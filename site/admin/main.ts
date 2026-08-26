import { ArrowLeft, Eye, LogOut, Pencil, Plus, RefreshCw, RotateCw, RotateCcw, Send, ShieldCheck, Unlock, Upload, createIcons } from "lucide";
import "./styles.css";
import { mountLocaleControls, t } from "../src/i18n.js";

mountLocaleControls();

type ConnectorType = "s3" | "oss" | "local";
interface BusinessProfile { id: string; label: string; modality: string; mode: string; layerId: string; surveyId: string; releaseId: string; product: string; coverageRole: string; dataOrigin: string; sourceTier: string; allowedSuffixes: string; maxOrder: number; raColumn?: string; decColumn?: string; expectedPrecision: string; acceptance: string }
interface AdminConfig { enabled: boolean; authRequired: boolean; namespace: string; kubernetesConfigured: boolean; capabilities: { coverageModes: string[]; businessModalities?: string[]; businessModalityProfiles?: BusinessProfile[]; connectorTypes: ConnectorType[]; backends: string[]; scanRequestApiVersion?: string } }
interface Connector { name: string; type: ConnectorType; endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKeyConfigured?: boolean; pvcName?: string; localPath?: string; phase?: string; message?: string; createdAt?: string }
interface TaskStatus { phase: string; reason?: string; backend?: string; runId?: string; discoveredFiles?: number; processedHdus?: number; coverageDocuments?: number; objectDocuments?: number; errorCount?: number; availableOrders?: number[]; evidencePath?: string; sourceSnapshot?: { uri?: string; sha256: string; sizeBytes?: number }; startedAt?: string; completedAt?: string; message?: string }
interface Task { name: string; createdAt?: string; layerId?: string; surveyId?: string; releaseId?: string; product?: string; productId?: string; modality?: string; mode?: string; backend?: string; sourceConnector?: string; sourcePaths: string[]; tags: string[]; batchId?: string; recipe?: { mode?: string; outputOrder?: number; catalog?: Record<string, unknown> }; status: TaskStatus }
interface Product { productId: string; draft: { productId: string; surveyId: string; releaseId: string; name: string; modality?: string; layerId?: string; mode?: string; coverageRole?: string; dataOrigin?: string; sourceTier?: string; scanDefaults?: { allowedSuffixes?: string; maxOrder?: number; raColumn?: string; decColumn?: string; healpixColumn?: string; healpixOrderColumn?: string; healpixOrder?: number }; recipeVersion?: number; recipeHash?: string; coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number }; presentation: { summaryMarkdown: string; methodologyMarkdown: string; limitationsMarkdown: string; flow: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } } }; published: unknown; revision: number; publishedRevision: number | null; updatedAt: string; publishedAt: string | null; coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number } }
interface CatalogStatus { mode: string; loadedAt: string; layers: number; footprints: number; warehouseConfigured: boolean }

const tokenKey = "astro-survey-atlas-assets.admin-token";
let adminConfig: AdminConfig | null = null;
let token = sessionStorage.getItem(tokenKey) ?? "";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};

function renderIcons(): void {
  createIcons({ icons: { ArrowLeft, Eye, LogOut, Pencil, Plus, RefreshCw, RotateCw, RotateCcw, Send, ShieldCheck, Unlock, Upload }, attrs: { "aria-hidden": "true" } });
}

function escapeText(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

function toast(message: string, error = false): void {
  const element = byId("admin-toast");
  element.textContent = message;
  element.dataset.error = error ? "true" : "false";
  element.dataset.visible = "true";
  window.setTimeout(() => { element.dataset.visible = "false"; }, 2400);
}

function setMessage(kind: "connector" | "task" | "product", message: string, error = false): void {
  const element = document.querySelector<HTMLElement>(`[data-form-message="${kind}"]`);
  if (!element) return;
  element.textContent = message;
  element.dataset.error = error ? "true" : "false";
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    if (response.status === 401) showLogin("管理员令牌无效");
    throw new Error(body.error || `请求失败（${response.status}）`);
  }
  return body;
}

function showLogin(message = ""): void {
  byId("login-panel").hidden = false;
  byId("admin-workspace").hidden = true;
  const error = byId("login-error");
  error.textContent = message;
  error.hidden = !message;
}

function showWorkspace(): void {
  byId("login-panel").hidden = true;
  byId("admin-workspace").hidden = false;
}

function formatDate(value?: string): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function connectorLabel(connector: Connector): string {
  return `${connector.name} · ${connector.type.toUpperCase()}${connector.phase ? ` · ${connector.phase}` : ""}`;
}

function renderConnectors(connectors: Connector[]): void {
  const list = byId("connector-list");
  const source = byId<HTMLSelectElement>("source-connector");
  source.replaceChildren(new Option(connectors.length ? "选择 source connector" : "暂无 source connector", ""), ...connectors.map((connector) => new Option(connectorLabel(connector), connector.name)));
  if (!connectors.length) {
    list.innerHTML = `<div class="resource-empty">暂无 Connector，请先定义一个。</div>`;
    return;
  }
  list.innerHTML = connectors.map((connector) => {
    const type = connector.type === "local" ? "LOCAL" : connector.type.toUpperCase();
    const location = connector.type === "local" ? connector.localPath ?? connector.pvcName ?? "受管本地存储" : `${connector.endpoint ?? ""}${connector.region ? ` · ${connector.region}` : ""}${connector.bucket ? ` · ${connector.bucket}` : ""}${connector.prefix ? ` / ${connector.prefix}` : ""}`;
    return `<article class="resource-row"><div><strong>${escapeText(connector.name)}</strong><span>${type} · ${escapeText(connector.phase ?? "UNKNOWN")}</span><p>${escapeText(location)}</p></div><code>${escapeText(connector.message ?? "")}</code></article>`;
  }).join("");
}

function phaseClass(phase: string): string {
  return phase.toLowerCase().replace(/[^a-z]+/g, "-");
}

function renderTasks(tasks: Task[]): void {
  const body = byId("task-list");
  if (!tasks.length) {
    body.innerHTML = `<tr><td colspan="7" class="resource-empty">暂无 Assets coverage task</td></tr>`;
    renderModalityMatrix([]);
    return;
  }
  body.innerHTML = tasks.map((task) => {
    const status = task.status ?? { phase: "Pending" };
    const stats = [status.discoveredFiles !== undefined ? `${status.discoveredFiles.toLocaleString()} files` : "--", status.coverageDocuments !== undefined ? `${status.coverageDocuments.toLocaleString()} coverage` : "--", status.errorCount !== undefined ? `${status.errorCount.toLocaleString()} errors` : "--"].join(" · ");
    return `<tr><td><strong>${escapeText(task.name)}</strong><small>${escapeText(task.modality ?? "other")} · ${escapeText(task.recipe?.mode ?? task.mode ?? "--")} · ${escapeText(task.batchId ?? "")}</small></td><td><strong>${escapeText(task.layerId ?? "--")}</strong><small>${escapeText(task.surveyId ?? "")} / ${escapeText(task.releaseId ?? "")}</small></td><td><span>${escapeText(task.sourceConnector ?? "--")}</span><small>${escapeText(task.sourcePaths[0] ?? "")}</small></td><td><span class="task-phase task-phase-${phaseClass(status.phase)}">${escapeText(status.phase)}</span><small>${escapeText(status.reason ?? status.message ?? "")}</small></td><td><span>${escapeText(stats)}</span><small>${status.runId ? `run ${escapeText(status.runId)}` : "run --"}</small></td><td><span>${escapeText(formatDate(status.completedAt ?? status.startedAt ?? task.createdAt))}</span></td><td><div class="task-row-actions"><button type="button" class="admin-quiet" data-task-details="${escapeText(task.name)}" title="查看任务详情"><i data-lucide="eye"></i><span>详情</span></button><button type="button" class="admin-quiet" data-task-resubmit="${escapeText(task.name)}" title="重新提交任务"><i data-lucide="rotate-ccw"></i><span>重提</span></button></div></td></tr>`;
  }).join("");
  body.querySelectorAll<HTMLButtonElement>("[data-task-details]").forEach((button) => button.addEventListener("click", () => void openTaskDetails(button.dataset.taskDetails ?? "")));
  body.querySelectorAll<HTMLButtonElement>("[data-task-resubmit]").forEach((button) => button.addEventListener("click", () => void resubmitTask(button.dataset.taskResubmit ?? "")));
  renderIcons();
  renderModalityMatrix(tasks);
}

function renderModalityMatrix(tasks: Task[]): void {
  const profiles = adminConfig?.capabilities.businessModalityProfiles ?? [];
  const container = byId("modality-matrix");
  container.innerHTML = profiles.map((profile) => {
    const matches = tasks.filter((task) => task.modality === profile.modality);
    const latest = matches[0];
    const phase = latest?.status.phase ?? "NOT RUN";
    return `<article class="modality-row"><div><strong>${escapeText(profile.modality.toUpperCase())}</strong><span>${escapeText(profile.label)} · ${escapeText(profile.mode)}</span></div><div><span class="task-phase task-phase-${phaseClass(phase)}">${escapeText(phase)}</span><small>${escapeText(latest ? `${latest.name} · ${latest.status.coverageDocuments ?? 0} coverage · ${latest.status.errorCount ?? 0} errors` : `${profile.expectedPrecision} · ${profile.acceptance}`)}</small></div></article>`;
  }).join("");
}

function detailValue(label: string, value: unknown): string {
  return `<div class="task-detail-field"><dt>${escapeText(label)}</dt><dd>${escapeText(value ?? "--")}</dd></div>`;
}

async function openTaskDetails(name: string): Promise<void> {
  try {
    const response = await api<{ task: Task }>(`/api/v1/admin/tasks/${encodeURIComponent(name)}`);
    const task = response.task;
    const status = task.status ?? { phase: "Pending" };
    byId("task-detail-title").textContent = task.name;
    byId("task-detail-content").innerHTML = `<dl class="task-detail-grid">${detailValue("phase", status.phase)}${detailValue("reason", status.reason)}${detailValue("message", status.message)}${detailValue("layer", task.layerId)}${detailValue("modality", task.modality)}${detailValue("recipe", task.recipe?.mode ?? task.mode)}${detailValue("available orders", status.availableOrders?.map((order) => `O${order}`).join(", "))}${detailValue("run ID", status.runId)}${detailValue("files", status.discoveredFiles?.toLocaleString())}${detailValue("processed", status.processedHdus?.toLocaleString())}${detailValue("coverage", status.coverageDocuments?.toLocaleString())}${detailValue("objects", status.objectDocuments?.toLocaleString())}${detailValue("errors", status.errorCount?.toLocaleString())}${detailValue("source snapshot", status.sourceSnapshot ? `${status.sourceSnapshot.sha256}${status.sourceSnapshot.sizeBytes !== undefined ? ` · ${status.sourceSnapshot.sizeBytes} bytes` : ""}${status.sourceSnapshot.uri ? ` · ${status.sourceSnapshot.uri}` : ""}` : undefined)}${detailValue("evidence", status.evidencePath)}${detailValue("started", formatDate(status.startedAt))}${detailValue("completed", formatDate(status.completedAt))}</dl>`;
    byId<HTMLDialogElement>("task-detail-dialog").showModal();
  } catch (error) { toast(error instanceof Error ? error.message : "任务详情加载失败", true); }
}

async function resubmitTask(name: string): Promise<void> {
  try {
    const response = await api<{ task: Task }>(`/api/v1/admin/tasks/${encodeURIComponent(name)}/resubmit`, { method: "POST" });
    toast(`已创建重提任务 ${response.task.name}`);
    await refresh();
  } catch (error) { toast(error instanceof Error ? error.message : "任务重提失败", true); }
}

let productRecords: Product[] = [];
let productQuery = "";
let refreshInFlight: Promise<void> | null = null;
function renderProducts(products: Product[]): void {
  productRecords = products;
  const list = byId("product-list");
  const select = byId<HTMLSelectElement>("task-product");
  select.replaceChildren(new Option("选择 Catalog 产品", ""), ...products.map((product) => new Option(`${product.draft.surveyId.toUpperCase()} · ${product.draft.name}`, product.productId)));
  const filtered = products.filter((product) => {
    if (!productQuery) return true;
    const orders = product.coverage?.availableOrders ?? product.draft.coverage?.availableOrders ?? [];
    return `${product.draft.surveyId} ${product.draft.releaseId} ${product.draft.name} ${product.draft.modality ?? ""} ${product.draft.mode ?? ""} ${orders.map((order) => `O${order}`).join(" ")}`.toLocaleLowerCase().includes(productQuery);
  });
  if (!filtered.length) { list.innerHTML = `<div class="resource-empty">${products.length ? "没有匹配的公共产品" : "暂无 Catalog 产品"}</div>`; return; }
  const grouped = new Map<string, Product[]>();
  filtered.forEach((product) => grouped.set(product.draft.surveyId, [...(grouped.get(product.draft.surveyId) ?? []), product]));
  list.innerHTML = [...grouped.entries()].map(([surveyId, records]) => `<section class="admin-product-survey"><h4>${escapeText(surveyId.toUpperCase())} <small>${records.length} products</small></h4>${records.map((product) => `<article class="product-row"><strong>${escapeText(product.draft.name)}</strong><small>${escapeText(product.draft.releaseId)} · HEALPix ${(product.coverage?.availableOrders ?? product.draft.coverage?.availableOrders ?? []).map((order) => `O${order}`).join(" / ") || "--"} · rev ${product.revision}${product.publishedRevision ? ` · published ${product.publishedRevision}` : " · 草稿"}</small><div class="product-row-actions"><button type="button" data-edit-product="${escapeText(product.productId)}" title="编辑产品"><i data-lucide="pencil"></i><span>编辑</span></button><button type="button" data-publish-product="${escapeText(product.productId)}" data-publish title="发布产品"><i data-lucide="upload"></i><span>发布</span></button></div></article>`).join("")}</section>`).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-edit-product]").forEach((button) => button.addEventListener("click", () => openProduct(button.dataset.editProduct ?? "")));
  list.querySelectorAll<HTMLButtonElement>("[data-publish-product]").forEach((button) => button.addEventListener("click", () => void publishProduct(button.dataset.publishProduct ?? "")));
  renderIcons();
}

function renderProductLoadError(message: string): void {
  const select = byId<HTMLSelectElement>("task-product");
  select.replaceChildren(new Option("Catalog 产品加载失败", ""));
  byId("product-list").innerHTML = `<div class="resource-empty">${escapeText(message)}</div>`;
  productRecords = [];
}

function renderBusinessProfiles(): void {
  const profiles = adminConfig?.capabilities.businessModalityProfiles ?? [];
  const select = byId<HTMLSelectElement>("task-profile");
  select.replaceChildren(new Option(profiles.length ? "选择 admin-only profile" : "暂无验收 profile", ""), ...profiles.map((profile) => new Option(`${profile.modality.toUpperCase()} · ${profile.label}`, profile.id)));
}

function setExtractionFields(mode?: string): void {
  for (const [selector, visible] of [["[data-catalog-radec]", mode === "catalog-radec"], ["[data-catalog-healpix]", mode === "nested-healpix"]] as const) {
    const section = document.querySelector<HTMLElement>(selector);
    if (!section) continue;
    section.hidden = !visible;
    section.querySelectorAll<HTMLInputElement>("input").forEach((field) => {
      field.disabled = !visible;
      field.required = visible && (field.name === "raColumn" || field.name === "decColumn" || field.name === "healpixColumn");
    });
  }
}

function setTaskSubmitEnabled(enabled: boolean): void {
  const submit = byId<HTMLFormElement>("task-form").querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = !enabled;
}

function setDerivedProduct(productId: string): void {
  const product = productRecords.find((entry) => entry.productId === productId);
  const output = byId("task-derived-summary");
  if (product) byId<HTMLSelectElement>("task-profile").value = "";
  if (!product) {
    output.textContent = "选择 Catalog 产品或四模态验收 profile。";
    setExtractionFields();
    setTaskSubmitEnabled(Boolean(byId<HTMLSelectElement>("task-profile").value));
    return;
  }
  const executable = Boolean(product.draft.layerId && product.draft.mode && product.draft.coverageRole && product.draft.dataOrigin && product.draft.sourceTier);
  output.textContent = `${product.draft.surveyId.toUpperCase()} / ${product.draft.releaseId} · ${product.draft.layerId ?? "未注册 layer"} · ${product.draft.modality ?? "other"} / ${product.draft.mode ?? "待 recipe"} · ${product.draft.coverageRole ?? "待 recipe"} · ${executable ? "READY" : "NOT EXECUTABLE"}`;
  const mode = product.draft.mode;
  setExtractionFields(mode);
  const taskForm = byId<HTMLFormElement>("task-form");
  const defaults = product.draft.scanDefaults ?? {};
  for (const [name, value] of Object.entries(defaults)) {
    const field = taskForm.elements.namedItem(name);
    if (field instanceof HTMLInputElement && value !== undefined) field.value = String(value);
  }
  setTaskSubmitEnabled(executable);
}

function setDerivedProfile(profileId: string): void {
  const profile = adminConfig?.capabilities.businessModalityProfiles?.find((entry) => entry.id === profileId);
  if (profile) byId<HTMLSelectElement>("task-product").value = "";
  if (!profile) {
    setDerivedProduct(byId<HTMLSelectElement>("task-product").value);
    return;
  }
  byId("task-derived-summary").textContent = `${profile.modality.toUpperCase()} · ${profile.surveyId.toUpperCase()} / ${profile.releaseId} · ${profile.layerId} · ${profile.mode} · ${profile.expectedPrecision} · READY`;
  setExtractionFields(profile.mode);
  const form = byId<HTMLFormElement>("task-form");
  for (const [name, value] of Object.entries({ allowedSuffixes: profile.allowedSuffixes, maxOrder: profile.maxOrder, raColumn: profile.raColumn, decColumn: profile.decColumn })) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement && value !== undefined) field.value = String(value);
  }
  setTaskSubmitEnabled(true);
}

function openProduct(productId: string): void {
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product) return;
  const form = byId<HTMLFormElement>("product-form");
  (form.elements.namedItem("productId") as HTMLInputElement).value = productId;
  (form.elements.namedItem("summaryMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.summaryMarkdown;
  (form.elements.namedItem("methodologyMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.methodologyMarkdown;
  (form.elements.namedItem("limitationsMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.limitationsMarkdown;
  (form.elements.namedItem("flowNodes") as HTMLTextAreaElement).value = JSON.stringify(product.draft.presentation.flow.nodes, null, 2);
  byId("product-dialog-title").textContent = `${product.draft.name} · 编辑草稿`;
  byId<HTMLDialogElement>("product-dialog").showModal();
}

async function saveProduct(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const product = productRecords.find((entry) => entry.productId === formValue(form, "productId"));
  if (!product) return;
  let nodes: Array<Record<string, unknown>>;
  try { nodes = JSON.parse(formValue(form, "flowNodes")) as Array<Record<string, unknown>>; } catch { setMessage("product", "流程节点 JSON 无效", true); return; }
  const content = { ...product.draft, presentation: { summaryMarkdown: formValue(form, "summaryMarkdown"), methodologyMarkdown: formValue(form, "methodologyMarkdown"), limitationsMarkdown: formValue(form, "limitationsMarkdown"), flow: { nodes, edges: product.draft.presentation.flow.edges } } };
  try { await api(`/api/v1/admin/products/${encodeURIComponent(product.productId)}/draft`, { method: "PUT", body: JSON.stringify({ revision: product.revision, content }) }); byId<HTMLDialogElement>("product-dialog").close(); toast("产品草稿已保存"); await refresh(); } catch (error) { setMessage("product", error instanceof Error ? error.message : "保存失败", true); }
}

async function publishProduct(productId: string): Promise<void> {
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product) return;
  try { await api(`/api/v1/admin/products/${encodeURIComponent(productId)}/publish`, { method: "POST", body: JSON.stringify({ revision: product.revision }) }); toast("产品已发布"); await refresh(); } catch (error) { toast(error instanceof Error ? error.message : "发布失败", true); }
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  const button = byId<HTMLButtonElement>("refresh-button");
  button.disabled = true;
  byId("admin-status").textContent = "REFRESHING…";
  refreshInFlight = (async () => {
  const [connectors, tasks, products, catalogStatus] = await Promise.allSettled([
    api<{ connectors: Connector[] }>("/api/v1/admin/connectors"),
    api<{ tasks: Task[] }>("/api/v1/admin/tasks"),
    api<{ products: Product[] }>("/api/v1/admin/products"),
    api<CatalogStatus>("/api/v1/admin/catalog/status"),
  ]);
  if (connectors.status === "fulfilled") renderConnectors(connectors.value.connectors);
  else toast(connectors.reason instanceof Error ? connectors.reason.message : "Connector 刷新失败", true);
  if (tasks.status === "fulfilled") renderTasks(tasks.value.tasks);
  else toast(tasks.reason instanceof Error ? tasks.reason.message : "任务刷新失败", true);
  if (products.status === "fulfilled") renderProducts(Array.isArray(products.value.products) ? products.value.products : []);
  else renderProductLoadError(products.reason instanceof Error ? products.reason.message : "产品刷新失败");
  const connectorCount = connectors.status === "fulfilled" ? connectors.value.connectors.length : "--";
  const taskCount = tasks.status === "fulfilled" ? tasks.value.tasks.length : "--";
  const productCount = products.status === "fulfilled" ? products.value.products.length : "--";
  const coverageState = catalogStatus.status === "fulfilled" ? `${catalogStatus.value.mode.toUpperCase()} · ${catalogStatus.value.footprints} FOOTPRINTS` : "COVERAGE UNKNOWN";
  byId("admin-status").textContent = `${connectorCount} CONNECTORS · ${taskCount} TASKS · ${productCount} PRODUCTS · ${coverageState} · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  })().catch((error) => {
    toast(error instanceof Error ? error.message : "刷新失败", true);
    byId("admin-status").textContent = "REFRESH FAILED";
  }).finally(() => {
    button.disabled = false;
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function formValue(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "").trim();
}

function updateConnectorFields(): void {
  const type = byId<HTMLSelectElement>("connector-type").value;
  const objectStorage = type === "s3" || type === "oss";
  document.querySelectorAll<HTMLElement>("[data-connector-object], [data-connector-local]").forEach((element) => {
    const field = element.querySelector<HTMLInputElement>("input,select");
    const visible = element.hasAttribute("data-connector-local") ? type === "local"
      : objectStorage;
    element.hidden = !visible;
    if (!field) return;
    field.disabled = !visible;
    field.required = visible && ["endpoint", "bucket", "accessKey", "secretKey", "localPath"].includes(field.name);
    if (!visible) field.value = "";
  });
}

async function submitConnector(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = { name: formValue(form, "name"), type: formValue(form, "type"), endpoint: formValue(form, "endpoint") || undefined, region: formValue(form, "region") || undefined, bucket: formValue(form, "bucket") || undefined, prefix: formValue(form, "prefix") || undefined, accessKey: formValue(form, "accessKey") || undefined, secretKey: formValue(form, "secretKey") || undefined, localPath: formValue(form, "localPath") || undefined };
  setMessage("connector", "正在创建…");
  try {
    await api("/api/v1/admin/connectors", { method: "POST", body: JSON.stringify(input) });
    form.reset();
    updateConnectorFields();
    byId<HTMLDialogElement>("connector-dialog").close();
    setMessage("connector", "Connector 已创建");
    toast("Connector 已创建");
    await refresh();
  } catch (error) { setMessage("connector", error instanceof Error ? error.message : "创建失败", true); }
}

async function submitTask(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = {
    name: formValue(form, "name"), productId: formValue(form, "productId") || undefined, profileId: formValue(form, "profileId") || undefined, sourceConnector: formValue(form, "sourceConnector"), sourcePaths: formValue(form, "sourcePaths").split(/\r?\n/).map((path) => path.trim()).filter(Boolean), allowedSuffixes: formValue(form, "allowedSuffixes") || undefined, maxOrder: Number(formValue(form, "maxOrder") || "8"), raColumn: formValue(form, "raColumn") || undefined, decColumn: formValue(form, "decColumn") || undefined, healpixColumn: formValue(form, "healpixColumn") || undefined, healpixOrderColumn: formValue(form, "healpixOrderColumn") || undefined, healpixOrder: formValue(form, "healpixOrder") ? Number(formValue(form, "healpixOrder")) : undefined, batchId: formValue(form, "batchId") || undefined,
  };
  setMessage("task", "正在提交 CRD…");
  try {
    await api("/api/v1/admin/tasks", { method: "POST", body: JSON.stringify(input) });
    byId<HTMLDialogElement>("task-dialog").close();
    setMessage("task", "ScanRequest 已提交");
    toast("ScanRequest 已提交");
    await refresh();
  } catch (error) { setMessage("task", error instanceof Error ? error.message : "提交失败", true); }
}

async function initialize(): Promise<void> {
  renderIcons();
  try {
    adminConfig = await api<AdminConfig>("/api/v1/admin/config", { headers: {} });
    renderBusinessProfiles();
    setTaskSubmitEnabled(false);
    byId("admin-namespace").textContent = adminConfig.namespace;
    byId("admin-capability").textContent = adminConfig.enabled && adminConfig.kubernetesConfigured ? "ONLINE" : "NOT CONFIGURED";
    if (!adminConfig.enabled) {
      byId("login-title").textContent = t("admin.disabled");
      byId("login-error").textContent = "当前部署未启用 Kubernetes 管理连接。";
      byId("login-error").hidden = false;
      return;
    }
    if (token) {
      showWorkspace();
      await refresh();
    }
  } catch (error) {
    byId("login-error").textContent = error instanceof Error ? error.message : "Unable to read admin configuration";
    byId("login-error").hidden = false;
  }
}

byId<HTMLFormElement>("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = byId<HTMLInputElement>("admin-token").value.trim();
  if (!token) return;
  sessionStorage.setItem(tokenKey, token);
  showWorkspace();
  await refresh();
});
byId("logout-button").addEventListener("click", () => { token = ""; sessionStorage.removeItem(tokenKey); showLogin(); });
byId("refresh-button").addEventListener("click", () => void refresh());
byId("catalog-reload-button").addEventListener("click", async () => {
  const button = byId<HTMLButtonElement>("catalog-reload-button");
  button.disabled = true;
  try {
    const response = await api<{ catalog: CatalogStatus }>("/api/v1/admin/catalog/reload", { method: "POST" });
    toast(`Coverage 已重载：${response.catalog.footprints} footprints`);
    await refresh();
  } catch (error) { toast(error instanceof Error ? error.message : "Coverage reload 失败", true); }
  finally { button.disabled = false; }
});
byId<HTMLFormElement>("connector-form").addEventListener("submit", (event) => void submitConnector(event));
byId<HTMLFormElement>("task-form").addEventListener("submit", (event) => void submitTask(event));
byId<HTMLFormElement>("product-form").addEventListener("submit", (event) => void saveProduct(event));
byId("product-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("product-dialog").close());
byId("task-product").addEventListener("change", (event) => setDerivedProduct((event.currentTarget as HTMLSelectElement).value));
byId("task-profile").addEventListener("change", (event) => setDerivedProfile((event.currentTarget as HTMLSelectElement).value));
byId("connector-type").addEventListener("change", updateConnectorFields);
byId("connector-create-button").addEventListener("click", () => byId<HTMLDialogElement>("connector-dialog").showModal());
byId("connector-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("connector-dialog").close());
byId("task-create-button").addEventListener("click", () => byId<HTMLDialogElement>("task-dialog").showModal());
byId("task-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("task-dialog").close());
byId("task-detail-close").addEventListener("click", () => byId<HTMLDialogElement>("task-detail-dialog").close());
byId<HTMLInputElement>("product-search").addEventListener("input", (event) => {
  productQuery = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
  renderProducts(productRecords);
});
updateConnectorFields();
void initialize();
