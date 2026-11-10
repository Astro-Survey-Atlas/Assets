import { ensureDownloadAccess, hasDownloadAccess, resetDownloadAccess } from "./download-access";
import { byId, escapeHtml, setTextIfPresent, toast as showToast } from "./dom.js";
import { BadgeCheck, BookOpen, Box, ChevronLeft, ChevronRight, CircleHelp, Cloud, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, HardDrive, Home, Image, Info, Layers3, ListChecks, ListFilter, LoaderCircle, Lock, Maximize2, Minimize2, Moon, Menu, Plug, Radio, RotateCcw, ScanLine, Search, ShieldCheck, Sun, Telescope, X, createIcons } from "lucide";
import { Healpix, Pointing } from "healpixjs";
import { AtlasCoverageGlobe, type CoverageCatalog } from "./atlas-coverage-globe.js";
import { CoverageViewTileBudgetError, coverageCellsInView, coverageTilesInView, overlapCoverageTilesInView, type CoverageViewGeometry } from "./atlas/coverage-view-tiles.js";
import {
  surveyColorFor,
  type SurveyLayerContextMenu,
  type SurveyLayerInspection,
  type SurveyLayerOverlapComponent,
  type SurveyLayerState,
} from "@astro-survey-atlas/sky-globe";
import { highestCommonCoverageOrder, overlapViewTileOrder } from "./atlas/coverage-orders.js";
import { RegionQueryPanel } from "./atlas/region-query.js";
import type { SkyRectangle } from "../../src/sky-region.js";
import { coverageCatalogRevisionKey } from "./coverage-catalog-revision.js";
import { coverageEscapeIntent } from "./atlas/coverage-interaction.js";
import { coverageLayerTooltipPosition } from "./atlas/layer-panel-layout.js";
import { overlapPanelExitTransform, overlapPanelsShouldExit } from "./overlap-layout.js";
import { joinUnique, mergeDownloadPlans, overlapCsvDocument, overlapCsvRows, type DownloadPlan, type DownloadPlanCoverageEvidence, type DownloadPlanEntrypoint, type DownloadPlanFile, type DownloadPlanMatch, type DownloadPlanScannedFile, type DownloadPlanSpatialUnit } from "./overlap-download.js";
import { locale, mountLocaleControls, t } from "./i18n.js";
import { createRevisionHydrationQueue } from "./revision-hydration-queue.js";
import { mountSiteChrome } from "./site-chrome.js";
import { canonicalModality, filterByModalities } from "../../src/modality-filter.js";
import type { WarehouseGeometryLoadStatus } from "../../server/coverage.js";
import type { WarehouseOverlapEvidence } from "../../server/overlap-details.js";
import { connectorDefaultIcon, type ScanConnectorIdentity } from "../../src/connector-icon.js";
import type { SkyDepthExample } from "../../src/sky-depth.js";
import type { SkyDepthControls, SkyDepthSelection } from "./atlas/sky-depth-panel.js";

import { bootActive, bootStage, bootTick, finishHudBoot, startHudBoot } from "./atlas/hud-boot.js";
import { maybeStartAtlasGuide, openAtlasGuide } from "./atlas/hud-guide.js";
import { buildLayerFacts, hudLog, setHudMinimapCells, setHudMode, setHudTarget, updateHudView, type HudRosterRow } from "./atlas/hud-overlay.js";

type AssetKind = "package" | "moc" | "geometry" | "manifest" | "ledger" | "documentation" | "provenance" | "metadata";
type ProductStatus = "acquired" | "overview_only" | "awaiting_geometry" | "not_applicable";
type Modality = "imaging" | "spectroscopy" | "redshift" | "photometry" | "time-domain" | "integral-field" | "ultraviolet" | "infrared" | "catalog" | "simulation" | "radio" | (string & {});
const OVERLAP_COMPONENT_PAGE_SIZE = 30;
const HST_IMAGE_LOOKUP_MAX_CELLS = 256;
const HST_IMAGE_LOOKUP_DISPLAY_LIMIT = 30;

interface HstImageLookup {
  coordinateFrame: "ICRS";
  ordering: "NESTED";
  order: number;
  nside: number;
  cells: number[];
  precision: "estimated" | "truncated";
  spatialPrecision: "estimated";
  observations: Array<{
    obsid: string;
    instrument?: string;
    filters?: string;
    target?: string;
    startTime?: number;
    endTime?: number;
    productUrl: string;
    files: Array<{ fileName: string; dataUri?: string; productType?: string; productGroup?: string; sizeBytes?: number; recommendation: "combined-image" | "exposure" | "other" }>;
  }>;
  errors: Array<{ stage: "observations" | "products"; kind: "timeout" | "unavailable" | "upstream"; page?: number; obsid?: string; message: string }>;
  truncated: boolean;
  queryExhausted: boolean;
  matchedObservationCount: number;
  excludedWithoutRegion: number;
  generatedAt: string;
  sourceSnapshotSha256: string;
  sourceSnapshotCapturedAt?: string;
}

interface AssetRecord {
  id: string;
  kind: AssetKind;
  label: string;
  description: string;
  downloadName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  version?: string;
  sourceUrl?: string;
  downloadUrl: string;
  previewUrl?: string;
  previewMode?: "text" | "image";
}

interface ReleaseManifest {
  generatedAt: string;
  bundle: { id: string; sha256: string };
  statistics: { releases: number; acquired: number; rawMocFiles: number; packages: number; totalBytes: number; runtimeBytes?: number; evidenceBytes?: number };
  files: AssetRecord[];
}

interface SurveyProduct {
  name: string;
  modality: Modality;
  description: string;
  status: ProductStatus;
  sourceUrl: string;
  geometrySourceUrl?: string;
  reason?: string;
  manualStep?: string;
  productId?: string;
  coverage?: { layerId: string; availableOrders: number[]; overviewOrder: number; maxOrder: number };
}

interface SurveyRelease {
  id: string;
  label: string;
  kind: string;
  releasedYear?: number;
  modalities: Modality[];
  products: SurveyProduct[];
  coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null };
}

interface SurveyRecord {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: Modality[];
  releases: SurveyRelease[];
  coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null };
  imageUrl: string;
  statistics: {
    publicProducts: number;
    acquired: number;
    overviewOnly: number;
    awaitingGeometry: number;
    notApplicable: number;
    footprintCells: number;
  };
  assets: AssetRecord[];
}

interface SurveyIndex {
  schemaVersion: 1;
  generatedAt: string;
  surveys: SurveyRecord[];
  sharedAssets: AssetRecord[];
}

const modalityLabels: Record<string, string> = {
  imaging: "图像",
  spectroscopy: "光谱",
  redshift: "红移",
  photometry: "测光",
  "time-domain": "时域",
  "integral-field": "积分场",
  ultraviolet: "紫外",
  infrared: "红外",
  catalog: "目录",
  simulation: "仿真",
  radio: "射电",
};
const modalityLabelsEn: Record<string, string> = {
  imaging: "Imaging", spectroscopy: "Spectroscopy", redshift: "Redshift", photometry: "Photometry", "time-domain": "Time-domain", "integral-field": "Integral-field", ultraviolet: "Ultraviolet", infrared: "Infrared", catalog: "Catalog", simulation: "Simulation", radio: "Radio",
};

const statusLabels: Record<ProductStatus, string> = {
  acquired: "已收录",
  overview_only: "仅概览",
  awaiting_geometry: "待计算",
  not_applicable: "不适用",
};
const statusLabelsEn: Record<ProductStatus, string> = { acquired: "Acquired", overview_only: "Overview only", awaiting_geometry: "Awaiting geometry", not_applicable: "Not applicable" };

function modalityLabel(modality: string): string {
  const labels = locale() === "zh" ? modalityLabels : modalityLabelsEn;
  return (labels[modality] ?? modality) || "未指定模态";
}
function statusLabel(status: ProductStatus): string { return locale() === "zh" ? statusLabels[status] : statusLabelsEn[status]; }

function orderLabel(coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number } | null): string {
  if (!coverage?.availableOrders?.length) return "HEALPIX --";
  const orders = [...new Set(coverage.availableOrders)].sort((a, b) => a - b);
  return `O${orders.join(" · O")}`;
}

function displayOrdersLabel(orders: readonly number[]): string {
  const sorted = [...new Set(orders)].sort((left, right) => left - right);
  const ranges: Array<[number, number]> = [];
  for (const order of sorted) {
    const previous = ranges.at(-1);
    if (previous && order === previous[1] + 1) previous[1] = order;
    else ranges.push([order, order]);
  }
  return ranges.map(([start, end]) => start === end ? `O${start}` : `O${start}-O${end}`).join("/");
}

function orderSummaryLabel(summary?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }): string {
  if (!summary?.availableOrders?.length) return "HEALPIX --";
  const orders = [...new Set(summary.availableOrders)].sort((a, b) => a - b);
  const overview = summary.overviewOrders?.length ? ` · OVERVIEW O${summary.overviewOrders.join("/O")}` : "";
  return `O${orders.join(" / O")}${overview}`;
}

const assetGroupDefinitions: Array<{ id: "moc" | "geometry" | "package" | "evidence"; label: string; icon: string; kinds: AssetKind[] }> = [
  { id: "moc", label: "FITS MOC", icon: "telescope", kinds: ["moc"] },
  { id: "geometry", label: "几何", icon: "layers-3", kinds: ["geometry"] },
  { id: "package", label: "资源包", icon: "file-archive", kinds: ["package"] },
  { id: "evidence", label: "证据", icon: "file-check-2", kinds: ["metadata"] },
];

let manifest: ReleaseManifest | null = null;
let surveyIndex: SurveyIndex | null = null;
let search = "";
const PUBLIC_REQUEST_RETRY_DELAYS_MS = [150, 400, 900] as const;
const selectedModalities = new Set<Modality>();
let modalityFilterInitialized = false;
let coverageDots: AtlasCoverageGlobe | null = null;
let skyDepthControls: SkyDepthControls | null = null;
let skyDepthOpening = 0;
let skyDepthSelectionKey = "";
let skyDepthSelection: SkyDepthSelection | null = null;
let skyDepthInspection: SurveyLayerInspection | null = null;
let activeSurveyId: string | null = null;
let coverageCatalog: CoverageCatalog | null = null;
let activeOverlapModalities: string[] = [];
const coverageBlockCache = new Map<string, number[]>();
const coverageRequests = new Map<string, { promise: Promise<number[]>; signal?: AbortSignal }>();
type CoverageLayerLoadState = "loading" | "ready" | "empty" | "error";
const coverageLayerLoadStates = new Map<string, CoverageLayerLoadState>();
const coverageLayerLoadErrors = new Map<string, string>();
// Two full views at the DISPLAY_TILE_BUDGET, so toggling G or panning back
// within a view never evicts the blocks it is about to reuse.
const COVERAGE_CACHE_LIMIT = 384;
interface SkyDeepLinkTarget { surveyId?: string; productId?: string; layerId?: string; error?: string }
let deepLinkTarget: SkyDeepLinkTarget | null = null;
let pendingCoverageState: SurveyLayerState | null = null;
let coverageStateFrame = 0;
let overlapMode = false;
let overlapIntent = false;
let overlapRequestSequence = 0;
let overlapEvidenceSequence = 0;
let overlapViewSequence = 0;
let overlapController: AbortController | null = null;
let overlapInitialController: AbortController | null = null;
let overlapEvidenceController: AbortController | null = null;
let overlapViewController: AbortController | null = null;
let overlapDetailsController: AbortController | null = null;
let overlapDetailsPendingKey = "";
let activeOverlapSurveyIds: string[] = [];
let activeOverlapLayerIds: string[] = [];
let activeOverlapViewTiles: { order: number; tiles: number[] } | undefined;
let lastOverlapViewKey = "";
let pendingOverlapViewKey = "";
let activeOverlapOrder: number | null = null;
let activeOverlapOverviewKey = "";
let activeOverlapPixels: number[] = [];
let activeOverlapComponents: OverlapComponentView[] = [];
let overlapComponentsPage = 0;
let overlapDrawerComponentsPage = 0;
const hstLookupControllers = new WeakMap<HTMLElement, AbortController>();
const queuedLayerIds = new Set<string>();
const selectedCoverageProductIds = new Set<string>();
const displayTileIndexCache = new Map<string, { ranges: Array<{ start: number; end: number }>; totalTiles: number }>();
const DISPLAY_TILE_INDEX_RANGE_BUDGET = 250_000;
let displayTileIndexCachedRangeCount = 0;
let selectedDisplayOrder = 4;
let coverageDisplaySequence = 0;
let coverageDisplayController: AbortController | null = null;
let coverageDisplayPlanningController: AbortController | null = null;
let coverageDisplayPlanSequence = 0;
let coverageDisplayPendingViewKey = "";
let coverageDisplayTimer: number | null = null;
let coverageDisplayViewKey = "";
let coverageCameraKey = "";
let displayOrderTimer: number | null = null;
let displayOrderDragging = false;
let pendingDisplayOrder: number | null = null;
let coverageFocusActive = false;
let coverageDisplayStatus: string | null = null;
const DISPLAY_TILE_BUDGET = 192;
let selectedQueueComponent: OverlapComponentView | null = null;
let renderedQueueComponentId: string | null = null;
let overlapDrawerOpen = false;
let overlapPanelResizeObserver: ResizeObserver | null = null;
let overlapDrawerPreviousState: { layersHidden: boolean; queueHidden: boolean; panelHidden: boolean; helpHidden: boolean } | null = null;
let overlapDrawerPreviousFocus: HTMLElement | null = null;
let layerCloseTimer: number | null = null;
let layerCloseDeadline = 0;
let layerCloseRemaining = 0;
let layerClosePaused = false;
let coverageLayerTooltip: HTMLElement | null = null;
let coverageLayerTooltipCloseTimer: number | null = null;
const expandedCoverageSurveyIds = new Set<string>();
let coverageSearchExpandedBefore: Set<string> | null = null;
let coverageLayerSearchQuery = "";
let coverageLayerTooltipRow: HTMLElement | null = null;
let regionPanel: RegionQueryPanel | null = null;
let activeRegionQuery: OverlapComponentView | null = null;
let regionExportController: AbortController | null = null;
let regionEvidenceNode: HTMLElement | null = null;

function setOverlapMode(active: boolean): void {
  if (overlapMode !== active) { closeSkyDepth(); skyDepthInspection = null; }
  overlapMode = active;
  overlapIntent = active;
  if (active) document.body.dataset.overlapMode = "active";
  else {
    overlapViewSequence += 1;
    overlapViewController?.abort();
    overlapViewController = null;
    document.body.removeAttribute("data-overlap-mode");
  }
  renderDisplayOrderControl();
}

function isSurveyIndex(value: unknown): value is SurveyIndex {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Partial<SurveyIndex>).schemaVersion === 1
    && Array.isArray((value as Partial<SurveyIndex>).surveys)
    && Array.isArray((value as Partial<SurveyIndex>).sharedAssets));
}

function isCoverageCatalog(value: unknown): value is CoverageCatalog {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Number.isSafeInteger((value as Partial<CoverageCatalog>).schemaVersion)
    && Array.isArray((value as Partial<CoverageCatalog>).layers));
}

function isReleaseManifest(value: unknown): value is ReleaseManifest {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Partial<ReleaseManifest>).bundle
    && Array.isArray((value as Partial<ReleaseManifest>).files));
}

async function fetchPublicResponse(url: string, init: RequestInit = {}): Promise<Response> {
  class NonRetryablePublicRequestError extends Error {}
  let lastError: unknown;
  for (let attempt = 0; attempt <= PUBLIC_REQUEST_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, cache: init.cache ?? "no-store" });
      if (response.ok || response.status === 304) return response;
      const error = new Error(`Public catalog request failed (${response.status})`);
      if (response.status < 500 && response.status !== 408 && response.status !== 429) throw new NonRetryablePublicRequestError(error.message);
      lastError = error;
    } catch (error) {
      if (error instanceof NonRetryablePublicRequestError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error;
    }
    const delay = PUBLIC_REQUEST_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await new Promise((resolve) => window.setTimeout(resolve, delay));
  }
  throw lastError instanceof Error ? lastError : new Error("Public catalog request failed");
}

async function fetchPublicJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchPublicResponse(url, init);
  if (response.status === 304) throw new Error("Public catalog returned 304 without a cached response");
  return await response.json() as T;
}

const overlapEvidenceCache = new Map<string, OverlapEvidenceResult>();
/** Failed automatic previews are not retried until `until`; avoids a 429 retry storm on every re-render. */
const overlapEvidenceCooldown = new Map<string, { until: number; message: string }>();
/** Selection and drawer renders fire within one tick; wait so only the last one queries. */
const OVERLAP_EVIDENCE_DEBOUNCE_MS = 150;
const overlapEvidenceHosts = new Map<string, HTMLElement>();
const overlapDetailsCache = new Map<string, OverlapDetailsResponse>();
/** One request per key; a repeat render joins it instead of aborting and re-sending. */
const overlapDetailsInflight = new Map<string, Promise<OverlapDetailsResponse>>();
const overlapDetailsCooldown = new Map<string, { until: number; message: string }>();
/** Key of the details the open drawer currently shows, so an unchanged refresh leaves it alone. */
let drawerDetailsShownKey = "";
let lastEscapeAt = -Infinity;
const isAtlasPage = window.location.pathname === "/atlas/" || window.location.pathname === "/atlas";
let coverageSelectionInitialized = false;

mountLocaleControls();
mountSiteChrome();

function isAtlasInteractive(): boolean {
  return document.body.dataset.homeState === "atlas";
}

function coverageBlockKey(layer: CoverageCatalog["layers"][number], order: number, tile: number): string {
  return `${layer.layerId}:${layer.displayRevision ?? layer.revision ?? "legacy"}:${order}:${tile}`;
}

async function fetchCoverageBlock(layer: CoverageCatalog["layers"][number], order: number, tile: number, signal?: AbortSignal): Promise<number[]> {
  const key = coverageBlockKey(layer, order, tile);
  const cached = coverageBlockCache.get(key);
  if (cached) return cached;
  const inFlight = coverageRequests.get(key);
  if (inFlight && !inFlight.signal?.aborted) return inFlight.promise;
  if (inFlight) coverageRequests.delete(key);
  const controller = new AbortController();
  const request = (async (): Promise<number[]> => {
    try {
      const revision = layer.revision ? `&revision=${encodeURIComponent(layer.revision)}` : "";
      const displayRevision = layer.displayRevision ? `&displayRevision=${encodeURIComponent(layer.displayRevision)}` : "";
      const response = await fetch(`/api/v1/coverage/blocks/${encodeURIComponent(layer.layerId)}?order=${order}&tile=${tile}${revision}${displayRevision}`, { signal: signal ?? controller.signal, cache: "no-store" });
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error ?? `coverage block HTTP ${response.status}`);
      }
      const block = await response.json() as { cells?: number[] };
      const cells = Array.isArray(block.cells) ? [...new Set(block.cells)].sort((a, b) => a - b) : [];
      coverageBlockCache.set(key, cells);
      while (coverageBlockCache.size > COVERAGE_CACHE_LIMIT) coverageBlockCache.delete(coverageBlockCache.keys().next().value!);
      return cells;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return [];
      throw error;
    }
  })();
  const flight = { promise: request, signal };
  coverageRequests.set(key, flight);
  void request.then(
    () => { if (coverageRequests.get(key) === flight) coverageRequests.delete(key); },
    () => { if (coverageRequests.get(key) === flight) coverageRequests.delete(key); },
  );
  return request;
}

interface DisplayTileIndex {
  layerId: string;
  order: number;
  tileSize: number;
  ranges: Array<{ start: number; end: number }>;
  totalTiles: number;
  displayRevision: string;
}

async function fetchDisplayTileIndex(layer: CoverageCatalog["layers"][number], order: number, signal: AbortSignal): Promise<DisplayTileIndex> {
  const cacheKey = `${layer.layerId}:${layer.displayRevision ?? layer.revision ?? "legacy"}:${order}`;
  const cached = displayTileIndexCache.get(cacheKey);
  if (cached) {
    displayTileIndexCache.delete(cacheKey);
    displayTileIndexCache.set(cacheKey, cached);
    return { layerId: layer.layerId, order, tileSize: 4096, ...cached, displayRevision: layer.displayRevision ?? "" };
  }
  const revision = layer.displayRevision ? `&displayRevision=${encodeURIComponent(layer.displayRevision)}` : "";
  const response = await fetch(`/api/v1/coverage/blocks/${encodeURIComponent(layer.layerId)}?order=${order}&tiles=1${revision}`, { signal, cache: "no-store" });
  const body = await response.json().catch(() => null) as DisplayTileIndex | { error?: string } | null;
  if (!response.ok || !body || !("ranges" in body)) throw new Error(body && "error" in body ? body.error ?? `tile index HTTP ${response.status}` : `tile index HTTP ${response.status}`);
  if (body.displayRevision !== (layer.displayRevision ?? "")) throw new Error("Coverage geometry changed while loading display tiles; refresh the catalog");
  if (body.ranges.length <= DISPLAY_TILE_INDEX_RANGE_BUDGET) {
    while (displayTileIndexCache.size >= 128 || displayTileIndexCachedRangeCount + body.ranges.length > DISPLAY_TILE_INDEX_RANGE_BUDGET) {
      const oldestKey = displayTileIndexCache.keys().next().value;
      if (!oldestKey) break;
      displayTileIndexCachedRangeCount -= displayTileIndexCache.get(oldestKey)!.ranges.length;
      displayTileIndexCache.delete(oldestKey);
    }
    displayTileIndexCache.set(cacheKey, { ranges: body.ranges, totalTiles: body.totalTiles });
    displayTileIndexCachedRangeCount += body.ranges.length;
  }
  return body;
}

async function fetchCoverageOverview(layer: CoverageCatalog["layers"][number]): Promise<number[]> {
  return fetchCoverageLayerOrder(layer, layer.overviewOrder);
}

async function fetchCoverageLayerOrder(layer: CoverageCatalog["layers"][number], order: number): Promise<number[]> {
  const tiles = layer.tileIdsByOrder?.[String(order)] ?? [0];
  coverageLayerLoadStates.set(layer.layerId, "loading");
  coverageLayerLoadErrors.delete(layer.layerId);
  try {
    const blocks = await Promise.all(tiles.map((tile) => fetchCoverageBlock(layer, order, tile)));
    const cells = [...new Set(blocks.flat())].sort((a, b) => a - b);
    coverageLayerLoadStates.set(layer.layerId, cells.length ? "ready" : "empty");
    return cells;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return [];
    coverageLayerLoadStates.set(layer.layerId, "error");
    coverageLayerLoadErrors.set(layer.layerId, error instanceof Error ? error.message : "coverage block unavailable");
    return [];
  }
}

function allCoverageSurveyIds(): string[] {
  return [...new Set(coverageCatalog?.layers.map((layer) => layer.surveyId) ?? [])];
}

function productForLayer(layer: CoverageCatalog["layers"][number]): SurveyProduct | undefined {
  const survey = surveyIndex?.surveys.find((entry) => entry.id === layer.surveyId);
  const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
  return release?.products.find((product) => product.productId === layer.productId || product.name === layer.product);
}

function readSkyDeepLink(): SkyDeepLinkTarget | null {
  const params = new URLSearchParams(window.location.search);
  const surveyId = params.get("survey")?.trim() || undefined;
  const productId = params.get("product")?.trim() || undefined;
  if (!surveyId && !productId) return null;
  const productMatch = productId
    ? surveyIndex?.surveys.flatMap((survey) => survey.releases.flatMap((release) => release.products.map((product) => ({ surveyId: survey.id, product }))))
      .find((entry) => entry.product.productId === productId)
    : undefined;
  if (productId && !productMatch) return { surveyId, productId, error: "PRODUCT DEEP LINK NOT FOUND" };
  if (surveyId && productMatch && surveyId !== productMatch.surveyId) return { surveyId, productId, error: "PRODUCT DOES NOT BELONG TO SURVEY" };
  const resolvedSurveyId = productMatch?.surveyId ?? surveyId;
  const product = productMatch?.product;
  const layer = product?.coverage?.layerId
    ? coverageCatalog?.layers.find((entry) => entry.layerId === product.coverage?.layerId)
    : product ? coverageCatalog?.layers.find((entry) => entry.productId === product.productId || entry.product === product.name) : undefined;
  return { surveyId: resolvedSurveyId, ...(productId ? { productId } : {}), ...(layer ? { layerId: layer.layerId } : {}) };
}

function syncSkyDeepLink(surveyId?: string, productId?: string): void {
  const url = new URL(window.location.href);
  url.search = "";
  if (surveyId) url.searchParams.set("survey", surveyId);
  if (productId) url.searchParams.set("product", productId);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function coverageDiagnosticText(): string | null {
  const failures = [...coverageLayerLoadStates.entries()].filter(([, state]) => state === "error");
  if (!failures.length) return null;
  const summary = failures.length === 1 ? "1 COVERAGE LAYER FAILED TO LOAD" : `${failures.length} COVERAGE LAYERS FAILED TO LOAD`;
  return `${summary} · OPEN LAYERS TO RETRY`;
}

function renderCoverageLoadDiagnostics(): void {
  const message = coverageDiagnosticText();
  if (message) byId("coverage-state").textContent = message;
}

function coverageStateText(defaultValue: string): string {
  return coverageDiagnosticText() ?? coverageDisplayStatus ?? defaultValue;
}

function setCoverageDisplayStatus(message: string): void {
  coverageDisplayStatus = message;
  byId("coverage-state").textContent = message;
  const drawerStatus = document.getElementById("overlap-drawer-display-state");
  if (drawerStatus) drawerStatus.textContent = message;
}

/** Order of the survey coverage drawn under the overlap highlight. */
function backgroundOrderText(): string {
  const sourceNside = coverageDots?.state?.sourceNside;
  return sourceNside ? `${t("coverage.overviewOrder")} O${Math.round(Math.log2(sourceNside))}` : "";
}

function retainedDisplayOrderText(): string {
  const nside = coverageDots?.state?.nside;
  const background = overlapMode && activeOverlapOrder !== null ? backgroundOrderText() : "";
  return nside ? `${locale() === "zh" ? "当前显示" : "Showing"} O${Math.round(Math.log2(nside))}${background ? ` · ${background}` : ""}` : "";
}

function overlapDisplayStatus(order: number, pixels: readonly number[]): string {
  const result = pixels.length
    ? `${t("coverage.commonOrder")} O${order} · ${pixels.length.toLocaleString("en-US")} CELLS`
    : `${t("coverage.noCommon")} · O${order}`;
  const background = backgroundOrderText();
  return background ? `${result} · ${background}` : result;
}

function coverageOrderText(order: number, sourceOrder: number): string {
  return overlapMode
    ? `${t("coverage.overviewOrder")} O${sourceOrder} · ${t("coverage.overlapDisplayOrder")} O${order}`
    : `DISPLAY O${order}`;
}

function focusSkyTarget(target: SkyDeepLinkTarget | null): void {
  if (!target?.surveyId || !coverageDots) return;
  const layer = target.layerId
    ? coverageCatalog?.layers.find((entry) => entry.layerId === target.layerId)
    : target.productId
      ? coverageCatalog?.layers.find((entry) => entry.productId === target.productId)
      : undefined;
  if (layer?.modality && selectedModalities.size && !filterByModalities([layer], selectedModalities).length) {
    selectedModalities.add(canonicalModality(layer.modality) as Modality);
    coverageDots.setVisibleModalities(selectedModalities);
    renderCoverageLayers();
  }
  applyCoverageSelection([target.surveyId]);
  coverageDots.setSelectedSurvey(target.surveyId);
  if (layer) {
    const cells = fetchCoverageLayerOrder(layer, layer.overviewOrder);
    void cells.then((values) => {
      if (!values.length || !coverageDots) return;
      coverageDots.focusPixels(layer.overviewOrder, values);
      updateCoverageReadout(layer.surveyId, productForLayer(layer)?.name ?? layer.product);
    });
  }
  updateCoverageReadout(target.surveyId, layer ? productForLayer(layer)?.name ?? layer.product : undefined);
}

function updateCoverageReadout(surveyId: string | null, product?: string): void {
  activeSurveyId = surveyId;
  const scene = byId("coverage-scene");
  const title = byId("coverage-selection-title");
  const meta = byId("coverage-selection-meta");
  const state = byId("coverage-state");
  const survey = surveyId ? surveyIndex?.surveys.find((entry) => entry.id === surveyId) : undefined;
  const layers = surveyId ? visibleCoverageLayers().filter((layer) => layer.surveyId === surveyId) : [];
  const queryOrders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((left, right) => left - right);
  const commonDisplayOrders = selectedLayerOrders();
  const displayedOrder = Math.round(Math.log2(coverageDots?.state?.nside ?? 2 ** selectedDisplayOrder));
  const displayText = coverageOrderText(displayedOrder, Math.round(Math.log2(coverageDots?.state?.sourceNside ?? 2 ** displayedOrder)));
  const orderText = layers.length
    ? `${displayText} · COMMON O${commonDisplayOrders.join("/O")} · BLOCKS O${queryOrders.join("/O")}`
    : `NESTED HEALPIX · ${displayText}`;
  if (!survey) {
    if (surveyId && layers.length) {
      scene.style.setProperty("--coverage-color", surveyColorFor(surveyId, layers[0]?.color));
      title.textContent = product ? `${surveyId.toUpperCase()} · ${product.toUpperCase()}` : surveyId.toUpperCase();
      meta.textContent = `${orderText} · ${coverageDots?.state?.visibleCellCount ?? 0} VISIBLE O${displayedOrder} CELLS`;
      state.textContent = coverageStateText(`${layers.length} COVERAGE LAYERS · SELECTED`);
      return;
    }
    scene.style.removeProperty("--coverage-color");
    title.textContent = t("coverage.allSurveys");
    meta.textContent = `NESTED HEALPIX · ${displayText} · NSIDE ${2 ** displayedOrder}`;
    state.textContent = coverageStateText(coverageDots ? t("coverage.publicCells") : t("coverage.previewUnavailable"));
    return;
  }
  scene.style.setProperty("--coverage-color", surveyColorFor(survey.id, survey.color, layers[0]?.color));
  title.textContent = product ? `${survey.name.toUpperCase()} · ${product.toUpperCase()}` : survey.name.toUpperCase();
  meta.textContent = `${orderText} · ${coverageDots?.state?.visibleCellCount ?? 0} VISIBLE O${displayedOrder} / ${survey.statistics.footprintCells.toLocaleString("en-US")} OVERVIEW CELLS`;
  state.textContent = coverageStateText(`${survey.statistics.acquired}/${survey.statistics.publicProducts} PRODUCTS · SELECTED`);
}

function updateCoverageState(state: SurveyLayerState): void {
  pendingCoverageState = state;
  if (coverageStateFrame) return;
  coverageStateFrame = requestAnimationFrame(() => {
    coverageStateFrame = 0;
    const next = pendingCoverageState;
    if (!next) return;
    if (!overlapMode) {
      const sources = skyDepthSources();
      const inspection = skyDepthInspection?.nside !== next.nside ? skyDepthInspection : null;
      if (next.selectedPixels.length && sources.length) void showSkyDepth({ order: Math.round(Math.log2(inspection?.nside ?? next.nside)), cells: inspection ? [inspection.pixel] : next.selectedPixels, sources });
      else closeSkyDepth();
    }
    const displayedOrder = Math.round(Math.log2(next.nside));
    const sourceOrder = Math.round(Math.log2(next.sourceNside));
    const nsideStatus = byId("coverage-status-nside");
    nsideStatus.textContent = `${next.nside} · O${displayedOrder}${overlapMode ? ` · ${t("coverage.overviewOrder")} O${sourceOrder}` : ""}`;
    nsideStatus.dataset.sourceOrder = String(sourceOrder);
    byId("coverage-status-fov").textContent = `${next.effectiveFovDeg.toFixed(1)}°`;
    const [x, y, z] = next.cameraPosition;
    byId("coverage-status-camera").textContent = `${next.cameraDistance.toFixed(2)} / ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`;
    syncHud(next);
    if (activeSurveyId) {
      const survey = surveyIndex?.surveys.find((entry) => entry.id === activeSurveyId);
      const layers = visibleCoverageLayers().filter((layer) => layer.surveyId === activeSurveyId);
      const queryOrders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((left, right) => left - right);
      const commonOrders = selectedLayerOrders();
      const displayText = coverageOrderText(displayedOrder, sourceOrder);
      const orderText = layers.length
        ? `${displayText} · COMMON O${commonOrders.join("/O")} · BLOCKS O${queryOrders.join("/O")}`
        : `NESTED HEALPIX · ${displayText}`;
      const displayedCells = next.visibleCellCount.toLocaleString("en-US");
      const overview = survey ? ` / ${survey.statistics.footprintCells.toLocaleString("en-US")} OVERVIEW CELLS` : "";
      byId("coverage-selection-meta").textContent = `${orderText} · ${displayedCells} VISIBLE O${displayedOrder}${overview}`;
    }
    const cameraKey = `${next.cameraPosition.map((value) => value.toFixed(5)).join(",")}:${next.coverageViewDirection.map((value) => value.toFixed(5)).join(",")}:${next.coverageViewRadiusRad.toFixed(5)}`;
    if (cameraKey === coverageCameraKey) return;
    coverageCameraKey = cameraKey;
    if (pendingDisplayOrder !== null || displayOrderDragging) return;
    if (overlapInitialController && !overlapInitialController.signal.aborted) return;
    if (selectedDisplayOrder >= 6 && !overlapMode && !overlapViewController) {
      if (coverageDisplayTimer !== null) window.clearTimeout(coverageDisplayTimer);
      coverageDisplayTimer = window.setTimeout(() => {
        coverageDisplayTimer = null;
        void loadCoverageDisplay();
      }, 350);
    }
    if (overlapMode && overlapViewTileOrder(selectedDisplayOrder) !== null) {
      if (coverageDisplayTimer !== null) window.clearTimeout(coverageDisplayTimer);
      coverageDisplayTimer = window.setTimeout(() => {
        coverageDisplayTimer = null;
        if (overlapInitialController && !overlapInitialController.signal.aborted) return;
        void activateOverlap(true);
      }, 450);
    }
  });
}

function setLockHeadline(prefix: string, value: string | null, sub = ""): void {
  const host = document.getElementById("coverage-detail-headline");
  if (!host) return;
  host.hidden = value === null;
  const em = document.createElement("em");
  em.textContent = value ?? "";
  host.replaceChildren(`${prefix} `, em, ...(sub ? [Object.assign(document.createElement("small"), { textContent: sub })] : []));
}

function lockActions(surveyIds: string[], pixels: number[], order: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "hud-lock-cta";
  const action = (label: string, key: string, hot: boolean, run: () => void, disabled = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `hud-btn${hot ? " is-hot" : ""}`;
    button.disabled = disabled;
    button.append(label, Object.assign(document.createElement("kbd"), { textContent: key }));
    button.addEventListener("click", run);
    row.append(button);
  };
  const zh = locale() === "zh";
  action(zh ? "展开重合" : "OVERLAP", "G", true, () => { void activateOverlap(); }, visibleSurveyIdsFromControls().length < 2);
  action(zh ? "聚焦" : "FOCUS", "F", false, () => focusCoverageSelection());
  action(zh ? "导出" : "EXPORT", "E", false, () => exportCoverageCells(surveyIds, pixels, order), !surveyIds.length);
  return row;
}

function focusCoverageSelection(): void {
  coverageFocusActive = true;
  coverageDisplayViewKey = "";
  if (!skyDepthControls?.focus()) coverageDots?.focusSelection();
}

function exportCoverageCells(_surveyIds: string[], pixels: number[], order: number): void {
  if (!pixels.length) return;
  const layers = visibleCoverageLayers();
  if (!layers.length) { toast(t("region.noLayers")); return; }
  regionPanel?.open();
  renderRegionQuery({ id: "SELECTED-CELLS", selectedRegion: true, order, cells: [...pixels], bounds: overlapBounds(pixels, order),
    evidenceLookup: { endpoint: "/api/v1/coverage/reverse-lookup", layerIds: layers.map(layer => layer.layerId), order, precision: "estimated", deferred: false } });
}

function updateCoverageInspector(inspection: SurveyLayerInspection | null): void {
  // The expanded drawer owns a whole connected region, never a hidden cell
  // inspector/depth request competing with its selected component.
  if (overlapDrawerOpen) return;
  skyDepthInspection = inspection;
  const panel = byId("coverage-detail-panel");
  if (!inspection) {
    setHudTarget(null);
    closeSkyDepth();
    if (!overlapMode) {
      abortHstLookupsWithin(byId("coverage-detail-content"));
      panel.hidden = true;
    }
    return;
  }
  const order = Math.round(Math.log2(inspection.nside));
  const overlapParent = overlapMode
    ? activeOverlapComponents.find((component) => component.order === order && component.cells.includes(inspection.pixel))
    : undefined;
  const overlapCell = overlapParent && reverseLookupRegionTooLarge(overlapParent) ? {
    ...overlapParent,
    id: `${overlapParent.id}-cell-${inspection.pixel}`,
    cells: [inspection.pixel],
    bounds: overlapBounds([inspection.pixel], order),
  } : overlapParent;
  if (!overlapMode) {
    panel.classList.remove("is-overlap-panel");
    panel.style.removeProperty("left");
    panel.style.removeProperty("top");
    panel.style.removeProperty("right");
    panel.style.removeProperty("width");
  } else {
    panel.classList.add("is-overlap-panel");
  }
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = overlapMode ? t("coverage.overlapResult") : t("coverage.cellInspector");
  byId("coverage-detail-title").textContent = `ORDER ${order} · IPix ${inspection.pixel}`;
  setLockHeadline("IPIX", String(inspection.pixel), `NSIDE ${inspection.nside} · NESTED · ICRS`);
  const content = byId("coverage-detail-content");
  delete content.dataset.overlapTargetKey;
  delete content.dataset.overlapRenderKey;
  delete content.dataset.overlapDetailKey;
  abortHstLookupsWithin(content);
  const cellSources = overlapParent?.surveys ?? [];
  const surveyName = (surveyId: string) => surveyIndex?.surveys.find((survey) => survey.id === surveyId)?.name ?? surveyId;
  const stats = document.createElement("div");
  stats.className = "hud-lock-stats";
  const cellArea = SKY_AREA_DEG2 / (12 * inspection.nside ** 2);
  for (const [label, value, title] of [
    ["RA", `${inspection.centerRaDeg.toFixed(1)}°`, `${inspection.centerRaDeg.toFixed(4)}°`],
    ["DEC", `${inspection.centerDecDeg >= 0 ? "+" : "−"}${Math.abs(inspection.centerDecDeg).toFixed(1)}°`, `${inspection.centerDecDeg.toFixed(4)}°`],
    ["AREA", `${cellArea >= 10 ? cellArea.toFixed(1) : cellArea >= 0.1 ? cellArea.toFixed(2) : cellArea.toFixed(4)} deg²`, `${cellArea} deg²`],
  ]) {
    const cell = document.createElement("div");
    cell.title = title!;
    cell.append(Object.assign(document.createElement("small"), { textContent: label }), Object.assign(document.createElement("b"), { textContent: value }));
    stats.append(cell);
  }
  const sourceRows = [...new Map([
    ...inspection.artifacts.map((artifact) => ({ surveyId: artifact.surveyId, releaseId: artifact.releaseId, product: artifact.product, modality: artifact.modality })),
    ...cellSources.map((source) => ({ surveyId: source.surveyId, releaseId: source.releaseId, product: source.product, modality: source.modality })),
  ].map((source) => [`${source.surveyId}:${source.releaseId}:${source.product}`, source])).values()];
  const sources = document.createElement("ul");
  sources.className = "hud-lock-sources coverage-detail-source-list";
  // One row per survey release; products of the same release share the row.
  const releaseRows = [...sourceRows.reduce((groups, source) => {
    const key = `${source.surveyId}:${source.releaseId}`;
    const group = groups.get(key);
    if (group) {
      group.products.push(source.product);
      if (source.modality && !group.modalities.includes(source.modality)) group.modalities.push(source.modality);
    } else groups.set(key, { surveyId: source.surveyId, releaseId: source.releaseId, products: [source.product], modalities: source.modality ? [source.modality] : [] });
    return groups;
  }, new Map<string, { surveyId: string; releaseId: string; products: string[]; modalities: string[] }>()).values()];
  const LOCK_SOURCE_ROWS = 4;
  releaseRows.slice(0, LOCK_SOURCE_ROWS).map((group) => ({
    surveyId: group.surveyId,
    releaseId: group.releaseId,
    product: group.products.length > 1 ? `${group.products[0]} +${group.products.length - 1}` : group.products[0]!,
    modality: group.modalities.join("/") || undefined,
    title: group.products.join("\n"),
  })).forEach((source) => {
    const row = document.createElement("li");
    row.style.setProperty("--c", surveyColorFor(source.surveyId, surveyIndex?.surveys.find((survey) => survey.id === source.surveyId)?.color));
    row.title = `${surveyName(source.surveyId)} · ${source.releaseId} · ${source.modality ?? "modality unknown"}\n${source.title}`;
    row.append(
      Object.assign(document.createElement("i"), { ariaHidden: "true" }),
      Object.assign(document.createElement("b"), { textContent: `${surveyName(source.surveyId).toUpperCase()} ${shortReleaseLabel(source.surveyId, source.releaseId)}` }),
      Object.assign(document.createElement("span"), { textContent: source.product }),
      Object.assign(document.createElement("em"), { textContent: (source.modality ?? "--").toUpperCase() }),
    );
    sources.append(row);
  });
  if (releaseRows.length > LOCK_SOURCE_ROWS) {
    const more = document.createElement("li");
    more.className = "is-empty";
    more.textContent = `+${releaseRows.length - LOCK_SOURCE_ROWS} ${locale() === "zh" ? "个数据版本" : "MORE RELEASES"}`;
    sources.append(more);
  }
  if (overlapParent) {
    const row = document.createElement("li");
    row.className = "is-overlap";
    row.append(
      Object.assign(document.createElement("i"), { ariaHidden: "true" }),
      Object.assign(document.createElement("b"), { textContent: `OVERLAP ${overlapParent.id}` }),
      Object.assign(document.createElement("span"), { textContent: t("coverage.overlapResult") }),
      Object.assign(document.createElement("em"), { textContent: `${overlapParent.cells.length.toLocaleString("en-US")} CELLS` }),
    );
    sources.append(row);
  }
  if (!sources.childElementCount) {
    const row = document.createElement("li");
    row.className = "is-empty";
    row.textContent = inspection.workspaceAvailable ? "workspace layer" : "--";
    sources.append(row);
  }
  const selectedPixels = coverageDots?.state?.nside === inspection.nside && coverageDots.state.selectedPixels.length ? coverageDots.state.selectedPixels : [inspection.pixel];
  const surveyIds = [...new Set([...inspection.surveyIds, ...cellSources.map((source) => source.surveyId)])];
  content.replaceChildren(stats, sources, lockActions(surveyIds, selectedPixels, order));
  setHudTarget({
    order,
    pixel: inspection.pixel,
    cellCount: selectedPixels.length,
    label: [surveyIds.map((id) => surveyName(id).toUpperCase()).join(" × ") || "NO PUBLIC LAYER", overlapParent?.id].filter(Boolean).join(" · "),
    surveys: surveyIds.map((surveyId) => {
      const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
      // Modalities of the products covering this cell; otherwise what the survey declares.
      const measured = [...new Set(sourceRows.filter((source) => source.surveyId === surveyId && source.modality).map((source) => canonicalModality(source.modality!)))];
      const declared = [...new Set((survey?.modalities ?? []).map((modality) => canonicalModality(modality)))];
      return {
        name: surveyName(surveyId).toUpperCase(),
        color: surveyColorFor(surveyId, survey?.color),
        modalities: (measured.length ? measured : declared).filter(Boolean).map((modality) => modalityLabel(modality)),
        declared: !measured.length && declared.length > 0,
      };
    }),
  });
  hudLog(["TARGET ACQUIRED · ", { text: `IPIX ${inspection.pixel}`, tone: "hot" }, ` · O${order}`]);
  const depthSources = withDesiReference(overlapMode ? [...new Map([...inspection.artifacts, ...cellSources]
    .map(source => [`${source.surveyId}:${source.releaseId}`, { surveyId: source.surveyId, releaseId: source.releaseId }])).values()] : skyDepthSources());
  if (depthSources.length && order >= 4) {
    const state = coverageDots?.state;
    void showSkyDepth({ order, cells: !overlapMode && state?.nside === inspection.nside && state.selectedPixels.length ? state.selectedPixels : [inspection.pixel], sources: depthSources }, true);
  } else closeSkyDepth();
  if (overlapMode) {
    setOverlapExpandVisible(false);
    if (overlapCell?.evidenceLookup) {
      const section = document.createElement("section");
      section.className = "overlap-cell-evidence-section";
      section.append(Object.assign(document.createElement("strong"), { textContent: t("coverage.overlapCellUnits") }));
      const evidence = document.createElement("div");
      evidence.className = "overlap-evidence-plan";
      section.append(evidence);
      content.append(section);
      void loadOverlapEvidence(overlapCell, evidence);
    }
    positionOverlapPanel();
  } else setOverlapExpandVisible(false);
}

function hstSize(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return t("coverage.hstSizeUnknown");
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let index = -1;
  do { amount /= 1024; index++; } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}

function abortHstLookupsWithin(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".hst-image-lookup-results").forEach((host) => hstLookupControllers.get(host)?.abort());
}

async function appendHstImageLookupResults(container: HTMLElement, order: number, cells: number[]): Promise<void> {
  const section = document.createElement("section");
  section.className = "hst-image-lookup-region";
  const heading = document.createElement("strong");
  heading.className = "hst-image-lookup-heading";
  heading.textContent = t("coverage.hstRegionFiles");
  section.append(heading);
  if (cells.length > HST_IMAGE_LOOKUP_MAX_CELLS) {
    section.append(Object.assign(document.createElement("small"), { className: "hst-image-lookup-region-note", textContent: t("coverage.hstRegionTooLarge") }));
    container.append(section);
    return;
  }
  const resultArea = document.createElement("div");
  resultArea.className = "hst-image-lookup-results";
  resultArea.setAttribute("aria-live", "polite");
  resultArea.setAttribute("aria-busy", "true");
  const pending = document.createElement("div");
  pending.className = "hst-image-lookup-loading";
  pending.setAttribute("role", "status");
  pending.append(icon("loader-circle"), document.createTextNode(t("coverage.hstSearching")));
  resultArea.append(pending);
  section.append(resultArea);
  container.append(section);
  renderIcons();
  const controller = new AbortController();
  hstLookupControllers.set(resultArea, controller);
  try {
    const response = await fetch("/api/v1/coverage/hst-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order, cells }),
      signal: controller.signal,
    });
    const result = await response.json() as HstImageLookup & { error?: string };
    if (!response.ok) throw new Error(result.error ?? t("coverage.hstLookupFailed"));
    if (!resultArea.isConnected || controller.signal.aborted) return;
    if (!Array.isArray(result.errors)) result.errors = [];
    renderHstImageLookup(result, resultArea);
  } catch (error) {
    if (controller.signal.aborted) return;
    resultArea.textContent = error instanceof Error ? error.message : t("coverage.hstLookupFailed");
  } finally {
    resultArea.setAttribute("aria-busy", "false");
    hstLookupControllers.delete(resultArea);
  }
}

function renderHstImageLookup(result: HstImageLookup, host: HTMLElement): void {
  const summary = document.createElement("p");
  summary.className = "hst-image-lookup-summary";
  const fileCount = result.observations.reduce((sum, observation) => sum + observation.files.length, 0);
  const errors = result.errors ?? [];
  summary.textContent = `O${result.order} · ${t("coverage.hstEstimated")} · ${result.observations.length} ${t("coverage.hstObservations")}${result.truncated || !result.queryExhausted || errors.length ? ` · ${t("coverage.hstResultsPartial")}` : ""}`;
  const groups = document.createElement("div");
  groups.className = "hst-image-observations";
  if (!result.observations.length && !errors.length) groups.append(Object.assign(document.createElement("p"), { className: "hst-image-lookup-summary", textContent: t("coverage.hstNoMatches") }));
  const observationsWithProductErrors = new Set(errors.flatMap((error) => error.stage === "products" && error.obsid ? [error.obsid] : []));
  const visibleObservations = result.observations.slice(0, HST_IMAGE_LOOKUP_DISPLAY_LIMIT);
  let remainingFiles = HST_IMAGE_LOOKUP_DISPLAY_LIMIT;
  let displayedFileCount = 0;
  for (const observation of visibleObservations) {
    const section = document.createElement("section");
    section.className = "hst-image-observation";
    const heading = document.createElement("div");
    heading.className = "hst-image-observation-heading";
    const title = document.createElement("strong");
    title.textContent = `MAST ${observation.obsid} · ${observation.instrument ?? "HST"} · ${observation.filters ?? ""}`;
    const source = document.createElement("a"); source.href = observation.productUrl; source.target = "_blank"; source.rel = "noopener noreferrer"; source.textContent = t("coverage.hstMastEntry");
    heading.append(title, source);
    section.append(heading);
    if (observation.target) {
      const target = document.createElement("p"); target.textContent = observation.target; section.append(target);
    }
    const products = document.createElement("ul");
    const visibleFiles = observation.files.slice(0, remainingFiles);
    remainingFiles -= visibleFiles.length;
    displayedFileCount += visibleFiles.length;
    for (const file of visibleFiles) {
      const item = document.createElement("li");
      const name = document.createElement("span"); name.textContent = file.fileName;
      const metadata = document.createElement("small"); metadata.textContent = `${file.recommendation} · ${file.productGroup ?? file.productType ?? "HST image"} · ${hstSize(file.sizeBytes)}`;
      item.append(name, metadata); products.append(item);
    }
    if (!observation.files.length) products.append(Object.assign(document.createElement("li"), { textContent: observationsWithProductErrors.has(observation.obsid) ? t("coverage.hstProductsFailed") : t("coverage.hstNoFiles") }));
    section.append(products);
    groups.append(section);
  }
  let failures: HTMLElement | undefined;
  if (errors.length) {
    failures = document.createElement("div");
    failures.className = "hst-image-lookup-errors";
    failures.append(Object.assign(document.createElement("p"), { textContent: t("coverage.hstPartialFailures").replace("{count}", String(errors.length)) }));
    const failedRequests = document.createElement("ul");
    errors.forEach((error) => {
      const item = document.createElement("li");
      const scope = error.stage === "products"
        ? `MAST ${error.obsid ?? "?"}`
        : `MAST · ${t("coverage.hstObservationPage")} ${error.page ?? "?"}`;
      const message = error.kind === "timeout"
        ? t("coverage.hstMastTimeout")
        : error.kind === "unavailable" ? t("coverage.hstMastUnavailable") : error.message;
      item.textContent = `${scope} · ${message}`;
      failedRequests.append(item);
    });
    failures.append(failedRequests);
  }
  const limits: HTMLElement[] = [];
  if (fileCount > displayedFileCount) {
    limits.push(Object.assign(document.createElement("p"), {
      className: "hst-image-lookup-limit",
      textContent: t("coverage.hstDisplayedFiles").replace("{shown}", String(displayedFileCount)).replace("{total}", String(fileCount)),
    }));
  }
  if (result.observations.length > visibleObservations.length) {
    limits.push(Object.assign(document.createElement("p"), {
      className: "hst-image-lookup-limit",
      textContent: t("coverage.hstDisplayedObservations").replace("{shown}", String(visibleObservations.length)).replace("{total}", String(result.observations.length)),
    }));
  }
  const provenance = document.createElement("small");
  provenance.className = "hst-image-lookup-provenance";
  provenance.textContent = `${t("coverage.hstSnapshot")} ${result.sourceSnapshotSha256.slice(0, 12)}${result.sourceSnapshotCapturedAt ? ` · ${result.sourceSnapshotCapturedAt}` : ""}${result.excludedWithoutRegion ? ` · ${result.excludedWithoutRegion} ${t("coverage.hstMissingRegion")}` : ""}`;
  host.replaceChildren(summary, ...(failures ? [failures] : []), groups, ...limits, provenance);
}

function updateOverlapViewport(): void {
  const drawer = byId("overlap-drawer");
  const inset = overlapDrawerOpen && window.innerWidth > 820 && !drawer.hidden ? drawer.getBoundingClientRect().width : 0;
  coverageDots?.setViewportRightInset(inset);
  updateOverlapPanelLayout();
}

function setOverlapPanelInteraction(element: HTMLElement, dismissed: boolean): void {
  element.inert = dismissed;
  if (dismissed) {
    element.setAttribute("aria-hidden", "true");
    element.dataset.overlapDismissed = "true";
  } else if (element.dataset.overlapDismissed === "true") {
    element.inert = false;
    element.removeAttribute("aria-hidden");
    delete element.dataset.overlapDismissed;
  }
}

function updateOverlapPanelLayout(): void {
  const drawer = byId("overlap-drawer");
  const panel = byId("coverage-detail-panel");
  const queue = byId("selection-queue");
  if (!overlapPanelResizeObserver && typeof ResizeObserver !== "undefined") {
    overlapPanelResizeObserver = new ResizeObserver(() => updateOverlapPanelLayout());
    overlapPanelResizeObserver.observe(drawer);
  }
  const crowded = overlapDrawerOpen && !drawer.hidden
    && overlapPanelsShouldExit(window.innerWidth, drawer.getBoundingClientRect().width);
  const layersOpen = document.body.dataset.layersPanel === "open";
  if (crowded) {
    document.body.dataset.overlapPanels = "dismissed";
    document.body.style.setProperty("--overlap-panel-exit-transform", overlapPanelExitTransform(window.innerWidth));
  } else if (overlapDrawerOpen && !drawer.hidden) {
    document.body.dataset.overlapPanels = "visible";
    document.body.style.removeProperty("--overlap-panel-exit-transform");
  } else {
    document.body.removeAttribute("data-overlap-panels");
    document.body.style.removeProperty("--overlap-panel-exit-transform");
  }
  setOverlapPanelInteraction(panel, crowded);
  setOverlapPanelInteraction(byId("coverage-depth-panel"), crowded);
  setOverlapPanelInteraction(queue, crowded || layersOpen);
}

function visibleSurveyIdsFromControls(): string[] {
  return [...byId("coverage-layers").querySelectorAll<HTMLInputElement>("input[data-survey-id]:not([data-release-id])")]
    .filter((input) => input.checked || input.indeterminate)
    .map((input) => input.dataset.surveyId)
    .filter((value): value is string => Boolean(value));
}

function visibleCoverageLayers(): CoverageCatalog["layers"] {
  return filterByModalities(coverageCatalog?.layers ?? [], selectedModalities)
    .filter((layer) => selectedCoverageProductIds.has(layer.layerId));
}

function applyCoverageSelection(surveyIds: Iterable<string>): void {
  cancelCoverageDisplayRequest();
  const next = new Set(surveyIds);
  coverageSelectionInitialized = true;
  queuedLayerIds.clear();
  next.forEach((surveyId) => queuedLayerIds.add(surveyId));
  selectedCoverageProductIds.clear();
  filterByModalities(coverageCatalog?.layers ?? [], selectedModalities)
    .filter((layer) => next.has(layer.surveyId))
    .forEach((layer) => selectedCoverageProductIds.add(layer.layerId));
  syncCoverageProductControls();
  clampDisplayOrderToSelection();
  coverageDots?.setVisibleSurveys(next);
  coverageDots?.setVisibleLayers(selectedCoverageProductIds);
  void loadCoverageDisplay();
  renderSelectionQueue();
}

function syncCoverageProductControls(): void {
  const host = document.getElementById("coverage-layers");
  if (!host) return;
  host.querySelectorAll<HTMLInputElement>("input[data-product-layer-id]").forEach((input) => {
    input.checked = selectedCoverageProductIds.has(input.dataset.productLayerId ?? "");
  });
  host.querySelectorAll<HTMLInputElement>("input[data-release-id]").forEach((input) => {
    const layers = filterByModalities(coverageCatalog?.layers ?? [], selectedModalities)
      .filter((layer) => layer.surveyId === input.dataset.surveyId && layer.releaseId === input.dataset.releaseId);
    const selected = layers.filter((layer) => selectedCoverageProductIds.has(layer.layerId)).length;
    input.checked = layers.length > 0 && selected === layers.length;
    input.indeterminate = selected > 0 && selected < layers.length;
  });
  host.querySelectorAll<HTMLInputElement>("input[data-survey-id]:not([data-release-id])").forEach((input) => {
    const layers = filterByModalities(coverageCatalog?.layers ?? [], selectedModalities).filter((layer) => layer.surveyId === input.dataset.surveyId);
    const ids = layers.filter((layer) => selectedCoverageProductIds.has(layer.layerId));
    const total = layers.length;
    input.checked = total > 0 && ids.length === total;
    input.indeterminate = ids.length > 0 && ids.length < total;
  });
  renderHudRosterNow();
}

const SKY_AREA_DEG2 = 129600 / Math.PI;
let hudMinimapKey = "";

function syncHud(state: SurveyLayerState): void {
  if (!isAtlasPage) return;
  setHudMode(overlapMode);
  const minimapKey = `${state.sourceNside}:${state.occupiedCellCount}:${[...state.visibleSurveyIds].sort().join(",")}:${document.documentElement.dataset.theme ?? ""}`;
  if (minimapKey !== hudMinimapKey && coverageDots) {
    hudMinimapKey = minimapKey;
    setHudMinimapCells(coverageDots.minimapCells());
  }
  updateHudView(state);
}

function shortReleaseLabel(surveyId: string, releaseId: string): string {
  const trimmed = releaseId.toLowerCase().startsWith(`${surveyId.toLowerCase()}-`) ? releaseId.slice(surveyId.length + 1) : releaseId;
  return trimmed.toUpperCase();
}

/** The atlas layer panel doubles as the HUD roster: every survey row carries
 * its release line, sky bar and share. Compact mode keeps the active surveys
 * plus the widest-covering inactive ones; full mode lists the whole catalogue. */
function renderHudRosterNow(): void {
  if (!isAtlasPage || !coverageCatalog) return;
  const host = byId("coverage-layers");
  const layers = filterByModalities(coverageCatalog.layers, selectedModalities);
  const bySurvey = new Map<string, CoverageCatalog["layers"]>();
  layers.forEach((layer) => bySurvey.set(layer.surveyId, [...(bySurvey.get(layer.surveyId) ?? []), layer]));
  const rows: Array<HudRosterRow & { area: number }> = [...bySurvey].map(([surveyId, surveyLayers]) => {
    const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
    const selected = surveyLayers.filter((layer) => selectedCoverageProductIds.has(layer.layerId));
    const shown = selected.length ? selected : surveyLayers;
    const releases = [...new Set(shown.map((layer) => shortReleaseLabel(surveyId, layer.releaseId)))];
    const modalities = [...new Set(shown.map((layer) => canonicalModality(layer.modality)).filter(Boolean))];
    const maxOrder = Math.max(...shown.map((layer) => Math.max(layer.maxOrder ?? 0, ...(layer.displayOrders ?? layer.availableOrders))));
    const area = Math.max(0, ...shown.map((layer) => layer.areaDeg2 || 0));
    const releaseText = releases.length > 2 ? `${releases[0]} +${releases.length - 1}` : releases.join(" / ");
    return {
      surveyId,
      name: (survey?.name ?? surveyId).toUpperCase(),
      sub: [releaseText, modalities.map((modality) => modality.toUpperCase().slice(0, 8)).join("/") || null, Number.isFinite(maxOrder) && maxOrder > 0 ? `O${maxOrder}` : null].filter(Boolean).join(" · "),
      color: surveyColorFor(surveyId, survey?.color, surveyLayers[0]?.color),
      skyFraction: area > 0 ? Math.min(1, area / SKY_AREA_DEG2) : null,
      on: selected.length > 0,
      area,
    };
  });
  const on = rows.filter((row) => row.on);
  const off = rows.filter((row) => !row.on).sort((left, right) => right.area - left.area);
  const compact = new Set([...on, ...off.slice(0, Math.max(on.length ? 1 : 4, 4 - on.length))].map((row) => row.surveyId));
  const byId_ = new Map(rows.map((row) => [row.surveyId, row]));
  let key = 0;
  host.querySelectorAll<HTMLElement>(".coverage-survey-group").forEach((group) => {
    const surveyId = group.dataset.surveyId ?? "";
    const row = byId_.get(surveyId);
    const label = group.querySelector<HTMLElement>(".coverage-layer-toggle");
    group.classList.toggle("is-compact-hidden", !compact.has(surveyId));
    group.classList.toggle("is-on", Boolean(row?.on));
    if (!label) return;
    label.querySelector(".hud-layer-facts")?.remove();
    delete label.dataset.hudKey;
    if (!row) return;
    label.style.setProperty("--c", row.color);
    label.append(buildLayerFacts(row));
    const visible = !group.hidden && (document.body.dataset.layersPanel === "open" || compact.has(surveyId));
    if (visible && key < 9) label.dataset.hudKey = String(++key);
  });
  const count = document.getElementById("hud-layers-count");
  if (count) {
    count.textContent = `${on.length} / ${rows.length}`;
    count.title = `${on.length} of ${rows.length} surveys shown`;
  }
}

const HUD_PREFERENCE_KEY = "asa-atlas-hud";

function applyHudPreferences(): void {
  if (!isAtlasPage) return;
  let preference: { hidden?: boolean; rosterCollapsed?: boolean } = {};
  try { preference = JSON.parse(localStorage.getItem(HUD_PREFERENCE_KEY) ?? "{}"); } catch { preference = {}; }
  setHudHidden(Boolean(preference.hidden), false);
  setRosterCollapsed(Boolean(preference.rosterCollapsed), false);
}

function storeHudPreferences(): void {
  try {
    localStorage.setItem(HUD_PREFERENCE_KEY, JSON.stringify({
      hidden: document.body.dataset.hud === "hidden",
      rosterCollapsed: document.body.dataset.hudRoster === "collapsed",
    }));
  } catch { /* storage may be unavailable */ }
}

function setHudHidden(hidden: boolean, store = true): void {
  if (hidden) {
    hideCoverageLayerTooltip();
    hideOverlapRegionTooltip();
  }
  if (hidden) document.body.dataset.hud = "hidden";
  else delete document.body.dataset.hud;
  const button = document.getElementById("hud-toggle");
  if (button) {
    const label = locale() === "zh" ? (hidden ? "显示 HUD 面板 (H)" : "隐藏 HUD 面板 (H)") : (hidden ? "Show HUD panels (H)" : "Hide HUD panels (H)");
    button.setAttribute("aria-pressed", String(hidden));
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  if (store) storeHudPreferences();
}

function setRosterCollapsed(collapsed: boolean, store = true): void {
  if (collapsed) hideCoverageLayerTooltip();
  if (collapsed) document.body.dataset.hudRoster = "collapsed";
  else delete document.body.dataset.hudRoster;
  document.getElementById("hud-layers-head")?.setAttribute("aria-expanded", String(!collapsed));
  if (store) storeHudPreferences();
}

function toggleRosterSurvey(surveyId: string): void {
  const input = document.querySelector<HTMLInputElement>(`#coverage-survey-${CSS.escape(surveyId)} input[data-survey-id]:not([data-release-id])`);
  if (!input || input.disabled) return;
  input.checked = !input.checked;
  input.indeterminate = false;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setCoverageProductSelection(layerId: string, enabled: boolean): void {
  const layer = coverageCatalog?.layers.find((candidate) => candidate.layerId === layerId);
  if (!layer) return;
  if (enabled) selectedCoverageProductIds.add(layerId);
  else selectedCoverageProductIds.delete(layerId);
  commitCoverageProductSelection();
}

function commitCoverageProductSelection(): void {
  regionPanel?.refreshLayers();
  cancelCoverageDisplayRequest();
  const selectedSurveys = new Set([...selectedCoverageProductIds].flatMap((id) => {
    const selected = coverageCatalog?.layers.find((candidate) => candidate.layerId === id);
    return selected ? [selected.surveyId] : [];
  }));
  coverageSelectionInitialized = true;
  queuedLayerIds.clear();
  selectedSurveys.forEach((id) => queuedLayerIds.add(id));
  clampDisplayOrderToSelection();
  coverageDots?.setVisibleSurveys(selectedSurveys);
  coverageDots?.setVisibleLayers(selectedCoverageProductIds);
  syncCoverageProductControls();
  if (overlapMode || overlapIntent || overlapViewController) void activateOverlap(true);
  else void loadCoverageDisplay();
  renderSelectionQueue();
  const tooltipRow = coverageLayerTooltipRow;
  const tooltipSurveyId = coverageLayerTooltip?.dataset.surveyId;
  if (tooltipRow && tooltipSurveyId) showCoverageLayerTooltip(tooltipSurveyId, tooltipRow, true);
}

function selectedLayerOrders(): number[] {
  const layers = visibleCoverageLayers();
  if (!layers.length) return [];
  const orderSets = layers.map((layer) => new Set(layer.displayOrders ?? layer.availableOrders));
  return [...orderSets[0]!]
    .filter((order) => Number.isInteger(order) && order >= 4 && order <= 13 && orderSets.every((orders) => orders.has(order)))
    .sort((left, right) => left - right);
}

function clampDisplayOrderToSelection(): void {
  cancelDisplayOrderInteraction();
  const options = selectedLayerOrders();
  const layers = visibleCoverageLayers();
  if (!layers.length) {
    if (isAtlasPage && selectedDisplayOrder !== 4) {
      selectedDisplayOrder = 4;
    }
    renderDisplayOrderControl();
    return;
  }
  if (!options.length) {
    renderDisplayOrderControl();
    const state = document.getElementById("coverage-state");
    if (state) state.textContent = t("coverage.noCommonOrder");
    return;
  }
  const next = options.includes(selectedDisplayOrder)
    ? selectedDisplayOrder
    : [...options].reverse().find((order) => order <= selectedDisplayOrder) ?? options[0]!;
  if (next !== selectedDisplayOrder) {
    selectedDisplayOrder = next;
  }
  renderDisplayOrderControl();
}

function renderDisplayOrderControl(): void {
  const slider = document.getElementById("coverage-display-order") as HTMLInputElement | null;
  if (!slider) return;
  const orders = selectedLayerOrders();
  const layers = visibleCoverageLayers();
  const currentIndex = orders.indexOf(pendingDisplayOrder ?? selectedDisplayOrder);
  slider.min = "0";
  slider.max = String(Math.max(0, orders.length - 1));
  slider.value = String(Math.max(0, currentIndex));
  slider.disabled = orders.length === 0;
  const labelKey = overlapMode ? "coverage.overlapDisplayOrder" : "coverage.displayOrder";
  const label = document.querySelector<HTMLLabelElement>('label[for="coverage-display-order"]');
  if (label) {
    label.dataset.i18n = labelKey;
    label.textContent = t(labelKey);
  }
  slider.setAttribute("data-i18n-aria-label", labelKey);
  slider.setAttribute("aria-label", t(labelKey));
  slider.setAttribute("aria-valuetext", orders.length ? `O${orders[currentIndex >= 0 ? currentIndex : 0]}` : layers.length ? "--" : "O4");
  const value = document.getElementById("coverage-display-order-value");
  if (value) value.textContent = orders.length ? `O${orders[currentIndex >= 0 ? currentIndex : 0]}` : layers.length ? "--" : "O4";
  const minimum = document.getElementById("coverage-display-order-min");
  if (minimum) minimum.textContent = orders.length ? `O${orders[0]}` : "O4";
  const maximum = document.getElementById("coverage-display-order-max");
  if (maximum) maximum.textContent = orders.length ? `O${orders[orders.length - 1]}` : layers.length ? "--" : "O4";
  renderDisplayOrderSegments(orders, orders[currentIndex >= 0 ? currentIndex : 0] ?? null);
}

/** Skewed segment gauge drawn under the native range input; one segment per selectable order. */
function renderDisplayOrderSegments(orders: readonly number[], current: number | null): void {
  const host = document.getElementById("coverage-display-order-segments");
  const control = host?.closest<HTMLElement>(".coverage-display-order-control");
  if (!host || !control) return;
  const layers = visibleCoverageLayers();
  const partial = [...new Set(layers.flatMap((layer) => layer.displayOrders ?? layer.availableOrders))]
    .filter((order) => Number.isInteger(order) && order >= 4 && order <= 13 && !orders.includes(order) && order > (orders[orders.length - 1] ?? 3))
    .sort((left, right) => left - right);
  const shown = orders.length ? orders : [4];
  control.style.setProperty("--order-count", String(shown.length));
  host.replaceChildren(
    ...shown.map((order) => {
      const segment = document.createElement("span");
      segment.className = `coverage-order-seg${current !== null && order < current ? " is-filled" : ""}${order === current ? " is-current" : ""}`;
      segment.append(Object.assign(document.createElement("span"), { textContent: `O${order}` }));
      return segment;
    }),
    ...partial.map((order) => {
      const segment = document.createElement("span");
      segment.className = "coverage-order-seg is-unavailable";
      segment.title = locale() === "zh" ? `O${order} 仅部分已选图层可用` : `O${order} is available for only some selected layers`;
      segment.append(Object.assign(document.createElement("span"), { textContent: `O${order}` }));
      return segment;
    }),
  );
}

function previewDisplayOrderControlValue(): void {
  const slider = document.getElementById("coverage-display-order") as HTMLInputElement | null;
  const value = document.getElementById("coverage-display-order-value");
  if (!slider || !value) return;
  const order = selectedLayerOrders()[Number(slider.value)];
  if (order === undefined || !Number.isInteger(order)) return;
  pendingDisplayOrder = order;
  if (displayOrderTimer !== null) window.clearTimeout(displayOrderTimer);
  displayOrderTimer = null;
  cancelCoverageDisplayRequest();
  overlapViewController?.abort();
  overlapViewController = null;
  overlapViewSequence += 1;
  overlapController?.abort();
  overlapController = null;
  overlapRequestSequence += 1;
  value.textContent = `O${order}`;
  slider.setAttribute("aria-valuetext", `O${order}`);
  renderDisplayOrderSegments(selectedLayerOrders(), order);
}

function cancelCoverageDisplayRequest(): void {
  if (coverageDisplayTimer !== null) window.clearTimeout(coverageDisplayTimer);
  coverageDisplayTimer = null;
  coverageDisplayController?.abort();
  coverageDisplayController = null;
  coverageDisplaySequence += 1;
  coverageDisplayPlanningController?.abort();
  coverageDisplayPlanningController = null;
  coverageDisplayPlanSequence += 1;
  coverageDisplayPendingViewKey = "";
}

function cancelDisplayOrderInteraction(): void {
  if (displayOrderTimer !== null) window.clearTimeout(displayOrderTimer);
  displayOrderTimer = null;
  pendingDisplayOrder = null;
  displayOrderDragging = false;
}

function scheduleDisplayOrderChange(): void {
  if (displayOrderTimer !== null) window.clearTimeout(displayOrderTimer);
  if (displayOrderDragging || pendingDisplayOrder === null) return;
  if (pendingDisplayOrder !== selectedDisplayOrder) setDisplayOrderLoading(pendingDisplayOrder);
  displayOrderTimer = window.setTimeout(() => {
    const order = pendingDisplayOrder;
    displayOrderTimer = null;
    pendingDisplayOrder = null;
    if (order !== null) setDisplayOrder(order);
  }, 250);
}

function setDisplayOrder(order: number): void {
  if (!selectedLayerOrders().includes(order)) { setDisplayOrderLoading(null); return; }
  selectedDisplayOrder = order;
  coverageDisplayViewKey = "";
  overlapEvidenceCache.clear();
  overlapDetailsCache.clear();
  renderDisplayOrderControl();
  const token = ++displayOrderLoadToken;
  setDisplayOrderLoading(order);
  const load = overlapMode || overlapIntent || overlapViewController ? activateOverlap(true) : loadCoverageDisplay(true);
  void load.finally(() => { if (token === displayOrderLoadToken && !coverageDisplayController && !coverageDisplayPlanningController) setDisplayOrderLoading(null); });
}

let displayOrderLoadToken = 0;

/** Visible feedback while a new display order is fetched: ring + label on the gauge, dimmed sky. */
function setDisplayOrderLoading(order: number | null): void {
  const control = document.querySelector<HTMLElement>(".coverage-display-order-control");
  const heading = control?.querySelector<HTMLElement>(".coverage-display-order-heading");
  const loading = order !== null;
  control?.classList.toggle("is-loading", loading);
  control?.setAttribute("aria-busy", String(loading));
  if (heading) heading.dataset.loadingText = loading ? (locale() === "zh" ? `正在加载 O${order} 覆盖…` : `LOADING O${order} COVERAGE…`) : "";
  document.getElementById("coverage-canvas")?.classList.toggle("is-order-loading", loading);
  const banner = document.getElementById("hud-order-banner");
  if (banner) {
    // Rapid slider moves keep the order the sky was actually showing when loading began.
    if (loading && !banner.classList.contains("is-active")) {
      const nside = coverageDots?.state?.nside;
      banner.dataset.from = String(nside ? Math.round(Math.log2(nside)) : selectedDisplayOrder);
    }
    if (loading) {
      banner.querySelector(".hud-order-label")!.textContent = locale() === "zh" ? "加载阶数" : "LOADING ORDER";
      banner.querySelector(".hud-order-from")!.textContent = `O${banner.dataset.from}`;
      banner.querySelector(".hud-order-to")!.textContent = `O${order}`;
    }
    banner.classList.toggle("is-active", loading);
  }
}

function displayCellBudget(order: number): number {
  if (order <= 4) return 200_000;
  if (order <= 8) return 65_536;
  return 32_768;
}

interface CoverageDisplayPlan {
  order: number;
  key: string;
  view: CoverageViewGeometry;
  includeFarSide: boolean;
  layers: Array<{
    layer: CoverageCatalog["layers"][number];
    ranges: Array<{ start: number; end: number }>;
    tiles: number[];
  }>;
}

async function planCoverageDisplay(
  order: number,
  layers: CoverageCatalog["layers"],
  state: CoverageViewGeometry,
  signal: AbortSignal,
  includeFarSide = !coverageFocusActive,
): Promise<CoverageDisplayPlan> {
  const indexes = new Map<string, DisplayTileIndex>();
  if (order > 4) {
    await mapWithConcurrency(layers, 6, async (layer) => {
      indexes.set(layer.layerId, await fetchDisplayTileIndex(layer, order, signal));
    });
  }
  signal.throwIfAborted();
  const selection = layers.map((layer) => {
    const ranges = indexes.get(layer.layerId)?.ranges
      ?? (layer.tileIdsByOrder?.[String(order)] ?? [0]).map((tile) => ({ start: tile, end: tile + 1 }));
    return { layer, ranges, tiles: coverageTilesInView(order, state, ranges, includeFarSide) };
  });
  const scopeKey = order >= 6
    ? `${includeFarSide}:${state.coverageViewDirection.map((value) => value.toFixed(5)).join(",")}:${state.coverageViewRadiusRad.toFixed(5)}`
    : "overview";
  return {
    order,
    key: `${order}:${selection.map(({ layer, tiles }) => `${layer.layerId}:${tiles.join(",")}`).sort().join(";")}:${scopeKey}`,
    view: { coverageViewDirection: [...state.coverageViewDirection], coverageViewRadiusRad: state.coverageViewRadiusRad },
    includeFarSide,
    layers: selection,
  };
}

async function fetchCoverageDisplayBatch(plan: CoverageDisplayPlan, signal: AbortSignal): Promise<{ blocks: Map<string, number[]>; renderedCells: number }> {
  const totalRequests = plan.layers.reduce((sum, entry) => sum + entry.tiles.length, 0);
  if (totalRequests > DISPLAY_TILE_BUDGET) {
    throw new Error(locale() === "zh"
      ? `所有选中图层在当前视野合计需要 ${totalRequests} 个高阶覆盖块，超过 ${DISPLAY_TILE_BUDGET} 块上限；请放大天球或减少选中图层`
      : `The selected layers need ${totalRequests} high-order coverage tiles in this view, exceeding the ${DISPLAY_TILE_BUDGET}-tile limit. Zoom in or deselect layers.`);
  }
  const blocks = new Map<string, number[]>();
  let renderedCells = 0;
  const requests = plan.layers.flatMap(({ layer, tiles }) => tiles.map((tile) => ({ layer, tile })));
  await mapWithConcurrency(requests, 6, async ({ layer, tile }) => {
    signal.throwIfAborted();
    const cells = coverageCellsInView(plan.order, plan.view, await fetchCoverageBlock(layer, plan.order, tile, signal), plan.includeFarSide);
    renderedCells += cells.length;
    const renderLimit = displayCellBudget(plan.order);
    if (renderedCells > renderLimit) throw new Error(`当前视野覆盖超过 ${renderLimit.toLocaleString("en-US")} 个 HEALPix 单元；请缩小视野或减少产品`);
    const key = `${layer.layerId}:${plan.order}`;
    blocks.set(key, [...(blocks.get(key) ?? []), ...cells]);
  });
  blocks.forEach((cells, key) => blocks.set(key, [...new Set(cells)].sort((a, b) => a - b)));
  return { blocks, renderedCells };
}

function overlapViewTiles(
  order: number,
  state: SurveyLayerState,
  surveyIds: readonly string[],
  plan: CoverageDisplayPlan,
): { order: number; tiles: number[] } | undefined {
  const tileOrder = overlapViewTileOrder(order);
  if (tileOrder === null) return undefined;
  const surveyRanges = surveyIds.map((surveyId) => ({
    products: plan.layers.filter(({ layer }) => layer.surveyId === surveyId).map(({ ranges }) => ranges),
  }));
  let tiles: number[];
  try {
    tiles = overlapCoverageTilesInView(order, state, surveyRanges, DISPLAY_TILE_BUDGET);
  } catch (error) {
    if (!(error instanceof CoverageViewTileBudgetError)) throw error;
    throw new Error(locale() === "zh"
      ? `当前视野有 ${error.tileCount} 个可能重合的高阶图块，超过 ${error.tileBudget} 块预算；请放大天球后重试`
      : `The current view has ${error.tileCount} possible overlap tiles, exceeding the ${error.tileBudget}-tile limit. Zoom in and try again.`);
  }
  return { order: tileOrder, tiles };
}

async function mapWithConcurrency<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await run(items[index]!);
    }
  });
  const results = await Promise.allSettled(workers);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function loadCoverageDisplay(force = false): Promise<void> {
  if (!coverageCatalog || !coverageDots || overlapMode || overlapIntent || overlapViewController || pendingDisplayOrder !== null || displayOrderDragging) return;
  const displayOrder = selectedDisplayOrder;
  const layers = visibleCoverageLayers().filter((layer) => (layer.displayOrders ?? layer.availableOrders).includes(displayOrder));
  if (visibleCoverageLayers().length && !selectedLayerOrders().length) {
    cancelCoverageDisplayRequest();
    coverageDots.updateBlocks(new Map(), displayOrder);
    byId("coverage-state").textContent = t("coverage.noCommonOrder");
    return;
  }
  const state = coverageDots.state;
  if (!layers.length || !state) {
    cancelCoverageDisplayRequest();
    coverageDisplayViewKey = `${selectedDisplayOrder}:empty:${[...selectedCoverageProductIds].sort().join(",")}`;
    coverageDots.setVisibleLayers(selectedCoverageProductIds);
    coverageDots.updateBlocks(new Map(), displayOrder);
    coverageDisplayStatus = null;
    return;
  }
  coverageDisplayPlanningController?.abort();
  const controller = new AbortController();
  coverageDisplayPlanningController = controller;
  const planSequence = ++coverageDisplayPlanSequence;
  let sequence: number | null = null;
  try {
    const plan = await planCoverageDisplay(displayOrder, layers, state, controller.signal);
    if (controller.signal.aborted || planSequence !== coverageDisplayPlanSequence) return;
    const viewKey = plan.key;
    if (viewKey === coverageDisplayPendingViewKey && coverageDisplayController) return;
    if (!force && viewKey === coverageDisplayViewKey) {
      coverageDisplayController?.abort();
      coverageDisplayController = null;
      coverageDisplayPendingViewKey = "";
      coverageDisplaySequence += 1;
      setCoverageDisplayStatus(`${t("coverage.publicCells")} · O${displayOrder} · ${coverageDots.state?.visibleCellCount ?? 0} CELLS`);
      return;
    }
    coverageDisplayController?.abort();
    coverageDisplayController = controller;
    coverageDisplayPlanningController = null;
    coverageDisplayPendingViewKey = viewKey;
    sequence = ++coverageDisplaySequence;
    setCoverageDisplayStatus(`${locale() === "zh" ? "加载显示阶数" : "Loading display order"} O${displayOrder} · ${retainedDisplayOrderText()}`);
    const { blocks, renderedCells } = await fetchCoverageDisplayBatch(plan, controller.signal);
    if (controller.signal.aborted || sequence !== coverageDisplaySequence) return;
    coverageDots.updateBlocks(blocks, displayOrder);
    coverageDisplayViewKey = viewKey;
    setCoverageDisplayStatus(`${t("coverage.publicCells")} · O${displayOrder} · ${renderedCells.toLocaleString("en-US")} CELLS`);
  } catch (error) {
    if (controller.signal.aborted || (sequence === null ? planSequence !== coverageDisplayPlanSequence : sequence !== coverageDisplaySequence)) return;
    if (sequence === null) {
      coverageDisplayController?.abort();
      coverageDisplayController = null;
      coverageDisplaySequence += 1;
      coverageDisplayPendingViewKey = "";
    }
    controller.abort();
    setCoverageDisplayStatus(`${error instanceof Error ? error.message : "COVERAGE DISPLAY FAILED"} · ${retainedDisplayOrderText()}`);
  } finally {
    if (coverageDisplayController === controller) {
      coverageDisplayController = null;
      coverageDisplayPendingViewKey = "";
    }
    if (coverageDisplayPlanningController === controller) coverageDisplayPlanningController = null;
    // A superseded request must not clear the ring while a newer one is still in flight.
    if (!coverageDisplayController && !coverageDisplayPlanningController && !displayOrderTimer) setDisplayOrderLoading(null);
  }
}

function commonOverviewOrder(surveyIds: string[] = visibleSurveyIdsFromControls()): number | null {
  return highestCommonCoverageOrder(visibleCoverageLayers(), surveyIds);
}

function surveyCellsAtOrder(surveyId: string, order: number): Set<number> {
  const cells = new Set<number>();
  for (const layer of visibleCoverageLayers().filter((candidate) => candidate.surveyId === surveyId && candidate.availableOrders.includes(order))) {
    const tiles = layer.tileIdsByOrder?.[String(order)] ?? [0];
    tiles.forEach((tile) => (coverageBlockCache.get(coverageBlockKey(layer, order, tile)) ?? []).forEach((pixel) => cells.add(pixel)));
  }
  return cells;
}

function overlapPixelsForSurveys(surveyIds: string[], order: number): number[] {
  const sets = surveyIds.map((surveyId) => surveyCellsAtOrder(surveyId, order));
  if (sets.length < 2 || sets.some((set) => !set.size)) return [];
  const [first, ...rest] = sets;
  return [...first!].filter((pixel) => rest.every((set) => set.has(pixel))).sort((a, b) => a - b);
}

function overlapBounds(pixels: number[], order: number): { areaDeg2: number; raMin: number; raMax: number; decMin: number; decMax: number } {
  const healpix = new Healpix(2 ** order);
  const values: Array<{ ra: number; dec: number }> = [];
  pixels.forEach((pixel) => {
    for (const point of healpix.getBoundaries(pixel)) {
      const radius = Math.hypot(point.x, point.y, point.z) || 1;
      values.push({ ra: ((Math.atan2(point.y, point.x) * 180 / Math.PI) + 360) % 360, dec: Math.asin(point.z / radius) * 180 / Math.PI });
    }
  });
  const areaDeg2 = pixels.length * (41252.96124941927 / (12 * (2 ** order) ** 2));
  return {
    areaDeg2,
    raMin: values.length ? Math.min(...values.map((value) => value.ra)) : 0,
    raMax: values.length ? Math.max(...values.map((value) => value.ra)) : 0,
    decMin: values.length ? Math.min(...values.map((value) => value.dec)) : 0,
    decMax: values.length ? Math.max(...values.map((value) => value.dec)) : 0,
  };
}

interface OverlapEvidenceLookup { endpoint: string; layerIds: string[]; order: number; precision: "exact" | "estimated" | "entrypoint-only" | "truncated"; deferred: boolean }
interface OverlapEvidenceResult {
  schemaVersion?: number;
  requested?: import("./overlap-download.js").DownloadComponent["requested"];
  available: boolean;
  nativeUnitIndexRevision?: string;
  precision: string;
  truncated: boolean;
  querySnapshot?: { id: string; expiresAt: string; queryExhausted: boolean; inventoryComplete: false; resultTruncated?: boolean; batch?: { completed: number; total: number; batchComplete: boolean; complete: boolean; queryComplete: boolean; remaining: number } };
  preview?: { limit: number; shown: number; omitted: number; hasMore: boolean };
  page?: { pageSize: number; shown: number; omitted: number; hasMore: boolean; nextCursor?: string };
  spatialPage?: { pageSize: number; shown: number; hasMore: boolean; nextCursor?: string };
  supportingPage?: { pageSize: number; shown: number; hasMore: boolean; nextCursor?: string };
  edges: Array<{
    edgeId?: string;
    layerId?: string;
    surveyId?: string;
    releaseId?: string;
    productId?: string;
    product?: string;
    modality?: string;
    sourceFileId?: string;
    fileName?: string;
    sourceUri?: string;
    downloadUrl?: string;
    raMin?: number;
    raMax?: number;
    decMin?: number;
    decMax?: number;
    sizeBytes?: number;
    order: number;
    ipix: number;
    coverageMethod?: string;
    coverageRole?: string;
    precision: string;
  }>;
  sourceFiles: Array<Record<string, unknown>>;
  sources?: Array<Record<string, unknown> & { layerId?: string }>;
  entrypoints?: Array<{ layerId: string; productId?: string; surveyId?: string; releaseId?: string; product?: string; order: number; nside: number; cells: number[]; precision: string; sourceUrl?: string; mocUrl?: string; note?: string }>;
  downloadPlan?: DownloadPlan;
  notes?: string[];
}
interface OverlapSurveyView { surveyId: string; releaseId: string; product: string; modality?: string; sourceUnitIndex?: { status: string; unitKind?: string; notes: string }; sourceUnits?: { status: string; unitKind: string; units: Array<{ unitId: string; exposureCount: number; lastNight: number; downloadUrl: string }>; totalUnits: number; truncated: boolean; notes: string } | null; downloadUrl?: string }
interface OverlapComponentView { id: string; regionSelector?: { rectangle: SkyRectangle; boundaryOrder: number }; selectedRegion?: boolean; order: number; cells: number[]; bounds: { areaDeg2: number; raMin: number; raMax: number; raWraps?: boolean; decMin: number; decMax: number }; evidenceLookup?: OverlapEvidenceLookup; surveys?: OverlapSurveyView[] }
type OverlapSourceEvidence = Pick<DownloadPlanCoverageEvidence, "evidenceKind" | "sourceIdentity" | "instrument" | "filters" | "sourceSnapshotSha256" | "precision" | "completeness" | "scienceFileScan" | "summary">;
interface OverlapDetailsResponse {
  schemaVersion: 1;
  warehouseGeometry?: WarehouseGeometryLoadStatus;
  component: OverlapComponentView;
  publicSources: Array<{ layerId: string; surveyId: string; surveyName: string; surveyColor?: string; releaseId: string; releaseLabel?: string; product: string; modality?: string; description?: string; sourceUrl?: string; geometrySourceUrl?: string; coverageClaim?: { kind: string; url?: string; status?: string }; dataOrigin?: string; sourceTier?: string; sourceLabel?: string; geometrySourceLabel?: string; coverageEvidence?: OverlapSourceEvidence; sourceUnits?: { status?: string; unitKind?: string; units?: Array<{ unitId: string; exposureCount?: number; lastNight?: number; downloadUrl?: string }>; totalUnits?: number; truncated?: boolean; notes?: string } }>;
  assetsEvidence: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; artifacts: Array<{ id: string; kind: string; label: string; downloadUrl: string; previewUrl?: string; sha256: string; sizeBytes: number }> }>;
  warehouseEvidence: WarehouseOverlapEvidence[];
  method: { summary: string; docsUrl?: string };
  reverseLookup: OverlapEvidenceLookup;
}

function overlapComponents(pixels: number[], order: number): OverlapComponentView[] {
  const pending = new Set(pixels);
  const result: OverlapComponentView[] = [];
  const healpix = new Healpix(2 ** order);
  while (pending.size) {
    const start = pending.values().next().value as number;
    const queue = [start];
    const cells: number[] = [];
    pending.delete(start);
    while (queue.length) {
      const pixel = queue.pop()!;
      cells.push(pixel);
      const neighbours = healpix.neighbours(pixel);
      for (const index of [0, 2, 4, 6]) {
        const neighbour = neighbours[index] ?? -1;
        if (neighbour >= 0 && pending.delete(neighbour)) queue.push(neighbour);
      }
    }
    cells.sort((a, b) => a - b);
    result.push({ id: `C${String(result.length + 1).padStart(2, "0")}`, order, cells, bounds: overlapBounds(cells, order) });
  }
  return result;
}

function positionOverlapPanel(): void {
  const panel = byId("coverage-detail-panel");
  // The readout and inspectors flow together; wrapped titles cannot overlap.
  for (const property of ["left", "right", "top", "width"]) panel.style.removeProperty(property);
}

function layersForSurvey(surveyId: string): CoverageCatalog["layers"] {
  return visibleCoverageLayers().filter((layer) => layer.surveyId === surveyId);
}

function createCoverageLayerDetail(surveyId: string, persistent = false): HTMLElement {
  const layers = layersForSurvey(surveyId);
  const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
  const color = surveyColorFor(surveyId, survey?.color, layers[0]?.color);
  const panel = document.createElement("div");
  panel.className = persistent ? "selection-queue-entry coverage-layer-detail-persistent" : "coverage-layer-detail";
  const body = persistent ? document.createElement("div") : panel;
  if (persistent) body.className = "coverage-layer-detail-body";
  panel.dataset.surveyId = surveyId;
  panel.style.setProperty("--layer-color", color);
  panel.setAttribute("aria-label", `${survey?.name ?? surveyId} 图层详情`);
  const kicker = document.createElement("span");
  kicker.className = "coverage-layer-detail-kicker";
  kicker.textContent = "COVERAGE LAYER";
  const title = document.createElement("strong");
  title.textContent = survey?.name ?? surveyId.toUpperCase();
  const summary = document.createElement("small");
  const orders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((a, b) => a - b);
  const modalities = [...new Set(layers.flatMap((layer) => {
    const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
    const product = release?.products.find((entry) => entry.name === layer.product);
    return product?.modality ? [modalityLabel(product.modality)] : [];
  }))];
  const states = [...new Set(layers.map((layer) => coverageLayerLoadStates.get(layer.layerId) ?? "loading"))];
  summary.textContent = `${layers.length} products · ${orders.length ? `最高原生 O${Math.max(...layers.map(layer => layer.maxOrder))} · O${orders.join("/O")}` : "HEALPIX --"}${modalities.length ? ` · ${modalities.join(" · ")}` : ""}`;
  body.append(kicker, title, summary);
  const list = document.createElement("div");
  list.className = "coverage-layer-detail-list";
  layers.forEach((layer) => {
    const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
    const product = release?.products.find((entry) => entry.name === layer.product);
    const row = document.createElement("div");
    row.className = "coverage-layer-detail-row";
    const state = coverageLayerLoadStates.get(layer.layerId) ?? "loading";
    const version = document.createElement("span");
    version.className = "coverage-layer-detail-version";
    version.textContent = layer.releaseId || release?.label || "--";
    const name = document.createElement("span");
    name.className = "coverage-layer-detail-product";
    name.textContent = layer.product || product?.name || "Coverage";
    const orders = document.createElement("small");
    orders.className = "coverage-layer-detail-orders";
    orders.textContent = `${locale() === "zh" ? "最高原生" : "Native max"} O${layer.maxOrder} · ${layer.availableOrders.length ? `O${layer.availableOrders.join("/O")}` : "HEALPIX --"}`;
    row.append(version, name, orders);
    if (state === "error") {
      const error = coverageLayerLoadErrors.get(layer.layerId);
      row.title = error ?? "Coverage block unavailable";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "coverage-layer-retry";
      retry.title = "重试覆盖块加载";
      retry.append(icon("refresh-cw"), document.createTextNode("重试"));
      retry.addEventListener("click", () => retryCoverageSurvey(surveyId));
      row.append(retry);
    }
    list.append(row);
  });
  body.append(list);
  if (persistent) panel.append(body);
  return panel;
}

function cancelCoverageLayerTooltipClose(): void {
  if (coverageLayerTooltipCloseTimer !== null) window.clearTimeout(coverageLayerTooltipCloseTimer);
  coverageLayerTooltipCloseTimer = null;
}

function coverageLayerTooltipOccupied(): boolean {
  return [coverageLayerTooltipRow, coverageLayerTooltip].some((element) =>
    element && (element.matches(":hover") || element.contains(document.activeElement)));
}

function scheduleCoverageLayerTooltipClose(): void {
  cancelCoverageLayerTooltipClose();
  if (!coverageLayerTooltip || coverageLayerTooltipOccupied()) return;
  const tooltip = coverageLayerTooltip;
  coverageLayerTooltipCloseTimer = window.setTimeout(() => {
    coverageLayerTooltipCloseTimer = null;
    if (coverageLayerTooltip === tooltip && !coverageLayerTooltipOccupied()) hideCoverageLayerTooltip();
  }, 2000);
}

function hideCoverageLayerTooltip(): void {
  cancelCoverageLayerTooltipClose();
  coverageLayerTooltipRow?.removeAttribute("aria-describedby");
  coverageLayerTooltipRow = null;
  coverageLayerTooltip?.remove();
  coverageLayerTooltip = null;
  resumeLayerCloseTimer();
}

function positionCoverageLayerTooltip(): void {
  const tooltip = coverageLayerTooltip;
  const row = coverageLayerTooltipRow;
  if (!tooltip || !row) return;
  if (window.innerWidth <= 820 || !row.isConnected || row.closest("[hidden]") || !row.getClientRects().length) {
    hideCoverageLayerTooltip();
    return;
  }
  const host = byId("coverage-layers");
  const listRect = host.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.bottom <= listRect.top || rowRect.top >= listRect.bottom) {
    hideCoverageLayerTooltip();
    return;
  }
  const tooltipRect = tooltip.getBoundingClientRect();
  const position = coverageLayerTooltipPosition(window.innerWidth, window.innerHeight, rowRect, listRect, tooltipRect);
  if (!position) {
    hideCoverageLayerTooltip();
    return;
  }
  tooltip.style.left = `${position.left}px`;
  tooltip.style.top = `${position.top}px`;
}

function showCoverageLayerTooltip(surveyId: string, row: HTMLElement, refresh = false): void {
  if (window.innerWidth <= 820) return;
  cancelCoverageLayerTooltipClose();
  if (!refresh && coverageLayerTooltip && coverageLayerTooltipRow === row) {
    positionCoverageLayerTooltip();
    return;
  }
  hideCoverageLayerTooltip();
  const tooltip = createCoverageLayerDetail(surveyId);
  tooltip.classList.add("coverage-layer-tooltip");
  tooltip.id = "coverage-layer-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.addEventListener("pointerenter", cancelCoverageLayerTooltipClose);
  tooltip.addEventListener("pointerleave", scheduleCoverageLayerTooltipClose);
  tooltip.addEventListener("focusin", cancelCoverageLayerTooltipClose);
  tooltip.addEventListener("focusout", () => queueMicrotask(scheduleCoverageLayerTooltipClose));
  document.body.append(tooltip);
  coverageLayerTooltip = tooltip;
  coverageLayerTooltipRow = row;
  pauseLayerCloseTimer();
  row.setAttribute("aria-describedby", tooltip.id);
  positionCoverageLayerTooltip();
}

/** On the wide atlas the panel stays docked: "open" means the full catalogue. */
function layersPanelDocked(): boolean {
  return isAtlasPage && window.innerWidth > 820;
}

function setCoverageLayersOpen(open: boolean): void {
  const layers = byId("coverage-layers");
  const queue = byId("selection-queue");
  layers.hidden = !open && !layersPanelDocked();
  if (open) document.body.dataset.layersPanel = "open";
  else document.body.removeAttribute("data-layers-panel");
  queue.inert = open;
  const toggle = document.getElementById("hud-layers-all");
  if (toggle) toggle.textContent = open ? "COMPACT ▴" : "ALL LAYERS ▸";
  renderHudRosterNow();
  updateOverlapPanelLayout();
  hideCoverageLayerTooltip();
  positionSelectionQueue();
  positionOverlapPanel();
}

function createSelectedComponentDetail(component: OverlapComponentView): HTMLElement {
  const panel = document.createElement("div");
  panel.className = `selection-queue-entry selection-queue-component${renderedQueueComponentId === component.id ? "" : " is-entering"}`;
  panel.dataset.queueKey = "component";
  panel.style.setProperty("--layer-color", "var(--ochre)");
  const kicker = document.createElement("span");
  kicker.className = "coverage-layer-detail-kicker";
  kicker.textContent = t("coverage.selectedComponent");
  const title = document.createElement("strong");
  title.textContent = component.id;
  const summary = document.createElement("small");
  summary.textContent = `O${component.order} · NSIDE ${2 ** component.order} · ${component.cells.length.toLocaleString("en-US")} cells · ${component.bounds.areaDeg2.toFixed(2)} deg²`;
  const bounds = document.createElement("small");
  bounds.textContent = `RA ${component.bounds.raMin.toFixed(2)}°–${component.bounds.raMax.toFixed(2)}° · DEC ${component.bounds.decMin.toFixed(2)}°–${component.bounds.decMax.toFixed(2)}°`;
  panel.append(kicker, title, summary, bounds);
  return panel;
}

function positionSelectionQueue(): void {
  const queue = byId("selection-queue");
  if (window.innerWidth <= 820) {
    queue.style.removeProperty("top");
    queue.style.removeProperty("left");
    queue.style.removeProperty("width");
    queue.style.removeProperty("--selection-queue-top");
    return;
  }
  const layers = byId("coverage-layers");
  const top = layers.hidden ? 132 : Math.min(window.innerHeight - 180, layers.getBoundingClientRect().bottom + 16);
  const boundedTop = Math.max(132, top);
  queue.style.top = `${boundedTop}px`;
  queue.style.setProperty("--selection-queue-top", `${boundedTop}px`);
  queue.style.left = "28px";
  queue.style.width = "min(330px, calc(100vw - 56px))";
}


function renderSelectionQueue(): void {
  const queue = byId("selection-queue");
  const entries: HTMLElement[] = [];
  queuedLayerIds.forEach((surveyId) => {
    if (layersForSurvey(surveyId).length) entries.push(createCoverageLayerDetail(surveyId, true));
  });
  if (selectedQueueComponent && overlapMode) entries.push(createSelectedComponentDetail(selectedQueueComponent));
  queue.replaceChildren(...entries);
  renderedQueueComponentId = selectedQueueComponent?.id ?? null;
  queue.hidden = entries.length === 0 || !isAtlasInteractive();
  positionSelectionQueue();
}

function clearLayerCloseTimer(): void {
  if (layerCloseTimer !== null) window.clearTimeout(layerCloseTimer);
  layerCloseTimer = null;
  layerCloseDeadline = 0;
  layerCloseRemaining = 0;
  layerClosePaused = false;
}

function scheduleLayerCloseTimer(): void {
  const host = document.getElementById("coverage-layers");
  if (coverageLayerTooltip || host?.matches(":hover") || host?.contains(document.activeElement)) layerClosePaused = true;
  if (layerClosePaused || layerCloseRemaining <= 0) return;
  layerCloseDeadline = Date.now() + layerCloseRemaining;
  layerCloseTimer = window.setTimeout(() => {
    layerCloseTimer = null;
    layerCloseRemaining = 0;
    setCoverageLayersOpen(false);
  }, layerCloseRemaining);
}

function restartLayerCloseTimer(): void {
  if (layerCloseTimer !== null) window.clearTimeout(layerCloseTimer);
  layerCloseTimer = null;
  layerCloseRemaining = 10_000;
  scheduleLayerCloseTimer();
}

function pauseLayerCloseTimer(): void {
  if (layerCloseTimer === null || layerClosePaused) return;
  layerClosePaused = true;
  window.clearTimeout(layerCloseTimer);
  layerCloseTimer = null;
  layerCloseRemaining = Math.max(0, layerCloseDeadline - Date.now());
}

function resumeLayerCloseTimer(): void {
  const host = document.getElementById("coverage-layers");
  if (coverageLayerTooltip || host?.matches(":hover") || host?.contains(document.activeElement)) return;
  if (!layerClosePaused) return;
  layerClosePaused = false;
  scheduleLayerCloseTimer();
}

function bindLayerCloseTimer(host: HTMLElement): void {
  if (host.dataset.timerBound === "true") return;
  host.dataset.timerBound = "true";
  host.addEventListener("pointerenter", pauseLayerCloseTimer);
  host.addEventListener("pointerleave", resumeLayerCloseTimer);
  host.addEventListener("focusin", pauseLayerCloseTimer);
  host.addEventListener("focusout", () => queueMicrotask(resumeLayerCloseTimer));
}

function renderOverlapLoadingPanel(surveyIds: string[], order: number): void {
  closeSkyDepth(); skyDepthInspection = null;
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  abortHstLookupsWithin(content);
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = t("coverage.overlapResult");
  byId("coverage-detail-title").textContent = `GLOBAL · ${surveyIds.length} SURVEYS`;
  setLockHeadline("OVERLAP", `O${order}`, "QUERYING");
  const summary = document.createElement("p");
  summary.className = "overlap-summary";
  summary.textContent = `${t("coverage.commonOrder")} O${order}`;
  const loading = document.createElement("div");
  loading.className = "overlap-loading";
  const spinner = document.createElement("span");
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.textContent = t("coverage.queryingPlan");
  loading.append(spinner, label);
  content.replaceChildren(summary, loading);
  setOverlapExpandVisible(false);
  positionOverlapPanel();
}

function renderOverlapErrorPanel(surveyIds: string[], messageText = t("coverage.overlapFailed")): void {
  closeSkyDepth(); skyDepthInspection = null;
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  abortHstLookupsWithin(content);
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = t("coverage.overlapResult");
  byId("coverage-detail-title").textContent = `GLOBAL · ${surveyIds.length} SURVEYS`;
  setLockHeadline("OVERLAP", null);
  const message = document.createElement("p");
  message.className = "overlap-error";
  message.textContent = messageText;
  content.replaceChildren(message);
  setOverlapExpandVisible(false);
  positionOverlapPanel();
}

function componentPageControls(total: number, page: number, onPageChange: (page: number) => void, variant: "panel" | "drawer"): HTMLElement | null {
  const pageCount = Math.ceil(total / OVERLAP_COMPONENT_PAGE_SIZE);
  if (pageCount < 2) return null;
  const start = page * OVERLAP_COMPONENT_PAGE_SIZE + 1;
  const end = Math.min(total, start + OVERLAP_COMPONENT_PAGE_SIZE - 1);
  const navigation = document.createElement("nav");
  navigation.className = `overlap-component-pagination overlap-component-pagination-${variant}`;
  navigation.setAttribute("aria-label", t("coverage.componentPages"));
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "icon-button overlap-component-page-button";
  previous.title = t("coverage.previousPage");
  previous.setAttribute("aria-label", t("coverage.previousPage"));
  previous.disabled = page === 0;
  previous.append(icon("chevron-left"));
  previous.addEventListener("click", () => onPageChange(page - 1));
  const label = document.createElement("span");
  label.textContent = t("coverage.componentPageLabel")
    .replace("{start}", String(start))
    .replace("{end}", String(end))
    .replace("{total}", String(total));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "icon-button overlap-component-page-button";
  next.title = t("coverage.nextPage");
  next.setAttribute("aria-label", t("coverage.nextPage"));
  next.disabled = page >= pageCount - 1;
  next.append(icon("chevron-right"));
  next.addEventListener("click", () => onPageChange(page + 1));
  navigation.append(previous, label, next);
  return navigation;
}

function overlapComponentTargetKey(component: OverlapComponentView, surveyIds: string[]): string {
  return JSON.stringify([surveyIds.slice().sort(), component.id, component.order, component.cells]);
}

function cancelRegionQuery(): void {
  regionExportController?.abort();
  regionExportController = null;
  if (regionEvidenceNode) {
    const loading = overlapEvidenceLoads.get(regionEvidenceNode);
    if (loading) {
      loading.abort();
      if (overlapEvidenceController === loading) { overlapEvidenceController = null; overlapEvidenceSequence++; }
    }
  }
}

function queryRectangle(rectangle: SkyRectangle, boundaryOrder: number): void {
  const layers = visibleCoverageLayers();
  if (!layers.length) { regionPanel?.status(t("region.noLayers")); return; }
  renderRegionQuery({ id: "RECTANGLE", selectedRegion: true, regionSelector: { rectangle, boundaryOrder }, order: 4, cells: [],
    bounds: { areaDeg2: 0, raMin: rectangle.raStart, raMax: rectangle.raEnd, raWraps: rectangle.raEnd < rectangle.raStart, decMin: rectangle.decMin, decMax: rectangle.decMax },
    evidenceLookup: { endpoint: "/api/v1/coverage/reverse-lookup", layerIds: layers.map(layer => layer.layerId), order: 4, precision: "estimated", deferred: false } });
}

function renderRegionQueryMetadata(component: OverlapComponentView, result: OverlapEvidenceResult): void {
  const host = byId("coverage-region-query-meta");
  for (const button of document.querySelectorAll<HTMLButtonElement>("#coverage-region-results button[data-export-format]")) {
    button.textContent = `${t(hasDownloadAccess() ? "region.fullReady" : "region.preview")} ${button.dataset.exportFormat?.toUpperCase()}`;
  }
  const region = result.requested?.region;
  const cover = region?.cover;
  const zh = locale() === "zh";
  const layers = (component.evidenceLookup?.layerIds ?? []).map(id => publicLayerEntry(id));
  const scope = layers.map(layer => `${layer.surveyId} / ${layer.releaseId} / ${layer.product}`).join("\n");
  const scopeHost = byId("coverage-region-frozen-scope");
  scopeHost.querySelector("summary")!.textContent = `${zh ? "已冻结查询产品" : "Frozen query products"} · ${layers.length}`;
  scopeHost.querySelector("div")!.textContent = scope;
  if (!region) {
    host.textContent = `O${component.order} · ${component.cells.length} ${zh ? "所选像元" : "selected cells"}`;
    return;
  }
  const orders = [...new Set(region.cells.map(cell => cell.order))].sort((a, b) => a - b);
  const rectangle = result.requested?.rectangle ?? region.rectangle;
  const pieces = [rectangle ? `RA ${rectangle.raStart}° → ${rectangle.raEnd}° · Dec ${rectangle.decMin}° → ${rectangle.decMax}°` : "",
    `${region.cells.length} ${zh ? "多阶单元" : "multi-order cells"} · ${orders.map(order => `O${order}`).join(" / ")}`].filter(Boolean);
  if (cover) {
    pieces.push(`${zh ? "覆盖面积" : "Cover area"} ${Number(cover.coverAreaDeg2).toFixed(4)} deg² · ${zh ? "面积超额" : "Excess area"} ${Number(cover.excessAreaDeg2).toFixed(4)} deg²`);
    pieces.push(`${zh ? "边界未决单元" : "Unresolved boundary cells"} ${cover.unresolvedBoundaryLeaves} · ${zh ? "最大外包角半径" : "Max enclosing radius"} ${Number(cover.maxUnresolvedAngularRadiusDeg).toFixed(4)}°`);
    if (cover.budgetLimited) pieces.push(zh ? "达到单元预算：部分边界保留较粗单元；没有裁掉输入区域。" : "Cell budget reached: some boundary cells remain coarse; the input region was not cut away.");
  }
  pieces.push(result.preview ? `${zh ? "匿名预览" : "Anonymous preview"} · ${result.preview.limit}`
    : `${zh ? "已加载原生单元" : "Native units loaded"} ${result.downloadPlan?.spatialUnits?.length ?? 0}`);
  host.textContent = pieces.join("\n");
  regionPanel?.status(result.page?.hasMore || result.preview?.hasMore ? (zh ? "仍有更多结果；预览不等于完整清单。" : "More results remain; the preview is not a full manifest.")
    : (zh ? "本次已返回的结果如上；查询耗尽不代表来源库存完整。" : "Returned results are shown; query exhaustion is not complete source inventory."));
}

function renderRegionQuery(component: OverlapComponentView): void {
  cancelRegionQuery();
  activeRegionQuery = component;
  const host = byId("coverage-region-results");
  const meta = Object.assign(document.createElement("p"), { id: "coverage-region-query-meta", className: "coverage-region-caveat", textContent: t("region.querying") });
  const evidence = Object.assign(document.createElement("div"), { className: "overlap-evidence-plan" });
  regionEvidenceNode = evidence;
  const actions = Object.assign(document.createElement("div"), { className: "coverage-region-actions" });
  const unlock = Object.assign(document.createElement("button"), { type: "button", className: "hud-btn is-hot", textContent: hasDownloadAccess() ? t("region.fullReady") : t("region.full") });
  unlock.addEventListener("click", async () => {
    unlock.disabled = true;
    try {
      if (await ensureDownloadAccess() && activeRegionQuery === component) {
        unlock.textContent = t("region.fullReady");
        // A cached preview must not stand in for the authorized page.
        await loadOverlapEvidence(component, evidence);
      }
    } finally { unlock.disabled = false; }
  });
  actions.append(unlock);
  for (const format of ["json", "csv"] as const) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "hud-btn", textContent: `${t(hasDownloadAccess() ? "region.fullReady" : "region.preview")} ${format.toUpperCase()}` });
    button.dataset.exportFormat = format;
    button.addEventListener("click", () => void exportRegionManifest(component, format, button));
    actions.append(button);
  }
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "hud-btn", textContent: t("region.cancelExport") });
  cancel.addEventListener("click", () => { cancelRegionQuery(); regionPanel?.status(t("region.cancelled")); });
  actions.append(cancel);
  const scope = Object.assign(document.createElement("details"), { id: "coverage-region-frozen-scope", className: "coverage-region-selection" });
  scope.append(document.createElement("summary"), Object.assign(document.createElement("div"), { className: "coverage-region-frozen-products" }));
  host.replaceChildren(meta, scope, actions, evidence);
  regionPanel?.status(t("region.querying"));
  void loadOverlapEvidence(component, evidence);
}

async function exportRegionManifest(component: OverlapComponentView, format: "json" | "csv", button: HTMLButtonElement): Promise<void> {
  if (regionExportController || activeRegionQuery !== component) return;
  const controller = new AbortController();
  regionExportController = controller;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t("coverage.downloadLoading");
  try {
    const result = await evidenceForExport(component, controller.signal);
    if (!result || controller.signal.aborted || activeRegionQuery !== component) return;
    const plan = downloadPlanFor(result);
    const selection = { ...component, requested: result.requested, sourceStatuses: result.sources };
    const text = format === "json" ? JSON.stringify({ schemaVersion: result.schemaVersion ?? 1, coordinateFrame: "ICRS", ordering: "NESTED", generatedAt: new Date().toISOString(),
      requested: result.requested ?? { layerIds: component.evidenceLookup?.layerIds, order: component.order, cells: component.cells },
      sources: result.sources, querySnapshot: result.querySnapshot, nativeUnitIndexRevision: result.nativeUnitIndexRevision, preview: result.preview, page: result.page,
      notes: result.notes, downloadPlan: plan }, null, 2)
      : `﻿${overlapCsvDocument(overlapCsvRows(selection, plan, publicLayerEntry, result.precision, {
        snapshotId: result.querySnapshot?.id, nativeUnitIndexRevision: result.nativeUnitIndexRevision,
        omitted: result.page?.omitted ?? result.preview?.omitted ?? 0, hasMore: result.page?.hasMore ?? result.preview?.hasMore ?? false,
      }))}`;
    const url = URL.createObjectURL(new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `atlas-region-${result.preview ? "preview" : "manifest"}.${format}`; link.click(); URL.revokeObjectURL(url);
    regionPanel?.status(t("coverage.downloadReady"));
  } catch (error) {
    if (!controller.signal.aborted) regionPanel?.status(`${t("coverage.downloadUnavailable")}: ${error instanceof Error ? error.message : ""}`);
  } finally {
    button.disabled = false; button.textContent = label;
    if (regionExportController === controller) regionExportController = null;
  }
}

const overlapEvidenceLoads = new WeakMap<HTMLElement, AbortController>();

function resumeOverlapPanelEvidence(component: OverlapComponentView, content: HTMLElement): void {
  const node = content.querySelector<HTMLElement>(".overlap-evidence-plan");
  if (!node || !component.evidenceLookup || node.dataset.lookupState === "complete") return;
  const pending = overlapEvidenceLoads.get(node);
  if (pending && !pending.signal.aborted) return;
  void loadOverlapEvidence(component, node);
}

function renderOverlapPanel(surveyIds: string[], pixels: number[], order: number, scope = "GLOBAL", componentData?: OverlapComponentView[], focus = true): void {
  const content = byId("coverage-detail-content");
  const rail = content.closest<HTMLElement>(".coverage-inspector-rail");
  const components = componentData?.length ? componentData : overlapComponents(pixels, order);
  const initialComponent = components.find((component) => component.id === selectedQueueComponent?.id) ?? components[0];
  const targetKey = initialComponent ? overlapComponentTargetKey(initialComponent, surveyIds) : "";
  const savedScroll = targetKey && content.dataset.overlapTargetKey === targetKey ? rail?.scrollTop ?? 0 : 0;
  // Build off-DOM: clearing the live content first temporarily shortens the rail.
  // Viewer/HUD layout reads can clamp its scroll offset before the list returns.
  const nextContent = document.createElement("div");
  closeSkyDepth(); skyDepthInspection = null;
  const panel = byId("coverage-detail-panel");
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
  setOverlapExpandVisible(Boolean(componentData?.length ?? activeOverlapComponents.length));
  byId("coverage-detail-kicker").textContent = t("coverage.overlapResult");
  byId("coverage-detail-title").textContent = `${scope} · ${surveyIds.length} SURVEYS`;
  setLockHeadline(scope === "SELECTED CELL" ? "EXPORT" : "OVERLAP", `O${order}`, `${pixels.length.toLocaleString("en-US")} CELLS · ${surveyIds.map((id) => (surveyIndex?.surveys.find((survey) => survey.id === id)?.name ?? id).toUpperCase()).join(" × ")}`);
  const summary = document.createElement("p");
  summary.className = "overlap-summary";
  summary.textContent = pixels.length ? `${t("coverage.commonOrder")} O${order} · NSIDE ${2 ** order} · ${pixels.length.toLocaleString("en-US")} cells` : `${t("coverage.commonOrder")} O${order} · ${t("coverage.noCommon")}`;
  nextContent.append(summary);
  if (!pixels.length || !initialComponent) {
    abortHstLookupsWithin(content);
    delete content.dataset.overlapTargetKey;
    delete content.dataset.overlapRenderKey;
    delete content.dataset.overlapDetailKey;
    content.replaceChildren(...nextContent.childNodes);
    if (rail) rail.scrollTop = 0;
    positionOverlapPanel();
    return;
  }
  const componentNav = document.createElement("div");
  componentNav.className = "overlap-components";
  const heading = document.createElement("strong");
  heading.textContent = `${components.length} CONNECTED COMPONENT${components.length === 1 ? "" : "S"}`;
  componentNav.append(heading);
  const pageCount = Math.max(1, Math.ceil(components.length / OVERLAP_COMPONENT_PAGE_SIZE));
  overlapComponentsPage = Math.min(overlapComponentsPage, pageCount - 1);
  const pageControls = componentPageControls(components.length, overlapComponentsPage, (page) => {
    overlapComponentsPage = page;
    const first = components[page * OVERLAP_COMPONENT_PAGE_SIZE];
    if (first) selectedQueueComponent = first;
    renderOverlapPanel(surveyIds, pixels, order, scope, components);
  }, "panel");
  if (pageControls) componentNav.append(pageControls);
  const visibleComponents = components.slice(overlapComponentsPage * OVERLAP_COMPONENT_PAGE_SIZE, (overlapComponentsPage + 1) * OVERLAP_COMPONENT_PAGE_SIZE);
  visibleComponents.forEach((component) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = selectedQueueComponent?.id === component.id ? "is-active" : "";
    button.setAttribute("aria-pressed", String(selectedQueueComponent?.id === component.id));
    button.textContent = component.id;
    button.addEventListener("click", () => {
      selectOverlapComponent(component, surveyIds, content);
    });
    componentNav.append(button);
  });
  nextContent.append(componentNav);
  const renderKey = JSON.stringify([scope, surveyIds, order, pixels, components, initialComponent.id, overlapComponentsPage,
    locale(), hasDownloadAccess(), visibleCoverageLayers().map((layer) => [layer.layerId, layer.revision])]);
  const unchanged = content.dataset.overlapRenderKey === renderKey && Boolean(content.querySelector(".overlap-component-detail"));
  if (unchanged) {
    // Coverage updates clear the viewer highlight even when the inspector did not
    // change. Resync the viewer/HUD, but keep DOM, focus, expanded lists and pages.
    selectOverlapComponent(initialComponent, surveyIds, content, focus, false);
  } else {
    abortHstLookupsWithin(content);
    selectOverlapComponent(initialComponent, surveyIds, nextContent, focus);
    content.replaceChildren(...nextContent.childNodes);
    content.dataset.overlapTargetKey = targetKey;
    content.dataset.overlapRenderKey = renderKey;
    content.dataset.overlapDetailKey = nextContent.dataset.overlapDetailKey;
  }
  renderIcons();
  positionOverlapPanel();
  // Restore the actual scroller synchronously, before paint; no stale rAF may
  // overwrite a later user scroll or target selection.
  if (rail) rail.scrollTop = savedScroll;
}

function selectOverlapComponent(component: OverlapComponentView, surveyIds = activeOverlapSurveyIds, content = byId("coverage-detail-content"), focus = true, renderDetail = true): void {
  const targetKey = overlapComponentTargetKey(component, surveyIds);
  const sameTarget = content.dataset.overlapTargetKey === targetKey;
  const detailKey = JSON.stringify([component, surveyIds, locale(), hasDownloadAccess(),
    visibleCoverageLayers().map((layer) => [layer.layerId, layer.revision])]);
  const detailUnchanged = sameTarget && content.dataset.overlapDetailKey === detailKey && Boolean(content.querySelector(".overlap-component-detail"));
  const rail = content.closest<HTMLElement>(".coverage-inspector-rail");
  const savedScroll = sameTarget ? rail?.scrollTop ?? 0 : 0;
  closeSkyDepth(); skyDepthInspection = null;
  const componentIndex = activeOverlapComponents.findIndex((entry) => entry.id === component.id);
  if (componentIndex >= 0) {
    overlapComponentsPage = Math.floor(componentIndex / OVERLAP_COMPONENT_PAGE_SIZE);
    overlapDrawerComponentsPage = overlapComponentsPage;
    if (overlapDrawerOpen) renderOverlapDrawerComponents();
  }
  content.querySelectorAll<HTMLButtonElement>(".overlap-components button").forEach((entry) => entry.classList.toggle("is-active", entry.textContent === component.id));
  coverageDots?.setActiveOverlapComponent(component.id);
  updateOverlapHud(component);
  updateOverlapViewport();
  if (focus) coverageDots?.focusPixels(component.order, component.cells);
  if (renderDetail && !detailUnchanged) {
    delete content.dataset.overlapRenderKey;
    renderOverlapComponent(component, surveyIds, content);
    content.dataset.overlapDetailKey = detailKey;
  } else {
    resumeOverlapPanelEvidence(component, content);
  }
  content.dataset.overlapTargetKey = targetKey;
  if (rail) rail.scrollTop = savedScroll;
}

function handleOverlapComponentLabel(component: SurveyLayerOverlapComponent): void {
  const selected = activeOverlapComponents.find((entry) => entry.id === component.id && entry.order === component.order);
  if (overlapDrawerOpen) {
    if (selected) selectOverlapDrawerComponent(selected);
    return;
  }
  selectOverlapComponent(selected ?? {
    id: component.id,
    order: component.order,
    cells: component.cells,
    bounds: overlapBounds(component.cells, component.order),
  });
}

function updateOverlapHud(component: OverlapComponentView | null): void {
  if (!component || !overlapMode) {
    selectedQueueComponent = null;
    renderedQueueComponentId = null;
    // The component no longer stands in as the target; a selected cell keeps its own.
    if (!coverageDots?.state?.selectedPixels.length) setHudTarget(null);
    renderSelectionQueue();
    return;
  }
  renderedQueueComponentId = selectedQueueComponent?.id ?? null;
  selectedQueueComponent = component;
  syncOverlapHudTarget(component);
  renderSelectionQueue();
  positionOverlapPanel();
}

function overlapRegionSources(component: OverlapComponentView): OverlapSurveyView[] {
  // Only responses scoped to this region may enrich product/modalities. Merge by
  // source identity: an early summary can omit a modality that details resolves.
  const sources = new Map<string, OverlapSurveyView>();
  for (const source of [...(component.surveys ?? []), ...(overlapDetailsCache.get(overlapDetailsCacheKey(component))?.publicSources ?? [])]) {
    const key = JSON.stringify([source.surveyId, source.releaseId, source.product]);
    const previous = sources.get(key);
    const modality = canonicalModality(source.modality);
    sources.set(key, { surveyId: source.surveyId, releaseId: source.releaseId, product: source.product,
      modality: modality && modality !== "coverage" ? source.modality : previous?.modality });
  }
  return [...sources.values()];
}

let overlapRegionTooltip: HTMLElement | null = null;

function hideOverlapRegionTooltip(): void {
  overlapRegionTooltip?.remove();
  overlapRegionTooltip = null;
  byId("coverage-canvas").removeAttribute("aria-describedby");
}

function showOverlapRegionTooltip(hover: { component: SurveyLayerOverlapComponent; clientX: number; clientY: number } | null): void {
  if (!hover || !overlapDrawerOpen || !overlapMode || document.body.dataset.hud === "hidden") {
    hideOverlapRegionTooltip();
    return;
  }
  const component = activeOverlapComponents.find((entry) => entry.id === hover.component.id && entry.order === hover.component.order);
  if (!component) { hideOverlapRegionTooltip(); return; }
  const entries = overlapRegionSources(component);
  const key = JSON.stringify([component.id, component.order, component.cells, component.bounds, entries, locale()]);
  if (!overlapRegionTooltip) {
    overlapRegionTooltip = document.createElement("div");
    overlapRegionTooltip.id = "overlap-region-tooltip";
    overlapRegionTooltip.className = "overlap-region-tooltip";
    overlapRegionTooltip.setAttribute("role", "tooltip");
    document.body.append(overlapRegionTooltip);
  }
  const tooltip = overlapRegionTooltip;
  if (tooltip.dataset.key !== key) {
    tooltip.dataset.key = key;
    tooltip.dataset.componentId = component.id;
    tooltip.dataset.order = String(component.order);
    const heading = Object.assign(document.createElement("strong"), { textContent: `${component.id} · O${component.order} · ${component.cells.length.toLocaleString("en-US")} cells` });
    const area = Object.assign(document.createElement("small"), { textContent: `${component.bounds.areaDeg2.toFixed(2)} deg² · ICRS / NESTED` });
    const rows = document.createElement("div");
    rows.className = "overlap-region-tooltip-sources";
    const surveyIds = [...new Set(entries.length ? entries.map((entry) => entry.surveyId) : activeOverlapSurveyIds)];
    surveyIds.forEach((surveyId) => {
      const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
      const row = document.createElement("div");
      row.className = "overlap-region-tooltip-source";
      const surveyName = (survey?.name ?? surveyId).toUpperCase();
      row.append(Object.assign(document.createElement("b"), { textContent: surveyName.length > 64 ? `${surveyName.slice(0, 61)}…` : surveyName, title: surveyName }));
      const releases = [...new Set(entries.filter((entry) => entry.surveyId === surveyId).map((entry) => entry.releaseId))];
      const releaseText = releases.slice(0, 2).map((release) => release.length > 48 ? `${release.slice(0, 45)}…` : release).join(" · ");
      row.append(Object.assign(document.createElement("small"), { textContent: releaseText ? `${releaseText}${releases.length > 2 ? ` · +${releases.length - 2} DR` : ""}` : (locale() === "zh" ? "区域 DR 未提供" : "Region DR unavailable"), title: releases.join(" · ") }));
      const modalities = [...new Set(entries.filter((entry) => entry.surveyId === surveyId).map((entry) => canonicalModality(entry.modality)).filter((modality) => Boolean(modality) && modality !== "coverage"))];
      const facts = document.createElement("span");
      facts.className = "overlap-region-tooltip-modalities";
      if (modalities.length) {
        modalities.slice(0, 4).forEach((modality) => facts.append(modalityBadge(modality, "overlap-source-modality")));
        if (modalities.length > 4) facts.append(Object.assign(document.createElement("small"), { textContent: `+${modalities.length - 4}` }));
      }
      else facts.textContent = locale() === "zh" ? "区域模态未提供" : "Region modality unavailable";
      row.append(facts);
      rows.append(row);
    });
    const hint = Object.assign(document.createElement("small"), { className: "overlap-region-tooltip-hint", textContent: locale() === "zh" ? "点击重合区域以选择整个区块" : "Click the overlap region to select the whole component" });
    // Bound the summary without hiding source rows below the viewport. Full
    // regional product details remain available in the selected drawer section.
    const allRows = [...rows.children];
    const rowLimit = Math.max(1, Math.min(4, Math.floor((window.innerHeight - 240) / 90)));
    tooltip.dataset.omitted = String(Math.max(0, allRows.length - rowLimit));
    if (allRows.length > rowLimit) allRows.slice(rowLimit).forEach((row) => row.remove());
    tooltip.replaceChildren(heading, area, rows, hint);
    renderIcons();
  }
  byId("coverage-canvas").setAttribute("aria-describedby", tooltip.id);
  const drawerLeft = byId("overlap-drawer").getBoundingClientRect().left;
  const right = window.innerWidth > 820 ? Math.min(window.innerWidth - 12, drawerLeft - 12) : window.innerWidth - 12;
  tooltip.style.maxWidth = `${Math.max(120, Math.min(300, right - 12))}px`;
  const rows = tooltip.querySelector<HTMLElement>(".overlap-region-tooltip-sources");
  const maxHeight = Math.max(120, window.innerHeight - 108);
  let omitted = Number(tooltip.dataset.omitted ?? 0);
  while (rows && tooltip.getBoundingClientRect().height > maxHeight && rows.querySelectorAll(".overlap-region-tooltip-source").length > 1) {
    rows.querySelector(".overlap-region-tooltip-source:last-of-type")?.remove();
    omitted += 1;
  }
  if (omitted && rows) {
    let note = rows.querySelector<HTMLElement>(".overlap-region-tooltip-overflow");
    if (!note) { note = document.createElement("small"); note.className = "overlap-region-tooltip-overflow"; rows.append(note); }
    note.textContent = locale() === "zh" ? `另有 ${omitted} 个巡天，完整内容见抽屉` : `${omitted} more surveys · full details in drawer`;
    tooltip.dataset.omitted = String(omitted);
  }
  const rect = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(hover.clientX + 18, right - rect.width))}px`;
  tooltip.style.top = `${Math.max(84, Math.min(hover.clientY + 18, window.innerHeight - rect.height - 12))}px`;
}

/** The on-globe TARGET callout for a selected overlap region, as in the normal cell view. */
function syncOverlapHudTarget(component: OverlapComponentView): void {
  // A selected cell owns the callout; the component only stands in when none is selected.
  if (!overlapDrawerOpen && coverageDots?.state?.selectedPixels.length) return;
  const surveyName = (surveyId: string) => surveyIndex?.surveys.find((survey) => survey.id === surveyId)?.name ?? surveyId;
  const entries = overlapRegionSources(component);
  const surveyIds = [...new Set(entries.length ? entries.map((entry) => entry.surveyId) : activeOverlapSurveyIds)];
  setHudTarget({
    order: component.order,
    pixel: null,
    cellCount: component.cells.length,
    title: `${component.id} · ${component.cells.length.toLocaleString("en-US")} CELLS`,
    label: surveyIds.map((id) => surveyName(id).toUpperCase()).join(" × ") || "OVERLAP",
    surveys: surveyIds.map((surveyId) => {
      const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
      const measured = [...new Set(entries.filter((entry) => entry.surveyId === surveyId && entry.modality).map((entry) => canonicalModality(entry.modality!)))];
      const declared = overlapDrawerOpen ? [] : [...new Set((survey?.modalities ?? []).map((modality) => canonicalModality(modality)))];
      const releases = [...new Set(entries.filter((entry) => entry.surveyId === surveyId).map((entry) => entry.releaseId))];
      return {
        name: [surveyName(surveyId).toUpperCase(), releases.join(" / ")].filter(Boolean).join(" · "),
        color: surveyColorFor(surveyId, survey?.color),
        modalities: (measured.length ? measured : declared).filter(Boolean).map((modality) => modalityLabel(modality)),
        declared: !measured.length && declared.length > 0,
      };
    }),
  });
  hudLog(["TARGET ACQUIRED · ", { text: `OVERLAP ${component.id}`, tone: "hot" }, ` · O${component.order}`]);
}

function sourceValue(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length) return value;
  }
  return undefined;
}

const PRIVATE_HOST = /^(?:localhost|127(?:\.|$)|0(?:\.|$)|10(?:\.|$)|192\.168(?:\.|$)|169\.254(?:\.|$)|172\.(?:1[6-9]|2\d|3[0-1])(?:\.|$)|\[?::1\]?$)/i;
const INTERNAL_HOST = /(?:\.local$|\.internal$|\.svc(?:\.|$)|\.cluster\.local$|(?:^|[-.])(minio|elasticsearch|kubernetes)(?:[-.]|$))/i;
const REVERSE_LOOKUP_MAX_CELLS = 4096;

function reverseLookupRegionTooLarge(component: OverlapComponentView): boolean {
  return component.cells.length > REVERSE_LOOKUP_MAX_CELLS;
}

/** Keep downloadable links in the public UI limited to browser-safe external URLs. */
function publicExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || PRIVATE_HOST.test(parsed.hostname) || INTERNAL_HOST.test(parsed.hostname)) return undefined;
  return parsed.toString();
}

function publicLocator(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/^(?:s3|oss):\/\//i.test(trimmed)) return trimmed;
  if (/^file:\/\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "file:" && !parsed.hostname && !parsed.username && !parsed.password) return trimmed;
    } catch { return undefined; }
  }
  return publicExternalUrl(trimmed);
}

function publicFileName(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const name = parsed.pathname.split("/").filter(Boolean).at(-1);
    return name ?? "";
  } catch {
    return raw.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  }
}

type OverlapEvidenceAccess = "preview" | "page" | "download";

function overlapEvidenceKey(component: OverlapComponentView): string {
  const layerIds = [...(component.evidenceLookup?.layerIds ?? [])].sort();
  return JSON.stringify({ order: component.order, cells: component.cells, region: component.regionSelector, layerIds,
    revisions: layerIds.map((id) => coverageCatalog?.layers.find((layer) => layer.layerId === id)?.revision) });
}

async function fetchOverlapEvidence(component: OverlapComponentView, signal?: AbortSignal, access: OverlapEvidenceAccess = "preview", page?: { cursor?: string; pageSize?: number; pageKind?: "spatial-units" | "supporting-evidence"; querySnapshotId?: string }, update?: (event: JsonStreamEvent) => void): Promise<OverlapEvidenceResult | null> {
  const lookup = component.evidenceLookup;
  if (!lookup) return null;
  const cacheKey = overlapEvidenceKey(component);
  // Only the first page is cacheable; continuation and export pages carry cursors.
  const firstPage = access === "preview" || (access === "page" && !page);
  const cached = firstPage ? cachedOverlapEvidence(component, access) : undefined;
  if (cached) return cached;
  const preview = access === "preview";
  const body: Record<string, unknown> = {
    layerIds: lookup.layerIds,
    ...(component.regionSelector ?? { order: lookup.order, cells: component.cells }),
    limit: preview ? 6 : 1000,
    preview,
  };
  if (access !== "preview") {
    body.pageSize = page?.pageSize ?? 20;
    if (page?.cursor) body.cursor = page.cursor;
    if (page?.pageKind) body.pageKind = page.pageKind;
    if (page?.querySnapshotId) body.querySnapshotId = page.querySnapshotId;
  }
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: update ? "text/event-stream" : "application/json" },
    signal,
    body: JSON.stringify(body),
  };
  let response = await fetch(lookup.endpoint, init);
  if (response.status === 429 && access !== "preview" && (page?.cursor || page?.querySnapshotId)) {
    const seconds = Math.min(60, Math.max(1, Number(response.headers.get("Retry-After")) || 60));
    await response.body?.cancel();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, seconds * 1000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    response = await fetch(lookup.endpoint, init);
  }
  if(response.status===401 && access !== "preview")resetDownloadAccess();
  if (!response.ok) {
    const failure=await response.json().catch(()=>({}));
    const retryAfter = Math.min(60, Math.max(1, Number(response.headers.get("Retry-After")) || 30));
    throw Object.assign(new Error(failure.error??`reverse lookup HTTP ${response.status}`), { status: response.status, retryAfter });
  }
  const result = await readJsonResponse<OverlapEvidenceResult>(response, update);
  if (firstPage) overlapEvidenceCache.set(cacheKey, result);
  return result;
}

/** A preview result must never stand in for the full first page of an unlocked lookup. */
function cachedOverlapEvidence(component: OverlapComponentView, access: OverlapEvidenceAccess): OverlapEvidenceResult | undefined {
  const cached = overlapEvidenceCache.get(overlapEvidenceKey(component));
  return cached && (access === "preview" || !cached.preview) ? cached : undefined;
}

function conservativePrecision(previous: unknown, next: unknown): string | undefined {
  if (typeof previous !== "string") return typeof next === "string" ? next : undefined;
  if (typeof next !== "string") return previous;
  const rank: Record<string, number> = { exact: 0, estimated: 1, "entrypoint-only": 2, truncated: 3 };
  if (rank[previous] === undefined) return previous;
  if (rank[next] === undefined) return previous;
  return rank[previous]! >= rank[next]! ? previous : next;
}

function mergeReverseSource(previous: Record<string, unknown> & { layerId?: string }, next: Record<string, unknown> & { layerId?: string }): Record<string, unknown> & { layerId?: string } {
  const merged: Record<string, unknown> & { layerId?: string } = { ...previous, ...next };
  for (const key of ["precision", "geometryPrecision"]) {
    const precision = conservativePrecision(previous[key], next[key]);
    if (precision) merged[key] = precision;
  }
  const unionNumbers = (left: unknown, right: unknown): number[] => [...new Set([
    ...(Array.isArray(left) ? left.filter((value): value is number => Number.isSafeInteger(value)) : []),
    ...(Array.isArray(right) ? right.filter((value): value is number => Number.isSafeInteger(value)) : []),
  ])].sort((a, b) => a - b);
  const regions = new Map<number, number[]>();
  for (const source of [previous, next]) {
    const groups = Array.isArray(source.matchingRegions) ? source.matchingRegions as Array<{ order: number; cells: number[] }>
      : typeof source.order === "number" && Array.isArray(source.cells) ? [{ order: source.order, cells: source.cells as number[] }] : [];
    for (const group of groups) regions.set(group.order, unionNumbers(regions.get(group.order), group.cells));
  }
  if (regions.size) {
    merged.matchingRegions = [...regions].sort(([a], [b]) => a - b).map(([order, cells]) => ({ order, cells }));
    if (regions.size === 1) { const [order, cells] = [...regions][0]!; merged.order = order; merged.nside = 2 ** order; merged.cells = cells; }
    else { delete merged.order; delete merged.nside; delete merged.cells; }
  } else if (previous.order === next.order) {
    const cells = unionNumbers(previous.cells, next.cells);
    if (cells.length || Array.isArray(previous.cells) || Array.isArray(next.cells)) merged.cells = cells;
  }
  const mergeItems = (key: "sourceUnits" | "downloads", identity: (item: Record<string, unknown>) => string): Record<string, unknown>[] => {
    const items = [...(Array.isArray(previous[key]) ? previous[key] as Record<string, unknown>[] : []), ...(Array.isArray(next[key]) ? next[key] as Record<string, unknown>[] : [])];
    const unique = new Map(items.map((item) => [identity(item), item]));
    if (unique.size || Array.isArray(previous[key]) || Array.isArray(next[key])) merged[key] = [...unique.values()];
    return [...unique.values()];
  };
  const units = mergeItems("sourceUnits", (item) => `${item.unitKind ?? ""}:${item.unitId ?? ""}`);
  mergeItems("downloads", (item) => `${item.kind ?? ""}:${item.unitKind ?? ""}:${item.unitId ?? ""}:${item.url ?? ""}`);
  const oldSummary = previous.sourceUnitSummary && typeof previous.sourceUnitSummary === "object" ? previous.sourceUnitSummary as Record<string, unknown> : undefined;
  const newSummary = next.sourceUnitSummary && typeof next.sourceUnitSummary === "object" ? next.sourceUnitSummary as Record<string, unknown> : undefined;
  if (oldSummary || newSummary) {
    const summary = { ...oldSummary, ...newSummary };
    if (oldSummary?.matchedUnitCount !== undefined || newSummary?.matchedUnitCount !== undefined) {
      // Counts without returned identities are retained as a lower bound; overlapping batches may repeat units.
      summary.matchedUnitCount = Math.max(Number(oldSummary?.matchedUnitCount ?? 0), Number(newSummary?.matchedUnitCount ?? 0), units.length);
    }
    summary.truncated = oldSummary?.truncated === true || newSummary?.truncated === true;
    merged.sourceUnitSummary = summary;
  }
  const completeness = [previous.completeness, next.completeness];
  if (completeness.includes("truncated")) merged.completeness = "truncated";
  else if (completeness.includes("incomplete")) merged.completeness = "incomplete";
  else if (completeness.includes("complete") && !completeness.includes("unknown")) merged.completeness = "complete";
  const reasons = [...new Set([previous.reason, next.reason].filter((value): value is string => typeof value === "string" && value.length > 0))];
  if (reasons.length) merged.reason = reasons.join(" ");
  return merged;
}

function mergeOverlapEvidence(current: OverlapEvidenceResult, next: OverlapEvidenceResult): OverlapEvidenceResult {
  if (current.querySnapshot?.id && next.querySnapshot?.id && current.querySnapshot.id !== next.querySnapshot.id) throw new Error("Reverse lookup snapshot changed");
  const currentPlan = downloadPlanFor(current);
  const nextPlan = downloadPlanFor(next);
  const sources = new Map((current.sources ?? []).filter((source) => source.layerId).map((source) => [source.layerId!, source]));
  (next.sources ?? []).forEach((source) => {
    if (!source.layerId) return;
    const previous = sources.get(source.layerId);
    sources.set(source.layerId, previous ? mergeReverseSource(previous, source) : source);
  });
  return {
    ...current,
    ...next,
    available: current.available || next.available,
    precision: conservativePrecision(current.precision, next.precision) ?? next.precision,
    truncated: next.truncated,
    preview: undefined,
    page: next.page,
    spatialPage: next.spatialPage ?? current.spatialPage,
    supportingPage: next.supportingPage ?? current.supportingPage,
    notes: [...new Set([...(current.notes ?? []), ...(next.notes ?? [])])],
    sources: [...sources.values()],
    sourceFiles: [...current.sourceFiles, ...next.sourceFiles].filter((source, index, values) => values.findIndex((candidate) => `${sourceValue(candidate, ["layer_id"])}:${sourceValue(candidate, ["fileId", "file_id", "_id"])}` === `${sourceValue(source, ["layer_id"])}:${sourceValue(source, ["fileId", "file_id", "_id"])}`) === index),
    edges: [...current.edges, ...next.edges].filter((edge, index, values) => values.findIndex((candidate) => `${candidate.edgeId ?? ""}:${candidate.layerId ?? ""}:${candidate.order}:${candidate.ipix}` === `${edge.edgeId ?? ""}:${edge.layerId ?? ""}:${edge.order}:${edge.ipix}`) === index),
    downloadPlan: mergeDownloadPlans(currentPlan, nextPlan),
  };
}

function publicLayerEntry(layerId: string | undefined): { surveyId: string; releaseId: string; product: string; modality: string; sourceUrl?: string; geometrySourceUrl?: string } {
  const layer = layerId ? coverageCatalog?.layers.find((entry) => entry.layerId === layerId) : undefined;
  const survey = layer ? surveyIndex?.surveys.find((entry) => entry.id === layer.surveyId) : undefined;
  const release = layer ? survey?.releases.find((entry) => entry.id === layer.releaseId) : undefined;
  const product = layer ? release?.products.find((entry) => entry.name === layer.product) : undefined;
  return {
    surveyId: layer?.surveyId ?? "",
    releaseId: layer?.releaseId ?? "",
    product: product?.name ?? layer?.product ?? "",
    modality: product?.modality ?? layer?.modality ?? "",
    ...(publicExternalUrl(product?.sourceUrl ?? layer?.recipe?.sourceUrl) ? { sourceUrl: publicExternalUrl(product?.sourceUrl ?? layer?.recipe?.sourceUrl) } : {}),
    ...(publicExternalUrl(product?.geometrySourceUrl) ? { geometrySourceUrl: publicExternalUrl(product?.geometrySourceUrl) } : {}),
  };
}

function legacyDownloadPlan(result: OverlapEvidenceResult | null): DownloadPlan {
  const sourceFiles = result?.sourceFiles ?? [];
  const sourceById = new Map<string, Record<string, unknown>>();
  sourceFiles.forEach((source) => {
    const id = sourceValue(source, ["fileId", "file_id", "sourceFileId", "source_file_id", "_id"]);
    if (id) sourceById.set(id, source);
  });
  const files = new Map<string, DownloadPlanFile>();
  (result?.edges ?? []).forEach((edge) => {
    const source = edge.sourceFileId ? sourceById.get(edge.sourceFileId) : undefined;
    const sourceUri = publicLocator(sourceValue(source ?? {}, ["sourceUri", "source_uri", "uri", "urn"]) ?? edge.sourceUri);
    const downloadUrl = publicExternalUrl(sourceValue(source ?? {}, ["downloadUrl", "download_url"]) ?? edge.downloadUrl ?? sourceUri);
    const fileId = edge.sourceFileId ?? sourceUri ?? edge.edgeId ?? `edge:${edge.layerId ?? "unknown"}:${edge.order}:${edge.ipix}`;
    const match: DownloadPlanMatch = { ...(edge.layerId ? { layerId: edge.layerId } : {}), order: edge.order, ipix: edge.ipix, precision: edge.precision, ...(edge.coverageMethod ? { coverageMethod: edge.coverageMethod } : {}), ...(edge.coverageRole ? { coverageRole: edge.coverageRole } : {}) };
    const current = files.get(fileId);
    if (current) {
      if (!current.matchingCoverage.some((entry) => entry.layerId === match.layerId && entry.order === match.order && entry.ipix === match.ipix)) current.matchingCoverage.push(match);
      return;
    }
    const fileName = sourceValue(source ?? {}, ["fileName", "file_name", "name"]) ?? edge.fileName;
    const fileType = sourceValue(source ?? {}, ["fileType", "file_type", "type"]);
    const sizeBytes = Number(sourceValue(source ?? {}, ["sizeBytes", "size_bytes", "size"]) ?? edge.sizeBytes);
    const unitKind = sourceValue(source ?? {}, ["unitKind", "unit_kind"]);
    const unitId = sourceValue(source ?? {}, ["unitId", "unit_id", "tileId", "tile_id"]);
    const downloadProvider = sourceValue(source ?? {}, ["downloadProvider", "download_provider"]);
    files.set(fileId, {
      fileId,
      metadataState: source ? "complete" : "missing",
      ...(unitKind ? { unitKind } : {}),
      ...(unitId ? { unitId } : {}),
      ...(downloadProvider ? { downloadProvider } : {}),
      ...(fileName ? { fileName } : {}),
      ...(fileType ? { fileType } : {}),
      ...(Number.isFinite(sizeBytes) ? { sizeBytes } : {}),
      ...(sourceUri ? { sourceUri } : {}),
      downloadable: Boolean(downloadUrl),
      ...(downloadUrl ? { downloadUrl } : {}),
      matchingCoverage: [match],
    });
  });
  const entrypoints = (result?.entrypoints ?? []).flatMap((entry): DownloadPlanEntrypoint[] => {
    const common = { layerId: entry.layerId, ...(entry.productId ? { productId: entry.productId } : {}), ...(entry.surveyId ? { surveyId: entry.surveyId } : {}), ...(entry.releaseId ? { releaseId: entry.releaseId } : {}), ...(entry.product ? { product: entry.product } : {}), order: entry.order, nside: entry.nside, cells: entry.cells, precision: entry.precision, ...(entry.note ? { note: entry.note } : {}) };
    return [
      ...(entry.sourceUrl ? [{ ...common, kind: "official-data", purpose: "data-access" as const, url: entry.sourceUrl, sourceUrl: entry.sourceUrl }] : []),
      ...(entry.mocUrl ? [{ ...common, kind: "coverage-moc", purpose: "coverage-reference" as const, url: entry.mocUrl, mocUrl: entry.mocUrl }] : []),
    ];
  });
  return { schemaVersion: 1, files: [...files.values()], entrypoints, truncated: result?.truncated ?? false, warnings: [] };
}

function downloadPlanFor(result: OverlapEvidenceResult | null): DownloadPlan {
  return result?.downloadPlan ?? legacyDownloadPlan(result);
}

async function evidenceForExport(component: OverlapComponentView, signal?: AbortSignal): Promise<OverlapEvidenceResult | null> {
  const current = await fetchOverlapEvidence(component, signal);
  if (!current || !hasDownloadAccess()) return current;
  if (current.querySnapshot && current.page?.hasMore === false && !current.preview) return current;
  let result = await fetchOverlapEvidence(component, signal, "download", { querySnapshotId: current.querySnapshot?.id, pageSize: 100 });
  if (!result) return null;
  const cursors = new Set<string>();
  while (result.page?.hasMore) {
    const cursor = result.page.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("Reverse lookup pagination did not advance");
    cursors.add(cursor);
    const next = await fetchOverlapEvidence(component, signal, "download", { cursor, pageSize: 100 });
    if (!next) throw new Error("Reverse lookup page was unavailable");
    result = mergeOverlapEvidence(result, next);
  }
  if (signal?.aborted) throw signal.reason;
  const key = overlapEvidenceKey(component);
  overlapEvidenceCache.set(key, result);
  const host = overlapEvidenceHosts.get(key);
  if (host?.isConnected) renderEvidencePlan(host, result, component);
  return result;
}

async function downloadOverlapCsv(components: OverlapComponentView[], filename: string, button: HTMLButtonElement): Promise<void> {
  if (components.some(reverseLookupRegionTooLarge)) {
    toast(t("coverage.overlapRegionTooLarge"), 8000);
    return;
  }
  const original = button.textContent ?? "Download CSV";
  button.disabled = true;
  button.textContent = t("coverage.downloadLoading");
  try {
    const results: Array<OverlapEvidenceResult | null> = [];
    // One download operation must not exceed the per-identity concurrency limit.
    for (const component of components) results.push(await evidenceForExport(component));
    const rows = components.flatMap((component, index) => overlapCsvRows(component, downloadPlanFor(results[index] ?? null), publicLayerEntry, results[index]?.precision, {
      snapshotId: results[index]?.querySnapshot?.id, nativeUnitIndexRevision: results[index]?.nativeUnitIndexRevision,
      omitted: results[index]?.page?.omitted ?? results[index]?.preview?.omitted ?? 0,
      hasMore: results[index]?.page?.hasMore ?? results[index]?.preview?.hasMore ?? false,
    }));
    if (!rows.length) {
      toast(t("coverage.noDownloadEntries"));
      return;
    }
    const csv = overlapCsvDocument(rows);
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    toast(t("coverage.downloadReady"));
  } catch (error) {
    toast(`${t("coverage.downloadUnavailable")}: ${error instanceof Error ? error.message : t("coverage.reverseFailed")}`, 8000);
  } finally {
    button.disabled = false;
    button.replaceChildren(icon("download"), document.createTextNode(original));
    renderIcons();
  }
}

async function downloadOverlapJson(components: OverlapComponentView[], filename: string, button: HTMLButtonElement): Promise<void> {
  if (components.some(reverseLookupRegionTooLarge)) {
    toast(t("coverage.overlapRegionTooLarge"), 8000);
    return;
  }
  const original = button.textContent ?? "Download JSON";
  button.disabled = true;
  button.textContent = t("coverage.downloadLoading");
  try {
    const results: Array<OverlapEvidenceResult | null> = [];
    // One download operation must not exceed the per-identity concurrency limit.
    for (const component of components) results.push(await evidenceForExport(component));
    const payload = {
      schemaVersion: 1,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      generatedAt: new Date().toISOString(),
      components: components.map((component, index) => ({
        componentId: component.id,
        order: component.order,
        nside: 2 ** component.order,
        cells: component.cells,
        bounds: component.bounds,
        querySnapshot: results[index]?.querySnapshot,
        nativeUnitIndexRevision: results[index]?.nativeUnitIndexRevision,
        preview: results[index]?.preview,
        page: results[index]?.page,
        notes: results[index]?.notes,
        ...(results[index] ? { downloadPlan: downloadPlanFor(results[index]) } : { downloadPlan: { schemaVersion: 1, files: [], entrypoints: [], truncated: false, warnings: ["reverse lookup was unavailable"] } }),
      })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    toast(t("coverage.downloadReady"));
  } catch (error) {
    toast(`${t("coverage.downloadUnavailable")}: ${error instanceof Error ? error.message : t("coverage.reverseFailed")}`, 8000);
  } finally {
    button.disabled = false;
    button.replaceChildren(icon("file-json-2"), document.createTextNode(original));
    renderIcons();
  }
}

function appendSourceLocator(row: HTMLElement, sourceUri: string): void {
  const local = sourceUri.startsWith("file:///");
  const object = /^(?:s3|oss):\/\//i.test(sourceUri);
  const remote = !local && !object;
  const externalUrl = remote ? publicExternalUrl(sourceUri) : undefined;
  const locator = document.createElement("div");
  locator.className = "overlap-source-locator";
  const value = externalUrl ? document.createElement("a") : document.createElement("code");
  if (value instanceof HTMLAnchorElement) {
    value.href = externalUrl!;
    value.target = "_blank";
    value.rel = "noopener noreferrer";
    value.title = "打开来源 URI";
    value.setAttribute("aria-label", `打开来源 URI ${sourceUri}`);
  }
  value.textContent = sourceUri;
  locator.append(value);
  row.append(locator);
}

function countryFlagUrl(code?: string): string {
  const iconNames: Record<string, string> = { US: "usa-circular", CN: "china-circular", ES: "spain-circular", JP: "japan-circular" };
  return `https://img.icons8.com/color/48/${iconNames[code?.toUpperCase() ?? ""] ?? "globe"}.png`;
}

function appendConnectorIcon(parent: HTMLElement, connector: ScanConnectorIdentity): void {
  const brand = document.createElement("span");
  brand.className = "overlap-access-flag";
  if (connector.iconUrl) {
    const image = Object.assign(document.createElement("img"), {
      src: connector.iconUrl, alt: `${connector.name} icon`, width: 18, height: 18, referrerPolicy: "no-referrer",
    });
    image.addEventListener("error", () => { brand.replaceChildren(icon(connectorDefaultIcon(connector.type))); renderIcons(); }, { once: true });
    brand.append(image);
  } else brand.append(icon(connectorDefaultIcon(connector.type)));
  parent.append(brand);
}

function appendScannedFileSource(parent: HTMLElement, file: DownloadPlanScannedFile, options: { fileName?: boolean; provenance?: boolean } = {}): void {
  const row = document.createElement("div");
  row.className = "overlap-scanned-source";
  if (options.fileName !== false) row.append(Object.assign(document.createElement("small"), {
    className: "overlap-spatial-unit-file-name", textContent: file.fileName ?? file.fileId,
  }));
  const metadata = document.createElement("div");
  metadata.className = "overlap-spatial-unit-access-meta";
  const heading = document.createElement("span");
  heading.className = "overlap-access-meta-heading";
  const brand = document.createElement("span");
  brand.className = "overlap-access-flag";
  const connectors = file.connectors ?? [];
  if (connectors.length) {
    connectors.forEach((connector, index) => {
      const source = document.createElement("span");
      source.className = "overlap-scan-connector";
      appendConnectorIcon(source, connector);
      source.append(document.createTextNode(`${connector.name}${connector.type === "unknown" ? "" : ` · ${connector.type.toUpperCase()}`}`));
      if (index) heading.append(document.createTextNode(" · "));
      heading.append(source);
    });
  } else {
    brand.append(icon("database"));
    heading.append(brand, document.createTextNode(locale() === "zh" ? "Warehouse · Connector 未关联" : "Warehouse · Connector unknown"));
  }
  const scanned = document.createElement("span");
  scanned.className = "overlap-access-status";
  scanned.dataset.status = "scanned";
  scanned.append(icon("file-check-2"), document.createTextNode(locale() === "zh" ? "已扫描" : "Seen in scan"));
  heading.append(scanned);
  const internal = /^(?:oss|s3|file):/i.test(file.sourceUri ?? "");
  if (internal) {
    const access = document.createElement("span");
    access.className = "overlap-access-status";
    access.dataset.status = "internal";
    access.append(icon("lock"), document.createTextNode(locale() === "zh" ? "内部来源，需授权" : "Internal · authorization required"));
    heading.append(access);
  }
  metadata.append(heading);
  row.append(metadata);
  if (file.sourceUri) appendSourceLocator(row, file.sourceUri);
  const matches = file.matchingCoverage ?? [];
  const runs = [...new Set([file.scanRunId, ...matches.map(match => match.scanRunId)].filter((value): value is string => Boolean(value)))];
  const hashes = [...new Set([file.sourceSnapshotSha256, ...matches.map(match => match.sourceSnapshotSha256)].filter((value): value is string => Boolean(value)))];
  if (options.provenance !== false && (runs.length || hashes.length)) {
    const provenance = document.createElement("details");
    provenance.className = "overlap-scanned-provenance";
    provenance.append(Object.assign(document.createElement("summary"), { textContent: locale() === "zh" ? "扫描依据与文件记录" : "Scan evidence and file records" }));
    connectors.forEach(connector => provenance.append(Object.assign(document.createElement("small"), {
      textContent: `${connector.name} · ${locale() === "zh" ? connector.identityBasis === "scan-run" ? "扫描运行关联" : "锁定扫描 scope 关联" : connector.identityBasis}`,
    })));
    runs.forEach(run => provenance.append(Object.assign(document.createElement("code"), { textContent: `SCAN RUN ${run}` })));
    hashes.forEach(hash => provenance.append(Object.assign(document.createElement("code"), { textContent: `SNAPSHOT SHA-256 ${hash}` })));
    row.append(provenance);
  }
  parent.append(row);
}

function countryName(code?: string): string {
  const value = code?.toUpperCase();
  if (!value || !/^[A-Z]{2}$/.test(value)) return locale() === "zh" ? "地域未知" : "Region unknown";
  try {
    return new Intl.DisplayNames([locale() === "zh" ? "zh-CN" : "en"], { type: "region" }).of(value) ?? value;
  } catch {
    return value;
  }
}

function accessStatusLabel(status: string, accessType: string): string {
  const zh = locale() === "zh";
  if (status === "verified") return zh ? accessType === "directory" ? "目录已核验" : "入口已核验" : accessType === "directory" ? "Verified directory" : "Verified entrypoint";
  if (status === "source-listed") return zh ? "来源清单已列出" : "Listed by source";
  if (status === "rule-derived") return zh ? "规则推导，未逐项核验" : "Rule-derived, not individually checked";
  if (status === "unavailable") return zh ? "当前不可用" : "Currently unavailable";
  return zh ? "仅来源入口" : "Entrypoint only";
}

function accessStatusIcon(status: string): string {
  if (status === "verified") return "badge-check";
  if (status === "source-listed") return "file-check-2";
  if (status === "rule-derived") return "circle-help";
  if (status === "unavailable") return "x";
  return "external-link";
}

function appendAccessAlternative(row: HTMLElement, entry: {
  uri: string; accessType?: string; provider?: string; providerCountryCode?: string;
  providerLocation?: string; servingRegion?: string; relationship?: string; status?: string; checkedAt?: string;
  httpStatus?: number; note?: string;
}): void {
  const type = entry.accessType ?? "file";
  const metadata = document.createElement("div");
  metadata.className = "overlap-spatial-unit-access-meta";
  const region = [countryName(entry.providerCountryCode), entry.providerLocation, entry.servingRegion].filter(Boolean).join(" · ");
  const relationship = entry.relationship === "mirror" ? (locale() === "zh" ? "镜像" : "Mirror")
    : entry.relationship === "regional-repository" ? (locale() === "zh" ? "区域仓库" : "Regional repository") : "";
  const heading = document.createElement("span");
  heading.className = "overlap-access-meta-heading";
  const flag = document.createElement("span");
  flag.className = "overlap-access-flag";
  flag.setAttribute("role", "img");
  flag.setAttribute("aria-label", `${countryName(entry.providerCountryCode)}${locale() === "zh" ? "国旗" : " flag"}`);
  const flagImage = document.createElement("img");
  flagImage.src = countryFlagUrl(entry.providerCountryCode);
  flagImage.alt = "";
  flagImage.width = 18;
  flagImage.height = 18;
  flagImage.loading = "lazy";
  flagImage.decoding = "async";
  flagImage.referrerPolicy = "no-referrer";
  flagImage.addEventListener("error", () => {
    flag.textContent = "◉";
    flag.setAttribute("aria-label", countryName(entry.providerCountryCode));
  }, { once: true });
  flag.append(flagImage);
  heading.append(flag, document.createTextNode(entry.provider ?? "Survey source"));
  if (relationship) heading.append(document.createTextNode(` · ${relationship}`));
  const statusValue = entry.status ?? "source-listed";
  const status = document.createElement("span");
  status.className = "overlap-access-status";
  status.dataset.status = statusValue;
  status.append(icon(accessStatusIcon(statusValue)), document.createTextNode(accessStatusLabel(statusValue, type)));
  heading.append(status);
  metadata.append(heading);
  const details = [`${entry.httpStatus ? `HTTP ${entry.httpStatus}` : ""}`, entry.checkedAt?.slice(0, 10) ?? "", region].filter(Boolean).join(" · ");
  if (details) metadata.append(Object.assign(document.createElement("small"), { className: "overlap-access-meta-details", textContent: details }));
  if (entry.note) metadata.title = entry.note;
  row.append(metadata);
  appendSourceLocator(row, entry.uri);
}

function spatialUnitMatchLabel(unit: DownloadPlanSpatialUnit): string {
  const regions = unit.matchingRegions ?? (unit.order !== undefined ? [{ order: unit.order, cells: unit.matchingCells ?? [] }] : []);
  return regions.map(region => `O${region.order} · ${region.cells.length} ${locale() === "zh" ? "个像元" : "cells"}`).join(" / ") || (locale() === "zh" ? "空间依据未提供" : "Spatial evidence unavailable");
}

function appendSpatialUnitAccess(row: HTMLElement, unit: DownloadPlanSpatialUnit): void {
  const entries: NonNullable<DownloadPlanSpatialUnit["accessUris"]> = unit.accessUris?.length ? unit.accessUris
    : unit.accessUri ? [{ uri: unit.accessUri, accessType: unit.unitKind === "tile" ? "directory" as const : "file" as const }] : [];
  for (const entry of entries) {
    if (entry.fileName) row.append(Object.assign(document.createElement("small"), { className: "overlap-spatial-unit-file-name", textContent: entry.fileName }));
    const alternatives = entry.alternatives?.length ? entry.alternatives : [{ uri: entry.uri, accessType: entry.accessType ?? "file", provider: "Survey source", status: "source-listed" }];
    alternatives.forEach(alternative => appendAccessAlternative(row, alternative));
  }
  const metadata = unit.sourceMetadata;
  const entrypoints = Array.isArray(metadata?.entrypoints) ? metadata.entrypoints as Array<Parameters<typeof appendAccessAlternative>[1]> : [];
  const providerStatuses = Array.isArray(metadata?.providerStatuses) ? metadata.providerStatuses as Array<Parameters<typeof appendAccessAlternative>[1]> : [];
  entrypoints.forEach(entry => appendAccessAlternative(row, entry));
  providerStatuses.forEach(entry => appendAccessAlternative(row, entry));
}

function appendMissingNativeSources(node: HTMLElement, result: OverlapEvidenceResult, plan: DownloadPlan, component?: OverlapComponentView): void {
  const unitsExhausted = result.spatialPage?.hasMore === false || (!result.preview && result.page?.hasMore === false);
  if (!unitsExhausted || !component?.evidenceLookup || !coverageCatalog) return;
  const groups = new Map<string, CoverageCatalog["layers"]>();
  for (const layerId of component.evidenceLookup.layerIds) {
    const layer = coverageCatalog.layers.find(entry => entry.layerId === layerId);
    if (!layer) continue;
    const key = component.selectedRegion ? layer.layerId : JSON.stringify([layer.surveyId, layer.releaseId]);
    groups.set(key, [...(groups.get(key) ?? []), layer]);
  }
  for (const layers of groups.values()) {
    const first = layers[0]!;
    if (component.selectedRegion ? layers.every(layer => plan.spatialUnits?.some(unit => unit.layerId === layer.layerId))
      : plan.spatialUnits?.some(unit => unit.surveyId === first.surveyId && unit.releaseId === first.releaseId)) continue;
    const survey = surveyIndex?.surveys.find(entry => entry.id === first.surveyId);
    const release = survey?.releases.find(entry => entry.id === first.releaseId);
    const card = document.createElement("div");
    card.className = "overlap-native-source-gap";
    card.dataset.surveyId = first.surveyId;
    card.dataset.releaseId = first.releaseId;
    const title = document.createElement("strong");
    title.textContent = `${survey?.name ?? first.surveyId} · ${release?.label ?? first.releaseId}${component.selectedRegion ? ` · ${first.product}` : ""} · ${locale() === "zh" ? "未返回原生分块" : "No native units returned"}`;
    card.append(title);
    const modalities = [...new Set(layers.flatMap(layer => layer.modality ? [layer.modality] : []))];
    const facts = document.createElement("div");
    facts.className = "overlap-spatial-unit-facts";
    for (const modality of modalities) facts.append(modalityBadge(modality, "overlap-spatial-unit-modality"));
    facts.append(document.createTextNode(component.selectedRegion ? (locale() === "zh" ? "所选区域 · 产品映射状态" : "Selected region · product mapping status") : `O${component.order} · 覆盖图命中`));
    card.append(facts);
    const note = document.createElement("small");
    const ero = first.surveyId === "euclid" && first.releaseId === "euclid-ero";
    const excluded = ero ? result.notes?.join("\n").match(/ERO snapshot excludes (\d+) targets/)?.[1] : undefined;
    note.textContent = component.selectedRegion
      ? (locale() === "zh" ? "所选产品的冻结原生索引未返回全部产品的空间分块；请核对来源范围和映射状态。这不表示此天区没有数据，也不表示每个产品均有覆盖图命中。" : "The frozen native inventory did not return units for every selected product. Check source scope and mapping status; this does not establish absence of data or a coverage hit for every product.")
      : ero
      ? `${excluded ? `当前 ERO 反查缺少 ${excluded} 个 target 的空间映射。` : "当前 ERO 反查依赖已核实的 target 空间映射。"}此区域未匹配到可列出的 target；ERO 尚无核实过的 Tile 清单。下方链接是公开发布入口。`
      : "覆盖图与此区域相交，当前冻结分块索引未返回可列出的原生分块。请从公开来源核对数据范围；该结果不表示此天区没有数据。";
    card.append(note);
    const entry = plan.entrypoints.find(candidate => candidate.kind === "official-release"
      && layers.some(layer => layer.layerId === candidate.layerId));
    const url = entry?.url ?? entry?.sourceUri ?? entry?.sourceUrl ?? publicLayerEntry(first.layerId).sourceUrl;
    const link = url ? drawerDocLink(url, "查看公开数据来源") : undefined;
    if (link) card.append(link);
    node.append(card);
  }
}

function renderEvidencePlan(node: HTMLElement, result: OverlapEvidenceResult, component?: OverlapComponentView): void {
  node.dataset.lookupState = "complete";
  if (component) {
    const key = overlapEvidenceKey(component);
    overlapEvidenceCache.set(key, result);
    overlapEvidenceHosts.set(key, node);
  }
  node.replaceChildren();
  const plan = downloadPlanFor(result);
  if (component?.selectedRegion && activeRegionQuery === component) renderRegionQueryMetadata(component, result);
  const coverageEvidence = plan.coverageEvidence ?? [];
  if (!result.available && !plan.spatialUnits?.length && !plan.files.length && !plan.entrypoints.length && !coverageEvidence.length
    && !result.spatialPage?.hasMore && !result.supportingPage?.hasMore) {
    node.append(Object.assign(document.createElement("small"), { textContent: t("coverage.evidenceUnavailable") }));
    return;
  }
  const previewLimit = result.preview?.limit ?? Number.POSITIVE_INFINITY;
  const displaySpatialUnits = plan.spatialUnits ?? [];
  const attachedFileIds = new Set(displaySpatialUnits.flatMap((unit) => unit.scannedFiles?.map((file) => file.fileId) ?? []));
  const displayFiles = plan.files.filter((file) => !attachedFileIds.has(file.fileId)).slice(0, previewLimit);
  const displayEntrypoints = plan.entrypoints.filter((entry) => !displaySpatialUnits.some((unit) => unit.layerId === entry.layerId && unit.unitId === String(entry.tileId ?? "") && entry.kind === "tile-directory"));
  const displayCoverageEvidence = coverageEvidence;
  const spatialHasMore = Boolean(result.spatialPage?.hasMore && result.spatialPage.nextCursor);
  const supportingHasMore = Boolean(result.supportingPage?.hasMore && result.supportingPage.nextCursor);
  const drawerResultsSection = node.parentElement?.classList.contains("overlap-drawer-results") ? node.parentElement : null;
  const resultHeading = `匹配的空间分块 · ${result.preview ? "已展示" : "已加载"} ${displaySpatialUnits.length}${spatialHasMore ? " · 还有更多分块" : ""}`;
  if (drawerResultsSection) {
    const heading = drawerResultsSection.querySelector("h3");
    if (heading) heading.textContent = resultHeading;
  } else {
    node.append(Object.assign(document.createElement("strong"), { textContent: resultHeading }));
  }
  appendMissingNativeSources(node, result, plan, component);
  const supporting = document.createElement("details");
  supporting.className = "overlap-supporting-evidence";
  const supportingSummary = document.createElement("summary");
  const scanScopeCount = plan.scanScopes?.length ?? 0;
  supportingSummary.textContent = `辅助信息 · ${displayEntrypoints.length} 个来源入口、${displayFiles.length} 个未归入分块的文件、${displayCoverageEvidence.length} 条覆盖依据${scanScopeCount ? `、${scanScopeCount} 个扫描范围` : ""}`;
  const hasSupporting = displayEntrypoints.length > 0 || displayFiles.length > 0 || displayCoverageEvidence.length > 0
    || scanScopeCount > 0 || result.notes?.length || plan.warnings.length || supportingHasMore;
  supporting.append(supportingSummary);
  supporting.append(Object.assign(document.createElement("small"), {
    className: "overlap-evidence-note",
    textContent: "这些记录说明数据来源、扫描情况和覆盖判断依据，不是空间分块，也不计入分块数量。",
  }));
  if (!displaySpatialUnits.length && !spatialHasMore) {
    node.append(Object.assign(document.createElement("small"), {
      className: "overlap-evidence-note",
      textContent: "当前没有匹配到可列出的原生空间分块。来源入口和覆盖信息收在辅助信息中。",
    }));
  }
  for (const scope of plan.scanScopes ?? []) {
    const summary = document.createElement("small");
    summary.textContent = `${scope.publishedLayerId ?? scope.layerId} · 扫描范围 ${scope.scopeId}：已提交 ${scope.committedPartitions}/${scope.expectedPartitions} 个分区${scope.completeness === "incomplete" ? "（尚未完成）" : ""}；仅代表此冻结范围，不代表完整巡天。`;
    summary.title = `证据层: ${scope.layerId}\n范围快照 SHA-256: ${scope.scopeSnapshotSha256}`;
    supporting.append(summary);
  }
  if (displaySpatialUnits.length || result.spatialPage) {
    if (!drawerResultsSection) {
      node.append(Object.assign(document.createElement("strong"), { textContent: `空间分块 URI · ${displaySpatialUnits.length}` }));
    }
    const units = document.createElement("div");
    units.className = "overlap-evidence-files overlap-spatial-units";
    for (const unit of displaySpatialUnits) {
      const row = document.createElement("div");
      row.className = "overlap-evidence-file overlap-spatial-unit";
      row.append(Object.assign(document.createElement("small"), {
        className: "overlap-spatial-unit-source",
        textContent: `${unit.surveyId} · ${unit.releaseId} · ${unit.product}`,
      }));
      const identity = document.createElement("div");
      identity.className = "overlap-spatial-unit-identity";
      identity.append(Object.assign(document.createElement("strong"), {
        className: "overlap-spatial-unit-title",
        textContent: `${unit.unitKind.toUpperCase()} ${unit.unitId}`,
      }));
      const accessStatus = unit.accessAvailability === "source-policy"
        ? "访问遵循来源站点策略"
        : unit.accessAvailability === "unverified"
          ? "URI 按分块规则生成，文件存在性尚未核实"
          : unit.accessAvailability === "public" ? "来源标记为公开访问" : undefined;
      const infoText = [unit.note, accessStatus].filter(Boolean).join("\n");
      if (infoText) {
        identity.append(infoControl(infoText));
      }
      row.append(identity);
      const facts = document.createElement("div");
      facts.className = "overlap-spatial-unit-facts";
      facts.append(modalityBadge(unit.modality, "overlap-spatial-unit-modality"));
      facts.append(Object.assign(document.createElement("span"), {
        className: "overlap-spatial-unit-match",
        textContent: spatialUnitMatchLabel(unit),
      }));
      facts.append(precisionIndicator(unit.precision));
      row.append(facts);
      appendSpatialUnitAccess(row, unit);
      if (unit.scannedFiles?.length) {
        const scans = document.createElement("div");
        scans.className = "overlap-scanned-sources";
        unit.scannedFiles.forEach(file => appendScannedFileSource(scans, file));
        row.append(scans);
      }
      units.append(row);
    }
    node.append(units);
    if (spatialHasMore && component) {
      const loadMore = document.createElement("button");
      loadMore.type = "button";
      loadMore.className = "command-button overlap-evidence-more-button";
      loadMore.append(icon("list-filter"), document.createTextNode("继续加载空间分块"));
      loadMore.addEventListener("click", async () => {
        loadMore.disabled = true;
        loadMore.replaceChildren(icon("rotate-ccw"), document.createTextNode("正在加载…"));
        renderIcons();
        try {
          if (!await ensureDownloadAccess()) {
            loadMore.disabled = false;
            loadMore.replaceChildren(icon("list-filter"), document.createTextNode("继续加载空间分块"));
            renderIcons();
            return;
          }
          const next = await fetchOverlapEvidence(component, undefined, "page", { cursor: result.spatialPage?.nextCursor, pageSize: 30, pageKind: "spatial-units" });
          if (next) renderEvidencePlan(node, mergeOverlapEvidence(result, next), component);
        } catch (error) {
          loadMore.disabled = false;
          loadMore.replaceChildren(icon("list-filter"), document.createTextNode("继续加载空间分块"));
          renderIcons();
          const failure = document.createElement("small");
          failure.className = "overlap-evidence-more-error";
          failure.textContent = `${t("coverage.reverseFailed")}: ${error instanceof Error ? error.message : ""}`;
          loadMore.insertAdjacentElement("afterend", failure);
        }
      });
      node.append(loadMore);
    }
  }
  if (hasSupporting) node.append(supporting);
  if (displayCoverageEvidence.length) {
    const coverageHeading = document.createElement("strong");
    coverageHeading.textContent = `覆盖依据 · ${displayCoverageEvidence.length}`;
    supporting.append(coverageHeading);
    const list = document.createElement("div");
    list.className = "overlap-evidence-files overlap-coverage-evidence";
    displayCoverageEvidence.forEach((evidence) => {
      const row = document.createElement("div");
      row.className = "overlap-evidence-file overlap-coverage-evidence-item";
      const title = document.createElement("strong");
      title.textContent = `${evidence.surveyId} · ${evidence.releaseId} · ${evidence.product}`;
      row.append(title);
      const precision = document.createElement("div");
      precision.className = "overlap-coverage-precision";
      precision.append(
        Object.assign(document.createElement("small"), {
          textContent: `${evidence.evidenceKind} · overlap ICRS/NESTED O${evidence.order} · native MOC max O${evidence.nativeMaxOrder} · ${evidence.matchedCells.length} matched cell(s)${evidence.availableOrders.length ? ` · query orders ${evidence.availableOrders.map((order) => `O${order}`).join(", ")}` : ""}`,
        }),
        precisionIndicator(evidence.precision),
      );
      row.append(precision);
      if (evidence.sourceIdentity || evidence.instrument || evidence.filters) {
        row.append(Object.assign(document.createElement("small"), {
          textContent: [evidence.sourceIdentity, evidence.instrument, evidence.filters].filter(Boolean).join(" · "),
        }));
      }
      if (evidence.completeness || evidence.scienceFileScan) {
        row.append(Object.assign(document.createElement("small"), {
          textContent: `completeness=${evidence.completeness ?? "unknown"} · science-file scan=${evidence.scienceFileScan ?? "unknown"}`,
        }));
      }
      if (evidence.sourceSnapshotSha256) {
        row.append(Object.assign(document.createElement("small"), {
          className: "coverage-evidence-snapshot",
          textContent: `source snapshot SHA-256 · ${evidence.sourceSnapshotSha256}`,
        }));
      }
      if (evidence.sourceLabel) row.append(Object.assign(document.createElement("small"), { textContent: `来源：${evidence.sourceLabel}` }));
      row.append(Object.assign(document.createElement("small"), { textContent: evidence.summary }));
      const sourceLink = drawerDocLink(evidence.sourceUrl, evidence.sourceLabel ? `查看来源：${evidence.sourceLabel}` : "查看数据来源");
      const geometryLink = drawerDocLink(evidence.geometrySourceUrl, "查看覆盖几何来源");
      const coverageLink = drawerDocLink(evidence.coverageUrl, "查看发布覆盖 MOC");
      if (sourceLink) row.append(sourceLink);
      if (geometryLink && evidence.geometrySourceUrl !== evidence.sourceUrl) row.append(geometryLink);
      if (coverageLink) row.append(coverageLink);
      list.append(row);
    });
    supporting.append(list);
  }
  if (displayFiles.length) {
    const filesHeading = document.createElement("strong");
    filesHeading.textContent = "未归入空间分块的文件命中 · coverage matches";
    supporting.append(filesHeading);
    const list = document.createElement("div");
    list.className = "overlap-evidence-files";
    displayFiles.forEach((file) => {
      const row = document.createElement("div");
      row.className = "overlap-evidence-file";
      const title = document.createElement("strong");
      title.textContent = `${file.unitId ? `${file.unitKind?.toUpperCase() ?? "UNIT"} ${file.unitId} · ` : ""}${file.fileName ?? file.fileId}`;
      row.append(title);
      const matchSummary = document.createElement("small");
      const size = file.sizeBytes === undefined ? "size unknown" : bytes(file.sizeBytes);
      matchSummary.textContent = `${file.matchingCoverage.length} coverage match${file.matchingCoverage.length === 1 ? "" : "es"} · ${joinUnique(file.matchingCoverage.map((match) => match.layerId)) || "layer unknown"} · ${joinUnique(file.matchingCoverage.map((match) => `O${match.order}:${match.ipix}`))} · ${size}${file.downloadProvider ? ` · ${file.downloadProvider}` : ""}`;
      row.append(matchSummary);
      const storedOrders = [...new Set(file.matchingCoverage.flatMap(match => match.sourceOrder !== undefined && match.sourceOrder !== match.order ? [match.sourceOrder] : []))];
      if (storedOrders.length) row.append(Object.assign(document.createElement("small"), {
        textContent: `${locale() === "zh" ? "原始扫描像元" : "Original scanned cells"}: ${storedOrders.map(order => `O${order}`).join(", ")}`,
      }));
      const runs = [...new Set(file.matchingCoverage.flatMap(match => match.scanRunId ? [match.scanRunId] : []))];
      if (runs.length && !file.observations?.length) {
        const scans = document.createElement("details");
        scans.append(Object.assign(document.createElement("summary"), { textContent: locale() === "zh" ? "扫描依据与文件记录" : "Scan evidence and file records" }));
        scans.append(Object.assign(document.createElement("small"), { textContent: `SCAN RUN ${runs.join(" · ")}` }));
        const hashes = [...new Set(file.matchingCoverage.flatMap(match => match.sourceSnapshotSha256 ? [match.sourceSnapshotSha256] : []))];
        for (const hash of hashes) scans.append(Object.assign(document.createElement("code"), { textContent: `SNAPSHOT SHA-256 ${hash}` }));
        row.append(scans);
      }
      if (file.matchingCoverageTruncated) row.append(Object.assign(document.createElement("small"), {
        textContent: "此文件仅展示部分覆盖匹配；文件清单加载完毕不代表已列出全部匹配区块。",
      }));
      if (file.observations?.length) {
        const details = document.createElement("details");
        const label = document.createElement("summary");
        label.textContent = "扫描依据与文件记录";
        details.append(label);
        for (const observation of file.observations) {
          const note = document.createElement("small");
          note.textContent = `${observation.scanRunId ?? "扫描标识未知"} · ${observation.fileName ?? file.fileId} · ${observation.sizeBytes === undefined ? "大小未知" : bytes(observation.sizeBytes)} · ${observation.metadataState === "missing" ? "文件元数据缺失" : "已保留文件记录"}`;
          note.title = `输入快照 SHA-256: ${observation.sourceSnapshotSha256 ?? "未知"}`;
          details.append(note);
          if (observation.sourceUri && observation.sourceUri !== file.sourceUri) appendSourceLocator(details, observation.sourceUri);
        }
        row.append(details);
      }
      if (file.metadataState === "missing") row.append(Object.assign(document.createElement("small"), { textContent: "FileAsset metadata missing; not verified as a complete file record" }));
      let hasLocation = false;
      if (file.downloadUrl) {
        const link = drawerExternalLink(file.downloadUrl, file.downloadProvider ? `${file.downloadProvider} · official file download` : file.downloadUrl);
        if (link) {
          link.title = file.downloadProvider ? `${file.downloadProvider} official file download` : t("coverage.downloadOfficial");
          row.append(link);
          hasLocation = true;
        }
      }
      if (file.sourceUri) {
        appendScannedFileSource(row, file, { fileName: false, provenance: false });
        hasLocation = true;
      }
      if (!hasLocation) {
        row.append(Object.assign(document.createElement("small"), { textContent: "没有公开文件下载地址" }));
      }
      list.append(row);
    });
    supporting.append(list);
  }
  if (!result.preview && plan.tileSelections?.length) {
    const selectionHeading = document.createElement("strong");
    selectionHeading.textContent = "REQUIRED TILE SETS";
    supporting.append(selectionHeading);
    const selectionList = document.createElement("div");
    selectionList.className = "overlap-evidence-files";
    plan.tileSelections.forEach((selection) => {
      const row = document.createElement("div");
      row.className = "overlap-evidence-file";
      const title = document.createElement("strong");
      title.textContent = `${selection.product ?? selection.layerId} · ${selection.tileIds.length} Tile${selection.tileIds.length === 1 ? "" : "s"}`;
      row.append(title);
      row.append(Object.assign(document.createElement("small"), { textContent: `${selection.complete ? "完整集合" : "结果被截断，只是部分集合"} · ${selection.tileIds.join(", ") || "没有匹配 Tile"}` }));
      row.append(Object.assign(document.createElement("small"), { textContent: selection.note }));
      selectionList.append(row);
    });
    supporting.append(selectionList);
  }
  if (displayEntrypoints.length) {
    const heading = document.createElement("strong");
    heading.textContent = `官方数据入口 · ${displayEntrypoints.length}`;
    supporting.append(heading);
    const list = document.createElement("div");
    list.className = "overlap-evidence-files";
    displayEntrypoints.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "overlap-evidence-file";
      row.append(Object.assign(document.createElement("strong"), { textContent: `${reverseEntrypointLabel(entry)} · ${entry.product ?? entry.productId ?? entry.layerId ?? "entrypoint"}` }));
      if (entry.order !== undefined) {
        const entryPrecision = document.createElement("div");
        entryPrecision.className = "overlap-coverage-precision";
        entryPrecision.append(
          Object.assign(document.createElement("small"), { textContent: `O${entry.order} · ${(entry.cells ?? []).length} cells` }),
          precisionIndicator(entry.precision),
        );
        row.append(entryPrecision);
      }
      if (entry.note) row.append(Object.assign(document.createElement("small"), { textContent: entry.note }));
      if (entry.sourceUri && entry.kind !== "coverage-source") appendSourceLocator(row, entry.sourceUri);
      const entryUrl = entry.url ?? entry.sourceUrl ?? entry.mocUrl;
      const tileId = typeof entry.tileId === "string" ? entry.tileId : undefined;
      const entryLabel = entry.kind === "tile-directory" && tileId
        ? `TILE ${tileId}`
        : reverseEntrypointLabel(entry);
      const entryLink = drawerDocLink(entryUrl, entryLabel);
      if (entryLink) row.append(entryLink);
      list.append(row);
    });
    supporting.append(list);
  }
  if (result.notes?.length) {
    const notes = document.createElement("small");
    notes.className = "overlap-evidence-note";
    notes.textContent = [...new Set(result.notes)].join(" · ");
    supporting.append(notes);
  }
  if (plan.warnings.length) {
    const warning = document.createElement("small");
    warning.textContent = plan.warnings.join(" · ");
    warning.className = "overlap-evidence-warning";
    supporting.append(warning);
  }
  if (supportingHasMore && component) {
    const loadMore = document.createElement("button");
    loadMore.type = "button";
    loadMore.className = "command-button overlap-evidence-more-button";
    loadMore.append(icon("list-filter"), document.createTextNode("继续加载辅助信息"));
    loadMore.addEventListener("click", async () => {
      loadMore.disabled = true;
      loadMore.replaceChildren(icon("rotate-ccw"), document.createTextNode("正在加载…"));
      renderIcons();
      try {
        if (!await ensureDownloadAccess()) {
          loadMore.disabled = false;
          loadMore.replaceChildren(icon("list-filter"), document.createTextNode("继续加载辅助信息"));
          renderIcons();
          return;
        }
        const next = await fetchOverlapEvidence(component, undefined, "page", { cursor: result.supportingPage?.nextCursor, pageSize: 30, pageKind: "supporting-evidence" });
        if (next) renderEvidencePlan(node, mergeOverlapEvidence(result, next), component);
      } catch (error) {
        loadMore.disabled = false;
        loadMore.replaceChildren(icon("list-filter"), document.createTextNode("继续加载辅助信息"));
        renderIcons();
        const failure = document.createElement("small");
        failure.className = "overlap-evidence-more-error";
        failure.textContent = `${t("coverage.reverseFailed")}: ${error instanceof Error ? error.message : ""}`;
        loadMore.insertAdjacentElement("afterend", failure);
      }
    });
    supporting.append(loadMore);
  }
  renderIcons();
}

const EVIDENCE_STAGE_LABEL: Record<string, string> = { native: "coverage.progressNative", warehouse: "coverage.progressWarehouse", coverage: "coverage.progressCoverage" };

/** Animated query status. The denominator is fixed up front (one item per layer
 * plus coverage and scan evidence) so the counter only ever moves forward; a
 * region split into batches reports the batch actually being queried. */
function evidenceProgress(layerIds: readonly string[]): { root: HTMLElement; event: (value: Record<string, unknown>) => void; setBlocks: (count: number) => void } {
  const root = document.createElement("div");
  root.className = "hud-query-progress";
  root.setAttribute("role", "status");
  const head = document.createElement("div");
  head.className = "hud-query-head";
  const spinner = Object.assign(document.createElement("i"), { className: "hud-query-spinner" });
  spinner.setAttribute("aria-hidden", "true");
  const state = document.createElement("b");
  state.textContent = locale() === "zh" ? "查询中" : "QUERYING";
  const counter = document.createElement("span");
  const elapsed = Object.assign(document.createElement("time"), { className: "hud-query-elapsed", textContent: "0s" });
  const blocks = document.createElement("em");
  head.append(spinner, state, counter, elapsed, blocks);
  const hint = Object.assign(document.createElement("small"), { className: "hud-query-hint" });
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    if (!root.isConnected && Date.now() - startedAt > 1000) { window.clearInterval(timer); return; }
    elapsed.textContent = `${Math.floor((Date.now() - startedAt) / 1000)}s`;
  }, 1000);
  const bar = Object.assign(document.createElement("i"), { className: "hud-query-bar" });
  bar.setAttribute("aria-hidden", "true");
  const lines = Object.assign(document.createElement("small"), { className: "hud-query-stages", textContent: t("coverage.queryingPlan") });
  root.append(head, bar, lines, hint);
  const zh = locale() === "zh";
  const pending = () => new Map<string, { stage: string; done: boolean; total?: number }>([
    ["coverage", { stage: "coverage", done: false }], ["warehouse", { stage: "warehouse", done: false }],
    ...layerIds.map((id): [string, { stage: string; done: boolean; total?: number }] => [id, { stage: "native", done: false }]),
  ]);
  let items = pending();
  let batch: { index: number; count: number } | undefined;
  const render = () => {
    const entries = [...items.values()];
    const done = entries.filter((entry) => entry.done).length;
    counter.textContent = batch && batch.count > 1
      ? `${zh ? "批次" : "BATCH"} ${batch.index + 1} / ${batch.count}`
      : `${done} / ${entries.length} ${zh ? "项" : "ITEMS"}`;
    const byStage = new Map<string, { done: number; all: number }>();
    entries.forEach((entry) => {
      const value = byStage.get(entry.stage) ?? { done: 0, all: 0 };
      value.all += 1; if (entry.done) value.done += 1;
      byStage.set(entry.stage, value);
    });
    lines.textContent = [...byStage].map(([stage, value]) => `${t(EVIDENCE_STAGE_LABEL[stage] ?? "coverage.progressQuery")} ${value.done === value.all ? "✓" : `${value.done}/${value.all}`}`).join(" · ");
    hint.textContent = batch && batch.count > 1
      ? (zh ? `所选区域较大，已分 ${batch.count} 批查询；先返回前几页，其余在继续加载时查询。` : `This region is split into ${batch.count} batches; the first pages return first and the rest load on demand.`)
      : "";
    root.title = [...items].map(([key, entry]) => `${key}: ${entry.done ? t("coverage.progressDone") : t("coverage.progressRunning")}${entry.total === undefined ? "" : ` ${entry.total}`}`).join("\n");
  };
  render();
  return {
    root,
    event(value) {
      const stage = String(value.stage);
      if (stage === "batch") {
        const index = Number(value.index), count = Number(value.count);
        if (Number.isFinite(index) && Number.isFinite(count)) {
          if (!batch || batch.index !== index) items = pending();
          batch = { index, count };
        }
      } else {
        const key = stage === "native" ? String(value.layerId ?? "") : stage;
        const item = items.get(key);
        if (item) { item.done = value.state === "completed"; if (typeof value.total === "number") item.total = value.total; }
      }
      render();
    },
    setBlocks(count) { blocks.textContent = `${count.toLocaleString("en-US")} ${zh ? "个分块已返回" : "BLOCKS RECEIVED"}`; },
  };
}

async function loadOverlapEvidence(component: OverlapComponentView, node: HTMLElement): Promise<void> {
  const lookup = component.evidenceLookup;
  if (!lookup) return;
  if (reverseLookupRegionTooLarge(component)) {
    node.replaceChildren(Object.assign(document.createElement("small"), { textContent: t("coverage.overlapRegionTooLarge") }));
    return;
  }
  overlapEvidenceController?.abort();
  const request = ++overlapEvidenceSequence;
  const access = hasDownloadAccess() ? "page" : "preview";
  const cached = cachedOverlapEvidence(component, access);
  if (cached) {
    // A cache hit is already complete: do not shrink the inspector to a skeleton
    // for an async turn before putting the same long list back.
    overlapEvidenceController = null;
    renderEvidencePlan(node, cached, component);
    return;
  }
  const cooling = overlapEvidenceCooldown.get(overlapEvidenceKey(component));
  if (cooling && cooling.until > Date.now()) {
    node.dataset.lookupState = "retry";
    node.replaceChildren(Object.assign(document.createElement("small"), { textContent: `${t("coverage.reverseFailed")}: ${cooling.message}` }));
    return;
  }
  const controller = new AbortController();
  overlapEvidenceController = controller;
  overlapEvidenceLoads.set(node, controller);
  node.dataset.lookupState = "loading";
  try {
    const progress = evidenceProgress(lookup.layerIds);
    const batches = document.createElement("div"); batches.className = "overlap-evidence-files overlap-spatial-units";
    for (let index = 0; index < 3; index += 1) batches.append(Object.assign(document.createElement("div"), { className: "hud-skeleton-row" }));
    const shown = new Set<string>();
    node.replaceChildren(progress.root, batches);
    await new Promise<void>((resolve) => setTimeout(resolve, OVERLAP_EVIDENCE_DEBOUNCE_MS));
    // A newer render superseded this one before it sent anything.
    if (controller.signal.aborted || request !== overlapEvidenceSequence) return;
    const previewSnapshot = access === "page" ? overlapEvidenceCache.get(overlapEvidenceKey(component))?.querySnapshot?.id : undefined;
    const result = await fetchOverlapEvidence(component, controller.signal, access, previewSnapshot ? { querySnapshotId: previewSnapshot } : undefined, event => {
      if (request !== overlapEvidenceSequence || controller.signal.aborted) return;
      const value = event.value;
      if (event.event === "progress") {
        progress.event(value);
      } else if (event.event === "batch" && Array.isArray(value.units)) {
        for (const unit of value.units as NonNullable<DownloadPlan["spatialUnits"]>) {
          const key = JSON.stringify([unit.layerId, unit.unitKind, unit.unitId]);
          if (shown.has(key) || shown.size >= 200) continue;
          shown.add(key);
          const row = document.createElement("div"); row.className = "overlap-evidence-file overlap-spatial-unit";
          row.append(Object.assign(document.createElement("small"), { className: "overlap-spatial-unit-source", textContent: `${unit.surveyId} · ${unit.releaseId} · ${unit.product}` }),
            Object.assign(document.createElement("strong"), { className: "overlap-spatial-unit-title", textContent: `${unit.unitKind.toUpperCase()} ${unit.unitId}` }));
          const facts = document.createElement("div"); facts.className = "overlap-spatial-unit-facts";
          facts.append(modalityBadge(unit.modality, "overlap-spatial-unit-modality"), document.createTextNode(` ${spatialUnitMatchLabel(unit)} `), precisionIndicator(unit.precision)); row.append(facts);
          appendSpatialUnitAccess(row, unit);
          batches.querySelectorAll(".hud-skeleton-row").forEach((skeleton) => skeleton.remove());
          batches.append(row);
        }
        progress.setBlocks(shown.size);
        progress.root.title = `${progress.root.title.split("\n\n")[0]}\n\n${t("coverage.progressFrozenPending")}`; renderIcons();
      }
    });
    if (!result) return;
    if (request === overlapEvidenceSequence && !controller.signal.aborted) renderEvidencePlan(node, result, component);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const message = error instanceof Error ? error.message : "";
    const retryAfter = (error as { retryAfter?: number }).retryAfter ?? 30;
    overlapEvidenceCooldown.set(overlapEvidenceKey(component), { until: Date.now() + retryAfter * 1000, message });
    if (request === overlapEvidenceSequence) node.replaceChildren(Object.assign(document.createElement("small"), { textContent: `${t("coverage.reverseFailed")}: ${message}` }));
  } finally {
    if (overlapEvidenceLoads.get(node) === controller) {
      overlapEvidenceLoads.delete(node);
      if (node.dataset.lookupState === "loading") node.dataset.lookupState = "retry";
    }
    if (overlapEvidenceController === controller) overlapEvidenceController = null;
  }
}

function renderOverlapComponent(component: OverlapComponentView, surveyIds: string[], content: HTMLElement): void {
  overlapEvidenceController?.abort();
  abortHstLookupsWithin(content);
  content.querySelectorAll(".overlap-component-detail, .overlap-products, .overlap-result-actions, .overlap-evidence-plan, .hst-image-lookup-region, .hst-image-lookup-results").forEach((node) => node.remove());
  const detail = document.createElement("div");
  detail.className = "overlap-component-detail";
  const bounds = component.bounds;
  detail.textContent = `${component.id} · ${component.cells.length.toLocaleString("en-US")} cells · ${bounds.areaDeg2.toFixed(2)} deg² · RA ${bounds.raMin.toFixed(2)}°${bounds.raWraps ? "↷" : "–"}${bounds.raMax.toFixed(2)}° · DEC ${bounds.decMin.toFixed(2)}°–${bounds.decMax.toFixed(2)}°`;
  content.append(detail);
  const entries: OverlapSurveyView[] = component.surveys ?? surveyIds.flatMap((surveyId): OverlapSurveyView[] => {
    const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
    return survey?.releases.flatMap((release) => release.products.filter((product) => product.coverage).map((product) => ({ surveyId, releaseId: release.id, product: product.name, modality: product.modality, downloadUrl: product.sourceUrl }))) ?? [];
  });
  const products = document.createElement("details");
  products.className = "overlap-products";
  products.open = true;
  const productsSummary = document.createElement("summary");
  productsSummary.textContent = `${t("coverage.overlapProducts")} · ${entries.length}`;
  products.append(productsSummary);
  const productsList = document.createElement("div");
  productsList.className = "overlap-products-list";
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "coverage-detail-product";
    const survey = surveyIndex?.surveys.find((candidate) => candidate.id === entry.surveyId);
    const modality = entry.modality?.trim() ?? "";
    const modalityName = modality ? modalityLabel(modality) : "未指定模态";
    const modalityIcon = document.createElement("span");
    modalityIcon.className = "coverage-detail-product-modality";
    modalityIcon.title = `模态：${modalityName}`;
    modalityIcon.setAttribute("aria-label", `模态：${modalityName}`);
    modalityIcon.append(icon(modalityIconName(modality || "unknown")));
    const title = document.createElement("span");
    title.className = "coverage-detail-product-title";
    title.title = `${survey?.name ?? entry.surveyId} · ${entry.releaseId} · ${entry.product} · ${modalityName}`;
    title.append(
      Object.assign(document.createElement("b"), { className: "coverage-detail-product-survey", textContent: survey?.name ?? entry.surveyId }),
      Object.assign(document.createElement("span"), { className: "coverage-detail-product-sub", textContent: `${entry.releaseId} · ${entry.product}` }),
    );
    row.style.setProperty("--product-color", surveyColorFor(entry.surveyId, survey?.color));
    row.append(modalityIcon, title);
    if (entry.sourceUnitIndex) row.append(Object.assign(document.createElement("small"), { textContent: `${entry.sourceUnitIndex.status.toUpperCase()}: ${entry.sourceUnitIndex.notes}` }));
    if (entry.sourceUnitIndex?.unitKind === "tile" && !entry.sourceUnits) {
      row.append(Object.assign(document.createElement("small"), { textContent: t("coverage.tileLookupUnavailable") }));
    }
    if (entry.sourceUnits?.unitKind === "tile") {
      const tilePlan = document.createElement("section");
      tilePlan.className = "overlap-tile-plan";
      const tileHeading = document.createElement("div");
      tileHeading.className = "overlap-tile-heading";
      const tileTitle = document.createElement("strong");
      tileTitle.textContent = `${t("coverage.tileMatches")} · ${entry.sourceUnits.totalUnits}`;
      const tileStatus = document.createElement("small");
      tileStatus.textContent = entry.sourceUnits.truncated ? t("coverage.tileFirstResults") : t("coverage.tileExact");
      tileHeading.append(tileTitle, tileStatus);
      tilePlan.append(tileHeading);
      if (!entry.sourceUnits.units.length) {
        tilePlan.append(Object.assign(document.createElement("small"), { className: "overlap-tile-empty", textContent: t("coverage.tileNoMatches") }));
      } else {
        const tileList = document.createElement("div");
        tileList.className = "overlap-tile-list";
        entry.sourceUnits.units.forEach((unit) => {
          const tileRow = document.createElement("div");
          tileRow.className = "overlap-tile-row";
          const tileCopy = document.createElement("div");
          tileCopy.className = "overlap-tile-copy";
          const link = document.createElement("a");
          link.className = "overlap-tile-link";
          const unitUrl = publicExternalUrl(unit.downloadUrl);
          if (!unitUrl) return;
          link.href = unitUrl;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = `TILE ${unit.unitId}`;
          link.title = `TILE ${unit.unitId} · NEXP ${unit.exposureCount} · LASTNIGHT ${unit.lastNight}`;
          const metadata = document.createElement("small");
          metadata.textContent = `NEXP ${unit.exposureCount} · LASTNIGHT ${unit.lastNight}`;
          tileCopy.append(link, metadata);
          tileRow.append(tileCopy);
          tileList.append(tileRow);
        });
        tilePlan.append(tileList);
      }
      row.append(tilePlan);
    }
    const entryUrl = publicExternalUrl(entry.downloadUrl);
    if (entryUrl) { const link = document.createElement("a"); link.href = entryUrl; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = t("coverage.releaseEntry"); row.append(link); }
    productsList.append(row);
  });
  if (!entries.length) productsList.append(Object.assign(document.createElement("p"), { className: "overlap-empty", textContent: t("coverage.noProducts") }));
  products.append(productsList);
  content.append(products);
  const list = document.createElement("div");
  list.className = "overlap-result-actions";
  const downloads = document.createElement("div");
  downloads.className = "overlap-download-actions";
  const currentDownload = document.createElement("button");
  currentDownload.type = "button";
  currentDownload.className = "command-button overlap-download-button";
  currentDownload.append(icon("lock"), document.createTextNode(t("coverage.downloadCurrent")));
  currentDownload.addEventListener("click", () => void downloadOverlapCsv([component], `atlas-overlap-${component.id}-download-plan.csv`, currentDownload));
  downloads.append(currentDownload);
  const currentJson = document.createElement("button");
  currentJson.type = "button";
  currentJson.className = "command-button overlap-download-button";
  currentJson.append(icon("lock"), document.createTextNode(t("coverage.downloadJson")));
  currentJson.addEventListener("click", () => void downloadOverlapJson([component], `atlas-overlap-${component.id}-download-plan.json`, currentJson));
  downloads.append(currentJson);
  if (activeOverlapComponents.length > 1) {
    const allDownload = document.createElement("button");
    allDownload.type = "button";
    allDownload.className = "command-button overlap-download-button";
    allDownload.append(icon("lock"), document.createTextNode(t("coverage.downloadAll")));
    allDownload.addEventListener("click", () => void downloadOverlapCsv(activeOverlapComponents, "atlas-overlap-all-download-plan.csv", allDownload));
    downloads.append(allDownload);
    const allJson = document.createElement("button");
    allJson.type = "button";
    allJson.className = "command-button overlap-download-button";
    allJson.append(icon("lock"), document.createTextNode(t("coverage.downloadJson")));
    allJson.addEventListener("click", () => void downloadOverlapJson(activeOverlapComponents, "atlas-overlap-all-download-plan.json", allJson));
    downloads.append(allJson);
  }
  if (component.evidenceLookup) {
    const evidence = document.createElement("div");
    evidence.className = "overlap-evidence-plan";
    evidence.append(Object.assign(document.createElement("small"), { textContent: t("coverage.queryingPlan") }));
    list.append(evidence);
    void loadOverlapEvidence(component, evidence);
  }
  list.append(downloads);
  content.append(list);
  renderIcons();
}

function setOverlapExpandVisible(visible: boolean): void {
  const button = byId<HTMLButtonElement>("overlap-expand");
  button.hidden = !visible;
}

function overlapDetailsCacheKey(component: OverlapComponentView): string {
  return `${activeOverlapSurveyIds.slice().sort().join(",")}:${activeOverlapLayerIds.join(",")}:${activeOverlapViewTiles?.tiles.join(",")}:${activeOverlapModalities.slice().sort().join(",")}:${component.id}:${component.order}:${component.cells.length}:${component.cells[0] ?? ""}:${component.cells[component.cells.length - 1] ?? ""}`;
}

async function fetchOverlapDetails(component: OverlapComponentView): Promise<OverlapDetailsResponse> {
  const key = overlapDetailsCacheKey(component);
  const cached = overlapDetailsCache.get(key);
  if (cached) return cached;
  const pending = overlapDetailsInflight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const response = await fetch("/api/v1/coverage/overlap/details", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ surveyIds: activeOverlapSurveyIds, layerIds: activeOverlapLayerIds, viewTiles: activeOverlapViewTiles, modalities: activeOverlapModalities, componentId: component.id, requestedOrder: component.order, strictOrder: true }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const retryAfter = Math.min(60, Math.max(1, Number(response.headers.get("Retry-After")) || 30));
      throw Object.assign(new Error(`overlap details HTTP ${response.status}`), { status: response.status, retryAfter });
    }
    const details = await response.json() as OverlapDetailsResponse;
    overlapDetailsCache.set(key, details);
    return details;
  })().finally(() => overlapDetailsInflight.delete(key));
  overlapDetailsInflight.set(key, request);
  return request;
}

function drawerSection(title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "overlap-drawer-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function drawerText(value: unknown, fallback = "--"): string {
  return typeof value === "string" && value.length ? value : fallback;
}

function drawerExternalLink(url: unknown, label: string): HTMLAnchorElement | null {
  const href = publicExternalUrl(url);
  if (!href) return null;
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

function drawerDocLink(url: unknown, label: string): HTMLAnchorElement | null {
  if (typeof url !== "string" || !url.trim()) return null;
  if (url.startsWith("/") && !url.startsWith("//")) {
    const link = document.createElement("a");
    link.href = url;
    link.textContent = label;
    return link;
  }
  return drawerExternalLink(url, label);
}

function reverseEntrypointLabel(entry: DownloadPlanEntrypoint): string {
  switch (entry.kind) {
    case "tile-directory": return "Tile 数据目录";
    case "official-release": return "公开发布页";
    case "official-data": return "官方数据入口";
    case "official-query": return "官方查询入口";
    case "coverage-source": return "覆盖 MOC / 边界来源";
    case "coverage-moc": return "Assets MOC";
    case "source-path": return "来源定位符";
    default: return entry.kind;
  }
}

function modalitiesForComponent(component: OverlapComponentView): string[] {
  const modalities = new Set((component.surveys ?? [])
    .map((survey) => canonicalModality(survey.modality))
    .filter((modality) => Boolean(modality) && modality !== "coverage"));
  if (!modalities.size && component.evidenceLookup?.layerIds.length && coverageCatalog) {
    const layerIds = new Set(component.evidenceLookup.layerIds);
    coverageCatalog.layers.forEach((layer) => {
      if (!layerIds.has(layer.layerId)) return;
      const modality = canonicalModality(layer.modality);
      if (modality && modality !== "coverage") modalities.add(modality);
    });
  }
  const modalityOrder = Object.keys(modalityLabels);
  return [...modalities].sort((left, right) => {
    const leftOrder = modalityOrder.indexOf(left);
    const rightOrder = modalityOrder.indexOf(right);
    return (leftOrder < 0 ? modalityOrder.length : leftOrder) - (rightOrder < 0 ? modalityOrder.length : rightOrder)
      || left.localeCompare(right);
  });
}

function componentModalityIcon(modality?: string): HTMLSpanElement {
  const normalized = canonicalModality(modality);
  const label = normalized && normalized !== "coverage"
    ? modalityLabel(normalized)
    : locale() === "zh" ? "模态未指定" : "Modality unspecified";
  const item = document.createElement("span");
  item.className = "overlap-drawer-component-modality";
  item.dataset.modality = normalized && normalized !== "coverage" ? normalized : "unknown";
  item.title = label;
  item.setAttribute("role", "img");
  item.setAttribute("aria-label", label);
  item.append(icon(modalityIconName(normalized || "unknown")));
  return item;
}

function renderOverlapDrawerComponents(): void {
  const host = byId("overlap-drawer-components");
  host.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = t("coverage.connectedRegions");
  host.append(heading);
  const pageCount = Math.max(1, Math.ceil(activeOverlapComponents.length / OVERLAP_COMPONENT_PAGE_SIZE));
  overlapDrawerComponentsPage = Math.min(overlapDrawerComponentsPage, pageCount - 1);
  const visible = activeOverlapComponents.slice(overlapDrawerComponentsPage * OVERLAP_COMPONENT_PAGE_SIZE, (overlapDrawerComponentsPage + 1) * OVERLAP_COMPONENT_PAGE_SIZE);
  const list = document.createElement("div");
  list.className = "overlap-drawer-component-list";
  visible.forEach((component) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `overlap-drawer-component-button${selectedQueueComponent?.id === component.id ? " is-active" : ""}`;
    button.setAttribute("aria-pressed", String(selectedQueueComponent?.id === component.id));
    const id = document.createElement("span");
    id.textContent = component.id;
    const summary = document.createElement("small");
    summary.textContent = `O${component.order} · ${component.cells.length.toLocaleString("en-US")} cells`;
    const modalities = modalitiesForComponent(component);
    const modalityIcons = document.createElement("span");
    modalityIcons.className = "overlap-drawer-component-modalities";
    if (modalities.length) modalities.forEach((modality) => modalityIcons.append(componentModalityIcon(modality)));
    else modalityIcons.append(componentModalityIcon());
    const modalityNames = modalities.length
      ? modalities.map(modalityLabel).join(locale() === "zh" ? "、" : ", ")
      : locale() === "zh" ? "模态未指定" : "Modality unspecified";
    button.setAttribute("aria-label", locale() === "zh"
      ? `${component.id}，O${component.order}，${component.cells.length} 个像元，模态：${modalityNames}`
      : `${component.id}, order ${component.order}, ${component.cells.length} cells, modalities: ${modalityNames}`);
    button.append(id, summary, modalityIcons);
    button.addEventListener("click", () => selectOverlapDrawerComponent(component));
    list.append(button);
  });
  host.append(list);
  const pageControls = componentPageControls(activeOverlapComponents.length, overlapDrawerComponentsPage, (page) => {
    overlapDrawerComponentsPage = page;
    const first = activeOverlapComponents[page * OVERLAP_COMPONENT_PAGE_SIZE];
    if (first) selectOverlapDrawerComponent(first);
  }, "drawer");
  if (pageControls) host.append(pageControls);
  renderIcons();
}

/** Name the intersecting surveys under the drawer title, each in its own colour. */
function renderOverlapDrawerSurveys(component?: Pick<OverlapComponentView, "surveys">): void {
  const host = document.getElementById("overlap-drawer-surveys");
  if (!host) return;
  const ids = [...new Set([...(component?.surveys?.map((survey) => survey.surveyId) ?? []), ...activeOverlapSurveyIds])]
    .filter((id) => !component?.surveys?.length || component.surveys.some((survey) => survey.surveyId === id));
  const nodes: Array<Node | string> = [];
  ids.forEach((id, index) => {
    const survey = surveyIndex?.surveys.find((entry) => entry.id === id);
    if (index) nodes.push(Object.assign(document.createElement("i"), { textContent: "×", ariaHidden: "true" }));
    const name = document.createElement("b");
    name.textContent = (survey?.name ?? id).toUpperCase();
    name.style.setProperty("--c", surveyColorFor(id, survey?.color));
    nodes.push(name);
  });
  host.replaceChildren(...nodes);
  host.hidden = !ids.length;
  host.setAttribute("aria-label", ids.map((id) => surveyIndex?.surveys.find((entry) => entry.id === id)?.name ?? id).join(" × "));
}

function renderOverlapDrawerLoading(component: OverlapComponentView): void {
  const drawer = byId("overlap-drawer");
  byId("overlap-drawer-title").textContent = `${component.id} · O${component.order}`;
  renderOverlapDrawerSurveys(component);
  const content = byId("overlap-drawer-content");
  abortHstLookupsWithin(content);
  const loading = document.createElement("div");
  loading.className = "overlap-drawer-loading";
  const spinner = document.createElement("span");
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.textContent = t("coverage.queryingPlan");
  loading.append(spinner, label);
  content.replaceChildren(loading);
  drawer.setAttribute("aria-busy", "true");
}

function renderOverlapDrawerError(message: string): void {
  byId("overlap-drawer").removeAttribute("aria-busy");
  const content = byId("overlap-drawer-content");
  abortHstLookupsWithin(content);
  const error = document.createElement("p");
  error.className = "overlap-drawer-error";
  error.textContent = message;
  content.replaceChildren(error);
}

function renderOverlapDrawerResponse(details: OverlapDetailsResponse): void {
  const drawer = byId("overlap-drawer");
  if (overlapDrawerOpen) syncOverlapHudTarget(details.component);
  drawer.removeAttribute("aria-busy");
  const component: OverlapComponentView = { ...details.component, evidenceLookup: details.reverseLookup };
  byId("overlap-drawer-title").textContent = `${component.id} · O${component.order} · ${component.cells.length.toLocaleString("en-US")} cells`;
  renderOverlapDrawerSurveys(component);
  const content = byId("overlap-drawer-content");
  abortHstLookupsWithin(content);
  content.replaceChildren();

  const geometry = drawerSection("REGION");
  const geometrySummary = document.createElement("p");
  geometrySummary.className = "overlap-drawer-summary";
  geometrySummary.textContent = `${component.id} · O${component.order} · NSIDE ${2 ** component.order} · ${component.cells.length.toLocaleString("en-US")} cells · ${component.bounds.areaDeg2.toFixed(2)} deg²`;
  const geometryGrid = document.createElement("dl");
  geometryGrid.className = "overlap-drawer-grid";
  const geometryRows: Array<[string, string]> = [
    ["RA", `${component.bounds.raMin.toFixed(4)}°${component.bounds.raWraps ? " ↷ " : " – "}${component.bounds.raMax.toFixed(4)}°`],
    ["DEC", `${component.bounds.decMin.toFixed(4)}° – ${component.bounds.decMax.toFixed(4)}°`],
    ["CELLS", component.cells.length.toLocaleString("en-US")],
    ["AREA", `${component.bounds.areaDeg2.toFixed(3)} deg²`],
  ];
  geometryRows.forEach(([label, value]) => {
    const cell = document.createElement("div");
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    cell.append(dt, dd); geometryGrid.append(cell);
  });
  geometry.append(geometrySummary, geometryGrid);
  content.append(geometry);

  const resultsSection = drawerSection("匹配的空间分块");
  resultsSection.classList.add("overlap-drawer-results");
  const evidence = document.createElement("div");
  evidence.className = "overlap-evidence-plan";
  resultsSection.append(evidence);
  content.append(resultsSection);

  const publicSection = drawerSection(t("coverage.publicSources"));
  const publicList = document.createElement("div");
  publicList.className = "overlap-public-surveys";
  if (!details.publicSources.length) {
    const empty = document.createElement("p"); empty.className = "overlap-drawer-copy"; empty.textContent = t("coverage.publicUnavailable"); publicList.append(empty);
  } else {
    const sourcesBySurvey = new Map<string, typeof details.publicSources>();
    details.publicSources.forEach((source) => {
      const group = sourcesBySurvey.get(source.surveyId) ?? [];
      group.push(source);
      sourcesBySurvey.set(source.surveyId, group);
    });
    for (const [surveyId, sources] of sourcesBySurvey) {
      const first = sources[0]!;
      const sourceColor = surveyColorFor(surveyId, first.surveyColor);
      const group = document.createElement("details");
      group.className = "overlap-public-survey";
      const summary = document.createElement("summary");
      summary.className = "overlap-public-survey-summary";
      const swatch = document.createElement("span");
      swatch.className = "overlap-source-swatch";
      swatch.style.backgroundColor = sourceColor;
      swatch.title = `${drawerText(first.surveyName, surveyId)} 图例颜色 ${sourceColor}`;
      swatch.setAttribute("aria-label", `${drawerText(first.surveyName, surveyId)} 图例颜色 ${sourceColor}`);
      const surveyName = document.createElement("strong");
      surveyName.textContent = drawerText(first.surveyName, surveyId);
      const productCount = document.createElement("small");
      productCount.textContent = `${sources.length.toLocaleString("en-US")} ${locale() === "zh" ? "个来源产品" : "products"}`;
      const modalities = [...new Set(sources.map((source) => source.modality ?? ""))];
      const modalityIcons = document.createElement("span");
      modalityIcons.className = "overlap-public-survey-modalities";
      modalities.forEach((modality) => {
        const label = modality ? modalityLabel(modality) : locale() === "zh" ? "模态未指定" : "Modality unspecified";
        const modalityIcon = icon(modalityIconName(modality || "unknown"));
        modalityIcon.classList.add("overlap-public-survey-modality-icon");
        modalityIcon.title = modalityDescription(modality || undefined);
        modalityIcon.setAttribute("role", "img");
        modalityIcon.setAttribute("aria-label", label);
        modalityIcons.append(modalityIcon);
      });
      summary.append(swatch, surveyName, productCount, modalityIcons);
      group.append(summary);

      const products = document.createElement("div");
      products.className = "overlap-public-survey-products";
      sources.forEach((source) => {
        const card = document.createElement("article");
        card.className = "overlap-drawer-card is-public-source";
        card.style.setProperty("--source-color", sourceColor);
        const heading = document.createElement("div");
        heading.className = "overlap-source-heading";
        const title = document.createElement("strong");
        title.textContent = `${drawerText(source.releaseLabel ?? source.releaseId)} · ${drawerText(source.product)}`;
        heading.append(title);
        card.append(heading);

        const metadata = document.createElement("div");
        metadata.className = "overlap-public-source-metadata";
        metadata.append(modalityBadge(source.modality, "overlap-source-modality"));
        if (source.dataOrigin) metadata.append(Object.assign(document.createElement("small"), { textContent: source.dataOrigin }));
        metadata.append(Object.assign(document.createElement("small"), {
          textContent: source.coverageEvidence?.evidenceKind.toUpperCase() ?? source.coverageClaim?.kind?.toUpperCase() ?? "OVERVIEW",
        }));
        card.append(metadata);
        if (source.sourceLabel || source.sourceTier || source.geometrySourceLabel) {
          const provenance = document.createElement("small"); provenance.textContent = `${source.sourceLabel ?? "Source"}${source.sourceTier ? ` · ${source.sourceTier}` : ""}${source.geometrySourceLabel ? ` · ${source.geometrySourceLabel}` : ""}`; card.append(provenance);
        }
        if (source.coverageEvidence) {
          const evidence = source.coverageEvidence;
          const kindLabels: Record<string, string> = locale() === "zh"
            ? { "observation-footprint": "观测边界", "tile-footprint": "Tile 边界", "source-unit-footprint": "原生分块边界", "wcs-coverage": "文件 WCS 覆盖", "published-moc": "已收录 MOC" }
            : { "observation-footprint": "Observation footprint", "tile-footprint": "Tile footprint", "source-unit-footprint": "Native source-unit footprint", "wcs-coverage": "File WCS coverage", "published-moc": "Collected MOC" };
          const evidencePrecision = document.createElement("div");
          evidencePrecision.className = "overlap-public-source-evidence";
          evidencePrecision.append(
            Object.assign(document.createElement("small"), {
              textContent: `${kindLabels[evidence.evidenceKind] ?? evidence.evidenceKind} · ICRS/NESTED O${component.order}`,
            }),
            precisionIndicator(evidence.precision),
          );
          card.append(evidencePrecision);
          const identity = [evidence.sourceIdentity, evidence.instrument, evidence.filters].filter(Boolean).join(" · ");
          if (identity) card.append(Object.assign(document.createElement("small"), { textContent: identity }));
          const completenessLabels = locale() === "zh"
            ? { complete: "声明范围内已收录完整", incomplete: "当前收录范围不完整", unknown: "完整性未知" }
            : { complete: "Complete within the declared scope", incomplete: "Current coverage is incomplete", unknown: "Completeness unknown" };
          const scanLabels = locale() === "zh"
            ? { "not-scanned": "尚未扫描科学文件", partial: "仅扫描部分科学文件", complete: "已完成声明范围内的文件扫描" }
            : { "not-scanned": "Science files not scanned", partial: "Science files partially scanned", complete: "File scan complete within the declared scope" };
          const limits = [
            evidence.completeness ? completenessLabels[evidence.completeness] : "",
            evidence.scienceFileScan ? scanLabels[evidence.scienceFileScan] : "",
          ].filter(Boolean).join(" · ");
          if (limits) card.append(Object.assign(document.createElement("small"), { textContent: limits }));
          if (evidence.sourceSnapshotSha256) card.append(Object.assign(document.createElement("code"), {
            textContent: `source snapshot SHA-256 · ${evidence.sourceSnapshotSha256}`,
          }));
          if (evidence.summary) card.append(Object.assign(document.createElement("p"), {
            className: "overlap-drawer-copy", textContent: evidence.summary,
          }));
        }
        if (source.description) card.append(Object.assign(document.createElement("p"), { className: "overlap-drawer-copy", textContent: source.description }));
        const links = document.createElement("div"); links.className = "overlap-unit-links";
        const sourceLink = drawerExternalLink(source.sourceUrl, "公开发布 / 数据入口");
        if (sourceLink) {
          sourceLink.className = "overlap-source-link";
          sourceLink.title = "打开该巡天产品的公开发布或数据页面";
          links.append(sourceLink);
        }
        const geometryLink = drawerExternalLink(source.geometrySourceUrl ?? source.coverageClaim?.url, "覆盖 MOC / 边界来源");
        if (geometryLink) {
          geometryLink.className = "overlap-source-link";
          geometryLink.title = "打开用于核对覆盖范围的 MOC 或边界来源";
          links.append(geometryLink);
        }
        if (!links.childElementCount) links.append(Object.assign(document.createElement("small"), { textContent: "尚未登记可点击的公开 URL" }));
        card.append(links);
        if (source.sourceUnits) {
          const unitKind = source.sourceUnits.unitKind ?? "source unit";
          const unitLabel = unitKind.toUpperCase();
          const units = document.createElement("small"); units.textContent = `${unitLabel} · ${source.sourceUnits.totalUnits ?? source.sourceUnits.units?.length ?? 0}${source.sourceUnits.truncated ? " · truncated" : ""}`; card.append(units);
          source.sourceUnits.units?.slice(0, 12).forEach((unit) => {
            const unitLink = drawerExternalLink(unit.downloadUrl, `${unitLabel} ${unit.unitId}`);
            if (unitLink) {
              unitLink.title = unitKind === "tile"
                ? `TILE ${unit.unitId} · NEXP ${unit.exposureCount ?? "--"} · LASTNIGHT ${unit.lastNight ?? "--"}`
                : `${unitLabel} ${unit.unitId}`;
              links.append(unitLink);
            }
          });
        }
        products.append(card);
      });
      group.append(products);
      publicList.append(group);
    }
  }
  publicSection.append(publicList);
  content.append(publicSection);

  const assetsSection = document.createElement("details");
  assetsSection.className = "overlap-drawer-section overlap-assets-evidence";
  const artifactCount = details.assetsEvidence.reduce((count, entry) => count + entry.artifacts.length, 0);
  const assetsSummary = document.createElement("summary");
  assetsSummary.textContent = `覆盖计算依据 · ${details.assetsEvidence.length} 个产品 · ${artifactCount} 个索引制品`;
  assetsSection.append(assetsSummary);
  const assetsIntro = document.createElement("p");
  assetsIntro.className = "overlap-drawer-copy";
  assetsIntro.textContent = "这些是所列产品整层的 Atlas 覆盖制品，用于天球绘制、重合计算和版本核对；不会列出当前区域的 Tile 或科学文件。";
  assetsSection.append(assetsIntro);
  const assetsList = document.createElement("div"); assetsList.className = "overlap-drawer-list";
  details.assetsEvidence.forEach((entry) => {
    const card = document.createElement("article"); card.className = "overlap-drawer-card is-assets";
    const source = details.publicSources.find((candidate) => candidate.layerId === entry.layerId);
    const title = document.createElement("strong");
    title.textContent = `${source?.surveyName ?? entry.surveyId} · ${source?.releaseLabel ?? entry.releaseId} · ${entry.product} · ${entry.artifacts.length} 个制品`;
    card.append(title);
    entry.artifacts.forEach((artifact) => {
      const row = document.createElement("div"); row.className = "overlap-unit-links";
      const kindLabel = artifact.kind === "moc" ? "MOC 覆盖文件" : artifact.kind === "query" ? "查询索引" : artifact.kind === "preview" ? "覆盖预览" : `发布制品 · ${artifact.kind.toUpperCase()}`;
      const link = drawerDocLink(artifact.downloadUrl, `${kindLabel} · ${artifact.label}`); if (link) row.append(link);
      row.append(Object.assign(document.createElement("small"), { textContent: `${bytes(artifact.sizeBytes)} · SHA-256 ${artifact.sha256.slice(0, 12)}…` }));
      card.append(row);
    });
    assetsList.append(card);
  });
  if (details.assetsEvidence.length) {
    assetsSection.append(assetsList);
    content.append(assetsSection);
  }

  const warehouseSection = drawerSection(t("coverage.warehouseEvidence"));
  const geometryStatus = warehouseGeometryNotice(details.warehouseGeometry);
  if (geometryStatus) warehouseSection.append(geometryStatus);
  const warehouseList = document.createElement("div");
  warehouseList.className = "overlap-drawer-list";
  if (!details.warehouseEvidence.length) {
    const empty = document.createElement("p"); empty.className = "overlap-drawer-copy"; empty.textContent = t("coverage.warehouseUnavailable"); warehouseList.append(empty);
  } else details.warehouseEvidence.forEach((evidence) => {
    const card = document.createElement("article"); card.className = "overlap-drawer-card is-warehouse";
    const title = document.createElement("strong"); title.textContent = `${drawerText(evidence.product, evidence.productId)} · ${drawerText(evidence.releaseId)} `;
    const status = document.createElement("span"); status.className = "overlap-drawer-card-status"; status.dataset.state = evidence.state; status.textContent = evidence.state; title.append(status); card.append(title);
    const counts = document.createElement("div"); counts.className = "overlap-warehouse-facts";
    counts.append(
      modalityBadge(evidence.modality, "overlap-source-modality"),
      Object.assign(document.createElement("small"), { textContent: `${evidence.coverageCells} cells · ${evidence.fileCount} files · ${evidence.coverageCount} edges · O${evidence.commonOrder}` }),
      precisionIndicator(evidence.precision),
    );
    card.append(counts);
    const scanNote = document.createElement("small");
    scanNote.className = "overlap-warehouse-scan-note";
    scanNote.append(icon("database"), document.createTextNode(t("coverage.warehouseScanRecorded")));
    card.append(scanNote);
    for (const connector of evidence.connectors ?? []) {
      const source = document.createElement("div");
      source.className = "overlap-warehouse-internal-source overlap-scan-connector";
      appendConnectorIcon(source, connector);
      source.append(Object.assign(document.createElement("strong"), { textContent: `${connector.name} · ${connector.type.toUpperCase()}` }));
      const runs = connector.matchingScanRuns;
      source.append(Object.assign(document.createElement("small"), { textContent: locale() === "zh" ? `关联 ${runs} 条活动扫描记录` : `${runs} active scan run${runs === 1 ? "" : "s"} associated` }));
      card.append(source);
    }
    if (evidence.scanRunId) card.append(Object.assign(document.createElement("small"), { textContent: `SCAN RUN ${evidence.scanRunId}` }));
    else if (evidence.scanRunCount !== undefined) card.append(Object.assign(document.createElement("small"), { textContent: `SCAN RUNS ${evidence.scanRunCount}` }));
    if (evidence.sourceSnapshotSha256) card.append(Object.assign(document.createElement("code"), { textContent: `SNAPSHOT SHA-256 ${evidence.sourceSnapshotSha256}` }));
    else if (evidence.sourceSnapshotCount !== undefined) card.append(Object.assign(document.createElement("small"), { textContent: `INPUT SNAPSHOTS ${evidence.sourceSnapshotCount} (per committed partition)` }));
    if (evidence.scanScope) {
      card.append(Object.assign(document.createElement("small"), { textContent: `SCOPE ${evidence.scanScope.scopeId} · ${evidence.scanScope.committedPartitions}/${evidence.scanScope.expectedPartitions} partitions · ${evidence.scanScope.completeness}` }));
      card.append(Object.assign(document.createElement("code"), { textContent: `SCOPE SNAPSHOT SHA-256 ${evidence.scanScope.scopeSnapshotSha256}` }));
    }
    const connector = document.createElement("small");
    connector.textContent = evidence.connector.status === "known"
      ? `${t("coverage.connector")}: ${evidence.connector.name ?? ""}${evidence.connector.type ? ` · ${evidence.connector.type.toUpperCase()}` : ""}`
      : t("coverage.connectorUnknown");
    if (!evidence.connectors?.length) card.append(connector);
    warehouseList.append(card);
  });
  warehouseSection.append(warehouseList);
  content.append(warehouseSection);

  const methodSection = drawerSection(t("coverage.method"));
  const methodCopy = document.createElement("p"); methodCopy.className = "overlap-drawer-copy"; methodCopy.textContent = details.method.summary; methodSection.append(methodCopy);
  const methodLink = drawerDocLink(details.method.docsUrl, "Coverage method documentation"); if (methodLink) methodSection.append(methodLink);
  const reverse = document.createElement("p"); reverse.className = "overlap-drawer-copy";
  reverse.append(document.createTextNode(`${t("coverage.reverseLookup")}: ${details.reverseLookup.endpoint} · O${details.reverseLookup.order} · `), precisionIndicator(details.reverseLookup.precision));
  if (details.reverseLookup.deferred) reverse.append(document.createTextNode(" · deferred"));
  methodSection.append(reverse);
  content.append(methodSection);

  const actionsSection = drawerSection("DOWNLOAD PLAN");
  const actions = document.createElement("div"); actions.className = "overlap-drawer-actions";
  const currentCsv = document.createElement("button"); currentCsv.type = "button"; currentCsv.className = "command-button overlap-download-button"; currentCsv.append(icon("lock"), document.createTextNode(t("coverage.downloadCurrent"))); currentCsv.addEventListener("click", () => void downloadOverlapCsv([component], `atlas-overlap-${component.id}-download-plan.csv`, currentCsv)); actions.append(currentCsv);
  const currentJson = document.createElement("button"); currentJson.type = "button"; currentJson.className = "command-button overlap-download-button"; currentJson.append(icon("lock"), document.createTextNode(t("coverage.downloadJson"))); currentJson.addEventListener("click", () => void downloadOverlapJson([component], `atlas-overlap-${component.id}-download-plan.json`, currentJson)); actions.append(currentJson);
  if (activeOverlapComponents.length > 1) {
    const allCsv = document.createElement("button"); allCsv.type = "button"; allCsv.className = "command-button overlap-download-button"; allCsv.append(icon("lock"), document.createTextNode(t("coverage.downloadAll"))); allCsv.addEventListener("click", () => void downloadOverlapCsv(activeOverlapComponents, "atlas-overlap-all-download-plan.csv", allCsv)); actions.append(allCsv);
    const allJson = document.createElement("button"); allJson.type = "button"; allJson.className = "command-button overlap-download-button"; allJson.append(icon("lock"), document.createTextNode(t("coverage.downloadJson"))); allJson.addEventListener("click", () => void downloadOverlapJson(activeOverlapComponents, "atlas-overlap-all-download-plan.json", allJson)); actions.append(allJson);
  }
  actionsSection.append(actions);
  content.append(actionsSection);
  void loadOverlapEvidence(component, evidence);
  renderIcons();
}

function renderOverlapDrawerDetails(component: OverlapComponentView): void {
  if (reverseLookupRegionTooLarge(component)) {
    drawerDetailsShownKey = "";
    renderOverlapDrawerError(t("coverage.overlapRegionTooLarge"));
    return;
  }
  const key = overlapDetailsCacheKey(component);
  // Same content already on screen (a camera refresh that changed nothing): leave it alone.
  if (overlapDrawerOpen && drawerDetailsShownKey === key && overlapDetailsCache.has(key)) return;
  const cooling = overlapDetailsCooldown.get(key);
  if (cooling && cooling.until > Date.now()) {
    drawerDetailsShownKey = "";
    renderOverlapDrawerError(`${t("coverage.overlapFailed")} ${cooling.message}`);
    return;
  }
  const cached = overlapDetailsCache.get(key);
  if (cached) {
    renderOverlapDrawerResponse(cached);
    drawerDetailsShownKey = key;
    return;
  }
  // A request for this very content is already running: keep showing it, do not restart.
  if (overlapDetailsPendingKey === key && overlapDetailsController) return;
  drawerDetailsShownKey = "";
  renderOverlapDrawerLoading(component);
  overlapDetailsController?.abort();
  const controller = new AbortController();
  overlapDetailsController = controller;
  overlapDetailsPendingKey = key;
  const current = () => overlapDrawerOpen && !controller.signal.aborted && selectedQueueComponent?.id === component.id;
  void new Promise<void>((resolve) => setTimeout(resolve, OVERLAP_EVIDENCE_DEBOUNCE_MS))
    .then(() => {
      // A newer render superseded this one before it sent anything.
      if (controller.signal.aborted) return;
      return fetchOverlapDetails(component).then((details) => {
        if (!current()) return;
        renderOverlapDrawerResponse(details);
        drawerDetailsShownKey = key;
      });
    }).catch((error: unknown) => {
      const retryAfter = (error as { retryAfter?: number }).retryAfter ?? 30;
      const message = error instanceof Error ? error.message : "";
      overlapDetailsCooldown.set(key, { until: Date.now() + retryAfter * 1000, message });
      if (current()) renderOverlapDrawerError(`${t("coverage.overlapFailed")} ${message}`);
    }).finally(() => {
      if (overlapDetailsController === controller) { overlapDetailsController = null; overlapDetailsPendingKey = ""; }
    });
}

function selectOverlapDrawerComponent(component: OverlapComponentView): void {
  if (!overlapDrawerOpen) return;
  hideOverlapRegionTooltip();
  const componentIndex = activeOverlapComponents.findIndex((entry) => entry.id === component.id);
  if (componentIndex >= 0) {
    overlapDrawerComponentsPage = Math.floor(componentIndex / OVERLAP_COMPONENT_PAGE_SIZE);
    overlapComponentsPage = overlapDrawerComponentsPage;
  }
  selectedQueueComponent = component;
  coverageDots?.setActiveOverlapComponent(component.id);
  syncOverlapHudTarget(component);
  updateOverlapViewport();
  coverageDots?.focusPixels(component.order, component.cells);
  renderSelectionQueue();
  renderOverlapDrawerComponents();
  renderOverlapDrawerDetails(component);
}

function openOverlapDrawer(): void {
  if (!overlapMode || !activeOverlapComponents.length) return;
  const drawer = byId("overlap-drawer");
  if (!overlapDrawerPreviousState) {
    overlapDrawerPreviousState = {
      layersHidden: document.body.dataset.layersPanel !== "open",
      queueHidden: Boolean(byId("selection-queue").hidden),
      panelHidden: Boolean(byId("coverage-detail-panel").hidden),
      helpHidden: Boolean(byId("coverage-help").hidden),
    };
    overlapDrawerPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  setCoverageLayersOpen(false);
  byId("coverage-help").hidden = true;
  overlapDrawerOpen = true;
  closeSkyDepth();
  skyDepthInspection = null;
  coverageDots?.setOverlapPickingMode("component");
  if (displayOrderControl) byId("overlap-drawer-tools").prepend(displayOrderControl);
  document.body.dataset.overlapDrawer = "open";
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  updateOverlapViewport();
  const component = activeOverlapComponents.find((entry) => entry.id === selectedQueueComponent?.id) ?? activeOverlapComponents[0]!;
  renderOverlapDrawerComponents();
  selectOverlapDrawerComponent(component);
  byId<HTMLButtonElement>("overlap-drawer-close").focus();
}

function closeOverlapDrawer(): void {
  if (!overlapDrawerOpen && !overlapDrawerPreviousState) return;
  overlapDetailsController?.abort();
  overlapDetailsController = null;
  overlapDetailsPendingKey = "";
  drawerDetailsShownKey = "";
  abortHstLookupsWithin(byId("overlap-drawer-content"));
  overlapDrawerOpen = false;
  hideOverlapRegionTooltip();
  coverageDots?.setOverlapPickingMode("cell");
  if (displayOrderControl && displayOrderHome) displayOrderHome.insertBefore(displayOrderControl, displayOrderNextSibling ?? null);
  coverageDots?.setActiveOverlapComponent(null);
  document.body.removeAttribute("data-overlap-drawer");
  document.body.removeAttribute("data-overlap-panels");
  const drawer = byId("overlap-drawer");
  drawer.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
  updateOverlapViewport();
  const previous = overlapDrawerPreviousState;
  overlapDrawerPreviousState = null;
  if (previous) {
    setCoverageLayersOpen(!previous.layersHidden);
    byId("selection-queue").hidden = previous.queueHidden;
    byId("coverage-detail-panel").hidden = previous.panelHidden;
    byId("coverage-help").hidden = previous.helpHidden;
    if (!previous.panelHidden && overlapMode && selectedQueueComponent) {
      renderOverlapPanel(activeOverlapSurveyIds, [...new Set(activeOverlapComponents.flatMap((entry) => entry.cells))], selectedQueueComponent.order, "GLOBAL", activeOverlapComponents, false);
    }
  }
  positionSelectionQueue();
  positionOverlapPanel();
  overlapDrawerPreviousFocus?.focus();
  overlapDrawerPreviousFocus = null;
}

async function activateOverlap(forceActive?: boolean, forceView = false): Promise<void> {
  if (!isAtlasInteractive()) return;
  const wasOverlapMode = overlapMode && activeOverlapOrder !== null;
  const hadPendingView = Boolean(overlapViewController);
  const viewSequence = ++overlapViewSequence;
  overlapViewController?.abort();
  overlapViewController = null;
  const surveyIds = visibleSurveyIdsFromControls();
  const activate = forceActive ?? !(overlapMode || overlapIntent || hadPendingView);
  overlapIntent = activate;
  if (activate && surveyIds.length < 2) {
    overlapIntent = false;
    if (overlapMode) void activateOverlap(false);
    toast(t("coverage.needTwoSurveys"));
    return;
  }
  let order: number | null = null;
  if (activate) {
    order = selectedDisplayOrder;
    if (!selectedLayerOrders().includes(order)) {
      overlapIntent = false;
      if (overlapMode) void activateOverlap(false);
      toast(t("coverage.noCommonOrder"));
      byId("coverage-state").textContent = t("coverage.noCommonOrder");
      return;
    }
  }
  const selectedLayerIds = visibleCoverageLayers().map((layer) => layer.layerId).sort();
  let requestedViewTiles: { order: number; tiles: number[] } | undefined;
  let displayPlan: CoverageDisplayPlan | null = null;
  let reuseOverlap = false;
  const viewController = activate && order !== null ? new AbortController() : null;
  if (viewController) {
    overlapViewController = viewController;
    cancelCoverageDisplayRequest();
    try {
      const state = coverageDots?.state;
      if (!state) throw new Error(t("coverage.previewUnavailable"));
      const intersectionPlan = await planCoverageDisplay(order!, visibleCoverageLayers(), state, viewController.signal, false);
      requestedViewTiles = overlapViewTiles(order!, state, surveyIds, intersectionPlan);
      // The survey coverage under the overlap keeps the selected display
      // order, planned exactly like the normal view so its blocks are shared.
      displayPlan = await planCoverageDisplay(order!, visibleCoverageLayers(), state, viewController.signal);
    } catch (error) {
      if (viewController.signal.aborted || viewSequence !== overlapViewSequence) return;
      if (overlapViewController === viewController) overlapViewController = null;
      const message = error instanceof Error ? error.message : locale() === "zh" ? "重合视野超过显示预算" : "OVERLAP VIEW EXCEEDS DISPLAY BUDGET";
      if (!wasOverlapMode) overlapIntent = false;
      if (!wasOverlapMode) renderOverlapErrorPanel(surveyIds, message);
      setCoverageDisplayStatus(`${message} · ${retainedDisplayOrderText()}`);
      return;
    }
    if (viewController.signal.aborted || viewSequence !== overlapViewSequence) return;
    if (overlapViewController === viewController) overlapViewController = null;
  }
  const viewKey = `${order}:${selectedLayerIds.join(",")}:${requestedViewTiles?.order}:${requestedViewTiles?.tiles.join(",")}:${displayPlan?.key}`;
  if (activate && !forceView && overlapMode) {
    const loadedTiles = activeOverlapViewTiles ? new Set(activeOverlapViewTiles.tiles) : null;
    reuseOverlap = Boolean(lastOverlapViewKey && activeOverlapOrder === order
      && selectedLayerIds.join(",") === activeOverlapLayerIds.join(",")
      && (!loadedTiles || requestedViewTiles?.tiles.every((tile) => loadedTiles.has(tile))));
    if (reuseOverlap && displayPlan?.key === activeOverlapOverviewKey) {
      overlapController?.abort();
      overlapController = null;
      overlapRequestSequence += 1;
      pendingOverlapViewKey = "";
      setCoverageDisplayStatus(overlapDisplayStatus(activeOverlapOrder!, activeOverlapPixels));
      return;
    }
    if (pendingOverlapViewKey === viewKey && overlapController) return;
  }
  const requestSequence = ++overlapRequestSequence;
  setOverlapMode(activate);
  if (!activate) {
    clearLayerCloseTimer();
    coverageDots?.setViewportRightInset(0);
    closeOverlapDrawer();
    overlapController?.abort();
    overlapController = null;
    overlapEvidenceController?.abort();
    overlapEvidenceSequence += 1;
    activeOverlapSurveyIds = [];
    activeOverlapLayerIds = [];
    activeOverlapViewTiles = undefined;
    lastOverlapViewKey = "";
    pendingOverlapViewKey = "";
    activeOverlapOrder = null;
    activeOverlapOverviewKey = "";
    activeOverlapPixels = [];
    activeOverlapModalities = [];
    activeOverlapComponents = [];
    overlapComponentsPage = 0;
    overlapDrawerComponentsPage = 0;
    overlapEvidenceCache.clear();
    overlapDetailsCache.clear();
    coverageDots?.setOverlapMode(false);
    coverageDots?.setActiveOverlapComponent(null);
    // Clear stale component/cell focus but keep the camera where the user
    // left it, so the coverage already drawn for this view stays valid.
    coverageDots?.clearTransientState();
    updateOverlapHud(null);
    const panel = byId("coverage-detail-panel");
    abortHstLookupsWithin(byId("coverage-detail-content"));
    panel.hidden = true;
    panel.classList.remove("is-overlap-panel");
    panel.style.removeProperty("left");
    panel.style.removeProperty("top");
    panel.style.removeProperty("right");
    panel.style.removeProperty("width");
    setOverlapExpandVisible(false);
    setCoverageLayersOpen(true);
    coverageFocusActive = false;
    // Not forced: when G drew the same plan, the coverage is already current.
    void loadCoverageDisplay();
    return;
  }
  if (activate) {
    clearLayerCloseTimer();
    setCoverageLayersOpen(false);
  }
  if (order === null || !displayPlan) return;
  coverageDots?.setOverlapMode(true);
  if (!wasOverlapMode) {
    overlapComponentsPage = 0;
    overlapDrawerComponentsPage = 0;
    updateOverlapHud(null);
  }
  // overlapDetailsCacheKey is content-addressed (surveys, layers, view tiles,
  // modalities, component), so a view refresh must not discard what it still matches.
  overlapController?.abort();
  const controller = new AbortController();
  overlapController = controller;
  if (!wasOverlapMode) overlapInitialController = controller;
  pendingOverlapViewKey = viewKey;
  const modalities = [...selectedModalities];
  if (!wasOverlapMode) renderOverlapLoadingPanel(surveyIds, order);
  setCoverageDisplayStatus(`${locale() === "zh" ? "加载共同覆盖" : "Loading overlap"} O${order} · ${retainedDisplayOrderText()}`);
  try {
    const resultPromise = reuseOverlap
      ? Promise.resolve({ commonOrder: activeOverlapOrder!, pixels: activeOverlapPixels, components: activeOverlapComponents })
      : fetch("/api/v1/coverage/overlap", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ surveyIds, layerIds: selectedLayerIds, viewTiles: requestedViewTiles, modalities, requestedOrder: order, strictOrder: true }), signal: controller.signal }).then(async (response) => {
        if (!response.ok) {
          const failure = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(failure?.error ?? `overlap request failed: ${response.status}`);
        }
        return response.json() as Promise<{ components?: OverlapComponentView[]; commonOrder?: number; pixels?: number[] }>;
      });
    // Commit the survey coverage and the intersection together. Blocks come
    // from the shared cache, so entering or leaving G does not refetch them.
    // A view whose coverage exceeds the display budget keeps the coverage
    // already drawn; only the strict intersection must succeed.
    const plan = displayPlan;
    const [batch, result] = await Promise.all([
      fetchCoverageDisplayBatch(plan, controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        return null;
      }),
      resultPromise,
    ]);
    if (!overlapMode || requestSequence !== overlapRequestSequence || controller.signal.aborted) return;
    const renderedPixels = result.pixels ?? [];
    const renderedOrder = result.commonOrder ?? order;
    if (renderedOrder !== order) throw new Error(`Overlap returned O${renderedOrder} instead of requested O${order}`);
    activeOverlapSurveyIds = [...surveyIds];
    activeOverlapLayerIds = selectedLayerIds;
    if (!reuseOverlap) activeOverlapViewTiles = requestedViewTiles;
    activeOverlapModalities = modalities;
    activeOverlapOrder = renderedOrder;
    activeOverlapPixels = renderedPixels;
    if (batch) {
      activeOverlapOverviewKey = plan.key;
      coverageDisplayViewKey = plan.key;
    }
    lastOverlapViewKey = viewKey;
    activeOverlapComponents = result.components ?? [];
    {
      const names = surveyIds.map((id) => (surveyIndex?.surveys.find((survey) => survey.id === id)?.name ?? id).toUpperCase()).join(" × ");
      const first = activeOverlapComponents[0];
      hudLog(first
        ? [`OVERLAP ${first.id} · `, { text: names, tone: "ind" }, ` · ${first.cells.length.toLocaleString("en-US")} CELLS · ${activeOverlapComponents.length} REGIONS`]
        : ["OVERLAP · ", { text: names, tone: "ind" }, ` · ${renderedPixels.length.toLocaleString("en-US")} CELLS`]);
    }
    // The preview cache key already carries order, cells, layers and revisions,
    // so a view refresh must not discard it and re-query unchanged regions.
    const overlapCoverage = { nside: 2 ** renderedOrder, pixels: renderedPixels, components: activeOverlapComponents };
    if (batch) coverageDots?.updateBlocks(batch.blocks, plan.order, overlapCoverage);
    else coverageDots?.updateOverlap(overlapCoverage);
    renderOverlapPanel(surveyIds, renderedPixels, renderedOrder, "GLOBAL", activeOverlapComponents, !wasOverlapMode);
    if (overlapDrawerOpen) {
      renderOverlapDrawerComponents();
      const component = activeOverlapComponents.find((entry) => entry.id === selectedQueueComponent?.id) ?? activeOverlapComponents[0];
      if (component) {
        selectedQueueComponent = component;
        renderOverlapDrawerDetails(component);
      } else {
        updateOverlapHud(null);
        byId("overlap-drawer-title").textContent = `${t("coverage.commonOrder")} O${renderedOrder}`;
        renderOverlapDrawerSurveys();
        renderOverlapDrawerError(t("coverage.noCommon"));
      }
    }
    setCoverageDisplayStatus(overlapDisplayStatus(renderedOrder, renderedPixels));
  } catch (error) {
    if (!overlapMode || requestSequence !== overlapRequestSequence || controller.signal.aborted) return;
    controller.abort();
    if (!wasOverlapMode) renderOverlapErrorPanel(surveyIds);
    setCoverageDisplayStatus(`${error instanceof Error ? error.message : t("coverage.overlapFailed")} · ${retainedDisplayOrderText()}`);
  } finally {
    if (overlapInitialController === controller) overlapInitialController = null;
    if (overlapController === controller) {
      overlapController = null;
      pendingOverlapViewKey = "";
    }
  }
}

function closeCoverageContextMenu(): void {
  const menu = byId("coverage-context-menu");
  menu.hidden = true;
  menu.replaceChildren();
}

function openCoverageContextMenu(menuState: SurveyLayerContextMenu): void {
  if (!isAtlasInteractive()) return;
  const menu = byId("coverage-context-menu");
  menu.replaceChildren();
  const addAction = (label: string, action: () => void): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => { action(); closeCoverageContextMenu(); });
    menu.append(button);
  };
  addAction(t("coverage.inspectDownload"), () => {
    renderOverlapPanel(menuState.surveyIds, menuState.pixels, menuState.nside === 16 ? 4 : Math.round(Math.log2(menuState.nside)), "SELECTED CELL");
  });
  const bounds = byId("coverage-scene").getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(12, menuState.clientX - bounds.left), bounds.width - 250)}px`;
  menu.style.top = `${Math.min(Math.max(72, menuState.clientY - bounds.top), bounds.height - 180)}px`;
  menu.hidden = false;
}

function modalityIconName(modality: string): string {
  return ({ imaging: "image", spectroscopy: "telescope", redshift: "scan-line", photometry: "database", "time-domain": "rotate-ccw", "integral-field": "layers-3", ultraviolet: "sun", infrared: "circle-help", catalog: "list-checks", simulation: "box", radio: "radio" } as Record<string, string>)[modality] ?? "circle-help";
}

function modalityDescription(modality: string | undefined): string {
  if (modality === "spectroscopy") {
    return locale() === "zh"
      ? "光谱记录光强随波长的变化，可用于分析谱线和天体性质；它不等同于红移目录。"
      : "Spectroscopy records signal as a function of wavelength for studying spectral features; it is distinct from a redshift catalog.";
  }
  const label = modality ? modalityLabel(modality) : locale() === "zh" ? "模态未指定" : "Modality unspecified";
  return locale() === "zh" ? `数据模态：${label}` : `Data modality: ${label}`;
}

function modalityBadge(modality: string | undefined, className: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = className;
  badge.dataset.modality = canonicalModality(modality) || "unknown";
  const label = modality ? modalityLabel(modality) : locale() === "zh" ? "模态未指定" : "Modality unspecified";
  badge.title = modalityDescription(modality);
  badge.setAttribute("aria-label", `${locale() === "zh" ? "模态" : "Modality"}: ${label}. ${modalityDescription(modality)}`);
  badge.append(icon(modalityIconName(modality ?? "unknown")), document.createTextNode(label));
  return badge;
}

function setCoverageSurveyExpanded(surveyId: string, expanded: boolean): void {
  const group = document.getElementById(`coverage-survey-${surveyId}`);
  const button = group?.querySelector<HTMLButtonElement>("[data-expand-survey]");
  const list = group?.querySelector<HTMLElement>(".coverage-release-list");
  if (!group || !button || !list) return;
  const surveyName = group.querySelector<HTMLElement>(".coverage-layer-name")?.textContent ?? surveyId;
  if (expanded) expandedCoverageSurveyIds.add(surveyId);
  else expandedCoverageSurveyIds.delete(surveyId);
  group.dataset.expanded = String(expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", `${expanded ? (locale() === "zh" ? "收起" : "Collapse") : (locale() === "zh" ? "展开" : "Expand")} ${surveyName}`);
  list.hidden = !expanded;
}

function filterCoverageSurveyGroups(): void {
  const host = document.getElementById("coverage-layers");
  if (!host) return;
  const query = coverageLayerSearchQuery;
  const rows = [...host.querySelectorAll<HTMLElement>(".coverage-survey-group")];
  if (query && coverageSearchExpandedBefore === null) coverageSearchExpandedBefore = new Set(expandedCoverageSurveyIds);
  if (!query && coverageSearchExpandedBefore) {
    expandedCoverageSurveyIds.clear();
    coverageSearchExpandedBefore.forEach((surveyId) => expandedCoverageSurveyIds.add(surveyId));
    coverageSearchExpandedBefore = null;
  }
  if (query && coverageSearchExpandedBefore) {
    expandedCoverageSurveyIds.clear();
    coverageSearchExpandedBefore.forEach((surveyId) => expandedCoverageSurveyIds.add(surveyId));
  }
  rows.forEach((row) => {
    const surveyId = row.dataset.surveyId;
    const surveyMatch = row.querySelector<HTMLElement>(".coverage-layer-toggle")?.dataset.searchText?.includes(query) ?? false;
    const productMatches = [...row.querySelectorAll<HTMLElement>(".coverage-product-toggle")]
      .filter((product) => product.dataset.searchText?.includes(query));
    row.hidden = Boolean(query) && !surveyMatch && !productMatches.length;
    if (query && (surveyMatch || productMatches.length) && surveyId) expandedCoverageSurveyIds.add(surveyId);
  });
  rows.forEach((row) => {
    if (row.dataset.surveyId) setCoverageSurveyExpanded(row.dataset.surveyId, expandedCoverageSurveyIds.has(row.dataset.surveyId));
  });
  positionCoverageLayerTooltip();
}

function infoControl(description: string, className = "overlap-spatial-unit-info"): HTMLSpanElement {
  const info = icon("info");
  info.classList.add(className);
  info.title = description;
  info.setAttribute("role", "img");
  info.setAttribute("aria-label", description.replaceAll("\n", ". "));
  info.tabIndex = 0;
  return info;
}

function precisionLabel(precision: string): string {
  const labels: Record<string, [string, string]> = {
    exact: ["精确", "Exact"],
    estimated: ["估算", "Estimated"],
    "entrypoint-only": ["仅入口", "Entrypoint only"],
    truncated: ["结果截断", "Truncated"],
  };
  const entry = labels[precision];
  return entry ? entry[locale() === "zh" ? 0 : 1] : precision;
}

function precisionDescription(precision: string): string {
  const explanations: Record<string, [string, string]> = {
    exact: [
      "按当前索引中的空间证据，在显示的 HEALPix order/cell 上精确匹配；不表示巡天清单完整，也不证明像元内每个位置都有观测文件。",
      "An exact match against indexed spatial evidence at the displayed HEALPix order/cell. It does not claim a complete survey inventory or a science file at every position.",
    ],
    estimated: [
      "分块边界或关联关系使用了近似几何/规则。命中表示可能相关的空间分块，不保证像元内每个位置都有科学数据。",
      "The unit footprint or association uses approximate geometry or rules. A match identifies a possibly relevant unit, not guaranteed science data at every position.",
    ],
    "entrypoint-only": [
      "只有公开覆盖或访问入口可用，尚无本地原生分块映射，因此不能列出精确的分块身份。",
      "Only a public coverage or access entrypoint is available; no local native-unit mapping exists to list specific blocks.",
    ],
    truncated: [
      "本次结果达到查询或展示上限，清单不完整；可用“继续加载”或授权分页获取后续结果。",
      "The query or display limit was reached, so this list is incomplete. Continue browsing or use an authorized cursor to retrieve more results.",
    ],
  };
  const entry = explanations[precision];
  return entry ? entry[locale() === "zh" ? 0 : 1] : `${locale() === "zh" ? "精度状态" : "Precision state"}: ${precision}`;
}

function precisionIndicator(precision: string): HTMLSpanElement {
  const status = document.createElement("span");
  status.className = "overlap-precision-indicator";
  status.append(document.createTextNode(precisionLabel(precision)), infoControl(precisionDescription(precision), "overlap-precision-info"));
  return status;
}

function modalityIconsMarkup(modalities: readonly string[], label: string): string { const unique=[...new Set(modalities)].sort((a,b)=>modalityLabel(a).localeCompare(modalityLabel(b))); return unique.length ? `<span class="coverage-modalities" aria-label="${escapeHtml(label)}：${escapeHtml(unique.map(modalityLabel).join("、"))}">${unique.map(m=>`<i data-lucide="${modalityIconName(m)}" title="${escapeHtml(modalityLabel(m))}"></i>`).join("")}</span>` : `<span class="coverage-modalities-empty">模态未指定</span>`; }

function renderCoverageLayers(): void {
  const host = byId("coverage-layers");
  hideCoverageLayerTooltip();
  host.replaceChildren();
  if (!coverageCatalog) return;
  bindLayerCloseTimer(host);
  if (isAtlasPage) {
    const head = document.createElement("button");
    head.type = "button";
    head.id = "hud-layers-head";
    head.className = "hud-layers-head";
    head.setAttribute("aria-expanded", String(document.body.dataset.hudRoster !== "collapsed"));
    head.append(
      Object.assign(document.createElement("b"), { textContent: "◆" }),
      Object.assign(document.createElement("span"), { textContent: "LAYERS · 覆盖图层" }),
      Object.assign(document.createElement("output"), { id: "hud-layers-count", textContent: "-- / --" }),
      Object.assign(document.createElement("i"), { className: "hud-roster-chevron" }),
    );
    head.addEventListener("click", () => setRosterCollapsed(document.body.dataset.hudRoster !== "collapsed"));
    host.append(head);
  }
  const search = document.createElement("label");
  search.className = "coverage-layer-search";
  search.innerHTML = `<i data-lucide="search"></i><input id="coverage-layer-search" type="search" autocomplete="off" placeholder="筛选巡天图层" aria-label="筛选巡天图层" />`;
  host.append(search);
  const filterInput = search.querySelector<HTMLInputElement>("input");
  if (filterInput) filterInput.value = coverageLayerSearchQuery;
  const grouped = new Map<string, CoverageCatalog["layers"]>();
  for (const layer of filterByModalities(coverageCatalog.layers, selectedModalities)) grouped.set(layer.surveyId, [...(grouped.get(layer.surveyId) ?? []), layer]);
  const surveyIds = [...new Set([
    ...grouped.keys(),
    ...(surveyIndex?.surveys.map((survey) => survey.id) ?? []),
  ])];
  for (const surveyId of surveyIds) {
    const layers = grouped.get(surveyId) ?? [];
    const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
    const unavailable = layers.length === 0;
    const group = document.createElement("section");
    group.className = "coverage-survey-group";
    group.id = `coverage-survey-${surveyId}`;
    group.dataset.surveyId = surveyId;
    const label = document.createElement("div");
    label.className = `coverage-layer-toggle${unavailable ? " is-unavailable" : ""}`;
    label.setAttribute("title", unavailable ? "暂无公开覆盖，暂不可在天球中显示" : "拖动把手可调整图层顺序");
    const input = document.createElement("input");
    input.type = "checkbox";
    const selectedProducts = layers.filter((layer) => selectedCoverageProductIds.has(layer.layerId)).length;
    input.checked = !unavailable && selectedProducts === layers.length;
    input.indeterminate = selectedProducts > 0 && selectedProducts < layers.length;
    input.disabled = unavailable;
    input.dataset.surveyId = surveyId;
    const name = document.createElement("span");
    label.dataset.searchText = `${survey?.name ?? surveyId} ${survey?.mission ?? ""}`.toLocaleLowerCase();
    const releaseGroups = new Map<string, CoverageCatalog["layers"]>();
    for (const layer of layers) releaseGroups.set(layer.releaseId, [...(releaseGroups.get(layer.releaseId) ?? []), layer]);
    const releaseModalities = [...releaseGroups.values()].map(group => [...new Set(group.flatMap(layer => { const product = survey?.releases.find(r => r.id === layer.releaseId)?.products.find(p => p.productId === layer.productId || p.name === layer.product); return product?.modality ? [product.modality] : []; }))]);
    const commonModalities = [...new Set(unavailable
      ? (survey?.modalities ?? []).filter((modality) => !selectedModalities.size || selectedModalities.has(modality))
      : releaseModalities.flat())];
    name.textContent = survey?.name ?? surveyId.toUpperCase();
    name.className = "coverage-layer-name";
    const swatch = document.createElement("span");
    swatch.className = "coverage-layer-swatch";
    swatch.style.backgroundColor = surveyColorFor(surveyId, survey?.color, layers[0]?.color);
    swatch.style.color = swatch.style.backgroundColor;
    swatch.setAttribute("aria-label", `图层颜色 ${swatch.style.backgroundColor}`);
    label.addEventListener("pointerenter", () => showCoverageLayerTooltip(surveyId, label));
    label.addEventListener("pointerleave", () => {
      if (coverageLayerTooltipRow === label) scheduleCoverageLayerTooltipClose();
    });
    label.addEventListener("focusin", () => showCoverageLayerTooltip(surveyId, label));
    label.addEventListener("focusout", () => {
      queueMicrotask(() => {
        if (coverageLayerTooltipRow === label) scheduleCoverageLayerTooltipClose();
      });
    });
    const handle = document.createElement("span");
    handle.className = "coverage-layer-handle";
    handle.innerHTML = `<i data-lucide="grip-horizontal"></i>`;
    handle.draggable = !unavailable;
    handle.setAttribute("role", "img");
    handle.setAttribute("aria-label", locale() === "zh" ? "拖动把手以排序" : "Drag handle to reorder");
    handle.title = "拖动排序";
    const expanded = expandedCoverageSurveyIds.has(surveyId);
    const expander = document.createElement("button");
    expander.className = "coverage-survey-expander";
    expander.type = "button";
    expander.dataset.expandSurvey = surveyId;
    expander.setAttribute("aria-controls", `coverage-releases-${surveyId}`);
    expander.setAttribute("aria-expanded", String(expanded));
    expander.setAttribute("aria-label", (expanded ? "收起 " : "展开 ") + (survey?.name ?? surveyId));
    expander.title = expanded ? (locale() === "zh" ? "收起数据版本" : "Collapse releases") : (locale() === "zh" ? "展开数据版本" : "Expand releases");
    expander.disabled = unavailable;
    expander.innerHTML = `<i data-lucide="chevron-right"></i>`;
    expander.addEventListener("click", () => setCoverageSurveyExpanded(surveyId, !expandedCoverageSurveyIds.has(surveyId)));
    label.addEventListener("click", (event) => {
      if (unavailable || !(event.target instanceof Element)) return;
      if (event.target.closest("input, button, .coverage-layer-handle")) return;
      setCoverageSurveyExpanded(surveyId, !expandedCoverageSurveyIds.has(surveyId));
    });
    input.addEventListener("change", () => {
      if (overlapDrawerOpen) closeOverlapDrawer();
      for (const layer of layers) {
        if (input.checked) selectedCoverageProductIds.add(layer.layerId);
        else selectedCoverageProductIds.delete(layer.layerId);
      }
      commitCoverageProductSelection();
      restartLayerCloseTimer();
    });
    if (!unavailable) {
      label.dataset.layerKey = `public-survey:${surveyId}`;
      handle.addEventListener("dragstart", () => label.classList.add("is-dragging"));
      label.addEventListener("dragend", () => { label.classList.remove("is-dragging"); host.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target")); });
      label.addEventListener("dragover", (event) => { event.preventDefault(); label.classList.add("is-drop-target"); });
      label.addEventListener("dragleave", () => label.classList.remove("is-drop-target"));
      label.addEventListener("drop", (event) => {
        event.preventDefault();
        const dragging = host.querySelector<HTMLElement>(".coverage-layer-toggle.is-dragging")?.closest<HTMLElement>(".coverage-survey-group");
        const targetGroup = label.closest<HTMLElement>(".coverage-survey-group");
        if (!dragging || !targetGroup || dragging === targetGroup) return;
        const rect = label.getBoundingClientRect();
        host.insertBefore(dragging, event.clientY < rect.top + rect.height / 2 ? targetGroup : targetGroup.nextSibling);
        coverageDots?.setLayerOrder([...host.querySelectorAll<HTMLElement>("[data-layer-key]")].map((node) => node.dataset.layerKey!).filter(Boolean));
      });
    }
    label.append(input, swatch, handle, expander, name);
    const common = document.createElement("span"); common.innerHTML = modalityIconsMarkup(commonModalities, `${survey?.name ?? surveyId} 共同覆盖模态`); label.append(common);
    if (unavailable) label.append(Object.assign(document.createElement("small"), { className: "coverage-layer-unavailable", textContent: "暂无公开覆盖" }));
    group.append(label);
    if (!unavailable) {
      const releaseList = document.createElement("div");
      releaseList.className = "coverage-release-list";
      releaseList.id = `coverage-releases-${surveyId}`;
      releaseList.hidden = !expanded;
      for (const [releaseId, products] of releaseGroups) {
        const release = document.createElement("section");
        release.className = "coverage-release-group";
        const releaseHeading = document.createElement("strong");
        releaseHeading.textContent = survey?.releases.find((entry) => entry.id === releaseId)?.label ?? releaseId;
        const releaseToggle = document.createElement("label");
        releaseToggle.className = "coverage-release-toggle";
        const releaseInput = document.createElement("input");
        releaseInput.type = "checkbox";
        releaseInput.dataset.surveyId = surveyId;
        releaseInput.dataset.releaseId = releaseId;
        const selectedInRelease = products.filter((layer) => selectedCoverageProductIds.has(layer.layerId)).length;
        releaseInput.checked = products.length > 0 && selectedInRelease === products.length;
        releaseInput.indeterminate = selectedInRelease > 0 && selectedInRelease < products.length;
        releaseInput.addEventListener("change", () => {
          for (const layer of products) {
            if (releaseInput.checked) selectedCoverageProductIds.add(layer.layerId);
            else selectedCoverageProductIds.delete(layer.layerId);
          }
          commitCoverageProductSelection();
        });
        releaseToggle.append(releaseInput, releaseHeading);
        release.append(releaseToggle);
        for (const layer of products) {
          const productRow = document.createElement("label");
          productRow.className = "coverage-product-toggle";
          productRow.dataset.searchText = `${survey?.name ?? surveyId} ${releaseId} ${layer.product} ${layer.modality ?? ""}`.toLocaleLowerCase();
          const productInput = document.createElement("input");
          productInput.type = "checkbox";
          productInput.dataset.productLayerId = layer.layerId;
          productInput.checked = selectedCoverageProductIds.has(layer.layerId);
          productInput.disabled = !layer.maxOrder || !layer.displayOrders?.length && !layer.availableOrders.length;
          productInput.addEventListener("change", () => setCoverageProductSelection(layer.layerId, productInput.checked));
          const productName = document.createElement("span");
          productName.textContent = layer.product;
          const capability = document.createElement("small");
          capability.textContent = (layer.displayOrders ?? layer.availableOrders).length
            ? displayOrdersLabel(layer.displayOrders ?? layer.availableOrders)
            : (locale() === "zh" ? "未发布覆盖" : "No published coverage");
          productRow.append(productInput, productName, modalityBadge(layer.modality, "coverage-product-modality"), capability);
          release.append(productRow);
        }
        releaseList.append(release);
      }
      group.append(releaseList);
    } else {
      group.append(Object.assign(document.createElement("small"), { className: "coverage-layer-unavailable", textContent: locale() === "zh" ? "暂无公开覆盖" : "No public coverage" }));
    }
    host.append(group);
  }
  if (host.dataset.tooltipBound !== "true") {
    host.dataset.tooltipBound = "true";
    host.addEventListener("scroll", positionCoverageLayerTooltip, { passive: true });
  }
  filterInput?.addEventListener("input", () => {
    coverageLayerSearchQuery = filterInput.value.trim().toLocaleLowerCase();
    filterCoverageSurveyGroups();
  });
  filterCoverageSurveyGroups();
  if (isAtlasPage) {
    const all = document.createElement("button");
    all.type = "button";
    all.id = "hud-layers-all";
    all.className = "hud-roster-all";
    all.textContent = document.body.dataset.layersPanel === "open" ? "COMPACT ▴" : "ALL LAYERS ▸";
    all.addEventListener("click", () => setCoverageLayersOpen(document.body.dataset.layersPanel !== "open"));
    host.append(all);
    if (layersPanelDocked()) host.hidden = false;
  }
  renderHudRosterNow();
  renderIcons();
  renderSelectionQueue();
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function toast(message: string, durationMs = 1800): void { showToast("toast", message, { durationMs }); }

async function copy(value: string, message = "SHA-256 已复制"): Promise<void> {
  await navigator.clipboard.writeText(value);
  toast(message);
}

function renderIcons(): void {
    createIcons({
    icons: { BadgeCheck, BookOpen, Box, ChevronLeft, ChevronRight, CircleHelp, Cloud, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, HardDrive, Home, Image, Info, Layers3, ListChecks, ListFilter, LoaderCircle, Lock, Maximize2, Minimize2, Moon, Menu, Plug, Radio, RotateCcw, ScanLine, Search, ShieldCheck, Sun, Telescope, X },
    attrs: { "aria-hidden": "true" },
  });
}

function icon(name: string): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = "button-icon";
  node.innerHTML = `<i data-lucide="${name}"></i>`;
  return node;
}

function assetGroups(survey: SurveyRecord): Array<{ id: "moc" | "geometry" | "package" | "evidence"; label: string; icon: string; records: AssetRecord[] }> {
  return assetGroupDefinitions.map((definition) => ({
    ...definition,
    records: survey.assets.filter((asset) => definition.kinds.includes(asset.kind)),
  }));
}

function initializeModalityFilter(): void {
  if (modalityFilterInitialized || !surveyIndex) return;
  surveyIndex.surveys.flatMap((survey) => survey.modalities).forEach((modality) => selectedModalities.add(modality));
  modalityFilterInitialized = true;
}

function renderSurveyFilterOptions(): void {
  initializeModalityFilter();
  const host = byId("survey-filter-options");
  const modalities = [...selectedModalities, ...((surveyIndex?.surveys.flatMap((survey) => survey.modalities) ?? []).filter((modality) => !selectedModalities.has(modality)))];
  const unique = [...new Set(modalities)].sort((a, b) => modalityLabel(a).localeCompare(modalityLabel(b)));
  host.replaceChildren(...unique.map((modality) => {
    const label = document.createElement("label");
    label.className = "survey-filter-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selectedModalities.has(modality);
    input.dataset.modality = modality;
    input.addEventListener("change", () => {
      const previouslySelectedProducts = new Set(selectedCoverageProductIds);
      if (input.checked) selectedModalities.add(modality);
      else selectedModalities.delete(modality);
      renderSurveys();
      updateSurveyFilterCount();
      coverageDots?.setVisibleModalities(selectedModalities);
      const availableProductIds = new Set(filterByModalities(coverageCatalog?.layers ?? [], selectedModalities).map((layer) => layer.layerId));
      selectedCoverageProductIds.clear();
      for (const layerId of previouslySelectedProducts) if (availableProductIds.has(layerId)) selectedCoverageProductIds.add(layerId);
      renderCoverageLayers();
      commitCoverageProductSelection();
    });
    const name = document.createElement("span");
    name.textContent = modalityLabel(modality);
    const count = document.createElement("small");
    count.textContent = String(surveyIndex?.surveys.filter((survey) => survey.modalities.includes(modality)).length ?? 0);
    label.append(input, name, count);
    return label;
  }));
  updateSurveyFilterCount();
}

function updateSurveyFilterCount(): void {
  const total = surveyIndex?.surveys.flatMap((survey) => survey.modalities).filter((modality, index, values) => values.indexOf(modality) === index).length ?? 0;
  byId("survey-filter-count").textContent = `${selectedModalities.size} / ${total}`;
}

function filteredSurveys(): SurveyRecord[] {
  const surveys = surveyIndex?.surveys ?? [];
  return surveys.filter((survey) => {
    if (selectedModalities.size && !survey.modalities.some((modality) => selectedModalities.has(modality))) return false;
    if (!search) return true;
    return [
    survey.name,
    survey.mission,
    survey.description,
    ...survey.modalities.map((modality) => modalityLabel(modality)),
    ...survey.releases.flatMap((release) => [release.label, ...release.products.flatMap((product) => [product.name, product.description, product.reason, product.manualStep])]),
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(search);
  });
}

function statusDescription(product: SurveyProduct): string {
  if (product.status === "acquired") return "已收录实际 HEALPix 覆盖与可复核来源。";
  return product.reason ?? "该公开产品当前尚未进入可复核覆盖发布包。";
}

function showSurveyProducts(survey: SurveyRecord): void {
  byId("dialog-kind").textContent = "PUBLIC PRODUCTS";
  const content = byId("dialog-content");
  content.replaceChildren();
  const header = document.createElement("header");
  header.className = "survey-dialog-header";
  const title = document.createElement("div");
  const overline = document.createElement("p"); overline.textContent = `${survey.mission} · ${survey.statistics.acquired} 已收录 / ${survey.statistics.publicProducts} 公开`;
  const heading = document.createElement("h2"); heading.textContent = `${survey.name} 产品收录情况`;
  const description = document.createElement("span"); description.textContent = "已收录表示已发布可复核的产品级覆盖；未收录产品会保留公开来源与下一步计算说明。";
  title.append(overline, heading, description);
  header.append(title);
  content.append(header);

  const list = document.createElement("div");
  list.className = "product-list";
  for (const release of survey.releases) {
    const releaseBanner = document.createElement("div");
    releaseBanner.className = "release-order-banner";
    releaseBanner.textContent = `${release.label} · ${orderSummaryLabel(release.coverageOrders)}`;
    list.append(releaseBanner);
    for (const product of release.products) {
      const row = document.createElement("section");
      row.className = "product-row";
      const identity = document.createElement("div");
      const releaseLabel = document.createElement("span"); releaseLabel.className = "product-release"; releaseLabel.textContent = release.label;
      const name = document.createElement("strong"); name.textContent = product.name;
      const detail = document.createElement("p"); detail.textContent = product.description;
      const order = document.createElement("code"); order.className = "product-order"; order.textContent = orderLabel(product.coverage);
      identity.append(releaseLabel, name, order, detail);
      const status = document.createElement("div"); status.className = "product-status";
      const pill = document.createElement("span"); pill.className = "status-pill"; pill.dataset.status = product.status; pill.textContent = statusLabel(product.status);
      const note = document.createElement("p"); note.textContent = statusDescription(product);
      status.append(pill, note);
      const actions = document.createElement("div"); actions.className = "product-actions";
      const modality = document.createElement("span"); modality.className = "modality-tag"; modality.textContent = modalityLabel(product.modality);
      const source = document.createElement("a"); source.className = "inline-link"; source.href = product.sourceUrl; source.target = "_blank"; source.rel = "noreferrer"; source.textContent = "公开来源"; source.append(icon("external-link"));
      actions.append(modality, source);
      if (product.manualStep) {
        const next = document.createElement("p"); next.className = "product-next-step"; next.textContent = `下一步：${product.manualStep}`;
        actions.append(next);
      }
      row.append(identity, status, actions);
      list.append(row);
    }
  }
  content.append(list);
  byId<HTMLDialogElement>("survey-dialog").showModal();
  renderIcons();
}

function showAssetGroup(survey: SurveyRecord, label: string, records: AssetRecord[]): void {
  byId("dialog-kind").textContent = label.toUpperCase();
  const content = byId("dialog-content");
  content.replaceChildren();
  const header = document.createElement("header");
  header.className = "survey-dialog-header";
  const overline = document.createElement("p"); overline.textContent = `${survey.name} · ${records.length} 个可下载文件`;
  const heading = document.createElement("h2"); heading.textContent = `${label} 下载`;
  const description = document.createElement("span"); description.textContent = "每个文件都经过发布 manifest 校验，并提供原始 SHA-256。";
  header.append(overline, heading, description);
  content.append(header);

  const list = document.createElement("div");
  list.className = "asset-download-list";
  for (const record of records) {
    const row = document.createElement("article");
    row.className = "asset-download-row";
    const assetCopy = document.createElement("div");
    const title = document.createElement("strong"); title.textContent = record.label;
    const description = document.createElement("p"); description.textContent = record.description;
    const metadata = document.createElement("code"); metadata.textContent = `${record.downloadName} · ${bytes(record.sizeBytes)} · ${record.sha256}`;
    assetCopy.append(title, description, metadata);
    const actions = document.createElement("div"); actions.className = "asset-download-actions";
    const copyHash = document.createElement("button"); copyHash.className = "icon-button"; copyHash.type = "button"; copyHash.title = "复制 SHA-256"; copyHash.setAttribute("aria-label", `复制 ${record.label} 的 SHA-256`); copyHash.append(icon("copy")); copyHash.addEventListener("click", () => void copy(record.sha256));
    const download = document.createElement("a"); download.className = "download-button"; download.href = record.downloadUrl; download.title = `下载 ${record.downloadName}`; download.setAttribute("aria-label", `下载 ${record.label}`); download.append(icon("download"));
    actions.append(copyHash);
    if (record.previewUrl && record.previewMode) {
      const preview = document.createElement("button"); preview.className = "icon-button"; preview.type = "button"; preview.title = `预览 ${record.downloadName}`; preview.setAttribute("aria-label", `预览 ${record.label}`); preview.append(icon("eye")); preview.addEventListener("click", () => void showAssetPreview(record));
      actions.append(preview);
    }
    actions.append(download);
    row.append(assetCopy, actions);
    list.append(row);
  }
  content.append(list);
  byId<HTMLDialogElement>("survey-dialog").showModal();
  renderIcons();
}

async function showAssetPreview(record: AssetRecord): Promise<void> {
  if (!record.previewUrl || !record.previewMode) return;
  const dialog = byId<HTMLDialogElement>("preview-dialog");
  byId("preview-kind").textContent = record.previewMode === "image" ? "IMAGE PREVIEW" : "TEXT PREVIEW";
  const content = byId("preview-content");
  const header = document.createElement("header"); header.className = "survey-dialog-header";
  const overline = document.createElement("p"); overline.textContent = `${record.mediaType} · ${bytes(record.sizeBytes)}`;
  const heading = document.createElement("h2"); heading.textContent = record.downloadName;
  const hash = document.createElement("code"); hash.className = "preview-hash"; hash.textContent = `SHA-256 ${record.sha256}`;
  header.append(overline, heading, hash);
  const body = document.createElement("div"); body.className = "preview-body"; body.textContent = "正在载入预览…";
  content.replaceChildren(header, body);
  dialog.showModal();
  renderIcons();
  try {
    if (record.previewMode === "image") {
      const image = document.createElement("img"); image.className = "preview-image"; image.src = record.previewUrl; image.alt = `${record.label} 预览`;
      body.replaceChildren(image);
      return;
    }
    const response = await fetch(record.previewUrl, { headers: { Accept: "text/plain, application/json" } });
    if (!response.ok) throw new Error(`预览请求失败（${response.status}）`);
    const pre = document.createElement("pre"); pre.className = "preview-text"; pre.textContent = await response.text();
    body.replaceChildren(pre);
  } catch (error) {
    body.className = "preview-body preview-error";
    body.textContent = error instanceof Error ? error.message : "无法载入文件预览";
  }
}

function renderSurveys(): void {
  const surveys = filteredSurveys();
  byId("survey-count").textContent = `${surveys.length} / ${surveyIndex?.surveys.length ?? 0} 个巡天`;
  const list = byId("survey-list");
  if (!surveys.length) {
    list.replaceChildren(Object.assign(document.createElement("div"), { className: "empty-row", textContent: "没有匹配的巡天或公开产品" }));
    return;
  }
  list.replaceChildren(...surveys.map((survey) => {
    const row = document.createElement("article");
    row.className = "survey-row";
    row.dataset.surveyId = survey.id;
    row.style.setProperty("--survey-color", surveyColorFor(survey.id, survey.color));
    row.setAttribute("aria-label", `${survey.name}，${survey.mission}，${survey.statistics.acquired} 个已收录产品`);

    const marker = document.createElement("span"); marker.className = "survey-marker"; marker.setAttribute("aria-hidden", "true");
    const visual = document.createElement("div"); visual.className = "survey-thumb"; visual.dataset.miniGlobe = survey.id;
    const image = document.createElement("img"); image.src = survey.imageUrl; image.alt = ""; image.loading = "lazy";
    const miniGlobe = document.createElement("span");
    miniGlobe.className = "survey-mini-globe";
    miniGlobe.dataset.surveyId = survey.id;
    miniGlobe.setAttribute("aria-hidden", "true");
    visual.append(image, miniGlobe);

    const identity = document.createElement("div"); identity.className = "survey-identity";
    const overline = document.createElement("span"); overline.className = "survey-overline"; overline.textContent = survey.mission;
    const heading = document.createElement("h3"); heading.textContent = survey.name;
    const description = document.createElement("p"); description.textContent = survey.description;
    const tags = document.createElement("div"); tags.className = "modality-tags";
    survey.modalities.forEach((modality) => { const tag = document.createElement("span"); tag.className = "modality-tag"; tag.textContent = modalityLabel(modality); tags.append(tag); });
    identity.append(overline, heading, description, tags);

    const metrics = document.createElement("dl"); metrics.className = "survey-metrics";
    const addMetric = (label: string, value: string, emphasis = false): void => {
      const cell = document.createElement("div");
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = value; if (emphasis) dd.className = "metric-emphasis";
      cell.append(dt, dd); metrics.append(cell);
    };
    addMetric("PUBLIC PRODUCTS", `${survey.statistics.acquired} / ${survey.statistics.publicProducts}`, true);
    addMetric("HEALPIX CELLS", survey.statistics.footprintCells ? survey.statistics.footprintCells.toLocaleString("en-US") : "--");
    addMetric("HEALPIX ORDER", orderSummaryLabel(survey.coverageOrders));

    const actions = document.createElement("div"); actions.className = "survey-actions";
    const skyAction = document.createElement("button");
    skyAction.type = "button";
    skyAction.className = "asset-action sky-action";
    skyAction.title = `${survey.name} · ${t("coverage.enterSurvey")}`;
    skyAction.append(icon("telescope"));
    const skyLabel = document.createElement("span"); skyLabel.textContent = t("coverage.enterSurvey"); skyAction.append(skyLabel);
    skyAction.addEventListener("click", () => enterAtlasExperience(survey.id));
    actions.append(skyAction);
    const detail = document.createElement("button"); detail.type = "button"; detail.className = "text-action"; detail.title = `查看 ${survey.name} 产品`; detail.append(icon("list-checks")); const detailLabel = document.createElement("span"); detailLabel.textContent = "产品详情"; detail.append(detailLabel); detail.addEventListener("click", () => showSurveyProducts(survey));
    actions.append(detail);
    assetGroups(survey).forEach((group) => {
      const action = document.createElement("button"); action.type = "button"; action.className = "asset-action";
      action.disabled = !group.records.length;
      action.title = group.records.length ? `查看 ${survey.name} 的${group.label}` : `${survey.name} 暂无已发布${group.label}`;
      action.append(icon(group.icon));
      const label = document.createElement("span"); label.textContent = group.label;
      const count = document.createElement("small"); count.textContent = group.records.length ? String(group.records.length) : "--";
      action.append(label, count);
      if (group.records.length) action.addEventListener("click", () => showAssetGroup(survey, group.label, group.records));
      actions.append(action);
    });

    row.append(marker, visual, identity, metrics, actions);
    return row;
  }));
  renderIcons();
}

async function fetchCoverageCatalogDocument(): Promise<CoverageCatalog> {
  const headers = new Headers({ Accept: "application/json" });
  const response = await fetchPublicResponse("/api/v1/coverage/catalog", { headers, cache: "no-store" });
  if (response.status === 304) throw new Error("Coverage catalog returned 304 without a cached response");
  const next = await response.json() as unknown;
  if (!isCoverageCatalog(next)) throw new Error("Coverage catalog response is invalid");
  return next;
}

async function hydrateCoverageCatalogInternal(nextCatalog: CoverageCatalog): Promise<void> {
  const previousCatalog = coverageCatalog;
  const previousSelectedProducts = new Set(selectedCoverageProductIds);
  const revisionChanged = Boolean(previousCatalog && coverageCatalogRevisionKey(previousCatalog) !== coverageCatalogRevisionKey(nextCatalog));
  coverageCatalog = nextCatalog;
  if (revisionChanged) {
    coverageBlockCache.clear();
    displayTileIndexCache.clear();
    displayTileIndexCachedRangeCount = 0;
    coverageDisplayViewKey = "";
    cancelCoverageDisplayRequest();
    overlapEvidenceCache.clear();
    overlapDetailsCache.clear();
    overlapController?.abort();
    overlapController = null;
    lastOverlapViewKey = "";
    activeOverlapOverviewKey = "";
    activeOverlapPixels = [];
    activeOverlapComponents = [];
  }
  coverageLayerLoadStates.clear();
  coverageLayerLoadErrors.clear();
  const blocks = new Map<string, number[]>();
  if (coverageDots) {
    const booting = bootActive();
    if (booting) bootStage("layers", "run", 0, nextCatalog.layers.length);
    await Promise.all(nextCatalog.layers.map(async (layer) => {
      try {
        const cells = await fetchCoverageOverview(layer);
        if (cells.length) blocks.set(`${layer.layerId}:${layer.overviewOrder}`, cells);
      } finally {
        if (booting) bootTick("layers");
      }
    }));
    if (booting) { bootStage("layers", "done"); bootStage("scene", "run"); }
    const availableSurveys = new Set(nextCatalog.layers.map((layer) => layer.surveyId));
    await coverageDots.loadCatalog(nextCatalog, blocks, surveyIndex?.surveys ?? []);
    if (coverageSelectionInitialized) {
      const selected = [...queuedLayerIds].filter((surveyId) => availableSurveys.has(surveyId));
      const selectedSet = new Set(selected);
      const retainedProducts = filterByModalities(nextCatalog.layers, selectedModalities)
        .filter((layer) => selectedSet.has(layer.surveyId) && previousSelectedProducts.has(layer.layerId));
      if (retainedProducts.length) {
        selectedCoverageProductIds.clear();
        retainedProducts.forEach((layer) => selectedCoverageProductIds.add(layer.layerId));
        commitCoverageProductSelection();
      } else {
        applyCoverageSelection(selected);
      }
    } else if (isAtlasPage) {
      // The standalone Atlas starts with an intentional empty selection. The
      // homepage may still use the loaded footprints as its ambient preview,
      // but the interactive page must never imply that every survey is chosen.
      applyCoverageSelection([]);
    } else {
      const allLayerIds = filterByModalities(nextCatalog.layers, selectedModalities).map((layer) => layer.layerId);
      selectedCoverageProductIds.clear();
      allLayerIds.forEach((layerId) => selectedCoverageProductIds.add(layerId));
      const allSurveys = new Set(nextCatalog.layers.map((layer) => layer.surveyId));
      coverageDots.setVisibleSurveys(allSurveys);
      coverageDots.setVisibleLayers(selectedCoverageProductIds);
      clampDisplayOrderToSelection();
      void loadCoverageDisplay();
    }
    coverageDots.transitionToDataView(1);
    renderCoverageLayers();
    renderHudRosterNow();
    hudLog(["COVERAGE SYNC · ", { text: `${nextCatalog.layers.length} LAYERS`, tone: "ind" }, ...(nextCatalog.revision ? [` · REV ${nextCatalog.revision.slice(0, 8)}`] : [])]);
    updateCoverageReadout(activeSurveyId);
    renderCoverageLoadDiagnostics();
    if (revisionChanged && overlapMode && visibleSurveyIdsFromControls().length >= 2) void activateOverlap(true);
  }
}

const coverageHydration = createRevisionHydrationQueue(coverageCatalogRevisionKey, hydrateCoverageCatalogInternal);

function hydrateCoverageCatalog(nextCatalog: CoverageCatalog, force = false): Promise<void> {
  const statusNode = document.getElementById("warehouse-geometry-status");
  if (statusNode) {
    const notice = warehouseGeometryNotice(nextCatalog.warehouseGeometry);
    statusNode.hidden = !notice;
    statusNode.replaceChildren(...(notice ? [notice] : []));
  }
  return coverageHydration.enqueue(nextCatalog, force);
}

function warehouseGeometryNotice(status?: WarehouseGeometryLoadStatus): HTMLDetailsElement | undefined {
  if (status?.status !== "degraded" || (!status.failures.length && !status.error)) return undefined;
  const notice = document.createElement("details");
  notice.className = "warehouse-geometry-notice";
  notice.append(Object.assign(document.createElement("summary"), { textContent: t("coverage.warehouseGeometryIncomplete") }));
  notice.append(Object.assign(document.createElement("p"), { textContent: t("coverage.warehouseGeometryRetained") }));
  if (status.error) notice.append(Object.assign(document.createElement("p"), { textContent: status.error }));
  if (status.failures.length) {
    const list = document.createElement("ul");
    for (const failure of status.failures) {
      const item = document.createElement("li");
      item.textContent = `${[failure.surveyId, failure.releaseId, failure.product ?? failure.layerId].filter(Boolean).join(" · ")}: ${failure.reason}`;
      list.append(item);
    }
    notice.append(list);
  }
  return notice;
}

function retryCoverageSurvey(surveyId: string): void {
  if (!coverageCatalog) return;
  const layer = coverageCatalog.layers.find((candidate) => candidate.surveyId === surveyId);
  if (!layer) return;
  coverageLayerLoadStates.set(layer.layerId, "loading");
  renderCoverageLayers();
  void hydrateCoverageCatalog(coverageCatalog, true).catch((error) => {
    byId("coverage-state").textContent = error instanceof Error ? error.message : "COVERAGE RETRY FAILED";
  });
}

function applySkyDeepLink(): void {
  deepLinkTarget = readSkyDeepLink();
  if (!deepLinkTarget) return;
  if (deepLinkTarget.error) {
    if (deepLinkTarget.surveyId && surveyIndex?.surveys.some((survey) => survey.id === deepLinkTarget?.surveyId)) {
      enterAtlasExperience(deepLinkTarget.surveyId, deepLinkTarget.productId);
      deepLinkTarget = { ...deepLinkTarget };
    }
    byId("coverage-state").textContent = deepLinkTarget.error ?? "PRODUCT DEEP LINK INVALID";
    return;
  }
  if (!deepLinkTarget.surveyId) {
    byId("coverage-state").textContent = "PRODUCT DEEP LINK HAS NO PUBLIC SURVEY";
    return;
  }
  if (!surveyIndex?.surveys.some((survey) => survey.id === deepLinkTarget?.surveyId)) {
    byId("coverage-state").textContent = "SURVEY DEEP LINK NOT FOUND";
    return;
  }
  enterAtlasExperience(deepLinkTarget.surveyId, deepLinkTarget.productId);
}

async function initialize(): Promise<void> {
  const zh = locale() === "zh";
  const booting = isAtlasPage && startHudBoot(zh
    ? { surveys: "巡天目录 · SURVEY INDEX", catalog: "覆盖目录 · COVERAGE CATALOG", layers: "覆盖图层 · LAYER OVERVIEWS", scene: "天球场景 · SKY SCENE" }
    : { surveys: "SURVEY INDEX", catalog: "COVERAGE CATALOG", layers: "LAYER OVERVIEWS", scene: "SKY SCENE" },
  zh ? "正在初始化天球 · INITIALISING ATLAS" : "INITIALISING ATLAS");
  try {
    coverageDots = new AtlasCoverageGlobe(byId("coverage-scene"), byId<HTMLCanvasElement>("coverage-canvas"), updateCoverageReadout, updateCoverageInspector, updateCoverageState, openCoverageContextMenu, handleOverlapComponentLabel, showOverlapRegionTooltip,
      (rectangle, phase) => regionPanel?.rectangleChanged(rectangle, phase));
    if (isAtlasPage) regionPanel = new RegionQueryPanel({ layers: visibleCoverageLayers,
      draw: enabled => coverageDots?.setRectangleDrawing(enabled), outline: rectangle => coverageDots?.setRectangleSelection(rectangle),
      query: queryRectangle, cancel: cancelRegionQuery });
    // The low tactical camera reads best with survey shells packed close to one surface.
    if (isAtlasPage) coverageDots.setLayerRadiusRange(0.994, 1.006);
  } catch (error) {
    console.warn("HEALPix globe unavailable", error);
    byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
  }
  const assetsPromise = (async (): Promise<ReleaseManifest | null> => {
    try {
      const value = await fetchPublicJson<unknown>("/api/v1/assets", { headers: { Accept: "application/json" } });
      if (!isReleaseManifest(value)) throw new Error("Public asset catalog response is invalid");
      return value;
    } catch (error) {
      console.warn("Public asset catalog unavailable", error);
      return null;
    }
  })();

  let surveysResult: SurveyIndex | null = null;
  if (booting) bootStage("surveys", "run");
  try {
    const value = await fetchPublicJson<unknown>("/api/v1/surveys", { headers: { Accept: "application/json" } });
    if (!isSurveyIndex(value)) throw new Error("Public survey catalog response is invalid");
    surveysResult = value;
    surveyIndex = value;
    initializeModalityFilter();
    renderSurveys();
    if (booting) bootStage("surveys", "done");
  } catch (error) {
    if (booting) bootStage("surveys", "fail");
    console.warn("Public survey catalog unavailable", error);
    byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: t("coverage.catalogLoadFailed") }));
  }

  let coverageResult: CoverageCatalog | null = null;
  if (surveysResult) {
    // Keep the catalog and URL state usable even when the optional WebGL
    // viewer could not be created (for example, in a headless browser).
    try {
      if (booting) bootStage("catalog", "run");
      coverageResult = await fetchCoverageCatalogDocument();
      if (booting) bootStage("catalog", "done");
      await hydrateCoverageCatalog(coverageResult);
      if (booting) { bootStage("scene", "done"); finishHudBoot(); }
      if (isAtlasPage) maybeStartAtlasGuide();
      applySkyDeepLink();
      if (isAtlasPage && new URLSearchParams(location.search).get("depth") === "desi") void openDepthExample();
    } catch (error) {
      console.warn("Public coverage catalog unavailable", error);
      byId("coverage-state").textContent = "COVERAGE CATALOG UNAVAILABLE";
      if (booting) { bootStage("catalog", "fail"); finishHudBoot(zh ? "覆盖目录暂不可用，已进入离线视图" : "COVERAGE CATALOG UNAVAILABLE · OPENING WITHOUT LAYERS"); }
    }
  } else {
    byId("coverage-state").textContent = "COVERAGE CATALOG UNAVAILABLE";
    if (booting) finishHudBoot(zh ? "巡天目录暂不可用，请稍后刷新" : "SURVEY INDEX UNAVAILABLE · PLEASE RETRY LATER");
  }

  const assetsResult = await assetsPromise;
  if (assetsResult) {
    manifest = assetsResult;
    byId("footer-release").textContent = `${manifest.bundle.id.toUpperCase()} · VERIFIED`;
    byId("stat-releases").textContent = String(manifest.statistics.releases);
    byId("stat-acquired").textContent = String(manifest.statistics.acquired);
    byId("stat-moc").textContent = String(manifest.statistics.rawMocFiles);
    byId("stat-packages").textContent = String(manifest.statistics.packages);
    byId("stat-size").textContent = bytes(manifest.statistics.runtimeBytes ?? manifest.statistics.totalBytes);
    setTextIfPresent("home-stat-releases", String(manifest.statistics.releases));
    byId("bundle-hash").textContent = manifest.bundle.sha256;
    byId("generated-at").textContent = new Date(manifest.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" }) + " UTC";
    const provenance = manifest.files.find((record) => record.kind === "provenance");
    if (provenance) byId<HTMLAnchorElement>("provenance-download").href = provenance.downloadUrl;
  }
}

byId<HTMLInputElement>("survey-search").addEventListener("input", (event) => {
  search = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
  renderSurveys();
});
byId("survey-filter-toggle").addEventListener("click", () => {
  renderSurveyFilterOptions();
  byId<HTMLDialogElement>("survey-filter-dialog").showModal();
});
byId("survey-filter-close").addEventListener("click", () => byId<HTMLDialogElement>("survey-filter-dialog").close());
byId<HTMLDialogElement>("survey-filter-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) byId<HTMLDialogElement>("survey-filter-dialog").close();
});
byId("copy-bundle-hash").addEventListener("click", () => { if (manifest) void copy(manifest.bundle.sha256); });
byId("dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("survey-dialog").close());
byId<HTMLDialogElement>("survey-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) byId<HTMLDialogElement>("survey-dialog").close(); });
byId("preview-close").addEventListener("click", () => byId<HTMLDialogElement>("preview-dialog").close());
byId<HTMLDialogElement>("preview-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) byId<HTMLDialogElement>("preview-dialog").close(); });
function clearCoverageFocus(openLayers = true): void {
  regionPanel?.close();
  activeRegionQuery = null;
  hideCoverageLayerTooltip();
  closeSkyDepth();
  cancelDisplayOrderInteraction();
  cancelCoverageDisplayRequest();
  coverageFocusActive = false;
  coverageDisplayStatus = null;
  closeCoverageContextMenu();
  closeOverlapDrawer();
  clearLayerCloseTimer();
  setOverlapMode(false);
  overlapController?.abort();
  overlapController = null;
  activeOverlapSurveyIds = [];
  activeOverlapModalities = [];
  activeOverlapComponents = [];
  overlapEvidenceCache.clear();
  overlapDetailsCache.clear();
  coverageDots?.setOverlapMode(false);
  coverageDots?.setActiveOverlapComponent(null);
  updateOverlapHud(null);
  if (openLayers) setCoverageLayersOpen(true);
  coverageDots?.clearSelection();
  coverageDots?.resetView();
  renderDisplayOrderControl();
  void loadCoverageDisplay(true);
  const panel = byId("coverage-detail-panel");
  abortHstLookupsWithin(byId("coverage-detail-content"));
  panel.hidden = true;
  panel.classList.remove("is-overlap-panel");
  panel.style.removeProperty("left");
  panel.style.removeProperty("top");
  panel.style.removeProperty("right");
  panel.style.removeProperty("width");
  setOverlapExpandVisible(false);
  updateCoverageInspector(null);
  updateCoverageReadout(null);
}

function resetCoverageExperience(updateUrl = true, preserveLayers = false): void {
  if (!preserveLayers) applyCoverageSelection([]);
  deepLinkTarget = null;
  if (updateUrl) syncSkyDeepLink();
  clearCoverageFocus(false);
  document.body.dataset.homeState = "atlas";
  document.documentElement.style.overflow = "";
  const atlasScene = document.getElementById("coverage-scene");
  if (atlasScene) {
    atlasScene.style.opacity = "1";
    atlasScene.style.pointerEvents = "auto";
  }
}

byId("coverage-reset").addEventListener("click", () => {
  if (isAtlasInteractive()) resetCoverageExperience();
});
function skyDepthSources(): SkyDepthSelection["sources"] {
  return withDesiReference([...new Map(visibleCoverageLayers().map(layer => [`${layer.surveyId}:${layer.releaseId}`, { surveyId: layer.surveyId, releaseId: layer.releaseId }])).values()]);
}
function withDesiReference(sources: SkyDepthSelection["sources"]): SkyDepthSelection["sources"] {
  const hasDesiDr1 = sources.some(source => source.surveyId === "desi" && source.releaseId === "desi-dr1");
  const hasOtherSurvey = sources.some(source => source.surveyId !== "desi" || source.releaseId !== "desi-dr1");
  return hasOtherSurvey && !hasDesiDr1 ? [...sources, { surveyId: "desi", releaseId: "desi-dr1", role: "reference" }] : sources;
}
function closeSkyDepth(): void {
  skyDepthOpening++; skyDepthSelectionKey = ""; skyDepthSelection = null; skyDepthControls?.close(); skyDepthControls = null;
}
async function showSkyDepth(selection: SkyDepthSelection, retry = false): Promise<void> {
  const host = document.getElementById("coverage-depth-panel");
  if (!host || selection.order < 4 || !selection.cells.length || !selection.sources.length) { closeSkyDepth(); return; }
  const key = JSON.stringify([selection.order, [...selection.cells].sort((a,b)=>a-b), selection.sources.map(source=>`${source.surveyId}:${source.releaseId}:${source.role ?? "survey"}`).sort()]);
  if (key === skyDepthSelectionKey) { if (retry) skyDepthControls?.updateSelection(selection, true); return; }
  skyDepthSelectionKey = key;
  skyDepthSelection = selection;
  if (skyDepthControls) { skyDepthControls.updateSelection(selection); return; }
  const request = ++skyDepthOpening;
  try {
    const { openSkyDepth } = await import("./atlas/sky-depth-panel.js");
    if (request !== skyDepthOpening || !coverageDots) return;
    skyDepthControls = openSkyDepth(selection, coverageDots, host);
  } catch {
    if (request === skyDepthOpening) closeSkyDepth();
  }
}
async function openDepthExample(): Promise<void> {
  if (!coverageCatalog) return;
  try {
    const example = await fetchPublicJson<SkyDepthExample>("/api/v1/sky-depth/example");
    if (!example.available || !example.selection) throw Error(locale() === "zh" ? "DESI 纵深示例暂时不可用" : "DESI depth example is unavailable");
    const selection = example.selection;
    resetCoverageExperience();
    applyCoverageSelection(["desi"]);
    for (const layer of coverageCatalog.layers) {
      if (!selection.sources.some(source => source.surveyId === layer.surveyId && source.releaseId === layer.releaseId)) selectedCoverageProductIds.delete(layer.layerId);
    }
    selectedDisplayOrder = selection.order;
    syncCoverageProductControls(); renderDisplayOrderControl();
    coverageDots?.setVisibleLayers(selectedCoverageProductIds);
    await loadCoverageDisplay(true);
    coverageDots?.selectPixels(selection.order, selection.cells);
    coverageDots?.focusPixels(selection.order, selection.cells);
    updateCoverageReadout("desi");
    // This developer preview selects a real cell; normal selection loads its depth.
  } catch (error) {
    byId("coverage-state").textContent = error instanceof Error ? error.message : "DEPTH EXAMPLE UNAVAILABLE";
  }
}
const displayOrderSlider = document.getElementById("coverage-display-order") as HTMLInputElement | null;
const displayOrderControl = displayOrderSlider?.closest<HTMLElement>(".coverage-display-order-control");
const displayOrderHome = displayOrderControl?.parentElement;
const displayOrderNextSibling = displayOrderControl?.nextSibling;
displayOrderSlider?.addEventListener("input", previewDisplayOrderControlValue);
displayOrderSlider?.addEventListener("change", scheduleDisplayOrderChange);
displayOrderSlider?.addEventListener("pointerdown", () => {
  displayOrderDragging = true;
  if (displayOrderTimer !== null) window.clearTimeout(displayOrderTimer);
  displayOrderTimer = null;
});
window.addEventListener("pointerup", () => {
  if (!displayOrderDragging) return;
  displayOrderDragging = false;
  scheduleDisplayOrderChange();
});
displayOrderSlider?.addEventListener("pointercancel", () => {
  cancelDisplayOrderInteraction();
  renderDisplayOrderControl();
});
byId("overlap-expand").addEventListener("click", () => openOverlapDrawer());
byId("overlap-drawer-close").addEventListener("click", () => closeOverlapDrawer());
byId("coverage-layers-toggle").addEventListener("click", () => {
  if (!isAtlasInteractive()) return;
  if (overlapDrawerOpen) {
    closeOverlapDrawer();
    return;
  }
  setCoverageLayersOpen(document.body.dataset.layersPanel !== "open");
});
window.addEventListener("resize", () => {
  const layers = document.getElementById("coverage-layers");
  if (layers) layers.hidden = document.body.dataset.layersPanel !== "open" && !layersPanelDocked();
});
byId("coverage-help-toggle").addEventListener("click", () => {
  if (!isAtlasInteractive()) return;
  byId("coverage-help").hidden = !byId("coverage-help").hidden;
});
byId("coverage-help-close").addEventListener("click", () => { byId("coverage-help").hidden = true; });
document.getElementById("coverage-guide-replay")?.addEventListener("click", () => { byId("coverage-help").hidden = true; openAtlasGuide(); });
document.getElementById("hud-toggle")?.addEventListener("click", () => setHudHidden(document.body.dataset.hud !== "hidden"));
applyHudPreferences();

function enterAtlasExperience(surveyId?: string, productId?: string): void {
  const selectedSurveyId = surveyId ?? deepLinkTarget?.surveyId;
  if (selectedSurveyId) applyCoverageSelection([selectedSurveyId]);
  else applyCoverageSelection([]);
  deepLinkTarget = selectedSurveyId ? { surveyId: selectedSurveyId, ...(productId ? { productId } : {}) } : null;
  syncSkyDeepLink(selectedSurveyId, productId);
  document.body.dataset.homeState = "atlas";
  coverageDots?.transitionToDataView(420);
  focusSkyTarget(deepLinkTarget);
  renderSelectionQueue();
}

window.addEventListener("popstate", () => {
  if (!surveyIndex || !coverageCatalog) return;
  const target = readSkyDeepLink();
  if (!target) {
    deepLinkTarget = null;
    resetCoverageExperience(false);
    return;
  }
  if (target.error) {
    if (target.surveyId && surveyIndex.surveys.some((survey) => survey.id === target.surveyId)) {
      enterAtlasExperience(target.surveyId, target.productId);
      deepLinkTarget = { ...target };
    }
    byId("coverage-state").textContent = target.error;
    return;
  }
  if (!target.surveyId) {
    byId("coverage-state").textContent = "PRODUCT DEEP LINK HAS NO PUBLIC SURVEY";
    return;
  }
  enterAtlasExperience(target.surveyId, target.productId);
});

window.addEventListener("pagehide", () => {
  hideCoverageLayerTooltip();
  hideOverlapRegionTooltip();
});

window.addEventListener("resize", () => {
  positionSelectionQueue();
  positionOverlapPanel();
  positionCoverageLayerTooltip();
  updateOverlapViewport();
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target && (target.matches("input, textarea, select") || target.isContentEditable)) return;
  if (!isAtlasInteractive()) return;
  if (event.key === "Escape") {
    if (regionPanel?.isOpen) { event.preventDefault(); regionPanel.close(); return; }
    const now = performance.now();
    if (overlapDrawerOpen) {
      closeOverlapDrawer();
      lastEscapeAt = -Infinity;
      return;
    }
    const intent = coverageEscapeIntent({ overlapDrawerOpen: false, now, lastEscapeAt });
    if (intent === "reset-experience") {
      lastEscapeAt = -Infinity;
      resetCoverageExperience(true, true);
    } else {
      lastEscapeAt = now;
      clearCoverageFocus(true);
    }
    return;
  }
  if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    resetCoverageExperience();
    return;
  }
  if (event.key.toLowerCase() === "f") {
    event.preventDefault();
    focusCoverageSelection();
  }
  if (event.key.toLowerCase() === "e" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const state = coverageDots?.state;
    if (overlapMode && selectedQueueComponent) {
      selectOverlapComponent(selectedQueueComponent);
    } else if (state?.selectedPixels.length) {
      exportCoverageCells([], state.selectedPixels, Math.round(Math.log2(state.nside)));
    } else if (activeRegionQuery) {
      regionPanel?.open();
    } else regionPanel?.open(true);
  }
  if (event.key.toLowerCase() === "h" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    setHudHidden(document.body.dataset.hud !== "hidden");
  }
  if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const row = document.querySelector<HTMLElement>(`#coverage-layers [data-hud-key="${event.key}"]`)?.closest<HTMLElement>(".coverage-survey-group");
    if (row?.dataset.surveyId) {
      event.preventDefault();
      toggleRosterSurvey(row.dataset.surveyId);
    }
  }
  if (event.key.toLowerCase() === "g") {
    event.preventDefault();
    void activateOverlap();
  }
});

document.addEventListener("pointerdown", (event) => {
  const menu = byId("coverage-context-menu");
  if (!menu.hidden && !menu.contains(event.target as Node)) closeCoverageContextMenu();
});

window.addEventListener("atlas:locale-change", () => {
  hideOverlapRegionTooltip();
  const depthSelection = skyDepthSelection;
  closeSkyDepth();
  if (depthSelection) void showSkyDepth(depthSelection);
  if (coverageCatalog) void hydrateCoverageCatalog(coverageCatalog);
  renderDisplayOrderControl();
  updateCoverageReadout(activeSurveyId);
  if (surveyIndex) renderSurveys();
  if (overlapMode && activeOverlapComponents.length) {
    const component = activeOverlapComponents.find((entry) => entry.id === selectedQueueComponent?.id) ?? activeOverlapComponents[0];
    if (component && overlapDrawerOpen) {
      selectedQueueComponent = component;
      renderOverlapDrawerComponents();
      drawerDetailsShownKey = "";   // translated text must be rebuilt
      renderOverlapDrawerDetails(component);
    } else if (component) {
      renderOverlapPanel(activeOverlapSurveyIds, [...new Set(activeOverlapComponents.flatMap((entry) => entry.cells))], component.order, "GLOBAL", activeOverlapComponents, false);
    }
  }
  if (surveyIndex) renderSurveyFilterOptions();
  renderSelectionQueue();
});

window.addEventListener("atlas:theme-change", () => {
  coverageDots?.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
});

renderIcons();
void initialize().catch((error) => {
  console.error(error);
  finishHudBoot(locale() === "zh" ? "初始化失败，请稍后刷新" : "INITIALISATION FAILED · PLEASE RETRY");
  byId("coverage-state").textContent = t("coverage.releaseUnavailable");
  if (!surveyIndex) byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: t("coverage.catalogLoadFailed") }));
});
import { readJsonResponse, type JsonStreamEvent } from "./json-stream.js";
