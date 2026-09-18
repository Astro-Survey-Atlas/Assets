/** Read-only audit: npx tsx scripts/audit-package-geometry.ts package.zip ... */
import { readFile } from "node:fs/promises";
import { readResourcePackageManifest,readZipEntry } from "../server/resource-package-inspection.js";
import { decodeNativeMoc,projectMoc,sha256 } from "../server/native-moc.js";
const packages=[];
for(const file of process.argv.slice(2)){
 const zip=await readFile(file),manifest=await readResourcePackageManifest(zip),layers=[];
 for(const layer of manifest.layers){const bytes=await readZipEntry(zip,layer.path);if(sha256(bytes)!==layer.sha256)throw Error(`Checksum mismatch ${layer.layerId}`);const moc=decodeNativeMoc(bytes);layers.push({surveyId:layer.surveyId,releaseId:layer.releaseId,layerId:layer.layerId,sourceId:layer.layerId,mocSha256:moc.sha256,coverageRevision:moc.revision,availableOrders:moc.availableOrders,maxOrder:moc.maxOrder,nativeCellCount:moc.cells.length,geometryPrecision:"estimated",accessAvailability:layer.surveyId==="desi"?"tile-resolved":"geometry-only",fixedRegion:{coordinateFrame:"ICRS",ordering:"NESTED",order:8,cells:[163327],matchedCells:projectMoc(moc,8,{order:8,cells:[163327]}).cells},fixedFineRegion:{coordinateFrame:"ICRS",ordering:"NESTED",order:10,cells:Array.from({length:16},(_,i)=>163327*16+i),matchedCells:projectMoc(moc,Math.min(10,moc.maxOrder),{order:10,cells:Array.from({length:16},(_,i)=>163327*16+i)}).cells}});}
 packages.push({id:manifest.id,version:manifest.version,sha256:sha256(zip),layers});
}
console.log(JSON.stringify({auditedAt:new Date().toISOString(),note:"Historical package bytes, not current public authorization. Re-review and complete publication are required after cutover.",packages},null,2));
