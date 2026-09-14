import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { activateReleasePointer, createArtifactStore, FilesystemArtifactStore, type ArtifactStore, publishReleaseArchive, uploadReleaseArchive } from "../server/artifact-store.js";
import { packageRelease } from "../scripts/release-archive.js";
import { storageLayout } from "../server/storage-layout.js";
import { cleanupReleaseHistory, syncReleaseFromObjectStore } from "../server/sync-release.js";
import { publicReleaseBundleDigest } from "../server/catalog.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

class LocalS3Store implements ArtifactStore {
  readonly kind = "s3" as const;
  constructor(private readonly delegate: FilesystemArtifactStore) {}
  head(key: string) { return this.delegate.head(key); }
  get(key: string, range?: { start: number; end: number }) { return this.delegate.get(key, range); }
  putImmutable(key: string, body: Uint8Array | string, options = {}) { return this.delegate.putImmutable(key, body, options); }
  putMutable(key: string, body: Uint8Array | string, options = {}) { return this.delegate.putMutable(key, body, options); }
  putFileImmutable(key: string, filePath: string, options = {}) { return this.delegate.putFileImmutable(key, filePath, options); }
  downloadToFile(key: string, filePath: string) { return this.delegate.downloadToFile(key, filePath); }
}

async function makeSource(root: string): Promise<{ bundleSha256: string }> {
  const sourcePath = path.join(root, "src", "tiny.txt");
  const bytes = Buffer.from("archive release\n", "utf8");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, bytes);
  const record = { id: "tiny-release-file", kind: "documentation" as const, label: "Tiny release file", description: "test", path: "src/tiny.txt", downloadName: "tiny.txt", mediaType: "text/plain; charset=utf-8", deliveryClass: "runtime" as const, sizeBytes: bytes.length, sha256: sha256(bytes) };
  const bundleSha256 = publicReleaseBundleDigest([record]);
  await mkdir(path.join(root, "artifacts", "public-survey-footprints"), { recursive: true });
  await writeFile(path.join(root, "artifacts", "public-survey-footprints", "release-manifest.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-28T00:00:00Z", bundle: { id: "tiny-release", sha256: bundleSha256 }, files: [record] })}\n`);
  return { bundleSha256 };
}

test("release archive is deterministic and publishes only the archive pointer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-package-"));
  try {
    const { bundleSha256 } = await makeSource(root);
    const first = await packageRelease({ root, outputPath: path.join(root, "first.tar.gz") });
    const second = await packageRelease({ root, outputPath: path.join(root, "second.tar.gz") });
    assert.equal(first.bundle.sha256, bundleSha256);
    assert.equal(first.archiveSha256, second.archiveSha256);
    const store = new LocalS3Store(new FilesystemArtifactStore(path.join(root, "objects")));
    const published = await publishReleaseArchive(first, store);
    assert.equal(published.archiveKey, `public/releases/tiny-release/${bundleSha256}/release.tar.gz`);
    const pointer = await store.get("public/current.json");
    assert.equal(JSON.parse(pointer!.body.toString("utf8")).schemaVersion, 2);
    assert.ok(await store.head(published.archiveKey));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release pointer activation rejects a stale baseline after candidate upload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-cas-release-"));
  try {
    const { bundleSha256 } = await makeSource(root);
    const descriptor = await packageRelease({ root, outputPath: path.join(root, "release.tar.gz") });
    const store = new LocalS3Store(new FilesystemArtifactStore(path.join(root, "objects")));
    await publishReleaseArchive(descriptor, store);
    const uploaded = await uploadReleaseArchive(descriptor, store);
    await assert.rejects(() => activateReleasePointer(uploaded, store, { expectedCurrentBundleSha256: "0".repeat(64) }), /Current release changed/);
    const pointer = JSON.parse((await store.get("public/current.json"))!.body.toString("utf8")) as { bundle: { sha256: string } };
    assert.equal(pointer.bundle.sha256, bundleSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive pull verifies and atomically activates a release, then reuses the hash cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-pull-"));
  try {
    await makeSource(root);
    const descriptor = await packageRelease({ root, outputPath: path.join(root, "release.tar.gz") });
    const store = new LocalS3Store(new FilesystemArtifactStore(path.join(root, "objects")));
    await publishReleaseArchive(descriptor, store);
    const target = path.join(root, "target");
    const synced = await syncReleaseFromObjectStore(store, target);
    assert.equal(synced.installedTarget, `releases/${descriptor.bundle.sha256}`);
    assert.equal(await readFile(path.join(target, "current", "src", "tiny.txt"), "utf8"), "archive release\n");
    const archive = path.join(target, ".staging", `${descriptor.bundle.sha256}.${process.pid}`, "release.tar.gz");
    assert.equal(await stat(archive).catch(() => undefined), undefined);
    const second = await syncReleaseFromObjectStore(store, target);
    assert.equal(second.files, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release history cleanup never removes the active release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-release-cleanup-"));
  try {
    const names = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    for (const name of names) {
      await mkdir(path.join(root, "releases", name), { recursive: true });
      await writeFile(path.join(root, "releases", name, "marker"), name);
    }
    await utimes(path.join(root, "releases", names[0]!), new Date(1_000), new Date(1_000));
    await utimes(path.join(root, "releases", names[1]!), new Date(2_000), new Date(2_000));
    await symlink(path.join("releases", names[2]!), path.join(root, "current"), "dir");
    const removed = await cleanupReleaseHistory(root, 2);
    assert.equal(removed, 1);
    assert.equal((await stat(path.join(root, "releases", names[2]!))).isDirectory(), true);
    assert.equal((await stat(path.join(root, "releases", names[1]!))).isDirectory(), true);
    await assert.rejects(() => stat(path.join(root, "releases", names[0]!)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable filesystem put rejects conflicting bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-immutable-conflict-"));
  try {
    const store = new FilesystemArtifactStore(path.join(root, "objects"));
    await store.putImmutable("public/x.bin", Buffer.from("one"));
    await assert.rejects(() => store.putImmutable("public/x.bin", Buffer.from("two")), /already exists with different bytes|Immutable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mutable filesystem pointers require the version read by the writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-mutable-cas-"));
  try {
    const store = new FilesystemArtifactStore(path.join(root, "objects"));
    const first = await store.putMutable("public/current.json", "first", { ifNoneMatch: "*" });
    assert.equal(first.sha256.length, 64);
    await assert.rejects(() => store.putMutable("public/current.json", "again", { ifNoneMatch: "*" }), /Conditional/);
    const current = await store.head("public/current.json");
    assert.ok(current?.etag);
    await assert.rejects(() => store.putMutable("public/current.json", "stale", { ifMatch: "0" }), /Conditional/);
    await store.putMutable("public/current.json", "second", { ifMatch: current!.etag });
    await assert.rejects(() => store.putMutable("public/current.json", "third", { ifMatch: current!.etag }), /Conditional/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packageRelease rejects evidence-class records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-evidence-"));
  try {
    const sourcePath = path.join(root, "src", "tiny.txt");
    const bytes = Buffer.from("leak\n", "utf8");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, bytes);
    const record = {
      id: "tiny-evidence",
      kind: "documentation" as const,
      label: "Evidence",
      description: "test",
      path: "src/tiny.txt",
      downloadName: "tiny.txt",
      mediaType: "text/plain; charset=utf-8",
      deliveryClass: "evidence" as const,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    };
    const bundleSha256 = publicReleaseBundleDigest([record]);
    await mkdir(path.join(root, "artifacts", "public-survey-footprints"), { recursive: true });
    await writeFile(
      path.join(root, "artifacts", "public-survey-footprints", "release-manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-28T00:00:00Z", bundle: { id: "tiny-release", sha256: bundleSha256 }, files: [record] })}\n`,
    );
    await assert.rejects(() => packageRelease({ root, outputPath: path.join(root, "out.tar.gz") }), /must not package evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed archive pull preserves the previously active current symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-preserve-"));
  try {
    await makeSource(root);
    const descriptor = await packageRelease({ root, outputPath: path.join(root, "release.tar.gz") });
    const store = new LocalS3Store(new FilesystemArtifactStore(path.join(root, "objects")));
    await publishReleaseArchive(descriptor, store);
    const target = path.join(root, "target");
    await syncReleaseFromObjectStore(store, target);
    const before = await readFile(path.join(target, "current", "src", "tiny.txt"), "utf8");
    assert.equal(before, "archive release\n");
    const pointer = JSON.parse((await store.get("public/current.json"))!.body.toString("utf8"));
    pointer.archiveSha256 = "f".repeat(64);
    await store.putMutable("public/current.json", `${JSON.stringify(pointer, null, 2)}\n`);
    await assert.rejects(() => syncReleaseFromObjectStore(store, target), /checksum|Release archive/);
    assert.equal(await readFile(path.join(target, "current", "src", "tiny.txt"), "utf8"), "archive release\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline restart reuses a validated installed current when the pointer is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-offline-"));
  try {
    await makeSource(root);
    const descriptor = await packageRelease({ root, outputPath: path.join(root, "release.tar.gz") });
    const objects = new FilesystemArtifactStore(path.join(root, "objects"));
    const store = new LocalS3Store(objects);
    await publishReleaseArchive(descriptor, store);
    const target = path.join(root, "target");
    await syncReleaseFromObjectStore(store, target);
    const offline: ArtifactStore = {
      kind: "s3",
      head: async () => null,
      get: async () => {
        throw new Error("object store offline");
      },
      putImmutable: async () => {
        throw new Error("object store offline");
      },
      putMutable: async () => {
        throw new Error("object store offline");
      },
      putFileImmutable: async () => {
        throw new Error("object store offline");
      },
      downloadToFile: async () => {
        throw new Error("object store offline");
      },
    };
    const reused = await syncReleaseFromObjectStore(offline, target, { allowInstalledFallback: true });
    assert.equal(reused.bundle.sha256, descriptor.bundle.sha256);
    assert.equal(reused.archiveKey, "");
    assert.equal(await readFile(path.join(target, "current", "src", "tiny.txt"), "utf8"), "archive release\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict archive pull does not reuse an installed cache when the object store is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-strict-offline-"));
  try {
    await makeSource(root);
    const descriptor = await packageRelease({ root, outputPath: path.join(root, "release.tar.gz") });
    const store = new LocalS3Store(new FilesystemArtifactStore(path.join(root, "objects")));
    await publishReleaseArchive(descriptor, store);
    const target = path.join(root, "target");
    await syncReleaseFromObjectStore(store, target);
    const offline: ArtifactStore = {
      kind: "s3",
      head: async () => null,
      get: async () => { throw new Error("object store offline"); },
      putImmutable: async () => { throw new Error("object store offline"); },
      putMutable: async () => { throw new Error("object store offline"); },
      putFileImmutable: async () => { throw new Error("object store offline"); },
      downloadToFile: async () => { throw new Error("object store offline"); },
    };
    await assert.rejects(
      () => syncReleaseFromObjectStore(offline, target, { allowInstalledFallback: false }),
      /object store offline/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict artifact stores reject an unconfigured object store", () => {
  assert.throws(() => createArtifactStore({ requireS3: true }), /ENDPOINT and .*BUCKET.*required/);
});

test("local storage layout keeps cache, scratch and uploads separate", async () => {
  const layout = storageLayout(path.join(os.tmpdir(), "asa-local-storage-test"));
  assert.equal(layout.cacheRoot, path.join(layout.root, "cache"));
  assert.equal(layout.scratchRoot, path.join(layout.root, "scratch"));
  assert.equal(layout.uploadsRoot, path.join(layout.root, "uploads"));
  assert.notEqual(layout.cacheRoot, layout.scratchRoot);
  assert.notEqual(layout.scratchRoot, layout.uploadsRoot);
  assert.throws(() => storageLayout(path.parse(layout.root).root), /must not be a filesystem root/);
});

test("corrupt cached release directory is discarded and re-downloaded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-cache-heal-"));
  try {
    await makeSource(root);
    const descriptor = await packageRelease({ root, outputPath: path.join(root, "release.tar.gz") });
    const store = new LocalS3Store(new FilesystemArtifactStore(path.join(root, "objects")));
    await publishReleaseArchive(descriptor, store);
    const target = path.join(root, "target");
    await syncReleaseFromObjectStore(store, target);
    const releaseDir = path.join(target, "releases", descriptor.bundle.sha256);
    await writeFile(path.join(releaseDir, "src", "tiny.txt"), "corrupted cache\n");
    const healed = await syncReleaseFromObjectStore(store, target);
    assert.equal(healed.bundle.sha256, descriptor.bundle.sha256);
    assert.equal(await readFile(path.join(target, "current", "src", "tiny.txt"), "utf8"), "archive release\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive with a symbolic-link member is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-archive-symlink-"));
  try {
    await makeSource(root);
    const descriptor = await packageRelease({ root, outputPath: path.join(root, "good.tar.gz") });
    const tree = path.join(root, "evil-tree");
    await mkdir(path.join(tree, "src"), { recursive: true });
    await writeFile(path.join(tree, "src", "tiny.txt"), "archive release\n");
    await mkdir(path.join(tree, "artifacts", "public-survey-footprints"), { recursive: true });
    await writeFile(
      path.join(tree, "artifacts", "public-survey-footprints", "release-manifest.json"),
      await readFile(path.join(root, "artifacts", "public-survey-footprints", "release-manifest.json")),
    );
    await symlink("tiny.txt", path.join(tree, "src", "link.txt"));
    const evilArchive = path.join(root, "evil.tar.gz");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("tar", ["--create", "--gzip", "--file", evilArchive, "-C", tree, "."]);
    const store = new LocalS3Store(new FilesystemArtifactStore(path.join(root, "objects")));
    const evilDescriptor = {
      ...descriptor,
      archivePath: evilArchive,
      archiveSizeBytes: (await stat(evilArchive)).size,
      archiveSha256: sha256(await readFile(evilArchive)),
    };
    await publishReleaseArchive(evilDescriptor, store);
    await assert.rejects(() => syncReleaseFromObjectStore(store, path.join(root, "target")), /symbolic or hard links|unsafe path|Release archive/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
