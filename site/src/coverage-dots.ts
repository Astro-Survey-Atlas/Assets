import { Healpix } from "healpixjs";

export interface CoverageFootprint {
  surveyId: string;
  releaseId: string;
  product: string;
  label?: string;
  nside: number;
  pixels: number[];
}

export interface CoverageManifest {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: string;
  nside: number;
  footprints: CoverageFootprint[];
}

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
}

export interface CoverageCatalog {
  schemaVersion: number;
  coordinateFrame: string;
  ordering: string;
  tileScheme: string;
  layers: CoverageLayer[];
}

interface RenderLayer extends CoverageLayer { cells: Map<number, number[]>; }
interface Projected { x: number; y: number; depth: number; }
interface Polygon { layer: RenderLayer; order: number; ipix: number; points: Projected[]; depth: number; }
interface LayerPath { layer: RenderLayer; path: Path2D; depth: number; }

const FALLBACK_COLOR = "#1e857b";
const parseColor = (value: string | null | undefined): string => /^#[\da-f]{6}$/i.test(value ?? "") ? value! : FALLBACK_COLOR;

function vecFor(theta: number, phi: number): { x: number; y: number; z: number } {
  const sinTheta = Math.sin(theta);
  return { x: sinTheta * Math.cos(phi), y: Math.cos(theta), z: sinTheta * Math.sin(phi) };
}

export class CoverageGlobe {
  readonly #host: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #resizeObserver: ResizeObserver;
  readonly #onActiveChange?: (surveyId: string | null, product?: string) => void;
  readonly #reducedMotion: MediaQueryList;
  #healpix = new Map<number, Healpix>();
  #boundaryCache = new Map<string, Array<{ x: number; y: number; z: number }>>();
  #layers: RenderLayer[] = [];
  #surveyDirections = new Map<string, { x: number; y: number; z: number }>();
  #activeSurvey: string | null = null;
  #selectedSurvey: string | null = null;
  #hoveredSurvey: string | null = null;
  #yaw = -0.42;
  #pitch = 0.08;
  #targetYaw = this.#yaw;
  #targetPitch = this.#pitch;
  #zoom = 1;
  #dragPointerId: number | null = null;
  #lastPointerX = 0;
  #lastPointerY = 0;
  #isDragging = false;
  #pointers = new Map<number, { x: number; y: number }>();
  #pinchDistance = 0;
  #drawHandle = 0;
  #animationFrame = 0;
  #animationStarted = 0;
  #visible = true;
  #lastPolygons: Polygon[] = [];
  #canvasWidth = 0;
  #canvasHeight = 0;
  #canvasDpr = 0;

  constructor(host: HTMLElement, canvas: HTMLCanvasElement, onActiveChange?: (surveyId: string | null, product?: string) => void) {
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("2D canvas is unavailable");
    this.#host = host;
    this.#canvas = canvas;
    this.#context = context;
    this.#onActiveChange = onActiveChange;
    this.#reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    canvas.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      this.#dragPointerId = event.pointerId;
      this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.#pointers.size === 2) this.#pinchDistance = this.#distanceBetweenPointers();
      this.#lastPointerX = event.clientX;
      this.#lastPointerY = event.clientY;
      this.#isDragging = true;
      host.dataset.dragging = "true";
      this.#stopAnimation();
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.#pointers.has(event.pointerId)) this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.#pointers.size >= 2) {
        const distance = this.#distanceBetweenPointers();
        if (this.#pinchDistance > 0 && distance > 0) this.#zoom = Math.max(0.68, Math.min(1.9, this.#zoom * distance / this.#pinchDistance));
        this.#pinchDistance = distance;
        this.#scheduleDraw();
        event.preventDefault();
        return;
      }
      if (!this.#isDragging || event.pointerId !== this.#dragPointerId) return;
      const bounds = canvas.getBoundingClientRect();
      const scale = Math.PI / Math.max(180, Math.min(bounds.width, bounds.height));
      this.#yaw += (event.clientX - this.#lastPointerX) * scale;
      this.#pitch = Math.max(-1.48, Math.min(1.48, this.#pitch + (event.clientY - this.#lastPointerY) * scale));
      this.#targetYaw = this.#yaw;
      this.#targetPitch = this.#pitch;
      this.#lastPointerX = event.clientX;
      this.#lastPointerY = event.clientY;
      this.#scheduleDraw();
      event.preventDefault();
    });
    const endDrag = (event: PointerEvent) => {
      this.#pointers.delete(event.pointerId);
      this.#pinchDistance = this.#pointers.size === 2 ? this.#distanceBetweenPointers() : 0;
      if (event.pointerId !== this.#dragPointerId) return;
      this.#dragPointerId = null;
      this.#isDragging = false;
      delete host.dataset.dragging;
      this.#scheduleDraw();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("lostpointercapture", endDrag);
    canvas.addEventListener("pointermove", (event) => {
      if (this.#isDragging) return;
      const polygon = this.#hit(event.clientX, event.clientY);
      this.#hoveredSurvey = polygon?.layer.surveyId ?? this.#hoveredSurvey;
      if (polygon) this.#setActive(polygon.layer.surveyId, false);
    });
    canvas.addEventListener("click", (event) => {
      const polygon = this.#hit(event.clientX, event.clientY);
      if (!polygon) return;
      this.#selectedSurvey = polygon.layer.surveyId;
      this.#hoveredSurvey = polygon.layer.surveyId;
      host.dataset.selectedSurvey = polygon.layer.surveyId;
      this.#setActive(polygon.layer.surveyId, true, polygon.layer.product);
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.#zoom = Math.max(0.68, Math.min(1.9, this.#zoom * Math.exp(-event.deltaY * 0.001)));
      this.#scheduleDraw();
    }, { passive: false });
    document.addEventListener("visibilitychange", () => {
      this.#visible = document.visibilityState === "visible";
      if (this.#visible) this.#scheduleDraw();
    });
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleDraw());
    this.#resizeObserver.observe(host);
    this.#scheduleDraw();
  }

  load(manifest: CoverageManifest, surveyColors: ReadonlyMap<string, string>): void {
    const layers: CoverageLayer[] = manifest.footprints.map((footprint, index) => ({
      layerId: `${footprint.surveyId}-${footprint.releaseId}-${index}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      productId: `${footprint.surveyId}-${footprint.releaseId}-${index}`,
      surveyId: footprint.surveyId,
      releaseId: footprint.releaseId,
      product: footprint.product,
      color: surveyColors.get(footprint.surveyId) ?? FALLBACK_COLOR,
      availableOrders: [Math.round(Math.log2(footprint.nside))],
      overviewOrder: Math.round(Math.log2(footprint.nside)),
      maxOrder: Math.round(Math.log2(footprint.nside)),
      cellCount: footprint.pixels.length,
      areaDeg2: footprint.pixels.length * (41252.96124941927 / (12 * footprint.nside * footprint.nside)),
      tileScheme: "ipix-range-4096",
    }));
    this.#setLayers(this.#mergeLayers(layers.map((layer, index) => ({ layer, cells: manifest.footprints[index]!.pixels }))));
    this.#canvas.dataset.ready = "true";
    this.#scheduleDraw();
  }

  loadCatalog(catalog: CoverageCatalog, blocks: ReadonlyMap<string, number[]>): void {
    const entries = catalog.layers
      .map((layer) => ({ layer, cells: blocks.get(`${layer.layerId}:${layer.overviewOrder}`) ?? [] }))
      .filter(({ cells }) => cells.length > 0);
    this.#setLayers(this.#mergeLayers(entries));
    this.#canvas.dataset.ready = "true";
    this.#scheduleDraw();
  }

  #mergeLayers(entries: Array<{ layer: CoverageLayer; cells: number[] }>): RenderLayer[] {
    const merged = new Map<string, { layer: CoverageLayer; cells: Set<number> }>();
    for (const entry of entries) {
      const key = `${entry.layer.surveyId}:${entry.layer.overviewOrder}`;
      const current = merged.get(key);
      if (current) {
        for (const cell of entry.cells) current.cells.add(cell);
        continue;
      }
      merged.set(key, { layer: entry.layer, cells: new Set(entry.cells) });
    }
    return [...merged.values()].map(({ layer, cells }) => {
      const values = [...cells].sort((a, b) => a - b);
      const order = layer.overviewOrder;
      return {
        ...layer,
        layerId: `survey-${layer.surveyId}-${order}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
        productId: `survey-${layer.surveyId}`,
        product: "",
        availableOrders: [order],
        maxOrder: order,
        cellCount: values.length,
        areaDeg2: values.length * (41252.96124941927 / (12 * (2 ** order) ** 2)),
        cells: new Map([[order, values]]),
      };
    });
  }

  #setLayers(layers: RenderLayer[]): void {
    this.#layers = layers;
    this.#surveyDirections.clear();
    for (const layer of this.#layers) {
      const hp = this.#healpixFor(layer.overviewOrder);
      const vectors = (layer.cells.get(layer.overviewOrder) ?? []).map((ipix) => {
        const p = hp.pix2ang(ipix);
        return vecFor(p.theta, p.phi);
      });
      const sum = vectors.reduce((acc, value) => ({ x: acc.x + value.x, y: acc.y + value.y, z: acc.z + value.z }), { x: 0, y: 0, z: 0 });
      const length = Math.hypot(sum.x, sum.y, sum.z) || 1;
      this.#surveyDirections.set(layer.surveyId, { x: sum.x / length, y: sum.y / length, z: sum.z / length });
    }
  }

  setHighlightedSurvey(surveyId: string | null): void {
    if (!surveyId) return;
    this.#hoveredSurvey = surveyId;
    this.#setActive(surveyId, false);
  }

  setSelectedSurvey(surveyId: string): void {
    this.#selectedSurvey = surveyId;
    this.#hoveredSurvey = surveyId;
    this.#host.dataset.selectedSurvey = surveyId;
    this.#setActive(surveyId, true);
  }

  resetView(): void {
    this.#zoom = 1;
    this.#targetYaw = -0.42;
    this.#targetPitch = 0.08;
    if (this.#reducedMotion.matches) {
      this.#yaw = this.#targetYaw;
      this.#pitch = this.#targetPitch;
    } else {
      this.#animationStarted = performance.now();
      this.#animationFrame ||= requestAnimationFrame(this.#animate);
    }
    this.#scheduleDraw();
  }

  dispose(): void { this.#resizeObserver.disconnect(); if (this.#drawHandle) cancelAnimationFrame(this.#drawHandle); if (this.#animationFrame) cancelAnimationFrame(this.#animationFrame); }

  #healpixFor(order: number): Healpix {
    const existing = this.#healpix.get(order);
    if (existing) return existing;
    const created = new Healpix(2 ** order);
    this.#healpix.set(order, created);
    return created;
  }

  #distanceBetweenPointers(): number {
    const [first, second] = [...this.#pointers.values()];
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  }

  #setActive(surveyId: string, focus: boolean, product?: string): void {
    if (surveyId === this.#activeSurvey && !focus) return;
    this.#activeSurvey = surveyId;
    this.#host.dataset.highlightedSurvey = surveyId;
    if (focus) {
      const direction = this.#surveyDirections.get(surveyId);
      if (direction) {
        this.#targetYaw = Math.atan2(-direction.x, direction.z);
        this.#targetPitch = Math.atan2(direction.y, Math.max(0.08, Math.hypot(direction.x, direction.z)));
      }
      if (this.#reducedMotion.matches) { this.#yaw = this.#targetYaw; this.#pitch = this.#targetPitch; }
      else { this.#animationStarted = performance.now(); this.#animationFrame ||= requestAnimationFrame(this.#animate); }
    }
    this.#onActiveChange?.(surveyId, product);
    this.#scheduleDraw();
  }

  #stopAnimation(): void { if (this.#animationFrame) cancelAnimationFrame(this.#animationFrame); this.#animationFrame = 0; this.#targetYaw = this.#yaw; this.#targetPitch = this.#pitch; }
  #animate = (now: number): void => {
    const progress = Math.min(1, (now - this.#animationStarted) / 560);
    const eased = 1 - Math.pow(1 - progress, 3);
    this.#yaw += (this.#targetYaw - this.#yaw) * Math.min(0.22, eased * 0.34 + 0.02);
    this.#pitch += (this.#targetPitch - this.#pitch) * Math.min(0.22, eased * 0.34 + 0.02);
    this.#scheduleDraw();
    if (progress < 1 && this.#visible) this.#animationFrame = requestAnimationFrame(this.#animate); else this.#animationFrame = 0;
  };
  #scheduleDraw(): void { if (!this.#visible || this.#drawHandle) return; this.#drawHandle = requestAnimationFrame(() => { this.#drawHandle = 0; this.#draw(); }); }

  #project(vector: { x: number; y: number; z: number }, centerX: number, centerY: number, radius: number): Projected {
    const x = vector.x * Math.cos(this.#yaw) + vector.z * Math.sin(this.#yaw);
    const firstDepth = -vector.x * Math.sin(this.#yaw) + vector.z * Math.cos(this.#yaw);
    const y = vector.y * Math.cos(this.#pitch) - firstDepth * Math.sin(this.#pitch);
    const depth = vector.y * Math.sin(this.#pitch) + firstDepth * Math.cos(this.#pitch);
    return { x: centerX + x * radius, y: centerY - y * radius, depth };
  }

  #draw(): void {
    const bounds = this.#host.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (width !== this.#canvasWidth || height !== this.#canvasHeight || dpr !== this.#canvasDpr) {
      this.#canvas.width = Math.round(width * dpr);
      this.#canvas.height = Math.round(height * dpr);
      this.#canvasWidth = width;
      this.#canvasHeight = height;
      this.#canvasDpr = dpr;
    }
    this.#context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#context.clearRect(0, 0, width, height);
    const radius = Math.min(width, height) * 0.47 * this.#zoom;
    const centerX = width * 0.5;
    const centerY = height * 0.52;
    this.#context.save();
    this.#context.beginPath();
    this.#context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    this.#context.fillStyle = "rgba(255,253,248,0.35)";
    this.#context.fill();
    this.#context.clip();
    const polygons: Polygon[] = [];
    const paths: LayerPath[] = [];
    for (const layer of this.#layers) {
      const order = this.#displayOrder(layer);
      const cells = layer.cells.get(order) ?? [];
      const hp = this.#healpixFor(order);
      const path = new Path2D();
      let depthSum = 0;
      let visibleCells = 0;
      for (const ipix of cells) {
        const boundaries = this.#boundariesFor(hp, order, ipix);
        const points = boundaries.map((point) => this.#project(point, centerX, centerY, radius));
        const depth = points.reduce((sum, point) => sum + point.depth, 0) / points.length;
        if (depth <= -0.16) continue;
        visibleCells += 1;
        depthSum += depth;
        polygons.push({ layer, order, ipix, points, depth });
        points.forEach((point, index) => index ? path.lineTo(point.x, point.y) : path.moveTo(point.x, point.y));
        path.closePath();
      }
      if (visibleCells) paths.push({ layer, path, depth: depthSum / visibleCells });
    }
    if (!this.#isDragging) polygons.sort((a, b) => a.depth - b.depth);
    this.#lastPolygons = polygons;
    paths.sort((a, b) => a.depth - b.depth);
    for (const entry of paths) {
      const active = this.#activeSurvey === entry.layer.surveyId;
      this.#context.fillStyle = parseColor(entry.layer.color);
      this.#context.globalAlpha = this.#activeSurvey ? (active ? 0.78 : 0.10) : 0.46;
      this.#context.fill(entry.path);
      if (!this.#activeSurvey || active) {
        this.#context.strokeStyle = parseColor(entry.layer.color);
        this.#context.globalAlpha = active ? 0.86 : 0.16;
        this.#context.lineWidth = active ? 1.05 : 0.42;
        this.#context.stroke(entry.path);
      }
    }
    this.#context.restore();
    this.#context.beginPath();
    this.#context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    this.#context.strokeStyle = "rgba(30,43,45,0.5)";
    this.#context.lineWidth = 1;
    this.#context.stroke();
  }

  #displayOrder(layer: RenderLayer): number {
    return layer.overviewOrder;
  }

  #boundariesFor(hp: Healpix, order: number, ipix: number): Array<{ x: number; y: number; z: number }> {
    const key = `${order}:${ipix}`;
    const cached = this.#boundaryCache.get(key);
    if (cached) return cached;
    const boundaries = hp.getBoundaries(ipix).map((point) => ({ x: point.x, y: point.y, z: point.z }));
    this.#boundaryCache.set(key, boundaries);
    return boundaries;
  }

  #hit(clientX: number, clientY: number): Polygon | undefined {
    const bounds = this.#canvas.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    for (let index = this.#lastPolygons.length - 1; index >= 0; index -= 1) {
      const polygon = this.#lastPolygons[index]!;
      if (polygon.points.every((point) => point.depth <= 0)) continue;
      let inside = false;
      for (let i = 0, j = polygon.points.length - 1; i < polygon.points.length; j = i++) {
        const a = polygon.points[i]!; const b = polygon.points[j]!;
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
      if (inside) return polygon;
    }
    return undefined;
  }
}

export { CoverageGlobe as CoverageDots };
