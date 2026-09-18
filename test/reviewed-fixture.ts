import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256, decodeNativeMoc } from "../server/native-moc.js";
import { PUBLICATION_POLICY } from "../server/approved-release.js";
import { publicReleaseBundleDigest } from "../server/catalog.js";
import { FilesystemArtifactStore, type ArtifactStore } from "../server/artifact-store.js";
import type { ProductRecord } from "../server/products.js";
import type { PublicAssetRecord } from "../server/types.js";
import type { PublicReleasePublisherOptions } from "../server/public-release-publication.js";

class LocalS3Store implements ArtifactStore {
  readonly kind = "s3" as const;
  constructor(private readonly delegate: FilesystemArtifactStore) {}
  head(key: string) { return this.delegate.head(key); }
  get(key: string, range?: { start: number; end: number }) { return this.delegate.get(key, range); }
  putImmutable(key: string, body: Uint8Array | string, options = {}) { return this.delegate.putImmutable(key, body, options); }
  putMutable(key: string, body: Uint8Array | string, options = {}) { return this.delegate.putMutable(key, body, options); }
  putFileImmutable(key: string, filePath: string, options = {}) { return this.delegate.putFileImmutable(key, filePath, options); }
  downloadToFile(key: string, filePath: string) { return this.delegate.downloadToFile(key, filePath); }
}
export function fitsMoc(cells:Array<{order:number;pixel:number}>=[{order:8,pixel:163327}]):Buffer {
  const header=(cards:string[])=>Buffer.from(cards.map(c=>c.padEnd(80)).join("").padEnd(2880));
  const rows=Buffer.alloc(Math.ceil(cells.length*8/2880)*2880);
  cells.forEach((c,i)=>rows.writeBigInt64BE(BigInt(4*4**c.order+c.pixel),i*8));
  return Buffer.concat([header(["SIMPLE  =                    T","BITPIX  =                    8","NAXIS   =                    0","EXTEND  =                    T","END"]),header(["XTENSION= 'BINTABLE'","BITPIX  =                    8","NAXIS   =                    2","NAXIS1  =                    8",`NAXIS2  = ${cells.length}`,"PCOUNT  =                    0","GCOUNT  =                    1","TFIELDS =                    1","TTYPE1  = 'UNIQ'","TFORM1  = '1K'","ORDERING= 'NUNIQ'","COORDSYS= 'C'","MOCDIM  = 'SPACE'","MOCVERS = '2.0'","END"]),rows]);
}
export async function reviewedFixture() {
  const base=await mkdtemp(path.join(tmpdir(),"reviewed-release-")),root=path.join(base,"baseline"),contentRoot=path.join(base,"content");
  await mkdir(contentRoot,{recursive:true});
  const files:PublicAssetRecord[]=[];
  async function put(id:string,relative:string,bytes:Buffer,kind:PublicAssetRecord['kind']="manifest"){
    await mkdir(path.dirname(path.join(root,relative)),{recursive:true});await writeFile(path.join(root,relative),bytes);
    files.push({id,path:relative,kind,label:id,description:id,downloadName:path.basename(relative),mediaType:kind==="moc"?"application/fits":"application/json",sha256:sha256(bytes),sizeBytes:bytes.length,deliveryClass:"runtime"});
  }
  const layerId="m42-dr1-image",bytes=fitsMoc([{order:8,pixel:163327},{order:10,pixel:2608000}]);
  const moc=decodeNativeMoc(bytes);
  const content={productId:"product-1",surveyId:"m42",releaseId:"dr1",name:"Image",layerId,modality:"imaging",sourceUrl:"https://example.org/survey",mode:"native-moc" as const,presentation:{summaryMarkdown:"",methodologyMarkdown:"",limitationsMarkdown:"",flow:{nodes:[],edges:[]}}};
  const record:ProductRecord={productId:content.productId,draft:content,published:null,revision:1,publishedRevision:null,updatedAt:new Date().toISOString(),publishedAt:null,contentSha256:sha256(JSON.stringify(content))};
  record.review={policy:PUBLICATION_POLICY,revision:1,contentSha256:record.contentSha256,reviewedAt:new Date().toISOString(),acceptedGaps:[],geometry:{layerId,coverageRevision:moc.revision,mocSha256:moc.sha256,indexRevision:null}};
  await put(`layer-${layerId}-moc`,`artifacts/public-survey-footprints/layers/${layerId}/moc.fits`,bytes,"moc");
  await put("survey-catalog","src/surveys/survey-catalog.json",Buffer.from(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),surveys:[{id:"m42",name:"M42",mission:"Test",color:"#123456",description:"Test",modalities:["imaging"],releases:[{id:"dr1",label:"DR1",kind:"release",modalities:["imaging"],products:[{name:"Image",modality:"imaging",sourceUrl:"https://example.org/survey",status:"acquired"}]}]}]})));
  await put("layer-registry","src/layers/layer-registry.json",Buffer.from(JSON.stringify({schemaVersion:1,layers:[]})));
  await put("manifest-canonical","src/footprints/survey-footprints.json",Buffer.from(JSON.stringify({schemaVersion:1,nside:16,coordinateFrame:"ICRS",generatedAt:new Date().toISOString(),footprints:[]})));
  await put("packages-catalog","artifacts/public-survey-footprints/packages/catalog.json",Buffer.from(JSON.stringify({schemaVersion:3,version:"3.0.0",packages:[]})));
  await put("release-history","artifacts/public-survey-footprints/release-history.json",Buffer.from(JSON.stringify({schemaVersion:2,latestReleaseId:"",releases:[]})));
  const manifest={schemaVersion:1,generatedAt:new Date().toISOString(),bundle:{id:"baseline",sha256:publicReleaseBundleDigest(files)},statistics:{releases:1,products:1,acquired:1,overviewOnly:0,awaitingGeometry:0,footprints:1,packages:0,rawMocFiles:1,totalBytes:files.reduce((s,f)=>s+f.sizeBytes,0)},files};
  await writeFile(path.join(root,"artifacts/public-survey-footprints/release-manifest.json"),JSON.stringify(manifest));
  const products=[record],store=new LocalS3Store(new FilesystemArtifactStore(path.join(base,"store")));
  const options:PublicReleasePublisherOptions={baselineRoot:root,contentRoot,loadProducts:()=>products,loadPublications:()=>[],publicationFile:()=>"",loadPackages:{list:()=>[],assets:()=>[],latest:()=>undefined},store,allowFilesystemStore:true};
  return {base,root,contentRoot,files,manifest,products,options,store,moc,bytes,layerId};
}
