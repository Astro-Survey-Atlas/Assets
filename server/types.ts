export type PublicAssetKind = "package" | "moc" | "geometry" | "manifest" | "ledger" | "documentation" | "provenance" | "metadata" | "sdk";

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
}

export interface PublicCoverageOrderSummary {
  availableOrders: number[];
  overviewOrders: number[];
  maxOrder: number | null;
}

export interface PublicSurveyProduct {
  productId?: string;
  name: string;
  modality: PublicSurveyModality;
  description: string;
  status: PublicProductStatus;
  sourceUrl: string;
  geometrySourceUrl?: string;
  reason?: string;
  manualStep?: string;
  coverage?: PublicCoverageOrders;
}

export interface PublicSurveyRelease {
  id: string;
  label: string;
  kind: string;
  releasedYear?: number;
  modalities: PublicSurveyModality[];
  products: PublicSurveyProduct[];
  coverageOrders?: PublicCoverageOrderSummary;
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
}

export interface PublicSurveyCatalog {
  schemaVersion: 1;
  generatedAt: string;
  surveys: PublicSurveyRecord[];
}
