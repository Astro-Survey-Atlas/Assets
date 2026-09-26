import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link } from "node:fs/promises";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import yazl from "yazl";

import { historicalPackages, mergePackageHistory, type PackageMetadata } from "./package-history.js";
import { assertReleaseContinuity, retainedPackageLayers } from "./package-continuity.js";
import type { MocPublication } from "./moc-build.js";
import { decodeNativeMoc, sha256, type NativeMoc } from "./native-moc.js";
import { deriveAccessModes, sourceAuthorityForUrl, sourceTierAuthority } from "./package-access-policy.js";
import { isDeniedSurvey } from "./publication-policy.js";
import type { ProductContent, ProductRecord } from "./products.js";
import { readResourcePackageManifest, readZipEntry } from "./resource-package-inspection.js";
import { buildResourcePackageHealpixFiles } from "./resource-package-healpix.js";
import { queueStateSnapshot, queueStateSnapshotFile, stateSnapshotFileKey, type StateSnapshotSink } from "./state-snapshot.js";

const PACKAGE_SCHEMA_VERSION = 3;
/** Baseline package format; dynamic packages increment the minor version per release. */
const PACKAGE_VERSION_PATTERN = /^3\.(\d+)\.\d+$/;
const STORE_SCHEMA_VERSION = 1;
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LAYER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PACKAGE_ID_LENGTH = 80;

export interface DynamicResourcePackageEntry {
  id: string;
  name: string;
  description: string;
  surveyId: string;
  modalities: string[];
  wavelengths: string[];
  productTypes: string[];
  facilities: string[];
  coverageAuthorities: string[];
  accessModes: string[];
  releases: string[];
  releaseLabels: Record<string, string>;
  sources: Array<{ releaseId: string; label: string; url: string; authority: string; license?: string }>;
  version: string;
  archiveUrl: string;
  sizeBytes: number;
  sha256: string;
  updatedAt: string;
  hidden: boolean;
  deprecated: boolean;
  replacedBy: string[];
  /** Content-volume path; never included in the public catalog response. */
  archivePath: string;
  /** Content-addressed object-store copy; never included in the public catalog response. */
  objectKey?: string;
  /** Fingerprint of the publication/product inputs used to build this archive. */
  contentFingerprint: string;
}

export interface DynamicResourcePackageAsset {
  id: string;
  kind: "package" | "geometry";
  mediaType: "application/zip" | "application/json";
  description: string;
  path: string;
  downloadName: string;
  sizeBytes: number;
  sha256: string;
  surveyId: string;
  releaseId?: string;
  version: string;
  name: string;
}

interface PersistedStore {
  schemaVersion: 1;
  packages: DynamicResourcePackageEntry[];
}

interface LayerBytes {
  publication: MocPublication;
  product: ProductContent;
  moc: Buffer;
  nativeMoc: NativeMoc;
  query?: { order: number; pixels: number[] };
  preview?: { order: number; pixels: number[] };
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value: string, fallback = "public"): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return normalized || fallback;
}

function text(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function healpixCellLimit(order: number): bigint {
  return 12n * (4n ** BigInt(order));
}

function fitsCard(bytes: Buffer, keyword: string): string | undefined {
  const limit = Math.min(bytes.length, 64 * 1024);
  for (let offset = 0; offset + 80 <= limit; offset += 80) {
    const card = bytes.toString("ascii", offset, offset + 80);
    if (card.slice(0, 8).trim() === keyword && card[8] === "=") {
      return card.slice(10).split("/", 1)[0]?.trim().replace(/^'|'$/g, "").trim();
    }
  }
  return undefined;
}

function validateMocFits(bytes: Buffer): void {
  if (bytes.length < 2880 || bytes.length % 2880 !== 0 || bytes.toString("ascii", 0, 8) !== "SIMPLE  ") {
    throw new Error("Published MOC is not a padded FITS file");
  }
  if (fitsCard(bytes, "ORDERING") !== "NUNIQ"
    || fitsCard(bytes, "COORDSYS") !== "C"
    || fitsCard(bytes, "MOCVERS") !== "2.0"
    || fitsCard(bytes, "MOCDIM") !== "SPACE") {
    throw new Error("Published MOC must declare ICRS/NUNIQ/SPACE semantics");
  }
  const hasUniqColumn = Array.from({ length: 32 }, (_, index) => fitsCard(bytes, `TTYPE${index + 1}`)).some((value) => value === "UNIQ");
  if (!hasUniqColumn) throw new Error("Published MOC does not contain a UNIQ column");
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validStringList(value: unknown, maximum = 160, allowEmpty = false): value is string[] {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maximum)
    && new Set(value.map((item) => item.trim())).size === value.length;
}

function expectedArchivePath(id: string, version: string): string {
  return `resource-packages/${id}/${version}/${id}.zip`;
}

function packageEntryKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function packageMinorVersion(version: string): number | undefined {
  return PACKAGE_VERSION_PATTERN.exec(version)?.[1] === undefined ? undefined : Number(PACKAGE_VERSION_PATTERN.exec(version)![1]);
}

function validObjectKey(value: string): boolean {
  if (!value || value.includes("\0") || value.startsWith("/")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function localArchiveState(filePath: string, expected: { sha256: string; sizeBytes: number }): Promise<"valid" | "missing" | "invalid"> {
  try {
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== expected.sizeBytes) return "invalid";
    return hash(await readFile(filePath)) === expected.sha256 ? "valid" : "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "invalid";
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, filePath);
}

export function stableResourcePackageId(surveyId: string): string {
  return `public-${slug(surveyId).slice(0, 40)}-footprints`;
}

function persistedPackageEntry(value: unknown): DynamicResourcePackageEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Partial<DynamicResourcePackageEntry>;
  if (typeof entry.id !== "string" || entry.id.length > MAX_PACKAGE_ID_LENGTH || !PACKAGE_ID_PATTERN.test(entry.id)) return undefined;
  if (typeof entry.version !== "string" || !PACKAGE_VERSION_PATTERN.test(entry.version)) return undefined;
  if (typeof entry.archivePath !== "string" || entry.archivePath !== expectedArchivePath(entry.id, entry.version) || entry.archivePath.includes("\\") || entry.archivePath.includes("\0")) return undefined;
  if (typeof entry.archiveUrl !== "string" || entry.archiveUrl !== `/api/v1/assets/${dynamicResourcePackageAssetId({ id: entry.id, version: entry.version })}/download`) return undefined;
  if (typeof entry.surveyId !== "string" || !entry.surveyId.trim() || entry.surveyId.length > 120) return undefined;
  if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 200) return undefined;
  if (typeof entry.description !== "string" || !entry.description.trim() || entry.description.length > 4000) return undefined;
  if (!validStringList(entry.modalities) || !validStringList(entry.wavelengths) || !validStringList(entry.productTypes) || !validStringList(entry.facilities) || !validStringList(entry.coverageAuthorities) || !validStringList(entry.accessModes)) return undefined;
  if (!validStringList(entry.releases, 120)) return undefined;
  if (!entry.releaseLabels || typeof entry.releaseLabels !== "object" || Array.isArray(entry.releaseLabels)) return undefined;
  const labels = entry.releaseLabels as Record<string, unknown>;
  if (Object.keys(labels).some((releaseId) => !entry.releases!.includes(releaseId) || typeof labels[releaseId] !== "string" || !String(labels[releaseId]).trim() || String(labels[releaseId]).length > 200)) return undefined;
  if (!Array.isArray(entry.sources) || !entry.sources.length || entry.sources.some((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return true;
    const item = source as { releaseId?: unknown; label?: unknown; url?: unknown; authority?: unknown; license?: unknown };
    return typeof item.releaseId !== "string" || !entry.releases!.includes(item.releaseId)
      || typeof item.label !== "string" || !item.label.trim() || item.label.length > 200
      || typeof item.url !== "string" || !validUrl(item.url)
      || typeof item.authority !== "string" || !item.authority.trim() || item.authority.length > 120
      || (item.license !== undefined && (typeof item.license !== "string" || item.license.length > 200));
  })) return undefined;
  const sizeBytes = entry.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) return undefined;
  if (typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))) return undefined;
  if (entry.hidden !== false || entry.deprecated !== false || !Array.isArray(entry.replacedBy) || !entry.replacedBy.every((id) => typeof id === "string" && PACKAGE_ID_PATTERN.test(id))) return undefined;
  if (entry.objectKey !== undefined && (typeof entry.objectKey !== "string" || !validObjectKey(entry.objectKey))) return undefined;
  if (typeof entry.contentFingerprint !== "string" || !SHA256_PATTERN.test(entry.contentFingerprint)) return undefined;
  return entry as DynamicResourcePackageEntry;
}

function productForPublication(publication: MocPublication, products: readonly ProductRecord[]): ProductContent {
  const record = products.find((candidate) => candidate.productId === publication.productId);
  const product = record?.published ?? record?.draft;
  if (product) return product;
  return {
    productId: publication.productId,
    surveyId: publication.surveyId,
    releaseId: publication.releaseId,
    name: publication.product,
    modality: "catalog",
    mode: "native-moc",
    coverageRole: "footprint_extent",
    dataOrigin: "observed",
    sourceTier: "third_party_moc",
    sourceUrl: publication.sourceUrl,
    presentation: { summaryMarkdown: "", methodologyMarkdown: "", limitationsMarkdown: "", flow: { nodes: [], edges: [] } },
  };
}

function readProjection(value: unknown): { order: number; pixels: number[] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { order?: unknown; pixels?: unknown };
  if (!Number.isSafeInteger(record.order) || Number(record.order) < 0 || Number(record.order) > 29 || !Array.isArray(record.pixels)) return undefined;
  const order = Number(record.order);
  if ((record as { ordering?: unknown }).ordering !== undefined && (record as { ordering?: unknown }).ordering !== "NESTED") return undefined;
  if ((record as { coordinateFrame?: unknown }).coordinateFrame !== undefined && (record as { coordinateFrame?: unknown }).coordinateFrame !== "ICRS") return undefined;
  const limit = healpixCellLimit(order);
  const pixels = record.pixels.filter((pixel): pixel is number => Number.isSafeInteger(pixel) && pixel >= 0 && BigInt(pixel) < limit);
  if (!pixels.length) return undefined;
  return { order, pixels: [...new Set(pixels)].sort((left, right) => left - right) };
}

async function loadLayer(publication: MocPublication, products: readonly ProductRecord[], absolutePath: (file: MocPublication["files"]["moc"]) => string): Promise<LayerBytes | undefined> {
  if (!publication || !LAYER_ID_PATTERN.test(publication.layerId) || !publication.surveyId.trim() || !publication.releaseId.trim()) return undefined;
  const product = productForPublication(publication, products);
  let moc: Buffer;
  let nativeMoc: NativeMoc;
  try {
    moc = await readFile(absolutePath(publication.files.moc));
    if (moc.length !== publication.files.moc.sizeBytes || hash(moc) !== publication.files.moc.sha256) return undefined;
    validateMocFits(moc);
    nativeMoc = decodeNativeMoc(moc);
  }
  catch { return undefined; }
  const readOptionalProjection = async (file: MocPublication["files"]["query"]): Promise<{ order: number; pixels: number[] } | undefined> => {
    if (!file) return undefined;
    try { return readProjection(JSON.parse(await readFile(absolutePath(file), "utf8"))); }
    catch { return undefined; }
  };
  const query = await readOptionalProjection(publication.files.query);
  const preview = await readOptionalProjection(publication.files.preview);
  if (!query && !preview) return undefined;
  return { publication, product, moc, nativeMoc, ...(query ? { query } : {}), ...(preview ? { preview } : {}) };
}

function projectToOrder(pixels: readonly number[], fromOrder: number, toOrder: number): number[] {
  if (toOrder > fromOrder) throw new Error(`Cannot project coverage from O${fromOrder} to finer O${toOrder}`);
  const factor = 4n ** BigInt(fromOrder - toOrder);
  return [...new Set(pixels.map((pixel) => Number(BigInt(pixel) / factor)))].sort((left, right) => left - right);
}

function packageSupport(layerBytes: readonly LayerBytes[], overviewOrder: number): Buffer {
  const generatedAt = layerBytes.map((layer) => layer.publication.publishedAt).sort().at(-1) ?? new Date().toISOString();
  const footprints = layerBytes.map(({ publication, product, query, preview }) => {
    const source = preview ?? query!;
    const pixels = projectToOrder(source.pixels, source.order, overviewOrder);
    return {
      surveyId: publication.surveyId,
      releaseId: publication.releaseId,
      product: publication.product,
      label: text(product.publicRelease?.label, publication.product),
      nside: 2 ** overviewOrder,
      pixels,
      quality: "official_overview" as const,
      sourceUrl: publication.sourceUrl,
      retrievedAt: publication.publishedAt,
      notes: `Display projection at explicit NESTED order ${overviewOrder}; authoritative coverage is the packaged FITS MOC.`,
    };
  }).sort((left, right) => `${left.releaseId}:${left.product}`.localeCompare(`${right.releaseId}:${right.product}`));
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, generatedAt, coordinateFrame: "ICRS", nside: 2 ** overviewOrder, footprints }, null, 2)}\n`, "utf8");
}

function packageProvenance(layerBytes: readonly LayerBytes[], packageId: string, packageVersion: string, overviewOrder: number): Buffer {
  const generatedAt = layerBytes.map((layer) => layer.publication.publishedAt).sort().at(-1) ?? new Date().toISOString();
  const layers = layerBytes.map(({ publication, product, query, preview, moc }) => ({
    layerId: publication.layerId,
    surveyId: publication.surveyId,
    releaseId: publication.releaseId,
    product: publication.product,
    modality: product.modality ?? "catalog",
    coverageRole: product.coverageRole ?? "footprint_extent",
    dataOrigin: product.dataOrigin ?? "observed",
    sourceTier: product.sourceTier ?? "third_party_moc",
    sourceUrl: publication.sourceUrl,
    sourceSnapshot: publication.sourceSnapshotSha256 ? { sha256: publication.sourceSnapshotSha256, ...(publication.sourceSnapshotSizeBytes !== undefined ? { sizeBytes: publication.sourceSnapshotSizeBytes } : {}) } : undefined,
    outputs: {
      moc: { path: `mocs/${publication.layerId}.moc.fits`, sizeBytes: moc.length, sha256: hash(moc) },
      ...(query ? { queryOrder: query.order } : {}),
      ...(preview ? { previewOrder: preview.order } : {}),
      overviewOrder,
    },
  })).sort((left, right) => left.layerId.localeCompare(right.layerId));
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, packageId, packageVersion, generatedAt, coordinateFrame: "ICRS", ordering: "NESTED", generator: { name: "astro-survey-atlas-assets", version: "1.0.0" }, layers }, null, 2)}\n`, "utf8");
}

async function zipEntries(entries: ReadonlyMap<string, Buffer>, destination: string): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    zip.addBuffer(bytes, name, { mtime: ZIP_EPOCH, mode: 0o100644, compress: true, forceDosTimestamp: true });
  }
  zip.end();
  await pipeline(zip.outputStream as NodeJS.ReadableStream, createWriteStream(destination, { flags: "wx", mode: 0o644 }));
}

function publicEntry(entry: DynamicResourcePackageEntry): Omit<DynamicResourcePackageEntry, "archivePath" | "objectKey" | "contentFingerprint"> {
  const { archivePath: _archivePath, objectKey: _objectKey, contentFingerprint: _contentFingerprint, ...result } = entry;
  return result;
}

export function dynamicResourcePackageAssetId(entry: Pick<DynamicResourcePackageEntry, "id" | "version">): string {
  // Public asset IDs are path components too. Keep the semver identity in the
  // package catalog, but normalize punctuation for the stable download ID.
  const version = entry.version.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `package-${entry.id}-${version}`;
}

/**
 * Owns runtime-generated packages for publications that are stored on the
 * content volume. Every input fingerprint receives a distinct package ID;
 * existing archives and package versions are never overwritten.
 */
export class DynamicResourcePackageStore {
  readonly contentRoot: string;
  /** Keyed by `<id>@<version>`; one content lineage may carry several versions. */
  #entries = new Map<string, DynamicResourcePackageEntry>();
  #initialized = false;
  readonly #snapshotSink: StateSnapshotSink | undefined;

  constructor(contentRoot: string, snapshotSink?: StateSnapshotSink, private readonly baselineRoot?: string) {
    this.contentRoot = path.resolve(contentRoot);
    this.#snapshotSink = snapshotSink;
  }

  private file(): string { return path.join(this.contentRoot, "resource-package-publications-v1.json"); }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.contentRoot, { recursive: true });
    let value: Partial<PersistedStore> | undefined;
    try {
      value = JSON.parse(await readFile(this.file(), "utf8")) as Partial<PersistedStore>;
    } catch (error) {
      if (this.#snapshotSink?.restore) {
        const restored = await this.#snapshotSink.restore("resource-packages");
        if (restored && restored.state && typeof restored.state === "object" && Array.isArray((restored.state as Partial<PersistedStore>).packages)) {
          value = restored.state as Partial<PersistedStore>;
          await writeJsonAtomic(this.file(), value);
        } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (value?.schemaVersion === STORE_SCHEMA_VERSION && Array.isArray(value.packages)) {
      const seen = new Set<string>();
      for (const raw of value.packages) {
        const entry = persistedPackageEntry(raw);
        if (!entry || seen.has(packageEntryKey(entry.id, entry.version))) continue;
        seen.add(packageEntryKey(entry.id, entry.version));
        const archivePath = path.resolve(this.contentRoot, entry.archivePath);
        const relative = path.relative(this.contentRoot, archivePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        let state = await localArchiveState(archivePath, entry);
        if ((state === "missing" || state === "invalid") && entry.objectKey && this.#snapshotSink?.restoreFile) {
          try {
            const restored = await this.#snapshotSink.restoreFile({
              namespace: "resource-packages",
              objectKey: entry.objectKey,
              destinationPath: archivePath,
              sha256: entry.sha256,
              sizeBytes: entry.sizeBytes,
            });
            if (restored) state = await localArchiveState(archivePath, entry);
          } catch { state = "invalid"; }
        }
        if (state === "valid") this.#entries.set(packageEntryKey(entry.id, entry.version), entry);
      }
    }
    this.#initialized = true;
  }

  /** Explicit maintenance: restore Release sets lost before this publisher existed. */
  async repairHistoricalReleases(root: string): Promise<void> {
    await this.initialize();
    const recovered = await historicalPackages(root);
    const catalog = JSON.parse(await readFile(path.join(root, "artifacts/public-survey-footprints/packages/catalog.json"), "utf8")) as { packages: PackageMetadata[] };
    for (const id of new Set(recovered.map(({ entry }) => entry.id))) {
      const current = catalog.packages.filter((entry) => entry.id === id && !entry.deprecated).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
      if (!current) continue;
      const older = recovered.filter(({ entry }) => entry.id === id).sort((a, b) => a.entry.version.localeCompare(b.entry.version, undefined, { numeric: true }));
      if (older.every(({ entry }) => entry.releases.every((release) => current.releases.includes(release)))) continue;
      const bytes = await readFile(path.join(root, "artifacts/public-survey-footprints/packages", `${id}-${current.version}.zip`));
      const fingerprint = hash(JSON.stringify([...older.map(({ entry }) => entry.sha256), current.sha256]));
      if ([...this.#entries.values()].some((entry) => entry.id === id && entry.contentFingerprint === fingerprint)) continue;
      const minor = Math.max(packageMinorVersion(current.version) ?? 0, ...[...this.#entries.values()].filter((entry) => entry.id === id).map((entry) => packageMinorVersion(entry.version) ?? 0)) + 1;
      const version = `3.${minor}.0`;
      const merged = await mergePackageHistory([...older, { entry: current, bytes }], version);
      const archivePath = expectedArchivePath(id, version);
      const destination = path.join(this.contentRoot, archivePath);
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      await zipEntries(merged.entries, temporary);
      const archive = await readFile(temporary);
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await readFile(destination)) !== hash(archive)) throw error;
      } finally { await rm(temporary, { force: true }); }
      const entry: DynamicResourcePackageEntry = { ...merged.metadata, archivePath, archiveUrl: `/api/v1/assets/${dynamicResourcePackageAssetId({ id, version })}/download`, sizeBytes: archive.length, sha256: hash(archive), updatedAt: new Date().toISOString(), contentFingerprint: fingerprint, objectKey: stateSnapshotFileKey("resource-packages", hash(archive)) };
      if (!persistedPackageEntry(entry)) throw new Error(`Invalid repaired package metadata: ${id}`);
      this.#entries.set(packageEntryKey(id, version), entry);
      await this.persist();
      await queueStateSnapshotFile(this.#snapshotSink, { namespace: "resource-packages", sourcePath: destination, objectKey: entry.objectKey!, kind: "resource-package", contentType: "application/zip", expectedSha256: entry.sha256, expectedSizeBytes: entry.sizeBytes });
    }
  }

  async reload(): Promise<void> {
    this.#initialized = false;
    this.#entries.clear();
    await this.initialize();
  }

  list(): Array<Omit<DynamicResourcePackageEntry, "archivePath" | "objectKey" | "contentFingerprint">> {
    return [...this.#entries.values()]
      .sort((left, right) => left.id.localeCompare(right.id)
        || (packageMinorVersion(left.version) ?? 0) - (packageMinorVersion(right.version) ?? 0))
      .map(publicEntry);
  }

  /** Latest non-deprecated entry for a stable package ID, if any. */
  latest(id: string): Omit<DynamicResourcePackageEntry, "archivePath" | "objectKey" | "contentFingerprint"> | undefined {
    const candidates = [...this.#entries.values()].filter((entry) => entry.id === id);
    if (!candidates.length) return undefined;
    const live = candidates.filter((entry) => !entry.deprecated);
    const pool = live.length ? live : candidates;
    const latest = pool.reduce((best, entry) => ((packageMinorVersion(entry.version) ?? -1) >= (packageMinorVersion(best.version) ?? -1) ? entry : best));
    return publicEntry(latest);
  }

  assets(): DynamicResourcePackageAsset[] {
    return [...this.#entries.values()].map((entry) => ({
      id: dynamicResourcePackageAssetId(entry),
      kind: "package",
      mediaType: "application/zip",
      description: entry.description,
      path: entry.archivePath,
      downloadName: `${entry.id}-${entry.version}.zip`,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      surveyId: entry.surveyId,
      releaseId: entry.releases[0],
      version: entry.version,
      name: entry.name,
    }));
  }

  async sync(publications: readonly MocPublication[], products: readonly ProductRecord[], absolutePath: (file: MocPublication["files"]["moc"]) => string): Promise<void> {
    await this.initialize();
    const resolveContentPath = (file: MocPublication["files"]["moc"]): string => {
      const resolved = path.resolve(absolutePath(file));
      const relative = path.relative(this.contentRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`MOC publication path escapes the content volume: ${file.path}`);
      return resolved;
    };
    const grouped = new Map<string, LayerBytes[]>();
    for (const publication of publications) {
      if (isDeniedSurvey(publication.surveyId)) continue;
      const productRecord = products.find((candidate) => candidate.productId === publication.productId);
      if (productRecord?.retiredAt) continue;
      const layer = await loadLayer(publication, products, resolveContentPath);
      if (!layer) continue;
      const current = grouped.get(publication.surveyId) ?? [];
      current.push(layer);
      grouped.set(publication.surveyId, current);
    }
    // If a survey still has publication records but all of its products were
    // explicitly retired, keep the old archive for history but mark it
    // deprecated so it cannot re-enter the current release.
    const publicationSurveys = new Set(publications.filter((publication) => !isDeniedSurvey(publication.surveyId)).map((publication) => publication.surveyId));
    for (const entry of this.#entries.values()) {
      if (entry.deprecated || !publicationSurveys.has(entry.surveyId) || grouped.has(entry.surveyId)) continue;
      if (!publications.filter((publication) => publication.surveyId === entry.surveyId).every((publication) => products.some((product) => product.productId === publication.productId && product.retiredAt))) throw new Error(`No valid layers for ${entry.surveyId}; retaining the previous package`);
      entry.deprecated = true;
      entry.replacedBy = [...new Set([...entry.replacedBy, `retired-${entry.surveyId}`])];
    }
    const created: DynamicResourcePackageEntry[] = [];
    for (const [surveyId, layers] of grouped) {
      const entry = await this.syncSurvey(surveyId, layers);
      if (entry) created.push(entry);
    }
    await this.persist();
    for (const entry of created) {
      await queueStateSnapshotFile(this.#snapshotSink, {
        namespace: "resource-packages",
        sourcePath: path.resolve(this.contentRoot, entry.archivePath),
        objectKey: entry.objectKey ?? stateSnapshotFileKey("resource-packages", entry.sha256),
        kind: "resource-package",
        contentType: "application/zip",
        expectedSha256: entry.sha256,
        expectedSizeBytes: entry.sizeBytes,
      });
    }
  }

  private async syncSurvey(surveyId: string, layers: readonly LayerBytes[]): Promise<DynamicResourcePackageEntry | undefined> {
    const retained = await retainedPackageLayers(this.baselineRoot, surveyId, layers.map((layer) => layer.publication.layerId));
    const orders = layers.flatMap((layer) => [layer.preview?.order, layer.query?.order]).filter((order): order is number => order !== undefined);
    if (!orders.length) return undefined;
    const overviewOrder = Math.min(4, ...orders);
    const fingerprint = hash(JSON.stringify([retained.layers, ...layers.map(({ publication, product, query, preview, moc }) => ({
      id: publication.id,
      layerId: publication.layerId,
      publishedAt: publication.publishedAt,
      product: {
        productId: product.productId,
        revision: product.publicRelease,
        modality: product.modality,
        coverageRole: product.coverageRole,
        dataOrigin: product.dataOrigin,
        sourceTier: product.sourceTier,
        coverageEvidence: product.coverageEvidence,
        sourceUnitIndex: product.sourceUnitIndex,
      },
      source: publication.sourceSnapshotSha256,
      files: { moc: hash(moc), query, preview },
    })).sort((left, right) => left.layerId.localeCompare(right.layerId))]));
    const packageId = stableResourcePackageId(surveyId);
    const lineage = [...this.#entries.values()].filter((entry) => entry.id === packageId);
    const existingPackage = lineage.find((entry) => entry.contentFingerprint === fingerprint && !entry.deprecated);
    if (existingPackage) return undefined;
    // Stable package IDs carry incrementing content versions: static seed
    // packages are 3.0.0, the first dynamic rebuild becomes 3.1.0, and every
    // changed fingerprint bumps the minor version again.
    const nextMinor = lineage.reduce((max, entry) => Math.max(max, packageMinorVersion(entry.version) ?? 0), packageMinorVersion(retained.metadata.version) ?? 0) + 1;
    const packageVersion = `3.${nextMinor}.0`;
    const entryKey = packageEntryKey(packageId, packageVersion);
    if (this.#entries.has(entryKey)) throw new Error(`Dynamic package version collision: ${packageId} ${packageVersion}`);
    const packageDir = path.join(this.contentRoot, "resource-packages", packageId, packageVersion);
    await mkdir(packageDir, { recursive: true });
    const packagePath = path.join(packageDir, `${packageId}.zip`);
    const footprintDocument = JSON.parse(packageSupport(layers, overviewOrder).toString());
    footprintDocument.footprints.push(...retained.footprints);
    const footprint = Buffer.from(JSON.stringify(footprintDocument));
    const provenanceDocument = JSON.parse(packageProvenance(layers, packageId, packageVersion, overviewOrder).toString());
    provenanceDocument.layers.push(...retained.provenance);
    const provenance = Buffer.from(JSON.stringify(provenanceDocument));
    const first = layers[0]!;
    const releases = [...new Set([...retained.layers.map((layer) => layer.releaseId), ...layers.map((layer) => layer.publication.releaseId)])].sort();
    assertReleaseContinuity([...retained.metadata.releases, ...lineage.flatMap((entry) => entry.releases)], releases);
    const releaseLabels = Object.fromEntries(layers.map((layer) => [layer.publication.releaseId, text(layer.product.publicRelease?.label, layer.publication.releaseId)]));
    const sources = [...layers.reduce((unique, layer) => {
      if (!unique.has(layer.publication.releaseId)) {
        unique.set(layer.publication.releaseId, {
          releaseId: layer.publication.releaseId,
          label: text(layer.product.publicRelease?.label, layer.publication.product),
          url: layer.publication.sourceUrl,
          authority: sourceAuthorityForUrl(layer.publication.sourceUrl),
        });
      }
      return unique;
    }, new Map<string, { releaseId: string; label: string; url: string; authority: string }>()).values()].sort((left, right) => left.releaseId.localeCompare(right.releaseId));
    Object.assign(releaseLabels, retained.metadata.releaseLabels);
    for (const source of retained.metadata.sources) if (releases.includes(source.releaseId) && !sources.some((item) => item.releaseId === source.releaseId)) sources.push(source);
    const layerRecords = layers.map(({ publication, product, moc, nativeMoc, preview, query }) => ({
      layerId: publication.layerId,
      surveyId,
      releaseId: publication.releaseId,
      productId: publication.productId,
      product: publication.product,
      ...(product.coverageEvidence?.sourceIdentity ? { sourceId: product.coverageEvidence.sourceIdentity } : {}),
      modality: product.modality ?? "catalog",
      coverageRole: product.coverageRole ?? "footprint_extent",
      dataOrigin: product.dataOrigin ?? "observed",
      sourceTier: product.sourceTier ?? "third_party_moc",
      path: `mocs/${publication.layerId}.moc.fits`,
      sizeBytes: moc.length,
      sha256: hash(moc),
      coordinateFrame: "ICRS" as const,
      ordering: "NESTED" as const,
      mocEncoding: "NUNIQ" as const,
      availableOrders: nativeMoc.availableOrders,
      overviewOrder: Math.min(nativeMoc.maxOrder, preview?.order ?? query?.order ?? 4),
      maxOrder: nativeMoc.maxOrder,
      coverageRevision: nativeMoc.revision,
      indexRevision: null,
      geometryPrecision: product.coverageEvidence?.precision ?? "unknown",
      completeness: product.coverageEvidence?.completeness ?? "unknown",
      precisionNote: product.coverageEvidence?.summary || "Published coverage precision and source completeness were not recorded.",
      accessAvailability: product.sourceUnitIndex?.status === "exact" ? "tile-resolved" : product.sourceUnitIndex ? "entrypoint-only" : "geometry-only",
    })).sort((left, right) => left.layerId.localeCompare(right.layerId));
    const packageLayers = [...layerRecords, ...retained.layers].sort((left, right) => left.layerId.localeCompare(right.layerId));
    const mocBytesByLayer = new Map<string, Uint8Array>([
      ...layers.map(({ publication, moc }) => [publication.layerId, moc] as const),
      ...retained.layers.map((layer) => {
        const bytes = retained.entries.get(layer.path);
        if (!bytes) throw new Error(`Retained package MOC bytes are missing: ${layer.layerId}`);
        return [layer.layerId, bytes] as const;
      }),
    ]);
    const healpixFiles = buildResourcePackageHealpixFiles({ packageId, packageVersion, surveyId, layers: packageLayers, mocBytesByLayer });
    const support = new Map<string, Buffer>([["README.md", Buffer.from(`# ${surveyId.toUpperCase()} public coverage\n\nThis immutable Resource Package v3 was generated from published Assets MOC outputs. FITS MOCs are authoritative ICRS/NESTED coverage; the footprint JSON is an explicit display projection at order ${overviewOrder}.\n`, "utf8")], ["footprints/survey-footprints.json", footprint], ["provenance.json", provenance], ...healpixFiles.map((file) => [file.path, file.bytes] as const)]);
    const packageManifest = {
      schemaVersion: PACKAGE_SCHEMA_VERSION,
      id: packageId,
      version: packageVersion,
      surveyId,
      layers: packageLayers,
      files: [...support.entries()].map(([filePath, bytes]) => ({ path: filePath, sizeBytes: bytes.length, sha256: hash(bytes) })).sort((left, right) => left.path.localeCompare(right.path)),
    };
    const entries = new Map<string, Buffer>([["resource-package.json", Buffer.from(`${JSON.stringify(packageManifest, null, 2)}\n`, "utf8")], ...support.entries(), ...retained.entries, ...layers.map(({ publication, moc }) => [`mocs/${publication.layerId}.moc.fits`, moc] as const)]);
    const temporary = `${packagePath}.${process.pid}.${Date.now()}.tmp`;
    await zipEntries(entries, temporary);
    const archiveBytes = await readFile(temporary);
    const archiveSha = hash(archiveBytes);
    try {
      // A hard-link gives us an atomic create-without-replace operation on the
      // content volume. The temporary file is removed in either branch.
      await link(temporary, packagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(packagePath);
      if (hash(existing) !== archiveSha) throw new Error(`Dynamic package archive already exists with different bytes: ${packageId}`);
    } finally {
      await rm(temporary, { force: true });
    }
    const latest = layers.map((layer) => layer.publication.publishedAt).sort().at(-1) ?? new Date().toISOString();
    const entry: DynamicResourcePackageEntry = {
      id: packageId,
      name: text(first.product.publicSurvey?.name, surveyId.toUpperCase()),
      description: text(first.product.publicSurvey?.description, `Published ${surveyId} MOC coverage from Assets.`),
      surveyId,
      modalities: [...new Set(layers.map((layer) => layer.product.modality ?? "catalog"))],
      wavelengths: ["multi-band"],
      productTypes: ["native-MOC"],
      facilities: [text(first.product.publicSurvey?.mission, "Assets MOC publication")],
      coverageAuthorities: [...new Set(layers.map((layer) => sourceTierAuthority(layer.product.sourceTier ?? "third_party_moc")))].sort(),
      accessModes: deriveAccessModes(sources),
      releases,
      releaseLabels,
      sources,
      version: packageVersion,
      archiveUrl: `/api/v1/assets/${dynamicResourcePackageAssetId({ id: packageId, version: packageVersion })}/download`,
      sizeBytes: archiveBytes.length,
      sha256: archiveSha,
      updatedAt: latest,
      hidden: false,
      deprecated: false,
      replacedBy: [],
      archivePath: path.relative(this.contentRoot, packagePath).split(path.sep).join("/"),
      ...(this.#snapshotSink?.enqueueFile ? { objectKey: stateSnapshotFileKey("resource-packages", archiveSha) } : {}),
      contentFingerprint: fingerprint,
    };
    for (const previous of this.#entries.values()) {
      if (previous.surveyId !== surveyId || previous.deprecated) continue;
      previous.deprecated = true;
      previous.replacedBy = [...new Set([...previous.replacedBy, packageId])];
    }
    this.#entries.set(entryKey, entry);
    return entry;
  }

  private async persist(): Promise<void> {
    await mkdir(this.contentRoot, { recursive: true });
    const target = this.file();
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const state = { schemaVersion: STORE_SCHEMA_VERSION, packages: [...this.#entries.values()] };
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    await queueStateSnapshot(this.#snapshotSink, "resource-packages", state);
  }
}
