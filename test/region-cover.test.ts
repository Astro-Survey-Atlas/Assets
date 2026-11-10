import assert from "node:assert/strict";
import test from "node:test";
import { Healpix, Pointing } from "healpixjs";
import { canonicalizeRegionCells, normalizeSkyRectangle, normalizeSkyRegion, type SkyRegionCell } from "../src/sky-region.js";
import { classifyRectangleCell, coverSkyRectangle, normalizeReverseSelector, skyRegionHash } from "../server/region-cover.js";

const contains = (cells: SkyRegionCell[], order: number, ipix: number) => cells.some(cell => cell.order <= order && Math.floor(ipix / 4 ** (order - cell.order)) === cell.ipix);

test("rectangle validation preserves wrap/full RA and rejects ambiguous or nonfinite input", () => {
  assert.deepEqual(normalizeSkyRectangle({ raStart: 350, raEnd: 10, decMin: -5, decMax: 5 }), { raStart: 350, raEnd: 10, decMin: -5, decMax: 5, raWidth: 20, fullRa: false });
  assert.equal(normalizeSkyRectangle({ raStart: 0, raEnd: 360, decMin: -90, decMax: 90 }).fullRa, true);
  for (const rectangle of [
    { raStart: 360, raEnd: 0, decMin: -5, decMax: 5 }, { raStart: 1, raEnd: 1, decMin: -5, decMax: 5 },
    { raStart: 0, raEnd: 5, decMin: 1, decMax: 1 }, { raStart: 0, raEnd: 5, decMin: 5, decMax: -5 },
    { raStart: "", raEnd: 5, decMin: -5, decMax: 5 }, { raStart: NaN, raEnd: 5, decMin: -5, decMax: 5 },
    { raStart: 0, raEnd: Infinity, decMin: -5, decMax: 5 }, { raStart: -1, raEnd: 5, decMin: -5, decMax: 5 },
  ]) assert.throws(() => normalizeSkyRectangle(rectangle));
});

test("canonical regions remove ancestors/duplicates and recursively pack siblings no lower than O4", () => {
  assert.deepEqual(canonicalizeRegionCells([{ order: 4, ipix: 5 }, { order: 12, ipix: 5 * 4 ** 8 }, { order: 4, ipix: 5 }]), [{ order: 4, ipix: 5 }]);
  const children = Array.from({ length: 16 }, (_, ipix) => ({ order: 6, ipix: 80 + ipix }));
  const region = normalizeSkyRegion({ coordinateFrame: "ICRS", ordering: "NESTED", cells: children });
  assert.deepEqual(region.cells, [{ order: 4, ipix: 5 }]);
  assert.equal(skyRegionHash(region), skyRegionHash({ ...region, cells: children }));
  assert.equal(canonicalizeRegionCells([0, 1, 2, 3].map(ipix => ({ order: 4, ipix }))).length, 4);
  for (const cell of [{ order: 3, ipix: 1 }, { order: 13, ipix: 1 }, { order: 4, ipix: 3072 }, { order: 4, ipix: -1 }, null]) assert.throws(() => normalizeSkyRegion({ coordinateFrame: "ICRS", ordering: "NESTED", cells: [cell] }));
});

test("conservative adaptive covers include rectangle interiors and boundaries at wrap, wide RA, poles and tiny boxes", () => {
  const rectangles = [
    { raStart: 350, raEnd: 10, decMin: -5, decMax: 5 },
    { raStart: 20, raEnd: 300, decMin: -30, decMax: 40 },
    { raStart: 0, raEnd: 360, decMin: 85, decMax: 90 },
    { raStart: 123.0001, raEnd: 123.0002, decMin: -45.0002, decMax: -45.0001 },
    { raStart: 350, raEnd: 10, decMin: -90, decMax: -85 },
  ];
  const hp = new Healpix(4096);
  for (const rectangle of rectangles) {
    const { region, cover, rectangle: normalized } = coverSkyRectangle(rectangle, 12);
    assert.ok(region.cells.length > 0 && region.cells.length <= 4096);
    assert.ok(cover.coverAreaDeg2 + 1e-8 >= cover.rectangleAreaDeg2);
    assert.equal(Object.values(cover.orderCounts).reduce((a, b) => a + b, 0), region.cells.length);
    assert.equal(cover.unresolvedBoundaryLeaves, region.cells.filter(cell => classifyRectangleCell(normalized, cell) === "boundary").length);
    // Sampling is a regression check, not the classifier's proof of containment.
    for (let x = 0; x <= 30; x++) for (let y = 0; y <= 20; y++) {
      const ra = (normalized.raStart + normalized.raWidth * x / 30) % 360;
      const dec = normalized.decMin + (normalized.decMax - normalized.decMin) * y / 20;
      const ipix = hp.ang2pix(new Pointing(null, false, (90 - dec) * Math.PI / 180, ra * Math.PI / 180));
      assert.ok(contains(region.cells, 12, ipix), `lost RA ${ra}, Dec ${dec}`);
    }
  }
});

test("budget pressure retains parents, reports actual radius/area and keeps coarse interiors", () => {
  const result = coverSkyRectangle({ raStart: 20, raEnd: 300, decMin: -30, decMax: 40 }, 12, 3072);
  assert.equal(result.cover.budgetLimited, true);
  assert.ok(result.region.cells.some(cell => cell.order === 4));
  assert.ok(result.region.cells.some(cell => cell.order > 4));
  assert.ok(result.cover.maxUnresolvedAngularRadiusDeg > new Healpix(4096).maxPixrad() * 180 / Math.PI);
  const full = coverSkyRectangle({ raStart: 0, raEnd: 360, decMin: -90, decMax: 90 });
  assert.equal(full.region.cells.length, 3072);
  assert.equal(full.cover.unresolvedBoundaryLeaves, 0);
  assert.equal(full.cover.budgetLimited, false);
  assert.ok(Math.abs(full.cover.excessAreaDeg2) < 1e-8);
});

test("mixed selectors partition by actual order and bind rectangle policy separately from canonical cover", () => {
  const selector = normalizeReverseSelector({ layerIds: ["a"], region: { coordinateFrame: "ICRS", ordering: "NESTED", cells: [{ order: 4, ipix: 5 }, ...Array.from({ length: 66 }, (_, i) => ({ order: 8, ipix: 1000 + i * 4 }))] } });
  assert.ok(selector.batches.some(batch => batch.order === 4));
  assert.ok(selector.batches.some(batch => batch.order === 8));
  for (const batch of selector.batches) {
    assert.ok(batch.cells.length <= 64);
    assert.ok(batch.cells.length * 41252.96124941927 / (12 * 4 ** batch.order) <= 100);
  }
  const a = normalizeReverseSelector({ rectangle: { raStart: 1, raEnd: 1.00001, decMin: 1, decMax: 1.00001 }, boundaryOrder: 4 });
  const b = normalizeReverseSelector({ rectangle: { raStart: 1, raEnd: 1.00002, decMin: 1, decMax: 1.00002 }, boundaryOrder: 4 });
  assert.equal(a.region!.hash, b.region!.hash);
  assert.notDeepEqual(a.fingerprintSelector, b.fingerprintSelector);
  for (const body of [{ order: 4, cells: [1], region: selector.region }, { order: 4, rectangle: {} }, { region: selector.region, boundaryOrder: 8 }, { cells: [] }, { rectangle: {}, region: {} }]) assert.throws(() => normalizeReverseSelector(body));
  assert.equal(normalizeReverseSelector({ order: 8, cells: [123] }).kind, "cells");
});
