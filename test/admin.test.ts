import assert from "node:assert/strict";
import test from "node:test";

import { AdminHttpError, buildConnectorResource, buildConnectorResources, buildTaskResource } from "../server/admin.js";

test("connector resources keep fields specific to their selected type", () => {
  const local = buildConnectorResources({ name: "assets-local", type: "local", localPath: "/data/coverage-inputs" }, "warehouse");
  assert.deepEqual(local.dataSource.spec, { type: "local", mount: { pvcName: "assets-local-pvc" } });
  assert.equal(local.persistentVolume?.spec?.hostPath && (local.persistentVolume.spec.hostPath as Record<string, unknown>).path, "/data/coverage-inputs");
  assert.equal(local.persistentVolumeClaim?.metadata?.name, "assets-local-pvc");
  const objectStorage = buildConnectorResources({ name: "assets-s3", type: "s3", endpoint: "https://object.example", bucket: "data", accessKey: "key", secretKey: "secret" }, "warehouse");
  assert.deepEqual(objectStorage.dataSource.spec, { type: "s3", endpoint: "https://object.example", bucket: "data", credentialSecretRef: { name: "assets-s3-credentials" } });
  assert.deepEqual(objectStorage.secret?.stringData, { "access-key": "key", "secret-key": "secret" });
  assert.throws(() => buildConnectorResource({ name: "assets-invalid-local", type: "local", localPath: "/data/local", endpoint: "https://object.example" }, "warehouse"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);
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
    sourcePaths: ["oss://data-and-computing/projects/CSST"],
  }, "warehouse");

  const userProperties = resource.spec?.userProperties as Record<string, string>;
  assert.equal(userProperties.fileIndex, "astro_file_index_v1");
  assert.equal(userProperties.coverageIndex, "astro_coverage_index_v1");
  assert.equal(userProperties.objectIndex, "astro_object_index_v1");
  assert.equal(userProperties.fileNamePattern, undefined);
  assert.deepEqual(resource.spec?.pathPatterns, {});
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

test("coverage task basename patterns use the deployed CRD-compatible user properties", () => {
  const resource = buildTaskResource({
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
  }, "warehouse");

  const userProperties = resource.spec?.userProperties as Record<string, string>;
  assert.equal(userProperties.fileNamePattern, "^CSST_.*\\\\.fits$");
  assert.equal(resource.spec?.fileNamePattern, undefined);
});
