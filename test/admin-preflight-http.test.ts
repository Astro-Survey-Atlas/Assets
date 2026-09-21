import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fitsMoc, reviewedFixture } from "./reviewed-fixture.js";
import { sha256 } from "../server/native-moc.js";
import { publicReleaseBundleDigest } from "../server/catalog.js";

for (const order of [0, 4]) test(`admin preflight validates actual O${order}; inventory includes unpublished and retired records`, async t => {
  const f = await reviewedFixture();
  const bytes = fitsMoc([{ order, pixel: 0 }]);
  const file = f.files.find(file => file.kind === "moc")!;
  await writeFile(path.join(f.root, file.path), bytes);
  file.sha256 = sha256(bytes); file.sizeBytes = bytes.length;
  f.manifest.bundle.sha256 = publicReleaseBundleDigest(f.files);
  await writeFile(path.join(f.root, "artifacts/public-survey-footprints/release-manifest.json"), JSON.stringify(f.manifest));
  const jwst = structuredClone(f.products[0]!);
  jwst.productId = jwst.draft.productId = "jwst-draft";
  jwst.draft.surveyId = "jwst"; jwst.draft.releaseId = "public";
  delete jwst.review;
  const akari = structuredClone(jwst);
  akari.productId = akari.draft.productId = "akari-retired";
  akari.draft.surveyId = "akari"; akari.retiredAt = "2026-09-20";
  await writeFile(path.join(f.contentRoot, "product-content-v1.json"), JSON.stringify({ schemaVersion: 1, products: [...f.products, jwst, akari] }));
  const server = net.createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(r => server.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ASSET_RELEASE_ROOT: f.root,
      ASSETS_CONTENT_ROOT: f.contentRoot, ASSETS_EVIDENCE_ROOT: path.join(f.base, "evidence"),
      ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "fixture", ASSETS_WAREHOUSE_ES_URL: "", ASSETS_KUBE_API_URL: "http://127.0.0.1:9" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stderr.on("data", chunk => logs += chunk); child.stdout.on("data", chunk => logs += chunk);
  t.after(async () => { if (child.exitCode === null) await new Promise<void>(r => { child.once("exit", () => r()); child.kill(); }); await rm(f.base, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  const get = async (route: string) => { const r = await fetch(base + route, { headers: { Authorization: "Bearer fixture" } }); assert.equal(r.status, 200); return r.json(); };
  for (const [llmEnabled, expected] of [["true", 400], [true, 409]] as const) {
    const rejected = await fetch(base + "/api/v1/admin/moc-discovery", { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ surveyName: "SDSS", llmEnabled }) });
    assert.equal(rejected.status, expected, "invalid or unconfigured enhancement rejected before Warehouse submission");
  }
  const before = await readFile(path.join(f.contentRoot, "product-content-v1.json"), "utf8");
  const preflight = await get("/api/v1/admin/products/jwst-draft/preflight");
  assert.equal(preflight.revision, 1);
  assert.equal(preflight.nativeOrder.minimum, 4);
  assert.equal(preflight.nativeOrder.state, order < 4 ? "blocked" : "passed");
  assert.match(preflight.nativeOrder.message, order < 4 ? /order 0.*order 4/ : /O4 ≥ O4/);
  assert.equal(await readFile(path.join(f.contentRoot, "product-content-v1.json"), "utf8"), before, "preflight does not mutate products");
  const overview = await get("/api/v1/admin/overview");
  const review = await get("/api/v1/admin/products?view=surveys");
  for (const body of [overview, review]) {
    const jwstGroup = body.surveys.find((s: any) => s.id === "jwst");
    assert.deepEqual(jwstGroup.releases.flatMap((r: any) => r.products.map((p: any) => p.productId)), ["jwst-draft"]);
    const akariGroup = body.surveys.find((s: any) => s.id === "akari");
    assert.equal(akariGroup.releases[0].products[0].review.state, "retired");
    assert.equal(body.surveys.some((s: any) => s.id === "__unmatched__"), false);
  }
  assert.equal((await get("/api/v1/admin/catalog/surveys/jwst/editorial")).editorial.surveyId, "jwst", "draft-only groups have a working copy editor");
  assert.deepEqual((await get("/api/v1/surveys")).surveys, [], "admin groups do not expose draft or retired products publicly");
  const restore = (body: unknown, token = "fixture") => fetch(base + "/api/v1/admin/products/akari-retired/restore", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await restore({ revision: 1, reason: "New evidence" }, "wrong")).status, 401);
  assert.equal((await restore({ revision: 1 })).status, 400);
  assert.equal((await restore({ revision: 99, reason: "New evidence" })).status, 409);
  const restoredResponse = await restore({ revision: 1, reason: "New evidence" });
  assert.equal(restoredResponse.status, 200);
  const restored = (await restoredResponse.json()).product;
  assert.equal(restored.revision, 2);
  assert.equal(restored.retiredAt, undefined);
  assert.equal(restored.review, undefined);
  assert.equal(restored.published, null);
  assert.equal(restored.restorationReason, "New evidence");
  assert.equal((await restore({ revision: 2, reason: "Again" })).status, 409);
  assert.deepEqual((await get("/api/v1/surveys")).surveys, [], "restoration never publishes a product");

});
