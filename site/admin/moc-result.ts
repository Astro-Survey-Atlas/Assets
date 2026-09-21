export interface DiscoveryResult { candidateId: string; title?: string; provider?: string; buildable?: boolean; identityMatch?: boolean; coverageCategory?: string; recordUrl?: string; mocUrl?: string; hipsUrl?: string; citation?: string }
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nature: Record<string, string> = { observed: "观测数据", planned: "计划覆盖", simulated: "模拟数据", unknown: "性质待核实" };
export function onlyLeads(candidates?: DiscoveryResult[]): boolean { return Boolean(candidates?.length && candidates.every(c => c.buildable === false)); }
function link(url: string | undefined, label: string): string {
 if (!url) return "";
 try { const u = new URL(url); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return ""; return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${label} ↗ <small>${esc(u.hostname)}</small></a>`; } catch { return ""; }
}
export function discoveryResultMarkup(c: DiscoveryResult): string {
 const lead = c.buildable === false, llm = c.provider === "llm";
 const missing: string[] = [];
 if (lead && !c.mocUrl) missing.push("缺少可下载的 MOC 覆盖文件。");
 if (lead && c.identityMatch !== true) missing.push("与当前巡天、DR 和目标产品的匹配关系尚未确认。");
 if (lead && c.coverageCategory !== "observed") missing.push("尚不能作为实际观测覆盖使用。");
 return `<div class="moc-result-conclusion ${lead ? "is-lead" : "is-candidate"}"><strong>${lead ? "仅找到线索，暂不可构建" : "可选择构建，仍需校验覆盖文件"}</strong><p>${lead ? "发现了相关来源，但构建条件尚未满足。" : "构建将检查文件、来源哈希和真实覆盖精度。"}</p></div>
 <h5 class="moc-result-title">${esc(c.title ?? c.candidateId)}</h5>
 <dl class="moc-result-facts"><div><dt>发现方式</dt><dd>${llm ? "LLM 补充查找" : "CDS 查询"}</dd></div>${llm ? `<div><dt>来源性质</dt><dd>${esc(nature[c.coverageCategory ?? "unknown"] ?? nature.unknown!)}</dd></div>` : ""}</dl>
 ${missing.length ? `<section class="moc-result-missing"><h5>还缺什么</h5><ul>${missing.map(v => `<li>${v}</li>`).join("")}</ul></section><p class="moc-result-next"><strong>下一步</strong> 继续查找同一 DR、同一产品的覆盖文件；只有说明页面时，保留为线索，不直接审核发布。</p>` : ""}
 <div class="moc-result-links">${link(c.recordUrl, "打开来源页面")}${!lead ? link(c.mocUrl ?? c.hipsUrl, "查看覆盖来源") : ""}</div>
 ${c.citation ? `<details class="moc-result-evidence"><summary>查看来源引用</summary><blockquote>${esc(c.citation)}</blockquote></details>` : ""}`;
}
