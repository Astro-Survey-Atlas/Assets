import { BadgeCheck, Box, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, Image, Layers3, ListChecks, Search, Telescope, X, createIcons } from "lucide";
import { CoverageDots, type CoverageManifest } from "./coverage-dots";

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
  statistics: { releases: number; acquired: number; rawMocFiles: number; packages: number; totalBytes: number };
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
}

interface SurveyRelease {
  id: string;
  label: string;
  kind: string;
  releasedYear?: number;
  modalities: Modality[];
  products: SurveyProduct[];
}

interface SurveyRecord {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: Modality[];
  releases: SurveyRelease[];
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

const assetGroupDefinitions: Array<{ id: "moc" | "geometry" | "package" | "evidence"; label: string; icon: string; kinds: AssetKind[] }> = [
  { id: "moc", label: "FITS MOC", icon: "telescope", kinds: ["moc"] },
  { id: "geometry", label: "几何", icon: "layers-3", kinds: ["geometry"] },
  { id: "package", label: "资源包", icon: "file-archive", kinds: ["package"] },
  { id: "evidence", label: "证据", icon: "file-check-2", kinds: ["metadata"] },
];

let manifest: ReleaseManifest | null = null;
let surveyIndex: SurveyIndex | null = null;
let search = "";
let coverageDots: CoverageDots | null = null;

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
    icons: { BadgeCheck, Box, Copy, Database, Download, ExternalLink, Eye, FileArchive, FileCheck2, FileCode2, FileJson2, Image, Layers3, ListChecks, Search, Telescope, X },
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
    for (const product of release.products) {
      const row = document.createElement("section");
      row.className = "product-row";
      const identity = document.createElement("div");
      const releaseLabel = document.createElement("span"); releaseLabel.className = "product-release"; releaseLabel.textContent = release.label;
      const name = document.createElement("strong"); name.textContent = product.name;
      const detail = document.createElement("p"); detail.textContent = product.description;
      identity.append(releaseLabel, name, detail);
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
    const card = document.createElement("article");
    card.className = "survey-card";
    card.style.setProperty("--survey-color", survey.color);
    card.addEventListener("mouseenter", () => coverageDots?.setHighlightedSurvey(survey.id));
    card.addEventListener("mouseleave", () => coverageDots?.setHighlightedSurvey(null));
    card.addEventListener("focusin", () => coverageDots?.setHighlightedSurvey(survey.id));
    card.addEventListener("focusout", (event) => {
      if (!card.contains(event.relatedTarget as Node | null)) coverageDots?.setHighlightedSurvey(null);
    });
    const visual = document.createElement("div"); visual.className = "survey-card-visual";
    const image = document.createElement("img"); image.src = survey.imageUrl; image.alt = `${survey.name} 已收录 HEALPix 覆盖预览`; image.loading = "lazy";
    const visualLabel = document.createElement("span"); visualLabel.textContent = survey.statistics.footprintCells ? `${survey.statistics.footprintCells.toLocaleString("en-US")} HEALPIX CELLS` : "NO GEOMETRY YET";
    visual.append(image, visualLabel);

    const body = document.createElement("div"); body.className = "survey-card-body";
    const title = document.createElement("div"); title.className = "survey-card-title";
    const mission = document.createElement("span"); mission.textContent = survey.mission;
    const heading = document.createElement("h3"); heading.textContent = survey.name;
    title.append(mission, heading);
    const description = document.createElement("p"); description.className = "survey-card-description"; description.textContent = survey.description;
    const tags = document.createElement("div"); tags.className = "modality-tags";
    survey.modalities.forEach((modality) => { const tag = document.createElement("span"); tag.className = "modality-tag"; tag.textContent = modalityLabels[modality]; tags.append(tag); });
    const progress = document.createElement("div"); progress.className = "survey-progress";
    const progressCopy = document.createElement("div");
    const progressLabel = document.createElement("span"); progressLabel.textContent = "PUBLIC PRODUCTS";
    const progressValue = document.createElement("strong"); progressValue.textContent = `${survey.statistics.acquired} 个已收录 / ${survey.statistics.publicProducts} 个公开`;
    progressCopy.append(progressLabel, progressValue);
    const detail = document.createElement("button"); detail.type = "button"; detail.className = "survey-detail-button"; detail.textContent = "查看产品"; detail.addEventListener("click", () => showSurveyProducts(survey));
    progress.append(progressCopy, detail);

    const actions = document.createElement("div"); actions.className = "survey-actions";
    assetGroups(survey).forEach((group) => {
      const action = document.createElement("button"); action.type = "button"; action.className = "asset-action";
      action.disabled = !group.records.length;
      action.title = group.records.length ? `查看 ${survey.name} 的${group.label}` : `${survey.name} 暂无已发布${group.label}`;
      action.append(icon(group.icon));
      const label = document.createElement("span"); label.textContent = group.label;
      const count = document.createElement("small"); count.textContent = String(group.records.length);
      action.append(label, count);
      if (group.records.length) action.addEventListener("click", () => showAssetGroup(survey, group.label, group.records));
      actions.append(action);
    });
    body.append(title, description, tags, progress, actions);
    card.append(visual, body);
    return card;
  }));
  renderIcons();
}

async function initialize(): Promise<void> {
  try {
    coverageDots = new CoverageDots(byId("coverage-scene"), byId<HTMLCanvasElement>("coverage-canvas"));
  } catch (error) {
    console.warn("Coverage dot matrix unavailable", error);
    byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
  }
  const [assetsResponse, coverageResponse, surveysResponse] = await Promise.all([
    fetch("/api/v1/assets", { headers: { Accept: "application/json" } }),
    fetch("/api/v1/coverage", { headers: { Accept: "application/json" } }),
    fetch("/api/v1/surveys", { headers: { Accept: "application/json" } }),
  ]);
  if (!assetsResponse.ok || !surveysResponse.ok) throw new Error("Public catalog request failed");
  manifest = await assetsResponse.json() as ReleaseManifest;
  surveyIndex = await surveysResponse.json() as SurveyIndex;
  if (coverageResponse.ok && coverageDots) {
    const coverage = await coverageResponse.json() as CoverageManifest;
    coverageDots.load(coverage, new Map(surveyIndex.surveys.map((survey) => [survey.id, survey.color])));
    byId("coverage-state").textContent = "PUBLIC HEALPIX DOT MATRIX";
  } else {
    byId("coverage-state").textContent = "COVERAGE PREVIEW UNAVAILABLE";
  }
  byId("header-release").textContent = `${manifest.bundle.id.toUpperCase()} · VERIFIED`;
  byId("stat-releases").textContent = String(manifest.statistics.releases);
  byId("stat-acquired").textContent = String(manifest.statistics.acquired);
  byId("stat-moc").textContent = String(manifest.statistics.rawMocFiles);
  byId("stat-packages").textContent = String(manifest.statistics.packages);
  byId("stat-size").textContent = bytes(manifest.statistics.totalBytes);
  byId("bundle-hash").textContent = manifest.bundle.sha256;
  byId("generated-at").textContent = new Date(manifest.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" }) + " UTC";
  const provenance = manifest.files.find((record) => record.kind === "provenance");
  if (provenance) byId<HTMLAnchorElement>("provenance-download").href = provenance.downloadUrl;
  renderSurveys();
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

renderIcons();
void initialize().catch((error) => {
  console.error(error);
  byId("header-release").textContent = "RELEASE UNAVAILABLE";
  byId("survey-list").replaceChildren(Object.assign(document.createElement("div"), { className: "error-row", textContent: "巡天公开目录载入失败" }));
});
