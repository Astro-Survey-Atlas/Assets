import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { loadCatalog, publicManifest, type LoadedCatalog } from "./catalog.js";
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
      version: "0.1.0",
      bundle: catalog.manifest.bundle,
      files: catalog.files.size,
    });
    if (pathname === "/api/v1/assets") return json(response, 200, publicManifest(catalog));
    if (pathname === "/api/v1/coverage") return json(response, 200, coverageManifest);
    if (pathname === "/api/v1/surveys") return json(response, 200, surveyIndex);
    const download = /^\/api\/v1\/assets\/([a-z0-9-]+)\/download$/.exec(pathname);
    if (download?.[1]) return sendDownload(request, response, catalog, download[1]);
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
