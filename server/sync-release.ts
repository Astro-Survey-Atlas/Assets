import { parseObjectPointer, restoreObjectRelease } from "./object-release.js";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createArtifactStoreFromProcess, type ArtifactStore } from "./artifact-store.js";
import { assertExactReleaseTree, loadCatalog } from "./catalog.js";

const execFile = promisify(execFileCallback);

export interface ArchivePointer {
  schemaVersion: 2;
  bundle: { id: string; sha256: string };
  archiveKey: string;
  archiveSizeBytes: number;
  archiveSha256: string;
  publishedAt?: string;
}

export type CurrentPointer = ArchivePointer | import("./object-release.js").ObjectReleasePointer;

function cleanArchiveKey(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || path.posix.isAbsolute(value)) throw new Error("Object-store current pointer contains an unsafe archive key");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Object-store current pointer contains an unsafe archive key");
  return value;
}

export function parseCurrentPointer(bytes: Uint8Array): CurrentPointer {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (value.schemaVersion === 3) return parseObjectPointer(value);
  if (value.schemaVersion !== 2 || !value.bundle || typeof value.bundle.id !== "string" || !/^[a-f0-9]{64}$/.test(value.bundle.sha256 ?? "") || !/^[a-f0-9]+$/.test(value.archiveSha256 ?? "") || !Number.isSafeInteger(value.archiveSizeBytes) || (value.archiveSizeBytes ?? 0) < 1) {
    throw new Error("Object-store current pointer is invalid");
  }
  cleanArchiveKey(value.archiveKey);
  if (value.archiveSha256?.length !== 64) throw new Error("Object-store current pointer has an invalid archive SHA-256");
  return value as CurrentPointer;
}

function safeArchiveMember(member: string): void {
  if (!member || member.includes("\0") || path.posix.isAbsolute(member)) throw new Error(`Release archive contains an unsafe path: ${member}`);
  const withoutSlash = member.replace(/\/$/, "");
  const normalized = path.posix.normalize(withoutSlash);
  if (!normalized || normalized === "." || normalized !== withoutSlash || normalized.split("/").some((part) => part === ".." || part === "." || !part)) throw new Error(`Release archive contains an unsafe path: ${member}`);
}

async function validateArchive(archivePath: string): Promise<void> {
  const listed = await execFile("tar", ["--list", "--file", archivePath, "--gzip", "--quoting-style=escape"]);
  const names = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!names.length) throw new Error("Release archive is empty");
  for (const name of names) safeArchiveMember(name);
  const verbose = await execFile("tar", ["--list", "--file", archivePath, "--gzip", "--verbose", "--quoting-style=escape"]);
  for (const line of verbose.stdout.split("\n")) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type === "l" || type === "h") throw new Error("Release archive must not contain symbolic or hard links");
    if (type !== "-" && type !== "d") throw new Error("Release archive contains an unsupported special file");
  }
}

function releaseRetentionCount(value: number): number {
  return Math.max(1, Number.isSafeInteger(value) ? value : 2);
}

/** Remove old immutable release directories without touching the active link. */
export async function cleanupReleaseHistory(targetRoot: string, retainReleases: number): Promise<number> {
  const resolvedRoot = path.resolve(targetRoot);
  if (resolvedRoot === "/") throw new Error("Unsafe public asset synchronization paths");
  const releasesRoot = path.join(resolvedRoot, "releases");
  const currentPath = path.join(resolvedRoot, "current");
  const currentTarget = await readlink(currentPath).catch(() => undefined);
  const activeName = currentTarget ? path.basename(currentTarget) : undefined;
  const keep = releaseRetentionCount(retainReleases);
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of await readdir(releasesRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const details = await stat(path.join(releasesRoot, entry.name));
    candidates.push({ name: entry.name, mtimeMs: details.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const retained = new Set([activeName, ...candidates.filter((entry) => entry.name !== activeName).slice(0, keep - 1).map((entry) => entry.name)].filter((name): name is string => Boolean(name)));
  let removed = 0;
  for (const entry of candidates) {
    if (retained.has(entry.name)) continue;
    await rm(path.join(releasesRoot, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function activateRelease(targetRoot: string, releaseName: string, stagingPath: string, retainReleases: number, cleanup: boolean): Promise<string> {
  const releasesRoot = path.join(targetRoot, "releases");
  const finalPath = path.join(releasesRoot, releaseName);
  await mkdir(releasesRoot, { recursive: true });
  let stagingReady = false;
  try {
    const details = await lstat(stagingPath);
    stagingReady = details.isDirectory() && !details.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stagingReady) {
    // A verified extracted tree always replaces any prior directory under this hash
    // (including a corrupt cache left in place until the new archive validated).
    await loadCatalog(stagingPath);
    await rm(finalPath, { recursive: true, force: true });
    await rename(stagingPath, finalPath);
  } else {
    await loadCatalog(finalPath);
  }
  const currentPath = path.join(targetRoot, "current");
  const nextPath = path.join(targetRoot, `.current.${process.pid}`);
  await rm(nextPath, { force: true });
  await symlink(path.relative(targetRoot, finalPath), nextPath, "dir");
  await rename(nextPath, currentPath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    const current = await lstat(currentPath);
    if (!current.isSymbolicLink()) throw new Error("Refusing to replace a non-symlink public asset current path");
    await rm(currentPath);
    await rename(nextPath, currentPath);
  });
  if (cleanup) {
    try {
      await cleanupReleaseHistory(targetRoot, retainReleases);
    } catch (error) {
      console.warn(`Release history cleanup failed after activation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return await readlink(currentPath);
}

async function scavengeStaleStaging(stagingRoot: string, keepName: string): Promise<void> {
  await mkdir(stagingRoot, { recursive: true });
  for (const entry of await readdir(stagingRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === keepName) continue;
    await rm(path.join(stagingRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withReleaseLock<T>(targetRoot: string, work: () => Promise<T>): Promise<T> {
  const lockPath = path.join(targetRoot, ".sync.lock");
  await mkdir(targetRoot, { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await open(lockPath, "r").catch(() => undefined);
    const owner = existing ? Number((await existing.readFile("utf8").catch(() => "")).trim()) : Number.NaN;
    await existing?.close().catch(() => undefined);
    // A PID is only meaningful inside the process namespace that created the lock.
    // Init and publisher containers both use PID 1, so a leftover PVC lock from a
    // terminated container must be treated as stale when it names this process.
    if (owner !== process.pid && processAlive(owner)) throw new Error(`Another release synchronization is already running (pid ${owner})`);
    await rm(lockPath, { force: true });
    handle = await open(lockPath, "wx");
  }
  try {
    await handle.writeFile(String(process.pid), "utf8");
    return await work();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

const ARCHIVE_SHA_MARKER = ".archive-sha256";

async function writeArchiveShaMarker(releasePath: string, archiveSha256: string): Promise<void> {
  await writeFile(path.join(releasePath, ARCHIVE_SHA_MARKER), `${archiveSha256}\n`, "utf8");
}

async function readArchiveShaMarker(releasePath: string): Promise<string | undefined> {
  const value = await readFile(path.join(releasePath, ARCHIVE_SHA_MARKER), "utf8").catch(() => undefined);
  const trimmed = value?.trim();
  return trimmed && /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : undefined;
}

async function validateInstalledRelease(
  releasePath: string,
  expected?: { id: string; sha256: string; archiveSha256?: string },
): Promise<Awaited<ReturnType<typeof loadCatalog>>> {
  const catalog = await loadCatalog(releasePath);
  if (expected && (catalog.manifest.bundle.id !== expected.id || catalog.manifest.bundle.sha256 !== expected.sha256)) {
    throw new Error("Installed release bundle identity does not match the current pointer");
  }
  if (expected?.archiveSha256) {
    const marker = await readArchiveShaMarker(releasePath);
    if (marker && marker !== expected.archiveSha256) {
      throw new Error("Installed release archive SHA marker does not match the current pointer");
    }
  }
  await assertExactReleaseTree(releasePath, catalog);
  return catalog;
}

async function useInstalledCurrent(targetRoot: string, reason: string): Promise<{ bundle: { id: string; sha256: string }; archiveKey: string; installedTarget: string; files: number }> {
  const currentPath = path.join(targetRoot, "current");
  const currentTarget = await readlink(currentPath);
  if (!currentTarget.startsWith("releases/") || currentTarget.includes("..")) throw new Error("Installed current release link is unsafe");
  const releasePath = path.resolve(targetRoot, currentTarget);
  if (!releasePath.startsWith(path.join(targetRoot, "releases") + path.sep)) throw new Error("Installed current release escapes the releases root");
  const catalog = await validateInstalledRelease(releasePath);
  console.warn(`Using installed release ${catalog.manifest.bundle.id} (${catalog.manifest.bundle.sha256}) because object-store current pointer is unavailable: ${reason}`);
  return {
    bundle: catalog.manifest.bundle,
    archiveKey: "",
    installedTarget: currentTarget.replaceAll("\\", "/"),
    files: catalog.manifest.files.length,
  };
}

/** Download one versioned tar.gz release, validate it and atomically activate it. */
export async function syncReleaseFromObjectStore(store: ArtifactStore, targetRoot: string, options: { currentKey?: string; pinnedPointer?: CurrentPointer; retainReleases?: number; cleanup?: boolean; allowInstalledFallback?: boolean } = {}): Promise<{ bundle: { id: string; sha256: string }; archiveKey: string; installedTarget: string; files: number }> {
  if (store.kind !== "s3") throw new Error("Archive release synchronization requires an S3-compatible object store");
  const resolvedRoot = path.resolve(targetRoot);
  if (resolvedRoot === "/") throw new Error("Unsafe public asset synchronization paths");
  return withReleaseLock(resolvedRoot, async () => {
    const currentKey = options.currentKey ?? "public/current.json";
    let pointer: CurrentPointer;
    try {
      if (options.pinnedPointer) pointer = options.pinnedPointer;
      else {
        const pointerObject = await store.get(currentKey);
        if (!pointerObject) throw new Error(`Object-store current pointer is unavailable: ${currentKey}`);
        pointer = parseCurrentPointer(pointerObject.body);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Installed-cache reuse is a deliberate offline mode, never an implicit
      // substitute for a missing authority pointer.
      if (options.allowInstalledFallback !== true) throw error instanceof Error ? error : new Error(reason);
      try {
        return await useInstalledCurrent(resolvedRoot, reason);
      } catch {
        throw error instanceof Error ? error : new Error(reason);
      }
    }
    if (pointer.schemaVersion === 3) {
      const releaseName = pointer.bundle.sha256;
      const staging = path.join(resolvedRoot, ".staging", `${releaseName}.${process.pid}`);
      await rm(staging, { recursive: true, force: true });
      try {
        await restoreObjectRelease(store, pointer, path.join(staging, "tree"), path.join(resolvedRoot, "current"));
        const installedTarget = await activateRelease(resolvedRoot, releaseName, path.join(staging, "tree"), options.retainReleases ?? 2, options.cleanup === true);
        const catalog = await loadCatalog(path.join(resolvedRoot, "current"));
        return { bundle: pointer.bundle, archiveKey: pointer.manifestKey, installedTarget, files: catalog.manifest.files.length };
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    const releaseName = pointer.bundle.sha256;
    const releasePath = path.join(resolvedRoot, "releases", releaseName);
    const stagingRoot = path.join(resolvedRoot, ".staging");
    const stagingName = `${releaseName}.${process.pid}`;
    const stagingPath = path.join(stagingRoot, stagingName);
    const archivePath = path.join(stagingPath, "release.tar.gz");
    await scavengeStaleStaging(stagingRoot, stagingName);
    await rm(stagingPath, { recursive: true, force: true });
    await mkdir(stagingPath, { recursive: true });
    try {
      let installed = false;
      let installedCatalog: Awaited<ReturnType<typeof loadCatalog>> | undefined;
      try {
        const details = await lstat(releasePath);
        if (details.isDirectory() && !details.isSymbolicLink()) {
          installedCatalog = await validateInstalledRelease(releasePath, { ...pointer.bundle, archiveSha256: pointer.archiveSha256 });
          installed = true;
        }
      } catch (error) {
        // Keep any existing tree until a replacement archive activates successfully so a
        // failed pull cannot delete the last known-good release behind /data/current.
        installed = false;
        installedCatalog = undefined;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`Cached release ${releaseName} failed validation and will be re-downloaded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!installed) {
        const archive = await store.downloadToFile(pointer.archiveKey, archivePath);
        if (!archive) throw new Error(`Release archive is unavailable: ${pointer.archiveKey}`);
        if (archive.sizeBytes !== pointer.archiveSizeBytes || archive.sha256 !== pointer.archiveSha256) throw new Error("Release archive checksum does not match current pointer");
        await validateArchive(archivePath);
        const extracted = path.join(stagingPath, "tree");
        await mkdir(extracted, { recursive: true });
        await execFile("tar", ["--extract", "--file", archivePath, "--gzip", "--directory", extracted, "--no-same-owner", "--no-same-permissions"]);
        const manifestPath = path.join(extracted, "artifacts", "public-survey-footprints", "release-manifest.json");
        await stat(manifestPath);
        const catalog = await loadCatalog(extracted);
        await assertExactReleaseTree(extracted, catalog);
        if (catalog.manifest.bundle.id !== pointer.bundle.id || catalog.manifest.bundle.sha256 !== pointer.bundle.sha256) throw new Error("Release archive manifest does not match current pointer");
        await writeArchiveShaMarker(extracted, pointer.archiveSha256);
        await activateRelease(resolvedRoot, releaseName, extracted, options.retainReleases ?? 2, options.cleanup === true);
        return { bundle: pointer.bundle, archiveKey: pointer.archiveKey, installedTarget: `releases/${releaseName}`, files: catalog.manifest.files.length };
      }
      const catalog = installedCatalog ?? await loadCatalog(releasePath);
      const currentTarget = await readlink(path.join(resolvedRoot, "current")).catch(() => undefined);
      if (currentTarget !== `releases/${releaseName}`) await activateRelease(resolvedRoot, releaseName, path.join(stagingPath, "unused"), options.retainReleases ?? 2, options.cleanup === true);
      return { bundle: pointer.bundle, archiveKey: pointer.archiveKey, installedTarget: `releases/${releaseName}`, files: catalog.manifest.files.length };
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  });
}

async function main(): Promise<void> {
  const targetRoot = path.resolve(process.env.ASSET_TARGET_ROOT ?? "/data");
  if (targetRoot === "/") throw new Error("Unsafe public asset synchronization paths");
  const objectStore = createArtifactStoreFromProcess(process.env);
  if (objectStore.kind !== "s3") throw new Error("ASSETS_OBJECT_STORE_ENDPOINT and ASSETS_OBJECT_STORE_BUCKET are required for archive pull");
  const synced = await syncReleaseFromObjectStore(objectStore, targetRoot, {
    currentKey: process.env.ASSETS_OBJECT_STORE_CURRENT_KEY,
    retainReleases: Number(process.env.ASSETS_RELEASE_RETENTION ?? "2"),
    cleanup: /^(1|true|yes|on)$/i.test(process.env.ASSETS_RELEASE_CLEANUP ?? ""),
    allowInstalledFallback: /^(1|true|yes|on)$/i.test(process.env.ASSETS_RELEASE_ALLOW_INSTALLED_FALLBACK ?? ""),
  });
  console.log(`Activated release archive ${synced.bundle.id} (${synced.bundle.sha256}) at ${synced.installedTarget}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) await main();
