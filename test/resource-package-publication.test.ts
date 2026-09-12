import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FilesystemArtifactStore, type ArtifactObject, type ArtifactObjectWithBody, type ArtifactPutOptions, type ArtifactStore } from "../server/artifact-store.js";
import { DynamicResourcePackageStore } from "../server/resource-package-publication.js";
import type { MocPublication } from "../server/moc-build.js";
import type { ProductRecord } from "../server/products.js";
import { StateSnapshotCoordinator, stateSnapshotFileKey } from "../server/state-snapshot.js";
import { testArtifactRoot } from "./test-data-root.js";
import { UploadSpool } from "../server/upload-spool.js";

class LocalS3Adapter implements ArtifactStore {
  readonly kind = "s3" as const;

  constructor(private readonly delegate: FilesystemArtifactStore) {}

  head(key: string): Promise<ArtifactObject | null> { return this.delegate.head(key); }
  get(key: string, range?: { start: number; end: number }): Promise<ArtifactObjectWithBody | null> { return this.delegate.get(key, range); }
  putImmutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putImmutable(key, body, options); }
  putMutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putMutable(key, body, options); }
  putFileImmutable(key: string, filePath: string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putFileImmutable(key, filePath, options); }
  downloadToFile(key: string, filePath: string): Promise<ArtifactObject | null> { return this.delegate.downloadToFile(key, filePath); }
}

async function waitForUploadKind(root: string, kind: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const entry of await readdir(path.join(root, "jobs"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(root, "jobs", entry.name, "manifest.json"), "utf8")) as { kind?: string };
        if (manifest.kind === kind) return;
      } catch { /* enqueue is still copying the job */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for upload kind ${kind}`);
}

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
const moc = await readFile(path.join(testArtifactRoot, "layers", "euclid-q1-deep-fields-image-extent", "euclid-q1-deep-fields-image-extent.moc.fits"));
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
  assert.equal(initial[0]!.version, "3.1.0");
  assert.equal(initial[0]!.id, "public-jwst-footprints");
  const archive = store.assets()[0]!;
  assert.equal(archive.sha256, initial[0]!.sha256);
  assert.equal((await stat(path.join(contentRoot, archive.path))).size, archive.sizeBytes);
  assert.equal(sha256(await readFile(path.join(contentRoot, archive.path))), archive.sha256);

  const changedMoc = await readFile(path.join(testArtifactRoot, "layers", "desi-dr1-spectra-footprint", "desi-dr1-spectra-footprint.moc.fits"));
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
  assert.equal(updated[0]!.version, "3.1.0");
  assert.equal(updated[0]!.deprecated, true);
  assert.equal(updated[1]!.version, "3.2.0");
  assert.equal(updated[1]!.deprecated, false);
  assert.equal(updated[1]!.id, "public-jwst-footprints");
  assert.notEqual(updated[0]!.sha256, updated[1]!.sha256);

  // An unchanged re-sync must not allocate a new version.
  await store.sync([second], [product()], (file) => path.join(contentRoot, file.path));
  assert.equal(store.list().length, 2);
  assert.equal(store.latest("public-jwst-footprints")?.version, "3.2.0");
});

test("dynamic package metadata queues and restores a missing archive", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "assets-dynamic-package-durable-"));
  try {
    const contentRoot = path.join(base, "content");
    const buildRoot = path.join(contentRoot, "moc-releases", "jwst-build");
    await (await import("node:fs/promises")).mkdir(buildRoot, { recursive: true });
    const moc = await readFile(path.join(testArtifactRoot, "layers", "euclid-q1-deep-fields-image-extent", "euclid-q1-deep-fields-image-extent.moc.fits"));
    const query = Buffer.from(JSON.stringify({ order: 8, pixels: [64, 65] }));
    const preview = Buffer.from(JSON.stringify({ order: 4, pixels: [4] }));
    await writeFile(path.join(buildRoot, "moc.fits"), moc);
    await writeFile(path.join(buildRoot, "query.json"), query);
    await writeFile(path.join(buildRoot, "preview.json"), preview);
    const source = publication(contentRoot, "jwst-build", moc, "2026-08-31T00:00:00.000Z");
    source.files.query!.sha256 = sha256(query); source.files.query!.sizeBytes = query.length;
    source.files.preview!.sha256 = sha256(preview); source.files.preview!.sizeBytes = preview.length;

    const objectStore = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "objects")));
    const spool = new UploadSpool({ root: path.join(base, "uploads"), store: objectStore });
    await spool.initialize();
    const snapshots = new StateSnapshotCoordinator({ root: path.join(base, "state"), store: objectStore, spool });
    await snapshots.initialize(["resource-packages"]);
    const packages = new DynamicResourcePackageStore(contentRoot, snapshots);
    await packages.sync([source], [product()], (file) => path.join(contentRoot, file.path));
    const asset = packages.assets()[0]!;
    const persisted = JSON.parse(await readFile(path.join(contentRoot, "resource-package-publications-v1.json"), "utf8")) as { packages: Array<{ objectKey?: string; sha256: string; sizeBytes: number; archivePath: string }> };
    assert.equal(persisted.packages[0]?.objectKey, stateSnapshotFileKey("resource-packages", persisted.packages[0]!.sha256));
    await waitForUploadKind(path.join(base, "uploads"), "resource-package");
    await waitForUploadKind(path.join(base, "uploads"), "state-snapshot");
    const uploads = await spool.processPending();
    await snapshots.reconcileUploaded(uploads.uploadedManifests);

    await rm(path.join(contentRoot, asset.path));
    await rm(path.join(contentRoot, "resource-package-publications-v1.json"));
    const restored = new DynamicResourcePackageStore(contentRoot, snapshots);
    await restored.initialize();
    assert.equal(restored.list().length, 1);
    assert.equal(await stat(path.join(contentRoot, asset.path)).then((details) => details.size), asset.sizeBytes);
    assert.equal(sha256(await readFile(path.join(contentRoot, asset.path))), asset.sha256);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
