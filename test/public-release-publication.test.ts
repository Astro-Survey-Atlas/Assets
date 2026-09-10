import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

import assert from "node:assert/strict";
import { test } from "node:test";
import yazl from "yazl";

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

function sha256Of(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function packageZipBuffer(manifest: Record<string, unknown>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"), "resource-package.json", {
    mtime: new Date("1980-01-01T00:00:00.000Z"),
    mode: 0o100644,
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

async function harness(): Promise<TestHarness> {
  const base = await mkdtemp(path.join(tmpdir(), "release-publisher-"));
  const baselineRoot = path.join(base, "baseline");
  const contentRoot = path.join(base, "content");
  await mkdir(path.join(baselineRoot, "artifacts/public-survey-footprints/packages"), { recursive: true });
  await mkdir(contentRoot, { recursive: true });

  const layerFile: MocPublicationFile = { path: "moc/m42.fits", sha256: sha256Of("moc-data"), sizeBytes: 8, mediaType: "application/fits" };
  const mocPath = path.join(contentRoot, "moc/m42.fits");
  await mkdir(path.dirname(mocPath), { recursive: true });
  await writeFile(mocPath, "moc-data");
  const legacyZipBytes = await packageZipBuffer({
    schemaVersion: 3,
    id: "public-legacy-footprints",
    version: "3.0.0",
    surveyId: "m42",
    layers: [
      {
        layerId: "legacy-layer",
        surveyId: "m42",
        releaseId: "m42-dr0",
        modality: "image",
        coverageRole: "image_extent",
        dataOrigin: "observed",
        sourceTier: "official",
        path: "layers/legacy-layer/moc.fits",
        sizeBytes: 4,
        sha256: sha256Of("legs"),
      },
    ],
    files: [],
  });
  const dynamicZipBytes = await packageZipBuffer({
    schemaVersion: 3,
    id: "public-m42-footprints",
    version: "3.1.0",
    surveyId: "m42",
    layers: [
      {
        layerId: "m42-halpha",
        surveyId: "m42",
        releaseId: "m42-dr1",
        modality: "image",
        coverageRole: "image_extent",
        dataOrigin: "observed",
        sourceTier: "official",
        path: "layers/m42-halpha/moc.fits",
        sizeBytes: 8,
        sha256: sha256Of("moc-data"),
      },
    ],
    files: [],
  });
  const zipSha256 = sha256Of(dynamicZipBytes);
  const surveyCatalog = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    surveys: [
      {
        id: "m42",
        name: "Messier 42",
        mission: "Orion Nebula Survey",
        color: "#7c5cff",
        description: "Test survey",
        modalities: ["image"],
        releases: [
          { id: "m42-dr0", label: "DR0", kind: "public_release", releasedYear: 2025, modalities: ["image"], products: [] },
          { id: "m42-dr1", label: "DR1", kind: "public_release", releasedYear: 2026, modalities: ["image"], products: [] },
        ],
      },
    ],
  };
  await mkdir(path.join(baselineRoot, "src/surveys"), { recursive: true });
  await writeFile(path.join(baselineRoot, "src/surveys/survey-catalog.json"), JSON.stringify(surveyCatalog, null, 2));

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
      sizeBytes: dynamicZipBytes.byteLength,
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
      sizeBytes: dynamicZipBytes.byteLength,
      sha256: zipSha256,
      surveyId: "m42",
      releaseId: "m42-dr1",
      version: "3.1.0",
      name: "M42 footprints",
    },
  ];
  const zipPath = path.join(contentRoot, packageAssets[0]!.path);
  await mkdir(path.dirname(zipPath), { recursive: true });
  await writeFile(zipPath, dynamicZipBytes);

  const baselineLayerRecord: PublicAssetRecord = {
    id: "layer-legacy-moc",
    kind: "moc",
    label: "Legacy",
    description: "Legacy layer",
    path: "artifacts/public-survey-footprints/layers/legacy/moc.fits",
    downloadName: "moc.fits",
    mediaType: "application/fits",
    sizeBytes: 4,
    sha256: sha256Of("legs"),
    deliveryClass: "runtime",
  };
  await mkdir(path.join(baselineRoot, path.dirname(baselineLayerRecord.path)), { recursive: true });
  await writeFile(path.join(baselineRoot, baselineLayerRecord.path), "legs");

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
  const catalogBytes = JSON.stringify({
    schemaVersion: 3,
    version: "3.0.0",
    packages: [{ id: "public-legacy-footprints", version: "3.0.0", name: "Legacy footprints", surveyId: "m42" }],
  });
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
      sha256: sha256Of(catalogBytes),
      deliveryClass: "runtime",
    },
    {
      id: "package-public-legacy-footprints-3-0-0",
      kind: "package",
      label: "Legacy package",
      description: "Legacy package",
      path: "artifacts/public-survey-footprints/packages/public-legacy-footprints-3.0.0.zip",
      downloadName: "public-legacy-footprints-3.0.0.zip",
      mediaType: "application/zip",
      sizeBytes: legacyZipBytes.byteLength,
      sha256: sha256Of(legacyZipBytes),
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
    assert.equal(finished.files, 7);
    assert.equal(finished.packages, 1);

    const pointer = JSON.parse((await readFile(path.join(objectRoot, "public/current.json"), "utf8")));
    assert.equal(pointer.bundle.sha256, finished.bundle?.sha256);
    assert.equal(pointer.archiveSha256, finished.archiveSha256);
    const archive = await stat(path.join(objectRoot, finished.archiveKey!));
    assert.equal(archive.size, finished.archiveSizeBytes);

    const extractRoot = path.join(base, "extract");
    await mkdir(extractRoot, { recursive: true });
    await execFileAsync("tar", ["-xzf", path.join(objectRoot, finished.archiveKey!), "-C", extractRoot]);
    const manifest = JSON.parse(await readFile(path.join(extractRoot, "artifacts/public-survey-footprints/release-manifest.json"), "utf8"));
    const packagePaths = manifest.files.filter((record: { kind: string }) => record.kind === "package").map((record: { path: string }) => record.path);
    assert.deepEqual(packagePaths.sort(), [
      "artifacts/public-survey-footprints/packages/public-legacy-footprints-3.0.0.zip",
      "artifacts/public-survey-footprints/packages/public-m42-footprints-3.1.0.zip",
    ]);
    const mergedCatalog = JSON.parse(await readFile(path.join(extractRoot, "artifacts/public-survey-footprints/packages/catalog.json"), "utf8"));
    assert.equal(mergedCatalog.packages.length, 2);
    const dynamicEntry = mergedCatalog.packages.find((entry: { id: string }) => entry.id === "public-m42-footprints");
    assert.equal(dynamicEntry.archiveUrl, "/api/v1/resource-packages/public-m42-footprints/versions/3.1.0/download");
    const history = JSON.parse(await readFile(path.join(extractRoot, "artifacts/public-survey-footprints/release-history.json"), "utf8"));
    assert.equal(history.schemaVersion, 2);
    assert.ok(history.latestReleaseId);
    assert.equal(history.releases.length, 1);
    assert.equal(history.releases[0].sequence, 1);
    assert.equal(history.releases[0].packages.length, 2);
    assert.ok(history.releases[0].packages.every((entry: { downloadUrl: string }) => entry.downloadUrl.startsWith("/api/v1/resource-packages/") && entry.downloadUrl.includes("/versions/")));
    const collection = history.releases[0].collection;
    assert.ok(collection, "history entry must carry collection metadata");
    assert.match(collection.fileName, /-resource-packages\.zip$/);
    assert.equal(collection.downloadUrl, `/api/v1/releases/${history.releases[0].releaseId}/download`);
    const collectionOnDisk = await readFile(path.join(extractRoot, "artifacts/public-survey-footprints/collections", collection.fileName));
    assert.equal(collectionOnDisk.byteLength, collection.sizeBytes);
    assert.equal(sha256Of(collectionOnDisk), collection.sha256);
    const legacyEntry = history.releases[0].packages.find((entry: { id: string }) => entry.id === "public-legacy-footprints");
    assert.ok(legacyEntry, "legacy package must be projected into history");
    assert.equal(legacyEntry.survey?.displayName, "Messier 42");
    assert.deepEqual(legacyEntry.modalities, ["image"]);
    assert.deepEqual(legacyEntry.releases.map((release: { id: string }) => release.id), ["m42-dr0"]);
    assert.equal(legacyEntry.releases[0].label, "DR0");
    assert.equal(legacyEntry.releases[0].layerCount, 1);
    const dynamicHistoryEntry = history.releases[0].packages.find((entry: { id: string }) => entry.id === "public-m42-footprints");
    assert.ok(dynamicHistoryEntry);
    assert.deepEqual(dynamicHistoryEntry.releases.map((release: { id: string }) => release.id), ["m42-dr1"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("publication policy denies sensitive surveys end to end", async () => {
  const context = await harness();
  const base = path.dirname(context.options.contentRoot);
  try {
    const csstLayerFile: MocPublicationFile = { path: "moc/csst-w1.fits", sha256: createHash("sha256").update("csst-moc").digest("hex"), sizeBytes: 8, mediaType: "application/fits" };
    await writeFile(path.join(context.options.contentRoot, "moc/csst-w1.fits"), "csst-moc");
    context.publications.push({
      schemaVersion: 1,
      id: "pub-csst",
      buildName: "build-csst",
      productId: "product-csst",
      surveyId: "csst",
      releaseId: "csst-w1",
      product: "CSST W1",
      layerId: "csst-sim-w1-image-extent",
      sourceUrl: "https://example.org/csst",
      publishedAt: "2026-01-02T00:00:00.000Z",
      files: { moc: csstLayerFile },
    });
    const csstZip = "csst-archive-bytes";
    context.packageEntries.push({
      ...context.packageEntries[0]!,
      id: "public-csst-footprints",
      surveyId: "csst",
      version: "3.1.0",
      archiveUrl: "/api/v1/assets/package-public-csst-footprints-3-1-0/download",
      archivePath: "resource-packages/public-csst-footprints/3.1.0/public-csst-footprints-3.1.0.zip",
      sizeBytes: Buffer.byteLength(csstZip),
      sha256: createHash("sha256").update(csstZip).digest("hex"),
    });
    context.packageAssets.push({
      ...context.packageAssets[0]!,
      id: "package-public-csst-footprints-3-1-0",
      path: "resource-packages/public-csst-footprints/3.1.0/public-csst-footprints-3.1.0.zip",
      downloadName: "public-csst-footprints-3.1.0.zip",
      surveyId: "csst",
      version: "3.1.0",
      sizeBytes: Buffer.byteLength(csstZip),
      sha256: createHash("sha256").update(csstZip).digest("hex"),
    });
    await writeFile(path.join(context.options.contentRoot, "resource-packages/public-csst-footprints/3.1.0/public-csst-footprints-3.1.0.zip"), csstZip, { flag: "wx" }).catch(() => undefined);

    const objectRoot = path.join(base, "objects-csst");
    const store = new FilesystemArtifactStore(objectRoot);
    const publisher = new PublicReleasePublisher({ ...context.options, store });
    const plan = await publisher.plan();
    const csstPlan = plan.surveys.find((survey) => survey.surveyId === "csst");
    assert.ok(csstPlan);
    assert.ok(csstPlan.blockers.some((blocker) => blocker.includes("policy")));
    assert.equal(csstPlan.selectable, false);
    await assert.rejects(
      publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["csst"] }),
      (error: { statusCode?: number }) => error.statusCode === 409,
    );

    const run = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"] });
    await publisher.claimQueuedRun();
    const finished = await publisher.execute(run.runId);
    assert.equal(finished.status, "published", finished.error);
    const extractRoot = path.join(base, "extract-csst");
    await mkdir(extractRoot, { recursive: true });
    await execFileAsync("tar", ["-xzf", path.join(objectRoot, finished.archiveKey!), "-C", extractRoot]);
    const manifest = JSON.parse(await readFile(path.join(extractRoot, "artifacts/public-survey-footprints/release-manifest.json"), "utf8"));
    assert.ok(manifest.files.every((record: { id: string; path: string; surveyId?: string }) => !/csst/i.test(record.id) && !record.path.includes("csst") && record.surveyId !== "csst"));
    const mergedCatalog = JSON.parse(await readFile(path.join(extractRoot, "artifacts/public-survey-footprints/packages/catalog.json"), "utf8"));
    assert.ok(mergedCatalog.packages.every((entry: { id: string; surveyId?: string }) => entry.id !== "public-csst-footprints" && entry.surveyId !== "csst"));
    const history = JSON.parse(await readFile(path.join(extractRoot, "artifacts/public-survey-footprints/release-history.json"), "utf8"));
    assert.ok(history.releases.every((release: { packages: Array<{ id: string }> }) => release.packages.every((entry) => !entry.id.includes("csst"))));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
