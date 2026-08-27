import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError } from "../server/admin.js";
import { MocDiscoveryReviewStore } from "../server/moc-discovery.js";

test("MOC discovery reviews are versioned by provider, candidate, and snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-review-"));
  const store = new MocDiscoveryReviewStore(root);
  const sourceSnapshotSha256 = "a".repeat(64);
  const first = await store.add("gaia-moc-discovery-20260826", {
    provider: "cds",
    candidateId: "ivo://cds.example/gaia-dr3",
    sourceSnapshotSha256,
    decision: "pending",
    sourceUrl: "https://alasky.cds.unistra.fr/gaia",
  });
  const second = await store.add("gaia-moc-discovery-20260826", {
    provider: "cds",
    candidateId: "ivo://cds.example/gaia-dr3",
    sourceSnapshotSha256,
    decision: "ready-for-build",
    notes: "MOC header and attribution reviewed",
  });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal((await store.list(first.requestName)).length, 2);
  await assert.rejects(() => store.add(first.requestName, {
    candidateId: "candidate",
    sourceSnapshotSha256: "not-a-hash",
    decision: "ready-for-build",
  }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  const raw = await readFile(path.join(root, "moc-discovery-reviews-v1.ndjson"), "utf8");
  assert.equal(raw.trim().split("\n").length, 2);
});
