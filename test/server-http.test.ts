import { fitsMoc } from "./reviewed-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { testArtifactRoot } from "./test-data-root.js";

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

test("hard cutover exposes no legacy products, geometry, packages or direct downloads", async context => {
  const port=await freePort(), contentRoot=await mkdtemp(path.join(os.tmpdir(),"empty-public-"));
  const child=spawn(process.execPath,[path.resolve("node_modules/tsx/dist/cli.mjs"),"server/server.ts"],{env:{...process.env,HOST:"127.0.0.1",PORT:String(port),ASSETS_CONTENT_ROOT:contentRoot,PUBLIC_SITE_ROOT:path.resolve("site/public"),ASSETS_WAREHOUSE_ES_URL:""},stdio:"ignore"});
  context.after(()=>stopChild(child));const base=`http://127.0.0.1:${port}`;await waitFor(`${base}/healthz`,child);
  for(const [route,key] of [["assets","files"],["surveys","surveys"],["products","products"],["coverage/catalog","layers"],["resource-packages/catalog.json","packages"],["releases","releases"]]) {
    const response=await fetch(`${base}/api/v1/${route}`);assert.equal(response.status,200);assert.deepEqual((await response.json() as Record<string,unknown>)[key!],[]);
  }
  for(const route of ["assets/manifest-canonical/download","assets/manifest-canonical/preview","coverage/layers/desi-dr1-spectra-footprint/moc.fits","resource-packages/public-euclid-footprints/versions/3.0.0/download"])
    assert.equal((await fetch(`${base}/api/v1/${route}`)).status,404);
  for(const route of ["access/region-query","coverage/reverse-lookup"])
    assert.equal((await fetch(`${base}/api/v1/${route}`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,401);
  assert.equal((await fetch(`${base}/fonts/NotoSans-Regular.ttf`)).status,200);
});

test("admin endpoints require a token and expose the configured control-plane boundary", {
  skip: process.env.ASSET_WORKTREE_ROOT ? "requires the local synthetic control-plane baseline" : false,
}, async (context) => {
  const port = await freePort();
  const childEnv = { ...process.env };
  delete childEnv.ASSET_WORKTREE_ROOT;
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    cwd: process.cwd(),
    env: { ...childEnv, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site"), ASSETS_ADMIN_ENABLED: "true", ASSETS_ADMIN_TOKEN: "test-admin-token", ASSETS_KUBE_API_URL: "http://127.0.0.1:9" },
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

  const overview = await fetch(`http://127.0.0.1:${port}/api/v1/admin/overview`, { headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(overview.status, 200);
  const overviewText = await overview.text();
  const overviewBody = JSON.parse(overviewText) as { schemaVersion: number; totals: { products: number }; readiness: { capabilityCounts: { coverage: number; unit: number; file: number } }; surveys: Array<{ readiness?: unknown; releases: Array<{ readiness?: unknown; products: Array<{ readiness?: { draft?: unknown; published?: unknown } }> }> }>; connectors: unknown[] };
  assert.equal(overviewBody.schemaVersion, 1);
  assert.equal(overviewBody.totals.products, productBody.products.length);
  assert.ok(overviewBody.readiness.capabilityCounts.coverage >= 0);
  assert.ok(overviewBody.surveys.length > 0);
  assert.ok(overviewBody.surveys.some((survey) => survey.readiness && survey.releases.some((release) => release.readiness && release.products.some((product) => product.readiness?.draft))));
  assert.doesNotMatch(overviewText, /normalized-scan|taskSnapshot|\/var\/lib|elasticsearch|input-manifest/i);

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
  const outputBytes = { moc: fitsMoc([{order:8,pixel:1},{order:8,pixel:2}]), query: Buffer.from(JSON.stringify({ order: 8, ordering: "NESTED", pixels: [1, 2] })), preview: Buffer.from(JSON.stringify({ order: 4, ordering: "NESTED", pixels: [0] })) };
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
  const detailBody = await detail.json() as { surveyFacts?: { surveyId: string; surveyName: string; mission: string; surveyDescription: string; surveyColor: string; surveyModalities: string[] }; registrationDefaults?: { releaseId?: string; releaseLabel?: string; productName?: string; modality?: string } };
  assert.equal(detailBody.surveyFacts?.surveyId, "jwst");
  assert.equal(detailBody.surveyFacts?.surveyName, "JWST");
  assert.ok(detailBody.surveyFacts?.mission);
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
  assert.deepEqual(registered.product.draft.publicSurvey, {
    name: detailBody.surveyFacts!.surveyName,
    mission: detailBody.surveyFacts!.mission,
    description: detailBody.surveyFacts!.surveyDescription,
    color: detailBody.surveyFacts!.surveyColor,
    modalities: detailBody.surveyFacts!.surveyModalities,
  });
  assert.equal(registered.request.productId, registered.product.productId);
  assert.equal(registered.request.workKey, `product:${registered.product.productId}`);

  const execution = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${registered.product.productId}/executions`, { method: "POST", headers, body: JSON.stringify({ revision: 1, executionId: "moc-output-check-1", stepId: "outputs", status: "passed", tool: { name: "moc-core", version: "1.1.0" }, inputs: [{ label: "locked source", sha256: "a".repeat(64), sizeBytes: 11 }], outputs: [{ label: "query projection", sha256: "b".repeat(64), sizeBytes: 2 }], checks: [{ id: "output-integrity", status: "passed" }] }) });
  assert.equal(execution.status, 201);
  const executionBody = await execution.json() as { product: { executionEvidence?: Array<{ executionId: string }> } };
  assert.equal(executionBody.product.executionEvidence?.at(-1)?.executionId, "moc-output-check-1");

  const review = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products?view=surveys`, { headers });
  const reviewBody = await review.json() as { surveys: Array<{ id: string; unmatchedBuilds?: unknown[]; unmatchedProducts?: Array<{ productId: string }> }> };
  assert.equal(reviewBody.surveys.some((survey) => survey.id === "__moc-builds__"), false);
  assert.ok(reviewBody.surveys.find((survey) => survey.id === "__unmatched__")?.unmatchedProducts?.some((product) => product.productId === registered.product.productId));

  const registeredDetail = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${registered.product.productId}`, { headers });
  assert.equal(registeredDetail.status, 200);
  const registeredDetailBody = await registeredDetail.json() as { product: { revision: number; readiness?: { draft?: { gaps?: string[] } } } };
  const reviewProduct = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${registered.product.productId}/review`, { method: "POST", headers, body: JSON.stringify({ revision: registeredDetailBody.product.revision, acceptedGaps: registeredDetailBody.product.readiness?.draft?.gaps ?? [] }) });
  assert.equal(reviewProduct.status, 200);

  const publish = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${registered.product.productId}/publish`, { method: "POST", headers, body: JSON.stringify({ revision: 1 }) });
  assert.equal(publish.status, 202, await publish.text());
  const surveysResponse = await fetch(`http://127.0.0.1:${port}/api/v1/surveys`);
  assert.equal(surveysResponse.status, 200);
  const surveys = await surveysResponse.json() as { surveys: Array<{ id: string; releases: Array<{ id: string; products: Array<{ productId?: string; name: string; sourceUrl: string }> }> }> };
  const dynamic = surveys.surveys.find((survey) => survey.id === "jwst");
  assert.equal(dynamic,undefined,"queued publication must not become public");
  const verify = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${registered.product.productId}/verify-build`, { method: "POST", headers, body: JSON.stringify({ revision: 1 }) });
  assert.equal(verify.status, 200);
  const verified = await verify.json() as { verification: { passed: boolean }; product: { review?: unknown; executionEvidence: Array<{ status: string }>; readiness: { draft: { gaps: string[] } } } };
  assert.equal(verified.verification.passed, false, "fixture deliberately has no locked source snapshot");
  assert.equal(verified.product.review, undefined, "failed validation invalidates an existing review");
  assert.equal(verified.product.executionEvidence.at(-1)?.status, "failed");
  assert.ok(verified.product.readiness.draft.gaps.includes("output-validation-missing"));
  const blockedReview = await fetch(`http://127.0.0.1:${port}/api/v1/admin/products/${registered.product.productId}/review`, { method: "POST", headers, body: JSON.stringify({ revision: 1, acceptedGaps: verified.product.readiness.draft.gaps }) });
  assert.equal(blockedReview.status, 409, "prior successful receipts cannot override the latest failed verification");
});

test("admin connector probe route checks an authorized PVC and persists its phase", async (context) => {
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
  const listedBody = await listed.json() as { connectors: Array<{ name: string; phase: string; checkedAt?: string; scope?: { kind?: string }; inventory?: { state?: string; denominatorKnown?: boolean; observedObjectCount?: number }; usage?: { scanTaskCount?: number } }> };
  assert.equal(listedBody.connectors[0]?.phase, "READY");
  assert.match(listedBody.connectors[0]?.checkedAt ?? "", /^20\d\d-/);
  assert.equal(listedBody.connectors[0]?.scope?.kind, "pvc");
  assert.equal(listedBody.connectors[0]?.inventory?.state, "unknown");
  assert.equal(listedBody.connectors[0]?.inventory?.denominatorKnown, false);
  const missing = await fetch(`http://127.0.0.1:${port}/api/v1/admin/connectors/missing/probe`, { method: "POST", headers: { Authorization: "Bearer test-admin-token" } });
  assert.equal(missing.status, 404);
});

