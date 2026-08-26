import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { AdminHttpError, AssetsAdmin, KubernetesApiError, adminFromRequest, businessModalityProfile, type ConnectorInput, type CoverageTaskInput } from "./admin.js";
import { assetPreviewMode, loadCatalog, publicManifest, type LoadedCatalog } from "./catalog.js";
import { projectRoot } from "./paths.js";
import { loadSurveyIndex } from "./surveys.js";
import { coverageBlock, coverageCatalogFromWarehouse, loadCoverageCatalog } from "./coverage.js";
import { overlapForLayers } from "./overlap.js";
import { ProductStore, type ProductRecord } from "./products.js";
import { SourceUnitStore, SourceUnitWorkerStore } from "./source-units.js";
import { CoverageEvidenceStore, EvidenceStoreError } from "./evidence-store.js";

const port = Number(process.env.PORT ?? "4180");
const host = process.env.HOST ?? "0.0.0.0";
const releaseRoot = path.resolve(process.env.ASSET_RELEASE_ROOT ?? projectRoot);
const siteRoot = path.resolve(process.env.PUBLIC_SITE_ROOT ?? path.join(projectRoot, "dist", "site"));
const catalog = await loadCatalog(releaseRoot);
let coverageManifest = JSON.parse(await readFile(path.join(releaseRoot, "src", "footprints", "survey-footprints.json"), "utf8")) as {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: string;
  nside: number;
  footprints: Array<Record<string, unknown> & { surveyId: string; releaseId: string; product: string; nside: number; pixels: number[] }>;
};
const evidenceStore = new CoverageEvidenceStore({
  url: process.env.ASSETS_WAREHOUSE_ES_URL,
  layerIndex: process.env.ASSETS_WAREHOUSE_LAYER_INDEX,
  coverageIndex: process.env.ASSETS_WAREHOUSE_COVERAGE_INDEX,
  fileIndex: process.env.ASSETS_WAREHOUSE_FILE_INDEX,
});
let staticCoverageCatalog = await loadCoverageCatalog(releaseRoot, coverageManifest);
let coverageCatalog = staticCoverageCatalog;
let runtimeCoverageManifest = coverageManifest;
let coverageLoadMode: "warehouse" | "static" | "degraded" = "static";
let coverageLoadedAt = new Date().toISOString();
let surveyIndex: Awaited<ReturnType<typeof loadSurveyIndex>>;

async function reloadRuntimeCoverage(): Promise<{ mode: string; loadedAt: string; layers: number; footprints: number }> {
  coverageManifest = JSON.parse(await readFile(path.join(releaseRoot, "src", "footprints", "survey-footprints.json"), "utf8")) as typeof coverageManifest;
  staticCoverageCatalog = await loadCoverageCatalog(releaseRoot, coverageManifest);
  coverageCatalog = staticCoverageCatalog;
  runtimeCoverageManifest = coverageManifest;
  coverageLoadMode = "static";
  if (evidenceStore.configured) {
    try {
      const warehouseSnapshot = await evidenceStore.loadCurrentCoverageCatalog();
      if (warehouseSnapshot?.layers.length) {
        coverageCatalog = coverageCatalogFromWarehouse(staticCoverageCatalog, warehouseSnapshot);
        runtimeCoverageManifest = {
          ...coverageManifest,
          generatedAt: new Date().toISOString(),
          nside: coverageCatalog.layers.length ? 2 ** Math.min(...coverageCatalog.layers.map((layer) => layer.overviewOrder)) : coverageManifest.nside,
          footprints: [...coverageCatalog.records.values()].map((layer) => ({
            surveyId: layer.surveyId,
            releaseId: layer.releaseId,
            product: layer.product,
            nside: 2 ** layer.overviewOrder,
            pixels: layer.cells.get(layer.overviewOrder) ?? [],
            sourceUrl: layer.recipe?.sourceUrl,
          })),
        };
        coverageLoadMode = "warehouse";
        console.info(`Loaded ${coverageCatalog.layers.length} ACTIVE Warehouse coverage layers from ${evidenceStore.layerIndex}/${evidenceStore.coverageIndex}`);
      } else {
        console.warn("Warehouse ES is configured but has no ACTIVE layers; using the checked-in public geometry until a scan completes.");
      }
    } catch (error) {
      coverageLoadMode = "degraded";
      console.warn(`Warehouse coverage catalog unavailable; using checked-in geometry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  coverageLoadedAt = new Date().toISOString();
  surveyIndex = await loadSurveyIndex(releaseRoot, catalog, runtimeCoverageManifest, coverageCatalog.layers);
  return { mode: coverageLoadMode, loadedAt: coverageLoadedAt, layers: coverageCatalog.layers.length, footprints: coverageCatalog.records.size };
}

await reloadRuntimeCoverage();
const admin = new AssetsAdmin();
const products = new ProductStore();
await products.initialize(releaseRoot, coverageCatalog.layers);
let sourceUnitsPromise: Promise<SourceUnitWorkerStore> | null = null;
let sourceUnitsFallbackPromise: Promise<SourceUnitStore> | null = null;
function sourceUnitsStore(): Promise<SourceUnitWorkerStore> {
  if (!sourceUnitsPromise) {
    sourceUnitsPromise = SourceUnitWorkerStore.load(releaseRoot).catch((error) => {
      sourceUnitsPromise = null;
      throw error;
    });
  }
  return sourceUnitsPromise;
}

function sourceUnitsFallbackStore(): Promise<SourceUnitStore> {
  if (!sourceUnitsFallbackPromise) {
    sourceUnitsFallbackPromise = SourceUnitStore.load(releaseRoot).catch((error) => {
      sourceUnitsFallbackPromise = null;
      throw error;
    });
  }
  return sourceUnitsFallbackPromise;
}

async function sourceUnitsReadyWithin(timeoutMs: number): Promise<SourceUnitWorkerStore | SourceUnitStore | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  try {
    try {
      const worker = await Promise.race([sourceUnitsStore(), timeout]);
      if (worker) return worker;
    } catch { /* fall through to the bounded main-thread index */ }
    return await sourceUnitsFallbackStore();
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

function productCoverage(record: ProductRecord): Record<string, unknown> | undefined {
  const layer = coverageCatalog.layers.find((candidate) => candidate.surveyId === record.draft.surveyId
    && candidate.releaseId === record.draft.releaseId
    && candidate.product === record.draft.name);
  if (!layer) return undefined;
  return { layerId: layer.layerId, availableOrders: layer.availableOrders, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder };
}

function adminProductView(record: ProductRecord): Record<string, unknown> {
  return { ...record, ...(productCoverage(record) ? { coverage: productCoverage(record) } : {}) };
}

function adminProductSummaries(records: ProductRecord[]): Array<Record<string, unknown>> {
  const grouped = new Map<string, { surveyId: string; productCount: number; publishedCount: number; releases: Set<string>; availableOrders: Set<number>; maxOrder: number | null }>();
  for (const record of records) {
    const surveyId = record.draft.surveyId;
    const summary = grouped.get(surveyId) ?? { surveyId, productCount: 0, publishedCount: 0, releases: new Set<string>(), availableOrders: new Set<number>(), maxOrder: null };
    summary.productCount += 1;
    if (record.published) summary.publishedCount += 1;
    summary.releases.add(record.draft.releaseId);
    const coverage = productCoverage(record);
    if (coverage && Array.isArray(coverage.availableOrders)) coverage.availableOrders.forEach((order) => summary.availableOrders.add(order as number));
    if (coverage && typeof coverage.maxOrder === "number") summary.maxOrder = Math.max(summary.maxOrder ?? 0, coverage.maxOrder);
    grouped.set(surveyId, summary);
  }
  return [...grouped.values()].sort((a, b) => a.surveyId.localeCompare(b.surveyId)).map((summary) => ({
    surveyId: summary.surveyId,
    productCount: summary.productCount,
    publishedCount: summary.publishedCount,
    releaseCount: summary.releases.size,
    availableOrders: [...summary.availableOrders].sort((a, b) => a - b),
    maxOrder: summary.maxOrder,
  }));
}
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_FITS_HEADER_BYTES = 256 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;

const staticTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function securityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(encoded.length),
    "Cache-Control": "no-cache",
  });
  response.end(encoded);
}

function compressedJson(request: IncomingMessage, response: ServerResponse, status: number, body: unknown, cacheControl = "no-cache", etag?: string): void {
  const raw = Buffer.from(`${JSON.stringify(body)}\n`);
  const accept = String(request.headers["accept-encoding"] ?? "");
  const encoded = /\bbr\b/i.test(accept) ? brotliCompressSync(raw) : /\bgzip\b/i.test(accept) ? gzipSync(raw) : raw;
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(encoded.length), "Cache-Control": cacheControl, Vary: "Accept-Encoding" };
  if (encoded !== raw) headers["Content-Encoding"] = /\bbr\b/i.test(accept) ? "br" : "gzip";
  if (etag) headers.ETag = etag;
  response.writeHead(status, headers);
  if (request.method === "HEAD") response.end(); else response.end(encoded);
}

async function resourcePackageCatalog(catalog: LoadedCatalog): Promise<Record<string, unknown>> {
  const catalogFile = [...catalog.files.values()].find(({ record }) => record.path.endsWith("/packages/catalog.json"));
  if (!catalogFile) throw new Error("Resource package catalog is not present in the Assets release");
  const document = JSON.parse(await readFile(catalogFile.absolutePath, "utf8")) as Record<string, unknown>;
  if (document.schemaVersion !== 3 || document.version !== "3.0.0" || !Array.isArray(document.packages)) {
    throw new Error("Resource package catalog is not v3");
  }
  const packageAssets = [...catalog.files.values()]
    .map(({ record }) => record)
    .filter((record) => record.kind === "package");
  const packages = document.packages.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resource package catalog contains an invalid entry");
    const entry = value as Record<string, unknown>;
    const surveyId = typeof entry.surveyId === "string" ? entry.surveyId : undefined;
    const version = typeof entry.version === "string" ? entry.version : undefined;
    const releases = Array.isArray(entry.releases) ? entry.releases.filter((release): release is string => typeof release === "string") : [];
    const asset = packageAssets.find((candidate) => candidate.surveyId === surveyId
      && candidate.version === version
      && (!candidate.releaseId || releases.includes(candidate.releaseId)));
    return {
      ...entry,
      ...(asset ? { archiveUrl: `/api/v1/assets/${encodeURIComponent(asset.id)}/download` } : {}),
    };
  });
  return { ...document, packages };
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function requestQuery(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://localhost").searchParams;
}

function rangeFrom(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new RangeError("Unsupported Range header");
  let start = match[1] ? Number(match[1]) : Number.NaN;
  let end = match[2] ? Number(match[2]) : Number.NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) throw new RangeError("Empty Range header");
  if (Number.isNaN(start)) {
    const suffix = end;
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("Invalid suffix range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    end = Number.isNaN(end) ? size - 1 : end;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new RangeError("Range is outside the file");
  return { start, end: Math.min(end, size - 1) };
}

function fitsInteger(cards: string[], keyword: string, fallback = 0): number {
  const card = cards.find((entry) => entry.slice(0, 8).trim() === keyword);
  if (!card || card[8] !== "=") return fallback;
  const value = Number.parseInt(card.slice(10).split("/", 1)[0]!.trim(), 10);
  return Number.isSafeInteger(value) ? value : fallback;
}

async function fitsHeaderPreview(filePath: string, size: number): Promise<string> {
  const length = Math.min(size, MAX_FITS_HEADER_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, "r");
  try { await handle.read(buffer, 0, length, 0); }
  finally { await handle.close(); }

  const output: string[] = [];
  let offset = 0;
  for (let hdu = 0; hdu < 16 && offset + 80 <= buffer.length; hdu += 1) {
    const cards: string[] = [];
    let endOffset = -1;
    for (let cursor = offset; cursor + 80 <= buffer.length; cursor += 80) {
      const card = buffer.toString("ascii", cursor, cursor + 80);
      cards.push(card);
      if (card.slice(0, 8).trim() === "END") { endOffset = cursor + 80; break; }
    }
    if (endOffset < 0) break;
    const extension = cards.find((entry) => entry.slice(0, 8).trim() === "XTENSION");
    const hduType = extension ? extension.slice(10, 30).replaceAll("'", "").trim() : "PRIMARY";
    output.push(`${output.length ? "\n" : ""}[HDU ${hdu}: ${hduType}]`, ...cards.map((card) => card.trimEnd()));

    const headerBytes = Math.ceil((endOffset - offset) / 2880) * 2880;
    const naxis = fitsInteger(cards, "NAXIS");
    const bitpix = Math.abs(fitsInteger(cards, "BITPIX"));
    let elements = naxis > 0 ? 1 : 0;
    for (let axis = 1; axis <= naxis; axis += 1) elements *= Math.max(0, fitsInteger(cards, `NAXIS${axis}`));
    const pcount = Math.max(0, fitsInteger(cards, "PCOUNT"));
    const gcount = Math.max(1, fitsInteger(cards, "GCOUNT", 1));
    const dataBytes = extension?.includes("BINTABLE") || extension?.includes("TABLE")
      ? (Math.max(0, fitsInteger(cards, "NAXIS1")) * Math.max(0, fitsInteger(cards, "NAXIS2")) + pcount) * gcount
      : Math.ceil(bitpix * elements / 8) * gcount + pcount;
    offset += headerBytes + Math.ceil(dataBytes / 2880) * 2880;
  }
  if (!output.length) throw new Error("FITS header does not contain an END card within the preview limit");
  return `${output.join("\n")}\n`;
}

async function textPreview(filePath: string, size: number, type: string): Promise<string> {
  if (type === "application/fits") return fitsHeaderPreview(filePath, size);
  if (type === "application/zip") return zipDirectoryPreview(filePath, size);
  if (size > MAX_TEXT_PREVIEW_BYTES) {
    const handle = await open(filePath, "r");
    const buffer = Buffer.alloc(MAX_TEXT_PREVIEW_BYTES);
    try { await handle.read(buffer, 0, buffer.length, 0); }
    finally { await handle.close(); }
    return `${buffer.toString("utf8")}\n\n[Preview truncated at ${MAX_TEXT_PREVIEW_BYTES} bytes; download the asset for the complete file.]\n`;
  }
  let content = await readFile(filePath, "utf8");
  if (type === "application/json") {
    try { content = `${JSON.stringify(JSON.parse(content), null, 2)}\n`; }
    catch { throw new Error("JSON asset cannot be formatted for preview"); }
  }
  return content;
}

function zipMethodName(method: number): string {
  switch (method) {
    case 0: return "stored";
    case 8: return "deflate";
    case 12: return "bzip2";
    case 14: return "lzma";
    case 93: return "zstd";
    default: return `method-${method}`;
  }
}

async function zipDirectoryPreview(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    // EOCD is at most 65,557 bytes from the end of a classic ZIP archive.
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocdOffset = tail.lastIndexOf(eocd);
    if (eocdOffset < 0 || eocdOffset + 22 > tail.length) throw new Error("ZIP end-of-central-directory record is missing");
    const entries = tail.readUInt16LE(eocdOffset + 10);
    const directorySize = tail.readUInt32LE(eocdOffset + 12);
    const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported by the online preview");
    }
    if (directoryOffset + directorySize > size) throw new Error("ZIP central directory is outside the asset");
    const bytesToRead = Math.min(directorySize, MAX_ZIP_DIRECTORY_BYTES);
    const directory = Buffer.alloc(bytesToRead);
    await handle.read(directory, 0, bytesToRead, directoryOffset);
    const lines = [
      "ZIP archive preview",
      `entries: ${entries}`,
      `central directory: ${directorySize} bytes`,
      "",
      "path\tcompressed\tuncompressed\tmethod",
    ];
    let offset = 0;
    let parsed = 0;
    const signature = 0x02014b50;
    while (offset + 46 <= directory.length && parsed < entries) {
      if (directory.readUInt32LE(offset) !== signature) break;
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (offset + recordLength > directory.length) break;
      const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\t", " ");
      const compressed = directory.readUInt32LE(offset + 20);
      const uncompressed = directory.readUInt32LE(offset + 24);
      const method = directory.readUInt16LE(offset + 10);
      lines.push(`${name}\t${compressed}\t${uncompressed}\t${zipMethodName(method)}`);
      offset += recordLength;
      parsed += 1;
    }
    if (parsed < entries || directorySize > MAX_ZIP_DIRECTORY_BYTES) {
      lines.push("", `[Preview truncated after ${parsed} of ${entries} entries; download the ZIP for the complete archive.]`);
    }
    return `${lines.join("\n")}\n`;
  } finally {
    await handle.close();
  }
}

async function sendDownload(request: IncomingMessage, response: ServerResponse, loaded: LoadedCatalog, id: string): Promise<void> {
  const entry = loaded.files.get(id);
  if (!entry) return json(response, 404, { error: "Public asset not found" });
  let range: { start: number; end: number } | undefined;
  try {
    range = rangeFrom(request.headers.range, entry.record.sizeBytes);
  } catch {
    response.writeHead(416, { "Content-Range": `bytes */${entry.record.sizeBytes}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? entry.record.sizeBytes - 1;
  const length = end - start + 1;
  const headers: Record<string, string> = {
    "Content-Type": entry.record.mediaType,
    "Content-Length": String(length),
    "Content-Disposition": `attachment; filename="${entry.record.downloadName.replaceAll('"', "")}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"sha256-${entry.record.sha256}"`,
    "X-Content-SHA256": entry.record.sha256,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${entry.record.sizeBytes}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(entry.absolutePath, { start, end }).pipe(response);
}

async function sendPreview(request: IncomingMessage, response: ServerResponse, loaded: LoadedCatalog, id: string): Promise<void> {
  const entry = loaded.files.get(id);
  if (!entry) return json(response, 404, { error: "Public asset not found" });
  const mode = assetPreviewMode(entry.record.mediaType);
  if (!mode) return json(response, 415, { error: "This asset type does not support online preview" });
  const type = entry.record.mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (mode === "text") {
    const details = await stat(entry.absolutePath);
    let content: string;
    try { content = await textPreview(entry.absolutePath, details.size, type); }
    catch { return json(response, 422, { error: "Asset cannot be formatted for preview" }); }
    const body = Buffer.from(content, "utf8");
    let range: { start: number; end: number } | undefined;
    try { range = rangeFrom(request.headers.range, body.length); }
    catch {
      response.writeHead(416, { "Content-Range": `bytes */${body.length}` });
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? body.length - 1;
    const headers: Record<string, string> = {
      "Content-Type": `${type === "application/fits" || type === "application/zip" ? "text/plain" : entry.record.mediaType.split(";", 1)[0]}; charset=utf-8`,
      "Content-Length": String(end - start + 1),
      "Content-Disposition": "inline",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"sha256-${entry.record.sha256}"`,
      "X-Content-SHA256": entry.record.sha256,
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD") { response.end(); return; }
    response.end(body.subarray(start, end + 1));
    return;
  }
  let range: { start: number; end: number } | undefined;
  try { range = rangeFrom(request.headers.range, entry.record.sizeBytes); }
  catch {
    response.writeHead(416, { "Content-Range": `bytes */${entry.record.sizeBytes}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? entry.record.sizeBytes - 1;
  const headers: Record<string, string> = {
    "Content-Type": entry.record.mediaType,
    "Content-Length": String(end - start + 1),
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"sha256-${entry.record.sha256}"`,
    "X-Content-SHA256": entry.record.sha256,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${entry.record.sizeBytes}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") { response.end(); return; }
  createReadStream(entry.absolutePath, { start, end }).pipe(response);
}

async function sendStatic(response: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(siteRoot, requested.endsWith("/") ? path.join(requested, "index.html") : requested);
  const relative = path.relative(siteRoot, resolved);
  const candidate = relative.startsWith("..") || path.isAbsolute(relative) ? path.join(siteRoot, "index.html") : resolved;
  let filePath = candidate;
  try {
    if (!(await stat(filePath)).isFile()) filePath = path.join(siteRoot, "index.html");
  } catch {
    filePath = path.join(siteRoot, "index.html");
  }
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": staticTypes[path.extname(filePath)] ?? "application/octet-stream",
    "Content-Length": String(body.length),
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=86400",
  });
  response.end(body);
}

async function requestJsonBody(request: IncomingMessage, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new AdminHttpError(413, "Request body is too large");
    chunks.push(bytes);
  }
  if (!chunks.length) throw new AdminHttpError(400, "JSON request body is required");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AdminHttpError(400, "Request body must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AdminHttpError(400, "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function expectedRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = request.headers["if-match"];
  const value = typeof header === "string" ? Number(header.replace(/^\"|\"$/g, "")) : body.revision;
  return value === undefined || value === "" ? undefined : Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

async function sendAdmin(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/api/v1/admin/config" && request.method === "GET") {
    return json(response, 200, admin.publicConfig());
  }
  if (!admin.config.enabled) return json(response, 404, { error: "Assets administration is disabled" });
  try {
    admin.authorize(adminFromRequest(request));
    if (pathname === "/api/v1/admin/connectors" && request.method === "GET") return json(response, 200, { connectors: await admin.listConnectors() });
    if (pathname === "/api/v1/admin/connectors" && request.method === "POST") {
      const input = await requestJsonBody(request) as unknown as ConnectorInput;
      return json(response, 201, { connector: await admin.createConnector(input) });
    }
    if (pathname === "/api/v1/admin/catalog/status" && request.method === "GET") {
      return json(response, 200, { mode: coverageLoadMode, loadedAt: coverageLoadedAt, layers: coverageCatalog.layers.length, footprints: coverageCatalog.records.size, warehouseConfigured: evidenceStore.configured });
    }
    if (pathname === "/api/v1/admin/catalog/reload" && request.method === "POST") {
      return json(response, 200, { catalog: await reloadRuntimeCoverage() });
    }
    if (pathname === "/api/v1/admin/tasks" && request.method === "GET") return json(response, 200, { tasks: await admin.listTasks() });
    if (pathname === "/api/v1/admin/tasks" && request.method === "POST") {
      const input = await requestJsonBody(request) as unknown as CoverageTaskInput & { productId?: string; profileId?: string };
      if (input.profileId) {
        const profile = businessModalityProfile(input.profileId);
        const immutable = ["layerId", "surveyId", "releaseId", "product", "productId", "modality", "mode", "coverageRole", "dataOrigin", "sourceTier"] as const;
        for (const key of immutable) if (input[key] !== undefined) return json(response, 400, { error: `${key} is defined by the selected business modality profile` });
        return json(response, 201, { task: await admin.createTask({
          ...input,
          layerId: profile.layerId,
          surveyId: profile.surveyId,
          releaseId: profile.releaseId,
          product: profile.product,
          productId: profile.id,
          modality: profile.modality,
          mode: profile.mode,
          coverageRole: profile.coverageRole,
          dataOrigin: profile.dataOrigin,
          sourceTier: profile.sourceTier,
          allowedSuffixes: input.allowedSuffixes ?? profile.allowedSuffixes,
          maxOrder: input.maxOrder ?? profile.maxOrder,
          raColumn: input.raColumn ?? ("raColumn" in profile ? profile.raColumn : undefined),
          decColumn: input.decColumn ?? ("decColumn" in profile ? profile.decColumn : undefined),
        }) });
      }
      if (input.productId) {
        const product = products.get(input.productId).draft;
        const immutable: Array<[keyof CoverageTaskInput, string | undefined]> = [["layerId", product.layerId], ["surveyId", product.surveyId], ["releaseId", product.releaseId], ["product", product.name], ["productId", product.productId], ["modality", product.modality], ["mode", product.mode], ["coverageRole", product.coverageRole], ["dataOrigin", product.dataOrigin], ["sourceTier", product.sourceTier]];
        for (const [key, expected] of immutable) if (input[key] !== undefined && input[key] !== expected) return json(response, 400, { error: `${String(key)} is defined by the selected product` });
        const derived = {
          ...input,
          layerId: product.layerId ?? input.layerId,
          surveyId: product.surveyId,
          releaseId: product.releaseId,
          product: product.name,
          productId: product.productId,
          modality: product.modality,
          mode: product.mode ?? input.mode,
          coverageRole: product.coverageRole ?? input.coverageRole,
          dataOrigin: product.dataOrigin ?? input.dataOrigin,
          sourceTier: product.sourceTier ?? input.sourceTier,
        };
        if (!derived.layerId || !derived.mode || !derived.coverageRole || !derived.dataOrigin || !derived.sourceTier) return json(response, 400, { error: "Selected product is not executable by the configured recipe" });
        return json(response, 201, { task: await admin.createTask(derived) });
      }
      return json(response, 201, { task: await admin.createTask(input) });
    }
    const taskMatch = /^\/api\/v1\/admin\/tasks\/([^/]+)$/.exec(pathname);
    const retryMatch = /^\/api\/v1\/admin\/tasks\/([^/]+)\/resubmit$/.exec(pathname);
    if (taskMatch?.[1] && request.method === "GET") {
      return json(response, 200, { task: await admin.getTask(decodeURIComponent(taskMatch[1])) });
    }
    if (retryMatch?.[1] && request.method === "POST") {
      return json(response, 201, { task: await admin.resubmitTask(decodeURIComponent(retryMatch[1])) });
    }
    if (pathname === "/api/v1/admin/products" && request.method === "GET") {
      const records = products.list();
      const query = requestQuery(request);
      if (query.get("view") === "surveys") return json(response, 200, { surveys: adminProductSummaries(records) });
      const surveyId = query.get("surveyId")?.trim();
      const filtered = surveyId ? records.filter((record) => record.draft.surveyId === surveyId) : records;
      return json(response, 200, { products: filtered.map(adminProductView) });
    }
    const productMatch = /^\/api\/v1\/admin\/products\/([^/]+)$/.exec(pathname);
    const draftMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/draft$/.exec(pathname);
    if (productMatch?.[1] && request.method === "GET") {
      const record = products.get(decodeURIComponent(productMatch[1]));
      return json(response, 200, { product: adminProductView(record) });
    }
    if ((productMatch?.[1] || draftMatch?.[1]) && request.method === "PUT") {
      const body = await requestJsonBody(request);
      const productId = productMatch?.[1] ?? draftMatch?.[1]!;
      return json(response, 200, { product: await products.updateDraft(decodeURIComponent(productId), body.content ?? body, expectedRevision(request, body)) });
    }
    const publishMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/publish$/.exec(pathname);
    if (publishMatch?.[1] && request.method === "POST") {
      const body = await requestJsonBody(request).catch(() => ({}));
      return json(response, 200, { product: await products.publish(decodeURIComponent(publishMatch[1]), expectedRevision(request, body)) });
    }
    const historyMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/history$/.exec(pathname);
    if (historyMatch?.[1] && request.method === "GET") return json(response, 200, { history: await products.history(decodeURIComponent(historyMatch[1])) });
    return json(response, 404, { error: "Admin endpoint not found" });
  } catch (error) {
    if (error instanceof AdminHttpError || error instanceof KubernetesApiError) return json(response, error.statusCode, { error: error.message });
    throw error;
  }
}

function sendCoverageBlock(request: IncomingMessage, response: ServerResponse, pathname: string): void {
  const match = /^\/api\/v1\/coverage\/blocks\/([a-z0-9-]+)$/.exec(pathname);
  if (!match) return json(response, 404, { error: "Coverage block not found" });
  const record = coverageCatalog.records.get(match[1]!);
  if (!record) return json(response, 404, { error: "Coverage layer not found" });
  const query = requestQuery(request);
  const order = Number(query.get("order"));
  const tile = Number(query.get("tile"));
  if (!Number.isSafeInteger(order) || !Number.isSafeInteger(tile) || order < 0 || order > 29 || tile < 0) return json(response, 400, { error: "order and tile are required integers" });
  const block = coverageBlock(record, order, tile);
  if (!block) return json(response, 404, { error: "Coverage block is unavailable" });
  compressedJson(request, response, 200, block, "public, max-age=31536000, immutable", `"sha256-${block.sha256}"`);
}

async function sendCoverageOverlap(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJsonBody(request).catch(() => ({})) as Record<string, unknown>;
  const surveyIds = Array.isArray(body.surveyIds) ? body.surveyIds.filter((value): value is string => typeof value === "string") : [];
  const requestedOrder = typeof body.requestedOrder === "number" && Number.isInteger(body.requestedOrder) ? body.requestedOrder : undefined;
  const result = overlapForLayers([...coverageCatalog.records.values()], surveyIds, requestedOrder);
  if (!result) return json(response, 400, { error: "At least two surveys with a common HEALPix order are required" });
  const selectedLayers = [...coverageCatalog.records.values()].filter((layer) => surveyIds.includes(layer.surveyId));
  const evidenceLayers = selectedLayers.filter((layer) => layer.sourceUnitIndex?.status === "exact" && layer.sourceUnitIndex.unitKind === "file");
  const needsSourceUnits = result.components.length > 0 && selectedLayers.some((layer) => layer.sourceUnitIndex?.status === "exact" && layer.sourceUnitIndex.unitKind === "tile");
  const sourceUnits = needsSourceUnits ? await sourceUnitsReadyWithin(3_000) : null;
  const componentDetails = await Promise.all(result.components.map(async (component) => {
    const componentCells = new Set(component.cells);
    return { ...component,
    // File-level evidence can be very large for a connected component. The
    // UI already has this component's cells, so it requests the exact bounded
    // file plan only when the user opens that component.
    evidenceLookup: evidenceLayers.length ? {
      endpoint: "/api/v1/coverage/reverse-lookup",
      layerIds: evidenceLayers.map((layer) => layer.layerId),
      order: component.order,
      precision: "exact",
      deferred: true,
    } : undefined,
    surveys: await Promise.all(selectedLayers.filter((layer) => layer.cells.get(component.order)?.some((pixel) => componentCells.has(pixel))).map(async (layer) => ({
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
      modality: layer.modality ?? "coverage",
      sourceUnitIndex: layer.sourceUnitIndex,
      sourceUnits: sourceUnits ? await Promise.resolve(sourceUnits.match(layer.layerId, component.order, component.cells)).catch(() => null) : null,
      downloadUrl: layer.recipe?.sourceUrl,
    }))) };
  }));
  return compressedJson(request, response, 200, { ...result, components: componentDetails }, "public, max-age=60, stale-while-revalidate=120");
}

async function sendCoverageReverseLookup(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJsonBody(request).catch(() => ({})) as Record<string, unknown>;
  const layerIds = Array.isArray(body.layerIds) ? body.layerIds.filter((value): value is string => typeof value === "string") : [];
  const cells = Array.isArray(body.cells) ? body.cells.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value)) : [];
  const order = typeof body.order === "number" && Number.isSafeInteger(body.order) ? body.order : Number.NaN;
  const limit = typeof body.limit === "number" && Number.isSafeInteger(body.limit) ? body.limit : undefined;
  if (layerIds.length < 1 || !Number.isSafeInteger(order) || order < 0 || order > 29 || !cells.length) return json(response, 400, { error: "layerIds, order and cells are required" });
  return compressedJson(request, response, 200, await evidenceStore.reverseLookup({ layerIds, order, cells, limit }), "public, max-age=30, stale-while-revalidate=60");
}

const server = http.createServer((request, response) => {
  void (async () => {
    securityHeaders(response);
    const pathname = requestPath(request);
    if (pathname.startsWith("/api/v1/admin/")) return sendAdmin(request, response, pathname);
    if (pathname === "/api/v1/coverage/overlap" && request.method === "POST") return sendCoverageOverlap(request, response);
    if (pathname === "/api/v1/coverage/reverse-lookup" && request.method === "POST") return sendCoverageReverseLookup(request, response);
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
    if (pathname === "/healthz") return json(response, 200, {
      status: "ok",
      service: "astro-survey-atlas-assets",
      version: "1.0.0",
      bundle: catalog.manifest.bundle,
      files: catalog.files.size,
    });
    if (pathname === "/api/v1/assets") return json(response, 200, publicManifest(catalog));
    if (pathname === "/api/v1/resource-packages/catalog.json") return json(response, 200, await resourcePackageCatalog(catalog));
    if (pathname === "/api/v1/coverage/catalog") {
      const { records: _records, ...publicCoverageCatalog } = coverageCatalog;
      return compressedJson(request, response, 200, publicCoverageCatalog, "public, max-age=300, stale-while-revalidate=60");
    }
    if (pathname.startsWith("/api/v1/coverage/blocks/")) return sendCoverageBlock(request, response, pathname);
    if (pathname === "/api/v1/coverage") return json(response, 200, runtimeCoverageManifest);
    if (pathname === "/api/v1/surveys") return json(response, 200, surveyIndex);
    if (pathname === "/api/v1/products") return json(response, 200, { products: products.list().filter((record) => record.published).map((record) => {
      const published = structuredClone(record.published!);
      const coverage = productCoverage(record);
      return coverage ? { ...published, coverage } : published;
    }) });
    const download = /^\/api\/v1\/assets\/([a-z0-9-]+)\/download$/.exec(pathname);
    if (download?.[1]) return sendDownload(request, response, catalog, download[1]);
    const preview = /^\/api\/v1\/assets\/([a-z0-9-]+)\/preview$/.exec(pathname);
    if (preview?.[1]) return sendPreview(request, response, catalog, preview[1]);
    if (pathname.startsWith("/api/")) return json(response, 404, { error: "API endpoint not found" });
    if (pathname === "/resources" || pathname.startsWith("/resources/")) return json(response, 404, { error: "Resources route has been split into /github/, /surveys/ and /sdk/" });
    return sendStatic(response, pathname);
  })().catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      const statusCode = error instanceof EvidenceStoreError ? error.statusCode : 500;
      const message = error instanceof EvidenceStoreError && statusCode >= 500 ? "Warehouse evidence service is unavailable" : error instanceof Error ? error.message : "Internal server error";
      json(response, statusCode, { error: message });
    }
    else response.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`astro-survey-atlas-assets listening on http://${host}:${port} with bundle ${catalog.manifest.bundle.sha256}`);
});

function shutdown(): void {
  void sourceUnitsPromise?.then((store) => store.terminate()).catch(() => undefined);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
