/**
 * Operator-facing readiness is derived from the artifacts and checks that are
 * actually available for one Product version.  This module deliberately has
 * no HTTP, Kubernetes, or filesystem dependencies so the rules can be tested
 * without booting the Assets server.
 */

/** -1 means below L0 (the product identity/source is not yet traceable). */
export type ReadinessLevel = -1 | 0 | 1 | 2 | 3;
export type ReadinessPrecision = "exact" | "estimated" | "entrypoint-only" | "unknown";
export type CompletenessState = "complete" | "partial" | "unknown";

export interface ReadinessProductContent {
  productId: string;
  surveyId: string;
  releaseId: string;
  name: string;
  mode?: string;
  sourceTier?: string;
  sourceUrl?: string;
  sourceLabel?: string;
  geometrySourceUrl?: string;
  geometrySourceLabel?: string;
  recipeHash?: string;
}

export interface ReadinessLayer {
  availableOrders: number[];
  overviewOrder: number;
  maxOrder: number;
  cellCount?: number;
  recipe?: {
    mode?: string;
    coordinateFrame?: string;
    ordering?: string;
    sourceSnapshotSha256?: string;
  };
  sourceUnitIndex?: {
    status: "exact" | "estimated" | "entrypoint-only";
    unitKind?: string;
    notes?: string;
  };
  fileCount?: number;
  coverageCount?: number;
  errorCount?: number;
  updatedAt?: string;
}

export interface ReadinessBuild {
  phase?: string;
  source?: { snapshotSha256?: string };
  outputs?: { availableOrders?: number[]; maxOrder?: number };
  publicationId?: string;
}

export interface ReadinessEvidenceInput {
  executionRecorded?: boolean;
  outputValidated?: boolean;
  isolatedRestoreValidated?: boolean;
}

export interface ReadinessCompletenessInput {
  state: CompletenessState;
  processed?: number;
  total?: number;
  asOf?: string;
  scope?: string;
}

export interface ProductReadiness {
  schemaVersion: 1;
  level: ReadinessLevel;
  label: "needs-information" | "source-registered" | "coverage-queryable" | "unit-reversible" | "file-locatable";
  geometry: {
    orders: number[];
    maxOrder?: number;
    precision: ReadinessPrecision;
    basis: "layer" | "entrypoint" | "none";
    coordinateFrame?: string;
    ordering?: string;
  };
  reverseLookup: {
    level: ReadinessLevel;
    orders: number[];
    precision: ReadinessPrecision;
    unitKind?: string;
    basis: "file" | "unit" | "entrypoint" | "none";
  };
  completeness: ReadinessCompletenessInput;
  evidence: {
    inputLocked: boolean;
    executionRecorded: boolean;
    outputValidated: boolean;
    isolatedRestoreValidated: boolean;
  };
  gaps: string[];
}

export interface ProductReadinessInput {
  content: ReadinessProductContent;
  layer?: ReadinessLayer;
  build?: ReadinessBuild;
  evidence?: ReadinessEvidenceInput;
  completeness?: ReadinessCompletenessInput;
}

export interface ReadinessAggregate {
  productCount: number;
  levelCounts: { L0: number; L1: number; L2: number; L3: number; needsInformation: number };
  capabilityCounts: { coverage: number; unit: number; file: number };
  geometryOrders: number[];
  reverseLookupOrders: number[];
  geometryPrecision: ReadinessPrecision | "mixed";
  reverseLookupPrecision: ReadinessPrecision | "mixed";
  completeness: { complete: number; partial: number; unknown: number };
  gapCount: number;
}

const LEVEL_LABELS: Record<Exclude<ReadinessLevel, -1>, ProductReadiness["label"]> = {
  0: "source-registered",
  1: "coverage-queryable",
  2: "unit-reversible",
  3: "file-locatable",
};

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validOrders(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((order): order is number => Number.isSafeInteger(order) && order >= 0 && order <= 29))].sort((a, b) => a - b);
}

function geometryPrecision(content: ReadinessProductContent, layer: ReadinessLayer | undefined): ReadinessPrecision {
  if (!layer) return hasText(content.sourceUrl) || hasText(content.geometrySourceUrl) ? "entrypoint-only" : "unknown";
  // Public MOC extents preserve a useful spatial query but do not establish a
  // per-exposure or depth mask.  Their limitation is part of the product
  // contract, so expose that distinction instead of calling every layer exact.
  if (content.mode === "native-moc" || layer.recipe?.mode === "native-moc" || content.sourceTier === "third_party_moc") return "estimated";
  return "exact";
}

function completenessFor(input: ProductReadinessInput, layer: ReadinessLayer | undefined): ReadinessCompletenessInput {
  if (input.completeness) return { ...input.completeness };
  if (layer?.errorCount && layer.errorCount > 0) {
    return { state: "partial", ...(layer.updatedAt ? { asOf: layer.updatedAt } : {}), scope: "current layer" };
  }
  // A processed count without a known denominator is useful evidence, but it
  // is not a percentage or a claim that the source was completely enumerated.
  if (layer?.fileCount !== undefined || layer?.coverageCount !== undefined) {
    return { state: "unknown", ...(layer.updatedAt ? { asOf: layer.updatedAt } : {}), scope: "current layer; denominator unavailable" };
  }
  return { state: "unknown" };
}

/** Derive the strongest capability supported by the supplied evidence. */
export function deriveProductReadiness(input: ProductReadinessInput): ProductReadiness {
  const { content, layer, build } = input;
  const sourceTraceable = hasText(content.sourceUrl) || hasText(content.sourceLabel)
    || hasText(content.geometrySourceUrl) || hasText(content.geometrySourceLabel);
  const orders = validOrders(layer?.availableOrders);
  const coordinateFrame = layer?.recipe?.coordinateFrame;
  const ordering = layer?.recipe?.ordering;
  const coverageQueryable = Boolean(layer && orders.length && coordinateFrame === "ICRS" && ordering === "NESTED");
  const unitIndex = layer?.sourceUnitIndex;
  const unitQueryable = Boolean(coverageQueryable && unitIndex && unitIndex.status !== "entrypoint-only" && hasText(unitIndex.unitKind));
  const fileQueryable = Boolean(unitQueryable && unitIndex?.status === "exact" && unitIndex.unitKind?.toLowerCase() === "file");
  const level: ReadinessLevel = !sourceTraceable ? -1 : fileQueryable ? 3 : unitQueryable ? 2 : coverageQueryable ? 1 : 0;
  const geometryBasis: ProductReadiness["geometry"]["basis"] = coverageQueryable ? "layer" : sourceTraceable ? "entrypoint" : "none";
  const reverseBasis: ProductReadiness["reverseLookup"]["basis"] = !sourceTraceable ? "none" : fileQueryable ? "file" : unitQueryable ? "unit" : "entrypoint";
  const reversePrecision: ReadinessPrecision = !sourceTraceable
    ? "unknown"
    : fileQueryable
      ? "exact"
      : unitQueryable
        ? unitIndex!.status
        : "entrypoint-only";
  const inputLocked = hasText(layer?.recipe?.sourceSnapshotSha256) || hasText(build?.source?.snapshotSha256);
  const executionRecorded = input.evidence?.executionRecorded ?? Boolean(fileQueryable || (build && ["STAGED", "PUBLISHED", "DUPLICATE"].includes(String(build.phase).toUpperCase())));
  const outputValidated = input.evidence?.outputValidated ?? Boolean(coverageQueryable && (layer?.cellCount === undefined || layer.cellCount > 0));
  const isolatedRestoreValidated = input.evidence?.isolatedRestoreValidated ?? false;
  const gaps: string[] = [];
  if (!sourceTraceable) gaps.push("source-not-traceable");
  if (!inputLocked) gaps.push("input-snapshot-hash-missing");
  if (!coverageQueryable) gaps.push(sourceTraceable ? "validated-coverage-missing" : "coverage-query-unavailable");
  if (!unitQueryable) gaps.push("source-unit-index-missing");
  if (!fileQueryable) gaps.push("file-level-reverse-index-missing");
  if (!executionRecorded) gaps.push("execution-record-missing");
  if (!outputValidated) gaps.push("output-validation-missing");
  if (!isolatedRestoreValidated) gaps.push("isolated-restore-not-verified");
  const completeness = completenessFor(input, layer);
  if (completeness.state === "unknown") gaps.push("completeness-unknown");
  if (completeness.state === "partial") gaps.push("completeness-partial");
  return {
    schemaVersion: 1,
    level,
    label: level < 0 ? "needs-information" : LEVEL_LABELS[level as Exclude<ReadinessLevel, -1>],
    geometry: {
      orders,
      ...(layer ? { maxOrder: layer.maxOrder } : {}),
      precision: geometryPrecision(content, layer),
      basis: geometryBasis,
      ...(coordinateFrame ? { coordinateFrame } : {}),
      ...(ordering ? { ordering } : {}),
    },
    reverseLookup: {
      level: !sourceTraceable ? -1 : fileQueryable ? 3 : unitQueryable ? 2 : 0,
      orders,
      precision: reversePrecision,
      ...(unitIndex?.unitKind ? { unitKind: unitIndex.unitKind } : {}),
      basis: reverseBasis,
    },
    completeness,
    evidence: { inputLocked, executionRecorded, outputValidated, isolatedRestoreValidated },
    gaps: [...new Set(gaps)],
  };
}

function precisionSummary(values: ReadinessPrecision[]): ReadinessAggregate["geometryPrecision"] {
  const known = [...new Set(values.filter((value) => value !== "unknown"))];
  if (!known.length) return "unknown";
  return known.length === 1 ? known[0]! : "mixed";
}

/** Summarize products without treating the highest product level as the DR level. */
export function aggregateReadiness(entries: readonly ProductReadiness[]): ReadinessAggregate {
  const levelCounts = { L0: 0, L1: 0, L2: 0, L3: 0, needsInformation: 0 };
  const capabilityCounts = { coverage: 0, unit: 0, file: 0 };
  const completeness = { complete: 0, partial: 0, unknown: 0 };
  const geometryOrders = new Set<number>();
  const reverseLookupOrders = new Set<number>();
  const geometryPrecisions: ReadinessPrecision[] = [];
  const reversePrecisions: ReadinessPrecision[] = [];
  let gapCount = 0;
  for (const entry of entries) {
    if (entry.level < 0) levelCounts.needsInformation += 1;
    else levelCounts[`L${entry.level}` as "L0" | "L1" | "L2" | "L3"] += 1;
    if (entry.level >= 1) capabilityCounts.coverage += 1;
    if (entry.level >= 2) capabilityCounts.unit += 1;
    if (entry.level >= 3) capabilityCounts.file += 1;
    entry.geometry.orders.forEach((order) => geometryOrders.add(order));
    entry.reverseLookup.orders.forEach((order) => reverseLookupOrders.add(order));
    geometryPrecisions.push(entry.geometry.precision);
    reversePrecisions.push(entry.reverseLookup.precision);
    completeness[entry.completeness.state] += 1;
    gapCount += entry.gaps.length;
  }
  return {
    productCount: entries.length,
    levelCounts,
    capabilityCounts,
    geometryOrders: [...geometryOrders].sort((a, b) => a - b),
    reverseLookupOrders: [...reverseLookupOrders].sort((a, b) => a - b),
    geometryPrecision: precisionSummary(geometryPrecisions),
    reverseLookupPrecision: precisionSummary(reversePrecisions),
    completeness,
    gapCount,
  };
}
