import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { ArtifactStore } from "./artifact-store.js";

export type ContentArchiveNamespace = "content" | "evidence";

export interface ContentArchiveFileRecord {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ContentArchivePointer {
  schemaVersion: 1;
  namespace: ContentArchiveNamespace;
  snapshot: string;
  files: number;
  bytes: number;
  updatedAt: string;
}

interface ContentArchiveManifest {
  schemaVersion: 1;
  namespace: ContentArchiveNamespace;
  files: ContentArchiveFileRecord[];
}

export interface ContentArchiveSnapshotResult {
  namespace: ContentArchiveNamespace;
  snapshot: string;
  currentKey: string;
  files: number;
  bytes: number;
  uploadedObjects: number;
  unchangedObjects: number;
  skipped: boolean;
}

export interface ContentArchiveDiff {
  namespace: ContentArchiveNamespace;
  snapshot: string | undefined;
  remoteFiles: number;
  missing: string[];
  changed: string[];
  extra: string[];
}

export interface ContentArchiveRestoreResult {
  namespace: ContentArchiveNamespace;
  snapshot: string;
  restored: number;
  skippedIdentical: number;
  bytes: number;
}

export class ContentArchiveError extends Error {
  constructor(message: string, readonly statusCode = 500) {
    super(message);
    this.name = "ContentArchiveError";
  }
}

const MANIFEST_SCHEMA_VERSION = 1;

function encodeManifest(manifest: ContentArchiveManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export class ContentArchiveSync {
  readonly root: string;
  readonly namespace: ContentArchiveNamespace;
  readonly #store: ArtifactStore;
  readonly #select: ((relativePath: string) => boolean) | undefined;

  constructor(options: { store: ArtifactStore; root: string; namespace: ContentArchiveNamespace; select?: (relativePath: string) => boolean }) {
    if (options.namespace !== "content" && options.namespace !== "evidence") throw new ContentArchiveError(`Unsupported content archive namespace: ${options.namespace}`, 400);
    this.#store = options.store;
    this.root = path.resolve(options.root);
    this.namespace = options.namespace;
    this.#select = options.select;
  }

  get currentKey(): string { return `${this.namespace}/current.json`; }
  #objectKey(sha256: string): string { return `${this.namespace}/objects/${sha256}`; }
  #snapshotKey(snapshot: string): string { return `${this.namespace}/snapshots/${snapshot}.json`; }

  async snapshot(): Promise<ContentArchiveSnapshotResult> {
    const manifest = await this.#scan();
    const encoded = encodeManifest(manifest);
    const snapshot = createHash("sha256").update(encoded).digest("hex");
    const files = manifest.files.length;
    const bytes = manifest.files.reduce((sum, record) => sum + record.sizeBytes, 0);
    const existingPointer = await this.#readPointer();
    if (existingPointer?.snapshot === snapshot) {
      const present = await this.#store.head(this.#snapshotKey(snapshot));
      if (present) {
        return { namespace: this.namespace, snapshot, currentKey: this.currentKey, files, bytes, uploadedObjects: 0, unchangedObjects: files, skipped: true };
      }
    }
    let uploadedObjects = 0;
    let unchangedObjects = 0;
    for (const record of manifest.files) {
      const objectKey = this.#objectKey(record.sha256);
      const existing = await this.#store.head(objectKey);
      if (existing) {
        if (existing.sizeBytes !== record.sizeBytes) throw new ContentArchiveError(`Content object already exists with a different size: ${objectKey}`, 409);
        unchangedObjects += 1;
        continue;
      }
      await this.#store.putFileImmutable(objectKey, this.#absolute(record.path), {
        contentType: "application/octet-stream",
        metadata: { namespace: this.namespace, path: record.path },
      });
      uploadedObjects += 1;
    }
    await this.#store.putImmutable(this.#snapshotKey(snapshot), encoded, { contentType: "application/json; charset=utf-8" });
    const pointer: ContentArchivePointer = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      namespace: this.namespace,
      snapshot,
      files,
      bytes,
      updatedAt: new Date().toISOString(),
    };
    await this.#store.putMutable(this.currentKey, `${JSON.stringify(pointer, null, 2)}\n`, { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" });
    return { namespace: this.namespace, snapshot, currentKey: this.currentKey, files, bytes, uploadedObjects, unchangedObjects, skipped: false };
  }

  async readPointer(): Promise<ContentArchivePointer | undefined> {
    return this.#readPointer();
  }

  async diff(): Promise<ContentArchiveDiff> {
    const pointer = await this.#readPointer();
    if (!pointer) return { namespace: this.namespace, snapshot: undefined, remoteFiles: 0, missing: [], changed: [], extra: [] };
    const manifest = await this.#readManifest(pointer.snapshot);
    const remote = new Map(manifest.files.map((record) => [record.path, record]));
    const local = new Map((await this.#scan()).files.map((record) => [record.path, record]));
    const missing: string[] = [];
    const changed: string[] = [];
    for (const [filePath, record] of remote) {
      const found = local.get(filePath);
      if (!found) missing.push(filePath);
      else if (found.sha256 !== record.sha256 || found.sizeBytes !== record.sizeBytes) changed.push(filePath);
    }
    const extra = [...local.keys()].filter((filePath) => !remote.has(filePath));
    return { namespace: this.namespace, snapshot: pointer.snapshot, remoteFiles: remote.size, missing, changed, extra };
  }

  async restore(options: { targetRoot?: string; overwrite?: boolean } = {}): Promise<ContentArchiveRestoreResult> {
    const pointer = await this.#readPointer();
    if (!pointer) throw new ContentArchiveError(`No ${this.namespace} snapshot has been published yet`, 404);
    const manifest = await this.#readManifest(pointer.snapshot);
    const targetRoot = path.resolve(options.targetRoot ?? this.root);
    let restored = 0;
    let skippedIdentical = 0;
    for (const record of manifest.files) {
      const target = this.#inside(targetRoot, record.path);
      let identical = false;
      try {
        const details = await stat(target);
        if (details.isFile() && details.size === record.sizeBytes) {
          identical = (await this.#hashFile(target)) === record.sha256;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (identical) {
        skippedIdentical += 1;
        continue;
      }
      if (!options.overwrite) {
        let exists = false;
        try { exists = (await stat(target)).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (exists) throw new ContentArchiveError(`Refusing to overwrite existing ${this.namespace} file without overwrite: ${record.path}`, 409);
      }
      const object = await this.#store.get(this.#objectKey(record.sha256));
      if (!object) throw new ContentArchiveError(`Content object is missing from the archive store: ${this.#objectKey(record.sha256)}`, 404);
      if (object.body.length !== record.sizeBytes || createHash("sha256").update(object.body).digest("hex") !== record.sha256) {
        throw new ContentArchiveError(`Content object failed checksum verification: ${record.path}`, 409);
      }
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.restore-${process.pid}-${restored}.tmp`;
      await writeFile(temporary, object.body, { flag: "wx" });
      await rm(target, { force: true });
      await rename(temporary, target);
      restored += 1;
    }
    return { namespace: this.namespace, snapshot: pointer.snapshot, restored, skippedIdentical, bytes: pointer.bytes };
  }

  async #readPointer(): Promise<ContentArchivePointer | undefined> {
    const object = await this.#store.get(this.currentKey);
    if (!object) return undefined;
    const value = JSON.parse(object.body.toString("utf8")) as ContentArchivePointer;
    if (value?.schemaVersion !== MANIFEST_SCHEMA_VERSION || value.namespace !== this.namespace || !/^[a-f0-9]{64}$/.test(value.snapshot ?? "")) {
      throw new ContentArchiveError(`Unsupported ${this.namespace} archive pointer`, 500);
    }
    return value;
  }

  async #readManifest(snapshot: string): Promise<ContentArchiveManifest> {
    const object = await this.#store.get(this.#snapshotKey(snapshot));
    if (!object) throw new ContentArchiveError(`Archived ${this.namespace} snapshot is missing: ${snapshot}`, 404);
    return JSON.parse(object.body.toString("utf8")) as ContentArchiveManifest;
  }

  async #scan(): Promise<ContentArchiveManifest> {
    const files: ContentArchiveFileRecord[] = [];
    const walk = async (directory: string, relative: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new ContentArchiveError(`${this.namespace} archive refuses symbolic links: ${child}`, 400);
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), child);
          continue;
        }
        if (!entry.isFile()) throw new ContentArchiveError(`${this.namespace} archive refuses special files: ${child}`, 400);
        if (this.#select && !this.#select(child)) continue;
        const absolutePath = path.join(directory, entry.name);
        const details = await stat(absolutePath);
        if (!Number.isSafeInteger(details.size) || details.size < 0) throw new ContentArchiveError(`${this.namespace} archive found an invalid file size: ${child}`);
        files.push({ path: child, sizeBytes: details.size, sha256: await this.#hashFile(absolutePath) });
      }
    };
    try {
      await walk(this.root, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ContentArchiveError(`${this.namespace} root directory does not exist: ${this.root}`, 400);
      throw error;
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, namespace: this.namespace, files };
  }

  #absolute(relativePath: string): string {
    return this.#inside(this.root, relativePath);
  }

  #inside(rootPath: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0") || relativePath.includes("\\")) {
      throw new ContentArchiveError(`Unsafe ${this.namespace} archive path: ${relativePath}`, 400);
    }
    const normalized = path.posix.normalize(relativePath);
    if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new ContentArchiveError(`Unsafe ${this.namespace} archive path: ${relativePath}`, 400);
    }
    return path.resolve(rootPath, ...normalized.split("/"));
  }

  async #hashFile(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
  }
}

export function namespaceRootFromProcess(namespace: ContentArchiveNamespace, environment: NodeJS.ProcessEnv = process.env): string {
  const value = namespace === "content" ? environment.ASSETS_CONTENT_ROOT : environment.ASSETS_EVIDENCE_ROOT;
  return path.resolve(value ?? (namespace === "content" ? "/var/lib/assets-content" : "/var/lib/assets-evidence"));
}
