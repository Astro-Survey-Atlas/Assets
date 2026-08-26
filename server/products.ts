import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AdminHttpError } from "./admin.js";

export interface ProductFlowNode {
  id: string;
  kind: string;
  title: string;
  bodyMarkdown: string;
  order: number;
  implementationRef: string;
  evidenceRefs: string[];
}
export interface ProductFlowEdge { from: string; to: string; label?: string; }
export interface ProductPresentation { summaryMarkdown: string; methodologyMarkdown: string; limitationsMarkdown: string; flow: { nodes: ProductFlowNode[]; edges: ProductFlowEdge[] } }
export interface ProductScanDefaults { allowedSuffixes?: string; maxOrder?: number; raColumn?: string; decColumn?: string; healpixColumn?: string; healpixOrderColumn?: string; healpixOrder?: number }
export interface ProductContent { productId: string; surveyId: string; releaseId: string; name: string; modality?: string; layerId?: string; mode?: "fits-wcs" | "fits-header-position" | "catalog-radec" | "nested-healpix"; scanDefaults?: ProductScanDefaults; recipeVersion?: number; recipeHash?: string; sourceUnitIndex?: { status: "exact" | "estimated" | "entrypoint-only"; unitKind?: string; downloadUrlTemplate?: string; notes: string }; coverageRole?: "image_extent" | "object_presence" | "footprint_extent"; dataOrigin?: "observed" | "simulated" | "catalog"; sourceTier?: "official_geometry" | "official_inventory_derived" | "third_party_moc" | "best_effort_derived" | "user_file_derived"; presentation: ProductPresentation }
export interface ProductRecord { productId: string; draft: ProductContent; published: ProductContent | null; revision: number; publishedRevision: number | null; updatedAt: string; publishedAt: string | null; contentSha256: string; }

const configuredContentRoot = process.env.ASSETS_CONTENT_ROOT ? path.resolve(process.env.ASSETS_CONTENT_ROOT) : "/var/lib/assets-content";

function productId(surveyId: string, releaseId: string, name: string): string {
  return createHash("sha256").update(`${surveyId}\n${releaseId}\n${name}`).digest("hex").slice(0, 20);
}

function defaultFlow(product: { name: string; modality: string }, mode = "catalog-radec", recipe: Record<string, unknown> = {}): ProductPresentation["flow"] {
  const definitions: Record<string, Array<[string, string]>> = {
    "fits-wcs": [["input", "输入来源"], ["filter", "文件筛选"], ["header", "FITS header / WCS 读取"], ["icrs", "ICRS 校验"], ["geometry", "几何边界计算"], ["rasterize", "HEALPix 栅格化"], ["union", "union / dedup"], ["outputs", "MOC、FITS、preview、statistics 输出"], ["evidence", "manifest、provenance、hash"]],
    "fits-header-position": [["input", "输入来源"], ["filter", "文件筛选"], ["header", "FITS position header 读取"], ["icrs", "ICRS 校验"], ["rasterize", "HEALPix entrypoint 定位"], ["union", "union / dedup"], ["outputs", "coverage、statistics 输出"], ["evidence", "manifest、errors、provenance、hash"]],
    "tile-table": [["input", "官方 tile 表输入"], ["filter", "质量字段筛选"], ["geometry", "tile 几何包络计算"], ["rasterize", "HEALPix 栅格化"], ["union", "union / dedup"], ["outputs", "MOC、FITS、preview、statistics 输出"], ["evidence", "manifest、provenance、hash"]],
    "regions": [["input", "区域文件输入"], ["parse", "区域格式解析"], ["icrs", "ICRS 校验"], ["union", "区域 union / dedup"], ["rasterize", "HEALPix 栅格化"], ["outputs", "MOC、FITS、preview、statistics 输出"], ["evidence", "manifest、provenance、hash"]],
    "nested-healpix": [["input", "原生 HEALPix/IPix 输入"], ["validate", "order、NESTED 与坐标校验"], ["union", "cell union / dedup"], ["outputs", "MOC、FITS、preview、statistics 输出"], ["evidence", "manifest、provenance、hash"]],
    "nested-healpix-fits-wcs": [["input", "输入目录与扫描快照"], ["filter", "文件名筛选与 FITS 可读性校验"], ["header", "FITS header / WCS 读取"], ["icrs", "ICRS 坐标校验"], ["geometry", "WCS 几何边界计算"], ["rasterize", "order 8 HEALPix 栅格化"], ["normalize", "NESTED order/ipix 归一化"], ["union", "cell union / dedup"], ["project", "query / overview order 投影"], ["outputs", "MOC、FITS、preview、statistics 输出"], ["evidence", "manifest、provenance、hash"]],
    "native-moc": [["input", "原生 FITS MOC 来源"], ["validate", "IVOA MOC / ICRS / NUNIQ 校验"], ["project", "发布 order 投影"], ["union", "cell canonicalize / dedup"], ["outputs", "MOC、preview、statistics 输出"], ["evidence", "来源、manifest、provenance、hash"]],
    "catalog-radec": [["input", "目录表输入"], ["filter", "目录行筛选"], ["geometry", "RA/DEC 几何计算"], ["rasterize", "HEALPix 栅格化"], ["union", "union / dedup"], ["outputs", "MOC、FITS、preview、statistics 输出"], ["evidence", "manifest、provenance、hash"]],
  };
  const values = (keys: string[]): string => keys.filter((key) => recipe[key] !== undefined).map((key) => `${key}=${typeof recipe[key] === "string" ? recipe[key] : JSON.stringify(recipe[key])}`).join("; ");
  const body = (kind: string): string => {
    if (kind === "input") return values(["input", "sourceUrl", "snapshotSha256", "snapshotSizeBytes", "hdu", "members"]);
    if (kind === "filter") return values(["fileNamePattern", "nexpColumn", "nexpMin", "scannerMode", "scannerRunId"]);
    if (kind === "header") return values(["scannerMode", "edgeSamples"]);
    if (kind === "parse") return values(["format", "members"]);
    if (kind === "icrs" || kind === "validate") return "coordinateFrame=ICRS; ordering=NESTED";
    if (kind === "geometry") return values(["raColumn", "decColumn", "radiusDeg", "radiusAuthority", "format", "members"]);
    if (kind === "rasterize") return `${values(["values", "order"])}${values(["values", "order"]) ? "; " : ""}maxOrder=${recipe.maxOrder ?? "locked"}; queryOrder=${recipe.queryOrder ?? 8}; previewOrder=${recipe.previewOrder ?? 4}; ICRS/NESTED`;
    if (kind === "normalize") return `将 FITS-WCS 扫描结果规范化为明确的 NESTED order/ipix；输入 order=${recipe.order ?? recipe.queryOrder ?? 8}，保留扫描 run 和文件来源。`;
    if (kind === "project") return `只投影为真实发布的 preview O${recipe.previewOrder ?? 4}${recipe.queryOrder ? ` 与 query O${recipe.queryOrder}` : ""}，不伪造更高精度。`;
    if (kind === "union") return "按 NESTED order/ipix canonicalize、union 并去重，不推断缺失的更高阶 cell。";
    if (kind === "outputs") return "输出 IVOA FITS MOC、query projection、preview projection 和 statistics。";
    return "保存锁定 recipe、输入快照 SHA-256、manifest、provenance 与输出 hash。";
  };
  const definitionKey = mode === "nested-healpix" && recipe.scannerMode === "fits-wcs" ? "nested-healpix-fits-wcs" : mode;
  const nodes = (definitions[definitionKey] ?? definitions["catalog-radec"]!).map(([kind, title], order) => ({ id: kind, kind, title, bodyMarkdown: body(kind) || `由 ${product.name} 的 ${mode} recipe 驱动。`, order, implementationRef: `assets.coverage.${kind}`, evidenceRefs: [] }));
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })) };
}

function hashContent(content: ProductContent): string { return createHash("sha256").update(JSON.stringify(content)).digest("hex"); }

function migrateRecipeContent(existing: ProductContent, template: ProductContent): ProductContent {
  const oldNodes = new Map(existing.presentation.flow.nodes.map((node) => [node.id, node]));
  const flow = {
    nodes: template.presentation.flow.nodes.map((node) => {
      const previous = oldNodes.get(node.id);
      return previous ? {
        ...node,
        title: previous.title.trim() ? previous.title : node.title,
        bodyMarkdown: previous.bodyMarkdown.trim() ? previous.bodyMarkdown : node.bodyMarkdown,
        evidenceRefs: previous.evidenceRefs,
      } : node;
    }),
    edges: template.presentation.flow.edges,
  };
  return {
    ...template,
    presentation: {
      summaryMarkdown: existing.presentation.summaryMarkdown,
      methodologyMarkdown: existing.presentation.methodologyMarkdown,
      limitationsMarkdown: existing.presentation.limitationsMarkdown,
      flow,
    },
  };
}

function validateContent(value: unknown, existing: ProductRecord): ProductContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminHttpError(400, "content must be an object");
  const input = value as Record<string, unknown>;
  const presentation = input.presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) throw new AdminHttpError(400, "presentation is required");
  const next = presentation as Record<string, unknown>;
  const flow = next.flow;
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) throw new AdminHttpError(400, "presentation.flow is required");
  const flowInput = flow as Record<string, unknown>;
  if (!Array.isArray(flowInput.nodes) || !Array.isArray(flowInput.edges)) throw new AdminHttpError(400, "flow nodes and edges are required");
  const allowed = new Map(existing.draft.presentation.flow.nodes.map((node) => [node.id, node]));
  const nodes = flowInput.nodes.map((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new AdminHttpError(400, "invalid flow node");
    const item = node as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    const recipe = allowed.get(id);
    if (!recipe) throw new AdminHttpError(400, `flow node ${id || "unknown"} is not allowed by the recipe`);
    return { ...recipe, title: typeof item.title === "string" ? item.title.slice(0, 200) : recipe.title, bodyMarkdown: typeof item.bodyMarkdown === "string" ? item.bodyMarkdown.slice(0, 4000) : "", evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs.filter((ref): ref is string => typeof ref === "string").slice(0, 32) : [] };
  });
  if (nodes.length !== allowed.size || nodes.some((node) => !allowed.has(node.id))) throw new AdminHttpError(400, "flow must retain every recipe node");
  const ids = new Set(nodes.map((node) => node.id));
  const edges = flowInput.edges.map((edge) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) throw new AdminHttpError(400, "invalid flow edge");
    const item = edge as Record<string, unknown>;
    const from = typeof item.from === "string" ? item.from : "";
    const to = typeof item.to === "string" ? item.to : "";
    if (!ids.has(from) || !ids.has(to) || from === to) throw new AdminHttpError(400, "flow edge references an invalid node");
    return { from, to, ...(typeof item.label === "string" ? { label: item.label.slice(0, 200) } : {}) };
  });
  const recipeEdges = new Set(existing.draft.presentation.flow.edges.map((edge) => `${edge.from}->${edge.to}`));
  if (edges.length !== recipeEdges.size || edges.some((edge) => !recipeEdges.has(`${edge.from}->${edge.to}`))) throw new AdminHttpError(400, "flow edges must match the product recipe");
  const text = (key: string): string => typeof next[key] === "string" ? (next[key] as string).slice(0, 12000) : "";
  return { ...existing.draft, presentation: { summaryMarkdown: text("summaryMarkdown"), methodologyMarkdown: text("methodologyMarkdown"), limitationsMarkdown: text("limitationsMarkdown"), flow: { nodes, edges } } };
}

export class ProductStore {
  #records = new Map<string, ProductRecord>();
  #initialized = false;
  #contentRoot = configuredContentRoot;

  #contentFile(): string { return path.join(this.#contentRoot, "product-content-v1.json"); }
  #historyFile(): string { return path.join(this.#contentRoot, "product-content-history.ndjson"); }

  async initialize(root: string, coverageLayers: Array<{ surveyId: string; releaseId: string; product: string; recipe?: { recipeVersion: number; mode: string; steps: Array<Omit<ProductFlowNode, "evidenceRefs">> } }> = []): Promise<void> {
    if (this.#initialized) return;
    const migrationHistory: string[] = [];
    try { await mkdir(this.#contentRoot, { recursive: true }); }
    catch { this.#contentRoot = path.join(root, ".assets-content"); await mkdir(this.#contentRoot, { recursive: true }); }
    try {
      const data = JSON.parse(await readFile(this.#contentFile(), "utf8")) as { products?: ProductRecord[] };
      for (const record of data.products ?? []) this.#records.set(record.productId, record);
    } catch { /* first boot */ }
    const catalog = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as { surveys?: Array<{ id: string; releases: Array<{ id: string; products: Array<{ name: string; modality: string }> }> }> };
    const registry = JSON.parse(await readFile(path.join(root, "src", "layers", "layer-registry.json"), "utf8")) as { layers?: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; coverageRole?: ProductContent["coverageRole"]; dataOrigin?: ProductContent["dataOrigin"]; sourceTier?: ProductContent["sourceTier"]; plannedMode?: string; mode?: string; recipePath?: string; status?: string; maxOrder?: number }> };
    const definitions = new Map((registry.layers ?? []).map((layer) => [`${layer.surveyId}:${layer.releaseId}:${layer.product}`, layer]));
    for (const survey of catalog.surveys ?? []) for (const release of survey.releases ?? []) for (const product of release.products ?? []) {
      const id = productId(survey.id, release.id, product.name);
      const existing = this.#records.get(id);
      const definition = definitions.get(`${survey.id}:${release.id}:${product.name}`);
      const coverageDefinition = coverageLayers.find((layer) => layer.surveyId === survey.id && layer.releaseId === release.id && layer.product === product.name);
      let recipeMode = definition?.mode ?? definition?.plannedMode;
      let recipe: Record<string, unknown> = {};
      let recipeHash: string | undefined;
      if (definition?.recipePath) {
        try {
          const raw = JSON.parse(await readFile(path.join(root, definition.recipePath), "utf8")) as Record<string, unknown>;
          if (typeof raw.mode === "string") recipeMode = raw.mode;
          recipe = raw.recipe && typeof raw.recipe === "object" ? raw.recipe as Record<string, unknown> : {};
          for (const key of ["input", "sourceUrl", "maxOrder", "queryOrder", "previewOrder"]) if (raw[key] !== undefined) recipe[key] = raw[key];
          if (raw.snapshot && typeof raw.snapshot === "object") { const snapshot = raw.snapshot as Record<string, unknown>; recipe.snapshotSha256 = snapshot.sha256; recipe.snapshotSizeBytes = snapshot.sizeBytes; }
          recipeHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
        } catch { /* recipe is optional for catalog-only products */ }
      }
      if (!recipeHash && coverageDefinition?.recipe) {
        recipeMode = coverageDefinition.recipe.mode;
        recipeHash = createHash("sha256").update(JSON.stringify(coverageDefinition.recipe)).digest("hex");
      }
      const supportedMode = recipeMode && ["fits-wcs", "fits-header-position", "catalog-radec", "nested-healpix"].includes(recipeMode) ? recipeMode as ProductContent["mode"] : undefined;
      const flowMode = recipeMode && ["fits-wcs", "fits-header-position", "catalog-radec", "nested-healpix", "regions", "tile-table", "native-moc"].includes(recipeMode) ? recipeMode : "catalog-radec";
      const coverageFlow = coverageDefinition?.recipe && !definition?.recipePath ? { nodes: coverageDefinition.recipe.steps.map((node) => ({ ...node, evidenceRefs: [] })), edges: coverageDefinition.recipe.steps.slice(1).map((node, index) => ({ from: coverageDefinition.recipe!.steps[index]!.id, to: node.id })) } : undefined;
      const scanDefaults: ProductScanDefaults = {
        ...(typeof recipe.maxOrder === "number" ? { maxOrder: recipe.maxOrder } : definition?.maxOrder ? { maxOrder: definition.maxOrder } : {}),
        ...(typeof recipe.raColumn === "string" ? { raColumn: recipe.raColumn } : {}),
        ...(typeof recipe.decColumn === "string" ? { decColumn: recipe.decColumn } : {}),
        ...(typeof recipe.values === "string" ? { healpixColumn: recipe.values } : {}),
        ...(typeof recipe.order === "number" ? { healpixOrder: recipe.order } : {}),
        ...(["fits-wcs", "fits-header-position"].includes(supportedMode ?? "") ? { allowedSuffixes: ".fits,.fit,.fits.gz" } : {}),
        ...(supportedMode === "nested-healpix" ? { allowedSuffixes: ".json,.csv,.tsv,.fits" } : {}),
        ...(supportedMode === "catalog-radec" ? { allowedSuffixes: ".csv,.tsv" } : {}),
      };
      const draft: ProductContent = { productId: id, surveyId: survey.id, releaseId: release.id, name: product.name, modality: product.modality, ...((definition || coverageDefinition) ? { layerId: definition?.layerId, coverageRole: definition?.coverageRole, dataOrigin: definition?.dataOrigin, sourceTier: definition?.sourceTier, ...(supportedMode ? { mode: supportedMode, scanDefaults } : {}) } : {}), ...(recipeHash ? { recipeVersion: 1, recipeHash } : {}), presentation: { summaryMarkdown: "", methodologyMarkdown: "", limitationsMarkdown: "", flow: coverageFlow ?? defaultFlow(product, flowMode, recipe) } };
      if (existing) {
        const recipeChanged = Boolean(recipeHash && existing.draft.recipeHash !== recipeHash);
        const scanDefaultsMissing = Boolean(supportedMode && existing.draft.scanDefaults === undefined);
        if (recipeChanged || scanDefaultsMissing) {
          existing.draft = migrateRecipeContent(existing.draft, draft);
          if (existing.published) existing.published = migrateRecipeContent(existing.published, draft);
          existing.revision += 1;
          if (existing.published) existing.publishedRevision = existing.revision;
          existing.updatedAt = new Date().toISOString();
          existing.contentSha256 = hashContent(existing.draft);
          migrationHistory.push(JSON.stringify({ action: recipeChanged ? "recipe-migration" : "scan-defaults-migration", productId: id, revision: existing.revision, at: existing.updatedAt, ...(recipeHash ? { recipeHash } : {}) }));
        }
        continue;
      }
      this.#records.set(id, { productId: id, draft, published: null, revision: 1, publishedRevision: null, updatedAt: new Date().toISOString(), publishedAt: null, contentSha256: hashContent(draft) });
    }
    await this.persist();
    if (migrationHistory.length) await appendFile(this.#historyFile(), `${migrationHistory.join("\n")}\n`);
    this.#initialized = true;
  }

  async persist(): Promise<void> { await writeFile(this.#contentFile(), `${JSON.stringify({ schemaVersion: 1, products: [...this.#records.values()] }, null, 2)}\n`, "utf8"); }
  list(): ProductRecord[] { return [...this.#records.values()].sort((a, b) => `${a.draft.surveyId}:${a.draft.releaseId}:${a.draft.name}`.localeCompare(`${b.draft.surveyId}:${b.draft.releaseId}:${b.draft.name}`)); }
  get(id: string): ProductRecord { const record = this.#records.get(id); if (!record) throw new AdminHttpError(404, "Product not found"); return record; }
  async updateDraft(id: string, content: unknown, expectedRevision?: number): Promise<ProductRecord> {
    const record = this.get(id);
    if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new AdminHttpError(409, "Product revision conflict");
    record.draft = validateContent(content, record);
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    record.contentSha256 = hashContent(record.draft);
    await this.persist();
    await appendFile(this.#historyFile(), `${JSON.stringify({ action: "draft", productId: id, revision: record.revision, at: record.updatedAt, content: record.draft })}\n`);
    return record;
  }
  async publish(id: string, expectedRevision?: number): Promise<ProductRecord> {
    const record = this.get(id);
    if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new AdminHttpError(409, "Product revision conflict");
    record.published = structuredClone(record.draft);
    record.publishedRevision = record.revision;
    record.publishedAt = new Date().toISOString();
    record.updatedAt = record.publishedAt;
    record.contentSha256 = hashContent(record.draft);
    await this.persist();
    await appendFile(this.#historyFile(), `${JSON.stringify({ action: "publish", productId: id, revision: record.revision, at: record.publishedAt, content: record.published })}\n`);
    return record;
  }
  async history(id: string): Promise<unknown[]> {
    try {
      const lines = (await readFile(this.#historyFile(), "utf8")).trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line)).filter((entry) => entry.productId === id);
    } catch { return []; }
  }
}

export { productId };
