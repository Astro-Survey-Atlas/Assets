import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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

  for (const [font, mediaType] of [["NotoSans-Regular.ttf", "font/ttf"], ["NotoSansCJK-Regular.ttc", "font/collection"]] as const) {
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
  const coverageCatalog = await coverageCatalogResponse.json() as { ordering: string; layers: Array<{ layerId: string; surveyId: string; availableOrders: number[]; tileIdsByOrder: Record<string, number[]>; recipe?: { mode: string; steps: any[] }; sourceUnitIndex?: { status: string; unitKind?: string } }> };
  assert.equal(coverageCatalog.ordering, "NESTED");
  assert.ok(coverageCatalog.layers.every((layer) => layer.availableOrders.every((order) => Array.isArray(layer.tileIdsByOrder[String(order)]))));
  const desiLayer = coverageCatalog.layers.find((layer) => layer.layerId === "desi-dr1-spectra-footprint");
  assert.equal(desiLayer?.recipe?.mode, "tile-table");
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
  const csstDesiOverlapBody = await csstDesiOverlap.json() as { commonOrder: number; pixels: number[]; components: Array<{ order: number; surveys?: Array<{ sourceUnitIndex?: { unitKind?: string }; sourceUnits?: { units: Array<{ unitId: string }>; totalUnits: number } | null }> }> };
  assert.equal(csstDesiOverlapBody.commonOrder, 4);
  assert.ok(csstDesiOverlapBody.pixels.length > 0);
  assert.ok(csstDesiOverlapBody.components.every((component) => component.order === 4));
  const tileMatches = csstDesiOverlapBody.components.flatMap((component) => component.surveys ?? []).filter((entry) => entry.sourceUnitIndex?.unitKind === "tile").map((entry) => entry.sourceUnits).filter((value): value is { units: Array<{ unitId: string }>; totalUnits: number } => Boolean(value));
  assert.ok(tileMatches.some((match) => match.totalUnits > 0 && match.units.some((unit) => unit.unitId)));

  const componentId = csstDesiOverlapBody.components[0] ? "C01" : "C99";
  const overlapDetails = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/overlap/details`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surveyIds: ["csst", "desi"], componentId }) });
  assert.equal(overlapDetails.status, 200);
  const overlapDetailsBody = await overlapDetails.json() as { schemaVersion: number; component: { id: string; order: number }; publicSources: Array<{ surveyId: string; coverageClaim?: { kind: string } }>; warehouseEvidence: Array<{ state: string; connector: { status: string } }>; method: { summary: string }; reverseLookup: { endpoint: string; order: number; deferred: boolean } };
  assert.equal(overlapDetailsBody.schemaVersion, 1);
  assert.equal(overlapDetailsBody.component.id, componentId);
  assert.ok(overlapDetailsBody.method.summary.length > 0);
  assert.equal(overlapDetailsBody.reverseLookup.endpoint, "/api/v1/coverage/reverse-lookup");
  assert.equal(overlapDetailsBody.reverseLookup.order, overlapDetailsBody.component.order);
  assert.equal(overlapDetailsBody.reverseLookup.deferred, true);
  assert.ok(overlapDetailsBody.publicSources.every((source) => source.coverageClaim?.kind));
  assert.ok(overlapDetailsBody.warehouseEvidence.every((entry) => entry.connector.status === "known" || entry.connector.status === "unavailable"));

  const reverseLookup = await fetch(`http://127.0.0.1:${port}/api/v1/coverage/reverse-lookup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layerIds: ["desi-dr1-spectra-footprint"], order: 4, cells: [1087] }) });
  assert.equal(reverseLookup.status, 200);
  const reverseBody = await reverseLookup.json() as { available: boolean; precision: string };
  assert.equal(reverseBody.available, false);
  assert.equal(reverseBody.precision, "entrypoint-only");

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
  const malformed = await fetch(`http://127.0.0.1:${port}/api/v1/admin/tasks`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(malformed.status, 503);

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
