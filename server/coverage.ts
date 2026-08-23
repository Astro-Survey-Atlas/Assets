import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CoverageCellLayer {
  layerId: string;
  productId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality?: string;
  color: string;
  availableOrders: number[];
  overviewOrder: number;
  maxOrder: number;
  cellCount: number;
  areaDeg2: number;
  tileScheme: string;
  cells: Map<number, number[]>;
  recipe?: CoverageRecipeSummary;
  sourceUnitIndex?: SourceUnitIndexSummary;
}

export interface CoverageRecipeSummary {
  recipeVersion: number;
  mode: string;
  coordinateFrame: "ICRS";
  ordering: "NESTED";
  maxOrder: number;
  queryOrder: number;
  previewOrder: number;
  sourceUrl?: string;
  steps: Array<{ id: string; kind: string; title: string; bodyMarkdown: string; order: number; implementationRef: string }>;
}

export interface SourceUnitIndexSummary {
  status: "exact" | "estimated" | "entrypoint-only";
  unitKind?: string;
  indexUrl?: string;
  downloadUrlTemplate?: string;
  notes: string;
}

export interface CoverageCatalog {
  schemaVersion: 1;
  coordinateFrame: "ICRS";
  ordering: "NESTED";
  tileScheme: "ipix-range-4096";
  layers: Array<Omit<CoverageCellLayer, "cells"> & { tileIdsByOrder: Record<string, number[]> }>;
}

const identity = (surveyId: string, releaseId: string, product: string): string => `${surveyId}:${releaseId}:${product}`;
const slug = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 96);

function colorFor(id: string): string {
  const palette = ["#1e857b", "#376b9b", "#a66a25", "#b64b3e", "#3b8054", "#7a5a9e", "#b27b2d", "#2b7887"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

function hashCells(cells: number[]): string {
  return createHash("sha256").update(JSON.stringify(cells)).digest("hex");
}

function recipeSteps(mode: string, recipe: Record<string, unknown>): CoverageRecipeSummary["steps"] {
  const values = (keys: string[]): string => keys.filter((key) => recipe[key] !== undefined).map((key) => `${key}=${typeof recipe[key] === "string" ? recipe[key] : JSON.stringify(recipe[key])}`).join("; ");
  const bodyFor = (id: string): string => {
    if (id === "input") return values(["input", "sourceUrl", "sourceId", "sourceNotes", "snapshotSha256", "snapshotSizeBytes", "hdu", "members"]);
    if (id === "filter") return values(["fileNamePattern", "nexpColumn", "nexpMin", "scannerMode", "scannerRunId"]);
    if (id === "header") return values(["scannerMode", "edgeSamples"]);
    if (id === "parse") return values(["format", "members"]);
    if (id === "icrs" || id === "validate") return "coordinateFrame=ICRS; ordering=NESTED";
    if (id === "geometry") return values(["raColumn", "decColumn", "radiusDeg", "radiusAuthority", "format", "members"]);
    if (id === "rasterize") return `${values(["values", "order"])}${values(["values", "order"]) ? "; " : ""}coordinateFrame=ICRS; ordering=NESTED; maxOrder=${recipe.maxOrder ?? "locked"}; queryOrder=${recipe.queryOrder ?? 8}; previewOrder=${recipe.previewOrder ?? 4}`;
    if (id === "normalize") return `将 FITS-WCS 扫描结果规范化为明确的 NESTED order/ipix；输入 order=${recipe.order ?? recipe.queryOrder ?? 8}，保留扫描 run 和文件来源。`;
    if (id === "project") return `将已校验 MOC 投影为真实发布的 overview O${recipe.previewOrder ?? 4}${recipe.queryOrder ? ` 与 query O${recipe.queryOrder}` : ""}；不伪造更高精度。`;
    if (id === "union") return "按 NESTED order/ipix canonicalize、union 并去重，不推断缺失的更高阶 cell。";
    if (id === "outputs") return "输出 IVOA FITS MOC、query projection、preview projection 和 statistics。";
    return "保存锁定 recipe、输入快照 SHA-256、manifest、provenance 与输出 hash。";
  };
  const definitions: Record<string, Array<[string, string, string, string]>> = {
    "fits-wcs": [["input", "source-inventory", "输入文件与发布快照", "assets.coverage.input"], ["filter", "file-filter", "文件筛选与可读性校验", "assets.coverage.filter"], ["header", "fits-wcs", "FITS header / WCS 读取", "assets.coverage.fits-wcs"], ["icrs", "coordinate-validation", "ICRS 坐标校验", "assets.coverage.icrs"], ["geometry", "boundary", "几何边界计算", "assets.coverage.geometry"], ["rasterize", "healpix", "HEALPix 栅格化", "assets.coverage.rasterize"], ["union", "union-dedup", "union / dedup", "assets.coverage.union"], ["outputs", "outputs", "MOC、FITS、preview、statistics 输出", "assets.coverage.outputs"], ["evidence", "evidence", "manifest、provenance、hash", "assets.coverage.evidence"]],
    "tile-table": [["input", "source-inventory", "官方 tile 表输入", "assets.coverage.input"], ["filter", "quality-filter", "质量字段筛选", "assets.coverage.filter"], ["geometry", "tile-geometry", "tile 几何包络计算", "assets.coverage.geometry"], ["rasterize", "healpix", "HEALPix 栅格化", "assets.coverage.rasterize"], ["union", "union-dedup", "union / dedup", "assets.coverage.union"], ["outputs", "outputs", "MOC、FITS、preview、statistics 输出", "assets.coverage.outputs"], ["evidence", "evidence", "manifest、provenance、hash", "assets.coverage.evidence"]],
    "catalog-radec": [["input", "source-inventory", "目录表输入", "assets.coverage.input"], ["filter", "quality-filter", "目录行筛选", "assets.coverage.filter"], ["geometry", "catalog-geometry", "RA/DEC 几何计算", "assets.coverage.geometry"], ["rasterize", "healpix", "HEALPix 栅格化", "assets.coverage.rasterize"], ["union", "union-dedup", "union / dedup", "assets.coverage.union"], ["outputs", "outputs", "MOC、FITS、preview、statistics 输出", "assets.coverage.outputs"], ["evidence", "evidence", "manifest、provenance、hash", "assets.coverage.evidence"]],
    "regions": [["input", "source-inventory", "区域文件输入", "assets.coverage.input"], ["parse", "region-parser", "DS9/区域格式解析", "assets.coverage.parse"], ["icrs", "coordinate-validation", "ICRS 坐标校验", "assets.coverage.icrs"], ["union", "union-dedup", "区域 union / dedup", "assets.coverage.union"], ["rasterize", "healpix", "HEALPix 栅格化", "assets.coverage.rasterize"], ["outputs", "outputs", "MOC、FITS、preview、statistics 输出", "assets.coverage.outputs"], ["evidence", "evidence", "manifest、provenance、hash", "assets.coverage.evidence"]],
    "nested-healpix": [["input", "source-inventory", "原生 HEALPix/IPix 输入", "assets.coverage.input"], ["validate", "healpix-validation", "order、NESTED 与坐标校验", "assets.coverage.validate"], ["union", "union-dedup", "cell union / dedup", "assets.coverage.union"], ["outputs", "outputs", "MOC、FITS、preview、statistics 输出", "assets.coverage.outputs"], ["evidence", "evidence", "manifest、provenance、hash", "assets.coverage.evidence"]],
    "nested-healpix-fits-wcs": [["input", "source-inventory", "输入目录与扫描快照", "assets.coverage.input"], ["filter", "file-filter", "文件名筛选与 FITS 可读性校验", "assets.coverage.filter"], ["header", "fits-wcs", "FITS header / WCS 读取", "assets.coverage.fits-wcs"], ["icrs", "coordinate-validation", "ICRS 坐标校验", "assets.coverage.icrs"], ["geometry", "boundary", "WCS 几何边界计算", "assets.coverage.geometry"], ["rasterize", "healpix", "order 8 HEALPix 栅格化", "assets.coverage.rasterize"], ["normalize", "healpix-normalization", "NESTED order/ipix 归一化", "assets.coverage.normalize"], ["union", "union-dedup", "cell union / dedup", "assets.coverage.union"], ["project", "order-projection", "query / overview order 投影", "assets.coverage.project"], ["outputs", "outputs", "MOC、FITS、preview、statistics 输出", "assets.coverage.outputs"], ["evidence", "evidence", "manifest、provenance、hash", "assets.coverage.evidence"]],
    "native-moc": [["input", "native-moc-source", "原生 FITS MOC 来源", "assets.coverage.input"], ["validate", "moc-validation", "IVOA MOC / ICRS / NUNIQ 校验", "assets.coverage.validate-moc"], ["project", "order-projection", "发布 order 投影", "assets.coverage.project"], ["union", "union-dedup", "cell canonicalize / dedup", "assets.coverage.union"], ["outputs", "outputs", "MOC、preview、statistics 输出", "assets.coverage.outputs"], ["evidence", "evidence", "来源、manifest、provenance、hash", "assets.coverage.evidence"]],
  };
  const definitionKey = mode === "nested-healpix" && recipe.scannerMode === "fits-wcs" ? "nested-healpix-fits-wcs" : mode;
  return (definitions[definitionKey] ?? definitions["catalog-radec"]!).map(([id, kind, title, implementationRef], order) => ({ id, kind, title, bodyMarkdown: bodyFor(id), order, implementationRef }));
}

export async function loadCoverageCatalog(root: string, manifest: { footprints: Array<{ surveyId: string; releaseId: string; product: string; nside: number; pixels: number[]; sourceUrl?: string; sourceId?: string; notes?: string }> }): Promise<CoverageCatalog & { records: Map<string, CoverageCellLayer> }> {
  const registryPath = path.join(root, "src", "layers", "layer-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as { layers?: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; modality?: string; maxOrder?: number; mode?: string; plannedMode?: string; recipePath?: string; sourceTier?: string; status?: string }> };
  const registryByIdentity = new Map((registry.layers ?? []).map((entry) => [identity(entry.surveyId, entry.releaseId, entry.product), entry]));
  const colors = new Map<string, string>();
  const surveyCatalog = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as { surveys?: Array<{ id: string; color: string }> };
  for (const survey of surveyCatalog.surveys ?? []) colors.set(survey.id, survey.color);
  const records = new Map<string, CoverageCellLayer>();
  for (const footprint of manifest.footprints) {
    const key = identity(footprint.surveyId, footprint.releaseId, footprint.product);
    const registered = registryByIdentity.get(key);
    const layerId = registered?.layerId ?? `${slug(footprint.surveyId)}-${slug(footprint.releaseId)}-${slug(footprint.product)}`;
    const order = Math.round(Math.log2(footprint.nside));
    const cells = new Map<number, number[]>([[order, [...new Set(footprint.pixels)].sort((a, b) => a - b)]]);
    const registeredRecipe: Record<string, unknown> = {};
    let registeredSourceUrl: string | undefined;
    let registeredMode: string | undefined;
    let registeredQueryOrder = 8;
    let registeredPreviewOrder = 4;
    if (registered?.recipePath) {
      try {
        const raw = JSON.parse(await readFile(path.join(root, registered.recipePath), "utf8")) as Record<string, unknown>;
        Object.assign(registeredRecipe, raw.recipe && typeof raw.recipe === "object" ? raw.recipe : {});
        if (typeof raw.input === "string") registeredRecipe.input = raw.input;
        if (typeof raw.sourceUrl === "string") registeredRecipe.sourceUrl = raw.sourceUrl;
        if (raw.snapshot && typeof raw.snapshot === "object") {
          const snapshot = raw.snapshot as Record<string, unknown>;
          if (typeof snapshot.sha256 === "string") registeredRecipe.snapshotSha256 = snapshot.sha256;
          if (typeof snapshot.sizeBytes === "number") registeredRecipe.snapshotSizeBytes = snapshot.sizeBytes;
        }
        if (typeof raw.maxOrder === "number") registeredRecipe.maxOrder = raw.maxOrder;
        if (typeof raw.queryOrder === "number") registeredRecipe.queryOrder = raw.queryOrder;
        if (typeof raw.previewOrder === "number") registeredRecipe.previewOrder = raw.previewOrder;
        if (typeof raw.sourceUrl === "string") registeredSourceUrl = raw.sourceUrl;
        if (typeof raw.mode === "string") registeredMode = raw.mode;
        if (typeof raw.queryOrder === "number") registeredQueryOrder = raw.queryOrder;
        if (typeof raw.previewOrder === "number") registeredPreviewOrder = raw.previewOrder;
      } catch { /* recipe details remain unavailable for legacy layers */ }
    }
    if (typeof footprint.sourceUrl === "string" && registeredRecipe.sourceUrl === undefined) registeredRecipe.sourceUrl = footprint.sourceUrl;
    if (!registeredSourceUrl && typeof footprint.sourceUrl === "string") registeredSourceUrl = footprint.sourceUrl;
    if (typeof footprint.sourceId === "string") registeredRecipe.sourceId = footprint.sourceId;
    if (typeof footprint.notes === "string") registeredRecipe.sourceNotes = footprint.notes;
    if (registered?.status === "frozen-review-exception") {
      registeredRecipe.scannerMode = "fits-wcs";
      registeredRecipe.reviewStatus = "frozen-review-exception";
    }
    const mode = registeredMode ?? registered?.mode ?? registered?.plannedMode ?? (registeredRecipe.scannerMode === "fits-wcs" ? "fits-wcs" : registered?.sourceTier === "user_file_derived" ? "nested-healpix" : "native-moc");
    const recipe: CoverageRecipeSummary = {
      recipeVersion: 1,
      mode,
      coordinateFrame: "ICRS",
      ordering: "NESTED",
      maxOrder: registered?.maxOrder ?? order,
      queryOrder: registeredQueryOrder,
      previewOrder: registeredPreviewOrder,
      ...(registeredSourceUrl ? { sourceUrl: registeredSourceUrl } : {}),
      steps: recipeSteps(mode, registeredRecipe),
    };
    const sourceUnitIndex: SourceUnitIndexSummary = mode === "tile-table"
      ? { status: footprint.surveyId === "desi" ? "exact" : "estimated", unitKind: "tile", indexUrl: registered?.recipePath, downloadUrlTemplate: footprint.surveyId === "desi" ? "https://data.desi.lbl.gov/public/{release}/spectro/redux/{specprod}/tiles/cumulative/{tileId}/{lastNight}/" : undefined, notes: footprint.surveyId === "desi" ? "由官方 TILE_COMPLETENESS 快照与锁定 recipe 构建运行时 tile 反向索引。" : "当前发布保存了 tile 表和几何规则；精确 tile 反向索引尚未提供。" }
      : { status: "entrypoint-only", notes: "当前 MOC 未保存可复核的原始 source-unit 反向索引，只提供 Release 官方入口。" };
    const record: CoverageCellLayer = {
      layerId,
      productId: createHash("sha256").update(`${footprint.surveyId}\n${footprint.releaseId}\n${footprint.product}`).digest("hex").slice(0, 20),
      surveyId: footprint.surveyId,
      releaseId: footprint.releaseId,
      product: footprint.product,
      modality: registered?.modality,
      color: colors.get(footprint.surveyId) ?? colorFor(footprint.surveyId),
      availableOrders: [order],
      overviewOrder: order,
      // maxOrder describes published projections, not a recipe's future target.
      maxOrder: order,
      cellCount: cells.get(order)!.length,
      areaDeg2: cells.get(order)!.length * (41252.96124941927 / (12 * footprint.nside * footprint.nside)),
      tileScheme: "ipix-range-4096",
      cells,
      recipe,
      sourceUnitIndex,
    };
    records.set(layerId, record);
  }
  // Add the higher-order query projections that are already part of the
  // release. They are optional: a layer never advertises an order without a
  // corresponding, verified projection.
  for (const record of records.values()) {
    const queryPath = path.join(root, "artifacts", "public-survey-footprints", "layers", record.layerId, "query-order8.json");
    try {
      const query = JSON.parse(await readFile(queryPath, "utf8")) as { order?: number; ordering?: string; pixels?: number[] };
      if (query.order === 8 && query.ordering === "NESTED" && Array.isArray(query.pixels) && query.pixels.length) {
        record.cells.set(8, [...new Set(query.pixels)].sort((a, b) => a - b));
        record.availableOrders = [...record.cells.keys()].sort((a, b) => a - b);
        record.maxOrder = Math.max(...record.availableOrders);
      }
    } catch { /* no high-order projection for this layer */ }
  }
  const layers = [...records.values()].map(({ cells, ...record }) => ({ ...record, tileIdsByOrder: Object.fromEntries([...cells.entries()].map(([order, values]) => [String(order), [...new Set(values.map((cell) => Math.floor(cell / 4096)))].sort((a, b) => a - b)])) }));
  return { schemaVersion: 1, coordinateFrame: "ICRS", ordering: "NESTED", tileScheme: "ipix-range-4096", layers, records };
}

export function coverageBlock(record: CoverageCellLayer, order: number, tileId: number): { layerId: string; order: number; tileId: number; cells: number[]; sha256: string } | null {
  const cells = record.cells.get(order);
  if (!cells) return null;
  const tileSize = 4096;
  const start = tileId * tileSize;
  const selected = cells.filter((cell) => cell >= start && cell < start + tileSize);
  if (!selected.length) return null;
  return { layerId: record.layerId, order, tileId, cells: selected, sha256: hashCells(selected) };
}

export function coverageTiles(record: CoverageCellLayer, order: number): number[] {
  const cells = record.cells.get(order) ?? [];
  const tileSize = 4096;
  return [...new Set(cells.map((cell) => Math.floor(cell / tileSize)))];
}
