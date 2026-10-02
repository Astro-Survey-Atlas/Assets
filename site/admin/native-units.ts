import type { NativeSource, NativeTaskDocument, NativeBinding, NativeReport } from "../../server/native-unit-model.js";
import { reconcileMarkup } from "./stable-dom.js";

interface SourceView extends NativeSource { snapshots: Array<{ id: string; sourceRevision: number; rowCount?: number; capturedAt: string; sizeBytes: number; fileCount: number; active: boolean }> }
interface GroupView { id: string; digest: string; active: boolean; archived: boolean; createdAt: string; origin: string; inputCount: number; productCount: number; sizeBytes: number; bindings: NativeBinding[]; report: NativeReport; review?: { digest: string; at: string } }
export interface NativeView { active: string | null; generation: number; sources: SourceView[]; groups: GroupView[]; tasks: NativeTaskDocument[]; syncStatus?: { status: string } }
type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
const base = "/api/v1/admin/native-units";
const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const short = (id: string): string => id.slice(0, 12);
const bytes = (size: number): string => `${(size / 1024 / 1024).toFixed(1)} MiB`;
const operationNames: Record<string, string> = { baseline: "接管现有基线", discover: "核查官方来源", acquire: "获取与校验清单", import: "导入与校验清单", build: "构建候选索引", verify: "验证索引", archive: "归档输入与索引", activate: "激活索引", restore: "从归档恢复" };
const phaseNames: Record<string, string> = { queued: "排队", running: "执行中", activating: "激活中", "site-pending": "查询验证中", completed: "已完成", failed: "失败", cancelled: "已取消" };
const gapNames: Record<string, string> = { "candidate-files-unverified": "来源 URI 包含按官方规则生成的候选，尚未逐文件核验", "hst-unsupported-frames": "HST 未解析的坐标框架记录仍作为排除证据保留", "euclid-q1-partial-inventory": "Euclid Q1 仅限锁定的 BGSUB 清单", "euclid-ero-tile-inventory-missing": "Euclid ERO 使用锁定的 target 元数据，没有核实过的 Tile 清单", "euclid-ero-footprint-association-missing": "部分 ERO target 没有可核实的 ESA Sky footprint 关联" };
const gapLabel = (gap: string): string => gap.startsWith("hst-binding-not-in-snapshot:") ? `HST 产品 ${gap.slice("hst-binding-not-in-snapshot:".length)} 不在此锁定快照中；仅保留来源身份和访问入口` : gapNames[gap] ?? gap;

export function mountNativeUnits(options: { api: Api; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void; icons: () => void }) {
  let view: NativeView | undefined;
  const dialog = document.createElement("dialog"); dialog.className = "admin-dialog native-dialog"; dialog.id = "native-unit-dialog"; document.body.append(dialog);
  let submitForm: ((form: HTMLFormElement) => Promise<void>) | undefined;
  dialog.addEventListener("click", event => { if ((event.target as Element).closest("[data-native-close]")) dialog.close(); });
  dialog.addEventListener("submit", event => {
    event.preventDefault(); const form = event.target as HTMLFormElement;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!; button.disabled = true;
    void submitForm?.(form).then(() => { dialog.close(); return options.refresh(); }).catch(error => { const status = form.querySelector<HTMLElement>("[data-native-message]"); if (status) status.textContent = error instanceof Error ? error.message : "操作失败"; }).finally(() => { button.disabled = false; });
  });
  function open(title: string, content: string, handler?: (form: HTMLFormElement) => Promise<void>): void {
    submitForm = handler;
    dialog.innerHTML = `<div class="task-detail-heading"><h3>${esc(title)}</h3><button type="button" class="admin-quiet" data-native-close>关闭</button></div>${content}`;
    dialog.showModal(); options.icons();
  }
  function button(action: string, label: string, id = "", disabled = false): string { return `<button type="button" class="admin-quiet" data-native-action="${action}" data-native-id="${esc(id)}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`; }
  function groupRows(release = false): string {
    return view!.groups.slice().reverse().map(group => `<article class="native-row" data-row-key="${esc(group.id)}"><div><strong>${esc(short(group.id))} ${group.active ? "· 当前活动" : ""}</strong><p>${group.origin === "imported-baseline" ? "历史基线接管" : "受管构建"} · ${group.inputCount} 个输入来源 · ${group.productCount} 个产品 · ${bytes(group.sizeBytes)}</p><p>${group.report.checks.length && group.report.checks.every(check => check.passed) ? "验证通过" : "待验证"} · ${group.review ? "已审核" : "待审核"} · ${group.archived ? "已归档" : "待归档"} · ${esc(group.createdAt)}</p></div><div class="panel-actions">${button("detail", "详情与审核", group.id)}${button("bindings", "产品绑定", group.id)}${button("verify", "重新验证", group.id)}${release ? `${button("archive", "归档", group.id)}${button("activate", group.active ? "已生效" : "激活 / 回退到此版本", group.id, group.active || !group.review || !group.archived)}${button("restore", "恢复文件", group.id, !group.archived)}` : ""}</div></article>`).join("") || '<div class="resource-empty">先在任务中接管已有基线，再独立审核原生分块索引。</div>';
  }
  function tasks(): string {
    return view!.tasks.map(task => `<article class="native-row" data-row-key="${esc(task.id)}"><div><strong>${esc(operationNames[task.operation])} · ${esc(phaseNames[task.phase] ?? task.phase)}</strong><p>${esc(task.sourceId ?? task.groupId ?? "现有公开来源")} · ${esc(task.id)} · 尝试 ${task.attempts}</p><p role="status">${esc(task.error ?? task.progress ?? "等待执行")}${task.result?.noChange ? " · 输入内容无变化，复用原版本" : ""}</p></div>${["queued", "running"].includes(task.phase) ? button("cancel", "取消任务", task.id) : ""}</article>`).join("") || '<div class="resource-empty">暂无原生分块任务</div>';
  }
  function render(value: NativeView): void {
    view = value;
    const update = (id: string, markup: string) => { const root = document.getElementById(id); if (root) reconcileMarkup(root, markup); };
    const active = value.groups.find(group => group.active);
    update("native-overview", `<h4>原生天空分块</h4><p>${active ? `活动索引 ${short(active.id)} · generation ${value.generation} · ${active.productCount} 个产品绑定` : "已安装的历史索引 · 尚未完成受管接管"} · ${value.sources.length} 个来源 · ${esc(value.syncStatus?.status ?? "local")}</p><p>覆盖版本与分块版本分别审核；来源清单、验证报告和历史索引均保留。</p>`);
    update("native-sources", `<div class="section-heading"><h4>原生分块来源</h4><span>${value.sources.length} 个受管适配来源</span></div><p>官方元数据 → 锁定快照 → 候选索引 → 独立审核 → 激活。获取的内容为分块元数据。</p>${value.sources.map(source => `<article class="native-row" data-row-key="${esc(source.id)}"><div><strong>${esc(source.title)}</strong><p>${esc(source.surveyId)} / ${esc(source.releaseId)} · ${esc(source.unitKind)} · v${source.revision} · ${esc(source.adapter)}</p><p>${esc(source.scope)}</p><a href="${esc(source.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方来源</a><p>${source.snapshots.length ? `${source.snapshots.length} 个锁定快照；最新 ${source.snapshots.at(-1)?.rowCount ?? "—"} 条记录 / ${bytes(source.snapshots.at(-1)!.sizeBytes)}` : "未接管快照"}</p></div><div class="panel-actions">${button("edit", "编辑来源", source.id)}${button("discover", "核查", source.id)}${button("acquire", source.adapter === "entrypoint" ? "锁定 target 元数据" : "获取并校验", source.id)}${button("import", "导入清单", source.id)}</div></article>`).join("")}`);
    update("native-tasks", `<div class="section-heading"><h4>原生分块任务</h4><div class="panel-actions">${button("baseline", "接管现有索引与清单", "", Boolean(value.active))}${button("build", "从快照构建候选", "", !value.groups.length)}</div></div>${tasks()}`);
    update("native-review", `<div class="section-heading"><h4>原生分块索引审核</h4><span>独立于 MOC 与资源包版本</span></div>${groupRows()}`);
    update("native-releases", `<div class="section-heading"><h4>分块索引激活与恢复</h4><span>复用持久发布队列</span></div>${groupRows(true)}<details><summary>执行记录</summary>${tasks()}</details>`);
    const count = document.getElementById("task-tab-native-count"); if (count) count.textContent = String(value.tasks.length);
    options.icons();
  }
  async function submit(operation: string, extra: Record<string, unknown> = {}): Promise<void> {
    await options.api(base + "/tasks", { method: "POST", body: JSON.stringify({ operation, expectedActive: view!.active, ...extra }) });
    options.toast(`${operationNames[operation]}已提交到持久队列`); await options.refresh();
  }
  document.addEventListener("click", event => {
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-native-action]"); if (!target || !view) return;
    const action = target.dataset.nativeAction!, id = target.dataset.nativeId!;
    const source = view.sources.find(source => source.id === id); const group = view.groups.find(group => group.id === id);
    void (async () => {
      target.disabled = true;
      if (["acquire", "discover"].includes(action)) await submit(action, { sourceId: id, sourceRevision: source!.revision });
      else if (action === "baseline") await submit(action);
      else if (["verify", "archive", "restore", "activate"].includes(action)) await submit(action, { groupId: id, reviewDigest: group!.digest });
      else if (action === "cancel") { await options.api(`${base}/tasks/${id}/cancel`, { method: "POST" }); await options.refresh(); }
      else if (action === "build") {
        open("选择已校验的来源快照", `<form class="admin-form"><p>每个来源选择一个版本；未选来源沿用活动版本。</p>${view!.sources.filter(source => source.snapshots.length).map(source => `<label>${esc(source.title)}<select name="snapshotId"><option value="">沿用活动输入</option>${source.snapshots.slice().reverse().map(snapshot => `<option value="${snapshot.id}">${short(snapshot.id)} · source v${snapshot.sourceRevision} · ${snapshot.rowCount ?? "—"} rows · ${esc(snapshot.capturedAt)}</option>`).join("")}</select></label>`).join("")}<p data-native-message role="status"></p><button class="admin-primary" type="submit">构建候选索引</button></form>`, async form => { const ids = new FormData(form).getAll("snapshotId").filter(Boolean); await submit("build", { snapshotIds: ids }); });
      } else if (action === "edit") {
        open("编辑分块来源", `<form class="admin-form"><p>身份 ${esc(source!.id)} · v${source!.revision}。修改后需获取、构建并重新审核。</p><label>名称<input name="title" value="${esc(source!.title)}" required></label><label>范围<textarea name="scope" required>${esc(source!.scope)}</textarea></label><label>官方元数据 URL<input type="url" name="sourceUrl" value="${esc(source!.sourceUrl)}" required></label>${source!.files.length > 1 ? source!.files.map(file => `<label>输入 ${esc(file.slot ?? "metadata")} URL<input type="url" name="fileUrl" value="${esc(file.sourceUrl)}" required></label>`).join("") : ""}${source!.query ? `<label>元数据查询<textarea name="query">${esc(source!.query)}</textarea></label>` : ""}<p data-native-message role="status"></p><button class="admin-primary" type="submit">保存来源版本</button></form>`, async form => { await options.api(`${base}/sources/${id}`, { method: "PUT", body: JSON.stringify({ revision: source!.revision, ...Object.fromEntries(new FormData(form)), ...(source!.files.length > 1 ? { fileUrls: new FormData(form).getAll("fileUrl") } : {}) }) }); });
      } else if (action === "import") {
        open("导入已暂存的官方元数据", `<form class="admin-form"><p>文件须已位于 Assets evidence 存储。按来源文件顺序填写 JSON 引用；HST 填一个 manifest，所有 SHA 锁定的 page 文件保留其目录结构。</p><label>文件引用<textarea name="files" rows="7" required placeholder='[{"ref":"managed/inputs/metadata.fits.gz","sha256":"…","sizeBytes":123}]'></textarea></label><p data-native-message role="status"></p><button class="admin-primary" type="submit">校验并锁定导入</button></form>`, async form => { await submit("import", { sourceId: id, sourceRevision: source!.revision, files: JSON.parse(String(new FormData(form).get("files"))) }); });
      } else if (action === "bindings") {
        const { bindings: choices } = await options.api<{ bindings: NativeBinding[] }>(base + "/bindings");
        open("编辑原生分块产品绑定", `<form class="admin-form"><p>保存为新的候选版本，随后验证、审核并激活。</p>${choices.map(binding => `<label class="native-gap"><input type="checkbox" name="productId" value="${esc(binding.productId)}" ${group!.bindings.some(current => current.productId === binding.productId) ? "checked" : ""}>${esc(binding.surveyId)} / ${esc(binding.releaseId)} / ${esc(binding.product)} · ${esc(binding.modality)}</label>`).join("")}<p data-native-message role="status"></p><button class="admin-primary" type="submit">保存候选绑定</button></form>`, async form => { await options.api(`${base}/groups/${id}/bindings`, { method: "PUT", body: JSON.stringify({ digest: group!.digest, productIds: new FormData(form).getAll("productId") }) }); options.toast("候选绑定已保存；需要重新验证和审核"); });
      } else if (action === "detail") {
        const detail = await options.api<{ bindings: NativeBinding[]; report: NativeReport; inputs: Array<{ sourceId: string; rowCount?: number; scope: string }>; digest: string }>(`${base}/groups/${id}`);
        open(`索引 ${short(id)} · 验证与审核`, `<form class="admin-form"><p>${group!.active ? "当前活动索引" : "候选 / 历史索引"} · ${group!.archived ? "输入和索引已归档" : "输入和索引待归档"}</p><h4>验证</h4>${detail.report.checks.map(check => `<p>${check.passed ? "✓" : "✕"} ${esc(check.id)} · ${esc(check.detail)}</p>`).join("")}<p>峰值 RSS ${detail.report.peakRssMiB ?? "—"} MiB · ${detail.report.elapsedMs ?? "—"} ms</p><details><summary>输入范围</summary>${detail.inputs.map(input => `<p>${esc(input.sourceId)} · ${input.rowCount ?? "—"} rows · ${esc(input.scope)}</p>`).join("")}</details><details><summary>产品绑定 ${detail.bindings.length}</summary>${detail.bindings.map(binding => `<p>${esc(binding.surveyId)} / ${esc(binding.releaseId)} / ${esc(binding.product)} · ${esc(binding.modality)} · ${esc(binding.unitKind)} · ${esc(short(binding.revision))}</p>`).join("")}</details><details><summary>真实查询样例</summary>${detail.report.samples.map(sample => `<p>${esc(sample.layerId)} · ${esc(sample.unitId)} · O${sample.order} · ${esc(sample.precision)}<br>${sample.uris.map(uri => `<a href="${esc(uri)}" target="_blank" rel="noopener noreferrer">${esc(uri)}</a>`).join("<br>")}</p>`).join("")}</details><h4>逐项接受已知缺口</h4>${detail.report.gaps.map(gap => `<label class="native-gap"><input type="checkbox" name="acceptedGaps" value="${esc(gap)}" required>${esc(gapLabel(gap))}</label>`).join("")}<p data-native-message role="status"></p><button class="admin-primary" type="submit" ${detail.report.checks.length && detail.report.checks.every(check => check.passed) ? "" : "disabled"}>审核此分块版本</button></form>`, async form => { await options.api(`${base}/groups/${id}/review`, { method: "POST", body: JSON.stringify({ digest: detail.digest, acceptedGaps: new FormData(form).getAll("acceptedGaps") }) }); options.toast("原生分块版本已独立审核"); });
      }
    })().catch(error => options.toast(error instanceof Error ? error.message : "原生分块操作失败", true)).finally(() => {
      if (target.isConnected) {
        const current = view?.groups.find(group => group.id === id);
        target.disabled = action === "activate" ? Boolean(current?.active || !current?.review || !current?.archived)
          : action === "baseline" ? Boolean(view?.active) : false;
      }
    });
  });
  return { render };
}
