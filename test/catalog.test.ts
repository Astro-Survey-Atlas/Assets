import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCatalog, publicManifest } from "../server/catalog.js";
import { projectRoot } from "../server/paths.js";

test("release catalog verifies every public file and bundle digest", async () => {
  const catalog = await loadCatalog(projectRoot);
  assert.equal(catalog.manifest.schemaVersion, 1);
  assert.equal(catalog.manifest.statistics.packages, 15);
  assert.equal(catalog.manifest.statistics.rawMocFiles, 50);
  assert.equal(catalog.manifest.statistics.acquired, 39);
  assert.equal(catalog.files.size, catalog.manifest.files.length);
  assert.ok(catalog.manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test("CSST release publishes reviewed MOC, geometry and complete evidence", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const files = catalog.manifest.files.filter((entry) => entry.surveyId === "csst");
  const ids = new Set(files.map((entry) => entry.id));
  for (const id of [
    "csst-coverage-job-snapshot", "csst-provenance", "csst-run-statistics", "csst-sample-report",
    "csst-wcs-geometry-summary", "csst-w1-display-footprint-nside16", "csst-w1-healpix-order8", "csst-w1-image-extent-moc-order8",
    "package-public-csst-footprints-3-0-0",
  ]) assert.ok(ids.has(id), `missing CSST release asset: ${id}`);
  assert.equal(ids.has("csst-input-manifest"), false, "the 205 MB input manifest belongs on evidence storage, not the public release allowlist");
  for (const band of ["w2", "w3", "w4"]) for (const suffix of [
    "coverage-job-snapshot", "layer-provenance", "moc", "normalized-scan", "preview-order4", "provenance", "query-order8", "run-statistics", "sample-report", "statistics",
  ]) assert.ok(ids.has(`csst-${band}-${suffix}`) || ids.has(`layer-csst-sim-${band}-image-extent-${suffix}`), `missing CSST ${band.toUpperCase()} release asset: ${suffix}`);
  assert.ok(files.filter((entry) => entry.kind === "moc").length >= 4);
  assert.ok(files.filter((entry) => entry.kind === "moc").every((entry) => entry.mediaType === "application/fits"));
  for (const band of ["w2", "w3", "w4"]) {
    const releaseId = `csst-sim-${band}-20250731`;
    assert.ok(files.some((entry) => entry.releaseId === releaseId && entry.kind === "moc"), `missing ${band.toUpperCase()} MOC`);
    assert.ok(files.filter((entry) => entry.releaseId === releaseId && entry.kind !== "package").every((entry) => entry.product === `${band.toUpperCase()} simulated wide-field images`));
  }
});

test("public API projection hides filesystem paths and exposes stable downloads", async () => {
  const response = publicManifest(await loadCatalog(projectRoot, false));
  assert.ok(response.files.length > 50);
  assert.ok(response.files.every((entry) => !("path" in entry)));
  assert.ok(response.files.every((entry) => entry.downloadUrl === `/api/v1/assets/${entry.id}/download`));
});

test("release catalog rejects evidence records misclassified as runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-catalog-boundary-"));
  try {
    const file = {
      id: "input-manifest",
      kind: "manifest",
      label: "Input manifest",
      description: "evidence",
      path: "evidence/input-manifest.json",
      downloadName: "input-manifest.json",
      mediaType: "application/json",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      deliveryClass: "runtime",
    };
    const bundleSha256 = createHash("sha256").update(JSON.stringify([{ id: file.id, path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 }])).digest("hex");
    const manifest = { schemaVersion: 1, generatedAt: "2026-08-31T00:00:00Z", bundle: { id: "boundary", sha256: bundleSha256 }, files: [file] };
    const manifestPath = path.join(root, "artifacts", "public-survey-footprints");
    await mkdir(manifestPath, { recursive: true });
    await writeFile(path.join(manifestPath, "release-manifest.json"), `${JSON.stringify(manifest)}\n`);
    await assert.rejects(() => loadCatalog(root, false), /Evidence asset cannot be marked runtime/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current package catalog publishes only referenced release versions", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const packages = catalog.manifest.files.filter((entry) => entry.kind === "package");
  assert.equal(packages.length, 15);
  assert.equal(packages.filter((entry) => entry.version === "3.0.0").length, 15);
  assert.equal(packages.some((entry) => entry.version !== "3.0.0"), false);
});

test("DESI official tile tables and resource package are downloadable release assets", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const files = catalog.manifest.files.filter((entry) => entry.surveyId === "desi");
  const downloads = new Set(files.map((entry) => entry.downloadName));
  for (const downloadName of [
    "desi-dr1-tiles-iron.fits",
    "desi-edr-tiles-fuji.fits",
    "public-desi-footprints-3.0.0.zip",
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

test("admin page is included as a separate deployable entry point", async () => {
  const html = await (await import("node:fs/promises")).readFile("site/admin/index.html", "utf8");
  assert.match(html, /ScanRequest/);
  assert.match(html, /\/admin\/main\.ts/);
  assert.match(html, /product-dialog-publish/);
});

test("cross-step MOC registration dialog is not nested in a hidden admin panel", async () => {
  const html = await (await import("node:fs/promises")).readFile("site/admin/index.html", "utf8");
  const stack: string[] = [];
  let ancestors: string[] | undefined;
  const tokens = /<\/?(main|section|div|dialog)\b[^>]*>/gi;
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    const id = token.match(/\bid="([^"]+)"/i)?.[1];
    if (id === "moc-product-register-dialog") ancestors = [...stack];
    stack.push(id ?? "");
  }
  assert.ok(ancestors, "registration dialog markup should be present");
  assert.equal(ancestors!.includes("admin-step-review"), false, "registration dialog must not inherit the hidden review panel");
});

test("organization and SDK pages expose the shared Core repository", async () => {
  const fs = await import("node:fs/promises");
  const github = await fs.readFile("site/github/index.html", "utf8");
  const sdk = await fs.readFile("site/sdk/index.html", "utf8");
  assert.match(github, /Astro-Survey-Atlas\/MOC-Core-SDK/);
  assert.match(github, /MOC-CORE-SDK/);
  assert.match(sdk, /Astro-Survey-Atlas\/MOC-Core-SDK/);
  assert.doesNotMatch(sdk, /No fourth SDK repository yet/);
});
