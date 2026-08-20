import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PublicAssetKind, PublicAssetManifest, PublicAssetRecord } from "../server/types.js";

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

interface RawMocIndex {
  artifacts: Array<{
    surveyId: string;
    releaseId: string;
    product: string;
    sourceId: string;
    sourceUrl: string;
    metadataUrl: string;
    fitsPath: string;
    metadataPath: string;
    byteLength: number;
    sha256: string;
  }>;
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

async function json<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
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

async function asset(input: Omit<PublicAssetRecord, "path" | "sizeBytes" | "sha256"> & { filePath: string; expectedBytes?: number; expectedSha256?: string }): Promise<PublicAssetRecord> {
  const details = await stat(input.filePath);
  const sha256 = await digest(input.filePath);
  if (input.expectedBytes !== undefined && details.size !== input.expectedBytes) throw new Error(`Size mismatch: ${relative(input.filePath)}`);
  if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) throw new Error(`SHA-256 mismatch: ${relative(input.filePath)}`);
  const { filePath, expectedBytes: _expectedBytes, expectedSha256: _expectedSha256, ...record } = input;
  return { ...record, path: relative(filePath), sizeBytes: details.size, sha256 };
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
  const mocIndexPath = path.join(artifactRoot, "raw", "moc", "index.json");
  const geometryIndexPath = path.join(artifactRoot, "raw", "geometry", "index.json");
  const packageCatalogPath = path.join(artifactRoot, "packages", "catalog.json");
  const provenance = await json<ProvenanceDocument>(provenancePath);
  const mocIndex = await json<RawMocIndex>(mocIndexPath);
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
    expectedSha256: provenance.inputs.canonicalManifest?.sha256,
  });
  await push({
    id: "manifest-normalized", kind: "manifest", label: "Normalized release manifest",
    description: "Normalized copy of the canonical footprint manifest included in the release bundle.",
    filePath: path.join(artifactRoot, provenance.files.manifest.path), downloadName: "survey-footprints-normalized.json", mediaType: "application/json",
    expectedSha256: provenance.files.manifest.sha256,
  });
  await push({
    id: "manifest-survey-catalog", kind: "manifest", label: "Public survey catalog",
    description: "Survey metadata, modalities, public products, acquisition states and outstanding geometry work.",
    filePath: path.join(root, "src", "surveys", "survey-catalog.json"), downloadName: "survey-catalog.json", mediaType: "application/json",
  });
  await push({
    id: "ledger-products", kind: "ledger", label: "Product coverage status ledger",
    description: "Product-level acquisition status, geometry source and outstanding calculation work.",
    filePath: path.join(artifactRoot, "sources.json"), downloadName: "public-footprint-product-status.json", mediaType: "application/json",
    expectedSha256: provenance.inputs.sources?.sha256,
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
    id: "metadata-layer-registry", kind: "metadata", label: "Stable coverage layer registry",
    description: "Assets-owned stable layer IDs and scientific classifications for reviewed Core layers.",
    filePath: path.join(root, "src", "layers", "layer-registry.json"), downloadName: "layer-registry.json", mediaType: "application/json",
  });
  await push({
    id: "sdk-moc-core-lock", kind: "sdk", label: "MOC Core dependency lock",
    description: "Pinned scientific dependencies used when building scanner and Assets MOC Core environments.",
    filePath: path.join(root, "requirements", "moc-core.lock"), downloadName: "moc-core.lock", mediaType: "text/plain; charset=utf-8", version: "0.1.0",
  });
  await push({
    id: "sdk-moc-core-wheel-0-1-0", kind: "sdk", label: "Assets MOC Core Python wheel",
    description: "Pinned offline Astro Survey MOC Core SDK wheel for scanner image and Atlas finalizer integration.",
    filePath: path.join(artifactRoot, "moc-core", "astro_survey_atlas_assets-0.1.0-py3-none-any.whl"),
    downloadName: "astro_survey_atlas_assets-0.1.0-py3-none-any.whl", mediaType: "application/zip", version: "0.1.0",
    expectedSha256: "79ab6babbed2ea4559e4e5f444bf1ead79e87e8a954cde55f0258f7067af6df8",
  });
  await push({
    id: "metadata-public-build-plan", kind: "metadata", label: "Locked public Core build plan",
    description: "Offline public-layer build order, source-date epoch and authoritative MOC hashes.",
    filePath: layerPlanPath, downloadName: "public-build-plan.json", mediaType: "application/json",
  });
  for (const entry of layerPlan.builds) {
    const specPath = path.join(root, entry.spec);
    const spec = await json<LayerSpec>(specPath);
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
    await push({
      id: `layer-${slug(spec.layerId)}-moc`, kind: "moc", label: `${layerLabel} authoritative MOC`,
      description: layerDescription, filePath: path.join(outputRoot, layerProvenance.outputs.moc.path),
      downloadName: `${spec.layerId}.moc.fits`, mediaType: "application/fits", expectedBytes: layerProvenance.outputs.moc.sizeBytes,
      expectedSha256: layerProvenance.outputs.moc.sha256, ...identity,
    });
    await push({
      id: `layer-${slug(spec.layerId)}-query-order8`, kind: "geometry", label: `${layerLabel} order-8 query projection`,
      description: "Fixed-order NESTED HEALPix query projection derived from the authoritative FITS MOC.",
      filePath: path.join(outputRoot, layerProvenance.outputs.query.path), downloadName: `${spec.layerId}-query-order8.json`,
      mediaType: "application/json", expectedBytes: layerProvenance.outputs.query.sizeBytes, expectedSha256: layerProvenance.outputs.query.sha256, ...identity,
    });
    await push({
      id: `layer-${slug(spec.layerId)}-preview-order4`, kind: "geometry", label: `${layerLabel} order-4 preview projection`,
      description: "Fixed-order NESTED HEALPix preview projection derived from the authoritative FITS MOC.",
      filePath: path.join(outputRoot, layerProvenance.outputs.preview.path), downloadName: `${spec.layerId}-preview-order4.json`,
      mediaType: "application/json", expectedBytes: layerProvenance.outputs.preview.sizeBytes, expectedSha256: layerProvenance.outputs.preview.sha256, ...identity,
    });
    await push({
      id: `layer-${slug(spec.layerId)}-provenance`, kind: "provenance", label: `${layerLabel} provenance`,
      description: "Locked input, Core version, scientific classification and output hashes for this public layer.",
      filePath: provenancePath, downloadName: `${spec.layerId}-provenance.json`, mediaType: "application/json", ...identity,
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
    id: "provenance-release", kind: "provenance", label: "Release provenance and hashes",
    description: "Authoritative input, output and package SHA-256 provenance for this release.",
    filePath: provenancePath, downloadName: "provenance.json", mediaType: "application/json",
  });
  await push({
    id: "metadata-moc-index", kind: "metadata", label: "Native MOC source index",
    description: "Source URLs, retrieval metadata, byte lengths and hashes for native FITS MOCs.",
    filePath: mocIndexPath, downloadName: "moc-index.json", mediaType: "application/json",
    expectedSha256: provenance.inputs.rawMocIndex?.sha256,
  });
  await push({
    id: "metadata-geometry-index", kind: "metadata", label: "Raw geometry source index",
    description: "Raw Euclid and DESI geometry metadata, parser parameters, byte lengths and hashes.",
    filePath: geometryIndexPath, downloadName: "geometry-index.json", mediaType: "application/json",
    expectedSha256: provenance.inputs.rawGeometryIndex?.sha256,
  });
  await push({
    id: "metadata-package-catalog", kind: "metadata", label: "Resource package catalog",
    description: "Current downloadable resource-package versions, sizes and SHA-256 values.",
    filePath: packageCatalogPath, downloadName: "resource-package-catalog.json", mediaType: "application/json",
    expectedSha256: provenance.files.catalog.sha256,
  });

  const csstEvidence = [
    ["csst-coverage-job-snapshot", "metadata", "CSST W1 coverage job snapshot", "coverage-job-snapshot.json", "Workspace coverage request, scanner configuration and review decision for CSST W1 simulated wide-field images."],
    ["csst-input-manifest", "manifest", "CSST W1 input manifest", "input-manifest.json", "Complete 178,056-file W1_Phot manifest with WCS summaries, ETags and the reviewed exclusion."],
    ["csst-wcs-geometry-summary", "metadata", "CSST W1 WCS geometry summary", "wcs-geometry-summary.json", "Measured WCS bounds, HEALPix order, area, nominal-area comparison and anomaly decision."],
    ["csst-run-statistics", "metadata", "CSST W1 full-run statistics", "run-statistics.json", "Summed 64-shard Workspace and Elasticsearch coverage statistics."],
    ["csst-sample-report", "metadata", "CSST W1 sample and smoke report", "sample-report.json", "Restricted-directory samples, smoke result and full-run anomaly audit."],
    ["csst-provenance", "provenance", "CSST W1 provenance", "provenance.json", "CSST W1 source prefix, run IDs, connector configuration hash, static output hashes and release decision."],
  ] as const;
  for (const [id, kind, label, fileName, description] of csstEvidence) {
    await push({
      id, kind, label, description,
      filePath: path.join(artifactRoot, "csst", fileName), downloadName: `csst-w1-${fileName}`, mediaType: "application/json",
      surveyId: "csst", releaseId: "csst-sim-w1-20250731", product: "W1 simulated wide-field images",
    });
  }
  await push({
    id: "csst-w1-image-extent-moc-order8", kind: "moc", label: "CSST W1 simulated image WCS MOC",
    description: "Reviewed ICRS NUNIQ FITS MOC at maximum order 8 for the current W1_Phot WIDE images (354.759 deg2).",
    filePath: path.join(artifactRoot, "csst", "csst-w1-image-extent-order8.fits"), downloadName: "csst-w1-image-extent-order8.fits", mediaType: "application/fits",
    surveyId: "csst", releaseId: "csst-sim-w1-20250731", product: "W1 simulated wide-field images",
  });
  await push({
    id: "csst-w1-healpix-order8", kind: "geometry", label: "CSST W1 order-8 HEALPix image extent",
    description: "6,763 unique ICRS NESTED NSIDE 256 pixels used to build the reviewed FITS MOC.",
    filePath: path.join(artifactRoot, "csst", "healpix-order8.json"), downloadName: "csst-w1-healpix-order8.json", mediaType: "application/json",
    surveyId: "csst", releaseId: "csst-sim-w1-20250731", product: "W1 simulated wide-field images",
  });
  await push({
    id: "csst-w1-display-footprint-nside16", kind: "geometry", label: "CSST W1 website display footprint",
    description: "46 NESTED NSIDE 16 parent pixels derived from the reviewed order-8 WCS union for website display.",
    filePath: path.join(artifactRoot, "csst", "display-footprint-nside16.json"), downloadName: "csst-w1-display-footprint-nside16.json", mediaType: "application/json",
    surveyId: "csst", releaseId: "csst-sim-w1-20250731", product: "W1 simulated wide-field images",
  });

  for (const record of mocIndex.artifacts) {
    const baseId = `moc-${slug(`${record.surveyId}-${record.releaseId}-${record.product}-${record.sourceId}`)}`;
    await push({
      id: baseId, kind: "moc", label: `${record.surveyId.toUpperCase()} · ${record.product}`,
      description: `Native FITS MOC for ${record.releaseId}.`, filePath: path.join(artifactRoot, "raw", "moc", record.fitsPath),
      downloadName: record.fitsPath, mediaType: "application/fits", expectedBytes: record.byteLength, expectedSha256: record.sha256,
      surveyId: record.surveyId, releaseId: record.releaseId, product: record.product, sourceUrl: record.sourceUrl,
    });
    await push({
      id: `${baseId}-record`, kind: "metadata", label: `${record.surveyId.toUpperCase()} · ${record.product} source record`,
      description: `CDS/HiPS source metadata accompanying ${record.fitsPath}.`, filePath: path.join(artifactRoot, "raw", "moc", record.metadataPath),
      downloadName: record.metadataPath, mediaType: "application/json", surveyId: record.surveyId, releaseId: record.releaseId,
      product: record.product, sourceUrl: record.metadataUrl,
    });
  }

  for (const record of geometryIndex.artifacts) {
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
  for (const record of packageCatalog.packages) {
    const expected = provenancePackages.get(`${record.id}@${record.version}`);
    if (!expected) throw new Error(`Package is absent from provenance: ${record.id}@${record.version}`);
    await push({
      id: `package-${slug(`${record.id}-${record.version}`)}`, kind: "package", label: record.name, description: record.description,
      filePath: path.join(artifactRoot, "packages", record.archiveUrl), downloadName: path.basename(record.archiveUrl), mediaType: "application/zip",
      expectedBytes: record.sizeBytes, expectedSha256: record.sha256, surveyId: record.surveyId,
      releaseId: record.sources?.[0]?.releaseId ?? record.releases?.[0], version: record.version, sourceUrl: record.sources?.[0]?.url,
    });
  }

  files.sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  if (new Set(files.map((entry) => entry.id)).size !== files.length) throw new Error("Release manifest contains duplicate asset IDs");
  const bundleSha256 = createHash("sha256").update(JSON.stringify(files.map(({ id, path: filePath, sizeBytes, sha256 }) => ({ id, path: filePath, sizeBytes, sha256 })))).digest("hex");
  const totalBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    schemaVersion: 1,
    generatedAt: provenance.generatedAt,
    bundle: { id: `public-survey-footprints-${provenance.generatedAt.slice(0, 10)}`, sha256: bundleSha256 },
    statistics: {
      releases: provenance.statistics.releases,
      products: provenance.statistics.products,
      acquired: provenance.statistics.acquired,
      overviewOnly: provenance.statistics.overview_only,
      awaitingGeometry: provenance.statistics.awaiting_geometry,
      footprints: provenance.statistics.manifestFootprints,
      packages: packageCatalog.packages.length,
      rawMocFiles: mocIndex.artifacts.length + 1 + layerPlan.builds.length,
      totalBytes,
    },
    files,
  };
}

const manifest = await build();
await writeFile(path.join(artifactRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Built ${manifest.bundle.id}: ${manifest.files.length} files, ${manifest.statistics.totalBytes} bytes, ${manifest.bundle.sha256}`);
