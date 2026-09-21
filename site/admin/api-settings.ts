type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
interface View {
 credentialStorageReady: boolean; startedAt: string;
 provider: { revision: number; baseUrl: string; model: string; enabled: boolean; keyConfigured: boolean };
 llmUsage: { requests: number; errors: number; inputTokens: number; outputTokens: number; unknownUsage: number };
 keys: Array<{ id: string; name: string; prefix: string; expiresAt: string; revokedAt?: string; perMinute: number; requests: number; errors: number; lastUsedAt?: string }>;
 events: Array<{ at: string; kind: string; id: string; route: string; status: number; durationMs: number }>;
}
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const base = "/api/v1/admin/api-management";
let loading = false;
export async function loadApiSettings(api: Api, renderIcons: () => void): Promise<void> {
 if (loading) return; loading = true;
 const root = document.getElementById("api-settings-content")!;
 root.setAttribute("aria-busy", "true");
 if (!root.childElementCount) root.textContent = "正在加载 API 设置…";
 try {
 const view = await api<View>(base), p = view.provider, u = view.llmUsage;
 root.innerHTML = `<div class="api-settings-grid"><section class="api-card"><h3>LLM 服务</h3><p>用于 MOC 探索的可选增强。只在 CDS 完整查询没有候选时调用；启用服务不会自动启动探索。</p>
 <form id="api-provider-form"><label>服务地址<input name="baseUrl" type="url" required value="${esc(p.baseUrl)}" placeholder="https://provider.example"></label><label>模型<input name="model" required maxlength="128" value="${esc(p.model)}"></label>
 <label>替换凭证<input name="key" type="password" autocomplete="new-password" placeholder="${p.keyConfigured ? '已配置，留空保持现有凭证' : '尚未配置'}"></label>
 <label class="api-check"><input name="enabled" type="checkbox" ${p.enabled ? 'checked' : ''}>启用 LLM 服务</label>
 <p>凭证加密保存，不返回浏览器。${view.credentialStorageReady ? '' : '后台尚未配置加密密钥，暂不能保存。'}</p>
 <div class="api-actions"><button class="admin-primary" type="submit" ${!view.credentialStorageReady ? 'disabled' : ''}><i data-lucide="save"></i><span>保存配置</span></button><button class="admin-quiet" type="button" id="api-provider-test"><i data-lucide="plug-zap"></i><span>测试已保存配置</span></button><button class="admin-quiet" type="button" id="api-provider-clear" ${!p.keyConfigured ? 'disabled' : ''}><i data-lucide="x"></i><span>清除凭证并停用</span></button></div><div id="api-provider-feedback" class="api-feedback" role="status" aria-live="polite" aria-atomic="true" hidden></div></form></section>
 <section class="api-card"><h3>LLM 调用统计</h3><p>从 ${esc(new Date(view.startedAt).toLocaleString())} 开始记录；不包含此前历史调用。</p><dl class="api-stats"><div><dt>模型调用</dt><dd>${u.requests}</dd></div><div><dt>失败</dt><dd>${u.errors}</dd></div><div><dt>输入 Token</dt><dd>${u.inputTokens}</dd></div><div><dt>输出 Token</dt><dd>${u.outputTokens}</dd></div></dl><p>${u.unknownUsage} 次调用未返回完整用量。一次探索最多调用模型两次；不估算费用。</p></section></div>
 <section class="api-card"><h3>对外 API Key</h3><p>公开目录与资源包保持匿名访问。Key 授权区域查询和重合区域下载计划；可在天球下载解锁框直接输入，也可通过 X-Assets-API-Key 请求头调用接口。不能管理、审核或发布数据。轮换时先创建新 Key，再撤销旧 Key。</p>
 <form id="api-key-form" class="api-key-form"><label>使用方 / 名称<input name="name" required maxlength="100" placeholder="例如：研究工作台"></label><label>每分钟请求数<input name="perMinute" type="number" min="1" max="30" value="30" required></label><label>有效期（天）<input name="days" type="number" min="1" max="365" value="90" required></label><button type="submit" class="admin-primary"><i data-lucide="plus"></i><span>创建 Key</span></button></form><div id="api-key-feedback" class="api-feedback" role="status" aria-live="polite" aria-atomic="true" hidden></div>
 <div class="api-table-wrap"><table><thead><tr><th>名称 / 标识</th><th>状态 / 有效期</th><th>限流</th><th>调用 / 失败</th><th>最近调用</th><th>操作</th></tr></thead><tbody>${view.keys.map(k => `<tr><td>${esc(k.name)}<small>${esc(k.prefix)}…</small></td><td>${k.revokedAt ? '已撤销' : Date.parse(k.expiresAt) <= Date.now() ? '已过期' : '有效'}<small>${esc(new Date(k.expiresAt).toLocaleString())}</small></td><td>${k.perMinute}/分钟</td><td>${k.requests} / ${k.errors}</td><td>${esc(k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '尚未调用')}</td><td><button type="button" class="admin-quiet" data-revoke-key="${esc(k.id)}" ${k.revokedAt ? 'disabled' : ''}><i data-lucide="x"></i><span>撤销</span></button></td></tr>`).join('') || '<tr><td colspan="6">尚未创建 API Key</td></tr>'}</tbody></table></div></section>
 <details class="api-card"><summary>最近调用记录（最多 1000 条）</summary><div class="api-table-wrap"><table><thead><tr><th>时间</th><th>类型 / 标识</th><th>接口</th><th>状态</th><th>耗时</th></tr></thead><tbody>${view.events.map(e => `<tr><td>${esc(new Date(e.at).toLocaleString())}</td><td>${esc(e.kind)}<small>${esc(e.id)}</small></td><td>${esc(e.route)}</td><td>${e.status}</td><td>${e.durationMs} ms</td></tr>`).join('') || '<tr><td colspan="5">暂无调用记录</td></tr>'}</tbody></table></div></details>`;
 const checkbox = document.getElementById("moc-llm-enabled") as HTMLInputElement;
 checkbox.disabled = !(p.enabled && p.keyConfigured); if (checkbox.disabled) checkbox.checked = false;
 document.getElementById("moc-llm-availability")!.textContent = checkbox.disabled ? "LLM 服务未配置或已停用，仍可使用 CDS 探索。" : "默认查询 CDS；增强选项仅在 CDS 成功且无候选时生效。";
 renderIcons();
 type Outcome = string | { message: string; state: "warning" };
 const feedback = (id: string, text: string, state: "pending" | "success" | "warning" | "error") => {
  const node = document.getElementById(id); if (!node) return;
  node.hidden = false; node.dataset.state = state;
  node.innerHTML = `<i data-lucide="${state === "pending" ? "loader-circle" : state === "success" ? "circle-check" : "circle-alert"}"${state === "pending" ? ' class="button-spinner"' : ''}></i><span>${esc(text)}</span>`;
  renderIcons();
  if (!node.closest<HTMLElement>("[data-admin-panel]")?.hidden) node.scrollIntoView({ block: "nearest" });
 };
 const run = async (action: () => Promise<Outcome>, target = "api-provider-feedback", trigger?: HTMLButtonElement) => {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")]; const disabled = buttons.map(b => b.disabled); buttons.forEach(b => b.disabled = true);
  const original = trigger?.innerHTML;
  if (trigger) { trigger.setAttribute("aria-busy", "true"); trigger.innerHTML = '<i data-lucide="loader-circle" class="button-spinner"></i><span>正在测试…</span>'; }
  feedback(target, trigger ? "正在连接已保存的服务并读取模型列表，最多等待 25 秒…" : "正在处理…", "pending");
  try { const result = await action(); feedback(target, typeof result === "string" ? result : result.message, typeof result === "string" ? "success" : result.state); }
  catch (e) { feedback(target, e instanceof Error ? e.message : "操作失败，请重试。", "error"); }
  finally { buttons.forEach((b,i) => b.disabled = disabled[i]!); if (trigger && original) { trigger.innerHTML = original; trigger.removeAttribute("aria-busy"); } }
 };
 root.querySelector<HTMLFormElement>("#api-provider-form")!.onsubmit = e => { e.preventDefault(); void run(async () => {
  const form = e.currentTarget as HTMLFormElement; const data = new FormData(form);
  await api(base + "/llm", { method: "PUT", body: JSON.stringify({ revision: p.revision, baseUrl: data.get("baseUrl"), model: data.get("model"), key: data.get("key"), enabled: data.has("enabled") }) });
  (form.elements.namedItem("key") as HTMLInputElement).value = ""; await loadApiSettings(api, renderIcons); return "配置已保存，后续探索使用新配置。";
 }); };
 root.querySelector<HTMLButtonElement>("#api-provider-test")!.onclick = e => { const button = e.currentTarget as HTMLButtonElement; void run(async () => {
  let r: { modelAvailable: boolean };
  try { r = await api(base + "/llm/test", { method: "POST", signal: AbortSignal.timeout(25_000) }); }
  catch (error) { if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("连接测试超时，请检查服务地址或稍后重试。"); throw error; }
  return r.modelAvailable ? "连接成功，模型列表包含已保存的模型。未发起推理调用。" : { message: "连接成功，但模型列表没有已保存的模型，请核对名称后重新保存。", state: "warning" as const };
 }, "api-provider-feedback", button); };
 root.querySelector<HTMLButtonElement>("#api-provider-clear")!.onclick = () => { if (!confirm("清除凭证并停用 LLM 增强？已开始的探索不受影响。")) return; void run(async () => { await api(base+"/llm", {method:"PUT",body:JSON.stringify({...p,clearKey:true,enabled:false})}); await loadApiSettings(api, renderIcons); return "凭证已清除，LLM 服务已停用。"; }); };
 root.querySelector<HTMLFormElement>("#api-key-form")!.onsubmit = e => { e.preventDefault(); const data = new FormData(e.currentTarget as HTMLFormElement); void run(async () => {
  const r = await api<{key:string}>(base+"/keys", {method:"POST",body:JSON.stringify({name:data.get("name"),scopes:["region:query"],perMinute:Number(data.get("perMinute")),expiresAt:new Date(Date.now()+Number(data.get("days"))*86400000).toISOString()})});
  const dialog = document.getElementById("api-key-created") as HTMLDialogElement; (dialog.querySelector("textarea") as HTMLTextAreaElement).value = r.key; dialog.showModal(); await loadApiSettings(api, renderIcons); return "Key 已创建。请保存弹框中的凭证，关闭后无法再次查看。";
 }, "api-key-feedback"); };
 root.querySelectorAll<HTMLButtonElement>("[data-revoke-key]").forEach(b => b.onclick = () => { if (!confirm("撤销此 Key？使用方后续请求将被拒绝。")) return; void run(async () => { await api(`${base}/keys/${encodeURIComponent(b.dataset.revokeKey!)}/revoke`,{method:"POST"}); await loadApiSettings(api, renderIcons); return "Key 已撤销。"; }, "api-key-feedback"); });
 } catch (e) { document.getElementById("api-settings-message")!.textContent = e instanceof Error ? e.message : "加载失败"; }
 finally { loading = false; root.removeAttribute("aria-busy"); }
}
export function mountApiSettings(): void {
 const dialog = document.getElementById("api-key-created") as HTMLDialogElement;
 dialog.addEventListener("close", () => { (dialog.querySelector("textarea") as HTMLTextAreaElement).value = ""; });
 dialog.querySelector<HTMLButtonElement>("[data-close-key]")!.onclick = () => dialog.close();
}
