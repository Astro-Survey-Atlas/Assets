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
export interface ProductContent { productId: string; surveyId: string; releaseId: string; name: string; layerId?: string; mode?: "fits-wcs" | "catalog-radec" | "nested-healpix"; coverageRole?: "image_extent" | "object_presence" | "footprint_extent"; dataOrigin?: "observed" | "simulated" | "catalog"; sourceTier?: "official_geometry" | "official_inventory_derived" | "third_party_moc" | "best_effort_derived" | "user_file_derived"; presentation: ProductPresentation }
export interface ProductRecord { productId: string; draft: ProductContent; published: ProductContent | null; revision: number; publishedRevision: number | null; updatedAt: string; publishedAt: string | null; contentSha256: string; }

const configuredContentRoot = process.env.ASSETS_CONTENT_ROOT ? path.resolve(process.env.ASSETS_CONTENT_ROOT) : "/var/lib/assets-content";

function productId(surveyId: string, releaseId: string, name: string): string {
  return createHash("sha256").update(`${surveyId}\n${releaseId}\n${name}`).digest("hex").slice(0, 20);
}

function defaultFlow(product: { name: string; modality: string }): ProductPresentation["flow"] {
  const isFits = /fits|image|imaging|wcs/i.test(`${product.name} ${product.modality}`);
  const names = isFits
    ? ["input", "filter", "header", "icrs", "geometry", "rasterize", "union", "outputs", "evidence"]
    : ["input", "filter", "geometry", "rasterize", "union", "outputs", "evidence"];
  const titles: Record<string, string> = { input: "输入来源", filter: "文件筛选", header: "FITS header / WCS 读取", icrs: "ICRS 校验", geometry: "几何边界计算", rasterize: "HEALPix 栅格化", union: "union / dedup", outputs: "MOC、FITS、preview、statistics 输出", evidence: "manifest、provenance、hash" };
  const nodes = names.map((kind, order) => ({ id: kind, kind, title: titles[kind] ?? kind, bodyMarkdown: "", order, implementationRef: `assets.coverage.${kind}`, evidenceRefs: [] }));
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })) };
}

function hashContent(content: ProductContent): string { return createHash("sha256").update(JSON.stringify(content)).digest("hex"); }
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

  async initialize(root: string): Promise<void> {
    if (this.#initialized) return;
    try { await mkdir(this.#contentRoot, { recursive: true }); }
    catch { this.#contentRoot = path.join(root, ".assets-content"); await mkdir(this.#contentRoot, { recursive: true }); }
    try {
      const data = JSON.parse(await readFile(this.#contentFile(), "utf8")) as { products?: ProductRecord[] };
      for (const record of data.products ?? []) this.#records.set(record.productId, record);
    } catch { /* first boot */ }
    const catalog = JSON.parse(await readFile(path.join(root, "src", "surveys", "survey-catalog.json"), "utf8")) as { surveys?: Array<{ id: string; releases: Array<{ id: string; products: Array<{ name: string; modality: string }> }> }> };
    const registry = JSON.parse(await readFile(path.join(root, "src", "layers", "layer-registry.json"), "utf8")) as { layers?: Array<{ layerId: string; surveyId: string; releaseId: string; product: string; coverageRole?: ProductContent["coverageRole"]; dataOrigin?: ProductContent["dataOrigin"]; sourceTier?: ProductContent["sourceTier"]; plannedMode?: string; status?: string; maxOrder?: number }> };
    const definitions = new Map((registry.layers ?? []).map((layer) => [`${layer.surveyId}:${layer.releaseId}:${layer.product}`, layer]));
    for (const survey of catalog.surveys ?? []) for (const release of survey.releases ?? []) for (const product of release.products ?? []) {
      const id = productId(survey.id, release.id, product.name);
      if (this.#records.has(id)) continue;
      const definition = definitions.get(`${survey.id}:${release.id}:${product.name}`);
      const recipeMode = definition?.plannedMode && ["fits-wcs", "catalog-radec", "nested-healpix"].includes(definition.plannedMode) ? definition.plannedMode as ProductContent["mode"] : definition && definition.status !== "awaiting_snapshot" ? "fits-wcs" as const : undefined;
      const draft: ProductContent = { productId: id, surveyId: survey.id, releaseId: release.id, name: product.name, ...(definition ? { layerId: definition.layerId, coverageRole: definition.coverageRole, dataOrigin: definition.dataOrigin, sourceTier: definition.sourceTier, ...(recipeMode ? { mode: recipeMode } : {}) } : {}), presentation: { summaryMarkdown: "", methodologyMarkdown: "", limitationsMarkdown: "", flow: defaultFlow(product) } };
      this.#records.set(id, { productId: id, draft, published: null, revision: 1, publishedRevision: null, updatedAt: new Date().toISOString(), publishedAt: null, contentSha256: hashContent(draft) });
    }
    await this.persist();
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
