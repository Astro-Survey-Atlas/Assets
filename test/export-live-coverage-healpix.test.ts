import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeNativeMoc, sha256 } from "../server/native-moc.js";
import { exportLiveCoverageHealpix } from "../scripts/export-live-coverage-healpix.js";
import { fitsMoc } from "./reviewed-fixture.js";

interface MockLayer {
  layerId: string;
  surveyId: string;
  releaseId: string;
  productId: string;
  product: string;
  moc: Buffer;
  revision?: string;
  precision: "exact" | "estimated";
  completeness: "complete" | "incomplete" | "unknown";
}

async function mockAssets(options: {
  layers: MockLayer[];
  corruptHeaderFor?: string;
  changedSnapshot?: boolean;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let healthRequests = 0;
  let catalogRequests = 0;
  const layers = options.layers.map((layer) => {
    const native = decodeNativeMoc(layer.moc);
    return {
      surveyId: layer.surveyId,
      releaseId: layer.releaseId,
      productId: layer.productId,
      product: layer.product,
      layerId: layer.layerId,
      maxOrder: native.maxOrder,
      availableOrders: [4, 8],
      ...(layer.revision !== undefined ? { revision: layer.revision } : {}),
      sourceEvidence: { precision: layer.precision, completeness: layer.completeness },
    };
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      healthRequests += 1;
      const changed = options.changedSnapshot && healthRequests > 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "astro-survey-atlas-assets", bundle: { id: changed ? "bundle-next" : "bundle-current", sha256: "a".repeat(64) } }));
      return;
    }
    if (url.pathname === "/api/v1/coverage/catalog") {
      catalogRequests += 1;
      const changed = options.changedSnapshot && catalogRequests > 1;
      response.writeHead(200, { "content-type": "application/json", etag: changed ? '"catalog-next"' : '"catalog-current"' });
      response.end(JSON.stringify({
        schemaVersion: 2,
        coordinateFrame: "ICRS",
        ordering: "NESTED",
        revision: changed ? "root-catalog-next" : "root-catalog-current",
        publicReleaseId: changed ? "release-next" : "release-current",
        layers,
      }));
      return;
    }
    const match = /^\/api\/v1\/coverage\/layers\/([^/]+)\/moc\.fits$/.exec(url.pathname);
    if (match?.[1]) {
      const layerId = decodeURIComponent(match[1]);
      const source = options.layers.find((layer) => layer.layerId === layerId);
      if (!source) {
        response.writeHead(404);
        response.end();
        return;
      }
      const digest = options.corruptHeaderFor === layerId ? "b".repeat(64) : sha256(source.moc);
      response.writeHead(200, { "content-type": "application/fits", "x-content-sha256": digest });
      response.end(source.moc);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function sampleLayers(): MockLayer[] {
  const fine = fitsMoc([{ order: 8, pixel: 20000 }]);
  const coarse = fitsMoc([{ order: 7, pixel: 1000 }]);
  return [
    { layerId: "demo-fine", surveyId: "demo", releaseId: "dr1", productId: "product-fine", product: "Fine layer", moc: fine, revision: decodeNativeMoc(fine).revision, precision: "exact", completeness: "complete" },
    { layerId: "demo-coarse", surveyId: "demo", releaseId: "dr1", productId: "product-coarse", product: "Coarse layer", moc: coarse, precision: "estimated", completeness: "incomplete" },
  ];
}

test("live exporter writes per-survey O4/O8 unions and native provenance", async () => {
  const fixture = await mockAssets({ layers: sampleLayers() });
  const parent = await mkdtemp(path.join(tmpdir(), "live-healpix-export-"));
  const outputDirectory = path.join(parent, "export");
  try {
    const summary = await exportLiveCoverageHealpix({ baseUrl: fixture.baseUrl, outputDirectory, now: () => "2026-09-25T00:00:00.000Z" });
    assert.equal(summary.surveys.length, 1);
    assert.equal(summary.surveys[0]?.layerCount, 2);
    assert.equal(summary.catalogRevision, "root-catalog-current");
    const o4Path = path.join(outputDirectory, "demo/healpix/order4.json");
    const o8Path = path.join(outputDirectory, "demo/healpix/order8.json");
    const o4 = JSON.parse(await readFile(o4Path, "utf8")) as { layers: Array<{ layerId: string; cells: number[]; precision: string; completeness: string }>; surveyUnion: { cells: number[]; precision: string; completeness: string; omittedLayers: unknown[] } };
    const o8 = JSON.parse(await readFile(o8Path, "utf8")) as { layers: Array<{ layerId: string; cells: number[] }>; surveyUnion: { cells: number[]; completeness: string; omittedLayers: Array<{ layerId: string; reason: string }> } };
    assert.deepEqual(o4.surveyUnion.cells, [15, 78]);
    assert.equal(o4.surveyUnion.precision, "estimated");
    assert.equal(o4.surveyUnion.completeness, "incomplete");
    assert.equal(o4.layers.find((layer) => layer.layerId === "demo-coarse")?.precision, "estimated");
    assert.equal(o4.layers.find((layer) => layer.layerId === "demo-coarse")?.completeness, "incomplete");
    assert.deepEqual(o8.surveyUnion.cells, [20000]);
    assert.equal(o8.surveyUnion.completeness, "incomplete");
    assert.deepEqual(o8.surveyUnion.omittedLayers.map((layer) => layer.layerId), ["demo-coarse"]);
    assert.match(o8.surveyUnion.omittedLayers[0]!.reason, /Native MOC maximum is O7/);
    const provenance = JSON.parse(await readFile(path.join(outputDirectory, "demo/provenance.json"), "utf8")) as { layers: Array<{ layerId: string; nativeRevision: string; catalogRevisionStatus: string; catalogCoverageRevision: { value: string } | null; nativeAvailableOrders: number[] }> };
    const fine = provenance.layers.find((layer) => layer.layerId === "demo-fine")!;
    const coarse = provenance.layers.find((layer) => layer.layerId === "demo-coarse")!;
    assert.equal(fine.catalogRevisionStatus, "matched");
    assert.equal(fine.nativeRevision, fine.catalogCoverageRevision?.value);
    assert.equal(coarse.catalogRevisionStatus, "missing");
    assert.equal(coarse.catalogCoverageRevision, null);
    assert.deepEqual(coarse.nativeAvailableOrders, [7]);
    assert.deepEqual(summary.surveys[0]?.orders.map((order) => order.unionCellCount), [2, 1]);
  } finally {
    await fixture.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("live exporter rejects a MOC response whose advertised checksum does not match", async () => {
  const layers = sampleLayers();
  const fixture = await mockAssets({ layers, corruptHeaderFor: "demo-fine" });
  const parent = await mkdtemp(path.join(tmpdir(), "live-healpix-checksum-"));
  const outputDirectory = path.join(parent, "export");
  try {
    await assert.rejects(exportLiveCoverageHealpix({ baseUrl: fixture.baseUrl, outputDirectory }), /MOC response checksum mismatch/);
    await assert.rejects(readFile(outputDirectory), { code: "ENOENT" });
  } finally {
    await fixture.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("live exporter rejects an available catalog native revision that differs from the decoded MOC", async () => {
  const layers = sampleLayers();
  layers[0]!.revision = "f".repeat(64);
  const fixture = await mockAssets({ layers });
  const parent = await mkdtemp(path.join(tmpdir(), "live-healpix-revision-"));
  const outputDirectory = path.join(parent, "export");
  try {
    await assert.rejects(exportLiveCoverageHealpix({ baseUrl: fixture.baseUrl, outputDirectory }), /native revision mismatch/);
    await assert.rejects(readFile(outputDirectory), { code: "ENOENT" });
  } finally {
    await fixture.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("live exporter discards staged files when the ending public identity changes", async () => {
  const fixture = await mockAssets({ layers: sampleLayers(), changedSnapshot: true });
  const parent = await mkdtemp(path.join(tmpdir(), "live-healpix-snapshot-"));
  const outputDirectory = path.join(parent, "export");
  try {
    await assert.rejects(exportLiveCoverageHealpix({ baseUrl: fixture.baseUrl, outputDirectory }), /public identity changed/);
    await assert.rejects(readFile(outputDirectory), { code: "ENOENT" });
  } finally {
    await fixture.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("live exporter refuses an existing output directory without changing it", async () => {
  const fixture = await mockAssets({ layers: sampleLayers() });
  const parent = await mkdtemp(path.join(tmpdir(), "live-healpix-existing-"));
  const outputDirectory = path.join(parent, "existing");
  try {
    await mkdir(outputDirectory);
    const sentinel = path.join(outputDirectory, "keep.txt");
    await writeFile(sentinel, "user data");
    await assert.rejects(exportLiveCoverageHealpix({ baseUrl: fixture.baseUrl, outputDirectory }), /already exists/);
    assert.equal(await readFile(sentinel, "utf8"), "user data");
  } finally {
    await fixture.close();
    await rm(parent, { recursive: true, force: true });
  }
});
