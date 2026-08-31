import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { AdminHttpError, AssetsAdmin, KubernetesApiError, SUPPORTED_COVERAGE_MODES, adminFromRequest, type ConnectorInput, type CoverageTaskInput, type MocDiscoveryInput } from "./admin.js";
import { assetPreviewMode, loadCatalog, publicManifest, type LoadedCatalog } from "./catalog.js";
import { projectRoot } from "./paths.js";
import { loadSurveyIndex } from "./surveys.js";
import { coverageBlock, coverageCatalogFromWarehouse, loadCoverageCatalog, withCoverageRevisions, type CoverageCellLayer } from "./coverage.js";
import { overlapForLayers } from "./overlap.js";
import { ProductStore, type MocProductRegistrationInput, type ProductRecord } from "./products.js";
import { SourceUnitStore, SourceUnitWorkerStore } from "./source-units.js";
import { CoverageEvidenceStore, EvidenceStoreError, type ReverseLookupResult, type WarehouseLayerSnapshot } from "./evidence-store.js";
import { buildOverlapDetails, publicExternalUrl } from "./overlap-details.js";
import { resolveMocDiscoveryCandidate } from "./moc-discovery.js";
import { MocBuildService, MocBuildStore, MocPublicationStore, type MocPublication, type MocPublicationFile } from "./moc-build.js";
import { buildPublicProductEvidence } from "./public-product-evidence.js";
import type { PublicAssetRecord, PublicProductDossier, PublicProductLink, PublicProductVerificationStatus, PublicSurveyModality } from "./types.js";

const port = Number(process.env.PORT ?? "4180");
const host = process.env.HOST ?? "0.0.0.0";
const releaseRoot = path.resolve(process.env.ASSET_RELEASE_ROOT ?? projectRoot);
const siteRoot = path.resolve(process.env.PUBLIC_SITE_ROOT ?? path.join(projectRoot, "dist", "site"));
const catalog = await loadCatalog(releaseRoot);
let coverageManifest = JSON.parse(await readFile(path.join(releaseRoot, "src", "footprints", "survey-footprints.json"), "utf8")) as {
  schemaVersion: number;
  generatedAt: string;
  coordinateFrame: string;
  nside: number;
  footprints: Array<Record<string, unknown> & { surveyId: string; releaseId: string; product: string; nside: number; pixels: number[] }>;
};
const evidenceStore = new CoverageEvidenceStore({
  url: process.env.ASSETS_WAREHOUSE_ES_URL,
  layerIndex: process.env.ASSETS_WAREHOUSE_LAYER_INDEX,
  coverageIndex: process.env.ASSETS_WAREHOUSE_COVERAGE_INDEX,
  fileIndex: process.env.ASSETS_WAREHOUSE_FILE_INDEX,
});
const contentRoot = path.resolve(process.env.ASSETS_CONTENT_ROOT ?? "/var/lib/assets-content");
const evidenceRoot = path.resolve(process.env.ASSETS_EVIDENCE_ROOT ?? "/var/lib/assets-evidence");
const mocBuildStore = new MocBuildStore(contentRoot);
await mocBuildStore.initialize();
const mocPublicationStore = new MocPublicationStore(contentRoot, evidenceRoot);
await mocPublicationStore.initialize();
const publishedPublicAssets = new Map<string, { record: PublicAssetRecord; absolutePath: string }>();
const publishedAssetIds = new Set<string>();
let staticCoverageCatalog = await loadCoverageCatalog(releaseRoot, coverageManifest);
let coverageCatalog = staticCoverageCatalog;
let runtimeCoverageManifest = coverageManifest;
let coverageLoadMode: "warehouse" | "static" | "degraded" = "static";
let coverageLoadedAt = new Date().toISOString();
let surveyIndex!: Awaited<ReturnType<typeof loadSurveyIndex>>;
let warehouseLayerSnapshots = new Map<string, WarehouseLayerSnapshot>();

function clearPublishedAssets(): void {
  for (const id of publishedAssetIds) catalog.files.delete(id);
  publishedAssetIds.clear();
  publishedPublicAssets.clear();
}

function publicationAsset(id: string, publication: MocPublication, file: MocPublicationFile, kind: PublicAssetRecord["kind"], label: string, downloadName: string): { record: PublicAssetRecord; absolutePath: string } {
  const record: PublicAssetRecord = {
    id,
    kind,
    label,
    description: `Published MOC build ${publication.buildName}`,
    path: file.path,
    downloadName,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    surveyId: publication.surveyId,
    releaseId: publication.releaseId,
    product: publication.product,
    deliveryClass: "runtime",
  };
  const entry = { record, absolutePath: mocPublicationStore.absolutePath(file) };
  catalog.files.set(id, entry);
  publishedAssetIds.add(id);
  publishedPublicAssets.set(id, entry);
  return entry;
}

async function registerPublicationAssets(publication: MocPublication): Promise<void> {
  publicationAsset(`layer-${publication.layerId}-moc`, publication, publication.files.moc, "moc", `${publication.product} FITS MOC`, `${publication.layerId}.moc.fits`);
  if (publication.files.query) publicationAsset(`layer-${publication.layerId}-query`, publication, publication.files.query, "geometry", `${publication.product} query projection`, `${publication.layerId}.query.json`);
  if (publication.files.preview) publicationAsset(`layer-${publication.layerId}-preview`, publication, publication.files.preview, "geometry", `${publication.product} coverage preview`, `${publication.layerId}.preview.json`);
  if (publication.files.statistics) publicationAsset(`layer-${publication.layerId}-statistics`, publication, publication.files.statistics, "metadata", `${publication.product} coverage statistics`, `${publication.layerId}.statistics.json`);
  if (publication.files.manifest) publicationAsset(`layer-${publication.layerId}-manifest`, publication, publication.files.manifest, "provenance", `${publication.product} MOC build manifest`, `${publication.layerId}.build-manifest.json`);
}

async function readProjection(file: MocPublicationFile | undefined): Promise<{ order: number; pixels: number[] } | undefined> {
  if (!file) return undefined;
  try {
    const value = JSON.parse(await readFile(mocPublicationStore.absolutePath(file), "utf8")) as Record<string, unknown>;
    const order = typeof value.order === "number" && Number.isSafeInteger(value.order) && value.order >= 0 && value.order <= 29 ? value.order : Number.NaN;
    const pixels = Array.isArray(value.pixels) ? value.pixels.filter((pixel): pixel is number => typeof pixel === "number" && Number.isSafeInteger(pixel) && pixel >= 0) : [];
    if (!Number.isSafeInteger(order) || !pixels.length) return undefined;
    return { order, pixels: [...new Set(pixels)].sort((a, b) => a - b) };
  } catch { return undefined; }
}

async function publicationLayer(publication: MocPublication): Promise<CoverageCellLayer | undefined> {
  const query = await readProjection(publication.files.query);
  const preview = await readProjection(publication.files.preview);
  const projections = [preview, query].filter((value): value is { order: number; pixels: number[] } => Boolean(value));
  if (!projections.length) return undefined;
  const cellMap = new Map<number, number[]>();
  for (const projection of projections) if (!cellMap.has(projection.order)) cellMap.set(projection.order, projection.pixels);
  const availableOrders = [...cellMap.keys()].sort((a, b) => a - b);
  const overviewOrder = availableOrders[0]!;
  const maxOrder = availableOrders[availableOrders.length - 1]!;
  const overviewCells = cellMap.get(overviewOrder) ?? [];
  const areaDeg2 = overviewCells.length * (41252.96124941927 / (12 * 2 ** (2 * overviewOrder)));
  return {
    layerId: publication.layerId,
    productId: publication.productId,
    surveyId: publication.surveyId,
    releaseId: publication.releaseId,
    product: publication.product,
    color: "#42d5c4",
    availableOrders,
    overviewOrder,
    maxOrder,
    cellCount: cellMap.get(maxOrder)?.length ?? overviewCells.length,
    areaDeg2,
    tileScheme: "ipix-range-4096",
    cells: cellMap,
    recipe: {
      recipeVersion: 1,
      mode: "native-moc",
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      maxOrder,
      queryOrder: query?.order ?? maxOrder,
      previewOrder: preview?.order ?? overviewOrder,
      steps: [
        { id: "input", kind: "native-moc-source", title: "原生 FITS MOC 来源", bodyMarkdown: `sourceUrl=${publication.buildName}`, order: 0, implementationRef: "assets.moc.discovery" },
        { id: "validate", kind: "moc-validation", title: "IVOA MOC / ICRS / NUNIQ 校验", bodyMarkdown: "coordinateFrame=ICRS; ordering=NESTED", order: 1, implementationRef: "astro_survey_moc_core.core:validate_moc_fits" },
        { id: "project", kind: "order-projection", title: "发布 order 投影", bodyMarkdown: `queryOrder=${query?.order ?? maxOrder}; previewOrder=${preview?.order ?? overviewOrder}`, order: 2, implementationRef: "astro_survey_moc_core.core:project_cells" },
        { id: "outputs", kind: "outputs", title: "MOC、query、preview 输出", bodyMarkdown: "输出已校验的不可变发布制品。", order: 3, implementationRef: "assets.moc.publication" },
        { id: "evidence", kind: "evidence", title: "manifest、provenance、hash", bodyMarkdown: `build=${publication.buildName}`, order: 4, implementationRef: "assets.moc.publication" },
      ],
      sourceUrl: publication.sourceUrl,
      ...(publication.sourceSnapshotSha256 ? { sourceSnapshotSha256: publication.sourceSnapshotSha256 } : {}),
      ...(publication.sourceSnapshotSizeBytes !== undefined ? { sourceSnapshotSizeBytes: publication.sourceSnapshotSizeBytes } : {}),
    },
    sourceUnitIndex: { status: "entrypoint-only", notes: "这是公开 CDS MOC 的覆盖层；没有源文件级反向索引。" },
  };
}

async function activatePublishedMocs(): Promise<void> {
  clearPublishedAssets();
  const layers = (await Promise.all(mocPublicationStore.list().map(async (publication) => {
    const integrity = await mocPublicationStore.verify(publication);
    if (!integrity.valid) {
      console.warn(`Skipping MOC publication ${publication.id}: ${integrity.reason}`);
      return undefined;
    }
    await registerPublicationAssets(publication);
    return publicationLayer(publication);
  }))).filter((layer): layer is CoverageCellLayer => Boolean(layer));
  if (!layers.length) return;
  const records = new Map(coverageCatalog.records);
  for (const layer of layers) records.set(layer.layerId, layer);
  coverageCatalog = withCoverageRevisions({ ...coverageCatalog, records, layers: [] });
  runtimeCoverageManifest = {
    ...runtimeCoverageManifest,
    generatedAt: new Date().toISOString(),
    nside: coverageCatalog.layers.length ? 2 ** Math.min(...coverageCatalog.layers.map((layer) => layer.overviewOrder)) : runtimeCoverageManifest.nside,
    footprints: [...records.values()].map((layer) => ({ surveyId: layer.surveyId, releaseId: layer.releaseId, product: layer.product, nside: 2 ** layer.overviewOrder, pixels: layer.cells.get(layer.overviewOrder) ?? [], sourceUrl: layer.recipe?.sourceUrl })),
  };
}

async function reloadRuntimeCoverage(): Promise<{ mode: string; loadedAt: string; layers: number; footprints: number }> {
  coverageManifest = JSON.parse(await readFile(path.join(releaseRoot, "src", "footprints", "survey-footprints.json"), "utf8")) as typeof coverageManifest;
  staticCoverageCatalog = await loadCoverageCatalog(releaseRoot, coverageManifest);
  coverageCatalog = staticCoverageCatalog;
  runtimeCoverageManifest = coverageManifest;
  coverageLoadMode = "static";
  warehouseLayerSnapshots = new Map();
  if (evidenceStore.configured) {
    try {
      const warehouseSnapshot = await evidenceStore.loadCurrentCoverageCatalog();
      if (warehouseSnapshot?.layers.length) {
        warehouseLayerSnapshots = new Map(warehouseSnapshot.layers.map((layer) => [layer.layerId, layer]));
        coverageCatalog = coverageCatalogFromWarehouse(staticCoverageCatalog, warehouseSnapshot);
        runtimeCoverageManifest = {
          ...coverageManifest,
          generatedAt: new Date().toISOString(),
          nside: coverageCatalog.layers.length ? 2 ** Math.min(...coverageCatalog.layers.map((layer) => layer.overviewOrder)) : coverageManifest.nside,
          footprints: [...coverageCatalog.records.values()].map((layer) => ({
            surveyId: layer.surveyId,
            releaseId: layer.releaseId,
            product: layer.product,
            nside: 2 ** layer.overviewOrder,
            pixels: layer.cells.get(layer.overviewOrder) ?? [],
            sourceUrl: layer.recipe?.sourceUrl,
          })),
        };
        coverageLoadMode = "warehouse";
        console.info(`Loaded ${coverageCatalog.layers.length} ACTIVE Warehouse coverage layers from ${evidenceStore.layerIndex}/${evidenceStore.coverageIndex}`);
      } else {
        console.warn("Warehouse ES is configured but has no ACTIVE layers; using the checked-in public geometry until a scan completes.");
      }
    } catch (error) {
      coverageLoadMode = "degraded";
      console.warn(`Warehouse coverage catalog unavailable; using checked-in geometry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  coverageLoadedAt = new Date().toISOString();
  await activatePublishedMocs();
  surveyIndex = await loadSurveyIndex(releaseRoot, catalog, runtimeCoverageManifest, coverageCatalog.layers, [...publishedPublicAssets.values()].map(({ record }) => record));
  return { mode: coverageLoadMode, loadedAt: coverageLoadedAt, layers: coverageCatalog.layers.length, footprints: coverageCatalog.records.size };
}

await reloadRuntimeCoverage();
const admin = new AssetsAdmin();
const products = new ProductStore();
await products.initialize(releaseRoot, coverageCatalog.layers);
const mocBuildService = new MocBuildService({
  store: mocBuildStore,
  evidenceRoot,
  maxOrder: Number(process.env.ASSETS_MOC_MAX_ORDER ?? "12"),
  queryOrder: Number(process.env.ASSETS_MOC_QUERY_ORDER ?? "8"),
  previewOrder: Number(process.env.ASSETS_MOC_PREVIEW_ORDER ?? "4"),
});

async function resumeMocBuilds(): Promise<void> {
  for (const request of mocBuildStore.list()) {
    if (["STAGED", "FAILED", "DUPLICATE"].includes(request.phase)) continue;
    try {
      const discovery = await admin.getMocDiscoveryRequest(request.discoveryRequestName);
      const candidate = resolveMocDiscoveryCandidate(discovery, request.candidateId);
      mocBuildService.enqueue(request, candidate);
    } catch (error) {
      console.warn(`Unable to resume MOC build ${request.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
await resumeMocBuilds();

function applyPublishedProductMetadata(index: Awaited<ReturnType<typeof loadSurveyIndex>>): Awaited<ReturnType<typeof loadSurveyIndex>> {
  const published = products.list().filter((record): record is ProductRecord & { published: NonNullable<ProductRecord["published"]> } => Boolean(record.published));
  if (!published.length) return index;
  const records = new Map(published.map((record) => [record.productId, record.published]));
  const publicModality = (value: string | undefined): PublicSurveyModality => {
    const allowed: PublicSurveyModality[] = ["imaging", "spectroscopy", "photometry", "time-domain", "integral-field", "ultraviolet", "infrared", "catalog", "simulation"];
    return value && allowed.includes(value as PublicSurveyModality) ? value as PublicSurveyModality : "catalog";
  };
  const applyOverride = <T extends object>(product: T, override: ProductRecord["published"]): T => ({
    ...product,
    ...(override?.dataOrigin ? { dataOrigin: override.dataOrigin } : {}),
    ...(override?.sourceTier ? { sourceTier: override.sourceTier } : {}),
    ...(override?.originNote ? { originNote: override.originNote } : {}),
    ...(override?.sourceLabel ? { sourceLabel: override.sourceLabel } : {}),
    ...(override?.sourceUrl ? { sourceUrl: override.sourceUrl } : {}),
    ...(override?.officialDataLabel ? { officialDataLabel: override.officialDataLabel } : {}),
    ...(override?.officialDataUrl ? { officialDataUrl: override.officialDataUrl } : {}),
    ...(override?.officialQueryLabel ? { officialQueryLabel: override.officialQueryLabel } : {}),
    ...(override?.officialQueryUrl ? { officialQueryUrl: override.officialQueryUrl } : {}),
    ...(override?.geometrySourceLabel ? { geometrySourceLabel: override.geometrySourceLabel } : {}),
    ...(override?.geometrySourceUrl ? { geometrySourceUrl: override.geometrySourceUrl } : {}),
  } as T);
  const surveys = index.surveys.map((survey) => ({
    ...survey,
    releases: survey.releases.map((release) => ({
      ...release,
      products: release.products.map((product) => {
        const override = records.get(product.productId ?? "");
        return override ? applyOverride(product, override) : product;
      }),
    })),
  }));
  const additionalAssets = [...publishedPublicAssets.values()].map(({ record }) => record);
  const allAssets = publicManifest(catalog, additionalAssets).files;
  const dynamicPublished = published.filter((record) => {
    const content = record.published;
    return Boolean(content.publicSurvey && content.publicRelease && content.publicDescription)
      && !surveys.some((survey) => survey.releases.some((release) => release.products.some((product) => product.productId === record.productId)));
  });
  for (const record of dynamicPublished) {
    const content = record.published;
    if (!content.publicSurvey || !content.publicRelease || !content.publicDescription) continue;
    const layer = coverageCatalog.layers.find((candidate) => candidate.surveyId === content.surveyId && candidate.releaseId === content.releaseId && candidate.product === content.name);
    const product = {
      productId: content.productId,
      name: content.name,
      modality: publicModality(content.modality ?? content.publicSurvey.modalities[0]),
      description: content.publicDescription,
      status: content.publicStatus ?? (layer ? "acquired" : "awaiting_geometry"),
      sourceUrl: content.sourceUrl ?? content.geometrySourceUrl ?? "",
      ...(content.dataOrigin ? { dataOrigin: content.dataOrigin } : {}),
      ...(content.sourceTier ? { sourceTier: content.sourceTier } : {}),
      ...(content.originNote ? { originNote: content.originNote } : {}),
      ...(content.sourceLabel ? { sourceLabel: content.sourceLabel } : {}),
      ...(content.geometrySourceUrl ? { geometrySourceUrl: content.geometrySourceUrl } : {}),
      ...(content.geometrySourceLabel ? { geometrySourceLabel: content.geometrySourceLabel } : {}),
      ...(layer ? { coverage: { layerId: layer.layerId, availableOrders: layer.availableOrders, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder } } : {}),
    };
    const survey = surveys.find((candidate) => candidate.id === content.surveyId);
    if (!survey) {
      surveys.push({
        id: content.surveyId,
        name: content.publicSurvey.name,
        mission: content.publicSurvey.mission,
        color: content.publicSurvey.color,
        description: content.publicSurvey.description,
        modalities: content.publicSurvey.modalities.map(publicModality),
        releases: [{ id: content.releaseId, label: content.publicRelease.label, kind: content.publicRelease.kind, ...(content.publicRelease.releasedYear !== undefined ? { releasedYear: content.publicRelease.releasedYear } : {}), modalities: [product.modality], products: [product] }],
        imageUrl: "",
        statistics: { publicProducts: 1, acquired: product.status === "acquired" ? 1 : 0, overviewOnly: product.status === "overview_only" ? 1 : 0, awaitingGeometry: product.status === "awaiting_geometry" ? 1 : 0, notApplicable: product.status === "not_applicable" ? 1 : 0, footprintCells: new Set(runtimeCoverageManifest.footprints.filter((footprint) => footprint.surveyId === content.surveyId).flatMap((footprint) => footprint.pixels)).size },
        assets: allAssets.filter((asset) => asset.surveyId === content.surveyId),
      });
      continue;
    }
    const release = survey.releases.find((candidate) => candidate.id === content.releaseId);
    if (release) {
      release.products.push(product);
      if (!release.modalities.includes(product.modality)) release.modalities.push(product.modality);
    } else {
      survey.releases.push({ id: content.releaseId, label: content.publicRelease.label, kind: content.publicRelease.kind, ...(content.publicRelease.releasedYear !== undefined ? { releasedYear: content.publicRelease.releasedYear } : {}), modalities: [product.modality], products: [product] });
    }
    if (!survey.modalities.includes(product.modality)) survey.modalities.push(product.modality);
    survey.assets = allAssets.filter((asset) => asset.surveyId === survey.id);
  }
  const orderSummary = (layers: typeof coverageCatalog.layers) => {
    if (!layers.length) return undefined;
    const availableOrders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((a, b) => a - b);
    const overviewOrders = [...new Set(layers.map((layer) => layer.overviewOrder))].sort((a, b) => a - b);
    return { availableOrders, overviewOrders, maxOrder: Math.max(...layers.map((layer) => layer.maxOrder)) };
  };
  return {
    ...index,
    surveys: surveys.map((survey) => {
      const surveyLayers = coverageCatalog.layers.filter((layer) => layer.surveyId === survey.id);
      const productsForSurvey = survey.releases.flatMap((release) => release.products);
      return {
        ...survey,
        coverageOrders: orderSummary(surveyLayers) ?? survey.coverageOrders,
        releases: survey.releases.map((release) => ({ ...release, coverageOrders: orderSummary(surveyLayers.filter((layer) => layer.releaseId === release.id)) ?? release.coverageOrders })),
        statistics: { publicProducts: productsForSurvey.length, acquired: productsForSurvey.filter((product) => product.status === "acquired").length, overviewOnly: productsForSurvey.filter((product) => product.status === "overview_only").length, awaitingGeometry: productsForSurvey.filter((product) => product.status === "awaiting_geometry").length, notApplicable: productsForSurvey.filter((product) => product.status === "not_applicable").length, footprintCells: new Set(runtimeCoverageManifest.footprints.filter((footprint) => footprint.surveyId === survey.id).flatMap((footprint) => footprint.pixels)).size },
        assets: allAssets.filter((asset) => asset.surveyId === survey.id),
      };
    }),
  };
}
surveyIndex = applyPublishedProductMetadata(surveyIndex);
let sourceUnitsPromise: Promise<SourceUnitWorkerStore> | null = null;
let sourceUnitsFallbackPromise: Promise<SourceUnitStore> | null = null;
function sourceUnitsStore(): Promise<SourceUnitWorkerStore> {
  if (!sourceUnitsPromise) {
    sourceUnitsPromise = SourceUnitWorkerStore.load(releaseRoot).catch((error) => {
      sourceUnitsPromise = null;
      throw error;
    });
  }
  return sourceUnitsPromise;
}

function sourceUnitsFallbackStore(): Promise<SourceUnitStore> {
  if (!sourceUnitsFallbackPromise) {
    sourceUnitsFallbackPromise = SourceUnitStore.load(releaseRoot).catch((error) => {
      sourceUnitsFallbackPromise = null;
      throw error;
    });
  }
  return sourceUnitsFallbackPromise;
}

async function sourceUnitsReadyWithin(timeoutMs: number): Promise<SourceUnitWorkerStore | SourceUnitStore | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  try {
    try {
      const worker = await Promise.race([sourceUnitsStore(), timeout]);
      if (worker) return worker;
    } catch { /* fall through to the bounded main-thread index */ }
    return await sourceUnitsFallbackStore();
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

function productCoverage(record: ProductRecord): Record<string, unknown> | undefined {
  const content = record.published ?? record.draft;
  const layer = productCoverageLayer(record);
  if (!layer) return undefined;
  return { layerId: layer.layerId, availableOrders: layer.availableOrders, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder, coverageRole: layer.coverageRole, areaDeg2: layer.areaDeg2 };
}

function productCoverageLayer(record: ProductRecord, build?: ReturnType<MocBuildStore["get"]>): CoverageCellLayer | undefined {
  const content = record.published ?? record.draft;
  const direct = content.layerId ? coverageCatalog.records.get(content.layerId) : undefined;
  if (direct) return direct;
  const matches = [...coverageCatalog.records.values()].filter((candidate) => candidate.surveyId === content.surveyId
    && candidate.releaseId === content.releaseId
    && candidate.product === content.name);
  if (build?.publicationId) {
    const publication = mocPublicationStore.forBuild(build.name);
    const publishedLayer = publication ? coverageCatalog.records.get(publication.layerId) : undefined;
    if (publishedLayer) return publishedLayer;
  }
  return matches.find((candidate) => candidate.layerId.startsWith("moc-")) ?? matches[0];
}

function adminMocBuildSummaryForBuild(build: ReturnType<MocBuildStore["get"]>): Record<string, unknown> {
  const outputs = build.outputs;
  const productRecord = build.productId ? products.list().find((record) => record.productId === build.productId) : undefined;
  return {
    name: build.name,
    discoveryRequestName: build.discoveryRequestName,
    candidateId: build.candidateId,
    ...(build.candidateTitle ? { candidateTitle: build.candidateTitle } : {}),
    ...(build.surveyId ? { surveyId: build.surveyId } : {}),
    ...(build.releaseId ? { releaseId: build.releaseId } : {}),
    ...(build.productId ? { productId: build.productId } : {}),
    sourceUrl: build.source.url,
    phase: build.phase,
    progress: build.progress,
    createdAt: build.createdAt,
    updatedAt: build.updatedAt,
    ...(outputs ? {
      outputs: {
        ...(outputs.cellCount !== undefined ? { cellCount: outputs.cellCount } : {}),
        ...(outputs.availableOrders ? { availableOrders: outputs.availableOrders } : {}),
        ...(outputs.maxOrder !== undefined ? { maxOrder: outputs.maxOrder } : {}),
      },
    } : {}),
    ...(build.error ? { error: build.error } : {}),
    ...(build.publishedAt ? { publishedAt: build.publishedAt } : {}),
    ...(build.publicationId ? { publicationId: build.publicationId } : {}),
    ...(productRecord ? { lifecycle: adminProductLifecycle(productRecord, build) } : {}),
  };
}

function adminProductLifecycle(record: ProductRecord, build?: ReturnType<MocBuildStore["get"]>): Record<string, unknown> {
  const layer = productCoverageLayer(record, build);
  const published = Boolean(record.published);
  const hasPublication = Boolean(build?.publicationId);
  const runtimeState = hasPublication
    ? layer ? "ACTIVE" : "INVALID"
    : layer ? "CATALOG_BASELINE" : "INACTIVE";
  return {
    publication: {
      state: published ? "PUBLISHED" : "DRAFT",
      ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
      ...(build?.publicationId ? { publicationId: build.publicationId } : {}),
    },
    runtime: {
      state: runtimeState,
      ...(layer ? {
        layerId: layer.layerId,
        catalogRevision: coverageCatalog.revision,
        availableOrders: layer.availableOrders,
        overviewOrder: layer.overviewOrder,
        maxOrder: layer.maxOrder,
      } : {}),
    },
    links: {
      product: published
        ? `/api/v1/products/${encodeURIComponent(record.productId)}`
        : `/api/v1/admin/products/${encodeURIComponent(record.productId)}`,
      catalog: "/api/v1/coverage/catalog",
      ...(published && layer ? { sky: `/?survey=${encodeURIComponent(record.draft.surveyId)}&product=${encodeURIComponent(record.productId)}` } : {}),
      ...(published && layer ? { moc: `/api/v1/coverage/layers/${encodeURIComponent(layer.layerId)}/moc.fits` } : {}),
    },
  };
}

function adminMocBuildView(build: ReturnType<MocBuildStore["get"]>): Record<string, unknown> {
  const product = build.productId ? products.list().find((record) => record.productId === build.productId) : undefined;
  return {
    ...build,
    ...(product ? { lifecycle: adminProductLifecycle(product, build) } : {}),
  };
}

type MocRegistrationDefaultField = "releaseId" | "releaseLabel" | "releaseKind" | "productName" | "productDescription" | "productStatus" | "modality" | "dataOrigin";
type MocRegistrationDefaults = Pick<MocProductRegistrationInput, MocRegistrationDefaultField>;

function registrationSlug(value: string | undefined, fallback = "public"): string {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return normalized || fallback;
}

function inferMocModality(surveyName: string, productName: string, existing?: string): string {
  if (existing?.trim()) return existing.trim();
  const value = `${surveyName} ${productName}`.toLowerCase();
  if (/gaia|catalog|source|astrometr|quasar/.test(value)) return "catalog";
  if (/jwst|wise|2mass|vista|infrared|nircam|miri|spitzer/.test(value)) return "infrared";
  if (/galex|ultraviolet|uv\b/.test(value)) return "ultraviolet";
  if (/desi|spectr|spectrum|ifs/.test(value)) return "spectroscopy";
  return "imaging";
}

async function mocRegistrationDefaults(build: ReturnType<MocBuildStore["get"]>): Promise<{ values: MocRegistrationDefaults; sources: Partial<Record<MocRegistrationDefaultField, string>> }> {
  const discovery = await admin.getMocDiscoveryRequest(build.discoveryRequestName);
  const candidate = resolveMocDiscoveryCandidate(discovery, build.candidateId);
  const surveyId = build.surveyId ?? discovery.surveyId ?? registrationSlug(discovery.surveyName);
  const survey = surveyIndex.surveys.find((entry) => entry.id === surveyId);
  const release = survey?.releases.find((entry) => entry.id === (build.releaseId ?? discovery.releaseId ?? registrationSlug(discovery.releaseHint, "")));
  const releaseId = build.releaseId ?? discovery.releaseId ?? (discovery.releaseHint ? registrationSlug(discovery.releaseHint) : "public");
  const releaseLabel = release?.label ?? discovery.releaseHint?.trim() ?? (releaseId === "public" ? "Public MOC" : releaseId.toUpperCase());
  const productName = discovery.productHint?.trim() || candidate.candidate.title?.trim() || candidate.candidate.candidateId;
  const existingProduct = release?.products.find((entry) => entry.name === productName);
  const modality = inferMocModality(discovery.surveyName, productName, existingProduct?.modality);
  const values: MocRegistrationDefaults = {
    releaseId,
    releaseLabel,
    releaseKind: release?.kind ?? "release",
    productName,
    productDescription: `${productName} 的公开天区覆盖 MOC；来源为 CDS MOC 服务，已由 Assets 校验并锁定来源哈希。`,
    productStatus: existingProduct?.status ?? "acquired",
    modality,
    dataOrigin: existingProduct?.dataOrigin ?? "observed",
  };
  return {
    values,
    sources: {
      releaseId: build.releaseId || discovery.releaseId || (discovery.releaseHint ? "discovery.releaseHint" : "fallback.public"),
      releaseLabel: release ? "public.catalog" : discovery.releaseHint ? "discovery.releaseHint" : "fallback.public",
      releaseKind: release ? "public.catalog" : "fallback.release",
      productName: discovery.productHint ? "discovery.productHint" : candidate.candidate.title ? "discovery.candidate.title" : "discovery.candidateId",
      productDescription: "assets.registration-template",
      productStatus: existingProduct ? "public.catalog" : "fallback.acquired",
      modality: existingProduct ? "public.catalog" : "assets.candidate-inference",
      dataOrigin: existingProduct ? "public.catalog" : "fallback.observed",
    },
  };
}

function adminMocBuildSummary(productId: string): Record<string, unknown> | undefined {
  const build = mocBuildStore.list().find((candidate) => candidate.productId === productId);
  return build ? adminMocBuildSummaryForBuild(build) : undefined;
}

function adminUnmatchedMocBuilds(): Array<Record<string, unknown>> {
  return mocBuildStore.list()
    .filter((build) => build.phase === "STAGED" && !build.productId && !build.publishedAt && !build.publicationId)
    .map(adminMocBuildSummaryForBuild);
}

function productAssets(record: ProductRecord): Array<{ record: PublicAssetRecord; id: string }> {
  const content = record.published ?? record.draft;
  const layer = productCoverageLayer(record);
  return [...catalog.files.entries()]
    .filter(([, entry]) => {
      const asset = entry.record;
      if (asset.surveyId !== content.surveyId) return false;
      if (asset.kind !== "package" && asset.releaseId && asset.releaseId !== content.releaseId) return false;
      if (asset.product && asset.product !== content.name) return false;
      if (layer && (asset.kind === "moc" || asset.kind === "geometry" || asset.kind === "provenance" || asset.kind === "metadata")) {
        return asset.path.includes(`/layers/${layer.layerId}/`)
          || asset.id.includes(layer.layerId)
          // Legacy W1 artifacts predate layer-directory naming. Their
          // survey/release/product identity is still unambiguous.
          || (asset.releaseId === content.releaseId && asset.product === content.name);
      }
      return asset.kind === "package" || asset.kind === "moc" || asset.kind === "geometry" || asset.kind === "provenance" || asset.kind === "metadata";
    })
    .map(([id, entry]) => ({ id, record: entry.record }));
}

function localAssetLink(kind: PublicProductLink["kind"], label: string, id: string, asset: { mediaType?: string; sizeBytes?: number; sha256?: string }): PublicProductLink {
  return {
    kind,
    label,
    url: `/api/v1/assets/${encodeURIComponent(id)}/download`,
    ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
    ...(typeof asset.sizeBytes === "number" ? { sizeBytes: asset.sizeBytes } : {}),
    ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
  };
}

function externalLink(kind: PublicProductLink["kind"], label: string, url: string): PublicProductLink | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const privateHost = host === "localhost" || host.endsWith(".local") || host === "::1"
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || privateHost) return undefined;
    return { kind, label, url: parsed.toString() };
  } catch { return undefined; }
}

function dedupeLinks(links: Array<PublicProductLink | undefined>): PublicProductLink[] {
  const seen = new Set<string>();
  return links.filter((link): link is PublicProductLink => Boolean(link)).filter((link) => {
    const key = `${link.kind}:${link.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function productCatalogEntry(record: ProductRecord): { status?: string; reason?: string; sourceUrl?: string; geometrySourceUrl?: string; sourceLabel?: string; geometrySourceLabel?: string; officialDataUrl?: string; officialDataLabel?: string; officialQueryUrl?: string; officialQueryLabel?: string } | undefined {
  const content = record.published ?? record.draft;
  const survey = surveyIndex.surveys.find((candidate) => candidate.id === content.surveyId);
  const release = survey?.releases.find((candidate) => candidate.id === content.releaseId);
  return release?.products.find((candidate) => candidate.productId === record.productId || candidate.name === content.name);
}

function sanitizeSummary(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  // Editorial markdown is intentionally kept as plain text in the API. Avoid
  // leaking implementation paths if an old draft contains one.
  return sanitizePublicText(text) || fallback;
}

function sanitizePublicText(value: string): string {
  return value
    .replace(/(?:^|[;\s])(input|scannerRunId|taskSnapshot|evidencePath|normalizedScan|manifestPath)=[^;\n]+/gi, " ")
    .replace(/(?:s3:\/\/|gs:\/\/|minio:\/\/|\/var\/lib\/|\/mnt\/|\/tmp\/)[^\s,;]+/gi, "[redacted path]")
    .replace(/\s{2,}/g, " ").trim();
}

function buildPublicProductDossier(record: ProductRecord): PublicProductDossier {
  // A catalog record can be useful before editorial copy is published. Build
  // the public projection from that record, while keeping draft prose and
  // internal fields out of the response.
  const product = record.published ?? record.draft;
  const layer = productCoverageLayer(record);
  const assets = productAssets(record);
  const catalogEntry = productCatalogEntry(record);
  const mocAsset = assets.find((asset) => asset.record.kind === "moc" && (!layer || asset.record.path.includes(`/layers/${layer.layerId}/`) || asset.record.id.includes(layer.layerId) || (asset.record.releaseId === product.releaseId && asset.record.product === product.name)));
  const previewAsset = assets.find((asset) => asset.record.kind === "geometry" && /preview/i.test(asset.record.id));
  const packageAsset = assets.find((asset) => asset.record.kind === "package");
  const provenanceAsset = assets.find((asset) => asset.record.kind === "provenance" && (!layer || asset.record.path.includes(`/layers/${layer.layerId}/`) || asset.record.id.includes(layer.layerId)));
  const geometryAsset = assets.find((asset) => asset.record.kind === "geometry" && !/preview|query/i.test(asset.record.id));
  const statisticsAsset = assets.find((asset) => asset.record.kind === "metadata" && /statistics/i.test(asset.record.id));
  const precision: PublicProductDossier["coverage"]["precision"] = !layer
    ? "entrypoint-only"
    : layer.sourceUnitIndex?.status === "estimated" ? "estimated" : "exact";
  const hasCoverage = Boolean(layer);
  const hasSnapshot = Boolean(layer?.recipe?.sourceSnapshotSha256);
  const status: PublicProductVerificationStatus = !hasCoverage
    ? (product.sourceUrl || catalogEntry?.sourceUrl ? "entrypoint-only" : "partial")
    : mocAsset && hasSnapshot ? "complete" : "partial";
  const summary = sanitizeSummary(product.presentation.summaryMarkdown, hasCoverage
    ? `${product.name} has a published ${precision} ICRS/NESTED coverage layer.`
    : `${product.name} has an official data entrypoint; a verified coverage layer is not published yet.`);
  const availableOrders = layer?.availableOrders ?? [];
  const cellCounts = layer ? Object.fromEntries([...layer.cells.entries()].map(([order, cells]) => [String(order), cells.length])) : {};
  const officialDataUrl = product.officialDataUrl ?? catalogEntry?.officialDataUrl;
  const officialQueryUrl = product.officialQueryUrl ?? catalogEntry?.officialQueryUrl;
  const links = dedupeLinks([
    externalLink("official-release", product.sourceLabel ?? catalogEntry?.sourceLabel ?? "Official release", product.sourceUrl ?? catalogEntry?.sourceUrl ?? ""),
    officialDataUrl ? externalLink("official-data", product.officialDataLabel ?? catalogEntry?.officialDataLabel ?? "Official data", officialDataUrl) : undefined,
    officialQueryUrl ? externalLink("official-query", product.officialQueryLabel ?? catalogEntry?.officialQueryLabel ?? "Official query", officialQueryUrl) : undefined,
    externalLink("geometry-source", product.geometrySourceLabel ?? catalogEntry?.geometrySourceLabel ?? "Coverage input", product.geometrySourceUrl ?? catalogEntry?.geometrySourceUrl ?? ""),
    mocAsset && layer && { kind: "fits-moc", label: "FITS MOC", url: `/api/v1/coverage/layers/${encodeURIComponent(layer.layerId)}/moc.fits`, ...(mocAsset.record.mediaType ? { mediaType: mocAsset.record.mediaType } : {}), ...(typeof mocAsset.record.sizeBytes === "number" ? { sizeBytes: mocAsset.record.sizeBytes } : {}), ...(mocAsset.record.sha256 ? { sha256: mocAsset.record.sha256 } : {}) },
    mocAsset && !layer ? localAssetLink("fits-moc", "FITS MOC", mocAsset.id, mocAsset.record) : undefined,
    previewAsset && localAssetLink("coverage-preview", "Coverage preview", previewAsset.id, previewAsset.record),
    geometryAsset && localAssetLink("geometry-source", "Geometry artifact", geometryAsset.id, geometryAsset.record),
    packageAsset && localAssetLink("resource-package", "Resource Package v3", packageAsset.id, packageAsset.record),
    provenanceAsset && localAssetLink("provenance", "Provenance", provenanceAsset.id, provenanceAsset.record),
  ]);
  const technicalDownloads = links.filter((link) => ["fits-moc", "coverage-preview", "geometry-source", "resource-package", "provenance"].includes(link.kind));
  const official = links.find((link) => link.kind === "official-release");
  const query = links.find((link) => link.kind === "official-query");
  const data = links.find((link) => link.kind === "official-data");
  const geometry = links.find((link) => link.kind === "geometry-source");
  const view: PublicProductLink = { kind: "coverage-preview", label: "View in sky", url: `/?survey=${encodeURIComponent(product.surveyId)}&product=${encodeURIComponent(product.productId)}`, description: "在 Atlas 天球视图中定位这个产品的公开覆盖。" };
  const checks: PublicProductDossier["verification"]["checks"] = [
    { id: "coverage", label: "Published coverage", status: hasCoverage ? "passed" : "unavailable", ...(hasCoverage ? { detail: `${availableOrders.length} HEALPix order(s) are published.` } : { detail: "Only an official entrypoint is available." }) },
    { id: "moc", label: "FITS MOC artifact", status: mocAsset ? "passed" : hasCoverage ? "warning" : "unavailable", ...(mocAsset ? { detail: "The downloadable artifact is allowlisted and hash-addressed." } : {}) },
    { id: "coordinates", label: "Coordinate frame and ordering", status: hasCoverage ? "passed" : "unavailable", ...(hasCoverage ? { detail: "ICRS / NESTED" } : {}) },
    { id: "source-snapshot", label: "Input snapshot hash", status: layer?.recipe?.sourceSnapshotSha256 ? "passed" : "unavailable", ...(layer?.recipe?.sourceSnapshotSha256 ? { detail: layer.recipe.sourceSnapshotSha256 } : {}) },
  ];
  const outputHashes = [
    ...technicalDownloads.filter((link) => link.sha256).map((link) => ({ kind: link.kind, sha256: link.sha256!, url: link.url })),
    ...(statisticsAsset ? [{ kind: "statistics", sha256: statisticsAsset.record.sha256, url: `/api/v1/assets/${encodeURIComponent(statisticsAsset.id)}/download` }] : []),
  ];
  const limitations = [
    ...(product.presentation.limitationsMarkdown?.split(/\n+/).map((line) => sanitizePublicText(line.replace(/^[-*]\s*/, "").trim())).filter(Boolean) ?? []),
    ...(layer?.sourceUnitIndex?.status === "entrypoint-only" ? [sanitizePublicText(layer.sourceUnitIndex.notes)] : []),
    ...(catalogEntry?.reason ? [sanitizePublicText(catalogEntry.reason)] : []),
  ];
  const evidence = buildPublicProductEvidence({ product, catalogEntry, layer, assets });
  const snapshot = layer?.recipe?.sourceSnapshotSha256 ? { sha256: layer.recipe.sourceSnapshotSha256, ...(layer.recipe.sourceSnapshotSizeBytes !== undefined ? { sizeBytes: layer.recipe.sourceSnapshotSizeBytes } : {}) } : undefined;
  const dossier: PublicProductDossier = {
    schemaVersion: 1,
    identity: { productId: product.productId, surveyId: product.surveyId, releaseId: product.releaseId, name: product.name, ...(product.modality ? { modality: product.modality } : {}), ...(product.dataOrigin ? { dataOrigin: product.dataOrigin } : {}), ...(product.sourceTier ? { sourceTier: product.sourceTier } : {}) },
    conclusion: { status, summary, coverageAvailable: hasCoverage },
    coverage: { available: hasCoverage, ...(layer ? { layerId: layer.layerId, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder, cellCount: layer.cellCount, cellCounts, areaDeg2: layer.areaDeg2, ...(layer.coverageRole ?? product.coverageRole ? { coverageRole: layer.coverageRole ?? product.coverageRole } : {}), ...(mocAsset ? { mocUrl: `/api/v1/coverage/layers/${encodeURIComponent(layer.layerId)}/moc.fits` } : {}), ...(previewAsset ? { previewUrl: `/api/v1/assets/${encodeURIComponent(previewAsset.id)}/preview` } : {}) } : {}), coordinateFrame: "ICRS", ordering: "NESTED", availableOrders, precision },
    source: { ...(product.sourceLabel || catalogEntry?.sourceLabel ? { label: product.sourceLabel ?? catalogEntry?.sourceLabel } : {}), ...(official?.url ? { url: official.url } : {}), ...(product.geometrySourceLabel || catalogEntry?.geometrySourceLabel ? { geometryLabel: product.geometrySourceLabel ?? catalogEntry?.geometrySourceLabel } : {}), ...(geometry?.url ? { geometryUrl: geometry.url } : {}), ...(snapshot ? { snapshot } : {}), references: evidence.sourceReferences },
    derivation: { ...(layer?.recipe?.mode ? { mode: layer.recipe.mode } : product.mode ? { mode: product.mode } : {}), coordinateFrame: "ICRS", ordering: "NESTED", ...(layer?.coverageRole ?? product.coverageRole ? { coverageRole: layer?.coverageRole ?? product.coverageRole } : {}), availableOrders, steps: evidence.steps },
    verification: { status, checks, outputHashes },
    limitations,
    actions: { ...(official ? { official } : {}), ...(query ? { query } : {}), ...(data ? { data } : {}), view },
    technicalDownloads,
    links,
    evidenceUrl: `/api/v1/products/${encodeURIComponent(product.productId)}/evidence`,
  };
  return dossier;
}

function publicProductListView(record: ProductRecord): Record<string, unknown> {
  const published = structuredClone(record.published!);
  const coverage = productCoverage(record);
  const dossier = buildPublicProductDossier(record);
  return { ...published, ...(coverage ? { coverage } : {}), detailUrl: `/api/v1/products/${encodeURIComponent(record.productId)}`, evidenceUrl: dossier.evidenceUrl, links: dossier.links };
}

function adminProductView(record: ProductRecord): Record<string, unknown> {
  const mocBuild = adminMocBuildSummary(record.productId);
  return { ...record, ...(productCoverage(record) ? { coverage: productCoverage(record) } : {}), ...(mocBuild ? { mocBuild } : {}), lifecycle: adminProductLifecycle(record, mocBuild ? mocBuildStore.get(String(mocBuild.name)) : undefined) };
}

function adminProductSummaries(records: ProductRecord[]): Array<Record<string, unknown>> {
  const grouped = new Map<string, { surveyId: string; productCount: number; publishedCount: number; releases: Set<string>; availableOrders: Set<number>; maxOrder: number | null }>();
  for (const record of records) {
    const surveyId = record.draft.surveyId;
    const summary = grouped.get(surveyId) ?? { surveyId, productCount: 0, publishedCount: 0, releases: new Set<string>(), availableOrders: new Set<number>(), maxOrder: null };
    summary.productCount += 1;
    if (record.published) summary.publishedCount += 1;
    summary.releases.add(record.draft.releaseId);
    const coverage = productCoverage(record);
    if (coverage && Array.isArray(coverage.availableOrders)) coverage.availableOrders.forEach((order) => summary.availableOrders.add(order as number));
    if (coverage && typeof coverage.maxOrder === "number") summary.maxOrder = Math.max(summary.maxOrder ?? 0, coverage.maxOrder);
    grouped.set(surveyId, summary);
  }
  return [...grouped.values()].sort((a, b) => a.surveyId.localeCompare(b.surveyId)).map((summary) => ({
    surveyId: summary.surveyId,
    productCount: summary.productCount,
    publishedCount: summary.publishedCount,
    releaseCount: summary.releases.size,
    availableOrders: [...summary.availableOrders].sort((a, b) => a - b),
    maxOrder: summary.maxOrder,
  }));
}

function adminProductSurveys(records: ProductRecord[], index: typeof surveyIndex): Array<Record<string, unknown>> {
  const byProductId = new Map(records.map((record) => [record.productId, record]));
  const seen = new Set<string>();
  const surveys = index.surveys.map((survey) => ({
    id: survey.id,
    surveyId: survey.id,
    name: survey.name,
    mission: survey.mission,
    color: survey.color,
    description: survey.description,
    modalities: survey.modalities,
    imageUrl: survey.imageUrl,
    statistics: survey.statistics,
    coverageOrders: survey.coverageOrders,
    releases: survey.releases.map((release) => ({
      id: release.id,
      label: release.label,
      kind: release.kind,
      ...(release.releasedYear !== undefined ? { releasedYear: release.releasedYear } : {}),
      modalities: release.modalities,
      coverageOrders: release.coverageOrders,
      products: release.products.map((product) => {
        const productId = product.productId ?? `${survey.id}:${release.id}:${product.name}`;
        const record = byProductId.get(productId);
        if (record) seen.add(productId);
        const coverage = record ? productCoverage(record) : product.coverage;
        const mocBuild = record ? adminMocBuildSummary(record.productId) : undefined;
        return {
          ...product,
          productId,
          ...(coverage ? { coverage } : {}),
          ...(mocBuild ? { mocBuild } : {}),
          ...(record ? { lifecycle: adminProductLifecycle(record, mocBuild ? mocBuildStore.get(String(mocBuild.name)) : undefined) } : {}),
          review: record ? {
            state: record.published ? "published" : "draft",
            draftRevision: record.revision,
            publishedRevision: record.publishedRevision,
            updatedAt: record.updatedAt,
            publishedAt: record.publishedAt,
          } : { state: "unmatched" },
        };
      }),
    })),
  }));
  const unmatchedProducts = records.filter((record) => !seen.has(record.productId)).map((record) => ({
    productId: record.productId,
    surveyId: record.draft.surveyId,
    releaseId: record.draft.releaseId,
    name: record.draft.name,
    modality: record.draft.modality,
    review: {
      state: record.published ? "unmatched-published" : "unmatched-draft",
      draftRevision: record.revision,
      publishedRevision: record.publishedRevision,
      updatedAt: record.updatedAt,
      publishedAt: record.publishedAt,
    },
  }));
  const unmatchedBuilds = adminUnmatchedMocBuilds();
  const result: Array<Record<string, unknown>> = unmatchedProducts.length ? [...surveys, { id: "__unmatched__", surveyId: "__unmatched__", name: "未匹配公共 Catalog 的产品", mission: "Assets editorial queue", color: "#82979e", description: "这些产品存在于 Assets 编辑存储，但没有对应的公共 survey/release/product 记录。", modalities: [], imageUrl: "", statistics: { publicProducts: unmatchedProducts.length, acquired: 0, overviewOnly: 0, awaitingGeometry: unmatchedProducts.length, notApplicable: 0, footprintCells: 0 }, releases: [], unmatchedProducts }] : [...surveys];
  if (unmatchedBuilds.length) result.push({ id: "__moc-builds__", surveyId: "__moc-builds__", name: "待登记 MOC 构建", mission: "Assets editorial queue", color: "#42d5c4", description: "这些 MOC 已完成构建但尚未绑定到公共 survey / release / product。登记后才能进入产品文稿审核与发布。", modalities: [], imageUrl: "", statistics: { publicProducts: 0, acquired: 0, overviewOnly: 0, awaitingGeometry: unmatchedBuilds.length, notApplicable: 0, footprintCells: 0 }, releases: [], unmatchedBuilds });
  return result;
}
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_FITS_HEADER_BYTES = 256 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;

const staticTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttc": "font/collection",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function securityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(encoded.length),
    "Cache-Control": "no-cache",
  });
  response.end(encoded);
}

function compressedJson(request: IncomingMessage, response: ServerResponse, status: number, body: unknown, cacheControl = "no-cache", etag?: string): void {
  if (etag && request.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) {
    response.writeHead(304, { ETag: etag, "Cache-Control": cacheControl, Vary: "Accept-Encoding" });
    response.end();
    return;
  }
  const raw = Buffer.from(`${JSON.stringify(body)}\n`);
  const accept = String(request.headers["accept-encoding"] ?? "");
  const encoded = /\bbr\b/i.test(accept) ? brotliCompressSync(raw) : /\bgzip\b/i.test(accept) ? gzipSync(raw) : raw;
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(encoded.length), "Cache-Control": cacheControl, Vary: "Accept-Encoding" };
  if (encoded !== raw) headers["Content-Encoding"] = /\bbr\b/i.test(accept) ? "br" : "gzip";
  if (etag) headers.ETag = etag;
  response.writeHead(status, headers);
  if (request.method === "HEAD") response.end(); else response.end(encoded);
}

async function resourcePackageCatalog(catalog: LoadedCatalog): Promise<Record<string, unknown>> {
  const catalogFile = [...catalog.files.values()].find(({ record }) => record.path.endsWith("/packages/catalog.json"));
  if (!catalogFile) throw new Error("Resource package catalog is not present in the Assets release");
  const document = JSON.parse(await readFile(catalogFile.absolutePath, "utf8")) as Record<string, unknown>;
  if (document.schemaVersion !== 3 || document.version !== "3.0.0" || !Array.isArray(document.packages)) {
    throw new Error("Resource package catalog is not v3");
  }
  const packageAssets = [...catalog.files.values()]
    .map(({ record }) => record)
    .filter((record) => record.kind === "package");
  const packages = document.packages.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resource package catalog contains an invalid entry");
    const entry = value as Record<string, unknown>;
    const surveyId = typeof entry.surveyId === "string" ? entry.surveyId : undefined;
    const version = typeof entry.version === "string" ? entry.version : undefined;
    const releases = Array.isArray(entry.releases) ? entry.releases.filter((release): release is string => typeof release === "string") : [];
    const asset = packageAssets.find((candidate) => candidate.surveyId === surveyId
      && candidate.version === version
      && (!candidate.releaseId || releases.includes(candidate.releaseId)));
    return {
      ...entry,
      ...(asset ? { archiveUrl: `/api/v1/assets/${encodeURIComponent(asset.id)}/download` } : {}),
    };
  });
  return { ...document, packages };
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function requestQuery(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://localhost").searchParams;
}

function rangeFrom(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new RangeError("Unsupported Range header");
  let start = match[1] ? Number(match[1]) : Number.NaN;
  let end = match[2] ? Number(match[2]) : Number.NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) throw new RangeError("Empty Range header");
  if (Number.isNaN(start)) {
    const suffix = end;
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("Invalid suffix range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    end = Number.isNaN(end) ? size - 1 : end;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new RangeError("Range is outside the file");
  return { start, end: Math.min(end, size - 1) };
}

function fitsInteger(cards: string[], keyword: string, fallback = 0): number {
  const card = cards.find((entry) => entry.slice(0, 8).trim() === keyword);
  if (!card || card[8] !== "=") return fallback;
  const value = Number.parseInt(card.slice(10).split("/", 1)[0]!.trim(), 10);
  return Number.isSafeInteger(value) ? value : fallback;
}

async function fitsHeaderPreview(filePath: string, size: number): Promise<string> {
  const length = Math.min(size, MAX_FITS_HEADER_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = await open(filePath, "r");
  try { await handle.read(buffer, 0, length, 0); }
  finally { await handle.close(); }

  const output: string[] = [];
  let offset = 0;
  for (let hdu = 0; hdu < 16 && offset + 80 <= buffer.length; hdu += 1) {
    const cards: string[] = [];
    let endOffset = -1;
    for (let cursor = offset; cursor + 80 <= buffer.length; cursor += 80) {
      const card = buffer.toString("ascii", cursor, cursor + 80);
      cards.push(card);
      if (card.slice(0, 8).trim() === "END") { endOffset = cursor + 80; break; }
    }
    if (endOffset < 0) break;
    const extension = cards.find((entry) => entry.slice(0, 8).trim() === "XTENSION");
    const hduType = extension ? extension.slice(10, 30).replaceAll("'", "").trim() : "PRIMARY";
    output.push(`${output.length ? "\n" : ""}[HDU ${hdu}: ${hduType}]`, ...cards.map((card) => card.trimEnd()));

    const headerBytes = Math.ceil((endOffset - offset) / 2880) * 2880;
    const naxis = fitsInteger(cards, "NAXIS");
    const bitpix = Math.abs(fitsInteger(cards, "BITPIX"));
    let elements = naxis > 0 ? 1 : 0;
    for (let axis = 1; axis <= naxis; axis += 1) elements *= Math.max(0, fitsInteger(cards, `NAXIS${axis}`));
    const pcount = Math.max(0, fitsInteger(cards, "PCOUNT"));
    const gcount = Math.max(1, fitsInteger(cards, "GCOUNT", 1));
    const dataBytes = extension?.includes("BINTABLE") || extension?.includes("TABLE")
      ? (Math.max(0, fitsInteger(cards, "NAXIS1")) * Math.max(0, fitsInteger(cards, "NAXIS2")) + pcount) * gcount
      : Math.ceil(bitpix * elements / 8) * gcount + pcount;
    offset += headerBytes + Math.ceil(dataBytes / 2880) * 2880;
  }
  if (!output.length) throw new Error("FITS header does not contain an END card within the preview limit");
  return `${output.join("\n")}\n`;
}

async function textPreview(filePath: string, size: number, type: string): Promise<string> {
  if (type === "application/fits") return fitsHeaderPreview(filePath, size);
  if (type === "application/zip") return zipDirectoryPreview(filePath, size);
  if (size > MAX_TEXT_PREVIEW_BYTES) {
    const handle = await open(filePath, "r");
    const buffer = Buffer.alloc(MAX_TEXT_PREVIEW_BYTES);
    try { await handle.read(buffer, 0, buffer.length, 0); }
    finally { await handle.close(); }
    return `${buffer.toString("utf8")}\n\n[Preview truncated at ${MAX_TEXT_PREVIEW_BYTES} bytes; download the asset for the complete file.]\n`;
  }
  let content = await readFile(filePath, "utf8");
  if (type === "application/json") {
    try { content = `${JSON.stringify(JSON.parse(content), null, 2)}\n`; }
    catch { throw new Error("JSON asset cannot be formatted for preview"); }
  }
  return content;
}

function zipMethodName(method: number): string {
  switch (method) {
    case 0: return "stored";
    case 8: return "deflate";
    case 12: return "bzip2";
    case 14: return "lzma";
    case 93: return "zstd";
    default: return `method-${method}`;
  }
}

async function zipDirectoryPreview(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    // EOCD is at most 65,557 bytes from the end of a classic ZIP archive.
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocdOffset = tail.lastIndexOf(eocd);
    if (eocdOffset < 0 || eocdOffset + 22 > tail.length) throw new Error("ZIP end-of-central-directory record is missing");
    const entries = tail.readUInt16LE(eocdOffset + 10);
    const directorySize = tail.readUInt32LE(eocdOffset + 12);
    const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported by the online preview");
    }
    if (directoryOffset + directorySize > size) throw new Error("ZIP central directory is outside the asset");
    const bytesToRead = Math.min(directorySize, MAX_ZIP_DIRECTORY_BYTES);
    const directory = Buffer.alloc(bytesToRead);
    await handle.read(directory, 0, bytesToRead, directoryOffset);
    const lines = [
      "ZIP archive preview",
      `entries: ${entries}`,
      `central directory: ${directorySize} bytes`,
      "",
      "path\tcompressed\tuncompressed\tmethod",
    ];
    let offset = 0;
    let parsed = 0;
    const signature = 0x02014b50;
    while (offset + 46 <= directory.length && parsed < entries) {
      if (directory.readUInt32LE(offset) !== signature) break;
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const recordLength = 46 + nameLength + extraLength + commentLength;
      if (offset + recordLength > directory.length) break;
      const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\t", " ");
      const compressed = directory.readUInt32LE(offset + 20);
      const uncompressed = directory.readUInt32LE(offset + 24);
      const method = directory.readUInt16LE(offset + 10);
      lines.push(`${name}\t${compressed}\t${uncompressed}\t${zipMethodName(method)}`);
      offset += recordLength;
      parsed += 1;
    }
    if (parsed < entries || directorySize > MAX_ZIP_DIRECTORY_BYTES) {
      lines.push("", `[Preview truncated after ${parsed} of ${entries} entries; download the ZIP for the complete archive.]`);
    }
    return `${lines.join("\n")}\n`;
  } finally {
    await handle.close();
  }
}

async function sendDownload(request: IncomingMessage, response: ServerResponse, loaded: LoadedCatalog, id: string): Promise<void> {
  const entry = loaded.files.get(id);
  if (!entry) return json(response, 404, { error: "Public asset not found" });
  let range: { start: number; end: number } | undefined;
  try {
    range = rangeFrom(request.headers.range, entry.record.sizeBytes);
  } catch {
    response.writeHead(416, { "Content-Range": `bytes */${entry.record.sizeBytes}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? entry.record.sizeBytes - 1;
  const length = end - start + 1;
  const headers: Record<string, string> = {
    "Content-Type": entry.record.mediaType,
    "Content-Length": String(length),
    "Content-Disposition": `attachment; filename="${entry.record.downloadName.replaceAll('"', "")}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"sha256-${entry.record.sha256}"`,
    "X-Content-SHA256": entry.record.sha256,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${entry.record.sizeBytes}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(entry.absolutePath, { start, end }).pipe(response);
}

async function sendPreview(request: IncomingMessage, response: ServerResponse, loaded: LoadedCatalog, id: string): Promise<void> {
  const entry = loaded.files.get(id);
  if (!entry) return json(response, 404, { error: "Public asset not found" });
  const mode = assetPreviewMode(entry.record.mediaType);
  if (!mode) return json(response, 415, { error: "This asset type does not support online preview" });
  const type = entry.record.mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (mode === "text") {
    const details = await stat(entry.absolutePath);
    let content: string;
    try { content = await textPreview(entry.absolutePath, details.size, type); }
    catch { return json(response, 422, { error: "Asset cannot be formatted for preview" }); }
    const body = Buffer.from(content, "utf8");
    let range: { start: number; end: number } | undefined;
    try { range = rangeFrom(request.headers.range, body.length); }
    catch {
      response.writeHead(416, { "Content-Range": `bytes */${body.length}` });
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? body.length - 1;
    const headers: Record<string, string> = {
      "Content-Type": `${type === "application/fits" || type === "application/zip" ? "text/plain" : entry.record.mediaType.split(";", 1)[0]}; charset=utf-8`,
      "Content-Length": String(end - start + 1),
      "Content-Disposition": "inline",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"sha256-${entry.record.sha256}"`,
      "X-Content-SHA256": entry.record.sha256,
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${body.length}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD") { response.end(); return; }
    response.end(body.subarray(start, end + 1));
    return;
  }
  let range: { start: number; end: number } | undefined;
  try { range = rangeFrom(request.headers.range, entry.record.sizeBytes); }
  catch {
    response.writeHead(416, { "Content-Range": `bytes */${entry.record.sizeBytes}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? entry.record.sizeBytes - 1;
  const headers: Record<string, string> = {
    "Content-Type": entry.record.mediaType,
    "Content-Length": String(end - start + 1),
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"sha256-${entry.record.sha256}"`,
    "X-Content-SHA256": entry.record.sha256,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${entry.record.sizeBytes}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") { response.end(); return; }
  createReadStream(entry.absolutePath, { start, end }).pipe(response);
}

async function sendStatic(response: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(siteRoot, requested.endsWith("/") ? path.join(requested, "index.html") : requested);
  const relative = path.relative(siteRoot, resolved);
  const candidate = relative.startsWith("..") || path.isAbsolute(relative) ? path.join(siteRoot, "index.html") : resolved;
  let filePath = candidate;
  try {
    if (!(await stat(filePath)).isFile()) filePath = path.join(siteRoot, "index.html");
  } catch {
    filePath = path.join(siteRoot, "index.html");
  }
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": staticTypes[path.extname(filePath)] ?? "application/octet-stream",
    "Content-Length": String(body.length),
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=86400",
  });
  response.end(body);
}

async function requestJsonBody(request: IncomingMessage, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new AdminHttpError(413, "Request body is too large");
    chunks.push(bytes);
  }
  if (!chunks.length) throw new AdminHttpError(400, "JSON request body is required");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AdminHttpError(400, "Request body must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AdminHttpError(400, "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function expectedRevision(request: IncomingMessage, body: Record<string, unknown>): number | undefined {
  const header = request.headers["if-match"];
  const value = typeof header === "string" ? Number(header.replace(/^\"|\"$/g, "")) : body.revision;
  return value === undefined || value === "" ? undefined : Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

function buildProductContext(productId: unknown): { productId?: string; surveyId?: string; releaseId?: string; workKey?: string; workTitle?: string } {
  if (productId === undefined || productId === null || productId === "") return {};
  if (typeof productId !== "string" || productId.length > 128) throw new AdminHttpError(400, "productId is invalid");
  const product = products.get(productId).draft;
  return {
    productId: product.productId,
    surveyId: product.surveyId,
    releaseId: product.releaseId,
    workKey: `product:${product.productId}`,
    workTitle: `${product.surveyId.toUpperCase()} · ${product.releaseId} · ${product.name}`.slice(0, 255),
  };
}

async function createMocBuild(body: Record<string, unknown>): Promise<ReturnType<MocBuildStore["get"]>> {
  const discoveryRequestName = typeof body.discoveryRequestName === "string" ? body.discoveryRequestName : typeof body.requestName === "string" ? body.requestName : "";
  if (!discoveryRequestName.trim()) throw new AdminHttpError(400, "discoveryRequestName is required");
  const candidateId = typeof body.candidateId === "string" ? body.candidateId : "";
  if (!candidateId.trim()) throw new AdminHttpError(400, "candidateId is required");
  const discovery = await admin.getMocDiscoveryRequest(discoveryRequestName);
  const candidate = resolveMocDiscoveryCandidate(discovery, candidateId);
  const requestedProductId = typeof body.productId === "string" && body.productId.trim() ? body.productId.trim() : undefined;
  if (discovery.productId && requestedProductId && discovery.productId !== requestedProductId) {
    throw new AdminHttpError(400, "productId does not match the discovery work item");
  }
  const product = buildProductContext(discovery.productId ?? requestedProductId);
  const request = await mocBuildStore.create({
    discoveryRequestName: discovery.name,
    candidate,
    ...product,
    ...(discovery.workKey && !product.workKey ? { workKey: discovery.workKey } : {}),
    ...(discovery.workTitle && !product.workTitle ? { workTitle: discovery.workTitle } : {}),
  });
  mocBuildService.enqueue(request, candidate);
  return request;
}

async function retryMocBuild(name: string): Promise<ReturnType<MocBuildStore["get"]>> {
  const existing = mocBuildStore.get(name);
  if (!(existing.phase === "FAILED" || existing.phase === "DUPLICATE")) throw new AdminHttpError(409, `MOC build ${name} is not retryable`);
  const discovery = await admin.getMocDiscoveryRequest(existing.discoveryRequestName);
  const candidate = resolveMocDiscoveryCandidate(discovery, existing.candidateId);
  const request = await mocBuildStore.create({
    discoveryRequestName: discovery.name,
    candidate,
    ...(existing.surveyId ? { surveyId: existing.surveyId } : {}),
    ...(existing.releaseId ? { releaseId: existing.releaseId } : {}),
    ...(existing.productId ? { productId: existing.productId } : {}),
    ...(existing.workKey ? { workKey: existing.workKey } : {}),
    ...(existing.workTitle ? { workTitle: existing.workTitle } : {}),
    name: `${existing.name}-retry`,
  });
  mocBuildService.enqueue(request, candidate);
  return request;
}

async function registerMocBuildProduct(name: string, body: Record<string, unknown>): Promise<{ request: ReturnType<MocBuildStore["get"]>; product: Record<string, unknown> }> {
  const build = mocBuildStore.get(name);
  if (build.phase !== "STAGED") throw new AdminHttpError(409, `MOC build ${name} is not staged`);
  if (build.productId) {
    const existing = products.get(build.productId);
    return { request: build, product: adminProductView(existing) };
  }
  const discovery = await admin.getMocDiscoveryRequest(build.discoveryRequestName);
  const candidate = resolveMocDiscoveryCandidate(discovery, build.candidateId);
  const requestedProductId = typeof body.productId === "string" && body.productId.trim() ? body.productId.trim() : undefined;
  let product: ProductRecord;
  if (requestedProductId) {
    product = products.get(requestedProductId);
    if (product.published) throw new AdminHttpError(409, `Product ${requestedProductId} is already published`);
  } else {
    const defaults = await mocRegistrationDefaults(build);
    const modalities = Array.isArray(body.surveyModalities)
      ? body.surveyModalities.filter((value): value is string => typeof value === "string")
      : typeof body.surveyModalities === "string" ? body.surveyModalities.split(",").map((value) => value.trim()).filter(Boolean) : [];
    const selectedModalities = modalities.length ? modalities : [defaults.values.modality];
    const textOrDefault = (key: MocRegistrationDefaultField): string => {
      const value = body[key];
      return typeof value === "string" && value.trim() ? value : String(defaults.values[key] ?? "");
    };
    const input: MocProductRegistrationInput = {
      surveyId: typeof body.surveyId === "string" ? body.surveyId : "",
      surveyName: typeof body.surveyName === "string" ? body.surveyName : "",
      mission: typeof body.mission === "string" ? body.mission : "",
      surveyDescription: typeof body.surveyDescription === "string" ? body.surveyDescription : "",
      surveyColor: typeof body.surveyColor === "string" ? body.surveyColor : "#42d5c4",
      surveyModalities: selectedModalities,
      releaseId: textOrDefault("releaseId"),
      releaseLabel: textOrDefault("releaseLabel"),
      releaseKind: textOrDefault("releaseKind"),
      ...(typeof body.releasedYear === "number" ? { releasedYear: body.releasedYear } : {}),
      productName: textOrDefault("productName"),
      productDescription: textOrDefault("productDescription"),
      productStatus: textOrDefault("productStatus") as MocProductRegistrationInput["productStatus"],
      modality: textOrDefault("modality"),
      sourceUrl: typeof body.sourceUrl === "string" && body.sourceUrl.trim() ? body.sourceUrl : candidate.candidate.recordUrl ?? candidate.sourceUrl,
      geometrySourceUrl: typeof body.geometrySourceUrl === "string" && body.geometrySourceUrl.trim() ? body.geometrySourceUrl : candidate.mocUrl ?? candidate.sourceUrl,
      ...(typeof body.geometrySourceLabel === "string" ? { geometrySourceLabel: body.geometrySourceLabel } : {}),
      dataOrigin: textOrDefault("dataOrigin") as MocProductRegistrationInput["dataOrigin"],
    };
    product = await products.createMocProduct(input);
    if (product.published) throw new AdminHttpError(409, `Product ${product.productId} is already published`);
  }
  const workTitle = `${product.draft.surveyId.toUpperCase()} · ${product.draft.releaseId} · ${product.draft.name}`.slice(0, 255);
  const request = await mocBuildStore.bindProduct(name, { productId: product.productId, surveyId: product.draft.surveyId, releaseId: product.draft.releaseId, workKey: `product:${product.productId}`, workTitle });
  return { request, product: adminProductView(product) };
}

async function sendAdmin(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (pathname === "/api/v1/admin/config" && request.method === "GET") {
    return json(response, 200, admin.publicConfig());
  }
  if (!admin.config.enabled) return json(response, 404, { error: "Assets administration is disabled" });
  try {
    admin.authorize(adminFromRequest(request));
    const connectorProbeMatch = /^\/api\/v1\/admin\/connectors\/([^/]+)\/probe$/.exec(pathname);
    if (connectorProbeMatch?.[1] && request.method === "POST") {
      return json(response, 200, { connector: await admin.probeConnector(decodeURIComponent(connectorProbeMatch[1])) });
    }
    if (pathname === "/api/v1/admin/connectors" && request.method === "GET") return json(response, 200, { connectors: await admin.listConnectors() });
    if (pathname === "/api/v1/admin/connectors" && request.method === "POST") {
      const input = await requestJsonBody(request) as unknown as ConnectorInput;
      return json(response, 201, { connector: await admin.createConnector(input) });
    }
    if (pathname === "/api/v1/admin/catalog/status" && request.method === "GET") {
      return json(response, 200, { mode: coverageLoadMode, loadedAt: coverageLoadedAt, revision: coverageCatalog.revision, layers: coverageCatalog.layers.length, footprints: coverageCatalog.records.size, warehouseConfigured: evidenceStore.configured });
    }
    if (pathname === "/api/v1/admin/catalog/reload" && request.method === "POST") {
      const catalogState = await reloadRuntimeCoverage();
      surveyIndex = applyPublishedProductMetadata(surveyIndex);
      return json(response, 200, { catalog: { ...catalogState, revision: coverageCatalog.revision } });
    }
    if (pathname === "/api/v1/admin/tasks" && request.method === "GET") return json(response, 200, { tasks: await admin.listTasks() });
    if (pathname === "/api/v1/admin/tasks" && request.method === "POST") {
      const input = await requestJsonBody(request) as unknown as CoverageTaskInput & { productId?: string; profileId?: unknown };
      if (input.profileId !== undefined) return json(response, 400, { error: "profileId is no longer supported; submit a product-driven ScanPlan" });
      if (input.productId) {
        const product = products.get(input.productId).draft;
        const executableMode: CoverageTaskInput["mode"] | undefined = product.mode && (SUPPORTED_COVERAGE_MODES as readonly string[]).includes(product.mode)
          ? product.mode as CoverageTaskInput["mode"]
          : undefined;
        const immutable: Array<[keyof CoverageTaskInput, string | undefined]> = [["layerId", product.layerId], ["surveyId", product.surveyId], ["releaseId", product.releaseId], ["product", product.name], ["productId", product.productId], ["modality", product.modality], ["mode", product.mode], ["coverageRole", product.coverageRole], ["dataOrigin", product.dataOrigin], ["sourceTier", product.sourceTier]];
        for (const [key, expected] of immutable) if (input[key] !== undefined && input[key] !== expected) return json(response, 400, { error: `${String(key)} is defined by the selected product` });
        const derived = {
          ...input,
          layerId: product.layerId ?? input.layerId,
          surveyId: product.surveyId,
          releaseId: product.releaseId,
          product: product.name,
          productId: product.productId,
          modality: product.modality,
          mode: executableMode ?? input.mode,
          coverageRole: product.coverageRole ?? input.coverageRole,
          dataOrigin: product.dataOrigin ?? input.dataOrigin,
          sourceTier: product.sourceTier ?? input.sourceTier,
        };
        if (!derived.layerId || !derived.mode || !derived.coverageRole || !derived.dataOrigin || !derived.sourceTier) return json(response, 400, { error: "Selected product is not executable by the configured recipe" });
        return json(response, 201, { task: await admin.createTask(derived) });
      }
      return json(response, 201, { task: await admin.createTask(input) });
    }
    if (pathname === "/api/v1/admin/moc-discovery" && request.method === "GET") {
      return json(response, 200, { requests: await admin.listMocDiscoveryRequests() });
    }
    if (pathname === "/api/v1/admin/moc-discovery" && request.method === "POST") {
      const body = await requestJsonBody(request);
      const input: MocDiscoveryInput = {
        surveyName: body.surveyName as string,
        ...(typeof body.releaseHint === "string" ? { releaseHint: body.releaseHint } : {}),
        ...(typeof body.productHint === "string" ? { productHint: body.productHint } : {}),
        ...(typeof body.surveyId === "string" ? { surveyId: body.surveyId } : {}),
        ...(typeof body.releaseId === "string" ? { releaseId: body.releaseId } : {}),
        ...(typeof body.productId === "string" ? { productId: body.productId } : {}),
        ...(typeof body.workTitle === "string" ? { workTitle: body.workTitle } : {}),
        ...(body.workContext && typeof body.workContext === "object" && !Array.isArray(body.workContext) ? { workContext: body.workContext as MocDiscoveryInput["workContext"] } : {}),
      };
      return json(response, 201, { request: await admin.createMocDiscoveryRequest(input) });
    }
    const mocRetryMatch = /^\/api\/v1\/admin\/moc-discovery\/([^/]+)\/resubmit$/.exec(pathname);
    if (mocRetryMatch?.[1] && request.method === "POST") {
      return json(response, 201, { request: await admin.resubmitMocDiscoveryRequest(decodeURIComponent(mocRetryMatch[1])) });
    }
    const mocMatch = /^\/api\/v1\/admin\/moc-discovery\/([^/]+)$/.exec(pathname);
    if (mocMatch?.[1] && request.method === "GET") {
      return json(response, 200, { request: await admin.getMocDiscoveryRequest(decodeURIComponent(mocMatch[1])) });
    }
    if (pathname === "/api/v1/admin/moc-builds" && request.method === "GET") {
      return json(response, 200, { requests: mocBuildStore.list().map(adminMocBuildView) });
    }
    if (pathname === "/api/v1/admin/moc-builds" && request.method === "POST") {
      return json(response, 201, { request: await createMocBuild(await requestJsonBody(request)) });
    }
    const mocBuildRetryMatch = /^\/api\/v1\/admin\/moc-builds\/([^/]+)\/retry$/.exec(pathname);
    if (mocBuildRetryMatch?.[1] && request.method === "POST") {
      return json(response, 201, { request: await retryMocBuild(decodeURIComponent(mocBuildRetryMatch[1])) });
    }
    const mocBuildRegisterMatch = /^\/api\/v1\/admin\/moc-builds\/([^/]+)\/register-product$/.exec(pathname);
    if (mocBuildRegisterMatch?.[1] && request.method === "POST") {
      return json(response, 201, await registerMocBuildProduct(decodeURIComponent(mocBuildRegisterMatch[1]), await requestJsonBody(request)));
    }
    const mocBuildMatch = /^\/api\/v1\/admin\/moc-builds\/([^/]+)$/.exec(pathname);
    if (mocBuildMatch?.[1] && request.method === "GET") {
      const build = mocBuildStore.get(decodeURIComponent(mocBuildMatch[1]));
      if (build.phase === "STAGED" && !build.productId) {
        try {
          const defaults = await mocRegistrationDefaults(build);
          return json(response, 200, { request: adminMocBuildView(build), registrationDefaults: defaults.values, registrationDefaultSources: defaults.sources });
        } catch {
          // A build detail remains readable even if its discovery evidence has expired.
        }
      }
      return json(response, 200, { request: adminMocBuildView(build) });
    }
    const taskMatch = /^\/api\/v1\/admin\/tasks\/([^/]+)$/.exec(pathname);
    const retryMatch = /^\/api\/v1\/admin\/tasks\/([^/]+)\/resubmit$/.exec(pathname);
    if (taskMatch?.[1] && request.method === "GET") {
      return json(response, 200, { task: await admin.getTask(decodeURIComponent(taskMatch[1])) });
    }
    if (retryMatch?.[1] && request.method === "POST") {
      return json(response, 201, { task: await admin.resubmitTask(decodeURIComponent(retryMatch[1])) });
    }
    if (pathname === "/api/v1/admin/products" && request.method === "GET") {
      const records = products.list();
      const query = requestQuery(request);
      if (query.get("view") === "surveys") return json(response, 200, { surveys: adminProductSurveys(records, applyPublishedProductMetadata(surveyIndex)) });
      const surveyId = query.get("surveyId")?.trim();
      const filtered = surveyId ? records.filter((record) => record.draft.surveyId === surveyId) : records;
      return json(response, 200, { products: filtered.map(adminProductView) });
    }
    const productMatch = /^\/api\/v1\/admin\/products\/([^/]+)$/.exec(pathname);
    const draftMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/draft$/.exec(pathname);
    if (productMatch?.[1] && request.method === "GET") {
      const record = products.get(decodeURIComponent(productMatch[1]));
      return json(response, 200, { product: adminProductView(record) });
    }
    if ((productMatch?.[1] || draftMatch?.[1]) && request.method === "PUT") {
      const body = await requestJsonBody(request);
      const productId = productMatch?.[1] ?? draftMatch?.[1]!;
      return json(response, 200, { product: await products.updateDraft(decodeURIComponent(productId), body.content ?? body, expectedRevision(request, body)) });
    }
    const publishMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/publish$/.exec(pathname);
    if (publishMatch?.[1] && request.method === "POST") {
      const body = await requestJsonBody(request).catch(() => ({}));
      const productId = decodeURIComponent(publishMatch[1]);
      const existing = products.get(productId);
      const revision = expectedRevision(request, body);
      if (revision !== undefined && revision !== existing.revision) throw new AdminHttpError(409, "Product revision conflict");
      const staged = mocBuildStore.list().find((build) => build.productId === productId && build.phase === "STAGED");
      const publication = staged ? await mocPublicationStore.publish(staged, {
        productId,
        surveyId: existing.draft.surveyId,
        releaseId: existing.draft.releaseId,
        name: existing.draft.name,
      }) : undefined;
      const product = await products.publish(productId, revision);
      if (staged && publication) {
        await mocBuildStore.markPublished(staged.name, publication.id);
        await reloadRuntimeCoverage();
      }
      surveyIndex = applyPublishedProductMetadata(surveyIndex);
      const publishedBuild = mocBuildStore.list().find((build) => build.productId === productId);
      return json(response, 200, { product, lifecycle: adminProductLifecycle(product, publishedBuild) });
    }
    const historyMatch = /^\/api\/v1\/admin\/products\/([^/]+)\/history$/.exec(pathname);
    if (historyMatch?.[1] && request.method === "GET") return json(response, 200, { history: await products.history(decodeURIComponent(historyMatch[1])) });
    return json(response, 404, { error: "Admin endpoint not found" });
  } catch (error) {
    if (error instanceof AdminHttpError || error instanceof KubernetesApiError) return json(response, error.statusCode, { error: error.message });
    throw error;
  }
}

function sendCoverageBlock(request: IncomingMessage, response: ServerResponse, pathname: string): void {
  const match = /^\/api\/v1\/coverage\/blocks\/([a-z0-9-]+)$/.exec(pathname);
  if (!match) return json(response, 404, { error: "Coverage block not found" });
  const record = coverageCatalog.records.get(match[1]!);
  if (!record) return json(response, 404, { error: "Coverage layer not found" });
  const query = requestQuery(request);
  const order = Number(query.get("order"));
  const tile = Number(query.get("tile"));
  if (!Number.isSafeInteger(order) || !Number.isSafeInteger(tile) || order < 0 || order > 29 || tile < 0) return json(response, 400, { error: "order and tile are required integers" });
  const block = coverageBlock(record, order, tile);
  if (!block) return json(response, 404, { error: "Coverage block is unavailable" });
  const requestedRevision = query.get("revision");
  if (requestedRevision && requestedRevision !== record.revision) {
    return json(response, 409, { error: "Coverage catalog revision changed", layerId: record.layerId, revision: record.revision });
  }
  const cacheControl = requestedRevision ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
  compressedJson(request, response, 200, { ...block, revision: record.revision }, cacheControl, `"sha256-${block.sha256}"`);
}

async function sendCoverageOverlap(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJsonBody(request).catch(() => ({})) as Record<string, unknown>;
  const surveyIds = Array.isArray(body.surveyIds) ? body.surveyIds.filter((value): value is string => typeof value === "string") : [];
  const requestedOrder = typeof body.requestedOrder === "number" && Number.isInteger(body.requestedOrder) ? body.requestedOrder : undefined;
  const result = overlapForLayers([...coverageCatalog.records.values()], surveyIds, requestedOrder);
  if (!result) return json(response, 400, { error: "At least two surveys with a common HEALPix order are required" });
  const selectedLayers = [...coverageCatalog.records.values()].filter((layer) => surveyIds.includes(layer.surveyId));
  const evidenceLayers = selectedLayers.filter((layer) => layer.sourceUnitIndex?.status === "exact" && layer.sourceUnitIndex.unitKind === "file");
  const needsSourceUnits = result.components.length > 0 && selectedLayers.some((layer) => layer.sourceUnitIndex?.status === "exact" && layer.sourceUnitIndex.unitKind === "tile");
  const sourceUnits = needsSourceUnits ? await sourceUnitsReadyWithin(3_000) : null;
  const componentDetails = await Promise.all(result.components.map(async (component) => {
    const componentCells = new Set(component.cells);
    return { ...component,
    // File-level evidence can be very large for a connected component. The
    // UI already has this component's cells, so it requests the exact bounded
    // file plan only when the user opens that component.
    evidenceLookup: evidenceLayers.length ? {
      endpoint: "/api/v1/coverage/reverse-lookup",
      layerIds: evidenceLayers.map((layer) => layer.layerId),
      order: component.order,
      precision: "exact",
      deferred: true,
    } : undefined,
    surveys: await Promise.all(selectedLayers.filter((layer) => layer.cells.get(component.order)?.some((pixel) => componentCells.has(pixel))).map(async (layer) => ({
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
      modality: layer.modality ?? "coverage",
      sourceUnitIndex: layer.sourceUnitIndex,
      sourceUnits: sourceUnits ? await Promise.resolve(sourceUnits.match(layer.layerId, component.order, component.cells)).catch(() => null) : null,
      downloadUrl: layer.recipe?.sourceUrl,
    }))) };
  }));
  return compressedJson(request, response, 200, { ...result, components: componentDetails }, "public, max-age=60, stale-while-revalidate=120");
}

async function sendCoverageOverlapDetails(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJsonBody(request).catch(() => ({})) as Record<string, unknown>;
  const surveyIds = Array.isArray(body.surveyIds) ? body.surveyIds.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const componentId = typeof body.componentId === "string" ? body.componentId : "";
  const requestedOrder = typeof body.requestedOrder === "number" && Number.isInteger(body.requestedOrder) ? body.requestedOrder : undefined;
  if (surveyIds.length < 2 || !componentId) return json(response, 400, { error: "surveyIds and componentId are required" });
  const result = overlapForLayers([...coverageCatalog.records.values()], surveyIds, requestedOrder);
  if (!result) return json(response, 400, { error: "No common coverage is available for the selected surveys" });
  const component = result.components.find((candidate) => candidate.id === componentId);
  if (!component) return json(response, 404, { error: "Overlap component not found for the current survey selection" });
  const selectedLayers = [...coverageCatalog.records.values()].filter((layer) => surveyIds.includes(layer.surveyId));
  const sourceUnitsByLayer = new Map<string, unknown>();
  if (selectedLayers.some((layer) => layer.sourceUnitIndex?.unitKind === "tile")) {
    const sourceUnits = await sourceUnitsReadyWithin(3_000);
    if (sourceUnits) for (const layer of selectedLayers) {
      if (layer.sourceUnitIndex?.unitKind !== "tile") continue;
      try { sourceUnitsByLayer.set(layer.layerId, await Promise.resolve(sourceUnits.match(layer.layerId, component.order, component.cells))); } catch { /* keep source index metadata only */ }
    }
  }
  const details = buildOverlapDetails({ result, component, layers: selectedLayers, surveyIndex: applyPublishedProductMetadata(surveyIndex), catalog, sourceUnitsByLayer, warehouseSnapshots: warehouseLayerSnapshots });
  return compressedJson(request, response, 200, details, "public, max-age=60, stale-while-revalidate=120");
}

function publicReverseEntrypoints(layerIds: readonly string[], order: number, cells: readonly number[]): Array<Record<string, unknown>> {
  const requested = new Set(cells);
  return layerIds.flatMap((layerId) => {
    const layer = coverageCatalog.records.get(layerId);
    if (!layer) return [];
    const matchedCells = (layer.cells.get(order) ?? []).filter((cell) => requested.has(cell));
    if (!matchedCells.length) return [];
    const survey = surveyIndex.surveys.find((entry) => entry.id === layer.surveyId);
    const release = survey?.releases.find((entry) => entry.id === layer.releaseId);
    const product = release?.products.find((entry) => entry.name === layer.product);
    const sourceUrl = publicExternalUrl(product?.geometrySourceUrl ?? product?.sourceUrl ?? layer.recipe?.sourceUrl);
    const mocAsset = [...catalog.files.entries()].find(([, entry]) => entry.record.kind === "moc"
      && entry.record.surveyId === layer.surveyId
      && entry.record.releaseId === layer.releaseId
      && entry.record.product === layer.product);
    return [{
      layerId,
      productId: layer.productId,
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      product: layer.product,
      order,
      nside: 2 ** order,
      cells: matchedCells,
      precision: "entrypoint-only",
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(mocAsset ? { mocUrl: `/api/v1/coverage/layers/${encodeURIComponent(layerId)}/moc.fits` } : {}),
      note: layer.sourceUnitIndex?.notes ?? "该图层提供公共覆盖入口，但没有文件级反向索引。",
    }];
  });
}

async function sendCoverageReverseLookup(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await requestJsonBody(request).catch(() => ({})) as Record<string, unknown>;
  const layerIds = Array.isArray(body.layerIds) ? body.layerIds.filter((value): value is string => typeof value === "string") : [];
  const cells = Array.isArray(body.cells) ? body.cells.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value)) : [];
  const order = typeof body.order === "number" && Number.isSafeInteger(body.order) ? body.order : Number.NaN;
  const limit = typeof body.limit === "number" && Number.isSafeInteger(body.limit) ? body.limit : undefined;
  if (layerIds.length < 1 || !Number.isSafeInteger(order) || order < 0 || order > 29 || !cells.length) return json(response, 400, { error: "layerIds, order and cells are required" });
  const warehouseLayerIds = layerIds.filter((layerId) => warehouseLayerSnapshots.has(layerId));
  const publicLayerIds = layerIds.filter((layerId) => !warehouseLayerIds.includes(layerId));
  const entrypoints = publicReverseEntrypoints(publicLayerIds, order, cells);
  const warehouseResult: ReverseLookupResult = warehouseLayerIds.length
    ? await evidenceStore.reverseLookup({ layerIds: warehouseLayerIds, order, cells, limit }, { tolerateUnavailable: true })
    : evidenceStore.unavailableResult({ layerIds: [], order, cells }, "这些图层由 Assets 公共 MOC 提供；没有 Warehouse 文件级反向索引。 ");
  const precision = warehouseResult.truncated
    ? "truncated"
    : entrypoints.length
      ? "entrypoint-only"
      : warehouseResult.precision;
  return compressedJson(request, response, 200, {
    ...warehouseResult,
    requested: { ...warehouseResult.requested, layerIds },
    precision,
    entrypoints,
    notes: [...warehouseResult.notes, ...(entrypoints.length ? [`${entrypoints.length} 个公共 MOC 图层仅提供入口级来源。`] : [])],
  }, "public, max-age=30, stale-while-revalidate=60");
}

const server = http.createServer((request, response) => {
  void (async () => {
    securityHeaders(response);
    const pathname = requestPath(request);
    if (pathname.startsWith("/api/v1/admin/")) return sendAdmin(request, response, pathname);
    if (pathname === "/api/v1/coverage/overlap" && request.method === "POST") return sendCoverageOverlap(request, response);
    if (pathname === "/api/v1/coverage/overlap/details" && request.method === "POST") return sendCoverageOverlapDetails(request, response);
    if (pathname === "/api/v1/coverage/reverse-lookup" && request.method === "POST") return sendCoverageReverseLookup(request, response);
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
    if (pathname === "/healthz") return json(response, 200, {
      status: "ok",
      service: "astro-survey-atlas-assets",
      version: "1.0.0",
      bundle: catalog.manifest.bundle,
      files: catalog.files.size,
    });
    if (pathname === "/api/v1/assets") return json(response, 200, publicManifest(catalog, [...publishedPublicAssets.values()].map(({ record }) => record)));
    if (pathname === "/api/v1/resource-packages/catalog.json") return json(response, 200, await resourcePackageCatalog(catalog));
    if (pathname === "/api/v1/coverage/catalog") {
      const { records: _records, ...publicCoverageCatalog } = coverageCatalog;
      const body = { ...publicCoverageCatalog, schemaVersion: 2, generatedAt: coverageLoadedAt };
      const etag = `"catalog-${coverageCatalog.revision ?? "unknown"}"`;
      return compressedJson(request, response, 200, body, "no-cache, must-revalidate", etag);
    }
    if (pathname.startsWith("/api/v1/coverage/blocks/")) return sendCoverageBlock(request, response, pathname);
    if (pathname === "/api/v1/coverage") return json(response, 200, runtimeCoverageManifest);
    if (pathname === "/api/v1/surveys") return json(response, 200, applyPublishedProductMetadata(surveyIndex));
    if (pathname === "/api/v1/products") return json(response, 200, { products: products.list().filter((record) => record.published).map(publicProductListView) });
    const productEvidence = /^\/api\/v1\/products\/([^/]+)\/evidence$/.exec(pathname);
    if (productEvidence?.[1]) {
      const record = products.list().find((candidate) => candidate.productId === decodeURIComponent(productEvidence[1]!));
      if (!record) return json(response, 404, { error: "Product not found" });
      const dossier = buildPublicProductDossier(record);
      // Evidence is deliberately a projection of the dossier. It contains
      // public hashes and checks, never manifests, task snapshots, storage
      // paths or Warehouse documents.
      return json(response, 200, {
        schemaVersion: 1,
        productId: dossier.identity.productId,
        surveyId: dossier.identity.surveyId,
        releaseId: dossier.identity.releaseId,
        product: dossier.identity.name,
        status: dossier.verification.status,
        precision: dossier.coverage.precision,
        source: dossier.source,
        sourceSnapshot: dossier.source.snapshot,
        sourceSnapshotSha256: dossier.source.snapshot?.sha256,
        method: dossier.derivation,
        coordinateFrame: dossier.coverage.coordinateFrame,
        ordering: dossier.coverage.ordering,
        availableOrders: dossier.coverage.availableOrders,
        overviewOrder: dossier.coverage.overviewOrder,
        maxOrder: dossier.coverage.maxOrder,
        areaDeg2: dossier.coverage.areaDeg2,
        coverageRole: dossier.coverage.coverageRole,
        cellCount: dossier.coverage.cellCount,
        cellCounts: dossier.coverage.cellCounts,
        mocUrl: dossier.coverage.mocUrl,
        previewUrl: dossier.coverage.previewUrl,
        checks: dossier.verification.checks,
        limitations: dossier.limitations,
        outputs: dossier.verification.outputHashes,
        outputHashes: dossier.verification.outputHashes,
        steps: dossier.derivation.steps,
        sourceReferences: dossier.source.references,
        next: dossier.actions.data ?? dossier.actions.official,
      });
    }
    const productDetail = /^\/api\/v1\/products\/([^/]+)$/.exec(pathname);
    if (productDetail?.[1]) {
      const record = products.list().find((candidate) => candidate.productId === decodeURIComponent(productDetail[1]!));
      if (!record) return json(response, 404, { error: "Product not found" });
      return json(response, 200, buildPublicProductDossier(record));
    }
    const layerMoc = /^\/api\/v1\/coverage\/layers\/([a-z0-9-]+)\/moc\.fits$/.exec(pathname);
    if (layerMoc?.[1]) {
      const layerId = layerMoc[1]!;
      const layer = coverageCatalog.records.get(layerId);
      const asset = [...catalog.files.entries()].find(([, entry]) => {
        if (entry.record.kind !== "moc") return false;
        if (entry.record.path.includes(`/layers/${layerId}/`) || entry.record.id === `layer-${layerId}-moc` || entry.record.id === layerId) return true;
        return Boolean(layer && entry.record.surveyId === layer.surveyId && entry.record.releaseId === layer.releaseId && entry.record.product === layer.product);
      });
      if (!asset) return json(response, 404, { error: "Coverage MOC not found" });
      return sendDownload(request, response, catalog, asset[0]);
    }
    const download = /^\/api\/v1\/assets\/([a-z0-9-]+)\/download$/.exec(pathname);
    if (download?.[1]) return sendDownload(request, response, catalog, download[1]);
    const preview = /^\/api\/v1\/assets\/([a-z0-9-]+)\/preview$/.exec(pathname);
    if (preview?.[1]) return sendPreview(request, response, catalog, preview[1]);
    if (pathname.startsWith("/api/")) return json(response, 404, { error: "API endpoint not found" });
    if (pathname === "/resources" || pathname.startsWith("/resources/")) return json(response, 404, { error: "Resources route has been split into /github/, /surveys/ and /sdk/" });
    return sendStatic(response, pathname);
  })().catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      const statusCode = error instanceof EvidenceStoreError ? error.statusCode : 500;
      const message = error instanceof EvidenceStoreError && statusCode >= 500 ? "Warehouse evidence service is unavailable" : error instanceof Error ? error.message : "Internal server error";
      json(response, statusCode, { error: message });
    }
    else response.destroy();
  });
});

server.listen(port, host, () => {
  console.log(`astro-survey-atlas-assets listening on http://${host}:${port} with bundle ${catalog.manifest.bundle.sha256}`);
});

function shutdown(): void {
  void sourceUnitsPromise?.then((store) => store.terminate()).catch(() => undefined);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
