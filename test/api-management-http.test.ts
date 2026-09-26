import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import http from "node:http";
import { proxyAdmin } from "../server/admin-proxy.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import net from "node:net";
import { reviewedFixture } from "./reviewed-fixture.js";

test("API management HTTP authorization and managed region requests preserve anonymous catalog and legacy keys", async t => {
 const f = await reviewedFixture({coverageEvidence:{evidenceKind:"observation-footprint",sourceIdentity:"MAST observation fixture-26442812",instrument:"ACS/WFC",filters:"F606W",sourceSnapshotSha256:"a".repeat(64),precision:"estimated",completeness:"incomplete",scienceFileScan:"not-scanned",summary:"Estimated archive observation footprint; no science files were scanned."}});
 const publisher = new PublicReleasePublisher(f.options), plan = await publisher.plan();
 const run = await publisher.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:["m42"],productIds:["product-1"]});
 assert.equal((await publisher.execute(run.runId)).status,"published");
 const installed=path.join(f.base,"installed");await syncReleaseFromObjectStore(f.store,installed);
 let warehouseEdges: Array<Record<string, unknown>> = [];
 let warehouseFiles: Array<Record<string, unknown>> = [];
 let warehouseCoverageReportedTotal: number|undefined;
 let warehouseCoverageFailureStatus: number|undefined;
 let warehouseCoverageMalformedJson=false;
 let warehouseLayerActive=true;
 const warehouseCoverageQueries: Array<Record<string,any>> = [];
 const warehouse = http.createServer((req,res) => {
  let raw="";
  req.setEncoding("utf8");
  req.on("data",chunk=>raw+=chunk);
  req.on("end",()=>{
   const body=JSON.parse(raw) as Record<string,any>;
   const index=String(req.url??"").split("/")[1];
   const respond=(sources:Array<Record<string,unknown>>,total=sources.length)=>{res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({hits:{total:{value:total},hits:sources.map((source,i)=>({_id:String(source.edge_id??i),_source:source}))}}));};
   if(index==="ast_layer_index_v1") return respond([{layer_id:f.layerId,state:warehouseLayerActive?"ACTIVE":"CANDIDATE"}]);
   if(index==="ast_coverage_index_v1"){
    warehouseCoverageQueries.push(body);
    if(warehouseCoverageFailureStatus){res.writeHead(warehouseCoverageFailureStatus,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"fixture Warehouse outage"}));return;}
    if(warehouseCoverageMalformedJson){res.writeHead(200,{"Content-Type":"application/json"});res.end("{");return;}
    const excluded=(body.query?.bool?.must_not??[]).flatMap((clause:any)=>clause.terms?.source_file_id??[]);
    const matched=warehouseEdges.filter(edge=>!excluded.includes(edge.source_file_id)).sort((a,b)=>String(a.source_file_id).localeCompare(String(b.source_file_id)));
    return respond(matched.slice(0,Number(body.size??1000)),warehouseCoverageReportedTotal??matched.length);
   }
   if(index==="ast_file_index_v1"){
    const ids=new Set((body.query?.bool?.should??[]).flatMap((clause:any)=>clause.ids?.values??clause.terms?.file_id??[]));
    return respond(warehouseFiles.filter(file=>ids.has(file.file_id)));
   }
   return respond([]);
  });
 });
 await new Promise<void>(r=>warehouse.listen(0,"127.0.0.1",r));
 const warehouseUrl=`http://127.0.0.1:${(warehouse.address() as net.AddressInfo).port}`;
 t.after(()=>new Promise<void>(r=>warehouse.close(()=>r())));
 const socket = net.createServer(); await new Promise<void>(r=>socket.listen(0,"127.0.0.1",r)); const port=(socket.address() as net.AddressInfo).port; await new Promise<void>(r=>socket.close(()=>r()));
 const child=spawn(process.execPath,[path.resolve("node_modules/tsx/dist/cli.mjs"),"server/server.ts"],{env:{...process.env,HOST:"127.0.0.1",PORT:String(port),ASSET_RELEASE_ROOT:path.join(installed,"current"),ASSETS_CONTENT_ROOT:f.contentRoot,ASSETS_EVIDENCE_ROOT:path.join(f.base,"evidence"),ASSETS_ADMIN_ENABLED:"true",ASSETS_ADMIN_TOKEN:"fixture",ASSETS_WORKSPACE_API_KEY:"legacy-workspace",ASSETS_API_MASTER_KEY:randomBytes(32).toString("base64"),ASSETS_LLM_API_KEY:"",ASSETS_WAREHOUSE_ES_URL:warehouseUrl,ASSETS_KUBE_API_URL:"http://127.0.0.1:9"},stdio:["ignore","pipe","pipe"]});
 let logs="";child.stderr.on("data",c=>logs+=c);child.stdout.on("data",c=>logs+=c);
 t.after(async()=>{if(child.exitCode===null)await new Promise<void>(r=>{child.once("exit",()=>r());child.kill();});await rm(f.base,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${port}`;for(let i=0;i<100;i++){try{if((await fetch(base+"/healthz")).ok)break;}catch{}if(child.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,100));}
 const route="/api/v1/admin/api-management", auth={Authorization:"Bearer fixture","Content-Type":"application/json"};
 assert.equal((await fetch(base+route)).status,401);
 const created=await fetch(base+route+"/keys",{method:"POST",headers:auth,body:JSON.stringify({name:"fixture",scopes:["region:query"],perMinute:2})});assert.equal(created.status,201);assert.equal(created.headers.get("cache-control"),"no-store");const key=await created.json();
 const view=await (await fetch(base+route,{headers:auth})).json();assert.equal(JSON.stringify(view).includes(key.key),false);
 const query=(token:string)=>fetch(base+"/api/v1/access/region-query",{method:"POST",headers:{"X-Assets-API-Key":token,"Content-Type":"application/json"},body:"{}"});
 assert.equal((await query("asa_live_unknown")).status,401);
 assert.equal((await query(key.key)).status,400,"authorized key reaches region validation");
 assert.equal((await query(key.key)).status,400);assert.equal((await query(key.key)).status,429);
 assert.equal((await query("legacy-workspace")).status,400,"legacy access unchanged");
 assert.equal((await fetch(base+route,{headers:{Authorization:`Bearer ${key.key}`}})).status,401,"managed key cannot administer");
 assert.equal((await fetch(base+"/api/v1/assets")).status,200);
 assert.equal((await fetch(base+route+`/keys/${key.id}/revoke`,{method:"POST",headers:auth})).status,200);
 assert.equal((await query(key.key)).status,401);
 const after=await (await fetch(base+route,{headers:auth})).json();assert.equal(after.keys[0].requests,4);assert.equal(after.keys[0].errors,4);
 // Browser enters a Key once, then uses an HttpOnly session through the site proxy.
 const issued=await (await fetch(base+route+"/keys",{method:"POST",headers:auth,body:JSON.stringify({name:"globe",scopes:["region:query"],perMinute:30})})).json();
 const proxy=http.createServer((req,res)=>proxyAdmin(req,res,base,true));await new Promise<void>(r=>proxy.listen(0,"127.0.0.1",r));
 t.after(()=>new Promise<void>(r=>proxy.close(()=>r())));
 const publicBase=`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
 const previewBody={layerIds:[f.layerId],order:8,cells:[163327],preview:true};
 const preview=await fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,"Content-Type":"application/json"},body:JSON.stringify(previewBody)});
 assert.equal(preview.status,200,"anonymous overlap preview is available");
 assert.equal((await preview.json()).preview.limit,6);
 const unauthenticatedPlan=await fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,"Content-Type":"application/json"},body:JSON.stringify({...previewBody,preview:false})});
 assert.equal(unauthenticatedPlan.status,401,"full reverse lookup requires an API Key");
 const unlock=(origin:string)=>fetch(publicBase+"/api/v1/access/unlock",{method:"POST",headers:{Origin:origin,"X-Assets-API-Key":issued.key,"Content-Type":"application/json"},body:"{}"});
 assert.equal((await unlock("https://other.example")).status,403);
 const unlocked=await unlock(publicBase);assert.equal(unlocked.status,200);const cookie=unlocked.headers.get("set-cookie")!;
 assert.match(cookie,/assets_download=managed\./);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.equal(cookie.includes(issued.key),false);
 const browserQuery=(path:string,origin=publicBase)=>fetch(publicBase+path,{method:"POST",headers:{Origin:origin,Cookie:cookie.split(";")[0]!,"Content-Type":"application/json"},body:"{}"});
 assert.equal((await browserQuery("/api/v1/access/region-query")).status,400,"session reaches region validator");
 const reverse=await browserQuery("/api/v1/coverage/reverse-lookup");assert.equal(reverse.status,400);assert.equal((await reverse.json()).error,"layerIds required","preserve reverse-lookup input contract");
 const validPlan=await fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,Cookie:cookie.split(";")[0]!,"Content-Type":"application/json"},body:JSON.stringify({layerIds:[f.layerId],order:8,cells:[163327]})});
 assert.equal(validPlan.status,200);const data=await validPlan.json();assert.equal(data.sources[0].layerId,f.layerId);assert.ok(data.downloadPlan);assert.deepEqual(data.downloadPlan.files,[],"authorization never invents missing science file indices");
 const pageRequest=(cursor?:string)=>fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,"Content-Type":"application/json"},body:JSON.stringify({...previewBody,...(cursor?{cursor}:{})})});
 const protectedPageRequest=(cursor:string,pageSize=6)=>fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,Cookie:cookie.split(";")[0]!,"Content-Type":"application/json"},body:JSON.stringify({...previewBody,preview:false,pageSize,cursor})});
 warehouseEdges=Array.from({length:7},(_,i)=>({edge_id:`file-a-edge-${i}`,layer_id:f.layerId,source_file_id:"file-a",healpix_order:8,healpix_cell:163327,precision:"exact"}));
 warehouseEdges.push({edge_id:"file-b-edge-0",layer_id:f.layerId,source_file_id:"file-b",healpix_order:8,healpix_cell:163327,precision:"exact"});
 warehouseFiles=["file-a","file-b"].map(file_id=>({file_id,file_name:`${file_id}.fits`,source_uri:`s3://survey/${file_id}.fits`}));
 const edgeLimitedResponse=await pageRequest();assert.equal(edgeLimitedResponse.status,200);const edgeLimited=await edgeLimitedResponse.json();
 assert.equal(edgeLimited.downloadPlan.files.find((file:{fileId:string})=>file.fileId==="file-a")?.matchingCoverageTruncated,true,"the visible file explains when its edge list hit the Warehouse limit");
 assert.ok(edgeLimited.downloadPlan.warnings.some((warning:string)=>warning.includes("Matching coverage for file file-a")));
 assert.ok(edgeLimited.page.nextCursor,"the preview cursor can seed an API-Key-authorized continuation");
 const anonymousContinuation=await pageRequest(edgeLimited.page.nextCursor);assert.equal(anonymousContinuation.status,400,"anonymous previews cannot continue with a cursor");
 warehouseCoverageFailureStatus=503;
 const failedContinuation=await protectedPageRequest(edgeLimited.page.nextCursor);const failedContinuationData=await failedContinuation.json();
 assert.equal(failedContinuation.status,503,"a transient Warehouse failure must leave an authenticated continuation retryable");
 assert.equal(failedContinuation.headers.get("retry-after"),"1");
 assert.match(failedContinuationData.error,/retry.*same cursor/i);
 const failedFirstPage=await fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,Cookie:cookie.split(";")[0]!,"Content-Type":"application/json"},body:JSON.stringify({...previewBody,preview:false})});
 assert.equal(failedFirstPage.status,503,"a transient Warehouse failure must not become an apparently complete first page");
 assert.equal(failedFirstPage.headers.get("retry-after"),"1");
 warehouseCoverageFailureStatus=undefined;
 warehouseCoverageMalformedJson=true;
 const unexpectedFailure=await protectedPageRequest(edgeLimited.page.nextCursor);assert.equal(unexpectedFailure.status,503,"unexpected Warehouse lookup failures must also remain retryable");
 assert.equal(unexpectedFailure.headers.get("retry-after"),"1");
 warehouseCoverageMalformedJson=false;
 warehouseLayerActive=false;
 const unindexedFallback=await fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,Cookie:cookie.split(";")[0]!,"Content-Type":"application/json"},body:JSON.stringify({...previewBody,preview:false})});
 assert.equal(unindexedFallback.status,200,"a genuinely unindexed layer retains its source/coverage fallback");
 const unindexedData=await unindexedFallback.json();assert.deepEqual(unindexedData.downloadPlan.files,[]);assert.ok(unindexedData.downloadPlan.coverageEvidence.length>0);assert.equal(unindexedData.downloadPlan.coverageEvidence[0].evidenceKind,"observation-footprint");assert.equal(unindexedData.downloadPlan.coverageEvidence[0].sourceIdentity,"MAST observation fixture-26442812");assert.equal(unindexedData.downloadPlan.coverageEvidence[0].scienceFileScan,"not-scanned");
 warehouseLayerActive=true;
 const retriedContinuation=await protectedPageRequest(edgeLimited.page.nextCursor);assert.equal(retriedContinuation.status,200,"the original cursor can be retried after Warehouse recovery");
 assert.deepEqual((await retriedContinuation.json()).downloadPlan.files.map((file:{fileId:string})=>file.fileId),["file-b"]);
 warehouseEdges=[];warehouseCoverageReportedTotal=100;
 const stalledResponse=await protectedPageRequest(edgeLimited.page.nextCursor);assert.equal(stalledResponse.status,200);const stalled=await stalledResponse.json();
 assert.equal(stalled.page.nextCursor,undefined,"a page without new manifest keys must not repeat the same cursor");
 assert.equal(stalled.truncated,true);assert.ok(stalled.downloadPlan.warnings.some((warning:string)=>warning.includes("no new manifest items")));
 warehouseCoverageReportedTotal=undefined;
 warehouseEdges=Array.from({length:7},(_,i)=>({edge_id:`file-a-edge-${i}`,layer_id:f.layerId,source_file_id:"file-a",healpix_order:8,healpix_cell:163327,precision:"exact"}));
 for(const fileId of ["file-b","file-c","file-d","file-e"]) warehouseEdges.push({edge_id:`${fileId}-edge-0`,layer_id:f.layerId,source_file_id:fileId,healpix_order:8,healpix_cell:163327,precision:"exact"});
 warehouseFiles=["file-a","file-b","file-c","file-d","file-e"].map(file_id=>({file_id,file_name:`${file_id}.fits`,source_uri:`s3://survey/${file_id}.fits`}));
 const authorizedStart=await protectedPageRequest(edgeLimited.page.nextCursor,1);assert.equal(authorizedStart.status,200);const authorizedPage=await authorizedStart.json();
 assert.deepEqual(authorizedPage.downloadPlan.files.map((file:{fileId:string})=>file.fileId),["file-b"]);
 assert.ok(authorizedPage.page.nextCursor,"the next cursor is issued after authorization");
 const boundCursorResponse=await fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,Cookie:cookie.split(";")[0]!,"Content-Type":"application/json"},body:JSON.stringify({...previewBody,preview:false,pageSize:1,cursor:authorizedPage.page.nextCursor})});
 assert.equal(boundCursorResponse.status,200,"subsequent protected pages accept their identity-bound cursor");
 const otherKey=await (await fetch(base+route+"/keys",{method:"POST",headers:auth,body:JSON.stringify({name:"other browser",scopes:["region:query"],perMinute:10})})).json();
 const otherUnlock=await fetch(publicBase+"/api/v1/access/unlock",{method:"POST",headers:{Origin:publicBase,"X-Assets-API-Key":otherKey.key,"Content-Type":"application/json"},body:"{}"});assert.equal(otherUnlock.status,200);
 const otherCursorResponse=await fetch(publicBase+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:publicBase,Cookie:otherUnlock.headers.get("set-cookie")!.split(";")[0]!,"Content-Type":"application/json"},body:JSON.stringify({...previewBody,preview:false,pageSize:1,cursor:authorizedPage.page.nextCursor})});
 assert.equal(otherCursorResponse.status,403,"an authenticated continuation cursor is bound to its API Key identity");
 assert.ok(warehouseCoverageQueries.some(query=>query.query.bool.must_not?.some((clause:any)=>clause.terms?.source_file_id?.includes("file-a"))),"authorized continuation excludes the previewed file in Warehouse");

 warehouseEdges=Array.from({length:8},(_,fileIndex)=>Array.from({length:2},(_,edgeIndex)=>({edge_id:`file-${String(fileIndex).padStart(2,"0")}-edge-${edgeIndex}`,layer_id:f.layerId,source_file_id:`file-${String(fileIndex).padStart(2,"0")}`,healpix_order:8,healpix_cell:163327,precision:"exact"}))).flat();
 warehouseFiles=Array.from({length:8},(_,fileIndex)=>{const file_id=`file-${String(fileIndex).padStart(2,"0")}`;return {file_id,file_name:`${file_id}.fits`,source_uri:`s3://survey/${file_id}.fits`};});
 const seenFileIds=new Set<string>(),seenEntrypoints=new Set<string>(),seenCoverage=new Set<string>();
 const multiFilePreview=await pageRequest();assert.equal(multiFilePreview.status,200);const multiFilePreviewData=await multiFilePreview.json();
 const collectPage=(pageData:any)=>{
  assert.ok(pageData.downloadPlan.files.length+pageData.downloadPlan.entrypoints.length+(pageData.downloadPlan.coverageEvidence?.length??0)<=6);
  for(const file of pageData.downloadPlan.files){assert.ok(!seenFileIds.has(file.fileId),`duplicate file ${file.fileId}`);seenFileIds.add(file.fileId);}
  for(const entry of pageData.downloadPlan.entrypoints){const key=JSON.stringify([entry.kind,entry.layerId,entry.url,entry.sourceUri]);assert.ok(!seenEntrypoints.has(key),`duplicate entrypoint ${key}`);seenEntrypoints.add(key);}
  for(const evidence of pageData.downloadPlan.coverageEvidence??[]){const key=`${evidence.layerId}:${evidence.order}`;assert.ok(!seenCoverage.has(key),`duplicate coverage evidence ${key}`);seenCoverage.add(key);}
 };
 collectPage(multiFilePreviewData);
 let pageCursor:string|undefined=multiFilePreviewData.page.nextCursor;
 for(let pageNumber=0;pageNumber<6&&pageCursor;pageNumber++){
  const pageResponse=await protectedPageRequest(pageCursor);assert.equal(pageResponse.status,200);const pageData=await pageResponse.json();
  collectPage(pageData);
  pageCursor=pageData.page.nextCursor;
 }
 assert.deepEqual([...seenFileIds].sort(),Array.from({length:8},(_,fileIndex)=>`file-${String(fileIndex).padStart(2,"0")}`));
 assert.equal((await browserQuery("/api/v1/coverage/reverse-lookup","https://other.example")).status,403);
 await fetch(base+route+`/keys/${issued.id}/revoke`,{method:"POST",headers:auth});
 assert.equal((await browserQuery("/api/v1/access/region-query")).status,401,"revoke invalidates already unlocked sessions");
 assert.equal((await browserQuery("/api/v1/coverage/reverse-lookup")).status,401);
 const passwordUnlock=await fetch(base+"/api/v1/access/unlock",{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify({password:"123"})});assert.equal(passwordUnlock.status,401,"password unlock is retired");
 const limited=await (await fetch(base+route+"/keys",{method:"POST",headers:auth,body:JSON.stringify({name:"limited browser",scopes:["region:query"],perMinute:1})})).json();
 const limitedUnlock=await fetch(base+"/api/v1/access/unlock",{method:"POST",headers:{Origin:base,"X-Assets-API-Key":limited.key,"Content-Type":"application/json"},body:"{}"});assert.equal(limitedUnlock.status,200);
 const limitQuery=await fetch(base+"/api/v1/coverage/reverse-lookup",{method:"POST",headers:{Origin:base,Cookie:limitedUnlock.headers.get("set-cookie")!.split(";")[0]!,"Content-Type":"application/json"},body:"{}"});assert.equal(limitQuery.status,429,"browser session retains Key rate limit");
 const stats=await (await fetch(base+route,{headers:auth})).json();assert.ok(stats.events.some((e:{id:string;route:string;status:number})=>e.id===issued.id&&e.route==="/api/v1/coverage/reverse-lookup"&&e.status===200));
 assert.equal(logs.includes(issued.key),false);
 assert.equal(logs.includes(key.key),false);
});
