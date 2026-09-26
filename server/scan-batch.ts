import { createHash } from "node:crypto";

export class ScanBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanBatchValidationError";
  }
}

export const SCAN_BATCH_MODES = ["fits-wcs", "fits-header-position", "catalog-radec", "nested-healpix"] as const;
export type ScanBatchMode = typeof SCAN_BATCH_MODES[number];

export const BATCH_EVIDENCE_LAYER_PREFIX = "assets-batch-";

export function batchEvidenceLayerId(productId: string): string {
  const normalized = text(productId, "productId", 128);
  const directToken = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(normalized) && normalized.length <= 50
    ? normalized
    : createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `${BATCH_EVIDENCE_LAYER_PREFIX}${directToken}`;
}

export function isBatchEvidenceLayerId(layerId: string): boolean {
  return layerId.startsWith(BATCH_EVIDENCE_LAYER_PREFIX);
}

export function resolveScanBatchMode(ruleMode: ScanBatchMode | undefined, productMode: string | undefined): ScanBatchMode | undefined {
  if (ruleMode) return ruleMode;
  return productMode && (SCAN_BATCH_MODES as readonly string[]).includes(productMode)
    ? productMode as ScanBatchMode
    : undefined;
}

export interface ScanBatchRuleRequest {
  name: string;
  productId: string;
  scanMode?: ScanBatchMode;
  relativePrefix: string;
  includePattern?: string;
  allowedSuffixes?: string;
  filters?: { includeSuffixes?: string[]; excludePatterns?: string[] };
  maxOrder?: number;
  raColumn?: string;
  decColumn?: string;
  healpixColumn?: string;
  healpixOrderColumn?: string;
  healpixOrder?: number;
  hduName?: string;
  hduIndex?: number;
  coordinateFrame?: string;
}

export interface ScanBatchRequest {
  name: string;
  sourceConnector: string;
  sourcePaths: [string];
  partitioning: { mode: "direct-child-prefixes"; scopeId: string; maxPartitions: number };
  maxConcurrent: number;
  rules: ScanBatchRuleRequest[];
}

export interface ScanBatchLayer {
  layerId: string;
  surveyId: string;
  releaseId: string;
  productId: string;
  modality: string;
  coverageRole: "footprint" | "occupancy";
  entrypoint?: string;
}

export interface ScanBatchRuleResource {
  name: string;
  layer: ScanBatchLayer;
  filters: { includeSuffixes: string[]; excludePatterns?: string[] };
  extraction: Record<string, unknown>;
  relativePrefix: string;
  includePattern?: string;
}

export interface ScanBatchResourceInput {
  name: string;
  namespace: string;
  sourceConnector: string;
  sourcePaths: [string];
  rules: ScanBatchRuleResource[];
  partitioning: ScanBatchRequest["partitioning"];
  maxConcurrent: number;
  source: Record<string, unknown>;
  credentials: Record<string, unknown>;
  sink: Record<string, unknown>;
  evidence: Record<string, unknown>;
  scanner: Record<string, unknown>;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScanBatchValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ScanBatchValidationError(`${field}.${unknown} is not supported`);
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ScanBatchValidationError(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ScanBatchValidationError(`${field} is too long`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new ScanBatchValidationError(`${field} contains control characters`);
  return normalized;
}

function dnsLabel(value: unknown, field: string, maxLength = 63): string {
  const normalized = text(value, field, maxLength).toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(normalized)) {
    throw new ScanBatchValidationError(`${field} must be a DNS label`);
  }
  return normalized;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ScanBatchValidationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ScanBatchValidationError(`${field} must be a non-negative integer`);
  }
  return value;
}

function stringArray(value: unknown, field: string, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ScanBatchValidationError(`${field} must contain at most ${maximumItems} entries`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`, maximumLength));
}

export function validateRelativePrefix(value: unknown): string {
  if (value === undefined || value === "") return "";
  const input = text(value, "relativePrefix", 2048);
  if (input.startsWith("/") || input.includes("\\")) {
    throw new ScanBatchValidationError("relativePrefix must be a relative POSIX path");
  }
  const normalized = input.endsWith("/") ? input.slice(0, -1) : input;
  if (normalized && normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ScanBatchValidationError("relativePrefix cannot contain empty or dot segments");
  }
  return normalized;
}

export function validateFilenamePattern(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = text(value, "includePattern", 256);
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new ScanBatchValidationError("includePattern must match a filename without path separators");
  }
  return normalized;
}

function normalizeRule(value: unknown, index: number): ScanBatchRuleRequest {
  const field = `rules[${index}]`;
  const rule = record(value, field);
  exactKeys(rule, ["name", "productId", "scanMode", "relativePrefix", "includePattern", "allowedSuffixes", "filters", "maxOrder", "raColumn", "decColumn", "healpixColumn", "healpixOrderColumn", "healpixOrder", "hduName", "hduIndex", "coordinateFrame"], field);
  const normalized: ScanBatchRuleRequest = {
    name: dnsLabel(rule.name, `${field}.name`, 128),
    productId: text(rule.productId, `${field}.productId`, 128),
    relativePrefix: validateRelativePrefix(rule.relativePrefix),
  };
  if (rule.scanMode !== undefined) {
    const scanMode = text(rule.scanMode, `${field}.scanMode`, 64);
    if (!(SCAN_BATCH_MODES as readonly string[]).includes(scanMode)) {
      throw new ScanBatchValidationError(`${field}.scanMode is unsupported`);
    }
    normalized.scanMode = scanMode as ScanBatchMode;
  }
  const hasHduName = rule.hduName !== undefined;
  const hasHduIndex = rule.hduIndex !== undefined;
  const hasCoordinateFrame = rule.coordinateFrame !== undefined;
  if ((hasHduName || hasHduIndex || hasCoordinateFrame) && normalized.scanMode !== undefined && normalized.scanMode !== "catalog-radec") {
    throw new ScanBatchValidationError(`${field}.hduName, hduIndex, and coordinateFrame are supported only with catalog-radec`);
  }
  if (hasHduName && hasHduIndex) throw new ScanBatchValidationError(`${field} must specify either hduName or hduIndex, not both`);
  if (hasCoordinateFrame) {
    if (rule.coordinateFrame !== "ICRS") throw new ScanBatchValidationError(`${field}.coordinateFrame must be exactly ICRS`);
    normalized.coordinateFrame = "ICRS";
  }
  if ((hasHduName || hasHduIndex) && rule.coordinateFrame !== "ICRS") {
    throw new ScanBatchValidationError(`${field} hduName or hduIndex requires coordinateFrame ICRS`);
  }
  if (hasHduName) normalized.hduName = text(rule.hduName, `${field}.hduName`, 128);
  if (hasHduIndex) normalized.hduIndex = nonNegativeInteger(rule.hduIndex, `${field}.hduIndex`);
  const includePattern = validateFilenamePattern(rule.includePattern);
  if (includePattern) normalized.includePattern = includePattern;
  if (rule.allowedSuffixes !== undefined && rule.allowedSuffixes !== "") {
    normalized.allowedSuffixes = text(rule.allowedSuffixes, `${field}.allowedSuffixes`, 128);
  }
  if (rule.filters !== undefined) {
    const filters = record(rule.filters, `${field}.filters`);
    exactKeys(filters, ["includeSuffixes", "excludePatterns"], `${field}.filters`);
    const includeSuffixes = filters.includeSuffixes === undefined ? undefined : stringArray(filters.includeSuffixes, `${field}.filters.includeSuffixes`, 128, 128);
    const excludePatterns = filters.excludePatterns === undefined ? undefined : stringArray(filters.excludePatterns, `${field}.filters.excludePatterns`, 128, 256);
    if (normalized.allowedSuffixes !== undefined && includeSuffixes !== undefined) {
      throw new ScanBatchValidationError(`${field} must use either allowedSuffixes or filters.includeSuffixes`);
    }
    normalized.filters = {
      ...(includeSuffixes ? { includeSuffixes } : {}),
      ...(excludePatterns ? { excludePatterns } : {}),
    };
  }
  if (rule.maxOrder !== undefined) normalized.maxOrder = integer(rule.maxOrder, `${field}.maxOrder`, 1, 12);
  for (const key of ["raColumn", "decColumn", "healpixColumn", "healpixOrderColumn"] as const) {
    if (rule[key] !== undefined) normalized[key] = text(rule[key], `${field}.${key}`, 128);
  }
  if (rule.healpixOrder !== undefined) normalized.healpixOrder = integer(rule.healpixOrder, `${field}.healpixOrder`, 1, 29);
  return normalized;
}

export function parseScanBatchRequest(value: unknown): ScanBatchRequest {
  const body = record(value, "request");
  exactKeys(body, ["name", "sourceConnector", "sourcePaths", "partitioning", "maxConcurrent", "rules"], "request");
  if (!Array.isArray(body.sourcePaths) || body.sourcePaths.length !== 1) {
    throw new ScanBatchValidationError("sourcePaths must contain exactly one shared root");
  }
  if (!Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 32) {
    throw new ScanBatchValidationError("rules must contain 1 to 32 entries");
  }
  const rules = body.rules.map(normalizeRule);
  if (new Set(rules.map((rule) => rule.name)).size !== rules.length) {
    throw new ScanBatchValidationError("rule names must be unique");
  }
  if (new Set(rules.map((rule) => rule.productId)).size !== rules.length) {
    throw new ScanBatchValidationError("a product may appear only once in a scan batch");
  }
  const partitioning = record(body.partitioning, "partitioning");
  exactKeys(partitioning, ["mode", "scopeId", "maxPartitions"], "partitioning");
  if (partitioning.mode !== "direct-child-prefixes") {
    throw new ScanBatchValidationError("partitioning.mode must be direct-child-prefixes");
  }
  return {
    name: dnsLabel(body.name, "name"),
    sourceConnector: dnsLabel(body.sourceConnector, "sourceConnector"),
    sourcePaths: [text(body.sourcePaths[0], "sourcePaths[0]", 2048)],
    partitioning: {
      mode: "direct-child-prefixes",
      scopeId: dnsLabel(partitioning.scopeId, "partitioning.scopeId", 96),
      maxPartitions: integer(partitioning.maxPartitions, "partitioning.maxPartitions", 1, 2048),
    },
    maxConcurrent: integer(body.maxConcurrent, "maxConcurrent", 1, 64),
    rules,
  };
}

export function buildScanBatchResource(input: ScanBatchResourceInput): Record<string, unknown> {
  const layerIds = input.rules.map((rule) => rule.layer.layerId);
  if (new Set(layerIds).size !== layerIds.length) throw new ScanBatchValidationError("rule layer IDs must be unique");
  return {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "ScanBatchRequest",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "astro-survey-atlas-assets",
        "astro.zhejianglab.org/resource-kind": "scan-batch",
        "astro.zhejianglab.org/source-connector": input.sourceConnector,
      },
    },
    spec: {
      source: input.source,
      credentials: input.credentials,
      rules: input.rules,
      partitioning: input.partitioning,
      sink: input.sink,
      evidence: input.evidence,
      scanner: input.scanner,
      maxConcurrent: input.maxConcurrent,
    },
  };
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string" && value.length <= maximumLength ? value : undefined;
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resourceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function summaryRule(value: unknown): Record<string, unknown> | undefined {
  const rule = resourceRecord(value);
  const result: Record<string, unknown> = {};
  for (const key of ["name", "layerId", "scopeId"] as const) {
    const item = boundedString(rule[key], 128);
    if (item) result[key] = item;
  }
  const hash = boundedString(rule.scopeSnapshotSha256, 64);
  if (hash && /^[a-f0-9]{64}$/.test(hash)) result.scopeSnapshotSha256 = hash;
  for (const key of ["expectedPartitionCount", "expectedPartitions", "completedPartitions", "failedPartitions", "runningPartitions", "files", "coverage"] as const) {
    const count = boundedCount(rule[key]);
    if (count !== undefined) result[key] = count;
  }
  if (Array.isArray(rule.availableOrders)) {
    result.availableOrders = rule.availableOrders.filter((order): order is number => Number.isSafeInteger(order) && (order as number) >= 0 && (order as number) <= 29).slice(0, 30);
  }
  return Object.keys(result).length ? result : undefined;
}

export function scanBatchView(value: unknown): Record<string, unknown> {
  const resource = resourceRecord(value);
  const metadata = resourceRecord(resource.metadata);
  const spec = resourceRecord(resource.spec);
  const source = resourceRecord(spec.source);
  const sourceConnectorConfig = resourceRecord(source.connector);
  const location = resourceRecord(source.location);
  const sourceType = boundedString(sourceConnectorConfig.type, 16);
  const bucket = boundedString(location.bucket, 255);
  const prefix = boundedString(location.prefix, 2048);
  const rootPath = boundedString(location.rootPath, 2048);
  const sourcePath = rootPath ?? (bucket ? `${sourceType ?? "s3"}://${bucket}${prefix ? `/${prefix}` : ""}` : undefined);
  const rawRules = Array.isArray(spec.rules) ? spec.rules.slice(0, 32) : [];
  const rules = rawRules.map((item) => {
    const rule = resourceRecord(item);
    const layer = resourceRecord(rule.layer);
    const filters = resourceRecord(rule.filters);
    const extraction = resourceRecord(rule.extraction);
    return {
      ...(boundedString(rule.name, 128) ? { name: boundedString(rule.name, 128) } : {}),
      layer: Object.fromEntries(["layerId", "surveyId", "releaseId", "productId", "modality", "coverageRole"].flatMap((key) => {
        const item = boundedString(layer[key], 200);
        return item ? [[key, item]] : [];
      })),
      relativePrefix: boundedString(rule.relativePrefix, 2048) ?? "",
      ...(boundedString(rule.includePattern, 256) ? { includePattern: boundedString(rule.includePattern, 256) } : {}),
      filters: {
        includeSuffixes: Array.isArray(filters.includeSuffixes) ? filters.includeSuffixes.filter((item): item is string => typeof item === "string" && item.length <= 128).slice(0, 128) : [],
        excludePatterns: Array.isArray(filters.excludePatterns) ? filters.excludePatterns.filter((item): item is string => typeof item === "string" && item.length <= 256).slice(0, 128) : [],
      },
      extraction: {
        ...(boundedString(extraction.mode, 64) ? { mode: boundedString(extraction.mode, 64) } : {}),
        ...(boundedCount(extraction.outputOrder) !== undefined ? { outputOrder: boundedCount(extraction.outputOrder) } : {}),
      },
    };
  });
  const rawStatus = resourceRecord(resource.status);
  const rawScope = resourceRecord(rawStatus.scope);
  const rawSummary = resourceRecord(rawStatus.summary);
  const scopeRules = Array.isArray(rawScope.rules) ? rawScope.rules.slice(0, 32).map(summaryRule).filter(Boolean) : [];
  const summaryRules = Array.isArray(rawSummary.rules) ? rawSummary.rules.slice(0, 32).map(summaryRule).filter(Boolean) : [];
  const phase = boundedString(rawStatus.phase, 32)?.toUpperCase();
  const status = {
    phase: phase && ["INVALID", "DISCOVERING", "RUNNING", "PARTIAL", "SUCCEEDED", "FAILED"].includes(phase) ? phase : "PENDING",
    ...(boundedString(rawStatus.reason, 128) ? { reason: boundedString(rawStatus.reason, 128) } : {}),
    ...(typeof rawStatus.discoveryComplete === "boolean" ? { discoveryComplete: rawStatus.discoveryComplete } : {}),
    scope: { rules: scopeRules },
    summary: {
      ...(boundedCount(rawSummary.completedRules) !== undefined ? { completedRules: boundedCount(rawSummary.completedRules) } : {}),
      rules: summaryRules,
    },
  };
  const name = boundedString(metadata.name, 63) ?? "";
  const connectorName = boundedString(resourceRecord(metadata.labels)["astro.zhejianglab.org/source-connector"], 63);
  const partitioning = resourceRecord(spec.partitioning);
  return {
    name,
    ...(boundedString(metadata.namespace, 253) ? { namespace: boundedString(metadata.namespace, 253) } : {}),
    ...(boundedString(metadata.creationTimestamp, 64) ? { createdAt: boundedString(metadata.creationTimestamp, 64) } : {}),
    ...(connectorName ? { sourceConnector: connectorName } : {}),
    sourcePaths: sourcePath ? [sourcePath] : [],
    rules,
    ...(typeof partitioning.scopeId === "string" ? { partitioning: { mode: "direct-child-prefixes", scopeId: partitioning.scopeId, ...(boundedCount(partitioning.maxPartitions) !== undefined ? { maxPartitions: partitioning.maxPartitions } : {}) } } : {}),
    ...(boundedCount(spec.maxConcurrent) !== undefined ? { maxConcurrent: spec.maxConcurrent } : {}),
    status,
  };
}
