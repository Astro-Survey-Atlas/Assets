import assert from "node:assert/strict";
import test from "node:test";

import { AccessError } from "../server/region-access.js";
import {
  decodeReverseCursor,
  encodeReverseCursor,
  pageReversePlan,
  reversePageSize,
  reversePlanItems,
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

test("reverse cursors bind identity and query fingerprint and reject tampering", () => {
  const payload: ReverseCursorPayload = { version: 1, identity: "preview", fingerprint: "query-a", seenKeys: ["file:file-a"] };
  const cursor = encodeReverseCursor(payload, "test-secret");
  assert.deepEqual(decodeReverseCursor(cursor, "managed-key:1", "query-a", "test-secret"), payload);
  assert.throws(() => decodeReverseCursor(cursor, "managed-key:1", "query-b", "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  assert.throws(() => decodeReverseCursor(`${cursor.slice(0, -1)}x`, "managed-key:1", "query-a", "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 400);

  const protectedCursor = encodeReverseCursor({ ...payload, identity: "managed-key:1" }, "test-secret");
  assert.throws(() => decodeReverseCursor(protectedCursor, "managed-key:2", "query-a", "test-secret"), (error: unknown) => error instanceof AccessError && error.statusCode === 403);
});

test("reverse page size stays within the public bound", () => {
  assert.equal(reversePageSize(undefined), undefined);
  assert.equal(reversePageSize(20), 20);
  assert.throws(() => reversePageSize(0), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
  assert.throws(() => reversePageSize(101), (error: unknown) => error instanceof AccessError && error.statusCode === 400);
});
