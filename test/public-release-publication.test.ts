import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewedFixture } from "./reviewed-fixture.js";
import { PublicReleasePublisher, type PublicationRun } from "../server/public-release-publication.js";
import { loadCatalog } from "../server/catalog.js";
import { loadPublicState } from "../server/public-state.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import { readResourcePackageManifest, readZipEntry } from "../server/resource-package-inspection.js";
import { sha256 } from "../server/native-moc.js";

async function queue(publisher:PublicReleasePublisher) {
  const plan=await publisher.plan();
  return publisher.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"],productIds:["product-1"]});
}

test("publication requires explicit reviewed versions; legacy published/ACTIVE does not grant access",async t=>{
  const f=await reviewedFixture();t.after(()=>rm(f.base,{recursive:true,force:true}));
  const state=await loadPublicState(await loadCatalog(f.root));assert.equal(state.index.surveys.length,0);assert.equal(state.catalog.files.size,0);
  const publisher=new PublicReleasePublisher(f.options),plan=await publisher.plan();
  assert.equal(plan.surveys[0]!.selectable,true);
  await assert.rejects(()=>publisher.submit({planId:"stale",expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"],productIds:["product-1"]}),/stale/);
  await assert.rejects(()=>publisher.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"]}),/explicit/);
  delete f.products[0]!.review;
  const blocked=await publisher.plan();assert.equal(blocked.surveys[0]!.selectable,false);
  await assert.rejects(()=>queue(publisher),/Blocked/);
});

test("whole publication verifies and activates package, native geometry and product as one snapshot",async t=>{
  const f=await reviewedFixture();t.after(()=>rm(f.base,{recursive:true,force:true}));
  const publisher=new PublicReleasePublisher(f.options),run=await queue(publisher);
  assert.equal(await publisher.claimQueuedRun(),run.runId);
  const finished=await publisher.execute(run.runId);assert.equal(finished.status,"published",finished.error);
  await syncReleaseFromObjectStore(f.store,path.join(f.base,"installed"));
  const catalog=await loadCatalog(path.join(f.base,"installed/current")),state=await loadPublicState(catalog);
  assert.equal(state.records.size,1);assert.equal(state.geometry.get(f.layerId)?.revision,f.moc.revision);
  assert.equal(state.index.surveys[0]?.releases[0]?.products[0]?.productId,"product-1");
  const packages=[...state.catalog.files.values()].filter(f=>f.record.kind==="package");assert.equal(packages.length,1);
  const bytes=await readFile(packages[0]!.absolutePath),manifest=await readResourcePackageManifest(bytes);
  assert.equal(manifest.layers[0]?.productId,"product-1");assert.equal(manifest.layers[0]?.coverageRevision,f.moc.revision);
  assert.deepEqual(await readZipEntry(bytes,manifest.layers[0]!.path),f.bytes);
  assert.equal(state.catalog.files.has("manifest-canonical"),false,"private baseline stays unavailable");
  const history=JSON.parse(await readFile(path.join(catalog.root,"artifacts/public-survey-footprints/release-history.json"),"utf8"));
  assert.equal(history.releases[0].packages[0].sha256,sha256(bytes));
  assert.equal((await new PublicReleasePublisher(f.options).get(run.runId))?.status,"published","durable run survives process restart");
});

test("a publication interrupted after claim is released and can be retried", async t => {
  const f = await reviewedFixture();
  t.after(() => rm(f.base, { recursive: true, force: true }));
  const publisher = new PublicReleasePublisher({ ...f.options, publicationLeaseMs: 1_000 });
  const run = await queue(publisher);
  assert.equal(await publisher.claimQueuedRun(), run.runId);
  const runPath = path.join(f.base, "content", "publication", "runs", `${run.runId}.json`);
  const staleAt = new Date(Date.now() - 10_000).toISOString();
  await writeFile(runPath, `${JSON.stringify({ ...run, status: "uploading", startedAt: staleAt, claimedAt: staleAt, lastProgressAt: staleAt }, null, 2)}\n`);

  const [released] = await publisher.list();
  assert.equal(released?.runId, run.runId);
  assert.equal(released?.status, "failed");
  assert.match(released?.error ?? "", /worker.*中断|interrupted/i);
  await assert.rejects(() => stat(path.join(f.base, "content", "publication", "queue", `${run.runId}.claimed.json`)), { code: "ENOENT" });

  const retry = await publisher.retry(run.runId);
  assert.notEqual(retry.runId, run.runId);
  assert.equal(retry.status, "queued");
});

test("a fresh active publication is not mistaken for an interrupted worker", async t => {
  const f = await reviewedFixture();
  t.after(() => rm(f.base, { recursive: true, force: true }));
  const publisher = new PublicReleasePublisher({ ...f.options, publicationLeaseMs: 60_000 });
  const run = await queue(publisher);
  await publisher.claimQueuedRun();
  const runPath = path.join(f.base, "content", "publication", "runs", `${run.runId}.json`);
  const now = new Date().toISOString();
  await writeFile(runPath, `${JSON.stringify({ ...run, status: "uploading", startedAt: now, claimedAt: now, lastProgressAt: now }, null, 2)}\n`);
  const [observed] = await publisher.list();
  assert.equal(observed?.status, "uploading");
  assert.equal(observed?.recovery, undefined);
});

test("changed revision or tampered geometry fails before activation",async t=>{
  const f=await reviewedFixture();t.after(()=>rm(f.base,{recursive:true,force:true}));
  const publisher=new PublicReleasePublisher(f.options),run=await queue(publisher);
  f.products[0]!.revision++;
  let finished=await publisher.execute(run.runId);assert.equal(finished.status,"failed");assert.match(finished.error??"",/changed/);
  await assert.rejects(()=>readFile(path.join(f.base,"store/public/current.json")));
  f.products[0]!.revision--;
  const second=await queue(publisher);
  await writeFile(path.join(f.root,f.files[0]!.path),Buffer.alloc(f.bytes.length));
  finished=await publisher.execute(second.runId);assert.equal(finished.status,"failed");assert.match(finished.error??"",/checksum/);
  await assert.rejects(()=>readFile(path.join(f.base,"store/public/current.json")));
});

test("unselected drafts do not block reviewed products or leak into a release",async t=>{
  const f=await reviewedFixture();t.after(()=>rm(f.base,{recursive:true,force:true}));
  const draft=structuredClone(f.products[0]!);draft.productId="unreviewed";draft.draft.productId="unreviewed";delete draft.review;f.products.push(draft);
  const p=new PublicReleasePublisher(f.options),plan=await p.plan();assert.equal(plan.surveys[0]!.selectable,true);
  await assert.rejects(()=>p.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"],productIds:["unreviewed"]}),/reviewed/);
  const run=await queue(p),result=await p.execute(run.runId);assert.equal(result.status,"published",result.error);
  await syncReleaseFromObjectStore(f.store,path.join(f.base,"installed"));const state=await loadPublicState(await loadCatalog(path.join(f.base,"installed/current")));
  assert.deepEqual([...state.records.keys()],["product-1"]);
});

test("explicit withdrawal removes public products and packages, retained version survives unrelated drafts",async t=>{
  const f=await reviewedFixture();t.after(()=>rm(f.base,{recursive:true,force:true}));
  const p=new PublicReleasePublisher(f.options),r=await queue(p);assert.equal((await p.execute(r.runId)).status,"published");
  const installed=path.join(f.base,"installed");await syncReleaseFromObjectStore(f.store,installed);
  const next=new PublicReleasePublisher({...f.options,baselineRoot:path.join(installed,"current")});
  const product=f.products[0]!;product.retiredAt=new Date().toISOString();product.retirementReason="Test withdrawal";product.revision++;
  const plan=await next.plan();assert.equal(plan.surveys[0]!.productDiffs[0]?.change,"removed");
  const queued=await queue(next),finished=await next.execute(queued.runId);assert.equal(finished.status,"published",finished.error);
  await syncReleaseFromObjectStore(f.store,installed);const state=await loadPublicState(await loadCatalog(path.join(installed,"current")));
  assert.equal(state.records.size,0);assert.equal(state.snapshot.packages.length,0);assert.equal(state.snapshot.withdrawals[0]?.reason,"Test withdrawal");
});


test("successful publication never reports failed verification while building or uploading", async t => {
  const f = await reviewedFixture();
  t.after(() => rm(f.base, { recursive: true, force: true }));
  const runs = new Map<string, PublicationRun>();
  const progress: PublicationRun[] = [];
  const publisher = new PublicReleasePublisher({ ...f.options, runRepository: {
    get: async id => runs.get(id), list: async () => [...runs.values()],
    submit: async run => { runs.set(run.runId, run); return run; },
    write: async run => { runs.set(run.runId, run); progress.push(structuredClone(run)); },
  } });
  const run = await queue(publisher);
  const result = await publisher.execute(run.runId);
  assert.equal(result.status, "published", result.error);
  for (const status of ["building", "uploading", "verifying"]) {
    const updates = progress.filter(run => run.status === status);
    assert.ok(updates.length > 0, `observed ${status}`);
    for (const update of updates) assert.equal(update.verification?.overall, "pending", `${status} must not display failure before verification`);
  }
});
