import assert from "node:assert/strict";
import test from "node:test";

import { AdminHttpError, AssetsAdmin, buildConnectorResource, buildConnectorResources, buildTaskResource, connectorView, taskView, type ObjectStorageProbeInput } from "../server/admin.js";
import { aggregateWorkAttempts } from "../site/admin/work-items.js";

test("work output aggregation counts attempts but renders only the latest result", () => {
  const groups = aggregateWorkAttempts(
    [
      { key: "product:jwst-dr1", createdAt: "2026-08-29T00:00:00Z", value: { createdAt: "2026-08-29T00:00:00Z", status: { phase: "FAILED", discoveredFiles: 2 } } },
      { key: "product:jwst-dr1", createdAt: "2026-08-30T00:00:00Z", value: { createdAt: "2026-08-30T00:00:00Z", status: { phase: "SUCCEEDED", discoveredFiles: 5 } } },
    ],
    [
      { key: "product:jwst-dr1", createdAt: "2026-08-29T00:00:00Z", value: { createdAt: "2026-08-29T00:00:00Z", status: { phase: "FAILED", candidateCount: 0 } } },
      { key: "product:jwst-dr1", createdAt: "2026-08-30T01:00:00Z", value: { createdAt: "2026-08-30T01:00:00Z", status: { phase: "SUCCEEDED", candidateCount: 1 } } },
    ],
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.taskAttempts, 2);
  assert.equal(groups[0]?.mocAttempts, 2);
  assert.equal((groups[0]?.task as { status: { phase: string; discoveredFiles: number } }).status.phase, "SUCCEEDED");
  assert.equal((groups[0]?.task as { status: { phase: string; discoveredFiles: number } }).status.discoveredFiles, 5);
  assert.equal((groups[0]?.request as { status: { phase: string; candidateCount: number } }).status.phase, "SUCCEEDED");
  assert.equal((groups[0]?.request as { status: { phase: string; candidateCount: number } }).status.candidateCount, 1);
});

test("connector resources keep fields specific to their selected type", () => {
  const local = buildConnectorResources({ name: "assets-local", type: "local", pvcName: "atlas-source-catalogs", basePath: "cosmos-parameter-prediction" }, "warehouse");
  assert.equal(local.configMap.apiVersion, "v1");
  assert.equal(local.configMap.kind, "ConfigMap");
  assert.deepEqual(local.configMap.data, { type: "local", pvcName: "atlas-source-catalogs", basePath: "cosmos-parameter-prediction" });
  assert.equal(local.persistentVolume, undefined);
  assert.equal(local.persistentVolumeClaim, undefined);
  assert.throws(() => buildConnectorResource({ name: "assets-missing-pvc", type: "local" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /pvcName is required/.test(error.message));
  assert.throws(() => buildConnectorResource({ name: "assets-legacy-local", type: "local", localPath: "eva7028:/data/coverage-inputs" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /no longer accepted/.test(error.message));
  assert.throws(() => buildConnectorResource({ name: "assets-absolute-base", type: "local", pvcName: "atlas-source-catalogs", basePath: "/cosmos" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /relative POSIX/.test(error.message));
  assert.throws(() => buildConnectorResource({ name: "assets-dot-base", type: "local", pvcName: "atlas-source-catalogs", basePath: "cosmos/../private" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /dot segments/.test(error.message));
  const objectStorage = buildConnectorResources({ name: "assets-s3", type: "s3", endpoint: "https://object.example", bucket: "data", accessKey: "key", secretKey: "secret" }, "warehouse");
  assert.deepEqual(objectStorage.configMap.data, { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-s3-credentials", accessKeyKey: "accessKey", secretKeyKey: "secretKey" });
  assert.throws(() => buildConnectorResource({ name: "assets-legacy-s3", type: "s3", endpoint: "http://warehouse-minio.warehouse.svc.cluster.local:9000", bucket: "data", accessKey: "key", secretKey: "secret" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /legacy warehouse/.test(error.message));
  assert.deepEqual(objectStorage.secret?.stringData, { accessKey: "key", secretKey: "secret" });
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-local", type: "local", localPath: "eva7028:/data/local", endpoint: "https://object.example" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-node", type: "local", localPath: "eva7028:/data/../secrets" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-es", type: "elasticsearch", endpoint: "https://search.example" } as never, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-s3", type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "user-secret" } as never, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
});

test("connector views start as NOT_CHECKED because ConfigMaps do not persist probe state", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const kube = {
    listCore: async () => [{ metadata: { name: "assets-source", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-source-credentials" } }],
  };
  const connectors = await new AssetsAdmin(config, kube as never).listConnectors();
  assert.equal(connectors[0]?.phase, "NOT_CHECKED");
  assert.equal(connectors[0]?.checkedAt, undefined);
});

test("object connector probes decode Secret data and return a transient READY result", async () => {
  let received: ObjectStorageProbeInput | undefined;
  const kube = {
    getCore: async (plural: string) => {
      if (plural === "configmaps") return { metadata: { name: "assets-oss", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "oss", endpoint: "https://oss.example", region: "cn-hangzhou", bucket: "astro-artifacts", prefix: "" , credentialSecretName: "assets-oss-credentials" } };
      return { data: { accessKey: Buffer.from("access-key").toString("base64"), secretKey: Buffer.from("secret-value").toString("base64") } };
    },
  };
  const probe = { probeObjectStorage: async (input: ObjectStorageProbeInput) => { received = input; } };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const result = await new AssetsAdmin(config, kube as never, probe).probeConnector("assets-oss");
  assert.equal(result.phase, "READY");
  assert.match(result.checkedAt ?? "", /^20\d\d-/);
  assert.equal(received?.type, "oss");
  assert.equal(received?.accessKeyId, "access-key");
  assert.equal(received?.secretAccessKey, "secret-value");
  assert.equal("secret-value" in result, false);
});

test("object connector probes report empty listings as READY and redact storage errors", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = { metadata: { name: "assets-s3", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "empty-bucket", credentialSecretName: "assets-s3-credentials" } };
  const kube = {
    getCore: async (plural: string) => plural === "configmaps" ? resource : { data: { accessKey: Buffer.from("key").toString("base64"), secretKey: Buffer.from("secret").toString("base64") } },
  };
  const ready = await new AssetsAdmin(config, kube as never, { probeObjectStorage: async () => undefined }).probeConnector("assets-s3");
  assert.equal(ready.phase, "READY");
  const failing = await new AssetsAdmin(config, kube as never, { probeObjectStorage: async () => { throw Object.assign(new Error("secret must never be returned"), { $metadata: { httpStatusCode: 403 } }); } }).probeConnector("assets-s3");
  assert.equal(failing.phase, "ERROR");
  assert.equal(failing.message, "Object storage returned HTTP 403");
  assert.doesNotMatch(failing.message ?? "", /secret/);
  const timedOut = await new AssetsAdmin(config, kube as never, { probeObjectStorage: async () => { throw Object.assign(new Error("request exceeded deadline"), { name: "TimeoutError" }); } }).probeConnector("assets-s3");
  assert.equal(timedOut.phase, "ERROR");
  assert.equal(timedOut.message, "Object storage probe timed out");
});

test("object connector probes return ERROR for missing credentials", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const base = { metadata: { name: "assets-s3", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-s3-credentials" } };
  const missingSecret = { getCore: async (plural: string) => plural === "configmaps" ? base : null };
  const missing = await new AssetsAdmin(config, missingSecret as never, { probeObjectStorage: async () => undefined }).probeConnector("assets-s3");
  assert.equal(missing.phase, "ERROR");
  assert.equal(missing.message, "Credential Secret was not found");
  const missingKey = { getCore: async (plural: string) => plural === "configmaps" ? base : { data: {} } };
  const invalid = await new AssetsAdmin(config, missingKey as never, { probeObjectStorage: async () => undefined }).probeConnector("assets-s3");
  assert.equal(invalid.phase, "ERROR");
  assert.equal(invalid.message, "Credential Secret is missing the configured keys");
});

test("local connector probes distinguish an authorized PVC state from pending and unauthorized claims", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const connector = { metadata: { name: "catalog-source", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "local", pvcName: "atlas-source-catalogs", basePath: "catalogs" } };
  const readyKube = { getCore: async (plural: string) => plural === "configmaps" ? connector : { metadata: { labels: { "atlas.zhejianglab.org/scanner-source": "true" } }, status: { phase: "Bound" } } };
  const ready = await new AssetsAdmin(config, readyKube as never).probeConnector("catalog-source");
  assert.equal(ready.phase, "READY");
  const pendingKube = { getCore: async (plural: string) => plural === "configmaps" ? connector : { metadata: { labels: { "atlas.zhejianglab.org/scanner-source": "true" } }, status: { phase: "Pending" } } };
  const pending = await new AssetsAdmin(config, pendingKube as never).probeConnector("catalog-source");
  assert.equal(pending.phase, "PENDING");
  const unauthorizedKube = { getCore: async (plural: string) => plural === "configmaps" ? connector : { metadata: { labels: {} }, status: { phase: "Bound" } } };
  const unauthorized = await new AssetsAdmin(config, unauthorizedKube as never).probeConnector("catalog-source");
  assert.equal(unauthorized.phase, "ERROR");
  assert.match(unauthorized.message ?? "", /not authorized/);
});

test("connector probes reject ConfigMaps that are not owned by Assets", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const kube = { getCore: async () => ({ metadata: { name: "other", labels: { "app.kubernetes.io/managed-by": "warehouse" } }, data: { type: "local", pvcName: "source" } }) };
  await assert.rejects(() => new AssetsAdmin(config, kube as never).probeConnector("other"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 404);
});

test("local coverage tasks translate relative paths into a read-only source PVC mount", () => {
  const resource = buildTaskResource({
    name: "cosmos-catalog-scan",
    layerId: "cosmos-prediction-catalog",
    surveyId: "cosmos",
    releaseId: "prediction-2026",
    product: "COSMOS parameter predictions",
    mode: "catalog-radec",
    coverageRole: "object_presence",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    sourceConnector: "cosmos-source",
    sourcePaths: ["web_predictions_COSMOS_prediction_dataset.csv"],
    allowedSuffixes: ".csv",
    raColumn: "ra",
    decColumn: "dec",
  }, "warehouse", {
    name: "cosmos-source",
    type: "local",
    pvcName: "atlas-source-catalogs",
    basePath: "cosmos-parameter-prediction",
  } as never);
  const plan = resource.spec?.plan as Record<string, unknown>;
  assert.deepEqual((plan.source as Record<string, unknown>).location, { rootPath: "/data/web_predictions_COSMOS_prediction_dataset.csv" });
  assert.deepEqual((resource.spec?.scanner as Record<string, unknown>).sourceVolume, {
    claimName: "atlas-source-catalogs",
    mountPath: "/data",
    subPath: "cosmos-parameter-prediction",
  });
  assert.throws(() => buildTaskResource({
    name: "cosmos-escaping-scan",
    layerId: "cosmos-prediction-catalog",
    surveyId: "cosmos",
    releaseId: "prediction-2026",
    product: "COSMOS parameter predictions",
    mode: "catalog-radec",
    coverageRole: "object_presence",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    sourceConnector: "cosmos-source",
    sourcePaths: ["../private.csv"],
    raColumn: "ra",
    decColumn: "dec",
  }, "warehouse", { name: "cosmos-source", type: "local", pvcName: "atlas-source-catalogs" } as never), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /dot segments/.test(error.message));
});

test("legacy local connector records remain visible but cannot submit scans", () => {
  const view = connectorView({ metadata: { name: "legacy-local" }, data: { type: "local", localPath: "eva7028:/data/coverage-inputs", nodeName: "eva7028", nodePath: "/data/coverage-inputs" } });
  assert.equal(view.localPath, "eva7028:/data/coverage-inputs");
  assert.equal(view.pvcName, undefined);
  assert.equal(view.basePath, undefined);
});

test("creating a local connector only writes its ConfigMap", async () => {
  const calls: string[] = [];
  const kube = {
    createCore: async (plural: string, resource: Record<string, unknown>) => {
      calls.push(plural);
      return resource;
    },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const view = await new AssetsAdmin(config, kube as never).createConnector({ name: "cosmos-source", type: "local", pvcName: "atlas-source-catalogs", basePath: "cosmos-parameter-prediction" });
  assert.equal(view.pvcName, "atlas-source-catalogs");
  assert.deepEqual(calls, ["configmaps"]);
});

test("MOC discovery requests keep execution policy inside Warehouse", async () => {
  let created: Record<string, unknown> | undefined;
  const kube = {
    create: async (_plural: string, resource: Record<string, unknown>) => { created = resource; return resource; },
  };
  const config = {
    enabled: true,
    namespace: "atlas-warehouse",
    adminToken: "token",
    kubeToken: "token",
    apiBaseUrl: "https://kube",
    tokenFile: "",
    caFile: "",
    warehouseEsUrl: "http://es",
    scannerImage: "scanner",
    evidenceClaimName: "atlas-evidence-smoke",
    evidenceMountPath: "/var/lib/atlas-evidence",
  };
  const request = await new AssetsAdmin(config, kube as never).createMocDiscoveryRequest({ surveyName: "Gaia", releaseHint: "DR3" });
  assert.match(request.name, /^gaia-moc-discovery-/);
  assert.equal(request.surveyName, "Gaia");
  assert.equal(request.releaseHint, "DR3");
  assert.equal(request.policyRef, "cds-public-moc-v1");
  assert.deepEqual(created?.spec, { query: { surveyName: "Gaia", releaseHint: "DR3" }, policyRef: "cds-public-moc-v1" });
  assert.equal((created?.metadata as Record<string, unknown>).namespace, "atlas-warehouse");
  assert.equal((created?.metadata as Record<string, unknown>).labels && ((created?.metadata as Record<string, unknown>).labels as Record<string, string>)["astro.zhejianglab.org/resource-kind"], "moc-discovery");
});

test("MOC discovery lists stay compact while details expose review summaries", async () => {
  const resource = {
    metadata: { name: "jwst-moc-discovery", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "JWST" }, policyRef: "cds-public-moc-v1" },
    status: { phase: "SUCCEEDED", candidateCount: 1, probeCount: 1, reviewSummary: { schemaVersion: 1, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst" }], probes: [{ probeId: "a".repeat(64), candidateId: "jwst", kind: "mocUrl", url: "https://alasky.cds.unistra.fr/jwst/moc.fits", ok: true, sha256: "b".repeat(64), validation: { acceptedSpatialMoc: true } }] } },
  };
  const kube = { list: async () => [resource], get: async () => resource };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const admin = new AssetsAdmin(config, kube as never);

  const list = await admin.listMocDiscoveryRequests();
  const detail = await admin.getMocDiscoveryRequest("jwst-moc-discovery");

  assert.equal(list[0]?.status.reviewSummary, undefined);
  assert.equal(detail.status.reviewSummary?.candidates[0]?.candidateId, "jwst");
  assert.equal(detail.status.reviewSummary?.probes[0]?.sha256, "b".repeat(64));
});

test("MOC views preserve a legitimate zero-result summary separately from a missing summary", async () => {
  const empty = {
    metadata: { name: "empty-moc-discovery", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "Unknown survey" }, policyRef: "cds-public-moc-v1" },
    status: { phase: "SUCCEEDED", candidateCount: 0, probeCount: 0, reviewSummary: { schemaVersion: 1, truncated: false, summaryTruncated: false, candidates: [], probes: [] } },
  };
  const legacy = {
    metadata: { name: "legacy-moc-discovery", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "Legacy survey" }, policyRef: "cds-public-moc-v1" },
    status: { phase: "SUCCEEDED", candidateCount: 0, probeCount: 0 },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const kube = { get: async (_plural: string, name: string) => name === empty.metadata.name ? empty : name === legacy.metadata.name ? legacy : null };
  const admin = new AssetsAdmin(config, kube as never);
  const emptyView = await admin.getMocDiscoveryRequest(empty.metadata.name);
  const legacyView = await admin.getMocDiscoveryRequest(legacy.metadata.name);
  assert.equal(emptyView.status.reviewSummaryState, "available");
  assert.deepEqual(emptyView.status.reviewSummary?.candidates, []);
  assert.equal(emptyView.status.candidateCount, 0);
  assert.equal(legacyView.status.reviewSummaryState, "missing");
  assert.equal(legacyView.status.reviewSummary, undefined);
});

test("MOC views accept zero-result summaries when Kubernetes omits empty arrays", async () => {
  const resource = {
    metadata: { name: "serialized-empty-moc", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "JWST" }, policyRef: "cds-public-moc-v1" },
    status: { phase: "SUCCEEDED", candidateCount: 0, probeCount: 0, reviewSummary: { schemaVersion: 1, truncated: false, summaryTruncated: false } },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const admin = new AssetsAdmin(config, { get: async () => resource } as never);

  const view = await admin.getMocDiscoveryRequest(resource.metadata.name);

  assert.equal(view.status.reviewSummaryState, "available");
  assert.deepEqual(view.status.reviewSummary?.candidates, []);
  assert.deepEqual(view.status.reviewSummary?.probes, []);
});

test("MOC discovery resubmission creates an immutable retry and preserves work context", async () => {
  const original = {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: { name: "jwst-moc-discovery", namespace: "warehouse", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" }, annotations: { "assets.atlas.zhejianglab.org/work-ref": "{\"key\":\"product:jwst-dr1\",\"surveyId\":\"jwst\",\"releaseId\":\"dr1\",\"productId\":\"jwst-dr1\"}" } },
    spec: { query: { surveyName: "JWST", releaseHint: "DR1" }, policyRef: "cds-public-moc-v1" },
    status: { phase: "SUCCEEDED" },
  };
  let created: Record<string, unknown> | undefined;
  const kube = { get: async () => original, create: async (_plural: string, resource: Record<string, unknown>) => { created = resource; return resource; } };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };

  const retry = await new AssetsAdmin(config, kube as never).resubmitMocDiscoveryRequest("jwst-moc-discovery");

  assert.match(retry.name, /^jwst-moc-discovery-retry-/);
  assert.equal(created?.status, undefined);
  const metadata = created?.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
  assert.equal(metadata.labels["astro.zhejianglab.org/retry-of"], "jwst-moc-discovery");
  assert.equal(metadata.annotations["assets.atlas.zhejianglab.org/work-ref"], original.metadata.annotations["assets.atlas.zhejianglab.org/work-ref"]);
  assert.deepEqual(created?.spec, original.spec);
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
  const labels = resource.metadata?.labels as Record<string, string>;
  assert.equal(labels["atlas.zhejianglab.org/track-caller"], "assets");
  assert.equal(labels["atlas.zhejianglab.org/track-task-kind"], "public-coverage");
  assert.equal(labels["astro.zhejianglab.org/task-kind"], "public-coverage");
  const plan = resource.spec?.plan as Record<string, unknown>;
  const sink = (plan.sink as Record<string, unknown>).connector as Record<string, unknown>;
  assert.equal(sink.type, "elasticsearch");
  assert.equal((plan.source as Record<string, unknown>).location && ((plan.source as Record<string, unknown>).location as Record<string, unknown>).prefix, "projects/CSST");
  assert.equal((plan.extraction as Record<string, unknown>).mode, "fits-wcs");
  assert.deepEqual(resource.spec?.credentials, {});
  assert.equal((resource.spec?.scanner as Record<string, unknown>).evidence && ((resource.spec?.scanner as Record<string, unknown>).evidence as Record<string, unknown>).claimName, "atlas-evidence");
  assert.throws(() => buildTaskResource({
    name: "assets-legacy-index",
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
    objectIndex: "legacy_object_index",
  }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /objectIndex is not part/.test(error.message));
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
    metadata: { name: "image-probe", namespace: "warehouse", uid: "old-uid", resourceVersion: "42", generation: 3, managedFields: [{ manager: "operator" }], annotations: { old: "value" }, labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/task-kind": "public-coverage", "astro.zhejianglab.org/task-id": "image-probe", "astro.zhejianglab.org/source-connector": "image-source" } },
    spec: { plan: { scanRunId: "image-probe-run", layer: { layerId: "image-layer", surveyId: "euclid", releaseId: "q1", productId: "vis", modality: "image" }, source: { connector: { type: "oss" }, location: { bucket: "data", prefix: "vis.fits" } }, extraction: { mode: "fits-wcs", outputOrder: 8, catalog: {} }, evidence: { outputPath: "/old/evidence" } } },
    status: { phase: "FAILED" },
  };
  let created: Record<string, unknown> | undefined;
  const kube = {
    get: async () => original,
    getCore: async (plural: string) => plural === "configmaps"
      ? { data: { type: "oss", endpoint: "https://new-object.example", bucket: "data", region: "cn-hangzhou", credentialSecretName: "image-source-credentials" } }
      : { data: {} },
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
  assert.equal(((plan.source as Record<string, unknown>).connector as Record<string, unknown>).endpoint, "https://new-object.example");
  assert.deepEqual((created?.spec as Record<string, unknown>).credentials, { source: { secretName: "image-source-credentials", accessKeyKey: "accessKey", secretKeyKey: "secretKey" } });
});

test("local task submission checks the approved PVC before creating a ScanRequest", async () => {
  let created: Record<string, unknown> | undefined;
  const kube = {
    getCore: async (plural: string) => {
      if (plural === "configmaps") return { data: { type: "local", pvcName: "atlas-source-catalogs", basePath: "cosmos-parameter-prediction" } };
      if (plural === "persistentvolumeclaims") return { metadata: { labels: { "atlas.zhejianglab.org/scanner-source": "true" } }, status: { phase: "Bound" } };
      return null;
    },
    create: async (_plural: string, resource: Record<string, unknown>) => { created = resource; return resource; },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const view = await new AssetsAdmin(config, kube as never).createTask({
    name: "cosmos-catalog-scan",
    layerId: "cosmos-prediction-catalog",
    surveyId: "cosmos",
    releaseId: "prediction-2026",
    product: "COSMOS parameter predictions",
    mode: "catalog-radec",
    coverageRole: "object_presence",
    dataOrigin: "catalog",
    sourceTier: "user_file_derived",
    sourceConnector: "cosmos-source",
    sourcePaths: ["web_predictions_COSMOS_prediction_dataset.csv"],
    raColumn: "ra",
    decColumn: "dec",
  });
  assert.equal(view.name, "cosmos-catalog-scan");
  assert.deepEqual(((created?.spec as Record<string, unknown>).scanner as Record<string, unknown>).sourceVolume, { claimName: "atlas-source-catalogs", mountPath: "/data", subPath: "cosmos-parameter-prediction" });
  assert.deepEqual((created?.spec as Record<string, unknown>).credentials, {});
});

test("local task submission rejects missing or unauthorized source PVCs", async () => {
  const input = {
    name: "cosmos-catalog-scan",
    layerId: "cosmos-prediction-catalog",
    surveyId: "cosmos",
    releaseId: "prediction-2026",
    product: "COSMOS parameter predictions",
    mode: "catalog-radec" as const,
    coverageRole: "object_presence" as const,
    dataOrigin: "catalog" as const,
    sourceTier: "user_file_derived" as const,
    sourceConnector: "cosmos-source",
    sourcePaths: ["prediction.csv"],
    raColumn: "ra",
    decColumn: "dec",
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const missing = { getCore: async (plural: string) => plural === "configmaps" ? { data: { type: "local", pvcName: "atlas-source-catalogs" } } : null };
  await assert.rejects(() => new AssetsAdmin(config, missing as never).createTask(input), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /not found/.test(error.message));
  const unauthorized = { getCore: async (plural: string) => plural === "configmaps" ? { data: { type: "local", pvcName: "atlas-source-catalogs" } } : { metadata: { labels: {} }, status: { phase: "Bound" } } };
  await assert.rejects(() => new AssetsAdmin(config, unauthorized as never).createTask(input), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /not authorized/.test(error.message));
});

test("local task resubmission refreshes the PVC mount without adding credentials", async () => {
  const original = {
    metadata: { name: "cosmos-catalog-scan", namespace: "warehouse", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/task-kind": "public-coverage", "astro.zhejianglab.org/task-id": "cosmos-catalog-scan", "astro.zhejianglab.org/source-connector": "cosmos-source" } },
    spec: { scanner: { evidence: { claimName: "evidence", mountPath: "/evidence" } }, plan: { scanRunId: "old-run", layer: { layerId: "cosmos-layer", surveyId: "cosmos", releaseId: "dr1", productId: "prediction", modality: "catalog" }, source: { connector: { type: "local" }, location: { rootPath: "/data/prediction.csv" } }, extraction: { mode: "catalog-radec", outputOrder: 8, catalog: { raColumn: "ra", decColumn: "dec" } }, evidence: { outputPath: "/evidence/old-run" } } },
    status: { phase: "FAILED" },
  };
  let created: Record<string, unknown> | undefined;
  const kube = {
    get: async () => original,
    getCore: async (plural: string) => plural === "configmaps"
      ? { data: { type: "local", pvcName: "atlas-source-catalogs", basePath: "cosmos-parameter-prediction" } }
      : { metadata: { labels: { "atlas.zhejianglab.org/scanner-source": "true" } }, status: { phase: "Bound" } },
    create: async (_plural: string, resource: Record<string, unknown>) => { created = resource; return resource; },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  await new AssetsAdmin(config, kube as never).resubmitTask("cosmos-catalog-scan");
  const spec = created?.spec as Record<string, unknown>;
  assert.deepEqual(spec.credentials, {});
  assert.deepEqual((spec.scanner as Record<string, unknown>).sourceVolume, { claimName: "atlas-source-catalogs", mountPath: "/data", subPath: "cosmos-parameter-prediction" });
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
