import { byId } from "../dom.js";
import { t } from "../i18n.js";
import { normalizeSkyRectangle, type SkyRectangle } from "../../../src/sky-region.js";

export interface RegionQueryLayer { layerId: string; surveyId: string; releaseId: string; product: string }
export interface RegionQueryOptions {
  layers(): RegionQueryLayer[];
  draw(enabled: boolean): void;
  outline(rectangle: SkyRectangle | null): void;
  query(rectangle: SkyRectangle, boundaryOrder: number): void;
  cancel(): void;
}

/** Owns only the drawing/form lifecycle; lookup and manifests use the shared evidence pipeline. */
export class RegionQueryPanel {
  readonly root = byId("coverage-region-panel");
  readonly results = byId("coverage-region-results");
  readonly #options: RegionQueryOptions;
  #drawing = false;
  #rectangle: SkyRectangle | null = null;
  #beforeDraw: SkyRectangle | null = null;

  constructor(options: RegionQueryOptions) {
    this.#options = options;
    byId("coverage-region-toggle").addEventListener("click", () => this.open());
    byId("coverage-region-close").addEventListener("click", () => this.close());
    byId("coverage-region-draw").addEventListener("click", () => this.startDrawing());
    byId("coverage-region-cancel").addEventListener("click", () => this.cancel());
    byId<HTMLFormElement>("coverage-region-form").addEventListener("submit", event => {
      event.preventDefault();
      const rectangle = this.#read();
      if (!rectangle) return;
      const layers = options.layers();
      if (!layers.length) { this.status(t("region.noLayers")); return; }
      this.#setDrawing(false);
      this.#rectangle = rectangle;
      this.#fill(rectangle);
      options.outline(rectangle);
      this.refreshLayers();
      options.query(rectangle, Number(byId<HTMLSelectElement>("coverage-region-order").value));
    });
    for (const field of this.root.querySelectorAll<HTMLInputElement>("input")) field.addEventListener("change", () => {
      const rectangle = this.#read();
      if (rectangle) { this.#setDrawing(false); this.#rectangle = rectangle; options.outline(rectangle); }
    });
    window.addEventListener("atlas:locale-change", () => this.refreshLayers());
  }

  get isOpen(): boolean { return !this.root.hidden; }
  get isDrawing(): boolean { return this.#drawing; }

  open(draw = false): void {
    this.root.hidden = false;
    this.refreshLayers();
    if (draw) this.startDrawing();
    else byId<HTMLInputElement>("region-ra-start").focus();
  }

  close(): void {
    this.cancel();
    this.#options.outline(null);
    this.root.hidden = true;
  }

  cancel(): void {
    if (this.#drawing) {
      this.#rectangle = this.#beforeDraw;
      if (this.#rectangle) this.#fill(this.#rectangle);
    }
    this.#setDrawing(false);
    this.#options.outline(this.#rectangle);
    this.#options.cancel();
    this.status(t("region.cancelled"));
  }

  startDrawing(): void {
    this.root.hidden = false;
    this.#beforeDraw = this.#rectangle;
    this.#setDrawing(true);
    this.status(t("region.drawingHint"));
  }

  rectangleChanged(rectangle: SkyRectangle | null, phase: "draft" | "commit" | "cancel"): void {
    if (rectangle) this.#fill(rectangle);
    if (phase === "draft") return;
    this.#rectangle = rectangle;
    this.#setDrawing(false);
    this.status(t(phase === "commit" ? "region.drawn" : "region.cancelled"));
  }

  refreshLayers(): void {
    const layers = this.#options.layers();
    const summary = byId("coverage-region-layers");
    summary.textContent = layers.length ? layers.map(layer => `${layer.surveyId} / ${layer.releaseId} / ${layer.product}`).join("\n") : t("region.noLayers");
    byId<HTMLButtonElement>("coverage-region-query").disabled = !layers.length;
  }

  status(message: string): void { byId("coverage-region-status").textContent = message; }

  #setDrawing(enabled: boolean): void {
    this.#drawing = enabled;
    this.root.classList.toggle("is-drawing", enabled);
    byId("coverage-region-draw").setAttribute("aria-pressed", String(enabled));
    this.#options.draw(enabled);
  }

  #fill(rectangle: SkyRectangle): void {
    const values = { "region-ra-start": rectangle.raStart, "region-ra-end": rectangle.raEnd, "region-dec-min": rectangle.decMin, "region-dec-max": rectangle.decMax };
    for (const [id, value] of Object.entries(values)) byId<HTMLInputElement>(id).value = String(Number(value.toFixed(6)));
  }

  #read(): SkyRectangle | null {
    try {
      const value = (id: string): number => {
        const input = byId<HTMLInputElement>(id);
        if (!input.value.trim()) throw new Error(t("region.invalid"));
        return Number(input.value);
      };
      return normalizeSkyRectangle({ raStart: value("region-ra-start"), raEnd: value("region-ra-end"), decMin: value("region-dec-min"), decMax: value("region-dec-max") });
    } catch (error) {
      this.status(`${t("region.invalid")}: ${error instanceof Error ? error.message : ""}`);
      return null;
    }
  }
}
