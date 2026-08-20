import assert from "node:assert/strict";
import test from "node:test";

import { loadCatalog, publicManifest } from "../server/catalog.js";
import { projectRoot } from "../server/paths.js";

test("release catalog verifies every public file and bundle digest", async () => {
  const catalog = await loadCatalog(projectRoot);
  assert.equal(catalog.manifest.schemaVersion, 1);
  assert.equal(catalog.manifest.statistics.packages, 16);
  assert.equal(catalog.manifest.statistics.rawMocFiles, 38);
  assert.equal(catalog.manifest.statistics.acquired, 32);
  assert.equal(catalog.files.size, catalog.manifest.files.length);
  assert.ok(catalog.manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test("CSST release publishes reviewed MOC, geometry and complete evidence", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const files = catalog.manifest.files.filter((entry) => entry.surveyId === "csst");
  assert.deepEqual(new Set(files.map((entry) => entry.id)), new Set([
    "csst-coverage-job-snapshot", "csst-input-manifest", "csst-provenance", "csst-run-statistics", "csst-sample-report",
    "csst-wcs-geometry-summary", "csst-w1-display-footprint-nside16", "csst-w1-healpix-order8", "csst-w1-image-extent-moc-order8",
    "package-public-csst-footprints-1-0-0",
  ]));
  assert.equal(files.find((entry) => entry.kind === "moc")?.mediaType, "application/fits");
  assert.ok(files.every((entry) => entry.releaseId === "csst-sim-w1-20250731"));
  assert.ok(files.filter((entry) => entry.kind !== "package").every((entry) => entry.product === "W1 simulated wide-field images"));
});

test("public API projection hides filesystem paths and exposes stable downloads", async () => {
  const response = publicManifest(await loadCatalog(projectRoot, false));
  assert.ok(response.files.length > 50);
  assert.ok(response.files.every((entry) => !("path" in entry)));
  assert.ok(response.files.every((entry) => entry.downloadUrl === `/api/v1/assets/${entry.id}/download`));
});

test("current package catalog publishes only referenced release versions", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const packages = catalog.manifest.files.filter((entry) => entry.kind === "package");
  assert.equal(packages.length, 16);
  assert.equal(packages.filter((entry) => entry.version === "2.0.3").length, 12);
  assert.equal(packages.filter((entry) => entry.version === "2.0.4").length, 1);
  assert.equal(packages.filter((entry) => entry.version === "1.0.0").length, 3);
  assert.equal(packages.some((entry) => entry.version === "2.0.0" || entry.version === "2.0.1"), false);
});

test("DESI official tile tables and resource package are downloadable release assets", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const files = catalog.manifest.files.filter((entry) => entry.surveyId === "desi");
  const downloads = new Set(files.map((entry) => entry.downloadName));
  for (const downloadName of [
    "desi-dr1-tiles-iron.fits",
    "desi-edr-tiles-fuji.fits",
    "public-desi-footprints-2.0.3.zip",
    "desi-dr1-spectra-footprint.moc.fits",
    "desi-dr1-spectra-footprint-query-order8.json",
    "desi-dr1-spectra-footprint-preview-order4.json",
    "desi-edr-spectra-footprint.moc.fits",
    "desi-edr-spectra-footprint-query-order8.json",
    "desi-edr-spectra-footprint-preview-order4.json",
  ]) assert.ok(downloads.has(downloadName), `missing DESI release asset: ${downloadName}`);
  assert.ok(files.some((entry) => entry.kind === "geometry" && entry.downloadName === "desi-dr1-tiles-iron.fits" && entry.mediaType === "application/fits"));
  assert.ok(files.some((entry) => entry.kind === "geometry" && entry.downloadName === "desi-edr-tiles-fuji.fits" && entry.mediaType === "application/fits"));
});
