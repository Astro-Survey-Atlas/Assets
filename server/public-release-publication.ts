import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createArtifactStoreFromProcess, publishReleaseArchive, type ArtifactStore } from "./artifact-store.js";
import { publicReleaseBundleDigest } from "./catalog.js";
import type { MocPublication, MocPublicationFile } from "./moc-build.js";
import { dynamicResourcePackageAssetId, type DynamicResourcePackageAsset, type DynamicResourcePackageEntry } from "./resource-package-publication.js";
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
  currentPackage: { id: string; version: string; sha256: string; sizeBytes: number } | undefined;
  inReleasePackage: boolean;
  changed: boolean;
  blockers: string[];
  selectable: boolean;
}

export interface PublicationPlan {
  planId: string;
  baselineBundle: { id: string; sha256: string };
  surveys: PublicationSurveyPlan[];
  changedSurveyIds: string[];
  dynamicPackages: number;
  dynamicLayers: number;
  createdAt: string;
}

export interface PublicationRunRequest {
  planId: string;
  expectedBaselineSha256: string;
  surveyIds: string[];
}

export type PublicationRunStatus = "queued" | "building" | "uploading" | "published" | "failed";

export interface PublicationRun {
  runId: string;
  planId: string;
  baselineBundle: { id: string; sha256: string };
  surveyIds: string[];
  status: PublicationRunStatus;
  requestedBy: string | undefined;
  createdAt: string;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  bundle: { id: string; sha256: string } | undefined;
  archiveKey: string | undefined;
  archiveSizeBytes: number | undefined;
  archiveSha256: string | undefined;
  files: number | undefined;
  packages: number | undefined;
  error: string | undefined;
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

export interface PublicReleasePublisherOptions {
  contentRoot: string;
  baselineRoot: string;
  loadPublications: () => Promise<MocPublication[]> | MocPublication[];
  publicationFile: (file: MocPublicationFile) => string;
  loadPackages: PackageProvider;
  loadProducts?: () => Promise<ProductRecord[]> | ProductRecord[];
  store?: ArtifactStore;
  allowFilesystemStore?: boolean;
  snapshotSink?: StateSnapshotSink;
}

interface LatestPackage {
  entry: PublicPackageEntry;
  asset: DynamicResourcePackageAsset;
}

async function latestPackages(packages: PackageProvider): Promise<Map<string, LatestPackage>> {
  const latest = new Map<string, LatestPackage>();
  const assets = await packages.assets();
  for (const entry of await packages.list()) {
    if (entry.hidden) continue;
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
    && ["queued", "building", "uploading", "published", "failed"].includes(run.status)
    && Array.isArray(run.surveyIds)
    && Array.isArray(run.log);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

/** Deep module that plans, builds and publishes complete public release archives from dynamic content. */
export class PublicReleasePublisher {
  readonly #options: PublicReleasePublisherOptions;
  readonly #runsDir: string;
  readonly #queueDir: string;
  readonly #snapshotSink: StateSnapshotSink | undefined;
  #runsRestored = false;
  #runsRestorePromise: Promise<void> | undefined;

  constructor(options: PublicReleasePublisherOptions) {
    this.#options = options;
    const publicationRoot = path.join(path.resolve(options.contentRoot), "publication");
    this.#runsDir = path.join(publicationRoot, "runs");
    this.#queueDir = path.join(publicationRoot, "queue");
    this.#snapshotSink = options.snapshotSink;
  }

  async plan(): Promise<PublicationPlan> {
    const baseline = await this.#baselineManifest();
    const publications = await this.#options.loadPublications();
    const latestByLayer = new Map<string, MocPublication>();
    for (const publication of publications) {
      const existing = latestByLayer.get(publication.layerId);
      if (!existing || existing.publishedAt < publication.publishedAt) latestByLayer.set(publication.layerId, publication);
    }
    const packages = await latestPackages(this.#options.loadPackages);
    const packageBySurvey = new Map<string, LatestPackage>();
    for (const entry of packages.values()) if (!packageBySurvey.has(entry.entry.surveyId)) packageBySurvey.set(entry.entry.surveyId, entry);
    const products = this.#options.loadProducts ? await this.#options.loadProducts() : [];
    const changedProductsBySurvey = new Map<string, number>();
    for (const product of products) {
      if (product.publishedRevision !== null && product.revision > product.publishedRevision) {
        const surveyId = (product as unknown as { surveyId?: string }).surveyId ?? "";
        changedProductsBySurvey.set(surveyId, (changedProductsBySurvey.get(surveyId) ?? 0) + 1);
      }
    }
    const baselinePackageShas = new Set(baseline.files.filter((record) => record.kind === "package").map((record) => record.sha256));
    const baselineRecordIds = new Set(baseline.files.map((record) => record.id));

    const surveyIds = [...new Set([...[...latestByLayer.values()].map((p) => p.surveyId), ...packageBySurvey.keys(), ...changedProductsBySurvey.keys()])].sort();
    const surveys: PublicationSurveyPlan[] = [];
    const fingerprintInputs: unknown[] = [{ baseline: baseline.bundle.sha256 }];
    for (const surveyId of surveyIds) {
      const layers = [...latestByLayer.values()].filter((publication) => publication.surveyId === surveyId);
      const blockers: string[] = [];
      if (isDeniedSurvey(surveyId)) blockers.push("Survey is excluded from publication by policy");
      for (const layer of layers) {
        for (const file of Object.values(layer.files)) {
          if (!file) continue;
          try {
            if (!(await stat(this.#options.publicationFile(file))).isFile()) blockers.push(`Missing published file for ${layer.layerId}`);
          } catch {
            blockers.push(`Missing published file for ${layer.layerId}`);
          }
        }
      }
      const current = packageBySurvey.get(surveyId);
      const dynamicLayerIds = layers.flatMap((layer) => this.#layerRecordIds(layer)).filter((id) => !baselineRecordIds.has(id));
      const changed = Boolean(
        (current && !baselinePackageShas.has(current.asset.sha256)) ||
        dynamicLayerIds.length > 0 ||
        (changedProductsBySurvey.get(surveyId) ?? 0) > 0,
      );
      surveys.push({
        surveyId,
        publishedLayers: layers.length,
        changedProducts: changedProductsBySurvey.get(surveyId) ?? 0,
        currentPackage: current ? { id: current.entry.id, version: current.entry.version, sha256: current.asset.sha256, sizeBytes: current.asset.sizeBytes } : undefined,
        inReleasePackage: Boolean(current && baselinePackageShas.has(current.asset.sha256)),
        changed,
        blockers,
        selectable: changed && blockers.length === 0,
      });
      fingerprintInputs.push({
        surveyId,
        layers: layers.map((layer) => [layer.layerId, layer.publishedAt, layer.files.moc.sha256]),
        package: current ? [current.entry.id, current.entry.version, current.asset.sha256] : undefined,
        changedProducts: changedProductsBySurvey.get(surveyId) ?? 0,
      });
    }
    return {
      planId: digest(fingerprintInputs).slice(0, 16),
      baselineBundle: baseline.bundle,
      surveys,
      changedSurveyIds: surveys.filter((survey) => survey.changed).map((survey) => survey.surveyId),
      dynamicPackages: packages.size,
      dynamicLayers: latestByLayer.size,
      createdAt: new Date().toISOString(),
    };
  }

  async submit(request: PublicationRunRequest, requestedBy?: string): Promise<PublicationRun> {
    const plan = await this.plan();
    if (request.planId !== plan.planId) {
      throw new PublicationConflictError(`Publication plan ${request.planId} is stale; current plan is ${plan.planId}`);
    }
    if (request.expectedBaselineSha256 !== plan.baselineBundle.sha256) {
      throw new PublicationConflictError(`Baseline release changed; expected ${plan.baselineBundle.sha256}`);
    }
    const requested = [...new Set(request.surveyIds ?? [])];
    if (!requested.length) throw new PublicationConflictError("Select at least one changed survey to publish", 400);
    const notChanged = requested.filter((surveyId) => !plan.changedSurveyIds.includes(surveyId));
    if (notChanged.length) throw new PublicationConflictError(`Surveys have no publication changes: ${notChanged.join(", ")}`);
    const blocked = plan.surveys.filter((survey) => requested.includes(survey.surveyId) && survey.blockers.length).map((survey) => `${survey.surveyId}: ${survey.blockers.join("; ")}`);
    if (blocked.length) throw new PublicationConflictError(`Blocked surveys cannot be published: ${blocked.join(" | ")}`);

    const run: PublicationRun = {
      runId: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      planId: plan.planId,
      baselineBundle: plan.baselineBundle,
      surveyIds: requested,
      status: "queued",
      requestedBy,
      createdAt: new Date().toISOString(),
      startedAt: undefined,
      finishedAt: undefined,
      bundle: undefined,
      archiveKey: undefined,
      archiveSizeBytes: undefined,
      archiveSha256: undefined,
      files: undefined,
      packages: undefined,
      error: undefined,
      log: [],
    };
    await mkdir(this.#runsDir, { recursive: true });
    await mkdir(this.#queueDir, { recursive: true });
    await this.#writeRun(run);
    await writeFile(path.join(this.#queueDir, `${run.runId}.json`), `${JSON.stringify({ runId: run.runId }, null, 2)}\n`, { flag: "wx" });
    return run;
  }

  async get(runId: string): Promise<PublicationRun | undefined> {
    await this.#ensureRunsRestored();
    try {
      return JSON.parse(await readFile(path.join(this.#runsDir, `${runId}.json`), "utf8")) as PublicationRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<PublicationRun[]> {
    await this.#ensureRunsRestored();
    await mkdir(this.#runsDir, { recursive: true });
    const runs: PublicationRun[] = [];
    for (const entry of (await readdir(this.#runsDir)).filter((name) => name.endsWith(".json")).sort().reverse()) {
      runs.push(JSON.parse(await readFile(path.join(this.#runsDir, entry), "utf8")) as PublicationRun);
    }
    return runs;
  }

  async claimQueuedRun(): Promise<string | undefined> {
    await this.#ensureRunsRestored();
    await mkdir(this.#queueDir, { recursive: true });
    const entries = (await readdir(this.#queueDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".claimed.json")).sort();
    for (const entry of entries) {
      const queuedPath = path.join(this.#queueDir, entry);
      const claimedPath = queuedPath.replace(/\.json$/, ".claimed.json");
      try {
        await rename(queuedPath, claimedPath);
        const runId = (JSON.parse(await readFile(claimedPath, "utf8")) as { runId: string }).runId;
        const run = await this.get(runId);
        if (run?.status === "queued") return runId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return undefined;
  }

  async execute(runId: string): Promise<PublicationRun> {
    let run = await this.get(runId);
    if (!run) throw new PublicationConflictError(`Unknown publication run: ${runId}`, 404);
    if (run.status !== "queued") throw new PublicationConflictError(`Publication run ${runId} is ${run.status}, not queued`);

    const stagingRoot = await mkdtemp(path.join(tmpdir(), "assets-release-publish-"));
    let archivePath: string | undefined;
    run = { ...run, status: "building", startedAt: new Date().toISOString() };
    await this.#writeRun(run);
    try {
      const candidate = await this.#buildCandidateTree(stagingRoot, runId);
      run = this.#append(run, `candidate: ${candidate.files.length} files, ${candidate.packages.length} dynamic packages`);
      const { packageRelease } = await import("../scripts/release-archive.js");
      archivePath = path.join(await mkdtemp(path.join(tmpdir(), "assets-release-archive-")), "release.tar.gz");
      const descriptor = await packageRelease({ root: candidate.root, outputPath: archivePath });
      run = { ...run, files: candidate.files.length, packages: candidate.packages.length };
      await this.#writeRun(run);

      run = { ...run, status: "uploading" };
      await this.#writeRun(run);
      const store = this.#options.store ?? createArtifactStoreFromProcess();
      if (store.kind !== "s3" && !this.#options.allowFilesystemStore) {
        throw new PublicationConflictError("Release publication requires a configured S3 object store", 400);
      }
      const published = await publishReleaseArchive(descriptor, store, { currentKey: process.env.ASSETS_OBJECT_STORE_CURRENT_KEY });
      run = {
        ...run,
        status: "published",
        finishedAt: new Date().toISOString(),
        bundle: published.bundle,
        archiveKey: published.archiveKey,
        archiveSizeBytes: published.archiveSizeBytes,
        archiveSha256: published.archiveSha256,
      };
      run = this.#append(run, `published ${published.archiveKey}`);
      await this.#writeRun(run);
      return run;
    } catch (error) {
      run = {
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await this.#writeRun(run).catch(() => undefined);
      return run;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
      if (archivePath) await rm(path.dirname(archivePath), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #buildCandidateTree(stagingRoot: string, runId: string): Promise<CandidateBuild> {
    const baseline = await this.#baselineManifest();
    for (const record of baseline.files) {
      if (inferredPublicAssetDeliveryClass({ path: record.path, kind: record.kind }) === "evidence") {
        throw new PublicationConflictError(`Baseline release contains an evidence record: ${record.id}`, 500);
      }
      try {
        assertRecordPublishable(record);
      } catch (error) {
        throw new PublicationConflictError(error instanceof Error ? error.message : String(error), 500);
      }
    }
    const allDynamic = await this.#allDynamicPackages();
    const baselinePath = (relativePath: string): string => path.resolve(this.#options.baselineRoot, relativePath);

    const existingPaths = new Set<string>();
    const files: PublicAssetRecord[] = [];
    for (const record of baseline.files) {
      if (record.path === PACKAGE_CATALOG_RELATIVE_PATH || record.path === RELEASE_HISTORY_RELATIVE_PATH) continue;
      const source = baselinePath(record.path);
      let bytes = await readFile(source);
      if (bytes.length !== record.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
        const sanitized = isSanitizableControlDocument(record.path) ? sanitizeReleaseControlDocument(record.path, bytes) : null;
        if (
          !sanitized ||
          sanitized.length !== record.sizeBytes ||
          createHash("sha256").update(sanitized).digest("hex") !== record.sha256
        ) {
          throw new PublicationConflictError(`Baseline file hash mismatch: ${record.path}`, 500);
        }
        bytes = Buffer.from(sanitized);
      }
      const destination = this.#inside(stagingRoot, record.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      files.push({ ...record });
      existingPaths.add(record.path);
    }

    const dynamicPackageEntries: PublicPackageEntry[] = [];
    for (const { entry, asset } of allDynamic) {
      const releasePath = `artifacts/public-survey-footprints/packages/${asset.downloadName}`;
      if (existingPaths.has(releasePath)) continue;
      const record: PublicAssetRecord = {
        id: asset.id,
        kind: "package",
        label: entry.name,
        description: entry.description,
        path: releasePath,
        downloadName: asset.downloadName,
        mediaType: "application/zip",
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256,
        surveyId: entry.surveyId,
        releaseId: entry.releases[0],
        version: entry.version,
        deliveryClass: "runtime",
      };
      const source = path.join(path.resolve(this.#options.contentRoot), asset.path);
      const details = await stat(source);
      if (details.size !== record.sizeBytes) throw new PublicationConflictError(`Dynamic package size mismatch: ${entry.id}@${entry.version}`, 500);
      const destination = this.#inside(stagingRoot, releasePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      files.push(record);
      existingPaths.add(releasePath);
      dynamicPackageEntries.push(entry);
    }

    const baselineRecordIds = new Set(baseline.files.map((record) => record.id));
    const publications = await this.#options.loadPublications();
    const latestByLayer = new Map<string, MocPublication>();
    for (const publication of publications) {
      const existing = latestByLayer.get(publication.layerId);
      if (!existing || existing.publishedAt < publication.publishedAt) latestByLayer.set(publication.layerId, publication);
    }
    for (const layerId of [...latestByLayer.keys()].sort()) {
      const publication = latestByLayer.get(layerId)!;
      if (isDeniedSurvey(publication.surveyId) || isDeniedLayerId(publication.layerId)) continue;
      const layerRecords = this.#layerRecords(publication);
      if (layerRecords.every(({ record }) => baselineRecordIds.has(record.id))) continue;
      for (const { record, file } of layerRecords) {
        const source = this.#options.publicationFile(file);
        const destination = this.#inside(stagingRoot, record.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
        files.push(record);
      }
    }

    const mergedCatalog = await this.#mergedPackageCatalog(allDynamic);
    const catalogBytes = Buffer.from(`${JSON.stringify(mergedCatalog, null, 2)}\n`, "utf8");
    const catalogRecord = baseline.files.find((record) => record.path === PACKAGE_CATALOG_RELATIVE_PATH);
    files.push({
      ...(catalogRecord ?? {
        id: "packages-catalog",
        kind: "manifest" as const,
        label: "Resource package catalog",
        description: "Catalog of published resource packages.",
        downloadName: "catalog.json",
        mediaType: "application/json",
      }),
      path: PACKAGE_CATALOG_RELATIVE_PATH,
      sizeBytes: catalogBytes.byteLength,
      sha256: createHash("sha256").update(catalogBytes).digest("hex"),
      deliveryClass: "runtime" as const,
    });

    const generatedAt = new Date().toISOString();
    const bundleId = `public-survey-footprints-${generatedAt.slice(0, 10)}`;
    const baselineHistory = await this.#readBaselineHistory();
    const sequence = baselineHistory.releases.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
    const releaseId = `${bundleId}-${sequence}`;

    const surveyLookups = await loadSurveyLookups(path.resolve(this.#options.baselineRoot, "src", "surveys", "survey-catalog.json"));
    const catalogByDownloadName = new Map<string, Record<string, unknown> & { id: string; surveyId?: string; version: string; name: string }>();
    for (const entry of mergedCatalog.packages) {
      catalogByDownloadName.set(`${entry.id}-${entry.version}.zip`, entry);
    }
    const collectionInputs: Array<{ downloadName: string; zipBytes: Buffer; projection: Awaited<ReturnType<typeof projectResourcePackage>> }> = [];
    const historyPackages: ReleaseHistoryPackage[] = [];
    for (const record of files.filter((candidate) => candidate.kind === "package").sort((left, right) => left.path.localeCompare(right.path))) {
      const catalogEntry = catalogByDownloadName.get(record.downloadName);
      if (!catalogEntry) continue;
      const surveyId = catalogEntry.surveyId;
      if (!surveyId || isDeniedSurvey(surveyId)) continue;
      if (catalogEntry.deprecated === true) continue;
      const zipBytes = await readFile(this.#inside(stagingRoot, record.path));
      const projection = await projectResourcePackage({
        id: catalogEntry.id,
        version: catalogEntry.version,
        name: catalogEntry.name,
        surveyId,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        facilities: typeof catalogEntry.facilities === "object" && catalogEntry.facilities !== null && Array.isArray(catalogEntry.facilities)
          ? (catalogEntry.facilities as string[])
          : undefined,
        accessModes: Array.isArray(catalogEntry.accessModes) ? (catalogEntry.accessModes as string[]) : undefined,
        sources: Array.isArray(catalogEntry.sources) ? (catalogEntry.sources as ProjectedPackageSource[]) : undefined,
        zipBytes,
      }, surveyLookups);
      collectionInputs.push({ downloadName: record.downloadName, zipBytes, projection });
      historyPackages.push({
        ...projection,
        downloadUrl: `/api/v1/resource-packages/${projection.id}/versions/${projection.version}/download`,
      });
    }
    const collection = await buildResourcePackageCollection({
      releaseId,
      sequence,
      bundleId,
      releasedAt: generatedAt,
      notes: `Publication run ${runId}`,
      catalogBytes,
      packages: collectionInputs,
    });
    const collectionPath = `artifacts/public-survey-footprints/collections/${collection.fileName}`;
    const collectionDestination = this.#inside(stagingRoot, collectionPath);
    await mkdir(path.dirname(collectionDestination), { recursive: true });
    await writeFile(collectionDestination, collection.bytes);
    files.push({
      id: `collection-${slugifyReleaseId(releaseId)}`,
      kind: "package-collection",
      label: "Resource package collection",
      description: `All ${collectionInputs.length} public resource packages of release ${releaseId} in one deterministic archive.`,
      path: collectionPath,
      downloadName: collection.fileName,
      mediaType: "application/zip",
      sizeBytes: collection.sizeBytes,
      sha256: collection.sha256,
      deliveryClass: "runtime",
    });

    const history: ReleaseHistoryDocument = {
      schemaVersion: 2,
      latestReleaseId: releaseId,
      releases: [...baselineHistory.releases, {
        releaseId,
        sequence,
        bundleId,
        releasedAt: generatedAt,
        notes: `Publication run ${runId}`,
        catalogSha256: createHash("sha256").update(catalogBytes).digest("hex"),
        collection: {
          fileName: collection.fileName,
          sizeBytes: collection.sizeBytes,
          sha256: collection.sha256,
          downloadUrl: `/api/v1/releases/${releaseId}/download`,
        },
        packages: historyPackages,
      }],
    };
    const historyBytes = Buffer.from(`${JSON.stringify(history, null, 2)}\n`, "utf8");
    const historyRecord = baseline.files.find((record) => record.path === RELEASE_HISTORY_RELATIVE_PATH);
    files.push({
      ...(historyRecord ?? {
        id: "metadata-release-history",
        kind: "metadata" as const,
        label: "Release history",
        description: "Chronological history of published public releases.",
        downloadName: "release-history.json",
        mediaType: "application/json",
      }),
      path: RELEASE_HISTORY_RELATIVE_PATH,
      sizeBytes: historyBytes.byteLength,
      sha256: createHash("sha256").update(historyBytes).digest("hex"),
      deliveryClass: "runtime" as const,
    });

    files.sort((left, right) => left.path.localeCompare(right.path));
    const seen = new Set<string>();
    for (const record of files) {
      if (seen.has(record.path)) throw new PublicationConflictError(`Candidate release has duplicate path: ${record.path}`, 500);
      seen.add(record.path);
      if (record.deliveryClass !== "runtime") throw new PublicationConflictError(`Candidate release contains an evidence record: ${record.id}`, 500);
      try {
        assertRecordPublishable(record);
      } catch (error) {
        throw new PublicationConflictError(error instanceof Error ? error.message : String(error), 500);
      }
    }
    const bundleSha256 = publicReleaseBundleDigest(files);
    const manifest: ReleaseManifestDocument = {
      schemaVersion: 1,
      generatedAt,
      bundle: { id: bundleId, sha256: bundleSha256 },
      statistics: {
        ...baseline.statistics,
        packages: files.filter((record) => record.kind === "package").length,
        rawMocFiles: files.filter((record) => record.kind === "moc").length,
        totalBytes: files.reduce((sum, record) => sum + record.sizeBytes, 0),
        runtimeBytes: files.reduce((sum, record) => sum + record.sizeBytes, 0),
        evidenceBytes: 0,
      },
      files,
    };
    const catalogDestination = this.#inside(stagingRoot, PACKAGE_CATALOG_RELATIVE_PATH);
    await mkdir(path.dirname(catalogDestination), { recursive: true });
    await writeFile(catalogDestination, catalogBytes);
    const historyDestination = this.#inside(stagingRoot, RELEASE_HISTORY_RELATIVE_PATH);
    await mkdir(path.dirname(historyDestination), { recursive: true });
    await writeFile(historyDestination, historyBytes);
    const manifestDestination = this.#inside(stagingRoot, MANIFEST_RELATIVE_PATH);
    await mkdir(path.dirname(manifestDestination), { recursive: true });
    await writeFile(manifestDestination, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    return { root: stagingRoot, files, packages: dynamicPackageEntries };
  }

  async #allDynamicPackages(): Promise<Array<{ entry: PublicPackageEntry; asset: DynamicResourcePackageAsset }>> {
    const assets = await this.#options.loadPackages.assets();
    const result: Array<{ entry: PublicPackageEntry; asset: DynamicResourcePackageAsset }> = [];
    for (const entry of await this.#options.loadPackages.list()) {
      if (entry.hidden || isDeniedSurvey(entry.surveyId)) continue;
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

  #append(run: PublicationRun, message: string): PublicationRun {
    return { ...run, log: [...run.log.slice(-40), `${new Date().toISOString()} ${message}`] };
  }

  async #writeRun(run: PublicationRun): Promise<void> {
    await mkdir(this.#runsDir, { recursive: true });
    await writeFile(path.join(this.#runsDir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await queueStateSnapshot(this.#snapshotSink, "publication-runs", { schemaVersion: 1, runs: await this.#readRunsOnDisk() });
  }

  async #ensureRunsRestored(): Promise<void> {
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
      const run = await this.get(runId);
      if (run?.status === "queued") {
        const queuedPath = path.join(this.#queueDir, `${runId}.json`);
        await rename(claimedPath, queuedPath).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
          await rm(claimedPath, { force: true });
        });
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
