import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readResourcePackageManifest, readZipEntry, type ResourcePackageLayerRecord } from "./resource-package-inspection.js";
import { isDeniedPackageId, isDeniedSurvey } from "./publication-policy.js";
import type { DynamicResourcePackageEntry } from "./resource-package-publication.js";
import type { ReleaseHistoryDocument } from "./public-release-publication.js";

export type PackageMetadata = Omit<DynamicResourcePackageEntry, "archivePath" | "objectKey" | "contentFingerprint">;
export interface HistoricalPackage { entry: PackageMetadata; bytes: Buffer }
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function verify(bytes: Buffer, record: { sizeBytes: number; sha256: string }, label: string): void {
  if (bytes.length !== record.sizeBytes || sha(bytes) !== record.sha256) throw new Error(`Historical package hash mismatch: ${label}`);
}

/** Recover missing immutable version downloads from their original verified collection. */
export async function historicalPackages(root: string): Promise<HistoricalPackage[]> {
  const base = path.join(root, "artifacts/public-survey-footprints");
  const catalog = JSON.parse(await readFile(path.join(base, "packages/catalog.json"), "utf8")) as { packages: PackageMetadata[] };
  let history: ReleaseHistoryDocument;
  try { history = JSON.parse(await readFile(path.join(base, "release-history.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const known = new Set(catalog.packages.map((entry) => `${entry.id}@${entry.version}`));
  const recovered: HistoricalPackage[] = [];
  for (const release of history.releases) {
    const missing = release.packages.filter((entry) => !known.has(`${entry.id}@${entry.version}`) && !isDeniedPackageId(entry.id) && !isDeniedSurvey(entry.survey?.id));
    if (!missing.length) continue;
    if (!release.collection) throw new Error(`Missing historical collection: ${release.releaseId}`);
    const collection = await readFile(path.join(base, "collections", release.collection.fileName));
    verify(collection, release.collection, release.releaseId);
    const original = JSON.parse((await readZipEntry(collection, "catalog.json")).toString()) as { packages: PackageMetadata[] };
    for (const record of missing) {
      const entry = original.packages.find((item) => item.id === record.id && item.version === record.version);
      if (!entry) throw new Error(`Missing historical catalog entry: ${record.id}@${record.version}`);
      const bytes = await readZipEntry(collection, `packages/${record.id}-${record.version}.zip`);
      verify(bytes, record, `${record.id}@${record.version}`);
      const manifest = await readResourcePackageManifest(bytes);
      if (manifest.id !== record.id || manifest.version !== record.version || manifest.surveyId !== entry.surveyId) throw new Error(`Historical package identity mismatch: ${record.id}`);
      const releases = [...new Set(manifest.layers.map((layer) => layer.releaseId))].sort();
      recovered.push({ bytes, entry: { ...entry, releases, releaseLabels: Object.fromEntries((record.releases ?? []).map((item) => [item.id, item.label])), sha256: record.sha256, sizeBytes: record.sizeBytes, deprecated: true, hidden: false, replacedBy: [entry.id], archiveUrl: `/api/v1/resource-packages/${entry.id}/versions/${entry.version}/download` } });
      known.add(`${record.id}@${record.version}`);
    }
  }
  return recovered;
}

/** Merge whole archived layers; keep exact bytes and original scientific provenance. */
export async function mergePackageHistory(inputs: HistoricalPackage[], version: string) {
  const entries = new Map<string, Buffer>();
  const layers = new Map<string, ResourcePackageLayerRecord>();
  const provenanceLayers = new Map<string, Record<string, unknown>>();
  const footprints = new Map<string, Record<string, unknown>>();
  let provenance: Record<string, unknown> = {};
  let preview: Record<string, unknown> = {};
  for (const { entry, bytes } of inputs) {
    verify(bytes, entry, `${entry.id}@${entry.version}`);
    const manifest = await readResourcePackageManifest(bytes);
    for (const record of [...manifest.files, ...manifest.layers]) {
      const content = await readZipEntry(bytes, record.path);
      verify(content, record, record.path);
      entries.set(record.path, content);
    }
    for (const layer of manifest.layers) layers.set(layer.layerId, layer);
    provenance = JSON.parse(entries.get("provenance.json")!.toString());
    for (const item of provenance.layers as Array<Record<string, unknown>>) provenanceLayers.set(String(item.layerId), item);
    const nextPreview = JSON.parse(entries.get("footprints/survey-footprints.json")!.toString());
    if (preview.nside !== undefined && preview.nside !== nextPreview.nside) throw new Error("Historical previews use different orders; explicit coarsening is required");
    preview = nextPreview;
    for (const item of preview.footprints as Array<Record<string, unknown>>) footprints.set(`${item.surveyId}:${item.releaseId}:${item.product}`, item);
  }
  const latest = inputs.at(-1)!.entry;
  const records = [...layers.values()].sort((a, b) => a.layerId.localeCompare(b.layerId));
  entries.set("provenance.json", Buffer.from(JSON.stringify({ ...provenance, packageVersion: version, layers: [...provenanceLayers.values()] })));
  entries.set("footprints/survey-footprints.json", Buffer.from(JSON.stringify({ ...preview, footprints: [...footprints.values()] })));
  // Legacy repair preserves the historical manifest contract: older layers may
  // lack product identity. Do not carry version-bound, partial sidecars from one
  // input into the merged archive or invent missing identities to regenerate them.
  entries.delete("healpix/order4.json");
  entries.delete("healpix/order8.json");
  const files = ["README.md", "provenance.json", "footprints/survey-footprints.json"].map((name) => ({ path: name, sizeBytes: entries.get(name)!.length, sha256: sha(entries.get(name)!) }));
  entries.set("resource-package.json", Buffer.from(JSON.stringify({ schemaVersion: 3, id: latest.id, version, surveyId: latest.surveyId, layers: records, files })));
  const sources = [...new Map(inputs.flatMap((input) => input.entry.sources).map((source) => [`${source.releaseId}:${source.url}`, source])).values()];
  return { entries, metadata: { ...latest, version, releases: [...new Set(records.map((layer) => layer.releaseId))].sort(), releaseLabels: Object.assign({}, ...inputs.map((input) => input.entry.releaseLabels)), sources, modalities: [...new Set(records.map((layer) => layer.modality))], deprecated: false, hidden: false, replacedBy: [] } };
}
