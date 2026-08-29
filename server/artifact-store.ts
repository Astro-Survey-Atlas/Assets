import { createHash } from "node:crypto";
import { readFile, stat, mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync as readFileSyncFromFs } from "node:fs";
import path from "node:path";

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ArtifactObject {
  key: string;
  sizeBytes: number;
  sha256: string;
  contentType?: string;
  etag?: string;
}

export interface ArtifactObjectWithBody extends ArtifactObject {
  body: Buffer;
}

export interface ArtifactPutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface ArtifactStore {
  readonly kind: "filesystem" | "s3";
  head(key: string): Promise<ArtifactObject | null>;
  get(key: string, range?: ByteRange): Promise<ArtifactObjectWithBody | null>;
  putImmutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject>;
  putMutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject>;
}

export class ArtifactStoreError extends Error {
  constructor(message: string, readonly statusCode = 503) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export class ArtifactStoreConflictError extends ArtifactStoreError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ArtifactStoreConflictError";
  }
}

function bytesOf(body: Uint8Array | string): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function cleanKey(key: string): string {
  if (!key || key.includes("\0") || key.startsWith("/")) throw new ArtifactStoreError(`Unsafe object key: ${key}`, 400);
  const parts = key.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new ArtifactStoreError(`Unsafe object key: ${key}`, 400);
  return parts.join("/");
}

function prefixedKey(prefix: string, key: string): string {
  const logical = cleanKey(key);
  const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
  return normalizedPrefix ? `${cleanKey(normalizedPrefix)}/${logical}` : logical;
}

function validateRange(range: ByteRange | undefined, size: number): ByteRange | undefined {
  if (!range) return undefined;
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.start >= size) {
    throw new ArtifactStoreError(`Requested byte range is outside the ${size}-byte object`, 416);
  }
  return { start: range.start, end: Math.min(range.end, size - 1) };
}

function metadataPath(filePath: string): string {
  return `${filePath}.metadata.json`;
}

async function readMetadata(filePath: string): Promise<ArtifactPutOptions> {
  try {
    const value = JSON.parse(await readFile(metadataPath(filePath), "utf8")) as ArtifactPutOptions;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Atomic, local fallback used by development and PVC-backed deployments. */
export class FilesystemArtifactStore implements ArtifactStore {
  readonly kind = "filesystem" as const;
  readonly root: string;
  readonly prefix: string;

  constructor(root: string, prefix = "") {
    this.root = path.resolve(root);
    this.prefix = prefix;
  }

  private filePath(key: string): string {
    const physical = prefixedKey(this.prefix, key);
    const filePath = path.resolve(this.root, ...physical.split("/"));
    const relative = path.relative(this.root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ArtifactStoreError(`Object key escapes filesystem store: ${key}`, 400);
    return filePath;
  }

  async head(key: string): Promise<ArtifactObject | null> {
    const filePath = this.filePath(key);
    let details;
    try { details = await stat(filePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!details.isFile()) throw new ArtifactStoreError(`Object key is not a file: ${key}`);
    const body = await readFile(filePath);
    const options = await readMetadata(filePath);
    return { key: cleanKey(key), sizeBytes: details.size, sha256: digest(body), ...(options.contentType ? { contentType: options.contentType } : {}) };
  }

  async get(key: string, range?: ByteRange): Promise<ArtifactObjectWithBody | null> {
    const filePath = this.filePath(key);
    const existing = await this.head(key);
    if (!existing) return null;
    const body = await readFile(filePath);
    const selected = validateRange(range, body.length);
    return { ...existing, body: selected ? body.subarray(selected.start, selected.end + 1) : body };
  }

  async putImmutable(key: string, body: Uint8Array | string, options: ArtifactPutOptions = {}): Promise<ArtifactObject> {
    const logical = cleanKey(key);
    const bytes = bytesOf(body);
    const existing = await this.head(logical);
    const sha256 = digest(bytes);
    if (existing) {
      if (existing.sizeBytes === bytes.length && existing.sha256 === sha256) return existing;
      throw new ArtifactStoreConflictError(`Immutable object already exists with different bytes: ${logical}`);
    }
    const filePath = this.filePath(logical);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await this.head(logical);
      if (raced?.sizeBytes === bytes.length && raced.sha256 === sha256) return raced;
      throw new ArtifactStoreConflictError(`Immutable object was concurrently published with different bytes: ${logical}`);
    }
    await writeFile(metadataPath(filePath), JSON.stringify(options) + "\n", { flag: "w" });
    return { key: logical, sizeBytes: bytes.length, sha256, ...(options.contentType ? { contentType: options.contentType } : {}) };
  }

  async putMutable(key: string, body: Uint8Array | string, options: ArtifactPutOptions = {}): Promise<ArtifactObject> {
    const logical = cleanKey(key);
    const bytes = bytesOf(body);
    const filePath = this.filePath(logical);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, filePath);
    await writeFile(metadataPath(filePath), JSON.stringify(options) + "\n");
    return { key: logical, sizeBytes: bytes.length, sha256: digest(bytes), ...(options.contentType ? { contentType: options.contentType } : {}) };
  }
}

export interface S3ArtifactStoreOptions {
  endpoint?: string;
  bucket: string;
  prefix?: string;
  region?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  client?: S3Client;
}

/** S3-compatible publication adapter. It never overwrites an immutable key. */
export class S3ArtifactStore implements ArtifactStore {
  readonly kind = "s3" as const;
  readonly bucket: string;
  readonly prefix: string;
  readonly publicBaseUrl?: string;
  readonly #client: S3Client;

  constructor(options: S3ArtifactStoreOptions) {
    if (!options.bucket.trim()) throw new ArtifactStoreError("S3 bucket is required", 400);
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? "";
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, "") || undefined;
    this.#client = options.client ?? new S3Client({
      region: options.region ?? "us-east-1",
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? true,
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
  }

  physicalKey(key: string): string { return prefixedKey(this.prefix, key); }

  publicUrl(key: string): string | undefined {
    if (!this.publicBaseUrl) return undefined;
    return `${this.publicBaseUrl}/${this.physicalKey(key).split("/").map(encodeURIComponent).join("/")}`;
  }

  async head(key: string): Promise<ArtifactObject | null> {
    const logical = cleanKey(key);
    try {
      const result = await this.#client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.physicalKey(logical) }));
      const sizeBytes = Number(result.ContentLength ?? 0);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new ArtifactStoreError(`S3 object has an invalid size: ${logical}`);
      const sha256 = result.Metadata?.sha256 ?? "";
      return { key: logical, sizeBytes, sha256, ...(result.ContentType ? { contentType: result.ContentType } : {}), ...(result.ETag ? { etag: result.ETag.replace(/^"|"$/g, "") } : {}) };
    } catch (error) {
      if (isMissingS3Object(error)) return null;
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(`S3 HEAD failed for ${logical}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async get(key: string, range?: ByteRange): Promise<ArtifactObjectWithBody | null> {
    const logical = cleanKey(key);
    const existing = await this.head(logical);
    if (!existing) return null;
    const selected = validateRange(range, existing.sizeBytes);
    try {
      const result = await this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.physicalKey(logical), ...(selected ? { Range: `bytes=${selected.start}-${selected.end}` } : {}) }));
      if (!result.Body || typeof result.Body.transformToByteArray !== "function") throw new ArtifactStoreError(`S3 object has no readable body: ${logical}`);
      const body = Buffer.from(await result.Body.transformToByteArray());
      return { ...existing, body };
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(`S3 GET failed for ${logical}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async putImmutable(key: string, body: Uint8Array | string, options: ArtifactPutOptions = {}): Promise<ArtifactObject> {
    const logical = cleanKey(key);
    const bytes = bytesOf(body);
    const sha256 = digest(bytes);
    const existing = await this.head(logical);
    if (existing) return this.reconcileExisting(logical, existing, bytes, sha256);
    const input = {
      Bucket: this.bucket,
      Key: this.physicalKey(logical),
      Body: bytes,
      ContentLength: bytes.length,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
      ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
      Metadata: { ...(options.metadata ?? {}), sha256 },
      IfNoneMatch: "*",
    };
    try {
      const result = await this.#client.send(new PutObjectCommand(input));
      return { key: logical, sizeBytes: bytes.length, sha256, ...(options.contentType ? { contentType: options.contentType } : {}), ...(result.ETag ? { etag: result.ETag.replace(/^"|"$/g, "") } : {}) };
    } catch (error) {
      if (!isPreconditionFailure(error)) throw new ArtifactStoreError(`S3 immutable PUT failed for ${logical}: ${error instanceof Error ? error.message : String(error)}`);
      const raced = await this.head(logical);
      if (!raced) throw new ArtifactStoreError(`S3 rejected immutable PUT but the object is not readable: ${logical}`);
      return this.reconcileExisting(logical, raced, bytes, sha256);
    }
  }

  async putMutable(key: string, body: Uint8Array | string, options: ArtifactPutOptions = {}): Promise<ArtifactObject> {
    const logical = cleanKey(key);
    const bytes = bytesOf(body);
    try {
      const result = await this.#client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(logical),
        Body: bytes,
        ContentLength: bytes.length,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        Metadata: { ...(options.metadata ?? {}), sha256: digest(bytes) },
      }));
      return { key: logical, sizeBytes: bytes.length, sha256: digest(bytes), ...(options.contentType ? { contentType: options.contentType } : {}), ...(result.ETag ? { etag: result.ETag.replace(/^"|"$/g, "") } : {}) };
    } catch (error) {
      throw new ArtifactStoreError(`S3 PUT failed for ${logical}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async reconcileExisting(logical: string, existing: ArtifactObject, bytes: Buffer, sha256: string): Promise<ArtifactObject> {
    if (existing.sizeBytes === bytes.length && existing.sha256 === sha256) return existing;
    if (!existing.sha256) {
      const fetched = await this.get(logical);
      if (fetched && fetched.body.length === bytes.length && digest(fetched.body) === sha256) return { ...existing, sha256 };
    }
    throw new ArtifactStoreConflictError(`Immutable object already exists with different bytes: ${logical}`);
  }
}

function isMissingS3Object(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  return value?.$metadata?.httpStatusCode === 404 || value?.name === "NotFound" || value?.name === "NoSuchKey" || value?.Code === "NoSuchKey";
}

function isPreconditionFailure(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  return value?.$metadata?.httpStatusCode === 412 || value?.name === "PreconditionFailed" || value?.Code === "PreconditionFailed";
}

export interface ArtifactStoreEnvironment {
  endpoint?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  secretJson?: string;
  secretFile?: string;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function secretCredentials(environment: ArtifactStoreEnvironment): S3ArtifactStoreOptions["credentials"] {
  let value = optional(environment.secretJson);
  if (!value && environment.secretFile) {
    try { value = readFileSyncFromFs(environment.secretFile, "utf8"); }
    catch (error) { throw new ArtifactStoreError(`Unable to read object-store secret file: ${error instanceof Error ? error.message : String(error)}`, 500); }
  }
  let parsed: Record<string, unknown> = {};
  if (value) {
    try { parsed = JSON.parse(value) as Record<string, unknown>; }
    catch { throw new ArtifactStoreError("ASSETS_OBJECT_STORE_SECRET_JSON must be a JSON object", 500); }
  }
  const accessKeyId = optional(environment.accessKeyId) ?? optional(typeof parsed.accessKeyId === "string" ? parsed.accessKeyId : typeof parsed.access_key_id === "string" ? parsed.access_key_id : undefined);
  const secretAccessKey = optional(environment.secretAccessKey) ?? optional(typeof parsed.secretAccessKey === "string" ? parsed.secretAccessKey : typeof parsed.secret_access_key === "string" ? parsed.secret_access_key : undefined);
  const sessionToken = optional(environment.sessionToken) ?? optional(typeof parsed.sessionToken === "string" ? parsed.sessionToken : typeof parsed.session_token === "string" ? parsed.session_token : undefined);
  if (!accessKeyId && !secretAccessKey) return undefined;
  if (!accessKeyId || !secretAccessKey) throw new ArtifactStoreError("Object-store credentials require both access key ID and secret access key", 500);
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

export function createArtifactStore(environment: ArtifactStoreEnvironment = {}, fallbackRoot = "/data/object-store"): ArtifactStore {
  const endpoint = optional(environment.endpoint);
  const bucket = optional(environment.bucket);
  if (endpoint || bucket) {
    if (!endpoint || !bucket) throw new ArtifactStoreError("ASSETS_OBJECT_STORE_ENDPOINT and ASSETS_OBJECT_STORE_BUCKET must be configured together", 500);
    return new S3ArtifactStore({
      endpoint,
      bucket,
      prefix: optional(environment.prefix),
      region: optional(environment.region) ?? "us-east-1",
      forcePathStyle: environment.forcePathStyle === undefined ? true : environment.forcePathStyle,
      publicBaseUrl: optional(environment.publicBaseUrl),
      credentials: secretCredentials(environment),
    });
  }
  return new FilesystemArtifactStore(fallbackRoot, optional(environment.prefix));
}

function environmentBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function artifactStoreEnvironmentFromProcess(environment: NodeJS.ProcessEnv = process.env): ArtifactStoreEnvironment {
  return {
    endpoint: environment.ASSETS_OBJECT_STORE_ENDPOINT,
    bucket: environment.ASSETS_OBJECT_STORE_BUCKET,
    prefix: environment.ASSETS_OBJECT_STORE_PREFIX,
    region: environment.ASSETS_OBJECT_STORE_REGION,
    forcePathStyle: environmentBoolean(environment.ASSETS_OBJECT_STORE_FORCE_PATH_STYLE, true),
    publicBaseUrl: environment.ASSETS_OBJECT_STORE_PUBLIC_BASE_URL,
    accessKeyId: environment.ASSETS_OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: environment.ASSETS_OBJECT_STORE_SECRET_ACCESS_KEY,
    sessionToken: environment.ASSETS_OBJECT_STORE_SESSION_TOKEN,
    secretJson: environment.ASSETS_OBJECT_STORE_SECRET_JSON,
    secretFile: environment.ASSETS_OBJECT_STORE_SECRET_FILE,
  };
}

export function createArtifactStoreFromProcess(environment: NodeJS.ProcessEnv = process.env, fallbackRoot = "/data/object-store"): ArtifactStore {
  return createArtifactStore(artifactStoreEnvironmentFromProcess(environment), fallbackRoot);
}

export interface PublishedRelease {
  schemaVersion: 1;
  bundle: { id: string; sha256: string };
  manifestKey: string;
  currentKey: string;
  runtimeCount: number;
  evidenceCount: number;
  publishedAt: string;
}

interface ReleaseRecord {
  id: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  mediaType?: string;
  deliveryClass?: "runtime" | "evidence";
  [key: string]: unknown;
}

function releaseDeliveryClass(record: ReleaseRecord): "runtime" | "evidence" {
  if (record.deliveryClass) return record.deliveryClass;
  if (record.path.includes("/csst/") || record.path.includes("/raw/") || record.path.endsWith("/provenance.json") || record.id.includes("provenance") || record.id.includes("snapshot") || record.id.includes("normalized")) return "evidence";
  return "runtime";
}

function objectKeyFor(record: ReleaseRecord, bundle: { id: string; sha256: string }): string {
  const base = releaseDeliveryClass(record) === "evidence" ? "evidence" : "public/releases";
  return `${base}/${cleanKey(bundle.id)}/${bundle.sha256}/${cleanKey(record.path)}`;
}

/** Publish a checked-in release into immutable public/evidence prefixes. */
export async function publishReleaseBundle(sourceRoot: string, store: ArtifactStore, options: { currentKey?: string } = {}): Promise<PublishedRelease> {
  const root = path.resolve(sourceRoot);
  const releaseManifestPath = path.join(root, "artifacts", "public-survey-footprints", "release-manifest.json");
  const manifest = JSON.parse(await readFile(releaseManifestPath, "utf8")) as { schemaVersion: number; generatedAt: string; bundle: { id: string; sha256: string }; files: ReleaseRecord[] };
  if (manifest.schemaVersion !== 1 || !manifest.bundle?.id || !/^[a-f0-9]{64}$/.test(manifest.bundle.sha256) || !Array.isArray(manifest.files)) throw new ArtifactStoreError("Unsupported public release manifest", 400);
  const objects: Array<ReleaseRecord & { objectKey: string }> = [];
  let runtimeCount = 0;
  let evidenceCount = 0;
  for (const record of manifest.files) {
    if (!record.id || !record.path || !Number.isSafeInteger(record.sizeBytes) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new ArtifactStoreError(`Invalid release asset record: ${record.id}`, 400);
    const filePath = path.resolve(root, record.path);
    const relative = path.relative(root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ArtifactStoreError(`Release asset escapes source root: ${record.path}`, 400);
    const bytes = await readFile(filePath);
    if (bytes.length !== record.sizeBytes || digest(bytes) !== record.sha256) throw new ArtifactStoreError(`Release asset checksum mismatch: ${record.id}`, 409);
    const deliveryClass = releaseDeliveryClass(record);
    if (deliveryClass === "evidence") evidenceCount += 1; else runtimeCount += 1;
    const objectKey = objectKeyFor(record, manifest.bundle);
    await store.putImmutable(objectKey, bytes, { contentType: record.mediaType });
    objects.push({ ...record, deliveryClass, objectKey });
  }
  const releaseBase = `public/releases/${cleanKey(manifest.bundle.id)}/${manifest.bundle.sha256}`;
  const manifestKey = `${releaseBase}/release-manifest.json`;
  const publishedManifest = { ...manifest, files: objects, objectStorage: { manifestKey, runtimeCount, evidenceCount } };
  await store.putImmutable(manifestKey, `${JSON.stringify(publishedManifest, null, 2)}\n`, { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" });
  const currentKey = options.currentKey ?? "public/current.json";
  const publishedAt = new Date().toISOString();
  await store.putMutable(currentKey, `${JSON.stringify({ schemaVersion: 1, bundle: manifest.bundle, manifestKey, publishedAt })}\n`, { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" });
  return { schemaVersion: 1, bundle: manifest.bundle, manifestKey, currentKey, runtimeCount, evidenceCount, publishedAt };
}
