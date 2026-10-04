import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorView, CoverageTaskView } from "../server/admin.js";
import type { DownloadPlanMatch, ScanScopeSummary, WarehouseLayerSnapshot } from "../server/evidence-store.js";
import { scannedFileConnectors, withWarehouseConnectorEvidence, type WarehouseConnectorContext } from "../server/warehouse-source-evidence.js";

const snapshot: WarehouseLayerSnapshot = {
  layerId: "euclid-q1-vis", surveyId: "euclid", releaseId: "euclid-q1", productId: "vis-product",
  state: "ACTIVE", scanRunId: "run-current", scanRunIds: ["run-current", "run-old"],
  availableOrders: [8], fileCount: 3, coverageCount: 9, errorCount: 0,
};
const task: CoverageTaskView = {
  name: "scan-current", surveyId: "euclid", releaseId: "euclid-q1", productId: "vis-product",
  sourceConnector: "euclid-mirror", sourcePaths: ["oss://example-bucket/q1/"], tags: [],
  status: { phase: "SUCCEEDED", runId: "run-current" },
};
const connector: ConnectorView = { name: "euclid-mirror", type: "oss", phase: "NOT_CHECKED", iconUrl: "/api/v1/connector-icons/custom" };
const context: WarehouseConnectorContext = { tasks: [task], batches: [], connectors: [connector] };
const layers = new Map([[snapshot.layerId, snapshot]]);
const match: DownloadPlanMatch = { layerId: snapshot.layerId, scanRunId: "run-current", order: 8, ipix: 42, precision: "estimated" };
const identity = { name: connector.name, type: "oss", iconUrl: connector.iconUrl, identityBasis: "scan-run" };

test("an exact scan run propagates the configured Connector identity and icon without its connection settings", () => {
  const enriched = withWarehouseConnectorEvidence(snapshot, context);
  assert.deepEqual(enriched.connectorEvidence, [{ ...identity, matchingScanRuns: 1 }]);
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [match] }, context, layers, []), [identity]);
  assert.equal(JSON.stringify(enriched).includes("example-bucket"), false);
});

test("a layer's other run, mismatched product, and URI alone do not identify a file's Connector", () => {
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [{ ...match, scanRunId: "run-old" }] }, context, layers, []), []);
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [match] }, { ...context, tasks: [{ ...task, productId: "other-product" }] }, layers, []), []);
  assert.deepEqual(scannedFileConnectors({}, context, layers, []), []);
});

const scope: ScanScopeSummary = { layerId: "batch-vis", publishedLayerId: snapshot.layerId, scopeId: "q1-image-scope", scopeSnapshotSha256: "frozen-scope-sha", expectedPartitions: 352, committedPartitions: 352, completeness: "complete" };
const batch = {
  name: "q1-images", sourceConnector: connector.name,
  rules: [{ name: "vis", layer: { ...snapshot, layerId: scope.layerId } }],
  status: { scope: { rules: [{ name: "vis", layerId: scope.layerId, scopeId: scope.scopeId, scopeSnapshotSha256: scope.scopeSnapshotSha256, expectedPartitionCount: 352 }] } },
};
const batchContext: WarehouseConnectorContext = { ...context, tasks: [], batches: [batch] };
const partitionMatch = { ...match, scanRunId: "partition-run", evidenceLayerId: scope.layerId, scopeId: scope.scopeId, observationLayerId: "partition-version" };

test("a retained batch's locked scope resolves a partition file even without a per-run ScanRequest", () => {
  const expected = { ...identity, identityBasis: "scan-scope" };
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [partitionMatch] }, batchContext, layers, [scope]), [expected]);
  assert.deepEqual(withWarehouseConnectorEvidence({ ...snapshot, scanScope: scope, scanRunCount: 352 }, batchContext).connectorEvidence, [{ ...expected, matchingScanRuns: 352 }]);
});

test("scope identity requires its hash, evidence layer, product and partition count to agree", () => {
  for (const invalidScope of [
    { ...scope, scopeSnapshotSha256: "other-sha" }, { ...scope, scopeId: "other-scope" },
    { ...scope, layerId: "other-layer" }, { ...scope, expectedPartitions: 353 },
  ]) assert.deepEqual(scannedFileConnectors({ matchingCoverage: [partitionMatch] }, batchContext, layers, [invalidScope]), []);
  const otherLayer = new Map([[snapshot.layerId, { ...snapshot, surveyId: "desi" }]]);
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [partitionMatch] }, batchContext, otherLayer, [scope]), []);
});

test("conflicting provenance is not branded; different confirmed observations can preserve multiple Connectors", () => {
  const conflicting = { ...batch, sourceConnector: "other-mirror" };
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [partitionMatch] }, { ...batchContext, batches: [batch, conflicting] }, layers, [scope]), []);
  const otherTask = { ...task, sourceConnector: "other-mirror", status: { phase: "SUCCEEDED", runId: "other-run" } };
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [match, { ...match, scanRunId: "other-run" }] }, { ...context, tasks: [task, otherTask] }, layers, []), [identity, { name: "other-mirror", type: "unknown", identityBasis: "scan-run" }]);
});

test("a removed Connector retains its proven name while a current configuration can supply a new icon", () => {
  assert.deepEqual(scannedFileConnectors({ matchingCoverage: [match] }, { ...context, connectors: [] }, layers, []), [{ name: connector.name, type: "unknown", identityBasis: "scan-run" }]);
  const changed = { ...context, connectors: [{ ...connector, iconUrl: "https://example.org/new.png" }] };
  assert.equal(scannedFileConnectors({ matchingCoverage: [match] }, changed, layers, [])[0]?.iconUrl, "https://example.org/new.png");
});
