/** Home hero controller: mounts the limb globe, feeds it the featured
 * surveys' published O4 unions, and turns "Open Sky Atlas" into a short
 * pull-back before the Atlas route loads. Loaded lazily; the hero works
 * as plain links when WebGL or this module is unavailable. */
import { HomeGlobe, type HomeGlobeLayer } from "./home-globe.js";

export interface HeroSurvey { id: string; name: string; color?: string }

/** The public coverage overview is published at O4 (nside 16). */
const NSIDE = 16;
const PAGE_SIZE = 100;
/** Guard against a cursor that never ends; the overview holds a few hundred footprints. */
const MAX_PAGES = 20;
let globe: HomeGlobe | null = null;

function webglAvailable(): boolean {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch {
    return false;
  }
}

export function mountHero(): boolean {
  const stage = document.querySelector<HTMLElement>("[data-home-stage]");
  const canvas = stage?.querySelector<HTMLCanvasElement>("canvas");
  if (!stage || !canvas || !webglAvailable()) return false;
  try {
    globe = new HomeGlobe(canvas);
  } catch (error) {
    console.warn("Home globe unavailable", error);
    return false;
  }
  stage.dataset.state = "live";
  bindLaunch();
  return true;
}

/** Union each featured survey's O4 footprints from the public coverage
 * overview (unmetered, cursor-paged) and draw them. Surveys the overview
 * does not list are skipped; nothing is drawn that the API did not return. */
export async function showSurveys(surveys: readonly HeroSurvey[]): Promise<void> {
  if (!globe) return;
  const unions = await loadUnions(new Set(surveys.map((survey) => survey.id)));
  if (!unions) return;
  const layers: HomeGlobeLayer[] = [];
  for (const survey of surveys) {
    const pixels = unions.get(survey.id);
    if (pixels?.size) layers.push({ surveyId: survey.id, color: survey.color, nside: NSIDE, pixels: [...pixels].sort((a, b) => a - b) });
  }
  if (!layers.length) return;
  globe.setLayers(layers);
  renderLegend(surveys, layers);
}

interface OverviewPage {
  nside?: number;
  ordering?: string;
  footprints?: Array<{ surveyId?: string; nside?: number; pixels?: number[] }>;
  page?: { hasMore?: boolean; nextCursor?: string };
}

async function loadUnions(wanted: ReadonlySet<string>): Promise<Map<string, Set<number>> | null> {
  const unions = new Map<string, Set<number>>();
  let cursor: string | undefined;
  try {
    // Follow the cursor to the end so a drawn union is never partial.
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const query = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/v1/coverage?${query}`, { headers: { Accept: "application/json" } });
      if (!response.ok) return null;
      const page = await response.json() as OverviewPage;
      if (page.ordering !== "NESTED" || page.nside !== NSIDE || !Array.isArray(page.footprints)) return null;
      for (const footprint of page.footprints) {
        if (!footprint.surveyId || !wanted.has(footprint.surveyId) || footprint.nside !== NSIDE || !Array.isArray(footprint.pixels)) continue;
        const union = unions.get(footprint.surveyId) ?? new Set<number>();
        footprint.pixels.forEach((pixel) => union.add(pixel));
        unions.set(footprint.surveyId, union);
      }
      if (!page.page?.hasMore) return unions;
      cursor = page.page.nextCursor;
      if (!cursor) return null;
    }
    return null;
  } catch {
    return null;
  }
}

function renderLegend(surveys: readonly HeroSurvey[], layers: readonly HomeGlobeLayer[]): void {
  const legend = document.querySelector<HTMLElement>("[data-home-stage-legend]");
  if (!legend || !layers.length) return;
  legend.replaceChildren();
  layers.forEach((layer) => {
    const survey = surveys.find((entry) => entry.id === layer.surveyId);
    const item = document.createElement("li");
    const swatch = document.createElement("i");
    swatch.style.setProperty("--c", layer.color ?? "currentColor");
    const name = document.createElement("b");
    name.textContent = (survey?.name ?? layer.surveyId).toUpperCase();
    const cells = document.createElement("span");
    cells.textContent = String(layer.pixels.length);
    item.append(swatch, name, cells);
    legend.append(item);
  });
  legend.closest<HTMLElement>(".home-stage-callout")?.removeAttribute("hidden");
}

function bindLaunch(): void {
  document.querySelectorAll<HTMLAnchorElement>("[data-home-launch]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (!globe || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      event.preventDefault();
      const target = link.href;
      document.body.dataset.homeLaunch = "flying";
      let gone = false;
      const go = (): void => {
        if (gone) return;
        gone = true;
        document.body.dataset.homeLaunch = "entering";
        window.setTimeout(() => window.location.assign(target), 180);
      };
      window.setTimeout(go, 1600);
      void globe.flyToAtlas().then(go);
    });
  });
  // Returning through the back/forward cache must show the hero again.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    delete document.body.dataset.homeLaunch;
    globe?.reset();
  });
}
