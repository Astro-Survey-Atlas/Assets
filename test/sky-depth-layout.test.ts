import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { buildSkyDepthLayout, buildSkyDepthRangeFramePositions, isSkyDepthValueInRange } from "../site/src/atlas/sky-depth-layer.js";
import { raDecToCartesian } from "../site/src/atlas/coordinates.js";
import { pixelAt, pixelCenter } from "../src/distance-feasibility.js";
import type { SkyDepthResponse, SkyDepthSourceResult } from "../src/sky-depth.js";

const source: SkyDepthSourceResult = {
  surveyId: "desi", releaseId: "desi-dr1", role: "survey", label: "DESI DR1", status: "available",
  selectedCount: 14, mode: "aggregate", points: [], aggregationOrder: 8, radialRange: [0, 100],
  cellExtents: [{ order: 4, pixel: 630, radialMax: 70, count: 14 }],
  voxels: [10, 30, 70].map((radialMean, i) => ({ order: 8, pixel: 630 * 256 + 20, radialMin: i * 30, radialMax: (i + 1) * 30,
    radialMean, count: [1, 4, 9][i]! })),
};
const data: SkyDepthResponse = {
  schemaVersion: 1, coordinateFrame: "ICRS", ordering: "NESTED",
  query: { order: 4, cells: [630], sources: [{ surveyId: "desi", releaseId: "desi-dr1" }], axis: "distance", mode: "aggregate" },
  sources: [source],
  distanceBasis: { kind: "redshift-space-comoving", model: "Astropy Planck18", unit: "Mpc", peculiarVelocityCorrected: false, cmbFrameCorrected: false, uncertainty: "measurement-only" },
};

test("depth positions follow radial means along the selected region normal", () => {
  const layout = buildSkyDepthLayout(data, 1.04);
  const center = pixelCenter(8, source.voxels[0]!.pixel);
  assert.equal(pixelAt(4, center.raDeg, center.decDeg), 630);
  const base = new THREE.Vector3().copy(raDecToCartesian(center.raDeg, center.decDeg, 1.04));
  for (const item of layout.items) {
    const t = item.voxel.radialMean / 100;
    assert.ok(item.position.clone().addScaledVector(layout.normal, -t * layout.height).distanceTo(base) < 1e-12);
    assert.ok(t * layout.height <= item.frameHeight + 1e-12);
  }
  const delta = layout.items[2]!.position.clone().sub(layout.items[0]!.position);
  assert.ok(delta.clone().cross(layout.normal).length() < 1e-12);
  assert.ok(delta.dot(layout.normal) > 0);
  assert.equal(layout.items[0]!.voxel.radialMean, 10);
});

test("range emphasis includes its endpoints and positions parallel frames on the shared radial scale", () => {
  const layout = buildSkyDepthLayout(data, 1.04);
  assert.equal(isSkyDepthValueInRange(20, [20, 50]), true);
  assert.equal(isSkyDepthValueInRange(50, [20, 50]), true);
  assert.equal(isSkyDepthValueInRange(19.99, [20, 50]), false);
  assert.equal(isSkyDepthValueInRange(50.01, [20, 50]), false);

  const [boundary] = layout.boundary;
  const lower = buildSkyDepthRangeFramePositions(layout.boundary, layout.normal, layout.height, 0, layout.range);
  const middle = buildSkyDepthRangeFramePositions(layout.boundary, layout.normal, layout.height, 50, layout.range);
  const upper = buildSkyDepthRangeFramePositions(layout.boundary, layout.normal, layout.height, 100, layout.range);
  assert.equal(lower.length, boundary!.length * 6);
  const point = (positions: Float32Array) => new THREE.Vector3(positions[0], positions[1], positions[2]);
  const offset = (position: THREE.Vector3) => position.clone().sub(boundary![0]!).dot(layout.normal);
  assert.ok(Math.abs(offset(point(lower))) < 1e-7);
  assert.ok(Math.abs(offset(point(middle)) - layout.height / 2) < 1e-7);
  assert.ok(Math.abs(offset(point(upper)) - layout.height) < 1e-7);
});

test("each selected cell rises to its own measured maximum and sparse cells keep separate heights", () => {
  const firstPixel = 2520, secondPixel = 2521;
  const sourceWithCells: SkyDepthSourceResult = { ...source, selectedCount: 14, cellExtents: [
    { order: 5, pixel: firstPixel, radialMax: 70, count: 10 },
    { order: 5, pixel: secondPixel, radialMax: 35, count: 4 },
  ], voxels: [
    { order: 8, pixel: firstPixel * 64 + 5, radialMin: 0, radialMax: 40, radialMean: 20, count: 5 },
    { order: 8, pixel: firstPixel * 64 + 6, radialMin: 40, radialMax: 80, radialMean: 70, count: 5 },
    { order: 8, pixel: secondPixel * 64 + 2, radialMin: 0, radialMax: 40, radialMean: 20, count: 4 },
  ] };
  const layout = buildSkyDepthLayout({ ...data, query: { ...data.query, order: 5, cells: [firstPixel, secondPixel] }, sources: [sourceWithCells] }, 1.04);
  const frames = new Map(layout.frames.map(frame => [frame.pixel, frame]));
  assert.equal(frames.size, 2);
  assert.ok(frames.get(firstPixel)!.height > frames.get(secondPixel)!.height);
  for (const item of layout.items) {
    const frame = frames.get(item.cellPixel)!;
    const base = pixelCenter(item.voxel.order, item.voxel.pixel);
    const basePoint = new THREE.Vector3().copy(raDecToCartesian(base.raDeg, base.decDeg, 1.04));
    const offset = item.position.clone().sub(basePoint).dot(layout.normal);
    assert.ok(offset <= frame.height + 1e-12);
    assert.equal(item.frameHeight, frame.height);
  }
  assert.equal(layout.items.reduce((sum, item) => sum + item.voxel.count, 0), 14);
});

test("the same measured maximum has the same height across selection and HEALPix orders", () => {
  const order4 = buildSkyDepthLayout(data, 1.04);
  const child = 2520;
  const order5 = buildSkyDepthLayout({ ...data,
    query: { ...data.query, order: 5, cells: [child] },
    sources: [{ ...source, cellExtents: [{ order: 5, pixel: child, radialMax: 70, count: 14 }] }],
  }, 1.04);
  assert.equal(order4.frames[0]!.height, order5.frames[0]!.height);
  assert.equal(order4.height, order5.height);
});

test("a measured zero is retained as a data extent without inventing vertical height", () => {
  const zero = buildSkyDepthLayout({ ...data, sources: [{ ...source, cellExtents: [{ order: 4, pixel: 630, radialMax: 0, count: 1 }],
    voxels: [{ order: 8, pixel: 630 * 256 + 20, radialMin: 0, radialMax: 1, radialMean: 0, count: 1 }] }] }, 1.04);
  assert.equal(zero.frames.length, 1);
  assert.equal(zero.frames[0]!.height, 0);
  assert.equal(zero.items.length, 1);
});

test("overlapping survey and reference measurements fuse to one cell frame without merging source identities", () => {
  const reference: SkyDepthSourceResult = { ...source, role: "reference", label: "DESI DR1 · reference depth", selectedCount: 2,
    cellExtents: [{ order: 4, pixel: 630, radialMax: 50, count: 2 }],
    voxels: [{ order: 8, pixel: 630 * 256 + 24, radialMin: 30, radialMax: 60, radialMean: 40, count: 2 }] };
  const layout = buildSkyDepthLayout({ ...data, sources: [source, reference] }, 1.04);
  assert.equal(layout.frames.length, 1);
  assert.equal(layout.frames[0]!.radialMax, 70);
  assert.equal(layout.frames[0]!.count, 16);
  assert.deepEqual(new Set(layout.items.map(item => item.source)), new Set([source, reference]));
  assert.ok(layout.items.every(item => item.voxel.radialMean <= layout.frames[0]!.radialMax));
});

test("screen disc area stays proportional to count, including when the global size scale is reduced", () => {
  for (const counts of [[1, 4, 9], [1, 100, 10000]]) {
    const l = buildSkyDepthLayout({ ...data, sources: [{ ...source, voxels: source.voxels.map((v, i) => ({ ...v, count: counts[i]! })) }] }, 1);
    const area = (n: number) => Math.PI * (l.baseDiameter * Math.sqrt(n) / 2) ** 2;
    assert.ok(Math.abs(area(counts[2]!) / area(counts[0]!) - counts[2]! / counts[0]!) < 1e-8);
    assert.ok(l.baseDiameter * Math.sqrt(l.maxCount) <= 28.000001);
  }
});

test("aggregates conserve counts and source identities without inventing individual objects", () => {
  const l = buildSkyDepthLayout(data, 1);
  assert.equal(l.items.length, 3);
  assert.equal(l.items.reduce((sum, item) => sum + item.voxel.count, 0), 14);
  assert.ok(l.items.every(item => item.source === source));
  assert.deepEqual(l.items.map(item => item.voxel), source.voxels);
});

test("missing evidence keeps the selected base boundary but creates no frame or points", () => {
  const l = buildSkyDepthLayout({ ...data, sources: [{ ...source, status: "not-connected", selectedCount: 0, voxels: [], cellExtents: [] }] }, 1);
  assert.equal(l.items.length, 0);
  assert.equal(l.frames.length, 0);
  assert.equal(l.boundary.length, 1);
  assert.throws(() => buildSkyDepthLayout({ ...data, query: { ...data.query, cells: [0, 3000] } }, 1));
});
