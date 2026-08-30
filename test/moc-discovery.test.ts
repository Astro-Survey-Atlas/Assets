import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError } from "../server/admin.js";
import { MocDiscoveryReviewStore, resolveMocDiscoveryReview } from "../server/moc-discovery.js";

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

test("MOC reviews resolve authoritative candidate URLs and hashes from Warehouse status", () => {
  const request = {
    name: "jwst-moc-discovery",
    status: {
      phase: "SUCCEEDED",
      reviewSummary: {
        schemaVersion: 1,
        truncated: false,
        summaryTruncated: false,
        candidates: [{ candidateId: "jwst", title: "JWST", recordUrl: "https://alasky.cds.unistra.fr/jwst" }],
        probes: [{ probeId: "a".repeat(64), candidateId: "jwst", kind: "mocUrl", url: "https://alasky.cds.unistra.fr/jwst/moc.fits", ok: true, sha256: "b".repeat(64), validation: { acceptedSpatialMoc: true } }],
      },
    },
  };

  const review = resolveMocDiscoveryReview(request, { candidateId: "jwst", probeId: "a".repeat(64), decision: "ready-for-build", notes: "verified" });

  assert.equal(review.sourceSnapshotSha256, "b".repeat(64));
  assert.equal(review.sourceUrl, "https://alasky.cds.unistra.fr/jwst");
  assert.equal(review.mocUrl, "https://alasky.cds.unistra.fr/jwst/moc.fits");
  assert.throws(() => resolveMocDiscoveryReview(request, { candidateId: "invented", decision: "rejected" }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
});

test("MOC review resolution distinguishes failed probes and missing summaries", () => {
  const failedProbeRequest = {
    name: "gaia-moc-discovery",
    status: {
      phase: "SUCCEEDED",
      reviewSummary: {
        schemaVersion: 1,
        truncated: false,
        summaryTruncated: false,
        candidates: [{ candidateId: "gaia" }],
        probes: [{ probeId: "c".repeat(64), candidateId: "gaia", kind: "mocUrl", url: "https://example.invalid/gaia.fits", ok: false, error: "HTTP 404" }],
      },
    },
  };
  assert.throws(() => resolveMocDiscoveryReview(failedProbeRequest, { candidateId: "gaia", probeId: "c".repeat(64), decision: "ready-for-build" }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409);
  const pending = resolveMocDiscoveryReview(failedProbeRequest, { candidateId: "gaia", probeId: "c".repeat(64), decision: "pending" });
  assert.equal(pending.probeId, "c".repeat(64));
  assert.equal(pending.sourceSnapshotSha256, undefined);

  assert.throws(() => resolveMocDiscoveryReview({ name: "legacy", status: { phase: "SUCCEEDED" } }, { candidateId: "gaia", decision: "rejected" }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409 && /summary is unavailable/.test(error.message));
});
