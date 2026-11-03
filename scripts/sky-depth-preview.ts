/** Run the real Atlas against published coverage and a bounded local DESI snapshot. */
import http from "node:http";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { SkyDepthInputError, SkyDepthStore } from "../server/sky-depth.js";

const args = new Map(process.argv.slice(2).map(arg => { const at = arg.indexOf("="); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const samplePath = args.get("sample") ?? process.env.ASSETS_SKY_DEPTH_SAMPLE_PATH;
const sampleSha256 = args.get("sha256") ?? process.env.ASSETS_SKY_DEPTH_SAMPLE_SHA256;
if (!samplePath || !sampleSha256 || !/^[a-f0-9]{64}$/.test(sampleSha256)) {
  throw Error("Use --sample=/absolute/evidence.json --sha256=<expected snapshot SHA-256>");
}
const upstream = new URL(args.get("upstream") ?? "http://10.15.51.75:32083");
if (upstream.protocol !== "http:" || upstream.username || upstream.password) throw Error("Preview upstream must be an unauthenticated HTTP Assets service");
const port = Number(args.get("port") ?? 5176), apiPort = Number(args.get("api-port") ?? 4188);
const root = fileURLToPath(new URL("../", import.meta.url));
const sampleFile = await realpath(samplePath);
const store = new SkyDepthStore({ evidenceRoot: args.get("evidence-root") ?? path.dirname(sampleFile), samplePath: sampleFile, sampleSha256,
  referencePath: path.join(root, "fixtures/distance-prototype/planck18-reference.json") });

const api = http.createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const json = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  try {
    if (pathname === "/api/v1/sky-depth/example" && request.method === "GET") return json(200, await store.example());
    if (pathname === "/api/v1/sky-depth" && request.method === "POST") {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 65536) return json(413, { error: "Query exceeds bounded request size" });
        chunks.push(chunk);
      }
      let query: unknown;
      try { query = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(400, { error: "Invalid JSON" }); }
      return json(200, await store.query(query));
    }
    // The preview exposes public read paths only; management stays on the real service.
    if (pathname.startsWith("/api/admin/") || !["GET", "HEAD"].includes(request.method ?? "")
      && !["/api/v1/coverage/overlap", "/api/v1/access/region-query", "/api/v1/access/coverage-block"].includes(pathname)) {
      return json(405, { error: "This preview supports public Atlas reads only" });
    }
    const proxy = http.request(new URL(request.url ?? "/", upstream), { method: request.method,
      headers: { ...request.headers, host: upstream.host }, timeout: 30000 }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    proxy.on("timeout", () => proxy.destroy(Error("Upstream timeout")));
    proxy.on("error", () => { if (!response.headersSent) json(502, { error: "Published coverage is temporarily unavailable" }); else response.destroy(); });
    request.pipe(proxy);
  } catch (error) {
    json(error instanceof SkyDepthInputError ? 400 : 503, { error: error instanceof SkyDepthInputError ? error.message : "Depth preview is unavailable" });
  }
});
await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(apiPort, "127.0.0.1", resolve); });
const vite = await createServer({ configFile: path.join(root, "vite.config.ts"), server: { host: "0.0.0.0", port, strictPort: true,
  proxy: { "/api": `http://127.0.0.1:${apiPort}`, "/healthz": `http://127.0.0.1:${apiPort}` } } });
try { await vite.listen(); } catch (error) { api.close(); throw error; }
console.log(`Atlas + real DESI depth: http://localhost:${port}/atlas/?depth=desi`);
console.log(`Coverage: ${upstream.origin}; depth: hash-locked local evidence (loaded on request).`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => { await vite.close(); api.close(); });
