import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
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

test("MOC discovery HTTP routes expose review summaries, reject forged choices and require explicit retry", async (context) => {
  const kubePort = await freePort();
  const probeId = "a".repeat(64);
  const sourceHash = "b".repeat(64);
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
    spec: { query: { surveyName: "JWST", releaseHint: "DR1" }, policyRef: "cds-public-moc-v1" },
    status: {
      phase: "SUCCEEDED",
      candidateCount: 1,
      probeCount: 1,
      reviewSummary: {
        schemaVersion: 1,
        truncated: false,
        summaryTruncated: false,
        candidates: [{ candidateId: "jwst-dr1", title: "JWST DR1", recordUrl: "https://alasky.cds.unistra.fr/jwst" }],
        probes: [{ probeId, candidateId: "jwst-dr1", kind: "mocUrl", url: "https://alasky.cds.unistra.fr/jwst/moc.fits", ok: true, sha256: sourceHash, validation: { acceptedSpatialMoc: true, icrs: true, nested: true } }],
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
  const detailBody = await detail.json() as { request: { workKey?: string; workTitle?: string; status: { reviewSummary?: { candidates: unknown[]; probes: unknown[] } } } };
  assert.equal(detailBody.request.workKey, "product:jwst-dr1");
  assert.equal(detailBody.request.workTitle, "JWST · DR1 · Public MOC");
  assert.equal(detailBody.request.status.reviewSummary?.candidates.length, 1);
  assert.equal(detailBody.request.status.reviewSummary?.probes.length, 1);

  const forged = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-discovery/jwst-moc-discovery/reviews`, { method: "POST", headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" }, body: JSON.stringify({ candidateId: "invented", decision: "rejected" }) });
  assert.equal(forged.status, 400);
  const review = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-discovery/jwst-moc-discovery/reviews`, { method: "POST", headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" }, body: JSON.stringify({ candidateId: "jwst-dr1", probeId, decision: "ready-for-build" }) });
  assert.equal(review.status, 201);
  const reviewBody = await review.json() as { review: { sourceSnapshotSha256?: string; mocUrl?: string; sourceUrl?: string } };
  assert.equal(reviewBody.review.sourceSnapshotSha256, sourceHash);
  assert.equal(reviewBody.review.sourceUrl, "https://alasky.cds.unistra.fr/jwst");
  assert.equal(reviewBody.review.mocUrl, "https://alasky.cds.unistra.fr/jwst/moc.fits");

  const retry = await fetch(`http://127.0.0.1:${port}/api/v1/admin/moc-discovery/jwst-moc-discovery/resubmit`, { method: "POST", headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(retry.status, 201);
  const retryBody = await retry.json() as { request: { name: string; status: Record<string, unknown> } };
  assert.match(retryBody.request.name, /^jwst-moc-discovery-retry-/);
  assert.equal(retryBody.request.status.phase, "PENDING");
  assert.equal(retryBody.request.status.reviewSummaryState, "missing");
  assert.ok(retryResource);
  assert.equal((retryResource!.metadata as Record<string, unknown>).annotations && ((retryResource!.metadata as Record<string, unknown>).annotations as Record<string, string>)["assets.atlas.zhejianglab.org/work-ref"], resource.metadata.annotations["assets.atlas.zhejianglab.org/work-ref"]);
  assert.equal((retryResource!.spec as Record<string, unknown>).policyRef, "cds-public-moc-v1");
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
