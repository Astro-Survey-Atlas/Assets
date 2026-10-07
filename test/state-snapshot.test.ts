import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

test("state sync status distinguishes queued snapshots from an acknowledged pointer", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-status-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator, spool } = await makeCoordinator(base, store);
    await coordinator.initialize(["products"]);
    await coordinator.enqueue("products", { revision: 1 });
    const queued = await coordinator.syncStatus("products");
    assert.equal(queued.status, "pending");
    assert.equal(queued.generation, 1);
    assert.ok(queued.uploadId);

    const uploads = await spool.processPending();
    await coordinator.reconcileUploaded(uploads.uploadedManifests);
    const synced = await coordinator.syncStatus("products");
    assert.equal(synced.status, "synced");
    assert.equal(synced.generation, 1);
    assert.equal(synced.snapshotSha256, uploads.uploadedManifests[0]?.sha256);
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

test("same generation duplicates do not stop reconciliation of later snapshots", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-duplicate-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const first = await makeCoordinator(base, store);
    await first.coordinator.initialize(["publication-runs"]);
    const original = await first.coordinator.enqueue("publication-runs", { run: "old" });
    const duplicate = await first.coordinator.enqueue("publication-runs", { run: "new" });
    const uploaded = await first.spool.processPending();
    const generationOne = uploaded.uploadedManifests.find((manifest) => manifest.uploadId === original.uploadId)!;
    const generationTwo = uploaded.uploadedManifests.find((manifest) => manifest.uploadId === duplicate.uploadId)!;
    await first.coordinator.reconcileUploaded([generationOne]);
    const duplicateJob = { ...generationTwo, metadata: { ...generationTwo.metadata, stateGeneration: "1" }, objectKey: generationTwo.objectKey.replace("/2-", "/1-") };
    await first.coordinator.reconcileUploaded([duplicateJob, generationTwo]);
    const pointer = await first.coordinator.readPointer("publication-runs");
    assert.equal(pointer?.generation, 2);
    assert.equal(pointer?.snapshotSha256, generationTwo.sha256);
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

test("separate coordinators sharing a spool root allocate distinct generations", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-cross-process-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const first = await makeCoordinator(base, store);
    const second = await makeCoordinator(base, store);
    await Promise.all([first.coordinator.initialize(["products"]), second.coordinator.initialize(["products"]) ]);
    const jobs = await Promise.all([
      first.coordinator.enqueue("products", { writer: 1 }),
      second.coordinator.enqueue("products", { writer: 2 }),
    ]);
    assert.deepEqual(jobs.map((job) => job.generation).sort((left, right) => left - right), [1, 2]);
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

    const corruptedDestination = path.join(base, "corrupted", "package.zip");
    await mkdir(path.dirname(corruptedDestination), { recursive: true });
    await writeFile(corruptedDestination, "stale local bytes\n");
    const repaired = await coordinator.restoreFile({ objectKey: job.objectKey, destinationPath: corruptedDestination, sha256: digest, sizeBytes: bytes.length });
    assert.deepEqual(repaired, { objectKey: job.objectKey, sha256: digest, sizeBytes: bytes.length });
    assert.deepEqual(await readFile(corruptedDestination), bytes);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writing another namespace never regresses a counter cached by an older coordinator", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-namespaces-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const first = await makeCoordinator(base, store);
    const second = await makeCoordinator(base, store);
    await first.coordinator.initialize(["products", "editorial"]);
    await second.coordinator.initialize(["products", "editorial"]);
    assert.equal((await first.coordinator.enqueue("products", { revision: 1 })).generation, 1);
    await second.coordinator.enqueue("editorial", { revision: 1 });
    // A new process has no in-memory maximum to hide a regressed disk counter.
    const restarted = await makeCoordinator(base, store);
    await restarted.coordinator.initialize(["products", "editorial"]);
    assert.equal((await restarted.coordinator.enqueue("products", { revision: 2 })).generation, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an upload outage retains two full checkpoints while preserving the entire task history", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-bounded-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator, spool } = await makeCoordinator(base, store);
    const history: string[] = [];
    for (let revision = 1; revision <= 12; revision += 1) {
      history.push(`task-${revision}`);
      await coordinator.enqueue("publication-tasks", { history: [...history], revision });
    }
    assert.equal((await spool.listManifests()).length, 2, "unprocessed full checkpoints must not accumulate during an outage");
    const uploaded = await spool.processPending();
    await coordinator.reconcileUploaded(uploaded.uploadedManifests);
    const restored = await coordinator.restore("publication-tasks");
    assert.equal(restored?.pointer.generation, 12);
    assert.deepEqual(restored?.state, { history, revision: 12 });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("checkpoint compaction keeps leased uploads and unique referenced files", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-leased-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator, spool } = await makeCoordinator(base, store);
    const first = await coordinator.enqueue("native-units", { revision: 1 });
    await writeFile(path.join(spool.jobsRoot, first.uploadId, ".lease"), JSON.stringify({ acquiredAt: new Date().toISOString() }));
    const source = path.join(base, "unique-index.bin");
    await writeFile(source, "unique index dependency");
    const dependency = await coordinator.enqueueFile("native-units", source);
    for (let revision = 2; revision <= 5; revision += 1) await coordinator.enqueue("native-units", { revision });
    const remaining = await spool.listManifests();
    assert.deepEqual(remaining.filter(m => m.kind === "state-snapshot").map(m => Number(m.metadata?.stateGeneration)).sort((a,b) => a-b), [1,4,5]);
    assert.ok(remaining.some(m => m.uploadId === dependency.uploadId));
    assert.equal(await readFile(path.join(spool.jobsRoot, dependency.uploadId, "payload"), "utf8"), "unique index dependency");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("capacity rejection leaves no abandoned snapshot source file", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-capacity-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const spool = new UploadSpool({ root: path.join(base, "uploads"), store, maxBytes: 8 });
    const coordinator = new StateSnapshotCoordinator({ root: path.join(base, "state"), store, spool });
    await assert.rejects(() => coordinator.enqueue("products", { description: "large checkpoint" }), /capacity|limit/i);
    assert.deepEqual(await readdir(path.join(base, "state", "pending", "products")), []);
    assert.deepEqual(await spool.listManifests(), []);
    assert.equal((await coordinator.syncStatus("products")).status, "failed", "rejected latest state must not appear synced");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a rejected checkpoint is reported even when an older checkpoint is still pending", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-rejected-latest-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const spool = new UploadSpool({ root: path.join(base, "uploads"), store, maxBytes: 4096 });
    const coordinator = new StateSnapshotCoordinator({ root: path.join(base, "state"), store, spool });
    await coordinator.enqueue("products", { revision: 1 });
    await assert.rejects(() => coordinator.enqueue("products", { revision: 2, content: "x".repeat(4096) }), /capacity|limit/i);
    const status = await coordinator.syncStatus("products");
    assert.equal(status.status, "failed");
    assert.equal(status.generation, 2);
    assert.match(status.error ?? "", /not admitted/i);
    assert.equal((await spool.listManifests()).length, 1, "the older checkpoint is still available for recovery");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a corrupt replacement checkpoint cannot retire the last valid older checkpoint", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "state-snapshot-corrupt-replacement-"));
  try {
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "remote")));
    const { coordinator, spool } = await makeCoordinator(base, store);
    const first = await coordinator.enqueue("products", { revision: 1 });
    const second = await coordinator.enqueue("products", { revision: 2 });
    await writeFile(path.join(spool.jobsRoot, second.uploadId, "payload"), "corrupt checkpoint");
    await coordinator.enqueue("products", { revision: 3 });
    assert.ok((await spool.listManifests()).some(m => m.uploadId === first.uploadId));
    assert.deepEqual(JSON.parse(await readFile(path.join(spool.jobsRoot, first.uploadId, "payload"), "utf8")), { revision: 1 });
  } finally { await rm(base, { recursive: true, force: true }); }
});
