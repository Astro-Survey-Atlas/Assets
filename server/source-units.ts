import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { Healpix, Pointing } from "healpixjs";
import { resolveEuclidQ1MerFile } from "./euclid-data-links.js";
import { SOURCE_UNIT_DISK_INDEX_VERSION, SourceUnitDiskIndex, type SourceUnitDiskLayerInput } from "./source-unit-disk-index.js";

export interface SourceUnitAccessUri {
  url: string;
  fileName?: string;
}

export interface SourceUnit {
  unitId: string;
  unitKind: string;
  raDeg: number;
  decDeg: number;
  radiusDeg: number;
  exposureCount?: number;
  lastNight?: number;
  downloadUrl: string;
  accessUris?: SourceUnitAccessUri[];
  accessAvailability?: "public" | "source-policy" | "unverified";
  footprint?: Array<[number, number]>;
  note?: string;
  geometryPrecision: "exact" | "estimated";
  sourceSnapshotSha256: string;
}

export interface SourceUnitLayerDescriptor {
  layerId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality?: string;
}

interface SourceUnitLayerBinding extends Omit<SourceUnitLayerDescriptor, "layerId"> {
  unitKind: string;
  snapshotKey: string;
  productPath?: "coadd" | "tractor";
  status: "exact" | "estimated";
  notes: string;
}

export interface SourceUnitCoverageLayer {
  layerId: string;
  surveyId: string;
  releaseId: string;
  product: string;
  modality: string;
  unitKind: string;
  sourceSnapshotSha256: string;
  sourceUrls: string[];
  accessUrl: string;
  notes: string;
  coverageMethod?: "native-footprints" | "unit-centers";
  cells: Map<number, number[]>;
}

/** Managed builds write a candidate; query workers only open its frozen artifact. */
export interface SourceUnitLoadOptions {
  indexPath?: string;
  buildKey?: string;
  readOnly?: boolean;
  lockText?: string;
  recipes?: Record<string, string>;
  /** A managed delta build parses one release; its database is merged into a copy. */
  sourceScope?: { surveyId: string; releaseId: string };
}

function sourceUnitIdentity(surveyId: string, releaseId: string, product: string): string {
  return `${surveyId}\u0000${releaseId}\u0000${product}`;
}

function sourceUnitDiskAlias(alias: string): string {
  const parts = alias.split("\u0000");
  return parts.length === 1 ? alias : `identity:${parts.map(encodeURIComponent).join("/")}`;
}

async function sourceUnitDiskCacheKey(root: string, registryText: string, lockText: string, registry: { layers?: Array<{ surveyId: string; recipePath?: string }> }, recipes: Record<string, string> = {}): Promise<string> {
  const modulePath = fileURLToPath(import.meta.url);
  const extension = path.extname(modulePath);
  const moduleDirectory = path.dirname(modulePath);
  const key = createHash("sha256").update(`source-unit-disk-index:${SOURCE_UNIT_DISK_INDEX_VERSION}\n`);
  key.update(registryText).update("\n").update(lockText).update("\n");
  for (const moduleName of ["source-units", "source-unit-disk-index", "euclid-data-links"]) {
    const bytes = await readFile(path.join(moduleDirectory, `${moduleName}${extension}`));
    key.update(moduleName).update("\n").update(bytes).update("\n");
  }
  const recipePaths = (registry.layers ?? [])
    .filter((layer) => layer.surveyId === "desi" && layer.recipePath)
    .map((layer) => layer.recipePath!)
    .sort();
  for (const recipePath of recipePaths) {
    key.update(recipePath).update("\n").update(recipes[recipePath] ?? await readFile(path.join(root, recipePath))).update("\n");
  }
  return key.digest("hex");
}

export interface MatchedSourceUnit extends SourceUnit {
  matchingCells: number[];
}

export interface SourceUnitMatch {
  status: "exact";
  precision: "estimated";
  unitKind: string;
  units: MatchedSourceUnit[];
  totalUnits: number;
  truncated: boolean;
  notes: string;
}

export function inspectSourceUnitInput(bytes: Buffer, kind: "legacy" | "desi" | "euclid" | "hsc"): { rows: number; columns: string[] } {
  if (kind === "hsc") {
    const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }) : bytes;
    const patches = parseHscPatchFile(decoded.toString("utf8"), "metadata", "metadata", "", "https://hsc-release.mtk.nao.ac.jp/");
    if (!patches.length) throw new Error("HSC metadata contains no valid tract/patch polygons");
    return { rows: patches.length, columns: ["tract", "patch", "center", "corners"] };
  }
  if (kind === "euclid") {
    const rows = parseCsv(bytes.toString("utf8"));
    const columns = rows[0]?.map(value => value.trim().toLowerCase()) ?? [];
    for (const column of ["tile_index", "file_name", "data_set_release", "stc_s"]) if (!columns.includes(column)) throw new Error(`Euclid metadata is missing ${column}`);
    return { rows: Math.max(0, rows.length - 1), columns };
  }
  const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }) : bytes;
  const table = binaryTable(decoded);
  const columns = table.columns.map(column => column.name.toUpperCase());
  if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 1 || table.dataOffset + table.rowCount * table.rowLength > decoded.length) throw new Error("Native metadata table is empty or incomplete");
  if (columns.some(column => /^(?:FLUX|WAVELENGTH|IVAR|FIBERFLUX|PSFFLUX)(?:_|$)/.test(column))) throw new Error("A science catalog or spectrum cannot be imported as native-unit metadata");
  for (const column of kind === "legacy" ? ["BRICKNAME", "RA", "DEC"] : ["TILEID", "TILERA", "TILEDEC", "NEXP"]) if (!columns.includes(column)) throw new Error(`Native metadata is missing ${column}`);
  return { rows: table.rowCount, columns };
}

interface SourceUnitLayerIndex {
  layerId: string;
  /**
   * Coarse NESTED cells bucket unit centers. Query-time radius expansion
   * keeps the candidate set conservative without rasterizing every unit at startup.
   */
  coarseOrder: number;
  coarseByPixel: Map<number, number[]>;
  maxUnitRadiusDeg: number;
  units: SourceUnit[];
  unitKind: string;
  notes: string;
  downloadUrlForUnit?: (unitId: string) => string;
  accessUrisForUnit?: (unitId: string) => SourceUnitAccessUri[];
  unitFilter?: (unitIndex: number) => boolean;
  sourceSnapshotSha256?: string;
  diskPayloadKind?: "legacy-release-roster";
  diskPayloadContext?: Record<string, unknown>;
  diskMembershipForUnit?: (unitId: string) => unknown;
}

interface SourceSnapshotLock {
  path: string;
  sourceUrl: string;
  sha256: string;
  sizeBytes: number;
}

interface FitsColumn { name: string; format: string; offset: number; width: number; }
interface FitsTable { rowLength: number; rowCount: number; dataOffset: number; columns: FitsColumn[]; }

function cardValue(card: string): string | undefined {
  if (card[8] !== "=") return undefined;
  const raw = card.slice(10).split("/", 1)[0]!.trim();
  return raw.startsWith("'") ? raw.slice(1, raw.lastIndexOf("'")).trim() : raw;
}

function headerAt(buffer: Buffer, offset: number): { values: Map<string, string>; dataOffset: number; nextOffset: number } {
  const values = new Map<string, string>();
  let cursor = offset;
  while (cursor + 80 <= buffer.length) {
    const card = buffer.toString("ascii", cursor, cursor + 80);
    cursor += 80;
    const key = card.slice(0, 8).trim();
    if (key === "END") break;
    const value = cardValue(card);
    if (key && value !== undefined) values.set(key, value);
  }
  const headerBytes = Math.ceil((cursor - offset) / 2880) * 2880;
  const dataOffset = offset + headerBytes;
  const naxis = Number(values.get("NAXIS") ?? 0);
  let dataBytes = Number(values.get("PCOUNT") ?? 0);
  if (values.get("XTENSION") === "BINTABLE") dataBytes += Number(values.get("NAXIS1") ?? 0) * Number(values.get("NAXIS2") ?? 0);
  else if (naxis > 0) {
    dataBytes = Math.abs(Number(values.get("BITPIX") ?? 8)) / 8;
    for (let axis = 1; axis <= naxis; axis += 1) dataBytes *= Number(values.get(`NAXIS${axis}`) ?? 0);
  }
  return { values, dataOffset, nextOffset: dataOffset + Math.ceil(dataBytes / 2880) * 2880 };
}

function formatWidth(format: string): number {
  const match = /^(\d*)([A-Z])/.exec(format.trim());
  if (!match) throw new Error(`Unsupported FITS TFORM: ${format}`);
  const count = Number(match[1] || 1);
  const widths: Record<string, number> = { A: 1, B: 1, I: 2, J: 4, K: 8, E: 4, D: 8, L: 1 };
  const width = widths[match[2]!];
  if (!width) throw new Error(`Unsupported FITS TFORM: ${format}`);
  return count * width;
}

function binaryTable(buffer: Buffer, hduName?: string): FitsTable {
  let offset = 0;
  while (offset < buffer.length) {
    const header = headerAt(buffer, offset);
    if (header.values.get("XTENSION") === "BINTABLE" && (!hduName || header.values.get("EXTNAME") === hduName)) {
      const count = Number(header.values.get("TFIELDS") ?? 0);
      const columns: FitsColumn[] = [];
      let columnOffset = 0;
      for (let index = 1; index <= count; index += 1) {
        const name = header.values.get(`TTYPE${index}`) ?? `COL${index}`;
        const format = header.values.get(`TFORM${index}`) ?? "";
        const width = formatWidth(format);
        columns.push({ name, format, offset: columnOffset, width });
        columnOffset += width;
      }
      return { rowLength: Number(header.values.get("NAXIS1")), rowCount: Number(header.values.get("NAXIS2")), dataOffset: header.dataOffset, columns };
    }
    offset = header.nextOffset;
  }
  throw new Error(`FITS HDU ${hduName} not found`);
}

function stringValue(buffer: Buffer, rowOffset: number, column: FitsColumn): string {
  return buffer.toString("ascii", rowOffset + column.offset, rowOffset + column.offset + column.width).trim();
}

function numericValue(buffer: Buffer, rowOffset: number, column: FitsColumn): number {
  const offset = rowOffset + column.offset;
  const kind = /([A-Z])/.exec(column.format)?.[1];
  if (kind === "B") return buffer.readUInt8(offset);
  if (kind === "J") return buffer.readInt32BE(offset);
  if (kind === "K") return Number(buffer.readBigInt64BE(offset));
  if (kind === "D") return buffer.readDoubleBE(offset);
  if (kind === "E") return buffer.readFloatBE(offset);
  if (kind === "I") return buffer.readInt16BE(offset);
  throw new Error(`Unsupported numeric FITS column ${column.name}:${column.format}`);
}

function rangePixels(instance: Healpix, pointing: Pointing, radiusDeg: number): number[] {
  const ranges = instance.queryDiscInclusive(pointing, radiusDeg * Math.PI / 180, 8) as unknown as { r: Int32Array; sz: number };
  const pixels: number[] = [];
  for (let index = 0; index < ranges.sz; index += 2) for (let pixel = ranges.r[index]!; pixel < ranges.r[index + 1]!; pixel += 1) pixels.push(pixel);
  return pixels;
}

function polygonPixels(instance: Healpix, footprint: Array<[number, number]>, fact = 1): number[] {
  const vertices = footprint.map(([ra, dec]) => new Pointing(null, false, (90 - dec) * Math.PI / 180, ra * Math.PI / 180));
  const ranges = instance.queryPolygonInclusive(vertices, fact) as unknown as { r: Int32Array; sz: number };
  const pixels: number[] = [];
  for (let index = 0; index < ranges.sz; index += 2) for (let pixel = ranges.r[index]!; pixel < ranges.r[index + 1]!; pixel += 1) pixels.push(pixel);
  return pixels;
}

function angularDistanceDeg(a: [number, number], b: [number, number]): number {
  const radians = Math.PI / 180;
  const decA = a[1] * radians;
  const decB = b[1] * radians;
  const deltaRa = (a[0] - b[0]) * radians;
  const cosine = Math.sin(decA) * Math.sin(decB) + Math.cos(decA) * Math.cos(decB) * Math.cos(deltaRa);
  return Math.acos(Math.min(1, Math.max(-1, cosine))) / radians;
}

function buildLayerIndex(layerId: string, units: SourceUnit[], notes: string, sharedIndex?: SourceUnitLayerIndex): SourceUnitLayerIndex {
  if (sharedIndex) return { ...sharedIndex, layerId, units, notes };
  const coarseOrder = 4;
  const coarseHealpix = new Healpix(2 ** coarseOrder);
  const coarseByPixel = new Map<number, number[]>();
  units.forEach((unit, unitIndex) => {
    const pixel = coarseHealpix.ang2pix(new Pointing(null, false, (90 - unit.decDeg) * Math.PI / 180, unit.raDeg * Math.PI / 180));
    const candidates = coarseByPixel.get(pixel);
    if (candidates) candidates.push(unitIndex);
    else coarseByPixel.set(pixel, [unitIndex]);
  });
  return {
    layerId,
    coarseOrder,
    coarseByPixel,
    maxUnitRadiusDeg: units.reduce((maximum, unit) => Math.max(maximum, unit.radiusDeg), 0),
    units,
    unitKind: units[0]?.unitKind ?? "unknown",
    notes,
  };
}

function unitPixels(instance: Healpix, unit: SourceUnit): number[] {
  if (unit.footprint?.length) return polygonPixels(instance, unit.footprint);
  return rangePixels(instance, new Pointing(null, false, (90 - unit.decDeg) * Math.PI / 180, unit.raDeg * Math.PI / 180), unit.radiusDeg);
}

function unitGeometryKey(unit: SourceUnit): string {
  return unit.footprint?.length
    ? `polygon:${unit.footprint.map(([ra, dec]) => `${ra},${dec}`).join(";")}`
    : `circle:${unit.raDeg},${unit.decDeg},${unit.radiusDeg}`;
}

const MAX_MATCH_CACHE_REGIONS = 2;
const MAX_MATCH_CACHE_GEOMETRIES = 20_000;

function coveragePixels(units: SourceUnit[], order: number): number[] {
  const healpix = new Healpix(2 ** order);
  const pixels = new Set<number>();
  for (const unit of units) unitPixels(healpix, unit).forEach((pixel) => pixels.add(pixel));
  return [...pixels].sort((left, right) => left - right);
}

function sourceUnitCoverageLayerId(binding: SourceUnitLayerBinding): string {
  const slug = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `source-units-${slug(binding.surveyId)}-${slug(binding.releaseId)}-${slug(binding.product)}`;
}

async function readLockedSnapshot(root: string, lock: SourceSnapshotLock): Promise<{ bytes: Buffer; sha256: string }> {
  const paths = [
    path.join(root, lock.path),
    path.join(root, "artifacts/public-survey-footprints/raw", lock.path),
  ];
  let bytes: Buffer | undefined;
  for (const candidate of paths) {
    try {
      bytes = await readFile(candidate);
      break;
    } catch {
      continue;
    }
  }
  if (!bytes) throw new Error(`Source-unit snapshot is missing: ${lock.path}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== lock.sizeBytes || sha256 !== lock.sha256) {
    throw new Error(`Source-unit snapshot does not match its lock: ${lock.path}`);
  }
  return { bytes, sha256 };
}

async function buildDesiLayer(root: string, evidenceRoot: string, input: { layerId: string; releaseId: string; recipePath: string }, recipeText?: string): Promise<SourceUnitLayerIndex> {
  const recipe = JSON.parse(recipeText ?? await readFile(path.join(root, input.recipePath), "utf8")) as { input: string; snapshot: { sha256: string; sizeBytes?: number }; recipe: { hdu: string; raColumn: string; decColumn: string; nexpColumn: string; nexpMin: number; radiusDeg: number } };
  const evidencePath = recipe.input.split("/raw/").at(-1);
  if (!evidencePath) throw new Error(`${input.layerId} recipe input is not evidence-backed`);
  let buffer: Buffer | undefined;
  for (const candidate of [path.join(evidenceRoot, evidencePath), path.join(evidenceRoot, recipe.input)]) {
    try {
      buffer = await readFile(candidate);
      break;
    } catch {
      continue;
    }
  }
  if (!buffer) throw new Error(`${input.layerId} evidence snapshot is missing`);
  if ((recipe.snapshot.sizeBytes !== undefined && buffer.byteLength !== recipe.snapshot.sizeBytes) || createHash("sha256").update(buffer).digest("hex") !== recipe.snapshot.sha256) {
    throw new Error(`${input.layerId} source snapshot does not match its recipe lock`);
  }
  const table = binaryTable(buffer, recipe.recipe.hdu);
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const required = ["TILEID", recipe.recipe.raColumn, recipe.recipe.decColumn, recipe.recipe.nexpColumn, "LASTNIGHT"];
  required.forEach((name) => { if (!columns.has(name)) throw new Error(`${input.layerId} source table is missing ${name}`); });
  const specprod = input.releaseId === "desi-dr1" ? "iron" : "fuji";
  const release = input.releaseId === "desi-dr1" ? "dr1" : "edr";
  const units: SourceUnit[] = [];
  for (let row = 0; row < table.rowCount; row += 1) {
    const rowOffset = table.dataOffset + row * table.rowLength;
    const exposureCount = numericValue(buffer, rowOffset, columns.get(recipe.recipe.nexpColumn)!);
    if (exposureCount < recipe.recipe.nexpMin) continue;
    const tileId = numericValue(buffer, rowOffset, columns.get("TILEID")!);
    const lastNight = numericValue(buffer, rowOffset, columns.get("LASTNIGHT")!);
    units.push({
      unitId: String(tileId),
      unitKind: "tile",
      raDeg: numericValue(buffer, rowOffset, columns.get(recipe.recipe.raColumn)!),
      decDeg: numericValue(buffer, rowOffset, columns.get(recipe.recipe.decColumn)!),
      radiusDeg: recipe.recipe.radiusDeg,
      exposureCount,
      lastNight,
      downloadUrl: `https://data.desi.lbl.gov/public/${release}/spectro/redux/${specprod}/tiles/cumulative/${tileId}/${lastNight}/`,
      geometryPrecision: "estimated",
      sourceSnapshotSha256: recipe.snapshot.sha256,
    });
  }
  return buildLayerIndex(input.layerId, units, "使用官方 TILE_COMPLETENESS 中心、NEXP 筛选及 DESI focal-plane radius 构成的圆形近似 footprint；命中表示可能相关的 Tile，不代表 Tile 内每个位置都有目标光谱。");
}

export function parseHscPatchFile(content: string, releaseId: string, region: string, sourceSnapshotSha256: string, dasSearchUrl: string): SourceUnit[] {
  const patches = new Map<string, SourceUnit>();
  let current: { tract: string; patch: string; center?: [number, number]; footprint: Array<[number, number]> } | undefined;
  const releaseLabel = releaseId.replace(/^hsc-/, "").toUpperCase();
  const finish = (): void => {
    if (!current?.center || current.footprint.length < 3) return;
    const footprint = current.footprint.filter((vertex, index, vertices) => index === 0 || vertex[0] !== vertices[index - 1]![0] || vertex[1] !== vertices[index - 1]![1]);
    if (footprint.length > 3 && footprint[0]![0] === footprint.at(-1)![0] && footprint[0]![1] === footprint.at(-1)![1]) footprint.pop();
    const unitId = `${current.tract}/${current.patch}`;
    const radiusDeg = Math.max(...footprint.map((vertex) => angularDistanceDeg(current!.center!, vertex)));
    const existing = patches.get(unitId);
    if (existing) {
      existing.note = `${existing.note}; ${region}`;
      return;
    }
    patches.set(unitId, {
      unitId,
      unitKind: "tract/patch",
      raDeg: current.center[0],
      decDeg: current.center[1],
      radiusDeg,
      footprint,
      downloadUrl: dasSearchUrl,
      accessAvailability: "source-policy",
      geometryPrecision: "estimated",
      sourceSnapshotSha256,
      note: `HSC ${releaseLabel} ${region}; use Tract ${current.tract} / Patch ${current.patch} in HSC DAS Search. The official list supplies patch geometry and identity; band-specific file availability and account access are resolved by HSC.`,
    });
  };
  for (const line of content.split(/\r?\n/)) {
    const center = /^Tract:\s*(\d+)\s+Patch:\s*([0-8],[0-8])\s+Center \(RA, Dec\):\s*\(([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\)/.exec(line);
    if (center) {
      finish();
      current = { tract: center[1]!, patch: center[2]!, center: [Number(center[3]), Number(center[4])], footprint: [] };
      continue;
    }
    const corner = /^Tract:\s*(\d+)\s+Patch:\s*([0-8],[0-8])\s+Corner\d+ \(RA, Dec\):\s*\(([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\)/.exec(line);
    if (corner && current && current.tract === corner[1] && current.patch === corner[2]) current.footprint.push([Number(corner[3]), Number(corner[4])]);
  }
  finish();
  return [...patches.values()];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += char;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function parseStcPolygon(region: string): Array<[number, number]> | undefined {
  const match = /^Polygon(?:\s+(?:ICRS|J2000))?\s+(.+)$/i.exec(region.trim());
  if (!match) return undefined;
  const values = match[1]!.trim().split(/\s+/).map(Number);
  if (values.length < 6 || values.length % 2 !== 0 || values.some((value) => !Number.isFinite(value))) return undefined;
  const vertices: Array<[number, number]> = [];
  for (let index = 0; index < values.length; index += 2) {
    const ra = values[index]!;
    const dec = values[index + 1]!;
    if (dec < -90 || dec > 90) return undefined;
    vertices.push([((ra % 360) + 360) % 360, dec]);
  }
  if (vertices.length > 3 && vertices[0]![0] === vertices.at(-1)![0] && vertices[0]![1] === vertices.at(-1)![1]) vertices.pop();
  return vertices;
}

function sphericalCentroid(points: Array<[number, number]>): [number, number] {
  const radians = Math.PI / 180;
  let x = 0, y = 0, z = 0;
  points.forEach(([ra, dec]) => {
    const longitude = ra * radians;
    const latitude = dec * radians;
    x += Math.cos(latitude) * Math.cos(longitude);
    y += Math.cos(latitude) * Math.sin(longitude);
    z += Math.sin(latitude);
  });
  return [((Math.atan2(y, x) / radians) % 360 + 360) % 360, Math.atan2(z, Math.hypot(x, y)) / radians];
}

function parseEuclidRows(content: string, sourceSnapshotSha256: string): Map<string, SourceUnitLayerIndex> {
  const rows = parseCsv(content);
  const header = new Map(rows[0]?.map((value, index) => [value.trim().toLowerCase(), index]) ?? []);
  const requiredColumns = ["tile_index", "file_name", "file_path", "datalabs_path", "data_set_release", "stc_s"];
  if (requiredColumns.some((name) => !header.has(name))) throw new Error("Euclid ObsCore snapshot is missing required columns");
  const column = (row: string[], key: string): string => row[header.get(key)!] ?? "";
  const grouped = new Map<string, Map<string, SourceUnit>>();
  for (const row of rows.slice(1)) {
    const tileId = column(row, "tile_index").trim();
    const fileName = column(row, "file_name").trim();
    const filePath = column(row, "file_path").trim().replace(/\/+$/, "");
    const datalabsPath = column(row, "datalabs_path").trim().replace(/\/+$/, "");
    const release = column(row, "data_set_release").trim();
    const footprint = parseStcPolygon(column(row, "stc_s"));
    if (!/^\d+$/.test(tileId) || !fileName || !filePath.startsWith("/") || !datalabsPath.startsWith("/") || !footprint || release !== "Q1_R1") continue;
    const productMetadata = ["instrument_name", "filter_name", "product_type"].map((key) => column(row, key)).join(" ");
    const productName = `${fileName} ${productMetadata}`.toLowerCase();
    const compactName = productName.replace(/[^a-z0-9]/g, "");
    const productKey = /mosaic(?:nir|nisp)h/.test(compactName) ? "nir-h"
      : /mosaic(?:nir|nisp)j/.test(compactName) ? "nir-j"
        : /mosaic(?:nir|nisp)y/.test(compactName) ? "nir-y"
          : /mosaicvis/.test(compactName) ? "vis"
            : /mosaic(?:des|wishes|panstarrs|cfis)/.test(compactName) ? "des-color"
              : undefined;
    if (!productKey) continue;
    const geometryCenter = sphericalCentroid(footprint);
    const radiusDeg = Math.max(...footprint.map((vertex) => angularDistanceDeg(geometryCenter, vertex)));
    const unitId = tileId;
    const index = grouped.get(productKey) ?? new Map<string, SourceUnit>();
    const existing = index.get(unitId);
    const dataLink = resolveEuclidQ1MerFile(fileName, { surveyId: "euclid", releaseId: "euclid-q1" });
    const fileUrl = dataLink?.downloadUrl ?? "https://datalabs.esa.int/";
    const note = `Tile ${tileId}; Data Labs path: ${datalabsPath}/${fileName}; archive path: ${filePath}/${fileName}; published=${column(row, "published") || "unknown"}. The file link uses ESA SAS-DD when its filename is supported; TAP published is retained as metadata, not treated as SAS-DD availability.`;
    if (existing) {
      existing.accessUris ??= [];
      if (!existing.accessUris.some((entry) => entry.fileName === fileName)) existing.accessUris.push({ fileName, url: fileUrl });
      if (!existing.note?.includes(`${datalabsPath}/${fileName}`)) existing.note = `${existing.note}; ${note}`;
      if (!dataLink) existing.accessAvailability = "unverified";
    } else {
      index.set(unitId, {
        unitId,
        unitKind: "tile",
        raDeg: geometryCenter[0],
        decDeg: geometryCenter[1],
        radiusDeg,
        footprint,
        downloadUrl: fileUrl,
        accessUris: [{ fileName, url: fileUrl }],
        accessAvailability: dataLink ? "public" : "unverified",
        geometryPrecision: "estimated",
        sourceSnapshotSha256,
        note: `The native unit is the ESA Tile identified by tile_index. This product row's stc_s supplies product-footprint geometry. ${note}`,
      });
    }
    grouped.set(productKey, index);
  }
  const productLabels: Record<string, string> = {
    "nir-h": "Euclid Q1 NISP.H",
    "nir-j": "Euclid Q1 NISP.J",
    "nir-y": "Euclid Q1 NISP.Y",
    vis: "Euclid Q1 VIS",
    "des-color": "Euclid Q1 color imaging",
  };
  const indexes = new Map<string, SourceUnitLayerIndex>();
  for (const [productKey, units] of grouped) {
    indexes.set(productKey, buildLayerIndex(`euclid:euclid-q1:${productKey}`, [...units.values()], `ESA TAP q1.mosaic_product ${productLabels[productKey]}; tile_index is the native Tile ID. The row's stc_s supplies product geometry. Matching uses inclusive HEALPix polygon overlap, so boundary candidates are marked estimated; the locked snapshot contains only its declared BGSUB mosaic query scope.`));
  }
  return indexes;
}

export function legacyDr1ImageUrl(unitId: string, band: string): string {
  const prefix = unitId.slice(0, 3);
  return `ftp://archive.noao.edu/public/hlsp/decals/dr1/coadd/${prefix}/${unitId}/decals-${unitId}-image-${band}.fits`;
}

function legacyDr1TractorUrl(unitId: string): string {
  const prefix = unitId.slice(0, 3);
  return `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr1/tractor/${prefix}/tractor-${unitId}.fits`;
}

function legacyDr2TractorUrl(unitId: string): string {
  const prefix = unitId.slice(0, 3);
  return `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr2/tractor/${prefix}/tractor-${unitId}.fits`;
}

function legacyDr2ImageUrl(unitId: string, band: string): string {
  const prefix = unitId.slice(0, 3);
  return `ftp://archive.noao.edu/public/hlsp/decals/dr2/coadd/${prefix}/${unitId}/decals-${unitId}-image-${band}.fits`;
}

function parseLegacyDr1Bricks(bytes: Buffer, sourceSnapshotSha256: string): { coaddUnits: SourceUnit[]; tractorUnits: SourceUnit[] } {
  const table = binaryTable(bytes);
  const columns = new Map(table.columns.map((column) => [column.name.toUpperCase(), column]));
  const required = ["BRICKNAME", "RA", "DEC", "RA1", "RA2", "DEC1", "DEC2", "HAS_IMAGE_G", "HAS_IMAGE_R", "HAS_IMAGE_Z", "HAS_CATALOG"];
  required.forEach((name) => { if (!columns.has(name)) throw new Error(`Legacy DR1 brick source is missing ${name}`); });
  const bands = ["g", "r", "z"] as const;
  const coaddUnits: SourceUnit[] = [];
  const tractorUnits: SourceUnit[] = [];
  for (let row = 0; row < table.rowCount; row += 1) {
    const rowOffset = table.dataOffset + row * table.rowLength;
    const unitId = stringValue(bytes, rowOffset, columns.get("BRICKNAME")!);
    if (!/^\d{4}[pm]\d{3}$/.test(unitId)) continue;
    const availableBands = bands.filter((band) => numericValue(bytes, rowOffset, columns.get(`HAS_IMAGE_${band.toUpperCase()}`)!) > 0);
    const hasCatalog = numericValue(bytes, rowOffset, columns.get("HAS_CATALOG")!) > 0;
    if (!availableBands.length && !hasCatalog) continue;
    const ra = numericValue(bytes, rowOffset, columns.get("RA")!);
    const dec = numericValue(bytes, rowOffset, columns.get("DEC")!);
    let ra1 = numericValue(bytes, rowOffset, columns.get("RA1")!);
    let ra2 = numericValue(bytes, rowOffset, columns.get("RA2")!);
    const dec1 = numericValue(bytes, rowOffset, columns.get("DEC1")!);
    const dec2 = numericValue(bytes, rowOffset, columns.get("DEC2")!);
    if (ra1 > ra2) ra2 += 360;
    const footprint = [[ra1, dec1], [ra2, dec1], [ra2, dec2], [ra1, dec2]].map(([lon, lat]): [number, number] => [((lon! % 360) + 360) % 360, lat!]);
    const radiusDeg = Math.max(...footprint.map((vertex) => angularDistanceDeg([ra, dec], vertex)));
    if (availableBands.length) {
      const accessUris = availableBands.map((band) => ({ fileName: `decals-${unitId}-image-${band}.fits`, url: legacyDr1ImageUrl(unitId, band) }));
      coaddUnits.push({
        unitId,
        unitKind: "brick",
        raDeg: ra,
        decDeg: dec,
        radiusDeg,
        footprint,
        downloadUrl: accessUris[0]!.url,
        accessUris,
        accessAvailability: "unverified",
        geometryPrecision: "estimated",
        sourceSnapshotSha256,
        note: `Official DR1 brick geometry and image membership flags; this brick lists imaging in ${availableBands.join(", ")} band(s). The NERSC DR1 Coadd tree was removed; the release page points to the NOAO archive FTP. Per-band URIs follow its documented path rule but have not been checked individually.`
      });
    }
    if (hasCatalog) {
      const url = legacyDr1TractorUrl(unitId);
      tractorUnits.push({
        unitId,
        unitKind: "brick",
        raDeg: ra,
        decDeg: dec,
        radiusDeg,
        footprint,
        downloadUrl: url,
        accessUris: [{ fileName: `tractor-${unitId}.fits`, url }],
        accessAvailability: "unverified",
        geometryPrecision: "estimated",
        sourceSnapshotSha256,
        note: "Official DR1 has_catalog membership flag identifies this Tractor brick. The candidate URI follows the documented DR1 path rule; individual file presence has not been checked."
      });
    }
  }
  return { coaddUnits, tractorUnits };
}

function parseLegacyDr2Bricks(bytes: Buffer, sourceSnapshotSha256: string): { coaddUnits: SourceUnit[]; tractorUnits: SourceUnit[] } {
  const table = binaryTable(bytes);
  const columns = new Map(table.columns.map((column) => [column.name.toUpperCase(), column]));
  const required = ["BRICKNAME", "RA", "DEC", "RA1", "RA2", "DEC1", "DEC2", "NOBS_MAX_G", "NOBS_MAX_R", "NOBS_MAX_Z"];
  required.forEach((name) => { if (!columns.has(name)) throw new Error(`Legacy DR2 brick roster is missing ${name}`); });
  const coaddUnits: SourceUnit[] = [];
  const tractorUnits: SourceUnit[] = [];
  const bands = ["g", "r", "z"] as const;
  for (let row = 0; row < table.rowCount; row += 1) {
    const rowOffset = table.dataOffset + row * table.rowLength;
    const unitId = stringValue(bytes, rowOffset, columns.get("BRICKNAME")!);
    if (!/^\d{4}[pm]\d{3}$/.test(unitId)) continue;
    const ra = numericValue(bytes, rowOffset, columns.get("RA")!);
    const dec = numericValue(bytes, rowOffset, columns.get("DEC")!);
    let ra1 = numericValue(bytes, rowOffset, columns.get("RA1")!);
    let ra2 = numericValue(bytes, rowOffset, columns.get("RA2")!);
    const dec1 = numericValue(bytes, rowOffset, columns.get("DEC1")!);
    const dec2 = numericValue(bytes, rowOffset, columns.get("DEC2")!);
    if (ra1 > ra2) ra2 += 360;
    const footprint = [[ra1, dec1], [ra2, dec1], [ra2, dec2], [ra1, dec2]]
      .map(([lon, lat]): [number, number] => [((lon! % 360) + 360) % 360, lat!]);
    const radiusDeg = Math.max(...footprint.map((vertex) => angularDistanceDeg([ra, dec], vertex)));
    const common = {
      unitId,
      unitKind: "brick",
      raDeg: ra,
      decDeg: dec,
      radiusDeg,
      footprint,
      geometryPrecision: "estimated",
      sourceSnapshotSha256,
    } satisfies Pick<SourceUnit, "unitId" | "unitKind" | "raDeg" | "decDeg" | "radiusDeg" | "footprint" | "geometryPrecision" | "sourceSnapshotSha256">;
    const tractorUrl = legacyDr2TractorUrl(unitId);
    tractorUnits.push({
      ...common,
      downloadUrl: tractorUrl,
      accessUris: [{ fileName: `tractor-${unitId}.fits`, url: tractorUrl }],
      accessAvailability: "unverified",
      note: "Official DR2 release brick roster supplies this brick identity and footprint. Tractor URI follows the DR2 files-page rule; sample 2134m090 returned HTTP 200, but this individual URI has not been checked.",
    });
    const availableBands = bands.filter((band) => numericValue(bytes, rowOffset, columns.get(`NOBS_MAX_${band.toUpperCase()}`)!) > 0);
    if (availableBands.length) {
      const accessUris = availableBands.map((band) => ({ fileName: `decals-${unitId}-image-${band}.fits`, url: legacyDr2ImageUrl(unitId, band) }));
      coaddUnits.push({
        ...common,
        downloadUrl: accessUris[0]!.url,
        accessUris,
        accessAvailability: "unverified",
        note: `Official DR2 release roster reports NOBS_MAX > 0 in ${availableBands.join(", ")} band(s); these statistics select candidate Coadd bricks but do not prove each image file exists. The documented NERSC Coadd tree has been removed and points to the NOAO FTP archive; the archive host did not resolve during this check.`,
      });
    }
  }
  return { coaddUnits, tractorUnits };
}

function parseLegacyBricks(bytes: Buffer, sourceSnapshotSha256: string, includedUnitIds?: ReadonlySet<string>): SourceUnit[] {
  const buffer = gunzipSync(bytes);
  const table = binaryTable(buffer);
  const columns = new Map(table.columns.map((column) => [column.name.toUpperCase(), column]));
  const required = ["BRICKNAME", "RA", "DEC", "RA1", "RA2", "DEC1", "DEC2"];
  required.forEach((name) => { if (!columns.has(name)) throw new Error(`Legacy brick source is missing ${name}`); });
  const units: SourceUnit[] = [];
  for (let row = 0; row < table.rowCount; row += 1) {
    const rowOffset = table.dataOffset + row * table.rowLength;
    const unitId = stringValue(buffer, rowOffset, columns.get("BRICKNAME")!);
    if (!/^\d{4}[pm]\d{3}$/.test(unitId)) continue;
    if (includedUnitIds && !includedUnitIds.has(unitId)) continue;
    const ra = numericValue(buffer, rowOffset, columns.get("RA")!);
    const dec = numericValue(buffer, rowOffset, columns.get("DEC")!);
    let ra1 = numericValue(buffer, rowOffset, columns.get("RA1")!);
    let ra2 = numericValue(buffer, rowOffset, columns.get("RA2")!);
    const dec1 = numericValue(buffer, rowOffset, columns.get("DEC1")!);
    const dec2 = numericValue(buffer, rowOffset, columns.get("DEC2")!);
    if (ra1 > ra2) ra2 += 360;
    const corners: Array<[number, number]> = [[ra1, dec1], [ra2, dec1], [ra2, dec2], [ra1, dec2]];
    const footprint = corners.map(([lon, lat]): [number, number] => [((lon % 360) + 360) % 360, lat]);
    const radiusDeg = Math.max(...footprint.map((vertex) => angularDistanceDeg([ra, dec], vertex)));
    units.push({
      unitId,
      unitKind: "brick",
      raDeg: ra,
      decDeg: dec,
      radiusDeg,
      footprint,
      downloadUrl: "https://www.legacysurvey.org/dr10/files/",
      accessAvailability: "unverified",
      geometryPrecision: "estimated",
      sourceSnapshotSha256,
      note: "Official Legacy all-sky brick identity and RA/Dec boundaries. Release membership and product access are resolved separately from a release roster.",
    });
  }
  return units;
}

interface LegacyRosterMember {
  raDeg: number;
  decDeg: number;
  availableBands: string[];
  bounds?: [number, number, number, number];
}

interface LegacyReleaseRoster {
  rowCount: number;
  members: Map<string, LegacyRosterMember>;
}

function parseLegacyReleaseRoster(bytes: Buffer, sourceName: string): LegacyReleaseRoster {
  const buffer = gunzipSync(bytes);
  const table = binaryTable(buffer);
  const columns = new Map(table.columns.map((column) => [column.name.toUpperCase(), column]));
  const required = ["BRICKNAME", "RA", "DEC", "NEXP_G", "NEXP_R", "NEXP_Z"];
  required.forEach((name) => { if (!columns.has(name)) throw new Error(`${sourceName} brick roster is missing ${name}`); });
  if (sourceName.startsWith("legacy-dr10") && !columns.has("NEXP_I")) throw new Error(`${sourceName} brick roster is missing NEXP_I`);
  const boundNames = ["RA1", "RA2", "DEC1", "DEC2"];
  const hasAnyBounds = boundNames.some((name) => columns.has(name));
  if (hasAnyBounds && boundNames.some((name) => !columns.has(name))) throw new Error(`${sourceName} brick roster has an incomplete bounds set`);
  const members = new Map<string, LegacyRosterMember>();
  for (let row = 0; row < table.rowCount; row += 1) {
    const rowOffset = table.dataOffset + row * table.rowLength;
    const unitId = stringValue(buffer, rowOffset, columns.get("BRICKNAME")!);
    if (!/^\d{4}[pm]\d{3}$/.test(unitId)) continue;
    if (members.has(unitId)) throw new Error(`${sourceName} brick roster has duplicate BRICKNAME ${unitId}`);
    const raDeg = numericValue(buffer, rowOffset, columns.get("RA")!);
    const decDeg = numericValue(buffer, rowOffset, columns.get("DEC")!);
    if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg) || raDeg < 0 || raDeg >= 360 || decDeg < -90 || decDeg > 90) {
      throw new Error(`${sourceName} brick roster has invalid coordinates for ${unitId}`);
    }
    const exposures: Partial<Record<"g" | "r" | "i" | "z", number>> = {};
    for (const band of ["g", "r", "i", "z"] as const) {
      const column = columns.get(`NEXP_${band.toUpperCase()}`);
      if (column) exposures[band] = numericValue(buffer, rowOffset, column);
    }
    const availableBands = legacyAvailableBands(exposures);
    const bounds = hasAnyBounds
      ? boundNames.map((name) => numericValue(buffer, rowOffset, columns.get(name)!)) as [number, number, number, number]
      : undefined;
    members.set(unitId, { raDeg, decDeg, availableBands, ...(bounds ? { bounds } : {}) });
  }
  return { rowCount: table.rowCount, members };
}

export function legacyAvailableBands(exposures: Partial<Record<"g" | "r" | "i" | "z", number>>): string[] {
  return (["g", "r", "i", "z"] as const).filter((band) => Number(exposures[band]) > 0);
}

export function legacyReleaseBrickAccessUris(
  releaseId: string,
  region: string,
  unitId: string,
  productPath: "coadd" | "tractor",
  bands: string[],
): SourceUnitAccessUri[] {
  const releaseNumber = /^legacy-dr(\d+)$/.exec(releaseId)?.[1];
  if (!releaseNumber) return [];
  const regionPath = region === "all" ? "" : `/${region}`;
  const root = `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr${releaseNumber}${regionPath}`;
  const prefix = unitId.slice(0, 3);
  if (productPath === "tractor") {
    const fileName = `tractor-${unitId}.fits`;
    return [{ fileName, url: `${root}/tractor/${prefix}/${fileName}` }];
  }
  const suffix = Number(releaseNumber) >= 5 ? ".fits.fz" : ".fits";
  return bands.map((band) => {
    const fileName = `legacysurvey-${unitId}-image-${band}${suffix}`;
    return { fileName, url: `${root}/coadd/${prefix}/${unitId}/${fileName}` };
  });
}

export class SourceUnitStore {
  readonly #layers = new Map<string, SourceUnitLayerIndex>();
  readonly #identityLayers = new Map<string, SourceUnitLayerIndex>();
  readonly #coverageLayers: SourceUnitCoverageLayer[] = [];
  readonly #spatialMatchCache = new Map<string, Map<string, number[] | null>>();
  #diskIndex?: SourceUnitDiskIndex;
  #cacheState: "hit" | "built" | "memory-only" = "memory-only";
  #cacheable = true;

  static async load(root: string, evidenceRoot = path.join(root, "artifacts/public-survey-footprints/raw"), options: SourceUnitLoadOptions = {}): Promise<SourceUnitStore> {
    const store = new SourceUnitStore();
    const registryPath = path.join(root, "src/layers/layer-registry.json");
    const lockPath = path.join(root, "src/layers/recipes/source-unit-indexes.lock.json");
    const [registryBytes, lockBytes] = await Promise.all([readFile(registryPath), readFile(lockPath)]);
    const registryText = registryBytes.toString("utf8");
    const lockText = options.lockText ?? lockBytes.toString("utf8");
    const registry = JSON.parse(registryText) as { layers?: Array<{ layerId: string; surveyId: string; releaseId: string; product?: string; status?: string; recipePath?: string }> };
    const lock = JSON.parse(lockText) as {
      euclidQ1?: { status?: string; snapshot?: SourceSnapshotLock };
      hscPdr2?: { releaseId: string; snapshotKey: string; dasSearchUrl: string; sourceFiles: Array<SourceSnapshotLock & { region: string }> };
      hscPdr3?: { releaseId: string; snapshotKey: string; dasSearchUrl: string; sourceFiles: Array<SourceSnapshotLock & { region: string }> };
      legacyDr1?: { status?: string; snapshot: SourceSnapshotLock };
      legacyDr2?: { status?: string; snapshot: SourceSnapshotLock };
      legacyDr10?: { snapshot: SourceSnapshotLock };
      legacyReleaseRosters?: {
        status?: string;
        scope?: string;
        releases?: Record<string, {
          status?: string;
          scope?: string;
          regions?: Array<{ id: string; snapshot: SourceSnapshotLock; observedRows?: number }>;
        }>;
      };
      layerBindings?: SourceUnitLayerBinding[];
      };
    if (options.sourceScope) {
      const scope = options.sourceScope;
      registry.layers = registry.layers?.filter(layer => layer.surveyId === scope.surveyId && layer.releaseId === scope.releaseId);
      const keep = (surveyId: string, releaseId: string) => scope.surveyId === surveyId && scope.releaseId === releaseId;
      if (!keep("euclid", "euclid-q1")) delete lock.euclidQ1;
      if (!keep("hsc-ssp", "hsc-pdr2")) delete lock.hscPdr2;
      if (!keep("hsc-ssp", "hsc-pdr3")) delete lock.hscPdr3;
      if (!keep("legacy-surveys", "legacy-dr1")) delete lock.legacyDr1;
      if (!keep("legacy-surveys", "legacy-dr2")) delete lock.legacyDr2;
      if (scope.surveyId !== "legacy-surveys" || ["legacy-dr1", "legacy-dr2"].includes(scope.releaseId)) delete lock.legacyDr10;
      if (lock.legacyReleaseRosters?.releases) lock.legacyReleaseRosters.releases = Object.fromEntries(Object.entries(lock.legacyReleaseRosters.releases).filter(([releaseId]) => keep("legacy-surveys", releaseId)));
      lock.layerBindings = lock.layerBindings?.filter(binding => keep(binding.surveyId, binding.releaseId));
    }
    const buildKey = options.buildKey ?? await sourceUnitDiskCacheKey(root, registryText, options.sourceScope ? JSON.stringify(lock) : lockText, registry, options.recipes);
    const diskPath = options.indexPath ?? path.join(evidenceRoot, "derived", "source-unit-indexes", "native-units.sqlite");
    const cachedIndex = await SourceUnitDiskIndex.open(diskPath, buildKey);
    if (cachedIndex) {
      store.#diskIndex = cachedIndex;
      store.#cacheState = "hit";
      return store;
    }

    if (options.readOnly) throw new Error("The approved source-unit index is unavailable or incompatible; create a managed build before activation");

    const desiRecipes = (registry.layers ?? []).filter((layer): layer is typeof layer & { recipePath: string } => layer.surveyId === "desi" && Boolean(layer.recipePath));
    for (const layer of desiRecipes) {
      try {
        const recipe = JSON.parse(options.recipes?.[layer.recipePath] ?? await readFile(path.join(root, layer.recipePath), "utf8")) as { input?: unknown; mode?: unknown };
        if (recipe.mode !== "tile-table" || typeof recipe.input !== "string") continue;
        store.#layers.set(layer.layerId, await buildDesiLayer(root, evidenceRoot, layer, options.recipes?.[layer.recipePath]));
      } catch {
        store.#cacheable = false;
        continue;
      }
    }

    if (lock.euclidQ1?.status === "ready" && lock.euclidQ1.snapshot) {
      try {
        const snapshot = await readLockedSnapshot(evidenceRoot, lock.euclidQ1.snapshot);
        const indexes = parseEuclidRows(snapshot.bytes.toString("utf8"), snapshot.sha256);
        const layerIds: Record<string, string> = {
          "nir-h": "euclid-euclid-q1-euclid-q1-nisp-h-moc",
          "nir-j": "euclid-euclid-q1-euclid-q1-nisp-j-moc",
          "nir-y": "euclid-euclid-q1-euclid-q1-nisp-y-moc",
          vis: "euclid-euclid-q1-euclid-q1-vis-moc",
          "des-color": "euclid-euclid-q1-euclid-q1-color-imaging-moc",
        };
        for (const [productKey, index] of indexes) {
          const layerId = layerIds[productKey];
          if (layerId && (registry.layers ?? []).some((layer) => layer.layerId === layerId)) {
            store.#layers.set(layerId, { ...index, layerId });
          }
        }
        const deepFieldsLayerId = "euclid-q1-deep-fields-image-extent";
        if ((registry.layers ?? []).some((layer) => layer.layerId === deepFieldsLayerId)) {
          const unitsByTile = new Map<string, SourceUnit>();
          for (const index of indexes.values()) {
            for (const unit of index.units) {
              const aggregate = unitsByTile.get(unit.unitId);
              if (!aggregate) {
                unitsByTile.set(unit.unitId, { ...unit, accessUris: [...(unit.accessUris ?? [])] });
                continue;
              }
              const urisByName = new Map((aggregate.accessUris ?? []).map((entry) => [entry.fileName ?? entry.url, entry]));
              for (const entry of unit.accessUris ?? []) urisByName.set(entry.fileName ?? entry.url, entry);
              aggregate.accessUris = [...urisByName.values()];
              if (unit.accessAvailability !== "public") aggregate.accessAvailability = "unverified";
            }
          }
          const notes = "Euclid Q1 deep-fields lookup returns the native ESA tile_index and all matching Q1 BGSUB product URIs in the locked 2,908-row snapshot. stc_s is product-footprint geometry; the result does not represent the complete Q1 inventory.";
          if (unitsByTile.size) store.#layers.set(deepFieldsLayerId, buildLayerIndex(deepFieldsLayerId, [...unitsByTile.values()], notes));
        }
      } catch {
        store.#cacheable = false;
        // An unavailable optional snapshot must not disable other survey indexes.
      }
    }

    for (const hscLock of [lock.hscPdr2, lock.hscPdr3]) {
      if (!hscLock) continue;
      const hscBindings = (lock.layerBindings ?? []).filter((binding) => binding.surveyId === "hsc-ssp"
        && binding.releaseId === hscLock.releaseId && binding.snapshotKey === hscLock.snapshotKey);
      const hscLayers = (registry.layers ?? []).filter((layer) => layer.surveyId === "hsc-ssp" && layer.releaseId === hscLock.releaseId);
      if (!hscBindings.length) continue;
      try {
        const patches = new Map<string, SourceUnit>();
        const snapshotReferences: string[] = [];
        for (const source of hscLock.sourceFiles) {
          const snapshot = await readLockedSnapshot(evidenceRoot, source);
          const parsed = parseHscPatchFile(snapshot.bytes.toString("utf8"), hscLock.releaseId, source.region, snapshot.sha256, hscLock.dasSearchUrl);
          if (!parsed.length) throw new Error(`HSC source has no parsed patches: ${source.path}`);
          snapshotReferences.push(`${source.path}:${snapshot.sha256}`);
          for (const unit of parsed) {
            const existing = patches.get(unit.unitId);
            if (existing) existing.note = `${existing.note}; ${source.region}`;
            else patches.set(unit.unitId, unit);
          }
        }
        if (patches.size && snapshotReferences.length === hscLock.sourceFiles.length) {
          const combinedSha = createHash("sha256").update(snapshotReferences.sort().join("\n")).digest("hex");
          const units = [...patches.values()].map((unit) => ({
            ...unit,
            downloadUrl: hscLock.dasSearchUrl,
            sourceSnapshotSha256: combinedSha,
          }));
          const notes = `HSC ${hscLock.releaseId.replace(/^hsc-/, "").toUpperCase()} official tract/patch geometry. The patch identity and footprint are known; file presence is filter-specific and access follows the HSC account policy.`;
          const shared = buildLayerIndex(`hsc-ssp:${hscLock.releaseId}`, units, notes);
          for (const layer of hscLayers) {
            store.#layers.set(layer.layerId, { ...shared, layerId: layer.layerId });
          }
          const order8Pixels = coveragePixels(units, 8);
          const order4Pixels = [...new Set(order8Pixels.map((pixel) => Math.floor(pixel / 4 ** 4)))].sort((left, right) => left - right);
          const cells = new Map([[4, order4Pixels], [8, order8Pixels]]);
          for (const binding of hscBindings) {
            const identity = sourceUnitIdentity(binding.surveyId, binding.releaseId, binding.product);
            store.#identityLayers.set(identity, buildLayerIndex(identity, units, binding.notes, shared));
            store.#coverageLayers.push({
              layerId: sourceUnitCoverageLayerId(binding),
              surveyId: binding.surveyId,
              releaseId: binding.releaseId,
              product: binding.product,
              modality: binding.modality ?? "imaging",
              unitKind: binding.unitKind,
              sourceSnapshotSha256: combinedSha,
              sourceUrls: hscLock.sourceFiles.map((source) => source.sourceUrl),
              accessUrl: hscLock.dasSearchUrl,
              notes: binding.notes,
              cells,
            });
          }
        }
      } catch (error) {
        store.#cacheable = false;
        console.warn(`Skipping incomplete HSC ${hscLock.releaseId} source-unit index: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const legacyDr1Bindings = (lock.layerBindings ?? []).filter((binding) => binding.snapshotKey === "legacyDr1" && binding.surveyId === "legacy-surveys" && binding.releaseId === "legacy-dr1");
    if (lock.legacyDr1?.status === "ready" && legacyDr1Bindings.length) {
      try {
        const snapshot = await readLockedSnapshot(evidenceRoot, lock.legacyDr1.snapshot);
        const { coaddUnits, tractorUnits } = parseLegacyDr1Bricks(snapshot.bytes, snapshot.sha256);
        if (!coaddUnits.length || !tractorUnits.length) throw new Error("Legacy DR1 brick source has no image-member or catalog-member bricks");
        for (const binding of legacyDr1Bindings) {
          const nativeUnits = binding.productPath === "coadd" ? coaddUnits : binding.productPath === "tractor" ? tractorUnits : undefined;
          if (!nativeUnits?.length) continue;
          const notes = binding.productPath === "tractor"
            ? `Official Legacy DR1 decals-bricks inventory (${nativeUnits.length} catalog-member bricks); has_catalog marks Tractor catalog membership. Candidate Tractor file URIs follow the documented path rule and have not been checked individually.`
            : `Official Legacy DR1 decals-bricks inventory (${nativeUnits.length} image-member bricks). Geometry and per-band membership flags are source-derived; candidate coadd file URIs follow the documented path rule and have not been checked individually.`;
          const shared = buildLayerIndex(`legacy-surveys:dr1:${binding.productPath}`, nativeUnits, notes);
          const identity = sourceUnitIdentity(binding.surveyId, binding.releaseId, binding.product);
          store.#identityLayers.set(identity, buildLayerIndex(identity, nativeUnits, binding.notes, shared));
          const cells = new Map([[4, [...shared.coarseByPixel.keys()].sort((left, right) => left - right)]]);
          store.#coverageLayers.push({
            layerId: sourceUnitCoverageLayerId(binding),
            surveyId: binding.surveyId,
            releaseId: binding.releaseId,
            product: binding.product,
            modality: binding.modality ?? "imaging",
            unitKind: binding.unitKind,
            sourceSnapshotSha256: snapshot.sha256,
            sourceUrls: [lock.legacyDr1.snapshot.sourceUrl],
            accessUrl: "https://www.legacysurvey.org/dr1/files/",
            notes: `${binding.notes} ${notes}`.trim(),
            coverageMethod: "unit-centers",
            cells,
          });
        }
      } catch (error) {
        store.#cacheable = false;
        console.warn(`Skipping incomplete Legacy DR1 source-unit index: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const legacyDr2Bindings = (lock.layerBindings ?? []).filter((binding) => binding.snapshotKey === "legacyDr2" && binding.surveyId === "legacy-surveys" && binding.releaseId === "legacy-dr2");
    if (lock.legacyDr2?.status === "ready" && legacyDr2Bindings.length) {
      try {
        const snapshot = await readLockedSnapshot(evidenceRoot, lock.legacyDr2.snapshot);
        const parsed = parseLegacyDr2Bricks(snapshot.bytes, snapshot.sha256);
        if (!parsed.tractorUnits.length) throw new Error("Legacy DR2 release roster contains no usable brick rows");
        for (const binding of legacyDr2Bindings) {
          const units = binding.productPath === "coadd" ? parsed.coaddUnits : binding.productPath === "tractor" ? parsed.tractorUnits : [];
          if (!units.length) continue;
          const notes = binding.productPath === "coadd"
            ? `Official Legacy DR2 release roster (${units.length} brick candidates with NOBS_MAX > 0 in at least one optical band). Coadd image URIs follow the official NOAO FTP path linked by the Legacy DR2 files page; the archive host could not be resolved here and per-file availability is unverified.`
            : `Official Legacy DR2 release roster (${units.length} brick rows). Brick identity and geometry come from the frozen roster. Tractor URI follows the documented DR2 path; only one example URI was checked, so individual file availability remains unverified.`;
          const shared = buildLayerIndex(`legacy-surveys:dr2:${binding.productPath}`, units, notes);
          const cells = new Map([[4, [...shared.coarseByPixel.keys()].sort((left, right) => left - right)] as const]);
          const identity = sourceUnitIdentity(binding.surveyId, binding.releaseId, binding.product);
          store.#identityLayers.set(identity, buildLayerIndex(identity, units, binding.notes, shared));
          store.#coverageLayers.push({
            layerId: sourceUnitCoverageLayerId(binding),
            surveyId: binding.surveyId,
            releaseId: binding.releaseId,
            product: binding.product,
            modality: binding.modality ?? "catalog",
            unitKind: binding.unitKind,
            sourceSnapshotSha256: snapshot.sha256,
            sourceUrls: [lock.legacyDr2.snapshot.sourceUrl],
            accessUrl: "https://www.legacysurvey.org/dr2/files/",
            notes: `${binding.notes} ${notes}`.trim(),
            coverageMethod: "unit-centers",
            cells: new Map(cells),
          });
        }
      } catch (error) {
        store.#cacheable = false;
        console.warn(`Skipping incomplete Legacy DR2 source-unit index: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const legacyReleaseBindings = (lock.layerBindings ?? []).filter((binding) => binding.snapshotKey === "legacyReleaseRosters"
      && binding.surveyId === "legacy-surveys");
    const bindingsByRelease = new Map<string, SourceUnitLayerBinding[]>();
    for (const binding of legacyReleaseBindings) {
      const bindings = bindingsByRelease.get(binding.releaseId) ?? [];
      bindings.push(binding);
      bindingsByRelease.set(binding.releaseId, bindings);
    }
    const parsedReleaseRosters = new Map<string, {
      scope: string;
      regions: Map<string, { lock: SourceSnapshotLock; roster: LegacyReleaseRoster }>;
      snapshotSha256: string;
      sourceUrls: string[];
    }>();
    for (const releaseId of bindingsByRelease.keys()) {
      const releaseLock = lock.legacyReleaseRosters?.releases?.[releaseId];
      if (!releaseLock || releaseLock.status !== "ready" || !releaseLock.regions?.length) continue;
      try {
        const regions = new Map<string, { lock: SourceSnapshotLock; roster: LegacyReleaseRoster }>();
        for (const regionLock of releaseLock.regions) {
          if (regions.has(regionLock.id)) throw new Error(`Duplicate Legacy ${releaseId} roster region ${regionLock.id}`);
          const snapshot = await readLockedSnapshot(evidenceRoot, regionLock.snapshot);
          const roster = parseLegacyReleaseRoster(snapshot.bytes, `${releaseId} ${regionLock.id}`);
          if (regionLock.observedRows !== undefined && regionLock.observedRows !== roster.rowCount) {
            throw new Error(`${releaseId} ${regionLock.id} row count differs from the locked observation`);
          }
          if (!roster.members.size) throw new Error(`${releaseId} ${regionLock.id} roster has no usable brick rows`);
          regions.set(regionLock.id, { lock: regionLock.snapshot, roster });
        }
        const references = [
          `${lock.legacyDr10?.snapshot.path ?? ""}:${lock.legacyDr10?.snapshot.sha256 ?? ""}`,
          ...[...regions.values()].map(({ lock: snapshotLock }) => `${snapshotLock.path}:${snapshotLock.sha256}`),
        ].sort();
        const sourceUrls = [
          ...(lock.legacyDr10?.snapshot.sourceUrl ? [lock.legacyDr10.snapshot.sourceUrl] : []),
          ...[...regions.values()].map(({ lock: snapshotLock }) => snapshotLock.sourceUrl),
        ];
        parsedReleaseRosters.set(releaseId, {
          scope: releaseLock.scope ?? "official release brick roster",
          regions,
          snapshotSha256: createHash("sha256").update(references.join("\n")).digest("hex"),
          sourceUrls,
        });
      } catch (error) {
        store.#cacheable = false;
        console.warn(`Skipping incomplete Legacy ${releaseId} source-unit roster: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (parsedReleaseRosters.size && lock.legacyDr10?.snapshot) {
      try {
        const geometrySnapshot = await readLockedSnapshot(evidenceRoot, lock.legacyDr10.snapshot);
        const candidateIds = new Set<string>();
        for (const release of parsedReleaseRosters.values()) {
          for (const { roster } of release.regions.values()) {
            for (const unitId of roster.members.keys()) candidateIds.add(unitId);
          }
        }
        const geometryUnits = parseLegacyBricks(geometrySnapshot.bytes, geometrySnapshot.sha256, candidateIds);
        candidateIds.clear();
        const geometryIndexById = new Map(geometryUnits.map((unit, index) => [unit.unitId, index]));
        for (const [releaseId, release] of [...parsedReleaseRosters]) {
          let invalid: string | undefined;
          for (const [region, { roster }] of release.regions) {
            for (const [unitId, member] of roster.members) {
              const geometryIndex = geometryIndexById.get(unitId);
              const geometry = geometryIndex === undefined ? undefined : geometryUnits[geometryIndex];
              if (!geometry) { invalid = `${region} brick ${unitId} is absent from the locked all-sky grid`; break; }
              if (Math.abs(geometry.raDeg - member.raDeg) > 1e-7 || Math.abs(geometry.decDeg - member.decDeg) > 1e-7) {
                invalid = `${region} brick ${unitId} center differs from the locked all-sky grid`;
                break;
              }
              if (member.bounds) {
                let [ra1, ra2, dec1, dec2] = member.bounds;
                if (ra1 > ra2) ra2 += 360;
                const expected = [[ra1, dec1], [ra2, dec1], [ra2, dec2], [ra1, dec2]]
                  .map(([ra, dec]): [number, number] => [((ra! % 360) + 360) % 360, dec!]);
                if (expected.some(([ra, dec], index) => Math.abs(ra - geometry.footprint![index]![0]) > 1e-7
                  || Math.abs(dec - geometry.footprint![index]![1]) > 1e-7)) {
                  invalid = `${region} brick ${unitId} bounds differ from the locked all-sky grid`;
                  break;
                }
              }
            }
            if (invalid) break;
          }
          if (invalid) {
            parsedReleaseRosters.delete(releaseId);
            console.warn(`Skipping inconsistent Legacy ${releaseId} source-unit roster: ${invalid}`);
          }
        }
        if (parsedReleaseRosters.size) {
          const sharedUnits = geometryUnits;
          const shared = buildLayerIndex("legacy-surveys:dr3-dr9", sharedUnits,
            "Official Legacy release rosters joined to the locked all-sky brick grid; each release keeps its own member scope and access paths.");
          const coarseHealpix = new Healpix(2 ** shared.coarseOrder);
          for (const [releaseId, release] of parsedReleaseRosters) {
            const bindings = bindingsByRelease.get(releaseId) ?? [];
            for (const binding of bindings) {
              const productPath = binding.productPath ?? "coadd";
              const productMembership = new Uint8Array(sharedUnits.length);
              for (const { roster } of release.regions.values()) {
                for (const [unitId, member] of roster.members) {
                  if (productPath === "coadd" && member.availableBands.length === 0) continue;
                  const unitIndex = geometryIndexById.get(unitId);
                  if (unitIndex !== undefined) productMembership[unitIndex] = 1;
                }
              }
              const accessUrisForUnit = (unitId: string): SourceUnitAccessUri[] => {
                const accessUris: SourceUnitAccessUri[] = [];
                for (const [region, { roster }] of release.regions) {
                  const member = roster.members.get(unitId);
                  if (member) accessUris.push(...legacyReleaseBrickAccessUris(releaseId, region, unitId, productPath, member.availableBands));
                }
                return accessUris;
              };
              const identity = sourceUnitIdentity(binding.surveyId, binding.releaseId, binding.product);
              const index = buildLayerIndex(identity, sharedUnits, binding.notes, shared);
              index.unitFilter = (unitIndex) => productMembership[unitIndex] === 1;
              index.accessUrisForUnit = accessUrisForUnit;
              index.sourceSnapshotSha256 = release.snapshotSha256;
              index.diskPayloadKind = "legacy-release-roster";
              index.diskPayloadContext = { releaseId, productPath };
              index.diskMembershipForUnit = (unitId) => ({
                regions: [...release.regions].flatMap(([id, { roster }]) => {
                  const member = roster.members.get(unitId);
                  return member ? [{ id, availableBands: member.availableBands }] : [];
                }),
              });
              store.#identityLayers.set(identity, index);
              if (releaseId === "legacy-dr5" && productPath === "coadd") {
                const decalsIdentity = sourceUnitIdentity("decals", "decals-dr5", "DR5 g/r/z color footprint");
                store.#identityLayers.set(decalsIdentity, {
                  ...index,
                  layerId: decalsIdentity,
                  notes: `${index.notes} This DECaLS DR5 mapping uses the official Legacy Surveys DR5 mixed-program coadd roster; it does not isolate DECaLS-only exposures.`,
                });
              }

              const cells = new Set<number>();
              for (let unitIndex = 0; unitIndex < sharedUnits.length; unitIndex += 1) {
                if (productMembership[unitIndex] !== 1) continue;
                const unit = sharedUnits[unitIndex]!;
                cells.add(coarseHealpix.ang2pix(new Pointing(null, false, (90 - unit.decDeg) * Math.PI / 180, unit.raDeg * Math.PI / 180)));
              }
              const unitCount = productMembership.reduce((count, member) => count + member, 0);
              const productNotes = `${releaseId.toUpperCase()} ${release.scope}: ${unitCount} ${productPath === "tractor" ? "Tractor" : "Coadd"} brick candidates. Coadd membership is selected from positive per-band NEXP roster summaries${releaseId === "legacy-dr10" ? " for g/r/i/z" : " for g/r/z"}; Tractor candidates use listed release bricks. Geometry comes from the locked all-sky brick grid and was checked against roster centers${release.regions.size && [...release.regions.keys()].some((region) => region !== "all") ? "; North/South memberships retain their region-specific URI prefixes" : ""}. URI rules are documented by the release; individual candidate files remain unverified.`;
              if (binding.product !== "DR10 color imaging") store.#coverageLayers.push({
                layerId: sourceUnitCoverageLayerId(binding),
                surveyId: binding.surveyId,
                releaseId: binding.releaseId,
                product: binding.product,
                modality: binding.modality ?? (productPath === "tractor" ? "catalog" : "imaging"),
                unitKind: binding.unitKind,
                sourceSnapshotSha256: release.snapshotSha256,
                sourceUrls: release.sourceUrls,
                accessUrl: `https://www.legacysurvey.org/${releaseId.replace("legacy-", "")}/files/`,
                notes: `${binding.notes} ${productNotes}`.trim(),
                coverageMethod: "unit-centers",
                cells: new Map([[shared.coarseOrder, [...cells].sort((left, right) => left - right)]]),
              });
            }
          }
        }
        geometryIndexById.clear();
      } catch (error) {
        store.#cacheable = false;
        console.warn(`Skipping Legacy DR3-DR9 source-unit indexes: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (store.#cacheable && (store.#layers.size || store.#identityLayers.size)) {
      try {
        store.#diskIndex = await SourceUnitDiskIndex.create(
          diskPath,
          buildKey,
          store.#diskLayerInputs(),
          store.#coverageLayers,
        );
        store.#cacheState = "built";
        store.#layers.clear();
        store.#identityLayers.clear();
        store.#coverageLayers.length = 0;
      } catch (error) {
        console.warn(`Source-unit SQLite cache unavailable; using in-memory index: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return store;
  }

  #diskLayerInputs(): SourceUnitDiskLayerInput[] {
    const aliasesByLayer = new Map<SourceUnitLayerIndex, Set<string>>();
    const addAlias = (layer: SourceUnitLayerIndex, alias: string): void => {
      let aliases = aliasesByLayer.get(layer);
      if (!aliases) {
        aliases = new Set();
        aliasesByLayer.set(layer, aliases);
      }
      aliases.add(sourceUnitDiskAlias(alias));
    };
    this.#layers.forEach((layer, alias) => addAlias(layer, alias));
    this.#identityLayers.forEach((layer, alias) => addAlias(layer, alias));

    const geometryKeyByUnits = new Map<SourceUnit[], string>();
    let nextGeometryKey = 1;
    return [...aliasesByLayer].map(([layer, aliases]) => {
      let geometryKey = geometryKeyByUnits.get(layer.units);
      if (!geometryKey) {
        geometryKey = `geometry-${nextGeometryKey++}`;
        geometryKeyByUnits.set(layer.units, geometryKey);
      }
      return {
        key: sourceUnitDiskAlias(layer.layerId),
        geometryKey,
        ...(layer.diskPayloadKind ? { payloadKind: layer.diskPayloadKind } : {}),
        ...(layer.diskPayloadContext ? { payloadContext: layer.diskPayloadContext } : {}),
        aliases: [...aliases],
        layerId: sourceUnitDiskAlias(layer.layerId),
        coarseOrder: layer.coarseOrder,
        maxUnitRadiusDeg: layer.maxUnitRadiusDeg,
        unitKind: layer.unitKind,
        notes: layer.notes,
        ...(layer.sourceSnapshotSha256 ? { sourceSnapshotSha256: layer.sourceSnapshotSha256 } : {}),
        units: (function* () {
          const healpix = new Healpix(2 ** layer.coarseOrder);
          for (let unitIndex = 0; unitIndex < layer.units.length; unitIndex += 1) {
          if (layer.unitFilter && !layer.unitFilter(unitIndex)) continue;
          const sourceUnit = layer.units[unitIndex]!;
          const membershipPayload = layer.diskMembershipForUnit?.(sourceUnit.unitId);
          const accessUris = layer.diskMembershipForUnit ? undefined : layer.accessUrisForUnit?.(sourceUnit.unitId);
          if (layer.accessUrisForUnit && !layer.diskMembershipForUnit && !accessUris?.length) continue;
            const downloadUrl = accessUris?.[0]?.url ?? layer.downloadUrlForUnit?.(sourceUnit.unitId) ?? sourceUnit.downloadUrl;
            const unit: SourceUnit = {
              ...sourceUnit,
              ...(layer.sourceSnapshotSha256 ? { sourceSnapshotSha256: layer.sourceSnapshotSha256 } : {}),
              ...(accessUris ? { accessUris } : {}),
              downloadUrl,
          };
          const coarsePixel = healpix.ang2pix(new Pointing(null, false, (90 - unit.decDeg) * Math.PI / 180, unit.raDeg * Math.PI / 180));
          yield { coarsePixel, unit, ...(membershipPayload === undefined ? {} : { membershipPayload }) };
        }
      })(),
      };
    });
  }

  coverageLayers(): SourceUnitCoverageLayer[] {
    const layers = this.#diskIndex?.coverageLayers() ?? this.#coverageLayers;
    return layers.map((layer) => ({ ...layer, cells: new Map(layer.cells) }));
  }

  match(layerId: string, order: number, cells: number[], limit = 120, identity?: Pick<SourceUnitLayerDescriptor, "surveyId" | "releaseId" | "product">): SourceUnitMatch | null {
    const memoryLayer = this.#layers.get(layerId)
      ?? (identity ? this.#identityLayers.get(sourceUnitIdentity(identity.surveyId, identity.releaseId, identity.product)) : undefined);
    const diskLayer = this.#diskIndex?.layer(sourceUnitDiskAlias(layerId))
      ?? (identity ? this.#diskIndex?.layer(sourceUnitDiskAlias(sourceUnitIdentity(identity.surveyId, identity.releaseId, identity.product))) : null);
    const layer = memoryLayer ?? diskLayer;
    if (!layer || order < 0 || order > 13) return null;
    const unitIndexes = new Set<number>();
    const candidatePixels = new Set<number>();
    const requestedCells = [...new Set(cells)].sort((left, right) => left - right);
    const coarseHealpix = new Healpix(2 ** layer.coarseOrder);
    const parentPixels = new Set<number>();
    requestedCells.forEach((pixel) => {
      if (order < layer.coarseOrder) {
        const childCount = 4 ** (layer.coarseOrder - order);
        for (let child = 0; child < childCount; child += 1) parentPixels.add(pixel * childCount + child);
      } else {
        parentPixels.add(Math.floor(pixel / 4 ** (order - layer.coarseOrder)));
      }
    });
    const candidateRadius = (layer.maxUnitRadiusDeg * Math.PI / 180) + coarseHealpix.maxPixrad();
    for (const parentPixel of parentPixels) {
      const parentCenter = coarseHealpix.pix2ang(parentPixel);
      const ranges = coarseHealpix.queryDiscInclusive(parentCenter, candidateRadius, 8) as unknown as { r: Int32Array; sz: number };
      for (let range = 0; range < ranges.sz; range += 2) {
        for (let pixel = ranges.r[range]!; pixel < ranges.r[range + 1]!; pixel += 1) {
          if (diskLayer) candidatePixels.add(pixel);
          else memoryLayer!.coarseByPixel.get(pixel)?.forEach((index) => unitIndexes.add(index));
        }
      }
    }
    const selected = new Set(requestedCells);
    const exactHealpix = new Healpix(2 ** order);
    const queryKey = `${order}:${requestedCells.join(",")}`;
    let geometryMatches = this.#spatialMatchCache.get(queryKey);
    if (geometryMatches) {
      this.#spatialMatchCache.delete(queryKey);
      this.#spatialMatchCache.set(queryKey, geometryMatches);
    } else {
      geometryMatches = new Map();
      this.#spatialMatchCache.set(queryKey, geometryMatches);
      if (this.#spatialMatchCache.size > MAX_MATCH_CACHE_REGIONS) {
        this.#spatialMatchCache.delete(this.#spatialMatchCache.keys().next().value!);
      }
    }
    const candidates: Iterable<{ unit: SourceUnit; index?: number; membershipPayload?: unknown }> = diskLayer
      ? this.#diskIndex!.units(diskLayer.key, candidatePixels)
      : [...unitIndexes].map((index) => ({ unit: memoryLayer!.units[index]!, index }));
    const allUnits: MatchedSourceUnit[] = [];
    for (const candidate of candidates) {
      const sourceUnit = candidate.unit;
      if (memoryLayer?.unitFilter) {
        if (candidate.index === undefined || !memoryLayer.unitFilter(candidate.index)) continue;
      }
      const geometryKey = unitGeometryKey(sourceUnit);
      let matchedPixels = geometryMatches.get(geometryKey);
      if (matchedPixels === undefined) {
        const matches = unitPixels(exactHealpix, sourceUnit).filter((pixel) => selected.has(pixel));
        matchedPixels = matches.length ? matches : null;
        if (geometryMatches.size < MAX_MATCH_CACHE_GEOMETRIES) geometryMatches.set(geometryKey, matchedPixels);
      }
      if (!matchedPixels?.length) continue;
      const matchingCells = [...matchedPixels];
      let diskAccessUris: SourceUnitAccessUri[] | undefined;
      if (diskLayer?.payloadKind === "legacy-release-roster") {
        const context = diskLayer.payloadContext;
        const releaseId = typeof context?.releaseId === "string" ? context.releaseId : undefined;
        const productPath = context?.productPath === "tractor" ? "tractor" : context?.productPath === "coadd" ? "coadd" : undefined;
        const membership = candidate.membershipPayload as { regions?: Array<{ id: string; availableBands: string[] }> } | undefined;
        if (releaseId && productPath && membership?.regions) {
          diskAccessUris = membership.regions.flatMap(({ id, availableBands }) =>
            legacyReleaseBrickAccessUris(releaseId, id, sourceUnit.unitId, productPath, availableBands));
        }
      }
      const accessUris = memoryLayer?.accessUrisForUnit?.(sourceUnit.unitId) ?? diskAccessUris ?? sourceUnit.accessUris;
      if (memoryLayer?.accessUrisForUnit && !accessUris?.length) continue;
      if (diskLayer?.payloadKind === "legacy-release-roster" && !accessUris?.length) continue;
      const downloadUrl = accessUris?.[0]?.url ?? memoryLayer?.downloadUrlForUnit?.(sourceUnit.unitId) ?? sourceUnit.downloadUrl;
      allUnits.push({
        ...sourceUnit,
        ...((memoryLayer?.sourceSnapshotSha256 ?? diskLayer?.sourceSnapshotSha256) ? { sourceSnapshotSha256: memoryLayer?.sourceSnapshotSha256 ?? diskLayer?.sourceSnapshotSha256 } : {}),
        ...(accessUris ? { accessUris } : {}),
        ...(downloadUrl ? { downloadUrl } : {}),
        matchingCells,
      });
    }
    allUnits.sort((left, right) => left.unitId.localeCompare(right.unitId, undefined, { numeric: true }));
    return { status: "exact", precision: "estimated", unitKind: layer.unitKind, units: allUnits.slice(0, limit), totalUnits: allUnits.length, truncated: allUnits.length > limit, notes: layer.notes };
  }

  get cacheState(): "hit" | "built" | "memory-only" { return this.#cacheState; }
  get diskBacked(): boolean { return Boolean(this.#diskIndex); }
  close(): void { this.#diskIndex?.close(); }
}

interface WorkerRequest { id: number; layerId: string; order: number; cells: number[]; limit?: number; identity?: Pick<SourceUnitLayerDescriptor, "surveyId" | "releaseId" | "product">; }
interface WorkerResponse { type: "ready" | "result" | "fatal"; id?: number; result?: SourceUnitMatch | null; coverageLayers?: SourceUnitCoverageLayer[]; error?: string; }

export class SourceUnitWorkerStore {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (value: SourceUnitMatch | null) => void; reject: (error: Error) => void }>();
  #coverageLayers: SourceUnitCoverageLayer[] = [];
  #nextId = 1;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on("message", (message: WorkerResponse) => {
      if (message.type !== "result" || message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result ?? null);
    });
    worker.on("error", (error) => this.#rejectAll(error));
    worker.on("exit", (code) => { if (code !== 0) this.#rejectAll(new Error(`Source-unit worker exited with code ${code}`)); });
  }

  static async load(root: string, evidenceRoot = path.join(root, "artifacts/public-survey-footprints/raw"), options: SourceUnitLoadOptions = {}): Promise<SourceUnitWorkerStore> {
    const source = new URL(import.meta.url);
    if (options.readOnly) return this.#openWorker(source, root, evidenceRoot, options);
    const cacheWorker = new Worker(source, { workerData: { kind: "source-unit-cache-builder", root, evidenceRoot, options } });
    const beforeBuildRss = process.memoryUsage().rss;
    let peakBuildRss = beforeBuildRss;
    const sampler = setInterval(() => { peakBuildRss = Math.max(peakBuildRss, process.memoryUsage().rss); }, 100);
    let cacheState: string;
    try {
      cacheState = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          cacheWorker.off("message", onMessage);
          cacheWorker.off("error", onError);
          cacheWorker.off("exit", onExit);
        };
        const onMessage = (message: { type: string; diskBacked?: boolean; cacheState?: string; error?: string }): void => {
          if (message.type === "prepared" && message.diskBacked) {
            settled = true;
            cleanup();
            resolve(message.cacheState ?? "ready");
          } else if (message.type === "fatal" || message.type === "prepared") {
            settled = true;
            cleanup();
            reject(new Error(message.error ?? "Source-unit disk index could not be prepared"));
          }
        };
        const onError = (error: Error): void => {
          if (!settled) { settled = true; cleanup(); reject(error); }
        };
        const onExit = (code: number): void => {
          if (!settled) { settled = true; cleanup(); reject(new Error(`Source-unit cache builder exited with code ${code}`)); }
        };
        cacheWorker.on("message", onMessage);
        cacheWorker.on("error", onError);
        cacheWorker.on("exit", onExit);
      });
    } finally {
      clearInterval(sampler);
      await cacheWorker.terminate().catch(() => undefined);
    }

    const diskPath = options.indexPath ?? path.join(evidenceRoot, "derived", "source-unit-indexes", "native-units.sqlite");
    const diskBytes = await stat(diskPath).then((value) => value.size).catch(() => 0);
    const builderPeakMiB = Math.round(peakBuildRss / (1024 * 1024));
    const readyMiB = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.info(`Source-unit SQLite cache ${cacheState}; ${diskBytes} bytes; RSS ${builderPeakMiB} MiB peak while building, ${readyMiB} MiB before query worker startup.`);

    return this.#openWorker(source, root, evidenceRoot, options);
  }

  static #openWorker(source: URL, root: string, evidenceRoot: string, options: SourceUnitLoadOptions): Promise<SourceUnitWorkerStore> {
    const worker = new Worker(source, { workerData: { kind: "source-unit-store", root, evidenceRoot, options } });
    const store = new SourceUnitWorkerStore(worker);
    return new Promise((resolve, reject) => {
      const onMessage = (message: WorkerResponse): void => {
        if (message.type === "ready") {
          store.#coverageLayers = message.coverageLayers ?? [];
          const queryWorkerMiB = Math.round(process.memoryUsage().rss / (1024 * 1024));
          console.info(`Source-unit query worker opened SQLite index; process RSS is ${queryWorkerMiB} MiB with ${store.#coverageLayers.length} coverage layers.`);
          cleanup();
          resolve(store);
        }
        else if (message.type === "fatal") { cleanup(); void worker.terminate(); reject(new Error(message.error ?? "Source-unit worker failed")); }
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const cleanup = (): void => { worker.off("message", onMessage); worker.off("error", onError); };
      worker.on("message", onMessage);
      worker.on("error", onError);
    });
  }

  match(layerId: string, order: number, cells: number[], limit = 120, identity?: Pick<SourceUnitLayerDescriptor, "surveyId" | "releaseId" | "product">): Promise<SourceUnitMatch | null> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, layerId, order, cells, limit, identity } satisfies WorkerRequest);
    });
  }

  coverageLayers(): SourceUnitCoverageLayer[] {
    return this.#coverageLayers.map((layer) => ({ ...layer, cells: new Map(layer.cells) }));
  }

  terminate(): Promise<number> { return this.#worker.terminate(); }

  #rejectAll(error: Error): void {
    this.#pending.forEach((pending) => pending.reject(error));
    this.#pending.clear();
  }
}

if (!isMainThread && workerData?.kind === "source-unit-cache-builder" && parentPort) {
  const workerPort = parentPort;
  void SourceUnitStore.load(String(workerData.root), String(workerData.evidenceRoot), workerData.options).then((store) => {
    const result = { type: "prepared", diskBacked: store.diskBacked, cacheState: store.cacheState };
    store.close();
    workerPort.postMessage(result);
    workerPort.close();
  }).catch((error) => {
    workerPort.postMessage({ type: "fatal", error: error instanceof Error ? error.message : String(error) });
    workerPort.close();
  });
}

if (!isMainThread && workerData?.kind === "source-unit-store" && parentPort) {
  const workerPort = parentPort;
  void SourceUnitStore.load(String(workerData.root), String(workerData.evidenceRoot), workerData.options).then((store) => {
    workerPort.postMessage({ type: "ready", coverageLayers: store.coverageLayers() } satisfies WorkerResponse);
    workerPort.on("message", (request: WorkerRequest) => {
      try {
        workerPort.postMessage({ type: "result", id: request.id, result: store.match(request.layerId, request.order, request.cells, request.limit, request.identity) } satisfies WorkerResponse);
      } catch (error) {
        workerPort.postMessage({ type: "result", id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
      }
    });
  }).catch((error) => workerPort.postMessage({ type: "fatal", error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse));
}
