import assert from "node:assert/strict";
import test from "node:test";

import { AdminHttpError, AssetsAdmin, type ScanBatchTaskRecipe } from "../server/admin.js";
import { batchEvidenceLayerId, parseScanBatchRequest, resolveScanBatchMode, ScanBatchValidationError, scanBatchView, validateFilenamePattern, validateRelativePrefix } from "../server/scan-batch.js";

const config = {
  enabled: true,
  namespace: "atlas-warehouse",
  adminToken: "token",
  kubeToken: "token",
  apiBaseUrl: "https://kube.example.invalid",
  tokenFile: "",
  caFile: "",
  warehouseEsUrl: "https://warehouse-es.example.invalid:9200",
  scannerImage: "scanner:v1",
  evidenceClaimName: "atlas-evidence",
  evidenceMountPath: "/var/lib/atlas-evidence",
};

function batchRequest(sourcePath = "oss://survey-data/MER/Q1", name = "euclid-q1-batch") {
  return parseScanBatchRequest({
    name,
    sourceConnector: "euclid-q1",
    sourcePaths: [sourcePath],
    partitioning: { mode: "direct-child-prefixes", scopeId: "euclid-q1-q1", maxPartitions: 256 },
    maxConcurrent: 8,
    rules: [
      { name: "vis-images", productId: "euclid-q1-vis", relativePrefix: "VIS/", includePattern: "*.fits", allowedSuffixes: ".fits", maxOrder: 4 },
      { name: "catalog", productId: "euclid-q1-catalog", filters: { includeSuffixes: [".csv"], excludePatterns: ["*.tmp"] }, raColumn: "ra", decColumn: "dec" },
      { name: "healpix", productId: "euclid-q1-healpix", scanMode: "nested-healpix", relativePrefix: "HPX", filters: { includeSuffixes: [".csv"] }, healpixColumn: "hpx", healpixOrder: 4 },
      { name: "fits-catalog", productId: "euclid-q1-fits-catalog", scanMode: "catalog-radec", relativePrefix: "CAT", includePattern: "*.fits", allowedSuffixes: ".fits", raColumn: "ra", decColumn: "dec", hduIndex: 0, coordinateFrame: "ICRS" },
    ],
  });
}

function recipes(): ScanBatchTaskRecipe[] {
  return [
    {
      layerId: "euclid-q1-vis",
      surveyId: "euclid",
      releaseId: "q1",
      product: "Euclid Q1 VIS",
      productId: "euclid-q1-vis",
      modality: "image",
      mode: "fits-wcs",
      coverageRole: "image_extent",
      dataOrigin: "observed",
      sourceTier: "official_inventory_derived",
      allowedSuffixes: ".fits",
      maxOrder: 4,
    },
    {
      layerId: "euclid-q1-catalog",
      surveyId: "euclid",
      releaseId: "q1",
      product: "Euclid Q1 catalog",
      productId: "euclid-q1-catalog",
      modality: "catalog",
      mode: "catalog-radec",
      coverageRole: "object_presence",
      dataOrigin: "catalog",
      sourceTier: "official_inventory_derived",
      allowedSuffixes: ".csv",
      maxOrder: 8,
      raColumn: "ra",
      decColumn: "dec",
    },
    {
      layerId: "euclid-q1-healpix",
      surveyId: "euclid",
      releaseId: "q1",
      product: "Euclid Q1 HEALPix catalog",
      productId: "euclid-q1-healpix",
      modality: "catalog",
      mode: "nested-healpix",
      coverageRole: "object_presence",
      dataOrigin: "catalog",
      sourceTier: "official_inventory_derived",
      allowedSuffixes: ".csv",
      maxOrder: 8,
      healpixColumn: "hpx",
      healpixOrder: 4,
    },
    {
      layerId: "euclid-q1-fits-catalog",
      surveyId: "euclid",
      releaseId: "q1",
      product: "Euclid Q1 FITS catalog",
      productId: "euclid-q1-fits-catalog",
      modality: "catalog",
      mode: "catalog-radec",
      coverageRole: "object_presence",
      dataOrigin: "catalog",
      sourceTier: "official_inventory_derived",
      allowedSuffixes: ".fits",
      maxOrder: 8,
      raColumn: "ra",
      decColumn: "dec",
      hduIndex: 0,
      coordinateFrame: "ICRS",
    },
  ];
}

function fakeAdmin(calls: Array<{ plural: string; resource: Record<string, unknown> }>, prefix = "MER/Q1") {
  const connector = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "euclid-q1",
      labels: {
        "app.kubernetes.io/managed-by": "astro-survey-atlas-assets",
        "astro.zhejianglab.org/resource-kind": "connector",
      },
    },
    data: {
      type: "oss",
      endpoint: "https://oss.example.invalid",
      bucket: "survey-data",
      prefix,
      credentialSecretName: "euclid-q1-secret",
      accessKeyKey: "accessKey",
      secretKeyKey: "secretKey",
    },
  };
  const kube = {
    getCore: async (plural: string) => plural === "configmaps" ? connector : { metadata: { name: "euclid-q1-secret" } },
    create: async (plural: string, resource: Record<string, unknown>) => {
      calls.push({ plural, resource });
      return resource;
    },
    list: async () => [],
    get: async () => null,
  };
  return new AssetsAdmin(config, kube as never);
}

test("scan batch parsing accepts an empty rule prefix and rejects unsafe boundaries", () => {
  const parsed = parseScanBatchRequest({
    name: "wide-batch",
    sourceConnector: "source",
    sourcePaths: ["oss://bucket/root"],
    partitioning: { mode: "direct-child-prefixes", scopeId: "scope", maxPartitions: 1 },
    maxConcurrent: 1,
    rules: [{ name: "all-files", productId: "product-1", scanMode: "fits-wcs", relativePrefix: "", includePattern: "*.fits" }],
  });
  assert.equal(parsed.rules[0]?.relativePrefix, "");
  assert.equal(parsed.rules[0]?.scanMode, "fits-wcs");
  assert.equal(validateRelativePrefix("VIS/"), "VIS");
  for (const value of ["/", "/absolute", ".", "..", "tile/../other", "tile\\other", "tile//other", "tile//"]) {
    assert.throws(() => validateRelativePrefix(value), ScanBatchValidationError);
  }
  assert.throws(() => validateFilenamePattern("../*.fits"), /filename/);
  assert.throws(() => validateFilenamePattern("*.fits".replace("*", "dir/*")), /filename/);
  assert.throws(() => parseScanBatchRequest({
    name: "bad-mode",
    sourceConnector: "source",
    sourcePaths: ["oss://bucket/root"],
    partitioning: { mode: "direct-child-prefixes", scopeId: "scope", maxPartitions: 1 },
    maxConcurrent: 1,
    rules: [{ name: "all-files", productId: "product-1", scanMode: "tile-table", relativePrefix: "" }],
  }), /scanMode is unsupported/);
  const orderFour = parseScanBatchRequest({
    name: "order-four",
    sourceConnector: "source",
    sourcePaths: ["oss://bucket/root"],
    partitioning: { mode: "direct-child-prefixes", scopeId: "scope", maxPartitions: 1 },
    maxConcurrent: 1,
    rules: [{ name: "pixels", productId: "product-1", scanMode: "nested-healpix", relativePrefix: "", maxOrder: 4, healpixColumn: "hpx", healpixOrder: 4 }],
  });
  assert.equal(orderFour.rules[0]?.maxOrder, 4);
  assert.equal(orderFour.rules[0]?.healpixOrder, 4);
});

test("scan batch mode prefers a rule selection and only falls back to executable product modes", () => {
  assert.equal(resolveScanBatchMode("fits-header-position", "tile-table"), "fits-header-position");
  assert.equal(resolveScanBatchMode(undefined, "catalog-radec"), "catalog-radec");
  assert.equal(resolveScanBatchMode(undefined, "tile-table"), undefined);
  assert.equal(resolveScanBatchMode(undefined, "native-moc"), undefined);
});

test("scan batch catalog selectors are exact, exclusive, and mode-scoped", () => {
  const parse = (rule: Record<string, unknown>) => parseScanBatchRequest({
    name: "catalog-batch",
    sourceConnector: "source",
    sourcePaths: ["oss://bucket/root"],
    partitioning: { mode: "direct-child-prefixes", scopeId: "scope", maxPartitions: 1 },
    maxConcurrent: 1,
    rules: [{ name: "catalog", productId: "product-1", relativePrefix: "", raColumn: "ra", decColumn: "dec", ...rule }],
  }).rules[0]!;

  assert.deepEqual(
    { hduName: parse({ scanMode: "catalog-radec", hduName: "TARGETS", coordinateFrame: "ICRS" }).hduName, coordinateFrame: parse({ scanMode: "catalog-radec", hduName: "TARGETS", coordinateFrame: "ICRS" }).coordinateFrame },
    { hduName: "TARGETS", coordinateFrame: "ICRS" },
  );
  assert.equal(parse({ scanMode: "catalog-radec", hduIndex: 0, coordinateFrame: "ICRS" }).hduIndex, 0);
  assert.equal(parse({ scanMode: "catalog-radec", coordinateFrame: "ICRS" }).coordinateFrame, "ICRS");
  assert.equal(parse({ scanMode: "catalog-radec" }).coordinateFrame, undefined);
  assert.throws(() => parse({ scanMode: "catalog-radec", hduName: "TARGETS", hduIndex: 0, coordinateFrame: "ICRS" }), /either hduName or hduIndex/);
  assert.throws(() => parse({ scanMode: "catalog-radec", hduIndex: 0 }), /requires coordinateFrame ICRS/);
  for (const coordinateFrame of ["icrs", "ICRS ", "FK5"]) {
    assert.throws(() => parse({ scanMode: "catalog-radec", coordinateFrame }), /exactly ICRS/);
  }
  assert.throws(() => parse({ scanMode: "fits-wcs", coordinateFrame: "ICRS" }), /only with catalog-radec/);
  assert.throws(() => parse({ scanMode: "nested-healpix", hduIndex: 0, coordinateFrame: "ICRS" }), /only with catalog-radec/);
});

test("scan batch request requires one root, bounded rules, and unique products", () => {
  const base = {
    name: "batch",
    sourceConnector: "source",
    sourcePaths: ["oss://bucket/root"],
    partitioning: { mode: "direct-child-prefixes", scopeId: "scope", maxPartitions: 8 },
    maxConcurrent: 2,
    rules: [{ name: "one", productId: "product-1" }],
  };
  assert.throws(() => parseScanBatchRequest({ ...base, sourcePaths: ["oss://bucket/a", "oss://bucket/b"] }), /exactly one/);
  assert.throws(() => parseScanBatchRequest({ ...base, rules: Array.from({ length: 33 }, (_, index) => ({ name: `rule-${index}`, productId: `product-${index}` })) }), /1 to 32/);
  assert.throws(() => parseScanBatchRequest({ ...base, rules: [{ name: "one", productId: "same" }, { name: "two", productId: "same" }] }), /product may appear only once/);
  for (const [field, value] of Object.entries({
    layerId: "forged-layer",
    surveyId: "forged-survey",
    releaseId: "forged-release",
    product: "forged-product",
    modality: "forged-modality",
    mode: "fits-wcs",
    coverageRole: "footprint",
    dataOrigin: "observed",
    sourceTier: "official_inventory_derived",
  })) {
    assert.throws(() => parseScanBatchRequest({ ...base, rules: [{ name: "one", productId: "product-1", [field]: value }] }), new RegExp(`${field} is not supported`));
  }
});

test("Assets submits one normalized ScanBatchRequest with shared connector credentials and rule identities", async () => {
  const calls: Array<{ plural: string; resource: Record<string, unknown> }> = [];
  const admin = fakeAdmin(calls);
  const created = await admin.createScanBatch(batchRequest(), recipes());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.plural, "scanbatchrequests");
  const resource = calls[0]?.resource;
  assert.equal(resource?.kind, "ScanBatchRequest");
  const spec = resource?.spec as Record<string, unknown>;
  assert.deepEqual(spec.credentials, { source: { secretName: "euclid-q1-secret", accessKeyKey: "accessKey", secretKeyKey: "secretKey" } });
  assert.equal((spec.source as { location: { bucket: string; prefix: string } }).location.prefix, "MER/Q1");
  const rules = spec.rules as Array<Record<string, unknown>>;
  assert.equal(rules.length, 4);
  assert.equal((rules[0]?.layer as Record<string, unknown>).layerId, batchEvidenceLayerId("euclid-q1-vis"));
  assert.equal((rules[0]?.layer as Record<string, unknown>).coverageRole, "footprint");
  assert.deepEqual(rules[0]?.filters, { includeSuffixes: [".fits"] });
  assert.equal(rules[0]?.relativePrefix, "VIS");
  assert.equal(rules[0]?.includePattern, "*.fits");
  assert.equal((rules[0]?.extraction as Record<string, unknown>).mode, "fits-wcs");
  assert.equal((rules[1]?.layer as Record<string, unknown>).coverageRole, "occupancy");
  assert.deepEqual(rules[1]?.filters, { includeSuffixes: [".csv"], excludePatterns: ["*.tmp"] });
  assert.equal((rules[2]?.layer as Record<string, unknown>).coverageRole, "occupancy");
  assert.equal((rules[2]?.extraction as Record<string, unknown>).mode, "catalog-healpix");
  assert.equal(((rules[2]?.extraction as Record<string, unknown>).catalog as Record<string, unknown>).healpixOrder, 4);
  assert.deepEqual(((rules[1]?.extraction as Record<string, unknown>).catalog as Record<string, unknown>), { raColumn: "ra", decColumn: "dec" });
  assert.deepEqual(((rules[3]?.extraction as Record<string, unknown>).catalog as Record<string, unknown>), {
    raColumn: "ra",
    decColumn: "dec",
    hduIndex: 0,
    coordinateFrame: "ICRS",
  });
  assert.deepEqual((spec.partitioning as Record<string, unknown>).mode, "direct-child-prefixes");
  assert.equal((created as Record<string, unknown>).sourceConnector, "euclid-q1");
  assert.doesNotMatch(JSON.stringify(created), /euclid-q1-secret|var\/lib\/atlas-evidence|credentialRef/);

  await admin.createScanBatch(batchRequest("oss://survey-data/MER/Q1", "euclid-q1-batch-again"), recipes());
  const secondRules = ((calls[1]?.resource.spec as Record<string, unknown>).rules as Array<Record<string, unknown>>);
  assert.deepEqual(
    secondRules.map(rule => (rule.layer as Record<string, unknown>).layerId),
    rules.map(rule => (rule.layer as Record<string, unknown>).layerId),
  );
});

test("Assets rejects a batch rule without a product identity before submitting it", async () => {
  const calls: Array<{ plural: string; resource: Record<string, unknown> }> = [];
  const incompleteRecipes = recipes();
  incompleteRecipes[1] = { ...incompleteRecipes[1]!, productId: undefined };
  await assert.rejects(fakeAdmin(calls).createScanBatch(batchRequest(), incompleteRecipes), (error: unknown) => {
    assert.ok(error instanceof AdminHttpError);
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /rule 2 is missing a productId/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("DESI DR1 catalog batch derives occupancy while preserving its spectrum product recipe", async () => {
  const calls: Array<{ plural: string; resource: Record<string, unknown> }> = [];
  const admin = fakeAdmin(calls, "DESI/DR1");
  const batch = parseScanBatchRequest({
    name: "desi-dr1-spectra-batch",
    sourceConnector: "euclid-q1",
    sourcePaths: ["oss://survey-data/DESI/DR1"],
    partitioning: { mode: "direct-child-prefixes", scopeId: "desi-dr1-tiles", maxPartitions: 256 },
    maxConcurrent: 8,
    rules: [{
      name: "spectra-targets",
      productId: "desi-dr1-spectra",
      scanMode: "catalog-radec",
      relativePrefix: "spectra",
      includePattern: "spectra-*.fits",
      allowedSuffixes: ".fits",
      maxOrder: 8,
      raColumn: "TARGET_RA",
      decColumn: "TARGET_DEC",
      hduName: "FIBERMAP",
      coordinateFrame: "ICRS",
    }],
  });
  const recipe: ScanBatchTaskRecipe = {
    layerId: "desi-dr1-spectra-footprint",
    surveyId: "desi",
    releaseId: "dr1",
    product: "DESI DR1 Spectra",
    productId: "desi-dr1-spectra",
    modality: "spectroscopy",
    mode: "catalog-radec",
    coverageRole: "footprint_extent",
    dataOrigin: "observed",
    sourceTier: "official_inventory_derived",
    allowedSuffixes: ".fits",
    maxOrder: 8,
    raColumn: "TARGET_RA",
    decColumn: "TARGET_DEC",
    hduName: "FIBERMAP",
    coordinateFrame: "ICRS",
  };

  await admin.createScanBatch(batch, [recipe]);
  const resource = calls[0]?.resource;
  const submittedRule = ((resource?.spec as Record<string, unknown>).rules as Array<Record<string, unknown>>)[0]!;
  const layer = submittedRule.layer as Record<string, unknown>;
  assert.equal(layer.surveyId, "desi");
  assert.equal(layer.releaseId, "dr1");
  assert.equal(layer.productId, "desi-dr1-spectra");
  assert.deepEqual({ modality: layer.modality, coverageRole: layer.coverageRole }, { modality: "spectrum", coverageRole: "occupancy" });
  assert.equal((submittedRule.extraction as Record<string, unknown>).mode, "catalog-radec");
  assert.deepEqual((submittedRule.extraction as Record<string, unknown>).catalog, {
    raColumn: "TARGET_RA",
    decColumn: "TARGET_DEC",
    hduName: "FIBERMAP",
    coordinateFrame: "ICRS",
  });
  assert.equal(recipe.coverageRole, "footprint_extent");
});

test("scan batch source root cannot escape a configured object connector prefix", async () => {
  const calls: Array<{ plural: string; resource: Record<string, unknown> }> = [];
  const admin = fakeAdmin(calls);
  await assert.rejects(admin.createScanBatch(batchRequest("oss://survey-data/MER/Q2"), recipes()), (error: unknown) => {
    assert.ok(error instanceof AdminHttpError);
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /connector root/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("scan batch status view returns bounded scope and summary metadata without roster or credentials", () => {
  const view = scanBatchView({
    metadata: { name: "batch", namespace: "atlas-warehouse", labels: { "astro.zhejianglab.org/source-connector": "source" } },
    spec: {
      source: { connector: { type: "oss", credentialRef: { accessKeyEnv: "secret-env" } }, location: { bucket: "data", prefix: "root" } },
      credentials: { source: { secretName: "secret" } },
      scanner: { evidence: { claimName: "evidence" } },
      evidence: { outputPath: "/var/lib/evidence/large-roster" },
      rules: [{ name: "one", layer: { layerId: "layer-1", productId: "product-1" }, relativePrefix: "" }],
    },
    status: {
      phase: "RUNNING",
      roster: ["large", "frozen", "roster"],
      scope: { rules: [{ name: "one", layerId: "layer-1", scopeId: "scope", scopeSnapshotSha256: "a".repeat(64), expectedPartitionCount: 10 }] },
      summary: { completedRules: 0, rules: [{ name: "one", layerId: "layer-1", expectedPartitions: 10, completedPartitions: 2, failedPartitions: 1, runningPartitions: 3, files: 40, coverage: 8, availableOrders: [8] }] },
    },
  });
  const text = JSON.stringify(view);
  assert.equal((view.status as { phase: string }).phase, "RUNNING");
  assert.equal(((view.status as { scope: { rules: Array<{ scopeSnapshotSha256: string }> } }).scope.rules[0]!).scopeSnapshotSha256.length, 64);
  assert.equal(((view.status as { summary: { rules: Array<{ completedPartitions: number }> } }).summary.rules[0]!).completedPartitions, 2);
  assert.doesNotMatch(text, /large-roster|secret-env|secret\"|\"roster\"/);
});
