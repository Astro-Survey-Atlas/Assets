import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FilesystemArtifactStore, type ArtifactStore, type ArtifactObject, type ArtifactObjectWithBody, type ArtifactPutOptions } from "../server/artifact-store.js";
import { StateSnapshotCoordinator, stateSnapshotFileKey, stateSnapshotPointerKey } from "../server/state-snapshot.js";
import { UploadSpool } from "../server/upload-spool.js";

class LocalS3Adapter implements ArtifactStore {
  readonly kind = "s3" as const;
  reads = 0;

  constructor(private readonly delegate: FilesystemArtifactStore) {}

  head(key: string): Promise<ArtifactObject | null> { return this.delegate.head(key); }
  async get(key: string, range?: { start: number; end: number }): Promise<ArtifactObjectWithBody | null> {
    this.reads += 1;
    return this.delegate.get(key, range);
  }
  putImmutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> {
    return this.delegate.putImmutable(key, body, options);
  }
  putMutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> {
    return this.delegate.putMutable(key, body, options);
  }
  putFileImmutable(key: string, filePath: string, options?: ArtifactPutOptions): Promise<ArtifactObject> {
    return this.delegate.putFileImmutable(key, filePath, options);
  }
  downloadToFile(key: string, filePath: string): Promise<ArtifactObject | null> {
    return this.delegate.downloadToFile(key, filePath);
  }
}

async function makeCoordinator(base: string, store: LocalS3Adapter): Promise<{ coordinator: StateSnapshotCoordinator; spool: UploadSpool }> {
  const spool = new UploadSpool({ root: path.join(base, "uploads"), store });
  await spool.initialize();
  const coordinator = new StateSnapshotCoordinator({ root: path.join(base, "state"), store, spool });
  return { coordinator, spool };
}

test("state snapshots upload asynchronously and restore from the remote pointer", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-restore-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator, spool } = await makeCoordinator(base, store);
    await coordinator.initialize(["products"]);
    const readsBeforeEnqueue = store.reads;
    await coordinator.enqueue("products", { schemaVersion: 1, products: [{ id: "one" }] });
    assert.equal(store.reads, readsBeforeEnqueue, "enqueue must not read the remote pointer");

    const uploaded = await spool.processPending();
    assert.equal(uploaded.uploaded.length, 1);
    assert.equal(uploaded.uploadedManifests.length, 1);
    const advanced = await coordinator.reconcileUploaded(uploaded.uploadedManifests);
    assert.equal(advanced.length, 1);
    assert.equal(advanced[0]?.generation, 1);

    const restoredCoordinator = await makeCoordinator(path.join(base, "restored"), store);
    const restored = await restoredCoordinator.coordinator.restore("products");
    assert.ok(restored);
    assert.equal(restored.pointer.generation, 1);
    assert.deepEqual(restored.state, { schemaVersion: 1, products: [{ id: "one" }] });
    assert.ok(await store.head(stateSnapshotPointerKey("products")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("state pointer never regresses when uploaded snapshots arrive out of order", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-order-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator, spool } = await makeCoordinator(base, store);
    await coordinator.initialize(["editorial"]);
    await coordinator.enqueue("editorial", { revision: 1 });
    await coordinator.enqueue("editorial", { revision: 2 });
    const uploaded = await spool.processPending();
    assert.equal(uploaded.uploadedManifests.length, 2);
    const ordered = [...uploaded.uploadedManifests].sort((left, right) => (left.metadata?.stateGeneration ?? "").localeCompare(right.metadata?.stateGeneration ?? ""));
    const newestFirst = [...ordered].reverse();
    const first = await coordinator.reconcileUploaded(newestFirst.slice(0, 1));
    assert.equal(first[0]?.generation, 2);
    assert.deepEqual(await coordinator.reconcileUploaded(ordered.slice(0, 1)), []);
    const restored = await coordinator.restore("editorial");
    assert.ok(restored);
    assert.equal(restored.pointer.generation, 2);
    assert.deepEqual(restored.state, { revision: 2 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("same-namespace snapshot enqueue is serialized into distinct generations", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-concurrency-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator } = await makeCoordinator(base, store);
    await coordinator.initialize(["products"]);
    const jobs = await Promise.all([
      coordinator.enqueue("products", { revision: 1 }),
      coordinator.enqueue("products", { revision: 2 }),
      coordinator.enqueue("products", { revision: 3 }),
    ]);
    assert.deepEqual(jobs.map((job) => job.generation).sort((left, right) => left - right), [1, 2, 3]);
    assert.equal(new Set(jobs.map((job) => job.snapshotKey)).size, 3);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("state files use content-addressed keys and restore only verified bytes", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-file-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator, spool } = await makeCoordinator(base, store);
    const source = path.join(base, "source.bin");
    const bytes = Buffer.from("durable state file\n", "utf8");
    await writeFile(source, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");

    const job = await coordinator.enqueueFile({ namespace: "resource-packages", sourcePath: source, kind: "test-package" });
    assert.equal(job.objectKey, stateSnapshotFileKey("resource-packages", digest));
    assert.equal(job.sha256, digest);
    assert.equal(job.sizeBytes, bytes.length);
    assert.deepEqual((await spool.processPending()).uploaded, [job.uploadId]);

    const destination = path.join(base, "restored", "package.zip");
    const restored = await coordinator.restoreFile({ namespace: "resource-packages", objectKey: job.objectKey, destinationPath: destination, sha256: digest, sizeBytes: bytes.length });
    assert.deepEqual(restored, { objectKey: job.objectKey, sha256: digest, sizeBytes: bytes.length });
    assert.deepEqual(await readFile(destination), bytes);

    const badDestination = path.join(base, "bad", "package.zip");
    await assert.rejects(
      () => coordinator.restoreFile({ namespace: "resource-packages", objectKey: job.objectKey, destinationPath: badDestination, sha256: "0".repeat(64), sizeBytes: bytes.length }),
      /checksum|mismatch/i,
    );
    await assert.rejects(() => stat(badDestination), { code: "ENOENT" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
