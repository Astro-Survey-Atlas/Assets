import { ArrowLeft, ExternalLink, FileCode2, Home, Search, X, createIcons } from "lucide";
import "../src/styles.css";
import { locale, mountLocaleControls, t } from "../src/i18n.js";

interface Asset { label: string; downloadName: string; downloadUrl: string; sha256: string; sizeBytes: number; releaseId?: string; product?: string; surveyId?: string }
interface Product { productId?: string; name: string; modality: string; description?: string; coverage?: { layerId?: string; availableOrders: number[]; overviewOrder: number; maxOrder: number }; sourceUrl?: string; status?: string }
interface Release { id: string; label: string; products: Product[]; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null } }
interface Survey { id: string; name: string; mission: string; modalities: string[]; releases: Release[]; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; assets: Asset[] }
interface SurveyIndex { surveys: Survey[] }
interface FlowNode { id: string; kind: string; title: string; bodyMarkdown: string; order: number; implementationRef: string; evidenceRefs: string[] }
interface FlowEdge { from: string; to: string; label?: string }
interface PublishedProduct { productId: string; surveyId: string; releaseId: string; name: string; modality?: string; coverage?: { layerId?: string; availableOrders: number[]; overviewOrder: number; maxOrder: number }; presentation: { summaryMarkdown: string; methodologyMarkdown: string; limitationsMarkdown: string; flow: { nodes: FlowNode[]; edges: FlowEdge[] } } }
interface ProductIndex { products: PublishedProduct[] }

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let surveys: Survey[] = [];
let published = new Map<string, PublishedProduct>();
let query = "";

mountLocaleControls();

const orderText = (orders?: number[]): string => orders?.length ? orders.map((order) => `O${order}`).join(" / ") : "--";
const productKey = (surveyId: string, releaseId: string, product: Product): string => product.productId ?? `${surveyId}:${releaseId}:${product.name}`;

function appendText(parent: Element, tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function assetsFor(survey: Survey, releaseId: string, productName: string): Asset[] {
  return survey.assets.filter((asset) => asset.releaseId === releaseId && (!asset.product || asset.product === productName));
}

function render(): void {
  const host = byId("resource-surveys");
  host.replaceChildren();
  const filtered = surveys.filter((survey) => !query || `${survey.name} ${survey.mission} ${survey.modalities.join(" ")} ${survey.releases.flatMap((release) => [release.label, ...release.products.flatMap((product) => [product.name, product.modality])]).join(" ")}`.toLocaleLowerCase().includes(query));
  if (!filtered.length) { appendText(host, "div", t("common.noMatch"), "resource-empty"); return; }

  filtered.forEach((survey) => {
    const article = document.createElement("article");
    article.className = "resource-survey";
    const identity = document.createElement("div");
    appendText(identity, "strong", survey.name);
    appendText(identity, "span", survey.mission);
    appendText(identity, "small", survey.modalities.join(" · "));
    article.append(identity);

    const metrics = document.createElement("div");
    metrics.className = "resource-survey-orders";
    appendText(metrics, "b", orderText(survey.coverageOrders?.availableOrders));
    appendText(metrics, "small", `${survey.releases.length} ${localeWord("releases")} · ${survey.releases.reduce((count, release) => count + release.products.length, 0)} ${localeWord("products")}`);
    article.append(metrics);

    const releaseList = document.createElement("div");
    releaseList.className = "resource-release-list";
    survey.releases.forEach((release) => {
      const releaseBlock = document.createElement("div");
      releaseBlock.className = "resource-release-block";
      const releaseHeader = document.createElement("div");
      releaseHeader.className = "resource-release-heading";
      appendText(releaseHeader, "span", release.label);
      appendText(releaseHeader, "code", orderText(release.coverageOrders?.availableOrders));
      releaseBlock.append(releaseHeader);
      const productList = document.createElement("div");
      productList.className = "resource-product-list";
      release.products.forEach((product) => {
        const id = productKey(survey.id, release.id, product);
        const record = published.get(id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "resource-product-item";
        button.dataset.productId = id;
      button.title = `${localeWord("view")} ${survey.name} ${release.label} ${product.name}`;
        appendText(button, "strong", product.name);
        appendText(button, "span", `${record?.modality ?? product.modality} · ${orderText(record?.coverage?.availableOrders ?? product.coverage?.availableOrders)} · ${record ? (locale() === "zh" ? "已发布" : "PUBLISHED") : (locale() === "zh" ? "目录" : "CATALOG")}`);
        button.addEventListener("click", () => openProduct(survey, release, product, record));
        productList.append(button);
      });
      releaseBlock.append(productList);
      releaseList.append(releaseBlock);
    });
    article.append(releaseList);
    host.append(article);
  });
  renderIcons();
}

function detailRow(parent: HTMLElement, label: string, value: string): void {
  const row = document.createElement("div");
  row.className = "resource-detail-row";
  appendText(row, "dt", label);
  appendText(row, "dd", value || "--");
  parent.append(row);
}

function textSection(parent: HTMLElement, title: string, value: string): void {
  const section = document.createElement("section");
  section.className = "resource-detail-section";
  appendText(section, "h3", title);
  const body = appendText(section, "pre", value || (locale() === "zh" ? "暂无已发布内容" : "No published content yet"));
  body.className = "resource-detail-copy";
  parent.append(section);
}

function localeWord(word: "releases" | "products" | "view"): string {
  if (locale() === "zh") return word === "releases" ? "个 release" : word === "products" ? "个产品" : "查看";
  return word === "view" ? "View" : word;
}

function openProduct(survey: Survey, release: Release, catalogProduct: Product, record?: PublishedProduct): void {
  const dialog = byId<HTMLDialogElement>("product-dialog");
  const content = byId("product-dialog-content");
  content.replaceChildren();
  byId("product-dialog-title").textContent = `${survey.name} · ${release.label} · ${catalogProduct.name}`;
  const product = record;
  const meta = document.createElement("dl");
  meta.className = "resource-detail-meta";
  detailRow(meta, "PRODUCT ID", product?.productId ?? catalogProduct.productId ?? "--");
  detailRow(meta, "SURVEY / RELEASE", `${survey.id} / ${release.id}`);
  detailRow(meta, "MODALITY", product?.modality ?? catalogProduct.modality);
  detailRow(meta, "HEALPIX", orderText(product?.coverage?.availableOrders ?? catalogProduct.coverage?.availableOrders));
  if (product?.coverage) detailRow(meta, "OVERVIEW / MAX", `O${product.coverage.overviewOrder} / O${product.coverage.maxOrder}`);
  content.append(meta);

  if (product) {
    textSection(content, "SUMMARY", product.presentation.summaryMarkdown);
    textSection(content, "METHODOLOGY", product.presentation.methodologyMarkdown);
    textSection(content, "LIMITATIONS", product.presentation.limitationsMarkdown);
    const flowSection = document.createElement("section");
    flowSection.className = "resource-detail-section";
    appendText(flowSection, "h3", locale() === "zh" ? "流程" : "PROCESS FLOW");
    const flow = document.createElement("ol");
    flow.className = "resource-flow";
    [...product.presentation.flow.nodes].sort((a, b) => a.order - b.order).forEach((node) => {
      const item = document.createElement("li");
      appendText(item, "strong", node.title);
      appendText(item, "small", `${node.kind} · ${node.implementationRef}`);
      if (node.bodyMarkdown) appendText(item, "pre", node.bodyMarkdown, "resource-detail-copy");
      if (node.evidenceRefs.length) appendText(item, "small", `evidence: ${node.evidenceRefs.join(", ")}`);
      flow.append(item);
    });
    flowSection.append(flow);
    const edgeText = product.presentation.flow.edges.map((edge) => `${edge.from} → ${edge.to}${edge.label ? ` · ${edge.label}` : ""}`).join("\n");
    if (edgeText) appendText(flowSection, "pre", edgeText, "resource-flow-edges");
    content.append(flowSection);
  } else {
    textSection(content, locale() === "zh" ? "已发布内容" : "PUBLISHED CONTENT", locale() === "zh" ? "该产品尚未发布管理员编辑内容。页面保留目录与下载信息，草稿不会公开显示。" : "This product has no published editorial content yet. Catalog and download information remain public; drafts are not shown.");
  }

  const assets = assetsFor(survey, release.id, catalogProduct.name);
  const downloads = document.createElement("section");
  downloads.className = "resource-detail-section";
  appendText(downloads, "h3", locale() === "zh" ? "下载 / 证据" : "DOWNLOADS / EVIDENCE");
  if (!assets.length) appendText(downloads, "p", locale() === "zh" ? "暂无可下载文件" : "No downloadable files", "resource-empty");
  assets.forEach((asset) => {
    const row = document.createElement("div");
    row.className = "resource-detail-download";
    const link = document.createElement("a");
    link.href = asset.downloadUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = asset.label;
    row.append(link);
    appendText(row, "small", `${asset.downloadName} · ${asset.sizeBytes.toLocaleString()} bytes · SHA-256 ${asset.sha256}`);
    downloads.append(row);
  });
  content.append(downloads);
  if (!dialog.open) dialog.showModal();
  const basePath = window.location.pathname.startsWith("/surveys") ? "/surveys/" : "/resources/";
  history.replaceState(null, "", `${basePath}#product=${encodeURIComponent(product?.productId ?? catalogProduct.productId ?? "")}`);
}

function openHashProduct(): void {
  const id = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("product");
  if (!id) return;
  for (const survey of surveys) for (const release of survey.releases) for (const product of release.products) {
    if (productKey(survey.id, release.id, product) === id) {
      openProduct(survey, release, product, published.get(id));
      return;
    }
  }
}

function renderIcons(): void {
  createIcons({ icons: { ArrowLeft, ExternalLink, FileCode2, Home, Search, X }, attrs: { "aria-hidden": "true" } });
}

byId<HTMLInputElement>("resource-search").addEventListener("input", (event) => {
  query = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
  render();
});
byId("product-dialog-close").addEventListener("click", () => byId<HTMLDialogElement>("product-dialog").close());
byId<HTMLDialogElement>("product-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) byId<HTMLDialogElement>("product-dialog").close();
});
window.addEventListener("hashchange", openHashProduct);
window.addEventListener("atlas:locale-change", () => render());
renderIcons();

Promise.all([
  fetch("/api/v1/surveys", { headers: { Accept: "application/json" } }).then((response) => response.ok ? response.json() as Promise<SurveyIndex> : Promise.reject(new Error("survey catalog unavailable"))),
  fetch("/api/v1/products", { headers: { Accept: "application/json" } }).then((response) => response.ok ? response.json() as Promise<ProductIndex> : Promise.reject(new Error("published products unavailable"))),
]).then(([surveyIndex, productIndex]) => {
  surveys = surveyIndex.surveys ?? [];
  published = new Map((productIndex.products ?? []).map((product) => [product.productId, product]));
  render();
  openHashProduct();
}).catch(() => {
  byId("resource-surveys").replaceChildren(Object.assign(document.createElement("div"), { className: "resource-empty", textContent: locale() === "zh" ? "巡天目录暂时不可用" : "Survey directory is temporarily unavailable" }));
});
