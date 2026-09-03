import {
  ArrowRight,
  ArrowUpRight,
  Database,
  ExternalLink,
  FileCheck2,
  Grid2X2,
  LocateFixed,
  Menu,
  Moon,
  PanelsTopLeft,
  Play,
  Sun,
  Star,
  Telescope,
  X,
  createIcons,
} from "lucide";
import { locale, mountLocaleControls, t } from "./i18n.js";
import { mountSiteChrome } from "./site-chrome.js";
import "./public.css";

interface SurveyRecord {
  id: string;
  name: string;
  mission: string;
  modalities: string[];
  releases: Array<{ products: Array<unknown> }>;
  statistics?: { publicProducts?: number; acquired?: number; footprintCells?: number };
}

interface SurveyIndex { surveys: SurveyRecord[] }

const modalityLabels: Record<string, { en: string; zh: string }> = {
  imaging: { en: "imaging", zh: "图像" },
  spectroscopy: { en: "spectroscopy", zh: "光谱" },
  photometry: { en: "photometry", zh: "测光" },
  "time-domain": { en: "time-domain", zh: "时域" },
  "integral-field": { en: "integral-field", zh: "积分场" },
  ultraviolet: { en: "ultraviolet", zh: "紫外" },
  infrared: { en: "infrared", zh: "红外" },
  catalog: { en: "catalog", zh: "目录" },
  simulation: { en: "simulation", zh: "仿真" },
};

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function renderIcons(): void {
  createIcons({
    icons: { ArrowRight, ArrowUpRight, Database, ExternalLink, FileCheck2, Grid2X2, "Grid2x2": Grid2X2, LocateFixed, Menu, Moon, PanelsTopLeft, Play, Star, Sun, Telescope, X },
    attrs: { "aria-hidden": "true" },
  });
}

function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function drawSkyPreview(): void {
  const canvas = byId<HTMLCanvasElement>("home-sky-canvas");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = document.documentElement.dataset.theme !== "light";
  const indigo = cssColor("--brand-indigo", "#2c3792");
  const indigoStrong = cssColor("--brand-indigo-strong", dark ? "#8d97ff" : "#20286f");
  const magenta = cssColor("--brand-magenta", "#f01951");
  context.clearRect(0, 0, width, height);

  // Keep the matrix static, but shape its visibility spatially: it enters
  // softly from the left, is clearest around ASA, and fades out to the right
  // and at the top/bottom edges like the supplied reference image.
  const smoothstep = (edge0: number, edge1: number, value: number): number => {
    const normalized = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return normalized * normalized * (3 - 2 * normalized);
  };
  const horizontalFade = (value: number): number => smoothstep(0.02, 0.34, value) * (1 - smoothstep(0.68, 1, value));
  const verticalFade = (value: number): number => smoothstep(0, 0.2, value) * (1 - smoothstep(0.8, 1, value));
  const mobile = width < 760;
  const cell = Math.max(10, Math.min(20, width / 56));
  const centerColumn = Math.round((width * (mobile ? .58 : .67)) / cell);
  const centerRow = Math.round((height * (mobile ? .78 : .53)) / cell);
  const dotSize = Math.max(6, Math.min(14, cell * .72));
  const drawDot = (x: number, y: number, alpha: number, color: string): void => {
    const half = dotSize / 2;
    const radius = Math.min(2.8, dotSize * .28);
    context.globalAlpha = Math.max(0, Math.min(1, alpha));
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x - half + radius, y - half);
    context.arcTo(x + half, y - half, x + half, y + half, radius);
    context.arcTo(x + half, y + half, x - half, y + half, radius);
    context.arcTo(x - half, y + half, x - half, y - half, radius);
    context.arcTo(x - half, y - half, x + half, y - half, radius);
    context.closePath();
    context.fill();
  };
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  for (let row = 0; row < rows; row += 1) {
    const y = row * cell + cell / 2;
    const yFade = verticalFade(y / height);
    for (let column = 0; column < columns; column += 1) {
      const x = column * cell + cell / 2;
      const fade = horizontalFade(x / width) * yFade;
      if (fade < .008) continue;
      const variation = .58 + ((column * 13 + row * 17 + 9001) % 11) / 24;
      const accent = (column * 19 + row * 23 + 7) % 29 === 0;
      const color = accent ? magenta : ((column + row) % 5 === 0 ? indigo : indigoStrong);
      const alpha = fade * (dark ? .28 : .2) * variation;
      drawDot(x, y, alpha, color);
    }
  }

  const glyphs: Record<string, string[]> = {
    A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    S: ["11111", "10000", "10000", "01110", "00001", "00001", "11111"],
  };
  const glyphScale = 1;
  const letterGap = 3;
  const word = ["A", "S", "A"];
  const wordWidth = word.reduce((sum, letter) => sum + glyphs[letter]![0]!.length * glyphScale, 0) + letterGap * (word.length - 1);
  const wordHeight = glyphs.A!.length * glyphScale;
  const startColumn = Math.round(centerColumn - wordWidth / 2);
  const startRow = Math.round(centerRow - wordHeight / 2);
  word.forEach((letter, letterIndex) => {
    const rowsForLetter = glyphs[letter]!;
    rowsForLetter.forEach((pattern, row) => {
      [...pattern].forEach((value, column) => {
        if (value !== "1") return;
        const gridColumn = startColumn + column + letterIndex * (rowsForLetter[0]!.length + letterGap);
        const gridRow = startRow + row;
        const x = gridColumn * cell + cell / 2;
        const y = gridRow * cell + cell / 2;
        const fade = horizontalFade(x / width) * verticalFade(y / height);
        const accent = (column * 7 + row * 11 + letterIndex * 5) % 9 === 0;
        drawDot(x, y, (dark ? .78 : .84) * Math.max(.62, fade), accent ? magenta : indigoStrong);
      });
    });
  });
  context.globalAlpha = 1;
}

function renderStats(surveys: SurveyRecord[]): void {
  const releases = surveys.reduce((sum, survey) => sum + survey.releases.length, 0);
  const products = surveys.reduce((sum, survey) => sum + (survey.statistics?.publicProducts ?? survey.releases.reduce((releaseSum, release) => releaseSum + release.products.length, 0)), 0);
  byId("home-stat-surveys").textContent = String(surveys.length);
  byId("home-stat-releases").textContent = String(releases);
  byId("home-stat-products").textContent = String(products);
}

function renderFeaturedSurveys(surveys: SurveyRecord[]): void {
  const host = byId("home-featured-surveys");
  host.replaceChildren();
  const featured = surveys.slice(0, 5);
  if (!featured.length) {
    const empty = document.createElement("div");
    empty.className = "snapshot-empty";
    empty.textContent = locale() === "zh" ? "暂无可用巡天目录" : "No public surveys are available.";
    host.append(empty);
    return;
  }
  featured.forEach((survey) => {
    const row = document.createElement("a");
    row.className = "snapshot-row";
    row.href = `/atlas/?survey=${encodeURIComponent(survey.id)}`;
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = survey.name;
    const details = document.createElement("span");
    const modalities = survey.modalities.map((modality) => modalityLabels[modality]?.[locale()] ?? modality);
    details.textContent = `${survey.mission} · ${modalities.join(" · ")}`;
    copy.append(name, details);
    const count = document.createElement("b");
    const productCount = survey.statistics?.acquired ?? survey.releases.reduce((sum, release) => sum + release.products.length, 0);
    count.textContent = `${productCount} ${t("home.productsCount")}`;
    row.append(copy, count);
    host.append(row);
  });
}

async function loadCatalog(): Promise<void> {
  try {
    const response = await fetch("/api/v1/surveys", { headers: { Accept: "application/json" }, cache: "no-cache" });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    const value = await response.json() as SurveyIndex;
    if (!Array.isArray(value.surveys)) throw new Error("Catalog response is invalid");
    renderStats(value.surveys);
    renderFeaturedSurveys(value.surveys);
  } catch (error) {
    const host = byId("home-featured-surveys");
    host.replaceChildren();
    const message = document.createElement("div");
    message.className = "snapshot-empty";
    message.textContent = locale() === "zh" ? "公共目录暂时不可用，请打开巡天目录重试。" : "The public catalog is temporarily unavailable. Open the directory to retry.";
    host.append(message);
    console.warn("Public survey catalog unavailable", error);
  }
}

mountLocaleControls();
mountSiteChrome();
renderIcons();
drawSkyPreview();
void loadCatalog();
window.addEventListener("resize", drawSkyPreview, { passive: true });
window.addEventListener("atlas:theme-change", drawSkyPreview);
window.addEventListener("atlas:locale-change", () => {
  drawSkyPreview();
  void loadCatalog();
});
