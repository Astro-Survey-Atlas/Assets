import { readFile } from "node:fs/promises";
import path from "node:path";
import { nativeNow, type NativeBinding, type NativeFile, type NativeSource } from "./native-unit-model.js";

type Document = Record<string, any>;
const snapshotFile = (snapshot: Document, slot?: string): NativeFile & { slot?: string } => ({ ref: snapshot.path, sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes ?? 0, sourceUrl: snapshot.sourceUrl, ...(slot ? { slot } : {}) });
async function optionalDocument(file: string): Promise<Document | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as Document; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** This is a recipe catalog, not an inventory loader. No source rows reach the UI. */
export async function nativeSourceRecipes(root: string): Promise<NativeSource[]> {
  let lock: Document;
  try { lock = JSON.parse(await readFile(path.join(root, "src/layers/recipes/source-unit-indexes.lock.json"), "utf8")) as Document; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const sources: NativeSource[] = [];
  const add = (source: Omit<NativeSource, "revision" | "updatedAt">): void => { sources.push({ ...source, revision: 1, updatedAt: nativeNow() }); };
  for (const [key, releaseId] of [["legacyDr1", "legacy-dr1"], ["legacyDr2", "legacy-dr2"]]) {
    const item = lock[key!];
    if (item?.snapshot) add({ id: `${releaseId}-bricks`, surveyId: "legacy-surveys", releaseId: releaseId!, title: `${releaseId!.toUpperCase()} brick inventory`, adapter: "legacy-roster", unitKind: "brick", scope: item.note ?? `${releaseId} official release member flags; candidate files unverified`, sourceUrl: item.sourceUrl, slot: key!, files: [snapshotFile(item.snapshot)] });
  }
  if (lock.legacyDr10?.snapshot) add({ id: "legacy-brick-geometry", surveyId: "legacy-surveys", releaseId: "legacy-grid", title: "Legacy shared brick geometry", adapter: "legacy-geometry", unitKind: "brick", scope: "All-sky brick geometry only; this does not prove membership in any release", sourceUrl: lock.legacyDr10.sourceUrl, slot: "legacyDr10", files: [snapshotFile(lock.legacyDr10.snapshot)] });
  for (const [releaseId, value] of Object.entries(lock.legacyReleaseRosters?.releases ?? {})) {
    const item = value as Document;
    add({ id: `${releaseId}-bricks`, surveyId: "legacy-surveys", releaseId, title: `${releaseId.toUpperCase()} brick inventory`, adapter: "legacy-roster", unitKind: "brick", scope: item.scope, sourceUrl: item.regions[0].snapshot.sourceUrl, slot: `legacyReleaseRosters.releases.${releaseId}`, files: item.regions.map((region: Document) => snapshotFile(region.snapshot, region.id)) });
  }
  if (lock.euclidQ1?.snapshot) add({ id: "euclid-q1-bgsub-tiles", surveyId: "euclid", releaseId: "euclid-q1", title: "Euclid Q1 BGSUB Tiles", adapter: "euclid-tap", unitKind: "tile", scope: "Q1_R1 BGSUB mosaic inventory only; not complete Euclid Q1", sourceUrl: lock.euclidQ1.sourceUrl, slot: "euclidQ1", query: lock.euclidQ1.snapshotQuery, files: [snapshotFile(lock.euclidQ1.snapshot)] });
  add({ id: "euclid-ero-targets", surveyId: "euclid", releaseId: "euclid-ero", title: "Euclid ERO target packages", adapter: "entrypoint", unitKind: "target", scope: "Official target-package entrypoints; no verified ERO Tile inventory", sourceUrl: "https://euclid.esac.esa.int/dr/ero/", slot: "entrypoint", files: [] });
  for (const key of ["hscPdr2", "hscPdr3"]) {
    const item = lock[key];
    if (item?.sourceFiles) add({ id: `${item.releaseId}-patches`, surveyId: "hsc-ssp", releaseId: item.releaseId, title: `${item.releaseId.toUpperCase()} tract/patch geometry`, adapter: "hsc-patch", unitKind: "tract/patch", scope: "Official tract/patch geometry; DAS login entrypoint; file inventory unverified", sourceUrl: item.sourceUrl, slot: key, files: item.sourceFiles.map((file: Document) => snapshotFile(file, file.region)) });
  }
  const registry = await optionalDocument(path.join(root, "src/layers/layer-registry.json")) ?? {};
  const seen = new Set<string>();
  for (const layer of registry.layers ?? []) {
    if (layer.surveyId !== "desi" || !layer.recipePath || seen.has(layer.recipePath)) continue;
    seen.add(layer.recipePath);
    const recipe = JSON.parse(await readFile(path.join(root, layer.recipePath), "utf8")) as Document;
    if (recipe.mode !== "tile-table") continue;
    add({ id: `${layer.releaseId}-tiles`, surveyId: "desi", releaseId: layer.releaseId, title: `${layer.releaseId.toUpperCase()} Tile candidates`, adapter: "desi-tile", unitKind: "tile", scope: "Official Tile geometry is estimated; not target-level spectroscopy coverage", sourceUrl: recipe.sourceUrl, slot: layer.recipePath, files: [{ ref: recipe.input.split("/raw/").at(-1), sha256: recipe.snapshot.sha256, sizeBytes: recipe.snapshot.sizeBytes ?? 0, sourceUrl: recipe.sourceUrl }] });
  }
  const hst = await optionalDocument(path.join(root, "src/layers/recipes/hst-public-image-observations.lock.json"));
  if (hst?.status === "ready" && hst.manifest) add({ id: "hst-public-images", surveyId: "hst", releaseId: "hst-public", title: "HST public image observations", adapter: "hst-caom", unitKind: "observation", scope: hst.scope, sourceUrl: hst.sourceUrl, slot: "hst", files: [snapshotFile(hst.manifest)] });
  for (const source of (await optionalDocument(path.join(root, "src/layers/recipes/survey-native-sources.json")))?.sources ?? []) add({ ...source, files: [] });
  return sources;
}

export function sourceIdsForBinding(binding: Pick<NativeBinding, "surveyId" | "releaseId">): string[] {
  if (binding.surveyId === "legacy-surveys") return [ `${binding.releaseId}-bricks`, ...(["legacy-dr1", "legacy-dr2"].includes(binding.releaseId) ? [] : ["legacy-brick-geometry"]) ];
  if (binding.surveyId === "desi") return [`${binding.releaseId}-tiles`];
  if (binding.surveyId === "euclid") return [binding.releaseId === "euclid-ero" ? "euclid-ero-targets" : "euclid-q1-bgsub-tiles"];
  if (binding.surveyId === "hst") return ["hst-public-images"];
  if (binding.surveyId === "hsc-ssp") return [`${binding.releaseId}-patches`];
  if (binding.surveyId === "gaia" && binding.releaseId === "gaia-dr3") return ["gaia-dr3-file-partitions"];
  if (binding.surveyId === "sdss" && binding.releaseId === "sdss-dr09") return ["sdss-dr9-fields"];
  if (binding.surveyId === "galex" && ["galex-gr6-gr7", "galex-gr6-ais"].includes(binding.releaseId)) return ["galex-public-images"];
  if (binding.surveyId === "jwst" && binding.releaseId === "dr1") return ["jwst-early-release-images"];
  return [];
}

export function getNativeSlot(document: Document, slot: string): any {
  return slot.split(".").reduce((value, key) => value?.[key], document);
}
export function setNativeSlot(document: Document, slot: string, value: unknown): void {
  const keys = slot.split(".");
  if (keys.some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("Invalid source recipe slot");
  const parent = keys.slice(0, -1).reduce((record, key) => record[key] ??= {}, document);
  parent[keys.at(-1)!] = value;
}
