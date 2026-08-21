import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { assetPreviewMode, loadCatalog, publicManifest, type LoadedCatalog } from "./catalog.js";
import { projectRoot } from "./paths.js";
import { loadSurveyIndex } from "./surveys.js";

const port = Number(process.env.PORT ?? "4180");
const host = process.env.HOST ?? "0.0.0.0";
const releaseRoot = path.resolve(process.env.ASSET_RELEASE_ROOT ?? projectRoot);
const siteRoot = path.resolve(process.env.PUBLIC_SITE_ROOT ?? path.join(projectRoot, "dist", "site"));
const catalog = await loadCatalog(releaseRoot);
const coverageManifest = JSON.parse(await readFile(path.join(releaseRoot, "src", "footprints", "survey-footprints.json"), "utf8")) as {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: string;
  nside: number;
  footprints: Array<Record<string, unknown> & { surveyId: string; pixels: number[] }>;
};
const surveyIndex = await loadSurveyIndex(releaseRoot, catalog, coverageManifest);
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
  const resolved = path.resolve(siteRoot, requested);
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

const server = http.createServer((request, response) => {
  void (async () => {
    securityHeaders(response);
    const pathname = requestPath(request);
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
    if (pathname === "/api/v1/coverage") return json(response, 200, coverageManifest);
    if (pathname === "/api/v1/surveys") return json(response, 200, surveyIndex);
    const download = /^\/api\/v1\/assets\/([a-z0-9-]+)\/download$/.exec(pathname);
    if (download?.[1]) return sendDownload(request, response, catalog, download[1]);
    const preview = /^\/api\/v1\/assets\/([a-z0-9-]+)\/preview$/.exec(pathname);
    if (preview?.[1]) return sendPreview(request, response, catalog, preview[1]);
    if (pathname.startsWith("/api/")) return json(response, 404, { error: "API endpoint not found" });
    return sendStatic(response, pathname);
  })().catch((error) => {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: "Internal server error" });
    else response.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`astro-survey-atlas-assets listening on http://${host}:${port} with bundle ${catalog.manifest.bundle.sha256}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
