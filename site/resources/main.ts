import { ArrowLeft, ExternalLink, FileCode2, GitBranch, Home, Search, Telescope, X, createIcons } from "lucide";
import "../src/styles.css";
import { locale, mountLocaleControls, t } from "../src/i18n.js";

interface Asset { label: string; downloadName: string; downloadUrl: string; sha256: string; sizeBytes: number; releaseId?: string; product?: string; surveyId?: string }
interface Product { productId?: string; name: string; modality: string; description?: string; coverage?: { layerId?: string; availableOrders: number[]; overviewOrder: number; maxOrder: number; coverageRole?: string; areaDeg2?: number }; sourceUrl?: string; geometrySourceUrl?: string; sourceLabel?: string; geometrySourceLabel?: string; dataOrigin?: string; sourceTier?: string; status?: string; reason?: string; manualStep?: string; detailUrl?: string; evidenceUrl?: string; links?: ProductLink[] }
interface ProductLink { kind: string; label: string; url: string; description?: string; mediaType?: string; sizeBytes?: number; sha256?: string }
interface EvidenceItem { kind: string; label: string; description: string; visibility: "public" | "evidence-only" | "unavailable"; url?: string; filename?: string; mediaType?: string; sizeBytes?: number; sha256?: string; reason?: string }
interface Release { id: string; label: string; products: Product[]; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null } }
interface Survey { id: string; name: string; mission: string; modalities: string[]; releases: Release[]; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; assets: Asset[] }
interface SurveyIndex { surveys: Survey[] }
interface FlowNode { id: string; kind: string; title: string; bodyMarkdown: string; order: number; implementationRef: string; evidenceRefs: string[] }
interface FlowEdge { from: string; to: string; label?: string }
interface PublishedProduct { productId: string; surveyId: string; releaseId: string; name: string; modality?: string; coverage?: { layerId?: string; availableOrders: number[]; overviewOrder: number; maxOrder: number }; presentation: { summaryMarkdown: string; methodologyMarkdown: string; limitationsMarkdown: string; flow: { nodes: FlowNode[]; edges: FlowEdge[] } } }
interface ProductIndex { products: PublishedProduct[] }
interface ProductDossier {
  schemaVersion: 1;
  identity: { productId: string; surveyId: string; releaseId: string; name: string; modality?: string; dataOrigin?: string; sourceTier?: string };
  conclusion: { status: "complete" | "partial" | "entrypoint-only"; summary: string; coverageAvailable: boolean };
  coverage: { available: boolean; layerId?: string; coverageRole?: "image_extent" | "object_presence" | "footprint_extent"; availableOrders: number[]; overviewOrder?: number; maxOrder?: number; precision: "exact" | "estimated" | "entrypoint-only" | "truncated"; areaDeg2?: number; cellCount?: number; cellCounts?: Record<string, number>; coordinateFrame: string; ordering: string; mocUrl?: string; previewUrl?: string };
  source: { label?: string; url?: string; geometryLabel?: string; geometryUrl?: string; snapshot?: { uri?: string; sha256?: string; sizeBytes?: number }; references?: EvidenceItem[] };
  derivation: { mode?: string; coordinateFrame: string; ordering: string; coverageRole?: "image_extent" | "object_presence" | "footprint_extent"; availableOrders: number[]; steps: Array<{ sequence: number; id: string; title: string; purpose: string; inputs: EvidenceItem[]; method: { libraries: string[]; implementationRef: string }; code?: { language: string; snippet: string; implementationRef: string }; outputs: EvidenceItem[]; status: "available" | "partial" | "unavailable"; reason?: string }> };
  verification: { status: "complete" | "partial" | "entrypoint-only"; checks: Array<{ id: string; label: string; status: "passed" | "warning" | "unavailable"; detail?: string }>; outputHashes: Array<{ kind: string; sha256: string; url?: string }> };
  limitations: string[];
  actions: { official?: ProductLink; query?: ProductLink; data?: ProductLink; view?: ProductLink };
  technicalDownloads: ProductLink[];
  links: ProductLink[];
  evidenceUrl: string;
}

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
  const text = value || (locale() === "zh" ? "暂无已发布内容" : "No published content yet");
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  for (const paragraph of paragraphs.length ? paragraphs : [text]) appendText(section, "p", paragraph, "resource-detail-copy");
  parent.append(section);
}

function localized(value: string, fallback: string): string {
  return locale() === "zh" ? value : fallback;
}

function statusLabelFor(status: string): string {
  if (locale() === "zh") return status === "complete" ? "证据链完整" : status === "partial" ? "覆盖可用，证据部分缺失" : "只有官方入口";
  return status === "complete" ? "Evidence chain complete" : status === "partial" ? "Coverage available; evidence is partial" : "Official entry point only";
}

function formatOrders(orders?: number[]): string {
  if (!orders?.length) return localized("未发布", "not published");
  const values = [...new Set(orders)].sort((left, right) => left - right).map((order) => `O${order}`);
  return values.join(localized("、", ", "));
}

function coverageRoleLabel(role?: ProductDossier["coverage"]["coverageRole"]): string {
  if (locale() === "zh") return role === "image_extent" ? "图像范围" : role === "object_presence" ? "目标存在" : role === "footprint_extent" ? "巡天脚印" : "未声明";
  return role === "image_extent" ? "Image extent" : role === "object_presence" ? "Object presence" : role === "footprint_extent" ? "Survey footprint" : "Not declared";
}

function precisionLabel(value: ProductDossier["coverage"]["precision"]): string {
  if (locale() === "zh") return value === "exact" ? "精确" : value === "estimated" ? "估算" : value === "truncated" ? "截断" : "只有入口";
  return value;
}

function evidenceItemStatus(item: EvidenceItem): string {
  if (item.visibility === "unavailable") return localized("不可用", "Unavailable");
  if (item.visibility === "evidence-only") return localized("受控证据", "Controlled evidence");
  return localized("公开", "Public");
}

function renderEvidenceItems(parent: HTMLElement, items: EvidenceItem[], emptyLabel = localized("没有可展示的证据。", "No evidence is published for this step.")): void {
  if (!items.length) {
    appendText(parent, "p", emptyLabel, "resource-evidence-empty");
    return;
  }
  const list = document.createElement("div");
  list.className = "resource-evidence-items";
  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = "resource-evidence-item";
    row.dataset.visibility = item.visibility;
    const heading = document.createElement("div");
    heading.className = "resource-evidence-item-heading";
    appendText(heading, "strong", item.label);
    appendText(heading, "span", evidenceItemStatus(item), "resource-evidence-item-status");
    row.append(heading);
    appendText(row, "p", item.description, "resource-evidence-item-description");
    if (item.filename) appendText(row, "code", item.filename, "resource-evidence-filename");
    if (item.url && item.visibility === "public") {
      const link = document.createElement("a");
      link.className = "resource-link resource-evidence-item-link";
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = item.filename ? localized("下载这个制品", "Download this artifact") : localized("打开这个来源", "Open this source");
      row.append(link);
    }
    if (item.sha256) appendText(row, "small", `SHA-256 ${item.sha256}`, "resource-evidence-hash");
    if (item.reason) appendText(row, "small", item.reason, "resource-evidence-reason");
    list.append(row);
  });
  parent.append(list);
}

function renderLinkGroup(parent: HTMLElement, title: string, links: ProductLink[], emptyLabel?: string): void {
  if (!links.length && !emptyLabel) return;
  const section = document.createElement("section");
  section.className = "resource-link-group";
  appendText(section, "h4", title);
  if (!links.length) {
    appendText(section, "p", emptyLabel!, "resource-link-empty");
    parent.append(section);
    return;
  }
  const list = document.createElement("div");
  list.className = "resource-link-list";
  links.forEach((action) => {
    const item = document.createElement("div");
    item.className = "resource-link-item";
    const link = document.createElement("a");
    link.className = "resource-link";
    link.href = action.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = action.label;
    item.append(link);
    if (action.description) appendText(item, "p", action.description, "resource-link-description");
    if (action.sha256) appendText(item, "small", `SHA-256 ${action.sha256}`, "resource-link-meta");
    list.append(item);
  });
  section.append(list);
  parent.append(section);
}

function renderDossier(parent: HTMLElement, dossier: ProductDossier): void {
  const conclusion = document.createElement("section");
  conclusion.className = "resource-conclusion";
  const status = document.createElement("span");
  status.className = "resource-evidence-status";
  status.dataset.status = dossier.conclusion.status;
  status.textContent = statusLabelFor(dossier.conclusion.status);
  appendText(conclusion, "p", localized("产品结论", "PRODUCT CONCLUSION"), "eyebrow");
  appendText(conclusion, "h3", dossier.identity.name);
  appendText(conclusion, "p", dossier.conclusion.summary, "resource-conclusion-copy");
  conclusion.append(status);
  if (dossier.coverage.available) {
    const area = typeof dossier.coverage.areaDeg2 === "number" ? `${dossier.coverage.areaDeg2.toLocaleString(undefined, { maximumFractionDigits: 2 })} deg²` : localized("未计算", "not calculated");
    const role = coverageRoleLabel(dossier.coverage.coverageRole);
    appendText(conclusion, "p", `${localized("覆盖类型", "Coverage type")}: ${role} · ${localized("覆盖面积", "Coverage area")}: ${area}`, "resource-conclusion-coverage");
    const coverage = document.createElement("dl");
    coverage.className = "resource-coverage-summary";
    detailRow(coverage, localized("HEALPix 可用等级", "HEALPix available orders"), formatOrders(dossier.coverage.availableOrders));
    detailRow(coverage, localized("网站预览等级", "Website preview order"), dossier.coverage.overviewOrder === undefined ? localized("未发布", "not published") : `O${dossier.coverage.overviewOrder}`);
    detailRow(coverage, localized("坐标", "Coordinates"), `${dossier.coverage.coordinateFrame} / ${dossier.coverage.ordering}`);
    detailRow(coverage, localized("空间精度", "Spatial precision"), precisionLabel(dossier.coverage.precision));
    conclusion.append(coverage);
  }
  parent.append(conclusion);

  const actions = document.createElement("div");
  actions.className = "resource-dossier-actions";
  const nextLinks = [dossier.actions.official, dossier.actions.data, dossier.actions.query].filter((action): action is ProductLink => Boolean(action));
  const viewLinks = [dossier.actions.view, ...dossier.links.filter((link) => link.kind === "coverage-preview" && link.url !== dossier.actions.view?.url)].filter((action): action is ProductLink => Boolean(action));
  const artifactLinks = dossier.links.filter((link) => ["fits-moc", "resource-package", "provenance"].includes(link.kind));
  renderLinkGroup(actions, localized("下一站", "NEXT STOP"), nextLinks, localized("没有单独声明的官方数据或查询地址。", "No separate official data or query URL was declared."));
  renderLinkGroup(actions, localized("查看覆盖", "VIEW COVERAGE"), viewLinks, localized("没有公开覆盖预览。", "No public coverage preview is available."));
  renderLinkGroup(actions, localized("复核制品", "VERIFY ARTIFACTS"), artifactLinks, localized("没有公开下载制品。", "No public artifacts are available."));
  if (actions.childElementCount) parent.append(actions);

  const source = document.createElement("section");
  source.className = "resource-detail-section resource-source-card";
  appendText(source, "h3", localized("来源与输入", "SOURCE AND INPUT"));
  if (dossier.source.label) appendText(source, "strong", dossier.source.label);
  renderEvidenceItems(source, dossier.source.references ?? (dossier.source.url ? [{ kind: "official-release", label: localized("官方发布入口", "Official release"), description: localized("产品版本与访问导航。", "Product release and navigation entrypoint."), visibility: "public", url: dossier.source.url }] : []));
  if (dossier.source.snapshot?.sha256) appendText(source, "small", `${localized("输入快照 SHA-256", "Input snapshot SHA-256")}: ${dossier.source.snapshot.sha256}`, "resource-hash");
  parent.append(source);

  const derivation = document.createElement("section");
  derivation.className = "resource-detail-section";
  appendText(derivation, "h3", localized("它是怎样得出的？", "HOW IT WAS DERIVED"));
  const stages = document.createElement("ol"); stages.className = "resource-dossier-stages";
  dossier.derivation.steps.forEach((stage) => {
    const item = document.createElement("li");
    appendText(item, "b", String(stage.sequence).padStart(2, "0"), "resource-stage-number");
    const copy = document.createElement("div");
    copy.className = "resource-stage-copy";
    const heading = document.createElement("div"); heading.className = "resource-stage-heading";
    appendText(heading, "strong", stage.title);
    const stageStatus = appendText(heading, "span", stage.status === "available" ? localized("已提供", "Available") : stage.status === "partial" ? localized("部分提供", "Partial") : localized("不可用", "Unavailable"), "resource-stage-status");
    stageStatus.dataset.status = stage.status;
    copy.append(heading);
    appendText(copy, "p", stage.purpose, "resource-stage-explanation");
    appendText(copy, "small", `${localized("库", "Libraries")}: ${stage.method.libraries.join(", ")} · ${localized("实现", "Implementation")}: ${stage.method.implementationRef}`, "resource-stage-method");
    if (stage.inputs.length) {
      appendText(copy, "h5", localized("输入证据", "INPUT EVIDENCE"), "resource-stage-subheading");
      renderEvidenceItems(copy, stage.inputs);
    }
    if (stage.code) {
      const details = document.createElement("details"); details.className = "resource-stage-code";
      appendText(details, "summary", localized(`查看实际代码（${stage.code.language}）`, `View implementation code (${stage.code.language})`));
      appendText(details, "small", stage.code.implementationRef, "resource-stage-code-ref");
      const code = document.createElement("pre"); code.textContent = stage.code.snippet; details.append(code); copy.append(details);
    }
    appendText(copy, "h5", localized("输出制品", "OUTPUT ARTIFACTS"), "resource-stage-subheading");
    renderEvidenceItems(copy, stage.outputs);
    if (stage.reason) appendText(copy, "p", stage.reason, "resource-stage-reason");
    item.append(copy); stages.append(item);
  });
  derivation.append(stages); parent.append(derivation);

  const verification = document.createElement("section"); verification.className = "resource-detail-section";
  appendText(verification, "h3", localized("为什么可以相信？", "WHY TRUST IT"));
  const checks = document.createElement("div"); checks.className = "resource-check-list";
  dossier.verification.checks.forEach((check) => {
    const row = document.createElement("div"); row.className = "resource-check"; row.dataset.status = check.status;
    appendText(row, "strong", check.status === "passed" ? "✓" : check.status === "unavailable" ? "—" : "!");
    appendText(row, "span", check.label); if (check.detail) appendText(row, "small", check.detail); checks.append(row);
  });
  verification.append(checks);
  if (dossier.verification.outputHashes.length) {
    const hashDetails = document.createElement("details"); appendText(hashDetails, "summary", localized("查看输出文件和 SHA-256", "Output files and SHA-256"));
    const list = document.createElement("ul"); list.className = "resource-hash-list";
    dossier.verification.outputHashes.forEach((hash) => {
      const item = document.createElement("li");
      appendText(item, "strong", hash.kind);
      appendText(item, "code", `SHA-256 ${hash.sha256}`);
      if (hash.url) { const link = document.createElement("a"); link.href = hash.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = localized("下载", "Download"); item.append(link); }
      list.append(item);
    }); hashDetails.append(list); verification.append(hashDetails);
  }
  parent.append(verification);

  if (dossier.limitations.length) {
    const limitations = document.createElement("section"); limitations.className = "resource-detail-section resource-limitations";
    appendText(limitations, "h3", localized("边界和局限", "LIMITATIONS"));
    const list = document.createElement("ul"); dossier.limitations.forEach((item) => appendText(list, "li", item)); limitations.append(list); parent.append(limitations);
  }
  if (dossier.technicalDownloads.length) {
    const technical = document.createElement("details"); technical.className = "resource-detail-section resource-technical";
    appendText(technical, "summary", localized("开发者下载和原始制品", "Developer downloads and raw artifacts"));
    const list = document.createElement("div"); list.className = "resource-detail-downloads";
    dossier.technicalDownloads.forEach((asset) => { const row = document.createElement("div"); row.className = "resource-detail-download"; const link = document.createElement("a"); link.href = asset.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = asset.label; row.append(link); appendText(row, "small", `${asset.mediaType ?? ""}${asset.sizeBytes ? ` · ${asset.sizeBytes.toLocaleString()} bytes` : ""}${asset.sha256 ? ` · SHA-256 ${asset.sha256}` : ""}`); list.append(row); });
    technical.append(list); parent.append(technical);
  }
}

function localeWord(word: "releases" | "products" | "view"): string {
  if (locale() === "zh") return word === "releases" ? "个 release" : word === "products" ? "个产品" : "查看";
  return word === "view" ? "View" : word;
}

async function openProduct(survey: Survey, release: Release, catalogProduct: Product, record?: PublishedProduct): Promise<void> {
  const dialog = byId<HTMLDialogElement>("product-dialog");
  const content = byId("product-dialog-content");
  content.replaceChildren();
  byId("product-dialog-title").textContent = `${survey.name} · ${release.label} · ${catalogProduct.name}`;
  let dossier: ProductDossier | undefined;
  const productId = catalogProduct.productId ?? productKey(survey.id, release.id, catalogProduct);
  try {
    const response = await fetch(`/api/v1/products/${encodeURIComponent(productId)}`, { headers: { Accept: "application/json" } });
    if (response.ok) dossier = await response.json() as ProductDossier;
  } catch { /* the catalog remains useful when detail evidence is unavailable */ }
  if (dossier) renderDossier(content, dossier);
  else {
    const fallback = document.createElement("section"); fallback.className = "resource-conclusion";
    appendText(fallback, "p", localized("产品目录", "PRODUCT CATALOG"), "eyebrow");
    appendText(fallback, "h3", catalogProduct.name);
    appendText(fallback, "p", catalogProduct.description ?? localized("该产品已登记，但详细证据仍在整理。", "This product is registered; detailed evidence is still being prepared."), "resource-conclusion-copy");
    const fallbackStatus = catalogProduct.status === "acquired" ? "partial" : "entrypoint-only";
    const status = document.createElement("span"); status.className = "resource-evidence-status"; status.dataset.status = fallbackStatus; status.textContent = statusLabelFor(fallbackStatus); fallback.append(status); content.append(fallback);
    const meta = document.createElement("dl"); meta.className = "resource-detail-meta";
    detailRow(meta, localized("巡天 / 发布", "SURVEY / RELEASE"), `${survey.id} / ${release.id}`);
    detailRow(meta, localized("波段/类型", "MODALITY"), catalogProduct.modality);
    detailRow(meta, localized("HEALPix 阶数", "HEALPIX ORDER"), orderText(catalogProduct.coverage?.availableOrders)); content.append(meta);
    const sourceUrl = catalogProduct.sourceUrl;
    if (sourceUrl) { const action = document.createElement("a"); action.className = "command-button"; action.href = sourceUrl; action.target = "_blank"; action.rel = "noreferrer"; action.textContent = localized("前往官方来源", "Open official source"); content.append(action); }
  }
  if (!dialog.open) dialog.showModal();
  const basePath = window.location.pathname.startsWith("/surveys") ? "/surveys/" : "/resources/";
  history.replaceState(null, "", `${basePath}#product=${encodeURIComponent(productId)}`);
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
  createIcons({ icons: { ArrowLeft, ExternalLink, FileCode2, GitBranch, Home, Search, Telescope, X }, attrs: { "aria-hidden": "true" } });
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
