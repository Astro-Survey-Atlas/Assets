import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError, KubernetesApiError, AssetsAdmin, buildConnectorResource, buildConnectorResources, buildTaskResource, connectorView, mocDiscoveryState, taskView, type ObjectStorageProbeInput } from "../server/admin.js";
import { ConnectorInventoryStateStore, ConnectorProbeStateStore } from "../server/connector-state.js";
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

test("Warehouse AstroDataSource connectors are visible alongside Assets ConfigMaps", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const dataSource = {
    apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
    kind: "AstroDataSource",
    metadata: { name: "warehouse-oss", namespace: "warehouse", creationTimestamp: "2026-09-13T00:00:00.000Z" },
    spec: { type: "oss", endpoint: "https://oss.example", bucket: "catalog", prefix: "dr1", credentialSecretRef: { name: "warehouse-oss-secret" } },
    status: { phase: "Ready", message: "DataSource configuration is valid" },
  };
  const connectors = await new AssetsAdmin(config, {
    listCore: async () => [],
    listDataSources: async () => [dataSource],
  } as never).listConnectors();
  assert.equal(connectors.length, 1);
  assert.equal(connectors[0]?.name, "warehouse-oss");
  assert.equal(connectors[0]?.resourceKind, "AstroDataSource");
  assert.equal(connectors[0]?.configurationPhase, "Ready");
  assert.equal(connectors[0]?.bucket, "catalog");
  assert.equal(connectors[0]?.prefix, "dr1");
});

test("Warehouse AstroDataSource connectors use their credentialSecretRef for probes", async () => {
  let received: ObjectStorageProbeInput | undefined;
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const dataSource = {
    apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
    kind: "AstroDataSource",
    metadata: { name: "warehouse-s3" },
    spec: { type: "s3", endpoint: "https://s3.example", bucket: "data", credentialSecretRef: { name: "warehouse-s3-secret" } },
    status: { phase: "Ready" },
  };
  const kube = {
    getCore: async (plural: string) => plural === "configmaps" ? null : { data: { accessKey: Buffer.from("key").toString("base64"), secretKey: Buffer.from("secret").toString("base64") } },
    getDataSource: async () => dataSource,
  };
  const result = await new AssetsAdmin(config, kube as never, { probeObjectStorage: async (input: ObjectStorageProbeInput) => { received = input; } }).probeConnector("warehouse-s3");
  assert.equal(result.phase, "READY");
  assert.equal(result.resourceKind, "AstroDataSource");
  assert.equal(received?.bucket, "data");
  assert.equal(received?.accessKeyId, "key");
  assert.equal(received?.secretAccessKey, "secret");
});

test("Warehouse AstroDataSource probes accept the native access-key and secret-key Secret fields", async () => {
  let received: ObjectStorageProbeInput | undefined;
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const dataSource = {
    apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
    kind: "AstroDataSource",
    metadata: { name: "warehouse-native-s3" },
    spec: { type: "s3", endpoint: "https://s3.example", bucket: "data", credentialSecretRef: { name: "warehouse-native-s3-secret" } },
  };
  const kube = {
    getCore: async (plural: string) => plural === "configmaps" ? null : { data: { "access-key": Buffer.from("native-key").toString("base64"), "secret-key": Buffer.from("native-secret").toString("base64") } },
    getDataSource: async () => dataSource,
  };
  const result = await new AssetsAdmin(config, kube as never, { probeObjectStorage: async (input: ObjectStorageProbeInput) => { received = input; } }).probeConnector("warehouse-native-s3");
  assert.equal(result.phase, "READY");
  assert.equal(received?.accessKeyId, "native-key");
  assert.equal(received?.secretAccessKey, "native-secret");
});

test("connector probe state survives a new admin process and excludes credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-connector-state-"));
  const snapshots: unknown[] = [];
  const sink = { enqueue: async (_namespace: string, state: unknown) => { snapshots.push(state); return {} as never; } };
  const first = new ConnectorProbeStateStore(root, sink);
  await first.set("source", { phase: "READY", message: "read-only probe", checkedAt: "2026-09-13T00:00:00.000Z" });
  const second = new ConnectorProbeStateStore(root, sink);
  assert.deepEqual(await second.get("source"), { phase: "READY", message: "read-only probe", checkedAt: "2026-09-13T00:00:00.000Z" });
  const persisted = await readFile(path.join(root, "connector-probes-v1.json"), "utf8");
  assert.doesNotMatch(persisted, /secret|accessKey|secretKey/i);
  assert.equal(snapshots.length, 1);
});

test("persisted connector probes are invalidated when the connector definition changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-connector-fingerprint-"));
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = { metadata: { name: "assets-s3", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-s3-credentials" } };
  const kube = { listCore: async () => [resource], getCore: async (plural: string) => plural === "configmaps" ? resource : { data: { accessKey: Buffer.from("key").toString("base64"), secretKey: Buffer.from("secret").toString("base64") } } };
  const firstStore = new ConnectorProbeStateStore(root);
  await new AssetsAdmin(config, kube as never, { probeObjectStorage: async () => undefined }, firstStore).probeConnector("assets-s3");
  const changed = structuredClone(resource);
  changed.data.endpoint = "https://other.example";
  const second = await new AssetsAdmin(config, { listCore: async () => [changed] } as never, { probeObjectStorage: async () => undefined }, new ConnectorProbeStateStore(root)).listConnectors();
  assert.equal(second[0]?.phase, "NOT_CHECKED");
});

test("persisted connector probes are invalidated when the credential Secret rotates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-connector-secret-rotation-"));
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = { metadata: { name: "assets-s3", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-s3-credentials" } };
  const secret = { metadata: { name: "assets-s3-credentials", resourceVersion: "1" }, data: { accessKey: Buffer.from("key").toString("base64"), secretKey: Buffer.from("secret").toString("base64") } };
  const kube = { listCore: async () => [resource], getCore: async (plural: string) => plural === "configmaps" ? resource : secret };
  try {
    const state = new ConnectorProbeStateStore(root);
    await new AssetsAdmin(config, kube as never, { probeObjectStorage: async () => undefined }, state).probeConnector("assets-s3");
    secret.metadata.resourceVersion = "2";
    const listed = await new AssetsAdmin(config, kube as never, { probeObjectStorage: async () => undefined }, new ConnectorProbeStateStore(root)).listConnectors();
    assert.equal(listed[0]?.phase, "NOT_CHECKED");
    assert.equal(listed[0]?.checkedAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connector probe state restores from the authority snapshot when the local file is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-connector-restore-"));
  const store = new ConnectorProbeStateStore(root, {
    enqueue: async () => ({}) as never,
    restore: async (namespace: string) => namespace === "connector-probes" ? { pointer: {} as never, state: { schemaVersion: 1, probes: { source: { phase: "ERROR", message: "restored", checkedAt: "2026-09-13T00:00:00.000Z" } } } } : null,
  });
  assert.deepEqual(await store.get("source"), { phase: "ERROR", message: "restored", checkedAt: "2026-09-13T00:00:00.000Z" });
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

test("object connector inventory accumulates pages and survives a fresh admin process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-connector-inventory-"));
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = { metadata: { name: "assets-s3", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "data", prefix: "dr1", credentialSecretName: "assets-s3-credentials" } };
  const kube = { getCore: async (plural: string) => plural === "configmaps" ? resource : { data: { accessKey: Buffer.from("key").toString("base64"), secretKey: Buffer.from("secret").toString("base64") } }, listCore: async () => [resource] };
  let page = 0;
  const inventoryClient = {
    inventoryObjectStorage: async (_input: unknown, token?: string) => {
      page += 1;
      if (!token) return { objects: [{ sizeBytes: 10 }, { sizeBytes: 20 }], nextToken: "page-2", truncated: true };
      return { objects: [{ sizeBytes: 30 }], truncated: false };
    },
  };
  try {
    const state = new ConnectorInventoryStateStore(root);
    const admin = new AssetsAdmin(config, kube as never, inventoryClient as never, undefined, state);
    const first = await admin.inventoryConnector("assets-s3");
    assert.equal(first.state, "running");
    assert.equal(first.processedObjects, 2);
    assert.equal(first.denominatorKnown, false);
    const second = await admin.inventoryConnector("assets-s3");
    assert.equal(second.state, "complete");
    assert.equal(second.totalObjectCount, 3);
    assert.equal(second.totalBytes, 60);
    const restarted = new AssetsAdmin(config, kube as never, inventoryClient as never, undefined, new ConnectorInventoryStateStore(root));
    const listed = await restarted.listConnectors();
    assert.equal(listed[0]?.inventory?.state, "complete");
    assert.equal(listed[0]?.inventory?.totalObjectCount, 3);
    assert.equal(page, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local connector inventory remains explicitly unknown because PVC contents belong to Warehouse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-local-inventory-"));
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = { metadata: { name: "assets-local", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "local", pvcName: "atlas-source-catalogs", basePath: "dr1" } };
  try {
    const state = new ConnectorInventoryStateStore(root);
    const admin = new AssetsAdmin(config, { getCore: async () => resource } as never, undefined, undefined, state);
    const result = await admin.inventoryConnector("assets-local");
    assert.equal(result.state, "unknown");
    assert.equal(result.denominatorKnown, false);
    assert.match(result.note ?? "", /Warehouse/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("object inventory marks a provider-truncated page partial instead of restarting with duplicate counts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-connector-inventory-partial-"));
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = { metadata: { name: "assets-s3", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-s3-credentials" } };
  const kube = { getCore: async (plural: string) => plural === "configmaps" ? resource : { data: { accessKey: Buffer.from("key").toString("base64"), secretKey: Buffer.from("secret").toString("base64") } }, listCore: async () => [resource] };
  let calls = 0;
  const inventoryClient = { inventoryObjectStorage: async () => { calls += 1; return { objects: [{ sizeBytes: 10 }], truncated: true }; } };
  try {
    const state = new ConnectorInventoryStateStore(root);
    const admin = new AssetsAdmin(config, kube as never, inventoryClient as never, undefined, state);
    const first = await admin.inventoryConnector("assets-s3");
    assert.equal(first.state, "partial");
    assert.equal(first.denominatorKnown, false);
    assert.match(first.note ?? "", /continuation token/);
    const second = await admin.inventoryConnector("assets-s3");
    assert.equal(second.state, "partial");
    assert.equal(second.processedObjects, 1, "a new pass must not reuse the previous partial counter");
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed inventory retains a provider cursor for an explicit retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-connector-inventory-retry-"));
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = { metadata: { name: "assets-s3", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretName: "assets-s3-credentials" } };
  const kube = { getCore: async (plural: string) => plural === "configmaps" ? resource : { data: { accessKey: Buffer.from("key").toString("base64"), secretKey: Buffer.from("secret").toString("base64") } } };
  let calls = 0;
  const inventoryClient = { inventoryObjectStorage: async (_input: unknown, token?: string) => { calls += 1; if (!token) return { objects: [{ sizeBytes: 10 }], nextToken: "page-2", truncated: true }; if (calls === 2) throw new Error("temporary outage"); return { objects: [{ sizeBytes: 20 }], truncated: false }; } };
  try {
    const state = new ConnectorInventoryStateStore(root);
    const admin = new AssetsAdmin(config, kube as never, inventoryClient as never, undefined, state);
    assert.equal((await admin.inventoryConnector("assets-s3")).state, "running");
    assert.equal((await admin.inventoryConnector("assets-s3")).state, "failed");
    const done = await admin.inventoryConnector("assets-s3");
    assert.equal(done.state, "complete");
    assert.equal(done.totalObjectCount, 2);
    assert.equal(done.totalBytes, 30);
    assert.equal(calls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  assert.equal((plan.layer as Record<string, unknown>).product, undefined);
  assert.equal((resource.spec?.scanner as Record<string, unknown>).backoffLimit, 0);
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
  assert.equal(request.policyRef, "cds-public-moc-v2");
  assert.deepEqual(created?.spec, { query: { surveyName: "Gaia", releaseHint: "DR3" }, policyRef: "cds-public-moc-v2" });
  assert.equal((created?.metadata as Record<string, unknown>).namespace, "atlas-warehouse");
  assert.equal((created?.metadata as Record<string, unknown>).labels && ((created?.metadata as Record<string, unknown>).labels as Record<string, string>)["astro.zhejianglab.org/resource-kind"], "moc-discovery");
});

test("MOC discovery lists stay compact while details expose review summaries", async () => {
  const resource = {
    metadata: { name: "jwst-moc-discovery", annotations: { "assets.atlas.zhejianglab.org/work-ref": JSON.stringify({ key: "product:jwst-dr1", title: "JWST · DR1 · Public MOC", surveyId: "jwst", releaseId: "dr1", productId: "jwst-dr1" }) }, labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "JWST" }, policyRef: "cds-public-moc-v2" },
    status: { phase: "SUCCEEDED", candidateCount: 1, reviewSummary: { schemaVersion: 2, truncated: false, summaryTruncated: false, searchRecordCount: 1, candidates: [{ candidateId: "jwst", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }] } },
  };
  const kube = { list: async () => [resource], get: async () => resource };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const admin = new AssetsAdmin(config, kube as never);

  const list = await admin.listMocDiscoveryRequests();
  const detail = await admin.getMocDiscoveryRequest("jwst-moc-discovery");

  assert.equal(list[0]?.status.reviewSummary, undefined);
  assert.equal(list[0]?.status.discoveryState, "ready");
  assert.equal(detail.surveyId, "jwst");
  assert.equal(detail.releaseId, "dr1");
  assert.equal(detail.productId, "jwst-dr1");
  assert.equal(detail.status.reviewSummary?.candidates[0]?.candidateId, "jwst");
  assert.equal(detail.status.reviewSummary?.candidates[0]?.mocUrl, "https://alasky.cds.unistra.fr/jwst/moc.fits");
  assert.equal(detail.status.discoveryState, "ready");
});

test("MOC views preserve a legitimate zero-result summary separately from a missing summary", async () => {
  const empty = {
    metadata: { name: "empty-moc-discovery", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "Unknown survey" }, policyRef: "cds-public-moc-v2" },
    status: { phase: "SUCCEEDED", candidateCount: 0, reviewSummary: { schemaVersion: 2, truncated: false, summaryTruncated: false, searchRecordCount: 0, candidates: [] } },
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
  assert.equal(emptyView.status.discoveryState, "empty");
  assert.deepEqual(emptyView.status.reviewSummary?.candidates, []);
  assert.equal(emptyView.status.candidateCount, 0);
  assert.equal(legacyView.status.reviewSummaryState, "missing");
  assert.equal(legacyView.status.discoveryState, "incomplete");
  assert.equal(legacyView.status.reviewSummary, undefined);
});

test("MOC discovery state makes Warehouse failures and incomplete summaries explicit", () => {
  assert.equal(mocDiscoveryState({ phase: "FAILED", reason: "ReconcileError" }), "failed");
  assert.equal(mocDiscoveryState({ phase: "RUNNING" }), "running");
  assert.equal(mocDiscoveryState({ phase: "SUCCEEDED", reviewSummary: { schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "roman" }] } }), "ready");
  assert.equal(mocDiscoveryState({ phase: "SUCCEEDED", reviewSummary: { schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [] } }), "empty");
  assert.equal(mocDiscoveryState({ phase: "SUCCEEDED", reviewSummary: { schemaVersion: 2, truncated: true, summaryTruncated: false, candidates: [{ candidateId: "roman" }] } }), "incomplete");
  assert.equal(mocDiscoveryState({ phase: "SUCCEEDED", reviewSummaryState: "missing" }), "incomplete");
});

test("MOC views accept zero-result summaries when Kubernetes omits empty arrays", async () => {
  const resource = {
    metadata: { name: "serialized-empty-moc", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "JWST" }, policyRef: "cds-public-moc-v2" },
    status: { phase: "SUCCEEDED", candidateCount: 0, reviewSummary: { schemaVersion: 2, truncated: false, summaryTruncated: false } },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const admin = new AssetsAdmin(config, { get: async () => resource } as never);

  const view = await admin.getMocDiscoveryRequest(resource.metadata.name);

  assert.equal(view.status.reviewSummaryState, "available");
  assert.deepEqual(view.status.reviewSummary?.candidates, []);
  assert.equal(view.status.reviewSummary?.searchRecordCount, undefined);
});

test("MOC discovery resubmission creates an immutable retry and preserves work context", async () => {
  const original = {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: { name: "jwst-moc-discovery", namespace: "warehouse", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" }, annotations: { "assets.atlas.zhejianglab.org/work-ref": "{\"key\":\"product:jwst-dr1\",\"surveyId\":\"jwst\",\"releaseId\":\"dr1\",\"productId\":\"jwst-dr1\"}" } },
    spec: { query: { surveyName: "JWST", releaseHint: "DR1" }, policyRef: "cds-public-moc-v2" },
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

test("MOC discovery resubmission upgrades legacy v1 intent to a v2 request", async () => {
  const original = {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: { name: "legacy-jwst-moc", namespace: "warehouse", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "JWST", releaseHint: "DR1" }, policyRef: "cds-public-moc-v1" },
    status: { phase: "SUCCEEDED" },
  };
  let created: Record<string, unknown> | undefined;
  const kube = { get: async () => original, create: async (_plural: string, resource: Record<string, unknown>) => { created = resource; return resource; } };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };

  await new AssetsAdmin(config, kube as never).resubmitMocDiscoveryRequest(original.metadata.name);

  assert.deepEqual(created?.spec, { query: { surveyName: "JWST", releaseHint: "DR1" }, policyRef: "cds-public-moc-v2" });
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

test("ScanRequests sourced from a Warehouse AstroDataSource preserve its native credential key names", async () => {
  const dataSource = {
    apiVersion: "org.zhejianglab.astro.metadata/v1alpha1",
    kind: "AstroDataSource",
    metadata: { name: "warehouse-native-s3" },
    spec: { type: "s3", endpoint: "https://s3.example", bucket: "data", credentialSecretRef: { name: "warehouse-native-s3-secret" } },
  };
  let created: Record<string, unknown> | undefined;
  const kube = {
    getCore: async (plural: string) => plural === "configmaps" ? null : { metadata: { name: "warehouse-native-s3-secret" }, data: { "access-key": "a", "secret-key": "b" } },
    getDataSource: async () => dataSource,
    create: async (_plural: string, resource: Record<string, unknown>) => { created = resource; return resource; },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  await new AssetsAdmin(config, kube as never).createTask({
    name: "native-s3-scan",
    layerId: "native-layer",
    surveyId: "gaia",
    releaseId: "dr3",
    product: "Gaia DR3",
    mode: "fits-wcs",
    coverageRole: "footprint_extent",
    dataOrigin: "observed",
    sourceTier: "official_inventory_derived",
    sourceConnector: "warehouse-native-s3",
    sourcePaths: ["s3://data/dr3"],
  });
  assert.deepEqual((created?.spec as Record<string, unknown>).credentials, { source: { secretName: "warehouse-native-s3-secret", accessKeyKey: "access-key", secretKeyKey: "secret-key" } });
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
  assert.equal((plan.layer as Record<string, unknown>).product, undefined);
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
  assert.equal(((spec.plan as Record<string, unknown>).layer as Record<string, unknown>).product, undefined);
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

test("discovery errors survive the Warehouse status projection without leaking raw evidence", async () => {
  const failure = { component: "warehouse-moc-discovery", code: "DiscoveryConnectTimeout", stage: "connect-or-tls", endpoint: "https://alasky.cds.unistra.fr/MocServer/query?token=secret", elapsedMs: 20002, timeoutMs: 20000, bytes: 0, causeChain: ["HttpConnectTimeoutException: HTTP connect timed out"], body: "private evidence" };
  const resource = {
    metadata: { name: "sdss-moc-discovery", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "SDSS" }, policyRef: "cds-public-moc-v2" },
    status: { phase: "FAILED", reason: "DiscoveryConnectTimeout", summary: { failure } },
  };
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const admin = new AssetsAdmin(config, { get: async () => resource, list: async () => [resource] } as never);
  const detail = await admin.getMocDiscoveryRequest("sdss-moc-discovery");
  assert.equal(detail.status.failure?.code, "DiscoveryConnectTimeout");
  assert.equal(detail.status.failure?.endpoint, "https://alasky.cds.unistra.fr/MocServer/query");
  assert.equal(detail.status.failure?.elapsedMs, 20002);
  assert.deepEqual(detail.status.failure?.causeChain, failure.causeChain);
  assert.equal(detail.status.discoveryState, "failed");
  assert.equal(JSON.stringify(detail).includes("private evidence"), false);
  assert.equal(JSON.stringify(detail).includes("token=secret"), false);
  assert.deepEqual((await admin.listMocDiscoveryRequests())[0]?.status.failure, detail.status.failure);
});

test("connector deletion blocks unfinished scans, preserves history and never deletes storage or credentials", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const resource = buildConnectorResources({ name: "old-source", type: "s3", endpoint: "https://object.example", bucket: "data", accessKey: "key", secretKey: "secret" }, "warehouse").configMap;
  const root = await mkdtemp(path.join(os.tmpdir(), "delete-connector-"));
  try {
    const probes = new ConnectorProbeStateStore(root);
    const inventories = new ConnectorInventoryStateStore(root);
    await probes.set("old-source", { phase: "READY", checkedAt: new Date().toISOString() });
    await inventories.set("old-source", { phase: "COMPLETE", updatedAt: new Date().toISOString() });
    const deleted: string[] = [];
    let phase: string | undefined = "RUNNING";
    let fail = false;
    const kube = {
      getCore: async () => resource,
      list: async () => {
        if (fail) throw new Error("status unavailable");
        return [{ metadata: { name: "scan", labels: { "astro.zhejianglab.org/source-connector": "old-source" } }, status: { phase } }];
      },
      deleteCore: async (plural: string, name: string) => { deleted.push(`${plural}/${name}`); },
    };
    const admin = new AssetsAdmin(config, kube as never, undefined, probes, inventories);
    for (phase of ["RUNNING", "PENDING", undefined]) {
      await assert.rejects(admin.deleteConnector("old-source"), (e: unknown) => e instanceof AdminHttpError && e.statusCode === 409);
    }
    fail = true;
    await assert.rejects(admin.deleteConnector("old-source"), /status unavailable/);
    assert.deepEqual(deleted, []);
    fail = false;
    phase = "SUCCEEDED";
    assert.deepEqual(await admin.deleteConnector("old-source"), { deleted: true, name: "old-source" });
    assert.deepEqual(deleted, ["configmaps/old-source"]);
    assert.equal(await new ConnectorProbeStateStore(root).get("old-source"), undefined);
    assert.equal(await new ConnectorInventoryStateStore(root).get("old-source"), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("connector deletion refuses Warehouse-owned resources and unknown names", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const native = { apiVersion: "org.zhejianglab.astro.metadata/v1alpha1", kind: "AstroDataSource", metadata: { name: "native" }, spec: { type: "s3" } };
  let resource: typeof native | null = native;
  const admin = new AssetsAdmin(config, { getCore: async () => null, getDataSource: async () => resource, deleteCore: async () => assert.fail("must not delete") } as never);
  await assert.rejects(admin.deleteConnector("native"), (e: unknown) => e instanceof AdminHttpError && e.statusCode === 409);
  resource = null;
  await assert.rejects(admin.deleteConnector("missing"), (e: unknown) => e instanceof AdminHttpError && e.statusCode === 404);
});


test("recreating a deleted connector leaves historical credentials unchanged", async () => {
  const config = { enabled: true, namespace: "warehouse", adminToken: "token", kubeToken: "token", apiBaseUrl: "https://kube", tokenFile: "", caFile: "", warehouseEsUrl: "http://es", scannerImage: "scanner", evidenceClaimName: "evidence", evidenceMountPath: "/evidence" };
  const created: Array<{ plural: string; resource: ReturnType<typeof buildConnectorResource> }> = [];
  const admin = new AssetsAdmin(config, {
    createCore: async (plural: string, resource: ReturnType<typeof buildConnectorResource>) => {
      if (plural === "secrets" && resource.metadata?.name === "old-source-credentials") throw new KubernetesApiError(409, "exists");
      created.push({ plural, resource: structuredClone(resource) });
      return resource;
    },
    deleteCore: async () => assert.fail("must not delete old credentials"),
  } as never);
  await admin.createConnector({ name: "old-source", type: "s3", endpoint: "https://object.example", bucket: "data", accessKey: "new-key", secretKey: "new-secret" });
  assert.equal(created.length, 2);
  assert.match(created[0]!.resource.metadata!.name!, /^old-source-cred-/);
  assert.equal(created[1]!.resource.data!.credentialSecretName, created[0]!.resource.metadata!.name);
});
