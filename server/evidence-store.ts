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
  index: { layer: string; coverage: string; files: string };
  requested: { order: number; nside: number; cells: number[]; layerIds: string[] };
  precision: ReversePrecision;
  edges: CoverageEdge[];
  sourceFiles: Array<Record<string, unknown>>;
  truncated: boolean;
  notes: string[];
}

export interface EvidenceStoreOptions {
  url?: string;
  layerIndex?: string;
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
  sourceSnapshotSha256?: string;
  availableOrders: number[];
  fileCount: number;
  coverageCount: number;
  errorCount: number;
  updatedAt?: string;
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
  readonly layerIndex: string;
  readonly coverageIndex: string;
  readonly fileIndex: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: EvidenceStoreOptions = {}) {
    this.url = options.url?.replace(/\/$/, "") || undefined;
    this.layerIndex = options.layerIndex ?? "ast_layer_index_v1";
    this.coverageIndex = options.coverageIndex ?? "ast_coverage_index_v1";
    this.fileIndex = options.fileIndex ?? "ast_file_index_v1";
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
    try {
      await this.requireActiveLayers(layerIds);
      const layerShould = layerIds.length ? [{ terms: { layer_id: layerIds } }] : [];
      const orderShould = [{ term: { healpix_order: input.order } }];
      const pixelShould = [{ terms: { healpix_cell: cells } }];
      const query = {
        size: limit + 1,
        track_total_hits: true,
        query: { bool: { must: [
          { bool: { should: orderShould, minimum_should_match: 1 } },
          { bool: { should: pixelShould, minimum_should_match: 1 } },
          ...(layerShould.length ? [{ bool: { should: layerShould, minimum_should_match: 1 } }] : []),
        ] } },
      };
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
      schemaVersion: 1, available: true, index: { layer: this.layerIndex, coverage: this.coverageIndex, files: this.fileIndex }, requested,
      precision: truncated ? "truncated" : capped.some((edge) => edge.precision !== "exact") ? "estimated" : "exact",
      edges: capped, sourceFiles, truncated,
      notes: ["Online reverse lookup is served by warehouse Elasticsearch coverage edges.", ...(truncated ? [`Result limited to ${limit} edges.`] : [])],
    };
  }

  private async lookupFiles(ids: string[], limit: number): Promise<Array<Record<string, unknown>>> {
    const response = await this.search(this.fileIndex, { size: limit, query: { bool: { should: [{ ids: { values: ids } }, { terms: { file_id: ids } }], minimum_should_match: 1 } } });
    return (response.hits?.hits ?? []).map((hit) => ({ _id: hit._id, ...(hit._source ?? {}) }));
  }

  /** Load the current-state layer and explicit coverage documents for the runtime catalog. */
  async loadCurrentCoverageCatalog(maxDocuments = Number(process.env.ASSETS_WAREHOUSE_COVERAGE_MAX_DOCS ?? "200000")): Promise<WarehouseCoverageCatalogSnapshot | null> {
    if (!this.url) return null;
    if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1) throw new EvidenceStoreError("ASSETS_WAREHOUSE_COVERAGE_MAX_DOCS must be a positive integer", 500);
    const layerResponse = await this.search(this.layerIndex, {
      size: 1000,
      track_total_hits: true,
      query: { bool: { filter: [{ term: { state: "ACTIVE" } }] } },
      sort: [{ layer_id: "asc" }],
    });
    const layers = (layerResponse.hits?.hits ?? []).map((hit) => this.normalizeLayer(hit)).filter((layer): layer is WarehouseLayerSnapshot => Boolean(layer));
    if (!layers.length) return { layers: [], coverages: [], truncated: false };
    const coverages: WarehouseCoverageSnapshot[] = [];
    let truncated = false;
    for (const layer of layers) {
      if (coverages.length >= maxDocuments) { truncated = true; break; }
      const remaining = maxDocuments - coverages.length;
      const response = await this.search(this.coverageIndex, {
        size: Math.min(10_000, remaining + 1),
        track_total_hits: true,
        query: { bool: { filter: [{ term: { layer_id: layer.layerId } }] } },
        sort: [{ healpix_order: "asc" }, { healpix_cell: "asc" }, { source_file_id: "asc" }],
      });
      const hits = response.hits?.hits ?? [];
      const total = typeof response.hits?.total === "number" ? response.hits.total : response.hits?.total?.value ?? hits.length;
      if (total > remaining || hits.length > remaining) truncated = true;
      for (const hit of hits.slice(0, remaining)) {
        const coverage = this.normalizeWarehouseCoverage(hit, layer.layerId);
        if (coverage) coverages.push(coverage);
      }
      if (total > hits.length) truncated = true;
    }
    if (truncated) throw new EvidenceStoreError(`Warehouse coverage catalog exceeds the configured ${maxDocuments} document limit`, 503);
    return { layers, coverages, truncated: false };
  }

  private async requireActiveLayers(layerIds: string[]): Promise<void> {
    if (!layerIds.length) return;
    const response = await this.search(this.layerIndex, {
      size: layerIds.length,
      query: { bool: { filter: [{ terms: { layer_id: layerIds } }] } },
    });
    const states = new Map((response.hits?.hits ?? []).map((hit) => {
      const source = hit._source ?? {};
      return [text(source.layer_id) ?? hit._id ?? "", text(source.state) ?? "UNKNOWN"] as const;
    }));
    const missing = layerIds.filter((layerId) => !states.has(layerId));
    const inactive = layerIds.filter((layerId) => states.get(layerId) !== "ACTIVE");
    if (missing.length || inactive.length) {
      throw new EvidenceStoreError(`Warehouse layer is not ACTIVE: ${[...new Set([...missing, ...inactive])].join(", ")}`, 409);
    }
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
    return await response.json() as SearchResponse;
  }
}
