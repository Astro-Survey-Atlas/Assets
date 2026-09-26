import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = path.resolve("scripts/mast_s_region_to_ds9.py");
const OBSERVATION_ID = "90001";
const DATA_INDICES = [
  "obsid",
  "obs_collection",
  "dataproduct_type",
  "dataRights",
  "proposal_id",
  "target_name",
  "instrument_name",
  "filters",
  "s_region",
  "t_min",
  "t_max",
];

function lockedSnapshot(region: unknown): Buffer {
  return Buffer.from(JSON.stringify({
    requestIdentity: { requestName: "synthetic-mast-discovery", requestUid: "synthetic-request-uid" },
    observationSummary: { kind: "mast-hst-observations", candidates: [{ obsid: OBSERVATION_ID }] },
    Tables: [{
      Columns: DATA_INDICES.map((dataIndex) => ({ dataIndex })),
      Rows: [[OBSERVATION_ID, "HST", "image", "PUBLIC", "12440", "UDF-01", "ACS/WFC", "F814W", region, 55907.8, 55907.9]],
    }],
  }));
}

async function runConverter(region: unknown, outputDir: string) {
  const sourceBody = lockedSnapshot(region);
  const sourcePath = path.join(outputDir, "source-snapshot.json");
  await writeFile(sourcePath, sourceBody);
  const sourceSha256 = createHash("sha256").update(sourceBody).digest("hex");
  const sourceRef = `discovery-evidence/observations/synthetic/${sourceSha256}.json`;
  const result = spawnSync("python3", [
    SCRIPT,
    "--input", sourcePath,
    "--output-dir", path.join(outputDir, "converted"),
    "--source-ref", sourceRef,
    "--obsid", OBSERVATION_ID,
    "--survey-id", "hst",
    "--release-id", "hst-mast-observations-2026",
    "--layer-id-prefix", "hst-mast-observation",
    "--product-label-prefix", "MAST",
    "--max-order", "8",
  ], { encoding: "utf8" });
  return { result, sourceBody, sourceSha256, sourceRef, outputDir: path.join(outputDir, "converted") };
}

test("MAST conversion preserves locked ICRS polygons and parameterized HST labels", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "assets-mast-region-convert-"));
  try {
    const { result, sourceBody, sourceSha256, sourceRef, outputDir } = await runConverter(
      "POLYGON 10 1 11 1 11 2 10 2 10 1 POLYGON 12 3 13 3 13 4 12 4 12 3",
      temp,
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(manifest.kind, "mast-hst-observation-region-inputs");
    assert.equal(manifest.sourceSnapshot.sha256, sourceSha256);
    assert.equal(manifest.sourceSnapshot.ref, sourceRef);
    assert.deepEqual(manifest.selectedObservationIds, [OBSERVATION_ID]);
    assert.doesNotMatch(JSON.stringify(manifest), /COSMOS/);

    const files = (await readdir(outputDir)).sort();
    assert.deepEqual(files, ["input-manifest.json", "obs-90001.lock.json", "obs-90001.reg"]);
    const region = await readFile(path.join(outputDir, "obs-90001.reg"), "utf8");
    assert.equal(region, [
      "# Region file format: DS9 version 4.1",
      "icrs",
      `# MAST CAOM observation ${OBSERVATION_ID}`,
      "polygon(10,1,11,1,11,2,10,2,10,1)",
      "polygon(12,3,13,3,13,4,12,4,12,3)",
      "",
    ].join("\n"));

    const lock = JSON.parse(await readFile(path.join(outputDir, "obs-90001.lock.json"), "utf8")) as Record<string, any>;
    assert.equal(lock.surveyId, "hst");
    assert.equal(lock.releaseId, "hst-mast-observations-2026");
    assert.equal(lock.layerId, `hst-mast-observation-${OBSERVATION_ID}`);
    assert.equal(lock.product, `MAST ACS/WFC F814W observation ${OBSERVATION_ID}`);
    assert.equal(lock.coordinateFrame, "ICRS");
    assert.equal(lock.ordering, "NESTED");
    assert.equal(lock.recipe.precision, "estimated");
    assert.equal(lock.recipe.completeness, "incomplete");
    assert.match(lock.recipe.completenessDescription, /not a complete HST archive inventory/);
    assert.equal(lock.recipe.scienceFileScan, "not-scanned");
    assert.equal(lock.snapshot.sourceSnapshotSha256, sourceSha256);
    assert.equal(lock.snapshot.sha256, createHash("sha256").update(region).digest("hex"));
    assert.equal(lock.snapshot.sizeBytes, Buffer.byteLength(region));
    assert.equal(manifest.observations[0].polygonCount, 2);
    assert.equal(manifest.observations[0].layerId, lock.layerId);
    assert.equal(manifest.observations[0].product, lock.product);
    assert.equal(manifest.observations[0].sourceSnapshot.sha256, sourceSha256);
    assert.equal(manifest.observations[0].regionInput.sha256, lock.snapshot.sha256);
    assert.equal(sourceBody.length, lock.snapshot.sourceSnapshotSizeBytes);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("MAST conversion rejects absent and unsupported s_region geometry", async () => {
  for (const [region, error] of [
    [null, /Unsupported s_region token: None/],
    ["", /s_region contains no POLYGON geometry/],
    ["CIRCLE 10 1 0.1", /Unsupported s_region token: CIRCLE/],
  ] as const) {
    const temp = await mkdtemp(path.join(os.tmpdir(), "assets-mast-region-reject-"));
    try {
      const { result, outputDir } = await runConverter(region, temp);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, error);
      assert.deepEqual((await readdir(outputDir)).filter((name) => name.endsWith(".reg") || name.endsWith(".lock.json")), []);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
});

test("MAST conversion rejects unsafe observation identifiers and incompatible survey identity", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "assets-mast-region-identity-"));
  try {
    const sourcePath = path.join(temp, "source-snapshot.json");
    await writeFile(sourcePath, lockedSnapshot("POLYGON 10 1 11 1 11 2 10 2 10 1"));
    const args = [
      SCRIPT,
      "--input", sourcePath,
      "--output-dir", path.join(temp, "converted"),
      "--source-ref", "discovery-evidence/observations/synthetic/snapshot.json",
      "--obsid", OBSERVATION_ID,
      "--survey-id", "cosmos",
      "--release-id", "hst-mast-observations-2026",
      "--layer-id-prefix", "hst-mast-observation",
      "--product-label-prefix", "MAST",
      "--max-order", "8",
    ];
    const result = spawnSync("python3", args, { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /survey-id must be hst/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("MOC-Core builds the locked DS9 region with estimated HST provenance", { skip: !process.env.ASSETS_MOC_CORE_REGIONS_TEST_IMAGE }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "assets-mast-core-regions-"));
  try {
    const { result: conversion, outputDir: evidenceDir } = await runConverter(
      "POLYGON 10 1 11 1 11 2 10 2 10 1",
      temp,
    );
    assert.equal(conversion.status, 0, conversion.stderr);
    const outputDir = path.join(temp, "core-output");
    await mkdir(outputDir);
    const worker = path.resolve("scripts/moc_build_worker.py");
    const image = process.env.ASSETS_MOC_CORE_REGIONS_TEST_IMAGE!;
    const build = spawnSync("podman", [
      "run", "--network", "none", "--rm", "--user", "0:0",
      "-v", `${worker}:/tmp/moc_build_worker.py:ro`,
      "-v", `${evidenceDir}:/evidence:ro`,
      "-v", `${outputDir}:/output:rw`,
      image,
      "python3", "/tmp/moc_build_worker.py", "build-regions",
      "--spec", "/evidence/obs-90001.lock.json",
      "--output", "/output",
    ], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const output = JSON.parse(build.stdout) as Record<string, any>;
    assert.equal(output.valid, true);
    assert.ok(output.cells > 0);
    assert.equal(output.maxOrder, 8);
    assert.ok(output.availableOrders.includes(8));
    const statistics = JSON.parse(await readFile(path.join(outputDir, "statistics.json"), "utf8")) as Record<string, any>;
    const provenance = JSON.parse(await readFile(path.join(outputDir, "provenance.json"), "utf8")) as Record<string, any>;
    assert.equal(statistics.maxOrder, 8);
    assert.equal(statistics.mocSha256, output.moc.sha256);
    assert.equal(provenance.recipe.observationId, OBSERVATION_ID);
    assert.equal(provenance.recipe.precision, "estimated");
    assert.equal(provenance.recipe.completeness, "incomplete");
    assert.equal(provenance.recipe.scienceFileScan, "not-scanned");
    assert.equal(provenance.input.path, "obs-90001.reg");
    assert.equal(provenance.outputs.moc.sha256, output.moc.sha256);

    await writeFile(path.join(evidenceDir, "obs-90001.reg"), "# changed after lock\n");
    const changedOutput = path.join(temp, "changed-output");
    await mkdir(changedOutput);
    const rejected = spawnSync("podman", [
      "run", "--network", "none", "--rm", "--user", "0:0",
      "-v", `${worker}:/tmp/moc_build_worker.py:ro`,
      "-v", `${evidenceDir}:/evidence:ro`,
      "-v", `${changedOutput}:/output:rw`,
      image,
      "python3", "/tmp/moc_build_worker.py", "build-regions",
      "--spec", "/evidence/obs-90001.lock.json",
      "--output", "/output",
    ], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Locked snapshot SHA-256 does not match the local input/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
