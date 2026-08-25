import { BadgeCheck, BookOpen, Box, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Home, Image, Layers3, ListChecks, ListFilter, RotateCcw, Search, ShieldCheck, Telescope, X, createIcons } from "lucide";
import { Healpix } from "healpixjs";
import { AtlasCoverageGlobe, type CoverageCatalog } from "./atlas-coverage-globe.js";
import type { SurveyLayerContextMenu, SurveyLayerInspection, SurveyLayerOverlapComponent, SurveyLayerState } from "./atlas/survey-layer-viewer.js";
import { locale, mountLocaleControls, t } from "./i18n.js";

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
const selectedModalities = new Set<Modality>();
let modalityFilterInitialized = false;
let coverageDots: AtlasCoverageGlobe | null = null;
let activeSurveyId: string | null = null;
let coverageCatalog: CoverageCatalog | null = null;
const coverageBlockCache = new Map<string, number[]>();
const coverageRequests = new Map<string, AbortController>();
const COVERAGE_CACHE_LIMIT = 128;
let pendingCoverageState: SurveyLayerState | null = null;
let coverageStateFrame = 0;
let overlapMode = false;
let overlapRequestSequence = 0;
let overlapEvidenceSequence = 0;
let overlapController: AbortController | null = null;
let overlapEvidenceController: AbortController | null = null;
let activeOverlapSurveyIds: string[] = [];
let activeOverlapComponents: OverlapComponentView[] = [];
const queuedLayerIds = new Set<string>();
let selectedQueueComponent: OverlapComponentView | null = null;
let renderedQueueComponentId: string | null = null;
let layerCloseTimer: number | null = null;
let layerCloseDeadline = 0;
let layerCloseRemaining = 0;
let layerClosePaused = false;
const overlapEvidenceCache = new Map<string, OverlapEvidenceResult>();
let lastEscapeAt = -Infinity;
let homeEntered = false;
let coverageSelectionInitialized = false;

mountLocaleControls();

function isAtlasInteractive(): boolean {
  return document.body.dataset.homeState === "atlas";
}

async function fetchCoverageBlock(layer: CoverageCatalog["layers"][number], order: number, tile: number): Promise<number[]> {
  const key = `${layer.layerId}:${order}:${tile}`;
  const cached = coverageBlockCache.get(key);
  if (cached) return cached;
  const controller = new AbortController();
  coverageRequests.get(key)?.abort();
  coverageRequests.set(key, controller);
  try {
    const response = await fetch(`/api/v1/coverage/blocks/${encodeURIComponent(layer.layerId)}?order=${order}&tile=${tile}`, { signal: controller.signal });
    if (!response.ok) return [];
    const block = await response.json() as { cells?: number[] };
    const cells = Array.isArray(block.cells) ? [...new Set(block.cells)].sort((a, b) => a - b) : [];
    coverageBlockCache.set(key, cells);
    while (coverageBlockCache.size > COVERAGE_CACHE_LIMIT) coverageBlockCache.delete(coverageBlockCache.keys().next().value!);
    return cells;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return [];
    throw error;
  } finally {
    if (coverageRequests.get(key) === controller) coverageRequests.delete(key);
  }
}

async function fetchCoverageOverview(layer: CoverageCatalog["layers"][number]): Promise<number[]> {
  return fetchCoverageBlock(layer, layer.overviewOrder, 0);
}

async function fetchCoverageLayerOrder(layer: CoverageCatalog["layers"][number], order: number): Promise<number[]> {
  const tiles = layer.tileIdsByOrder?.[String(order)] ?? [0];
  const blocks = await Promise.all(tiles.map((tile) => fetchCoverageBlock(layer, order, tile)));
  return [...new Set(blocks.flat())].sort((a, b) => a - b);
}

function updateCoverageReadout(surveyId: string | null, product?: string): void {
  activeSurveyId = surveyId;
  const scene = byId("coverage-scene");
  const title = byId("coverage-selection-title");
  const meta = byId("coverage-selection-meta");
  const state = byId("coverage-state");
  const survey = surveyId ? surveyIndex?.surveys.find((entry) => entry.id === surveyId) : undefined;
  if (!survey) {
    scene.style.removeProperty("--coverage-color");
    title.textContent = t("coverage.allSurveys");
    meta.textContent = "NESTED HEALPIX · NSIDE 16";
    state.textContent = coverageDots ? t("coverage.publicCells") : t("coverage.previewUnavailable");
    return;
  }
  scene.style.setProperty("--coverage-color", survey.color);
  title.textContent = product ? `${survey.name.toUpperCase()} · ${product.toUpperCase()}` : survey.name.toUpperCase();
  meta.textContent = `${survey.mission} · ${survey.statistics.footprintCells.toLocaleString("en-US")} HEALPIX CELLS`;
  state.textContent = `${survey.statistics.acquired}/${survey.statistics.publicProducts} PRODUCTS · SELECTED`;
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

function commonOverviewOrder(surveyIds: string[] = visibleSurveyIdsFromControls()): number {
  const layers = coverageCatalog?.layers.filter((layer) => surveyIds.includes(layer.surveyId)) ?? [];
  const bySurvey = new Map<string, Set<number>>();
  layers.forEach((layer) => { const orders = bySurvey.get(layer.surveyId) ?? new Set<number>(); layer.availableOrders.forEach((order) => orders.add(order)); bySurvey.set(layer.surveyId, orders); });
  const common = [...bySurvey.values()].reduce<number[]>((orders, available, index) => index === 0 ? [...available] : orders.filter((order) => available.has(order)), []);
  return common.length ? Math.max(...common) : 4;
}

function surveyCellsAtOrder(surveyId: string, order: number): Set<number> {
  const cells = new Set<number>();
  for (const layer of coverageCatalog?.layers.filter((candidate) => candidate.surveyId === surveyId && candidate.availableOrders.includes(order)) ?? []) {
    const tiles = layer.tileIdsByOrder?.[String(order)] ?? [0];
    tiles.forEach((tile) => (coverageBlockCache.get(`${layer.layerId}:${order}:${tile}`) ?? []).forEach((pixel) => cells.add(pixel)));
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
interface OverlapEvidenceResult { available: boolean; precision: string; truncated: boolean; edges: Array<{ layerId?: string; releaseId?: string; sourceFileId?: string; fileName?: string; sourceUri?: string; downloadUrl?: string; ipix: number; precision: string }>; sourceFiles: Array<Record<string, unknown>>; notes?: string[] }
interface OverlapComponentView { id: string; order: number; cells: number[]; bounds: { areaDeg2: number; raMin: number; raMax: number; raWraps?: boolean; decMin: number; decMax: number }; evidenceLookup?: OverlapEvidenceLookup; surveys?: Array<{ surveyId: string; releaseId: string; product: string; modality?: string; sourceUnitIndex?: { status: string; unitKind?: string; notes: string }; sourceUnits?: { status: string; unitKind: string; units: Array<{ unitId: string; exposureCount: number; lastNight: number; downloadUrl: string }>; totalUnits: number; truncated: boolean; notes: string } | null; downloadUrl?: string }> }

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
  panel.style.width = window.innerWidth <= 820 ? "min(300px, calc(100vw - 28px))" : "300px";
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
  summary.textContent = `${layers.length} products · ${orders.length ? `O${orders.join("/O")}` : "HEALPIX --"}${modalities.length ? ` · ${modalities.join(" · ")}` : ""}`;
  body.append(kicker, title, summary);
  const list = document.createElement("div");
  list.className = "coverage-layer-detail-list";
  layers.forEach((layer) => {
    const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
    const product = release?.products.find((entry) => entry.name === layer.product);
    const row = document.createElement("div");
    row.className = "coverage-layer-detail-row";
    row.textContent = `${layer.product || product?.name || "Coverage"} · ${layer.releaseId || release?.label || "--"} · ${layer.availableOrders.length ? `O${layer.availableOrders.join("/O")}` : "HEALPIX --"}`;
    list.append(row);
  });
  body.append(list);
  if (persistent) panel.append(body);
  return panel;
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
    return;
  }
  const layers = byId("coverage-layers");
  const top = layers.hidden ? 132 : Math.min(window.innerHeight - 180, layers.getBoundingClientRect().bottom + 16);
  queue.style.top = `${Math.max(132, top)}px`;
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
    byId("coverage-layers").hidden = true;
    positionSelectionQueue();
    updateCoverageEmptyGuide();
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
  positionOverlapPanel();
}

function renderOverlapPanel(surveyIds: string[], pixels: number[], order: number, scope = "GLOBAL", componentData?: OverlapComponentView[]): void {
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  panel.classList.add("is-overlap-panel");
  panel.hidden = false;
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

async function fetchOverlapEvidence(component: OverlapComponentView, signal?: AbortSignal): Promise<OverlapEvidenceResult | null> {
  const lookup = component.evidenceLookup;
  if (!lookup) return null;
  const cached = overlapEvidenceCache.get(component.id);
  if (cached) return cached;
  const response = await fetch(lookup.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal,
    body: JSON.stringify({ layerIds: lookup.layerIds, order: lookup.order, cells: component.cells, limit: 250 }),
  });
  if (!response.ok) throw new Error(`reverse lookup HTTP ${response.status}`);
  const result = await response.json() as OverlapEvidenceResult;
  overlapEvidenceCache.set(component.id, result);
  return result;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function overlapCsvRows(component: OverlapComponentView, result: OverlapEvidenceResult | null): string[][] {
  const files = new Map<string, Record<string, unknown>>();
  result?.sourceFiles.forEach((source) => {
    const id = sourceValue(source, ["fileId", "file_id", "sourceFileId", "source_file_id", "_id"]) ?? String(files.size);
    files.set(id, source);
  });
  const edges = result?.edges ?? [];
  if (!edges.length) return [[component.id, String(component.order), String(2 ** component.order), "", result?.precision ?? "entrypoint-only", "", "", "", "", "", "", "", "", String(component.bounds.raMin), String(component.bounds.raMax), String(component.bounds.decMin), String(component.bounds.decMax), String(component.bounds.areaDeg2)]];
  return edges.map((edge) => {
    const sourceId = edge.sourceFileId ?? "";
    const source = files.get(sourceId) ?? {};
    return [
      component.id,
      String(component.order),
      String(2 ** component.order),
      String(edge.ipix ?? ""),
      edge.precision ?? result?.precision ?? "",
      edge.layerId ?? sourceValue(source, ["layerId", "layer_id"]) ?? "",
      sourceValue(source, ["surveyId", "survey_id"]) ?? "",
      sourceValue(source, ["releaseId", "release_id"]) ?? "",
      sourceValue(source, ["product", "productName", "product_name"]) ?? "",
      sourceId,
      edge.fileName ?? sourceValue(source, ["name", "fileName", "file_name"]) ?? "",
      edge.sourceUri ?? sourceValue(source, ["sourceUri", "source_uri", "uri", "urn"]) ?? "",
      edge.downloadUrl ?? sourceValue(source, ["downloadUrl", "download_url"]) ?? "",
      String(component.bounds.raMin),
      String(component.bounds.raMax),
      String(component.bounds.decMin),
      String(component.bounds.decMax),
      String(component.bounds.areaDeg2),
    ];
  });
}

async function downloadOverlapCsv(components: OverlapComponentView[], filename: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent ?? "Download CSV";
  button.disabled = true;
  button.textContent = t("coverage.downloadLoading");
  try {
    const results = await Promise.all(components.map((component) => fetchOverlapEvidence(component)));
    const header = ["component_id", "order", "nside", "ipix", "precision", "layer_id", "survey_id", "release_id", "product", "source_file_id", "file_name", "source_uri", "download_url", "ra_min_deg", "ra_max_deg", "dec_min_deg", "dec_max_deg", "area_deg2"];
    const rows = components.flatMap((component, index) => overlapCsvRows(component, results[index]));
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
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

function renderEvidencePlan(node: HTMLElement, result: OverlapEvidenceResult): void {
  node.replaceChildren();
  if (!result.available) {
    node.append(Object.assign(document.createElement("small"), { textContent: t("coverage.evidenceUnavailable") }));
    return;
  }
  const files = new Map<string, Record<string, unknown>>();
  result.sourceFiles.forEach((source) => {
    const id = sourceValue(source, ["fileId", "file_id", "sourceFileId", "source_file_id", "_id"]) ?? String(files.size);
    files.set(id, source);
  });
  const heading = document.createElement("strong");
  heading.textContent = `DOWNLOAD PLAN · ${files.size} files · ${result.edges.length} coverage edges${result.truncated ? " · truncated" : ""}`;
  node.append(heading);
  if (!files.size) {
    node.append(Object.assign(document.createElement("small"), { textContent: t("coverage.noSourceFiles") }));
    return;
  }
  const list = document.createElement("div");
  list.className = "overlap-evidence-files";
  files.forEach((source) => {
    const row = document.createElement("div");
    row.className = "overlap-evidence-file";
    const name = sourceValue(source, ["name", "fileName", "file_name", "uri", "source_uri", "urn"]) ?? "source file";
    const title = document.createElement("strong");
    title.textContent = name;
    row.append(title);
    const wcs = source.wcs_summary;
    if (wcs && typeof wcs === "object") {
      const summary = wcs as Record<string, unknown>;
      const raMin = Number(summary.ra_min_deg);
      const raMax = Number(summary.ra_max_deg);
      const decMin = Number(summary.dec_min_deg);
      const decMax = Number(summary.dec_max_deg);
      if ([raMin, raMax, decMin, decMax].every(Number.isFinite)) row.append(Object.assign(document.createElement("small"), { textContent: `RA ${raMin.toFixed(3)}°–${raMax.toFixed(3)}° · DEC ${decMin.toFixed(3)}°–${decMax.toFixed(3)}°` }));
    }
    const uri = sourceValue(source, ["downloadUrl", "download_url", "sourceUrl", "source_url", "uri", "source_uri", "urn"]);
    if (uri) {
      if (/^https?:\/\//i.test(uri)) {
        const link = document.createElement("a");
        link.href = uri;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = t("coverage.downloadOfficial");
        row.append(link);
      } else row.append(Object.assign(document.createElement("code"), { textContent: uri }));
    }
    list.append(row);
  });
  node.append(list);
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
  const entries = component.surveys ?? surveyIds.flatMap((surveyId) => {
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
          link.href = unit.downloadUrl;
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
    if (entry.downloadUrl) { const link = document.createElement("a"); link.href = entry.downloadUrl; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = t("coverage.releaseEntry"); row.append(link); }
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
  if (activeOverlapComponents.length > 1) {
    const allDownload = document.createElement("button");
    allDownload.type = "button";
    allDownload.className = "command-button overlap-download-button";
    allDownload.append(icon("download"), document.createTextNode(t("coverage.downloadAll")));
    allDownload.addEventListener("click", () => void downloadOverlapCsv(activeOverlapComponents, "atlas-overlap-all-download-plan.csv", allDownload));
    downloads.append(allDownload);
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

async function activateOverlap(forceActive?: boolean): Promise<void> {
  if (!isAtlasInteractive()) return;
  const surveyIds = visibleSurveyIdsFromControls();
  const activate = forceActive ?? !overlapMode;
  if (activate && surveyIds.length < 2) {
    toast(t("coverage.needTwoSurveys"));
    return;
  }
  const order = commonOverviewOrder(surveyIds);
  const requestSequence = ++overlapRequestSequence;
  overlapMode = activate;
  if (!activate) {
    overlapController?.abort();
    overlapController = null;
    overlapEvidenceController?.abort();
    overlapEvidenceSequence += 1;
    activeOverlapSurveyIds = [];
    activeOverlapComponents = [];
    overlapEvidenceCache.clear();
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
    return;
  }
  coverageDots?.setOverlapMode(true);
  activeOverlapComponents = [];
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
    name.textContent = survey?.name ?? surveyId.toUpperCase();
    name.className = "coverage-layer-name";
    const swatch = document.createElement("span");
    swatch.className = "coverage-layer-swatch";
    swatch.style.backgroundColor = layers[0]?.color ?? survey?.color ?? "#42d5c4";
    swatch.setAttribute("aria-label", `图层颜色 ${swatch.style.backgroundColor}`);
    const detail = createCoverageLayerDetail(surveyId);
    label.addEventListener("pointerenter", () => {
      const bounds = label.getBoundingClientRect();
      const detailWidth = Math.min(292, Math.max(220, window.innerWidth - 390));
      detail.style.top = `${Math.max(12, Math.min(bounds.top, window.innerHeight - 210))}px`;
      detail.style.left = `${Math.min(bounds.right + 12, window.innerWidth - detailWidth - 12)}px`;
      detail.style.display = "grid";
    });
    label.addEventListener("pointerleave", () => {
      detail.style.removeProperty("top");
      detail.style.removeProperty("left");
      detail.style.removeProperty("display");
    });
    const handle = document.createElement("span");
    handle.className = "coverage-layer-handle";
    handle.innerHTML = `<i data-lucide="grip-horizontal"></i>`;
    handle.setAttribute("role", "img");
    handle.setAttribute("aria-label", "拖动把手");
    handle.title = "拖动排序";
    input.addEventListener("change", () => {
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
    label.append(input, swatch, handle, name, detail);
    host.append(label);
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

async function copy(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  toast("SHA-256 已复制");
}

function renderIcons(): void {
    createIcons({
    icons: { BadgeCheck, BookOpen, Box, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Home, Image, Layers3, ListChecks, ListFilter, RotateCcw, Search, ShieldCheck, Telescope, X },
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

async function initialize(): Promise<void> {
  try {
    coverageDots = new AtlasCoverageGlobe(byId("coverage-scene"), byId<HTMLCanvasElement>("coverage-canvas"), updateCoverageReadout, updateCoverageInspector, updateCoverageState, openCoverageContextMenu, handleOverlapComponentLabel);
  } catch (error) {
    console.warn("HEALPix globe unavailable", error);
    byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
  }
  const assetsPromise = fetch("/api/v1/assets", { headers: { Accept: "application/json" } });
  const [surveysResponse, coverageCatalogResponse] = await Promise.all([
    fetch("/api/v1/surveys", { headers: { Accept: "application/json" } }),
    fetch("/api/v1/coverage/catalog", { headers: { Accept: "application/json" } }),
  ]);
  if (!surveysResponse.ok) throw new Error("Public survey catalog request failed");
  surveyIndex = await surveysResponse.json() as SurveyIndex;
  initializeModalityFilter();
  renderSurveys();
  if (coverageCatalogResponse.ok && coverageDots) {
    coverageCatalog = await coverageCatalogResponse.json() as CoverageCatalog;
    const blocks = new Map<string, number[]>();
    await Promise.all(coverageCatalog.layers.map(async (layer) => {
      const cells = await fetchCoverageOverview(layer);
      if (cells.length) blocks.set(`${layer.layerId}:${layer.overviewOrder}`, cells);
    }));
    coverageDots.loadCatalog(coverageCatalog, blocks, surveyIndex.surveys);
    if (coverageSelectionInitialized) coverageDots.setVisibleSurveys(queuedLayerIds);
    else coverageDots.setVisibleSurveys(new Set(coverageCatalog.layers.map((layer) => layer.surveyId)));
    if (homeEntered) coverageDots.transitionToDataView(1);
    renderCoverageLayers();
    updateCoverageReadout(null);
  } else if (coverageDots) {
    byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
  } else {
    byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
  }
  const assetsResponse = await assetsPromise;
  if (!assetsResponse.ok) throw new Error("Public asset catalog request failed");
  manifest = await assetsResponse.json() as ReleaseManifest;
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
function resetCoverageExperience(): void {
  closeCoverageContextMenu();
  applyCoverageSelection([]);
  clearLayerCloseTimer();
  overlapMode = false;
  overlapController?.abort();
  overlapController = null;
  activeOverlapSurveyIds = [];
  activeOverlapComponents = [];
  overlapEvidenceCache.clear();
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
  updateCoverageInspector(null);
}

byId("coverage-reset").addEventListener("click", () => {
  if (isAtlasInteractive()) resetCoverageExperience();
});
byId("coverage-layers-toggle").addEventListener("click", () => {
  if (!isAtlasInteractive()) return;
  const layers = byId("coverage-layers");
  layers.hidden = !layers.hidden;
  positionSelectionQueue();
  positionOverlapPanel();
  updateCoverageEmptyGuide();
});
byId("coverage-empty-guide-action").addEventListener("click", () => {
  byId("coverage-layers-toggle").click();
});
byId("coverage-help-toggle").addEventListener("click", () => {
  if (!isAtlasInteractive()) return;
  byId("coverage-help").hidden = !byId("coverage-help").hidden;
});
byId("coverage-help-close").addEventListener("click", () => { byId("coverage-help").hidden = true; });

function enterAtlasExperience(surveyId?: string): void {
  if (homeEntered) return;
  if (surveyId) applyCoverageSelection([surveyId]);
  else applyCoverageSelection([]);
  homeEntered = true;
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
    byId("coverage-layers-toggle").focus();
  };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }
  window.setTimeout(finish, 680);
}

byId("home-enter").addEventListener("click", () => enterAtlasExperience());

window.addEventListener("resize", () => {
  positionSelectionQueue();
  positionOverlapPanel();
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target && (target.matches("input, textarea, select") || target.isContentEditable)) return;
  if (!isAtlasInteractive()) return;
  if (event.key === "Escape") {
    const now = performance.now();
    const doubleEscape = now - lastEscapeAt < 500;
    lastEscapeAt = now;
    closeCoverageContextMenu();
    overlapMode = false;
    overlapController?.abort();
    overlapController = null;
    activeOverlapSurveyIds = [];
    activeOverlapComponents = [];
    overlapEvidenceCache.clear();
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
    if (component) renderOverlapPanel(activeOverlapSurveyIds, [...new Set(activeOverlapComponents.flatMap((entry) => entry.cells))], component.order, "GLOBAL", activeOverlapComponents);
  }
  if (surveyIndex) renderSurveyFilterOptions();
  renderSelectionQueue();
  updateCoverageEmptyGuide();
});

renderIcons();
void initialize().catch((error) => {
  console.error(error);
  byId("coverage-state").textContent = t("coverage.releaseUnavailable");
  byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: t("coverage.catalogLoadFailed") }));
});
