import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export function publicSourceUrl(value: string): URL {
  const u = new URL(value);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) throw new Error("来源必须为不含凭证的公共 HTTP(S) 地址");
  u.hash = "";
  return u;
}
const deniedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) deniedV6.addSubnet(address, prefix, "ipv6");
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
  }
  return isIP(address) === 6 && /^[23]/i.test(address) && !deniedV6.check(address, "ipv6");
}
/** Resolve and pin a public address for every hop; no ambient proxy or cookies. */
export async function fetchPublicSource(value: string, maxBytes: number, signal: AbortSignal, hops = 0): Promise<{ url: string; bytes: Buffer; contentType: string }> {
  signal.throwIfAborted();
  const u = publicSourceUrl(value);
  const addresses = await lookup(u.hostname.replace(/^\[|\]$/g, ""), { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error("来源地址不是公共网络地址");
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).get(u, {
      signal, headers: { Accept: "application/fits,application/json,text/html,text/plain,*/*", "User-Agent": "AstroAssets-Discovery/1.0" },
      lookup: ((_host: unknown, _options: unknown, callback: (...args: unknown[]) => void) => callback(null, _options && typeof _options === "object" && "all" in _options && _options.all ? [pinned] : pinned.address, pinned.family)) as never,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (hops >= 3 || !res.headers.location) return reject(new Error("来源重定向过多或缺少目标"));
        void fetchPublicSource(new URL(res.headers.location, u).href, maxBytes, signal, hops + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`来源返回 HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) res.destroy(new Error("来源响应超过大小限制")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ url: u.href, bytes: Buffer.concat(chunks), contentType: String(res.headers["content-type"] ?? "") }));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("来源读取超时")));
  });
}
