import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { ArtifactStore } from "./artifact-store.js";
import type { CoverageCellLayer } from "./coverage.js";
import type { DownloadPlanSpatialUnit } from "./evidence-store.js";
import { cellsForStcs, lookupHstImages } from "./hst-image-lookup.js";
import { metadataFetch } from "./metadata-fetch.js";

const ERO_URL = "https://euclid.esac.esa.int/dr/ero/";
const TAP_URL = "https://sky.esa.int/esasky-tap/tap/sync";
const xml = new XMLParser({ ignoreAttributes: false, processEntities: false });
const CACHE_MS = 24 * 3600_000;
let eroIndex: { expiresAt: number; targets: Array<{ id: string; sRegion: string }>; raw: string[] } | undefined;
const targetCache = new Map<string, { expiresAt: number; raw: string; urls: string[] }>();

async function metadata(url: string | URL, querySignal: AbortSignal): Promise<string> {
  querySignal.throwIfAborted();
  const response = await metadataFetch(url, { signal: AbortSignal.any([querySignal, AbortSignal.timeout(25_000)]) });
  if (!response.ok) throw new Error(`Official archive metadata returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Archive metadata exceeded its size limit");
  return bytes.toString("utf8");
}

function links(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(links);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record["@_href"] === "string" ? [record["@_href"]] : []),
    ...Object.entries(record).filter(([key]) => !key.startsWith("@_")).flatMap(([, item]) => links(item)),
  ];
}

const targetKey = (value: string): string => value.replace(/^ERO-/i, "").replace(/_HighRes$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();

async function loadEroIndex(querySignal: AbortSignal): Promise<NonNullable<typeof eroIndex>> {
  if (eroIndex && eroIndex.expiresAt > Date.now()) return eroIndex;
  const landing = await metadata(ERO_URL, querySignal);
  const ids = [...new Set(links(xml.parse(landing)).flatMap((href) => {
    const url = new URL(href, ERO_URL);
    const id = url.pathname.match(/^\/dr\/ero\/(ERO-[A-Za-z0-9_-]+)\/?$/)?.[1];
    return url.origin === new URL(ERO_URL).origin && id ? [id] : [];
  }))];
  if (!ids.length || ids.length > 100) throw new Error("Euclid ERO target metadata is unavailable");
  const tap = new URL(TAP_URL);
  tap.search = new URLSearchParams({ REQUEST: "doQuery", LANG: "ADQL", FORMAT: "json",
    QUERY: "SELECT TOP 200 id,object_name,title,stc_s FROM images.euclid_outreach" }).toString();
  const raw = await metadata(tap, querySignal);
  const table = JSON.parse(raw) as { metadata: Array<{ name: string }>; data: unknown[][] };
  const columns = table.metadata.map((column) => column.name);
  const rows = table.data.map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index]])));
  const targets = ids.flatMap((id) => {
    const match = rows.find((row) => typeof row.id === "string" && targetKey(row.id) === targetKey(id)
      && typeof row.stc_s === "string");
    return match ? [{ id, sRegion: String(match.stc_s) }] : [];
  });
  if (!targets.length) throw new Error("No ERO targets have a verified ESA Sky footprint association");
  eroIndex = { expiresAt: Date.now() + CACHE_MS, targets, raw: [landing, raw] };
  return eroIndex;
}

async function targetProducts(id: string, querySignal: AbortSignal): Promise<{ raw: string; urls: string[] }> {
  const cached = targetCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const raw = await metadata(new URL(id, ERO_URL), querySignal);
  const document = xml.parse(raw) as { data?: { dataitem?: { name?: string } } };
  if (document.data?.dataitem?.name !== id) throw new Error("ERO target identity does not match its official metadata");
  const urls = [...new Set(links(document).filter((href) => {
    const url = new URL(href, ERO_URL);
    return url.origin === "https://cdn.euclid.esac.esa.int" && /^\/(Stack|Catalog)\//.test(url.pathname)
      && url.pathname.includes(`-${id}.`) && /\.tar(?:\.gz)?$/.test(url.pathname);
  }))];
  const result = { expiresAt: Date.now() + CACHE_MS, raw, urls };
  targetCache.set(id, result);
  return result;
}

export function hstObservationMatchesLayer(layer: CoverageCellLayer, observation: { obsid: string; instrument?: string; filters?: string }): boolean {
  const obsid = layer.sourceEvidence?.sourceIdentity?.match(/\bobsid\s+(\d+)/i)?.[1]
    ?? layer.layerId.match(/(?:observation|obs)-(\d+)$/)?.[1];
  if (obsid) return observation.obsid === obsid;
  const instrument = layer.sourceEvidence?.instrument ?? layer.product.match(/\b(ACS|WFC3)\b/i)?.[1];
  if (!instrument || !observation.instrument?.toUpperCase().startsWith(instrument.toUpperCase())) return false;
  const filter = layer.sourceEvidence?.filters;
  return !filter || observation.filters === filter;
}

function unitIdentity(layer: CoverageCellLayer, order: number): Pick<DownloadPlanSpatialUnit, "layerId" | "productId" | "surveyId" | "releaseId" | "product" | "modality" | "order" | "nside" | "precision"> {
  return { layerId: layer.layerId, productId: layer.productId, surveyId: layer.surveyId, releaseId: layer.releaseId,
    product: layer.product, ...(layer.modality ? { modality: layer.modality } : {}), order, nside: 2 ** order, precision: "estimated" };
}

export async function archiveNativeUnits(layers: readonly CoverageCellLayer[], order: number, cells: readonly number[], store: ArtifactStore): Promise<{
  units: DownloadPlanSpatialUnit[]; indexedLayerIds: Set<string>; unavailableLayerIds: string[]; truncated: boolean; notes: string[];
}> {
  const units: DownloadPlanSpatialUnit[] = [];
  const indexedLayerIds = new Set<string>();
  const unavailableLayerIds: string[] = [];
  const notes: string[] = [];
  let truncated = false;
  const querySignal = AbortSignal.timeout(45_000);
  const hst = layers.filter((layer) => layer.surveyId === "hst");
  const ero = layers.filter((layer) => layer.surveyId === "euclid" && layer.releaseId === "euclid-ero");
  await Promise.all([
    (async () => {
      if (!hst.length) return;
      try {
        const result = await lookupHstImages({ order, cells }, store, { metadataOnly: true, signal: querySignal });
        truncated ||= result.truncated;
        notes.push(...result.errors.map((error) => `HST: ${error.message}`));
        for (const layer of hst) {
          indexedLayerIds.add(layer.layerId);
          for (const observation of result.observations.filter((obs) => hstObservationMatchesLayer(layer, obs))) {
            units.push({ ...unitIdentity(layer, order), unitKind: "observation", unitId: observation.obsid,
              matchingCells: observation.matchingCells, accessUri: observation.productUrl, accessAvailability: "source-policy",
              sRegion: observation.sRegion, instrument: observation.instrument, filters: observation.filters,
              sourceUrl: "https://mast.stsci.edu/api/v0/invoke", sourceSnapshotSha256: result.sourceSnapshotSha256,
              note: "Public MAST observation metadata; s_region intersection is estimated. Open the observation in MAST for products and archive access policies. Query exhaustion does not establish a complete HST inventory." });
          }
        }
      } catch (error) { unavailableLayerIds.push(...hst.map((layer) => layer.layerId)); notes.push(`HST: ${error instanceof Error ? error.message : String(error)}`); }
    })(),
    (async () => {
      if (!ero.length) return;
      try {
        const index = await loadEroIndex(querySignal);
        const selected = index.targets.flatMap((target) => {
          const matchingCells = cellsForStcs(order, cells, target.sRegion);
          return matchingCells.length ? [{ ...target, matchingCells }] : [];
        });
        for (const layer of ero) indexedLayerIds.add(layer.layerId);
        for (const target of selected) {
          const products = await targetProducts(target.id, querySignal);
          const evidence = JSON.stringify({ schemaVersion: 1, source: [ERO_URL, TAP_URL], target: target.id, footprint: target.sRegion, raw: [...index.raw, products.raw] });
          const sha256 = createHash("sha256").update(evidence).digest("hex");
          await store.putImmutable(`euclid-ero-lookups/${sha256}.json`, evidence, { contentType: "application/json", metadata: { deliveryClass: "evidence", surveyId: "euclid" } });
          for (const layer of ero) {
            const instrument = /NISP/i.test(layer.product) ? "NISP" : /\bVIS\b/i.test(layer.product) ? "VIS" : undefined;
            const catalog = layer.modality === "catalog" || /catalog/i.test(layer.product);
            const urls = products.urls.filter((url) => (!instrument || url.includes(`Euclid-${instrument}-`)) && url.includes(catalog ? "/Catalog/" : "/Stack/"));
            units.push({ ...unitIdentity(layer, order), unitKind: "target", unitId: target.id, matchingCells: target.matchingCells,
              ...(urls.length ? { accessUri: urls[0], accessUris: urls.map((uri) => ({ uri, fileName: new URL(uri).pathname.split("/").at(-1)! })) } : {}),
              accessAvailability: "source-policy", sRegion: target.sRegion, sourceUrl: new URL(target.id, ERO_URL).toString(), sourceSnapshotSha256: sha256,
              note: "ERO target package, not a Tile. The associated ESA Sky outreach footprint is an estimated target extent, not a verified instrument/filter footprint. Package links are read from official ERO metadata; scientific contents and file existence were not inspected. Only targets associated with official ESA Sky geometry can be matched." });
          }
        }
        notes.push("Euclid ERO lookup is limited to named targets with associated ESA Sky outreach footprints; no ERO Tile inventory is available.");
      } catch (error) { unavailableLayerIds.push(...ero.map((layer) => layer.layerId)); notes.push(`Euclid ERO: ${error instanceof Error ? error.message : String(error)}`); }
    })(),
  ]);
  return { units, indexedLayerIds, unavailableLayerIds, truncated: truncated || unavailableLayerIds.length > 0, notes };
}
