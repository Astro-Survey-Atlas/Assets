import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { MocBuildService, MocBuildStore } from "../server/moc-build.js";
import { ProductStore } from "../server/products.js";
import { sha256 } from "../server/native-moc.js";
import { MAST_HST_DISCOVERY_POLICY } from "../server/moc-discovery.js";
import { fitsMoc, reviewedFixture } from "./reviewed-fixture.js";
import { PublicReleasePublisher } from "../server/public-release-publication.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";

const LAYER_ID = "euclid-euclid-q1-euclid-q1-vis-moc";
const BUILD_NAME = "hst-observation-build";
const DISCOVERY_NAME = "hst-observation-discovery";
const OBSID = "90001";
const ADMIN_TOKEN = "fixture-admin-token";
const OWNED_LABELS = {
  "app.kubernetes.io/managed-by": "astro-survey-atlas-assets",
  "astro.zhejianglab.org/resource-kind": "moc-discovery",
};

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address() as net.AddressInfo;
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function hstDiscoveryResource(): Record<string, any> {
  const scope = {
    ordering: "NESTED",
    order: 8,
    cells: [163327],
    q1MocSha256: "a".repeat(64),
    hstMocSha256: "b".repeat(64),
  };
  const observationQuery = {
    coordinateFrame: "ICRS",
    cone: { raDeg: 45, decDeg: 2, radiusDeg: 0.1 },
    scope,
  };
  const request = { namespace: "atlas-warehouse", name: DISCOVERY_NAME, uid: "hst-request-uid-001" };
  const snapshotBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: "mast-hst-observations",
    request,
    observationQuery,
    result: { candidateCount: 1, truncated: false, queryExhausted: true },
    source: { collection: "HST", dataproductType: "image", dataRights: "PUBLIC" },
    Tables: [{
      Columns: ["obsid", "obs_collection", "dataproduct_type", "dataRights"].map((dataIndex) => ({ dataIndex })),
      Rows: [[OBSID, "HST", "image", "PUBLIC"]],
    }],
  }));
  const snapshotSha = sha256(snapshotBytes);
  return {
    apiVersion: "atlas.zhejianglab.org/v1alpha1",
    kind: "MocDiscoveryRequest",
    metadata: {
      ...request,
      labels: OWNED_LABELS,
      annotations: {
        "assets.atlas.zhejianglab.org/mast-hst-scope-ref": JSON.stringify({
          publishedLayerId: LAYER_ID,
          stagedBuildName: BUILD_NAME,
          order: 8,
          componentIndex: 0,
        }),
        "assets.atlas.zhejianglab.org/mast-hst-component-id": "C01",
        "assets.atlas.zhejianglab.org/work-ref": JSON.stringify({ key: "survey:hst:hst-mast-observations", title: "HST observation" }),
      },
    },
    spec: { policyRef: MAST_HST_DISCOVERY_POLICY, query: { surveyName: "Hubble Space Telescope", observationQuery } },
    status: {
      phase: "SUCCEEDED",
      candidateCount: 1,
      observationSummary: {
        kind: "mast-hst-observations",
        request,
        candidates: [{ obsid: OBSID, instrument: "ACS/WFC", filters: "F814W" }],
        candidateCount: 1,
        truncated: false,
        queryExhausted: true,
        snapshot: {
          objectKey: `discovery-evidence/observations/atlas-warehouse/${request.name}/${request.uid}/${snapshotSha}.json`,
          sha256: snapshotSha,
          sizeBytes: snapshotBytes.length,
        },
      },
    },
  };
}

async function writeLocked(root: string, ref: string, bytes: Buffer): Promise<{ ref: string; sha256: string; sizeBytes: number }> {
  const target = path.join(root, ref);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { ref, sha256: sha256(bytes), sizeBytes: bytes.length };
}

test("HST admin HTTP routes enforce request fields, protect summaries, and resolve against current release records", async (t) => {
  const fixture = await reviewedFixture({
    productId: "euclid-q1-vis-test-product",
    surveyId: "euclid",
    releaseId: "euclid-q1",
    productName: "Euclid Q1 VIS",
    layerId: LAYER_ID,
  });
  const publisher = new PublicReleasePublisher(fixture.options);
  const plan = await publisher.plan();
  const run = await publisher.submit({
    planId: plan.planId,
    expectedBaselineSha256: plan.baselineBundle.sha256,
    surveyIds: ["euclid"],
    productIds: ["euclid-q1-vis-test-product"],
  });
  assert.equal((await publisher.execute(run.runId)).status, "published");
  const installed = path.join(fixture.base, "installed");
  await syncReleaseFromObjectStore(fixture.store, installed);

  const evidenceRoot = path.join(fixture.base, "evidence");
  const contentRoot = fixture.contentRoot;
  await mkdir(evidenceRoot, { recursive: true });
  const products = new ProductStore(undefined, contentRoot);
  await products.initialize(path.join(installed, "current"));
  const product = await products.createMocProduct({
    surveyId: "hst",
    surveyName: "Hubble Space Telescope",
    mission: "HST",
    surveyDescription: "Selected public observation footprints.",
    surveyColor: "#79a9ff",
    surveyModalities: ["imaging"],
    releaseId: "hst-mast-observations",
    releaseLabel: "MAST HST observation snapshots",
    releaseKind: "observation_snapshot",
    productName: "MAST HST observation fixture",
    productDescription: "One selected public HST image observation.",
    modality: "imaging",
    sourceUrl: "https://archive.stsci.edu/missions-and-data/hst",
    geometrySourceUrl: "https://mast.stsci.edu/api/v0/invoke",
    geometrySourceLabel: "MAST CAOM metadata",
    dataOrigin: "observed",
    sourceTier: "official_geometry",
    coverageRole: "image_extent",
    mode: "regions",
    coverageEvidence: {
      evidenceKind: "observation-footprint",
      sourceIdentity: `MAST obsid ${OBSID}`,
      sourceSnapshotSha256: "c".repeat(64),
      precision: "estimated",
      completeness: "incomplete",
      scienceFileScan: "not-scanned",
      summary: "Estimated HST observation footprint; this is not a complete archive inventory.",
    },
  });

  const builds = new MocBuildStore(contentRoot, undefined, evidenceRoot);
  const nativeBytes = fitsMoc([{ order: 8, pixel: 163327 }]);
  const nativeMoc = await writeLocked(evidenceRoot, "staged/hst/moc.fits", nativeBytes);
  const source = await writeLocked(evidenceRoot, "staged/hst/source.json", Buffer.from("{}"));
  const query = await writeLocked(evidenceRoot, "staged/hst/query.json", Buffer.from("{}"));
  const preview = await writeLocked(evidenceRoot, "staged/hst/preview.json", Buffer.from("{}"));
  const statistics = await writeLocked(evidenceRoot, "staged/hst/statistics.json", Buffer.from("{}"));
  await builds.createVerifiedEvidenceBuild({
    name: BUILD_NAME,
    layerId: `hst-mast-observation-${OBSID}`,
    candidateId: OBSID,
    candidateTitle: "MAST HST observation fixture",
    surveyId: "hst",
    releaseId: "hst-mast-observations",
    productId: product.productId,
    source: { url: "https://mast.stsci.edu/api/v0/invoke", snapshotSha256: source.sha256, sizeBytes: source.sizeBytes, evidenceRef: source.ref },
    outputs: {
      moc: nativeMoc,
      query: { ...query, order: 8 },
      preview: { ...preview, order: 4 },
      statistics,
      cellCount: 1,
      availableOrders: [8],
      maxOrder: 8,
    },
  });

  const discovery = hstDiscoveryResource();
  const createdResources: Array<Record<string, any>> = [];
  const kubePath = `/apis/atlas.zhejianglab.org/v1alpha1/namespaces/atlas-warehouse/mocdiscoveryrequests`;
  const kube = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://kube.local");
    if (request.method === "GET" && url.pathname === `${kubePath}/${DISCOVERY_NAME}`) return json(response, 200, discovery);
    if (request.method === "GET" && url.pathname === "/api/v1/namespaces/atlas-system/pods") return json(response, 200, { items: [] });
    if (request.method === "GET" && url.pathname === kubePath) return json(response, 200, { items: [discovery] });
    if (request.method === "POST" && url.pathname === kubePath) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => body += chunk);
      request.on("end", () => {
        const created = JSON.parse(body) as Record<string, any>;
        const resource = {
          ...created,
          metadata: { ...created.metadata, namespace: "atlas-warehouse", uid: "created-hst-request-001", creationTimestamp: new Date().toISOString() },
          status: { phase: "PENDING" },
        };
        createdResources.push(resource);
        json(response, 201, resource);
      });
      return;
    }
    json(response, 404, { message: "not found" });
  });
  await new Promise<void>((resolve) => kube.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => kube.close(() => resolve())));
  const kubeUrl = `http://127.0.0.1:${(kube.address() as net.AddressInfo).port}`;
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server/server.ts"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ASSET_RELEASE_ROOT: path.join(installed, "current"),
      ASSETS_CONTENT_ROOT: contentRoot,
      ASSETS_EVIDENCE_ROOT: evidenceRoot,
      ASSETS_ADMIN_ENABLED: "true",
      ASSETS_ADMIN_TOKEN: ADMIN_TOKEN,
      ASSETS_KUBE_API_URL: kubeUrl,
      ASSETS_KUBE_TOKEN: "fixture-kube-token",
      ASSETS_WAREHOUSE_ES_URL: "",
      ASSETS_LLM_API_KEY: "",
      ASSETS_ROLE: "legacy",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (chunk) => logs += chunk);
  child.stdout.on("data", (chunk) => logs += chunk);
  t.after(async () => {
    if (child.exitCode === null) await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
    await rm(fixture.base, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* wait until the child server listens */ }
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const auth = { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };

  const strictFields = await fetch(`${base}/api/v1/admin/moc-discovery`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      policyRef: MAST_HST_DISCOVERY_POLICY,
      publishedLayerId: LAYER_ID,
      stagedBuildName: BUILD_NAME,
      order: 8,
      componentIndex: 0,
      observationQuery: {},
    }),
  });
  assert.equal(strictFields.status, 400);
  assert.equal(createdResources.length, 0, "invalid HST fields do not reach Kubernetes");

  const summaryResponse = await fetch(`${base}/api/v1/admin/moc-discovery/${DISCOVERY_NAME}`, { headers: auth });
  assert.equal(summaryResponse.status, 200);
  const summaryBody = await summaryResponse.json();
  const summaryText = JSON.stringify(summaryBody);
  assert.equal(summaryBody.request.status.observationSummary.candidates[0].obsid, OBSID);
  assert.doesNotMatch(summaryText, /objectKey|Tables|Rows|discovery-evidence\/observations/);

  const resolvedRequest = await fetch(`${base}/api/v1/admin/moc-discovery`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      policyRef: MAST_HST_DISCOVERY_POLICY,
      publishedLayerId: LAYER_ID,
      stagedBuildName: BUILD_NAME,
      order: 8,
      componentIndex: 0,
    }),
  });
  assert.equal(resolvedRequest.status, 201, logs);
  assert.equal(createdResources.length, 1);
  const resolvedBody = await resolvedRequest.json() as { request: { releaseId: string; workKey: string } };
  const importedReleaseId = "hst-mast-observations";
  assert.equal(product.draft.releaseId, importedReleaseId);
  assert.equal(resolvedBody.request.releaseId, importedReleaseId);
  assert.equal(resolvedBody.request.workKey, "survey:hst:hst-mast-observations:moc");
  assert.equal(createdResources[0]!.metadata.labels["astro.zhejianglab.org/release-id"], importedReleaseId);
  const createdWork = JSON.parse(createdResources[0]!.metadata.annotations["assets.atlas.zhejianglab.org/work-ref"]);
  assert.equal(createdWork.releaseId, importedReleaseId);
  assert.equal(createdWork.key, resolvedBody.request.workKey);
  const requestQuery = createdResources[0]!.spec.query.observationQuery;
  assert.equal(requestQuery.coordinateFrame, "ICRS");
  assert.deepEqual(requestQuery.scope.cells, [163327]);
  assert.equal(requestQuery.scope.order, 8);
  assert.equal(requestQuery.scope.q1MocSha256, fixture.moc.sha256);
  assert.equal(requestQuery.scope.hstMocSha256, sha256(nativeBytes));

  const beforeImport = createdResources.length;
  const s3Required = await fetch(`${base}/api/v1/admin/moc-builds`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ discoveryRequestName: DISCOVERY_NAME, candidateId: OBSID }),
  });
  assert.equal(s3Required.status, 503);
  assert.equal(createdResources.length, beforeImport, "the local no-S3 branch does not submit or persist a scan");
});
