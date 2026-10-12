import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { csvRecords, validateEuclidManifest, validateEuclidRow } from "../server/euclid-native-metadata.js";
import { nativeFile } from "../server/native-unit-archive.js";
import { importSurveySnapshot, SurveyNativeIndex, surveyNativeBinding } from "../server/survey-native-index.js";
import { sourceIdsForBinding } from "../server/native-unit-sources.js";
import type { NativeSource, NativeBinding } from "../server/native-unit-model.js";

const source: NativeSource = { id: "euclid-q1-calibrated-frames", revision: 1, surveyId: "euclid", releaseId: "euclid-q1",
  adapter: "euclid-image-metadata", unitKind: "image", title: "Q1 calibrated frames", scope: "Synthetic released frames; not science pixels",
  sourceUrl: "https://eas.esac.esa.int/tap-server/tap/sync", slot: "survey", files: [], updatedAt: "2026-10-10T00:00:00Z" };
const region = "POLYGON ICRS 53 -28 54 -28 54 -27 53 -27";
function frame(id: number, band: "VIS" | "Y") {
  const metadata = { calibrated_frame_oid: String(id), observation_id: "3030", pointing_id: "13408",
    file_name: `EUC_${band}-3030-${id}.fits`, file_path: "/euclid/repository_idr/iqr1/Q1_R1/NIR/3030",
    datalabs_path: "/data/euclid_q1/Q1_R1/NIR/3030", stc_s: region, data_set_release: "Q1_R1",
    instrument_name: band === "VIS" ? "VIS" : "NISP", filter_name: band === "VIS" ? "VIS" : "NIR_Y",
    product_type: "CalibratedFrame" };
  return { unitId: `Q1_R1:calibrated-frame:${id}`, filename: metadata.file_name, instrument: metadata.instrument_name,
    bands: [band], sRegion: region, accessUris: [], sourceMetadata: { ...metadata, coordinateFrame: "ICRS", geometryPrecision: "estimated",
      scienceFileScan: "not-scanned", validPixelMasksChecked: false, metadataRef: "metadata/page.csv", metadataSha256: "" } };
}
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "euclid-frame-fixture-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "metadata")); await mkdir(path.join(root, "normalized"));
  const rows = [frame(1, "VIS"), frame(2, "Y")];
  const keys = Object.keys(rows[0]!.sourceMetadata).filter(key => !["coordinateFrame", "geometryPrecision", "scienceFileScan", "validPixelMasksChecked", "metadataRef", "metadataSha256"].includes(key));
  const csv = keys.join(",") + "\n" + rows.map(row => keys.map(key => JSON.stringify((row.sourceMetadata as Record<string, unknown>)[key])).join(",")).join("\n") + "\n";
  await writeFile(path.join(root, "metadata/page.csv"), csv);
  await writeFile(path.join(root, "metadata/end.csv"), keys.join(",") + "\n");
  const countBody = "total\n2\n";
  await writeFile(path.join(root, "metadata/count.csv"), countBody);
  const count = { ...await nativeFile(root, "metadata/count.csv"), url: source.sourceUrl };
  const page = { ...await nativeFile(root, "metadata/page.csv"), url: source.sourceUrl };
  const end = { ...await nativeFile(root, "metadata/end.csv"), url: source.sourceUrl };
  rows.forEach(row => { row.sourceMetadata.metadataSha256 = page.sha256; });
  await writeFile(path.join(root, "normalized/frames.ndjson.gz"), gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
  const rowFile = { ...await nativeFile(root, "normalized/frames.ndjson.gz"), rows: 2 };
  const manifest = { schemaVersion: 1, adapter: source.adapter, sourceId: source.id, surveyId: "euclid", releaseId: "euclid-q1",
    coordinateFrame: "ICRS", ordering: "NESTED", deliveryClass: "evidence", capturedAt: source.updatedAt,
    rowCount: 2, inventoryComplete: false, queryPagesComplete: true, metadataDocuments: [count, page, end], rowFiles: [rowFile],
    scope: { release: "Q1_R1", table: "q1.calibrated_frame", geometryPrecision: "estimated", scienceFileScan: "not-scanned", validPixelMasksChecked: false },
    sourcePagination: { expectedRowCount: 2, queryPagesComplete: true, pages: [
      { page: 1, status: 200, rows: 2, after: -1, ref: page.ref, sha256: page.sha256, query: "SELECT TOP 500 * FROM q1.calibrated_frame WHERE data_set_release = 'Q1_R1' AND calibrated_frame_oid > -1 ORDER BY calibrated_frame_oid" },
      { page: 2, status: 200, rows: 0, after: 2, ref: end.ref, sha256: end.sha256, query: "SELECT TOP 500 * FROM q1.calibrated_frame WHERE data_set_release = 'Q1_R1' AND calibrated_frame_oid > 2 ORDER BY calibrated_frame_oid" },
    ] } };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, rows, manifest, file: await nativeFile(root, "manifest.json") };
}

test("Euclid calibrated images and Q2 quadrants retain distinct source identities", () => {
  const q1 = { layerId: "euclid-q1-vis-frames", surveyId: "euclid", releaseId: "euclid-q1", product: "Euclid Q1 VIS calibrated frames" };
  assert.equal(surveyNativeBinding(q1)?.unitKind, "image");
  assert.deepEqual(sourceIdsForBinding(q1), [source.id]);
  assert.deepEqual(surveyNativeBinding({ ...q1, product: "Euclid Q1 VIS and NISP calibrated frames" })?.selector, { bands: ["VIS", "Y", "J", "H"] });
  assert.deepEqual(sourceIdsForBinding({ surveyId: "euclid", releaseId: "euclid-q2" }), ["euclid-q2-egbs-quadrants"]);
  assert.deepEqual(sourceIdsForBinding({ surveyId: "euclid", releaseId: "unknown" }), []);
  assert.deepEqual(sourceIdsForBinding({ surveyId: "euclid", releaseId: "euclid-q1", product: "Euclid Q1 VIS" }), ["euclid-q1-bgsub-tiles"]);
  assert.equal(csvRecords('id,note\n1,"a, b and ""quote"""\n')[0]?.note, 'a, b and "quote"');
});

test("Q1 incomplete pagination and substituted source geometry are rejected", async t => {
  const f = await fixture(t);
  assert.throws(() => validateEuclidManifest({ ...f.manifest, sourcePagination: { ...f.manifest.sourcePagination, pages: f.manifest.sourcePagination.pages.slice(0, 1) } }, source), /ordered archive/);
  const countBody = "total\n3\n";
  await writeFile(path.join(f.root, "metadata/count.csv"), countBody);
  f.manifest.metadataDocuments[0] = { ...await nativeFile(f.root, "metadata/count.csv"), url: source.sourceUrl };
  await writeFile(path.join(f.root, f.manifest.rowFiles[0]!.ref), gzipSync(f.rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
  await writeFile(path.join(f.root, "manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(importSurveySnapshot(f.root, await nativeFile(f.root, "manifest.json"), source), /official archive row count/);
  const corrected = await fixture(t);
  assert.throws(() => validateEuclidRow({ ...corrected.rows[0], unitId: "Tile3030" }, source), /relabelled/);
  assert.throws(() => validateEuclidRow({ ...corrected.rows[0], sRegion: "POLYGON ICRS 3 -28 4 -28 4 -27 3 -27" }, source), /disagrees/);
  corrected.rows[0]!.sourceMetadata.file_name = "EUC_substituted.fits";
  await writeFile(path.join(corrected.root, corrected.manifest.rowFiles[0]!.ref), gzipSync(corrected.rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
  corrected.manifest.rowFiles[0] = { ...await nativeFile(corrected.root, corrected.manifest.rowFiles[0]!.ref), rows: 2 };
  await writeFile(path.join(corrected.root, "manifest.json"), JSON.stringify(corrected.manifest));
  await assert.rejects(importSurveySnapshot(corrected.root, await nativeFile(corrected.root, "manifest.json"), source), /not supported by its locked archive page/);
});

test("Q1 managed import and index query select each band's own frame without invented file links", async t => {
  const f = await fixture(t);
  const snapshot = await importSurveySnapshot(f.root, f.file, source);
  const index = await SurveyNativeIndex.build(f.root, "managed/native-units/indexes/fixture/survey-units.sqlite", [source], [snapshot], () => {});
  try {
    const base = { productId: "synthetic-vis", layerId: "euclid-q1-vis-frames", surveyId: "euclid", releaseId: "euclid-q1", product: "Euclid Q1 VIS calibrated frames" };
    const binding: NativeBinding = { ...base, ...surveyNativeBinding(base)!, revision: "fixture", visibility: "published", modality: "imaging" };
    const result = index.lookup(binding, 4, index.sampleCells(binding), 10);
    assert.deepEqual(result.units.map(unit => unit.unitId), ["Q1_R1:calibrated-frame:1"]);
    assert.deepEqual(result.units[0]?.accessUris, []);
    assert.equal(result.units[0]?.sRegion, region);
    assert.equal(result.units[0]?.precision, "estimated");
    assert.equal(index.summaries[0]?.inventoryComplete, false);
    assert.equal(index.summaries[0]?.queryComplete, true);
  } finally { index.close(); }
});
