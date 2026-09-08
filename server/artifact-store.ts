import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync as readFileSyncFromFs } from "node:fs";
import { readFile, stat, mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
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
  putFileImmutable(key: string, filePath: string, options?: ArtifactPutOptions): Promise<ArtifactObject>;
  downloadToFile(key: string, filePath: string): Promise<ArtifactObject | null>;
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

async function fileDigest(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
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

  async putFileImmutable(key: string, filePath: string, options: ArtifactPutOptions = {}): Promise<ArtifactObject> {
    const logical = cleanKey(key);
    const details = await fileDigest(filePath);
    const existing = await this.head(logical);
    if (existing) {
      if (existing.sizeBytes === details.sizeBytes && existing.sha256 === details.sha256) return existing;
      throw new ArtifactStoreConflictError(`Immutable object already exists with different bytes: ${logical}`);
    }
    const destination = this.filePath(logical);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(createReadStream(filePath), createWriteStream(temporary, { flags: "wx" }));
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const raced = await this.head(logical);
        if (raced?.sizeBytes === details.sizeBytes && raced.sha256 === details.sha256) return raced;
        throw new ArtifactStoreConflictError(`Immutable object was concurrently published with different bytes: ${logical}`);
      }
      throw error;
    }
    await writeFile(metadataPath(destination), JSON.stringify(options) + "\n", { flag: "w" });
    return { key: logical, ...details, ...(options.contentType ? { contentType: options.contentType } : {}) };
  }

  async downloadToFile(key: string, filePath: string): Promise<ArtifactObject | null> {
    const logical = cleanKey(key);
    const existing = await this.head(logical);
    if (!existing) return null;
    await mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(createReadStream(this.filePath(logical)), createWriteStream(filePath, { flags: "wx" }));
    return existing;
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
      await this.verifyRemoteObject(logical, bytes.length, sha256);
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

  async putFileImmutable(key: string, filePath: string, options: ArtifactPutOptions = {}): Promise<ArtifactObject> {
    const logical = cleanKey(key);
    const details = await fileDigest(filePath);
    const existing = await this.head(logical);
    if (existing) return this.reconcileExisting(logical, existing, Buffer.alloc(0), details.sha256, details.sizeBytes);
    try {
      const result = await this.#client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(logical),
        Body: createReadStream(filePath),
        ContentLength: details.sizeBytes,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        Metadata: { ...(options.metadata ?? {}), sha256: details.sha256 },
        IfNoneMatch: "*",
      }));
      await this.verifyRemoteObject(logical, details.sizeBytes, details.sha256);
      return { key: logical, ...details, ...(options.contentType ? { contentType: options.contentType } : {}), ...(result.ETag ? { etag: result.ETag.replace(/^"|"$/g, "") } : {}) };
    } catch (error) {
      if (!isPreconditionFailure(error)) throw new ArtifactStoreError(`S3 immutable file PUT failed for ${logical}: ${error instanceof Error ? error.message : String(error)}`);
      const raced = await this.head(logical);
      if (!raced) throw new ArtifactStoreError(`S3 rejected immutable file PUT but the object is not readable: ${logical}`);
      return this.reconcileExisting(logical, raced, Buffer.alloc(0), details.sha256, details.sizeBytes);
    }
  }

  async downloadToFile(key: string, filePath: string): Promise<ArtifactObject | null> {
    const logical = cleanKey(key);
    const existing = await this.head(logical);
    if (!existing) return null;
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const result = await this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.physicalKey(logical) }));
      if (!result.Body) throw new ArtifactStoreError(`S3 object has no readable body: ${logical}`);
      await pipeline(Readable.from(result.Body as AsyncIterable<Uint8Array>), createWriteStream(filePath, { flags: "wx" }));
      const details = await fileDigest(filePath);
      if (details.sizeBytes !== existing.sizeBytes || (existing.sha256 && details.sha256 !== existing.sha256)) {
        await unlink(filePath).catch(() => undefined);
        throw new ArtifactStoreError(`S3 object checksum mismatch for ${logical}`, 409);
      }
      return { ...existing, ...details };
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(`S3 download failed for ${logical}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async verifyRemoteObject(logical: string, expectedSize: number, expectedSha256: string): Promise<void> {
    const hash = createHash("sha256");
    let size = 0;
    const readWhole = async (): Promise<Buffer> => {
      const result = await this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.physicalKey(logical) }));
      if (!result.Body) throw new Error("object has no readable body");
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    };
    const readRange = async (start: number, end: number): Promise<Buffer> => {
      const result = await this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.physicalKey(logical), Range: `bytes=${start}-${end}` }));
      if (!result.Body) throw new Error("object has no readable body");
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== end - start + 1) throw new Error(`range read returned ${bytes.length} bytes, expected ${end - start + 1}`);
      return bytes;
    };
    const retry = async (operation: () => Promise<Buffer>, label: string): Promise<Buffer> => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        }
      }
      throw new ArtifactStoreError(`S3 read-after-write verification failed for ${logical} (${label}): ${lastError instanceof Error ? lastError.message : String(lastError)}`, 503);
    };
    try {
      if (expectedSize <= 8 * 1024 * 1024) {
        const bytes = await retry(readWhole, "full read");
        size = bytes.length;
        hash.update(bytes);
      } else {
        const chunkSize = 8 * 1024 * 1024;
        for (let start = 0; start < expectedSize; start += chunkSize) {
          const end = Math.min(start + chunkSize, expectedSize) - 1;
          const bytes = await retry(() => readRange(start, end), `range ${start}-${end}`);
          size += bytes.length;
          hash.update(bytes);
        }
      }
      if (size !== expectedSize || hash.digest("hex") !== expectedSha256) {
        throw new ArtifactStoreError(`S3 read-after-write verification failed for ${logical}`, 409);
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(`S3 read-after-write verification failed for ${logical}: ${error instanceof Error ? error.message : String(error)}`, 409);
    }
  }

  private async reconcileExisting(logical: string, existing: ArtifactObject, bytes: Buffer, sha256: string, expectedSize = bytes.length): Promise<ArtifactObject> {
    if (existing.sizeBytes === expectedSize && existing.sha256 === sha256) {
      await this.verifyRemoteObject(logical, expectedSize, sha256);
      return existing;
    }
    if (!existing.sha256) {
      await this.verifyRemoteObject(logical, expectedSize, sha256);
      return { ...existing, sha256 };
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

export interface ReleaseArchiveDescriptor {
  bundle: { id: string; sha256: string };
  archivePath: string;
  archiveSizeBytes: number;
  archiveSha256: string;
}

export interface PublishedReleaseArchive {
  schemaVersion: 2;
  bundle: { id: string; sha256: string };
  archiveKey: string;
  archiveSizeBytes: number;
  archiveSha256: string;
  currentKey: string;
  publishedAt: string;
}

/** Publish one immutable release archive and advance the current pointer last. */
export async function publishReleaseArchive(descriptor: ReleaseArchiveDescriptor, store: ArtifactStore, options: { currentKey?: string } = {}): Promise<PublishedReleaseArchive> {
  if (!descriptor.bundle?.id || !/^[a-f0-9]{64}$/.test(descriptor.bundle.sha256)) throw new ArtifactStoreError("Invalid release bundle identity", 400);
  if (!Number.isSafeInteger(descriptor.archiveSizeBytes) || descriptor.archiveSizeBytes < 1 || !/^[a-f0-9]{64}$/.test(descriptor.archiveSha256)) throw new ArtifactStoreError("Invalid release archive checksum", 400);
  const archiveKey = `public/releases/${cleanKey(descriptor.bundle.id)}/${descriptor.bundle.sha256}/release.tar.gz`;
  const uploaded = await store.putFileImmutable(archiveKey, descriptor.archivePath, {
    contentType: "application/gzip",
    cacheControl: "public, max-age=31536000, immutable",
  });
  if (uploaded.sizeBytes !== descriptor.archiveSizeBytes || uploaded.sha256 !== descriptor.archiveSha256) throw new ArtifactStoreError("Published release archive failed read-after-write verification", 409);
  const currentKey = options.currentKey ?? "public/current.json";
  const publishedAt = new Date().toISOString();
  const pointer = {
    schemaVersion: 2 as const,
    bundle: descriptor.bundle,
    archiveKey,
    archiveSizeBytes: descriptor.archiveSizeBytes,
    archiveSha256: descriptor.archiveSha256,
    publishedAt,
  };
  await store.putMutable(currentKey, `${JSON.stringify(pointer, null, 2)}\n`, { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" });
  return { ...pointer, currentKey };
}
