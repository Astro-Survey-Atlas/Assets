import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { aggregatePoints, comovingDistance, parentPixel, parseDistanceSample, pixelAt, pixelCenter, planRepresentation, prepareObjects,
  radialBinAt, selectPoints, syntheticCatalogue, type DistanceReference, type DistanceObject } from "../src/distance-feasibility.js";

const reference = JSON.parse(await readFile(new URL("../fixtures/distance-prototype/planck18-reference.json", import.meta.url), "utf8")) as DistanceReference & { referenceChecks: { z: number; distanceMpc: number }[] };
const distanceMax = comovingDistance(2, reference);
const rows = syntheticCatalogue(1200);
const prepared = prepareObjects(rows, reference);

test("bounded DESI imports preserve source rows and IDs, reject incomplete provenance, and exclude null coordinates", () => {
  const input = { schemaVersion: 1, dataOrigin: "desi-dr1-local", deliveryClass: "evidence", source: {
    connector: "desi-dr1-local", relativePath: "zcatalog/v1/zall-pix-iron.fits", fileRows: 100, rowStartInclusive: 9,
    rowStopExclusive: 10, headerSha256: "1".repeat(64), rowBytesSha256: "2".repeat(64), skyRegionComplete: false,
  }, objects: [{ ...rows[0]!, surveyId: "desi", releaseId: "dr1", objectId: "39628473198710603", sourceRow: 9 }] };
  const sample = parseDistanceSample(input);
  assert.equal(sample.objects[0]!.objectId, "39628473198710603");
  assert.equal(prepareObjects(sample.objects, reference).accepted, 1);
  assert.throws(() => parseDistanceSample({ ...input, source: { ...input.source, rowStopExclusive: 11 } }));
  assert.throws(() => parseDistanceSample({ ...input, source: { ...input.source, skyRegionComplete: true } }));
  assert.throws(() => parseDistanceSample({ ...input, objects: [{ ...input.objects[0], sourceRow: 10 }] }));
  const invalid = parseDistanceSample({ ...input, objects: [{ ...input.objects[0], raDeg: null }] });
  assert.equal(prepareObjects(invalid.objects, reference).excluded.invalidCoordinate, 1);
});

test("Planck18 interpolation agrees with independent Astropy reference checks within 0.003 Mpc", () => {
  for (const check of reference.referenceChecks) assert.ok(Math.abs(comovingDistance(check.z, reference) - check.distanceMpc) < .003);
  assert.equal(comovingDistance(0, reference), 0);
  assert.throws(() => comovingDistance(-.1, reference));
  assert.throws(() => comovingDistance(2.1, reference));
  assert.throws(() => comovingDistance(NaN, reference));
});
test("a redshift-inferred coordinate carries its basis and uncorrected limitations", () => {
  const p = prepared.points[0]!;
  assert.equal(p.basis, "redshift-space-comoving");
  assert.ok(p.limitations.includes("peculiar-velocity-not-corrected"));
  assert.ok(p.limitations.includes("barycentric-not-cmb-corrected"));
  assert.ok(p.limitations.includes("cosmology-systematics-not-in-error"));
  assert.ok(p.measurementErrorMpc! > 0);
});
test("invalid redshifts, unknown frames and unreliable measurements do not receive distances", () => {
  const base = rows[0]!;
  const changes: Partial<DistanceObject>[] = [{ redshift: null }, { redshift: -.01 }, { redshift: .01 }, { redshift: 3 },
    { redshiftFrame: "unknown" }, { zwarn: 1 }, { spectype: "STAR" }, { zcatPrimary: false }, { objtype: "SKY" }, { program: "other" }, { zcatPrimary: null }, { observingSurvey: "sv3" }, { raDeg: 361 }, { decDeg: -91 }];
  const result = prepareObjects(changes.map((v, i) => ({ ...base, ...v, objectId: `invalid-${i}` })), reference);
  assert.equal(result.accepted, 0);
  assert.equal(Object.values(result.excluded).reduce((a, b) => a + b, 0), changes.length);
});
test("missing or invalid measurement error stays unknown instead of becoming a zero uncertainty", () => {
  const result = prepareObjects([{ ...rows[0]!, redshiftError: null }, { ...rows[1]!, redshiftError: -1 }], reference);
  assert.ok(result.points.every(p => p.measurementErrorMpc === null && p.limitations.includes("measurement-error-unavailable")));
});
test("duplicates are handled within release while distinct survey/release identities remain distinct", () => {
  const row = rows[0]!;
  const result = prepareObjects([row, row, { ...row, releaseId: "another-release" }, { ...row, surveyId: "another-survey" }], reference);
  assert.equal(result.accepted, 3);
  assert.equal(result.excluded.duplicateIdenticalPrimary, 1);
  const conflict = prepareObjects([row, { ...row, redshift: .8, deltaChi2: 999 }], reference);
  assert.equal(conflict.accepted, 0);
  assert.equal(conflict.excluded.ambiguousPrimary, 2);
});
test("ICRS coordinates map to real NESTED descendants, including RA wrap and high declination", () => {
  for (const [ra, dec] of [[0, 0], [359.999, 89.9], [2, -89.9], [120, 20]]) {
    const fine = pixelAt(13, ra!, dec!);
    for (const order of [4, 6, 8, 10, 12]) assert.equal(parentPixel(fine, order), pixelAt(order, ra!, dec!));
  }
  const c = pixelCenter(6, 18000);
  assert.equal(pixelAt(6, c.raDeg, c.decDeg), 18000);
});
test("selection boundaries and multiple regions exclude every non-member", () => {
  const selected = selectPoints(prepared.points, { order: 6, pixels: [18000, 19000] });
  assert.equal(selected.length, 1140);
  assert.ok(selected.every(p => [18000, 19000].includes(parentPixel(p.pixel13, 6))));
  assert.equal(selectPoints(prepared.points, { order: 6, pixels: [3] }).length, 0);
  assert.throws(() => selectPoints(prepared.points, { order: 6, pixels: [] }));
});
test("aggregation conserves counts and radial histograms across parent/child orders", () => {
  const selected = selectPoints(prepared.points, { order: 6, pixels: [18000] });
  for (const bins of [32, 64, 128]) {
    let first: number[] | undefined;
    for (const order of [6, 8, 10, 13]) {
      const voxels = aggregatePoints(selected, order, bins, distanceMax);
      assert.equal(voxels.reduce((sum, v) => sum + v.count, 0), selected.length);
      const hist = Array<number>(bins).fill(0);
      for (const v of voxels) hist[v.radialBin]! += v.count;
      if (first) assert.deepEqual(hist, first); else first = hist;
    }
  }
});
test("radial interval edges are deterministic and the upper endpoint is retained", () => {
  assert.equal(radialBinAt(0, 32, 100), 0);
  assert.equal(radialBinAt(50, 32, 100), 16);
  assert.equal(radialBinAt(100, 32, 100), 31);
  assert.throws(() => radialBinAt(101, 32, 100));
  assert.throws(() => radialBinAt(1, 0, 100));
});
test("object budgets switch to complete aggregation; too-small voxel budgets return no partial result", () => {
  const selection = { order: 6, pixels: [18000] };
  const result = planRepresentation(prepared.points, selection, 64, distanceMax, "points", 10, 1000);
  assert.equal(result.mode, "aggregate");
  assert.equal(result.voxels.reduce((sum, v) => sum + v.count, 0), result.selected.length);
  const failure = planRepresentation(prepared.points, selection, 64, distanceMax, "points", 10, 1);
  assert.equal(failure.budgetExceeded, true);
  assert.deepEqual(failure.voxels, []);
});
