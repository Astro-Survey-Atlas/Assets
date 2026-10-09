import {
  ArrowRight,
  ArrowUpRight,
  Box,
  CircleHelp,
  Database,
  ExternalLink,
  FileCheck2,
  Grid2X2,
  Image,
  Layers3,
  ListChecks,
  LocateFixed,
  Menu,
  Moon,
  PanelsTopLeft,
  Pause,
  Play,
  RotateCcw,
  Star,
  Sun,
  Telescope,
  X,
  createIcons,
} from "lucide";
import { locale, mountLocaleControls, t } from "./i18n.js";
import { mountSiteChrome } from "./site-chrome.js";
import { surveyMarkMarkup } from "./survey-mark.js";
import "./public.css";
import "./homepage.css";
import "./survey-mark.css";

interface SurveyProduct {
  modality?: string;
  coverage?: { maxOrder?: number };
}

interface SurveyRelease {
  products: SurveyProduct[];
}

interface SurveyRecord {
  id: string;
  name: string;
  mission: string;
  modalities: string[];
  releases: SurveyRelease[];
  statistics?: { publicProducts?: number };
}

interface SurveyIndex { surveys: SurveyRecord[] }
type TabName = "coverage" | "overlap" | "sources";

const byId = <T extends Element = HTMLElement>(id: string): T => document.getElementById(id) as unknown as T;
const tabNames: TabName[] = ["coverage", "overlap", "sources"];
const featuredSurveyIds = ["euclid", "desi", "legacy-surveys", "hst"];
const modalityLabels: Record<string, { en: string; zh: string }> = {
  imaging: { en: "imaging", zh: "图像" },
  spectroscopy: { en: "spectroscopy", zh: "光谱" },
  redshift: { en: "redshift", zh: "红移" },
  photometry: { en: "photometry", zh: "测光" },
  "time-domain": { en: "time-domain", zh: "时域" },
  "integral-field": { en: "integral-field", zh: "积分场" },
  ultraviolet: { en: "ultraviolet", zh: "紫外" },
  infrared: { en: "infrared", zh: "红外" },
  catalog: { en: "catalog", zh: "目录" },
  simulation: { en: "simulation", zh: "仿真" },
};
const modalityIcons: Record<string, string> = {
  imaging: "image",
  spectroscopy: "telescope",
  redshift: "locate-fixed",
  photometry: "database",
  "time-domain": "rotate-ccw",
  "integral-field": "layers-3",
  ultraviolet: "sun",
  infrared: "circle-help",
  catalog: "list-checks",
  simulation: "box",
};

function renderIcons(root: HTMLElement = document.body): void {
  createIcons({
    icons: {
      ArrowRight, ArrowUpRight, Box, CircleHelp, Database, ExternalLink, FileCheck2,
      Grid2X2, Image, Layers3, ListChecks, LocateFixed, Menu, Moon, PanelsTopLeft,
      Pause, Play, RotateCcw, Star, Sun, Telescope, X,
    },
    attrs: { "aria-hidden": "true" },
    root,
  });
}

function renderStats(surveys: SurveyRecord[]): void {
  const releases = surveys.reduce((sum, survey) => sum + survey.releases.length, 0);
  const products = surveys.reduce((sum, survey) => sum + (survey.statistics?.publicProducts ?? survey.releases.reduce((count, release) => count + release.products.length, 0)), 0);
  byId("home-stat-surveys").textContent = String(surveys.length);
  byId("home-stat-releases").textContent = String(releases);
  byId("home-stat-products").textContent = String(products);
}

function renderFeaturedSurveys(surveys: SurveyRecord[]): void {
  const host = byId("home-featured-surveys");
  host.replaceChildren();
  const bySurveyId = new Map(surveys.map((survey) => [survey.id, survey]));
  const featured = featuredSurveyIds.flatMap((id) => {
    const survey = bySurveyId.get(id);
    return survey ? [survey] : [];
  });
  if (!featured.length) {
    const empty = document.createElement("div");
    empty.className = "home-catalog-message";
    empty.textContent = t("home.catalogEmpty");
    host.append(empty);
    return;
  }

  featured.forEach((survey, index) => {
    const row = document.createElement("a");
    row.className = "home-survey-row";
    row.href = `/atlas/?survey=${encodeURIComponent(survey.id)}`;
    row.setAttribute("aria-label", `${survey.name}: ${survey.mission}`);

    const position = document.createElement("span");
    position.className = "home-survey-index";
    position.textContent = String(index + 1).padStart(2, "0");

    const logo = document.createElement("span");
    logo.className = "home-survey-logo";
    logo.setAttribute("aria-hidden", "true");
    logo.innerHTML = surveyMarkMarkup(survey.id);

    const identity = document.createElement("span");
    identity.className = "home-survey-identity";
    const name = document.createElement("strong");
    name.textContent = survey.name;
    const mission = document.createElement("small");
    mission.textContent = survey.mission;
    identity.append(name, mission);

    const modalities = [...new Set([
      ...(survey.modalities ?? []),
      ...survey.releases.flatMap((release) => release.products.flatMap((product) => product.modality ? [product.modality] : [])),
    ])];
    const modalityList = document.createElement("span");
    modalityList.className = "home-survey-modalities";
    modalityList.setAttribute("aria-label", `${survey.name} ${locale() === "zh" ? "模态：" : "modalities: "}${modalities.map((modality) => modalityLabels[modality]?.[locale()] ?? modality).join("、")}`);
    modalities.slice(0, 5).forEach((modality) => {
      const icon = document.createElement("i");
      icon.dataset.lucide = modalityIcons[modality] ?? "database";
      icon.title = modalityLabels[modality]?.[locale()] ?? modality;
      modalityList.append(icon);
    });

    const orders = survey.releases.flatMap((release) => release.products.flatMap((product) => product.coverage?.maxOrder ?? []));
    const precision = document.createElement("span");
    precision.className = "home-survey-precision";
    precision.textContent = orders.length ? `O${Math.max(...orders)}` : "—";
    precision.title = orders.length
      ? `${locale() === "zh" ? "最高原生阶数" : "Finest native order"} O${Math.max(...orders)}`
      : (locale() === "zh" ? "目录未声明原生阶数" : "Native order not specified in catalog");

    const products = survey.statistics?.publicProducts ?? survey.releases.reduce((sum, release) => sum + release.products.length, 0);
    const summary = document.createElement("span");
    summary.className = "home-survey-counts";
    summary.textContent = locale() === "zh"
      ? `${survey.releases.length} 个版本 · ${products} 个产品`
      : `${survey.releases.length} releases · ${products} products`;

    const arrow = document.createElement("i");
    arrow.dataset.lucide = "arrow-up-right";
    arrow.className = "home-survey-arrow";
    row.append(position, logo, identity, modalityList, precision, summary, arrow);
    host.append(row);
  });
  renderIcons(host);
}

type SvgAttributes = Record<string, string | number>;
function svgNode(tag: string, attributes: SvgAttributes, parent: SVGElement, text?: string): SVGElement {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}

function drawGraphic(svg: SVGElement, mode: TabName): void {
  const mobile = window.matchMedia("(max-width: 700px)").matches;
  const width = mobile ? 390 : 760;
  const height = mobile ? 455 : 380;
  const cell = mobile ? 20 : 24;
  const columns = mobile ? 14 : 17;
  const rows = mobile ? 8 : 10;
  const gridOrigin = mobile ? [20, 74] : [65, 122];
  const matrix = mobile ? "matrix(1 -.16 .35 .8 0 0)" : "matrix(1 -.22 .56 .72 0 0)";
  const pointOnPlane = (x: number, y: number): [number, number] => mobile
    ? [gridOrigin[0]! + x + .35 * y, gridOrigin[1]! - .16 * x + .8 * y]
    : [gridOrigin[0]! + x + .56 * y, gridOrigin[1]! - .22 * x + .72 * y];

  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const titleId = `home-diagram-title-${mode}`;
  const descriptionId = `home-diagram-description-${mode}`;
  svgNode("title", { id: titleId }, svg, t(`home.tab${mode[0]!.toUpperCase()}${mode.slice(1)}Image`));
  svgNode("desc", { id: descriptionId }, svg, t("home.conceptNotice"));
  svg.setAttribute("aria-labelledby", `${titleId} ${descriptionId}`);

  const grid = svgNode("g", { transform: `translate(${gridOrigin[0]} ${gridOrigin[1]}) ${matrix}` }, svg);
  for (let x = 0; x <= columns; x += 1) {
    svgNode("line", { x1: x * cell, y1: 0, x2: x * cell, y2: rows * cell, class: "home-grid-line" }, grid);
  }
  for (let y = 0; y <= rows; y += 1) {
    svgNode("line", { x1: 0, y1: y * cell, x2: columns * cell, y2: y * cell, class: "home-grid-line" }, grid);
  }

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const blue = mode === "coverage"
        ? (x >= 1 && x <= 6 && y >= 1 && y <= 4) || (x >= 3 && x <= 5 && y >= 5 && y <= 6)
        : x >= 1 && x <= (mobile ? 8 : 10) && y >= 1 && y <= 6;
      const red = mode === "coverage"
        ? (x >= (mobile ? 8 : 10) && x <= columns - 2 && y >= 2 && y <= rows - 2) || (x === (mobile ? 7 : 9) && y >= rows - 4)
        : x >= (mobile ? 6 : 7) && x <= columns - 2 && y >= 3 && y <= rows - 2;
      if (blue || red) {
        svgNode("rect", { x: x * cell + 3, y: y * cell + 3, width: cell - 6, height: cell - 6, class: blue && red ? "home-cell-joint" : blue ? "home-cell-blue" : "home-cell-red" }, grid);
      } else {
        svgNode("rect", { x: x * cell + cell / 2 - 1, y: y * cell + cell / 2 - 1, width: 2, height: 2, class: "home-grid-dot" }, grid);
      }
    }
  }

  const box = (x: number, y: number, boxWidth: number, title: string, subtitle: string): void => {
    svgNode("rect", { x, y, width: boxWidth, height: mobile ? 50 : 52, class: "home-graphic-box" }, svg);
    svgNode("text", { x: x + (mobile ? 8 : 12), y: y + 21, class: "home-graphic-label" }, svg, title);
    svgNode("text", { x: x + (mobile ? 8 : 12), y: y + 38, class: "home-graphic-caption" }, svg, subtitle);
  };

  if (mode === "coverage") {
    if (mobile) {
      box(10, 330, 176, t("home.legendA"), t("home.tabCoverage"));
      box(204, 330, 176, t("home.legendB"), t("home.tabCoverage"));
    } else {
      const bluePoint = pointOnPlane(6 * cell + 12, 3 * cell + 12);
      const redPoint = pointOnPlane(14 * cell + 12, 6 * cell + 12);
      svgNode("path", { d: `M${bluePoint[0]} ${bluePoint[1]} H564 V118 H594`, class: "home-graphic-leader" }, svg);
      svgNode("path", { d: `M${redPoint[0]} ${redPoint[1]} H572 V234 H594`, class: "home-graphic-leader" }, svg);
      box(594, 92, 146, t("home.legendA"), t("home.tabCoverage"));
      box(594, 208, 146, t("home.legendB"), t("home.tabCoverage"));
    }
  } else {
    const selectionX = (mobile ? 6 : 7) * cell + 1;
    const selectionY = (mobile ? 3 : 4) * cell + 1;
    const selectionSize = (mobile ? 3 : 3) * cell - 2;
    svgNode("rect", { x: selectionX, y: selectionY, width: selectionSize, height: selectionSize, class: "home-selection-line" }, grid);
    [[selectionX, selectionY], [selectionX + selectionSize, selectionY], [selectionX + selectionSize, selectionY + selectionSize], [selectionX, selectionY + selectionSize]].forEach(([x, y]) => {
      svgNode("rect", { x: x! - 3, y: y! - 3, width: 6, height: 6, class: "home-selection-line" }, grid);
    });
    const point = pointOnPlane(selectionX + selectionSize, selectionY + selectionSize / 2);
    if (mode === "overlap") {
      if (mobile) box(100, 344, 190, t("home.legendJoint"), t("home.tabOverlap"));
      else {
        svgNode("path", { d: `M${point[0]} ${point[1]} H571 V178 H594`, class: "home-graphic-leader" }, svg);
        box(594, 152, 146, t("home.legendJoint"), t("home.tabOverlap"));
      }
    } else if (mobile) {
      ["Tile", "brick", "observation"].forEach((unit, index) => box(6 + index * 128, 360, 120, unit, t("home.tabSources")));
    } else {
      svgNode("path", { d: `M${point[0]} ${point[1]} H558 M558 110 V282`, class: "home-graphic-leader" }, svg);
      ["Tile", "brick", "observation"].forEach((unit, index) => {
        const y = 84 + index * 86;
        svgNode("path", { d: `M558 ${y + 26} H594`, class: "home-graphic-leader" }, svg);
        box(594, y, 146, unit, t("home.tabSources"));
      });
    }
  }

  if (!mobile) {
    svgNode("path", { d: "M34 68H46 M40 62V74 M698 330H710 M704 324V336", class: "home-graphic-leader" }, svg);
    svgNode("text", { x: 64, y: 361, class: "home-graphic-caption" }, svg, t("home.conceptNotice"));
  }
}

const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-home-tab]")];
const workflow = document.querySelector<HTMLElement>(".home-workflow");
const rotationButton = document.querySelector<HTMLButtonElement>("[data-home-autoplay]");
const rotationLabel = rotationButton?.querySelector<HTMLElement>("[data-i18n]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let currentTab: TabName = "overlap";
let autoIntent: boolean | null = null;
let hovering = false;
let timer: number | null = null;
let loadedSurveys: SurveyRecord[] | null = null;
let catalogFailed = false;

function tabContent(name: TabName): { title: string; copy: string; cards: Array<[string, string]> } {
  const prefix = `home.tab${name[0]!.toUpperCase()}${name.slice(1)}`;
  return {
    title: t(`${prefix}Title`),
    copy: t(`${prefix}Copy`),
    cards: [1, 2, 3].map((index) => [t(`${prefix}Card${index}Title`), t(`${prefix}Card${index}Body`)]),
  };
}

function renderTab(name: TabName): void {
  currentTab = name;
  const selected = tabs.find((tab) => tab.dataset.homeTab === name);
  tabs.forEach((tab) => {
    const isSelected = tab === selected;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(isSelected));
    tab.setAttribute("tabindex", isSelected ? "0" : "-1");
    tab.setAttribute("aria-controls", "workflow-panel");
    tab.classList.toggle("is-active", isSelected);
  });
  const panel = byId("workflow-panel");
  if (selected) panel.setAttribute("aria-labelledby", selected.id);
  const content = tabContent(name);
  const summary = byId("home-summary");
  summary.replaceChildren();
  const kicker = document.createElement("p");
  kicker.className = "home-summary-kicker";
  kicker.textContent = `0${tabNames.indexOf(name) + 1} / ${t(`home.tab${name[0]!.toUpperCase()}${name.slice(1)}`)}`;
  const title = document.createElement("h2");
  title.id = "workflow-title";
  title.textContent = content.title;
  const copy = document.createElement("p");
  copy.className = "home-summary-copy";
  copy.textContent = content.copy;
  summary.append(kicker, title, copy);

  const cards = byId("home-info-cards");
  cards.replaceChildren();
  content.cards.forEach(([heading, body], index) => {
    const card = document.createElement("article");
    card.className = "home-info-card";
    const number = document.createElement("span");
    number.className = "home-info-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const cardTitle = document.createElement("h3");
    cardTitle.textContent = heading;
    const cardBody = document.createElement("p");
    cardBody.textContent = body;
    card.append(number, cardTitle, cardBody);
    cards.append(card);
  });
  drawGraphic(byId<SVGElement>("home-diagram"), name);
}

function autoRequested(): boolean {
  return autoIntent ?? !reducedMotion.matches;
}

function hasKeyboardFocus(): boolean {
  const active = document.activeElement;
  return Boolean(workflow && active && workflow.contains(active) && active.matches(":focus-visible"));
}

function mayRotate(): boolean {
  return autoRequested() && !document.hidden && !hovering && !hasKeyboardFocus();
}

function syncRotationControl(): void {
  if (!rotationButton || !rotationLabel) return;
  const enabled = autoRequested();
  rotationLabel.textContent = t(enabled ? "home.pauseRotation" : "home.resumeRotation");
  rotationButton.setAttribute("aria-label", t(enabled ? "home.pauseRotation" : "home.resumeRotation"));
  rotationButton.setAttribute("aria-pressed", String(!enabled));
  const iconHost = rotationButton.querySelector<HTMLElement>(".home-rotation-icon");
  const iconName = enabled ? "pause" : "play";
  if (iconHost && iconHost.querySelector("[data-lucide]")?.getAttribute("data-lucide") !== iconName) {
    const icon = document.createElement("i");
    icon.dataset.lucide = iconName;
    iconHost.replaceChildren(icon);
    renderIcons(iconHost);
  }
}

function scheduleRotation(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  syncRotationControl();
  if (!mayRotate()) return;
  timer = window.setTimeout(() => {
    timer = null;
    if (!mayRotate()) return;
    const next = (tabNames.indexOf(currentTab) + 1) % tabNames.length;
    renderTab(tabNames[next]!);
    scheduleRotation();
  }, 5000);
}

function chooseTab(value: string, updateUrl: boolean, focus = false): void {
  const name = tabNames.includes(value as TabName) ? value as TabName : "overlap";
  renderTab(name);
  if (focus) tabs.find((tab) => tab.dataset.homeTab === name)?.focus();
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", name);
    window.history.replaceState(window.history.state, "", url);
  }
  scheduleRotation();
}

function renderCatalogFailure(): void {
  const host = byId("home-featured-surveys");
  host.replaceChildren();
  const message = document.createElement("div");
  message.className = "home-catalog-message";
  message.textContent = t("home.catalogUnavailable");
  host.append(message);
}

async function loadCatalog(): Promise<void> {
  try {
    const response = await fetch("/api/v1/surveys", { headers: { Accept: "application/json" }, cache: "no-cache" });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    const value = await response.json() as SurveyIndex;
    if (!Array.isArray(value.surveys)) throw new Error("Catalog response is invalid");
    catalogFailed = false;
    loadedSurveys = value.surveys;
    renderStats(loadedSurveys);
    renderFeaturedSurveys(loadedSurveys);
  } catch (error) {
    catalogFailed = true;
    renderCatalogFailure();
    console.warn("Public survey catalog unavailable", error);
  }
}

mountLocaleControls();
mountSiteChrome();
renderIcons();
tabs.forEach((tab) => {
  tab.addEventListener("click", () => chooseTab(tab.dataset.homeTab ?? "overlap", true));
  tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    chooseTab(tabs[next]!.dataset.homeTab ?? "overlap", true, true);
  });
});
workflow?.addEventListener("pointerenter", (event) => {
  if (event.pointerType !== "mouse") return;
  hovering = true;
  scheduleRotation();
});
workflow?.addEventListener("pointerleave", (event) => {
  if (event.pointerType !== "mouse") return;
  hovering = false;
  scheduleRotation();
});
workflow?.addEventListener("focusin", scheduleRotation);
workflow?.addEventListener("focusout", () => queueMicrotask(scheduleRotation));
rotationButton?.addEventListener("click", () => {
  autoIntent = !autoRequested();
  scheduleRotation();
});
document.addEventListener("visibilitychange", scheduleRotation);
reducedMotion.addEventListener("change", () => {
  autoIntent = null;
  scheduleRotation();
});
window.addEventListener("resize", () => drawGraphic(byId<SVGElement>("home-diagram"), currentTab), { passive: true });
window.addEventListener("popstate", () => chooseTab(new URLSearchParams(window.location.search).get("tab") ?? "overlap", false));
window.addEventListener("atlas:locale-change", () => {
  renderTab(currentTab);
  if (loadedSurveys) {
    renderStats(loadedSurveys);
    renderFeaturedSurveys(loadedSurveys);
  } else if (catalogFailed) renderCatalogFailure();
  syncRotationControl();
  scheduleRotation();
});

chooseTab(new URLSearchParams(window.location.search).get("tab") ?? "overlap", false);
void loadCatalog();
