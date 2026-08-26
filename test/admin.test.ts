import assert from "node:assert/strict";
import test from "node:test";

import { AdminHttpError, AssetsAdmin, buildConnectorResource, buildConnectorResources, buildTaskResource, taskView } from "../server/admin.js";

test("connector resources keep fields specific to their selected type", () => {
  const local = buildConnectorResources({ name: "assets-local", type: "local", localPath: "eva7028:/data/coverage-inputs" }, "warehouse");
  assert.equal(local.configMap.apiVersion, "v1");
  assert.equal(local.configMap.kind, "ConfigMap");
  assert.deepEqual(local.configMap.data, { type: "local", localPath: "eva7028:/data/coverage-inputs", nodeName: "eva7028", nodePath: "/data/coverage-inputs", pvcName: "assets-local-pvc" });
  assert.equal(local.persistentVolume?.spec?.hostPath && (local.persistentVolume.spec.hostPath as Record<string, unknown>).path, "/data/coverage-inputs");
  assert.deepEqual((local.persistentVolume?.spec?.nodeAffinity as Record<string, unknown>)?.required, { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: ["eva7028"] }] }] });
  assert.equal(local.configMap.data?.localPath, "eva7028:/data/coverage-inputs");
  assert.equal(local.persistentVolumeClaim?.metadata?.name, "assets-local-pvc");
  const objectStorage = buildConnectorResources({ name: "assets-s3", type: "s3", endpoint: "https://object.example", bucket: "data", accessKey: "key", secretKey: "secret" }, "warehouse");
  assert.deepEqual(objectStorage.configMap.data, { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-s3-credentials", accessKeyKey: "accessKey", secretKeyKey: "secretKey" });
  assert.deepEqual(objectStorage.secret?.stringData, { accessKey: "key", secretKey: "secret" });
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-local", type: "local", localPath: "eva7028:/data/local", endpoint: "https://object.example" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-node", type: "local", localPath: "eva7028:/data/../secrets" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-es", type: "elasticsearch", endpoint: "https://search.example" } as never, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-s3", type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "user-secret" } as never, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
});

test("coverage task defaults use the standard Elasticsearch index names", () => {
  const resource = buildTaskResource({
    name: "assets-dryrun-coverage",
    layerId: "csst-sim-w2-image-extent",
    surveyId: "csst",
    releaseId: "csst-sim-w2-20250731",
    product: "CSST W2 simulated images",
    mode: "fits-wcs",
    coverageRole: "image_extent",
    dataOrigin: "simulated",
    sourceTier: "user_file_derived",
    sourceConnector: "assets-dryrun-source",
    sourcePaths: ["oss://example/projects/CSST"],
  }, "warehouse");

  assert.equal(resource.apiVersion, "atlas.zhejianglab.org/v1alpha1");
  assert.equal(resource.kind, "ScanRequest");
  const plan = resource.spec?.plan as Record<string, unknown>;
  const sink = (plan.sink as Record<string, unknown>).connector as Record<string, unknown>;
  assert.equal(sink.type, "elasticsearch");
  assert.equal((plan.source as Record<string, unknown>).location && ((plan.source as Record<string, unknown>).location as Record<string, unknown>).prefix, "projects/CSST");
  assert.equal((plan.extraction as Record<string, unknown>).mode, "fits-wcs");
  assert.deepEqual(resource.spec?.credentials, {});
  assert.equal((resource.spec?.scanner as Record<string, unknown>).evidence && ((resource.spec?.scanner as Record<string, unknown>).evidence as Record<string, unknown>).claimName, "atlas-evidence");
});

test("spectrum tasks render the Warehouse header-position extraction mode", () => {
  const resource = buildTaskResource({
    name: "sdss-spectrum-position",
    layerId: "sdss-spectrum-entrypoints",
    surveyId: "sdss",
    releaseId: "sdss-dr18",
    product: "SDSS spectra",
    modality: "spectroscopy",
    mode: "fits-header-position",
    coverageRole: "footprint_extent",
    dataOrigin: "observed",
    sourceTier: "official_inventory_derived",
    sourceConnector: "sdss-source",
    sourcePaths: ["oss://example/spectra/spec-0001.fits"],
    allowedSuffixes: ".fits",
    maxOrder: 8,
  }, "warehouse");
  const plan = resource.spec?.plan as Record<string, unknown>;
  assert.equal((plan.extraction as Record<string, unknown>).mode, "fits-header-position");
  assert.equal((plan.layer as Record<string, unknown>).modality, "spectrum");
});

test("task views expose summary evidence without embedding evidence payloads", () => {
  const view = taskView({
    metadata: { name: "catalog-probe", labels: { "astro.zhejianglab.org/source-connector": "catalog-source" } },
    spec: { plan: { scanRunId: "catalog-probe-run", layer: { layerId: "catalog-layer", surveyId: "gaia", releaseId: "dr3", productId: "main-source", modality: "catalog" }, source: { connector: { type: "oss" }, location: { bucket: "data", prefix: "gaia.csv" } }, extraction: { mode: "catalog-radec", outputOrder: 8, catalog: { raColumn: "ra", decColumn: "dec" } } } },
    status: { phase: "SUCCEEDED", reason: "Completed", summary: { scanRunId: "catalog-probe-run", discoveredFileCount: 1, processedItemCount: 128, coverageRecordCount: 12, errorCount: 0, availableOrders: [8], evidencePath: "/evidence/catalog-probe", sourceSnapshotSha256: "a".repeat(64) } },
  });
  assert.equal(view.modality, "catalog");
  assert.equal(view.recipe?.mode, "catalog-radec");
  assert.deepEqual(view.status.availableOrders, [8]);
  assert.equal(view.status.errorCount, 0);
  assert.equal(view.status.evidencePath, "/evidence/catalog-probe");
  assert.equal(view.status.sourceSnapshot?.sha256, "a".repeat(64));
  assert.equal(view.status.runId, "catalog-probe-run");
  assert.equal(view.status.sourceSnapshot?.uri, undefined);
  assert.equal("payload" in view.status, false);
});

test("task resubmission preserves the plan and creates a fresh immutable identity", async () => {
  const original = {
    metadata: { name: "image-probe", namespace: "warehouse", uid: "old-uid", resourceVersion: "42", generation: 3, managedFields: [{ manager: "operator" }], annotations: { old: "value" }, labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/task-kind": "public-coverage", "astro.zhejianglab.org/task-id": "image-probe" } },
    spec: { plan: { scanRunId: "image-probe-run", layer: { layerId: "image-layer", surveyId: "euclid", releaseId: "q1", productId: "vis", modality: "image" }, source: { connector: { type: "oss" }, location: { bucket: "data", prefix: "vis.fits" } }, extraction: { mode: "fits-wcs", outputOrder: 8, catalog: {} }, evidence: { outputPath: "/old/evidence" } } },
    status: { phase: "FAILED" },
  };
  let created: Record<string, unknown> | undefined;
  const kube = {
    get: async () => original,
    create: async (_plural: string, resource: Record<string, unknown>) => { created = resource; return resource; },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const view = await new AssetsAdmin(config, kube as never).resubmitTask("image-probe");
  assert.match(view.name, /^image-probe-retry-/);
  assert.equal((created?.status), undefined);
  const metadata = created?.metadata as Record<string, unknown>;
  assert.equal((metadata.labels as Record<string, string>)["astro.zhejianglab.org/retry-of"], "image-probe");
  assert.deepEqual(Object.keys(metadata).sort(), ["labels", "name", "namespace"]);
  const plan = ((created?.spec as Record<string, unknown>).plan as Record<string, unknown>);
  assert.notEqual(plan.scanRunId, "image-probe-run");
  assert.match(((plan.evidence as Record<string, unknown>).outputPath as string), /^\/evidence\/image-probe-retry-/);
});

test("coverage tasks reject unsupported sink connectors", () => {
  assert.throws(() => buildTaskResource({
    name: "assets-sink-task",
    layerId: "csst-sim-w2-image-extent",
    surveyId: "csst",
    releaseId: "csst-sim-w2-20250731",
    product: "CSST W2 simulated images",
    mode: "fits-wcs",
    coverageRole: "image_extent",
    dataOrigin: "simulated",
    sourceTier: "user_file_derived",
    sourceConnector: "assets-source",
    sourcePaths: ["/data/input"],
    sinkConnector: "elasticsearch",
  }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
});

test("coverage task basename patterns are rejected when they are not representable in ScanPlan v2", () => {
  assert.throws(() => buildTaskResource({
    name: "assets-pattern-coverage",
    layerId: "csst-sim-w2-image-extent",
    surveyId: "csst",
    releaseId: "csst-sim-w2-20250731",
    product: "CSST W2 simulated images",
    mode: "fits-wcs",
    coverageRole: "image_extent",
    dataOrigin: "simulated",
    sourceTier: "user_file_derived",
    sourceConnector: "assets-dryrun-source",
    sourcePaths: ["oss://data-and-computing/projects/CSST"],
    fileNamePattern: "^CSST_.*\\\\.fits$",
  }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
});
