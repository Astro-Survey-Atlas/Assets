import assert from "node:assert/strict";
import test from "node:test";

import { displayOrders, displayTileRanges, mocPixelRanges, pixelsInTile } from "../server/display-coverage.js";
import { layersForOverlapComponent, overlapForLayers } from "../server/overlap.js";
import type { CoverageCellLayer } from "../server/coverage.js";
import type { NativeMoc } from "../server/native-moc.js";
import { overlapViewTileOrder } from "../site/src/atlas/coverage-orders.js";
import { coverageCatalogRevisionKey } from "../site/src/coverage-catalog-revision.js";

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
