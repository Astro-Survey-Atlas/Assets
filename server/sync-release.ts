import { cp, lstat, mkdir, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createArtifactStoreFromProcess, publishReleaseBundle } from "./artifact-store.js";
import { loadCatalog } from "./catalog.js";

interface ObjectReleaseFile {
  path: string;
  sizeBytes: number;
  sha256: string;
  objectKey?: string;
}

interface ObjectReleaseManifest {
  schemaVersion: 1;
  generatedAt: string;
  bundle: { id: string; sha256: string };
  files: ObjectReleaseFile[];
}

interface CurrentPointer {
  schemaVersion: 1;
  bundle: { id: string; sha256: string };
  manifestKey: string;
}

function safeRelative(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error(`Unsafe release path: ${relativePath}`);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Release path escapes target: ${relativePath}`);
  return absolute;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCurrent(bytes: Buffer): CurrentPointer {
  const value = JSON.parse(bytes.toString("utf8")) as Partial<CurrentPointer>;
  if (value.schemaVersion !== 1 || !value.bundle || typeof value.bundle.id !== "string" || !/^[a-f0-9]{64}$/.test(value.bundle.sha256 ?? "") || typeof value.manifestKey !== "string") {
    throw new Error("Object-store current pointer is invalid");
  }
  return value as CurrentPointer;
}

function parseManifest(bytes: Buffer): ObjectReleaseManifest {
  const value = JSON.parse(bytes.toString("utf8")) as Partial<ObjectReleaseManifest>;
  if (value.schemaVersion !== 1 || !value.bundle || typeof value.bundle.id !== "string" || !/^[a-f0-9]{64}$/.test(value.bundle.sha256 ?? "") || !Array.isArray(value.files)) {
    throw new Error("Object-store release manifest is invalid");
  }
  for (const record of value.files) {
    if (!record || typeof record.path !== "string" || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1 || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) {
      throw new Error("Object-store release manifest contains an invalid file record");
    }
  }
  return value as ObjectReleaseManifest;
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
  const candidates = [] as Array<{ name: string; mtimeMs: number }>;
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
  let installed = false;
  try {
    const details = await lstat(finalPath);
    installed = details.isDirectory() && !details.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (installed) {
    await rm(stagingPath, { recursive: true, force: true });
    await loadCatalog(finalPath);
  } else {
    await rm(finalPath, { recursive: true, force: true });
    await loadCatalog(stagingPath);
    await rename(stagingPath, finalPath);
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
  if (cleanup) await cleanupReleaseHistory(targetRoot, retainReleases);
  return await readlink(currentPath);
}

/** Download, verify and atomically activate the bundle selected by current.json. */
export async function syncReleaseFromObjectStore(store: Awaited<ReturnType<typeof createArtifactStoreFromProcess>>, targetRoot: string, options: { currentKey?: string; retainReleases?: number; cleanup?: boolean } = {}): Promise<{ bundle: { id: string; sha256: string }; manifestKey: string; installedTarget: string; files: number }> {
  const currentKey = options.currentKey ?? "public/current.json";
  const pointerObject = await store.get(currentKey);
  if (!pointerObject) throw new Error(`Object-store current pointer is unavailable: ${currentKey}`);
  const pointer = parseCurrent(pointerObject.body);
  const manifestObject = await store.get(pointer.manifestKey);
  if (!manifestObject) throw new Error(`Object-store release manifest is unavailable: ${pointer.manifestKey}`);
  const manifest = parseManifest(manifestObject.body);
  if (manifest.bundle.id !== pointer.bundle.id || manifest.bundle.sha256 !== pointer.bundle.sha256) throw new Error("Object-store current pointer does not match the release manifest");
  const releaseName = manifest.bundle.sha256;
  const stagingPath = path.join(path.resolve(targetRoot), ".staging", `${releaseName}.${process.pid}`);
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: true });
  try {
    const manifestPath = safeRelative(stagingPath, "artifacts/public-survey-footprints/release-manifest.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifestObject.body, { flag: "wx" });
    for (const record of manifest.files) {
      const objectKey = record.objectKey ?? `public/releases/${manifest.bundle.id}/${manifest.bundle.sha256}/${record.path}`;
      const object = await store.get(objectKey);
      if (!object) throw new Error(`Release object is unavailable: ${objectKey}`);
      if (object.body.length !== record.sizeBytes || sha256(object.body) !== record.sha256) throw new Error(`Release object checksum mismatch: ${record.path}`);
      const destination = safeRelative(stagingPath, record.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, object.body, { flag: "wx" });
    }
    const installedTarget = await activateRelease(path.resolve(targetRoot), releaseName, stagingPath, options.retainReleases ?? 2, options.cleanup === true);
    return { bundle: manifest.bundle, manifestKey: pointer.manifestKey, installedTarget, files: manifest.files.length };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const targetRoot = path.resolve(process.env.ASSET_TARGET_ROOT ?? "/data");
  if (targetRoot === "/") throw new Error("Unsafe public asset synchronization paths");
  const mode = (process.env.ASSETS_OBJECT_STORE_MODE ?? "filesystem").trim().toLowerCase();
  const pullEnabled = mode === "pull" || /^(1|true|yes|on)$/i.test(process.env.ASSETS_OBJECT_STORE_PULL ?? "");
  if (pullEnabled) {
    const fallbackRoot = path.resolve(process.env.ASSETS_OBJECT_STORE_ROOT ?? path.join(targetRoot, "object-store"));
    const objectStore = createArtifactStoreFromProcess(process.env, fallbackRoot);
    if (objectStore.kind !== "s3") throw new Error("S3 pull mode requires ASSETS_OBJECT_STORE_ENDPOINT and ASSETS_OBJECT_STORE_BUCKET");
    const retainReleases = Number(process.env.ASSETS_RELEASE_RETENTION ?? "2");
    const cleanup = /^(1|true|yes|on)$/i.test(process.env.ASSETS_RELEASE_CLEANUP ?? "");
    const synced = await syncReleaseFromObjectStore(objectStore, targetRoot, { currentKey: process.env.ASSETS_OBJECT_STORE_CURRENT_KEY, retainReleases, cleanup });
    console.log(`Activated object-store bundle ${synced.bundle.id} (${synced.bundle.sha256}) at ${synced.installedTarget}`);
    return;
  }
  const sourceRoot = path.resolve(process.env.ASSET_SOURCE_ROOT ?? "/app/release");
  if (sourceRoot === targetRoot) throw new Error("Unsafe public asset synchronization paths");
  const source = await loadCatalog(sourceRoot);
  const releaseName = source.manifest.bundle.sha256;
  const releasesRoot = path.join(targetRoot, "releases");
  const stagingPath = path.join(releasesRoot, `.${releaseName}.${process.pid}.staging`);
  await mkdir(releasesRoot, { recursive: true });
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: true });
  for (const directory of ["artifacts", "contracts", "docs", "requirements", "src"]) {
    await cp(path.join(sourceRoot, directory), path.join(stagingPath, directory), { recursive: true, force: false });
  }
  const cleanup = /^(1|true|yes|on)$/i.test(process.env.ASSETS_RELEASE_CLEANUP ?? "");
  const installedTarget = await activateRelease(targetRoot, releaseName, stagingPath, Number(process.env.ASSETS_RELEASE_RETENTION ?? "2"), cleanup);
  console.log(`Published ${source.manifest.bundle.id} at ${installedTarget}`);
  const objectStoreEnabled = /^(1|true|yes|on)$/i.test(process.env.ASSETS_OBJECT_STORE_PUBLISH ?? "") || Boolean(process.env.ASSETS_OBJECT_STORE_ENDPOINT || process.env.ASSETS_OBJECT_STORE_BUCKET);
  if (objectStoreEnabled) {
    const fallbackRoot = path.resolve(process.env.ASSETS_OBJECT_STORE_ROOT ?? path.join(targetRoot, "object-store"));
    const objectStore = createArtifactStoreFromProcess(process.env, fallbackRoot);
    const published = await publishReleaseBundle(sourceRoot, objectStore);
    console.log(`Published object-store bundle ${published.bundle.id} (${published.bundle.sha256}) via ${objectStore.kind}: ${published.runtimeCount} runtime objects, ${published.evidenceCount} evidence objects`);
  }
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await main();
}
