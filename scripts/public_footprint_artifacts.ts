import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.ASSET_WORKTREE_ROOT ?? process.cwd());
const artifactRoot = path.join(root, "artifacts", "public-survey-footprints");
const SHA256 = /^[a-f0-9]{64}$/;
const STATUSES = new Set(["acquired", "overview_only", "awaiting_geometry", "not_applicable"]);

interface FileRecord { path: string; sha256: string; sizeBytes?: number }
interface SourceProduct {
  product: string;
  status: string;
  sourceUrl: string;
  geometrySourceUrl?: string;
  reason?: string;
  manualStep?: string;
}
interface SourceRelease { surveyId: string; releaseId: string; products: SourceProduct[] }
interface Footprint { surveyId: string; releaseId: string; product: string; nside: number; pixels: number[]; quality: string; sourceUrl: string }

export interface PublicFootprintStatistics {
  releases: number;
  products: number;
  acquired: number;
  overview_only: number;
  awaiting_geometry: number;
  not_applicable: number;
  generatedLayers: number;
}

async function json<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

function identity(surveyId: string, releaseId: string, product: string): string {
  return `${surveyId}:${releaseId}:${product}`;
}

function resolveArtifact(relativePath: string): string {
  const absolute = path.resolve(artifactRoot, relativePath);
  const relative = path.relative(artifactRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Artifact path escapes root: ${relativePath}`);
  return absolute;
}

async function verifyRecord(record: FileRecord, label: string, base = artifactRoot): Promise<void> {
  if (!record?.path || !SHA256.test(record.sha256)) throw new Error(`Invalid ${label} file record`);
  const filePath = path.resolve(base, record.path);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes Assets root`);
  const details = await stat(filePath);
  if (!details.isFile() || (record.sizeBytes !== undefined && details.size !== record.sizeBytes)) throw new Error(`${label} size mismatch`);
  if (await sha256(filePath) !== record.sha256) throw new Error(`${label} SHA-256 mismatch`);
}

function fitsCard(bytes: Buffer, keyword: string): string | undefined {
  for (let offset = 0; offset + 80 <= Math.min(bytes.length, 64 * 1024); offset += 80) {
    const card = bytes.toString("ascii", offset, offset + 80);
    if (card.slice(0, 8).trim() === keyword && card[8] === "=") return card.slice(10).split("/", 1)[0]?.trim().replace(/^'|'$/g, "").trim();
  }
  return undefined;
}

async function validateFitsMoc(filePath: string, expectedSha256: string): Promise<void> {
  const bytes = await readFile(filePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error(`Generated MOC SHA-256 mismatch: ${filePath}`);
  if (bytes.toString("ascii", 0, 8) !== "SIMPLE  ") throw new Error(`Generated MOC is not FITS: ${filePath}`);
  const header = bytes.subarray(bytes.indexOf(Buffer.from("XTENSION")));
  if (fitsCard(header, "ORDERING") !== "NUNIQ" || fitsCard(header, "COORDSYS") !== "C" || fitsCard(header, "MOCVERS") !== "2.0" || fitsCard(header, "MOCDIM") !== "SPACE") {
    throw new Error(`Generated MOC violates the ICRS/NUNIQ contract: ${filePath}`);
  }
}

export async function validate(): Promise<PublicFootprintStatistics> {
  const errors: string[] = [];
  const surveyCatalog = await json<{ schemaVersion: number; surveys: Array<{ id: string; releases: Array<{ id: string; products: Array<{ name: string; status: string }> }> }> }>(path.join(root, "src", "surveys", "survey-catalog.json"));
  const sources = await json<{ schemaVersion: number; releases: SourceRelease[] }>(path.join(artifactRoot, "sources.json"));
  const manifest = await json<{ schemaVersion: number; coordinateFrame: string; nside: number; footprints: Footprint[] }>(path.join(root, "src", "footprints", "survey-footprints.json"));
  if (surveyCatalog.schemaVersion !== 1 || sources.schemaVersion !== 2 || manifest.schemaVersion !== 1 || manifest.coordinateFrame !== "ICRS" || manifest.nside !== 16) errors.push("Unsupported public metadata schema");

  const registered = new Map<string, { status: string }>();
  for (const survey of surveyCatalog.surveys ?? []) for (const release of survey.releases ?? []) for (const product of release.products ?? []) {
    const key = identity(survey.id, release.id, product.name);
    if (registered.has(key)) errors.push(`Duplicate survey catalog product: ${key}`);
    registered.set(key, product);
  }
  const sourceProducts = new Map<string, SourceProduct>();
  for (const release of sources.releases ?? []) for (const product of release.products ?? []) {
    const key = identity(release.surveyId, release.releaseId, product.product);
    if (sourceProducts.has(key)) errors.push(`Duplicate source product: ${key}`);
    sourceProducts.set(key, product);
    if (!registered.has(key)) errors.push(`Source product is not registered: ${key}`);
    if (!STATUSES.has(product.status) || !validUrl(product.sourceUrl)) errors.push(`Invalid source product: ${key}`);
    if (product.geometrySourceUrl !== undefined && !validUrl(product.geometrySourceUrl)) errors.push(`Invalid geometry URL: ${key}`);
    if (product.status === "acquired" && (!product.geometrySourceUrl || product.reason || product.manualStep)) errors.push(`Invalid acquired source: ${key}`);
    if (product.status !== "acquired" && !product.reason?.trim()) errors.push(`Incomplete source lacks reason: ${key}`);
    if (["overview_only", "awaiting_geometry"].includes(product.status) && !product.manualStep?.trim()) errors.push(`Incomplete source lacks manual step: ${key}`);
  }
  for (const key of registered.keys()) if (!sourceProducts.has(key)) errors.push(`Registered product lacks source status: ${key}`);

  const footprints = new Map<string, Footprint>();
  for (const footprint of manifest.footprints ?? []) {
    const key = identity(footprint.surveyId, footprint.releaseId, footprint.product);
    if (footprints.has(key)) errors.push(`Duplicate footprint: ${key}`);
    footprints.set(key, footprint);
    if (!sourceProducts.has(key) || !validUrl(footprint.sourceUrl) || footprint.nside !== 16 || !["moc", "official_overview"].includes(footprint.quality)) errors.push(`Invalid footprint: ${key}`);
    if (!Array.isArray(footprint.pixels) || !footprint.pixels.length || new Set(footprint.pixels).size !== footprint.pixels.length || footprint.pixels.some((pixel) => !Number.isInteger(pixel) || pixel < 0 || pixel >= 3072)) errors.push(`Invalid footprint pixels: ${key}`);
  }
  for (const [key, product] of sourceProducts) {
    if (product.status === "acquired" && footprints.get(key)?.quality !== "moc") errors.push(`Acquired source lacks MOC footprint: ${key}`);
    if (product.status === "overview_only" && footprints.get(key)?.quality === "moc") errors.push(`Overview source claims exact MOC: ${key}`);
  }

  const provenance = await json<{ inputs: Record<string, FileRecord>; files: { manifest: FileRecord; catalog: FileRecord; packages: Array<{ id: string; version: string; archive: string; sizeBytes: number; sha256: string }> } }>(path.join(artifactRoot, "provenance.json"));
  for (const [name, record] of Object.entries(provenance.inputs ?? {})) {
    try { await verifyRecord(record, `provenance input ${name}`); } catch (error) { errors.push(String(error)); }
  }
  for (const [name, record] of Object.entries({ manifest: provenance.files?.manifest, catalog: provenance.files?.catalog })) {
    try { await verifyRecord(record, `provenance output ${name}`); } catch (error) { errors.push(String(error)); }
  }

  const packageCatalog = await json<{
    schemaVersion: number;
    version: string;
    packages: Array<{
      id: string;
      version: string;
      archiveUrl: string;
      sizeBytes: number;
      sha256: string;
      releases?: unknown;
      releaseLabels?: unknown;
      sources?: unknown;
    }>;
  }>(path.join(artifactRoot, "packages", "catalog.json"));
  if (packageCatalog.schemaVersion !== 3 || packageCatalog.version !== "3.0.0") errors.push("Active package catalog must be Resource Package v3 (3.0.0)");
  const provenancePackages = new Map((provenance.files?.packages ?? []).map((entry) => [`${entry.id}@${entry.version}`, entry]));
  for (const entry of packageCatalog.packages ?? []) {
    if (!Array.isArray(entry.releases) || entry.releases.length === 0 || !entry.releases.every((release) => typeof release === "string" && release.length > 0)) errors.push(`Package catalog releases are invalid: ${entry.id}`);
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) errors.push(`Package catalog sources are invalid: ${entry.id}`);
    if (!entry.releaseLabels || typeof entry.releaseLabels !== "object" || Array.isArray(entry.releaseLabels)) errors.push(`Package catalog release labels are invalid: ${entry.id}`);
    const record = provenancePackages.get(`${entry.id}@${entry.version}`);
    if (!record || record.sizeBytes !== entry.sizeBytes || record.sha256 !== entry.sha256) errors.push(`Package provenance mismatch: ${entry.id}@${entry.version}`);
    try { await verifyRecord({ path: entry.archiveUrl, sizeBytes: entry.sizeBytes, sha256: entry.sha256 }, `package ${entry.id}`, path.join(artifactRoot, "packages")); } catch (error) { errors.push(String(error)); }
  }

  for (const indexName of ["raw/moc/index.json", "raw/geometry/index.json"] as const) {
    const indexPath = path.join(artifactRoot, indexName);
    const index = await json<{ artifacts: Array<{ fitsPath?: string; metadataPath?: string; filePath?: string; byteLength: number; sha256: string }> }>(indexPath);
    for (const artifact of index.artifacts ?? []) {
      const fileName = artifact.fitsPath ?? artifact.filePath;
      if (!fileName || path.basename(fileName) !== fileName) { errors.push(`Invalid raw artifact path in ${indexName}`); continue; }
      try { await verifyRecord({ path: fileName, sizeBytes: artifact.byteLength, sha256: artifact.sha256 }, `raw artifact ${fileName}`, path.dirname(indexPath)); } catch (error) { errors.push(String(error)); }
      if (artifact.metadataPath) {
        try { await json(path.join(path.dirname(indexPath), artifact.metadataPath)); } catch { errors.push(`Invalid raw metadata: ${artifact.metadataPath}`); }
      }
    }
  }

  const registry = await json<{ schemaVersion: number; coreVersion: string; layers: Array<{ layerId: string; coverageRole: string; dataOrigin: string; sourceTier: string; maxOrder: number; status: string; recipePath?: string; artifactPath?: string; expectedSha256?: string; plannedMode?: string; sourceUrl?: string; geometrySourceUrl?: string; pendingReason?: string }> }>(path.join(root, "src", "layers", "layer-registry.json"));
  const plan = await json<{ schemaVersion: number; builds: Array<{ spec: string; output: string; expectedSha256: string }> }>(path.join(root, "src", "layers", "public-build-plan.json"));
  if (registry.schemaVersion !== 1 || plan.schemaVersion !== 1) errors.push("Unsupported layer registry/build plan");
  const layerIds = new Set<string>();
  const layerStatuses = new Set(["acquired", "frozen-review-exception", "awaiting_snapshot"]);
  for (const layer of registry.layers ?? []) {
    if (layerIds.has(layer.layerId)) errors.push(`Duplicate layerId: ${layer.layerId}`);
    layerIds.add(layer.layerId);
    if (!layerStatuses.has(layer.status)) errors.push(`Unsupported layer status: ${layer.layerId}`);
    if (layer.status === "awaiting_snapshot") {
      if (!layer.plannedMode || !["fits-wcs", "catalog-radec", "nested-healpix", "regions", "tile-table"].includes(layer.plannedMode)) errors.push(`Pending layer lacks a valid planned mode: ${layer.layerId}`);
      if (!validUrl(layer.sourceUrl) || !validUrl(layer.geometrySourceUrl)) errors.push(`Pending layer lacks official source URLs: ${layer.layerId}`);
      if (!layer.pendingReason?.trim()) errors.push(`Pending layer lacks a reason: ${layer.layerId}`);
      if (layer.artifactPath || layer.recipePath || layer.expectedSha256) errors.push(`Pending layer must not claim a generated artifact: ${layer.layerId}`);
    } else if (!layer.artifactPath || !SHA256.test(layer.expectedSha256 ?? "")) {
      errors.push(`Published layer lacks an artifact lock: ${layer.layerId}`);
    }
  }
  for (const build of plan.builds ?? []) {
    try {
      const spec = await json<{ layerId: string; snapshot: { sha256: string; sizeBytes: number }; input: string }>(path.join(root, build.spec));
      const outputRoot = path.join(root, build.output);
      const layer = registry.layers.find((entry) => entry.layerId === spec.layerId);
      if (!layer || layer.status !== "acquired") throw new Error(`Build plan layer is not acquired: ${spec.layerId}`);
      if (layer.recipePath !== build.spec || layer.artifactPath !== path.join(build.output, `${spec.layerId}.moc.fits`) || layer.expectedSha256 !== build.expectedSha256) throw new Error(`Layer registry lock mismatch: ${spec.layerId}`);
      await verifyRecord({ path: spec.input, ...spec.snapshot }, `locked input ${spec.layerId}`, root);
      await validateFitsMoc(path.join(outputRoot, `${spec.layerId}.moc.fits`), build.expectedSha256);
      const outputProvenance = await json<{ coreVersion: string; layerId: string; coverageRole: string; dataOrigin: string; sourceTier: string; outputs: { moc: FileRecord; query: FileRecord; preview: FileRecord; statistics: FileRecord } }>(path.join(outputRoot, "provenance.json"));
      if (outputProvenance.coreVersion !== registry.coreVersion || outputProvenance.layerId !== layer.layerId || outputProvenance.coverageRole !== layer.coverageRole || outputProvenance.dataOrigin !== layer.dataOrigin || outputProvenance.sourceTier !== layer.sourceTier || outputProvenance.outputs.moc.sha256 !== build.expectedSha256) throw new Error(`Generated layer provenance mismatch: ${spec.layerId}`);
      for (const [name, record] of Object.entries(outputProvenance.outputs)) await verifyRecord(record, `${spec.layerId} ${name}`, outputRoot);
    } catch (error) { errors.push(String(error)); }
  }

  const csstPath = path.join(artifactRoot, "csst", "csst-w1-image-extent-order8.fits");
  if (await sha256(csstPath) !== "caa6a5287efa0ba9abc406261d4e653730b062e49282ffc82549f7d2735dbf3c") errors.push("Frozen CSST MOC hash changed");
  const csstLayer = registry.layers.find((layer) => layer.layerId === "csst-sim-w1-image-extent");
  if (!csstLayer || csstLayer.coverageRole !== "image_extent" || csstLayer.dataOrigin !== "simulated" || csstLayer.sourceTier !== "user_file_derived" || csstLayer.maxOrder !== 8 || csstLayer.artifactPath !== "artifacts/public-survey-footprints/csst/csst-w1-image-extent-order8.fits" || csstLayer.expectedSha256 !== "caa6a5287efa0ba9abc406261d4e653730b062e49282ffc82549f7d2735dbf3c") errors.push("Frozen CSST classification changed");

  if (errors.length) throw new Error(`public footprint validation failed:\n${errors.join("\n")}`);
  const products = [...sourceProducts.values()];
  return {
    releases: sources.releases.length,
    products: products.length,
    acquired: products.filter((product) => product.status === "acquired").length,
    overview_only: products.filter((product) => product.status === "overview_only").length,
    awaiting_geometry: products.filter((product) => product.status === "awaiting_geometry").length,
    not_applicable: products.filter((product) => product.status === "not_applicable").length,
    generatedLayers: plan.builds.length,
  };
}

if (process.argv[1]?.endsWith("public_footprint_artifacts.ts")) {
  if (process.argv[2] !== "validate") throw new Error("Usage: public_footprint_artifacts.ts validate");
  const statistics = await validate();
  console.log(`Validated ${statistics.products} products and ${statistics.generatedLayers} offline Core layers`);
}
