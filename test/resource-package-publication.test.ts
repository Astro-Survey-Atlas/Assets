import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DynamicResourcePackageStore } from "../server/resource-package-publication.js";
import type { MocPublication } from "../server/moc-build.js";
import type { ProductRecord } from "../server/products.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function publication(contentRoot: string, buildName: string, bytes: Buffer, publishedAt: string): MocPublication {
  const relative = `moc-releases/${buildName}`;
  return {
    schemaVersion: 1,
    id: `moc-publication-${buildName}`,
    buildName,
    productId: "jwst-product",
    surveyId: "jwst",
    releaseId: "jwst-dr1",
    product: "JWST DR1",
    layerId: `moc-jwst-dr1-${buildName}`,
    sourceUrl: "https://alasky.cds.unistra.fr/jwst/dr1/moc.fits",
    publishedAt,
    files: {
      moc: { path: `${relative}/moc.fits`, sha256: sha256(bytes), sizeBytes: bytes.length, mediaType: "application/fits" },
      query: { path: `${relative}/query.json`, sha256: "a".repeat(64), sizeBytes: 0, mediaType: "application/json" },
      preview: { path: `${relative}/preview.json`, sha256: "b".repeat(64), sizeBytes: 0, mediaType: "application/json" },
    },
  };
}

function product(): ProductRecord {
  return {
    productId: "jwst-product",
    revision: 1,
    publishedRevision: 1,
    updatedAt: "2026-08-31T00:00:00.000Z",
    publishedAt: "2026-08-31T00:00:00.000Z",
    contentSha256: "c".repeat(64),
    draft: {
      productId: "jwst-product", surveyId: "jwst", releaseId: "jwst-dr1", name: "JWST DR1", modality: "infrared", mode: "native-moc", coverageRole: "footprint_extent", dataOrigin: "observed", sourceTier: "third_party_moc", sourceUrl: "https://archive.example/jwst", presentation: { summaryMarkdown: "", methodologyMarkdown: "", limitationsMarkdown: "", flow: { nodes: [], edges: [] } },
    },
    published: {
      productId: "jwst-product", surveyId: "jwst", releaseId: "jwst-dr1", name: "JWST DR1", modality: "infrared", mode: "native-moc", coverageRole: "footprint_extent", dataOrigin: "observed", sourceTier: "third_party_moc", sourceUrl: "https://archive.example/jwst", publicSurvey: { name: "JWST", mission: "James Webb Space Telescope", description: "Published JWST coverage", color: "#42d5c4", modalities: ["infrared", "imaging"] }, publicRelease: { label: "DR1", kind: "release" }, publicDescription: "JWST DR1 public coverage", presentation: { summaryMarkdown: "", methodologyMarkdown: "", limitationsMarkdown: "", flow: { nodes: [], edges: [] } },
    },
  };
}

test("dynamic publications produce immutable hash-addressed Resource Package v3 archives", async () => {
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-dynamic-package-"));
  const buildRoot = path.join(contentRoot, "moc-releases", "jwst-build");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(buildRoot, { recursive: true }));
  const moc = await readFile(path.resolve("artifacts/public-survey-footprints/layers/euclid-q1-deep-fields-image-extent/euclid-q1-deep-fields-image-extent.moc.fits"));
  const query = Buffer.from(JSON.stringify({ order: 8, pixels: [64, 65] }));
  const preview = Buffer.from(JSON.stringify({ order: 4, pixels: [4] }));
  await writeFile(path.join(buildRoot, "moc.fits"), moc);
  await writeFile(path.join(buildRoot, "query.json"), query);
  await writeFile(path.join(buildRoot, "preview.json"), preview);
  const first = publication(contentRoot, "jwst-build", moc, "2026-08-31T00:00:00.000Z");
  first.files.query!.sha256 = sha256(query); first.files.query!.sizeBytes = query.length;
  first.files.preview!.sha256 = sha256(preview); first.files.preview!.sizeBytes = preview.length;
  const store = new DynamicResourcePackageStore(contentRoot);
  await store.sync([first], [product()], (file) => path.join(contentRoot, file.path));
  const initial = store.list();
  assert.equal(initial.length, 1);
  assert.equal(initial[0]!.surveyId, "jwst");
  assert.equal(initial[0]!.version, "3.0.0");
  assert.match(initial[0]!.id, /^public-jwst-footprints-[a-f0-9]{16}$/);
  const archive = store.assets()[0]!;
  assert.equal(archive.sha256, initial[0]!.sha256);
  assert.equal((await stat(path.join(contentRoot, archive.path))).size, archive.sizeBytes);
  assert.equal(sha256(await readFile(path.join(contentRoot, archive.path))), archive.sha256);

  const changedMoc = await readFile(path.resolve("artifacts/public-survey-footprints/layers/desi-dr1-spectra-footprint/desi-dr1-spectra-footprint.moc.fits"));
  await writeFile(path.join(buildRoot, "moc.fits"), changedMoc);
  const second = publication(contentRoot, "jwst-build-v2", changedMoc, "2026-09-01T00:00:00.000Z");
  second.files.query!.sha256 = sha256(query); second.files.query!.sizeBytes = query.length;
  second.files.preview!.sha256 = sha256(preview); second.files.preview!.sizeBytes = preview.length;
  await writeFile(path.join(contentRoot, "moc-releases", "jwst-build-v2", "query.json"), query).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(contentRoot, "moc-releases", "jwst-build-v2"), { recursive: true });
    await writeFile(path.join(contentRoot, "moc-releases", "jwst-build-v2", "query.json"), query);
    await writeFile(path.join(contentRoot, "moc-releases", "jwst-build-v2", "preview.json"), preview);
    await writeFile(path.join(contentRoot, "moc-releases", "jwst-build-v2", "moc.fits"), changedMoc);
  });
  await store.sync([first, second], [product()], (file) => path.join(contentRoot, file.path));
  const updated = store.list();
  assert.equal(updated.length, 2);
  assert.equal(updated.filter((entry) => entry.deprecated).length, 1);
  assert.equal(updated.filter((entry) => !entry.deprecated).length, 1);
  assert.notEqual(updated[0]!.sha256, updated[1]!.sha256);
});
