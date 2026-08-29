import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStoreConflictError, FilesystemArtifactStore, createArtifactStore, publishReleaseBundle } from "../server/artifact-store.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

test("filesystem object store publishes immutable release objects and current pointer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-object-store-"));
  const source = path.join(root, "source");
  const objectRoot = path.join(root, "objects");
  const filePath = path.join(source, "src", "tiny.txt");
  const bytes = Buffer.from("immutable release\n", "utf8");
  const record = {
    id: "tiny-release-file",
    kind: "documentation",
    label: "Tiny release file",
    description: "test",
    path: "src/tiny.txt",
    downloadName: "tiny.txt",
    mediaType: "text/plain; charset=utf-8",
    deliveryClass: "runtime",
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  };
  const bundleSha256 = sha256(Buffer.from(JSON.stringify([{ id: record.id, path: record.path, sizeBytes: record.sizeBytes, sha256: record.sha256 }])));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  await mkdir(path.join(source, "artifacts", "public-survey-footprints"), { recursive: true });
  await writeFile(path.join(source, "artifacts", "public-survey-footprints", "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-08-28T00:00:00Z",
    bundle: { id: "tiny-release", sha256: bundleSha256 },
    files: [record],
  })}\n`);

  const store = new FilesystemArtifactStore(objectRoot);
  const published = await publishReleaseBundle(source, store);
  assert.equal(published.runtimeCount, 1);
  assert.equal(published.evidenceCount, 0);
  const object = await store.get(`public/releases/tiny-release/${bundleSha256}/src/tiny.txt`);
  assert.ok(object);
  assert.equal(object.sha256, record.sha256);
  assert.deepEqual(object.body, bytes);
  const current = await store.get("public/current.json");
  assert.ok(current);
  assert.equal(JSON.parse(current.body.toString("utf8")).manifestKey, published.manifestKey);
  const manifest = await store.get(published.manifestKey);
  assert.ok(manifest);
  assert.equal(JSON.parse(manifest.body.toString("utf8")).files[0].objectKey, object.key);

  await assert.rejects(() => store.putImmutable(object.key, Buffer.from("different")), ArtifactStoreConflictError);
  const range = await store.get(object.key, { start: 0, end: 8 });
  assert.equal(range?.body.toString("utf8"), "immutable");
  await readFile(path.join(objectRoot, "public", "current.json"));
});

test("object-store factory requires a complete S3 configuration and falls back to filesystem", () => {
  assert.equal(createArtifactStore({}).kind, "filesystem");
  assert.throws(() => createArtifactStore({ endpoint: "http://minio.local" }), /configured together/);
  assert.throws(() => createArtifactStore({ bucket: "atlas" }), /configured together/);
});
