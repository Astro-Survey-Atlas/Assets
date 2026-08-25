import assert from "node:assert/strict";
import test from "node:test";

import { AdminHttpError, buildConnectorResource, buildConnectorResources, buildTaskResource } from "../server/admin.js";

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
