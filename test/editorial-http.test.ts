import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SurveyEditorialContent } from "../server/editorial.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate test port"));
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming ready: ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* retry while the release is verified */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become ready");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

test("editorial submission updates product draft, requires re-review and cannot bypass complete publication", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-editorial-http-"));
  const environment = {
    ...process.env,
    HOST: "127.0.0.1",
    PUBLIC_SITE_ROOT: path.resolve("site"),
    ASSETS_CONTENT_ROOT: root,
    ASSETS_WAREHOUSE_ES_URL: "",
    ASSETS_ADMIN_ENABLED: "true",
    ASSETS_ADMIN_TOKEN: "test-admin-token",
  };
  let child: ChildProcess | undefined;
  context.after(async () => {
    if (child) await stop(child);
    await rm(root, { recursive: true, force: true });
  });
  const start = async (): Promise<number> => {
    const port = await freePort();
    child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
      cwd: process.cwd(),
      env: { ...environment, PORT: String(port) },
      stdio: ["ignore", "ignore", "ignore"],
    });
    await waitFor(`http://127.0.0.1:${port}/healthz`, child);
    return port;
  };

  let port = await start();
  const endpoint = `http://127.0.0.1:${port}/api/v1/admin/catalog/surveys/gaia/editorial`;
  const headers = { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" };
  const initialResponse = await fetch(endpoint, { headers });
  assert.equal(initialResponse.status, 200);
  const initialBody = await initialResponse.json() as { editorial: { revision: number; draft: SurveyEditorialContent; published: unknown } };
  const initial = initialBody.editorial;
  assert.equal(initial.draft.surveyId, "gaia");
  assert.equal(initial.revision, 1);
  const release = initial.draft.releases[0]!;
  const product = release.products[0]!;
  const productId = product.productId;

  const draft = structuredClone(initial.draft);
  draft.name = "CSST Editorial Name";
  draft.mission = "Edited CSST mission";
  draft.description = "Edited CSST description";
  draft.releases[0]!.label = "CSST Edited Release";
  draft.releases[0]!.products[0]!.displayName = "Public W1 image label";
  draft.releases[0]!.products[0]!.description = "Edited public product description";
  const updateResponse = await fetch(`${endpoint}/draft`, { method: "PUT", headers, body: JSON.stringify({ revision: initial.revision, content: draft }) });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json() as { editorial: { revision: number; draft: typeof draft; published: unknown } };
  assert.equal(updated.editorial.revision, 2);
  assert.equal(updated.editorial.published, null);

  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/v1/surveys`)).json() as {surveys:unknown[]}).surveys,[]);
  const forged = structuredClone(draft);
  forged.releases[0]!.products[0]!.canonicalName = "changed-canonical-name";
  const forgedResponse = await fetch(`${endpoint}/draft`, { method: "PUT", headers, body: JSON.stringify({ revision: updated.editorial.revision, content: forged }) });
  assert.equal(forgedResponse.status, 400);
  const conflictResponse = await fetch(`${endpoint}/draft`, { method: "PUT", headers, body: JSON.stringify({ revision: initial.revision, content: draft }) });
  assert.equal(conflictResponse.status, 409);
  const invalidRevisionResponse = await fetch(`${endpoint}/draft`, { method: "PUT", headers, body: JSON.stringify({ revision: "two", content: draft }) });
  assert.equal(invalidRevisionResponse.status, 400);

  const publishResponse = await fetch(`${endpoint}/publish`, { method: "POST", headers, body: JSON.stringify({ revision: updated.editorial.revision }) });
  assert.equal(publishResponse.status, 200);
  const published = await publishResponse.json() as { editorial: { publishedRevision: number; audit: Array<{ action: string }> } };
  assert.equal(published.editorial.publishedRevision, 2);
  assert.equal(published.editorial.audit.at(-1)?.action, "publish");

  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/v1/surveys`)).json() as {surveys:unknown[]}).surveys,[]);
  const productState=await (await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${productId}`,{headers})).json() as {product:{draft:{publicDisplayName:string;publicDescription:string};review?:unknown;published:unknown}};
  assert.equal(productState.product.draft.publicDisplayName,"Public W1 image label");
  assert.equal(productState.product.draft.publicDescription,"Edited public product description");
  assert.equal(productState.product.review,undefined);
  assert.equal(productState.product.published,null);
  await stop(child!);
  port = await start();
  const restored = await (await fetch(`http://127.0.0.1:${port}/api/v1/admin/catalog/surveys/gaia/editorial`, { headers })).json() as { editorial: { revision: number; published: { name: string } | null } };
  assert.equal(restored.editorial.revision, 2);
  assert.equal(restored.editorial.published?.name, "CSST Editorial Name");
});
