import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MocBuildStore, type MocBuildRequest } from "../server/moc-build.js";

test("an output byte-identical to the archived source is enqueued once (shared content-addressed upload id)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "moc-dedupe-"));
  const bytes = Buffer.from("same-bytes-for-source-and-normalized-moc");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "build/source.fits"), bytes);
  await writeFile(path.join(root, "build/moc.fits"), bytes);
  const calls: Array<{ kind?: string; objectKey?: string }> = [];
  const sink = { enqueue: async () => { throw new Error("unused"); }, enqueueFile: async (request: any) => {
    calls.push({ kind: request.kind, objectKey: request.objectKey });
    return { namespace: request.namespace, objectKey: request.objectKey, sha256, sizeBytes: bytes.length, uploadId: "u" };
  } };
  const store = new MocBuildStore(path.join(root, "content"), sink as never, root);
  const request = { name: "x", source: { url: "u", snapshotSha256: sha256, sizeBytes: bytes.length, evidenceRef: "build/source.fits" },
    outputs: { moc: { ref: "build/moc.fits", sha256, sizeBytes: bytes.length } } } as unknown as MocBuildRequest;
  await store.queueOutputFiles(request, root);
  assert.deepEqual(calls.map((call) => call.kind), ["moc-build-source"]);
});
