import assert from "node:assert/strict";
import test from "node:test";

import { coverageCatalogFromWarehouse, type CoverageCellLayer } from "../server/coverage.js";
import type { WarehouseCoverageCatalogSnapshot } from "../server/evidence-store.js";

function layer(layerId: string, surveyId: string, pixels: number[], product = layerId): CoverageCellLayer {
  const cells = new Map([[4, pixels]]);
  return {
    layerId,
    productId: `${layerId}-product`,
    surveyId,
    releaseId: `${surveyId}-release`,
    product,
    color: "#ffffff",
    availableOrders: [4],
    overviewOrder: 4,
    maxOrder: 4,
    cellCount: pixels.length,
    areaDeg2: 1,
    tileScheme: "ipix-range-4096" as const,
    cells,
  };
}

function warehouseLayer(layerId: string, surveyId: string, productId = `${layerId}-warehouse`): WarehouseCoverageCatalogSnapshot["layers"][number] {
  return {
    layerId,
    surveyId,
    releaseId: `${surveyId}-release`,
    productId,
    state: "ACTIVE",
    availableOrders: [8],
    fileCount: 1,
    coverageCount: 1,
    errorCount: 0,
  };
}

test("Warehouse coverage preserves static layers, overrides matching identities, and adds new layers", () => {
  const staticBase = layer("static-layer", "static", [1, 2], "static product");
  const staticOnly = layer("static-only", "legacy", [3]);
  const base = {
    schemaVersion: 1 as const,
    coordinateFrame: "ICRS" as const,
    ordering: "NESTED" as const,
    tileScheme: "ipix-range-4096" as const,
    layers: [],
    records: new Map([[staticBase.layerId, staticBase], [staticOnly.layerId, staticOnly]]),
  };
  const snapshot: WarehouseCoverageCatalogSnapshot = {
    layers: [
      warehouseLayer("static-layer", "static"),
      warehouseLayer("warehouse-layer", "warehouse"),
    ],
    coverages: [
      { layerId: "static-layer", order: 8, ipix: 100 },
      { layerId: "warehouse-layer", order: 8, ipix: 200 },
    ],
    truncated: false,
  };

  const merged = coverageCatalogFromWarehouse(base, snapshot);

  assert.deepEqual([...merged.records.keys()], ["static-layer", "static-only", "warehouse-layer"]);
  assert.deepEqual(merged.records.get("static-only")?.cells.get(4), [3]);
  assert.deepEqual(merged.records.get("static-layer")?.cells.get(8), [100]);
  assert.equal(merged.records.get("static-layer")?.cells.has(4), false);
  assert.deepEqual(merged.records.get("warehouse-layer")?.cells.get(8), [200]);
  assert.deepEqual(merged.layers.map(({ layerId }) => layerId), ["static-layer", "static-only", "warehouse-layer"]);
});
