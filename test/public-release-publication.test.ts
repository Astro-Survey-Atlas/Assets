import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import assert from "node:assert/strict";
import { test } from "node:test";

import { FilesystemArtifactStore } from "../server/artifact-store.js";
import { PublicReleasePublisher, type PublicReleasePublisherOptions } from "../server/public-release-publication.js";
import type { MocPublication, MocPublicationFile } from "../server/moc-build.js";
import type { DynamicResourcePackageAsset, DynamicResourcePackageEntry } from "../server/resource-package-publication.js";
import type { ProductRecord } from "../server/products.js";
import { publicReleaseBundleDigest, type LoadedCatalog } from "../server/catalog.js";
import { type PublicAssetManifest } from "../server/types.js";
import type { PublicAssetRecord } from "../server/types.js";

interface TestHarness {
  options: PublicReleasePublisherOptions;
  publications: MocPublication[];
  products: ProductRecord[];
  packageEntries: DynamicResourcePackageEntry[];
  packageAssets: DynamicResourcePackageAsset[];
}

async function harness(): Promise<TestHarness> {
  const base = await mkdtemp(path.join(tmpdir(), "release-publisher-"));
  const baselineRoot = path.join(base, "baseline");
  const contentRoot = path.join(base, "content");
  await mkdir(path.join(baselineRoot, "artifacts/public-survey-footprints/packages"), { recursive: true });
  await mkdir(contentRoot, { recursive: true });

  const layerFile: MocPublicationFile = { path: "moc/m42.fits", sha256: createHash("sha256").update("moc-data").digest("hex"), sizeBytes: 8, mediaType: "application/fits" };
  const mocPath = path.join(contentRoot, "moc/m42.fits");
  await mkdir(path.dirname(mocPath), { recursive: true });
  await writeFile(mocPath, "moc-data");
  const zipContent = "PK\x03\x04";
  const zipSha256 = createHash("sha256").update(zipContent).digest("hex");

  const publications: MocPublication[] = [
    {
      schemaVersion: 1,
      id: "pub-1",
      buildName: "build-1",
      productId: "product-1",
      surveyId: "m42",
      releaseId: "m42-dr1",
      product: "M42 survey",
      layerId: "m42-halpha",
      sourceUrl: "https://example.org/m42",
      publishedAt: "2026-01-01T00:00:00.000Z",
      files: { moc: layerFile },
    },
  ];

  const packageEntries: DynamicResourcePackageEntry[] = [
    {
      id: "public-m42-footprints",
      name: "M42 footprints",
      description: "M42 resource package",
      surveyId: "m42",
      modalities: ["image"],
      wavelengths: ["optical"],
      productTypes: ["footprints"],
      facilities: ["M42"],
      coverageAuthorities: ["M42"],
      accessModes: ["public"],
      releases: ["m42-dr1"],
      releaseLabels: { "m42-dr1": "DR1" },
      sources: [{ releaseId: "m42-dr1", label: "DR1", url: "https://example.org/m42", authority: "M42" }],
      version: "3.1.0",
      archiveUrl: "/api/v1/assets/package-public-m42-footprints-3-1-0/download",
      sizeBytes: 4,
      sha256: zipSha256,
      updatedAt: "2026-01-01T00:00:00.000Z",
      hidden: false,
      deprecated: false,
      replacedBy: [],
      archivePath: "resource-packages/public-m42-footprints/3.1.0/public-m42-footprints-3.1.0.zip",
      contentFingerprint: "f".repeat(64),
    },
  ];
  const packageAssets: DynamicResourcePackageAsset[] = [
    {
      id: "package-public-m42-footprints-3-1-0",
      path: "resource-packages/public-m42-footprints/3.1.0/public-m42-footprints-3.1.0.zip",
      downloadName: "public-m42-footprints-3.1.0.zip",
      sizeBytes: 4,
      sha256: zipSha256,
      surveyId: "m42",
      releaseId: "m42-dr1",
      version: "3.1.0",
      name: "M42 footprints",
    },
  ];
  const zipPath = path.join(contentRoot, packageAssets[0]!.path);
  await mkdir(path.dirname(zipPath), { recursive: true });
  await writeFile(zipPath, zipContent);

  const baselineLayerRecord: PublicAssetRecord = {
    id: "layer-legacy-moc",
    kind: "moc",
    label: "Legacy",
    description: "Legacy layer",
    path: "artifacts/public-survey-footprints/layers/legacy/moc.fits",
    downloadName: "moc.fits",
    mediaType: "application/fits",
    sizeBytes: 4,
    sha256: createHash("sha256").update("legs").digest("hex"),
    deliveryClass: "runtime",
  };
  await mkdir(path.join(baselineRoot, path.dirname(baselineLayerRecord.path)), { recursive: true });
  await writeFile(path.join(baselineRoot, baselineLayerRecord.path), "legs");
  const legacyZipBytes = "legacy-archive-bytes";

  const baselineManifest: PublicAssetManifest = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    bundle: { id: "public-survey-footprints-2026-01-01", sha256: "" },
    statistics: {
      releases: 1,
      products: 1,
      packages: 1,
      acquired: 1,
      overviewOnly: 0,
      awaitingGeometry: 0,
      footprints: 1,
      rawMocFiles: 1,
      totalBytes: 4,
      runtimeBytes: 4,
      evidenceBytes: 0,
    },
    files: [],
  };
  const catalogBytes = JSON.stringify({ schemaVersion: 3, version: "3.0.0", packages: [{ id: "public-legacy-footprints-legacy", surveyId: "m42" }] });
  const zipBytes = zipContent;
  baselineManifest.files = [
    baselineLayerRecord,
    {
      id: "packages-catalog",
      kind: "manifest",
      label: "Package catalog",
      description: "Package catalog",
      path: "artifacts/public-survey-footprints/packages/catalog.json",
      downloadName: "catalog.json",
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength(catalogBytes),
      sha256: createHash("sha256").update(catalogBytes).digest("hex"),
      deliveryClass: "runtime",
    },
    {
      id: "package-public-legacy-3-0-0",
      kind: "package",
      label: "Legacy package",
      description: "Legacy package",
      path: "artifacts/public-survey-footprints/packages/public-legacy-3.0.0.zip",
      downloadName: "public-legacy-3.0.0.zip",
      mediaType: "application/zip",
      sizeBytes: Buffer.byteLength(legacyZipBytes),
      sha256: createHash("sha256").update(legacyZipBytes).digest("hex"),
      surveyId: "m42",
      version: "3.0.0",
      deliveryClass: "runtime",
    },
  ];
  baselineManifest.bundle.sha256 = publicReleaseBundleDigest(baselineManifest.files);
  await writeFile(
    path.join(baselineRoot, "artifacts/public-survey-footprints/release-manifest.json"),
    `${JSON.stringify(baselineManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(baselineRoot, baselineManifest.files[1]!.path), catalogBytes);
  await writeFile(path.join(baselineRoot, baselineManifest.files[2]!.path), legacyZipBytes);

  const catalog = {
    root: baselineRoot,
    manifest: baselineManifest,
    files: new Map(baselineManifest.files.map((record) => [record.path, { record, absolutePath: path.join(baselineRoot, record.path) }])),
  } as unknown as LoadedCatalog;

  const options: PublicReleasePublisherOptions = {
    contentRoot,
    baselineRoot,
    loadPublications: async () => publications,
    publicationFile: (file) => path.join(contentRoot, file.path),
    loadPackages: {
      list: async () => packageEntries,
      assets: async () => packageAssets,
      latest: (id) => packageEntries.find((entry) => entry.id === id),
    },
    loadProducts: async () => [],
    allowFilesystemStore: true,
  };
  void catalog;
  return { options, publications, products: [], packageEntries, packageAssets };
}

test("publication plan reports changed surveys and submit rejects stale plans", async () => {
  const context = await harness();
  const base = path.dirname(context.options.contentRoot);
  try {
    const publisher = new PublicReleasePublisher(context.options);
    const plan = await publisher.plan();
    assert.equal(plan.surveys.length, 1);
    assert.equal(plan.changedSurveyIds.length, 1);
    assert.equal(plan.surveys[0]!.surveyId, "m42");
    assert.equal(plan.surveys[0]!.selectable, true);
    assert.equal(plan.dynamicPackages, 1);
    assert.equal(plan.dynamicLayers, 1);

    await assert.rejects(
      publisher.submit({ planId: "deadbeef", expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"] }),
      (error: { statusCode?: number }) => error.statusCode === 409,
    );
    await assert.rejects(
      publisher.submit({ planId: plan.planId, expectedBaselineSha256: "0".repeat(64), surveyIds: ["m42"] }),
      (error: { statusCode?: number }) => error.statusCode === 409,
    );
    await assert.rejects(
      publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: [] }),
      (error: { statusCode?: number }) => error.statusCode === 400,
    );

    const run = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"] }, "tester");
    assert.equal(run.status, "queued");
    await assert.rejects(
      publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["unknown"] }),
      (error: { statusCode?: number }) => error.statusCode === 409,
    );
    const claimed = await publisher.claimQueuedRun();
    assert.equal(claimed, run.runId);
    assert.equal(await publisher.claimQueuedRun(), undefined);
    void base;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("publisher executes a queued run into a verified archive and pointer", async () => {
  const context = await harness();
  const base = path.dirname(context.options.contentRoot);
  try {
    const objectRoot = path.join(base, "objects");
    const store = new FilesystemArtifactStore(objectRoot);
    const publisher = new PublicReleasePublisher({ ...context.options, store });
    const plan = await publisher.plan();
    const run = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"] });
    await publisher.claimQueuedRun();
    const finished = await publisher.execute(run.runId);
    assert.equal(finished.status, "published", finished.error);
    assert.ok(finished.archiveKey?.startsWith("public/releases/"));
    assert.equal(finished.files, 4);
    assert.equal(finished.packages, 1);

    const pointer = JSON.parse((await readFile(path.join(objectRoot, "public/current.json"), "utf8")));
    assert.equal(pointer.bundle.sha256, finished.bundle?.sha256);
    assert.equal(pointer.archiveSha256, finished.archiveSha256);
    const archive = await stat(path.join(objectRoot, finished.archiveKey!));
    assert.equal(archive.size, finished.archiveSizeBytes);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
