import "./promos.css";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Kind = "notice" | "new-survey" | "maintenance";
interface Text { zh: string; en: string }
interface Promo { id: string; kind: Kind; surveyIds: string[]; title: Text; body: Text; link?: string; startsAt?: string; endsAt?: string; enabled: boolean; newSurveys: Array<{ surveyId: string; newUntil: string }> }
interface NewSettings { manual: Array<{ surveyId: string; newUntil: string }>; suppressed: string[] }
interface Doc { promos: Promo[]; newSettings: NewSettings }
interface SurveyOption { id: string; name: string }

const KINDS: Array<{ id: Kind; label: string }> = [{ id: "notice", label: "公告" }, { id: "new-survey", label: "新收录" }, { id: "maintenance", label: "维护" }];
const kindLabel = (kind: Kind) => KINDS.find((entry) => entry.id === kind)?.label ?? kind;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const toLocal = (iso?: string) => { if (!iso) return ""; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const toIso = (value: string) => value ? new Date(value).toISOString() : "";
const day = (iso?: string) => iso ? new Date(iso).toLocaleDateString("zh-CN") : "";
const DAY_MS = 86_400_000;

function period(promo: Promo, now = Date.now()): { label: string; state: "live" | "scheduled" | "ended" | "off" } {
  if (!promo.enabled) return { label: "已停用", state: "off" };
  if (promo.startsAt && Date.parse(promo.startsAt) > now) return { label: `${day(promo.startsAt)} 开始`, state: "scheduled" };
  if (promo.endsAt && Date.parse(promo.endsAt) <= now) return { label: "已结束", state: "ended" };
  return { label: promo.endsAt ? `至 ${day(promo.endsAt)}` : "长期", state: "live" };
}

/** Multi-select list of surveys rendered as checkboxes; the survey list comes from the catalog, never typed by hand. */
function surveyChecklist(name: string, options: SurveyOption[], selected: Iterable<string>): string {
  const chosen = new Set(selected);
  return `<div class="ops-checklist" role="group">${options.map((option) => `<label class="ops-chip"><input type="checkbox" name="${name}" value="${esc(option.id)}" ${chosen.has(option.id) ? "checked" : ""}><span>${esc(option.name)}</span></label>`).join("")}</div>`;
}

const checked = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((input) => input.value);

async function loadSurveys(): Promise<SurveyOption[]> {
  try {
    const response = await fetch("/api/v1/surveys", { headers: { Accept: "application/json" } });
    const data = await response.json() as { surveys?: Array<{ id: string; name?: string }> };
    return (data.surveys ?? []).map((survey) => ({ id: survey.id, name: survey.name || survey.id })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

export async function loadPromos(api: Api, renderIcons: () => void = () => undefined): Promise<void> {
  const host = document.getElementById("ops-content");
  if (!host) return;
  const root: HTMLElement = host;
  const [loaded, surveys] = await Promise.all([api<Doc>("/api/v1/admin/promos"), loadSurveys()]);
  let promos = loaded.promos;
  let settings = loaded.newSettings ?? { manual: [], suppressed: [] };
  let message = "";
  const nameOf = (id: string) => surveys.find((survey) => survey.id === id)?.name ?? id;

  const save = async (nextPromos: Promo[], nextSettings: NewSettings, note: string): Promise<boolean> => {
    message = "正在保存…"; paintMessage();
    try {
      const saved = await api<Doc>("/api/v1/admin/promos", { method: "PUT", body: JSON.stringify({ promos: nextPromos, newSettings: nextSettings }) });
      promos = saved.promos; settings = saved.newSettings; message = note;
    } catch (error) { message = error instanceof Error ? error.message : "保存失败"; paintMessage(); return false; }
    render(); return true;
  };
  const paintMessage = () => { const node = root.querySelector("#ops-message"); if (node) node.textContent = message; };

  const dialog = (() => {
    let element = document.getElementById("promo-dialog") as HTMLDialogElement | null;
    if (!element) { element = document.createElement("dialog"); element.id = "promo-dialog"; element.className = "admin-dialog promo-dialog"; root.after(element); }
    return element;
  })();

  const openForm = (promo?: Promo) => {
    dialog.innerHTML = `<form method="dialog" class="promo-form" id="promo-form"><h3>${promo ? "编辑公告" : "新增公告"}</h3>
      <div class="ops-grid">
        <label>类型<select name="kind">${KINDS.map((kind) => `<option value="${kind.id}" ${(promo?.kind ?? "notice") === kind.id ? "selected" : ""}>${kind.label}</option>`).join("")}</select></label>
        <label class="ops-check"><input name="enabled" type="checkbox" ${promo?.enabled !== false ? "checked" : ""}>启用</label>
        <label>标题（中文）<input name="titleZh" maxlength="120" value="${esc(promo?.title.zh)}"></label>
        <label>标题（English）<input name="titleEn" maxlength="120" value="${esc(promo?.title.en)}"></label>
        <label>摘要（中文）<textarea name="bodyZh" rows="2" maxlength="600">${esc(promo?.body.zh)}</textarea></label>
        <label>摘要（English）<textarea name="bodyEn" rows="2" maxlength="600">${esc(promo?.body.en)}</textarea></label>
        <label class="ops-wide">链接（可选）<input name="link" maxlength="500" placeholder="https://… 或 /atlas/" value="${esc(promo?.link)}"></label>
        <label>开始时间<input name="startsAt" type="datetime-local" value="${toLocal(promo?.startsAt)}"></label>
        <label>结束时间<input name="endsAt" type="datetime-local" value="${toLocal(promo?.endsAt)}"></label>
        <fieldset class="ops-wide"><legend>关联巡天（卡片上展示缩略图与名称）</legend>${surveyChecklist("surveyIds", surveys, promo?.surveyIds ?? [])}</fieldset>
      </div>
      <p class="form-message" id="promo-form-message" role="status"></p>
      <div class="ops-actions"><button class="admin-quiet" type="button" data-cancel>取消</button><button class="admin-primary" type="submit"><span>保存</span></button></div></form>`;
    const form = dialog.querySelector<HTMLFormElement>("form")!;
    form.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form); const v = (key: string) => String(data.get(key) ?? "").trim();
      const item: Promo = {
        id: promo?.id ?? "", kind: v("kind") as Kind, surveyIds: checked(form, "surveyIds"),
        title: { zh: v("titleZh"), en: v("titleEn") }, body: { zh: v("bodyZh"), en: v("bodyEn") },
        ...(v("link") ? { link: v("link") } : {}), ...(v("startsAt") ? { startsAt: toIso(v("startsAt")) } : {}), ...(v("endsAt") ? { endsAt: toIso(v("endsAt")) } : {}),
        enabled: data.has("enabled"), newSurveys: promo?.newSurveys ?? [],
      };
      const next = promo ? promos.map((entry) => entry.id === promo.id ? item : entry) : [...promos, item];
      form.querySelector("#promo-form-message")!.textContent = "正在保存…";
      if (await save(next, settings, promo ? "公告已更新" : "公告已添加")) dialog.close();
      else form.querySelector("#promo-form-message")!.textContent = message;
    });
    dialog.showModal();
  };

  const autoNote = "最近 30 天内首次发布的 DR 所属巡天会自动带 NEW；可在此手动标记，或取消某个巡天的自动 NEW。";
  function render(): void {
    const manualIds = new Set(settings.manual.map((flag) => flag.surveyId));
    const defaultUntil = toLocal(new Date(Date.now() + 30 * DAY_MS).toISOString()).slice(0, 10);
    root.innerHTML = `<div class="ops-head"><div><h2>运营</h2></div><p id="ops-message" role="status" aria-live="polite">${esc(message)}</p></div>
      <section class="api-card ops-card"><div class="ops-card-head"><h3>公告</h3>
        <span class="ops-hint" title="公开首页顶部的卡片轮播；只显示当前生效的公告。">ⓘ</span>
        <button class="admin-primary" type="button" id="promo-add"><i data-lucide="plus"></i><span>新增公告</span></button></div>
        ${promos.length ? `<div class="api-table-wrap"><table class="ops-table"><thead><tr><th>标题</th><th>类型</th><th>关联巡天</th><th>有效期</th><th>状态</th><th class="ops-op">操作</th></tr></thead><tbody>${promos.map((promo) => {
          const when = period(promo);
          return `<tr data-promo="${esc(promo.id)}"><td><strong>${esc(promo.title.zh || promo.title.en)}</strong>${promo.body.zh || promo.body.en ? `<small>${esc(promo.body.zh || promo.body.en)}</small>` : ""}</td>
            <td><span class="ops-kind" data-kind="${promo.kind}">${kindLabel(promo.kind)}</span></td>
            <td>${promo.surveyIds.map((id) => `<span class="ops-chip-static">${esc(nameOf(id))}</span>`).join("") || "—"}</td>
            <td>${promo.endsAt || promo.startsAt ? esc(when.state === "off" ? "—" : [promo.startsAt ? `${day(promo.startsAt)} 起` : "", promo.endsAt ? `${day(promo.endsAt)} 止` : ""].filter(Boolean).join(" ")) : "长期"}</td>
            <td><label class="ops-switch" title="启用 / 停用"><input type="checkbox" data-toggle ${promo.enabled ? "checked" : ""}><span></span></label><small class="ops-state" data-state="${when.state}">${when.state === "live" ? "展示中" : when.state === "scheduled" ? "待开始" : when.state === "ended" ? "已结束" : "已停用"}</small></td>
            <td class="ops-op"><button class="admin-quiet" type="button" data-edit>编辑</button><button class="admin-quiet" type="button" data-delete>删除</button></td></tr>`;
        }).join("")}</tbody></table></div>` : `<p class="ops-empty">还没有公告。点击“新增公告”创建第一条。</p>`}
      </section>
      <section class="api-card ops-card"><div class="ops-card-head"><h3>巡天 NEW 标记</h3><span class="ops-hint" title="${esc(autoNote)}">ⓘ</span></div>
        <form id="new-form" class="ops-new-form">
          <fieldset><legend>手动标记 NEW</legend>${surveyChecklist("manual", surveys, manualIds)}</fieldset>
          <label class="ops-until">统一截止日期<input type="date" name="until" value="${esc(settings.manual[0]?.newUntil ? toLocal(settings.manual[0].newUntil).slice(0, 10) : defaultUntil)}"></label>
          <fieldset><legend>取消自动 NEW</legend>${surveyChecklist("suppressed", surveys, settings.suppressed)}</fieldset>
          <div class="ops-actions"><button class="admin-primary" type="submit"><span>保存 NEW 设置</span></button></div>
        </form></section>`;
    root.querySelector("#promo-add")!.addEventListener("click", () => openForm());
    root.querySelectorAll<HTMLTableRowElement>("tr[data-promo]").forEach((row) => {
      const promo = promos.find((entry) => entry.id === row.dataset.promo)!;
      row.querySelector("[data-edit]")!.addEventListener("click", () => openForm(promo));
      row.querySelector("[data-delete]")!.addEventListener("click", () => { if (window.confirm(`删除公告“${promo.title.zh || promo.title.en}”？`)) void save(promos.filter((entry) => entry.id !== promo.id), settings, "公告已删除"); });
      row.querySelector<HTMLInputElement>("[data-toggle]")!.addEventListener("change", (event) => void save(promos.map((entry) => entry.id === promo.id ? { ...entry, enabled: (event.currentTarget as HTMLInputElement).checked } : entry), settings, "状态已更新"));
    });
    root.querySelector<HTMLFormElement>("#new-form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const until = String(new FormData(form).get("until") ?? "");
      const manual = checked(form, "manual");
      if (manual.length && !until) { message = "请选择 NEW 的截止日期"; paintMessage(); return; }
      void save(promos, { manual: manual.map((surveyId) => ({ surveyId, newUntil: toIso(`${until}T23:59`) })), suppressed: checked(form, "suppressed") }, "NEW 设置已保存");
    });
    renderIcons();
  }
  render();
}
