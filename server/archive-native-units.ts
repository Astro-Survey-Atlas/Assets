import type { ArtifactStore } from "./artifact-store.js";
import type { CoverageCellLayer } from "./coverage.js";
import type { DownloadPlanSpatialUnit } from "./evidence-store.js";
import { cellsForStcs } from "./hst-image-lookup.js";
import type { HstObservationIndex } from "./hst-observation-index.js";
import { ERO_METADATA_URL, type EroTargetIndex } from "./ero-target-index.js";

export function hstObservationMatchesLayer(layer: CoverageCellLayer, observation: { obsid: string; instrument?: string; filters?: string }): boolean {
  const obsid = layer.sourceEvidence?.sourceIdentity?.match(/\bobsid\s+(\d+)/i)?.[1]
    ?? layer.layerId.match(/(?:observation|obs)-(\d+)$/)?.[1];
  if (obsid) return observation.obsid === obsid;
  const instrument = layer.sourceEvidence?.instrument ?? layer.product.match(/\b(ACS|WFC3)\b/i)?.[1];
  const instruments = observation.instrument?.split(",").map((value) => value.trim().toUpperCase()) ?? [];
  if (!instrument || !instruments.some((value) => value.startsWith(instrument.toUpperCase()))) return false;
  const filter = layer.sourceEvidence?.filters;
  return !filter || observation.filters?.split(",").map((value) => value.trim()).includes(filter) === true;
}

function unitIdentity(layer: CoverageCellLayer, order: number): Pick<DownloadPlanSpatialUnit, "layerId" | "productId" | "surveyId" | "releaseId" | "product" | "modality" | "order" | "nside" | "precision"> {
  return { layerId: layer.layerId, productId: layer.productId, surveyId: layer.surveyId, releaseId: layer.releaseId,
    product: layer.product, ...(layer.modality ? { modality: layer.modality } : {}), order, nside: 2 ** order, precision: "estimated" };
}

export async function archiveNativeUnits(layers: readonly CoverageCellLayer[], order: number, cells: readonly number[], _store: ArtifactStore,
  options: { hstIndex?: HstObservationIndex; eroIndex?: EroTargetIndex } = {}): Promise<{
  units: DownloadPlanSpatialUnit[]; indexedLayerIds: Set<string>; unavailableLayerIds: string[]; truncated: boolean; notes: string[];
}> {
  const units: DownloadPlanSpatialUnit[] = [];
  const indexedLayerIds = new Set<string>();
  const unavailableLayerIds: string[] = [];
  const notes: string[] = [];
  let truncated = false;
  const hst = layers.filter((layer) => layer.surveyId === "hst");
  const ero = layers.filter((layer) => layer.surveyId === "euclid" && layer.releaseId === "euclid-ero");
  await Promise.all([
    (async () => {
      if (!hst.length) return;
      try {
        if (!options.hstIndex) throw new Error("The locked local HST observation index is unavailable");
        const result = options.hstIndex.lookup(order, cells);
        truncated ||= result.truncated;
        if (result.excludedRows) notes.push(`HST local snapshot excludes ${result.excludedRows} public image rows without supported spatial geometry.`);
        if (!result.queryExhausted) notes.push(`HST local lookup matched at least ${result.matchedObservationCount} observations and reached its configured ${result.observations.length}-observation result limit.`);
        for (const layer of hst) {
          indexedLayerIds.add(layer.layerId);
          for (const observation of result.observations.filter((obs) => hstObservationMatchesLayer(layer, obs))) {
            units.push({ ...unitIdentity(layer, order), unitKind: "observation", unitId: observation.obsid,
              matchingCells: observation.matchingCells, accessUri: observation.productUrl, accessAvailability: "source-policy",
              sRegion: observation.sRegion, instrument: observation.instrument, filters: observation.filters,
              sourceUrl: "https://mast.stsci.edu/api/v0/invoke", sourceSnapshotSha256: result.sourceSnapshotSha256,
              note: "Public MAST observation metadata from the locked local snapshot; s_region matching is estimated, and highly detailed footprints may use a conservative spherical cap that can include nearby false-positive candidates. Inspect the saved footprint and open the observation in MAST for products and archive access policies." });
          }
        }
      } catch (error) { unavailableLayerIds.push(...hst.map((layer) => layer.layerId)); notes.push(`HST: ${error instanceof Error ? error.message : String(error)}`); }
    })(),
    (async () => {
      if (!ero.length) return;
      try {
        const index = options.eroIndex;
        if (!index) throw new Error("The locked local ERO target metadata snapshot is unavailable");
        if (index.excludedTargets) { truncated = true; notes.push(`ERO snapshot excludes ${index.excludedTargets} targets without an unambiguous outreach footprint.`); }
        const selected = index.targets.flatMap((target) => {
          const matchingCells = cellsForStcs(order, cells, target.sRegion);
          return matchingCells.length ? [{ ...target, matchingCells }] : [];
        });
        for (const layer of ero) indexedLayerIds.add(layer.layerId);
        for (const target of selected) {
          for (const layer of ero) {
            const instrument = /NISP/i.test(layer.product) ? "NISP" : /\bVIS\b/i.test(layer.product) ? "VIS" : undefined;
            const catalog = layer.modality === "catalog" || /catalog/i.test(layer.product);
            const urls = target.urls.filter((url) => (!instrument || url.includes(`Euclid-${instrument}-`)) && url.includes(catalog ? "/Catalog/" : "/Stack/"));
            units.push({ ...unitIdentity(layer, order), unitKind: "target", unitId: target.id, matchingCells: target.matchingCells,
              ...(urls.length ? { accessUri: urls[0], accessUris: urls.map((uri) => ({ uri, fileName: new URL(uri).pathname.split("/").at(-1)! })) } : {}),
              accessAvailability: "source-policy", sRegion: target.sRegion, sourceUrl: new URL(target.id, ERO_METADATA_URL).toString(), sourceSnapshotSha256: index.sourceSnapshotSha256,
              note: "ERO target package, not a Tile. The associated ESA Sky outreach footprint is an estimated target extent, not a verified instrument/filter footprint. Package links are read from official ERO metadata; scientific contents and file existence were not inspected. Only targets associated with official ESA Sky geometry can be matched." });
          }
        }
        notes.push("Euclid ERO lookup is limited to named targets with associated ESA Sky outreach footprints; no ERO Tile inventory is available.");
      } catch (error) { unavailableLayerIds.push(...ero.map((layer) => layer.layerId)); notes.push(`Euclid ERO: ${error instanceof Error ? error.message : String(error)}`); }
    })(),
  ]);
  return { units, indexedLayerIds, unavailableLayerIds, truncated: truncated || unavailableLayerIds.length > 0, notes };
}
