import { mkdir, readFile, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { AdminHttpError } from "./admin-error.js";
import { eroFramesForProduct, parseEroTargetSnapshot } from "./ero-target-index.js";
import { polygonCoordinates } from "./euclid-native-metadata.js";
import { assertPublicCoverageOrder } from "./coverage-policy.js";
import { decodeNativeMoc, projectMoc, sha256 } from "./native-moc.js";
import { nativeEvidencePath, type NativeGroup, type NativeSource } from "./native-unit-model.js";
import { nativeFile } from "./native-unit-archive.js";
import { loadSurveyManifest, normalizedRow } from "./survey-native-index.js";
import { safeMocName, type MocBuildService, type MocBuildStore, type MocBuildOutputFile } from "./moc-build.js";
import { ProductStore } from "./products.js";

type Document = Record<string, any>;
const BANDS = ["VIS", "Y", "J", "H", "all"];

/** Build only from installed, reviewed source snapshots. Caller supplies no geometry or files. */
export async function buildEuclidGeometry(options: {
  evidenceRoot: string; sourceRoot: string; active?: NativeGroup | null; sources: readonly NativeSource[];
  products: ProductStore; builds: MocBuildStore; buildService: MocBuildService;
}, value: unknown): Promise<{ request: ReturnType<MocBuildStore["get"]>; product: ReturnType<ProductStore["get"]> }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminHttpError(400, "Euclid build request must be an object");
  const input = value as Document;
  if (Object.keys(input).some(key => !["sourceId", "band", "buildName", "expectedActive"].includes(key))
    || typeof input.buildName !== "string" || safeMocName(input.buildName) !== input.buildName || !BANDS.includes(input.band)) {
    throw new AdminHttpError(400, "Use a safe buildName, a registered sourceId and VIS/Y/J/H/all band");
  }
  const group = options.active;
  if (!group?.review || input.expectedActive !== group.id) throw new AdminHttpError(409, "Active native version changed; select the reviewed version again");
  const source = options.sources.find(source => source.id === input.sourceId);
  const snapshot = group.snapshots[input.sourceId];
  if (!source || source.surveyId !== "euclid" || !snapshot
    || !["euclid-ero-targets", "euclid-q1-calibrated-frames", "euclid-q2-egbs-quadrants"].includes(source.id)) {
    throw new AdminHttpError(409, "Euclid geometry requires an installed reviewed ERO/Q1/Q2 source snapshot");
  }
  if (source.releaseId === "euclid-q2" && !["VIS", "all"].includes(input.band)) throw new AdminHttpError(400, "Q2 EGBS-v1 has VIS science images only");
  const sourceFile = snapshot.files[0]!;
  for (const file of snapshot.files) await nativeFile(options.sourceRoot, file.ref, file);
  const sourceBytes = await readFile(nativeEvidencePath(options.sourceRoot, sourceFile.ref));
  const bandLabel = input.band === "all" ? "VIS and NISP" : input.band === "VIS" ? "VIS" : `NISP.${input.band}`;
  const productName = source.releaseId === "euclid-ero" ? `ERO ${bandLabel} image frames`
    : source.releaseId === "euclid-q1" ? `Euclid Q1 ${bandLabel} calibrated frames` : "Euclid Q2 EGBS-v1 VIS quadrants";
  const existingProduct = options.products.list().find(record => record.draft.surveyId === "euclid"
    && record.draft.releaseId === source.releaseId && record.draft.name === productName);
  const prior = options.builds.list().find(build => build.name === input.buildName);
  if (prior) {
    if (prior.source.snapshotSha256 !== sourceFile.sha256 || prior.candidateId !== `${source.id}:${input.band}`
      || !existingProduct || prior.productId !== existingProduct.productId) throw new AdminHttpError(409, "Build name already refers to different source content");
    await options.buildService.verifyOutputs(prior.name);
    return { request: prior, product: existingProduct };
  }
  // Immutable products keep old geometry addressable; a changed snapshot gets a new build/product version.
  if (existingProduct) throw new AdminHttpError(409, "This frame product already exists; reuse its locked build or register a new source version");
  const regions: Array<{ unitId: string; sRegion: string; sourceFile: string; sourceUrl?: string; headerSha256?: string }> = [];
  if (source.id === "euclid-ero-targets") {
    const index = parseEroTargetSnapshot(sourceBytes.toString("utf8"), sourceFile.sha256);
    for (const target of index.targets) for (const frame of eroFramesForProduct(target, productName)) {
      regions.push({ unitId: target.id, sRegion: frame.sRegion, sourceFile: frame.memberName, sourceUrl: frame.sourceUrl, headerSha256: frame.sha256 });
    }
  } else {
    const { manifest } = await loadSurveyManifest(options.sourceRoot, sourceFile.ref, source, sourceFile);
    for (const file of manifest.rowFiles!) {
      const bytes = await readFile(nativeEvidencePath(options.sourceRoot, path.posix.join(path.posix.dirname(sourceFile.ref), file.ref)));
      const decoded = file.ref.endsWith(".gz") ? gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }) : bytes;
      for (const line of decoded.toString("utf8").split("\n").filter(Boolean)) {
        const row = normalizedRow(JSON.parse(line), source);
        if (row && (input.band === "all" || row.bands.includes(input.band))) regions.push({ unitId: row.unitId,
          sRegion: row.sRegion, sourceFile: row.filename, sourceUrl: row.accessUris?.[0]?.uri,
          ...(row.sourceMetadata?.headerSha256 ? { headerSha256: row.sourceMetadata.headerSha256 } : {}) });
      }
    }
  }
  if (!regions.length) throw new AdminHttpError(409, "Selected band has no source-supported image frames");
  const root = await realpath(options.evidenceRoot);
  const directoryRef = `moc-build/${input.buildName}`;
  const directory = nativeEvidencePath(root, directoryRef);
  await mkdir(directory, { recursive: true });
  for (const dir of [path.dirname(directory), directory]) if ((await lstat(dir)).isSymbolicLink()
    || !path.relative(root, await realpath(dir)).split(path.sep).every(part => part !== "..")) throw new AdminHttpError(409, "Build directory must stay on the evidence volume");
  const write = async (filename: string, bytes: Buffer): Promise<MocBuildOutputFile & { sha256: string; sizeBytes: number }> => {
    const ref = `${directoryRef}/${filename}`;
    await writeFile(nativeEvidencePath(root, ref), bytes, { flag: "wx" });
    return { ref, sha256: sha256(bytes), sizeBytes: bytes.length };
  };
  const ds9 = Buffer.from("# Region file format: DS9 version 4.1\nicrs\n" + regions.map(region => {
    const polygon = polygonCoordinates(region.sRegion);
    if (polygon.frame !== "ICRS") throw new AdminHttpError(409, "Installed Euclid frame must be normalized to ICRS");
    return `polygon(${polygon.points.join(",")})`;
  }).join("\n") + "\n");
  const regionFile = await write("frames.reg", ds9);
  const identity = `${source.title}; ${bandLabel}; ${regions.length} source-listed frames`;
  const recipe = { layerId: `euclid-${source.releaseId.replace("euclid-", "")}-${input.band.toLowerCase()}-frames`, surveyId: "euclid",
    releaseId: source.releaseId, product: productName, modality: "imaging", mode: "regions", input: "frames.reg",
    coverageRole: "image_extent", dataOrigin: "observed", sourceTier: "official_geometry", coordinateFrame: "ICRS", ordering: "NESTED",
    maxOrder: 10, queryOrder: 8, previewOrder: 4, sourceUrl: source.sourceUrl,
    snapshot: { sha256: regionFile.sha256, sizeBytes: regionFile.sizeBytes, sourceSnapshotSha256: sourceFile.sha256 },
    recipe: { format: "ds9", geometryField: "s_region", sourceSyntax: "STC-S POLYGON", geometryKind: "managed-native-unit",
      sourceId: source.id, nativeVersion: group.id, snapshotId: snapshot.id, sourceSnapshotSha256: sourceFile.sha256,
      unitCount: new Set(regions.map(region => region.unitId)).size, frameCount: regions.length, band: input.band,
      precision: "estimated", completeness: "incomplete", scienceFileScan: "not-scanned",
      limitations: ["Image frame extent; valid-pixel masks, depth and exposure holes were not inspected.", "Source identities and manifest export do not grant access to scientific data."] } };
  const recipeFile = await write("recipe.lock.json", Buffer.from(JSON.stringify(recipe, null, 2) + "\n"));
  const inputManifest = await write("input-manifest.json", Buffer.from(JSON.stringify({ schemaVersion: 1, deliveryClass: "evidence",
    coordinateFrame: "ICRS", ordering: "NESTED", sourceId: source.id, nativeVersion: group.id, snapshotId: snapshot.id,
    sourceSnapshot: sourceFile, regions, recipe: recipeFile }, null, 2) + "\n"));
  const output = await options.buildService.buildRegions(nativeEvidencePath(root, recipeFile.ref), path.join(directory, "core"));
  const lockedOutput = async (key: string): Promise<MocBuildOutputFile & { sha256: string; sizeBytes: number }> => {
    const item = output[key] as Document;
    const actual = await realpath(String(item?.path));
    const relative = path.relative(directory, actual);
    if (relative.startsWith("..") || path.isAbsolute(relative) || (await lstat(actual)).isSymbolicLink()) throw new AdminHttpError(409, "Core output escaped its stage directory");
    const bytes = await readFile(actual);
    if (bytes.length !== item.sizeBytes || sha256(bytes) !== item.sha256) throw new AdminHttpError(409, "Core output hash changed");
    return { ref: path.relative(root, actual).split(path.sep).join("/"), sha256: item.sha256, sizeBytes: item.sizeBytes };
  };
  const moc = await lockedOutput("moc"), query = await lockedOutput("query"), preview = await lockedOutput("preview");
  const statistics = await lockedOutput("statistics"), provenance = await lockedOutput("provenance");
  const decoded = decodeNativeMoc(await readFile(nativeEvidencePath(root, moc.ref)));
  assertPublicCoverageOrder(decoded.maxOrder);
  if (decoded.maxOrder !== 10) throw new AdminHttpError(409, "Frame MOC does not have the requested actual O10 boundary precision");
  for (const [file, order] of [[query, 8], [preview, 4]] as const) {
    const projection = JSON.parse(await readFile(nativeEvidencePath(root, file.ref), "utf8"));
    if (projection.order !== order || projection.ordering !== "NESTED"
      || JSON.stringify(projection.pixels) !== JSON.stringify(projectMoc(decoded, order).cells)) throw new AdminHttpError(409, "Frame MOC projection disagrees with its actual NUNIQ cells");
  }
  const product = await options.products.createMocProduct({ surveyId: "euclid", surveyName: "Euclid", mission: "ESA",
    surveyDescription: "Euclid optical and near-infrared survey data and coverage.", surveyColor: "#d5543c", surveyModalities: ["imaging", "catalog", "spectroscopy"],
    releaseId: source.releaseId, releaseLabel: source.releaseId === "euclid-ero" ? "ERO" : source.releaseId === "euclid-q1" ? "Q1" : "Q2 EGBS-v1",
    releaseKind: "public", releasedYear: source.releaseId === "euclid-q2" ? 2026 : source.releaseId === "euclid-q1" ? 2025 : 2024,
    productName, productDescription: `${identity}. Estimated image-frame coverage in ICRS/NESTED; valid-pixel masks are not included. JSON/CSV exports list sources; users retrieve scientific data from ESA under its access policy.`,
    modality: "imaging", sourceUrl: source.sourceUrl, geometrySourceUrl: source.sourceUrl, geometrySourceLabel: "Managed official image-frame metadata",
    mode: "regions", sourceTier: "official_geometry", coverageRole: "image_extent", coverageEvidence: {
      evidenceKind: source.releaseId === "euclid-ero" || source.releaseId === "euclid-q2" ? "wcs-coverage" : "source-unit-footprint",
      sourceIdentity: identity, sourceSnapshotSha256: sourceFile.sha256, precision: "estimated", completeness: "incomplete", scienceFileScan: "not-scanned",
      summary: "Coverage comes from each image's saved WCS or archive footprint, not a HiPS display MOC. It does not establish valid pixels, a complete scientific inventory or current file availability." } });
  const inputs = [regionFile, recipeFile, inputManifest, provenance].map(file => ({ label: path.basename(file.ref), ...file }));
  const manifestOutput = await write("build-manifest.json", Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "moc-build-evidence",
    provider: "evidence", nativeVersion: group.id, sourceId: source.id, snapshotId: snapshot.id,
    source: sourceFile, inputEvidence: inputs, tool: { name: "astro-survey-moc-core", version: "1.2.0" },
    coordinateFrame: "ICRS", ordering: "NESTED", precision: "estimated", outputs: { moc, query, preview, statistics } }, null, 2) + "\n"));
  const sourceRef = options.sourceRoot === root ? sourceFile.ref : (await write("source-snapshot.json", sourceBytes)).ref;
  const request = await options.builds.createVerifiedEvidenceBuild({ name: input.buildName, layerId: recipe.layerId,
    candidateId: `${source.id}:${input.band}`, candidateTitle: productName, surveyId: "euclid", releaseId: source.releaseId,
    productId: product.productId, source: { url: source.sourceUrl, evidenceRef: sourceRef, snapshotSha256: sourceFile.sha256,
      sizeBytes: sourceFile.sizeBytes, evidenceInputs: inputs, sourceEvidence: product.draft.coverageEvidence },
    outputs: { moc, query: { ...query, order: 8 }, preview: { ...preview, order: 4 }, statistics, manifest: manifestOutput,
      cellCount: decoded.cells.length, availableOrders: decoded.availableOrders, maxOrder: decoded.maxOrder } });
  await options.buildService.verifyOutputs(request.name);
  return { request, product };
}
