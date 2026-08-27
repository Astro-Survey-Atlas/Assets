import assert from "node:assert/strict";
import test from "node:test";

import { coverageCatalogFromWarehouse, type CoverageCellLayer } from "../server/coverage.js";
import type { WarehouseCoverageCatalogSnapshot } from "../server/evidence-store.js";
import { footprintManifest, type CoverageCatalog } from "../site/src/atlas-coverage-globe.js";
import { buildSurveyLayerModel, visibleCoverageAtPixel, visibleSurveySlots } from "../site/src/atlas/survey-layer-model.js";
import { buildSphericalCellSourceSectorGeometry } from "../site/src/atlas/spherical-cell-geometry.js";
import * as THREE from "three";

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

test("coverage globe keeps O8-only Warehouse layers in the O4 visual overview", () => {
  const catalog: CoverageCatalog = {
    schemaVersion: 1,
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    tileScheme: "ipix-range-4096",
    layers: [
      {
        layerId: "static-euclid", productId: "euclid-product", surveyId: "euclid", releaseId: "q1", product: "Euclid", color: "#fff",
        availableOrders: [4], overviewOrder: 4, maxOrder: 4, cellCount: 1, areaDeg2: 1, tileScheme: "ipix-range-4096",
        tileIdsByOrder: { "4": [0] },
      },
      {
        layerId: "warehouse-gaia", productId: "gaia-product", surveyId: "gaia", releaseId: "dr3", product: "Gaia", color: "#fff",
        availableOrders: [8], overviewOrder: 8, maxOrder: 8, cellCount: 1, areaDeg2: 1, tileScheme: "ipix-range-4096",
        tileIdsByOrder: { "8": [3] },
      },
    ],
  };
  const manifest = footprintManifest(catalog, new Map([
    ["static-euclid:4", [637]],
    ["warehouse-gaia:8", [15_612]],
  ]));
  const gaia = manifest.footprints.find((footprint) => footprint.surveyId === "gaia");
  assert.ok(gaia, "the O8-only Gaia layer should be visible in the overview manifest");
  assert.equal(manifest.nside, 16);
  assert.deepEqual(gaia?.pixels, [60]);
});

test("coverage viewer keeps a Warehouse-only survey visible when public metadata is absent", () => {
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-08-26T00:00:00.000Z",
    coordinateFrame: "ICRS" as const,
    nside: 16,
    footprints: [{
      surveyId: "gaia",
      releaseId: "dr3-smoke",
      product: "catalog-gaia",
      label: "catalog-gaia",
      nside: 16,
      pixels: [60, 61],
      quality: "official_overview" as const,
      sourceUrl: "https://assets.local/coverage/catalog",
      retrievedAt: "2026-08-26T00:00:00.000Z",
      notes: "Warehouse-only visual overview",
    }],
  };
  const model = buildSurveyLayerModel([], manifest);
  assert.ok(model.slots.some((slot) => slot.surveyId === "gaia" && slot.hasFootprint));
  assert.deepEqual(visibleSurveySlots(model, ["gaia"], "layers").map((slot) => slot.surveyId), ["gaia"]);
});

test("single-survey source membership is keyed by layer identity and sorted deterministically", () => {
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-08-26T00:00:00.000Z",
    coordinateFrame: "ICRS" as const,
    nside: 16,
    footprints: [
      { layerId: "layer-z", surveyId: "demo", releaseId: "r1", product: "Product Z", label: "Product Z", nside: 16, pixels: [5], quality: "official_overview" as const, sourceUrl: "https://assets.local", retrievedAt: "2026-08-26T00:00:00.000Z", notes: "test" },
      { layerId: "layer-a", surveyId: "demo", releaseId: "r2", product: "Product A", label: "Product A", nside: 16, pixels: [5], quality: "official_overview" as const, sourceUrl: "https://assets.local", retrievedAt: "2026-08-26T00:00:00.000Z", notes: "test" },
    ],
  };
  const model = buildSurveyLayerModel([], manifest);
  assert.deepEqual(model.sourcesBySurveyPixel.get("demo")?.get(5)?.map((source) => [source.identity, source.label]), [["layer-a", "Product A"], ["layer-z", "Product Z"]]);
  assert.deepEqual(model.sourceIdentitiesBySurvey.get("demo"), ["layer-a", "layer-z"]);
  assert.deepEqual(visibleCoverageAtPixel(model, 5, ["demo"])?.artifacts.map((artifact) => artifact.layerId), ["layer-a", "layer-z"]);
});

test("source sector geometry emits one center fan sector per source", () => {
  const geometry = buildSphericalCellSourceSectorGeometry([{
    nside: 16,
    pixel: 5,
    radius: 1,
    colors: [new THREE.Color("#111111"), new THREE.Color("#eeeeee"), new THREE.Color("#777777")],
  }]);
  assert.equal(geometry.getAttribute("position").count, 18);
  const values = Array.from(geometry.getAttribute("color").array as ArrayLike<number>);
  const colors = new Set(Array.from({ length: 3 }, (_, index) => values.slice(index * 18, index * 18 + 3).map((value) => value.toFixed(3)).join(",")));
  assert.equal(colors.size, 3);
  assert.ok(values.slice(0, 18).every((value) => value < 0.2));
  assert.ok(values.slice(18, 36).every((value) => value > 0.8));
});

test("source sector geometry keeps single-source cells filled when another cell is split", () => {
  const geometry = buildSphericalCellSourceSectorGeometry([
    { nside: 16, pixel: 5, radius: 1, colors: [new THREE.Color("#111111")] },
    { nside: 16, pixel: 6, radius: 1, colors: [new THREE.Color("#111111"), new THREE.Color("#eeeeee")] },
  ]);
  assert.equal(geometry.getAttribute("position").count, 27);
  assert.ok(geometry.getAttribute("color").count > 0);
});
