import assert from "node:assert/strict";
import test from "node:test";
import { Healpix } from "healpixjs";

import type { CoverageCellLayer } from "../server/coverage.js";
import { highestCommonOrder, overlapForLayers } from "../server/overlap.js";
import { SourceUnitStore } from "../server/source-units.js";
import { buildOverlapHighlight } from "../site/src/atlas/overlap-highlight.js";
import { recenteredOrbitPose } from "../site/src/atlas/survey-layer-viewer.js";
import { cameraDistanceForAngularRadius } from "../site/src/atlas/survey-layer-viewer.js";
import * as THREE from "three";

function layer(layerId: string, surveyId: string, orders: Record<number, number[]>): CoverageCellLayer {
  const cells = new Map(Object.entries(orders).map(([order, pixels]) => [Number(order), pixels]));
  const availableOrders = [...cells.keys()].sort((left, right) => left - right);
  return { layerId, productId: layerId, surveyId, releaseId: `${surveyId}-dr`, product: layerId, color: "#ffffff", availableOrders, overviewOrder: availableOrders[0]!, maxOrder: Math.max(...availableOrders), cellCount: cells.get(availableOrders[0]!)!.length, areaDeg2: 1, tileScheme: "ipix-range-4096", cells };
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

test("component camera fitting zooms small regions without the old distance cap", () => {
  const small = cameraDistanceForAngularRadius(THREE.MathUtils.degToRad(1.8), 1);
  const large = cameraDistanceForAngularRadius(THREE.MathUtils.degToRad(13), 1);
  assert.ok(small > 1.08);
  assert.ok(small < 2.8);
  assert.ok(large > small);
  assert.ok(large < 2.8);
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

test("DESI source units are reconstructed from the locked TILE_COMPLETENESS snapshots", async () => {
  const store = await SourceUnitStore.load(process.cwd());
  const match = store.match("desi-dr1-spectra-footprint", 4, [1087, 1130, 1173, 1216]);
  assert.ok(match);
  assert.equal(match.status, "exact");
  assert.ok(match.totalUnits > 0);
  assert.match(match.units[0]!.downloadUrl, new RegExp("data\\.desi\\.lbl\\.gov/public/dr1/spectro/redux/iron/tiles/cumulative"));
});
