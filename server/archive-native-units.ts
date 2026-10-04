import type { ArtifactStore } from "./artifact-store.js";
import type { CoverageCellLayer } from "./coverage.js";
import type { DownloadPlanSpatialUnit } from "./evidence-store.js";
import { cellsForStcs } from "./hst-image-lookup.js";
import type { HstObservationIndex } from "./hst-observation-index.js";
import { ERO_METADATA_URL, eroFramesForProduct, type EroTargetIndex } from "./ero-target-index.js";
import { surveyNativeBinding, type SurveyNativeIndex } from "./survey-native-index.js";
import type { NativeBinding } from "./native-unit-model.js";
import { metadataEntrypoint, verifiedDirectoryAlternative } from "./survey-access.js";

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
  options: { hstIndex?: HstObservationIndex; eroIndex?: EroTargetIndex; surveyIndex?: SurveyNativeIndex; bindings?: NativeBinding[]; limit?: number } = {}): Promise<{
  units: DownloadPlanSpatialUnit[]; indexedLayerIds: Set<string>; unavailableLayerIds: string[]; truncated: boolean; notes: string[];
}> {
  const units: DownloadPlanSpatialUnit[] = [];
  const indexedLayerIds = new Set<string>();
  const unavailableLayerIds: string[] = [];
  const notes: string[] = [];
  let truncated = false;
  const hst = layers.filter((layer) => layer.surveyId === "hst");
  const ero = layers.filter((layer) => layer.surveyId === "euclid" && layer.releaseId === "euclid-ero");
  for (const layer of layers.filter(layer => surveyNativeBinding(layer))) {
    try {
      const binding = options.bindings?.find(binding => binding.layerId === layer.layerId);
      if (!binding || !options.surveyIndex) throw new Error("The reviewed local survey-native index or product binding is unavailable");
      const result = options.surveyIndex.lookup(binding, order, cells, options.limit);
      units.push(...result.units); indexedLayerIds.add(layer.layerId); truncated ||= result.truncated; notes.push(...result.notes);
    } catch (error) { unavailableLayerIds.push(layer.layerId); notes.push(`${layer.surveyId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await Promise.all([
    (async () => {
      if (!hst.length) return;
      try {
        if (!options.hstIndex) throw new Error("The locked local HST observation index is unavailable");
        const result = options.hstIndex.lookup(order, cells);
        truncated ||= result.truncated;
        if (result.partialRefresh) notes.push(`HST retains its historical input from ${result.baselineCapturedAt} (SHA ${result.baselineSnapshotSha256}) plus ${result.supplementRows} selected fresh metadata rows. This bounded supplement does not establish a complete current inventory or remove observations absent from the selected pages.`);
        if (result.excludedRows) notes.push(`HST local snapshot excludes ${result.excludedRows} public image rows without supported spatial geometry.`);
        if (!result.queryExhausted) notes.push(`HST local lookup matched at least ${result.matchedObservationCount} observations and reached its configured ${result.observations.length}-observation result limit.`);
        for (const layer of hst) {
          indexedLayerIds.add(layer.layerId);
          for (const observation of result.observations.filter((obs) => hstObservationMatchesLayer(layer, obs))) {
            units.push({ ...unitIdentity(layer, order), unitKind: "observation", unitId: observation.obsid,
              matchingCells: observation.matchingCells, accessAvailability: "source-policy",
              sRegion: observation.sRegion, instrument: observation.instrument, filters: observation.filters,
              sourceUrl: "https://mast.stsci.edu/api/v0/invoke", sourceSnapshotSha256: result.sourceSnapshotSha256,
              sourceMetadata: { entrypoints: [metadataEntrypoint(observation.productUrl, "hst", layer.releaseId)] },
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
        if (index.excludedTargets) { truncated = true; notes.push(`ERO snapshot excludes ${index.excludedTargets} targets without a verified target footprint.`); }
        if (index.metadataTransportExceptions?.length) notes.push("ERO header evidence records a CDN certificate-time exception; certificate chain and hostname were verified during metadata capture.");
        for (const layer of ero) indexedLayerIds.add(layer.layerId);
        for (const target of index.targets) {
          for (const layer of ero) {
            const frames = eroFramesForProduct(target, layer.product);
            if (target.frames && !frames.length) continue;
            const regions = [...new Set(frames.length ? frames.map(frame => frame.sRegion) : [target.sRegion])];
            const matchingCells = [...new Set(regions.flatMap(region => cellsForStcs(order, cells, region)))].sort((a, b) => a - b);
            if (!matchingCells.length) continue;
            const instrument = /NISP/i.test(layer.product) ? "NISP" : /\bVIS\b/i.test(layer.product) ? "VIS" : undefined;
            const catalog = layer.modality === "catalog" || /catalog/i.test(layer.product);
            const packageUrls = target.urls.filter((url) => (!instrument || url.includes(`Euclid-${instrument}-`)) && url.includes(catalog ? "/Catalog/" : "/Stack/"));
            if (!/^ERO-[A-Za-z0-9_-]+$/.test(target.id)) throw new Error("Invalid ERO target identity for the verified IRSA directory rule");
            const targetName = target.id.slice(4);
            const imageDirectory = `https://irsa.ipac.caltech.edu/data/Euclid/ERO/images/${targetName}/${target.id}/`;
            const accessUris = catalog ? [] : [{ uri: imageDirectory, accessType: "directory" as const,
              alternatives: [verifiedDirectoryAlternative(imageDirectory, "NASA/IPAC IRSA Euclid ERO mirror", "US", "IPAC, Pasadena, California, US",
                "2026-10-04", "All 17 official ERO target directories returned HTTP 200 and listed 15 separate FITS files. This directory contains files for multiple bands; file bytes were not compared with ESA package members.")] }];
            units.push({ ...unitIdentity(layer, order), unitKind: "target", unitId: target.id, matchingCells,
              ...(accessUris.length ? { accessUri: imageDirectory, accessUris } : {}),
              accessAvailability: "source-policy", sRegion: regions.join(" "), sourceUrl: new URL(target.id, ERO_METADATA_URL).toString(), sourceSnapshotSha256: index.sourceSnapshotSha256,
              sourceMetadata: { archivePackageUris: packageUrls, packageInventory: "Official target XML package references; direct catalog-file members were not verified." },
              ...(frames.length ? { geometryEvidence: frames, instrument: [...new Set(frames.map(frame => frame.instrument))].join(","), filters: [...new Set(frames.map(frame => frame.filter))].join(",") } : {}),
              note: frames.length
                ? "ERO target directory lists separate FITS files; archive packages are not presented as download links. Spatial association uses the selected band's ICRS TAN frame from locked ESA FITS headers. Estimated frame bounds do not verify valid-pixel masks or exposure holes. IRSA file bytes were not compared with ESA package members. This is a target, not a Tile."
                : "ERO target, not a Tile. Its footprint is estimated from the ESA Sky outreach region, not a verified instrument/filter frame. Official XML package references remain source metadata; no direct catalog-file URL was verified." });
          }
        }
        notes.push(index.targets.some(target => target.frames?.length)
          ? "Euclid ERO matches named targets using their own per-band image-frame WCS. Valid-pixel masks and an ERO Tile inventory remain unverified."
          : "Euclid ERO lookup is limited to named targets with associated ESA Sky outreach footprints; no ERO Tile inventory is available.");
      } catch (error) { unavailableLayerIds.push(...ero.map((layer) => layer.layerId)); notes.push(`Euclid ERO: ${error instanceof Error ? error.message : String(error)}`); }
    })(),
  ]);
  return { units, indexedLayerIds, unavailableLayerIds, truncated: truncated || unavailableLayerIds.length > 0, notes };
}
