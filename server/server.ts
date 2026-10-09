import { ApiManagement, MANAGED_KEY_PREFIX } from "./api-management.js";
import { LlmDiscovery, CDS_SEARCH_URL } from "./llm-discovery.js";
import { adminInventoryIndex } from "./admin-survey-index.js";
import { decodeNativeMoc, sha256 as nativeSha256 } from "./native-moc.js";
import { assertPublicCoverageOrder, MIN_PUBLIC_COVERAGE_ORDER, CoveragePrecisionError } from "./coverage-policy.js";
import { acquireLocalFileLock } from "./local-file-lock.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { ReleaseSynchronizer } from "./release-synchronizer.js";
import { PublicationScheduler } from "./publication-scheduler.js";
import { NativeUnitController } from "./native-unit-controller.js";
import { nativeDatabaseKey } from "./native-unit-worker.js";
import { sourceIdsForBinding } from "./native-unit-sources.js";
import { nativeEvidencePath, type NativeBinding, type NativeGroup } from "./native-unit-model.js";
import type { SourceUnitLoadOptions } from "./source-units.js";
import { healpixList, type HealpixLayer } from "./healpix-list.js";
import { pageCoverageFootprints } from "./coverage-footprint-pages.js";
import { publicOpenApi } from "./public-openapi.js";
import { ReverseStream } from "./reverse-stream.js";
import { proxyAdmin } from "./admin-proxy.js";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { AdminHttpError, AssetsAdmin, KubernetesApiError, SUPPORTED_COVERAGE_MODES, adminFromRequest, type ConnectorInput, type ConnectorView, type CoverageTaskInput, type CoverageTaskView, type KubernetesResource, type MocDiscoveryInput, type ScanBatchTaskRecipe } from "./admin.js";
import { batchEvidenceLayerId, parseScanBatchRequest, resolveScanBatchIncludePattern, resolveScanBatchMode, ScanBatchValidationError } from "./scan-batch.js";
import { ConnectorInventoryStateStore, ConnectorProbeStateStore } from "./connector-state.js";
import { ConnectorPresentationStore } from "./connector-presentation.js";
import { createArtifactStoreFromProcess, FilesystemArtifactStore } from "./artifact-store.js";
import { assetPreviewMode, loadCatalog, publicManifest, type LoadedCatalog } from "./catalog.js";
import { projectRoot } from "./paths.js";
import { loadSurveyIndex, type PublicSurveyIndex } from "./surveys.js";
import { coverageBlock, coverageCatalogFromWarehouse, isWarehouseFilePartitionLayer, loadCoverageCatalog, updateCoverageNativeUnitState, withCoverageRevisions, type CoverageCatalog, type CoverageCellLayer, type WarehouseFileIndexSummary, type WarehouseGeometryLoadStatus } from "./coverage.js";
import { layersForOverlapComponent, overlapForLayers } from "./overlap.js";
import { AccessGate, AccessError, queryRegion, validateRegion } from "./region-access.js";
import { loadPublicState } from "./public-state.js";
import { ProductStore, type MocProductRegistrationInput, type ProductExecutionRecord, type ProductRecord } from "./products.js";
import { currentReview, productGeometry, readApprovedRelease, PUBLICATION_POLICY } from "./approved-release.js";
import { aggregateReadiness, deriveProductReadiness, type ProductReadiness, type ReadinessAggregate, type ReadinessLayer } from "./admin-readiness.js";
import { SurveyEditorialStore, type SurveyEditorialContent, type SurveyEditorialRecord } from "./editorial.js";
import { SourceUnitStore, SourceUnitWorkerStore, type SourceUnitCoverageLayer } from "./source-units.js";
import { buildDownloadPlan, CoverageEvidenceStore, EvidenceStoreError, warehouseGeometryFailureReason, type DownloadPlan, type DownloadPlanCoverageEvidence, type DownloadPlanEntrypoint, type DownloadPlanSpatialUnit, type ReverseLookupResult, type WarehouseLayerSnapshot, type WarehouseLayerStatusSnapshot } from "./evidence-store.js";
import { interleaveSpatialUnitsBySurvey, partitionReverseCells, reversePageSize, reversePlanCoverageEvidenceKey, reversePlanEntrypointKey, reversePlanFileKey, reversePlanItems, reversePlanSpatialUnitKey, type ReverseCursorScope } from "./reverse-pagination.js";
import { resolveEuclidQ1MerFile } from "./euclid-data-links.js";
import { buildOverlapDetails, publicExternalUrl, publicLocator } from "./overlap-details.js";
import { filterByModalities } from "../src/modality-filter.js";
import { MAST_HST_DISCOVERY_POLICY, resolveMocDiscoveryCandidate } from "./moc-discovery.js";
import { decodeScopeMoc, parseMastHstScopeRef, resolveMastHstScope } from "./mast-hst-discovery.js";
import { importMastHstObservation } from "./mast-hst-import.js";
import { normalizedHstLookupCells } from "./hst-image-lookup.js";
import { HstObservationIndex } from "./hst-observation-index.js";
import { archiveNativeUnits } from "./archive-native-units.js";
import { SurveyNativeIndex, nativeBindingIndexRoute, surveyNativeBinding } from "./survey-native-index.js";
import { verifyNativeRuntimeBindings } from "./native-runtime-verification.js";
import { alternativesForAccessUri, mergeSourceAccessUris, mergeSourceMetadata, withSurveyProviderStatuses } from "./survey-access.js";
import { scannedFileConnectors, withWarehouseConnectorEvidence, type WarehouseConnectorContext } from "./warehouse-source-evidence.js";
import { parseEroTargetSnapshot, type EroTargetIndex } from "./ero-target-index.js";
import { decodeSnapshotCursor, readReverseSnapshot, snapshotPage, writeReverseSnapshot, type ReverseSnapshot } from "./reverse-snapshot.js";
import { MocBuildService, MocBuildStore, MocPublicationStore, type MocPublication, type MocPublicationFile } from "./moc-build.js";
import { DynamicResourcePackageStore, dynamicResourcePackageAssetId } from "./resource-package-publication.js";
import { PublicReleasePublisher, PublicationConflictError, type ReleaseHistoryDocument } from "./public-release-publication.js";
import { isDeniedPackageId, isDeniedSurvey } from "./publication-policy.js";
import { ContentArchiveError } from "./content-archive.js";
import { buildPublicProductEvidence } from "./public-product-evidence.js";
import { registerEvidenceMoc } from "./evidence-moc-import.js";
import { registerPathHealpixMoc } from "./path-healpix-moc-import.js";
import { mergeWarehouseSourceFiles, warehouseLogicalLayersForSource } from "./reverse-observations.js";
import { StateSnapshotCoordinator, STATE_SNAPSHOT_NAMESPACES, type StateSnapshotSink, type StateSnapshotSyncStatus } from "./state-snapshot.js";
import { UploadSpool } from "./upload-spool.js";
import type { PublicAssetRecord, PublicProductDossier, PublicProductLink, PublicProductReadiness, PublicProductVerificationStatus, PublicReadinessAggregate, PublicSurveyModality } from "./types.js";

const role = process.env.ASSETS_ROLE ?? "legacy";
if (!["legacy", "site", "backend"].includes(role)) throw new Error("Invalid ASSETS_ROLE");
const managesContent = role !== "site";
const requestRelease = new AsyncLocalStorage<{ catalog: LoadedCatalog; state: Awaited<ReturnType<typeof loadPublicState>>; nativeGroup?: NativeGroup; nativeVersion: string }>();
const port = Number(process.env.PORT ?? "4180");
const host = process.env.HOST ?? "0.0.0.0";
const accessGate=new AccessGate();
async function handleDownloadUnlock(request:IncomingMessage,response:ServerResponse):Promise<void> {
  const apiKey = request.headers["x-assets-api-key"];
  if (typeof apiKey !== "string" || !apiKey.startsWith(MANAGED_KEY_PREFIX)) throw new AccessError(401, "API Key required");
  accessGate.sameOrigin(request);
  if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
  if (!apiManagement) throw new AccessError(503, "API management unavailable");
  const started = Date.now(), route = "/api/v1/access/unlock";
  let id: string | undefined;
  const token = accessGate.unlockKey(request, () => { id = apiManagement.authorize(apiKey, "region:query", route); return id; });
  apiManagement.recordKey(id!, route, 200, Date.now()-started);
  response.setHeader("Cache-Control", "no-store");
  const secure=request.headers["x-forwarded-proto"]==="https"?"; Secure":"";
  response.setHeader("Set-Cookie",`assets_download=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secure}`);
  json(response,200,{unlocked:true,expiresAt:new Date(Date.now()+3600000).toISOString()});
}
const releaseRoot = path.resolve(process.env.ASSET_RELEASE_ROOT ?? process.env.ASSET_WORKTREE_ROOT ?? projectRoot);
const productCatalogRoot = path.resolve(process.env.ASSETS_PRODUCT_CATALOG_ROOT ?? releaseRoot);
const siteRoot = path.resolve(process.env.PUBLIC_SITE_ROOT ?? path.join(projectRoot, "dist", "site"));
const authorityStore = role !== "legacy" ? createArtifactStoreFromProcess() : undefined;
const releaseSynchronizer = authorityStore ? new ReleaseSynchronizer(authorityStore, path.dirname(releaseRoot), process.env.ASSETS_OBJECT_STORE_CURRENT_KEY) : undefined;
await releaseSynchronizer?.sync();
let currentCatalog = await loadCatalog(await realpath(releaseRoot));
const catalog = new Proxy({} as LoadedCatalog, { get: (_target, key) => Reflect.get(requestRelease.getStore()?.catalog ?? currentCatalog, key) });
let coverageManifest = JSON.parse(await readFile(path.join(releaseRoot, "src", "footprints", "survey-footprints.json"), "utf8")) as {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: string;
  nside: number;
  footprints: Array<Record<string, unknown> & { surveyId: string; releaseId: string; product: string; nside: number; pixels: number[] }>;
};
const evidenceStore = new CoverageEvidenceStore({
  url: process.env.ASSETS_WAREHOUSE_ES_URL,
  layerIndex: process.env.ASSETS_WAREHOUSE_LAYER_INDEX,
  coverageIndex: process.env.ASSETS_WAREHOUSE_COVERAGE_INDEX,
  fileIndex: process.env.ASSETS_WAREHOUSE_FILE_INDEX,
});
const contentRoot = path.resolve(process.env.ASSETS_CONTENT_ROOT ?? path.join(releaseRoot, ".assets-content"));
const releaseBackendOwnership = role === "backend" ? await acquireLocalFileLock(path.join(contentRoot, ".backend-owner.lock")) : undefined;
const evidenceRoot = path.resolve(process.env.ASSETS_EVIDENCE_ROOT ?? "/var/lib/assets-evidence");
const publicLookupStore = authorityStore ?? new FilesystemArtifactStore(path.join(evidenceRoot, "public-lookups"));
const sourceUnitEvidenceRoot = path.resolve(process.env.ASSETS_SOURCE_UNIT_EVIDENCE_ROOT
  ?? (process.env.ASSETS_EVIDENCE_ROOT ? evidenceRoot : path.join(releaseRoot, "artifacts/public-survey-footprints/raw")));
const uploadSpoolRoot = path.resolve(process.env.ASSETS_UPLOAD_SPOOL_ROOT ?? "/var/lib/assets-upload-spool");
let stateSnapshotSink: StateSnapshotSink | undefined;
const objectStoreRequired = /^(1|true|yes|on)$/i.test(process.env.ASSETS_OBJECT_STORE_REQUIRED ?? "");
let snapshotWorker: { spool: UploadSpool; snapshots: StateSnapshotCoordinator } | undefined;
if (managesContent && (objectStoreRequired || process.env.ASSETS_OBJECT_STORE_ENDPOINT?.trim() || process.env.ASSETS_OBJECT_STORE_BUCKET?.trim())) {
  const objectStore = createArtifactStoreFromProcess(process.env);
  const uploadSpool = new UploadSpool({ root: uploadSpoolRoot, store: objectStore });
  await uploadSpool.initialize();
  const stateSnapshots = new StateSnapshotCoordinator({ root: path.join(uploadSpoolRoot, "state"), store: objectStore, spool: uploadSpool });
  await stateSnapshots.initialize(STATE_SNAPSHOT_NAMESPACES);
  stateSnapshotSink = stateSnapshots;
  snapshotWorker = { spool: uploadSpool, snapshots: stateSnapshots };
}

/**
 * Mutating admin APIs report whether the control document is only local,
 * admitted to the durable upload spool, or reflected by the S3 pointer. A
 * status read is best-effort so a successful local edit is never hidden by a
 * transient status probe failure.
 */
async function apiSyncStatus(namespace: string): Promise<StateSnapshotSyncStatus> {
  if (role === "backend" && namespace === "publication-runs") namespace = "publication-tasks";
  if (!stateSnapshotSink?.syncStatus) return { namespace, status: "local" };
  try {
    return await stateSnapshotSink.syncStatus(namespace);
  } catch (error) {
    return { namespace, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

const editorial = new SurveyEditorialStore(contentRoot, stateSnapshotSink);
const mocBuildStore = new MocBuildStore(contentRoot, stateSnapshotSink);
if (managesContent) await mocBuildStore.initialize();
const mocPublicationStore = new MocPublicationStore(contentRoot, evidenceRoot, stateSnapshotSink);
if (managesContent) await mocPublicationStore.initialize();
const dynamicResourcePackages = new DynamicResourcePackageStore(contentRoot, stateSnapshotSink, releaseRoot);
if (managesContent) await dynamicResourcePackages.initialize();
const publishedPublicAssets = new Map<string, { record: PublicAssetRecord; absolutePath: string }>();
const publishedAssetIds = new Set<string>();
const dynamicPackageAssetIds = new Set<string>();
let staticCoverageCatalog = await loadCoverageCatalog(releaseRoot, coverageManifest);
let coverageCatalog = staticCoverageCatalog;
let currentPublicState: Awaited<ReturnType<typeof loadPublicState>>;
let sourceUnitCoverageLayers: CoverageCellLayer[] = [];
let sourceUnitCoverageLoadPromise: Promise<void> | null = null;
let runtimeCoverageManifest = coverageManifest;
let coverageLoadMode: "warehouse" | "static" | "degraded" = "static";
let coverageLoadedAt = new Date().toISOString();
let warehouseGeometry: WarehouseGeometryLoadStatus = { status: "unconfigured", loadedAt: coverageLoadedAt, loadedLayers: 0, uniqueCells: 0, failures: [] };
const verifiedWarehouseLayers = new Map<string, CoverageCellLayer>();
let runtimeSurveyIndex!: Awaited<ReturnType<typeof loadSurveyIndex>>;
let warehouseLayerSnapshots = new Map<string, WarehouseLayerSnapshot | WarehouseLayerStatusSnapshot>();
let warehouseFileIndexMetadataUnavailable = false;
let productsForWarehouseStatus: ProductStore | undefined;
interface NativeRuntime {
  version: string; group?: NativeGroup; references: number;
  worker?: Promise<SourceUnitWorkerStore>; fallback?: Promise<SourceUnitStore>;
  hst?: Promise<HstObservationIndex | undefined>; ero?: Promise<EroTargetIndex | undefined>;
  survey?: Promise<SurveyNativeIndex | undefined>;
  state: "initializing" | "available" | "unavailable";
  capturedAt?: string; retire?: ReturnType<typeof setTimeout>;
}
const nativeRuntimes = new Map<string, NativeRuntime>();

function sourceUnitProductIdentity(value: Pick<CoverageCellLayer, "surveyId" | "releaseId" | "product">): string {
  return `${value.surveyId}\u0000${value.releaseId}\u0000${value.product}`;
}

function sourceUnitCoverageRecord(source: SourceUnitCoverageLayer): CoverageCellLayer {
  const cells = new Map(source.cells);
  const availableOrders = [...cells.keys()].sort((left, right) => left - right);
  const overviewOrder = Math.min(...availableOrders);
  const queryOrder = Math.max(...availableOrders);
  const overviewCells = cells.get(overviewOrder) ?? [];
  const queryCells = cells.get(queryOrder) ?? [];
  const coverageNote = source.coverageMethod === "unit-centers"
    ? `O${queryOrder} overview marks cells containing native ${source.unitKind} centers; it is indicative, not a boundary-complete footprint. Reverse lookup still intersects the selected full HEALPix cell with each locked native unit polygon.`
    : `HEALPix coverage is rasterized at O${queryOrder} from the locked native-unit polygons at runtime; this is not a generated or published MOC.`;
  const note = `${source.notes} ${coverageNote}`;
  return {
    layerId: source.layerId,
    productId: createHash("sha256").update(`${source.surveyId}\n${source.releaseId}\n${source.product}`).digest("hex").slice(0, 20),
    surveyId: source.surveyId,
    releaseId: source.releaseId,
    product: source.product,
    modality: source.modality,
    coverageRole: "footprint_extent",
    color: "#14b8a6",
    availableOrders,
    overviewOrder,
    maxOrder: queryOrder,
    cellCount: overviewCells.length,
    areaDeg2: queryCells.length * (41252.96124941927 / (12 * (2 ** queryOrder) ** 2)),
    tileScheme: "ipix-range-4096",
    cells,
    recipe: {
      recipeVersion: 1,
      mode: "source-unit-polygons",
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      maxOrder: queryOrder,
      queryOrder,
      previewOrder: overviewOrder,
      sourceUrl: source.sourceUrls[0],
      sourceSnapshotSha256: source.sourceSnapshotSha256,
      sourceFileReferences: source.sourceUrls,
      precision: "estimated",
      steps: [{
        id: "source-unit-polygons",
        kind: "native-unit-geometry",
        title: "Native sky-block geometry",
        bodyMarkdown: source.coverageMethod === "unit-centers"
          ? `Mark ICRS/NESTED O${queryOrder} cells containing official ${source.unitKind} centers as an indicative overview; reverse lookup uses the complete native unit boundaries. No MOC file is emitted.`
          : `Rasterize official ${source.unitKind} footprints in ICRS/NESTED at O${queryOrder}; preserve the native unit identity for reverse lookup. No MOC file is emitted.`,
        order: 0,
        implementationRef: "assets.coverage.source-unit-polygons",
      }],
    },
    sourceUnitIndex: { status: "estimated", unitKind: source.unitKind, indexUrl: "/api/v1/coverage/reverse-lookup", notes: note },
    sourceEvidence: {
      evidenceKind: "source-unit-footprint",
      sourceIdentity: source.unitKind,
      sourceSnapshotSha256: source.sourceSnapshotSha256,
      precision: "estimated",
      completeness: "unknown",
      scienceFileScan: "not-scanned",
      summary: note,
    },
  };
}

function mergeSourceUnitCoverage(
  base: CoverageCatalog & { records: Map<string, CoverageCellLayer> },
  extra: CoverageCellLayer[] = sourceUnitCoverageLayers,
): CoverageCatalog & { records: Map<string, CoverageCellLayer> } {
  if (!extra.length) return base;
  const records = new Map(base.records);
  const existingByIdentity = new Map([...records.values()].map((record) => [sourceUnitProductIdentity(record), record]));
  for (const layer of extra) {
    const identity = sourceUnitProductIdentity(layer);
    const existing = existingByIdentity.get(identity);
    const merged = existing ? {
      ...existing,
      coverageRole: "footprint_extent" as const,
      availableOrders: layer.availableOrders,
      overviewOrder: layer.overviewOrder,
      maxOrder: layer.maxOrder,
      cellCount: layer.cellCount,
      areaDeg2: layer.areaDeg2,
      cells: layer.cells,
      recipe: layer.recipe,
      sourceEvidence: layer.sourceEvidence,
      sourceUnitIndex: layer.sourceUnitIndex,
    } : layer;
    records.set(merged.layerId, merged);
  }
  return withCoverageRevisions({ ...base, records, layers: [] });
}

function mergeSourceUnitFootprints(
  manifest: typeof runtimeCoverageManifest,
  records: ReadonlyMap<string, CoverageCellLayer>,
): typeof runtimeCoverageManifest {
  const footprints = [...manifest.footprints];
  for (const source of sourceUnitCoverageLayers) {
    const identity = sourceUnitProductIdentity(source);
    const layer = records.get(source.layerId) ?? [...records.values()].find((candidate) => sourceUnitProductIdentity(candidate) === identity);
    if (!layer) continue;
    const footprint = {
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
      nside: 2 ** layer.overviewOrder,
      pixels: layer.cells.get(layer.overviewOrder) ?? [],
      sourceUrl: layer.recipe?.sourceUrl,
    };
    const existingIndex = footprints.findIndex((candidate) => sourceUnitProductIdentity(candidate) === identity);
    if (existingIndex >= 0) footprints[existingIndex] = footprint;
    else footprints.push(footprint);
  }
  return { ...manifest, footprints };
}

function mergeSourceUnitSurveyIndex(
  publicIndex: PublicSurveyIndex,
  sourceIndex: PublicSurveyIndex,
  layers: readonly CoverageCellLayer[],
  footprints: readonly (typeof currentPublicState.footprints)[number][],
): PublicSurveyIndex {
  const surveys = publicIndex.surveys.map((survey) => ({
    ...survey,
    modalities: [...survey.modalities],
    releases: survey.releases.map((release) => ({ ...release, modalities: [...release.modalities], products: [...release.products] })),
    assets: [...survey.assets],
  }));

  for (const layer of layers) {
    const sourceSurvey = sourceIndex.surveys.find((survey) => survey.id === layer.surveyId);
    const sourceRelease = sourceSurvey?.releases.find((release) => release.id === layer.releaseId);
    const sourceProduct = sourceRelease?.products.find((product) => product.name === layer.product);
    if (!sourceSurvey || !sourceRelease || !sourceProduct) continue;

    let survey = surveys.find((candidate) => candidate.id === layer.surveyId);
    if (!survey) {
      survey = {
        ...sourceSurvey,
        modalities: [...sourceSurvey.modalities],
        releases: [],
        statistics: { publicProducts: 0, acquired: 0, overviewOnly: 0, awaitingGeometry: 0, notApplicable: 0, footprintCells: 0 },
        assets: [],
      };
      surveys.push(survey);
    }
    let release = survey.releases.find((candidate) => candidate.id === layer.releaseId);
    if (!release) {
      release = { ...sourceRelease, modalities: [...sourceRelease.modalities], products: [] };
      survey.releases.push(release);
    }
    const existing = release.products.find((product) => product.name === layer.product);
    const product = {
      ...sourceProduct,
      ...(existing ?? {}),
      ...(layer.sourceEvidence?.evidenceKind === "source-unit-footprint" ? { status: "acquired" as const } : {}),
      sourceUrl: sourceProduct.sourceUrl,
      coverage: { layerId: layer.layerId, availableOrders: layer.availableOrders, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder },
    };
    if (existing) release.products[release.products.indexOf(existing)] = product;
    else release.products.push(product);
    const modality = product.modality;
    if (!release.modalities.includes(modality)) release.modalities.push(modality);
    if (!survey.modalities.includes(modality)) survey.modalities.push(modality);
  }

  return {
    ...publicIndex,
    surveys: surveys.map((survey) => {
      const products = survey.releases.flatMap((release) => release.products);
      const coverageLayers = layers.filter((layer) => layer.surveyId === survey.id);
      const pixels = new Set(footprints.filter((footprint) => footprint.surveyId === survey.id).flatMap((footprint) => footprint.pixels));
      const surveyOrders = [...new Set([...(survey.coverageOrders?.availableOrders ?? []), ...coverageLayers.flatMap((layer) => layer.availableOrders)])].sort((left, right) => left - right);
      return {
        ...survey,
        ...(surveyOrders.length ? { coverageOrders: {
          availableOrders: surveyOrders,
          overviewOrders: [...new Set([...(survey.coverageOrders?.overviewOrders ?? []), ...coverageLayers.map((layer) => layer.overviewOrder)])].sort((a, b) => a - b),
          maxOrder: Math.max(...surveyOrders),
        } } : {}),
        releases: survey.releases.map((release) => {
          const releaseLayers = coverageLayers.filter((layer) => layer.releaseId === release.id);
          const orders = [...new Set([...(release.coverageOrders?.availableOrders ?? []), ...releaseLayers.flatMap((layer) => layer.availableOrders)])].sort((left, right) => left - right);
          return {
            ...release,
            ...(orders.length ? { coverageOrders: {
              availableOrders: orders,
              overviewOrders: [...new Set([...(release.coverageOrders?.overviewOrders ?? []), ...releaseLayers.map((layer) => layer.overviewOrder)])].sort((a, b) => a - b),
              maxOrder: Math.max(...orders),
            } } : {}),
          };
        }),
        statistics: {
          ...survey.statistics,
          publicProducts: products.length,
          acquired: products.filter((product) => product.status === "acquired").length,
          overviewOnly: products.filter((product) => product.status === "overview_only").length,
          awaitingGeometry: products.filter((product) => product.status === "awaiting_geometry").length,
          notApplicable: products.filter((product) => product.status === "not_applicable").length,
          footprintCells: pixels.size,
        },
      };
    }),
  };
}

function mergeSourceUnitPublicState(
  state: Awaited<ReturnType<typeof loadPublicState>>,
  sourceIndex: PublicSurveyIndex,
  layers: readonly CoverageCellLayer[],
): Awaited<ReturnType<typeof loadPublicState>> {
  const coverage = mergeSourceUnitCoverage(state.coverage, [...layers]);
  const footprints = [...state.footprints];
  const resolvedLayers = layers.map((layer) => coverage.records.get(layer.layerId)
    ?? [...coverage.records.values()].find((candidate) => sourceUnitProductIdentity(candidate) === sourceUnitProductIdentity(layer))
    ?? layer);
  for (const layer of resolvedLayers) {
    const footprint = {
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
      productId: layer.productId,
      layerId: layer.layerId,
      nside: 2 ** layer.overviewOrder,
      pixels: layer.cells.get(layer.overviewOrder) ?? [],
    };
    const identity = sourceUnitProductIdentity(layer);
    const existingIndex = footprints.findIndex((candidate) => sourceUnitProductIdentity(candidate) === identity);
    if (existingIndex >= 0) footprints[existingIndex] = footprint;
    else footprints.push(footprint);
  }
  return {
    ...state,
    coverage,
    footprints,
    index: mergeSourceUnitSurveyIndex(state.index, sourceIndex, resolvedLayers, footprints),
  };
}

function currentWarehouseCoverageSnapshots(): ReadonlyMap<string, WarehouseLayerSnapshot> {
  const snapshots = new Map<string, WarehouseLayerSnapshot>();
  for (const [layerId, snapshot] of warehouseLayerSnapshots) {
    // Draft readiness counters deliberately share this map, but overlap
    // details must only receive full coverage snapshots.  Status-only rows do
    // not carry survey/product identity or available orders and cannot prove
    // a spatial match.
    if ("surveyId" in snapshot && "releaseId" in snapshot && "productId" in snapshot && "availableOrders" in snapshot) {
      snapshots.set(layerId, snapshot);
    }
  }
  return snapshots;
}

let warehouseConnectorLookupCache: { expiresAt: number; value: Promise<WarehouseConnectorContext> } | undefined;

function warehouseConnectorLookup(): Promise<WarehouseConnectorContext> {
  if (warehouseConnectorLookupCache && warehouseConnectorLookupCache.expiresAt > Date.now()) return warehouseConnectorLookupCache.value;
  const value = Promise.allSettled([admin.listTasks(), admin.listScanBatches(), admin.listConnectors()])
    .then(([tasks, batches, connectors]) => ({
      tasks: tasks.status === "fulfilled" ? tasks.value : [],
      batches: batches.status === "fulfilled" ? batches.value : [],
      connectors: connectors.status === "fulfilled" ? connectors.value : [],
    }));
  warehouseConnectorLookupCache = { expiresAt: Date.now() + 15_000, value };
  return value;
}

async function currentWarehouseOverlapSnapshots(): Promise<ReadonlyMap<string, WarehouseLayerSnapshot>> {
  const snapshots = currentWarehouseCoverageSnapshots();
  if (![...snapshots.values()].some((snapshot) => snapshot.scanRunId || snapshot.scanRunIds?.length || snapshot.scanScope)) return snapshots;
  const context = await warehouseConnectorLookup();
  return new Map([...snapshots].map(([layerId, snapshot]) => [layerId, withWarehouseConnectorEvidence(snapshot, context)]));
}

function warehouseFileIndexSummary(layerId: string): WarehouseFileIndexSummary {
  const candidate = warehouseLayerSnapshots.get(layerId);
  const snapshot = candidate && "surveyId" in candidate && "releaseId" in candidate && "productId" in candidate
    ? candidate as WarehouseLayerSnapshot
    : undefined;
  if (snapshot && snapshot.state.toUpperCase() === "ACTIVE" && snapshot.fileCount > 0 && snapshot.coverageCount > 0) {
    return {
      status: "available",
      indexUrl: "/api/v1/coverage/reverse-lookup",
      fileCount: snapshot.fileCount,
      coverageCount: snapshot.coverageCount,
      errorCount: snapshot.errorCount,
      ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
      notes: "Warehouse 当前有可按空间区域查询的已扫描文件索引；计数描述扫描范围，不代表完整巡天。",
    };
  }
  if (!evidenceStore.configured || coverageLoadMode === "degraded" || warehouseFileIndexMetadataUnavailable) {
    return { status: "unavailable", notes: "当前无法确认 Warehouse 文件反查索引状态。" };
  }
  return { status: "not-indexed", notes: "当前没有该产品可用的 Warehouse 文件空间索引；原生分块映射状态单独列出。" };
}

function clearPublishedAssets(): void {
  for (const id of publishedAssetIds) catalog.files.delete(id);
  publishedAssetIds.clear();
  publishedPublicAssets.clear();
}

function clearDynamicPackageAssets(): void {
  for (const id of dynamicPackageAssetIds) catalog.files.delete(id);
  dynamicPackageAssetIds.clear();
}

function registerDynamicPackageAssets(): void {
  clearDynamicPackageAssets();
  for (const asset of dynamicResourcePackages.assets()) {
    const record: PublicAssetRecord = {
      id: asset.id,
      kind: "package",
      label: asset.name,
      description: `Immutable Resource Package v3 for ${asset.surveyId}.`,
      path: asset.path,
      downloadName: asset.downloadName,
      mediaType: "application/zip",
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      surveyId: asset.surveyId,
      ...(asset.releaseId ? { releaseId: asset.releaseId } : {}),
      version: asset.version,
      deliveryClass: "runtime",
    };
    catalog.files.set(asset.id, { record, absolutePath: path.resolve(contentRoot, asset.path) });
    dynamicPackageAssetIds.add(asset.id);
  }
}

function publicationAsset(id: string, publication: MocPublication, file: MocPublicationFile, kind: PublicAssetRecord["kind"], label: string, downloadName: string): { record: PublicAssetRecord; absolutePath: string } {
  const record: PublicAssetRecord = {
    id,
    kind,
    label,
    description: `Published MOC build ${publication.buildName}`,
    path: file.path,
    downloadName,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    surveyId: publication.surveyId,
    releaseId: publication.releaseId,
    product: publication.product,
    deliveryClass: "runtime",
  };
  const entry = { record, absolutePath: mocPublicationStore.absolutePath(file) };
  catalog.files.set(id, entry);
  publishedAssetIds.add(id);
  publishedPublicAssets.set(id, entry);
  return entry;
}

async function registerPublicationAssets(publication: MocPublication): Promise<void> {
  publicationAsset(`layer-${publication.layerId}-moc`, publication, publication.files.moc, "moc", `${publication.product} FITS MOC`, `${publication.layerId}.moc.fits`);
  if (publication.files.query) publicationAsset(`layer-${publication.layerId}-query`, publication, publication.files.query, "geometry", `${publication.product} query projection`, `${publication.layerId}.query.json`);
  if (publication.files.preview) publicationAsset(`layer-${publication.layerId}-preview`, publication, publication.files.preview, "geometry", `${publication.product} coverage preview`, `${publication.layerId}.preview.json`);
  if (publication.files.statistics) publicationAsset(`layer-${publication.layerId}-statistics`, publication, publication.files.statistics, "metadata", `${publication.product} coverage statistics`, `${publication.layerId}.statistics.json`);
  if (publication.files.manifest) publicationAsset(`layer-${publication.layerId}-manifest`, publication, publication.files.manifest, "provenance", `${publication.product} MOC build manifest`, `${publication.layerId}.build-manifest.json`);
}

async function readProjection(file: MocPublicationFile | undefined): Promise<{ order: number; pixels: number[] } | undefined> {
  if (!file) return undefined;
  try {
    const value = JSON.parse(await readFile(mocPublicationStore.absolutePath(file), "utf8")) as Record<string, unknown>;
    const order = typeof value.order === "number" && Number.isSafeInteger(value.order) && value.order >= 0 && value.order <= 29 ? value.order : Number.NaN;
    const pixels = Array.isArray(value.pixels) ? value.pixels.filter((pixel): pixel is number => typeof pixel === "number" && Number.isSafeInteger(pixel) && pixel >= 0) : [];
    if (!Number.isSafeInteger(order) || !pixels.length) return undefined;
    return { order, pixels: [...new Set(pixels)].sort((a, b) => a - b) };
  } catch { return undefined; }
}

async function publicationLayer(publication: MocPublication): Promise<CoverageCellLayer | undefined> {
  const query = await readProjection(publication.files.query);
  const preview = await readProjection(publication.files.preview);
  const projections = [preview, query].filter((value): value is { order: number; pixels: number[] } => Boolean(value));
  if (!projections.length) return undefined;
  const cellMap = new Map<number, number[]>();
  for (const projection of projections) if (!cellMap.has(projection.order)) cellMap.set(projection.order, projection.pixels);
  const availableOrders = [...cellMap.keys()].sort((a, b) => a - b);
  const overviewOrder = availableOrders[0]!;
  const maxOrder = availableOrders[availableOrders.length - 1]!;
  const overviewCells = cellMap.get(overviewOrder) ?? [];
  const areaDeg2 = overviewCells.length * (41252.96124941927 / (12 * 2 ** (2 * overviewOrder)));
  const productRecord = products.list().find((record) => record.productId === publication.productId);
  const productContent = productRecord?.published ?? productRecord?.draft;
  const pathIndex = productContent?.mode === "path-healpix" && publication.sourceEvidence?.precision === "exact";
  const recipeSteps = pathIndex
    ? productContent.presentation.flow.nodes.map((node, order) => ({
      id: node.id,
      kind: node.kind ?? node.id,
      title: node.title,
      bodyMarkdown: node.bodyMarkdown,
      order,
      implementationRef: `assets.coverage.${node.kind ?? node.id}`,
    }))
    : undefined;
  return {
    layerId: publication.layerId,
    productId: publication.productId,
    surveyId: publication.surveyId,
    releaseId: publication.releaseId,
    product: publication.product,
    ...(productContent?.modality ? { modality: productContent.modality } : {}),
    ...(productContent?.coverageRole ? { coverageRole: productContent.coverageRole } : {}),
    ...(publication.sourceEvidence ? { sourceEvidence: publication.sourceEvidence } : {}),
    color: productContent?.publicSurvey?.color ?? "#42d5c4",
    availableOrders,
    overviewOrder,
    maxOrder,
    cellCount: cellMap.get(maxOrder)?.length ?? overviewCells.length,
    areaDeg2,
    tileScheme: "ipix-range-4096",
    cells: cellMap,
    recipe: {
      recipeVersion: 1,
      mode: pathIndex ? "path-healpix" : "native-moc",
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      maxOrder,
      queryOrder: query?.order ?? maxOrder,
      previewOrder: preview?.order ?? overviewOrder,
      ...(publication.sourceEvidence ? { precision: publication.sourceEvidence.precision } : {}),
      steps: recipeSteps ?? [
        { id: "input", kind: "native-moc-source", title: "原生 FITS MOC 来源", bodyMarkdown: `sourceUrl=${publication.buildName}`, order: 0, implementationRef: "assets.moc.discovery" },
        { id: "validate", kind: "moc-validation", title: "IVOA MOC / ICRS / NUNIQ 校验", bodyMarkdown: "coordinateFrame=ICRS; ordering=NESTED", order: 1, implementationRef: "astro_survey_moc_core.core:validate_moc_fits" },
        { id: "project", kind: "order-projection", title: "发布 order 投影", bodyMarkdown: `queryOrder=${query?.order ?? maxOrder}; previewOrder=${preview?.order ?? overviewOrder}`, order: 2, implementationRef: "astro_survey_moc_core.core:project_cells" },
        { id: "outputs", kind: "outputs", title: "MOC、query、preview 输出", bodyMarkdown: "输出已校验的不可变发布制品。", order: 3, implementationRef: "assets.moc.publication" },
        { id: "evidence", kind: "evidence", title: "manifest、provenance、hash", bodyMarkdown: `build=${publication.buildName}`, order: 4, implementationRef: "assets.moc.publication" },
      ],
      sourceUrl: publication.sourceUrl,
      ...(publication.sourceSnapshotSha256 ? { sourceSnapshotSha256: publication.sourceSnapshotSha256 } : {}),
      ...(publication.sourceSnapshotSizeBytes !== undefined ? { sourceSnapshotSizeBytes: publication.sourceSnapshotSizeBytes } : {}),
    },
    ...(publication.sourceEvidence ? { sourceEvidence: publication.sourceEvidence } : {}),
    sourceUnitIndex: pathIndex
      ? { status: "exact", unitKind: `NESTED order-${productContent?.scanDefaults?.pathHealpixOrder ?? maxOrder} HEALPix partition`, indexUrl: "/api/v1/coverage/reverse-lookup", notes: "每个已扫描文件 URI 与其来源路径中的 NESTED HEALPix 分区精确对应；分区不是 DESI Tile，也不证明整个分区内每个天体都有观测。" }
      : { status: "entrypoint-only", notes: "这是公开来源 MOC 的覆盖层；没有源文件级反向索引。" },
  };
}

const products = new ProductStore(stateSnapshotSink, contentRoot);
// Drafts use the image-bundled catalog; public products remain bound to releaseRoot.
if (managesContent) await products.initialize(productCatalogRoot, coverageCatalog.layers);
productsForWarehouseStatus = products;

const activePublishedMocLayers = new Set<string>();
async function activatePublishedMocs(): Promise<void> {
  activePublishedMocLayers.clear();
  clearPublishedAssets();
  const layers = (await Promise.all(mocPublicationStore.list().map(async (publication) => {
    const integrity = await mocPublicationStore.verify(publication);
    if (!integrity.valid) {
      console.warn(`Skipping MOC publication ${publication.id}: ${integrity.reason}`);
      return undefined;
    }
    await registerPublicationAssets(publication);
    return publicationLayer(publication);
  }))).filter((layer): layer is CoverageCellLayer => Boolean(layer));
  if (!layers.length) return;
  const records = new Map(coverageCatalog.records);
  for (const layer of layers) { records.set(layer.layerId, layer); activePublishedMocLayers.add(layer.layerId); }
  coverageCatalog = withCoverageRevisions({ ...coverageCatalog, records, layers: [] });
  runtimeCoverageManifest = {
    ...runtimeCoverageManifest,
    generatedAt: new Date().toISOString(),
    nside: coverageCatalog.layers.length ? 2 ** Math.min(...coverageCatalog.layers.map((layer) => layer.overviewOrder)) : runtimeCoverageManifest.nside,
    footprints: [...records.values()].map((layer) => ({ surveyId: layer.surveyId, releaseId: layer.releaseId, product: layer.product, nside: 2 ** layer.overviewOrder, pixels: layer.cells.get(layer.overviewOrder) ?? [], sourceUrl: layer.recipe?.sourceUrl })),
  };
}

if (managesContent) await activatePublishedMocs();
currentPublicState = await loadPublicState(currentCatalog, productCatalogRoot);

function draftWarehouseLayerIds(publicLayerIds: ReadonlySet<string>): string[] {
  if (!productsForWarehouseStatus) return [];
  return [...new Set(productsForWarehouseStatus.list().flatMap(product => {
    const layerId = product.draft.layerId;
    return layerId && !publicLayerIds.has(layerId) && !isDeniedSurvey(product.draft.surveyId) ? [layerId] : [];
  }))];
}

async function reloadWarehouseDraftStatuses(): Promise<void> {
  if (!managesContent || !evidenceStore.configured || !productsForWarehouseStatus) return;
  const statuses = await evidenceStore.loadCurrentCoverageLayerStatuses(
    draftWarehouseLayerIds(new Set(currentPublicState.coverage.records.keys())),
  );
  for (const status of statuses) warehouseLayerSnapshots.set(status.layerId, status);
}

async function reloadRuntimeCoverage(): Promise<{ mode: string; loadedAt: string; layers: number; footprints: number; warehouseGeometry: WarehouseGeometryLoadStatus }> {
  coverageManifest = JSON.parse(await readFile(path.join(releaseRoot, "src", "footprints", "survey-footprints.json"), "utf8")) as typeof coverageManifest;
  staticCoverageCatalog = await loadCoverageCatalog(releaseRoot, coverageManifest);
  coverageCatalog = staticCoverageCatalog;
  runtimeCoverageManifest = coverageManifest;
  coverageLoadMode = "static";
  warehouseGeometry = { status: "unconfigured", loadedAt: new Date().toISOString(), loadedLayers: 0, uniqueCells: 0, failures: [] };
  warehouseLayerSnapshots = new Map();
  warehouseFileIndexMetadataUnavailable = false;
  if (managesContent && evidenceStore.configured) {
    const publicLayerIds = new Set(currentPublicState.coverage.records.keys());
    for (const layerId of verifiedWarehouseLayers.keys()) if (!publicLayerIds.has(layerId)) verifiedWarehouseLayers.delete(layerId);
    try {
      const warehouseSnapshot = await evidenceStore.loadCurrentCoverageCatalog({
        allowedLayerIds: [...publicLayerIds],
      });
      if (warehouseSnapshot?.layers.length) {
        coverageCatalog = coverageCatalogFromWarehouse(staticCoverageCatalog, warehouseSnapshot, verifiedWarehouseLayers);
        const failedLayers = new Set(warehouseSnapshot.failures?.map(failure => failure.layerId));
        warehouseGeometry = {
          status: failedLayers.size ? "degraded" : "loaded", loadedAt: new Date().toISOString(),
          loadedLayers: warehouseSnapshot.layers.length - failedLayers.size, uniqueCells: warehouseSnapshot.coverages.length,
          failures: (warehouseSnapshot.failures ?? []).map(failure => {
            const layer = warehouseSnapshot.layers.find(layer => layer.layerId === failure.layerId)!;
            const previous = verifiedWarehouseLayers.get(layer.layerId);
            const retained = previous?.productId === layer.productId && previous.surveyId === layer.surveyId && previous.releaseId === layer.releaseId;
            return { ...failure, surveyId: layer.surveyId, releaseId: layer.releaseId,
              product: currentPublicState.coverage.records.get(layer.layerId)?.product ?? layer.productId,
              retainedGeometry: retained ? "previous-scan" as const : "published" as const };
          }),
        };
        for (const layer of warehouseSnapshot.layers) {
          const verified = coverageCatalog.records.get(layer.layerId);
          if (!failedLayers.has(layer.layerId) && verified) verifiedWarehouseLayers.set(layer.layerId, verified);
        }
        const directSnapshots = warehouseSnapshot.layers
          .filter((layer) => coverageCatalog.records.has(layer.layerId))
          .map((layer) => [layer.layerId, layer] as const);
        const evidenceSnapshots = await evidenceStore.loadCurrentCoverageEvidenceSnapshots(
          [...currentPublicState.coverage.records.values()].map((layer) => ({
            layerId: layer.layerId,
            surveyId: layer.surveyId,
            releaseId: layer.releaseId,
            productId: layer.productId,
            modality: layer.modality,
          })),
        ).catch((error) => {
          warehouseFileIndexMetadataUnavailable = true;
          console.warn(`Warehouse file-index metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        });
        warehouseLayerSnapshots = new Map([
          ...directSnapshots,
          ...evidenceSnapshots.map((layer) => [layer.layerId, layer] as const),
        ]);
        runtimeCoverageManifest = {
          ...coverageManifest,
          generatedAt: new Date().toISOString(),
          nside: coverageCatalog.layers.length ? 2 ** Math.min(...coverageCatalog.layers.map((layer) => layer.overviewOrder)) : coverageManifest.nside,
          footprints: [...coverageCatalog.records.values()].map((layer) => ({
            surveyId: layer.surveyId,
            releaseId: layer.releaseId,
            product: layer.product,
            nside: 2 ** layer.overviewOrder,
            pixels: layer.cells.get(layer.overviewOrder) ?? [],
            sourceUrl: layer.recipe?.sourceUrl,
          })),
        };
        coverageLoadMode = failedLayers.size ? "degraded" : "warehouse";
        console.info(`Loaded ${warehouseGeometry.loadedLayers} Warehouse geometry layers with ${warehouseGeometry.uniqueCells} distinct real-order sky cells; ${failedLayers.size} layers failed.`);
        for (const failure of warehouseGeometry.failures) console.warn(`Warehouse geometry unavailable for ${failure.layerId}: ${failure.reason}; retaining ${failure.retainedGeometry} geometry.`);
      } else {
        warehouseGeometry = { ...warehouseGeometry, status: "loaded" };
        console.warn("Warehouse ES is configured but has no ACTIVE layers; using the checked-in public geometry until a scan completes.");
      }
    } catch (error) {
      coverageLoadMode = "degraded";
      const reason = warehouseGeometryFailureReason(error);
      warehouseGeometry = { ...warehouseGeometry, status: "degraded", error: reason,
        failures: [...verifiedWarehouseLayers.values()].map(layer => ({ layerId: layer.layerId, surveyId: layer.surveyId, releaseId: layer.releaseId, product: layer.product, reason, retainedGeometry: "previous-scan" })),
      };
      coverageCatalog = withCoverageRevisions({ ...staticCoverageCatalog, records: new Map([...staticCoverageCatalog.records, ...verifiedWarehouseLayers]), layers: [] });
      console.warn(`Warehouse coverage catalog unavailable; retaining verified geometry: ${reason}`);
      try {
        const directLayers = await evidenceStore.loadCurrentCoverageLayers({ allowedLayerIds: [...publicLayerIds] });
        const evidenceLayers = await evidenceStore.loadCurrentCoverageEvidenceSnapshots(
          [...currentPublicState.coverage.records.values()].map((layer) => ({
            layerId: layer.layerId,
            surveyId: layer.surveyId,
            releaseId: layer.releaseId,
            productId: layer.productId,
            modality: layer.modality,
          })),
        );
        const metadataLayers = [...new Map([...directLayers, ...evidenceLayers].map((layer) => [layer.layerId, layer])).values()];
        warehouseLayerSnapshots = new Map(metadataLayers.map((layer) => [layer.layerId, layer]));
        console.info(`Loaded ${metadataLayers.length} Warehouse layer metadata rows for overlap evidence; coverage geometry remains the checked-in public catalog.`);
      } catch (metadataError) {
        console.warn(`Warehouse layer metadata unavailable: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`);
      }
    }
  }
  try {
    await reloadWarehouseDraftStatuses();
  } catch (error) {
    console.warn(`Warehouse readiness metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  await sourceUnitCoverageLoadPromise?.catch(() => undefined);
  coverageLoadedAt = new Date().toISOString();
  if (managesContent) await activatePublishedMocs();
  coverageCatalog = mergeSourceUnitCoverage(coverageCatalog);
  runtimeCoverageManifest = mergeSourceUnitFootprints(runtimeCoverageManifest, coverageCatalog.records);
  runtimeSurveyIndex = await loadSurveyIndex(releaseRoot, catalog, runtimeCoverageManifest, coverageCatalog.layers, [...publishedPublicAssets.values()].map(({ record }) => record));
  currentPublicState = mergeSourceUnitPublicState(currentPublicState, runtimeSurveyIndex, sourceUnitCoverageLayers);
  return { mode: coverageLoadMode, loadedAt: coverageLoadedAt, layers: coverageCatalog.layers.length, footprints: coverageCatalog.records.size, warehouseGeometry };
}

await reloadRuntimeCoverage();
const connectorPresentations = new ConnectorPresentationStore(contentRoot, stateSnapshotSink);
const admin = new AssetsAdmin(undefined, undefined, undefined, new ConnectorProbeStateStore(contentRoot, stateSnapshotSink), new ConnectorInventoryStateStore(contentRoot, stateSnapshotSink), connectorPresentations);
const apiManagement = managesContent ? new ApiManagement(contentRoot, stateSnapshotSink) : undefined;
await apiManagement?.initialize();
const apiStatsTimer = apiManagement ? setInterval(() => { void apiManagement.flush().catch(() => console.error("API statistics archive failed")); }, 60000) : undefined;
apiStatsTimer?.unref();
const llmDiscovery = new LlmDiscovery({ root: contentRoot, evidenceRoot, sink: stateSnapshotSink,
  getSettings: () => apiManagement?.settings() ?? {}, onUsage: event => apiManagement?.recordLlm(event),
  getRequest: name => admin.getMocDiscoveryRequest(name), baseUrl: process.env.ASSETS_LLM_BASE_URL,
  model: process.env.ASSETS_LLM_MODEL, key: process.env.ASSETS_LLM_API_KEY });
if (managesContent) await llmDiscovery.initialize();
async function discoveryView(name: string) { return llmDiscovery.view(await admin.getMocDiscoveryRequest(name)); }
function discoveryCandidate(discovery: Awaited<ReturnType<typeof discoveryView>>, id: unknown) {
  return llmDiscovery.resolve(discovery.name, id) ?? resolveMocDiscoveryCandidate(discovery, id);
}
const llmTimer = managesContent ? setInterval(() => { void llmDiscovery.tick().catch(() => console.error("LLM discovery state update failed")); }, 5000) : undefined;
llmTimer?.unref();
try {
  await reloadWarehouseDraftStatuses();
} catch (error) {
  console.warn(`Warehouse readiness metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
}
const nativeUnits = managesContent ? new NativeUnitController({
  contentRoot, catalogRoot: productCatalogRoot, evidenceRoot: sourceUnitEvidenceRoot,
  store: authorityStore ?? new FilesystemArtifactStore(path.join(productCatalogRoot, "var/object-store")), snapshotSink: stateSnapshotSink,
  bindings: nativeProductBindings, changed: reloadNativeRuntime, verifyRuntime: verifyNativeRuntime,
  ...((process.env.ASSETS_PUBLIC_VERIFY_INTERNAL_URL || process.env.ASSETS_PUBLIC_VERIFY_URL) ? { verifySite: verifyNativeSite } : {}),
}) : undefined;
await nativeUnits?.initialize();
const publicationScheduler = role === "backend" && authorityStore && releaseSynchronizer ? new PublicationScheduler({
  contentRoot, baselineRoot: releaseRoot, store: authorityStore, snapshotSink: stateSnapshotSink,
  freeze: async () => ({ products: products.list(), publications: mocPublicationStore.list() }),
  synchronize: () => releaseSynchronizer.sync(),
  nativeUnits,
}) : undefined;
const publisher = new PublicReleasePublisher({
  runRepository: publicationScheduler,
  contentRoot,
  baselineRoot: releaseRoot,
  loadPublications: () => mocPublicationStore.list(),
  publicationFile: (file) => mocPublicationStore.absolutePath(file),
  loadPackages: dynamicResourcePackages,
  loadProducts: () => products.list(),
  snapshotSink: stateSnapshotSink,
  verificationTarget: process.env.ASSETS_PUBLIC_VERIFY_URL?.trim() || undefined,
  publicationLeaseMs: Number(process.env.ASSETS_PUBLICATION_LEASE_MS ?? "600000"),
});
const publicState = new Proxy({} as typeof currentPublicState, { get: (_target, key) => Reflect.get(requestRelease.getStore()?.state ?? currentPublicState, key) });
const approvedRelease = new Proxy({} as typeof currentPublicState.snapshot, { get: (_target, key) => Reflect.get(publicState.snapshot, key) });
await publicationScheduler?.initialize();
if (managesContent) products.projectPublished(approvedRelease.products, approvedRelease.generatedAt);
async function prepareProductGeometry(record:ProductRecord):Promise<void> {
  const staged=mocBuildStore.list().find(b=>b.productId===record.productId && b.phase==="STAGED");
  if(!staged)return;
  // This copies verified build bytes to durable candidate storage. It does not
  // grant public access; only the approved snapshot can do that.
  const prepared=await mocPublicationStore.publish(staged,{productId:record.productId,surveyId:record.draft.surveyId,releaseId:record.draft.releaseId,name:record.draft.name});
  await mocBuildStore.markPublished(staged.name,prepared.id);
  await reloadRuntimeCoverage();
}
let publicRefreshBusy=false;
const publicRefreshTimer=setInterval(()=>{ void (async()=>{
  if(publicRefreshBusy)return;publicRefreshBusy=true;
  try {
    await releaseSynchronizer?.sync();
    const root=await realpath(releaseRoot);
    if(root===currentCatalog.root)return;
    const nextCatalog=await loadCatalog(root);
    const next=await loadPublicState(nextCatalog, productCatalogRoot, currentPublicState);
    // No await between these assignments: readers see one consistent snapshot.
    currentCatalog=nextCatalog;currentPublicState=mergeSourceUnitPublicState(next,runtimeSurveyIndex,sourceUnitCoverageLayers);
    if (managesContent) products.projectPublished(next.snapshot.products,next.snapshot.generatedAt);
  } catch(error) { console.error("Public release refresh failed; retaining verified snapshot",error instanceof Error?error.message:String(error)); }
  finally {publicRefreshBusy=false;}
})().catch(()=>undefined);},5000);
publicRefreshTimer.unref();
const mocBuildService = new MocBuildService({
  store: mocBuildStore,
  evidenceRoot,
  maxOrder: Number(process.env.ASSETS_MOC_MAX_ORDER ?? "12"),
  queryOrder: Number(process.env.ASSETS_MOC_QUERY_ORDER ?? "8"),
  previewOrder: Number(process.env.ASSETS_MOC_PREVIEW_ORDER ?? "4"),
});

async function resumeMocBuilds(): Promise<void> {
  for (const request of mocBuildStore.list()) {
    if (["STAGED", "FAILED", "DUPLICATE"].includes(request.phase)) continue;
    try {
      const discovery = await discoveryView(request.discoveryRequestName);
      const candidate = discoveryCandidate(discovery, request.candidateId);
      mocBuildService.enqueue(request, candidate);
    } catch (error) {
      console.warn(`Unable to resume MOC build ${request.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
if (managesContent) await resumeMocBuilds();

async function refreshDynamicResourcePackages(): Promise<void> {
  // Restore previously generated immutable archives before attempting to
  // generate a newer package. A transient publication error must not make the
  // last known package disappear from the public catalog.
  registerDynamicPackageAssets();
  const verified = (await Promise.all(mocPublicationStore.list().map(async (publication) => {
    const integrity = await mocPublicationStore.verify(publication);
    return integrity.valid ? publication : undefined;
  }))).filter((publication): publication is MocPublication => Boolean(publication));
  try {
    await dynamicResourcePackages.sync(verified, products.list(), (file) => mocPublicationStore.absolutePath(file));
    registerDynamicPackageAssets();
  } catch (error) {
    // A failed generated package must not remove the last valid package from
    // the public catalog. The publication itself remains independently usable.
    console.warn(`Unable to refresh dynamic Resource Packages: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function applyPublishedProductMetadata(index: Awaited<ReturnType<typeof loadSurveyIndex>>): Awaited<ReturnType<typeof loadSurveyIndex>> {
  const allRecords = products.list();
  const retiredProductIds = new Set(allRecords.filter((record) => Boolean(record.retiredAt)).map((record) => record.productId));
  const published = allRecords.filter((record): record is ProductRecord & { published: NonNullable<ProductRecord["published"]> } => Boolean(record.published) && !record.retiredAt);
  if (!published.length) return index;
  const records = new Map(published.map((record) => [record.productId, record.published]));
  const publicModality = (value: string | undefined): PublicSurveyModality => {
    const allowed: PublicSurveyModality[] = ["imaging", "spectroscopy", "redshift", "photometry", "time-domain", "integral-field", "ultraviolet", "infrared", "catalog", "simulation", "radio"];
    return value && allowed.includes(value as PublicSurveyModality) ? value as PublicSurveyModality : "catalog";
  };
  const applyOverride = <T extends object>(product: T, override: ProductRecord["published"]): T => ({
    ...product,
    ...(override?.dataOrigin ? { dataOrigin: override.dataOrigin } : {}),
    ...(override?.sourceTier ? { sourceTier: override.sourceTier } : {}),
    ...(override?.originNote ? { originNote: override.originNote } : {}),
    ...(override?.sourceLabel ? { sourceLabel: override.sourceLabel } : {}),
    ...(override?.sourceUrl ? { sourceUrl: override.sourceUrl } : {}),
    ...(override?.officialDataLabel ? { officialDataLabel: override.officialDataLabel } : {}),
    ...(override?.officialDataUrl ? { officialDataUrl: override.officialDataUrl } : {}),
    ...(override?.officialQueryLabel ? { officialQueryLabel: override.officialQueryLabel } : {}),
    ...(override?.officialQueryUrl ? { officialQueryUrl: override.officialQueryUrl } : {}),
    ...(override?.geometrySourceLabel ? { geometrySourceLabel: override.geometrySourceLabel } : {}),
    ...(override?.geometrySourceUrl ? { geometrySourceUrl: override.geometrySourceUrl } : {}),
  } as T);
  const surveys = index.surveys.map((survey) => ({
    ...survey,
    releases: survey.releases.map((release) => ({
      ...release,
      products: release.products.filter((product) => !retiredProductIds.has(product.productId ?? "")).map((product) => {
        const override = records.get(product.productId ?? "");
        return override ? applyOverride(product, override) : product;
      }),
    })),
  }));
  const additionalAssets = [...publishedPublicAssets.values()].map(({ record }) => record);
  const allAssets = publicManifest(catalog, additionalAssets).files;
  const dynamicPublished = published.filter((record) => {
    const content = record.published;
    return Boolean(content.publicSurvey && content.publicRelease && content.publicDescription)
      && !surveys.some((survey) => survey.releases.some((release) => release.products.some((product) => product.productId === record.productId)));
  });
  for (const record of dynamicPublished) {
    const content = record.published;
    if (!content.publicSurvey || !content.publicRelease || !content.publicDescription) continue;
    const layer = coverageCatalog.layers.find((candidate) => candidate.surveyId === content.surveyId && candidate.releaseId === content.releaseId && candidate.product === content.name);
    const product = {
      productId: content.productId,
      name: content.name,
      modality: publicModality(content.modality ?? content.publicSurvey.modalities[0]),
      description: content.publicDescription,
      status: content.publicStatus ?? (layer ? "acquired" : "awaiting_geometry"),
      sourceUrl: content.sourceUrl ?? content.geometrySourceUrl ?? "",
      ...(content.dataOrigin ? { dataOrigin: content.dataOrigin } : {}),
      ...(content.sourceTier ? { sourceTier: content.sourceTier } : {}),
      ...(content.originNote ? { originNote: content.originNote } : {}),
      ...(content.sourceLabel ? { sourceLabel: content.sourceLabel } : {}),
      ...(content.geometrySourceUrl ? { geometrySourceUrl: content.geometrySourceUrl } : {}),
      ...(content.geometrySourceLabel ? { geometrySourceLabel: content.geometrySourceLabel } : {}),
      ...(layer ? { coverage: { layerId: layer.layerId, availableOrders: layer.availableOrders, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder } } : {}),
    };
    const survey = surveys.find((candidate) => candidate.id === content.surveyId);
    if (!survey) {
      surveys.push({
        id: content.surveyId,
        name: content.publicSurvey.name,
        mission: content.publicSurvey.mission,
        color: content.publicSurvey.color,
        description: content.publicSurvey.description,
        modalities: content.publicSurvey.modalities.map(publicModality),
        releases: [{ id: content.releaseId, label: content.publicRelease.label, kind: content.publicRelease.kind, ...(content.publicRelease.releasedYear !== undefined ? { releasedYear: content.publicRelease.releasedYear } : {}), modalities: [product.modality], products: [product] }],
        imageUrl: "",
        statistics: { publicProducts: 1, acquired: product.status === "acquired" ? 1 : 0, overviewOnly: product.status === "overview_only" ? 1 : 0, awaitingGeometry: product.status === "awaiting_geometry" ? 1 : 0, notApplicable: product.status === "not_applicable" ? 1 : 0, footprintCells: new Set(runtimeCoverageManifest.footprints.filter((footprint) => footprint.surveyId === content.surveyId).flatMap((footprint) => footprint.pixels)).size },
        assets: allAssets.filter((asset) => asset.surveyId === content.surveyId),
      });
      continue;
    }
    const release = survey.releases.find((candidate) => candidate.id === content.releaseId);
    if (release) {
      release.products.push(product);
      if (!release.modalities.includes(product.modality)) release.modalities.push(product.modality);
    } else {
      survey.releases.push({ id: content.releaseId, label: content.publicRelease.label, kind: content.publicRelease.kind, ...(content.publicRelease.releasedYear !== undefined ? { releasedYear: content.publicRelease.releasedYear } : {}), modalities: [product.modality], products: [product] });
    }
    if (!survey.modalities.includes(product.modality)) survey.modalities.push(product.modality);
    survey.assets = allAssets.filter((asset) => asset.surveyId === survey.id);
  }
  const orderSummary = (layers: typeof coverageCatalog.layers) => {
    if (!layers.length) return undefined;
    const availableOrders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((a, b) => a - b);
    const overviewOrders = [...new Set(layers.map((layer) => layer.overviewOrder))].sort((a, b) => a - b);
    return { availableOrders, overviewOrders, maxOrder: Math.max(...layers.map((layer) => layer.maxOrder)) };
  };
  return {
    ...index,
    surveys: surveys.map((survey) => {
      const surveyLayers = coverageCatalog.layers.filter((layer) => layer.surveyId === survey.id && !isRetiredLayer(layer));
      const productsForSurvey = survey.releases.flatMap((release) => release.products);
      return {
        ...survey,
        coverageOrders: orderSummary(surveyLayers) ?? survey.coverageOrders,
        releases: survey.releases.map((release) => ({ ...release, coverageOrders: orderSummary(surveyLayers.filter((layer) => layer.releaseId === release.id)) ?? release.coverageOrders })),
        statistics: { publicProducts: productsForSurvey.length, acquired: productsForSurvey.filter((product) => product.status === "acquired").length, overviewOnly: productsForSurvey.filter((product) => product.status === "overview_only").length, awaitingGeometry: productsForSurvey.filter((product) => product.status === "awaiting_geometry").length, notApplicable: productsForSurvey.filter((product) => product.status === "not_applicable").length, footprintCells: new Set(runtimeCoverageManifest.footprints.filter((footprint) => footprint.surveyId === survey.id).flatMap((footprint) => footprint.pixels)).size },
        assets: allAssets.filter((asset) => asset.surveyId === survey.id),
      };
    }),
  };
}

function adminSurveyIndex(): Awaited<ReturnType<typeof loadSurveyIndex>> {
  return editorial.applyPublished(adminInventoryIndex(runtimeSurveyIndex, products.list()));
}

function publicSurveyIndex(): Awaited<ReturnType<typeof loadSurveyIndex>> {
  return publicState.index;
}

function isRetiredLayer(layer: Pick<CoverageCellLayer, "layerId" | "surveyId" | "releaseId" | "product">): boolean {
  return products.list().some((record) => Boolean(record.retiredAt)
    && (record.draft.layerId === layer.layerId
      || (record.draft.surveyId === layer.surveyId && record.draft.releaseId === layer.releaseId && record.draft.name === layer.product)));
}

function publicCoverageCatalog(): typeof coverageCatalog { return publicState.coverage; }

function isRetiredFootprint(footprint: { surveyId: string; releaseId: string; product: string }): boolean {
  return products.list().some((record) => Boolean(record.retiredAt)
    && record.draft.surveyId === footprint.surveyId
    && record.draft.releaseId === footprint.releaseId
    && record.draft.name === footprint.product);
}

function fullyRetiredSurveyIds(): Set<string> {
  const bySurvey = new Map<string, ProductRecord[]>();
  for (const product of products.list()) {
    const records = bySurvey.get(product.draft.surveyId) ?? [];
    records.push(product);
    bySurvey.set(product.draft.surveyId, records);
  }
  return new Set([...bySurvey.entries()]
    .filter(([, records]) => records.length > 0 && records.every((record) => Boolean(record.retiredAt)))
    .map(([surveyId]) => surveyId));
}

function isRetiredAsset(record: PublicAssetRecord): boolean {
  return !approvedRelease.assetIds.includes(record.id);
}

function publicAssetCatalog(): LoadedCatalog { return publicState.catalog; }

function editorialApiContent(content: SurveyEditorialContent | null): SurveyEditorialContent | null {
  if (!content) return null;
  return {
    ...content,
    releases: content.releases.map((release) => ({
      ...release,
      products: release.products.map((product) => ({
        ...product,
        reason: product.reason ?? "",
        manualStep: product.manualStep ?? "",
      })),
    })),
  };
}

function editorialApiRecord(record: SurveyEditorialRecord): SurveyEditorialRecord {
  return { ...record, draft: editorialApiContent(record.draft)!, published: editorialApiContent(record.published) };
}
if (managesContent) {
  if (role === "legacy") await refreshDynamicResourcePackages();
  else registerDynamicPackageAssets();
  runtimeSurveyIndex = applyPublishedProductMetadata(runtimeSurveyIndex);
  await editorial.initialize(adminInventoryIndex(runtimeSurveyIndex, products.list()).surveys);
}
function independentLoop(name: string, interval: number, work: () => Promise<void>): void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void work().catch(error => console.error(`${name} deferred:`, error instanceof Error ? error.message : String(error))).finally(() => { busy = false; });
  }, interval);
  timer.unref();
}
if (publicationScheduler) {
  independentLoop("publication", 1000, () => publicationScheduler.tick());
  independentLoop("publication-checkpoint", 5000, () => publicationScheduler.snapshot());
  independentLoop("site-verification", 5000, async () => {
    for (const task of publicationScheduler.tasks.list().filter(task => task.phase === "site-pending")) {
      if (nativeUnits?.matches(task.payload)) await nativeUnits.verifyPending(task);
      else await publisher.verifySite(task.id, await publicationScheduler.siteExpectation(task.id));
    }
  });
  if (snapshotWorker) independentLoop("state-snapshots", 5000, async () => {
    const { spool, snapshots } = snapshotWorker!;
    const uploaded = await spool.processPending({ maxUploads: 1 });
    await snapshots.reconcileUploaded(uploaded.uploadedManifests);
    await spool.markReconciled(uploaded.uploadedManifests.map(manifest => manifest.uploadId));
    await spool.cleanupUploaded();
  });
}
function requestNativeGroup(): NativeGroup | undefined { const context = requestRelease.getStore(); return context ? context.nativeGroup : nativeUnits?.active; }
function requestNativeVersion(): string { return requestRelease.getStore()?.nativeVersion ?? nativeUnits?.version ?? "imported-baseline"; }
function nativeRuntime(): NativeRuntime {
  const version = requestNativeVersion();
  let runtime = nativeRuntimes.get(version);
  if (!runtime) { runtime = { version, group: requestNativeGroup(), references: 0, state: "initializing" }; nativeRuntimes.set(version, runtime); }
  return runtime;
}
async function closeNativeRuntime(runtime: NativeRuntime): Promise<void> {
  if (runtime.retire) clearTimeout(runtime.retire);
  await Promise.allSettled([runtime.worker?.then(store => store.terminate()), runtime.fallback?.then(store => store.close()), runtime.hst?.then(index => index?.close()), runtime.survey?.then(index => index?.close())]);
}
function retireNativeRuntime(runtime: NativeRuntime): void {
  if (runtime.version === (nativeUnits?.version ?? "imported-baseline") || runtime.references || runtime.retire) return;
  runtime.retire = setTimeout(() => {
    runtime.retire = undefined;
    if (runtime.references || runtime.version === (nativeUnits?.version ?? "imported-baseline")) return;
    nativeRuntimes.delete(runtime.version); void closeNativeRuntime(runtime);
  }, 60_000);
  runtime.retire.unref();
}
const HST_IMAGE_LOOKUP_MAX_OBSERVATIONS = 256;
function hstObservationIndex(): Promise<HstObservationIndex | undefined> {
  const runtime = nativeRuntime();
  if (!runtime.hst) runtime.hst = (async () => {
    const group = runtime.group;
    if (group) {
      if (!group.hst) return undefined;
      runtime.capturedAt = group.snapshots["hst-public-images"]?.capturedAt;
      return HstObservationIndex.open(group.hst.root ? nativeEvidencePath(sourceUnitEvidenceRoot, group.hst.root) : sourceUnitEvidenceRoot, group.hst.sourceSha256);
    }
    const lock = JSON.parse(await readFile(path.join(productCatalogRoot, "src/layers/recipes/hst-public-image-observations.lock.json"), "utf8")) as { status?: string; capturedAt?: string; manifest?: { sha256?: string } };
    if (lock.status !== "ready" || !lock.manifest?.sha256) return undefined;
    runtime.capturedAt = lock.capturedAt;
    return HstObservationIndex.open(sourceUnitEvidenceRoot, lock.manifest.sha256);
  })().catch(error => { console.warn(`Locked local HST observation index is unavailable: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
  return runtime.hst;
}
function eroTargetIndex(): Promise<EroTargetIndex | undefined> {
  const runtime = nativeRuntime();
  if (!runtime.ero) runtime.ero = (async () => {
    const snapshot = runtime.group?.snapshots["euclid-ero-targets"];
    const file = snapshot?.files[0];
    if (!file) return undefined;
    return parseEroTargetSnapshot(await readFile(nativeEvidencePath(sourceUnitEvidenceRoot, file.ref), "utf8"), file.sha256);
  })().catch(error => { console.warn(`Locked ERO target metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
  return runtime.ero;
}
function nativeBindingEnabled(layerId: string): boolean {
  const group = requestNativeGroup();
  return !group || group.bindings.some(binding => binding.layerId === layerId) && !group.report.unavailableBindings?.includes(layerId);
}

function surveyNativeIndex(): Promise<SurveyNativeIndex | undefined> {
  const runtime = nativeRuntime();
  if (!runtime.survey) runtime.survey = Promise.resolve().then(() => {
    const index = runtime.group?.survey;
    return index ? SurveyNativeIndex.open(nativeEvidencePath(sourceUnitEvidenceRoot, index.file.ref), index.buildKey) : undefined;
  }).catch(error => { console.warn(`Locked survey native index is unavailable: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
  return runtime.survey;
}

function nativeReadOptions(group: NativeGroup | null = nativeUnits?.active ?? null): SourceUnitLoadOptions {
  if (group) {
    if (!group.generic) throw new Error("Active native index has no generic database");
    return { readOnly: true, indexPath: nativeEvidencePath(sourceUnitEvidenceRoot, group.generic.file.ref), buildKey: group.generic.buildKey, lockText: group.lockText, recipes: group.recipes };
  }
  // Preserve the installed historical baseline while it passes managed adoption.
  // Module-byte changes never trigger a query-time cold build.
  const indexPath = path.join(sourceUnitEvidenceRoot, "derived/source-unit-indexes/native-units.sqlite");
  return { readOnly: true, indexPath, buildKey: nativeDatabaseKey(indexPath) };
}

async function verifyNativeRuntime(group: NativeGroup): Promise<void> {
  const store = await SourceUnitStore.load(productCatalogRoot, sourceUnitEvidenceRoot, nativeReadOptions(group));
  try {
    if (group.hst) {
      const index = await HstObservationIndex.open(group.hst.root ? nativeEvidencePath(sourceUnitEvidenceRoot, group.hst.root) : sourceUnitEvidenceRoot, group.hst.sourceSha256);
      index.close();
    }
    if (group.survey) {
      const index = SurveyNativeIndex.open(nativeEvidencePath(sourceUnitEvidenceRoot, group.survey.file.ref), group.survey.buildKey);
      try { verifyNativeRuntimeBindings(group.bindings, store, index); }
      finally { index.close(); }
    }
  } finally { store.close(); }
}

async function verifyNativeSite(group: NativeGroup): Promise<void> {
  const internal = process.env.ASSETS_PUBLIC_VERIFY_INTERNAL_URL?.trim();
  const base = new URL(internal || process.env.ASSETS_PUBLIC_VERIFY_URL!.trim());
  if (base.username || base.password || !["http:", "https:"].includes(base.protocol) || !internal && base.protocol !== "https:") throw new Error("Invalid native-index site verification URL");
  const status = await fetch(new URL("/api/v1/status", base), { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!status.ok) throw new Error(`Native index site status returned HTTP ${status.status}`);
  const body = await status.json() as { nativeIndex?: { version?: string }; services?: Array<{ id: string; status: string }> };
  if (body.nativeIndex?.version !== group.id || !body.services?.some(service => service.id === "reverse-lookup" && service.status === "available")) throw new Error("Site has not confirmed the active native-index query runtime");
  const sample = group.report.samples.find(sample => sample.cells.length > 0);
  if (!sample) throw new Error("Native site verification requires a real saved lookup sample");
  const lookup = await fetch(new URL("/api/v1/coverage/reverse-lookup", base), { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json" }, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ layerIds: [sample.layerId], order: sample.order, cells: sample.cells.slice(0, 4), preview: true }) });
  if (!lookup.ok) throw new Error(`Native site lookup returned HTTP ${lookup.status}`);
  const result = await lookup.json() as { downloadPlan?: { spatialUnits?: Array<{ layerId: string; unitKind: string; unitId: string }> } };
  if (!result.downloadPlan?.spatialUnits?.some(unit => unit.layerId === sample.layerId && unit.unitKind === sample.unitKind && unit.unitId)) throw new Error("Site lookup did not return native identities from the reviewed product binding");
}

async function nativeProductBindings(): Promise<NativeBinding[]> {
  await sourceUnitCoverageReady();
  const store = await sourceUnitsStore();
  const bindings: NativeBinding[] = [];
  for (const layer of currentPublicState.coverage.records.values()) {
    const survey = surveyNativeBinding(layer);
    if (!survey && !["legacy-surveys", "decals", "desi", "euclid", "hst", "hsc-ssp", "vista", "skymapper", "2mass"].includes(layer.surveyId) || isWarehouseFilePartitionLayer(layer)) continue;
    const match = survey || layer.surveyId === "hst" || layer.surveyId === "euclid" && layer.releaseId === "euclid-ero" ? undefined : await store.match(layer.layerId, 4, [], 1, layer);
    if (!survey && !match && layer.surveyId !== "hst" && !(layer.surveyId === "euclid" && layer.releaseId === "euclid-ero")) continue;
    const record = products.list().find(record => record.productId === layer.productId || record.draft.surveyId === layer.surveyId && record.draft.releaseId === layer.releaseId && record.draft.name === layer.product);
    const binding: NativeBinding = { productId: record?.productId ?? layer.productId ?? layer.layerId, layerId: layer.layerId, surveyId: layer.surveyId, releaseId: layer.releaseId, product: layer.product, modality: layer.modality, unitKind: match?.unitKind ?? (layer.surveyId === "hst" ? "observation" : "target"), sourceIds: sourceIdsForBinding(layer), revision: "", visibility: record?.published ? "published" : "imported-overview", ...(survey ?? {}), ...(layer.surveyId === "hst" ? { instrument: layer.sourceEvidence?.instrument, filters: layer.sourceEvidence?.filters, observationId: layer.sourceEvidence?.sourceIdentity?.match(/\bobsid\s+(\d+)/i)?.[1] } : {}) };
    bindings.push(binding);
  }
  return bindings;
}

async function reloadNativeRuntime(): Promise<void> {
  await requestRelease.exit(async () => {
    sourceUnitCoverageLoadPromise = null; sourceUnitCoverageLayers = [];
    // Rebuild from the approved public release so removed bindings cannot survive.
    currentPublicState = await loadPublicState(currentCatalog, productCatalogRoot, currentPublicState);
    await reloadRuntimeCoverage();
    await sourceUnitCoverageReady();
    await Promise.all([hstObservationIndex(), eroTargetIndex(), surveyNativeIndex()]);
  });
  for (const runtime of nativeRuntimes.values()) retireNativeRuntime(runtime);
}
function sourceUnitsStore(): Promise<SourceUnitWorkerStore> {
  const runtime = nativeRuntime();
  if (!runtime.worker) runtime.worker = Promise.resolve().then(() => SourceUnitWorkerStore.load(productCatalogRoot, sourceUnitEvidenceRoot, nativeReadOptions(runtime.group ?? null))).then(store => {
    runtime.state = "available"; return store;
  }).catch(error => { runtime.state = "unavailable"; throw error; });
  return runtime.worker;
}
function sourceUnitsFallbackStore(): Promise<SourceUnitStore> {
  const runtime = nativeRuntime();
  if (!runtime.fallback) runtime.fallback = Promise.resolve().then(() => SourceUnitStore.load(productCatalogRoot, sourceUnitEvidenceRoot, nativeReadOptions(runtime.group ?? null))).then(store => {
    runtime.state = "available"; return store;
  }).catch(error => { runtime.state = "unavailable"; throw error; });
  return runtime.fallback;
}

async function sourceUnitsReadyWithin(timeoutMs: number): Promise<SourceUnitWorkerStore | SourceUnitStore | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  try {
    try {
      const worker = await Promise.race([sourceUnitsStore(), timeout]);
      return worker;
    } catch {
      return await sourceUnitsFallbackStore();
    }
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

function sourceUnitCoverageReady(): Promise<void> {
  const hasApprovedProducts = [...currentPublicState.records.values()].some((record) => record.published && !record.retiredAt);
  if (!hasApprovedProducts) return Promise.resolve();
  if (!sourceUnitCoverageLoadPromise) {
    const version = nativeUnits?.version ?? "imported-baseline";
    sourceUnitCoverageLoadPromise = requestRelease.exit(() => sourceUnitsStore().catch(() => sourceUnitsFallbackStore()).then(async (store) => {
      if (version !== (nativeUnits?.version ?? "imported-baseline")) return;
      const declaredProducts = new Set(runtimeSurveyIndex.surveys.flatMap((survey) => survey.releases.flatMap((release) => (
        release.products.map((product) => `${survey.id}\u0000${release.id}\u0000${product.name}`)
      ))));
      sourceUnitCoverageLayers = store.coverageLayers()
        .filter((layer) => declaredProducts.has(sourceUnitProductIdentity(layer)))
        .filter(layer => !nativeUnits?.active || nativeUnits.active.bindings.some(binding => sourceUnitProductIdentity(binding) === sourceUnitProductIdentity(layer) && (binding.visibility === "imported-overview" || [...currentPublicState.records.values()].some(record => record.published && !record.retiredAt && record.published.surveyId === binding.surveyId && record.published.releaseId === binding.releaseId && record.published.name === binding.product))))
        .map(sourceUnitCoverageRecord);
      coverageCatalog = mergeSourceUnitCoverage(coverageCatalog);
      runtimeCoverageManifest = mergeSourceUnitFootprints(runtimeCoverageManifest, coverageCatalog.records);
      runtimeSurveyIndex = await loadSurveyIndex(productCatalogRoot, catalog, runtimeCoverageManifest, coverageCatalog.layers, [...publishedPublicAssets.values()].map(({ record }) => record));
      runtimeSurveyIndex = applyPublishedProductMetadata(runtimeSurveyIndex);
      currentPublicState = mergeSourceUnitPublicState(currentPublicState, runtimeSurveyIndex, sourceUnitCoverageLayers);
      if (nativeUnits?.active) for (const binding of nativeUnits.active.bindings) {
        const layer = currentPublicState.coverage.records.get(binding.layerId);
        if (layer) layer.nativeUnitIndexRevision = binding.revision;
      }
      const [hst, ero, survey] = await Promise.all([hstObservationIndex(), eroTargetIndex(), surveyNativeIndex()]);
      if (version !== (nativeUnits?.version ?? "imported-baseline")) return;
      for (const layer of currentPublicState.coverage.records.values()) {
        if (isWarehouseFilePartitionLayer(layer) || !["legacy-surveys", "decals", "desi", "euclid", "hst", "hsc-ssp", "gaia", "sdss", "galex", "jwst", "vista", "skymapper", "2mass", "des", "fds", "kids", "allwise", "spherex", "vphas", "cfhtls", "act", "decaps", "panstarrs", "nvss", "sumss", "wenss"].includes(layer.surveyId)) continue;
        const binding = nativeUnits?.active?.bindings.find(binding => binding.layerId === layer.layerId);
        const unavailableBinding = nativeUnits?.active?.report.unavailableBindings?.includes(layer.layerId);
        const enabled = (!nativeUnits?.active || Boolean(binding)) && !unavailableBinding;
        const available = enabled && (layer.surveyId === "hst" ? Boolean(hst)
          : layer.surveyId === "euclid" && layer.releaseId === "euclid-ero" ? Boolean(ero)
          : nativeBindingIndexRoute(binding ?? layer) === "survey" ? Boolean(binding && survey?.hasBinding(binding)) : Boolean(await store.match(layer.layerId, 4, [], 1, layer)));
        const surveyScope = binding && nativeBindingIndexRoute(binding) === "survey" ? survey?.summaries.find(source => binding.sourceIds.includes(source.sourceId))?.scope : undefined;
        const sourceUnitIndex: NonNullable<CoverageCellLayer["sourceUnitIndex"]> = available
          ? { ...layer.sourceUnitIndex, status: "estimated", unitKind: binding?.unitKind ?? (layer.surveyId === "hst" ? "observation" : layer.surveyId === "euclid" && layer.releaseId === "euclid-ero" ? "target" : layer.sourceUnitIndex?.unitKind), indexUrl: "/api/v1/coverage/reverse-lookup", notes: surveyScope ?? layer.sourceUnitIndex?.notes ?? "The installed local native-unit mapping is available; candidate precision and inventory scope apply." }
          : { ...layer.sourceUnitIndex, status: "entrypoint-only", notes: unavailableBinding ? "This published source identity has no matching observation in the active locked metadata snapshot; its coverage and official entrypoint remain visible." : enabled ? "The local native-unit mapping is unavailable for this product; coverage and official source identities remain visible." : "This product is absent from the active reviewed native-index binding set." };
        updateCoverageNativeUnitState(currentPublicState.coverage, layer.layerId, sourceUnitIndex, binding?.revision);
      }
      console.info(`Native source-unit indexes are ready; ${sourceUnitCoverageLayers.length} approved source-derived coverage layers are available.`);
    }).catch((error) => {
      if (version === (nativeUnits?.version ?? "imported-baseline")) sourceUnitCoverageLoadPromise = null;
      throw error;
    }));
  }
  return sourceUnitCoverageLoadPromise;
}

async function awaitNativeSourceUnitCoverageLoad(): Promise<void> {
  await sourceUnitCoverageLoadPromise?.catch(() => undefined);
}

if (role !== "site") {
  void sourceUnitCoverageReady().catch((error) => {
    console.warn(`Native source-unit indexes could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function productCoverage(record: ProductRecord): Record<string, unknown> | undefined {
  const layer = productCoverageLayer(record);
  if (!layer) return undefined;
  return { layerId: layer.layerId, availableOrders: layer.availableOrders, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder, coverageRole: layer.coverageRole, areaDeg2: layer.areaDeg2 };
}

function productCoverageLayer(record: ProductRecord, build?: ReturnType<MocBuildStore["get"]>, content = record.published ?? record.draft): CoverageCellLayer | undefined {
  if (content === record.published && content.layerId) return publicState?.coverage.records.get(content.layerId);
  const direct = content.layerId ? coverageCatalog.records.get(content.layerId) : undefined;
  if (direct) return direct;
  const matches = [...coverageCatalog.records.values()].filter((candidate) => candidate.surveyId === content.surveyId
    && candidate.releaseId === content.releaseId
    && candidate.product === content.name);
  if (build?.publicationId) {
    const publication = mocPublicationStore.forBuild(build.name);
    const publishedLayer = publication ? coverageCatalog.records.get(publication.layerId) : undefined;
    if (publishedLayer) return publishedLayer;
  }
  return matches.find((candidate) => candidate.layerId.startsWith("moc-")) ?? matches[0];
}

function readinessLayer(layer: CoverageCellLayer | undefined): ReadinessLayer | undefined {
  if (!layer) return undefined;
  const snapshot = warehouseLayerSnapshots.get(layer.layerId);
  const hasPublicSnapshot = snapshot && "surveyId" in snapshot && "releaseId" in snapshot && "productId" in snapshot;
  const warehouseFileIndex = hasPublicSnapshot ? warehouseFileIndexSummary(layer.layerId) : undefined;
  return {
    availableOrders: layer.availableOrders,
    overviewOrder: layer.overviewOrder,
    maxOrder: layer.maxOrder,
    cellCount: layer.cellCount,
    ...(layer.recipe ? { recipe: {
      mode: layer.recipe.mode,
      coordinateFrame: layer.recipe.coordinateFrame,
      ordering: layer.recipe.ordering,
      precision: layer.recipe.precision,
      sourceSnapshotSha256: layer.recipe.sourceSnapshotSha256,
    } } : {}),
    ...(layer.sourceUnitIndex ? { sourceUnitIndex: {
      status: layer.sourceUnitIndex.status,
      unitKind: layer.sourceUnitIndex.unitKind,
      notes: layer.sourceUnitIndex.notes,
    } } : {}),
    ...(warehouseFileIndex ? { warehouseFileIndex: { status: warehouseFileIndex.status } } : {}),
    ...(snapshot ? {
      fileCount: snapshot.fileCount,
      coverageCount: snapshot.coverageCount,
      errorCount: snapshot.errorCount,
      updatedAt: snapshot.updatedAt,
    } : {}),
  };
}

function readinessLayerFromBuild(build: ReturnType<MocBuildStore["get"]> | undefined): ReadinessLayer | undefined {
  const outputs = build?.outputs;
  const orders = outputs?.availableOrders?.filter((order): order is number => Number.isSafeInteger(order) && order >= 0) ?? [];
  if (!outputs || !orders.length || !["STAGED", "PUBLISHED", "DUPLICATE"].includes(build?.phase ?? "")) return undefined;
  const overviewOrder = Math.min(...orders);
  const product = build?.productId ? products.list().find((record) => record.productId === build.productId) : undefined;
  const pathIndex = build?.provider === "evidence" && product?.draft.mode === "path-healpix"
    && product.draft.coverageEvidence?.precision === "exact"
    && product.draft.coverageEvidence?.completeness === "incomplete"
    && build.source.sourceEvidence?.sourceSnapshotSha256 === product.draft.coverageEvidence.sourceSnapshotSha256;
  return {
    availableOrders: [...new Set(orders)].sort((a, b) => a - b),
    overviewOrder,
    maxOrder: outputs.maxOrder ?? Math.max(...orders),
    ...(outputs.cellCount !== undefined ? { cellCount: outputs.cellCount } : {}),
    recipe: { mode: pathIndex ? "path-healpix" : "native-moc", coordinateFrame: "ICRS", ordering: "NESTED", ...(pathIndex ? { precision: "exact" as const } : {}), sourceSnapshotSha256: build?.source.snapshotSha256 },
    sourceUnitIndex: pathIndex
      ? { status: "exact", unitKind: "file", notes: "已校验 DESI order-6 路径分区 URI 与已提交 Warehouse 文件索引。" }
      : { status: "entrypoint-only", notes: "已锁定 MOC 构建输出；尚未生成单元到文件反查索引。" },
    ...(pathIndex && outputs.cellCount !== undefined ? { fileCount: outputs.cellCount, coverageCount: outputs.cellCount, errorCount: 0 } : {}),
  };
}

function productReadinessForContent(record: ProductRecord, content: ProductRecord["draft"] | NonNullable<ProductRecord["published"]>, build?: ReturnType<MocBuildStore["get"]>): ProductReadiness {
  const layer = productCoverageLayer(record, build, content);
  const warehouseStatus = content.layerId ? warehouseLayerSnapshots.get(content.layerId) : undefined;
  const revision = content === record.draft ? record.revision : record.publishedRevision;
  const executions = revision === null || revision === undefined ? [] : (record.executions ?? []).filter((entry) => entry.revision === revision);
  const executionEvidence = executions.length ? {
    executionRecorded: executions.some((entry) => entry.status === "passed"),
    outputValidated: executions.some((entry) => entry.status === "passed" && entry.checks.some((check) => check.status === "passed" && /output|hash|integrity/i.test(check.id))),
    isolatedRestoreValidated: executions.some((entry) => entry.status === "passed" && entry.checks.some((check) => check.status === "passed" && /isolated|restore/i.test(check.id))),
  } : undefined;
  const latestVerification = executions.filter((entry) => entry.stepId === "verify-moc-build").at(-1);
  if (executionEvidence && latestVerification) executionEvidence.outputValidated = latestVerification.status === "passed";
  return deriveProductReadiness({
    content: {
      productId: content.productId,
      surveyId: content.surveyId,
      releaseId: content.releaseId,
      name: content.name,
      mode: content.mode,
      sourceTier: content.sourceTier,
      sourceUrl: content.sourceUrl,
      sourceLabel: content.sourceLabel,
      geometrySourceUrl: content.geometrySourceUrl,
      geometrySourceLabel: content.geometrySourceLabel,
      recipeHash: content.recipeHash,
      coverageCompleteness: content.coverageEvidence?.completeness,
    },
    layer: readinessLayer(layer) ?? readinessLayerFromBuild(build),
    ...(warehouseStatus ? { completeness: {
      state: warehouseStatus.errorCount > 0 ? "partial" as const : "unknown" as const,
      fileCount: warehouseStatus.fileCount,
      coverageCount: warehouseStatus.coverageCount,
      errorCount: warehouseStatus.errorCount,
      ...(warehouseStatus.updatedAt ? { asOf: warehouseStatus.updatedAt } : {}),
      scope: "current Warehouse layer metadata; unpublished geometry is not loaded",
    } } : {}),
    ...(build ? { build: {
      phase: build.phase,
      source: { snapshotSha256: build.source.snapshotSha256 },
      ...(build.outputs ? { outputs: { availableOrders: build.outputs.availableOrders, maxOrder: build.outputs.maxOrder } } : {}),
      ...(build.publicationId ? { publicationId: build.publicationId } : {}),
    } } : {}),
    ...(executionEvidence ? { evidence: executionEvidence } : {}),
  });
}

function productReadiness(record: ProductRecord): { draft: ProductReadiness; published: ProductReadiness | null } {
  const summary = adminMocBuildSummary(record.productId);
  const build = summary ? mocBuildStore.get(String(summary.name)) : undefined;
  return {
    draft: productReadinessForContent(record, record.draft, build),
    published: record.published ? productReadinessForContent(record, record.published, build) : null,
  };
}

function currentReadiness(record: ProductRecord): ProductReadiness {
  const summary = productReadiness(record);
  return summary.published ?? summary.draft;
}

function readinessSummaryForRecords(records: readonly ProductRecord[]): { draft: ReadinessAggregate; published: ReadinessAggregate } {
  const versions = records.map((record) => productReadiness(record));
  return {
    draft: aggregateReadiness(versions.map((version) => version.draft)),
    published: aggregateReadiness(versions.flatMap((version) => version.published ? [version.published] : [])),
  };
}

const NON_ACCEPTABLE_PUBLICATION_GAPS = new Set([
  "source-not-traceable",
  "validated-coverage-missing",
  "coverage-query-unavailable",
  "output-validation-missing",
]);

async function productNativeOrderPreflight(record: ProductRecord): Promise<{ minimum: number; state: "passed" | "blocked"; maxOrder?: number; message: string }> {
  let maxOrder: number | undefined;
  let error: string | undefined;
  try {
    // Read staged bytes without preparing/publishing a candidate or mutating the build.
    const staged = mocBuildStore.list().find(build => build.productId === record.productId && build.phase === "STAGED");
    if (staged?.outputs?.moc) {
      const file = staged.outputs.moc;
      const bytes = await readFile(path.resolve(evidenceRoot, file.ref));
      if (nativeSha256(bytes) !== file.sha256) throw new Error("MOC 校验和不一致，请重新校验构建输出。");
      maxOrder = decodeNativeMoc(bytes).maxOrder;
      assertPublicCoverageOrder(maxOrder);
    } else {
      const material = await productGeometry(record, { root: catalog.root, files: catalog.manifest.files,
        publications: mocPublicationStore.list(), publicationFile: file => mocPublicationStore.absolutePath(file) });
      if (!material) throw new Error("尚无可验证的原生 MOC，请先构建并校验覆盖。非预览阶数检查。");
      maxOrder = material.moc.maxOrder;
    }
  } catch (failure) { error = failure instanceof Error ? failure.message : "原生覆盖精度检查失败"; }
  return {
    minimum: MIN_PUBLIC_COVERAGE_ORDER,
    state: error ? "blocked" : "passed",
    ...(maxOrder !== undefined ? { maxOrder } : {}),
    message: error ?? `真实原生最高阶数 O${maxOrder} ≥ O${MIN_PUBLIC_COVERAGE_ORDER}（已读取并校验 MOC）`,
  };
}

function hasCurrentProductReview(record: ProductRecord): boolean {
  return record.review?.revision === record.revision && record.review.contentSha256 === record.contentSha256;
}

function assertReviewableProduct(record: ProductRecord, acceptedGaps: readonly string[]): void {
  const readiness = productReadiness(record).draft;
  const unknown = acceptedGaps.filter((gap) => !readiness.gaps.includes(gap));
  if (unknown.length) throw new AdminHttpError(400, `acceptedGaps contains gaps not present in the current revision: ${unknown.join(", ")}`);
  const blocked = readiness.gaps.filter((gap) => NON_ACCEPTABLE_PUBLICATION_GAPS.has(gap));
  if (blocked.length) throw new AdminHttpError(409, `Product cannot be reviewed for publication until evidence is fixed: ${blocked.join(", ")}`);
}

function assertPublishableProduct(record: ProductRecord): void {
  const review = record.review;
  if (!review || review.revision !== record.revision || review.contentSha256 !== record.contentSha256) {
    throw new AdminHttpError(409, "Product revision must be reviewed before publication");
  }
  const readiness = productReadiness(record).draft;
  const blocked = readiness.gaps.filter((gap) => NON_ACCEPTABLE_PUBLICATION_GAPS.has(gap));
  if (blocked.length) throw new AdminHttpError(409, `Product publication is blocked by missing evidence: ${blocked.join(", ")}`);
  const accepted = new Set(review.acceptedGaps);
  const unaccepted = readiness.gaps.filter((gap) => !accepted.has(gap));
  if (unaccepted.length) throw new AdminHttpError(409, `Product publication requires explicit acceptance of evidence gaps: ${unaccepted.join(", ")}`);
}

function adminMocBuildSummaryForBuild(build: ReturnType<MocBuildStore["get"]>): Record<string, unknown> {
  const outputs = build.outputs;
  const productRecord = build.productId ? products.list().find((record) => record.productId === build.productId) : undefined;
  return {
    name: build.name,
    discoveryRequestName: build.discoveryRequestName,
    candidateId: build.candidateId,
    ...(build.candidateTitle ? { candidateTitle: build.candidateTitle } : {}),
    ...(build.surveyId ? { surveyId: build.surveyId } : {}),
    ...(build.releaseId ? { releaseId: build.releaseId } : {}),
    ...(build.productId ? { productId: build.productId } : {}),
    sourceUrl: build.source.url,
    phase: build.phase,
    progress: build.progress,
    createdAt: build.createdAt,
    updatedAt: build.updatedAt,
    ...(outputs ? {
      outputs: {
        ...(outputs.cellCount !== undefined ? { cellCount: outputs.cellCount } : {}),
        ...(outputs.availableOrders ? { availableOrders: outputs.availableOrders } : {}),
        ...(outputs.maxOrder !== undefined ? { maxOrder: outputs.maxOrder } : {}),
      },
    } : {}),
    ...(build.error ? { error: build.error } : {}),
    ...(build.publishedAt ? { publishedAt: build.publishedAt } : {}),
    ...(build.publicationId ? { publicationId: build.publicationId } : {}),
    ...(productRecord ? { lifecycle: adminProductLifecycle(productRecord, build) } : {}),
  };
}

function adminProductLifecycle(record: ProductRecord, build?: ReturnType<MocBuildStore["get"]>): Record<string, unknown> {
  const layer = productCoverageLayer(record, build);
  const published = Boolean(record.published);
  const hasPublication = Boolean(build?.publicationId);
  const retired = Boolean(record.retiredAt);
  const runtimeState = retired
    ? "INACTIVE"
    : hasPublication
      ? layer ? "ACTIVE" : "INVALID"
      : layer ? "CATALOG_BASELINE" : "INACTIVE";
  return {
    publication: {
      state: retired ? "RETIRED" : published ? "PUBLISHED" : "DRAFT",
      ...(retired ? { withdrawalState: publicState.records.has(record.productId) ? "pending" : "withdrawn" } : {}),
      ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
      ...(record.retiredAt ? { retiredAt: record.retiredAt } : {}),
      ...(record.retirementReason ? { retirementReason: record.retirementReason } : {}),
      ...(build?.publicationId ? { publicationId: build.publicationId } : {}),
    },
    runtime: {
      state: runtimeState,
      ...(layer && !retired ? {
        layerId: layer.layerId,
        catalogRevision: coverageCatalog.revision,
        availableOrders: layer.availableOrders,
        overviewOrder: layer.overviewOrder,
        maxOrder: layer.maxOrder,
      } : {}),
    },
    links: {
      product: published && !retired
        ? `/api/v1/products/${encodeURIComponent(record.productId)}`
        : `/api/v1/admin/products/${encodeURIComponent(record.productId)}`,
      catalog: "/api/v1/coverage/catalog",
      ...(published && !retired && layer ? { sky: `/?survey=${encodeURIComponent(record.draft.surveyId)}&product=${encodeURIComponent(record.productId)}` } : {}),
      ...(published && !retired && layer ? { moc: `/api/v1/coverage/layers/${encodeURIComponent(layer.layerId)}/moc.fits` } : {}),
    },
  };
}

function adminMocBuildView(build: ReturnType<MocBuildStore["get"]>): Record<string, unknown> {
  const product = build.productId ? products.list().find((record) => record.productId === build.productId) : undefined;
  const source = build.provider === "evidence"
    ? {
      url: build.source.url,
      ...(build.source.snapshotSha256 ? { snapshotSha256: build.source.snapshotSha256 } : {}),
      ...(build.source.sizeBytes !== undefined ? { sizeBytes: build.source.sizeBytes } : {}),
      ...(build.source.sourceEvidence ? { sourceEvidence: build.source.sourceEvidence } : {}),
    }
    : build.source;
  const outputs = build.outputs && Object.fromEntries(Object.entries(build.outputs).map(([key, value]) => {
    if (!value || typeof value !== "object" || !("ref" in value)) return [key, value];
    const { objectKey: _objectKey, ...safeFile } = value as Record<string, unknown>;
    return [key, safeFile];
  }));
  return {
    ...build,
    source,
    ...(outputs ? { outputs } : {}),
    ...(product ? { lifecycle: adminProductLifecycle(product, build) } : {}),
  };
}

type MocRegistrationDefaultField = "releaseId" | "releaseLabel" | "releaseKind" | "productName" | "productDescription" | "productStatus" | "modality" | "dataOrigin";
type MocRegistrationDefaults = Pick<MocProductRegistrationInput, MocRegistrationDefaultField>;

async function mocSurveyFacts(build: ReturnType<MocBuildStore["get"]>) {
  const discovery = await discoveryView(build.discoveryRequestName);
  const surveyId = build.surveyId ?? discovery.surveyId ?? registrationSlug(discovery.surveyName);
  const survey = runtimeSurveyIndex.surveys.find((entry) => entry.id === surveyId || entry.name.toLowerCase() === discovery.surveyName.toLowerCase());
  const existing = products.list().find((entry) => entry.draft.surveyId === (survey?.id ?? surveyId) && entry.draft.publicSurvey)?.draft.publicSurvey;
  const palette = ["#5678ad", "#528c79", "#9670a9", "#b58049", "#518caa", "#ad6476"];
  const colorIndex = [...surveyId].reduce((sum, letter) => (sum * 31 + letter.charCodeAt(0)) >>> 0, 0) % palette.length;
  return {
    surveyId: survey?.id ?? surveyId,
    surveyName: survey?.name ?? existing?.name ?? discovery.surveyName,
    mission: survey?.mission ?? existing?.mission ?? discovery.surveyName,
    surveyDescription: survey?.description ?? existing?.description ?? `${discovery.surveyName} 的公开覆盖产品。巡天简介尚待来源核实。`,
    surveyColor: survey?.color ?? existing?.color ?? palette[colorIndex]!,
    surveyModalities: survey?.modalities ?? existing?.modalities ?? ["imaging"],
  };
}

function registrationSlug(value: string | undefined, fallback = "public"): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return normalized || fallback;
}

function inferMocModality(surveyName: string, productName: string, existing?: string): string {
  if (existing?.trim()) return existing.trim();
  const value = `${surveyName} ${productName}`.toLowerCase();
  if (/gaia|catalog|source|astrometr|quasar/.test(value)) return "catalog";
  if (/jwst|wise|2mass|vista|infrared|nircam|miri|spitzer/.test(value)) return "infrared";
  if (/galex|ultraviolet|uv\b/.test(value)) return "ultraviolet";
  if (/desi|spectr|spectrum|ifs/.test(value)) return "spectroscopy";
  return "imaging";
}

async function mocRegistrationDefaults(build: ReturnType<MocBuildStore["get"]>): Promise<{ values: MocRegistrationDefaults; sources: Partial<Record<MocRegistrationDefaultField, string>> }> {
  const discovery = await discoveryView(build.discoveryRequestName);
  const candidate = discoveryCandidate(discovery, build.candidateId);
  const surveyId = build.surveyId ?? discovery.surveyId ?? registrationSlug(discovery.surveyName);
  const survey = runtimeSurveyIndex.surveys.find((entry) => entry.id === surveyId);
  const release = survey?.releases.find((entry) => entry.id === (build.releaseId ?? discovery.releaseId ?? registrationSlug(discovery.releaseHint, "")));
  const releaseId = build.releaseId ?? discovery.releaseId ?? (discovery.releaseHint ? registrationSlug(discovery.releaseHint) : "public");
  const releaseLabel = release?.label ?? discovery.releaseHint?.trim() ?? (releaseId === "public" ? "Public MOC" : releaseId.toUpperCase());
  const productName = discovery.productHint?.trim() || candidate.candidate.title?.trim() || candidate.candidate.candidateId;
  const existingProduct = release?.products.find((entry) => entry.name === productName);
  const modality = inferMocModality(discovery.surveyName, productName, existingProduct?.modality);
  const values: MocRegistrationDefaults = {
    releaseId,
    releaseLabel,
    releaseKind: release?.kind ?? "release",
    productName,
    productDescription: `${productName} 的公开天区覆盖 MOC；来源为 ${candidate.provider === "llm" ? "经 LLM 发现并人工选择的公开来源" : "CDS MOC 服务"}，已由 Assets 校验并锁定来源哈希。`,
    productStatus: existingProduct?.status ?? "acquired",
    modality,
    dataOrigin: existingProduct?.dataOrigin ?? "observed",
  };
  return {
    values,
    sources: {
      releaseId: build.releaseId || discovery.releaseId || (discovery.releaseHint ? "discovery.releaseHint" : "fallback.public"),
      releaseLabel: release ? "public.catalog" : discovery.releaseHint ? "discovery.releaseHint" : "fallback.public",
      releaseKind: release ? "public.catalog" : "fallback.release",
      productName: discovery.productHint ? "discovery.productHint" : candidate.candidate.title ? "discovery.candidate.title" : "discovery.candidateId",
      productDescription: "assets.registration-template",
      productStatus: existingProduct ? "public.catalog" : "fallback.acquired",
      modality: existingProduct ? "public.catalog" : "assets.candidate-inference",
      dataOrigin: existingProduct ? "public.catalog" : "fallback.observed",
    },
  };
}

function adminMocBuildSummary(productId: string): Record<string, unknown> | undefined {
  const build = mocBuildStore.list().find((candidate) => candidate.productId === productId);
  return build ? adminMocBuildSummaryForBuild(build) : undefined;
}

function adminUnmatchedMocBuilds(): Array<Record<string, unknown>> {
  return mocBuildStore.list()
    .filter((build) => build.phase === "STAGED" && !build.productId && !build.publishedAt && !build.publicationId)
    .map(adminMocBuildSummaryForBuild);
}

function productAssets(record: ProductRecord): Array<{ record: PublicAssetRecord; id: string }> {
  const content = record.published ?? record.draft;
  const layer = productCoverageLayer(record);
  return [...catalog.files.entries()]
    .filter(([, entry]) => {
      const asset = entry.record;
      if (asset.surveyId !== content.surveyId) return false;
      if (asset.kind !== "package" && asset.releaseId && asset.releaseId !== content.releaseId) return false;
      if (asset.product && asset.product !== content.name) return false;
      if (layer && (asset.kind === "moc" || asset.kind === "geometry" || asset.kind === "provenance" || asset.kind === "metadata")) {
        return asset.path.includes(`/layers/${layer.layerId}/`)
          || asset.id.includes(layer.layerId)
          // Legacy W1 artifacts predate layer-directory naming. Their
          // survey/release/product identity is still unambiguous.
          || (asset.releaseId === content.releaseId && asset.product === content.name);
      }
      return asset.kind === "package" || asset.kind === "moc" || asset.kind === "geometry" || asset.kind === "provenance" || asset.kind === "metadata";
    })
    .map(([id, entry]) => ({ id, record: entry.record }));
}

function localAssetLink(kind: PublicProductLink["kind"], label: string, id: string, asset: { mediaType?: string; sizeBytes?: number; sha256?: string }): PublicProductLink {
  return {
    kind,
    label,
    url: `/api/v1/assets/${encodeURIComponent(id)}/download`,
    ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
    ...(typeof asset.sizeBytes === "number" ? { sizeBytes: asset.sizeBytes } : {}),
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
  };
}

function externalLink(kind: PublicProductLink["kind"], label: string, url: string): PublicProductLink | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const privateHost = host === "localhost" || host.endsWith(".local") || host === "::1"
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || privateHost) return undefined;
    return { kind, label, url: parsed.toString() };
  } catch { return undefined; }
}

function dedupeLinks(links: Array<PublicProductLink | undefined>): PublicProductLink[] {
  const seen = new Set<string>();
  return links.filter((link): link is PublicProductLink => Boolean(link)).filter((link) => {
    const key = `${link.kind}:${link.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function effectiveEditorialProduct(record: ProductRecord): { displayName: string; description: string; reason?: string; manualStep?: string; survey?: { name: string; mission: string; description: string }; release?: { label: string } } | undefined {
  if (publicState.records.get(record.productId) === record) return undefined;
  const content = editorial.publishedContent(record.draft.surveyId);
  if (!content) return undefined;
  const release = content.releases.find((entry) => entry.releaseId === record.draft.releaseId);
  const product = release?.products.find((entry) => entry.productId === record.productId);
  if (!release || !product) return undefined;
  return {
    displayName: product.displayName,
    description: product.description,
    ...(product.reason ? { reason: product.reason } : {}),
    ...(product.manualStep ? { manualStep: product.manualStep } : {}),
    survey: { name: content.name, mission: content.mission, description: content.description },
    release: { label: release.label },
  };
}

function effectivePublicProduct(record: ProductRecord): NonNullable<ProductRecord["published"]> {
  const content=publicState.records.get(record.productId)?.published ?? record.draft;
  return {...content,name:content.publicDisplayName??content.name};
}

function productCatalogEntry(record: ProductRecord): { status?: string; description?: string; reason?: string; manualStep?: string; sourceUrl?: string; geometrySourceUrl?: string; sourceLabel?: string; geometrySourceLabel?: string; officialDataUrl?: string; officialDataLabel?: string; officialQueryUrl?: string; officialQueryLabel?: string } | undefined {
  const content = record.published ?? record.draft;
  const survey = publicSurveyIndex().surveys.find((candidate) => candidate.id === content.surveyId);
  const release = survey?.releases.find((candidate) => candidate.id === content.releaseId);
  return release?.products.find((candidate) => candidate.productId === record.productId || candidate.name === content.name);
}

function sanitizeSummary(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  // Editorial markdown is intentionally kept as plain text in the API. Avoid
  // leaking implementation paths if an old draft contains one.
  return sanitizePublicText(text) || fallback;
}

function sanitizePublicText(value: string): string {
  return value
    .replace(/(?:^|[;\s])(input|scannerRunId|taskSnapshot|evidencePath|normalizedScan|manifestPath)=[^;\n]+/gi, " ")
    .replace(/(?:s3:\/\/|gs:\/\/|minio:\/\/|\/var\/lib\/|\/mnt\/|\/tmp\/)[^\s,;]+/gi, "[redacted path]")
    .replace(/\s{2,}/g, " ").trim();
}

function buildPublicProductDossier(record: ProductRecord): PublicProductDossier {
  // A catalog record can be useful before editorial copy is published. Build
  // the public projection from that record, while keeping draft prose and
  // internal fields out of the response.
  const product = effectivePublicProduct(record)!;
  const canonicalProduct = record.published ?? record.draft;
  const readiness = productReadiness(record).published ?? productReadiness(record).draft;
  const layer = productCoverageLayer(record);
  const assets = productAssets(record);
  const catalogEntry = productCatalogEntry(record);
  const mocAsset = assets.find((asset) => asset.record.kind === "moc" && (!layer || asset.record.path.includes(`/layers/${layer.layerId}/`) || asset.record.id.includes(layer.layerId) || (asset.record.releaseId === canonicalProduct.releaseId && asset.record.product === canonicalProduct.name)));
  const previewAsset = assets.find((asset) => asset.record.kind === "geometry" && /preview/i.test(asset.record.id));
  const packageAsset = assets.find((asset) => asset.record.kind === "package");
  const provenanceAsset = assets.find((asset) => asset.record.kind === "provenance" && (!layer || asset.record.path.includes(`/layers/${layer.layerId}/`) || asset.record.id.includes(layer.layerId)));
  const geometryAsset = (layer ? assets.find((asset) => asset.record.kind === "geometry" && asset.record.id === `layer-${layer.layerId}-preview-order4`) : undefined)
    ?? assets.find((asset) => asset.record.kind === "geometry" && !/preview|query/i.test(asset.record.id));
  const statisticsAsset = assets.find((asset) => asset.record.kind === "metadata" && /statistics/i.test(asset.record.id));
  const precision: PublicProductDossier["coverage"]["precision"] = !layer
    ? "entrypoint-only"
    : "estimated";
  const hasCoverage = Boolean(layer);
  const hasSnapshot = Boolean(layer?.recipe?.sourceSnapshotSha256);
  const status: PublicProductVerificationStatus = !hasCoverage
    ? (product.sourceUrl || catalogEntry?.sourceUrl ? "entrypoint-only" : "partial")
    : mocAsset && hasSnapshot ? "complete" : "partial";
  const summary = sanitizeSummary(product.presentation.summaryMarkdown, hasCoverage
    ? `${product.name} has a published ${precision} ICRS/NESTED coverage layer.`
    : `${product.name} has an official data entrypoint; a verified coverage layer is not published yet.`);
  const availableOrders = layer?.availableOrders ?? [];
  const cellCounts = layer ? Object.fromEntries([...layer.cells.entries()].map(([order, cells]) => [String(order), cells.length])) : {};
  const officialDataUrl = product.officialDataUrl ?? catalogEntry?.officialDataUrl;
  const officialQueryUrl = product.officialQueryUrl ?? catalogEntry?.officialQueryUrl;
  const links = dedupeLinks([
    externalLink("official-release", product.sourceLabel ?? catalogEntry?.sourceLabel ?? "Official release", product.sourceUrl ?? catalogEntry?.sourceUrl ?? ""),
    officialDataUrl ? externalLink("official-data", product.officialDataLabel ?? catalogEntry?.officialDataLabel ?? "Official data", officialDataUrl) : undefined,
    officialQueryUrl ? externalLink("official-query", product.officialQueryLabel ?? catalogEntry?.officialQueryLabel ?? "Official query", officialQueryUrl) : undefined,
    externalLink("geometry-source", product.geometrySourceLabel ?? catalogEntry?.geometrySourceLabel ?? "Coverage input", product.geometrySourceUrl ?? catalogEntry?.geometrySourceUrl ?? ""),
    mocAsset && layer && { kind: "fits-moc", label: "FITS MOC", url: `/api/v1/coverage/layers/${encodeURIComponent(layer.layerId)}/moc.fits`, ...(mocAsset.record.mediaType ? { mediaType: mocAsset.record.mediaType } : {}), ...(typeof mocAsset.record.sizeBytes === "number" ? { sizeBytes: mocAsset.record.sizeBytes } : {}), ...(mocAsset.record.sha256 ? { sha256: mocAsset.record.sha256 } : {}) },
    mocAsset && !layer ? localAssetLink("fits-moc", "FITS MOC", mocAsset.id, mocAsset.record) : undefined,
    previewAsset && localAssetLink("coverage-preview", "Coverage preview", previewAsset.id, previewAsset.record),
    geometryAsset && localAssetLink("geometry-source", "Geometry artifact", geometryAsset.id, geometryAsset.record),
    packageAsset && localAssetLink("resource-package", "Resource Package v3", packageAsset.id, packageAsset.record),
    provenanceAsset && localAssetLink("provenance", "Provenance", provenanceAsset.id, provenanceAsset.record),
  ]);
  const technicalDownloads = links.filter((link) => ["fits-moc", "coverage-preview", "geometry-source", "resource-package", "provenance"].includes(link.kind));
  const official = links.find((link) => link.kind === "official-release");
  const query = links.find((link) => link.kind === "official-query");
  const data = links.find((link) => link.kind === "official-data");
  const geometry = links.find((link) => link.kind === "geometry-source");
  const view: PublicProductLink = { kind: "coverage-preview", label: "View in sky", url: `/?survey=${encodeURIComponent(product.surveyId)}&product=${encodeURIComponent(product.productId)}`, description: "在 Atlas 天球视图中定位这个产品的公开覆盖。" };
  const checks: PublicProductDossier["verification"]["checks"] = [
    { id: "coverage", label: "Published coverage", status: hasCoverage ? "passed" : "unavailable", ...(hasCoverage ? { detail: `${availableOrders.length} HEALPix order(s) are published.` } : { detail: "Only an official entrypoint is available." }) },
    { id: "moc", label: "FITS MOC artifact", status: mocAsset ? "passed" : hasCoverage ? "warning" : "unavailable", ...(mocAsset ? { detail: "The downloadable artifact is allowlisted and hash-addressed." } : {}) },
    { id: "coordinates", label: "Coordinate frame and ordering", status: hasCoverage ? "passed" : "unavailable", ...(hasCoverage ? { detail: "ICRS / NESTED" } : {}) },
    { id: "source-snapshot", label: "Input snapshot hash", status: layer?.recipe?.sourceSnapshotSha256 ? "passed" : "unavailable", ...(layer?.recipe?.sourceSnapshotSha256 ? { detail: layer.recipe.sourceSnapshotSha256 } : {}) },
  ];
  const outputHashes = [
    ...technicalDownloads.filter((link) => link.sha256).map((link) => ({ kind: link.kind, sha256: link.sha256!, url: link.url })),
    ...(statisticsAsset ? [{ kind: "statistics", sha256: statisticsAsset.record.sha256, url: `/api/v1/assets/${encodeURIComponent(statisticsAsset.id)}/download` }] : []),
  ];
  const limitations = [
    ...(product.presentation.limitationsMarkdown?.split(/\n+/).map((line) => sanitizePublicText(line.replace(/^[-*]\s*/, "").trim())).filter(Boolean) ?? []),
    ...(layer?.sourceUnitIndex?.status === "entrypoint-only" ? [sanitizePublicText(layer.sourceUnitIndex.notes)] : []),
    ...(catalogEntry?.reason ? [sanitizePublicText(catalogEntry.reason)] : []),
  ];
  const evidence = buildPublicProductEvidence({ product, catalogEntry, layer, assets });
  const snapshot = layer?.recipe?.sourceSnapshotSha256 ? { sha256: layer.recipe.sourceSnapshotSha256, ...(layer.recipe.sourceSnapshotSizeBytes !== undefined ? { sizeBytes: layer.recipe.sourceSnapshotSizeBytes } : {}) } : undefined;
  const dossier: PublicProductDossier = {
    schemaVersion: 1,
    identity: { productId: product.productId, surveyId: product.surveyId, releaseId: product.releaseId, name: product.name, ...(product.modality ? { modality: product.modality } : {}), ...(product.dataOrigin ? { dataOrigin: product.dataOrigin } : {}), ...(product.sourceTier ? { sourceTier: product.sourceTier } : {}) },
    description: effectiveEditorialProduct(record)?.description ?? product.publicDescription ?? catalogEntry?.description ?? product.name,
    ...(effectiveEditorialProduct(record)?.reason ? { reason: effectiveEditorialProduct(record)!.reason } : catalogEntry?.reason ? { reason: catalogEntry.reason } : {}),
    ...(effectiveEditorialProduct(record)?.manualStep ? { manualStep: effectiveEditorialProduct(record)!.manualStep } : catalogEntry?.manualStep ? { manualStep: catalogEntry.manualStep } : {}),
    conclusion: { status, summary, coverageAvailable: hasCoverage },
    readiness,
    coverage: { available: hasCoverage, ...(layer ? { layerId: layer.layerId, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder, cellCount: layer.cellCount, cellCounts, areaDeg2: layer.areaDeg2, ...(layer.coverageRole ?? product.coverageRole ? { coverageRole: layer.coverageRole ?? product.coverageRole } : {}), ...(mocAsset ? { mocUrl: `/api/v1/coverage/layers/${encodeURIComponent(layer.layerId)}/moc.fits` } : {}), ...(previewAsset ? { previewUrl: `/api/v1/assets/${encodeURIComponent(previewAsset.id)}/preview` } : {}) } : {}), coordinateFrame: "ICRS", ordering: "NESTED", availableOrders, precision },
    source: { ...(product.sourceLabel || catalogEntry?.sourceLabel ? { label: product.sourceLabel ?? catalogEntry?.sourceLabel } : {}), ...(official?.url ? { url: official.url } : {}), ...(product.geometrySourceLabel || catalogEntry?.geometrySourceLabel ? { geometryLabel: product.geometrySourceLabel ?? catalogEntry?.geometrySourceLabel } : {}), ...(geometry?.url ? { geometryUrl: geometry.url } : {}), ...(snapshot ? { snapshot } : {}), references: evidence.sourceReferences },
    derivation: { ...(layer?.recipe?.mode ? { mode: layer.recipe.mode } : product.mode ? { mode: product.mode } : {}), coordinateFrame: "ICRS", ordering: "NESTED", ...(layer?.coverageRole ?? product.coverageRole ? { coverageRole: layer?.coverageRole ?? product.coverageRole } : {}), availableOrders, steps: evidence.steps },
    verification: { status, checks, outputHashes },
    limitations,
    actions: { ...(official ? { official } : {}), ...(query ? { query } : {}), ...(data ? { data } : {}), view },
    technicalDownloads,
    links,
    evidenceUrl: `/api/v1/products/${encodeURIComponent(product.productId)}/evidence`,
  };
  return dossier;
}

function publicProductListView(record: ProductRecord): Record<string, unknown> {
  const dossier=buildPublicProductDossier(record);
  return {productId:record.productId,surveyId:record.draft.surveyId,releaseId:record.draft.releaseId,name:record.draft.name,coverage:dossier.coverage,readiness:dossier.readiness,detailUrl:`/api/v1/products/${record.productId}`};
}

function adminProductView(record: ProductRecord): Record<string, unknown> {
  const mocBuild = adminMocBuildSummary(record.productId);
  const { executions, ...base } = record;
  const buildRecord = mocBuild ? mocBuildStore.get(String(mocBuild.name)) : undefined;
  const buildExecution: ProductExecutionRecord | undefined = buildRecord ? {
    executionId: `moc-build:${buildRecord.name}`,
    revision: record.revision,
    stepId: "moc-build",
    status: buildRecord.phase === "FAILED" ? "failed" : ["STAGED", "PUBLISHED", "DUPLICATE"].includes(buildRecord.phase) ? "passed" : "running",
    startedAt: buildRecord.createdAt,
    ...(buildRecord.phase === "FAILED" || ["STAGED", "PUBLISHED", "DUPLICATE"].includes(buildRecord.phase) ? { finishedAt: buildRecord.updatedAt } : {}),
    tool: { name: "MOC-Core-SDK" },
    inputs: [{ label: "source snapshot", ...(buildRecord.source.evidenceRef ? { ref: buildRecord.source.evidenceRef } : {}), ...(buildRecord.source.snapshotSha256 ? { sha256: buildRecord.source.snapshotSha256 } : {}), ...(buildRecord.source.sizeBytes !== undefined ? { sizeBytes: buildRecord.source.sizeBytes } : {}) }],
    parameters: { candidateId: buildRecord.candidateId },
    outputs: Object.entries(buildRecord.outputs ?? {}).flatMap(([label, value]) => {
      if (!value || typeof value !== "object") return [];
      const output = value as { ref?: unknown; sha256?: unknown; sizeBytes?: unknown };
      if (typeof output.ref !== "string" && typeof output.sha256 !== "string") return [];
      return [{ label, ...(typeof output.ref === "string" ? { ref: output.ref } : {}), ...(typeof output.sha256 === "string" ? { sha256: output.sha256 } : {}), ...(typeof output.sizeBytes === "number" ? { sizeBytes: output.sizeBytes } : {}) }];
    }),
    checks: [
      { id: "source-snapshot", status: buildRecord.source.snapshotSha256 ? "passed" : "failed" },
      { id: "output-integrity", status: ["STAGED", "PUBLISHED", "DUPLICATE"].includes(buildRecord.phase) ? "passed" : "not-applicable" },
    ],
    ...(buildRecord.error?.message ? { error: buildRecord.error.message } : {}),
  } : undefined;
  const evidence = [...(buildExecution ? [buildExecution] : []), ...(executions ?? [])].slice(-64);
  return {
    ...base,
    ...(evidence.length ? { executionEvidence: evidence } : {}),
    ...(productCoverage(record) ? { coverage: productCoverage(record) } : {}),
    ...(mocBuild ? { mocBuild } : {}),
    readiness: productReadiness(record),
    lifecycle: adminProductLifecycle(record, mocBuild ? mocBuildStore.get(String(mocBuild.name)) : undefined),
    ...(record.retiredAt ? { retiredAt: record.retiredAt } : {}),
    ...(record.retirementReason ? { retirementReason: record.retirementReason } : {}),
    ...(record.restoredAt ? { restoredAt: record.restoredAt, restorationReason: record.restorationReason } : {}),
  };
}

function adminProductSurveys(records: ProductRecord[], index: typeof runtimeSurveyIndex): Array<Record<string, unknown>> {
  const byProductId = new Map(records.map((record) => [record.productId, record]));
  const seen = new Set<string>();
  const surveys = index.surveys.map((survey) => {
    const surveyRecords: ProductRecord[] = [];
    const releases = survey.releases.map((release) => {
      const releaseRecords: ProductRecord[] = [];
      const products = release.products.map((product) => {
        const productId = product.productId ?? `${survey.id}:${release.id}:${product.name}`;
        const record = byProductId.get(productId);
        if (record) {
          seen.add(productId);
          releaseRecords.push(record);
          surveyRecords.push(record);
        }
        const coverage = record ? productCoverage(record) : product.coverage;
        const mocBuild = record ? adminMocBuildSummary(record.productId) : undefined;
        return {
          ...product,
          productId,
          ...(coverage ? { coverage } : {}),
          ...(mocBuild ? { mocBuild } : {}),
          ...(record ? { readiness: productReadiness(record), lifecycle: adminProductLifecycle(record, mocBuild ? mocBuildStore.get(String(mocBuild.name)) : undefined), ...(record.retiredAt ? { retiredAt: record.retiredAt } : {}), ...(record.retirementReason ? { retirementReason: record.retirementReason } : {}) } : {}),
          review: record ? {
            state: record.retiredAt ? "retired" : record.published && record.publishedRevision === record.revision ? "published" : hasCurrentProductReview(record) ? "reviewed" : "draft",
            draftRevision: record.revision,
            publishedRevision: record.publishedRevision,
            updatedAt: record.updatedAt,
            publishedAt: record.publishedAt,
            ...(record.review ? { reviewedRevision: record.review.revision, reviewedAt: record.review.reviewedAt, acceptedGaps: record.review.acceptedGaps } : {}),
          } : { state: "unmatched" },
        };
      });
      return {
        id: release.id,
        label: release.label,
        kind: release.kind,
        ...(release.releasedYear !== undefined ? { releasedYear: release.releasedYear } : {}),
        modalities: release.modalities,
        coverageOrders: release.coverageOrders,
        readiness: readinessSummaryForRecords(releaseRecords),
        products,
      };
    });
    return {
      id: survey.id,
      surveyId: survey.id,
      name: survey.name,
      mission: survey.mission,
      color: survey.color,
      description: survey.description,
      modalities: survey.modalities,
      imageUrl: survey.imageUrl,
      statistics: survey.statistics,
      coverageOrders: survey.coverageOrders,
      readiness: readinessSummaryForRecords(surveyRecords),
      releases,
    };
  });
  const unmatchedRecords = records.filter((record) => !seen.has(record.productId));
  const unmatchedProducts = unmatchedRecords.map((record) => ({
    productId: record.productId,
    surveyId: record.draft.surveyId,
    releaseId: record.draft.releaseId,
    name: record.draft.name,
    modality: record.draft.modality,
    ...(record.retiredAt ? { retiredAt: record.retiredAt } : {}),
    ...(record.retirementReason ? { retirementReason: record.retirementReason } : {}),
    readiness: productReadiness(record),
    review: {
      state: record.retiredAt ? "retired" : record.published && record.publishedRevision === record.revision ? "unmatched-published" : "unmatched-draft",
      draftRevision: record.revision,
      publishedRevision: record.publishedRevision,
      updatedAt: record.updatedAt,
      publishedAt: record.publishedAt,
      ...(record.review ? { reviewedRevision: record.review.revision, reviewedAt: record.review.reviewedAt, acceptedGaps: record.review.acceptedGaps } : {}),
    },
  }));
  const unmatchedBuilds = adminUnmatchedMocBuilds();
  const result: Array<Record<string, unknown>> = unmatchedProducts.length ? [...surveys, { id: "__unmatched__", surveyId: "__unmatched__", name: "未匹配公共 Catalog 的产品", mission: "Assets editorial queue", color: "#82979e", description: "这些产品存在于 Assets 编辑存储，但没有对应的公共 survey/release/product 记录。", modalities: [], imageUrl: "", statistics: { publicProducts: unmatchedProducts.length, acquired: 0, overviewOnly: 0, awaitingGeometry: unmatchedProducts.length, notApplicable: 0, footprintCells: 0 }, readiness: readinessSummaryForRecords(unmatchedRecords), releases: [], unmatchedProducts }] : [...surveys];
  if (unmatchedBuilds.length) result.push({ id: "__moc-builds__", surveyId: "__moc-builds__", name: "待登记 MOC 构建", mission: "Assets editorial queue", color: "#42d5c4", description: "这些 MOC 已完成构建但尚未绑定到公共 survey / release / product。登记后才能进入产品文稿审核与发布。", modalities: [], imageUrl: "", statistics: { publicProducts: 0, acquired: 0, overviewOnly: 0, awaitingGeometry: unmatchedBuilds.length, notApplicable: 0, footprintCells: 0 }, releases: [], unmatchedBuilds });
  return result;
}

function productsRecord(id:string):ProductRecord|undefined {return products.list().find(p=>p.productId===id);}

function overviewSurveySummary(value: Record<string, unknown>): Record<string, unknown> {
  const releases = Array.isArray(value.releases) ? value.releases : [];
  return {
    id: value.id,
    surveyId: value.surveyId,
    name: value.name,
    mission: value.mission,
    modalities: value.modalities,
    statistics: value.statistics,
    readiness: value.readiness,
    releases: releases.map((releaseValue) => {
      const release = releaseValue && typeof releaseValue === "object" && !Array.isArray(releaseValue) ? releaseValue as Record<string, unknown> : {};
      const products = Array.isArray(release.products) ? release.products : [];
      return {
        id: release.id,
        label: release.label,
        kind: release.kind,
        readiness: release.readiness,
        products: products.map((productValue) => {
          const product = productValue && typeof productValue === "object" && !Array.isArray(productValue) ? productValue as Record<string, unknown> : {};
          return {
            productId: product.productId,
            name: product.name,
            modality: product.modality,
            status: product.status,
            readiness: product.readiness,
            review: product.review,
            publicCoverage: {published:publicState.records.has(String(product.productId)),orders:[...publicState.coverage.records.values()].filter(l=>l.productId===product.productId).map(l=>l.maxOrder),retired:Boolean(productsRecord(String(product.productId))?.retiredAt)},
          };
        }),
      };
    }),
  };
}

function connectorScope(connector: Awaited<ReturnType<AssetsAdmin["listConnectors"]>>[number]): Record<string, unknown> {
  if (connector.type === "local") {
    return { kind: "pvc", ...(connector.pvcName ? { pvcName: connector.pvcName } : {}), ...(connector.basePath ? { basePath: connector.basePath } : {}), ...(connector.localPath ? { legacyPath: connector.localPath } : {}) };
  }
  return {
    kind: "bucket-prefix",
    ...(connector.endpoint ? { endpoint: connector.endpoint } : {}),
    ...(connector.region ? { region: connector.region } : {}),
    ...(connector.bucket ? { bucket: connector.bucket } : {}),
    ...(connector.prefix ? { prefix: connector.prefix } : {}),
  };
}

function connectorSummary(connector: Awaited<ReturnType<AssetsAdmin["listConnectors"]>>[number], tasks: Awaited<ReturnType<AssetsAdmin["listTasks"]>>): Record<string, unknown> {
  const related = tasks.filter((task) => task.sourceConnector === connector.name).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const latest = related[0];
  const observedObjectCount = latest?.status.discoveredFiles;
  const inventory = connector.inventory;
  return {
    ...connector,
    scope: connectorScope(connector),
    inventory: inventory ? {
      ...inventory,
      ...(inventory.state === "complete" ? {} : observedObjectCount !== undefined ? { observedObjectCount, observedAt: latest?.createdAt, source: inventory.source ?? "scan-run" } : {}),
      note: inventory.note ?? (observedObjectCount !== undefined ? "最近一次扫描的观测值，不代表整个授权范围总量。" : "尚未执行授权范围盘点；总对象数与总字节数未知。"),
    } : {
      state: "unknown",
      denominatorKnown: false,
      ...(observedObjectCount !== undefined ? { observedObjectCount } : {}),
      ...(latest?.createdAt ? { observedAt: latest.createdAt } : {}),
      source: observedObjectCount !== undefined ? "scan-run" : "none",
      note: observedObjectCount !== undefined ? "最近一次扫描的观测值，不代表整个授权范围总量。" : "尚未执行授权范围盘点；总对象数与总字节数未知。",
    },
    usage: {
      scanTaskCount: related.length,
      productCount: new Set(related.map((task) => task.productId).filter((value): value is string => Boolean(value))).size,
      ...(latest ? { latestTask: { name: latest.name, phase: latest.status.phase, ...(latest.createdAt ? { createdAt: latest.createdAt } : {}) } } : {}),
    },
  };
}

/** Keep the on-demand product history useful without returning full draft bodies or evidence payloads. */
function productHistorySummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { action: "unknown" };
  const entry = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["action", "productId", "revision", "at", "reason"] as const) {
    const current = entry[key];
    if ((key === "revision" && Number.isSafeInteger(current)) || (key !== "revision" && typeof current === "string" && current)) summary[key] = current;
  }
  if (Array.isArray(entry.acceptedGaps)) summary.acceptedGaps = entry.acceptedGaps.filter((gap): gap is string => typeof gap === "string").slice(0, 64);
  const execution = entry.execution;
  if (execution && typeof execution === "object" && !Array.isArray(execution)) {
    const details = execution as Record<string, unknown>;
    for (const key of ["executionId", "stepId", "status"] as const) if (typeof details[key] === "string" && details[key]) summary[key] = details[key];
  }
  return summary;
}

async function adminOverview(): Promise<Record<string, unknown>> {
  const records = products.list();
  const surveyRecords = adminProductSurveys(records, adminSurveyIndex());
  let tasks: Awaited<ReturnType<AssetsAdmin["listTasks"]>> = [];
  let discoveryRequests: Awaited<ReturnType<AssetsAdmin["listMocDiscoveryRequests"]>> = [];
  let connectors: Awaited<ReturnType<AssetsAdmin["listConnectors"]>> = [];
  await Promise.all([
    admin.listTasks().then((value) => { tasks = value; }).catch(() => undefined),
    admin.listMocDiscoveryRequests().then((value) => { discoveryRequests = value; }).catch(() => undefined),
    admin.listConnectors().then((value) => { connectors = value; }).catch(() => undefined),
  ]);
  const releaseCount = surveyRecords.filter((survey) => !String(survey.id).startsWith("__"))
    .reduce((total, survey) => total + (Array.isArray(survey.releases) ? survey.releases.length : 0), 0);
  const activeRecords = records.filter((record) => !record.retiredAt);
  const productSummaries = activeRecords.map((record) => currentReadiness(record));
  const taskPhases = Object.fromEntries([...new Set(tasks.map((task) => task.status.phase))].sort().map((phase) => [phase, tasks.filter((task) => task.status.phase === phase).length]));
  const discoveryPhases = Object.fromEntries([...new Set(discoveryRequests.map((request) => request.status.discoveryState ?? request.status.phase))].sort().map((phase) => [phase, discoveryRequests.filter((request) => (request.status.discoveryState ?? request.status.phase) === phase).length]));
  const buildPhases = Object.fromEntries([...new Set(mocBuildStore.list().map((build) => build.phase))].sort().map((phase) => [phase, mocBuildStore.list().filter((build) => build.phase === phase).length]));
  const readinessVersions = readinessSummaryForRecords(activeRecords);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    coverage: {
      mode: coverageLoadMode,
      warehouseGeometry,
      loadedAt: coverageLoadedAt,
      revision: coverageCatalog.revision,
      layers: coverageCatalog.layers.length,
      footprints: coverageCatalog.records.size,
      warehouseConfigured: evidenceStore.configured,
      runtimeLayers: [...coverageCatalog.records.values()].map(layer => {
        const record = records.find(product => product.productId === layer.productId)
          ?? records.find(product => product.draft.layerId === layer.layerId)
          ?? records.find(product => product.draft.surveyId === layer.surveyId && product.draft.releaseId === layer.releaseId && product.draft.name === layer.product);
        const source = activePublishedMocLayers.has(layer.layerId)
          ? "product-moc" : warehouseLayerSnapshots.has(layer.layerId) ? "warehouse" : "release";
        return { layerId: layer.layerId, surveyId: layer.surveyId, releaseId: layer.releaseId, name: layer.product, source,
          availableOrders: layer.availableOrders, productId: record?.productId,
          productState: !record ? "unlinked" : record.retiredAt ? "retired" : record.review?.revision === record.revision ? "reviewed" : "pending",
          productPublished: Boolean(record?.published),
        };
      }),
    },
    totals: {
      surveys: surveyRecords.filter((survey) => !String(survey.id).startsWith("__")).length,
      releases: releaseCount,
      products: records.length,
      publishedProducts: records.filter((record) => Boolean(record.published) && !record.retiredAt).length,
      retiredProducts: records.filter((record) => Boolean(record.retiredAt)).length,
    },
    readiness: aggregateReadiness(productSummaries),
    readinessVersions,
    surveys: surveyRecords.map(overviewSurveySummary),
    connectors: connectors.map((connector) => connectorSummary(connector, tasks)),
    workflows: {
      tasks: { total: tasks.length, phases: taskPhases },
      discovery: { total: discoveryRequests.length, phases: discoveryPhases },
      builds: { total: mocBuildStore.list().length, phases: buildPhases },
    },
    syncStatus: {
      products: await apiSyncStatus("products"),
      editorial: await apiSyncStatus("editorial"),
      "publication-runs": await apiSyncStatus("publication-runs"),
    },
  };
}
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_FITS_HEADER_BYTES = 256 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;

const staticTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttc": "font/collection",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function securityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https: http:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(encoded.length),
    "Cache-Control": String(response.getHeader("Cache-Control") ?? "no-cache"),
  });
  response.end(encoded);
}

function compressedJson(request: IncomingMessage, response: ServerResponse, status: number, body: unknown, cacheControl = "no-cache", etag?: string): void {
  if (etag && request.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) {
    response.writeHead(304, { ETag: etag, "Cache-Control": cacheControl, Vary: "Accept-Encoding" });
    response.end();
    return;
  }
  const raw = Buffer.from(`${JSON.stringify(body)}\n`);
  const accept = String(request.headers["accept-encoding"] ?? "");
  const encoded = /\bbr\b/i.test(accept) ? brotliCompressSync(raw) : /\bgzip\b/i.test(accept) ? gzipSync(raw) : raw;
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(encoded.length), "Cache-Control": cacheControl, Vary: "Accept-Encoding" };
  if (encoded !== raw) headers["Content-Encoding"] = /\bbr\b/i.test(accept) ? "br" : "gzip";
  if (etag) headers.ETag = etag;
  response.writeHead(status, headers);
  if (request.method === "HEAD") response.end(); else response.end(encoded);
}

async function resourcePackageCatalog(catalog: LoadedCatalog): Promise<Record<string, unknown>> {
  const catalogFile = [...catalog.files.values()].find(({ record }) => record.path.endsWith("/packages/catalog.json"));
  if (!catalogFile) throw new Error("Resource package catalog is not present in the Assets release");
  const document = JSON.parse(await readFile(catalogFile.absolutePath, "utf8")) as Record<string, unknown>;
  if (document.schemaVersion !== 3 || document.version !== "3.0.0" || !Array.isArray(document.packages)) {
    throw new Error("Resource package catalog is not v3");
  }
  // Serve-time policy filter: denied surveys are never listed, even when the
  // on-disk catalog is an unsanitized worktree original.
  const retiredSurveys = fullyRetiredSurveyIds();
  const sanitizedPackages = approvedRelease.packages.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const surveyId = (value as Record<string, unknown>)["surveyId"];
    const packageId = typeof (value as Record<string, unknown>)["id"] === "string" ? (value as Record<string, unknown>)["id"] as string : "";
    const version = typeof (value as Record<string, unknown>)["version"] === "string" ? (value as Record<string, unknown>)["version"] as string : "";
    const approved = approvedRelease.packages.some(p => p.id === packageId && p.version === version);
    return typeof surveyId === "string" ? !isDeniedSurvey(surveyId) && !retiredSurveys.has(surveyId) && approved : approved;
  });
  document.packages = sanitizedPackages;
  const packageAssets = [...catalog.files.values()]
    .map(({ record }) => record)
    .filter((record) => record.kind === "package" && !isRetiredAsset(record));
  // Public upgrades become visible only when the complete release is activated.
  const packages = sanitizedPackages.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resource package catalog contains an invalid entry");
    const entry = value as Record<string, unknown>;
    const packageId = typeof entry.id === "string" ? entry.id : undefined;
    const surveyId = typeof entry.surveyId === "string" ? entry.surveyId : undefined;
    const version = typeof entry.version === "string" ? entry.version : undefined;
    const releases = Array.isArray(entry.releases) ? entry.releases.filter((release): release is string => typeof release === "string") : [];
    const dynamicAsset = surveyId && version && packageId
      ? packageAssets.find((candidate) => candidate.id === dynamicResourcePackageAssetId({ id: packageId, version }))
      : undefined;
    const asset = dynamicAsset ?? packageAssets.find((candidate) => candidate.surveyId === surveyId
      && candidate.version === version
      && (!candidate.releaseId || releases.includes(candidate.releaseId)));
    return {
      ...entry,
      ...(packageId && version && asset
        ? { archiveUrl: `/api/v1/resource-packages/${encodeURIComponent(packageId)}/versions/${encodeURIComponent(version)}/download` }
        : asset
          ? { archiveUrl: `/api/v1/assets/${encodeURIComponent(asset.id)}/download` }
          : {}),
    };
  });
  return { ...document, packages };
}

/**
 * Public release history from the current immutable release, coerced to the
 * v2 projection, with a fail-closed serve-time policy filter: packages of
 * denied surveys are never listed even if a stale history document slipped
 * through. `latestReleaseId` is recomputed from the highest sequence so the
 * serve-time answer never depends on a stale stored pointer.
 */
async function releaseHistory(loaded: LoadedCatalog): Promise<ReleaseHistoryDocument> {
  const historyFile = [...loaded.files.values()].find(({ record }) => record.path.endsWith("/release-history.json"));
  if (!historyFile) return { schemaVersion: 2, latestReleaseId: "", releases: [] };
  const raw = JSON.parse(await readFile(historyFile.absolutePath, "utf8")) as ReleaseHistoryDocument & { schemaVersion: number };
  if (!raw || !Array.isArray(raw.releases)) {
    throw new Error("Release history document is malformed");
  }
  const releases = raw.releases.filter(entry => entry.releaseId === approvedRelease.releaseId)
    .map((entry) => ({
      ...entry,
      packages: entry.packages.filter((pkg) => (approvedRelease.packages.some(p => p.id === pkg.id && p.version === pkg.version)) && !isDeniedPackageId(pkg.id) && !(pkg.survey && isDeniedSurvey(pkg.survey.id))),
    }))
    .sort((left, right) => right.sequence - left.sequence);
  const latest = releases[0];
  const storedLatest = raw.schemaVersion === 2 ? raw.latestReleaseId : undefined;
  return {
    schemaVersion: 2,
    latestReleaseId: latest?.releaseId ?? "",
    releases,
  };
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function decodeAdminPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AdminHttpError(400, "Invalid URL path segment");
  }
}

function requestQuery(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://localhost").searchParams;
}

function rangeFrom(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new RangeError("Unsupported Range header");
  let start = match[1] ? Number(match[1]) : Number.NaN;
  let end = match[2] ? Number(match[2]) : Number.NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) throw new RangeError("Empty Range header");
  if (Number.isNaN(start)) {
    const suffix = end;
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("Invalid suffix range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    end = Number.isNaN(end) ? size - 1 : end;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new RangeError("Range is outside the file");
  return { start, end: Math.min(end, size - 1) };
}

function fitsInteger(cards: string[], keyword: string, fallback = 0): number {
  const card = cards.find((entry) => entry.slice(0, 8).trim() === keyword);
  if (!card || card[8] !== "=") return fallback;
  const value = Number.parseInt(card.slice(10).split("/", 1)[0]!.trim(), 10);
  return Number.isSafeInteger(value) ? value : fallback;
}

async function fitsHeaderPreview(filePath: string, size: number): Promise<string> {
  const length = Math.min(size, MAX_FITS_HEADER_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, "r");
  try { await handle.read(buffer, 0, length, 0); }
  finally { await handle.close(); }

  const output: string[] = [];
  let offset = 0;
  for (let hdu = 0; hdu < 16 && offset + 80 <= buffer.length; hdu += 1) {
    const cards: string[] = [];
    let endOffset = -1;
    for (let cursor = offset; cursor + 80 <= buffer.length; cursor += 80) {
      const card = buffer.toString("ascii", cursor, cursor + 80);
      cards.push(card);
      if (card.slice(0, 8).trim() === "END") { endOffset = cursor + 80; break; }
    }
    if (endOffset < 0) break;
    const extension = cards.find((entry) => entry.slice(0, 8).trim() === "XTENSION");
    const hduType = extension ? extension.slice(10, 30).replaceAll("'", "").trim() : "PRIMARY";
    output.push(`${output.length ? "\n" : ""}[HDU ${hdu}: ${hduType}]`, ...cards.map((card) => card.trimEnd()));

    const headerBytes = Math.ceil((endOffset - offset) / 2880) * 2880;
    const naxis = fitsInteger(cards, "NAXIS");
    const bitpix = Math.abs(fitsInteger(cards, "BITPIX"));
    let elements = naxis > 0 ? 1 : 0;
    for (let axis = 1; axis <= naxis; axis += 1) elements *= Math.max(0, fitsInteger(cards, `NAXIS${axis}`));
    const pcount = Math.max(0, fitsInteger(cards, "PCOUNT"));
    const gcount = Math.max(1, fitsInteger(cards, "GCOUNT", 1));
    const dataBytes = extension?.includes("BINTABLE") || extension?.includes("TABLE")
      ? (Math.max(0, fitsInteger(cards, "NAXIS1")) * Math.max(0, fitsInteger(cards, "NAXIS2")) + pcount) * gcount
      : Math.ceil(bitpix * elements / 8) * gcount + pcount;
    offset += headerBytes + Math.ceil(dataBytes / 2880) * 2880;
  }
  if (!output.length) throw new Error("FITS header does not contain an END card within the preview limit");
  return `${output.join("\n")}\n`;
}

async function textPreview(filePath: string, size: number, type: string): Promise<string> {
  if (type === "application/fits") return fitsHeaderPreview(filePath, size);
  if (type === "application/zip") return zipDirectoryPreview(filePath, size);
  if (size > MAX_TEXT_PREVIEW_BYTES) {
    const handle = await open(filePath, "r");
    const buffer = Buffer.alloc(MAX_TEXT_PREVIEW_BYTES);
    try { await handle.read(buffer, 0, buffer.length, 0); }
    finally { await handle.close(); }
    return `${buffer.toString("utf8")}\n\n[Preview truncated at ${MAX_TEXT_PREVIEW_BYTES} bytes; download the asset for the complete file.]\n`;
  }
  let content = await readFile(filePath, "utf8");
  if (type === "application/json") {
    try { content = `${JSON.stringify(JSON.parse(content), null, 2)}\n`; }
    catch { throw new Error("JSON asset cannot be formatted for preview"); }
  }
  return content;
}

function zipMethodName(method: number): string {
  switch (method) {
    case 0: return "stored";
    case 8: return "deflate";
    case 12: return "bzip2";
    case 14: return "lzma";
    case 93: return "zstd";
    default: return `method-${method}`;
  }
}

async function zipDirectoryPreview(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    // EOCD is at most 65,557 bytes from the end of a classic ZIP archive.
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocdOffset = tail.lastIndexOf(eocd);
    if (eocdOffset < 0 || eocdOffset + 22 > tail.length) throw new Error("ZIP end-of-central-directory record is missing");
    const entries = tail.readUInt16LE(eocdOffset + 10);
    const directorySize = tail.readUInt32LE(eocdOffset + 12);
    const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported by the online preview");
    }
    if (directoryOffset + directorySize > size) throw new Error("ZIP central directory is outside the asset");
    const bytesToRead = Math.min(directorySize, MAX_ZIP_DIRECTORY_BYTES);
    const directory = Buffer.alloc(bytesToRead);
    await handle.read(directory, 0, bytesToRead, directoryOffset);
    const lines = [
      "ZIP archive preview",
      `entries: ${entries}`,
      `central directory: ${directorySize} bytes`,
      "",
      "path\tcompressed\tuncompressed\tmethod",
    ];
    let offset = 0;
    let parsed = 0;
    const signature = 0x02014b50;
    while (offset + 46 <= directory.length && parsed < entries) {
      if (directory.readUInt32LE(offset) !== signature) break;
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (offset + recordLength > directory.length) break;
      const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\t", " ");
      const compressed = directory.readUInt32LE(offset + 20);
      const uncompressed = directory.readUInt32LE(offset + 24);
      const method = directory.readUInt16LE(offset + 10);
      lines.push(`${name}\t${compressed}\t${uncompressed}\t${zipMethodName(method)}`);
      offset += recordLength;
      parsed += 1;
    }
    if (parsed < entries || directorySize > MAX_ZIP_DIRECTORY_BYTES) {
      lines.push("", `[Preview truncated after ${parsed} of ${entries} entries; download the ZIP for the complete archive.]`);
    }
    return `${lines.join("\n")}\n`;
  } finally {
    await handle.close();
  }
}

async function sendDownload(request: IncomingMessage, response: ServerResponse, loaded: LoadedCatalog, id: string): Promise<void> {
  const entry = loaded.files.get(id);
  if (!entry) return json(response, 404, { error: "Public asset not found" });
  let range: { start: number; end: number } | undefined;
  try {
    range = rangeFrom(request.headers.range, entry.record.sizeBytes);
  } catch {
    response.writeHead(416, { "Content-Range": `bytes */${entry.record.sizeBytes}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? entry.record.sizeBytes - 1;
  const length = end - start + 1;
  const headers: Record<string, string> = {
    "Content-Type": entry.record.mediaType,
    "Content-Length": String(length),
    "Content-Disposition": `attachment; filename="${entry.record.downloadName.replaceAll('"', "")}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"sha256-${entry.record.sha256}"`,
    "X-Content-SHA256": entry.record.sha256,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${entry.record.sizeBytes}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(entry.absolutePath, { start, end }).pipe(response);
}

async function sendPreview(request: IncomingMessage, response: ServerResponse, loaded: LoadedCatalog, id: string): Promise<void> {
  const entry = loaded.files.get(id);
  if (!entry) return json(response, 404, { error: "Public asset not found" });
  const mode = assetPreviewMode(entry.record.mediaType);
  if (!mode) return json(response, 415, { error: "This asset type does not support online preview" });
  const type = entry.record.mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (mode === "text") {
    const details = await stat(entry.absolutePath);
    let content: string;
    try { content = await textPreview(entry.absolutePath, details.size, type); }
    catch { return json(response, 422, { error: "Asset cannot be formatted for preview" }); }
    const body = Buffer.from(content, "utf8");
    let range: { start: number; end: number } | undefined;
    try { range = rangeFrom(request.headers.range, body.length); }
    catch {
      response.writeHead(416, { "Content-Range": `bytes */${body.length}` });
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? body.length - 1;
    const headers: Record<string, string> = {
      "Content-Type": `${type === "application/fits" || type === "application/zip" ? "text/plain" : entry.record.mediaType.split(";", 1)[0]}; charset=utf-8`,
      "Content-Length": String(end - start + 1),
      "Content-Disposition": "inline",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"sha256-${entry.record.sha256}"`,
      "X-Content-SHA256": entry.record.sha256,
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD") { response.end(); return; }
    response.end(body.subarray(start, end + 1));
    return;
  }
  let range: { start: number; end: number } | undefined;
  try { range = rangeFrom(request.headers.range, entry.record.sizeBytes); }
  catch {
    response.writeHead(416, { "Content-Range": `bytes */${entry.record.sizeBytes}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? entry.record.sizeBytes - 1;
  const headers: Record<string, string> = {
    "Content-Type": entry.record.mediaType,
    "Content-Length": String(end - start + 1),
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"sha256-${entry.record.sha256}"`,
    "X-Content-SHA256": entry.record.sha256,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${entry.record.sizeBytes}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") { response.end(); return; }
  createReadStream(entry.absolutePath, { start, end }).pipe(response);
}

async function sendStatic(response: ServerResponse, pathname: string): Promise<void> {
  if (/^\/admin\/(?:overview(?:\/surveys\/[^/]+)?|sources|tasks|review(?:\/products\/[^/]+)?|releases|api)\/?$/.test(pathname)) pathname = "/admin/";
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(siteRoot, requested.endsWith("/") ? path.join(requested, "index.html") : requested);
  const relative = path.relative(siteRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Not found");
    return;
  }
  const filePath = resolved;
  try {
    if (!(await stat(filePath)).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Not found");
      return;
    }
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("Not found");
    return;
  }
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": staticTypes[path.extname(filePath)] ?? "application/octet-stream",
    "Content-Length": String(body.length),
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=86400",
  });
  response.end(body);
}

async function requestJsonBody(request: IncomingMessage, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new AdminHttpError(413, "Request body is too large");
    chunks.push(bytes);
  }
  if (!chunks.length) throw new AdminHttpError(400, "JSON request body is required");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AdminHttpError(400, "Request body must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AdminHttpError(400, "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function expectedRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = request.headers["if-match"];
  const value = typeof header === "string" ? Number(header.replace(/^\"|\"$/g, "")) : body.revision;
  return value === undefined || value === "" ? undefined : Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

function editorialExpectedRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = request.headers["if-match"];
  const raw = typeof header === "string" ? header.replace(/^\"|\"$/g, "") : body.revision;
  if (raw === undefined || raw === "") return undefined;
  if ((typeof raw !== "number" && typeof raw !== "string") || !Number.isSafeInteger(Number(raw))) throw new AdminHttpError(400, "revision must be a safe integer");
  return Number(raw);
}

function buildProductContext(productId: unknown): { productId?: string; surveyId?: string; releaseId?: string; workKey?: string; workTitle?: string } {
  if (productId === undefined || productId === null || productId === "") return {};
  if (typeof productId !== "string" || productId.length > 128) throw new AdminHttpError(400, "productId is invalid");
  const product = products.get(productId).draft;
  return {
    productId: product.productId,
    surveyId: product.surveyId,
    releaseId: product.releaseId,
    workKey: `product:${product.productId}`,
    workTitle: `${product.surveyId.toUpperCase()} · ${product.releaseId} · ${product.name}`.slice(0, 255),
  };
}

function requireOnlyFields(body: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AdminHttpError(400, `${label} contains unsupported fields`);
}

async function currentPublicHstScopeMoc(ref: ReturnType<typeof parseMastHstScopeRef>) {
  const layer = publicState.coverage.records.get(ref.publishedLayerId);
  if (!layer || layer.layerId !== ref.publishedLayerId || layer.surveyId !== "euclid" || layer.releaseId !== "euclid-q1") {
    throw new AdminHttpError(409, "The selected layer is not in the current public Euclid Q1 release");
  }
  const approved = publicState.snapshot.products.find((product) => product.geometry?.layerId === layer.layerId);
  const approvedGeometry = approved?.geometry;
  if (!approved || !approvedGeometry || approved.productId !== layer.productId || approved.content.surveyId !== layer.surveyId
    || approved.content.releaseId !== layer.releaseId || approved.content.name !== layer.product) {
    throw new AdminHttpError(409, "The selected layer is not bound to its current approved product");
  }

  const assets = [...publicState.catalog.files.entries()].filter(([, entry]) => {
    const asset = entry.record;
    return asset.kind === "moc" && asset.surveyId === layer.surveyId && asset.releaseId === layer.releaseId && asset.product === layer.product;
  });
  const selectors = new Set([`approved-${layer.layerId}-moc`, `layer-${layer.layerId}-moc`, layer.layerId]);
  const exact = assets.filter(([id, entry]) => selectors.has(id) || entry.record.path.replaceAll("\\", "/").includes(`/layers/${layer.layerId}/`));
  const matches = exact.length ? exact : assets;
  if (matches.length !== 1) throw new AdminHttpError(409, "The current public native MOC is missing or ambiguous");
  const [assetId, entry] = matches[0]!;
  if (!assetId || entry.record.deliveryClass === "evidence" || entry.record.sha256 !== approvedGeometry.mocSha256) {
    throw new AdminHttpError(409, "The public MOC asset does not match the approved product geometry");
  }
  let bytes: Buffer;
  try {
    const info = await lstat(entry.absolutePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.record.sizeBytes) throw new Error("public MOC file identity mismatch");
    bytes = await readFile(entry.absolutePath);
  } catch {
    throw new AdminHttpError(409, "The current public native MOC cannot be read safely");
  }
  if (nativeSha256(bytes) !== entry.record.sha256) throw new AdminHttpError(409, "The current public native MOC bytes no longer match the release catalog");
  const moc = decodeScopeMoc(bytes, entry.record.sha256);
  if (moc.revision !== approvedGeometry.coverageRevision || (layer.revision && layer.revision !== moc.revision)) {
    throw new AdminHttpError(409, "The current public native MOC revision does not match the approved layer");
  }
  return { layer, moc, sha256: entry.record.sha256 };
}

function stagedBuildFilePath(ref: string): string {
  if (!ref || ref.includes("\\") || path.posix.isAbsolute(ref) || ref.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AdminHttpError(409, "Staged HST MOC evidence path is invalid");
  }
  const root = path.resolve(mocBuildService.evidenceRoot);
  const target = path.resolve(root, ...ref.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new AdminHttpError(409, "Staged HST MOC evidence escaped its storage root");
  return target;
}

async function stagedHstScopeMoc(name: string) {
  const build = mocBuildStore.get(name);
  if (build.phase !== "STAGED" || build.surveyId !== "hst" || !build.productId || build.publishedAt || build.publicationId) {
    throw new AdminHttpError(409, "The selected HST build must be staged, product-bound, and unpublished");
  }
  const product = products.get(build.productId);
  if (product.draft.surveyId !== "hst" || product.draft.releaseId !== build.releaseId || product.published || product.retiredAt
    || (build.layerId !== undefined && product.draft.layerId !== undefined && product.draft.layerId !== build.layerId)) {
    throw new AdminHttpError(409, "The selected staged build does not match its unpublished HST product");
  }
  await mocBuildService.verifyOutputs(build.name);
  const outputs = build.outputs;
  const output = outputs?.moc;
  if (!outputs || !output?.sha256 || !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes! < 1) {
    throw new AdminHttpError(409, "The selected staged build has no locked native MOC output");
  }
  const target = stagedBuildFilePath(output.ref);
  let bytes: Buffer;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== output.sizeBytes) throw new Error("staged MOC file identity mismatch");
    bytes = await readFile(target);
  } catch {
    throw new AdminHttpError(409, "The selected staged HST MOC cannot be read safely");
  }
  if (nativeSha256(bytes) !== output.sha256) throw new AdminHttpError(409, "The selected staged HST MOC bytes no longer match the build record");
  const moc = decodeScopeMoc(bytes, output.sha256);
  const outputOrders = outputs.availableOrders;
  if (outputs.maxOrder !== moc.maxOrder || outputs.cellCount !== moc.cells.length
    || !Array.isArray(outputOrders) || outputOrders.length !== moc.availableOrders.length
    || outputOrders.some((order, index) => order !== moc.availableOrders[index])) {
    throw new AdminHttpError(409, "The selected staged build summary does not match its decoded native MOC");
  }
  return { build, moc, sha256: output.sha256 };
}

async function createMastHstDiscovery(body: Record<string, unknown>): Promise<Awaited<ReturnType<AssetsAdmin["createMocDiscoveryRequest"]>>> {
  requireOnlyFields(body, ["policyRef", "publishedLayerId", "stagedBuildName", "order", "componentIndex"], "HST discovery request");
  if (body.policyRef !== MAST_HST_DISCOVERY_POLICY) throw new AdminHttpError(400, "Unsupported HST discovery policy");
  const ref = parseMastHstScopeRef({
    publishedLayerId: body.publishedLayerId,
    stagedBuildName: body.stagedBuildName,
    order: body.order,
    componentIndex: body.componentIndex,
  });
  const published = await currentPublicHstScopeMoc(ref);
  const staged = await stagedHstScopeMoc(ref.stagedBuildName);
  const resolved = resolveMastHstScope({
    ref,
    publishedLayer: published.layer,
    publishedMoc: published.moc,
    publishedMocSha256: published.sha256,
    stagedBuild: staged.build,
    stagedMoc: staged.moc,
    stagedMocSha256: staged.sha256,
  });
  const input: MocDiscoveryInput = {
    policyRef: MAST_HST_DISCOVERY_POLICY,
    surveyName: "Hubble Space Telescope",
    surveyId: "hst",
    releaseId: "hst-mast-observations",
    observationQuery: resolved.query,
    observationScopeRef: resolved.ref,
    observationComponentId: resolved.componentId,
  };
  return admin.createMocDiscoveryRequest(input);
}

async function createMocBuild(body: Record<string, unknown>): Promise<ReturnType<MocBuildStore["get"]>> {
  const discoveryRequestName = typeof body.discoveryRequestName === "string" ? body.discoveryRequestName : typeof body.requestName === "string" ? body.requestName : "";
  if (!discoveryRequestName.trim()) throw new AdminHttpError(400, "discoveryRequestName is required");
  const candidateId = typeof body.candidateId === "string" ? body.candidateId : "";
  if (!candidateId.trim()) throw new AdminHttpError(400, "candidateId is required");
  const discovery = await discoveryView(discoveryRequestName);
  const candidate = discoveryCandidate(discovery, candidateId);
  const requestedProductId = typeof body.productId === "string" && body.productId.trim() ? body.productId.trim() : undefined;
  if (discovery.productId && requestedProductId && discovery.productId !== requestedProductId) {
    throw new AdminHttpError(400, "productId does not match the discovery work item");
  }
  const product = buildProductContext(discovery.productId ?? requestedProductId);
  const request = await mocBuildStore.create({
    discoveryRequestName: discovery.name,
    candidate,
    ...product,
    ...(discovery.workKey && !product.workKey ? { workKey: discovery.workKey } : {}),
    ...(discovery.workTitle && !product.workTitle ? { workTitle: discovery.workTitle } : {}),
  });
  mocBuildService.enqueue(request, candidate);
  return request;
}

async function retryMocBuild(name: string): Promise<ReturnType<MocBuildStore["get"]>> {
  const existing = mocBuildStore.get(name);
  if (!(existing.phase === "FAILED" || existing.phase === "DUPLICATE")) throw new AdminHttpError(409, `MOC build ${name} is not retryable`);
  const discovery = await discoveryView(existing.discoveryRequestName);
  const candidate = discoveryCandidate(discovery, existing.candidateId);
  const request = await mocBuildStore.create({
    discoveryRequestName: discovery.name,
    candidate,
    ...(existing.surveyId ? { surveyId: existing.surveyId } : {}),
    ...(existing.releaseId ? { releaseId: existing.releaseId } : {}),
    ...(existing.productId ? { productId: existing.productId } : {}),
    ...(existing.workKey ? { workKey: existing.workKey } : {}),
    ...(existing.workTitle ? { workTitle: existing.workTitle } : {}),
    name: `${existing.name}-retry`,
  });
  mocBuildService.enqueue(request, candidate);
  return request;
}

async function registerMocBuildProduct(name: string, body: Record<string, unknown>): Promise<{ request: ReturnType<MocBuildStore["get"]>; product: Record<string, unknown> }> {
  const build = mocBuildStore.get(name);
  if (build.phase !== "STAGED") throw new AdminHttpError(409, `MOC build ${name} is not staged`);
  if (build.productId) {
    const existing = products.get(build.productId);
    return { request: build, product: adminProductView(existing) };
  }
  const discovery = await discoveryView(build.discoveryRequestName);
  const candidate = discoveryCandidate(discovery, build.candidateId);
  const requestedProductId = typeof body.productId === "string" && body.productId.trim() ? body.productId.trim() : undefined;
  let product: ProductRecord;
  if (requestedProductId) {
    product = products.get(requestedProductId);
    if (product.published) throw new AdminHttpError(409, `Product ${requestedProductId} is already published`);
  } else {
    const defaults = await mocRegistrationDefaults(build);
    const surveyFacts = await mocSurveyFacts(build);
    const textOrDefault = (key: MocRegistrationDefaultField): string => {
      const value = body[key];
      return typeof value === "string" && value.trim() ? value : String(defaults.values[key] ?? "");
    };
    const input: MocProductRegistrationInput = {
      ...surveyFacts,
      releaseId: textOrDefault("releaseId"),
      releaseLabel: textOrDefault("releaseLabel"),
      releaseKind: textOrDefault("releaseKind"),
      ...(typeof body.releasedYear === "number" ? { releasedYear: body.releasedYear } : {}),
      productName: textOrDefault("productName"),
      productDescription: textOrDefault("productDescription"),
      productStatus: textOrDefault("productStatus") as MocProductRegistrationInput["productStatus"],
      modality: textOrDefault("modality"),
      sourceUrl: typeof body.sourceUrl === "string" && body.sourceUrl.trim() ? body.sourceUrl : candidate.candidate.recordUrl ?? candidate.sourceUrl,
      geometrySourceUrl: typeof body.geometrySourceUrl === "string" && body.geometrySourceUrl.trim() ? body.geometrySourceUrl : candidate.mocUrl ?? candidate.sourceUrl,
      ...(typeof body.geometrySourceLabel === "string" ? { geometrySourceLabel: body.geometrySourceLabel } : {}),
      dataOrigin: textOrDefault("dataOrigin") as MocProductRegistrationInput["dataOrigin"],
    };
    product = await products.createMocProduct(input);
    if (product.published) throw new AdminHttpError(409, `Product ${product.productId} is already published`);
  }
  const workTitle = `${product.draft.surveyId.toUpperCase()} · ${product.draft.releaseId} · ${product.draft.name}`.slice(0, 255);
  const request = await mocBuildStore.bindProduct(name, { productId: product.productId, surveyId: product.draft.surveyId, releaseId: product.draft.releaseId, workKey: `product:${product.productId}`, workTitle });
  await editorial.sync(adminInventoryIndex(runtimeSurveyIndex, products.list()).surveys);
  return { request, product: adminProductView(product) };
}

async function sendAdmin(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/api/v1/admin/config" && request.method === "GET") {
    return json(response, 200, { ...admin.publicConfig(), mocDiscovery: { cdsUrl: CDS_SEARCH_URL, llmAvailable: llmDiscovery.configured } });
  }
  if (!admin.config.enabled) return json(response, 404, { error: "Assets administration is disabled" });
  try {
    admin.authorize(adminFromRequest(request));
    if (pathname.startsWith("/api/v1/admin/native-units")) {
      if (!nativeUnits) throw new AdminHttpError(503, "Native-unit management backend unavailable");
      response.setHeader("Cache-Control", "no-store");
      const base = "/api/v1/admin/native-units";
      const actor = "administrator";
      if (pathname === base && request.method === "GET") return json(response, 200, { ...nativeUnits.view() as object, syncStatus: await apiSyncStatus("native-units") });
      if (pathname === base + "/bindings" && request.method === "GET") return json(response, 200, { bindings: await nativeUnits.availableBindings() });
      if (pathname === base + "/tasks" && request.method === "POST") return json(response, 202, { task: await nativeUnits.submit(await requestJsonBody(request, 65536) as Record<string, unknown>, actor) });
      const source = /^\/api\/v1\/admin\/native-units\/sources\/([^/]+)$/.exec(pathname);
      if (source && request.method === "PUT") return json(response, 200, { source: await nativeUnits.updateSource(source[1]!, await requestJsonBody(request, 32768) as Record<string, unknown>, actor) });
      const group = /^\/api\/v1\/admin\/native-units\/groups\/([^/]+)(?:\/(review|bindings))?$/.exec(pathname);
      if (group && !group[2] && request.method === "GET") return json(response, 200, nativeUnits.detail(group[1]!));
      if (group && group[2] === "review" && request.method === "POST") return json(response, 200, await nativeUnits.review(group[1]!, await requestJsonBody(request, 32768) as Record<string, unknown>, actor));
      if (group && group[2] === "bindings" && request.method === "PUT") return json(response, 200, await nativeUnits.changeBindings(group[1]!, await requestJsonBody(request, 32768) as Record<string, unknown>, actor));
      const cancel = /^\/api\/v1\/admin\/native-units\/tasks\/([^/]+)\/cancel$/.exec(pathname);
      if (cancel && request.method === "POST") { await publicationScheduler?.cancel(cancel[1]!); return json(response, 200, { cancelled: true }); }
      throw new AdminHttpError(404, "Native-unit management route not found");
    }
    if (pathname.startsWith("/api/v1/admin/api-management")) {
      if (!apiManagement) throw new AdminHttpError(503, "API management backend unavailable");
      response.setHeader("Cache-Control", "no-store");
      const base = "/api/v1/admin/api-management";
      if (pathname === base && request.method === "GET") return json(response, 200, apiManagement.view());
      if (pathname === base + "/llm" && request.method === "PUT") { await apiManagement.updateProvider(await requestJsonBody(request, 16384) as Record<string, unknown>); return json(response, 200, apiManagement.view()); }
      if (pathname === base + "/llm/test" && request.method === "POST") return json(response, 200, await apiManagement.testProvider());
      if (pathname === base + "/keys" && request.method === "POST") return json(response, 201, await apiManagement.createKey(await requestJsonBody(request, 16384) as Record<string, unknown>));
      const revoke = /^\/api\/v1\/admin\/api-management\/keys\/([^/]+)\/revoke$/.exec(pathname);
      if (revoke && request.method === "POST") { await apiManagement.revokeKey(revoke[1]!); return json(response, 200, { revoked: true }); }
      const deleteKey = /^\/api\/v1\/admin\/api-management\/keys\/([^/]+)$/.exec(pathname);
      if (deleteKey && request.method === "DELETE") { await apiManagement.deleteRevokedKey(deleteKey[1]!); return json(response, 200, { deleted: true }); }
      throw new AdminHttpError(404, "API management route not found");
    }
    if (pathname === "/api/v1/admin/overview" && request.method === "GET") {
      return json(response, 200, await adminOverview());
    }
    const connectorDeleteMatch = /^\/api\/v1\/admin\/connectors\/([^/]+)$/.exec(pathname);
    if (connectorDeleteMatch?.[1] && request.method === "DELETE") {
      const result = await admin.deleteConnector(decodeURIComponent(connectorDeleteMatch[1]));
      warehouseConnectorLookupCache = undefined;
      return json(response, 200, result);
    }
    const connectorIconMatch = /^\/api\/v1\/admin\/connectors\/([^/]+)\/icon$/.exec(pathname);
    if (connectorIconMatch?.[1] && request.method === "PUT") {
      const input = await requestJsonBody(request, 96 * 1024);
      const connector = await admin.updateConnectorIcon(decodeURIComponent(connectorIconMatch[1]), input);
      warehouseConnectorLookupCache = undefined;
      return json(response, 200, { connector, syncStatus: await apiSyncStatus("connector-presentation") });
    }
    const connectorProbeMatch = /^\/api\/v1\/admin\/connectors\/([^/]+)\/probe$/.exec(pathname);
    if (connectorProbeMatch?.[1] && request.method === "POST") {
      return json(response, 200, { connector: await admin.probeConnector(decodeURIComponent(connectorProbeMatch[1])) });
    }
    const connectorInventoryMatch = /^\/api\/v1\/admin\/connectors\/([^/]+)\/inventory$/.exec(pathname);
    if (connectorInventoryMatch?.[1] && request.method === "POST") {
      return json(response, 202, { connector: { name: decodeURIComponent(connectorInventoryMatch[1]), inventory: await admin.inventoryConnector(decodeURIComponent(connectorInventoryMatch[1])) } });
    }
    if (pathname === "/api/v1/admin/connectors" && request.method === "GET") {
      const connectors = await admin.listConnectors();
      let tasks: Awaited<ReturnType<AssetsAdmin["listTasks"]>> = [];
      try { tasks = await admin.listTasks(); } catch { /* Connector inventory remains readable when Warehouse is unavailable. */ }
      return json(response, 200, { connectors: connectors.map((connector) => connectorSummary(connector, tasks)) });
    }
    if (pathname === "/api/v1/admin/connectors" && request.method === "POST") {
      const input = await requestJsonBody(request, 96 * 1024) as unknown as ConnectorInput;
      const connector = await admin.createConnector(input);
      warehouseConnectorLookupCache = undefined;
      return json(response, 201, { connector });
    }
    if (pathname === "/api/v1/admin/catalog/status" && request.method === "GET") {
      return json(response, 200, { mode: coverageLoadMode, loadedAt: coverageLoadedAt, revision: coverageCatalog.revision, layers: coverageCatalog.layers.length, footprints: coverageCatalog.records.size, warehouseConfigured: evidenceStore.configured, warehouseGeometry });
    }
    if (pathname === "/api/v1/admin/catalog/reload" && request.method === "POST") {
      const catalogState = await reloadRuntimeCoverage();
      runtimeSurveyIndex = applyPublishedProductMetadata(runtimeSurveyIndex);
      await editorial.sync(adminInventoryIndex(runtimeSurveyIndex, products.list()).surveys);
      return json(response, 200, { catalog: { ...catalogState, revision: coverageCatalog.revision } });
    }
    if (pathname === "/api/v1/admin/tasks" && request.method === "GET") return json(response, 200, { tasks: await admin.listTasks() });
    if (pathname === "/api/v1/admin/tasks" && request.method === "POST") {
      const input = await requestJsonBody(request) as unknown as CoverageTaskInput & { productId?: string; profileId?: unknown };
      if (input.profileId !== undefined) return json(response, 400, { error: "profileId is no longer supported; submit a product-driven ScanPlan" });
      if (input.productId) {
        const product = products.get(input.productId).draft;
        const executableMode: CoverageTaskInput["mode"] | undefined = product.mode && (SUPPORTED_COVERAGE_MODES as readonly string[]).includes(product.mode)
          ? product.mode as CoverageTaskInput["mode"]
          : undefined;
        const immutable: Array<[keyof CoverageTaskInput, string | undefined]> = [["layerId", product.layerId], ["surveyId", product.surveyId], ["releaseId", product.releaseId], ["product", product.name], ["productId", product.productId], ["modality", product.modality], ["mode", product.mode], ["coverageRole", product.coverageRole], ["dataOrigin", product.dataOrigin], ["sourceTier", product.sourceTier]];
        for (const [key, expected] of immutable) {
          // A catalog coordinate scan records target/object presence. A product
          // may still publish an independent footprint recipe, so allow this
          // evidence role to be derived without rewriting the public product.
          const explicitExecutableMode = input.mode !== undefined
            && (SUPPORTED_COVERAGE_MODES as readonly string[]).includes(input.mode);
          const scanModeOverride = key === "mode"
            && !executableMode
            && explicitExecutableMode;
          const catalogEvidenceRole = key === "coverageRole"
            && (executableMode ?? input.mode) === "catalog-radec"
            && input[key] === "object_presence"
            && expected === "footprint_extent";
          if (input[key] !== undefined && input[key] !== expected && !scanModeOverride && !catalogEvidenceRole) {
            return json(response, 400, { error: `${String(key)} is defined by the selected product` });
          }
        }
        const effectiveMode = executableMode ?? input.mode;
        const derived = {
          ...input,
          layerId: product.layerId ?? input.layerId,
          surveyId: product.surveyId,
          releaseId: product.releaseId,
          product: product.name,
          productId: product.productId,
          modality: product.modality,
          mode: effectiveMode,
          coverageRole: effectiveMode === "catalog-radec"
            ? "object_presence"
            : product.coverageRole ?? input.coverageRole,
          dataOrigin: product.dataOrigin ?? input.dataOrigin,
          sourceTier: product.sourceTier ?? input.sourceTier,
        };
        if (!derived.layerId || !derived.mode || !derived.coverageRole || !derived.dataOrigin || !derived.sourceTier) return json(response, 400, { error: "Selected product is not executable by the configured recipe" });
        return json(response, 201, { task: await admin.createTask(derived) });
      }
      return json(response, 201, { task: await admin.createTask(input) });
    }
    if (pathname === "/api/v1/admin/scan-batches" && request.method === "GET") {
      response.setHeader("Cache-Control", "no-store");
      return json(response, 200, { batches: await admin.listScanBatches() });
    }
    if (pathname === "/api/v1/admin/scan-batches" && request.method === "POST") {
      response.setHeader("Cache-Control", "no-store");
      let input;
      try {
        input = parseScanBatchRequest(await requestJsonBody(request, 64 * 1024));
      } catch (error) {
        if (error instanceof ScanBatchValidationError) throw new AdminHttpError(400, error.message);
        throw error;
      }
      const recipes: ScanBatchTaskRecipe[] = input.rules.map((rule) => {
        const product = products.get(rule.productId).draft;
        const mode = resolveScanBatchMode(rule.scanMode, product.mode);
        if (!product.layerId) {
          throw new AdminHttpError(400, `Product ${product.productId} is missing a layerId required for a scan batch`);
        }
        if (!mode) {
          throw new AdminHttpError(400, `Product ${product.productId} has no executable scan mode; specify scanMode for this rule`);
        }
        if (!product.coverageRole || !product.dataOrigin || !product.sourceTier) {
          throw new AdminHttpError(400, `Product ${product.productId} is not executable by the configured recipe`);
        }
        let includePattern: string | undefined;
        try {
          includePattern = resolveScanBatchIncludePattern(rule.includePattern, product.scanDefaults?.includePattern);
        } catch (error) {
          if (error instanceof ScanBatchValidationError) throw new AdminHttpError(400, error.message);
          throw error;
        }
        const suffixes = rule.allowedSuffixes
          ?? (rule.filters?.includeSuffixes !== undefined ? rule.filters.includeSuffixes.join(",") : product.scanDefaults?.allowedSuffixes);
        return {
          layerId: product.layerId,
          surveyId: product.surveyId,
          releaseId: product.releaseId,
          product: product.name,
          productId: product.productId,
          modality: product.modality,
          mode,
          coverageRole: product.coverageRole,
          dataOrigin: product.dataOrigin,
          sourceTier: product.sourceTier,
          ...(suffixes !== undefined ? { allowedSuffixes: suffixes } : {}),
          ...(includePattern ? { includePattern } : {}),
          ...(rule.maxOrder !== undefined ? { maxOrder: rule.maxOrder } : product.scanDefaults?.maxOrder !== undefined ? { maxOrder: product.scanDefaults.maxOrder } : {}),
          ...((rule.raColumn ?? product.scanDefaults?.raColumn) ? { raColumn: rule.raColumn ?? product.scanDefaults?.raColumn } : {}),
          ...((rule.decColumn ?? product.scanDefaults?.decColumn) ? { decColumn: rule.decColumn ?? product.scanDefaults?.decColumn } : {}),
          ...((rule.healpixColumn ?? product.scanDefaults?.healpixColumn) ? { healpixColumn: rule.healpixColumn ?? product.scanDefaults?.healpixColumn } : {}),
          ...((rule.healpixOrderColumn ?? product.scanDefaults?.healpixOrderColumn) ? { healpixOrderColumn: rule.healpixOrderColumn ?? product.scanDefaults?.healpixOrderColumn } : {}),
          ...((rule.healpixOrder ?? product.scanDefaults?.healpixOrder) !== undefined ? { healpixOrder: rule.healpixOrder ?? product.scanDefaults?.healpixOrder } : {}),
          ...((rule.pathHealpixOrder ?? product.scanDefaults?.pathHealpixOrder) !== undefined ? { pathHealpixOrder: rule.pathHealpixOrder ?? product.scanDefaults?.pathHealpixOrder } : {}),
          ...((rule.pathHealpixGroupSize ?? product.scanDefaults?.pathHealpixGroupSize) !== undefined ? { pathHealpixGroupSize: rule.pathHealpixGroupSize ?? product.scanDefaults?.pathHealpixGroupSize } : {}),
          ...(rule.hduName !== undefined ? { hduName: rule.hduName } : {}),
          ...(rule.hduIndex !== undefined ? { hduIndex: rule.hduIndex } : {}),
          ...(rule.coordinateFrame !== undefined ? { coordinateFrame: rule.coordinateFrame } : {}),
        };
      });
      return json(response, 201, { batch: await admin.createScanBatch(input, recipes) });
    }
    if (pathname === "/api/v1/admin/moc-discovery" && request.method === "GET") {
      return json(response, 200, { requests: (await admin.listMocDiscoveryRequests()).map(r => llmDiscovery.view(r)) });
    }
    if (pathname === "/api/v1/admin/moc-discovery" && request.method === "POST") {
      const body = await requestJsonBody(request);
      if (body.policyRef === MAST_HST_DISCOVERY_POLICY) {
        const created = await createMastHstDiscovery(body);
        return json(response, 201, { request: llmDiscovery.view(created) });
      }
      if (body.llmEnabled !== undefined && typeof body.llmEnabled !== "boolean") throw new AdminHttpError(400, "llmEnabled 必须是布尔值");
      if (body.llmEnabled && !llmDiscovery.configured) throw new AdminHttpError(409, "LLM 服务未配置");
      const input: MocDiscoveryInput = {
        surveyName: body.surveyName as string,
        ...(typeof body.releaseHint === "string" ? { releaseHint: body.releaseHint } : {}),
        ...(typeof body.productHint === "string" ? { productHint: body.productHint } : {}),
        ...(typeof body.surveyId === "string" ? { surveyId: body.surveyId } : {}),
        ...(typeof body.releaseId === "string" ? { releaseId: body.releaseId } : {}),
        ...(typeof body.productId === "string" ? { productId: body.productId } : {}),
        ...(typeof body.workTitle === "string" ? { workTitle: body.workTitle } : {}),
        ...(body.workContext && typeof body.workContext === "object" && !Array.isArray(body.workContext) ? { workContext: body.workContext as MocDiscoveryInput["workContext"] } : {}),
      };
      const created = await admin.createMocDiscoveryRequest(input);
      if (body.llmEnabled === true) await llmDiscovery.enable(created);
      return json(response, 201, { request: llmDiscovery.view(created) });
    }
    const mocRetryMatch = /^\/api\/v1\/admin\/moc-discovery\/([^/]+)\/resubmit$/.exec(pathname);
    if (mocRetryMatch?.[1] && request.method === "POST") {
      const previousName = decodeURIComponent(mocRetryMatch[1]);
      const created = await admin.resubmitMocDiscoveryRequest(previousName);
      if (llmDiscovery.enabled(previousName)) await llmDiscovery.enable(created);
      return json(response, 201, { request: llmDiscovery.view(created) });
    }
    const mocMatch = /^\/api\/v1\/admin\/moc-discovery\/([^/]+)$/.exec(pathname);
    if (mocMatch?.[1] && request.method === "GET") {
      return json(response, 200, { request: await discoveryView(decodeURIComponent(mocMatch[1])) });
    }
    if (pathname === "/api/v1/admin/moc-builds" && request.method === "GET") {
      return json(response, 200, { requests: mocBuildStore.list().map(adminMocBuildView), syncStatus: await apiSyncStatus("moc-build") });
    }
    if (pathname === "/api/v1/admin/moc-builds" && request.method === "POST") {
      const body = await requestJsonBody(request);
      const requestName = typeof body.discoveryRequestName === "string" ? body.discoveryRequestName
        : typeof body.requestName === "string" ? body.requestName : "";
      if (requestName.trim()) {
        const raw = await admin.getMocDiscoveryResource(requestName);
        if (raw.spec?.policyRef === MAST_HST_DISCOVERY_POLICY) {
          requireOnlyFields(body, ["discoveryRequestName", "requestName", "candidateId", "policyRef"], "HST MOC build request");
          if (body.discoveryRequestName !== undefined && body.requestName !== undefined) {
            throw new AdminHttpError(400, "Specify only one HST discovery request name");
          }
          if (body.policyRef !== undefined && body.policyRef !== MAST_HST_DISCOVERY_POLICY) {
            throw new AdminHttpError(400, "HST MOC build policy does not match the discovery request");
          }
          if (!authorityStore || authorityStore.kind !== "s3") {
            throw new AdminHttpError(503, "A configured shared S3 artifact store is required to import HST discovery evidence");
          }
          const imported = await importMastHstObservation({
            resource: raw as KubernetesResource,
            candidateId: body.candidateId,
            artifactStore: authorityStore,
            evidenceRoot,
            products,
            builds: mocBuildStore,
            buildService: mocBuildService,
          });
          await editorial.sync(adminInventoryIndex(runtimeSurveyIndex, products.list()).surveys);
          return json(response, 201, {
            request: adminMocBuildView(imported.request),
            product: adminProductView(imported.product),
            syncStatus: await apiSyncStatus("products"),
          });
        }
      }
      return json(response, 201, { request: await createMocBuild(body), syncStatus: await apiSyncStatus("moc-build") });
    }
    if (pathname === "/api/v1/admin/moc-builds/from-evidence" && request.method === "POST") {
      const imported = await registerEvidenceMoc({ evidenceRoot, products, builds: mocBuildStore, buildService: mocBuildService }, await requestJsonBody(request));
      await editorial.sync(adminInventoryIndex(runtimeSurveyIndex, products.list()).surveys);
      return json(response, 201, { request: adminMocBuildView(imported.request), product: adminProductView(imported.product), syncStatus: await apiSyncStatus("products") });
    }
    if (pathname === "/api/v1/admin/moc-builds/from-path-healpix-evidence" && request.method === "POST") {
      const imported = await registerPathHealpixMoc({ evidenceRoot, products, builds: mocBuildStore, buildService: mocBuildService }, await requestJsonBody(request));
      return json(response, 201, { request: adminMocBuildView(imported.request), product: adminProductView(imported.product), syncStatus: await apiSyncStatus("products") });
    }
    const mocBuildRetryMatch = /^\/api\/v1\/admin\/moc-builds\/([^/]+)\/retry$/.exec(pathname);
    if (mocBuildRetryMatch?.[1] && request.method === "POST") {
      return json(response, 201, { request: await retryMocBuild(decodeURIComponent(mocBuildRetryMatch[1])), syncStatus: await apiSyncStatus("moc-build") });
    }
    const mocBuildRegisterMatch = /^\/api\/v1\/admin\/moc-builds\/([^/]+)\/register-product$/.exec(pathname);
    if (mocBuildRegisterMatch?.[1] && request.method === "POST") {
      return json(response, 201, { ...(await registerMocBuildProduct(decodeURIComponent(mocBuildRegisterMatch[1]), await requestJsonBody(request))), syncStatus: await apiSyncStatus("products") });
    }
    const mocBuildMatch = /^\/api\/v1\/admin\/moc-builds\/([^/]+)$/.exec(pathname);
    if (mocBuildMatch?.[1] && request.method === "GET") {
      const build = mocBuildStore.get(decodeURIComponent(mocBuildMatch[1]));
      if (build.phase === "STAGED" && !build.productId) {
        try {
          const defaults = await mocRegistrationDefaults(build);
          return json(response, 200, { request: adminMocBuildView(build), registrationDefaults: defaults.values, surveyFacts: await mocSurveyFacts(build), registrationDefaultSources: defaults.sources });
        } catch {
          // A build detail remains readable even if its discovery evidence has expired.
        }
      }
      return json(response, 200, { request: adminMocBuildView(build) });
    }
    const taskMatch = /^\/api\/v1\/admin\/tasks\/([^/]+)$/.exec(pathname);
    const retryMatch = /^\/api\/v1\/admin\/tasks\/([^/]+)\/resubmit$/.exec(pathname);
    const scanBatchMatch = /^\/api\/v1\/admin\/scan-batches\/([^/]+)$/.exec(pathname);
    if (scanBatchMatch?.[1] && request.method === "GET") {
      response.setHeader("Cache-Control", "no-store");
      return json(response, 200, { batch: await admin.getScanBatch(decodeAdminPathSegment(scanBatchMatch[1])) });
    }
    if (taskMatch?.[1] && request.method === "GET") {
      return json(response, 200, { task: await admin.getTask(decodeURIComponent(taskMatch[1])) });
    }
    if (retryMatch?.[1] && request.method === "POST") {
      return json(response, 201, { task: await admin.resubmitTask(decodeURIComponent(retryMatch[1])) });
    }
    if (pathname === "/api/v1/admin/products" && request.method === "GET") {
      const records = products.list();
      const query = requestQuery(request);
      if (query.get("view") === "surveys") return json(response, 200, { surveys: adminProductSurveys(records, adminSurveyIndex()), syncStatus: await apiSyncStatus("products") });
      const surveyId = query.get("surveyId")?.trim();
      const filtered = surveyId ? records.filter((record) => record.draft.surveyId === surveyId) : records;
      return json(response, 200, { products: filtered.map(adminProductView), syncStatus: await apiSyncStatus("products") });
    }
    const editorialMatch = /^\/api\/v1\/admin\/catalog\/surveys\/([^/]+)\/editorial(?:\/(draft|publish))?$/.exec(pathname);
    if (editorialMatch?.[1]) {
      const surveyId = decodeAdminPathSegment(editorialMatch[1]);
      const action = editorialMatch[2];
      if (!action && request.method === "GET") return json(response, 200, { editorial: editorialApiRecord(editorial.get(surveyId)), syncStatus: await apiSyncStatus("editorial") });
      if (action === "draft" && request.method === "PUT") {
        const body = await requestJsonBody(request);
        const envelope = "content" in body || "draft" in body;
        if (envelope && Object.keys(body).some((key) => !["content", "draft", "revision"].includes(key))) throw new AdminHttpError(400, "editorial draft request contains unsupported field");
        if ("content" in body && "draft" in body) throw new AdminHttpError(400, "editorial draft request cannot contain both content and draft");
        const content = body.content ?? body.draft ?? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "revision"));
        return json(response, 200, { editorial: editorialApiRecord(await editorial.updateDraft(surveyId, content, editorialExpectedRevision(request, body))), syncStatus: await apiSyncStatus("editorial") });
      }
      if (action === "publish" && request.method === "POST") {
        const body = await requestJsonBody(request);
        if (Object.keys(body).some((key) => key !== "revision")) throw new AdminHttpError(400, "editorial publish request contains unsupported field");
        const expected = editorialExpectedRevision(request, body);
        const pending = editorial.get(surveyId);
        if (expected !== undefined && pending.revision !== expected) throw new AdminHttpError(409,"Editorial revision conflict");
        await products.applyEditorial(pending.draft);
        const record = await editorial.publish(surveyId, expected);
        return json(response, 200, { editorial: editorialApiRecord(record), syncStatus: await apiSyncStatus("editorial") });
      }
    }
    const reviewReadinessMatch = /^\/api\/v1\/admin\/products\/review-readiness$/.exec(pathname);
    if (reviewReadinessMatch && request.method === "GET") {
      const surveyId = requestQuery(request).get("surveyId")?.trim();
      if (!surveyId) throw new AdminHttpError(400, "surveyId is required; qualification is limited to one survey");
      const survey = adminSurveyIndex().surveys.find(item => item.id === surveyId);
      if (!survey) throw new AdminHttpError(404, "Survey not found in the current admin catalog");
      const catalogProductIds = new Set(survey.releases.flatMap(release => release.products.map(product => product.productId ?? `${survey.id}:${release.id}:${product.name}`)));
      const records = products.list().filter(record => catalogProductIds.has(record.productId));
      const qualifications = await Promise.all(records.map(async sourceRecord => {
        const record = structuredClone(sourceRecord);
        const revision = record.revision;
        const readiness = productReadiness(record).draft;
        const retired = Boolean(record.retiredAt);
        const currentRevisionPublished = Boolean(record.published && record.publishedRevision === revision);
        const reviewIsCurrent = hasCurrentProductReview(record);
        const needsOrderCheck = !retired && !currentRevisionPublished;
        const nativeOrder = needsOrderCheck
          ? await productNativeOrderPreflight(record)
          : { minimum: MIN_PUBLIC_COVERAGE_ORDER, state: "not-checked" as const, message: retired ? "已退休产品不进入审核或发布流程" : "当前版本已发布" };
        const latest = products.list().find(item => item.productId === record.productId);
        const stale = !latest || latest.revision !== revision;
        const blockingGaps = readiness.gaps.filter(gap => NON_ACCEPTABLE_PUBLICATION_GAPS.has(gap));
        const confirmationGaps = readiness.gaps.filter(gap => !NON_ACCEPTABLE_PUBLICATION_GAPS.has(gap));
        const reviewState = stale ? "stale" : retired ? "retired" : currentRevisionPublished ? "published"
          : blockingGaps.length || nativeOrder.state !== "passed" ? "blocked"
            : confirmationGaps.length ? "confirm-limitations" : "ready";
        const accepted = new Set(reviewIsCurrent ? record.review?.acceptedGaps ?? [] : []);
        const unacceptedGaps = readiness.gaps.filter(gap => !accepted.has(gap));
        const publicationState = stale ? "stale" : retired ? "retired" : currentRevisionPublished ? "published"
          : blockingGaps.length || nativeOrder.state !== "passed" ? "blocked"
            : !reviewIsCurrent ? "needs-review"
              : unacceptedGaps.length ? "confirm-limitations" : "ready";
        return {
          productId: record.productId,
          revision,
          reviewEligibility: { state: reviewState, blockingGaps, confirmationGaps },
          publicationEligibility: { state: publicationState, unacceptedGaps },
          nativeOrder,
        };
      }));
      response.setHeader("Cache-Control", "no-store");
      return json(response, 200, { surveyId, generatedAt: new Date().toISOString(), products: qualifications });
    }
    const preflightMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/preflight$/.exec(pathname);
    if (preflightMatch?.[1] && request.method === "GET") {
      const record = products.get(decodeAdminPathSegment(preflightMatch[1]));
      return json(response, 200, { productId: record.productId, revision: record.revision, nativeOrder: await productNativeOrderPreflight(record) });
    }
    const productMatch = /^\/api\/v1\/admin\/products\/([^/]+)$/.exec(pathname);
    const draftMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/draft$/.exec(pathname);
    if (productMatch?.[1] && request.method === "GET") {
      const record = products.get(decodeAdminPathSegment(productMatch[1]));
      return json(response, 200, { product: adminProductView(record), syncStatus: await apiSyncStatus("products") });
    }
    if ((productMatch?.[1] || draftMatch?.[1]) && request.method === "PUT") {
      const body = await requestJsonBody(request);
      const productId = productMatch?.[1] ?? draftMatch?.[1]!;
      return json(response, 200, { product: await products.updateDraft(decodeAdminPathSegment(productId), body.content ?? body, expectedRevision(request, body)), syncStatus: await apiSyncStatus("products") });
    }
    const executionMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/executions$/.exec(pathname);
    const verifyProductMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/verify-build$/.exec(pathname);
    if (verifyProductMatch?.[1] && request.method === "POST") {
      const record = products.get(decodeAdminPathSegment(verifyProductMatch[1]));
      const body = await requestJsonBody(request);
      const revision = expectedRevision(request, body);
      if (revision !== record.revision) throw new AdminHttpError(409, "产品版本已变化，请刷新后重新校验。");
      if (record.retiredAt) throw new AdminHttpError(409, "已退休产品不能重新校验。");
      const summary = adminMocBuildSummary(record.productId);
      if (!summary) throw new AdminHttpError(409, "没有关联的 MOC 构建，请先从探索候选构建覆盖。");
      const build = mocBuildStore.get(String(summary.name));
      const startedAt = new Date().toISOString();
      let failure: string | undefined;
      try { await mocBuildService.verifyOutputs(build.name); }
      catch (error) { failure = error instanceof Error ? error.message : "产物校验失败"; }
      const product = await products.recordExecution(record.productId, {
        executionId: `verify-build-${randomUUID()}`,
        stepId: "verify-moc-build",
        status: failure ? "failed" : "passed",
        startedAt, finishedAt: new Date().toISOString(),
        tool: { name: "Assets integrity verification / MOC-Core-SDK" },
        inputs: build.source.evidenceRef || build.source.snapshotSha256 ? [{ label: "探索下载的 MOC 快照", ref: build.source.evidenceRef, sha256: build.source.snapshotSha256 }] : [],
        outputs: Object.entries(build.outputs ?? {}).flatMap(([label, entry]) => entry && typeof entry === "object" && "ref" in entry ? [{ label, ref: entry.ref, sha256: entry.sha256 }] : []),
        parameters: { buildName: build.name, candidateId: build.candidateId },
        checks: [{ id: "output-integrity", status: failure ? "failed" : "passed", detail: failure ?? "来源及输出哈希、大小与 Core MOC 校验通过" }],
        ...(failure ? { error: failure } : {}),
      }, revision);
      return json(response, 200, { product: adminProductView(product), verification: { passed: !failure, ...(failure ? { error: failure } : {}) }, syncStatus: await apiSyncStatus("products") });
    }
    if (executionMatch?.[1] && request.method === "GET") {
      const record = products.get(decodeAdminPathSegment(executionMatch[1]));
      return json(response, 200, { productId: record.productId, revision: record.revision, executions: (record.executions ?? []).slice(-128), readiness: productReadiness(record), syncStatus: await apiSyncStatus("products") });
    }
    if (executionMatch?.[1] && request.method === "POST") {
      const body = await requestJsonBody(request);
      const envelope = Object.prototype.hasOwnProperty.call(body, "execution");
      if (envelope && Object.keys(body).some((key) => !["execution", "revision"].includes(key))) throw new AdminHttpError(400, "Product execution request contains unsupported field");
      const execution = envelope ? body.execution : body;
      const product = await products.recordExecution(decodeAdminPathSegment(executionMatch[1]), execution, expectedRevision(request, body));
      return json(response, 201, { product: adminProductView(product), readiness: productReadiness(product), syncStatus: await apiSyncStatus("products") });
    }
    const publishMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/publish$/.exec(pathname);
    const restoreMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/restore$/.exec(pathname);
    if (restoreMatch?.[1] && request.method === "POST") {
      const body = await requestJsonBody(request);
      if (Object.keys(body).some(key => !["revision", "reason"].includes(key))
        || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1 || typeof body.reason !== "string" || !body.reason.trim()) {
        throw new AdminHttpError(400, "恢复产品需要当前 revision 和恢复原因。");
      }
      const productId = decodeAdminPathSegment(restoreMatch[1]);
      const record = products.get(productId);
      if (publicState.records.has(productId)) throw new AdminHttpError(409, "公开版本尚未撤下，请先发布撤下并等待网站生效。");
      const active = (await publisher.list()).find(run => ["queued", "building", "uploading", "verifying"].includes(run.status)
        && (run.selectedProducts?.some(p => p.productId === productId) || (!run.selectedProducts?.length && run.surveyIds.includes(record.draft.surveyId))));
      if (active) throw new AdminHttpError(409, `相关发布任务 ${active.runId} 尚未结束，请等待或取消后再恢复。`);
      const product = await products.restore(productId, Number(body.revision), body.reason);
      await editorial.sync(adminInventoryIndex(runtimeSurveyIndex, products.list()).surveys);
      return json(response, 200, { product: adminProductView(product), syncStatus: await apiSyncStatus("products") });
    }
    const retireMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/retire$/.exec(pathname);
    const reviewMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/review$/.exec(pathname);
    if (reviewMatch?.[1] && request.method === "POST") {
      const body: Record<string, unknown> = await requestJsonBody(request).catch(() => ({} as Record<string, unknown>));
      if (Object.keys(body).some((key) => !["revision", "acceptedGaps"].includes(key))) throw new AdminHttpError(400, "Product review request contains unsupported field");
      if (body.acceptedGaps !== undefined && !Array.isArray(body.acceptedGaps)) throw new AdminHttpError(400, "acceptedGaps must be an array");
      if (Array.isArray(body.acceptedGaps) && body.acceptedGaps.some((value) => typeof value !== "string")) throw new AdminHttpError(400, "acceptedGaps must contain only strings");
      const acceptedGaps = Array.isArray(body.acceptedGaps)
        ? body.acceptedGaps.filter((value: unknown): value is string => typeof value === "string").map((value: string) => value.trim()).filter(Boolean)
        : [];
      const productId = decodeAdminPathSegment(reviewMatch[1]);
      const existing = products.get(productId);
      assertReviewableProduct(existing, acceptedGaps);
      await prepareProductGeometry(existing);
      const geometry = await productGeometry(existing, { root: catalog.root, files: catalog.manifest.files, publications: mocPublicationStore.list(), publicationFile: file => mocPublicationStore.absolutePath(file) });
      const product = await products.review(productId, expectedRevision(request, body), acceptedGaps, geometry?.facts ?? null);
      return json(response, 200, { product: adminProductView(product), readiness: productReadiness(product), syncStatus: await apiSyncStatus("products") });
    }
    if (retireMatch?.[1] && request.method === "POST") {
      const body: Record<string, unknown> = await requestJsonBody(request).catch(() => ({} as Record<string, unknown>));
      if (Object.keys(body).some((key) => !["revision", "reason"].includes(key))) throw new AdminHttpError(400, "Product retirement request contains unsupported field");
      const reason = body.reason === undefined ? undefined : typeof body.reason === "string" ? body.reason : (() => { throw new AdminHttpError(400, "reason must be a string"); })();
      const product = await products.retire(decodeAdminPathSegment(retireMatch[1]), expectedRevision(request, body), reason);
      runtimeSurveyIndex = applyPublishedProductMetadata(runtimeSurveyIndex);
      await editorial.sync(adminInventoryIndex(runtimeSurveyIndex, products.list()).surveys);
      return json(response, 200, { product: adminProductView(product), readiness: productReadiness(product), syncStatus: await apiSyncStatus("products") });
    }
    if (publishMatch?.[1] && request.method === "POST") {
      const body: Record<string, unknown> = await requestJsonBody(request).catch(() => ({} as Record<string, unknown>));
      const productId = decodeAdminPathSegment(publishMatch[1]);
      const existing = products.get(productId);
      const revision = expectedRevision(request, body);
      if (revision !== undefined && revision !== existing.revision) throw new AdminHttpError(409, "Product revision conflict");
      const plan = await publisher.plan();
      const run = await publisher.submit({planId:plan.planId,expectedBaselineSha256:plan.baselineBundle.sha256,surveyIds:[existing.draft.surveyId],productIds:[productId]}, "admin");
      return json(response,202,{product:adminProductView(existing),run});
    }

    const historyMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/history$/.exec(pathname);
    if (historyMatch?.[1] && request.method === "GET") {
      const allHistory = await products.history(decodeAdminPathSegment(historyMatch[1]));
      const history = allHistory.slice(-128).map(productHistorySummary);
      return json(response, 200, { history, truncated: history.length < allHistory.length });
    }
    if (pathname === "/api/v1/admin/publication-plan" && request.method === "GET") {
      return json(response, 200, { plan: await publisher.plan() });
    }
    if (pathname === "/api/v1/admin/publications" && request.method === "GET") {
      return json(response, 200, { runs: await publisher.list(), syncStatus: await apiSyncStatus("publication-runs") });
    }
    if (pathname === "/api/v1/admin/publications" && request.method === "POST") {
      const body = await requestJsonBody(request);
      if (body.rebuildPackages !== undefined && typeof body.rebuildPackages !== "boolean") throw new AdminHttpError(400, "rebuildPackages must be a boolean");
      const surveyIds = Array.isArray(body.surveyIds) ? body.surveyIds.filter((value): value is string => typeof value === "string") : [];
      const run = await publisher.submit({
        planId: typeof body.planId === "string" ? body.planId : "",
        expectedBaselineSha256: typeof body.expectedBaselineSha256 === "string" ? body.expectedBaselineSha256 : "",
        surveyIds,
        productIds: Array.isArray(body.productIds) ? body.productIds.filter((v):v is string=>typeof v==="string") : undefined,
        ...(body.rebuildPackages === true ? { rebuildPackages: true } : {}),
      }, "admin");
      return json(response, 202, { run, syncStatus: await apiSyncStatus("publication-runs") });
    }
    const publicationCancelMatch = /^\/api\/v1\/admin\/publications\/([^/]+)\/cancel$/.exec(pathname);
    if (publicationCancelMatch?.[1] && request.method === "POST") {
      if (!publicationScheduler) throw new AdminHttpError(409, "Cancellation requires the management backend");
      await publicationScheduler.cancel(decodeAdminPathSegment(publicationCancelMatch[1]));
      return json(response, 200, { run: await publisher.get(decodeAdminPathSegment(publicationCancelMatch[1])) });
    }
    const publicationMatch = /^\/api\/v1\/admin\/publications\/([^/]+)$/.exec(pathname);
    const publicationRetryMatch = /^\/api\/v1\/admin\/publications\/([^/]+)\/retry$/.exec(pathname);
    const publicationRecoverMatch = /^\/api\/v1\/admin\/publications\/([^/]+)\/recover$/.exec(pathname);
    const publicationVerifyMatch = /^\/api\/v1\/admin\/publications\/([^/]+)\/verify$/.exec(pathname);
    if (publicationRetryMatch?.[1] && request.method === "POST") {
      const body: Record<string, unknown> = await requestJsonBody(request).catch(() => ({} as Record<string, unknown>));
      if (Object.keys(body).length) throw new AdminHttpError(400, "Publication retry request contains unsupported field");
      const run = await publisher.retry(decodeAdminPathSegment(publicationRetryMatch[1]), adminFromRequest(request));
      return json(response, 202, { run, syncStatus: await apiSyncStatus("publication-runs") });
    }
    if (publicationRecoverMatch?.[1] && request.method === "POST") {
      const body: Record<string, unknown> = await requestJsonBody(request).catch(() => ({} as Record<string, unknown>));
      if (Object.keys(body).length) throw new AdminHttpError(400, "Publication recovery request contains unsupported field");
      const run = await publisher.recover(decodeAdminPathSegment(publicationRecoverMatch[1]), adminFromRequest(request));
      return json(response, 202, { run, syncStatus: await apiSyncStatus("publication-runs") });
    }
    if (publicationVerifyMatch?.[1] && request.method === "POST") {
      const run = await publisher.verifySite(decodeAdminPathSegment(publicationVerifyMatch[1]));
      return json(response, 200, { run, syncStatus: await apiSyncStatus("publication-runs") });
    }
    if (publicationMatch?.[1] && request.method === "GET") {
      const run = await publisher.get(decodeAdminPathSegment(publicationMatch[1]));
      if (!run) return json(response, 404, { error: "Publication run not found" });
      return json(response, 200, { run, syncStatus: await apiSyncStatus("publication-runs") });
    }
    return json(response, 404, { error: "Admin endpoint not found" });
  } catch (error) {
    if (error instanceof CoveragePrecisionError || error instanceof AdminHttpError || error instanceof KubernetesApiError || error instanceof PublicationConflictError || error instanceof ContentArchiveError) {
      return json(response, error.statusCode, { error: error.message });
    }
    console.error("Assets admin request failed", error instanceof Error ? error.message : String(error));
    return json(response, 500, { error: "Internal server error" });
  }
}

function sendCoverageBlock(request: IncomingMessage, response: ServerResponse, pathname: string): void {
  const match = /^\/api\/v1\/coverage\/blocks\/([a-z0-9-]+)$/.exec(pathname);
  if (!match) return json(response, 404, { error: "Coverage block not found" });
  const record = publicCoverageCatalog().records.get(match[1]!);
  if (!record) return json(response, 404, { error: "Coverage layer not found" });
  const query = requestQuery(request);
  const order = Number(query.get("order"));
  const tile = Number(query.get("tile"));
  if (!Number.isSafeInteger(order) || !Number.isSafeInteger(tile) || order < 0 || order > 29 || tile < 0) return json(response, 400, { error: "order and tile are required integers" });
  const block = coverageBlock(record, order, tile);
  if (!block) return json(response, 404, { error: "Coverage block is unavailable" });
  const requestedRevision = query.get("revision");
  if (requestedRevision && requestedRevision !== record.revision) {
    return json(response, 409, { error: "Coverage catalog revision changed", layerId: record.layerId, revision: record.revision });
  }
  const cacheControl = requestedRevision ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
  compressedJson(request, response, 200, { ...block, revision: record.revision }, cacheControl, `"sha256-${block.sha256}"`);
}

async function sendProtectedCoverageBlock(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
  return withRegionAccess(request, response, async () => {
    const body = await requestJsonBody(request, 16 * 1024);
    const layerId = typeof body.layerId === "string" ? body.layerId.trim() : "";
    const order = body.order;
    const tile = body.tile;
    const revision = typeof body.revision === "string" ? body.revision : undefined;
    const allowedLayers = new Set([
      "source-units-legacy-surveys-legacy-dr9-coadded-imaging",
      "source-units-legacy-surveys-legacy-dr9-tractor-catalog",
    ]);
    if (!allowedLayers.has(layerId) || order !== 4 || tile !== 0) {
      throw new AccessError(400, "A supported Legacy DR9 order-4 overview block is required");
    }
    const record = publicCoverageCatalog().records.get(layerId);
    if (!record || record.surveyId !== "legacy-surveys" || record.releaseId !== "legacy-dr9"
      || record.maxOrder !== 4 || record.overviewOrder !== 4 || record.availableOrders.length !== 1
      || record.availableOrders[0] !== 4 || record.sourceUnitIndex?.status !== "estimated") {
      throw new AccessError(503, "The locked Legacy DR9 overview is unavailable");
    }
    if (revision && revision !== record.revision) throw new AccessError(409, "Coverage catalog revision changed");
    const block = coverageBlock(record, 4, 0);
    if (!block) throw new AccessError(404, "Legacy DR9 overview block is unavailable");
    response.setHeader("Cache-Control", "no-store");
    const generatedAt = publicCoverageCatalog().generatedAt;
    return compressedJson(request, response, 200, {
      ...block,
      generatedAt: generatedAt && Number.isFinite(Date.parse(generatedAt)) ? generatedAt : new Date().toISOString(),
      layerId: record.layerId,
      surveyId: record.surveyId,
      releaseId: record.releaseId,
      product: record.product,
      modality: record.modality,
      availableOrders: record.availableOrders,
      overviewOrder: record.overviewOrder,
      maxOrder: record.maxOrder,
      cellCount: record.cellCount,
      revision: record.revision,
      sourceUnitIndex: record.sourceUnitIndex,
    }, "no-store", `"sha256-${block.sha256}"`);
  });
}

async function sendCoverageOverlap(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await awaitNativeSourceUnitCoverageLoad();
  const body = await requestJsonBody(request).catch(() => ({})) as Record<string, unknown>;
  const surveyIds = Array.isArray(body.surveyIds) ? body.surveyIds.filter((value): value is string => typeof value === "string") : [];
  const modalities = Array.isArray(body.modalities) ? body.modalities.filter((value): value is string => typeof value === "string") : [];
  const requestedOrder = typeof body.requestedOrder === "number" && Number.isInteger(body.requestedOrder) ? body.requestedOrder : undefined;
  const eligibleLayers = filterByModalities([...publicCoverageCatalog().records.values()], modalities);
  const result = overlapForLayers(eligibleLayers, surveyIds, requestedOrder);
  if (!result) return json(response, 400, { error: "At least two surveys with a common HEALPix order are required" });
  const selectedLayers = eligibleLayers.filter((layer) => surveyIds.includes(layer.surveyId));
  const componentDetails = result.components.map((component) => {
    const componentLayers = layersForOverlapComponent(selectedLayers, result, component);
    return {
      ...component,
      evidenceLookup: {
        endpoint: "/api/v1/coverage/reverse-lookup",
        layerIds: componentLayers.map((layer) => layer.layerId),
        order: component.order,
        precision: "estimated" as const,
        deferred: false as const,
      },
      surveys: componentLayers.map((layer) => ({
        surveyId: layer.surveyId,
        releaseId: layer.releaseId,
        product: layer.product,
        modality: layer.modality ?? "coverage",
      })),
    };
  });

  return compressedJson(request, response, 200, { ...result, components: componentDetails }, "public, max-age=60, stale-while-revalidate=120");
}

async function sendCoverageOverlapDetails(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await awaitNativeSourceUnitCoverageLoad();
  const body = await requestJsonBody(request).catch(() => ({})) as Record<string, unknown>;
  const surveyIds = Array.isArray(body.surveyIds) ? body.surveyIds.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const modalities = Array.isArray(body.modalities) ? body.modalities.filter((value): value is string => typeof value === "string") : [];
  const componentId = typeof body.componentId === "string" ? body.componentId : "";
  const requestedOrder = typeof body.requestedOrder === "number" && Number.isInteger(body.requestedOrder) ? body.requestedOrder : undefined;
  if (surveyIds.length < 2 || !componentId) return json(response, 400, { error: "surveyIds and componentId are required" });
  const eligibleLayers = filterByModalities([...publicCoverageCatalog().records.values()], modalities);
  const result = overlapForLayers(eligibleLayers, surveyIds, requestedOrder);
  if (!result) return json(response, 400, { error: "No common coverage is available for the selected surveys" });
  const component = result.components.find((candidate) => candidate.id === componentId);
  if (!component) return json(response, 404, { error: "Overlap component not found for the current survey selection" });
  const selectedLayers = eligibleLayers.filter((layer) => surveyIds.includes(layer.surveyId));
  const publishedSourcesByLayer = new Map(publicState.snapshot.products.flatMap((product) => {
    const layerId = product.geometry?.layerId;
    if (!layerId) return [];
    const content = product.content;
    return [[layerId, {
      sourceUrl: content.sourceUrl,
      officialDataUrl: content.officialDataUrl,
      officialQueryUrl: content.officialQueryUrl,
      geometrySourceUrl: content.geometrySourceUrl,
      publicDescription: content.publicDescription,
      dataOrigin: content.dataOrigin,
      sourceTier: content.sourceTier,
      sourceLabel: content.sourceLabel,
      geometrySourceLabel: content.geometrySourceLabel,
      coverageEvidence: content.coverageEvidence,
    }] as const];
  }));
  const details = buildOverlapDetails({ result, component, layers: selectedLayers, surveyIndex: publicSurveyIndex(), sourceIndex: runtimeSurveyIndex, publishedSourcesByLayer, catalog:publicState.catalog, sourceUnitsByLayer:new Map(), warehouseGeometry, warehouseSnapshots: await currentWarehouseOverlapSnapshots() });

  return compressedJson(request, response, 200, details, "public, max-age=60, stale-while-revalidate=120");
}

function publicReverseEntrypoints(layerIds: readonly string[], order: number, cells: readonly number[]): Array<Record<string, unknown>> {
  const requested = new Set(cells);
  return layerIds.flatMap((layerId) => {
    // Reverse lookup previews are a public contract. The runtime warehouse
    // catalog may contain only scanned layers, so use the published coverage
    // catalog here to keep entrypoint-only products visible as well.
    const layer = publicCoverageCatalog().records.get(layerId);
    if (!layer) return [];
    const matchedCells = (layer.cells.get(order) ?? []).filter((cell) => requested.has(cell));
    if (!matchedCells.length) return [];
    const survey = runtimeSurveyIndex.surveys.find((entry) => entry.id === layer.surveyId);
    const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
    const product = release?.products.find((entry) => entry.name === layer.product);
    const sourceUrl = publicExternalUrl(product?.sourceUrl);
    const officialDataUrl = publicExternalUrl(product?.officialDataUrl);
    const officialQueryUrl = publicExternalUrl(product?.officialQueryUrl);
    const geometrySourceLocator = publicLocator(product?.geometrySourceUrl ?? layer.recipe?.sourceUrl);
    const geometrySourceScope = geometrySourceLocator && /\.[a-z0-9]{1,12}(?:$|[?#])/i.test(geometrySourceLocator) ? "file" : "prefix";
    const geometrySourceUrl = publicExternalUrl(geometrySourceLocator);
    const mocAsset = [...catalog.files.entries()].find(([, entry]) => entry.record.kind === "moc"
      && entry.record.surveyId === layer.surveyId
      && entry.record.releaseId === layer.releaseId
      && entry.record.product === layer.product);
    return [{
      layerId,
      productId: layer.productId,
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
      order,
      nside: 2 ** order,
      cells: matchedCells,
      precision: "entrypoint-only",
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(officialDataUrl ? { officialDataUrl } : {}),
      ...(officialQueryUrl ? { officialQueryUrl } : {}),
      ...(geometrySourceUrl ? { geometrySourceUrl } : {}),
      ...(geometrySourceLocator ? { sourceUri: geometrySourceLocator, sourceScope: geometrySourceScope, sourcePurpose: layer.sourceUnitIndex?.unitKind === "file" ? "data-access" : "coverage-reference" } : {}),
      ...(mocAsset ? { mocUrl: `/api/v1/coverage/layers/${encodeURIComponent(layerId)}/moc.fits` } : {}),
      note: layer.sourceUnitIndex?.notes ?? "该图层提供公共覆盖范围，但当前没有本地原生空间分块索引；此入口不是分块清单。",
    }];
  });
}

function reverseEntrypointPrecision(value: unknown): DownloadPlanEntrypoint["precision"] {
  return value === "exact" || value === "estimated" || value === "entrypoint-only" || value === "truncated" ? value : "entrypoint-only";
}

function normalizeReverseEntrypoints(entries: Array<Record<string, unknown>>): DownloadPlanEntrypoint[] {
  return entries.flatMap((entry) => {
    const common = {
      ...(typeof entry.layerId === "string" ? { layerId: entry.layerId } : {}),
      ...(typeof entry.productId === "string" ? { productId: entry.productId } : {}),
      ...(typeof entry.surveyId === "string" ? { surveyId: entry.surveyId } : {}),
      ...(typeof entry.releaseId === "string" ? { releaseId: entry.releaseId } : {}),
      ...(typeof entry.product === "string" ? { product: entry.product } : {}),
      ...(typeof entry.order === "number" ? { order: entry.order } : {}),
      ...(typeof entry.nside === "number" ? { nside: entry.nside } : {}),
      ...(Array.isArray(entry.cells) ? { cells: entry.cells.filter((cell): cell is number => typeof cell === "number") } : {}),
      precision: reverseEntrypointPrecision(entry.precision),
      ...(typeof entry.note === "string" ? { note: entry.note } : {}),
    };
    const normalized: DownloadPlanEntrypoint[] = [];
    const addExternal = (kind: string, purpose: DownloadPlanEntrypoint["purpose"], key: "sourceUrl" | "officialDataUrl" | "officialQueryUrl" | "geometrySourceUrl"): void => {
      const url = publicExternalUrl(entry[key]);
      if (!url) return;
      normalized.push({ ...common, kind, purpose, url, [key]: url });
    };
    addExternal("official-release", "data-access", "sourceUrl");
    addExternal("official-data", "data-access", "officialDataUrl");
    addExternal("official-query", "data-access", "officialQueryUrl");
    addExternal("coverage-source", "coverage-reference", "geometrySourceUrl");
    const sourceUri = publicLocator(entry.sourceUri ?? entry.geometrySourceUrl);
    const sourceScope: DownloadPlanEntrypoint["sourceScope"] = entry.sourceScope === "file" ? "file" : "prefix";
    const sourcePurpose: DownloadPlanEntrypoint["purpose"] = entry.sourcePurpose === "data-access" ? "data-access" : "coverage-reference";
    if (sourceUri) {
      normalized.push({
        ...common,
        kind: "source-path",
        purpose: sourcePurpose,
        sourceUri,
        sourceScope,
        ...(publicExternalUrl(sourceUri) ? { url: publicExternalUrl(sourceUri) } : {}),
        note: sourcePurpose === "data-access"
          ? "原始数据来源路径；当前计划不展开到每个文件。"
          : "覆盖或清单来源路径；科学数据请使用对应的数据入口。",
      });
    }
    if (typeof entry.mocUrl === "string" && (entry.mocUrl.startsWith("/") || publicExternalUrl(entry.mocUrl))) {
      normalized.push({ ...common, kind: "coverage-moc", purpose: "coverage-reference", url: entry.mocUrl, mocUrl: entry.mocUrl });
    }
    return normalized;
  });
}

const PUBLIC_REVERSE_PREVIEW_LIMIT = 6;
const REVERSE_LOOKUP_BODY_MAX_BYTES = 1_310_720;
const reverseCursorSecret = process.env.ASSETS_REVERSE_CURSOR_SECRET?.trim() || randomUUID();

function reverseQueryFingerprint(layerIds: readonly string[], order: number, cells: readonly number[]): string {
  const revisions = [...new Set(layerIds)].sort().map((layerId) => ({ layerId, revision: publicCoverageCatalog().records.get(layerId)?.revision ?? "" }));
  return nativeSha256(JSON.stringify({
    releaseId: publicState.snapshot.releaseId,
    layerIds: [...new Set(layerIds)].sort(),
    order,
    cells: [...new Set(cells)].sort((left, right) => left - right),
    revisions,
    nativeUnitIndexRevision: requestNativeVersion(),
  }));
}
function reverseSelectorFingerprint(layerIds: readonly string[], order: number, cells: readonly number[]): string {
  return nativeSha256(JSON.stringify({ layerIds: [...new Set(layerIds)].sort(), order, cells: [...new Set(cells)].sort((a, b) => a - b) }));
}

function capReversePreview(plan: DownloadPlan, limit = PUBLIC_REVERSE_PREVIEW_LIMIT, seenKeys: ReadonlySet<string> = new Set()): { plan: DownloadPlan; shown: number; omitted: number; hasMore: boolean } {
  const remainingUnits = (plan.spatialUnits ?? []).filter((unit) => !seenKeys.has(reversePlanSpatialUnitKey(unit)));
  const remainingFiles = plan.files.filter((file) => !seenKeys.has(reversePlanFileKey(file)));
  const remainingEntrypoints = plan.entrypoints.filter((entry) => !seenKeys.has(reversePlanEntrypointKey(entry)));
  const remainingCoverage = (plan.coverageEvidence ?? []).filter((evidence) => !seenKeys.has(reversePlanCoverageEvidenceKey(evidence)));
  const spatialUnits: DownloadPlanSpatialUnit[] = [];
  const files: DownloadPlan["files"] = [];
  const entrypoints: DownloadPlanEntrypoint[] = [];
  const coverageEvidence: DownloadPlanCoverageEvidence[] = [];
  const selectedFiles = new Set<string>();
  const selectedEntrypoints = new Set<DownloadPlanEntrypoint>();
  const selectedCoverage = new Set<DownloadPlanCoverageEvidence>();
  const hasRoom = (): boolean => spatialUnits.length + files.length + entrypoints.length + coverageEvidence.length < limit;
  const addUnit = (unit: DownloadPlanSpatialUnit): void => {
    if (!hasRoom() || spatialUnits.some((candidate) => reversePlanSpatialUnitKey(candidate) === reversePlanSpatialUnitKey(unit))) return;
    spatialUnits.push(unit);
  };
  const fileLayerIds = (file: DownloadPlan["files"][number]): string[] => [...new Set(file.matchingCoverage.flatMap((match) => match.layerId ? [match.layerId] : []))];
  const entryLayerId = (entry: DownloadPlanEntrypoint): string => entry.layerId ?? `${entry.surveyId ?? ""}:${entry.releaseId ?? ""}:${entry.product ?? ""}`;
  const addFile = (file: DownloadPlan["files"][number]): void => {
    if (!hasRoom() || selectedFiles.has(file.fileId)) return;
    selectedFiles.add(file.fileId);
    files.push(file);
  };
  const addEntrypoint = (entry: DownloadPlanEntrypoint): void => {
    if (!hasRoom() || selectedEntrypoints.has(entry)) return;
    selectedEntrypoints.add(entry);
    entrypoints.push(entry);
  };
  const addCoverage = (evidence: DownloadPlanCoverageEvidence): void => {
    if (!hasRoom() || selectedCoverage.has(evidence)) return;
    selectedCoverage.add(evidence);
    coverageEvidence.push(evidence);
  };
  const dataEntrypoints = remainingEntrypoints.filter((entry) => entry.purpose === "data-access");
  // Prefer concrete Tile/file entrypoints in the bounded preview. General
  // release pages remain useful for layers without a file index, but they
  // must not hide a real Tile link from another selected survey.
  const concreteDataEntrypoints = dataEntrypoints.filter((entry) => entry.kind !== "official-release");
  const releaseEntrypoints = dataEntrypoints.filter((entry) => entry.kind === "official-release");
  const referenceEntrypoints = remainingEntrypoints.filter((entry) => entry.purpose !== "data-access");
  const preferredEntrypoints = [...concreteDataEntrypoints, ...releaseEntrypoints, ...referenceEntrypoints];
  const layerIds = [...new Set([
    ...remainingUnits.map((unit) => unit.layerId),
    ...remainingFiles.flatMap(fileLayerIds),
    ...preferredEntrypoints.map(entryLayerId),
    ...remainingCoverage.map((evidence) => evidence.layerId),
  ])];
  // Keep the preview representative by layer, then include the matching
  // coverage basis before filling remaining space with additional results.
  for (const layerId of layerIds) {
    const unit = remainingUnits.find((candidate) => candidate.layerId === layerId);
    const file = remainingFiles.find((candidate) => fileLayerIds(candidate).includes(layerId));
    const entry = preferredEntrypoints.find((candidate) => entryLayerId(candidate) === layerId);
    if (unit) addUnit(unit);
    else if (file) addFile(file);
    else if (entry) addEntrypoint(entry);
  }
  for (const layerId of layerIds) {
    const evidence = remainingCoverage.find((candidate) => candidate.layerId === layerId);
    if (evidence) addCoverage(evidence);
  }
  for (const unit of remainingUnits) addUnit(unit);
  for (const file of remainingFiles) addFile(file);
  for (const entry of preferredEntrypoints) addEntrypoint(entry);
  for (const evidence of remainingCoverage) addCoverage(evidence);
  const shown = spatialUnits.length + files.length + entrypoints.length + coverageEvidence.length;
  const total = remainingUnits.length + remainingFiles.length + remainingEntrypoints.length + remainingCoverage.length;
  const omitted = Math.max(0, total - shown);
  const hasMore = plan.truncated || omitted > 0 || Boolean(plan.tileSelections?.some((selection) => selection.tileIds.length > limit));
  const warnings = hasMore
    ? [...new Set([...plan.warnings, `匿名预览最多显示 ${limit} 项；完整反查需要 API Key，page.nextCursor 可在授权请求中接续。`])]
    : plan.warnings;
  return {
    shown,
    omitted,
    hasMore,
    plan: {
      ...plan,
      spatialUnits,
      files,
      entrypoints,
      ...(plan.coverageEvidence ? { coverageEvidence } : {}),
      tileSelections: undefined,
      truncated: hasMore,
      warnings,
    },
  };
}

async function publicSpatialUnits(layerIds: readonly string[], order: number, cells: readonly number[], limit: number, batch?: (layerId: string, units: DownloadPlanSpatialUnit[]) => void) {
  const layers = layerIds.flatMap((id) => { const layer = publicCoverageCatalog().records.get(id); return layer ? [layer] : []; });
  const archiveCandidates = layers.filter((layer) => layer.surveyId === "hst" || (layer.surveyId === "euclid" && layer.releaseId === "euclid-ero") || nativeBindingIndexRoute(layer) === "survey");
  const archiveLayers = archiveCandidates.filter(layer => nativeBindingEnabled(layer.layerId));
  const disabled = archiveCandidates.filter(layer => !nativeBindingEnabled(layer.layerId));
  const [hstIndex, eroIndex, surveyIndex] = await Promise.all([
    archiveLayers.some(layer => layer.surveyId === "hst") ? hstObservationIndex() : undefined,
    archiveLayers.some(layer => layer.surveyId === "euclid") ? eroTargetIndex() : undefined,
    archiveLayers.some(layer => nativeBindingIndexRoute(layer) === "survey") ? surveyNativeIndex() : undefined,
  ]);
  const [local, archive] = await Promise.all([
    localSpatialUnits(layers.filter((layer) => !archiveCandidates.includes(layer)).map((layer) => layer.layerId), order, cells, limit, batch),
    archiveNativeUnits(archiveLayers, order, cells, publicLookupStore, { hstIndex, eroIndex, surveyIndex, bindings: requestNativeGroup()?.bindings, limit }).then(result => { for (const layer of archiveLayers) batch?.(layer.layerId, result.units.filter(unit => unit.layerId === layer.layerId)); return result; }),
  ]);
  const units = [...local.units, ...archive.units].map(withSurveyProviderStatuses);
  return { units, indexedLayerIds: new Set([...local.indexedLayerIds, ...archive.indexedLayerIds]),
    unavailableLayerIds: [...local.unavailableLayerIds, ...archive.unavailableLayerIds, ...disabled.map(layer => layer.layerId)], truncated: local.truncated || archive.truncated || disabled.length > 0, notes: [...archive.notes, ...local.notes, ...(disabled.length ? ["Native lookup is unavailable for products absent from the active binding set or without a mapping in its locked inventory; source identities and entrypoints remain visible."] : [])] };
}

async function localSpatialUnits(layerIds: readonly string[], order: number, cells: readonly number[], limit: number, batch?: (layerId: string, units: DownloadPlanSpatialUnit[]) => void): Promise<{ units: DownloadPlanSpatialUnit[]; indexedLayerIds: Set<string>; unavailableLayerIds: string[]; truncated: boolean; notes: string[] }> {
  const layers = layerIds.map((layerId) => publicCoverageCatalog().records.get(layerId))
    .filter((layer): layer is CoverageCellLayer => layer !== undefined && !isWarehouseFilePartitionLayer(layer));
  if (!layers.length) return { units: [], indexedLayerIds: new Set(), unavailableLayerIds: [], truncated: false, notes: [] };
  const sourceUnits = await sourceUnitsReadyWithin(120_000);
  const unavailableLayerIds = new Set<string>();
  if (!sourceUnits) {
    layers.filter((layer) => layer.sourceUnitIndex?.status === "exact" || layer.sourceUnitIndex?.status === "estimated")
      .forEach((layer) => unavailableLayerIds.add(layer.layerId));
    return { units: [], indexedLayerIds: new Set(), unavailableLayerIds: [...unavailableLayerIds], truncated: false, notes: [] };
  }
  const units: DownloadPlanSpatialUnit[] = [];
  const indexedLayerIds = new Set<string>();
  const notes: string[] = [];
  let truncated = false;
  for (const layer of layers) {
    const active = requestNativeGroup();
    if (active && !active.bindings.some(binding => binding.layerId === layer.layerId)) { unavailableLayerIds.add(layer.layerId); continue; }
    const batchStart = units.length;
    const match = await Promise.resolve(sourceUnits.match(layer.layerId, order, [...cells], limit, {
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
    })).catch(() => null);
    if (!match) {
      if (layer.sourceUnitIndex?.status === "exact" || layer.sourceUnitIndex?.status === "estimated") unavailableLayerIds.add(layer.layerId);
      continue;
    }
    indexedLayerIds.add(layer.layerId);
    truncated ||= match.truncated;
    if (match.truncated) notes.push(`${layer.surveyId} / ${layer.releaseId} / ${layer.product}: native-unit lookup returned ${match.units.length} of ${match.totalUnits} units at its ${limit}-unit result limit.`);
    if (!match.units.length) notes.push(`${layer.surveyId} / ${layer.releaseId} / ${layer.product}: the current native-unit inventory returned no match in this region; this does not establish that the survey has no data. ${match.notes}`);
    for (const unit of match.units) {
      const sourceAccessRows = unit.accessUris?.flatMap((entry) => {
        const uri = publicExternalUrl(entry.url);
        if (!uri) return [];
        const fileName = entry.fileName;
        const accessType = layer.surveyId === "hsc-ssp" ? "entrypoint" as const : uri.endsWith("/") ? "directory" as const : "file" as const;
        return [{ uri, ...(fileName ? { fileName } : {}), accessType,
          alternatives: alternativesForAccessUri(uri, { surveyId: layer.surveyId, releaseId: layer.releaseId, fileName,
            accessType, band: fileName?.match(/(?:MOSAIC-)?(?:NISP-)?([YJH]|VIS)(?:_|-)/i)?.[1] }) }];
      }) ?? [];
      const accessUri = publicExternalUrl(unit.downloadUrl);
      const accessUris = sourceAccessRows.length ? sourceAccessRows : accessUri ? [{ uri: accessUri,
        accessType: layer.surveyId === "hsc-ssp" ? "entrypoint" as const : unit.unitKind === "tile" || accessUri.endsWith("/") ? "directory" as const : "file" as const,
        alternatives: alternativesForAccessUri(accessUri, { surveyId: layer.surveyId, releaseId: layer.releaseId,
          accessType: layer.surveyId === "hsc-ssp" ? "entrypoint" : unit.unitKind === "tile" || accessUri.endsWith("/") ? "directory" : "file" }) }] : [];
      units.push({
        layerId: layer.layerId,
        productId: layer.productId,
        surveyId: layer.surveyId,
        releaseId: layer.releaseId,
        product: layer.product,
        ...(layer.modality ? { modality: layer.modality } : {}),
        unitKind: unit.unitKind,
        unitId: unit.unitId,
        order,
        nside: 2 ** order,
        matchingCells: unit.matchingCells,
        precision: unit.geometryPrecision,
        ...(accessUris.length ? { accessUri: accessUris[0]!.uri } : {}),
        ...(accessUris?.length ? { accessUris } : {}),
        ...(unit.accessAvailability ? { accessAvailability: unit.accessAvailability } : {}),
        sourceSnapshotSha256: unit.sourceSnapshotSha256,
        note: [match.notes, unit.note].filter((part): part is string => Boolean(part)).join(" "),
      });
    }
    batch?.(layer.layerId, units.slice(batchStart));
  }
  units.sort((left, right) => left.layerId.localeCompare(right.layerId) || left.unitKind.localeCompare(right.unitKind) || left.unitId.localeCompare(right.unitId, undefined, { numeric: true }));
  return { units, indexedLayerIds, unavailableLayerIds: [...unavailableLayerIds], truncated, notes };
}

async function withRegionAccess(request:IncomingMessage,response:ServerResponse,action:(identity:string)=>Promise<void>):Promise<void> {
  const token = request.headers["x-assets-api-key"];
  const managedHeader = typeof token === "string" && token.startsWith(MANAGED_KEY_PREFIX);
  const managedCookie = /(?:^|;\s*)assets_download=managed\./.test(String(request.headers.cookie ?? ""));
  if (role === "site" && (managedHeader || managedCookie)) {
    if (!managedHeader) accessGate.sameOrigin(request);
    return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
  }
  const identity = managedHeader ? undefined : accessGate.identity(request);
  if (!managedHeader && !identity?.startsWith("managed-key:")) return action(identity!);
  if (!apiManagement) throw new AccessError(503, "API management unavailable");
  const route = requestPath(request), started = Date.now();
  const id = managedHeader ? apiManagement.authorize(token as string, "region:query", route) : apiManagement.authorizeId(identity!.slice("managed-key:".length), "region:query", route);
  let status = 200;
  try { await action(`managed-key:${id}`); }
  catch (e) { status = e instanceof AccessError || e instanceof AdminHttpError ? e.statusCode : 500; throw e; }
  finally { apiManagement.recordKey(id, route, status, Date.now()-started); }
}

async function sendCoverageReverseLookup(request:IncomingMessage,response:ServerResponse):Promise<void> {
  if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
  const body=await requestJsonBody(request,REVERSE_LOOKUP_BODY_MAX_BYTES);
  const preview=body.preview===true;
  const stream = new ReverseStream(request, response);
  const action=async (identity:string) => {
    try { await buildCoverageReverseLookup(request,response,body,identity,preview,stream); }
    catch (error) {
      if (stream.enabled && response.headersSent) { stream.emit("error", { status: error instanceof AccessError || error instanceof AdminHttpError ? error.statusCode : 500, error: error instanceof Error ? error.message : "Reverse lookup failed" }); }
      throw error;
    }
  };
  if (preview) return action(`preview:${request.socket.remoteAddress ?? "unknown"}`);
  return withRegionAccess(request,response,action);
}

const REVERSE_BATCHES_PER_REQUEST = 32;
const REVERSE_BATCH_SEEN_KEY_LIMIT = 100_000;
const REVERSE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

interface ReverseBatchBuildOptions {
  index: number;
  count: number;
  fingerprint: string;
  selectorFingerprint: string;
  expiresAt: string;
  rootSnapshotId?: string;
  queryComplete: boolean;
  resultTruncated: boolean;
  seenKeys: string[];
  unitCounts: Record<string, number>;
}

interface ReverseBatchBuildResult { snapshot: ReverseSnapshot; snapshotId: string }

function reversePlanKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function filterReversePlanForBatches(plan: DownloadPlan, priorKeys: readonly string[]): { plan: DownloadPlan; seenKeys: string[]; stoppedAtLimit: boolean } {
  const seen = new Set(priorKeys);
  const next = new Set<string>();
  let stoppedAtLimit = false;
  const keep = (key: string): boolean => {
    const hash = reversePlanKeyHash(key);
    if (seen.has(hash) || next.has(hash)) return false;
    if (seen.size + next.size >= REVERSE_BATCH_SEEN_KEY_LIMIT) { stoppedAtLimit = true; return false; }
    next.add(hash);
    return true;
  };
  const filtered: DownloadPlan = {
    ...plan,
    ...(plan.spatialUnits ? { spatialUnits: plan.spatialUnits.filter((unit) => keep(reversePlanSpatialUnitKey(unit))) } : {}),
    files: plan.files.filter((file) => keep(reversePlanFileKey(file))),
    entrypoints: plan.entrypoints.filter((entry) => keep(reversePlanEntrypointKey(entry))),
    ...(plan.coverageEvidence ? { coverageEvidence: plan.coverageEvidence.filter((entry) => keep(reversePlanCoverageEvidenceKey(entry))) } : {}),
  };
  if (stoppedAtLimit) {
    filtered.truncated = true;
    filtered.warnings = [...new Set([...filtered.warnings, `Reverse lookup stopped after ${REVERSE_BATCH_SEEN_KEY_LIMIT} unique manifest identities; matching results remain incomplete.`])];
  }
  return { plan: filtered, seenKeys: [...seen, ...next], stoppedAtLimit };
}

function planWithReverseItems(plan: DownloadPlan, items: ReturnType<typeof reversePlanItems>): DownloadPlan {
  return {
    ...plan,
    spatialUnits: items.flatMap((item) => item.kind === "spatial-unit" ? [item.value] : []),
    files: items.flatMap((item) => item.kind === "file" ? [item.value] : []),
    entrypoints: items.flatMap((item) => item.kind === "entrypoint" ? [item.value] : []),
    coverageEvidence: items.flatMap((item) => item.kind === "coverage-evidence" ? [item.value] : []),
    tileSelections: undefined,
  };
}

function reversePageItemCount(plan: DownloadPlan): number {
  return (plan.spatialUnits?.length ?? 0) + plan.files.length + plan.entrypoints.length + (plan.coverageEvidence?.length ?? 0);
}

async function buildBatchedCoverageReverseLookup(
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
  identity: string,
  stream: ReverseStream,
  cellBatches: number[][],
  order: number,
  fingerprint: string,
  selectorFingerprint: string,
  pageScope: ReverseCursorScope,
  pageSize: number,
): Promise<void> {
  const cursor = decodeSnapshotCursor(body.cursor, identity, undefined, pageScope, reverseCursorSecret);
  if (cursor && body.querySnapshotId !== undefined && (cursor.rootSnapshotId ?? cursor.snapshotId) !== body.querySnapshotId) {
    throw new AccessError(400, "Cursor and query snapshot do not match");
  }

  let rootSnapshotId: string | undefined;
  let snapshotExpiresAt = new Date(Date.now() + 3600_000).toISOString();
  let batchIndex = 0;
  let currentSnapshot: ReverseSnapshot | undefined;
  let currentSnapshotId: string | undefined;
  let currentCursor = cursor;
  let queryComplete = true;
  let resultTruncated = false;
  let seenKeys: string[] = [];
  let unitCounts: Record<string, number> = {};

  const rootId = cursor?.rootSnapshotId ?? (typeof body.querySnapshotId === "string" ? body.querySnapshotId : undefined);
  if (rootId) {
    const root = await readReverseSnapshot(publicLookupStore, rootId, identity, fingerprint, selectorFingerprint);
    if (!root.batch || root.batch.index !== 0 || root.batch.count !== cellBatches.length || root.fingerprint !== fingerprint) {
      throw new AccessError(409, "Reverse lookup source revisions changed; restart the region query");
    }
    rootSnapshotId = rootId;
    snapshotExpiresAt = root.expiresAt;
    if (cursor) {
      if (!cursor.rootSnapshotId || cursor.batchIndex === undefined || cursor.batchIndex >= cellBatches.length) {
        throw new AccessError(400, "Reverse lookup batch cursor is invalid");
      }
      if (cursor.snapshotId === rootId) {
        currentSnapshot = root;
        currentSnapshotId = rootId;
        if (cursor.batchIndex > root.batch.index) currentSnapshot = undefined;
      } else {
        const state = await readReverseSnapshot(publicLookupStore, cursor.snapshotId, identity, fingerprint, selectorFingerprint);
        if (!state.batch || state.batch.count !== root.batch.count
          || (state.batch.rootSnapshotId ?? (state.batch.index === 0 ? cursor.snapshotId : undefined)) !== rootId) {
          throw new AccessError(409, "Cursor does not match its frozen batch");
        }
        if (cursor.batchIndex === state.batch.index) {
          currentSnapshot = state;
          currentSnapshotId = cursor.snapshotId;
        } else if (cursor.batchIndex === state.batch.index + 1) {
          currentSnapshot = undefined;
        } else {
          throw new AccessError(400, "Reverse lookup batch cursor is out of sequence");
        }
        batchIndex = cursor.batchIndex;
        queryComplete = cursor.queryComplete ?? state.batch.queryComplete;
        resultTruncated = cursor.resultTruncated ?? state.batch.resultTruncated;
        seenKeys = state.batch.seenKeys ?? [];
        unitCounts = state.batch.unitCounts ?? {};
      }
      if (cursor.snapshotId === rootId) {
        batchIndex = cursor.batchIndex;
        queryComplete = cursor.queryComplete ?? root.batch.queryComplete;
        resultTruncated = cursor.resultTruncated ?? root.batch.resultTruncated;
        seenKeys = root.batch.seenKeys ?? [];
        unitCounts = root.batch.unitCounts ?? {};
      }
    } else {
      currentSnapshot = root;
      currentSnapshotId = rootId;
      batchIndex = 0;
      queryComplete = root.batch.queryComplete;
      resultTruncated = root.batch.resultTruncated;
      seenKeys = root.batch.seenKeys ?? [];
      unitCounts = root.batch.unitCounts ?? {};
    }
  }

  const selected: DownloadPlan = { schemaVersion: 1, spatialUnits: [], files: [], entrypoints: [], coverageEvidence: [], warnings: [], truncated: false };
  const selectedKeys = new Set<string>();
  const processedSnapshots: ReverseSnapshot[] = [];
  let lastPage: Record<string, any> | undefined;
  let lastSnapshot: ReverseSnapshot | undefined;
  let lastSnapshotId: string | undefined;
  let executedBatches = 0;

  while (batchIndex < cellBatches.length) {
    if (!currentSnapshot) {
      if (executedBatches >= REVERSE_BATCHES_PER_REQUEST) break;
      const built = await buildCoverageReverseLookup(request, response, {
        ...body,
        cells: cellBatches[batchIndex],
        cursor: undefined,
        querySnapshotId: undefined,
        preview: false,
      }, identity, false, stream, {
        index: batchIndex,
        count: cellBatches.length,
        fingerprint,
        selectorFingerprint,
        expiresAt: snapshotExpiresAt,
        ...(rootSnapshotId ? { rootSnapshotId } : {}),
        queryComplete,
        resultTruncated,
        seenKeys,
        unitCounts,
      });
      if (!built || !("snapshot" in built)) throw new Error("Reverse lookup batch did not produce a frozen snapshot");
      currentSnapshot = built.snapshot;
      currentSnapshotId = built.snapshotId;
      rootSnapshotId ??= built.snapshotId;
      executedBatches++;
    }
    if (!currentSnapshotId) throw new Error("Reverse lookup batch snapshot ID is unavailable");

    const remainingPageSize = Math.max(1, pageSize - reversePageItemCount(selected));
    const page = snapshotPage(currentSnapshot, currentSnapshotId, identity, reverseCursorSecret, {
      scope: pageScope,
      pageSize: remainingPageSize,
      ...(currentCursor && currentCursor.batchIndex === currentSnapshot.batch?.index ? { cursor: currentCursor } : {}),
      rootSnapshotId,
    });
    const pagePlan = page.downloadPlan as DownloadPlan;
    for (const item of reversePlanItems(pagePlan)) {
      const hash = reversePlanKeyHash(item.key);
      if (selectedKeys.has(hash)) continue;
      selectedKeys.add(hash);
      if (item.kind === "spatial-unit") selected.spatialUnits!.push(item.value);
      else if (item.kind === "file") selected.files.push(item.value);
      else if (item.kind === "entrypoint") selected.entrypoints.push(item.value);
      else selected.coverageEvidence!.push(item.value);
    }
    selected.warnings.push(...pagePlan.warnings);
    selected.scanScopes = [...(selected.scanScopes ?? []), ...(pagePlan.scanScopes ?? [])];
    selected.truncated ||= pagePlan.truncated;
    processedSnapshots.push(currentSnapshot);
    lastPage = page;
    lastSnapshot = currentSnapshot;
    lastSnapshotId = currentSnapshotId;
    queryComplete = currentSnapshot.batch?.queryComplete ?? false;
    resultTruncated = currentSnapshot.batch?.resultTruncated ?? true;
    seenKeys = currentSnapshot.batch?.seenKeys ?? seenKeys;
    unitCounts = currentSnapshot.batch?.unitCounts ?? unitCounts;

    const manifestPage = page.page as Record<string, any> | undefined;
    const spatialPage = page.spatialPage as Record<string, any> | undefined;
    const supportingPage = page.supportingPage as Record<string, any> | undefined;
    const nextToken = pageScope === "manifest" ? manifestPage?.nextCursor : pageScope === "spatial-units" ? spatialPage?.nextCursor : supportingPage?.nextCursor;
    if (!nextToken) break;
    const nextCursor = decodeSnapshotCursor(nextToken, identity, undefined, pageScope, reverseCursorSecret);
    if (!nextCursor || nextCursor.batchIndex === undefined || nextCursor.batchIndex >= cellBatches.length) break;
    if (reversePageItemCount(selected) >= pageSize) { currentCursor = nextCursor; break; }
    if (nextCursor.batchIndex === currentSnapshot.batch?.index) {
      currentCursor = nextCursor;
      continue;
    }
    batchIndex = nextCursor.batchIndex;
    currentSnapshot = undefined;
    currentSnapshotId = undefined;
    currentCursor = nextCursor;
    queryComplete = nextCursor.queryComplete ?? queryComplete;
    resultTruncated = nextCursor.resultTruncated ?? resultTruncated;
    if (executedBatches >= REVERSE_BATCHES_PER_REQUEST) break;
  }

  if (!lastPage || !lastSnapshot || !lastSnapshotId || !rootSnapshotId) throw new AccessError(410, "Reverse lookup snapshot is unavailable; repeat the region query");
  const batch = lastSnapshot.batch!;
  const queryCompleteFinal = batch.queryComplete;
  const resultTruncatedFinal = batch.resultTruncated;
  const hasMore = pageScope === "manifest" ? Boolean(lastPage.page?.hasMore) : Boolean(pageScope === "spatial-units" ? lastPage.spatialPage?.hasMore : lastPage.supportingPage?.hasMore);
  selected.warnings = [...new Set(selected.warnings)];
  selected.scanScopes = [...new Map((selected.scanScopes ?? []).map((scope) => [JSON.stringify(scope), scope])).values()];
  selected.truncated ||= hasMore || resultTruncatedFinal || Boolean(batch.stoppedAtLimit);

  const mergedSources = new Map<string, Record<string, any>>();
  for (const snapshot of processedSnapshots) {
    const sources = Array.isArray(snapshot.response.sources) ? snapshot.response.sources as Array<Record<string, any>> : [];
    for (const source of sources) {
      const layerId = typeof source.layerId === "string" ? source.layerId : undefined;
      if (!layerId) continue;
      const previous = mergedSources.get(layerId);
      const oldCells = Array.isArray(previous?.cells) ? previous!.cells as number[] : [];
      const newCells = Array.isArray(source.cells) ? source.cells as number[] : [];
      const sourceCount = unitCounts[layerId] ?? Number(source.sourceUnitSummary?.matchedUnitCount ?? 0);
      const oldCount = Number(previous?.sourceUnitSummary?.matchedUnitCount ?? 0);
      const preferred = sourceCount > oldCount ? source : previous ?? source;
      mergedSources.set(layerId, {
        ...preferred,
        cells: [...new Set([...oldCells, ...newCells])].sort((left, right) => left - right),
        sourceUnitSummary: {
          ...(preferred.sourceUnitSummary ?? source.sourceUnitSummary ?? {}),
          matchedUnitCount: Math.max(oldCount, sourceCount),
          truncated: Boolean(previous?.sourceUnitSummary?.truncated || source.sourceUnitSummary?.truncated || resultTruncatedFinal),
        },
      });
    }
  }
  const responseSources = (body.layerIds as string[]).flatMap((layerId) => {
    const source = mergedSources.get(layerId);
    if (!source) return [];
    const count = unitCounts[layerId] ?? Number(source.sourceUnitSummary?.matchedUnitCount ?? 0);
    return [{ ...source, sourceUnitSummary: { ...(source.sourceUnitSummary ?? {}), matchedUnitCount: count, truncated: Boolean(source.sourceUnitSummary?.truncated || resultTruncatedFinal) } }];
  });
  const notes = [...new Set(processedSnapshots.flatMap((snapshot) => Array.isArray(snapshot.response.notes) ? snapshot.response.notes as string[] : []))];
  const warnings = [...new Set(processedSnapshots.flatMap((snapshot) => snapshot.response.downloadPlan.warnings ?? []))];
  const allSourcesAvailable = processedSnapshots.some((snapshot) => snapshot.response.available === true);
  const topPrecision = resultTruncatedFinal ? "truncated" : processedSnapshots.some((snapshot) => snapshot.response.precision === "estimated") ? "estimated" : lastSnapshot.response.precision;
  const outputPlan: DownloadPlan = {
    ...lastSnapshot.response.downloadPlan,
    spatialUnits: selected.spatialUnits,
    files: selected.files,
    entrypoints: selected.entrypoints,
    coverageEvidence: selected.coverageEvidence,
    tileSelections: undefined,
    warnings,
    scanScopes: selected.scanScopes,
    truncated: selected.truncated,
  };
  const consumedBatches = batch.index + 1;
  const output = {
    ...lastPage,
    available: allSourcesAvailable,
    precision: topPrecision,
    requested: { layerIds: body.layerIds, order, cells: body.cells },
    sources: responseSources,
    notes,
    downloadPlan: outputPlan,
    truncated: outputPlan.truncated,
    querySnapshot: {
      id: rootSnapshotId,
      expiresAt: snapshotExpiresAt,
      queryExhausted: consumedBatches === cellBatches.length && queryCompleteFinal,
      inventoryComplete: false,
      resultTruncated: resultTruncatedFinal,
      batch: {
        completed: consumedBatches,
        total: cellBatches.length,
        batchComplete: true,
        complete: consumedBatches === cellBatches.length,
        queryComplete: queryCompleteFinal,
        remaining: cellBatches.length - consumedBatches,
      },
    },
    expiresAt: snapshotExpiresAt,
    ...(pageScope === "manifest" ? { page: {
      ...lastPage.page,
      pageSize,
      shown: reversePageItemCount(selected),
      omitted: Number(lastPage.page?.omitted ?? 0),
      hasMore,
    } } : {}),
    spatialPage: { ...lastPage.spatialPage, shown: selected.spatialUnits?.length ?? 0 },
    supportingPage: { ...lastPage.supportingPage, shown: selected.files.length + selected.entrypoints.length + (selected.coverageEvidence?.length ?? 0) },
    edges: [],
    sourceFiles: [],
  };
  if (stream.enabled) stream.emit("complete", output); else compressedJson(request, response, 200, output, "no-store");
}

async function buildCoverageReverseLookup(request:IncomingMessage,response:ServerResponse,body:Record<string,unknown>,identity:string,preview:boolean,stream:ReverseStream,internalBatch?:ReverseBatchBuildOptions):Promise<void|ReverseBatchBuildResult> {
  await awaitNativeSourceUnitCoverageLoad();
  if(!Array.isArray(body.layerIds)||body.layerIds.some(id=>typeof id!=="string"))throw new AccessError(400,"layerIds required");
  if (!Number.isSafeInteger(body.order) || Number(body.order) < 0 || Number(body.order) > 13 || !Array.isArray(body.cells)) throw new AccessError(400, "order and cells are required");
  const pageScope: ReverseCursorScope = body.pageKind === "spatial-units" || body.pageKind === "supporting-evidence" ? body.pageKind : "manifest";
  if (body.pageKind !== undefined && body.pageKind !== "spatial-units" && body.pageKind !== "supporting-evidence") throw new AccessError(400, "pageKind must be spatial-units or supporting-evidence");
  const order = Number(body.order);
  const requestedCellsInput = body.cells as number[];
  if (requestedCellsInput.length > 4096) throw new AccessError(400, "A reverse lookup may contain at most 4096 cells");
  const uniqueRequestedCells = [...new Set(requestedCellsInput)].sort((left, right) => left - right);
  const cellBatches = partitionReverseCells(order, uniqueRequestedCells);
  const fingerprint = internalBatch?.fingerprint ?? reverseQueryFingerprint(body.layerIds as string[], order, requestedCellsInput);
  const selectorFingerprint = internalBatch?.selectorFingerprint ?? reverseSelectorFingerprint(body.layerIds as string[], order, requestedCellsInput);
  const cursor = decodeSnapshotCursor(body.cursor, identity, undefined, pageScope, reverseCursorSecret);
  if (preview && cursor) throw new AccessError(400, "Anonymous preview requests cannot continue a reverse lookup cursor");
  if (cursor && cursor.identity !== "preview" && cursor.identity !== identity) {
    throw new AccessError(403, "Reverse lookup cursor belongs to another access mode");
  }
  const requestedPageSize = reversePageSize(body.pageSize);
  const pageSize = preview ? PUBLIC_REVERSE_PREVIEW_LIMIT : requestedPageSize ?? 100;
  let batchIndex = internalBatch?.index ?? 0;
  let batchCount = internalBatch?.count ?? cellBatches.length;
  let batchRootSnapshotId: string | undefined = internalBatch?.rootSnapshotId;
  let priorBatchQueryComplete = internalBatch?.queryComplete ?? true;
  let priorBatchResultTruncated = internalBatch?.resultTruncated ?? false;
  let snapshotExpiresAt: string | undefined = internalBatch?.expiresAt;
  const regionBatchIndex = internalBatch ? 0 : batchIndex;
  if (!internalBatch && !preview && (cellBatches.length > 1 || cursor?.rootSnapshotId)) {
    await buildBatchedCoverageReverseLookup(request, response, body, identity, stream, cellBatches, order, fingerprint, selectorFingerprint, pageScope, pageSize);
    return;
  }
  if (!internalBatch && (cursor || body.querySnapshotId !== undefined)) {
    if (preview) throw new AccessError(400, "Anonymous preview cannot select a query snapshot");
    const cursorRootId = cursor?.rootSnapshotId ?? cursor?.snapshotId;
    if (cursor && body.querySnapshotId !== undefined && cursorRootId !== body.querySnapshotId) throw new AccessError(400, "Cursor and query snapshot do not match");
    if (cursor?.rootSnapshotId && cursor.batchIndex !== undefined) {
      const rootId = cursor.rootSnapshotId;
      const root = await readReverseSnapshot(publicLookupStore, rootId, identity, fingerprint, selectorFingerprint);
      if (!root.batch || root.batch.index !== 0 || root.batch.count !== cellBatches.length || root.fingerprint !== fingerprint) {
        throw new AccessError(409, "Reverse lookup source revisions changed; restart the region query");
      }
      if (Date.parse(root.expiresAt) <= Date.now()) throw new AccessError(410, "Reverse lookup snapshot expired; repeat the region query");
      if (cursor.batchIndex < root.batch.index || cursor.batchIndex >= root.batch.count) throw new AccessError(400, "Reverse lookup batch cursor is out of sequence");
      if (cursor.snapshotId === rootId && cursor.batchIndex > root.batch.index) {
        if (cursor.batchIndex === 0 || cursor.queryComplete === undefined || cursor.resultTruncated === undefined) {
          throw new AccessError(400, "Reverse lookup batch cursor is invalid");
        }
        batchRootSnapshotId = rootId;
        batchIndex = cursor.batchIndex;
        batchCount = root.batch.count;
        priorBatchQueryComplete = cursor.queryComplete;
        priorBatchResultTruncated = cursor.resultTruncated;
        snapshotExpiresAt = root.expiresAt;
      } else {
        const snapshot = await readReverseSnapshot(publicLookupStore, cursor.snapshotId, identity, fingerprint, selectorFingerprint);
        if (cursor.fingerprint !== snapshot.fingerprint || !snapshot.batch
          || snapshot.batch.index !== cursor.batchIndex || snapshot.batch.count !== root.batch.count
          || (snapshot.batch.rootSnapshotId ?? cursor.snapshotId) !== rootId) throw new AccessError(409, "Cursor does not match its frozen batch");
        const page = snapshotPage(snapshot, cursor.snapshotId, identity, reverseCursorSecret, { scope: pageScope, pageSize, cursor, rootSnapshotId: rootId });
        if (stream.enabled) stream.emit("complete", page); else compressedJson(request, response, 200, page, "no-store");
        return;
      }
    } else {
      const id = cursor?.snapshotId ?? body.querySnapshotId;
      const snapshot = await readReverseSnapshot(publicLookupStore, id, identity, fingerprint, selectorFingerprint);
      if (cursor && cursor.fingerprint !== snapshot.fingerprint) throw new AccessError(409, "Cursor does not match its frozen snapshot");
      const page = snapshotPage(snapshot, id as string, identity, reverseCursorSecret, { scope: pageScope, pageSize, cursor });
      if (stream.enabled) stream.emit("complete", page); else compressedJson(request, response, 200, page, "no-store");
      return;
    }
  }
  const excludeFileIds: string[] = [];
  const queryLimit = body.limit ?? 1000;
  const sourceUnitLimit = 50_000;
  const sourceDescriptors = (body.layerIds as string[]).map((layerId) => {
    const layer = publicCoverageCatalog().records.get(layerId);
    if (!layer) throw new AccessError(404, "Coverage layer not found");
    const productRecord = publicState.snapshot.products.find((product) => product.productId === layer.productId);
    return { layer, productRecord };
  });
  const validatedRegion = validateRegion({
    purpose: "download-plan",
    region: { coordinateFrame: "ICRS", ordering: "NESTED", order, cells: cellBatches[regionBatchIndex]! },
    sources: sourceDescriptors.map(({ layer, productRecord }) => ({
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      productId: layer.productId,
      layerId: layer.layerId,
      coverageRevision: productRecord?.geometry?.coverageRevision ?? layer.revision ?? "runtime-source-unit",
      indexRevision: productRecord?.geometry?.indexRevision ?? null,
    })),
    ...(typeof queryLimit === "number" ? { limit: queryLimit } : {}),
  }, 64);
  const cells = validatedRegion.region.cells;
  const regionSources = sourceDescriptors.flatMap(({ layer, productRecord }) => {
    const geometry = productRecord?.geometry;
    if (!geometry || geometry.layerId !== layer.layerId) return [];
    return [{
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      productId: productRecord.productId,
      layerId: geometry.layerId,
      coverageRevision: geometry.coverageRevision,
      indexRevision: geometry.indexRevision,
    }];
  });
  stream.emit("progress", { stage: "query", state: "running", nativeUnitIndexRevision: requestNativeVersion() });
  const regionPromise = (regionSources.length
    ? executeRegionQuery(request, { purpose: "download-plan", region: validatedRegion.region, sources: regionSources, limit: queryLimit }, identity, 64)
    : Promise.resolve({ sources: [] as Array<Record<string, unknown>>, expiresAt: new Date(Date.now() + 600_000).toISOString() })).then(result => { stream.emit("progress", { stage: "coverage", state: "completed" }); return result; });
  const nativePromise = publicSpatialUnits(body.layerIds as string[], order, cells, sourceUnitLimit, (layerId, units) => {
    stream.emit("progress", { stage: "native", layerId, state: "completed", total: units.length });
    if (!preview && units.length) stream.emit("batch", { stage: "native", layerId, units: units.slice(0, 100), total: units.length, provisional: true });
  });
  const warehouseResults = new Map<string, ReverseLookupResult>();
  const warehouseUnavailableLayers = new Set<string>();
  const warehouseResultLimitNotes: string[] = [];
  const warehousePromise = (async () => { if (evidenceStore.configured) {
    const lookups = await Promise.all(sourceDescriptors.map(async ({ layer }) => {
      const layerId = layer.layerId;
      try {
        let lookup = await evidenceStore.reverseLookup({
          layerIds: [layerId],
          // Derive only from the server's published product identity, never
          // from a browser-supplied evidence layer or an arbitrary ES match.
          evidenceLayerBindings: [{ layerId, evidenceLayerId: batchEvidenceLayerId(layer.productId) }],
          ...(excludeFileIds.length ? { excludeFileIds } : {}),
          order,
          cells,
          limit: 1000,
        }, { tolerateUnavailable: true });
        if (lookup.available && lookup.truncated && lookup.nextSearchAfter) {
          const edges = [...lookup.edges];
          const files = [...lookup.sourceFiles];
          const scopes = JSON.stringify(lookup.scanScopes ?? []);
          const cursors = new Set<string>();
          while (lookup.truncated && lookup.nextSearchAfter && edges.length < 50_000) {
            const after = lookup.nextSearchAfter;
            const key = JSON.stringify(after);
            if (cursors.has(key)) break;
            cursors.add(key);
            const next = await evidenceStore.reverseLookup({ layerIds: [layerId], evidenceLayerBindings: [{ layerId, evidenceLayerId: batchEvidenceLayerId(layer.productId) }],
              order, cells, limit: 1000, searchAfter: after }, { tolerateUnavailable: true });
            if (!next.available || scopes !== JSON.stringify(next.scanScopes ?? [])) break;
            edges.push(...next.edges); files.push(...next.sourceFiles); lookup = next;
          }
          if (lookup.truncated) {
            warehouseResultLimitNotes.push(edges.length >= 50_000
              ? `${layerId}: Warehouse reverse lookup reached its 50,000-edge continuation limit; additional matching edges remain.`
              : `${layerId}: Warehouse reverse lookup could not exhaust its continuation; matching evidence remains truncated.`);
          }
          lookup = { ...lookup, edges, sourceFiles: files,
            notes: lookup.notes.filter((note) => !/^Result limited to/.test(note)),
            downloadPlan: buildDownloadPlan({ edges, sourceFiles: files, truncated: lookup.truncated, scanScopes: lookup.scanScopes }) };
        }
        if (!lookup.available) {
          warehouseUnavailableLayers.add(layerId);
        }
        return [layerId, lookup] as const;
      } catch (error) {
        if (error instanceof AccessError) throw error;
        if (error instanceof EvidenceStoreError && error.statusCode === 409 && error.message.startsWith("Warehouse layer is not ACTIVE:")) {
          // Unindexed published layers keep their geometry and source entrypoints.
          return undefined;
        }
        console.warn(`Warehouse reverse lookup failed for ${layerId}: ${error instanceof Error ? error.message : String(error)}`);
        warehouseUnavailableLayers.add(layerId);
        return undefined;
      }
    }));
    for (const lookup of lookups) if (lookup) warehouseResults.set(lookup[0], lookup[1]);
  } stream.emit("progress", { stage: "warehouse", state: "completed", layerCount: warehouseResults.size }); })();
  const [result, sourceUnitResult] = await Promise.all([regionPromise, nativePromise, warehousePromise]);

  const warehouseEdges = [...warehouseResults.values()].flatMap(lookup => lookup.edges);
  const warehouseFiles: Array<Record<string, unknown>> = mergeWarehouseSourceFiles(warehouseResults)
    .map(({ logicalLayerId, source }) => {
      const fileId = [source.file_id, source.fileId, source._id].find((value): value is string => typeof value === "string");
      const normalizedFile = warehouseResults.get(logicalLayerId)?.downloadPlan.files.find(file => file.fileId === fileId);
      const fileName = typeof source.file_name === "string" ? source.file_name : typeof source.fileName === "string" ? source.fileName : typeof source.name === "string" ? source.name : undefined;
      const sourceUri = [source.sourceUri, source.source_uri, source.uri, source.urn, source.path, source.key, normalizedFile?.sourceUri].find((value): value is string => typeof value === "string");
      const desiTileId = sourceUri?.match(/(?:^|\/)tiles\/cumulative\/(\d+)\/(?:\d{8})(?:\/|$)/)?.[1];
      const matchedEuclidLayer = warehouseLogicalLayersForSource(source, warehouseEdges, logicalLayerId)
        .map((layerId) => publicCoverageCatalog().records.get(layerId))
        .find((layer) => layer?.surveyId === "euclid" && layer.releaseId === "euclid-q1");
      const euclidLink = matchedEuclidLayer ? resolveEuclidQ1MerFile(fileName, matchedEuclidLayer) : undefined;
      return {
        ...source,
        __logicalLayerId: logicalLayerId,
        ...(sourceUri ? { sourceUri } : {}),
        ...(typeof source.unitKind === "string" ? {} : typeof source.unit_kind === "string" ? { unitKind: source.unit_kind } : {}),
        ...(typeof source.unitId === "string" ? {} : typeof source.unit_id === "string" ? { unitId: source.unit_id } : {}),
        ...(euclidLink ? { download_url: euclidLink.downloadUrl, downloadProvider: euclidLink.downloadProvider, unitKind: euclidLink.unitKind, unitId: euclidLink.tileId } : {}),
        ...(!euclidLink && desiTileId ? { unitKind: "tile", unitId: desiTileId } : {}),
      };
    });
  const regionSpatialUnits: DownloadPlanSpatialUnit[] = result.sources.flatMap((source): DownloadPlanSpatialUnit[] => {
    const sourceRecord = source as unknown as Record<string, unknown>;
    const layerId = typeof sourceRecord.layerId === "string" ? sourceRecord.layerId : "";
    const layer = publicCoverageCatalog().records.get(layerId);
    const downloads = Array.isArray(sourceRecord.downloads) ? sourceRecord.downloads as Array<Record<string, unknown>> : [];
    const sourceUnits = Array.isArray(sourceRecord.sourceUnits) ? sourceRecord.sourceUnits as Array<Record<string, unknown>> : [];
    if (!layer) return [];
    return downloads.flatMap((download): DownloadPlanSpatialUnit[] => {
      const unitId = typeof download.unitId === "string" ? download.unitId : undefined;
      const unitKind = typeof download.unitKind === "string" ? download.unitKind : undefined;
      const accessUri = typeof download.url === "string" ? publicLocator(download.url) : undefined;
      if (!unitId || !unitKind || !accessUri) return [];
      const unit = sourceUnits.find((candidate) => candidate.unitId === unitId && candidate.unitKind === unitKind);
      const matchingCells = Array.isArray(unit?.matchingCells) ? unit.matchingCells.filter((cell): cell is number => Number.isSafeInteger(cell)) : [];
      return [{
        layerId,
        productId: layer.productId,
        surveyId: layer.surveyId,
        releaseId: layer.releaseId,
        product: layer.product,
        ...(layer.modality ? { modality: layer.modality } : {}),
        unitKind,
        unitId,
        order,
        nside: 2 ** order,
        matchingCells,
        precision: download.geometryPrecision === "exact" ? "exact" : "estimated",
        accessUri,
        ...(typeof download.sourceSnapshotSha256 === "string" ? { sourceSnapshotSha256: download.sourceSnapshotSha256 } : {}),
        ...(typeof download.note === "string" ? { note: download.note } : {}),
      }];
    });
  });
  const retryableWarehouseLayers = [...warehouseUnavailableLayers].filter((layerId) =>
    !sourceUnitResult.indexedLayerIds.has(layerId) && !regionSpatialUnits.some((unit) => unit.layerId === layerId));
  const regionResultLimitNotes = result.sources.flatMap((source) => source.completeness === "truncated"
    ? [`${String(source.layerId)}: published region-to-file lookup reached a result or geometry limit; matching source identities remain partial.`]
    : []);
  const spatialUnitsByIdentity = new Map<string, DownloadPlanSpatialUnit>();
  for (const unit of [...regionSpatialUnits, ...sourceUnitResult.units]) {
    const identity = `${unit.layerId}:${unit.unitKind}:${unit.unitId}`;
    const previous = spatialUnitsByIdentity.get(identity);
    spatialUnitsByIdentity.set(identity, previous ? {
      ...previous,
      ...unit,
      matchingCells: [...new Set([...previous.matchingCells, ...unit.matchingCells])].sort((left, right) => left - right),
      ...(previous.accessUris?.length || unit.accessUris?.length ? {
        accessUris: mergeSourceAccessUris(previous.accessUris, unit.accessUris),
      } : {}),
      ...(previous.sourceMetadata || unit.sourceMetadata ? { sourceMetadata: mergeSourceMetadata(previous.sourceMetadata, unit.sourceMetadata) } : {}),
    } : unit);
  }
  const nativeSpatialUnits = interleaveSpatialUnitsBySurvey([...spatialUnitsByIdentity.values()].sort((left, right) => left.surveyId.localeCompare(right.surveyId)
    || left.releaseId.localeCompare(right.releaseId)
    || left.product.localeCompare(right.product)
    || left.unitKind.localeCompare(right.unitKind)
    || left.unitId.localeCompare(right.unitId, undefined, { numeric: true })));
  const unitsByIdentity = new Map(nativeSpatialUnits.map((unit) => [`${unit.layerId}:${unit.unitKind}:${unit.unitId}`, unit]));
  const connectorContext: WarehouseConnectorContext = warehouseResults.size ? await warehouseConnectorLookup() : { tasks: [], batches: [], connectors: [] };
  const connectorLayers = new Map(sourceDescriptors.map(({ layer }) => [layer.layerId, layer]));
  const connectorScopes = [...warehouseResults.values()].flatMap(lookup => lookup.scanScopes ?? []);
  const scannedFilesByUnit = new Map<string, NonNullable<DownloadPlanSpatialUnit["scannedFiles"]>>();
  for (const source of warehouseFiles) {
    const layerId = typeof source.__logicalLayerId === "string" ? source.__logicalLayerId : undefined;
    const unitKind = typeof source.unitKind === "string" ? source.unitKind : undefined;
    const unitId = typeof source.unitId === "string" ? source.unitId : undefined;
    if (!layerId || !unitKind || !unitId) continue;
    const fileId = typeof source.file_id === "string" ? source.file_id : typeof source.fileId === "string" ? source.fileId : typeof source._id === "string" ? source._id : undefined;
    if (!fileId) continue;
    const identity = `${layerId}:${unitKind}:${unitId}`;
    if (!unitsByIdentity.has(identity)) continue;
    const sourceUri = [source.sourceUri, source.source_uri, source.uri, source.urn].find((value): value is string => typeof value === "string");
    const fileName = [source.file_name, source.fileName, source.name].find((value): value is string => typeof value === "string");
    const scanRunId = typeof source.scan_run_id === "string" ? source.scan_run_id : typeof source.scanRunId === "string" ? source.scanRunId : undefined;
    const sourceSnapshotSha256 = typeof source.sourceSnapshotSha256 === "string" ? source.sourceSnapshotSha256 : typeof source.source_snapshot_sha256 === "string" ? source.source_snapshot_sha256 : undefined;
    const matchingCoverage = warehouseResults.get(layerId)?.downloadPlan.files.find(file => file.fileId === fileId)?.matchingCoverage
      .filter(match => !source.layer_id || match.observationLayerId === source.layer_id) ?? [];
    const runIds = [...new Set(matchingCoverage.map(match => match.scanRunId).filter((value): value is string => Boolean(value)))];
    const files = scannedFilesByUnit.get(identity) ?? [];
    for (const runId of runIds.length ? runIds : [scanRunId]) {
      if (files.some(file => file.fileId === fileId && file.scanRunId === runId)) continue;
      const matches = matchingCoverage.filter(match => match.scanRunId === runId);
      const snapshotHash = matches.find(match => match.sourceSnapshotSha256)?.sourceSnapshotSha256 ?? sourceSnapshotSha256;
      const connectors = scannedFileConnectors({ scanRunId: runId, matchingCoverage: matches }, connectorContext, connectorLayers, connectorScopes);
      files.push({ fileId, ...(fileName ? { fileName } : {}), ...(sourceUri ? { sourceUri } : {}), ...(runId ? { scanRunId: runId } : {}), ...(snapshotHash ? { sourceSnapshotSha256: snapshotHash } : {}), ...(matches.length ? { matchingCoverage: matches } : {}), ...(connectors.length ? { connectors } : {}) });
    }
    scannedFilesByUnit.set(identity, files);
  }
  for (const [identity, files] of scannedFilesByUnit) {
    const unit = unitsByIdentity.get(identity);
    if (unit) unit.scannedFiles = files;
  }
  const scannedUnitFileIds = new Set(nativeSpatialUnits.flatMap((unit) => unit.scannedFiles?.map((file) => file.fileId) ?? []));
  const warehouseLayerSources = new Map<string, Record<string, unknown>>();
  for (const [layerId, lookup] of warehouseResults) {
    const product = publicState.snapshot.products.find(entry => entry.geometry?.layerId === layerId);
    if (!product) continue;
    const edges = lookup.edges.filter(edge => edge.layerId === layerId);
    const matchedCells = [...new Set(edges.map(edge => edge.ipix))].sort((a, b) => a - b);
    const fileIds = [...new Set(edges.map(edge => edge.sourceFileId).filter((value): value is string => Boolean(value)))];
    const precision = lookup.precision;
    warehouseLayerSources.set(layerId, {
      surveyId: product.content.surveyId,
      releaseId: product.content.releaseId,
      productId: product.productId,
      layerId,
      product: product.content.name,
      modality: product.content.modality,
      sourceId: layerId,
      order: body.order,
      nside: 2 ** (body.order as number),
      cells: matchedCells,
      geometryPrecision: precision,
      geometryOperation: "warehouse-coverage-edge-intersection",
      accessAvailability: edges.length ? "file-resolved" : "geometry-only",
      completeness: lookup.truncated ? "truncated" : edges.length ? "incomplete" : "incomplete",
      reason: edges.length
        ? `Warehouse file evidence currently covers ${fileIds.length} scanned file${fileIds.length === 1 ? "" : "s"}; the published MOC scope is broader.`
        : "No Warehouse coverage edge intersects the requested cells.",
      sourceUnitSummary: {
        status: edges.length ? "exact" : "unavailable",
        unitKind: "file",
        matchedUnitCount: fileIds.length,
        truncated: lookup.truncated,
        notes: "File metadata and coverage edges come from the configured Warehouse evidence indices; this is not a public file download proxy.",
      },
      downloads: [],
    });
  }
  const sourcesByLayer = new Map(result.sources.map(source => [String(source.layerId), source]));
  for (const [layerId, source] of warehouseLayerSources) sourcesByLayer.set(layerId, source);
  const responseSources = (body.layerIds as string[]).flatMap((layerId) => {
    const source = sourcesByLayer.get(layerId);
    if (source) return [source];
    const descriptor = sourceDescriptors.find((candidate) => candidate.layer.layerId === layerId);
    if (!descriptor) return [];
    const { layer } = descriptor;
    const units = sourceUnitResult.units.filter((unit) => unit.layerId === layerId);
    const matchedCells = [...new Set(units.flatMap((unit) => unit.matchingCells))].sort((left, right) => left - right);
    return [{
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      productId: layer.productId,
      layerId,
      product: layer.product,
      modality: layer.modality,
      order,
      nside: 2 ** order,
      coverageRevision: layer.revision,
      cells: matchedCells,
      geometryPrecision: "estimated",
      geometryOperation: "native-source-unit-footprint-intersection",
      accessAvailability: units.some((unit) => unit.accessAvailability === "source-policy") ? "source-policy" : units.length ? "source-unit-resolved" : "geometry-only",
      completeness: sourceUnitResult.truncated || sourceUnitResult.unavailableLayerIds.includes(layerId) ? "truncated" : "incomplete",
      reason: units.length
        ? "Native source-unit footprints intersect the selected HEALPix area; filter-specific file availability is resolved by the survey archive."
        : "The local native-unit index returned no unit for this HEALPix area; this is not evidence that the survey has no data.",
      sourceUnitSummary: {
        unitKind: units[0]?.unitKind ?? layer.sourceUnitIndex?.unitKind ?? "source unit",
        matchedUnitCount: units.length,
        truncated: sourceUnitResult.truncated || sourceUnitResult.unavailableLayerIds.includes(layerId),
      },
      downloads: [],
    }];
  });
  // Public release and coverage links exist even when a layer has no Warehouse
  // file index yet. Keep those links in the mixed overlap result so a missing
  // scan is visible as a limitation instead of making the product disappear.
  const publicEntrypoints = normalizeReverseEntrypoints(publicReverseEntrypoints(body.layerIds as string[], order, cells))
    .map((entry) => ({
      ...entry,
      note: entry.kind === "official-release"
        ? sourceUnitResult.indexedLayerIds.has(String(entry.layerId))
          ? nativeSpatialUnits.some((unit) => unit.layerId === entry.layerId)
            ? "官方数据入口；当前命中的原生空间分块 URI 已单独列出。"
            : "官方数据入口；当前冻结索引在该区域没有原生分块命中，覆盖依据仍保留；这不是该天区无数据的结论。"
          : isWarehouseFilePartitionLayer(publicCoverageCatalog().records.get(String(entry.layerId)) ?? { sourceUnitIndex: undefined })
            ? "官方数据入口；该产品按路径 HEALPix 分区反查文件，命中情况见文件清单。"
            : "官方数据入口；当前产品尚无可用的本地原生空间分块索引，这不是该天区无数据的结论。"
        : entry.kind === "coverage-moc" || entry.kind === "coverage-source"
          ? "覆盖参考；合并后的 MOC 本身不含每个原生空间分块的身份。"
          : entry.note,
    }));
  const requestedCells = new Set(cells);
  const coverageEvidence: DownloadPlanCoverageEvidence[] = (body.layerIds as string[]).flatMap((layerId) => {
    const layer = publicCoverageCatalog().records.get(layerId);
    if (!layer) return [];
    const matchedCells = (layer.cells.get(order) ?? []).filter((cell) => requestedCells.has(cell));
    if (!matchedCells.length) return [];
    const product = publicState.records.get(layer.productId)?.draft;
    const sourceEvidence = layer.sourceEvidence ?? product?.coverageEvidence;
    const sourceIndex = layer.sourceUnitIndex ?? product?.sourceUnitIndex;
    const evidenceKind: DownloadPlanCoverageEvidence["evidenceKind"] = sourceEvidence?.evidenceKind ?? (product?.mode === "tile-table" || sourceIndex?.unitKind === "tile"
      ? "tile-footprint"
      : product?.mode === "fits-wcs" || sourceIndex?.unitKind === "file"
        ? "wcs-coverage"
        : "published-moc");
    const scannedFiles = new Set(warehouseEdges.filter((edge) => edge.layerId === layerId && edge.sourceFileId).map((edge) => edge.sourceFileId));
    const detail = evidenceKind === "observation-footprint"
      ? "An observation footprint intersects these cells; this establishes archive geometry, not science-file availability at every position."
      : evidenceKind === "tile-footprint"
      ? "An official Tile footprint intersects these cells; this does not establish target-level spectra at every position."
      : evidenceKind === "source-unit-footprint"
        ? "Official native source-unit geometry intersects these cells; the matching unit identity is listed separately from file-scan evidence."
      : evidenceKind === "wcs-coverage"
        ? "A WCS-derived footprint intersects these cells; file matches and scan scope are reported separately."
        : "The published ICRS/NESTED MOC intersects these cells; this alone does not verify a scientific file at each position.";
    const scanNote = scannedFiles.size
      ? `The Warehouse file index returned ${scannedFiles.size} matching scanned file(s) for this component.`
      : sourceEvidence?.scienceFileScan === "not-scanned"
        ? "No science-file scan index is available for this source."
        : "The current Warehouse scan index returned no file match here; this does not mean the source has no data.";
    const summary = sourceEvidence ? `${sourceEvidence.summary} ${scanNote}` : `Coverage evidence: ${detail} ${scanNote}`;
    const sourceUrl = publicExternalUrl(product?.officialDataUrl ?? product?.officialQueryUrl ?? product?.sourceUrl);
    const geometrySourceUrl = publicExternalUrl(product?.geometrySourceUrl);
    return [{
      layerId,
      productId: layer.productId,
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
      ...(product?.modality ?? layer.modality ? { modality: product?.modality ?? layer.modality } : {}),
      evidenceKind,
      order,
      nside: 2 ** order,
      nativeMaxOrder: layer.maxOrder,
      availableOrders: [...layer.availableOrders],
      matchedCells,
      precision: sourceEvidence?.precision ?? layer.recipe?.precision ?? "estimated",
      ...(sourceEvidence?.completeness ? { completeness: sourceEvidence.completeness } : {}),
      ...(sourceEvidence?.scienceFileScan ? { scienceFileScan: sourceEvidence.scienceFileScan } : {}),
      ...(sourceEvidence?.sourceIdentity ? { sourceIdentity: sourceEvidence.sourceIdentity } : {}),
      ...(sourceEvidence?.instrument ? { instrument: sourceEvidence.instrument } : {}),
      ...(sourceEvidence?.filters ? { filters: sourceEvidence.filters } : {}),
      ...(sourceEvidence?.sourceSnapshotSha256 ?? layer.recipe?.sourceSnapshotSha256 ? { sourceSnapshotSha256: sourceEvidence?.sourceSnapshotSha256 ?? layer.recipe?.sourceSnapshotSha256 } : {}),
      ...(product?.sourceLabel ? { sourceLabel: product.sourceLabel } : product?.geometrySourceLabel ? { sourceLabel: product.geometrySourceLabel } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(geometrySourceUrl ? { geometrySourceUrl } : {}),
      ...(layer.recipe?.mode !== "source-unit-polygons" ? { coverageUrl: `/api/v1/coverage/layers/${encodeURIComponent(layerId)}/moc.fits` } : {}),
      summary,
    }];
  });
  let downloadPlan = buildDownloadPlan({
    edges: warehouseEdges.filter((edge) => !edge.sourceFileId || !scannedUnitFileIds.has(edge.sourceFileId)),
    sourceFiles: warehouseFiles.filter((source) => {
      const fileId = typeof source.file_id === "string" ? source.file_id : typeof source.fileId === "string" ? source.fileId : typeof source._id === "string" ? source._id : undefined;
      return !fileId || !scannedUnitFileIds.has(fileId);
    }),
    spatialUnits: nativeSpatialUnits,
    scanScopes: [...warehouseResults.values()].flatMap((lookup) => lookup.scanScopes ?? []),
    // The legacy tile path already carries its public URL and selection
    // metadata; keep those fields intact while adding normalized Warehouse
    // evidence entrypoints.
    entrypoints: publicEntrypoints,
    coverageEvidence,
    matchingCoverageTruncatedFileIds: [...warehouseResults.values()].flatMap((lookup) => lookup.downloadPlan.files.filter((file) => file.matchingCoverageTruncated).map((file) => file.fileId)),
    truncated: sourceUnitResult.truncated || sourceUnitResult.unavailableLayerIds.length > 0 || (warehouseResults.size > 0 && [...warehouseResults.values()].some((lookup: ReverseLookupResult) => lookup.truncated)) || result.sources.some(source => source.completeness === "truncated" && !sourceUnitResult.indexedLayerIds.has(String(source.layerId))),
  });
  downloadPlan.warnings.push(...sourceUnitResult.notes, ...warehouseResultLimitNotes, ...regionResultLimitNotes,
    ...retryableWarehouseLayers.map((layerId) => `${layerId}: Warehouse evidence is unavailable; native results from other surveys are retained.`));
  for (const file of downloadPlan.files) {
    const connectors = scannedFileConnectors(file, connectorContext, connectorLayers, connectorScopes);
    if (connectors.length) file.connectors = connectors;
  }
  downloadPlan.truncated ||= retryableWarehouseLayers.length > 0;
  let stoppedAtLimit = false;
  let seenKeys: string[] | undefined;
  let unitCounts: Record<string, number> | undefined;
  let batchQueryComplete = priorBatchQueryComplete && !downloadPlan.truncated;
  let batchResultTruncated = priorBatchResultTruncated || downloadPlan.truncated;
  let snapshotSources = responseSources;
  if (internalBatch) {
    const filtered = filterReversePlanForBatches(downloadPlan, internalBatch.seenKeys);
    downloadPlan = filtered.plan;
    seenKeys = filtered.seenKeys;
    stoppedAtLimit = filtered.stoppedAtLimit;
    batchQueryComplete &&= !stoppedAtLimit;
    batchResultTruncated ||= stoppedAtLimit;
    const batchUnitCounts: Record<string, number> = { ...internalBatch.unitCounts };
    for (const unit of downloadPlan.spatialUnits ?? []) batchUnitCounts[unit.layerId] = (batchUnitCounts[unit.layerId] ?? 0) + 1;
    unitCounts = batchUnitCounts;
    snapshotSources = responseSources.map((source) => {
      const record = source as Record<string, unknown>;
      const summary = record.sourceUnitSummary && typeof record.sourceUnitSummary === "object"
        ? record.sourceUnitSummary as Record<string, unknown>
        : undefined;
      if (!summary || summary.unitKind === "file") return source;
      const layerId = String(record.layerId ?? "");
      return { ...record, sourceUnitSummary: { ...summary, matchedUnitCount: batchUnitCounts[layerId] ?? 0 } };
    });
  } else if (preview && batchCount > 1) {
    const filtered = filterReversePlanForBatches(downloadPlan, []);
    downloadPlan = filtered.plan;
    seenKeys = filtered.seenKeys;
    stoppedAtLimit = filtered.stoppedAtLimit;
    batchQueryComplete &&= !stoppedAtLimit;
    batchResultTruncated ||= stoppedAtLimit;
  }
  const snapshot: ReverseSnapshot = {
    schemaVersion: 2, identity: preview ? "preview" : identity, fingerprint, selectorFingerprint,
    expiresAt: snapshotExpiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
    batch: {
      ...(batchRootSnapshotId ? { rootSnapshotId: batchRootSnapshotId } : {}),
      index: batchIndex,
      count: batchCount,
      queryComplete: batchQueryComplete,
      resultTruncated: batchResultTruncated,
      ...(seenKeys ? { seenKeys } : {}),
      ...(unitCounts ? { unitCounts } : {}),
      ...(stoppedAtLimit ? { stoppedAtLimit: true } : {}),
    },
    response: { available: Boolean(downloadPlan.spatialUnits?.length || downloadPlan.files.length || downloadPlan.entrypoints.length),
      precision: downloadPlan.truncated ? "truncated" : nativeSpatialUnits.some((unit) => unit.precision !== "exact")
        || [...warehouseResults.values()].some((lookup) => lookup.precision !== "exact") || (!nativeSpatialUnits.length && !warehouseEdges.length) ? "estimated" : "exact", requested: { layerIds: body.layerIds, order, cells },
      nativeUnitIndexRevision: requestNativeVersion(), sources: snapshotSources, notes: [...new Set([...sourceUnitResult.notes, ...warehouseResultLimitNotes, ...regionResultLimitNotes, ...[...warehouseResults.values()].flatMap((lookup) => lookup.notes),
        ...[...warehouseUnavailableLayers].map((layerId) => `${layerId}: Warehouse evidence is temporarily unavailable.`)])], downloadPlan },
    previewPlan: capReversePreview(downloadPlan).plan,
  };
  if (internalBatch && Buffer.byteLength(JSON.stringify(snapshot)) > REVERSE_SNAPSHOT_MAX_BYTES) {
    const limited = planWithReverseItems(downloadPlan, reversePlanItems(downloadPlan).slice(0, 100));
    limited.truncated = true;
    limited.warnings = [...new Set([...limited.warnings, "Reverse lookup batch exceeded the 64 MiB snapshot limit; this batch result is incomplete."])];
    const cappedCounts = { ...internalBatch.unitCounts };
    for (const unit of limited.spatialUnits ?? []) cappedCounts[unit.layerId] = (cappedCounts[unit.layerId] ?? 0) + 1;
    snapshot.response.downloadPlan = limited;
    snapshot.response.precision = "truncated";
    snapshot.response.sources = snapshotSources.map((source) => {
      const record = source as Record<string, unknown>;
      const summary = record.sourceUnitSummary && typeof record.sourceUnitSummary === "object"
        ? record.sourceUnitSummary as Record<string, unknown>
        : undefined;
      if (!summary || summary.unitKind === "file") return source;
      return { ...record, sourceUnitSummary: { ...summary, matchedUnitCount: cappedCounts[String(record.layerId ?? "")] ?? 0, truncated: true } };
    });
    snapshot.batch = { ...snapshot.batch!, queryComplete: false, resultTruncated: true, stoppedAtLimit: true, unitCounts: cappedCounts };
    snapshot.previewPlan = capReversePreview(limited).plan;
  }
  const snapshotId = await writeReverseSnapshot(publicLookupStore, snapshot);
  if (internalBatch) return { snapshot, snapshotId };
  const page = snapshotPage(snapshot, snapshotId, identity, reverseCursorSecret, { preview, scope: pageScope, pageSize, rootSnapshotId: batchRootSnapshotId });
  if (stream.enabled) stream.emit("complete", page); else compressedJson(request, response, 200, page, "no-store");
  return;
}

async function executeRegionQuery(request:IncomingMessage,body:unknown,managedIdentity?:string,sourceLimit:8|64=8) {
  const identity=managedIdentity ?? accessGate.identity(request),reservation=accessGate.begin(identity);
  const state=publicState;
  const task=queryRegion(state,body,async(layerId,order,cells,limit,indexRevision)=>{
    const product=state.records.get(state.coverage.records.get(layerId)!.productId)!;
    // The approved release has already decoded and verified this immutable MOC.
    const published = state.snapshot.products.find(record => record.productId === product.productId);
    if(published?.geometry?.indexRevision!==indexRevision)throw new AccessError(409,"Index revision changed");
    if (!nativeBindingEnabled(layerId)) return null;
    const index=await sourceUnitsReadyWithin(3000);
    const layer = state.coverage.records.get(layerId);
    return index?await index.match(layerId,order,cells,limit,layer ? {
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
    } : undefined):null;
  },sourceLimit);
  let timer:ReturnType<typeof setTimeout>|undefined;
  // Keep the concurrency slot while timed-out worker work is still running.
  void task.then(r=>reservation.finish(r.sources.reduce((sum,s)=>sum+(s.cells as number[]).length+(s.sourceUnits as unknown[]).length,0)),()=>reservation.finish(11000));
  try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AccessError(504,"Region query timed out")),10000);})]);}finally{if(timer)clearTimeout(timer);}
}
async function sendProtectedRegionQuery(request:IncomingMessage,response:ServerResponse):Promise<void> {
 return withRegionAccess(request,response,async identity => {
  const body=await requestJsonBody(request,256*1024);
  const result=await executeRegionQuery(request,body,identity);
  compressedJson(request,response,200,result,"no-store");
 });
}

let adminMutationTail: Promise<void> = Promise.resolve();
const server = http.createServer((request, response) => {
  const context = { catalog: currentCatalog, state: currentPublicState, nativeGroup: nativeUnits?.active, nativeVersion: nativeUnits?.version ?? "imported-baseline" };
  const runtime = nativeRuntimes.get(context.nativeVersion) ?? { version: context.nativeVersion, group: context.nativeGroup, references: 0, state: "initializing" as const };
  nativeRuntimes.set(context.nativeVersion, runtime); runtime.references++;
  if (runtime.retire) { clearTimeout(runtime.retire); runtime.retire = undefined; }
  void requestRelease.run(context, async () => {
    securityHeaders(response);
    const pathname = requestPath(request);
    const connectorIcon = /^\/api\/v1\/connector-icons\/([a-f0-9]{64})$/.exec(pathname);
    if (connectorIcon && (request.method === "GET" || request.method === "HEAD")) {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      const content = await connectorPresentations.readIcon(connectorIcon[1]!);
      if (!content) return json(response, 404, { error: "Connector icon not found" });
      const etag = `"${connectorIcon[1]}"`;
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.setHeader("ETag", etag);
      if (request.headers["if-none-match"] === etag) { response.writeHead(304); response.end(); return; }
      response.writeHead(200, { "Content-Type": content.contentType, "Content-Length": content.bytes.length });
      response.end(request.method === "HEAD" ? undefined : content.bytes);
      return;
    }
    if (pathname === "/api/v1/openapi.json" && request.method === "GET") return json(response, 200, publicOpenApi());
    if (pathname === "/api/v1/status" && request.method === "GET") {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      const active = nativeUnits?.active;
      return json(response, 200, { schemaVersion: 1, generatedAt: new Date().toISOString(), status: "available", publicRelease: { id: publicState.snapshot.releaseId, generatedAt: publicState.snapshot.generatedAt, coverageRevision: publicCoverageCatalog().revision, publishedMocLayers: publicState.geometry.size }, warehouseGeometry, nativeIndex: { version: nativeUnits?.version ?? "unavailable", generation: nativeUnits?.generation ?? 0, managed: Boolean(active), verified: Boolean(active?.report.checks.length && active.report.checks.every(check => check.passed)) }, services: [{ id: "survey-healpix", status: publicState.geometry.size ? "available" : "empty", authentication: "public" }, { id: "reverse-lookup", status: nativeRuntime().state, authentication: "region:query", anonymousPreviewLimit: PUBLIC_REVERSE_PREVIEW_LIMIT }, { id: "warehouse-evidence", status: evidenceStore.configured ? "configured" : "unconfigured", authentication: "region:query" }], access: { keyIssuance: "administrator", scopes: ["region:query"], maximumRequestsPerMinute: 30, onlineBilling: false }, documentation: "/api-docs/" });
    }
    const surveyHealpix = /^\/api\/v1\/coverage\/surveys\/([a-z0-9-]+)\/healpix$/.exec(pathname);
    if (surveyHealpix && request.method === "GET") {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      const surveyId = surveyHealpix[1]!;
      if (isDeniedSurvey(surveyId) || !publicState.index.surveys.some(survey => survey.id === surveyId)) throw new AccessError(404, "Public survey not found");
      const query = requestQuery(request);
      if (!query.has("order") || !/^\d+$/.test(query.get("order")!)) throw new AccessError(400, "An integer order is required");
      const filters = (key: string) => new Set(query.getAll(key).flatMap(value => value.split(",")).filter(Boolean));
      const releases = filters("releaseId"), products = filters("productId");
      const layers: HealpixLayer[] = publicState.snapshot.products.flatMap(product => {
        if (product.content.surveyId !== surveyId || !product.geometry || releases.size && !releases.has(product.content.releaseId) || products.size && !products.has(product.productId)) return [];
        const moc = publicState.geometry.get(product.geometry.layerId);
        return moc ? [{ layerId: product.geometry.layerId, productId: product.productId, releaseId: product.content.releaseId, modality: product.content.modality, moc }] : [];
      });
      if ([...releases].some(id => !layers.some(layer => layer.releaseId === id)) || [...products].some(id => !layers.some(layer => layer.productId === id))) throw new AccessError(404, "A selected release or product has no published MOC");
      const reservation = accessGate.begin(`healpix-list:${request.socket.remoteAddress ?? "unknown"}`);
      try {
        const result = healpixList({ surveyId, layers, order: Number(query.get("order")), pageSize: query.has("pageSize") ? Number(query.get("pageSize")) : undefined, cursor: query.get("cursor") ?? undefined, revision: query.get("revision") ?? undefined, secret: reverseCursorSecret });
        compressedJson(request, response, result.status, result, "no-store");
        reservation.finish(result.status === 200 ? result.pixels.length : 1);
      } catch (error) { reservation.finish(1); throw error; }
      return;
    }
    if (pathname === "/api/v1/access/unlock" && request.method==="POST") return handleDownloadUnlock(request,response);
    if (pathname.startsWith("/api/v1/admin/")) {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181");
      if (request.method === "GET" || request.method === "HEAD") return sendAdmin(request, response, pathname);
      const mutation = adminMutationTail.then(() => sendAdmin(request, response, pathname));
      adminMutationTail = mutation.catch(() => undefined);
      return mutation;
    }
    if (pathname === "/api/v1/access/region-query" && request.method === "POST") return sendProtectedRegionQuery(request,response);
    if (pathname === "/api/v1/access/coverage-block" && request.method === "POST") return sendProtectedCoverageBlock(request, response);
    if (pathname === "/api/v1/coverage/overlap" && request.method === "POST") {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      return sendCoverageOverlap(request, response);
    }
    if (pathname === "/api/v1/coverage/hst-images" && request.method === "POST") {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      const body = await requestJsonBody(request, 32 * 1024);
      const quota = accessGate.begin(`hst-images:${request.socket.remoteAddress ?? "unknown"}`);
      let cost = 1;
      try {
        const { order, cells } = normalizedHstLookupCells(body);
        const index = await hstObservationIndex();
        if (!index) throw new AdminHttpError(503, "The locked local HST observation index is unavailable");
        const local = index.lookup(order, cells, HST_IMAGE_LOOKUP_MAX_OBSERVATIONS);
        const result = {
          coordinateFrame: "ICRS" as const,
          ordering: "NESTED" as const,
          order,
          nside: 2 ** order,
          cells,
          precision: local.truncated ? "truncated" as const : "estimated" as const,
          spatialPrecision: "estimated" as const,
          observations: local.observations.map((observation) => ({ ...observation, files: [] })),
          errors: [],
          truncated: local.truncated,
          queryExhausted: local.queryExhausted,
          matchedObservationCount: local.matchedObservationCount,
          excludedWithoutRegion: index.summary.excludedRows,
          generatedAt: new Date().toISOString(),
          sourceSnapshotSha256: local.sourceSnapshotSha256,
          sourceSnapshotCapturedAt: nativeRuntime().capturedAt,
        };
        cost += result.observations.length;
        response.setHeader("Cache-Control", "no-store");
        return json(response, 200, result);
      } finally {
        quota.finish(cost);
      }
    }
    if (pathname === "/api/v1/coverage/overlap/details" && request.method === "POST") {
      // The site owns the read-only public geometry, but Warehouse evidence is
      // loaded only by the backend.  Proxy this read-only detail request so a
      // browser does not silently lose file/scan evidence at the site edge.
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      return sendCoverageOverlapDetails(request, response);
    }
    if (pathname === "/api/v1/coverage/reverse-lookup" && request.method === "POST") return sendCoverageReverseLookup(request, response);
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
    if (pathname === "/healthz") return json(response, 200, {
      nativeUnitIndex: { version: nativeUnits?.version ?? "backend-proxy", generation: nativeUnits?.generation ?? null },
      status: "ok",
      service: "astro-survey-atlas-assets",
      version: "0.0.1",
      bundle: catalog.manifest.bundle,
      files: catalog.files.size,
    });
    if (pathname === "/api/v1/assets") {
      const visibleAssets: PublicAssetRecord[] = [];
      return json(response, 200, publicManifest(publicAssetCatalog(), visibleAssets));
    }
    if (pathname === "/api/v1/resource-packages/catalog.json") return json(response, 200, await resourcePackageCatalog(catalog));
    if (pathname === "/api/v1/releases") {
      const history = await releaseHistory(catalog);
      return compressedJson(request, response, 200, history, "public, max-age=60, stale-while-revalidate=300", `"releases-${catalog.manifest.bundle.sha256.slice(0, 16)}"`);
    }
    const releaseDetail = /^\/api\/v1\/releases\/([^/]+)$/.exec(pathname);
    if (releaseDetail?.[1]) {
      const releaseId = decodeURIComponent(releaseDetail[1]);
      const entry = (await releaseHistory(catalog)).releases.find((candidate) => candidate.releaseId === releaseId);
      if (!entry) return json(response, 404, { error: "Release not found" });
      if (releaseId !== approvedRelease.releaseId) return json(response,404,{error:"Release withdrawn pending re-review"});
      return compressedJson(request, response, 200, entry, "public, max-age=60, stale-while-revalidate=300");
    }
    const releaseDownload = /^\/api\/v1\/releases\/([^/]+)\/download$/.exec(pathname);
    if (releaseDownload?.[1]) {
      const releaseId = decodeURIComponent(releaseDownload[1]);
      const entry = (await releaseHistory(catalog)).releases.find((candidate) => candidate.releaseId === releaseId);
      if (!entry || entry.releaseId !== approvedRelease.releaseId) return json(response, 404, { error: "Release not found" });
      const collection = entry.collection;
      if (!collection) return json(response, 404, { error: "Release collection not available" });
      const match = [...catalog.files.values()].find(({ record }) => record.kind === "package-collection"
        && record.path.endsWith(`/${collection.fileName}`));
      if (!match) return json(response, 404, { error: "Release collection not available" });
      return sendDownload(request, response, catalog, match.record.id);
    }
    const releaseCatalogRoute = /^\/api\/v1\/releases\/([^/]+)\/resource-packages\/catalog\.json$/.exec(pathname);
    if (releaseCatalogRoute?.[1]) {
      const releaseId = decodeURIComponent(releaseCatalogRoute[1]);
      const history = await releaseHistory(catalog);
      const entry = history.releases.find((candidate) => candidate.releaseId === releaseId);
      if (!entry) return json(response, 404, { error: "Release not found" });
      if (releaseId !== approvedRelease.releaseId) return json(response,404,{error:"Release withdrawn pending re-review"});
      const currentEntry = [...history.releases].reverse().find((candidate) => candidate.bundleId === catalog.manifest.bundle.id);
      if (currentEntry?.releaseId === releaseId) {
        return json(response, 200, await resourcePackageCatalog(catalog));
      }
      // Historical entries serve a catalog projection from the immutable
      // history record; every referenced archive stays downloadable because
      // prior package versions are retained cumulatively in the release tree.
      return json(response, 200, {
        schemaVersion: 3,
        version: "3.0.0",
        releaseId: entry.releaseId,
        bundleId: entry.bundleId,
        generatedAt: entry.releasedAt,
        packages: entry.packages.map((pkg) => ({
          id: pkg.id,
          surveyId: pkg.survey?.id,
          name: pkg.name,
          version: pkg.version,
          modalities: pkg.modalities ?? [],
          facilities: pkg.facilities ?? [],
          releases: (pkg.releases ?? []).map((release) => release.id),
          releaseLabels: Object.fromEntries((pkg.releases ?? []).map((release) => [release.id, release.label])),
          archiveUrl: pkg.downloadUrl,
          sizeBytes: pkg.sizeBytes,
          sha256: pkg.sha256,
          updatedAt: entry.releasedAt,
        })),
      });
    }
    const packageVersionDownload = /^\/api\/v1\/resource-packages\/([^/]+)\/versions\/([^/]+)\/download$/.exec(pathname);
    if (packageVersionDownload?.[1] && packageVersionDownload[2]) {
      const packageId = decodeURIComponent(packageVersionDownload[1]);
      const version = decodeURIComponent(packageVersionDownload[2]);
      const match = [...catalog.files.values()].find(({ record }) => record.kind === "package"
        && record.version === version
        && (record.downloadName === `${packageId}-${version}.zip` || record.path.endsWith(`/${packageId}-${version}.zip`)));
      const historical = approvedRelease.historicalPackages?.some(p => p.id === packageId && p.version === version) ?? false;
      if (!match || (isRetiredAsset(match.record) && !historical) || isDeniedSurvey(match.record.surveyId) || isDeniedPackageId(packageId)) {
        return json(response, 404, { error: "Resource package version not found" });
      }
      const current = approvedRelease.packages.some(p => p.id === packageId && p.version === version);
      if (!current && !historical) return json(response,404,{error:"Resource package withdrawn pending re-review"});
      return sendDownload(request, response, catalog, match.record.id);
    }
    if (pathname === "/api/v1/coverage/catalog") {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      await awaitNativeSourceUnitCoverageLoad();
      const { records: _records, ...publicCoverage } = publicCoverageCatalog();
      publicCoverage.layers = publicCoverage.layers.map((layer) => ({
        ...layer,
        warehouseFileIndex: warehouseFileIndexSummary(layer.layerId),
      }));
      const body = { ...publicCoverage, schemaVersion: 2, generatedAt: coverageLoadedAt, warehouseGeometry, publicationPolicy: PUBLICATION_POLICY, publicReleaseId: approvedRelease.releaseId || null };
      const bodyBytes = Buffer.from(`${JSON.stringify(body)}\n`);
      const etag = `W/"catalog-${createHash("sha256").update(bodyBytes).digest("hex")}"`;
      return compressedJson(request, response, 200, body, "no-cache, must-revalidate", etag);
    }
    if (pathname.startsWith("/api/v1/coverage/blocks/")) {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      await awaitNativeSourceUnitCoverageLoad();
      return sendCoverageBlock(request, response, pathname);
    }
    if (pathname === "/api/v1/coverage") {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      await awaitNativeSourceUnitCoverageLoad();
      const query = requestQuery(request);
      if (query.has("pageSize") || query.has("cursor")) {
        const result = pageCoverageFootprints({
          footprints: publicState.footprints,
          generatedAt: approvedRelease.generatedAt,
          nside: 16,
          pageSize: query.has("pageSize") ? Number(query.get("pageSize")) : undefined,
          cursor: query.get("cursor") ?? undefined,
          secret: reverseCursorSecret,
        });
        return compressedJson(request, response, 200, result, "no-store");
      }
      return json(response, 200, { schemaVersion:1, coordinateFrame:"ICRS", ordering:"NESTED", nside:16, generatedAt:approvedRelease.generatedAt, footprints:publicState.footprints });
    }
    if (pathname === "/api/v1/surveys") {
      if (role === "site") return proxyAdmin(request, response, process.env.ASSETS_BACKEND_URL ?? "http://127.0.0.1:4181", true);
      await awaitNativeSourceUnitCoverageLoad();
      return json(response, 200, publicSurveyIndex());
    }
    if (pathname === "/api/v1/products") return json(response, 200, { products: [...publicState.records.values()].map(publicProductListView) });
    const productEvidence = /^\/api\/v1\/products\/([^/]+)\/evidence$/.exec(pathname);
    if (productEvidence?.[1]) {
      const record = publicState.records.get(decodeURIComponent(productEvidence[1]!));
      if (!record?.published) return json(response, 404, { error: "Product not found" });
      const dossier = buildPublicProductDossier(record);
      // Evidence is deliberately a projection of the dossier. It contains
      // public hashes and checks, never manifests, task snapshots, storage
      // paths or Warehouse documents.
      return json(response, 200, {
        schemaVersion: 1,
        productId: dossier.identity.productId,
        surveyId: dossier.identity.surveyId,
        releaseId: dossier.identity.releaseId,
        product: dossier.identity.name,
        status: dossier.verification.status,
        precision: dossier.coverage.precision,
        source: dossier.source,
        sourceSnapshot: dossier.source.snapshot,
        sourceSnapshotSha256: dossier.source.snapshot?.sha256,
        method: dossier.derivation,
        coordinateFrame: dossier.coverage.coordinateFrame,
        ordering: dossier.coverage.ordering,
        availableOrders: dossier.coverage.availableOrders,
        overviewOrder: dossier.coverage.overviewOrder,
        maxOrder: dossier.coverage.maxOrder,
        areaDeg2: dossier.coverage.areaDeg2,
        coverageRole: dossier.coverage.coverageRole,
        cellCount: dossier.coverage.cellCount,
        cellCounts: dossier.coverage.cellCounts,
        mocUrl: dossier.coverage.mocUrl,
        previewUrl: dossier.coverage.previewUrl,
        checks: dossier.verification.checks,
        limitations: dossier.limitations,
        outputs: dossier.verification.outputHashes,
        outputHashes: dossier.verification.outputHashes,
        steps: dossier.derivation.steps,
        sourceReferences: dossier.source.references,
        next: dossier.actions.data ?? dossier.actions.official,
      });
    }
    const productDetail = /^\/api\/v1\/products\/([^/]+)$/.exec(pathname);
    if (productDetail?.[1]) {
      const record = publicState.records.get(decodeURIComponent(productDetail[1]!));
      if (!record?.published) return json(response, 404, { error: "Product not found" });
      return json(response, 200, buildPublicProductDossier(record));
    }
    const layerMoc = /^\/api\/v1\/coverage\/layers\/([a-z0-9-]+)\/moc\.fits$/.exec(pathname);
    if (layerMoc?.[1]) {
      const layerId = layerMoc[1]!;
      const layer = publicCoverageCatalog().records.get(layerId);
      if (!layer) return json(response, 404, { error: "Coverage MOC not found" });
      const asset = [...publicState.catalog.files.entries()].find(([, entry]) => {
        if (entry.record.kind !== "moc") return false;
        if (entry.record.path.includes(`/layers/${layerId}/`) || entry.record.id === `layer-${layerId}-moc` || entry.record.id === layerId) return true;
        return Boolean(layer && entry.record.surveyId === layer.surveyId && entry.record.releaseId === layer.releaseId && entry.record.product === layer.product);
      });
      if (!asset) return json(response, 404, { error: "Coverage MOC not found" });
      return sendDownload(request, response, catalog, asset[0]);
    }
    const download = /^\/api\/v1\/assets\/([a-z0-9-]+)\/download$/.exec(pathname);
    if (download?.[1]) {
      const entry = catalog.files.get(download[1]);
      if (!entry || isRetiredAsset(entry.record)) return json(response, 404, { error: "Asset not found" });
      return sendDownload(request, response, catalog, download[1]);
    }
    const preview = /^\/api\/v1\/assets\/([a-z0-9-]+)\/preview$/.exec(pathname);
    if (preview?.[1]) {
      const entry = catalog.files.get(preview[1]);
      if (!entry || isRetiredAsset(entry.record)) return json(response, 404, { error: "Asset not found" });
      return sendPreview(request, response, catalog, preview[1]);
    }
    if (pathname.startsWith("/api/")) return json(response, 404, { error: "API endpoint not found" });
    return sendStatic(response, pathname);
  }).catch((error) => {
    if (response.writableEnded || response.destroyed) return;
    if (!response.headersSent && (error instanceof AccessError || error instanceof AdminHttpError)){ if(error.statusCode===429)response.setHeader("Retry-After",String(Math.ceil((60_000-Date.now()%60_000)/1000)));return json(response,error.statusCode,{error:error.message});}
    console.error(error);
    if (!response.headersSent) {
      const statusCode = error instanceof EvidenceStoreError ? error.statusCode : 500;
      const message = error instanceof EvidenceStoreError && statusCode >= 500 ? "Warehouse evidence service is unavailable" : error instanceof Error ? error.message : "Internal server error";
      json(response, statusCode, { error: message });
    }
    else response.destroy();
  }).finally(() => { runtime.references--; retireNativeRuntime(runtime); });
});

server.listen(port, host, () => {
  console.log(`astro-survey-atlas-assets listening on http://${host}:${port} with bundle ${catalog.manifest.bundle.sha256}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  llmDiscovery.stop();
  if (apiStatsTimer) clearInterval(apiStatsTimer);
  if (llmTimer) clearInterval(llmTimer);
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  void (async () => {
    await publicationScheduler?.stop();
    await closed;
    await Promise.allSettled([...nativeRuntimes.values()].map(closeNativeRuntime));
    await apiManagement?.flush();
    apiManagement?.close();
    await releaseBackendOwnership?.();
    process.exit(0);
  })().catch(error => { console.error("Shutdown failed", error); process.exit(1); });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
