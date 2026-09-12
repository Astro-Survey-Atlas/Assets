import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactStore } from "./artifact-store.js";
import type { UploadJobManifest, UploadSpool } from "./upload-spool.js";

export interface StateSnapshotPointer {
  schemaVersion: 1;
  namespace: string;
  generation: number;
  snapshotKey: string;
  snapshotSha256: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface StateSnapshotJob {
  namespace: string;
  generation: number;
  snapshotKey: string;
  snapshotSha256: string;
  sizeBytes: number;
  uploadId: string;
}

export interface StateSnapshotRestore {
  pointer: StateSnapshotPointer;
  state: unknown;
}

export interface StateSnapshotFileRecord {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

export interface StateSnapshotFileJob extends StateSnapshotFileRecord {
  namespace: string;
  uploadId: string;
}

export interface StateSnapshotFileEnqueueOptions {
  objectKey?: string;
  uploadId?: string;
  kind?: string;
  contentType?: string;
  metadata?: Record<string, string>;
  expectedSha256?: string;
  expectedSizeBytes?: number;
}

export interface StateSnapshotFileEnqueueRequest extends StateSnapshotFileEnqueueOptions {
  namespace: string;
  sourcePath: string;
}

export interface StateSnapshotFileRestoreOptions {
  namespace?: string;
  objectKey: string;
  destinationPath: string;
  sha256: string;
  sizeBytes: number;
}

interface LocalFileDetails {
  sha256: string;
  sizeBytes: number;
}

/**
 * The file methods are optional so the existing enqueue-only test doubles and
 * local callers remain valid while the coordinator can provide durable files.
 */
export interface StateSnapshotSink {
  enqueue(namespace: string, state: unknown): Promise<StateSnapshotJob>;
  restore?(namespace: string): Promise<StateSnapshotRestore | null>;
  enqueueFile?(
    requestOrNamespace: StateSnapshotFileEnqueueRequest | string,
    sourcePath?: string,
    options?: StateSnapshotFileEnqueueOptions,
  ): Promise<StateSnapshotFileJob>;
  restoreFile?(
    requestOrNamespace: StateSnapshotFileRestoreOptions | string,
    objectKey?: string,
    destinationPath?: string,
    expected?: Pick<StateSnapshotFileRestoreOptions, "sha256" | "sizeBytes">,
  ): Promise<StateSnapshotFileRecord | null>;
}

export const STATE_SNAPSHOT_NAMESPACES = [
  "products",
  "editorial",
  "moc-build",
  "moc-publications",
  "resource-packages",
  "publication-runs",
] as const;

/** Queue a local state snapshot without making the writer wait for S3. */
export function queueStateSnapshot(sink: StateSnapshotSink | undefined, namespace: string, state: unknown): void {
  if (!sink) return;
  void sink.enqueue(namespace, state).catch((error) => {
    console.warn(`State snapshot enqueue failed for ${namespace}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Queue a durable state file after its local write has completed. */
export function queueStateSnapshotFile(
  sink: StateSnapshotSink | undefined,
  request: StateSnapshotFileEnqueueRequest,
): void;
export function queueStateSnapshotFile(
  sink: StateSnapshotSink | undefined,
  namespace: string,
  sourcePath: string,
  options?: StateSnapshotFileEnqueueOptions,
): void;
export function queueStateSnapshotFile(
  sink: StateSnapshotSink | undefined,
  requestOrNamespace: StateSnapshotFileEnqueueRequest | string,
  sourcePath?: string,
  options: StateSnapshotFileEnqueueOptions = {},
): void {
  if (!sink?.enqueueFile) return;
  const request: StateSnapshotFileEnqueueRequest = typeof requestOrNamespace === "string"
    ? { ...options, namespace: requestOrNamespace, sourcePath: sourcePath ?? "" }
    : requestOrNamespace;
  void sink.enqueueFile(request).catch((error) => {
    console.warn(`State file enqueue failed for ${request.namespace}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export interface StateSnapshotCoordinatorOptions {
  root: string;
  store: ArtifactStore;
  spool: UploadSpool;
  now?: () => Date;
}

interface LocalGenerationDocument {
  schemaVersion: 1;
  generations: Record<string, number>;
}

function safeNamespace(namespace: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace)) throw new Error(`State namespace is unsafe: ${namespace}`);
  return namespace;
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileDetails(filePath: string): Promise<LocalFileDetails> {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`State file must be a regular file: ${filePath}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

function safeObjectKey(value: string): string {
  if (!value || value.includes("\0") || value.startsWith("/")) throw new Error(`State file object key is unsafe: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`State file object key is unsafe: ${value}`);
  return value;
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function pointerKey(namespace: string): string {
  return `state/${safeNamespace(namespace)}/current.json`;
}

function snapshotKey(namespace: string, generation: number, digest: string): string {
  return `state/${safeNamespace(namespace)}/snapshots/${generation}-${digest}.json`;
}

/** Stable object key for a file referenced by a state snapshot. */
export function stateSnapshotFileKey(namespaceValue: string, digest: string): string {
  const namespace = safeNamespace(namespaceValue);
  if (!validDigest(digest)) throw new Error(`State file SHA-256 is invalid: ${digest}`);
  return `state/${namespace}/files/${digest}`;
}

function parsePointer(value: unknown, namespace: string): StateSnapshotPointer {
  if (!value || typeof value !== "object") throw new Error(`State pointer is invalid: ${namespace}`);
  const pointer = value as Partial<StateSnapshotPointer>;
  if (pointer.schemaVersion !== 1 || pointer.namespace !== namespace || !Number.isSafeInteger(pointer.generation) || (pointer.generation ?? 0) < 1 || typeof pointer.snapshotKey !== "string" || !/^[a-f0-9]{64}$/.test(pointer.snapshotSha256 ?? "") || pointer.snapshotKey !== snapshotKey(namespace, pointer.generation as number, pointer.snapshotSha256 as string) || !Number.isSafeInteger(pointer.sizeBytes) || (pointer.sizeBytes ?? -1) < 0 || typeof pointer.updatedAt !== "string") {
    throw new Error(`State pointer is invalid: ${namespace}`);
  }
  return pointer as StateSnapshotPointer;
}

function metadataValue(manifest: UploadJobManifest, key: string): string | undefined {
  return manifest.metadata?.[key];
}

function snapshotJobFromManifest(manifest: UploadJobManifest): StateSnapshotJob | undefined {
  if (manifest.kind !== "state-snapshot") return undefined;
  const namespace = metadataValue(manifest, "stateNamespace");
  const generationText = metadataValue(manifest, "stateGeneration");
  if (!namespace || !generationText || !/^[1-9][0-9]*$/.test(generationText)) return undefined;
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)) return undefined;
  if (manifest.objectKey !== snapshotKey(namespace, generation, manifest.sha256)) return undefined;
  return { namespace, generation, snapshotKey: manifest.objectKey, snapshotSha256: manifest.sha256, sizeBytes: manifest.sizeBytes, uploadId: manifest.uploadId };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * Queues full state snapshots locally and advances one monotonic S3 pointer
 * after the spool has verified the immutable snapshot object. The worker is
 * the single pointer writer; callers only perform local I/O plus spool enqueue.
 */
export class StateSnapshotCoordinator implements StateSnapshotSink {
  readonly root: string;
  readonly #store: ArtifactStore;
  readonly #spool: UploadSpool;
  readonly #now: () => Date;
  readonly #generations = new Map<string, number>();
  readonly #enqueueQueues = new Map<string, Promise<unknown>>();
  readonly #fileEnqueueQueues = new Map<string, Promise<StateSnapshotFileJob>>();

  constructor(options: StateSnapshotCoordinatorOptions) {
    const root = path.resolve(options.root);
    if (root === path.parse(root).root) throw new Error("State snapshot root must not be a filesystem root");
    if (options.store.kind !== "s3") throw new Error("State snapshots require an S3-compatible object store");
    this.root = root;
    this.#store = options.store;
    this.#spool = options.spool;
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(namespaces: readonly string[] = []): Promise<void> {
    await mkdir(path.join(this.root, "generations"), { recursive: true });
    for (const namespaceValue of namespaces) {
      const namespace = safeNamespace(namespaceValue);
      const localGeneration = await this.readLocalGeneration(namespace);
      const pointer = await this.readPointer(namespace);
      const generation = Math.max(localGeneration, pointer?.generation ?? 0);
      this.#generations.set(namespace, generation);
      await this.writeLocalGeneration();
    }
  }

  async flush(): Promise<void> {
    for (;;) {
      const pending = [...this.#enqueueQueues.values(), ...this.#fileEnqueueQueues.values()];
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  async enqueue(namespaceValue: string, state: unknown): Promise<StateSnapshotJob> {
    const namespace = safeNamespace(namespaceValue);
    const previous = this.#enqueueQueues.get(namespace) ?? Promise.resolve();
    const operation = previous.then(() => this.enqueueOne(namespace, state));
    const tracked = operation.then(() => undefined, () => undefined);
    this.#enqueueQueues.set(namespace, tracked);
    try {
      return await operation;
    } finally {
      if (this.#enqueueQueues.get(namespace) === tracked) this.#enqueueQueues.delete(namespace);
    }
  }

  async enqueueFile(
    requestOrNamespace: StateSnapshotFileEnqueueRequest | string,
    sourcePath?: string,
    options: StateSnapshotFileEnqueueOptions = {},
  ): Promise<StateSnapshotFileJob> {
    const request: StateSnapshotFileEnqueueRequest = typeof requestOrNamespace === "string"
      ? { ...options, namespace: requestOrNamespace, sourcePath: sourcePath ?? "" }
      : requestOrNamespace;
    const namespace = safeNamespace(request.namespace);
    const source = await fileDetails(request.sourcePath);
    if (request.expectedSha256 !== undefined && request.expectedSha256 !== source.sha256) throw new Error(`State file SHA-256 changed before enqueue: ${request.sourcePath}`);
    if (request.expectedSizeBytes !== undefined && request.expectedSizeBytes !== source.sizeBytes) throw new Error(`State file size changed before enqueue: ${request.sourcePath}`);
    const objectKey = safeObjectKey(request.objectKey ?? stateSnapshotFileKey(namespace, source.sha256));
    const uploadId = request.uploadId ?? `state-file-${namespace.slice(0, 48)}-${source.sha256}`;
    const queueKey = `${namespace}:${objectKey}`;
    const previous = this.#fileEnqueueQueues.get(queueKey);
    if (previous) return previous;
    const operation = this.enqueueFileOne(request, namespace, source, objectKey, uploadId);
    this.#fileEnqueueQueues.set(queueKey, operation);
    try {
      return await operation;
    } finally {
      if (this.#fileEnqueueQueues.get(queueKey) === operation) this.#fileEnqueueQueues.delete(queueKey);
    }
  }

  private async enqueueFileOne(
    request: StateSnapshotFileEnqueueRequest,
    namespace: string,
    source: LocalFileDetails,
    objectKey: string,
    uploadId: string,
  ): Promise<StateSnapshotFileJob> {
    const manifest = await this.#spool.enqueueFile({
      kind: request.kind ?? "state-file",
      sourcePath: request.sourcePath,
      objectKey,
      uploadId,
      ...(request.contentType ? { contentType: request.contentType } : {}),
      metadata: {
        ...(request.metadata ?? {}),
        stateNamespace: namespace,
        stateFileSha256: source.sha256,
        stateFileSizeBytes: String(source.sizeBytes),
      },
    });
    if (manifest.objectKey !== objectKey || manifest.sha256 !== source.sha256 || manifest.sizeBytes !== source.sizeBytes) {
      throw new Error(`State file upload manifest verification failed for ${namespace}`);
    }
    return { namespace, objectKey, sha256: source.sha256, sizeBytes: source.sizeBytes, uploadId: manifest.uploadId };
  }

  async restoreFile(
    requestOrNamespace: StateSnapshotFileRestoreOptions | string,
    objectKey?: string,
    destinationPath?: string,
    expected?: Pick<StateSnapshotFileRestoreOptions, "sha256" | "sizeBytes">,
  ): Promise<StateSnapshotFileRecord | null> {
    const request: StateSnapshotFileRestoreOptions = typeof requestOrNamespace === "string"
      ? {
        namespace: requestOrNamespace,
        objectKey: objectKey ?? "",
        destinationPath: destinationPath ?? "",
        sha256: expected?.sha256 ?? "",
        sizeBytes: expected?.sizeBytes ?? -1,
      }
      : requestOrNamespace;
    if (request.namespace !== undefined) safeNamespace(request.namespace);
    const logicalKey = safeObjectKey(request.objectKey);
    if (!validDigest(request.sha256) || !Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 0) throw new Error(`State file restore metadata is invalid: ${logicalKey}`);
    const target = path.resolve(request.destinationPath);
    if (!path.isAbsolute(request.destinationPath) || target === path.parse(target).root) throw new Error("State file restore destination must be a non-root absolute path");
    await mkdir(path.dirname(target), { recursive: true });

    const existing = await fileDetails(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (existing.sizeBytes !== request.sizeBytes || existing.sha256 !== request.sha256) throw new Error(`State file checksum mismatch at ${target}`);
      return { objectKey: logicalKey, sizeBytes: existing.sizeBytes, sha256: existing.sha256 };
    }

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const object = await this.#store.downloadToFile(logicalKey, temporary);
      if (!object) return null;
      const downloaded = await fileDetails(temporary);
      if (object.sizeBytes !== request.sizeBytes || downloaded.sizeBytes !== request.sizeBytes || downloaded.sha256 !== request.sha256 || (object.sha256 && object.sha256 !== request.sha256)) {
        throw new Error(`State file checksum or size mismatch for ${logicalKey}`);
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raced = await fileDetails(target);
        if (raced.sizeBytes !== request.sizeBytes || raced.sha256 !== request.sha256) throw new Error(`State file checksum mismatch at ${target}`);
      }
      return { objectKey: logicalKey, sizeBytes: downloaded.sizeBytes, sha256: downloaded.sha256 };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async enqueueOne(namespace: string, state: unknown): Promise<StateSnapshotJob> {
    await this.initialize();
    const generation = await this.nextGeneration(namespace);
    const bytes = canonicalJson(state);
    const digest = sha256(bytes);
    const key = snapshotKey(namespace, generation, digest);
    const sourceRoot = path.join(this.root, "pending", namespace);
    const sourcePath = path.join(sourceRoot, `${generation}-${digest}.json`);
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sourcePath, bytes, { flag: "wx", mode: 0o600 });
    try {
      const manifest = await this.#spool.enqueueFile({
        kind: "state-snapshot",
        sourcePath,
        objectKey: key,
        uploadId: `state-${namespace}-${generation}-${digest.slice(0, 16)}`,
        contentType: "application/json; charset=utf-8",
        metadata: { stateNamespace: namespace, stateGeneration: String(generation) },
      });
      return { namespace, generation, snapshotKey: key, snapshotSha256: digest, sizeBytes: bytes.length, uploadId: manifest.uploadId };
    } finally {
      await rm(sourcePath, { force: true });
    }
  }

  async reconcileUploaded(manifests: readonly UploadJobManifest[]): Promise<StateSnapshotPointer[]> {
    const jobs = manifests.map(snapshotJobFromManifest).filter((job): job is StateSnapshotJob => Boolean(job));
    jobs.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.generation - right.generation);
    const advanced: StateSnapshotPointer[] = [];
    for (const job of jobs) {
      const current = await this.readPointer(job.namespace);
      if (current && current.generation >= job.generation) continue;
      const pointer: StateSnapshotPointer = {
        schemaVersion: 1,
        namespace: job.namespace,
        generation: job.generation,
        snapshotKey: job.snapshotKey,
        snapshotSha256: job.snapshotSha256,
        sizeBytes: job.sizeBytes,
        updatedAt: this.#now().toISOString(),
      };
      await this.#store.putMutable(pointerKey(job.namespace), `${JSON.stringify(pointer, null, 2)}\n`, { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" });
      const verified = await this.readPointer(job.namespace);
      if (!verified || verified.generation !== job.generation || verified.snapshotSha256 !== job.snapshotSha256) throw new Error(`State pointer verification failed: ${job.namespace}@${job.generation}`);
      advanced.push(verified);
    }
    return advanced;
  }

  async readPointer(namespaceValue: string): Promise<StateSnapshotPointer | null> {
    const namespace = safeNamespace(namespaceValue);
    const object = await this.#store.get(pointerKey(namespace));
    if (!object) return null;
    return parsePointer(JSON.parse(object.body.toString("utf8")) as unknown, namespace);
  }

  async restore(namespaceValue: string): Promise<StateSnapshotRestore | null> {
    const namespace = safeNamespace(namespaceValue);
    const pointer = await this.readPointer(namespace);
    if (!pointer) return null;
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `restore-${namespace}-${pointer.generation}-${randomUUID()}.json`);
    try {
      const object = await this.#store.downloadToFile(pointer.snapshotKey, temporary);
      if (!object) throw new Error(`State snapshot is missing: ${namespace}@${pointer.generation}`);
      const details = await fileDetails(temporary);
      if (object.sizeBytes !== pointer.sizeBytes || details.sizeBytes !== pointer.sizeBytes || details.sha256 !== pointer.snapshotSha256 || (object.sha256 && object.sha256 !== pointer.snapshotSha256)) {
        throw new Error(`State snapshot verification failed: ${namespace}@${pointer.generation}`);
      }
      return { pointer, state: JSON.parse(await readFile(temporary, "utf8")) as unknown };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async nextGeneration(namespace: string): Promise<number> {
    const current = this.#generations.get(namespace) ?? await this.readLocalGeneration(namespace);
    const next = current + 1;
    this.#generations.set(namespace, next);
    await this.writeLocalGeneration();
    return next;
  }

  private async readLocalGeneration(namespace: string): Promise<number> {
    const file = path.join(this.root, "generations", `${namespace}.json`);
    try {
      const document = JSON.parse(await readFile(file, "utf8")) as Partial<LocalGenerationDocument>;
      const value = document.generations?.[namespace];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    } catch { /* first local snapshot */ }
    return 0;
  }

  private async writeLocalGeneration(): Promise<void> {
    const document: LocalGenerationDocument = {
      schemaVersion: 1,
      generations: Object.fromEntries(this.#generations),
    };
    await Promise.all([...this.#generations.keys()].map((namespace) => writeJsonAtomic(
      path.join(this.root, "generations", `${namespace}.json`),
      document,
    )));
  }
}

export function stateSnapshotPointerKey(namespace: string): string {
  return pointerKey(namespace);
}
