import { Activity, ArrowLeft, AudioLines, Box, ChevronDown, ChevronUp, Database, Eye, Image, Layers3, LogOut, Pencil, PlugZap, Plus, RefreshCw, RotateCw, RotateCcw, Search, Send, ShieldCheck, Table2, Unlock, Upload, createIcons } from "lucide";
import "./styles.css";
import { mountLocaleControls, t } from "../src/i18n.js";
import { aggregateWorkAttempts } from "./work-items.js";

mountLocaleControls();

type ConnectorType = "s3" | "oss" | "local";
interface AdminConfig { enabled: boolean; authRequired: boolean; namespace: string; kubernetesConfigured: boolean; capabilities: { coverageModes: string[]; modalities?: string[]; connectorTypes: ConnectorType[]; backends: string[]; scanRequestApiVersion?: string } }
interface Connector { name: string; type: ConnectorType; endpoint?: string; region?: string; bucket?: string; prefix?: string; accessKeyConfigured?: boolean; pvcName?: string; basePath?: string; localPath?: string; phase?: string; message?: string; checkedAt?: string; createdAt?: string }
interface TaskStatus { phase: string; reason?: string; backend?: string; runId?: string; discoveredFiles?: number; processedHdus?: number; coverageDocuments?: number; objectDocuments?: number; errorCount?: number; availableOrders?: number[]; evidencePath?: string; sourceSnapshot?: { uri?: string; sha256: string; sizeBytes?: number }; startedAt?: string; completedAt?: string; message?: string }
interface Task { name: string; createdAt?: string; layerId?: string; surveyId?: string; releaseId?: string; product?: string; productId?: string; modality?: string; mode?: string; backend?: string; sourceConnector?: string; sourcePaths: string[]; tags: string[]; batchId?: string; workKey?: string; workTitle?: string; recipe?: { mode?: string; outputOrder?: number; catalog?: Record<string, unknown> }; status: TaskStatus }
interface Product { productId: string; draft: { productId: string; surveyId: string; releaseId: string; name: string; layerId?: string; modality?: string; mode?: string; coverageRole?: string; dataOrigin?: string; sourceTier?: string; originNote?: string; sourceLabel?: string; sourceUrl?: string; geometrySourceLabel?: string; geometrySourceUrl?: string; scanDefaults?: { allowedSuffixes?: string; maxOrder?: number; raColumn?: string; decColumn?: string; healpixColumn?: string; healpixOrderColumn?: string; healpixOrder?: number }; recipeVersion?: number; recipeHash?: string; coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number }; presentation: { summaryMarkdown: string; methodologyMarkdown: string; limitationsMarkdown: string; flow: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } } }; published: unknown; revision: number; publishedRevision: number | null; updatedAt: string; publishedAt: string | null; coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number } }
interface CatalogStatus { mode: string; loadedAt: string; layers: number; footprints: number; warehouseConfigured: boolean }
interface MocCandidateSummary { candidateId: string; title?: string; recordUrl?: string; mocUrl?: string; hipsUrl?: string }
interface MocProbeSummary { probeId: string; candidateId: string; kind: string; url: string; status?: number; bytes?: number; ok: boolean; sha256?: string; evidenceRef?: string; contentType?: string; error?: string; validation?: { acceptedSpatialMoc?: boolean; maxOrder?: number; icrs?: boolean; nested?: boolean; mocDimension?: boolean; stmoc?: boolean; format?: string; timeLoss?: string } }
interface MocReviewSummary { schemaVersion: 1; truncated: boolean; summaryTruncated: boolean; candidates: MocCandidateSummary[]; probes: MocProbeSummary[] }
interface MocDiscoveryStatus { phase: string; jobName?: string; reason?: string; message?: string; evidencePath?: string; candidateCount?: number; probeCount?: number; lastTransitionTime?: string; reviewSummary?: MocReviewSummary; reviewSummaryState?: "available" | "missing" }
interface MocDiscoveryRequest { name: string; namespace?: string; createdAt?: string; surveyName: string; releaseHint?: string; productHint?: string; policyRef: string; workKey?: string; workTitle?: string; status: MocDiscoveryStatus }
interface MocDiscoveryReview { provider: string; requestName: string; candidateId: string; probeId?: string; sourceSnapshotSha256?: string; decision: "pending" | "ready-for-build" | "rejected"; sourceUrl?: string; mocUrl?: string; hipsUrl?: string; notes?: string; revision: number; reviewedAt: string }
interface ReviewProduct { productId: string; name: string; modality?: string; description: string; status: string; sourceUrl?: string; dataOrigin?: string; sourceTier?: string; originNote?: string; sourceLabel?: string; geometrySourceUrl?: string; geometrySourceLabel?: string; reason?: string; manualStep?: string; coverage?: { availableOrders?: number[]; overviewOrder?: number; maxOrder?: number; layerId?: string; areaDeg2?: number }; review?: { state: string; draftRevision?: number; publishedRevision?: number | null; updatedAt?: string; publishedAt?: string | null } }
interface ReviewRelease { id: string; label: string; kind: string; releasedYear?: number; modalities: string[]; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; products: ReviewProduct[] }
interface ReviewSurvey { id: string; surveyId: string; name: string; mission: string; color: string; description: string; modalities: string[]; imageUrl: string; statistics: Record<string, number>; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; releases: ReviewRelease[]; unmatchedProducts?: Array<Record<string, unknown>> }

const tokenKey = "astro-survey-atlas-assets.admin-token";
let adminConfig: AdminConfig | null = null;
let token = sessionStorage.getItem(tokenKey) ?? "";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};

function renderIcons(): void {
  createIcons({ icons: { Activity, ArrowLeft, AudioLines, Box, ChevronDown, ChevronUp, Database, Eye, Image, Layers3, LogOut, Pencil, PlugZap, Plus, RefreshCw, RotateCw, RotateCcw, Search, Send, ShieldCheck, Table2, Unlock, Upload }, attrs: { "aria-hidden": "true" } });
}

type AdminStep = "sources" | "tasks" | "review";
let activeStep: AdminStep = "sources";

function setAdminStep(step: AdminStep, replace = false): void {
  activeStep = step;
  document.querySelectorAll<HTMLElement>("[data-admin-panel]").forEach((panel) => { panel.hidden = panel.dataset.adminPanel !== step; });
  document.querySelectorAll<HTMLButtonElement>("[data-admin-step]").forEach((button) => {
    const selected = button.dataset.adminStep === step;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  const hash = `#${step}`;
  if (replace) history.replaceState(null, "", hash);
  else if (location.hash !== hash) history.pushState(null, "", hash);
}

function readAdminStep(): AdminStep {
  const value = location.hash.slice(1);
  return value === "tasks" || value === "review" ? value : "sources";
}

function modalityIcon(modality?: string): string {
  const value = modality?.toLowerCase();
  if (value === "image" || value === "imaging") return "image";
  if (value === "spectrum" || value === "spectroscopy") return "audio-lines";
  if (value === "catalog" || value === "photometry") return "table-2";
  if (value === "cube" || value === "integral-field") return "box";
  if (value === "timeseries" || value === "time-domain") return "activity";
  return "layers-3";
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

function setMessage(kind: "connector" | "task" | "product" | "moc-discovery" | "moc-review", message: string, error = false): void {
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
  setAdminStep(readAdminStep(), true);
}

function formatDate(value?: string): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function connectorLabel(connector: Connector): string {
  return `${connector.name} · ${connector.type.toUpperCase()} · ${connector.phase ?? "NOT_CHECKED"}`;
}

function connectorLocation(connector: Connector): string {
  if (connector.type === "local") {
    if (connector.pvcName) return `PVC ${connector.pvcName}${connector.basePath ? ` · base ${connector.basePath}` : " · PVC root"}`;
    return connector.localPath ? `LEGACY ${connector.localPath}` : "受管本地存储";
  }
  return `${connector.endpoint ?? ""}${connector.region ? ` · ${connector.region}` : ""}${connector.bucket ? ` · ${connector.bucket}` : ""}${connector.prefix ? ` / ${connector.prefix}` : ""}`;
}

let connectorRecords: Connector[] = [];
let selectedConnectorName = "";
const connectorProbeResults = new Map<string, Connector>();

function renderConnectorDetails(connector?: Connector): void {
  const detail = byId("connector-detail");
  if (!connector) {
    detail.innerHTML = `<div class="resource-empty">选择一个 Connector 查看安全详情。</div>`;
    return;
  }
  const location = connectorLocation(connector);
  const phase = connector.phase ?? "NOT_CHECKED";
  detail.innerHTML = `<div class="connector-detail-heading"><div><span class="section-note">SELECTED CONNECTOR</span><h4>${escapeText(connector.name)}</h4></div><div class="connector-detail-actions"><button type="button" class="admin-quiet" data-probe-connector="${escapeText(connector.name)}" title="探测 Connector 连接"${phase === "PROBING" ? " disabled" : ""}><i data-lucide="plug-zap"></i><span>${phase === "PROBING" ? "探测中…" : "探测连接"}</span></button><button type="button" class="admin-quiet" data-use-connector="${escapeText(connector.name)}" title="用此 Connector 创建扫描"><i data-lucide="send"></i><span>用于新扫描</span></button></div></div><dl class="connector-detail-grid">${detailValue("type", connector.type.toUpperCase())}${detailValue("phase", phase)}${detailValue("location", location)}${detailValue("PVC", connector.pvcName)}${detailValue("base path", connector.basePath)}${detailValue("legacy path", connector.localPath)}${detailValue("credentials", connector.accessKeyConfigured ? "configured" : "not configured")}${detailValue("checked", connector.checkedAt ? formatDate(connector.checkedAt) : "NOT_CHECKED")}${detailValue("created", formatDate(connector.createdAt))}${detailValue("message", connector.message)}</dl>`;
  detail.querySelector<HTMLButtonElement>("[data-probe-connector]")?.addEventListener("click", () => void probeConnector(connector.name));
  detail.querySelector<HTMLButtonElement>("[data-use-connector]")?.addEventListener("click", () => {
    setAdminStep("tasks");
    byId<HTMLSelectElement>("source-connector").value = connector.name;
    byId<HTMLDialogElement>("task-dialog").showModal();
  });
  renderIcons();
}

function renderConnectors(connectors: Connector[]): void {
  connectorRecords = connectors.map((connector) => connectorProbeResults.get(connector.name) ?? connector);
  const list = byId("connector-list");
  const source = byId<HTMLSelectElement>("source-connector");
  source.replaceChildren(new Option(connectorRecords.length ? "选择 source connector" : "暂无 source connector", ""), ...connectorRecords.map((connector) => new Option(connectorLabel(connector), connector.name)));
  if (!connectorRecords.length) {
    list.innerHTML = `<div class="resource-empty">暂无 Connector，请先定义一个。</div>`;
    selectedConnectorName = "";
    renderConnectorDetails();
    return;
  }
  if (!connectorRecords.some((connector) => connector.name === selectedConnectorName)) selectedConnectorName = connectorRecords[0]!.name;
  list.innerHTML = connectorRecords.map((connector) => {
    const type = connector.type === "local" ? "LOCAL" : connector.type.toUpperCase();
    const location = connectorLocation(connector);
    const selected = connector.name === selectedConnectorName;
    return `<button type="button" class="resource-row connector-row${selected ? " is-selected" : ""}" data-connector-name="${escapeText(connector.name)}"><span class="connector-row-copy"><strong>${escapeText(connector.name)}</strong><span>${type} · ${escapeText(connector.phase ?? "NOT_CHECKED")}</span><p>${escapeText(location)}</p></span><code>${escapeText(connector.message ?? "")}</code></button>`;
  }).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-connector-name]").forEach((button) => button.addEventListener("click", () => {
    selectedConnectorName = button.dataset.connectorName ?? "";
    renderConnectors(connectorRecords);
    renderConnectorDetails(connectorRecords.find((connector) => connector.name === selectedConnectorName));
  }));
  renderConnectorDetails(connectorRecords.find((connector) => connector.name === selectedConnectorName));
}

async function probeConnector(name: string): Promise<void> {
  const current = connectorRecords.find((connector) => connector.name === name);
  if (!current || current.phase === "PROBING") return;
  connectorProbeResults.set(name, { ...current, phase: "PROBING", message: "正在探测连接…" });
  renderConnectors(connectorRecords);
  try {
    const response = await api<{ connector: Connector }>(`/api/v1/admin/connectors/${encodeURIComponent(name)}/probe`, { method: "POST" });
    connectorProbeResults.set(name, response.connector);
    renderConnectors(connectorRecords);
    toast(`${name} · ${response.connector.phase}` , response.connector.phase === "ERROR");
  } catch (error) {
    connectorProbeResults.set(name, { ...current, phase: "ERROR", message: error instanceof Error ? error.message : "探测失败", checkedAt: new Date().toISOString() });
    renderConnectors(connectorRecords);
    toast(error instanceof Error ? error.message : "Connector 探测失败", true);
  }
}

function phaseClass(phase: string): string {
  return (phase || "PENDING").toLowerCase().replace(/[^a-z]+/g, "-");
}

function phaseLabel(phase?: string): string {
  const normalized = String(phase ?? "").trim().toUpperCase();
  return normalized || "PENDING";
}

function taskWorkKey(task: Task): string {
  return task.workKey ?? (task.productId ? `product:${task.productId}` : `work:${task.surveyId ?? "unknown"}:${task.releaseId ?? "unknown"}:${task.product ?? task.layerId ?? task.name}`);
}

function mocWorkKey(request: MocDiscoveryRequest): string {
  return request.workKey ?? `work:${request.surveyName}:${request.releaseHint ?? "unknown"}:${request.productHint ?? "moc"}`;
}

function workTitle(task?: Task, request?: MocDiscoveryRequest): string {
  return task?.workTitle ?? request?.workTitle
    ?? ([task?.surveyId ?? request?.surveyName, task?.releaseId ?? request?.releaseHint, task?.product ?? request?.productHint].filter(Boolean).join(" · ")
      || "MOC discovery");
}

let taskRecords: Task[] = [];
const taskRetryInFlight = new Set<string>();

function renderTasks(tasks: Task[]): void {
  taskRecords = tasks;
  const body = byId("task-list");
  if (!tasks.length) {
    body.innerHTML = `<tr><td colspan="7" class="resource-empty">暂无文件扫描执行记录</td></tr>`;
    renderWorkOutputs([], mocDiscoveryRecords);
    return;
  }
  body.innerHTML = tasks.map((task) => {
    const status = task.status ?? { phase: "Pending" };
    const modality = task.modality ?? "other";
    const stats = [status.discoveredFiles !== undefined ? `${status.discoveredFiles.toLocaleString()} files` : "files unknown", status.coverageDocuments !== undefined ? `${status.coverageDocuments.toLocaleString()} coverage` : "coverage unknown", status.objectDocuments !== undefined ? `${status.objectDocuments.toLocaleString()} objects` : "objects unknown", status.errorCount !== undefined ? `${status.errorCount.toLocaleString()} errors` : "errors unknown"].join(" · ");
    const retrying = taskRetryInFlight.has(task.name);
    return `<tr><td><div class="task-identity"><i data-lucide="${modalityIcon(modality)}"></i><strong>${escapeText(workTitle(task))}</strong></div><small>${escapeText(task.name)} · ${escapeText(modality)} · ${escapeText(task.recipe?.mode ?? task.mode ?? "recipe pending")} · ${escapeText(task.batchId ?? "run pending")}</small></td><td><strong>${escapeText(task.product ?? task.productId ?? task.layerId ?? "product pending")}</strong><small>${escapeText(task.surveyId ?? "survey pending")} / ${escapeText(task.releaseId ?? "release pending")}</small></td><td><span>${escapeText(task.sourceConnector ?? "source pending")}</span><small>${escapeText(task.sourcePaths[0] ?? "path pending")}</small></td><td><span class="task-phase task-phase-${phaseClass(status.phase)}">${escapeText(phaseLabel(status.phase))}</span><small>${escapeText(status.reason ?? status.message ?? "")}</small></td><td><span>${escapeText(stats)}</span><small>${status.runId ? `run ${escapeText(status.runId)}` : "run pending"}</small></td><td><span>${escapeText(formatDate(status.completedAt ?? status.startedAt ?? task.createdAt))}</span></td><td><div class="task-row-actions"><button type="button" class="admin-quiet" data-task-details="${escapeText(task.name)}" title="查看任务详情"><i data-lucide="eye"></i><span>详情</span></button><button type="button" class="admin-quiet" data-task-resubmit="${escapeText(task.name)}" title="重新提交任务"${retrying ? " disabled" : ""}><i data-lucide="rotate-ccw"></i><span>${retrying ? "重提中…" : "重提"}</span></button></div></td></tr>`;
  }).join("");
  body.querySelectorAll<HTMLButtonElement>("[data-task-details]").forEach((button) => button.addEventListener("click", () => void openTaskDetails(button.dataset.taskDetails ?? "")));
  body.querySelectorAll<HTMLButtonElement>("[data-task-resubmit]").forEach((button) => button.addEventListener("click", () => void resubmitTask(button.dataset.taskResubmit ?? "")));
  renderIcons();
  renderWorkOutputs(tasks, mocDiscoveryRecords);
}

let mocDiscoveryRecords: MocDiscoveryRequest[] = [];
let mocRetryInFlight = "";

function renderMocDiscoveryRequests(requests: MocDiscoveryRequest[]): void {
  mocDiscoveryRecords = requests;
  byId("moc-discovery-count").textContent = `${requests.length} REQUEST${requests.length === 1 ? "" : "S"}`;
  const list = byId("moc-discovery-list");
  if (!requests.length) {
    list.innerHTML = `<div class="resource-empty">暂无 MOC 探测请求</div>`;
    renderWorkOutputs(taskRecords, requests);
    return;
  }
  list.innerHTML = requests.map((request) => {
    const status = request.status ?? { phase: "PENDING" };
    const hints = [request.releaseHint, request.productHint].filter(Boolean).join(" · ");
    const counts = [status.candidateCount !== undefined ? `${status.candidateCount} candidates` : "candidates unknown", status.probeCount !== undefined ? `${status.probeCount} probes` : "probes unknown"].join(" · ");
    const reviewState = status.reviewSummaryState === "available" ? "review summary ready" : status.phase === "SUCCEEDED" ? "review summary missing" : "review pending";
    const retrying = mocRetryInFlight === request.name;
    const retry = ["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(phaseLabel(status.phase)) ? `<button type="button" class="admin-quiet" data-moc-retry="${escapeText(request.name)}" title="重新探查"${retrying ? " disabled" : ""}><i data-lucide="rotate-ccw"></i><span>${retrying ? "探查中…" : "重新探查"}</span></button>` : "";
    return `<article class="resource-row moc-discovery-row"><div><div class="task-identity"><i data-lucide="search"></i><strong>${escapeText(workTitle(undefined, request))}</strong></div><span>${escapeText(request.name)}${hints ? ` · ${escapeText(hints)}` : ""}</span><p>${escapeText(counts)} · ${escapeText(reviewState)}${status.evidencePath ? ` · evidence ${escapeText(status.evidencePath)}` : ""}</p></div><div class="moc-discovery-row-actions"><span class="task-phase task-phase-${phaseClass(status.phase)}">${escapeText(phaseLabel(status.phase))}</span><button type="button" class="admin-quiet" data-moc-review="${escapeText(request.name)}" title="查看请求并记录候选审核"><i data-lucide="shield-check"></i><span>审核</span></button>${retry}</div></article>`;
  }).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-moc-review]").forEach((button) => button.addEventListener("click", () => void openMocReview(button.dataset.mocReview ?? "")));
  list.querySelectorAll<HTMLButtonElement>("[data-moc-retry]").forEach((button) => button.addEventListener("click", () => void resubmitMocDiscovery(button.dataset.mocRetry ?? "")));
  renderIcons();
  renderWorkOutputs(taskRecords, requests);
}

function reviewField(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLSelectElement) && !(field instanceof HTMLTextAreaElement)) throw new Error(`Missing review field: ${name}`);
  return field;
}

function renderMocReviewHistory(reviews: MocDiscoveryReview[]): void {
  const container = byId("moc-review-history");
  if (!reviews.length) {
    container.innerHTML = `<div class="resource-empty">尚无审核记录</div>`;
    return;
  }
  container.innerHTML = `<div class="section-heading"><div><span class="section-index">HISTORY</span><h4>审核记录</h4></div></div>${reviews.slice().reverse().map((review) => `<article class="resource-row moc-review-history-row"><div><strong>${escapeText(review.candidateId)}</strong><span>${escapeText(review.decision)} · rev ${review.revision} · ${escapeText(formatDate(review.reviewedAt))}</span><p>${escapeText(review.notes ?? "")}</p></div><code>${escapeText(review.sourceSnapshotSha256 ?? "snapshot unavailable")}</code></article>`).join("")}`;
}

let activeMocReviewRequest: MocDiscoveryRequest | null = null;

function setReviewValue(form: HTMLFormElement, name: string, value: string): void {
  const field = reviewField(form, name);
  field.value = value;
}

function syncMocReviewSelection(): void {
  const request = activeMocReviewRequest;
  if (!request) return;
  const form = byId<HTMLFormElement>("moc-review-form");
  const summary = request.status.reviewSummary;
  const candidateId = formValue(form, "candidateId");
  const candidate = summary?.candidates.find((entry) => entry.candidateId === candidateId);
  const probeSelect = reviewField(form, "probeId") as HTMLSelectElement;
  const selectedProbeId = probeSelect.value;
  const candidateProbes = summary?.probes.filter((entry) => entry.candidateId === candidateId) ?? [];
  probeSelect.replaceChildren(new Option("只使用候选元数据", ""), ...candidateProbes.map((probe) => new Option(`${probe.kind} · ${probe.ok ? "OK" : "FAILED"}`, probe.probeId)));
  probeSelect.value = candidateProbes.some((entry) => entry.probeId === selectedProbeId) ? selectedProbeId : candidateProbes[0]?.probeId ?? "";
  const probe = summary?.probes.find((entry) => entry.probeId === probeSelect.value && entry.candidateId === candidateId);
  const sourceUrl = candidate?.recordUrl ?? "";
  const mocUrl = probe?.kind === "mocUrl" ? probe.url : candidate?.mocUrl ?? "";
  const hipsUrl = probe?.kind === "hipsUrl" ? probe.url : candidate?.hipsUrl ?? "";
  setReviewValue(form, "sourceSnapshotSha256", probe?.sha256 ?? "");
  setReviewValue(form, "sourceUrl", sourceUrl);
  setReviewValue(form, "mocUrl", mocUrl);
  setReviewValue(form, "hipsUrl", hipsUrl);
  const detail = byId("moc-candidate-detail");
  detail.innerHTML = candidate ? `<strong>${escapeText(candidate.title ?? candidate.candidateId)}</strong><p>${escapeText(candidate.candidateId)}</p><small>${escapeText(candidate.recordUrl ?? "No record URL")}</small>` : `<span class="resource-empty">请选择一个候选</span>`;
  const probeDetail = byId("moc-probe-detail");
  if (!probe) probeDetail.innerHTML = `<span class="resource-empty">该候选没有 probe，pending/rejected 仍可保存。</span>`;
  else {
    const validation = probe.validation ? Object.entries(probe.validation).map(([key, value]) => `${key}=${String(value)}`).join(" · ") : "validation unavailable";
    probeDetail.innerHTML = `<strong>${escapeText(probe.kind)} · ${probe.ok ? "OK" : "FAILED"}</strong><p>${escapeText(probe.url)}</p><small>${escapeText(probe.sha256 ?? "snapshot unavailable")} · ${escapeText(validation)}${probe.error ? ` · ${escapeText(probe.error)}` : ""}</small>`;
  }
  const decision = reviewField(form, "decision") as HTMLSelectElement;
  const readyOption = [...decision.options].find((option) => option.value === "ready-for-build");
  const ready = Boolean(request.status.phase === "SUCCEEDED" && probe?.ok && probe.validation?.acceptedSpatialMoc === true && probe.sha256);
  if (readyOption) readyOption.disabled = !ready;
  if (decision.value === "ready-for-build" && !ready) decision.value = "pending";
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = !candidate;
}

function renderMocReviewSummary(request: MocDiscoveryRequest): void {
  const form = byId<HTMLFormElement>("moc-review-form");
  const state = byId("moc-review-state");
  const candidateSelect = reviewField(form, "candidateId") as HTMLSelectElement;
  const probeSelect = reviewField(form, "probeId") as HTMLSelectElement;
  candidateSelect.replaceChildren(new Option("选择候选", ""));
  probeSelect.replaceChildren(new Option("只使用候选元数据", ""));
  const summary = request.status.reviewSummary;
  if (!summary) {
    state.dataset.state = "missing";
    state.textContent = request.status.phase === "SUCCEEDED"
      ? "任务成功但未投影审核摘要。这是旧版 discovery 结果，请点击“重新探查”生成可审核内容。"
      : "当前任务还没有可审核的 Warehouse 摘要。";
    byId("moc-candidate-detail").innerHTML = "";
    byId("moc-probe-detail").innerHTML = "";
    const retry = byId<HTMLButtonElement>("moc-review-retry");
    retry.hidden = !["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(phaseLabel(request.status.phase));
    (form.querySelector<HTMLButtonElement>('button[type="submit"]'))?.setAttribute("disabled", "true");
    return;
  }
  byId<HTMLButtonElement>("moc-review-retry").hidden = !["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(phaseLabel(request.status.phase));
  if (!summary.candidates.length) {
    state.dataset.state = summary.truncated || summary.summaryTruncated ? "warning" : "empty";
    state.textContent = summary.truncated || summary.summaryTruncated
      ? "探测完成，但结果被策略限制截断；不能把它当作完整的零候选结果。"
      : "探测完成，Warehouse 返回了合法的 0 candidates / 0 probes。它表示本次上游查询为空，不代表巡天没有公开 MOC。";
    (form.querySelector<HTMLButtonElement>('button[type="submit"]'))?.setAttribute("disabled", "true");
  } else {
    state.dataset.state = summary.truncated || summary.summaryTruncated ? "warning" : "ready";
    state.textContent = `${summary.candidates.length} candidates · ${summary.probes.length} probes${summary.truncated || summary.summaryTruncated ? " · 结果有截断" : ""}`;
    summary.candidates.forEach((candidate) => candidateSelect.add(new Option(`${candidate.title ?? candidate.candidateId}`, candidate.candidateId)));
    candidateSelect.value = summary.candidates[0]!.candidateId;
  }
  candidateSelect.onchange = syncMocReviewSelection;
  probeSelect.onchange = syncMocReviewSelection;
  syncMocReviewSelection();
}

async function openMocReview(name: string): Promise<void> {
  try {
    const [requestResponse, reviewResponse] = await Promise.all([
      api<{ request: MocDiscoveryRequest }>(`/api/v1/admin/moc-discovery/${encodeURIComponent(name)}`),
      api<{ reviews: MocDiscoveryReview[] }>(`/api/v1/admin/moc-discovery/${encodeURIComponent(name)}/reviews`),
    ]);
    const form = byId<HTMLFormElement>("moc-review-form");
    form.reset();
    (reviewField(form, "requestName") as HTMLInputElement).value = requestResponse.request.name;
    const latest = reviewResponse.reviews.at(-1);
    if (latest) {
      for (const [fieldName, value] of Object.entries({ candidateId: latest.candidateId, sourceSnapshotSha256: latest.sourceSnapshotSha256, decision: latest.decision, sourceUrl: latest.sourceUrl, mocUrl: latest.mocUrl, hipsUrl: latest.hipsUrl, notes: latest.notes })) {
        const field = reviewField(form, fieldName);
        if (value !== undefined && fieldName !== "sourceSnapshotSha256") field.value = value;
      }
    }
    activeMocReviewRequest = requestResponse.request;
    byId("moc-review-title").textContent = workTitle(undefined, requestResponse.request);
    renderMocReviewSummary(requestResponse.request);
    if (latest) {
      setReviewValue(form, "candidateId", latest.candidateId);
      if (latest.probeId) setReviewValue(form, "probeId", latest.probeId);
      syncMocReviewSelection();
    }
    renderMocReviewHistory(reviewResponse.reviews);
    byId<HTMLDialogElement>("moc-review-dialog").showModal();
  } catch (error) { toast(error instanceof Error ? error.message : "审核请求加载失败", true); }
}

async function submitMocDiscovery(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  setMessage("moc-discovery", "正在提交…");
  try {
    const selectedProduct = productRecords.find((product) => product.productId === formValue(form, "productId"));
    await api("/api/v1/admin/moc-discovery", { method: "POST", body: JSON.stringify({ surveyName: selectedProduct?.draft.surveyId ?? formValue(form, "surveyName"), releaseHint: selectedProduct?.draft.releaseId ?? (formValue(form, "releaseHint") || undefined), productHint: selectedProduct?.draft.name ?? (formValue(form, "productHint") || undefined), productId: selectedProduct?.productId, surveyId: selectedProduct?.draft.surveyId, releaseId: selectedProduct?.draft.releaseId, workTitle: selectedProduct ? `${selectedProduct.draft.surveyId.toUpperCase()} · ${selectedProduct.draft.releaseId} · ${selectedProduct.draft.name}` : undefined }) });
    form.reset();
    byId<HTMLDialogElement>("moc-discovery-dialog").close();
    toast("MOC 探测请求已提交");
    await refresh();
  } catch (error) { setMessage("moc-discovery", error instanceof Error ? error.message : "提交失败", true); }
}

async function submitMocReview(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const requestName = formValue(form, "requestName");
  setMessage("moc-review", "正在保存…");
  try {
    await api(`/api/v1/admin/moc-discovery/${encodeURIComponent(requestName)}/reviews`, { method: "POST", body: JSON.stringify({ provider: "cds", candidateId: formValue(form, "candidateId"), probeId: formValue(form, "probeId") || undefined, decision: formValue(form, "decision"), notes: formValue(form, "notes") || undefined }) });
    toast("审核记录已保存");
    const response = await api<{ reviews: MocDiscoveryReview[] }>(`/api/v1/admin/moc-discovery/${encodeURIComponent(requestName)}/reviews`);
    renderMocReviewHistory(response.reviews);
    setMessage("moc-review", "已保存");
    await refresh();
  } catch (error) { setMessage("moc-review", error instanceof Error ? error.message : "保存失败", true); }
}

async function resubmitMocDiscovery(name: string): Promise<void> {
  if (mocRetryInFlight === name) return;
  mocRetryInFlight = name;
  renderMocDiscoveryRequests(mocDiscoveryRecords);
  try {
    const response = await api<{ request: MocDiscoveryRequest }>(`/api/v1/admin/moc-discovery/${encodeURIComponent(name)}/resubmit`, { method: "POST" });
    toast(`已创建重新探查任务 ${response.request.name}`);
    byId<HTMLDialogElement>("moc-review-dialog").close();
    activeMocReviewRequest = null;
    await refresh();
  } catch (error) { toast(error instanceof Error ? error.message : "重新探查失败", true); }
  finally { mocRetryInFlight = ""; renderMocDiscoveryRequests(mocDiscoveryRecords); }
}

function renderWorkOutputs(tasks: Task[], requests: MocDiscoveryRequest[]): void {
  const container = byId("modality-chart");
  const groups = aggregateWorkAttempts(
    tasks.map((task) => ({ key: taskWorkKey(task), createdAt: task.createdAt, value: task })),
    requests.map((request) => ({ key: mocWorkKey(request), createdAt: request.createdAt, value: request })),
  );
  if (!groups.length) {
    container.innerHTML = `<div class="resource-empty">暂无任务产出</div>`;
    return;
  }
  const rows = groups.map((group) => {
    const key = group.key;
    const task = group.task;
    const request = group.request;
    const scanStatus = task ? phaseLabel(task.status?.phase) : "NOT_SUBMITTED";
    const mocStatus = request ? phaseLabel(request.status?.phase) : "NOT_SUBMITTED";
    const taskStatus = task?.status ?? { phase: "PENDING" };
    const scanCounts = task ? [taskStatus.discoveredFiles !== undefined ? `${taskStatus.discoveredFiles.toLocaleString()} files` : "files unknown", taskStatus.coverageDocuments !== undefined ? `${taskStatus.coverageDocuments.toLocaleString()} coverage` : "coverage unknown", taskStatus.objectDocuments !== undefined ? `${taskStatus.objectDocuments.toLocaleString()} objects` : "objects unknown", taskStatus.errorCount !== undefined ? `${taskStatus.errorCount.toLocaleString()} errors` : "errors unknown", taskStatus.availableOrders?.length ? taskStatus.availableOrders.map((order) => `O${order}`).join("/") : "orders unknown"].join(" · ") : "文件扫描尚未提交";
    const mocCounts = request ? `${request.status.candidateCount !== undefined ? request.status.candidateCount.toLocaleString() : "unknown"} candidates · ${request.status.probeCount !== undefined ? request.status.probeCount.toLocaleString() : "unknown"} probes` : "MOC 尚未探查";
    const counts = `${scanCounts} · ${mocCounts}`;
    const retry = task && ["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(scanStatus) ? `<button type="button" class="admin-quiet" data-task-resubmit-output="${escapeText(task.name)}" title="重新提交文件扫描"><i data-lucide="rotate-ccw"></i><span>重提扫描</span></button>` : "";
    const mocRetry = request && ["SUCCEEDED", "FAILED", "COMPLETED", "ERROR", "INVALID", "CANCELLED"].includes(mocStatus) ? `<button type="button" class="admin-quiet" data-moc-retry-output="${escapeText(request.name)}" title="重新探查"><i data-lucide="rotate-ccw"></i><span>重提探查</span></button>` : "";
    const evidence = task?.status.evidencePath ?? request?.status.evidencePath;
    const attemptLabel = `${group.taskAttempts} scan / ${group.mocAttempts} MOC attempts; latest result only`;
    return `<article class="work-output-row"><div class="work-output-copy"><div class="task-identity"><i data-lucide="layers-3"></i><strong>${escapeText(workTitle(task, request))}</strong></div><small>${escapeText(key)} · ${escapeText(attemptLabel)}</small><p>${escapeText(counts)}${evidence ? ` · evidence ${escapeText(evidence)}` : ""}</p></div><div class="work-output-status"><span class="task-phase task-phase-${phaseClass(scanStatus)}">SCAN ${escapeText(scanStatus)}</span><span class="task-phase task-phase-${phaseClass(mocStatus)}">MOC ${escapeText(mocStatus)}</span><div class="work-output-actions">${task ? `<button type="button" class="admin-quiet" data-task-details-output="${escapeText(task.name)}" title="查看扫描详情"><i data-lucide="eye"></i><span>详情</span></button>` : ""}${request ? `<button type="button" class="admin-quiet" data-moc-review-output="${escapeText(request.name)}" title="审核 MOC 候选"><i data-lucide="shield-check"></i><span>审核</span></button>` : ""}${retry}${mocRetry}</div></div></article>`;
  }).join("");
  container.innerHTML = `<div class="work-output-list">${rows}</div>`;
  container.querySelectorAll<HTMLButtonElement>("[data-task-details-output]").forEach((button) => button.addEventListener("click", () => void openTaskDetails(button.dataset.taskDetailsOutput ?? "")));
  container.querySelectorAll<HTMLButtonElement>("[data-task-resubmit-output]").forEach((button) => button.addEventListener("click", () => void resubmitTask(button.dataset.taskResubmitOutput ?? "")));
  container.querySelectorAll<HTMLButtonElement>("[data-moc-review-output]").forEach((button) => button.addEventListener("click", () => void openMocReview(button.dataset.mocReviewOutput ?? "")));
  container.querySelectorAll<HTMLButtonElement>("[data-moc-retry-output]").forEach((button) => button.addEventListener("click", () => void resubmitMocDiscovery(button.dataset.mocRetryOutput ?? "")));
  renderIcons();
}

function detailValue(label: string, value: unknown): string {
  return `<div class="task-detail-field"><dt>${escapeText(label)}</dt><dd>${escapeText(value ?? "unknown")}</dd></div>`;
}

async function openTaskDetails(name: string): Promise<void> {
  try {
    const response = await api<{ task: Task }>(`/api/v1/admin/tasks/${encodeURIComponent(name)}`);
    const task = response.task;
    const status = task.status ?? { phase: "Pending" };
    byId("task-detail-title").textContent = task.name;
    byId("task-detail-content").innerHTML = `<dl class="task-detail-grid">${detailValue("phase", phaseLabel(status.phase))}${detailValue("reason", status.reason)}${detailValue("message", status.message)}${detailValue("survey", task.surveyId)}${detailValue("release", task.releaseId)}${detailValue("product", task.product ?? task.productId)}${detailValue("layer", task.layerId)}${detailValue("modality", task.modality)}${detailValue("recipe", task.recipe?.mode ?? task.mode)}${detailValue("available orders", status.availableOrders?.map((order) => `O${order}`).join(", "))}${detailValue("run ID", status.runId)}${detailValue("files", status.discoveredFiles?.toLocaleString())}${detailValue("processed", status.processedHdus?.toLocaleString())}${detailValue("coverage", status.coverageDocuments?.toLocaleString())}${detailValue("objects", status.objectDocuments?.toLocaleString())}${detailValue("errors", status.errorCount?.toLocaleString())}${detailValue("source snapshot", status.sourceSnapshot ? `${status.sourceSnapshot.sha256}${status.sourceSnapshot.sizeBytes !== undefined ? ` · ${status.sourceSnapshot.sizeBytes} bytes` : ""}${status.sourceSnapshot.uri ? ` · ${status.sourceSnapshot.uri}` : ""}` : undefined)}${detailValue("evidence", status.evidencePath)}${detailValue("started", formatDate(status.startedAt))}${detailValue("completed", formatDate(status.completedAt))}</dl>`;
    byId<HTMLDialogElement>("task-detail-dialog").showModal();
  } catch (error) { toast(error instanceof Error ? error.message : "任务详情加载失败", true); }
}

async function resubmitTask(name: string): Promise<void> {
  if (taskRetryInFlight.has(name)) return;
  taskRetryInFlight.add(name);
  renderTasks(taskRecords);
  try {
    const response = await api<{ task: Task }>(`/api/v1/admin/tasks/${encodeURIComponent(name)}/resubmit`, { method: "POST" });
    toast(`已创建重提任务 ${response.task.name}`);
    await refresh();
  } catch (error) { toast(error instanceof Error ? error.message : "任务重提失败", true); }
  finally { taskRetryInFlight.delete(name); renderTasks(taskRecords); }
}

let productRecords: Product[] = [];
let reviewSurveyRecords: ReviewSurvey[] = [];
let selectedReviewSurveyId = "";
let productQuery = "";
let refreshInFlight: Promise<void> | null = null;
function renderProducts(products: Product[]): void {
  productRecords = products;
  const select = byId<HTMLSelectElement>("task-product");
  select.replaceChildren(new Option("选择 Catalog 产品", ""), ...products.map((product) => new Option(`${product.draft.surveyId.toUpperCase()} · ${product.draft.name}`, product.productId)));
  const mocProduct = document.getElementById("moc-product");
  if (mocProduct instanceof HTMLSelectElement) mocProduct.replaceChildren(new Option("不绑定 Catalog 产品", ""), ...products.map((product) => new Option(`${product.draft.surveyId.toUpperCase()} · ${product.draft.releaseId} · ${product.draft.name}`, product.productId)));
  renderReviewSurveys(reviewSurveyRecords);
}

function renderProductLoadError(message: string): void {
  const select = byId<HTMLSelectElement>("task-product");
  select.replaceChildren(new Option("Catalog 产品加载失败", ""));
  byId("product-list").innerHTML = `<div class="resource-empty">${escapeText(message)}</div>`;
  productRecords = [];
}

function reviewProductMatches(product: ReviewProduct): boolean {
  if (!productQuery) return true;
  return `${product.name} ${product.productId} ${product.modality ?? ""} ${product.status} ${product.description} ${product.reason ?? ""} ${(product.coverage?.availableOrders ?? []).map((order) => `O${order}`).join(" ")}`.toLocaleLowerCase().includes(productQuery);
}

function renderReviewSurveys(surveys: ReviewSurvey[]): void {
  reviewSurveyRecords = surveys;
  const list = byId("product-list");
  const visible = surveys.filter((survey) => !productQuery || `${survey.name} ${survey.mission} ${survey.description} ${survey.modalities.join(" ")} ${survey.releases.flatMap((release) => [release.label, release.id, release.kind, ...release.products.flatMap((product) => [product.name, product.description, product.modality ?? "", product.status, (product.coverage?.availableOrders ?? []).map((order) => `O${order}`).join(" ")])]).join(" ")} ${(survey.unmatchedProducts ?? []).map((product) => Object.values(product).join(" ")).join(" ")}`.toLocaleLowerCase().includes(productQuery));
  if (!visible.length) {
    list.innerHTML = `<div class="resource-empty">${surveys.length ? "没有匹配的巡天或产品" : "暂无公共巡天 Catalog"}</div>`;
    return;
  }
  if (!visible.some((survey) => survey.id === selectedReviewSurveyId)) selectedReviewSurveyId = visible[0]!.id;
  list.innerHTML = visible.map((survey) => {
    const selected = survey.id === selectedReviewSurveyId;
    const publicStats = Object.entries(survey.statistics).filter(([, value]) => typeof value === "number").map(([key, value]) => `${key} ${value.toLocaleString()}`).join(" · ");
    const releases = selected ? survey.releases.map((release) => `<section class="review-release"><div class="review-release-heading"><div><span class="section-index">RELEASE</span><h5>${escapeText(release.label)}</h5></div><small>${escapeText(release.id)} · ${escapeText(release.kind)}${release.releasedYear ? ` · ${release.releasedYear}` : ""}</small></div><div class="review-product-list">${release.products.filter(reviewProductMatches).map((product) => {
      const orders = product.coverage?.availableOrders?.map((order) => `O${order}`).join(" / ") || "orders unavailable";
      const reviewState = product.review?.state ?? "unmatched";
      return `<article class="review-product-row"><div><strong>${escapeText(product.name)}</strong><span>${escapeText(product.modality ?? "modality unknown")} · ${escapeText(product.status)} · ${escapeText(orders)}</span><p>${escapeText(product.description || product.reason || "No public description")}</p>${product.reason ? `<small>${escapeText(product.reason)}</small>` : ""}</div><div class="product-row-actions"><span class="review-state review-state-${phaseClass(reviewState)}">${escapeText(reviewState)}</span><button type="button" class="admin-quiet" data-edit-product="${escapeText(product.productId)}" title="编辑产品文稿"><i data-lucide="pencil"></i><span>编辑</span></button>${reviewState !== "published" ? `<button type="button" class="admin-quiet" data-publish-product="${escapeText(product.productId)}" data-publish title="发布产品"><i data-lucide="upload"></i><span>发布</span></button>` : ""}</div></article>`;
    }).join("") || `<div class="resource-empty">该 Release 没有匹配的产品</div>`}</div></section>`).join("") : "";
    const unmatchedRecords = survey.unmatchedProducts ?? [];
    const unmatchedProducts = selected ? unmatchedRecords.filter((product) => !productQuery || Object.values(product).join(" ").toLocaleLowerCase().includes(productQuery)).map((product) => {
      const productId = typeof product.productId === "string" ? product.productId : "";
      const name = typeof product.name === "string" ? product.name : productId || "unmatched product";
      const reviewState = typeof product.review === "object" && product.review && typeof (product.review as Record<string, unknown>).state === "string" ? String((product.review as Record<string, unknown>).state) : "unmatched";
      return `<article class="review-product-row"><div><strong>${escapeText(name)}</strong><span>${escapeText(String(product.surveyId ?? "survey unknown"))} · ${escapeText(String(product.releaseId ?? "release unknown"))}</span><p>该草稿没有对应的公共 survey/release/product 记录，需要补齐映射或确认是否应移除。</p></div><div class="product-row-actions"><span class="review-state review-state-${phaseClass(reviewState)}">${escapeText(reviewState)}</span>${productId ? `<button type="button" class="admin-quiet" data-edit-product="${escapeText(productId)}" title="编辑未匹配产品"><i data-lucide="pencil"></i><span>编辑</span></button>` : ""}</div></article>`;
    }).join("") : "";
    const unmatched = selected && unmatchedRecords.length ? `<section class="review-release review-unmatched"><div class="review-release-heading"><div><span class="section-index">QUEUE</span><h5>未匹配公共 Catalog</h5></div><small>Assets editorial queue</small></div><div class="review-product-list">${unmatchedProducts || `<div class="resource-empty">暂无未匹配产品</div>`}</div></section>` : "";
    const image = survey.imageUrl ? `<img src="${escapeText(survey.imageUrl)}" alt="" loading="lazy" />` : "";
    return `<article class="review-survey${selected ? " is-selected" : ""}" style="--survey-color:${escapeText(survey.color)}"><button type="button" class="review-survey-header" data-review-survey="${escapeText(survey.id)}"><span class="review-survey-swatch" aria-hidden="true"></span><span class="review-survey-copy"><strong>${escapeText(survey.name)}</strong><small>${escapeText(survey.mission)} · ${survey.releases.length} releases · ${escapeText(publicStats || "statistics unavailable")}</small><p>${escapeText(survey.description)}</p></span><i data-lucide="${selected ? "chevron-up" : "chevron-down"}"></i></button>${selected ? `<div class="review-survey-body"><div class="review-survey-meta"><span>${escapeText(survey.modalities.join(" · "))}</span><span>Coverage ${escapeText(survey.coverageOrders?.availableOrders?.map((order) => `O${order}`).join(" / ") || "orders unavailable")}</span>${image}</div>${releases}${unmatched}</div>` : ""}</article>`;
  }).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-review-survey]").forEach((button) => button.addEventListener("click", () => { selectedReviewSurveyId = button.dataset.reviewSurvey ?? ""; renderReviewSurveys(reviewSurveyRecords); }));
  list.querySelectorAll<HTMLButtonElement>("[data-edit-product]").forEach((button) => button.addEventListener("click", () => openProduct(button.dataset.editProduct ?? "")));
  list.querySelectorAll<HTMLButtonElement>("[data-publish-product]").forEach((button) => button.addEventListener("click", () => void publishProduct(button.dataset.publishProduct ?? "")));
  renderIcons();
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
  if (!product) {
    output.textContent = "选择 Catalog 产品后自动带出 survey、release、layer 和 ScanPlan v2 recipe。";
    setExtractionFields();
    setTaskSubmitEnabled(false);
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

function openProduct(productId: string): void {
  const product = productRecords.find((entry) => entry.productId === productId);
  if (!product) return;
  const form = byId<HTMLFormElement>("product-form");
  const facts = byId("product-public-facts");
  const publicProduct = reviewSurveyRecords.flatMap((survey) => survey.releases.flatMap((release) => release.products)).find((entry) => entry.productId === productId);
  facts.innerHTML = `<div class="section-heading"><div><span class="section-index">PUBLIC FACTS</span><h4>${escapeText(product.draft.name)}</h4></div><span class="section-note">read-only · /surveys/ source</span></div><dl class="product-fact-grid">${detailValue("survey", product.draft.surveyId)}${detailValue("release", product.draft.releaseId)}${detailValue("modality", publicProduct?.modality ?? product.draft.modality)}${detailValue("catalog status", publicProduct?.status)}${detailValue("description", publicProduct?.description)}${detailValue("coverage orders", (publicProduct?.coverage?.availableOrders ?? product.coverage?.availableOrders ?? product.draft.coverage?.availableOrders)?.map((order) => `O${order}`).join(" / "))}${detailValue("layer", publicProduct?.coverage?.layerId ?? product.draft.layerId)}</dl>`;
  (form.elements.namedItem("productId") as HTMLInputElement).value = productId;
  (form.elements.namedItem("summaryMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.summaryMarkdown;
  (form.elements.namedItem("methodologyMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.methodologyMarkdown;
  (form.elements.namedItem("limitationsMarkdown") as HTMLTextAreaElement).value = product.draft.presentation.limitationsMarkdown;
  (form.elements.namedItem("flowNodes") as HTMLTextAreaElement).value = JSON.stringify(product.draft.presentation.flow.nodes, null, 2);
  for (const [name, value] of Object.entries({ dataOrigin: product.draft.dataOrigin, sourceTier: product.draft.sourceTier, originNote: product.draft.originNote, sourceLabel: product.draft.sourceLabel, sourceUrl: product.draft.sourceUrl, geometrySourceLabel: product.draft.geometrySourceLabel, geometrySourceUrl: product.draft.geometrySourceUrl })) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) field.value = value ?? "";
  }
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
  const content = { ...product.draft, dataOrigin: formValue(form, "dataOrigin") || undefined, sourceTier: formValue(form, "sourceTier") || undefined, originNote: formValue(form, "originNote") || undefined, sourceLabel: formValue(form, "sourceLabel") || undefined, sourceUrl: formValue(form, "sourceUrl") || undefined, geometrySourceLabel: formValue(form, "geometrySourceLabel") || undefined, geometrySourceUrl: formValue(form, "geometrySourceUrl") || undefined, presentation: { summaryMarkdown: formValue(form, "summaryMarkdown"), methodologyMarkdown: formValue(form, "methodologyMarkdown"), limitationsMarkdown: formValue(form, "limitationsMarkdown"), flow: { nodes, edges: product.draft.presentation.flow.edges } } };
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
  const [connectors, tasks, products, reviewSurveys, catalogStatus, mocDiscovery] = await Promise.allSettled([
    api<{ connectors: Connector[] }>("/api/v1/admin/connectors"),
    api<{ tasks: Task[] }>("/api/v1/admin/tasks"),
    api<{ products: Product[] }>("/api/v1/admin/products"),
    api<{ surveys: ReviewSurvey[] }>("/api/v1/admin/products?view=surveys"),
    api<CatalogStatus>("/api/v1/admin/catalog/status"),
    api<{ requests: MocDiscoveryRequest[] }>("/api/v1/admin/moc-discovery"),
  ]);
  if (connectors.status === "fulfilled") renderConnectors(connectors.value.connectors);
  else toast(connectors.reason instanceof Error ? connectors.reason.message : "Connector 刷新失败", true);
  if (tasks.status === "fulfilled") renderTasks(tasks.value.tasks);
  else toast(tasks.reason instanceof Error ? tasks.reason.message : "任务刷新失败", true);
  if (products.status === "fulfilled") renderProducts(Array.isArray(products.value.products) ? products.value.products : []);
  else renderProductLoadError(products.reason instanceof Error ? products.reason.message : "产品刷新失败");
  if (reviewSurveys.status === "fulfilled") renderReviewSurveys(Array.isArray(reviewSurveys.value.surveys) ? reviewSurveys.value.surveys : []);
  else byId("product-list").innerHTML = `<div class="resource-empty">${escapeText(reviewSurveys.reason instanceof Error ? reviewSurveys.reason.message : "公共巡天刷新失败")}</div>`;
  if (mocDiscovery.status === "fulfilled") renderMocDiscoveryRequests(Array.isArray(mocDiscovery.value.requests) ? mocDiscovery.value.requests : []);
  else renderMocDiscoveryRequests([]);
  const connectorCount = connectors.status === "fulfilled" ? connectors.value.connectors.length : "--";
  const taskCount = tasks.status === "fulfilled" ? tasks.value.tasks.length : "--";
  const productCount = products.status === "fulfilled" ? products.value.products.length : "unknown";
  const mocCount = mocDiscovery.status === "fulfilled" ? mocDiscovery.value.requests.length : "--";
  const coverageState = catalogStatus.status === "fulfilled" ? `${catalogStatus.value.mode.toUpperCase()} · ${catalogStatus.value.footprints} FOOTPRINTS` : "COVERAGE UNAVAILABLE";
  byId("step-sources-count").textContent = String(connectorCount);
  byId("step-tasks-count").textContent = String(taskCount);
  byId("step-review-count").textContent = reviewSurveys.status === "fulfilled" ? String(reviewSurveys.value.surveys.length) : "unknown";
  byId("admin-status").textContent = `${connectorCount} CONNECTORS · ${taskCount} TASKS · ${mocCount} MOC REQUESTS · ${productCount} PRODUCTS · ${coverageState} · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
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
    field.required = visible && ["endpoint", "bucket", "accessKey", "secretKey", "pvcName"].includes(field.name);
    if (!visible) field.value = "";
  });
}

async function submitConnector(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = { name: formValue(form, "name"), type: formValue(form, "type"), endpoint: formValue(form, "endpoint") || undefined, region: formValue(form, "region") || undefined, bucket: formValue(form, "bucket") || undefined, prefix: formValue(form, "prefix") || undefined, accessKey: formValue(form, "accessKey") || undefined, secretKey: formValue(form, "secretKey") || undefined, pvcName: formValue(form, "pvcName") || undefined, basePath: formValue(form, "basePath") || undefined };
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
    name: formValue(form, "name"), productId: formValue(form, "productId") || undefined, sourceConnector: formValue(form, "sourceConnector"), sourcePaths: formValue(form, "sourcePaths").split(/\r?\n/).map((path) => path.trim()).filter(Boolean), allowedSuffixes: formValue(form, "allowedSuffixes") || undefined, maxOrder: Number(formValue(form, "maxOrder") || "8"), raColumn: formValue(form, "raColumn") || undefined, decColumn: formValue(form, "decColumn") || undefined, healpixColumn: formValue(form, "healpixColumn") || undefined, healpixOrderColumn: formValue(form, "healpixOrderColumn") || undefined, healpixOrder: formValue(form, "healpixOrder") ? Number(formValue(form, "healpixOrder")) : undefined, batchId: formValue(form, "batchId") || undefined,
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
byId("logout-button").addEventListener("click", () => { token = ""; sessionStorage.removeItem(tokenKey); connectorProbeResults.clear(); connectorRecords = []; showLogin(); });
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
byId<HTMLFormElement>("moc-discovery-form").addEventListener("submit", (event) => void submitMocDiscovery(event));
byId<HTMLFormElement>("moc-review-form").addEventListener("submit", (event) => void submitMocReview(event));
byId<HTMLFormElement>("product-form").addEventListener("submit", (event) => void saveProduct(event));
byId("product-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("product-dialog").close());
byId("task-product").addEventListener("change", (event) => setDerivedProduct((event.currentTarget as HTMLSelectElement).value));
byId("connector-type").addEventListener("change", updateConnectorFields);
byId("connector-create-button").addEventListener("click", () => byId<HTMLDialogElement>("connector-dialog").showModal());
byId("connector-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("connector-dialog").close());
byId("task-create-button").addEventListener("click", () => { setAdminStep("tasks"); byId<HTMLDialogElement>("task-dialog").showModal(); });
byId("task-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("task-dialog").close());
byId("task-detail-close").addEventListener("click", () => byId<HTMLDialogElement>("task-detail-dialog").close());
byId("moc-discovery-create-button").addEventListener("click", () => { setAdminStep("tasks"); byId<HTMLDialogElement>("moc-discovery-dialog").showModal(); });
byId("moc-discovery-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("moc-discovery-dialog").close());
byId("moc-review-dialog-cancel").addEventListener("click", () => byId<HTMLDialogElement>("moc-review-dialog").close());
byId("moc-review-retry").addEventListener("click", () => { const name = formValue(byId<HTMLFormElement>("moc-review-form"), "requestName"); if (name) void resubmitMocDiscovery(name); });
byId<HTMLInputElement>("product-search").addEventListener("input", (event) => {
  productQuery = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
  renderProducts(productRecords);
});
document.querySelectorAll<HTMLButtonElement>("[data-admin-step]").forEach((button) => button.addEventListener("click", () => setAdminStep(button.dataset.adminStep as AdminStep)));
window.addEventListener("popstate", () => setAdminStep(readAdminStep(), true));
setAdminStep(readAdminStep(), true);
updateConnectorFields();
void initialize();
