import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { AdminHttpError } from "./admin.js";
import { assertPublicCoverageOrder } from "./coverage-policy.js";
import { decodeNativeMoc, projectMoc, sha256 } from "./native-moc.js";
import { MocBuildService, MocBuildStore, safeMocName, type MocBuildOutput, type MocBuildOutputFile } from "./moc-build.js";
import { ProductStore, type MocProductRegistrationInput } from "./products.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

interface LockedEvidenceFile { label: string; ref: string; sha256: string; sizeBytes: number; }
interface ImportInput {
  buildName: string;
  layerId: string;
  candidateId: string;
  candidateTitle: string;
  product: MocProductRegistrationInput;
  source: { url: string; snapshotRef: string; snapshotSha256: string; sizeBytes: number };
  inputEvidence: LockedEvidenceFile[];
  outputs: {
    moc: LockedEvidenceFile;
    query: LockedEvidenceFile;
    preview: LockedEvidenceFile;
    statistics: LockedEvidenceFile;
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminHttpError(400, `${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new AdminHttpError(400, `${field} is invalid`);
  return value.trim();
}

function lockedFile(value: unknown, field: string): LockedEvidenceFile {
  const item = record(value, field);
  const label = text(item.label, `${field}.label`, 200);
  const ref = text(item.ref, `${field}.ref`, 2048);
  const digest = text(item.sha256, `${field}.sha256`, 64);
  const sizeBytes = item.sizeBytes;
  if (!SHA256.test(digest) || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0 || Number(sizeBytes) > MAX_EVIDENCE_BYTES) throw new AdminHttpError(400, `${field} has an invalid SHA-256 or size`);
  return { label, ref, sha256: digest, sizeBytes: Number(sizeBytes) };
}

function parseInput(value: unknown): ImportInput {
  const input = record(value, "request");
  const allowed = new Set(["buildName", "layerId", "candidateId", "candidateTitle", "product", "source", "inputEvidence", "outputs"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new AdminHttpError(400, "Evidence MOC request contains unsupported fields");
  const buildName = text(input.buildName, "buildName", 63);
  if (safeMocName(buildName) !== buildName) throw new AdminHttpError(400, "buildName must be lowercase letters, digits, and hyphens");
  const layerId = text(input.layerId, "layerId", 63);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(layerId)) throw new AdminHttpError(400, "layerId is invalid");
  const candidateId = text(input.candidateId, "candidateId", 128);
  const candidateTitle = text(input.candidateTitle, "candidateTitle", 256);
  const product = record(input.product, "product") as unknown as MocProductRegistrationInput;
  const sourceInput = record(input.source, "source");
  const snapshotSha256 = text(sourceInput.snapshotSha256, "source.snapshotSha256", 64);
  const sizeBytes = sourceInput.sizeBytes;
  if (!SHA256.test(snapshotSha256) || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0 || Number(sizeBytes) > MAX_EVIDENCE_BYTES) throw new AdminHttpError(400, "source snapshot has an invalid SHA-256 or size");
  if (!Array.isArray(input.inputEvidence) || input.inputEvidence.length < 2 || input.inputEvidence.length > 16) throw new AdminHttpError(400, "inputEvidence must contain 2 to 16 locked files");
  const inputEvidence = input.inputEvidence.map((item, index) => lockedFile(item, `inputEvidence[${index}]`));
  if (new Set(inputEvidence.map((item) => item.ref)).size !== inputEvidence.length) throw new AdminHttpError(400, "inputEvidence refs must be unique");
  const outputsInput = record(input.outputs, "outputs");
  const outputs = {
    moc: lockedFile(outputsInput.moc, "outputs.moc"),
    query: lockedFile(outputsInput.query, "outputs.query"),
    preview: lockedFile(outputsInput.preview, "outputs.preview"),
    statistics: lockedFile(outputsInput.statistics, "outputs.statistics"),
  };
  return {
    buildName,
    layerId,
    candidateId,
    candidateTitle,
    product,
    source: {
      url: text(sourceInput.url, "source.url", 2048),
      snapshotRef: text(sourceInput.snapshotRef, "source.snapshotRef", 2048),
      snapshotSha256,
      sizeBytes: Number(sizeBytes),
    },
    inputEvidence,
    outputs,
  };
}

function within(root: string, ref: string): string {
  if (!ref || ref.includes("\\") || path.posix.isAbsolute(ref) || ref.split("/").some((part) => !part || part === "." || part === "..")) throw new AdminHttpError(400, "Evidence refs must be safe relative paths");
  const absolute = path.resolve(root, ref);
  const relative = path.relative(root, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new AdminHttpError(400, "Evidence ref escapes the evidence root");
  return absolute;
}

async function readLocked(root: string, file: LockedEvidenceFile): Promise<Buffer> {
  const rootReal = await realpath(root);
  const absolute = within(rootReal, file.ref);
  try {
    const actual = await realpath(absolute);
    const relative = path.relative(rootReal, actual);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("outside evidence root");
    const info = await lstat(actual);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes) throw new Error("file type or size mismatch");
    const bytes = await readFile(actual);
    if (sha256(bytes) !== file.sha256) throw new Error("SHA-256 mismatch");
    return bytes;
  } catch {
    throw new AdminHttpError(409, `Locked evidence is missing or changed: ${file.label}`);
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mastDs9Region(sourceBytes: Buffer, observationId: string): {
  text: string;
  instrument: string;
  filters: string;
  proposalId: string;
  targetName: string;
  tMinMjd: number;
  tMaxMjd: number;
  polygonCount: number;
} {
  const payload = jsonObject(sourceBytes, "MAST CAOM source snapshot");
  if (!Array.isArray(payload.Tables) || !payload.Tables.length) throw new AdminHttpError(409, "MAST CAOM snapshot has no result table");
  const table = record(payload.Tables[0], "MAST CAOM table");
  if (!Array.isArray(table.Columns) || !Array.isArray(table.Rows)) throw new AdminHttpError(409, "MAST CAOM snapshot is missing columns or rows");
  const columns = table.Columns.map((value) => text(record(value, "MAST CAOM column").dataIndex, "MAST CAOM column name", 128));
  const indices = new Map(columns.map((name, index) => [name, index]));
  for (const key of ["obsid", "obs_collection", "dataproduct_type", "dataRights", "proposal_id", "instrument_name", "filters", "s_region", "t_min", "target_name", "t_max"]) {
    if (!indices.has(key)) throw new AdminHttpError(409, `MAST CAOM snapshot is missing ${key}`);
  }
  const matchingRows = table.Rows.map((value) => {
    if (!Array.isArray(value) || value.length !== columns.length) throw new AdminHttpError(409, "MAST CAOM snapshot contains an invalid row");
    return value;
  }).filter((value) => String(value[indices.get("obsid")!]) === observationId);
  if (matchingRows.length !== 1) throw new AdminHttpError(409, "Selected obsid must occur exactly once in the locked HST CAOM snapshot");
  const row = matchingRows[0]!;
  if (String(row[indices.get("obs_collection")!]).toUpperCase() !== "HST"
    || String(row[indices.get("dataproduct_type")!]).toLowerCase() !== "image"
    || String(row[indices.get("dataRights")!]).toUpperCase() !== "PUBLIC") {
    throw new AdminHttpError(409, "Selected observation is outside the locked public HST image policy");
  }
  const region = String(row[indices.get("s_region")!] ?? "");
  const tokens = region.trim().split(/\s+/);
  const polygons: string[][] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    if (tokens[cursor]!.toUpperCase() !== "POLYGON") throw new AdminHttpError(409, "MAST observation s_region contains unsupported geometry");
    cursor++;
    const coordinates: string[] = [];
    while (cursor < tokens.length && tokens[cursor]!.toUpperCase() !== "POLYGON") {
      const coordinate = tokens[cursor]!;
      const number = Number(coordinate);
      if (!Number.isFinite(number)) throw new AdminHttpError(409, "MAST observation s_region contains a non-finite coordinate");
      coordinates.push(coordinate);
      cursor++;
    }
    if (coordinates.length < 8 || coordinates.length % 2) throw new AdminHttpError(409, "MAST observation s_region has an invalid polygon");
    const points = coordinates.filter((_value, index) => index % 2 === 0).map((ra, index) => `${ra}:${coordinates[index * 2 + 1]}`);
    if (points[0] !== points.at(-1) || new Set(points.slice(0, -1)).size < 3) throw new AdminHttpError(409, "MAST observation s_region polygon is not explicitly closed");
    polygons.push(coordinates);
  }
  if (!polygons.length) throw new AdminHttpError(409, "MAST observation has no s_region polygon");
  const instrument = text(row[indices.get("instrument_name")!], "MAST instrument", 128);
  const filters = text(row[indices.get("filters")!], "MAST filters", 256);
  const proposalId = text(row[indices.get("proposal_id")!], "MAST proposal ID", 128);
  const targetName = text(row[indices.get("target_name")!], "MAST target name", 256);
  const tMinMjd = Number(row[indices.get("t_min")!]);
  const tMaxMjd = Number(row[indices.get("t_max")!]);
  if (!Number.isFinite(tMinMjd) || !Number.isFinite(tMaxMjd) || tMaxMjd < tMinMjd) throw new AdminHttpError(409, "MAST observation has invalid time bounds");
  const lines = ["# Region file format: DS9 version 4.1", "icrs", `# MAST CAOM observation ${observationId}`];
  lines.push(...polygons.map((coordinates) => `polygon(${coordinates.join(",")})`));
  return { text: `${lines.join("\n")}\n`, instrument, filters, proposalId, targetName, tMinMjd, tMaxMjd, polygonCount: polygons.length };
}

function jsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return record(parsed, label);
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw new AdminHttpError(409, `${label} is not valid JSON`);
  }
}

function outputFile(ref: string, bytes: Buffer, order?: number): MocBuildOutputFile & { sha256: string; order?: number } {
  return { ref, sha256: sha256(bytes), sizeBytes: bytes.length, ...(order !== undefined ? { order } : {}) };
}

export async function registerEvidenceMoc(options: {
  evidenceRoot: string;
  products: ProductStore;
  builds: MocBuildStore;
  buildService: MocBuildService;
}, value: unknown): Promise<{ request: ReturnType<MocBuildStore["get"]>; product: ReturnType<ProductStore["get"]> }> {
  const input = parseInput(value);
  const sourceFile = { label: "MAST CAOM source snapshot", ref: input.source.snapshotRef, sha256: input.source.snapshotSha256, sizeBytes: input.source.sizeBytes };
  const sourceBytes = await readLocked(options.evidenceRoot, sourceFile);
  const inputBytes = new Map<string, Buffer>();
  for (const file of input.inputEvidence) inputBytes.set(file.ref, await readLocked(options.evidenceRoot, file));

  const manifestFile = input.inputEvidence.find((file) => file.ref.endsWith("input-manifest.json"));
  const provenanceFile = input.inputEvidence.find((file) => file.ref.endsWith("provenance.json"));
  const regionFile = input.inputEvidence.find((file) => file.ref.endsWith(`obs-${input.candidateId}.reg`));
  const recipeFile = input.inputEvidence.find((file) => file.ref.endsWith(`obs-${input.candidateId}.lock.json`));
  if (!manifestFile || !provenanceFile || !regionFile || !recipeFile) throw new AdminHttpError(400, "inputEvidence must include the observation manifest, provenance, DS9 region, and recipe lock");
  const manifest = jsonObject(inputBytes.get(manifestFile.ref)!, "input manifest");
  const manifestSnapshot = record(manifest.sourceSnapshot, "input manifest sourceSnapshot");
  const selectedIds = manifest.selectedObservationIds;
  const observation = Array.isArray(manifest.observations)
    ? manifest.observations.map((row) => record(row, "input manifest observation")).find((row) => row.observationId === input.candidateId)
    : undefined;
  if (manifest.schemaVersion !== 1 || manifest.kind !== "mast-hst-observation-region-inputs" || manifest.coordinateFrame !== "ICRS" || manifest.ordering !== "NESTED"
    || manifestSnapshot.ref !== sourceFile.ref || manifestSnapshot.sha256 !== sourceFile.sha256 || manifestSnapshot.sizeBytes !== sourceFile.sizeBytes
    || !Array.isArray(selectedIds) || !selectedIds.includes(input.candidateId) || !observation) {
    throw new AdminHttpError(409, "Input manifest does not bind the selected MAST observation to the locked CAOM snapshot");
  }
  const sourceGeometry = mastDs9Region(sourceBytes, input.candidateId);
  const sourceObservation = record(observation.sourceSnapshot, "input manifest observation sourceSnapshot");
  const sourceRegion = record(observation.regionInput, "input manifest regionInput");
  const recipeRef = text(observation.recipe, "input manifest recipe ref", 256);
  if (sourceObservation.ref !== sourceFile.ref || sourceObservation.sha256 !== sourceFile.sha256 || sourceObservation.sizeBytes !== sourceFile.sizeBytes
    || observation.proposalId !== sourceGeometry.proposalId || observation.targetName !== sourceGeometry.targetName
    || observation.instrument !== sourceGeometry.instrument || observation.filters !== sourceGeometry.filters
    || observation.tMinMjd !== sourceGeometry.tMinMjd || observation.tMaxMjd !== sourceGeometry.tMaxMjd
    || observation.polygonCount !== sourceGeometry.polygonCount
    || sourceRegion.ref !== path.posix.basename(regionFile.ref) || sourceRegion.sha256 !== regionFile.sha256 || sourceRegion.sizeBytes !== regionFile.sizeBytes
    || recipeRef !== path.posix.basename(recipeFile.ref)
    || sourceGeometry.instrument !== input.product.coverageEvidence?.instrument
    || sourceGeometry.filters !== input.product.coverageEvidence?.filters
    || !inputBytes.get(regionFile.ref)!.equals(Buffer.from(sourceGeometry.text, "utf8"))) {
    throw new AdminHttpError(409, "Manifest, DS9 region or observation metadata does not match the locked MAST observation");
  }
  const recipe = jsonObject(inputBytes.get(recipeFile.ref)!, "recipe lock");
  const recipeDetails = record(recipe.recipe, "recipe lock recipe");
  const recipeSource = record(recipe.snapshot, "recipe lock snapshot");
  const sourceIdentity = `MAST obsid ${input.candidateId} · proposal ${sourceGeometry.proposalId} · target ${sourceGeometry.targetName}`;
  const coverageEvidence = input.product.coverageEvidence;
  if (input.product.surveyId !== "hst" || input.product.mode !== "regions" || input.product.coverageRole !== "image_extent"
    || input.product.dataOrigin !== "observed" || input.product.sourceTier !== "official_geometry"
    || !coverageEvidence || coverageEvidence.evidenceKind !== "observation-footprint" || coverageEvidence.precision !== "estimated"
    || coverageEvidence.completeness !== "incomplete" || coverageEvidence.scienceFileScan !== "not-scanned"
    || coverageEvidence.sourceIdentity !== sourceIdentity || coverageEvidence.sourceSnapshotSha256 !== sourceFile.sha256
    || coverageEvidence.instrument !== sourceGeometry.instrument || coverageEvidence.filters !== sourceGeometry.filters) {
    throw new AdminHttpError(400, "HST product must declare the locked estimated observation-footprint evidence and scan limits");
  }
  if (recipe.layerId !== input.layerId || recipe.surveyId !== input.product.surveyId || recipe.releaseId !== input.product.releaseId
    || recipe.sourceUrl !== input.source.url || recipe.coordinateFrame !== "ICRS" || recipe.ordering !== "NESTED" || recipeDetails.precision !== "estimated"
    || recipeDetails.observationId !== input.candidateId || recipeDetails.sourceSnapshotSha256 !== sourceFile.sha256
    || recipeDetails.proposalId !== sourceGeometry.proposalId || recipeDetails.targetName !== sourceGeometry.targetName
    || recipeDetails.instrument !== sourceGeometry.instrument || recipeDetails.filters !== sourceGeometry.filters
    || recipeDetails.tMinMjd !== sourceGeometry.tMinMjd || recipeDetails.tMaxMjd !== sourceGeometry.tMaxMjd
    || recipe.maxOrder !== manifest.maxOrder || recipeSource.sourceSnapshotRef !== sourceFile.ref
    || recipeSource.sourceSnapshotSha256 !== sourceFile.sha256 || recipeSource.sourceSnapshotSizeBytes !== sourceFile.sizeBytes
    || recipeSource.sha256 !== regionFile.sha256 || recipeSource.sizeBytes !== regionFile.sizeBytes) {
    throw new AdminHttpError(409, "Recipe lock does not match the selected ICRS/NESTED observation evidence");
  }
  const provenance = jsonObject(inputBytes.get(provenanceFile.ref)!, "coverage provenance");
  const provenanceSnapshot = record(provenance.snapshot, "provenance snapshot");
  const provenanceInput = record(provenance.input, "provenance input");
  const provenanceRecipe = record(provenance.recipe, "provenance recipe");
  const provenanceOutputs = record(provenance.outputs, "provenance outputs");
  if (provenance.layerId !== input.layerId || provenance.coordinateFrame !== "ICRS" || provenance.ordering !== "NESTED"
    || provenance.sourceUrl !== recipe.sourceUrl || provenance.sourceTier !== input.product.sourceTier
    || provenance.dataOrigin !== input.product.dataOrigin || provenance.coverageRole !== input.product.coverageRole
    || provenanceSnapshot.sha256 !== regionFile.sha256 || provenanceSnapshot.sizeBytes !== regionFile.sizeBytes
    || provenanceSnapshot.sourceSnapshotRef !== sourceFile.ref || provenanceSnapshot.sourceSnapshotSha256 !== sourceFile.sha256
    || provenanceSnapshot.sourceSnapshotSizeBytes !== sourceFile.sizeBytes
    || provenanceInput.path !== path.posix.basename(regionFile.ref) || provenanceInput.sha256 !== regionFile.sha256
    || provenanceRecipe.observationId !== input.candidateId || provenanceRecipe.precision !== "estimated"
    || provenanceRecipe.sourceSnapshotSha256 !== sourceFile.sha256 || provenanceRecipe.proposalId !== sourceGeometry.proposalId
    || provenanceRecipe.targetName !== sourceGeometry.targetName || provenanceRecipe.instrument !== sourceGeometry.instrument
    || provenanceRecipe.filters !== sourceGeometry.filters || provenanceRecipe.tMinMjd !== sourceGeometry.tMinMjd
    || provenanceRecipe.tMaxMjd !== sourceGeometry.tMaxMjd || provenanceRecipe.sourceSnapshotRef !== sourceFile.ref
    || provenanceRecipe.sourceSnapshotSizeBytes !== sourceFile.sizeBytes) {
    throw new AdminHttpError(409, "Coverage provenance does not match the locked observation input");
  }

  const mocBytes = await readLocked(options.evidenceRoot, input.outputs.moc);
  const moc = decodeNativeMoc(mocBytes);
  assertPublicCoverageOrder(moc.maxOrder);
  const queryBytes = await readLocked(options.evidenceRoot, input.outputs.query);
  const previewBytes = await readLocked(options.evidenceRoot, input.outputs.preview);
  const statisticsBytes = await readLocked(options.evidenceRoot, input.outputs.statistics);
  const requestedMaxOrder = recipe.maxOrder;
  const requestedQueryOrder = recipe.queryOrder;
  if (!Number.isSafeInteger(requestedMaxOrder) || Number(requestedMaxOrder) < 4
    || !Number.isSafeInteger(requestedQueryOrder) || Number(requestedQueryOrder) < 0
    || moc.maxOrder > Number(requestedMaxOrder) || moc.maxOrder < Number(requestedQueryOrder)) {
    throw new AdminHttpError(409, "Native MOC order must be within the locked query and maximum order bounds");
  }
  const query = jsonObject(queryBytes, "query projection");
  const preview = jsonObject(previewBytes, "preview projection");
  const statistics = jsonObject(statisticsBytes, "MOC statistics");
  const projection = (value: Record<string, unknown>, label: string): { order: number; pixels: number[] } => {
    const order = value.order;
    const pixels = value.pixels;
    if (!Number.isSafeInteger(order) || Number(order) < 0 || Number(order) > moc.maxOrder || value.ordering !== "NESTED"
      || !Array.isArray(pixels) || pixels.some((pixel) => !Number.isSafeInteger(pixel) || Number(pixel) < 0 || Number(pixel) >= 12 * 4 ** Number(order))) {
      throw new AdminHttpError(409, `${label} has invalid NESTED order/pixel data`);
    }
    const normalized = [...new Set(pixels as number[])].sort((left, right) => left - right);
    const expected = projectMoc(moc, Number(order)).cells;
    if (!sameNumbers(normalized, expected)) throw new AdminHttpError(409, `${label} does not match the decoded native MOC`);
    return { order: Number(order), pixels: normalized };
  };
  const queryProjection = projection(query, "Query projection");
  const previewProjection = projection(preview, "Preview projection");
  if (queryProjection.order !== recipe.queryOrder || previewProjection.order !== recipe.previewOrder) {
    throw new AdminHttpError(409, "Query and preview orders do not match the locked recipe");
  }
  const provenanceMoc = record(provenanceOutputs.moc, "provenance MOC output");
  const provenanceQuery = record(provenanceOutputs.query, "provenance query output");
  const provenancePreview = record(provenanceOutputs.preview, "provenance preview output");
  const provenanceStatistics = record(provenanceOutputs.statistics, "provenance statistics output");
  const outputEvidenceMatches = (provenanceOutput: Record<string, unknown>, file: LockedEvidenceFile): boolean =>
    provenanceOutput.path === path.posix.basename(file.ref) && provenanceOutput.sha256 === file.sha256 && provenanceOutput.sizeBytes === file.sizeBytes;
  if (statistics.schemaVersion !== 1 || statistics.maxOrder !== moc.maxOrder || statistics.mocSha256 !== input.outputs.moc.sha256
    || statistics.queryPixelCount !== queryProjection.pixels.length || statistics.previewPixelCount !== previewProjection.pixels.length
    || !outputEvidenceMatches(provenanceMoc, input.outputs.moc) || !outputEvidenceMatches(provenanceQuery, input.outputs.query)
    || !outputEvidenceMatches(provenancePreview, input.outputs.preview) || !outputEvidenceMatches(provenanceStatistics, input.outputs.statistics)) {
    throw new AdminHttpError(409, "MOC statistics do not match the locked input and actual projections");
  }

  const stageName = safeMocName(input.buildName);
  const stageDirectory = path.join("moc-build", stageName);
  const evidenceRoot = await realpath(options.evidenceRoot);
  const stageRoot = within(evidenceRoot, stageDirectory);
  await mkdir(stageRoot, { recursive: true });
  for (const directory of [path.dirname(stageRoot), stageRoot]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AdminHttpError(409, "MOC evidence stage path must contain only real directories");
  }
  const outputBytes = new Map<string, Buffer>([
    ["moc.fits", mocBytes],
    [`query-order${queryProjection.order}.json`, queryBytes],
    [`preview-order${previewProjection.order}.json`, previewBytes],
    ["statistics.json", statisticsBytes],
  ]);
  const stagedFiles = new Map<string, ReturnType<typeof outputFile>>();
  for (const [filename, bytes] of outputBytes) {
    const absolute = within(evidenceRoot, path.posix.join(stageDirectory, filename));
    const digest = sha256(bytes);
    try { await writeFile(absolute, bytes, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new AdminHttpError(409, `Immutable MOC build output conflicts: ${filename}`);
      const existing = await lstat(absolute);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length || sha256(await readFile(absolute)) !== digest) {
        throw new AdminHttpError(409, `Immutable MOC build output conflicts: ${filename}`);
      }
    }
    stagedFiles.set(filename, outputFile(path.posix.join(stageDirectory, filename), bytes,
      filename.startsWith("query-order") ? queryProjection.order : filename.startsWith("preview-order") ? previewProjection.order : undefined));
  }
  const buildManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: "moc-build-evidence",
    requestName: stageName,
    provider: "evidence",
    candidateId: input.candidateId,
    layerId: input.layerId,
    source: { url: input.source.url, ref: input.source.snapshotRef, sha256: sourceFile.sha256, sizeBytes: sourceBytes.length },
    inputEvidence: input.inputEvidence,
    tool: { name: "astro-survey-moc-core", version: "1.1.0" },
    outputs: Object.fromEntries([...stagedFiles.entries()].map(([name, file]) => [name, file])),
  }, null, 2)}\n`, "utf8");
  const manifestRef = path.posix.join(stageDirectory, "build-manifest.json");
  const manifestAbsolute = within(evidenceRoot, manifestRef);
  const manifestSha256 = sha256(buildManifest);
  try { await writeFile(manifestAbsolute, buildManifest, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new AdminHttpError(409, "Immutable MOC build manifest conflicts with existing evidence");
    const existing = await lstat(manifestAbsolute);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== buildManifest.length || sha256(await readFile(manifestAbsolute)) !== manifestSha256) {
      throw new AdminHttpError(409, "Immutable MOC build manifest conflicts with existing evidence");
    }
  }
  const manifestOutput = outputFile(manifestRef, buildManifest);
  const product = await options.products.createMocProduct(input.product);
  if (product.published || product.draft.coverageEvidence?.sourceSnapshotSha256 !== sourceFile.sha256 || product.draft.mode !== input.product.mode) {
    throw new AdminHttpError(409, "An existing product conflicts with this MAST observation evidence");
  }
  const request = await options.builds.createVerifiedEvidenceBuild({
    name: input.buildName,
    layerId: input.layerId,
    candidateId: input.candidateId,
    candidateTitle: input.candidateTitle,
    surveyId: product.draft.surveyId,
    releaseId: product.draft.releaseId,
    productId: product.productId,
    source: {
      url: input.source.url,
      snapshotSha256: sourceFile.sha256,
      sizeBytes: sourceBytes.length,
      evidenceRef: sourceFile.ref,
      evidenceInputs: input.inputEvidence,
      sourceEvidence: product.draft.coverageEvidence,
    },
    outputs: {
      moc: stagedFiles.get("moc.fits")!,
      query: stagedFiles.get(`query-order${queryProjection.order}.json`)! as MocBuildOutput["query"],
      preview: stagedFiles.get(`preview-order${previewProjection.order}.json`)! as MocBuildOutput["preview"],
      statistics: stagedFiles.get("statistics.json")!,
      manifest: manifestOutput,
      cellCount: moc.cells.length,
      availableOrders: moc.availableOrders,
      maxOrder: moc.maxOrder,
    },
  });
  await options.buildService.verifyOutputs(request.name);
  return { request, product };
}
