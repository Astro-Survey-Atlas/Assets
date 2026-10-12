import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeReleaseControlDocument } from "../server/publication-policy.js";

const root = path.resolve(process.env.ASSET_WORKTREE_ROOT ?? process.cwd());
const artifactRoot = path.join(root, "artifacts", "public-survey-footprints");
const destination = path.resolve(process.env.DATA_RELEASE_ASSET_OUTPUT_ROOT ?? path.join(process.cwd(), "dist", "data-assets"));
const notesPath = path.resolve(process.env.DATA_RELEASE_NOTES_PATH ?? path.join(process.cwd(), "dist", "DATA-RELEASE-NOTES.md"));
const tag = process.env.DATA_RELEASE_TAG ?? "";
const bundleId = process.env.DATA_RELEASE_BUNDLE_ID ?? "";
const bundleSha256 = process.env.DATA_RELEASE_BUNDLE_SHA256 ?? "";

if (!/^data-v\d+\.\d+\.\d+$/.test(tag) || !bundleId || !/^[a-f0-9]{64}$/.test(bundleSha256)) {
  throw new Error("Data release requires data-vX.Y.Z, a public bundle id and its SHA-256");
}

const history = JSON.parse(await readFile(path.join(artifactRoot, "release-history.json"), "utf8")) as {
  schemaVersion: number;
  latestReleaseId?: string;
  releases: Array<{ releaseId: string; sequence: number; bundleId: string; collection?: { fileName: string; sizeBytes: number; sha256: string }; packages: Array<{ id: string }> }>;
};
if (history.schemaVersion !== 2) throw new Error(`Unsupported release history schema ${history.schemaVersion}`);
const latest = history.releases.find(entry => entry.releaseId === history.latestReleaseId)
  ?? [...history.releases].sort((left, right) => right.sequence - left.sequence)[0];
if (!latest?.collection?.fileName) throw new Error("Pinned public bundle has no downloadable package collection");
if (!/^[A-Za-z0-9_.-]+$/.test(latest.collection.fileName)) throw new Error("Collection archive filename is unsafe");
const collectionPath = path.join(artifactRoot, "collections", latest.collection.fileName);
const collection = await readFile(collectionPath);
const collectionSha256 = createHash("sha256").update(collection).digest("hex");
if (collection.length !== latest.collection.sizeBytes || collectionSha256 !== latest.collection.sha256) throw new Error("Collection archive size or SHA differs from release history");

const catalogRelative = "artifacts/public-survey-footprints/packages/catalog.json";
const catalogBytes = await readFile(path.join(root, catalogRelative));
const sanitizedCatalog = sanitizeReleaseControlDocument(catalogRelative, catalogBytes) ?? catalogBytes;
const catalog = JSON.parse(sanitizedCatalog.toString("utf8")) as { packages: Array<{ id: string }> };
if (!Array.isArray(catalog.packages) || catalog.packages.some(entry => /csst/i.test(entry.id))) throw new Error("Public catalog is invalid or contains a denied package");
if (latest.packages.some(entry => /csst/i.test(entry.id))) throw new Error("Public release history contains a denied package");

await mkdir(destination, { recursive: true });
await copyFile(collectionPath, path.join(destination, latest.collection.fileName));
await writeFile(path.join(destination, "catalog.json"), sanitizedCatalog);
await copyFile(path.join(artifactRoot, "release-history.json"), path.join(destination, "release-history.json"));
const info = {
  schemaVersion: 1,
  releaseKind: "data",
  dataTag: tag,
  publicBundle: { id: bundleId, sha256: bundleSha256 },
  packageBundleId: latest.bundleId,
  releaseId: latest.releaseId,
  sequence: latest.sequence,
  collection: latest.collection,
  packages: latest.packages.length,
};
await writeFile(path.join(destination, "DATA-RELEASE-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);

const notes = [
  `## Astro Survey Atlas data release ${tag.replace(/^data-/, "")}`,
  "",
  `Public bundle: \`${bundleId}\` (SHA-256 \`${bundleSha256}\`).`,
  `Resource package bundle: \`${latest.bundleId}\`.`,
  `Package collection: \`${latest.collection.fileName}\` (${latest.packages.length} packages, ${latest.collection.sizeBytes} bytes).`,
  "",
  "This release contains public survey coverage and downloadable resource package metadata. It is independent of the application image and Helm chart.",
  "Scientific pixels remain at the source archives and are not included.",
  "See DATA-RELEASE-INFO.json and SHA256SUMS for immutable bundle and file checksums.",
  "",
].join("\n");
await mkdir(path.dirname(notesPath), { recursive: true });
await writeFile(notesPath, notes);
