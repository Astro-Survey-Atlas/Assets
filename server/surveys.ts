import { readFile } from "node:fs/promises";
import path from "node:path";

import { publicManifest, type LoadedCatalog } from "./catalog.js";
import type { PublicAssetProjection, PublicAssetRecord, PublicCoverageOrderSummary, PublicSurveyCatalog, PublicSurveyRecord } from "./types.js";
import { productId } from "./products.js";

type DownloadableAsset = PublicAssetProjection;

export interface PublicSurveyIndex {
  schemaVersion: 1;
  generatedAt: string;
  surveys: Array<PublicSurveyRecord & {
    imageUrl: string;
    statistics: {
      publicProducts: number;
      acquired: number;
      overviewOnly: number;
      awaitingGeometry: number;
      notApplicable: number;
      footprintCells: number;
    };
    assets: DownloadableAsset[];
  }>;
  sharedAssets: DownloadableAsset[];
}

interface CoverageLayerMeta {
  layerId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  availableOrders: number[];
  overviewOrder: number;
  maxOrder: number;
}

function orderSummary(layers: CoverageLayerMeta[]): PublicCoverageOrderSummary | undefined {
  if (!layers.length) return undefined;
  const availableOrders = [...new Set(layers.flatMap((layer) => layer.availableOrders))].sort((a, b) => a - b);
  const overviewOrders = [...new Set(layers.map((layer) => layer.overviewOrder))].sort((a, b) => a - b);
  return { availableOrders, overviewOrders, maxOrder: Math.max(...layers.map((layer) => layer.maxOrder)) };
}

export async function loadSurveyIndex(
  root: string,
  catalog: LoadedCatalog,
  coverage: { footprints: Array<{ surveyId: string; pixels: number[] }> },
  coverageLayers: CoverageLayerMeta[] = [],
  additionalAssets: PublicAssetRecord[] = [],
): Promise<PublicSurveyIndex> {
  const source = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as PublicSurveyCatalog;
  if (source.schemaVersion !== 1 || !Array.isArray(source.surveys)) throw new Error("Unsupported public survey catalog");
  const assets = publicManifest(catalog, additionalAssets).files;
  const sharedAssets = assets.filter((asset) => !asset.surveyId);
  const surveys = source.surveys.map((survey) => {
    const products = survey.releases.flatMap((release) => release.products);
    const pixels = new Set(coverage.footprints.filter((footprint) => footprint.surveyId === survey.id).flatMap((footprint) => footprint.pixels));
    const surveyLayers = coverageLayers.filter((layer) => layer.surveyId === survey.id);
    const layerByProduct = new Map(surveyLayers.map((layer) => [`${layer.releaseId}:${layer.product}`, layer]));
    return {
      ...survey,
      coverageOrders: orderSummary(surveyLayers),
      releases: survey.releases.map((release) => {
        const releaseLayers = surveyLayers.filter((layer) => layer.releaseId === release.id);
        return {
          ...release,
          coverageOrders: orderSummary(releaseLayers),
          products: release.products.map((product) => {
            const layer = layerByProduct.get(`${release.id}:${product.name}`);
            return {
              ...product,
              productId: productId(survey.id, release.id, product.name),
              ...(layer ? { coverage: { layerId: layer.layerId, availableOrders: layer.availableOrders, overviewOrder: layer.overviewOrder, maxOrder: layer.maxOrder } } : {}),
            };
          }),
        };
      }),
      imageUrl: `/surveys/${encodeURIComponent(survey.id)}.png`,
      statistics: {
        publicProducts: products.length,
        acquired: products.filter((product) => product.status === "acquired").length,
        overviewOnly: products.filter((product) => product.status === "overview_only").length,
        awaitingGeometry: products.filter((product) => product.status === "awaiting_geometry").length,
        notApplicable: products.filter((product) => product.status === "not_applicable").length,
        footprintCells: pixels.size,
      },
      assets: assets.filter((asset) => asset.surveyId === survey.id),
    };
  });
  return { schemaVersion: 1, generatedAt: source.generatedAt, surveys, sharedAssets };
}
