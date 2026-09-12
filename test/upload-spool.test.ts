import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FilesystemArtifactStore, type ArtifactPutOptions, type ArtifactStore, type ArtifactObject, type ArtifactObjectWithBody } from "../server/artifact-store.js";
import { UploadSpool } from "../server/upload-spool.js";

class LocalS3Adapter implements ArtifactStore {
  readonly kind = "s3" as const;

  constructor(private readonly delegate: FilesystemArtifactStore) {}

  head(key: string): Promise<ArtifactObject | null> { return this.delegate.head(key); }
  get(key: string, range?: { start: number; end: number }): Promise<ArtifactObjectWithBody | null> { return this.delegate.get(key, range); }
  putImmutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putImmutable(key, body, options); }
  putMutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putMutable(key, body, options); }
  putFileImmutable(key: string, filePath: string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putFileImmutable(key, filePath, options); }
  downloadToFile(key: string, filePath: string): Promise<ArtifactObject | null> { return this.delegate.downloadToFile(key, filePath); }
}

class FailingOnceAdapter extends LocalS3Adapter {
  #failuresRemaining: number;

  constructor(delegate: FilesystemArtifactStore, failures = 1) {
    super(delegate);
    this.#failuresRemaining = failures;
  }

  override async putFileImmutable(key: string, filePath: string, options?: ArtifactPutOptions): Promise<ArtifactObject> {
    if (this.#failuresRemaining > 0) {
      this.#failuresRemaining -= 1;
      throw new Error("temporary object-store outage");
    }
    return super.putFileImmutable(key, filePath, options);
  }
}

class FailingKeyAdapter extends LocalS3Adapter {
  constructor(delegate: FilesystemArtifactStore, private readonly failedKey: string) {
    super(delegate);
  }

  override async putFileImmutable(key: string, filePath: string, options?: ArtifactPutOptions): Promise<ArtifactObject> {
    if (key === this.failedKey) throw new Error("temporary object-store outage");
    return super.putFileImmutable(key, filePath, options);
  }
}

async function fixture(prefix: string): Promise<{ root: string; spoolRoot: string; source: string; store: LocalS3Adapter }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const source = path.join(root, "source.bin");
  await writeFile(source, "payload bytes\n", "utf8");
  return {
    root,
    spoolRoot: path.join(root, "uploads"),
    source,
    store: new LocalS3Adapter(new FilesystemArtifactStore(path.join(root, "objects"))),
  };
}

test("upload spool enqueues atomically and uploads an idempotent job", async () => {
  const { root, spoolRoot, source, store } = await fixture("upload-spool-success-");
  try {
    const spool = new UploadSpool({ root: spoolRoot, store });
    const manifest = await spool.enqueueFile({ kind: "moc", sourcePath: source, objectKey: "evidence/objects/test-a", uploadId: "job-a", contentType: "application/octet-stream" });
    const jobRoot = path.join(spoolRoot, "jobs", "job-a");
    assert.equal(manifest.status, "pending");
    assert.equal((await readFile(path.join(jobRoot, ".ready"), "utf8")), "job-a\n");
    assert.equal(await readFile(path.join(jobRoot, "payload"), "utf8"), "payload bytes\n");
    assert.deepEqual((await readdir(path.join(spoolRoot, "jobs"))).sort(), ["job-a"]);

    const first = await spool.processPending();
    assert.deepEqual(first.uploaded, ["job-a"]);
    assert.equal((await spool.processPending()).skipped.includes("job-a"), true);
    assert.ok(await store.head("evidence/objects/test-a"));
    assert.equal((await readFile(path.join(jobRoot, "receipt.json"), "utf8")).includes('"sha256"'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload spool treats an existing identical object as success", async () => {
  const { root, spoolRoot, source, store } = await fixture("upload-spool-idempotent-");
  try {
    await store.putFileImmutable("evidence/objects/existing", source);
    const spool = new UploadSpool({ root: spoolRoot, store });
    await spool.enqueueFile({ kind: "scan", sourcePath: source, objectKey: "evidence/objects/existing", uploadId: "job-existing" });
    const result = await spool.processPending();
    assert.deepEqual(result.uploaded, ["job-existing"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload spool records a conflicting immutable key as terminal conflict", async () => {
  const { root, spoolRoot, source, store } = await fixture("upload-spool-conflict-");
  try {
    await store.putImmutable("evidence/objects/conflict", "different bytes");
    const spool = new UploadSpool({ root: spoolRoot, store });
    await spool.enqueueFile({ kind: "scan", sourcePath: source, objectKey: "evidence/objects/conflict", uploadId: "job-conflict" });
    const result = await spool.processPending();
    assert.deepEqual(result.conflicts, ["job-conflict"]);
    const manifest = JSON.parse(await readFile(path.join(spoolRoot, "jobs", "job-conflict", "manifest.json"), "utf8")) as { status: string };
    assert.equal(manifest.status, "conflict");
    assert.equal(await stat(path.join(spoolRoot, "jobs", "job-conflict", "payload")).then(() => true), true);
    assert.equal((await spool.processPending()).skipped.includes("job-conflict"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload spool retains failed payloads and retries after a transient outage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "upload-spool-retry-"));
  try {
    const source = path.join(root, "source.bin");
    await writeFile(source, "retry payload", "utf8");
    let now = new Date("2026-09-11T00:00:00.000Z");
    const store = new FailingOnceAdapter(new FilesystemArtifactStore(path.join(root, "objects")));
    const spool = new UploadSpool({ root: path.join(root, "uploads"), store, retryBaseMs: 100, retryMaxMs: 1_000, now: () => now });
    await spool.enqueueFile({ kind: "exploration", sourcePath: source, objectKey: "work/result", uploadId: "job-retry" });

    const failed = await spool.processPending();
    assert.deepEqual(failed.retryable, ["job-retry"]);
    assert.equal(await stat(path.join(root, "uploads", "jobs", "job-retry", "payload")).then(() => true), true);
    assert.equal(await stat(path.join(root, "uploads", "jobs", "job-retry", "receipt.json")).then(() => true).catch(() => false), false);

    now = new Date(now.getTime() + 101);
    const retried = await spool.processPending();
    assert.deepEqual(retried.uploaded, ["job-retry"]);
    assert.ok(await store.head("work/result"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload spool recovers a stale lease and leaves an active lease alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "upload-spool-lease-"));
  try {
    const source = path.join(root, "source.bin");
    await writeFile(source, "lease payload", "utf8");
    let now = new Date("2026-09-11T00:00:00.000Z");
    const store = new LocalS3Adapter(new FilesystemArtifactStore(path.join(root, "objects")));
    const spool = new UploadSpool({ root: path.join(root, "uploads"), store, leaseMs: 100, now: () => now });
    await spool.enqueueFile({ kind: "moc", sourcePath: source, objectKey: "evidence/lease", uploadId: "job-lease" });
    const jobRoot = path.join(root, "uploads", "jobs", "job-lease");
    await writeFile(path.join(jobRoot, ".lease"), JSON.stringify({ acquiredAt: new Date(now.getTime() - 101).toISOString() }));
    assert.deepEqual((await spool.processPending()).uploaded, ["job-lease"]);

    await spool.enqueueFile({ kind: "moc", sourcePath: source, objectKey: "evidence/active", uploadId: "job-active" });
    const activeRoot = path.join(root, "uploads", "jobs", "job-active");
    await writeFile(path.join(activeRoot, ".lease"), JSON.stringify({ acquiredAt: now.toISOString() }));
    assert.equal((await spool.processPending()).skipped.includes("job-active"), true);
    now = new Date(now.getTime() + 101);
    assert.equal((await spool.processPending()).uploaded.includes("job-active"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload cleanup removes only acknowledged jobs, not failed jobs or sibling storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "upload-spool-cleanup-"));
  try {
    const source = path.join(root, "source.bin");
    await writeFile(source, "cleanup payload", "utf8");
    const store = new FailingKeyAdapter(new FilesystemArtifactStore(path.join(root, "objects")), "evidence/failed");
    const uploadsRoot = path.join(root, "uploads");
    const spool = new UploadSpool({ root: uploadsRoot, store, retryBaseMs: 60_000 });
    await mkdir(path.join(root, "cache"), { recursive: true });
    await mkdir(path.join(root, "scratch"), { recursive: true });
    await writeFile(path.join(root, "cache", "keep"), "cache");
    await writeFile(path.join(root, "scratch", "keep"), "scratch");
    await spool.enqueueFile({ kind: "moc", sourcePath: source, objectKey: "evidence/cleanup", uploadId: "job-clean" });
    await spool.enqueueFile({ kind: "moc", sourcePath: source, objectKey: "evidence/failed", uploadId: "job-failed" });
    assert.deepEqual((await spool.processPending()).uploaded, ["job-clean"]);
    assert.equal((await spool.processPending()).skipped.includes("job-failed"), true, "backoff must defer the failed job");
    assert.equal(await spool.cleanupUploaded(), 1);
    await assert.rejects(() => stat(path.join(uploadsRoot, "jobs", "job-clean")), { code: "ENOENT" });
    assert.equal(await stat(path.join(uploadsRoot, "jobs", "job-failed")).then(() => true), true);
    assert.equal(await readFile(path.join(root, "cache", "keep"), "utf8"), "cache");
    assert.equal(await readFile(path.join(root, "scratch", "keep"), "utf8"), "scratch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
