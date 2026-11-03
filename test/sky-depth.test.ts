import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkyDepthInputError, SkyDepthStore, parseSkyDepthQuery } from "../server/sky-depth.js";
import { pixelAt, pixelCenter, prepareObjects, prepareRedshiftObjects, syntheticCatalogue, type DistanceObject, type DistanceReference } from "../src/distance-feasibility.js";
import { readFile } from "node:fs/promises";

const referencePath = new URL("../fixtures/distance-prototype/planck18-reference.json", import.meta.url).pathname;
const reference = JSON.parse(await readFile(referencePath, "utf8")) as DistanceReference;
const baseline = { ...syntheticCatalogue(1)[0]!, surveyId: "desi", releaseId: "dr1", ...pixelCenter(6, 18000) };
const source = { surveyId: "desi", releaseId: "desi-dr1" };
const query = { order: 6, cells: [18000], sources: [source], axis: "distance", mode: "points" };
async function fixture(t: test.TestContext, changes: Partial<DistanceObject>[] = [{}]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sky-depth-synthetic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "synthetic-evidence.json");
  const objects = changes.map((change, i) => ({ ...baseline, objectId: `synthetic-${i}`, ...change, sourceRow: i }));
  const bytes = JSON.stringify({ schemaVersion: 1, dataOrigin: "desi-dr1-local", deliveryClass: "evidence",
    source: { connector: "desi-dr1-local", relativePath: "zcatalog/v1/zall-pix-iron.fits", fileRows: objects.length + 100,
      rowStartInclusive: 0, rowStopExclusive: objects.length, headerSha256: "1".repeat(64), rowBytesSha256: "2".repeat(64), skyRegionComplete: false }, objects });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(file, bytes);
  const config = { evidenceRoot: root, samplePath: file, sampleSha256: sha256, referencePath };
  return { root, file, bytes, config, store: new SkyDepthStore(config) };
}

test("observed redshifts retain negative/low/out-of-model z and unknown frames without inventing distances", () => {
  const rows = [-.01, .01, 3, .4].map((redshift, i) => ({ ...baseline, objectId: String(i), redshift, ...(i === 3 ? { redshiftFrame: "unknown" as const } : {}) }));
  assert.equal(prepareRedshiftObjects(rows).accepted, 4);
  assert.equal(prepareObjects(rows, reference).accepted, 0);
  assert.equal(prepareRedshiftObjects([{ ...rows[0]!, zwarn: 1 }]).accepted, 0);
});
test("invalid queries fail before loading evidence and valid duplicate selections normalize", async () => {
  const store = new SkyDepthStore({ evidenceRoot: "/missing", samplePath: "/missing/file", referencePath });
  for (const bad of [null, {}, { ...query, order: 3 }, { ...query, cells: [] }, { ...query, cells: [-1] },
    { ...query, cells: [12 * 4 ** 6] }, { ...query, order: 14 }, { ...query, sources: [] }, { ...query, sources: [{ surveyId: "../secret", releaseId: "dr1" }] },
    { ...query, sources: [{ surveyId: "euclid", releaseId: "q1", role: "reference" }] }]) {
    await assert.rejects(store.query(bad), SkyDepthInputError);
  }
  assert.deepEqual(parseSkyDepthQuery({ ...query, cells: [18000, 18000], sources: [source, source] }).cells, [18000]);
});
test("selection uses true coordinates, preserves evidence identity and keeps unsupported releases separate", async t => {
  const { store, config } = await fixture(t, [{}, { ...pixelCenter(6, 19000) }]);
  const result = await store.query({ ...query, sources: [source, { surveyId: "desi", releaseId: "desi-edr" }, { surveyId: "gaia", releaseId: "gaia-dr3" }] });
  const first = result.sources[0]!;
  assert.equal(first.status, "available"); assert.equal(first.selectedCount, 1);
  assert.equal(pixelAt(6, first.points[0]!.raDeg, first.points[0]!.decDeg), 18000);
  assert.equal(first.snapshotSha256, config.sampleSha256); assert.equal(first.scope?.skyRegionComplete, false);
  assert.ok(first.points[0]!.distanceMpc! > 0); assert.equal(result.distanceBasis.peculiarVelocityCorrected, false);
  assert.deepEqual(first.cellExtents, [{ order: 6, pixel: 18000, radialMax: first.points[0]!.distanceMpc, count: 1 }]);
  assert.deepEqual(first.radialRange, (await store.query({ ...query, cells: [19000] })).sources[0]!.radialRange,
    "the source axis range must not follow the current selection");
  assert.deepEqual(result.sources.slice(1).map(s => s.status), ["not-connected", "not-connected"]);
  assert.equal((await store.query({ ...query, cells: [1] })).sources[0]!.status, "empty");
  const example = await store.example(); assert.equal(example.available, true); assert.equal(example.selection!.order, 4);
});
test("DESI may be requested as an explicitly labeled coordinate reference for another survey", async t => {
  const { store } = await fixture(t, [{}, { ...pixelCenter(6, 19000) }]);
  const result = await store.query({ ...query, sources: [
    { surveyId: "euclid", releaseId: "euclid-q1" }, { ...source, role: "reference" },
  ] });
  assert.equal(result.sources[0]!.status, "not-connected");
  assert.equal(result.sources[1]!.status, "available");
  assert.equal(result.sources[1]!.role, "reference");
  assert.equal(result.sources[1]!.label, "DESI DR1 · reference depth");
  assert.equal(result.sources[1]!.selectedCount, 1);
});
test("voxel radial positions use the count-weighted measurement mean and cell maxima use eligible rows", async t => {
  const { store } = await fixture(t, [{ redshift: .5 }, { redshift: .5001 }, { redshift: .5002 }]);
  const individual = (await store.query({ ...query, mode: "points" })).sources[0]!;
  const aggregate = (await store.query({ ...query, mode: "aggregate" })).sources[0]!;
  const voxel = aggregate.voxels.find(item => item.count === 3)!;
  const expectedMean = individual.points.reduce((sum, point) => sum + point.distanceMpc!, 0) / individual.points.length;
  assert.ok(Math.abs(voxel.radialMean - expectedMean) < 1e-10);
  assert.equal(aggregate.cellExtents![0]!.count, 3);
  assert.equal(aggregate.cellExtents![0]!.radialMax, Math.max(...individual.points.map(point => point.distanceMpc!)));
});
test("redshift-only measurements, no applicable measurements, and empty input are distinct", async t => {
  const { store } = await fixture(t, [{ redshift: -.01 }, { redshift: .01 }, { redshift: 3 }, { zwarn: 1, ...pixelCenter(6, 19000) }]);
  const distance = (await store.query(query)).sources[0]!;
  assert.equal(distance.status, "redshift-only"); assert.equal(distance.selectedCount, 0); assert.equal(distance.redshiftCount, 3);
  const z = (await store.query({ ...query, axis: "redshift" })).sources[0]!;
  assert.equal(z.selectedCount, 3); assert.deepEqual(z.points.map(p => p.distanceMpc), [null, null, null]);
  assert.equal(z.radialRange![0], -.01); assert.equal(z.radialRange![1], 3);
  assert.equal((await store.query({ ...query, cells: [19000] })).sources[0]!.status, "no-measurements");
});
test("a measured zero is retained separately from a missing cell extent", async t => {
  const { store } = await fixture(t, [{ redshift: 0 }]);
  const zero = (await store.query({ ...query, axis: "redshift", mode: "aggregate" })).sources[0]!;
  assert.equal(zero.selectedCount, 1);
  assert.deepEqual(zero.cellExtents, [{ order: 6, pixel: 18000, radialMax: 0, count: 1 }]);
  const empty = (await store.query({ ...query, cells: [19000], axis: "redshift", mode: "aggregate" })).sources[0]!;
  assert.equal(empty.status, "empty");
  assert.equal(empty.cellExtents, undefined);
});
test("missing files and hash mismatch are read failures, never empty results; retries can recover", async t => {
  const { file, bytes, store, config } = await fixture(t);
  await rm(file);
  assert.equal((await store.query(query)).sources[0]!.status, "unavailable");
  await writeFile(file, bytes);
  assert.equal((await store.query(query)).sources[0]!.status, "available");
  const mismatch = new SkyDepthStore({ ...config, sampleSha256: "0".repeat(64) });
  const result = await mismatch.query({ ...query, sources: [source, { surveyId: "gaia", releaseId: "gaia-dr3" }] });
  assert.equal(result.sources[0]!.status, "unavailable"); assert.equal(result.sources[1]!.status, "not-connected");
  assert.equal(JSON.stringify(result).includes(file), false);
  const outside = new SkyDepthStore({ ...config, evidenceRoot: path.join(config.evidenceRoot, "unrelated") });
  assert.equal((await outside.query(query)).sources[0]!.status, "unavailable");
});
test("point and column budgets aggregate the complete selection with conserved counts", async t => {
  const changes = Array.from({ length: 21000 }, (_, i) => ({ redshift: .02 + i / 11000 }));
  const { store } = await fixture(t, changes);
  for (const mode of ["points", "bars", "aggregate"]) {
    const result = (await store.query({ ...query, mode })).sources[0]!;
    assert.equal(result.status, "available"); assert.equal(result.mode, "aggregate"); assert.deepEqual(result.points, []);
    assert.equal(result.voxels.reduce((sum, v) => sum + v.count, 0), 21000);
    assert.ok(result.aggregationOrder! >= query.order); assert.ok(result.voxels.length <= 32768);
  }
});
