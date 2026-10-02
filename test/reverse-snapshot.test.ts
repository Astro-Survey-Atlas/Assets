import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FilesystemArtifactStore, type ArtifactPutOptions } from "../server/artifact-store.js";
import { decodeSnapshotCursor, readReverseSnapshot, snapshotPage, writeReverseSnapshot, type ReverseSnapshot } from "../server/reverse-snapshot.js";
import type { DownloadPlan } from "../server/evidence-store.js";

function snapshot(identity = "preview"): ReverseSnapshot {
  const plan: DownloadPlan = { schemaVersion: 1, files: [], entrypoints: [], truncated: false, warnings: [],
    spatialUnits: Array.from({ length: 1408 }, (_, index) => ({ layerId: "legacy-dr10", productId: "product", surveyId: "legacy-surveys",
      releaseId: "dr10", product: "Coadd", unitKind: "brick", unitId: String(index), order: 8, nside: 256,
      matchingCells: [202250], precision: "estimated", accessUri: `https://example.test/brick/${index}/` })) };
  return { schemaVersion: 1, identity, fingerprint: "region-revision", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    response: { downloadPlan: plan }, previewPlan: { ...plan, spatialUnits: plan.spatialUnits!.slice(0, 6), truncated: true } };
}

test("large footprint snapshots fit a bounded transfer and continuations reuse the immutable result", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assets-reverse-transfer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  class MeteredStore extends FilesystemArtifactStore {
    reads = 0;
    override async putImmutable(key: string, body: Uint8Array | string, options: ArtifactPutOptions = {}) {
      const size = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
      assert.ok(size < 256 * 1024, "Snapshot transport exceeded the metadata transfer budget");
      return super.putImmutable(key, body, options);
    }
    override async get(key: string) { this.reads += 1; return super.get(key); }
  }
  const source = snapshot("key-1");
  for (const unit of source.response.downloadPlan.spatialUnits!) {
    unit.sRegion = `POLYGON ICRS ${"328.5 17.7 328.6 17.8 ".repeat(256)}`;
    unit.accessUris = [{ uri: unit.accessUri!, fileName: `${unit.unitId}.fits` }];
  }
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > 2 * 1024 * 1024);
  const id = await writeReverseSnapshot(new MeteredStore(directory), source);
  const reader = new MeteredStore(directory);
  for (let page = 0; page < 5; page += 1) {
    const retained = await readReverseSnapshot(reader, id, "key-1", "region-revision");
    assert.deepEqual(retained, source);
  }
  await assert.rejects(readReverseSnapshot(reader, id, "key-2", "region-revision"), /another access/);
  assert.equal(reader.reads, 1);
});

test("existing uncompressed query snapshots remain readable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assets-reverse-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FilesystemArtifactStore(directory);
  const source = snapshot("key-1");
  const bytes = Buffer.from(JSON.stringify(source));
  const id = createHash("sha256").update(bytes).digest("hex");
  await store.putImmutable(`reverse-lookups/${id}.json`, bytes);
  assert.deepEqual(await readReverseSnapshot(store, id, "key-1", "region-revision"), source);
});

test("snapshot pagination drains more than 1000 native units with fixed bounded cursors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assets-reverse-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FilesystemArtifactStore(directory);
  const source = snapshot();
  const id = await writeReverseSnapshot(store, source);
  const retained = await readReverseSnapshot(store, id, "key-1", "region-revision");
  let response = snapshotPage(retained, id, "key-1", "secret", { preview: true, scope: "manifest", pageSize: 6 }) as {
    downloadPlan: DownloadPlan; page: { nextCursor?: string }; querySnapshot: { queryExhausted: boolean; inventoryComplete: boolean };
  };
  const seen = new Set(response.downloadPlan.spatialUnits!.map((unit) => unit.unitId));
  while (response.page.nextCursor) {
    assert.ok(response.page.nextCursor.length < 2000);
    const cursor = decodeSnapshotCursor(response.page.nextCursor, "key-1", "region-revision", "manifest", "secret");
    response = snapshotPage(retained, id, "key-1", "secret", { scope: "manifest", pageSize: 100, cursor }) as typeof response;
    for (const unit of response.downloadPlan.spatialUnits!) { assert.ok(!seen.has(unit.unitId)); seen.add(unit.unitId); }
  }
  assert.equal(seen.size, 1408);
  assert.equal(response.querySnapshot.queryExhausted, true);
  assert.equal(response.querySnapshot.inventoryComplete, false);
  assert.equal(response.downloadPlan.truncated, false);
});

test("snapshot cursors bind region, revision, access identity and page kind; expiry is explicit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assets-reverse-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FilesystemArtifactStore(directory);
  const source = snapshot("key-1");
  const id = await writeReverseSnapshot(store, source);
  const response = snapshotPage(source, id, "key-1", "secret", { scope: "spatial-units", pageSize: 1 }) as { spatialPage: { nextCursor: string } };
  assert.throws(() => decodeSnapshotCursor(response.spatialPage.nextCursor, "key-2", "region-revision", "spatial-units", "secret"), /another access/);
  assert.throws(() => decodeSnapshotCursor(response.spatialPage.nextCursor, "key-1", "changed", "spatial-units", "secret"), /does not match/);
  assert.throws(() => decodeSnapshotCursor(response.spatialPage.nextCursor, "key-1", "region-revision", "manifest", "secret"), /does not match/);
  await assert.rejects(readReverseSnapshot(store, id, "key-2", "region-revision"), /another access/);
  const expiredId = await writeReverseSnapshot(store, { ...source, expiresAt: "2000-01-01T00:00:00Z" });
  await assert.rejects(readReverseSnapshot(store, expiredId, "key-1", "region-revision"), /expired/);
});

test("upstream truncation survives exhaustion and never creates an empty continuation", () => {
  const source = snapshot(); source.response.downloadPlan.truncated = true;
  const response = snapshotPage(source, "a".repeat(64), "key-1", "secret", { scope: "manifest", pageSize: 2000 }) as {
    truncated: boolean; page: { hasMore: boolean }; querySnapshot: { queryExhausted: boolean };
  };
  assert.equal(response.truncated, true); assert.equal(response.page.hasMore, false); assert.equal(response.querySnapshot.queryExhausted, false);
});
