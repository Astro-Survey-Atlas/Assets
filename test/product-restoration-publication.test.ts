import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProductStore } from "../server/products.js";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { productGeometry, readApprovedRelease, buildApprovedRelease } from "../server/approved-release.js";
import { loadCatalog } from "../server/catalog.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import { reviewedFixture } from "./reviewed-fixture.js";

test("withdraw, restore, re-review and republish retains identity with a new package version", async () => {
  const f = await reviewedFixture();
  try {
    await writeFile(path.join(f.contentRoot, "product-content-v1.json"), JSON.stringify({ schemaVersion: 1, products: f.products }));
    const store = new ProductStore(undefined, f.contentRoot); await store.initialize(f.root);
    let root = f.root;
    const installed = path.join(f.base, "installed"); await mkdir(installed);
    const makePublisher = () => new PublicReleasePublisher({ ...f.options, baselineRoot: root, loadProducts: () => [store.get("product-1")] });
    const publish = async () => {
      const pub = makePublisher(), plan = await pub.plan();
      const run = await pub.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"], productIds: ["product-1"] });
      assert.equal(run.operation, store.get("product-1").retiredAt ? "withdraw" : "publish");
      const result = await pub.execute(run.runId); assert.equal(result.status, "published", result.error);
      await syncReleaseFromObjectStore(f.store, installed); root = path.join(installed, "current");
      const snapshot = await readApprovedRelease(root); store.projectPublished(snapshot.products, snapshot.generatedAt);
      return snapshot;
    };
    const first = await publish(); assert.ok(first.products[0]?.geometry);
    const record = store.get("product-1");
    await store.retire(record.productId, record.revision, "Replace evidence");
    const withdrawn = await publish(); assert.equal(withdrawn.products.length, 0);
    await store.restore(record.productId, record.revision, "Evidence checked, restore product");
    assert.equal(record.review, undefined); assert.equal(record.published, null);
    assert.equal((await makePublisher().plan()).surveys[0]?.selectable, false, "old review cannot republish");
    const baseline = await loadCatalog(root);
    const geometry = await productGeometry(record, { root, files: baseline.manifest.files, publications: [], publicationFile: () => "" });
    assert.ok(geometry); assert.ok(geometry.moc.maxOrder >= 4);
    await store.review(record.productId, record.revision, [], geometry.facts);
    const republished = await publish();
    assert.equal(republished.products[0]?.productId, first.products[0]?.productId);
    assert.ok(republished.products[0]!.revision > first.products[0]!.revision);
    assert.notEqual(republished.packages[0]?.version, first.packages[0]?.version, "restoration must not reuse a withdrawn package version");
    assert.ok(republished.withdrawals.some(w => w.productId === record.productId), "withdrawal remains in history");
    const history = await store.history(record.productId);
    assert.ok(history.some(e => (e as {action:string}).action === "restore"));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("restored products without bound geometry cannot bypass preflight through publication plan or candidate builder", async () => {
  const f = await reviewedFixture();
  try {
    const p = f.products[0]!; p.restoredAt = new Date().toISOString(); delete p.draft.layerId;
    p.review!.geometry = null;
    await assert.rejects(productGeometry(p, { root:f.root, files:f.files, publications:[], publicationFile:()=>"" }), /恢复产品.*原生 MOC/);
    const publisher = new PublicReleasePublisher(f.options), plan = await publisher.plan();
    assert.equal(plan.surveys[0]?.selectable, false);
    assert.match(plan.surveys[0]!.productDiffs[0]!.blockingReason!, /原生 MOC/);
    await assert.rejects(publisher.submit({ planId:plan.planId, expectedBaselineSha256:plan.baselineBundle.sha256, surveyIds:["m42"],productIds:[p.productId] }), /原生 MOC/);
    await assert.rejects(buildApprovedRelease({ root:f.root, files:f.files, publications:[], publicationFile:()=>"", products:[p], selected:[{productId:p.productId,revision:p.revision}], baseline:f.manifest, stagingRoot:path.join(f.base,"blocked"),runId:"blocked" }), /原生 MOC/);
  } finally { await rm(f.base, { recursive:true, force:true }); }
});
