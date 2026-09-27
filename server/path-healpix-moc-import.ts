import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { AdminHttpError } from "./admin.js";
import { assertPublicCoverageOrder } from "./coverage-policy.js";
import { decodeNativeMoc, projectMoc, sha256 } from "./native-moc.js";
import { MocBuildService, MocBuildStore, safeMocName, type MocBuildOutput } from "./moc-build.js";
import { ProductStore } from "./products.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const SOURCE_PATTERN = /^redrock-main-bright-(\d+)\.fits(?:\.gz)?$/;

interface LockedFile { label: string; ref: string; sha256: string; sizeBytes: number; }

interface PathHealpixImport {
  buildName: string;
  layerId: string;
  productId: string;
  source: { url: string; snapshotRef: string; snapshotSha256: string; sizeBytes: number };
  inputEvidence: LockedFile[];
  outputs: { moc: LockedFile; query: LockedFile; preview: LockedFile; statistics: LockedFile; manifest: LockedFile };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminHttpError(400, `${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new AdminHttpError(400, `${field} is invalid`);
  return value.trim();
}

function lockedFile(value: unknown, field: string): LockedFile {
  const item = object(value, field);
  const label = text(item.label, `${field}.label`, 200);
  const ref = text(item.ref, `${field}.ref`, 2048);
  const digest = text(item.sha256, `${field}.sha256`, 64);
  const sizeBytes = item.sizeBytes;
  if (!SHA256.test(digest) || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0 || Number(sizeBytes) > MAX_EVIDENCE_BYTES) throw new AdminHttpError(400, `${field} has an invalid SHA-256 or size`);
  return { label, ref, sha256: digest, sizeBytes: Number(sizeBytes) };
}

function parseRequest(value: unknown): PathHealpixImport {
  const input = object(value, "request");
  const allowed = new Set(["buildName", "layerId", "productId", "source", "inputEvidence", "outputs"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new AdminHttpError(400, "Path HEALPix evidence request contains unsupported fields");
  const buildName = text(input.buildName, "buildName", 63);
  if (safeMocName(buildName) !== buildName) throw new AdminHttpError(400, "buildName must be lowercase letters, digits, and hyphens");
  const layerId = text(input.layerId, "layerId", 63);
  const productId = text(input.productId, "productId", 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(layerId)) throw new AdminHttpError(400, "layerId is invalid");

  const sourceInput = object(input.source, "source");
  const snapshotSha256 = text(sourceInput.snapshotSha256, "source.snapshotSha256", 64);
  const sizeBytes = sourceInput.sizeBytes;
  if (!SHA256.test(snapshotSha256) || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0 || Number(sizeBytes) > MAX_EVIDENCE_BYTES) throw new AdminHttpError(400, "source snapshot has an invalid SHA-256 or size");
  let sourceUrl: URL;
  try { sourceUrl = new URL(text(sourceInput.url, "source.url", 2048)); } catch { throw new AdminHttpError(400, "source.url is invalid"); }
  if (!/^https?:$/.test(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password) throw new AdminHttpError(400, "source.url must be a public HTTP or HTTPS URL");

  if (!Array.isArray(input.inputEvidence) || input.inputEvidence.length < 3 || input.inputEvidence.length > 16) throw new AdminHttpError(400, "inputEvidence must contain 3 to 16 locked files");
  const inputEvidence = input.inputEvidence.map((entry, index) => lockedFile(entry, `inputEvidence[${index}]`));
  if (new Set(inputEvidence.map((entry) => entry.ref)).size !== inputEvidence.length) throw new AdminHttpError(400, "inputEvidence refs must be unique");
  const outputsInput = object(input.outputs, "outputs");
  const outputs = {
    moc: lockedFile(outputsInput.moc, "outputs.moc"),
    query: lockedFile(outputsInput.query, "outputs.query"),
    preview: lockedFile(outputsInput.preview, "outputs.preview"),
    statistics: lockedFile(outputsInput.statistics, "outputs.statistics"),
    manifest: lockedFile(outputsInput.manifest, "outputs.manifest"),
  };
  return {
    buildName, layerId, productId,
    source: { url: sourceUrl.href, snapshotRef: text(sourceInput.snapshotRef, "source.snapshotRef", 2048), snapshotSha256, sizeBytes: Number(sizeBytes) },
    inputEvidence,
    outputs,
  };
}

function evidencePath(root: string, ref: string): string {
  if (!ref || ref.includes("\\") || path.posix.isAbsolute(ref) || ref.split("/").some((part) => !part || part === "." || part === "..")) throw new AdminHttpError(400, "Evidence refs must be safe relative paths");
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, ...ref.split("/"));
  const relative = path.relative(resolvedRoot, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new AdminHttpError(400, "Evidence ref escapes the evidence root");
  return absolute;
}

async function readLocked(root: string, file: LockedFile): Promise<Buffer> {
  const rootReal = await realpath(root);
  const absolute = evidencePath(rootReal, file.ref);
  try {
    const actual = await realpath(absolute);
    const relative = path.relative(rootReal, actual);
    const info = await lstat(actual);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes) throw new Error("type or size mismatch");
    const bytes = await readFile(actual);
    if (sha256(bytes) !== file.sha256) throw new Error("SHA-256 mismatch");
    return bytes;
  } catch {
    throw new AdminHttpError(409, `Locked evidence is missing or changed: ${file.label}`);
  }
}

function parseJson(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return object(parsed, label);
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw new AdminHttpError(409, `${label} is not valid JSON`);
  }
}

function assertProjection(value: Record<string, unknown>, label: string, order: number, expected: readonly number[]): number[] {
  const pixels = value.pixels;
  if (value.order !== order || value.ordering !== "NESTED" || !Array.isArray(pixels)
    || pixels.some((pixel) => !Number.isSafeInteger(pixel) || Number(pixel) < 0 || Number(pixel) >= 12 * 4 ** order)) {
    throw new AdminHttpError(409, `${label} has invalid NESTED order/pixel data`);
  }
  const normalized = [...new Set(pixels as number[])].sort((left, right) => left - right);
  if (normalized.length !== expected.length || normalized.some((pixel, index) => pixel !== expected[index])) throw new AdminHttpError(409, `${label} does not match the decoded native MOC`);
  return normalized;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourcePathRecord(value: unknown, expectedPrefix: string, groupSize: number): { uri: string; order: number; ipix: number } {
  const entry = object(value, "source manifest file");
  const uri = text(entry.uri, "source manifest URI", 2048);
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new AdminHttpError(409, "Source manifest contains an invalid file URI"); }
  if (parsed.protocol !== "oss:" || parsed.username || parsed.password || !uri.startsWith(expectedPrefix)) throw new AdminHttpError(409, "Source manifest file is outside the locked OSS prefix");
  const segments = parsed.pathname.split("/").filter(Boolean);
  const prefixSegments = new URL(expectedPrefix).pathname.split("/").filter(Boolean);
  if (segments.length !== prefixSegments.length + 3 || prefixSegments.some((segment, index) => segments[index] !== segment)) throw new AdminHttpError(409, "Source manifest path does not match the locked group/pixel layout");
  const group = Number(segments.at(-3));
  const ipix = Number(segments.at(-2));
  const filename = decodeURIComponent(segments.at(-1)!);
  const match = SOURCE_PATTERN.exec(filename);
  if (!match || Number(match[1]) !== ipix || !Number.isSafeInteger(group) || group !== Math.floor(ipix / groupSize)) throw new AdminHttpError(409, "Source file name or group directory does not match its order-6 pixel");
  if (entry.order !== 6 || entry.ipix !== ipix || entry.group !== group || !Number.isSafeInteger(entry.sizeBytes) || Number(entry.sizeBytes) < 0) throw new AdminHttpError(409, "Source manifest HEALPix metadata is inconsistent");
  return { uri, order: 6, ipix };
}

export async function registerPathHealpixMoc(options: {
  evidenceRoot: string;
  products: ProductStore;
  builds: MocBuildStore;
  buildService: MocBuildService;
}, value: unknown): Promise<{ request: ReturnType<MocBuildStore["get"]>; product: ReturnType<ProductStore["get"]> }> {
  const input = parseRequest(value);
  const product = options.products.get(input.productId);
  const content = product.draft;
  if (content.layerId !== input.layerId || content.surveyId !== "desi" || content.releaseId !== "desi-dr1"
    || content.modality !== "redshift" || content.mode !== "path-healpix"
    || content.scanDefaults?.includePattern !== "redrock-main-bright-*.fits*"
    || content.scanDefaults.pathHealpixOrder !== 6 || content.scanDefaults.pathHealpixGroupSize !== 100) {
    throw new AdminHttpError(409, "Selected product is not the locked DESI DR1 bright redrock path-HEALPix product");
  }
  const coverageEvidence = content.coverageEvidence;
  if (!coverageEvidence || coverageEvidence.evidenceKind !== "published-moc" || coverageEvidence.precision !== "exact"
    || coverageEvidence.completeness !== "incomplete" || coverageEvidence.scienceFileScan !== "partial") {
    throw new AdminHttpError(409, "Product draft must declare exact partial redrock file-to-cell coverage evidence before import");
  }

  const sourceSnapshot: LockedFile = {
    label: "DESI path-HEALPix input manifest",
    ref: input.source.snapshotRef,
    sha256: input.source.snapshotSha256,
    sizeBytes: input.source.sizeBytes,
  };
  const sourceBytes = await readLocked(options.evidenceRoot, sourceSnapshot);
  const evidenceBytes = new Map<string, Buffer>();
  for (const file of input.inputEvidence) evidenceBytes.set(file.ref, await readLocked(options.evidenceRoot, file));
  const sourceManifestFile = input.inputEvidence.find((file) => file.ref.endsWith("source-manifest.json"));
  const cellsFile = input.inputEvidence.find((file) => file.ref.endsWith("path-healpix-cells-order6.json"));
  const recipeFile = input.inputEvidence.find((file) => file.ref.endsWith("recipe.lock.json"));
  const scanReceiptFile = input.inputEvidence.find((file) => file.ref.endsWith("warehouse-scan-receipt.json"));
  const coverageEvidenceFile = input.inputEvidence.find((file) => file.ref.endsWith("coverage-evidence.json"));
  const provenanceFile = input.inputEvidence.find((file) => file.ref.endsWith("provenance.json"));
  if (!sourceManifestFile || !cellsFile || !recipeFile || !scanReceiptFile || !coverageEvidenceFile || !provenanceFile) {
    throw new AdminHttpError(400, "inputEvidence must include source-manifest.json, path-healpix-cells-order6.json, recipe.lock.json, warehouse-scan-receipt.json, coverage-evidence.json, and provenance.json");
  }

  const manifest = parseJson(sourceBytes, "DESI path-HEALPix input manifest");
  const sourceRecord = object(manifest.sourceManifest, "input manifest sourceManifest");
  const cellsRecord = object(manifest.pathCells, "input manifest pathCells");
  const scan = object(manifest.scan, "input manifest scan");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "desi-path-healpix-input-manifest"
    || manifest.layerId !== input.layerId || manifest.productId !== input.productId
    || manifest.surveyId !== "desi" || manifest.releaseId !== "desi-dr1" || manifest.modality !== "redshift"
    || manifest.coordinateFrame !== "ICRS" || manifest.ordering !== "NESTED" || manifest.completeness !== "incomplete"
    || sourceRecord.ref !== sourceManifestFile.ref.split("/").at(-1) || sourceRecord.sha256 !== sourceManifestFile.sha256 || sourceRecord.sizeBytes !== sourceManifestFile.sizeBytes
    || cellsRecord.ref !== cellsFile.ref.split("/").at(-1) || cellsRecord.sha256 !== cellsFile.sha256 || cellsRecord.sizeBytes !== cellsFile.sizeBytes
    || manifest.recipeRef !== recipeFile.ref.split("/").at(-1)
    || scan.batchId !== "desi-dr1-redrock-bright-user-oss-20260927-r1" || scan.phase !== "SUCCEEDED"
    || scan.order !== 6 || scan.groupSize !== 100 || scan.expectedPartitions !== 228 || scan.completedPartitions !== 228 || scan.failedPartitions !== 0
    || scan.scanRunCount !== 228 || scan.sourceSnapshotCount !== 228 || scan.fileCount !== 904 || scan.coverageCount !== 904
    || !SHA256.test(String(scan.rosterSha256 ?? "")) || !SHA256.test(String(scan.scopeSnapshotSha256 ?? ""))) {
    throw new AdminHttpError(409, "Input manifest does not bind the successful, partial DESI DR1 redrock scan scope");
  }
  if (coverageEvidence.sourceSnapshotSha256 !== scan.scopeSnapshotSha256) throw new AdminHttpError(409, "Product coverage evidence does not match the Warehouse scope snapshot");

  const sourceManifest = parseJson(evidenceBytes.get(sourceManifestFile.ref)!, "DESI source manifest");
  const sourcePrefix = text(manifest.sourcePrefix, "input manifest sourcePrefix", 1024);
  const rawFiles = sourceManifest.files;
  if (!Array.isArray(rawFiles) || rawFiles.length !== 904) throw new AdminHttpError(409, "Source manifest must contain exactly the frozen 904 redrock files");
  const sourceFiles = rawFiles.map((file) => sourcePathRecord(file, sourcePrefix, 100));
  const sourceUris = new Set(sourceFiles.map((file) => file.uri));
  const sourceCells = [...new Set(sourceFiles.map((file) => file.ipix))].sort((left, right) => left - right);
  if (sourceUris.size !== sourceFiles.length || sourceCells.length !== sourceFiles.length) throw new AdminHttpError(409, "Source manifest contains duplicate files or HEALPix cells");

  const cells = parseJson(evidenceBytes.get(cellsFile.ref)!, "order-6 path HEALPix cell set");
  const rawCells = cells.cells;
  if (cells.order !== 6 || cells.ordering !== "NESTED" || !Array.isArray(rawCells)
    || rawCells.some((cell) => !Number.isSafeInteger(cell) || Number(cell) < 0 || Number(cell) >= 12 * 4 ** 6)) {
    throw new AdminHttpError(409, "Path HEALPix cells must be valid ICRS/NESTED order-6 pixels");
  }
  const cellPixels = [...new Set(rawCells as number[])].sort((left, right) => left - right);
  if (!sameNumbers(cellPixels, sourceCells) || cellsRecord.cellCount !== sourceCells.length) throw new AdminHttpError(409, "Path HEALPix cells do not exactly match the source file roster");

  const recipe = parseJson(evidenceBytes.get(recipeFile.ref)!, "path-HEALPix recipe lock");
  const recipeDetails = object(recipe.recipe, "recipe lock recipe");
  const recipeSnapshot = object(recipe.snapshot, "recipe lock snapshot");
  const outputLocks = object(recipe.outputs, "recipe lock outputs");
  if (recipe.schemaVersion !== 1 || recipe.kind !== "coverage-recipe-lock" || recipe.layerId !== input.layerId
    || recipe.mode !== "path-healpix" || recipe.coordinateFrame !== "ICRS" || recipe.ordering !== "NESTED"
    || recipe.sourceOrder !== 6 || recipe.queryOrder !== 6 || recipe.overviewOrder !== 4 || recipe.previewOrder !== 4
    || recipe.maxOrder !== 6 || recipeDetails.groupSize !== 100 || recipeDetails.scanBatchId !== scan.batchId
    || recipeDetails.rosterSha256 !== scan.rosterSha256 || recipeDetails.scopeSnapshotSha256 !== scan.scopeSnapshotSha256
    || recipeSnapshot.sourceManifestSha256 !== sourceManifestFile.sha256 || recipeSnapshot.pathCellsSha256 !== cellsFile.sha256
    || recipeSnapshot.sourceManifestSizeBytes !== sourceManifestFile.sizeBytes || recipeSnapshot.pathCellsSizeBytes !== cellsFile.sizeBytes
    || recipeDetails.precision !== "exact" || typeof recipeDetails.precisionJustification !== "string"
    || !object(outputLocks.moc, "recipe output MOC").precision || !object(outputLocks.query, "recipe output query").precision
    || !object(outputLocks.preview, "recipe output preview").precision || !object(outputLocks.statistics, "recipe output statistics").precision) {
    throw new AdminHttpError(409, "Recipe lock does not match the frozen order-6 path-index inputs");
  }

  const scanReceipt = parseJson(evidenceBytes.get(scanReceiptFile.ref)!, "Warehouse scan receipt");
  const receiptPartitions = scanReceipt.partitions;
  const receiptRows = Array.isArray(receiptPartitions) ? receiptPartitions.map((partition) => object(partition, "Warehouse scan partition")) : [];
  const scanRunIds = receiptRows.map((partition) => text(partition.scanRunId, "Warehouse scan run ID", 256)).sort();
  const declaredRunIds = Array.isArray(scan.scanRunIds)
    ? scan.scanRunIds.filter((runId): runId is string => typeof runId === "string").sort()
    : [];
  const receiptPartitionIds = receiptRows.map((partition) => text(partition.partitionId, "Warehouse partition ID", 256));
  const receiptLayerIds = receiptRows.map((partition) => text(partition.indexedLayerId, "Warehouse indexed layer ID", 256));
  let receiptFiles = 0;
  let receiptCoverage = 0;
  let receiptErrors = 0;
  for (const partition of receiptRows) {
    const snapshotSha256 = text(partition.sourceSnapshotSha256, "Warehouse source snapshot SHA-256", 64);
    const fileCount = partition.fileCount;
    const coverageCount = partition.coverageCount;
    const errorCount = partition.errorCount;
    if (!SHA256.test(snapshotSha256) || !Number.isSafeInteger(fileCount) || Number(fileCount) < 0
      || !Number.isSafeInteger(coverageCount) || Number(coverageCount) < 0
      || !Number.isSafeInteger(errorCount) || Number(errorCount) < 0) {
      throw new AdminHttpError(409, "Warehouse scan receipt contains invalid partition counts or snapshot hashes");
    }
    receiptFiles += Number(fileCount);
    receiptCoverage += Number(coverageCount);
    receiptErrors += Number(errorCount);
  }
  if (scanReceipt.schemaVersion !== 1 || scanReceipt.kind !== "desi-path-healpix-warehouse-scan-receipt"
    || scanReceipt.batchId !== scan.batchId || scanReceipt.scopeId !== scan.scopeId
    || scanReceipt.scopeSnapshotSha256 !== scan.scopeSnapshotSha256 || scanReceipt.rosterSha256 !== scan.rosterSha256
    || scanReceipt.evidenceLayerId !== `assets-batch-${input.productId}`
    || scanReceipt.expectedPartitions !== 228 || scanReceipt.committedPartitions !== 228
    || scanReceipt.scanRunCount !== 228 || scanReceipt.sourceSnapshotCount !== 228
    || scanReceipt.fileCount !== 904 || scanReceipt.coverageCount !== 904 || scanReceipt.errorCount !== 0
    || scanRunIds.length !== 228 || new Set(scanRunIds).size !== 228
    || receiptPartitionIds.length !== 228 || new Set(receiptPartitionIds).size !== 228
    || receiptLayerIds.length !== 228 || new Set(receiptLayerIds).size !== 228
    || receiptFiles !== 904 || receiptCoverage !== 904 || receiptErrors !== 0
    || declaredRunIds.length !== 228 || !sameStrings(scanRunIds, declaredRunIds)) {
    throw new AdminHttpError(409, "Warehouse scan receipt does not bind all committed runs in the frozen scope");
  }

  const mocBytes = await readLocked(options.evidenceRoot, input.outputs.moc);
  const moc = decodeNativeMoc(mocBytes);
  assertPublicCoverageOrder(moc.maxOrder);
  if (moc.maxOrder !== 6 || moc.availableOrders.some((order) => order > 6)
    || !Array.isArray(recipe.availableOrders) || !sameNumbers(recipe.availableOrders as number[], moc.availableOrders)) {
    throw new AdminHttpError(409, "Native MOC and recipe lock must preserve the actual source orders through order 6");
  }
  const expectedQuery = projectMoc(moc, 6).cells;
  if (!sameNumbers(expectedQuery, sourceCells)) throw new AdminHttpError(409, "Native MOC does not represent the exact scanned order-6 file cells");
  const queryBytes = await readLocked(options.evidenceRoot, input.outputs.query);
  const previewBytes = await readLocked(options.evidenceRoot, input.outputs.preview);
  const statisticsBytes = await readLocked(options.evidenceRoot, input.outputs.statistics);
  const provenanceBytes = await readLocked(options.evidenceRoot, input.outputs.manifest);
  const query = parseJson(queryBytes, "order-6 query projection");
  const preview = parseJson(previewBytes, "order-4 preview projection");
  const queryPixels = assertProjection(query, "Query projection", 6, expectedQuery);
  const expectedPreview = projectMoc(moc, 4).cells;
  const previewPixels = assertProjection(preview, "Preview projection", 4, expectedPreview);
  const statistics = parseJson(statisticsBytes, "MOC statistics");
  if (statistics.schemaVersion !== 1 || statistics.maxOrder !== 6 || statistics.cellCount !== moc.cells.length
    || statistics.mocSha256 !== input.outputs.moc.sha256 || statistics.queryPixelCount !== queryPixels.length
    || statistics.previewPixelCount !== previewPixels.length || !Array.isArray(statistics.availableOrders)
    || !sameNumbers(statistics.availableOrders as number[], moc.availableOrders)) {
    throw new AdminHttpError(409, "MOC statistics do not match the native order and exact projections");
  }
  const provenance = parseJson(provenanceBytes, "MOC provenance");
  const provenanceScan = object(provenance.scan, "MOC provenance scan");
  const provenanceInputs = object(provenance.inputs, "MOC provenance inputs");
  const provenanceOutputs = object(provenance.outputs, "MOC provenance outputs");
  if (provenance.schemaVersion !== 1 || provenance.kind !== "path-healpix-moc-provenance"
    || provenance.layerId !== input.layerId || provenance.coordinateFrame !== "ICRS" || provenance.ordering !== "NESTED"
    || provenance.maxOrder !== 6 || provenance.queryOrder !== 6 || provenance.previewOrder !== 4
    || provenance.precision !== "exact" || provenanceInputs.inputManifestSha256 !== input.source.snapshotSha256
    || provenanceInputs.sourceManifestSha256 !== sourceManifestFile.sha256 || provenanceInputs.pathCellsSha256 !== cellsFile.sha256
    || provenanceScan.rosterSha256 !== scan.rosterSha256 || provenanceScan.scopeSnapshotSha256 !== scan.scopeSnapshotSha256
    || provenanceScan.batchId !== scan.batchId) {
    throw new AdminHttpError(409, "MOC provenance does not match the locked scan and recipe inputs");
  }
  for (const [name, file] of Object.entries({ moc: input.outputs.moc, query: input.outputs.query, preview: input.outputs.preview, statistics: input.outputs.statistics })) {
    const actual = object(provenanceOutputs[name], `MOC provenance ${name}`);
    if (actual.ref !== file.ref.split("/").at(-1) || actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes) throw new AdminHttpError(409, `MOC provenance does not lock ${name}`);
  }

  for (const [name, file] of Object.entries({
    moc: input.outputs.moc,
    query: input.outputs.query,
    preview: input.outputs.preview,
    statistics: input.outputs.statistics,
    manifest: input.outputs.manifest,
  })) {
    const lockedOutput = object(outputLocks[name], `recipe lock output ${name}`);
    if (lockedOutput.sha256 !== file.sha256 || lockedOutput.sizeBytes !== file.sizeBytes
      || typeof lockedOutput.precision !== "string") {
      throw new AdminHttpError(409, `Recipe lock output ${name} does not match the imported bytes`);
    }
  }

  const coverageDocument = parseJson(evidenceBytes.get(coverageEvidenceFile.ref)!, "Coverage evidence contract");
  const coverageOutputs = object(coverageDocument.outputs, "Coverage evidence outputs");
  const coverageSnapshot = object(coverageDocument.sourceSnapshot, "Coverage evidence source snapshot");
  const coverageScanRunIds = coverageDocument.scanRunIds;
  const coverageRunIds = Array.isArray(coverageScanRunIds)
    ? coverageScanRunIds.filter((runId): runId is string => typeof runId === "string").sort()
    : [];
  if (coverageDocument.schemaVersion !== 1 || coverageDocument.layerId !== input.layerId
    || coverageDocument.productId !== input.productId || coverageDocument.surveyId !== "desi"
    || coverageDocument.releaseId !== "desi-dr1" || coverageDocument.coordinateFrame !== "ICRS"
    || coverageDocument.ordering !== "NESTED" || coverageDocument.maxOrder !== 6
    || coverageDocument.overviewOrder !== 4 || coverageDocument.scanBatchId !== scan.batchId
    || coverageSnapshot.uri !== `warehouse-scan-scope:${scan.scopeId}`
    || coverageSnapshot.sha256 !== scan.scopeSnapshotSha256
    || !sameStrings(coverageRunIds, scanRunIds)) {
    throw new AdminHttpError(409, "Coverage evidence contract does not bind the DESI order-6 scan batch");
  }
  const coverageOutputFiles = {
    moc: input.outputs.moc,
    query: input.outputs.query,
    preview: input.outputs.preview,
    statistics: input.outputs.statistics,
    manifest: input.outputs.manifest,
    provenance: provenanceFile,
  };
  for (const [name, file] of Object.entries(coverageOutputFiles)) {
    const actual = object(coverageOutputs[name], `Coverage evidence output ${name}`);
    if (actual.uri !== file.ref.split("/").at(-1) || actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes) {
      throw new AdminHttpError(409, `Coverage evidence does not lock ${name}`);
    }
  }
  if (!Array.isArray(coverageDocument.availableOrders)
    || !sameNumbers(coverageDocument.availableOrders as number[], moc.availableOrders)) {
    throw new AdminHttpError(409, "Coverage evidence available orders do not match the native MOC");
  }

  const additionalProvenance = parseJson(evidenceBytes.get(provenanceFile.ref)!, "Path-HEALPix provenance");
  const provenanceManifest = object(additionalProvenance.buildManifest, "Path-HEALPix provenance build manifest");
  const provenanceRecipe = object(additionalProvenance.recipe, "Path-HEALPix provenance recipe");
  const provenanceReceipt = object(additionalProvenance.scanReceipt, "Path-HEALPix provenance scan receipt");
  const provenanceInput = object(additionalProvenance.inputManifest, "Path-HEALPix provenance input manifest");
  if (additionalProvenance.schemaVersion !== 1 || additionalProvenance.kind !== "path-healpix-provenance"
    || provenanceManifest.ref !== input.outputs.manifest.ref.split("/").at(-1)
    || provenanceManifest.sha256 !== input.outputs.manifest.sha256
    || provenanceRecipe.ref !== recipeFile.ref.split("/").at(-1) || provenanceRecipe.sha256 !== recipeFile.sha256
    || provenanceReceipt.ref !== scanReceiptFile.ref.split("/").at(-1) || provenanceReceipt.sha256 !== scanReceiptFile.sha256
    || provenanceInput.ref !== input.source.snapshotRef || provenanceInput.sha256 !== input.source.snapshotSha256) {
    throw new AdminHttpError(409, "Additional path-HEALPix provenance does not match the locked evidence");
  }

  const stageName = safeMocName(input.buildName);
  const stageDirectory = path.posix.join("moc-build", stageName);
  const rootReal = await realpath(options.evidenceRoot);
  const stageRoot = evidencePath(rootReal, stageDirectory);
  await mkdir(stageRoot, { recursive: true });
  for (const directory of [path.dirname(stageRoot), stageRoot]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AdminHttpError(409, "MOC evidence stage path must contain only real directories");
  }
  const outputInputs = [
    ["moc.fits", input.outputs.moc],
    ["query-order6.json", input.outputs.query],
    ["preview-order4.json", input.outputs.preview],
    ["statistics.json", input.outputs.statistics],
    ["build-manifest.json", input.outputs.manifest],
  ] as const;
  const staged: Record<string, { ref: string; sha256: string; sizeBytes: number; order?: number }> = {};
  for (const [filename, file] of outputInputs) {
    const bytes = filename === "moc.fits" ? mocBytes
      : filename === "query-order6.json" ? queryBytes
        : filename === "preview-order4.json" ? previewBytes
          : filename === "statistics.json" ? statisticsBytes
            : provenanceBytes;
    const absolute = evidencePath(rootReal, path.posix.join(stageDirectory, filename));
    try { await writeFile(absolute, bytes, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new AdminHttpError(409, `Unable to stage MOC output ${filename}`);
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length || sha256(await readFile(absolute)) !== sha256(bytes)) throw new AdminHttpError(409, `Immutable MOC build output conflicts: ${filename}`);
    }
    staged[filename] = { ref: path.posix.join(stageDirectory, filename), sha256: sha256(bytes), sizeBytes: bytes.length,
      ...(filename.startsWith("query-order") ? { order: 6 } : filename.startsWith("preview-order") ? { order: 4 } : {}) };
    if (file.sha256 !== sha256(bytes) || file.sizeBytes !== bytes.length) throw new AdminHttpError(409, `Staged ${filename} differs from its locked source`);
  }

  const outputFile = (filename: string, order?: number) => ({ ref: staged[filename]!.ref, sha256: staged[filename]!.sha256, sizeBytes: staged[filename]!.sizeBytes, ...(order !== undefined ? { order } : {}) });
  const build = await options.builds.createVerifiedEvidenceBuild({
    name: input.buildName,
    layerId: input.layerId,
    candidateId: String(scan.scopeId),
    candidateTitle: "DESI DR1 bright redrock order-6 file index",
    surveyId: content.surveyId,
    releaseId: content.releaseId,
    productId: input.productId,
    source: {
      url: input.source.url,
      snapshotSha256: sourceSnapshot.sha256,
      sizeBytes: sourceSnapshot.sizeBytes,
      evidenceRef: sourceSnapshot.ref,
      evidenceInputs: input.inputEvidence,
      sourceEvidence: coverageEvidence,
    },
    outputs: {
      moc: outputFile("moc.fits"),
      query: outputFile("query-order6.json", 6) as MocBuildOutput["query"],
      preview: outputFile("preview-order4.json", 4) as MocBuildOutput["preview"],
      statistics: outputFile("statistics.json"),
      manifest: outputFile("build-manifest.json"),
      cellCount: moc.cells.length,
      availableOrders: moc.availableOrders,
      maxOrder: moc.maxOrder,
    },
  });
  await options.buildService.verifyOutputs(build.name);
  return { request: build, product };
}
