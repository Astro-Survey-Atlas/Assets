import { byIdOrNull } from "../dom.js";
import type { SurveyLayerState } from "./survey-layer-viewer.js";

/**
 * Screen-space tactical HUD drawn over the single WebGL canvas: heading tape,
 * declination ladder, target reticle, minimap, telemetry and event log.
 * Everything here is derived from viewer state; nothing is invented.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const RA_PX_PER_DEG = 24;
const DEC_PX_PER_DEG = 20;

const byId = <T extends HTMLElement | SVGElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const normalizeRa = (value: number) => ((value % 360) + 360) % 360;
const signed = (value: number, digits = 1) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

export interface HudTarget {
  order: number;
  pixel: number | null;
  cellCount: number;
  label: string;
  /** Per survey: modalities of the covering products, or the survey's declared ones. */
  surveys?: Array<{ name: string; color: string; modalities: string[]; declared: boolean }>;
}

let target: HudTarget | null = null;
let lastState: SurveyLayerState | null = null;

export function setHudTarget(next: HudTarget | null): void {
  target = next;
  if (lastState) updateHudView(lastState);
}

export function setHudMode(overlap: boolean): void {
  const tag = byId("hud-mode");
  const label = byId("hud-mode-label");
  if (!tag || !label) return;
  tag.dataset.mode = overlap ? "overlap" : "layers";
  label.textContent = overlap ? "OVERLAP MODE · G" : "LAYER MODE";
}

function renderRaTape(state: SurveyLayerState, depthActive: boolean): void {
  const tape = byId("hud-ra-tape");
  if (!tape) return;
  const center = state.viewCenter;
  tape.hidden = !center || depthActive;
  if (!center) return;
  const strip = tape.querySelector<HTMLElement>(".hud-ra-strip");
  const current = tape.querySelector<HTMLOutputElement>(".hud-ra-current");
  if (!strip || !current) return;
  const width = tape.clientWidth || 720;
  const span = Math.ceil(width / 2 / RA_PX_PER_DEG) + 1;
  const base = Math.floor(center.raDeg);
  const nodes: HTMLElement[] = [];
  for (let step = -span; step <= span; step += 1) {
    const deg = base + step;
    const x = width / 2 + (deg - center.raDeg) * RA_PX_PER_DEG * center.raScreenSign;
    if (x < 0 || x > width) continue;
    const label = normalizeRa(deg);
    const tick = document.createElement("i");
    tick.className = label % 5 === 0 ? "is-major" : "";
    tick.style.left = `${x}px`;
    nodes.push(tick);
    if (label % 5 === 0) {
      const text = document.createElement("span");
      text.style.left = `${x}px`;
      text.textContent = String(label);
      nodes.push(text);
    }
  }
  strip.replaceChildren(...nodes);
  current.textContent = `RA ${center.raDeg.toFixed(1)}°`;
}

function renderDecLadder(state: SurveyLayerState, depthActive: boolean): void {
  const ladder = byId("hud-dec-ladder");
  if (!ladder) return;
  const center = state.viewCenter;
  ladder.hidden = !center || depthActive;
  if (!center) return;
  const strip = ladder.querySelector<HTMLElement>(".hud-dec-strip");
  const current = ladder.querySelector<HTMLOutputElement>(".hud-dec-current");
  if (!strip || !current) return;
  const height = ladder.clientHeight || 520;
  const span = Math.ceil(height / 2 / DEC_PX_PER_DEG) + 1;
  const base = Math.round(center.decDeg);
  const nodes: HTMLElement[] = [];
  for (let step = -span; step <= span; step += 1) {
    const deg = base + step;
    if (deg < -90 || deg > 90) continue;
    const y = height / 2 - (deg - center.decDeg) * DEC_PX_PER_DEG;
    if (y < 0 || y > height) continue;
    const tick = document.createElement("i");
    tick.className = deg % 5 === 0 ? "is-major" : "";
    tick.style.top = `${y}px`;
    nodes.push(tick);
    if (deg % 5 === 0) {
      const text = document.createElement("span");
      text.style.top = `${y}px`;
      text.textContent = signed(deg, 0);
      nodes.push(text);
    }
  }
  strip.replaceChildren(...nodes);
  current.textContent = `DEC ${signed(center.decDeg)}°`;
}

function renderReticle(state: SurveyLayerState, depthActive: boolean): void {
  const reticle = byId("hud-reticle");
  const callout = byId("hud-callout");
  const canvas = byId("coverage-canvas");
  if (!reticle || !callout || !canvas) return;
  const anchor = state.selectionAnchor;
  const show = Boolean(anchor?.visible && target && !depthActive);
  reticle.hidden = true;
  callout.hidden = !show;
  if (!show || !anchor || !target) return;
  const rect = canvas.getBoundingClientRect();
  const x = rect.left + anchor.xRatio * rect.width;
  const y = rect.top + anchor.yRatio * rect.height;
  reticle.style.transform = `translate(${x}px, ${y}px)`;
  const halfWidth = Math.max(26, Math.min(160, (anchor.bounds.rightRatio - anchor.bounds.leftRatio) * rect.width / 2 + 10));
  const halfHeight = Math.max(22, Math.min(160, (anchor.bounds.bottomRatio - anchor.bounds.topRatio) * rect.height / 2 + 10));
  const corner = 12;
  let brackets = reticle.querySelector<SVGPathElement>(".hud-reticle-brackets");
  const svg = reticle.querySelector("svg");
  if (!brackets && svg) {
    brackets = document.createElementNS(SVG_NS, "path");
    brackets.setAttribute("class", "hud-reticle-brackets");
    svg.append(brackets);
  }
  brackets?.setAttribute("d", [
    `M${-halfWidth},${-halfHeight + corner}V${-halfHeight}H${-halfWidth + corner}`,
    `M${halfWidth - corner},${-halfHeight}H${halfWidth}V${-halfHeight + corner}`,
    `M${halfWidth},${halfHeight - corner}V${halfHeight}H${halfWidth - corner}`,
    `M${-halfWidth + corner},${halfHeight}H${-halfWidth}V${halfHeight - corner}`,
  ].join(""));

  // Lead the callout away from the cell, toward whichever side has room.
  const roster = byId("coverage-layers")?.getBoundingClientRect();
  const leftLimit = (roster && roster.width ? roster.right : 0) + 24;
  const dx = x - 470 > leftLimit ? -250 : 250;
  const dy = y - 210 > 90 ? -150 : 150;
  callout.style.transform = `translate(${x}px, ${y}px)`;
  const line = callout.querySelector<HTMLElement>(".hud-callout-line");
  const box = callout.querySelector<HTMLElement>(".hud-callout-box");
  if (line) {
    line.style.width = `${Math.hypot(dx, dy) - 60}px`;
    line.style.transform = `rotate(${Math.atan2(dy, dx)}rad) translateX(60px)`;
  }
  if (box) {
    box.style.left = `${dx < 0 ? dx - (box.offsetWidth || 210) : dx}px`;
    box.style.top = `${dy - 26}px`;
    const [kicker, title, detail] = [box.querySelector("small"), box.querySelector("b"), box.querySelector("span")];
    if (kicker) kicker.textContent = `TARGET · O${target.order}`;
    if (title) title.textContent = target.pixel !== null && target.cellCount <= 1 ? `IPIX ${target.pixel}` : `${target.cellCount.toLocaleString("en-US")} CELLS`;
    if (detail) detail.textContent = target.label;
    let list = box.querySelector<HTMLElement>(".hud-callout-modalities");
    if (!list) {
      list = Object.assign(document.createElement("ul"), { className: "hud-callout-modalities" });
      box.append(list);
    }
    const key = JSON.stringify(target.surveys ?? []);
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...(target.surveys ?? []).map((survey) => {
        const item = document.createElement("li");
        item.style.setProperty("--c", survey.color);
        item.append(
          Object.assign(document.createElement("b"), { textContent: survey.name }),
          Object.assign(document.createElement("span"), { textContent: survey.modalities.join(" · ") || "—" }),
        );
        if (survey.declared) item.append(Object.assign(document.createElement("em"), { textContent: "DECLARED", title: "Modalities the survey declares; no product modality is recorded for this cell" }));
        return item;
      }));
    }
  }
}

function renderTelemetry(state: SurveyLayerState): void {
  const alt = byId("hud-telemetry-alt");
  const tilt = byId("hud-telemetry-tilt");
  const cells = byId("hud-telemetry-cells");
  if (alt) alt.textContent = `${state.viewAltitude.toFixed(2)} R`;
  if (tilt) tilt.textContent = state.viewTiltDeg === null ? "--" : `${state.viewTiltDeg.toFixed(0)}°`;
  if (cells) cells.textContent = state.visibleCellCount.toLocaleString("en-US");
}

/* ---------- minimap ---------- */

interface MinimapCell { color: string; direction: [number, number, number] }
let minimapCells: MinimapCell[] = [];
let minimapKey = "";

type Vec = [number, number, number];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec): Vec => { const length = Math.hypot(...a) || 1; return [a[0] / length, a[1] / length, a[2] / length]; };

export function setHudMinimapCells(cells: readonly MinimapCell[]): void {
  minimapCells = [...cells];
  minimapKey = "";
  if (lastState) renderMinimap(lastState);
}

function minimapBasis(state: SurveyLayerState): { view: Vec; right: Vec; up: Vec } {
  // View the overview globe from slightly above the camera so it reads as a
  // tilted sphere, matching the low tactical camera of the main view.
  const camera = unit(state.coverageViewDirection);
  const worldUp: Vec = [0, 1, 0];
  let right = cross(worldUp, camera);
  if (Math.hypot(...right) < 1e-3) right = [1, 0, 0];
  right = unit(right);
  const north = unit(cross(camera, right));
  const elevation = 0.42;
  const view = unit([
    camera[0] * Math.cos(elevation) + north[0] * Math.sin(elevation),
    camera[1] * Math.cos(elevation) + north[1] * Math.sin(elevation),
    camera[2] * Math.cos(elevation) + north[2] * Math.sin(elevation),
  ]);
  const up = unit(cross(view, right));
  return { view, right, up };
}

function renderMinimap(state: SurveyLayerState): void {
  const svg = byId<SVGSVGElement>("hud-minimap");
  if (!svg) return;
  const key = `${state.coverageViewDirection.map((value) => value.toFixed(2)).join(",")}:${state.viewCenter?.raDeg.toFixed(1)}:${state.viewCenter?.decDeg.toFixed(1)}`;
  if (key === minimapKey) return;
  minimapKey = key;
  const radius = 84;
  const { view, right, up } = minimapBasis(state);
  const project = (point: Vec) => ({ x: dot(point, right) * radius, y: -dot(point, up) * radius, front: dot(point, view) >= 0 });
  const nodes: SVGElement[] = [];
  const element = (name: string, attributes: Record<string, string>) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, value);
    return node;
  };
  nodes.push(element("circle", { class: "hud-minimap-limb", r: String(radius) }));
  // Graticule: equator and the 0h/6h meridians, front half solid, back half dashed.
  const circles: Array<(t: number) => Vec> = [
    (t) => [Math.cos(t), 0, Math.sin(t)],
    (t) => [0, Math.sin(t), Math.cos(t)],
    (t) => [Math.cos(t), Math.sin(t), 0],
  ];
  for (const circle of circles) {
    let front = "";
    let back = "";
    let previous: boolean | null = null;
    for (let index = 0; index <= 72; index += 1) {
      const point = project(circle((index / 72) * Math.PI * 2));
      const segment = `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      const command = previous === point.front ? "L" : "M";
      if (point.front) front += `${command}${segment}`;
      else back += `${command}${segment}`;
      previous = point.front;
    }
    nodes.push(element("path", { class: "hud-minimap-grid", d: front }));
    nodes.push(element("path", { class: "hud-minimap-grid is-back", d: back }));
  }
  const paths = new Map<string, string>();
  for (const cell of minimapCells) {
    const point = project(cell.direction);
    if (!point.front) continue;
    paths.set(cell.color, `${paths.get(cell.color) ?? ""}M${(point.x - 1.1).toFixed(1)},${(point.y - 1.1).toFixed(1)}h2.2v2.2h-2.2z`);
  }
  for (const [color, d] of paths) {
    const path = element("path", { class: "hud-minimap-cells", d });
    path.style.fill = color;
    nodes.push(path);
  }
  // View cone: from the point under the camera to the sky at the view centre.
  const nadir = project(unit(state.coverageViewDirection));
  if (state.viewCenter) {
    const ra = (state.viewCenter.raDeg * Math.PI) / 180;
    const dec = (state.viewCenter.decDeg * Math.PI) / 180;
    const focus = project([-Math.cos(dec) * Math.sin(ra), Math.sin(dec), -Math.cos(dec) * Math.cos(ra)]);
    const along = [focus.x - nadir.x, focus.y - nadir.y];
    const length = Math.hypot(along[0]!, along[1]!) || 1;
    const normal = [-along[1]! / length, along[0]! / length];
    const spread = Math.max(14, length * 0.55);
    const cone = element("path", {
      class: "hud-minimap-cone",
      d: `M${nadir.x.toFixed(1)},${nadir.y.toFixed(1)}L${(focus.x + normal[0]! * spread).toFixed(1)},${(focus.y + normal[1]! * spread).toFixed(1)}L${(focus.x - normal[0]! * spread).toFixed(1)},${(focus.y - normal[1]! * spread).toFixed(1)}Z`,
    });
    nodes.push(cone);
  }
  nodes.push(element("circle", { class: "hud-minimap-camera", cx: nadir.x.toFixed(1), cy: nadir.y.toFixed(1), r: "3" }));
  svg.replaceChildren(...nodes);
}

/* ---------- event log ---------- */

export type HudLogPart = string | { text: string; tone: "ind" | "hot" };
const logLines: HudLogPart[][] = [];

export function hudLog(parts: HudLogPart[]): void {
  const host = byId("hud-log");
  if (!host) return;
  const text = parts.map((part) => typeof part === "string" ? part : part.text).join("");
  const last = logLines[logLines.length - 1];
  if (last && last.map((part) => typeof part === "string" ? part : part.text).join("") === text) return;
  logLines.push(parts);
  while (logLines.length > 3) logLines.shift();
  host.replaceChildren(...logLines.map((line) => {
    const row = document.createElement("div");
    row.append("> ");
    for (const part of line) {
      if (typeof part === "string") row.append(part);
      else row.append(Object.assign(document.createElement(part.tone === "hot" ? "em" : "b"), { textContent: part.text }));
    }
    return row;
  }));
}

/* ---------- roster ---------- */

export interface HudRosterRow {
  surveyId: string;
  name: string;
  sub: string;
  color: string;
  /** Sky fraction of the largest public layer, or null when the survey has no coverage. */
  skyFraction: number | null;
  on: boolean;
}

export function formatSkyFraction(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction) || fraction <= 0) return "—";
  const percent = fraction * 100;
  if (percent >= 10) return `${percent.toFixed(0)}%`;
  if (percent >= 0.1) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
}

/** Roster facts appended to a layer-panel survey row: release line,
 * ten-segment sky bar and the sky fraction of its largest public layer. */
export function buildLayerFacts(row: HudRosterRow): HTMLElement {
  const facts = document.createElement("span");
  facts.className = "hud-layer-facts";
  const sub = Object.assign(document.createElement("small"), { className: "hud-layer-sub", textContent: row.sub });
  const segments = document.createElement("span");
  segments.className = "hud-unit-segs";
  const filled = row.skyFraction && row.skyFraction > 0 ? Math.max(1, Math.min(10, Math.round(row.skyFraction * 10))) : 0;
  for (let segment = 0; segment < 10; segment += 1) {
    const bar = document.createElement("i");
    if (row.on && segment < filled) bar.className = "is-filled";
    segments.append(bar);
  }
  const pct = document.createElement("span");
  pct.className = "hud-unit-pct";
  pct.append(row.on ? formatSkyFraction(row.skyFraction) : "—", Object.assign(document.createElement("small"), { textContent: row.on ? "SKY" : "OFF" }));
  facts.title = row.skyFraction === null ? row.name : `${row.name} · ${formatSkyFraction(row.skyFraction)} of the sky (largest public layer)`;
  facts.append(sub, segments, pct);
  return facts;
}

/* ---------- per-frame view sync ---------- */

export function updateHudView(state: SurveyLayerState): void {
  lastState = state;
  const depthActive = Boolean(byId("coverage-canvas")?.dataset.depthPoints);
  renderRaTape(state, depthActive);
  renderDecLadder(state, depthActive);
  renderReticle(state, depthActive);
  renderTelemetry(state);
  renderMinimap(state);
}
