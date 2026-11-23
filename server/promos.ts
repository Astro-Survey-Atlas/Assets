import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { AdminHttpError } from "./admin.js";
import { queueStateSnapshot, type StateSnapshotSink } from "./state-snapshot.js";

export interface PromoText { zh: string; en: string }
export interface PromoNewSurvey { surveyId: string; newUntil: string }
export const PROMO_KINDS = ["notice", "new-survey", "maintenance"] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];
/** How long a survey counts as NEW after its first publication. */
export const NEW_SURVEY_DAYS = 30;
export interface Promo {
  id: string;
  kind: PromoKind;
  /** Surveys this promo is about (shown as chips/thumbnail on the card). */
  surveyIds: string[];
  title: PromoText;
  body: PromoText;
  link?: string;
  /** ISO timestamps; empty bounds mean unbounded. */
  startsAt?: string;
  endsAt?: string;
  enabled: boolean;
  newSurveys: PromoNewSurvey[];
}
/** Manual NEW flags and surveys whose automatic NEW is switched off. */
export interface PromoNewSettings { manual: PromoNewSurvey[]; suppressed: string[] }
export interface PromoDocument { schemaVersion: 2; promos: Promo[]; newSettings: PromoNewSettings; updatedAt: string }
/** Public view: only active items, no admin-only fields. */
export interface PublicPromos { promos: Array<Omit<Promo, "enabled" | "startsAt" | "endsAt" | "newSurveys">>; newSurveys: PromoNewSurvey[] }

const MAX_PROMOS = 50;
const MAX_NEW_SURVEYS = 200;

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new AdminHttpError(400, `${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new AdminHttpError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new AdminHttpError(400, `${field} is required`);
  if (trimmed.length > max) throw new AdminHttpError(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

function time(value: unknown, field: string): string | undefined {
  const raw = text(value, field, 40, false);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new AdminHttpError(400, `${field} must be a valid date`);
  return new Date(parsed).toISOString();
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminHttpError(400, `${field} must be an object`);
  return value as Record<string, unknown>;
}

export function normalizePromos(value: unknown): Promo[] {
  const raw = Array.isArray(value) ? value : (value as { promos?: unknown } | null)?.promos;
  if (!Array.isArray(raw)) throw new AdminHttpError(400, "promos must be an array");
  if (raw.length > MAX_PROMOS) throw new AdminHttpError(400, `at most ${MAX_PROMOS} promos are allowed`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `promos[${index}]`;
    const item = record(entry, field);
    const id = text(item.id, `${field}.id`, 64, false) || randomUUID();
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new AdminHttpError(400, `${field}.id may only contain letters, digits, dot, underscore and dash`);
    if (seen.has(id)) throw new AdminHttpError(400, `${field}.id is duplicated`);
    seen.add(id);
    const title = record(item.title ?? {}, `${field}.title`);
    const body = record(item.body ?? {}, `${field}.body`);
    const titleText = { zh: text(title.zh, `${field}.title.zh`, 120, false), en: text(title.en, `${field}.title.en`, 120, false) };
    if (!titleText.zh && !titleText.en) throw new AdminHttpError(400, `${field}.title requires zh or en text`);
    const link = text(item.link, `${field}.link`, 500, false);
    if (link && !/^(https?:\/\/|\/(?!\/))/.test(link)) throw new AdminHttpError(400, `${field}.link must be an http(s) URL or a site path`);
    const startsAt = time(item.startsAt, `${field}.startsAt`);
    const endsAt = time(item.endsAt, `${field}.endsAt`);
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw new AdminHttpError(400, `${field}.endsAt must be after startsAt`);
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new AdminHttpError(400, `${field}.enabled must be a boolean`);
    const rawNew = item.newSurveys ?? [];
    if (!Array.isArray(rawNew)) throw new AdminHttpError(400, `${field}.newSurveys must be an array`);
    if (rawNew.length > MAX_NEW_SURVEYS) throw new AdminHttpError(400, `${field}.newSurveys has too many entries`);
    const newSurveys = rawNew.map((flag, flagIndex) => {
      const flagField = `${field}.newSurveys[${flagIndex}]`;
      const parsed = record(flag, flagField);
      const newUntil = time(parsed.newUntil, `${flagField}.newUntil`);
      if (!newUntil) throw new AdminHttpError(400, `${flagField}.newUntil is required`);
      return { surveyId: text(parsed.surveyId, `${flagField}.surveyId`, 128, true), newUntil };
    });
    const kind = item.kind === undefined ? (newSurveys.length ? "new-survey" : "notice") : item.kind;
    if (!PROMO_KINDS.includes(kind as PromoKind)) throw new AdminHttpError(400, `${field}.kind must be one of ${PROMO_KINDS.join(", ")}`);
    const rawSurveyIds = item.surveyIds ?? [];
    if (!Array.isArray(rawSurveyIds) || rawSurveyIds.length > MAX_NEW_SURVEYS) throw new AdminHttpError(400, `${field}.surveyIds must be an array`);
    const surveyIds = [...new Set(rawSurveyIds.map((value, i) => text(value, `${field}.surveyIds[${i}]`, 128, true)))];
    return {
      id,
      kind: kind as PromoKind,
      surveyIds,
      title: titleText,
      body: { zh: text(body.zh, `${field}.body.zh`, 600, false), en: text(body.en, `${field}.body.en`, 600, false) },
      ...(link ? { link } : {}),
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
      enabled: item.enabled !== false,
      newSurveys,
    };
  });
}

export function isPromoActive(promo: Promo, now: number): boolean {
  if (!promo.enabled) return false;
  if (promo.startsAt && Date.parse(promo.startsAt) > now) return false;
  if (promo.endsAt && Date.parse(promo.endsAt) <= now) return false;
  return true;
}

export function normalizeNewSettings(value: unknown): PromoNewSettings {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const manualRaw = item.manual ?? [];
  const suppressedRaw = item.suppressed ?? [];
  if (!Array.isArray(manualRaw) || !Array.isArray(suppressedRaw) || manualRaw.length > MAX_NEW_SURVEYS || suppressedRaw.length > MAX_NEW_SURVEYS) {
    throw new AdminHttpError(400, "newSettings.manual and newSettings.suppressed must be arrays");
  }
  const manual = manualRaw.map((flag, index) => {
    const parsed = record(flag, `newSettings.manual[${index}]`);
    const newUntil = time(parsed.newUntil, `newSettings.manual[${index}].newUntil`);
    if (!newUntil) throw new AdminHttpError(400, `newSettings.manual[${index}].newUntil is required`);
    return { surveyId: text(parsed.surveyId, `newSettings.manual[${index}].surveyId`, 128, true), newUntil };
  });
  const suppressed = [...new Set(suppressedRaw.map((entry, index) => text(entry, `newSettings.suppressed[${index}]`, 128, true)))];
  return { manual, suppressed };
}

/** Surveys whose first publication is recent enough to count as NEW; newUntil = first publication + NEW_SURVEY_DAYS. */
export function automaticNewSurveys(firstPublished: ReadonlyMap<string, string>, now = Date.now()): PromoNewSurvey[] {
  const result: PromoNewSurvey[] = [];
  for (const [surveyId, publishedAt] of firstPublished) {
    const until = Date.parse(publishedAt) + NEW_SURVEY_DAYS * 86_400_000;
    if (Number.isFinite(until) && until > now) result.push({ surveyId, newUntil: new Date(until).toISOString() });
  }
  return result;
}

export function publicPromos(promos: readonly Promo[], now = Date.now(), settings: PromoNewSettings = { manual: [], suppressed: [] }, automatic: readonly PromoNewSurvey[] = []): PublicPromos {
  const active = promos.filter((promo) => isPromoActive(promo, now));
  const newest = new Map<string, string>();
  const consider = (flag: PromoNewSurvey) => {
    if (Date.parse(flag.newUntil) <= now) return;
    const previous = newest.get(flag.surveyId);
    if (!previous || Date.parse(flag.newUntil) > Date.parse(previous)) newest.set(flag.surveyId, flag.newUntil);
  };
  // Legacy per-promo flags still count while their promo is active; automatic flags honour suppression.
  for (const promo of active) promo.newSurveys.forEach(consider);
  settings.manual.forEach(consider);
  automatic.filter((flag) => !settings.suppressed.includes(flag.surveyId)).forEach(consider);
  for (const surveyId of settings.suppressed) {
    // Suppression also removes legacy per-promo flags, but never a manual flag set later by the operator.
    if (!settings.manual.some((flag) => flag.surveyId === surveyId)) newest.delete(surveyId);
  }
  return {
    promos: active.map(({ id, kind, surveyIds, title, body, link }) => ({ id, kind, surveyIds, title, body, ...(link ? { link } : {}) })),
    newSurveys: [...newest].map(([surveyId, newUntil]) => ({ surveyId, newUntil })),
  };
}

export class PromoStore {
  #promos: Promo[] = [];
  #newSettings: PromoNewSettings = { manual: [], suppressed: [] };
  #updatedAt = new Date(0).toISOString();
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly contentRoot: string, private readonly snapshotSink?: StateSnapshotSink) {}

  #file(): string { return path.join(this.contentRoot, "promos-v1.json"); }

  async initialize(): Promise<void> {
    await mkdir(this.contentRoot, { recursive: true });
    let state: unknown;
    try {
      state = JSON.parse(await readFile(this.#file(), "utf8"));
    } catch {
      try { state = (await this.snapshotSink?.restore?.("promos"))?.state; } catch { /* start empty */ }
    }
    try {
      this.#promos = state ? normalizePromos(state) : [];
      this.#newSettings = normalizeNewSettings((state as Partial<PromoDocument> | undefined)?.newSettings);
      this.#updatedAt = (state as Partial<PromoDocument> | undefined)?.updatedAt ?? this.#updatedAt;
    } catch { this.#promos = []; this.#newSettings = { manual: [], suppressed: [] }; }
  }

  document(): PromoDocument { return { schemaVersion: 2, promos: structuredClone(this.#promos), newSettings: structuredClone(this.#newSettings), updatedAt: this.#updatedAt }; }

  public(now = Date.now(), automatic: readonly PromoNewSurvey[] = []): PublicPromos { return publicPromos(this.#promos, now, this.#newSettings, automatic); }

  /** `newSettings` is optional so older clients that only send promos keep the current NEW settings. */
  async replace(value: unknown): Promise<PromoDocument> {
    const promos = normalizePromos(value);
    const settings = value && typeof value === "object" && !Array.isArray(value) && (value as { newSettings?: unknown }).newSettings !== undefined
      ? normalizeNewSettings((value as { newSettings?: unknown }).newSettings) : this.#newSettings;
    this.#promos = promos;
    this.#newSettings = settings;
    this.#updatedAt = new Date().toISOString();
    const document = this.document();
    const operation = this.#queue.then(async () => {
      await mkdir(this.contentRoot, { recursive: true });
      const temporary = `${this.#file()}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
      await rename(temporary, this.#file());
      await queueStateSnapshot(this.snapshotSink, "promos", document);
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
    return document;
  }
}
