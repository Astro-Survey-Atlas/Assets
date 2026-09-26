import { createHash } from "node:crypto";
import { BATCH_EVIDENCE_LAYER_PREFIX, batchEvidenceLayerId, isBatchEvidenceLayerId } from "./scan-batch.js";
import { isExcludedWarehouseLayerId } from "./coverage.js";
import { DENIED_SURVEY_IDS, isDeniedLayerId, isDeniedSurvey } from "./publication-policy.js";

export type ReversePrecision = "exact" | "estimated" | "entrypoint-only" | "truncated";

export interface ReverseLookupRequest {
  layerIds: string[];
  evidenceLayerBindings?: Array<{ layerId: string; evidenceLayerId: string }>;
  /** File IDs already emitted by a signed cursor page. */
  excludeFileIds?: string[];
  order: number;
  cells: number[];
  limit?: number;
}

export interface CoverageEdge {
  edgeId: string;
  layerId?: string;
  surveyId?: string;
  releaseId?: string;
  productId?: string;
  product?: string;
  modality?: string;
  /** Actual Warehouse logical layer queried for this public layer. */
  evidenceLayerId?: string;
  scanRunId?: string;
  /** Immutable candidate used to join versioned file metadata. */
  observationLayerId?: string;
  scopeId?: string;
  partitionId?: string;
  sourceSnapshotSha256?: string;
  sourceFileId?: string;
  sourceUri?: string;
  fileName?: string;
  order: number;
  ipix: number;
  raMin?: number;
  raMax?: number;
  decMin?: number;
  decMax?: number;
  etag?: string;
  sizeBytes?: number;
  coverageMethod?: string;
  coverageRole?: string;
  downloadUrl?: string;
  precision: ReversePrecision;
}

export interface DownloadPlanMatch {
  layerId?: string;
  evidenceLayerId?: string;
  observationLayerId?: string;
  scopeId?: string;
  partitionId?: string;
  order: number;
  ipix: number;
  precision: ReversePrecision;
  coverageMethod?: string;
  coverageRole?: string;
  sourceOrder?: number;
  scanRunId?: string;
  sourceSnapshotSha256?: string;
}

export interface DownloadPlanFile {
  fileId: string;
  metadataState: "complete" | "missing";
  unitKind?: string;
  unitId?: string;
  downloadProvider?: string;
  fileName?: string;
  fileType?: string;
  sizeBytes?: number;
  lastModified?: string;
  etag?: string;
  sourceUri?: string;
  downloadable: boolean;
  downloadUrl?: string;
  matchingCoverage: DownloadPlanMatch[];
  matchingCoverageTruncated?: boolean;
  observations?: Array<{ layerId?: string; scanRunId?: string; sourceSnapshotSha256?: string; fileName?: string; sizeBytes?: number; lastModified?: string; sourceUri?: string; metadataState: "complete" | "missing" }>;
}

export interface DownloadPlanEntrypoint {
  kind: string;
  purpose: "data-access" | "coverage-reference";
  layerId?: string;
  productId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  order?: number;
  nside?: number;
  cells?: number[];
  precision: ReversePrecision;
  url?: string;
  /** Original source locator; may be HTTP(S), s3://, oss:// or file:///. */
  sourceUri?: string;
  sourceScope?: "prefix" | "file" | "tile-directory";
  sourceUrl?: string;
  mocUrl?: string;
  required?: boolean;
  selectionRule?: string;
  selectionComplete?: boolean;
  truncated?: boolean;
  note?: string;
  [key: string]: unknown;
}

export interface DownloadPlanTileSelection {
  layerId: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  tileIds: string[];
  selectionRule: string;
  complete: boolean;
  note: string;
}

export interface DownloadPlanCoverageEvidence {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality?: string;
  evidenceKind: "observation-footprint" | "published-moc" | "tile-footprint" | "wcs-coverage";
  order: number;
  nside: number;
  nativeMaxOrder: number;
  availableOrders: number[];
  matchedCells: number[];
  precision: "exact" | "estimated";
  completeness?: "complete" | "incomplete" | "unknown";
  scienceFileScan?: "not-scanned" | "partial" | "complete";
  sourceIdentity?: string;
  instrument?: string;
  filters?: string;
  sourceSnapshotSha256?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  geometrySourceUrl?: string;
  coverageUrl?: string;
  summary: string;
}

export interface DownloadPlan {
  schemaVersion: 1;
  files: DownloadPlanFile[];
  entrypoints: DownloadPlanEntrypoint[];
  coverageEvidence?: DownloadPlanCoverageEvidence[];
  tileSelections?: DownloadPlanTileSelection[];
  truncated: boolean;
  warnings: string[];
  scanScopes?: ScanScopeSummary[];
}

export interface DownloadPlanInput {
  edges: CoverageEdge[];
  sourceFiles: Array<Record<string, unknown>>;
  entrypoints?: DownloadPlanEntrypoint[];
  coverageEvidence?: DownloadPlanCoverageEvidence[];
  truncated: boolean;
  scanScopes?: ScanScopeSummary[];
  matchingCoverageTruncatedFileIds?: string[];
}

export interface ReverseLookupResult {
  schemaVersion: 1;
  available: boolean;
  index: { layer: string; coverage: string; files: string };
  requested: { order: number; nside: number; cells: number[]; layerIds: string[] };
  precision: ReversePrecision;
  edges: CoverageEdge[];
  sourceFiles: Array<Record<string, unknown>>;
  truncated: boolean;
  notes: string[];
  downloadPlan: DownloadPlan;
  scanScopes?: ScanScopeSummary[];
}

export interface ScanScopeSummary {
  /** Warehouse logical layer that owns the frozen scope. */
  layerId: string;
  /** Published coverage layer exposed to clients when this is an evidence alias. */
  publishedLayerId?: string;
  scopeId: string;
  scopeSnapshotSha256: string;
  expectedPartitions: number;
  committedPartitions: number;
  /** Completeness of the frozen scope only, never the entire scientific release. */
  completeness: "complete" | "incomplete";
}

interface EvidenceLayerBinding {
  /** Public layer identity retained on returned edges. */
  layerId: string;
  /** Warehouse logical layer identity resolved from ast_layer_index_v1. */
  evidenceLayerId: string;
  indexedLayerId: string;
  scanRunId?: string;
  scopeId?: string;
  partitionId?: string;
  sourceSnapshotSha256?: string;
  availableOrders?: number[];
  fileCount?: number;
  coverageCount?: number;
}

export interface EvidenceStoreOptions {
  url?: string;
  layerIndex?: string;
  coverageIndex?: string;
  fileIndex?: string;
  partitionIndex?: string;
  fileObservationIndex?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ReverseLookupOptions {
  tolerateUnavailable?: boolean;
}

interface SearchHit { _id?: string; _source?: Record<string, unknown>; sort?: unknown[] }
interface SearchResponse { timed_out?: boolean; _shards?: { failed?: number }; hits?: { hits?: SearchHit[]; total?: number | { value?: number } } }

export interface WarehouseLayerSnapshot {
  layerId: string;
  surveyId: string;
  releaseId: string;
  productId: string;
  modality?: string;
  coverageRole?: string;
  entrypoint?: string;
  state: string;
  scanRunId?: string;
  /** Number of committed scan runs when a partitioned scope has many runs. */
  scanRunCount?: number;
  sourceSnapshotSha256?: string;
  /** Number of distinct input snapshots when a partitioned scope has many. */
  sourceSnapshotCount?: number;
  availableOrders: number[];
  fileCount: number;
  coverageCount: number;
  errorCount: number;
  updatedAt?: string;
  scanScope?: ScanScopeSummary;
}

export interface WarehouseCoverageSnapshot {
  layerId: string;
  sourceFileId?: string;
  sourceUri?: string;
  order: number;
  ipix: number;
  coordinateFrame?: string;
  nesting?: string;
  coverageMethod?: string;
  coverageRole?: string;
  modality?: string;
  precision?: ReversePrecision;
  sourceOrder?: number;
}

export interface WarehouseCoverageCatalogSnapshot {
  layers: WarehouseLayerSnapshot[];
  coverages: WarehouseCoverageSnapshot[];
  truncated: boolean;
}

export interface WarehouseLayerStatusSnapshot {
  layerId: string;
  state: string;
  fileCount: number;
  coverageCount: number;
  errorCount: number;
  updatedAt?: string;
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
const first = (source: Record<string, unknown>, keys: string[]): unknown => keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);

const PRIVATE_HOST = /^(?:localhost|127(?:\.|$)|0(?:\.|$)|10(?:\.|$)|192\.168(?:\.|$)|169\.254(?:\.|$)|172\.(?:1[6-9]|2\d|3[0-1])(?:\.|$)|\[?::1\]?$)/i;
const INTERNAL_HOST = /(?:\.local$|\.internal$|\.svc(?:\.|$)|\.cluster\.local$|(?:^|[-.])(minio|elasticsearch|kubernetes)(?:[-.]|$))/i;
const MAX_WAREHOUSE_CATALOG_LAYER_IDS = 1000;

function safeWarehouseCatalogLayerIds(layerIds: readonly string[]): string[] {
  if (layerIds.length > MAX_WAREHOUSE_CATALOG_LAYER_IDS) {
    throw new EvidenceStoreError(`Warehouse layer allowlist exceeds ${MAX_WAREHOUSE_CATALOG_LAYER_IDS} IDs`, 400);
  }
  return [...new Set(layerIds.filter(layerId =>
    typeof layerId === "string"
    && layerId.length > 0
    && layerId.length <= 512
    && !isDeniedLayerId(layerId)
    && !isExcludedWarehouseLayerId(layerId)
    && !isBatchEvidenceLayerId(layerId),
  ))].sort();
}

function warehouseCatalogLayerQuery(layerIds: string[]): Record<string, unknown> {
  return {
    size: MAX_WAREHOUSE_CATALOG_LAYER_IDS,
    track_total_hits: true,
    query: { bool: {
      filter: [
        { terms: { state: ["ACTIVE", "PARTITIONED"] } },
        { terms: { layer_id: layerIds } },
      ],
      must_not: [
        { term: { layer_mode: "CANDIDATE" } },
        { terms: { survey_id: DENIED_SURVEY_IDS } },
        { prefix: { layer_id: BATCH_EVIDENCE_LAYER_PREFIX } },
        { prefix: { layer_id: "warehouse-selftest-" } },
        { prefix: { layer_id: "warehouse-caller-" } },
      ],
    } },
    sort: [{ layer_id: "asc" }],
  };
}

function safePublicHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || PRIVATE_HOST.test(parsed.hostname) || INTERNAL_HOST.test(parsed.hostname)) return undefined;
    return parsed.toString();
  } catch { return undefined; }
}

function locator(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/^(?:s3|oss):\/\//i.test(trimmed)) return trimmed;
  if (/^file:\/\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "file:" && !parsed.hostname && !parsed.username && !parsed.password) return trimmed;
    } catch { return undefined; }
  }
  return safePublicHttpUrl(trimmed);
}

function sourceIdentifier(source: Record<string, unknown>): string | undefined {
  const value = first(source, ["fileId", "file_id", "sourceFileId", "source_file_id", "_id"]);
  return typeof value === "string" && value.length ? value : undefined;
}

function sourceString(source: Record<string, unknown>, keys: string[]): string | undefined {
  const value = first(source, keys);
  return typeof value === "string" && value.length ? value : undefined;
}

function sourceNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  return number(first(source, keys));
}

function matchingKey(match: DownloadPlanMatch): string {
  return [match.layerId ?? "", match.evidenceLayerId ?? "", match.observationLayerId ?? "", match.scopeId ?? "", match.partitionId ?? "", match.order, match.ipix, match.precision, match.coverageMethod ?? "", match.coverageRole ?? "", match.sourceOrder ?? "", match.scanRunId ?? "", match.sourceSnapshotSha256 ?? ""].join("|");
}

/** Build the file-level public contract without turning coverage edges into files. */
export function buildDownloadPlan(input: DownloadPlanInput): DownloadPlan {
  const sourceById = new Map<string, Record<string, unknown>>();
  input.sourceFiles.forEach((source) => {
    const id = sourceIdentifier(source);
    if (id) sourceById.set(source.layer_id ? `${source.layer_id}\n${id}` : id, source);
  });
  const files = new Map<string, DownloadPlanFile>();
  const warnings = new Set<string>();
  for (const edge of input.edges) {
    const source = edge.sourceFileId ? sourceById.get(edge.observationLayerId ? `${edge.observationLayerId}\n${edge.sourceFileId}` : edge.sourceFileId) : undefined;
    const sourceUri = locator(sourceString(source ?? {}, ["sourceUri", "source_uri", "uri", "urn"]) ?? edge.sourceUri);
    const fileId = edge.sourceFileId ?? sourceIdentifier(source ?? {}) ?? (sourceUri ? `uri:${sourceUri}` : `edge:${edge.edgeId}`);
    const downloadUrl = safePublicHttpUrl(sourceString(source ?? {}, ["downloadUrl", "download_url"]) ?? edge.downloadUrl ?? sourceUri);
    const matchingCoverage: DownloadPlanMatch = {
      ...(edge.layerId ? { layerId: edge.layerId } : {}),
      ...(edge.evidenceLayerId ? { evidenceLayerId: edge.evidenceLayerId } : {}),
      ...(edge.observationLayerId ? { observationLayerId: edge.observationLayerId } : {}),
      ...(edge.scopeId ? { scopeId: edge.scopeId } : {}),
      ...(edge.partitionId ? { partitionId: edge.partitionId } : {}),
      ...(edge.scanRunId ? { scanRunId: edge.scanRunId } : {}),
      ...(edge.sourceSnapshotSha256 ? { sourceSnapshotSha256: edge.sourceSnapshotSha256 } : {}),
      order: edge.order,
      ipix: edge.ipix,
      precision: edge.precision,
      ...(edge.coverageMethod ? { coverageMethod: edge.coverageMethod } : {}),
      ...(edge.coverageRole ? { coverageRole: edge.coverageRole } : {}),
      ...(sourceNumber(source ?? {}, ["sourceOrder", "source_order"]) !== undefined ? { sourceOrder: sourceNumber(source ?? {}, ["sourceOrder", "source_order"]) } : {}),
    };
    const current = files.get(fileId);
    if (current) {
      const key = matchingKey(matchingCoverage);
      if (!current.matchingCoverage.some((match) => matchingKey(match) === key)) current.matchingCoverage.push(matchingCoverage);
      continue;
    }
    const metadataState = source ? "complete" : "missing";
    if (!source) warnings.add(`FileAsset metadata is missing for ${fileId}`);
    const fileName = sourceString(source ?? {}, ["fileName", "file_name", "name"]) ?? edge.fileName;
    const fileType = sourceString(source ?? {}, ["fileType", "file_type", "type"]);
    const unitKind = sourceString(source ?? {}, ["unitKind", "unit_kind"]);
    const unitId = sourceString(source ?? {}, ["unitId", "unit_id", "tileId", "tile_id"]);
    const downloadProvider = sourceString(source ?? {}, ["downloadProvider", "download_provider"]);
    const sizeBytes = sourceNumber(source ?? {}, ["sizeBytes", "size_bytes", "size"]) ?? edge.sizeBytes;
    const lastModified = sourceString(source ?? {}, ["lastModified", "last_modified"]);
    const etag = sourceString(source ?? {}, ["etag", "eTag", "ETag"]) ?? edge.etag;
    files.set(fileId, {
      fileId,
      metadataState,
      ...(unitKind ? { unitKind } : {}),
      ...(unitId ? { unitId } : {}),
      ...(downloadProvider ? { downloadProvider } : {}),
      ...(fileName ? { fileName } : {}),
      ...(fileType ? { fileType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(lastModified ? { lastModified } : {}),
      ...(etag ? { etag } : {}),
      ...(sourceUri ? { sourceUri } : {}),
      downloadable: Boolean(downloadUrl),
      ...(downloadUrl ? { downloadUrl } : {}),
      matchingCoverage: [matchingCoverage],
    });
  }
  for (const edge of input.edges.filter(edge => edge.observationLayerId && edge.sourceFileId)) {
    const file = files.get(edge.sourceFileId!);
    if (!file) continue;
    const source = sourceById.get(`${edge.observationLayerId}\n${edge.sourceFileId}`);
    const observation = {
      layerId: edge.layerId, scanRunId: edge.scanRunId, sourceSnapshotSha256: edge.sourceSnapshotSha256,
      metadataState: source ? "complete" as const : "missing" as const,
      fileName: sourceString(source ?? {}, ["file_name", "fileName"]),
      sizeBytes: sourceNumber(source ?? {}, ["size_bytes", "sizeBytes"]),
      lastModified: sourceString(source ?? {}, ["last_modified", "lastModified"]),
      sourceUri: locator(sourceString(source ?? {}, ["source_uri", "sourceUri"]) ?? edge.sourceUri),
    };
    file.observations ??= [];
    if (!file.observations.some(value => value.layerId === observation.layerId && value.scanRunId === observation.scanRunId)) file.observations.push(observation);
  }
  for (const fileId of input.matchingCoverageTruncatedFileIds ?? []) {
    const file = files.get(fileId);
    if (!file) continue;
    file.matchingCoverageTruncated = true;
    warnings.add(`Matching coverage for file ${fileId} is incomplete because the Warehouse edge limit omitted additional matches.`);
  }
  if (input.truncated) warnings.add("This reverse lookup manifest is incomplete because the bounded result limit was reached.");
  for (const file of files.values()) {
    if (!file.observations) continue;
    if (file.observations.some(value => value.metadataState === "missing")) {
      file.metadataState = "missing";
      warnings.add(`File observation metadata is missing for ${file.fileId}`);
    }
    if (file.observations.length < 2) continue;
    for (const key of ["fileName", "sizeBytes", "lastModified", "sourceUri"] as const) {
      if (new Set(file.observations.map(value => value[key])).size > 1) {
        delete file[key];
        warnings.add(`File ${file.fileId} has differing committed observations; inspect observations for version-specific metadata.`);
        if (key === "sourceUri") { delete file.downloadUrl; file.downloadable = false; }
      }
    }
  }
  const sortedFiles = [...files.values()].sort((left, right) => left.fileId.localeCompare(right.fileId));
  sortedFiles.forEach((file) => file.matchingCoverage.sort((left, right) => {
    const layer = (left.layerId ?? "").localeCompare(right.layerId ?? "");
    return layer || left.order - right.order || left.ipix - right.ipix;
  }));
  return {
    schemaVersion: 1,
    files: sortedFiles,
    entrypoints: [...(input.entrypoints ?? [])],
    ...(input.coverageEvidence?.length ? { coverageEvidence: [...input.coverageEvidence] } : {}),
    truncated: input.truncated,
    warnings: [...warnings],
    ...(input.scanScopes?.length ? { scanScopes: input.scanScopes } : {}),
  };
}

function stableEdgeId(source: Record<string, unknown>, fallback: string): string {
  const key = [source.layerId, source.layer_id, source.sourceFileId, source.source_file_id, source.order, source.ipix, source.tileId, source.tile_id].map((value) => String(value ?? "")).join("|");
  return createHash("sha256").update(key || fallback).digest("hex").slice(0, 24);
}

function normalizeEdge(hit: SearchHit, request: ReverseLookupRequest): CoverageEdge | undefined {
  const source = hit._source ?? {};
  const order = number(first(source, ["order", "healpix_order", "coverage_order"]));
  const ipix = number(first(source, ["ipix", "pixel", "healpix", "healpix_cell", "healpix_ipix", "healpix_pixel"]));
  if (order !== request.order || ipix === undefined || !request.cells.includes(ipix)) return undefined;
  const layerId = text(first(source, ["layerId", "layer_id", "layer"]));
  if (request.layerIds.length && layerId && !request.layerIds.includes(layerId)) return undefined;
  const precision = text(first(source, ["precision", "coverage_precision"])) as ReversePrecision | undefined;
  return {
    edgeId: hit._id ?? stableEdgeId(source, `${order}:${ipix}`),
    layerId,
    surveyId: text(first(source, ["surveyId", "survey_id", "survey"])),
    releaseId: text(first(source, ["releaseId", "release_id", "release"])),
    productId: text(first(source, ["productId", "product_id"])),
    product: text(first(source, ["product", "productName", "product_name"])),
    modality: text(first(source, ["modality", "data_modality"])),
    scanRunId: text(first(source, ["scanRunId", "scan_run_id", "runId", "run_id"])),
    sourceFileId: text(first(source, ["sourceFileId", "source_file_id", "fileId", "file_id"])),
    sourceUri: text(first(source, ["sourceUri", "source_uri", "uri", "urn"])),
    fileName: text(first(source, ["fileName", "file_name", "name"])),
    order,
    ipix,
    raMin: number(first(source, ["raMin", "ra_min", "ra_min_deg"])),
    raMax: number(first(source, ["raMax", "ra_max", "ra_max_deg"])),
    decMin: number(first(source, ["decMin", "dec_min", "dec_min_deg"])),
    decMax: number(first(source, ["decMax", "dec_max", "dec_max_deg"])),
    etag: text(first(source, ["etag", "eTag", "ETag"])),
    sizeBytes: number(first(source, ["sizeBytes", "size_bytes", "size"])),
    coverageMethod: text(first(source, ["coverageMethod", "coverage_method"])),
    coverageRole: text(first(source, ["coverageRole", "coverage_role"])),
    downloadUrl: text(first(source, ["downloadUrl", "download_url"])),
    precision: precision && ["exact", "estimated", "entrypoint-only", "truncated"].includes(precision) ? precision : "exact",
  };
}

export class EvidenceStoreError extends Error {
  constructor(message: string, readonly statusCode = 503) { super(message); this.name = "EvidenceStoreError"; }
}

/** Warehouse-only online evidence lookup. It deliberately has no legacy ES fallback. */
export class CoverageEvidenceStore {
  readonly url?: string;
  readonly layerIndex: string;
  readonly coverageIndex: string;
  readonly fileIndex: string;
  readonly partitionIndex: string;
  readonly fileObservationIndex: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: EvidenceStoreOptions = {}) {
    this.url = options.url?.replace(/\/$/, "") || undefined;
    this.layerIndex = options.layerIndex ?? "ast_layer_index_v1";
    this.coverageIndex = options.coverageIndex ?? "ast_coverage_index_v1";
    this.fileIndex = options.fileIndex ?? "ast_file_index_v1";
    this.partitionIndex = options.partitionIndex ?? "ast_partition_index_v1";
    this.fileObservationIndex = options.fileObservationIndex ?? "ast_file_observation_index_v1";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  get configured(): boolean { return Boolean(this.url); }

  unavailableResult(input: ReverseLookupRequest, note?: string): ReverseLookupResult {
    const layerIds = [...new Set(input.layerIds)].filter(Boolean);
    const cells = [...new Set(input.cells)].filter((cell) => Number.isSafeInteger(cell) && cell >= 0);
    const requested = { order: input.order, nside: 2 ** input.order, cells, layerIds };
    return {
      schemaVersion: 1,
      available: false,
      index: { layer: this.layerIndex, coverage: this.coverageIndex, files: this.fileIndex },
      requested,
      precision: "entrypoint-only",
      edges: [],
      sourceFiles: [],
      truncated: false,
      notes: [note ?? "Warehouse evidence index is not configured; local MOC geometry is still available, but file-level reverse lookup is unavailable."],
      downloadPlan: buildDownloadPlan({ edges: [], sourceFiles: [], truncated: false }),
    };
  }

  async reverseLookup(input: ReverseLookupRequest, options: ReverseLookupOptions = {}): Promise<ReverseLookupResult> {
    const layerIds = [...new Set(input.layerIds)].filter(Boolean);
    const cells = [...new Set(input.cells)].filter((cell) => Number.isSafeInteger(cell) && cell >= 0);
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
    const requested = { order: input.order, nside: 2 ** input.order, cells, layerIds };
    if (!Number.isSafeInteger(input.order) || input.order < 0 || input.order > 29 || !cells.length) throw new EvidenceStoreError("order and cells are required for reverse lookup", 400);
    if (!this.url) return this.unavailableResult({ ...input, layerIds, cells });
    let response: SearchResponse;
    let bindings: EvidenceLayerBinding[] = [];
    let scanScopes: ScanScopeSummary[] = [];
    try {
      ({ bindings, scanScopes } = await this.resolveEvidenceLayers(layerIds, input.evidenceLayerBindings));
      const indexedIds = bindings.filter(binding => !binding.availableOrders || binding.availableOrders.includes(input.order)).map(binding => binding.indexedLayerId);
      const layerShould = [{ terms: { layer_id: indexedIds } }];
      const orderShould = [{ term: { healpix_order: input.order } }];
      const pixelShould = [{ terms: { healpix_cell: cells } }];
      const excludeFileIds = [...new Set(input.excludeFileIds ?? [])];
      if (excludeFileIds.some(fileId => typeof fileId !== "string" || !fileId.length || fileId.length > 512)) {
        throw new EvidenceStoreError("Excluded file IDs are invalid", 400);
      }
      const query = {
        size: limit + 1,
        track_total_hits: true,
        sort: [{ source_file_id: "asc" }, { layer_id: "asc" }, { healpix_cell: "asc" }, { coverage_role: "asc" }],
        query: { bool: { must: [
          { bool: { should: orderShould, minimum_should_match: 1 } },
          { bool: { should: pixelShould, minimum_should_match: 1 } },
          ...(layerShould.length ? [{ bool: { should: layerShould, minimum_should_match: 1 } }] : []),
        ], ...(excludeFileIds.length ? { must_not: [{ terms: { source_file_id: excludeFileIds } }] } : {}) } },
      };
      response = indexedIds.length ? await this.search(this.coverageIndex, query) : { hits: { hits: [] } };
    } catch (error) {
      if (options.tolerateUnavailable && error instanceof EvidenceStoreError && error.statusCode >= 500) {
        return this.unavailableResult({ ...input, layerIds, cells }, "Warehouse evidence lookup is temporarily unavailable; overlap geometry remains valid, but file-level results could not be loaded.");
      }
      throw error;
    }
    const byIndexedLayer = new Map(bindings.map(binding => [binding.indexedLayerId, binding]));
    const edges = (response.hits?.hits ?? []).flatMap(hit => {
      // Membership is checked with the committed-candidate map below.
      const edge = normalizeEdge(hit, { ...input, layerIds: [], cells });
      const binding = edge?.layerId ? byIndexedLayer.get(edge.layerId) : undefined;
      if (!edge || !binding) return [];
      return [{ ...edge, layerId: binding.layerId, evidenceLayerId: binding.evidenceLayerId, ...(binding.scopeId ? {
        observationLayerId: binding.indexedLayerId, scanRunId: binding.scanRunId,
        scopeId: binding.scopeId, partitionId: binding.partitionId, sourceSnapshotSha256: binding.sourceSnapshotSha256,
      } : {}) }];
    });
    const truncated = edges.length > limit || Number(typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value ?? 0) > limit;
    const capped = edges.slice(0, limit);
    const overflowEdge = edges[limit];
    const lastCappedEdge = capped.at(-1);
    const matchingCoverageTruncatedFileIds = overflowEdge?.sourceFileId && overflowEdge.sourceFileId === lastCappedEdge?.sourceFileId
      ? [overflowEdge.sourceFileId]
      : [];
    const sourceIds = [...new Set(capped.filter(edge => !edge.observationLayerId).map((edge) => edge.sourceFileId).filter((value): value is string => Boolean(value)))];
    let sourceFiles: Array<Record<string, unknown>> = [];
    try {
      sourceFiles = sourceIds.length ? await this.lookupFiles(sourceIds, limit) : [];
      sourceFiles.push(...await this.lookupFileObservations(capped));
    } catch (error) {
      if (options.tolerateUnavailable && error instanceof EvidenceStoreError && error.statusCode >= 500) {
        return this.unavailableResult({ ...input, layerIds, cells }, "Warehouse evidence lookup is temporarily unavailable; overlap geometry remains valid, but file-level results could not be loaded.");
      }
      throw error;
    }
    return {
      schemaVersion: 1, available: true, index: { layer: this.layerIndex, coverage: this.coverageIndex, files: this.fileIndex }, requested,
      precision: truncated ? "truncated" : capped.some((edge) => edge.precision !== "exact") ? "estimated" : "exact",
      edges: capped, sourceFiles, truncated,
      ...(scanScopes.length ? { scanScopes } : {}),
      notes: ["Online reverse lookup is served by warehouse Elasticsearch coverage edges.", ...scanScopes.map(scope => `${scope.layerId}: ${scope.committedPartitions}/${scope.expectedPartitions} partitions committed in frozen scope ${scope.scopeId}; this does not establish complete survey coverage.`), ...(truncated ? [`Result limited to ${limit} edges.`] : [])],
      downloadPlan: buildDownloadPlan({ edges: capped, sourceFiles, truncated, scanScopes, matchingCoverageTruncatedFileIds }),
    };
  }

  private async lookupFiles(ids: string[], limit: number): Promise<Array<Record<string, unknown>>> {
    const response = await this.search(this.fileIndex, { size: limit, query: { bool: { should: [{ ids: { values: ids } }, { terms: { file_id: ids } }], minimum_should_match: 1 } } });
    return (response.hits?.hits ?? []).map((hit) => ({ _id: hit._id, ...(hit._source ?? {}) }));
  }

  /**
   * Read only the current public layer metadata.  This is intentionally
   * separate from the full coverage catalog: a public DESI layer can have
   * more edges than the bounded startup catalog is allowed to materialize, but
   * its state, scan run and counts are still useful in overlap details.
   */
  async loadCurrentCoverageLayers(options: { allowedLayerIds: readonly string[] }): Promise<WarehouseLayerSnapshot[]> {
    if (!this.url) return [];
    const allowedLayerIds = safeWarehouseCatalogLayerIds(options.allowedLayerIds);
    if (!allowedLayerIds.length) return [];
    const allowedSet = new Set(allowedLayerIds);
    const response = await this.search(this.layerIndex, warehouseCatalogLayerQuery(allowedLayerIds));
    const hits = response.hits?.hits ?? [];
    const total = typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value ?? hits.length;
    if (total > hits.length) throw new EvidenceStoreError("Warehouse logical layer catalog is truncated");
    return hits
      .filter(hit => {
        const layerId = text(hit._source?.layer_id) ?? hit._id ?? "";
        return allowedSet.has(layerId)
          && hit._source?.layer_mode !== "CANDIDATE"
          && !isDeniedSurvey(text(hit._source?.survey_id))
          && !isDeniedLayerId(layerId)
          && !isExcludedWarehouseLayerId(layerId)
          && !isBatchEvidenceLayerId(layerId);
      })
      .map((hit) => this.normalizeLayer(hit))
      .filter((layer): layer is WarehouseLayerSnapshot => Boolean(layer));
  }

  /**
   * Resolve public layer identities through their server-owned batch aliases
   * and return bounded layer metadata without materializing coverage edges.
   * Partitioned batches expose one aggregate row per public layer; their
   * committed partition counters and snapshots are folded into that row.
   */
  async loadCurrentCoverageEvidenceSnapshots(layers: ReadonlyArray<{
    layerId: string;
    surveyId: string;
    releaseId: string;
    productId: string;
    modality?: string;
  }>): Promise<WarehouseLayerSnapshot[]> {
    if (!this.url || !layers.length) return [];
    const publicLayers = layers.filter((layer) =>
      typeof layer.layerId === "string" && layer.layerId.length > 0
      && typeof layer.surveyId === "string" && layer.surveyId.length > 0
      && typeof layer.releaseId === "string" && layer.releaseId.length > 0
      && typeof layer.productId === "string" && layer.productId.length > 0,
    );
    const snapshots = await Promise.all(publicLayers.map(async (layer) => {
      const evidenceLayerId = batchEvidenceLayerId(layer.productId);
      let resolved: Awaited<ReturnType<CoverageEvidenceStore["resolveEvidenceLayers"]>>;
      try {
        resolved = await this.resolveEvidenceLayers([layer.layerId], [{ layerId: layer.layerId, evidenceLayerId }]);
      } catch (error) {
        // A published geometry without a corresponding scan alias is still a
        // valid public layer; it simply has no Warehouse metadata to show.
        if (error instanceof EvidenceStoreError && error.statusCode === 409 && error.message.startsWith("Warehouse layer is not ACTIVE:")) return undefined;
        throw error;
      }
      if (!resolved.bindings.length) return undefined;
      const availableOrders = [...new Set(resolved.bindings.flatMap((binding) => binding.availableOrders ?? []))].sort((left, right) => left - right);
      const fileCount = resolved.bindings.some((binding) => binding.fileCount !== undefined)
        ? resolved.bindings.reduce((total, binding) => total + (binding.fileCount ?? 0), 0)
        : Number(resolved.sources.get(resolved.bindings[0]!.evidenceLayerId)?.file_count ?? 0);
      const coverageCount = resolved.bindings.some((binding) => binding.coverageCount !== undefined)
        ? resolved.bindings.reduce((total, binding) => total + (binding.coverageCount ?? 0), 0)
        : Number(resolved.sources.get(resolved.bindings[0]!.evidenceLayerId)?.coverage_count ?? 0);
      const scanRuns = [...new Set(resolved.bindings.map((binding) => binding.scanRunId).filter((value): value is string => Boolean(value)))];
      const sourceSnapshots = [...new Set(resolved.bindings.map((binding) => binding.sourceSnapshotSha256).filter((value): value is string => Boolean(value)))];
      const source = resolved.sources.get(resolved.bindings[0]!.evidenceLayerId);
      const sourceOrders = Array.isArray(source?.available_orders)
        ? source.available_orders.filter((value): value is number => Number.isSafeInteger(value))
        : [];
      const scanScope = resolved.scanScopes.find((scope) => scope.publishedLayerId === layer.layerId || scope.layerId === resolved.bindings[0]!.evidenceLayerId);
      return {
        layerId: layer.layerId,
        surveyId: layer.surveyId,
        releaseId: layer.releaseId,
        productId: layer.productId,
        ...(layer.modality ? { modality: layer.modality } : {}),
        state: "ACTIVE",
        ...(scanRuns.length === 1 ? { scanRunId: scanRuns[0] } : {}),
        ...(scanRuns.length > 1 ? { scanRunCount: scanRuns.length } : {}),
        ...(sourceSnapshots.length === 1 ? { sourceSnapshotSha256: sourceSnapshots[0] } : {}),
        ...(sourceSnapshots.length > 1 ? { sourceSnapshotCount: sourceSnapshots.length } : {}),
        availableOrders: availableOrders.length ? availableOrders : sourceOrders,
        fileCount: Number.isFinite(fileCount) ? fileCount : 0,
        coverageCount: Number.isFinite(coverageCount) ? coverageCount : 0,
        errorCount: 0,
        ...(typeof source?.updated_at === "string" ? { updatedAt: source.updated_at } : {}),
        ...(scanScope ? { scanScope } : {}),
      } satisfies WarehouseLayerSnapshot;
    }));
    return snapshots.filter((snapshot): snapshot is WarehouseLayerSnapshot => Boolean(snapshot));
  }

  /** Load explicitly public geometry and separate readiness-only draft metadata. */
  async loadCurrentCoverageCatalog(options: {
    allowedLayerIds: readonly string[];
    maxDocuments?: number;
  }): Promise<WarehouseCoverageCatalogSnapshot | null> {
    if (!this.url) return null;
    const maxDocuments = options.maxDocuments ?? Number(process.env.ASSETS_WAREHOUSE_COVERAGE_MAX_DOCS ?? "200000");
    if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1) throw new EvidenceStoreError("ASSETS_WAREHOUSE_COVERAGE_MAX_DOCS must be a positive integer", 500);
    const allowedLayerIds = safeWarehouseCatalogLayerIds(options.allowedLayerIds);
    if (!allowedLayerIds.length) return { layers: [], coverages: [], truncated: false };
    const allowedSet = new Set(allowedLayerIds);
    const layerResponse = await this.search(this.layerIndex, warehouseCatalogLayerQuery(allowedLayerIds));
    const returnedLayerHits = layerResponse.hits?.hits ?? [];
    const layerTotal = typeof layerResponse.hits?.total === "number" ? layerResponse.hits.total : layerResponse.hits?.total?.value ?? returnedLayerHits.length;
    if (layerTotal > returnedLayerHits.length) throw new EvidenceStoreError("Warehouse logical layer catalog is truncated");
    const layerHits = returnedLayerHits.filter(hit => {
      const layerId = text(hit._source?.layer_id) ?? hit._id ?? "";
      return allowedSet.has(layerId)
        && hit._source?.layer_mode !== "CANDIDATE"
        && !isDeniedSurvey(text(hit._source?.survey_id))
        && !isDeniedLayerId(layerId)
        && !isExcludedWarehouseLayerId(layerId)
        && !isBatchEvidenceLayerId(layerId);
    });
    const layers = layerHits.map((hit) => this.normalizeLayer(hit)).filter((layer): layer is WarehouseLayerSnapshot => Boolean(layer));
    if (!layers.length) return { layers: [], coverages: [], truncated: false };
    const coverages: WarehouseCoverageSnapshot[] = [];
    for (const layer of layers) {
      const raw = layerHits.find(hit => (text(hit._source?.layer_id) ?? hit._id) === layer.layerId)?._source;
      let indexedLayerIds = [layer.layerId];
      if (raw?.layer_mode === "PARTITIONED" || layer.state === "PARTITIONED") {
        const resolved = await this.resolveEvidenceLayers([layer.layerId]);
        indexedLayerIds = resolved.bindings.map(binding => binding.indexedLayerId);
        layer.scanScope = resolved.scanScopes[0];
        layer.availableOrders = [...new Set(resolved.bindings.flatMap(binding => binding.availableOrders ?? []))].sort((a, b) => a - b);
        layer.fileCount = resolved.bindings.reduce((total, binding) => total + (binding.fileCount ?? 0), 0);
        layer.coverageCount = resolved.bindings.reduce((total, binding) => total + (binding.coverageCount ?? 0), 0);
      }
      if (!indexedLayerIds.length) continue;
      let searchAfter: unknown[] | undefined;
      let loadedForLayer = 0;
      while (true) {
        const remaining = maxDocuments - coverages.length;
        const response = await this.search(this.coverageIndex, {
          // Elasticsearch caps a single search response at 10,000 hits. Keep
          // the page bounded and advance with the explicit sort tuple below.
          size: Math.min(10_000, Math.max(1, remaining + 1)),
          track_total_hits: true,
          query: { bool: { filter: [{ terms: { layer_id: indexedLayerIds } }] } },
          sort: [
            { layer_id: "asc" },
            { source_file_id: "asc" },
            { healpix_order: "asc" },
            { healpix_cell: "asc" },
            { coverage_role: "asc" },
          ],
          ...(searchAfter ? { search_after: searchAfter } : {}),
        });
        const hits = response.hits?.hits ?? [];
        const total = typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value;
        const allowedHits = hits.filter(hit => {
          const indexedLayerId = text(hit._source?.layer_id);
          return Boolean(indexedLayerId && indexedLayerIds.includes(indexedLayerId) && !isBatchEvidenceLayerId(indexedLayerId));
        });
        if (allowedHits.length > remaining) throw new EvidenceStoreError(`Warehouse coverage catalog exceeds the configured ${maxDocuments} document limit`, 503);
        for (const hit of allowedHits) {
          const coverage = this.normalizeWarehouseCoverage(hit, layer.layerId);
          if (coverage) coverages.push(coverage);
        }
        loadedForLayer += hits.length;
        const hasMore = total !== undefined ? total > loadedForLayer : hits.length === Math.min(10_000, Math.max(1, remaining + 1));
        if (!hasMore) break;
        const lastSort = hits.at(-1)?.sort;
        if (!lastSort?.length) throw new EvidenceStoreError(`Warehouse coverage page for ${layer.layerId} is missing a stable sort cursor`, 503);
        searchAfter = lastSort;
      }
    }
    return { layers, coverages, truncated: false };
  }

  /** Read only bounded counters for known draft layers; this never reads coverage edges. */
  async loadCurrentCoverageLayerStatuses(layerIds: readonly string[]): Promise<WarehouseLayerStatusSnapshot[]> {
    if (!this.url) return [];
    const requestedLayerIds = safeWarehouseCatalogLayerIds(layerIds);
    if (!requestedLayerIds.length) return [];
    const response = await this.search(this.layerIndex, {
      ...warehouseCatalogLayerQuery(requestedLayerIds),
      _source: ["layer_id", "state", "file_count", "coverage_count", "error_count", "updated_at"],
    });
    const hits = response.hits?.hits ?? [];
    const total = typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value ?? hits.length;
    if (total > hits.length) throw new EvidenceStoreError("Warehouse readiness layer catalog is truncated");
    const allowed = new Set(requestedLayerIds);
    return hits.flatMap(hit => {
      const source = hit._source ?? {};
      const layerId = text(source.layer_id) ?? hit._id;
      if (!layerId || !allowed.has(layerId) || isDeniedLayerId(layerId) || isExcludedWarehouseLayerId(layerId) || isBatchEvidenceLayerId(layerId)) return [];
      return [{
        layerId,
        state: text(source.state) ?? "UNKNOWN",
        fileCount: number(source.file_count) ?? 0,
        coverageCount: number(source.coverage_count) ?? 0,
        errorCount: number(source.error_count) ?? 0,
        ...(text(source.updated_at) ? { updatedAt: text(source.updated_at) } : {}),
      }];
    });
  }

  private async resolveEvidenceLayers(
    layerIds: string[],
    evidenceLayerBindings: Array<{ layerId: string; evidenceLayerId: string }> = [],
  ): Promise<{ bindings: EvidenceLayerBinding[]; scanScopes: ScanScopeSummary[]; sources: ReadonlyMap<string, Record<string, unknown>> }> {
    const aliasesByLayer = new Map<string, string>();
    for (const alias of evidenceLayerBindings) {
      if (!alias.layerId || !alias.evidenceLayerId || !layerIds.includes(alias.layerId)) {
        throw new EvidenceStoreError("Evidence layer bindings must reference a requested public layer", 400);
      }
      const existing = aliasesByLayer.get(alias.layerId);
      if (existing && existing !== alias.evidenceLayerId) {
        throw new EvidenceStoreError(`Multiple evidence layers were supplied for ${alias.layerId}`, 400);
      }
      aliasesByLayer.set(alias.layerId, alias.evidenceLayerId);
    }
    const targets = layerIds.flatMap(layerId => [
      { layerId, evidenceLayerId: layerId },
      ...(aliasesByLayer.has(layerId) ? [{ layerId, evidenceLayerId: aliasesByLayer.get(layerId)! }] : []),
    ]);
    const uniqueTargets = [...new Map(targets.map(target => [`${target.layerId}\n${target.evidenceLayerId}`, target])).values()];
    const evidenceLayerIds = [...new Set(uniqueTargets.map(target => target.evidenceLayerId))];
    const response = await this.search(this.layerIndex, {
      size: evidenceLayerIds.length || 1000,
      track_total_hits: true,
      query: { bool: {
        filter: [
          evidenceLayerIds.length ? { terms: { layer_id: evidenceLayerIds } } : { terms: { state: ["ACTIVE", "PARTITIONED"] } },
          { terms: { state: ["ACTIVE", "PARTITIONED"] } },
        ],
        must_not: [{ term: { layer_mode: "CANDIDATE" } }],
      } },
    });
    const hits = response.hits?.hits ?? [];
    const total = typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value ?? hits.length;
    if (total > hits.length) throw new EvidenceStoreError("Warehouse logical layer selection is truncated");
    const sources = new Map(hits.map(hit => [text(hit._source?.layer_id) ?? hit._id ?? "", hit._source ?? {}]));
    const bindings: EvidenceLayerBinding[] = [];
    const scanScopes: ScanScopeSummary[] = [];
    const resolvedTargets = (layerIds.length ? uniqueTargets : [...sources.keys()].map(layerId => ({ layerId, evidenceLayerId: layerId })))
      .filter(target => {
        const source = sources.get(target.evidenceLayerId);
        return source && source.layer_mode !== "CANDIDATE" && ["ACTIVE", "PARTITIONED"].includes(String(source.state));
      });
    const unresolvedPublicLayers = layerIds.filter(layerId => !resolvedTargets.some(target => target.layerId === layerId));
    if (unresolvedPublicLayers.length) {
      throw new EvidenceStoreError(`Warehouse layer is not ACTIVE: ${unresolvedPublicLayers.join(", ")}`, 409);
    }
    for (const target of resolvedTargets) {
      const { layerId, evidenceLayerId } = target;
      const source = sources.get(evidenceLayerId)!;
      if (source.state === "ACTIVE" && source.layer_mode !== "PARTITIONED") {
        bindings.push({ layerId, evidenceLayerId, indexedLayerId: evidenceLayerId });
        continue;
      }
      const scopeId = text(source.active_scope_id);
      const hash = text(source.scope_snapshot_sha256);
      const expected = number(source.expected_partition_count);
      if (!scopeId || !hash || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(expected) || expected! < 1 || expected! > 2048) throw new EvidenceStoreError(`Warehouse partition scope is invalid for ${evidenceLayerId}`);
      const partitions = await this.search(this.partitionIndex, {
        size: expected! + 1, track_total_hits: true,
        query: { bool: { filter: [{ term: { layer_id: evidenceLayerId } }, { term: { scope_id: scopeId } }] } },
      });
      const rows = (partitions.hits?.hits ?? []).map(hit => hit._source ?? {});
      const count = typeof partitions.hits?.total === "number" ? partitions.hits.total : partitions.hits?.total?.value ?? rows.length;
      if (count > rows.length || rows.length > expected! + 1) throw new EvidenceStoreError(`Warehouse partition scope is truncated for ${evidenceLayerId}`);
      if (rows.filter(row => row.state === "SCOPE" && row.partition_id === "scope-lock").length !== 1) throw new EvidenceStoreError(`Warehouse partition scope lock is missing for ${evidenceLayerId}`);
      const partitionIds = new Set<string>();
      const candidateIds = new Set<string>();
      let committed = 0;
      for (const row of rows) {
        if (row.layer_id !== evidenceLayerId || row.scope_id !== scopeId || row.scope_snapshot_sha256 !== hash || number(row.expected_partition_count) !== expected || number(row.partition_version) !== 1) throw new EvidenceStoreError(`Warehouse partition scope snapshot mismatch for ${evidenceLayerId}`);
        if (row.state === "SCOPE" && row.partition_id === "scope-lock") continue;
        const partitionId = text(row.partition_id);
        if (!partitionId || partitionId === "scope-lock" || partitionIds.has(partitionId)) throw new EvidenceStoreError(`Warehouse partition scope contains duplicate or invalid members for ${evidenceLayerId}`);
        partitionIds.add(partitionId);
        if (row.state !== "ACTIVE") continue;
        const indexedLayerId = text(row.active_layer_id);
        const scanRunId = text(row.active_scan_run_id);
        const snapshot = text(row.source_snapshot_sha256);
        const availableOrders = row.available_orders;
        if (!indexedLayerId || !scanRunId || !snapshot || !/^[a-f0-9]{64}$/.test(snapshot) || candidateIds.has(indexedLayerId) || !Array.isArray(availableOrders) || availableOrders.some(value => !Number.isInteger(value) || Number(value) < 0 || Number(value) > 29)) throw new EvidenceStoreError(`Warehouse active partition evidence is invalid for ${evidenceLayerId}`);
        candidateIds.add(indexedLayerId);
        committed++;
        bindings.push({ layerId, evidenceLayerId, indexedLayerId, scanRunId, scopeId, partitionId, sourceSnapshotSha256: snapshot, availableOrders: availableOrders as number[], fileCount: number(row.file_count) ?? 0, coverageCount: number(row.coverage_count) ?? 0 });
      }
      scanScopes.push({ layerId: evidenceLayerId, ...(layerId !== evidenceLayerId ? { publishedLayerId: layerId } : {}), scopeId, scopeSnapshotSha256: hash, expectedPartitions: expected!, committedPartitions: committed, completeness: committed === expected ? "complete" : "incomplete" });
    }
    return { bindings, scanScopes, sources };
  }

  private async lookupFileObservations(edges: CoverageEdge[]): Promise<Array<Record<string, unknown>>> {
    const expected = new Map(edges.filter(edge => edge.observationLayerId && edge.sourceFileId).map(edge => [
      createHash("sha256").update(`${edge.observationLayerId}\n${edge.sourceFileId}`).digest("hex"), edge,
    ]));
    if (!expected.size) return [];
    const response = await this.search(this.fileObservationIndex, { size: expected.size, query: { ids: { values: [...expected.keys()] } } });
    return (response.hits?.hits ?? []).flatMap(hit => {
      const source = hit._source ?? {};
      const key = createHash("sha256").update(`${source.layer_id}\n${source.file_id}`).digest("hex");
      const edge = expected.get(key);
      if (!edge || source.scan_run_id !== edge.scanRunId) throw new EvidenceStoreError("Warehouse file observation does not match committed partition");
      return [{ ...source, _id: hit._id }];
    });
  }

  private normalizeLayer(hit: SearchHit): WarehouseLayerSnapshot | undefined {
    const source = hit._source ?? {};
    const layerId = text(source.layer_id) ?? hit._id;
    const surveyId = text(source.survey_id);
    const releaseId = text(source.release_id);
    const productId = text(source.product_id);
    if (!layerId || !surveyId || !releaseId || !productId) return undefined;
    const availableOrders = Array.isArray(source.available_orders) ? source.available_orders.map(number).filter((value): value is number => value !== undefined) : [];
    return {
      layerId, surveyId, releaseId, productId,
      modality: text(source.modality), coverageRole: text(source.coverage_role), entrypoint: text(source.entrypoint),
      state: text(source.state) ?? "UNKNOWN", scanRunId: text(source.scan_run_id), sourceSnapshotSha256: text(source.source_snapshot_sha256),
      availableOrders: [...new Set(availableOrders)].sort((a, b) => a - b), fileCount: number(source.file_count) ?? 0,
      coverageCount: number(source.coverage_count) ?? 0, errorCount: number(source.error_count) ?? 0, updatedAt: text(source.updated_at),
    };
  }

  private normalizeWarehouseCoverage(hit: SearchHit, layerId: string): WarehouseCoverageSnapshot | undefined {
    const source = hit._source ?? {};
    const order = number(source.healpix_order);
    const ipix = number(source.healpix_cell);
    if (order === undefined || ipix === undefined) return undefined;
    const precision = text(source.precision) as ReversePrecision | undefined;
    return {
      layerId,
      sourceFileId: text(source.source_file_id), sourceUri: text(source.source_uri), order, ipix,
      coordinateFrame: text(source.coordinate_frame), nesting: text(source.nesting), coverageMethod: text(source.coverage_method),
      coverageRole: text(source.coverage_role), modality: text(source.modality),
      precision: precision && ["exact", "estimated", "entrypoint-only", "truncated"].includes(precision) ? precision : undefined,
      sourceOrder: number(source.source_order),
    };
  }

  private async search(index: string, body: unknown): Promise<SearchResponse> {
    if (!this.url) throw new EvidenceStoreError("Warehouse evidence index is not configured");
    let response: Response;
    try {
      response = await this.#fetch(`${this.url}/${encodeURIComponent(index)}/_search`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      throw new EvidenceStoreError(`Warehouse evidence search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      if (response.status === 404) return { hits: { hits: [] } };
      throw new EvidenceStoreError(`Warehouse evidence search returned HTTP ${response.status}`);
    }
    const result = await response.json() as SearchResponse;
    if (result.timed_out || (result._shards?.failed ?? 0) > 0) throw new EvidenceStoreError("Warehouse evidence search returned partial results");
    return result;
  }
}
