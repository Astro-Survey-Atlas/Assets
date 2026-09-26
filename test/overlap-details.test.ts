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
      { layerId: "euclid-layer", surveyId: "euclid", releaseId: "euclid-q1", productId: "euclid-product", state: "ACTIVE", scanRunCount: 3, sourceSnapshotCount: 3, scanScope: { layerId: "assets-batch-euclid", publishedLayerId: "euclid-layer", scopeId: "q1", scopeSnapshotSha256: "b".repeat(64), expectedPartitions: 3, committedPartitions: 3, completeness: "complete" }, availableOrders: [4, 8], fileCount: 2, coverageCount: 4, errorCount: 0 },
    ]]),
  });
  assert.equal(details.component.id, "C01");
  assert.equal(details.publicSources[0]?.coverageClaim?.kind, "moc");
  assert.equal(details.publicSources[0]?.sourceUrl, "https://www.euclid.example/q1");
  assert.equal(details.publicSources[0]?.surveyColor, "#a7d9ff");
  assert.equal(details.warehouseEvidence[0]?.state, "ACTIVE");
  assert.equal(details.warehouseEvidence[0]?.coverageCells, 1);
  assert.equal(details.warehouseEvidence[0]?.scanRunCount, 3);
  assert.equal(details.warehouseEvidence[0]?.sourceSnapshotCount, 3);
  assert.equal(details.warehouseEvidence[0]?.scanScope?.completeness, "complete");
  assert.equal(details.warehouseEvidence[0]?.connector.status, "unavailable");
  assert.deepEqual(details.reverseLookup.layerIds, ["euclid-layer"]);
  assert.equal(details.reverseLookup.precision, "exact");
});

test("overlap details expose only approved product provenance for dynamic MOC layers", () => {
  const surveyIndex = {
    schemaVersion: 1,
    generatedAt: "2026-08-26",
    sharedAssets: [],
    surveys: [{
      id: "euclid", name: "Euclid", mission: "ESA Euclid", color: "#a7d9ff", description: "Euclid survey", modalities: ["imaging"],
      imageUrl: "/surveys/euclid.png", statistics: { publicProducts: 1, acquired: 1, overviewOnly: 0, awaitingGeometry: 0, notApplicable: 0, footprintCells: 1 },
      releases: [{ id: "euclid-q1", label: "Q1", kind: "quick_release", modalities: ["imaging"], products: [{ name: "Euclid VIS", modality: "imaging", description: "MOC-only index row", status: "acquired", sourceUrl: "/api/v1/coverage/layers/euclid-layer/moc.fits" }] }],
    }],
  } as any;
  const details = buildOverlapDetails({
    result,
    component: result.components[0]!,
    layers: [layer()],
    surveyIndex,
    publishedSourcesByLayer: new Map([[
      "euclid-layer",
      {
        sourceUrl: "https://mast.stsci.edu/portal/?obsid=26442812",
        geometrySourceUrl: "https://mast.stsci.edu/api/v0/invoke",
        publicDescription: "Estimated footprint; science files were not scanned.",
        dataOrigin: "observed",
        sourceTier: "official_geometry",
        sourceLabel: "MAST observation 26442812",
        geometrySourceLabel: "MAST CAOM observation footprint",
      },
    ]]),
  });

  assert.equal(details.publicSources[0]?.sourceUrl, "https://mast.stsci.edu/portal/?obsid=26442812");
  assert.equal(details.publicSources[0]?.geometrySourceUrl, "https://mast.stsci.edu/api/v0/invoke");
  assert.equal(details.publicSources[0]?.sourceLabel, "MAST observation 26442812");
  assert.equal(details.publicSources[0]?.description, "Estimated footprint; science files were not scanned.");
});

test("overlap details preserve structured observation evidence and use its declared precision", () => {
  const evidence = {
    evidenceKind: "observation-footprint" as const,
    sourceIdentity: "MAST observation 26442812",
    instrument: "ACS/WFC",
    filters: "F606W, F814W",
    sourceSnapshotSha256: "b".repeat(64),
    precision: "estimated" as const,
    completeness: "incomplete" as const,
    scienceFileScan: "not-scanned" as const,
    summary: "Estimated observation footprint; science files were not scanned.",
  };
  const hstLayer: CoverageCellLayer = {
    ...layer(),
    layerId: "hst-acs-layer",
    productId: "hst-acs-product",
    surveyId: "hst",
    releaseId: "mast-observations",
    product: "HST ACS observations",
  };
  const hstResult: OverlapResult = { ...result, surveyIds: ["hst", "sdss"] };
  const surveyIndex = {
    schemaVersion: 1,
    generatedAt: "2026-09-25",
    sharedAssets: [],
    surveys: [{
      id: "hst", name: "Hubble Space Telescope", mission: "HST", color: "#a7d9ff", description: "HST", modalities: ["imaging"],
      imageUrl: "/surveys/hst.png", statistics: { publicProducts: 1, acquired: 1, overviewOnly: 0, awaitingGeometry: 0, notApplicable: 0, footprintCells: 1 },
      releases: [{ id: "mast-observations", label: "MAST observations", kind: "release", modalities: ["imaging"], products: [{ name: "HST ACS observations", modality: "imaging", description: "MAST observation footprint", status: "acquired" }] }],
    }],
  } as any;
  const details = buildOverlapDetails({
    result: hstResult,
    component: hstResult.components[0]!,
    layers: [hstLayer],
    surveyIndex,
    publishedSourcesByLayer: new Map([[hstLayer.layerId, { coverageEvidence: evidence }]]),
  });

  assert.deepEqual(details.publicSources[0]?.coverageEvidence, evidence);
  assert.equal(details.reverseLookup.precision, "estimated");
});
