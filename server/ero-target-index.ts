import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { metadataFetch } from "./metadata-fetch.js";
import { eroFitsFrame, type EroFitsHeader, type EroFrameFootprint } from "./ero-fits-footprint.js";

export const ERO_METADATA_URL = "https://euclid.esac.esa.int/dr/ero/";
const geometryUrl = "https://sky.esa.int/esasky-tap/tap/sync";
const xml = new XMLParser({ ignoreAttributes: false, processEntities: false });
export interface EroTargetIndex {
  sourceSnapshotSha256: string;
  targets: Array<{ id: string; sRegion: string; urls: string[]; frames?: EroFrameFootprint[] }>;
  excludedTargets: number;
  metadataTransportExceptions?: string[];
}
interface EroMetadataSnapshot {
  schemaVersion: 1 | 2; kind: "euclid-ero-target-metadata"; capturedAt: string;
  sourceUrl: string; geometrySourceUrl: string;
  landing: string; geometry: string; products: Array<{ id: string; xml: string }>;
  packageHeaders?: Array<{
    targetId: string; packageUrl: string; capturedAt: string; tls: string; packageSizeBytes: number;
    ranges: Array<{ start: number; end: number; sizeBytes: number; sha256: string }>;
    fitsHeaders: EroFitsHeader[];
  }>;
}

function links(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(links);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [...(typeof record["@_href"] === "string" ? [record["@_href"]] : []),
    ...Object.entries(record).filter(([key]) => !key.startsWith("@_")).flatMap(([, item]) => links(item))];
}
function targetIds(landing: string): string[] {
  const ids = [...new Set(links(xml.parse(landing)).flatMap(href => {
    const url = new URL(href, ERO_METADATA_URL);
    const id = url.pathname.match(/^\/dr\/ero\/(ERO-[A-Za-z0-9_-]+)\/?$/)?.[1];
    return url.origin === new URL(ERO_METADATA_URL).origin && id ? [id] : [];
  }))];
  if (!ids.length || ids.length > 100) throw new Error("Euclid ERO target metadata is unavailable");
  return ids;
}
const targetKey = (value: string): string => value.replace(/^ERO-/i, "").replace(/_HighRes$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
const geometryAliases: Readonly<Record<string, readonly string[]>> = {
  // ESA Sky publishes both the default and high-resolution rows as M78.
  messier78: ["m78"],
};

function targetAssociationKeys(value: string): Set<string> {
  const key = targetKey(value);
  return new Set([key, ...(geometryAliases[key] ?? [])]);
}

/** Select the actual band's header rather than borrowing a sibling's WCS. */
export function eroFramesForProduct(target: EroTargetIndex["targets"][number], product: string): EroFrameFootprint[] {
  const instrument = /NISP/i.test(product) ? "NISP" : /\bVIS\b/i.test(product) ? "VIS" : undefined;
  const filter = /NISP[.\s_-]+([YJH])\b/i.exec(product)?.[1]?.toUpperCase();
  return (target.frames ?? []).filter(frame => frame.filter !== "CHI2"
    && (!instrument || frame.instrument === instrument) && (!filter || frame.filter === filter));
}

/** Parse saved official metadata only. A target package is never relabelled as a Tile. */
export function parseEroTargetSnapshot(bytes: string, sha256: string): EroTargetIndex {
  const snapshot = JSON.parse(bytes) as EroMetadataSnapshot;
  if (![1, 2].includes(snapshot.schemaVersion) || snapshot.kind !== "euclid-ero-target-metadata"
    || snapshot.sourceUrl !== ERO_METADATA_URL || snapshot.geometrySourceUrl !== geometryUrl
    || !Number.isFinite(Date.parse(snapshot.capturedAt)) || !Array.isArray(snapshot.products)
    || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid locked ERO target metadata snapshot");
  const ids = targetIds(snapshot.landing);
  if (snapshot.schemaVersion === 2 && (!Array.isArray(snapshot.packageHeaders)
    || snapshot.packageHeaders.length !== ids.length * 2
    || new Set(snapshot.packageHeaders.map(item => item.packageUrl)).size !== ids.length * 2
    || snapshot.packageHeaders.some(item => !ids.includes(item.targetId)))) throw new Error("ERO snapshot is missing the explicit VIS/NISP header inventory");
  const table = JSON.parse(snapshot.geometry) as { metadata: Array<{ name: string }>; data: unknown[][] };
  const columns = table.metadata.map(column => column.name);
  if (!columns.includes("id") || !columns.includes("stc_s") || !Array.isArray(table.data)) throw new Error("ERO snapshot has no ESA Sky target geometry");
  const rows = table.data.map(row => Object.fromEntries(columns.map((name, index) => [name, row[index]])));
  if (snapshot.products.length !== ids.length || new Set(snapshot.products.map(product => product.id)).size !== ids.length) throw new Error("ERO snapshot is missing target metadata documents");
  const targets: EroTargetIndex["targets"] = [];
  const transportExceptions = new Set<string>();
  for (const id of ids) {
    const product = snapshot.products.find(product => product.id === id);
    if (!product) throw new Error("ERO snapshot is missing a target document");
    const document = xml.parse(product.xml) as { data?: { dataitem?: { name?: string } } };
    if (document.data?.dataitem?.name !== id) throw new Error("ERO target identity disagrees with its official XML");
    const urls = [...new Set(links(document).filter(href => {
      const url = new URL(href, ERO_METADATA_URL);
      return url.origin === "https://cdn.euclid.esac.esa.int" && /^\/(Stack|Catalog)\//.test(url.pathname)
        && url.pathname.includes(`-${id}.`) && /\.tar(?:\.gz)?$/.test(url.pathname);
    }))];
    if (snapshot.schemaVersion === 2) {
      const packages = snapshot.packageHeaders!.filter(item => item.targetId === id);
      if (packages.length !== 2) throw new Error(`ERO target is missing an instrument package: ${id}`);
      const frames: EroFrameFootprint[] = [];
      for (const item of packages) {
        if (!urls.includes(item.packageUrl) || !item.packageUrl.includes("/Stack/")
          || !Number.isFinite(Date.parse(item.capturedAt)) || !Number.isSafeInteger(item.packageSizeBytes) || item.packageSizeBytes < 512
          || !Array.isArray(item.ranges) || !item.ranges.length || item.ranges.length > 512
          || item.ranges.some(range => !Number.isSafeInteger(range.start) || range.start < 0
            || !Number.isSafeInteger(range.end) || range.end < range.start || range.end >= item.packageSizeBytes
            || !Number.isSafeInteger(range.sizeBytes) || range.sizeBytes !== range.end - range.start + 1 || range.sizeBytes > 65536
            || !/^[a-f0-9]{64}$/.test(range.sha256))
          || !Array.isArray(item.fitsHeaders) || !item.fitsHeaders.length || item.fitsHeaders.length > 8
          || !["chain-and-hostname-verified", "chain-and-hostname-verified; certificate-time-check-disabled"].includes(item.tls)) throw new Error(`Invalid ERO header capture receipt: ${id}`);
        if (item.tls.endsWith("; certificate-time-check-disabled")) transportExceptions.add("euclid-ero-cdn-certificate-time-exception");
        for (const header of item.fitsHeaders) {
          const tarSha = createHash("sha256").update(Buffer.from(header.tarHeaderBase64 ?? "", "base64")).digest("hex");
          if (header.targetId !== id || header.packageUrl !== item.packageUrl
            || !item.ranges.some(range => range.start === header.tarOffset && range.sizeBytes === 512 && range.sha256 === tarSha)) throw new Error("ERO FITS header disagrees with its official target/package receipt");
          let cursor = header.tarOffset + 512;
          const prefixEnd = cursor + header.compressedPrefixBytes;
          while (cursor < prefixEnd) {
            const range = item.ranges.find(range => range.start === cursor);
            if (!range || range.end >= prefixEnd) throw new Error("ERO FITS header has no complete bounded-prefix request receipt");
            cursor = range.end + 1;
          }
          frames.push(eroFitsFrame(header));
        }
      }
      const bands = frames.map(frame => `${frame.instrument}:${frame.filter}`);
      if (new Set(bands).size !== bands.length || ["VIS:VIS", "NISP:Y", "NISP:J", "NISP:H"].some(band => !bands.includes(band))) throw new Error(`ERO target is missing its own per-band image frame: ${id}`);
      targets.push({ id, sRegion: frames.find(frame => frame.instrument === "VIS")!.sRegion, urls, frames });
      continue;
    }
    const aliases = targetAssociationKeys(id);
    const matches = rows.filter(row => typeof row.id === "string"
      && [...targetAssociationKeys(row.id)].some(key => aliases.has(key))
      && typeof row.stc_s === "string");
    if (!matches.length) continue;
    const regions = [...new Set(matches.map(row => String(row.stc_s)))];
    if (regions.length !== 1) throw new Error(`ERO target has conflicting outreach footprints: ${id}`);
    targets.push({ id, sRegion: regions[0]!, urls });
  }
  if (!targets.length) throw new Error("ERO snapshot has no verified target-to-outreach-footprint associations");
  return { sourceSnapshotSha256: sha256, targets, excludedTargets: ids.length - targets.length,
    ...(transportExceptions.size ? { metadataTransportExceptions: [...transportExceptions] } : {}) };
}

/** Called exclusively by a managed acquisition task, never by a region query. */
export async function acquireEroTargetSnapshot(progress: (message: string) => void = () => undefined): Promise<string> {
  const metadata = async (url: string | URL): Promise<string> => {
    const response = await metadataFetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error(`Official ERO metadata returned HTTP ${response.status}`);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error("ERO metadata exceeded its size budget");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  const landing = await metadata(ERO_METADATA_URL);
  const ids = targetIds(landing);
  const tap = new URL(geometryUrl);
  tap.search = new URLSearchParams({ REQUEST: "doQuery", LANG: "ADQL", FORMAT: "json",
    QUERY: "SELECT TOP 200 id,object_name,title,stc_s FROM images.euclid_outreach" }).toString();
  const geometry = await metadata(tap);
  const products: EroMetadataSnapshot["products"] = [];
  for (let offset = 0; offset < ids.length; offset += 2) {
    products.push(...await Promise.all(ids.slice(offset, offset + 2).map(async id => ({ id, xml: await metadata(new URL(id, ERO_METADATA_URL)) }))));
    progress(`Locked ERO target metadata ${products.length}/${ids.length}; scientific packages are source links`);
  }
  return JSON.stringify({ schemaVersion: 1, kind: "euclid-ero-target-metadata", capturedAt: new Date().toISOString(),
    sourceUrl: ERO_METADATA_URL, geometrySourceUrl: geometryUrl, landing, geometry, products } satisfies EroMetadataSnapshot) + "\n";
}
