import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { eroFitsFrame, type EroFitsHeader } from "../server/ero-fits-footprint.js";
import { ERO_METADATA_URL, parseEroTargetSnapshot } from "../server/ero-target-index.js";
import { archiveNativeUnits } from "../server/archive-native-units.js";
import { OVERLAP_DOWNLOAD_HEADER, overlapCsvRows } from "../site/src/overlap-download.js";
import type { ArtifactStore } from "../server/artifact-store.js";
import type { CoverageCellLayer } from "../server/coverage.js";

const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function fixtureHeader(filter = "VIS", ra = 5.0632, dec = 59.288): EroFitsHeader {
  const instrument = filter === "VIS" ? "VIS" : "NISP";
  const name = `ERO-IC10/Euclid-${filter === "VIS" ? "VIS" : `NISP-${filter}`}-ERO-IC10-Flattened.DR3.fits.gz`;
  const tar = Buffer.alloc(512);
  tar.write(name); tar.write("00000020000\0", 124); tar.fill(32, 148, 156); tar[156] = 48;
  tar.write(tar.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  const values = { SIMPLE: "T", BITPIX: "-32", NAXIS: "2", NAXIS1: "36000", NAXIS2: "36000",
    RADESYS: "'ICRS'", CTYPE1: "'RA---TAN'", CTYPE2: "'DEC--TAN'", CUNIT1: "'deg'", CUNIT2: "'deg'",
    CRVAL1: String(ra), CRVAL2: String(dec), CRPIX1: "18000.5", CRPIX2: "18000.5",
    CD1_1: "-0.00002777777777778", CD1_2: "0", CD2_1: "0", CD2_2: "0.00002777777777778" };
  const header = (Object.entries(values).map(([key, value]) => `${key.padEnd(8)}= ${value}`.padEnd(80)).join("") + "END".padEnd(80)).padEnd(2880);
  return { targetId: "ERO-IC10", packageUrl: `https://cdn.euclid.esac.esa.int/Stack/Euclid-${instrument}-Stack-ERO-IC10.DR3.tar`,
    memberName: name, instrument, filter, tarOffset: 0, tarHeaderBase64: tar.toString("base64"), header, headerSha256: sha(header), compressedPrefixBytes: 512 };
}

function fixtureSnapshot() {
  const headers = [fixtureHeader(), fixtureHeader("Y", 100, 0), fixtureHeader("J", 100, 0), fixtureHeader("H", 100, 0)];
  for (let index = 1; index < headers.length; index++) headers[index]!.tarOffset = (index - 1) * 8704;
  const urls = [...new Set(headers.map(header => header.packageUrl))];
  return { schemaVersion: 2, kind: "euclid-ero-target-metadata", capturedAt: "2026-10-03T00:00:00Z",
    sourceUrl: ERO_METADATA_URL, geometrySourceUrl: "https://sky.esa.int/esasky-tap/tap/sync",
    landing: "<data><a href='ERO-IC10'>IC10</a></data>",
    products: [{ id: "ERO-IC10", xml: `<data><dataitem><name>ERO-IC10</name>${urls.map(url => `<a href='${url}'>Stack</a>`).join("")}</dataitem></data>` }],
    geometry: JSON.stringify({ metadata: [{ name: "id" }, { name: "stc_s" }], data: [["ic342", "POLYGON ICRS 100 0 101 0 101 1"]] }),
    packageHeaders: urls.map(packageUrl => {
      const fitsHeaders = headers.filter(header => header.packageUrl === packageUrl);
      return { targetId: "ERO-IC10", packageUrl, capturedAt: "2026-10-03T00:00:00Z", tls: "chain-and-hostname-verified", packageSizeBytes: 100000,
        fitsHeaders, ranges: fitsHeaders.flatMap(header => [{ start: header.tarOffset, end: header.tarOffset + 511, sizeBytes: 512, sha256: sha(Buffer.from(header.tarHeaderBase64, "base64")) },
          { start: header.tarOffset + 512, end: header.tarOffset + 1023, sizeBytes: 512, sha256: "a".repeat(64) }]) };
    }) };
}

test("ERO frame bounds use half-pixel TAN edges, with an independent Astropy coordinate baseline", () => {
  const frame = eroFitsFrame(fixtureHeader());
  const values = frame.sRegion.split(/\s+/).slice(2).map(Number);
  const expected = [6.027939416075, 58.784412707169, 4.098460583925, 58.784412707169, 4.069698969226, 59.784241354938, 6.056701030774, 59.784241354938];
  values.forEach((value, index) => assert.ok(Math.abs(value - expected[index]!) < 1e-10));
  assert.equal(frame.sha256, sha(fixtureHeader().header));
});

test("ERO header imports reject altered bytes, other coordinate frames, unsupported distortion and false member identities", () => {
  const header = fixtureHeader();
  assert.throws(() => eroFitsFrame({ ...header, header: header.header.replace("ICRS", "FK5 ") }), /Invalid ERO/);
  const update = (text: string) => ({ ...header, header: text, headerSha256: sha(text) });
  assert.throws(() => eroFitsFrame(update(header.header.replace("ICRS", "FK5 "))), /Invalid ERO/);
  assert.throws(() => eroFitsFrame(update(header.header.replace("RA---TAN", "RA---TPV"))), /Invalid ERO/);
  assert.throws(() => eroFitsFrame(update(header.header.replace("END".padEnd(80), "PV1_1   = 1".padEnd(80) + "END".padEnd(80)).slice(0, 2880))), /Invalid ERO/);
  assert.throws(() => eroFitsFrame({ ...header, memberName: header.memberName.replace("IC10", "IC342") }), /Invalid ERO/);
  assert.throws(() => eroFitsFrame({ ...header, filter: "H" }), /Invalid ERO/);
  assert.throws(() => eroFitsFrame({ ...header, packageUrl: header.packageUrl.replace("Stack", "Catalog") }), /Invalid ERO/);
});

test("ERO C01 resolves IC10 from its VIS header without borrowing IC342 or a sibling band's footprint", async t => {
  const snapshot = fixtureSnapshot(), bytes = JSON.stringify(snapshot);
  const index = parseEroTargetSnapshot(bytes, sha(bytes));
  assert.equal(index.excludedTargets, 0);
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => { throw new Error("Native runtime must use only locked local metadata"); };
  const layer = (product: string): CoverageCellLayer => ({ layerId: product, productId: product, surveyId: "euclid", releaseId: "euclid-ero", product,
    modality: "imaging", availableOrders: [4], overviewOrder: 4, maxOrder: 4, cellCount: 1, areaDeg2: 1, color: "#ffffff", tileScheme: "ipix-range-4096", cells: new Map() });
  const result = await archiveNativeUnits([layer("ERO VIS"), layer("ERO NISP.H")], 4, [190], {} as ArtifactStore, { eroIndex: index });
  assert.deepEqual(result.units.map(unit => [unit.product, unit.unitId]), [["ERO VIS", "ERO-IC10"]]);
  const unit = result.units[0]!;
  assert.equal(unit.precision, "estimated"); assert.deepEqual(unit.matchingCells, [190]);
  assert.equal(unit.geometryEvidence?.[0]?.filter, "VIS"); assert.equal(unit.sourceSnapshotSha256, sha(bytes));
  assert.equal(unit.accessUri, "https://irsa.ipac.caltech.edu/data/Euclid/ERO/images/IC10/ERO-IC10/");
  assert.equal(unit.accessUris?.[0]?.accessType, "directory");
  assert.equal(unit.accessUris?.[0]?.alternatives?.[0]?.status, "verified");
  const archivePackageUris = unit.sourceMetadata?.archivePackageUris;
  assert.ok(Array.isArray(archivePackageUris));
  assert.equal(archivePackageUris.length, 1);
  assert.match(unit.note!, /valid-pixel masks/i);
  const rows = overlapCsvRows({ id: "C01", order: 4, cells: [190], bounds: { raMin: 0, raMax: 9, decMin: 57.3995, decMax: 63.4483, areaDeg2: 13.4287 } },
    { schemaVersion: 1, files: [], entrypoints: [], warnings: [], truncated: true, spatialUnits: result.units }, () => ({ layerId: "ERO VIS", surveyId: "euclid", releaseId: "euclid-ero", product: "ERO VIS", modality: "imaging" }));
  assert.deepEqual(JSON.parse(rows[0]![OVERLAP_DOWNLOAD_HEADER.indexOf("geometry_evidence")]!), unit.geometryEvidence);
  assert.equal(rows[0]![OVERLAP_DOWNLOAD_HEADER.indexOf("s_region")], unit.sRegion);
});

test("ERO imports require explicit XML package association, every band's own header and bounded range receipts", () => {
  const check = (snapshot: ReturnType<typeof fixtureSnapshot>) => parseEroTargetSnapshot(JSON.stringify(snapshot), "a".repeat(64));
  const missing = fixtureSnapshot(); missing.packageHeaders[1]!.fitsHeaders.pop();
  assert.throws(() => check(missing), /missing its own per-band/);
  const falseLink = fixtureSnapshot(); falseLink.products[0]!.xml = falseLink.products[0]!.xml.replace("cdn.euclid.esac.esa.int", "untrusted.example");
  assert.throws(() => check(falseLink), /capture receipt/);
  const badRange = fixtureSnapshot(); badRange.packageHeaders[0]!.ranges[0]!.sha256 = "0".repeat(64);
  assert.throws(() => check(badRange), /target\/package receipt/);
  const fullPackage = fixtureSnapshot(); fullPackage.packageHeaders[0]!.ranges[0]!.sizeBytes = 100000;
  assert.throws(() => check(fullPackage), /capture receipt/);
});
