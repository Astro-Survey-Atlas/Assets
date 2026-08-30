import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AdminHttpError } from "./admin.js";
import type { MocDiscoveryCandidate } from "./moc-discovery.js";

export const MOC_BUILD_PHASES = [
  "QUEUED", "FETCHING", "SNAPSHOT_LOCKED", "VALIDATING", "BUILDING", "PROJECTING", "BUNDLING", "STAGED", "FAILED", "DUPLICATE",
] as const;
export type MocBuildPhase = typeof MOC_BUILD_PHASES[number];

export interface MocBuildProgress {
  phase: MocBuildPhase;
  step: number;
  totalSteps: number;
  percent?: number;
  message?: string;
}

export interface MocBuildOutput {
  moc?: { ref: string; sha256: string; sizeBytes?: number };
  query?: { ref: string; sha256?: string; sizeBytes?: number; order: number };
  preview?: { ref: string; sha256?: string; sizeBytes?: number; order: number };
  statistics?: { ref: string; sha256?: string; sizeBytes?: number };
  manifest?: { ref: string; sha256?: string; sizeBytes?: number };
  cellCount?: number;
  availableOrders?: number[];
  maxOrder?: number;
}

export interface MocPublicationFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

export interface MocPublication {
  schemaVersion: 1;
  id: string;
  buildName: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  layerId: string;
  sourceUrl: string;
  sourceSnapshotSha256?: string;
  sourceSnapshotSizeBytes?: number;
  publishedAt: string;
  files: {
    moc: MocPublicationFile;
    query?: MocPublicationFile;
    preview?: MocPublicationFile;
    statistics?: MocPublicationFile;
    manifest?: MocPublicationFile;
  };
}

export type MocPublicationIntegrity =
  | { valid: true }
  | { valid: false; reason: string };

export interface MocBuildRequest {
  schemaVersion: 1;
  kind: "MocBuildRequest";
  name: string;
  namespace?: string;
  createdAt: string;
  updatedAt: string;
  discoveryRequestName: string;
  provider: "cds";
  candidateId: string;
  candidateTitle?: string;
  surveyId?: string;
  releaseId?: string;
  productId?: string;
  workKey?: string;
  workTitle?: string;
  source: {
    url: string;
    snapshotSha256?: string;
    sizeBytes?: number;
    evidenceRef?: string;
  };
  progress: MocBuildProgress;
  phase: MocBuildPhase;
  outputs?: MocBuildOutput;
  error?: { reason: string; message: string };
  duplicateOf?: string;
  publishedAt?: string;
  publicationId?: string;
}

export interface MocBuildRequestInput {
  discoveryRequestName: string;
  candidate: MocDiscoveryCandidate;
  surveyId?: string;
  releaseId?: string;
  productId?: string;
  workKey?: string;
  workTitle?: string;
  name?: string;
}

export interface MocBuildProductBinding {
  productId: string;
  surveyId: string;
  releaseId: string;
  workKey?: string;
  workTitle?: string;
}

export interface MocCoreRunner {
  validate(sourcePath: string): Promise<Record<string, unknown>>;
  build(sourcePath: string, outputDir: string, options: { maxOrder: number; queryOrder: number; previewOrder: number }): Promise<Record<string, unknown>>;
}

const DEFAULT_TOTAL_STEPS = 7;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const CDS_HOSTS = ["alasky.cds.unistra.fr", "alasky.unistra.fr", "cds.unistra.fr"];

function now(): string { return new Date().toISOString(); }

export function safeMocName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52);
  return normalized || "moc-build";
}

function assertSourceUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AdminHttpError(400, "MOC source URL is invalid"); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !CDS_HOSTS.some((host) => parsed.hostname.toLowerCase() === host || parsed.hostname.toLowerCase().endsWith(`.${host}`))) {
    throw new AdminHttpError(400, "MOC source URL is not on the CDS allowlist");
  }
  return parsed.toString();
}

function hash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

function immutableRef(root: string, value: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(value);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("build path escapes evidence root");
  return resolved;
}

/** Durable Assets-owned state for MOC acquisition and build attempts. */
export class MocBuildStore {
  #root: string;
  #records = new Map<string, MocBuildRequest>();
  #initialized = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(root = process.env.ASSETS_CONTENT_ROOT || "/var/lib/assets-content") {
    this.#root = path.resolve(root);
  }

  private file(): string { return path.join(this.#root, "moc-build-requests-v1.json"); }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    try {
      const value = JSON.parse(await readFile(this.file(), "utf8")) as { requests?: MocBuildRequest[] };
      for (const request of value.requests ?? []) if (request?.name) this.#records.set(request.name, request);
    } catch { /* first boot */ }
    this.#initialized = true;
  }

  private async persist(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const target = this.file();
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, requests: [...this.#records.values()] }, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  }

  private async queuedPersist(): Promise<void> {
    const operation = this.#writeQueue.then(() => this.persist(), () => this.persist());
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }

  list(): MocBuildRequest[] { return [...this.#records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  get(name: string): MocBuildRequest {
    const record = this.#records.get(name);
    if (!record) throw new AdminHttpError(404, `MOC build request ${name} was not found`);
    return record;
  }

  async create(input: MocBuildRequestInput): Promise<MocBuildRequest> {
    await this.initialize();
    const sourceUrl = assertSourceUrl(input.candidate.sourceUrl);
    const timestamp = now().replace(/[-:.TZ]/g, "").slice(0, 14);
    const base = safeMocName(input.name ?? `${input.candidate.candidate.candidateId}-moc-build`);
    let name = `${base}-${timestamp}`.slice(0, 63).replace(/-+$/, "");
    let suffix = 1;
    while (this.#records.has(name)) name = `${base}-${timestamp}-${suffix++}`.slice(0, 63).replace(/-+$/, "");
    const createdAt = now();
    const record: MocBuildRequest = {
      schemaVersion: 1,
      kind: "MocBuildRequest",
      name,
      ...(input.surveyId ? { surveyId: input.surveyId } : {}),
      ...(input.releaseId ? { releaseId: input.releaseId } : {}),
      ...(input.productId ? { productId: input.productId } : {}),
      ...(input.workKey ? { workKey: input.workKey } : {}),
      ...(input.workTitle ? { workTitle: input.workTitle } : {}),
      createdAt,
      updatedAt: createdAt,
      discoveryRequestName: input.discoveryRequestName,
      provider: input.candidate.provider,
      candidateId: input.candidate.candidate.candidateId,
      ...(input.candidate.candidate.title ? { candidateTitle: input.candidate.candidate.title } : {}),
      source: { url: sourceUrl },
      phase: "QUEUED",
      progress: { phase: "QUEUED", step: 0, totalSteps: DEFAULT_TOTAL_STEPS, percent: 0, message: "等待构建 worker" },
    };
    this.#records.set(name, record);
    await this.queuedPersist();
    return record;
  }

  async update(name: string, patch: Partial<Pick<MocBuildRequest, "phase" | "progress" | "source" | "outputs" | "error" | "duplicateOf" | "publishedAt" | "publicationId">>): Promise<MocBuildRequest> {
    await this.initialize();
    const record = this.get(name);
    const nextPhase = patch.phase ?? record.phase;
    if (!MOC_BUILD_PHASES.includes(nextPhase)) throw new AdminHttpError(400, "Unsupported MOC build phase");
    const terminal = ["STAGED", "FAILED", "DUPLICATE"].includes(record.phase);
    if (terminal && nextPhase !== record.phase && !(record.phase === "STAGED" && nextPhase === "STAGED")) throw new AdminHttpError(409, `MOC build ${name} is already ${record.phase}`);
    Object.assign(record, patch, { updatedAt: now() });
    await this.queuedPersist();
    return record;
  }

  async lockSnapshot(name: string, snapshotSha256: string, sizeBytes: number, evidenceRef: string): Promise<{ request: MocBuildRequest; duplicateOf?: string }> {
    await this.initialize();
    if (!/^[a-f0-9]{64}$/.test(snapshotSha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new AdminHttpError(400, "invalid MOC source snapshot");
    const record = this.get(name);
    const existing = this.list().find((candidate) => candidate.name !== name && candidate.provider === record.provider && candidate.candidateId === record.candidateId && candidate.source.snapshotSha256 === snapshotSha256 && candidate.phase !== "FAILED");
    if (existing) {
      await this.update(name, { phase: "DUPLICATE", duplicateOf: existing.name, progress: { phase: "DUPLICATE", step: 3, totalSteps: DEFAULT_TOTAL_STEPS, percent: 100, message: `与 ${existing.name} 使用同一来源快照` } });
      return { request: this.get(name), duplicateOf: existing.name };
    }
    await this.update(name, { source: { ...record.source, snapshotSha256, sizeBytes, evidenceRef }, phase: "SNAPSHOT_LOCKED", progress: { phase: "SNAPSHOT_LOCKED", step: 2, totalSteps: DEFAULT_TOTAL_STEPS, percent: 28, message: "来源 SHA-256 已锁定" } });
    return { request: this.get(name) };
  }

  async markPublished(name: string, publicationId?: string): Promise<MocBuildRequest> {
    return this.update(name, { publishedAt: now(), ...(publicationId ? { publicationId } : {}) });
  }

  /** Bind a staged, unpublished attempt to exactly one Assets product. */
  async bindProduct(name: string, binding: MocBuildProductBinding): Promise<MocBuildRequest> {
    await this.initialize();
    const record = this.get(name);
    if (record.phase !== "STAGED") throw new AdminHttpError(409, `MOC build ${name} is not staged`);
    if (record.publishedAt || record.publicationId) throw new AdminHttpError(409, `MOC build ${name} is already published`);
    if (!binding.productId || !binding.surveyId || !binding.releaseId) throw new AdminHttpError(400, "MOC product binding is incomplete");
    if (record.productId) {
      if (record.productId === binding.productId) return record;
      throw new AdminHttpError(409, `MOC build ${name} is already bound to another product`);
    }
    Object.assign(record, {
      productId: binding.productId,
      surveyId: binding.surveyId,
      releaseId: binding.releaseId,
      ...(binding.workKey ? { workKey: binding.workKey } : {}),
      ...(binding.workTitle ? { workTitle: binding.workTitle } : {}),
      updatedAt: now(),
    });
    await this.queuedPersist();
    return record;
  }
}

export interface MocBuildServiceOptions {
  store: MocBuildStore;
  evidenceRoot?: string;
  maxBytes?: number;
  maxOrder?: number;
  queryOrder?: number;
  previewOrder?: number;
  fetchImpl?: typeof fetch;
  runner?: MocCoreRunner;
}

/** Executes one durable build attempt. It is deliberately independent of ScanRequest. */
export class MocBuildService {
  readonly store: MocBuildStore;
  readonly evidenceRoot: string;
  readonly maxBytes: number;
  readonly maxOrder: number;
  readonly queryOrder: number;
  readonly previewOrder: number;
  readonly fetchImpl: typeof fetch;
  readonly runner: MocCoreRunner;
  #running = new Set<string>();

  constructor(options: MocBuildServiceOptions) {
    this.store = options.store;
    this.evidenceRoot = path.resolve(options.evidenceRoot ?? process.env.ASSETS_EVIDENCE_ROOT ?? "/var/lib/assets-evidence");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxOrder = options.maxOrder ?? 12;
    this.queryOrder = options.queryOrder ?? 8;
    this.previewOrder = options.previewOrder ?? 4;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runner = options.runner ?? new PythonMocCoreRunner();
  }

  enqueue(request: MocBuildRequest, candidate: MocDiscoveryCandidate): void {
    if (this.#running.has(request.name) || ["STAGED", "FAILED", "DUPLICATE"].includes(request.phase)) return;
    this.#running.add(request.name);
    void this.process(request.name, candidate).finally(() => this.#running.delete(request.name));
  }

  private async process(name: string, candidate: MocDiscoveryCandidate): Promise<void> {
    const root = immutableRef(this.evidenceRoot, path.join(this.evidenceRoot, "moc-build", safeMocName(name)));
    const sourcePath = immutableRef(root, path.join(root, "source.moc"));
    try {
      await this.store.update(name, { phase: "FETCHING", progress: { phase: "FETCHING", step: 1, totalSteps: DEFAULT_TOTAL_STEPS, percent: 12, message: "下载 CDS MOC 并计算来源哈希" } });
      const url = assertSourceUrl(candidate.sourceUrl);
      const response = await this.fetchImpl(url, { redirect: "error", headers: { Accept: "application/fits,application/octet-stream" } });
      if (!response.ok || !response.body) throw new Error(`CDS returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > this.maxBytes) throw new Error(`source exceeds ${this.maxBytes} byte limit`);
        chunks.push(next.value);
      }
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const snapshotSha256 = hash(body);
      await mkdir(root, { recursive: true });
      try { await writeFile(sourcePath, body, { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(sourcePath);
        if (hash(existing) !== snapshotSha256) throw new Error("immutable source snapshot conflicts with existing bytes");
      }
      const locked = await this.store.lockSnapshot(name, snapshotSha256, body.length, path.relative(this.evidenceRoot, sourcePath));
      if (locked.duplicateOf) return;
      await this.store.update(name, { phase: "VALIDATING", progress: { phase: "VALIDATING", step: 3, totalSteps: DEFAULT_TOTAL_STEPS, percent: 42, message: "调用 MOC-Core-SDK 校验 ICRS / NESTED / MOC" } });
      await this.runner.validate(sourcePath);
      await this.store.update(name, { phase: "BUILDING", progress: { phase: "BUILDING", step: 4, totalSteps: DEFAULT_TOTAL_STEPS, percent: 58, message: "生成规范化 MOC" } });
      const build = await this.runner.build(sourcePath, root, { maxOrder: this.maxOrder, queryOrder: this.queryOrder, previewOrder: this.previewOrder });
      await this.store.update(name, { phase: "PROJECTING", progress: { phase: "PROJECTING", step: 5, totalSteps: DEFAULT_TOTAL_STEPS, percent: 74, message: "生成 query / preview 投影" } });
      const output = await outputSummary(root, this.evidenceRoot, build, this.queryOrder, this.previewOrder);
      await this.store.update(name, { phase: "BUNDLING", progress: { phase: "BUNDLING", step: 6, totalSteps: DEFAULT_TOTAL_STEPS, percent: 88, message: "写入证据 manifest 和不可变构建产物" }, outputs: output });
      await writeJsonImmutable(path.join(root, "build-manifest.json"), { schemaVersion: 1, kind: "moc-build-evidence", requestName: name, candidateId: candidate.candidate.candidateId, provider: candidate.provider, source: { url, sha256: snapshotSha256, sizeBytes: body.length }, outputs: output });
      await this.store.update(name, { phase: "STAGED", progress: { phase: "STAGED", step: DEFAULT_TOTAL_STEPS, totalSteps: DEFAULT_TOTAL_STEPS, percent: 100, message: "构建完成，等待产品审核与发布" }, outputs: { ...output, manifest: await fileObject(root, this.evidenceRoot, "build-manifest.json") } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await this.store.update(name, { phase: "FAILED", progress: { phase: "FAILED", step: 0, totalSteps: DEFAULT_TOTAL_STEPS, message }, error: { reason: "BuildFailed", message } }); }
      catch { /* preserve the original failure when persistence itself is unavailable */ }
    }
  }
}

export interface MocPublicationProduct {
  productId: string;
  surveyId: string;
  releaseId: string;
  name: string;
}

/**
 * Copies a staged build from evidence into the public content volume. The
 * publication record is the only bridge between the private build directory
 * and public runtime catalogues.
 */
export class MocPublicationStore {
  readonly contentRoot: string;
  readonly evidenceRoot: string;
  #records = new Map<string, MocPublication>();
  #initialized = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(contentRoot = process.env.ASSETS_CONTENT_ROOT || "/var/lib/assets-content", evidenceRoot = process.env.ASSETS_EVIDENCE_ROOT || "/var/lib/assets-evidence") {
    this.contentRoot = path.resolve(contentRoot);
    this.evidenceRoot = path.resolve(evidenceRoot);
  }

  private file(): string { return path.join(this.contentRoot, "moc-publications-v1.json"); }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    try {
      const value = JSON.parse(await readFile(this.file(), "utf8")) as { publications?: MocPublication[] };
      for (const publication of value.publications ?? []) if (publication?.id && publication.buildName) this.#records.set(publication.id, publication);
    } catch { /* first boot */ }
    this.#initialized = true;
  }

  list(): MocPublication[] { return [...this.#records.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)); }

  forBuild(buildName: string): MocPublication | undefined {
    return this.list().find((publication) => publication.buildName === buildName);
  }

  absolutePath(file: MocPublicationFile): string {
    return immutableRef(this.contentRoot, path.join(this.contentRoot, file.path));
  }

  /** Verify the content-volume files before they are exposed as public assets. */
  async verify(publication: MocPublication): Promise<MocPublicationIntegrity> {
    await this.initialize();
    const files = publication && typeof publication === "object" && publication.files && typeof publication.files === "object"
      ? Object.values(publication.files)
      : [];
    if (!files.length) return { valid: false, reason: "publication has no files" };
    if (!publication.files || typeof publication.files !== "object" || !publication.files.moc) {
      return { valid: false, reason: "publication has no required MOC file" };
    }
    for (const value of files) {
      if (!value || typeof value !== "object") return { valid: false, reason: "publication contains an invalid file record" };
      const file = value as Partial<MocPublicationFile>;
      const sizeBytes = file.sizeBytes;
      if (typeof file.path !== "string" || !file.path || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
        || typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        return { valid: false, reason: "publication contains an invalid file record" };
      }
      try {
        const absolute = this.absolutePath(file as MocPublicationFile);
        const details = await lstat(absolute);
        if (!details.isFile() || details.isSymbolicLink()) return { valid: false, reason: "publication file is not a regular file" };
        if (details.size !== sizeBytes) return { valid: false, reason: "publication file size does not match its record" };
        const body = await readFile(absolute);
        if (hash(body) !== file.sha256) return { valid: false, reason: "publication file SHA-256 does not match its record" };
      } catch {
        return { valid: false, reason: "publication file is unavailable" };
      }
    }
    return { valid: true };
  }

  private async persist(): Promise<void> {
    await mkdir(this.contentRoot, { recursive: true });
    const target = this.file();
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, publications: this.list() }, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, target);
  }

  private async queuedPersist(): Promise<void> {
    const operation = this.#writeQueue.then(() => this.persist(), () => this.persist());
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }

  async publish(request: MocBuildRequest, product: MocPublicationProduct): Promise<MocPublication> {
    await this.initialize();
    if (request.phase !== "STAGED" || !request.outputs?.moc) throw new AdminHttpError(409, `MOC build ${request.name} is not staged`);
    const existing = this.forBuild(request.name);
    if (existing) {
      if (existing.productId !== product.productId) throw new AdminHttpError(409, `MOC build ${request.name} is already published for another product`);
      const integrity = await this.verify(existing);
      if (!integrity.valid) throw new AdminHttpError(409, `MOC publication ${existing.id} failed integrity verification: ${integrity.reason}`);
      return existing;
    }
    const candidateDigest = createHash("sha256").update(`${request.provider}:${request.candidateId}`).digest("hex").slice(0, 12);
    const layerId = `moc-${safeMocName(product.surveyId).slice(0, 12)}-${safeMocName(product.releaseId).slice(0, 12)}-${candidateDigest}`.slice(0, 63).replace(/-+$/, "");
    const id = `moc-publication-${createHash("sha256").update(request.name).digest("hex").slice(0, 16)}`;
    const sourceRoot = immutableRef(this.evidenceRoot, path.join(this.evidenceRoot, "moc-build", safeMocName(request.name)));
    const relativeRoot = path.posix.join("moc-releases", safeMocName(request.name));
    const destinationRoot = immutableRef(this.contentRoot, path.join(this.contentRoot, ...relativeRoot.split("/")));
    await mkdir(destinationRoot, { recursive: true });

    const copyOutput = async (sourceRef: { ref: string; sha256?: string; sizeBytes?: number }, targetName: string, mediaType: string): Promise<MocPublicationFile> => {
      const sourceName = path.basename(sourceRef.ref);
      if (!sourceName || sourceName === "." || sourceName === ".." || sourceName.includes("\0")) throw new AdminHttpError(409, "staged MOC output has an invalid filename");
      const source = immutableRef(sourceRoot, path.join(sourceRoot, sourceName));
      const destination = immutableRef(destinationRoot, path.join(destinationRoot, targetName));
      let sourceBody: Buffer;
      try { sourceBody = await readFile(source); }
      catch { throw new AdminHttpError(409, `staged MOC output ${sourceName} is unavailable`); }
      const sourceSha = hash(sourceBody);
      if (sourceRef.sha256 && sourceRef.sha256 !== sourceSha) throw new AdminHttpError(409, `staged MOC output ${sourceName} failed its SHA-256 check`);
      try {
        const existing = await readFile(destination);
        if (hash(existing) !== sourceSha) throw new AdminHttpError(409, `public MOC output ${targetName} already contains different bytes`);
      } catch (error) {
        if (error instanceof AdminHttpError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await copyFile(source, destination);
      }
      return { path: path.posix.join(relativeRoot, targetName), sha256: sourceSha, sizeBytes: sourceBody.length, mediaType };
    };

    const files: MocPublication["files"] = {
      moc: await copyOutput(request.outputs.moc, "moc.fits", "application/fits"),
      ...(request.outputs.query ? { query: await copyOutput(request.outputs.query, "query.json", "application/json") } : {}),
      ...(request.outputs.preview ? { preview: await copyOutput(request.outputs.preview, "preview.json", "application/json") } : {}),
      ...(request.outputs.statistics ? { statistics: await copyOutput(request.outputs.statistics, "statistics.json", "application/json") } : {}),
      ...(request.outputs.manifest ? { manifest: await copyOutput(request.outputs.manifest, "build-manifest.json", "application/json") } : {}),
    };
    const publication: MocPublication = {
      schemaVersion: 1,
      id,
      buildName: request.name,
      productId: product.productId,
      surveyId: product.surveyId,
      releaseId: product.releaseId,
      product: product.name,
      layerId,
      sourceUrl: request.source.url,
      ...(request.source.snapshotSha256 ? { sourceSnapshotSha256: request.source.snapshotSha256 } : {}),
      ...(request.source.sizeBytes !== undefined ? { sourceSnapshotSizeBytes: request.source.sizeBytes } : {}),
      publishedAt: now(),
      files,
    };
    const previous = this.#records.get(id);
    this.#records.set(id, publication);
    try {
      await this.queuedPersist();
    } catch (error) {
      if (previous) this.#records.set(id, previous);
      else this.#records.delete(id);
      throw error;
    }
    return publication;
  }
}

async function outputSummary(root: string, evidenceRoot: string, build: Record<string, unknown>, queryOrder: number, previewOrder: number): Promise<MocBuildOutput> {
  const moc = await fileObject(root, evidenceRoot, "moc.fits");
  const query = await fileObject(root, evidenceRoot, `query-order${queryOrder}.json`).catch(() => undefined);
  const preview = await fileObject(root, evidenceRoot, `preview-order${previewOrder}.json`).catch(() => undefined);
  const statistics = await fileObject(root, evidenceRoot, "statistics.json").catch(() => undefined);
  const result: MocBuildOutput = {
    moc,
    ...(query ? { query: { ...query, order: queryOrder } } : {}),
    ...(preview ? { preview: { ...preview, order: previewOrder } } : {}),
    ...(statistics ? { statistics } : {}),
    ...(typeof build.cells === "number" ? { cellCount: build.cells } : {}),
    ...(Array.isArray(build.availableOrders) ? { availableOrders: build.availableOrders.filter((item): item is number => typeof item === "number") } : {}),
    ...(typeof build.maxOrder === "number" ? { maxOrder: build.maxOrder } : {}),
  };
  return result;
}

async function fileObject(root: string, evidenceRoot: string, name: string): Promise<{ ref: string; sha256: string; sizeBytes: number }> {
  const absolute = immutableRef(root, path.join(root, name));
  const body = await readFile(absolute);
  return { ref: path.relative(path.resolve(evidenceRoot), absolute), sha256: hash(body), sizeBytes: body.length };
}

async function writeJsonImmutable(target: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try { await writeFile(target, body, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(target, "utf8")) !== body) throw new Error(`immutable output conflicts with existing ${target}`);
  }
}

/** Default runner for development and builder images. Production can inject a Job-backed runner. */
export class PythonMocCoreRunner implements MocCoreRunner {
  readonly python: string;
  readonly script: string;
  readonly environment: NodeJS.ProcessEnv;

  constructor(options: { python?: string; script?: string; coreRoot?: string } = {}) {
    this.python = options.python ?? process.env.MOC_BUILDER_PYTHON ?? "python3";
    const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    this.script = options.script ?? process.env.MOC_BUILDER_SCRIPT ?? path.join(moduleRoot, "scripts", "moc_build_worker.py");
    const coreRoot = options.coreRoot ?? process.env.MOC_CORE_ROOT ?? path.resolve(moduleRoot, "..", "MOC-Core-SDK");
    this.environment = { ...process.env, PYTHONPATH: [coreRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  }

  validate(sourcePath: string): Promise<Record<string, unknown>> { return this.run(["validate", "--source", sourcePath]); }

  build(sourcePath: string, outputDir: string, options: { maxOrder: number; queryOrder: number; previewOrder: number }): Promise<Record<string, unknown>> {
    return this.run(["build", "--source", sourcePath, "--output", outputDir, "--max-order", String(options.maxOrder), "--query-order", String(options.queryOrder), "--preview-order", String(options.previewOrder)]);
  }

  private run(args: string[]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.script, ...args], { env: this.environment, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) { reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `MOC builder exited with ${code}`)); return; }
        try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>); }
        catch { reject(new Error("MOC builder returned invalid JSON")); }
      });
    });
  }
}
