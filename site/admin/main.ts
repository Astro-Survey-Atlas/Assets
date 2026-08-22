import { ArrowLeft, LogOut, Pencil, Plus, RefreshCw, Send, ShieldCheck, Unlock, Upload, createIcons } from "lucide";
import "./styles.css";

type ConnectorType = "s3" | "local";
interface AdminConfig { enabled: boolean; authRequired: boolean; namespace: string; kubernetesConfigured: boolean; capabilities: { coverageModes: string[]; connectorTypes: ConnectorType[]; backends: string[] } }
interface Connector { name: string; type: ConnectorType | "oss"; endpoint?: string; bucket?: string; prefix?: string; accessKeyConfigured?: boolean; pvcName?: string; localPath?: string; phase?: string; message?: string; createdAt?: string }
interface TaskStatus { phase: string; backend?: string; runId?: string; discoveredFiles?: number; processedHdus?: number; coverageDocuments?: number; objectDocuments?: number; startedAt?: string; completedAt?: string; message?: string }
interface Task { name: string; createdAt?: string; layerId?: string; surveyId?: string; releaseId?: string; product?: string; mode?: string; backend?: string; sourceConnector?: string; sinkConnector?: string; sourcePaths: string[]; fileNamePattern?: string; tags: string[]; batchId?: string; status: TaskStatus }
interface Product { productId: string; draft: { productId: string; surveyId: string; releaseId: string; name: string; layerId?: string; mode?: string; coverageRole?: string; dataOrigin?: string; sourceTier?: string; presentation: { summaryMarkdown: string; methodologyMarkdown: string; limitationsMarkdown: string; flow: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } } }; published: unknown; revision: number; publishedRevision: number | null; updatedAt: string; publishedAt: string | null }

const tokenKey = "astro-survey-atlas-assets.admin-token";
let adminConfig: AdminConfig | null = null;
let token = sessionStorage.getItem(tokenKey) ?? "";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};

function renderIcons(): void {
  createIcons({ icons: { ArrowLeft, LogOut, Pencil, Plus, RefreshCw, Send, ShieldCheck, Unlock, Upload }, attrs: { "aria-hidden": "true" } });
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
    const type = connector.type === "local" ? "LOCAL" : "S3 / OSS";
    const location = connector.type === "local" ? connector.localPath ?? connector.pvcName ?? "受管本地存储" : `${connector.endpoint ?? ""}${connector.bucket ? ` · ${connector.bucket}` : ""}${connector.prefix ? ` / ${connector.prefix}` : ""}`;
    return `<article class="resource-row"><div><strong>${escapeText(connector.name)}</strong><span>${type} · ${escapeText(connector.phase ?? "UNKNOWN")}</span><p>${escapeText(location)}</p></div><code>${escapeText(connector.message ?? "")}</code></article>`;
  }).join("");
}

function phaseClass(phase: string): string {
  return phase.toLowerCase().replace(/[^a-z]+/g, "-");
}

function renderTasks(tasks: Task[]): void {
  const body = byId("task-list");
  if (!tasks.length) {
    body.innerHTML = `<tr><td colspan="6" class="resource-empty">暂无 Assets coverage task</td></tr>`;
    return;
  }
  body.innerHTML = tasks.map((task) => {
    const status = task.status ?? { phase: "Pending" };
    const stats = [status.discoveredFiles !== undefined ? `${status.discoveredFiles.toLocaleString()} files` : "--", status.coverageDocuments !== undefined ? `${status.coverageDocuments.toLocaleString()} coverage` : "--"].join(" · ");
    return `<tr><td><strong>${escapeText(task.name)}</strong><small>${escapeText(task.backend ?? "job")} · ${escapeText(task.batchId ?? "")}</small></td><td><strong>${escapeText(task.layerId ?? "--")}</strong><small>${escapeText(task.surveyId ?? "")} / ${escapeText(task.releaseId ?? "")}</small></td><td><span>${escapeText(task.sourceConnector ?? "--")}</span><small>${escapeText(task.sourcePaths[0] ?? "")}</small></td><td><span class="task-phase task-phase-${phaseClass(status.phase)}">${escapeText(status.phase)}</span><small>${escapeText(status.message ?? "")}</small></td><td><span>${escapeText(stats)}</span><small>${status.runId ? `run ${escapeText(status.runId)}` : "run --"}</small></td><td><span>${escapeText(formatDate(status.completedAt ?? status.startedAt ?? task.createdAt))}</span></td></tr>`;
  }).join("");
}

let productRecords: Product[] = [];
function renderProducts(products: Product[]): void {
  productRecords = products;
  const list = byId("product-list");
  const select = byId<HTMLSelectElement>("task-product");
  select.replaceChildren(new Option("选择 Catalog 产品", ""), ...products.map((product) => new Option(`${product.draft.surveyId.toUpperCase()} · ${product.draft.name}`, product.productId)));
  if (!products.length) { list.innerHTML = `<div class="resource-empty">暂无 Catalog 产品</div>`; return; }
  list.innerHTML = products.map((product) => `<article class="product-row"><strong>${escapeText(product.draft.name)}</strong><small>${escapeText(product.draft.surveyId)} / ${escapeText(product.draft.releaseId)} · rev ${product.revision}${product.publishedRevision ? ` · published ${product.publishedRevision}` : " · 草稿"}</small><div class="product-row-actions"><button type="button" data-edit-product="${escapeText(product.productId)}" title="编辑产品"><i data-lucide="pencil"></i><span>编辑</span></button><button type="button" data-publish-product="${escapeText(product.productId)}" data-publish title="发布产品"><i data-lucide="upload"></i><span>发布</span></button></div></article>`).join("");
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

function setDerivedProduct(productId: string): void {
  const product = productRecords.find((entry) => entry.productId === productId);
  const output = byId("task-derived-summary");
  if (!product) { output.textContent = "选择产品后自动带出 survey、release、layer 和标准覆盖模式。"; return; }
  output.textContent = `${product.draft.surveyId.toUpperCase()} / ${product.draft.releaseId} · ${product.draft.layerId ?? "未注册 layer"} · ${product.draft.mode ?? "待 recipe"} · ${product.draft.coverageRole ?? "待 recipe"}`;
  for (const [name, value] of [["layerId", product.draft.layerId], ["surveyId", product.draft.surveyId], ["releaseId", product.draft.releaseId], ["product", product.draft.name], ["mode", product.draft.mode], ["coverageRole", product.draft.coverageRole], ["dataOrigin", product.draft.dataOrigin]] as const) {
    const field = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    if (field && value) field.value = value;
  }
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
  byId("admin-status").textContent = "LOADING";
  const [connectors, tasks, products] = await Promise.allSettled([
    api<{ connectors: Connector[] }>("/api/v1/admin/connectors"),
    api<{ tasks: Task[] }>("/api/v1/admin/tasks"),
    api<{ products: Product[] }>("/api/v1/admin/products"),
  ]);
  if (connectors.status === "fulfilled") renderConnectors(connectors.value.connectors);
  else toast(connectors.reason instanceof Error ? connectors.reason.message : "Connector 刷新失败", true);
  if (tasks.status === "fulfilled") renderTasks(tasks.value.tasks);
  else toast(tasks.reason instanceof Error ? tasks.reason.message : "任务刷新失败", true);
  if (products.status === "fulfilled") renderProducts(products.value.products);
  else renderProductLoadError(products.reason instanceof Error ? products.reason.message : "产品刷新失败");
  const connectorCount = connectors.status === "fulfilled" ? connectors.value.connectors.length : "--";
  const taskCount = tasks.status === "fulfilled" ? tasks.value.tasks.length : "--";
  const productCount = products.status === "fulfilled" ? products.value.products.length : "--";
  byId("admin-status").textContent = `${connectorCount} CONNECTORS · ${taskCount} TASKS · ${productCount} PRODUCTS`;
}

function formValue(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "").trim();
}

function updateConnectorFields(): void {
  const type = byId<HTMLSelectElement>("connector-type").value;
  const objectStorage = type === "s3";
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
  const input = { name: formValue(form, "name"), type: formValue(form, "type"), endpoint: formValue(form, "endpoint") || undefined, bucket: formValue(form, "bucket") || undefined, prefix: formValue(form, "prefix") || undefined, accessKey: formValue(form, "accessKey") || undefined, secretKey: formValue(form, "secretKey") || undefined, localPath: formValue(form, "localPath") || undefined };
  setMessage("connector", "正在创建…");
  try {
    await api("/api/v1/admin/connectors", { method: "POST", body: JSON.stringify(input) });
    form.reset();
    updateConnectorFields();
    setMessage("connector", "Connector 已创建");
    toast("Connector 已创建");
    await refresh();
  } catch (error) { setMessage("connector", error instanceof Error ? error.message : "创建失败", true); }
}

async function submitTask(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = {
    name: formValue(form, "name"), productId: formValue(form, "productId"), sourceConnector: formValue(form, "sourceConnector"), sourcePaths: formValue(form, "sourcePaths").split(/\r?\n/).map((path) => path.trim()).filter(Boolean), backend: formValue(form, "backend"), fileNamePattern: formValue(form, "fileNamePattern") || undefined, tags: formValue(form, "tags").split(",").map((tag) => tag.trim()).filter(Boolean), scanShards: Number(formValue(form, "scanShards") || "1"), allowedSuffixes: formValue(form, "allowedSuffixes") || undefined, maxOrder: Number(formValue(form, "maxOrder") || "8"), fileIndex: formValue(form, "fileIndex"), coverageIndex: formValue(form, "coverageIndex"), batchId: formValue(form, "batchId") || undefined,
  };
  setMessage("task", "正在提交 CRD…");
  try {
    await api("/api/v1/admin/tasks", { method: "POST", body: JSON.stringify(input) });
    setMessage("task", "Coverage Task 已提交");
    toast("Coverage Task 已提交");
    await refresh();
  } catch (error) { setMessage("task", error instanceof Error ? error.message : "提交失败", true); }
}

async function initialize(): Promise<void> {
  renderIcons();
  try {
    adminConfig = await api<AdminConfig>("/api/v1/admin/config", { headers: {} });
    byId("admin-namespace").textContent = adminConfig.namespace;
    byId("admin-capability").textContent = adminConfig.enabled && adminConfig.kubernetesConfigured ? "ONLINE" : "NOT CONFIGURED";
    if (!adminConfig.enabled) {
      byId("login-title").textContent = "管理台未启用";
      byId("login-error").textContent = "当前部署未启用 Kubernetes 管理连接。";
      byId("login-error").hidden = false;
      return;
    }
    if (token) {
      showWorkspace();
      await refresh();
    }
  } catch (error) {
    byId("login-error").textContent = error instanceof Error ? error.message : "无法读取管理配置";
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
byId<HTMLFormElement>("connector-form").addEventListener("submit", (event) => void submitConnector(event));
byId<HTMLFormElement>("task-form").addEventListener("submit", (event) => void submitTask(event));
byId<HTMLFormElement>("product-form").addEventListener("submit", (event) => void saveProduct(event));
byId("product-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("product-dialog").close());
byId("task-product").addEventListener("change", (event) => setDerivedProduct((event.currentTarget as HTMLSelectElement).value));
byId("connector-type").addEventListener("change", updateConnectorFields);
updateConnectorFields();
void initialize();
