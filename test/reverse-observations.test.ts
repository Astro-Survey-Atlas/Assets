import assert from "node:assert/strict";
import test from "node:test";

import { buildDownloadPlan, type CoverageEdge } from "../server/evidence-store.js";
import { mergeWarehouseSourceFiles, warehouseLogicalLayersForSource } from "../server/reverse-observations.js";

test("reverse source merge preserves same-file candidate observations and ordinary FileAssets", () => {
  const candidateA = { layer_id: "candidate-a", scan_run_id: "run-a", file_id: "shared-file", file_name: "tile-a.fits", source_uri: "oss://survey/tile-a.fits", size_bytes: 42 };
  const candidateB = { layer_id: "candidate-b", scan_run_id: "run-b", file_id: "shared-file", file_name: "tile-b.fits", source_uri: "oss://survey/tile-b.fits", size_bytes: 84 };
  const ordinaryFile = { file_id: "ordinary-file", file_name: "catalog.csv", source_uri: "oss://survey/catalog.csv", size_bytes: 12 };
  const merged = mergeWarehouseSourceFiles([
    ["logical-a", { sourceFiles: [candidateA, ordinaryFile] }],
    ["logical-b", { sourceFiles: [candidateB, { ...ordinaryFile }] }],
  ]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.filter((entry) => entry.source.file_id === "shared-file").map((entry) => entry.source.layer_id).sort(), ["candidate-a", "candidate-b"]);
  assert.equal(merged.filter((entry) => entry.source.file_id === "ordinary-file").length, 1);
  assert.equal("layer_id" in merged.find((entry) => entry.source.file_id === "ordinary-file")!.source, false);

  const fileEdges = [
    { layerId: "logical-a", observationLayerId: "candidate-a", sourceFileId: "shared-file" },
    { layerId: "logical-b", observationLayerId: "candidate-b", sourceFileId: "shared-file" },
    { layerId: "ordinary-layer", sourceFileId: "ordinary-file" },
  ];
  assert.deepEqual(warehouseLogicalLayersForSource(candidateA, fileEdges, "wrong-fallback"), ["logical-a"]);
  assert.deepEqual(warehouseLogicalLayersForSource(candidateB, fileEdges, "wrong-fallback"), ["logical-b"]);
  assert.deepEqual(warehouseLogicalLayersForSource(ordinaryFile, fileEdges, "wrong-fallback"), ["ordinary-layer"]);

  const edge = (input: Partial<CoverageEdge> & Pick<CoverageEdge, "edgeId" | "layerId" | "sourceFileId" | "order" | "ipix">): CoverageEdge => ({
    ...input,
    precision: "estimated",
  });
  const plan = buildDownloadPlan({
    edges: [
      edge({ edgeId: "edge-a", layerId: "logical-a", observationLayerId: "candidate-a", scanRunId: "run-a", sourceFileId: "shared-file", order: 8, ipix: 1 }),
      edge({ edgeId: "edge-b", layerId: "logical-b", observationLayerId: "candidate-b", scanRunId: "run-b", sourceFileId: "shared-file", order: 8, ipix: 2 }),
      edge({ edgeId: "edge-ordinary", layerId: "ordinary-layer", sourceFileId: "ordinary-file", order: 8, ipix: 3 }),
    ],
    sourceFiles: merged.map((entry) => entry.source),
    truncated: false,
  });
  const shared = plan.files.find((file) => file.fileId === "shared-file");
  assert.equal(shared?.metadataState, "complete");
  assert.deepEqual(shared?.observations?.map((observation) => observation.layerId).sort(), ["logical-a", "logical-b"]);
  assert.equal(plan.files.find((file) => file.fileId === "ordinary-file")?.metadataState, "complete");
});
