import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";

/** Preserve the existing admin API/auth headers; never fall back to local mutation. */
export function proxyAdmin(request: IncomingMessage, response: ServerResponse, backend: string, preserveHost = false): void {
  const target = new URL(backend);
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port,
    path: request.url, method: request.method, headers: { ...request.headers, host: preserveHost ? request.headers.host ?? target.host : target.host }, timeout: 120_000 }, remote => {
    response.writeHead(remote.statusCode ?? 502, remote.headers);
    remote.pipe(response);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("Management backend timeout")));
  upstream.on("error", () => {
    if (response.headersSent) response.destroy();
    else { response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify({ error: "Management backend is unavailable; retry shortly" })); }
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}
