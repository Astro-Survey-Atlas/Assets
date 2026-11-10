import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { rm } from "node:fs/promises";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import { reviewedFixture } from "./reviewed-fixture.js";

// A layer whose native MOC is coarser (order 6) than the requested multi-order region (order 8) must
// be intersected at its own order. It used to throw "Unsupported projection order" in
// publicReverseEntrypoints, which failed the whole multi-layer query.
test("reverse lookup intersects a layer coarser than the requested region at its native order", async t => {
  const f = await reviewedFixture({ mocCells: [{ order: 6, pixel: 10207 }] });
  const publisher = new PublicReleasePublisher(f.options), plan = await publisher.plan();
  const run = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"], productIds: ["product-1"] });
  assert.equal((await publisher.execute(run.runId)).status, "published");
  const installed = path.join(f.base, "installed"); await syncReleaseFromObjectStore(f.store, installed);
  const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), ASSET_RELEASE_ROOT: path.join(installed, "current"), ASSETS_CONTENT_ROOT: f.contentRoot,
      ASSETS_EVIDENCE_ROOT: path.join(f.base, "evidence"), ASSETS_API_MASTER_KEY: randomBytes(32).toString("base64"), ASSETS_LLM_API_KEY: "", ASSETS_KUBE_API_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stderr.on("data", c => logs += c); child.stdout.on("data", c => logs += c);
  t.after(async () => { if (child.exitCode === null) await new Promise<void>(r => { child.once("exit", () => r()); child.kill(); }); await rm(f.base, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch { /* not up yet */ } if (child.exitCode !== null) throw new Error(logs); await new Promise(r => setTimeout(r, 100)); }
  // Public preview: no key needed. The O8 cell lies inside the layer's O6 parent cell 10207.
  const response = await fetch(base + "/api/v1/coverage/reverse-lookup", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ layerIds: [f.layerId], region: { coordinateFrame: "ICRS", ordering: "NESTED", cells: [{ order: 8, ipix: 163327 }] }, preview: true }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text + "\n--- server log ---\n" + logs.split("\n").filter(l => /Unsupported|    at /.test(l)).slice(0, 8).join("\n"));
  assert.doesNotMatch(logs, /Unsupported projection order/, "the coarse layer must not throw");
  const body = JSON.parse(text);
  assert.equal(body.schemaVersion, 2);
  const evidenceOf = (b: any) => (b.downloadPlan?.coverageEvidence ?? []).filter((e: any) => e.layerId === f.layerId);
  const inside = evidenceOf(body);
  assert.equal(inside.length, 1, "a cell inside the layer's O6 parent must match: " + JSON.stringify(body.downloadPlan?.coverageEvidence ?? null).slice(0, 300));
  assert.deepEqual(inside[0].matchedCells, [163327], "matches stay in the requested O8 grid, not folded O6 ids");
  // A cell that lies outside the layer's O6 parent is still excluded (folding must not over-match).
  const outside = await fetch(base + "/api/v1/coverage/reverse-lookup", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ layerIds: [f.layerId], region: { coordinateFrame: "ICRS", ordering: "NESTED", cells: [{ order: 8, ipix: 0 }] }, preview: true }),
  });
  const outsideText = await outside.text();
  assert.equal(outside.status, 200, outsideText);
  assert.doesNotMatch(logs, /Unsupported projection order/);
  assert.equal(evidenceOf(JSON.parse(outsideText)).length, 0, "a cell outside the layer's O6 parent must not match (folding must not over-match)");
});
