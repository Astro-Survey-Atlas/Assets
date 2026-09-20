import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { reviewedFixture } from "./reviewed-fixture.js";
import { s3HttpFixture } from "./s3-http-fixture.js";
import { createArtifactStoreFromProcess } from "../server/artifact-store.js";
import { uploadObjectRelease, activateObjectRelease } from "../server/object-release.js";
import { PublicReleasePublisher } from "../server/public-release-publication.js";

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}
async function until(check: () => Promise<boolean>, logs: () => string): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${logs()}`);
}

test("site has no draft writes, proxies admin, hot-syncs its own cache and restarts offline", async () => {
  const f = await reviewedFixture();
  const s3 = await s3HttpFixture();
  const store = createArtifactStoreFromProcess(s3.env);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = "";
  const backend = http.createServer((req, res) => { res.writeHead(req.headers.authorization === "Bearer fixture" ? 200 : 401); res.end(JSON.stringify({ path: req.url })); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as import("node:net").AddressInfo).port;
  const forbiddenContent = path.join(f.base, "site-must-not-create-content");
  const start = () => {
    const child = spawn(process.execPath, ["dist/server/server.js"], { env: { ...process.env, ...s3.env,
      ASSETS_ROLE: "site", ASSET_RELEASE_ROOT: path.join(f.base, "site-cache/current"),
      ASSETS_CONTENT_ROOT: forbiddenContent, ASSETS_EVIDENCE_ROOT: path.join(forbiddenContent, "evidence"),
      ASSETS_UPLOAD_SPOOL_ROOT: path.join(forbiddenContent, "spool"), ASSETS_BACKEND_URL: `http://127.0.0.1:${backendPort}`,
      ASSETS_WAREHOUSE_ES_URL: "", HOST: "127.0.0.1", PORT: String(port),
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", bytes => { logs += bytes; }); child.stderr!.on("data", bytes => { logs += bytes; });
    return child;
  };
  let child: ChildProcess | undefined;
  let closed = false;
  try {
    const initial = await uploadObjectRelease(f.root, f.root, store, f.manifest.bundle.sha256);
    await activateObjectRelease(store, initial, f.manifest.bundle.sha256);
    child = start();
    await until(async () => (await fetch(`${base}/healthz`)).ok, () => logs);
    await assert.rejects(() => stat(forbiddenContent), { code: "ENOENT" });
    assert.equal((await fetch(`${base}/api/v1/admin/products`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/admin/products`, { headers: { Authorization: "Bearer fixture" } })).status, 200);
    const publisher = new PublicReleasePublisher({ ...f.options, store });
    const plan = await publisher.plan();
    const run = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"], productIds: ["product-1"] });
    const published = await publisher.execute(run.runId);
    assert.equal(published.status, "published", published.error);
    await until(async () => ((await (await fetch(`${base}/healthz`)).json()) as any).bundle.sha256 === published.bundle?.sha256, () => logs);
    assert.equal(((await (await fetch(`${base}/api/v1/products`)).json()) as any).products.length, 1);
    await assert.rejects(() => stat(forbiddenContent), { code: "ENOENT" });
    await stop(child);
    await s3.close(); closed = true;
    child = start();
    await until(async () => (await fetch(`${base}/healthz`)).ok, () => logs);
    assert.equal(((await (await fetch(`${base}/healthz`)).json()) as any).bundle.sha256, published.bundle?.sha256);
    await new Promise<void>(resolve => backend.close(() => resolve()));
    assert.equal((await fetch(`${base}/api/v1/admin/products`)).status, 503);
    assert.equal((await fetch(`${base}/api/v1/products`)).status, 200);
  } finally {
    if (child) await stop(child);
    if (!closed) await s3.close();
    backend.closeAllConnections(); backend.close();
    await rm(f.base, { recursive: true, force: true });
  }
});
