import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { inferredPublicAssetDeliveryClass, type PublicAssetManifest, type PublicAssetRecord } from "../server/types.js";
import { publicReleaseBundleDigest } from "../server/catalog.js";
import { assertRecordPublishable, isDeniedLayerId, isDeniedSurvey, sanitizeReleaseControlDocument } from "../server/publication-policy.js";

const root = path.resolve(process.env.ASSET_WORKTREE_ROOT ?? process.cwd());
const artifactRoot = path.join(root, "artifacts", "public-survey-footprints");

interface ProvenanceFile {
  path: string;
  sha256: string;
}

interface ProvenanceDocument {
  generatedAt: string;
  statistics: {
    releases: number;
    products: number;
    acquired: number;
    overview_only: number;
    awaiting_geometry: number;
    manifestFootprints: number;
    packages: number;
  };
  inputs: Record<string, ProvenanceFile>;
  files: {
    manifest: ProvenanceFile;
    catalog: ProvenanceFile;
    packages: Array<{ id: string; version: string; archive: string; sizeBytes: number; sha256: string }>;
  };
}

interface GeometryIndex {
  artifacts: Array<{
    surveyId: string;
    releaseId: string;
    product: string;
    sourceUrl: string;
    filePath: string;
    byteLength: number;
    sha256: string;
    mediaType?: string;
    polygonCount?: number;
    rowCount?: number;
    selectedRowCount?: number;
    filter?: string;
    tileRadiusDeg?: number;
    parser: string;
  }>;
}

interface PackageCatalog {
  packages: Array<{
    id: string;
    name: string;
    description: string;
    surveyId: string;
    version: string;
    archiveUrl: string;
    sizeBytes: number;
    sha256: string;
    releases?: string[];
    sources?: Array<{ releaseId: string; url: string }>;
  }>;
}

interface LayerBuildPlan {
  schemaVersion: number;
  sourceDateEpoch: number;
  builds: Array<{ spec: string; output: string; expectedSha256: string }>;
}

interface LayerSpec {
  layerId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
  coverageRole: string;
  dataOrigin: string;
  sourceTier: string;
  sourceUrl: string;
}

interface LayerFileRecord {
  path: string;
  sha256: string;
  sizeBytes: number;
}

interface LayerProvenance {
  layerId: string;
  coreVersion: string;
  coverageRole: string;
  dataOrigin: string;
  sourceTier: string;
  outputs: {
    moc: LayerFileRecord;
    query: LayerFileRecord;
    preview: LayerFileRecord;
    statistics: LayerFileRecord;
  };
}

interface ReleaseHistoryDocument {
  schemaVersion: number;
  releases: Array<{
    releaseId: string;
    sequence: number;
    bundleId: string;
    releasedAt: string;
    notes?: string;
    packages: Array<{ id: string; version: string; name: string; sizeBytes: number; sha256: string; downloadUrl: string }>;
  }>;
}

async function json<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function digest(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function relative(filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96);
}

function projectionOrder(fileName: string, kind: "query" | "preview"): number {
  const match = fileName.match(new RegExp(`${kind}-order(\\d+)\\.json$`));
  if (!match) throw new Error(`Layer ${kind} projection has no locked order: ${fileName}`);
  return Number(match[1]);
}

async function asset(input: Omit<PublicAssetRecord, "path" | "sizeBytes" | "sha256"> & { filePath: string; expectedBytes?: number; expectedSha256?: string; pathOverride?: string; allowMissing?: boolean; sanitizeForPublication?: boolean }): Promise<PublicAssetRecord> {
  let bytes: Buffer | null;
  try {
    bytes = await readFile(input.filePath);
  } catch (error) {
    if (!input.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT" || input.expectedBytes === undefined || input.expectedSha256 === undefined) throw error;
    bytes = null;
  }
  let sizeBytes = bytes?.length ?? input.expectedBytes!;
  let sha256 = bytes ? sha256Bytes(bytes) : input.expectedSha256!;
  if (input.expectedBytes !== undefined && sizeBytes !== input.expectedBytes) throw new Error(`Size mismatch: ${relative(input.filePath)}`);
  if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) throw new Error(`SHA-256 mismatch: ${relative(input.filePath)}`);
  const { filePath, expectedBytes: _expectedBytes, expectedSha256: _expectedSha256, pathOverride: _pathOverride, allowMissing: _allowMissing, sanitizeForPublication: _sanitizeForPublication, ...record } = input;
  const relativePath = input.pathOverride ?? relative(filePath);
  if (bytes && input.sanitizeForPublication) {
    const sanitized = sanitizeReleaseControlDocument(relativePath, bytes);
    if (sanitized) {
      sizeBytes = sanitized.length;
      sha256 = sha256Bytes(sanitized);
    }
  }
  return { ...record, deliveryClass: inferredPublicAssetDeliveryClass({ path: relativePath, kind: record.kind }), path: relativePath, sizeBytes, sha256 };
}

async function verifiedProvenanceFiles(provenance: ProvenanceDocument): Promise<void> {
  const records = [...Object.values(provenance.inputs), provenance.files.manifest, provenance.files.catalog];
  for (const record of records) {
    const filePath = path.resolve(artifactRoot, record.path);
    if (await digest(filePath) !== record.sha256) throw new Error(`Provenance mismatch: ${record.path}`);
  }
}

async function build(): Promise<PublicAssetManifest> {
  const provenancePath = path.join(artifactRoot, "provenance.json");
  const geometryIndexPath = path.join(artifactRoot, "raw", "geometry", "index.json");
  const packageCatalogPath = path.join(artifactRoot, "packages", "catalog.json");
  const provenance = await json<ProvenanceDocument>(provenancePath);
  const geometryIndex = await json<GeometryIndex>(geometryIndexPath);
  const packageCatalog = await json<PackageCatalog>(packageCatalogPath);
  const layerPlanPath = path.join(root, "src", "layers", "public-build-plan.json");
  const layerPlan = await json<LayerBuildPlan>(layerPlanPath);
  await verifiedProvenanceFiles(provenance);

  const files: PublicAssetRecord[] = [];
  const push = async (entry: Parameters<typeof asset>[0]): Promise<void> => { files.push(await asset(entry)); };

  await push({
    id: "manifest-canonical", kind: "manifest", label: "Canonical NSIDE 16 footprint manifest",
    description: "The canonical ICRS HEALPix footprint manifest used by Astro Survey Atlas.",
    filePath: path.join(root, "src", "footprints", "survey-footprints.json"), downloadName: "survey-footprints.json", mediaType: "application/json",
    expectedSha256: provenance.inputs.canonicalManifest?.sha256, sanitizeForPublication: true,
  });
  await push({
    id: "manifest-normalized", kind: "manifest", label: "Normalized release manifest",
    description: "Normalized copy of the canonical footprint manifest included in the release bundle.",
    filePath: path.join(artifactRoot, provenance.files.manifest.path), downloadName: "survey-footprints-normalized.json", mediaType: "application/json",
    expectedSha256: provenance.files.manifest.sha256, sanitizeForPublication: true,
  });
  await push({
    id: "manifest-survey-catalog", kind: "manifest", label: "Public survey catalog",
    description: "Survey metadata, modalities, public products, acquisition states and outstanding geometry work.",
    filePath: path.join(root, "src", "surveys", "survey-catalog.json"), downloadName: "survey-catalog.json", mediaType: "application/json",
    sanitizeForPublication: true,
  });
  await push({
    id: "documentation-moc-method", kind: "documentation", label: "MOC calculation and evidence method",
    description: "Calculation notes for native MOC ingestion, Euclid Q1 polygons and DESI observed-tile rasterization.",
    filePath: path.join(root, "docs", "public-footprint-moc-method.md"), downloadName: "public-footprint-moc-method.md", mediaType: "text/markdown; charset=utf-8",
  });
  await push({
    id: "documentation-moc-core-contract", kind: "documentation", label: "Assets MOC Core contract",
    description: "Scientific enums, deterministic build lifecycle, CLI boundary and Resource Package v3 contract.",
    filePath: path.join(root, "docs", "moc-core-contract.md"), downloadName: "moc-core-contract.md", mediaType: "text/markdown; charset=utf-8",
  });
  await push({
    id: "documentation-resource-package-integration", kind: "documentation", label: "Resource Package v3 integration guide",
    description: "Standalone trust, validation and installation workflow for projects that consume Assets coverage packages.",
    filePath: path.join(root, "docs", "resource-package-integration.md"), downloadName: "resource-package-integration.md", mediaType: "text/markdown; charset=utf-8",
  });
  await push({
    id: "documentation-architecture-boundary", kind: "documentation", label: "Assets and Atlas architecture boundary",
    description: "Assets responsibilities, independent project boundaries and the one-shot data-warehouse handoff.",
    filePath: path.join(root, "docs", "architecture-boundary.md"), downloadName: "architecture-boundary.md", mediaType: "text/markdown; charset=utf-8",
  });
  await push({
    id: "documentation-public-artifact-storage", kind: "documentation", label: "Public artifact storage and migration",
    description: "Versioned object-storage publication, evidence boundaries, migration steps and runtime compatibility requirements.",
    filePath: path.join(root, "docs", "public-artifact-storage.md"), downloadName: "public-artifact-storage.md", mediaType: "text/markdown; charset=utf-8",
  });
  await push({
    id: "documentation-data-warehouse-requirements", kind: "documentation", label: "Assets data-warehouse requirements",
    description: "Assets-owned CRD handoff, status, sink and coverage scanner requirements for data-warehouse.",
    filePath: path.join(root, "docs", "data-warehouse-requirements.md"), downloadName: "data-warehouse-requirements.md", mediaType: "text/markdown; charset=utf-8",
  });
  await push({
    id: "metadata-resource-package-v3-schema", kind: "metadata", label: "Resource Package v3 JSON Schema",
    description: "Machine-readable manifest shape used by public package installers and conformance tooling.",
    filePath: path.join(root, "contracts", "resource-package-v3.schema.json"), downloadName: "resource-package-v3.schema.json", mediaType: "application/json",
  });
  await push({
    id: "metadata-coverage-task-schema", kind: "metadata", label: "Public coverage task handoff schema",
    description: "Assets-side input used to render standard data-warehouse CRDs; credential storage, sink semantics and task history remain outside this schema.",
    filePath: path.join(root, "contracts", "coverage-task-v1.schema.json"), downloadName: "coverage-task-v1.schema.json", mediaType: "application/json",
  });
  await push({
    id: "metadata-layer-registry", kind: "metadata", label: "Stable coverage layer registry",
    description: "Assets-owned stable layer IDs and scientific classifications for reviewed Core layers.",
    filePath: path.join(root, "src", "layers", "layer-registry.json"), downloadName: "layer-registry.json", mediaType: "application/json",
    sanitizeForPublication: true,
  });
  await push({
    id: "metadata-moc-source-registry", kind: "metadata", label: "Public MOC source registry",
    description: "Allowlisted MOC/HiPS discovery records, locked orders, coverage roles, provenance requirements and attribution status.",
    filePath: path.join(root, "src", "moc-sources", "source-registry.json"), downloadName: "moc-source-registry.json", mediaType: "application/json",
  });
  await push({
    id: "sdk-moc-core-lock", kind: "sdk", label: "MOC Core dependency lock",
    description: "Pinned scientific dependencies for the shared Astro Survey MOC Core build environment.",
    filePath: path.join(root, "requirements", "requirements.lock"), downloadName: "requirements.lock", mediaType: "text/plain; charset=utf-8", version: "1.0.0",
  });
  await push({
    id: "sdk-moc-core-source", kind: "sdk", label: "MOC Core source provenance",
    description: "Repository commit and wheel hash for the organization-level Astro Survey MOC Core.",
    filePath: path.join(root, "requirements", "moc-core-source.json"), downloadName: "moc-core-source.json", mediaType: "application/json", version: "1.0.0",
  });
  await push({
    id: "sdk-moc-core-wheel-1-0-0", kind: "sdk", label: "Astro Survey MOC Core Python wheel",
    description: "Pinned offline shared MOC Core wheel for deterministic Assets and Workspace layer builds and validation.",
    filePath: path.join(artifactRoot, "moc-core", "astro_survey_moc_core-1.0.0-py3-none-any.whl"),
    downloadName: "astro_survey_moc_core-1.0.0-py3-none-any.whl", mediaType: "application/zip", version: "1.0.0",
    expectedSha256: "66d0d07c3afaf74141f967c80eaf359180d06a07f6805494a4aea086d6339642",
  });
  await push({
    id: "metadata-public-build-plan", kind: "metadata", label: "Locked public Core build plan",
    description: "Offline public-layer build order, source-date epoch and authoritative MOC hashes.",
    filePath: layerPlanPath, downloadName: "public-build-plan.json", mediaType: "application/json",
    sanitizeForPublication: true,
  });
  for (const entry of layerPlan.builds) {
    const specPath = path.join(root, entry.spec);
    const spec = await json<LayerSpec>(specPath);
    if (isDeniedSurvey(spec.surveyId) || isDeniedLayerId(spec.layerId)) continue;
    const outputRoot = path.join(root, entry.output);
    const provenancePath = path.join(outputRoot, "provenance.json");
    const layerProvenance = await json<LayerProvenance>(provenancePath);
    if (layerProvenance.layerId !== spec.layerId || layerProvenance.outputs.moc.sha256 !== entry.expectedSha256) {
      throw new Error(`Public layer lock mismatch: ${spec.layerId}`);
    }
    const identity = {
      surveyId: spec.surveyId,
      releaseId: spec.releaseId,
      product: spec.product,
      sourceUrl: spec.sourceUrl,
    };
    const layerLabel = `${spec.surveyId.toUpperCase()} · ${spec.product}`;
    const layerDescription = `${spec.coverageRole} (${spec.dataOrigin}, ${spec.sourceTier}) generated by Assets MOC Core ${layerProvenance.coreVersion}.`;
    const queryOrder = projectionOrder(layerProvenance.outputs.query.path, "query");
    const previewOrder = projectionOrder(layerProvenance.outputs.preview.path, "preview");
    await push({
      id: `layer-${slug(spec.layerId)}-moc`, kind: "moc", label: `${layerLabel} authoritative MOC`,
      description: layerDescription, filePath: path.join(outputRoot, layerProvenance.outputs.moc.path),
      downloadName: `${spec.layerId}.moc.fits`, mediaType: "application/fits", expectedBytes: layerProvenance.outputs.moc.sizeBytes,
      expectedSha256: layerProvenance.outputs.moc.sha256, ...identity,
    });
    await push({
      id: `layer-${slug(spec.layerId)}-query-order${queryOrder}`, kind: "geometry", label: `${layerLabel} order-${queryOrder} query projection`,
      description: "Fixed-order NESTED HEALPix query projection derived from the authoritative FITS MOC.",
      filePath: path.join(outputRoot, layerProvenance.outputs.query.path), downloadName: `${spec.layerId}-query-order${queryOrder}.json`,
      mediaType: "application/json", expectedBytes: layerProvenance.outputs.query.sizeBytes, expectedSha256: layerProvenance.outputs.query.sha256, ...identity,
    });
    await push({
      id: `layer-${slug(spec.layerId)}-preview-order${previewOrder}`, kind: "geometry", label: `${layerLabel} order-${previewOrder} preview projection`,
      description: "Fixed-order NESTED HEALPix preview projection derived from the authoritative FITS MOC.",
      filePath: path.join(outputRoot, layerProvenance.outputs.preview.path), downloadName: `${spec.layerId}-preview-order${previewOrder}.json`,
      mediaType: "application/json", expectedBytes: layerProvenance.outputs.preview.sizeBytes, expectedSha256: layerProvenance.outputs.preview.sha256, ...identity,
    });
    await push({
      id: `layer-${slug(spec.layerId)}-statistics`, kind: "metadata", label: `${layerLabel} statistics`,
      description: "Area, cell count and fixed-order projection counts for the authoritative layer.",
      filePath: path.join(outputRoot, layerProvenance.outputs.statistics.path), downloadName: `${spec.layerId}-statistics.json`,
      mediaType: "application/json", expectedBytes: layerProvenance.outputs.statistics.sizeBytes, expectedSha256: layerProvenance.outputs.statistics.sha256, ...identity,
    });
    await push({
      id: `layer-${slug(spec.layerId)}-lock`, kind: "metadata", label: `${layerLabel} locked recipe`,
      description: "Offline recipe and input snapshot lock used to build this public layer.",
      filePath: specPath, downloadName: `${spec.layerId}.lock.json`, mediaType: "application/json", ...identity,
    });
  }
  await push({
    id: "metadata-package-catalog", kind: "metadata", label: "Resource package catalog",
    description: "Current downloadable resource-package versions, sizes and SHA-256 values.",
    filePath: packageCatalogPath, downloadName: "resource-package-catalog.json", mediaType: "application/json",
    expectedSha256: provenance.files.catalog.sha256, sanitizeForPublication: true,
  });

  for (const record of geometryIndex.artifacts) {
    if (isDeniedSurvey(record.surveyId)) continue;
    const logicalPath = path.join("artifacts", "public-survey-footprints", "raw", "geometry", record.filePath);
    if (inferredPublicAssetDeliveryClass({ path: logicalPath, kind: "geometry" }) === "evidence") continue;
    const geometryDescription = record.polygonCount !== undefined
      ? `${record.polygonCount} official polygons. ${record.parser}.`
      : `${record.selectedRowCount ?? 0}/${record.rowCount ?? 0} official observed tile rows (${record.filter ?? "no filter"}); ${record.tileRadiusDeg ?? "unknown"} deg tile radius. ${record.parser}.`;
    await push({
      id: `geometry-${slug(`${record.surveyId}-${record.releaseId}-${record.product}`)}`, kind: "geometry",
      label: `${record.surveyId.toUpperCase()} · ${record.product} source geometry`,
      description: geometryDescription, filePath: path.join(artifactRoot, "raw", "geometry", record.filePath),
      downloadName: record.filePath, mediaType: record.mediaType ?? (record.filePath.endsWith(".fits") ? "application/fits" : "application/zip"), expectedBytes: record.byteLength, expectedSha256: record.sha256,
      surveyId: record.surveyId, releaseId: record.releaseId, product: record.product, sourceUrl: record.sourceUrl,
    });
  }

  const provenancePackages = new Map(provenance.files.packages.map((entry) => [`${entry.id}@${entry.version}`, entry]));
  const packageStagingRoot = process.env.ASSETS_PACKAGE_STAGING_ROOT ? path.resolve(process.env.ASSETS_PACKAGE_STAGING_ROOT) : undefined;
  const publicPackages = packageCatalog.packages.filter((record) => !isDeniedSurvey(record.surveyId));
  for (const record of publicPackages) {
    const expected = provenancePackages.get(`${record.id}@${record.version}`);
    if (!expected) throw new Error(`Package is absent from provenance: ${record.id}@${record.version}`);
    const packagePath = packageStagingRoot
      ? path.join(packageStagingRoot, path.basename(record.archiveUrl))
      : path.join(artifactRoot, "packages", record.archiveUrl);
    await push({
      id: `package-${slug(`${record.id}-${record.version}`)}`, kind: "package", label: record.name, description: record.description,
      filePath: packagePath, pathOverride: path.join("artifacts", "public-survey-footprints", "packages", path.basename(record.archiveUrl)),
      downloadName: path.basename(record.archiveUrl), mediaType: "application/zip", allowMissing: !packageStagingRoot,
      expectedBytes: record.sizeBytes, expectedSha256: record.sha256, surveyId: record.surveyId,
      releaseId: record.sources?.[0]?.releaseId ?? record.releases?.[0], version: record.version, sourceUrl: record.sources?.[0]?.url,
    });
  }

  const bundleId = `public-survey-footprints-${provenance.generatedAt.slice(0, 10)}`;
  const historyPath = path.join(artifactRoot, "release-history.json");
  let history: ReleaseHistoryDocument;
  if (existsSync(historyPath)) {
    history = await json<ReleaseHistoryDocument>(historyPath);
    if (history.schemaVersion !== 1 || !Array.isArray(history.releases)) {
      throw new Error("Release history document is malformed");
    }
  } else {
    history = {
      schemaVersion: 1,
      releases: [{
        releaseId: `${bundleId}-1`,
        sequence: 1,
        bundleId,
        releasedAt: provenance.generatedAt,
        packages: publicPackages.map((record) => ({
          id: record.id,
          version: record.version,
          name: record.name,
          sizeBytes: record.sizeBytes,
          sha256: record.sha256,
          downloadUrl: `/api/v1/resource-packages/${record.id}/versions/${record.version}/download`,
        })),
      }],
    };
    await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  }
  await push({
    id: "metadata-release-history", kind: "metadata", label: "Release history",
    description: "Public release history with per-release package versions, sizes and SHA-256 values.",
    filePath: historyPath, downloadName: "release-history.json", mediaType: "application/json",
  });

  files.sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  if (new Set(files.map((entry) => entry.id)).size !== files.length) throw new Error("Release manifest contains duplicate asset IDs");
  const evidenceLeak = files.find((entry) => entry.deliveryClass !== "runtime");
  if (evidenceLeak) throw new Error(`Public release manifest must not contain evidence records: ${evidenceLeak.id}`);
  for (const entry of files) assertRecordPublishable(entry);
  const canonicalFootprints = await json<{ footprints: Array<{ surveyId: string }> }>(path.join(root, "src", "footprints", "survey-footprints.json"));
  const publicFootprintCount = canonicalFootprints.footprints.filter((entry) => !isDeniedSurvey(entry.surveyId)).length;
  const bundleSha256 = publicReleaseBundleDigest(files);
  const totalBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const runtimeBytes = files.filter((entry) => entry.deliveryClass === "runtime").reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const evidenceBytes = files.filter((entry) => entry.deliveryClass === "evidence").reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    schemaVersion: 1,
    generatedAt: provenance.generatedAt,
    bundle: { id: bundleId, sha256: bundleSha256 },
    statistics: {
      releases: provenance.statistics.releases,
      products: provenance.statistics.products,
      acquired: provenance.statistics.acquired,
      overviewOnly: provenance.statistics.overview_only,
      awaitingGeometry: provenance.statistics.awaiting_geometry,
      footprints: publicFootprintCount,
      packages: publicPackages.length,
      rawMocFiles: files.filter((entry) => entry.kind === "moc").length,
      totalBytes,
      runtimeBytes,
      evidenceBytes,
    },
    files,
  };
}

const manifest = await build();
await writeFile(path.join(artifactRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Built ${manifest.bundle.id}: ${manifest.files.length} files, ${manifest.statistics.totalBytes} bytes, ${manifest.bundle.sha256}`);
