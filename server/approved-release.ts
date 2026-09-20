import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yazl from "yazl";
import type { ProductContent, ProductRecord } from "./products.js";
import type { MocPublication, MocPublicationFile } from "./moc-build.js";
import type { PublicAssetRecord } from "./types.js";
import { decodeNativeMoc, projectMoc, sha256, type NativeMoc } from "./native-moc.js";
import { assertPublicCoverageOrder } from "./coverage-policy.js";
import { isDeniedSurvey } from "./publication-policy.js";
import { readResourcePackageManifest, readZipEntry, validateReviewedPackage } from "./resource-package-inspection.js";
import { publicReleaseBundleDigest } from "./catalog.js";

export const PUBLICATION_POLICY = "reviewed-release-v1";
export const APPROVED_RELEASE_PATH = "artifacts/public-survey-footprints/approved-release.json";
export interface GeometryFacts {
  layerId: string; coverageRevision: string; mocSha256: string; indexRevision: string | null;
}
export interface ApprovedProduct {
  productId: string; revision: number; contentSha256: string; content: ProductContent;
  reviewedAt: string; geometry: GeometryFacts | null;
}
export interface ApprovedRelease {
  policy: typeof PUBLICATION_POLICY; releaseId: string; generatedAt: string;
  products: ApprovedProduct[]; assetIds: string[]; packages: Array<Record<string, unknown>>;
  withdrawals: Array<{ productId: string; reason: string }>;
}
export interface GeometryMaterial { facts: GeometryFacts; bytes: Buffer; moc: NativeMoc; sourcePath: string }
interface MaterialOptions {
  root: string; publications: readonly MocPublication[];
  publicationFile: (file: MocPublicationFile) => string;
  files: readonly PublicAssetRecord[];
}

export async function readApprovedRelease(root: string): Promise<ApprovedRelease> {
  try {
    const value = JSON.parse(await readFile(path.join(root, APPROVED_RELEASE_PATH), "utf8")) as ApprovedRelease;
    if (value.policy !== PUBLICATION_POLICY || !Array.isArray(value.products) || !Array.isArray(value.assetIds)) throw new Error("Invalid approved release snapshot");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { policy: PUBLICATION_POLICY, releaseId: "", generatedAt: "", products: [], assetIds: [], packages: [], withdrawals: [] };
  }
}

/** Binding is always explicit product/layer identity, never a display-name match. */
export async function productGeometry(product: ProductRecord, options: MaterialOptions): Promise<GeometryMaterial | null> {
  const content = product.draft;
  const publication = [...options.publications].filter(p => p.productId === product.productId).sort((a,b) => b.publishedAt.localeCompare(a.publishedAt))[0];
  let sourcePath: string | undefined, expected: string | undefined;
  let layerId = content.layerId;
  if (publication) { layerId=publication.layerId; sourcePath=options.publicationFile(publication.files.moc); expected=publication.files.moc.sha256; }
  if (!sourcePath && layerId) {
    const entry=options.files.find(f => f.kind === "moc" && (f.id === `approved-${layerId}-moc` || f.id === `layer-${layerId}-moc` || f.path.includes(`/layers/${layerId}/`)));
    if (entry) { sourcePath=path.join(options.root,entry.path); expected=entry.sha256; }
  }
  if (!sourcePath || !layerId) return null;
  const bytes=await readFile(sourcePath);
  if (sha256(bytes)!==expected) throw new Error(`Geometry checksum mismatch: ${product.productId}`);
  const moc=decodeNativeMoc(bytes);
  assertPublicCoverageOrder(moc.maxOrder);
  let indexRevision: string | null=null;
  if (content.surveyId === "desi" && ["desi-dr1-spectra-footprint","desi-edr-spectra-footprint"].includes(layerId)) {
    const recipePath=path.join(options.root,`src/layers/recipes/${layerId}.lock.json`);
    const recipeBytes=await readFile(recipePath);
    const recipe=JSON.parse(recipeBytes.toString()) as { input: string; snapshot: { sha256: string } };
    const input=await readFile(path.join(options.root,recipe.input));
    if (sha256(input)!==recipe.snapshot.sha256) throw new Error(`Index snapshot mismatch: ${layerId}`);
    indexRevision=sha256(`${sha256(recipeBytes)}\n${sha256(input)}\ndesi-tile-inclusive-v1`);
  }
  return { bytes,moc,sourcePath,facts:{layerId,coverageRevision:moc.revision,mocSha256:moc.sha256,indexRevision} };
}

export function currentReview(product: ProductRecord, geometry: GeometryFacts | null): boolean {
  return !product.retiredAt && !isDeniedSurvey(product.draft.surveyId)
    && product.review?.policy === PUBLICATION_POLICY
    && product.review.revision === product.revision && product.review.contentSha256 === product.contentSha256
    && JSON.stringify(product.review.geometry ?? null) === JSON.stringify(geometry);
}

export function zipBuffers(entries: Array<{ path: string; bytes: Buffer }>): Promise<Buffer> {
  return new Promise((resolve,reject) => {
    const zip=new yazl.ZipFile(), chunks: Buffer[]=[];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error",reject); zip.outputStream.on("end",()=>resolve(Buffer.concat(chunks)));
    for (const entry of entries.sort((a,b)=>a.path.localeCompare(b.path))) zip.addBuffer(entry.bytes,entry.path,{mtime:new Date("1980-01-01T00:00:00Z")});
    zip.end();
  });
}

export interface ApprovedBuildOptions extends MaterialOptions {
  stagingRoot: string; products: readonly ProductRecord[]; selected: Array<{productId:string; revision:number}>;
  baseline: { bundle:{id:string;sha256:string}; statistics: Record<string,unknown>; files: PublicAssetRecord[] };
  runId: string;
}

/** Whole-release activation is the only public commit point. Internal baseline
 * material remains on the service volume; only the snapshot allowlist is served. */
export async function buildApprovedRelease(options: ApprovedBuildOptions): Promise<{root:string;files:PublicAssetRecord[];packages:Array<Record<string,unknown>>}> {
  const previous=await readApprovedRelease(options.root);
  const selected=new Map(options.selected.map(p=>[p.productId,p.revision]));
  const approved=new Map(previous.products.map(p=>[p.productId,p]));
  const withdrawals=[...previous.withdrawals];
  const material=new Map<string,GeometryMaterial>();
  for (const record of options.products) {
    if (selected.has(record.productId) && record.retiredAt && approved.has(record.productId)) {
      if (!record.retirementReason?.trim()) throw new Error("Withdrawal requires a reason");
      approved.delete(record.productId); withdrawals.push({productId:record.productId,reason:record.retirementReason}); continue;
    }
    if (!selected.has(record.productId)) continue;
    if (record.revision!==selected.get(record.productId)) throw new Error(`Product changed while queued: ${record.productId}`);
    const geometry=await productGeometry(record,options);
    if (!currentReview(record,geometry?.facts ?? null)) throw new Error(`Product requires review: ${record.productId}`);
    const content=structuredClone(record.draft);
    if (geometry) {content.layerId=geometry.facts.layerId;material.set(record.productId,geometry);}
    approved.set(record.productId,{productId:record.productId,revision:record.revision,contentSha256:record.contentSha256,content,reviewedAt:record.review!.reviewedAt,geometry:geometry?.facts ?? null});
  }
  for (const id of selected.keys()) if (!options.products.some(p=>p.productId===id)) throw new Error(`Unknown selected product: ${id}`);
  // Retained published versions use their frozen MOC, not a newer working layer.
  for (const product of approved.values()) if (product.geometry && !material.has(product.productId)) {
    const entry=options.files.find(f=>f.id===`approved-${product.geometry!.layerId}-moc` && f.sha256===product.geometry!.mocSha256);
    if (!entry) throw new Error(`Missing frozen geometry: ${product.productId}`);
    const sourcePath=path.join(options.root,entry.path),bytes=await readFile(sourcePath),moc=decodeNativeMoc(bytes);
    assertPublicCoverageOrder(moc.maxOrder);
    if (moc.sha256!==product.geometry.mocSha256 || moc.revision!==product.geometry.coverageRevision) throw new Error("Frozen geometry mismatch");
    material.set(product.productId,{facts:product.geometry,bytes,moc,sourcePath});
  }
  const generatedAt=new Date().toISOString(),releaseId=`reviewed-${options.runId}`;
  const snapshot:ApprovedRelease={policy:PUBLICATION_POLICY,releaseId,generatedAt,products:[...approved.values()],assetIds:[],packages:[],withdrawals};
  const files:PublicAssetRecord[]=[];
  const put=async(record:Omit<PublicAssetRecord,"sha256"|"sizeBytes">,bytes:Buffer,expose=false):Promise<PublicAssetRecord>=>{
    const target=path.join(options.stagingRoot,record.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
    const full={...record,sha256:sha256(bytes),sizeBytes:bytes.length};files.push(full);if(expose)snapshot.assetIds.push(full.id);return full;
  };
  // Keep internal material available for subsequent reviews and server startup.
  // No baseline asset automatically enters the public allowlist.
  for(const record of options.baseline.files) {
    if(record.id.startsWith("approved-") || record.path===APPROVED_RELEASE_PATH || record.path.endsWith("/packages/catalog.json") || record.path.endsWith("/release-history.json"))continue;
    const bytes=await readFile(path.join(options.root,record.path));
    if(sha256(bytes)!==record.sha256)throw new Error(`Baseline checksum mismatch: ${record.path}`);
    await put(record,bytes);
  }
  const footprintRows:unknown[]=[];
  for(const surveyId of [...new Set(snapshot.products.map(p=>p.content.surveyId))].sort()) {
    const changedSurvey = options.products.some(p => selected.has(p.productId) && p.draft.surveyId === surveyId);
    if (!changedSurvey && previous.packages.some(p => p.surveyId === surveyId)) {
      snapshot.packages.push(...previous.packages.filter(p => p.surveyId === surveyId));
      for (const record of options.files.filter(f => f.surveyId === surveyId && previous.assetIds.includes(f.id) && (f.kind === "package" || f.kind === "moc"))) {
        const bytes = await readFile(path.join(options.root, record.path));
        if (sha256(bytes) !== record.sha256) throw new Error("Retained public asset checksum mismatch");
        await put(record, bytes, true);
      }
      continue;
    }
    const products=snapshot.products.filter(p=>p.content.surveyId===surveyId && p.geometry);
    if(!products.length)continue;
    const id=`public-${surveyId}-footprints`;
    // Allocate above every retained version, including unpublished historical inputs.
    let minor=0;
    for(const record of options.files.filter(f=>f.kind==="package" && f.surveyId===surveyId)) minor=Math.max(minor,Number(record.version?.split(".")[1] ?? 0));
    const version=`3.${minor+1}.0`,entries:Array<{path:string;bytes:Buffer}>=[],layers:Array<Record<string,unknown>>=[],provenance:unknown[]=[],footprints:unknown[]=[];
    for(const product of products) {
      const g=material.get(product.productId)!,c=product.content,layerId=g.facts.layerId;
      const overviewOrder=Math.min(4,g.moc.maxOrder),pixels=projectMoc(g.moc,overviewOrder).cells;
      const row={surveyId,releaseId:c.releaseId,product:c.name,productId:product.productId,layerId,nside:2**overviewOrder,pixels};footprints.push(row);footprintRows.push(row);
      const mocPath=`mocs/${layerId}.moc.fits`;entries.push({path:mocPath,bytes:g.bytes});
      layers.push({layerId,sourceId:layerId,productId:product.productId,product:c.name,surveyId,releaseId:c.releaseId,modality:c.modality??"coverage",coverageRole:c.coverageRole??"footprint_extent",dataOrigin:c.dataOrigin??"observed",sourceTier:c.sourceTier??"best_effort_derived",path:mocPath,sizeBytes:g.bytes.length,sha256:g.moc.sha256,coordinateFrame:"ICRS",ordering:"NESTED",mocEncoding:"NUNIQ",availableOrders:g.moc.availableOrders,overviewOrder,maxOrder:g.moc.maxOrder,coverageRevision:g.moc.revision,indexRevision:g.facts.indexRevision,geometryPrecision:"estimated",precisionNote:"Exact cell-set operations on supplied MOC; physical footprint boundary is limited by the source method and HEALPix resolution.",accessAvailability:g.facts.indexRevision?"tile-resolved":"geometry-only"});
      provenance.push({productId:product.productId,layerId,reviewedAt:product.reviewedAt,productRevision:product.revision,geometrySourceUrl:c.geometrySourceUrl??c.sourceUrl,geometryRevision:g.moc.revision,mocSha256:g.moc.sha256,method:c.mode??"native-moc",indexRevision:g.facts.indexRevision});
      await put({id:`approved-${layerId}-moc`,kind:"moc",label:c.name,description:"Reviewed public coverage geometry",path:`artifacts/public-survey-footprints/approved/${layerId}.fits`,downloadName:`${layerId}.fits`,mediaType:"application/fits",surveyId,releaseId:c.releaseId,product:c.name,deliveryClass:"runtime"},g.bytes,true);
    }
    entries.push({path:"footprints/survey-footprints.json",bytes:Buffer.from(JSON.stringify({schemaVersion:1,coordinateFrame:"ICRS",ordering:"NESTED",generatedAt,footprints}))},{path:"provenance.json",bytes:Buffer.from(JSON.stringify({schemaVersion:2,policy:PUBLICATION_POLICY,releaseId,layers:provenance}))},{path:"README.md",bytes:Buffer.from("# Reviewed public coverage\nNative MOC is authoritative. The overview is a conservative display projection. Geometry sources are not science-file lists.\n")});
    const manifest={schemaVersion:3,id,version,surveyId,layers,files:entries.filter(e=>!e.path.startsWith("mocs/")).map(e=>({path:e.path,sizeBytes:e.bytes.length,sha256:sha256(e.bytes)}))};
    entries.push({path:"resource-package.json",bytes:Buffer.from(JSON.stringify(manifest))});
    const zip=await zipBuffers(entries);
    // Validate the bytes actually going into the release, not just the build inputs.
    const parsed=await readResourcePackageManifest(zip);
    validateReviewedPackage(parsed);
    for(const layer of parsed.layers)if(sha256(await readZipEntry(zip,layer.path))!==layer.sha256)throw new Error("Package member checksum mismatch");
    const asset=await put({id:`approved-${id}-${version.replaceAll(".","-")}`,kind:"package",label:id,description:"Reviewed public survey geometry",path:`artifacts/public-survey-footprints/packages/${id}-${version}.zip`,downloadName:`${id}-${version}.zip`,mediaType:"application/zip",surveyId,version,deliveryClass:"runtime"},zip,true);
    snapshot.packages.push({id,version,surveyId,name:products[0]!.content.publicSurvey?.name??surveyId,description:asset.description,releases:[...new Set(products.map(p=>p.content.releaseId))],releaseLabels:Object.fromEntries(products.map(p=>[p.content.releaseId,p.content.publicRelease?.label??p.content.releaseId])),modalities:[...new Set(products.map(p=>p.content.modality??"coverage"))],facilities:[surveyId],accessModes:["Resource Package v3"],sources:[],archiveUrl:`/api/v1/resource-packages/${id}/versions/${version}/download`,sizeBytes:asset.sizeBytes,sha256:asset.sha256,updatedAt:generatedAt,hidden:false,deprecated:false,replacedBy:[]});
  }
  const catalogBytes=Buffer.from(JSON.stringify({schemaVersion:3,version:"3.0.0",releaseId,generatedAt,packages:snapshot.packages}));
  await put({id:"approved-package-catalog",kind:"manifest",label:"Package catalog",description:"Reviewed packages",path:"artifacts/public-survey-footprints/packages/catalog.json",downloadName:"catalog.json",mediaType:"application/json",deliveryClass:"runtime"},catalogBytes,true);
  const collectionMembers=[{path:"catalog.json",bytes:catalogBytes}];
  for(const f of files.filter(f=>f.kind==="package" && snapshot.assetIds.includes(f.id)))collectionMembers.push({path:f.downloadName,bytes:await readFile(path.join(options.stagingRoot,f.path))});
  const collection=await put({id:`approved-collection-${options.runId}`,kind:"package-collection",label:"Reviewed release",description:"Reviewed package collection",path:`artifacts/public-survey-footprints/packages/${releaseId}.zip`,downloadName:`${releaseId}.zip`,mediaType:"application/zip",deliveryClass:"runtime"},await zipBuffers(collectionMembers),true);
  const history={schemaVersion:2,latestReleaseId:releaseId,releases:[{releaseId,sequence:Date.now(),bundleId:releaseId,releasedAt:generatedAt,notes:"Hard cutover: historical products require explicit re-review; unapproved historical packages are withdrawn.",catalogSha256:sha256(catalogBytes),collection:{fileName:collection.downloadName,sizeBytes:collection.sizeBytes,sha256:collection.sha256,downloadUrl:`/api/v1/releases/${releaseId}/download`},packages:snapshot.packages.map(p=>({...p,downloadUrl:p.archiveUrl,survey:{id:p.surveyId,displayName:p.name},releases:(p.releases as string[]).map(id=>({id,label:id,modalities:p.modalities,layerCount:snapshot.products.filter(product=>product.content.releaseId===id && product.geometry).length}))}))}]};
  await put({id:"approved-release-history",kind:"manifest",label:"Release history",description:"Reviewed releases",path:"artifacts/public-survey-footprints/release-history.json",downloadName:"release-history.json",mediaType:"application/json",deliveryClass:"runtime"},Buffer.from(JSON.stringify(history)),true);
  await put({id:"approved-release-snapshot",kind:"manifest",label:"Approved snapshot",description:"Internal authorization snapshot",path:APPROVED_RELEASE_PATH,downloadName:"approved-release.json",mediaType:"application/json",deliveryClass:"runtime"},Buffer.from(JSON.stringify(snapshot)));
  const manifest={schemaVersion:1,generatedAt,bundle:{id:releaseId,sha256:publicReleaseBundleDigest(files)},statistics:{...options.baseline.statistics,packages:snapshot.packages.length,totalBytes:files.reduce((s,f)=>s+f.sizeBytes,0)},files};
  await writeFile(path.join(options.stagingRoot,"artifacts/public-survey-footprints/release-manifest.json"),JSON.stringify(manifest));
  return {root:options.stagingRoot,files,packages:snapshot.packages};
}
