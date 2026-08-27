import {
  SurveyLayerViewer,
  type SurveyLayerHover,
  type SurveyLayerInspection,
  type SurveyLayerState,
  type SurveyLayerContextMenu,
  type SurveyLayerOverlapComponent,
} from "./atlas/survey-layer-viewer.js";
import type { SurveyFootprintManifest } from "./atlas/survey-footprints.js";
import type { SurveyCard } from "./atlas/survey-registry.js";

export interface CoverageLayer {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  color: string;
  availableOrders: number[];
  overviewOrder: number;
  maxOrder: number;
  cellCount: number;
  areaDeg2: number;
  tileScheme: string;
  tileIdsByOrder?: Record<string, number[]>;
  recipe?: { recipeVersion: number; mode: string; coordinateFrame: string; ordering: string; maxOrder: number; queryOrder: number; previewOrder: number; sourceUrl?: string; steps: Array<{ id: string; kind: string; title: string; bodyMarkdown: string; order: number; implementationRef: string }> };
  sourceUnitIndex?: { status: "exact" | "estimated" | "entrypoint-only"; unitKind?: string; indexUrl?: string; downloadUrlTemplate?: string; notes: string };
}

export interface CoverageCatalog {
  schemaVersion: number;
  coordinateFrame: string;
  ordering: string;
  tileScheme: string;
  layers: CoverageLayer[];
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
    color: record.color,
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

export function footprintManifest(catalog: CoverageCatalog, blocks: ReadonlyMap<string, number[]>): SurveyFootprintManifest {
  const overviewOrders = [...new Set(catalog.layers.map((layer) => layer.overviewOrder))];
  const order = overviewOrders.length ? Math.min(...overviewOrders) : 4;
  const nside = 2 ** order;
  const generatedAt = new Date().toISOString();
  const footprints = catalog.layers
    .map((layer) => ({
      surveyId: layer.surveyId,
      layerId: layer.layerId,
      releaseId: layer.releaseId,
      product: layer.product,
      label: layer.product,
      nside,
      pixels: projectPixelsToOrder(blocks.get(`${layer.layerId}:${layer.overviewOrder}`) ?? [], layer.overviewOrder, order),
      quality: "official_overview" as const,
      sourceUrl: "https://assets.local/coverage/catalog",
      retrievedAt: generatedAt,
      notes: layer.overviewOrder === order
        ? `Overview HEALPix order ${order} loaded from the public coverage catalog.`
        : `Overview HEALPix order ${order} projected from explicit order ${layer.overviewOrder} coverage for the globe preview.`,
    }))
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
  #surveys: CoverageSurvey[] = [];

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
    const manifest = footprintManifest(catalog, blocks);
    const selectedSurveyIds = new Set(this.#visibleSurveyIds);
    this.#viewer?.dispose();
    this.#surveys = surveys;
    const cards = surveys.map(surveyCardFor);
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
    this.#visibleSurveyIds = selectedSurveyIds;
    this.#viewer.setVisibleSurveys(this.#visibleSurveyIds);
    // The viewer is constructed before coverage is known. Reframe once the
    // loaded layers establish the actual outer radius of the globe.
    this.#viewer.setHomePresentation();
    this.#host.dataset.ready = "true";
  }

  setVisibleSurveys(surveyIds: Iterable<string>): void {
    this.#visibleSurveyIds = new Set(surveyIds);
    this.#viewer?.setVisibleSurveys(this.#visibleSurveyIds);
  }

  setOverlapMode(active: boolean): void { this.#viewer?.setOverlapMode(active); }

  setViewportRightInset(insetPixels: number): void { this.#viewer?.setViewportRightInset(insetPixels); }

  setOverlapCells(order: number, pixels: readonly number[]): void { this.#viewer?.setOverlapCells(2 ** order, pixels); }

  setOverlapComponents(components: readonly SurveyLayerOverlapComponent[]): void { this.#viewer?.setOverlapComponents(components); }

  setActiveOverlapComponent(componentId: string | null): void { this.#viewer?.setActiveOverlapComponent(componentId); }

  setHighlightedSurvey(surveyId: string): void {
    this.#viewer?.focusSurvey(surveyId);
  }

  focusSelection(): void { this.#viewer?.focusSelection(); }

  focusPixels(order: number, pixels: readonly number[]): void { this.#viewer?.focusPixels(2 ** order, pixels); }

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
