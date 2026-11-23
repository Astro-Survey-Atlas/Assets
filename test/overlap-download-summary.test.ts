import assert from "node:assert/strict";
import test from "node:test";

import type { DownloadComponent, DownloadPlan } from "../site/src/overlap-download.js";
import { buildDownloadSummary, downloadSummaryCsv, downloadSummaryJson, pickAlternative } from "../site/src/overlap-download-summary.js";

const bounds = { raMin: 1, raMax: 2, decMin: 3, decMax: 4, areaDeg2: 1 };
const comp = (id: string, layerIds: string[] = []): DownloadComponent => ({ id, order: 8, cells: [1], bounds, requested: { layerIds } });
const resolve = (layerId?: string) => ({ surveyId: layerId?.split("-")[0] ?? "", releaseId: layerId?.split("-")[1] ?? "", product: layerId ?? "", modality: "imaging", sourceUrl: `https://official/${layerId}` });
const alt = (uri: string, provider: string, status: string, providerCountryCode?: string) => ({ uri, accessType: "file" as const, provider, status: status as "verified", providerCountryCode });
const unit = (unitId: string, layerId: string, alternatives: ReturnType<typeof alt>[]) => ({
  layerId, productId: "p", surveyId: layerId.split("-")[0]!, releaseId: layerId.split("-")[1]!, product: "prod", unitKind: "tile", unitId,
  order: 8, matchingCells: [1], precision: "exact", accessUris: [{ uri: alternatives[0]!.uri, alternatives }],
});
const plan = (units: ReturnType<typeof unit>[]): DownloadPlan => ({ schemaVersion: 1, files: [], spatialUnits: units, entrypoints: [], truncated: false, warnings: [] });

test("pickAlternative: status first, unavailable never, user preference then region then order", () => {
  const list = [
    { url: "a", provider: "ESA", status: "rule-derived", country: "ES" },
    { url: "b", provider: "IRSA", status: "verified", country: "US" },
    { url: "c", provider: "Mirror CN", status: "verified", country: "CN" },
    { url: "d", provider: "Dead", status: "unavailable" },
  ];
  assert.equal(pickAlternative(list)?.url, "b");
  assert.equal(pickAlternative(list, { locale: "zh" })?.url, "c");
  assert.equal(pickAlternative(list, { preferredProvider: "ESA" })?.url, "a");
  assert.equal(pickAlternative(list, { preferredProvider: "Missing" })?.url, "b");
  assert.equal(pickAlternative([list[3]!]), undefined);
});

test("one preferred link per native-unit, deduplicated across components; csv has exactly three columns", () => {
  const units = [unit("t1", "euclid-dr1", [alt("https://irsa/t1.fits", "IRSA", "verified", "US"), alt("https://esa/t1.fits", "ESA", "source-listed", "ES")])];
  const summary = buildDownloadSummary([{ component: comp("C1"), plan: plan(units) }, { component: comp("C2"), plan: plan(units) }], resolve);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0]!.link, "https://irsa/t1.fits");
  const csv = downloadSummaryCsv(summary, "en").trim().split("\r\n");
  assert.deepEqual(csv, ["survey,release,link", "euclid,dr1,https://irsa/t1.fits"]);
  assert.deepEqual(downloadSummaryJson(summary).items, [{ survey: "euclid", release: "dr1", link: "https://irsa/t1.fits", alternatives: ["https://esa/t1.fits"] }]);
  const preferred = buildDownloadSummary([{ component: comp("C1"), plan: plan(units) }], resolve, { preferredProvider: "ESA" });
  assert.equal(preferred.items[0]!.link, "https://esa/t1.fits");
});

test("a release without file index appears once as official entrypoint only, with the explanatory note", () => {
  const summary = buildDownloadSummary([{ component: comp("C1", ["euclid-dr1", "desi-dr1"]), plan: plan([unit("t1", "euclid-dr1", [alt("https://irsa/t1.fits", "IRSA", "verified")])]) }], resolve);
  assert.deepEqual(summary.entrypointOnly, [{ survey: "desi", release: "dr1", link: "https://official/desi-dr1" }]);
  const csv = downloadSummaryCsv(summary, "zh");
  assert.match(csv, /^# 此天区可能有数据，本站暂无文件索引/);
  assert.match(csv, /desi,dr1（仅官方入口）,https:\/\/official\/desi-dr1/);
  assert.equal(downloadSummaryJson(summary, "zh").note !== undefined, true);
});
