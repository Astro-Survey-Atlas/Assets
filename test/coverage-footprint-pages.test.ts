import assert from "node:assert/strict";
import test from "node:test";
import { pageCoverageFootprints } from "../server/coverage-footprint-pages.js";
import { AccessError } from "../server/region-access.js";

const footprints = ["a", "b", "c"].map((layerId, index) => ({
  surveyId: "euclid",
  releaseId: "euclid-q1",
  product: `Product ${index}`,
  productId: `product-${index}`,
  layerId,
  nside: 16,
  pixels: [index, index + 10],
}));

test("coverage overview pages retain whole footprints and continue without duplicates", () => {
  const first = pageCoverageFootprints({ footprints, generatedAt: "2026-10-02T00:00:00.000Z", nside: 16, pageSize: 2, secret: "secret" });
  assert.equal(first.total, 3);
  assert.deepEqual(first.footprints.map(item => item.layerId), ["a", "b"]);
  assert.equal(first.page.shown, 2);
  assert.equal(first.page.hasMore, true);
  assert.ok(first.page.nextCursor);

  const second = pageCoverageFootprints({ footprints, generatedAt: "2026-10-02T00:00:00.000Z", nside: 16, pageSize: 2, cursor: first.page.nextCursor, secret: "secret" });
  assert.deepEqual(second.footprints.map(item => item.layerId), ["c"]);
  assert.equal(second.page.hasMore, false);
  assert.equal(second.page.nextCursor, undefined);
  assert.equal(second.revision, first.revision);
});

test("coverage overview cursors reject bad limits, tampering and changed snapshots", () => {
  assert.throws(() => pageCoverageFootprints({ footprints, generatedAt: "now", nside: 16, pageSize: 101, secret: "secret" }), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  const first = pageCoverageFootprints({ footprints, generatedAt: "before", nside: 16, pageSize: 1, secret: "secret" });
  assert.throws(() => pageCoverageFootprints({ footprints, generatedAt: "after", nside: 16, cursor: first.page.nextCursor, secret: "secret" }), (error: unknown) => error instanceof AccessError && error.statusCode === 409);
  assert.throws(() => pageCoverageFootprints({ footprints, generatedAt: "before", nside: 16, cursor: `${first.page.nextCursor}x`, secret: "secret" }), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
});
