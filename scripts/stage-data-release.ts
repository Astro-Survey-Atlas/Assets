import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildResourcePackageCollection } from "../server/resource-package-collection.js";
import type { ProjectedResourcePackage } from "../server/resource-package-projection.js";
import { sanitizeReleaseControlDocument } from "../server/publication-policy.js";
import type { PublicAssetRecord } from "../server/types.js";

interface DataReleaseCollection {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

interface DataReleasePackage extends ProjectedResourcePackage {
  downloadUrl: string;
}

interface DataReleaseHistoryEntry {
  releaseId: string;
  sequence: number;
  bundleId: string;
  releasedAt: string;
  catalogSha256?: string;
  collection?: DataReleaseCollection;
  packages: DataReleasePackage[];
}

interface ReleaseAssetManifest {
  files: PublicAssetRecord[];
  retainedPackages?: PublicAssetRecord[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveAssetPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`Unsafe package archive path: ${relativePath}`);
  }
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Package archive escapes bundle root: ${relativePath}`);
  return absolutePath;
}

async function rebuildCollection(
  root: string,
  artifactRoot: string,
  latest: DataReleaseHistoryEntry,
  catalogBytes: Buffer,
  releaseManifest: ReleaseAssetManifest,
): Promise<Buffer> {
  if (latest.catalogSha256 && sha256(catalogBytes) !== latest.catalogSha256) {
    throw new Error("Cannot rebuild package collection: sanitized catalog hash differs from release history");
  }

  const packageAssets = [
    ...releaseManifest.files,
    ...(releaseManifest.retainedPackages ?? []),
  ].filter((record) => record.kind === "package");

  const packages = [];
  for (const projection of latest.packages) {
    if (!/^[A-Za-z0-9_.-]+$/.test(projection.id) || !/^[A-Za-z0-9_.-]+$/.test(projection.version)) {
      throw new Error(`Cannot rebuild package collection: unsafe package identity ${projection.id}@${projection.version}`);
    }
    const downloadName = `${projection.id}-${projection.version}.zip`;
    const matches = packageAssets.filter((record) => record.downloadName === downloadName && record.version === projection.version);
    if (matches.length !== 1) {
      throw new Error(`Cannot rebuild package collection: expected one bundled archive for ${projection.id}@${projection.version}, found ${matches.length}`);
    }
    const record = matches[0]!;
    if (record.sizeBytes !== projection.sizeBytes || record.sha256 !== projection.sha256) {
      throw new Error(`Cannot rebuild package collection: asset metadata differs for ${projection.id}@${projection.version}`);
    }
    const zipBytes = await readFile(resolveAssetPath(root, record.path));
    if (zipBytes.byteLength !== projection.sizeBytes || sha256(zipBytes) !== projection.sha256) {
      throw new Error(`Cannot rebuild package collection: package archive checksum failed for ${projection.id}@${projection.version}`);
    }
    const { downloadUrl: _historyDownloadUrl, ...collectionProjection } = projection;
    packages.push({ downloadName, zipBytes, projection: collectionProjection });
  }
  if (packages.length === 0) throw new Error("Cannot rebuild package collection: release history contains no packages");

  const rebuilt = await buildResourcePackageCollection({
    releaseId: latest.releaseId,
    sequence: latest.sequence,
    bundleId: latest.bundleId,
    releasedAt: latest.releasedAt,
    catalogBytes,
    packages,
  });
  const expected = latest.collection;
  if (rebuilt.fileName !== expected?.fileName || rebuilt.sizeBytes !== expected.sizeBytes || rebuilt.sha256 !== expected.sha256) {
    throw new Error(
      `Rebuilt package collection does not match release history (expected ${expected?.sha256 ?? "missing"}, got ${rebuilt.sha256})`,
    );
  }
  return rebuilt.bytes;
}

async function verifiedCollection(
  root: string,
  artifactRoot: string,
  latest: DataReleaseHistoryEntry,
  catalogBytes: Buffer,
  releaseManifest: ReleaseAssetManifest,
): Promise<{ bytes: Buffer; source: "bundle" | "reconstructed" }> {
  const collection = latest.collection;
  if (!collection?.fileName) throw new Error("Pinned public bundle has no downloadable package collection");
  if (!/^[A-Za-z0-9_.-]+$/.test(collection.fileName)) throw new Error("Collection archive filename is unsafe");

  const assets = releaseManifest.files.filter((record) => record.kind === "package-collection" && record.downloadName === collection.fileName);
  if (assets.length > 1) throw new Error(`Public asset manifest contains duplicate collection archives: ${collection.fileName}`);
  const asset = assets[0];
  if (asset && (asset.sizeBytes !== collection.sizeBytes || asset.sha256 !== collection.sha256)) {
    throw new Error("Collection asset metadata differs from release history");
  }

  const candidatePaths = [
    ...(asset ? [resolveAssetPath(root, asset.path)] : []),
    path.join(artifactRoot, "collections", collection.fileName),
  ];
  for (const candidatePath of new Set(candidatePaths)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (bytes.length !== collection.sizeBytes || sha256(bytes) !== collection.sha256) {
      throw new Error("Collection archive size or SHA differs from release history");
    }
    return { bytes, source: "bundle" };
  }

  return {
    bytes: await rebuildCollection(root, artifactRoot, latest, catalogBytes, releaseManifest),
    source: "reconstructed",
  };
}

export async function stageDataRelease(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = path.resolve(environment.ASSET_WORKTREE_ROOT ?? process.cwd());
  const artifactRoot = path.join(root, "artifacts", "public-survey-footprints");
  const destination = path.resolve(environment.DATA_RELEASE_ASSET_OUTPUT_ROOT ?? path.join(process.cwd(), "dist", "data-assets"));
  const notesPath = path.resolve(environment.DATA_RELEASE_NOTES_PATH ?? path.join(process.cwd(), "dist", "DATA-RELEASE-NOTES.md"));
  const tag = environment.DATA_RELEASE_TAG ?? "";
  const bundleId = environment.DATA_RELEASE_BUNDLE_ID ?? "";
  const bundleSha256 = environment.DATA_RELEASE_BUNDLE_SHA256 ?? "";

  if (!/^data-v\d+\.\d+\.\d+$/.test(tag) || !bundleId || !/^[a-f0-9]{64}$/.test(bundleSha256)) {
    throw new Error("Data release requires data-vX.Y.Z, a public bundle id and its SHA-256");
  }

  const history = JSON.parse(await readFile(path.join(artifactRoot, "release-history.json"), "utf8")) as {
    schemaVersion: number;
    latestReleaseId?: string;
    releases: DataReleaseHistoryEntry[];
  };
  if (history.schemaVersion !== 2 || !Array.isArray(history.releases)) {
    throw new Error(`Unsupported or invalid release history schema ${history.schemaVersion}`);
  }
  const latest = history.releases.find(entry => entry.releaseId === history.latestReleaseId)
    ?? [...history.releases].sort((left, right) => right.sequence - left.sequence)[0];
  if (!latest?.collection?.fileName) throw new Error("Pinned public bundle has no downloadable package collection");
  if (latest.packages.some(entry => /csst/i.test(entry.id) || /csst/i.test(entry.survey.id))) {
    throw new Error("Public release history contains a denied package");
  }

  const catalogRelative = "artifacts/public-survey-footprints/packages/catalog.json";
  const catalogBytes = await readFile(path.join(root, catalogRelative));
  const sanitizedCatalog = sanitizeReleaseControlDocument(catalogRelative, catalogBytes) ?? catalogBytes;
  const catalog = JSON.parse(sanitizedCatalog.toString("utf8")) as { packages: Array<{ id: string }> };
  if (!Array.isArray(catalog.packages) || catalog.packages.some(entry => /csst/i.test(entry.id))) {
    throw new Error("Public catalog is invalid or contains a denied package");
  }

  const releaseManifest = JSON.parse(
    await readFile(path.join(artifactRoot, "release-manifest.json"), "utf8"),
  ) as ReleaseAssetManifest;
  if (!Array.isArray(releaseManifest.files) || (releaseManifest.retainedPackages !== undefined && !Array.isArray(releaseManifest.retainedPackages))) {
    throw new Error("Public asset manifest is invalid");
  }

  const collection = await verifiedCollection(root, artifactRoot, latest, sanitizedCatalog, releaseManifest);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, latest.collection.fileName), collection.bytes);
  await writeFile(path.join(destination, "catalog.json"), sanitizedCatalog);
  await writeFile(path.join(destination, "release-history.json"), `${JSON.stringify(history, null, 2)}\n`);
  const info = {
    schemaVersion: 1,
    releaseKind: "data",
    dataTag: tag,
    publicBundle: { id: bundleId, sha256: bundleSha256 },
    packageBundleId: latest.bundleId,
    releaseId: latest.releaseId,
    sequence: latest.sequence,
    collection: latest.collection,
    collectionArtifactSource: collection.source,
    packages: latest.packages.length,
  };
  await writeFile(path.join(destination, "DATA-RELEASE-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);

  const notes = [
    `## Astro Survey Atlas data release ${tag.replace(/^data-/, "")}`,
    "",
    `Public bundle: \`${bundleId}\` (SHA-256 \`${bundleSha256}\`).`,
    `Resource package bundle: \`${latest.bundleId}\`.`,
    `Package collection: \`${latest.collection.fileName}\` (${latest.packages.length} packages, ${latest.collection.sizeBytes} bytes).`,
    ...(collection.source === "reconstructed" ? ["The collection archive was rebuilt from bundle package archives and matched the release-history SHA-256."] : []),
    "",
    "This release contains public survey coverage and downloadable resource package metadata. It is independent of the application image and Helm chart.",
    "Scientific pixels remain at the source archives and are not included.",
    "See DATA-RELEASE-INFO.json and SHA256SUMS for immutable bundle and file checksums.",
    "",
  ].join("\n");
  await mkdir(path.dirname(notesPath), { recursive: true });
  await writeFile(notesPath, notes);

  console.log(collection.source === "reconstructed"
    ? `rebuilt and verified ${latest.collection.fileName} (${latest.packages.length} packages, release ${latest.releaseId})`
    : `staged ${latest.collection.fileName} (${latest.packages.length} packages, release ${latest.releaseId})`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await stageDataRelease().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
