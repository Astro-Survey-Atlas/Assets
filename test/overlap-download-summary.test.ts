import assert from "node:assert/strict";
import test from "node:test";

import type { DownloadComponent, DownloadPlan } from "../site/src/overlap-download.js";
import { buildDownloadSummary, downloadSummaryCsv } from "../site/src/overlap-download-summary.js";

const bounds = { raMin: 1, raMax: 2, decMin: 3, decMax: 4, areaDeg2: 1 };
const comp = (id: string): DownloadComponent => ({ id, order: 8, cells: [1], bounds });
const resolve = (layerId?: string) => ({ surveyId: layerId?.split("-")[0] ?? "", releaseId: "dr1", product: layerId ?? "", modality: "imaging" });
const file = (id: string, layerId: string, ipix: number) => ({
  fileId: id, metadataState: "complete" as const, fileName: `${id}.fits`, fileType: "fits", sizeBytes: 100, downloadable: true,
  downloadUrl: `https://x/${id}.fits`, matchingCoverage: [{ layerId, order: 8, ipix, precision: "exact" }],
});

test("same file reached by two layers and two components appears once with merged layers and cells", () => {
  const plan = (layer: string, ipix: number): DownloadPlan => ({ schemaVersion: 1, files: [file("a", layer, ipix)], entrypoints: [], truncated: false, warnings: [] });
  const summary = buildDownloadSummary([
    { component: comp("C1"), plan: plan("euclid-q1", 5) },
    { component: comp("C2"), plan: plan("euclid-dr1", 6) },
  ], resolve);
  assert.equal(summary.items.length, 1);
  assert.deepEqual(summary.items[0]!.layers, ["euclid-dr1", "euclid-q1"]);
  assert.equal(summary.items[0]!.overlap, "O8:5,6");
  assert.deepEqual(summary.items[0]!.components, ["C1", "C2"]);
  assert.equal(summary.totals.duplicatesRemoved, 1);
  assert.equal(summary.totals.knownBytes, 100);
  const csv = downloadSummaryCsv(summary).split("\r\n");
  assert.equal(csv.length, 3);
  assert.match(csv[1]!, /https:\/\/x\/a\.fits/);
});

test("spatial-unit and entrypoint links already covered by a file are not repeated; coverage-reference entrypoints are skipped", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1, files: [file("a", "desi-dr1", 1)],
    spatialUnits: [{ layerId: "desi-dr1", productId: "p", surveyId: "desi", releaseId: "dr1", product: "spec", unitKind: "tile", unitId: "t1", order: 8, matchingCells: [1], precision: "exact", accessUri: "https://x/a.fits" },
      { layerId: "desi-dr1", productId: "p", surveyId: "desi", releaseId: "dr1", product: "spec", unitKind: "tile", unitId: "t2", order: 8, matchingCells: [2], precision: "estimated", accessUri: "https://x/t2/" }],
    entrypoints: [{ kind: "moc", purpose: "coverage-reference", precision: "exact", url: "https://x/moc.fits" }, { kind: "archive", purpose: "data-access", precision: "entrypoint-only", url: "https://x/archive" }],
    truncated: false, warnings: [],
  };
  const summary = buildDownloadSummary([{ component: comp("C1"), plan }], resolve);
  assert.deepEqual(summary.items.map((item) => item.url).sort(), ["https://x/a.fits", "https://x/archive", "https://x/t2/"]);
  assert.equal(summary.items.find((item) => item.url === "https://x/t2/")!.precision, "estimated");
  assert.equal(summary.totals.unknownSizeItems, 2);
});
