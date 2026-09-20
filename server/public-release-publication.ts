import { uploadObjectRelease, restoreObjectRelease, activateObjectRelease } from "./object-release.js";
import { createHash, randomUUID } from "node:crypto";
import { buildApprovedRelease, currentReview, productGeometry, readApprovedRelease } from "./approved-release.js";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { activateReleasePointer, createArtifactStoreFromProcess, uploadReleaseArchive, type ArtifactStore, type UploadedReleaseArchive } from "./artifact-store.js";
import { publicReleaseBundleDigest } from "./catalog.js";
import type { MocPublication, MocPublicationFile } from "./moc-build.js";
import { dynamicResourcePackageAssetId, type DynamicResourcePackageAsset, type DynamicResourcePackageEntry } from "./resource-package-publication.js";
import { historicalPackages } from "./package-history.js";
import { assertReleaseContinuity } from "./package-continuity.js";
import { readResourcePackageManifest } from "./resource-package-inspection.js";
import {
  assertRecordPublishable,
  isDeniedSurvey,
  isDeniedLayerId,
  isSanitizableControlDocument,
  sanitizeReleaseControlDocument,
} from "./publication-policy.js";
import { loadSurveyLookups, projectResourcePackage, type ProjectedPackageSource } from "./resource-package-projection.js";
import { buildResourcePackageCollection } from "./resource-package-collection.js";
import type { ProductRecord } from "./products.js";
import { queueStateSnapshot, type StateSnapshotSink } from "./state-snapshot.js";
import { inferredPublicAssetDeliveryClass, type PublicAssetRecord } from "./types.js";

const MANIFEST_RELATIVE_PATH = "artifacts/public-survey-footprints/release-manifest.json";
const PACKAGE_CATALOG_RELATIVE_PATH = "artifacts/public-survey-footprints/packages/catalog.json";
const RELEASE_HISTORY_RELATIVE_PATH = "artifacts/public-survey-footprints/release-history.json";
const execFile = promisify(execFileCallback);

export interface ReleaseHistorySurvey {
  id: string;
  displayName: string;
  mission?: string;
}

export interface ReleaseHistoryRelease {
  id: string;
  label: string;
  kind?: string;
  releasedYear?: number;
  modalities: string[];
  layerCount: number;
}

export interface ReleaseHistorySource {
  releaseId: string;
  label: string;
  url: string;
  authority: string;
}

export interface ReleaseHistoryPackage {
  id: string;
  version: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  survey?: ReleaseHistorySurvey;
  facilities?: string[];
  modalities?: string[];
  accessModes?: string[];
  sources?: ReleaseHistorySource[];
  releases?: ReleaseHistoryRelease[];
}

export interface ReleaseHistoryCollection {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
}

export interface ReleaseHistoryEntry {
  releaseId: string;
  sequence: number;
  bundleId: string;
  releasedAt: string;
  notes?: string;
  catalogSha256?: string;
  collection?: ReleaseHistoryCollection;
  packages: ReleaseHistoryPackage[];
}

export interface ReleaseHistoryDocument {
  schemaVersion: 2;
  latestReleaseId: string;
  releases: ReleaseHistoryEntry[];
}

export interface ReleaseManifestDocument {
  schemaVersion: 1;
  generatedAt: string;
  bundle: { id: string; sha256: string };
  statistics: Record<string, number>;
  files: PublicAssetRecord[];
}

export interface PublicationSurveyPlan {
  surveyId: string;
  publishedLayers: number;
  changedProducts: number;
  productDiffs: PublicationProductDiff[];
  currentPackage: { id: string; version: string; sha256: string; sizeBytes: number } | undefined;
  inReleasePackage: boolean;
  changed: boolean;
  blockers: string[];
  selectable: boolean;
}

export interface PublicationProductDiff {
  productId: string;
  surveyId: string;
  releaseId: string;
  name: string;
  change: "added" | "modified" | "removed";
  fields: string[];
  draftRevision: number;
  publishedRevision: number | null;
  reviewed: boolean;
  blockingReason?: string;
}

export interface PublicationPlan {
  planId: string;
  baselineBundle: { id: string; sha256: string };
  surveys: PublicationSurveyPlan[];
  changedSurveyIds: string[];
  dynamicPackages: number;
  dynamicLayers: number;
  createdAt: string;
  /** Bounded identity expectations used when the configured site is verified. */
  verification?: PublicationVerificationExpectation;
}

export interface PublicationRunRequest {
  planId: string;
  expectedBaselineSha256: string;
  surveyIds: string[];
  productIds?: string[];
}

export type PublicationRunStatus = "queued" | "building" | "uploading" | "verifying" | "published" | "failed" | "cancelled";
export type PublicationFailureStage = "build" | "upload" | "candidate" | "activate";

export type PublicationVerificationState = "pending" | "passed" | "failed" | "not-configured";
export interface PublicationVerification {
  overall: "pending" | "authority-published" | "site-pending" | "verified" | "failed";
  candidate: { state: PublicationVerificationState; checkedAt?: string; bundleSha256?: string; error?: string };
  authority: { state: PublicationVerificationState; checkedAt?: string; bundleSha256?: string; error?: string };
  site: {
    state: PublicationVerificationState;
    target?: string;
    checkedAt?: string;
    observedBundleSha256?: string;
    checkedProducts?: number;
    missingProducts?: string[];
    missingLayers?: string[];
    missingPackages?: string[];
    unexpectedProducts?: string[];
    unexpectedLayers?: string[];
    unexpectedPackages?: string[];
    error?: string;
  };
}

export interface PublicationVerificationExpectation {
  products: Array<{ productId: string; surveyId: string; present: boolean }>;
  layers: Array<{ layerId: string; surveyId: string; present: boolean }>;
  packages: Array<{ id: string; version: string; surveyId: string; present: boolean }>;
}

export interface PublicationRun {
  runId: string;
  selectedProducts?: Array<{productId:string;revision:number}>;
  queue?: { phase: string; attempts: number; nextAttemptAt?: string; cancellable: boolean; syncDelayed: boolean };

  planId: string;
  baselineBundle: { id: string; sha256: string };
  surveyIds: string[];
  status: PublicationRunStatus;
  requestedBy: string | undefined;
  createdAt: string;
  startedAt: string | undefined;
  /** The worker lease is refreshed while a run is active. */
  claimedAt?: string;
  lastProgressAt?: string;
  finishedAt: string | undefined;
  bundle: { id: string; sha256: string } | undefined;
  manifestKey?: string;
  archiveKey: string | undefined;
  archiveSizeBytes: number | undefined;
  archiveSha256: string | undefined;
  files: number | undefined;
  packages: number | undefined;
  error: string | undefined;
  /** The durable stage at which the last attempt stopped. */
  failureStage?: PublicationFailureStage;
  /** Set when a worker lease expired; the operator can recover this run. */
  recovery?: { detectedAt: string; reason: string };
  /** Identity-level expectations captured at submit time for target-site checks. */
  expected?: PublicationVerificationExpectation;
  verification?: PublicationVerification;
  log: string[];
}

export class PublicationConflictError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
    this.name = "PublicationConflictError";
  }
}

type PublicPackageEntry = Omit<DynamicResourcePackageEntry, "archivePath" | "objectKey" | "contentFingerprint">;

interface PackageProvider {
  list(): PublicPackageEntry[] | Promise<PublicPackageEntry[]>;
  assets(): DynamicResourcePackageAsset[] | Promise<DynamicResourcePackageAsset[]>;
  latest(id: string): PublicPackageEntry | undefined;
}

interface CandidateBuild {
  root: string;
  files: PublicAssetRecord[];
  packages: PublicPackageEntry[];
}

export interface PublicationRunRepository {
  get(id: string): Promise<PublicationRun | undefined>;
  list(): Promise<PublicationRun[]>;
  submit(run: PublicationRun): Promise<PublicationRun>;
  write(run: PublicationRun): Promise<void>;
  retry?(run: PublicationRun): Promise<PublicationRun | undefined>;
}

export interface PublicReleasePublisherOptions {
  runRepository?: PublicationRunRepository;
  activateCandidate?: typeof activateObjectRelease;
  deferSiteVerification?: boolean;
  contentRoot: string;
  baselineRoot: string;
  loadPublications: () => Promise<MocPublication[]> | MocPublication[];
  publicationFile: (file: MocPublicationFile) => string;
  loadPackages: PackageProvider;
  loadProducts?: () => Promise<ProductRecord[]> | ProductRecord[];
  store?: ArtifactStore;
  allowFilesystemStore?: boolean;
  snapshotSink?: StateSnapshotSink;
  /** Explicit operator-configured public site target for post-publication checks. */
  verificationTarget?: string;
  /** Deployment-owned Service URL; never accepted from an HTTP request. */
  internalVerificationTarget?: string;
  /** Injectable HTTP client keeps target-site checks deterministic in tests. */
  fetchImpl?: typeof fetch;
  /** Maximum time without a worker heartbeat before an active run is released. */
  publicationLeaseMs?: number;
}

interface LatestPackage {
  entry: PublicPackageEntry;
  asset: DynamicResourcePackageAsset;
}

async function latestPackages(packages: PackageProvider): Promise<Map<string, LatestPackage>> {
  const latest = new Map<string, LatestPackage>();
  const assets = await packages.assets();
  for (const entry of await packages.list()) {
    if (entry.hidden || entry.deprecated) continue;
    const existing = latest.get(entry.id);
    if (existing && !existing.entry.deprecated && entry.deprecated) continue;
    if (existing && !entry.deprecated && packageMinor(existing.entry.version) > packageMinor(entry.version)) continue;
    const asset = assets.find((candidate) => candidate.id === dynamicResourcePackageAssetId(entry));
    if (!asset) continue;
    latest.set(entry.id, { entry, asset });
  }
  return latest;
}

function packageMinor(version: string): number {
  const match = /^3\.(\d+)\.\d+$/.exec(version);
  return match ? Number(match[1]) : -1;
}

function productDiffFields(product: ProductRecord): string[] {
  if (product.retiredAt) return ["retirement", ...(product.retirementReason ? ["retirementReason"] : [])];
  if (!product.published) return ["identity", "source", "coverage", "presentation"];
  const fields = ["name", "modality", "mode", "layerId", "coverageRole", "dataOrigin", "sourceTier", "originNote", "sourceLabel", "sourceUrl", "officialDataUrl", "officialQueryUrl", "geometrySourceUrl", "publicDescription", "publicStatus", "presentation"] as const;
  return fields.filter((field) => JSON.stringify(product.draft[field]) !== JSON.stringify(product.published?.[field]));
}

function productDiff(product: ProductRecord): PublicationProductDiff | undefined {
  if (product.retiredAt && product.published) {
    if (product.publishedRevision !== null && product.revision <= product.publishedRevision) return undefined;
    return {
      productId: product.productId,
      surveyId: product.draft.surveyId,
      releaseId: product.draft.releaseId,
      name: product.draft.name,
      change: "removed",
      fields: productDiffFields(product),
      draftRevision: product.revision,
      publishedRevision: product.publishedRevision,
      reviewed: true,
    };
  }
  if (product.publishedRevision !== null && product.revision <= product.publishedRevision) return undefined;
  return {
    productId: product.productId,
    surveyId: product.draft.surveyId,
    releaseId: product.draft.releaseId,
    name: product.draft.name,
    change: product.published ? "modified" : "added",
    fields: productDiffFields(product),
    draftRevision: product.revision,
    publishedRevision: product.publishedRevision,
    reviewed: Boolean(product.review && product.review.revision === product.revision && product.review.contentSha256 === product.contentSha256),
  };
}

/** Capture the identity checks a target site must satisfy for one run. */
async function verificationExpectations(
  surveyIds: readonly string[],
  diffs: readonly PublicationProductDiff[],
  products: readonly ProductRecord[],
  publications: readonly MocPublication[],
  packages: readonly PublicationSurveyPlan[],
): Promise<PublicationVerificationExpectation> {
  const selected = new Set(surveyIds);
  const productStates = new Map<string, { productId: string; surveyId: string; present: boolean }>();
  const layerStates = new Map<string, { layerId: string; surveyId: string; present: boolean }>();
  for (const diff of diffs) {
    if (!selected.has(diff.surveyId)) continue;
    productStates.set(diff.productId, { productId: diff.productId, surveyId: diff.surveyId, present: diff.change !== "removed" });
    const product = products.find((candidate) => candidate.productId === diff.productId);
    const publication = publications.find((candidate) => candidate.productId === diff.productId);
    const layerId = product?.draft.layerId ?? publication?.layerId;
    if (layerId) layerStates.set(layerId, { layerId, surveyId: diff.surveyId, present: diff.change !== "removed" });
  }
  // A selected survey can change only because a new MOC layer or package was
  // staged. Include every current product and layer for that survey so a
  // target cannot report success after silently dropping one of those
  // outputs. Product records without a publication still need checking: the
  // public product API is backed by ProductStore, not the MOC publication log.
  for (const product of products) {
    if (!selected.has(product.draft.surveyId) || product.retiredAt) continue;
    if (product.published || product.publishedRevision === null) {
      productStates.set(product.productId, { productId: product.productId, surveyId: product.draft.surveyId, present: true });
    }
    if (product.draft.layerId) layerStates.set(product.draft.layerId, { layerId: product.draft.layerId, surveyId: product.draft.surveyId, present: true });
  }
  for (const publication of publications) {
    if (!selected.has(publication.surveyId)) continue;
    const product = products.find((candidate) => candidate.productId === publication.productId);
    if (product?.retiredAt) continue;
    productStates.set(publication.productId, { productId: publication.productId, surveyId: publication.surveyId, present: true });
    layerStates.set(publication.layerId, { layerId: publication.layerId, surveyId: publication.surveyId, present: true });
  }
  const packageStates = new Map<string, { id: string; version: string; surveyId: string; present: boolean }>();
  for (const survey of packages) {
    if (!selected.has(survey.surveyId) || !survey.currentPackage) continue;
    const key = `${survey.currentPackage.id}@${survey.currentPackage.version}`;
    packageStates.set(key, { id: survey.currentPackage.id, version: survey.currentPackage.version, surveyId: survey.surveyId, present: true });
  }
  return {
    products: [...productStates.values()].sort((left, right) => left.productId.localeCompare(right.productId)),
    layers: [...layerStates.values()].sort((left, right) => left.layerId.localeCompare(right.layerId)),
    packages: [...packageStates.values()].sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version)),
  };
}

function slugifyReleaseId(releaseId: string): string {
  return releaseId.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isPublicationRun(value: unknown): value is PublicationRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<PublicationRun>;
  return typeof run.runId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run.runId)
    && typeof run.planId === "string"
    && typeof run.status === "string"
    && ["queued", "building", "uploading", "verifying", "published", "failed", "cancelled"].includes(run.status)
    && Array.isArray(run.surveyIds)
    && Array.isArray(run.log);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

function safeArchivePath(value: string): string {
  if (!value || value.includes("\0") || value.startsWith("/")) throw new PublicationConflictError(`Candidate archive contains an unsafe path: ${value}`, 500);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    throw new PublicationConflictError(`Candidate archive contains an unsafe path: ${value}`, 500);
  }
  return normalized;
}

async function regularFiles(root: string, relative = ""): Promise<string[]> {
  const directory = relative ? path.join(root, relative) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await regularFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new PublicationConflictError(`Candidate archive contains a special file: ${child}`, 500);
  }
  return files;
}

export interface ReleaseArchiveVerification {
  state: "passed";
  checkedAt: string;
  bundleSha256: string;
  files: number;
  packageReferences: number;
  coverageDocuments: number;
}

interface ReleaseDocumentVerification {
  packageReferences: number;
  coverageDocuments: number;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicationConflictError(`${label} must be an object`, 500);
  return value as Record<string, unknown>;
}

function packageManifestRecord(records: Map<string, PublicAssetRecord>, id: string, version: string): PublicAssetRecord | undefined {
  const downloadName = `${id}-${version}.zip`;
  return [...records.values()].find((record) => record.kind === "package"
    && (record.downloadName === downloadName || record.path.endsWith(`/${downloadName}`)));
}

/** Validate the small runtime control documents that bind packages and coverage together. */
async function verifyReleaseDocuments(extractRoot: string, manifest: ReleaseManifestDocument): Promise<ReleaseDocumentVerification> {
  const manifestRecords = new Map(manifest.files.map((record) => [record.path, record]));
  const packageCatalogPath = path.join(extractRoot, PACKAGE_CATALOG_RELATIVE_PATH);
  let packageCatalog: Record<string, unknown>;
  try { packageCatalog = objectRecord(JSON.parse(await readFile(packageCatalogPath, "utf8")), "Resource package catalog"); }
  catch (error) {
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationConflictError(`Candidate resource package catalog is missing or invalid: ${error instanceof Error ? error.message : String(error)}`, 409);
  }
  if (packageCatalog.schemaVersion !== 3 || !Array.isArray(packageCatalog.packages)) throw new PublicationConflictError("Candidate resource package catalog is not v3", 500);
  let packageReferences = 0;
  const packageKeys = new Set<string>();
  for (const raw of packageCatalog.packages) {
    const entry = objectRecord(raw, "Resource package entry");
    const id = typeof entry.id === "string" ? entry.id : "";
    const version = typeof entry.version === "string" ? entry.version : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !/^3\.\d+\.\d+$/.test(version)) throw new PublicationConflictError("Resource package catalog contains an invalid identity", 500);
    const key = `${id}@${version}`;
    if (packageKeys.has(key)) throw new PublicationConflictError(`Resource package catalog contains duplicate ${key}`, 500);
    packageKeys.add(key);
    const record = packageManifestRecord(manifestRecords, id, version);
    if (!record) throw new PublicationConflictError(`Resource package catalog entry ${key} has no manifest ZIP`, 409);
    if (entry.sizeBytes !== undefined && entry.sizeBytes !== record.sizeBytes) throw new PublicationConflictError(`Resource package size mismatch: ${key}`, 409);
    if (entry.sha256 !== undefined && entry.sha256 !== record.sha256) throw new PublicationConflictError(`Resource package checksum mismatch: ${key}`, 409);
    if (entry.archiveUrl !== undefined && (typeof entry.archiveUrl !== "string" || /[\u0000-\u001f]/.test(entry.archiveUrl))) throw new PublicationConflictError(`Resource package archive URL is invalid: ${key}`, 500);
    let packageManifest: Awaited<ReturnType<typeof readResourcePackageManifest>>;
    try {
      packageManifest = await readResourcePackageManifest(await readFile(path.join(extractRoot, record.path)));
    } catch (error) {
      throw new PublicationConflictError(`Resource package ${key} does not contain a valid resource-package.json: ${error instanceof Error ? error.message : String(error)}`, 409);
    }
    if (packageManifest.id !== id || packageManifest.version !== version) {
      throw new PublicationConflictError(`Resource package manifest identity mismatch: expected ${key}, got ${packageManifest.id}@${packageManifest.version}`, 409);
    }
    if (typeof entry.surveyId === "string" && packageManifest.surveyId !== entry.surveyId) {
      throw new PublicationConflictError(`Resource package survey mismatch: ${key}`, 409);
    }
    packageReferences += 1;
  }

  const historyPath = path.join(extractRoot, RELEASE_HISTORY_RELATIVE_PATH);
  let history: Record<string, unknown>;
  try { history = objectRecord(JSON.parse(await readFile(historyPath, "utf8")), "Release history"); }
  catch (error) {
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationConflictError(`Candidate release history is missing or invalid: ${error instanceof Error ? error.message : String(error)}`, 409);
  }
  if (history.schemaVersion !== 2 || !Array.isArray(history.releases)) throw new PublicationConflictError("Candidate release history is not v2", 500);
  for (const rawRelease of history.releases) {
    const release = objectRecord(rawRelease, "Release history entry");
    if (typeof release.releaseId !== "string" || typeof release.bundleId !== "string" || !Array.isArray(release.packages)) throw new PublicationConflictError("Release history entry is malformed", 500);
    for (const rawPackage of release.packages) {
      const entry = objectRecord(rawPackage, "Release history package");
      const id = typeof entry.id === "string" ? entry.id : "";
      const version = typeof entry.version === "string" ? entry.version : "";
      const record = packageManifestRecord(manifestRecords, id, version);
      if (!record || !packageKeys.has(`${id}@${version}`)) throw new PublicationConflictError(`Release history package ${id}@${version} has no package catalog/manifest entry`, 409);
      if (entry.sizeBytes !== undefined && entry.sizeBytes !== record.sizeBytes) throw new PublicationConflictError(`Release history package size mismatch: ${id}@${version}`, 409);
      if (entry.sha256 !== undefined && entry.sha256 !== record.sha256) throw new PublicationConflictError(`Release history package checksum mismatch: ${id}@${version}`, 409);
    }
  }

  let coverageDocuments = 0;
  for (const record of manifest.files) {
    if (record.kind !== "geometry" || !record.path.includes("/layers/") || !record.path.endsWith(".json")) continue;
    let document: Record<string, unknown>;
    try { document = objectRecord(JSON.parse(await readFile(path.join(extractRoot, record.path), "utf8")), `Coverage document ${record.path}`); }
    catch (error) {
      if (error instanceof PublicationConflictError) throw error;
      throw new PublicationConflictError(`Coverage document is missing or invalid: ${record.path}`, 409);
    }
    const order = document.order;
    const ordering = document.ordering;
    const pixels = document.pixels;
    if (!Number.isSafeInteger(order) || (order as number) < 0 || (order as number) > 29 || ordering !== "NESTED" || !Array.isArray(pixels) || pixels.some((pixel) => !Number.isSafeInteger(pixel) || (pixel as number) < 0)) {
      throw new PublicationConflictError(`Coverage document has invalid ICRS/NESTED projection metadata: ${record.path}`, 500);
    }
    coverageDocuments += 1;
  }
  return { packageReferences, coverageDocuments };
}

/** Rehydrate an uploaded archive into a clean directory and verify every manifest record. */
export async function verifyUploadedReleaseArchive(uploaded: UploadedReleaseArchive, store: ArtifactStore): Promise<ReleaseArchiveVerification> {
  const root = await mkdtemp(path.join(tmpdir(), "assets-release-verify-"));
  const archivePath = path.join(root, "release.tar.gz");
  const extractRoot = path.join(root, "extract");
  try {
    const downloaded = await store.downloadToFile(uploaded.archiveKey, archivePath);
    if (!downloaded) throw new PublicationConflictError(`Uploaded release archive is missing: ${uploaded.archiveKey}`, 409);
    if (downloaded.sizeBytes !== uploaded.archiveSizeBytes || downloaded.sha256 !== uploaded.archiveSha256) throw new PublicationConflictError("Uploaded release archive checksum mismatch", 409);
    const listing = (await execFile("tar", ["--list", "--gzip", "--file", archivePath])).stdout
      .split("\n").map((entry) => entry.trim()).filter(Boolean).map(safeArchivePath);
    if (new Set(listing).size !== listing.length) throw new PublicationConflictError("Candidate archive contains duplicate paths", 500);
    await mkdir(extractRoot, { recursive: true });
    await execFile("tar", ["--extract", "--gzip", "--file", archivePath, "--directory", extractRoot, "--no-same-owner", "--no-same-permissions"]);
    const manifestPath = path.join(extractRoot, MANIFEST_RELATIVE_PATH);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReleaseManifestDocument;
    if (manifest.schemaVersion !== 1 || !manifest.bundle?.id || !/^[a-f0-9]{64}$/.test(manifest.bundle.sha256) || !Array.isArray(manifest.files) || !manifest.files.length) throw new PublicationConflictError("Candidate release manifest is malformed", 500);
    if (publicReleaseBundleDigest(manifest.files) !== manifest.bundle.sha256 || manifest.bundle.sha256 !== uploaded.bundle.sha256) throw new PublicationConflictError("Candidate release bundle digest mismatch", 409);
    const expected = new Set<string>([MANIFEST_RELATIVE_PATH]);
    for (const record of manifest.files) {
      const relative = safeArchivePath(record.path);
      if (expected.has(relative)) throw new PublicationConflictError(`Candidate release contains duplicate manifest path: ${relative}`, 500);
      if (!record.id || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new PublicationConflictError(`Candidate release has an invalid asset record: ${record.id ?? "unknown"}`, 500);
      expected.add(relative);
      const absolute = path.resolve(extractRoot, ...relative.split("/"));
      const relativeToRoot = path.relative(extractRoot, absolute);
      if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) throw new PublicationConflictError(`Candidate release path escapes extraction root: ${relative}`, 500);
      let details;
      try { details = await lstat(absolute); } catch { throw new PublicationConflictError(`Candidate release asset is missing: ${relative}`, 409); }
      if (!details.isFile() || details.isSymbolicLink()) throw new PublicationConflictError(`Candidate release asset is not a regular file: ${relative}`, 500);
      if (details.size !== record.sizeBytes) throw new PublicationConflictError(`Candidate release asset size mismatch: ${record.id}`, 409);
      const bytes = await readFile(absolute);
      if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new PublicationConflictError(`Candidate release asset checksum mismatch: ${record.id}`, 409);
    }
    const actual = new Set((await regularFiles(extractRoot)).map(safeArchivePath));
    if (actual.size !== expected.size || [...expected].some((entry) => !actual.has(entry)) || [...actual].some((entry) => !expected.has(entry))) {
      throw new PublicationConflictError("Candidate archive does not exactly match its release manifest", 500);
    }
    const documents = await verifyReleaseDocuments(extractRoot, manifest);
    return { state: "passed", checkedAt: new Date().toISOString(), bundleSha256: manifest.bundle.sha256, files: manifest.files.length, ...documents };
  } catch (error) {
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationConflictError(`Candidate archive isolation verification failed: ${error instanceof Error ? error.message : String(error)}`, 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Deep module that plans, builds and publishes complete public release archives from dynamic content. */
export class PublicReleasePublisher {
  readonly #options: PublicReleasePublisherOptions;
  readonly #runsDir: string;
  readonly #queueDir: string;
  readonly #snapshotSink: StateSnapshotSink | undefined;
  readonly #leaseMs: number;
  #runsRestored = false;
  #runsRestorePromise: Promise<void> | undefined;
  #runWriteTail: Promise<void> = Promise.resolve();

  constructor(options: PublicReleasePublisherOptions) {
    this.#options = options;
    const publicationRoot = path.join(path.resolve(options.contentRoot), "publication");
    this.#runsDir = path.join(publicationRoot, "runs");
    this.#queueDir = path.join(publicationRoot, "queue");
    this.#snapshotSink = options.snapshotSink;
    const configuredLease = options.publicationLeaseMs ?? Number(process.env.ASSETS_PUBLICATION_LEASE_MS ?? "600000");
    this.#leaseMs = Number.isFinite(configuredLease) && configuredLease > 0 ? configuredLease : 600_000;
  }

  async plan(): Promise<PublicationPlan> {
    const baseline=await this.#baselineManifest();
    const products=this.#options.loadProducts ? await this.#options.loadProducts() : [];
    const publications=await this.#options.loadPublications();
    const previous=await readApprovedRelease(this.#options.baselineRoot);
    const surveys: PublicationSurveyPlan[]=[];
    for(const surveyId of [...new Set(products.map(p=>p.draft.surveyId))].sort()) {
      const diffs:PublicationProductDiff[]=[];
      for(const product of products.filter(p=>p.draft.surveyId===surveyId)) {
        const old=previous.products.find(p=>p.productId===product.productId);
        if(product.retiredAt){if(old)diffs.push({productId:product.productId,surveyId,releaseId:product.draft.releaseId,name:product.draft.name,change:"removed",fields:["withdrawal"],draftRevision:product.revision,publishedRevision:old.revision,reviewed:Boolean(product.retirementReason?.trim())});continue;}
        let geometry=null;let geometryInvalid=false;let blockingReason: string | undefined;
        try { geometry=await productGeometry(product,{root:this.#options.baselineRoot,files:baseline.files,publications,publicationFile:this.#options.publicationFile}); } catch (error) { geometryInvalid=true; blockingReason=error instanceof Error ? error.message : String(error); }
        if(old?.revision===product.revision && JSON.stringify(old.geometry)===JSON.stringify(geometry?.facts??null))continue;
        diffs.push({productId:product.productId,surveyId,releaseId:product.draft.releaseId,name:product.draft.name,change:old?"modified":"added",fields:["identity","coverage","presentation"],draftRevision:product.revision,publishedRevision:old?.revision??null,reviewed:!geometryInvalid&&currentReview(product,geometry?.facts??null),...(blockingReason?{blockingReason}:{})});
      }
      const blockers=isDeniedSurvey(surveyId)?["Survey is excluded from publication by policy"]:[];
      if(!diffs.some(d=>d.reviewed))blockers.push(...(diffs.some(d=>d.blockingReason)?diffs.filter(d=>d.blockingReason).map(d=>`${d.name}: ${d.blockingReason}`):["No reviewed product versions are ready; review a product first"]));
      surveys.push({surveyId,publishedLayers:previous.products.filter(p=>p.content.surveyId===surveyId&&p.geometry).length,changedProducts:diffs.length,productDiffs:diffs,currentPackage:undefined,inReleasePackage:previous.packages.some(p=>p.surveyId===surveyId),changed:diffs.length>0,blockers,selectable:diffs.some(d=>d.reviewed)&&!isDeniedSurvey(surveyId)});
    }
    return {planId:digest({baseline:baseline.bundle,surveys}).slice(0,16),baselineBundle:baseline.bundle,surveys,changedSurveyIds:surveys.filter(s=>s.changed).map(s=>s.surveyId),dynamicPackages:0,dynamicLayers:0,createdAt:new Date().toISOString()};
  }

  #submissionTail: Promise<unknown> = Promise.resolve();
  async submit(request: PublicationRunRequest, requestedBy?: string): Promise<PublicationRun> {
    const pending = this.#submissionTail.then(() => this.#submit(request, requestedBy));
    this.#submissionTail = pending.catch(() => undefined);
    return pending;
  }
  async #submit(request: PublicationRunRequest, requestedBy?: string): Promise<PublicationRun> {
    const plan = await this.plan();
    if (request.planId !== plan.planId) {
      throw new PublicationConflictError(`Publication plan ${request.planId} is stale; current plan is ${plan.planId}`);
    }
    if (request.expectedBaselineSha256 !== plan.baselineBundle.sha256) {
      throw new PublicationConflictError(`Baseline release changed; expected ${plan.baselineBundle.sha256}`);
    }
    const requested = [...new Set(request.surveyIds ?? [])];
    if (!request.productIds?.length) throw new PublicationConflictError("Select explicit reviewed product versions",400);
    if (!requested.length) throw new PublicationConflictError("Select at least one changed survey to publish", 400);
    const notChanged = requested.filter((surveyId) => !plan.changedSurveyIds.includes(surveyId));
    if (notChanged.length) throw new PublicationConflictError(`Surveys have no publication changes: ${notChanged.join(", ")}`);
    const blocked = plan.surveys.filter((survey) => requested.includes(survey.surveyId) && survey.blockers.length).map((survey) => `${survey.surveyId}: ${survey.blockers.join("; ")}`);
    if (blocked.length) throw new PublicationConflictError(`Blocked surveys cannot be published: ${blocked.join(" | ")}`);
    const eligible=plan.surveys.filter(s=>requested.includes(s.surveyId)).flatMap(s=>s.productDiffs).filter(p=>p.reviewed);
    const selected=eligible.filter(p=>!request.productIds || request.productIds.includes(p.productId));
    if(!selected.length || request.productIds?.some(id=>!eligible.some(p=>p.productId===id)))throw new PublicationConflictError("Select reviewed product versions only",400);

    const versions = selected.map(p => ({ productId: p.productId, revision: p.draftRevision }));
    const now = Date.now();
    const active = (await this.list()).filter(r => ["queued", "building", "uploading", "verifying"].includes(r.status));
    const duplicate = active.find(r => r.selectedProducts?.length === versions.length && versions.every(v => r.selectedProducts?.some(p => p.productId === v.productId && p.revision === v.revision)));
    if (duplicate) return duplicate;
    if (active.some(r => r.selectedProducts?.some(p => versions.some(v => p.productId === v.productId)))) throw new PublicationConflictError("Product already has an active publication task");
    const run: PublicationRun = {
      runId: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      selectedProducts:selected.map(p=>({productId:p.productId,revision:p.draftRevision})),
      planId: plan.planId,
      baselineBundle: plan.baselineBundle,
      surveyIds: requested,
      status: "queued",
      requestedBy: requestedBy ? "admin" : undefined,
      createdAt: new Date().toISOString(),
      startedAt: undefined,
      claimedAt: undefined,
      lastProgressAt: undefined,
      finishedAt: undefined,
      bundle: undefined,
      archiveKey: undefined,
      archiveSizeBytes: undefined,
      archiveSha256: undefined,
      files: undefined,
      packages: undefined,
      error: undefined,
      expected: {
        products: plan.verification?.products.filter((entry) => requested.includes(entry.surveyId ?? "")) ?? [],
        layers: plan.verification?.layers.filter((entry) => requested.includes(entry.surveyId ?? "")) ?? [],
        packages: plan.verification?.packages.filter((entry) => requested.includes(entry.surveyId ?? "")) ?? [],
      },
      log: [],
    };
    if (this.#options.runRepository) return this.#options.runRepository.submit(run);
    await mkdir(this.#runsDir, { recursive: true });
    await mkdir(this.#queueDir, { recursive: true });
    await this.#writeRun(run);
    await writeFile(path.join(this.#queueDir, `${run.runId}.json`), `${JSON.stringify({ runId: run.runId }, null, 2)}\n`, { flag: "wx" });
    return run;
  }

  /** Requeue a failed attempt against a freshly computed plan and baseline. */
  async retry(runId: string, requestedBy?: string): Promise<PublicationRun> {
    await this.#ensureRunsRestored();
    await this.#recoverStaleRuns();
    const previous = await this.get(runId);
    if (!previous) throw new PublicationConflictError(`Unknown publication run: ${runId}`, 404);
    if (previous.status !== "failed") throw new PublicationConflictError(`Publication run ${runId} is ${previous.status}, not failed`);
    const durableRetry = await this.#options.runRepository?.retry?.(previous);
    if (durableRetry) return durableRetry;
    const currentProducts = this.#options.loadProducts ? await this.#options.loadProducts() : [];
    if (previous.selectedProducts?.some(selected => !currentProducts.some(product => product.productId === selected.productId && product.revision === selected.revision))) {
      throw new PublicationConflictError("Selected revision changed; review and submit a new publication instead of retrying");
    }
    const plan = await this.plan();
    return this.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: previous.surveyIds, productIds: previous.selectedProducts?.map(p=>p.productId) }, requestedBy);
  }

  /** Release a stale worker lease and immediately create a fresh queued attempt. */
  async recover(runId: string, requestedBy?: string): Promise<PublicationRun> {
    await this.#ensureRunsRestored();
    await this.#recoverStaleRuns();
    const previous = await this.get(runId);
    if (!previous) throw new PublicationConflictError(`Unknown publication run: ${runId}`, 404);
    if (previous.status !== "failed" || !previous.recovery) {
      throw new PublicationConflictError(`Publication run ${runId} is still active or is not recoverable`);
    }
    return this.retry(runId, requestedBy);
  }

  async get(runId: string): Promise<PublicationRun | undefined> {
    if (this.#options.runRepository) return this.#options.runRepository.get(runId);
    await this.#ensureRunsRestored();
    try {
      return JSON.parse(await readFile(path.join(this.#runsDir, `${runId}.json`), "utf8")) as PublicationRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<PublicationRun[]> {
    if (this.#options.runRepository) return this.#options.runRepository.list();
    await this.#ensureRunsRestored();
    await this.#recoverStaleRuns();
    await mkdir(this.#runsDir, { recursive: true });
    const runs: PublicationRun[] = [];
    for (const entry of (await readdir(this.#runsDir)).filter((name) => name.endsWith(".json")).sort().reverse()) {
      runs.push(JSON.parse(await readFile(path.join(this.#runsDir, entry), "utf8")) as PublicationRun);
    }
    return runs;
  }

  async claimQueuedRun(): Promise<string | undefined> {
    await this.#ensureRunsRestored();
    await this.#recoverStaleRuns();
    await mkdir(this.#queueDir, { recursive: true });
    const entries = (await readdir(this.#queueDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".claimed.json")).sort();
    for (const entry of entries) {
      const queuedPath = path.join(this.#queueDir, entry);
      const claimedPath = queuedPath.replace(/\.json$/, ".claimed.json");
      try {
        await rename(queuedPath, claimedPath);
        const runId = (JSON.parse(await readFile(claimedPath, "utf8")) as { runId: string }).runId;
        const run = await this.get(runId);
        if (run?.status === "queued") {
          const now = new Date().toISOString();
          await this.#writeRun({ ...run, claimedAt: now, lastProgressAt: now, recovery: undefined });
          await writeJsonAtomic(claimedPath, { runId, claimedAt: now });
          return runId;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }

  async execute(runId: string): Promise<PublicationRun> {
    const existing = await this.get(runId);
    if (!existing) throw new PublicationConflictError(`Unknown publication run: ${runId}`, 404);
    let run: PublicationRun = existing;
    if (run.status !== "queued") throw new PublicationConflictError(`Publication run ${runId} is ${run.status}, not queued`);

    const stagingRoot = await mkdtemp(path.join(tmpdir(), "assets-release-publish-"));
    let archivePath: string | undefined;
    let failureStage: "build" | "upload" | "candidate" | "activate" = "build";
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const verificationTarget = this.#options.internalVerificationTarget?.trim() || process.env.ASSETS_PUBLIC_VERIFY_INTERNAL_URL?.trim() || this.#options.verificationTarget?.trim() || process.env.ASSETS_PUBLIC_VERIFY_URL?.trim() || undefined;
    const startedAt = new Date().toISOString();
    run = {
      ...run,
      status: "building",
      startedAt: run.startedAt ?? startedAt,
      claimedAt: run.claimedAt ?? startedAt,
      lastProgressAt: startedAt,
      recovery: undefined,
      verification: {
        overall: "pending",
        candidate: { state: "pending" },
        authority: { state: "pending" },
        site: { state: verificationTarget ? "pending" : "not-configured", ...(verificationTarget ? { target: verificationTarget } : {}) },
      },
    };
    await this.#writeRun(run);
    const heartbeatMs = Math.max(1_000, Math.min(15_000, Math.floor(this.#leaseMs / 3)));
    heartbeatTimer = setInterval(() => {
      const now = new Date().toISOString();
      run = { ...run, lastProgressAt: now };
      void this.#writeRun(run).catch(() => undefined);
    }, heartbeatMs);
    heartbeatTimer.unref?.();
    try {
      if(!run.selectedProducts?.length)throw new PublicationConflictError("Legacy publication task must be resubmitted under reviewed-release-v1");
      const candidate = await buildApprovedRelease({stagingRoot,runId,root:this.#options.baselineRoot,baseline:await this.#baselineManifest(),files:(await this.#baselineManifest()).files,products:this.#options.loadProducts?await this.#options.loadProducts():[],publications:await this.#options.loadPublications(),publicationFile:this.#options.publicationFile,selected:run.selectedProducts});
      const approved = await readApprovedRelease(candidate.root);
      const previous = await readApprovedRelease(this.#options.baselineRoot);
      run.expected = {
        products: [...approved.products.map(p=>({productId:p.productId,surveyId:p.content.surveyId,present:true})),...previous.products.filter(p=>!approved.products.some(n=>n.productId===p.productId)).map(p=>({productId:p.productId,surveyId:p.content.surveyId,present:false}))],
        layers: approved.products.flatMap(p=>p.geometry?[{layerId:p.geometry.layerId,surveyId:p.content.surveyId,present:true}]:[]),
        packages: approved.packages.map(p=>({id:String(p.id),version:String(p.version),surveyId:String(p.surveyId),present:true})),
      };
      run = this.#append(run, `candidate: ${candidate.files.length} files, ${candidate.packages.length} dynamic packages`);
      failureStage = "candidate";
      await verifyReleaseDocuments(candidate.root, JSON.parse(await readFile(path.join(candidate.root, MANIFEST_RELATIVE_PATH), "utf8")));
      failureStage = "build";
      run = { ...run, files: candidate.files.length, packages: candidate.packages.length };
      await this.#writeRun(run);

      run = { ...run, status: "uploading", lastProgressAt: new Date().toISOString() };
      await this.#writeRun(run);
      const store = this.#options.store ?? createArtifactStoreFromProcess();
      if (store.kind !== "s3" && !this.#options.allowFilesystemStore) {
        throw new PublicationConflictError("Release publication requires a configured S3 object store", 400);
      }
      failureStage = "upload";
      const uploaded = await uploadObjectRelease(candidate.root, this.#options.baselineRoot, store, run.baselineBundle.sha256);
      failureStage = "candidate";
      const restored = path.join(stagingRoot, "object-readback");
      await restoreObjectRelease(store, uploaded, restored, this.#options.baselineRoot);
      const checks = await verifyReleaseDocuments(restored, JSON.parse(await readFile(path.join(restored, MANIFEST_RELATIVE_PATH), "utf8")));
      const candidateVerification: ReleaseArchiveVerification = { state: "passed", checkedAt: new Date().toISOString(), bundleSha256: uploaded.bundle.sha256, files: candidate.files.length, ...checks };
      run = {
        ...run,
        status: "verifying",
        lastProgressAt: new Date().toISOString(),
        verification: {
          ...(run.verification ?? { overall: "pending", candidate: { state: "pending" }, authority: { state: "pending" }, site: { state: "not-configured" } }),
          candidate: candidateVerification,
          authority: { state: "pending" },
        },
      };
      await this.#writeRun(run);
      failureStage = "activate";
      const latestProducts=this.#options.loadProducts?await this.#options.loadProducts():[];
      const candidateApproval=await readApprovedRelease(candidate.root);
      for(const selected of run.selectedProducts ?? []) {
        const latest=latestProducts.find(p=>p.productId===selected.productId);
        const frozen=candidateApproval.products.find(p=>p.productId===selected.productId);
        if(!latest || latest.revision!==selected.revision || (frozen && !currentReview(latest,frozen.geometry)))throw new PublicationConflictError("Selected product changed during publication; review and resubmit");
      }
      const published = await (this.#options.activateCandidate ?? activateObjectRelease)(store, uploaded, run.baselineBundle.sha256);
      const siteState = verificationTarget
        ? { state: "pending" as const, target: verificationTarget }
        : { state: "not-configured" as const };
      run = {
        ...run,
        status: "published",
        lastProgressAt: new Date().toISOString(),
        claimedAt: undefined,
        finishedAt: new Date().toISOString(),
        bundle: published.bundle,
        manifestKey: published.manifestKey,
        verification: {
          ...(run.verification ?? { overall: "pending", candidate: { state: "pending" }, authority: { state: "pending" }, site: { state: "not-configured" } }),
          overall: verificationTarget ? "site-pending" : "authority-published",
          authority: { state: "passed", checkedAt: published.publishedAt!, bundleSha256: published.bundle.sha256 },
          site: siteState,
        },
      };
      run = this.#append(run, `published object manifest ${published.manifestKey}`);
      await this.#writeRun(run);
      if (verificationTarget && !this.#options.deferSiteVerification) run = await this.verifySite(run.runId);
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const verification = run.verification;
      run = {
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
        claimedAt: undefined,
        error: message,
        failureStage,
        ...(verification ? { verification: {
          ...verification,
          overall: "failed",
          ...(failureStage === "candidate" ? { candidate: { ...verification.candidate, state: "failed", checkedAt: new Date().toISOString(), error: message } } : {}),
          ...(failureStage === "activate" || failureStage === "upload" ? { authority: { ...verification.authority, state: "failed", checkedAt: new Date().toISOString(), error: message } } : {}),
        } } : {}),
      };
      await this.#writeRun(run).catch(() => undefined);
      return run;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!this.#options.runRepository) await this.#releaseQueueMarkers(runId);
      await rm(stagingRoot, { recursive: true, force: true });
      if (archivePath) await rm(path.dirname(archivePath), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Verify a configured target site without changing the release pointer. */
  async verifySite(runId: string, successor?: { bundle: { id: string; sha256: string }; expected: PublicationVerificationExpectation }): Promise<PublicationRun> {
    let run = await this.get(runId);
    if (!run) throw new PublicationConflictError(`Unknown publication run: ${runId}`, 404);
    const internalTarget = this.#options.internalVerificationTarget?.trim() || process.env.ASSETS_PUBLIC_VERIFY_INTERNAL_URL?.trim();
    const target = internalTarget || this.#options.verificationTarget?.trim() || process.env.ASSETS_PUBLIC_VERIFY_URL?.trim();
    if (!target) {
      run = { ...run, verification: { ...(run.verification ?? { overall: "authority-published", candidate: { state: "passed" }, authority: { state: "passed" }, site: { state: "not-configured" } }), overall: run.status === "failed" ? "failed" : "authority-published", site: { state: "not-configured" } } };
      await this.#writeRun(run);
      return run;
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
      if (parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid verification URL");
      if (!internalTarget && (parsed.protocol !== "https:" || parsed.hostname === "localhost" || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(parsed.hostname))) throw new Error("target must be a public HTTPS URL");
    } catch {
      run = { ...run, verification: { ...(run.verification ?? { overall: "authority-published", candidate: { state: "passed" }, authority: { state: "passed" }, site: { state: "pending" } }), overall: "failed", site: { state: "failed", target, checkedAt: new Date().toISOString(), error: "Configured verification target is not a public HTTPS URL" } } };
      await this.#writeRun(run);
      return run;
    }
    const site = { state: "pending" as const, target, checkedAt: new Date().toISOString() };
    run = { ...run, verification: { ...(run.verification ?? { overall: "authority-published", candidate: { state: "passed" }, authority: { state: "passed" }, site }), overall: "site-pending", site } };
    await this.#writeRun(run);
    try {
      const base = parsed.toString().replace(/\/$/, "");
      const fetchImpl = this.#options.fetchImpl ?? fetch;
      const request = async (suffix: string): Promise<Record<string, unknown>> => {
        const response = await fetchImpl(`${base}${suffix}`, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`${suffix} returned HTTP ${response.status}`);
        const body = await response.json() as unknown;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${suffix} returned an invalid JSON object`);
        return body as Record<string, unknown>;
      };
      const health = await request("/healthz");
      const bundle = health.bundle && typeof health.bundle === "object" && !Array.isArray(health.bundle) ? health.bundle as Record<string, unknown> : {};
      const observedBundleSha256 = typeof bundle.sha256 === "string" ? bundle.sha256 : undefined;
      if (!observedBundleSha256 || observedBundleSha256 !== (successor?.bundle ?? run.bundle)?.sha256) {
        run = { ...run, verification: { ...(run.verification ?? { overall: "site-pending", candidate: { state: "passed" }, authority: { state: "passed" }, site }), overall: "site-pending", site: { state: "pending", target, checkedAt: new Date().toISOString(), ...(observedBundleSha256 ? { observedBundleSha256 } : {}), error: `目标站点仍未使用候选 bundle（期望 ${(successor?.bundle ?? run.bundle)?.sha256 ?? "unknown"}）` } } };
        await this.#writeRun(run);
        return run;
      }
      const products = await request("/api/v1/products");
      const coverage = await request("/api/v1/coverage/catalog");
      const packages = await request("/api/v1/resource-packages/catalog.json");
      if (!Array.isArray(products.products)) throw new Error("/api/v1/products returned no products array");
      const productList = products.products;
      const layerList = Array.isArray(coverage.layers) ? coverage.layers : [];
      const packageList = Array.isArray(packages.packages) ? packages.packages : [];
      if (!Array.isArray(coverage.layers)) throw new Error("/api/v1/coverage/catalog returned no layers array");
      if (!Array.isArray(packages.packages)) throw new Error("/api/v1/resource-packages/catalog.json returned no packages array");
      const productIds = new Set(productList.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const id = (value as Record<string, unknown>).productId;
        return typeof id === "string" && id ? [id] : [];
      }));
      const layerIds = new Set(layerList.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const id = (value as Record<string, unknown>).layerId;
        return typeof id === "string" && id ? [id] : [];
      }));
      const packageKeys = new Set(packageList.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const entry = value as Record<string, unknown>;
        return typeof entry.id === "string" && typeof entry.version === "string" ? [`${entry.id}@${entry.version}`] : [];
      }));
      const productSurveys = new Map<string, Set<string | undefined>>();
      for (const value of productList) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.productId !== "string" || !entry.productId) continue;
        const surveys = productSurveys.get(entry.productId) ?? new Set<string | undefined>();
        surveys.add(typeof entry.surveyId === "string" ? entry.surveyId : undefined);
        productSurveys.set(entry.productId, surveys);
      }
      const layerSurveys = new Map<string, Set<string | undefined>>();
      for (const value of layerList) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.layerId !== "string" || !entry.layerId) continue;
        const surveys = layerSurveys.get(entry.layerId) ?? new Set<string | undefined>();
        surveys.add(typeof entry.surveyId === "string" ? entry.surveyId : undefined);
        layerSurveys.set(entry.layerId, surveys);
      }
      const packageSurveys = new Map<string, Set<string | undefined>>();
      for (const value of packageList) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.id !== "string" || typeof entry.version !== "string") continue;
        const key = `${entry.id}@${entry.version}`;
        const surveys = packageSurveys.get(key) ?? new Set<string | undefined>();
        surveys.add(typeof entry.surveyId === "string" ? entry.surveyId : undefined);
        packageSurveys.set(key, surveys);
      }
      const hasIdentity = (identities: Map<string, Set<string | undefined>>, key: string, surveyId: string): boolean => identities.get(key)?.has(surveyId) ?? false;
      const expectation = successor?.expected ?? run.expected;
      const missingProducts = expectation?.products.filter((entry) => entry.present && !hasIdentity(productSurveys, entry.productId, entry.surveyId)).map((entry) => entry.productId) ?? [];
      const missingLayers = expectation?.layers.filter((entry) => entry.present && !hasIdentity(layerSurveys, entry.layerId, entry.surveyId)).map((entry) => entry.layerId) ?? [];
      const missingPackages = expectation?.packages.filter((entry) => entry.present && !hasIdentity(packageSurveys, `${entry.id}@${entry.version}`, entry.surveyId)).map((entry) => `${entry.id}@${entry.version}`) ?? [];
      const unexpectedProducts = expectation?.products.filter((entry) => !entry.present && productIds.has(entry.productId)).map((entry) => entry.productId) ?? [];
      const unexpectedLayers = expectation?.layers.filter((entry) => !entry.present && layerIds.has(entry.layerId)).map((entry) => entry.layerId) ?? [];
      const unexpectedPackages = expectation?.packages.filter((entry) => !entry.present && packageKeys.has(`${entry.id}@${entry.version}`)).map((entry) => `${entry.id}@${entry.version}`) ?? [];
      const mismatches = [...missingProducts, ...missingLayers, ...missingPackages, ...unexpectedProducts, ...unexpectedLayers, ...unexpectedPackages];
      const affected = expectation?.products.filter((entry) => entry.present).length ?? run.surveyIds.filter((surveyId) => productList.some((value) => value && typeof value === "object" && !Array.isArray(value) && ((value as Record<string, unknown>).surveyId === surveyId || ((value as Record<string, unknown>).identity && typeof (value as Record<string, unknown>).identity === "object" && ((value as Record<string, unknown>).identity as Record<string, unknown>).surveyId === surveyId)))).length;
      if (mismatches.length) {
        const details = [
          missingProducts.length ? `missing products: ${missingProducts.join(", ")}` : "",
          missingLayers.length ? `missing layers: ${missingLayers.join(", ")}` : "",
          missingPackages.length ? `missing packages: ${missingPackages.join(", ")}` : "",
          unexpectedProducts.length ? `unexpected products: ${unexpectedProducts.join(", ")}` : "",
          unexpectedLayers.length ? `unexpected layers: ${unexpectedLayers.join(", ")}` : "",
          unexpectedPackages.length ? `unexpected packages: ${unexpectedPackages.join(", ")}` : "",
        ].filter(Boolean).join("; ");
        run = {
          ...run,
          verification: {
            ...(run.verification ?? { overall: "site-pending", candidate: { state: "passed" }, authority: { state: "passed" }, site }),
            overall: "failed",
            site: {
              state: "failed",
              target,
              checkedAt: new Date().toISOString(),
              observedBundleSha256,
              checkedProducts: affected,
              ...(missingProducts.length ? { missingProducts } : {}),
              ...(missingLayers.length ? { missingLayers } : {}),
              ...(missingPackages.length ? { missingPackages } : {}),
              ...(unexpectedProducts.length ? { unexpectedProducts } : {}),
              ...(unexpectedLayers.length ? { unexpectedLayers } : {}),
              ...(unexpectedPackages.length ? { unexpectedPackages } : {}),
              error: `目标站点内容与候选身份不一致：${details}`,
            },
          },
        };
        await this.#writeRun(run);
        return run;
      }
      run = { ...run, verification: { ...(run.verification ?? { overall: "site-pending", candidate: { state: "passed" }, authority: { state: "passed" }, site }), overall: "verified", site: { state: "passed", target, checkedAt: new Date().toISOString(), observedBundleSha256, checkedProducts: affected } } };
      await this.#writeRun(run);
      return run;
    } catch (error) {
      run = { ...run, verification: { ...(run.verification ?? { overall: "site-pending", candidate: { state: "passed" }, authority: { state: "passed" }, site }), overall: "failed", site: { state: "failed", target, checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) } } };
      await this.#writeRun(run);
      return run;
    }
  }

  async #allDynamicPackages(): Promise<Array<{ entry: PublicPackageEntry; asset: DynamicResourcePackageAsset }>> {
    const assets = await this.#options.loadPackages.assets();
    const result: Array<{ entry: PublicPackageEntry; asset: DynamicResourcePackageAsset }> = [];
    for (const entry of await this.#options.loadPackages.list()) {
      if (entry.hidden || entry.deprecated || isDeniedSurvey(entry.surveyId)) continue;
      const asset = assets.find((candidate) => candidate.id === dynamicResourcePackageAssetId(entry));
      if (asset) result.push({ entry, asset });
    }
    return result.sort((left, right) => left.entry.id.localeCompare(right.entry.id) || packageMinor(left.entry.version) - packageMinor(right.entry.version));
  }

  async #readBaselineHistory(): Promise<ReleaseHistoryDocument> {
    let parsed: ReleaseHistoryDocument | undefined;
    try {
      const source = await readFile(path.resolve(this.#options.baselineRoot, RELEASE_HISTORY_RELATIVE_PATH), "utf8");
      parsed = JSON.parse(source) as ReleaseHistoryDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 2, latestReleaseId: "", releases: [] };
      }
      throw error;
    }
    if (!parsed || !Array.isArray(parsed.releases)) {
      throw new PublicationConflictError("Baseline release history is malformed", 500);
    }
    if (parsed.schemaVersion === 2) {
      return {
        schemaVersion: 2,
        latestReleaseId: parsed.latestReleaseId ?? parsed.releases.at(-1)?.releaseId ?? "",
        releases: parsed.releases,
      };
    }
    return {
      schemaVersion: 2,
      latestReleaseId: parsed.releases.at(-1)?.releaseId ?? "",
      releases: parsed.releases,
    };
  }

  #layerRecordIds(publication: MocPublication): string[] {
    return this.#layerRecords(publication).map(({ record }) => record.id);
  }

  #layerRecords(publication: MocPublication): Array<{ record: PublicAssetRecord; file: MocPublicationFile }> {
    const definitions: Array<{ suffix: "moc" | "query" | "preview" | "statistics"; kind: PublicAssetRecord["kind"]; label: string; description: string }> = [
      { suffix: "moc", kind: "moc", label: `${publication.product} coverage MOC`, description: `Published MOC for ${publication.product}.` },
      { suffix: "query", kind: "geometry", label: `${publication.product} query MOC`, description: `Order-8 query MOC for ${publication.product}.` },
      { suffix: "preview", kind: "geometry", label: `${publication.product} preview MOC`, description: `Order-4 preview MOC for ${publication.product}.` },
      { suffix: "statistics", kind: "metadata", label: `${publication.product} coverage statistics`, description: `Coverage statistics for ${publication.product}.` },
    ];
    const records: Array<{ record: PublicAssetRecord; file: MocPublicationFile }> = [];
    for (const definition of definitions) {
      const file = publication.files[definition.suffix];
      if (!file) continue;
      const fileName = path.posix.basename(file.path.replaceAll(path.sep, "/"));
      records.push({
        file,
        record: {
          id: `layer-${publication.layerId}-${definition.suffix}`,
          kind: definition.kind,
          label: definition.label,
          description: definition.description,
          path: `artifacts/public-survey-footprints/layers/${publication.layerId}/${fileName}`,
          downloadName: fileName,
          mediaType: file.mediaType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          surveyId: publication.surveyId,
          releaseId: publication.releaseId,
          sourceUrl: publication.sourceUrl,
          deliveryClass: "runtime",
        },
      });
    }
    return records;
  }

  async #mergedPackageCatalog(
    allDynamic: Array<{ entry: PublicPackageEntry; asset: DynamicResourcePackageAsset }>,
  ): Promise<{ schemaVersion: number; version: string; generatedAt?: string; packages: Array<Record<string, unknown> & { id: string; surveyId?: string; version: string; name: string }> }> {
    const source = await readFile(path.resolve(this.#options.baselineRoot, PACKAGE_CATALOG_RELATIVE_PATH), "utf8");
    const sanitized = isSanitizableControlDocument(PACKAGE_CATALOG_RELATIVE_PATH) ? sanitizeReleaseControlDocument(PACKAGE_CATALOG_RELATIVE_PATH, Buffer.from(source, "utf8")) : null;
    const document = JSON.parse(sanitized ? sanitized.toString("utf8") : source) as {
      schemaVersion: number;
      version: string;
      generatedAt?: string;
      packages: Array<Record<string, unknown> & { id: string; surveyId?: string; version: string; name: string }>;
    };
    const packages = document.packages.filter((entry) => !(entry.surveyId && isDeniedSurvey(entry.surveyId)));
    packages.push(...(await historicalPackages(this.#options.baselineRoot)).map(({ entry }) => entry));
    const known = new Set(packages.map((entry) => `${entry.id}@${entry.version}`));
    for (const { entry } of allDynamic) {
      if (isDeniedSurvey(entry.surveyId)) continue;
      const key = `${entry.id}@${entry.version}`;
      if (known.has(key)) continue;
      known.add(key);
      packages.push({
        ...entry,
        archiveUrl: `/api/v1/resource-packages/${entry.id}/versions/${entry.version}/download`,
      });
    }
    for (const entry of packages) {
      const latest = packages.filter((candidate) => candidate.id === entry.id && candidate.deprecated !== true)
        .sort((a, b) => packageMinor(b.version) - packageMinor(a.version))[0];
      if (!latest) continue;
      const releases = (value: Record<string, unknown>): string[] => Array.isArray(value.releases) ? value.releases.filter((id): id is string => typeof id === "string") : [];
      assertReleaseContinuity(releases(entry), releases(latest));
      if (entry.version !== latest.version) { entry.deprecated = true; entry.replacedBy = [latest.id]; }
    }
    packages.sort((left, right) => left.id.localeCompare(right.id) || packageMinor(left.version) - packageMinor(right.version));
    return { schemaVersion: document.schemaVersion, version: document.version, generatedAt: document.generatedAt, packages };
  }

  async #baselineManifest(): Promise<ReleaseManifestDocument> {
    const document = JSON.parse(await readFile(path.resolve(this.#options.baselineRoot, MANIFEST_RELATIVE_PATH), "utf8")) as ReleaseManifestDocument;
    if (document.schemaVersion !== 1 || !Array.isArray(document.files) || !document.files.length) throw new PublicationConflictError("Baseline release manifest is unusable", 500);
    if (publicReleaseBundleDigest(document.files) !== document.bundle.sha256) throw new PublicationConflictError("Baseline release manifest digest mismatch", 500);
    return document;
  }

  #inside(root: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new PublicationConflictError(`Unsafe candidate path: ${relativePath}`, 500);
    const normalized = path.posix.normalize(relativePath.replaceAll(path.sep, "/"));
    if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) throw new PublicationConflictError(`Unsafe candidate path: ${relativePath}`, 500);
    return path.resolve(root, ...normalized.split("/"));
  }

  async #recoverStaleRuns(): Promise<PublicationRun[]> {
    if (this.#options.runRepository) return [];
    const now = Date.now();
    const runs = await this.#readRunsOnDisk();
    const claimedIds = new Set<string>();
    for (const entry of await readdir(this.#queueDir).catch(() => [])) {
      if (!entry.endsWith(".claimed.json")) continue;
      try {
        const value = JSON.parse(await readFile(path.join(this.#queueDir, entry), "utf8")) as { runId?: unknown };
        if (typeof value.runId === "string") claimedIds.add(value.runId);
      } catch { /* malformed claim is handled by queue restoration */ }
    }
    const stale: PublicationRun[] = [];
    for (const run of runs) {
      const active = ["building", "uploading", "verifying"].includes(run.status);
      const claimedQueued = run.status === "queued" && claimedIds.has(run.runId);
      if (!active && !claimedQueued) continue;
      const timestamp = Date.parse(run.lastProgressAt ?? run.claimedAt ?? run.startedAt ?? run.createdAt);
      if (!Number.isFinite(timestamp) || now - timestamp <= this.#leaseMs) continue;
      const stage: PublicationFailureStage = run.status === "uploading" ? "upload" : run.status === "verifying" ? "candidate" : "build";
      const reason = `发布 worker 在${stage === "upload" ? "上传" : stage === "candidate" ? "验证" : "构建"}阶段中断，任务已释放，可重试`;
      const detectedAt = new Date(now).toISOString();
      const failed: PublicationRun = {
        ...run,
        status: "failed",
        finishedAt: detectedAt,
        lastProgressAt: detectedAt,
        claimedAt: undefined,
        error: reason,
        failureStage: stage,
        recovery: { detectedAt, reason },
        verification: run.verification ? {
          ...run.verification,
          overall: "failed",
          ...(stage === "candidate" ? { candidate: { ...run.verification.candidate, state: "failed", checkedAt: detectedAt, error: reason } } : {}),
          ...(stage === "upload" ? { authority: { ...run.verification.authority, state: "failed", checkedAt: detectedAt, error: reason } } : {}),
        } : run.verification,
        log: [...run.log.slice(-39), `${detectedAt} ${reason}`],
      };
      await this.#writeRun(failed);
      await this.#releaseQueueMarkers(run.runId);
      stale.push(failed);
    }
    return stale;
  }

  async #releaseQueueMarkers(runId: string): Promise<void> {
    await Promise.all([
      rm(path.join(this.#queueDir, `${runId}.json`), { force: true }),
      rm(path.join(this.#queueDir, `${runId}.claimed.json`), { force: true }),
    ]);
  }

  #append(run: PublicationRun, message: string): PublicationRun {
    const now = new Date().toISOString();
    return { ...run, lastProgressAt: now, log: [...run.log.slice(-40), `${now} ${message}`] };
  }

  async #writeRun(run: PublicationRun): Promise<void> {
    if (this.#options.runRepository) return this.#options.runRepository.write(run);
    const operation = this.#runWriteTail.then(async () => {
      await mkdir(this.#runsDir, { recursive: true });
      await writeJsonAtomic(path.join(this.#runsDir, `${run.runId}.json`), run);
      await queueStateSnapshot(this.#snapshotSink, "publication-runs", { schemaVersion: 1, runs: await this.#readRunsOnDisk() });
    });
    this.#runWriteTail = operation.catch(() => undefined);
    await operation;
  }

  async #ensureRunsRestored(): Promise<void> {
    if (this.#options.runRepository) return;
    if (this.#runsRestored) return;
    if (!this.#runsRestorePromise) {
      this.#runsRestorePromise = this.#restoreRuns().then(() => {
        this.#runsRestored = true;
      }).finally(() => {
        this.#runsRestorePromise = undefined;
      });
    }
    await this.#runsRestorePromise;
  }

  async #restoreRuns(): Promise<void> {
    await mkdir(this.#runsDir, { recursive: true });
    await mkdir(this.#queueDir, { recursive: true });
    const localRuns: PublicationRun[] = [];
    let needsRestore = false;
    for (const entry of await readdir(this.#runsDir)) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.#runsDir, entry);
      try {
        const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
        if (!isPublicationRun(value)) throw new Error("invalid publication run");
        localRuns.push(value);
      } catch {
        needsRestore = true;
        await rm(filePath, { force: true });
      }
    }
    if (needsRestore || localRuns.length === 0) {
      const restored = await this.#snapshotSink?.restore?.("publication-runs");
      const state = restored?.state && typeof restored.state === "object" ? restored.state as { runs?: unknown; run?: unknown } : undefined;
      const candidates = Array.isArray(state?.runs) ? state.runs : state?.run ? [state.run] : [];
      const known = new Map(localRuns.map((run) => [run.runId, run]));
      for (const candidate of candidates) if (isPublicationRun(candidate)) known.set(candidate.runId, candidate);
      for (const run of known.values()) await writeJsonAtomic(path.join(this.#runsDir, `${run.runId}.json`), run);
      localRuns.splice(0, localRuns.length, ...known.values());
    }
    for (const run of localRuns) {
      if (run.status !== "queued") continue;
      const queuedPath = path.join(this.#queueDir, `${run.runId}.json`);
      const claimedPath = path.join(this.#queueDir, `${run.runId}.claimed.json`);
      if (!(await stat(queuedPath).catch(() => undefined)) && !(await stat(claimedPath).catch(() => undefined))) {
        await writeJsonAtomic(queuedPath, { runId: run.runId });
      }
    }
    // A claimed marker left by a crashed worker is recoverable only during
    // publisher initialization; subsequent claims on this instance must not
    // steal the run currently being executed.
    await this.#recoverClaimedQueue();
  }

  async #recoverClaimedQueue(): Promise<void> {
    // Initialization must not call get(), which awaits this same restoration.
    const runs = await this.#readRunsOnDisk();
    for (const entry of await readdir(this.#queueDir)) {
      if (!entry.endsWith(".claimed.json")) continue;
      const claimedPath = path.join(this.#queueDir, entry);
      let runId: string | undefined;
      try {
        const value = JSON.parse(await readFile(claimedPath, "utf8")) as { runId?: unknown };
        if (typeof value.runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)) runId = value.runId;
      } catch { /* corrupt claim is discarded below */ }
      if (!runId) {
        await rm(claimedPath, { force: true });
        continue;
      }
      const run = runs.find((candidate) => candidate.runId === runId);
      if (run?.status === "queued") {
        const queuedPath = path.join(this.#queueDir, `${runId}.json`);
        await rename(claimedPath, queuedPath).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
          await rm(claimedPath, { force: true });
        });
        await writeJsonAtomic(path.join(this.#runsDir, `${runId}.json`), { ...run, claimedAt: undefined, lastProgressAt: undefined, recovery: undefined });
      } else {
        await rm(claimedPath, { force: true });
      }
    }
  }

  async #readRunsOnDisk(): Promise<PublicationRun[]> {
    const runs: PublicationRun[] = [];
    for (const entry of (await readdir(this.#runsDir).catch(() => [])).filter((name) => name.endsWith(".json"))) {
      try {
        const value = JSON.parse(await readFile(path.join(this.#runsDir, entry), "utf8")) as unknown;
        if (isPublicationRun(value)) runs.push(value);
      } catch { /* a later restore will quarantine malformed local state */ }
    }
    return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));
  }
}
