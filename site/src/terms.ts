import { Search, createIcons } from "lucide";

import { locale, mountLocaleControls, t } from "./i18n.js";
import { mountSiteChrome as mountChrome } from "./site-chrome.js";
import "./public.css";

type Localized = { en: string; zh: string };
type TermGroup = "asa" | "spatial" | "execution" | "surfaces";

interface Term {
  id: string;
  group: TermGroup;
  name: Localized;
  aliases: string[];
  origin: "ASA" | "STANDARD";
  definition: Localized;
  detail: Localized;
}

const groups: Record<TermGroup, Localized> = {
  asa: { en: "ASA concepts", zh: "ASA 概念" },
  spatial: { en: "Spatial contract", zh: "空间契约" },
  execution: { en: "Execution and lookup", zh: "执行与反查" },
  surfaces: { en: "Data surfaces", zh: "数据平面" },
};

const terms: readonly Term[] = [
  {
    id: "asa",
    group: "asa",
    name: { en: "ASA", zh: "ASA" },
    aliases: ["Astro Survey Atlas", "Atlas"],
    origin: "ASA",
    definition: { en: "Astro Survey Atlas, the public catalog and spatial index for survey data.", zh: "Astro Survey Atlas，面向巡天数据的公共目录与空间索引。" },
    detail: { en: "Assets is the public release surface of ASA; Warehouse executes scans and Workspace owns user data.", zh: "Assets 是 ASA 的公共发布平面；Warehouse 执行扫描，Workspace 管理用户数据。" },
  },
  {
    id: "assets",
    group: "asa",
    name: { en: "Assets", zh: "Assets" },
    aliases: ["public release", "catalog"],
    origin: "ASA",
    definition: { en: "The public release service that publishes catalog, coverage, MOCs, evidence links and packages.", zh: "发布目录、覆盖、MOC、证据链接和资源包的公共发布服务。" },
    detail: { en: "Assets does not own Warehouse execution state or private Workspace records.", zh: "Assets 不拥有 Warehouse 的执行状态，也不保存 Workspace 的私有记录。" },
  },
  {
    id: "resource-package",
    group: "asa",
    name: { en: "Resource Package", zh: "Resource Package（资源包）" },
    aliases: ["v3", "package", "offline bundle"],
    origin: "ASA",
    definition: { en: "An immutable archive that groups verified MOCs, projections, metadata and provenance for offline use.", zh: "将经过验证的 MOC、投影、元数据和 provenance 组合成不可变离线归档。" },
    detail: { en: "The current public contract is Resource Package v3; its files retain release hashes and coordinate semantics.", zh: "当前公共契约是 Resource Package v3；其中保留发布哈希与坐标语义。" },
  },
  {
    id: "file-asset",
    group: "asa",
    name: { en: "FileAsset", zh: "FileAsset（文件资产）" },
    aliases: ["file", "source file", "ast_file_index_v1"],
    origin: "ASA",
    definition: { en: "A warehouse-indexed file with a locator, metadata and the coverage cells it contributes.", zh: "由 Warehouse 建立索引的文件，带有定位地址、元数据和它贡献的覆盖像元。" },
    detail: { en: "A source URI may be HTTP(S), object storage or a local hint; only public HTTP(S) is a direct browser download.", zh: "源 URI 可以是 HTTP(S)、对象存储或本地提示；只有公共 HTTP(S) 可直接由浏览器下载。" },
  },
  {
    id: "source-unit",
    group: "asa",
    name: { en: "SourceUnit", zh: "SourceUnit（源单元）" },
    aliases: ["tile", "brick", "source unit"],
    origin: "ASA",
    definition: { en: "The smallest source-level unit used to explain a coverage edge, such as a tile, brick or catalog slice.", zh: "用于解释覆盖边的最小源级单元，例如 tile、brick 或目录切片。" },
    detail: { en: "SourceUnit keeps reverse lookup tied to the actual file and its WCS or tile metadata.", zh: "SourceUnit 让反向查找始终关联到真实文件及其 WCS 或 tile 元数据。" },
  },
  {
    id: "evidence",
    group: "asa",
    name: { en: "Evidence", zh: "Evidence（证据）" },
    aliases: ["evidence-only", "snapshot", "provenance"],
    origin: "ASA",
    definition: { en: "The auditable inputs, scan snapshots, checks and hashes behind a public result.", zh: "公共结果背后可审计的输入、扫描快照、检查结果与哈希。" },
    detail: { en: "Evidence is downloadable and reviewable, but it is kept off the browser's initial catalog request.", zh: "Evidence 可以下载和复核，但不会放进浏览器的初始目录请求。" },
  },
  {
    id: "coverage-layer",
    group: "spatial",
    name: { en: "Coverage Layer", zh: "Coverage Layer（覆盖图层）" },
    aliases: ["layer", "footprint", "coverage catalog"],
    origin: "ASA",
    definition: { en: "A published survey, release and product footprint with explicit HEALPix orders and precision.", zh: "带有明确 HEALPix order 与精度的巡天、Release 和产品覆盖脚印。" },
    detail: { en: "A layer can publish an overview order and a finer query order only when both were actually produced.", zh: "只有源数据确实生成了更细 order，图层才会同时发布 overview order 和 query order。" },
  },
  {
    id: "coverage-edge",
    group: "spatial",
    name: { en: "Coverage Edge", zh: "Coverage Edge（覆盖边）" },
    aliases: ["coverage_edges.parquet", "edge", "file coverage"],
    origin: "ASA",
    definition: { en: "The link between a published HEALPix cell and the source file or unit that covers it.", zh: "把已发布 HEALPix 像元连接到覆盖它的源文件或源单元的关系。" },
    detail: { en: "Coverage edges are the reconstruction source for reverse lookup and download plans.", zh: "Coverage Edge 是反向查找与下载计划的重建依据。" },
  },
  {
    id: "moc",
    group: "spatial",
    name: { en: "MOC", zh: "MOC" },
    aliases: ["Multi-Order Coverage", "FITS MOC"],
    origin: "STANDARD",
    definition: { en: "A Multi-Order Coverage map: a compact set of HEALPix cells describing a region on the sky.", zh: "Multi-Order Coverage map，用一组 HEALPix 像元紧凑表达天空区域。" },
    detail: { en: "ASA publishes native FITS MOCs alongside fixed-order query and preview projections.", zh: "ASA 同时发布原生 FITS MOC，以及固定 order 的 query 和 preview 投影。" },
  },
  {
    id: "healpix",
    group: "spatial",
    name: { en: "HEALPix", zh: "HEALPix" },
    aliases: ["pixel", "order", "nside", "ipix"],
    origin: "STANDARD",
    definition: { en: "Hierarchical equal-area pixels used as the common spatial language for coverage.", zh: "用于表达覆盖范围的分层等面积像元体系。" },
    detail: { en: "Order determines resolution; NSIDE is 2^order, and every result keeps its actual order explicit.", zh: "order 决定分辨率；NSIDE 等于 2^order，每个结果都会明确保留真实 order。" },
  },
  {
    id: "icrs",
    group: "spatial",
    name: { en: "ICRS", zh: "ICRS" },
    aliases: ["coordinate frame", "coordinates"],
    origin: "STANDARD",
    definition: { en: "The celestial reference frame used by the public coverage contract.", zh: "公共覆盖契约使用的天球参考坐标系。" },
    detail: { en: "Inputs are validated as ICRS before geometry is rasterized or published.", zh: "输入会先验证为 ICRS，再进行几何栅格化和发布。" },
  },
  {
    id: "nested",
    group: "spatial",
    name: { en: "NESTED", zh: "NESTED" },
    aliases: ["ordering", "HEALPix ordering"],
    origin: "STANDARD",
    definition: { en: "The hierarchical HEALPix indexing order used by ASA cells and APIs.", zh: "ASA 像元和 API 使用的分层 HEALPix 索引顺序。" },
    detail: { en: "It must be read together with order and nside; it is not interchangeable with RING ordering.", zh: "它必须与 order 和 nside 一起读取，不能与 RING 顺序混用。" },
  },
  {
    id: "precision",
    group: "spatial",
    name: { en: "Precision state", zh: "Precision（精度状态）" },
    aliases: ["exact", "estimated", "entrypoint-only", "truncated"],
    origin: "ASA",
    definition: { en: "A label explaining whether a coverage or lookup result is exact, estimated, entrypoint-only or truncated.", zh: "说明覆盖或查找结果属于 exact、estimated、entrypoint-only 还是 truncated 的标签。" },
    detail: { en: "Precision is part of the response contract; a preview is never silently promoted to a finer order.", zh: "精度是响应契约的一部分；preview 不会被静默提升为更细 order。" },
  },
  {
    id: "scan-plan",
    group: "execution",
    name: { en: "ScanPlan", zh: "ScanPlan" },
    aliases: ["scan plan", "bounded scan", "v2"],
    origin: "ASA",
    definition: { en: "A bounded, reproducible description of what Warehouse should enumerate and spatially extract.", zh: "描述 Warehouse 应枚举哪些输入并提取空间信息的有界、可复现计划。" },
    detail: { en: "Assets submits standard public ScanPlan tasks; Warehouse owns execution and status.", zh: "Assets 提交标准公共 ScanPlan 任务；Warehouse 负责执行和状态。" },
  },
  {
    id: "scan-request",
    group: "execution",
    name: { en: "ScanRequest", zh: "ScanRequest" },
    aliases: ["request", "namespace-local"],
    origin: "ASA",
    definition: { en: "A request envelope that asks Warehouse to run a ScanPlan in an owning namespace.", zh: "请求 Warehouse 在所属 namespace 中运行 ScanPlan 的请求封装。" },
    detail: { en: "Workspace may submit a namespace-local request; it does not transfer ownership of user data to Assets.", zh: "Workspace 可以提交 namespace-local 请求，但不会把用户数据所有权转移给 Assets。" },
  },
  {
    id: "warehouse",
    group: "execution",
    name: { en: "Warehouse", zh: "Warehouse" },
    aliases: ["scanner", "operator", "execution layer"],
    origin: "ASA",
    definition: { en: "The execution and current-state service for enumeration, scans, file indices, coverage indices and evidence.", zh: "负责枚举、扫描、文件索引、覆盖索引和证据的执行与当前状态服务。" },
    detail: { en: "Warehouse serves both Assets' public coverage jobs and Workspace's optional user scans.", zh: "Warehouse 同时服务 Assets 的公共覆盖任务和 Workspace 的可选用户扫描。" },
  },
  {
    id: "reverse-lookup",
    group: "execution",
    name: { en: "Reverse Lookup", zh: "Reverse Lookup（反向查找）" },
    aliases: ["reverse lookup", "cell lookup", "source lookup"],
    origin: "ASA",
    definition: { en: "The path from selected sky cells back to matching files, tiles and official entrypoints.", zh: "从选中的天空像元反查匹配文件、tile 和官方入口的路径。" },
    detail: { en: "It chooses one common order, reports precision and keeps exact cell matches attached to each source.", zh: "它选择一个共同 order，报告精度，并把精确像元匹配关联到每个源。" },
  },
  {
    id: "download-plan",
    group: "execution",
    name: { en: "Download Plan", zh: "Download Plan（下载计划）" },
    aliases: ["download", "file list", "tile list"],
    origin: "ASA",
    definition: { en: "A file-level and entrypoint-level list produced by reverse lookup for a selected component.", zh: "反向查找针对一个连通区生成的文件级与入口级清单。" },
    detail: { en: "HTTP(S) locators are direct downloads; object-store and local locators remain visible as copyable hints.", zh: "HTTP(S) 定位地址可直接下载；对象存储和本地定位地址保留为可复制提示。" },
  },
  {
    id: "connected-component",
    group: "execution",
    name: { en: "Connected Component", zh: "Connected Component（连通区）" },
    aliases: ["C01", "C02", "overlap component"],
    origin: "ASA",
    definition: { en: "A contiguous region of common HEALPix cells in an overlap result, labelled C01, C02 and so on.", zh: "重合结果中由共同 HEALPix 像元组成的连续区域，按 C01、C02 等编号。" },
    detail: { en: "Each component has its own coordinates, area, source matches and download plan.", zh: "每个连通区都有独立的坐标、面积、源匹配和下载计划。" },
  },
  {
    id: "workspace",
    group: "surfaces",
    name: { en: "Workspace", zh: "Workspace" },
    aliases: ["user data", "private assets", "workflow"],
    origin: "ASA",
    definition: { en: "The user-data surface for private assets, connectors, local workflows and user MOCs.", zh: "负责私有资产、Connector、本地工作流和用户 MOC 的用户数据平面。" },
    detail: { en: "Workspace can install verified public packages and optionally ask Warehouse to scan its own namespace.", zh: "Workspace 可以安装经过验证的公共资源包，也可以请求 Warehouse 扫描自己的 namespace。" },
  },
  {
    id: "active-ast",
    group: "surfaces",
    name: { en: "ACTIVE AST_*", zh: "ACTIVE AST_*" },
    aliases: ["active layer", "current index"],
    origin: "ASA",
    definition: { en: "The current Warehouse layer and evidence records that Assets is allowed to consume.", zh: "Assets 允许消费的 Warehouse 当前图层与证据记录。" },
    detail: { en: "ACTIVE is a current-state signal, not a replacement for the immutable public release artifacts.", zh: "ACTIVE 表示当前状态，不替代不可变的公共发布制品。" },
  },
];

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let query = "";

function renderIcons(): void {
  createIcons({ icons: { Search }, attrs: { "aria-hidden": "true" }, root: document.querySelector("main") ?? document.body });
}

function localized(value: Localized): string {
  return value[locale()];
}

function render(): void {
  const host = byId("terms-groups");
  const search = byId<HTMLInputElement>("terms-search");
  const currentLocale = locale();
  const normalized = query.toLocaleLowerCase();
  search.placeholder = t("page.terms.search");
  const filtered = terms.filter((term) => {
    if (!normalized) return true;
    return [term.name.en, term.name.zh, term.definition.en, term.definition.zh, term.detail.en, term.detail.zh, ...term.aliases]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalized);
  });
  byId("terms-count").textContent = `${filtered.length} ${currentLocale === "zh" ? "个术语" : "terms"}`;
  host.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "terms-empty";
    empty.textContent = t("page.terms.empty");
    host.append(empty);
    renderIcons();
    return;
  }
  (Object.keys(groups) as TermGroup[]).forEach((groupId, index) => {
    const groupTerms = filtered.filter((term) => term.group === groupId);
    if (!groupTerms.length) return;
    const section = document.createElement("section");
    section.className = "terms-group";
    section.id = `terms-${groupId}`;
    const heading = document.createElement("div");
    heading.className = "terms-group-heading";
    const kicker = document.createElement("p");
    kicker.className = "public-kicker";
    kicker.textContent = localized(groups[groupId]);
    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");
    heading.append(kicker, number);
    const grid = document.createElement("div");
    grid.className = "terms-grid";
    groupTerms.forEach((term) => {
      const card = document.createElement("article");
      card.className = "term-card";
      card.id = `term-${term.id}`;
      const top = document.createElement("div");
      top.className = "term-card-top";
      const title = document.createElement("h3");
      title.textContent = localized(term.name);
      const origin = document.createElement("span");
      origin.className = "term-origin";
      origin.dataset.origin = term.origin.toLowerCase();
      origin.textContent = term.origin;
      top.append(title, origin);
      const english = document.createElement("p");
      english.className = "term-definition";
      const enLabel = document.createElement("b");
      enLabel.textContent = "EN";
      english.append(enLabel, document.createTextNode(term.definition.en));
      const chinese = document.createElement("p");
      chinese.className = "term-definition term-definition-zh";
      const zhLabel = document.createElement("b");
      zhLabel.textContent = "中";
      chinese.append(zhLabel, document.createTextNode(term.definition.zh));
      const detail = document.createElement("p");
      detail.className = "term-detail";
      detail.textContent = localized(term.detail);
      const aliases = document.createElement("div");
      aliases.className = "term-aliases";
      aliases.textContent = term.aliases.join(" · ");
      card.append(top, english, chinese, detail, aliases);
      grid.append(card);
    });
    section.append(heading, grid);
    host.append(section);
  });
  renderIcons();
}

mountLocaleControls();
mountChrome();
byId<HTMLInputElement>("terms-search").addEventListener("input", (event) => {
  query = (event.currentTarget as HTMLInputElement).value.trim();
  render();
});
window.addEventListener("atlas:locale-change", render);
render();
