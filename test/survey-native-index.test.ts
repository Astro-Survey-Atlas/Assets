import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { FilesystemArtifactStore } from "../server/artifact-store.js";
import { nativeFile, archiveNativeFile, restoreNativeFile } from "../server/native-unit-archive.js";
import { assertNativeSurvey, nativeMetadataUrl, type NativeBinding, type NativeSource } from "../server/native-unit-model.js";
import { cellsForStcs } from "../server/hst-image-lookup.js";
import { importSurveySnapshot, SurveyNativeIndex, surveyNativeBinding } from "../server/survey-native-index.js";
import { alternativesForAccessUri, casdcProviderStatuses } from "../server/survey-access.js";
import { OVERLAP_DOWNLOAD_HEADER, overlapCsvRows } from "../site/src/overlap-download.js";

const capturedAt = "2026-10-03T08:00:00Z";
const source = (surveyId: string): NativeSource => ({ id: surveyId === "gaia" ? "gaia-dr3-file-partitions" : surveyId === "jwst" ? "jwst-early-release-images" : "galex-public-images",
  revision: 1, surveyId, releaseId: surveyId === "gaia" ? "gaia-dr3" : surveyId === "jwst" ? "dr1" : "galex-gr6-gr7", title: "Synthetic metadata",
  adapter: surveyId === "gaia" ? "gaia-healpix-range" : "mast-observation", unitKind: surveyId === "gaia" ? "healpix-range" : "observation", slot: "survey", scope: "Synthetic public metadata; no science content", files: [], updatedAt: capturedAt,
  sourceUrl: surveyId === "gaia" ? "https://gaia.eu-1.cdn77-storage.com/?prefix=Gaia/gdr3/gaia_source/&delimiter=/" : "https://mast.stsci.edu/api/v0/invoke" });
const binding = (surveyId: string, releaseId: string, layerId: string, product: string): NativeBinding => ({ productId: layerId, layerId, surveyId, releaseId, product,
  revision: "synthetic", visibility: "published", ...surveyNativeBinding({ surveyId, releaseId, layerId, product })! });
async function stage(t: { after(fn: () => unknown): void }, src: NativeSource, input: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "inputs"));
  await writeFile(path.join(root, "inputs/raw-metadata.json"), JSON.stringify(input));
  const metadata = await nativeFile(root, "inputs/raw-metadata.json");
  const document: Record<string, unknown> = { schemaVersion: 1, adapter: src.adapter, surveyId: src.surveyId, releaseId: src.releaseId, capturedAt, coordinateFrame: "ICRS", ordering: "NESTED",
    metadataDocuments: [{ ...metadata, ref: "raw-metadata.json", sourceUrl: src.sourceUrl }], inventoryComplete: false, queryPagesComplete: true, ...input };
  if (input.rows) {
    const rows = input.rows as Array<Record<string, unknown>>;
    await writeFile(path.join(root, "inputs/rows.ndjson.gz"), gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
    const file = await nativeFile(root, "inputs/rows.ndjson.gz");
    document.rowFiles = [{ ...file, ref: "rows.ndjson.gz", rows: rows.length }]; document.rowCount = rows.length; delete document.rows;
  }
  await writeFile(path.join(root, "inputs/manifest.json"), JSON.stringify(document));
  const file = await nativeFile(root, "inputs/manifest.json");
  const snapshot = await importSurveySnapshot(root, file, src);
  return { root, document, file, snapshot };
}

test("Gaia uses inclusive native O8 ranges at both sides of a boundary and keeps O8 under finer queries", async t => {
  const src = source("gaia");
  const files = [[0, 255], [256, 12 * 4 ** 8 - 1]].map(([firstIpix, lastIpix]) => {
    const unitId = `GaiaSource_${String(firstIpix).padStart(6, "0")}-${String(lastIpix).padStart(6, "0")}`;
    return { unitId, filename: `${unitId}.csv.gz`, firstIpix, lastIpix, url: `https://cdn.gea.esac.esa.int/Gaia/gdr3/gaia_source/${unitId}.csv.gz`, sourceMd5: "a".repeat(32), sizeBytes: 123 };
  });
  const f = await stage(t, src, { nativeOrder: 8, listing: { complete: true }, scope: { fileRosterComplete: true }, files });
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  const layer = binding("gaia", "gaia-dr3", "gaia-dr3-main-source-presence", "Gaia DR3 main source presence");
  assert.deepEqual(index.lookup(layer, 8, [255, 256]).units.map(unit => [unit.unitId, unit.matchingCells]), [[files[0]!.unitId, [255]], [files[1]!.unitId, [256]]]);
  assert.equal(index.lookup(layer, 4, [0]).units.length, 1);
  const o8 = index.lookup(layer, 8, [255, 256]);
  assert.equal(o8.units[0]!.accessUris!.length, 1, "a regional mirror is an alternative to the same file, not another file identity");
  assert.deepEqual(o8.units[0]!.accessUris![0]!.alternatives!.map(item => [item.uri, item.status]), [
    [files[0]!.url, "source-listed"],
    [files[0]!.url.replace("cdn.gea.esac.esa.int", "gaia.eu-1.cdn77-storage.com"), "rule-derived"],
  ]);
  assert.equal(o8.units[0]!.accessUris![0]!.alternatives![0]!.providerCountryCode, "ES");
  assert.match(o8.units[0]!.accessUris![0]!.alternatives![0]!.servingRegion!, /Chicago.*edge can vary/);
  assert.equal(o8.units[0]!.accessUris![0]!.alternatives![1]!.providerCountryCode, undefined, "do not infer country from the eu-1 hostname");
  const finer = index.lookup(layer, 10, [256 * 16]);
  assert.equal(finer.units[0]!.nativePartition!.order, 8);
  assert.equal(finer.units[0]!.precision, "estimated");
  assert.equal(finer.units[0]!.sourceMetadata!.checksumStatus, "upstream-declared");
  const csv = overlapCsvRows({ id: "C01", order: 10, cells: [256 * 16], bounds: { raMin: 0, raMax: 1, decMin: 0, decMax: 1, areaDeg2: 1 } },
    { schemaVersion: 1, spatialUnits: finer.units, files: [], entrypoints: [], warnings: [], truncated: false }, () => ({ ...layer, modality: "catalog" }));
  const exported = Object.fromEntries(OVERLAP_DOWNLOAD_HEADER.map((key, index) => [key, csv[0]![index]]));
  assert.deepEqual(JSON.parse(exported.native_partition!), finer.units[0]!.nativePartition);
  assert.deepEqual(JSON.parse(exported.source_metadata!), JSON.parse(JSON.stringify(finer.units[0]!.sourceMetadata)));
  assert.deepEqual(JSON.parse(exported.access_uris!), finer.units[0]!.accessUris);
  assert.equal(exported.source_snapshot_sha256, f.file.sha256);
  const limited = index.lookup(layer, 8, [255, 256], 1);
  assert.equal(limited.queryExhausted, false); assert.equal(limited.truncated, true);
  // Every managed index/input dependency survives an isolated, byte-verified archive restore.
  const store = new FilesystemArtifactStore(path.join(f.root, "objects"));
  const restoreRoot = path.join(f.root, "restored");
  for (const file of [...f.snapshot.files, await nativeFile(f.root, "index.sqlite")]) {
    const archived = await archiveNativeFile(store, f.root, file, () => {});
    await restoreNativeFile(store, restoreRoot, archived);
    assert.equal((await nativeFile(restoreRoot, file.ref)).sha256, file.sha256);
  }
  const restored = SurveyNativeIndex.open(path.join(restoreRoot, "index.sqlite"), index.buildKey);
  assert.deepEqual(restored.lookup(layer, 8, [256]).units, index.lookup(layer, 8, [256]).units); restored.close();
  const manifest = { ...f.document, files: [files[0], { ...files[1], firstIpix: 255 }] };
  await writeFile(path.join(f.root, "inputs/bad.json"), JSON.stringify(manifest));
  await assert.rejects(importSurveySnapshot(f.root, await nativeFile(f.root, "inputs/bad.json"), src), /overlapping/);
});

const footprint = "CIRCLE ICRS 291.44945899 75.14693546 0.625";
const mastRow = (id: string, release: string, filters: string) => {
  const suffix = filters === "FUV" ? "fd-exp" : "nd-int";
  const field = String(Number(id) - 9038).padStart(2, "0");
  const dataURL = `http://galex.stsci.edu/data/${release}/pipe/02-vsn/50000-AIS_0/d/01-main/0001-img/07-try/AIS_0_sg${field}-${suffix}.fits.gz`;
  const products = new URL("https://mast.stsci.edu/api/v0/invoke");
  products.searchParams.set("request", JSON.stringify({ service: "Mast.Caom.Products", params: { obsid: id }, format: "json", pagesize: 2000, page: 1 }));
  return { unitId: id, obs_id: "6370915756560875520", objID: id + filters, obs_collection: "GALEX", dataRights: "PUBLIC", dataproduct_type: "image",
    sRegion: footprint, filters, instrument: "GALEX", project: "AIS", provenance_name: "AIS", dataURL,
    accessUris: [{ url: products.toString(), fileName: `MAST-observation-${id}-products.json` }, { url: dataURL, fileName: dataURL.split("/").at(-1) }] };
};

test("GALEX selectors retain GR6 AIS identities and explicit band records without GR7 contamination", async t => {
  const src = source("galex");
  const f = await stage(t, src, { rows: [mastRow("9039", "GR6", "FUV"), mastRow("9039", "GR6", "NUV"), mastRow("9040", "GR7", "FUV"), mastRow("9041", "GR6", "NUV")] });
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  const cells = cellsForStcs(8, Array.from({ length: 12 * 4 ** 8 }, (_, cell) => cell), footprint).slice(0, 2);
  const fuv = index.lookup(binding("galex", "galex-gr6-ais", "galex-fuv", "GALEX AIS FUV imaging"), 8, cells);
  assert.deepEqual(fuv.units.map(unit => unit.unitId), ["9039"]);
  assert.equal(fuv.units[0]!.filters, "FUV");
  assert.equal(fuv.units[0]!.sourceMetadata!.records instanceof Array, true);
  assert.equal(fuv.units[0]!.accessUri, "https://galex.stsci.edu/data/GR6/pipe/02-vsn/50000-AIS_0/d/01-main/0001-img/07-try/AIS_0_sg01-fd-exp.fits.gz");
  assert.equal(fuv.units[0]!.accessUris!.length, 1);
  assert.equal(fuv.units[0]!.accessUris![0]!.alternatives![0]!.status, "rule-derived");
  assert.equal(fuv.units[0]!.accessUris![0]!.alternatives![0]!.httpStatus, 200);
  assert.equal((fuv.units[0]!.sourceMetadata!.entrypoints as Array<{ uri: string }>)[0]!.uri, mastRow("9039", "GR6", "FUV").accessUris[0]!.url);
  assert.equal(fuv.inventoryComplete, false); assert.equal(fuv.queryExhausted, true); assert.equal(fuv.truncated, false);
  const color = index.lookup(binding("galex", "galex-gr6-ais", "galex-color", "GALEX AIS color imaging"), 8, cells);
  assert.deepEqual(color.units.map(unit => unit.unitId), ["9039", "9041"]);
  assert.equal(color.units[0]!.filters, "FUV, NUV");
  assert.equal((color.units[0]!.sourceMetadata!.records as unknown[]).length, 2);
  const all = index.lookup(binding("galex", "galex-gr6-gr7", "galex-all", "GALEX GR6/GR7 imaging"), 8, cells);
  assert.deepEqual(all.units.map(unit => unit.unitId), ["9039", "9040", "9041"]);
  assert.deepEqual(index.lookup(binding("galex", "galex-gr6-ais", "galex-color", "GALEX AIS color imaging"), 8, [0]).units, []);
});

test("JWST file URIs become direct MAST links while Products API remains an entrypoint", async t => {
  const src = source("jwst");
  const row = { ...mastRow("1", "GR6", "F200W"), obs_collection: "JWST", instrument: "NIRCAM/IMAGE", project: "JWST", provenance_name: "CALJWST", proposalId: "2731", targetName: "NGC-3324", calib_level: 3, t_min: 59733.4,
    dataURL: "mast:JWST/product/jw02731-o002_t017_miri_f1800w_i2d.fits" };
  const f = await stage(t, src, { rows: [row, { ...row, unitId: "2", instrument: "MIRI/IMAGE" }, { ...row, unitId: "3", targetName: "OTHER" }] });
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  const layer = binding("jwst", "dr1", "moc-jwst-dr1-611dfe774f60", "Carina NIRCam");
  const matched = index.lookup(layer, 4, index.sampleCells(layer)).units;
  assert.deepEqual(matched.map(unit => unit.unitId), ["1"]);
  assert.match(matched[0]!.accessUri!, /mast\.stsci\.edu\/api\/v0\.1\/Download\/file\?uri=mast%3AJWST%2Fproduct%2F/);
  assert.equal(matched[0]!.accessUris!.length, 1, "the Products API and science file stay separate");
  assert.equal((matched[0]!.sourceMetadata!.entrypoints as Array<{ accessType: string }>)[0]!.accessType, "entrypoint");
  const planned = await stage(t, src, { rows: [{ ...row, provenance_name: "APT", calib_level: -1, t_min: null }] });
  await assert.rejects(SurveyNativeIndex.build(planned.root, "index.sqlite", [src], [planned.snapshot], () => {}), /Planned, test/);
  await assert.rejects(readFile(path.join(planned.root, "index.sqlite")), /ENOENT/);
  assert.throws(() => assertNativeSurvey("csst"), /public surveys/);
  assert.throws(() => assertNativeSurvey("roman"), /public surveys/);
  assert.throws(() => nativeMetadataUrl("https://cdn.gea.esac.esa.int/Gaia/gdr3/gaia_source/file.csv.gz", "gaia-healpix-range"), /metadata source/);
  assert.throws(() => nativeMetadataUrl("https://data.sdss.org/sas/dr9/frames/image.fits", "sdss-field"), /metadata table/);
});

test("SDSS keeps native fields, original window geometry and per-product unverified frame URIs", async t => {
  const src: NativeSource = { ...source("galex"), id: "sdss-dr9-fields", surveyId: "sdss", releaseId: "sdss-dr09", adapter: "sdss-field", unitKind: "field", sourceUrl: "https://data.sdss.org/sas/dr9/env/PHOTO_RESOLVE/window_flist.fits" };
  const sRegion = "POLYGON ICRS 359.9 -0.1 0.1 -0.1 0.1 0.1 359.9 0.1";
  const row = { unitId: "94/301/1/11", sRegion, bands: ["u", "g"], sourceMetadata: { run: 94, rerun: "301", camcol: 1, field: 11, photoStatus: 0, imageStatus: [0, 0, 0, 0, 0], geometryKind: "official-trimmed-field-window" },
    accessUris: ["u", "g"].map(band => ({ band, filename: `frame-${band}-000094-1-0011.fits.bz2`, uri: `https://data.sdss.org/sas/dr9/boss/photoObj/frames/301/94/1/frame-${band}-000094-1-0011.fits.bz2` })) };
  const f = await stage(t, src, { rows: [row] });
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  const layer = binding("sdss", "sdss-dr09", "sdss-g", "DR9 g-band imaging");
  const result = index.lookup(layer, 4, index.sampleCells(layer));
  assert.equal(result.units[0]!.unitId, row.unitId); assert.equal(result.units[0]!.sRegion, sRegion);
  assert.equal(result.units[0]!.filters, "G"); assert.equal(result.units[0]!.accessAvailability, "unverified");
  assert.equal(result.units[0]!.accessUris!.length, 1);
  assert.equal(result.units[0]!.accessUris![0]!.uri, row.accessUris[1]!.uri);
  assert.equal(result.units[0]!.accessUris![0]!.alternatives![0]!.status, "rule-derived");
  assert.equal(result.units[0]!.accessUris![0]!.alternatives![0]!.httpStatus, 200);
  const record = (result.units[0]!.sourceMetadata!.records as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(record.imageStatus, [0, 0, 0, 0, 0]); assert.equal(record.geometryKind, "official-trimmed-field-window"); assert.equal(record.rerun, "301");
  assert.equal(result.queryExhausted, true); assert.equal(result.inventoryComplete, false);
});

test("regional source status remains explicit when a public mirror is currently unavailable", () => {
  const providers = casdcProviderStatuses("gaia", "gaia-dr3");
  assert.deepEqual(providers.map(item => [item.providerCountryCode, item.accessType, item.status, item.httpStatus]), [
    ["CN", "entrypoint", "entrypoint-only", 200],
    ["CN", "directory", "unavailable", 404],
  ]);
  assert.equal(providers[1]!.uri, "https://casdc.china-vo.org/mirror/Gaia");
});

test("Euclid Q1 adds only the checked VIS directory mirror rule", () => {
  const fileName = "EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-ACBD03_20241018T142710.276838Z_00.00.fits";
  const vis = alternativesForAccessUri("https://eas.esac.esa.int/sas-dd/data?FILE_NAME=sample", {
    surveyId: "euclid", releaseId: "euclid-q1", fileName, band: "VIS", accessType: "file",
  });
  assert.equal(vis.length, 2);
  assert.equal(vis[1]!.accessType, "directory");
  assert.equal(vis[1]!.status, "verified");
  assert.equal(vis[1]!.relationship, "directory-entrypoint");
  assert.equal(vis[1]!.providerCountryCode, "US");
  assert.equal(vis[1]!.uri, "https://nasa-irsa-euclid-q1.s3.us-east-1.amazonaws.com/index.html#q1/MER/102018211/VIS/");
  const nisp = alternativesForAccessUri("https://eas.esac.esa.int/sas-dd/data?FILE_NAME=sample", {
    surveyId: "euclid", releaseId: "euclid-q1", fileName: "EUC_MER_BGSUB-MOSAIC-NISP-H_TILE102018211.fits", band: "H",
  });
  assert.equal(nisp.length, 1, "do not infer an unverified NISP mirror path");
});
