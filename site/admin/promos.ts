type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
interface Promo { id: string; title: { zh: string; en: string }; body: { zh: string; en: string }; link?: string; startsAt?: string; endsAt?: string; enabled: boolean; newSurveys: Array<{ surveyId: string; newUntil: string }> }
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const local = (iso?: string) => { if (!iso) return ""; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const iso = (v: string) => v ? new Date(v).toISOString() : "";
const flagsText = (p: Promo) => p.newSurveys.map(f => `${f.surveyId} ${local(f.newUntil).slice(0, 10)}`).join("\n");

export async function loadPromos(api: Api): Promise<void> {
  const root = document.getElementById("promo-settings-content"); if (!root) return;
  const status = document.getElementById("promo-settings-message")!;
  let promos = (await api<{ promos: Promo[] }>("/api/v1/admin/promos")).promos;
  const save = async (next: Promo[], note: string) => {
    status.textContent = "正在保存…";
    try { promos = (await api<{ promos: Promo[] }>("/api/v1/admin/promos", { method: "PUT", body: JSON.stringify({ promos: next }) })).promos; status.textContent = note; }
    catch (e) { status.textContent = e instanceof Error ? e.message : "保存失败"; return; }
    render();
  };
  const form = (p?: Promo) => `<form class="api-card promo-form" data-promo-id="${esc(p?.id ?? "")}"><label>标题（中文）<input name="titleZh" maxlength="120" value="${esc(p?.title.zh)}"></label><label>标题（English）<input name="titleEn" maxlength="120" value="${esc(p?.title.en)}"></label>
<label>正文（中文）<textarea name="bodyZh" rows="2" maxlength="600">${esc(p?.body.zh)}</textarea></label><label>正文（English）<textarea name="bodyEn" rows="2" maxlength="600">${esc(p?.body.en)}</textarea></label>
<label>链接（可选，http(s) 或站内路径）<input name="link" maxlength="500" value="${esc(p?.link)}"></label><label>开始时间（可空）<input name="startsAt" type="datetime-local" value="${local(p?.startsAt)}"></label><label>结束时间（可空）<input name="endsAt" type="datetime-local" value="${local(p?.endsAt)}"></label>
<label>标记为 NEW 的巡天（每行：surveyId YYYY-MM-DD，到该日 NEW 失效）<textarea name="flags" rows="3" spellcheck="false">${esc(p ? flagsText(p) : "")}</textarea></label>
<label class="api-check"><input name="enabled" type="checkbox" ${p?.enabled !== false ? "checked" : ""}>启用</label>
<div class="api-actions"><button class="admin-primary" type="submit"><span>${p ? "保存" : "添加"}</span></button>${p ? '<button class="admin-quiet" type="button" data-promo-delete><span>删除</span></button>' : ""}</div></form>`;
  const collect = (f: HTMLFormElement): Promo => {
    const d = new FormData(f), v = (k: string) => String(d.get(k) ?? "").trim();
    const newSurveys = v("flags").split("\n").map(l => l.trim()).filter(Boolean).map(l => { const [surveyId = "", day = ""] = l.split(/\s+/); return { surveyId, newUntil: iso(`${day}T23:59`) }; });
    return { id: f.dataset.promoId || "", title: { zh: v("titleZh"), en: v("titleEn") }, body: { zh: v("bodyZh"), en: v("bodyEn") }, ...(v("link") ? { link: v("link") } : {}), ...(v("startsAt") ? { startsAt: iso(v("startsAt")) } : {}), ...(v("endsAt") ? { endsAt: iso(v("endsAt")) } : {}), enabled: d.has("enabled"), newSurveys };
  };
  const render = () => {
    root.innerHTML = promos.map(form).join("") + `<h4>新增公告</h4>${form()}`;
    root.querySelectorAll<HTMLFormElement>("form").forEach(f => {
      f.addEventListener("submit", e => { e.preventDefault(); let item: Promo; try { item = collect(f); } catch { status.textContent = "日期格式无效"; return; } const id = f.dataset.promoId; void save(id ? promos.map(p => p.id === id ? item : p) : [...promos, item], "已保存"); });
      f.querySelector("[data-promo-delete]")?.addEventListener("click", () => void save(promos.filter(p => p.id !== f.dataset.promoId), "已删除"));
    });
  };
  render();
}
