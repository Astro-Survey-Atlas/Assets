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
}

const MANIFEST_FILE = "manifest.json";
const READY_FILE = ".ready";
const LEASE_FILE = ".lease";
const RECEIPT_FILE = "receipt.json";

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
    await mkdir(this.jobsRoot, { recursive: true });
  }

  async enqueueFile(options: EnqueueUploadOptions): Promise<UploadJobManifest> {
    await this.initialize();
    if (!options.kind.trim()) throw new Error("Upload kind is required");
    const uploadId = safeUploadId(options.uploadId ?? `upload-${Date.now().toString(36)}-${randomUUID()}`);
    const objectKey = safeObjectKey(options.objectKey);
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
    const jobRoot = path.join(this.jobsRoot, uploadId);
    await mkdir(temporaryRoot, { recursive: true });
    try {
      await copyFile(options.sourcePath, path.join(temporaryRoot, manifest.payloadPath));
      await writeJsonAtomic(path.join(temporaryRoot, MANIFEST_FILE), manifest);
      await mkdir(path.dirname(jobRoot), { recursive: true });
      await rename(temporaryRoot, jobRoot);
      await writeFile(path.join(jobRoot, READY_FILE), `${uploadId}\n`, { flag: "wx", mode: 0o600 });
      return manifest;
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Upload job already exists: ${uploadId}`);
      throw error;
    }
  }

  async processPending(): Promise<UploadProcessResult> {
    await this.initialize();
    const result: UploadProcessResult = { scanned: 0, uploaded: [], uploadedManifests: [], retryable: [], conflicts: [], skipped: [] };
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const uploadId = entry.name;
      result.scanned += 1;
      const outcome = await this.processJob(uploadId);
      if (outcome === "uploaded") {
        result.uploaded.push(uploadId);
        const uploadedManifest = await this.readManifest(uploadId).catch(() => undefined);
        if (uploadedManifest) result.uploadedManifests.push(uploadedManifest);
      }
      else if (outcome === "retryable-failed") result.retryable.push(uploadId);
      else if (outcome === "conflict") result.conflicts.push(uploadId);
      else result.skipped.push(uploadId);
    }
    return result;
  }

  async cleanupUploaded(): Promise<number> {
    await this.initialize();
    let removed = 0;
    for (const entry of await readdir(this.jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const jobRoot = path.join(this.jobsRoot, entry.name);
      const manifest = await this.readManifest(entry.name).catch(() => undefined);
      if (manifest?.status !== "uploaded") continue;
      const receipt = await stat(path.join(jobRoot, RECEIPT_FILE)).catch(() => undefined);
      if (!receipt?.isFile()) continue;
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
    const value = JSON.parse(await readFile(path.join(jobRoot, MANIFEST_FILE), "utf8")) as unknown;
    return parseManifest(value, uploadId);
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
      const lease = JSON.parse(await readFile(leasePath, "utf8").catch(() => "{}")) as { acquiredAt?: string };
      const acquiredAt = Date.parse(lease.acquiredAt ?? "");
      if (!Number.isFinite(acquiredAt) || this.#now().getTime() - acquiredAt <= this.#leaseMs) return false;
      await rm(leasePath, { force: true });
      return this.acquireLease(jobRoot);
    }
  }

  private async processJob(uploadId: string): Promise<"uploaded" | "retryable-failed" | "conflict" | "skipped"> {
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
