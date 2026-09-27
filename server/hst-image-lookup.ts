import { createHash } from "node:crypto";
import { Healpix, Pointing, type RangeSet } from "healpixjs";
import { AdminHttpError } from "./admin-error.js";
import type { ArtifactStore } from "./artifact-store.js";

const MAST_URL = "https://mast.stsci.edu/api/v0/invoke";
const MAX_CELLS = 256;
const MAX_OBSERVATIONS = 50;
const MAX_PRODUCTS = 500;
const MAX_POSITION_PAGES = 8;
const MAX_PRODUCT_PAGES = 2;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const INTERSECTION_OVERSAMPLING = 4;
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const cache = new Map<string, { expiresAt: number; result: HstImageLookupResult }>();

type MastRow = Record<string, unknown>;
type MastRegion = { kind: "polygon"; vertices: Pointing[] } | { kind: "circle"; center: Pointing; radius: number };
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
    files: Array<{
      fileName: string;
      dataUri?: string;
      productType?: string;
      productGroup?: string;
      sizeBytes?: number;
      recommendation: "combined-image" | "exposure" | "other";
    }>;
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

async function mast(service: string, params: Record<string, unknown>, page = 1): Promise<{ body: unknown; raw: string }> {
  let response: Response;
  try {
    response = await fetch(MAST_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ request: JSON.stringify({ service, params, format: "json", pagesize: 100, page }) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AdminHttpError(503, "MAST metadata service is temporarily unavailable");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new AdminHttpError(502, "MAST metadata response exceeded its size limit");
  if (!response.ok) throw new AdminHttpError(503, `MAST metadata service returned HTTP ${response.status}`);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new AdminHttpError(502, "MAST returned invalid metadata JSON"); }
  const status = record(body)?.status;
  if (typeof status === "string" && status.toUpperCase() !== "COMPLETE") throw new AdminHttpError(503, "MAST did not complete the metadata query");
  return { body, raw };
}

function normalizedCells(value: unknown): { order: number; cells: number[] } {
  const body = record(value);
  const order = body?.order;
  const cells = body?.cells;
  if (!Number.isSafeInteger(order) || Number(order) < 4 || Number(order) > 12 || !Array.isArray(cells)
    || cells.length < 1 || cells.length > MAX_CELLS) {
    throw new AdminHttpError(400, `order must be 4 through 12 and cells must contain 1 through ${MAX_CELLS} pixels`);
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

function regions(region: unknown): MastRegion[] | undefined {
  if (typeof region !== "string" || region.length > 32_768) return undefined;
  const tokens = region.trim().split(/\s+/);
  const output: MastRegion[] = [];
  for (let index = 0; index < tokens.length;) {
    const kind = tokens[index++]!.toUpperCase();
    if (kind !== "POLYGON" && kind !== "CIRCLE") return undefined;
    if (index < tokens.length && /^[A-Z]+$/.test(tokens[index]!)) {
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
    }
    if (coordinates.length < 6 || coordinates.length % 2) return undefined;
    const vertices: Pointing[] = [];
    for (let i = 0; i < coordinates.length; i += 2) {
      const ra = coordinates[i]!, dec = coordinates[i + 1]!;
      if (Math.abs(ra) > 1_000_000 || dec < -90 || dec > 90) return undefined;
      vertices.push(new Pointing(null, false, (90 - dec) * Math.PI / 180, ((ra % 360 + 360) % 360) * Math.PI / 180));
    }
    if (vertices.length > 3) {
      const first = vertices[0]!;
      const last = vertices.at(-1)!;
      const phiDifference = Math.atan2(Math.sin(first.phi - last.phi), Math.cos(first.phi - last.phi));
      if (Math.abs(first.theta - last.theta) < 1e-12 && Math.abs(phiDifference) < 1e-12) vertices.pop();
    }
    if (vertices.length < 3) return undefined;
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

function productKind(product: MastRow): "combined-image" | "exposure" | "other" {
  const group = String(product.productSubGroupDescription ?? "").toUpperCase();
  const fileName = String(product.productFilename ?? "").toLowerCase();
  if (/\b(DRZ|DRC|DITHERED)\b/.test(group) || /_(drz|drc)\.fits(?:\.gz)?$/.test(fileName)) return "combined-image";
  if (/\b(FLT|FLC|RAW|EXP)\b/.test(group) || /_(flt|flc|raw)\.fits(?:\.gz)?$/.test(fileName)) return "exposure";
  return "other";
}

function portalUrl(obsid: string): string {
  const url = new URL("https://mast.stsci.edu/portal/Mashup/Clients/Mast/Portal.html");
  url.searchParams.set("searchQuery", `obsid:${obsid}`);
  return url.toString();
}

export async function lookupHstImages(input: unknown, store?: ArtifactStore): Promise<HstImageLookupResult> {
  const { order, cells } = normalizedCells(input);
  const cacheKey = `${order}:${cells.join(",")}`;
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
  for (let page = 1; page <= MAX_POSITION_PAGES; page++) {
    const result = await mast("Mast.Caom.Filtered.Position", {
      position: `${cone.ra}, ${cone.dec}, ${cone.radius}`,
      columns: "obsid,obs_collection,dataproduct_type,proposal_id,target_name,instrument_name,filters,t_min,t_max,s_region,dataRights",
      filters: [
        { paramName: "obs_collection", values: ["HST"] },
        { paramName: "dataproduct_type", values: ["image"] },
        { paramName: "dataRights", values: ["PUBLIC"] },
      ],
    }, page);
    rawResponses.push(result.raw);
    const pageRows = rows(result.body);
    for (const observation of pageRows) {
      const obsid = String(observation.obsid ?? "");
      if (!/^\d{1,32}$/.test(obsid) || !Number.isSafeInteger(Number(obsid)) || String(observation.obs_collection ?? "").toUpperCase() !== "HST"
        || String(observation.dataproduct_type ?? "").toLowerCase() !== "image"
        || String(observation.dataRights ?? "").toUpperCase() !== "PUBLIC") continue;
      const shape = regions(observation.s_region);
      if (!shape) { excludedWithoutRegion++; continue; }
      if (intersects(order, cellSet, shape)) matched.set(obsid, observation);
    }
    const pageCount = filteredPageCount(result.body);
    queryExhausted = pageCount !== undefined ? page >= pageCount : pageRows.length < 100;
    if (!queryExhausted && matched.size >= MAX_OBSERVATIONS) {
      truncated = true;
      break;
    }
    if (queryExhausted) break;
    if (page === MAX_POSITION_PAGES) truncated = true;
  }
  if (!queryExhausted) truncated = true;
  if (excludedWithoutRegion > 0) truncated = true;
  const ordered = [...matched.values()].sort((left, right) => Number(left.obsid) - Number(right.obsid));
  if (ordered.length > MAX_OBSERVATIONS) { ordered.length = MAX_OBSERVATIONS; truncated = true; }

  const productsByObservation = new Map<string, MastRow[]>();
  const productResponses: Array<{ obsid: string; page: number; body: unknown }> = [];
  for (let start = 0; start < ordered.length; start += 4) {
    const batch = ordered.slice(start, start + 4);
    const result = await Promise.all(batch.map(async (observation) => {
      const obsid = String(observation.obsid);
      const products: MastRow[] = [];
      const responses: Array<{ obsid: string; page: number; body: unknown }> = [];
      let exhausted = false;
      for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
        const response = await mast("Mast.Caom.Products", { obsid: Number(obsid) }, page);
        responses.push({ obsid, page, body: response.body });
        products.push(...rows(response.body).filter((product) => {
          const filename = product.productFilename;
          const rights = product.dataRights;
          return typeof filename === "string" && filename.length > 0 && filename.length <= 512
            && String(rights ?? "").toUpperCase() === "PUBLIC"
            && (!product.dataproduct_type || String(product.dataproduct_type).toLowerCase() === "image");
        }));
        const pageCount = filteredPageCount(response.body);
        exhausted = pageCount !== undefined ? page >= pageCount : rows(response.body).length < 100;
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
      productUrl: portalUrl(obsid),
      files,
    });
  }

  const generatedAt = new Date().toISOString();
  const evidence = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt, query: { coordinateFrame: "ICRS", ordering: "NESTED", order, cells }, rawResponses, products: productResponses }));
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
    truncated,
    queryExhausted,
    matchedObservationCount: matched.size,
    excludedWithoutRegion,
    generatedAt,
    sourceSnapshotSha256,
  };
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { expiresAt: now + CACHE_MS, result: response });
  return response;
}
