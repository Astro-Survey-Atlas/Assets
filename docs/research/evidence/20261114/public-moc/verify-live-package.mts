import { readFile, writeFile } from 'node:fs/promises';
import { readResourcePackageManifest, readZipEntry } from '/workspace/work/repos/Assets/server/resource-package-inspection.ts';
import { decodeNativeMoc, sha256 } from '/workspace/work/repos/Assets/server/native-moc.ts';
const file = '/workspace/work/evidence/production/spherex-resource-package.zip';
const bytes = await readFile(file);
const manifest = await readResourcePackageManifest(bytes);
const checks = [];
for (const entry of [...manifest.files, ...manifest.layers]) {
  const body = await readZipEntry(bytes, entry.path);
  const match = body.length === entry.sizeBytes && sha256(body) === entry.sha256;
  if (!match) throw new Error('SHA/size mismatch '+entry.path);
  checks.push({path:entry.path,bytes:body.length,sha256:sha256(body),passed:match});
}
const layers = [];
for (const layer of manifest.layers) {
  const moc = decodeNativeMoc(await readZipEntry(bytes, layer.path));
  layers.push({layerId:layer.layerId,releaseId:layer.releaseId,actualMaxOrder:moc.maxOrder,declaredMaxOrder:layer.maxOrder,availableOrders:moc.availableOrders,sha256:moc.sha256});
  if (moc.maxOrder !== layer.maxOrder) throw new Error('native maxOrder mismatch');
}
const sidecars = [];
for (const order of [4,8]) {
  const body = JSON.parse((await readZipEntry(bytes,`healpix/order${order}.json`)).toString('utf8'));
  sidecars.push(body);
}
if (sidecars[1].layers.length !== 0 || sidecars[1].surveyUnion.omittedLayers.length !== 7) throw new Error('O8 omission contract mismatch');
const result = {scope:'Read-only verification of one current public SPHEREx QR2 package, not production publication acceptance',file,packageId:manifest.id,version:manifest.version,outerBytes:bytes.length,outerSha256:sha256(bytes),memberChecks:checks,layers,sidecars};
await writeFile('/workspace/work/evidence/public-moc/live-spherex-package-verification.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({packageId:manifest.id,version:manifest.version,outerBytes:bytes.length,checkedMembers:checks.length,layers,sidecars:sidecars.map(x=>({order:x.order,layers:x.layers.length,omittedLayers:x.surveyUnion.omittedLayers,unionCount:x.surveyUnion.cells.length}))},null,2));
