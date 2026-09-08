import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import { test } from "node:test";

import { FilesystemArtifactStore } from "../server/artifact-store.js";
import { ContentArchiveSync } from "../server/content-archive.js";

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function treeHashes(root: string): Promise<Map<string, string>> {
  const { readdir, stat } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const files = new Map<string, string>();
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), child);
        continue;
      }
      const bytes = await readFile(path.join(directory, entry.name));
      files.set(child, createHash("sha256").update(bytes).digest("hex"));
      void stat;
    }
  };
  await walk(root, "");
  return files;
}

test("content archive snapshots, detects changes and restores a consistent tree", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "content-archive-"));
  try {
    const source = path.join(base, "source");
    const store = new FilesystemArtifactStore(path.join(base, "objects"));
    const archive = new ContentArchiveSync({ store, root: source, namespace: "content" });
    await assert.rejects(archive.snapshot(), /does not exist/);

    await writeTree(source, { "a.json": "{\"v\":1}\n", "nested/b.bin": "payload" });
    const first = await archive.snapshot();
    assert.equal(first.files, 2);
    assert.equal(first.uploadedObjects, 2);
    assert.equal(first.skipped, false);

    const unchanged = await archive.snapshot();
    assert.equal(unchanged.snapshot, first.snapshot);
    assert.equal(unchanged.skipped, true);

    await writeTree(source, { "a.json": "{\"v\":2}\n", "nested/c.bin": "more" });
    const second = await archive.snapshot();
    assert.notEqual(second.snapshot, first.snapshot);
    assert.equal(second.files, 3);
    assert.equal(second.uploadedObjects, 2);

    const target = path.join(base, "restored");
    const restored = await archive.restore({ targetRoot: target });
    assert.equal(restored.snapshot, second.snapshot);
    assert.equal(restored.restored, 3);
    assert.deepEqual([...(await treeHashes(target)).entries()], [...(await treeHashes(source)).entries()]);

    const pointer = await archive.readPointer();
    assert.equal(pointer?.snapshot, second.snapshot);
    assert.equal(pointer?.namespace, "content");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("content archive refuses overwriting conflicting local files without overwrite and reports diffs", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "content-archive-diff-"));
  try {
    const source = path.join(base, "source");
    const store = new FilesystemArtifactStore(path.join(base, "objects"));
    const archive = new ContentArchiveSync({ store, root: source, namespace: "evidence" });
    await writeTree(source, { "raw/one.fits": "fits-bytes", "keep.txt": "keep" });
    const filtered = new ContentArchiveSync({ store, root: source, namespace: "evidence", select: (relativePath) => relativePath.startsWith("raw/") });
    const snapshot = await filtered.snapshot();
    assert.equal(snapshot.files, 1);

    await writeTree(source, { "raw/one.fits": "tampered" });
    const diff = await filtered.diff();
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.extra.length, 0);

    await rm(path.join(source, "raw"), { recursive: true, force: true });
    await writeTree(source, { "raw/one.fits": "restored-conflict" });
    await assert.rejects(filtered.restore(), /Refusing to overwrite/);
    const forced = await filtered.restore({ overwrite: true });
    assert.equal(forced.restored, 1);
    assert.equal((await readFile(path.join(source, "raw/one.fits"), "utf8")), "fits-bytes");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
