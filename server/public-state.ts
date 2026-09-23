import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedCatalog } from "./catalog.js";
import { publicManifest } from "./catalog.js";
import { readApprovedRelease, type ApprovedRelease } from "./approved-release.js";
import { decodeNativeMoc, projectMoc, type NativeMoc } from "./native-moc.js";
import { withCoverageRevisions, type CoverageCellLayer } from "./coverage.js";
import type { ProductRecord } from "./products.js";
import type { PublicSurveyIndex } from "./surveys.js";
import type { PublicSurveyModality } from "./types.js";
import { isDeniedSurvey } from "./publication-policy.js";

async function loadSurveyColors(root: string): Promise<Map<string, string>> {
  try {
    const source = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as {
      surveys?: Array<{ id?: unknown; color?: unknown }>;
    };
    return new Map((source.surveys ?? []).flatMap((survey) => {
      if (typeof survey.id !== "string" || !/^#[0-9a-f]{6}$/i.test(String(survey.color ?? ""))) return [];
      return [[survey.id, String(survey.color).toLowerCase()] as const];
    }));
  } catch {
    return new Map();
  }
}

/** A single immutable projection for every public reader. Missing approval is
 * an empty public release, never a fallback to the working catalog. */
export async function loadPublicState(catalog: LoadedCatalog) {
  const surveyColors = await loadSurveyColors(catalog.root);
  const snapshot: ApprovedRelease = await readApprovedRelease(catalog.root);
  const products = snapshot.products.filter(p => !isDeniedSurvey(p.content.surveyId));
  const records = new Map<string, ProductRecord>(products.map(p => [p.productId, {
    productId:p.productId, draft:p.content, published:p.content, revision:p.revision,
    publishedRevision:p.revision, contentSha256:p.contentSha256, updatedAt:snapshot.generatedAt,
    publishedAt:snapshot.generatedAt, review:{revision:p.revision,contentSha256:p.contentSha256,reviewedAt:p.reviewedAt,acceptedGaps:[],policy:snapshot.policy,geometry:p.geometry},
  }]));
  const allowed = new Set(snapshot.assetIds);
  const publicCatalog: LoadedCatalog = {...catalog, files:new Map([...catalog.files].filter(([id])=>allowed.has(id))),manifest:{...catalog.manifest,files:catalog.manifest.files.filter(f=>allowed.has(f.id))}};
  const geometry = new Map<string, NativeMoc>(), layers = new Map<string,CoverageCellLayer>();
  for (const product of products) {
    if (!product.geometry) continue;
    const g = product.geometry, c=product.content;
    const entry=publicCatalog.files.get(`approved-${g.layerId}-moc`);
    if(!entry || entry.record.sha256!==g.mocSha256) throw new Error(`Approved MOC missing: ${g.layerId}`);
    const moc=decodeNativeMoc(await readFile(entry.absolutePath));
    if(moc.sha256!==g.mocSha256 || moc.revision!==g.coverageRevision)throw new Error(`Approved MOC mismatch: ${g.layerId}`);
    if(layers.has(g.layerId))throw new Error(`Duplicate approved layer: ${g.layerId}`);
    geometry.set(g.layerId,moc);
    const overviewOrder=Math.min(4,moc.maxOrder);
    // O4/O8 for existing viewer blocks; finest geometry stays in native MOC and
    // bounded queries instead of materializing whole-sky fine rasters in JS.
    const orders=[...new Set([overviewOrder,Math.min(8,moc.maxOrder)])];
    const cells=new Map(orders.map(order=>[order,projectMoc(moc,order).cells]));
    const count=cells.get(orders.at(-1)!)!.length;
    layers.set(g.layerId,{layerId:g.layerId,productId:c.productId,surveyId:c.surveyId,releaseId:c.releaseId,product:c.name,modality:c.modality,coverageRole:c.coverageRole,color:surveyColors.get(c.surveyId)??c.publicSurvey?.color??"#376b9b",availableOrders:orders,overviewOrder,maxOrder:moc.maxOrder,cellCount:count,areaDeg2:count*41252.96124941927/(12*4**orders.at(-1)!),tileScheme:"ipix-range-4096",cells,
      sourceUnitIndex:{status:g.indexRevision?"estimated":"entrypoint-only",unitKind:g.indexRevision?"tile":undefined,notes:g.indexRevision?"Official tile geometry; scientific file contents have not been verified.":"No region-to-science-file index is available."},revision:g.coverageRevision});
  }
  const coverage=withCoverageRevisions({schemaVersion:2,coordinateFrame:"ICRS",ordering:"NESTED",tileScheme:"ipix-range-4096",records:layers,layers:[]});
  // Block revision and package coverage revision must be the same fixed identity.
  for(const layer of coverage.layers)layer.revision=geometry.get(layer.layerId)!.revision;
  for(const layer of coverage.records.values())layer.revision=geometry.get(layer.layerId)!.revision;
  const footprints=[...layers.values()].map(l=>({surveyId:l.surveyId,releaseId:l.releaseId,product:l.product,productId:l.productId,layerId:l.layerId,nside:2**l.overviewOrder,pixels:l.cells.get(l.overviewOrder)!}));
  const assets=publicManifest(publicCatalog).files;
  const surveys:PublicSurveyIndex['surveys']=[];
  for(const surveyId of [...new Set(products.map(p=>p.content.surveyId))]) {
    const selected=products.filter(p=>p.content.surveyId===surveyId),first=selected[0]!.content,meta=first.publicSurvey;
    const declaredModalities = (meta?.modalities ?? []).filter((modality): modality is PublicSurveyModality => typeof modality === "string" && modality.trim().length > 0);
    const productModalities = selected.flatMap((product) => {
      const modality = product.content.modality ?? product.content.publicSurvey?.modalities?.[0];
      return typeof modality === "string" && modality.trim().length > 0 ? [modality as PublicSurveyModality] : [];
    });
    const surveyModalities = [...new Set([...declaredModalities, ...productModalities])];
    const releases=[...new Set(selected.map(p=>p.content.releaseId))].map(releaseId=>{
      const group=selected.filter(p=>p.content.releaseId===releaseId),r=group[0]!.content.publicRelease;
      return {id:releaseId,label:r?.label??releaseId,kind:r?.kind??"release",modalities:[...new Set(group.map(p=>(p.content.modality??"catalog") as PublicSurveyModality))],releasedYear:r?.releasedYear,products:group.map(p=>{
        const c=p.content,l=p.geometry?layers.get(p.geometry.layerId):undefined;
        return {productId:p.productId,name:c.publicDisplayName??c.name,modality:(c.modality??"catalog") as PublicSurveyModality,status:l?"acquired" as const:"awaiting_geometry" as const,description:c.publicDescription??c.name,sourceUrl:l?`/api/v1/coverage/layers/${l.layerId}/moc.fits`:"",dataOrigin:c.dataOrigin,sourceTier:c.sourceTier,
          ...(l?{coverage:{layerId:l.layerId,availableOrders:l.availableOrders,overviewOrder:l.overviewOrder,maxOrder:l.maxOrder}}:{})};
      })};
    });
    surveys.push({id:surveyId,name:meta?.name??surveyId,mission:meta?.mission??surveyId,description:meta?.description??"",color:surveyColors.get(surveyId)??meta?.color??"#376b9b",modalities:surveyModalities,releases,imageUrl:`/surveys/${surveyId}.png`,statistics:{publicProducts:selected.length,acquired:selected.filter(p=>p.geometry).length,overviewOnly:0,awaitingGeometry:selected.filter(p=>p.geometry).length,notApplicable:0,footprintCells:footprints.filter(f=>f.surveyId===surveyId).reduce((s,f)=>s+f.pixels.length,0)},assets:assets.filter(a=>a.surveyId===surveyId)});
  }
  const index:PublicSurveyIndex={schemaVersion:1,generatedAt:snapshot.generatedAt,surveys,sharedAssets:assets.filter(a=>!a.surveyId)};
  return {snapshot,records,geometry,coverage,footprints,index,catalog:publicCatalog};
}
export type PublicState=Awaited<ReturnType<typeof loadPublicState>>;
