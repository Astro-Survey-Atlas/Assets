import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, lstat, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactStoreConflictError,
  type ArtifactPutOptions,
  type ArtifactStore,
} from "./artifact-store.js";

export type UploadJobStatus = "pending" | "uploading" | "retryable-failed" | "uploaded" | "conflict";
type UploadProcessOutcome = "uploaded" | "retryable-failed" | "conflict" | "skipped";

export interface UploadJobManifest {
  schemaVersion: 1;
  uploadId: string;
  kind: string;
  payloadPath: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  contentType?: string;
  metadata?: Record<string, string>;
  status: UploadJobStatus;
  retryCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadReceipt {
  schemaVersion: 1;
  uploadId: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

export interface EnqueueUploadOptions {
  kind: string;
  sourcePath: string;
  objectKey: string;
  uploadId?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface UploadSpoolOptions {
  root: string;
  store: ArtifactStore;
  leaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
}

export interface UploadProcessResult {
  scanned: number;
  uploaded: string[];
  uploadedManifests: UploadJobManifest[];
  retryable: string[];
  conflicts: string[];
  skipped: string[];
  quarantined: string[];
}

const MANIFEST_FILE = "manifest.json";
const READY_FILE = ".ready";
const LEASE_FILE = ".lease";
const RECEIPT_FILE = "receipt.json";
const RECONCILED_FILE = ".reconciled";

function safeRelativePath(value: string, label: string): string {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value)) throw new Error(`${label} must be a relative path`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} is unsafe: ${value}`);
  return value;
}

function safeObjectKey(value: string): string {
  return safeRelativePath(value, "Upload object key");
}

function safeUploadId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`Upload ID is unsafe: ${value}`);
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileDetails(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Upload source must be a regular file: ${filePath}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

function parseManifest(value: unknown, uploadId: string): UploadJobManifest {
  if (!value || typeof value !== "object") throw new Error(`Upload manifest is invalid: ${uploadId}`);
  const manifest = value as Partial<UploadJobManifest>;
  const sizeBytes = manifest.sizeBytes;
  const retryCount = manifest.retryCount;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.uploadId !== uploadId ||
    typeof manifest.kind !== "string" || !manifest.kind ||
    typeof manifest.payloadPath !== "string" ||
    typeof manifest.objectKey !== "string" ||
    typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 ||
    typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !["pending", "uploading", "retryable-failed", "uploaded", "conflict"].includes(manifest.status ?? "") ||
    typeof retryCount !== "number" || !Number.isSafeInteger(retryCount) || retryCount < 0 ||
    typeof manifest.createdAt !== "string" || typeof manifest.updatedAt !== "string"
  ) throw new Error(`Upload manifest is invalid: ${uploadId}`);
  safeRelativePath(manifest.payloadPath, "Upload payload path");
  safeObjectKey(manifest.objectKey);
  return manifest as UploadJobManifest;
}

function parseReceipt(value: unknown, uploadId: string): UploadReceipt {
  if (!value || typeof value !== "object") throw new Error(`Upload receipt is invalid: ${uploadId}`);
  const receipt = value as Partial<UploadReceipt>;
  if (receipt.schemaVersion !== 1 || receipt.uploadId !== uploadId || typeof receipt.objectKey !== "string" || typeof receipt.sizeBytes !== "number" || !Number.isSafeInteger(receipt.sizeBytes) || receipt.sizeBytes < 0 || typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256) || typeof receipt.uploadedAt !== "string") {
    throw new Error(`Upload receipt is invalid: ${uploadId}`);
  }
  safeObjectKey(receipt.objectKey);
  return receipt as UploadReceipt;
}

function sameJob(a: UploadJobManifest, b: UploadJobManifest): boolean {
  return a.kind === b.kind
    && a.objectKey === b.objectKey
    && a.sizeBytes === b.sizeBytes
    && a.sha256 === b.sha256
    && a.contentType === b.contentType
    && JSON.stringify(a.metadata ?? {}) === JSON.stringify(b.metadata ?? {});
}

function sameRequest(manifest: UploadJobManifest, options: EnqueueUploadOptions, objectKey: string): boolean {
  return manifest.kind === options.kind
    && manifest.objectKey === objectKey
    && manifest.contentType === options.contentType
    && JSON.stringify(manifest.metadata ?? {}) === JSON.stringify(options.metadata ?? {});
}

export class UploadSpool {
  readonly root: string;
  readonly jobsRoot: string;
  readonly #store: ArtifactStore;
  readonly #leaseMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #now: () => Date;

  constructor(options: UploadSpoolOptions) {
    const root = path.resolve(options.root);
    if (root === path.parse(root).root) throw new Error("Upload spool root must not be a filesystem root");
    if (options.store.kind !== "s3") throw new Error("Upload spool requires an S3-compatible object store");
    this.root = root;
    this.jobsRoot = path.join(root, "jobs");
    this.#store = options.store;
    this.#leaseMs = options.leaseMs ?? 10 * 60 * 1000;
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
    this.#retryMaxMs = options.retryMaxMs ?? 15 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.#leaseMs) || this.#leaseMs <= 0 || !Number.isFinite(this.#retryBaseMs) || this.#retryBaseMs < 0 || !Number.isFinite(this.#retryMaxMs) || this.#retryMaxMs < this.#retryBaseMs) {
      throw new Error("Upload spool timing options are invalid");
    }
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.jobsRoot, { recursive: true }),
      mkdir(path.join(this.root, "quarantine"), { recursive: true }),
    ]);
  }

  /**
   * Return readable job manifests for status reporting and reconciliation.
   * Malformed or unready jobs are deliberately omitted here; the worker's
   * processPending path remains responsible for quarantining them.
   */
  async listManifests(): Promise<UploadJobManifest[]> {
    await this.initialize();
    const manifests: UploadJobManifest[] = [];
    for (const entry of await readdir(this.jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        manifests.push(await this.readManifest(entry.name));
      } catch {
        // A status read must not prevent the worker from inspecting the rest
        // of the spool. processPending quarantines this job with its reason.
      }
    }
    return manifests.sort((left, right) => left.uploadId.localeCompare(right.uploadId));
  }

  async enqueueFile(options: EnqueueUploadOptions): Promise<UploadJobManifest> {
    await this.initialize();
    if (!options.kind.trim()) throw new Error("Upload kind is required");
    const uploadId = safeUploadId(options.uploadId ?? `upload-${Date.now().toString(36)}-${randomUUID()}`);
    const objectKey = safeObjectKey(options.objectKey);
    const jobRoot = path.join(this.jobsRoot, uploadId);
    let existing: UploadJobManifest | undefined;
    try {
      const details = await lstat(jobRoot);
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`Upload job path is not a directory: ${uploadId}`);
      existing = await this.readManifest(uploadId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (!sameRequest(existing, options, objectKey)) throw new ArtifactStoreConflictError(`Upload job already exists with different bytes or metadata: ${uploadId}`);
      try {
        const source = await fileDetails(options.sourcePath);
        const candidate: UploadJobManifest = {
          ...existing,
          sizeBytes: source.sizeBytes,
          sha256: source.sha256,
        };
        if (sameJob(existing, candidate)) return existing;
        throw new ArtifactStoreConflictError(`Upload job already exists with different bytes or metadata: ${uploadId}`);
      } catch (error) {
        // A replay may legitimately happen after the source was cleaned; the
        // durable job manifest is then the idempotency record.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return existing;
        throw error;
      }
    }
    const source = await fileDetails(options.sourcePath);
    const createdAt = this.#now().toISOString();
    const manifest: UploadJobManifest = {
      schemaVersion: 1,
      uploadId,
      kind: options.kind,
      payloadPath: "payload",
      ...source,
      objectKey,
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
      status: "pending",
      retryCount: 0,
      createdAt,
      updatedAt: createdAt,
    };
    const temporaryRoot = path.join(this.root, `.job-${uploadId}-${randomUUID()}`);
    await mkdir(temporaryRoot, { recursive: true });
    try {
      await copyFile(options.sourcePath, path.join(temporaryRoot, manifest.payloadPath));
      const copied = await fileDetails(path.join(temporaryRoot, manifest.payloadPath));
      if (copied.sizeBytes !== manifest.sizeBytes || copied.sha256 !== manifest.sha256) throw new Error(`Upload source changed while being copied: ${options.sourcePath}`);
      await writeJsonAtomic(path.join(temporaryRoot, MANIFEST_FILE), manifest);
      // A visible job is complete only when its manifest, payload and ready
      // marker are all present in the same renamed directory.
      await writeFile(path.join(temporaryRoot, READY_FILE), `${uploadId}\n`, { flag: "wx", mode: 0o600 });
      await mkdir(path.dirname(jobRoot), { recursive: true });
      await rename(temporaryRoot, jobRoot);
      return manifest;
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = await this.readManifest(uploadId).catch(() => undefined);
        if (current && sameJob(current, manifest)) return current;
        throw new ArtifactStoreConflictError(`Upload job already exists with different bytes or metadata: ${uploadId}`);
      }
      throw error;
    }
  }

  async processPending(): Promise<UploadProcessResult> {
    await this.initialize();
    const result: UploadProcessResult = { scanned: 0, uploaded: [], uploadedManifests: [], retryable: [], conflicts: [], skipped: [], quarantined: [] };
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const uploadId = entry.name;
      result.scanned += 1;
      let manifest: UploadJobManifest;
      try {
        manifest = await this.readManifest(uploadId);
        if (manifest.status === "uploaded") await this.readReceipt(uploadId, manifest);
      } catch (error) {
        if (await this.quarantineJob(uploadId)) result.quarantined.push(uploadId);
        else result.skipped.push(uploadId);
        continue;
      }
      if (manifest.status === "uploaded") {
        result.uploadedManifests.push(manifest);
        result.skipped.push(uploadId);
        continue;
      }
      let outcome: UploadProcessOutcome;
      try {
        outcome = await this.processJob(uploadId);
      } catch {
        if (await this.quarantineJob(uploadId)) result.quarantined.push(uploadId);
        else result.skipped.push(uploadId);
        continue;
      }
      if (outcome === "uploaded") {
        result.uploaded.push(uploadId);
        const uploadedManifest = await this.readManifest(uploadId);
        await this.readReceipt(uploadId, uploadedManifest);
        result.uploadedManifests.push(uploadedManifest);
      }
      else if (outcome === "retryable-failed") result.retryable.push(uploadId);
      else if (outcome === "conflict") result.conflicts.push(uploadId);
      else result.skipped.push(uploadId);
    }
    return result;
  }

  async markReconciled(uploadIds: readonly string[]): Promise<number> {
    await this.initialize();
    let marked = 0;
    for (const uploadId of uploadIds) {
      safeUploadId(uploadId);
      const manifest = await this.readManifest(uploadId);
      if (manifest.status !== "uploaded") continue;
      await this.readReceipt(uploadId, manifest);
      await writeFile(path.join(this.jobsRoot, uploadId, RECONCILED_FILE), `${this.#now().toISOString()}\n`, { flag: "wx", mode: 0o600 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      marked += 1;
    }
    return marked;
  }

  async cleanupUploaded(): Promise<number> {
    await this.initialize();
    let removed = 0;
    for (const entry of await readdir(this.jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const jobRoot = path.join(this.jobsRoot, entry.name);
      const manifest = await this.readManifest(entry.name).catch(() => undefined);
      if (manifest?.status !== "uploaded") continue;
      const receipt = await this.readReceipt(entry.name, manifest).catch(() => undefined);
      const reconciled = await stat(path.join(jobRoot, RECONCILED_FILE)).catch(() => undefined);
      if (!receipt || !reconciled?.isFile()) continue;
      await rm(jobRoot, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  private async readManifest(uploadId: string): Promise<UploadJobManifest> {
    safeUploadId(uploadId);
    const jobRoot = path.join(this.jobsRoot, uploadId);
    const ready = await stat(path.join(jobRoot, READY_FILE));
    if (!ready.isFile()) throw new Error(`Upload job is not ready: ${uploadId}`);
    const marker = (await readFile(path.join(jobRoot, READY_FILE), "utf8")).trim();
    if (marker !== uploadId) throw new Error(`Upload job ready marker is invalid: ${uploadId}`);
    const value = JSON.parse(await readFile(path.join(jobRoot, MANIFEST_FILE), "utf8")) as unknown;
    return parseManifest(value, uploadId);
  }

  private async readReceipt(uploadId: string, manifest: UploadJobManifest): Promise<UploadReceipt> {
    const receipt = parseReceipt(JSON.parse(await readFile(path.join(this.jobsRoot, uploadId, RECEIPT_FILE), "utf8")) as unknown, uploadId);
    if (receipt.objectKey !== manifest.objectKey || receipt.sizeBytes !== manifest.sizeBytes || receipt.sha256 !== manifest.sha256) throw new Error(`Upload receipt does not match manifest: ${uploadId}`);
    return receipt;
  }

  private async quarantineJob(uploadId: string): Promise<boolean> {
    const source = path.join(this.jobsRoot, uploadId);
    const target = path.join(this.root, "quarantine", `${uploadId}-${Date.now().toString(36)}-${randomUUID()}`);
    try {
      await rename(source, target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async acquireLease(jobRoot: string): Promise<boolean> {
    const leasePath = path.join(jobRoot, LEASE_FILE);
    try {
      const handle = await open(leasePath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: this.#now().toISOString() }) + "\n", "utf8");
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let lease: { acquiredAt?: string };
      try {
        lease = JSON.parse(await readFile(leasePath, "utf8")) as { acquiredAt?: string };
      } catch {
        throw new Error(`Upload lease is corrupt: ${path.basename(jobRoot)}`);
      }
      const acquiredAt = Date.parse(lease.acquiredAt ?? "");
      if (!Number.isFinite(acquiredAt) || this.#now().getTime() - acquiredAt <= this.#leaseMs) return false;
      await rm(leasePath, { force: true });
      return this.acquireLease(jobRoot);
    }
  }

  private async processJob(uploadId: string): Promise<UploadProcessOutcome> {
    const jobRoot = path.join(this.jobsRoot, uploadId);
    const manifest = await this.readManifest(uploadId);
    if (manifest.status === "uploaded" || manifest.status === "conflict") return "skipped";
    if (manifest.nextAttemptAt && Date.parse(manifest.nextAttemptAt) > this.#now().getTime()) return "skipped";
    if (!(await this.acquireLease(jobRoot))) return "skipped";
    try {
      const current = await this.readManifest(uploadId);
      if (current.status === "uploaded" || current.status === "conflict") return "skipped";
      const uploading: UploadJobManifest = { ...current, status: "uploading", updatedAt: this.#now().toISOString() };
      await writeJsonAtomic(path.join(jobRoot, MANIFEST_FILE), uploading);
      try {
        const payload = await fileDetails(path.join(jobRoot, current.payloadPath));
        if (payload.sizeBytes !== current.sizeBytes || payload.sha256 !== current.sha256) {
          throw new ArtifactStoreConflictError(`Upload payload checksum conflict for ${uploadId}`);
        }
        const uploaded = await this.#store.putFileImmutable(path.join(current.objectKey), path.join(jobRoot, current.payloadPath), this.putOptions(current));
        if (uploaded.sizeBytes !== current.sizeBytes || uploaded.sha256 !== current.sha256) throw new Error(`Uploaded object verification failed for ${uploadId}`);
        const uploadedAt = this.#now().toISOString();
        const receipt: UploadReceipt = { schemaVersion: 1, uploadId, objectKey: current.objectKey, sizeBytes: current.sizeBytes, sha256: current.sha256, uploadedAt };
        await writeJsonAtomic(path.join(jobRoot, RECEIPT_FILE), receipt);
        await writeJsonAtomic(path.join(jobRoot, MANIFEST_FILE), { ...current, status: "uploaded", nextAttemptAt: undefined, lastError: undefined, updatedAt: uploadedAt });
        return "uploaded";
      } catch (error) {
        const conflict = error instanceof ArtifactStoreConflictError || /different bytes|conflict/i.test(errorText(error));
        const retryCount = current.retryCount + 1;
        const delay = Math.min(this.#retryMaxMs, this.#retryBaseMs * (2 ** Math.max(0, retryCount - 1)));
        await writeJsonAtomic(path.join(jobRoot, MANIFEST_FILE), {
          ...current,
          status: conflict ? "conflict" : "retryable-failed",
          retryCount,
          nextAttemptAt: conflict ? undefined : new Date(this.#now().getTime() + delay).toISOString(),
          lastError: errorText(error),
          updatedAt: this.#now().toISOString(),
        } satisfies UploadJobManifest);
        return conflict ? "conflict" : "retryable-failed";
      }
    } finally {
      await rm(path.join(jobRoot, LEASE_FILE), { force: true });
    }
  }

  private putOptions(manifest: UploadJobManifest): ArtifactPutOptions {
    return {
      ...(manifest.contentType ? { contentType: manifest.contentType } : {}),
      ...(manifest.metadata ? { metadata: manifest.metadata } : {}),
    };
  }
}
