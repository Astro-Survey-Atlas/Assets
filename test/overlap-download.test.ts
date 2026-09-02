import assert from "node:assert/strict";
import test from "node:test";

import { OVERLAP_DOWNLOAD_HEADER, overlapCsvRows, type DownloadPlan } from "../site/src/overlap-download.js";

const component = {
  id: "C09",
  order: 8,
  cells: [101, 102],
  bounds: { raMin: 146.4, raMax: 149.6, decMin: -15.4, decMax: -12.0, areaDeg2: 5.35 },
};

const layer = { surveyId: "desi", releaseId: "desi-dr1", product: "DR1 spectra", modality: "spectroscopy" };

function record(row: string[]): Record<string, string> {
  return Object.fromEntries(OVERLAP_DOWNLOAD_HEADER.map((key, index) => [key, row[index] ?? ""]));
}

test("empty download plans do not manufacture placeholder rows", () => {
  const plan: DownloadPlan = { schemaVersion: 1, files: [], entrypoints: [], truncated: false, warnings: [] };
  assert.deepEqual(overlapCsvRows(component, plan, () => layer), []);
});

test("file rows retain local URIs and all matching coverage", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [{
      fileId: "local-file",
      metadataState: "complete",
      fileName: "image.fits",
      sourceUri: "file:///data/images/image.fits",
      downloadable: false,
      matchingCoverage: [
        { layerId: "roman-images", order: 8, ipix: 101, precision: "exact" },
        { layerId: "roman-images", order: 8, ipix: 102, precision: "exact" },
      ],
    }],
    entrypoints: [],
    truncated: false,
    warnings: [],
  };
  const row = record(overlapCsvRows(component, plan, () => ({ ...layer, surveyId: "roman" }))[0]!);
  assert.equal(row.item_kind, "file");
  assert.equal(row.source_uri, "file:///data/images/image.fits");
  assert.equal(row.downloadable, "false");
  assert.deepEqual(JSON.parse(row.matching_cells ?? "[]").map((match: { ipix: number }) => match.ipix), [101, 102]);
});

test("file rows retain an official link and owned URI independently", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [{
      fileId: "owned-file",
      metadataState: "complete",
      fileName: "tile.fits",
      sourceUri: "oss://survey-data/tiles/1234/tile.fits",
      downloadable: true,
      downloadUrl: "https://data.example/tiles/1234/tile.fits",
      matchingCoverage: [{ layerId: "desi", order: 8, ipix: 101, precision: "exact" }],
    }],
    entrypoints: [],
    truncated: false,
    warnings: [],
  };
  const row = record(overlapCsvRows(component, plan, () => layer)[0]!);
  assert.equal(row.source_uri, "oss://survey-data/tiles/1234/tile.fits");
  assert.equal(row.downloadable, "true");
  assert.equal(row.download_url, "https://data.example/tiles/1234/tile.fits");
});

test("tile rows expose the matched cells, tile identity and official directory URL", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [],
    entrypoints: [{
      kind: "tile-directory",
      purpose: "data-access",
      layerId: "desi-dr1-spectra-footprint",
      surveyId: "desi",
      releaseId: "desi-dr1",
      product: "DR1 spectra",
      order: 8,
      nside: 256,
      cells: [101, 102],
      precision: "exact",
      tileId: "1234",
      url: "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/1234/20250101/",
    }],
    truncated: false,
    warnings: [],
  };
  const row = record(overlapCsvRows(component, plan, () => layer)[0]!);
  assert.equal(row.item_kind, "entrypoint");
  assert.equal(row.entrypoint_kind, "tile-directory");
  assert.equal(row.tile_id, "1234");
  assert.deepEqual(JSON.parse(row.matching_cells ?? "[]"), [101, 102]);
  assert.match(row.entrypoint_url ?? "", /tiles\/cumulative\/1234/);
  assert.equal(row.source_file_id, "");
});

test("source-path rows preserve the original locator and tile selection metadata", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [],
    entrypoints: [{
      kind: "source-path",
      purpose: "data-access",
      layerId: "csst-sim-w2-image-extent",
      surveyId: "csst",
      releaseId: "csst-sim-w2-20250731",
      product: "W2 simulated wide-field images",
      order: 8,
      nside: 256,
      cells: [101, 102],
      precision: "entrypoint-only",
      sourceUri: "s3://data-and-computing/projects/CSST/W2_Phot/",
      sourceScope: "prefix",
      note: "原始数据来源前缀；当前计划不展开到每个文件。",
    }, {
      kind: "tile-directory",
      purpose: "data-access",
      layerId: "desi-dr1-spectra-footprint",
      surveyId: "desi",
      releaseId: "desi-dr1",
      product: "DR1 spectra",
      order: 8,
      nside: 256,
      cells: [101],
      precision: "exact",
      tileId: "1234",
      url: "https://data.desi.lbl.gov/public/dr1/tile/1234/",
      sourceUri: "https://data.desi.lbl.gov/public/dr1/tile/1234/",
      sourceScope: "tile-directory",
      required: true,
      selectionComplete: true,
      selectionRule: "all official tile footprints intersecting the current component cells",
    }],
    tileSelections: [{
      layerId: "desi-dr1-spectra-footprint",
      surveyId: "desi",
      releaseId: "desi-dr1",
      product: "DR1 spectra",
      tileIds: ["1234"],
      selectionRule: "all official tile footprints intersecting the current component cells",
      complete: true,
      note: "下载本组件列出的全部 Tile 可获得覆盖当前重合区域的相关数据；Tile 内容可能超出组件边界，未做空间裁剪。",
    }],
    truncated: false,
    warnings: [],
  };
  const rows = overlapCsvRows(component, plan, (layerId) => layerId?.startsWith("csst") ? {
    surveyId: "csst", releaseId: "csst-sim-w2-20250731", product: "W2 simulated wide-field images", modality: "imaging",
  } : layer);
  const source = record(rows[0]!);
  assert.equal(source.item_kind, "source-path");
  assert.equal(source.source_uri, "s3://data-and-computing/projects/CSST/W2_Phot/");
  assert.equal(source.source_scope, "prefix");
  const tile = record(rows[1]!);
  assert.equal(tile.required, "true");
  assert.equal(tile.selection_complete, "true");
  assert.deepEqual(JSON.parse(tile.required_tile_ids!), ["1234"]);
});
