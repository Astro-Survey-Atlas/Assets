import assert from "node:assert/strict";
import test from "node:test";
import { Healpix } from "healpixjs";

import { displayOrders, displayTileRanges, mocPixelRanges, pixelsInTile } from "../server/display-coverage.js";
import { layersForOverlapComponent, overlapForLayers } from "../server/overlap.js";
import type { CoverageCellLayer } from "../server/coverage.js";
import type { NativeMoc } from "../server/native-moc.js";
import { overlapViewTileOrder } from "../site/src/atlas/coverage-orders.js";
import { CoverageViewTileBudgetError, coverageCellsInView, coverageTilesInView, overlapCoverageTilesInView } from "../site/src/atlas/coverage-view-tiles.js";
import { coverageCatalogRevisionKey } from "../site/src/coverage-catalog-revision.js";
import { healpixPixelFromSceneDirection, sphericalCellCenter } from "../site/src/atlas/spherical-cell-geometry.js";

function nativeMoc(order: number, pixels: number[], maxOrder = order): NativeMoc {
  return {
    cells: pixels.map((pixel) => ({ order, pixel })),
    availableOrders: [order],
    maxOrder,
    revision: `native-${order}-${pixels.join("-")}`,
    sha256: "fixture",
  };
}

function layer(layerId: string, surveyId: string, orders: number[]): CoverageCellLayer {
  return {
    layerId,
    productId: layerId,
    surveyId,
    releaseId: `${surveyId}-release`,
    product: layerId,
    color: "#ffffff",
    availableOrders: orders,
    overviewOrder: Math.min(...orders),
    maxOrder: Math.max(...orders),
    cellCount: 1,
    areaDeg2: 1,
    tileScheme: "ipix-range-4096",
    cells: new Map(orders.map((order) => [order, [1]])),
  };
}

test("display capabilities include native orders beyond the precomputed query blocks", () => {
  assert.deepEqual(displayOrders([4, 8], nativeMoc(10, [256])), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(displayOrders([4, 8]), [4, 8]);
});

test("catalog hydration notices native geometry changes even when the catalog revision is stable", () => {
  const catalog = { revision: "catalog-r1", layers: [{ layerId: "layer-a", displayRevision: "native-r1", displayOrders: [4, 8] }] };
  assert.notEqual(coverageCatalogRevisionKey(catalog), coverageCatalogRevisionKey({
    ...catalog,
    layers: [{ ...catalog.layers[0]!, displayRevision: "native-r2" }],
  }));
  assert.equal(coverageCatalogRevisionKey(catalog), coverageCatalogRevisionKey({
    ...catalog,
    layers: [{ ...catalog.layers[0]!, displayOrders: [8, 4] }],
  }));
});

test("small display orders use a full-sky overlap seed while O6+ uses HEALPix parent tiles", () => {
  assert.equal(overlapViewTileOrder(4), null);
  assert.equal(overlapViewTileOrder(5), null);
  assert.equal(overlapViewTileOrder(6), 0);
  assert.equal(overlapViewTileOrder(10), 4);
  assert.equal(overlapViewTileOrder(14), null);
});

test("high-order view clipping includes indexed ERO tiles visible on either side of the globe", () => {
  const direction = [1.5745985198673105, -0.45021676894871193, -0.7447296563312263] as [number, number, number];
  const length = Math.hypot(...direction);
  const view = {
    coverageViewDirection: direction.map((value) => value / length) as [number, number, number],
    coverageViewRadiusRad: 73.37 * Math.PI / 180,
  };
  const ranges = [
    { start: 419, end: 420 },
    { start: 425, end: 426 },
    { start: 876, end: 877 },
    { start: 5712, end: 5714 },
    { start: 7428, end: 7430 },
    { start: 10518, end: 10520 },
  ];

  assert.deepEqual(coverageTilesInView(11, view, ranges), [419, 425, 876, 5712, 5713, 7428, 7429, 10518, 10519]);
});

test("high-order overlap seeds intersect survey unions at real display tiles", () => {
  const view = { coverageViewDirection: [1, 0, 0] as [number, number, number], coverageViewRadiusRad: Math.PI };
  const tiles = overlapCoverageTilesInView(11, view, [
    { products: [[{ start: 10, end: 13 }, { start: 100, end: 102 }], [{ start: 12, end: 15 }]] },
    { products: [[{ start: 12, end: 14 }, { start: 101, end: 103 }]] },
  ], 192);
  assert.deepEqual(tiles, [12, 13, 101]);
});

test("high-order overlap reports the shared-tile budget instead of returning a partial seed", () => {
  const view = { coverageViewDirection: [1, 0, 0] as [number, number, number], coverageViewRadiusRad: Math.PI };
  const fullSky = [{ start: 0, end: 193 }];
  assert.throws(
    () => overlapCoverageTilesInView(11, view, [{ products: [fullSky] }, { products: [fullSky] }], 192),
    (error) => error instanceof CoverageViewTileBudgetError && error.tileCount === 193 && error.tileBudget === 192,
  );
});

test("focus and overlap omit indexed tiles on the far side of the sky", () => {
  const front = healpixPixelFromSceneDirection(32, { x: 1, y: 0, z: 0 });
  const back = healpixPixelFromSceneDirection(32, { x: -1, y: 0, z: 0 });
  const ranges = [front, back].sort((a, b) => a - b).map((tile) => ({ start: tile, end: tile + 1 }));
  const view = { coverageViewDirection: [1, 0, 0] as [number, number, number], coverageViewRadiusRad: 0.05 };
  assert.deepEqual(coverageTilesInView(11, view, ranges), [front, back].sort((a, b) => a - b));
  assert.deepEqual(coverageTilesInView(11, view, ranges, false), [front]);
  assert.deepEqual(overlapCoverageTilesInView(11, view, [{ products: [ranges] }, { products: [ranges] }], 192), [front]);
});

test("source cell clipping keeps real cells at the view boundary and omits off-view tile contents", () => {
  const order = 8;
  const nside = 2 ** order;
  const front = healpixPixelFromSceneDirection(nside, { x: 1, y: 0, z: 0 });
  const center = sphericalCellCenter(nside, front, 1).normalize();
  const back = healpixPixelFromSceneDirection(nside, center.clone().negate());
  const edge = healpixPixelFromSceneDirection(nside, { x: Math.cos(0.04), y: Math.sin(0.04), z: 0 });
  const outside = healpixPixelFromSceneDirection(nside, { x: 0, y: 1, z: 0 });
  const view = {
    coverageViewDirection: center.toArray() as [number, number, number],
    coverageViewRadiusRad: center.angleTo(sphericalCellCenter(nside, edge, 1)) - new Healpix(nside).maxPixrad() / 2,
  };
  const cells = [front, back, edge, outside];
  assert.deepEqual(coverageCellsInView(order, view, cells, false), [front, edge]);
  assert.deepEqual(coverageCellsInView(order, view, cells, true), [front, back, edge]);
  assert.deepEqual(coverageCellsInView(4, view, [0, 1, 2], false), [0, 1, 2], "O4 remains the full overview");
});

test("focused source rendering counts only the visible native-order cells of a fetched tile", () => {
  const order = 10;
  const front = healpixPixelFromSceneDirection(2 ** order, { x: 1, y: 0, z: 0 });
  const cells = Array.from({ length: 4096 }, (_, index) => Math.floor(front / 4096) * 4096 + index);
  const view = { coverageViewDirection: [1, 0, 0] as [number, number, number], coverageViewRadiusRad: 0.01 };
  const visible = coverageCellsInView(order, view, cells, false);
  assert.ok(visible.includes(front));
  assert.ok(visible.length > 0 && visible.length < 1024, `${visible.length} cells from a 4096-cell source tile`);
  assert.ok(visible.every((pixel) => cells.includes(pixel)), "clipping must never synthesize cells");
});

test("native MOC projection produces bounded display tiles without expanding the whole order", () => {
  const ranges = mocPixelRanges(nativeMoc(4, [1], 10), 10);
  assert.deepEqual(ranges, [{ start: 4096, end: 8192 }]);
  assert.deepEqual(displayTileRanges(ranges), [{ start: 1, end: 2 }]);
  assert.deepEqual(pixelsInTile(ranges, 1), Array.from({ length: 4096 }, (_, index) => index + 4096));
});

test("strict O8 overlap remains empty when only the O4 parents overlap", () => {
  const layers = [layer("a", "a", [4, 8]), layer("b", "b", [4, 8])];
  const result = overlapForLayers(layers, ["a", "b"], 8, {
    strictOrder: true,
    nativeGeometry: new Map([
      ["a", nativeMoc(8, [256])],
      ["b", nativeMoc(8, [257])],
    ]),
  });
  assert.equal(result?.commonOrder, 8);
  assert.deepEqual(result?.pixels, []);
  assert.deepEqual(result?.components, []);
});

test("strict O4 overlap searches the full sky instead of clipping to a storage block ID", () => {
  const layers = [layer("a", "a", [4]), layer("b", "b", [4])];
  const result = overlapForLayers(layers, ["a", "b"], 4, {
    strictOrder: true,
    nativeGeometry: new Map([
      ["a", nativeMoc(4, [1280])],
      ["b", nativeMoc(4, [1280])],
    ]),
  });
  assert.deepEqual(result?.pixels, [1280]);
  assert.deepEqual(result?.components[0]?.cells, [1280]);
});

test("high-order overlap details identify products through their native MOCs", () => {
  const layers = [layer("a", "a", [4, 8]), layer("b", "b", [4, 8])];
  const nativeGeometry = new Map([
    ["a", nativeMoc(8, [256])],
    ["b", nativeMoc(8, [256])],
  ]);
  const result = overlapForLayers(layers, ["a", "b"], 8, { strictOrder: true, nativeGeometry });
  const component = result?.components[0];
  assert.ok(component);
  assert.deepEqual(layersForOverlapComponent(layers, result!, component, nativeGeometry).map((entry) => entry.layerId), ["a", "b"]);
});

test("strict overlap rejects a selected product without the requested order", () => {
  const layers = [layer("a-o4", "a", [4, 8]), layer("a-o4-only", "a", [4]), layer("b", "b", [4, 8])];
  const result = overlapForLayers(layers, ["a", "b"], 8, {
    strictOrder: true,
    nativeGeometry: new Map([
      ["a-o4", nativeMoc(8, [256])],
      ["b", nativeMoc(8, [256])],
    ]),
  });
  assert.equal(result, null);
});

test("view clipping retains the full connected component for details and reverse lookup", () => {
  const layers = [layer("a", "a", [4, 8]), layer("b", "b", [4, 8])];
  const result = overlapForLayers(layers, ["a", "b"], 8, {
    strictOrder: true,
    nativeGeometry: new Map([
      ["a", nativeMoc(8, [0, 283989])],
      ["b", nativeMoc(8, [0, 283989])],
    ]),
    viewTiles: { order: 2, tiles: [0] },
  });
  assert.deepEqual(result?.pixels, [0]);
  assert.deepEqual(result?.components[0]?.cells, [0, 283989]);
});
