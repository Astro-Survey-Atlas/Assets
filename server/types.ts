export type PublicAssetKind = "package" | "package-collection" | "moc" | "geometry" | "manifest" | "ledger" | "documentation" | "provenance" | "metadata" | "sdk";

export interface PublicAssetRecord {
  id: string;
  kind: PublicAssetKind;
  label: string;
  description: string;
  path: string;
  downloadName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  version?: string;
  sourceUrl?: string;
  deliveryClass?: "runtime" | "evidence";
}

/**
 * Infer the delivery boundary from a release record. Evidence-class source
 * material (raw scans, job snapshots, run statistics, provenance, ledgers)
 * must never be promoted to the public runtime class by a stale or
 * hand-edited manifest. Official upstream survey inventories that runtime
 * features read directly (DESI tile tables) are the only raw-path carve-out.
 */
export function inferredPublicAssetDeliveryClass(record: Pick<PublicAssetRecord, "path"> & Partial<Pick<PublicAssetRecord, "kind">>): "runtime" | "evidence" {
  const normalizedPath = record.path.replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)desi-(dr1-tiles-iron|edr-tiles-fuji)\.fits$/.test(normalizedPath)) return "runtime";
  if (/(^|\/)(raw|evidence)(\/|$)/.test(normalizedPath)
    || /(?:input-manifest|normalized-scan|task-snapshot|coverage-job-snapshot|wcs-geometry-summary|scan[-_]error|run-statistics|sample-report)/.test(normalizedPath)
    || record.kind === "provenance" || record.kind === "ledger") return "evidence";
  return "runtime";
}

export type PublicAssetPreviewMode = "text" | "image";

export type PublicAssetProjection = Omit<PublicAssetRecord, "path"> & {
  downloadUrl: string;
  previewUrl?: string;
  previewMode?: PublicAssetPreviewMode;
};

export interface PublicAssetManifest {
  schemaVersion: 1;
  generatedAt: string;
  bundle: {
    id: string;
    sha256: string;
  };
  statistics: {
    releases: number;
    products: number;
    acquired: number;
    overviewOnly: number;
    awaitingGeometry: number;
    footprints: number;
    packages: number;
    rawMocFiles: number;
    totalBytes: number;
    runtimeBytes?: number;
    evidenceBytes?: number;
  };
  files: PublicAssetRecord[];
}

export type PublicSurveyModality = "imaging" | "spectroscopy" | "photometry" | "time-domain" | "integral-field" | "ultraviolet" | "infrared" | "catalog" | "simulation";
export type PublicProductStatus = "acquired" | "overview_only" | "awaiting_geometry" | "not_applicable";

export interface PublicCoverageOrders {
  availableOrders: number[];
  overviewOrder: number;
  maxOrder: number;
  layerId?: string;
  coverageRole?: "image_extent" | "object_presence" | "footprint_extent";
  areaDeg2?: number;
}

export interface PublicCoverageOrderSummary {
  availableOrders: number[];
  overviewOrders: number[];
  maxOrder: number | null;
}

/**
 * Public, evidence-backed readiness projection.  The public API exposes the
 * same capability level as the control room, but never includes raw manifests
 * or execution payloads.  Counts are intentionally optional because an
 * unknown denominator must remain unknown rather than becoming zero.
 */
export interface PublicProductReadiness {
  schemaVersion: 1;
  level: -1 | 0 | 1 | 2 | 3;
  label: "needs-information" | "source-registered" | "coverage-queryable" | "unit-reversible" | "file-locatable";
  geometry: {
    orders: number[];
    maxOrder?: number;
    precision: "exact" | "estimated" | "entrypoint-only" | "unknown";
    basis: "layer" | "entrypoint" | "none";
    coordinateFrame?: string;
    ordering?: string;
  };
  reverseLookup: {
    level: -1 | 0 | 1 | 2 | 3;
    orders: number[];
    precision: "exact" | "estimated" | "entrypoint-only" | "unknown";
    unitKind?: string;
    basis: "file" | "unit" | "entrypoint" | "none";
  };
  completeness: {
    state: "complete" | "partial" | "unknown";
    processed?: number;
    total?: number;
    asOf?: string;
    scope?: string;
  };
  evidence: {
    inputLocked: boolean;
    executionRecorded: boolean;
    outputValidated: boolean;
    isolatedRestoreValidated: boolean;
  };
  gaps: string[];
}

export interface PublicReadinessAggregate {
  productCount: number;
  levelCounts: { L0: number; L1: number; L2: number; L3: number; needsInformation: number };
  capabilityCounts: { coverage: number; unit: number; file: number };
  geometryOrders: number[];
  reverseLookupOrders: number[];
  geometryPrecision: "exact" | "estimated" | "entrypoint-only" | "unknown" | "mixed";
  reverseLookupPrecision: "exact" | "estimated" | "entrypoint-only" | "unknown" | "mixed";
  completeness: { complete: number; partial: number; unknown: number };
  gapCount: number;
}

export interface PublicSurveyProduct {
  productId?: string;
  name: string;
  modality: PublicSurveyModality;
  description: string;
  status: PublicProductStatus;
  sourceUrl: string;
  dataOrigin?: "observed" | "simulated" | "catalog";
  sourceTier?: "official_geometry" | "official_inventory_derived" | "third_party_moc" | "best_effort_derived" | "user_file_derived";
  originNote?: string;
  sourceLabel?: string;
  geometrySourceUrl?: string;
  geometrySourceLabel?: string;
  officialDataUrl?: string;
  officialDataLabel?: string;
  officialQueryUrl?: string;
  officialQueryLabel?: string;
  reason?: string;
  manualStep?: string;
  coverage?: PublicCoverageOrders;
  readiness?: PublicProductReadiness;
  detailUrl?: string;
  evidenceUrl?: string;
  links?: PublicProductLink[];
}

export type PublicProductLinkKind = "official-release" | "official-query" | "official-data" | "geometry-source" | "fits-moc" | "coverage-preview" | "resource-package" | "provenance";

export interface PublicProductLink {
  kind: PublicProductLinkKind;
  label: string;
  url: string;
  description?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
}

/**
 * Human-facing aggregate for a published product.  The product list keeps its
 * historical fields for existing clients; this shape is used by the detail
 * and evidence endpoints so consumers do not need to join several JSON
 * documents themselves.
 */
export type PublicProductVerificationStatus = "complete" | "partial" | "entrypoint-only";

export type PublicEvidenceItemKind = "official-release" | "official-data" | "official-query" | "coverage-input" | "raw-moc" | "snapshot" | "code" | "artifact" | "note";
export type PublicEvidenceItemVisibility = "public" | "evidence-only" | "unavailable";
export type PublicDerivationStepStatus = "available" | "partial" | "unavailable";

export interface PublicProductEvidenceItem {
  kind: PublicEvidenceItemKind;
  label: string;
  description: string;
  visibility: PublicEvidenceItemVisibility;
  url?: string;
  filename?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  reason?: string;
}

export interface PublicProductCodeEvidence {
  language: "python" | "typescript";
  snippet: string;
  implementationRef: string;
  /** This snippet documents the method; it is never an execution receipt. */
  classification: "method-explanation";
}

export interface PublicProductDerivationStep {
  sequence: number;
  id: string;
  title: string;
  purpose: string;
  inputs: PublicProductEvidenceItem[];
  method: { libraries: string[]; implementationRef: string };
  code?: PublicProductCodeEvidence;
  outputs: PublicProductEvidenceItem[];
  status: PublicDerivationStepStatus;
  reason?: string;
}

export interface PublicProductDossier {
  schemaVersion: 1;
  identity: {
    productId: string;
    surveyId: string;
    releaseId: string;
    name: string;
    modality?: string;
    dataOrigin?: "observed" | "simulated" | "catalog";
    sourceTier?: "official_geometry" | "official_inventory_derived" | "third_party_moc" | "best_effort_derived" | "user_file_derived";
  };
  /** Published editorial copy shown on the public product page. */
  description?: string;
  reason?: string;
  manualStep?: string;
  conclusion: {
    status: PublicProductVerificationStatus;
    summary: string;
    coverageAvailable: boolean;
  };
  /** Published-version capability summary; raw execution records stay private. */
  readiness: PublicProductReadiness;
  coverage: {
    available: boolean;
    layerId?: string;
    coordinateFrame: "ICRS";
    ordering: "NESTED";
    coverageRole?: "image_extent" | "object_presence" | "footprint_extent";
    availableOrders: number[];
    overviewOrder?: number;
    maxOrder?: number;
    cellCount?: number;
    cellCounts?: Record<string, number>;
    areaDeg2?: number;
    precision: "exact" | "estimated" | "entrypoint-only" | "truncated";
    mocUrl?: string;
    previewUrl?: string;
  };
  source: {
    label?: string;
    url?: string;
    geometryLabel?: string;
    geometryUrl?: string;
    snapshot?: { uri?: string; sha256?: string; sizeBytes?: number };
    references?: PublicProductEvidenceItem[];
  };
  derivation: {
    mode?: string;
    coordinateFrame: "ICRS";
    ordering: "NESTED";
    coverageRole?: "image_extent" | "object_presence" | "footprint_extent";
    availableOrders: number[];
    steps: PublicProductDerivationStep[];
  };
  verification: {
    status: PublicProductVerificationStatus;
    checks: Array<{ id: string; label: string; status: "passed" | "warning" | "unavailable"; detail?: string }>;
    outputHashes: Array<{ kind: string; sha256: string; url?: string }>;
  };
  limitations: string[];
  actions: {
    official?: PublicProductLink;
    query?: PublicProductLink;
    data?: PublicProductLink;
    view?: PublicProductLink;
  };
  technicalDownloads: PublicProductLink[];
  /** Stable links are repeated here for clients that do not inspect actions. */
  links: PublicProductLink[];
  evidenceUrl: string;
}

export interface PublicSurveyRelease {
  id: string;
  label: string;
  kind: string;
  releasedYear?: number;
  modalities: PublicSurveyModality[];
  products: PublicSurveyProduct[];
  coverageOrders?: PublicCoverageOrderSummary;
  readiness?: PublicReadinessAggregate;
}

export interface PublicSurveyRecord {
  id: string;
  name: string;
  mission: string;
  color: string;
  description: string;
  modalities: PublicSurveyModality[];
  releases: PublicSurveyRelease[];
  coverageOrders?: PublicCoverageOrderSummary;
  readiness?: PublicReadinessAggregate;
}

export interface PublicSurveyCatalog {
  schemaVersion: 1;
  generatedAt: string;
  surveys: PublicSurveyRecord[];
}
