import { EnvHttpProxyAgent } from "undici";

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? new EnvHttpProxyAgent() : undefined;

/** Only official metadata endpoints call this helper; scientific objects are never fetched. */
export function metadataFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, ...(proxy ? { dispatcher: proxy } : {}) } as RequestInit);
}
