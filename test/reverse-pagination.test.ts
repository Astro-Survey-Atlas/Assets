import assert from "node:assert/strict";
import test from "node:test";

import { AccessError } from "../server/region-access.js";
import {
  decodeReverseCursor,
  encodeReverseCursor,
  partitionReverseCells,
  pageReversePlan,
  reversePageSize,
  reversePlanItems,
  REVERSE_CURSOR_MAX_BYTES,
  REVERSE_CURSOR_MAX_KEY_LENGTH,
  REVERSE_CURSOR_MAX_KEYS,
  REVERSE_QUERY_BATCH_MAX_AREA_DEG2,
  REVERSE_QUERY_BATCH_MAX_CELLS,
  type ReverseCursorPayload,
} from "../server/reverse-pagination.js";
import type { DownloadPlan } from "../server/evidence-store.js";

function plan(): DownloadPlan {
  return {
    schemaVersion: 1,
    files: ["file-a", "file-b", "file-c"].map((fileId) => ({ fileId, metadataState: "complete", downloadable: false, matchingCoverage: [] })),
    entrypoints: [{ kind: "official-release", purpose: "data-access", layerId: "layer-1", product: "Product", precision: "entrypoint-only", url: "https://example.test/release" }],
    truncated: false,
    warnings: [],
  };
}

test("reverse pages advance without repeating files or entrypoints", () => {
  const source = plan();
  const first = pageReversePlan(source, new Set(), 2);
  assert.deepEqual(first.plan.files.map((file) => file.fileId), ["file-a", "file-b"]);
  assert.equal(first.plan.entrypoints.length, 0);
  assert.equal(first.hasMore, true);

  const second = pageReversePlan(source, new Set(first.keys), 2);
  assert.deepEqual(second.plan.files.map((file) => file.fileId), ["file-c"]);
  assert.deepEqual(second.plan.entrypoints.map((entry) => entry.url), ["https://example.test/release"]);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.keys, ...second.keys]).size, reversePlanItems(source).length);
});

test("coverage evidence participates in the same cursor pagination as files and entrypoints", () => {
  const source = {
    ...plan(),
    coverageEvidence: [{
      layerId: "layer-1",
      productId: "product-1",
      surveyId: "hst",
      releaseId: "hst-snapshot",
      product: "HST observation footprints",
      evidenceKind: "published-moc" as const,
      order: 4,
      nside: 16,
      nativeMaxOrder: 10,
      availableOrders: [4],
      matchedCells: [123],
      precision: "estimated" as const,
      summary: "Coverage only; no science file match is asserted.",
    }],
  };
  const first = pageReversePlan(source, new Set(), 4);
  assert.equal(first.plan.coverageEvidence?.length, 0);
  assert.equal(first.hasMore, true);
  const second = pageReversePlan(source, new Set(first.keys), 4);
  assert.deepEqual(second.plan.coverageEvidence?.map((evidence) => evidence.layerId), ["layer-1"]);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.keys, ...second.keys]).size, reversePlanItems(source).length);
});

test("spatial-unit and supporting-evidence pages do not consume each other's cursor items", () => {
  const source: DownloadPlan = {
    ...plan(),
    spatialUnits: ["tile-1", "tile-2"].map((unitId) => ({
      layerId: "layer-1",
      productId: "product-1",
      surveyId: "desi",
      releaseId: "dr1",
      product: "Spectra",
      unitKind: "tile",
      unitId,
      order: 8,
      nside: 256,
      matchingCells: [123],
      precision: "estimated",
      accessUri: `https://example.test/${unitId}`,
    })),
  };
  const firstUnits = pageReversePlan(source, new Set(), 1, "spatial-units");
  assert.deepEqual(firstUnits.plan.spatialUnits?.map((unit) => unit.unitId), ["tile-1"]);
  assert.deepEqual(firstUnits.plan.files, []);
  assert.deepEqual(firstUnits.plan.entrypoints, []);
  assert.equal(firstUnits.hasMore, true);

  const firstSupport = pageReversePlan(source, new Set(), 2, "supporting-evidence");
  assert.equal(firstSupport.plan.spatialUnits?.length, 0);
  assert.deepEqual(firstSupport.plan.files.map((file) => file.fileId), ["file-a", "file-b"]);
  assert.equal(firstSupport.hasMore, true);

  const nextUnitPage = pageReversePlan(source, new Set(firstUnits.keys), 2, "spatial-units");
  assert.deepEqual(nextUnitPage.plan.spatialUnits?.map((unit) => unit.unitId), ["tile-2"]);
  assert.deepEqual(nextUnitPage.plan.files, []);
});

test("reverse cursors bind identity and query fingerprint and reject tampering", () => {
  const payload: ReverseCursorPayload = { version: 1, identity: "preview", fingerprint: "query-a", seenKeys: ["file:file-a"] };
  const cursor = encodeReverseCursor(payload, "test-secret");
  assert.deepEqual(decodeReverseCursor(cursor, "managed-key:1", "query-a", "test-secret"), payload);
  assert.throws(() => decodeReverseCursor(cursor, "managed-key:1", "query-b", "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  assert.throws(() => decodeReverseCursor(`${cursor.slice(0, -1)}x`, "managed-key:1", "query-a", "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);

  const protectedCursor = encodeReverseCursor({ ...payload, identity: "managed-key:1" }, "test-secret");
  assert.throws(() => decodeReverseCursor(protectedCursor, "managed-key:2", "query-a", "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 403);

  const spatialCursor = encodeReverseCursor({ ...payload, scope: "spatial-units" }, "test-secret");
  assert.deepEqual(decodeReverseCursor(spatialCursor, "managed-key:1", "query-a", "test-secret", "spatial-units")?.seenKeys, payload.seenKeys);
  assert.throws(() => decodeReverseCursor(spatialCursor, "managed-key:1", "query-a", "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
});

test("reverse cursor encoder and decoder share bounded large-page limits", () => {
  const longPayload: ReverseCursorPayload = {
    version: 1,
    identity: "managed-key:fixture",
    fingerprint: "query-a",
    seenKeys: Array.from({ length: 1_408 }, (_, index) => `file:${String(index).padStart(4, "0")}${"x".repeat(REVERSE_CURSOR_MAX_KEY_LENGTH - 9)}`),
  };
  const cursor = encodeReverseCursor(longPayload, "test-secret");
  assert.ok(cursor.length <= REVERSE_CURSOR_MAX_BYTES);
  assert.equal(decodeReverseCursor(cursor, longPayload.identity, longPayload.fingerprint, "test-secret")?.seenKeys.length, 1_408);

  const payload: ReverseCursorPayload = {
    version: 1,
    identity: "managed-key:fixture",
    fingerprint: "query-a",
    seenKeys: Array.from({ length: REVERSE_CURSOR_MAX_KEYS }, (_, index) => `file:${String(index).padStart(8, "0")}`),
  };
  const largeCursor = encodeReverseCursor(payload, "test-secret");
  assert.ok(largeCursor.length <= REVERSE_CURSOR_MAX_BYTES);
  assert.equal(decodeReverseCursor(largeCursor, payload.identity, payload.fingerprint, "test-secret")?.seenKeys.length, REVERSE_CURSOR_MAX_KEYS);
  assert.throws(() => encodeReverseCursor({ ...payload, seenKeys: [...payload.seenKeys, "file:one-more"] }, "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  assert.throws(() => encodeReverseCursor({ ...payload, seenKeys: [`${"x".repeat(REVERSE_CURSOR_MAX_KEY_LENGTH + 1)}`] }, "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  assert.throws(() => encodeReverseCursor({ ...payload, identity: "x".repeat(REVERSE_CURSOR_MAX_BYTES) }, "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  assert.throws(() => decodeReverseCursor("x".repeat(REVERSE_CURSOR_MAX_BYTES + 1), payload.identity, payload.fingerprint, "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
});

test("reverse page size stays within the public bound", () => {
  assert.equal(reversePageSize(undefined), undefined);
  assert.equal(reversePageSize(20), 20);
  assert.throws(() => reversePageSize(0), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  assert.throws(() => reversePageSize(101), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
});

test("large reverse regions retain their native order and split below cell and area bounds", () => {
  const orderEightCells = Array.from({ length: 4_096 }, (_, index) => 100_000 + index);
  const batches = partitionReverseCells(8, orderEightCells);
  const cellArea = 41252.96124941927 / (12 * 4 ** 8);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length <= REVERSE_QUERY_BATCH_MAX_CELLS));
  assert.ok(batches.every((batch) => batch.length * cellArea <= REVERSE_QUERY_BATCH_MAX_AREA_DEG2));
  assert.deepEqual(batches.flat(), orderEightCells);

  const orderFourBatches = partitionReverseCells(4, [190, 191, 192, 193, 194, 195, 196, 197]);
  assert.deepEqual(orderFourBatches, [[190, 191, 192, 193, 194, 195, 196], [197]], "eight O4 cells exceed the per-query area budget");
  assert.throws(() => partitionReverseCells(0, [0]), (error: unknown) => error instanceof AccessError && error.statusCode === 413);
});
