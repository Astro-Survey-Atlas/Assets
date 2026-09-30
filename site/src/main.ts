import { ensureDownloadAccess, hasDownloadAccess, resetDownloadAccess } from "./download-access";
import { BadgeCheck, BookOpen, Box, ChevronLeft, ChevronRight, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Home, Image, Info, Layers3, ListChecks, ListFilter, LoaderCircle, Lock, Maximize2, Minimize2, Moon, Menu, Radio, RotateCcw, ScanLine, Search, ShieldCheck, Sun, Telescope, X, createIcons } from "lucide";
import { Healpix } from "healpixjs";
import { AtlasCoverageGlobe, type CoverageCatalog } from "./atlas-coverage-globe.js";
import { surveyColorFor } from "./atlas/survey-colors.js";
import type { SurveyLayerContextMenu, SurveyLayerInspection, SurveyLayerOverlapComponent, SurveyLayerState } from "./atlas/survey-layer-viewer.js";
import { highestCommonCoverageOrder } from "./atlas/coverage-orders.js";
import { coverageEscapeIntent } from "./atlas/coverage-interaction.js";
import { coverageLayerTooltipPosition } from "./atlas/layer-panel-layout.js";
import { overlapPanelExitTransform, overlapPanelsShouldExit } from "./overlap-layout.js";
import { joinUnique, overlapCsvDocument, overlapCsvRows, type DownloadPlan, type DownloadPlanCoverageEvidence, type DownloadPlanEntrypoint, type DownloadPlanFile, type DownloadPlanMatch } from "./overlap-download.js";
import { locale, mountLocaleControls, t } from "./i18n.js";
import { createRevisionHydrationQueue } from "./revision-hydration-queue.js";
import { mountSiteChrome } from "./site-chrome.js";
import { canonicalModality, filterByModalities } from "../../src/modality-filter.js";

import "./styles.css";

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
let activeSurveyId: string | null = null;
let coverageCatalog: CoverageCatalog | null = null;
let activeOverlapModalities: string[] = [];
const coverageBlockCache = new Map<string, number[]>();
const coverageRequests = new Map<string, Promise<number[]>>();
type CoverageLayerLoadState = "loading" | "ready" | "empty" | "error";
const coverageLayerLoadStates = new Map<string, CoverageLayerLoadState>();
const coverageLayerLoadErrors = new Map<string, string>();
const COVERAGE_CACHE_LIMIT = 128;
interface SkyDeepLinkTarget { surveyId?: string; productId?: string; layerId?: string; error?: string }
let deepLinkTarget: SkyDeepLinkTarget | null = null;
let pendingCoverageState: SurveyLayerState | null = null;
let coverageStateFrame = 0;
let overlapMode = false;
let overlapRequestSequence = 0;
let overlapEvidenceSequence = 0;
let overlapController: AbortController | null = null;
let overlapEvidenceController: AbortController | null = null;
let overlapDetailsController: AbortController | null = null;
let activeOverlapSurveyIds: string[] = [];
let activeOverlapComponents: OverlapComponentView[] = [];
let overlapComponentsPage = 0;
let overlapDrawerComponentsPage = 0;
const hstLookupControllers = new WeakMap<HTMLElement, AbortController>();
const queuedLayerIds = new Set<string>();
let selectedQueueComponent: OverlapComponentView | null = null;
let renderedQueueComponentId: string | null = null;
let overlapDrawerOpen = false;
let overlapPanelResizeObserver: ResizeObserver | null = null;
let overlapDrawerPreviousState: { layersHidden: boolean; queueHidden: boolean; panelHidden: boolean; helpHidden: boolean; guideHidden: boolean } | null = null;
let overlapDrawerPreviousFocus: HTMLElement | null = null;
let layerCloseTimer: number | null = null;
let layerCloseDeadline = 0;
let layerCloseRemaining = 0;
let layerClosePaused = false;
let coverageLayerTooltip: HTMLElement | null = null;
let coverageLayerTooltipRow: HTMLElement | null = null;

function setOverlapMode(active: boolean): void {
  overlapMode = active;
  if (active) document.body.dataset.overlapMode = "active";
  else document.body.removeAttribute("data-overlap-mode");
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
const overlapEvidenceHosts = new Map<string, HTMLElement>();
const overlapDetailsCache = new Map<string, OverlapDetailsResponse>();
let lastEscapeAt = -Infinity;
const isAtlasPage = window.location.pathname === "/atlas/" || window.location.pathname === "/atlas";
let homeEntered = isAtlasPage;
let coverageSelectionInitialized = false;

mountLocaleControls();
mountSiteChrome();

function isAtlasInteractive(): boolean {
  return document.body.dataset.homeState === "atlas";
}

function updateHomeScrollProgress(): void {
  if (homeEntered) return;
  const viewport = Math.max(1, window.innerHeight);
  const progress = Math.min(1, Math.max(0, window.scrollY / (viewport * 0.82)));
  document.body.style.setProperty("--home-scroll-progress", progress.toFixed(4));
  coverageDots?.setHomeScrollProgress(progress);
}

function coverageBlockKey(layer: CoverageCatalog["layers"][number], order: number, tile: number): string {
  return `${layer.layerId}:${layer.revision ?? "legacy"}:${order}:${tile}`;
}

async function fetchCoverageBlock(layer: CoverageCatalog["layers"][number], order: number, tile: number): Promise<number[]> {
  const key = coverageBlockKey(layer, order, tile);
  const cached = coverageBlockCache.get(key);
  if (cached) return cached;
  const inFlight = coverageRequests.get(key);
  if (inFlight) return inFlight;
  const controller = new AbortController();
  const request = (async (): Promise<number[]> => {
    try {
      const revision = layer.revision ? `&revision=${encodeURIComponent(layer.revision)}` : "";
      const response = await fetchPublicResponse(`/api/v1/coverage/blocks/${encodeURIComponent(layer.layerId)}?order=${order}&tile=${tile}${revision}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`coverage block HTTP ${response.status}`);
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
  coverageRequests.set(key, request);
  void request.then(
    () => { if (coverageRequests.get(key) === request) coverageRequests.delete(key); },
    () => { if (coverageRequests.get(key) === request) coverageRequests.delete(key); },
  );
  return request;
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
  return coverageDiagnosticText() ?? defaultValue;
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
  const visualOrders = [...new Set(layers.map((layer) => layer.overviewOrder))].sort((left, right) => left - right);
  const queryOrders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((left, right) => left - right);
  const orderText = visualOrders.length
    ? `VISUAL OVERVIEW · O${visualOrders.join("/O")} · QUERY O${queryOrders.join("/O")}`
    : "NESTED HEALPIX · NSIDE 16";
  if (!survey) {
    if (surveyId && layers.length) {
      scene.style.setProperty("--coverage-color", surveyColorFor(surveyId, layers[0]?.color));
      title.textContent = product ? `${surveyId.toUpperCase()} · ${product.toUpperCase()}` : surveyId.toUpperCase();
      meta.textContent = orderText;
      state.textContent = coverageStateText(`${layers.length} COVERAGE LAYERS · SELECTED`);
      return;
    }
    scene.style.removeProperty("--coverage-color");
    title.textContent = t("coverage.allSurveys");
    meta.textContent = "NESTED HEALPIX · NSIDE 16";
    state.textContent = coverageStateText(coverageDots ? t("coverage.publicCells") : t("coverage.previewUnavailable"));
    return;
  }
  scene.style.setProperty("--coverage-color", surveyColorFor(survey.id, survey.color, layers[0]?.color));
  title.textContent = product ? `${survey.name.toUpperCase()} · ${product.toUpperCase()}` : survey.name.toUpperCase();
  meta.textContent = `${orderText} · ${survey.statistics.footprintCells.toLocaleString("en-US")} CELLS`;
  state.textContent = coverageStateText(`${survey.statistics.acquired}/${survey.statistics.publicProducts} PRODUCTS · SELECTED`);
}

function updateCoverageState(state: SurveyLayerState): void {
  pendingCoverageState = state;
  if (coverageStateFrame) return;
  coverageStateFrame = requestAnimationFrame(() => {
    coverageStateFrame = 0;
    const next = pendingCoverageState;
    if (!next) return;
    byId("coverage-status-nside").textContent = `${next.nside} · O${Math.round(Math.log2(next.nside))}`;
    byId("coverage-status-fov").textContent = `${next.effectiveFovDeg.toFixed(1)}°`;
    const [x, y, z] = next.cameraPosition;
    byId("coverage-status-camera").textContent = `${next.cameraDistance.toFixed(2)} / ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`;
  });
}

function updateCoverageInspector(inspection: SurveyLayerInspection | null): void {
  const panel = byId("coverage-detail-panel");
  if (!inspection) {
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
  const content = byId("coverage-detail-content");
  abortHstLookupsWithin(content);
  const cellSources = overlapParent?.surveys ?? [];
  const releaseModes = [...new Set([
    ...inspection.artifacts.map((artifact) => {
      const surveyName = surveyIndex?.surveys.find((survey) => survey.id === artifact.surveyId)?.name ?? artifact.surveyId;
      return `${surveyName} · ${artifact.releaseId} · ${artifact.modality ?? "modality unknown"}`;
    }),
    ...cellSources.map((source) => {
      const surveyName = surveyIndex?.surveys.find((survey) => survey.id === source.surveyId)?.name ?? source.surveyId;
      return `${surveyName} · ${source.releaseId} · ${source.modality ?? "modality unknown"}`;
    }),
  ])];
  const rows: Array<[string, string]> = [
    ["NSIDE", String(inspection.nside)],
    ["RA / DEC", `${inspection.centerRaDeg.toFixed(4)}° / ${inspection.centerDecDeg.toFixed(4)}°`],
    ["DR · MODE", releaseModes.length ? releaseModes.join("\n") : inspection.releaseIds.join(", ") || "--"],
  ];
  const list = document.createElement("dl");
  list.className = "coverage-detail-list";
  rows.forEach(([label, value]) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    dt.title = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.title = value;
    list.append(dt, dd);
  });
  const sourceLabel = document.createElement("dt");
  sourceLabel.textContent = "SOURCES";
  const sourceValue = document.createElement("dd");
  sourceValue.className = "coverage-detail-source-value";
  if (inspection.artifacts.length || cellSources.length) {
    const sources = document.createElement("ul");
    sources.className = "coverage-detail-source-list";
    const sourceRows = [
      ...inspection.artifacts.map((artifact) => ({ surveyId: artifact.surveyId, releaseId: artifact.releaseId, product: artifact.product })),
      ...cellSources.map((source) => ({ surveyId: source.surveyId, releaseId: source.releaseId, product: source.product })),
    ];
    [...new Map(sourceRows.map((source) => [`${source.surveyId}:${source.releaseId}:${source.product}`, source])).values()].forEach((artifact) => {
      const surveyName = surveyIndex?.surveys.find((survey) => survey.id === artifact.surveyId)?.name ?? artifact.surveyId;
      const source = document.createElement("li");
      source.textContent = `${surveyName} · ${artifact.releaseId} · ${artifact.product}`;
      source.title = source.textContent;
      sources.append(source);
    });
    sourceValue.append(sources);
  } else sourceValue.textContent = inspection.workspaceAvailable ? "workspace layer" : "--";
  list.append(sourceLabel, sourceValue);
  content.replaceChildren(list);
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
  summary.textContent = `O${result.order} · ${t("coverage.hstEstimated")} · ${result.observations.length} ${t("coverage.hstObservations")} · ${fileCount} ${t("coverage.hstFiles")}${result.truncated || !result.queryExhausted || errors.length ? ` · ${t("coverage.hstResultsPartial")}` : ""}`;
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
  provenance.textContent = `${t("coverage.hstSnapshot")} ${result.sourceSnapshotSha256.slice(0, 12)} · ${result.generatedAt}${result.excludedWithoutRegion ? ` · ${result.excludedWithoutRegion} ${t("coverage.hstMissingRegion")}` : ""}`;
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
  setOverlapPanelInteraction(queue, crowded || layersOpen);
}

function visibleSurveyIdsFromControls(): string[] {
  return [...byId("coverage-layers").querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")]
    .map((input) => input.dataset.surveyId)
    .filter((value): value is string => Boolean(value));
}

function visibleCoverageLayers(): CoverageCatalog["layers"] {
  return filterByModalities(coverageCatalog?.layers ?? [], selectedModalities);
}

function applyCoverageSelection(surveyIds: Iterable<string>): void {
  const next = new Set(surveyIds);
  coverageSelectionInitialized = true;
  queuedLayerIds.clear();
  next.forEach((surveyId) => queuedLayerIds.add(surveyId));
  coverageDots?.setVisibleSurveys(next);
  byId("coverage-layers").querySelectorAll<HTMLInputElement>("input[data-survey-id]").forEach((input) => {
    input.checked = next.has(input.dataset.surveyId ?? "");
  });
  renderSelectionQueue();
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
  available: boolean;
  precision: string;
  truncated: boolean;
  querySnapshot?: { id: string; expiresAt: string; queryExhausted: boolean; inventoryComplete: false };
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
  entrypoints?: Array<{ layerId: string; productId?: string; surveyId?: string; releaseId?: string; product?: string; order: number; nside: number; cells: number[]; precision: string; sourceUrl?: string; mocUrl?: string; note?: string }>;
  downloadPlan?: DownloadPlan;
  notes?: string[];
}
interface OverlapSurveyView { surveyId: string; releaseId: string; product: string; modality?: string; sourceUnitIndex?: { status: string; unitKind?: string; notes: string }; sourceUnits?: { status: string; unitKind: string; units: Array<{ unitId: string; exposureCount: number; lastNight: number; downloadUrl: string }>; totalUnits: number; truncated: boolean; notes: string } | null; downloadUrl?: string }
interface OverlapComponentView { id: string; order: number; cells: number[]; bounds: { areaDeg2: number; raMin: number; raMax: number; raWraps?: boolean; decMin: number; decMax: number }; evidenceLookup?: OverlapEvidenceLookup; surveys?: OverlapSurveyView[] }
type OverlapSourceEvidence = Pick<DownloadPlanCoverageEvidence, "evidenceKind" | "sourceIdentity" | "instrument" | "filters" | "sourceSnapshotSha256" | "precision" | "completeness" | "scienceFileScan" | "summary">;
interface OverlapDetailsResponse {
  schemaVersion: 1;
  component: OverlapComponentView;
  publicSources: Array<{ layerId: string; surveyId: string; surveyName: string; surveyColor?: string; releaseId: string; releaseLabel?: string; product: string; modality?: string; description?: string; sourceUrl?: string; geometrySourceUrl?: string; coverageClaim?: { kind: string; url?: string; status?: string }; dataOrigin?: string; sourceTier?: string; sourceLabel?: string; geometrySourceLabel?: string; coverageEvidence?: OverlapSourceEvidence; sourceUnits?: { status?: string; unitKind?: string; units?: Array<{ unitId: string; exposureCount?: number; lastNight?: number; downloadUrl?: string }>; totalUnits?: number; truncated?: boolean; notes?: string } }>;
  assetsEvidence: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; artifacts: Array<{ id: string; kind: string; label: string; downloadUrl: string; previewUrl?: string; sha256: string; sizeBytes: number }> }>;
  warehouseEvidence: Array<{ layerId: string; surveyId: string; releaseId: string; productId: string; product?: string; modality?: string; state: string; scanRunId?: string; scanRunCount?: number; availableOrders: number[]; commonOrder: number; coverageCells: number; fileCount: number; coverageCount: number; precision: string; sourceSnapshotSha256?: string; sourceSnapshotCount?: number; scanScope?: { layerId: string; publishedLayerId?: string; scopeId: string; scopeSnapshotSha256: string; expectedPartitions: number; committedPartitions: number; completeness: string }; connector: { status: string; name?: string; type?: string }; method: { summary: string; docsUrl?: string } }>;
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
  if (!panel.classList.contains("is-overlap-panel")) return;
  panel.style.left = "auto";
  panel.style.right = window.innerWidth <= 820 ? "14px" : "28px";
  panel.style.top = window.innerWidth <= 820 ? "150px" : "214px";
  panel.style.width = "var(--coverage-panel-width)";
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
    row.textContent = `${layer.product || product?.name || "Coverage"} · ${layer.releaseId || release?.label || "--"} · 最高原生 O${layer.maxOrder} · ${layer.availableOrders.length ? `O${layer.availableOrders.join("/O")}` : "HEALPIX --"}`;
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

function hideCoverageLayerTooltip(): void {
  coverageLayerTooltipRow?.removeAttribute("aria-describedby");
  coverageLayerTooltipRow = null;
  coverageLayerTooltip?.remove();
  coverageLayerTooltip = null;
}

function positionCoverageLayerTooltip(): void {
  const tooltip = coverageLayerTooltip;
  const row = coverageLayerTooltipRow;
  if (!tooltip || !row) return;
  if (window.innerWidth <= 820) {
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

function showCoverageLayerTooltip(surveyId: string, row: HTMLElement): void {
  if (window.innerWidth <= 820) return;
  hideCoverageLayerTooltip();
  const tooltip = createCoverageLayerDetail(surveyId);
  tooltip.classList.add("coverage-layer-tooltip");
  tooltip.id = "coverage-layer-tooltip";
  tooltip.setAttribute("role", "tooltip");
  document.body.append(tooltip);
  coverageLayerTooltip = tooltip;
  coverageLayerTooltipRow = row;
  row.setAttribute("aria-describedby", tooltip.id);
  positionCoverageLayerTooltip();
}

function setCoverageLayersOpen(open: boolean): void {
  const layers = byId("coverage-layers");
  const queue = byId("selection-queue");
  layers.hidden = !open;
  if (open) document.body.dataset.layersPanel = "open";
  else document.body.removeAttribute("data-layers-panel");
  queue.inert = open;
  updateOverlapPanelLayout();
  hideCoverageLayerTooltip();
  positionSelectionQueue();
  positionOverlapPanel();
  updateCoverageEmptyGuide();
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

function updateCoverageEmptyGuide(): void {
  const guide = byId("coverage-empty-guide");
  const layers = byId("coverage-layers");
  const shouldShow = isAtlasInteractive()
    && Boolean(coverageCatalog?.layers.length)
    && queuedLayerIds.size === 0
    && layers.hidden;
  guide.hidden = !shouldShow;
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
  updateCoverageEmptyGuide();
}

function clearLayerCloseTimer(): void {
  if (layerCloseTimer !== null) window.clearTimeout(layerCloseTimer);
  layerCloseTimer = null;
  layerCloseDeadline = 0;
  layerCloseRemaining = 0;
  layerClosePaused = false;
}

function scheduleLayerCloseTimer(): void {
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
  if (!layerClosePaused) return;
  layerClosePaused = false;
  scheduleLayerCloseTimer();
}

function bindLayerCloseTimer(host: HTMLElement): void {
  if (host.dataset.timerBound === "true") return;
  host.dataset.timerBound = "true";
  host.addEventListener("pointerenter", pauseLayerCloseTimer);
  host.addEventListener("pointerleave", resumeLayerCloseTimer);
}

function renderOverlapLoadingPanel(surveyIds: string[], order: number): void {
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  abortHstLookupsWithin(content);
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = t("coverage.overlapResult");
  byId("coverage-detail-title").textContent = `GLOBAL · ${surveyIds.length} SURVEYS`;
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

function renderOverlapErrorPanel(surveyIds: string[]): void {
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  abortHstLookupsWithin(content);
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = t("coverage.overlapResult");
  byId("coverage-detail-title").textContent = `GLOBAL · ${surveyIds.length} SURVEYS`;
  const message = document.createElement("p");
  message.className = "overlap-error";
  message.textContent = t("coverage.overlapFailed");
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

function renderOverlapPanel(surveyIds: string[], pixels: number[], order: number, scope = "GLOBAL", componentData?: OverlapComponentView[]): void {
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
  setOverlapExpandVisible(Boolean(componentData?.length ?? activeOverlapComponents.length));
  byId("coverage-detail-kicker").textContent = t("coverage.overlapResult");
  byId("coverage-detail-title").textContent = `${scope} · ${surveyIds.length} SURVEYS`;
  abortHstLookupsWithin(content);
  content.replaceChildren();
  const summary = document.createElement("p");
  summary.className = "overlap-summary";
  summary.textContent = pixels.length ? `${t("coverage.commonOrder")} O${order} · NSIDE ${2 ** order} · ${pixels.length.toLocaleString("en-US")} cells` : `${t("coverage.commonOrder")} O${order} · ${t("coverage.noCommon")}`;
  content.append(summary);
  if (!pixels.length) {
    positionOverlapPanel();
    return;
  }
  const components = componentData?.length ? componentData : overlapComponents(pixels, order);
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
  content.append(componentNav);
  const initialComponent = components.find((component) => component.id === selectedQueueComponent?.id) ?? components[0]!;
  selectOverlapComponent(initialComponent, surveyIds, content);
  renderIcons();
  positionOverlapPanel();
}

function selectOverlapComponent(component: OverlapComponentView, surveyIds = activeOverlapSurveyIds, content = byId("coverage-detail-content")): void {
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
  coverageDots?.focusPixels(component.order, component.cells);
  renderOverlapComponent(component, surveyIds, content);
}

function handleOverlapComponentLabel(component: SurveyLayerOverlapComponent): void {
  const selected = activeOverlapComponents.find((entry) => entry.id === component.id) ?? {
    id: component.id,
    order: component.order,
    cells: component.cells,
    bounds: overlapBounds(component.cells, component.order),
  };
  selectOverlapComponent(selected);
}

function updateOverlapHud(component: OverlapComponentView | null): void {
  if (!component || !overlapMode) {
    selectedQueueComponent = null;
    renderedQueueComponentId = null;
    renderSelectionQueue();
    return;
  }
  renderedQueueComponentId = selectedQueueComponent?.id ?? null;
  selectedQueueComponent = component;
  renderSelectionQueue();
  positionOverlapPanel();
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
const REVERSE_LOOKUP_MAX_AREA_DEG2 = 100;

function reverseLookupRegionTooLarge(component: OverlapComponentView): boolean {
  return component.cells.length > REVERSE_LOOKUP_MAX_CELLS || component.bounds.areaDeg2 > REVERSE_LOOKUP_MAX_AREA_DEG2;
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
  return JSON.stringify({ order: component.order, cells: component.cells, layerIds,
    revisions: layerIds.map((id) => coverageCatalog?.layers.find((layer) => layer.layerId === id)?.revision) });
}

async function fetchOverlapEvidence(component: OverlapComponentView, signal?: AbortSignal, access: OverlapEvidenceAccess = "preview", page?: { cursor?: string; pageSize?: number; pageKind?: "spatial-units" | "supporting-evidence"; querySnapshotId?: string }): Promise<OverlapEvidenceResult | null> {
  const lookup = component.evidenceLookup;
  if (!lookup) return null;
  const cacheKey = overlapEvidenceKey(component);
  const cached = access === "preview" ? overlapEvidenceCache.get(cacheKey) : undefined;
  if (cached) return cached;
  const preview = access === "preview";
  const body: Record<string, unknown> = {
    layerIds: lookup.layerIds,
    order: lookup.order,
    cells: component.cells,
    limit: preview ? 6 : 1000,
    preview,
  };
  if (access !== "preview") {
    body.pageSize = page?.pageSize ?? 20;
    if (page?.cursor) body.cursor = page.cursor;
    if (page?.pageKind) body.pageKind = page.pageKind;
    if (page?.querySnapshotId) body.querySnapshotId = page.querySnapshotId;
  }
  const response = await fetch(lookup.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal,
    body: JSON.stringify(body),
  });
  if(response.status===401 && access !== "preview")resetDownloadAccess();
  if (!response.ok) { const failure=await response.json().catch(()=>({})); throw new Error(failure.error??`reverse lookup HTTP ${response.status}`); }
  const result = await response.json() as OverlapEvidenceResult;
  if (access === "preview") overlapEvidenceCache.set(cacheKey, result);
  return result;
}

function reversePlanEntryKey(entry: DownloadPlanEntrypoint): string {
  return [entry.kind, entry.layerId ?? "", entry.tileId ?? "", entry.url ?? entry.sourceUri ?? entry.sourceUrl ?? entry.mocUrl ?? "", entry.product ?? entry.productId ?? ""].join(":");
}

function mergeOverlapEvidence(current: OverlapEvidenceResult, next: OverlapEvidenceResult): OverlapEvidenceResult {
  if (current.querySnapshot?.id && next.querySnapshot?.id && current.querySnapshot.id !== next.querySnapshot.id) throw new Error("Reverse lookup snapshot changed");
  const currentPlan = downloadPlanFor(current);
  const nextPlan = downloadPlanFor(next);
  const files = new Map(currentPlan.files.map((file) => [file.fileId, file]));
  for (const file of nextPlan.files) {
    const previous = files.get(file.fileId);
    if (!previous) {
      files.set(file.fileId, file);
      continue;
    }
    const matches = new Map(previous.matchingCoverage.map((match) => [`${match.layerId ?? ""}:${match.order}:${match.ipix}:${match.precision}:${match.scanRunId ?? ""}:${match.sourceSnapshotSha256 ?? ""}:${match.evidenceLayerId ?? ""}:${match.observationLayerId ?? ""}:${match.scopeId ?? ""}:${match.partitionId ?? ""}`, match]));
    file.matchingCoverage.forEach((match) => matches.set(`${match.layerId ?? ""}:${match.order}:${match.ipix}:${match.precision}:${match.scanRunId ?? ""}:${match.sourceSnapshotSha256 ?? ""}:${match.evidenceLayerId ?? ""}:${match.observationLayerId ?? ""}:${match.scopeId ?? ""}:${match.partitionId ?? ""}`, match));
    const observations = new Map([...(previous.observations ?? []), ...(file.observations ?? [])].map(observation => [`${observation.layerId}:${observation.scanRunId}`, observation]));
    files.set(file.fileId, { ...previous, ...file, matchingCoverage: [...matches.values()],
      ...(previous.matchingCoverageTruncated || file.matchingCoverageTruncated ? { matchingCoverageTruncated: true } : {}),
      warnings: [...new Set([...(previous.warnings ?? []), ...(file.warnings ?? [])])],
      ...(observations.size ? { observations: [...observations.values()] } : {}) });
  }
  const entrypoints = new Map(currentPlan.entrypoints.map((entry) => [reversePlanEntryKey(entry), entry]));
  nextPlan.entrypoints.forEach((entry) => entrypoints.set(reversePlanEntryKey(entry), entry));
  const spatialUnits = new Map((currentPlan.spatialUnits ?? []).map((unit) => [`${unit.layerId}:${unit.unitKind}:${unit.unitId}`, unit]));
  (nextPlan.spatialUnits ?? []).forEach((unit) => {
    const key = `${unit.layerId}:${unit.unitKind}:${unit.unitId}`;
    const previous = spatialUnits.get(key);
    const scannedFiles = new Map([...(previous?.scannedFiles ?? []), ...(unit.scannedFiles ?? [])].map((file) => [`${file.fileId}:${file.scanRunId ?? ""}`, file]));
    const accessUris = new Map([...(previous?.accessUris ?? []), ...(unit.accessUris ?? [])].map((entry) => [entry.uri, entry]));
    spatialUnits.set(key, {
      ...previous,
      ...unit,
      ...(scannedFiles.size ? { scannedFiles: [...scannedFiles.values()] } : {}),
      ...(accessUris.size ? { accessUris: [...accessUris.values()] } : {}),
    });
  });
  const coverageEvidence = new Map((currentPlan.coverageEvidence ?? []).map((evidence) => [`${evidence.layerId}:${evidence.order}`, evidence]));
  (nextPlan.coverageEvidence ?? []).forEach((evidence) => coverageEvidence.set(`${evidence.layerId}:${evidence.order}`, evidence));
  return {
    ...current,
    ...next,
    preview: undefined,
    page: next.page,
    spatialPage: next.spatialPage ?? current.spatialPage,
    supportingPage: next.supportingPage ?? current.supportingPage,
    sourceFiles: [...current.sourceFiles, ...next.sourceFiles].filter((source, index, values) => values.findIndex((candidate) => `${sourceValue(candidate, ["layer_id"])}:${sourceValue(candidate, ["fileId", "file_id", "_id"])}` === `${sourceValue(source, ["layer_id"])}:${sourceValue(source, ["fileId", "file_id", "_id"])}`) === index),
    edges: [...current.edges, ...next.edges].filter((edge, index, values) => values.findIndex((candidate) => `${candidate.edgeId ?? ""}:${candidate.layerId ?? ""}:${candidate.order}:${candidate.ipix}` === `${edge.edgeId ?? ""}:${edge.layerId ?? ""}:${edge.order}:${edge.ipix}`) === index),
    downloadPlan: {
      ...currentPlan,
      ...nextPlan,
      spatialUnits: [...spatialUnits.values()],
      files: [...files.values()],
      entrypoints: [...entrypoints.values()],
      coverageEvidence: [...coverageEvidence.values()],
      truncated: nextPlan.truncated,
      warnings: [...new Set([...currentPlan.warnings, ...nextPlan.warnings])],
    },
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

async function evidenceForExport(component: OverlapComponentView): Promise<OverlapEvidenceResult | null> {
  const current = await fetchOverlapEvidence(component);
  if (!current || !hasDownloadAccess()) return current;
  let result = await fetchOverlapEvidence(component, undefined, "download", { querySnapshotId: current.querySnapshot?.id, pageSize: 100 });
  if (!result) return null;
  const cursors = new Set<string>();
  while (result.page?.hasMore) {
    const cursor = result.page.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("Reverse lookup pagination did not advance");
    cursors.add(cursor);
    const next = await fetchOverlapEvidence(component, undefined, "download", { cursor, pageSize: 100 });
    if (!next) throw new Error("Reverse lookup page was unavailable");
    result = mergeOverlapEvidence(result, next);
  }
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
    const rows = components.flatMap((component, index) => overlapCsvRows(component, downloadPlanFor(results[index]), publicLayerEntry, results[index]?.precision, {
      snapshotId: results[index]?.querySnapshot?.id, omitted: results[index]?.page?.omitted ?? results[index]?.preview?.omitted ?? 0,
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

function renderEvidencePlan(node: HTMLElement, result: OverlapEvidenceResult, component?: OverlapComponentView): void {
  if (component) {
    const key = overlapEvidenceKey(component);
    overlapEvidenceCache.set(key, result);
    overlapEvidenceHosts.set(key, node);
  }
  node.replaceChildren();
  const plan = downloadPlanFor(result);
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
  const heading = document.createElement("strong");
  heading.textContent = `匹配的空间分块 · ${result.preview ? "已展示" : "已加载"} ${displaySpatialUnits.length}${spatialHasMore ? " · 还有更多分块" : ""}`;
  node.append(heading);
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
    const unitsHeading = document.createElement("strong");
    unitsHeading.textContent = `空间分块 URI · ${displaySpatialUnits.length}`;
    node.append(unitsHeading);
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
        textContent: `O${unit.order} · ${unit.matchingCells.length} 个像元`,
      }));
      facts.append(precisionIndicator(unit.precision));
      row.append(facts);
      if (unit.accessUris?.length) {
        unit.accessUris.forEach((entry) => {
          if (entry.fileName) row.append(Object.assign(document.createElement("small"), { className: "overlap-spatial-unit-file-name", textContent: entry.fileName }));
          appendSourceLocator(row, entry.uri);
        });
      } else if (unit.accessUri) appendSourceLocator(row, unit.accessUri);
      if (unit.scannedFiles?.length) {
        row.append(Object.assign(document.createElement("small"), { textContent: `已扫描到 ${unit.scannedFiles.length} 个关联文件` }));
        const scans = document.createElement("ul");
        unit.scannedFiles.forEach((file) => {
          const item = document.createElement("li");
          item.append(Object.assign(document.createElement("span"), { textContent: file.fileName ?? file.fileId }));
          if (file.sourceUri) item.append(Object.assign(document.createElement("code"), { textContent: ` · ${file.sourceUri}` }));
          if (file.scanRunId) item.append(Object.assign(document.createElement("small"), { textContent: ` · ${file.scanRunId}` }));
          scans.append(item);
        });
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
        appendSourceLocator(row, file.sourceUri);
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

async function loadOverlapEvidence(component: OverlapComponentView, node: HTMLElement): Promise<void> {
  const lookup = component.evidenceLookup;
  if (!lookup) return;
  if (reverseLookupRegionTooLarge(component)) {
    node.replaceChildren(Object.assign(document.createElement("small"), { textContent: t("coverage.overlapRegionTooLarge") }));
    return;
  }
  overlapEvidenceController?.abort();
  const controller = new AbortController();
  overlapEvidenceController = controller;
  const request = ++overlapEvidenceSequence;
  node.replaceChildren(Object.assign(document.createElement("small"), { textContent: t("coverage.queryingPlan") }));
  try {
    const result = await fetchOverlapEvidence(component, controller.signal);
    if (!result) return;
    if (request === overlapEvidenceSequence && !controller.signal.aborted) renderEvidencePlan(node, result, component);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (request === overlapEvidenceSequence) node.replaceChildren(Object.assign(document.createElement("small"), { textContent: `${t("coverage.reverseFailed")}: ${error instanceof Error ? error.message : ""}` }));
  } finally {
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
  productsSummary.textContent = `参与覆盖产品 · ${entries.length}`;
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
    title.textContent = `${survey?.name ?? entry.surveyId} · ${entry.releaseId} · ${entry.product}`;
    title.title = `${title.textContent} · ${modalityName}`;
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
  return `${activeOverlapSurveyIds.slice().sort().join(",")}:${activeOverlapModalities.slice().sort().join(",")}:${component.id}:${component.order}`;
}

async function fetchOverlapDetails(component: OverlapComponentView, signal?: AbortSignal): Promise<OverlapDetailsResponse> {
  const key = overlapDetailsCacheKey(component);
  const cached = overlapDetailsCache.get(key);
  if (cached) return cached;
  const response = await fetch("/api/v1/coverage/overlap/details", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ surveyIds: activeOverlapSurveyIds, modalities: activeOverlapModalities, componentId: component.id, requestedOrder: component.order }),
    signal,
  });
  if (!response.ok) throw new Error(`overlap details HTTP ${response.status}`);
  const details = await response.json() as OverlapDetailsResponse;
  overlapDetailsCache.set(key, details);
  return details;
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
    button.append(id, summary);
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

function renderOverlapDrawerLoading(component: OverlapComponentView): void {
  const drawer = byId("overlap-drawer");
  byId("overlap-drawer-title").textContent = `${component.id} · O${component.order}`;
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
  drawer.removeAttribute("aria-busy");
  const component: OverlapComponentView = { ...details.component, evidenceLookup: details.reverseLookup };
  byId("overlap-drawer-title").textContent = `${component.id} · O${component.order} · ${component.cells.length.toLocaleString("en-US")} cells`;
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

  const assetsSection = drawerSection("ATLAS 覆盖索引 · MOC / 查询制品");
  const assetsIntro = document.createElement("p");
  assetsIntro.className = "overlap-drawer-copy";
  assetsIntro.textContent = "这些是 Atlas 发布的覆盖索引，用于天球绘制、重合计算和版本核对；链接只提供 MOC、查询投影或预览制品，不是科学数据文件，也不代表 Tile / 文件清单。";
  assetsSection.append(assetsIntro);
  const assetsList = document.createElement("div"); assetsList.className = "overlap-drawer-list";
  details.assetsEvidence.forEach((entry) => {
    const card = document.createElement("article"); card.className = "overlap-drawer-card is-assets";
    const title = document.createElement("strong"); title.textContent = `${entry.product} · ${entry.artifacts.length} artifacts`; card.append(title);
    entry.artifacts.forEach((artifact) => {
      const row = document.createElement("div"); row.className = "overlap-unit-links";
      const kindLabel = artifact.kind === "moc" ? "MOC 覆盖文件" : artifact.kind === "query" ? "查询投影" : artifact.kind === "preview" ? "预览制品" : `发布制品 · ${artifact.kind.toUpperCase()}`;
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
    if (evidence.scanRunId) card.append(Object.assign(document.createElement("small"), { textContent: `SCAN RUN ${evidence.scanRunId}` }));
    else if (evidence.scanRunCount !== undefined) card.append(Object.assign(document.createElement("small"), { textContent: `SCAN RUNS ${evidence.scanRunCount}` }));
    if (evidence.sourceSnapshotSha256) card.append(Object.assign(document.createElement("code"), { textContent: `SNAPSHOT SHA-256 ${evidence.sourceSnapshotSha256}` }));
    else if (evidence.sourceSnapshotCount !== undefined) card.append(Object.assign(document.createElement("small"), { textContent: `INPUT SNAPSHOTS ${evidence.sourceSnapshotCount} (per committed partition)` }));
    if (evidence.scanScope) {
      card.append(Object.assign(document.createElement("small"), { textContent: `SCOPE ${evidence.scanScope.scopeId} · ${evidence.scanScope.committedPartitions}/${evidence.scanScope.expectedPartitions} partitions · ${evidence.scanScope.completeness}` }));
      card.append(Object.assign(document.createElement("code"), { textContent: `SCOPE SNAPSHOT SHA-256 ${evidence.scanScope.scopeSnapshotSha256}` }));
    }
    const connector = document.createElement("small"); connector.textContent = `${t("coverage.connector")}: ${evidence.connector.status}${evidence.connector.name ? ` · ${evidence.connector.name}` : ""}${evidence.connector.type ? ` · ${evidence.connector.type}` : ""}`; card.append(connector);
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
    renderOverlapDrawerError(t("coverage.overlapRegionTooLarge"));
    return;
  }
  renderOverlapDrawerLoading(component);
  overlapDetailsController?.abort();
  const controller = new AbortController();
  overlapDetailsController = controller;
  void fetchOverlapDetails(component, controller.signal).then((details) => {
    if (!overlapDrawerOpen || controller.signal.aborted || selectedQueueComponent?.id !== component.id) return;
    renderOverlapDrawerResponse(details);
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (overlapDrawerOpen && !controller.signal.aborted && selectedQueueComponent?.id === component.id) renderOverlapDrawerError(t("coverage.overlapFailed"));
  }).finally(() => {
    if (overlapDetailsController === controller) overlapDetailsController = null;
  });
}

function selectOverlapDrawerComponent(component: OverlapComponentView): void {
  if (!overlapDrawerOpen) return;
  const componentIndex = activeOverlapComponents.findIndex((entry) => entry.id === component.id);
  if (componentIndex >= 0) {
    overlapDrawerComponentsPage = Math.floor(componentIndex / OVERLAP_COMPONENT_PAGE_SIZE);
    overlapComponentsPage = overlapDrawerComponentsPage;
  }
  selectedQueueComponent = component;
  coverageDots?.setActiveOverlapComponent(component.id);
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
      layersHidden: Boolean(byId("coverage-layers").hidden),
      queueHidden: Boolean(byId("selection-queue").hidden),
      panelHidden: Boolean(byId("coverage-detail-panel").hidden),
      helpHidden: Boolean(byId("coverage-help").hidden),
      guideHidden: Boolean(byId("coverage-empty-guide").hidden),
    };
    overlapDrawerPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  setCoverageLayersOpen(false);
  byId("coverage-help").hidden = true;
  byId("coverage-empty-guide").hidden = true;
  overlapDrawerOpen = true;
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
  abortHstLookupsWithin(byId("overlap-drawer-content"));
  overlapDrawerOpen = false;
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
    byId("coverage-empty-guide").hidden = previous.guideHidden;
    if (!previous.panelHidden && overlapMode && selectedQueueComponent) {
      renderOverlapPanel(activeOverlapSurveyIds, [...new Set(activeOverlapComponents.flatMap((entry) => entry.cells))], selectedQueueComponent.order, "GLOBAL", activeOverlapComponents);
    }
  }
  positionSelectionQueue();
  positionOverlapPanel();
  overlapDrawerPreviousFocus?.focus();
  overlapDrawerPreviousFocus = null;
}

async function activateOverlap(forceActive?: boolean): Promise<void> {
  if (!isAtlasInteractive()) return;
  const surveyIds = visibleSurveyIdsFromControls();
  const activate = forceActive ?? !overlapMode;
  if (activate && surveyIds.length < 2) {
    if (overlapMode) void activateOverlap(false);
    toast(t("coverage.needTwoSurveys"));
    return;
  }
  let order: number | null = null;
  if (activate) {
    order = commonOverviewOrder(surveyIds);
    if (order === null) {
      if (overlapMode) void activateOverlap(false);
      toast(t("coverage.noCommonOrder"));
      byId("coverage-state").textContent = t("coverage.noCommonOrder");
      return;
    }
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
    activeOverlapModalities = [];
    activeOverlapComponents = [];
    overlapComponentsPage = 0;
    overlapDrawerComponentsPage = 0;
    overlapEvidenceCache.clear();
    overlapDetailsCache.clear();
    coverageDots?.setOverlapMode(false);
    coverageDots?.setActiveOverlapComponent(null);
    // Leave overlap on the canonical centered data view. This also clears any
    // stale component/cell focus without changing the checked layer set.
    coverageDots?.resetView();
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
    return;
  }
  if (activate) {
    clearLayerCloseTimer();
    setCoverageLayersOpen(false);
  }
  if (order === null) return;
  coverageDots?.setOverlapMode(true);
  activeOverlapComponents = [];
  overlapComponentsPage = 0;
  overlapDrawerComponentsPage = 0;
  overlapDetailsCache.clear();
  updateOverlapHud(null);
  overlapController?.abort();
  const controller = new AbortController();
  overlapController = controller;
  activeOverlapModalities = [...selectedModalities];
  renderOverlapLoadingPanel(surveyIds, order);
  try {
    const response = await fetch("/api/v1/coverage/overlap", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ surveyIds, modalities: activeOverlapModalities, requestedOrder: order }), signal: controller.signal });
    if (!overlapMode || requestSequence !== overlapRequestSequence) return;
    if (!response.ok) throw new Error(`overlap request failed: ${response.status}`);
    const result = await response.json() as { components?: OverlapComponentView[]; commonOrder?: number; pixels?: number[] };
    if (!overlapMode || requestSequence !== overlapRequestSequence) return;
    const renderedPixels = result.pixels ?? [];
    const renderedOrder = result.commonOrder ?? order;
    activeOverlapSurveyIds = [...surveyIds];
    activeOverlapComponents = result.components ?? [];
    overlapEvidenceCache.clear();
    coverageDots?.setOverlapCells(renderedOrder, renderedPixels);
    coverageDots?.setOverlapComponents(activeOverlapComponents);
    renderOverlapPanel(surveyIds, renderedPixels, renderedOrder, "GLOBAL", activeOverlapComponents);
    const firstComponent = activeOverlapComponents[0];
    if (firstComponent) coverageDots?.focusPixels(firstComponent.order, firstComponent.cells);
    byId("coverage-state").textContent = renderedPixels.length ? `${t("coverage.commonOrder")} O${renderedOrder} · ${renderedPixels.length.toLocaleString("en-US")} CELLS` : `${t("coverage.noCommon")} · O${renderedOrder}`;
  } catch {
    if (!overlapMode || requestSequence !== overlapRequestSequence || controller.signal.aborted) return;
    activeOverlapSurveyIds = [...surveyIds];
    activeOverlapComponents = [];
    coverageDots?.setOverlapCells(order, []);
    coverageDots?.setOverlapComponents([]);
    renderOverlapErrorPanel(surveyIds);
    byId("coverage-state").textContent = t("coverage.overlapFailed");
  }
  if (overlapController === controller) overlapController = null;
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
  const label = modality ? modalityLabel(modality) : locale() === "zh" ? "模态未指定" : "Modality unspecified";
  badge.title = modalityDescription(modality);
  badge.setAttribute("aria-label", `${locale() === "zh" ? "模态" : "Modality"}: ${label}. ${modalityDescription(modality)}`);
  badge.append(icon(modalityIconName(modality ?? "unknown")), document.createTextNode(label));
  return badge;
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

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character)); }
function modalityIconsMarkup(modalities: readonly string[], label: string): string { const unique=[...new Set(modalities)].sort((a,b)=>modalityLabel(a).localeCompare(modalityLabel(b))); return unique.length ? `<span class="coverage-modalities" aria-label="${escapeHtml(label)}：${escapeHtml(unique.map(modalityLabel).join("、"))}">${unique.map(m=>`<i data-lucide="${modalityIconName(m)}" title="${escapeHtml(modalityLabel(m))}"></i>`).join("")}</span>` : `<span class="coverage-modalities-empty">模态未指定</span>`; }

function renderCoverageLayers(): void {
  const host = byId("coverage-layers");
  hideCoverageLayerTooltip();
  host.replaceChildren();
  if (!coverageCatalog) return;
  bindLayerCloseTimer(host);
  const search = document.createElement("label");
  search.className = "coverage-layer-search";
  search.innerHTML = `<i data-lucide="search"></i><input id="coverage-layer-search" type="search" autocomplete="off" placeholder="筛选巡天图层" aria-label="筛选巡天图层" />`;
  host.append(search);
  const filterInput = search.querySelector<HTMLInputElement>("input");
  const grouped = new Map<string, CoverageCatalog["layers"]>();
  for (const layer of visibleCoverageLayers()) grouped.set(layer.surveyId, [...(grouped.get(layer.surveyId) ?? []), layer]);
  const surveyIds = [...new Set([
    ...grouped.keys(),
    ...(surveyIndex?.surveys.map((survey) => survey.id) ?? []),
  ])];
  for (const surveyId of surveyIds) {
    const layers = grouped.get(surveyId) ?? [];
    const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
    const unavailable = layers.length === 0;
    const label = document.createElement("div");
    label.className = `coverage-layer-toggle${unavailable ? " is-unavailable" : ""}`;
    label.setAttribute("title", unavailable ? "暂无公开覆盖，暂不可在天球中显示" : "拖动三横线把手以调整图层顺序");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !unavailable && queuedLayerIds.has(surveyId);
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
    swatch.setAttribute("aria-label", `图层颜色 ${swatch.style.backgroundColor}`);
    label.addEventListener("pointerenter", () => showCoverageLayerTooltip(surveyId, label));
    label.addEventListener("pointerleave", () => {
      if (coverageLayerTooltipRow === label) hideCoverageLayerTooltip();
    });
    label.addEventListener("focusin", () => showCoverageLayerTooltip(surveyId, label));
    label.addEventListener("focusout", (event) => {
      const related = event.relatedTarget;
      if (!(related instanceof Node) || !label.contains(related)) hideCoverageLayerTooltip();
    });
    const handle = document.createElement("span");
    handle.className = "coverage-layer-handle";
    handle.innerHTML = `<i data-lucide="grip-horizontal"></i>`;
    handle.setAttribute("role", "img");
    handle.setAttribute("aria-label", "拖动把手");
    handle.title = "拖动排序";
    input.addEventListener("change", () => {
      if (overlapDrawerOpen) closeOverlapDrawer();
      const enabled = [...host.querySelectorAll<HTMLInputElement>("input:checked")]
        .map((entry) => entry.dataset.surveyId)
        .filter((value): value is string => Boolean(value));
      applyCoverageSelection(enabled);
      restartLayerCloseTimer();
      if (overlapMode) {
        void (enabled.length >= 2 ? activateOverlap(true) : activateOverlap(false));
      }
    });
    if (!unavailable) {
      label.draggable = true;
      label.dataset.layerKey = `public-survey:${surveyId}`;
      label.addEventListener("dragstart", () => label.classList.add("is-dragging"));
      label.addEventListener("dragend", () => { label.classList.remove("is-dragging"); host.querySelectorAll(".is-drop-target").forEach((node) => node.classList.remove("is-drop-target")); });
      label.addEventListener("dragover", (event) => { event.preventDefault(); label.classList.add("is-drop-target"); });
      label.addEventListener("dragleave", () => label.classList.remove("is-drop-target"));
      label.addEventListener("drop", (event) => {
        event.preventDefault();
        const dragging = host.querySelector<HTMLElement>(".is-dragging");
        if (!dragging || dragging === label) return;
        const rect = label.getBoundingClientRect();
        host.insertBefore(dragging, event.clientY < rect.top + rect.height / 2 ? label : label.nextSibling);
        coverageDots?.setLayerOrder([...host.querySelectorAll<HTMLElement>("[data-layer-key]")].map((node) => node.dataset.layerKey!).filter(Boolean));
      });
    }
    label.append(input, swatch, handle, name);
    const common = document.createElement("span"); common.innerHTML = modalityIconsMarkup(commonModalities, `${survey?.name ?? surveyId} 共同覆盖模态`); label.append(common);
    if (unavailable) label.append(Object.assign(document.createElement("small"), { className: "coverage-layer-unavailable", textContent: "暂无公开覆盖" }));
    host.append(label);
  }
  if (host.dataset.tooltipBound !== "true") {
    host.dataset.tooltipBound = "true";
    host.addEventListener("scroll", positionCoverageLayerTooltip, { passive: true });
  }
  filterInput?.addEventListener("input", () => {
    const query = filterInput.value.trim().toLocaleLowerCase();
    host.querySelectorAll<HTMLElement>(".coverage-layer-toggle").forEach((row) => { row.hidden = Boolean(query) && !row.dataset.searchText?.includes(query); });
  });
  renderIcons();
  renderSelectionQueue();
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function setTextIfPresent(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer: number | undefined;
function toast(message: string, durationMs = 1800): void {
  const element = byId("toast");
  element.textContent = message;
  element.dataset.visible = "true";
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { element.dataset.visible = "false"; }, durationMs);
}

async function copy(value: string, message = "SHA-256 已复制"): Promise<void> {
  await navigator.clipboard.writeText(value);
  toast(message);
}

function renderIcons(): void {
    createIcons({
    icons: { BadgeCheck, BookOpen, Box, ChevronLeft, ChevronRight, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Home, Image, Info, Layers3, ListChecks, ListFilter, LoaderCircle, Lock, Maximize2, Minimize2, Moon, Menu, Radio, RotateCcw, ScanLine, Search, ShieldCheck, Sun, Telescope, X },
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
      if (input.checked) selectedModalities.add(modality);
      else selectedModalities.delete(modality);
      const selectedSurveys = [...queuedLayerIds];
      renderSurveys();
      updateSurveyFilterCount();
      coverageDots?.setVisibleModalities(selectedModalities);
      const availableSurveys = new Set(visibleCoverageLayers().map((layer) => layer.surveyId));
      renderCoverageLayers();
      applyCoverageSelection(selectedSurveys.filter((surveyId) => availableSurveys.has(surveyId)));
      if (overlapMode) {
        const enabled = visibleSurveyIdsFromControls();
        void (enabled.length >= 2 ? activateOverlap(true) : activateOverlap(false));
      }
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

function coverageCatalogRevisionKey(catalog: CoverageCatalog): string {
  if (catalog.revision) return `revision:${catalog.revision}`;
  if (catalog.generatedAt) return `generated:${catalog.generatedAt}`;
  // Older catalogs did not carry a revision. Keep a deterministic fallback so
  // an initialization retry does not rebuild the same catalog twice.
  return `catalog:${JSON.stringify(catalog)}`;
}

async function hydrateCoverageCatalogInternal(nextCatalog: CoverageCatalog): Promise<void> {
  const previousCatalog = coverageCatalog;
  const revisionChanged = Boolean(previousCatalog && coverageCatalogRevisionKey(previousCatalog) !== coverageCatalogRevisionKey(nextCatalog));
  coverageCatalog = nextCatalog;
  if (revisionChanged) {
    coverageBlockCache.clear();
    overlapEvidenceCache.clear();
    overlapDetailsCache.clear();
    overlapController?.abort();
    overlapController = null;
    activeOverlapComponents = [];
  }
  coverageLayerLoadStates.clear();
  coverageLayerLoadErrors.clear();
  const blocks = new Map<string, number[]>();
  if (coverageDots) {
    await Promise.all(nextCatalog.layers.map(async (layer) => {
      const cells = await fetchCoverageOverview(layer);
      if (cells.length) blocks.set(`${layer.layerId}:${layer.overviewOrder}`, cells);
    }));
    const availableSurveys = new Set(nextCatalog.layers.map((layer) => layer.surveyId));
    await coverageDots.loadCatalog(nextCatalog, blocks, surveyIndex?.surveys ?? []);
    if (coverageSelectionInitialized) {
      const selected = [...queuedLayerIds].filter((surveyId) => availableSurveys.has(surveyId));
      applyCoverageSelection(selected);
    } else if (isAtlasPage) {
      // The standalone Atlas starts with an intentional empty selection. The
      // homepage may still use the loaded footprints as its ambient preview,
      // but the interactive page must never imply that every survey is chosen.
      applyCoverageSelection([]);
    } else {
      coverageDots.setVisibleSurveys(new Set(nextCatalog.layers.map((layer) => layer.surveyId)));
    }
    if (homeEntered) coverageDots.transitionToDataView(1);
    else updateHomeScrollProgress();
    renderCoverageLayers();
    updateCoverageReadout(activeSurveyId);
    renderCoverageLoadDiagnostics();
    if (revisionChanged && overlapMode && visibleSurveyIdsFromControls().length >= 2) void activateOverlap(true);
  }
}

const coverageHydration = createRevisionHydrationQueue(coverageCatalogRevisionKey, hydrateCoverageCatalogInternal);

function hydrateCoverageCatalog(nextCatalog: CoverageCatalog, force = false): Promise<void> {
  return coverageHydration.enqueue(nextCatalog, force);
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

// Global enterAtlasExperience function for inline onclick handlers if needed
declare global {
  interface Window {
    enterAtlasExperience: (surveyId?: string, productId?: string) => void;
  }
}
window.enterAtlasExperience = enterAtlasExperience;

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
  try {
    coverageDots = new AtlasCoverageGlobe(byId("coverage-scene"), byId<HTMLCanvasElement>("coverage-canvas"), updateCoverageReadout, updateCoverageInspector, updateCoverageState, openCoverageContextMenu, handleOverlapComponentLabel);
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
  try {
    const value = await fetchPublicJson<unknown>("/api/v1/surveys", { headers: { Accept: "application/json" } });
    if (!isSurveyIndex(value)) throw new Error("Public survey catalog response is invalid");
    surveysResult = value;
    surveyIndex = value;
    initializeModalityFilter();
    renderSurveys();
  } catch (error) {
    console.warn("Public survey catalog unavailable", error);
    byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: t("coverage.catalogLoadFailed") }));
  }

  let coverageResult: CoverageCatalog | null = null;
  if (surveysResult) {
    // Keep the catalog and URL state usable even when the optional WebGL
    // viewer could not be created (for example, in a headless browser).
    try {
      coverageResult = await fetchCoverageCatalogDocument();
      await hydrateCoverageCatalog(coverageResult);
      applySkyDeepLink();

      // Setup a subtle auto-rotation for the background visual if we are on the homepage
      if (coverageDots && !homeEntered) {
          coverageDots.resetView(); // This should trigger a continuous slow rotation if implemented in AtlasCoverageGlobe
      }
    } catch (error) {
      console.warn("Public coverage catalog unavailable", error);
      byId("coverage-state").textContent = "COVERAGE CATALOG UNAVAILABLE";
    }
  } else {
    byId("coverage-state").textContent = "COVERAGE CATALOG UNAVAILABLE";
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

  // Keep the standalone atlas page in its interactive state. The homepage
  // uses the same controller but must return to its introductory hero.
  if (isAtlasPage) {
    document.body.dataset.homeState = "atlas";
    document.documentElement.style.overflow = "";
    const atlasScene = document.getElementById("coverage-scene");
    if (atlasScene) {
      atlasScene.style.opacity = "1";
      atlasScene.style.pointerEvents = "auto";
    }
    homeEntered = true;
    return;
  }

  // Revert UI to the home state
  document.body.dataset.homeState = "intro";
  document.documentElement.style.overflow = "";
  const coverageScene = document.getElementById("coverage-scene");
  if (coverageScene) {
      coverageScene.style.opacity = "0";
      coverageScene.style.pointerEvents = "none";
  }
  const hero = document.getElementById("home-hero");
  if (hero) {
      hero.classList.remove("is-exiting");
      hero.removeAttribute("aria-hidden");
  }
  homeEntered = false;
}

byId("coverage-reset").addEventListener("click", () => {
  if (isAtlasInteractive()) resetCoverageExperience();
});
byId("overlap-expand").addEventListener("click", () => openOverlapDrawer());
byId("overlap-drawer-close").addEventListener("click", () => closeOverlapDrawer());
byId("coverage-layers-toggle").addEventListener("click", () => {
  if (!isAtlasInteractive()) return;
  if (overlapDrawerOpen) {
    closeOverlapDrawer();
    return;
  }
  const layers = byId("coverage-layers");
  setCoverageLayersOpen(Boolean(layers.hidden));
});
byId("coverage-empty-guide-action").addEventListener("click", () => {
  byId("coverage-layers-toggle").click();
});
byId("coverage-help-toggle").addEventListener("click", () => {
  if (!isAtlasInteractive()) return;
  byId("coverage-help").hidden = !byId("coverage-help").hidden;
});
byId("coverage-help-close").addEventListener("click", () => { byId("coverage-help").hidden = true; });

function enterAtlasExperience(surveyId?: string, productId?: string): void {
  const selectedSurveyId = surveyId ?? deepLinkTarget?.surveyId;
  if (selectedSurveyId) applyCoverageSelection([selectedSurveyId]);
  else applyCoverageSelection([]);
  const wasEntered = homeEntered;
  homeEntered = true;
  deepLinkTarget = selectedSurveyId ? { surveyId: selectedSurveyId, ...(productId ? { productId } : {}) } : null;
  syncSkyDeepLink(selectedSurveyId, productId);
  const focus = (): void => focusSkyTarget(deepLinkTarget);
  if (wasEntered) {
    document.body.dataset.homeState = "atlas";
    coverageDots?.transitionToDataView(420);
    focus();
    renderSelectionQueue();
    updateCoverageEmptyGuide();
    return;
  }
  const hero = byId("home-hero");

  const coverageScene = document.getElementById("coverage-scene");
  if (coverageScene) {
      coverageScene.style.opacity = "1";
      coverageScene.style.pointerEvents = "auto";
  }

  document.body.dataset.homeState = "entering";
  document.body.style.setProperty("--home-scroll-progress", "1");
  window.scrollTo({ top: 0, behavior: "auto" });
  hero.classList.add("is-exiting");
  coverageDots?.transitionToDataView(900);
  const finish = (): void => {
    document.body.dataset.homeState = "atlas";
    hero.setAttribute("aria-hidden", "true");
    renderSelectionQueue();
    updateCoverageEmptyGuide();
    focus();
    byId("coverage-layers-toggle").focus();
  };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }
  window.setTimeout(finish, 680);
}

const enterBtn = document.getElementById("home-enter");
if (enterBtn) {
  enterBtn.addEventListener("click", () => enterAtlasExperience());
}

// Fallback listener for the old ID if it's still being used somewhere else
const oldEnterBtn = document.getElementById("home-enter");
if (oldEnterBtn && !enterBtn) {
    oldEnterBtn.addEventListener("click", () => enterAtlasExperience());
}

window.addEventListener("popstate", () => {
  if (!surveyIndex || !coverageCatalog) return;
  const target = readSkyDeepLink();
  if (!target) {
    deepLinkTarget = null;
    if (homeEntered) resetCoverageExperience(false);
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

window.addEventListener("resize", () => {
  positionSelectionQueue();
  positionOverlapPanel();
  positionCoverageLayerTooltip();
  updateOverlapViewport();
  updateHomeScrollProgress();
});

window.addEventListener("scroll", updateHomeScrollProgress, { passive: true });

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target && (target.matches("input, textarea, select") || target.isContentEditable)) return;
  if (!isAtlasInteractive()) return;
  if (event.key === "Escape") {
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
    coverageDots?.focusSelection();
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
  updateCoverageReadout(activeSurveyId);
  if (surveyIndex) renderSurveys();
  if (overlapMode && activeOverlapComponents.length) {
    const component = activeOverlapComponents.find((entry) => entry.id === selectedQueueComponent?.id) ?? activeOverlapComponents[0];
    if (component && overlapDrawerOpen) {
      selectedQueueComponent = component;
      renderOverlapDrawerComponents();
      renderOverlapDrawerDetails(component);
    } else if (component) {
      renderOverlapPanel(activeOverlapSurveyIds, [...new Set(activeOverlapComponents.flatMap((entry) => entry.cells))], component.order, "GLOBAL", activeOverlapComponents);
    }
  }
  if (surveyIndex) renderSurveyFilterOptions();
  renderSelectionQueue();
  updateCoverageEmptyGuide();
});

window.addEventListener("atlas:theme-change", () => {
  coverageDots?.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
});

renderIcons();
void initialize().catch((error) => {
  console.error(error);
  byId("coverage-state").textContent = t("coverage.releaseUnavailable");
  if (!surveyIndex) byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: t("coverage.catalogLoadFailed") }));
});
