// Copyright 2026 Astro Survey Atlas contributors.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Stages GitHub Release assets and release notes for the tag-triggered
// release workflow: latest resource-package collection archive, sanitized
// public package catalog, release history and a machine-readable summary.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeReleaseControlDocument } from "../server/publication-policy.js";

const root = path.resolve(process.env.ASSET_WORKTREE_ROOT ?? process.cwd());
const artifactRoot = path.join(root, "artifacts", "public-survey-footprints");
const destination = path.resolve(process.env.ASSETS_RELEASE_ASSET_OUTPUT_ROOT ?? path.join(root, "dist", "release-assets"));
const notesPath = path.resolve(process.env.ASSETS_RELEASE_NOTES_PATH ?? path.join(root, "dist", "RELEASE-NOTES.md"));

const releaseVersion = process.env.RELEASE_VERSION ?? "";
const imageReference = process.env.RELEASE_IMAGE ?? "";
const imageDigest = process.env.RELEASE_IMAGE_DIGEST ?? "";
const mirrorReference = process.env.RELEASE_IMAGE_MIRROR ?? "";
const chartReference = process.env.RELEASE_CHART ?? "";

interface ReleaseCollection {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

interface ReleaseHistoryEntry {
  releaseId: string;
  sequence: number;
  bundleId: string;
  collection?: ReleaseCollection;
  packages: Array<{ id: string }>;
}

async function main() {
  if (!releaseVersion) throw new Error("RELEASE_VERSION is required");

  const history = JSON.parse(await readFile(path.join(artifactRoot, "release-history.json"), "utf8")) as {
    schemaVersion: number;
    latestReleaseId?: string;
    releases: ReleaseHistoryEntry[];
  };
  if (history.schemaVersion !== 2) throw new Error(`unsupported release history schema ${history.schemaVersion}`);
  const latest =
    history.releases.find((entry) => entry.releaseId === history.latestReleaseId)
    ?? [...history.releases].sort((left, right) => right.sequence - left.sequence)[0];
  if (!latest?.collection?.fileName) throw new Error("latest release exposes no collection archive");
  const denied = latest.packages.filter((entry) => /csst/i.test(entry.id));
  if (denied.length > 0) throw new Error(`denied surveys leaked into latest release: ${denied.map((entry) => entry.id).join(", ")}`);

  const catalogRelative = "artifacts/public-survey-footprints/packages/catalog.json";
  const catalogBytes = await readFile(path.join(root, catalogRelative));
  const sanitizedCatalog = sanitizeReleaseControlDocument(catalogRelative, catalogBytes) ?? catalogBytes;
  const catalogDocument = JSON.parse(sanitizedCatalog.toString("utf8")) as { packages: Array<{ id: string }> };
  const catalogDenied = catalogDocument.packages.filter((entry) => /csst/i.test(entry.id));
  if (catalogDenied.length > 0) throw new Error(`denied surveys leaked into staged catalog: ${catalogDenied.map((entry) => entry.id).join(", ")}`);

  await mkdir(destination, { recursive: true });
  await copyFile(path.join(artifactRoot, "collections", latest.collection.fileName), path.join(destination, latest.collection.fileName));
  await writeFile(path.join(destination, "catalog.json"), sanitizedCatalog);
  await copyFile(path.join(artifactRoot, "release-history.json"), path.join(destination, "release-history.json"));
  await writeFile(
    path.join(destination, "RELEASE-INFO.json"),
    `${JSON.stringify(
      {
        releaseId: latest.releaseId,
        sequence: latest.sequence,
        bundleId: latest.bundleId,
        collection: latest.collection,
        packages: latest.packages.length,
      },
      null,
      2,
    )}\n`,
  );

  const lines = [
    `## Astro Survey Atlas Assets ${releaseVersion}`,
    "",
    "### Container images (same digest)",
    "",
    `- \`${imageReference}\` @ \`${imageDigest}\``,
    ...(mirrorReference ? [`- \`${mirrorReference}\` (Aliyun mirror)`] : []),
    "",
    "### Helm",
    "",
    "```sh",
    "helm upgrade --install astro-survey-atlas-assets \\",
    `  ${chartReference} \\`,
    `  --version ${releaseVersion} \\`,
    "  --namespace astro-survey-atlas-assets --create-namespace \\",
    "  --values <environment-values.yaml>",
    "```",
    "",
    "### Resource Packages",
    "",
    `The collection archive \`${latest.collection.fileName}\` bundles all ${latest.packages.length} public`,
    "survey footprint resource packages for offline synchronization. See RELEASE-INFO.json",
    "for the release id, bundle digest and package count, and SHA256SUMS for asset checksums.",
    "",
  ];
  await mkdir(path.dirname(notesPath), { recursive: true });
  await writeFile(notesPath, `${lines.join("\n")}\n`);

  console.log(`staged ${latest.collection.fileName} (${latest.packages.length} packages, release ${latest.releaseId})`);
}

await main();
