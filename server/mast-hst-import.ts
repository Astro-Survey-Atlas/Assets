import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactStore } from "./artifact-store.js";
import { AdminHttpError, type KubernetesResource } from "./admin.js";
import { registerEvidenceMoc } from "./evidence-moc-import.js";
import { resolveMastHstObservation, verifyMastHstSnapshot, MAST_HST_MAX_SNAPSHOT_BYTES } from "./moc-discovery.js";
import type { MocBuildService, MocBuildStore } from "./moc-build.js";
import type { ProductStore } from "./products.js";

const MAST_API_URL = "https://mast.stsci.edu/api/v0/invoke";
const HST_ARCHIVE_URL = "https://archive.stsci.edu/missions-and-data/hst";
const HST_RELEASE_ID = "hst-mast-observations";

interface LockedFile {
  label: string;
  ref: string;
  sha256: string;
  sizeBytes: number;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminHttpError(409, "Locked MAST evidence is malformed");
  return value as Record<string, unknown>;
}

function evidenceRef(root: string, target: string): string {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative)) throw new AdminHttpError(409, "Generated MAST evidence escaped its storage root");
  return relative;
}

async function ensureDirectory(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new AdminHttpError(409, "Generated MAST evidence escaped its storage root");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AdminHttpError(409, "Generated MAST evidence path must contain only real directories");
  }
}

async function writeImmutable(root: string, ref: string, bytes: Buffer): Promise<string> {
  if (!ref || ref.includes("\\") || path.posix.isAbsolute(ref) || ref.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new AdminHttpError(409, "MAST snapshot evidence key is invalid");
  }
  const target = path.join(root, ...ref.split("/"));
  const parent = path.dirname(target);
  await ensureDirectory(root, parent);
  try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length || digest(await readFile(target)) !== digest(bytes)) {
      throw new AdminHttpError(409, "Immutable MAST snapshot conflicts with existing evidence");
    }
  }
  return target;
}

async function lockedFile(root: string, label: string, target: string): Promise<LockedFile> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new AdminHttpError(409, `Generated evidence is not a regular file: ${label}`);
  const bytes = await readFile(target);
  return { label, ref: evidenceRef(root, target), sha256: digest(bytes), sizeBytes: bytes.length };
}

function runConverter(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const python = process.env.MOC_BUILDER_PYTHON?.trim() || "python3";
    const child = spawn(python, [script, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 1024 * 1024) stdout.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
      else child.kill("SIGKILL");
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new AdminHttpError(503, "MAST region converter could not start"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        try {
          const manifest = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
          if (manifest.kind !== "mast-hst-observation-region-inputs") throw new Error("unsupported output");
          resolve();
        } catch {
          reject(new AdminHttpError(422, "MAST region converter returned an invalid locked input manifest"));
        }
        return;
      }
      if (timedOut) {
        reject(new AdminHttpError(504, "MAST region converter exceeded its time limit"));
        return;
      }
      const details = Buffer.concat(stderr).toString("utf8").trim();
      reject(new AdminHttpError(422, details ? `Locked MAST s_region conversion failed: ${details.slice(0, 1000)}` : "Locked MAST s_region conversion failed"));
    });
  });
}

export async function locateMastHstConverterScript(moduleUrl = import.meta.url): Promise<string> {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
  const candidates = [
    path.join(moduleRoot, "scripts", "mast_s_region_to_ds9.py"),
    path.resolve(moduleRoot, "..", "scripts", "mast_s_region_to_ds9.py"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new AdminHttpError(503, "MAST region converter is unavailable in this Assets runtime");
}

async function readArtifact(store: ArtifactStore, resolved: ReturnType<typeof resolveMastHstObservation>): Promise<Buffer> {
  const head = await store.head(resolved.snapshot.objectKey);
  if (!head || head.key !== resolved.snapshot.objectKey || head.sha256 !== resolved.snapshot.sha256 || head.sizeBytes !== resolved.snapshot.sizeBytes
    || head.sizeBytes < 1 || head.sizeBytes > MAST_HST_MAX_SNAPSHOT_BYTES) {
    throw new AdminHttpError(409, "Warehouse HST snapshot is missing or its metadata does not match the discovery status");
  }
  const value = await store.get(resolved.snapshot.objectKey);
  if (!value || value.key !== resolved.snapshot.objectKey || value.sha256 !== resolved.snapshot.sha256
    || value.sizeBytes !== resolved.snapshot.sizeBytes || value.body.length !== resolved.snapshot.sizeBytes
    || digest(value.body) !== resolved.snapshot.sha256) {
    throw new AdminHttpError(409, "Warehouse HST snapshot bytes do not match the immutable discovery status");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value.body.toString("utf8")); }
  catch { throw new AdminHttpError(409, "Warehouse HST snapshot is not valid JSON"); }
  verifyMastHstSnapshot(parsed, resolved);
  return value.body;
}

export async function importMastHstObservation(options: {
  resource: KubernetesResource;
  candidateId: unknown;
  artifactStore: ArtifactStore;
  evidenceRoot: string;
  products: ProductStore;
  builds: MocBuildStore;
  buildService: MocBuildService;
}): Promise<{ request: ReturnType<MocBuildStore["get"]>; product: ReturnType<ProductStore["get"]> }> {
  const resolved = resolveMastHstObservation(options.resource, options.candidateId);
  const snapshot = await readArtifact(options.artifactStore, resolved);
  await mkdir(options.evidenceRoot, { recursive: true });
  const root = await realpath(options.evidenceRoot);
  if (!path.isAbsolute(root)) throw new AdminHttpError(503, "Assets evidence storage is unavailable");
  const sourceRef = resolved.snapshot.objectKey;
  const sourcePath = await writeImmutable(root, sourceRef, snapshot);
  const derivedRef = path.posix.join(path.posix.dirname(sourceRef), "converted", `${resolved.candidate.obsid}-${resolved.snapshot.sha256.slice(0, 12)}`);
  const convertedPath = path.join(root, ...derivedRef.split("/"));
  await ensureDirectory(root, convertedPath);
  const corePath = path.join(convertedPath, "core");
  await ensureDirectory(root, corePath);
  const converter = await locateMastHstConverterScript();
  const releaseId = HST_RELEASE_ID;
  const layerPrefix = "hst-mast-observation";
  const conversionArgs = [
    "--input", sourcePath,
    "--output-dir", convertedPath,
    "--source-ref", sourceRef,
    "--obsid", resolved.candidate.obsid,
    "--survey-id", "hst",
    "--release-id", releaseId,
    "--layer-id-prefix", layerPrefix,
    "--product-label-prefix", "MAST",
    "--max-order", "10",
  ];
  await runConverter(converter, conversionArgs);
  const lockPath = path.join(convertedPath, `obs-${resolved.candidate.obsid}.lock.json`);
  try { await options.buildService.buildRegions(lockPath, corePath); }
  catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw new AdminHttpError(422, "MOC Core rejected the locked MAST observation footprint");
  }

  const inputManifestPath = path.join(convertedPath, "input-manifest.json");
  const recipe = object(JSON.parse(await readFile(lockPath, "utf8")));
  const recipeDetails = object(recipe.recipe);
  const manifest = object(JSON.parse(await readFile(inputManifestPath, "utf8")));
  const observations = manifest.observations;
  const observation = Array.isArray(observations) ? object(observations[0]) : undefined;
  if (manifest.kind !== "mast-hst-observation-region-inputs" || !observation || observation.observationId !== resolved.candidate.obsid
    || recipe.layerId !== `hst-mast-observation-${resolved.candidate.obsid}`) {
    throw new AdminHttpError(409, "Converted HST evidence does not identify the selected observation");
  }
  const proposalId = typeof recipeDetails.proposalId === "string" ? recipeDetails.proposalId : "";
  const targetName = typeof recipeDetails.targetName === "string" ? recipeDetails.targetName : "";
  const instrument = typeof recipeDetails.instrument === "string" ? recipeDetails.instrument : "";
  const filters = typeof recipeDetails.filters === "string" ? recipeDetails.filters : "";
  const productName = typeof observation.product === "string" ? observation.product : "";
  if (!proposalId || !targetName || !instrument || !filters || !productName) throw new AdminHttpError(409, "Converted HST observation metadata is incomplete");

  const inputEvidence = await Promise.all([
    lockedFile(root, "MAST observation input manifest", inputManifestPath),
    lockedFile(root, "MAST ICRS DS9 s_region", path.join(convertedPath, `obs-${resolved.candidate.obsid}.reg`)),
    lockedFile(root, "MAST observation recipe lock", lockPath),
    lockedFile(root, "Core coverage provenance", path.join(corePath, "provenance.json")),
  ]);
  const queryOrder = Number(recipe.queryOrder);
  const previewOrder = Number(recipe.previewOrder);
  if (!Number.isSafeInteger(queryOrder) || !Number.isSafeInteger(previewOrder)) throw new AdminHttpError(409, "Converted HST recipe has invalid projection orders");
  const outputRoot = corePath;
  const outputs = {
    moc: await lockedFile(root, "Native HST FITS MOC", path.join(outputRoot, `${String(recipe.layerId)}.moc.fits`)),
    query: await lockedFile(root, "HST query projection", path.join(outputRoot, `query-order${queryOrder}.json`)),
    preview: await lockedFile(root, "HST preview projection", path.join(outputRoot, `preview-order${previewOrder}.json`)),
    statistics: await lockedFile(root, "HST MOC statistics", path.join(outputRoot, "statistics.json")),
  };
  const sourceIdentity = `MAST obsid ${resolved.candidate.obsid} · proposal ${proposalId} · target ${targetName}`;
  const buildName = `hst-observation-${resolved.candidate.obsid}-${resolved.snapshot.sha256.slice(0, 8)}`;
  const imported = await registerEvidenceMoc({
    evidenceRoot: root,
    products: options.products,
    builds: options.builds,
    buildService: options.buildService,
  }, {
    buildName,
    layerId: String(recipe.layerId),
    candidateId: resolved.candidate.obsid,
    candidateTitle: productName,
    product: {
      surveyId: "hst",
      surveyName: "HST",
      mission: "Hubble Space Telescope / MAST",
      surveyDescription: "A heterogeneous pointed-observation archive. It is recorded as dated archive snapshots and products, not as a fictitious uniform DR sequence.",
      surveyColor: "#79a9ff",
      surveyModalities: ["imaging"],
      releaseId,
      releaseLabel: "MAST HST observation snapshots",
      releaseKind: "observation_snapshot",
      productName,
      productDescription: `Estimated ICRS footprint derived from the MAST CAOM s_region for HST observation ${resolved.candidate.obsid}. This is one observation, not a complete archive inventory; science files were not scanned or downloaded.`,
      productStatus: "acquired",
      modality: "imaging",
      sourceUrl: HST_ARCHIVE_URL,
      geometrySourceUrl: MAST_API_URL,
      geometrySourceLabel: "MAST CAOM observation metadata",
      sourceLabel: "MAST HST archive",
      dataOrigin: "observed",
      sourceTier: "official_geometry",
      coverageRole: "image_extent",
      mode: "regions",
      coverageEvidence: {
        evidenceKind: "observation-footprint",
        sourceIdentity,
        instrument,
        filters,
        sourceSnapshotSha256: resolved.snapshot.sha256,
        precision: "estimated",
        completeness: "incomplete",
        scienceFileScan: "not-scanned",
        summary: "MAST CAOM s_region polygons rasterized as an estimated ICRS/NESTED HST observation footprint. This is a selected metadata result, not a complete HST inventory; science files were not scanned or retrieved.",
      },
    },
    source: { url: MAST_API_URL, snapshotRef: sourceRef, snapshotSha256: resolved.snapshot.sha256, sizeBytes: snapshot.length },
    inputEvidence,
    outputs,
  });
  return imported;
}
