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
  Sun,
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
    icons: { ArrowRight, ArrowUpRight, Database, ExternalLink, FileCheck2, Grid2X2, "Grid2x2": Grid2X2, LocateFixed, Menu, Moon, PanelsTopLeft, Sun, Telescope, X },
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
  const background = cssColor("--public-bg", dark ? "#090b18" : "#fbfbfe");
  const indigo = cssColor("--brand-indigo", "#2c3792");
  const indigoStrong = cssColor("--brand-indigo-strong", dark ? "#8d97ff" : "#20286f");
  const magenta = cssColor("--brand-magenta", "#f01951");
  context.clearRect(0, 0, width, height);
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  let seed = 0x2c3792;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = 0; index < Math.round(width * height / 220); index += 1) {
    const x = random() * width;
    const y = random() * height;
    const radius = .35 + random() * 1.1;
    context.globalAlpha = .2 + random() * .55;
    context.fillStyle = indigoStrong;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;

  const centerX = width * .54;
  const centerY = height * .51;
  const radius = Math.min(width, height) * .34;
  context.save();
  context.translate(centerX, centerY);
  context.strokeStyle = indigo;
  context.lineWidth = 1;
  context.globalAlpha = dark ? .78 : .55;
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.stroke();
  context.globalAlpha = dark ? .34 : .22;
  for (let index = 1; index < 6; index += 1) {
    const offset = radius * (index / 6);
    context.beginPath();
    context.ellipse(0, 0, radius, offset, 0, 0, Math.PI * 2);
    context.stroke();
  }
  for (let index = 1; index < 6; index += 1) {
    const widthScale = index / 6;
    context.beginPath();
    context.ellipse(0, 0, radius * widthScale, radius, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = dark ? .72 : .58;
  context.strokeStyle = magenta;
  context.lineWidth = 2;
  for (const band of [-.56, -.28, .12, .38]) {
    context.beginPath();
    context.ellipse(0, radius * band, radius * .92, radius * .13, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = dark ? .18 : .12;
  context.fillStyle = magenta;
  context.beginPath();
  context.moveTo(-radius * .82, radius * .18);
  context.bezierCurveTo(-radius * .22, -radius * .28, radius * .08, radius * .58, radius * .83, -radius * .12);
  context.lineTo(radius * .83, radius * .12);
  context.bezierCurveTo(radius * .05, radius * .84, -radius * .3, -radius * .06, -radius * .82, radius * .3);
  context.closePath();
  context.fill();
  context.restore();
  context.globalAlpha = 1;

  context.fillStyle = indigoStrong;
  context.font = "600 10px monospace";
  context.fillText("NESTED / O4-O8", 16, height - 18);
  context.fillStyle = magenta;
  const coverageLabel = locale() === "zh" ? "公共覆盖" : "PUBLIC COVERAGE";
  context.fillText(coverageLabel, width - (locale() === "zh" ? 76 : 116), 23);
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
