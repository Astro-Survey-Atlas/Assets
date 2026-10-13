import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildResourcePackageCollection } from "../server/resource-package-collection.js";
import type { ProjectedResourcePackage } from "../server/resource-package-projection.js";
import { sanitizeReleaseControlDocument } from "../server/publication-policy.js";
import { stageDataRelease } from "../scripts/stage-data-release.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function makeFixture(collectionHashOverride?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "assets-data-release-"));
  const artifactRoot = path.join(root, "artifacts", "public-survey-footprints");
  const packageRoot = path.join(artifactRoot, "packages");
  const packageBytes = Buffer.from("verified package archive fixture");
  const catalogBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 3, packages: [{ id: "public-demo-footprints", version: "1.0.0" }] }, null, 2)}\n`);
  const collectionCatalogBytes = sanitizeReleaseControlDocument(
    "artifacts/public-survey-footprints/packages/catalog.json",
    catalogBytes,
  ) ?? catalogBytes;
  const projection: ProjectedResourcePackage = {
    id: "public-demo-footprints",
    version: "1.0.0",
    name: "Demo footprints",
    sizeBytes: packageBytes.length,
    sha256: sha256(packageBytes),
    survey: { id: "demo", displayName: "Demo Survey" },
    facilities: ["Demo Observatory"],
    modalities: ["imaging"],
    accessModes: ["download"],
    sources: [],
    releases: [{ id: "demo-dr1", label: "DR1", modalities: ["imaging"], layerCount: 1 }],
  };
  const release: {
    releaseId: string;
    sequence: number;
    bundleId: string;
    releasedAt: string;
    catalogSha256: string;
    packages: Array<ProjectedResourcePackage & { downloadUrl: string }>;
    collection?: { fileName: string; sizeBytes: number; sha256: string };
  } = {
    releaseId: "public-survey-footprints-2026-10-12-1",
    sequence: 1,
    bundleId: "public-survey-footprints-2026-10-12",
    releasedAt: "2026-10-12T00:00:00.000Z",
    catalogSha256: sha256(collectionCatalogBytes),
    packages: [{ ...projection, downloadUrl: "/api/v1/resource-packages/public-demo-footprints/versions/1.0.0/download" }],
  };
  const expectedCollection = await buildResourcePackageCollection({
    ...release,
    catalogBytes: collectionCatalogBytes,
    packages: [{ downloadName: "public-demo-footprints-1.0.0.zip", zipBytes: packageBytes, projection }],
  });
  release.collection = {
    fileName: expectedCollection.fileName,
    sizeBytes: expectedCollection.sizeBytes,
    sha256: collectionHashOverride ?? expectedCollection.sha256,
  };

  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "catalog.json"), catalogBytes);
  await writeFile(path.join(packageRoot, "public-demo-footprints-1.0.0.zip"), packageBytes);
  await writeFile(path.join(artifactRoot, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    files: [{
      id: "package-public-demo-footprints-1-0-0",
      kind: "package",
      label: "Demo footprints",
      description: "Fixture package",
      path: "artifacts/public-survey-footprints/packages/public-demo-footprints-1.0.0.zip",
      downloadName: "public-demo-footprints-1.0.0.zip",
      mediaType: "application/zip",
      sizeBytes: packageBytes.length,
      sha256: sha256(packageBytes),
      version: "1.0.0",
    }],
  })}\n`);
  await writeFile(path.join(artifactRoot, "release-history.json"), `${JSON.stringify({
    schemaVersion: 2,
    latestReleaseId: release.releaseId,
    releases: [release],
  })}\n`);

  return { root, artifactRoot, release, expectedCollection, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function environment(root: string, outputRoot: string): NodeJS.ProcessEnv {
  return {
    ASSET_WORKTREE_ROOT: root,
    DATA_RELEASE_ASSET_OUTPUT_ROOT: outputRoot,
    DATA_RELEASE_NOTES_PATH: path.join(outputRoot, "DATA-RELEASE-NOTES.md"),
    DATA_RELEASE_TAG: "data-v0.0.1",
    DATA_RELEASE_BUNDLE_ID: "reviewed-test-bundle",
    DATA_RELEASE_BUNDLE_SHA256: "a".repeat(64),
  };
}

test("data release rebuilds a missing collection only when its recorded checksum matches", async () => {
  const fixture = await makeFixture();
  try {
    const outputRoot = path.join(fixture.root, "output");
    await stageDataRelease(environment(fixture.root, outputRoot));

    const collectionPath = path.join(outputRoot, fixture.release.collection!.fileName);
    assert.deepEqual(await readFile(collectionPath), fixture.expectedCollection.bytes);
    const info = JSON.parse(await readFile(path.join(outputRoot, "DATA-RELEASE-INFO.json"), "utf8"));
    assert.equal(info.collectionArtifactSource, "reconstructed");
    assert.equal(info.collection.sha256, fixture.release.collection!.sha256);
    assert.match(await readFile(path.join(outputRoot, "DATA-RELEASE-NOTES.md"), "utf8"), /matched the release-history SHA-256/);
  } finally {
    await fixture.cleanup();
  }
});

test("data release refuses a reconstructed collection that differs from release history", async () => {
  const fixture = await makeFixture("0".repeat(64));
  try {
    const outputRoot = path.join(fixture.root, "output");
    await assert.rejects(
      stageDataRelease(environment(fixture.root, outputRoot)),
      /Rebuilt package collection does not match release history/,
    );
  } finally {
    await fixture.cleanup();
  }
});
