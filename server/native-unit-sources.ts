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
  if ((registry.layers ?? []).some((layer: Document) => layer.surveyId === "des" && layer.releaseId === "des-dr2")) add({
    id: "des-dr2-coadd-tiles", surveyId: "des", releaseId: "des-dr2", title: "DES DR2 coadd Tile images",
    adapter: "noirlab-des-tap", unitKind: "tile",
    scope: "Official DR2 normal g/r/i/z/Y coadd file rows from ivoa_des_dr2.siav1; complete within the captured coadd selector, not all DES data products.",
    sourceUrl: "https://datalab.noirlab.edu/tap/sync", slot: "survey",
    query: "SELECT object, fileref, filter, obs_pub_did, access_url, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4 FROM ivoa_des_dr2.siav1 WHERE obs_pub_did LIKE '%#1' AND filter IN ('g','r','i','z','Y') AND fileref NOT LIKE '%nobkg%' ORDER BY obs_pub_did",
    files: [],
  });
  if ((registry.layers ?? []).some((layer: Document) => layer.surveyId === "fds" && layer.releaseId === "fds-dr1")) add({
    id: "fds-dr1-science-fields", surveyId: "fds", releaseId: "fds-dr1", title: "FDS DR1 science-image fields",
    adapter: "eso-obscore-fds", unitKind: "field",
    scope: "The complete 97-row FDS DR1 science-image ObsCore roster (20 u, 26 g, 26 r, 25 i) from official ESO release 157; paired weight maps are retained as ancillary evidence, not spatial-unit image URIs. J2000 field polygons are transformed to estimated ICRS frame bounds; file availability is not verified per row.",
    sourceUrl: "https://archive.eso.org/tap_obs/sync", slot: "survey",
    query: "SELECT TOP 5000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'FDS' AND release_description = 'https://www.eso.org/rm/api/v1/public/releaseDescriptions/157' AND dataproduct_type = 'image' ORDER BY dp_id",
    files: [],
  });
  if ((registry.layers ?? []).some((layer: Document) => layer.surveyId === "vphas" && layer.releaseId === "vphas-dr4")) add({
    id: "vphas-dr4-eso-images", surveyId: "vphas", releaseId: "vphas-dr4", title: "VPHAS+ DR4 unstacked OmegaCAM images",
    adapter: "eso-obscore-vphas", unitKind: "image",
    scope: "The exact 15,534-row ESO DR4 submission from release description 145, with source-listed unstacked OmegaCAM pawprint files and per-file UNION of CCD polygons. This is the final incremental submission, not a reconciled cumulative DR4 inventory; J2000 CCD bounds are transformed to estimated ICRS geometry, valid-pixel masks are not checked and only representative file availability is probed.",
    sourceUrl: "https://archive.eso.org/tap_obs/sync", slot: "survey",
    query: "SELECT TOP 5000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'VPHASplus' AND release_description = 'https://www.eso.org/rm/api/v1/public/releaseDescriptions/145' AND dataproduct_type = 'image' ORDER BY dp_id",
    files: [],
  });
  if ((registry.layers ?? []).some((layer: Document) => layer.surveyId === "kids" && layer.releaseId === "kids-dr5")) add({
    id: "kids-dr5-eso-images", surveyId: "kids", releaseId: "kids-dr5", title: "KiDS DR5 gri Tile images",
    adapter: "eso-obscore-kids", unitKind: "tile",
    scope: "The complete ESO DR5 g/r/i image roster, including both i epochs: 5,388 source-listed image rows across 1,347 Tiles. Each source-listed file is joined by exact filename to the official KiDS Astro-WISE wget list; the providers may deliver different FITS headers and are recorded as separate sources, not byte-identical mirrors. J2000 image-frame polygons are transformed to estimated ICRS bounds; valid-pixel masks are not checked and individual file availability remains unverified.",
    sourceUrl: "https://archive.eso.org/tap_obs/sync", slot: "survey",
    query: "SELECT TOP 1000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'KIDS' AND release_description = 'https://www.eso.org/rm/api/v1/public/releaseDescriptions/229' AND dataproduct_type = 'image' AND filter IN ('g_SDSS','r_SDSS','i_SDSS') ORDER BY dp_id",
    files: [],
  });
  const hst = await optionalDocument(path.join(root, "src/layers/recipes/hst-public-image-observations.lock.json"));
  if (hst?.status === "ready" && hst.manifest) add({ id: "hst-public-images", surveyId: "hst", releaseId: "hst-public", title: "HST public image observations", adapter: "hst-caom", unitKind: "observation", scope: hst.scope, sourceUrl: hst.sourceUrl, slot: "hst", files: [snapshotFile(hst.manifest)] });
  for (const source of (await optionalDocument(path.join(root, "src/layers/recipes/survey-native-sources.json")))?.sources ?? []) add({ ...source, files: [] });
  return sources;
}

export function sourceIdsForBinding(binding: Pick<NativeBinding, "surveyId" | "releaseId">): string[] {
  if (binding.surveyId === "legacy-surveys") return [ `${binding.releaseId}-bricks`, ...(["legacy-dr1", "legacy-dr2"].includes(binding.releaseId) ? [] : ["legacy-brick-geometry"]) ];
  if (binding.surveyId === "decals" && binding.releaseId === "decals-dr5") return ["legacy-dr5-bricks", "legacy-brick-geometry"];
  if (binding.surveyId === "desi") return [`${binding.releaseId}-tiles`];
  if (binding.surveyId === "act" && binding.releaseId === "act-dr5") return ["act-dr5-normal-whole-maps"];
  if (binding.surveyId === "des" && binding.releaseId === "des-dr2") return ["des-dr2-coadd-tiles"];
  if (binding.surveyId === "decaps" && binding.releaseId === "decaps-dr2") return ["decaps-dr2-native-ccds"];
  if (binding.surveyId === "euclid") return [binding.releaseId === "euclid-ero" ? "euclid-ero-targets" : "euclid-q1-bgsub-tiles"];
  if (binding.surveyId === "hst") return ["hst-public-images"];
  if (binding.surveyId === "hsc-ssp") return [`${binding.releaseId}-patches`];
  if (binding.surveyId === "gaia" && binding.releaseId === "gaia-dr3") return ["gaia-dr3-file-partitions"];
  if (binding.surveyId === "sdss" && binding.releaseId === "sdss-dr09") return ["sdss-dr9-fields"];
  if (binding.surveyId === "galex" && ["galex-gr6-gr7", "galex-gr6-ais"].includes(binding.releaseId)) return ["galex-public-images"];
  if (binding.surveyId === "jwst" && binding.releaseId === "dr1") return ["jwst-early-release-images"];
  if (binding.surveyId === "vista" && binding.releaseId === "vista-vvv-dr4") return ["vista-vvv-dr4-observations"];
  if (binding.surveyId === "skymapper" && binding.releaseId === "skymapper-dr4") return ["skymapper-dr4-2014-mar15-18-ccds"];
  if (binding.surveyId === "2mass" && binding.releaseId === "2mass-6x") return ["2mass-6x-m31-1deg-atlas-images", "2mass-6x-lmc-1deg-atlas-images"];
  if (binding.surveyId === "allwise" && binding.releaseId === "allwise") return ["allwise-w3-w4-atlas"];
  if (binding.surveyId === "cfhtls" && binding.releaseId === "cfhtls-wide") return ["cfhtls-wide-t0007-single-band-images"];
  if (binding.surveyId === "spherex" && binding.releaseId === "spherex-qr2") return ["spherex-qr2-2025w17-4b-0001-1"];
  if (binding.surveyId === "fds" && binding.releaseId === "fds-dr1") return ["fds-dr1-science-fields"];
  if (binding.surveyId === "kids" && binding.releaseId === "kids-dr5") return ["kids-dr5-eso-images"];
  if (binding.surveyId === "vphas" && binding.releaseId === "vphas-dr4") return ["vphas-dr4-eso-images"];
  if (binding.surveyId === "vista" && binding.releaseId === "viking") return ["vista-viking-dr1-j-tiles"];
  if (binding.surveyId === "panstarrs" && binding.releaseId === "panstarrs-dr1") return ["panstarrs-dr1-zone23-skycells"];
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
