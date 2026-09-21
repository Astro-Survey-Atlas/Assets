import { providerFetch } from "./provider-fetch.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { AdminHttpError } from "./admin.js";
import type { StateSnapshotSink } from "./state-snapshot.js";
import { publicSourceUrl } from "./public-source-fetch.js";

export interface LlmSettings { baseUrl?: string; model?: string; key?: string }
interface Provider { revision: number; baseUrl: string; model: string; enabled: boolean; encryptedKey?: string; updatedAt: string }
interface KeyRecord { id: string; name: string; prefix: string; hash: string; scopes: string[]; createdAt: string; expiresAt: string; revokedAt?: string; perMinute: number; window: number; used: number; requests: number; errors: number; lastUsedAt?: string }
interface Event { at: string; kind: "key" | "llm"; id: string; route: string; status: number; durationMs: number; model?: string; inputTokens?: number; outputTokens?: number }
interface State { provider?: Provider; keys: KeyRecord[]; events: Event[]; llm: { requests: number; errors: number; inputTokens: number; outputTokens: number; unknownUsage: number }; startedAt: string }
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
export const MANAGED_KEY_PREFIX = "asa_live_";
export const KEY_SCOPES = ["region:query"] as const;
export class ApiManagement {
 private db: DatabaseSync;
 private state: State;
 private master?: Buffer;
 private dirty = false;
 constructor(private root: string, private sink?: StateSnapshotSink, master = process.env.ASSETS_API_MASTER_KEY, private seed: LlmSettings = { baseUrl: process.env.ASSETS_LLM_BASE_URL, model: process.env.ASSETS_LLM_MODEL, key: process.env.ASSETS_LLM_API_KEY }) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "api-management.sqlite"); this.db = new DatabaseSync(file); chmodSync(file, 0o600);
  this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
  const row = this.db.prepare("SELECT value FROM state WHERE id=1").get() as { value: string } | undefined;
  this.state = row ? JSON.parse(row.value) : { keys: [], events: [], llm: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0 }, startedAt: now() };
  if (master) { this.master = Buffer.from(master, "base64"); if (this.master.length !== 32) throw new Error("API encryption key must contain 32 bytes"); }
 }
 async initialize(): Promise<void> {
  if (!this.db.prepare("SELECT id FROM state WHERE id=1").get()) {
   const restored = await this.sink?.restore?.("api-management"); if (restored) this.state = restored.state as State;
   if (!this.state.provider && this.master && this.seed.key && this.seed.baseUrl && this.seed.model) this.state.provider = { revision: 1, baseUrl: this.seed.baseUrl, model: this.seed.model, enabled: true, encryptedKey: this.encrypt(this.seed.key), updatedAt: now() };
   this.save();
  }
  // A missing/wrong master key must never silently replace a saved credential.
  if (this.state.provider?.encryptedKey) this.decrypt(this.state.provider.encryptedKey);
 }
 private encrypt(key: string): string { if (!this.master) throw new AdminHttpError(409, "后台加密密钥尚未配置"); const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.master, iv); const bytes = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]); return [iv, cipher.getAuthTag(), bytes].map(b => b.toString("base64")).join("."); }
 private decrypt(value: string): string { if (!this.master) throw new Error("API encryption key unavailable"); const [iv, tag, bytes] = value.split(".").map(x => Buffer.from(x, "base64")); const decipher = createDecipheriv("aes-256-gcm", this.master, iv!); decipher.setAuthTag(tag!); return Buffer.concat([decipher.update(bytes!), decipher.final()]).toString("utf8"); }
 private save(): void { this.db.prepare("INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(this.state)); this.dirty = true; }
 async flush(): Promise<void> { if (!this.dirty) return; const snapshot = structuredClone(this.state); this.dirty = false; try { await this.sink?.enqueue("api-management", snapshot); } catch (e) { this.dirty = true; throw e; } }
 settings(): LlmSettings {
  const p = this.state.provider;
  if (!p) return this.seed;
  if (!p.enabled) return {};
  return { baseUrl: p.baseUrl, model: p.model, key: p.encryptedKey ? this.decrypt(p.encryptedKey) : undefined };
 }
 view() {
  const p = this.state.provider;
  return { startedAt: this.state.startedAt, credentialStorageReady: Boolean(this.master), provider: p ? { revision: p.revision, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled, keyConfigured: Boolean(p.encryptedKey), updatedAt: p.updatedAt } : { revision: 0, baseUrl: this.seed.baseUrl ?? "", model: this.seed.model ?? "", enabled: Boolean(this.seed.key), keyConfigured: Boolean(this.seed.key) }, scopes: KEY_SCOPES,
   keys: this.state.keys.map(({ hash, window, used, ...key }) => key), events: [...this.state.events].reverse(), llmUsage: this.state.llm };
 }
 async updateProvider(input: Record<string, unknown>): Promise<void> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminHttpError(400, "配置必须为对象");
  if (!this.master) throw new AdminHttpError(409, "后台加密密钥尚未配置");
  const old = this.state.provider;
  if (input.revision !== (old?.revision ?? 0)) throw new AdminHttpError(409, "配置版本已变化，请刷新后重试");
  if (typeof input.baseUrl !== "string" || typeof input.model !== "string" || typeof input.enabled !== "boolean") throw new AdminHttpError(400, "服务地址、模型和启用状态必填");
  let url: URL; try { url = publicSourceUrl(input.baseUrl); } catch { throw new AdminHttpError(400, "服务地址必须是不含凭证的 HTTPS URL"); }
  if (url.protocol !== "https:" || url.search || new URL(input.baseUrl).hash || input.model.length > 128 || !input.model.trim()) throw new AdminHttpError(400, "服务地址或模型无效");
  const replacement = typeof input.key === "string" ? input.key.trim() : "";
  if (replacement.length > 8192 || /[\r\n]/.test(replacement)) throw new AdminHttpError(400, "凭证格式无效");
  if (old && old.baseUrl !== url.href.replace(/\/$/, "") && !replacement && input.clearKey !== true) throw new AdminHttpError(400, "更换服务地址时请同时提供新凭证");
  const encryptedKey = input.clearKey === true ? undefined : replacement ? this.encrypt(replacement) : old?.encryptedKey;
  if (input.enabled && !encryptedKey) throw new AdminHttpError(400, "启用服务前请配置凭证");
  this.state.provider = { revision: (old?.revision ?? 0) + 1, baseUrl: url.href.replace(/\/$/, ""), model: input.model.trim(), enabled: input.enabled, ...(encryptedKey ? { encryptedKey } : {}), updatedAt: now() }; this.save(); await this.flush();
 }
 async testProvider(): Promise<{ modelAvailable: boolean }> {
  const p = this.settings(); if (!p.key || !p.baseUrl || !p.model) throw new AdminHttpError(409, "请先保存并启用服务配置");
  const url = new URL(p.baseUrl); url.pathname = url.pathname.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1/models";
  try {
   const r = await providerFetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${p.key}` } });
   if (!r.ok) throw new AdminHttpError(502, `模型服务返回 HTTP ${r.status}`);
   const reader = r.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
   for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 1024*1024) { await reader.cancel(); throw new Error(); } chunks.push(value); }
   const data = JSON.parse(Buffer.concat(chunks).toString()); return { modelAvailable: Array.isArray(data.data) && data.data.some((m: {id?:string}) => m.id === p.model) };
  } catch (e) { if (e instanceof AdminHttpError) throw e; throw new AdminHttpError(502, "模型服务连接失败或响应无效；凭证不会出现在诊断信息中"); }
 }
 async createKey(input: Record<string, unknown>): Promise<{ key: string; id: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminHttpError(400, "Key 配置必须为对象");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const scopes = input.scopes, perMinute = input.perMinute ?? 30;
  const expiresAt = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : Date.now() + 90*86400000;
  if (!name || name.length > 100 || !Array.isArray(scopes) || !scopes.length || scopes.some(s => !KEY_SCOPES.includes(s)) || !Number.isInteger(perMinute) || Number(perMinute) < 1 || Number(perMinute) > 30 || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now()+366*86400000) throw new AdminHttpError(400, "请填写名称、区域查询权限、1–30 次/分钟限流，以及一年内的有效期");
  if (this.state.keys.length >= 1000) throw new AdminHttpError(409, "Key 数量已达上限");
  const key = MANAGED_KEY_PREFIX + randomBytes(32).toString("base64url"), id = randomUUID();
  this.state.keys.push({ id, name, prefix: key.slice(0, 17), hash: sha(key), scopes: [...new Set(scopes)], createdAt: now(), expiresAt: new Date(expiresAt).toISOString(), perMinute: Number(perMinute), window: 0, used: 0, requests: 0, errors: 0 }); this.save(); await this.flush(); return { key, id };
 }
 async revokeKey(id: string): Promise<void> { const key = this.state.keys.find(k => k.id === id); if (!key) throw new AdminHttpError(404, "Key 不存在"); key.revokedAt ??= now(); this.save(); await this.flush(); }
 authorize(token: string, scope: string, route: string): string {
  const key = this.state.keys.find(k => k.hash === sha(token)); if (!key) throw new AdminHttpError(401, "API Key 无效");
  return this.authorizeRecord(key, scope, route);
 }
 authorizeId(id: string, scope: string, route: string): string {
  const key = this.state.keys.find(k => k.id === id); if (!key) throw new AdminHttpError(401, "API Key 无效");
  return this.authorizeRecord(key, scope, route);
 }
 private authorizeRecord(key: KeyRecord, scope: string, route: string): string {
  const deny = (status: number, message: string): never => { this.recordKey(key.id, route, status, 0); throw new AdminHttpError(status, message); };
  if (key.revokedAt || Date.parse(key.expiresAt) <= Date.now()) deny(401, "API Key 已撤销或过期");
  if (!key.scopes.includes(scope)) deny(403, "API Key 没有所需权限");
  const minute = Math.floor(Date.now()/60000); if (key.window !== minute) { key.window = minute; key.used = 0; }
  if (key.used >= key.perMinute) deny(429, "API Key 已达到每分钟限额"); key.used++; this.save(); return key.id;
 }
 recordKey(id: string, route: string, status: number, durationMs: number): void { const key = this.state.keys.find(k => k.id === id); if (!key) return; key.requests++; if (status >= 400) key.errors++; key.lastUsedAt = now(); this.event({ at: now(), kind: "key", id, route, status, durationMs }); }
 recordLlm(input: { requestId: string; model: string; success: boolean; durationMs: number; usage?: unknown }): void {
  const u = input.usage as Record<string, unknown> | undefined;
  const inputTokens = u?.prompt_tokens ?? u?.input_tokens, outputTokens = u?.completion_tokens ?? u?.output_tokens;
  const valid = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
  const tally = this.state.llm; tally.requests++; if (!input.success) tally.errors++;
  if (valid(inputTokens)) tally.inputTokens += inputTokens; if (valid(outputTokens)) tally.outputTokens += outputTokens;
  if (!valid(inputTokens) || !valid(outputTokens)) tally.unknownUsage++;
  this.event({ at: now(), kind: "llm", id: input.requestId, route: "moc-discovery", model: input.model, status: input.success ? 200 : 502, durationMs: input.durationMs, ...(valid(inputTokens) ? { inputTokens } : {}), ...(valid(outputTokens) ? { outputTokens } : {}) });
 }
 private event(event: Event): void { this.state.events.push(event); if (this.state.events.length > 1000) this.state.events.splice(0, this.state.events.length - 1000); this.save(); }
 close(): void { this.db.close(); }
}
