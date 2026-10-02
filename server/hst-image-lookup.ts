import { createHash } from "node:crypto";
import { Healpix, Pointing, type RangeSet } from "healpixjs";
import { AdminHttpError } from "./admin-error.js";
import type { ArtifactStore } from "./artifact-store.js";
import { metadataFetch } from "./metadata-fetch.js";

const MAST_URL = "https://mast.stsci.edu/api/v0/invoke";
const MAX_CELLS = 256;
const MAX_OBSERVATIONS = 50;
const MAX_PRODUCTS = 500;
const MAX_POSITION_PAGES = 8;
const MAX_PRODUCT_PAGES = 2;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAST_REQUEST_TIMEOUT_MS = 60_000;
const METADATA_QUERY_TIMEOUT_MS = 45_000;
const INTERSECTION_OVERSAMPLING = 4;
const COMPLEX_FOOTPRINT_VERTEX_LIMIT = 4;
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const MAX_STCS_REGION_LENGTH = 131_072;
const MAX_STCS_REGION_TOKENS = 131_072;
const MAX_STCS_REGION_PARTS = 512;
const MAX_STCS_POLYGON_VERTICES = 32_768;
const cache = new Map<string, { expiresAt: number; result: HstImageLookupResult }>();

type MastRow = Record<string, unknown>;
type MastRegion = { kind: "polygon"; vertices: Pointing[] } | { kind: "circle"; center: Pointing; radius: number };

function hasComplexPolygon(shapes: readonly MastRegion[]): boolean {
  return shapes.reduce((sum, shape) => sum + (shape.kind === "polygon" ? shape.vertices.length : 0), 0) > COMPLEX_FOOTPRINT_VERTEX_LIMIT;
}
export interface HstImageLookupResult {
  coordinateFrame: "ICRS";
  ordering: "NESTED";
  order: number;
  nside: number;
  cells: number[];
  precision: "estimated" | "truncated";
  spatialPrecision: "estimated";
  observations: Array<{
    obsid: string;
    instrument?: string;
    filters?: string;
    target?: string;
    startTime?: number;
    endTime?: number;
    productUrl: string;
    sRegion: string;
    matchingCells: number[];
    files: Array<{
      fileName: string;
      dataUri?: string;
      productType?: string;
      productGroup?: string;
      sizeBytes?: number;
      recommendation: "combined-image" | "exposure" | "other";
    }>;
  }>;
  errors: Array<{
    stage: "observations" | "products";
    kind: "timeout" | "unavailable" | "upstream";
    page?: number;
    obsid?: string;
    message: string;
  }>;
  truncated: boolean;
  queryExhausted: boolean;
  matchedObservationCount: number;
  excludedWithoutRegion: number;
  generatedAt: string;
  sourceSnapshotSha256: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rows(value: unknown): MastRow[] {
  const root = record(value);
  const table = Array.isArray(root?.Tables) ? record(root.Tables[0]) : undefined;
  if (table && Array.isArray(table.Columns) && Array.isArray(table.Rows)) {
    const columns = table.Columns.map((column) => record(column)?.dataIndex);
    if (columns.some((column) => typeof column !== "string") || columns.length > 256) throw new AdminHttpError(502, "MAST returned invalid table columns");
    return table.Rows.flatMap((row) => Array.isArray(row) && row.length === columns.length
      ? [Object.fromEntries(columns.map((column, index) => [column as string, row[index]]))]
      : []);
  }
  const data = root?.data;
  return Array.isArray(data) ? data.flatMap((item) => record(item) ? [record(item)!] : []) : [];
}

function filteredPageCount(value: unknown): number | undefined {
  const paging = record(record(value)?.paging);
  const pages = finiteNumber(paging?.pagesFiltered);
  return Number.isSafeInteger(pages) && pages! >= 0 ? pages : undefined;
}

async function mast(service: string, params: Record<string, unknown>, page = 1, metadataOnly = false, querySignal?: AbortSignal): Promise<{ body: unknown; raw: string }> {
  let response: Response;
  let raw: string;
  try {
    const encoded = new URLSearchParams({ request: JSON.stringify({ service, params, format: "json", pagesize: 100, page }) });
    response = await metadataFetch(metadataOnly ? `${MAST_URL}?${encoded}` : MAST_URL, {
      method: metadataOnly ? "GET" : "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      ...(metadataOnly ? {} : { body: encoded }),
      signal: querySignal ? AbortSignal.any([querySignal, AbortSignal.timeout(MAST_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(MAST_REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AdminHttpError(504, metadataOnly ? "MAST metadata query exceeded its time limit"
        : `MAST metadata request timed out after ${MAST_REQUEST_TIMEOUT_MS / 1000} seconds`);
    }
    throw new AdminHttpError(503, "MAST metadata service could not be reached");
  }
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new AdminHttpError(502, "MAST metadata response exceeded its size limit");
  if (!response.ok) throw new AdminHttpError(503, `MAST metadata service returned HTTP ${response.status}`);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new AdminHttpError(502, "MAST returned invalid metadata JSON"); }
  const status = record(body)?.status;
  if (typeof status === "string" && status.toUpperCase() !== "COMPLETE") throw new AdminHttpError(503, "MAST did not complete the metadata query");
  return { body, raw };
}

export function normalizedHstLookupCells(value: unknown, maximumCells = MAX_CELLS): { order: number; cells: number[] } {
  const body = record(value);
  const order = body?.order;
  const cells = body?.cells;
  if (!Number.isSafeInteger(order) || Number(order) < 4 || Number(order) > 12 || !Array.isArray(cells)
    || cells.length < 1 || cells.length > maximumCells) {
    throw new AdminHttpError(400, `order must be 4 through 12 and cells must contain 1 through ${maximumCells} pixels`);
  }
  const maximum = 12 * 4 ** Number(order);
  if (cells.some((cell) => !Number.isSafeInteger(cell) || Number(cell) < 0 || Number(cell) >= maximum)) {
    throw new AdminHttpError(400, "cells contains an invalid NESTED HEALPix pixel");
  }
  return { order: Number(order), cells: [...new Set(cells as number[])].sort((a, b) => a - b) };
}

function coneForCells(order: number, cells: number[]): { ra: number; dec: number; radius: number } {
  const healpix = new Healpix(2 ** order);
  const centers = cells.map((pixel) => healpix.pix2vec(pixel));
  const mean = centers.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, z: sum.z + point.z }), { x: 0, y: 0, z: 0 });
  const length = Math.hypot(mean.x, mean.y, mean.z);
  if (!length) throw new AdminHttpError(400, "Selected HEALPix cells do not define a bounded sky region");
  const center = { x: mean.x / length, y: mean.y / length, z: mean.z / length };
  let radius = 0;
  for (const pixel of cells) {
    for (const point of healpix.getBoundaries(pixel)) {
      const dot = Math.max(-1, Math.min(1, center.x * point.x + center.y * point.y + center.z * point.z));
      radius = Math.max(radius, Math.acos(dot));
    }
  }
  radius += 0.1 * Math.PI / 180;
  if (radius > 10 * Math.PI / 180) throw new AdminHttpError(400, "Selected HST lookup region exceeds the 10 degree query limit");
  return {
    ra: (Math.atan2(center.y, center.x) * 180 / Math.PI + 360) % 360,
    dec: Math.asin(center.z) * 180 / Math.PI,
    radius: radius * 180 / Math.PI,
  };
}

function sameVertex(left: Pointing, right: Pointing): boolean {
  const phiDifference = Math.atan2(Math.sin(left.phi - right.phi), Math.cos(left.phi - right.phi));
  return Math.abs(left.theta - right.theta) < 1e-12 && Math.abs(phiDifference) < 1e-12;
}

function polygonHasArea(vertices: readonly Pointing[]): boolean {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const left = vertices[index]!;
    const right = vertices[(index + 1) % vertices.length]!;
    const leftSinTheta = Math.sin(left.theta);
    const rightSinTheta = Math.sin(right.theta);
    const leftX = leftSinTheta * Math.cos(left.phi);
    const leftY = leftSinTheta * Math.sin(left.phi);
    const leftZ = Math.cos(left.theta);
    const rightX = rightSinTheta * Math.cos(right.phi);
    const rightY = rightSinTheta * Math.sin(right.phi);
    const rightZ = Math.cos(right.theta);
    x += leftY * rightZ - leftZ * rightY;
    y += leftZ * rightX - leftX * rightZ;
    z += leftX * rightY - leftY * rightX;
  }
  return Math.hypot(x, y, z) > 1e-14;
}

function regions(region: unknown): MastRegion[] | undefined {
  if (typeof region !== "string" || region.length > MAX_STCS_REGION_LENGTH) return undefined;
  const normalized = region.replace(/([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?=(?:POLYGON|CIRCLE)\b)/gi, "$1 ");
  const tokens = normalized.trim().split(/\s+/);
  if (tokens.length > MAX_STCS_REGION_TOKENS) return undefined;
  const output: MastRegion[] = [];
  let partCount = 0;
  for (let index = 0; index < tokens.length;) {
    const kind = tokens[index++]!.toUpperCase();
    if (kind !== "POLYGON" && kind !== "CIRCLE") return undefined;
    partCount += 1;
    if (partCount > MAX_STCS_REGION_PARTS) return undefined;
    if (index < tokens.length && /^[A-Z][A-Z0-9_-]*$/i.test(tokens[index]!)) {
      if (tokens[index]!.toUpperCase() !== "ICRS") return undefined;
      index++;
    }
    if (kind === "CIRCLE") {
      if (index + 3 > tokens.length) return undefined;
      const ra = Number(tokens[index++]);
      const dec = Number(tokens[index++]);
      const radius = Number(tokens[index++]);
      if (!Number.isFinite(ra) || Math.abs(ra) > 1_000_000 || !Number.isFinite(dec) || dec < -90 || dec > 90
        || !Number.isFinite(radius) || radius < 0 || radius > 180) return undefined;
      output.push({
        kind: "circle",
        center: new Pointing(null, false, (90 - dec) * Math.PI / 180, ((ra % 360 + 360) % 360) * Math.PI / 180),
        radius: radius * Math.PI / 180,
      });
      continue;
    }
    const coordinates: number[] = [];
    while (index < tokens.length && !["POLYGON", "CIRCLE"].includes(tokens[index]!.toUpperCase())) {
      const coordinate = Number(tokens[index++]);
      if (!Number.isFinite(coordinate)) return undefined;
      coordinates.push(coordinate);
      if (coordinates.length > MAX_STCS_POLYGON_VERTICES * 2) return undefined;
    }
    if (coordinates.length % 2) return undefined;
    if (coordinates.length < 6) continue;
    const vertices: Pointing[] = [];
    for (let i = 0; i < coordinates.length; i += 2) {
      const ra = coordinates[i]!, dec = coordinates[i + 1]!;
      if (Math.abs(ra) > 1_000_000 || dec < -90 || dec > 90) return undefined;
      vertices.push(new Pointing(null, false, (90 - dec) * Math.PI / 180, ((ra % 360 + 360) % 360) * Math.PI / 180));
    }
    if (vertices.length > 1 && sameVertex(vertices[0]!, vertices.at(-1)!)) vertices.pop();
    if (vertices.length < 3) continue;
    const uniqueVertices = new Set(vertices.map((vertex) => `${Math.round(vertex.theta * 1e12)}:${Math.round(vertex.phi * 1e12)}`));
    if (uniqueVertices.size < 3 || !polygonHasArea(vertices)) continue;
    output.push({ kind: "polygon", vertices });
  }
  return output.length ? output : undefined;
}

function contains(ranges: RangeSet, pixel: number): boolean {
  let low = 0;
  let high = ranges.sz / 2;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges.r[middle * 2 + 1]! <= pixel) low = middle + 1;
    else high = middle;
  }
  return low < ranges.sz / 2 && ranges.r[low * 2]! <= pixel && pixel < ranges.r[low * 2 + 1]!;
}

function intersects(order: number, cells: Set<number>, shapes: MastRegion[]): boolean {
  const healpix = new Healpix(2 ** order);
  // The instance sets the requested order; fact only oversamples boundary checks.
  return shapes.some((shape) => {
    const covered = shape.kind === "circle"
      ? healpix.queryDiscInclusive(shape.center, shape.radius, INTERSECTION_OVERSAMPLING)
      : healpix.queryPolygonInclusive(shape.vertices, INTERSECTION_OVERSAMPLING);
    for (const pixel of cells) if (contains(covered, pixel)) return true;
    return false;
  });
}

export function cellsForStcs(order: number, cells: readonly number[], stcs: unknown): number[] {
  const shapes = regions(stcs);
  if (!shapes) return [];
  const healpix = new Healpix(2 ** order);
  const simplifyPolygons = hasComplexPolygon(shapes);
  const covered = shapes.map((shape) => {
    if (shape.kind === "polygon" && simplifyPolygons) {
      const cap = circumscribedCap(shape.vertices);
      if (!cap || cap.radius >= Math.PI / 2) return undefined;
      return healpix.queryDiscInclusive(cap.center, cap.radius, INTERSECTION_OVERSAMPLING);
    }
    return shape.kind === "circle"
      ? healpix.queryDiscInclusive(shape.center, shape.radius, INTERSECTION_OVERSAMPLING)
      : healpix.queryPolygonInclusive(shape.vertices, INTERSECTION_OVERSAMPLING);
  });
  if (covered.some((range) => range === undefined)) return [...cells];
  return cells.filter((pixel) => covered.some((range) => contains(range!, pixel)));
}

function circumscribedCap(vertices: readonly Pointing[]): { center: Pointing; radius: number } | undefined {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const vertex of vertices) {
    const sinTheta = Math.sin(vertex.theta);
    x += sinTheta * Math.cos(vertex.phi);
    y += sinTheta * Math.sin(vertex.phi);
    z += Math.cos(vertex.theta);
  }
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) return undefined;
  x /= length;
  y /= length;
  z /= length;
  const center = new Pointing(null, false, Math.acos(Math.max(-1, Math.min(1, z))), (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI));
  let radius = 0;
  for (const vertex of vertices) {
    const sinTheta = Math.sin(vertex.theta);
    const dot = x * sinTheta * Math.cos(vertex.phi) + y * sinTheta * Math.sin(vertex.phi) + z * Math.cos(vertex.theta);
    radius = Math.max(radius, Math.acos(Math.max(-1, Math.min(1, dot))));
  }
  return { center, radius: Math.min(Math.PI, radius + 1e-12) };
}

export function candidateCellsForStcs(order: number, stcs: unknown, healpix = new Healpix(2 ** order)): number[] {
  const shapes = regions(stcs);
  if (!shapes) return [];
  const candidates = new Set<number>();
  const simplifyPolygons = hasComplexPolygon(shapes);
  for (const shape of shapes) {
    let covered;
    if (shape.kind === "polygon" && simplifyPolygons) {
      const cap = circumscribedCap(shape.vertices);
      if (!cap || cap.radius >= Math.PI / 2) {
        const allSkyCells = 12 * 4 ** order;
        for (let cell = 0; cell < allSkyCells; cell += 1) candidates.add(cell);
        continue;
      }
      covered = healpix.queryDiscInclusive(cap.center, Math.min(Math.PI, cap.radius + healpix.maxPixrad()), INTERSECTION_OVERSAMPLING);
    } else {
      covered = shape.kind === "circle"
        ? healpix.queryDiscInclusive(shape.center, Math.min(Math.PI, shape.radius + healpix.maxPixrad()), INTERSECTION_OVERSAMPLING)
        : healpix.queryPolygonInclusive(shape.vertices, INTERSECTION_OVERSAMPLING);
    }
    for (let range = 0; range < covered.sz; range += 2) {
      for (let pixel = covered.r[range]!; pixel < covered.r[range + 1]!; pixel += 1) candidates.add(pixel);
    }
  }
  return [...candidates].sort((left, right) => left - right);
}

function productKind(product: MastRow): "combined-image" | "exposure" | "other" {
  const group = String(product.productSubGroupDescription ?? "").toUpperCase();
  const fileName = String(product.productFilename ?? "").toLowerCase();
  if (/\b(DRZ|DRC|DITHERED)\b/.test(group) || /_(drz|drc)\.fits(?:\.gz)?$/.test(fileName)) return "combined-image";
  if (/\b(FLT|FLC|RAW|EXP)\b/.test(group) || /_(flt|flc|raw)\.fits(?:\.gz)?$/.test(fileName)) return "exposure";
  return "other";
}

function publicScienceFitsProduct(product: MastRow, obsid: string): boolean {
  const fileName = product.productFilename;
  if (typeof fileName !== "string" || !/\.fits(?:\.gz)?$/i.test(fileName)
    || String(product.dataRights ?? "").toUpperCase() !== "PUBLIC"
    || (product.dataproduct_type && String(product.dataproduct_type).toLowerCase() !== "image")) return false;
  const parentObsid = product.parent_obsid ?? product.parentObsid;
  if (parentObsid !== undefined && String(parentObsid) !== obsid) return false;
  const subgroup = String(product.productSubGroupDescription ?? "").trim().toUpperCase();
  const productType = String(product.productType ?? "").trim().toUpperCase();
  if (productType) return productType === "SCIENCE";
  return ["SCIENCE", "DRZ", "DRC", "FLT", "FLC", "RAW", "EXP"].includes(subgroup);
}

function failureDetails(error: unknown): { kind: "timeout" | "unavailable" | "upstream"; message: string } {
  const message = error instanceof Error ? error.message : "MAST metadata request failed";
  const statusCode = error && typeof error === "object" && "statusCode" in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  if (statusCode === 504) return { kind: "timeout", message };
  if (statusCode === 503 && /could not be reached|temporarily unavailable/i.test(message)) return { kind: "unavailable", message };
  return { kind: "upstream", message };
}

function mastProductsUrl(obsid: string): string {
  const url = new URL("https://mast.stsci.edu/api/v0/invoke");
  url.searchParams.set("request", JSON.stringify({
    service: "Mast.Caom.Products",
    params: {
      obsid,
      columns: "obsID,obs_collection,dataproduct_type,obs_id,description,type,dataURI,productType,productGroupDescription,productSubGroupDescription,project,proposal_id,productFilename,size,parent_obsid,dataRights,calib_level,filters",
    },
    format: "json",
    pagesize: 5000,
    page: 1,
  }));
  return url.toString();
}

export async function lookupHstImages(input: unknown, store?: ArtifactStore, options: { metadataOnly?: boolean; signal?: AbortSignal } = {}): Promise<HstImageLookupResult> {
  const metadataOnly = options.metadataOnly === true;
  const { order, cells } = normalizedHstLookupCells(input, metadataOnly ? 4096 : MAX_CELLS);
  const cacheKey = `${metadataOnly}:${order}:${cells.join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cached) cache.delete(cacheKey);

  const cone = coneForCells(order, cells);
  const cellSet = new Set(cells);
  const matched = new Map<string, MastRow>();
  const rawResponses: string[] = [];
  let queryExhausted = false;
  let truncated = false;
  let excludedWithoutRegion = 0;
  const errors: HstImageLookupResult["errors"] = [];
  const maximumPages = metadataOnly ? 64 : MAX_POSITION_PAGES;
  const maximumObservations = metadataOnly ? 6400 : MAX_OBSERVATIONS;
  const querySignal = metadataOnly ? options.signal ?? AbortSignal.timeout(METADATA_QUERY_TIMEOUT_MS) : undefined;
  for (let page = 1; page <= maximumPages; page++) {
    let body: unknown;
    let pageRows: MastRow[];
    try {
      if (querySignal?.aborted) throw new AdminHttpError(504, "MAST metadata query exceeded its time limit");
      const result = await mast("Mast.Caom.Filtered.Position", {
        position: `${cone.ra}, ${cone.dec}, ${cone.radius}`,
        columns: "obsid,obs_collection,dataproduct_type,proposal_id,target_name,instrument_name,filters,t_min,t_max,s_region,dataRights",
        filters: [
          { paramName: "obs_collection", values: ["HST"] },
          { paramName: "dataproduct_type", values: ["image"] },
          { paramName: "dataRights", values: ["PUBLIC"] },
        ],
      }, page, metadataOnly, querySignal);
      rawResponses.push(result.raw);
      body = result.body;
      pageRows = rows(body);
    } catch (error) {
      errors.push({ stage: "observations", page, ...failureDetails(error) });
      truncated = true;
      break;
    }
    for (const observation of pageRows) {
      const obsid = String(observation.obsid ?? "");
      if (!/^\d{1,32}$/.test(obsid) || !Number.isSafeInteger(Number(obsid)) || String(observation.obs_collection ?? "").toUpperCase() !== "HST"
        || String(observation.dataproduct_type ?? "").toLowerCase() !== "image"
        || String(observation.dataRights ?? "").toUpperCase() !== "PUBLIC") continue;
      const shape = regions(observation.s_region);
      if (!shape) { excludedWithoutRegion++; continue; }
      try {
        if (intersects(order, cellSet, shape)) matched.set(obsid, observation);
      } catch { excludedWithoutRegion++; }
    }
    const pageCount = filteredPageCount(body);
    queryExhausted = pageCount !== undefined ? page >= pageCount : pageRows.length < 100;
    if (!queryExhausted && matched.size >= maximumObservations) {
      truncated = true;
      break;
    }
    if (queryExhausted) break;
    if (page === maximumPages) truncated = true;
  }
  if (!queryExhausted) truncated = true;
  if (excludedWithoutRegion > 0) truncated = true;
  const ordered = [...matched.values()].sort((left, right) => Number(left.obsid) - Number(right.obsid));
  if (ordered.length > maximumObservations) { ordered.length = maximumObservations; truncated = true; }

  const productsByObservation = new Map<string, MastRow[]>();
  const productResponses: Array<{ obsid: string; page: number; body: unknown }> = [];
  for (let start = 0; !metadataOnly && start < ordered.length; start += 4) {
    const batch = ordered.slice(start, start + 4);
    const result = await Promise.all(batch.map(async (observation) => {
      const obsid = String(observation.obsid);
      const products: MastRow[] = [];
      const responses: Array<{ obsid: string; page: number; body: unknown }> = [];
      let exhausted = false;
      for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
        try {
          const response = await mast("Mast.Caom.Products", { obsid: Number(obsid) }, page);
          responses.push({ obsid, page, body: response.body });
          products.push(...rows(response.body).filter((product) => {
            const fileName = product.productFilename;
            return typeof fileName === "string" && fileName.length <= 512 && publicScienceFitsProduct(product, obsid);
          }));
          const pageCount = filteredPageCount(response.body);
          exhausted = pageCount !== undefined ? page >= pageCount : rows(response.body).length < 100;
        } catch (error) {
          errors.push({ stage: "products", obsid, page, ...failureDetails(error) });
          break;
        }
        if (exhausted) break;
      }
      return { obsid, products, responses, exhausted };
    }));
    for (const item of result) {
      productsByObservation.set(item.obsid, item.products);
      productResponses.push(...item.responses);
      if (!item.exhausted) truncated = true;
    }
  }

  const observations: HstImageLookupResult["observations"] = [];
  let productCount = 0;
  for (const observation of ordered) {
    const obsid = String(observation.obsid);
    const files = (productsByObservation.get(obsid) ?? []).flatMap((product) => {
      if (productCount >= MAX_PRODUCTS) { truncated = true; return []; }
      const fileName = String(product.productFilename);
      const group = typeof product.productSubGroupDescription === "string" ? product.productSubGroupDescription : undefined;
      const productType = typeof product.productType === "string" ? product.productType : undefined;
      const recommendation = productKind(product);
      productCount++;
      return [{
        fileName,
        ...(typeof product.dataURI === "string" && product.dataURI.length <= 2048 ? { dataUri: product.dataURI } : {}),
        ...(productType ? { productType } : {}),
        ...(group ? { productGroup: group } : {}),
        ...(finiteNumber(product.dataSize ?? product.sizeBytes ?? product.size) !== undefined ? { sizeBytes: finiteNumber(product.dataSize ?? product.sizeBytes ?? product.size)! } : {}),
        recommendation,
      }];
    });
    observations.push({
      obsid,
      ...(typeof observation.instrument_name === "string" ? { instrument: observation.instrument_name.slice(0, 128) } : {}),
      ...(typeof observation.filters === "string" ? { filters: observation.filters.slice(0, 512) } : {}),
      ...(typeof observation.target_name === "string" ? { target: observation.target_name.slice(0, 256) } : {}),
      ...(finiteNumber(observation.t_min) !== undefined ? { startTime: finiteNumber(observation.t_min)! } : {}),
      ...(finiteNumber(observation.t_max) !== undefined ? { endTime: finiteNumber(observation.t_max)! } : {}),
      productUrl: mastProductsUrl(obsid),
      sRegion: String(observation.s_region),
      matchingCells: cellsForStcs(order, cells, observation.s_region),
      files,
    });
  }

  const generatedAt = new Date().toISOString();
  const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt, query: { coordinateFrame: "ICRS", ordering: "NESTED", order, cells }, rawResponses, products: productResponses, errors }));
  if (evidence.length > MAX_RESPONSE_BYTES) throw new AdminHttpError(502, "MAST evidence snapshot exceeded its size limit");
  const sourceSnapshotSha256 = createHash("sha256").update(evidence).digest("hex");
  if (store) {
    await store.putImmutable(`hst-image-lookups/${generatedAt.slice(0, 10)}/${sourceSnapshotSha256}.json`, evidence, {
      contentType: "application/json",
      metadata: { deliveryClass: "evidence", surveyId: "hst", source: "mast" },
    });
  }
  const response: HstImageLookupResult = {
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    order,
    nside: 2 ** order,
    cells,
    precision: truncated ? "truncated" : "estimated",
    spatialPrecision: "estimated",
    observations,
    errors: [...errors].sort((left, right) => left.stage.localeCompare(right.stage)
      || (left.obsid ?? "").localeCompare(right.obsid ?? "")
      || (left.page ?? 0) - (right.page ?? 0)),
    truncated,
    queryExhausted,
    matchedObservationCount: matched.size,
    excludedWithoutRegion,
    generatedAt,
    sourceSnapshotSha256,
  };
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  if (!errors.length) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { expiresAt: now + CACHE_MS, result: response });
  }
  return response;
}
