export interface DownloadPlanMatch {
  layerId?: string;
  evidenceLayerId?: string;
  observationLayerId?: string;
  scopeId?: string;
  partitionId?: string;
  order: number;
  ipix: number;
  precision: string;
  coverageMethod?: string;
  coverageRole?: string;
  sourceOrder?: number;
  scanRunId?: string;
  sourceSnapshotSha256?: string;
}

export interface DownloadPlanFile {
  fileId: string;
  metadataState: "complete" | "missing";
  unitKind?: string;
  unitId?: string;
  downloadProvider?: string;
  fileName?: string;
  fileType?: string;
  sizeBytes?: number;
  lastModified?: string;
  etag?: string;
  sourceUri?: string;
  downloadable: boolean;
  downloadUrl?: string;
  matchingCoverage: DownloadPlanMatch[];
  matchingCoverageTruncated?: boolean;
  warnings?: string[];
  observations?: Array<{ layerId?: string; scanRunId?: string; sourceSnapshotSha256?: string; fileName?: string; sizeBytes?: number; lastModified?: string; sourceUri?: string; metadataState: "complete" | "missing" }>;
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

export interface DownloadPlanCoverageEvidence {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality?: string;
  evidenceKind: "observation-footprint" | "published-moc" | "tile-footprint" | "wcs-coverage";
  order: number;
  nside: number;
  nativeMaxOrder: number;
  availableOrders: number[];
  matchedCells: number[];
  precision: "exact" | "estimated";
  completeness?: "complete" | "incomplete" | "unknown";
  scienceFileScan?: "not-scanned" | "partial" | "complete";
  sourceIdentity?: string;
  instrument?: string;
  filters?: string;
  sourceSnapshotSha256?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  geometrySourceUrl?: string;
  coverageUrl?: string;
  summary: string;
}

export interface DownloadPlan {
  schemaVersion: 1;
  files: DownloadPlanFile[];
  entrypoints: DownloadPlanEntrypoint[];
  coverageEvidence?: DownloadPlanCoverageEvidence[];
  tileSelections?: DownloadPlanTileSelection[];
  truncated: boolean;
  warnings: string[];
  scanScopes?: Array<{ layerId: string; publishedLayerId?: string; scopeId: string; scopeSnapshotSha256: string; expectedPartitions: number; committedPartitions: number; completeness: "complete" | "incomplete" }>;
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
  "ra_min_deg", "ra_max_deg", "dec_min_deg", "dec_max_deg", "area_deg2", "notes", "evidence_kind", "source_label", "source_url", "geometry_source_url", "coverage_url", "available_orders", "native_max_order", "source_identity", "instrument", "filters", "source_snapshot_sha256", "completeness", "science_file_scan",
  "file_observations", "scan_scopes", "matching_coverage_truncated",
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
    const notes = joinUnique([
      file.metadataState === "missing" ? "FileAsset metadata missing" : undefined,
      plan.truncated ? "coverage result truncated" : undefined,
      file.matchingCoverageTruncated ? "file coverage matches truncated" : undefined,
      ...(file.warnings ?? []),
    ]);
    rows.push([
      component.id, "file", String(component.order), String(2 ** component.order), precision,
      joinUnique(layers), joinUnique(layerEntries.map((entry) => entry.surveyId)) || firstLayer.surveyId,
      joinUnique(layerEntries.map((entry) => entry.releaseId)) || firstLayer.releaseId,
      joinUnique(layerEntries.map((entry) => entry.product)) || firstLayer.product,
      joinUnique(layerEntries.map((entry) => entry.modality)) || firstLayer.modality,
      file.fileId, file.fileName ?? "", file.fileType ?? "", file.sizeBytes === undefined ? "" : String(file.sizeBytes),
      file.sourceUri ?? "", String(file.downloadable), file.downloadUrl ?? "",
      JSON.stringify(file.matchingCoverage),
      joinUnique(file.matchingCoverage.map((match) => match.coverageMethod)), "", file.unitId ?? "", "", "", "", "", "", "",
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
  (plan.coverageEvidence ?? []).forEach((evidence) => {
    rows.push([
      component.id, "coverage-evidence", String(evidence.order), String(evidence.nside), evidence.precision,
      evidence.layerId, evidence.surveyId, evidence.releaseId, evidence.product, evidence.modality ?? "",
      "", "", "", "", "", "", "", JSON.stringify(evidence.matchedCells), "", evidence.evidenceKind,
      "", evidence.coverageUrl ?? "", "", "", "", "", "",
      String(component.bounds.raMin), String(component.bounds.raMax), String(component.bounds.decMin), String(component.bounds.decMax), String(component.bounds.areaDeg2), evidence.summary,
      evidence.evidenceKind, evidence.sourceLabel ?? "", evidence.sourceUrl ?? "", evidence.geometrySourceUrl ?? "", evidence.coverageUrl ?? "", JSON.stringify(evidence.availableOrders),
      String(evidence.nativeMaxOrder), evidence.sourceIdentity ?? "", evidence.instrument ?? "", evidence.filters ?? "", evidence.sourceSnapshotSha256 ?? "", evidence.completeness ?? "", evidence.scienceFileScan ?? "",
    ]);
  });
  return rows.map((row) => {
    const padded = [...row, ...Array(Math.max(0, OVERLAP_DOWNLOAD_HEADER.length - row.length)).fill("")];
    const file = row[1] === "file" ? plan.files.find(file => file.fileId === row[10]) : undefined;
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("file_observations")] = file?.observations?.length ? JSON.stringify(file.observations) : "";
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("scan_scopes")] = plan.scanScopes?.length ? JSON.stringify(plan.scanScopes) : "";
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("matching_coverage_truncated")] = file?.matchingCoverageTruncated === undefined ? "" : String(file.matchingCoverageTruncated);
    if (file) padded[OVERLAP_DOWNLOAD_HEADER.indexOf("source_snapshot_sha256")] = joinUnique(file.matchingCoverage.map(match => match.sourceSnapshotSha256));
    return padded;
  });
}

export function overlapCsvDocument(rows: string[][]): string {
  return [OVERLAP_DOWNLOAD_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
