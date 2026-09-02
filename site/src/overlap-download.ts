export interface DownloadPlanMatch {
  layerId?: string;
  order: number;
  ipix: number;
  precision: string;
  coverageMethod?: string;
  coverageRole?: string;
  sourceOrder?: number;
}

export interface DownloadPlanFile {
  fileId: string;
  metadataState: "complete" | "missing";
  fileName?: string;
  fileType?: string;
  sizeBytes?: number;
  lastModified?: string;
  etag?: string;
  sourceUri?: string;
  downloadable: boolean;
  downloadUrl?: string;
  matchingCoverage: DownloadPlanMatch[];
}

export interface DownloadPlanEntrypoint {
  kind: string;
  purpose: "data-access" | "coverage-reference";
  layerId?: string;
  productId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  order?: number;
  nside?: number;
  cells?: number[];
  precision: string;
  url?: string;
  sourceUri?: string;
  sourceScope?: "prefix" | "file" | "tile-directory";
  sourceUrl?: string;
  mocUrl?: string;
  tileId?: string;
  required?: boolean;
  selectionRule?: string;
  selectionComplete?: boolean;
  truncated?: boolean;
  note?: string;
  [key: string]: unknown;
}

export interface DownloadPlanTileSelection {
  layerId: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  tileIds: string[];
  selectionRule: string;
  complete: boolean;
  note: string;
}

export interface DownloadPlan {
  schemaVersion: 1;
  files: DownloadPlanFile[];
  entrypoints: DownloadPlanEntrypoint[];
  tileSelections?: DownloadPlanTileSelection[];
  truncated: boolean;
  warnings: string[];
}

export interface DownloadComponent {
  id: string;
  order: number;
  cells: number[];
  bounds: { areaDeg2: number; raMin: number; raMax: number; decMin: number; decMax: number };
}

export interface DownloadLayerEntry {
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
}

export const OVERLAP_DOWNLOAD_HEADER = [
  "component_id", "item_kind", "order", "nside", "precision", "layer_id", "survey_id", "release_id", "product", "modality",
  "source_file_id", "file_name", "file_type", "size_bytes", "source_uri", "downloadable", "download_url", "matching_cells", "coverage_methods", "entrypoint_kind", "tile_id", "entrypoint_url", "source_scope", "required", "selection_complete", "selection_rule", "required_tile_ids",
  "ra_min_deg", "ra_max_deg", "dec_min_deg", "dec_max_deg", "area_deg2", "notes",
] as const;

export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function joinUnique(values: Array<string | undefined>): string {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].join("; ");
}

export function overlapCsvRows(
  component: DownloadComponent,
  plan: DownloadPlan,
  resolveLayer: (layerId: string | undefined) => DownloadLayerEntry,
  fallbackPrecision = "entrypoint-only",
): string[][] {
  const rows: string[][] = [];
  plan.files.forEach((file) => {
    const layers = file.matchingCoverage.map((match) => match.layerId);
    const firstLayer = resolveLayer(file.matchingCoverage[0]?.layerId);
    const layerEntries = [...new Set(layers.filter((value): value is string => Boolean(value)))].map(resolveLayer);
    const precision = joinUnique(file.matchingCoverage.map((match) => match.precision)) || fallbackPrecision;
    const notes = file.metadataState === "missing" ? "FileAsset metadata missing" : plan.truncated ? "coverage result truncated" : "";
    rows.push([
      component.id, "file", String(component.order), String(2 ** component.order), precision,
      joinUnique(layers), joinUnique(layerEntries.map((entry) => entry.surveyId)) || firstLayer.surveyId,
      joinUnique(layerEntries.map((entry) => entry.releaseId)) || firstLayer.releaseId,
      joinUnique(layerEntries.map((entry) => entry.product)) || firstLayer.product,
      joinUnique(layerEntries.map((entry) => entry.modality)) || firstLayer.modality,
      file.fileId, file.fileName ?? "", file.fileType ?? "", file.sizeBytes === undefined ? "" : String(file.sizeBytes),
      file.sourceUri ?? "", String(file.downloadable), file.downloadUrl ?? "",
      JSON.stringify(file.matchingCoverage.map((match) => ({ layerId: match.layerId, order: match.order, ipix: match.ipix, precision: match.precision }))),
      joinUnique(file.matchingCoverage.map((match) => match.coverageMethod)), "", "", "", "", "", "", "", "",
      String(component.bounds.raMin), String(component.bounds.raMax), String(component.bounds.decMin), String(component.bounds.decMax), String(component.bounds.areaDeg2), notes,
    ]);
  });
  plan.entrypoints.forEach((entry) => {
    const layer = resolveLayer(entry.layerId);
    const tileSelection = entry.layerId ? plan.tileSelections?.find((selection) => selection.layerId === entry.layerId) : undefined;
    const itemKind = entry.kind === "source-path" ? "source-path" : "entrypoint";
    rows.push([
      component.id, itemKind, String(entry.order ?? component.order), String(entry.nside ?? 2 ** component.order), entry.precision,
      entry.layerId ?? "", entry.surveyId ?? layer.surveyId, entry.releaseId ?? layer.releaseId, entry.product ?? layer.product, layer.modality,
      "", "", "", "", entry.sourceUri ?? "", "", "", JSON.stringify(entry.cells ?? component.cells), "", entry.kind,
      typeof entry.tileId === "string" ? entry.tileId : "", entry.url ?? entry.sourceUrl ?? entry.mocUrl ?? "", entry.sourceScope ?? "",
      entry.required === undefined ? "" : String(entry.required), entry.selectionComplete === undefined ? (tileSelection ? String(tileSelection.complete) : "") : String(entry.selectionComplete),
      entry.selectionRule ?? tileSelection?.selectionRule ?? "", tileSelection ? JSON.stringify(tileSelection.tileIds) : "",
      String(component.bounds.raMin), String(component.bounds.raMax), String(component.bounds.decMin), String(component.bounds.decMax), String(component.bounds.areaDeg2), entry.note ?? "",
    ]);
  });
  return rows;
}

export function overlapCsvDocument(rows: string[][]): string {
  return [OVERLAP_DOWNLOAD_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
