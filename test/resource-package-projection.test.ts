import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import yazl from "yazl";

import assert from "node:assert/strict";
import { test } from "node:test";

import { PackageInspectionError, readResourcePackageManifest, readZipEntry } from "../server/resource-package-inspection.js";
import { projectResourcePackage, surveyLookupsFromCatalog, type SurveyLookup } from "../server/resource-package-projection.js";
import { buildResourcePackageCollection } from "../server/resource-package-collection.js";
import type { ProjectedResourcePackage } from "../server/resource-package-projection.js";

function sha256Of(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function zipBuffer(entries: Array<{ name: string; data: Buffer; compress?: boolean }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(entry.data, entry.name, {
      mtime: new Date("1980-01-01T00:00:00.000Z"),
      mode: 0o100644,
      compress: entry.compress ?? false,
    });
  }
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

function layer(releaseId: string, modality: string, layerId: string): Record<string, unknown> {
  return {
    layerId,
    surveyId: "demo",
    releaseId,
    modality,
    coverageRole: "image_extent",
    dataOrigin: "observed",
    sourceTier: "official",
    path: `layers/${layerId}/moc.fits`,
    sizeBytes: 8,
    sha256: sha256Of(`${layerId}-moc`),
  };
}

const lookups = surveyLookupsFromCatalog({
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  surveys: [
    {
      id: "demo",
      name: "Demo Survey",
      mission: "Demo Mission",
      releases: [
        { id: "demo-dr1", label: "DR1", kind: "public_release", releasedYear: 2025, modalities: ["image"], products: [] },
        { id: "demo-edr", kind: "early_release", modalities: [], products: [] },
      ],
    },
    { id: "other", name: "Other", releases: [] },
  ],
});

async function demoZip(): Promise<Buffer> {
  return zipBuffer([
    {
      name: "resource-package.json",
      compress: true,
      data: Buffer.from(
        `${JSON.stringify(
          {
            schemaVersion: 3,
            id: "public-demo-footprints",
            version: "3.0.0",
            surveyId: "demo",
            layers: [layer("demo-dr1", "image", "demo-dr1-i"), layer("demo-dr1", "catalog", "demo-dr1-cat"), layer("demo-edr", "imaging", "demo-edr-i")],
            files: [{ path: "README.md", sizeBytes: 3, sha256: sha256Of("abc") }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
    },
    { name: "README.md", data: Buffer.from("abc") },
  ]);
}

test("resource package inspection parses manifests and reads exact entries", async () => {
  const zipBytes = await demoZip();
  const manifest = await readResourcePackageManifest(zipBytes);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.surveyId, "demo");
  assert.equal(manifest.layers.length, 3);
  const readme = await readZipEntry(zipBytes, "README.md");
  assert.equal(readme.toString("utf8"), "abc");
  await assert.rejects(readZipEntry(zipBytes, "missing.txt"), (error: { statusCode?: number }) => error.statusCode === 422);
  await assert.rejects(
    readZipEntry(Buffer.from("this is not a zip at all"), "resource-package.json"),
    (error: { statusCode?: number }) => error.statusCode === 400,
  );
  await assert.rejects(
    readResourcePackageManifest(Buffer.from("still not a zip")),
    (error: { statusCode?: number }) => error.statusCode === 400,
  );
});

test("projection groups DR releases, unions modalities, and falls back labels", async () => {
  const zipBytes = await demoZip();
  const projection = await projectResourcePackage(
    {
      id: "public-demo-footprints",
      version: "3.0.0",
      name: "Demo footprints",
      surveyId: "demo",
      sizeBytes: zipBytes.byteLength,
      sha256: sha256Of(zipBytes),
      facilities: ["DemoTelescope"],
      zipBytes,
    },
    lookups,
  );
  assert.equal(projection.survey?.displayName, "Demo Survey");
  assert.equal(projection.survey?.mission, "Demo Mission");
  assert.deepEqual(projection.facilities, ["DemoTelescope"]);
  assert.deepEqual(projection.modalities, ["catalog", "image", "imaging"]);
  assert.deepEqual(
    projection.releases.map((release) => release.id),
    ["demo-dr1", "demo-edr"],
  );
  const dr1 = projection.releases[0]!;
  assert.equal(dr1.label, "DR1");
  assert.equal(dr1.kind, "public_release");
  assert.equal(dr1.releasedYear, 2025);
  assert.equal(dr1.layerCount, 2);
  assert.deepEqual(dr1.modalities, ["catalog", "image"]);
  const edr = projection.releases[1]!;
  assert.equal(edr.label, "demo-edr", "labels fall back to release id");
  assert.deepEqual(edr.modalities, ["imaging"]);
});

test("projection fails closed on denied surveys and identity mismatch", async () => {
  const zipBytes = await demoZip();
  await assert.rejects(
    projectResourcePackage(
      {
        id: "public-csst-footprints",
        version: "3.0.0",
        name: "CSST footprints",
        surveyId: "csst",
        sizeBytes: zipBytes.byteLength,
        sha256: sha256Of(zipBytes),
        zipBytes,
      },
      lookups,
    ),
    (error: { statusCode?: number }) => error instanceof PackageInspectionError && error.statusCode === 403,
  );
  await assert.rejects(
    projectResourcePackage(
      {
        id: "public-other-footprints",
        version: "3.0.0",
        name: "Other footprints",
        surveyId: "other",
        sizeBytes: zipBytes.byteLength,
        sha256: sha256Of(zipBytes),
        zipBytes,
      },
      lookups,
    ),
    (error: { statusCode?: number }) => error instanceof PackageInspectionError && error.statusCode === 422,
  );
  const foreignZip = await zipBuffer([
    {
      name: "resource-package.json",
      compress: true,
      data: Buffer.from(
        JSON.stringify({
          schemaVersion: 3,
          id: "public-demo-footprints",
          version: "3.0.0",
          surveyId: "other",
          layers: [layer("demo-dr1", "image", "demo-dr1-i")],
          files: [],
        }),
      ),
    },
  ]);
  await assert.rejects(
    projectResourcePackage(
      {
        id: "public-other-footprints",
        version: "3.0.0",
        name: "Other footprints",
        surveyId: "other",
        sizeBytes: foreignZip.byteLength,
        sha256: sha256Of(foreignZip),
        zipBytes: foreignZip,
      },
      lookups,
    ),
    (error: { statusCode?: number }) => error instanceof PackageInspectionError && error.statusCode === 422,
  );
});

test("collection zip is deterministic and carries projections and catalog", async () => {
  const zipBytes = await demoZip();
  const projection: ProjectedResourcePackage = await projectResourcePackage(
    {
      id: "public-demo-footprints",
      version: "3.0.0",
      name: "Demo footprints",
      surveyId: "demo",
      sizeBytes: zipBytes.byteLength,
      sha256: sha256Of(zipBytes),
      zipBytes,
    },
    lookups,
  );
  const catalogBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 3, version: "3.0.0", packages: [{ id: "public-demo-footprints", version: "3.0.0", surveyId: "demo" }] }, null, 2)}\n`,
    "utf8",
  );
  const input = {
    releaseId: "public-survey-footprints-2026-01-01-1",
    sequence: 1,
    bundleId: "public-survey-footprints-2026-01-01",
    releasedAt: "2026-01-01T00:00:00.000Z",
    catalogBytes,
    packages: [{ downloadName: "public-demo-footprints-3.0.0.zip", zipBytes, projection }],
  };
  const first = await buildResourcePackageCollection(input);
  const second = await buildResourcePackageCollection(input);
  assert.equal(first.sha256, second.sha256, "identical inputs must produce byte-identical collections");
  assert.equal(first.fileName, "public-survey-footprints-2026-01-01-1-resource-packages.zip");

  const collectionJson = JSON.parse((await readZipEntry(first.bytes, "collection.json")).toString("utf8"));
  assert.equal(collectionJson.schemaVersion, 1);
  assert.equal(collectionJson.releaseId, input.releaseId);
  assert.equal(collectionJson.packages.length, 1);
  assert.equal(collectionJson.packages[0].survey.displayName, "Demo Survey");
  assert.equal(collectionJson.packages[0].archivePath, "packages/public-demo-footprints-3.0.0.zip");
  assert.match(collectionJson.packages[0].downloadUrl, /\/api\/v1\/resource-packages\/.+\/versions\/3\.0\.0\/download$/);

  const catalogInZip = await readZipEntry(first.bytes, "catalog.json");
  assert.equal(catalogInZip.toString("utf8"), catalogBytes.toString("utf8"));
  const packagedZip = await readZipEntry(first.bytes, "packages/public-demo-footprints-3.0.0.zip");
  assert.equal(packagedZip.toString("hex"), zipBytes.toString("hex"), "member zips must be stored uncompressed");

  await assert.rejects(
    buildResourcePackageCollection({
      ...input,
      packages: [
        {
          downloadName: "public-csst-footprints-3.0.0.zip",
          zipBytes,
          projection: { ...projection, id: "public-csst-footprints", survey: { id: "csst", displayName: "CSST" } },
        },
      ],
    }),
    /excluded survey/i,
  );
});

test("survey lookups require a survey array", () => {
  assert.throws(() => surveyLookupsFromCatalog({ schemaVersion: 1 }), /surveys/);
  const parsed = surveyLookupsFromCatalog({
    schemaVersion: 1,
    surveys: [{ id: "demo", name: "Demo Survey", releases: [] }],
  });
  assert.equal(parsed.size, 1);
  assert.equal(parsed.get("demo")!.id, "demo");
});
