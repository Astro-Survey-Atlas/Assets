import assert from "node:assert/strict";
import test from "node:test";
import { Healpix, Pointing } from "healpixjs";
import { filterByModalities } from "../src/modality-filter.js";

import type { CoverageCellLayer } from "../server/coverage.js";
import { highestCommonOrder, layersForOverlapComponent, overlapForLayers } from "../server/overlap.js";
import { SourceUnitStore } from "../server/source-units.js";
import { buildOverlapHighlight } from "../site/src/atlas/overlap-highlight.js";
import { largestConnectedPixelComponent, recenteredOrbitPose } from "../site/src/atlas/survey-layer-viewer.js";
import { cameraDistanceForAngularRadius, cameraDistanceForEffectiveFov, CENTERED_DATA_FOV_DEG } from "../site/src/atlas/survey-layer-viewer.js";
import { coverageEscapeIntent } from "../site/src/atlas/coverage-interaction.js";
import { testDataRoot } from "./test-data-root.js";
import * as THREE from "three";

function layer(layerId: string, surveyId: string, orders: Record<number, number[]>): CoverageCellLayer {
  const cells = new Map(Object.entries(orders).map(([order, pixels]) => [Number(order), pixels]));
  const availableOrders = [...cells.keys()].sort((left, right) => left - right);
  return { layerId, productId: layerId, surveyId, releaseId: `${surveyId}-dr`, product: layerId, color: "#ffffff", availableOrders, overviewOrder: availableOrders[0]!, maxOrder: Math.max(...availableOrders), cellCount: cells.get(availableOrders[0]!)!.length, areaDeg2: 1, tileScheme: "ipix-range-4096", cells };
}

let sourceUnitStorePromise: Promise<SourceUnitStore> | undefined;

function sourceUnitStore(): Promise<SourceUnitStore> {
  sourceUnitStorePromise ??= SourceUnitStore.load(testDataRoot);
  return sourceUnitStorePromise;
}

test("overlap uses the highest order shared by surveys and unions products within each survey", () => {
  const layers = [
    layer("a-one", "a", { 4: [100], 8: [200] }),
    layer("a-two", "a", { 4: [101] }),
    layer("b-one", "b", { 4: [100, 101], 8: [200] }),
  ];
  assert.equal(highestCommonOrder(layers), 8);
  assert.deepEqual(overlapForLayers(layers, ["a", "b"], 4)?.pixels, [100, 101]);
  assert.deepEqual(overlapForLayers(layers, ["a", "b"], 7)?.pixels, [100, 101]);
  assert.deepEqual(overlapForLayers(layers, ["a", "b"], 8)?.pixels, [200]);
});

test("overlap respects selected product modalities within each survey", () => {
  const layers = [
    { ...layer("desi-spectroscopy", "desi", { 4: [10] }), modality: "spectroscopy" },
    { ...layer("desi-redshift", "desi", { 4: [20] }), modality: "redshift" },
    { ...layer("euclid-imaging", "euclid", { 4: [20] }), modality: "imaging" },
  ];
  const selected = filterByModalities(layers, ["redshift", "imaging"]);
  const result = overlapForLayers(selected, ["desi", "euclid"], 4);
  assert.deepEqual(result?.pixels, [20]);
  assert.deepEqual(layersForOverlapComponent(selected, result!, result!.components[0]!).map((entry) => entry.layerId), ["desi-redshift", "euclid-imaging"]);
});

test("overlap falls back to a lower real common order when the highest order has no shared cells", () => {
  const layers = [
    layer("euclid-o4", "euclid", { 4: [637], 8: [548_923] }),
    layer("euclid-o8", "euclid", { 8: [548_923] }),
    layer("sdss-o4", "sdss", { 4: [637], 8: [283_791] }),
    layer("sdss-o8", "sdss", { 8: [283_791] }),
  ];
  const result = overlapForLayers(layers, ["euclid", "sdss"]);
  assert.equal(result?.commonOrder, 4);
  assert.deepEqual(result?.pixels, [637]);
  assert.equal(result?.components[0]?.order, 4);
});

test("overlap component layers contain only products touching that component", () => {
  const layers = [
    layer("euclid-a", "euclid", { 4: [10] }),
    layer("euclid-b", "euclid", { 4: [20] }),
    layer("desi", "desi", { 4: [10, 20] }),
  ];
  const result = overlapForLayers(layers, ["euclid", "desi"], 4)!;
  const first = result.components.find((component) => component.cells.includes(10))!;
  assert.deepEqual(layersForOverlapComponent(layers, result, first).map((entry) => entry.layerId), ["euclid-a", "desi"]);
});

test("overlap components use side neighbours and remain stable", () => {
  const healpix = new Healpix(16);
  const start = 1000;
  const side = healpix.neighbours(start)[0]!;
  const separate = [...Array(12 * 16 * 16).keys()].find((pixel) => pixel !== start && pixel !== side && ![...healpix.neighbours(start), ...healpix.neighbours(side)].includes(pixel))!;
  const layers = [layer("a", "a", { 4: [start, side, separate] }), layer("b", "b", { 4: [start, side, separate] })];
  const result = overlapForLayers(layers, ["a", "b"], 4)!;
  assert.equal(result.components.length, 2);
  assert.ok(result.components.some((component) => JSON.stringify(component.cells) === JSON.stringify([start, side].sort((left, right) => left - right))));
  assert.equal(result.components[0]?.id, "C01");
  assert.equal(result.components[1]?.id, "C02");
});

test("survey focus chooses the largest connected footprint component", () => {
  const healpix = new Healpix(16);
  const start = 1000;
  const side = healpix.neighbours(start)[0]!;
  const separate = [...Array(12 * 16 * 16).keys()].find((pixel) => pixel !== start && pixel !== side && ![...healpix.neighbours(start), ...healpix.neighbours(side)].includes(pixel))!;
  assert.deepEqual(largestConnectedPixelComponent([separate, side, start], 16), [start, side].sort((left, right) => left - right));
});

test("component camera fitting zooms small regions without the old distance cap", () => {
  const small = cameraDistanceForAngularRadius(THREE.MathUtils.degToRad(1.8), 1);
  const large = cameraDistanceForAngularRadius(THREE.MathUtils.degToRad(13), 1);
  assert.ok(small > 1.08);
  assert.ok(small < 2.8);
  assert.ok(large > small);
  assert.ok(large < 2.8);
});

test("centered data framing targets the canonical 115 degree effective FOV", () => {
  const outerRadius = 1.12;
  const cameraFovDeg = 48;
  const distance = cameraDistanceForEffectiveFov(outerRadius, cameraFovDeg, CENTERED_DATA_FOV_DEG);
  const effectiveFovDeg = THREE.MathUtils.radToDeg(2 * Math.atan((distance * Math.tan(THREE.MathUtils.degToRad(cameraFovDeg) / 2)) / outerRadius));
  assert.ok(Math.abs(effectiveFovDeg - CENTERED_DATA_FOV_DEG) < 1e-9);
});

test("Escape keeps the drawer dismissal, focus clear and double-reset intents distinct", () => {
  assert.equal(coverageEscapeIntent({ overlapDrawerOpen: true, now: 100, lastEscapeAt: 0 }), "dismiss-overlap-drawer");
  assert.equal(coverageEscapeIntent({ overlapDrawerOpen: false, now: 1_000, lastEscapeAt: 0 }), "clear-focus");
  assert.equal(coverageEscapeIntent({ overlapDrawerOpen: false, now: 1_400, lastEscapeAt: 1_000 }), "reset-experience");
});

test("overlap highlight builds solid cells and flow edges without a runtime error", () => {
  const highlight = buildOverlapHighlight([{ nside: 16, pixel: 1000, radius: 1.02, color: new THREE.Color("#ffd24a"), inset: 0.028 }], 11_999);
  assert.equal(highlight.root.children.length, 3);
  assert.equal(highlight.mesh.renderOrder, 11_999);
  assert.equal(highlight.meshMaterial.depthTest, true);
  assert.equal(highlight.glowMaterial.depthTest, false);
  assert.equal(highlight.dashMaterial.depthTest, false);
  assert.equal(highlight.dashEdges.renderOrder, 12_001);
  assert.ok(highlight.dashEdges.geometry.getAttribute("lineDistance"));
  highlight.root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      child.material.dispose();
    }
  });
});

test("exiting overlap rebases the orbit around the celestial sphere", () => {
  const pose = recenteredOrbitPose(new THREE.Vector3(7, 4, 2), new THREE.Vector3(2, 1, 0));
  assert.deepEqual(pose.orbitTarget.toArray(), [0, 0, 0]);
  assert.deepEqual(pose.cameraPosition.toArray(), [5, 3, 2]);
});

test("locked source-unit snapshots reconstruct DESI Tiles and HSC tract/patch mappings", async () => {
  const store = await sourceUnitStore();
  assert.equal(store.match("desi-dr1-redrock-bright-file-index", 6, [128]), null);
  const requestedCells = [1087, 1130, 1173, 1216];
  const match = store.match("desi-dr1-spectra-footprint", 4, requestedCells);
  assert.ok(match);
  assert.equal(match.status, "exact");
  assert.ok(match.totalUnits > 0);
  assert.match(match.units[0]!.downloadUrl, new RegExp("data\\.desi\\.lbl\\.gov/public/dr1/spectro/redux/iron/tiles/cumulative"));
  assert.ok(match.units.every((unit) => unit.matchingCells.length > 0 && unit.matchingCells.every((cell) => requestedCells.includes(cell))));
  assert.ok(match.units.some((unit) => unit.matchingCells.length < requestedCells.length));

  const hscLayers = store.coverageLayers().filter((entry) => entry.surveyId === "hsc-ssp");
  assert.equal(hscLayers.length, 7);
  assert.ok(hscLayers.some((entry) => entry.releaseId === "hsc-pdr3"));
  const hsc = hscLayers.find((entry) => entry.releaseId === "hsc-pdr2" && entry.product === "PDR2 g-band imaging")!;
  const hscCell = hsc.cells.get(8)?.[0];
  assert.notEqual(hscCell, undefined);
  const hscMatch = store.match(hsc.layerId, 8, [hscCell!], 20, {
    surveyId: hsc.surveyId,
    releaseId: hsc.releaseId,
    product: hsc.product,
  });
  assert.ok(hscMatch?.units.length);
  assert.equal(hscMatch?.unitKind, "tract/patch");
  assert.ok(hscMatch?.units.every((unit) => unit.downloadUrl?.includes("/das_search/pdr2/")));
});

test("Legacy DR10 matches derive Coadd and Tractor URIs from one brick identity", async () => {
  const store = await sourceUnitStore();
  const cell = 436132;
  const coadd = store.match("source-units-legacy-surveys-legacy-dr10-coadded-imaging", 8, [cell], 120, {
    surveyId: "legacy-surveys",
    releaseId: "legacy-dr10",
    product: "Coadded imaging",
  });
  const tractor = store.match("source-units-legacy-surveys-legacy-dr10-tractor-catalog", 8, [cell], 120, {
    surveyId: "legacy-surveys",
    releaseId: "legacy-dr10",
    product: "Tractor catalog",
  });
  const coaddBrick = coadd?.units.find((unit) => unit.unitId === "1498p020");
  const tractorBrick = tractor?.units.find((unit) => unit.unitId === "1498p020");

  assert.ok(coaddBrick);
  assert.ok(tractorBrick);
  assert.match(coaddBrick.downloadUrl, /\/dr10\/south\/coadd\/149\/1498p020\/$/);
  assert.match(tractorBrick.downloadUrl, /\/dr10\/south\/tractor\/149\/tractor-1498p020\.fits$/);
});

test("DESI source-unit matches retain each tile's exact finer-order cell subset", async () => {
  const store = await sourceUnitStore();
  const coarseMatch = store.match("desi-dr1-spectra-footprint", 4, [1087], 1);
  assert.ok(coarseMatch?.units[0]);
  const unit = coarseMatch.units[0];
  const order = 8;
  const healpix = new Healpix(2 ** order);
  const pointing = new Pointing(null, false, (90 - unit.decDeg) * Math.PI / 180, unit.raDeg * Math.PI / 180);
  const ranges = healpix.queryDiscInclusive(pointing, unit.radiusDeg * Math.PI / 180, 8) as unknown as { r: Int32Array; sz: number };
  const tileCells: number[] = [];
  for (let index = 0; index < ranges.sz; index += 2) {
    for (let pixel = ranges.r[index]!; pixel < ranges.r[index + 1]!; pixel += 1) tileCells.push(pixel);
  }
  assert.ok(tileCells.length > 1);
  const expected = [tileCells[0]!, tileCells.at(-1)!].sort((left, right) => left - right);
  const outsideTile = [...Array(256).keys()].map((offset) => 637 * 256 + offset).find((cell) => !tileCells.includes(cell));
  assert.notEqual(outsideTile, undefined);
  const requestedCells = [...expected, outsideTile!];
  const exactMatch = store.match("desi-dr1-spectra-footprint", order, requestedCells, 5000);
  const exactUnit = exactMatch?.units.find((candidate) => candidate.unitId === unit.unitId);
  assert.deepEqual(exactUnit?.matchingCells, expected);
  assert.notDeepEqual(exactUnit?.matchingCells, requestedCells);
});
