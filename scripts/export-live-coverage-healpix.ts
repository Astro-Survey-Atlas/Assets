import { lstat, mkdir, mkdtemp, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildResourcePackageHealpixFiles } from "../server/resource-package-healpix.js";
import { decodeNativeMoc, sha256 } from "../server/native-moc.js";
import type { ResourcePackageLayerRecord } from "../server/resource-package-inspection.js";

type JsonRecord = Record<string, unknown>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ServiceSnapshot {
  bundleId: string;
  bundleSha256: string;
  catalogRevision: string;
  catalogEtag: string;
  publicReleaseId: string | null;
  catalog: JsonRecord;
}

interface LayerProvenance {
  layerId: string;
  surveyId: string;
  releaseId: string;
  productId: string;
  product: string;
  nativeRevision: string;
  catalogCoverageRevision: { field: string; value: string } | null;
  catalogRevisionStatus: "matched" | "missing";
  mocSha256: string;
  nativeMaxOrder: number;
  nativeAvailableOrders: number[];
}

export interface LiveCoverageHealpixExportSummary {
  outputDirectory: string;
  bundleId: string;
  bundleSha256: string;
  catalogRevision: string;
  publicReleaseId: string | null;
  surveys: Array<{
    surveyId: string;
    directory: string;
    layerCount: number;
    orders: Array<{ order: number; path: string; unionCellCount: number; omittedLayerCount: number; sha256: string }>;
    provenancePath: string;
  }>;
}

function record(value: unknown, description: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} must be an object`);
  return value as JsonRecord;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${description} is missing`);
  return value;
}

function validSha256(value: unknown, description: string): string {
  const result = requiredString(value, description);
  if (!/^[a-f\d]{64}$/i.test(result)) throw new Error(`${description} must be a SHA-256 hex digest`);
  return result.toLowerCase();
}

async function jsonResponse(response: Response, description: string): Promise<JsonRecord> {
  if (!response.ok) throw new Error(`${description} returned HTTP ${response.status}`);
  try {
    return record(await response.json(), `${description} response`);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function captureSnapshot(baseUrl: URL, fetcher: Fetcher): Promise<ServiceSnapshot> {
  const [healthResponse, catalogResponse] = await Promise.all([
    fetcher(new URL("/healthz", baseUrl), { cache: "no-store", signal: AbortSignal.timeout(30_000) }),
    fetcher(new URL("/api/v1/coverage/catalog", baseUrl), { cache: "no-store", signal: AbortSignal.timeout(30_000) }),
  ]);
  const [health, catalog] = await Promise.all([
    jsonResponse(healthResponse, "/healthz"),
    jsonResponse(catalogResponse, "/api/v1/coverage/catalog"),
  ]);
  if (health.service !== "astro-survey-atlas-assets" || health.status !== "ok") throw new Error("Assets health response does not identify a healthy Assets service");
  const bundle = record(health.bundle, "Assets bundle identity");
  const bundleId = requiredString(bundle.id, "Assets bundle ID");
  const bundleSha256 = validSha256(bundle.sha256, "Assets bundle SHA-256");
  const catalogRevision = requiredString(catalog.revision, "Coverage catalog revision");
  const publicReleaseId = catalog.publicReleaseId === null ? null : requiredString(catalog.publicReleaseId, "Public release ID");
  const catalogEtag = catalogResponse.headers.get("etag");
  if (!catalogEtag) throw new Error("Coverage catalog response is missing its ETag");
  if (catalog.coordinateFrame !== "ICRS" || catalog.ordering !== "NESTED" || !Array.isArray(catalog.layers)) {
    throw new Error("Coverage catalog must declare ICRS/NESTED layers");
  }
  return { bundleId, bundleSha256, catalogRevision, catalogEtag, publicReleaseId, catalog };
}

function assertSameSnapshot(before: ServiceSnapshot, after: ServiceSnapshot): void {
  const fields: Array<keyof ServiceSnapshot> = ["bundleId", "bundleSha256", "catalogRevision", "catalogEtag", "publicReleaseId"];
  const changed = fields.filter((field) => before[field] !== after[field]);
  if (changed.length) throw new Error(`Assets public identity changed during export: ${changed.join(", ")}`);
}

function catalogLayers(snapshot: ServiceSnapshot): JsonRecord[] {
  const layers = snapshot.catalog.layers;
  if (!Array.isArray(layers)) throw new Error("Coverage catalog has no layers array");
  return layers.map((layer, index) => record(layer, `Coverage catalog layer ${index}`));
}

function checkedLayer(layer: JsonRecord): {
  layer: ResourcePackageLayerRecord;
  catalogCoverageRevision: LayerProvenance["catalogCoverageRevision"];
} {
  const layerId = requiredString(layer.layerId, "Coverage layer ID");
  const surveyId = requiredString(layer.surveyId, `Coverage layer ${layerId} survey ID`);
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(surveyId)) throw new Error(`Coverage layer ${layerId} has an unsafe survey ID`);
  const releaseId = requiredString(layer.releaseId, `Coverage layer ${layerId} release ID`);
  const productId = requiredString(layer.productId, `Coverage layer ${layerId} product ID`);
  const product = requiredString(layer.product, `Coverage layer ${layerId} product name`);
  const maxOrder = layer.maxOrder;
  if (!Number.isSafeInteger(maxOrder) || (maxOrder as number) < 0 || (maxOrder as number) > 13) throw new Error(`Coverage layer ${layerId} has an invalid native maxOrder`);

  let catalogCoverageRevision: LayerProvenance["catalogCoverageRevision"] = null;
  const revisionField = Object.hasOwn(layer, "coverageRevision") ? "coverageRevision" : Object.hasOwn(layer, "revision") ? "revision" : null;
  if (revisionField && typeof layer[revisionField] === "string") {
    catalogCoverageRevision = { field: revisionField, value: validSha256(layer[revisionField], `Coverage layer ${layerId} ${revisionField}`) };
  } else if (revisionField && layer[revisionField] !== null && layer[revisionField] !== undefined) {
    throw new Error(`Coverage layer ${layerId} has an invalid ${revisionField}`);
  }

  const sourceEvidence = layer.sourceEvidence && typeof layer.sourceEvidence === "object" ? layer.sourceEvidence as JsonRecord : {};
  const recipe = layer.recipe && typeof layer.recipe === "object" ? layer.recipe as JsonRecord : {};
  const precision = layer.geometryPrecision ?? sourceEvidence.precision ?? recipe.precision;
  const completeness = layer.completeness ?? sourceEvidence.completeness ?? "unknown";
  const typedLayer: ResourcePackageLayerRecord = {
    layerId,
    surveyId,
    releaseId,
    productId,
    product,
    modality: typeof layer.modality === "string" ? layer.modality : "coverage",
    path: `mocs/${layerId}.moc.fits`,
    sizeBytes: 1,
    sha256: "0".repeat(64),
    maxOrder: maxOrder as number,
    ...(catalogCoverageRevision ? { coverageRevision: catalogCoverageRevision.value } : {}),
    ...(typeof precision === "string" ? { geometryPrecision: precision } : {}),
    ...(typeof completeness === "string" ? { completeness: completeness as ResourcePackageLayerRecord["completeness"] } : {}),
  };
  return { layer: typedLayer, catalogCoverageRevision };
}

async function fetchMoc(baseUrl: URL, layerId: string, fetcher: Fetcher): Promise<{ bytes: Buffer; responseSha256: string }> {
  const url = new URL(`/api/v1/coverage/layers/${encodeURIComponent(layerId)}/moc.fits`, baseUrl);
  const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200) throw new Error(`MOC for ${layerId} returned HTTP ${response.status}`);
  const headerHash = response.headers.get("x-content-sha256");
  if (!headerHash || !/^[a-f\d]{64}$/i.test(headerHash)) throw new Error(`MOC for ${layerId} is missing a valid X-Content-SHA256`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const responseSha256 = sha256(bytes);
  if (responseSha256 !== headerHash.toLowerCase()) throw new Error(`MOC response checksum mismatch for ${layerId}`);
  return { bytes, responseSha256 };
}

function packageIdentity(publicReleaseId: string | null, bundleId: string, surveyId: string): { packageId: string; packageVersion: string } {
  return {
    packageId: `assets-live-${surveyId}`,
    packageVersion: publicReleaseId ?? bundleId,
  };
}

function outputSummary(bytes: Buffer): { cells: number; omittedLayers: number } {
  const value = JSON.parse(bytes.toString("utf8")) as { surveyUnion?: { cells?: unknown[]; omittedLayers?: unknown[] } };
  return { cells: value.surveyUnion?.cells?.length ?? 0, omittedLayers: value.surveyUnion?.omittedLayers?.length ?? 0 };
}

export async function exportLiveCoverageHealpix(input: {
  baseUrl: string;
  outputDirectory: string;
  fetcher?: Fetcher;
  now?: () => string;
}): Promise<LiveCoverageHealpixExportSummary> {
  const baseUrl = new URL(input.baseUrl);
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("Assets base URL must use HTTP or HTTPS");
  const outputDirectory = path.resolve(input.outputDirectory);
  const fetcher = input.fetcher ?? globalThis.fetch;
  const now = input.now ?? (() => new Date().toISOString());
  try {
    await lstat(outputDirectory);
    throw new Error(`Output directory already exists: ${outputDirectory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const before = await captureSnapshot(baseUrl, fetcher);
  const sourceLayers = catalogLayers(before).map((source) => checkedLayer(source));
  if (!sourceLayers.length) throw new Error("Coverage catalog contains no layers to export");
  const seenLayerIds = new Set<string>();
  for (const entry of sourceLayers) {
    if (seenLayerIds.has(entry.layer.layerId)) throw new Error(`Coverage catalog contains duplicate layer ${entry.layer.layerId}`);
    seenLayerIds.add(entry.layer.layerId);
  }

  const mocBytesByLayer = new Map<string, Uint8Array>();
  const provenance: LayerProvenance[] = [];
  for (const entry of sourceLayers.sort((left, right) => left.layer.surveyId.localeCompare(right.layer.surveyId) || left.layer.layerId.localeCompare(right.layer.layerId))) {
    const { bytes, responseSha256 } = await fetchMoc(baseUrl, entry.layer.layerId, fetcher);
    const moc = decodeNativeMoc(bytes);
    if (moc.maxOrder !== entry.layer.maxOrder) throw new Error(`Coverage layer native maxOrder mismatch for ${entry.layer.layerId}`);
    if (entry.catalogCoverageRevision && moc.revision !== entry.catalogCoverageRevision.value) {
      throw new Error(`Coverage layer native revision mismatch for ${entry.layer.layerId}`);
    }
    entry.layer.sha256 = responseSha256;
    entry.layer.sizeBytes = bytes.length;
    mocBytesByLayer.set(entry.layer.layerId, bytes);
    provenance.push({
      layerId: entry.layer.layerId,
      surveyId: entry.layer.surveyId,
      releaseId: entry.layer.releaseId,
      productId: entry.layer.productId!,
      product: entry.layer.product!,
      nativeRevision: moc.revision,
      catalogCoverageRevision: entry.catalogCoverageRevision,
      catalogRevisionStatus: entry.catalogCoverageRevision ? "matched" : "missing",
      mocSha256: responseSha256,
      nativeMaxOrder: moc.maxOrder,
      nativeAvailableOrders: moc.availableOrders,
    });
  }

  const grouped = new Map<string, Array<ResourcePackageLayerRecord>>();
  for (const entry of sourceLayers) {
    const layers = grouped.get(entry.layer.surveyId) ?? [];
    layers.push(entry.layer);
    grouped.set(entry.layer.surveyId, layers);
  }

  const parent = path.dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  const stagedDirectory = await mkdtemp(path.join(parent, ".assets-healpix-export-"));
  const surveySummaries: LiveCoverageHealpixExportSummary["surveys"] = [];
  try {
    for (const [surveyId, layers] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const identity = packageIdentity(before.publicReleaseId, before.bundleId, surveyId);
      const files = buildResourcePackageHealpixFiles({
        ...identity,
        surveyId,
        layers,
        mocBytesByLayer,
      });
      const surveyDirectory = path.join(stagedDirectory, surveyId);
      await mkdir(path.join(surveyDirectory, "healpix"), { recursive: true });
      const orders = [];
      for (const file of files) {
        const relativePath = path.join(surveyId, file.path);
        await writeFile(path.join(stagedDirectory, relativePath), file.bytes, { flag: "wx" });
        const counts = outputSummary(file.bytes);
        orders.push({ order: file.order, path: path.join(outputDirectory, relativePath), unionCellCount: counts.cells, omittedLayerCount: counts.omittedLayers, sha256: file.sha256 });
      }
      const layerProvenance = provenance.filter((entry) => entry.surveyId === surveyId);
      const provenanceDocument = {
        schemaVersion: 1,
        generatedAt: now(),
        source: {
          baseUrl: baseUrl.origin,
          bundle: { id: before.bundleId, sha256: before.bundleSha256 },
          catalog: { revision: before.catalogRevision, etag: before.catalogEtag, publicReleaseId: before.publicReleaseId },
        },
        surveyId,
        layers: layerProvenance,
        outputs: files.map((file) => ({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 })),
      };
      const provenancePath = path.join(surveyDirectory, "provenance.json");
      await writeFile(provenancePath, `${JSON.stringify(provenanceDocument, null, 2)}\n`, { flag: "wx" });
      surveySummaries.push({
        surveyId,
        directory: path.join(outputDirectory, surveyId),
        layerCount: layers.length,
        orders,
        provenancePath: path.join(outputDirectory, surveyId, "provenance.json"),
      });
    }

    const after = await captureSnapshot(baseUrl, fetcher);
    assertSameSnapshot(before, after);
    await mkdir(outputDirectory);
    const committed: string[] = [];
    try {
      for (const summary of surveySummaries) {
        await rename(path.join(stagedDirectory, summary.surveyId), path.join(outputDirectory, summary.surveyId));
        committed.push(summary.surveyId);
      }
    } catch (error) {
      for (const surveyId of committed) await rm(path.join(outputDirectory, surveyId), { recursive: true, force: true });
      await rmdir(outputDirectory).catch(() => undefined);
      throw error;
    }
    await rm(stagedDirectory, { recursive: true, force: true });
  } catch (error) {
    await rm(stagedDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    outputDirectory,
    bundleId: before.bundleId,
    bundleSha256: before.bundleSha256,
    catalogRevision: before.catalogRevision,
    publicReleaseId: before.publicReleaseId,
    surveys: surveySummaries,
  };
}

async function main(): Promise<void> {
  const [, , baseUrl, outputDirectory, ...extra] = process.argv;
  if (!baseUrl || !outputDirectory || extra.length) {
    throw new Error("Usage: npm run coverage:export-healpix -- <assets-base-url> <new-output-directory>");
  }
  const result = await exportLiveCoverageHealpix({ baseUrl, outputDirectory });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
