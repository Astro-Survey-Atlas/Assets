import { BadgeCheck, BookOpen, Box, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Image, Layers3, ListChecks, RotateCcw, Search, ShieldCheck, Telescope, X, createIcons } from "lucide";
import { Healpix } from "healpixjs";
import { AtlasCoverageGlobe, type CoverageCatalog } from "./atlas-coverage-globe.js";
import type { SurveyLayerContextMenu, SurveyLayerInspection, SurveyLayerState } from "./atlas/survey-layer-viewer.js";

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

const statusLabels: Record<ProductStatus, string> = {
  acquired: "已收录",
  overview_only: "仅概览",
  awaiting_geometry: "待计算",
  not_applicable: "不适用",
};

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
let lastEscapeAt = -Infinity;

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
    title.textContent = "ALL PUBLIC SURVEYS";
    meta.textContent = "NESTED HEALPIX · NSIDE 16";
    state.textContent = coverageDots ? "PUBLIC HEALPIX CELL COVERAGE" : "COVERAGE PREVIEW UNAVAILABLE";
    document.querySelectorAll<HTMLElement>(".survey-row").forEach((row) => { row.dataset.selected = "false"; });
    return;
  }
  scene.style.setProperty("--coverage-color", survey.color);
  title.textContent = product ? `${survey.name.toUpperCase()} · ${product.toUpperCase()}` : survey.name.toUpperCase();
  meta.textContent = `${survey.mission} · ${survey.statistics.footprintCells.toLocaleString("en-US")} HEALPIX CELLS`;
  state.textContent = `${survey.statistics.acquired}/${survey.statistics.publicProducts} PRODUCTS · SELECTED`;
  document.querySelectorAll<HTMLElement>(".survey-row").forEach((row) => { row.dataset.selected = row.dataset.surveyId === survey.id ? "true" : "false"; });
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
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = "CELL INSPECTOR";
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

interface OverlapComponentView { id: string; order: number; cells: number[]; bounds: { areaDeg2: number; raMin: number; raMax: number; raWraps?: boolean; decMin: number; decMax: number }; surveys?: Array<{ surveyId: string; releaseId: string; product: string; modality?: string; sourceUnitIndex?: { status: string; notes: string }; sourceUnits?: { status: string; unitKind: string; units: Array<{ unitId: string; exposureCount: number; lastNight: number; downloadUrl: string }>; totalUnits: number; truncated: boolean; notes: string } | null; downloadUrl?: string }> }

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

function renderOverlapPanel(surveyIds: string[], pixels: number[], order: number, scope = "GLOBAL", componentData?: OverlapComponentView[]): void {
  const panel = byId("coverage-detail-panel");
  const content = byId("coverage-detail-content");
  panel.hidden = false;
  byId("coverage-detail-kicker").textContent = "OVERLAP RESULT";
  byId("coverage-detail-title").textContent = `${scope} · ${surveyIds.length} SURVEYS`;
  content.replaceChildren();
  const summary = document.createElement("p");
  summary.className = "overlap-summary";
  summary.textContent = pixels.length ? `COMMON ORDER O${order} · NSIDE ${2 ** order} · ${pixels.length.toLocaleString("en-US")} cells` : `COMMON ORDER O${order} · 没有公共覆盖像元`;
  content.append(summary);
  if (!pixels.length) return;
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
      componentNav.querySelectorAll("button").forEach((entry) => entry.classList.remove("is-active"));
      button.classList.add("is-active");
      renderOverlapComponent(component, surveyIds, content);
      coverageDots?.focusPixels(component.order, component.cells);
    });
    componentNav.append(button);
  });
  content.append(componentNav);
  renderOverlapComponent(components[0]!, surveyIds, content);
}

function renderOverlapComponent(component: OverlapComponentView, surveyIds: string[], content: HTMLElement): void {
  content.querySelectorAll(".overlap-component-detail, .overlap-products").forEach((node) => node.remove());
  const detail = document.createElement("div");
  detail.className = "overlap-component-detail";
  const bounds = component.bounds;
  detail.textContent = `${component.id} · ${component.cells.length.toLocaleString("en-US")} cells · ${bounds.areaDeg2.toFixed(2)} deg² · RA ${bounds.raMin.toFixed(2)}°${bounds.raWraps ? "↷" : "–"}${bounds.raMax.toFixed(2)}° · DEC ${bounds.decMin.toFixed(2)}°–${bounds.decMax.toFixed(2)}°`;
  content.append(detail);
  const list = document.createElement("div");
  list.className = "overlap-products";
  const entries = component.surveys ?? surveyIds.flatMap((surveyId) => {
    const survey = surveyIndex?.surveys.find((entry) => entry.id === surveyId);
    return survey?.releases.flatMap((release) => release.products.filter((product) => product.coverage).map((product) => ({ surveyId, releaseId: release.id, product: product.name, modality: product.modality, downloadUrl: product.sourceUrl }))) ?? [];
  });
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "coverage-detail-product";
    row.textContent = `${surveyIndex?.surveys.find((survey) => survey.id === entry.surveyId)?.name ?? entry.surveyId} · ${entry.releaseId} · ${entry.product} · ${entry.modality ?? "--"}`;
    if (entry.sourceUnitIndex) row.append(Object.assign(document.createElement("small"), { textContent: `${entry.sourceUnitIndex.status.toUpperCase()}: ${entry.sourceUnitIndex.notes}` }));
    if (entry.sourceUnits) {
      row.append(Object.assign(document.createElement("small"), { textContent: `${entry.sourceUnits.totalUnits} ${entry.sourceUnits.unitKind}${entry.sourceUnits.totalUnits === 1 ? "" : "s"} matched${entry.sourceUnits.truncated ? " · first results shown" : ""}` }));
      const links = document.createElement("div"); links.className = "overlap-unit-links";
      entry.sourceUnits.units.slice(0, 18).forEach((unit) => { const link = document.createElement("a"); link.href = unit.downloadUrl; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = `TILE ${unit.unitId}`; link.title = `NEXP ${unit.exposureCount} · LASTNIGHT ${unit.lastNight}`; links.append(link); });
      row.append(links);
    }
    if (entry.downloadUrl) { const link = document.createElement("a"); link.href = entry.downloadUrl; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "官方 Release 入口"; row.append(link); }
    list.append(row);
  });
  if (!entries.length) list.append(Object.assign(document.createElement("p"), { className: "overlap-empty", textContent: "当前重合区域没有已发布产品。" }));
  content.append(list);
}

async function activateOverlap(forceActive?: boolean): Promise<void> {
  const surveyIds = visibleSurveyIdsFromControls();
  const order = commonOverviewOrder(surveyIds);
  if (surveyIds.length < 2) {
    toast("至少勾选两个巡天才能计算重合");
    return;
  }
  const activate = forceActive ?? !overlapMode;
  const requestSequence = ++overlapRequestSequence;
  overlapMode = activate;
  if (!activate) {
    coverageDots?.setOverlapMode(false);
    byId("coverage-detail-panel").hidden = true;
    return;
  }
  coverageDots?.setOverlapMode(true);
  const layers = coverageCatalog?.layers.filter((layer) => surveyIds.includes(layer.surveyId) && layer.availableOrders.includes(order)) ?? [];
  await Promise.all(layers.map((layer) => fetchCoverageLayerOrder(layer, order)));
  const pixels = overlapPixelsForSurveys(surveyIds, order);
  if (!overlapMode || requestSequence !== overlapRequestSequence) return;
  const localComponents = overlapComponents(pixels, order);
  coverageDots?.setOverlapCells(order, pixels);
  renderOverlapPanel(surveyIds, pixels, order, "GLOBAL", localComponents);
  if (localComponents[0]) coverageDots?.focusPixels(localComponents[0].order, localComponents[0].cells);
  let renderedPixels = pixels;
  let renderedOrder = order;
  try {
    const response = await fetch("/api/v1/coverage/overlap", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ surveyIds, requestedOrder: order }) });
    if (!overlapMode || requestSequence !== overlapRequestSequence) return;
    if (response.ok) {
      const result = await response.json() as { components?: OverlapComponentView[]; commonOrder?: number; pixels?: number[] };
      renderedPixels = result.pixels ?? pixels;
      renderedOrder = result.commonOrder ?? order;
      coverageDots?.setOverlapCells(renderedOrder, renderedPixels);
      renderOverlapPanel(surveyIds, renderedPixels, renderedOrder, "GLOBAL", result.components);
      const firstComponent = result.components?.[0];
      if (firstComponent) coverageDots?.focusPixels(firstComponent.order, firstComponent.cells);
    }
  } catch {
    // The local overlap remains usable when download-plan enrichment fails.
  }
  byId("coverage-state").textContent = renderedPixels.length ? `OVERLAP O${renderedOrder} · ${renderedPixels.length.toLocaleString("en-US")} CELLS` : `NO COMMON COVERAGE · O${renderedOrder}`;
}

function closeCoverageContextMenu(): void {
  const menu = byId("coverage-context-menu");
  menu.hidden = true;
  menu.replaceChildren();
}

function openCoverageContextMenu(menuState: SurveyLayerContextMenu): void {
  const menu = byId("coverage-context-menu");
  menu.replaceChildren();
  const addAction = (label: string, action: () => void): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => { action(); closeCoverageContextMenu(); });
    menu.append(button);
  };
  addAction("查看当前区块覆盖与下载", () => {
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
  const search = document.createElement("label");
  search.className = "coverage-layer-search";
  search.innerHTML = `<i data-lucide="search"></i><input id="coverage-layer-search" type="search" autocomplete="off" placeholder="筛选巡天图层" aria-label="筛选巡天图层" />`;
  host.append(search);
  const filterInput = search.querySelector<HTMLInputElement>("input");
  const grouped = new Map<string, CoverageCatalog["layers"]>();
  for (const layer of coverageCatalog.layers) grouped.set(layer.surveyId, [...(grouped.get(layer.surveyId) ?? []), layer]);
  for (const [surveyId, layers] of grouped) {
    const label = document.createElement("label");
    label.className = "coverage-layer-toggle";
    label.setAttribute("title", "拖动三横线把手以调整图层顺序");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
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
    const modalities = [...new Set(layers.flatMap((layer) => {
      const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
      const product = release?.products.find((entry) => entry.name === layer.product);
      return product?.modality ? [modalityLabels[product.modality as Modality] ?? product.modality] : [];
    }))];
    const modality = document.createElement("small");
    modality.className = "coverage-layer-modality";
    modality.textContent = modalities.length ? modalities.join(" · ") : "MODALITY --";
    modality.title = modalities.length ? `模态：${modalities.join("、")}` : "未提供模态信息";
    const count = document.createElement("small");
    count.className = "coverage-layer-count";
    const orders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((a, b) => a - b);
    count.textContent = `${layers.length} products · O${orders.join("/O") || "--"}`;
    const handle = document.createElement("span");
    handle.className = "coverage-layer-handle";
    handle.innerHTML = `<i data-lucide="grip-horizontal"></i>`;
    handle.setAttribute("role", "img");
    handle.setAttribute("aria-label", "拖动把手");
    handle.title = "拖动排序";
    input.addEventListener("change", () => {
      const enabled = new Set([...host.querySelectorAll<HTMLInputElement>("input:checked")].map((entry) => entry.dataset.surveyId).filter(Boolean) as string[]);
      coverageDots?.setVisibleSurveys(enabled);
      if (overlapMode) {
        void activateOverlap(true);
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
    label.append(input, swatch, handle, name, modality, count);
    host.append(label);
  }
  filterInput?.addEventListener("input", () => {
    const query = filterInput.value.trim().toLocaleLowerCase();
    host.querySelectorAll<HTMLElement>(".coverage-layer-toggle").forEach((row) => { row.hidden = Boolean(query) && !row.dataset.searchText?.includes(query); });
  });
  renderIcons();
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
    icons: { BadgeCheck, BookOpen, Box, CircleHelp, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, GitBranch, GripHorizontal, Image, Layers3, ListChecks, RotateCcw, Search, ShieldCheck, Telescope, X },
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

function filteredSurveys(): SurveyRecord[] {
  const surveys = surveyIndex?.surveys ?? [];
  if (!search) return surveys;
  return surveys.filter((survey) => [
    survey.name,
    survey.mission,
    survey.description,
    ...survey.modalities.map((modality) => modalityLabels[modality]),
    ...survey.releases.flatMap((release) => [release.label, ...release.products.flatMap((product) => [product.name, product.description, product.reason, product.manualStep])]),
  ].filter(Boolean).join(" ").toLocaleLowerCase().includes(search));
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
      const pill = document.createElement("span"); pill.className = "status-pill"; pill.dataset.status = product.status; pill.textContent = statusLabels[product.status];
      const note = document.createElement("p"); note.textContent = statusDescription(product);
      status.append(pill, note);
      const actions = document.createElement("div"); actions.className = "product-actions";
      const modality = document.createElement("span"); modality.className = "modality-tag"; modality.textContent = modalityLabels[product.modality];
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
    row.dataset.selected = activeSurveyId === survey.id ? "true" : "false";
    row.tabIndex = 0;
    row.style.setProperty("--survey-color", survey.color);
    row.setAttribute("aria-label", `${survey.name}，${survey.mission}，${survey.statistics.acquired} 个已收录产品`);

    const focusSurvey = (): void => coverageDots?.setHighlightedSurvey(survey.id);
    const clearSurvey = (): void => { /* Keep the last active survey after leaving a record. */ };
    row.addEventListener("pointerenter", focusSurvey);
    row.addEventListener("pointerleave", clearSurvey);
    row.addEventListener("focus", focusSurvey);
    row.addEventListener("focusin", focusSurvey);
    row.addEventListener("focusout", (event) => {
      if (!row.contains(event.relatedTarget as Node | null)) clearSurvey();
    });
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button, a")) return;
      coverageDots?.setSelectedSurvey(survey.id);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        coverageDots?.setSelectedSurvey(survey.id);
      }
    });

    const marker = document.createElement("span"); marker.className = "survey-marker"; marker.setAttribute("aria-hidden", "true");
    const visual = document.createElement("div"); visual.className = "survey-thumb";
    const image = document.createElement("img"); image.src = survey.imageUrl; image.alt = ""; image.loading = "lazy";
    visual.append(image);

    const identity = document.createElement("div"); identity.className = "survey-identity";
    const overline = document.createElement("span"); overline.className = "survey-overline"; overline.textContent = survey.mission;
    const heading = document.createElement("h3"); heading.textContent = survey.name;
    const description = document.createElement("p"); description.textContent = survey.description;
    const tags = document.createElement("div"); tags.className = "modality-tags";
    survey.modalities.forEach((modality) => { const tag = document.createElement("span"); tag.className = "modality-tag"; tag.textContent = modalityLabels[modality]; tags.append(tag); });
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
    coverageDots = new AtlasCoverageGlobe(byId("coverage-scene"), byId<HTMLCanvasElement>("coverage-canvas"), updateCoverageReadout, updateCoverageInspector, updateCoverageState, openCoverageContextMenu);
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
  if (coverageCatalogResponse.ok && coverageDots) {
    coverageCatalog = await coverageCatalogResponse.json() as CoverageCatalog;
    const blocks = new Map<string, number[]>();
    await Promise.all(coverageCatalog.layers.map(async (layer) => {
      const cells = await fetchCoverageOverview(layer);
      if (cells.length) blocks.set(`${layer.layerId}:${layer.overviewOrder}`, cells);
    }));
    coverageDots.loadCatalog(coverageCatalog, blocks, surveyIndex.surveys);
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
  byId("bundle-hash").textContent = manifest.bundle.sha256;
  byId("generated-at").textContent = new Date(manifest.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" }) + " UTC";
  const provenance = manifest.files.find((record) => record.kind === "provenance");
  if (provenance) byId<HTMLAnchorElement>("provenance-download").href = provenance.downloadUrl;
}

byId<HTMLInputElement>("survey-search").addEventListener("input", (event) => {
  search = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
  renderSurveys();
});
byId("copy-bundle-hash").addEventListener("click", () => { if (manifest) void copy(manifest.bundle.sha256); });
byId("dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("survey-dialog").close());
byId<HTMLDialogElement>("survey-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) byId<HTMLDialogElement>("survey-dialog").close(); });
byId("preview-close").addEventListener("click", () => byId<HTMLDialogElement>("preview-dialog").close());
byId<HTMLDialogElement>("preview-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) byId<HTMLDialogElement>("preview-dialog").close(); });
function resetCoverageExperience(): void {
  closeCoverageContextMenu();
  overlapMode = false;
  coverageDots?.setOverlapMode(false);
  coverageDots?.clearSelection();
  coverageDots?.resetView();
  byId("coverage-detail-panel").hidden = true;
  updateCoverageInspector(null);
}

byId("coverage-reset").addEventListener("click", resetCoverageExperience);
byId("coverage-layers-toggle").addEventListener("click", () => {
  const layers = byId("coverage-layers");
  layers.hidden = !layers.hidden;
});
byId("coverage-help-toggle").addEventListener("click", () => {
  byId("coverage-help").hidden = !byId("coverage-help").hidden;
});
byId("coverage-help-close").addEventListener("click", () => { byId("coverage-help").hidden = true; });

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target && (target.matches("input, textarea, select") || target.isContentEditable)) return;
  if (event.key === "Escape") {
    const now = performance.now();
    const doubleEscape = now - lastEscapeAt < 500;
    lastEscapeAt = now;
    closeCoverageContextMenu();
    overlapMode = false;
    coverageDots?.setOverlapMode(false);
    byId("coverage-detail-panel").hidden = true;
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

renderIcons();
void initialize().catch((error) => {
  console.error(error);
  byId("coverage-state").textContent = "RELEASE UNAVAILABLE";
  byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: "巡天公开目录载入失败" }));
});
