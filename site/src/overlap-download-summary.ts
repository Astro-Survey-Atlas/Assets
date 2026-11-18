import type { DownloadComponent, DownloadLayerEntry, DownloadPlan } from "./overlap-download.js";
import { csvCell } from "./overlap-download.js";

/** One deduplicated thing the user may download for an overlap region. */
export interface DownloadSummaryItem {
  kind: "file" | "unit" | "entrypoint";
  name: string;
  type: string;
  sizeBytes?: number;
  url: string;
  precision: string;
  surveys: string[];
  releases: string[];
  products: string[];
  layers: string[];
  components: string[];
  overlap: string;
  notes: string;
}

export interface DownloadSummary {
  schemaVersion: 2;
  totals: {
    items: number;
    files: number;
    units: number;
    entrypoints: number;
    knownBytes: number;
    unknownSizeItems: number;
    duplicatesRemoved: number;
  };
  bySurvey: Array<{ surveyId: string; items: number; knownBytes: number }>;
  items: DownloadSummaryItem[];
}

export const DOWNLOAD_SUMMARY_HEADER = [
  "kind", "survey", "release", "product", "name", "type", "size_bytes", "url", "precision", "overlap_cells", "components", "notes",
] as const;

const MAX_CELLS_SHOWN = 6;

function cellsLabel(cells: Map<number, Set<number>>): string {
  return [...cells].sort(([left], [right]) => left - right).map(([order, set]) => {
    const sorted = [...set].sort((left, right) => left - right);
    const shown = sorted.slice(0, MAX_CELLS_SHOWN).join(",");
    return `O${order}:${shown}${sorted.length > MAX_CELLS_SHOWN ? `(+${sorted.length - MAX_CELLS_SHOWN})` : ""}`;
  }).join(" ");
}

interface Accumulator {
  item: Omit<DownloadSummaryItem, "overlap" | "surveys" | "releases" | "products" | "layers" | "components"> & {
    surveys: Set<string>; releases: Set<string>; products: Set<string>; layers: Set<string>; components: Set<string>;
  };
  cells: Map<number, Set<number>>;
}

/**
 * Collapse the full, audit-oriented download plans of one or more overlap components into
 * a single list of unique downloadable things: same URL (or file id) appears once even
 * when several layers or components reach it.
 */
export function buildDownloadSummary(
  entries: Array<{ component: DownloadComponent; plan: DownloadPlan }>,
  resolveLayer: (layerId: string | undefined) => DownloadLayerEntry,
): DownloadSummary {
  const byKey = new Map<string, Accumulator>();
  let rawRows = 0;
  const add = (
    key: string,
    base: { kind: DownloadSummaryItem["kind"]; name: string; type: string; sizeBytes?: number; url: string; precision: string; notes: string },
    componentId: string,
    layerIds: Array<string | undefined>,
    cells: Array<{ order: number; ipix: number }>,
  ): void => {
    rawRows += 1;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        item: { ...base, surveys: new Set(), releases: new Set(), products: new Set(), layers: new Set(), components: new Set() },
        cells: new Map(),
      };
      byKey.set(key, acc);
    }
    acc.item.components.add(componentId);
    for (const layerId of layerIds) {
      if (!layerId) continue;
      const layer = resolveLayer(layerId);
      acc.item.layers.add(layerId);
      if (layer.surveyId) acc.item.surveys.add(layer.surveyId);
      if (layer.releaseId) acc.item.releases.add(layer.releaseId);
      if (layer.product) acc.item.products.add(layer.product);
    }
    for (const { order, ipix } of cells) {
      const set = acc.cells.get(order) ?? new Set<number>();
      set.add(ipix);
      acc.cells.set(order, set);
    }
    if (acc.item.sizeBytes === undefined && base.sizeBytes !== undefined) acc.item.sizeBytes = base.sizeBytes;
    if (base.precision === "estimated" || base.precision === "entrypoint-only") acc.item.precision = base.precision;
  };

  for (const { component, plan } of entries) {
    const coveredUrls = new Set<string>();
    for (const file of plan.files) {
      const url = file.downloadUrl ?? file.sourceUri ?? "";
      if (url) coveredUrls.add(url);
      add(url || `file:${file.fileId}`, {
        kind: "file", name: file.fileName ?? file.fileId, type: file.fileType ?? "", sizeBytes: file.sizeBytes, url,
        precision: [...new Set(file.matchingCoverage.map((match) => match.precision))].join("/") || "exact",
        notes: file.downloadable ? "" : "source-hosted; not mirrored by Assets",
      }, component.id, file.matchingCoverage.map((match) => match.layerId), file.matchingCoverage.map((match) => ({ order: match.order, ipix: match.ipix })));
    }
    for (const unit of plan.spatialUnits ?? []) {
      const uris = unit.accessUris?.length ? unit.accessUris.map((entry) => ({ url: entry.uri, name: entry.fileName ?? unit.unitId })) : unit.accessUri ? [{ url: unit.accessUri, name: unit.unitId }] : [];
      const cells = (unit.matchingRegions ?? (unit.order === undefined ? [] : [{ order: unit.order, cells: unit.matchingCells ?? [] }]))
        .flatMap((region) => region.cells.map((ipix) => ({ order: region.order, ipix })));
      for (const uri of uris) {
        if (coveredUrls.has(uri.url)) continue;
        add(uri.url, { kind: "unit", name: uri.name, type: unit.unitKind, url: uri.url, precision: unit.precision, notes: unit.note ?? "" },
          component.id, [unit.layerId], cells);
      }
    }
    for (const entry of plan.entrypoints) {
      if (entry.purpose !== "data-access") continue;
      const url = entry.url ?? entry.sourceUrl ?? entry.sourceUri ?? "";
      if (!url || coveredUrls.has(url)) continue;
      add(`entry:${url}`, { kind: "entrypoint", name: entry.tileId ?? entry.kind, type: entry.kind, url, precision: entry.precision, notes: entry.note ?? "" },
        component.id, [entry.layerId], entry.order === undefined ? [] : (entry.cells ?? []).map((ipix) => ({ order: entry.order!, ipix })));
    }
  }

  const items: DownloadSummaryItem[] = [...byKey.values()].map(({ item, cells }) => ({
    ...item,
    surveys: [...item.surveys].sort(), releases: [...item.releases].sort(), products: [...item.products].sort(),
    layers: [...item.layers].sort(), components: [...item.components].sort(), overlap: cellsLabel(cells),
  })).sort((left, right) => left.kind.localeCompare(right.kind) || left.surveys.join().localeCompare(right.surveys.join()) || left.name.localeCompare(right.name));

  const surveyTotals = new Map<string, { items: number; knownBytes: number }>();
  for (const item of items) {
    for (const surveyId of item.surveys.length ? item.surveys : [""]) {
      const total = surveyTotals.get(surveyId) ?? { items: 0, knownBytes: 0 };
      total.items += 1;
      total.knownBytes += item.sizeBytes ?? 0;
      surveyTotals.set(surveyId, total);
    }
  }
  return {
    schemaVersion: 2,
    totals: {
      items: items.length,
      files: items.filter((item) => item.kind === "file").length,
      units: items.filter((item) => item.kind === "unit").length,
      entrypoints: items.filter((item) => item.kind === "entrypoint").length,
      knownBytes: items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
      unknownSizeItems: items.filter((item) => item.sizeBytes === undefined).length,
      duplicatesRemoved: rawRows - items.length,
    },
    bySurvey: [...surveyTotals].map(([surveyId, total]) => ({ surveyId, ...total })).sort((left, right) => left.surveyId.localeCompare(right.surveyId)),
    items,
  };
}

export function downloadSummaryCsv(summary: DownloadSummary): string {
  const rows = summary.items.map((item) => [
    item.kind, item.surveys.join("; "), item.releases.join("; "), item.products.join("; "), item.name, item.type,
    item.sizeBytes === undefined ? "" : String(item.sizeBytes), item.url, item.precision, item.overlap, item.components.join("; "), item.notes,
  ]);
  return [DOWNLOAD_SUMMARY_HEADER as readonly string[], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
