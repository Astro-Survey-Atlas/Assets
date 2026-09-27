import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { registerPathHealpixMoc } from "../server/path-healpix-moc-import.js";
import { sha256 } from "../server/native-moc.js";
import { MocBuildService, MocBuildStore } from "../server/moc-build.js";
import { ProductStore, type ProductRecord } from "../server/products.js";
import { fitsMoc } from "./reviewed-fixture.js";

const PRODUCT_ID = "08f093bcebd4cd3ef4c3";
const LAYER_ID = "desi-dr1-redrock-bright-file-index";
const BATCH_ID = "desi-dr1-redrock-bright-user-oss-20260927-r1";
const SCOPE_ID = "desi-dr1-redrock-bright-user-oss-20260927";
const SCOPE_SHA = "5".repeat(64);
const ROSTER_SHA = "b".repeat(64);
const SOURCE_PREFIX = "oss://si000925lshd/27-Class/DESI/DR1/spectro/redux/iron/healpix/main/bright/";
const PIXELS = Array.from({ length: 904 }, (_, index) => index);

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function locked(label: string, ref: string, bytes: Buffer) {
  return { label, ref, sha256: sha256(bytes), sizeBytes: bytes.length };
}

function outputRecord(ref: string, bytes: Buffer) {
  return { ref, sha256: sha256(bytes), sizeBytes: bytes.length };
}

function contractOutput(uri: string, bytes: Buffer, deliveryClass: "runtime" | "evidence") {
  return { uri, sha256: sha256(bytes), sizeBytes: bytes.length, deliveryClass };
}

function sourceFiles(wrongFilename = false) {
  return PIXELS.map((ipix) => {
    const filenamePixel = wrongFilename && ipix === 128 ? 129 : ipix;
    return {
      uri: `${SOURCE_PREFIX}${Math.floor(ipix / 100)}/${ipix}/redrock-main-bright-${filenamePixel}.fits`,
      sizeBytes: 0,
      order: 6,
      ipix,
      group: Math.floor(ipix / 100),
    };
  });
}

function scanReceipt() {
  const partitions = Array.from({ length: 228 }, (_, index) => ({
    partitionId: `partition-${String(index).padStart(3, "0")}`,
    indexedLayerId: `partition-layer-${String(index).padStart(3, "0")}`,
    scanRunId: `scan-run-${String(index).padStart(3, "0")}`,
    sourceSnapshotSha256: sha256(Buffer.from(`snapshot-${index}`)),
    fileCount: index < 13 ? 65 : index === 13 ? 59 : 0,
    coverageCount: index < 13 ? 65 : index === 13 ? 59 : 0,
    errorCount: 0,
    updatedAt: "2026-09-27T00:00:00.000Z",
  }));
  return {
    schemaVersion: 1,
    kind: "desi-path-healpix-warehouse-scan-receipt",
    batchId: BATCH_ID,
    scopeId: SCOPE_ID,
    scopeSnapshotSha256: SCOPE_SHA,
    rosterSha256: ROSTER_SHA,
    evidenceLayerId: `assets-batch-${PRODUCT_ID}`,
    expectedPartitions: 228,
    committedPartitions: 228,
    scanRunCount: 228,
    sourceSnapshotCount: 228,
    fileCount: 904,
    coverageCount: 904,
    errorCount: 0,
    partitions,
  };
}

async function makeFixture(evidenceRoot: string, wrongFilename = false) {
  const inputRoot = "desi/dr1-redrock-bright-order6";
  const sourceBytes = json({
    schemaVersion: 1,
    kind: "desi-path-healpix-file-manifest",
    batchName: BATCH_ID,
    layerId: LAYER_ID,
    productId: PRODUCT_ID,
    surveyId: "desi",
    releaseId: "desi-dr1",
    sourcePrefix: SOURCE_PREFIX,
    order: 6,
    ordering: "NESTED",
    fileCount: 904,
    uniqueCellCount: 904,
    frozenScope: { expectedPartitions: 228, committedPartitions: 228, rosterSha256: ROSTER_SHA, scopeSnapshotSha256: SCOPE_SHA },
    files: sourceFiles(wrongFilename),
  });
  const cellsBytes = json({ order: 6, ordering: "NESTED", cells: PIXELS });
  const scanBytes = json(scanReceipt());
  const mocBytes = fitsMoc(PIXELS.map((pixel) => ({ order: 6, pixel })));
  const queryPixels = [...PIXELS];
  const previewPixels = [...new Set(PIXELS.map((pixel) => pixel >> 4))].sort((a, b) => a - b);
  const queryBytes = json({ schemaVersion: 1, order: 6, ordering: "NESTED", pixels: queryPixels });
  const previewBytes = json({ schemaVersion: 1, order: 4, ordering: "NESTED", pixels: previewPixels });
  const statisticsBytes = json({
    schemaVersion: 1,
    maxOrder: 6,
    cellCount: 904,
    mocSha256: sha256(mocBytes),
    queryPixelCount: queryPixels.length,
    previewPixelCount: previewPixels.length,
    availableOrders: [6],
  });
  const inputManifest = {
    schemaVersion: 1,
    kind: "desi-path-healpix-input-manifest",
    layerId: LAYER_ID,
    productId: PRODUCT_ID,
    surveyId: "desi",
    releaseId: "desi-dr1",
    modality: "redshift",
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    completeness: "incomplete",
    sourcePrefix: SOURCE_PREFIX,
    sourceManifest: { ref: "source-manifest.json", sha256: sha256(sourceBytes), sizeBytes: sourceBytes.length },
    pathCells: { ref: "path-healpix-cells-order6.json", sha256: sha256(cellsBytes), sizeBytes: cellsBytes.length, cellCount: 904 },
    recipeRef: "recipe.lock.json",
    scan: {
      batchId: BATCH_ID,
      scopeId: SCOPE_ID,
      phase: "SUCCEEDED",
      order: 6,
      groupSize: 100,
      expectedPartitions: 228,
      completedPartitions: 228,
      failedPartitions: 0,
      scanRunCount: 228,
      sourceSnapshotCount: 228,
      fileCount: 904,
      coverageCount: 904,
      errorCount: 0,
      rosterSha256: ROSTER_SHA,
      scopeSnapshotSha256: SCOPE_SHA,
      scanRunIds: scanReceipt().partitions.map((partition) => partition.scanRunId),
    },
  };
  const inputBytes = json(inputManifest);
  const manifestBytes = json({
    schemaVersion: 1,
    kind: "path-healpix-moc-provenance",
    layerId: LAYER_ID,
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    maxOrder: 6,
    queryOrder: 6,
    previewOrder: 4,
    precision: "exact",
    inputs: { inputManifestSha256: sha256(inputBytes), sourceManifestSha256: sha256(sourceBytes), pathCellsSha256: sha256(cellsBytes) },
    scan: {
      batchId: BATCH_ID,
      scopeId: SCOPE_ID,
      rosterSha256: ROSTER_SHA,
      scopeSnapshotSha256: SCOPE_SHA,
    },
    outputs: {
      moc: outputRecord("moc.fits", mocBytes),
      query: outputRecord("query-order6.json", queryBytes),
      preview: outputRecord("preview-order4.json", previewBytes),
      statistics: outputRecord("statistics.json", statisticsBytes),
    },
  });
  const recipe = {
    schemaVersion: 1,
    kind: "coverage-recipe-lock",
    layerId: LAYER_ID,
    surveyId: "desi",
    releaseId: "desi-dr1",
    product: "DR1 bright-program redrock files",
    modality: "redshift",
    mode: "path-healpix",
    maxOrder: 6,
    availableOrders: [6],
    queryOrder: 6,
    overviewOrder: 4,
    previewOrder: 4,
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    sourceOrder: 6,
    recipe: {
      groupSize: 100,
      scanBatchId: BATCH_ID,
      scopeId: SCOPE_ID,
      rosterSha256: ROSTER_SHA,
      scopeSnapshotSha256: SCOPE_SHA,
      expectedPartitions: 228,
      completedPartitions: 228,
      failedPartitions: 0,
      scanRunCount: 228,
      sourceSnapshotCount: 228,
      fileCount: 904,
      coverageCount: 904,
      precision: "exact",
      precisionJustification: "Exact URI-to-path partition identity.",
    },
    snapshot: {
      sourceManifestSha256: sha256(sourceBytes),
      sourceManifestSizeBytes: sourceBytes.length,
      pathCellsSha256: sha256(cellsBytes),
      pathCellsSizeBytes: cellsBytes.length,
    },
    outputs: {
      moc: { ...outputRecord("moc.fits", mocBytes), precision: "exact" },
      query: { ...outputRecord("query-order6.json", queryBytes), precision: "exact" },
      preview: { ...outputRecord("preview-order4.json", previewBytes), precision: "estimated" },
      statistics: { ...outputRecord("statistics.json", statisticsBytes), precision: "exact" },
      manifest: { ...outputRecord("build-manifest.json", manifestBytes), precision: "exact" },
    },
  };
  const recipeBytes = json(recipe);
  const provenanceBytes = json({
    schemaVersion: 1,
    kind: "path-healpix-provenance",
    layerId: LAYER_ID,
    buildManifest: { ref: "build-manifest.json", sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length },
    recipe: { ref: "recipe.lock.json", sha256: sha256(recipeBytes), sizeBytes: recipeBytes.length },
    scanReceipt: { ref: "warehouse-scan-receipt.json", sha256: sha256(scanBytes), sizeBytes: scanBytes.length },
    inputManifest: { ref: `${inputRoot}/input-manifest.json`, sha256: sha256(inputBytes), sizeBytes: inputBytes.length },
  });
  const coverageBytes = json({
    schemaVersion: 1,
    layerId: LAYER_ID,
    surveyId: "desi",
    releaseId: "desi-dr1",
    productId: PRODUCT_ID,
    modality: "redshift",
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    availableOrders: [6],
    overviewOrder: 4,
    maxOrder: 6,
    scanBatchId: BATCH_ID,
    scanRunIds: inputManifest.scan.scanRunIds,
    sourceSnapshot: { uri: `warehouse-scan-scope:${SCOPE_ID}`, sha256: SCOPE_SHA },
    steps: [{ id: "scan", kind: "warehouse-scan", title: "Committed partitions", implementationRef: "data-warehouse PathHealpixHandler", order: 0 }],
    outputs: {
      moc: contractOutput("moc.fits", mocBytes, "runtime"),
      query: contractOutput("query-order6.json", queryBytes, "runtime"),
      preview: contractOutput("preview-order4.json", previewBytes, "runtime"),
      statistics: contractOutput("statistics.json", statisticsBytes, "runtime"),
      manifest: contractOutput("build-manifest.json", manifestBytes, "evidence"),
      provenance: contractOutput("provenance.json", provenanceBytes, "evidence"),
    },
  });
  const fileBytes = new Map([
    [`${inputRoot}/source-manifest.json`, sourceBytes],
    [`${inputRoot}/path-healpix-cells-order6.json`, cellsBytes],
    [`${inputRoot}/warehouse-scan-receipt.json`, scanBytes],
    [`${inputRoot}/input-manifest.json`, inputBytes],
    [`${inputRoot}/recipe.lock.json`, recipeBytes],
    [`${inputRoot}/coverage-evidence.json`, coverageBytes],
    [`${inputRoot}/provenance.json`, provenanceBytes],
    [`${inputRoot}/moc.fits`, mocBytes],
    [`${inputRoot}/query-order6.json`, queryBytes],
    [`${inputRoot}/preview-order4.json`, previewBytes],
    [`${inputRoot}/statistics.json`, statisticsBytes],
    [`${inputRoot}/build-manifest.json`, manifestBytes],
  ]);
  for (const [ref, bytes] of fileBytes) {
    const absolute = path.join(evidenceRoot, ref);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }

  const flowNodes = ["input", "filter", "validate", "normalize", "outputs", "evidence"].map((id, order) => ({
    id,
    kind: id,
    title: id,
    bodyMarkdown: "Verified DESI order-6 path-HEALPix file mapping.",
    order,
    implementationRef: `assets.coverage.${id}`,
    evidenceRefs: [],
  }));
  const draft = {
    productId: PRODUCT_ID,
    surveyId: "desi",
    releaseId: "desi-dr1",
    name: "DR1 bright-program redrock files",
    modality: "redshift",
    layerId: LAYER_ID,
    mode: "path-healpix" as const,
    scanDefaults: { includePattern: "redrock-main-bright-*.fits*", pathHealpixOrder: 6, pathHealpixGroupSize: 100 },
    coverageEvidence: {
      evidenceKind: "published-moc" as const,
      precision: "exact" as const,
      completeness: "incomplete" as const,
      scienceFileScan: "partial" as const,
      sourceSnapshotSha256: SCOPE_SHA,
      summary: "Exact redrock URI-to-order-6 path association; partial user OSS copy.",
    },
    presentation: {
      summaryMarkdown: "",
      methodologyMarkdown: "",
      limitationsMarkdown: "",
      flow: { nodes: flowNodes, edges: flowNodes.slice(1).map((node, index) => ({ from: flowNodes[index]!.id, to: node.id })) },
    },
  };
  const product: ProductRecord = {
    productId: PRODUCT_ID,
    draft,
    published: null,
    revision: 1,
    publishedRevision: null,
    updatedAt: new Date(0).toISOString(),
    publishedAt: null,
    contentSha256: sha256(json(draft)),
  };
  const contentRoot = path.join(evidenceRoot, "content");
  const catalogRoot = path.join(evidenceRoot, "catalog");
  await mkdir(contentRoot, { recursive: true });
  await mkdir(path.join(catalogRoot, "src/surveys"), { recursive: true });
  await mkdir(path.join(catalogRoot, "src/layers"), { recursive: true });
  await writeFile(path.join(contentRoot, "product-content-v1.json"), json({ schemaVersion: 1, products: [product], history: [] }));
  await writeFile(path.join(catalogRoot, "src/surveys/survey-catalog.json"), json({ schemaVersion: 1, surveys: [] }));
  await writeFile(path.join(catalogRoot, "src/layers/layer-registry.json"), json({ schemaVersion: 1, layers: [] }));
  const products = new ProductStore(undefined, contentRoot);
  await products.initialize(catalogRoot);
  const builds = new MocBuildStore(contentRoot, undefined, evidenceRoot);
  const buildService = new MocBuildService({
    store: builds,
    evidenceRoot,
    runner: { validate: async () => ({ valid: true }), build: async () => ({}) },
  });
  const request = {
    buildName: "desi-dr1-redrock-bright-order6",
    layerId: LAYER_ID,
    productId: PRODUCT_ID,
    source: {
      url: "https://data.desi.lbl.gov/doc/releases/dr1/",
      snapshotRef: `${inputRoot}/input-manifest.json`,
      snapshotSha256: sha256(inputBytes),
      sizeBytes: inputBytes.length,
    },
    inputEvidence: [
      locked("source manifest", `${inputRoot}/source-manifest.json`, sourceBytes),
      locked("order-6 cells", `${inputRoot}/path-healpix-cells-order6.json`, cellsBytes),
      locked("recipe lock", `${inputRoot}/recipe.lock.json`, recipeBytes),
      locked("scan receipt", `${inputRoot}/warehouse-scan-receipt.json`, scanBytes),
      locked("coverage evidence", `${inputRoot}/coverage-evidence.json`, coverageBytes),
      locked("provenance", `${inputRoot}/provenance.json`, provenanceBytes),
    ],
    outputs: {
      moc: locked("MOC", `${inputRoot}/moc.fits`, mocBytes),
      query: locked("query", `${inputRoot}/query-order6.json`, queryBytes),
      preview: locked("preview", `${inputRoot}/preview-order4.json`, previewBytes),
      statistics: locked("statistics", `${inputRoot}/statistics.json`, statisticsBytes),
      manifest: locked("manifest", `${inputRoot}/build-manifest.json`, manifestBytes),
    },
  };
  return { evidenceRoot, products, builds, buildService, request, wrongFilename };
}

test("path-HEALPix evidence import stages an exact order-6 file index", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "assets-path-healpix-import-"));
  try {
    const fixture = await makeFixture(base);
    const imported = await registerPathHealpixMoc(fixture, fixture.request);
    assert.equal(imported.request.phase, "STAGED");
    assert.equal(imported.request.provider, "evidence");
    assert.equal(imported.request.outputs?.maxOrder, 6);
    assert.deepEqual(imported.request.outputs?.availableOrders, [6]);
    assert.equal(imported.product.draft.coverageEvidence?.sourceSnapshotSha256, SCOPE_SHA);
    assert.equal(imported.product.published, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("path-HEALPix evidence import rejects a filename that points at another cell", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "assets-path-healpix-reject-"));
  try {
    const fixture = await makeFixture(base, true);
    await assert.rejects(registerPathHealpixMoc(fixture, fixture.request), /file name or group directory does not match/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
