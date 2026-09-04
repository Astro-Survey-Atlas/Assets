import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { AdminHttpError } from "./admin.js";
import { productId } from "./products.js";
import type { PublicSurveyProduct, PublicSurveyRecord } from "./types.js";

/**
 * The editorial document deliberately contains only values that are rendered
 * by the public survey catalog. Immutable product and coverage facts are
 * carried as references so a client can render the locked fields, but are
 * always rebuilt from the catalog when a draft is accepted.
 */
export interface SurveyEditorialProduct {
  productId: string;
  releaseId: string;
  canonicalName: string;
  displayName: string;
  description: string;
  reason?: string;
  manualStep?: string;
}

export interface SurveyEditorialRelease {
  releaseId: string;
  label: string;
  products: SurveyEditorialProduct[];
}

export interface SurveyEditorialContent {
  surveyId: string;
  name: string;
  mission: string;
  description: string;
  releases: SurveyEditorialRelease[];
}

export interface SurveyEditorialAuditEntry {
  action: "draft" | "publish";
  revision: number;
  at: string;
}

export interface SurveyEditorialRecord {
  surveyId: string;
  draft: SurveyEditorialContent;
  published: SurveyEditorialContent | null;
  revision: number;
  publishedRevision: number | null;
  updatedAt: string;
  publishedAt: string | null;
  audit: SurveyEditorialAuditEntry[];
}

interface PersistedEditorialDocument {
  schemaVersion: 1;
  surveys: SurveyEditorialRecord[];
}

interface EditorialIndexProduct extends Pick<PublicSurveyProduct, "productId" | "name" | "description" | "reason" | "manualStep"> {}

interface EditorialIndexRelease {
  id: string;
  label: string;
  products: EditorialIndexProduct[];
}

interface EditorialIndexSurvey {
  id: string;
  name: string;
  mission: string;
  description: string;
  releases: EditorialIndexRelease[];
}

interface EditorialIndex {
  surveys: EditorialIndexSurvey[];
}

const configuredContentRoot = process.env.ASSETS_CONTENT_ROOT
  ? path.resolve(process.env.ASSETS_CONTENT_ROOT)
  : "/var/lib/assets-content";

const MAX_SURVEY_NAME = 200;
const MAX_SURVEY_MISSION = 400;
const MAX_SURVEY_DESCRIPTION = 12_000;
const MAX_RELEASE_LABEL = 200;
const MAX_PRODUCT_DISPLAY_NAME = 200;
const MAX_PRODUCT_DESCRIPTION = 12_000;
const MAX_PRODUCT_NOTE = 8_000;
const MAX_AUDIT_ENTRIES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new AdminHttpError(400, `${label} contains unsupported field: ${unknown[0]}`);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new AdminHttpError(400, `${field} must be a string`);
  const text = value.trim();
  if (!text) throw new AdminHttpError(400, `${field} is required`);
  if (text.length > maxLength) throw new AdminHttpError(400, `${field} exceeds ${maxLength} characters`);
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new AdminHttpError(400, `${field} must be a string`);
  const text = value.trim();
  if (text.length > maxLength) throw new AdminHttpError(400, `${field} exceeds ${maxLength} characters`);
  return text || undefined;
}

function stableProductId(surveyId: string, releaseId: string, canonicalName: string): string {
  return productId(surveyId, releaseId, canonicalName);
}

function baselineContent(survey: EditorialIndexSurvey): SurveyEditorialContent {
  return {
    surveyId: survey.id,
    name: survey.name,
    mission: survey.mission,
    description: survey.description,
    releases: survey.releases.map((release) => ({
      releaseId: release.id,
      label: release.label,
      products: release.products.map((entry) => {
        const canonicalName = entry.name;
        return {
          productId: entry.productId ?? stableProductId(survey.id, release.id, canonicalName),
          releaseId: release.id,
          canonicalName,
          displayName: canonicalName,
          description: entry.description,
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(entry.manualStep ? { manualStep: entry.manualStep } : {}),
        };
      }),
    })),
  };
}

function baselineProductMap(content: SurveyEditorialContent): Map<string, SurveyEditorialProduct> {
  return new Map(content.releases.flatMap((release) => release.products.map((entry) => [entry.productId, entry] as const)));
}

function reconcileContent(base: SurveyEditorialContent, previous: SurveyEditorialContent | null | undefined): SurveyEditorialContent {
  if (!previous) return structuredClone(base);
  const previousProducts = baselineProductMap(previous);
  const previousReleases = new Map(previous.releases.map((release) => [release.releaseId, release]));
  return {
    ...base,
    name: typeof previous.name === "string" ? previous.name : base.name,
    mission: typeof previous.mission === "string" ? previous.mission : base.mission,
    description: typeof previous.description === "string" ? previous.description : base.description,
    releases: base.releases.map((release) => {
      const previousRelease = previousReleases.get(release.releaseId);
      return {
        ...release,
        label: typeof previousRelease?.label === "string" ? previousRelease.label : release.label,
        products: release.products.map((entry) => {
          const previousProduct = previousProducts.get(entry.productId);
          return previousProduct && previousProduct.canonicalName === entry.canonicalName
            ? { ...entry, displayName: previousProduct.displayName, description: previousProduct.description, ...(previousProduct.reason ? { reason: previousProduct.reason } : {}), ...(previousProduct.manualStep ? { manualStep: previousProduct.manualStep } : {}) }
            : entry;
        }),
      };
    }),
  };
}

function recordForBaseline(base: SurveyEditorialContent, previous?: SurveyEditorialRecord): SurveyEditorialRecord {
  const now = previous?.updatedAt ?? new Date().toISOString();
  return {
    surveyId: base.surveyId,
    draft: reconcileContent(base, previous?.draft),
    published: previous?.published ? reconcileContent(base, previous.published) : null,
    revision: previous?.revision && Number.isSafeInteger(previous.revision) && previous.revision > 0 ? previous.revision : 1,
    publishedRevision: previous?.publishedRevision !== undefined && previous?.publishedRevision !== null && Number.isSafeInteger(previous.publishedRevision) ? previous.publishedRevision : null,
    updatedAt: now,
    publishedAt: previous?.publishedAt ?? null,
    audit: Array.isArray(previous?.audit) ? previous!.audit.filter((entry) => isAuditEntry(entry)).slice(-MAX_AUDIT_ENTRIES) : [],
  };
}

function isAuditEntry(value: unknown): value is SurveyEditorialAuditEntry {
  return isRecord(value)
    && (value.action === "draft" || value.action === "publish")
    && typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && value.revision > 0
    && typeof value.at === "string";
}

function validateContent(value: unknown, baseline: SurveyEditorialContent, current: SurveyEditorialContent): SurveyEditorialContent {
  if (!isRecord(value)) throw new AdminHttpError(400, "content must be an object");
  ownKeys(value, ["surveyId", "name", "mission", "description", "releases"], "content");
  if (value.surveyId !== baseline.surveyId) throw new AdminHttpError(400, "surveyId cannot be changed");
  if (!Array.isArray(value.releases)) throw new AdminHttpError(400, "releases must be an array");
  const releases = new Map(baseline.releases.map((release) => [release.releaseId, release]));
  const seenReleases = new Set<string>();
  const nextReleases = value.releases.map((rawRelease, releaseIndex) => {
    if (!isRecord(rawRelease)) throw new AdminHttpError(400, `releases[${releaseIndex}] must be an object`);
    ownKeys(rawRelease, ["releaseId", "label", "products"], `releases[${releaseIndex}]`);
    const releaseId = rawRelease.releaseId;
    if (typeof releaseId !== "string" || !releases.has(releaseId)) throw new AdminHttpError(400, `releases[${releaseIndex}].releaseId is immutable or unknown`);
    if (baseline.releases[releaseIndex]?.releaseId !== releaseId) throw new AdminHttpError(400, "release order cannot be changed");
    if (seenReleases.has(releaseId)) throw new AdminHttpError(400, `release ${releaseId} is duplicated`);
    seenReleases.add(releaseId);
    const baseRelease = releases.get(releaseId)!;
    const currentRelease = current.releases.find((entry) => entry.releaseId === releaseId);
    if (!Array.isArray(rawRelease.products)) throw new AdminHttpError(400, `release ${releaseId}.products must be an array`);
    const products = new Map(baseRelease.products.map((product) => [product.productId, product]));
    const seenProducts = new Set<string>();
    const nextProducts = rawRelease.products.map((rawProduct, productIndex) => {
      if (!isRecord(rawProduct)) throw new AdminHttpError(400, `releases[${releaseIndex}].products[${productIndex}] must be an object`);
      const field = `releases[${releaseIndex}].products[${productIndex}]`;
      ownKeys(rawProduct, ["productId", "releaseId", "canonicalName", "displayName", "description", "reason", "manualStep"], field);
      const productIdValue = rawProduct.productId;
      const productReleaseId = rawProduct.releaseId;
      const canonicalName = rawProduct.canonicalName;
      if (typeof productIdValue !== "string" || !products.has(productIdValue)) throw new AdminHttpError(400, `${field}.productId is immutable or unknown`);
      if (productReleaseId !== releaseId) throw new AdminHttpError(400, `${field}.releaseId cannot be changed`);
      const baseProduct = products.get(productIdValue)!;
      const currentProduct = currentRelease?.products.find((entry) => entry.productId === productIdValue);
      if (canonicalName !== baseProduct.canonicalName) throw new AdminHttpError(400, `${field}.canonicalName cannot be changed`);
      if (stableProductId(baseline.surveyId, releaseId, baseProduct.canonicalName) !== productIdValue) throw new AdminHttpError(400, `${field}.productId is invalid`);
      if (baseRelease.products[productIndex]?.productId !== productIdValue) throw new AdminHttpError(400, "product order cannot be changed");
      if (seenProducts.has(productIdValue)) throw new AdminHttpError(400, `product ${productIdValue} is duplicated`);
      seenProducts.add(productIdValue);
      const reason = rawProduct.reason === undefined
        ? currentProduct?.reason
        : optionalText(rawProduct.reason, `${field}.reason`, MAX_PRODUCT_NOTE);
      const manualStep = rawProduct.manualStep === undefined
        ? currentProduct?.manualStep
        : optionalText(rawProduct.manualStep, `${field}.manualStep`, MAX_PRODUCT_NOTE);
      if (baseProduct.reason === undefined && reason !== undefined) throw new AdminHttpError(400, `${field}.reason is not editable for this product`);
      if (baseProduct.manualStep === undefined && manualStep !== undefined) throw new AdminHttpError(400, `${field}.manualStep is not editable for this product`);
      return {
        productId: productIdValue,
        releaseId,
        canonicalName: baseProduct.canonicalName,
        displayName: requiredText(rawProduct.displayName, `${field}.displayName`, MAX_PRODUCT_DISPLAY_NAME),
        description: requiredText(rawProduct.description, `${field}.description`, MAX_PRODUCT_DESCRIPTION),
        ...(reason ? { reason } : {}),
        ...(manualStep ? { manualStep } : {}),
      };
    });
    if (seenProducts.size !== products.size) throw new AdminHttpError(400, `release ${releaseId}.products must retain every product`);
    return { releaseId, label: requiredText(rawRelease.label, `releases[${releaseIndex}].label`, MAX_RELEASE_LABEL), products: nextProducts };
  });
  if (seenReleases.size !== releases.size) throw new AdminHttpError(400, "releases must retain every release");
  return {
    surveyId: baseline.surveyId,
    name: requiredText(value.name, "name", MAX_SURVEY_NAME),
    mission: requiredText(value.mission, "mission", MAX_SURVEY_MISSION),
    description: requiredText(value.description, "description", MAX_SURVEY_DESCRIPTION),
    releases: nextReleases,
  };
}

function applyContent<T extends EditorialIndex>(index: T, surveyId: string, content: SurveyEditorialContent): T {
  return {
    ...index,
    surveys: index.surveys.map((survey) => {
      if (survey.id !== surveyId) return survey;
      const releaseMap = new Map(content.releases.map((release) => [release.releaseId, release]));
      return {
        ...survey,
        name: content.name,
        mission: content.mission,
        description: content.description,
        releases: survey.releases.map((release) => {
          const editorialRelease = releaseMap.get(release.id);
          if (!editorialRelease) return release;
          const productMap = new Map(editorialRelease.products.map((product) => [product.productId, product]));
          return {
            ...release,
            label: editorialRelease.label,
            products: release.products.map((product) => {
              const editorialProduct = productMap.get(product.productId ?? stableProductId(survey.id, release.id, product.name));
              if (!editorialProduct) return product;
              const { reason: _reason, manualStep: _manualStep, ...withoutOptionalNotes } = product;
              return {
                ...withoutOptionalNotes,
                name: editorialProduct.displayName,
                description: editorialProduct.description,
                ...(editorialProduct.reason ? { reason: editorialProduct.reason } : {}),
                ...(editorialProduct.manualStep ? { manualStep: editorialProduct.manualStep } : {}),
              };
            }),
          };
        }),
      };
    }),
  } as T;
}

export class SurveyEditorialStore {
  #records = new Map<string, SurveyEditorialRecord>();
  #baselines = new Map<string, SurveyEditorialContent>();
  #initialized = false;
  #contentRoot: string;
  #fallbackRoot: string | undefined;
  #persistQueue: Promise<void> = Promise.resolve();

  constructor(contentRoot = configuredContentRoot, fallbackRoot?: string) {
    this.#contentRoot = path.resolve(contentRoot);
    this.#fallbackRoot = fallbackRoot ? path.resolve(fallbackRoot) : undefined;
  }

  #contentFile(): string {
    return path.join(this.#contentRoot, "survey-editorial-v1.json");
  }

  #historyFile(): string {
    return path.join(this.#contentRoot, "survey-editorial-history.ndjson");
  }

  async initialize(surveys: readonly PublicSurveyRecord[]): Promise<void> {
    if (this.#initialized) {
      await this.sync(surveys);
      return;
    }
    try {
      await mkdir(this.#contentRoot, { recursive: true });
    } catch (error) {
      if (!this.#fallbackRoot) throw error;
      this.#contentRoot = path.join(this.#fallbackRoot, ".assets-content");
      await mkdir(this.#contentRoot, { recursive: true });
    }
    const previous = new Map<string, SurveyEditorialRecord>();
    try {
      const document = JSON.parse(await readFile(this.#contentFile(), "utf8")) as Partial<PersistedEditorialDocument>;
      if (document.schemaVersion === 1 && Array.isArray(document.surveys)) {
        for (const entry of document.surveys) if (isRecord(entry) && typeof entry.surveyId === "string") previous.set(entry.surveyId, entry as unknown as SurveyEditorialRecord);
      }
    } catch { /* first boot or a partially written optional editorial file */ }
    for (const survey of surveys) {
      const base = baselineContent(survey);
      this.#baselines.set(survey.id, base);
      this.#records.set(survey.id, recordForBaseline(base, previous.get(survey.id)));
    }
    this.#initialized = true;
    if (!previous.size || [...this.#records.values()].some((record) => !previous.has(record.surveyId))) await this.#persist();
  }

  /** Refresh immutable references when a dynamic public product is activated. */
  async sync(surveys: readonly PublicSurveyRecord[]): Promise<void> {
    if (!this.#initialized) throw new AdminHttpError(503, "Survey editorial store is not initialized");
    let changed = false;
    for (const survey of surveys) {
      const base = baselineContent(survey);
      const previousBase = this.#baselines.get(survey.id);
      const record = this.#records.get(survey.id);
      this.#baselines.set(survey.id, base);
      if (!record) {
        this.#records.set(survey.id, recordForBaseline(base));
        changed = true;
        continue;
      }
      const draft = reconcileContent(base, record.draft);
      const published = record.published ? reconcileContent(base, record.published) : null;
      if (JSON.stringify(previousBase) !== JSON.stringify(base)
        || JSON.stringify(record.draft) !== JSON.stringify(draft)
        || JSON.stringify(record.published) !== JSON.stringify(published)) {
        record.draft = draft;
        record.published = published;
        this.#records.set(survey.id, record);
        changed = true;
      }
    }
    if (changed) await this.#persist();
  }

  get(surveyId: string): SurveyEditorialRecord {
    const record = this.#records.get(surveyId);
    if (!record) throw new AdminHttpError(404, "Survey editorial record not found");
    return structuredClone(record);
  }

  list(): SurveyEditorialRecord[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  publishedContent(surveyId: string): SurveyEditorialContent | null {
    const record = this.#records.get(surveyId);
    return record?.published ? structuredClone(record.published) : null;
  }

  applyPublished<T extends EditorialIndex>(index: T): T {
    let result = index;
    for (const record of this.#records.values()) if (record.published) result = applyContent(result, record.surveyId, record.published);
    return result;
  }

  applyDraft<T extends EditorialIndex>(index: T, surveyId: string): T {
    const record = this.#records.get(surveyId);
    return record ? applyContent(index, surveyId, record.draft) : index;
  }

  async updateDraft(surveyId: string, value: unknown, expectedRevision?: number): Promise<SurveyEditorialRecord> {
    const record = this.#records.get(surveyId);
    const baseline = this.#baselines.get(surveyId);
    if (!record || !baseline) throw new AdminHttpError(404, "Survey editorial record not found");
    if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new AdminHttpError(409, "Survey editorial revision conflict");
    const draft = validateContent(value, baseline, record.draft);
    record.draft = draft;
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    const auditEntry: SurveyEditorialAuditEntry = { action: "draft", revision: record.revision, at: record.updatedAt };
    record.audit = [...record.audit, auditEntry].slice(-MAX_AUDIT_ENTRIES);
    await this.#persist();
    await appendFile(this.#historyFile(), `${JSON.stringify({ action: "draft", surveyId, revision: record.revision, at: record.updatedAt, content: record.draft })}\n`);
    return structuredClone(record);
  }

  async publish(surveyId: string, expectedRevision?: number): Promise<SurveyEditorialRecord> {
    const record = this.#records.get(surveyId);
    if (!record) throw new AdminHttpError(404, "Survey editorial record not found");
    if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new AdminHttpError(409, "Survey editorial revision conflict");
    record.published = structuredClone(record.draft);
    record.publishedRevision = record.revision;
    record.publishedAt = new Date().toISOString();
    record.updatedAt = record.publishedAt;
    const auditEntry: SurveyEditorialAuditEntry = { action: "publish", revision: record.revision, at: record.publishedAt };
    record.audit = [...record.audit, auditEntry].slice(-MAX_AUDIT_ENTRIES);
    await this.#persist();
    await appendFile(this.#historyFile(), `${JSON.stringify({ action: "publish", surveyId, revision: record.revision, at: record.publishedAt, content: record.published })}\n`);
    return structuredClone(record);
  }

  async history(surveyId: string): Promise<unknown[]> {
    if (!this.#records.has(surveyId)) throw new AdminHttpError(404, "Survey editorial record not found");
    try {
      const content = (await readFile(this.#historyFile(), "utf8")).trim();
      if (!content) return [];
      return content.split("\n").map((line) => JSON.parse(line)).filter((entry) => isRecord(entry) && entry.surveyId === surveyId);
    } catch { return []; }
  }

  async #persist(): Promise<void> {
    const document: PersistedEditorialDocument = { schemaVersion: 1, surveys: [...this.#records.values()] };
    const temporaryFile = `${this.#contentFile()}.${process.pid}.${randomUUID()}.tmp`;
    const operation = this.#persistQueue.then(async () => {
      await writeFile(temporaryFile, `${JSON.stringify(document, null, 2)}\n`);
      await rename(temporaryFile, this.#contentFile());
    });
    this.#persistQueue = operation.catch(() => undefined);
    await operation;
  }
}

export { applyContent as applySurveyEditorialContent, baselineContent as buildSurveyEditorialBaseline, validateContent as validateSurveyEditorialContent };
