import type { NativeSource, NativeTaskDocument, NativeBinding, NativeReport } from "../../server/native-unit-model.js";
import type { NativeDiffState, NativeGroupComparison, NativeSnapshotSummary } from "../../server/native-unit-comparison.js";
import { reconcileMarkup } from "./stable-dom.js";
import { mountRecordTabs } from "./task-tabs.js";

interface SourceView extends NativeSource { snapshots: Array<{ id: string; sourceRevision: number; rowCount?: number; capturedAt: string; sizeBytes: number; fileCount: number; active: boolean }> }
interface GroupView { id: string; digest: string; active: boolean; archived: boolean; createdAt: string; origin: string; inputCount: number; productCount: number; sizeBytes: number; bindings: NativeBinding[]; report: NativeReport; comparison: Pick<NativeGroupComparison, "baseline" | "hasChanges" | "summary">; review?: { digest: string; at: string } }
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
const surveyLabels: Record<string, string> = { euclid: "Euclid", desi: "DESI", "legacy-surveys": "Legacy Surveys", hst: "HST", "hsc-ssp": "HSC-SSP" };
const unitLabels: Record<string, string> = { tile: "Tile", brick: "Brick", target: "Target", observation: "Observation", "tract/patch": "Tract / patch" };
const diffLabels: Record<NativeDiffState, string> = { unchanged: "未变化", modified: "修改", added: "新增", removed: "移除" };
const bindingFieldLabels: Record<string, string> = { productId: "产品 ID", layerId: "图层", surveyId: "巡天", releaseId: "Release", product: "产品名称", modality: "模态", unitKind: "分块类型", sourceIds: "来源绑定", selector: "产品筛选", visibility: "可见性", instrument: "仪器", filters: "滤镜", observationId: "观测 ID" };
const actionIcons: Record<string, string> = { edit: "pencil", discover: "search", acquire: "download", import: "file-input", detail: "clipboard-list", bindings: "link-2", verify: "badge-check", archive: "archive", activate: "circle-check", restore: "rotate-ccw", cancel: "x" };
const phaseTone: Record<string, string> = { queued: "queued", running: "running", activating: "running", "site-pending": "warning", completed: "complete", failed: "failed", cancelled: "muted" };

export function mountNativeUnits(options: { api: Api; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void; icons: () => void }) {
  let view: NativeView | undefined;
  let sourceSearch = sessionStorage.getItem("assets-admin-native-source-search") ?? "";
  let sourceSurvey = sessionStorage.getItem("assets-admin-native-source-survey") ?? "all";
  const mountedTabs = new Set<string>();
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
  function button(action: string, label: string, id = "", disabled = false): string {
    const icon = actionIcons[action] ?? "circle-dot";
    return `<button type="button" class="admin-quiet native-action" data-native-action="${action}" data-native-id="${esc(id)}" title="${esc(label)}" aria-label="${esc(label)}" ${disabled ? "disabled" : ""}><i data-lucide="${icon}"></i><span>${esc(label)}</span></button>`;
  }
  function badge(label: string, tone = "muted"): string { return `<span class="native-badge" data-tone="${esc(tone)}">${esc(label)}</span>`; }
  function diffBadge(state: NativeDiffState): string { return `<span class="native-badge" data-tone="${state === "added" ? "complete" : state === "modified" ? "warning" : state === "removed" ? "failed" : "muted"}">${diffLabels[state]}</span>`; }
  function diffValue(value: unknown): string { return value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value); }
  function snapshotDescription(value?: NativeSnapshotSummary): string {
    if (!value) return "无对应快照";
    return `source v${value.sourceRevision} · ${value.rowCount?.toLocaleString("en-US") ?? "—"} 行 · ${value.files.length} 个文件 · ${value.files.map(file => file.sha256.slice(0, 12)).join(", ") || "无文件"}`;
  }
  function sourceMarkup(): string {
    const sources = view!.sources.filter(source => {
      const surveyMatch = sourceSurvey === "all" || (sourceSurvey === "other" ? !surveyLabels[source.surveyId] : source.surveyId === sourceSurvey);
      const query = sourceSearch.trim().toLocaleLowerCase();
      const searchable = [source.title, source.id, source.surveyId, source.releaseId, source.unitKind, source.adapter, source.scope].join(" ").toLocaleLowerCase();
      return surveyMatch && (!query || searchable.includes(query));
    });
    const groups = new Map<string, SourceView[]>();
    for (const source of sources) groups.set(source.surveyId, [...(groups.get(source.surveyId) ?? []), source]);
    const groupList = [...groups.entries()].sort(([left], [right]) => (surveyLabels[left] ?? left).localeCompare(surveyLabels[right] ?? right))
      .map(([surveyId, entries]) => `<section class="native-source-group" data-row-key="source-group:${esc(surveyId)}"><h5>${esc(surveyLabels[surveyId] ?? surveyId)}<span>${entries.length}</span></h5><div>${entries.map(source => {
        const latest = source.snapshots.at(-1);
        return `<details class="native-source-row" data-row-key="${esc(source.id)}"><summary><span class="native-source-copy"><strong>${esc(source.title)}</strong><small>${esc(source.releaseId)} · ${esc(unitLabels[source.unitKind] ?? source.unitKind)} · ${source.snapshots.length ? `${latest?.rowCount?.toLocaleString("en-US") ?? "—"} 条 / ${bytes(latest?.sizeBytes ?? 0)}` : "尚无锁定快照"}</small></span><span class="native-source-state">${badge(source.snapshots.length ? "已锁定" : "待获取", source.snapshots.length ? "complete" : "warning")}<i data-lucide="chevron-down"></i></span></summary><div class="native-source-detail"><dl><div><dt>来源身份</dt><dd><code>${esc(source.id)}</code> · v${source.revision} · ${esc(source.adapter)}</dd></div><div><dt>适用范围</dt><dd>${esc(source.scope)}</dd></div>${latest ? `<div><dt>最新快照</dt><dd>${latest.fileCount} 个文件 · ${esc(latest.capturedAt)} · ${esc(short(latest.id))}</dd></div>` : ""}</dl><a class="native-source-link" href="${esc(source.sourceUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i><span>官方来源</span></a><div class="native-row-actions">${button("edit", "编辑来源", source.id)}${button("discover", "核查", source.id)}${button("acquire", source.adapter === "entrypoint" ? "锁定 target 元数据" : "获取并校验", source.id)}${button("import", "导入清单", source.id)}</div></div></details>`;
      }).join("")}</div></section>`).join("");
    return `<div class="section-heading native-section-heading"><div><span class="section-index">NATIVE SOURCES</span><h4>原生分块来源</h4></div><span class="section-note">${sources.length} / ${view!.sources.length} 个来源</span></div><div class="native-source-toolbar"><label class="admin-product-search"><span>查找来源</span><input id="native-source-search" type="search" autocomplete="off" placeholder="名称、release 或分块类型" value="${esc(sourceSearch)}" /></label><label><span>巡天</span><select id="native-source-survey"><option value="all" ${sourceSurvey === "all" ? "selected" : ""}>全部巡天</option>${[...new Set(view!.sources.map(source => source.surveyId))].sort((a, b) => (surveyLabels[a] ?? a).localeCompare(surveyLabels[b] ?? b)).map(id => `<option value="${esc(id)}" ${sourceSurvey === id ? "selected" : ""}>${esc(surveyLabels[id] ?? id)}</option>`).join("")}</select></label></div>${groupList || '<div class="resource-empty">没有符合条件的原生来源。</div>'}`;
  }
  function groupRows(groups: GroupView[], release = false): string {
    return groups.slice().sort((left, right) => Number(right.active) - Number(left.active) || right.createdAt.localeCompare(left.createdAt)).map(group => {
      const checksPassed = group.report.checks.length > 0 && group.report.checks.every(check => check.passed);
      const sameAsActive = !group.active && group.comparison.hasChanges === false;
      const state = group.active ? badge("当前活动", "complete") : sameAsActive ? badge("与活动版相同", "muted") : group.review && group.archived ? badge("可激活", "complete") : group.review ? badge("已审核 · 待归档", "warning") : badge("候选待审核", checksPassed ? "warning" : "failed");
      const comparison = group.comparison.hasChanges === null
        ? "首个托管基线 · 暂无活动版可比较"
        : group.comparison.hasChanges === false
          ? `与 Generation ${group.comparison.baseline?.generation ?? "—"} 内容相同`
          : `对照 Generation ${group.comparison.baseline?.generation ?? "—"} · 产品 +${group.comparison.summary.products.added} / ~${group.comparison.summary.products.modified} / -${group.comparison.summary.products.removed}`;
      return `<article class="native-version-row" data-row-key="${esc(group.id)}"><div class="native-version-main"><div class="native-version-title"><strong title="${esc(group.id)}">${esc(short(group.id))}</strong>${state}<span class="native-version-date">${esc(group.createdAt)}</span></div><div class="native-version-meta"><span>${group.origin === "imported-baseline" ? "基线接管" : "受管构建"}</span><span>${group.inputCount} 个来源</span><span>${group.productCount} 个产品绑定</span><span>${bytes(group.sizeBytes)}</span><span>${checksPassed ? "验证通过" : "待验证"}</span><span class="native-version-comparison">${esc(comparison)}</span></div><details class="native-version-details"><summary>查看索引摘要</summary><div><span>Digest <code>${esc(group.digest)}</code></span><span>活动版 ${group.comparison.baseline ? `Generation ${group.comparison.baseline.generation} · ${esc(short(group.comparison.baseline.groupId))}` : "尚未建立"}</span><span>审核 ${group.review ? esc(group.review.at) : "尚未审核"}</span><span>归档 ${group.archived ? "完成" : "尚未归档"}</span><span>执行来源 ${esc(group.origin)}</span></div></details></div><div class="native-version-actions">${button("detail", "详情与审核", group.id)}${button("bindings", "产品绑定", group.id)}${button("verify", "重新验证", group.id)}${release ? `${button("archive", "归档", group.id, group.archived)}${button("activate", group.active ? "当前活动" : "激活 / 回退", group.id, group.active || !group.review || !group.archived)}${button("restore", "恢复文件", group.id, !group.archived)}` : ""}</div></article>`;
    }).join("") || '<div class="resource-empty">暂无符合条件的原生索引版本</div>';
  }
  function tasks(): string {
    return view!.tasks.slice().reverse().map(task => {
      const phase = phaseNames[task.phase] ?? task.phase;
      const scope = task.sourceId ? view!.sources.find(source => source.id === task.sourceId)?.title ?? task.sourceId : task.groupId ? short(task.groupId) : "原生索引";
      return `<article class="native-task-row" data-row-key="${esc(task.id)}"><div class="native-task-state">${badge(phase, phaseTone[task.phase] ?? "muted")}</div><div class="native-task-content"><strong>${esc(operationNames[task.operation] ?? task.operation)} · ${esc(scope)}</strong><small>${esc(task.id)} · 第 ${task.attempts} 次尝试</small><p role="status">${esc(task.error ?? task.progress ?? "等待执行")}${task.result?.noChange ? " · 输入内容无变化，复用原版本" : ""}</p></div><div class="native-task-actions">${["queued", "running"].includes(task.phase) ? button("cancel", "取消任务", task.id) : ""}</div></article>`;
    }).join("") || '<div class="resource-empty">暂无原生分块任务</div>';
  }
  function comparisonMarkup(detail: NativeGroupComparison, group: GroupView): string {
    const stateLabel = (state: NativeDiffState) => diffBadge(state);
    const firstBaseline = detail.hasChanges === null;
    const changedProducts = firstBaseline ? [] : detail.products.filter(item => item.state !== "unchanged");
    const unchangedProducts = detail.products.filter(item => item.state === "unchanged");
    const productName = (binding?: NativeBinding) => binding ? `${binding.surveyId} / ${binding.releaseId} / ${binding.product}` : "无绑定";
    const productChanges = changedProducts.map(item => {
      const binding = item.candidate ?? item.active;
      const fields = item.bindingFields.map(field => {
        const before = item.active ? (item.active as unknown as Record<string, unknown>)[field] : undefined;
        const after = item.candidate ? (item.candidate as unknown as Record<string, unknown>)[field] : undefined;
        return `<li><strong>${esc(bindingFieldLabels[field] ?? field)}</strong><span>${esc(diffValue(before))} → ${esc(diffValue(after))}</span></li>`;
      });
      const snapshots = item.changes.filter(change => change.startsWith("snapshot:")).map(change => {
        const sourceId = change.slice("snapshot:".length);
        const source = view?.sources.find(entry => entry.id === sourceId);
        const input = detail.inputs.find(entry => entry.sourceId === sourceId);
        return `<li><strong>${esc(source?.title ?? sourceId)} · 输入快照</strong><span>${esc(input?.candidate?.scope ?? input?.active?.scope ?? sourceId)}</span></li>`;
      });
      const bindingChange = item.state === "added" || item.state === "removed"
        ? `<p>${esc(productName(binding))} · ${esc(binding?.layerId ?? "")}</p>`
        : "";
      return `<article class="native-diff-row" data-state="${item.state}"><div class="native-diff-heading">${stateLabel(item.state)}<strong>${esc(item.productId)}</strong></div>${bindingChange}${fields.length || snapshots.length ? `<ul>${fields.join("")}${snapshots.join("")}</ul>` : ""}</article>`;
    }).join("");
    const unchangedProductMarkup = firstBaseline
      ? `<details class="native-diff-unchanged"><summary>基线产品绑定 · ${detail.products.length}</summary><div>${detail.products.map(item => `<p><code>${esc(item.productId)}</code> · ${esc(productName(item.candidate))} · ${esc(item.candidate?.layerId ?? "")}</p>`).join("") || "<p>无</p>"}</div></details>`
      : `<details class="native-diff-unchanged"><summary>未变化产品绑定 · ${unchangedProducts.length}</summary><div>${unchangedProducts.map(item => `<p><code>${esc(item.productId)}</code> · ${esc(productName(item.candidate))} · ${esc(item.candidate?.layerId ?? "")}</p>`).join("") || "<p>无</p>"}</div></details>`;

    const changedInputs = firstBaseline ? [] : detail.inputs.filter(item => item.state !== "unchanged");
    const unchangedInputs = detail.inputs.filter(item => item.state === "unchanged");
    const inputMarkup = changedInputs.map(item => {
      const title = view?.sources.find(source => source.id === item.sourceId)?.title ?? item.sourceId;
      return `<article class="native-diff-row" data-state="${item.state}"><div class="native-diff-heading">${stateLabel(item.state)}<strong>${esc(title)}</strong></div><code>${esc(item.sourceId)}</code><ul><li><strong>活动版</strong><span>${esc(snapshotDescription(item.active))}</span></li><li><strong>候选版</strong><span>${esc(snapshotDescription(item.candidate))}</span></li></ul><p>${esc(item.candidate?.scope ?? item.active?.scope ?? "")}</p></article>`;
    }).join("");
    const unchangedInputMarkup = firstBaseline
      ? `<details class="native-diff-unchanged"><summary>基线锁定输入 · ${detail.inputs.length}</summary><div>${detail.inputs.map(item => `<p><code>${esc(item.sourceId)}</code> · ${esc(snapshotDescription(item.candidate))}</p>`).join("") || "<p>无</p>"}</div></details>`
      : `<details class="native-diff-unchanged"><summary>未变化来源快照 · ${unchangedInputs.length}</summary><div>${unchangedInputs.map(item => `<p><code>${esc(item.sourceId)}</code> · ${esc(snapshotDescription(item.candidate))}</p>`).join("") || "<p>无</p>"}</div></details>`;

    const changedArtifacts = firstBaseline ? [] : detail.artifacts.filter(item => item.state !== "unchanged");
    const unchangedArtifacts = detail.artifacts.filter(item => item.state === "unchanged");
    const artifactMarkup = changedArtifacts.map(item => `<article class="native-diff-row" data-state="${item.state}"><div class="native-diff-heading">${stateLabel(item.state)}<strong>${esc(item.label)}</strong></div><ul><li><strong>活动版</strong><span>${item.activeDigest ? esc(item.activeDigest.slice(0, 16)) : "无制品"}</span></li><li><strong>候选版</strong><span>${item.candidateDigest ? esc(item.candidateDigest.slice(0, 16)) : "无制品"}</span></li></ul></article>`).join("");
    const unchangedArtifactMarkup = firstBaseline
      ? `<details class="native-diff-unchanged"><summary>基线索引制品 · ${detail.artifacts.length}</summary><div>${detail.artifacts.map(item => `<p>${esc(item.label)} · ${esc(item.candidateDigest?.slice(0, 16) ?? "")}</p>`).join("") || "<p>无</p>"}</div></details>`
      : `<details class="native-diff-unchanged"><summary>未变化索引制品 · ${unchangedArtifacts.length}</summary><div>${unchangedArtifacts.map(item => `<p>${esc(item.label)} · ${esc(item.candidateDigest?.slice(0, 16) ?? "")}</p>`).join("") || "<p>无</p>"}</div></details>`;

    let baseline: string;
    let summary: string;
    if (detail.hasChanges === null) {
      baseline = "当前没有活动托管版本。这是首个托管基线，以下内容不标为相对前版新增或修改。";
      summary = `${group.productCount} 个基线产品绑定 · ${group.inputCount} 个锁定输入 · ${detail.artifacts.length} 个索引制品`;
    } else {
      const generation = detail.baseline?.generation ?? "—";
      const groupId = detail.baseline?.groupId ?? "";
      baseline = `对照活动版 Generation ${generation} · ${groupId ? short(groupId) : "无"}`;
      summary = `产品绑定：${detail.summary.products.added} 新增 · ${detail.summary.products.modified} 修改 · ${detail.summary.products.removed} 移除 · ${detail.summary.products.unchanged} 未变化；输入快照：${detail.summary.inputs.added} 新增 · ${detail.summary.inputs.modified} 修改 · ${detail.summary.inputs.removed} 移除 · 制品变化 ${detail.summary.changedArtifacts} 项`;
      if (detail.hasChanges === false) baseline += " · 内容完全相同，不能重复审核";
    }
    const productDiffBody = firstBaseline ? `<p class="native-diff-empty">首个托管基线，没有可比较的前版差异。</p>` : productMarkupOrEmpty(productChanges, "没有新增、修改或移除的产品绑定。");
    const inputDiffBody = firstBaseline ? `<p class="native-diff-empty">首个托管基线，没有可比较的前版差异。</p>` : productMarkupOrEmpty(inputMarkup, "没有新增、修改或移除的输入快照。");
    const artifactDiffBody = firstBaseline ? `<p class="native-diff-empty">首个托管基线，没有可比较的前版差异。</p>` : productMarkupOrEmpty(artifactMarkup, "索引制品与活动版一致。");
    return `<section class="native-comparison" data-identical="${detail.hasChanges === false}"><div class="native-comparison-heading"><div><h4>与活动版比较</h4><p>${esc(baseline)}</p></div><strong>${esc(summary)}</strong></div><p class="native-comparison-scope">比较产品绑定、锁定来源快照摘要和索引制品；不逐条比较原生分块记录。</p><section><h5>产品绑定差异</h5>${productDiffBody}${unchangedProductMarkup}</section><section><h5>锁定来源快照</h5>${inputDiffBody}${unchangedInputMarkup}</section><section><h5>索引制品</h5>${artifactDiffBody}${unchangedArtifactMarkup}</section></section>`;
  }
  function productMarkupOrEmpty(markup: string, empty: string): string { return markup || `<p class="native-diff-empty">${esc(empty)}</p>`; }
  function technicalEvidenceMarkup(detail: { report: NativeReport; inputs: Array<{ sourceId: string; sourceRevision: number; rowCount?: number; scope: string; sourceUrl: string; capturedAt: string; files: Array<{ ref: string; sha256: string; sizeBytes: number }> }> }): string {
    return `<details class="native-technical-evidence"><summary>技术证据 · ${detail.inputs.length} 个输入 · ${detail.report.samples.length} 个查询样例</summary><div><p>峰值 RSS ${detail.report.peakRssMiB ?? "—"} MiB · 执行耗时 ${detail.report.elapsedMs ?? "—"} ms</p><section><h5>输入快照</h5>${detail.inputs.map(input => `<article><strong>${esc(input.sourceId)} · source v${input.sourceRevision}</strong><span>${input.rowCount?.toLocaleString("en-US") ?? "—"} 行 · ${esc(input.scope)} · ${esc(input.capturedAt)}</span>${input.files.map(file => `<code>${esc(file.sha256)} · ${bytes(file.sizeBytes)} · ${esc(file.ref)}</code>`).join("")}</article>`).join("") || "<p>无锁定输入</p>"}</section><section><h5>真实查询样例</h5>${detail.report.samples.map(sample => `<article><strong>${esc(sample.layerId)} · ${esc(sample.unitKind)} ${esc(sample.unitId)}</strong><span>O${sample.order} · ${esc(sample.precision)} · ${sample.cells.length} 个命中 cell</span>${sample.uris.map(uri => `<a href="${esc(uri)}" target="_blank" rel="noopener noreferrer">${esc(uri)}</a>`).join("")}</article>`).join("") || "<p>无查询样例</p>"}</section></div></details>`;
  }
  function restoreTab(root: HTMLElement | null, prefix: string, values: readonly string[], key: string): void {
    if (!root) return;
    const saved = sessionStorage.getItem(key);
    if (!saved || !values.includes(saved)) return;
    root.querySelectorAll<HTMLButtonElement>(`[data-${prefix}-tab]`).forEach(tab => {
      const selected = tab.getAttribute(`data-${prefix}-tab`) === saved;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    root.querySelectorAll<HTMLElement>(`[data-${prefix}-panel]`).forEach(panel => {
      panel.hidden = panel.getAttribute(`data-${prefix}-panel`) !== saved;
    });
  }
  function render(value: NativeView): void {
    view = value;
    const update = (id: string, markup: string) => { const root = document.getElementById(id); if (root) reconcileMarkup(root, markup); };
    const active = value.groups.find(group => group.active);
    update("native-overview", `<div class="native-overview-heading"><div><span class="section-index">NATIVE INDEX</span><h4>原生天空分块</h4></div>${badge(value.syncStatus?.status === "synced" ? "状态已同步" : value.syncStatus?.status ?? "本地", value.syncStatus?.status === "synced" ? "complete" : "warning")}</div><div class="native-overview-stats"><div><span>活动版本</span><strong title="${active ? esc(active.id) : "尚未激活"}">${active ? esc(short(active.id)) : "—"}</strong></div><div><span>索引代次</span><strong>${value.generation}</strong></div><div><span>产品关联</span><strong>${active?.productCount ?? 0}</strong></div><div><span>受管来源</span><strong>${value.sources.length}</strong></div></div>${active ? `<details class="native-overview-details"><summary>活动版本详情</summary><div><span>SHA-256 <code>${esc(active.id)}</code></span><span>内容检查 ${active.report.checks.filter(check => check.passed).length} / ${active.report.checks.length} 通过</span><span>索引状态 ${active.review ? "已审核" : "未审核"} · ${active.archived ? "依赖已归档" : "依赖未归档"}</span></div></details>` : '<p class="native-overview-empty">尚无通过审核并激活的原生索引</p>'}`);
    update("native-sources", sourceMarkup());
    update("native-tasks", `<div class="section-heading"><h4>原生分块任务</h4><div class="panel-actions">${button("baseline", "接管现有索引与清单", "", Boolean(value.active))}${button("build", "从快照构建候选", "", !value.groups.length)}</div></div>${tasks()}`);
    const reviewRoot = document.getElementById("native-review");
    update("native-review", `<div class="section-heading native-section-heading"><div><span class="section-index">NATIVE REVIEW</span><h4>原生分块索引审核</h4></div><span class="section-note">${value.groups.length} 个版本</span></div><nav class="native-version-tabs" role="tablist" aria-label="原生版本审核"><button id="native-review-pending-tab" type="button" role="tab" data-native-review-tab="pending" aria-controls="native-review-pending" aria-selected="true">待审核 <output>${value.groups.filter(group => !group.review).length}</output></button><button id="native-review-reviewed-tab" type="button" role="tab" data-native-review-tab="reviewed" aria-controls="native-review-reviewed" aria-selected="false" tabindex="-1">已审核 <output>${value.groups.filter(group => group.review).length}</output></button></nav><section id="native-review-pending" data-native-review-panel="pending" role="tabpanel" aria-labelledby="native-review-pending-tab">${groupRows(value.groups.filter(group => !group.review))}</section><section id="native-review-reviewed" data-native-review-panel="reviewed" role="tabpanel" aria-labelledby="native-review-reviewed-tab" hidden>${groupRows(value.groups.filter(group => group.review))}</section>`);
    restoreTab(reviewRoot, "native-review", ["pending", "reviewed"], "assets-admin-native-review-tab");
    if (reviewRoot && !mountedTabs.has("review")) { mountRecordTabs(reviewRoot, "native-review", ["pending", "reviewed"] as const, "assets-admin-native-review-tab"); mountedTabs.add("review"); }
    const releaseRoot = document.getElementById("native-releases");
    update("native-releases", `<div class="section-heading native-section-heading"><div><span class="section-index">NATIVE RELEASE</span><h4>索引激活与恢复</h4></div><span class="section-note">Generation ${value.generation}</span></div><nav class="native-version-tabs" role="tablist" aria-label="原生索引发布"><button id="native-release-ready-tab" type="button" role="tab" data-native-release-tab="ready" aria-controls="native-release-ready" aria-selected="true">可激活 <output>${value.groups.filter(group => !group.active && group.review && group.archived).length}</output></button><button id="native-release-active-tab" type="button" role="tab" data-native-release-tab="active" aria-controls="native-release-active" aria-selected="false" tabindex="-1">活动版本 <output>${value.groups.filter(group => group.active).length}</output></button><button id="native-release-history-tab" type="button" role="tab" data-native-release-tab="history" aria-controls="native-release-history" aria-selected="false" tabindex="-1">其他版本 <output>${value.groups.filter(group => !group.active && !(group.review && group.archived)).length}</output></button></nav><section id="native-release-ready" data-native-release-panel="ready" role="tabpanel" aria-labelledby="native-release-ready-tab">${groupRows(value.groups.filter(group => !group.active && group.review && group.archived), true)}</section><section id="native-release-active" data-native-release-panel="active" role="tabpanel" aria-labelledby="native-release-active-tab" hidden>${groupRows(value.groups.filter(group => group.active), true)}</section><section id="native-release-history" data-native-release-panel="history" role="tabpanel" aria-labelledby="native-release-history-tab" hidden>${groupRows(value.groups.filter(group => !group.active && !(group.review && group.archived)), true)}</section><details class="native-task-history"><summary>原生索引执行记录 <span>${value.tasks.length}</span></summary>${tasks()}</details>`);
    restoreTab(releaseRoot, "native-release", ["ready", "active", "history"], "assets-admin-native-release-tab");
    if (releaseRoot && !mountedTabs.has("release")) { mountRecordTabs(releaseRoot, "native-release", ["ready", "active", "history"] as const, "assets-admin-native-release-tab"); mountedTabs.add("release"); }
    const sourceRoot = document.getElementById("native-sources");
    if (sourceRoot && !mountedTabs.has("sources")) {
      sourceRoot.addEventListener("input", event => { const target = event.target as HTMLInputElement; if (target.id !== "native-source-search") return; sourceSearch = target.value; sessionStorage.setItem("assets-admin-native-source-search", sourceSearch); if (view) reconcileMarkup(sourceRoot, sourceMarkup()); options.icons(); });
      sourceRoot.addEventListener("change", event => { const target = event.target as HTMLSelectElement; if (target.id !== "native-source-survey") return; sourceSurvey = target.value; sessionStorage.setItem("assets-admin-native-source-survey", sourceSurvey); if (view) reconcileMarkup(sourceRoot, sourceMarkup()); options.icons(); });
      mountedTabs.add("sources");
    }
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
        const detail = await options.api<{
          digest: string;
          bindings: NativeBinding[];
          report: NativeReport;
          comparison: NativeGroupComparison;
          inputs: Array<{ sourceId: string; sourceRevision: number; rowCount?: number; scope: string; sourceUrl: string; capturedAt: string; files: Array<{ ref: string; sha256: string; sizeBytes: number }> }>;
        }>(`${base}/groups/${id}`);
        const identicalCandidate = !group!.active && detail.comparison.hasChanges === false;
        const checksPassed = detail.report.checks.length > 0 && detail.report.checks.every(check => check.passed);
        const reviewDisabled = !checksPassed || identicalCandidate;
        const checks = detail.report.checks.map(check => `<div class="native-check" data-passed="${check.passed}"><strong>${check.passed ? "通过" : "未通过"} · ${esc(check.id)}</strong><span>${esc(check.detail)}</span></div>`).join("") || `<p class="native-diff-empty">尚无验证报告。</p>`;
        const gaps = detail.report.gaps.map(gap => `<label class="native-gap"><input type="checkbox" name="acceptedGaps" value="${esc(gap)}" required>${esc(gapLabel(gap))}</label>`).join("") || `<p class="native-diff-empty">验证报告没有记录已知缺口。</p>`;
        const noChangeMessage = identicalCandidate ? `<p class="native-review-blocked">候选版与当前活动版内容完全相同，不需要重复审核。</p>` : "";
        open(`索引 ${short(id)} · 验证与审核`, `<form class="admin-form native-review-form"><p class="native-review-state">${group!.active ? "当前活动索引" : "候选 / 历史索引"} · ${group!.archived ? "依赖已归档" : "依赖待归档"}</p>${comparisonMarkup(detail.comparison, group!)}<section class="native-review-validation"><h4>验证结论</h4>${checks}</section><section class="native-review-gaps"><h4>已知限制</h4><p>审核时逐项确认报告中的限制。</p>${gaps}</section>${noChangeMessage}${technicalEvidenceMarkup(detail)}<p data-native-message role="status"></p><button class="admin-primary" type="submit" ${reviewDisabled ? "disabled" : ""}>${identicalCandidate ? "内容无变化 · 不可审核" : "审核此分块版本"}</button></form>`, async form => { await options.api(`${base}/groups/${id}/review`, { method: "POST", body: JSON.stringify({ digest: detail.digest, acceptedGaps: new FormData(form).getAll("acceptedGaps") }) }); options.toast("原生分块版本已独立审核"); });
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
