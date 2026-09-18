import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { reviewedFixture } from "./reviewed-fixture.js";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import { sha256 } from "../server/native-moc.js";

async function port(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const p=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p;}

test("HTTP hot activation, frozen dossier, protected queries and atomic withdrawal without restart",async t=>{
 const f=await reviewedFixture(),installed=await mkdtemp(path.join(tmpdir(),"public-http-"));
 await symlink(f.root,path.join(installed,"current"));
 await writeFile(path.join(f.contentRoot,"product-content-v1.json"),JSON.stringify({schemaVersion:1,products:f.products}));
 const p=await port(),base=`http://127.0.0.1:${p}`;
 const child=spawn(process.execPath,[path.resolve("node_modules/tsx/dist/cli.mjs"),"server/server.ts"],{env:{...process.env,HOST:"127.0.0.1",PORT:String(p),ASSET_RELEASE_ROOT:path.join(installed,"current"),ASSETS_CONTENT_ROOT:f.contentRoot,ASSETS_WAREHOUSE_ES_URL:"",ASSETS_WORKSPACE_API_KEY:"test-service-key",PUBLIC_SITE_ROOT:path.resolve("site")},stdio:["ignore","pipe","pipe"]});
 let logs="";child.stderr?.on("data",b=>logs+=b);child.stdout?.on("data",b=>logs+=b);
 t.after(async()=>{if(child.exitCode===null)await new Promise<void>(r=>{child.once("exit",()=>r());child.kill();});await rm(f.base,{recursive:true,force:true});await rm(installed,{recursive:true,force:true});});
 const get=async(route:string)=>fetch(base+route);
 for(let i=0;i<150;i++){try{if((await get("/healthz")).ok)break;}catch{}if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,100));}
 assert.deepEqual((await (await get("/api/v1/products")).json() as any).products,[]);
 const publisher=new PublicReleasePublisher(f.options);
 const publish=async(pub:PublicReleasePublisher)=>{const plan=await pub.plan();const run=await pub.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"],productIds:["product-1"]});const result=await pub.execute(run.runId);assert.equal(result.status,"published",result.error);await syncReleaseFromObjectStore(f.store,installed);};
 await publish(publisher);
 let detail:Response|undefined;
 for(let i=0;i<70;i++){detail=await get("/api/v1/products/product-1");if(detail.ok)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(detail!.status,200,logs);const dossier=await detail!.json() as any;assert.equal(dossier.identity.productId,"product-1");
 const moc=await fetch(`${base}/api/v1/coverage/layers/${f.layerId}/moc.fits`,{headers:{Range:"bytes=0-15"}});assert.equal(moc.status,206);assert.equal(moc.headers.get("x-content-sha256"),f.moc.sha256);assert.equal((await moc.arrayBuffer()).byteLength,16);
 const catalog=await (await get("/api/v1/resource-packages/catalog.json")).json() as any;assert.equal(catalog.packages.length,1);
 const archive=await get(catalog.packages[0].archiveUrl);assert.equal(archive.status,200);assert.equal(sha256(new Uint8Array(await archive.arrayBuffer())),catalog.packages[0].sha256);
 const history=await (await get("/api/v1/releases")).json() as any;assert.equal(history.releases.length,1);assert.equal((await get(history.releases[0].collection.downloadUrl)).status,200);
 const body={purpose:"download-plan",region:{coordinateFrame:"ICRS",ordering:"NESTED",order:8,cells:[163327]},sources:[{surveyId:"m42",releaseId:"dr1",productId:"product-1",layerId:f.layerId,coverageRevision:f.moc.revision,indexRevision:null}],limit:10};
 const query=(headers:Record<string,string>,input=body)=>fetch(`${base}/api/v1/access/region-query`,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(input)});
 assert.equal((await query({})).status,401);
 const result=await query({"X-Assets-API-Key":"test-service-key"});assert.equal(result.status,200);const data=await result.json() as any;assert.deepEqual(data.sources[0].cells,[163327]);assert.equal(data.sources[0].accessAvailability,"geometry-only");assert.deepEqual(data.sources[0].downloads,[]);
 assert.equal((await query({"X-Assets-API-Key":"test-service-key"},{...body,sources:[{...body.sources[0]!,coverageRevision:"stale"}]})).status,409);
 const unlock=await fetch(`${base}/api/v1/access/unlock`,{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify({password:"123"})});assert.equal(unlock.status,200);const cookie=unlock.headers.get("set-cookie")!;assert.match(cookie,/HttpOnly/);assert.equal((await query({Origin:base,Cookie:cookie})).status,200);assert.equal((await query({Origin:"https://evil.invalid",Cookie:cookie})).status,403);
 // Mutable retirement alone must not hide the frozen public release.
 f.products[0]!.retiredAt=new Date().toISOString();f.products[0]!.retirementReason="Withdraw fixture";f.products[0]!.revision++;
 assert.equal((await get("/api/v1/products/product-1")).status,200);
 await publish(new PublicReleasePublisher({...f.options,baselineRoot:path.join(installed,"current")}));
 for(let i=0;i<70;i++){if((await get("/api/v1/products/product-1")).status===404)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal((await get("/api/v1/products/product-1")).status,404);assert.equal((await get(catalog.packages[0].archiveUrl)).status,404);assert.equal((await get(`/api/v1/coverage/layers/${f.layerId}/moc.fits`)).status,404);
});
