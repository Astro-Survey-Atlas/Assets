import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { FilesystemArtifactStore } from "../server/artifact-store.js";
import { MAST_HST_DISCOVERY_POLICY, type MastHstObservationQuery } from "../server/moc-discovery.js";
import { locateMastHstConverterScript } from "../server/mast-hst-import.js";
import { MocBuildService, MocBuildStore } from "../server/moc-build.js";
import { decodeNativeMoc, sha256 } from "../server/native-moc.js";
import { ProductStore } from "../server/products.js";
import type { KubernetesResource } from "../server/admin.js";

const OBSID = "90001";
const REQUEST = { namespace: "atlas-warehouse", name: "hst-import-fixture", uid: "hst-request-uid-001" };
const QUERY: MastHstObservationQuery = {
  coordinateFrame: "ICRS",
  cone: { raDeg: 10.5, decDeg: 1.5, radiusDeg: 0.2 },
  scope: { ordering: "NESTED", order: 8, cells: [163327], q1MocSha256: "a".repeat(64), hstMocSha256: "b".repeat(64) },
};
const COLUMNS = [
  "obsid", "obs_collection", "dataproduct_type", "dataRights", "proposal_id", "target_name",
  "instrument_name", "filters", "s_region", "t_min", "t_max",
];

function mastSnapshot(): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: "mast-hst-observations",
    request: REQUEST,
    observationQuery: QUERY,
    result: { candidateCount: 1, truncated: false, queryExhausted: true },
    source: { collection: "HST", dataproductType: "image", dataRights: "PUBLIC" },
    Tables: [{
      Columns: COLUMNS.map((dataIndex) => ({ dataIndex })),
      Rows: [[OBSID, "HST", "image", "PUBLIC", "12440", "UDF-01", "ACS/WFC", "F814W", "POLYGON 10 1 11 1 11 2 10 2 10 1", 55907.8, 55907.9]],
    }],
  }));
}

function discoveryResource(snapshot: Buffer): KubernetesResource {
  const snapshotSha = sha256(snapshot);
  return {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: {
      ...REQUEST,
      labels: {
        "app.kubernetes.io/managed-by": "astro-survey-atlas-assets",
        "astro.zhejianglab.org/resource-kind": "moc-discovery",
      },
    },
    spec: { policyRef: MAST_HST_DISCOVERY_POLICY, query: { observationQuery: QUERY } },
    status: {
      phase: "SUCCEEDED",
      observationSummary: {
        kind: "mast-hst-observations",
        request: REQUEST,
        candidates: [{ obsid: OBSID, instrument: "ACS/WFC", filters: "F814W" }],
        candidateCount: 1,
        truncated: false,
        queryExhausted: true,
        snapshot: {
          objectKey: `discovery-evidence/observations/${REQUEST.namespace}/${REQUEST.name}/${REQUEST.uid}/${snapshotSha}.json`,
          sha256: snapshotSha,
          sizeBytes: snapshot.length,
        },
      },
    },
  };
}

async function initializeCatalogRoot(root: string): Promise<void> {
  const surveys = path.join(root, "src/surveys");
  const layers = path.join(root, "src/layers");
  await mkdir(surveys, { recursive: true });
  await mkdir(layers, { recursive: true });
  await writeFile(path.join(surveys, "survey-catalog.json"), JSON.stringify({ schemaVersion: 1, surveys: [] }));
  await writeFile(path.join(layers, "layer-registry.json"), JSON.stringify({ schemaVersion: 1, layers: [] }));
}

function regionBuildRunner(image: string) {
  return {
    validate: async () => ({ valid: true }),
    build: async () => ({}),
    buildRegions: async (specPath: string, outputDir: string) => {
      const worker = path.resolve("scripts/moc_build_worker.py");
      const result = spawnSync("podman", [
        "run", "--network", "none", "--rm", "--user", "0:0",
        "-v", `${worker}:/tmp/moc_build_worker.py:ro`,
        "-v", `${path.dirname(specPath)}:/evidence:ro`,
        "-v", `${outputDir}:/output:rw`,
        image,
        "python3", "/tmp/moc_build_worker.py", "build-regions",
        "--spec", `/evidence/${path.basename(specPath)}`,
        "--output", "/output",
      ], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    },
  };
}

test("compiled HST importer locates its converter in the final app image layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-hst-compiled-layout-"));
  try {
    const moduleFile = path.join(root, "app", "dist", "server", "mast-hst-import.js");
    const converter = path.join(root, "app", "scripts", "mast_s_region_to_ds9.py");
    await mkdir(path.dirname(moduleFile), { recursive: true });
    await mkdir(path.dirname(converter), { recursive: true });
    await writeFile(moduleFile, "");
    await writeFile(converter, "");
    assert.equal(await locateMastHstConverterScript(pathToFileURL(moduleFile).href), converter);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HST importer stages a frozen public observation through compiled code and offline MOC-Core", {
  skip: !process.env.ASSETS_MOC_CORE_REGIONS_TEST_IMAGE,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-hst-import-happy-path-"));
  const evidenceRoot = path.join(root, "evidence");
  const contentRoot = path.join(root, "content");
  const catalogRoot = path.join(root, "catalog");
  const artifactRoot = path.join(root, "warehouse-artifacts");
  try {
    await Promise.all([evidenceRoot, contentRoot, artifactRoot].map((directory) => mkdir(directory, { recursive: true })));
    await initializeCatalogRoot(catalogRoot);
    const snapshot = mastSnapshot();
    const snapshotSha = sha256(snapshot);
    const objectKey = `discovery-evidence/observations/${REQUEST.namespace}/${REQUEST.name}/${REQUEST.uid}/${snapshotSha}.json`;
    const artifactStore = new FilesystemArtifactStore(artifactRoot);
    await artifactStore.putImmutable(objectKey, snapshot, { contentType: "application/json" });

    const products = new ProductStore(undefined, contentRoot);
    await products.initialize(catalogRoot);
    const builds = new MocBuildStore(contentRoot, undefined, evidenceRoot);
    const buildService = new MocBuildService({
      store: builds,
      evidenceRoot,
      runner: regionBuildRunner(process.env.ASSETS_MOC_CORE_REGIONS_TEST_IMAGE!),
    });
    const resource = discoveryResource(snapshot);
    const modulePath = path.resolve("dist/server/mast-hst-import.js");
    let importObservation = (await import("../server/mast-hst-import.js")).importMastHstObservation;
    try {
      await lstat(modulePath);
      importObservation = (await import(pathToFileURL(modulePath).href)).importMastHstObservation;
    } catch { /* source import remains available when the server build has not run */ }
    const imported = await importObservation({
      resource,
      candidateId: OBSID,
      artifactStore,
      evidenceRoot,
      products,
      builds,
      buildService,
    });

    assert.equal(imported.request.phase, "STAGED");
    assert.equal(imported.request.provider, "evidence");
    assert.equal(imported.request.candidateId, OBSID);
    assert.equal(imported.request.publishedAt, undefined);
    assert.equal(imported.product.published, null);
    assert.equal(imported.product.draft.coverageEvidence?.evidenceKind, "observation-footprint");
    assert.equal(imported.product.draft.coverageEvidence?.sourceSnapshotSha256, snapshotSha);
    assert.equal(imported.product.draft.coverageEvidence?.precision, "estimated");
    assert.equal(imported.product.draft.coverageEvidence?.completeness, "incomplete");
    assert.equal(imported.product.draft.coverageEvidence?.scienceFileScan, "not-scanned");
    assert.equal(imported.request.outputs?.maxOrder, 10);
    assert.ok((imported.request.outputs?.cellCount ?? 0) > 0);
    await buildService.verifyOutputs(imported.request.name);
    const mocPath = path.join(evidenceRoot, imported.request.outputs!.moc!.ref);
    const moc = decodeNativeMoc(await readFile(mocPath));
    assert.equal(moc.sha256, imported.request.outputs!.moc!.sha256);
    assert.deepEqual(imported.request.outputs?.availableOrders, moc.availableOrders);
    assert.equal(imported.request.outputs?.maxOrder, moc.maxOrder);
    assert.equal(moc.cells.length, imported.request.outputs!.cellCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
