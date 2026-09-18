import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { PublicState } from "./public-state.js";
import { projectMoc, sha256 } from "./native-moc.js";
import type { SourceUnitMatch } from "./source-units.js";

export class AccessError extends Error { constructor(readonly statusCode:number,message:string){super(message);} }
const equal=(a:string,b:string):boolean=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export class AccessGate {
  private sessions=new Map<string,{until:number;identity:string}>();
  private quotas=new Map<string,{minute:number;requests:number;active:number;day:number;units:number;failures:number}>();
  constructor(private password=process.env.ASSETS_DOWNLOAD_PASSWORD??"123",private apiKey=process.env.ASSETS_WORKSPACE_API_KEY??""){}
  private quota(id:string){
    const now=Date.now(),minute=Math.floor(now/60000),day=Math.floor(now/86400000);
    for(const [key,q] of this.quotas)if(q.day<day&&!q.active)this.quotas.delete(key);
    if(this.quotas.size>10000&&!this.quotas.has(id))throw new AccessError(429,"Access capacity exceeded");
    const q=this.quotas.get(id)??{minute,day,requests:0,active:0,units:0,failures:0};
    if(q.minute!==minute){q.minute=minute;q.requests=0;q.failures=0;}if(q.day!==day){q.day=day;q.units=0;}
    this.quotas.set(id,q);return q;
  }
  sameOrigin(request:IncomingMessage):void {
    const origin=request.headers.origin;
    if(typeof origin!=="string" || new URL(origin).host!==request.headers.host)throw new AccessError(403,"Same-origin browser request required");
    if(request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"]!=="same-origin")throw new AccessError(403,"Cross-site request rejected");
  }
  unlock(request:IncomingMessage,password:unknown):string {
    this.sameOrigin(request);
    const id=`browser:${request.socket.remoteAddress??"unknown"}`,q=this.quota(id);
    if(++q.failures>5)throw new AccessError(429,"Too many unlock attempts; retry next minute");
    if(typeof password!=="string"||!equal(password,this.password))throw new AccessError(401,"Invalid download password");
    const now=Date.now();for(const [id,s]of this.sessions)if(s.until<=now)this.sessions.delete(id);
    if(this.sessions.size>=10000)throw new AccessError(429,"Session capacity exceeded");
    const token=randomBytes(32).toString("hex");this.sessions.set(token,{until:now+3600000,identity:id});return token;
  }
  identity(request:IncomingMessage):string {
    const key=request.headers["x-assets-api-key"];
    if(typeof key==="string"&&this.apiKey&&equal(key,this.apiKey))return "service:workspace";
    const cookie=String(request.headers.cookie??"").match(/(?:^|;\s*)assets_download=([^;]+)/)?.[1];
    const session=cookie?this.sessions.get(cookie):undefined;
    if(session && session.until>Date.now()){this.sameOrigin(request);return session.identity;}
    throw new AccessError(401,"Unlock downloads or provide a service API key");
  }
  begin(id:string):{finish:(units:number)=>void} {
    const q=this.quota(id);
    // Reserve the maximum operation cost before computing. Failed or abandoned
    // calls do not become a free index enumeration path.
    if(q.requests>=30||q.active>=2||q.units+11000>100000)throw new AccessError(429,"Query quota exceeded");
    q.requests++;q.active++;q.units+=11000;let finished=false;
    return{finish:units=>{if(finished)return;finished=true;q.active--;q.units-=11000-Math.min(11000,Math.max(1,units));}};
  }
}
export interface RegionRequest {
  purpose:"fine-overlap"|"download-plan";
  region:{coordinateFrame:"ICRS";ordering:"NESTED";order:number;nside?:number;cells:number[]};
  sources:Array<{surveyId:string;releaseId:string;productId:string;layerId:string;sourceId?:string;coverageRevision:string;indexRevision?:string|null}>;
  limit?:number;
}
export function validateRegion(input:unknown):RegionRequest {
  if(!input||typeof input!=="object")throw new AccessError(400,"Region request required");
  const x=input as RegionRequest,r=x.region;
  if(!["fine-overlap","download-plan"].includes(x.purpose)||!r||r.coordinateFrame!=="ICRS"||r.ordering!=="NESTED")throw new AccessError(400,"purpose and ICRS/NESTED region are required");
  if(!Number.isInteger(r.order)||r.order<0||r.order>13||!Array.isArray(r.cells)||!r.cells.length||r.cells.length>4096||r.cells.some(p=>!Number.isSafeInteger(p)||p<0||p>=12*4**r.order)||r.nside!==undefined&&r.nside!==2**r.order)throw new AccessError(400,"Invalid region order, nside or cells (maximum 4096 cells, O13)");
  const cells=[...new Set(r.cells)].sort((a,b)=>a-b);
  if(cells.length*41252.96124941927/(12*4**r.order)>100)throw new AccessError(413,"Region exceeds 100 square degrees");
  if(!Array.isArray(x.sources)||x.sources.length<1||x.sources.length>8)throw new AccessError(400,"Provide 1–8 concrete sources");
  const ids=new Set<string>();
  for(const s of x.sources){
    if(!s || [s.surveyId,s.releaseId,s.productId,s.layerId,s.coverageRevision].some(v=>typeof v!=="string"||!v||v.length>128)||s.layerId.startsWith("public:")||s.sourceId!==undefined&&s.sourceId!==s.layerId||ids.has(s.layerId))throw new AccessError(400,"Invalid, duplicate or non-concrete source identity");
    if(x.purpose==="download-plan" && s.indexRevision===undefined)throw new AccessError(400,"download-plan requires indexRevision (null for geometry-only)");
    ids.add(s.layerId);
  }
  if(x.limit!==undefined&&(!Number.isInteger(x.limit)||x.limit<1||x.limit>1000))throw new AccessError(400,"limit must be 1–1000");
  return {...x,region:{...r,cells,nside:2**r.order},limit:x.limit??500};
}
export async function queryRegion(state:PublicState,input:unknown,match:(layerId:string,order:number,cells:number[],limit:number,indexRevision:string)=>Promise<SourceUnitMatch|null>) {
  const request=validateRegion(input),sources:Array<Record<string,unknown>>=[];
  let remainingGeometry=10000,remainingUnits=request.limit!;
  for(const source of request.sources){
    const product=state.snapshot.products.find(p=>p.productId===source.productId),g=product?.geometry;
    if(!product||!g||product.content.surveyId!==source.surveyId||product.content.releaseId!==source.releaseId||g.layerId!==source.layerId||!state.geometry.has(g.layerId))throw new AccessError(404,"Published source not found");
    if(g.coverageRevision!==source.coverageRevision || request.purpose==="download-plan"&&g.indexRevision!==source.indexRevision)throw new AccessError(409,"Published source revision changed; synchronize the package catalog");
    const moc=state.geometry.get(g.layerId)!,order=Math.min(moc.maxOrder,request.region.order);
    // Region order fixes the requested grid. Coarser input remains coarse;
    // clients request fine cells explicitly for fine-overlap inspection.
    const projection=projectMoc(moc,order,request.region,remainingGeometry);remainingGeometry-=projection.cells.length;
    let units:SourceUnitMatch|null=null,reason=g.indexRevision?"":"No region-to-science-file index is available for this product.";
    if(request.purpose==="download-plan"&&g.indexRevision&&projection.cells.length&&!projection.truncated&&remainingUnits>0) {
      try {units=await match(g.layerId,order,projection.cells,remainingUnits,g.indexRevision);if(!units)reason="Published index is unavailable";}
      catch {reason="Published index is unavailable; no download plan was inferred";}
    }
    const hits=units?.units??[];remainingUnits-=hits.length;
    const downloads=hits.filter(u=>/^https:\/\//.test(u.downloadUrl)).map(u=>({kind:"tile-directory",unitId:u.unitId,url:u.downloadUrl,sourceId:g.layerId,surveyId:source.surveyId,releaseId:source.releaseId,productId:source.productId,geometryPrecision:"estimated",completeness:"candidate",note:"Intersects the requested HEALPix region using the official tile footprint; directory contents are not a verified science-file list."}));
    sources.push({...source,sourceId:g.layerId,order,nside:2**order,coverageRevision:g.coverageRevision,indexRevision:g.indexRevision,cells:projection.cells,geometryPrecision:"estimated",geometryOperation:order>=moc.maxOrder?"exact-native-cell-intersection":"conservative-projection",accessAvailability:units?"tile-resolved":g.indexRevision&&reason?"unavailable":"geometry-only",completeness:projection.truncated||units?.truncated||(!remainingUnits&&g.indexRevision&&!units)?"truncated":reason&&g.indexRevision?"incomplete":"complete",reason:reason||undefined,sourceUnits:hits.map(u=>({unitId:u.unitId,unitKind:u.unitKind,matchingCells:u.matchingCells})),downloads,provenance:{method:product.content.mode??"native-moc",mocSha256:moc.sha256,productRevision:product.revision,publishedRelease:state.snapshot.releaseId}});
  }
  const response={schemaVersion:1,purpose:request.purpose,region:request.region,regionSha256:sha256(JSON.stringify(request.region)),sources,expiresAt:new Date(Date.now()+600000).toISOString()};
  if(Buffer.byteLength(JSON.stringify(response))>2*1024*1024)throw new AccessError(413,"Response exceeds 2 MiB; reduce the region or limit");
  return response;
}
