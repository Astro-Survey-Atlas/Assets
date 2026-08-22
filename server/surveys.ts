import { readFile } from "node:fs/promises";
import path from "node:path";

import { publicManifest, type LoadedCatalog } from "./catalog.js";
import type { PublicAssetProjection, PublicSurveyCatalog, PublicSurveyRecord } from "./types.js";
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

export async function loadSurveyIndex(root: string, catalog: LoadedCatalog, coverage: { footprints: Array<{ surveyId: string; pixels: number[] }> }): Promise<PublicSurveyIndex> {
  const source = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as PublicSurveyCatalog;
  if (source.schemaVersion !== 1 || !Array.isArray(source.surveys)) throw new Error("Unsupported public survey catalog");
  const assets = publicManifest(catalog).files;
  const sharedAssets = assets.filter((asset) => !asset.surveyId);
  const surveys = source.surveys.map((survey) => {
    const products = survey.releases.flatMap((release) => release.products);
    const pixels = new Set(coverage.footprints.filter((footprint) => footprint.surveyId === survey.id).flatMap((footprint) => footprint.pixels));
    return {
      ...survey,
      releases: survey.releases.map((release) => ({ ...release, products: release.products.map((product) => ({ ...product, productId: productId(survey.id, release.id, product.name) })) })),
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
