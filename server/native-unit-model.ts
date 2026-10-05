import { createHash } from "node:crypto";
import path from "node:path";
import { isDeniedSurvey } from "./publication-policy.js";
import { AdminHttpError } from "./admin-error.js";

export type NativeAdapter = "legacy-roster" | "legacy-geometry" | "desi-tile" | "euclid-tap" | "hst-caom" | "hsc-patch" | "entrypoint" | "gaia-healpix-range" | "sdss-field" | "mast-observation" | "eso-obscore-vvv" | "eso-obscore-fds" | "eso-obscore-kids" | "eso-obscore-vphas" | "eso-obscore-viking" | "skymapper-dr4-ccd" | "twomass-6x-atlas" | "allwise-ibe-atlas" | "noirlab-des-tap" | "noirlab-decaps-tap" | "spherex-qr2-s3-observation" | "cadc-caom-cfhtls" | "act-dr5-whole-map" | "panstarrs-dr1-skycell";
export type NativeTaskKind = "baseline" | "discover" | "acquire" | "import" | "build" | "verify" | "archive" | "activate" | "restore";
export interface NativeFile {
  ref: string; sha256: string; sizeBytes: number; objectKey?: string; sourceUrl?: string;
  archive?: { encoding: "gzip"; sha256: string; sizeBytes: number };
}
export interface NativeSource {
  id: string; revision: number; surveyId: string; releaseId: string; title: string;
  adapter: NativeAdapter; unitKind: "tile" | "brick" | "observation" | "tract/patch" | "target" | "healpix-range" | "field" | "ccd" | "image";
  scope: string; sourceUrl: string; files: Array<NativeFile & { slot?: string }>;
  slot: string; query?: string; updatedAt: string;
}
export interface NativeSnapshot {
  id: string; sourceId: string; sourceRevision: number; capturedAt: string;
  files: NativeFile[]; scope: string; sourceUrl: string; rowCount?: number;
  patch?: unknown; recipeText?: string; hstRoot?: string; hstManifest?: string;
}
export interface NativeBinding {
  productId: string; layerId: string; surveyId: string; releaseId: string; product: string;
  modality?: string; unitKind: string; sourceIds: string[]; revision: string;
  instrument?: string; filters?: string; observationId?: string;
  selector?: { releaseTags?: string[]; bands?: string[]; proposalIds?: string[]; instrument?: string; targets?: string[]; project?: string; unitPrefixes?: string[] };
  visibility: "published" | "imported-overview";
}
export interface NativeCheck { id: string; passed: boolean; detail: string }
export interface NativeReport {
  checks: NativeCheck[]; gaps: string[]; counts: Record<string, number>;
  unavailableBindings?: string[];
  samples: Array<{ layerId: string; unitKind: string; unitId: string; order: number; cells: number[]; precision: string; uris: string[]; sRegion?: string }>;
  peakRssMiB?: number; elapsedMs?: number; cacheHit?: boolean;
}
export interface NativeGroup {
  id: string; createdAt: string; origin: "imported-baseline" | "managed-build";
  generic?: { file: NativeFile; buildKey: string };
  hst?: { file: NativeFile; root: string; manifest: string; sourceSha256: string };
  survey?: { file: NativeFile; buildKey: string };
  lockText: string; recipes: Record<string, string>; snapshots: Record<string, NativeSnapshot>;
  bindings: NativeBinding[]; report: NativeReport;
  review?: { at: string; actor: string; digest: string; acceptedGaps: string[] };
}
export interface NativeOperation {
  kind: "native-unit"; operation: NativeTaskKind; sourceId?: string; sourceRevision?: number;
  groupId?: string; expectedActive?: string | null; actor: string; submittedAt: string;
  importFiles?: NativeFile[]; bindings?: NativeBinding[];
  snapshotIds?: string[]; reviewDigest?: string;
}
export interface NativeTaskDocument {
  id: string; operation: NativeTaskKind; sourceId?: string; groupId?: string; actor: string;
  submittedAt: string; phase: string; attempts: number; progress?: string;
  result?: { snapshotId?: string; groupId?: string; noChange?: boolean; discovered?: { sourceUrl: string; reachable: boolean; sizeBytes?: number } }; error?: string;
}
export interface NativeState {
  schemaVersion: 1; sources: NativeSource[]; snapshots: NativeSnapshot[]; groups: NativeGroup[];
  active: string | null; generation: number; history: Array<{ at: string; actor: string; action: string; id: string }>;
  tasks: Record<string, Pick<NativeTaskDocument, "progress" | "result">>;
}
export interface NativeWorkerRequest {
  operation: NativeOperation; catalogRoot: string; evidenceRoot: string; taskId: string;
  source?: NativeSource; sources: NativeSource[]; snapshots: NativeSnapshot[]; active?: NativeGroup;
  bindings: NativeBinding[];
}
export interface NativeWorkerResult { snapshot?: NativeSnapshot; group?: NativeGroup; report?: NativeReport; discovered?: { sourceUrl: string; reachable: boolean; sizeBytes?: number }; noChange?: boolean }

export const nativeDigest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const nativeNow = (): string => new Date().toISOString();
export function nativeEvidencePath(root: string, ref: string): string {
  if (!ref || path.isAbsolute(ref) || ref.includes("\\") || ref.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f]/.test(ref)) throw new AdminHttpError(400, "Invalid evidence reference");
  return path.join(root, ref);
}
export function assertNativeSurvey(surveyId: string): void {
  if (isDeniedSurvey(surveyId) || !["legacy-surveys", "act", "decals", "des", "decaps", "desi", "euclid", "fds", "hst", "hsc-ssp", "kids", "gaia", "sdss", "galex", "jwst", "vista", "skymapper", "2mass", "allwise", "spherex", "vphas", "cfhtls", "panstarrs"].includes(surveyId)) throw new AdminHttpError(400, "Native-unit management accepts only registered public surveys");
}
export function nativeMetadataUrl(value: string, adapter: NativeAdapter): URL {
  const url = new URL(value);
  const hosts: Record<NativeAdapter, string[]> = {
    "legacy-roster": ["portal.nersc.gov"], "legacy-geometry": ["portal.nersc.gov"],
    "desi-tile": ["data.desi.lbl.gov", "data.desi.lbl.gov:443"], "euclid-tap": ["eas.esac.esa.int"],
    "hst-caom": ["mast.stsci.edu"], "hsc-patch": ["hsc-release.mtk.nao.ac.jp"],
    "gaia-healpix-range": ["gaia.eu-1.cdn77-storage.com"], "sdss-field": ["data.sdss.org"], "mast-observation": ["mast.stsci.edu"],
    "eso-obscore-vvv": ["archive.eso.org"],
    "eso-obscore-fds": ["archive.eso.org"],
    "eso-obscore-kids": ["archive.eso.org"],
    "eso-obscore-vphas": ["archive.eso.org"],
    "eso-obscore-viking": ["archive.eso.org"],
    "skymapper-dr4-ccd": ["api.skymapper.nci.org.au"], "twomass-6x-atlas": ["irsa.ipac.caltech.edu"], "allwise-ibe-atlas": ["irsa.ipac.caltech.edu"],
    "noirlab-des-tap": ["datalab.noirlab.edu"], "noirlab-decaps-tap": ["datalab.noirlab.edu"],
    "spherex-qr2-s3-observation": ["nasa-irsa-spherex.s3.us-east-1.amazonaws.com"],
    "cadc-caom-cfhtls": ["ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca"],
    "act-dr5-whole-map": ["lambda.gsfc.nasa.gov"],
    "panstarrs-dr1-skycell": ["ps1images.stsci.edu"],
    entrypoint: ["euclid.esac.esa.int", "www.cosmos.esa.int"],
  };
  if (url.protocol !== "https:" || url.username || url.password || !hosts[adapter].includes(url.host)) throw new AdminHttpError(400, "Use an official public metadata source for this adapter");
  if (["legacy-roster", "legacy-geometry"].includes(adapter) && !/\/(?:survey-bricks[^/]*|decals-bricks[^/]*)\.fits(?:\.gz)?$/.test(url.pathname)) throw new AdminHttpError(400, "The Legacy adapter accepts official brick metadata tables");
  if (adapter === "desi-tile" && !/\/(?:tiles[^/]*|desi-tiles[^/]*)\.fits(?:\.gz)?$/.test(url.pathname)) throw new AdminHttpError(400, "The DESI adapter accepts Tile metadata tables");
  if (adapter === "euclid-tap" && !url.pathname.includes("/tap")) throw new AdminHttpError(400, "Use the ESA metadata TAP endpoint");
  if (["hst-caom", "mast-observation"].includes(adapter) && url.pathname !== "/api/v0/invoke") throw new AdminHttpError(400, "Use the MAST CAOM metadata endpoint");
  if (adapter === "gaia-healpix-range" && (url.pathname !== "/" || url.searchParams.get("prefix") !== "Gaia/gdr3/gaia_source/" || url.searchParams.get("delimiter") !== "/")) throw new AdminHttpError(400, "Use the Gaia DR3 metadata listing, not a scientific catalog file");
  if (adapter === "sdss-field" && url.pathname !== "/sas/dr9/env/PHOTO_RESOLVE/window_flist.fits") throw new AdminHttpError(400, "Use the official SDSS DR9 native field metadata table");
  if (["eso-obscore-vvv", "eso-obscore-fds", "eso-obscore-kids", "eso-obscore-vphas", "eso-obscore-viking"].includes(adapter) && url.pathname !== "/tap_obs/sync") {
    const surveyName = adapter === "eso-obscore-vvv" ? "VVV" : adapter === "eso-obscore-fds" ? "FDS" : adapter === "eso-obscore-kids" ? "KiDS" : adapter === "eso-obscore-viking" ? "VIKING" : "VPHAS+";
    throw new AdminHttpError(400, `Use the official ESO ObsCore TAP service for ${surveyName} metadata`);
  }
  if (adapter === "skymapper-dr4-ccd" && url.pathname !== "/public/tap/sync") throw new AdminHttpError(400, "Use the official SkyMapper DR4 TAP metadata endpoint");
  if (adapter === "twomass-6x-atlas" && url.pathname !== "/cgi-bin/2MASS/IM/nph-im_sia") throw new AdminHttpError(400, "Use the official IRSA 2MASS SIA metadata endpoint");
  if (adapter === "allwise-ibe-atlas" && url.pathname !== "/TAP/sync") throw new AdminHttpError(400, "Use the official IRSA AllWISE TAP metadata endpoint");
  if (adapter === "noirlab-des-tap" && url.pathname !== "/tap/sync") throw new AdminHttpError(400, "Use the official NOIRLab Data Lab TAP metadata endpoint");
  if (adapter === "noirlab-decaps-tap" && url.pathname !== "/tap/sync") throw new AdminHttpError(400, "Use the official NOIRLab Data Lab DECaPS metadata endpoint");
  if (adapter === "spherex-qr2-s3-observation" && url.pathname !== "/") throw new AdminHttpError(400, "Use the official NASA/IPAC SPHEREx QR2 AWS metadata listing");
  if (adapter === "cadc-caom-cfhtls" && url.pathname !== "/argus/sync") throw new AdminHttpError(400, "Use the official CADC CAOM TAP service for CFHTLS metadata");
  if (adapter === "act-dr5-whole-map" && url.pathname !== "/product/act/actpol_dr5_coadd_maps_get.html") throw new AdminHttpError(400, "Use the official ACT DR5 normal-map roster page");
  if (adapter === "panstarrs-dr1-skycell" && url.pathname !== "/cgi-bin/ps1filenames.py") throw new AdminHttpError(400, "Use the official Pan-STARRS DR1 image-list service");
  return url;
}
export function groupReviewDigest(group: NativeGroup): string {
  return nativeDigest({ id: group.id, bindings: group.bindings, report: group.report, inputs: Object.values(group.snapshots).map(s => [s.id, s.sourceRevision]).sort() });
}
export function bindingRevision(binding: Omit<NativeBinding, "revision">, snapshots: Record<string, NativeSnapshot>): string {
  const { revision: _revision, ...identity } = binding as NativeBinding;
  return nativeDigest({ ...identity, inputs: binding.sourceIds.map(id => snapshots[id]?.id ?? id).sort() });
}
export function nativeGroupId(group: Omit<NativeGroup, "id" | "review">): string {
  return nativeDigest({ generic: group.generic && [group.generic.file.sha256, group.generic.buildKey], hst: group.hst && [group.hst.file.sha256, group.hst.sourceSha256], ...(group.survey ? { survey: [group.survey.file.sha256, group.survey.buildKey] } : {}), lock: JSON.parse(group.lockText), recipes: Object.fromEntries(Object.entries(group.recipes).map(([key, value]) => [key, JSON.parse(value)])), bindings: group.bindings });
}
