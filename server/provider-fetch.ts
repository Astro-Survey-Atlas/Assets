import https from "node:https";
import { lookup } from "node:dns/promises";
import { isPublicAddress } from "./public-source-fetch.js";

/** Credentials are sent only to the configured public HTTPS origin, without redirects. */
export const providerFetch: typeof fetch = async (input, init = {}) => {
 const url = new URL(String(input));
 if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new Error("Invalid provider URL");
 const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
 if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error("Provider must use public addresses");
 const pinned = addresses[0]!;
 return new Promise((resolve, reject) => {
  const req = https.request(url, { method: init.method ?? "GET", signal: init.signal ?? undefined,
   headers: Object.fromEntries(new Headers(init.headers).entries()),
   lookup: ((_host: unknown, options: unknown, callback: (...args: unknown[]) => void) => callback(null, options && typeof options === "object" && "all" in options && options.all ? [pinned] : pinned.address, pinned.family)) as never,
  }, res => {
   const chunks: Buffer[] = []; let size = 0;
   res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2*1024*1024) res.destroy(new Error("Provider response too large")); else chunks.push(chunk); });
   res.on("error", reject);
   res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502 })));
  });
  req.on("error", reject); req.setTimeout(60_000, () => req.destroy(new Error("Provider timeout")));
  if (init.body) req.write(String(init.body)); req.end();
 });
};
