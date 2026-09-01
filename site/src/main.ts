import { BadgeCheck, BookOpen, Box, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Home, Image, Layers3, ListChecks, ListFilter, Maximize2, Minimize2, RotateCcw, Search, ShieldCheck, Telescope, X, createIcons } from "lucide";
import { Healpix } from "healpixjs";
import { AtlasCoverageGlobe, type CoverageCatalog } from "./atlas-coverage-globe.js";
import type { SurveyLayerContextMenu, SurveyLayerInspection, SurveyLayerOverlapComponent, SurveyLayerState } from "./atlas/survey-layer-viewer.js";
import { highestCommonCoverageOrder } from "./atlas/coverage-orders.js";
import { coverageLayerTooltipPosition } from "./atlas/layer-panel-layout.js";
import { overlapPanelExitTransform, overlapPanelsShouldExit } from "./overlap-layout.js";
import { joinUnique, overlapCsvDocument, overlapCsvRows, type DownloadPlan, type DownloadPlanEntrypoint, type DownloadPlanFile, type DownloadPlanMatch } from "./overlap-download.js";
import { locale, mountLocaleControls, t } from "./i18n.js";
import { loadPublicCatalogResource, type PublicCatalogResource, type PublicCatalogSource } from "./public-catalog.js";
import { createRevisionHydrationQueue } from "./revision-hydration-queue.js";

import "./styles.css";

type AssetKind = "package" | "moc" | "geometry" | "manifest" | "ledger" | "documentation" | "provenance" | "metadata";
type ProductStatus = "acquired" | "overview_only" | "awaiting_geometry" | "not_applicable";
type Modality = "imaging" | "spectroscopy" | "photometry" | "time-domain" | "integral-field" | "ultraviolet" | "infrared" | "catalog" | "simulation";

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

const modalityLabels: Record<Modality, string> = {
  imaging: "图像",
  spectroscopy: "光谱",
  photometry: "测光",
  "time-domain": "时域",
  "integral-field": "积分场",
  ultraviolet: "紫外",
  infrared: "红外",
  catalog: "目录",
  simulation: "仿真",
};
const modalityLabelsEn: Record<Modality, string> = {
  imaging: "Imaging", spectroscopy: "Spectroscopy", photometry: "Photometry", "time-domain": "Time-domain", "integral-field": "Integral-field", ultraviolet: "Ultraviolet", infrared: "Infrared", catalog: "Catalog", simulation: "Simulation",
};

const statusLabels: Record<ProductStatus, string> = {
  acquired: "已收录",
  overview_only: "仅概览",
  awaiting_geometry: "待计算",
  not_applicable: "不适用",
};
const statusLabelsEn: Record<ProductStatus, string> = { acquired: "Acquired", overview_only: "Overview only", awaiting_geometry: "Awaiting geometry", not_applicable: "Not applicable" };

function modalityLabel(modality: Modality): string { return locale() === "zh" ? modalityLabels[modality] : modalityLabelsEn[modality]; }
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
const PUBLIC_CATALOG_CACHE_KEYS = {
  surveys: "astro-assets:public-surveys:v1",
  coverage: "astro-assets:coverage-catalog:v1",
  assets: "astro-assets:release-manifest:v1",
} as const;
const PUBLIC_REQUEST_RETRY_DELAYS_MS = [150, 400, 900] as const;
let usedCachedPublicCatalog = false;
type PublicCatalogName = keyof typeof PUBLIC_CATALOG_CACHE_KEYS;
const publicCatalogSources: Record<PublicCatalogName, PublicCatalogSource | undefined> = {
  surveys: undefined,
  coverage: undefined,
  assets: undefined,
};
const selectedModalities = new Set<Modality>();
let modalityFilterInitialized = false;
let coverageDots: AtlasCoverageGlobe | null = null;
let activeSurveyId: string | null = null;
let coverageCatalog: CoverageCatalog | null = null;
const coverageBlockCache = new Map<string, number[]>();
const coverageRequests = new Map<string, Promise<number[]>>();
type CoverageLayerLoadState = "loading" | "ready" | "empty" | "error";
const coverageLayerLoadStates = new Map<string, CoverageLayerLoadState>();
const coverageLayerLoadErrors = new Map<string, string>();
const COVERAGE_CACHE_LIMIT = 128;
const COVERAGE_REFRESH_INTERVAL_MS = 60_000;
let coverageRefreshTimer: number | null = null;
let coverageCatalogEtag = "";
let coverageInitializationComplete = false;
let coverageRefreshInFlight: Promise<void> | null = null;
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

function cachePublicCatalog<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), value }));
  } catch {
    // Private browsing and quota limits must not make the public catalog fail.
  }
}

function readCachedPublicCatalog<T>(key: string, isValue: (value: unknown) => value is T): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { value?: unknown };
    return isValue(parsed?.value) ? parsed.value : undefined;
  } catch {
    return undefined;
  }
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
      const response = await fetch(url, { ...init, cache: "no-cache" });
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

function recordPublicCatalogResult(name: PublicCatalogName, result: PublicCatalogResource<unknown>): void {
  publicCatalogSources[name] = result.source;
  if (result.source !== "fresh") usedCachedPublicCatalog = true;
  if (result.error) console.warn(`Public catalog ${name} ${result.source}: ${result.error}`);
  const sources = Object.values(publicCatalogSources);
  document.body.dataset.publicCatalogState = sources.includes("unavailable")
    ? "unavailable"
    : sources.some((source) => source !== undefined && source !== "fresh")
      ? "degraded"
      : "fresh";
}
const overlapEvidenceCache = new Map<string, OverlapEvidenceResult>();
const overlapDetailsCache = new Map<string, OverlapDetailsResponse>();
let lastEscapeAt = -Infinity;
let homeEntered = false;
let coverageSelectionInitialized = false;

mountLocaleControls();

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
  applyCoverageSelection([target.surveyId]);
  coverageDots.setSelectedSurvey(target.surveyId);
  const layer = target.layerId
    ? coverageCatalog?.layers.find((entry) => entry.layerId === target.layerId)
    : target.productId
      ? coverageCatalog?.layers.find((entry) => entry.productId === target.productId)
      : undefined;
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
  const layers = surveyId ? (coverageCatalog?.layers.filter((layer) => layer.surveyId === surveyId) ?? []) : [];
  const visualOrders = [...new Set(layers.map((layer) => layer.overviewOrder))].sort((left, right) => left - right);
  const queryOrders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((left, right) => left - right);
  const orderText = visualOrders.length
    ? `VISUAL OVERVIEW · O${visualOrders.join("/O")} · QUERY O${queryOrders.join("/O")}`
    : "NESTED HEALPIX · NSIDE 16";
  if (!survey) {
    if (surveyId && layers.length) {
      scene.style.setProperty("--coverage-color", layers[0]?.color ?? "#42d5c4");
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
  scene.style.setProperty("--coverage-color", survey.color);
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
    if (!overlapMode) panel.hidden = true;
    return;
  }
  if (overlapMode) return;
  panel.classList.remove("is-overlap-panel");
  panel.style.removeProperty("left");
  panel.style.removeProperty("top");
  panel.style.removeProperty("right");
  panel.style.removeProperty("width");
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = t("coverage.cellInspector");
  byId("coverage-detail-title").textContent = `ORDER ${Math.round(Math.log2(inspection.nside))} · IPix ${inspection.pixel}`;
  const content = byId("coverage-detail-content");
  const rows: Array<[string, string]> = [
    ["NSIDE", String(inspection.nside)],
    ["RA / DEC", `${inspection.centerRaDeg.toFixed(4)}° / ${inspection.centerDecDeg.toFixed(4)}°`],
    ["POINTER", `${inspection.pointerRaDeg.toFixed(4)}° / ${inspection.pointerDecDeg.toFixed(4)}°`],
    ["SURVEYS", inspection.surveyIds.length ? inspection.surveyIds.map((id) => surveyIndex?.surveys.find((survey) => survey.id === id)?.name ?? id).join(", ") : "--"],
    ["RELEASES", inspection.releaseIds.length ? inspection.releaseIds.join(", ") : "--"],
    ["SOURCES", inspection.artifacts.length ? inspection.artifacts.map((artifact) => artifact.product).join(", ") : inspection.workspaceAvailable ? "workspace layer" : "--"],
  ];
  content.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
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
  setOverlapPanelInteraction(panel, crowded || layersOpen);
  setOverlapPanelInteraction(queue, crowded || layersOpen);
}

function visibleSurveyIdsFromControls(): string[] {
  return [...byId("coverage-layers").querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")]
    .map((input) => input.dataset.surveyId)
    .filter((value): value is string => Boolean(value));
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
  return highestCommonCoverageOrder(coverageCatalog?.layers ?? [], surveyIds);
}

function surveyCellsAtOrder(surveyId: string, order: number): Set<number> {
  const cells = new Set<number>();
  for (const layer of coverageCatalog?.layers.filter((candidate) => candidate.surveyId === surveyId && candidate.availableOrders.includes(order)) ?? []) {
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
interface OverlapDetailsResponse {
  schemaVersion: 1;
  component: OverlapComponentView;
  publicSources: Array<{ layerId: string; surveyId: string; surveyName: string; releaseId: string; releaseLabel?: string; product: string; modality?: string; description?: string; sourceUrl?: string; geometrySourceUrl?: string; coverageClaim?: { kind: string; url?: string; status?: string }; dataOrigin?: string; sourceTier?: string; sourceLabel?: string; geometrySourceLabel?: string; sourceUnits?: { status?: string; unitKind?: string; units?: Array<{ unitId: string; exposureCount?: number; lastNight?: number; downloadUrl?: string }>; totalUnits?: number; truncated?: boolean; notes?: string } }>;
  assetsEvidence: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; artifacts: Array<{ id: string; kind: string; label: string; downloadUrl: string; previewUrl?: string; sha256: string; sizeBytes: number }> }>;
  warehouseEvidence: Array<{ layerId: string; surveyId: string; releaseId: string; productId: string; product?: string; modality?: string; state: string; scanRunId?: string; availableOrders: number[]; commonOrder: number; coverageCells: number; fileCount: number; coverageCount: number; precision: string; sourceSnapshotSha256?: string; connector: { status: string; name?: string; type?: string }; method: { summary: string; docsUrl?: string } }>;
  method: { summary: string; docsUrl?: string };
  reverseLookup: { endpoint: string; layerIds: string[]; order: number; precision: string; deferred: boolean };
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
  return coverageCatalog?.layers.filter((layer) => layer.surveyId === surveyId) ?? [];
}

function createCoverageLayerDetail(surveyId: string, persistent = false): HTMLElement {
  const layers = layersForSurvey(surveyId);
  const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
  const color = layers[0]?.color ?? survey?.color ?? "#42d5c4";
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
  const stateLabel = states.includes("error") ? "ERROR" : states.includes("loading") ? "LOADING" : states.includes("empty") ? "EMPTY" : "READY";
  summary.textContent = `${layers.length} products · ${orders.length ? `O${orders.join("/O")}` : "HEALPIX --"}${modalities.length ? ` · ${modalities.join(" · ")}` : ""} · ${stateLabel}`;
  body.append(kicker, title, summary);
  const list = document.createElement("div");
  list.className = "coverage-layer-detail-list";
  layers.forEach((layer) => {
    const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
    const product = release?.products.find((entry) => entry.name === layer.product);
    const row = document.createElement("div");
    row.className = "coverage-layer-detail-row";
    const state = coverageLayerLoadStates.get(layer.layerId) ?? "loading";
    row.textContent = `${layer.product || product?.name || "Coverage"} · ${layer.releaseId || release?.label || "--"} · ${layer.availableOrders.length ? `O${layer.availableOrders.join("/O")}` : "HEALPIX --"} · ${state.toUpperCase()}`;
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
  const auxiliaryPanels = [byId("coverage-detail-panel"), byId("selection-queue")];
  layers.hidden = !open;
  if (open) document.body.dataset.layersPanel = "open";
  else document.body.removeAttribute("data-layers-panel");
  auxiliaryPanels.forEach((panel) => { panel.inert = open; });
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

function renderOverlapPanel(surveyIds: string[], pixels: number[], order: number, scope = "GLOBAL", componentData?: OverlapComponentView[]): void {
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
  setOverlapExpandVisible(Boolean(componentData?.length ?? activeOverlapComponents.length));
  byId("coverage-detail-kicker").textContent = t("coverage.overlapResult");
  byId("coverage-detail-title").textContent = `${scope} · ${surveyIds.length} SURVEYS`;
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
  components.forEach((component, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === 0 ? "is-active" : "";
    button.textContent = component.id;
    button.addEventListener("click", () => {
      selectOverlapComponent(component, surveyIds, content);
    });
    componentNav.append(button);
  });
  content.append(componentNav);
  const initialComponent = components.find((component) => component.id === selectedQueueComponent?.id) ?? components[0]!;
  selectOverlapComponent(initialComponent, surveyIds, content);
  positionOverlapPanel();
}

function selectOverlapComponent(component: OverlapComponentView, surveyIds = activeOverlapSurveyIds, content = byId("coverage-detail-content")): void {
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

async function fetchOverlapEvidence(component: OverlapComponentView, signal?: AbortSignal): Promise<OverlapEvidenceResult | null> {
  const lookup = component.evidenceLookup;
  if (!lookup) return null;
  const cached = overlapEvidenceCache.get(component.id);
  if (cached) return cached;
  const response = await fetch(lookup.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal,
    body: JSON.stringify({ layerIds: lookup.layerIds, order: lookup.order, cells: component.cells, limit: 5000 }),
  });
  if (!response.ok) throw new Error(`reverse lookup HTTP ${response.status}`);
  const result = await response.json() as OverlapEvidenceResult;
  overlapEvidenceCache.set(component.id, result);
  return result;
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
    files.set(fileId, {
      fileId,
      metadataState: source ? "complete" : "missing",
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

async function downloadOverlapCsv(components: OverlapComponentView[], filename: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent ?? "Download CSV";
  button.disabled = true;
  button.textContent = t("coverage.downloadLoading");
  try {
    const results = await Promise.all(components.map((component) => fetchOverlapEvidence(component)));
    const rows = components.flatMap((component, index) => overlapCsvRows(component, downloadPlanFor(results[index]), publicLayerEntry, results[index]?.precision));
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
  } catch {
    toast(t("coverage.downloadUnavailable"));
  } finally {
    button.disabled = false;
    button.replaceChildren(icon("download"), document.createTextNode(original));
    renderIcons();
  }
}

async function downloadOverlapJson(components: OverlapComponentView[], filename: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent ?? "Download JSON";
  button.disabled = true;
  button.textContent = t("coverage.downloadLoading");
  try {
    const results = await Promise.all(components.map((component) => fetchOverlapEvidence(component)));
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
  } catch {
    toast(t("coverage.downloadUnavailable"));
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
  const locator = document.createElement("div");
  locator.className = "overlap-source-locator";
  const value = document.createElement("code");
  value.textContent = `${local ? "LOCAL FILE URI" : object ? "OBJECT URI" : "SOURCE URI"} · ${sourceUri}`;
  const copyUri = document.createElement("button");
  copyUri.className = "icon-button overlap-source-copy";
  copyUri.type = "button";
  copyUri.title = "复制源文件 URI";
  copyUri.setAttribute("aria-label", `复制源文件 URI ${sourceUri}`);
  copyUri.append(icon("copy"));
  copyUri.addEventListener("click", () => void copy(sourceUri, t("coverage.uriCopied")));
  locator.append(value, copyUri);
  row.append(locator);
  row.append(Object.assign(document.createElement("small"), {
    textContent: local
      ? "本地文件定位符：需在对应数据挂载环境访问"
      : object
        ? "对象存储定位符：需使用对应存储权限访问"
        : remote
          ? "源文件 URI：记录实际数据位置；官方下载链接可能不同"
          : "源文件定位符不可由浏览器直接下载",
  }));
}

function renderEvidencePlan(node: HTMLElement, result: OverlapEvidenceResult): void {
  node.replaceChildren();
  const plan = downloadPlanFor(result);
  if (!result.available && !plan.files.length && !plan.entrypoints.length) {
    node.append(Object.assign(document.createElement("small"), { textContent: t("coverage.evidenceUnavailable") }));
    return;
  }
  const directFiles = plan.files.filter((file) => file.downloadable).length;
  const locatorFiles = plan.files.filter((file) => Boolean(file.sourceUri)).length;
  const tileLinks = plan.entrypoints.filter((entry) => entry.kind === "tile-directory").length;
  const heading = document.createElement("strong");
  heading.textContent = `DOWNLOAD PLAN · ${plan.files.length} files · ${directFiles} direct downloads · ${locatorFiles} URI locators · ${tileLinks} tile links${plan.truncated ? " · truncated" : ""}`;
  node.append(heading);
  if (plan.warnings.length) {
    const warning = document.createElement("small");
    warning.textContent = plan.warnings.join(" · ");
    warning.className = "overlap-evidence-warning";
    node.append(warning);
  }
  if (plan.files.length) {
    const filesHeading = document.createElement("strong");
    filesHeading.textContent = "FILES · coverage matches";
    node.append(filesHeading);
    const list = document.createElement("div");
    list.className = "overlap-evidence-files";
    plan.files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "overlap-evidence-file";
      const title = document.createElement("strong");
      title.textContent = file.fileName ?? file.fileId;
      row.append(title);
      const matchSummary = document.createElement("small");
      matchSummary.textContent = `${file.matchingCoverage.length} coverage match${file.matchingCoverage.length === 1 ? "" : "es"} · ${joinUnique(file.matchingCoverage.map((match) => match.layerId)) || "layer unknown"} · ${joinUnique(file.matchingCoverage.map((match) => `O${match.order}:${match.ipix}`))}`;
      row.append(matchSummary);
      if (file.metadataState === "missing") row.append(Object.assign(document.createElement("small"), { textContent: "FileAsset metadata missing; not verified as a complete file record" }));
      let hasLocation = false;
      if (file.downloadUrl) {
        const link = drawerExternalLink(file.downloadUrl, file.downloadUrl);
        if (link) {
          link.title = t("coverage.downloadOfficial");
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
    node.append(list);
  } else {
    node.append(Object.assign(document.createElement("small"), { textContent: t("coverage.noSourceFiles") }));
  }
  if (plan.entrypoints.length) {
    const heading = document.createElement("strong");
    heading.textContent = `DATA / COVERAGE ENTRYPOINTS · ${plan.entrypoints.length}`;
    node.append(heading);
    const list = document.createElement("div");
    list.className = "overlap-evidence-files";
    plan.entrypoints.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "overlap-evidence-file";
      row.append(Object.assign(document.createElement("strong"), { textContent: `${entry.kind} · ${entry.product ?? entry.productId ?? entry.layerId ?? "entrypoint"}` }));
      if (entry.order !== undefined) row.append(Object.assign(document.createElement("small"), { textContent: `O${entry.order} · ${(entry.cells ?? []).length} cells · ${entry.precision}` }));
      if (entry.note) row.append(Object.assign(document.createElement("small"), { textContent: entry.note }));
      const entryUrl = entry.url ?? entry.sourceUrl ?? entry.mocUrl;
      const entryLabel = entry.kind === "tile-directory" && typeof entryUrl === "string"
        ? entryUrl
        : entry.purpose === "coverage-reference" ? "Coverage reference" : "Official data entrypoint";
      const entryLink = drawerDocLink(entryUrl, entryLabel);
      if (entry.kind === "tile-directory" && entry.tileId) row.append(Object.assign(document.createElement("small"), { textContent: `TILE ${entry.tileId}` }));
      if (entryLink) row.append(entryLink);
      list.append(row);
    });
    node.append(list);
  }
  renderIcons();
}

async function loadOverlapEvidence(component: OverlapComponentView, node: HTMLElement): Promise<void> {
  const lookup = component.evidenceLookup;
  if (!lookup) return;
  overlapEvidenceController?.abort();
  const controller = new AbortController();
  overlapEvidenceController = controller;
  const request = ++overlapEvidenceSequence;
  node.replaceChildren(Object.assign(document.createElement("small"), { textContent: t("coverage.queryingPlan") }));
  try {
    const result = await fetchOverlapEvidence(component, controller.signal);
    if (!result) return;
    if (request === overlapEvidenceSequence && !controller.signal.aborted) renderEvidencePlan(node, result);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (request === overlapEvidenceSequence) node.replaceChildren(Object.assign(document.createElement("small"), { textContent: t("coverage.reverseFailed") }));
  } finally {
    if (overlapEvidenceController === controller) overlapEvidenceController = null;
  }
}

function renderOverlapComponent(component: OverlapComponentView, surveyIds: string[], content: HTMLElement): void {
  overlapEvidenceController?.abort();
  content.querySelectorAll(".overlap-component-detail, .overlap-products, .overlap-result-actions, .overlap-evidence-plan").forEach((node) => node.remove());
  const detail = document.createElement("div");
  detail.className = "overlap-component-detail";
  const bounds = component.bounds;
  detail.textContent = `${component.id} · ${component.cells.length.toLocaleString("en-US")} cells · ${bounds.areaDeg2.toFixed(2)} deg² · RA ${bounds.raMin.toFixed(2)}°${bounds.raWraps ? "↷" : "–"}${bounds.raMax.toFixed(2)}° · DEC ${bounds.decMin.toFixed(2)}°–${bounds.decMax.toFixed(2)}°`;
  content.append(detail);
  const products = document.createElement("div");
  products.className = "overlap-products";
  const entries: OverlapSurveyView[] = component.surveys ?? surveyIds.flatMap((surveyId): OverlapSurveyView[] => {
    const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
    return survey?.releases.flatMap((release) => release.products.filter((product) => product.coverage).map((product) => ({ surveyId, releaseId: release.id, product: product.name, modality: product.modality, downloadUrl: product.sourceUrl }))) ?? [];
  });
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "coverage-detail-product";
    row.textContent = `${surveyIndex?.surveys.find((survey) => survey.id === entry.surveyId)?.name ?? entry.surveyId} · ${entry.releaseId} · ${entry.product} · ${entry.modality ?? "--"}`;
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
    products.append(row);
  });
  if (!entries.length) products.append(Object.assign(document.createElement("p"), { className: "overlap-empty", textContent: t("coverage.noProducts") }));
  content.append(products);
  const list = document.createElement("div");
  list.className = "overlap-result-actions";
  const downloads = document.createElement("div");
  downloads.className = "overlap-download-actions";
  const currentDownload = document.createElement("button");
  currentDownload.type = "button";
  currentDownload.className = "command-button overlap-download-button";
  currentDownload.append(icon("download"), document.createTextNode(t("coverage.downloadCurrent")));
  currentDownload.addEventListener("click", () => void downloadOverlapCsv([component], `atlas-overlap-${component.id}-download-plan.csv`, currentDownload));
  downloads.append(currentDownload);
  const currentJson = document.createElement("button");
  currentJson.type = "button";
  currentJson.className = "command-button overlap-download-button";
  currentJson.append(icon("file-json-2"), document.createTextNode(t("coverage.downloadJson")));
  currentJson.addEventListener("click", () => void downloadOverlapJson([component], `atlas-overlap-${component.id}-download-plan.json`, currentJson));
  downloads.append(currentJson);
  if (activeOverlapComponents.length > 1) {
    const allDownload = document.createElement("button");
    allDownload.type = "button";
    allDownload.className = "command-button overlap-download-button";
    allDownload.append(icon("download"), document.createTextNode(t("coverage.downloadAll")));
    allDownload.addEventListener("click", () => void downloadOverlapCsv(activeOverlapComponents, "atlas-overlap-all-download-plan.csv", allDownload));
    downloads.append(allDownload);
    const allJson = document.createElement("button");
    allJson.type = "button";
    allJson.className = "command-button overlap-download-button";
    allJson.append(icon("file-json-2"), document.createTextNode(t("coverage.downloadJson")));
    allJson.addEventListener("click", () => void downloadOverlapJson(activeOverlapComponents, "atlas-overlap-all-download-plan.json", allJson));
    downloads.append(allJson);
  }
  list.append(downloads);
  if (component.evidenceLookup) {
    const evidence = document.createElement("div");
    evidence.className = "overlap-evidence-plan";
    list.append(evidence);
    void loadOverlapEvidence(component, evidence);
  }
  content.append(list);
}

function setOverlapExpandVisible(visible: boolean): void {
  const button = byId<HTMLButtonElement>("overlap-expand");
  button.hidden = !visible;
}

function overlapDetailsCacheKey(component: OverlapComponentView): string {
  return `${activeOverlapSurveyIds.slice().sort().join(",")}:${component.id}:${component.order}`;
}

async function fetchOverlapDetails(component: OverlapComponentView, signal?: AbortSignal): Promise<OverlapDetailsResponse> {
  const key = overlapDetailsCacheKey(component);
  const cached = overlapDetailsCache.get(key);
  if (cached) return cached;
  const response = await fetch("/api/v1/coverage/overlap/details", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ surveyIds: activeOverlapSurveyIds, componentId: component.id, requestedOrder: component.order }),
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

function renderOverlapDrawerComponents(): void {
  const host = byId("overlap-drawer-components");
  host.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = t("coverage.connectedRegions");
  host.append(heading);
  activeOverlapComponents.forEach((component) => {
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
    host.append(button);
  });
}

function renderOverlapDrawerLoading(component: OverlapComponentView): void {
  const drawer = byId("overlap-drawer");
  byId("overlap-drawer-title").textContent = `${component.id} · O${component.order}`;
  const content = byId("overlap-drawer-content");
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
  const error = document.createElement("p");
  error.className = "overlap-drawer-error";
  error.textContent = message;
  content.replaceChildren(error);
}

function renderOverlapDrawerResponse(details: OverlapDetailsResponse): void {
  const drawer = byId("overlap-drawer");
  drawer.removeAttribute("aria-busy");
  const component = details.component;
  byId("overlap-drawer-title").textContent = `${component.id} · O${component.order} · ${component.cells.length.toLocaleString("en-US")} cells`;
  const content = byId("overlap-drawer-content");
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

  const publicSection = drawerSection(t("coverage.publicSources"));
  const publicList = document.createElement("div");
  publicList.className = "overlap-drawer-list";
  if (!details.publicSources.length) {
    const empty = document.createElement("p"); empty.className = "overlap-drawer-copy"; empty.textContent = t("coverage.publicUnavailable"); publicList.append(empty);
  } else details.publicSources.forEach((source) => {
    const card = document.createElement("article"); card.className = "overlap-drawer-card";
    const title = document.createElement("strong"); title.textContent = `${drawerText(source.surveyName, source.surveyId)} · ${drawerText(source.releaseLabel ?? source.releaseId)} · ${drawerText(source.product)}`;
    card.append(title);
    const metadata = document.createElement("small"); metadata.textContent = `${source.modality ? `${source.modality} · ` : ""}${source.dataOrigin ? `${source.dataOrigin} · ` : ""}${source.coverageClaim?.kind?.toUpperCase() ?? "OVERVIEW"}`; card.append(metadata);
    if (source.sourceLabel || source.sourceTier || source.geometrySourceLabel) {
      const provenance = document.createElement("small"); provenance.textContent = `${source.sourceLabel ?? "Source"}${source.sourceTier ? ` · ${source.sourceTier}` : ""}${source.geometrySourceLabel ? ` · ${source.geometrySourceLabel}` : ""}`; card.append(provenance);
    }
    if (source.description) card.append(Object.assign(document.createElement("p"), { className: "overlap-drawer-copy", textContent: source.description }));
    const links = document.createElement("div"); links.className = "overlap-unit-links";
    const sourceLink = drawerExternalLink(source.sourceUrl, source.sourceLabel ?? "Source / release page"); if (sourceLink) links.append(sourceLink);
    const geometryLink = drawerExternalLink(source.geometrySourceUrl ?? source.coverageClaim?.url, source.geometrySourceLabel ?? "Geometry / inventory input"); if (geometryLink) links.append(geometryLink);
    if (links.childElementCount) card.append(links);
    if (source.sourceUnits) {
      const units = document.createElement("small"); units.textContent = `${source.sourceUnits.unitKind ?? "source units"} · ${source.sourceUnits.totalUnits ?? source.sourceUnits.units?.length ?? 0}${source.sourceUnits.truncated ? " · truncated" : ""}`; card.append(units);
      source.sourceUnits.units?.slice(0, 12).forEach((unit) => {
        const unitLink = drawerExternalLink(unit.downloadUrl, `TILE ${unit.unitId}`);
        if (unitLink) {
          unitLink.title = `TILE ${unit.unitId} · NEXP ${unit.exposureCount ?? "--"} · LASTNIGHT ${unit.lastNight ?? "--"}`;
          links.append(unitLink);
        }
      });
    }
    publicList.append(card);
  });
  publicSection.append(publicList);
  content.append(publicSection);

  const assetsSection = drawerSection("ASSETS RELEASE EVIDENCE");
  const assetsList = document.createElement("div"); assetsList.className = "overlap-drawer-list";
  if (!details.assetsEvidence.length) assetsList.append(Object.assign(document.createElement("p"), { className: "overlap-drawer-copy", textContent: "No Assets release artifacts are linked to this layer." }));
  details.assetsEvidence.forEach((entry) => {
    const card = document.createElement("article"); card.className = "overlap-drawer-card is-assets";
    const title = document.createElement("strong"); title.textContent = `${entry.product} · ${entry.artifacts.length} artifacts`; card.append(title);
    entry.artifacts.forEach((artifact) => {
      const row = document.createElement("div"); row.className = "overlap-unit-links";
      const link = drawerDocLink(artifact.downloadUrl, `${artifact.kind.toUpperCase()} · ${artifact.label}`); if (link) row.append(link);
      row.append(Object.assign(document.createElement("small"), { textContent: `${bytes(artifact.sizeBytes)} · SHA-256 ${artifact.sha256.slice(0, 12)}…` }));
      card.append(row);
    });
    assetsList.append(card);
  });
  assetsSection.append(assetsList); content.append(assetsSection);

  const warehouseSection = drawerSection(t("coverage.warehouseEvidence"));
  const warehouseList = document.createElement("div");
  warehouseList.className = "overlap-drawer-list";
  if (!details.warehouseEvidence.length) {
    const empty = document.createElement("p"); empty.className = "overlap-drawer-copy"; empty.textContent = t("coverage.warehouseUnavailable"); warehouseList.append(empty);
  } else details.warehouseEvidence.forEach((evidence) => {
    const card = document.createElement("article"); card.className = "overlap-drawer-card is-warehouse";
    const title = document.createElement("strong"); title.textContent = `${drawerText(evidence.product, evidence.productId)} · ${drawerText(evidence.releaseId)} `;
    const status = document.createElement("span"); status.className = "overlap-drawer-card-status"; status.dataset.state = evidence.state; status.textContent = evidence.state; title.append(status); card.append(title);
    const counts = document.createElement("small"); counts.textContent = `${evidence.modality ?? "coverage"} · ${evidence.coverageCells} cells · ${evidence.fileCount} files · ${evidence.coverageCount} edges · ${evidence.precision} · O${evidence.commonOrder}`; card.append(counts);
    if (evidence.scanRunId) card.append(Object.assign(document.createElement("small"), { textContent: `SCAN RUN ${evidence.scanRunId}` }));
    if (evidence.sourceSnapshotSha256) card.append(Object.assign(document.createElement("code"), { textContent: `SNAPSHOT SHA-256 ${evidence.sourceSnapshotSha256}` }));
    const connector = document.createElement("small"); connector.textContent = `${t("coverage.connector")}: ${evidence.connector.status}${evidence.connector.name ? ` · ${evidence.connector.name}` : ""}${evidence.connector.type ? ` · ${evidence.connector.type}` : ""}`; card.append(connector);
    warehouseList.append(card);
  });
  warehouseSection.append(warehouseList);
  content.append(warehouseSection);

  const methodSection = drawerSection(t("coverage.method"));
  const methodCopy = document.createElement("p"); methodCopy.className = "overlap-drawer-copy"; methodCopy.textContent = details.method.summary; methodSection.append(methodCopy);
  const methodLink = drawerDocLink(details.method.docsUrl, "Coverage method documentation"); if (methodLink) methodSection.append(methodLink);
  const reverse = document.createElement("p"); reverse.className = "overlap-drawer-copy"; reverse.textContent = `${t("coverage.reverseLookup")}: ${details.reverseLookup.endpoint} · O${details.reverseLookup.order} · ${details.reverseLookup.precision}${details.reverseLookup.deferred ? " · deferred" : ""}`; methodSection.append(reverse);
  content.append(methodSection);

  const actionsSection = drawerSection("DOWNLOAD PLAN");
  const actions = document.createElement("div"); actions.className = "overlap-drawer-actions";
  const currentCsv = document.createElement("button"); currentCsv.type = "button"; currentCsv.className = "command-button overlap-download-button"; currentCsv.append(icon("download"), document.createTextNode(t("coverage.downloadCurrent"))); currentCsv.addEventListener("click", () => void downloadOverlapCsv([component], `atlas-overlap-${component.id}-download-plan.csv`, currentCsv)); actions.append(currentCsv);
  const currentJson = document.createElement("button"); currentJson.type = "button"; currentJson.className = "command-button overlap-download-button"; currentJson.append(icon("file-json-2"), document.createTextNode(t("coverage.downloadJson"))); currentJson.addEventListener("click", () => void downloadOverlapJson([component], `atlas-overlap-${component.id}-download-plan.json`, currentJson)); actions.append(currentJson);
  if (activeOverlapComponents.length > 1) {
    const allCsv = document.createElement("button"); allCsv.type = "button"; allCsv.className = "command-button overlap-download-button"; allCsv.append(icon("download"), document.createTextNode(t("coverage.downloadAll"))); allCsv.addEventListener("click", () => void downloadOverlapCsv(activeOverlapComponents, "atlas-overlap-all-download-plan.csv", allCsv)); actions.append(allCsv);
    const allJson = document.createElement("button"); allJson.type = "button"; allJson.className = "command-button overlap-download-button"; allJson.append(icon("file-json-2"), document.createTextNode(t("coverage.downloadJson"))); allJson.addEventListener("click", () => void downloadOverlapJson(activeOverlapComponents, "atlas-overlap-all-download-plan.json", allJson)); actions.append(allJson);
  }
  actionsSection.append(actions);
  content.append(actionsSection);
  renderIcons();
}

function renderOverlapDrawerDetails(component: OverlapComponentView): void {
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
    toast(t("coverage.needTwoSurveys"));
    return;
  }
  let order: number | null = null;
  if (activate) {
    order = commonOverviewOrder(surveyIds);
    if (order === null) {
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
    activeOverlapComponents = [];
    overlapEvidenceCache.clear();
    overlapDetailsCache.clear();
    coverageDots?.setOverlapMode(false);
    coverageDots?.setActiveOverlapComponent(null);
    updateOverlapHud(null);
    const panel = byId("coverage-detail-panel");
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
  overlapDetailsCache.clear();
  updateOverlapHud(null);
  overlapController?.abort();
  const controller = new AbortController();
  overlapController = controller;
  renderOverlapLoadingPanel(surveyIds, order);
  try {
    const response = await fetch("/api/v1/coverage/overlap", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ surveyIds, requestedOrder: order }), signal: controller.signal });
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
  for (const layer of coverageCatalog.layers) grouped.set(layer.surveyId, [...(grouped.get(layer.surveyId) ?? []), layer]);
  for (const [surveyId, layers] of grouped) {
    const label = document.createElement("div");
    label.className = "coverage-layer-toggle";
    label.setAttribute("title", "拖动三横线把手以调整图层顺序");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = queuedLayerIds.has(surveyId);
    input.dataset.surveyId = surveyId;
    const name = document.createElement("span");
    const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
    label.dataset.searchText = `${survey?.name ?? surveyId} ${survey?.mission ?? ""}`.toLocaleLowerCase();
    const loadState = layers.some((layer) => coverageLayerLoadStates.get(layer.layerId) === "error")
      ? "ERROR"
      : layers.some((layer) => coverageLayerLoadStates.get(layer.layerId) === "loading") ? "LOADING" : "READY";
    name.textContent = `${survey?.name ?? surveyId.toUpperCase()} · ${loadState}`;
    name.className = "coverage-layer-name";
    const swatch = document.createElement("span");
    swatch.className = "coverage-layer-swatch";
    swatch.style.backgroundColor = layers[0]?.color ?? survey?.color ?? "#42d5c4";
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
    label.append(input, swatch, handle, name);
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

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function toast(message: string): void {
  const element = byId("toast");
  element.textContent = message;
  element.dataset.visible = "true";
  window.setTimeout(() => { element.dataset.visible = "false"; }, 1800);
}

async function copy(value: string, message = "SHA-256 已复制"): Promise<void> {
  await navigator.clipboard.writeText(value);
  toast(message);
}

function renderIcons(): void {
    createIcons({
    icons: { BadgeCheck, BookOpen, Box, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Home, Image, Layers3, ListChecks, ListFilter, Maximize2, Minimize2, RotateCcw, Search, ShieldCheck, Telescope, X },
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
      renderSurveys();
      updateSurveyFilterCount();
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
    if (!selectedModalities.size || !survey.modalities.some((modality) => selectedModalities.has(modality))) return false;
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
    row.style.setProperty("--survey-color", survey.color);
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

async function fetchCoverageCatalogDocument(): Promise<CoverageCatalog | null> {
  const headers = new Headers({ Accept: "application/json" });
  if (coverageCatalogEtag) headers.set("If-None-Match", coverageCatalogEtag);
  const response = await fetchPublicResponse("/api/v1/coverage/catalog", { headers });
  if (response.status === 304) return null;
  coverageCatalogEtag = response.headers.get("etag") ?? coverageCatalogEtag;
  const next = await response.json() as unknown;
  if (!isCoverageCatalog(next)) throw new Error("Coverage catalog response is invalid");
  cachePublicCatalog(PUBLIC_CATALOG_CACHE_KEYS.coverage, next);
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

function refreshCoverageCatalog(): Promise<void> {
  if (document.hidden || !coverageDots || !coverageInitializationComplete) return Promise.resolve();
  if (coverageRefreshInFlight) return coverageRefreshInFlight;
  const request = (async (): Promise<void> => {
    try {
      const next = await fetchCoverageCatalogDocument();
      if (next) {
        const nextRevision = coverageCatalogRevisionKey(next);
        const currentRevision = coverageCatalog ? coverageCatalogRevisionKey(coverageCatalog) : null;
        if (nextRevision !== currentRevision || coverageHydration.appliedRevision !== nextRevision) {
          await hydrateCoverageCatalog(next);
          if (deepLinkTarget?.surveyId) focusSkyTarget(deepLinkTarget);
        }
      } else if (coverageCatalog) {
        // A failed hydration may have already recorded the catalog ETag. A
        // subsequent refresh therefore returns 304; retry the un-applied
        // catalog instead of treating that response as a successful load.
        const currentRevision = coverageCatalogRevisionKey(coverageCatalog);
        if (coverageHydration.appliedRevision !== currentRevision) {
          await hydrateCoverageCatalog(coverageCatalog, true);
          if (deepLinkTarget?.surveyId) focusSkyTarget(deepLinkTarget);
        }
      }
    } catch (error) {
      byId("coverage-state").textContent = error instanceof Error ? error.message : "COVERAGE CATALOG REFRESH FAILED";
    }
  })();
  coverageRefreshInFlight = request;
  void request.finally(() => {
    if (coverageRefreshInFlight === request) coverageRefreshInFlight = null;
  });
  return request;
}

function scheduleCoverageRefresh(): void {
  if (coverageRefreshTimer !== null) window.clearInterval(coverageRefreshTimer);
  coverageRefreshTimer = window.setInterval(() => void refreshCoverageCatalog(), COVERAGE_REFRESH_INTERVAL_MS);
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
  try {
    coverageDots = new AtlasCoverageGlobe(byId("coverage-scene"), byId<HTMLCanvasElement>("coverage-canvas"), updateCoverageReadout, updateCoverageInspector, updateCoverageState, openCoverageContextMenu, handleOverlapComponentLabel);
  } catch (error) {
    console.warn("HEALPix globe unavailable", error);
    byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
  }
  const assetsPromise = loadPublicCatalogResource<ReleaseManifest>(async () => {
    const value = await fetchPublicJson<unknown>("/api/v1/assets", { headers: { Accept: "application/json" } });
    if (!isReleaseManifest(value)) throw new Error("Public asset catalog response is invalid");
    cachePublicCatalog(PUBLIC_CATALOG_CACHE_KEYS.assets, value);
    return value;
  }, {
    current: manifest,
    cached: readCachedPublicCatalog(PUBLIC_CATALOG_CACHE_KEYS.assets, isReleaseManifest),
  });
  const coveragePromise = loadPublicCatalogResource<CoverageCatalog>(fetchCoverageCatalogDocument, {
    current: coverageCatalog,
    cached: readCachedPublicCatalog(PUBLIC_CATALOG_CACHE_KEYS.coverage, isCoverageCatalog),
  });
  const surveysPromise = loadPublicCatalogResource<SurveyIndex>(async () => {
    const value = await fetchPublicJson<unknown>("/api/v1/surveys", { headers: { Accept: "application/json" } });
    if (!isSurveyIndex(value)) throw new Error("Public survey catalog response is invalid");
    cachePublicCatalog(PUBLIC_CATALOG_CACHE_KEYS.surveys, value);
    return value;
  }, {
    current: surveyIndex,
    cached: readCachedPublicCatalog(PUBLIC_CATALOG_CACHE_KEYS.surveys, isSurveyIndex),
  });
  const [assetsResult, coverageResult, surveysResult] = await Promise.all([assetsPromise, coveragePromise, surveysPromise]);
  recordPublicCatalogResult("assets", assetsResult);
  recordPublicCatalogResult("coverage", coverageResult);
  recordPublicCatalogResult("surveys", surveysResult);

  if (surveysResult.value) {
    surveyIndex = surveysResult.value;
    initializeModalityFilter();
    renderSurveys();
  } else if (!surveyIndex) {
    byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: t("coverage.catalogLoadFailed") }));
  }

  if (coverageResult.value) {
    // Keep the catalog and URL state usable even when the optional WebGL
    // viewer could not be created (for example, in a headless browser).
    try {
      await hydrateCoverageCatalog(coverageResult.value);
      applySkyDeepLink();
    } catch (error) {
      console.warn("Coverage preview unavailable", error);
      byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
    }
    // Keep retrying a catalog whose first viewer hydration failed. The
    // refresh path can reuse the un-applied catalog even when the server
    // answers 304 for its already-recorded ETag.
    scheduleCoverageRefresh();
  } else {
    byId("coverage-state").textContent = "COVERAGE CATALOG UNAVAILABLE";
  }

  if (assetsResult.value) {
    manifest = assetsResult.value;
    byId("footer-release").textContent = `${manifest.bundle.id.toUpperCase()} · VERIFIED`;
    byId("stat-releases").textContent = String(manifest.statistics.releases);
    byId("stat-acquired").textContent = String(manifest.statistics.acquired);
    byId("stat-moc").textContent = String(manifest.statistics.rawMocFiles);
    byId("stat-packages").textContent = String(manifest.statistics.packages);
    byId("stat-size").textContent = bytes(manifest.statistics.runtimeBytes ?? manifest.statistics.totalBytes);
    byId("home-stat-releases").textContent = String(manifest.statistics.releases);
    byId("bundle-hash").textContent = manifest.bundle.sha256;
    byId("generated-at").textContent = new Date(manifest.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" }) + " UTC";
    const provenance = manifest.files.find((record) => record.kind === "provenance");
    if (provenance) byId<HTMLAnchorElement>("provenance-download").href = provenance.downloadUrl;
  }
  if (usedCachedPublicCatalog) byId("coverage-state").textContent = "PUBLIC CATALOG CACHED · RETRYING";
  coverageInitializationComplete = true;
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
function resetCoverageExperience(updateUrl = true): void {
  closeCoverageContextMenu();
  closeOverlapDrawer();
  applyCoverageSelection([]);
  deepLinkTarget = null;
  if (updateUrl) syncSkyDeepLink();
  clearLayerCloseTimer();
  setOverlapMode(false);
  overlapController?.abort();
  overlapController = null;
  activeOverlapSurveyIds = [];
  activeOverlapComponents = [];
  overlapEvidenceCache.clear();
  overlapDetailsCache.clear();
  coverageDots?.setOverlapMode(false);
  coverageDots?.setActiveOverlapComponent(null);
  updateOverlapHud(null);
  coverageDots?.clearSelection();
  coverageDots?.resetView();
  const panel = byId("coverage-detail-panel");
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

byId("home-enter").addEventListener("click", () => enterAtlasExperience());

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

window.addEventListener("pageshow", () => void refreshCoverageCatalog());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshCoverageCatalog();
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
    const doubleEscape = now - lastEscapeAt < 500;
    lastEscapeAt = now;
    closeCoverageContextMenu();
    setOverlapMode(false);
    overlapController?.abort();
    overlapController = null;
    activeOverlapSurveyIds = [];
    activeOverlapComponents = [];
    overlapEvidenceCache.clear();
    overlapDetailsCache.clear();
    coverageDots?.setOverlapMode(false);
    coverageDots?.setActiveOverlapComponent(null);
    updateOverlapHud(null);
    const panel = byId("coverage-detail-panel");
    panel.hidden = true;
    panel.classList.remove("is-overlap-panel");
    panel.style.removeProperty("left");
    panel.style.removeProperty("top");
    panel.style.removeProperty("right");
    panel.style.removeProperty("width");
    setOverlapExpandVisible(false);
    setCoverageLayersOpen(true);
    coverageDots?.clearSelection();
    updateCoverageInspector(null);
    if (doubleEscape) resetCoverageExperience();
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

renderIcons();
void initialize().catch((error) => {
  console.error(error);
  byId("coverage-state").textContent = t("coverage.releaseUnavailable");
  if (!surveyIndex) byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: t("coverage.catalogLoadFailed") }));
  coverageInitializationComplete = true;
});
