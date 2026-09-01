import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import test from "node:test";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate test port"));
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming ready: ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch { /* retry while the catalog is verified */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become ready");
}

test("HTTP service exposes metadata and range-enabled allowlisted downloads", async (context) => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site/public") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);

  for (const [font, mediaType] of [["NotoSans-Regular.ttf", "font/ttf"], ["NotoSansSC-Regular.woff2", "font/woff2"]] as const) {
    const fontResponse = await fetch(`http://127.0.0.1:${port}/fonts/${font}`);
    assert.equal(fontResponse.status, 200);
    assert.equal(fontResponse.headers.get("content-type"), mediaType);
  }

  const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/v1/assets`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json() as { files: Array<{ id: string; mediaType: string; sizeBytes: number; sha256: string; downloadUrl: string; previewUrl?: string; previewMode?: "text" | "image" }> };
  const provenance = catalog.files.find((entry) => entry.id === "provenance-release");
  assert.ok(provenance);
  assert.ok(provenance.previewUrl?.endsWith("/preview"));

  const range = await fetch(`http://127.0.0.1:${port}${provenance.downloadUrl}`, { headers: { Range: "bytes=0-31" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-length"), "32");
  assert.equal(range.headers.get("x-content-sha256"), provenance.sha256);
  assert.match(range.headers.get("content-disposition") ?? "", /provenance\.json/);
  assert.equal((await range.arrayBuffer()).byteLength, 32);

  const preview = await fetch(`http://127.0.0.1:${port}${provenance.previewUrl}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-disposition"), "inline");
  assert.match(await preview.text(), /generatedAt/);
  assert.equal(preview.headers.get("x-content-sha256"), provenance.sha256);

  const packageCatalogResponse = await fetch(`http://127.0.0.1:${port}/api/v1/resource-packages/catalog.json`);
  assert.equal(packageCatalogResponse.status, 200);
  const packageCatalog = await packageCatalogResponse.json() as { schemaVersion: number; version: string; packages: Array<{ id: string; archiveUrl: string; sizeBytes: number; sha256: string }> };
  assert.equal(packageCatalog.schemaVersion, 3);
  assert.equal(packageCatalog.version, "3.0.0");
  assert.ok(packageCatalog.packages.length > 0);
  assert.ok(packageCatalog.packages.every((entry) => entry.archiveUrl.startsWith("/api/v1/assets/")));
  const packageArchive = await fetch(`http://127.0.0.1:${port}${packageCatalog.packages[0]!.archiveUrl}`, { headers: { Range: "bytes=0-7" } });
  assert.equal(packageArchive.status, 206);
  assert.equal(packageArchive.headers.get("x-content-sha256"), packageCatalog.packages[0]!.sha256);
  assert.equal((await packageArchive.arrayBuffer()).byteLength, 8);
  const completePackageArchive = await fetch(`http://127.0.0.1:${port}${packageCatalog.packages[0]!.archiveUrl}`);
  assert.equal(completePackageArchive.status, 200);
  const completePackageBytes = new Uint8Array(await completePackageArchive.arrayBuffer());
  assert.equal(completePackageArchive.headers.get("content-length"), String(packageCatalog.packages[0]!.sizeBytes));
  assert.equal(completePackageBytes.byteLength, packageCatalog.packages[0]!.sizeBytes);
  assert.equal(sha256(completePackageBytes), packageCatalog.packages[0]!.sha256);

  const zip = catalog.files.find((entry) => entry.id.startsWith("package-"));
  assert.ok(zip);
  assert.ok(zip.previewUrl?.endsWith("/preview"));
  assert.equal(zip.previewMode, "text");
  const zipPreview = await fetch(`http://127.0.0.1:${port}/api/v1/assets/${zip.id}/preview`);
  assert.equal(zipPreview.status, 200);
  assert.equal(zipPreview.headers.get("content-disposition"), "inline");
  assert.match(zipPreview.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(await zipPreview.text(), /ZIP archive preview/);
  assert.equal(zipPreview.headers.get("x-content-sha256"), zip.sha256);

  const fits = catalog.files.find((entry) => entry.mediaType === "application/fits");
  assert.ok(fits);
  assert.ok(fits.previewUrl?.endsWith("/preview"));
  assert.equal(fits.previewMode, "text");
  const fitsPreview = await fetch(`http://127.0.0.1:${port}${fits.previewUrl}`);
  assert.equal(fitsPreview.status, 200);
  assert.match(fitsPreview.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(await fitsPreview.text(), /\[HDU 0: PRIMARY\][\s\S]*SIMPLE/);
  assert.equal(fitsPreview.headers.get("x-content-sha256"), fits.sha256);
  assert.ok(catalog.files.every((entry) => entry.previewUrl));

  const coverageResponse = await fetch(`http://127.0.0.1:${port}/api/v1/coverage`);
  assert.equal(coverageResponse.status, 200);
  const coverage = await coverageResponse.json() as { coordinateFrame: string; nside: number; footprints: Array<{ surveyId: string; pixels: number[] }> };
  assert.equal(coverage.coordinateFrame, "ICRS");
  assert.equal(coverage.nside, 16);
  assert.ok(coverage.footprints.length > 20);
  assert.ok(coverage.footprints.every((footprint) => footprint.pixels.length > 0));
  assert.equal(coverage.footprints.find((footprint) => footprint.surveyId === "csst")?.pixels.length, 46);

  const coverageCatalogResponse = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/catalog`);
  assert.equal(coverageCatalogResponse.status, 200);
  const catalogEtag = coverageCatalogResponse.headers.get("etag");
  assert.match(catalogEtag ?? "", /^"catalog-[a-f0-9]{32}"$/);
  const coverageCatalog = await coverageCatalogResponse.json() as { revision: string; ordering: string; layers: Array<{ layerId: string; surveyId: string; availableOrders: number[]; tileIdsByOrder: Record<string, number[]>; revision?: string; recipe?: { mode: string; steps: any[] }; sourceUnitIndex?: { status: string; unitKind?: string } }> };
  assert.match(coverageCatalog.revision, /^[a-f0-9]{32}$/);
  const notModifiedCatalog = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/catalog`, { headers: { "If-None-Match": catalogEtag! } });
  assert.equal(notModifiedCatalog.status, 304);
  assert.equal(coverageCatalog.ordering, "NESTED");
  assert.ok(coverageCatalog.layers.every((layer) => layer.availableOrders.every((order) => Array.isArray(layer.tileIdsByOrder[String(order)]))));
  const desiLayer = coverageCatalog.layers.find((layer) => layer.layerId === "desi-dr1-spectra-footprint");
  assert.equal(desiLayer?.recipe?.mode, "tile-table");
  assert.match(desiLayer?.revision ?? "", /^[a-f0-9]{32}$/);
  const desiOrder = desiLayer?.availableOrders[0];
  const desiTile = desiOrder === undefined ? undefined : desiLayer?.tileIdsByOrder[String(desiOrder)]?.[0];
  assert.notEqual(desiTile, undefined);
  const block = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/blocks/${desiLayer!.layerId}?order=${desiOrder}&tile=${desiTile}&revision=${desiLayer!.revision}`);
  assert.equal(block.status, 200);
  const blockBody = await block.json() as { revision: string; cells: number[] };
  assert.equal(blockBody.revision, desiLayer!.revision);
  assert.ok(Array.isArray(blockBody.cells));
  const staleBlock = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/blocks/${desiLayer!.layerId}?order=${desiOrder}&tile=${desiTile}&revision=stale`);
  assert.equal(staleBlock.status, 409);
  assert.ok((desiLayer?.recipe?.steps.length ?? 0) >= 7);
  assert.equal(desiLayer?.sourceUnitIndex?.status, "exact");
  const csstW2Layer = coverageCatalog.layers.find((layer) => layer.layerId === "csst-sim-w2-image-extent");
  assert.equal(csstW2Layer?.recipe?.mode, "nested-healpix");
  assert.equal(csstW2Layer?.sourceUnitIndex?.status, "exact");
  assert.equal(csstW2Layer?.sourceUnitIndex?.unitKind, "file");
  assert.ok(csstW2Layer?.recipe?.steps.some((step: any) => step.id === "header"));
  assert.ok(csstW2Layer?.recipe?.steps.some((step: any) => step.id === "normalize"));
  const csstW1Layer = coverageCatalog.layers.find((layer) => layer.layerId === "csst-sim-w1-image-extent");
  assert.equal(csstW1Layer?.recipe?.mode, "fits-wcs");
  assert.ok(csstW1Layer?.recipe?.steps.some((step: any) => step.id === "header"));

  const invalidOverlap = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/overlap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surveyIds: ["desi"] }) });
  assert.equal(invalidOverlap.status, 400);

  const csstDesiOverlap = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/overlap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surveyIds: ["csst", "desi"], requestedOrder: 4 }) });
  assert.equal(csstDesiOverlap.status, 200);
  const csstDesiOverlapBody = await csstDesiOverlap.json() as { commonOrder: number; pixels: number[]; components: Array<{ id: string; order: number; cells: number[]; evidenceLookup?: { endpoint: string; layerIds: string[]; order: number; precision: string; deferred: boolean }; surveys?: Array<{ sourceUnitIndex?: { unitKind?: string }; sourceUnits?: { units: Array<{ unitId: string }>; totalUnits: number } | null }> }> };
  assert.equal(csstDesiOverlapBody.commonOrder, 4);
  assert.ok(csstDesiOverlapBody.pixels.length > 0);
  assert.ok(csstDesiOverlapBody.components.every((component) => component.order === 4));
  const tileMatches = csstDesiOverlapBody.components.flatMap((component) => component.surveys ?? []).filter((entry) => entry.sourceUnitIndex?.unitKind === "tile").map((entry) => entry.sourceUnits).filter((value): value is { units: Array<{ unitId: string }>; totalUnits: number } => Boolean(value));
  assert.ok(tileMatches.some((match) => match.totalUnits > 0 && match.units.some((unit) => unit.unitId)));
  const csstDesiComponent = csstDesiOverlapBody.components[0];
  assert.ok(csstDesiComponent?.evidenceLookup?.layerIds.includes("desi-dr1-spectra-footprint"));

  const publicOverlap = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/overlap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surveyIds: ["galex", "nvss"], requestedOrder: 4 }) });
  assert.equal(publicOverlap.status, 200);
  const publicOverlapBody = await publicOverlap.json() as { components: Array<{ cells: number[]; evidenceLookup?: { endpoint: string; layerIds: string[]; order: number } }> };
  const publicComponent = publicOverlapBody.components[0];
  assert.ok(publicComponent?.evidenceLookup);
  assert.ok(publicComponent.evidenceLookup.layerIds.some((layerId) => layerId.startsWith("galex-")));
  assert.ok(publicComponent.evidenceLookup.layerIds.some((layerId) => layerId.startsWith("nvss-")));

  const publicReverseLookup = await fetch(`http://127.0.0.1:${port}${publicComponent.evidenceLookup.endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layerIds: publicComponent.evidenceLookup.layerIds, order: publicComponent.evidenceLookup.order, cells: publicComponent.cells, limit: 250 }) });
  assert.equal(publicReverseLookup.status, 200);
  const publicReverseBody = await publicReverseLookup.json() as { downloadPlan: { files: unknown[]; entrypoints: Array<{ layerId?: string; url?: string; cells?: number[] }> } };
  assert.deepEqual(publicReverseBody.downloadPlan.files, []);
  assert.ok(publicReverseBody.downloadPlan.entrypoints.some((entry) => entry.layerId && entry.url && (entry.cells?.length ?? 0) > 0));

  const componentId = csstDesiOverlapBody.components[0] ? "C01" : "C99";
  const overlapDetails = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/overlap/details`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surveyIds: ["csst", "desi"], componentId }) });
  assert.equal(overlapDetails.status, 200);
  const overlapDetailsBody = await overlapDetails.json() as { schemaVersion: number; component: { id: string; order: number }; publicSources: Array<{ surveyId: string; coverageClaim?: { kind: string } }>; warehouseEvidence: Array<{ state: string; connector: { status: string } }>; method: { summary: string }; reverseLookup: { endpoint: string; layerIds: string[]; order: number; deferred: boolean } };
  assert.equal(overlapDetailsBody.schemaVersion, 1);
  assert.equal(overlapDetailsBody.component.id, componentId);
  assert.ok(overlapDetailsBody.method.summary.length > 0);
  assert.equal(overlapDetailsBody.reverseLookup.endpoint, "/api/v1/coverage/reverse-lookup");
  assert.equal(overlapDetailsBody.reverseLookup.order, overlapDetailsBody.component.order);
  assert.equal(overlapDetailsBody.reverseLookup.deferred, true);
  assert.ok(overlapDetailsBody.reverseLookup.layerIds.includes("desi-dr1-spectra-footprint"));
  assert.ok(overlapDetailsBody.publicSources.every((source) => source.coverageClaim?.kind));
  assert.ok(overlapDetailsBody.warehouseEvidence.every((entry) => entry.connector.status === "known" || entry.connector.status === "unavailable"));

  const reverseLookup = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/reverse-lookup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layerIds: ["desi-dr1-spectra-footprint"], order: 4, cells: [1087] }) });
  assert.equal(reverseLookup.status, 200);
  const reverseBody = await reverseLookup.json() as {
    available: boolean;
    precision: string;
    edges: unknown[];
    sourceFiles: unknown[];
    downloadPlan: {
      files: Array<{ sourceUri?: string; downloadable: boolean; downloadUrl?: string; matchingCoverage: Array<{ order: number; ipix: number }> }>;
      entrypoints: Array<{ kind: string; purpose: string; url?: string; tileId?: string; cells?: number[] }>;
      truncated: boolean;
      warnings: string[];
    };
  };
  assert.equal(reverseBody.available, false);
  assert.equal(reverseBody.precision, "entrypoint-only");
  assert.deepEqual(reverseBody.downloadPlan.files, []);
  assert.equal(reverseBody.downloadPlan.truncated, false);
  assert.ok(reverseBody.downloadPlan.entrypoints.some((entry) => entry.kind === "official-release" && entry.purpose === "data-access"));
  assert.ok(reverseBody.downloadPlan.entrypoints.some((entry) => entry.kind === "coverage-source" && entry.purpose === "coverage-reference"));
  assert.ok(reverseBody.downloadPlan.entrypoints.some((entry) => entry.kind === "tile-directory" && entry.purpose === "data-access"));
  assert.ok(reverseBody.downloadPlan.entrypoints.some((entry) => entry.kind === "tile-directory" && entry.tileId && (entry.cells?.length ?? 0) > 0));
  assert.equal(reverseBody.downloadPlan.entrypoints.some((entry) => entry.kind === "official-data"), false);
  assert.ok(reverseBody.downloadPlan.entrypoints.every((entry) => entry.url?.startsWith("https://") || entry.url?.startsWith("/api/v1/")));

  const surveysResponse = await fetch(`http://127.0.0.1:${port}/api/v1/surveys`);
  assert.equal(surveysResponse.status, 200);
  const surveys = await surveysResponse.json() as {
    surveys: Array<{ id: string; modalities: string[]; statistics: { publicProducts: number; acquired: number }; coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; releases: Array<{ coverageOrders?: { availableOrders: number[]; overviewOrders: number[]; maxOrder: number | null }; products: Array<{ status: string; reason?: string; coverage?: { availableOrders: number[]; overviewOrder: number; maxOrder: number } }> }>; assets: Array<{ surveyId?: string; downloadUrl: string }> }>;
    sharedAssets: Array<{ surveyId?: string; downloadUrl: string }>;
  };
  assert.equal(surveys.surveys.length, 17);
  const csst = surveys.surveys.find((survey) => survey.id === "csst");
  assert.ok(csst);
  assert.deepEqual(csst.modalities.sort(), ["catalog", "imaging", "photometry", "simulation"]);
  assert.equal(csst.releases[0]?.products[0]?.status, "acquired");
  assert.deepEqual(csst.releases[0]?.products[0]?.coverage?.availableOrders, [4]);
  assert.equal(csst.releases[0]?.coverageOrders?.overviewOrders[0], 4);
  assert.ok(csst.coverageOrders?.availableOrders.includes(8));
  assert.deepEqual(csst.releases[1]?.products[0]?.coverage?.availableOrders, [4, 8]);
  assert.ok(csst.assets.some((asset) => asset.downloadUrl.includes("csst-coverage-job-snapshot")));
  assert.ok(surveys.surveys.every((survey) => survey.modalities.length > 0 && survey.statistics.publicProducts > 0));
  assert.ok(surveys.surveys.every((survey) => survey.assets.every((asset) => asset.surveyId === survey.id && asset.downloadUrl.startsWith("/api/v1/assets/"))));
  assert.ok(surveys.sharedAssets.every((asset) => !asset.surveyId));
  const sdss = surveys.surveys.find((survey) => survey.id === "sdss");
  assert.ok(sdss && sdss.statistics.acquired < sdss.statistics.publicProducts);
  assert.ok(sdss.releases.flatMap((release) => release.products).some((product) => product.status === "awaiting_geometry" && product.reason));

  const head = await fetch(`http://127.0.0.1:${port}${provenance.downloadUrl}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(provenance.sizeBytes));
  assert.equal(head.headers.get("content-range"), null);

  const denied = await fetch(`http://127.0.0.1:${port}/api/v1/assets/not-in-release/download`);
  assert.equal(denied.status, 404);
});

test("admin endpoints require a token and expose the configured control-plane boundary", async (context) => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site"), ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "test-admin-token", ASSETS_KUBE_API_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);

  const config = await fetch(`http://127.0.0.1:${port}/api/v1/admin/config`);
  assert.equal(config.status, 200);
  const configBody = await config.json() as { enabled: boolean; authRequired: boolean; capabilities: { coverageModes: string[]; modalities: string[]; businessModalityProfiles?: unknown } };
  assert.equal(configBody.enabled, true);
  assert.equal(configBody.authRequired, true);
  assert.deepEqual(configBody.capabilities.coverageModes, ["fits-wcs", "fits-header-position", "catalog-radec", "nested-healpix"]);
  assert.deepEqual(configBody.capabilities.modalities, ["image", "spectrum", "cube", "catalog", "timeseries", "visibility", "event", "other"]);
  assert.equal("businessModalityProfiles" in configBody.capabilities, false);

  const denied = await fetch(`http://127.0.0.1:${port}/api/v1/admin/tasks`);
  assert.equal(denied.status, 401);
  const deniedProduct = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/bb743658cd44269d7675`);
  assert.equal(deniedProduct.status, 401);
  assert.deepEqual(await deniedProduct.json(), { error: "Invalid Assets admin token" });
  const malformed = await fetch(`http://127.0.0.1:${port}/api/v1/admin/tasks`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(malformed.status, 503);

  const existingProduct = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/bb743658cd44269d7675`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(existingProduct.status, 200);
  assert.equal((await existingProduct.json() as { product: { productId: string } }).product.productId, "bb743658cd44269d7675");

  const missingProduct = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/missing-product-id`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(missingProduct.status, 404);
  assert.deepEqual(await missingProduct.json(), { error: "Product not found" });

  const malformedProductPath = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/%E0%A4%A`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(malformedProductPath.status, 400);
  assert.deepEqual(await malformedProductPath.json(), { error: "Invalid URL path segment" });

  const catalogStatus = await fetch(`http://127.0.0.1:${port}/api/v1/admin/catalog/status`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(catalogStatus.status, 200);
  const catalogStatusBody = await catalogStatus.json() as { mode: string; layers: number; footprints: number };
  assert.ok(["static", "warehouse", "degraded"].includes(catalogStatusBody.mode));
  assert.ok(catalogStatusBody.layers > 0);
  assert.ok(catalogStatusBody.footprints >= 44);

  const products = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(products.status, 200);
  const productBody = await products.json() as { products: Array<{ productId: string }> };
  assert.ok(productBody.products.length > 0);

  const surveyView = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products?view=surveys`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(surveyView.status, 200);
  const surveyViewText = await surveyView.text();
  const surveyViewBody = JSON.parse(surveyViewText) as { surveys: Array<{ id: string; releases: Array<{ id: string; products: Array<{ productId: string; review?: { state: string } }> }>; unmatchedProducts?: unknown[] }> };
  assert.ok(surveyViewBody.surveys.length > 0);
  const csst = surveyViewBody.surveys.find((survey) => survey.id === "csst");
  assert.ok(csst);
  assert.ok(csst.releases.length > 0 && csst.releases.every((release) => release.products.length > 0));
  assert.ok(csst.releases.flatMap((release) => release.products).every((product) => product.productId && product.review?.state));
  assert.doesNotMatch(surveyViewText, /normalized-scan|taskSnapshot|\/var\/lib|elasticsearch|input-manifest/i);
});

test("MOC discovery HTTP routes expose v2 summaries, reject forged choices and require explicit retry", async (context) => {
  const kubePort = await freePort();
  const resource = {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: {
      name: "jwst-moc-discovery",
      namespace: "atlas-warehouse",
      creationTimestamp: "2026-08-30T01:00:00.000Z",
      labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" },
      annotations: { "assets.atlas.zhejianglab.org/work-ref": JSON.stringify({ key: "product:jwst-dr1", title: "JWST · DR1 · Public MOC", surveyId: "jwst", releaseId: "dr1", productId: "jwst-dr1" }) },
    },
    spec: { query: { surveyName: "JWST", releaseHint: "DR1" }, policyRef: "cds-public-moc-v2" },
    status: {
      phase: "SUCCEEDED",
      candidateCount: 1,
      reviewSummary: {
        schemaVersion: 2,
        truncated: false,
        summaryTruncated: false,
        searchRecordCount: 1,
        candidates: [{ candidateId: "jwst-dr1", title: "JWST DR1", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }],
      },
    },
  };
  let retryResource: Record<string, unknown> | undefined;
  const kubeServer = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://kubernetes").pathname;
    response.setHeader("Content-Type", "application/json");
    if (pathname.endsWith("/mocdiscoveryrequests") && request.method === "GET") {
      response.writeHead(200);
      response.end(JSON.stringify({ items: [resource] }));
      return;
    }
    if (pathname.endsWith("/mocdiscoveryrequests/jwst-moc-discovery") && request.method === "GET") {
      response.writeHead(200);
      response.end(JSON.stringify(resource));
      return;
    }
    if (pathname.endsWith("/mocdiscoveryrequests") && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      retryResource = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(201);
      response.end(JSON.stringify({ ...retryResource, metadata: { ...(retryResource.metadata as Record<string, unknown>), creationTimestamp: "2026-08-30T01:01:00.000Z" } }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((resolve, reject) => { kubeServer.once("error", reject); kubeServer.listen(kubePort, "127.0.0.1", () => resolve()); });
  context.after(() => { kubeServer.close(); });

  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-moc-http-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site"), ASSETS_CONTENT_ROOT: contentRoot, ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "test-admin-token", ASSETS_KUBE_API_URL: `http://127.0.0.1:${kubePort}`, ASSETS_KUBE_TOKEN: "kube-token", ASSETS_WAREHOUSE_NAMESPACE: "atlas-warehouse" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);

  const list = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-discovery`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(list.status, 200);
  const listText = await list.text();
  assert.doesNotMatch(listText, /candidates|probes|https:\/\/alasky/);
  const detail = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-discovery/jwst-moc-discovery`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { request: { workKey?: string; workTitle?: string; surveyId?: string; releaseId?: string; productId?: string; status: { reviewSummary?: { candidates: unknown[]; searchRecordCount?: number } } } };
  assert.equal(detailBody.request.workKey, "product:jwst-dr1");
  assert.equal(detailBody.request.workTitle, "JWST · DR1 · Public MOC");
  assert.equal(detailBody.request.surveyId, "jwst");
  assert.equal(detailBody.request.releaseId, "dr1");
  assert.equal(detailBody.request.productId, "jwst-dr1");
  assert.equal(detailBody.request.status.reviewSummary?.candidates.length, 1);
  assert.equal(detailBody.request.status.reviewSummary?.searchRecordCount, 1);

  const forged = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-builds`, { method: "POST", headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" }, body: JSON.stringify({ discoveryRequestName: "jwst-moc-discovery", candidateId: "invented" }) });
  assert.equal(forged.status, 400);
  const mismatchedProduct = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-builds`, { method: "POST", headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" }, body: JSON.stringify({ discoveryRequestName: "jwst-moc-discovery", candidateId: "jwst-dr1", productId: "other-product" }) });
  assert.equal(mismatchedProduct.status, 400);

  const retry = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-discovery/jwst-moc-discovery/resubmit`, { method: "POST", headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(retry.status, 201);
  const retryBody = await retry.json() as { request: { name: string; status: Record<string, unknown> } };
  assert.match(retryBody.request.name, /^jwst-moc-discovery-retry-/);
  assert.equal(retryBody.request.status.phase, "PENDING");
  assert.equal(retryBody.request.status.reviewSummaryState, "missing");
  assert.ok(retryResource);
  assert.equal((retryResource!.metadata as Record<string, unknown>).annotations && ((retryResource!.metadata as Record<string, unknown>).annotations as Record<string, string>)["assets.atlas.zhejianglab.org/work-ref"], resource.metadata.annotations["assets.atlas.zhejianglab.org/work-ref"]);
  assert.equal((retryResource!.spec as Record<string, unknown>).policyRef, "cds-public-moc-v2");
});

test("product review exposes staged MOC builds that are not bound to a product", async (context) => {
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-unbound-moc-review-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "assets-unbound-moc-evidence-"));
  await writeFile(path.join(contentRoot, "moc-build-requests-v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    requests: [{
      schemaVersion: 1,
      kind: "MocBuildRequest",
      name: "jwst-moc-build-staged",
      createdAt: "2026-08-30T04:00:00.000Z",
      updatedAt: "2026-08-30T04:00:00.000Z",
      discoveryRequestName: "jwst-moc-discovery",
      provider: "cds",
      candidateId: "cds-p-jwst-deep-field",
      candidateTitle: "JWST deep field",
      source: { url: "https://alasky.cds.unistra.fr/jwst/moc.fits" },
      phase: "STAGED",
      progress: { phase: "STAGED", step: 7, totalSteps: 7, percent: 100, message: "构建完成，等待产品审核与发布" },
    }],
  }, null, 2)}\n`);
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site"), ASSETS_CONTENT_ROOT: contentRoot, ASSETS_EVIDENCE_ROOT: evidenceRoot, ASSETS_WAREHOUSE_ES_URL: "", ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "test-admin-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products?view=surveys`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(response.status, 200);
  const body = await response.json() as { surveys: Array<{ id: string; unmatchedBuilds?: Array<{ name: string; candidateId: string; candidateTitle?: string }> }> };
  const queue = body.surveys.find((survey) => survey.id === "__moc-builds__");
  assert.ok(queue);
  assert.equal(queue.unmatchedBuilds?.[0]?.name, "jwst-moc-build-staged");
  assert.equal(queue.unmatchedBuilds?.[0]?.candidateId, "cds-p-jwst-deep-field");
  assert.equal(queue.unmatchedBuilds?.[0]?.candidateTitle, "JWST deep field");
});

test("staged MOC builds can be registered, reviewed and published as a dynamic survey", async (context) => {
  const kubePort = await freePort();
  const discovery = {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: { name: "jwst-moc-discovery", namespace: "atlas-warehouse", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
    spec: { query: { surveyName: "JWST", releaseHint: "DR1" }, policyRef: "cds-public-moc-v2" },
    status: { phase: "SUCCEEDED", reviewSummary: { schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst-dr1", title: "JWST DR1", recordUrl: "https://alasky.cds.unistra.fr/jwst/dr1", mocUrl: "https://alasky.cds.unistra.fr/jwst/dr1/moc.fits" }] } },
  };
  const kubeServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://kubernetes").pathname;
    response.setHeader("Content-Type", "application/json");
    if (pathname.endsWith("/mocdiscoveryrequests/jwst-moc-discovery")) {
      response.writeHead(200);
      response.end(JSON.stringify(discovery));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((resolve, reject) => { kubeServer.once("error", reject); kubeServer.listen(kubePort, "127.0.0.1", () => resolve()); });
  context.after(() => { kubeServer.close(); });

  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-moc-register-content-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "assets-moc-register-evidence-"));
  const buildName = "jwst-moc-build-staged";
  const buildRoot = path.join(evidenceRoot, "moc-build", buildName);
  await mkdir(buildRoot, { recursive: true });
  const outputBytes = { moc: Buffer.from("jwst-moc-fits"), query: Buffer.from(JSON.stringify({ order: 8, ordering: "NESTED", pixels: [1, 2] })), preview: Buffer.from(JSON.stringify({ order: 4, ordering: "NESTED", pixels: [0] })) };
  await writeFile(path.join(buildRoot, "moc.fits"), outputBytes.moc);
  await writeFile(path.join(buildRoot, "query-order8.json"), outputBytes.query);
  await writeFile(path.join(buildRoot, "preview-order4.json"), outputBytes.preview);
  const outputRef = (key: keyof typeof outputBytes, ref: string) => ({ ref: `moc-build/${buildName}/${ref}`, sha256: sha256(outputBytes[key]), sizeBytes: outputBytes[key].length });
  await writeFile(path.join(contentRoot, "moc-build-requests-v1.json"), `${JSON.stringify({ schemaVersion: 1, requests: [{ schemaVersion: 1, kind: "MocBuildRequest", name: buildName, createdAt: "2026-08-30T04:00:00.000Z", updatedAt: "2026-08-30T04:00:00.000Z", discoveryRequestName: "jwst-moc-discovery", provider: "cds", candidateId: "jwst-dr1", candidateTitle: "JWST DR1", source: { url: "https://alasky.cds.unistra.fr/jwst/dr1/moc.fits" }, phase: "STAGED", progress: { phase: "STAGED", step: 7, totalSteps: 7, percent: 100, message: "构建完成，等待产品审核与发布" }, outputs: { moc: outputRef("moc", "moc.fits"), query: { ...outputRef("query", "query-order8.json"), order: 8 }, preview: { ...outputRef("preview", "preview-order4.json"), order: 4 }, availableOrders: [4, 8], maxOrder: 8, cellCount: 2 } }] }, null, 2)}\n`);
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site"), ASSETS_CONTENT_ROOT: contentRoot, ASSETS_EVIDENCE_ROOT: evidenceRoot, ASSETS_WAREHOUSE_ES_URL: "", ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "test-admin-token", ASSETS_KUBE_API_URL: `http://127.0.0.1:${kubePort}`, ASSETS_KUBE_TOKEN: "kube-token", ASSETS_WAREHOUSE_NAMESPACE: "atlas-warehouse" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);
  const headers = { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" };
  const detail = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-builds/${buildName}`, { headers });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { registrationDefaults?: { releaseId?: string; releaseLabel?: string; productName?: string; modality?: string } };
  assert.deepEqual(detailBody.registrationDefaults, {
    releaseId: "dr1",
    releaseLabel: "DR1",
    releaseKind: "release",
    productName: "JWST DR1",
    productDescription: "JWST DR1 的公开天区覆盖 MOC；来源为 CDS MOC 服务，已由 Assets 校验并锁定来源哈希。",
    productStatus: "acquired",
    modality: "infrared",
    dataOrigin: "observed",
  });
  const register = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-builds/${buildName}/register-product`, { method: "POST", headers, body: JSON.stringify({ surveyId: "jwst", surveyName: "JWST", mission: "James Webb Space Telescope", surveyDescription: "Public JWST coverage products.", surveyColor: "#42d5c4", surveyModalities: ["infrared", "imaging"], releaseId: " ", releaseLabel: "", releaseKind: "", productName: "", productDescription: " ", productStatus: "", modality: "", dataOrigin: "", sourceUrl: "https://alasky.cds.unistra.fr/jwst/dr1", geometrySourceUrl: "https://alasky.cds.unistra.fr/jwst/dr1/moc.fits", geometrySourceLabel: "CDS MOC source" }) });
  assert.equal(register.status, 201);
  const registered = await register.json() as { product: { productId: string; draft: { surveyId: string; releaseId: string; name: string; modality?: string; publicDescription?: string; publicSurvey?: { name: string }; publicRelease?: { label: string; kind: string } } }; request: { productId?: string; workKey?: string } };
  assert.equal(registered.product.draft.surveyId, "jwst");
  assert.equal(registered.product.draft.releaseId, "dr1");
  assert.equal(registered.product.draft.name, "JWST DR1");
  assert.equal(registered.product.draft.modality, "infrared");
  assert.equal(registered.product.draft.publicRelease?.label, "DR1");
  assert.equal(registered.product.draft.publicDescription, "JWST DR1 的公开天区覆盖 MOC；来源为 CDS MOC 服务，已由 Assets 校验并锁定来源哈希。");
  assert.equal(registered.product.draft.publicSurvey?.name, "JWST");
  assert.equal(registered.request.productId, registered.product.productId);
  assert.equal(registered.request.workKey, `product:${registered.product.productId}`);

  const review = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products?view=surveys`, { headers });
  const reviewBody = await review.json() as { surveys: Array<{ id: string; unmatchedBuilds?: unknown[]; unmatchedProducts?: Array<{ productId: string }> }> };
  assert.equal(reviewBody.surveys.some((survey) => survey.id === "__moc-builds__"), false);
  assert.ok(reviewBody.surveys.find((survey) => survey.id === "__unmatched__")?.unmatchedProducts?.some((product) => product.productId === registered.product.productId));

  const publish = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${registered.product.productId}/publish`, { method: "POST", headers, body: JSON.stringify({ revision: 1 }) });
  assert.equal(publish.status, 200);
  const surveysResponse = await fetch(`http://127.0.0.1:${port}/api/v1/surveys`);
  assert.equal(surveysResponse.status, 200);
  const surveys = await surveysResponse.json() as { surveys: Array<{ id: string; releases: Array<{ id: string; products: Array<{ productId?: string; name: string; sourceUrl: string }> }> }> };
  const dynamic = surveys.surveys.find((survey) => survey.id === "jwst");
  assert.ok(dynamic);
  assert.equal(dynamic.releases.find((release) => release.id === "dr1")?.products[0]?.productId, registered.product.productId);
});

test("admin connector probe route checks an authorized PVC without persisting its phase", async (context) => {
  const kubePort = await freePort();
  const kubeServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://kubernetes").pathname;
    response.setHeader("Content-Type", "application/json");
    if (pathname.endsWith("/configmaps/connector-local")) {
      response.writeHead(200);
      response.end(JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "connector-local", namespace: "atlas-warehouse", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } },
        data: { type: "local", pvcName: "atlas-source-catalogs", basePath: "catalogs" },
      }));
      return;
    }
    if (pathname.endsWith("/configmaps")) {
      response.writeHead(200);
      response.end(JSON.stringify({ items: [{ metadata: { name: "connector-local", namespace: "atlas-warehouse", labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "connector" } }, data: { type: "local", pvcName: "atlas-source-catalogs", basePath: "catalogs" } }] }));
      return;
    }
    if (pathname.endsWith("/persistentvolumeclaims/atlas-source-catalogs")) {
      response.writeHead(200);
      response.end(JSON.stringify({ metadata: { name: "atlas-source-catalogs", labels: { "atlas.zhejianglab.org/scanner-source": "true" } }, status: { phase: "Bound" } }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((resolve, reject) => { kubeServer.once("error", reject); kubeServer.listen(kubePort, "127.0.0.1", () => resolve()); });
  context.after(() => { kubeServer.close(); });

  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site"), ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "test-admin-token", ASSETS_KUBE_API_URL: `http://127.0.0.1:${kubePort}`, ASSETS_KUBE_TOKEN: "kube-token", ASSETS_WAREHOUSE_NAMESPACE: "atlas-warehouse" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);

  const denied = await fetch(`http://127.0.0.1:${port}/api/v1/admin/connectors/connector-local/probe`, { method: "POST" });
  assert.equal(denied.status, 401);
  const probe = await fetch(`http://127.0.0.1:${port}/api/v1/admin/connectors/connector-local/probe`, { method: "POST", headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(probe.status, 200);
  const probeBody = await probe.json() as { connector: { name: string; phase: string; checkedAt?: string; message?: string } };
  assert.equal(probeBody.connector.name, "connector-local");
  assert.equal(probeBody.connector.phase, "READY");
  assert.match(probeBody.connector.checkedAt ?? "", /^20\d\d-/);
  assert.match(probeBody.connector.message ?? "", /Bound/);

  const listed = await fetch(`http://127.0.0.1:${port}/api/v1/admin/connectors`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json() as { connectors: Array<{ name: string; phase: string; checkedAt?: string }> };
  assert.equal(listedBody.connectors[0]?.phase, "NOT_CHECKED");
  assert.equal(listedBody.connectors[0]?.checkedAt, undefined);
  const missing = await fetch(`http://127.0.0.1:${port}/api/v1/admin/connectors/missing/probe`, { method: "POST", headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(missing.status, 404);
});

test("public product dossier, evidence projection and predictable MOC URL are hash-addressed", async (context) => {
  const port = await freePort();
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-product-dossier-"));
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site"), ASSETS_CONTENT_ROOT: contentRoot, ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "test-admin-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);

  const adminResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(adminResponse.status, 200);
  const adminBody = await adminResponse.json() as { products: Array<{ productId: string; draft: { layerId?: string } }> };
  const candidate = adminBody.products.find((product) => product.draft.layerId === "euclid-q1-deep-fields-image-extent");
  assert.ok(candidate);
  const adminProductResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${candidate.productId}`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(adminProductResponse.status, 200);
  const adminProductBody = await adminProductResponse.json() as { product: { draft: Record<string, unknown> } };
  const unsafeDraft = { ...adminProductBody.product.draft, sourceUrl: "http://10.42.0.7/private", geometrySourceUrl: "http://192.168.0.4/geometry" };
  const updateResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${candidate.productId}`, {
    method: "PUT",
    headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" },
    body: JSON.stringify({ content: unsafeDraft }),
  });
  assert.equal(updateResponse.status, 200);
  const catalogDetail = await fetch(`http://127.0.0.1:${port}/api/v1/products/${candidate.productId}`);
  assert.equal(catalogDetail.status, 200);
  const catalogDossier = await catalogDetail.json() as { identity: { productId: string }; coverage: { layerId?: string }; conclusion: { summary: string }; source?: { url?: string; geometryUrl?: string } };
  assert.equal(catalogDossier.identity.productId, candidate.productId);
  assert.equal(catalogDossier.coverage.layerId, "euclid-q1-deep-fields-image-extent");
  assert.equal(catalogDossier.source?.url, undefined);
  assert.ok(catalogDossier.source?.geometryUrl?.startsWith("/api/v1/assets/"));
  assert.doesNotMatch(JSON.stringify(catalogDossier), /10\.42\.0\.7|192\.168\.0\.4/);
  assert.doesNotMatch(catalogDossier.conclusion.summary, /scannerRunId|taskSnapshot|normalized-scan|\/var\/lib|elasticsearch/i);
  const publishResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${candidate.productId}/publish`, { method: "POST", headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(publishResponse.status, 200);

  const listResponse = await fetch(`http://127.0.0.1:${port}/api/v1/products`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as { products: Array<{ productId: string; detailUrl: string; evidenceUrl: string; links: Array<{ kind: string; url: string }> }> };
  const listed = listBody.products.find((product) => product.productId === candidate.productId);
  assert.ok(listed);
  assert.equal(listed.detailUrl, `/api/v1/products/${candidate.productId}`);
  assert.equal(listed.evidenceUrl, `/api/v1/products/${candidate.productId}/evidence`);
  assert.ok(listed.links.some((link) => link.kind === "fits-moc"));

  const detailResponse = await fetch(`http://127.0.0.1:${port}${listed.detailUrl}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as { schemaVersion: number; identity: { productId: string }; coverage: { layerId?: string; ordering: string; precision: string }; verification: { status: string }; evidenceUrl: string };
  assert.equal(detail.schemaVersion, 1);
  assert.equal(detail.identity.productId, candidate.productId);
  assert.equal(detail.coverage.ordering, "NESTED");
  assert.equal(detail.coverage.precision, "exact");
  assert.equal(detail.verification.status, "complete");

  const evidenceResponse = await fetch(`http://127.0.0.1:${port}${detail.evidenceUrl}`);
  assert.equal(evidenceResponse.status, 200);
  const evidenceText = await evidenceResponse.text();
  const evidence = JSON.parse(evidenceText) as { status: string; precision: string; coordinateFrame: string; ordering: string; checks: unknown[]; outputHashes: unknown[] };
  assert.equal(evidence.status, "complete");
  assert.equal(evidence.precision, "exact");
  assert.equal(evidence.coordinateFrame, "ICRS");
  assert.equal(evidence.ordering, "NESTED");
  assert.ok(evidence.checks.length > 0 && evidence.outputHashes.length > 0);
  assert.doesNotMatch(evidenceText, /scannerRunId|taskSnapshot|normalized-scan|\/var\/lib|elasticsearch/i);

  const mocUrl = listed.links.find((link) => link.kind === "fits-moc")?.url;
  assert.ok(mocUrl);
  const moc = await fetch(`http://127.0.0.1:${port}${mocUrl}`, { headers: { Range: "bytes=0-15" } });
  assert.equal(moc.status, 206);
  assert.equal(moc.headers.get("content-length"), "16");
  assert.equal(moc.headers.get("content-type"), "application/fits");
  assert.match(moc.headers.get("etag") ?? "", /^\"sha256-[a-f0-9]{64}\"$/);
  const mocHead = await fetch(`http://127.0.0.1:${port}${mocUrl}`, { method: "HEAD" });
  assert.equal(mocHead.status, 200);
  assert.ok(Number(mocHead.headers.get("content-length")) > 0);
});

test("HTTP publication activates dynamic MOC assets and restores them after restart", async (context) => {
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-dynamic-moc-content-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "assets-dynamic-moc-evidence-"));
  const buildName = "euclid-ero-moc-build-20260830";
  const buildRoot = path.join(evidenceRoot, "moc-build", buildName);
  await mkdir(buildRoot, { recursive: true });
  const outputBytes = {
    moc: await readFile(path.resolve("artifacts/public-survey-footprints/layers/euclid-q1-deep-fields-image-extent/euclid-q1-deep-fields-image-extent.moc.fits")),
    query: Buffer.from(JSON.stringify({ order: 8, ordering: "NESTED", pixels: [1, 2] })),
    preview: Buffer.from(JSON.stringify({ order: 4, ordering: "NESTED", pixels: [0] })),
    statistics: Buffer.from(JSON.stringify({ cells: 2 })),
    manifest: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "moc-build-evidence", requestName: buildName })),
  };
  for (const [name, bytes] of Object.entries(outputBytes)) await writeFile(path.join(buildRoot, name === "query" ? "query-order8.json" : name === "preview" ? "preview-order4.json" : name === "manifest" ? "build-manifest.json" : `${name}.json`.replace("moc.json", "moc.fits")), bytes);
  const outputRef = (name: keyof typeof outputBytes, fileName: string) => ({ ref: `moc-build/${buildName}/${fileName}`, sha256: sha256(outputBytes[name]), sizeBytes: outputBytes[name].length });
  const productId = "18e203dec1e31f1da357";
  await writeFile(path.join(contentRoot, "moc-build-requests-v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    requests: [{
      schemaVersion: 1,
      kind: "MocBuildRequest",
      name: buildName,
      createdAt: "2026-08-30T01:00:00.000Z",
      updatedAt: "2026-08-30T01:00:00.000Z",
      discoveryRequestName: "euclid-ero-moc-discovery",
      provider: "cds",
      candidateId: "euclid-ero",
      surveyId: "euclid",
      releaseId: "euclid-ero",
      productId,
      workKey: `product:${productId}`,
      workTitle: "EUCLID · ERO · Early Release Observations",
      source: { url: "https://alasky.cds.unistra.fr/euclid-ero/moc.fits", snapshotSha256: "b".repeat(64), sizeBytes: 11, evidenceRef: `moc-build/${buildName}/source.moc` },
      phase: "STAGED",
      progress: { phase: "STAGED", step: 7, totalSteps: 7, percent: 100, message: "构建完成" },
      outputs: {
        moc: outputRef("moc", "moc.fits"),
        query: { ...outputRef("query", "query-order8.json"), order: 8 },
        preview: { ...outputRef("preview", "preview-order4.json"), order: 4 },
        statistics: outputRef("statistics", "statistics.json"),
        manifest: outputRef("manifest", "build-manifest.json"),
        cellCount: 2,
        availableOrders: [4, 8],
        maxOrder: 8,
      },
    }],
  }, null, 2)}\n`);

  const baseEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PUBLIC_SITE_ROOT: path.resolve("site"),
    ASSETS_CONTENT_ROOT: contentRoot,
    ASSETS_EVIDENCE_ROOT: evidenceRoot,
    ASSETS_WAREHOUSE_ES_URL: "",
    ASSETS_ADMIN_ENABLED: "true",
    ASSETS_ADMIN_TOKEN: "test-admin-token",
  };
  let child: ChildProcess | undefined;
  context.after(async () => { if (child) await stopChild(child); });
  const start = async (): Promise<number> => {
    const port = await freePort();
    child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
      cwd: process.cwd(),
      env: { ...baseEnv, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitFor(`http://127.0.0.1:${port}/healthz`, child);
    return port;
  };

  let port = await start();
  const adminHeaders = { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" };
  const adminProducts = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products?view=surveys`, { headers: adminHeaders });
  assert.equal(adminProducts.status, 200);
  const adminProductBody = await adminProducts.json() as { surveys: Array<{ releases: Array<{ products: Array<{ productId: string; mocBuild?: { name: string; phase: string; progress?: { percent?: number }; lifecycle?: { publication?: { state?: string }; runtime?: { state?: string; availableOrders?: number[] } } }; lifecycle?: { publication?: { state?: string }; runtime?: { state?: string; availableOrders?: number[] } } }> }> }> };
  const stagedAdminProduct = adminProductBody.surveys.flatMap((survey) => survey.releases.flatMap((release) => release.products)).find((product) => product.productId === productId);
  assert.equal(stagedAdminProduct?.mocBuild?.name, buildName);
  assert.equal(stagedAdminProduct?.mocBuild?.phase, "STAGED");
  assert.equal(stagedAdminProduct?.lifecycle?.publication?.state, "DRAFT");
  assert.equal(stagedAdminProduct?.lifecycle?.runtime?.state, "INACTIVE");
  assert.equal(stagedAdminProduct?.mocBuild?.lifecycle?.runtime?.state, "INACTIVE");
  const publish = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${productId}/publish`, { method: "POST", headers: adminHeaders, body: "{}" });
  assert.equal(publish.status, 200);
  const publishBody = await publish.json() as { lifecycle?: { publication?: { state?: string }; runtime?: { state?: string; availableOrders?: number[] }; links?: Record<string, string> } };
  assert.equal(publishBody.lifecycle?.publication?.state, "PUBLISHED");
  assert.equal(publishBody.lifecycle?.runtime?.state, "ACTIVE");
  assert.deepEqual(publishBody.lifecycle?.runtime?.availableOrders, [4, 8]);
  assert.deepEqual(Object.keys(publishBody.lifecycle?.links ?? {}).sort(), ["catalog", "moc", "product", "sky"]);

  const assetsResponse = await fetch(`http://127.0.0.1:${port}/api/v1/assets`);
  assert.equal(assetsResponse.status, 200);
  const assets = await assetsResponse.json() as { files: Array<{ id: string; sha256: string; downloadUrl: string }> };
  const dynamicAsset = assets.files.find((asset) => asset.id.startsWith("layer-moc-euclid-euclid-ero-") && asset.id.endsWith("-moc"));
  assert.ok(dynamicAsset);
  assert.equal(dynamicAsset.sha256, sha256(outputBytes.moc));

  const packageCatalogResponse = await fetch(`http://127.0.0.1:${port}/api/v1/resource-packages/catalog.json`);
  assert.equal(packageCatalogResponse.status, 200);
  const packageCatalog = await packageCatalogResponse.json() as { packages: Array<{ id: string; surveyId: string; version: string; archiveUrl: string; sha256: string; sizeBytes: number }> };
  const dynamicPackage = packageCatalog.packages.find((entry) => entry.surveyId === "euclid" && entry.id.startsWith("public-euclid-footprints-"));
  assert.ok(dynamicPackage);
  assert.equal(dynamicPackage.version, "3.0.0");
  const packageArchive = await fetch(`http://127.0.0.1:${port}${dynamicPackage.archiveUrl}`, { headers: { Range: "bytes=0-7" } });
  assert.equal(packageArchive.status, 206);
  assert.equal(packageArchive.headers.get("x-content-sha256"), dynamicPackage.sha256);
  assert.equal((await packageArchive.arrayBuffer()).byteLength, 8);
  const completePackageArchive = await fetch(`http://127.0.0.1:${port}${dynamicPackage.archiveUrl}`);
  assert.equal(completePackageArchive.status, 200);
  const completePackageBytes = new Uint8Array(await completePackageArchive.arrayBuffer());
  assert.equal(completePackageArchive.headers.get("content-length"), String(dynamicPackage.sizeBytes));
  assert.equal(completePackageBytes.byteLength, dynamicPackage.sizeBytes);
  assert.equal(sha256(completePackageBytes), dynamicPackage.sha256);

  const coverageCatalogResponse = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/catalog`);
  assert.equal(coverageCatalogResponse.status, 200);
  const coverageCatalog = await coverageCatalogResponse.json() as { layers: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; availableOrders: number[] }> };
  const dynamicLayer = coverageCatalog.layers.find((layer) => layer.surveyId === "euclid" && layer.releaseId === "euclid-ero" && layer.product === "Early Release Observations");
  assert.ok(dynamicLayer);
  assert.deepEqual(dynamicLayer.availableOrders, [4, 8]);

  const coverageResponse = await fetch(`http://127.0.0.1:${port}/api/v1/coverage`);
  const coverage = await coverageResponse.json() as { footprints: Array<{ surveyId: string; releaseId: string; product: string }> };
  assert.ok(coverage.footprints.some((footprint) => footprint.surveyId === "euclid" && footprint.releaseId === "euclid-ero" && footprint.product === "Early Release Observations"));

  const surveysResponse = await fetch(`http://127.0.0.1:${port}/api/v1/surveys`);
  const surveys = await surveysResponse.json() as { surveys: Array<{ id: string; releases: Array<{ id: string; products: Array<{ productId: string; coverage?: { layerId?: string } }> }> }> };
  const publishedProduct = surveys.surveys.find((survey) => survey.id === "euclid")?.releases.find((release) => release.id === "euclid-ero")?.products.find((product) => product.productId === productId);
  assert.equal(publishedProduct?.coverage?.layerId, dynamicLayer.layerId);

  const mocResponse = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/layers/${dynamicLayer.layerId}/moc.fits`, { headers: { Range: "bytes=0-6" } });
  assert.equal(mocResponse.status, 206);
  assert.equal(mocResponse.headers.get("x-content-sha256"), dynamicAsset.sha256);
  assert.equal((await mocResponse.arrayBuffer()).byteLength, 7);

  await stopChild(child!);
  port = await start();
  const restoredAssetsResponse = await fetch(`http://127.0.0.1:${port}/api/v1/assets`);
  const restoredAssets = await restoredAssetsResponse.json() as { files: Array<{ id: string }> };
  assert.ok(restoredAssets.files.some((asset) => asset.id === dynamicAsset.id));
  const restoredCoverageResponse = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/catalog`);
  const restoredCoverage = await restoredCoverageResponse.json() as { layers: Array<{ layerId: string }> };
  assert.ok(restoredCoverage.layers.some((layer) => layer.layerId === dynamicLayer.layerId));

  const publicationDocument = JSON.parse(await readFile(path.join(contentRoot, "moc-publications-v1.json"), "utf8")) as { publications: Array<{ files: { moc: { path: string } } }> };
  await writeFile(path.join(contentRoot, publicationDocument.publications[0]!.files.moc.path), "tampered dynamic MOC");
  await stopChild(child!);
  port = await start();
  const rejectedAssetsResponse = await fetch(`http://127.0.0.1:${port}/api/v1/assets`);
  const rejectedAssets = await rejectedAssetsResponse.json() as { files: Array<{ id: string }> };
  assert.equal(rejectedAssets.files.some((asset) => asset.id === dynamicAsset.id), false);
  const rejectedCoverageResponse = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/catalog`);
  const rejectedCoverage = await rejectedCoverageResponse.json() as { layers: Array<{ layerId: string }> };
  assert.equal(rejectedCoverage.layers.some((layer) => layer.layerId === dynamicLayer.layerId), false);
});
