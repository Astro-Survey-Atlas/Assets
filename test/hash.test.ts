import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256File, sha256FileDetails, sha256Hex } from "../server/hash.js";

const reference = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");

test("sha256Hex matches node:crypto for bytes, UTF-8 strings and the empty input", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  for (const input of ["abc", "巡天覆盖 · ICRS", Buffer.from([0, 1, 2, 255]), new Uint8Array(4096).fill(7)]) {
    assert.equal(sha256Hex(input), reference(input));
  }
});

test("sha256File streams multi-chunk files to the same digest and size", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-hash-"));
  try {
    // Larger than the 64 KiB default stream chunk so the digest spans several updates.
    const bytes = Buffer.alloc(300_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) & 0xff;
    const file = path.join(root, "payload.bin");
    await writeFile(file, bytes);
    assert.deepEqual(await sha256FileDetails(file), { sizeBytes: bytes.length, sha256: reference(bytes) });
    assert.equal(await sha256File(file), reference(bytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
