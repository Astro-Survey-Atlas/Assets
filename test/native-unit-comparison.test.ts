import assert from "node:assert/strict";
import test from "node:test";
import { compareNativeGroups } from "../server/native-unit-comparison.js";
import type { NativeBinding, NativeGroup, NativeSnapshot } from "../server/native-unit-model.js";

const sourceId = "fixture-source";

function binding(overrides: Partial<NativeBinding> = {}): NativeBinding {
  return {
    productId: "product-a", layerId: "layer-a", surveyId: "survey-a", releaseId: "release-a",
    product: "Imaging", modality: "imaging", unitKind: "tile", sourceIds: [sourceId],
    revision: "revision-a", visibility: "published", ...overrides,
  };
}

function snapshot(overrides: Partial<NativeSnapshot> = {}): NativeSnapshot {
  return {
    id: "snapshot-a", sourceId, sourceRevision: 1, capturedAt: "2026-10-01T00:00:00.000Z",
    files: [{ ref: "inputs/source.json", sha256: "a".repeat(64), sizeBytes: 10 }],
    scope: "all rows", sourceUrl: "https://example.test/metadata", rowCount: 1, ...overrides,
  };
}

function group(overrides: Partial<NativeGroup> = {}): NativeGroup {
  return {
    id: "group-a", createdAt: "2026-10-01T00:00:00.000Z", origin: "managed-build",
    generic: { file: { ref: "indexes/generic.sqlite", sha256: "b".repeat(64), sizeBytes: 20 }, buildKey: "generic-a" },
    lockText: '{"schemaVersion":1,"inputs":[]}', recipes: { layer: "recipe-a" },
    snapshots: { [sourceId]: snapshot() }, bindings: [binding()],
    report: { checks: [{ id: "fixture", passed: true, detail: "ok" }], gaps: [], counts: {}, samples: [] },
    ...overrides,
  };
}

test("native comparison identifies the active generation and ignores binding revision metadata", () => {
  const active = group();
  const candidate = group({ id: "candidate", bindings: [binding({ revision: "revision-b" })], lockText: '{ "inputs": [], "schemaVersion": 1 }' });
  const comparison = compareNativeGroups(active, candidate, 13);

  assert.deepEqual(comparison.baseline, { groupId: "group-a", generation: 13 });
  assert.equal(comparison.hasChanges, false);
  assert.equal(comparison.summary.products.unchanged, 1);
  assert.equal(comparison.products[0]?.state, "unchanged");
  assert.deepEqual(comparison.products[0]?.bindingFields, []);
});

test("native comparison names changed binding fields and source snapshots", () => {
  const active = group();
  const candidate = group({
    id: "candidate",
    bindings: [binding({ layerId: "layer-b", modality: "radio" })],
    snapshots: { [sourceId]: snapshot({ id: "snapshot-b", sourceRevision: 2, rowCount: 2, files: [{ ref: "inputs/source.json", sha256: "c".repeat(64), sizeBytes: 11 }] }) },
    generic: { file: { ref: "indexes/generic.sqlite", sha256: "d".repeat(64), sizeBytes: 21 }, buildKey: "generic-b" },
  });
  const comparison = compareNativeGroups(active, candidate, 13);

  assert.equal(comparison.hasChanges, true);
  assert.equal(comparison.products[0]?.state, "modified");
  assert.deepEqual(comparison.products[0]?.bindingFields, ["layerId", "modality"]);
  assert.ok(comparison.products[0]?.changes.includes(`snapshot:${sourceId}`));
  assert.equal(comparison.inputs[0]?.state, "modified");
  assert.equal(comparison.artifacts.find(item => item.id === "generic")?.state, "modified");
});

test("native comparison handles optional binding fields missing from the candidate", () => {
  const active = group({ bindings: [binding({ selector: { bands: ["g", "r"] } })] });
  const candidate = group({ id: "candidate", bindings: [binding()] });
  const comparison = compareNativeGroups(active, candidate, 13);

  assert.equal(comparison.hasChanges, true);
  assert.equal(comparison.products[0]?.state, "modified");
  assert.deepEqual(comparison.products[0]?.bindingFields, ["selector"]);
});

test("native comparison reports additions and removals without row-level unit diffs", () => {
  const active = group({ bindings: [binding(), binding({ productId: "removed-product" })] });
  const candidate = group({
    id: "candidate",
    bindings: [binding(), binding({ productId: "added-product", layerId: "layer-added" })],
  });
  const comparison = compareNativeGroups(active, candidate, 13);

  assert.equal(comparison.summary.products.unchanged, 1);
  assert.equal(comparison.summary.products.added, 1);
  assert.equal(comparison.summary.products.removed, 1);
  assert.equal(comparison.products.find(item => item.productId === "added-product")?.state, "added");
  assert.equal(comparison.products.find(item => item.productId === "removed-product")?.state, "removed");
});

test("first managed baseline is explicitly incomparable with an active generation", () => {
  const comparison = compareNativeGroups(undefined, group(), 0);
  assert.equal(comparison.baseline, null);
  assert.equal(comparison.hasChanges, null);
  assert.equal(comparison.summary.products.added, 1);
});
