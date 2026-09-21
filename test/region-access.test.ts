import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { AccessGate, validateRegion, queryRegion } from "../server/region-access.js";
import { decodeNativeMoc,projectMoc } from "../server/native-moc.js";
import { fitsMoc,reviewedFixture } from "./reviewed-fixture.js";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import { loadCatalog } from "../server/catalog.js";
import { loadPublicState } from "../server/public-state.js";
import { rm } from "node:fs/promises";
import path from "node:path";
const input={purpose:"download-plan",region:{coordinateFrame:"ICRS",ordering:"NESTED",order:8,cells:[163327]},sources:[{surveyId:"m42",releaseId:"dr1",productId:"product-1",layerId:"m42-dr1-image",coverageRevision:"a".repeat(64),indexRevision:null}],limit:10};
test("native MOC canonical identity ignores packing and preserves true precision",()=>{
 const a=decodeNativeMoc(fitsMoc([{order:8,pixel:100}])),b=decodeNativeMoc(fitsMoc([400,401,402,403].map(pixel=>({order:9,pixel}))));
 assert.equal(a.revision,b.revision);assert.notEqual(a.sha256,b.sha256);assert.equal(a.maxOrder,8);
 assert.throws(()=>projectMoc(a,9),/Unsupported/);assert.deepEqual(projectMoc(b,8).cells,[100]);assert.equal(projectMoc(b,9,undefined,2).truncated,true);
 assert.throws(()=>decodeNativeMoc(fitsMoc([{order:8,pixel:100},{order:9,pixel:400}])) ,/Overlapping/);
 assert.throws(()=>decodeNativeMoc(fitsMoc([{order:14,pixel:1}])) ,/maximum O13/);
 assert.throws(()=>decodeNativeMoc(Buffer.from("not fits")),/Invalid/);
});
test("region validation rejects oversized, pseudo identity and ambiguous revisions",()=>{
 assert.equal(validateRegion(input).region.nside,256);
 for(const bad of [{...input,purpose:"scan"},{...input,region:{...input.region,nside:16}},{...input,region:{...input.region,order:0,cells:[1]}},{...input,region:{...input.region,cells:Array(4097).fill(1)}},{...input,sources:[{...input.sources[0],layerId:"public:desi"}]},{...input,sources:[{...input.sources[0],indexRevision:undefined}]},{...input,limit:1001}])assert.throws(()=>validateRegion(bad));
});
test("access sessions reject cross-origin requests and enforce concurrency and output quotas",()=>{
 const gate=new AccessGate("123","secret"),req=new IncomingMessage(new Socket());req.headers={host:"assets.test",origin:"http://assets.test"};
 assert.throws(()=>gate.identity(req),/Unlock/);assert.throws(()=>gate.unlock(req,"bad"),/Invalid/);
 const token=gate.unlock(req,"123");req.headers.cookie=`assets_download=${token}`;assert.match(gate.identity(req),/^browser:/);
 req.headers.origin="https://evil.test";assert.throws(()=>gate.identity(req),/Same-origin/);
 req.headers={"x-assets-api-key":"secret"};assert.equal(gate.identity(req),"service:workspace");
 const a=gate.begin("service:workspace"),b=gate.begin("service:workspace");assert.throws(()=>gate.begin("service:workspace"),/quota/);a.finish(10000);a.finish(0);b.finish(10000);
 for(let i=0;i<7;i++)gate.begin("service:workspace").finish(11000);
 assert.throws(()=>gate.begin("service:workspace"),/quota/);
});
test("region results remain bounded and never infer scientific files from geometry",async t=>{
 const f=await reviewedFixture();t.after(()=>rm(f.base,{recursive:true,force:true}));const p=new PublicReleasePublisher(f.options),plan=await p.plan();const run=await p.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"],productIds:["product-1"]});assert.equal((await p.execute(run.runId)).status,"published");
 const installed=path.join(f.base,"installed");await syncReleaseFromObjectStore(f.store,installed);const state=await loadPublicState(await loadCatalog(path.join(installed,"current")));
 const request={...input,sources:[{...input.sources[0]!,coverageRevision:f.moc.revision}]};
 const answer=await queryRegion(state,request,async()=>{throw Error("must not call an absent index");});assert.deepEqual(answer.sources[0]!.cells,[163327]);assert.deepEqual(answer.sources[0]!.downloads,[]);assert.equal(answer.sources[0]!.accessAvailability,"geometry-only");assert.ok(Date.parse(answer.expiresAt)-Date.now()<=600000);
 await assert.rejects(()=>queryRegion(state,input,async()=>null),/revision changed/);
 const g=state.snapshot.products[0]!.geometry!;g.indexRevision="b".repeat(64);
 const missing=await queryRegion(state,{...request,sources:[{...request.sources[0]!,indexRevision:g.indexRevision}]},async()=>null);assert.equal(missing.sources[0]!.accessAvailability,"unavailable");assert.equal(missing.sources[0]!.completeness,"incomplete");
});
test("multi-product download plans accept 13 layers without raising direct query or aggregate output limits",async t=>{
 const f=await reviewedFixture();t.after(()=>rm(f.base,{recursive:true,force:true}));
 const p=new PublicReleasePublisher(f.options),plan=await p.plan();const run=await p.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"],productIds:["product-1"]});assert.equal((await p.execute(run.runId)).status,"published");
 const installed=path.join(f.base,"installed");await syncReleaseFromObjectStore(f.store,installed);const state=await loadPublicState(await loadCatalog(path.join(installed,"current")));
 const template=state.snapshot.products[0]!;
 for(let i=1;i<13;i++){const copy=structuredClone(template);copy.productId=copy.content.productId=`product-${i+1}`;copy.geometry!.layerId=`layer-${i+1}`;state.snapshot.products.push(copy);state.geometry.set(copy.geometry!.layerId,f.moc);}
 const sources=state.snapshot.products.map(p=>({surveyId:p.content.surveyId,releaseId:p.content.releaseId,productId:p.productId,layerId:p.geometry!.layerId,coverageRevision:p.geometry!.coverageRevision,indexRevision:null}));
 const request={...input,sources};
 await assert.rejects(queryRegion(state,request,async()=>null),/1–8/);
 const response=await queryRegion(state,request,async()=>{throw Error("geometry-only is not a file index");},64);
 assert.equal(response.sources.length,13);assert.ok(response.sources.every(s=>s.accessAvailability==="geometry-only"&&Array.isArray(s.downloads)&&s.downloads.length===0));
 assert.ok(response.sources.reduce((n,s)=>n+(Array.isArray(s.cells)?s.cells.length:0),0)<=10000);
 assert.throws(()=>validateRegion({...request,sources:Array(65).fill(sources[0])},64),/1–64/);
 assert.throws(()=>validateRegion({...request,region:{...request.region,cells:Array(4097).fill(163327)}},64),/maximum 4096/);
 assert.throws(()=>validateRegion({...request,limit:1001},64),/1–1000/);
});
