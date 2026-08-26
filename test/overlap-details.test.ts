import assert from "node:assert/strict";
import test from "node:test";

import type { CoverageCellLayer } from "../server/coverage.js";
import { buildOverlapDetails, publicExternalUrl } from "../server/overlap-details.js";
import type { OverlapResult } from "../server/overlap.js";

function layer(): CoverageCellLayer {
  return {
    layerId: "euclid-layer",
    productId: "euclid-product",
    surveyId: "euclid",
    releaseId: "euclid-q1",
    product: "Euclid VIS",
    modality: "imaging",
    color: "#a7d9ff",
    availableOrders: [4, 8],
    overviewOrder: 4,
    maxOrder: 8,
    cellCount: 1,
    areaDeg2: 1,
    tileScheme: "ipix-range-4096",
    cells: new Map([[4, [7]], [8, [123]]]),
    recipe: {
      recipeVersion: 1,
      mode: "fits-wcs",
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      maxOrder: 8,
      queryOrder: 8,
      previewOrder: 4,
      sourceUrl: "https://public.example/catalog",
      steps: [{ id: "header", kind: "fits-wcs", title: "FITS header", bodyMarkdown: "", order: 0, implementationRef: "assets.coverage.header" }],
    },
  };
}

const result: OverlapResult = {
  schemaVersion: 1,
  surveyIds: ["euclid", "sdss"],
  commonOrder: 4,
  limitingLayers: [],
  pixels: [7],
  components: [{ id: "C01", index: 0, order: 4, cells: [7], bounds: { areaDeg2: 1, raMin: 1, raMax: 2, raWraps: false, decMin: 3, decMax: 4 } }],
};

test("public external URL projection rejects internal and credential-bearing URLs", () => {
  assert.equal(publicExternalUrl("https://data.example.org/moc.fits"), "https://data.example.org/moc.fits");
  assert.equal(publicExternalUrl("s3://bucket/file.fits"), undefined);
  assert.equal(publicExternalUrl("http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200"), undefined);
  assert.equal(publicExternalUrl("https://user:secret@data.example.org/file"), undefined);
});

test("overlap details separate public claims from current Warehouse evidence", () => {
  const surveyIndex = {
    schemaVersion: 1,
    generatedAt: "2026-08-26",
    sharedAssets: [],
    surveys: [{
      id: "euclid", name: "Euclid", mission: "ESA Euclid", color: "#a7d9ff", description: "Euclid survey", modalities: ["imaging"],
      imageUrl: "/surveys/euclid.png", statistics: { publicProducts: 1, acquired: 1, overviewOnly: 0, awaitingGeometry: 0, notApplicable: 0, footprintCells: 1 },
      releases: [{ id: "euclid-q1", label: "Q1", kind: "quick_release", modalities: ["imaging"], products: [{ name: "Euclid VIS", modality: "imaging", description: "VIS imaging", status: "acquired", sourceUrl: "https://www.euclid.example/q1", geometrySourceUrl: "https://www.euclid.example/q1.moc" }] }],
    }],
  } as any;
  const details = buildOverlapDetails({
    result,
    component: result.components[0]!,
    layers: [layer()],
    surveyIndex,
    warehouseSnapshots: new Map([[
      "euclid-layer",
      { layerId: "euclid-layer", surveyId: "euclid", releaseId: "euclid-q1", productId: "euclid-product", state: "ACTIVE", scanRunId: "run-1", sourceSnapshotSha256: "a".repeat(64), availableOrders: [4, 8], fileCount: 2, coverageCount: 4, errorCount: 0 },
    ]]),
  });
  assert.equal(details.component.id, "C01");
  assert.equal(details.publicSources[0]?.coverageClaim?.kind, "moc");
  assert.equal(details.publicSources[0]?.sourceUrl, "https://www.euclid.example/q1");
  assert.equal(details.warehouseEvidence[0]?.state, "ACTIVE");
  assert.equal(details.warehouseEvidence[0]?.coverageCells, 1);
  assert.equal(details.warehouseEvidence[0]?.connector.status, "unavailable");
  assert.deepEqual(details.reverseLookup.layerIds, ["euclid-layer"]);
  assert.equal(details.reverseLookup.precision, "exact");
});
