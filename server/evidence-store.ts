import { createHash } from "node:crypto";

export type ReversePrecision = "exact" | "estimated" | "entrypoint-only" | "truncated";

export interface ReverseLookupRequest {
  layerIds: string[];
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
  scanRunId?: string;
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

export interface ReverseLookupResult {
  schemaVersion: 1;
  available: boolean;
  index: { coverage: string; files: string };
  requested: { order: number; nside: number; cells: number[]; layerIds: string[] };
  precision: ReversePrecision;
  edges: CoverageEdge[];
  sourceFiles: Array<Record<string, unknown>>;
  truncated: boolean;
  notes: string[];
}

export interface EvidenceStoreOptions {
  url?: string;
  coverageIndex?: string;
  fileIndex?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ReverseLookupOptions {
  tolerateUnavailable?: boolean;
}

interface SearchHit { _id?: string; _source?: Record<string, unknown> }
interface SearchResponse { hits?: { hits?: SearchHit[]; total?: number | { value?: number } } }

const text = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
const first = (source: Record<string, unknown>, keys: string[]): unknown => keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);

function stableEdgeId(source: Record<string, unknown>, fallback: string): string {
  const key = [source.layerId, source.layer_id, source.sourceFileId, source.source_file_id, source.order, source.ipix, source.tileId, source.tile_id].map((value) => String(value ?? "")).join("|");
  return createHash("sha256").update(key || fallback).digest("hex").slice(0, 24);
}

function normalizeEdge(hit: SearchHit, request: ReverseLookupRequest): CoverageEdge | undefined {
  const source = hit._source ?? {};
  const order = number(first(source, ["order", "healpix_order", "coverage_order"]));
  const ipix = number(first(source, ["ipix", "pixel", "healpix", "healpix_ipix", "healpix_pixel"]));
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
    downloadUrl: text(first(source, ["downloadUrl", "download_url", "sourceUrl", "source_url"])),
    precision: precision && ["exact", "estimated", "entrypoint-only", "truncated"].includes(precision) ? precision : "exact",
  };
}

export class EvidenceStoreError extends Error {
  constructor(message: string, readonly statusCode = 503) { super(message); this.name = "EvidenceStoreError"; }
}

/** Warehouse-only online evidence lookup. It deliberately has no legacy ES fallback. */
export class CoverageEvidenceStore {
  readonly url?: string;
  readonly coverageIndex: string;
  readonly fileIndex: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: EvidenceStoreOptions = {}) {
    this.url = options.url?.replace(/\/$/, "") || undefined;
    this.coverageIndex = options.coverageIndex ?? "astro_coverage_index_v1";
    this.fileIndex = options.fileIndex ?? "astro_file_index_v1";
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
      index: { coverage: this.coverageIndex, files: this.fileIndex },
      requested,
      precision: "entrypoint-only",
      edges: [],
      sourceFiles: [],
      truncated: false,
      notes: [note ?? "Warehouse evidence index is not configured; local MOC geometry is still available, but file-level reverse lookup is unavailable."],
    };
  }

  async reverseLookup(input: ReverseLookupRequest, options: ReverseLookupOptions = {}): Promise<ReverseLookupResult> {
    const layerIds = [...new Set(input.layerIds)].filter(Boolean);
    const cells = [...new Set(input.cells)].filter((cell) => Number.isSafeInteger(cell) && cell >= 0);
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
    const requested = { order: input.order, nside: 2 ** input.order, cells, layerIds };
    if (!Number.isSafeInteger(input.order) || input.order < 0 || input.order > 29 || !cells.length) throw new EvidenceStoreError("order and cells are required for reverse lookup", 400);
    if (!this.url) return this.unavailableResult({ ...input, layerIds, cells });
    const layerShould = layerIds.flatMap((layerId) => [
      { term: { "layerId.keyword": layerId } }, { term: { "layer_id.keyword": layerId } }, { term: { layerId } }, { term: { layer_id: layerId } },
    ]);
    const orderShould = ["order", "healpix_order", "coverage_order"].flatMap((field) => [{ term: { [field]: input.order } }, { term: { [`${field}.keyword`]: String(input.order) } }]);
    const pixelShould = ["ipix", "pixel", "healpix", "healpix_ipix", "healpix.ipix"].flatMap((field) => [{ terms: { [field]: cells } }, { terms: { [`${field}.keyword`]: cells.map(String) } }]);
    const query = {
      size: limit + 1,
      track_total_hits: true,
      query: { bool: { must: [
        { bool: { should: orderShould, minimum_should_match: 1 } },
        { bool: { should: pixelShould, minimum_should_match: 1 } },
        ...(layerShould.length ? [{ bool: { should: layerShould, minimum_should_match: 1 } }] : []),
      ] } },
    };
    let response: SearchResponse;
    try {
      response = await this.search(this.coverageIndex, query);
    } catch (error) {
      if (options.tolerateUnavailable && error instanceof EvidenceStoreError && error.statusCode >= 500) {
        return this.unavailableResult({ ...input, layerIds, cells }, "Warehouse evidence lookup is temporarily unavailable; overlap geometry remains valid, but file-level results could not be loaded.");
      }
      throw error;
    }
    const edges = (response.hits?.hits ?? []).map((hit) => normalizeEdge(hit, { ...input, layerIds, cells })).filter((edge): edge is CoverageEdge => Boolean(edge));
    const truncated = edges.length > limit || Number(typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value ?? 0) > limit;
    const capped = edges.slice(0, limit);
    const sourceIds = [...new Set(capped.map((edge) => edge.sourceFileId).filter((value): value is string => Boolean(value)))];
    let sourceFiles: Array<Record<string, unknown>> = [];
    try {
      sourceFiles = sourceIds.length ? await this.lookupFiles(sourceIds, limit) : [];
    } catch (error) {
      if (options.tolerateUnavailable && error instanceof EvidenceStoreError && error.statusCode >= 500) {
        return this.unavailableResult({ ...input, layerIds, cells }, "Warehouse evidence lookup is temporarily unavailable; overlap geometry remains valid, but file-level results could not be loaded.");
      }
      throw error;
    }
    return {
      schemaVersion: 1, available: true, index: { coverage: this.coverageIndex, files: this.fileIndex }, requested,
      precision: truncated ? "truncated" : capped.some((edge) => edge.precision !== "exact") ? "estimated" : "exact",
      edges: capped, sourceFiles, truncated,
      notes: ["Online reverse lookup is served by warehouse Elasticsearch coverage edges.", ...(truncated ? [`Result limited to ${limit} edges.`] : [])],
    };
  }

  private async lookupFiles(ids: string[], limit: number): Promise<Array<Record<string, unknown>>> {
    const response = await this.search(this.fileIndex, { size: limit, query: { bool: { should: [{ ids: { values: ids } }, { terms: { "fileId.keyword": ids } }, { terms: { "file_id.keyword": ids } }, { terms: { "source_file_id.keyword": ids } }], minimum_should_match: 1 } } });
    return (response.hits?.hits ?? []).map((hit) => ({ _id: hit._id, ...(hit._source ?? {}) }));
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
    return await response.json() as SearchResponse;
  }
}
