import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createGunzip, gunzipSync } from "node:zlib";
import { Healpix } from "healpixjs";
import type { DownloadPlanSpatialUnit } from "./evidence-store.js";
import type { SourceAccessAlternative, SourceAccessUri } from "./evidence-store.js";
import { candidateCellsForStcs, cellsForStcs } from "./hst-image-lookup.js";
import { nativeFile } from "./native-unit-archive.js";
import { nativeDigest, nativeEvidencePath, nativeMetadataUrl, type NativeAdapter, type NativeBinding, type NativeFile, type NativeSnapshot, type NativeSource } from "./native-unit-model.js";
import { alternativesForAccessUri, mastScienceFile, metadataEntrypoint } from "./survey-access.js";

const SCHEMA = "1";
const COARSE_ORDER = 4;
const MAX_UNITS = 50_000;
const ADAPTERS = new Set<NativeAdapter>(["gaia-healpix-range", "sdss-field", "mast-observation", "eso-obscore-vvv", "eso-obscore-fds", "eso-obscore-kids", "eso-obscore-vphas", "eso-obscore-viking", "skymapper-dr4-ccd", "twomass-6x-atlas", "allwise-ibe-atlas", "noirlab-des-tap", "noirlab-decaps-tap", "spherex-qr2-s3-observation", "cadc-caom-cfhtls", "act-dr5-whole-map", "panstarrs-dr1-skycell", "iphas-dr2-pipeline", "rubin-firstlook-avm", "irsa-akari-fis-map", "cds-ztf-progenitor-o3", "skyview-radio-maps"]);
const SKYVIEW_RADIO_HEADER_REF = "metadata/map-headers.ndjson.gz";
const SKYVIEW_RADIO_SPECS: Record<string, { sourceId: string; releaseId: string; expectedRows: number; xmlName: string; mapRoot: string; band: string; nativeFrame: string; producer: string; producerCountry: string }> = {
  nvss: { sourceId: "nvss-final-native-maps", releaseId: "nvss-final", expectedRows: 2326, xmlName: "nvss", mapRoot: "https://skyview.gsfc.nasa.gov/surveys/nvss/", band: "1400 MHZ", nativeFrame: "FK5(J2000)", producer: "National Radio Astronomy Observatory", producerCountry: "US" },
  sumss: { sourceId: "sumss-final-native-maps", releaseId: "sumss-final", expectedRows: 748, xmlName: "sumss", mapRoot: "https://skyview.gsfc.nasa.gov/surveys/sumss/mosaics/", band: "843 MHZ", nativeFrame: "FK5(J2000)", producer: "University of Sydney SUMSS", producerCountry: "AU" },
  wenss: { sourceId: "wenss-final-native-maps", releaseId: "wenss-final", expectedRows: 493, xmlName: "wenss", mapRoot: "https://skyview.gsfc.nasa.gov/surveys/wenss/", band: "325 MHZ", nativeFrame: "FK4(B1950)", producer: "WENSS team: NFRA/ASTRON and Leiden Observatory", producerCountry: "NL" },
};
const SKYMapper_SOURCE_ID = "skymapper-dr4-2014-mar15-18-ccds";
const SKYMapper_QUERY = "SELECT image_id, ccd, filter, filename, coverage FROM dr4.ccds WHERE image_id >= 20140315000000 AND image_id < 20140318000000 AND filter IN ('g','r','i') ORDER BY image_id, ccd";
const TWOMASS_SOURCE_SPECS: Record<string, { query: string; position: string; expectedRows: number; coaddCount: number }> = {
  "2mass-6x-m31-1deg-atlas-images": {
    query: "ds=sx&POS=10.6847083%2C41.26875&SIZE=1.0&FORMAT=image%2Ffits&MAXREC=1000",
    position: "10.6847083,41.26875", expectedRows: 138, coaddCount: 46,
  },
  "2mass-6x-lmc-1deg-atlas-images": {
    query: "ds=sx&POS=80.894%2C-69.756&SIZE=1.0&FORMAT=image%2Ffits&MAXREC=1000",
    position: "80.894,-69.756", expectedRows: 165, coaddCount: 55,
  },
};
const TWOMASS_SOURCE_IDS = Object.keys(TWOMASS_SOURCE_SPECS);
const ALLWISE_SOURCE_ID = "allwise-w3-w4-atlas";
const ALLWISE_QUERY = "SELECT TOP 1000 coadd_id, band, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4, crval1, crval2, crpix1, crpix2, naxis1, naxis2, ctype1, ctype2, cdelt1, cdelt2, crota2, equinox, cntr FROM allwise_p3am_cdd WHERE band IN (3,4) ORDER BY coadd_id, band";
const ALLWISE_ROW_COUNT = 36480;
const ALLWISE_COADD_COUNT = 18240;
const ALLWISE_BAND_COUNTS = { W3: 18240, W4: 18240 };
const CFHTLS_SOURCE_ID = "cfhtls-wide-t0007-single-band-images";
const CFHTLS_QUERY = "SELECT TOP 1000 o.collection, o.observationID, o.obsID, p.productID, p.provenance_version, p.energy_bandpassName, p.position_bounds, p.position_dimension_naxis1, p.position_dimension_naxis2, a.artifactID, a.uri, a.productType, a.contentType, a.contentLength, a.contentChecksum, c.position_coordsys, c.position_equinox FROM caom2.Observation AS o JOIN caom2.Plane AS p ON o.obsID=p.obsID JOIN caom2.Artifact AS a ON a.planeID=p.planeID JOIN caom2.Part AS pt ON pt.artifactID=a.artifactID JOIN caom2.Chunk AS c ON c.partID=pt.partID WHERE o.collection='CFHTTERAPIX' AND o.observationID LIKE 'CFHTLS_W_%' AND p.provenance_version='T0007' AND a.productType='science' AND a.uri LIKE '%_T0007_MEDIAN.fits' AND p.energy_bandpassName IN ('g.MP9401','i.MP9701','i.MP9702','r.MP9601','u.MP9301','z.MP9801') ORDER BY o.observationID,p.productID,a.uri";
const CFHTLS_ROW_COUNT = 855;
const CFHTLS_FIELD_COUNT = 171;
const CFHTLS_BAND_COUNTS = { U: 171, G: 171, R: 171, I: 171, Z: 171 };
const CFHTLS_FILTER_COUNTS = { "g.MP9401": 171, gri: 80, gry: 19, "i.MP9701": 139, "i.MP9702": 32, "r.MP9601": 171, ryg: 11, "u.MP9301": 171, "z.MP9801": 171 };
const CFHTLS_BAND_BY_FILTER: Record<string, string> = { "g.MP9401": "G", "i.MP9701": "I", "i.MP9702": "I", "r.MP9601": "R", "u.MP9301": "U", "z.MP9801": "Z" };
const CFHTLS_DATA_ROOT = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/pub/CFHTTERAPIX/";
const DES_SOURCE_ID = "des-dr2-coadd-tiles";
const DES_QUERY = "SELECT object, fileref, filter, obs_pub_did, access_url, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4 FROM ivoa_des_dr2.siav1 WHERE obs_pub_did LIKE '%#1' AND filter IN ('g','r','i','z','Y') AND fileref NOT LIKE '%nobkg%' ORDER BY obs_pub_did";
const DECAPS_SOURCE_ID = "decaps-dr2-native-ccds";
const DECAPS_QUERY = "SELECT obs_collection, propid, obs_id, obs_pub_did, access_url, access_format, access_estsize, filter, im_naxis1, im_naxis2, wcsaxes1, wcsaxes2, date_obs, mjd_obs, expnum, exptime, fileref, proctype, prodtype, obstype, telescope, instrument_name, object, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4 FROM ivoa_decaps_dr2.siav1 WHERE filter IN ('g','i','r','Y','z') ORDER BY obs_pub_did";
const DECAPS_ROW_COUNT = 1_065_941;
const DECAPS_BAND_COUNTS = { G: 222_948, I: 213_595, R: 220_344, Y: 198_019, Z: 211_035 };
const DECAPS_FILTER_COUNTS = { g: 222_948, i: 213_595, r: 220_344, Y: 198_019, z: 211_035 };
const ACT_SOURCE_ID = "act-dr5-normal-whole-maps";
const ACT_QUERY = "Official ACT DR5 normal ACT-only whole-map selector: frequencies 090/150/220 GHz x night/daynight; lock the six matching FITS members from the official 42-file download script and capture only their FITS header blocks.";
const ACT_MAPS = ["090-night", "090-daynight", "150-night", "150-daynight", "220-night", "220-daynight"];
const ACT_MAP_ROOT = "https://lambda.gsfc.nasa.gov/data/suborbital/ACT/ACT_dr5/maps/";
const PANSTARRS_SOURCE_ID = "panstarrs-dr1-zone23-skycells";
const PANSTARRS_QUERY = "skycell={projection}.{subcell}&type=stack";
const PANSTARRS_GRID_URL = "https://outerspace.stsci.edu/download/attachments/298812317/ps1grid.fits?version=1&modificationDate=1532367528459&api=v2";
const PANSTARRS_IMAGE_LIST_URL = "https://ps1images.stsci.edu/cgi-bin/ps1filenames.py";
const PANSTARRS_BANDS = ["G", "R", "I", "Z", "Y"];
const PANSTARRS_ZONE = { zone: 23, projectionStart: 1322, projectionCount: 90, decCenter: 2, decMin: 1.3877787807814457e-17, decMax: 3.998086931795508, xCell: 6240, yCell: 6243, crpix1: 240, crpix2: 242 };
const IPHAS_SOURCE_ID = "iphas-dr2-pipeline-images";
const IPHAS_SOURCE_URL = "https://raw.githubusercontent.com/barentsen/iphas-dr2/e2e47c6964df6bb5fe9909e317ef18f0913698db/scripts/release-preparation/iphas-images-pipeline.fits";
const IPHAS_EXPECTED_ROWS = 268_185;
const IPHAS_EXPECTED_DR2_ROWS = 169_392;
const IPHAS_EXPECTED_UNIQUE_ROWS = 169_380;
const IPHAS_EXPECTED_DUPLICATE_ROWS = 12;
const IPHAS_BANDS = ["HALPHA", "R", "I"];
const RUBIN_SOURCE_ID = "rubin-firstlook-public-images";
const RUBIN_CAPTURE_REF = "metadata/rubin-firstlook-capture.json";
const RUBIN_IMAGE_EVIDENCE: Record<string, { fileName: string; sizeBytes: number; xmpRef: string; xmpSha256: string; dimensions: [number, number] }> = {
  noirlab2521a: { fileName: "noirlab2521a.tif", sizeBytes: 15_142_805_372, xmpRef: "metadata/noirlab2521a-range-524-26612.bin", xmpSha256: "2434a33aab3fa183b284cb332b503b9d9bfe53f7acc48cec13e58e6df92c1d04", dimensions: [97_943, 51_536] },
  noirlab2521b: { fileName: "noirlab2521b.tif", sizeBytes: 25_956_028_716, xmpRef: "metadata/noirlab2521b-range-524-20743.bin", xmpSha256: "9bc9699803579fb8b2fb0a6ca3c1ad13f9ac6e368c65d42f7c06d5c6173f8930", dimensions: [84_000, 51_500] },
};
const AKARI_SOURCE_ID = "akari-fis-allsky-native-images";
const AKARI_QUERY = "Four complete per-band science-image queries against akari.akari_images for N60, WideS, WideL and N160; preserve each raw VOTable and compare all rows to the source region list and band directories.";
const AKARI_ROW_COUNT = 6688;
const AKARI_REGION_COUNT = 1672;
const AKARI_BAND_COUNTS = { N60: 1672, WIDES: 1672, WIDEL: 1672, N160: 1672 };
const AKARI_DATA_ROOT = "https://irsa.ipac.caltech.edu/data/AKARI/";
const ZTF_SOURCE_ID = "ztf-dr7-cds-o3-reference-images";
const ZTF_SOURCE_ROOT = "https://alasky.cds.unistra.fr/ZTF/DR7/";
const ZTF_QUERY = "Enumerate every g/r/i NESTED order-3 pixel key 0..767 from CDS DR7 HpxFinder; preserve each HTTP 200 body and HTTP 404 outcome and apply the advertised IRSA whole-file resolver.";
const ZTF_ROW_COUNT = 220349;
const ZTF_FILE_COUNTS = { G: 65783, R: 69959, I: 26591 };
const ZTF_BANDS = ["g", "r", "i"] as const;
const ZTF_PAGE_ROW_COUNTS = { g: 89292, r: 95014, i: 36043 };
const ZTF_PAGE_404_COUNTS = { g: 176, r: 175, i: 257 };
const SPHEREX_SOURCE_ID = "spherex-qr2-2025w17-4b-0001-1";
const SPHEREX_QUERY = "ListObjectsV2 prefix=qr2/level2/2025W17_4B/l2b-v20-2025-240/{2,3,4,5,6}/level2_2025W17_4B_0001_1D{2,3,4,5,6}_spx_l2b-v20-2025-240.fits; one QR2 observation";
const SPHEREX_D1_V241_SOURCE_ID = "spherex-qr2-2025w17-4b-0001-1-d1-v241";
const SPHEREX_D1_V241_QUERY = "ListObjectsV2 prefix=qr2/level2/2025W17_4B/l2b-v20-2025-241/1/level2_2025W17_4B_0001_1D1_spx_l2b-v20-2025-241.fits; one QR2 D1 observation";
const SPHEREX_SOURCE_SPECS: Record<string, { query: string; processingVersion: string; detectors: number[]; expectedRows: number; versionedUnitId: boolean }> = {
  [SPHEREX_SOURCE_ID]: { query: SPHEREX_QUERY, processingVersion: "l2b-v20-2025-240", detectors: [2, 3, 4, 5, 6], expectedRows: 5, versionedUnitId: false },
  [SPHEREX_D1_V241_SOURCE_ID]: { query: SPHEREX_D1_V241_QUERY, processingVersion: "l2b-v20-2025-241", detectors: [1], expectedRows: 1, versionedUnitId: true },
};
const FDS_SOURCE_ID = "fds-dr1-science-fields";
const FDS_RELEASE_DESCRIPTION = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/157";
const FDS_QUERY = `SELECT TOP 5000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'FDS' AND release_description = '${FDS_RELEASE_DESCRIPTION}' AND dataproduct_type = 'image' ORDER BY dp_id`;
const FDS_BAND_COUNTS = { U: 20, G: 26, R: 26, I: 25 };
const KIDS_SOURCE_ID = "kids-dr5-eso-images";
const KIDS_RELEASE_DESCRIPTION = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/229";
const KIDS_ROSTER_URL = "https://kids.strw.leidenuniv.nl/DR5/kids_dr5.0_sci_wget.sh";
const KIDS_QUERY = `SELECT TOP 1000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'KIDS' AND release_description = '${KIDS_RELEASE_DESCRIPTION}' AND dataproduct_type = 'image' AND filter IN ('g_SDSS','r_SDSS','i_SDSS') ORDER BY dp_id`;
const KIDS_BAND_COUNTS = { G: 1347, R: 1347, I: 2694 };
const KIDS_ROSTER_BAND_COUNTS = { u: 1347, g: 1347, r: 1347, i: 1347, i2: 1347 };
const VPHAS_SOURCE_ID = "vphas-dr4-eso-images";
const VPHAS_RELEASE_DESCRIPTION = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/145";
const VPHAS_QUERY = `SELECT TOP 5000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description FROM ivoa.ObsCore WHERE obs_collection = 'VPHASplus' AND release_description = '${VPHAS_RELEASE_DESCRIPTION}' AND dataproduct_type = 'image' ORDER BY dp_id`;
const VPHAS_FILTER_COUNTS = { U: 2557, G: 3829, R: 4437, I: 1876, HALPHA: 2835 };
const VIKING_SOURCE_ID = "vista-viking-dr1-j-tiles";
const VIKING_RELEASE_DESCRIPTION = "https://www.eso.org/rm/api/v1/public/releaseDescriptions/24";
const VIKING_QUERY = `SELECT TOP 5000 dp_id, target_name, filter, obs_id, obs_creator_did, s_region, access_url, release_description, dataproduct_subtype FROM ivoa.ObsCore WHERE obs_collection = 'VIKING' AND release_description = '${VIKING_RELEASE_DESCRIPTION}' AND dataproduct_type = 'image' AND filter = 'J' AND (dataproduct_subtype IS NULL OR dataproduct_subtype = '') ORDER BY dp_id`;
export const isSurveyNativeAdapter = (adapter: NativeAdapter): boolean => ADAPTERS.has(adapter);

type Document = Record<string, any>;
interface SurveyManifest extends Document {
  schemaVersion: 1; adapter: NativeAdapter; surveyId: string; releaseId: string;
  capturedAt: string; coordinateFrame: "ICRS"; ordering: "NESTED";
  metadataDocuments: Array<NativeFile & { url?: string }>;
  rowFiles?: Array<NativeFile & { rows: number }>;
  rowCount?: number; inventoryComplete?: boolean;
}
interface Summary {
  sourceId: string; surveyId: string; releaseId: string; adapter: NativeAdapter;
  sourceUrl: string; sha256: string; capturedAt: string; scope: string;
  rowCount: number; indexedRows: number; unitCount: number; excludedRows: number; inventoryComplete: boolean; queryComplete: boolean;
  gaps?: string[]; headerFailures?: number; geometryFailures?: number; spectralConflicts?: number;
}
interface IndexedRow {
  sourceId: string; unitId: string; sRegion: string | null; firstIpix: number | null; lastIpix: number | null;
  payload: string;
}

/** Binding selectors are release/product contracts, independent of the displayed MOC. */
export function surveyNativeBinding(layer: Pick<NativeBinding, "layerId" | "surveyId" | "releaseId" | "product">): Pick<NativeBinding, "unitKind" | "sourceIds" | "selector"> | undefined {
  if (layer.surveyId === "decals" && layer.releaseId === "decals-dr5" && layer.layerId === "decals-dr5-color-footprint") {
    return { unitKind: "brick", sourceIds: ["legacy-dr5-bricks", "legacy-brick-geometry"], selector: { bands: ["G", "R", "Z"] } };
  }
  if (layer.surveyId === "iphas" && layer.releaseId === "iphas-dr2") {
    const product = layer.product.toLowerCase();
    if (product.includes("h-alpha")) return { unitKind: "ccd", sourceIds: [IPHAS_SOURCE_ID], selector: { bands: ["HALPHA"] } };
    const band = /\b([ri])-band\b/i.exec(layer.product)?.[1]?.toUpperCase();
    return band ? { unitKind: "ccd", sourceIds: [IPHAS_SOURCE_ID], selector: { bands: [band] } } : undefined;
  }
  if (layer.surveyId === "rubin" && layer.releaseId === "rubin-firstlook" && layer.layerId === "rubin-rubin-firstlook-rubin-first-look-imaging-moc") {
    return { unitKind: "image", sourceIds: [RUBIN_SOURCE_ID], selector: { bands: ["RGB"] } };
  }
  if (layer.surveyId === "vista" && layer.releaseId === "viking" && layer.layerId === "vista-viking-j-footprint") {
    return { unitKind: "tile", sourceIds: [VIKING_SOURCE_ID], selector: { bands: ["J"] } };
  }
  if (layer.surveyId === "vista" && layer.releaseId === "vista-vvv-dr4") {
    const product = layer.product.toLowerCase();
    if (product.includes("h bulge")) return { unitKind: "tile", sourceIds: ["vista-vvv-dr4-observations"], selector: { bands: ["H"], unitPrefixes: ["b"] } };
    if (product.includes("h disk")) return { unitKind: "tile", sourceIds: ["vista-vvv-dr4-observations"], selector: { bands: ["H"], unitPrefixes: ["d"] } };
    if (product.includes("j/y/z color")) return { unitKind: "tile", sourceIds: ["vista-vvv-dr4-observations"], selector: { bands: ["J", "Y", "Z"] } };
    const band = /\b([JYZ])(?:-band)?\b/i.exec(layer.product)?.[1]?.toUpperCase();
    if (band) return { unitKind: "tile", sourceIds: ["vista-vvv-dr4-observations"], selector: { bands: [band] } };
  }
  if (layer.surveyId === "skymapper" && layer.releaseId === "skymapper-dr4" && layer.layerId === "skymapper-dr4-color-footprint") {
    return { unitKind: "ccd", sourceIds: [SKYMapper_SOURCE_ID], selector: { bands: ["G", "R", "I"] } };
  }
  if (layer.surveyId === "2mass" && layer.releaseId === "2mass-6x") {
    const band = /\b([JHK])-band\b/i.exec(layer.product)?.[1]?.toUpperCase();
    if (!band) return undefined;
    return { unitKind: "image", sourceIds: TWOMASS_SOURCE_IDS, selector: { bands: [band] } };
  }
  if (layer.surveyId === "allwise" && layer.releaseId === "allwise") {
    const band = /\bW([34])\b/i.exec(layer.product)?.[1];
    if (!band) return undefined;
    return { unitKind: "tile", sourceIds: [ALLWISE_SOURCE_ID], selector: { bands: [`W${band}`] } };
  }
  if (layer.surveyId === "cfhtls" && layer.releaseId === "cfhtls-wide") {
    const band = layer.product.match(/\b([ugriz])-band\b/i)?.[1]?.toUpperCase();
    return band ? { unitKind: "field", sourceIds: [CFHTLS_SOURCE_ID], selector: { bands: [band] } } : undefined;
  }
  if (layer.surveyId === "des" && layer.releaseId === "des-dr2") {
    const band = layer.product.match(/\b([grizY])-band\b/i)?.[1]?.toUpperCase();
    if (!band && !/\bcolor\b/i.test(layer.product)) return undefined;
    return { unitKind: "tile", sourceIds: [DES_SOURCE_ID], selector: { bands: band ? [band] : ["G", "R", "I", "Z", "Y"] } };
  }
  if (layer.surveyId === "act" && layer.releaseId === "act-dr5") {
    const frequency = /\b(90|150|220)\s*GHz\b/i.exec(layer.product)?.[1];
    return frequency ? { unitKind: "image", sourceIds: [ACT_SOURCE_ID], selector: { bands: [`${Number(frequency)} GHZ`] } } : undefined;
  }
  if (["nvss", "sumss", "wenss"].includes(layer.surveyId)) {
    const spec = SKYVIEW_RADIO_SPECS[layer.surveyId];
    if (!spec || layer.releaseId !== spec.releaseId || !/imaging/i.test(layer.product)) return undefined;
    return { unitKind: "image", sourceIds: [spec.sourceId], selector: { bands: [spec.band] } };
  }
  if (layer.surveyId === "panstarrs" && layer.releaseId === "panstarrs-dr1") {
    const band = /\b([grizy])-band\s+imaging\b/i.exec(layer.product)?.[1]?.toUpperCase();
    return band ? { unitKind: "tile", sourceIds: [PANSTARRS_SOURCE_ID], selector: { bands: [band] } } : undefined;
  }
  if (layer.surveyId === "akari" && layer.releaseId === "akari-fis" && layer.layerId === "akari-akari-fis-akari-fis-color-coverage-moc") {
    return { unitKind: "image", sourceIds: [AKARI_SOURCE_ID], selector: { bands: ["N60", "WIDES", "WIDEL"] } };
  }
  if (layer.surveyId === "ztf" && layer.releaseId === "ztf-dr7") {
    const product = layer.product.toLowerCase();
    if (product.includes("color")) return { unitKind: "image", sourceIds: [ZTF_SOURCE_ID], selector: { bands: ["G", "R", "I"] } };
    const band = /\b([gri])-band\s+imaging\b/i.exec(layer.product)?.[1]?.toUpperCase();
    return band ? { unitKind: "image", sourceIds: [ZTF_SOURCE_ID], selector: { bands: [band] } } : undefined;
  }
  if (layer.surveyId === "decaps" && layer.releaseId === "decaps-dr2" && layer.layerId === "decaps-decaps-dr2-decaps-dr2-color-imaging-moc") {
    return { unitKind: "ccd", sourceIds: [DECAPS_SOURCE_ID], selector: { bands: ["G", "I", "R", "Y", "Z"] } };
  }
  if (layer.surveyId === "spherex" && layer.releaseId === "spherex-qr2") {
    const detector = layer.product.match(/\bD([1-6])\b/i)?.[1];
    return { unitKind: "image", sourceIds: [SPHEREX_SOURCE_ID, SPHEREX_D1_V241_SOURCE_ID], selector: { bands: detector ? [`D${detector}`] : ["D1", "D2", "D3", "D4", "D5", "D6"] } };
  }
  if (layer.surveyId === "fds" && layer.releaseId === "fds-dr1") {
    const band = layer.product.match(/\b([ugri])-band\b/i)?.[1]?.toUpperCase();
    if (!band && !/\bcolor\b/i.test(layer.product)) return undefined;
    return { unitKind: "field", sourceIds: [FDS_SOURCE_ID], selector: { bands: band ? [band] : ["U", "G", "R", "I"] } };
  }
  if (layer.surveyId === "kids" && layer.releaseId === "kids-dr5" && layer.layerId === "kids-dr5-color-footprint") {
    return { unitKind: "tile", sourceIds: [KIDS_SOURCE_ID], selector: { bands: ["G", "R", "I"] } };
  }
  if (layer.surveyId === "vphas" && layer.releaseId === "vphas-dr4") {
    const product = layer.product.toLowerCase();
    if (product.includes("h-alpha")) return { unitKind: "image", sourceIds: [VPHAS_SOURCE_ID], selector: { bands: ["HALPHA"] } };
    const band = /\b([ugri])-band\b/i.exec(layer.product)?.[1]?.toUpperCase();
    return { unitKind: "image", sourceIds: [VPHAS_SOURCE_ID], selector: { bands: band ? [band] : ["U", "G", "R", "I", "HALPHA"] } };
  }
  if (layer.surveyId === "gaia" && layer.releaseId === "gaia-dr3" && layer.layerId === "gaia-dr3-main-source-presence") return { unitKind: "healpix-range", sourceIds: ["gaia-dr3-file-partitions"] };
  if (layer.surveyId === "sdss" && layer.releaseId === "sdss-dr09") {
    const band = layer.product.match(/\b([ugriz])-band\b/i)?.[1]?.toUpperCase();
    if (!band && !/DR9.*color/i.test(layer.product)) return undefined;
    return { unitKind: "field", sourceIds: ["sdss-dr9-fields"], selector: { releaseTags: ["DR9"], ...(band ? { bands: [band] } : {}) } };
  }
  if (layer.surveyId === "galex" && ["galex-gr6-gr7", "galex-gr6-ais"].includes(layer.releaseId)) {
    const band = layer.product.match(/\b(FUV|NUV)\b/i)?.[1]?.toUpperCase();
    return { unitKind: "observation", sourceIds: ["galex-public-images"], selector: { releaseTags: layer.releaseId === "galex-gr6-ais" ? ["GR6"] : ["GR6", "GR7"], ...(band ? { bands: [band] } : {}), ...(layer.releaseId === "galex-gr6-ais" ? { project: "AIS" } : {}) } };
  }
  if (layer.surveyId === "jwst" && layer.releaseId === "dr1") {
    if (layer.layerId === "moc-jwst-dr1-611dfe774f60") return { unitKind: "observation", sourceIds: ["jwst-early-release-images"], selector: { proposalIds: ["2731"], instrument: "NIRCAM", targets: ["NGC-3324"] } };
    if (layer.layerId === "moc-jwst-dr1-c0924d1a5468") return { unitKind: "observation", sourceIds: ["jwst-early-release-images"], selector: { proposalIds: ["2736"], instrument: "NIRCAM", targets: ["SMACS-J0723.3-7327"] } };
  }
  return undefined;
}

export function nativeBindingIndexRoute(binding: Pick<NativeBinding, "layerId" | "surveyId" | "releaseId" | "product">): "survey" | "source-unit" | "unsupported" {
  const mapped = surveyNativeBinding(binding);
  if (!mapped?.sourceIds.length) return "unsupported";
  if (mapped.sourceIds.every(sourceId => sourceId.startsWith("legacy-"))) return "source-unit";
  if (mapped.sourceIds.every(sourceId => !sourceId.startsWith("legacy-"))) return "survey";
  return "unsupported";
}

interface PanstarrsListingRow { projectionId: number; subcell: number; ra: number; dec: number; band: string; type: string; fileName: string; shortName: string; badFlag: number }

export function parsePanstarrsListing(body: string, expectedSkycell: string): PanstarrsListingRow[] {
  const lines = body.trimEnd().split(/\r?\n/);
  const headers = ["projcell", "subcell", "ra", "dec", "filter", "mjd", "type", "filename", "shortname", "badflag"];
  if (lines.shift()?.trim().split(/\s+/).join(" ") !== headers.join(" ")) throw new Error("Pan-STARRS image-list response has an unexpected header");
  const [projectionText, subcellText] = expectedSkycell.split(".");
  const expectedProjection = Number(projectionText);
  const expectedSubcell = Number(subcellText);
  const rows: PanstarrsListingRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== headers.length) throw new Error("Pan-STARRS image-list row has an unexpected width");
    const [projection, subcell, ra, dec, filter, mjd, type, filename, shortname, badflag] = fields;
    const numeric = [Number(projection), Number(subcell), Number(ra), Number(dec), Number(mjd), Number(badflag)];
    if (!numeric.every(Number.isFinite) || numeric[0] !== expectedProjection || numeric[1] !== expectedSubcell
      || numeric[2]! <= -360 || numeric[2]! >= 360 || numeric[3]! < -90 || numeric[3]! > 90
      || !Number.isSafeInteger(numeric[5]) || numeric[5]! < 0
      || !["g", "r", "i", "z", "y"].includes(String(filter)) || type !== "stack"
      || !/^\/rings\.v3\.skycell\/\d{4}\/\d{3}\/rings\.v3\.skycell\.\d{4}\.\d{3}\.stk\.[grizy]\.unconv\.fits$/.test(String(filename))
      || String(shortname) !== String(filename).split("/").at(-1)) throw new Error("Pan-STARRS image-list row does not match its requested stack skycell");
    rows.push({ projectionId: numeric[0]!, subcell: numeric[1]!, ra: ((numeric[2]! % 360) + 360) % 360, dec: numeric[3]!, band: String(filter).toUpperCase(),
      type: String(type), fileName: String(filename), shortName: String(shortname), badFlag: numeric[5]! });
  }
  return rows;
}

interface ZtfHpxFinderRow { name: string; fileName: string; band: string; field: string; ccd: number; quadrant: number; ra: number; dec: number; stc: string; generatorPath: string }

export function parseZtfHpxFinderPage(body: string, band: typeof ZTF_BANDS[number]): ZtfHpxFinderRow[] {
  if (!ZTF_BANDS.includes(band)) throw new Error("ZTF HpxFinder page requires one of g/r/i");
  const rows: ZtfHpxFinderRow[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let sourceRow: Document;
    try { sourceRow = JSON.parse(line) as Document; } catch { throw new Error("ZTF HpxFinder page contains invalid JSONL"); }
    const name = String(sourceRow.name ?? "");
    const match = /^ztf_(\d{6})_z([gri])_c(0[1-9]|1[0-6])_q([1-4])_refimg$/.exec(name);
    const ra = Number(sourceRow.ra);
    const dec = Number(sourceRow.dec);
    const stc = String(sourceRow.stc ?? "").trim();
    const tokens = stc.split(/\s+/);
    const coordinates = tokens.slice(2).map(Number);
    if (!match || match[2] !== band || !Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90
      || tokens[0]?.toUpperCase() !== "POLYGON" || tokens[1]?.toUpperCase() !== "J2000"
      || coordinates.length !== 8 || coordinates.some((value, index) => !Number.isFinite(value) || (index % 2 === 0 ? value < 0 || value >= 360 : value < -90 || value > 90))
      || !Number.isSafeInteger(Number(sourceRow.cellmem)) || Number(sourceRow.cellmem) < 1
      || typeof sourceRow.path !== "string" || sourceRow.path.length > 1024) {
      throw new Error("ZTF HpxFinder row does not match its band-specific CCD-quadrant reference image and J2000 frame");
    }
    rows.push({ name, fileName: `${name}.fits`, band: match[2]!.toUpperCase(), field: match[1]!, ccd: Number(match[3]), quadrant: Number(match[4]),
      ra, dec, stc, generatorPath: sourceRow.path });
  }
  return rows;
}

export function ztfReferenceImageUri(fileName: string): string {
  const match = /^ztf_(\d{6})_z([gri])_c(0[1-9]|1[0-6])_q([1-4])_refimg\.fits$/.exec(fileName);
  if (!match) throw new Error("Invalid ZTF reference-image filename");
  const field = match[1]!;
  return `https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/${field.slice(0, 3)}/field${field}/z${match[2]}/ccd${Number(match[3])}/q${match[4]}/${fileName}`;
}

export function matchesPanstarrsListingEvidence(row: Document, sourceRow: { fileName: string; responseSha256: string }, gridSha256: string): boolean {
  const metadata = row.sourceMetadata as Document | undefined;
  return Boolean(metadata && sourceRow.fileName === metadata.sourceFilename
    && sourceRow.responseSha256 === metadata.listingResponseSha256 && metadata.gridSha256 === gridSha256);
}

export async function loadSurveyManifest(root: string, ref: string, source: NativeSource, expected?: Pick<NativeFile, "sha256" | "sizeBytes">): Promise<{ manifest: SurveyManifest; files: NativeFile[] }> {
  if (!isSurveyNativeAdapter(source.adapter)) throw new Error("Unsupported survey metadata adapter");
  nativeMetadataUrl(source.sourceUrl, source.adapter);
  const file = await nativeFile(root, ref, expected);
  if (file.sizeBytes > 16 * 1024 * 1024) throw new Error("Survey manifest exceeded its metadata budget");
  const manifest = JSON.parse(await readFile(nativeEvidencePath(root, ref), "utf8")) as SurveyManifest;
  if (manifest.schemaVersion !== 1 || manifest.adapter !== source.adapter || manifest.surveyId !== source.surveyId || manifest.releaseId !== source.releaseId
    || manifest.coordinateFrame !== "ICRS" || manifest.ordering !== "NESTED" || !Number.isFinite(Date.parse(manifest.capturedAt))
    || !Array.isArray(manifest.metadataDocuments) || !manifest.metadataDocuments.length || manifest.metadataDocuments.length + (manifest.rowFiles?.length ?? 0) > 4096) throw new Error("Survey manifest identity, coordinate contract or provenance is invalid");
  if (source.adapter === "gaia-healpix-range") {
    if (manifest.nativeOrder !== 8 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.listing?.complete !== true || manifest.scope?.fileRosterComplete !== true) throw new Error("Gaia import requires the complete official order-8 file roster");
    let end = -1;
    for (const row of manifest.files) {
      if (!Number.isSafeInteger(row.firstIpix) || !Number.isSafeInteger(row.lastIpix) || row.firstIpix !== end + 1 || row.lastIpix < row.firstIpix || row.lastIpix >= 12 * 4 ** 8
        || row.unitId !== `GaiaSource_${String(row.firstIpix).padStart(6, "0")}-${String(row.lastIpix).padStart(6, "0")}`
        || row.filename !== `${row.unitId}.csv.gz` || !/^[a-f0-9]{32}$/i.test(row.sourceMd5 ?? "") || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1) throw new Error("Invalid or overlapping Gaia native file range");
      const url = new URL(row.url);
      if (url.protocol !== "https:" || url.hostname !== "cdn.gea.esac.esa.int" && url.hostname !== "gaia.eu-1.cdn77-storage.com" || url.pathname !== `/Gaia/gdr3/gaia_source/${row.filename}` || url.username || url.password) throw new Error("Gaia file URI is not an official roster identity");
      end = row.lastIpix;
    }
    if (end !== 12 * 4 ** 8 - 1) throw new Error("Gaia native roster does not cover its declared order-8 partition domain");
  } else if (!Array.isArray(manifest.rowFiles) || !manifest.rowFiles.length || !Number.isSafeInteger(manifest.rowCount) || manifest.rowCount! < 1) throw new Error("Survey observation/field import needs locked row files");
  if (source.adapter === "skyview-radio-maps") {
    const spec = SKYVIEW_RADIO_SPECS[source.surveyId];
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    const pages = manifest.sourcePagination;
    const mapReceipts = pages?.maps;
    const headerEvidence = documents.get(SKYVIEW_RADIO_HEADER_REF);
    const xmlEvidence = documents.get(`metadata/${source.surveyId}.xml.gz`);
    const publisherManifest = documents.get("metadata/survey.manifest");
    const successfulHeaders = Array.isArray(mapReceipts) ? mapReceipts.filter((item: Document) => item.headerStatus === "captured").length : -1;
    const failedHeaders = Array.isArray(mapReceipts) ? mapReceipts.filter((item: Document) => item.headerStatus === "failed").length : -1;
    const geometryFailures = Array.isArray(mapReceipts) ? mapReceipts.filter((item: Document) => item.geometryStatus !== "mapped").length : -1;
    const validRows = (manifest.rowFiles ?? []).some(rowFile => rowFile.ref === "normalized/native-rows.ndjson.gz" && rowFile.rows === spec?.expectedRows);
    if (!spec || source.id !== spec.sourceId || source.releaseId !== spec.releaseId
      || source.sourceUrl !== `https://skyview.gsfc.nasa.gov/current/jar/surveys/xml/${spec.xmlName}.xml.gz`
      || manifest.deliveryClass !== "evidence" || manifest.nativeCoordinateFrame !== spec.nativeFrame
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false || manifest.rowCount !== spec.expectedRows
      || manifest.scope?.expectedRowCount !== spec.expectedRows || manifest.scope?.xmlRosterPath !== `metadata/${spec.xmlName}.xml.gz`
      || manifest.scope?.headerEvidenceRef !== SKYVIEW_RADIO_HEADER_REF || manifest.scope?.fullSurveyInventory !== false
      || manifest.scope?.validPixelMasksChecked !== false || manifest.scope?.geometryPrecision !== "estimated"
      || pages?.queryPagesComplete !== true || pages?.xmlStatus !== 200 || pages?.xmlUrl !== source.sourceUrl
      || pages?.xmlRowCount !== spec.expectedRows || pages?.xmlSha256 !== xmlEvidence?.sha256
      || pages?.publisherManifestSha256 !== publisherManifest?.sha256
      || pages?.headerEvidenceSha256 !== headerEvidence?.sha256
      || pages?.headerSuccessCount !== successfulHeaders || manifest.scope?.headerSuccessCount !== successfulHeaders
      || pages?.headerFailureCount !== failedHeaders || manifest.scope?.headerFailureCount !== failedHeaders
      || pages?.geometryFailureCount !== geometryFailures || manifest.scope?.geometryFailureCount !== geometryFailures
      || successfulHeaders + failedHeaders !== spec.expectedRows
      || !Array.isArray(mapReceipts) || mapReceipts.length !== spec.expectedRows
      || ![headerEvidence, xmlEvidence, publisherManifest].every((document: Document | undefined) => document
        && /^[a-f0-9]{64}$/.test(document.sha256 ?? "") && Number.isSafeInteger(document.sizeBytes) && document.sizeBytes > 0)
      || !validRows || !Array.isArray(manifest.gaps) || manifest.gaps.some((gap: unknown) => typeof gap !== "string" || gap.length > 240)) {
      throw new Error("SkyView radio import must retain the exact published XML roster, every native map identity, and its actual header-range outcome");
    }
    const identities = new Set<string>();
    for (const item of mapReceipts as Document[]) {
      if (typeof item.unitId !== "string" || !item.unitId || identities.has(item.unitId)
        || item.url !== `${spec.mapRoot}${item.relativePath}` || item.headerStatus !== "captured" && item.headerStatus !== "failed"
        || !["mapped", "failed", "unavailable"].includes(item.geometryStatus)
        || item.headerStatus === "captured" && (!/^[a-f0-9]{64}$/.test(item.headerSha256 ?? "") || !Number.isSafeInteger(item.headerBytes) || item.headerBytes < 2880)
        || item.headerStatus === "failed" && typeof item.error !== "string") {
        throw new Error("SkyView radio XML roster contains an invalid or duplicate map identity or header receipt");
      }
      identities.add(item.unitId);
    }
  }
  if (source.adapter === "irsa-akari-fis-map") {
    const scope = manifest.scope;
    const pages = manifest.sourcePagination?.pages;
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    if (source.id !== AKARI_SOURCE_ID || source.surveyId !== "akari" || source.releaseId !== "akari-fis" || source.query !== AKARI_QUERY
      || manifest.deliveryClass !== "evidence" || manifest.nativeCoordinateFrame !== "FK5(J2000)"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== true || manifest.rowCount !== AKARI_ROW_COUNT
      || scope?.table !== "akari.akari_images" || scope?.datasetVersion !== "2.1" || scope?.regionCount !== AKARI_REGION_COUNT
      || scope?.expectedRowCount !== AKARI_ROW_COUNT || scope?.fileType !== "science" || scope?.validPixelMasksChecked !== false
      || JSON.stringify(scope?.bands) !== JSON.stringify(["N60", "WideS", "WideL", "N160"])
      || !scope?.bandCounts || Object.entries(AKARI_BAND_COUNTS).some(([band, count]) => scope.bandCounts[band] !== count)
      || manifest.sourcePagination?.queryPagesComplete !== true || manifest.sourcePagination?.denominatorsStable !== true
      || manifest.sourcePagination?.regionListCount !== AKARI_REGION_COUNT || manifest.sourcePagination?.directoryMembershipComplete !== true
      || !Array.isArray(pages) || pages.length !== 4 || pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) !== AKARI_ROW_COUNT
      || !pages.every((page: Document, index: number) => page.status === 200 && page.queryStatus === "OK" && page.overflow === false
        && page.band === ["N60", "WideS", "WideL", "N160"][index] && page.rows === AKARI_REGION_COUNT
        && documents.get(page.ref)?.sha256 === page.sha256 && documents.get(page.ref)?.sizeBytes === page.sizeBytes)
      || !(manifest.rowFiles ?? []).some(rowFile => rowFile.ref === "normalized/native-rows.ndjson.gz" && rowFile.rows === AKARI_ROW_COUNT)) {
      throw new Error("AKARI FIS import must retain the four complete source-listed science-map bands and matching region roster");
    }
  }
  if (source.adapter === "cds-ztf-progenitor-o3") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    const bands = scope?.fileCounts;
    if (source.id !== ZTF_SOURCE_ID || source.surveyId !== "ztf" || source.releaseId !== "ztf-dr7" || source.query !== ZTF_QUERY
      || manifest.deliveryClass !== "evidence" || manifest.nativeCoordinateFrame !== "FK5(J2000)"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false || manifest.rowCount !== ZTF_ROW_COUNT
      || scope?.publisherProduct !== "CDS/P/ZTF/DR7" || scope?.progenitorOrder !== 3 || scope?.keyCount !== 2304
      || scope?.http200Pages !== 1696 || scope?.http404Pages !== 608 || scope?.inputRows !== ZTF_ROW_COUNT
      || scope?.uniqueReferenceImages !== 162333 || scope?.duplicateRows !== 58016 || scope?.historicalReleaseInventoryComplete !== false
      || scope?.directFileSource !== "IRSA ZTF products/ref" || scope?.validPixelMasksChecked !== false
      || JSON.stringify(scope?.bands) !== JSON.stringify(["g", "r", "i"])
      || !bands || Object.entries(ZTF_FILE_COUNTS).some(([band, count]) => bands[band] !== count)
      || pagination?.queryPagesComplete !== true || pagination?.requestedKeys !== 2304 || pagination?.http200Pages !== 1696 || pagination?.http404Pages !== 608
      || pagination?.failedPages !== 0 || pagination?.inputRows !== ZTF_ROW_COUNT || pagination?.uniqueReferenceImages !== 162333
      || documents.get("metadata/research-manifest.json")?.sha256 !== pagination?.researchManifestSha256
      || !documents.has("metadata/page-evidence.ndjson.gz")
      || !["metadata/g-metadata.xml", "metadata/r-metadata.xml", "metadata/i-metadata.xml"].every(ref => documents.has(ref))
      || !(manifest.rowFiles ?? []).some(rowFile => rowFile.ref === "normalized/native-rows.ndjson.gz" && rowFile.rows === ZTF_ROW_COUNT)) {
      throw new Error("ZTF import must retain all CDS DR7 O3 progenitor page outcomes and clearly bounded historical scope");
    }
  }
  if (source.adapter === "eso-obscore-vvv" && (source.surveyId !== "vista" || source.releaseId !== "vista-vvv-dr4"
    || manifest.nativeCoordinateFrame !== "J2000" || typeof manifest.queryPagesComplete !== "boolean"
    || manifest.scope?.releaseDescription !== "https://www.eso.org/rm/api/v1/public/releaseDescriptions/80"
    || manifest.scope?.cumulativeInventory !== false)) throw new Error("VVV input must retain the exact DR4 incremental ObsCore scope and J2000 provenance");
  if (source.adapter === "eso-obscore-fds") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    const bandCounts = scope?.bandCounts;
    if (manifest.deliveryClass !== "evidence" || source.id !== FDS_SOURCE_ID || source.surveyId !== "fds" || source.releaseId !== "fds-dr1"
      || source.query !== FDS_QUERY || manifest.nativeCoordinateFrame !== "J2000"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== true
      || scope?.releaseDescription !== FDS_RELEASE_DESCRIPTION || scope?.obsCollection !== "FDS"
      || scope?.scienceImageRowsOnly !== true || scope?.weightMapRowsIncluded !== false
      || scope?.expectedRowCount !== 97 || scope?.expectedFieldCount !== 26
      || JSON.stringify(scope?.filters) !== JSON.stringify(["u_SDSS", "g_SDSS", "r_SDSS", "i_SDSS"])
      || !bandCounts || Object.keys(bandCounts).length !== 4
      || Object.entries(FDS_BAND_COUNTS).some(([band, count]) => bandCounts[band] !== count)
      || manifest.rowCount !== 97 || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 5000
      || pagination?.expectedRowCount !== 97 || pagination?.dataLinkThisCount !== 97 || pagination?.dataLinkErrors !== 0
      || pagination?.denominator?.status !== 200 || pagination?.denominator?.queryStatus !== "OK"
      || pagination?.denominator?.rowCount !== 97 || pagination?.releaseDocument?.status !== 200
      || !Array.isArray(pages) || pages.length !== 1 || pageRows !== 97
      || pages[0]?.status !== 200 || pages[0]?.queryStatus !== "OK" || pages[0]?.rows !== 97 || pages[0]?.overflow !== false
      || (manifest.metadataDocuments.length < 3)) {
      throw new Error("FDS DR1 input must retain the complete official 97-row science-image roster and its DataLink evidence");
    }
  }
  if (source.adapter === "eso-obscore-kids") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    const bands = scope?.bandCounts;
    const rosterBands = scope?.rosterBandCounts;
    const roster = manifest.metadataDocuments.find(document => document.ref === "metadata/kids_dr5.0_sci_wget.sh");
    const datalinks = manifest.metadataDocuments.find(document => document.ref === "metadata/datalinks.ndjson.gz");
    if (manifest.deliveryClass !== "evidence" || source.id !== KIDS_SOURCE_ID || source.surveyId !== "kids" || source.releaseId !== "kids-dr5"
      || source.query !== KIDS_QUERY || manifest.nativeCoordinateFrame !== "J2000"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== true
      || scope?.releaseDescription !== KIDS_RELEASE_DESCRIPTION || scope?.obsCollection !== "KIDS"
      || scope?.scienceImageRowsOnly !== true || scope?.expectedRowCount !== 5388 || scope?.expectedTileCount !== 1347
      || scope?.sourceRosterRows !== 6735 || scope?.sourceRosterTileCount !== 1347 || scope?.rosterJoinRows !== 5388
      || !rosterBands || Object.keys(rosterBands).length !== 5
      || Object.entries(KIDS_ROSTER_BAND_COUNTS).some(([band, count]) => rosterBands[band] !== count)
      || JSON.stringify(scope?.filters) !== JSON.stringify(["g_SDSS", "r_SDSS", "i_SDSS"])
      || !bands || Object.keys(bands).length !== 3
      || Object.entries(KIDS_BAND_COUNTS).some(([band, count]) => bands[band] !== count)
      || scope?.iEpochCounts?.i !== 1347 || scope?.iEpochCounts?.i2 !== 1347
      || manifest.rowCount !== 5388 || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 1000
      || pagination?.expectedRowCount !== 5388 || pagination?.tileCount !== 1347
      || pagination?.dataLinkRequestedCount !== 5388 || pagination?.dataLinkThisCount !== 5388 || pagination?.dataLinkErrors !== 0
      || pagination?.denominator?.status !== 200 || pagination?.denominator?.queryStatus !== "OK" || pagination?.denominator?.rowCount !== 5388
      || pagination?.bandCounts?.status !== 200 || pagination?.bandCounts?.queryStatus !== "OK"
      || !Array.isArray(pages) || pages.length !== 6 || pageRows !== 5388
      || !pages.every((page: Document, index: number) => page.status === 200 && page.queryStatus === "OK"
        && page.rows === (index === 5 ? 388 : 1000) && page.overflow === false
        && page.query === (index === 0 ? KIDS_QUERY : `${KIDS_QUERY.replace(" ORDER BY dp_id", "")} AND dp_id > '${pages[index - 1].lastDpId}' ORDER BY dp_id`)
        && typeof page.firstDpId === "string" && typeof page.lastDpId === "string" && page.firstDpId <= page.lastDpId
        && (index === 0 || pages[index - 1].lastDpId < page.firstDpId))
      || !roster || roster.sourceUrl !== KIDS_ROSTER_URL || !datalinks || manifest.metadataDocuments.length < 11) {
      throw new Error("KiDS DR5 input must retain the complete 5,388-row gri roster, two i epochs, exact Astro-WISE filename join and DataLink evidence");
    }
  }
  if (source.adapter === "eso-obscore-vphas") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    const bands = scope?.bandCounts;
    const rawLinks = manifest.metadataDocuments.find(document => document.ref === "metadata/datalinks.ndjson.gz");
    const releaseDocument = manifest.metadataDocuments.find(document => document.ref === "metadata/release-description-145.pdf");
    const continuationBase = VPHAS_QUERY.replace(" ORDER BY dp_id", "");
    if (manifest.deliveryClass !== "evidence" || source.id !== VPHAS_SOURCE_ID || source.surveyId !== "vphas" || source.releaseId !== "vphas-dr4"
      || source.query !== VPHAS_QUERY || manifest.nativeCoordinateFrame !== "J2000"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false
      || scope?.releaseDescription !== VPHAS_RELEASE_DESCRIPTION || scope?.obsCollection !== "VPHASplus"
      || scope?.dataproductType !== "image" || scope?.cumulativeInventory !== false
      || scope?.nativeProduct !== "unstacked 32-CCD OmegaCAM pawprint exposures"
      || scope?.geometryComponents !== "per-file UNION of source CCD polygons" || scope?.validPixelMasksChecked !== false
      || scope?.expectedRowCount !== 15534 || !Number.isSafeInteger(scope?.expectedFieldCount) || scope.expectedFieldCount < 1
      || JSON.stringify(scope?.filters) !== JSON.stringify(["g_SDSS", "i_SDSS", "NB_659", "r_SDSS", "u_SDSS"])
      || !bands || Object.keys(bands).length !== 5 || Object.entries(VPHAS_FILTER_COUNTS).some(([band, count]) => bands[band] !== count)
      || manifest.rowCount !== 15534 || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 5000
      || pagination?.expectedRowCount !== 15534 || pagination?.dataLinkRequestedCount !== 15534
      || pagination?.dataLinkThisCount !== 15534 || pagination?.dataLinkErrors !== 0
      || pagination?.denominator?.status !== 200 || pagination?.denominator?.queryStatus !== "OK" || pagination?.denominator?.rowCount !== 15534
      || pagination?.bandCounts?.status !== 200 || pagination?.bandCounts?.queryStatus !== "OK"
      || !Array.isArray(pages) || pages.length !== 4 || pageRows !== 15534
      || !pages.every((page: Document, index: number) => page.status === 200
        && page.queryStatus === (page.overflow ? "OVERFLOW" : "OK")
        && Number.isSafeInteger(page.rows) && page.rows === (index === 3 ? 534 : 5000)
        && page.query === (index === 0 ? VPHAS_QUERY : `${continuationBase} AND dp_id > '${pages[index - 1].lastDpId}' ORDER BY dp_id`)
        && typeof page.firstDpId === "string" && typeof page.lastDpId === "string" && page.firstDpId <= page.lastDpId
        && (index === 0 || pages[index - 1].lastDpId < page.firstDpId))
      || !rawLinks || !releaseDocument || manifest.metadataDocuments.length < 9) {
      throw new Error("VPHAS+ DR4 input must retain all 15,534 final-submission images, exact band counts, ordered TAP pages and DataLink evidence");
    }
  }
  if (source.adapter === "eso-obscore-viking") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    if (manifest.deliveryClass !== "evidence" || source.id !== VIKING_SOURCE_ID || source.surveyId !== "vista" || source.releaseId !== "viking"
      || source.query !== VIKING_QUERY || manifest.nativeCoordinateFrame !== "J2000"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false
      || scope?.releaseDescription !== VIKING_RELEASE_DESCRIPTION || scope?.obsCollection !== "VIKING"
      || scope?.dataproductType !== "image" || scope?.filter !== "J" || scope?.subtypeSelector !== "blank-or-null"
      || scope?.officialReleaseTileCount !== 151 || scope?.expectedRowCount !== 110 || scope?.expectedTileCount !== 110
      || scope?.unitIdentity !== "numeric ESO source filename tile suffix" || scope?.validPixelMasksChecked !== false
      || manifest.rowCount !== 110 || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 5000
      || pagination?.expectedRowCount !== 110 || pagination?.tileCount !== 110
      || pagination?.dataLinkRequestedCount !== 110 || pagination?.dataLinkThisCount !== 110 || pagination?.dataLinkErrors !== 0
      || pagination?.denominator?.status !== 200 || pagination?.denominator?.queryStatus !== "OK" || pagination?.denominator?.rowCount !== 110
      || pagination?.bandCounts?.status !== 200 || pagination?.bandCounts?.queryStatus !== "OK" || pagination?.bandCounts?.J !== 110
      || !Array.isArray(pages) || pages.length !== 1 || pageRows !== 110
      || pages[0]?.status !== 200 || pages[0]?.queryStatus !== "OK" || pages[0]?.rows !== 110 || pages[0]?.overflow !== false
      || pages[0]?.query !== VIKING_QUERY
      || !manifest.metadataDocuments.some(document => document.ref === "metadata/datalinks.ndjson.gz")
      || !manifest.metadataDocuments.some(document => document.ref === "metadata/release-description-24.pdf")
      || manifest.metadataDocuments.length < 6) {
      throw new Error("VIKING input must retain the bounded 110-row J Tile image roster, official 151-Tile denominator and DataLink evidence");
    }
  }
  if (source.adapter === "skymapper-dr4-ccd") {
    const pages = manifest.sourcePagination?.pages;
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    const terminalPageRows = Number(pages?.at(-1)?.rows);
    const expectedRows = Number(manifest.scope?.expectedRowCount);
    if (source.id !== SKYMapper_SOURCE_ID || source.surveyId !== "skymapper" || source.releaseId !== "skymapper-dr4"
      || source.query !== SKYMapper_QUERY || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false
      || manifest.scope?.imageIdStartInclusive !== 20140315000000 || manifest.scope?.imageIdEndExclusive !== 20140318000000
      || JSON.stringify(manifest.scope?.filters) !== JSON.stringify(["g", "r", "i"]) || !Number.isSafeInteger(expectedRows) || expectedRows !== manifest.rowCount
      || manifest.sourcePagination?.expectedRowCount !== expectedRows || manifest.sourcePagination?.queryPagesComplete !== true
      || manifest.sourcePagination?.pageSize !== 5000 || !Array.isArray(pages) || !pages.length || pageRows !== expectedRows
      || !pages.every((page: Document) => page.status === 200 && page.queryStatus === "OK" && Number.isSafeInteger(page.rows) && page.rows >= 0 && page.rows <= 5000)
      || terminalPageRows >= 5000 || pages.slice(0, -1).some((page: Document) => page.rows !== 5000)) {
      throw new Error("SkyMapper input must retain complete keyset pages and the bounded 2014-03-15 through 2014-03-18 g/r/i CCD count");
    }
  }
  if (source.adapter === "twomass-6x-atlas") {
    const scope = manifest.scope;
    const pages = manifest.sourcePagination?.pages;
    const expectedRows = Number(scope?.expectedRowCount);
    const spec = TWOMASS_SOURCE_SPECS[source.id];
    if (!spec || source.surveyId !== "2mass" || source.releaseId !== "2mass-6x"
      || source.query !== spec.query || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false
      || scope?.dataset !== "sx" || scope?.position !== spec.position || scope?.sizeDeg !== 1
      || scope?.format !== "image/fits" || scope?.maxRecords !== 1000 || scope?.fullReleaseInventory !== false
      || !Number.isSafeInteger(expectedRows) || expectedRows !== spec.expectedRows || manifest.rowCount !== spec.expectedRows
      || scope?.coaddCount !== spec.coaddCount || JSON.stringify(scope?.bands) !== JSON.stringify(["J", "H", "K"])
      || scope?.atlasType !== "A"
      || manifest.sourcePagination?.queryPagesComplete !== true || manifest.sourcePagination?.pageSize !== 1000
      || manifest.sourcePagination?.expectedRowCount !== expectedRows || !Array.isArray(pages) || pages.length !== 1
      || pages[0]?.query !== spec.query || pages[0]?.status !== 200 || pages[0]?.queryStatus !== "OK" || pages[0]?.rows !== expectedRows
      || pages[0]?.overflow !== false || expectedRows > 1000) {
      throw new Error("2MASS 6X input must retain a complete, locked one-degree Atlas-image SIA response");
    }
  }
  if (source.adapter === "allwise-ibe-atlas") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    const queryBeforeOrder = ALLWISE_QUERY.slice(0, ALLWISE_QUERY.indexOf(" ORDER BY coadd_id, band"));
    if (manifest.deliveryClass !== "evidence" || source.id !== ALLWISE_SOURCE_ID || source.surveyId !== "allwise" || source.releaseId !== "allwise"
      || source.query !== ALLWISE_QUERY || manifest.nativeCoordinateFrame !== "FK5(J2000)"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== true
      || scope?.table !== "allwise_p3am_cdd" || scope?.dataset !== "AllWISE Image Atlas"
      || scope?.expectedRowCount !== ALLWISE_ROW_COUNT || scope?.expectedCoaddCount !== ALLWISE_COADD_COUNT
      || scope?.coaddIdSetsEqual !== true || scope?.validPixelMasksChecked !== false
      || JSON.stringify(scope?.bands) !== JSON.stringify(["W3", "W4"])
      || !scope?.bandCounts || Object.entries(ALLWISE_BAND_COUNTS).some(([band, count]) => scope.bandCounts[band] !== count)
      || manifest.rowCount !== ALLWISE_ROW_COUNT || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 1000
      || pagination?.expectedRowCount !== ALLWISE_ROW_COUNT || pagination?.expectedCoaddCount !== ALLWISE_COADD_COUNT
      || pagination?.denominator?.status !== 200 || pagination?.denominator?.queryStatus !== "OK" || pagination?.denominator?.rowCount !== ALLWISE_ROW_COUNT
      || pagination?.denominatorAfter?.status !== 200 || pagination?.denominatorAfter?.queryStatus !== "OK" || pagination?.denominatorAfter?.rowCount !== ALLWISE_ROW_COUNT
      || pagination?.bandCounts?.status !== 200 || pagination?.bandCounts?.queryStatus !== "OK"
      || pagination?.bandCountsAfter?.status !== 200 || pagination?.bandCountsAfter?.queryStatus !== "OK"
      || pagination?.denominatorsStable !== true
      || !pagination?.w3DistinctCoadds || pagination.w3DistinctCoadds.status !== 200 || pagination.w3DistinctCoadds.queryStatus !== "OK" || pagination.w3DistinctCoadds.count !== ALLWISE_COADD_COUNT
      || !pagination?.w4DistinctCoadds || pagination.w4DistinctCoadds.status !== 200 || pagination.w4DistinctCoadds.queryStatus !== "OK" || pagination.w4DistinctCoadds.count !== ALLWISE_COADD_COUNT
      || !pagination?.w3DistinctCoaddsAfter || pagination.w3DistinctCoaddsAfter.status !== 200 || pagination.w3DistinctCoaddsAfter.queryStatus !== "OK" || pagination.w3DistinctCoaddsAfter.count !== ALLWISE_COADD_COUNT
      || !pagination?.w4DistinctCoaddsAfter || pagination.w4DistinctCoaddsAfter.status !== 200 || pagination.w4DistinctCoaddsAfter.queryStatus !== "OK" || pagination.w4DistinctCoaddsAfter.count !== ALLWISE_COADD_COUNT
      || pagination?.coaddIdSetsEqual !== true || !Array.isArray(pages) || pages.length !== 37 || pageRows !== ALLWISE_ROW_COUNT
      || !pages.every((page: Document, index: number) => {
        const ref = `metadata/tap-page-${String(index + 1).padStart(3, "0")}.vot`;
        const document = documents.get(ref) as Document | undefined;
        const expectedQuery = index === 0 ? ALLWISE_QUERY
          : `${queryBeforeOrder} AND (coadd_id > '${pages[index - 1].lastCoaddId}' OR (coadd_id = '${pages[index - 1].lastCoaddId}' AND band > ${pages[index - 1].lastBand})) ORDER BY coadd_id, band`;
        return page.status === 200 && page.queryStatus === "OK" && page.overflow === false
          && page.rows === (index === 36 ? 480 : 1000) && page.query === expectedQuery
          && typeof page.firstCoaddId === "string" && typeof page.lastCoaddId === "string"
          && [3, 4].includes(page.firstBand) && [3, 4].includes(page.lastBand)
          && (index === 0 || pages[index - 1].lastCoaddId < page.firstCoaddId
            || pages[index - 1].lastCoaddId === page.firstCoaddId && pages[index - 1].lastBand < page.firstBand)
          && document?.sha256 === page.sha256 && document?.sizeBytes === page.sizeBytes;
      })
      || !["metadata/table-schema.vot", "metadata/denominator-before.vot", "metadata/band-counts-before.vot", "metadata/w3-distinct-before.vot", "metadata/w4-distinct-before.vot",
        "metadata/denominator-after.vot", "metadata/band-counts-after.vot", "metadata/w3-distinct-after.vot", "metadata/w4-distinct-after.vot"]
        .every(ref => documents.has(ref))
      || !(manifest.rowFiles ?? []).some(rowFile => rowFile.ref === "normalized/native-rows.ndjson.gz" && rowFile.rows === ALLWISE_ROW_COUNT)) {
      throw new Error("AllWISE input must retain every ordered W3/W4 TAP page, the complete 18,240-Tile-per-band denominators and matching source-table evidence");
    }
  }
  if (source.adapter === "cadc-caom-cfhtls") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const page = Array.isArray(pages) ? pages[0] : undefined;
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    const sameCounts = (value: Document | undefined) => !!value && Object.entries(CFHTLS_FILTER_COUNTS).every(([filter, count]) => value[filter] === count)
      && Object.keys(value).length === Object.keys(CFHTLS_FILTER_COUNTS).length;
    if (manifest.deliveryClass !== "evidence" || source.id !== CFHTLS_SOURCE_ID || source.surveyId !== "cfhtls" || source.releaseId !== "cfhtls-wide"
      || source.query !== CFHTLS_QUERY || manifest.nativeCoordinateFrame !== "ICRS"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== true
      || scope?.collection !== "CFHTTERAPIX" || scope?.provenanceVersion !== "T0007" || scope?.singleBandMedianImagesOnly !== true
      || scope?.fullArchiveInventory !== false || scope?.expectedRowCount !== CFHTLS_ROW_COUNT || scope?.expectedFieldCount !== CFHTLS_FIELD_COUNT
      || scope?.excludedRgbCount !== 110 || !scope?.bandCounts || Object.entries(CFHTLS_BAND_COUNTS).some(([band, count]) => scope.bandCounts[band] !== count)
      || !sameCounts(scope?.filterCounts) || manifest.rowCount !== CFHTLS_ROW_COUNT
      || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 1000 || pagination?.expectedRowCount !== CFHTLS_ROW_COUNT
      || pagination?.denominatorsStable !== true
      || pagination?.denominatorBefore?.status !== 200 || pagination.denominatorBefore.queryStatus !== "OK"
      || pagination.denominatorBefore.rowCount !== CFHTLS_ROW_COUNT || pagination.denominatorBefore.fieldCount !== CFHTLS_FIELD_COUNT
      || pagination?.denominatorAfter?.status !== 200 || pagination.denominatorAfter.queryStatus !== "OK"
      || pagination.denominatorAfter.rowCount !== CFHTLS_ROW_COUNT || pagination.denominatorAfter.fieldCount !== CFHTLS_FIELD_COUNT
      || pagination?.filterCountsBefore?.status !== 200 || pagination.filterCountsBefore.queryStatus !== "OK" || !sameCounts(pagination.filterCountsBefore.counts)
      || pagination?.filterCountsAfter?.status !== 200 || pagination.filterCountsAfter.queryStatus !== "OK" || !sameCounts(pagination.filterCountsAfter.counts)
      || !Array.isArray(pages) || pages.length !== 1 || page?.page !== 1 || page.query !== CFHTLS_QUERY
      || page.status !== 200 || page.queryStatus !== "OK" || page.overflow !== false || page.rows !== CFHTLS_ROW_COUNT
      || documents.get("metadata/tap-page-001.vot")?.sha256 !== page.sha256
      || documents.get("metadata/tap-page-001.vot")?.sizeBytes !== page.sizeBytes
      || !["metadata/table-schema.vot", "metadata/count-before.vot", "metadata/filter-counts-before.vot", "metadata/count-after.vot", "metadata/filter-counts-after.vot"]
        .every(ref => documents.has(ref))
      || !(manifest.rowFiles ?? []).some(rowFile => rowFile.ref === "normalized/native-rows.ndjson.gz" && rowFile.rows === CFHTLS_ROW_COUNT)) {
      throw new Error("CFHTLS import must retain the complete 855-file T0007 single-band roster, its 171-field band counts, and raw CAOM TAP evidence");
    }
  }
  if (source.adapter === "noirlab-des-tap") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const expectedRows = Number(scope?.expectedRowCount);
    const expectedTiles = Number(scope?.expectedTileCount);
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    const expectedBands = ["g", "r", "i", "z", "Y"];
    if (source.id !== DES_SOURCE_ID || source.surveyId !== "des" || source.releaseId !== "des-dr2"
      || source.query !== DES_QUERY || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== true
      || scope?.table !== "ivoa_des_dr2.siav1" || scope?.collection !== "des_dr2"
      || JSON.stringify(scope?.filters) !== JSON.stringify(expectedBands) || scope?.hdu !== 1
      || scope?.normalCoaddsOnly !== true || scope?.cutoutParametersIncluded !== false
      || !Number.isSafeInteger(expectedRows) || expectedRows !== manifest.rowCount
      || !Number.isSafeInteger(expectedTiles) || expectedTiles < 1 || expectedRows !== expectedTiles * expectedBands.length
      || !scope?.bandCounts || Object.keys(scope.bandCounts).length !== expectedBands.length
      || expectedBands.some(band => scope.bandCounts[band] !== expectedTiles)
      || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 5000
      || pagination?.expectedRowCount !== expectedRows || pagination?.expectedTileCount !== expectedTiles
      || pagination?.denominator?.status !== 200 || pagination?.denominator?.queryStatus !== "OK"
      || pagination?.denominator?.tileCount !== expectedTiles || pagination?.denominator?.uniqueTileCount !== expectedTiles
      || pagination?.bandCounts?.status !== 200 || pagination?.bandCounts?.queryStatus !== "OK"
      || pagination?.bandCounts?.perBandCount !== expectedTiles
      || !Array.isArray(pages) || !pages.length || pageRows !== expectedRows
      || !pages.every((page: Document) => page.status === 200 && page.queryStatus === "OK" && Number.isSafeInteger(page.rows) && page.rows > 0 && page.rows <= 5000)
      || pages.at(-1)?.rows >= 5000 || pages.slice(0, -1).some((page: Document) => page.rows !== 5000)) {
      throw new Error("DES DR2 input must retain every ordered normal g/r/i/z/Y coadd page and matching Tile/band denominators");
    }
  }
  if (source.adapter === "noirlab-decaps-tap") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const pages = pagination?.pages;
    const expectedPageCount = Math.ceil(DECAPS_ROW_COUNT / 5000);
    const pageRows = Array.isArray(pages) ? pages.reduce((sum: number, page: Document) => sum + Number(page.rows), 0) : 0;
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    const filterCountsMatch = (value: Document | undefined) => !!value
      && Object.entries(DECAPS_FILTER_COUNTS).every(([filter, count]) => value[filter] === count)
      && Object.keys(value).length === Object.keys(DECAPS_FILTER_COUNTS).length;
    const queryBeforeOrder = DECAPS_QUERY.slice(0, DECAPS_QUERY.indexOf(" ORDER BY obs_pub_did"));
    const pagedQuery = queryBeforeOrder.replace(/^SELECT /, "SELECT TOP 5000 ");
    if (manifest.deliveryClass !== "evidence" || source.id !== DECAPS_SOURCE_ID || source.surveyId !== "decaps" || source.releaseId !== "decaps-dr2"
      || source.query !== DECAPS_QUERY || manifest.nativeCoordinateFrame !== "ICRS"
      || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== true
      || scope?.table !== "ivoa_decaps_dr2.siav1" || scope?.collection !== "DECaPS DR2"
      || JSON.stringify(scope?.filters) !== JSON.stringify(["g", "i", "r", "Y", "z"])
      || scope?.completeTableInventory !== true || scope?.expectedRowCount !== DECAPS_ROW_COUNT || scope?.expectedCcdCount !== DECAPS_ROW_COUNT
      || scope?.individualFileAvailabilityVerified !== false || !scope?.bandCounts || !filterCountsMatch(scope.bandCounts)
      || manifest.rowCount !== DECAPS_ROW_COUNT || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 5000
      || pagination?.expectedRowCount !== DECAPS_ROW_COUNT || pagination?.expectedCcdCount !== DECAPS_ROW_COUNT
      || pagination?.denominatorsStable !== true
      || pagination?.denominatorBefore?.status !== 200 || pagination.denominatorBefore.queryStatus !== "OK" || pagination.denominatorBefore.rowCount !== DECAPS_ROW_COUNT
      || pagination?.denominatorAfter?.status !== 200 || pagination.denominatorAfter.queryStatus !== "OK" || pagination.denominatorAfter.rowCount !== DECAPS_ROW_COUNT
      || pagination?.filterCountsBefore?.status !== 200 || pagination.filterCountsBefore.queryStatus !== "OK" || !filterCountsMatch(pagination.filterCountsBefore.counts)
      || pagination?.filterCountsAfter?.status !== 200 || pagination.filterCountsAfter.queryStatus !== "OK" || !filterCountsMatch(pagination.filterCountsAfter.counts)
      || !Array.isArray(pages) || pages.length !== expectedPageCount || pageRows !== DECAPS_ROW_COUNT
      || !pages.every((page: Document, index: number) => {
        const reference = `metadata/tap-page-${String(index + 1).padStart(4, "0")}.votable.xml`;
        const document = documents.get(reference) as Document | undefined;
        const expectedQuery = `${pagedQuery}${index === 0 ? "" : ` AND obs_pub_did > '${pages[index - 1].lastPublisherDid}'`} ORDER BY obs_pub_did`;
        return page.page === index + 1 && page.status === 200 && page.queryStatus === "OK"
          && page.query === expectedQuery && page.rows === (index === expectedPageCount - 1 ? DECAPS_ROW_COUNT % 5000 : 5000)
          && typeof page.firstPublisherDid === "string" && typeof page.lastPublisherDid === "string"
          && page.firstPublisherDid <= page.lastPublisherDid
          && (index === 0 || pages[index - 1].lastPublisherDid < page.firstPublisherDid)
          && document?.sha256 === page.sha256 && document?.sizeBytes === page.sizeBytes;
      })
      || !["metadata/table-schema.votable.xml", "metadata/count-before.votable.xml", "metadata/filter-counts-before.votable.xml",
        "metadata/count-after.votable.xml", "metadata/filter-counts-after.votable.xml"].every(ref => documents.has(ref))
      || !(manifest.rowFiles ?? []).some(rowFile => rowFile.ref === "normalized/native-rows.ndjson.gz" && rowFile.rows === DECAPS_ROW_COUNT)) {
      throw new Error("DECaPS DR2 input must retain the complete ordered CCD roster, stable SIAv1 denominators and raw TAP evidence");
    }
  }
  if (source.adapter === "panstarrs-dr1-skycell") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    const grid = documents.get("metadata/ps1-grid.fits") as Document | undefined;
    const zone = documents.get("metadata/zone-23-grid.json") as Document | undefined;
    const receipts = documents.get("metadata/skycell-query-receipts.ndjson.gz") as Document | undefined;
    const header = documents.get("metadata/representative-header.json") as Document | undefined;
    const headerBytes = documents.get("metadata/representative-header.bin") as Document | undefined;
    const sourcePage = Array.isArray(pagination?.pages) && pagination.pages.length === 1 ? pagination.pages[0] : undefined;
    const rowFile = Array.isArray(manifest.rowFiles) && manifest.rowFiles.length === 1 ? manifest.rowFiles[0] : undefined;
    let gridDetails: Document | undefined;
    let headerDetails: Document | undefined;
    try {
      if (zone) gridDetails = JSON.parse(await readFile(nativeEvidencePath(root, path.posix.join(path.posix.dirname(ref), zone.ref)), "utf8")) as Document;
      if (header) headerDetails = JSON.parse(await readFile(nativeEvidencePath(root, path.posix.join(path.posix.dirname(ref), header.ref)), "utf8")) as Document;
    } catch { throw new Error("Pan-STARRS input is missing its parsed zone or representative-header receipt"); }
    const counts = scope?.bandCounts;
    const rowCountFromBands = counts && PANSTARRS_BANDS.every(band => Number.isSafeInteger(counts[band]))
      ? PANSTARRS_BANDS.reduce((sum, band) => sum + counts[band], 0) : -1;
    const closeTo = (value: unknown, expected: number) => typeof value === "number" && Math.abs(value - expected) < 1e-10;
    const validGrid = gridDetails?.zone === PANSTARRS_ZONE.zone && gridDetails?.projectionStart === PANSTARRS_ZONE.projectionStart
      && gridDetails?.projectionCount === PANSTARRS_ZONE.projectionCount && closeTo(gridDetails?.decCenter, PANSTARRS_ZONE.decCenter)
      && closeTo(gridDetails?.decMin, PANSTARRS_ZONE.decMin) && closeTo(gridDetails?.decMax, PANSTARRS_ZONE.decMax)
      && gridDetails?.xCell === PANSTARRS_ZONE.xCell && gridDetails?.yCell === PANSTARRS_ZONE.yCell
      && closeTo(gridDetails?.crpix1, PANSTARRS_ZONE.crpix1) && closeTo(gridDetails?.crpix2, PANSTARRS_ZONE.crpix2)
      && gridDetails?.gridSha256 === grid?.sha256;
    const rangeReceipts = headerDetails?.ranges;
    const sampleHeader = documents.get("metadata/representative-header.bin") as Document | undefined;
    const validHeader = headerDetails?.unitId === "1405.053" && headerDetails?.band === "g"
      && headerDetails?.status === 206 && headerDetails?.url === "https://ps1images.stsci.edu/rings.v3.skycell/1405/053/rings.v3.skycell.1405.053.stk.g.unconv.fits"
      && headerDetails?.headerBytes === 23_040 && headerDetails?.sha256 === sampleHeader?.sha256
      && Array.isArray(rangeReceipts) && rangeReceipts.length === 8
      && rangeReceipts.every((range: Document, index: number) => range.start === index * 2880
        && range.endInclusive === (index + 1) * 2880 - 1 && range.status === 206
        && range.contentRange === `bytes ${range.start}-${range.endInclusive}/${headerDetails?.fileSizeBytes}` && range.bytesRead === 2880);
    if (manifest.deliveryClass !== "evidence" || source.id !== PANSTARRS_SOURCE_ID || source.surveyId !== "panstarrs" || source.releaseId !== "panstarrs-dr1"
      || source.sourceUrl !== PANSTARRS_IMAGE_LIST_URL || source.query !== PANSTARRS_QUERY
      || manifest.nativeCoordinateFrame !== "FK5(J2000)" || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false
      || !Number.isSafeInteger(manifest.rowCount) || (manifest.rowCount ?? 0) < 1 || rowCountFromBands !== manifest.rowCount
      || scope?.zone !== PANSTARRS_ZONE.zone || scope?.projectionStart !== PANSTARRS_ZONE.projectionStart
      || scope?.projectionCount !== PANSTARRS_ZONE.projectionCount || scope?.expectedSkycellCount !== 9000
      || scope?.queriedSkycellCount !== 9000 || !Number.isSafeInteger(scope?.emptySkycellCount) || scope.emptySkycellCount < 0 || scope.emptySkycellCount > 9000
      || scope?.expectedImageCount !== manifest.rowCount || scope?.fullSurveyInventory !== false || scope?.badFlagAcceptedValue !== 0
      || scope?.geometryPrecision !== "estimated" || scope?.validPixelMasksChecked !== false || scope?.headerOnlyGeometryCheck !== true
      || !validGrid || !validHeader || grid?.url !== PANSTARRS_GRID_URL || grid?.sizeBytes !== 11_520
      || !receipts || !/^[a-f0-9]{64}$/.test(receipts.sha256 ?? "")
      || pagination?.queryPagesComplete !== true || pagination?.pageSize !== 1 || pagination?.expectedSkycellCount !== 9000
      || sourcePage?.status !== 200 || sourcePage?.rows !== 9000 || sourcePage?.receiptRef !== receipts.ref
      || sourcePage?.receiptSha256 !== receipts.sha256 || !rowFile || rowFile.ref !== "normalized/native-rows.ndjson.gz"
      || rowFile.rows !== manifest.rowCount || headerBytes?.sizeBytes !== 23_040) {
      throw new Error("Pan-STARRS DR1 input must retain the complete zone 23 skycell queries, official grid, header-only WCS check and bounded-scope declaration");
    }
  }
  if (source.adapter === "iphas-dr2-pipeline") {
    const raw = manifest.metadataDocuments.find((document: Document) => document.ref === "metadata/iphas-images-pipeline.fits");
    const rows = manifest.rowFiles?.find(rowFile => rowFile.ref === "normalized/native-rows.ndjson.gz");
    const scope = manifest.scope;
    if (manifest.deliveryClass !== "evidence" || source.id !== IPHAS_SOURCE_ID || source.surveyId !== "iphas" || source.releaseId !== "iphas-dr2"
      || source.sourceUrl !== IPHAS_SOURCE_URL || manifest.inventoryComplete !== false || manifest.queryPagesComplete !== true
      || manifest.nativeCoordinateFrame !== "ICRS" || manifest.rowCount !== IPHAS_EXPECTED_ROWS
      || raw?.sha256 !== "7cae94bb03e1fb3d43a9af49e164df88e8087d4c7fe6527e10fe066af825465d" || raw.sizeBytes !== 63_570_240
      || scope?.upstreamGitCommit !== "e2e47c6964df6bb5fe9909e317ef18f0913698db" || scope?.expectedRows !== IPHAS_EXPECTED_ROWS
      || scope?.expectedDr2RecalibrationRows !== IPHAS_EXPECTED_DR2_ROWS || scope?.expectedUniqueRunCcdBands !== IPHAS_EXPECTED_UNIQUE_ROWS
      || scope?.expectedDuplicateRunCcdBands !== IPHAS_EXPECTED_DUPLICATE_ROWS || scope?.finalQcReconciled !== false
      || scope?.geometrySource !== "pinned IPHAS DR2 author pipeline table, four CCD corners, ZPN frame"
      || rows?.rows !== IPHAS_EXPECTED_ROWS || rows.sha256 === raw.sha256) {
      throw new Error("IPHAS DR2 input must retain the pinned full author pipeline table, its partial recalibration scope and separate normalized metadata rows");
    }
  }
  if (source.adapter === "rubin-firstlook-avm") {
    const scope = manifest.scope;
    const capture = manifest.metadataDocuments.find((document: Document) => document.ref === RUBIN_CAPTURE_REF);
    const rowFile = manifest.rowFiles?.find(row => row.ref === "normalized/native-rows.ndjson.gz");
    const expectedXmp = Object.values(RUBIN_IMAGE_EVIDENCE);
    const xmpDocuments = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    if (manifest.deliveryClass !== "evidence" || source.id !== RUBIN_SOURCE_ID || source.surveyId !== "rubin" || source.releaseId !== "rubin-firstlook"
      || manifest.inventoryComplete !== false || manifest.queryPagesComplete !== true || manifest.rowCount !== expectedXmp.length
      || scope?.expectedImageCount !== expectedXmp.length || scope?.fullScientificInventory !== false
      || scope?.outreachImagesOnly !== true || scope?.geometryPrecision !== "estimated" || scope?.validPixelMasksChecked !== false
      || !capture || !expectedXmp.every(item => xmpDocuments.get(item.xmpRef)?.sha256 === item.xmpSha256)
      || rowFile?.rows !== expectedXmp.length) {
      throw new Error("Rubin First Look input must retain the exact two publisher XMP ranges and an explicit outreach-only scope");
    }
  }
  if (source.adapter === "act-dr5-whole-map") {
    const scope = manifest.scope;
    const pagination = manifest.sourcePagination;
    const maps = pagination?.maps;
    const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
    const headerDocuments = manifest.metadataDocuments.filter((document: Document) => String(document.ref).endsWith(".header"));
    const rosterPage = Array.isArray(pagination?.pages) && pagination.pages.length === 1 ? pagination.pages[0] : undefined;
    const validMapReceipts = Array.isArray(maps) && maps.length === ACT_MAPS.length && maps.every((item: Document) => {
      const match = /^act_dr5\.01_s08s18_AA_f(090|150|220)_(night|daynight)_map\.fits$/.exec(String(item.fileName ?? ""));
      const mapId = match ? `${match[1]}-${match[2]}` : "";
      const header = documents.get(`metadata/headers/${item.fileName}.header`) as Document | undefined;
      const expectedHeaderBytes = Number(item.headerBytes);
      const expectedBlockCount = expectedHeaderBytes / 2880;
      return !!match && item.mapId === mapId && ACT_MAPS.includes(mapId)
        && item.url === `${ACT_MAP_ROOT}${item.fileName}` && item.headStatus === 200
        && item.acceptRanges === "bytes" && Number.isSafeInteger(item.fileSizeBytes) && item.fileSizeBytes > expectedHeaderBytes
        && [2880, 5760].includes(expectedHeaderBytes) && header?.mapId === mapId
        && header?.url === item.url && header?.sha256 === item.headerSha256 && header?.sizeBytes === expectedHeaderBytes
        && Array.isArray(item.ranges) && item.ranges.length === expectedBlockCount
        && item.ranges.every((range: Document, index: number) => range.start === index * 2880
          && range.endInclusive === (index + 1) * 2880 - 1 && range.status === 206
          && range.contentRange === `bytes ${range.start}-${range.endInclusive}/${item.fileSizeBytes}`
          && range.bytesRead === 2880);
    });
    if (manifest.deliveryClass !== "evidence" || source.id !== ACT_SOURCE_ID || source.surveyId !== "act" || source.releaseId !== "act-dr5"
      || source.query !== ACT_QUERY || manifest.nativeCoordinateFrame !== "ICRS" || manifest.queryPagesComplete !== true
      || manifest.inventoryComplete !== false || manifest.rowCount !== ACT_MAPS.length
      || scope?.selector !== "normal ACT-only frequency/time-selection whole maps"
      || JSON.stringify(scope?.frequenciesGHz) !== JSON.stringify([90, 150, 220])
      || JSON.stringify(scope?.timeSelections) !== JSON.stringify(["night", "daynight"])
      || JSON.stringify(scope?.mapIds) !== JSON.stringify(ACT_MAPS) || scope?.fileRosterComplete !== true
      || scope?.fullSurveyInventory !== false || scope?.headerOnly !== true || scope?.validPixelMasksChecked !== false
      || JSON.stringify(scope?.expectedDimensions) !== JSON.stringify([43_200, 10_320, 3]) || scope?.geometryPrecision !== "estimated"
      || pagination?.queryPagesComplete !== true || pagination?.pageSize !== ACT_MAPS.length
      || pagination?.expectedRowCount !== ACT_MAPS.length || rosterPage?.page !== 1 || rosterPage?.status !== 200
      || rosterPage?.queryStatus !== "OK" || rosterPage?.query !== ACT_QUERY || rosterPage?.rows !== ACT_MAPS.length
      || JSON.stringify(rosterPage?.mapIds) !== JSON.stringify(ACT_MAPS)
      || rosterPage?.rosterSha256 !== documents.get("metadata/act-dr5-coadd-maps-wget.sh")?.sha256
      || documents.get("metadata/act-dr5-get.html")?.url !== source.sourceUrl
      || headerDocuments.length !== ACT_MAPS.length || !validMapReceipts
      || !Array.isArray(manifest.rowFiles) || manifest.rowFiles.length !== 1
      || manifest.rowFiles[0]?.ref !== "normalized/native-rows.ndjson.gz" || manifest.rowFiles[0]?.rows !== ACT_MAPS.length) {
      throw new Error("ACT DR5 input must retain the exact six-map normal ACT-only roster and header-only ICRS CAR evidence");
    }
  }
  if (source.adapter === "spherex-qr2-s3-observation") {
    const scope = manifest.scope;
    const pages = manifest.sourcePagination?.pages;
    const spec = SPHEREX_SOURCE_SPECS[source.id];
    const expectedRows = Number(scope?.expectedRowCount);
    const rowsByDetector = new Map<number, number>();
    for (const page of Array.isArray(pages) ? pages : []) {
      if (!Number.isSafeInteger(page.detector) || !spec?.detectors.includes(page.detector)
        || page.status !== 200 || !Number.isSafeInteger(page.rows) || page.rows < 0 || page.rows > 1000
        || typeof page.isTruncated !== "boolean") throw new Error("SPHEREx input has an invalid detector listing receipt");
      rowsByDetector.set(page.detector, (rowsByDetector.get(page.detector) ?? 0) + page.rows);
    }
    if (!spec || manifest.sourceId !== source.id || manifest.query !== spec.query
      || source.surveyId !== "spherex" || source.releaseId !== "spherex-qr2"
      || source.query !== spec.query || manifest.queryPagesComplete !== true || manifest.inventoryComplete !== false
      || scope?.observingRun !== "2025W17_4B" || scope?.processingVersion !== spec.processingVersion
      || scope?.observationSelector !== "2025W17_4B_0001_1" || scope?.observationId !== "2025W17_4B_0001_1"
      || JSON.stringify(scope?.detectors) !== JSON.stringify(spec.detectors)
      || scope?.fullObservationRoster !== true || scope?.fullReleaseInventory !== false || scope?.headerOnly !== true
      || scope?.validPixelMasksChecked !== false || !Number.isSafeInteger(expectedRows) || expectedRows !== spec.expectedRows
      || manifest.rowCount !== expectedRows || manifest.sourcePagination?.queryPagesComplete !== true
      || manifest.sourcePagination?.pageSize !== 1000 || manifest.sourcePagination?.expectedRowCount !== expectedRows
      || !Array.isArray(pages) || pages.length !== spec.detectors.length
      || [...rowsByDetector.keys()].sort((a, b) => a - b).join(",") !== [...spec.detectors].sort((a, b) => a - b).join(",")
      || [...rowsByDetector.values()].some(count => count !== 1)
      || !Array.isArray(manifest.metadataDocuments) || manifest.metadataDocuments.length !== expectedRows * 2
      || manifest.metadataDocuments.some((document: Document) => !/^[a-f0-9]{64}$/.test(document.sha256 ?? "")
        || !Number.isSafeInteger(document.sizeBytes) || document.sizeBytes < 1)) {
      throw new Error("SPHEREx input must retain the complete bounded five-detector QR2 observation roster and metadata-only FITS headers");
    }
  }
  const files = [{ ...file, sourceUrl: source.sourceUrl }];
  for (const dependency of [...manifest.metadataDocuments, ...(manifest.rowFiles ?? [])]) {
    // References are relative to the manifest, and may never escape its directory.
    nativeEvidencePath("/", dependency.ref);
    const depRef = path.posix.join(path.posix.dirname(ref), dependency.ref);
    files.push({ ...await nativeFile(root, depRef, dependency), sourceUrl: ("url" in dependency ? dependency.url : undefined) ?? dependency.sourceUrl ?? source.sourceUrl });
  }
  return { manifest, files };
}

async function* manifestRows(root: string, ref: string, manifest: SurveyManifest): AsyncGenerator<Document> {
  if (manifest.adapter === "gaia-healpix-range") { for (const row of manifest.files) yield row; return; }
  let total = 0;
  for (const file of manifest.rowFiles!) {
    const stream = createReadStream(nativeEvidencePath(root, path.posix.join(path.posix.dirname(ref), file.ref)));
    const decoded = file.ref.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
    const lines = createInterface({ input: decoded, crlfDelay: Infinity });
    let rows = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > 256 * 1024) throw new Error("Native metadata row exceeds its size budget");
        const row = JSON.parse(line) as Document;
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => /^(?:flux|wavelength|pixels|spectrum)$/i.test(key))) throw new Error("Only native-unit metadata rows can be imported");
        rows++; total++; yield row;
      }
    } finally { lines.close(); decoded.destroy(); stream.destroy(); }
    if (rows !== file.rows) throw new Error("Survey row file count differs from its locked manifest");
  }
  if (total !== manifest.rowCount) throw new Error("Survey total row count differs from its locked manifest");
}

interface ZtfPageMember { sourceRow: ZtfHpxFinderRow; pageResponseSha256: string }

async function validateZtfPageEvidence(root: string, manifestRef: string, manifest: SurveyManifest): Promise<Map<string, ZtfPageMember>> {
  const documents = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
  const researchDoc = documents.get("metadata/research-manifest.json") as Document | undefined;
  const evidenceDoc = documents.get("metadata/page-evidence.ndjson.gz") as Document | undefined;
  if (!researchDoc || !evidenceDoc || researchDoc.sha256 !== manifest.sourcePagination?.researchManifestSha256) throw new Error("ZTF import is missing its locked page and research evidence");
  const baseDir = path.posix.dirname(manifestRef);
  let research: Document;
  try { research = JSON.parse(await readFile(nativeEvidencePath(root, path.posix.join(baseDir, researchDoc.ref)), "utf8")) as Document; }
  catch { throw new Error("ZTF research capture manifest is invalid"); }
  if (research.captureComplete !== true || research.sourcePageCount !== 2304 || !Array.isArray(research.results) || research.results.length !== 2304
    || research.validation?.allPageReceiptsRevalidated !== true || research.validation?.sciencePixelBytesFetched !== 0) {
    throw new Error("ZTF capture is not the complete metadata-only CDS O3 key enumeration");
  }

  const members = new Map<string, ZtfPageMember>();
  const unique = new Map<string, { band: string; stc: string; ra: number; dec: number }>();
  const pageCounts = new Map(ZTF_BANDS.map(band => [band, { pages200: 0, pages404: 0, rows: 0, unique: new Set<string>() }]));
  const stream = createReadStream(nativeEvidencePath(root, path.posix.join(baseDir, evidenceDoc.ref))).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let pageIndex = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 2 * 1024 * 1024 || pageIndex >= research.results.length) throw new Error("ZTF page evidence exceeds its fixed response budget");
      const item = JSON.parse(line) as Document;
      const result = research.results[pageIndex] as Document;
      const band = ZTF_BANDS[Math.floor(pageIndex / 768)]!;
      const ipix = pageIndex % 768;
      const expectedUrl = `${ZTF_SOURCE_ROOT}CDS_P_ZTF_DR7_${band}/HpxFinder/Norder3/Dir0/Npix${ipix}`;
      const counts = pageCounts.get(band)!;
      if (item.band !== band || item.order !== 3 || item.ipix !== ipix || item.url !== expectedUrl || result.band !== band || result.order !== 3
        || result.ipix !== ipix || result.url !== expectedUrl || item.status !== result.status || item.sha256 !== result.sha256
        || item.bytes !== result.bytes || item.rowCount !== Number(result.rowCount ?? 0) || item.finalUrl !== expectedUrl || result.finalUrl !== expectedUrl) {
        throw new Error("ZTF page evidence order or receipt does not match the locked CDS NESTED O3 request");
      }
      if (item.status === 404) {
        if (item.bodyBase64 !== "" || item.bytes !== result.bytes || item.rowCount !== 0
          || Number(result.headers?.["Content-Length"]) !== item.bytes) throw new Error("ZTF 404 page evidence must retain its explicit status and body receipt without treating it as an image row");
        counts.pages404++;
      } else if (item.status === 200) {
        const bodyBase64 = String(item.bodyBase64 ?? "");
        const body = Buffer.from(bodyBase64, "base64");
        const hash = createHash("sha256").update(body).digest("hex");
        if (!body.length || body.toString("base64") !== bodyBase64 || body.length !== item.bytes || hash !== item.sha256
          || Number(result.headers?.["Content-Length"]) !== body.length) throw new Error("ZTF source page bytes differ from their locked receipt");
        const rows = parseZtfHpxFinderPage(body.toString("utf8"), band);
        if (rows.length !== item.rowCount) throw new Error("ZTF source page rows differ from their locked receipt");
        counts.pages200++; counts.rows += rows.length;
        for (const sourceRow of rows) {
          const memberId = `${band}/${ipix}/${sourceRow.name}`;
          if (members.has(memberId)) throw new Error("ZTF source page repeats a reference-image row within one O3 key");
          members.set(memberId, { sourceRow, pageResponseSha256: hash });
          const imageId = `${band}/${sourceRow.name}`;
          const prior = unique.get(imageId);
          if (prior && (prior.stc !== sourceRow.stc || prior.ra !== sourceRow.ra || prior.dec !== sourceRow.dec)) {
            throw new Error("ZTF progenitor pages disagree on a repeated reference-image footprint");
          }
          if (!prior) { unique.set(imageId, { band, stc: sourceRow.stc, ra: sourceRow.ra, dec: sourceRow.dec }); counts.unique.add(sourceRow.name); }
        }
      } else throw new Error("ZTF capture contains an unresolved HTTP outcome");
      pageIndex++;
    }
  } finally { lines.close(); stream.destroy(); }
  if (pageIndex !== 2304 || members.size !== ZTF_ROW_COUNT || unique.size !== 162333
    || ZTF_BANDS.some(band => {
      const counts = pageCounts.get(band)!;
      const uppercaseBand = ({ g: "G", r: "R", i: "I" } as Record<string, string>)[band]!;
      return counts.pages200 !== 768 - ZTF_PAGE_404_COUNTS[band]
        || counts.pages404 !== ZTF_PAGE_404_COUNTS[band] || counts.rows !== ZTF_PAGE_ROW_COUNTS[band]
        || counts.unique.size !== ZTF_FILE_COUNTS[uppercaseBand as keyof typeof ZTF_FILE_COUNTS];
    })) throw new Error("ZTF page evidence counts do not match the captured CDS DR7 O3 source inventory");
  return members;
}

export async function importSurveySnapshot(root: string, file: NativeFile, source: NativeSource): Promise<NativeSnapshot> {
  const { manifest, files } = await loadSurveyManifest(root, file.ref, source, file);
  const metadataByRef = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document.sha256]));
  const radioHeaderEvidence = new Map<string, Document>();
  const radioMapReceipts = new Map<string, Document>();
  if (source.adapter === "skyview-radio-maps") {
    for (const item of manifest.sourcePagination?.maps as Document[]) radioMapReceipts.set(item.unitId, item);
    const evidenceDocument = manifest.metadataDocuments.find(document => document.ref === SKYVIEW_RADIO_HEADER_REF);
    if (!evidenceDocument || evidenceDocument.sizeBytes > 64 * 1024 * 1024) throw new Error("SkyView radio import is missing its bounded per-map FITS header evidence");
    const evidencePath = nativeEvidencePath(root, path.posix.join(path.posix.dirname(file.ref), SKYVIEW_RADIO_HEADER_REF));
    const contents = gunzipSync(await readFile(evidencePath), { maxOutputLength: 128 * 1024 * 1024 }).toString("utf8");
    for (const line of contents.split(/\r?\n/)) {
      if (!line) continue;
      const item = JSON.parse(line) as Document;
      if (typeof item.unitId !== "string" || radioHeaderEvidence.has(item.unitId)
        || item.status !== "captured" && item.status !== "failed") throw new Error("SkyView radio header evidence contains an invalid or duplicate map result");
      if (item.status === "captured") {
        const header = Buffer.from(String(item.headerBase64 ?? ""), "base64");
        if (!header.length || header.toString("base64") !== item.headerBase64
          || createHash("sha256").update(header).digest("hex") !== item.headerSha256
          || item.headerBytes !== header.length || item.headerBytes % 2880 !== 0) throw new Error("SkyView radio FITS header evidence hash or padded size is invalid");
      } else if (typeof item.error !== "string" || !item.error) throw new Error("SkyView radio failed-header evidence has no reason");
      radioHeaderEvidence.set(item.unitId, item);
    }
    if (radioHeaderEvidence.size !== manifest.rowCount) throw new Error("SkyView radio header evidence does not retain every XML-listed map outcome");
  }
  const kidsDataLinkEvidence = new Map<string, { sha256: string; url: string }>();
  const kidsAstroWiseRoster = new Map<string, string>();
  const vphasDataLinkEvidence = new Map<string, { sha256: string; url: string }>();
  const vikingDataLinkEvidence = new Map<string, { sha256: string; url: string }>();
  const panstarrsListingEvidence = new Map<string, { fileName: string; responseSha256: string }>();
  const iphasUniqueRows = new Map<string, string>();
  let iphasDr2Rows = 0;
  let iphasDuplicateRows = 0;
  const rubinImages = new Map<string, Document>();
  const ztfPageMembers = source.adapter === "cds-ztf-progenitor-o3" ? await validateZtfPageEvidence(root, file.ref, manifest) : new Map<string, ZtfPageMember>();
  if (source.adapter === "rubin-firstlook-avm") {
    const captureDocument = manifest.metadataDocuments.find(document => document.ref === RUBIN_CAPTURE_REF);
    if (!captureDocument) throw new Error("Rubin First Look import is missing the publisher range-capture receipt");
    let capture: Document;
    try { capture = JSON.parse(await readFile(nativeEvidencePath(root, path.posix.join(path.posix.dirname(file.ref), captureDocument.ref)), "utf8")) as Document; }
    catch { throw new Error("Rubin First Look publisher range-capture receipt is invalid"); }
    if (capture.schemaVersion !== 1 || capture.pixelPayloadRead !== false || capture.images?.length !== Object.keys(RUBIN_IMAGE_EVIDENCE).length) {
      throw new Error("Rubin First Look capture must contain only the two bounded publisher metadata records");
    }
    for (const image of capture.images as Document[]) {
      const expected = RUBIN_IMAGE_EVIDENCE[String(image.imageId)];
      const xmpSha256 = metadataByRef.get(String(image.xmpRef));
      const rangeDocuments = new Map(manifest.metadataDocuments.map((document: Document) => [document.ref, document]));
      const rangesArchived = Array.isArray(image.ranges) && image.ranges.length === 5 && image.ranges.every((range: Document) => {
        const document = rangeDocuments.get(range.ref) as Document | undefined;
        return range.status === 206 && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.endInclusive)
          && range.endInclusive >= range.start && range.bytesRead === range.endInclusive - range.start + 1
          && range.contentRange === `bytes ${range.start}-${range.endInclusive}/${image.fileSizeBytes}`
          && document?.sha256 === range.sha256 && document?.sizeBytes === range.bytesRead;
      });
      if (!expected || rubinImages.has(String(image.imageId)) || image.fileName !== expected.fileName || image.imageUrl !== `https://storage.noirlab.edu/media/archives/images/original/${expected.fileName}`
        || image.fileSizeBytes !== expected.sizeBytes || image.headStatus !== 200 || image.xmpRef !== expected.xmpRef
        || image.xmpSha256 !== expected.xmpSha256 || xmpSha256 !== expected.xmpSha256 || image.width !== expected.dimensions[0]
        || image.height !== expected.dimensions[1] || image.coordinateFrame !== "ICRS" || image.equinox !== "J2000"
        || image.projection !== "TAN" || image.quality !== "Position" || typeof image.footprint !== "string"
        || !rangesArchived) {
        throw new Error("Rubin First Look capture does not match its pinned publisher image and AVM range evidence");
      }
      rubinImages.set(String(image.imageId), image);
    }
  }
  if (source.adapter === "eso-obscore-kids") {
    const evidence = manifest.metadataDocuments.find(document => document.ref === "metadata/datalinks.ndjson.gz");
    if (!evidence) throw new Error("KiDS import is missing its raw DataLink response bundle");
    const ref = path.posix.join(path.posix.dirname(file.ref), evidence.ref);
    const content = gunzipSync(await readFile(nativeEvidencePath(root, ref))).toString("utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      const item = JSON.parse(line) as Document;
      const body = Buffer.from(String(item.bodyBase64 ?? ""), "base64");
      const hash = createHash("sha256").update(body).digest("hex");
      if (body.length === 0 || body.toString("base64") !== item.bodyBase64 || item.status !== 200
        || !/^ADP\.[A-Za-z0-9.:-]+$/.test(String(item.dpId)) || kidsDataLinkEvidence.has(item.dpId)
        || hash !== item.responseSha256 || item.url !== `https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?${item.dpId}`) throw new Error("KiDS raw DataLink evidence is invalid or duplicated");
      kidsDataLinkEvidence.set(item.dpId, { sha256: hash, url: item.url });
    }
    if (kidsDataLinkEvidence.size !== 5388) throw new Error("KiDS raw DataLink bundle does not contain all 5,388 source responses");
    const roster = manifest.metadataDocuments.find(document => document.ref === "metadata/kids_dr5.0_sci_wget.sh");
    if (!roster) throw new Error("KiDS import is missing its official Astro-WISE file roster");
    const rosterPath = path.posix.join(path.posix.dirname(file.ref), roster.ref);
    const rosterText = await readFile(nativeEvidencePath(root, rosterPath), "utf8");
    const rosterCounts = { u: 0, g: 0, r: 0, i: 0, i2: 0 };
    for (const line of rosterText.split(/\r?\n/)) {
      if (!line) continue;
      const match = /^wget (http:\/\/ds\.astro\.rug\.astro-wise\.org:8000\/(KiDS_DR5\.0_[0-9.]+_-?[0-9.]+_(u|g|r|i|i2)_sci\.fits))$/.exec(line);
      if (!match || kidsAstroWiseRoster.has(match[2]!)) throw new Error("KiDS Astro-WISE roster contains an invalid or duplicate file URI");
      kidsAstroWiseRoster.set(match[2]!, match[1]!);
      rosterCounts[match[3] as keyof typeof rosterCounts]++;
    }
    if (kidsAstroWiseRoster.size !== 6735 || Object.values(rosterCounts).some(count => count !== 1347)) throw new Error("KiDS Astro-WISE roster does not match the official 6,735-file, five-epoch listing");
  }
  if (source.adapter === "eso-obscore-vphas") {
    const evidence = manifest.metadataDocuments.find(document => document.ref === "metadata/datalinks.ndjson.gz");
    if (!evidence) throw new Error("VPHAS+ import is missing the raw DataLink response bundle");
    const ref = path.posix.join(path.posix.dirname(file.ref), evidence.ref);
    const stream = createReadStream(nativeEvidencePath(root, ref)).pipe(createGunzip());
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > 2 * 1024 * 1024) throw new Error("VPHAS+ DataLink evidence row exceeds its size budget");
        const item = JSON.parse(line) as Document;
        const bodyBase64 = String(item.bodyBase64 ?? "");
        const body = Buffer.from(bodyBase64, "base64");
        const hash = createHash("sha256").update(body).digest("hex");
        const dpId = String(item.dpId ?? "");
        const expectedUrl = `https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?${dpId}`;
        if (!body.length || body.toString("base64") !== bodyBase64 || item.status !== 200
          || !/^ADP\.[A-Za-z0-9.:-]+$/.test(dpId) || vphasDataLinkEvidence.has(dpId)
          || hash !== item.responseSha256 || item.url !== expectedUrl) throw new Error("VPHAS+ raw DataLink evidence is invalid or duplicated");
        vphasDataLinkEvidence.set(dpId, { sha256: hash, url: item.url });
      }
    } finally { lines.close(); stream.destroy(); }
    if (vphasDataLinkEvidence.size !== 15534) throw new Error("VPHAS+ raw DataLink bundle does not contain all 15,534 source responses");
  }
  if (source.adapter === "eso-obscore-viking") {
    const evidence = manifest.metadataDocuments.find(document => document.ref === "metadata/datalinks.ndjson.gz");
    if (!evidence) throw new Error("VIKING import is missing its raw DataLink response bundle");
    const ref = path.posix.join(path.posix.dirname(file.ref), evidence.ref);
    const content = gunzipSync(await readFile(nativeEvidencePath(root, ref))).toString("utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      const item = JSON.parse(line) as Document;
      const body = Buffer.from(String(item.bodyBase64 ?? ""), "base64");
      const hash = createHash("sha256").update(body).digest("hex");
      const dpId = String(item.dpId ?? "");
      const expectedUrl = `https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?${dpId}`;
      if (!body.length || body.toString("base64") !== item.bodyBase64 || item.status !== 200
        || !/^ADP\.[A-Za-z0-9.:-]+$/.test(dpId) || vikingDataLinkEvidence.has(dpId)
        || hash !== item.responseSha256 || item.url !== expectedUrl) throw new Error("VIKING raw DataLink evidence is invalid or duplicated");
      vikingDataLinkEvidence.set(dpId, { sha256: hash, url: item.url });
    }
    if (vikingDataLinkEvidence.size !== 110) throw new Error("VIKING raw DataLink bundle does not contain all 110 source responses");
  }
  if (source.adapter === "panstarrs-dr1-skycell") {
    const evidence = manifest.metadataDocuments.find(document => document.ref === "metadata/skycell-query-receipts.ndjson.gz");
    if (!evidence) throw new Error("Pan-STARRS import is missing the per-skycell image-list evidence");
    const ref = path.posix.join(path.posix.dirname(file.ref), evidence.ref);
    const content = gunzipSync(await readFile(nativeEvidencePath(root, ref))).toString("utf8");
    const receiptLines = content.split(/\r?\n/).filter(Boolean);
    const expectedSkycells = Array.from({ length: 9000 }, (_, index) => {
      const projection = PANSTARRS_ZONE.projectionStart + Math.floor(index / 100);
      const subcell = index % 100;
      return `${projection}.${String(subcell).padStart(3, "0")}`;
    });
    const listingBands = new Map(PANSTARRS_BANDS.map(band => [band, 0]));
    if (receiptLines.length !== expectedSkycells.length) throw new Error("Pan-STARRS evidence does not query every zone 23 skycell");
    for (const [index, line] of receiptLines.entries()) {
      const item = JSON.parse(line) as Document;
      const bodyBase64 = String(item.bodyBase64 ?? "");
      const body = Buffer.from(bodyBase64, "base64");
      const hash = createHash("sha256").update(body).digest("hex");
      const skycell = expectedSkycells[index]!;
      const query = new URL(source.sourceUrl);
      query.searchParams.set("skycell", skycell);
      query.searchParams.set("type", "stack");
      if (!body.length || body.toString("base64") !== bodyBase64 || item.status !== 200
        || item.skycell !== skycell || item.url !== query.href || hash !== item.responseSha256) {
        throw new Error("Pan-STARRS per-skycell source response is invalid, out of order or does not match its locked query");
      }
      const responseRows = parsePanstarrsListing(body.toString("utf8"), skycell);
      if (item.rows !== responseRows.length) throw new Error("Pan-STARRS source response row count differs from its evidence receipt");
      for (const row of responseRows) {
        if (row.badFlag !== 0) continue;
        const key = `${skycell}/${row.band}`;
        if (panstarrsListingEvidence.has(key)) throw new Error("Pan-STARRS source query returned a duplicate skycell/band identity");
        panstarrsListingEvidence.set(key, { fileName: row.fileName, responseSha256: hash });
        listingBands.set(row.band, (listingBands.get(row.band) ?? 0) + 1);
      }
    }
    if (panstarrsListingEvidence.size !== manifest.rowCount
      || PANSTARRS_BANDS.some(band => listingBands.get(band) !== manifest.scope.bandCounts[band])) {
      throw new Error("Pan-STARRS source responses do not match their accepted stack-file rows and per-band counts");
    }
  }
  let rows = 0;
  const fdsFiles = new Set<string>();
  const fdsFields = new Set<string>();
  const fdsBands = new Map<string, number>();
  const kidsFiles = new Set<string>();
  const kidsTiles = new Set<string>();
  const kidsBands = new Map<string, number>();
  const kidsEpochs = new Map<string, number>();
  const allwisePairs = new Set<string>();
  const allwiseCoadds = { W3: new Set<string>(), W4: new Set<string>() };
  const cfhtlsFiles = new Set<string>();
  const cfhtlsFields = new Set<string>();
  const cfhtlsBands = new Map<string, number>();
  const cfhtlsFilters = new Map<string, number>();
  const vphasFiles = new Set<string>();
  const vphasFields = new Set<string>();
  const vphasBands = new Map<string, number>();
  const vikingFiles = new Set<string>();
  const vikingTiles = new Set<string>();
  const decapsCcds = new Set<string>();
  const decapsBands = new Map<string, number>();
  const actMaps = new Set<string>();
  const radioMaps = new Set<string>();
  let radioHeaderFailures = 0;
  let radioGeometryFailures = 0;
  let radioSpectralConflicts = 0;
  const akariRegions = new Set<string>();
  const akariFiles = new Set<string>();
  const akariRegionBands = new Set<string>();
  const akariBands = new Map<string, number>();
  const ztfRowsByBand = new Map<string, number>();
  const ztfImagesByBand = new Map<string, Set<string>>();
  for await (const row of manifestRows(root, file.ref, manifest)) {
    rows++;

    if (source.adapter === "skyview-radio-maps") {
      const spec = SKYVIEW_RADIO_SPECS[source.surveyId]!;
      const metadata = row.sourceMetadata as Document | undefined;
      const relativePath = String(metadata?.relativePath ?? "");
      const unitId = String(row.unitId ?? "");
      const receipt = radioMapReceipts.get(unitId);
      const evidence = radioHeaderEvidence.get(unitId);
      const fileName = relativePath.split("/").at(-1) ?? "";
      const uri = row.accessUris?.[0] ? publicUri(row.accessUris[0].uri ?? row.accessUris[0].url) : undefined;
      const expectedRegion = Array.isArray(metadata?.frameEdgeIcrs) && metadata.frameEdgeIcrs.length === 128
        ? `POLYGON ICRS ${metadata.frameEdgeIcrs.map((point: number[]) => `${Number(point[0]).toFixed(8)} ${Number(point[1]).toFixed(8)}`).join(" ")}`
        : "";
      const normalized = normalizedRow(row, source);
      if (!metadata || !receipt || !evidence || radioMaps.has(unitId) || unitId !== relativePath
        || !fileName || row.filename !== fileName || metadata.fileName !== fileName
        || metadata.headerStatus !== receipt.headerStatus || evidence.status !== receipt.headerStatus
        || metadata.geometryStatus !== receipt.geometryStatus
        || receipt.relativePath !== relativePath || receipt.url !== `${spec.mapRoot}${relativePath}`
        || metadata.mirrorCountry !== "US" || metadata.producerCountry !== spec.producerCountry
        || metadata.producer !== spec.producer || metadata.publisherBand !== spec.band
        || row.bands?.length !== 1 || row.bands[0] !== spec.band
        || row.accessUris?.length !== 1 || uri !== receipt.url
        || row.accessUris[0].sourceId !== "skyview-gsfc-us" || row.accessUris[0].countryCode !== "US"
        || metadata.headerEvidenceRef !== SKYVIEW_RADIO_HEADER_REF
        || metadata.headerSha256 !== receipt.headerSha256 || metadata.headerBytes !== receipt.headerBytes
        || evidence.headerSha256 !== receipt.headerSha256
        || receipt.headerStatus === "failed" && typeof metadata.failure !== "string"
        || receipt.headerStatus === "captured" && (!receipt.headerSha256 || !receipt.headerBytes)
        || receipt.geometryStatus === "mapped" && (!normalized || row.sRegion !== expectedRegion
          || metadata.geometrySource !== "actual FITS primary-header WCS pixel-edge samples transformed to ICRS"
          || metadata.coordinateFrame !== "ICRS" || metadata.nativeCoordinateFrame !== spec.nativeFrame
          || metadata.geometryPrecision !== "estimated" || metadata.validPixelMasksChecked !== false
          || metadata.frameEdgeIcrs.length !== 128)
        || receipt.geometryStatus !== "mapped" && (normalized || row.sRegion !== null || typeof metadata.failure !== "string")) {
        throw new Error("SkyView radio map row does not match its XML identity, source-listed URI and actual per-map header outcome");
      }
      if (source.surveyId === "wenss" && metadata.spectralMetadataConflict === true) radioSpectralConflicts++;
      radioMaps.add(unitId);
      if (receipt.headerStatus === "failed") radioHeaderFailures++;
      if (receipt.geometryStatus !== "mapped") radioGeometryFailures++;
    }
    if (source.adapter === "irsa-akari-fis-map") {
      const normalized = normalizedRow(row, source);
      const metadata = normalized?.sourceMetadata as Document | undefined;
      const band = String(normalized?.bands?.[0] ?? "").toUpperCase();
      if (!normalized || !metadata || akariFiles.has(String(metadata.fileName))) throw new Error("AKARI FIS input contains an invalid or duplicate direct science-map identity");
      akariFiles.add(String(metadata.fileName)); akariRegions.add(String(metadata.regionId));
      akariRegionBands.add(`${metadata.regionId}/${band}`); akariBands.set(band, (akariBands.get(band) ?? 0) + 1);
    }
    if (source.adapter === "cds-ztf-progenitor-o3") {
      const normalized = normalizedRow(row, source);
      const metadata = normalized?.sourceMetadata as Document | undefined;
      if (!normalized || !metadata) throw new Error("ZTF input contains an unsupported progenitor reference-image row");
      const memberId = `${metadata.pageBand}/${metadata.pageIpix}/${metadata.sourceName}`;
      const evidence = ztfPageMembers.get(memberId);
      if (!evidence || evidence.pageResponseSha256 !== metadata.pageResponseSha256
        || evidence.sourceRow.fileName !== normalized.filename || evidence.sourceRow.stc !== metadata.sourceStc
        || evidence.sourceRow.generatorPath !== metadata.generatorPath || evidence.sourceRow.field !== metadata.field
        || evidence.sourceRow.ccd !== metadata.ccd || evidence.sourceRow.quadrant !== metadata.quadrant
        || evidence.sourceRow.ra !== metadata.sourceCenterRa || evidence.sourceRow.dec !== metadata.sourceCenterDec) {
        throw new Error("ZTF normalized rows do not reproduce their locked HpxFinder source-page members");
      }
      const band = String(normalized.bands[0]).toUpperCase();
      ztfRowsByBand.set(band, (ztfRowsByBand.get(band) ?? 0) + 1);
      const images = ztfImagesByBand.get(band) ?? new Set<string>(); images.add(String(metadata.sourceName)); ztfImagesByBand.set(band, images);
    }
    if (source.adapter === "iphas-dr2-pipeline") {
      const normalized = normalizedRow(row, source);
      const recalibrated = row.sourceMetadata?.inDr2 === true;
      if (recalibrated) {
        if (!normalized) throw new Error("IPHAS DR2 recalibration member lacks a supported CCD image footprint");
        iphasDr2Rows++;
        const key = `${normalized.unitId}/${normalized.bands[0]}`;
        const hash = nativeDigest(normalized);
        const prior = iphasUniqueRows.get(key);
        if (prior && prior !== hash) throw new Error("IPHAS DR2 contains conflicting duplicate run/CCD/band metadata");
        if (prior) iphasDuplicateRows++;
        else iphasUniqueRows.set(key, hash);
      } else if (normalized || row.sourceMetadata?.inDr2 !== false) {
        throw new Error("IPHAS pipeline rows must carry a boolean in_dr2 membership flag");
      }
    }
    if (source.adapter === "rubin-firstlook-avm") {
      const normalized = normalizedRow(row, source);
      const metadata = normalized?.sourceMetadata as Document | undefined;
      const image = metadata ? rubinImages.get(String(metadata.imageId)) : undefined;
      const capturedAvm = image?.avm as Document | undefined;
      const normalizedAvm = metadata?.avm as Document | undefined;
      const avmMatches = !!capturedAvm && !!normalizedAvm
        && JSON.stringify(Object.entries(capturedAvm).sort()) === JSON.stringify(Object.entries(normalizedAvm).sort());
      if (!normalized || !image || rubinImages.has(`${String(metadata?.imageId)}:seen`)
        || row.sRegion !== image.footprint || metadata?.xmpRef !== image.xmpRef || metadata?.xmpSha256 !== image.xmpSha256
        || metadata?.fileSizeBytes !== image.fileSizeBytes || !avmMatches) {
        throw new Error("Rubin First Look normalized rows do not match the captured publisher IFD/XMP evidence");
      }
      rubinImages.set(`${String(metadata?.imageId)}:seen`, image);
    }
    if (source.adapter === "eso-obscore-fds") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("FDS DR1 contains a row without a supported field footprint");
      const metadata = normalized.sourceMetadata as Document;
      if (fdsFiles.has(String(metadata.dpId))) throw new Error("FDS DR1 contains a duplicate science-file identity");
      fdsFiles.add(String(metadata.dpId)); fdsFields.add(normalized.unitId);
      const band = String(normalized.bands[0]).toUpperCase();
      fdsBands.set(band, (fdsBands.get(band) ?? 0) + 1);
    }
    if (source.adapter === "eso-obscore-kids") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("KiDS DR5 contains an image without a supported Tile footprint");
      const metadata = normalized.sourceMetadata as Document;
      const dpId = String(metadata.dpId);
      const sourceResponse = kidsDataLinkEvidence.get(dpId);
      if (kidsFiles.has(dpId) || sourceResponse?.sha256 !== metadata.dataLinkResponseSha256 || sourceResponse?.url !== metadata.dataLinkUrl
        || kidsAstroWiseRoster.get(String(normalized.filename)) !== metadata.astroWiseUri) throw new Error("KiDS DR5 file or source-list evidence identity is duplicated or mismatched");
      kidsFiles.add(dpId); kidsTiles.add(normalized.unitId);
      const band = String(normalized.bands[0]).toUpperCase();
      const epoch = String(metadata.epoch);
      kidsBands.set(band, (kidsBands.get(band) ?? 0) + 1);
      kidsEpochs.set(epoch, (kidsEpochs.get(epoch) ?? 0) + 1);
    }
    if (source.adapter === "eso-obscore-vphas") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("VPHAS+ DR4 contains an image without a supported CCD union footprint");
      const metadata = normalized.sourceMetadata as Document;
      const dpId = String(metadata.dpId);
      const sourceLink = vphasDataLinkEvidence.get(dpId);
      if (vphasFiles.has(dpId) || !sourceLink || sourceLink.sha256 !== metadata.dataLinkResponseSha256
        || sourceLink.url !== metadata.dataLinkUrl) throw new Error("VPHAS+ image identity does not match its source-listed DataLink response");
      vphasFiles.add(dpId);
      vphasFields.add(String(metadata.targetName));
      const band = String(normalized.bands[0]);
      vphasBands.set(band, (vphasBands.get(band) ?? 0) + 1);
    }
    if (source.adapter === "eso-obscore-viking") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("VIKING DR1 contains an image without a supported Tile footprint");
      const metadata = normalized.sourceMetadata as Document;
      const dpId = String(metadata.dpId);
      const sourceLink = vikingDataLinkEvidence.get(dpId);
      if (vikingFiles.has(dpId) || !sourceLink || sourceLink.sha256 !== metadata.dataLinkResponseSha256
        || sourceLink.url !== metadata.dataLinkUrl) throw new Error("VIKING image identity does not match its source-listed DataLink response");
      vikingFiles.add(dpId);
      vikingTiles.add(normalized.unitId);
    }
    if (source.adapter === "allwise-ibe-atlas") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("AllWISE Atlas contains a row without a supported coadd footprint");
      const metadata = normalized.sourceMetadata as Document;
      const band = String(metadata.band);
      const pair = `${normalized.unitId}/${band}`;
      if (allwisePairs.has(pair)) throw new Error("AllWISE Atlas contains a duplicate coadd/band image identity");
      allwisePairs.add(pair);
      allwiseCoadds[band as "W3" | "W4"].add(normalized.unitId);
    }
    if (source.adapter === "cadc-caom-cfhtls") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("CFHTLS T0007 contains a row without a supported field footprint");
      const metadata = normalized.sourceMetadata as Document;
      const productId = String(metadata.productId);
      if (cfhtlsFiles.has(productId)) throw new Error("CFHTLS T0007 contains a duplicate single-band image product");
      cfhtlsFiles.add(productId);
      cfhtlsFields.add(normalized.unitId);
      const band = String(normalized.bands[0]);
      const filter = String(metadata.energyBandpassName);
      cfhtlsBands.set(band, (cfhtlsBands.get(band) ?? 0) + 1);
      cfhtlsFilters.set(filter, (cfhtlsFilters.get(filter) ?? 0) + 1);
    }
    if (source.adapter === "noirlab-decaps-tap") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("DECaPS DR2 contains a CCD row without a supported frame footprint");
      const metadata = normalized.sourceMetadata as Document;
      const publisherDid = String(metadata.publisherDid);
      if (decapsCcds.has(publisherDid)) throw new Error("DECaPS DR2 contains a duplicate CCD publisher identity");
      decapsCcds.add(publisherDid);
      const band = String(normalized.bands[0]);
      decapsBands.set(band, (decapsBands.get(band) ?? 0) + 1);
    }
    if (source.adapter === "act-dr5-whole-map") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("ACT DR5 contains a whole map without a supported header-derived frame");
      const metadata = normalized.sourceMetadata as Document;
      if (actMaps.has(String(metadata.mapId)) || metadataByRef.get(String(metadata.headerRef)) !== metadata.headerSha256) {
        throw new Error("ACT DR5 map identity or FITS header hash does not match its locked metadata evidence");
      }
      actMaps.add(String(metadata.mapId));
    }
    if (source.adapter === "panstarrs-dr1-skycell") {
      const normalized = normalizedRow(row, source);
      if (!normalized) throw new Error("Pan-STARRS DR1 contains a stack row without a supported skycell footprint");
      const metadata = normalized.sourceMetadata as Document;
      const band = String(normalized.bands[0]);
      const key = `${normalized.unitId}/${band}`;
      const sourceRow = panstarrsListingEvidence.get(key);
      const gridSha256 = metadataByRef.get("metadata/ps1-grid.fits");
      if (!sourceRow || !gridSha256 || !matchesPanstarrsListingEvidence(normalized, sourceRow, gridSha256)) {
        throw new Error("Pan-STARRS stack-file identity or URI does not match its exact skycell query response");
      }
      panstarrsListingEvidence.delete(key);
    }
    if (source.adapter === "spherex-qr2-s3-observation") {
      const metadata = row.sourceMetadata;
      if (!metadata || metadataByRef.get(metadata.wcsHeaderRef) !== metadata.wcsHeaderSha256) throw new Error("SPHEREx row WCS provenance does not match its locked header evidence");
    }
  }
  if (source.adapter === "iphas-dr2-pipeline" && (rows !== IPHAS_EXPECTED_ROWS || iphasDr2Rows !== IPHAS_EXPECTED_DR2_ROWS
    || iphasUniqueRows.size !== IPHAS_EXPECTED_UNIQUE_ROWS || iphasDuplicateRows !== IPHAS_EXPECTED_DUPLICATE_ROWS)) {
    throw new Error("IPHAS DR2 pipeline rows do not match the pinned table and recalibration/duplicate denominators");
  }
  if (source.adapter === "rubin-firstlook-avm" && (rows !== Object.keys(RUBIN_IMAGE_EVIDENCE).length
    || [...rubinImages.keys()].filter(key => key.endsWith(":seen")).length !== Object.keys(RUBIN_IMAGE_EVIDENCE).length)) {
    throw new Error("Rubin First Look input must contain each publisher original image exactly once");
  }
  if (source.adapter === "eso-obscore-fds" && (rows !== 97 || fdsFiles.size !== 97 || fdsFields.size !== 26
    || Object.entries(FDS_BAND_COUNTS).some(([band, count]) => fdsBands.get(band) !== count))) {
    throw new Error("FDS DR1 import rows do not match the official file, field and per-band denominators");
  }
  if (source.adapter === "eso-obscore-kids" && (rows !== 5388 || kidsFiles.size !== 5388 || kidsTiles.size !== 1347
    || Object.entries(KIDS_BAND_COUNTS).some(([band, count]) => kidsBands.get(band) !== count)
    || kidsEpochs.get("i") !== 1347 || kidsEpochs.get("i2") !== 1347)) {
    throw new Error("KiDS DR5 import rows do not match the official Tile, band and i-epoch denominators");
  }
  if (source.adapter === "eso-obscore-vphas" && (rows !== 15534 || vphasFiles.size !== 15534
    || vphasFields.size !== manifest.scope.expectedFieldCount
    || Object.entries(VPHAS_FILTER_COUNTS).some(([band, count]) => vphasBands.get(band) !== count))) {
    throw new Error("VPHAS+ DR4 import rows do not match the official file, field and per-filter denominators");
  }
  if (source.adapter === "eso-obscore-viking" && (rows !== 110 || vikingFiles.size !== 110 || vikingTiles.size !== 110)) {
    throw new Error("VIKING DR1 import rows do not match the 110 source-listed file and Tile identities");
  }
  if (source.adapter === "allwise-ibe-atlas" && (rows !== ALLWISE_ROW_COUNT || allwisePairs.size !== ALLWISE_ROW_COUNT
    || allwiseCoadds.W3.size !== ALLWISE_COADD_COUNT || allwiseCoadds.W4.size !== ALLWISE_COADD_COUNT
    || [...allwiseCoadds.W3].some(coaddId => !allwiseCoadds.W4.has(coaddId)))) {
    throw new Error("AllWISE W3/W4 input rows do not match the complete 18,240-coadd roster in both bands");
  }
  if (source.adapter === "cadc-caom-cfhtls" && (rows !== CFHTLS_ROW_COUNT || cfhtlsFiles.size !== CFHTLS_ROW_COUNT
    || cfhtlsFields.size !== CFHTLS_FIELD_COUNT
    || Object.entries(CFHTLS_BAND_COUNTS).some(([band, count]) => cfhtlsBands.get(band) !== count)
    || Object.entries(CFHTLS_FILTER_COUNTS).filter(([filter]) => filter !== "gri" && filter !== "gry" && filter !== "ryg")
      .some(([filter, count]) => cfhtlsFilters.get(filter) !== count))) {
    throw new Error("CFHTLS T0007 input rows do not match the 855 single-band image, 171-field and passband denominators");
  }
  if (source.adapter === "noirlab-decaps-tap" && (rows !== DECAPS_ROW_COUNT || decapsCcds.size !== DECAPS_ROW_COUNT
    || Object.entries(DECAPS_BAND_COUNTS).some(([band, count]) => decapsBands.get(band) !== count))) {
    throw new Error("DECaPS DR2 input rows do not match the complete CCD and per-filter SIAv1 denominators");
  }
  if (source.adapter === "act-dr5-whole-map" && (rows !== ACT_MAPS.length || actMaps.size !== ACT_MAPS.length
    || ACT_MAPS.some(mapId => !actMaps.has(mapId)))) {
    throw new Error("ACT DR5 input rows do not match the six normal ACT-only frequency/time-selection maps");
  }
  if (source.adapter === "panstarrs-dr1-skycell" && (rows !== manifest.rowCount || panstarrsListingEvidence.size !== 0)) {
    throw new Error("Pan-STARRS DR1 normalized rows do not exactly match the locked zone 23 stack-file responses");
  }
  if (source.adapter === "irsa-akari-fis-map" && (rows !== AKARI_ROW_COUNT || akariFiles.size !== AKARI_ROW_COUNT
    || akariRegions.size !== AKARI_REGION_COUNT || akariRegionBands.size !== AKARI_ROW_COUNT
    || Object.entries(AKARI_BAND_COUNTS).some(([band, count]) => akariBands.get(band) !== count))) {
    throw new Error("AKARI FIS image rows do not match all four 1,672-region source rosters");
  }
  if (source.adapter === "cds-ztf-progenitor-o3" && (rows !== ZTF_ROW_COUNT || ztfPageMembers.size !== ZTF_ROW_COUNT
    || Object.entries(ZTF_PAGE_ROW_COUNTS).some(([band, count]) => ztfRowsByBand.get(band.toUpperCase()) !== count)
    || Object.entries(ZTF_FILE_COUNTS).some(([band, count]) => ztfImagesByBand.get(band)?.size !== count))) {
    throw new Error("ZTF normalized reference images do not match the complete CDS O3 progenitor rows and file counts");
  }
  if (source.adapter === "skyview-radio-maps") {
    const spec = SKYVIEW_RADIO_SPECS[source.surveyId]!;
    if (rows !== spec.expectedRows || radioMaps.size !== spec.expectedRows
      || radioHeaderEvidence.size !== spec.expectedRows
      || manifest.sourcePagination?.headerFailureCount !== radioHeaderFailures
      || manifest.sourcePagination?.geometryFailureCount !== radioGeometryFailures
      || source.surveyId === "wenss" && manifest.scope?.spectralConflictCount !== radioSpectralConflicts) {
      throw new Error("SkyView radio normalized rows do not match the complete explicit XML roster and retained per-map header results");
    }
  }
  return { id: nativeDigest({ sourceId: source.id, sourceRevision: source.revision, sha256: files[0]!.sha256 }), sourceId: source.id, sourceRevision: source.revision,
    capturedAt: manifest.capturedAt, sourceUrl: source.sourceUrl, scope: source.scope, files, rowCount: rows };
}

function publicUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

function iphasImageUri(value: unknown, expected: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "www.iphas.org" && !url.username && !url.password
      && !url.search && !url.hash && url.href === expected ? url.href : undefined;
  } catch { return undefined; }
}

function publicKidsUri(value: unknown): string | undefined {
  const secure = publicUri(value);
  if (secure) return secure;
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && url.hostname === "ds.astro.rug.astro-wise.org" && url.port === "8000"
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/KiDS_DR5\.0_[0-9.]+_-?[0-9.]+_(?:u|g|r|i|i2)_sci\.fits$/.test(url.pathname)) return url.href;
  } catch { return undefined; }
  return undefined;
}

function rawQueryValues(url: URL, name: string): string[] {
  const values: string[] = [];
  for (const part of url.search.slice(1).split("&")) {
    const separator = part.indexOf("=");
    try {
      const key = decodeURIComponent(separator < 0 ? part : part.slice(0, separator));
      if (key === name) values.push(decodeURIComponent(separator < 0 ? "" : part.slice(separator + 1)));
    } catch { return []; }
  }
  return values;
}

export function normalizedRow(row: Document, source: NativeSource): Document | undefined {
  const unitId = String(row.unitId ?? "");
  if (!unitId || unitId.length > 160 || /[\x00-\x1f]/.test(unitId)) throw new Error("Invalid native unit identity");
  if (source.adapter === "gaia-healpix-range") return row;
  if (source.adapter === "skyview-radio-maps") {
    const spec = SKYVIEW_RADIO_SPECS[source.surveyId];
    const metadata = row.sourceMetadata as Document | undefined;
    const relativePath = String(metadata?.relativePath ?? "");
    const fileName = relativePath.split("/").at(-1) ?? "";
    const validPath = source.surveyId === "nvss" ? /^I\d{4}[PM]\d{2}\.fits\.gz$/.test(relativePath)
      : source.surveyId === "sumss" ? /^(?:Galactic|Extragalactic)\/J\d{4}[PM]\d{2}\.FITS$/.test(relativePath)
      : source.surveyId === "wenss" ? /^(?:wn|wp)\d{5}h\.fits\.gz$/.test(relativePath)
      : false;
    if (metadata?.headerStatus === "failed" || metadata?.geometryStatus !== "mapped") return undefined;
    const framePoints = metadata?.frameEdgeIcrs;
    const validFrame = Array.isArray(framePoints) && framePoints.length === 128 && framePoints.every((point: unknown) => Array.isArray(point)
      && point.length === 2 && point.every((value: unknown) => Number.isFinite(value))
      && Number(point[0]) >= 0 && Number(point[0]) < 360 && Number(point[1]) >= -90 && Number(point[1]) <= 90);
    const expectedRegion = validFrame
      ? `POLYGON ICRS ${framePoints.map((point: number[]) => `${Number(point[0]).toFixed(8)} ${Number(point[1]).toFixed(8)}`).join(" ")}`
      : "";
    const rawFrequency = metadata?.rawFrequencyHz;
    const frequencyConflict = typeof rawFrequency === "number" && Number.isFinite(rawFrequency)
      && Math.abs(rawFrequency - 325_000_000) > 32_500_000;
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    if (!spec || !validPath || !fileName || unitId !== relativePath || row.filename !== fileName || metadata?.fileName !== fileName
      || source.id !== spec.sourceId || source.releaseId !== spec.releaseId || source.query === undefined
      || metadata?.relativePath !== relativePath || metadata?.headerStatus !== "captured"
      || !/^[a-f0-9]{64}$/.test(String(metadata?.headerSha256 ?? "")) || !Number.isSafeInteger(metadata?.headerBytes)
      || metadata.headerBytes < 2880 || metadata.headerBytes % 2880 !== 0 || metadata?.headerEvidenceRef !== SKYVIEW_RADIO_HEADER_REF
      || metadata?.coordinateFrame !== "ICRS" || metadata?.nativeCoordinateFrame !== spec.nativeFrame
      || metadata?.geometrySource !== "actual FITS primary-header WCS pixel-edge samples transformed to ICRS"
      || metadata?.geometryPrecision !== "estimated" || metadata?.validPixelMasksChecked !== false
      || metadata?.mirrorCountry !== "US" || metadata?.producerCountry !== spec.producerCountry || metadata?.producer !== spec.producer
      || metadata?.publisherBand !== spec.band || row.bands?.length !== 1 || row.bands[0] !== spec.band
      || !validFrame || metadata?.footprint !== expectedRegion || row.sRegion !== expectedRegion
      || source.surveyId === "wenss" && metadata?.spectralMetadataConflict !== frequencyConflict
      || source.surveyId !== "wenss" && metadata?.spectralMetadataConflict !== false
      || row.accessUris?.length !== 1 || access?.sourceId !== "skyview-gsfc-us" || access.countryCode !== "US"
      || access.fileName !== fileName || access.accessType !== "file" || !uri || uri !== `${spec.mapRoot}${relativePath}`) {
      throw new Error("SkyView radio row does not match its source-listed native image and actual FITS WCS evidence");
    }
  }
  if (source.adapter === "irsa-akari-fis-map") {
    const metadata = row.sourceMetadata as Document | undefined;
    const band = String(row.bands?.[0] ?? "").toUpperCase();
    const fileName = String(metadata?.fileName ?? "");
    const fileRef = String(metadata?.fileRef ?? "");
    const regionId = String(metadata?.regionId ?? "");
    const corners = metadata?.cornersIcrs;
    const validCorners = Array.isArray(corners) && corners.length === 4 && corners.every((point: unknown) => Array.isArray(point)
      && point.length === 2 && point.every((value: unknown) => Number.isFinite(value))
      && (point as number[])[0]! >= 0 && (point as number[])[0]! < 360 && (point as number[])[1]! >= -90 && (point as number[])[1]! <= 90);
    const expectedRegion = validCorners ? `POLYGON ICRS ${corners.map((point: number[]) => `${Number(point[0]).toFixed(10)} ${Number(point[1]).toFixed(10)}`).join(" ")}` : "";
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const expectedUri = `${AKARI_DATA_ROOT}${fileRef}`;
    const acceptedBands = ["N60", "WIDES", "WIDEL", "N160"];
    if (source.id !== AKARI_SOURCE_ID || source.surveyId !== "akari" || source.releaseId !== "akari-fis"
      || !acceptedBands.includes(band) || row.bands?.length !== 1 || !/^images\/(?:N60|WideS|WideL|N160)\/[^/]+_fixstripe\.fits$/.test(fileRef)
      || fileName !== fileRef.split("/").at(-1) || unitId !== fileRef || metadata?.regionId !== fileName.replace(/_(?:N60|WideS|WideL|N160)_fixstripe\.fits$/, "")
      || metadata?.bandName !== ({ N60: "N60", WIDES: "WideS", WIDEL: "WideL", N160: "N160" } as Record<string, string>)[band]
      || metadata?.fileType !== "science" || metadata?.datasetVersion !== "2.1" || metadata?.equinox !== 2000
      || metadata?.coordinateFrame !== "FK5(J2000)" || metadata?.geometrySource !== "IRSA akari.akari_images four J2000 image-frame corners transformed to ICRS"
      || metadata?.geometryPrecision !== "estimated" || metadata?.validPixelMasksChecked !== false
      || !Array.isArray(metadata?.sourceCornersJ2000) || metadata.sourceCornersJ2000.length !== 4
      || metadata.sourceCornersJ2000.some((point: unknown) => !Array.isArray(point) || point.length !== 2 || point.some((value: unknown) => !Number.isFinite(value)))
      || !validCorners || metadata?.footprint !== expectedRegion || row.sRegion !== expectedRegion
      || access?.sourceId !== "irsa-akari-fis" || access.fileName !== fileName || access.accessType !== "file" || String(access.band).toUpperCase() !== band
      || row.accessUris?.length !== 1 || !uri || uri !== expectedUri || !/^https:\/\/irsa\.ipac\.caltech\.edu\/data\/AKARI\/images\//.test(uri)) {
      throw new Error("AKARI FIS rows must retain a source-listed all-sky science-map FITS, its J2000-to-ICRS frame and direct IRSA file URI");
    }
  }
  if (source.adapter === "cds-ztf-progenitor-o3") {
    const metadata = row.sourceMetadata as Document | undefined;
    const name = String(metadata?.sourceName ?? "");
    const match = /^ztf_(\d{6})_z([gri])_c(0[1-9]|1[0-6])_q([1-4])_refimg$/.exec(name);
    const band = String(row.bands?.[0] ?? "").toUpperCase();
    const expectedBand = match ? ({ g: "G", r: "R", i: "I" } as Record<string, string>)[match[2]!] : undefined;
    const fileName = match ? `${name}.fits` : "";
    const pageBand = metadata?.pageBand;
    const pageIpix = metadata?.pageIpix;
    const pageUrl = typeof pageBand === "string" && ZTF_BANDS.some(band => band === pageBand)
      && typeof pageIpix === "number" && Number.isSafeInteger(pageIpix) && pageIpix >= 0 && pageIpix < 768
      ? `${ZTF_SOURCE_ROOT}CDS_P_ZTF_DR7_${pageBand}/HpxFinder/Norder3/Dir0/Npix${pageIpix}` : "";
    const coordinates = String(row.sRegion ?? "").replace(/^POLYGON ICRS\s+/i, "").trim().split(/\s+/).map(Number);
    const validPolygon = /^POLYGON ICRS\s/i.test(String(row.sRegion ?? "")) && coordinates.length === 8
      && coordinates.every((value, index) => Number.isFinite(value) && (index % 2 === 0 ? value >= 0 && value < 360 : value >= -90 && value <= 90));
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const expectedUri = fileName ? ztfReferenceImageUri(fileName) : "";
    if (source.id !== ZTF_SOURCE_ID || source.surveyId !== "ztf" || source.releaseId !== "ztf-dr7" || !match
      || unitId !== name || row.filename !== fileName || band !== expectedBand || row.bands?.length !== 1
      || metadata?.field !== match[1] || metadata?.filterCode !== `z${match[2]}` || metadata?.ccd !== Number(match[3]) || metadata?.quadrant !== Number(match[4])
      || metadata?.pageOrder !== 3 || metadata?.pageIpix !== pageIpix || metadata?.pageBand !== pageBand
      || metadata?.pageUrl !== pageUrl || !/^[a-f0-9]{64}$/.test(String(metadata?.pageResponseSha256 ?? ""))
      || typeof metadata?.generatorPath !== "string" || metadata.generatorPath.length > 1024
      || metadata?.nativeIdentityKind !== "reference-image CCD quadrant" || metadata?.coordinateFrame !== "FK5(J2000)"
      || !/^POLYGON J2000\s/i.test(String(metadata?.sourceStc ?? "")) || metadata?.geometrySource !== "CDS DR7 HpxFinder J2000 image frame transformed to ICRS"
      || metadata?.geometryPrecision !== "estimated" || metadata?.validPixelMasksChecked !== false
      || !Array.isArray(metadata?.cornersIcrs) || metadata.cornersIcrs.length !== 4
      || metadata.cornersIcrs.some((point: unknown) => !Array.isArray(point) || point.length !== 2 || point.some((value: unknown) => !Number.isFinite(value)))
      || !validPolygon || metadata?.footprint !== row.sRegion || access?.sourceId !== "irsa-ztf-reference-images"
      || access.fileName !== fileName || access.accessType !== "file" || String(access.band).toUpperCase() !== band
      || row.accessUris?.length !== 1 || !uri || uri !== expectedUri) {
      throw new Error("ZTF DR7 rows must retain one CDS O3 progenitor reference-image quadrant and its source-rule whole-file IRSA FITS URI");
    }
  }
  if (source.adapter === "sdss-field") {
    const metadata = row.sourceMetadata;
    if (!metadata || ![metadata.run, metadata.camcol, metadata.field].every(Number.isSafeInteger)
      || String(metadata.rerun) !== "301" || metadata.photoStatus !== 0 || metadata.run < 1 || metadata.camcol < 1 || metadata.camcol > 6 || metadata.field < 0
      || unitId !== `${metadata.run}/${metadata.rerun}/${metadata.camcol}/${metadata.field}`) throw new Error("SDSS fields require actual normal rerun-301 native identities");
  }
  if (source.adapter === "noirlab-decaps-tap") {
    const metadata = row.sourceMetadata;
    const band = String(row.bands?.[0] ?? "").toUpperCase();
    const fileName = String(metadata?.fileRef ?? "");
    const publisherDid = String(metadata?.publisherDid ?? "");
    const extension = metadata?.extension;
    const corners = metadata?.cornersIcrs;
    const validCorners = Array.isArray(corners) && corners.length === 4 && corners.every((point: unknown) => Array.isArray(point)
      && point.length === 2 && point.every((value: unknown) => Number.isFinite(value))
      && (point as number[])[0]! >= 0 && (point as number[])[0]! < 360 && (point as number[])[1]! >= -90 && (point as number[])[1]! <= 90);
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const parsed = uri ? new URL(uri) : undefined;
    const fileRefs = parsed ? rawQueryValues(parsed, "siaRef") : [];
    const extensionString = Number.isSafeInteger(extension) && extension >= 0 ? String(extension) : "";
    if (source.id !== DECAPS_SOURCE_ID || source.surveyId !== "decaps" || source.releaseId !== "decaps-dr2"
      || !/^c4d_[A-Za-z0-9_.-]+\.fits\.fz$/.test(fileName) || unitId !== `${fileName}#${extensionString}`
      || !["G", "I", "R", "Y", "Z"].includes(band) || !Array.isArray(row.bands) || row.bands.length !== 1
      || publisherDid !== `ivo://datalab.noirlab/decaps_dr2/${fileName}#${extensionString}`
      || metadata?.filter !== band || metadata?.coordinateFrame !== "ICRS" || metadata?.wcsProjection !== "TPV"
      || metadata?.observationId !== "decaps_dr2" || metadata?.geometrySource !== "NOIRLab ivoa_decaps_dr2.siav1 CCD ICRS corner columns"
      || metadata?.accessSemantics !== "source-listed full DECaPS CCD FITS extension; POS/SIZE cutout parameters absent"
      || !Number.isSafeInteger(metadata?.exposureNumber) || metadata.exposureNumber < 1
      || !Number.isFinite(metadata?.exposureSeconds) || metadata.exposureSeconds <= 0
      || !Array.isArray(metadata?.dimensions) || metadata.dimensions.length !== 2
      || !metadata.dimensions.every((value: unknown) => Number.isSafeInteger(value) && Number(value) > 0)
      || !validCorners || metadata?.footprint !== row.sRegion || !/^POLYGON ICRS\s/i.test(String(row.sRegion))
      || row.filename !== fileName || row.accessUris?.length !== 1 || access?.accessType !== "file"
      || access.fileName !== fileName || String(access.band).toUpperCase() !== band
      || !parsed || parsed.hostname !== "datalab.noirlab.edu" || parsed.pathname !== "/svc/cutout"
      || parsed.searchParams.get("col") !== "decaps_dr2" || fileRefs.length !== 1 || fileRefs[0] !== fileName
      || parsed.searchParams.get("extn") !== extensionString || [...parsed.searchParams.keys()].some(key => ["POS", "SIZE"].includes(key.toUpperCase()))) {
      throw new Error("DECaPS DR2 rows must retain their CCD extension, source-listed no-cutout URI and ICRS frame corners");
    }
  }
  const sRegion = row.sRegion;
  if (typeof sRegion !== "string" || sRegion.length > 131_072) return undefined;
  if (source.adapter === "iphas-dr2-pipeline") {
    const metadata = row.sourceMetadata as Document | undefined;
    const match = /^r(\d{6})-([1-4])\.fits\.fz$/i.exec(String(row.filename ?? ""));
    const run = metadata?.run;
    const ccd = metadata?.ccd;
    const band = String(metadata?.band ?? "").toUpperCase();
    const bounds = [metadata?.raMin, metadata?.raMax, metadata?.decMin, metadata?.decMax];
    const validBounds = bounds.every(Number.isFinite) && bounds[0]! >= 0 && bounds[0]! < 360
      && bounds[1]! > bounds[0]! && bounds[1]! - bounds[0]! < 5
      && bounds[2]! >= -90 && bounds[3]! <= 90 && bounds[3]! > bounds[2]!;
    const coordinates = sRegion.replace(/^POLYGON ICRS\s+/i, "").trim().split(/\s+/).map(Number);
    const expectedCorners = validBounds ? [[bounds[0]!, bounds[2]!], [bounds[1]!, bounds[2]!], [bounds[1]!, bounds[3]!], [bounds[0]!, bounds[3]!]] : [];
    const polygonMatches = /^POLYGON ICRS\s/i.test(sRegion) && coordinates.length === 8
      && coordinates.every(Number.isFinite) && expectedCorners.every(([ra, dec], index) =>
        Math.abs((((coordinates[index * 2]! - ra + 540) % 360) + 360) % 360 - 180) < 1e-7
        && Math.abs(coordinates[index * 2 + 1]! - dec) < 1e-7);
    const fileName = String(row.filename ?? "");
    const expectedUri = match ? `http://www.iphas.org/data/images/${fileName.slice(0, 4)}/${fileName}` : "";
    const access = row.accessUris?.[0];
    const uri = access ? iphasImageUri(access.uri ?? access.url, expectedUri) : undefined;
    if (source.id !== IPHAS_SOURCE_ID || source.surveyId !== "iphas" || source.releaseId !== "iphas-dr2"
      || !match || !Number.isSafeInteger(run) || Number(run) < 1 || Number(run) !== Number(match[1])
      || !Number.isSafeInteger(ccd) || Number(ccd) < 1 || Number(ccd) > 4 || Number(ccd) !== Number(match[2])
      || unitId !== `${run}/${ccd}` || !["true", "false"].includes(String(metadata?.inDr2)) && typeof metadata?.inDr2 !== "boolean"
      || !IPHAS_BANDS.includes(band) || row.bands?.length !== 1 || String(row.bands[0]).toUpperCase() !== band
      || !validBounds || !polygonMatches || row.sRegion !== metadata?.footprint
      || metadata?.coordinateFrame !== "ICRS" || metadata?.projection !== "ZPN"
      || metadata?.geometrySource !== "pinned IPHAS DR2 author pipeline table, four CCD corners, ZPN frame"
      || metadata?.sourceFilename !== fileName || !uri || uri !== expectedUri || row.accessUris?.length !== 1
      || access?.sourceId !== "iphas-publisher" || access.fileName !== fileName || access.accessType !== "file" || access.band !== band) {
      throw new Error("IPHAS DR2 rows must retain the pinned run/CCD, band, recalibration flag, author-derived ICRS bounds and source-rule image URI");
    }
    if (metadata?.inDr2 !== true && metadata?.inDr2 !== "true") return undefined;
  }
  if (source.adapter === "rubin-firstlook-avm") {
    const metadata = row.sourceMetadata as Document | undefined;
    const imageId = String(metadata?.imageId ?? "");
    const expected = RUBIN_IMAGE_EVIDENCE[imageId];
    const avm = metadata?.avm as Document | undefined;
    const sourceImageUrl = expected ? `https://storage.noirlab.edu/media/archives/images/original/${expected.fileName}` : "";
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const numericPair = (value: unknown, expectedValues: number[]) => Array.isArray(value) && value.length === expectedValues.length
      && value.every((item, index) => typeof item === "number" && Math.abs(item - expectedValues[index]!) < 1e-10);
    const expectedAvm = imageId === "noirlab2521a"
      ? { referenceValue: [186.368524202294, 6.930215747979968], referencePixel: [48971.5, 25768], scale: [-5.55399208524905e-5, 5.55399208524905e-5], rotation: 48.96 }
      : { referenceValue: [271.6317360235022, -23.762469026534358], referencePixel: [42000, 25750], scale: [-5.553994996501517e-5, 5.553994996501517e-5], rotation: -12 };
    if (source.id !== RUBIN_SOURCE_ID || source.surveyId !== "rubin" || source.releaseId !== "rubin-firstlook" || !expected
      || unitId !== imageId || row.filename !== expected.fileName || metadata?.fileSizeBytes !== expected.sizeBytes
      || metadata?.xmpRef !== expected.xmpRef || metadata?.xmpSha256 !== expected.xmpSha256 || metadata?.captureRef !== RUBIN_CAPTURE_REF
      || metadata?.coordinateFrame !== "ICRS" || metadata?.equinox !== "J2000" || metadata?.projection !== "TAN" || metadata?.quality !== "Position"
      || metadata?.geometrySource !== "NOIRLab publisher BigTIFF IFD and AVM XMP range; AVM Position quality"
      || !numericPair(avm?.referenceValue, expectedAvm.referenceValue) || !numericPair(avm?.referencePixel, expectedAvm.referencePixel)
      || !numericPair(avm?.scale, expectedAvm.scale) || typeof avm?.rotation !== "number" || Math.abs(avm.rotation - expectedAvm.rotation) > 1e-10
      || !numericPair(avm?.referenceDimension, expected.dimensions) || !uri || uri !== sourceImageUrl || row.accessUris?.length !== 1
      || access?.sourceId !== "noirlab-publisher" || access.fileName !== expected.fileName || access.accessType !== "file" || access.band !== "RGB"
      || row.bands?.length !== 1 || String(row.bands[0]).toUpperCase() !== "RGB" || metadata?.footprint !== sRegion) {
      throw new Error("Rubin First Look rows must match the two publisher TIFF identities, verified AVM metadata and exact whole-image URLs");
    }
  }
  if (source.adapter === "panstarrs-dr1-skycell") {
    const metadata = row.sourceMetadata;
    const band = String(row.bands?.[0] ?? "");
    const projectionId = metadata?.projectionId;
    const subcell = metadata?.subcell;
    const expectedUnitId = Number.isSafeInteger(projectionId) && Number.isSafeInteger(subcell)
      ? `${projectionId}.${String(subcell).padStart(3, "0")}` : "";
    const fileName = String(row.filename ?? "");
    const expectedSourceFilename = Number.isSafeInteger(projectionId) && Number.isSafeInteger(subcell)
      ? `/rings.v3.skycell/${projectionId}/${String(subcell).padStart(3, "0")}/${fileName}` : "";
    const fileMatch = /^rings\.v3\.skycell\.(\d{4})\.(\d{3})\.stk\.([grizy])\.unconv\.fits$/.exec(fileName);
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const expectedQuery = new URL(source.sourceUrl);
    expectedQuery.searchParams.set("skycell", expectedUnitId);
    expectedQuery.searchParams.set("type", "stack");
    const coordinates = sRegion.replace(/^POLYGON ICRS\s+/i, "").trim().split(/\s+/).map(Number);
    const validPolygon = /^POLYGON ICRS\s/i.test(sRegion) && coordinates.length >= 6 && coordinates.length % 2 === 0
      && coordinates.every((value, index) => Number.isFinite(value) && (index % 2 === 0 ? value >= 0 && value < 360 : value >= -90 && value <= 90));
    if (source.id !== PANSTARRS_SOURCE_ID || source.surveyId !== "panstarrs" || source.releaseId !== "panstarrs-dr1"
      || !Number.isSafeInteger(projectionId) || projectionId < PANSTARRS_ZONE.projectionStart
      || projectionId >= PANSTARRS_ZONE.projectionStart + PANSTARRS_ZONE.projectionCount
      || !Number.isSafeInteger(subcell) || subcell < 0 || subcell >= 100 || unitId !== expectedUnitId
      || !fileMatch || Number(fileMatch[1]) !== projectionId || Number(fileMatch[2]) !== subcell || fileMatch[3]!.toUpperCase() !== band
      || !PANSTARRS_BANDS.includes(band) || row.bands?.length !== 1 || metadata?.zone !== PANSTARRS_ZONE.zone
      || metadata?.filter !== band.toLowerCase() || metadata?.imageType !== "stack" || metadata?.badFlag !== 0
      || metadata?.coordinateFrame !== "FK5(J2000)" || metadata?.geometrySource !== "official PS1 zone 23 skycell WCS rule; representative FITS header checked"
      || !/^[a-f0-9]{64}$/.test(String(metadata?.gridSha256 ?? "")) || !/^[a-f0-9]{64}$/.test(String(metadata?.listingResponseSha256 ?? ""))
      || !Number.isFinite(metadata?.catalogRa) || metadata.catalogRa < 0 || metadata.catalogRa >= 360
      || !Number.isFinite(metadata?.catalogDec) || metadata.catalogDec < -90 || metadata.catalogDec > 90
      || !validPolygon || row.filename !== fileName || row.accessUris?.length !== 1 || access?.sourceId !== "ps1-stsci"
      || access.fileName !== fileName || access.accessType !== "file" || access.band !== band
      || metadata?.sourceFilename !== expectedSourceFilename
      || !uri || uri !== `${new URL(PANSTARRS_IMAGE_LIST_URL).origin}${expectedSourceFilename}`
      || typeof metadata?.queryUrl !== "string" || metadata.queryUrl !== expectedQuery.href) {
      throw new Error("Pan-STARRS DR1 rows must retain a source-listed stack skycell, exact file URI and official-grid ICRS frame geometry");
    }
  }
  if (source.adapter === "act-dr5-whole-map") {
    const metadata = row.sourceMetadata;
    const match = /^act_dr5\.01_s08s18_AA_f(090|150|220)_(night|daynight)_map\.fits$/.exec(unitId);
    const frequency = match ? Number(match[1]) : 0;
    const selection = match?.[2] ?? "";
    const expectedBand = `${frequency} GHZ`;
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const parsed = uri ? new URL(uri) : undefined;
    const rangeReceipts = metadata?.rangeReceipts;
    const validRanges = Array.isArray(rangeReceipts) && [2880, 5760].includes(metadata?.headerBytes)
      && rangeReceipts.length === Number(metadata?.headerBytes) / 2880
      && rangeReceipts.every((range: Document, index: number) => range.start === index * 2880
        && range.endInclusive === (index + 1) * 2880 - 1 && range.status === 206
        && range.contentRange === `bytes ${range.start}-${range.endInclusive}/${metadata?.fileSizeBytes}`
        && range.bytesRead === 2880);
    if (source.id !== ACT_SOURCE_ID || source.surveyId !== "act" || source.releaseId !== "act-dr5"
      || !match || !ACT_MAPS.includes(`${match[1]}-${selection}`) || unitId !== String(metadata?.fileName ?? "")
      || metadata?.mapId !== `${match[1]}-${selection}` || metadata?.frequencyGHz !== frequency || metadata?.timeSelection !== selection
      || !Array.isArray(row.bands) || row.bands.length !== 1 || row.bands[0] !== expectedBand
      || !Array.isArray(metadata?.dimensions) || JSON.stringify(metadata.dimensions) !== JSON.stringify([43_200, 10_320, 3])
      || metadata?.coordinateFrame !== "ICRS" || metadata?.projection !== "CAR"
      || metadata?.geometryPrecision !== "estimated"
      || metadata?.frameSemantics !== "whole-map image frame; ACT valid-pixel holes and masks are not checked"
      || metadata?.geometrySource !== "ACT DR5 FITS primary-header ICRS CAR WCS transformed along image-frame edges"
      || metadata?.accessSemantics !== "source-listed direct whole-map FITS file; no archive wrapper"
      || !Array.isArray(metadata?.declinationBoundsDeg) || metadata.declinationBoundsDeg.length !== 2
      || metadata.declinationBoundsDeg.some((value: unknown) => !Number.isFinite(value) || Number(value) < -90 || Number(value) > 90)
      || !/^[a-f0-9]{64}$/.test(String(metadata?.headerSha256 ?? ""))
      || metadata?.headerRef !== `metadata/headers/${unitId}.header`
      || metadata?.headStatus !== 200 || !Number.isSafeInteger(metadata?.fileSizeBytes)
      || metadata.fileSizeBytes <= metadata.headerBytes || !validRanges
      || !/^UNION ICRS \(POLYGON ICRS /.test(sRegion) || !sRegion.endsWith(")")
      || (sRegion.match(/POLYGON ICRS/g) ?? []).length !== 360
      || row.filename !== unitId || row.accessUris?.length !== 1 || access?.accessType !== "file"
      || access.fileName !== unitId || access.band !== expectedBand
      || !parsed || parsed.href !== `${ACT_MAP_ROOT}${unitId}` || parsed.pathname !== `/data/suborbital/ACT/ACT_dr5/maps/${unitId}`) {
      throw new Error("ACT DR5 rows must retain one of the six direct whole-map FITS identities and its header-derived estimated ICRS CAR frame");
    }
  }
  if (source.adapter === "cadc-caom-cfhtls") {
    const metadata = row.sourceMetadata;
    const positionBounds = String(metadata?.positionBounds ?? "").trim();
    const tokens = positionBounds.split(/\s+/);
    if (tokens.shift()?.toLowerCase() !== "polygon" || tokens.length < 6 || tokens.length % 2 !== 0) throw new Error("CFHTLS CAOM geometry must be a source polygon");
    const coordinates = tokens.map(Number);
    if (coordinates.some(value => !Number.isFinite(value)) || coordinates.some((value, index) => index % 2 === 0 ? value < 0 || value > 360 : value < -90 || value > 90)) {
      throw new Error("CFHTLS CAOM polygon contains invalid ICRS coordinates");
    }
    const expectedRegion = `POLYGON ICRS ${tokens.join(" ")}`;
    const observationId = String(metadata?.observationId ?? "");
    const productId = String(metadata?.productId ?? "");
    const artifactUri = String(metadata?.artifactUri ?? "");
    const artifactPath = /^cadc:CFHTTERAPIX\/(.+\.fits)$/.exec(artifactUri)?.[1];
    const fileName = artifactPath?.split("/").at(-1) ?? "";
    const expectedUri = artifactPath ? `${CFHTLS_DATA_ROOT}${artifactPath.split("/").map(encodeURIComponent).join("/")}` : "";
    const passband = String(metadata?.energyBandpassName ?? "");
    const band = CFHTLS_BAND_BY_FILTER[passband];
    const contentLength = metadata?.contentLength;
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    if (source.id !== CFHTLS_SOURCE_ID || source.surveyId !== "cfhtls" || source.releaseId !== "cfhtls-wide"
      || !/^CFHTLS_W_[A-Za-z0-9.+-]+$/.test(observationId) || unitId !== observationId
      || !/^CFHTLS_W_[A-Za-z0-9_.+-]+_T0007_MEDIAN$/.test(productId) || `${productId}.fits` !== fileName
      || metadata?.collection !== "CFHTTERAPIX" || metadata?.provenanceVersion !== "T0007"
      || !band || !Array.isArray(row.bands) || row.bands.length !== 1 || row.bands[0] !== band
      || metadata?.chunkCoordinateSystem !== "ICRS" || metadata?.positionEquinox !== 2000
      || !/^POLYGON ICRS\s/i.test(sRegion) || sRegion !== expectedRegion
      || !artifactPath || artifactPath.includes("..") || !/\.fits$/i.test(fileName)
      || metadata?.artifactProductType !== "science" || !/^application\/fits$/i.test(String(metadata?.contentType ?? ""))
      || !Number.isSafeInteger(contentLength) || contentLength < 1 || !/^md5:[0-9a-f]{32}$/i.test(String(metadata?.contentChecksum ?? ""))
      || metadata?.validPixelMasksChecked !== false || metadata?.geometrySource !== "caom2.Plane.position_bounds corroborated by joined caom2.Chunk.position_coordsys"
      || row.filename !== fileName || row.accessUris?.length !== 1 || !uri || uri !== expectedUri
      || access?.sourceId !== "cadc-cfht-terapix" || access.fileName !== fileName || access.accessType !== "file" || access.band !== band) {
      throw new Error("CFHTLS rows must retain one T0007 median file, its CAOM ICRS frame and its documented CADC whole-file URI");
    }
  }
  if (source.adapter === "eso-obscore-vvv") {
    const metadata = row.sourceMetadata;
    if (!metadata || metadata.targetName !== unitId || metadata.sourceTargetName === undefined
      || !/^ADP\.[A-Za-z0-9.:-]+$/.test(String(metadata.dpId))
      || metadata.nativeCoordinateFrame !== "J2000" || !/^POLYGON J2000\s/i.test(metadata.sourceSRegion ?? "")
      || !/^POLYGON ICRS\s/i.test(sRegion) || metadata.releaseDescription !== "https://www.eso.org/rm/api/v1/public/releaseDescriptions/80"
      || !["H", "J", "Y", "Z", "KS"].includes(String(metadata.filter).toUpperCase())
      || !Array.isArray(row.bands) || row.bands.length !== 1 || String(row.bands[0]).toUpperCase() !== String(metadata.filter).toUpperCase()
      || typeof metadata.dataLinkUrl !== "string" || !metadata.dataLinkUrl.startsWith("https://archive.eso.org/datalink/links?")) throw new Error("VVV row lacks its scoped Tile, source-frame, band or DataLink identity");
    const accessUris = row.accessUris ?? [];
    const nativeTileIdentity = /^[bd]\d{3}$/.test(unitId);
    if (metadata.nativeTileIdentity !== nativeTileIdentity) throw new Error("VVV source target classification differs from its native Tile identity");
    if (!nativeTileIdentity) {
      if (metadata.dataLinkListed || accessUris.length) throw new Error("VVV calibration/non-Tile targets cannot be bound as science Tiles");
      return undefined;
    }
    if (typeof metadata.dataLinkListed !== "boolean" || metadata.dataLinkListed !== (accessUris.length === 1)) throw new Error("VVV direct file URI must agree with the saved DataLink #this response");
    for (const access of accessUris) {
      const uri = publicUri(access.uri ?? access.url);
      const parsed = uri ? new URL(uri) : undefined;
      if (!parsed || parsed.hostname !== "dataportal.eso.org" || parsed.pathname !== `/dataPortal/file/${metadata.dpId}`
        || access.accessType !== "file" || access.band?.toUpperCase() !== String(metadata.filter).toUpperCase()
        || !/\.fits(?:\.(?:gz|bz2|fz))?$/i.test(String(access.fileName ?? ""))) throw new Error("VVV DataLink #this is not an ESO single-file identity");
    }
  }
  if (source.adapter === "eso-obscore-fds") {
    const metadata = row.sourceMetadata;
    const dpId = String(metadata?.dpId ?? "");
    const filter = String(metadata?.filter ?? "");
    const band = filter.slice(0, 1).toUpperCase();
    const filename = String(row.filename ?? "");
    const dataLinkUrl = publicUri(metadata?.dataLinkUrl);
    const dataLink = dataLinkUrl ? new URL(dataLinkUrl) : undefined;
    const access = row.accessUris?.[0];
    const directUri = access ? publicUri(access.uri ?? access.url) : undefined;
    const direct = directUri ? new URL(directUri) : undefined;
    const weightUri = publicUri(metadata?.ancillaryWeightMap?.uri);
    const weightUrl = weightUri ? new URL(weightUri) : undefined;
    const expectedPath = `/dataPortal/file/${dpId}`;
    if (source.id !== FDS_SOURCE_ID || source.surveyId !== "fds" || source.releaseId !== "fds-dr1"
      || !/^FDS_F\d{1,2}$/.test(unitId) || metadata?.targetName !== unitId
      || !/^ADP\.[A-Za-z0-9.:-]+$/.test(dpId) || metadata?.obsCollection !== "FDS"
      || metadata?.dataproductType !== "image" || metadata?.releaseDescription !== FDS_RELEASE_DESCRIPTION
      || metadata?.nativeCoordinateFrame !== "J2000" || !/^POLYGON J2000\s/i.test(metadata?.sourceSRegion ?? "")
      || !/^POLYGON ICRS\s/i.test(sRegion) || metadata?.dataLinkSemantics !== "#this"
      || metadata?.dataLinkCategory !== "SCIENCE.IMAGE" || metadata?.dataLinkListed !== true
      || metadata?.dataLinkFileName !== filename || metadata?.esoOriginalFile !== filename || !/[ugri]_SDSS_sci\.fits\.fz$/i.test(filename)
      || !filename.startsWith(`${unitId}_OCAM_${band.toLowerCase()}_`)
      || !["u_SDSS", "g_SDSS", "r_SDSS", "i_SDSS"].includes(filter)
      || !Array.isArray(row.bands) || row.bands.length !== 1 || String(row.bands[0]).toUpperCase() !== band
      || !dataLink || dataLink.hostname !== "archive.eso.org" || dataLink.pathname !== "/datalink/links"
      || dataLink.searchParams.get("ID") !== `ivo://eso.org/ID?${dpId}`
      || row.accessUris?.length !== 1 || access?.accessType !== "file" || access.fileName !== filename
      || String(access.band).toUpperCase() !== band || !direct || direct.hostname !== "dataportal.eso.org"
      || direct.pathname !== expectedPath || metadata?.dataLinkUri !== directUri
      || !/^[a-f0-9]{64}$/i.test(String(metadata?.dataLinkResponseSha256 ?? ""))
      || !/^POLYGON J2000\s/i.test(String(metadata?.sourceSRegion ?? ""))
      || !String(metadata?.geometryTransform ?? "").includes("FK5(equinox=J2000)")
      || !metadata?.ancillaryWeightMap || metadata.ancillaryWeightMap.semantics !== "#auxiliary"
      || metadata.ancillaryWeightMap.category !== "ANCILLARY.WEIGHTMAP"
      || !/^FDS_F\d{1,2}_OCAM_[ugri]_SDSS_wei\.fits$/i.test(String(metadata.ancillaryWeightMap.fileName ?? ""))
      || !weightUrl || weightUrl.hostname !== "dataportal.eso.org" || !/^\/dataPortal\/file\/ADP\.[A-Za-z0-9.:-]+$/.test(weightUrl.pathname)) {
      throw new Error("FDS row lacks its scoped field, J2000 footprint, DataLink #this evidence or direct science-file identity");
    }
  }
  if (source.adapter === "eso-obscore-kids") {
    const metadata = row.sourceMetadata;
    const dpId = String(metadata?.dpId ?? "");
    const filter = String(metadata?.filter ?? "");
    const band = filter.slice(0, 1).toUpperCase();
    const filename = String(row.filename ?? "");
    const epoch = String(metadata?.epoch ?? "");
    const expectedFilename = `KiDS_DR5.0_${unitId.slice(5)}_${epoch}_sci.fits`;
    const dataLinkUrl = publicUri(metadata?.dataLinkUrl);
    const dataLink = dataLinkUrl ? new URL(dataLinkUrl) : undefined;
    const dataLinkUri = publicUri(metadata?.dataLinkUri);
    const access = row.accessUris ?? [];
    const esoUri = access[0] ? publicUri(access[0].uri ?? access[0].url) : undefined;
    const astroWiseUri = access[1] ? publicKidsUri(access[1].uri ?? access[1].url) : undefined;
    const astroWise = astroWiseUri ? new URL(astroWiseUri) : undefined;
    if (source.id !== KIDS_SOURCE_ID || source.surveyId !== "kids" || source.releaseId !== "kids-dr5"
      || !/^KIDS_[+-]?[0-9]+(?:\.[0-9]+)?_[+-]?[0-9]+(?:\.[0-9]+)?$/.test(unitId) || metadata?.targetName !== unitId
      || !/^ADP\.[A-Za-z0-9.:-]+$/.test(dpId) || metadata?.obsCollection !== "KIDS"
      || metadata?.dataproductType !== "image" || metadata?.releaseDescription !== KIDS_RELEASE_DESCRIPTION
      || metadata?.nativeCoordinateFrame !== "J2000" || !/^POLYGON J2000\s/i.test(metadata?.sourceSRegion ?? "")
      || !/^POLYGON ICRS\s/i.test(sRegion) || metadata?.dataLinkSemantics !== "#this"
      || metadata?.dataLinkCategory !== "SCIENCE.IMAGE" || metadata?.dataLinkFileName !== filename
      || metadata?.esoOriginalFile !== filename || filename !== expectedFilename
      || !["g_SDSS", "r_SDSS", "i_SDSS"].includes(filter) || !["i", "i2", "g", "r"].includes(epoch)
      || (band !== "I" && epoch !== band.toLowerCase())
      || !Array.isArray(row.bands) || row.bands.length !== 1 || String(row.bands[0]).toUpperCase() !== band
      || !dataLink || dataLink.hostname !== "archive.eso.org" || dataLink.pathname !== "/datalink/links"
      || dataLink.searchParams.get("ID") !== `ivo://eso.org/ID?${dpId}`
      || access.length !== 2 || access[0]?.sourceId !== "eso-datalink" || access[1]?.sourceId !== "kids-astro-wise-wget-list"
      || access[0]?.accessType !== "file" || access[1]?.accessType !== "file"
      || access.some((item: Document) => item.fileName !== filename || String(item.band).toUpperCase() !== band)
      || !esoUri || new URL(esoUri).hostname !== "dataportal.eso.org" || new URL(esoUri).pathname !== `/dataPortal/file/${dpId}`
      || metadata?.dataLinkUri !== esoUri || !astroWise || astroWise.protocol !== "http:" || astroWise.hostname !== "ds.astro.rug.astro-wise.org"
      || astroWise.port !== "8000" || astroWise.pathname !== `/${filename}` || metadata?.astroWiseUri !== astroWiseUri
      || metadata?.astroWiseFilename !== filename || metadata?.astroWiseRosterMatchedBy !== "exact-filename"
      || !/^[a-f0-9]{64}$/i.test(String(metadata?.dataLinkResponseSha256 ?? ""))
      || !String(metadata?.geometryTransform ?? "").includes("FK5(equinox=J2000)")) {
      throw new Error("KiDS DR5 row lacks its scoped Tile, J2000 footprint, exact DataLink file or source-list URI identities");
    }
  }
  if (source.adapter === "eso-obscore-vphas") {
    const metadata = row.sourceMetadata;
    const dpId = String(metadata?.dpId ?? "");
    const sourceFilter = String(metadata?.filter ?? "");
    const bandByFilter: Record<string, string> = { u_SDSS: "U", g_SDSS: "G", r_SDSS: "R", i_SDSS: "I", NB_659: "HALPHA" };
    const band = bandByFilter[sourceFilter];
    const filename = String(row.filename ?? "");
    const dataLinkUrl = publicUri(metadata?.dataLinkUrl);
    const dataLink = dataLinkUrl ? new URL(dataLinkUrl) : undefined;
    const direct = row.accessUris?.[0];
    const directUri = direct ? publicUri(direct.uri ?? direct.url) : undefined;
    const polygonCount = (value: string): number => (value.match(/\bPOLYGON\b/gi) ?? []).length;
    const sourceGeometry = String(metadata?.sourceSRegion ?? "");
    const expectedUri = `https://dataportal.eso.org/dataPortal/file/${dpId}`;
    if (source.id !== VPHAS_SOURCE_ID || source.surveyId !== "vphas" || source.releaseId !== "vphas-dr4"
      || unitId !== dpId || !/^ADP\.[A-Za-z0-9.:-]+$/.test(dpId) || !String(metadata?.targetName ?? "")
      || metadata?.obsCollection !== "VPHASplus" || metadata?.dataproductType !== "image"
      || metadata?.releaseDescription !== VPHAS_RELEASE_DESCRIPTION || metadata?.nativeCoordinateFrame !== "J2000"
      || !/^UNION J2000\s/i.test(sourceGeometry) || !/^UNION ICRS\s/i.test(sRegion)
      || !String(metadata?.geometryTransform ?? "").includes("all source-listed UNION J2000 CCD polygons")
      || !Number.isSafeInteger(metadata?.ccdPolygonCount) || metadata.ccdPolygonCount < 1 || metadata.ccdPolygonCount > 32
      || polygonCount(sourceGeometry) !== metadata.ccdPolygonCount || polygonCount(sRegion) !== metadata.ccdPolygonCount
      || band === undefined || !Array.isArray(row.bands) || row.bands.length !== 1 || row.bands[0] !== band
      || !/^[A-Za-z0-9_.+-]+\.fits(?:\.fz)?$/i.test(filename)
      || metadata?.dataLinkSemantics !== "#this" || metadata?.dataLinkCategory !== "SCIENCE.MEFIMAGE"
      || metadata?.dataLinkFileName !== filename || metadata?.esoOriginalFile !== filename
      || String(metadata?.obsCreatorDid ?? "").split("?").at(-1) !== filename
      || !dataLink || dataLink.hostname !== "archive.eso.org" || dataLink.pathname !== "/datalink/links"
      || dataLink.searchParams.get("ID") !== `ivo://eso.org/ID?${dpId}`
      || !/^[a-f0-9]{64}$/i.test(String(metadata?.dataLinkResponseSha256 ?? ""))
      || !directUri || directUri !== expectedUri || row.accessUris?.length !== 1
      || direct?.sourceId !== "eso-datalink" || direct?.accessType !== "file" || direct.fileName !== filename
      || direct.band !== band || metadata?.dataLinkUri !== directUri
      || metadata?.accessSemantics !== "whole-unstacked-omegacam-pawprint-image") {
      throw new Error("VPHAS+ DR4 row lacks its native image identity, source CCD union or exact DataLink single-file identity");
    }
  }
  if (source.adapter === "eso-obscore-viking") {
    const metadata = row.sourceMetadata;
    const dpId = String(metadata?.dpId ?? "");
    const filename = String(row.filename ?? "");
    const tileMatch = /^viking_er1_[A-Za-z0-9.+-]+_tile_j_(deepimage|image)_(\d+)\.fits\.fz$/i.exec(filename);
    const dataLinkUrl = publicUri(metadata?.dataLinkUrl);
    const dataLink = dataLinkUrl ? new URL(dataLinkUrl) : undefined;
    const direct = row.accessUris?.[0];
    const directUri = direct ? publicUri(direct.uri ?? direct.url) : undefined;
    const expectedUri = `https://dataportal.eso.org/dataPortal/file/${dpId}`;
    if (source.id !== VIKING_SOURCE_ID || source.surveyId !== "vista" || source.releaseId !== "viking"
      || !tileMatch || unitId !== tileMatch[2] || metadata?.tileId !== unitId || !String(metadata?.targetName ?? "")
      || !/^ADP\.[A-Za-z0-9.:-]+$/.test(dpId) || metadata?.obsCollection !== "VIKING"
      || metadata?.dataproductType !== "image" || metadata?.releaseDescription !== VIKING_RELEASE_DESCRIPTION
      || metadata?.filter !== "J" || metadata?.nativeCoordinateFrame !== "J2000"
      || !/^POLYGON J2000\s/i.test(metadata?.sourceSRegion ?? "") || !/^POLYGON ICRS\s/i.test(sRegion)
      || !String(metadata?.geometryTransform ?? "").includes("FK5(equinox=J2000)")
      || metadata?.dataLinkSemantics !== "#this" || metadata?.dataLinkCategory !== "SCIENCE.IMAGE"
      || metadata?.dataLinkFileName !== filename || metadata?.esoOriginalFile !== filename
      || String(metadata?.obsCreatorDid ?? "").split("?").at(-1) !== filename
      || !dataLink || dataLink.hostname !== "archive.eso.org" || dataLink.pathname !== "/datalink/links"
      || dataLink.searchParams.get("ID") !== `ivo://eso.org/ID?${dpId}`
      || !/^[a-f0-9]{64}$/i.test(String(metadata?.dataLinkResponseSha256 ?? ""))
      || !directUri || directUri !== expectedUri || row.accessUris?.length !== 1
      || direct?.sourceId !== "eso-datalink" || direct?.accessType !== "file" || direct.fileName !== filename || direct.band !== "J"
      || metadata?.dataLinkUri !== directUri || metadata?.officialReleaseTileCount !== 151 || metadata?.observedTileCount !== 110
      || metadata?.validPixelMasksChecked !== false || metadata?.accessSemantics !== "whole-tile-science-image") {
      throw new Error("VIKING DR1 row lacks its native Tile suffix, J2000 footprint or exact DataLink single-file identity");
    }
  }
  if (source.adapter === "skymapper-dr4-ccd") {
    const metadata = row.sourceMetadata;
    const imageId = String(metadata?.imageId ?? "");
    const ccd = metadata?.ccd;
    const filter = String(metadata?.filter ?? "").toLowerCase();
    const cutout = row.accessUris?.[0];
    const parsed = cutout ? new URL(String(cutout.uri ?? cutout.url)) : undefined;
    const position = parsed?.searchParams.get("POS")?.split(",").map(Number);
    if (source.id !== SKYMapper_SOURCE_ID || !/^\d{14}$/.test(imageId) || imageId < "20140315000000" || imageId >= "20140318000000"
      || !Number.isInteger(ccd) || ccd < 1 || ccd > 32 || !["g", "r", "i"].includes(filter)
      || unitId !== `${imageId}-${String(ccd).padStart(2, "0")}` || !/^POLYGON ICRS\s/i.test(sRegion)
      || metadata?.sourceCoverage !== sRegion || metadata?.geometrySource !== "dr4.ccds.coverage"
      || metadata?.originalFilename !== row.filename || !/^\d{5}\/\d{2}\/Skymapper_[A-Za-z0-9_.:-]+_\d{2}_red\.fits$/.test(String(row.filename ?? ""))
      || metadata?.accessSemantics !== "five-arcmin-fits-cutout-not-full-ccd" || metadata?.cutoutSizeDeg !== 0.0833
      || !Array.isArray(row.bands) || row.bands.length !== 1 || String(row.bands[0]).toLowerCase() !== filter
      || row.accessUris?.length !== 1 || !parsed || parsed.protocol !== "https:" || parsed.hostname !== "api.skymapper.nci.org.au"
      || parsed.pathname !== "/public/siap/dr4/get_image" || parsed.searchParams.get("IMAGE") !== unitId
      || parsed.searchParams.get("SIZE") !== "0.0833" || parsed.searchParams.get("FORMAT") !== "fits"
      || !position || position.length !== 2 || !position.every(Number.isFinite)
      || !Array.isArray(metadata?.cutoutCenterIcrs) || metadata.cutoutCenterIcrs.length !== 2
      || position.some((value: number, index: number) => value !== Number(metadata.cutoutCenterIcrs[index]))
      || cutout?.accessType !== "file" || String(cutout.band).toLowerCase() !== filter
      || cutout.fileName !== undefined && !/\.fits$/i.test(String(cutout.fileName))) {
      throw new Error("SkyMapper CCD row must retain its DR4 ICRS polygon, native identity and source-supported FITS cutout");
    }
  }
  if (source.adapter === "twomass-6x-atlas") {
    const metadata = row.sourceMetadata;
    const dataset = String(metadata?.dataset ?? "");
    const date = String(metadata?.date ?? "");
    const hem = String(metadata?.hemisphere ?? "");
    const scan = metadata?.scan;
    const image = metadata?.image;
    const band = String(metadata?.band ?? "").toUpperCase();
    const originalDownload = publicUri(metadata?.originalDownload);
    const parsedDownload = originalDownload ? new URL(originalDownload) : undefined;
    const direct = row.accessUris?.[0];
    const parsedDirect = direct ? new URL(String(direct.uri ?? direct.url)) : undefined;
    const scanPath = Number.isInteger(scan) ? String(scan).padStart(3, "0") : "";
    const imagePath = Number.isInteger(image) ? String(image).padStart(4, "0") : "";
    const fileName = `${band.toLowerCase()}i${scanPath}${imagePath}.fits.gz`;
    const expectedUnitId = `${date}${hem}/s${scanPath}/${imagePath}/${band}`;
    const expectedUri = `https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/${date}${hem}/s${scanPath}/image/${fileName}`;
    const downloadQuery = parsedDownload?.searchParams;
    if (!TWOMASS_SOURCE_SPECS[source.id] || dataset !== "sx" || !/^\d{6}$/.test(date) || !["n", "s"].includes(hem)
      || !Number.isInteger(scan) || scan < 0 || scan > 999 || !Number.isInteger(image) || image < 0 || image > 9999
      || !["J", "H", "K"].includes(band) || unitId !== expectedUnitId || row.filename !== fileName
      || !/^POLYGON ICRS\s/i.test(sRegion) || metadata?.sourceFrame !== "FK5(J2000)" || metadata?.projection !== "RA---SIN/DEC--SIN"
      || metadata?.geometrySource !== "2MASS SIA WCS pixel-edge transform" || !Number.isSafeInteger(metadata?.coaddKey)
      || !parsedDownload || parsedDownload.hostname !== "irsa.ipac.caltech.edu" || parsedDownload.pathname !== "/cgi-bin/2MASS/IM/nph-im"
      || downloadQuery?.get("ds") !== "sx" || downloadQuery.get("dh") !== `${date}${hem}` || downloadQuery.get("scan") !== scanPath
      || downloadQuery.get("name") !== `${band.toLowerCase()}i${scanPath}${imagePath}.fits`
      || row.accessUris?.length !== 1 || !parsedDirect || parsedDirect.href !== expectedUri || direct?.fileName !== fileName
      || direct?.accessType !== "file" || String(direct.band).toUpperCase() !== band) {
      throw new Error("2MASS 6X rows must retain their Atlas image identity, FK5-derived ICRS footprint and rule-derived whole-image URI");
    }
  }
  if (source.adapter === "allwise-ibe-atlas") {
    const metadata = row.sourceMetadata;
    const coaddId = String(metadata?.coaddId ?? "");
    const band = String(metadata?.band ?? "").toUpperCase();
    const bandNumber = metadata?.bandNumber;
    const fileName = `${coaddId}-w${bandNumber}-int-3.fits`;
    const expectedUri = `https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/${coaddId.slice(0, 2)}/${coaddId.slice(0, 4)}/${coaddId}/${fileName}`;
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const corners = metadata?.sourceCornersJ2000;
    const wcs = metadata?.sourceWcs;
    if (source.id !== ALLWISE_SOURCE_ID || source.surveyId !== "allwise" || source.releaseId !== "allwise"
      || !/^\d{4}[pm]\d{3}_ac\d+$/i.test(coaddId) || unitId !== coaddId
      || !["W3", "W4"].includes(band) || bandNumber !== Number(band.slice(1))
      || !Array.isArray(row.bands) || row.bands.length !== 1 || row.bands[0] !== band
      || !/^POLYGON ICRS\s/i.test(sRegion) || metadata?.footprint !== sRegion
      || metadata?.sourceNativeFrame !== "FK5(J2000)" || metadata?.coordinateTransform !== "FK5(equinox=J2000) to ICRS via Astropy"
      || metadata?.geometrySource !== "allwise_p3am_cdd ra1/dec1 through ra4/dec4"
      || metadata?.equinox !== 2000 || metadata?.validPixelMasksChecked !== false
      || !Array.isArray(corners) || corners.length !== 4 || corners.some((point: unknown) => !Array.isArray(point) || point.length !== 2
        || !point.every((value: unknown) => Number.isFinite(value)) || (point as number[])[0]! < 0 || (point as number[])[0]! >= 360
        || (point as number[])[1]! < -90 || (point as number[])[1]! > 90)
      || !wcs || wcs.naxis1 !== 4095 || wcs.naxis2 !== 4095 || wcs.ctype1 !== "RA---SIN" || wcs.ctype2 !== "DEC--SIN"
      || ![wcs.crval1, wcs.crval2, wcs.crpix1, wcs.crpix2, wcs.cdelt1, wcs.cdelt2, wcs.crota2].every(Number.isFinite)
      || metadata?.accessSemantics !== "whole-intensity-fits" || metadata?.uriRule !== "official AllWISE IBE p3am_cdd path"
      || row.filename !== fileName || row.accessUris?.length !== 1 || !uri || uri !== expectedUri
      || access?.sourceId !== "irsa-allwise-ibe" || access.fileName !== fileName || access.accessType !== "file" || access.band !== band) {
      throw new Error("AllWISE rows must retain their source-table coadd, J2000 frame corners and documented whole-intensity FITS URI");
    }
  }
  if (source.adapter === "noirlab-des-tap") {
    const metadata = row.sourceMetadata;
    const band = String(row.bands?.[0] ?? "").toUpperCase();
    const fileName = String(metadata?.fileRef ?? "");
    const publisherDid = String(metadata?.publisherDid ?? "");
    const corners = metadata?.cornersIcrs;
    const validCorners = Array.isArray(corners) && corners.length === 4 && corners.every((point: unknown) => Array.isArray(point)
      && point.length === 2 && point.every((value: unknown) => Number.isFinite(value)));
    const access = row.accessUris?.[0];
    const uri = access ? publicUri(access.uri ?? access.url) : undefined;
    const parsed = uri ? new URL(uri) : undefined;
    const fileRefs = parsed ? rawQueryValues(parsed, "siaRef") : [];
    if (source.id !== DES_SOURCE_ID || source.surveyId !== "des" || source.releaseId !== "des-dr2"
      || !/^DES\d{4}[+-]\d{4}$/.test(unitId) || !["G", "R", "I", "Z", "Y"].includes(band)
      || !/^DES\d{4}[+-]\d{4}_[A-Za-z0-9]+_[grizY]\.fits\.fz$/.test(fileName) || row.filename !== fileName
      || !Array.isArray(row.bands) || row.bands.length !== 1 || !/^ivo:\/\/datalab\.noao\/des_dr2\//i.test(publisherDid)
      || !publisherDid.endsWith(`/${fileName}#1`) || metadata?.tileId !== unitId || metadata?.filter !== band
      || metadata?.coordinateFrame !== "ICRS" || metadata?.geometrySource !== "ivoa_des_dr2.siav1 ICRS image corners"
      || metadata?.accessSemantics !== "full-coadd-image-no-region-cutout" || metadata?.hdu !== 1
      || !validCorners || corners.some((point: number[]) => point[0]! < 0 || point[0]! >= 360 || point[1]! < -90 || point[1]! > 90)
      || metadata?.footprint !== sRegion || !/^POLYGON ICRS\s/i.test(sRegion)
      || row.accessUris?.length !== 1 || access?.accessType !== "file" || access.fileName !== fileName || String(access.band) !== band
      || !parsed || parsed.protocol !== "https:" || parsed.hostname !== "datalab.noirlab.edu" || parsed.pathname !== "/svc/cutout"
      || parsed.searchParams.get("col") !== "des_dr2" || fileRefs.length !== 1 || fileRefs[0] !== fileName || parsed.searchParams.get("extn") !== "1"
      || parsed.searchParams.has("POS") || parsed.searchParams.has("SIZE") || publicUri(metadata?.accessUrl) !== parsed.href) {
      throw new Error("DES DR2 rows must retain their Tile, ICRS corners and no-cutout full-coadd file identity");
    }
  }
  if (source.adapter === "spherex-qr2-s3-observation") {
    const metadata = row.sourceMetadata;
    const spec = SPHEREX_SOURCE_SPECS[source.id];
    const detector = Number(metadata?.detector);
    const filename = String(metadata?.fileName ?? "");
    const key = String(metadata?.objectKey ?? "");
    const match = spec ? new RegExp(`^level2_2025W17_4B_0001_1D([${spec.detectors.join("")}])_spx_${spec.processingVersion}\\.fits$`).exec(filename) : null;
    const expectedPrefix = spec ? `qr2/level2/2025W17_4B/${spec.processingVersion}/` : "";
    const expectedUnitId = spec?.versionedUnitId
      ? `2025W17_4B_0001_1/${spec.processingVersion}/D${detector}` : `2025W17_4B_0001_1/D${detector}`;
    const originalUri = publicUri(`https://irsa.ipac.caltech.edu/ibe/data/spherex/${key}`);
    const mirrorUri = publicUri(`https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/${key}`);
    const validFrame = Array.isArray(metadata?.frameEdgeIcrs) && metadata.frameEdgeIcrs.length === 32
      && metadata.frameEdgeIcrs.every((point: unknown) => Array.isArray(point) && point.length === 2
        && point.every((value: unknown) => Number.isFinite(value))
        && (point as number[])[0]! >= 0 && (point as number[])[0]! < 360
        && (point as number[])[1]! >= -90 && (point as number[])[1]! <= 90);
    const expectedRegion = validFrame
      ? `POLYGON ICRS ${metadata.frameEdgeIcrs.map((point: number[]) => `${point[0]!.toFixed(10)} ${point[1]!.toFixed(10)}`).join(" ")}`
      : "";
    const uris = row.accessUris ?? [];
    if (!spec || source.surveyId !== "spherex" || source.releaseId !== "spherex-qr2"
      || detector !== Number(match?.[1])
      || unitId !== expectedUnitId || row.filename !== filename
      || !key.startsWith(expectedPrefix + `${detector}/`) || !key.endsWith(`/${filename}`)
      || metadata?.observationId !== "2025W17_4B_0001_1" || metadata?.processingVersion !== spec.processingVersion
      || metadata?.coordinateFrame !== "ICRS" || metadata?.geometrySource !== "SPHEREx FITS IMAGE extension TAN-SIP pixel-edge transform"
      || metadata?.availabilityEvidence !== "public-object-listing-and-header-ranges"
      || metadata?.frameSemantics !== "detector image frame; valid-pixel mask not checked"
      || !/^[a-f0-9]{64}$/.test(metadata?.wcsHeaderSha256 ?? "") || typeof metadata?.wcsHeaderRef !== "string"
      || !Number.isSafeInteger(metadata?.fileSizeBytes) || metadata.fileSizeBytes < 1
      || !Array.isArray(row.bands) || row.bands.length !== 1 || row.bands[0] !== `D${detector}`
      || !/^POLYGON ICRS\s/i.test(sRegion) || !validFrame || sRegion !== expectedRegion
      || uris.length !== 2 || !uris.some((access: Document) => publicUri(access.uri) === originalUri && access.fileName === filename && access.band === `D${detector}` && access.accessType === "file")
      || !uris.some((access: Document) => publicUri(access.uri) === mirrorUri && access.fileName === filename && access.band === `D${detector}` && access.accessType === "file")) {
      throw new Error("SPHEREx row must retain its scoped observation identity, header-derived ICRS frame and official/mirror whole-file URIs");
    }
  }
  if (source.adapter === "mast-observation") {
    if (String(row.dataRights).toUpperCase() !== "PUBLIC" || String(row.dataproduct_type).toLowerCase() !== "image" || String(row.obs_collection).toLowerCase() !== source.surveyId || !/^\d+$/.test(unitId)) throw new Error("MAST snapshot contains a non-public or unrelated observation");
    if (source.surveyId === "jwst" && (row.provenance_name !== "CALJWST" || !Number.isFinite(row.t_min) || ![1, 2, 3, 4].includes(Number(row.calib_level)))) throw new Error("Planned, test or uncalibrated JWST records cannot become observed sky units");
  }
  const bands: string[] = (Array.isArray(row.bands) ? row.bands : String(row.filters ?? "").split(/[,;\s]+/)).map((band: unknown) => String(band).toUpperCase()).filter(Boolean);
  const dataUrl = String(row.dataURL ?? "");
  const releaseTag = source.surveyId === "sdss" ? "DR9" : source.surveyId === "galex" ? /\/data\/(GR[67])\//i.exec(dataUrl)?.[1]?.toUpperCase() : source.surveyId === "vista" ? "DR4" : undefined;
  if (source.surveyId === "galex" && !releaseTag) return undefined;
  const accessUris = (row.accessUris ?? []).flatMap((access: Document) => {
    const uri = publicUri(access.uri ?? access.url);
    return uri ? [{ ...access, uri, ...(access.fileName ?? access.filename ? { fileName: access.fileName ?? access.filename } : {}), ...(access.band ? { band: String(access.band).toUpperCase() } : {}) }] : [];
  });
  return { ...row, unitId, sRegion, bands, releaseTag, accessUris,
    instrument: row.instrument ?? row.instrument_name, proposalId: String(row.proposalId ?? row.proposal_id ?? ""), targetName: row.targetName ?? row.target_name,
    sourceMetadata: row.sourceMetadata ?? row.metadata ?? {} };
}

export class SurveyNativeIndex {
  readonly #db: DatabaseSync;
  readonly #sources: Map<string, Summary>;
  readonly buildKey: string;
  readonly fileRef?: string;
  private constructor(db: DatabaseSync, buildKey: string, fileRef?: string) {
    this.#db = db; this.buildKey = buildKey; this.fileRef = fileRef;
    db.exec("PRAGMA cache_size=-8192; PRAGMA mmap_size=0; CREATE TEMP TABLE request_cells(cell INTEGER PRIMARY KEY) WITHOUT ROWID;");
    this.#sources = new Map((db.prepare("SELECT source_id AS sourceId, payload FROM survey_sources").all() as Array<{ sourceId: string; payload: string }>).map(row => [row.sourceId, JSON.parse(row.payload) as Summary]));
  }
  static open(file: string, buildKey: string, fileRef?: string): SurveyNativeIndex {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const meta = new Map((db.prepare("SELECT key,value FROM survey_meta").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]));
      if (meta.get("schema") !== SCHEMA || meta.get("build_key") !== buildKey) throw new Error("Survey native index schema or locked inputs do not match");
      return new SurveyNativeIndex(db, buildKey, fileRef);
    } catch (error) { db.close(); throw error; }
  }
  static key(snapshots: NativeSnapshot[]): string { return nativeDigest({ schema: SCHEMA, construction: "local-staging-v1", inputs: snapshots.map(snapshot => [snapshot.sourceId, snapshot.id, snapshot.files[0]!.sha256]).sort() }); }
  private static async reusableFileRef(root: string, buildKey: string): Promise<string | undefined> {
    const directory = nativeEvidencePath(root, "managed/native-units/indexes");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const ref = `managed/native-units/indexes/${entry.name}/survey-units.sqlite`;
      try {
        const file = nativeEvidencePath(root, ref);
        if (!(await stat(file)).isFile()) continue;
        const index = this.open(file, buildKey, ref);
        index.close();
        return ref;
      } catch {
        continue;
      }
    }
    return undefined;
  }
  static async build(root: string, ref: string, sources: NativeSource[], snapshots: NativeSnapshot[], progress: (message: string) => void,
    base?: { file: NativeFile; buildKey: string; snapshots: NativeSnapshot[] }): Promise<SurveyNativeIndex> {
    const file = nativeEvidencePath(root, ref); await mkdir(path.dirname(file), { recursive: true });
    const buildKey = this.key(snapshots);
    try {
      if ((await stat(file)).isFile()) return this.open(file, buildKey, ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const reusableRef = await this.reusableFileRef(root, buildKey);
    if (reusableRef) {
      progress(`Reusing verified survey metadata SQLite from ${reusableRef}`);
      return this.open(nativeEvidencePath(root, reusableRef), buildKey, reusableRef);
    }
    const currentBySource = new Map(snapshots.map(snapshot => [snapshot.sourceId, snapshot]));
    const matchesLockedInput = (previous: NativeSnapshot): boolean => {
      const current = currentBySource.get(previous.sourceId);
      return Boolean(current && current.id === previous.id && current.sourceRevision === previous.sourceRevision
        && current.files.length === previous.files.length
        && current.files.every((file, index) => file.sha256 === previous.files[index]?.sha256));
    };
    const canExtend = Boolean(base && base.snapshots.length > 0 && snapshots.length > base.snapshots.length
      && base.buildKey === this.key(base.snapshots) && base.snapshots.every(matchesLockedInput));
    // SQLite's random page writes can stall for minutes on the evidence NFS.
    // Build on the worker's temporary disk, then atomically install the closed DB.
    const scratch = await mkdtemp(path.join(os.tmpdir(), "assets-survey-native-"));
    const staging = path.join(scratch, "survey.sqlite");
    const installing = `${file}.${path.basename(scratch)}.tmp`;
    let installStarted = false;
    let db: DatabaseSync | undefined;
    const healpix = new Healpix(2 ** COARSE_ORDER);
    try {
      if (canExtend && base) {
        const previousFile = nativeEvidencePath(root, base.file.ref);
        await nativeFile(root, base.file.ref, base.file);
        const verified = this.open(previousFile, base.buildKey, base.file.ref);
        verified.close();
        progress(`Extending verified survey metadata SQLite with ${snapshots.length - base.snapshots.length} new source snapshots`);
        await copyFile(previousFile, staging, constants.COPYFILE_EXCL);
        db = new DatabaseSync(staging);
        db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384; CREATE TEMP TABLE native_ids(unit_id TEXT PRIMARY KEY) WITHOUT ROWID; BEGIN IMMEDIATE;");
      } else {
        db = new DatabaseSync(staging);
        db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384;
          CREATE TABLE survey_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE survey_sources(source_id TEXT PRIMARY KEY,payload TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE survey_units(row_id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, unit_id TEXT NOT NULL, row_hash TEXT UNIQUE NOT NULL,
            s_region TEXT, first_ipix INTEGER, last_ipix INTEGER, bands TEXT NOT NULL, release_tag TEXT, proposal_id TEXT, instrument TEXT, target TEXT, project TEXT, payload TEXT NOT NULL);
          CREATE INDEX survey_units_by_source ON survey_units(source_id,unit_id,row_id);
          CREATE INDEX survey_units_by_partition ON survey_units(source_id,first_ipix,last_ipix);
          CREATE TABLE survey_cells(coarse_cell INTEGER NOT NULL,row_id INTEGER NOT NULL,PRIMARY KEY(coarse_cell,row_id)) WITHOUT ROWID;
          CREATE TEMP TABLE native_ids(unit_id TEXT PRIMARY KEY) WITHOUT ROWID;
          BEGIN IMMEDIATE;`);
      }
      const insert = db.prepare("INSERT OR IGNORE INTO survey_units(source_id,unit_id,row_hash,s_region,first_ipix,last_ipix,bands,release_tag,proposal_id,instrument,target,project,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const insertCell = db.prepare("INSERT OR IGNORE INTO survey_cells VALUES (?,?)");
      const insertId = db.prepare("INSERT OR IGNORE INTO native_ids VALUES (?)");
      for (const snapshot of snapshots) {
        if (canExtend && base?.snapshots.some(previous => previous.sourceId === snapshot.sourceId)) continue;
        const source = sources.find(item => item.id === snapshot.sourceId)!;
        const { manifest } = await loadSurveyManifest(root, snapshot.files[0]!.ref, source, snapshot.files[0]);
        let rowCount = 0, indexedRows = 0, excludedRows = 0;
        db.exec("DELETE FROM native_ids;");
        for await (const input of manifestRows(root, snapshot.files[0]!.ref, manifest)) {
          rowCount++;
          const row = normalizedRow(input, source);
          const coarseCells = row && source.adapter !== "gaia-healpix-range" ? candidateCellsForStcs(COARSE_ORDER, row.sRegion, healpix) : [];
          if (!row || source.adapter !== "gaia-healpix-range" && !coarseCells.length) { excludedRows++; continue; }
          const payload = JSON.stringify(row);
          const result = insert.run(source.id, row.unitId, nativeDigest([source.id, row]), row.sRegion ?? null, row.firstIpix ?? null, row.lastIpix ?? null,
            `,${(row.bands ?? []).join(",")},`, row.releaseTag ?? null, row.proposalId ?? null, row.instrument ?? null, row.targetName ?? null, row.project ?? null, payload);
          if (!result.changes) continue;
          indexedRows++; insertId.run(row.unitId);
          for (const cell of coarseCells) insertCell.run(cell, Number(result.lastInsertRowid));
          if (rowCount % 50_000 === 0) progress(`${source.title}: ${rowCount} metadata rows indexed`);
        }
        const unitCount = Number((db.prepare("SELECT count(*) AS total FROM native_ids").get() as { total: number }).total);
        const summary: Summary = { sourceId: source.id, surveyId: source.surveyId, releaseId: source.releaseId, adapter: source.adapter,
          sourceUrl: source.sourceUrl, sha256: snapshot.files[0]!.sha256, capturedAt: manifest.capturedAt, scope: snapshot.scope,
          rowCount, indexedRows, unitCount, excludedRows, inventoryComplete: source.adapter === "gaia-healpix-range" || manifest.inventoryComplete === true && excludedRows === 0,
          queryComplete: ["gaia-healpix-range", "sdss-field"].includes(source.adapter) || manifest.queryPagesComplete === true || manifest.sourcePagination?.queryPagesComplete === true,
          ...(Array.isArray(manifest.gaps) ? { gaps: manifest.gaps } : {}),
          ...(source.adapter === "skyview-radio-maps" ? { headerFailures: Number(manifest.sourcePagination?.headerFailureCount ?? 0),
            geometryFailures: Number(manifest.sourcePagination?.geometryFailureCount ?? 0), spectralConflicts: Number(manifest.scope?.spectralConflictCount ?? 0) } : {}) };
        if (!unitCount) throw new Error(`${source.id} has no supported native metadata geometry`);
        db.prepare("INSERT INTO survey_sources VALUES (?,?)").run(source.id, JSON.stringify(summary));
        progress(`${source.title}: ${unitCount} identities; ${excludedRows} excluded rows retained in input evidence`);
      }
      if (canExtend) db.prepare("UPDATE survey_meta SET value=? WHERE key='build_key'").run(buildKey);
      else {
        db.prepare("INSERT INTO survey_meta VALUES ('schema',?)").run(SCHEMA);
        db.prepare("INSERT INTO survey_meta VALUES ('build_key',?)").run(buildKey);
      }
      db.exec("COMMIT;");
      if ((db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("Survey native SQLite failed integrity verification");
      db.close();
      progress("Installing the verified survey metadata SQLite into evidence storage");
      installStarted = true;
      await copyFile(staging, installing, constants.COPYFILE_EXCL);
      await rename(installing, file);
      return this.open(file, buildKey, ref);
    } catch (error) { try { db?.exec("ROLLBACK;"); } catch {} try { db?.close(); } catch {} throw error; }
    finally {
      await rm(scratch, { recursive: true, force: true });
      if (installStarted) await rm(installing, { force: true });
    }
  }
  get summaries(): Summary[] { return [...this.#sources.values()].map(summary => ({ ...summary })); }
  hasBinding(binding: NativeBinding): boolean { return binding.sourceIds.length > 0 && binding.sourceIds.every(sourceId => this.#sources.has(sourceId)); }
  sampleCells(binding: NativeBinding): number[] {
    const { sql, args } = this.#selection(binding);
    const row = this.#db.prepare(`SELECT s_region AS sRegion,first_ipix AS firstIpix FROM survey_units WHERE ${sql} ORDER BY unit_id,row_id LIMIT 1`).get(...args) as { sRegion: string | null; firstIpix: number | null } | undefined;
    if (!row) return [];
    return row.firstIpix !== null ? [Math.floor(row.firstIpix / 4 ** (8 - 4))] : cellsForStcs(4, Array.from({ length: 12 * 4 ** 4 }, (_, pixel) => pixel), row.sRegion);
  }
  #selection(binding: NativeBinding): { sql: string; args: SQLInputValue[] } {
    if (!this.hasBinding(binding)) throw new Error("Product has no locked survey-native source");
    const terms = [`source_id IN (${binding.sourceIds.map(() => "?").join(",")})`]; const args: SQLInputValue[] = [...binding.sourceIds];
    const selector = binding.selector;
    for (const [column, values] of [["release_tag", selector?.releaseTags], ["proposal_id", selector?.proposalIds], ["target", selector?.targets]] as const) if (values?.length) { terms.push(`${column} IN (${values.map(() => "?").join(",")})`); args.push(...values); }
    if (selector?.bands?.length) { terms.push(`(${selector.bands.map(() => "INSTR(bands,?)>0").join(" OR ")})`); args.push(...selector.bands.map(band => `,${band.toUpperCase()},`)); }
    if (selector?.unitPrefixes?.length) {
      const prefixes = selector.unitPrefixes.map(prefix => prefix.toLowerCase()).filter(prefix => /^[a-z]$/.test(prefix));
      if (!prefixes.length) throw new Error("Native-unit prefix selector is invalid");
      terms.push(`substr(lower(unit_id),1,1) IN (${prefixes.map(() => "?").join(",")})`); args.push(...prefixes);
    }
    if (selector?.instrument) { terms.push("(UPPER(instrument)=? OR UPPER(instrument) LIKE ?)"); args.push(selector.instrument.toUpperCase(), `${selector.instrument.toUpperCase()}/%`); }
    if (selector?.project) { terms.push("UPPER(project)=?"); args.push(selector.project.toUpperCase()); }
    return { sql: terms.join(" AND "), args };
  }
  lookup(binding: NativeBinding, order: number, cells: readonly number[], limit = MAX_UNITS): { units: DownloadPlanSpatialUnit[]; truncated: boolean; queryExhausted: boolean; notes: string[]; inventoryComplete: boolean } {
    if (!Number.isSafeInteger(order) || order < 4 || order > 12 || cells.some(cell => !Number.isSafeInteger(cell) || cell < 0 || cell >= 12 * 4 ** order)) throw new Error("Survey lookup requires ICRS/NESTED cells at order 4 through 12");
    const { sql, args } = this.#selection(binding);
    const sourceSummaries = binding.sourceIds.map(sourceId => this.#sources.get(sourceId)!);
    const summary = sourceSummaries[0]!;
    const rows = this.#db.prepare(`SELECT source_id AS sourceId,unit_id AS unitId,s_region AS sRegion,first_ipix AS firstIpix,last_ipix AS lastIpix,payload FROM survey_units WHERE ${sql}${summary.adapter === "gaia-healpix-range" ? "" : " AND row_id IN (SELECT row_id FROM survey_cells WHERE coarse_cell IN (SELECT cell FROM request_cells))"} ORDER BY unit_id,row_id`);
    this.#db.exec("DELETE FROM request_cells;");
    const insertCell = this.#db.prepare("INSERT OR IGNORE INTO request_cells VALUES (?)");
    for (const cell of new Set(cells.map(cell => Math.floor(cell / 4 ** (order - COARSE_ORDER))))) insertCell.run(cell);
    const matched = new Map<string, DownloadPlanSpatialUnit>();
    const clippedLimit = Math.max(1, Math.min(MAX_UNITS, Math.trunc(limit)));
    let limitHit = false;
    try {
      for (const row of rows.iterate(...args) as Iterable<IndexedRow>) {
        const rowSummary = this.#sources.get(row.sourceId)!;
        const matchingCells = rowSummary.adapter === "gaia-healpix-range" ? cells.filter(cell => {
          const first = order <= 8 ? cell * 4 ** (8 - order) : Math.floor(cell / 4 ** (order - 8));
          const last = order <= 8 ? (cell + 1) * 4 ** (8 - order) - 1 : first;
          return first <= row.lastIpix! && last >= row.firstIpix!;
        }) : cellsForStcs(order, cells, row.sRegion);
        if (!matchingCells.length) continue;
        let unit = matched.get(row.unitId);
        if (!unit && matched.size >= clippedLimit) { limitHit = true; break; }
        const payload = JSON.parse(row.payload) as Document;
        if (!unit) {
          unit = { layerId: binding.layerId, productId: binding.productId, surveyId: binding.surveyId, releaseId: binding.releaseId, product: binding.product,
            ...(binding.modality ? { modality: binding.modality } : {}), unitKind: binding.unitKind, unitId: row.unitId, order, nside: 2 ** order, matchingCells: [], precision: "estimated",
            sourceSnapshotSha256: rowSummary.sha256, sourceUrl: rowSummary.sourceUrl,
            accessAvailability: rowSummary.adapter === "rubin-firstlook-avm" && payload.sourceMetadata?.accessAvailability === "public" ? "public"
              : ["sdss-field", "eso-obscore-vvv", "eso-obscore-fds", "eso-obscore-kids", "eso-obscore-vphas", "eso-obscore-viking", "skymapper-dr4-ccd", "twomass-6x-atlas", "allwise-ibe-atlas", "noirlab-des-tap", "noirlab-decaps-tap", "cadc-caom-cfhtls", "act-dr5-whole-map", "iphas-dr2-pipeline", "irsa-akari-fis-map", "cds-ztf-progenitor-o3", "skyview-radio-maps"].includes(rowSummary.adapter) ? "unverified" : "source-policy",
            sourceMetadata: { capturedAt: rowSummary.capturedAt, inventoryComplete: rowSummary.inventoryComplete,
              sourceSnapshots: [{ sourceId: rowSummary.sourceId, sha256: rowSummary.sha256, capturedAt: rowSummary.capturedAt, scope: rowSummary.scope }], records: [] },
            note: rowSummary.scope };
          if (rowSummary.adapter === "gaia-healpix-range") {
            unit.nativePartition = { coordinateFrame: "ICRS", ordering: "NESTED", order: 8, firstIpix: row.firstIpix!, lastIpix: row.lastIpix!, precision: "exact" };
            const alternatives = alternativesForAccessUri(payload.url, { surveyId: binding.surveyId, releaseId: binding.releaseId, fileName: payload.filename });
            unit.accessUri = payload.url; unit.accessUris = [{ uri: payload.url, fileName: payload.filename, accessType: "file", alternatives }];
            unit.sourceMetadata = { capturedAt: rowSummary.capturedAt, fileRosterComplete: true, scienceContentVerified: false, sizeBytes: payload.sizeBytes,
              sourceMd5: payload.sourceMd5, checksumStatus: "upstream-declared", sourceEtag: payload.sourceEtag, lastModified: payload.lastModified };
          }
          matched.set(row.unitId, unit);
        }
        unit.matchingCells = [...new Set([...unit.matchingCells, ...matchingCells])].sort((a, b) => a - b);
        if (rowSummary.adapter !== "gaia-healpix-range") {
          const snapshots = Array.isArray(unit.sourceMetadata!.sourceSnapshots) ? unit.sourceMetadata!.sourceSnapshots as Document[] : [];
          unit.sourceMetadata!.sourceSnapshots = snapshots;
          if (!snapshots.some((item: Document) => item.sourceId === rowSummary.sourceId && item.sha256 === rowSummary.sha256)) {
            snapshots.push({ sourceId: rowSummary.sourceId, sha256: rowSummary.sha256, capturedAt: rowSummary.capturedAt, scope: rowSummary.scope });
            unit.sourceMetadata!.inventoryComplete = unit.sourceMetadata!.inventoryComplete !== false && rowSummary.inventoryComplete;
            const note = unit.note ?? "";
            if (!note.includes(rowSummary.scope)) unit.note = `${note} ${rowSummary.scope}`.trim();
          }
          const regions = new Set([...(unit.sRegion ? [unit.sRegion] : []), row.sRegion!]); unit.sRegion = [...regions].join(" ");
          unit.instrument = [...new Set([unit.instrument, payload.instrument].filter(Boolean))].join(", ") || undefined;
          const selectedBands = (payload.bands ?? []).filter((band: string) => !binding.selector?.bands?.length || binding.selector.bands.includes(band));
          unit.filters = [...new Set([...(unit.filters?.split(", ") ?? []), ...selectedBands])].sort().join(", ");
          const direct = mastScienceFile(payload.dataURL, binding.surveyId);
          const accessUris: SourceAccessUri[] = direct ? [{ uri: direct.uri, fileName: direct.fileName, accessType: "file",
            alternatives: alternativesForAccessUri(direct.uri, { surveyId: binding.surveyId, releaseId: binding.releaseId, fileName: direct.fileName,
              band: payload.bands?.length === 1 ? payload.bands[0] : undefined }) }] : [];
          for (const access of payload.accessUris as Document[]) {
            if (!access.band || !binding.selector?.bands?.length || binding.selector.bands.includes(String(access.band).toUpperCase())) {
              const uri = rowSummary.adapter === "eso-obscore-kids" ? publicKidsUri(access.uri ?? access.url) : publicUri(access.uri ?? access.url);
              const fileName = String(access.fileName ?? access.filename ?? "");
              const sourceId = typeof access.sourceId === "string" ? access.sourceId : undefined;
              const generatedCutout = rowSummary.adapter === "skymapper-dr4-ccd" && uri !== undefined
                && new URL(uri).hostname === "api.skymapper.nci.org.au" && new URL(uri).pathname === "/public/siap/dr4/get_image";
              const supportedFile = /\.(?:fits(?:\.(?:gz|bz2|fz))?|asdf)$/i.test(fileName)
                || rowSummary.adapter === "rubin-firstlook-avm" && /\.tiff?$/i.test(fileName);
              if (uri && (generatedCutout || supportedFile) && !accessUris.some(item => item.uri === uri)) {
                accessUris.push({ uri, ...(fileName ? { fileName } : {}), ...(typeof access.band === "string" ? { band: access.band.toUpperCase() } : {}),
                  ...(sourceId ? { sourceId } : {}), accessType: "file", alternatives: alternativesForAccessUri(uri,
                  { surveyId: binding.surveyId, releaseId: binding.releaseId, fileName, band: access.band }) });
              }
            }
          }
          const allUris = new Map([...(unit.accessUris ?? []), ...accessUris].map(access => [access.uri, access]));
          unit.accessUris = [...allUris.values()]; unit.accessUri = unit.accessUris[0]?.uri;
          const productEntryPoint = (payload.accessUris as Document[]).map((access: Document) => publicUri(access.uri ?? access.url))
            .find((uri: string | undefined) => uri && new URL(uri).hostname === "mast.stsci.edu" && new URL(uri).pathname === "/api/v0/invoke");
          if (productEntryPoint) {
            const entrypoints = new Map((unit.sourceMetadata!.entrypoints ?? []).map(item => [item.uri, item]));
            entrypoints.set(productEntryPoint, metadataEntrypoint(productEntryPoint, binding.surveyId, binding.releaseId));
            unit.sourceMetadata!.entrypoints = [...entrypoints.values()];
          }
          const dataLinkUrl = ["eso-obscore-vvv", "eso-obscore-fds", "eso-obscore-kids", "eso-obscore-vphas", "eso-obscore-viking"].includes(rowSummary.adapter) ? publicUri(payload.sourceMetadata?.dataLinkUrl) : undefined;
          if (dataLinkUrl) {
            const entrypoints = new Map((unit.sourceMetadata!.entrypoints ?? []).map(item => [item.uri, item]));
            entrypoints.set(dataLinkUrl, metadataEntrypoint(dataLinkUrl, binding.surveyId, binding.releaseId));
            unit.sourceMetadata!.entrypoints = [...entrypoints.values()];
          }
          (unit.sourceMetadata!.records as unknown[]).push({ ...payload.sourceMetadata, ...(payload.dataURL ? { dataURL: payload.dataURL } : {}),
            ...(payload.obs_id ? { obs_id: String(payload.obs_id) } : {}), ...(payload.objID ? { objID: String(payload.objID) } : {}),
            bands: payload.bands, releaseTag: payload.releaseTag, proposalId: payload.proposalId, targetName: payload.targetName,
            project: payload.project, provenance: payload.provenance_name, t_min: payload.t_min, t_max: payload.t_max, calib_level: payload.calib_level, dataRights: payload.dataRights,
            sourceId: rowSummary.sourceId, sourceSnapshotSha256: rowSummary.sha256, sourceUrl: rowSummary.sourceUrl, sourceScope: rowSummary.scope, sRegion: row.sRegion });
        }
      }
    } finally { this.#db.exec("DELETE FROM request_cells;"); }
    const notes = sourceSummaries.map(item => item.scope);
    if (sourceSummaries.some(item => !item.inventoryComplete)) notes.push(`${binding.surveyId}: these locked metadata snapshots do not establish complete survey inventory.`);
    const excludedRows = sourceSummaries.reduce((sum, item) => sum + item.excludedRows, 0);
    if (excludedRows) notes.push(`${binding.surveyId}: ${excludedRows} metadata rows lack supported release or geometry; their source evidence is retained.`);
    if (limitHit) notes.push(`${binding.surveyId}: the ${clippedLimit}-unit query limit was reached.`);
    if (summary.adapter === "mast-observation") {
      const detail = "Original MAST s_region is retained. Complex polygons use a conservative spherical cap and can include nearby false positives; valid-pixel masks and complete scientific product inventory were not inspected. The Products API is the source-policy entrypoint; archive-reported dataURL subtypes are preserved without synthesizing intensity files.";
      notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
    }
    if (summary.adapter === "eso-obscore-vvv") {
      const detail = "VVV native Tiles and ObsCore footprints are limited to the 11,452-row DR4 submission increment, not the cumulative DR4 inventory. Original POLYGON J2000 geometry is retained and transformed to ICRS; image-frame bounds remain estimated without valid-pixel masks. Direct files are the ESO DataLink #this records; their availability was not verified with a successful file response.";
      notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
    }
    if (summary.adapter === "eso-obscore-fds") {
      const detail = "FDS DR1 returns its official 97 science-image records across 26 native fields and u/g/r/i bands; the 97 paired weight maps remain ancillary and are not listed as science images. Original POLYGON J2000 footprints are transformed to estimated ICRS frame bounds without valid-pixel-mask checks. Each link is the DataLink #this single-file product; only representative files were checked, so individual availability remains unverified.";
      notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
    }
    if (summary.adapter === "eso-obscore-kids") {
      const detail = "KiDS DR5 includes the complete source-listed ESO g/r/i roster: 5,388 images across 1,347 Tiles, including separate i and i2 epochs. Each image retains its ESO DataLink #this URL and the exact-filename match from the official Astro-WISE wget list. The sources are separate FITS representations, not asserted byte-identical mirrors; the Astro-WISE URL remains HTTP as listed. Original J2000 frame polygons are transformed to estimated ICRS bounds without valid-pixel masks; only representative links were checked, so per-file availability remains unverified.";
      notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
    }
    if (summary.adapter === "eso-obscore-vphas") {
      const detail = "VPHAS+ DR4 returns the exact 15,534-image final incremental ESO submission, not a reconciled cumulative DR4 inventory. Each unstacked OmegaCAM pawprint retains its source UNION of CCD polygons transformed from J2000 to ICRS; geometry remains estimated and valid-pixel masks were not inspected. Links are source-listed DataLink #this single-file products; only a representative URI was probed, so individual availability remains unverified.";
      notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
    }
    if (summary.adapter === "eso-obscore-viking") {
      const detail = "VIKING DR1 returns 110 source-listed J-band Tile images identified by their numeric Tile suffixes; the release description declares 151 survey Tiles, so the remaining 41 are not represented by this input. Original POLYGON J2000 frames are transformed to estimated ICRS geometry without valid-pixel masks. Each URI is the direct ESO DataLink #this FITS image; individual availability is unverified.";
      notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
    }
        if (summary.adapter === "skymapper-dr4-ccd") {
          const detail = "SkyMapper units are limited to the 2014-03-15 through 2014-03-18 g/r/i CCD metadata increment, not the cumulative DR4 inventory. Original dr4.ccds ICRS polygons are retained with estimated precision. Each linked SIAP product is a fixed five-arcmin FITS cutout centered on the CCD, not the complete CCD image or an arbitrary full-region cutout; individual cutout URLs remain unverified.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "twomass-6x-atlas") {
          const detail = "2MASS 6X results include only the explicitly listed bounded one-degree Atlas-image queries, not the full 6X inventory. Original FK5/J2000 SIN WCS values are retained and transformed to estimated ICRS frame edges; valid-pixel masks were not inspected. Whole-image FITS links follow the documented IRSA IBE path rule; individual file availability is unverified.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "allwise-ibe-atlas") {
          const detail = "AllWISE returns the complete 18,240-coadd W3/W4 intensity roster from the official p3am_cdd source table. Native Tile IDs preserve coadd_id values such as _ac51; source J2000 corners are transformed to estimated ICRS image-frame bounds, not valid-pixel coverage. Each band has a direct whole-FITS IRSA IBE URI derived from the documented path rule; individual file availability remains unverified.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "cadc-caom-cfhtls") {
          const detail = "CFHTLS Wide returns the complete 855-file T0007 single-band u/g/r/i/z median-image selector across 171 fields; the 110 gri/gry/ryg RGB artifacts are separate products and excluded here. Each native CAOM frame polygon is explicitly corroborated as ICRS by its joined Chunk metadata, but remains estimated without valid-pixel masks. CADC whole-file API URLs are derived from the source cadc: artifact identity; only a representative file was checked, so per-file availability remains unverified.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "iphas-dr2-pipeline") {
          const detail = "IPHAS results use the pinned author image-pipeline table's in_dr2 recalibration flag and run/CCD identity; this does not establish final DR2 QC membership. Four-corner ZPN frame bounds are estimated, and the source-rule whole-image URLs are currently unverified.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "rubin-firstlook-avm") {
          const detail = "Rubin First Look resolves only the two NOIRLab publisher TIFFs underlying the public outreach HiPS layer. AVM declares Position quality, so TAN frame bounds are estimated; these are not Rubin DP1 scientific exposures and do not represent the Rubin science inventory.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "noirlab-des-tap") {
          const detail = "DES DR2 includes the complete captured 10,169-Tile normal g/r/i/z/Y coadd roster. Each access URL is the source-listed FITS file URL without POS/SIZE cutout parameters; one representative response per selected probe returned 10,000 by 10,000 pixels, while position/size requests returned smaller cutouts. Individual files and valid-pixel masks were not verified; four-corner frame geometry remains estimated.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "noirlab-decaps-tap") {
          const detail = "DECaPS DR2 returns CCD-extension identities from the complete captured 1,065,941-row NOIRLab SIAv1 image table across g/i/r/Y/z. Source-listed Data Lab links select the full FITS CCD extension without POS/SIZE cutout parameters. ICRS TPV frame corners are estimated and valid-pixel masks were not inspected; only representative file endpoints were checked, so individual file availability remains unverified.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
        if (summary.adapter === "act-dr5-whole-map") {
          const detail = "ACT DR5 returns six source-listed direct whole-map FITS files: 090/150/220 GHz, each with night and daynight selection. These are full CAR maps, not spatial Tiles; their header-derived segmented ICRS frame envelope is estimated and does not exclude ACT map holes or artifacts. Header ranges and whole-file HEADs were checked, but scientific pixels and complete-file checksums were not downloaded or verified. Other ACT DR5 product families are outside this selector, so full-release inventory is incomplete.";
          notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
        }
    const queryComplete = sourceSummaries.every(item => item.queryComplete);
    return { units: [...matched.values()], queryExhausted: !limitHit && queryComplete && excludedRows === 0, truncated: limitHit || excludedRows > 0 || !queryComplete,
      notes, inventoryComplete: sourceSummaries.every(item => item.inventoryComplete) };
  }
  close(): void { this.#db.close(); }
}
