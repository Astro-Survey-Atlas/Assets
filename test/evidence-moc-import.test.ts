import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerEvidenceMoc } from "../server/evidence-moc-import.js";
import { sha256 } from "../server/native-moc.js";
import { MocBuildService, MocBuildStore } from "../server/moc-build.js";
import { ProductStore } from "../server/products.js";
import { fitsMoc } from "./reviewed-fixture.js";

const OBSERVATION_ID = "90001";
const SOURCE_REF = "hst/mast-cosmos/test/mast-caom-response.json";
const PROPOSAL_ID = "12440";
const TARGET_NAME = "COSMOS-X";
const INSTRUMENT = "ACS/WFC";
const FILTERS = "F814W";
const T_MIN_MJD = 55907.8;
const T_MAX_MJD = 55907.9;
const REGION_TEXT = [
  "# Region file format: DS9 version 4.1",
  "icrs",
  `# MAST CAOM observation ${OBSERVATION_ID}`,
  "polygon(10,1,11,1,11,2,10,2,10,1)",
  "",
].join("\n");

function mastSnapshot(): Buffer {
  const dataIndices = ["obsid", "obs_collection", "dataproduct_type", "dataRights", "proposal_id", "instrument_name", "s_region", "filters", "t_min", "target_name", "t_max"];
  return Buffer.from(JSON.stringify({
    Tables: [{
      Columns: dataIndices.map((dataIndex) => ({ dataIndex })),
      Rows: [[OBSERVATION_ID, "HST", "image", "PUBLIC", PROPOSAL_ID, INSTRUMENT, "POLYGON 10 1 11 1 11 2 10 2 10 1", FILTERS, T_MIN_MJD, TARGET_NAME, T_MAX_MJD]],
    }],
  }));
}

async function createImportFixture(evidenceRoot: string, options: { regionText?: string; nativeOrder?: number; requestedMaxOrder?: number } = {}) {
  const inputRoot = "hst/mast-cosmos/test/input";
  const outputRoot = "hst/mast-cosmos/test/output";
  const sourceBytes = mastSnapshot();
  const sourceSha = sha256(sourceBytes);
  const regionBytes = Buffer.from(options.regionText ?? REGION_TEXT);
  const regionSha = sha256(regionBytes);
  const recipeRef = `obs-${OBSERVATION_ID}.lock.json`;
  const regionRef = `obs-${OBSERVATION_ID}.reg`;
  const nativeOrder = options.nativeOrder ?? 8;
  const requestedMaxOrder = options.requestedMaxOrder ?? nativeOrder;
  const nativePixel = nativeOrder >= 8 ? 100 * 4 ** (nativeOrder - 8) : 0;
  const mocBytes = fitsMoc([{ order: nativeOrder, pixel: nativePixel }]);
  const queryBytes = Buffer.from(JSON.stringify({ order: 8, ordering: "NESTED", pixels: [100] }));
  const previewBytes = Buffer.from(JSON.stringify({ order: 4, ordering: "NESTED", pixels: [0] }));
  const mocRef = `${outputRoot}/hst-mast-cosmos-obs-${OBSERVATION_ID}.moc.fits`;
  const queryRef = `${outputRoot}/query-order8.json`;
  const previewRef = `${outputRoot}/preview-order4.json`;
  const statisticsRef = `${outputRoot}/statistics.json`;
  const statisticsBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    maxOrder: nativeOrder,
    mocSha256: sha256(mocBytes),
    queryPixelCount: 1,
    previewPixelCount: 1,
  }));
  const recipeBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    layerId: `hst-mast-cosmos-obs-${OBSERVATION_ID}`,
    surveyId: "hst",
    releaseId: "hst-mast-snapshot-2026",
    sourceUrl: "https://mast.stsci.edu/api/v0/invoke",
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    maxOrder: requestedMaxOrder,
    queryOrder: 8,
    previewOrder: 4,
    recipe: {
      precision: "estimated",
      observationId: OBSERVATION_ID,
      proposalId: PROPOSAL_ID,
      targetName: TARGET_NAME,
      instrument: INSTRUMENT,
      filters: FILTERS,
      tMinMjd: T_MIN_MJD,
      tMaxMjd: T_MAX_MJD,
      sourceSnapshotRef: SOURCE_REF,
      sourceSnapshotSha256: sourceSha,
      sourceSnapshotSizeBytes: sourceBytes.length,
    },
    snapshot: {
      sourceSnapshotRef: SOURCE_REF,
      sourceSnapshotSha256: sourceSha,
      sourceSnapshotSizeBytes: sourceBytes.length,
      sha256: regionSha,
      sizeBytes: regionBytes.length,
    },
  }));
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: "mast-hst-observation-region-inputs",
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    maxOrder: requestedMaxOrder,
    sourceSnapshot: { ref: SOURCE_REF, sha256: sourceSha, sizeBytes: sourceBytes.length },
    selectedObservationIds: [OBSERVATION_ID],
    observations: [{
      observationId: OBSERVATION_ID,
      proposalId: PROPOSAL_ID,
      targetName: TARGET_NAME,
      instrument: INSTRUMENT,
      filters: FILTERS,
      tMinMjd: T_MIN_MJD,
      tMaxMjd: T_MAX_MJD,
      polygonCount: 1,
      sourceSnapshot: { ref: SOURCE_REF, sha256: sourceSha, sizeBytes: sourceBytes.length },
      regionInput: { ref: regionRef, sha256: regionSha, sizeBytes: regionBytes.length },
      recipe: recipeRef,
    }],
  }));
  const outputEntry = (ref: string, bytes: Buffer) => ({ path: path.posix.basename(ref), sha256: sha256(bytes), sizeBytes: bytes.length });
  const provenanceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    layerId: `hst-mast-cosmos-obs-${OBSERVATION_ID}`,
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    sourceUrl: "https://mast.stsci.edu/api/v0/invoke",
    sourceTier: "official_geometry",
    dataOrigin: "observed",
    coverageRole: "image_extent",
    snapshot: {
      sha256: regionSha,
      sizeBytes: regionBytes.length,
      sourceSnapshotRef: SOURCE_REF,
      sourceSnapshotSha256: sourceSha,
      sourceSnapshotSizeBytes: sourceBytes.length,
    },
    input: { path: regionRef, sha256: regionSha },
    recipe: {
      observationId: OBSERVATION_ID,
      proposalId: PROPOSAL_ID,
      targetName: TARGET_NAME,
      instrument: INSTRUMENT,
      filters: FILTERS,
      tMinMjd: T_MIN_MJD,
      tMaxMjd: T_MAX_MJD,
      precision: "estimated",
      sourceSnapshotSha256: sourceSha,
      sourceSnapshotRef: SOURCE_REF,
      sourceSnapshotSizeBytes: sourceBytes.length,
    },
    outputs: {
      moc: outputEntry(mocRef, mocBytes),
      query: outputEntry(queryRef, queryBytes),
      preview: outputEntry(previewRef, previewBytes),
      statistics: outputEntry(statisticsRef, statisticsBytes),
    },
  }));

  const files = new Map<string, Buffer>([
    [SOURCE_REF, sourceBytes],
    [`${inputRoot}/input-manifest.json`, manifestBytes],
    [`${inputRoot}/${regionRef}`, regionBytes],
    [`${inputRoot}/${recipeRef}`, recipeBytes],
    [`${inputRoot}/provenance.json`, provenanceBytes],
    [mocRef, mocBytes],
    [queryRef, queryBytes],
    [previewRef, previewBytes],
    [statisticsRef, statisticsBytes],
  ]);
  for (const [ref, bytes] of files) {
    const absolute = path.join(evidenceRoot, ref);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  const locked = (label: string, ref: string, bytes: Buffer) => ({ label, ref, sha256: sha256(bytes), sizeBytes: bytes.length });
  const product = {
    surveyId: "hst",
    surveyName: "Hubble Space Telescope",
    mission: "HST",
    surveyDescription: "Selected public HST observation footprints.",
    surveyColor: "#268cab",
    surveyModalities: ["imaging", "infrared"],
    releaseId: "hst-mast-snapshot-2026",
    releaseLabel: "Selected COSMOS observations",
    releaseKind: "observation-snapshot",
    releasedYear: 2026,
    productName: `COSMOS HST observation ${OBSERVATION_ID} (${INSTRUMENT} ${FILTERS})`,
    productDescription: "One selected MAST observation footprint; not a complete HST archive inventory.",
    productStatus: "acquired",
    modality: "imaging",
    sourceUrl: `https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html?searchQuery=obsid%3D${OBSERVATION_ID}`,
    geometrySourceUrl: "https://mast.stsci.edu/api/v0/invoke",
    geometrySourceLabel: "MAST CAOM observation footprint",
    sourceLabel: `MAST observation ${OBSERVATION_ID}`,
    dataOrigin: "observed",
    sourceTier: "official_geometry",
    coverageRole: "image_extent",
    mode: "regions",
    coverageEvidence: {
      evidenceKind: "observation-footprint",
      precision: "estimated",
      completeness: "incomplete",
      scienceFileScan: "not-scanned",
      sourceIdentity: `MAST obsid ${OBSERVATION_ID} · proposal ${PROPOSAL_ID} · target ${TARGET_NAME}`,
      instrument: INSTRUMENT,
      filters: FILTERS,
      sourceSnapshotSha256: sourceSha,
      sourceLabel: "MAST CAOM observation metadata",
      summary: "Official MAST CAOM s_region rasterized to estimated ICRS/NESTED coverage; science files were not scanned.",
    },
  };
  return {
    request: {
      buildName: `hst-mast-${OBSERVATION_ID}`,
      layerId: `hst-mast-cosmos-obs-${OBSERVATION_ID}`,
      candidateId: OBSERVATION_ID,
      candidateTitle: product.productName,
      product,
      source: { url: "https://mast.stsci.edu/api/v0/invoke", snapshotRef: SOURCE_REF, snapshotSha256: sourceSha, sizeBytes: sourceBytes.length },
      inputEvidence: [
        locked("Observation input manifest", `${inputRoot}/input-manifest.json`, manifestBytes),
        locked("Coverage provenance", `${inputRoot}/provenance.json`, provenanceBytes),
        locked("DS9 region", `${inputRoot}/${regionRef}`, regionBytes),
        locked("Observation recipe lock", `${inputRoot}/${recipeRef}`, recipeBytes),
      ],
      outputs: {
        moc: locked("Native MOC", mocRef, mocBytes),
        query: locked("Query projection", queryRef, queryBytes),
        preview: locked("Preview projection", previewRef, previewBytes),
        statistics: locked("MOC statistics", statisticsRef, statisticsBytes),
      },
    },
    productName: product.productName,
  };
}

async function initializeCatalogRoot(root: string): Promise<void> {
  const surveys = path.join(root, "src/surveys");
  const layers = path.join(root, "src/layers");
  await mkdir(surveys, { recursive: true });
  await mkdir(layers, { recursive: true });
  await writeFile(path.join(surveys, "survey-catalog.json"), JSON.stringify({ schemaVersion: 1, surveys: [] }));
  await writeFile(path.join(layers, "layer-registry.json"), JSON.stringify({ schemaVersion: 1, layers: [] }));
}

async function runImport(evidenceRoot: string, contentRoot: string, catalogRoot: string, request: unknown) {
  const products = new ProductStore(undefined, contentRoot);
  await products.initialize(catalogRoot);
  const builds = new MocBuildStore(contentRoot, undefined, evidenceRoot);
  const buildService = new MocBuildService({
    store: builds,
    evidenceRoot,
    runner: { validate: async () => ({ valid: true }), build: async () => ({}) },
  });
  return registerEvidenceMoc({ evidenceRoot, products, builds, buildService }, request);
}

test("HST evidence import stages a provenance-checked estimated footprint", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "assets-hst-evidence-import-"));
  const evidenceRoot = path.join(base, "evidence");
  const contentRoot = path.join(base, "content");
  const catalogRoot = path.join(base, "catalog");
  await mkdir(evidenceRoot, { recursive: true });
  await initializeCatalogRoot(catalogRoot);
  try {
    const fixture = await createImportFixture(evidenceRoot);
    const imported = await runImport(evidenceRoot, contentRoot, catalogRoot, fixture.request);
    assert.equal(imported.request.phase, "STAGED");
    assert.equal(imported.request.provider, "evidence");
    assert.equal(imported.request.candidateId, OBSERVATION_ID);
    assert.equal(imported.product.published, null);
    assert.equal(imported.product.draft.coverageEvidence?.precision, "estimated");
    assert.equal(imported.product.draft.coverageEvidence?.scienceFileScan, "not-scanned");
    assert.deepEqual(imported.request.outputs?.availableOrders, [8]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("HST evidence import rejects a changed DS9 geometry before product registration", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "assets-hst-evidence-reject-"));
  const evidenceRoot = path.join(base, "evidence");
  const contentRoot = path.join(base, "content");
  const catalogRoot = path.join(base, "catalog");
  await mkdir(evidenceRoot, { recursive: true });
  await initializeCatalogRoot(catalogRoot);
  try {
    const fixture = await createImportFixture(evidenceRoot, { regionText: `${REGION_TEXT}# tampered\n` });
    await assert.rejects(runImport(evidenceRoot, contentRoot, catalogRoot, fixture.request), /Manifest, DS9 region or observation metadata/);
    const products = new ProductStore(undefined, contentRoot);
    await products.initialize(catalogRoot);
    assert.equal(products.list().length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("HST evidence import accepts and records native order below the requested maximum", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "assets-hst-evidence-native-order-"));
  const evidenceRoot = path.join(base, "evidence");
  const contentRoot = path.join(base, "content");
  const catalogRoot = path.join(base, "catalog");
  await mkdir(evidenceRoot, { recursive: true });
  await initializeCatalogRoot(catalogRoot);
  try {
    const fixture = await createImportFixture(evidenceRoot, { nativeOrder: 9, requestedMaxOrder: 10 });
    const imported = await runImport(evidenceRoot, contentRoot, catalogRoot, fixture.request);
    assert.equal(imported.request.phase, "STAGED");
    assert.equal(imported.request.outputs?.maxOrder, 9);
    assert.deepEqual(imported.request.outputs?.availableOrders, [9]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("HST evidence import rejects native precision below the public minimum", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "assets-hst-evidence-low-order-"));
  const evidenceRoot = path.join(base, "evidence");
  const contentRoot = path.join(base, "content");
  const catalogRoot = path.join(base, "catalog");
  await mkdir(evidenceRoot, { recursive: true });
  await initializeCatalogRoot(catalogRoot);
  try {
    const fixture = await createImportFixture(evidenceRoot, { nativeOrder: 3, requestedMaxOrder: 10 });
    await assert.rejects(
      runImport(evidenceRoot, contentRoot, catalogRoot, fixture.request),
      /原生覆盖精度 order 3 低于公开发布最低要求 order 4/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
