import type { CoverageCellLayer } from "./coverage.js";
import type { ProductContent, ProductFlowNode } from "./products.js";
import type {
  PublicAssetRecord,
  PublicEvidenceItemKind,
  PublicProductDerivationStep,
  PublicProductEvidenceItem,
  PublicProductCodeEvidence,
} from "./types.js";

export interface PublicEvidenceAsset {
  id: string;
  record: PublicAssetRecord;
}

export interface PublicProductEvidenceInput {
  product: ProductContent;
  catalogEntry?: Pick<ProductContent, "sourceUrl" | "sourceLabel" | "geometrySourceUrl" | "geometrySourceLabel" | "officialDataUrl" | "officialDataLabel" | "officialQueryUrl" | "officialQueryLabel">;
  layer?: CoverageCellLayer;
  assets: PublicEvidenceAsset[];
}

export interface PublicProductEvidenceProjection {
  sourceReferences: PublicProductEvidenceItem[];
  steps: PublicProductDerivationStep[];
}

const itemKey = (item: PublicProductEvidenceItem): string => item.sha256
  ? `${item.kind}:sha256:${item.sha256}`
  : `${item.kind}:${item.url ?? ""}:${item.filename ?? ""}`;

function dedupeItems(items: PublicProductEvidenceItem[]): PublicProductEvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const privateHost = host === "localhost" || host.endsWith(".local") || host === "::1"
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || privateHost) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function assetUrl(id: string): string {
  return `/api/v1/assets/${encodeURIComponent(id)}/download`;
}

function publicAssetItem(asset: PublicEvidenceAsset, kind: PublicEvidenceItemKind, description: string): PublicProductEvidenceItem {
  return {
    kind,
    label: asset.record.label,
    description,
    visibility: "public",
    url: assetUrl(asset.id),
    filename: asset.record.downloadName,
    mediaType: asset.record.mediaType,
    sizeBytes: asset.record.sizeBytes,
    sha256: asset.record.sha256,
  };
}

function sourceKind(url: string): { label: string; kind: PublicEvidenceItemKind; description: string } {
  const lower = url.toLowerCase();
  if (lower.includes("galex.stsci.edu") || lower.includes("tilelist")) {
    return { label: "官方 tile inventory 页面", kind: "coverage-input", description: "STScI 官方 tile 清单页面；当前只作为覆盖筛选输入，尚未转换成该 release 的身份精确 MOC。" };
  }
  if (lower.includes("mocserver") || lower.includes("get=smoc")) {
    return { label: "CDS 原始 MOC", kind: "raw-moc", description: "CDS MocServer 提供的原始空间覆盖；它是覆盖输入，不是 Assets 的官方数据查询服务。" };
  }
  if (lower.endsWith(".zip") || lower.includes("region_files")) {
    return { label: "区域文件 ZIP", kind: "coverage-input", description: "官方发布的区域边界压缩包，解析后用于计算覆盖。" };
  }
  if (lower.endsWith(".fits") || lower.includes("tiles-")) {
    return { label: "FITS 覆盖输入", kind: "coverage-input", description: "官方 FITS 文件；读取其中的空间字段或 WCS 作为覆盖计算输入。" };
  }
  if (lower.includes("oss-") || lower.includes("/prefix") || !lower.includes(".")) {
    return { label: "OSS 源目录 / prefix", kind: "coverage-input", description: "对象存储目录前缀；扫描符合 recipe 的文件并读取其空间信息。" };
  }
  return { label: "官方覆盖说明或输入", kind: "coverage-input", description: "来源页面或文件，用于确认本产品的覆盖边界。" };
}

function purposeFor(kind: string): string {
  const purposes: Record<string, string> = {
    input: "锁定本次计算使用的官方输入或对象存储目录。",
    filter: "只保留 recipe 指定的文件或质量记录，并保留被拒绝项作为证据。",
    header: "读取 FITS header/WCS，确认文件确实包含二维天球坐标。",
    parse: "解析 DS9 区域或其他声明的几何格式。",
    icrs: "把空间坐标验证并统一到 ICRS。",
    validate: "验证原生 MOC 的 ICRS、NUNIQ 和 MOC 版本声明。",
    geometry: "从 WCS、tile 中心/半径或 RA/DEC 点得到空间边界。",
    rasterize: "把空间边界栅格化为明确的 NESTED HEALPix order/ipix。",
    normalize: "把扫描结果规范化为可比较的 order/ipix 记录并保留源文件关联。",
    project: "从权威结果投影出真实存在的查询和网站预览等级。",
    union: "canonicalize、union 并去重，避免同一 cell 重复计数。",
    outputs: "写出 FITS MOC、查询投影、预览和统计文件。",
    evidence: "保存 recipe、输入快照、provenance 和每个公开制品的 hash。",
    warehouse: "读取 Warehouse 当前 ACTIVE layer 的显式 coverage edges。",
  };
  return purposes[kind] ?? "执行 recipe 声明的覆盖处理步骤。";
}

function librariesFor(mode: string, kind: string): string[] {
  if (kind === "warehouse") return ["data-warehouse ast_* indexes"];
  if (mode === "regions") return ["astropy", "regions", "mocpy", "astropy-healpix"];
  if (mode === "tile-table") return ["astropy", "mocpy", "astropy-healpix", "desimodel (radius authority)"];
  if (mode === "native-moc") return ["astropy", "astro_survey_moc_core"];
  if (mode === "catalog-radec") return ["astropy", "astropy-healpix", "mocpy"];
  return ["astropy", "astropy.wcs", "astropy-healpix", "mocpy"];
}

function codeFor(mode: string, kind: string): PublicProductCodeEvidence | undefined {
  const snippets: Record<string, { snippet: string; implementationRef: string }> = {
    "*:input": {
      snippet: "input_digest = hashlib.sha256(input_path.read_bytes()).hexdigest() if input_path else None\nif rebuild and input_digest != spec.snapshot.get(\"sha256\"):\n    raise ValueError(\"Locked snapshot SHA-256 does not match the local input\")",
      implementationRef: "astro_survey_moc_core.core:build_layer",
    },
    "*:filter": {
      snippet: "for path in sorted(source_paths):\n    if allowed_suffixes and path.suffix.lower() not in allowed_suffixes:\n        continue\n    selected.append(path)",
      implementationRef: "data-warehouse ScanPlan v2 filters.includeSuffixes",
    },
    "*:header": {
      snippet: "with fits.open(path, memmap=False) as hdul:\n    return [hdu.header.copy() for hdu in hdul]",
      implementationRef: "astro_survey_moc_core.core:_wcs_headers",
    },
    "*:icrs": {
      snippet: "wcs = WCS(header, naxis=2).celestial\nsky = wcs.pixel_to_world(x, y).icrs",
      implementationRef: "astro_survey_moc_core.core:_cells_from_fits_wcs",
    },
    "*:parse": {
      snippet: "region_sets = [Regions.read(path, format=spec.recipe.get(\"format\", \"ds9\"))]\nfor region in (region for region_set in region_sets for region in region_set):\n    moc = MOC.from_astropy_regions(region, max_depth=spec.max_order)",
      implementationRef: "astro_survey_moc_core.core:_cells_from_regions",
    },
    "*:geometry": {
      snippet: "edge = (\n    [(x, -0.5) for x in x_forward]\n    + [(width - 0.5, y) for y in y_forward[1:]]\n    + [(x, height - 0.5) for x in x_forward[-2::-1]]\n    + [(-0.5, y) for y in y_forward[-2:0:-1]]\n)\nsky = wcs.pixel_to_world(np.asarray([point[0] for point in edge]), np.asarray([point[1] for point in edge])).icrs\nresult.update(_polygon_cells(sky, spec.max_order))",
      implementationRef: "astro_survey_moc_core.core:_cells_from_fits_wcs",
    },
    "fits-wcs:header": {
      snippet: "with fits.open(path, memmap=False) as hdul:\n    wcs = WCS(hdul[0].header, naxis=2).celestial\n    sky = wcs.pixel_to_world(x, y).icrs",
      implementationRef: "astro_survey_moc_core.core:_cells_from_fits_wcs",
    },
    "nested-healpix:rasterize": {
      snippet: "hp = HEALPix(nside=2**order, order=\"nested\", frame=ICRS())\npixels = hp.skycoord_to_healpix(SkyCoord(ra * u.deg, dec * u.deg, frame=\"icrs\"))",
      implementationRef: "astro_survey_moc_core.core:_cells_from_radec",
    },
    "fits-wcs:rasterize": {
      snippet: "moc = MOC.from_polygon_skycoord(vertices, max_depth=order)\nreturn {(order, int(pixel)) for pixel in moc.flatten()}",
      implementationRef: "astro_survey_moc_core.core:_polygon_cells",
    },
    "regions:parse": {
      snippet: "region_set = Regions.parse(text, format=\"ds9\")\nfor region in region_set:\n    moc = MOC.from_astropy_regions(region, max_depth=spec.max_order)",
      implementationRef: "astro_survey_moc_core.core:_cells_from_regions",
    },
    "regions:rasterize": {
      snippet: "moc = MOC.from_astropy_regions(region, max_depth=spec.max_order)\nresult.update((spec.max_order, int(pixel)) for pixel in moc.flatten())",
      implementationRef: "astro_survey_moc_core.core:_cells_from_regions",
    },
    "tile-table:geometry": {
      snippet: "rows = _rows_from_input(path, spec.recipe)\npoints = _parse_points(rows, spec.recipe)\nradius = float(spec.recipe.get(\"radiusDeg\", 0))\nreturn _cells_from_radec_circles(points, spec.max_order, radius)",
      implementationRef: "astro_survey_moc_core.core:_input_cells",
    },
    "catalog-radec:rasterize": {
      snippet: "coords = _skycoord([point[0] for point in points], [point[1] for point in points])\npixels = np.asarray(hp.skycoord_to_healpix(coords), dtype=np.int64).reshape(-1)\nreturn {(order, int(pixel)) for pixel in pixels}",
      implementationRef: "astro_survey_moc_core.core:_cells_from_radec",
    },
    "*:rasterize": {
      snippet: "cells = _cells_from_radec_circles(points, spec.max_order, radius_deg)\nresult = canonical_cells(cells, max_order=spec.max_order)",
      implementationRef: "astro_survey_moc_core.core:_cells_from_radec_circles",
    },
    "nested-healpix:header": {
      snippet: "if path.suffix.lower() in {\".fits\", \".fit\", \".fz\"}:\n    return set(validate_moc_fits(path))",
      implementationRef: "astro_survey_moc_core.core:_cells_from_nested",
    },
    "nested-healpix:normalize": {
      snippet: "cells = canonical_cells(raw_cells, max_order=spec.max_order)\nreturn tuple(sorted(cells, key=lambda value: (value[0], value[1])))",
      implementationRef: "astro_survey_moc_core.core:canonical_cells",
    },
    "*:normalize": {
      snippet: "cells = canonical_cells(_input_cells(spec, Path(base_dir)), max_order=spec.max_order)",
      implementationRef: "astro_survey_moc_core.core:canonical_cells",
    },
    "*:project": {
      snippet: "query_path.write_bytes(canonical_json({\n    \"schemaVersion\": 1,\n    \"order\": spec.query_order,\n    \"ordering\": \"NESTED\",\n    \"pixels\": project_cells(cells, spec.query_order),\n}) + b\"\\n\")",
      implementationRef: "astro_survey_moc_core.core:project_cells",
    },
    "native-moc:validate": {
      snippet: "if hdu.header.get(\"ORDERING\") != \"NUNIQ\":\n    raise ValueError(\"FITS MOC ORDERING must be NUNIQ\")\nif hdu.header.get(\"COORDSYS\") != \"C\":\n    raise ValueError(\"FITS MOC COORDSYS must be ICRS celestial (C)\")",
      implementationRef: "astro_survey_moc_core.core:validate_moc_fits",
    },
    "*:union": {
      snippet: "canonical = canonical_cells(cells, max_order=max_order)",
      implementationRef: "astro_survey_moc_core.core:canonical_cells",
    },
    "*:outputs": {
      snippet: "sha256 = write_moc_fits(moc_path, cells, max_order=spec.max_order)\nquery_path.write_bytes(canonical_json({\"schemaVersion\": 1, \"order\": spec.query_order, \"ordering\": \"NESTED\", \"pixels\": project_cells(cells, spec.query_order)}) + b\"\\n\")",
      implementationRef: "astro_survey_moc_core.core:build_layer",
    },
    "*:evidence": {
      snippet: "def _file_record(path: Path) -> dict[str, Any]:\n    return {\"path\": path.name, \"sha256\": hashlib.sha256(path.read_bytes()).hexdigest(), \"sizeBytes\": path.stat().st_size}",
      implementationRef: "astro_survey_moc_core.core:_file_record",
    },
  };
  const selected = snippets[`${mode}:${kind}`] ?? snippets[`*:${kind}`];
  return selected ? { language: "python", snippet: selected.snippet, implementationRef: selected.implementationRef } : undefined;
}

function noteItem(label: string, description: string, reason?: string): PublicProductEvidenceItem {
  return { kind: "note", label, description, visibility: "unavailable", ...(reason ? { reason } : {}) };
}

function stepOutputs(stepId: string, assets: PublicEvidenceAsset[]): PublicProductEvidenceItem[] {
  if (stepId === "outputs" || stepId === "project") {
    const outputKinds: Array<[string, string]> = stepId === "project"
      ? [["query", "order 查询投影"], ["preview", "网站预览"]]
      : [["moc", "FITS MOC"], ["query", "order 查询投影"], ["preview", "网站预览"], ["statistics", "覆盖统计"]];
    const output = outputKinds.flatMap(([needle, label]) => assets.filter((asset) => {
      const id = `${asset.id} ${asset.record.path}`.toLowerCase();
      const publicOutput = asset.record.deliveryClass !== "evidence" || asset.record.kind === "moc" || asset.record.kind === "provenance";
      return publicOutput && (needle === "moc" ? asset.record.kind === "moc" : id.includes(needle));
    }).map((asset) => publicAssetItem(asset, "artifact", `Assets 发布的 ${label}，可下载并用 SHA-256 校验。`)));
    return output.length ? dedupeItems(output) : [noteItem("中间输出未提供", "本产品没有单独发布该步骤的文件。", "当前发布目录中未找到对应制品。")];
  }
  if (stepId === "evidence") {
    // Recipe locks, manifests, normalized scans and task snapshots are
    // internal evidence inputs. Only publish the resulting provenance,
    // statistics and Resource Package references in a public dossier.
    const output = assets.filter((asset) => asset.record.deliveryClass !== "evidence"
      && ["provenance", "package", "metadata"].includes(asset.record.kind)
      && !/lock|manifest|normalized|snapshot|task|run-statistics|sample-report/i.test(`${asset.record.id} ${asset.record.path}`))
      .map((asset) => publicAssetItem(asset, "artifact", "公开 provenance、统计或 Resource Package 制品。"));
    return output.length ? dedupeItems(output) : [noteItem("证据制品未提供", "证据保存在受控存储中，当前没有公开下载文件。")];
  }
  return [noteItem("中间结果未单独发布", "该步骤的结果直接交给下一步消费，发布目录没有单独文件。", "中间对象不是稳定公开制品。")];
}

function stepInputs(stepId: string, sourceReferences: PublicProductEvidenceItem[], snapshot: PublicProductEvidenceItem | undefined, body: string | undefined): PublicProductEvidenceItem[] {
  const inputs = stepId === "input" ? [...sourceReferences, ...(snapshot ? [snapshot] : [])] : [];
  if (body?.trim()) inputs.push({ kind: "note", label: "锁定 recipe 参数", description: body.replace(/scannerRunId\s*=[^;]+;?\s*/gi, "").replace(/(?:^|[;\s])(input|manifestPath|evidencePath)=[^;\n]+/gi, " ").replace(/\s{2,}/g, " ").trim(), visibility: "public" });
  return dedupeItems(inputs);
}

export function buildPublicProductEvidence(input: PublicProductEvidenceInput): PublicProductEvidenceProjection {
  const { product, catalogEntry, layer, assets } = input;
  const officialUrl = safeExternalUrl(product.sourceUrl ?? catalogEntry?.sourceUrl);
  const geometryUrl = safeExternalUrl(product.geometrySourceUrl ?? catalogEntry?.geometrySourceUrl);
  const recipeSourceUrl = safeExternalUrl(layer?.recipe?.sourceUrl);
  const sourceReferences: PublicProductEvidenceItem[] = [];
  if (officialUrl) sourceReferences.push({ kind: "official-release", label: product.sourceLabel ?? catalogEntry?.sourceLabel ?? "官方发布入口", description: "产品版本、说明和官方访问导航。", visibility: "public", url: officialUrl });
  if (geometryUrl) {
    const source = sourceKind(geometryUrl);
    sourceReferences.push({ kind: source.kind, label: product.geometrySourceLabel ?? catalogEntry?.geometrySourceLabel ?? source.label, description: source.description, visibility: "public", url: geometryUrl });
  }
  if (recipeSourceUrl && recipeSourceUrl !== geometryUrl) {
    const source = sourceKind(recipeSourceUrl);
    sourceReferences.push({ kind: source.kind, label: source.label, description: source.description, visibility: "public", url: recipeSourceUrl });
  }
  const officialDataUrl = safeExternalUrl(product.officialDataUrl ?? catalogEntry?.officialDataUrl);
  if (officialDataUrl) sourceReferences.push({ kind: "official-data", label: product.officialDataLabel ?? catalogEntry?.officialDataLabel ?? "官方数据", description: "官方数据下载或归档入口；没有显式地址时不生成此项。", visibility: "public", url: officialDataUrl });
  const officialQueryUrl = safeExternalUrl(product.officialQueryUrl ?? catalogEntry?.officialQueryUrl);
  if (officialQueryUrl) sourceReferences.push({ kind: "official-query", label: product.officialQueryLabel ?? catalogEntry?.officialQueryLabel ?? "官方查询", description: "官方查询服务入口；Assets 不将自身覆盖 API 冒充为 TAP、ObsCore 或 SIA。", visibility: "public", url: officialQueryUrl });
  const rawMoc = assets.find((asset) => asset.record.kind === "moc" && /\/raw\/moc\//.test(asset.record.path));
  if (rawMoc) sourceReferences.push(publicAssetItem(rawMoc, "raw-moc", "Assets 保存的原始 MOC 输入快照；它不是科学数据文件。"));
  const snapshot = layer?.recipe?.sourceSnapshotSha256
    ? { kind: "snapshot" as const, label: "输入快照 hash", description: "输入快照保存在 evidence 存储；浏览器只收到 hash 和大小，不返回内部路径或扫描文档。", visibility: "evidence-only" as const, sha256: layer.recipe.sourceSnapshotSha256, ...(layer.recipe.sourceSnapshotSizeBytes !== undefined ? { sizeBytes: layer.recipe.sourceSnapshotSizeBytes } : {}) }
    : undefined;
  if (snapshot) sourceReferences.push(snapshot);

  const mode = layer?.recipe?.mode ?? product.mode ?? "catalog-radec";
  const recipeSteps = layer?.recipe?.steps ?? product.presentation.flow.nodes.map((node: ProductFlowNode) => ({ ...node, kind: node.kind ?? node.id }));
  const implementationMode = mode === "nested-healpix" && recipeSteps.some((step) => /scannerMode\s*=\s*fits-wcs/i.test(step.bodyMarkdown)) ? "fits-wcs" : mode;
  const steps = recipeSteps.map((step, index): PublicProductDerivationStep => {
    const hasLayer = Boolean(layer);
    const outputItems = hasLayer ? stepOutputs(step.id, assets) : [noteItem("未提供", "当前没有已发布的覆盖层，因此这一步没有可复核输出。", "先取得并锁定几何输入后才能执行。")];
    const outputAvailable = outputItems.some((item) => item.visibility === "public" && Boolean(item.url || item.sha256));
    const status: PublicProductDerivationStep["status"] = !hasLayer
      ? step.id === "input" && sourceReferences.length ? "partial" : "unavailable"
      : step.id === "input" && !snapshot && !geometryUrl && !recipeSourceUrl ? "partial"
        : (step.id === "outputs" || step.id === "evidence") && !outputAvailable ? "partial" : "available";
    const body = "bodyMarkdown" in step ? step.bodyMarkdown : undefined;
    return {
      sequence: index + 1,
      id: step.id,
      title: step.title,
      purpose: purposeFor(step.id),
      inputs: stepInputs(step.id, sourceReferences, snapshot, body),
      method: { libraries: librariesFor(mode, step.id), implementationRef: step.implementationRef },
      ...(codeFor(implementationMode, step.id) ? { code: codeFor(implementationMode, step.id) } : {}),
      outputs: outputItems,
      status,
      ...(status !== "available" ? { reason: status === "partial" && step.id === "input" ? "输入来源可见，但没有锁定的快照 hash 或完整覆盖输入。" : "尚未取得可复核的覆盖输入或公开发布制品。" } : {}),
    };
  });
  return { sourceReferences: dedupeItems(sourceReferences), steps };
}
