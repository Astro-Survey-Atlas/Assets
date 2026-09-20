import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withLocalFileLock } from "../server/local-file-lock.js";

test("same-PID callers cannot steal a live release lock; stale file contents are harmless", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-flock-"));
  const file = path.join(root, ".sync.lock");
  try {
    await writeFile(file, "1");
    await withLocalFileLock(file, async () => {
      await assert.rejects(() => withLocalFileLock(file, async () => assert.fail("concurrent owner")), /already running/);
    });
    assert.equal(await withLocalFileLock(file, async () => 42), 42);
    await assert.rejects(() => withLocalFileLock(file, async () => { throw new Error("restore failed"); }), /restore failed/);
    assert.equal(await withLocalFileLock(file, async () => 43), 43);
  } finally { await rm(root, { recursive: true, force: true }); }
});
