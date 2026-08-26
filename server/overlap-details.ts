import type { CoverageCellLayer } from "./coverage.js";
import type { WarehouseLayerSnapshot } from "./evidence-store.js";
import type { OverlapComponent, OverlapResult } from "./overlap.js";
import type { PublicSurveyIndex } from "./surveys.js";

export type CoverageClaimKind = "moc" | "tile" | "raw-file" | "overview";
export type DetailPrecision = "exact" | "estimated" | "entrypoint-only" | "truncated";

export interface PublicOverlapSource {
  layerId: string;
  surveyId: string;
  surveyName: string;
  releaseId: string;
  releaseLabel?: string;
  product: string;
  modality?: string;
  description?: string;
  sourceUrl?: string;
  geometrySourceUrl?: string;
  coverageClaim?: { kind: CoverageClaimKind; url?: string; status?: string };
}

export interface WarehouseOverlapEvidence {
  layerId: string;
  surveyId: string;
  releaseId: string;
  productId: string;
  product?: string;
  modality?: string;
  state: "ACTIVE" | "FAILED" | "UNKNOWN";
  scanRunId?: string;
  availableOrders: number[];
  commonOrder: number;
  coverageCells: number;
  fileCount: number;
  coverageCount: number;
  precision: DetailPrecision;
  sourceSnapshotSha256?: string;
  connector: { status: "known" | "unavailable"; name?: string; type?: string };
  method: { summary: string; docsUrl?: string };
}

export interface OverlapDetails {
  schemaVersion: 1;
  component: OverlapComponent;
  publicSources: PublicOverlapSource[];
  warehouseEvidence: WarehouseOverlapEvidence[];
  method: { summary: string; docsUrl?: string };
  reverseLookup: {
    endpoint: string;
    layerIds: string[];
    order: number;
    precision: DetailPrecision;
    deferred: true;
  };
}

const PRIVATE_HOST = /^(?:localhost|127(?:\.|$)|0(?:\.|$)|10(?:\.|$)|192\.168(?:\.|$)|169\.254(?:\.|$)|172\.(?:1[6-9]|2\d|3[0-1])(?:\.|$)|\[?::1\]?$)/i;
const INTERNAL_HOST = /(?:\.local$|\.internal$|\.svc(?:\.|$)|\.cluster\.local$|(?:^|[-.])(minio|elasticsearch|kubernetes)(?:[-.]|$))/i;

/** Keep only URLs that a public browser can safely follow. */
export function publicExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || PRIVATE_HOST.test(parsed.hostname) || INTERNAL_HOST.test(parsed.hostname)) return undefined;
  return parsed.toString();
}

function claimKind(product: string, geometryUrl?: string): CoverageClaimKind {
  const lower = `${product} ${geometryUrl ?? ""}`.toLowerCase();
  if (/\bmoc\b|moc\.fits|moc\.json/.test(lower)) return "moc";
  if (/tile|brick|hips/.test(lower)) return "tile";
  if (/fits|file|archive|download/.test(lower)) return "raw-file";
  return "overview";
}

function detailPrecision(value: string | undefined): DetailPrecision {
  return value === "exact" || value === "estimated" || value === "entrypoint-only" || value === "truncated" ? value : "exact";
}

function selectedLayers(layers: readonly CoverageCellLayer[], result: OverlapResult, component: OverlapComponent): CoverageCellLayer[] {
  const componentCells = new Set(component.cells);
  return layers.filter((layer) => result.surveyIds.includes(layer.surveyId) && Boolean(layer.cells.get(component.order)?.some((cell) => componentCells.has(cell))));
}

function publicSourcesFor(layers: readonly CoverageCellLayer[], surveyIndex: PublicSurveyIndex, result: OverlapResult, component: OverlapComponent): PublicOverlapSource[] {
  const seen = new Set<string>();
  const sources: PublicOverlapSource[] = [];
  for (const layer of selectedLayers(layers, result, component)) {
    const survey = surveyIndex.surveys.find((candidate) => candidate.id === layer.surveyId);
    const release = survey?.releases.find((candidate) => candidate.id === layer.releaseId);
    const product = release?.products.find((candidate) => candidate.name === layer.product);
    const sourceUrl = publicExternalUrl(product?.sourceUrl ?? layer.recipe?.sourceUrl);
    const geometrySourceUrl = publicExternalUrl(product?.geometrySourceUrl);
    const key = `${layer.layerId}:${layer.releaseId}:${layer.product}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      layerId: layer.layerId,
      surveyId: layer.surveyId,
      surveyName: survey?.name ?? layer.surveyId,
      releaseId: layer.releaseId,
      ...(release?.label ? { releaseLabel: release.label } : {}),
      product: product?.name ?? layer.product,
      ...(product?.modality ?? layer.modality ? { modality: product?.modality ?? layer.modality } : {}),
      ...(product?.description ? { description: product.description } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(geometrySourceUrl ? { geometrySourceUrl } : {}),
      coverageClaim: { kind: claimKind(product?.name ?? layer.product, geometrySourceUrl), ...(geometrySourceUrl ? { url: geometrySourceUrl } : sourceUrl ? { url: sourceUrl } : { status: "no-public-geometry-url" }) },
    });
  }
  return sources;
}

function precisionForEvidence(snapshot: WarehouseLayerSnapshot, layer: CoverageCellLayer, component: OverlapComponent): DetailPrecision {
  const cells = layer.cells.get(component.order) ?? [];
  if (!cells.length) return "entrypoint-only";
  return snapshot.state === "ACTIVE" ? "exact" : "entrypoint-only";
}

function warehouseEvidenceFor(
  layers: readonly CoverageCellLayer[],
  result: OverlapResult,
  component: OverlapComponent,
  snapshots: ReadonlyMap<string, WarehouseLayerSnapshot>,
): WarehouseOverlapEvidence[] {
  const componentCells = new Set(component.cells);
  return selectedLayers(layers, result, component)
    .map((layer) => {
      const snapshot = snapshots.get(layer.layerId);
      if (!snapshot) return null;
      const cells = (layer.cells.get(component.order) ?? []).filter((cell) => componentCells.has(cell));
      const precision = precisionForEvidence(snapshot, layer, component);
      return {
        layerId: layer.layerId,
        surveyId: snapshot.surveyId,
        releaseId: snapshot.releaseId,
        productId: snapshot.productId,
        ...(layer.product ? { product: layer.product } : {}),
        ...(snapshot.modality ?? layer.modality ? { modality: snapshot.modality ?? layer.modality } : {}),
        state: snapshot.state === "ACTIVE" ? "ACTIVE" : snapshot.state === "FAILED" ? "FAILED" : "UNKNOWN",
        ...(snapshot.scanRunId ? { scanRunId: snapshot.scanRunId } : {}),
        availableOrders: snapshot.availableOrders,
        commonOrder: component.order,
        coverageCells: cells.length,
        fileCount: snapshot.fileCount,
        coverageCount: snapshot.coverageCount,
        precision,
        ...(snapshot.sourceSnapshotSha256 ? { sourceSnapshotSha256: snapshot.sourceSnapshotSha256 } : {}),
        connector: { status: "unavailable" },
        method: {
          summary: layer.recipe?.steps.map((step) => step.title).join(" -> ") || "Warehouse ACTIVE layer with explicit ICRS/NESTED coverage edges.",
          docsUrl: "/api/v1/coverage/catalog",
        },
      } satisfies WarehouseOverlapEvidence;
    })
    .filter((entry): entry is WarehouseOverlapEvidence => Boolean(entry));
}

export function buildOverlapDetails(input: {
  result: OverlapResult;
  component: OverlapComponent;
  layers: readonly CoverageCellLayer[];
  surveyIndex: PublicSurveyIndex;
  warehouseSnapshots?: ReadonlyMap<string, WarehouseLayerSnapshot>;
}): OverlapDetails {
  const warehouseEvidence = warehouseEvidenceFor(input.layers, input.result, input.component, input.warehouseSnapshots ?? new Map());
  const precisions = warehouseEvidence.map((entry) => entry.precision);
  const precision: DetailPrecision = precisions.includes("truncated")
    ? "truncated"
    : precisions.includes("estimated")
      ? "estimated"
      : precisions.includes("exact")
        ? "exact"
        : "entrypoint-only";
  const layerIds = warehouseEvidence.map((entry) => entry.layerId);
  const method = {
    summary: "Intersect explicit ICRS/NESTED cells at the highest real common order, then label side-connected components.",
    docsUrl: "/api/v1/coverage/catalog",
  };
  return {
    schemaVersion: 1,
    component: input.component,
    publicSources: publicSourcesFor(input.layers, input.surveyIndex, input.result, input.component),
    warehouseEvidence,
    method,
    reverseLookup: { endpoint: "/api/v1/coverage/reverse-lookup", layerIds, order: input.component.order, precision, deferred: true },
  };
}
