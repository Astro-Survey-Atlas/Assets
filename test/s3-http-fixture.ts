import http from "node:http";
import { createHash } from "node:crypto";

/** Minimal local S3 protocol fixture exercising the actual SDK/child-process path. */
export async function s3HttpFixture() {
  const objects = new Map<string, { bytes: Buffer; sha: string; etag: string }>();
  const server = http.createServer((req, res) => { void (async () => {
    const key = decodeURIComponent(new URL(req.url!, "http://fixture").pathname);
    const existing = objects.get(key);
    if (req.method === "PUT") {
      if ((req.headers["if-none-match"] === "*" && existing) || (req.headers["if-match"] && req.headers["if-match"] !== existing?.etag)) {
        res.writeHead(412, { "Content-Type": "application/xml" }); res.end("<Error><Code>PreconditionFailed</Code></Error>"); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let bytes = Buffer.concat(chunks);
      if (String(req.headers["content-encoding"] ?? "").includes("aws-chunked")) {
        const decoded: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const end = bytes.indexOf("\r\n", offset);
          const length = Number.parseInt(bytes.subarray(offset, end).toString().split(";")[0]!, 16);
          if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid S3 streaming chunk");
          if (length === 0) break;
          decoded.push(bytes.subarray(end + 2, end + 2 + length));
          offset = end + 2 + length + 2;
        }
        bytes = Buffer.concat(decoded);
      }
      const etag = `"${createHash("md5").update(bytes).digest("hex")}"`;
      objects.set(key, { bytes, etag, sha: String(req.headers["x-amz-meta-sha256"] ?? "") });
      res.writeHead(200, { ETag: etag }); res.end(); return;
    }
    if (!existing) { res.writeHead(404, { "Content-Type": "application/xml" }); res.end("<Error><Code>NoSuchKey</Code></Error>"); return; }
    let bytes = existing.bytes;
    let status = 200;
    const headers: Record<string, string | number> = { ETag: existing.etag, "x-amz-meta-sha256": existing.sha };
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    if (range) {
      bytes = bytes.subarray(Number(range[1]), Number(range[2]) + 1);
      headers["Content-Range"] = `bytes ${range[1]}-${range[2]}/${existing.bytes.length}`;
      status = 206;
    }
    res.writeHead(status, { ...headers, "Content-Length": bytes.length });
    res.end(req.method === "HEAD" ? undefined : bytes);
  })().catch(error => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const env = {
    ASSETS_OBJECT_STORE_ENDPOINT: `http://127.0.0.1:${address.port}`, ASSETS_OBJECT_STORE_BUCKET: "fixture",
    ASSETS_OBJECT_STORE_ACCESS_KEY_ID: "fixture", ASSETS_OBJECT_STORE_SECRET_ACCESS_KEY: "fixture",
    ASSETS_OBJECT_STORE_REQUIRED: "1", ASSETS_OBJECT_STORE_PREFIX: "",
    AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED", AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
  };
  return { env, objects, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
