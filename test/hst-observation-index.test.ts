import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { Healpix } from "healpixjs";

import { archiveNativeUnits } from "../server/archive-native-units.js";
import type { CoverageCellLayer } from "../server/coverage.js";
import type { ArtifactStore } from "../server/artifact-store.js";
import { candidateCellsForStcs, cellsForStcs } from "../server/hst-image-lookup.js";
import { buildHstObservationIndex, HstObservationIndex } from "../server/hst-observation-index.js";

const layer = (product: string): CoverageCellLayer => ({
  layerId: `hst-${product.toLowerCase().replaceAll(" ", "-")}`,
  productId: product,
  surveyId: "hst",
  product,
  releaseId: "hst-public-images",
  modality: "imaging",
  color: "#ffffff",
  availableOrders: [8],
  overviewOrder: 8,
  maxOrder: 8,
  cellCount: 1,
  areaDeg2: 1,
  tileScheme: "ipix-range-4096",
  cells: new Map(),
});

test("locked HST metadata snapshot builds a local footprint index used by overlap lookup", async (t) => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "hst-observation-index-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const pixel = 200001;
  const pointing = new Healpix(256).pix2ang(pixel);
  const ra = pointing.phi * 180 / Math.PI;
  const dec = 90 - pointing.theta * 180 / Math.PI;
  const sRegion = `POLYGON ${ra - .01} ${dec - .01} ${ra + .01} ${dec - .01} ${ra + .01} ${dec + .01} ${ra - .01} ${dec + .01}`;
  const exactCoarseCells = cellsForStcs(4, Array.from({ length: 3072 }, (_, cell) => cell), sRegion);
  const candidateCoarseCells = new Set(candidateCellsForStcs(4, sRegion));
  assert.ok(exactCoarseCells.every((cell) => candidateCoarseCells.has(cell)));
  const page = {
    status: "COMPLETE",
    paging: { page: 1, pageSize: 3, pagesFiltered: 1, rows: 3, rowsFiltered: 3, rowsTotal: 3 },
    data: [
      { obsid: 123, obs_collection: "HST", dataproduct_type: "image", dataRights: "PUBLIC", instrument_name: "ACS/WFC", filters: "F814W", target_name: "MVP", t_min: 50000, t_max: 50001, s_region: sRegion },
      { obsid: 123, obs_collection: "HST", dataproduct_type: "image", dataRights: "PUBLIC", instrument_name: "ACS/WFC", filters: "F606W", target_name: "MVP II", t_min: 49999, t_max: 50002, s_region: sRegion },
      { obsid: 124, obs_collection: "HST", dataproduct_type: "image", dataRights: "PUBLIC", instrument_name: "WFC3/IR", filters: "F160W", s_region: "UNION ICRS" },
    ],
  };
  const pagePath = "source-units/hst-public-image-pages/page-000001.json.gz";
  const pageBytes = gzipSync(Buffer.from(JSON.stringify(page)));
  await mkdir(path.dirname(path.join(evidenceRoot, pagePath)), { recursive: true });
  await writeFile(path.join(evidenceRoot, pagePath), pageBytes);
  const manifest = {
    schemaVersion: 1,
    kind: "mast-hst-public-image-observations",
    sourceUrl: "https://mast.stsci.edu/api/v0/invoke",
    service: "Mast.Caom.Filtered",
    capturedAt: "2026-10-01T00:00:00.000Z",
    pageSize: 3,
    pageCount: 1,
    rowCount: 3,
    rowsTotal: 3,
    pages: [{ page: 1, path: pagePath, sha256: createHash("sha256").update(pageBytes).digest("hex"), sizeBytes: pageBytes.length, rows: 3 }],
  };
  const manifestPath = path.join(evidenceRoot, "source-units/hst-public-image-pages/manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");

  const index = await buildHstObservationIndex(evidenceRoot, manifestPath, manifestSha);
  assert.equal(index.summary.sourceSnapshotSha256, manifestSha);
  assert.equal(index.summary.rowCount, 3);
  assert.equal(index.summary.indexedRows, 2, JSON.stringify(index.summary));
  assert.equal(index.summary.observationCount, 1);
  assert.equal(index.summary.excludedRows, 1);
  assert.equal(index.summary.duplicateRows, 1);
  const lookup = index.lookup(8, [pixel]);
  assert.deepEqual(lookup.observations.map(({ obsid }) => obsid), ["123"]);
  assert.equal(lookup.queryExhausted, true);
  assert.equal(lookup.truncated, true);
  assert.equal(lookup.observations[0]!.filters, "F606W, F814W");
  assert.equal(lookup.observations[0]!.startTime, 49999);
  assert.equal(lookup.observations[0]!.endTime, 50002);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("HST overlap lookup must not call MAST"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const store = { putImmutable: async () => { throw new Error("HST lookup must not write per-query MAST evidence"); } } as unknown as ArtifactStore;
  const result = await archiveNativeUnits([layer("HST ACS archive coverage")], 8, [pixel], store, { hstIndex: index });
  assert.equal(result.truncated, true);
  assert.equal(result.unavailableLayerIds.length, 0);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0]!.unitId, "123");
  assert.equal(result.units[0]!.instrument, "ACS/WFC");
  assert.equal(result.units[0]!.filters, "F606W, F814W");
  assert.equal(result.units[0]!.sourceSnapshotSha256, manifestSha);
  const missingIndex = await archiveNativeUnits([layer("HST ACS archive coverage")], 8, [pixel], store);
  assert.deepEqual(missingIndex.unavailableLayerIds, [layer("HST ACS archive coverage").layerId]);
  assert.match(missingIndex.notes.join(" "), /local HST observation index is unavailable/);
  index.close();
});

test("complex HST footprints use conservative coarse candidates", () => {
  const pixel = 200001;
  const pointing = new Healpix(256).pix2ang(pixel);
  const centerRa = pointing.phi * 180 / Math.PI;
  const centerDec = 90 - pointing.theta * 180 / Math.PI;
  const decRadians = centerDec * Math.PI / 180;
  const radiusDeg = 0.04;
  const vertices = Array.from({ length: 14 }, (_, index) => {
    const angle = 2 * Math.PI * index / 14;
    const ra = (centerRa + radiusDeg * Math.cos(angle) / Math.max(0.1, Math.cos(decRadians)) + 360) % 360;
    const dec = centerDec + radiusDeg * Math.sin(angle);
    return `${ra} ${dec}`;
  });
  const sRegion = `POLYGON ${[...vertices, vertices[0]].join(" ")}`;
  const allCoarseCells = Array.from({ length: 3072 }, (_, cell) => cell);
  const candidates = new Set(candidateCellsForStcs(4, sRegion));
  const matching = cellsForStcs(4, allCoarseCells, sRegion);
  const coarsePixel = Math.floor(pixel / 4 ** 4);

  assert.ok(matching.includes(coarsePixel));
  assert.ok(matching.every((cell) => candidates.has(cell)));
});

test("multi-corner HST footprints avoid pathological polygon rasterization", () => {
  const sRegion = "POLYGON 275.2020946565124 -16.117225698475448 275.1541741538782 -16.172156796594184 275.1265468927975 -16.150775418624786 275.17621271935 -16.093463733090687 275.2019461517607 -16.114340082040858 275.22634094615506 -16.086407347468338 275.2532285874187 -16.108417352187676 275.2281675309826 -16.137350763053217 275.2020946565124 -16.117225698475448";
  const allCoarseCells = Array.from({ length: 3072 }, (_, cell) => cell);
  const candidates = new Set(candidateCellsForStcs(4, sRegion));
  const matching = cellsForStcs(4, allCoarseCells, sRegion);

  assert.ok(matching.length > 0);
  assert.ok(matching.every((cell) => candidates.has(cell)));
});

test("multipart HST footprints trigger conservative indexing across the complete region", () => {
  const center = new Healpix(256).pix2ang(200001);
  const centerRa = center.phi * 180 / Math.PI;
  const centerDec = 90 - center.theta * 180 / Math.PI;
  const polygons = Array.from({ length: 24 }, (_, index) => {
    const offset = index * 0.001;
    const coordinates = [
      `${centerRa + offset - 0.002} ${centerDec - 0.002}`,
      `${centerRa + offset + 0.002} ${centerDec - 0.002}`,
      `${centerRa + offset + 0.002} ${centerDec + 0.002}`,
      `${centerRa + offset - 0.002} ${centerDec + 0.002}`,
    ];
    return `POLYGON ${[...coordinates, coordinates[0]].join(" ")}`;
  });
  const sRegion = polygons.join(" ");
  const allCoarseCells = Array.from({ length: 3072 }, (_, cell) => cell);
  const candidates = new Set(candidateCellsForStcs(4, sRegion));
  const matching = cellsForStcs(4, allCoarseCells, sRegion);

  assert.ok(matching.length > 0);
  assert.ok(matching.every((cell) => candidates.has(cell)));
});

test("degenerate CAOM polygon parts are rejected as unsupported geometry", () => {
  const sRegion = "POLYGON 64.89785252637786 29.167193784588 64.86140914086259 29.16364345361216 64.89785252637786 29.167193784588";
  assert.deepEqual(candidateCellsForStcs(4, sRegion), []);
  assert.deepEqual(cellsForStcs(4, [1400], sRegion), []);
});

test("degenerate polygon parts do not discard valid parts of a compound footprint", () => {
  const valid = "POLYGON ICRS 64.89 29.16 64.91 29.16 64.91 29.18 64.89 29.18";
  const degenerate = "POLYGON ICRS 10 20 10 20 10 20";
  assert.ok(candidateCellsForStcs(4, `${degenerate} ${valid}`).length > 0);
});

test("STC-S tokenizer accepts a numeric coordinate immediately followed by a new primitive", () => {
  const first = "POLYGON ICRS 64.89 29.16 64.91 29.16 64.91 29.18 64.89 29.18";
  const second = "POLYGON ICRS 120 10 120.02 10 120.02 10.02 120 10.02";
  const glued = first + second;
  assert.match(glued, /29\.18POLYGON/);
  const allCells = Array.from({ length: 3072 }, (_, cell) => cell);
  const matched = cellsForStcs(4, allCells, glued);
  const candidates = candidateCellsForStcs(4, glued);
  const secondCandidates = candidateCellsForStcs(4, second);
  assert.ok(matched.length > 0);
  assert.ok(secondCandidates.some((cell) => candidates.includes(cell)));
  assert.ok(matched.every((cell) => candidates.includes(cell)));
});

test("large CAOM polygons above the former 32 KiB limit remain locally matchable", () => {
  const center = new Healpix(256).pix2ang(200001);
  const centerRa = center.phi * 180 / Math.PI;
  const centerDec = 90 - center.theta * 180 / Math.PI;
  const coordinates = Array.from({ length: 900 }, (_, index) => {
    const angle = 2 * Math.PI * index / 900;
    return `${(centerRa + 0.1 * Math.cos(angle)).toFixed(18)} ${(centerDec + 0.1 * Math.sin(angle)).toFixed(18)}`;
  });
  const sRegion = `POLYGON ICRS ${coordinates.join(" ")}`;
  assert.ok(sRegion.length > 32_768);
  assert.ok(candidateCellsForStcs(4, sRegion).length > 0);
});

test("unknown CAOM coordinate frames are not reinterpreted as ICRS", () => {
  assert.deepEqual(candidateCellsForStcs(4, "CIRCLE GSC1 64.9 29.17 0.01"), []);
  assert.deepEqual(candidateCellsForStcs(4, "CIRCLE OTHER 64.9 29.17 0.01"), []);
});

test("HST index refuses an incomplete or tampered page snapshot", async (t) => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "hst-observation-index-invalid-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const pagePath = "source-units/hst-public-image-pages/page-000001.json.gz";
  await mkdir(path.dirname(path.join(evidenceRoot, pagePath)), { recursive: true });
  const pageBytes = gzipSync(Buffer.from(JSON.stringify({ status: "COMPLETE", paging: { page: 1, pageSize: 1, pagesFiltered: 2, rows: 1, rowsFiltered: 2 }, data: [] })));
  await writeFile(path.join(evidenceRoot, pagePath), pageBytes);
  const manifestPath = path.join(evidenceRoot, "source-units/hst-public-image-pages/manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: "mast-hst-public-image-observations",
    sourceUrl: "https://mast.stsci.edu/api/v0/invoke",
    service: "Mast.Caom.Filtered",
    capturedAt: "2026-10-01T00:00:00.000Z",
    pageSize: 1,
    pageCount: 2,
    rowCount: 2,
    pages: [{ page: 1, path: pagePath, sha256: createHash("sha256").update(pageBytes).digest("hex"), sizeBytes: pageBytes.length, rows: 1 }],
  })}\n`);
  await writeFile(manifestPath, manifestBytes);
  const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
  await assert.rejects(() => buildHstObservationIndex(evidenceRoot, manifestPath, manifestSha), /snapshot manifest|snapshot page count|pagination/);

  const altered = Buffer.concat([manifestBytes, Buffer.from(" ")]);
  await writeFile(manifestPath, altered);
  await assert.rejects(() => HstObservationIndex.open(path.join(evidenceRoot, "missing.sqlite"), manifestSha), /unable to open|not found|cannot open/i);
  assert.notEqual(createHash("sha256").update(await readFile(manifestPath)).digest("hex"), manifestSha);
});
