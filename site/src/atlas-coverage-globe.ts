import { MIN_PUBLIC_COVERAGE_ORDER } from "../../server/coverage-policy.js";
import type { WarehouseGeometryLoadStatus } from "../../server/coverage.js";
import {
  SurveyLayerViewer,
  type SurveyLayerHover,
  type SurveyLayerInspection,
  type SurveyLayerState,
  type SurveyLayerContextMenu,
  type SurveyLayerOverlapComponent,
  type SurveyLayerOverlapCoverage,
} from "./atlas/survey-layer-viewer.js";
import type { SurveyFootprintManifest } from "./atlas/survey-footprints.js";
import type { SurveyCard } from "./atlas/survey-registry.js";
import { surveyColorFor } from "./atlas/survey-colors.js";
import { filterByModalities } from "../../src/modality-filter.js";

export interface CoverageLayer {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality?: string;
  color: string;
  availableOrders: number[];
  displayOrders?: number[];
  displayRevision?: string;
  nativeRevision?: string;
  nativeMaxOrder?: number;
  overviewOrder: number;
  maxOrder: number;
  cellCount: number;
  areaDeg2: number;
  tileScheme: string;
  tileIdsByOrder?: Record<string, number[]>;
  recipe?: { recipeVersion: number; mode: string; coordinateFrame: string; ordering: string; maxOrder: number; queryOrder: number; previewOrder: number; sourceUrl?: string; steps: Array<{ id: string; kind: string; title: string; bodyMarkdown: string; order: number; implementationRef: string }> };
  sourceUnitIndex?: { status: "exact" | "estimated" | "entrypoint-only"; unitKind?: string; indexUrl?: string; downloadUrlTemplate?: string; notes: string };
  warehouseFileIndex?: { status: "available" | "not-indexed" | "unavailable"; indexUrl?: string; fileCount?: number; coverageCount?: number; errorCount?: number; updatedAt?: string; notes: string };
  revision?: string;
}

export interface CoverageCatalog {
  schemaVersion: number;
  coordinateFrame: string;
  ordering: string;
  tileScheme: string;
  layers: CoverageLayer[];
  revision?: string;
  generatedAt?: string;
  warehouseGeometry?: WarehouseGeometryLoadStatus;
}

export interface CoverageSurvey {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: string[];
  releases: Array<{ id: string; products: Array<{ name: string }> }>;
}

type ActiveChange = (surveyId: string | null, product?: string) => void;
type InspectionChange = (inspection: SurveyLayerInspection | null) => void;
type StateChange = (state: SurveyLayerState) => void;
type ContextMenuChange = (menu: SurveyLayerContextMenu) => void;
type OverlapComponentChange = (component: SurveyLayerOverlapComponent) => void;

function surveyCardFor(record: CoverageSurvey): SurveyCard {
  return {
    id: record.id,
    name: record.name,
    mission: record.mission,
    color: surveyColorFor(record.id, record.color),
    description: record.description,
    modalities: record.modalities as SurveyCard["modalities"],
    origin: "public",
    releaseCount: record.releases.length,
    availableReleaseCount: record.releases.length,
    verifiedFootprintReleaseCount: record.releases.length,
    coverageStatus: "verified",
  };
}

function projectPixelsToOrder(pixels: readonly number[], sourceOrder: number, targetOrder: number): number[] {
  if (sourceOrder < targetOrder) return [];
  const divisor = 4 ** (sourceOrder - targetOrder);
  return [...new Set(pixels.map((pixel) => Math.floor(pixel / divisor)))].sort((left, right) => left - right);
}

export function footprintManifest(
  catalog: CoverageCatalog,
  blocks: ReadonlyMap<string, number[]>,
  modalities: Iterable<string> = [],
  displayOrder?: number,
  layerIds?: Iterable<string>,
): SurveyFootprintManifest {
  // Older cached catalogs may predate the release precision gate. Never let
  // an ineligible layer lower the resolution of every other survey.
  const selectedIds = layerIds ? new Set(layerIds) : undefined;
  const layers = filterByModalities(catalog.layers, modalities).filter(layer => layer.overviewOrder >= MIN_PUBLIC_COVERAGE_ORDER
    && layer.maxOrder >= MIN_PUBLIC_COVERAGE_ORDER && (!selectedIds || selectedIds.has(layer.layerId)));
  const overviewOrders = [...new Set(layers.map((layer) => layer.overviewOrder))];
  const order = displayOrder ?? (overviewOrders.length ? Math.min(...overviewOrders) : MIN_PUBLIC_COVERAGE_ORDER);
  const nside = 2 ** order;
  const generatedAt = new Date().toISOString();
  const footprints = layers
    .filter((layer) => layer.displayOrders
      ? layer.displayOrders.includes(order)
      : layer.availableOrders.includes(order) || layer.overviewOrder > order)
    .map((layer) => {
      const sourceOrder = layer.displayOrders?.includes(order) || layer.availableOrders.includes(order)
        ? order
        : layer.overviewOrder;
      return {
        surveyId: layer.surveyId,
        layerId: layer.layerId,
        releaseId: layer.releaseId,
        product: layer.product,
        modality: layer.modality,
        label: layer.product,
        nside,
        pixels: projectPixelsToOrder(blocks.get(`${layer.layerId}:${sourceOrder}`) ?? [], sourceOrder, order),
        quality: layer.nativeMaxOrder !== undefined ? "moc" as const : "official_overview" as const,
        sourceUrl: "https://assets.local/coverage/catalog",
        retrievedAt: generatedAt,
        notes: layer.nativeMaxOrder !== undefined
          ? `Public native MOC projected at display order ${order}; scientific precision follows the published evidence.`
          : sourceOrder === order
            ? `Published coverage cells loaded at their explicitly available order ${order}.`
            : `Overview HEALPix order ${sourceOrder} projected to the coarser display order ${order}.`,
      };
    })
    .filter((footprint) => footprint.pixels.length > 0);
  return { schemaVersion: 1, generatedAt, coordinateFrame: "ICRS", nside, footprints };
}

export class AtlasCoverageGlobe {
  readonly #host: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #onActiveChange: ActiveChange;
  readonly #onInspectionChange: InspectionChange;
  readonly #onStateChange: StateChange;
  readonly #onContextMenu: ContextMenuChange;
  readonly #onOverlapComponent: OverlapComponentChange;
  #viewer: SurveyLayerViewer | null = null;
  #visibleSurveyIds = new Set<string>();
  #visibleLayerIds = new Set<string>();
  #visibleModalities = new Set<string>();
  #displayOrder = MIN_PUBLIC_COVERAGE_ORDER;
  #surveys: CoverageSurvey[] = [];
  #catalog: CoverageCatalog | null = null;
  #blocks = new Map<string, number[]>();

  constructor(host: HTMLElement, canvas: HTMLCanvasElement, onActiveChange: ActiveChange, onInspectionChange: InspectionChange = () => undefined, onStateChange: StateChange = () => undefined, onContextMenu: ContextMenuChange = () => undefined, onOverlapComponent: OverlapComponentChange = () => undefined) {
    this.#host = host;
    this.#canvas = canvas;
    this.#onActiveChange = onActiveChange;
    this.#onInspectionChange = onInspectionChange;
    this.#onStateChange = onStateChange;
    this.#onContextMenu = onContextMenu;
    this.#onOverlapComponent = onOverlapComponent;
    canvas.dataset.renderer = "three";
  }

  setTheme(theme: "light" | "dark"): void {
    this.#viewer?.setTheme(theme);
  }

  async loadCatalog(catalog: CoverageCatalog, blocks: ReadonlyMap<string, number[]>, surveys: CoverageSurvey[]): Promise<void> {
    // Canvas text is rasterized at creation time, so wait for the bundled
    // faces before constructing labels used by the Three.js viewer.
    try {
      await Promise.all([
        document.fonts.load('700 24px "Atlas Sans CJK"'),
        document.fonts.load('700 12px "Atlas Mono"'),
        document.fonts.ready,
      ]);
    } catch { /* browsers without Font Loading API use the declared fallback */ }
    this.#catalog = catalog;
    this.#blocks = new Map(blocks);
    this.#surveys = surveys;
    this.#renderCatalog();
  }

  setVisibleModalities(modalities: Iterable<string>): void {
    this.#visibleModalities = new Set(modalities);
    if (this.#catalog) this.#renderCatalog();
  }

  #renderCatalog(overlap?: SurveyLayerOverlapCoverage): void {
    if (!this.#catalog) return;
    const manifest = footprintManifest(this.#catalog, this.#blocks, this.#visibleModalities, this.#displayOrder, this.#visibleLayerIds);
    const cards = this.#surveys.map(surveyCardFor);
    if (this.#viewer) {
      this.#viewer.updateCoverage(manifest, cards, this.#visibleSurveyIds, overlap);
      return;
    }
    this.#viewer = new SurveyLayerViewer(
      this.#canvas,
      manifest,
      cards,
      () => undefined,
      (hover) => this.#handleHover(hover),
      (inspection) => this.#handleInspection(inspection),
      (menu) => this.#onContextMenu(menu),
      this.#onStateChange,
      undefined,
      (component) => this.#onOverlapComponent(component),
    );
    this.#viewer.setLayoutMode("layers");
    this.#viewer.setVisibleSurveys(this.#visibleSurveyIds);
    // Only the first mount sets the starting pose; coverage updates retain it.
    this.#viewer.setHomePresentation();
    this.#host.dataset.ready = "true";
  }

  setVisibleSurveys(surveyIds: Iterable<string>): void {
    this.#visibleSurveyIds = new Set(surveyIds);
    this.#viewer?.setVisibleSurveys(this.#visibleSurveyIds);
  }

  setVisibleLayers(layerIds: Iterable<string>): void {
    const next = new Set(layerIds);
    if (next.size === this.#visibleLayerIds.size && [...next].every((id) => this.#visibleLayerIds.has(id))) return;
    this.#visibleLayerIds = next;
    if (this.#catalog) this.#renderCatalog();
  }

  updateBlocks(blocks: ReadonlyMap<string, number[]>, order = this.#displayOrder, overlap?: Omit<SurveyLayerOverlapCoverage, "nside">): void {
    this.#displayOrder = order;
    this.#blocks = new Map(blocks);
    if (this.#catalog) this.#renderCatalog(overlap ? { ...overlap, nside: 2 ** order } : undefined);
  }

  get state(): SurveyLayerState | null {
    return this.#viewer?.state ?? null;
  }

  setOverlapMode(active: boolean): void { this.#viewer?.setOverlapMode(active); }

  setViewportRightInset(insetPixels: number): void { this.#viewer?.setViewportRightInset(insetPixels); }

  setOverlapCells(order: number, pixels: readonly number[]): void { this.#viewer?.setOverlapCells(2 ** order, pixels); }

  setOverlapComponents(components: readonly SurveyLayerOverlapComponent[]): void { this.#viewer?.setOverlapComponents(components); }

  setOverlapCoverage(order: number, pixels: readonly number[], components: readonly SurveyLayerOverlapComponent[]): void {
    this.#viewer?.setOverlapCoverage(2 ** order, pixels, components);
  }

  setActiveOverlapComponent(componentId: string | null): void { this.#viewer?.setActiveOverlapComponent(componentId); }

  setHighlightedSurvey(surveyId: string): void {
    this.#viewer?.focusSurvey(surveyId);
  }

  focusSelection(): void { this.#viewer?.focusSelection(); }

  focusPixels(order: number, pixels: readonly number[]): void { this.#viewer?.focusPixels(2 ** order, pixels); }

  focusViewGeometry(order: number, pixels: readonly number[]) { return this.#viewer?.focusViewGeometry(2 ** order, pixels) ?? null; }

  transitionToDataView(durationMs = 900): void { this.#viewer?.transitionToDataPresentation(durationMs); }

  setHomePresentation(): void { this.#viewer?.setHomePresentation(); }

  setHomeScrollProgress(progress: number): void { this.#viewer?.setHomeScrollProgress(progress); }

  clearSelection(): void {
    this.#viewer?.clearRegionSelection();
    this.#onInspectionChange(null);
  }

  setLayerOrder(keys: Iterable<string>): void { this.#viewer?.setLayerOrder(keys); }

  setSelectedSurvey(surveyId: string): void {
    this.#visibleSurveyIds.add(surveyId);
    this.#viewer?.setVisibleSurveys(this.#visibleSurveyIds);
    this.#viewer?.focusSurvey(surveyId);
    this.#onActiveChange(surveyId);
  }

  resetView(): void {
    this.#viewer?.clearTransientState();
    this.#viewer?.reset();
    this.#onActiveChange(null);
  }

  dispose(): void {
    this.#viewer?.dispose();
    this.#viewer = null;
  }

  #handleHover(hover: SurveyLayerHover | null): void {
    if (!hover?.surveyIds.length) return;
    this.#onActiveChange(hover.surveyIds[0]!, hover.artifacts[0]?.product);
  }

  #handleInspection(inspection: SurveyLayerInspection | null): void {
    this.#onInspectionChange(inspection);
    if (!inspection?.surveyIds.length) return;
    this.#onActiveChange(inspection.surveyIds[0]!, inspection.artifacts[0]?.product);
  }
}
