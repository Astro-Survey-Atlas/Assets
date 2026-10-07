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
import { importSurveySnapshot, loadSurveyManifest, matchesPanstarrsListingEvidence, normalizedRow, parsePanstarrsListing, SurveyNativeIndex, surveyNativeBinding } from "../server/survey-native-index.js";
import { sourceIdsForBinding } from "../server/native-unit-sources.js";
import { alternativesForAccessUri, casdcProviderStatuses } from "../server/survey-access.js";
import { OVERLAP_DOWNLOAD_HEADER, overlapCsvRows } from "../site/src/overlap-download.js";

const capturedAt = "2026-10-03T08:00:00Z";
const source = (surveyId: string): NativeSource => ({ id: surveyId === "gaia" ? "gaia-dr3-file-partitions" : surveyId === "jwst" ? "jwst-early-release-images" : "galex-public-images",
  revision: 1, surveyId, releaseId: surveyId === "gaia" ? "gaia-dr3" : surveyId === "jwst" ? "dr1" : "galex-gr6-gr7", title: "Synthetic metadata",
  adapter: surveyId === "gaia" ? "gaia-healpix-range" : "mast-observation", unitKind: surveyId === "gaia" ? "healpix-range" : "observation", slot: "survey", scope: "Synthetic public metadata; no science content", files: [], updatedAt: capturedAt,
  sourceUrl: surveyId === "gaia" ? "https://gaia.eu-1.cdn77-storage.com/?prefix=Gaia/gdr3/gaia_source/&delimiter=/" : "https://mast.stsci.edu/api/v0/invoke" });
const binding = (surveyId: string, releaseId: string, layerId: string, product: string): NativeBinding => ({ productId: layerId, layerId, surveyId, releaseId, product,
  revision: "synthetic", visibility: "published", ...surveyNativeBinding({ surveyId, releaseId, layerId, product })! });
async function stage(t: { after(fn: () => unknown): void }, src: NativeSource, input: Record<string, unknown>, sharedRoot?: string) {
  const root = sharedRoot ?? await mkdtemp(path.join(os.tmpdir(), "survey-native-"));
  if (!sharedRoot) t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = sharedRoot ? path.join(root, "inputs", src.id) : path.join(root, "inputs");
  await mkdir(inputDir, { recursive: true });
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const metadataPath = path.join(inputDir, "raw-metadata.json");
  await writeFile(metadataPath, JSON.stringify(input));
  const metadata = await nativeFile(root, relative(metadataPath));
  const metadataDocuments: Array<Record<string, unknown>> = [{ ...metadata, ref: "raw-metadata.json", sourceUrl: src.sourceUrl }];
  for (const [index, item] of ((input.supportingMetadata ?? []) as Array<{ sourceUrl?: string; content: string }>).entries()) {
    const name = `supporting-metadata-${index + 1}.txt`;
    await writeFile(path.join(inputDir, name), item.content);
    const evidence = await nativeFile(root, relative(path.join(inputDir, name)));
    metadataDocuments.push({ ...evidence, ref: name, sourceUrl: item.sourceUrl ?? src.sourceUrl });
  }
  const document: Record<string, unknown> = { schemaVersion: 1, adapter: src.adapter, surveyId: src.surveyId, releaseId: src.releaseId, capturedAt, coordinateFrame: "ICRS", ordering: "NESTED",
    metadataDocuments, inventoryComplete: false, queryPagesComplete: true, ...input };
  if (input.rows) {
    const rows = input.rows as Array<Record<string, unknown>>;
    const rowsPath = path.join(inputDir, "rows.ndjson.gz");
    await writeFile(rowsPath, gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
    const file = await nativeFile(root, relative(rowsPath));
    document.rowFiles = [{ ...file, ref: "rows.ndjson.gz", rows: rows.length }]; document.rowCount = rows.length; delete document.rows;
  }
  delete document.supportingMetadata;
  const manifestPath = path.join(inputDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(document));
  const manifestFile = await nativeFile(root, relative(manifestPath));
  const snapshot = await importSurveySnapshot(root, manifestFile, src);
  return { root, document, file: manifestFile, snapshot };
}

test("KiDS DR5 gri binds native Tiles and keeps ESO and Astro-WISE source identities separate", () => {
  const layer = { surveyId: "kids", releaseId: "kids-dr5", layerId: "kids-dr5-color-footprint", product: "DR5 gri imaging" };
  assert.deepEqual(surveyNativeBinding(layer), { unitKind: "tile", sourceIds: ["kids-dr5-eso-images"], selector: { bands: ["G", "R", "I"] } });
  assert.deepEqual(sourceIdsForBinding(layer), ["kids-dr5-eso-images"]);
  assertNativeSurvey("kids");
  assert.equal(nativeMetadataUrl("https://archive.eso.org/tap_obs/sync", "eso-obscore-kids").hostname, "archive.eso.org");
  assert.throws(() => nativeMetadataUrl("https://kids.strw.leidenuniv.nl/DR5/kids_dr5.0_sci_wget.sh", "eso-obscore-kids"), /official public metadata source/);
  const [astroWise] = alternativesForAccessUri("http://ds.astro.rug.astro-wise.org:8000/KiDS_DR5.0_195.5_-3.5_i2_sci.fits", {
    surveyId: "kids", releaseId: "kids-dr5", fileName: "KiDS_DR5.0_195.5_-3.5_i2_sci.fits",
  });
  assert.equal(astroWise?.providerCountryCode, "NL");
  assert.equal(astroWise?.status, "source-listed");
  assert.match(astroWise?.note ?? "", /not claimed to be a byte-identical mirror/);
});

test("VPHAS+ DR4 products bind source image identities by their actual filter and accept only ESO TAP", () => {
  const color = { surveyId: "vphas", releaseId: "vphas-dr4", layerId: "vphas-color", product: "VPHAS+ DR4 color imaging" };
  const halpha = { ...color, layerId: "vphas-halpha", product: "VPHAS+ DR4 H-alpha imaging" };
  const gBand = { ...color, layerId: "vphas-g", product: "VPHAS+ DR4 g-band imaging" };
  assert.deepEqual(surveyNativeBinding(color), { unitKind: "image", sourceIds: ["vphas-dr4-eso-images"], selector: { bands: ["U", "G", "R", "I", "HALPHA"] } });
  assert.deepEqual(surveyNativeBinding(halpha)?.selector, { bands: ["HALPHA"] });
  assert.deepEqual(surveyNativeBinding(gBand)?.selector, { bands: ["G"] });
  assert.deepEqual(sourceIdsForBinding(color), ["vphas-dr4-eso-images"]);
  assertNativeSurvey("vphas");
  assert.equal(nativeMetadataUrl("https://archive.eso.org/tap_obs/sync", "eso-obscore-vphas").hostname, "archive.eso.org");
  assert.throws(() => nativeMetadataUrl("https://example.org/tap_obs/sync", "eso-obscore-vphas"), /official public metadata source/);
});

test("IPHAS DR2 binds only recalibration CCD rows and preserves their source-rule image URI", () => {
  const src: NativeSource = { ...source("gaia"), id: "iphas-dr2-pipeline-images", surveyId: "iphas", releaseId: "iphas-dr2",
    adapter: "iphas-dr2-pipeline", unitKind: "ccd", sourceUrl: "https://raw.githubusercontent.com/barentsen/iphas-dr2/e2e47c6964df6bb5fe9909e317ef18f0913698db/scripts/release-preparation/iphas-images-pipeline.fits",
    query: "Pinned IPHAS author pipeline table; only in_dr2 recalibration members bind to the DR2 products",
    scope: "Partial DR2 recalibration-member precursor; final QC is not reconciled", files: [] };
  const layer = { surveyId: "iphas", releaseId: "iphas-dr2", layerId: "iphas-dr2-color", product: "IPHAS DR2 color imaging" };
  assert.deepEqual(surveyNativeBinding({ ...layer, product: "IPHAS DR2 H-alpha imaging" })?.selector, { bands: ["HALPHA"] });
  assert.deepEqual(surveyNativeBinding({ ...layer, product: "IPHAS DR2 r-band imaging" })?.selector, { bands: ["R"] });
  assert.deepEqual(surveyNativeBinding({ ...layer, product: "IPHAS DR2 i-band imaging" })?.selector, { bands: ["I"] });
  assert.deepEqual(sourceIdsForBinding(layer), ["iphas-dr2-pipeline-images"]);
  assert.equal(surveyNativeBinding(layer), undefined, "the aggregate color product must not bypass band-specific source identities");

  const footprint = "POLYGON ICRS 40.3430730489 56.1273298822 41.0252753622 56.1273298822 41.0252753622 56.3203180851 40.3430730489 56.3203180851";
  const row = { unitId: "375643/1", filename: "r375643-1.fits.fz", sRegion: footprint, bands: ["HALPHA"],
    accessUris: [{ sourceId: "iphas-publisher", uri: "http://www.iphas.org/data/images/r375/r375643-1.fits.fz",
      fileName: "r375643-1.fits.fz", accessType: "file", band: "HALPHA" }],
    sourceMetadata: { run: 375643, ccd: 1, inDr2: true, band: "HALPHA", sourceFilename: "r375643-1.fits.fz",
      raMin: 40.34307304889804, raMax: 41.02527536218735, decMin: 56.12732988220369, decMax: 56.32031808508418,
      coordinateFrame: "ICRS", projection: "ZPN", geometrySource: "pinned IPHAS DR2 author pipeline table, four CCD corners, ZPN frame",
      footprint, accessAvailability: "unverified" } };
  assert.equal(normalizedRow(row, src)?.unitId, "375643/1");
  assert.throws(() => normalizedRow({ ...row, accessUris: [{ ...row.accessUris[0]!, uri: "http://www.iphas.org/data/images/r376/r375643-1.fits.fz" }] }, src), /IPHAS DR2 rows/);
  assert.equal(normalizedRow({ ...row, sourceMetadata: { ...row.sourceMetadata, inDr2: false } }, src), undefined);
});

test("Rubin First Look binds its two publisher AVM images as estimated outreach frames", () => {
  const sourceId = "rubin-firstlook-public-images";
  const src: NativeSource = { ...source("gaia"), id: sourceId, surveyId: "rubin", releaseId: "rubin-firstlook",
    adapter: "rubin-firstlook-avm", unitKind: "image", sourceUrl: "https://noirlab.edu/public/images/noirlab2521a/",
    query: "The two original publisher TIFFs listed by the CDS Rubin First Look record", scope: "Two outreach images only", files: [] };
  const layer = { surveyId: "rubin", releaseId: "rubin-firstlook", layerId: "rubin-rubin-firstlook-rubin-first-look-imaging-moc",
    product: "Rubin First Look imaging" };
  assert.deepEqual(surveyNativeBinding(layer), { unitKind: "image", sourceIds: [sourceId], selector: { bands: ["RGB"] } });
  assert.deepEqual(sourceIdsForBinding(layer), [sourceId]);

  const footprint = "POLYGON ICRS 185.3 7.8 187.4 7.1 186.9 6.0 184.8 6.7";
  const row = { unitId: "noirlab2521a", filename: "noirlab2521a.tif", sRegion: footprint, bands: ["RGB"],
    accessUris: [{ sourceId: "noirlab-publisher", uri: "https://storage.noirlab.edu/media/archives/images/original/noirlab2521a.tif",
      fileName: "noirlab2521a.tif", accessType: "file", band: "RGB" }],
    sourceMetadata: { imageId: "noirlab2521a", fileSizeBytes: 15_142_805_372, xmpRef: "metadata/noirlab2521a-range-524-26612.bin",
      xmpSha256: "2434a33aab3fa183b284cb332b503b9d9bfe53f7acc48cec13e58e6df92c1d04",
      captureRef: "metadata/rubin-firstlook-capture.json", coordinateFrame: "ICRS", equinox: "J2000", projection: "TAN", quality: "Position",
      geometrySource: "NOIRLab publisher BigTIFF IFD and AVM XMP range; AVM Position quality", footprint,
      avm: { referenceValue: [186.368524202294, 6.930215747979968], referencePixel: [48_971.5, 25_768],
        scale: [-5.55399208524905e-5, 5.55399208524905e-5], rotation: 48.96, referenceDimension: [97_943, 51_536] } } };
  assert.equal(normalizedRow(row, src)?.unitId, "noirlab2521a");
  assert.throws(() => normalizedRow({ ...row, sourceMetadata: { ...row.sourceMetadata, xmpSha256: "f".repeat(64) } }, src), /Rubin First Look rows/);
});

test("SkyView radio bindings keep exact native filenames and reject unlisted URI shapes", () => {
  const cases = [
    { surveyId: "nvss", releaseId: "nvss-final", sourceId: "nvss-final-native-maps", band: "1400 MHZ", product: "1.4 GHz radio imaging",
      path: "I0000M04.fits.gz", root: "https://skyview.gsfc.nasa.gov/surveys/nvss/", nativeFrame: "FK5(J2000)",
      producer: "National Radio Astronomy Observatory", producerCountry: "US" },
    { surveyId: "sumss", releaseId: "sumss-final", sourceId: "sumss-final-native-maps", band: "843 MHZ", product: "SUMSS 843 MHz imaging",
      path: "Extragalactic/J0000M84.FITS", root: "https://skyview.gsfc.nasa.gov/surveys/sumss/mosaics/", nativeFrame: "FK5(J2000)",
      producer: "University of Sydney SUMSS", producerCountry: "AU" },
    { surveyId: "wenss", releaseId: "wenss-final", sourceId: "wenss-final-native-maps", band: "325 MHZ", product: "WENSS 325 MHz imaging",
      path: "wn30000h.fits.gz", root: "https://skyview.gsfc.nasa.gov/surveys/wenss/", nativeFrame: "FK4(B1950)",
      producer: "WENSS team: NFRA/ASTRON and Leiden Observatory", producerCountry: "NL", rawFrequencyHz: 609_585_595.238 },
  ];
  const points: Array<[number, number]> = Array.from({ length: 128 }, (_, index) => [10 + (index % 16) * 0.01, 30 + Math.floor(index / 16) * 0.01]);
  const footprint = `POLYGON ICRS ${points.map(([ra, dec]) => `${ra.toFixed(8)} ${dec.toFixed(8)}`).join(" ")}`;

  for (const item of cases) {
    const layer = { surveyId: item.surveyId, releaseId: item.releaseId, layerId: `${item.surveyId}-imaging`, product: item.product };
    assert.deepEqual(surveyNativeBinding(layer), { unitKind: "image", sourceIds: [item.sourceId], selector: { bands: [item.band] } });
    assert.deepEqual(sourceIdsForBinding(layer), [item.sourceId]);

    const src: NativeSource = { ...source("gaia"), id: item.sourceId, surveyId: item.surveyId, releaseId: item.releaseId,
      adapter: "skyview-radio-maps", unitKind: "image", sourceUrl: `https://skyview.gsfc.nasa.gov/current/jar/surveys/xml/${item.surveyId}.xml.gz`,
      query: "Parse the complete source-listed SkyView XML roster and capture each actual image header", scope: "Publisher-listed maps only", files: [] };
    const filename = item.path.split("/").at(-1)!;
    const uri = item.root + item.path;
    const conflict = item.surveyId === "wenss";
    const row = { unitId: item.path, filename, sRegion: footprint, bands: [item.band],
      accessUris: [{ sourceId: "skyview-gsfc-us", uri, fileName: filename, accessType: "file", countryCode: "US", band: item.band }],
      sourceMetadata: { relativePath: item.path, fileName: filename, headerStatus: "captured", geometryStatus: "mapped",
        headerSha256: "a".repeat(64), headerBytes: 2880, headerEvidenceRef: "metadata/map-headers.ndjson.gz",
        coordinateFrame: "ICRS", nativeCoordinateFrame: item.nativeFrame, geometrySource: "actual FITS primary-header WCS pixel-edge samples transformed to ICRS",
        geometryPrecision: "estimated", validPixelMasksChecked: false, frameEdgeIcrs: points, footprint,
        mirrorCountry: "US", producerCountry: item.producerCountry, producer: item.producer, publisherBand: item.band,
        rawFrequencyHz: item.rawFrequencyHz, spectralMetadataConflict: conflict } };
    assert.equal(normalizedRow(row, src)?.unitId, item.path);
    if (conflict) {
      assert.equal(normalizedRow(row, src)?.sourceMetadata.spectralMetadataConflict, true);
      assert.equal(normalizedRow(row, src)?.sourceMetadata.rawFrequencyHz, item.rawFrequencyHz);
    }
    assert.throws(() => normalizedRow({ ...row, unitId: `${item.path}?download=1`,
      sourceMetadata: { ...row.sourceMetadata, relativePath: `${item.path}?download=1` } }, src), /SkyView radio row/);
  }
});

test("VIKING DR1 J footprint binds numeric ESO Tile identities and only accepts ESO TAP", () => {
  const layer = { surveyId: "vista", releaseId: "viking", layerId: "vista-viking-j-footprint", product: "VIKING J footprint" };
  assert.deepEqual(surveyNativeBinding(layer), { unitKind: "tile", sourceIds: ["vista-viking-dr1-j-tiles"], selector: { bands: ["J"] } });
  assert.deepEqual(sourceIdsForBinding(layer), ["vista-viking-dr1-j-tiles"]);
  assertNativeSurvey("vista");
  assert.equal(nativeMetadataUrl("https://archive.eso.org/tap_obs/sync", "eso-obscore-viking").hostname, "archive.eso.org");
  assert.throws(() => nativeMetadataUrl("https://example.org/tap_obs/sync", "eso-obscore-viking"), /official public metadata source/);
});

test("Pan-STARRS DR1 exposes only source-listed single-band skycell files with grid evidence", () => {
  const sourceId = "panstarrs-dr1-zone23-skycells";
  const src: NativeSource = { ...source("gaia"), id: sourceId, surveyId: "panstarrs", releaseId: "panstarrs-dr1",
    adapter: "panstarrs-dr1-skycell", unitKind: "tile", sourceUrl: "https://ps1images.stsci.edu/cgi-bin/ps1filenames.py",
    query: "skycell={projection}.{subcell}&type=stack", scope: "Official zone 23 stack file increment", files: [] };
  const gBand = { surveyId: "panstarrs", releaseId: "panstarrs-dr1", layerId: "ps1-g", product: "DR1 g-band imaging" };
  const yBand = { ...gBand, layerId: "ps1-y", product: "DR1 y-band imaging" };
  const color = { ...gBand, layerId: "ps1-color", product: "DR1 color imaging" };
  assert.deepEqual(surveyNativeBinding(gBand), { unitKind: "tile", sourceIds: [sourceId], selector: { bands: ["G"] } });
  assert.deepEqual(surveyNativeBinding(yBand)?.selector, { bands: ["Y"] });
  assert.equal(surveyNativeBinding(color), undefined, "a catalog/color product is not an individual band FITS file");
  assert.deepEqual(sourceIdsForBinding(gBand), [sourceId]);
  assertNativeSurvey("panstarrs");
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).hostname, "ps1images.stsci.edu");
  assert.throws(() => nativeMetadataUrl("https://example.org/cgi-bin/ps1filenames.py", src.adapter), /official public metadata source/);

  const fileName = "rings.v3.skycell.1405.053.stk.g.unconv.fits";
  const sourceFilename = `/rings.v3.skycell/1405/053/${fileName}`;
  const queryUrl = "https://ps1images.stsci.edu/cgi-bin/ps1filenames.py?skycell=1405.053&type=stack";
  const row = {
    unitId: "1405.053",
    sRegion: "POLYGON ICRS 332.817060 1.983023 332.383516 1.983180 332.383617 2.416705 332.817275 2.416513",
    bands: ["G"], filename: fileName,
    accessUris: [{ sourceId: "ps1-stsci", uri: `https://ps1images.stsci.edu${sourceFilename}`, fileName, accessType: "file", band: "G" }],
    sourceMetadata: { zone: 23, projectionId: 1405, subcell: 53, filter: "g", imageType: "stack", badFlag: 0,
      catalogRa: 332.6004516572, catalogDec: 2.1998090576, sourceFilename, coordinateFrame: "FK5(J2000)",
      geometrySource: "official PS1 zone 23 skycell WCS rule; representative FITS header checked",
      gridSha256: "a".repeat(64), listingResponseSha256: "b".repeat(64), queryUrl },
  };
  assert.equal(normalizedRow(row, src)?.unitId, "1405.053");
  const fakeBundle = structuredClone(row);
  fakeBundle.accessUris[0]!.uri = "https://ps1images.stsci.edu/download/stack.tar";
  assert.throws(() => normalizedRow(fakeBundle, src), /source-listed stack skycell/);

  const header = "projcell subcell ra dec filter mjd type filename shortname badflag";
  const sourceRow = `1405 53 332.6004516572 2.1998090576 g 0.0 stack ${sourceFilename} ${fileName} 0`;
  const parsedRow = parsePanstarrsListing(`${header}\n${sourceRow}\n`, "1405.053")[0]!;
  assert.equal(parsedRow.fileName, sourceFilename);
  assert.notEqual(parsedRow.fileName, row.filename, "source evidence retains the full path while normalized filename is a basename");
  assert.equal(matchesPanstarrsListingEvidence(row, { fileName: parsedRow.fileName, responseSha256: "b".repeat(64) }, "a".repeat(64)), true);
  const negativeRaListing = sourceRow.replace("332.6004516572", "-0.1999643937");
  assert.equal(parsePanstarrsListing(`${header}\n${negativeRaListing}\n`, "1405.053")[0]?.ra, 359.8000356063);
  assert.equal(parsePanstarrsListing(`${header}\n`, "1411.999").length, 0);
  assert.throws(() => parsePanstarrsListing(`${header}\n${sourceRow}\n`, "1405.054"), /requested stack skycell/);
});

test("CFHTLS Wide T0007 binds complete field-band products with ICRS evidence and CADC whole-file links", async t => {
  const configuredSources = JSON.parse(await readFile(path.resolve("src/layers/recipes/survey-native-sources.json"), "utf8")) as { sources: NativeSource[] };
  const configured = configuredSources.sources.find(item => item.id === "cfhtls-wide-t0007-single-band-images")!;
  const src: NativeSource = { ...source("gaia"), ...configured, updatedAt: capturedAt };
  const gLayer = { surveyId: "cfhtls", releaseId: "cfhtls-wide", layerId: "cfhtls-g", product: "CFHTLS Wide g-band imaging" };
  const iLayer = { ...gLayer, layerId: "cfhtls-i", product: "CFHTLS Wide i-band imaging" };
  const colorLayer = { ...gLayer, layerId: "cfhtls-color", product: "CFHTLS Wide u/g/i color imaging" };
  assert.deepEqual(surveyNativeBinding(gLayer), { unitKind: "field", sourceIds: [src.id], selector: { bands: ["G"] } });
  assert.deepEqual(surveyNativeBinding(iLayer)?.selector, { bands: ["I"] });
  assert.equal(surveyNativeBinding(colorLayer), undefined, "a color layer must not be mapped to unrelated single-band files");
  assert.deepEqual(sourceIdsForBinding(gLayer), [src.id]);
  assertNativeSurvey("cfhtls");
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).pathname, "/argus/sync");
  assert.throws(() => nativeMetadataUrl("https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/pub/CFHTTERAPIX/", src.adapter), /CADC CAOM TAP/);

  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-cfhtls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "inputs", src.id);
  await mkdir(path.join(input, "metadata"), { recursive: true });
  await mkdir(path.join(input, "normalized"), { recursive: true });
  const metadataDocuments: Array<Record<string, unknown>> = [];
  const refs = ["metadata/table-schema.vot", "metadata/count-before.vot", "metadata/filter-counts-before.vot",
    "metadata/tap-page-001.vot", "metadata/count-after.vot", "metadata/filter-counts-after.vot"];
  for (const ref of refs) {
    const absolute = path.join(input, ref);
    await writeFile(absolute, `locked CADC evidence: ${ref}`);
    metadataDocuments.push({ ...await nativeFile(root, path.relative(root, absolute)), ref, url: src.sourceUrl });
  }
  const pageEvidence = metadataDocuments.find(document => document.ref === "metadata/tap-page-001.vot")!;
  const filters = ["u.MP9301", "g.MP9401", "r.MP9601", "z.MP9801"];
  const rows: Array<Record<string, unknown>> = [];
  const polygon = "polygon 36.91524084390912 -3.699893292981912 36.91588330980907 -4.699786330549173 35.91261669019093 -4.699786330549173 35.91325915609087 -3.699893292981912";
  for (let field = 0; field < 171; field++) {
    const fieldId = `CFHTLS_W_field${String(field).padStart(3, "0")}`;
    const rowFilters = [...filters, field < 139 ? "i.MP9701" : "i.MP9702"];
    for (const filter of rowFilters) {
      const band = filter.startsWith("u.") ? "U" : filter.startsWith("g.") ? "G" : filter.startsWith("r.") ? "R" : filter.startsWith("z.") ? "Z" : "I";
      const filename = `CFHTLS_W_${band.toLowerCase()}_field${String(field).padStart(3, "0")}_T0007_MEDIAN.fits`;
      const productId = filename.slice(0, -5);
      const artifactUri = `cadc:CFHTTERAPIX/${filename}`;
      const uri = `https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/pub/CFHTTERAPIX/${filename}`;
      const region = `POLYGON ICRS ${polygon.slice("polygon ".length)}`;
      rows.push({ unitId: fieldId, sRegion: region, bands: [band], filename,
        accessUris: [{ sourceId: "cadc-cfht-terapix", uri, fileName: filename, accessType: "file", band }],
        sourceMetadata: { collection: "CFHTTERAPIX", observationId: fieldId, productId, provenanceVersion: "T0007",
          energyBandpassName: filter, artifactId: `artifact-${field}-${filter}`, artifactUri, artifactProductType: "science",
          contentType: "application/fits", contentLength: 1498320000, contentChecksum: "md5:5bbeb87faa312d42428f07facc9112ca",
          positionBounds: polygon, chunkCoordinateSystem: "ICRS", positionEquinox: 2000,
          geometrySource: "caom2.Plane.position_bounds corroborated by joined caom2.Chunk.position_coordsys",
          positionDimensions: [19354, 19354], validPixelMasksChecked: false, availabilityChecked: false } });
    }
  }
  const rowsPath = path.join(input, "normalized/native-rows.ndjson.gz");
  await writeFile(rowsPath, gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
  const rowFile = await nativeFile(root, path.relative(root, rowsPath));
  const counts = { "g.MP9401": 171, gri: 80, gry: 19, "i.MP9701": 139, "i.MP9702": 32,
    "r.MP9601": 171, ryg: 11, "u.MP9301": 171, "z.MP9801": 171 };
  const manifest = { schemaVersion: 1, deliveryClass: "evidence", adapter: src.adapter, surveyId: src.surveyId,
    releaseId: src.releaseId, capturedAt, coordinateFrame: "ICRS", nativeCoordinateFrame: "ICRS", ordering: "NESTED",
    inventoryComplete: true, queryPagesComplete: true, rowCount: 855,
    scope: { collection: "CFHTTERAPIX", provenanceVersion: "T0007", observationPattern: "CFHTLS_W_%",
      singleBandMedianImagesOnly: true, fullArchiveInventory: false, expectedRowCount: 855, expectedFieldCount: 171,
      bandCounts: { U: 171, G: 171, R: 171, I: 171, Z: 171 }, filterCounts: counts,
      excludedRgbCount: 110, geometrySource: "caom2.Plane.position_bounds corroborated per file by caom2.Chunk.position_coordsys=ICRS",
      validPixelMasksChecked: false, wholeFileAccess: true },
    sourcePagination: { queryPagesComplete: true, pageSize: 1000, expectedRowCount: 855,
      denominatorBefore: { status: 200, queryStatus: "OK", rowCount: 855, fieldCount: 171 },
      filterCountsBefore: { status: 200, queryStatus: "OK", counts },
      denominatorAfter: { status: 200, queryStatus: "OK", rowCount: 855, fieldCount: 171 },
      filterCountsAfter: { status: 200, queryStatus: "OK", counts }, denominatorsStable: true,
      pages: [{ page: 1, query: src.query, url: src.sourceUrl, status: 200, queryStatus: "OK", overflow: false,
        rows: 855, sha256: pageEvidence.sha256, sizeBytes: pageEvidence.sizeBytes }] },
    metadataDocuments, rowFiles: [{ ...rowFile, ref: "normalized/native-rows.ndjson.gz", rows: 855 }] };
  const manifestPath = path.join(input, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const manifestFile = await nativeFile(root, path.relative(root, manifestPath));
  const snapshot = await importSurveySnapshot(root, manifestFile, src);
  assert.equal(snapshot.rowCount, 855);
  const index = await SurveyNativeIndex.build(root, "index.sqlite", [src], [snapshot], () => {});
  t.after(() => index.close());
  const result = index.lookup(binding("cfhtls", "cfhtls-wide", "cfhtls-g", "CFHTLS Wide g-band imaging"), 4,
    index.sampleCells(binding("cfhtls", "cfhtls-wide", "cfhtls-g", "CFHTLS Wide g-band imaging")));
  assert.equal(result.units.length, 171);
  assert.equal(result.units[0]!.accessUris?.length, 1);
  assert.match(result.units[0]!.accessUri ?? "", /\/data\/pub\/CFHTTERAPIX\/CFHTLS_W_g_field\d{3}_T0007_MEDIAN\.fits$/);
  assert.equal(result.units[0]!.accessUris?.[0]?.band, "G");
  assert.equal(result.units[0]!.sourceMetadata?.inventoryComplete, true);
  assert.equal(result.inventoryComplete, true);
  assert.equal(result.queryExhausted, true);
});

test("AllWISE binds only W3/W4 image products to the complete coadd Tile roster", async t => {
  const sourceId = "allwise-w3-w4-atlas";
  const query = "SELECT TOP 1000 coadd_id, band, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4, crval1, crval2, crpix1, crpix2, naxis1, naxis2, ctype1, ctype2, cdelt1, cdelt2, crota2, equinox, cntr FROM allwise_p3am_cdd WHERE band IN (3,4) ORDER BY coadd_id, band";
  const src: NativeSource = { ...source("allwise"), id: sourceId, surveyId: "allwise", releaseId: "allwise", title: "AllWISE W3/W4 Atlas Tiles",
    adapter: "allwise-ibe-atlas", unitKind: "tile", sourceUrl: "https://irsa.ipac.caltech.edu/TAP/sync", query,
    scope: "Complete official AllWISE W3/W4 intensity roster", files: [] };
  const w3 = { surveyId: "allwise", releaseId: "allwise", layerId: "moc-allwise-allwise-f58150ab415d", product: "W3 imaging" };
  const w4 = { ...w3, layerId: "moc-allwise-allwise-b005bce7321e", product: "W4 imaging" };
  assert.deepEqual(surveyNativeBinding(w3), { unitKind: "tile", sourceIds: [sourceId], selector: { bands: ["W3"] } });
  assert.deepEqual(surveyNativeBinding(w4)?.selector, { bands: ["W4"] });
  assert.deepEqual(sourceIdsForBinding(w3), [sourceId]);
  assertNativeSurvey("allwise");
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).pathname, "/TAP/sync");
  assert.throws(() => nativeMetadataUrl("https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/", src.adapter), /AllWISE TAP/);

  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-allwise-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "inputs", sourceId);
  await mkdir(path.join(input, "metadata"), { recursive: true });
  await mkdir(path.join(input, "normalized"), { recursive: true });
  const metadataDocuments: Array<Record<string, unknown>> = [];
  const addMetadata = async (ref: string) => {
    const absolute = path.join(input, ref);
    await writeFile(absolute, `locked metadata: ${ref}`);
    const file = await nativeFile(root, path.relative(root, absolute));
    const document = { ...file, ref, url: src.sourceUrl, sourceUrl: src.sourceUrl };
    metadataDocuments.push(document);
    return file;
  };
  await addMetadata("metadata/table-schema.vot");
  for (const suffix of ["before", "after"]) {
    for (const name of ["denominator", "band-counts", "w3-distinct", "w4-distinct"]) await addMetadata(`metadata/${name}-${suffix}.vot`);
  }

  const coaddIds = Array.from({ length: 18240 }, (_, index) => `0000m000_ac${String(index).padStart(5, "0")}`);
  const rows: Array<Record<string, unknown>> = [];
  const polygon = "POLYGON ICRS 0.7830000000 -2.2967000000 359.2173000000 -2.2967000000 359.2178000000 -0.7322000000 0.7825000000 -0.7322000000";
  for (const coaddId of coaddIds) for (const bandNumber of [3, 4]) {
    const band = `W${bandNumber}`;
    const fileName = `${coaddId}-w${bandNumber}-int-3.fits`;
    const uri = `https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/${coaddId.slice(0, 2)}/${coaddId.slice(0, 4)}/${coaddId}/${fileName}`;
    rows.push({ unitId: coaddId, sRegion: polygon, bands: [band], filename: fileName,
      accessUris: [{ sourceId: "irsa-allwise-ibe", uri, fileName, accessType: "file", band }],
      sourceMetadata: { table: "allwise_p3am_cdd", coaddId, band, bandNumber, sourceNativeFrame: "FK5(J2000)",
        coordinateTransform: "FK5(equinox=J2000) to ICRS via Astropy",
        sourceCornersJ2000: [[0.783, -2.2967], [359.2173, -2.2967], [359.2178, -0.7322], [0.7825, -0.7322]],
        cornersIcrs: [[0.783, -2.2967], [359.2173, -2.2967], [359.2178, -0.7322], [0.7825, -0.7322]],
        footprint: polygon, geometrySource: "allwise_p3am_cdd ra1/dec1 through ra4/dec4", equinox: 2000,
        sourceWcs: { naxis1: 4095, naxis2: 4095, crval1: 0, crval2: -1.5, crpix1: 2048, crpix2: 2048,
          ctype1: "RA---SIN", ctype2: "DEC--SIN", cdelt1: -0.0003819444, cdelt2: 0.0003819444, crota2: 0 },
        validPixelMasksChecked: false, accessSemantics: "whole-intensity-fits", uriRule: "official AllWISE IBE p3am_cdd path", sourceCounter: "1" } });
  }
  const pages: Array<Record<string, unknown>> = [];
  const queryBeforeOrder = query.slice(0, query.indexOf(" ORDER BY coadd_id, band"));
  for (let index = 0; index < 37; index++) {
    const firstRow = index * 1000;
    const lastRow = firstRow + (index === 36 ? 479 : 999);
    const first = rows[firstRow]!.sourceMetadata as Record<string, unknown>;
    const last = rows[lastRow]!.sourceMetadata as Record<string, unknown>;
    const firstCoaddId = String(first.coaddId), lastCoaddId = String(last.coaddId);
    const firstBand = Number(first.bandNumber), lastBand = Number(last.bandNumber);
    const pageRef = `metadata/tap-page-${String(index + 1).padStart(3, "0")}.vot`;
    const file = await addMetadata(pageRef);
    const expectedQuery = index === 0 ? query
      : `${queryBeforeOrder} AND (coadd_id > '${String((rows[firstRow - 1]!.sourceMetadata as Record<string, unknown>).coaddId)}' OR (coadd_id = '${String((rows[firstRow - 1]!.sourceMetadata as Record<string, unknown>).coaddId)}' AND band > ${Number((rows[firstRow - 1]!.sourceMetadata as Record<string, unknown>).bandNumber)})) ORDER BY coadd_id, band`;
    pages.push({ page: index + 1, query: expectedQuery, url: src.sourceUrl, status: 200, queryStatus: "OK", overflow: false,
      rows: index === 36 ? 480 : 1000, firstCoaddId, firstBand, lastCoaddId, lastBand, sha256: file.sha256, sizeBytes: file.sizeBytes });
  }
  const rowsPath = path.join(input, "normalized/native-rows.ndjson.gz");
  await writeFile(rowsPath, gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
  const rowsFile = await nativeFile(root, path.relative(root, rowsPath));
  const manifest = { schemaVersion: 1, deliveryClass: "evidence", adapter: src.adapter, surveyId: src.surveyId, releaseId: src.releaseId,
    capturedAt, coordinateFrame: "ICRS", nativeCoordinateFrame: "FK5(J2000)", ordering: "NESTED", inventoryComplete: true,
    queryPagesComplete: true, rowCount: 36480,
    scope: { dataset: "AllWISE Image Atlas", table: "allwise_p3am_cdd", bands: ["W3", "W4"], expectedRowCount: 36480,
      expectedCoaddCount: 18240, bandCounts: { W3: 18240, W4: 18240 }, coaddIdSetsEqual: true, validPixelMasksChecked: false },
    sourcePagination: { queryPagesComplete: true, pageSize: 1000, expectedRowCount: 36480, expectedCoaddCount: 18240,
      coaddIdSetsEqual: true, denominator: { status: 200, queryStatus: "OK", rowCount: 36480 },
      bandCounts: { status: 200, queryStatus: "OK", perBandCount: 18240 },
      denominatorAfter: { status: 200, queryStatus: "OK", rowCount: 36480 },
      bandCountsAfter: { status: 200, queryStatus: "OK" }, denominatorsStable: true,
      w3DistinctCoadds: { status: 200, queryStatus: "OK", count: 18240 }, w4DistinctCoadds: { status: 200, queryStatus: "OK", count: 18240 },
      w3DistinctCoaddsAfter: { status: 200, queryStatus: "OK", count: 18240 }, w4DistinctCoaddsAfter: { status: 200, queryStatus: "OK", count: 18240 }, pages },
    metadataDocuments, rowFiles: [{ ...rowsFile, ref: "normalized/native-rows.ndjson.gz", rows: 36480 }] };
  const manifestPath = path.join(input, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const manifestFile = await nativeFile(root, path.relative(root, manifestPath));
  const snapshot = await importSurveySnapshot(root, manifestFile, src);
  assert.equal(snapshot.rowCount, 36480);
});

test("KiDS accepts complete TOP-limited ESO keyset pages with truthful OK statuses", async t => {
  const query = "SELECT TOP 1000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'KIDS' AND release_description = 'https://www.eso.org/rm/api/v1/public/releaseDescriptions/229' AND dataproduct_type = 'image' AND filter IN ('g_SDSS','r_SDSS','i_SDSS') ORDER BY dp_id";
  const src: NativeSource = { id: "kids-dr5-eso-images", revision: 1, surveyId: "kids", releaseId: "kids-dr5", title: "KiDS DR5 image roster",
    adapter: "eso-obscore-kids", unitKind: "tile", slot: "survey", scope: "Complete source-listed DR5 gri image roster", sourceUrl: "https://archive.eso.org/tap_obs/sync", query, files: [], updatedAt: capturedAt };
  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-kids-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "inputs");
  await mkdir(path.join(input, "metadata"), { recursive: true });
  await mkdir(path.join(input, "normalized"), { recursive: true });
  const metadataDocuments: Array<Record<string, unknown>> = [];
  const names = ["kids_dr5.0_sci_wget.sh", "datalinks.ndjson.gz", "denominator.vot", "band-counts.vot", "release-description-229.pdf",
    "tap-page-001.vot", "tap-page-002.vot", "tap-page-003.vot", "tap-page-004.vot", "tap-page-005.vot", "tap-page-006.vot"];
  for (const name of names) {
    const ref = `metadata/${name}`;
    const absolute = path.join(input, ref);
    await writeFile(absolute, `fixture:${name}`);
    metadataDocuments.push({ ...await nativeFile(root, path.relative(root, absolute)), ref,
      sourceUrl: name === "kids_dr5.0_sci_wget.sh" ? "https://kids.strw.leidenuniv.nl/DR5/kids_dr5.0_sci_wget.sh" : src.sourceUrl });
  }
  const rowsPath = path.join(input, "normalized/native-rows.ndjson.gz");
  await writeFile(rowsPath, gzipSync("{}\n"));
  const rowFile = await nativeFile(root, path.relative(root, rowsPath));
  const pageSizes = [1000, 1000, 1000, 1000, 1000, 388];
  const pages = pageSizes.map((rows, index) => {
    const first = `ADP.${String(index * 1000 + 1).padStart(4, "0")}`;
    const last = `ADP.${String(index * 1000 + rows).padStart(4, "0")}`;
    const previousLast = index ? `ADP.${String(index * 1000).padStart(4, "0")}` : "";
    return { status: 200, queryStatus: "OK", overflow: false, rows, firstDpId: first, lastDpId: last,
      query: index ? `${query.replace(" ORDER BY dp_id", "")} AND dp_id > '${previousLast}' ORDER BY dp_id` : query };
  });
  const manifest = {
    schemaVersion: 1, deliveryClass: "evidence", adapter: src.adapter, surveyId: src.surveyId, releaseId: src.releaseId,
    capturedAt, coordinateFrame: "ICRS", nativeCoordinateFrame: "J2000", ordering: "NESTED", queryPagesComplete: true, inventoryComplete: true,
    scope: { releaseDescription: "https://www.eso.org/rm/api/v1/public/releaseDescriptions/229", obsCollection: "KIDS", scienceImageRowsOnly: true,
      expectedRowCount: 5388, expectedTileCount: 1347, sourceRosterRows: 6735, sourceRosterTileCount: 1347, rosterJoinRows: 5388,
      filters: ["g_SDSS", "r_SDSS", "i_SDSS"], bandCounts: { G: 1347, R: 1347, I: 2694 },
      rosterBandCounts: { u: 1347, g: 1347, r: 1347, i: 1347, i2: 1347 }, iEpochCounts: { i: 1347, i2: 1347 } },
    sourcePagination: { queryPagesComplete: true, pageSize: 1000, expectedRowCount: 5388, tileCount: 1347,
      dataLinkRequestedCount: 5388, dataLinkThisCount: 5388, dataLinkErrors: 0,
      denominator: { status: 200, queryStatus: "OK", rowCount: 5388 }, bandCounts: { status: 200, queryStatus: "OK" }, pages },
    metadataDocuments, rowFiles: [{ ...rowFile, ref: "normalized/native-rows.ndjson.gz", rows: 5388 }], rowCount: 5388,
  };
  const manifestPath = path.join(input, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const manifestFile = await nativeFile(root, path.relative(root, manifestPath));
  const loaded = await loadSurveyManifest(root, path.relative(root, manifestPath), src, manifestFile);
  assert.equal(loaded.manifest.sourcePagination.pages[0].queryStatus, "OK");
  assert.equal(loaded.manifest.sourcePagination.pages[5].rows, 388);

  pages[0]!.queryStatus = "OVERFLOW";
  pages[0]!.overflow = true;
  const invalidPath = path.join(input, "invalid-manifest.json");
  await writeFile(invalidPath, JSON.stringify(manifest));
  const invalidFile = await nativeFile(root, path.relative(root, invalidPath));
  await assert.rejects(loadSurveyManifest(root, path.relative(root, invalidPath), src, invalidFile), /complete 5,388-row gri roster/);
});

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

test("survey-native builds reuse a completed locked-input index from an earlier task", async t => {
  const src = source("gaia");
  const files = [[0, 255], [256, 12 * 4 ** 8 - 1]].map(([firstIpix, lastIpix]) => {
    const unitId = `GaiaSource_${String(firstIpix).padStart(6, "0")}-${String(lastIpix).padStart(6, "0")}`;
    return { unitId, filename: `${unitId}.csv.gz`, firstIpix, lastIpix, url: `https://cdn.gea.esac.esa.int/Gaia/gdr3/gaia_source/${unitId}.csv.gz`, sourceMd5: "a".repeat(32), sizeBytes: 123 };
  });
  const f = await stage(t, src, { nativeOrder: 8, listing: { complete: true }, scope: { fileRosterComplete: true }, files });
  const originalRef = "managed/native-units/indexes/first-task/survey-units.sqlite";
  const first = await SurveyNativeIndex.build(f.root, originalRef, [src], [f.snapshot], () => {});
  const buildKey = first.buildKey;
  first.close();

  const messages: string[] = [];
  const retryRef = "managed/native-units/indexes/retry-task/survey-units.sqlite";
  const retry = await SurveyNativeIndex.build(f.root, retryRef, [src], [f.snapshot], message => messages.push(message));
  try {
    assert.equal(retry.buildKey, buildKey);
    assert.equal(retry.fileRef, originalRef);
    assert.ok(messages.some(message => message.includes("Reusing verified survey metadata SQLite")));
    await assert.rejects(readFile(path.join(f.root, retryRef)), /ENOENT/);
  } finally { retry.close(); }
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

test("survey-native builds extend a verified immutable index when adding new source snapshots", async t => {
  const oldSource = source("galex");
  const newSource = source("jwst");
  const oldInput = await stage(t, oldSource, { rows: [mastRow("9039", "GR6", "FUV")] });
  const jwstRow = { ...mastRow("1", "GR6", "F200W"), obs_collection: "JWST", instrument: "NIRCAM/IMAGE", project: "JWST",
    provenance_name: "CALJWST", proposalId: "2731", targetName: "NGC-3324", calib_level: 3, t_min: 59733.4,
    dataURL: "mast:JWST/product/jw02731-o002_t017_nircam_clear-f200w_i2d.fits" };
  const newInput = await stage(t, newSource, { rows: [jwstRow] }, oldInput.root);
  const sources = [oldSource, newSource];
  const originalRef = "managed/native-units/indexes/original/survey-units.sqlite";
  const original = await SurveyNativeIndex.build(oldInput.root, originalRef, sources, [oldInput.snapshot], () => {});
  const originalBuildKey = original.buildKey;
  const galexLayer = binding("galex", "galex-gr6-ais", "galex-fuv", "GALEX AIS FUV imaging");
  const originalCells = cellsForStcs(8, Array.from({ length: 12 * 4 ** 8 }, (_, cell) => cell), footprint).slice(0, 2);
  const originalUnits = original.lookup(galexLayer, 8, originalCells).units;
  original.close();

  const baseFile = await nativeFile(oldInput.root, originalRef);
  const candidateRef = "managed/native-units/indexes/candidate/survey-units.sqlite";
  const extended = await SurveyNativeIndex.build(oldInput.root, candidateRef, sources, [oldInput.snapshot, newInput.snapshot], () => {},
    { file: baseFile, buildKey: originalBuildKey, snapshots: [oldInput.snapshot] });
  t.after(() => extended.close());

  assert.notEqual(extended.buildKey, originalBuildKey);
  assert.deepEqual(extended.summaries.map(summary => summary.sourceId).sort(), [oldSource.id, newSource.id].sort());
  assert.deepEqual(extended.lookup(galexLayer, 8, originalCells).units, originalUnits);
  const jwstLayer = binding("jwst", "dr1", "moc-jwst-dr1-611dfe774f60", "Carina NIRCam");
  assert.deepEqual(extended.lookup(jwstLayer, 4, extended.sampleCells(jwstLayer)).units.map(unit => unit.unitId), ["1"]);

  const untouched = SurveyNativeIndex.open(path.join(oldInput.root, originalRef), originalBuildKey);
  try { assert.deepEqual(untouched.summaries.map(summary => summary.sourceId), [oldSource.id]); }
  finally { untouched.close(); }
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

test("VVV DR4 maps ESO J2000 footprints to existing band and bulge/disk Tile products", async t => {
  const src: NativeSource = { ...source("galex"), id: "vista-vvv-dr4-observations", surveyId: "vista", releaseId: "vista-vvv-dr4",
    adapter: "eso-obscore-vvv", unitKind: "tile", sourceUrl: "https://archive.eso.org/tap_obs/sync",
    scope: "VVV DR4 submission increment; not cumulative inventory" };
  const sRegion = "POLYGON ICRS 266.1 -21.6 266.9 -20.3 268.0 -21.0 267.2 -22.2";
  const makeRow = (tile: string, filter: string, suffix: string) => {
    const dpId = `ADP.2016-05-25T15:33:${suffix}`;
    const dataLinkUrl = `https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?${dpId}`;
    const fileName = `v20140402_${suffix.slice(-3)}_st_tl.fits.fz`;
    const dataLinkListed = filter !== "Ks";
    return {
      unitId: tile, targetName: tile, sRegion, bands: [filter],
      sourceMetadata: { dpId, targetName: tile, filter, nativeCoordinateFrame: "J2000", sourceSRegion: "POLYGON J2000 266.1 -21.6 266.9 -20.3 268.0 -21.0 267.2 -22.2",
        sourceTargetName: tile, nativeTileIdentity: true, releaseDescription: "https://www.eso.org/rm/api/v1/public/releaseDescriptions/80", dataLinkUrl, dataLinkListed, contentLength: dataLinkListed ? 223058880 : undefined },
      accessUris: dataLinkListed ? [{ uri: `https://dataportal.eso.org/dataPortal/file/${dpId}`, fileName, band: filter, accessType: "file" }] : [],
    };
  };
  const calibrator = makeRow("caly-b201", "Y", "722");
  calibrator.sourceMetadata.nativeTileIdentity = false;
  calibrator.sourceMetadata.dataLinkListed = false;
  calibrator.accessUris = [];
  const f = await stage(t, src, { scope: { releaseDescription: "https://www.eso.org/rm/api/v1/public/releaseDescriptions/80", cumulativeInventory: false }, nativeCoordinateFrame: "J2000", queryPagesComplete: true,
    rows: [makeRow("b380", "H", "720"), makeRow("d104", "H", "721"), makeRow("d104", "J", "726"), makeRow("d104", "Y", "870"), makeRow("d104", "Z", "717"), makeRow("d104", "Ks", "267"), calibrator] });
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  assert.equal(assertNativeSurvey("vista"), undefined);
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).hostname, "archive.eso.org");
  assert.throws(() => nativeMetadataUrl("https://archive.eso.org/tap_obs/tables", src.adapter), /ObsCore TAP/);
  const layer = (product: string, layerId = product) => binding("vista", "vista-vvv-dr4", layerId, product);
  const hBulge = index.lookup(layer("VVV DR4 H bulge imaging"), 4, index.sampleCells(layer("VVV DR4 H bulge imaging")));
  const hDisk = index.lookup(layer("VVV DR4 H disk imaging"), 4, index.sampleCells(layer("VVV DR4 H disk imaging")));
  assert.deepEqual(hBulge.units.map(unit => unit.unitId), ["b380"]);
  assert.deepEqual(hDisk.units.map(unit => unit.unitId), ["d104"]);
  assert.equal(hBulge.units[0]!.accessAvailability, "unverified");
  assert.equal(hBulge.units[0]!.accessUris![0]!.uri, "https://dataportal.eso.org/dataPortal/file/ADP.2016-05-25T15:33:720");
  assert.equal(hBulge.units[0]!.accessUris![0]!.alternatives![0]!.providerCountryCode, "ES");
  assert.equal(hBulge.units[0]!.accessUris![0]!.alternatives![0]!.status, "source-listed");
  assert.equal((hBulge.units[0]!.sourceMetadata!.entrypoints as Array<{ uri: string }>)[0]!.uri, "https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?ADP.2016-05-25T15:33:720");
  const color = index.lookup(layer("VVV DR4 J/Y/Z color imaging"), 4, index.sampleCells(layer("VVV DR4 J/Y/Z color imaging")));
  assert.deepEqual(color.units.map(unit => unit.unitId), ["d104"]);
  assert.equal(color.units[0]!.filters, "J, Y, Z");
  assert.equal(color.units[0]!.accessUris!.length, 3);
  assert.equal((color.units[0]!.sourceMetadata!.records as unknown[]).length, 3);
  assert.equal(color.inventoryComplete, false);
  assert.equal(color.queryExhausted, false);
  assert.equal(color.truncated, true);
  assert.match(color.notes.join(" "), /1 metadata rows lack supported release or geometry/);
  assert.equal(surveyNativeBinding({ surveyId: "vista", releaseId: "vista-vvv-dr4", layerId: "x", product: "VVV DR4 Ks imaging" }), undefined);
  assert.throws(() => assertNativeSurvey("csst"), /public surveys/);
});

const fdsQuery = "SELECT TOP 5000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'FDS' AND release_description = 'https://www.eso.org/rm/api/v1/public/releaseDescriptions/157' AND dataproduct_type = 'image' ORDER BY dp_id";
const fdsFields = ["F1", "F2", "F4", "F5", "F6", "F7", "F9", "F10", "F11", "F12", "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F25", "F26", "F27", "F28", "F31", "F33"];
const fdsSource = (): NativeSource => ({ id: "fds-dr1-science-fields", revision: 1, surveyId: "fds", releaseId: "fds-dr1", title: "FDS DR1 science fields",
  adapter: "eso-obscore-fds", unitKind: "field", slot: "survey", scope: "Complete official FDS DR1 science-image roster", sourceUrl: "https://archive.eso.org/tap_obs/sync", query: fdsQuery, files: [], updatedAt: capturedAt });
function fdsRows() {
  const sRegion = "POLYGON ICRS 55.3 -35.0 53.9 -35.0 53.9 -33.8 55.3 -33.8";
  const sourceSRegion = "POLYGON J2000 55.33476 -35.031069 53.910128 -35.0325 53.918524 -33.866384 55.322879 -33.865015";
  const rows: Record<string, unknown>[] = [];
  const filters = ["u_SDSS", "g_SDSS", "r_SDSS", "i_SDSS"];
  const dpSequence = (index: number) => `ADP.2020-08-26T11:45:${String(32 + index).padStart(2, "0")}.${String(index).padStart(3, "0")}`;
  for (const [fieldIndex, field] of fdsFields.entries()) for (const [bandIndex, filter] of filters.entries()) {
    if (filter === "u_SDSS" && fieldIndex >= 20 || filter === "i_SDSS" && fieldIndex >= 25) continue;
    const band = filter[0]!.toUpperCase();
    const dpId = dpSequence(rows.length);
    const filename = `FDS_${field}_OCAM_${filter[0]}_SDSS_sci.fits.fz`;
    const dataLinkUrl = `https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?${dpId}`;
    rows.push({ unitId: `FDS_${field}`, sRegion, bands: [band], filename,
      accessUris: [{ uri: `https://dataportal.eso.org/dataPortal/file/${dpId}`, fileName: filename, band, accessType: "file" }],
      sourceMetadata: { dpId, obsId: `obs-${fieldIndex}`, obsCreatorDid: `ivo://eso.org/origfile?${filename}`, targetName: `FDS_${field}`, sourceTargetName: `FDS_${field}`,
        obsCollection: "FDS", dataproductType: "image", filter, nativeCoordinateFrame: "J2000", sourceSRegion,
        geometryTransform: "FK5(equinox=J2000) polygon vertices transformed to ICRS with Astropy", releaseDescription: "https://www.eso.org/rm/api/v1/public/releaseDescriptions/157",
        dataLinkUrl, dataLinkUri: `https://dataportal.eso.org/dataPortal/file/${dpId}`, dataLinkResponseSha256: "a".repeat(64), dataLinkSemantics: "#this",
        dataLinkCategory: "SCIENCE.IMAGE", dataLinkFileName: filename, esoOriginalFile: filename, dataLinkListed: true, contentLength: 260331840,
        ancillaryWeightMap: { semantics: "#auxiliary", category: "ANCILLARY.WEIGHTMAP", fileName: `FDS_${field}_OCAM_${filter[0]}_SDSS_wei.fits`, uri: `https://dataportal.eso.org/dataPortal/file/ADP.2020-08-26T11:46:00.${String(rows.length).padStart(3, "0")}` },
        accessSemantics: "whole-science-image" } });
  }
  return rows;
}

test("FDS DR1 retains complete science-file fields, source-listed links and actual per-band geometry", async t => {
  const src = fdsSource();
  assert.equal(assertNativeSurvey("fds"), undefined);
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).pathname, "/tap_obs/sync");
  assert.throws(() => nativeMetadataUrl("https://archive.eso.org/tap_obs/tables", src.adapter), /FDS metadata/);
  assert.deepEqual(sourceIdsForBinding({ surveyId: "fds", releaseId: "fds-dr1" }), [src.id]);
  const rows = fdsRows();
  const counts = { U: 20, G: 26, R: 26, I: 25 };
  const f = await stage(t, src, {
    deliveryClass: "evidence", nativeCoordinateFrame: "J2000", queryPagesComplete: true, inventoryComplete: true,
    scope: { obsCollection: "FDS", releaseDescription: "https://www.eso.org/rm/api/v1/public/releaseDescriptions/157", dataproductType: "image",
      filters: ["u_SDSS", "g_SDSS", "r_SDSS", "i_SDSS"], bandCounts: counts, expectedRowCount: 97, expectedFieldCount: 26,
      scienceImageRowsOnly: true, weightMapRowsIncluded: false, weightMapFileCount: 97, validPixelMasksChecked: false },
    sourcePagination: { queryPagesComplete: true, pageSize: 5000, expectedRowCount: 97, dataLinkRequestedCount: 97, dataLinkThisCount: 97, dataLinkAuxiliaryCount: 97,
      dataLinkErrors: 0, denominator: { status: 200, queryStatus: "OK", rowCount: 97 }, bandCounts: { status: 200, queryStatus: "OK", counts },
      releaseDocument: { status: 200 }, pages: [{ page: 1, status: 200, queryStatus: "OK", rows: 97, overflow: false, query: fdsQuery }] },
    supportingMetadata: [{ content: "official-release-pdf" }, { content: "raw-tap-and-datalink-capture" }], rows,
  });
  assert.equal(f.snapshot.rowCount, 97);
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  const colorBinding = binding("fds", "fds-dr1", "fds-color", "FDS DR1 color imaging");
  const cells = index.sampleCells(colorBinding);
  const color = index.lookup(colorBinding, 4, cells);
  assert.equal(color.units.length, 26);
  assert.equal(color.units[0]!.unitId, "FDS_F1");
  assert.equal(color.units[0]!.unitKind, "field");
  assert.equal(color.units[0]!.accessUris!.length, 4);
  assert.equal((color.units[0]!.sourceMetadata!.records as unknown[]).length, 4);
  assert.equal(color.units[0]!.precision, "estimated");
  assert.equal(color.units[0]!.accessAvailability, "unverified");
  assert.equal(color.inventoryComplete, true);
  assert.equal(color.queryExhausted, true);
  const uBand = index.lookup(binding("fds", "fds-dr1", "fds-u", "FDS DR1 u-band imaging"), 4, cells);
  assert.equal(uBand.units.length, 20);
  assert.ok(uBand.units.every(unit => unit.filters === "U"));
  const iBand = index.lookup(binding("fds", "fds-dr1", "fds-i", "FDS DR1 i-band imaging"), 4, cells);
  assert.equal(iBand.units.length, 25);
  assert.ok(iBand.units.every(unit => unit.filters === "I"));
  assert.deepEqual(surveyNativeBinding({ surveyId: "fds", releaseId: "fds-dr1", layerId: "x", product: "FDS DR1 z-band imaging" }), undefined);

  const publicManifest = { ...f.document, deliveryClass: "runtime" };
  await writeFile(path.join(f.root, "inputs/fds-public-manifest.json"), JSON.stringify(publicManifest));
  await assert.rejects(importSurveySnapshot(f.root, await nativeFile(f.root, "inputs/fds-public-manifest.json"), src), /complete official 97-row science-image roster/);

  const invalidRows = rows.map((row, index) => index === 0 ? { ...row, accessUris: [{ ...(row.accessUris as Array<Record<string, unknown>>)[0], uri: "https://dataportal.eso.org/dataPortal/file/another-file" }] } : row);
  await assert.rejects(stage(t, src, {
    deliveryClass: "evidence", nativeCoordinateFrame: "J2000", queryPagesComplete: true, inventoryComplete: true,
    scope: { obsCollection: "FDS", releaseDescription: "https://www.eso.org/rm/api/v1/public/releaseDescriptions/157", dataproductType: "image", scienceImageRowsOnly: true,
      weightMapRowsIncluded: false, expectedRowCount: 97, expectedFieldCount: 26, filters: ["u_SDSS", "g_SDSS", "r_SDSS", "i_SDSS"], bandCounts: counts },
    sourcePagination: { queryPagesComplete: true, pageSize: 5000, expectedRowCount: 97, dataLinkRequestedCount: 97, dataLinkThisCount: 97, dataLinkAuxiliaryCount: 97, dataLinkErrors: 0,
      denominator: { status: 200, queryStatus: "OK", rowCount: 97 }, releaseDocument: { status: 200 },
      pages: [{ status: 200, queryStatus: "OK", rows: 97, overflow: false }] },
    supportingMetadata: [{ content: "pdf" }, { content: "raw" }], rows: invalidRows,
  }), /DataLink #this evidence/);
});

test("SkyMapper DR4 preserves bounded CCD identities, ICRS footprints and honest cutout links", async t => {
  const sourceId = "skymapper-dr4-2014-mar15-18-ccds";
  const query = "SELECT image_id, ccd, filter, filename, coverage FROM dr4.ccds WHERE image_id >= 20140315000000 AND image_id < 20140318000000 AND filter IN ('g','r','i') ORDER BY image_id, ccd";
  const src: NativeSource = { ...source("galex"), id: sourceId, surveyId: "skymapper", releaseId: "skymapper-dr4", adapter: "skymapper-dr4-ccd", unitKind: "ccd",
    sourceUrl: "https://api.skymapper.nci.org.au/public/tap/sync", query, scope: "Bounded 2014-03-15 to 18 g/r/i CCD increment; not complete DR4 inventory" };
  const polygon = "POLYGON ICRS 10.0 2.0 10.2 2.0 10.2 2.2 10.0 2.2";
  const makeRow = (imageId: string, ccd: number, band: string) => {
    const unitId = `${imageId}-${String(ccd).padStart(2, "0")}`;
    const params = new URLSearchParams({ IMAGE: unitId, SIZE: "0.0833", POS: "10.100000,2.100000", FORMAT: "fits" });
    return {
      unitId, sRegion: polygon, bands: [band.toUpperCase()], filename: "56731/01/Skymapper_1206517766_2014-03-16T02:31:00_01_red.fits",
      accessUris: [{ uri: `https://api.skymapper.nci.org.au/public/siap/dr4/get_image?${params}`, accessType: "file", band }],
      sourceMetadata: { imageId, ccd, filter: band, originalFilename: "56731/01/Skymapper_1206517766_2014-03-16T02:31:00_01_red.fits",
        sourceCoverage: polygon, geometrySource: "dr4.ccds.coverage", coordinateFrame: "ICRS", accessSemantics: "five-arcmin-fits-cutout-not-full-ccd",
        cutoutSizeDeg: 0.0833, cutoutCenterIcrs: [10.1, 2.1] },
    };
  };
  const inputRows = [makeRow("20140315153115", 1, "g"), makeRow("20140315153116", 2, "r")];
  const f = await stage(t, src, {
    scope: { imageIdStartInclusive: 20140315000000, imageIdEndExclusive: 20140318000000, filters: ["g", "r", "i"], expectedRowCount: 2, fullReleaseInventory: false },
    queryPagesComplete: true,
    sourcePagination: { queryPagesComplete: true, pageSize: 5000, expectedRowCount: 2, pages: [{ status: 200, queryStatus: "OK", rows: 2 }] },
    rows: inputRows,
  });
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  const layer = binding("skymapper", "skymapper-dr4", "skymapper-dr4-color-footprint", "SkyMapper DR4 g/r/i color footprint");
  const mapping = surveyNativeBinding(layer);
  assert.ok(mapping);
  assert.equal(mapping.unitKind, "ccd");
  assert.deepEqual(sourceIdsForBinding(layer), [sourceId]);
  assert.deepEqual(mapping.sourceIds, [sourceId]);
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).hostname, "api.skymapper.nci.org.au");
  const result = index.lookup(layer, 4, index.sampleCells(layer));
  assert.deepEqual(result.units.map(unit => [unit.unitId, unit.filters]), [["20140315153115-01", "G"], ["20140315153116-02", "R"]]);
  assert.equal(result.units[0]!.sRegion, polygon);
  assert.equal(result.units[0]!.precision, "estimated");
  assert.equal(result.units[0]!.accessAvailability, "unverified");
  assert.equal(result.units[0]!.accessUri, inputRows[0]!.accessUris[0]!.uri);
  assert.equal(result.units[0]!.accessUris![0]!.fileName, undefined, "a cutout must not be named as the full CCD file");
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.queryExhausted, true);
  assert.match(result.notes.join(" "), /not the complete CCD image/i);

  const sourcePagination = f.document.sourcePagination as Record<string, unknown>;
  delete sourcePagination.expectedRowCount;
  await writeFile(path.join(f.root, "inputs/bad-manifest.json"), JSON.stringify(f.document));
  await assert.rejects(importSurveySnapshot(f.root, await nativeFile(f.root, "inputs/bad-manifest.json"), src), /complete keyset pages/);
});

test("2MASS 6X indexes independently locked M31 and LMC Atlas-image increments", async t => {
  const cases = [
    { id: "2mass-6x-m31-1deg-atlas-images", position: "10.6847083,41.26875", query: "ds=sx&POS=10.6847083%2C41.26875&SIZE=1.0&FORMAT=image%2Ffits&MAXREC=1000", count: 46,
      dates: ["001114", "001113"], hemisphere: "n", baseScan: 46, baseImage: 33, baseCoadd: 54225,
      polygon: "POLYGON ICRS 10.7759944164 41.1518082455 10.5871124880 41.1517243701 10.5864760203 41.4361687116 10.7761833685 41.4362529535",
      crval: [10.68145330, 41.29402879] },
    { id: "2mass-6x-lmc-1deg-atlas-images", position: "80.894,-69.756", query: "ds=sx&POS=80.894%2C-69.756&SIZE=1.0&FORMAT=image%2Ffits&MAXREC=1000", count: 55,
      dates: ["001208", "001229", "010103", "010113", "010202", "010203"], hemisphere: "s", baseScan: 1, baseImage: 1, baseCoadd: 62000,
      polygon: "POLYGON ICRS 80.9 -69.8 80.7 -69.8 80.7 -69.6 80.9 -69.6", crval: [80.8, -69.7] },
  ];
  const sourceIds = cases.map(item => item.id);
  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-2mass-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged: Array<{ region: typeof cases[number]; src: NativeSource; f: Awaited<ReturnType<typeof stage>>; rows: Array<Record<string, any>> }> = [];
  for (const region of cases) {
    const src: NativeSource = { ...source("galex"), id: region.id, surveyId: "2mass", releaseId: "2mass-6x", adapter: "twomass-6x-atlas", unitKind: "image",
      sourceUrl: "https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia", query: region.query, scope: `Bounded one-degree ${region.id} Atlas-image increment` };
    const rows = Array.from({ length: region.count }, (_, coaddIndex) => ["J", "H", "K"].map(band => {
      const date = region.dates[coaddIndex % region.dates.length]!;
      const scan = region.baseScan + coaddIndex;
      const image = region.baseImage + coaddIndex;
      const scanPath = String(scan).padStart(3, "0");
      const imagePath = String(image).padStart(4, "0");
      const fileName = `${band.toLowerCase()}i${scanPath}${imagePath}.fits.gz`;
      const unitId = `${date}${region.hemisphere}/s${scanPath}/${imagePath}/${band}`;
      return {
        unitId, sRegion: region.polygon, bands: [band], filename: fileName,
        accessUris: [{ uri: `https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/${date}${region.hemisphere}/s${scanPath}/image/${fileName}`, fileName, band, accessType: "file" }],
        sourceMetadata: { dataset: "sx", date, hemisphere: region.hemisphere, scan, image, coaddKey: region.baseCoadd + coaddIndex, band,
          type: "A", pixflags: "CZ", sourceFrame: "FK5(J2000)", projection: "RA---SIN/DEC--SIN", geometrySource: "2MASS SIA WCS pixel-edge transform",
          sourceWcs: { naxis: [512, 1024], scaleDegPerPixel: [-0.0002777777845, 0.0002777777845], crpixFits: [256.5, 512.5], crvalDeg: region.crval, crota2Deg: 0.03385583169 },
          originalDownload: `https://irsa.ipac.caltech.edu:443/cgi-bin/2MASS/IM/nph-im?ds=sx&atdir=%2Fti09%2F6x&dh=${date}${region.hemisphere}&scan=${scanPath}&name=${band.toLowerCase()}i${scanPath}${imagePath}.fits`,
          accessSemantics: "whole-Atlas-image-fits-gzip" },
      };
    })).flat();
    const f = await stage(t, src, {
      scope: { dataset: "sx", region: region.id.includes("lmc") ? "lmc" : "m31", position: region.position, sizeDeg: 1, format: "image/fits", maxRecords: 1000,
        expectedRowCount: rows.length, coaddCount: region.count, bands: ["J", "H", "K"], atlasType: "A", fullReleaseInventory: false },
      sourcePagination: { queryPagesComplete: true, pageSize: 1000, expectedRowCount: rows.length,
        pages: [{ status: 200, queryStatus: "OK", overflow: false, query: region.query, rows: rows.length }] },
      rows,
    }, root);
    staged.push({ region, src, f, rows });
  }
  const index = await SurveyNativeIndex.build(root, "index.sqlite", staged.map(item => item.src), staged.map(item => item.f.snapshot), () => {}); t.after(() => index.close());
  assert.equal(assertNativeSurvey("2mass"), undefined);
  const layer = binding("2mass", "2mass-6x", "2mass-2mass-6x-2mass-6x-j-band-imaging-moc", "2MASS 6X J-band imaging");
  assert.equal(layer.unitKind, "image");
  assert.deepEqual(layer.selector?.bands, ["J"]);
  assert.deepEqual(sourceIdsForBinding({ surveyId: "2mass", releaseId: "2mass-6x" }), sourceIds);
  assert.deepEqual(surveyNativeBinding({ surveyId: "2mass", releaseId: "2mass-6x", layerId: layer.layerId, product: layer.product })?.sourceIds, sourceIds);
  for (const { region, src, f, rows } of staged) {
    assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).hostname, "irsa.ipac.caltech.edu");
    const regionBinding = { ...layer, sourceIds: [region.id] };
    const result = index.lookup(layer, 4, index.sampleCells(regionBinding));
    assert.equal(result.units.length, region.count);
    assert.equal(result.units[0]!.sRegion, region.polygon);
    assert.equal(result.units[0]!.precision, "estimated");
    assert.equal(result.units[0]!.accessAvailability, "unverified");
    const matched = result.units.find(unit => unit.accessUri === rows[0]!.accessUris[0]!.uri);
    assert.ok(matched);
    assert.equal(matched.sourceSnapshotSha256, f.file.sha256);
    assert.deepEqual((matched.sourceMetadata as any).sourceSnapshots.map((snapshot: any) => snapshot.sourceId), [region.id]);
    assert.equal((matched.sourceMetadata as any).records[0].sourceId, region.id);
    assert.equal((matched.sourceMetadata as any).records[0].sourceSnapshotSha256, f.file.sha256);
    assert.deepEqual(result.units[0]!.accessUris![0]!.alternatives!.map(item => [item.providerCountryCode, item.status]), [["US", "rule-derived"]]);
    assert.equal(result.inventoryComplete, false);
    assert.equal(result.queryExhausted, true);
    assert.match(result.notes.join(" "), /not the full 6X inventory/i);
    assert.throws(() => nativeMetadataUrl("https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/", src.adapter), /SIA metadata endpoint/);
  }
});

test("DES DR2 binds its complete normal-coadd Tile roster to full-file URLs, not cutouts", async t => {
  const sourceId = "des-dr2-coadd-tiles";
  const query = "SELECT object, fileref, filter, obs_pub_did, access_url, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4 FROM ivoa_des_dr2.siav1 WHERE obs_pub_did LIKE '%#1' AND filter IN ('g','r','i','z','Y') AND fileref NOT LIKE '%nobkg%' ORDER BY obs_pub_did";
  const src: NativeSource = { ...source("galex"), id: sourceId, surveyId: "des", releaseId: "des-dr2", adapter: "noirlab-des-tap", unitKind: "tile",
    sourceUrl: "https://datalab.noirlab.edu/tap/sync", query, scope: "Complete DES DR2 normal five-band coadd Tile roster" };
  const corners = [[20.8041, 18.9093], [20.032, 18.9093], [20.0336, 18.1788], [20.8025, 18.1788]];
  const tile = "DES0121+1832";
  const rows = ["g", "r", "i", "z", "Y"].map(filter => {
    const fileRef = `${tile}_r4907p01_${filter}.fits.fz`;
    const accessUrl = `https://datalab.noirlab.edu/svc/cutout?col=des_dr2&siaRef=${fileRef}&extn=1`;
    const sRegion = `POLYGON ICRS ${corners.map(point => point.map(value => value.toFixed(10)).join(" ")).join(" ")}`;
    return {
      unitId: tile, sRegion, bands: [filter.toUpperCase()], filename: fileRef,
      accessUris: [{ uri: accessUrl, fileName: fileRef, band: filter.toUpperCase(), accessType: "file" }],
      sourceMetadata: { tileId: tile, fileRef, filter: filter.toUpperCase(), publisherDid: `ivo://datalab.noao/des_dr2/${fileRef}#1`,
        accessUrl, hdu: 1, coordinateFrame: "ICRS", geometrySource: "ivoa_des_dr2.siav1 ICRS image corners",
        cornersIcrs: corners, footprint: sRegion, accessSemantics: "full-coadd-image-no-region-cutout" },
    };
  });
  const f = await stage(t, src, {
    scope: { collection: "des_dr2", table: "ivoa_des_dr2.siav1", filters: ["g", "r", "i", "z", "Y"], hdu: 1,
      normalCoaddsOnly: true, cutoutParametersIncluded: false, expectedRowCount: 5, expectedTileCount: 1,
      bandCounts: { g: 1, r: 1, i: 1, z: 1, Y: 1 }, inventoryComplete: true },
    inventoryComplete: true,
    sourcePagination: { queryPagesComplete: true, pageSize: 5000, expectedRowCount: 5, expectedTileCount: 1,
      denominator: { status: 200, queryStatus: "OK", tileCount: 1, uniqueTileCount: 1 },
      bandCounts: { status: 200, queryStatus: "OK", perBandCount: 1 },
      pages: [{ status: 200, queryStatus: "OK", rows: 5 }] },
    rows,
  });
  const index = await SurveyNativeIndex.build(f.root, "index.sqlite", [src], [f.snapshot], () => {}); t.after(() => index.close());
  assert.equal(assertNativeSurvey("des"), undefined);
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).hostname, "datalab.noirlab.edu");
  assert.deepEqual(sourceIdsForBinding({ surveyId: "des", releaseId: "des-dr2" }), [sourceId]);
  const gLayer = binding("des", "des-dr2", "des-des-dr2-dr2-g-band-imaging-moc", "DR2 g-band imaging");
  assert.equal(gLayer.unitKind, "tile");
  assert.deepEqual(gLayer.selector?.bands, ["G"]);
  const colorLayer = binding("des", "des-dr2", "des-des-dr2-dr2-color-imaging-moc", "DR2 color imaging");
  assert.deepEqual(colorLayer.selector?.bands, ["G", "R", "I", "Z", "Y"]);
  const color = index.lookup(colorLayer, 4, index.sampleCells(colorLayer));
  assert.deepEqual(color.units.map(unit => [unit.unitId, unit.filters]), [[tile, "G, I, R, Y, Z"]]);
  assert.equal(color.units[0]!.accessAvailability, "unverified");
  assert.equal(color.units[0]!.accessUris!.length, 5);
  assert.ok(color.units[0]!.accessUris!.every(uri => uri.accessType === "file" && !/[?&](?:POS|SIZE)=/i.test(uri.uri)));
  assert.equal((color.units[0]!.sourceMetadata!.records as unknown[]).length, 5);
  assert.equal(color.inventoryComplete, true);
  assert.equal(color.queryExhausted, true);
  assert.match(color.notes.join(" "), /10,000 by 10,000 pixels/i);
  const g = index.lookup(gLayer, 4, index.sampleCells(gLayer));
  assert.equal(g.units[0]!.accessUris!.length, 1);
  assert.equal(g.units[0]!.accessUris![0]!.fileName, rows[0]!.filename);
  assert.throws(() => nativeMetadataUrl("https://datalab.noirlab.edu/tap", src.adapter), /official NOIRLab Data Lab TAP/);
});

test("DECaPS DR2 maps native CCD extensions and rejects cutout URLs", () => {
  const layer = { surveyId: "decaps", releaseId: "decaps-dr2", layerId: "decaps-decaps-dr2-decaps-dr2-color-imaging-moc", product: "DECaPS DR2 color imaging" };
  const sourceId = "decaps-dr2-native-ccds";
  const src: NativeSource = { ...source("galex"), id: sourceId, surveyId: "decaps", releaseId: "decaps-dr2", adapter: "noirlab-decaps-tap", unitKind: "ccd",
    sourceUrl: "https://datalab.noirlab.edu/tap/sync", query: "SELECT DECaPS CCD metadata" };
  const fileName = "c4d_180520_103732_ooi_r_decaps2.fits.fz";
  const footprint = "POLYGON ICRS 99.4890000000 -26.0936000000 99.8221000000 -25.9442000000 99.8219000000 -26.0936000000 99.4898000000 -26.0933000000";
  const accessUrl = `https://datalab.noirlab.edu/svc/cutout?col=decaps_dr2&siaRef=${fileName}&extn=51`;
  const row = {
    unitId: `${fileName}#51`, sRegion: footprint, bands: ["R"], filename: fileName,
    accessUris: [{ uri: accessUrl, fileName, band: "R", accessType: "file" }],
    sourceMetadata: { publisherDid: `ivo://datalab.noirlab/decaps_dr2/${fileName}#51`, fileRef: fileName, extension: 51, filter: "R",
      exposureNumber: 525811, observationId: "decaps_dr2", exposureSeconds: 30, dimensions: [2046, 4094], coordinateFrame: "ICRS", wcsProjection: "TPV",
      geometrySource: "NOIRLab ivoa_decaps_dr2.siav1 CCD ICRS corner columns", cornersIcrs: [[99.489, -26.0936], [99.8221, -25.9442], [99.8219, -26.0936], [99.4898, -26.0933]],
      footprint, accessSemantics: "source-listed full DECaPS CCD FITS extension; POS/SIZE cutout parameters absent" },
  };
  assert.deepEqual(surveyNativeBinding(layer), { unitKind: "ccd", sourceIds: [sourceId], selector: { bands: ["G", "I", "R", "Y", "Z"] } });
  assert.deepEqual(sourceIdsForBinding(layer), [sourceId]);
  assertNativeSurvey("decaps");
  assert.equal(nativeMetadataUrl(src.sourceUrl, src.adapter).pathname, "/tap/sync");
  assert.equal(normalizedRow(row, src)?.unitId, `${fileName}#51`);
  assert.throws(() => nativeMetadataUrl("https://example.org/tap/sync", src.adapter), /official public metadata source/);

  const cutout = structuredClone(row);
  cutout.accessUris[0]!.uri += "&POS=100,-26&SIZE=0.02";
  assert.throws(() => normalizedRow(cutout, src), /CCD extension/);
});

test("DECaPS DR2 accepts the captured TOP 5000 keyset query on every ordered page", async t => {
  const sourceId = "decaps-dr2-native-ccds";
  const query = "SELECT obs_collection, propid, obs_id, obs_pub_did, access_url, access_format, access_estsize, filter, im_naxis1, im_naxis2, wcsaxes1, wcsaxes2, date_obs, mjd_obs, expnum, exptime, fileref, proctype, prodtype, obstype, telescope, instrument_name, object, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4 FROM ivoa_decaps_dr2.siav1 WHERE filter IN ('g','i','r','Y','z') ORDER BY obs_pub_did";
  const src: NativeSource = { ...source("galex"), id: sourceId, surveyId: "decaps", releaseId: "decaps-dr2", adapter: "noirlab-decaps-tap", unitKind: "ccd",
    sourceUrl: "https://datalab.noirlab.edu/tap/sync", query };
  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-decaps-manifest-")); t.after(() => rm(root, { recursive: true, force: true }));
  const manifestRef = "inputs/manifest.json";
  await mkdir(path.join(root, "inputs/metadata"), { recursive: true });
  await mkdir(path.join(root, "inputs/normalized"), { recursive: true });
  const metadataDocuments: Array<Record<string, unknown>> = [];
  const addDocument = async (ref: string) => {
    const body = Buffer.from(ref);
    const absolutePath = path.join(root, "inputs", ref);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, body);
    const file = await nativeFile(root, `inputs/${ref}`);
    metadataDocuments.push({ ...file, ref, url: src.sourceUrl });
    return file;
  };
  await addDocument("metadata/table-schema.votable.xml");
  await addDocument("metadata/count-before.votable.xml");
  await addDocument("metadata/filter-counts-before.votable.xml");
  const expectedRows = 1_065_941;
  const expectedPageCount = Math.ceil(expectedRows / 5000);
  const pages: Array<Record<string, unknown>> = [];
  const baseQuery = query.slice(0, query.indexOf(" ORDER BY obs_pub_did")).replace(/^SELECT /, "SELECT TOP 5000 ");
  for (let pageNumber = 1; pageNumber <= expectedPageCount; pageNumber++) {
    const rows = pageNumber === expectedPageCount ? expectedRows % 5000 : 5000;
    const firstOrdinal = (pageNumber - 1) * 5000 + 1;
    const lastOrdinal = firstOrdinal + rows - 1;
    const firstPublisherDid = `ccd-${String(firstOrdinal).padStart(7, "0")}`;
    const lastPublisherDid = `ccd-${String(lastOrdinal).padStart(7, "0")}`;
    const pageQuery = `${baseQuery}${pageNumber === 1 ? "" : ` AND obs_pub_did > '${pages[pageNumber - 2]!.lastPublisherDid}'`} ORDER BY obs_pub_did`;
    const ref = `metadata/tap-page-${String(pageNumber).padStart(4, "0")}.votable.xml`;
    const document = await addDocument(ref);
    pages.push({ page: pageNumber, query: pageQuery, status: 200, queryStatus: "OK", rows, firstPublisherDid, lastPublisherDid,
      sha256: document.sha256, sizeBytes: document.sizeBytes });
  }
  await addDocument("metadata/count-after.votable.xml");
  await addDocument("metadata/filter-counts-after.votable.xml");
  const rowRef = "inputs/normalized/native-rows.ndjson.gz";
  const rowBytes = gzipSync("");
  await writeFile(rowRef.startsWith("inputs/") ? path.join(root, rowRef) : path.join(root, "inputs", rowRef), rowBytes);
  const rowFile = { ...await nativeFile(root, rowRef), ref: "normalized/native-rows.ndjson.gz", rows: expectedRows };
  const filterCounts = { g: 222_948, i: 213_595, r: 220_344, Y: 198_019, z: 211_035 };
  const manifest = {
    schemaVersion: 1, deliveryClass: "evidence", adapter: src.adapter, surveyId: src.surveyId, releaseId: src.releaseId,
    capturedAt, coordinateFrame: "ICRS", nativeCoordinateFrame: "ICRS", ordering: "NESTED", query, queryPagesComplete: true,
    inventoryComplete: true, rowCount: expectedRows,
    scope: { table: "ivoa_decaps_dr2.siav1", collection: "DECaPS DR2", filters: ["g", "i", "r", "Y", "z"], completeTableInventory: true,
      expectedRowCount: expectedRows, expectedCcdCount: expectedRows, individualFileAvailabilityVerified: false, bandCounts: filterCounts },
    sourcePagination: { queryPagesComplete: true, pageSize: 5000, expectedRowCount: expectedRows, expectedCcdCount: expectedRows,
      denominatorsStable: true,
      denominatorBefore: { status: 200, queryStatus: "OK", rowCount: expectedRows },
      denominatorAfter: { status: 200, queryStatus: "OK", rowCount: expectedRows },
      filterCountsBefore: { status: 200, queryStatus: "OK", counts: filterCounts },
      filterCountsAfter: { status: 200, queryStatus: "OK", counts: filterCounts }, pages },
    metadataDocuments, rowFiles: [rowFile],
  };
  await writeFile(path.join(root, manifestRef), JSON.stringify(manifest));
  const loaded = await loadSurveyManifest(root, manifestRef, src);
  assert.equal(loaded.manifest.rowCount, expectedRows);
  assert.equal(loaded.files.length, 1 + metadataDocuments.length + 1);
  assert.equal(pages[0]!.query, `${baseQuery} ORDER BY obs_pub_did`);
  assert.match(String(pages[1]!.query), /SELECT TOP 5000 .* AND obs_pub_did > 'ccd-0005000' ORDER BY obs_pub_did$/);
});

test("ACT DR5 binds its six header-verified whole maps by frequency without claiming a full-release inventory", async t => {
  const sourceId = "act-dr5-normal-whole-maps";
  const sourceUrl = "https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_get.html";
  const query = "Official ACT DR5 normal ACT-only whole-map selector: frequencies 090/150/220 GHz x night/daynight; lock the six matching FITS members from the official 42-file download script and capture only their FITS header blocks.";
  const src: NativeSource = { ...source("gaia"), id: sourceId, surveyId: "act", releaseId: "act-dr5", adapter: "act-dr5-whole-map", unitKind: "image",
    sourceUrl, query, scope: "Six normal ACT-only frequency/time maps; full ACT DR5 inventory is outside this selector", files: [] };
  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-act-")); t.after(() => rm(root, { recursive: true, force: true }));
  const manifestRef = "inputs/manifest.json";
  await mkdir(path.join(root, "inputs/metadata/headers"), { recursive: true });
  await mkdir(path.join(root, "inputs/normalized"), { recursive: true });
  const metadataDocuments: Array<Record<string, unknown>> = [];
  const addEvidence = async (ref: string, bytes: Buffer, url: string, extra: Record<string, unknown> = {}) => {
    const absolutePath = path.join(root, "inputs", ref);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    const file = await nativeFile(root, `inputs/${ref}`);
    const document = { ...file, ref, url, ...extra };
    metadataDocuments.push(document);
    return document;
  };
  const page = await addEvidence("metadata/act-dr5-get.html", Buffer.from("ACT DR5 download page"), sourceUrl);
  const roster = await addEvidence("metadata/act-dr5-coadd-maps-wget.sh", Buffer.from("six selected map URLs"), "https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_wget.sh");
  const mapIds = ["090-night", "090-daynight", "150-night", "150-daynight", "220-night", "220-daynight"];
  const accessRoot = "https://lambda.gsfc.nasa.gov/data/suborbital/ACT/ACT_dr5/maps/";
  const region = `UNION ICRS (${Array.from({ length: 360 }, () => "POLYGON ICRS 100 -1 101 -1 101 1 100 1").join(" ")})`;
  const rows: Array<Record<string, unknown>> = [];
  const mapReceipts: Array<Record<string, unknown>> = [];
  for (const mapId of mapIds) {
    const [frequency, selection] = mapId.split("-");
    const fileName = `act_dr5.01_s08s18_AA_f${frequency}_${selection}_map.fits`;
    const url = accessRoot + fileName;
    const headerRef = `metadata/headers/${fileName}.header`;
    const header = await addEvidence(`metadata/headers/${fileName}.header`, Buffer.alloc(2880, 32), url, { mapId });
    const fileSizeBytes = 5_368_709_120;
    const range = { start: 0, endInclusive: 2879, status: 206, contentRange: `bytes 0-2879/${fileSizeBytes}`, bytesRead: 2880 };
    mapReceipts.push({ mapId, fileName, url, headStatus: 200, acceptRanges: "bytes", fileSizeBytes,
      ranges: [range], headerBytes: 2880, headerSha256: header.sha256 });
    const band = `${Number(frequency)} GHZ`;
    rows.push({ unitId: fileName, sRegion: region, bands: [band], filename: fileName,
      accessUris: [{ uri: url, fileName, band, accessType: "file" }],
      sourceMetadata: { mapId, frequencyGHz: Number(frequency), timeSelection: selection, fileName, fileSizeBytes,
        coordinateFrame: "ICRS", projection: "CAR", dimensions: [43200, 10320, 3], declinationBoundsDeg: [-63, 23],
        frameSemantics: "whole-map image frame; ACT valid-pixel holes and masks are not checked",
        geometrySource: "ACT DR5 FITS primary-header ICRS CAR WCS transformed along image-frame edges", geometryPrecision: "estimated",
        headerRef, headerSha256: header.sha256, headerBytes: 2880, headStatus: 200, rangeReceipts: [range],
        accessSemantics: "source-listed direct whole-map FITS file; no archive wrapper" },
    });
  }
  const rowPath = path.join(root, "inputs/normalized/native-rows.ndjson.gz");
  await writeFile(rowPath, gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
  const rowFile = { ...await nativeFile(root, "inputs/normalized/native-rows.ndjson.gz"), ref: "normalized/native-rows.ndjson.gz", rows: rows.length };
  const manifest = { schemaVersion: 1, deliveryClass: "evidence", adapter: src.adapter, surveyId: src.surveyId, releaseId: src.releaseId,
    capturedAt, coordinateFrame: "ICRS", nativeCoordinateFrame: "ICRS", ordering: "NESTED", queryPagesComplete: true,
    inventoryComplete: false, rowCount: rows.length,
    scope: { selector: "normal ACT-only frequency/time-selection whole maps", frequenciesGHz: [90, 150, 220], timeSelections: ["night", "daynight"],
      mapIds, fileRosterComplete: true, fullSurveyInventory: false, headerOnly: true, validPixelMasksChecked: false,
      expectedDimensions: [43200, 10320, 3], geometryPrecision: "estimated" },
    sourcePagination: { queryPagesComplete: true, pageSize: 6, expectedRowCount: 6, maps: mapReceipts,
      pages: [{ page: 1, status: 200, queryStatus: "OK", query, rows: 6, mapIds, rosterSha256: roster.sha256 }] },
    metadataDocuments, rowFiles: [rowFile] };
  await writeFile(path.join(root, manifestRef), JSON.stringify(manifest));
  const inputFile = await nativeFile(root, manifestRef);
  const snapshot = await importSurveySnapshot(root, inputFile, src);
  assert.equal(snapshot.rowCount, 6);
  assert.deepEqual(surveyNativeBinding({ surveyId: "act", releaseId: "act-dr5", layerId: "act-90", product: "ACT DR5 90 GHz coverage" }),
    { unitKind: "image", sourceIds: [sourceId], selector: { bands: ["90 GHZ"] } });
  assert.deepEqual(sourceIdsForBinding({ surveyId: "act", releaseId: "act-dr5" }), [sourceId]);
  assert.equal(assertNativeSurvey("act"), undefined);
  assert.equal(nativeMetadataUrl(sourceUrl, src.adapter).pathname, "/product/act/actpol_dr5_coadd_maps_get.html");

  const index = await SurveyNativeIndex.build(root, "derived/act-native.sqlite", [src], [snapshot], () => {}); t.after(() => index.close());
  const ninety = binding("act", "act-dr5", "act-90", "ACT DR5 90 GHz coverage");
  const sampleCells = index.sampleCells(ninety);
  assert.ok(sampleCells.length > 0);
  const result = index.lookup(ninety, 4, sampleCells);
  assert.deepEqual(result.units.map(unit => unit.unitId), mapIds.slice(0, 2).map(mapId => `act_dr5.01_s08s18_AA_f${mapId.replace("-", "_")}_map.fits`).sort());
  assert.ok(result.units.every(unit => unit.unitKind === "image" && unit.accessAvailability === "unverified"));
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.queryExhausted, true);
  assert.match(result.notes.join(" "), /full-release inventory is incomplete/i);

  await writeFile(path.join(root, manifestRef), JSON.stringify({ ...manifest, scope: { ...manifest.scope, fullSurveyInventory: true } }));
  const tamperedFile = await nativeFile(root, manifestRef);
  await assert.rejects(loadSurveyManifest(root, manifestRef, src, tamperedFile), /ACT DR5 input/);
});

test("SPHEREx QR2 binds one header-derived detector observation without claiming release completeness", async t => {
  const sourceId = "spherex-qr2-2025w17-4b-0001-1";
  const sourceUrl = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/";
  const query = "ListObjectsV2 prefix=qr2/level2/2025W17_4B/l2b-v20-2025-240/{2,3,4,5,6}/level2_2025W17_4B_0001_1D{2,3,4,5,6}_spx_l2b-v20-2025-240.fits; one QR2 observation";
  const src: NativeSource = { ...source("gaia"), id: sourceId, surveyId: "spherex", releaseId: "spherex-qr2", adapter: "spherex-qr2-s3-observation", unitKind: "image",
    sourceUrl, query, scope: "One five-detector QR2 observation; not the full QR2 inventory", files: [] };
  const root = await mkdtemp(path.join(os.tmpdir(), "survey-native-spherex-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "inputs/metadata"), { recursive: true });
  const metadataDocuments: Array<Record<string, unknown>> = [];
  const headerFiles = new Map<string, { ref: string; sha256: string }>();
  for (let index = 0; index < 10; index++) {
    const header = index >= 5;
    const detector = header ? index - 3 : index + 2;
    const relative = header ? `metadata/header-${detector}.bin` : `metadata/listing-${detector}.xml`;
    const ref = `inputs/${relative}`;
    await writeFile(path.join(root, ref), Buffer.from(`${header ? "header" : "listing"}-${index}`));
    const file = await nativeFile(root, ref);
    metadataDocuments.push({ ...file, ref: relative, sourceUrl: `${sourceUrl}?metadata=${index}` });
    if (header) headerFiles.set(relative, { ref: relative, sha256: file.sha256 });
  }

  const frameEdgeIcrs = Array.from({ length: 32 }, (_, index) => {
    const angle = 2 * Math.PI * index / 32;
    return [Number((164.706 + Math.cos(angle) * 0.1).toFixed(10)), Number((29.139 + Math.sin(angle) * 0.1).toFixed(10))];
  });
  const sRegion = `POLYGON ICRS ${frameEdgeIcrs.map(([ra, dec]) => `${ra!.toFixed(10)} ${dec!.toFixed(10)}`).join(" ")}`;
  const rows: Array<Record<string, unknown>> = [];
  for (const detector of [2, 3, 4, 5, 6]) {
    const filename = `level2_2025W17_4B_0001_1D${detector}_spx_l2b-v20-2025-240.fits`;
    const objectKey = `qr2/level2/2025W17_4B/l2b-v20-2025-240/${detector}/${filename}`;
    const headerRef = `metadata/header-${detector}.bin`;
    const header = headerFiles.get(headerRef)!;
    const originalUri = `https://irsa.ipac.caltech.edu/ibe/data/spherex/${objectKey}`;
    const mirrorUri = `${sourceUrl}${objectKey}`;
    rows.push({
      unitId: `2025W17_4B_0001_1/D${detector}`, sRegion, bands: [`D${detector}`], filename,
      accessUris: [
        { uri: originalUri, fileName: filename, band: `D${detector}`, accessType: "file" },
        { uri: mirrorUri, fileName: filename, band: `D${detector}`, accessType: "file" },
      ],
      sourceMetadata: {
        observationId: "2025W17_4B_0001_1", detector, processingVersion: "l2b-v20-2025-240",
        objectKey, fileName: filename, fileSizeBytes: 71634240, providerETag: "ee30fd35a2ab3d38e52d06acc1128cca",
        coordinateFrame: "ICRS", geometrySource: "SPHEREx FITS IMAGE extension TAN-SIP pixel-edge transform",
        wcsHeaderRef: headerRef, wcsHeaderSha256: header.sha256, headerRangeEndInclusive: 5759, imageHeaderOffset: 2880,
        imageWidth: 2040, imageHeight: 2040, wcsCtype: ["RA---TAN-SIP", "DEC--TAN-SIP"],
        referenceIcrs: [164.705590379, 29.1388961408], frameEdgeIcrs,
        sourceListedUri: originalUri, mirrorUri, availabilityEvidence: "public-object-listing-and-header-ranges",
        rangeRequests: [{ start: 0, endInclusive: 2879, status: 206, contentRange: "bytes 0-2879/71634240", bytesRead: 2880 },
          { start: 2880, endInclusive: 5759, status: 206, contentRange: "bytes 2880-5759/71634240", bytesRead: 2880 }],
        frameSemantics: "detector image frame; valid-pixel mask not checked",
      },
    });
  }
  const rowBody = gzipSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(path.join(root, "inputs/rows.jsonl.gz"), rowBody);
  const rowFile = await nativeFile(root, "inputs/rows.jsonl.gz");
  const manifest = {
    schemaVersion: 1, adapter: src.adapter, surveyId: src.surveyId, releaseId: src.releaseId, sourceId, query, capturedAt,
    coordinateFrame: "ICRS", ordering: "NESTED", queryPagesComplete: true, inventoryComplete: false,
    nativeCoordinateFrame: "ICRS",
    scope: { observingRun: "2025W17_4B", processingVersion: "l2b-v20-2025-240", observationSelector: "2025W17_4B_0001_1",
      observationId: "2025W17_4B_0001_1", detectors: [2, 3, 4, 5, 6], expectedRowCount: 5,
      fullObservationRoster: true, fullReleaseInventory: false, inventoryComplete: false,
      headerOnly: true, validPixelMasksChecked: false },
    sourcePagination: { pageSize: 1000, expectedRowCount: 5, queryPagesComplete: true,
      pages: [2, 3, 4, 5, 6].map(detector => ({ detector, page: 1, status: 200, rows: 1, isTruncated: false })) },
    metadataDocuments, rowFiles: [{ ...rowFile, ref: "rows.jsonl.gz", rows: 5 }], rowCount: 5,
  };
  await writeFile(path.join(root, "inputs/manifest.json"), JSON.stringify(manifest));
  const input = await nativeFile(root, "inputs/manifest.json");
  const snapshot = await importSurveySnapshot(root, input, src);
  const index = await SurveyNativeIndex.build(root, "index.sqlite", [src], [snapshot], () => {}); t.after(() => index.close());

  assert.equal(assertNativeSurvey("spherex"), undefined);
  assert.equal(nativeMetadataUrl(sourceUrl, src.adapter).hostname, "nasa-irsa-spherex.s3.us-east-1.amazonaws.com");
  assert.deepEqual(sourceIdsForBinding({ surveyId: "spherex", releaseId: "spherex-qr2" }), [sourceId, `${sourceId}-d1-v241`]);
  const proposedD2 = binding("spherex", "spherex-qr2", "spherex-spherex-qr2-spherex-qr2-d2-coverage-moc", "SPHEREx QR2 D2 coverage");
  assert.equal(index.hasBinding(proposedD2), false, "a proposed binding needs both processing-version inputs locked");
  // Installed versions keep their original frozen sources. This fixture contains
  // only the earlier five-detector input, so it must not claim the new D1 source.
  const d2 = { ...proposedD2, sourceIds: [sourceId] };
  assert.equal(d2.unitKind, "image");
  assert.deepEqual(d2.selector?.bands, ["D2"]);
  const result = index.lookup(d2, 4, index.sampleCells(d2));
  assert.equal(result.units.length, 1);
  assert.ok(result.units.every(unit => unit.filters === "D2" && unit.precision === "estimated" && unit.accessUris?.length === 2));
  assert.equal(result.inventoryComplete, false);
  assert.equal(result.queryExhausted, true);
  assert.match(result.notes.join(" "), /not the full QR2 inventory/i);
  const color = { ...binding("spherex", "spherex-qr2", "spherex-spherex-qr2-spherex-qr2-color-coverage-moc", "SPHEREx QR2 color coverage"), sourceIds: [sourceId] };
  assert.deepEqual(color.selector?.bands, ["D1", "D2", "D3", "D4", "D5", "D6"]);
  assert.equal(index.lookup(color, 4, index.sampleCells(color)).units.length, 5);
  assert.equal(surveyNativeBinding({ surveyId: "spherex", releaseId: "spherex-qr2", layerId: "x", product: "SPHEREx QR2 D1 coverage" })?.selector?.bands?.[0], "D1");
  assert.throws(() => nativeMetadataUrl("https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr2/level2/", src.adapter), /AWS metadata listing/);
});

test("CASDC provider status records reachable survey directories with canonical URLs", () => {
  const cases = [
    ["gaia", "gaia-dr3", "Gaia"],
    ["galex", "galex-gr6-gr7", "GALEX"],
    ["euclid", "euclid-q1", "Euclid-Q1"],
  ] as const;
  for (const [surveyId, releaseId, directory] of cases) {
    const providers = casdcProviderStatuses(surveyId, releaseId);
    assert.deepEqual(providers.map(item => [item.providerCountryCode, item.accessType, item.status, item.httpStatus]), [
      ["CN", "entrypoint", "entrypoint-only", 200],
      ["CN", "directory", "verified", 200],
    ]);
    assert.equal(providers[1]!.uri, `https://casdc.china-vo.org/mirror/${directory}/`);
    assert.match(providers[1]!.note ?? "", /directory listing/i);
    assert.match(providers[1]!.note ?? "", /individual file URLs and scientific bytes were not checked/i);
  }
});

test("DECaLS DR5 binds to the locked DR5 brick sources with a mixed-program scope", () => {
  const layer = { surveyId: "decals", releaseId: "decals-dr5", layerId: "decals-dr5-color-footprint", product: "DR5 g/r/z color footprint" };
  assert.equal(assertNativeSurvey("decals"), undefined);
  assert.deepEqual(surveyNativeBinding(layer), { unitKind: "brick", sourceIds: ["legacy-dr5-bricks", "legacy-brick-geometry"], selector: { bands: ["G", "R", "Z"] } });
  assert.deepEqual(sourceIdsForBinding(layer), ["legacy-dr5-bricks", "legacy-brick-geometry"]);
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
