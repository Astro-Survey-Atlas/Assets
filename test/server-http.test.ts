import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
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
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_SITE_ROOT: path.resolve("site") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${port}/healthz`, child);

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

  const surveysResponse = await fetch(`http://127.0.0.1:${port}/api/v1/surveys`);
  assert.equal(surveysResponse.status, 200);
  const surveys = await surveysResponse.json() as {
    surveys: Array<{ id: string; modalities: string[]; statistics: { publicProducts: number; acquired: number }; releases: Array<{ products: Array<{ status: string; reason?: string }> }>; assets: Array<{ surveyId?: string; downloadUrl: string }> }>;
    sharedAssets: Array<{ surveyId?: string; downloadUrl: string }>;
  };
  assert.equal(surveys.surveys.length, 14);
  const csst = surveys.surveys.find((survey) => survey.id === "csst");
  assert.ok(csst);
  assert.deepEqual(csst.modalities.sort(), ["catalog", "imaging", "photometry", "simulation"]);
  assert.equal(csst.releases[0]?.products[0]?.status, "acquired");
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
