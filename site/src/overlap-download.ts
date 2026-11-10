import type { ScanConnectorIdentity } from "../../src/connector-icon.js";
import type { SkyRectangle, SkyRegion, SkyRegionCoverMetadata } from "../../src/sky-region.js";

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
  sourceIpix?: number;
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
  connectors?: ScanConnectorIdentity[];
  downloadable: boolean;
  downloadUrl?: string;
  matchingCoverage: DownloadPlanMatch[];
  matchingCoverageTruncated?: boolean;
  warnings?: string[];
  observations?: Array<{ layerId?: string; scanRunId?: string; sourceSnapshotSha256?: string; fileName?: string; sizeBytes?: number; lastModified?: string; sourceUri?: string; metadataState: "complete" | "missing" }>;
}

export interface DownloadMatchingRegion {
  order: number;
  cells: number[];
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
  matchingRegions?: DownloadMatchingRegion[];
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
  evidenceKind: "observation-footprint" | "published-moc" | "tile-footprint" | "source-unit-footprint" | "wcs-coverage";
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

export interface DownloadPlanScannedFile {
  fileId: string;
  fileName?: string;
  sourceUri?: string;
  scanRunId?: string;
  sourceSnapshotSha256?: string;
  matchingCoverage?: DownloadPlanMatch[];
  matchingEvidenceScope?: "batch" | "full-region";
  connectors?: ScanConnectorIdentity[];
}

export interface DownloadPlanSpatialUnit {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality?: string;
  unitKind: string;
  unitId: string;
  order?: number;
  nside?: number;
  matchingCells?: number[];
  matchingRegions?: DownloadMatchingRegion[];
  memberCompleteness?: "complete-for-region" | "incomplete" | "unit-candidate";
  matchingEvidenceScope?: "batch" | "full-region";
  precision: string;
  accessUri?: string;
  accessUris?: Array<{ uri: string; fileName?: string; band?: string; accessType?: "file" | "directory" | "entrypoint"; alternatives?: DownloadPlanSourceAccessAlternative[] }>;
  accessAvailability?: "public" | "source-policy" | "unverified";
  sourceSnapshotSha256?: string;
  note?: string;
  sRegion?: string;
  geometryEvidence?: Array<{ kind: "fits-wcs-frame"; sRegion: string; sourceUrl: string; memberName: string; sha256: string; instrument: string; filter: string }>;
  instrument?: string;
  filters?: string;
  sourceUrl?: string;
  nativePartition?: { coordinateFrame: "ICRS"; ordering: "NESTED"; order: number; firstIpix: number; lastIpix: number; precision: "exact" };
  sourceMetadata?: Record<string, unknown>;
  scannedFiles?: DownloadPlanScannedFile[];
}

export interface DownloadPlanSourceAccessAlternative {
  uri: string;
  accessType: "file" | "directory" | "entrypoint";
  provider: string;
  providerCountryCode?: string;
  providerLocation?: string;
  servingRegion?: string;
  relationship?: string;
  status: "verified" | "source-listed" | "rule-derived" | "entrypoint-only" | "unavailable";
  checkedAt?: string;
  httpStatus?: number;
  note?: string;
}

export interface DownloadPlan {
  schemaVersion: 1 | 2;
  spatialUnits?: DownloadPlanSpatialUnit[];
  files: DownloadPlanFile[];
  entrypoints: DownloadPlanEntrypoint[];
  coverageEvidence?: DownloadPlanCoverageEvidence[];
  tileSelections?: DownloadPlanTileSelection[];
  truncated: boolean;
  warnings: string[];
  scanScopes?: Array<{ layerId: string; publishedLayerId?: string; scopeId: string; scopeSnapshotSha256: string; expectedPartitions: number; committedPartitions: number; completeness: "complete" | "incomplete" }>;
}

function unionNumbers(left: readonly number[] = [], right: readonly number[] = []): number[] {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

function groupMatchingRegions(regions: readonly DownloadMatchingRegion[]): DownloadMatchingRegion[] {
  const orders = new Map<number, Set<number>>();
  for (const region of regions) {
    const cells = orders.get(region.order) ?? new Set<number>();
    region.cells.forEach(cell => cells.add(cell));
    orders.set(region.order, cells);
  }
  return [...orders].sort(([left], [right]) => left - right).map(([order, cells]) => ({ order, cells: [...cells].sort((left, right) => left - right) }));
}

function matchingRegionsFor(value: { order?: number; matchingRegions?: DownloadMatchingRegion[] }, cells?: number[]): DownloadMatchingRegion[] {
  // An explicit multi-order membership is authoritative, even if legacy fields remain.
  return value.matchingRegions !== undefined ? groupMatchingRegions(value.matchingRegions)
    : value.order === undefined ? [] : [{ order: value.order, cells: unionNumbers(cells) }];
}

function mergeOrderSafeMembership<T extends { order?: number; nside?: number; matchingRegions?: DownloadMatchingRegion[]; cells?: number[]; matchingCells?: number[] }>(
  previous: T, next: T, cellKey: "cells" | "matchingCells",
): T {
  const merged = { ...previous, ...next };
  const regions = groupMatchingRegions([...matchingRegionsFor(previous, previous[cellKey]), ...matchingRegionsFor(next, next[cellKey])]);
  if (regions.length === 1) {
    const region = regions[0]!;
    merged.order = region.order;
    merged.nside = 2 ** region.order;
    merged[cellKey] = region.cells;
  } else {
    // In particular, never interpret an ipix at one order as an ipix at another.
    delete merged.order;
    delete merged.nside;
    delete merged[cellKey];
  }
  if (regions.length > 1 || previous.matchingRegions !== undefined || next.matchingRegions !== undefined) merged.matchingRegions = regions;
  return merged;
}

function conservativePrecision(left: string, right: string): string {
  const rank: Record<string, number> = { exact: 0, estimated: 1, "entrypoint-only": 2, truncated: 3 };
  if (rank[left] === undefined) return left || right;
  if (rank[right] === undefined) return left;
  return rank[left]! >= rank[right]! ? left : right;
}

function mergeAccessUris(...lists: Array<Array<NonNullable<DownloadPlanSpatialUnit["accessUris"]>[number]> | undefined>) {
  const entries = new Map<string, NonNullable<DownloadPlanSpatialUnit["accessUris"]>[number]>();
  for (const entry of lists.flatMap(list => list ?? [])) {
    const key = `${entry.fileName ?? entry.uri}:${entry.band ?? ""}:${entry.accessType ?? ""}`;
    const old = entries.get(key);
    if (!old) { entries.set(key, entry); continue; }
    const alternatives = new Map([...(old.alternatives ?? []), ...(entry.alternatives ?? [])]
      .map(item => [`${item.provider}:${item.uri}`, item]));
    entries.set(key, { ...old, ...entry, uri: old.uri, ...(alternatives.size ? { alternatives: [...alternatives.values()] } : {}) });
  }
  return [...entries.values()];
}

function mergeSpatialSourceMetadata(previous?: Record<string, unknown>, next?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!previous && !next) return undefined;
  const result = { ...previous, ...next };
  for (const key of ["entrypoints", "providerStatuses", "records", "archivePackageUris"]) {
    const items = [...(Array.isArray(previous?.[key]) ? previous[key] as unknown[] : []), ...(Array.isArray(next?.[key]) ? next[key] as unknown[] : [])];
    if (items.length) result[key] = [...new Map(items.map(item => [typeof item === "string" ? item : JSON.stringify(item), item])).values()];
  }
  return result;
}

function mergeScanConnectors(previous?: ScanConnectorIdentity[], next?: ScanConnectorIdentity[]): ScanConnectorIdentity[] {
  const identities = new Map<string, ScanConnectorIdentity>();
  for (const connector of [...(previous ?? []), ...(next ?? [])]) {
    const key = `${connector.name}:${connector.type}:${connector.identityBasis}`;
    identities.set(key, { ...identities.get(key), ...connector });
  }
  return [...identities.values()];
}

export function mergeDownloadPlans(previous: DownloadPlan, next: DownloadPlan): DownloadPlan {
  const matchKey = (match: DownloadPlanMatch) => [match.layerId, match.order, match.ipix, match.sourceOrder, match.sourceIpix, match.precision, match.scanRunId,
    match.sourceSnapshotSha256, match.evidenceLayerId, match.observationLayerId, match.scopeId, match.partitionId].join(":");
  const files = new Map(previous.files.map((file) => [file.fileId, file]));
  for (const file of next.files) {
    const old = files.get(file.fileId);
    if (!old) { files.set(file.fileId, file); continue; }
    const matches = new Map(old.matchingCoverage.map((match) => [matchKey(match), match]));
    file.matchingCoverage.forEach((match) => matches.set(matchKey(match), match));
    const observations = new Map([...(old.observations ?? []), ...(file.observations ?? [])]
      .map((observation) => [`${observation.layerId ?? ""}:${observation.scanRunId ?? ""}:${observation.sourceSnapshotSha256 ?? ""}:${observation.sourceUri ?? ""}`, observation]));
    files.set(file.fileId, { ...old, ...file, matchingCoverage: [...matches.values()],
      ...(old.connectors?.length || file.connectors?.length ? { connectors: mergeScanConnectors(old.connectors, file.connectors) } : {}),
      ...(old.matchingCoverageTruncated || file.matchingCoverageTruncated ? { matchingCoverageTruncated: true } : {}),
      warnings: [...new Set([...(old.warnings ?? []), ...(file.warnings ?? [])])],
      ...(observations.size ? { observations: [...observations.values()] } : {}) });
  }
  const entryKey = (entry: DownloadPlanEntrypoint) => [entry.kind, entry.layerId ?? "", entry.tileId ?? "",
    entry.url ?? entry.sourceUri ?? entry.sourceUrl ?? entry.mocUrl ?? "", entry.product ?? entry.productId ?? ""].join(":");
  const entrypoints = new Map(previous.entrypoints.map((entry) => [entryKey(entry), entry]));
  next.entrypoints.forEach((entry) => {
    const key = entryKey(entry), old = entrypoints.get(key);
    entrypoints.set(key, old ? { ...mergeOrderSafeMembership(old, entry, "cells"), precision: conservativePrecision(old.precision, entry.precision),
      note: joinUnique([old.note, entry.note]) || undefined } : entry);
  });
  const spatialUnits = new Map((previous.spatialUnits ?? []).map((unit) => [`${unit.layerId}:${unit.unitKind}:${unit.unitId}`, unit]));
  (next.spatialUnits ?? []).forEach((unit) => {
    const key = `${unit.layerId}:${unit.unitKind}:${unit.unitId}`, old = spatialUnits.get(key);
    if (!old) { spatialUnits.set(key, unit); return; }
    const scannedFiles = new Map<string, NonNullable<DownloadPlanSpatialUnit["scannedFiles"]>[number]>();
    for (const file of [...(old.scannedFiles ?? []), ...(unit.scannedFiles ?? [])]) {
      const key = `${file.fileId}:${file.scanRunId ?? ""}`, existing = scannedFiles.get(key);
      const matches = new Map([...(existing?.matchingCoverage ?? []), ...(file.matchingCoverage ?? [])].map(match => [matchKey(match), match]));
      scannedFiles.set(key, { ...existing, ...file, ...(matches.size ? { matchingCoverage: [...matches.values()] } : {}),
        ...(existing?.matchingEvidenceScope === "batch" || file.matchingEvidenceScope === "batch" ? { matchingEvidenceScope: "batch" as const } : {}),
        ...(existing?.connectors?.length || file.connectors?.length ? { connectors: mergeScanConnectors(existing?.connectors, file.connectors) } : {}) });
    }
    const accessUris = mergeAccessUris(old.accessUris, old.accessUri && !old.accessUris?.some(entry => entry.uri === old.accessUri) ? [{ uri: old.accessUri }] : undefined,
      unit.accessUris, unit.accessUri && !unit.accessUris?.some(entry => entry.uri === unit.accessUri) ? [{ uri: unit.accessUri }] : undefined);
    spatialUnits.set(key, { ...mergeOrderSafeMembership(old, unit, "matchingCells"), precision: conservativePrecision(old.precision, unit.precision),
      ...(old.memberCompleteness === "incomplete" || unit.memberCompleteness === "incomplete" ? { memberCompleteness: "incomplete" as const }
        : old.memberCompleteness === "unit-candidate" || unit.memberCompleteness === "unit-candidate" ? { memberCompleteness: "unit-candidate" as const } : {}),
      ...(old.matchingEvidenceScope === "batch" || unit.matchingEvidenceScope === "batch" ? { matchingEvidenceScope: "batch" as const } : {}),
      note: joinUnique([old.note, unit.note]) || undefined,
      ...(scannedFiles.size ? { scannedFiles: [...scannedFiles.values()] } : {}),
      ...(accessUris.length ? { accessUri: old.accessUri ?? unit.accessUri ?? accessUris[0]?.uri, accessUris } : {}),
      ...(old.sourceMetadata || unit.sourceMetadata ? { sourceMetadata: mergeSpatialSourceMetadata(old.sourceMetadata, unit.sourceMetadata) } : {}) });
  });
  const coverage = new Map((previous.coverageEvidence ?? []).map((evidence) => [`${evidence.layerId}:${evidence.order}`, evidence]));
  (next.coverageEvidence ?? []).forEach((evidence) => {
    const key = `${evidence.layerId}:${evidence.order}`, old = coverage.get(key);
    if (!old) { coverage.set(key, evidence); return; }
    const completeness = old.completeness === "incomplete" || evidence.completeness === "incomplete" ? "incomplete"
      : old.completeness === "unknown" || evidence.completeness === "unknown" ? "unknown"
        : old.completeness ?? evidence.completeness;
    const scienceFileScan = old.scienceFileScan === "not-scanned" || evidence.scienceFileScan === "not-scanned" ? "not-scanned"
      : old.scienceFileScan === "partial" || evidence.scienceFileScan === "partial" ? "partial"
        : old.scienceFileScan ?? evidence.scienceFileScan;
    coverage.set(key, { ...old, ...evidence, matchedCells: unionNumbers(old.matchedCells, evidence.matchedCells),
      availableOrders: unionNumbers(old.availableOrders, evidence.availableOrders),
      precision: old.precision === "estimated" || evidence.precision === "estimated" ? "estimated" : "exact",
      ...(completeness ? { completeness } : {}), ...(scienceFileScan ? { scienceFileScan } : {}),
      summary: joinUnique([old.summary, evidence.summary]) });
  });
  const tileSelections = new Map((previous.tileSelections ?? []).map((selection) => [selection.layerId, selection]));
  (next.tileSelections ?? []).forEach((selection) => {
    const old = tileSelections.get(selection.layerId);
    tileSelections.set(selection.layerId, old ? { ...old, ...selection,
      tileIds: [...new Set([...old.tileIds, ...selection.tileIds])].sort(),
      complete: old.complete && selection.complete,
      note: joinUnique([old.note, selection.note]) } : selection);
  });
  const scanScopes = new Map([...(previous.scanScopes ?? []), ...(next.scanScopes ?? [])].map((scope) =>
    [`${scope.layerId}:${scope.scopeId}:${scope.scopeSnapshotSha256}`, scope]));
  return {
    ...previous,
    ...next,
    spatialUnits: [...spatialUnits.values()],
    files: [...files.values()],
    entrypoints: [...entrypoints.values()],
    ...(previous.coverageEvidence || next.coverageEvidence ? { coverageEvidence: [...coverage.values()] } : {}),
    ...(previous.tileSelections || next.tileSelections ? { tileSelections: [...tileSelections.values()] } : {}),
    ...(previous.scanScopes || next.scanScopes ? { scanScopes: [...scanScopes.values()] } : {}),
    truncated: next.truncated,
    warnings: [...new Set([...previous.warnings, ...next.warnings])],
  };
}

export interface DownloadQueryRegion extends SkyRegion {
  hash: string;
  rectangle?: SkyRectangle;
  cover?: SkyRegionCoverMetadata;
}

export interface DownloadComponent {
  id: string;
  // Legacy presentation fields; requested.region is authoritative for region queries.
  order: number;
  cells: number[];
  bounds: { areaDeg2: number; raMin: number; raMax: number; decMin: number; decMax: number };
  requested?: { layerIds?: string[]; order?: number; cells?: number[]; rectangle?: SkyRectangle; inputRectangle?: SkyRectangle; region?: DownloadQueryRegion };
  sourceStatuses?: Array<Record<string, unknown> & { layerId?: string }>;
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
  "file_observations", "scan_scopes", "matching_coverage_truncated", "access_uris", "access_availability",
  "s_region", "query_snapshot_id", "omitted", "has_more", "inventory_complete", "native_unit_index_revision",
  "geometry_evidence",
  "native_partition", "source_metadata",
  "matching_regions", "query_region", "query_rectangle", "region_hash", "coordinate_frame", "ordering", "region_cover", "region_approximation",
  "region_budget_limited", "region_target_boundary_order", "region_order_counts", "region_unresolved_boundary_leaves", "region_max_unresolved_angular_radius_deg",
  "rectangle_area_deg2", "cover_area_deg2", "excess_area_deg2", "source_status", "member_completeness", "matching_evidence_scope", "query_input_rectangle",
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
  state?: { snapshotId?: string; nativeUnitIndexRevision?: string; omitted: number; hasMore: boolean },
): string[][] {
  const rows: string[][] = [];
  const region = component.requested?.region;
  const rectangle = component.requested?.rectangle ?? region?.rectangle;
  const queryRegions = region ? groupMatchingRegions(region.cells.map(cell => ({ order: cell.order, cells: [cell.ipix] }))) : undefined;
  const sourceRows = new Map<string[], Record<string, unknown>>();
  const evidenceRows = new Map<string[], DownloadPlanCoverageEvidence>();
  const entryRows = new Map<string[], DownloadPlanEntrypoint>();
  const text = (value: unknown): string => value == null ? "" : String(value);
  const membershipColumns = (regions: DownloadMatchingRegion[], nside?: number): string[] => regions.length === 1
    ? [String(regions[0]!.order), String(nside ?? 2 ** regions[0]!.order), JSON.stringify(regions[0]!.cells)] : ["", "", ""];
  (plan.spatialUnits ?? []).forEach((unit) => {
    const membership = membershipColumns(matchingRegionsFor(unit, unit.matchingCells));
    rows.push([
      component.id, "spatial-unit", membership[0]!, membership[1]!, unit.precision,
      unit.layerId, unit.surveyId, unit.releaseId, unit.product, unit.modality ?? "",
      "", "", "", "", unit.accessUri ?? "", "", unit.accessUri ?? "", membership[2]!, "", unit.unitKind,
      unit.unitId, unit.accessUri ?? "", "", "", "", "", "",
      String(component.bounds.raMin), String(component.bounds.raMax), String(component.bounds.decMin), String(component.bounds.decMax), String(component.bounds.areaDeg2), unit.note ?? "",
      "", "", "", "", "", "", "", "", "", "", unit.sourceSnapshotSha256 ?? "", "", unit.scannedFiles?.length ? JSON.stringify(unit.scannedFiles) : "",
    ]);
  });
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
    const membership = region ? membershipColumns(groupMatchingRegions(file.matchingCoverage.map(match => ({ order: match.order, cells: [match.ipix] }))))
      : [String(component.order), String(2 ** component.order)];
    rows.push([
      component.id, "file", membership[0]!, membership[1]!, precision,
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
    const regions = matchingRegionsFor({ ...entry, order: entry.order ?? (region ? undefined : component.order) }, entry.cells ?? (region ? undefined : component.cells));
    const membership = membershipColumns(regions, entry.matchingRegions === undefined ? entry.nside : undefined);
    const row = [
      component.id, itemKind, membership[0]!, membership[1]!, entry.precision,
      entry.layerId ?? "", entry.surveyId ?? layer.surveyId, entry.releaseId ?? layer.releaseId, entry.product ?? layer.product, layer.modality,
      "", "", "", "", entry.sourceUri ?? "", "", "", membership[2]!, "", entry.kind,
      typeof entry.tileId === "string" ? entry.tileId : "", entry.url ?? entry.sourceUrl ?? entry.mocUrl ?? "", entry.sourceScope ?? "",
      entry.required === undefined ? "" : String(entry.required), entry.selectionComplete === undefined ? (tileSelection ? String(tileSelection.complete) : "") : String(entry.selectionComplete),
      entry.selectionRule ?? tileSelection?.selectionRule ?? "", tileSelection ? JSON.stringify(tileSelection.tileIds) : "",
      String(component.bounds.raMin), String(component.bounds.raMax), String(component.bounds.decMin), String(component.bounds.decMax), String(component.bounds.areaDeg2), entry.note ?? "",
    ];
    rows.push(row);
    entryRows.set(row, entry);
  });
  (plan.coverageEvidence ?? []).forEach((evidence) => {
    const row = [
      component.id, "coverage-evidence", String(evidence.order), String(evidence.nside), evidence.precision,
      evidence.layerId, evidence.surveyId, evidence.releaseId, evidence.product, evidence.modality ?? "",
      "", "", "", "", "", "", "", JSON.stringify(evidence.matchedCells), "", evidence.evidenceKind,
      "", evidence.coverageUrl ?? "", "", "", "", "", "",
      String(component.bounds.raMin), String(component.bounds.raMax), String(component.bounds.decMin), String(component.bounds.decMax), String(component.bounds.areaDeg2), evidence.summary,
      evidence.evidenceKind, evidence.sourceLabel ?? "", evidence.sourceUrl ?? "", evidence.geometrySourceUrl ?? "", evidence.coverageUrl ?? "", JSON.stringify(evidence.availableOrders),
      String(evidence.nativeMaxOrder), evidence.sourceIdentity ?? "", evidence.instrument ?? "", evidence.filters ?? "", evidence.sourceSnapshotSha256 ?? "", evidence.completeness ?? "", evidence.scienceFileScan ?? "",
    ];
    rows.push(row);
    evidenceRows.set(row, evidence);
  });
  for (const source of component.sourceStatuses ?? []) {
    const layer = resolveLayer(source.layerId);
    const row = Array<string>(OVERLAP_DOWNLOAD_HEADER.length).fill("");
    const set = (key: typeof OVERLAP_DOWNLOAD_HEADER[number], value: unknown) => { row[OVERLAP_DOWNLOAD_HEADER.indexOf(key)] = text(value); };
    set("component_id", component.id);
    set("item_kind", "source-status");
    set("layer_id", source.layerId);
    set("survey_id", source.surveyId ?? layer.surveyId);
    set("release_id", source.releaseId ?? layer.releaseId);
    set("product", source.product ?? layer.product);
    set("modality", source.modality ?? layer.modality);
    set("precision", source.precision ?? source.geometryPrecision ?? fallbackPrecision);
    set("access_availability", source.accessAvailability);
    set("completeness", source.completeness);
    set("source_snapshot_sha256", source.sourceSnapshotSha256);
    set("source_identity", source.sourceIdentity);
    set("source_url", source.sourceUrl);
    set("entrypoint_url", source.url ?? source.sourceUrl);
    set("inventory_complete", source.inventoryComplete ?? false);
    set("notes", joinUnique([typeof source.reason === "string" ? source.reason : undefined,
      typeof source.note === "string" ? source.note : undefined,
      ...(Array.isArray(source.notes) ? source.notes.filter((note): note is string => typeof note === "string") : [])]));
    set("source_status", JSON.stringify(source));
    sourceRows.set(row, source);
    rows.push(row);
  }
  if (state || region || rectangle) {
    const row = Array<string>(OVERLAP_DOWNLOAD_HEADER.length).fill("");
    row[0] = component.id; row[1] = "manifest-state";
    row[OVERLAP_DOWNLOAD_HEADER.indexOf("precision")] = plan.truncated ? "truncated" : fallbackPrecision;
    row[OVERLAP_DOWNLOAD_HEADER.indexOf("notes")] = plan.warnings.join("; ");
    row[OVERLAP_DOWNLOAD_HEADER.indexOf("query_snapshot_id")] = state?.snapshotId ?? "";
    row[OVERLAP_DOWNLOAD_HEADER.indexOf("omitted")] = text(state?.omitted);
    row[OVERLAP_DOWNLOAD_HEADER.indexOf("has_more")] = text(state?.hasMore);
    row[OVERLAP_DOWNLOAD_HEADER.indexOf("inventory_complete")] = "false";
    rows.push(row);
  }
  const filesById = new Map(plan.files.map(file => [file.fileId, file]));
  const unitsById = new Map((plan.spatialUnits ?? []).map(unit => [JSON.stringify([unit.layerId, unit.unitKind, unit.unitId]), unit]));
  return rows.map((row) => {
    const padded = [...row, ...Array(Math.max(0, OVERLAP_DOWNLOAD_HEADER.length - row.length)).fill("")];
    const file = row[1] === "file" ? filesById.get(row[10] ?? "") : undefined;
    const unit = row[1] === "spatial-unit" ? unitsById.get(JSON.stringify([row[5], row[19], row[20]])) : undefined;
    const entry = entryRows.get(row);
    const evidence = evidenceRows.get(row);
    const source = sourceRows.get(row);
    const set = (key: typeof OVERLAP_DOWNLOAD_HEADER[number], value: unknown) => { padded[OVERLAP_DOWNLOAD_HEADER.indexOf(key)] = text(value); };
    let matchingRegions: DownloadMatchingRegion[] | undefined;
    if (unit) matchingRegions = matchingRegionsFor(unit, unit.matchingCells);
    else if (file) matchingRegions = groupMatchingRegions(file.matchingCoverage.map(match => ({ order: match.order, cells: [match.ipix] })));
    else if (entry) matchingRegions = matchingRegionsFor({ ...entry, order: entry.order ?? (region ? undefined : component.order) }, entry.cells ?? (region ? undefined : component.cells));
    else if (evidence) matchingRegions = [{ order: evidence.order, cells: unionNumbers(evidence.matchedCells) }];
    else if (source) {
      if (Array.isArray(source.matchingRegions)) matchingRegions = groupMatchingRegions(source.matchingRegions as DownloadMatchingRegion[]);
      else if (typeof source.order === "number" && Array.isArray(source.cells)) matchingRegions = [{ order: source.order, cells: unionNumbers(source.cells as number[]) }];
      const membership = membershipColumns(matchingRegions ?? []);
      set("order", membership[0]); set("nside", membership[1]); set("matching_cells", membership[2]);
    } else if (row[1] === "manifest-state") matchingRegions = queryRegions;
    if (matchingRegions) set("matching_regions", JSON.stringify(matchingRegions));
    if (region) {
      set("query_region", JSON.stringify(region));
      set("region_hash", region.hash);
      set("coordinate_frame", region.coordinateFrame);
      set("ordering", region.ordering);
    }
    if (component.requested?.inputRectangle) set("query_input_rectangle", JSON.stringify(component.requested.inputRectangle));
    if (rectangle) {
      set("query_rectangle", JSON.stringify(rectangle));
      set("ra_min_deg", rectangle.raStart); set("ra_max_deg", rectangle.raEnd);
      set("dec_min_deg", rectangle.decMin); set("dec_max_deg", rectangle.decMax);
    }
    const cover = region?.cover;
    if (cover || rectangle) set("region_approximation", "conservative");
    if (cover) {
      set("region_cover", JSON.stringify(cover));
      set("region_budget_limited", cover.budgetLimited);
      set("region_target_boundary_order", cover.targetBoundaryOrder);
      set("region_order_counts", JSON.stringify(cover.orderCounts));
      set("region_unresolved_boundary_leaves", cover.unresolvedBoundaryLeaves);
      set("region_max_unresolved_angular_radius_deg", cover.maxUnresolvedAngularRadiusDeg);
      set("rectangle_area_deg2", cover.rectangleAreaDeg2);
      set("cover_area_deg2", cover.coverAreaDeg2);
      set("excess_area_deg2", cover.excessAreaDeg2);
      set("area_deg2", cover.rectangleAreaDeg2);
    }
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("native_unit_index_revision")] = state?.nativeUnitIndexRevision ?? "";
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("file_observations")] = file?.observations?.length
      ? JSON.stringify(file.observations)
      : unit?.scannedFiles?.length ? JSON.stringify(unit.scannedFiles) : "";
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("scan_scopes")] = plan.scanScopes?.length ? JSON.stringify(plan.scanScopes) : "";
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("matching_coverage_truncated")] = file?.matchingCoverageTruncated === undefined ? "" : String(file.matchingCoverageTruncated);
    padded[OVERLAP_DOWNLOAD_HEADER.indexOf("access_uris")] = unit?.accessUris?.length ? JSON.stringify(unit.accessUris) : "";
    if (unit) {
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("access_availability")] = unit.accessAvailability ?? "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("member_completeness")] = unit.memberCompleteness ?? "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("matching_evidence_scope")] = unit.matchingEvidenceScope ?? "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("s_region")] = unit.sRegion ?? "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("instrument")] = unit.instrument ?? "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("filters")] = unit.filters ?? "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("source_url")] = unit.sourceUrl ?? "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("geometry_source_url")] = joinUnique(unit.geometryEvidence?.map(evidence => evidence.sourceUrl) ?? []);
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("geometry_evidence")] = unit.geometryEvidence?.length ? JSON.stringify(unit.geometryEvidence) : "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("native_partition")] = unit.nativePartition ? JSON.stringify(unit.nativePartition) : "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("source_metadata")] = unit.sourceMetadata ? JSON.stringify(unit.sourceMetadata) : "";
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("science_file_scan")] = "";
    }
    if (file) {
      padded[OVERLAP_DOWNLOAD_HEADER.indexOf("source_snapshot_sha256")] = joinUnique(file.matchingCoverage.map(match => match.sourceSnapshotSha256));
      if (file.connectors?.length) padded[OVERLAP_DOWNLOAD_HEADER.indexOf("source_metadata")] = JSON.stringify({ connectors: file.connectors });
    }
    return padded;
  });
}

export function overlapCsvDocument(rows: string[][]): string {
  return [OVERLAP_DOWNLOAD_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
