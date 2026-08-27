import test from "node:test";
import assert from "node:assert/strict";

import { buildPublicProductEvidence } from "../server/public-product-evidence.js";
import type { CoverageCellLayer } from "../server/coverage.js";
import type { ProductContent } from "../server/products.js";
import type { PublicAssetRecord } from "../server/types.js";

const product = (overrides: Partial<ProductContent> = {}): ProductContent => ({
  productId: "product-1",
  surveyId: "survey-1",
  releaseId: "release-1",
  name: "Example image extent",
  modality: "imaging",
  sourceLabel: "Official archive",
  sourceUrl: "https://archive.example.test/release",
  geometrySourceUrl: "https://archive.example.test/regions.zip",
  presentation: {
    summaryMarkdown: "",
    methodologyMarkdown: "",
    limitationsMarkdown: "",
    flow: { nodes: [{ id: "input", kind: "input", title: "Input", bodyMarkdown: "", order: 0, implementationRef: "assets.coverage.input", evidenceRefs: [] }], edges: [] },
  },
  ...overrides,
});

const asset = (overrides: Partial<PublicAssetRecord>): { id: string; record: PublicAssetRecord } => ({
  id: "asset-1",
  record: {
    id: "asset-1",
    kind: "moc",
    label: "Example MOC",
    description: "",
    path: "layers/example/example.moc.fits",
    downloadName: "example.moc.fits",
    mediaType: "application/fits",
    sizeBytes: 128,
    sha256: "a".repeat(64),
    surveyId: "survey-1",
    releaseId: "release-1",
    product: "Example image extent",
    ...overrides,
  },
});

const layer = (overrides: Partial<CoverageCellLayer> = {}): CoverageCellLayer => ({
  layerId: "layer-1",
  productId: "product-1",
  surveyId: "survey-1",
  releaseId: "release-1",
  product: "Example image extent",
  coverageRole: "image_extent",
  color: "#42d5c4",
  availableOrders: [4, 8],
  overviewOrder: 4,
  maxOrder: 8,
  cellCount: 1,
  areaDeg2: 10,
  tileScheme: "ipix-range-4096",
  cells: new Map([[4, [1]], [8, [16]]]),
  recipe: {
    recipeVersion: 1,
    mode: "regions",
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    maxOrder: 8,
    queryOrder: 8,
    previewOrder: 4,
    sourceSnapshotSha256: "b".repeat(64),
    sourceSnapshotSizeBytes: 42,
    steps: [
      { id: "input", kind: "source-inventory", title: "Input", bodyMarkdown: "", order: 0, implementationRef: "assets.coverage.input" },
      { id: "outputs", kind: "outputs", title: "Outputs", bodyMarkdown: "", order: 1, implementationRef: "assets.coverage.outputs" },
    ],
  },
  sourceUnitIndex: { status: "exact", notes: "" },
  ...overrides,
});

test("evidence projection keeps explicit links and provides real step evidence", () => {
  const projection = buildPublicProductEvidence({ product: product(), layer: layer(), assets: [asset({}), asset({ id: "asset-duplicate", sha256: "a".repeat(64) })] });
  assert.equal(projection.sourceReferences.find((item) => item.kind === "coverage-input")?.label, "区域文件 ZIP");
  assert.equal(projection.sourceReferences.some((item) => item.kind === "official-query"), false);
  assert.equal(projection.sourceReferences.some((item) => item.kind === "official-data"), false);
  assert.deepEqual(projection.steps.map((step) => step.sequence), [1, 2]);
  assert.ok(projection.steps[0]?.code?.snippet.includes("input_digest"));
  assert.equal(projection.steps[1]?.outputs[0]?.sha256, "a".repeat(64));
  assert.equal(projection.steps[1]?.outputs.length, 1);
});

test("missing source and output evidence is explicit instead of invented", () => {
  const projection = buildPublicProductEvidence({ product: product({ sourceUrl: undefined, geometrySourceUrl: undefined }), assets: [] });
  assert.equal(projection.sourceReferences.length, 0);
  assert.equal(projection.steps[0]?.status, "unavailable");
  assert.match(projection.steps[0]?.reason ?? "", /输入来源|发布制品/);
});
