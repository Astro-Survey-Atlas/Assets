import { createHash } from "node:crypto";
import path from "node:path";
import { isDeniedSurvey } from "./publication-policy.js";
import { AdminHttpError } from "./admin-error.js";

export type NativeAdapter = "legacy-roster" | "legacy-geometry" | "desi-tile" | "euclid-tap" | "hst-caom" | "hsc-patch" | "entrypoint" | "gaia-healpix-range" | "sdss-field" | "mast-observation";
export type NativeTaskKind = "baseline" | "discover" | "acquire" | "import" | "build" | "verify" | "archive" | "activate" | "restore";
export interface NativeFile {
  ref: string; sha256: string; sizeBytes: number; objectKey?: string; sourceUrl?: string;
  archive?: { encoding: "gzip"; sha256: string; sizeBytes: number };
}
export interface NativeSource {
  id: string; revision: number; surveyId: string; releaseId: string; title: string;
  adapter: NativeAdapter; unitKind: "tile" | "brick" | "observation" | "tract/patch" | "target" | "healpix-range" | "field";
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
  selector?: { releaseTags?: string[]; bands?: string[]; proposalIds?: string[]; instrument?: string; targets?: string[]; project?: string };
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
  if (isDeniedSurvey(surveyId) || !["legacy-surveys", "desi", "euclid", "hst", "hsc-ssp", "gaia", "sdss", "galex", "jwst"].includes(surveyId)) throw new AdminHttpError(400, "Native-unit management accepts only registered public surveys");
}
export function nativeMetadataUrl(value: string, adapter: NativeAdapter): URL {
  const url = new URL(value);
  const hosts: Record<NativeAdapter, string[]> = {
    "legacy-roster": ["portal.nersc.gov"], "legacy-geometry": ["portal.nersc.gov"],
    "desi-tile": ["data.desi.lbl.gov", "data.desi.lbl.gov:443"], "euclid-tap": ["eas.esac.esa.int"],
    "hst-caom": ["mast.stsci.edu"], "hsc-patch": ["hsc-release.mtk.nao.ac.jp"],
    "gaia-healpix-range": ["gaia.eu-1.cdn77-storage.com"], "sdss-field": ["data.sdss.org"], "mast-observation": ["mast.stsci.edu"],
    entrypoint: ["euclid.esac.esa.int", "www.cosmos.esa.int"],
  };
  if (url.protocol !== "https:" || url.username || url.password || !hosts[adapter].includes(url.host)) throw new AdminHttpError(400, "Use an official public metadata source for this adapter");
  if (["legacy-roster", "legacy-geometry"].includes(adapter) && !/\/(?:survey-bricks[^/]*|decals-bricks[^/]*)\.fits(?:\.gz)?$/.test(url.pathname)) throw new AdminHttpError(400, "The Legacy adapter accepts official brick metadata tables");
  if (adapter === "desi-tile" && !/\/(?:tiles[^/]*|desi-tiles[^/]*)\.fits(?:\.gz)?$/.test(url.pathname)) throw new AdminHttpError(400, "The DESI adapter accepts Tile metadata tables");
  if (adapter === "euclid-tap" && !url.pathname.includes("/tap")) throw new AdminHttpError(400, "Use the ESA metadata TAP endpoint");
  if (["hst-caom", "mast-observation"].includes(adapter) && url.pathname !== "/api/v0/invoke") throw new AdminHttpError(400, "Use the MAST CAOM metadata endpoint");
  if (adapter === "gaia-healpix-range" && (url.pathname !== "/" || url.searchParams.get("prefix") !== "Gaia/gdr3/gaia_source/" || url.searchParams.get("delimiter") !== "/")) throw new AdminHttpError(400, "Use the Gaia DR3 metadata listing, not a scientific catalog file");
  if (adapter === "sdss-field" && url.pathname !== "/sas/dr9/env/PHOTO_RESOLVE/window_flist.fits") throw new AdminHttpError(400, "Use the official SDSS DR9 native field metadata table");
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
