import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewedFixture } from "./reviewed-fixture.js";
import { packageRelease } from "../scripts/release-archive.js";
import { publishReleaseArchive } from "../server/artifact-store.js";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { parseCurrentPointer, syncReleaseFromObjectStore } from "../server/sync-release.js";
import { loadCatalog } from "../server/catalog.js";
import { loadPublicState } from "../server/public-state.js";

async function queued(publisher: PublicReleasePublisher) {
  const plan = await publisher.plan();
  return publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"], productIds: ["product-1"] });
}

test("legacy archive transitions to object publication without uploading unchanged baseline or tar; clean restore works", async t => {
  const f = await reviewedFixture(); t.after(() => rm(f.base, {recursive:true,force:true}));
  const archive = await packageRelease({ root:f.root, outputPath:path.join(f.base,"baseline.tar.gz") });
  await publishReleaseArchive(archive, f.store);
  const uploaded: string[] = [];
  const put = f.store.putFileImmutable.bind(f.store);
  f.store.putFileImmutable = async (key, file, options) => { uploaded.push(key); return put(key,file,options); };
  const publisher = new PublicReleasePublisher(f.options);
  const [first, duplicate] = await Promise.all([queued(publisher),queued(publisher)]);
  assert.equal(first.runId,duplicate.runId,"concurrent duplicate uses the active run");
  const run = await publisher.execute(first.runId);
  assert.equal(run.status,"published",run.error);
  assert.ok(uploaded.length);
  assert.ok(uploaded.every(key=>key.startsWith("public/objects/sha256/")));
  const unchanged = f.files.find(file=>file.id==="survey-catalog")!;
  assert.ok(!uploaded.includes(`public/objects/sha256/${unchanged.sha256}`));
  const pointer = parseCurrentPointer((await f.store.get("public/current.json"))!.body);
  assert.equal(pointer.schemaVersion,3);
  await syncReleaseFromObjectStore(f.store,path.join(f.base,"clean-install"));
  const state = await loadPublicState(await loadCatalog(path.join(f.base,"clean-install/current")));
  assert.equal(state.records.size,1);
  assert.equal(state.geometry.get(f.layerId)?.revision,f.moc.revision);
  // Corrupt one immutable member; current stays on the previously installed release.
  const key = uploaded[0]!;
  await writeFile(path.join(f.base,"store",key),"corrupt");
  await assert.rejects(()=>syncReleaseFromObjectStore(f.store,path.join(f.base,"second-clean-install")),/checksum|SHA|hash/i);
  const still = await loadPublicState(await loadCatalog(path.join(f.base,"clean-install/current")));
  assert.equal(still.records.size,1);
});
