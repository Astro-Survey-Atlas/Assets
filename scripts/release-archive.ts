import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { createArtifactStoreFromProcess, publishReleaseArchive, type ReleaseArchiveDescriptor } from "../server/artifact-store.js";
import { publicReleaseBundleDigest } from "../server/catalog.js";
import type { PublicAssetRecord } from "../server/types.js";

const execFile = promisify(execFileCallback);
const root = path.resolve(process.env.ASSET_WORKTREE_ROOT ?? process.cwd());
const manifestRelativePath = "artifacts/public-survey-footprints/release-manifest.json";

interface ReleaseManifest {
  schemaVersion: number;
  generatedAt: string;
  bundle: { id: string; sha256: string };
  files: PublicAssetRecord[];
}

export interface PackagedRelease extends ReleaseArchiveDescriptor {
  metadataPath: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileDigest(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  return { sizeBytes: bytes.length, sha256: digest(bytes) };
}

function safeRelative(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error(`Unsafe release path: ${relativePath}`);
  const normalized = path.posix.normalize(relativePath.replaceAll(path.sep, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) throw new Error(`Unsafe release path: ${relativePath}`);
  return normalized;
}

function inside(rootPath: string, relativePath: string): string {
  const safe = safeRelative(relativePath);
  const absolute = path.resolve(rootPath, ...safe.split("/"));
  const relative = path.relative(rootPath, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Release path escapes root: ${relativePath}`);
  return absolute;
}

async function packageSource(sourceRoot: string, record: PublicAssetRecord, stagingRoot: string | undefined): Promise<string> {
  const sourcePath = inside(sourceRoot, record.path);
  if (record.kind === "package" && stagingRoot) {
    const stagedPath = inside(path.resolve(stagingRoot), path.basename(record.path));
    try {
      await stat(stagedPath);
      return stagedPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`Resource Package staging file is missing: ${stagedPath}`);
    }
  }
  return sourcePath;
}

async function validateAndCopy(sourceRoot: string, record: PublicAssetRecord, stagingRoot: string | undefined, outputRoot: string): Promise<void> {
  const sourcePath = await packageSource(sourceRoot, record, stagingRoot);
  const details = await fileDigest(sourcePath).catch((error) => {
    throw new Error(`Release asset is unavailable: ${record.path}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (details.sizeBytes !== record.sizeBytes || details.sha256 !== record.sha256) throw new Error(`Release asset checksum mismatch: ${record.id}`);
  const destination = inside(outputRoot, record.path);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
}

async function listFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Release archive refuses special file: ${child}`);
  }
  return files;
}

async function createTarGz(sourceRoot: string, outputPath: string): Promise<void> {
  const files = await listFiles(sourceRoot);
  if (!files.length) throw new Error("Release archive is empty");
  const listPath = `${outputPath}.files.${process.pid}`;
  await writeFile(listPath, `${files.map((file) => `${file}\0`).join("")}`, "utf8");
  try {
    await execFile("tar", [
      "--create", "--gzip", "--file", outputPath,
      "--directory", sourceRoot,
      "--null", "--verbatim-files-from", "--files-from", listPath,
      "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
    ]);
  } finally {
    await rm(listPath, { force: true });
  }
}

export async function packageRelease(options: { root?: string; stagingRoot?: string; outputPath?: string } = {}): Promise<PackagedRelease> {
  const sourceRoot = path.resolve(options.root ?? root);
  const releaseManifestPath = path.join(sourceRoot, manifestRelativePath);
  const manifest = JSON.parse(await readFile(releaseManifestPath, "utf8")) as ReleaseManifest;
  if (manifest.schemaVersion !== 1 || !manifest.bundle?.id || !/^[a-f0-9]{64}$/.test(manifest.bundle.sha256) || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Unsupported or empty release manifest");
  if (publicReleaseBundleDigest(manifest.files) !== manifest.bundle.sha256) throw new Error("Release manifest bundle digest does not cover its own records");
  const stagingRoot = options.stagingRoot ?? process.env.ASSETS_PACKAGE_STAGING_ROOT;
  const outputPath = path.resolve(options.outputPath ?? process.env.ASSETS_RELEASE_ARCHIVE ?? path.join(sourceRoot, "dist", "release", `${manifest.bundle.sha256}.tar.gz`));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(path.dirname(outputPath), `.release-tree-${process.pid}-`));
  try {
    for (const record of manifest.files) {
      if (!record.id || !record.path || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`Invalid release asset record: ${record.id}`);
      if (record.deliveryClass === "evidence") throw new Error(`Release archive must not package evidence records: ${record.id}`);
      await validateAndCopy(sourceRoot, record, stagingRoot, temporaryRoot);
    }
    const manifestDestination = inside(temporaryRoot, manifestRelativePath);
    await mkdir(path.dirname(manifestDestination), { recursive: true });
    await copyFile(releaseManifestPath, manifestDestination);
    const archivedFiles = await listFiles(temporaryRoot);
    const expectedFiles = new Set([...manifest.files.map((record) => inside(temporaryRoot, record.path)), manifestDestination]);
    const absoluteFiles = archivedFiles.map((file) => path.resolve(temporaryRoot, file));
    if (archivedFiles.length !== expectedFiles.size || absoluteFiles.some((file) => !expectedFiles.has(file))) {
      const unexpected = absoluteFiles.filter((file) => !expectedFiles.has(file));
      throw new Error(`Staged release tree does not exactly match the release manifest (unexpected: ${unexpected.slice(0, 5).join(", ") || "none"})`);
    }
    await createTarGz(temporaryRoot, outputPath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const archive = await fileDigest(outputPath);
  const descriptor: PackagedRelease = {
    bundle: manifest.bundle,
    archivePath: outputPath,
    archiveSizeBytes: archive.sizeBytes,
    archiveSha256: archive.sha256,
    metadataPath: `${outputPath}.json`,
  };
  await writeFile(descriptor.metadataPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  console.log(`Packaged ${manifest.bundle.id}: ${archive.sizeBytes} bytes, ${archive.sha256}`);
  return descriptor;
}

export async function uploadRelease(options: { metadataPath?: string } = {}) {
  const metadataPath = path.resolve(options.metadataPath ?? process.env.ASSETS_RELEASE_ARCHIVE_METADATA ?? `${process.env.ASSETS_RELEASE_ARCHIVE ?? path.join(root, "dist", "release", "current.tar.gz")}.json`);
  const descriptor = JSON.parse(await readFile(metadataPath, "utf8")) as ReleaseArchiveDescriptor;
  const archive = await fileDigest(descriptor.archivePath);
  if (archive.sizeBytes !== descriptor.archiveSizeBytes || archive.sha256 !== descriptor.archiveSha256) throw new Error("Release archive metadata does not match the local archive");
  const store = createArtifactStoreFromProcess(process.env);
  if (store.kind !== "s3") throw new Error("Release archive upload requires an S3-compatible object store");
  const published = await publishReleaseArchive(descriptor, store, { currentKey: process.env.ASSETS_OBJECT_STORE_CURRENT_KEY });
  console.log(`Published ${published.bundle.id}: ${published.archiveKey} (${published.archiveSha256})`);
  return published;
}

if (process.argv[1]?.endsWith("release-archive.ts")) {
  const command = process.argv[2] ?? "package";
  if (command === "package") await packageRelease();
  else if (command === "upload") await uploadRelease();
  else throw new Error("Usage: release-archive.ts package|upload");
}
