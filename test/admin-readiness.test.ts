import assert from "node:assert/strict";
import test from "node:test";

import { aggregateReadiness, deriveProductReadiness, type ReadinessLayer } from "../server/admin-readiness.js";

const content = {
  productId: "demo-product",
  surveyId: "demo",
  releaseId: "dr1",
  name: "Demo DR1",
  sourceUrl: "https://archive.example/dr1",
};

function layer(overrides: Partial<ReadinessLayer> = {}): ReadinessLayer {
  return {
    availableOrders: [4, 8],
    overviewOrder: 4,
    maxOrder: 8,
    cellCount: 12,
    recipe: { mode: "native-moc", coordinateFrame: "ICRS", ordering: "NESTED", sourceSnapshotSha256: "a".repeat(64) },
    sourceUnitIndex: { status: "entrypoint-only", notes: "public MOC" },
    ...overrides,
  };
}

test("readiness keeps an untraceable product below L0", () => {
  const result = deriveProductReadiness({ content: { ...content, sourceUrl: undefined } });
  assert.equal(result.level, -1);
  assert.equal(result.label, "needs-information");
  assert.deepEqual(result.geometry.orders, []);
  assert.ok(result.gaps.includes("source-not-traceable"));
});

test("a validated public MOC is L1 with its real orders and entrypoint-only reverse lookup", () => {
  const result = deriveProductReadiness({ content: { ...content, mode: "native-moc", sourceTier: "third_party_moc" }, layer: layer() });
  assert.equal(result.level, 1);
  assert.equal(result.label, "coverage-queryable");
  assert.deepEqual(result.geometry.orders, [4, 8]);
  assert.equal(result.geometry.precision, "estimated");
  assert.equal(result.reverseLookup.level, 0);
  assert.equal(result.reverseLookup.precision, "entrypoint-only");
  assert.equal(result.evidence.inputLocked, true);
  assert.ok(result.gaps.includes("file-level-reverse-index-missing"));
});

test("an explicit estimated footprint remains estimated with real ICRS/NESTED orders", () => {
  const result = deriveProductReadiness({
    content: { ...content, mode: "regions", sourceTier: "official_geometry" },
    layer: layer({ recipe: { mode: "regions", coordinateFrame: "ICRS", ordering: "NESTED", precision: "estimated" } }),
  });
  assert.equal(result.level, 1);
  assert.deepEqual(result.geometry.orders, [4, 8]);
  assert.equal(result.geometry.precision, "estimated");
  assert.equal(result.geometry.basis, "layer");
  assert.equal(result.geometry.coordinateFrame, "ICRS");
  assert.equal(result.geometry.ordering, "NESTED");
  assert.equal(result.reverseLookup.precision, "entrypoint-only");
});

test("a stable tile index reaches L2 while preserving estimated spatial precision", () => {
  const result = deriveProductReadiness({
    content: { ...content, mode: "tile-table", sourceTier: "official_inventory_derived" },
    layer: layer({ recipe: { mode: "tile-table", coordinateFrame: "ICRS", ordering: "NESTED" }, sourceUnitIndex: { status: "estimated", unitKind: "tile", notes: "tile geometry is estimated" } }),
  });
  assert.equal(result.level, 2);
  assert.equal(result.reverseLookup.level, 2);
  assert.equal(result.reverseLookup.unitKind, "tile");
  assert.equal(result.reverseLookup.precision, "estimated");
});

test("an exact file index reaches L3 and does not claim completeness without a denominator", () => {
  const result = deriveProductReadiness({
    content: { ...content, mode: "fits-wcs", sourceTier: "official_inventory_derived" },
    layer: layer({ recipe: { mode: "fits-wcs", coordinateFrame: "ICRS", ordering: "NESTED" }, sourceUnitIndex: { status: "exact", unitKind: "file", notes: "warehouse index" }, fileCount: 42, coverageCount: 84 }),
  });
  assert.equal(result.level, 3);
  assert.equal(result.reverseLookup.level, 3);
  assert.equal(result.reverseLookup.precision, "exact");
  assert.equal(result.completeness.state, "unknown");
  assert.ok(result.gaps.includes("completeness-unknown"));
});

test("draft Warehouse counters remain visible without claiming loaded geometry", () => {
  const result = deriveProductReadiness({
    content: { ...content, mode: "native-moc", sourceTier: "third_party_moc" },
    completeness: {
      state: "partial",
      fileCount: 42,
      coverageCount: 84,
      errorCount: 3,
      asOf: "2026-09-25T00:00:00.000Z",
      scope: "current Warehouse layer metadata; unpublished geometry is not loaded",
    },
  });
  assert.equal(result.level, 0);
  assert.deepEqual(result.geometry.orders, []);
  assert.equal(result.geometry.maxOrder, undefined);
  assert.equal(result.geometry.basis, "entrypoint");
  assert.deepEqual(result.completeness, {
    state: "partial",
    fileCount: 42,
    coverageCount: 84,
    errorCount: 3,
    asOf: "2026-09-25T00:00:00.000Z",
    scope: "current Warehouse layer metadata; unpublished geometry is not loaded",
  });
});

test("aggregate readiness reports capability distributions and mixed precision", () => {
  const entries = [
    deriveProductReadiness({ content: content, layer: layer() }),
    deriveProductReadiness({ content: { ...content, productId: "tile", mode: "tile-table" }, layer: layer({ recipe: { mode: "tile-table", coordinateFrame: "ICRS", ordering: "NESTED" }, sourceUnitIndex: { status: "estimated", unitKind: "tile" } }) }),
    deriveProductReadiness({ content: { ...content, productId: "file", mode: "fits-wcs" }, layer: layer({ recipe: { mode: "fits-wcs", coordinateFrame: "ICRS", ordering: "NESTED" }, sourceUnitIndex: { status: "exact", unitKind: "file" } }) }),
  ];
  const result = aggregateReadiness(entries);
  assert.equal(result.productCount, 3);
  assert.deepEqual(result.levelCounts, { L0: 0, L1: 1, L2: 1, L3: 1, needsInformation: 0 });
  assert.deepEqual(result.capabilityCounts, { coverage: 3, unit: 2, file: 1 });
  assert.deepEqual(result.geometryOrders, [4, 8]);
  assert.equal(result.geometryPrecision, "mixed");
  assert.equal(result.reverseLookupPrecision, "mixed");
});
