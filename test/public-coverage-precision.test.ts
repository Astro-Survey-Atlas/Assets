import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { buildApprovedRelease, productGeometry } from "../server/approved-release.js";
import { publicReleaseBundleDigest } from "../server/catalog.js";
import { sha256 } from "../server/native-moc.js";
import { footprintManifest, type CoverageLayer } from "../site/src/atlas-coverage-globe.js";
import { fitsMoc, reviewedFixture } from "./reviewed-fixture.js";

for (const order of [0, 3, 4, 8]) {
  test(`publication checks actual native MOC precision at order ${order}`, async () => {
    const fixture = await reviewedFixture();
    try {
      // Mixed-order MOCs may contain coarse interior cells; the finest actual
      // cells set the native precision, not the minimum cell order.
      const bytes = fitsMoc(order === 0 ? [{ order: 0, pixel: 0 }] : [{ order: 0, pixel: 0 }, { order, pixel: 4 ** order }]);
      const file = fixture.files.find(file => file.kind === "moc")!;
      await writeFile(path.join(fixture.root, file.path), bytes);
      file.sha256 = sha256(bytes); file.sizeBytes = bytes.length;
      const work = productGeometry(fixture.products[0]!, { root: fixture.root, files: fixture.files, publications: [], publicationFile: () => "" });
      if (order < 4) {
        await assert.rejects(work, /order 4/);
        fixture.manifest.bundle.sha256 = publicReleaseBundleDigest(fixture.files);
        await writeFile(path.join(fixture.root, "artifacts/public-survey-footprints/release-manifest.json"), JSON.stringify(fixture.manifest));
        const publisher = new PublicReleasePublisher(fixture.options);
        const plan = await publisher.plan();
        assert.equal(plan.surveys[0]?.selectable, false);
        assert.match(plan.surveys[0]!.productDiffs[0]!.blockingReason!, /order 4/);
        await assert.rejects(publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"], productIds: ["product-1"] }), /order 4/);
        await assert.rejects(buildApprovedRelease({ ...fixture.options, root: fixture.root, publications: [], publicationFile: () => "", files: fixture.files, baseline: fixture.manifest, products: fixture.products, selected: [{ productId: "product-1", revision: 1 }], stagingRoot: path.join(fixture.base, "candidate"), runId: "low-precision" }), /order 4/);
      }
      else assert.equal((await work)?.moc.maxOrder, order);
    } finally { await rm(fixture.base, { recursive: true, force: true }); }
  });
}

test("a legacy order-0 layer cannot coarsen other globe previews or invent finer cells", () => {
  const layer = (id: string, order: number): CoverageLayer => ({ layerId: id, productId: id, surveyId: id, releaseId: "dr1", product: id, color: "#123456", availableOrders: [order], overviewOrder: order, maxOrder: order, cellCount: 1, areaDeg2: 1, tileScheme: "nested" });
  const fine = layer("fine", 4), coarse = layer("coarse", 0);
  const catalog = { schemaVersion: 1, coordinateFrame: "ICRS", ordering: "NESTED", tileScheme: "nested", layers: [fine, coarse] };
  const blocks = new Map([["fine:4", [900, 901]], ["coarse:0", [0]]]);
  const manifest = footprintManifest(catalog, blocks);
  assert.equal(manifest.nside, 16);
  assert.deepEqual(manifest.footprints.map(row => [row.surveyId, row.nside, row.pixels]), [["fine", 16, [900, 901]]]);
  assert.deepEqual(footprintManifest({ ...catalog, layers: [coarse] }, blocks).footprints, []);
});
