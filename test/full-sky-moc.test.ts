import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fitsMoc, reviewedFixture } from "./reviewed-fixture.js";
import { decodeNativeMoc, isFullSkyMoc, projectMoc } from "../server/native-moc.js";
import { assertPublicCoverageMoc, assertPublicCoverageOrder } from "../server/coverage-policy.js";
import { displayOrders, mocPixelRanges, pixelsInTile } from "../server/display-coverage.js";
import { healpixList } from "../server/healpix-list.js";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { loadPublicState } from "../server/public-state.js";
import { loadCatalog } from "../server/catalog.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import { readResourcePackageManifest, readZipEntry } from "../server/resource-package-inspection.js";

const sky = Array.from({ length: 12 }, (_, pixel) => ({ order: 0, pixel }));
test("only decoded complete sky bypasses the low native order gate", () => {
  const moc = decodeNativeMoc(fitsMoc(sky));
  assert.equal(moc.maxOrder, 0); assert.deepEqual(moc.availableOrders, [0]);
  assert.equal(isFullSkyMoc(moc), true); assertPublicCoverageMoc(moc);
  assert.throws(() => assertPublicCoverageOrder(0));
  const incomplete = decodeNativeMoc(fitsMoc(sky.slice(1)));
  assert.equal(isFullSkyMoc(incomplete), false);
  assert.throws(() => assertPublicCoverageMoc(incomplete), /order 0/);
  assert.throws(() => projectMoc(incomplete, 4));
  assert.throws(() => decodeNativeMoc(fitsMoc([...sky, sky[0]!])), /duplicate/);
  // Equivalent packing also covers the sky exactly; no header flag is required.
  const mixed = decodeNativeMoc(fitsMoc([...sky.slice(1), ...[0,1,2,3].map(pixel => ({ order: 1, pixel }))]));
  assert.equal(isFullSkyMoc(mixed), true); assertPublicCoverageMoc(mixed);
});

test("full sky display and pagination stay bounded through O13 and retain native O0", () => {
  const moc = decodeNativeMoc(fitsMoc(sky));
  assert.deepEqual(displayOrders([0], moc), [4,5,6,7,8,9,10,11,12,13]);
  const ranges = mocPixelRanges(moc, 13);
  assert.deepEqual(ranges, [{ start: 0, end: 12 * 4 ** 13 }]);
  assert.equal(pixelsInTile(ranges, 0).length, 4096);
  assert.deepEqual(projectMoc(moc, 13, { order: 13, cells: [55, 800000000] }).cells, [55, 800000000]);
  assert.equal(projectMoc(moc, 13, undefined, 10).truncated, true);
  assert.throws(() => mocPixelRanges(moc, 14));
  const result = healpixList({ surveyId: "spherex", layers: [{ layerId: "cube", productId: "cube", releaseId: "dr1", moc }], order: 13, pageSize: 3, secret: "test" });
  assert.equal(result.status, 200);
  if (result.status === 200) {
    assert.deepEqual(result.pixels, [0,1,2]); assert.equal(result.total, 12 * 4 ** 13);
    assert.equal(result.layers[0]?.maxOrder, 0); assert.equal(result.page.hasMore, true);
  }
});

test("reviewed full-sky publication survives activation and keeps SDK v3 native metadata", async t => {
  const f = await reviewedFixture({ surveyId: "spherex", releaseId: "spherex-dr1", productName: "SPHEREx DR1 All-Sky Cube coverage", layerId: "spherex-dr1-allsky-cube-moc", mocCells: sky });
  t.after(() => rm(f.base, { recursive: true, force: true }));
  const publisher = new PublicReleasePublisher(f.options), plan = await publisher.plan();
  assert.equal(plan.surveys[0]?.selectable, true);
  const run = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["spherex"], productIds: ["product-1"] });
  const finished = await publisher.execute(run.runId);
  assert.equal(finished.status, "published", finished.error);
  await syncReleaseFromObjectStore(f.store, path.join(f.base, "installed"));
  const state = await loadPublicState(await loadCatalog(path.join(f.base, "installed/current")));
  const layer = state.coverage.records.get(f.layerId)!;
  assert.equal(layer.maxOrder, 0); assert.equal(layer.overviewOrder, 4);
  assert.equal(layer.cells.get(4)?.length, 3072); assert.equal(layer.cells.get(8)?.length, 786432);
  assert.equal(state.geometry.get(f.layerId)?.maxOrder, 0);
  const entry = [...state.catalog.files.values()].find(entry => entry.record.kind === "package")!;
  const bytes = await readFile(entry.absolutePath), manifest = await readResourcePackageManifest(bytes);
  assert.equal(manifest.layers[0]?.maxOrder, 0); assert.deepEqual(manifest.layers[0]?.availableOrders, [0]);
  assert.deepEqual(await readZipEntry(bytes, manifest.layers[0]!.path), f.bytes);
  for (const order of [4,8]) {
    const sidecar = JSON.parse((await readZipEntry(bytes, `healpix/order${order}.json`)).toString());
    assert.equal(sidecar.layers.length, 0);
    assert.equal(sidecar.surveyUnion.omittedLayers[0].layerId, f.layerId);
    assert.equal(sidecar.surveyUnion.completeness, "incomplete");
  }
});
