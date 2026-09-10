import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCatalog, publicManifest } from "../server/catalog.js";
import { readZipEntry } from "../server/resource-package-inspection.js";
import { projectRoot } from "../server/paths.js";

test("release catalog verifies every public file and bundle digest", async () => {
  const catalog = await loadCatalog(projectRoot);
  assert.equal(catalog.manifest.schemaVersion, 1);
  assert.equal(catalog.manifest.statistics.packages, 29);
  assert.equal(catalog.manifest.statistics.rawMocFiles, 80);
  assert.equal(catalog.manifest.statistics.footprints, 116);
  assert.equal(catalog.manifest.statistics.acquired, 107);
  assert.equal(catalog.manifest.statistics.releases, 67);
  assert.equal(catalog.manifest.statistics.products, 159);
  // Fresh checkouts (CI) tolerate absent gitignored generated files; every
  // present file is still hash-verified, only the exact-count claim depends
  // on the complete worktree.
  if (process.env.ASSETS_TOLERATE_MISSING_RELEASE_FILES === "1") {
    assert.ok(catalog.files.size > 0 && catalog.files.size <= catalog.manifest.files.length);
  } else {
    assert.equal(catalog.files.size, catalog.manifest.files.length);
  }
  assert.ok(catalog.manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test("release catalog labels projections with their locked order", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  for (const order of [5, 7]) {
    const entries = catalog.manifest.files.filter((entry) => entry.kind === "geometry" && entry.path.endsWith(`/query-order${order}.json`));
    assert.ok(entries.length > 0, `missing order-${order} query projections`);
    for (const entry of entries) {
      assert.match(entry.id, new RegExp(`-query-order${order}$`));
      assert.match(entry.label, new RegExp(`order-${order} query projection`));
      assert.match(entry.downloadName, new RegExp(`query-order${order}\\.json$`));
    }
  }
});

test("publication policy keeps sensitive CSST surveys off the public release", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const files = catalog.manifest.files;
  assert.equal(files.filter((entry) => entry.surveyId === "csst").length, 0);
  const ids = new Set(files.map((entry) => entry.id));
  for (const id of [
    "csst-w1-display-footprint-nside16", "csst-w1-healpix-order8", "csst-w1-image-extent-moc-order8",
    "package-public-csst-footprints-3-0-0",
  ]) assert.equal(ids.has(id), false, `sensitive survey asset must stay off the public release: ${id}`);
  for (const band of ["w2", "w3", "w4"]) {
    for (const suffix of ["moc", "preview-order4", "query-order8", "statistics", "coverage-job-snapshot", "normalized-scan", "provenance", "run-statistics", "sample-report"]) {
      assert.equal(ids.has(`csst-${band}-${suffix}`) || ids.has(`layer-csst-sim-${band}-image-extent-${suffix}`), false, `sensitive survey asset must stay off the public release: csst-${band}-${suffix}`);
    }
  }
  assert.ok(files.every((entry) => !/(^|-)csst(-|$)/.test(entry.id)), "no CSST-flavoured record ids may remain");
  assert.ok(files.every((entry) => !/(^|\/)csst(\/|-)/.test(entry.path)), "no CSST paths may remain in the release tree");
  assert.ok(files.every((entry) => !/csst/i.test(entry.downloadName)), "no CSST downloads may remain");
  assert.ok(files.every((entry) => entry.kind !== "moc" || entry.mediaType === "application/fits"));
});

test("release history ships as a public manifest record without sensitive packages", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const history = catalog.manifest.files.find((entry) => entry.id === "metadata-release-history");
  assert.ok(history, "release-history.json must be a public manifest record");
  assert.match(history.path, /release-history\.json$/);
  const document = JSON.parse(await readFile(path.join(projectRoot, history.path), "utf8")) as {
    schemaVersion: number;
    latestReleaseId: string;
    releases: Array<{
      releaseId: string;
      sequence: number;
      bundleId: string;
      releasedAt: string;
      collection?: { fileName: string; sizeBytes: number; sha256: string; downloadUrl: string };
      packages: Array<{
        id: string;
        version: string;
        downloadUrl: string;
        survey?: { id: string; displayName: string };
        modalities?: string[];
        releases?: Array<{ id: string; label: string; layerCount: number }>;
      }>;
    }>;
  };
  assert.equal(document.schemaVersion, 2);
  assert.ok(document.latestReleaseId);
  assert.equal(document.releases.length, 2);
  const [priorRelease, release] = document.releases;
  assert.ok(priorRelease && priorRelease.sequence < release!.sequence, "history must keep earlier releases cumulative");
  assert.equal(priorRelease!.packages.length, 14);
  assert.equal(release!.sequence, 2);
  assert.ok(release!.releaseId.endsWith("-2"));
  assert.equal(document.latestReleaseId, release!.releaseId);
  assert.equal(release!.bundleId, catalog.manifest.bundle.id);
  assert.equal(release!.packages.length, 29);
  assert.ok(release!.packages.every((entry) => !/csst/.test(entry.id)));
  assert.ok(release!.packages.every((entry) => entry.downloadUrl === `/api/v1/resource-packages/${entry.id}/versions/${entry.version}/download`));

  const collection = release!.collection;
  assert.ok(collection, "history entry must carry the collection archive");
  assert.match(collection.fileName, /-resource-packages\.zip$/);
  assert.equal(collection.downloadUrl, `/api/v1/releases/${release!.releaseId}/download`);
  const collectionRecords = catalog.manifest.files.filter((entry) => entry.kind === "package-collection");
  assert.equal(collectionRecords.length, 2, "every published collection archive stays downloadable");
  const collectionRecord = collectionRecords.find((entry) => entry.path.endsWith(collection.fileName));
  assert.ok(collectionRecord, "collection ZIP must be a public manifest record");
  assert.equal(collectionRecord.sizeBytes, collection.sizeBytes);
  assert.equal(collectionRecord.sha256, collection.sha256);

  const desi = release!.packages.find((entry) => entry.id === "public-desi-footprints");
  assert.ok(desi?.survey, "packages must carry survey projections");
  assert.ok(desi.survey!.displayName.length > 0);
  assert.ok((desi.modalities ?? []).length > 0, "survey modalities are the union of release modalities");
  const releaseIds = (desi.releases ?? []).map((entry) => entry.id);
  assert.ok(releaseIds.includes("desi-dr1"));
  assert.ok((desi.releases ?? []).every((entry) => entry.layerCount >= 1 && entry.label.length > 0));
});

test("public release manifest and API projection expose no evidence records", async () => {
  const catalog = await loadCatalog(projectRoot);
  assert.equal(catalog.manifest.files.filter((entry) => entry.deliveryClass === "evidence").length, 0);
  const projection = publicManifest(catalog);
  if (process.env.ASSETS_TOLERATE_MISSING_RELEASE_FILES === "1") {
    assert.ok(projection.files.length > 0 && projection.files.length <= catalog.manifest.files.length);
  } else {
    assert.equal(projection.files.length, catalog.manifest.files.length);
  }
  assert.equal(projection.statistics.evidenceBytes, 0);
  assert.ok(projection.files.every((entry) => entry.deliveryClass === "runtime"));
  assert.ok(projection.files.every((entry) => !/\/(raw|csst-evidence)\//.test(entry.downloadUrl)));
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

test("package records keep current and superseded versions cumulative", async () => {
  const catalog = await loadCatalog(projectRoot, false);
  const packages = catalog.manifest.files.filter((entry) => entry.kind === "package");
  assert.equal(packages.length, 34);
  assert.equal(packages.filter((entry) => /superseded/.test(entry.label)).length, 5);
  assert.ok(packages.every((entry) => /^3\.\d+\.\d+$/.test(entry.version ?? "")));
  assert.ok(packages.every((entry) => entry.downloadName?.endsWith(`-${entry.version}.zip`) ?? false));
  assert.equal(new Set(packages.map((entry) => entry.id)).size, packages.length);
  const bumped = packages.find((entry) => entry.id === "package-public-sdss-footprints-3-1-0");
  const superseded = packages.find((entry) => entry.id === "package-public-sdss-footprints-3-0-0");
  assert.ok(bumped && superseded, "changed packages get a new version while the old one stays downloadable");
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
  assert.match(html, /editorial-dialog/);
  assert.match(html, /editorial-diff-dialog/);
  assert.match(html, /editorial-canvas/);
  assert.match(html, /editorial-diff-confirm/);
  assert.match(await (await import("node:fs/promises")).readFile("site/admin/main.ts", "utf8"), /CircleDot/);
});

test("admin survey colors use CSP-safe data attributes", async () => {
  const [main, styles] = await Promise.all([
    (await import("node:fs/promises")).readFile("site/admin/main.ts", "utf8"),
    (await import("node:fs/promises")).readFile("site/admin/styles.css", "utf8"),
  ]);
  assert.doesNotMatch(main, /style=["']--survey-color/);
  assert.match(main, /data-survey-color/);
  assert.match(styles, /\.review-survey-swatch\[data-survey-color\][^}]*attr\(data-survey-color type\(<color>\)/);
  assert.match(styles, /\.editorial-survey-swatch\[data-survey-color\][^}]*attr\(data-survey-color type\(<color>\)/);
});

test("admin light theme keeps form controls readable", async () => {
  const [html, styles] = await Promise.all([
    (await import("node:fs/promises")).readFile("site/admin/index.html", "utf8"),
    (await import("node:fs/promises")).readFile("site/admin/styles.css", "utf8"),
  ]);
  assert.match(html, /id="admin-token"[^>]*type="password"/);
  assert.match(html, /<form id="product-form"[\s\S]*<textarea name="methodologyMarkdown"/);
  assert.match(styles, /:root\[data-theme="light"\]\s+input,\s*:root\[data-theme="light"\]\s+select,\s*:root\[data-theme="light"\]\s+textarea\s*\{[^}]*background:\s*var\(--bright\);[^}]*color:\s*var\(--ink\);/s);
  assert.match(styles, /:root\[data-theme="light"\]\s+input::placeholder,\s*:root\[data-theme="light"\]\s+textarea::placeholder\s*\{[^}]*color:\s*var\(--muted\);/s);
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

test("every public package declares access modes and release-aligned coverage sources", async () => {
  type CatalogSource = { releaseId: string; label: string; url: string; authority: string };
  type CatalogEntry = {
    id: string;
    version: string;
    releases: string[];
    accessModes: string[];
    sources: CatalogSource[];
  };
  const document = JSON.parse(
    await readFile(path.join(projectRoot, "artifacts/public-survey-footprints/packages/catalog.json"), "utf8"),
  ) as { schemaVersion: number; packages: CatalogEntry[] };
  assert.equal(document.schemaVersion, 3);
  const publicEntries = document.packages.filter((entry) => !/csst/.test(entry.id));
  assert.equal(publicEntries.length, 29);
  for (const entry of publicEntries) {
    assert.ok(entry.releases.length > 0, `${entry.id} must declare releases`);
    assert.ok(entry.accessModes.length > 0, `${entry.id} must declare non-empty accessModes`);
    assert.ok(entry.sources.length > 0, `${entry.id} must declare non-empty sources`);
    const releaseSet = new Set(entry.releases);
    const sourceReleaseIds = new Set(entry.sources.map((source) => source.releaseId));
    assert.equal(sourceReleaseIds.size, entry.releases.length, `${entry.id} sources must cover every release exactly once`);
    for (const releaseId of releaseSet) {
      assert.ok(sourceReleaseIds.has(releaseId), `${entry.id} sources must reference declared release ${releaseId}`);
    }
    for (const source of entry.sources) {
      assert.ok(source.label.length > 0 && source.authority.length > 0, `${entry.id} sources must carry label and authority`);
      assert.match(source.url, /^https?:\/\//, `${entry.id} source url must be public`);
    }
    assert.ok(entry.accessModes.includes("Resource Package v3"), `${entry.id} accessModes must include the package channel`);
  }
  const twomass = publicEntries.find((entry) => entry.id === "public-2mass-footprints");
  assert.ok(twomass);
  assert.deepEqual(twomass.releases, ["2mass-6x"]);
  assert.equal(twomass.sources[0]?.releaseId, "2mass-6x", "2MASS sources must follow the current release, not the retired all-sky release");
});

test("latest release history carries access metadata and the collection embeds the same catalog", async () => {
  const historyPath = path.join(projectRoot, "artifacts/public-survey-footprints/release-history.json");
  const document = JSON.parse(await readFile(historyPath, "utf8")) as {
    releases: Array<{
      releaseId: string;
      catalogSha256?: string;
      collection?: { fileName: string; sha256: string };
      packages: Array<{ id: string; accessModes?: string[]; sources?: Array<{ releaseId: string; url: string }> }>;
    }>;
  };
  const latest = document.releases.at(-1)!;
  assert.ok(latest.catalogSha256, "history entries must fingerprint the embedded catalog");
  for (const pkg of latest.packages) {
    assert.ok((pkg.accessModes ?? []).length > 0, `${pkg.id} in history must carry accessModes`);
    assert.ok((pkg.sources ?? []).length > 0, `${pkg.id} in history must carry sources`);
    for (const source of pkg.sources ?? []) assert.match(source.url, /^https?:\/\//);
  }
  const twomass = latest.packages.find((pkg) => pkg.id === "public-2mass-footprints");
  assert.equal(twomass?.sources?.[0]?.releaseId, "2mass-6x");

  const collectionPath = path.join(projectRoot, "artifacts/public-survey-footprints/collections", latest.collection!.fileName);
  const embedded = JSON.parse(
    (await readZipEntry(await readFile(collectionPath), "catalog.json")).toString("utf8"),
  ) as { packages: Array<{ id: string; accessModes: string[]; sources: Array<{ releaseId: string }> }> };
  assert.equal(embedded.packages.length, 29);
  assert.ok(embedded.packages.every((entry) => !/csst/.test(entry.id)));
  for (const entry of embedded.packages) {
    assert.ok(entry.accessModes.length > 0, `${entry.id} embedded catalog must keep accessModes`);
    const releaseSet = new Set(latest.packages.find((pkg) => pkg.id === entry.id)?.sources?.map((source) => source.releaseId) ?? []);
    for (const source of entry.sources) assert.ok(releaseSet.has(source.releaseId), `${entry.id} embedded sources must match history`);
  }
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
