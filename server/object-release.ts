import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactStore } from "./artifact-store.js";
import { assertExactReleaseTree, loadCatalog } from "./catalog.js";

export interface ObjectReleasePointer {
  schemaVersion: 3;
  bundle: { id: string; sha256: string };
  manifestKey: string;
  manifestSha256: string;
  publishedAt?: string;
}
interface ArchiveSource {
  schemaVersion: 2;
  bundle: { id: string; sha256: string };
  archiveKey: string;
  archiveSizeBytes: number;
  archiveSha256: string;
}
interface ObjectEntry { path: string; sha256: string; sizeBytes: number; key?: string }
interface ObjectManifest {
  schemaVersion: 1;
  bundle: ObjectReleasePointer["bundle"];
  baseArchive?: ArchiveSource;
  files: ObjectEntry[];
}
const manifestPath = "artifacts/public-survey-footprints/release-manifest.json";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function safe(value: string): boolean {
  return typeof value === "string" && !!value && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && value.split("/").every(p => p && p !== "." && p !== "..");
}
export function parseObjectPointer(value: ObjectReleasePointer): ObjectReleasePointer {
  if (value.schemaVersion !== 3 || !value.bundle?.id || !/^[a-f0-9]{64}$/.test(value.bundle.sha256) || !safe(value.manifestKey) || !/^[a-f0-9]{64}$/.test(value.manifestSha256)) throw new Error("Invalid object release pointer");
  return value;
}
async function readManifest(store: ArtifactStore, pointer: ObjectReleasePointer): Promise<ObjectManifest> {
  const object = await store.get(pointer.manifestKey);
  if (!object || hash(object.body) !== pointer.manifestSha256) throw new Error("Object release manifest checksum mismatch");
  const manifest = JSON.parse(object.body.toString()) as ObjectManifest;
  if (manifest.schemaVersion !== 1 || manifest.bundle.id !== pointer.bundle.id || manifest.bundle.sha256 !== pointer.bundle.sha256 || !Array.isArray(manifest.files)) throw new Error("Object release manifest identity mismatch");
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (!safe(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || (entry.key ? entry.key !== `public/objects/sha256/${entry.sha256}` : !manifest.baseArchive)) throw new Error("Invalid object release member");
    seen.add(entry.path);
  }
  return manifest;
}

/** Legacy members remain pinned to their existing archive; only changed bytes are uploaded. */
export async function uploadObjectRelease(root: string, baselineRoot: string, store: ArtifactStore, expectedSha: string): Promise<ObjectReleasePointer> {
  const current = await store.get(process.env.ASSETS_OBJECT_STORE_CURRENT_KEY ?? "public/current.json");
  const previous = current ? JSON.parse(current.body.toString()) as ObjectReleasePointer | ArchiveSource : undefined;
  if (previous && previous.bundle.sha256 !== expectedSha) throw new Error("Release authority changed before upload");
  const baseline = await loadCatalog(baselineRoot);
  const old = previous?.schemaVersion === 3 ? await readManifest(store, parseObjectPointer(previous)) : undefined;
  const inherited = new Map(old?.files.map(f => [f.path, f]) ?? (previous ? baseline.manifest.files.map(f => [f.path, { path: f.path, sha256: f.sha256, sizeBytes: f.sizeBytes }] as const) : []));
  const catalog = await loadCatalog(root);
  await assertExactReleaseTree(root, catalog);
  const records = [...catalog.manifest.files.map(f => ({ path: f.path, sha256: f.sha256, sizeBytes: f.sizeBytes }))];
  const bytes = await readFile(path.join(root, manifestPath));
  records.push({ path: manifestPath, sha256: hash(bytes), sizeBytes: bytes.length });
  const files: ObjectEntry[] = [];
  for (const record of records) {
    const prior = inherited.get(record.path);
    if (prior?.sha256 === record.sha256 && prior.sizeBytes === record.sizeBytes) { files.push(prior); continue; }
    const key = `public/objects/sha256/${record.sha256}`;
    const existing = await store.head(key);
    if (!existing) {
      const uploaded = await store.putFileImmutable(key, path.join(root, record.path));
      if (uploaded.sha256 !== record.sha256 || uploaded.sizeBytes !== record.sizeBytes) throw new Error("Object upload checksum mismatch");
    } else if (existing.sha256 !== record.sha256 || existing.sizeBytes !== record.sizeBytes) throw new Error("Existing object checksum mismatch");
    files.push({ ...record, key });
  }
  const baseArchive = previous?.schemaVersion === 2 ? previous : old?.baseArchive;
  const manifest: ObjectManifest = { schemaVersion: 1, bundle: catalog.manifest.bundle, ...(files.some(f => !f.key) ? { baseArchive } : {}), files };
  const body = Buffer.from(JSON.stringify(manifest));
  const manifestSha256 = hash(body), manifestKey = `public/manifests/${manifestSha256}.json`;
  await store.putImmutable(manifestKey, body, { contentType: "application/json" });
  return { schemaVersion: 3, bundle: manifest.bundle, manifestKey, manifestSha256 };
}

export async function restoreObjectRelease(store: ArtifactStore, pointer: ObjectReleasePointer, root: string, cacheRoot?: string): Promise<void> {
  const manifest = await readManifest(store, pointer);
  let legacyRoot: string | undefined;
  for (const entry of manifest.files) {
    const target = path.join(root, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    let reused = false;
    if (cacheRoot) {
      const cached = await readFile(path.join(cacheRoot, entry.path)).catch(() => undefined);
      if (cached && cached.length === entry.sizeBytes && hash(cached) === entry.sha256) { await writeFile(target, cached); reused = true; }
    }
    if (!reused && entry.key) {
      const fetched = await store.downloadToFile(entry.key, target);
      if (!fetched || fetched.sha256 !== entry.sha256 || fetched.sizeBytes !== entry.sizeBytes) throw new Error(`Object restore checksum mismatch: ${entry.path}`);
    } else if (!reused) {
      // A retained object manifest may reference a legacy member without an
      // archive pointer. Reuse the active installed release before failing.
      if (cacheRoot) {
        const activeBytes = await readFile(path.join(cacheRoot, entry.path)).catch(() => undefined);
        if (activeBytes && activeBytes.length === entry.sizeBytes && hash(activeBytes) === entry.sha256) { await writeFile(target, activeBytes); reused = true; }
      }
      if (reused) continue;
      if (!manifest.baseArchive) throw new Error("Missing legacy archive reference");
      if (!legacyRoot) {
        const { syncReleaseFromObjectStore, parseCurrentPointer } = await import("./sync-release.js");
        const base = parseCurrentPointer(Buffer.from(JSON.stringify(manifest.baseArchive)));
        const legacyCache = path.join(path.dirname(root), "legacy");
        await syncReleaseFromObjectStore(store, legacyCache, { pinnedPointer: base });
        legacyRoot = path.join(legacyCache, "current");
      }
      const source = path.join(legacyRoot, entry.path);
      const bytes = await readFile(source);
      if (bytes.length !== entry.sizeBytes || hash(bytes) !== entry.sha256) throw new Error("Legacy object checksum mismatch");
      await copyFile(source, target);
    }
  }
  const catalog = await loadCatalog(root);
  await assertExactReleaseTree(root, catalog);
  if (catalog.manifest.bundle.sha256 !== pointer.bundle.sha256 || catalog.manifest.bundle.id !== pointer.bundle.id) throw new Error("Restored object release identity mismatch");
}

export async function activateObjectRelease(store: ArtifactStore, pointer: ObjectReleasePointer, expectedSha: string): Promise<ObjectReleasePointer> {
  const key = process.env.ASSETS_OBJECT_STORE_CURRENT_KEY ?? "public/current.json";
  const current = await store.get(key);
  if (current && JSON.parse(current.body.toString()).bundle?.sha256 !== expectedSha) throw new Error("Release authority changed before activation");
  const published = { ...pointer, publishedAt: new Date().toISOString() };
  const body = JSON.stringify(published);
  await store.putMutable(key, body, { ...(current ? { ifMatch: current.etag ?? current.sha256 } : { ifNoneMatch: "*" }), contentType: "application/json", cacheControl: "no-cache" });
  const verified = await store.get(key);
  if (!verified || hash(verified.body) !== hash(Buffer.from(body))) throw new Error("Release pointer verification failed");
  return published;
}
