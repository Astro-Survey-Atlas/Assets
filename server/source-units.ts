import { readFile } from "node:fs/promises";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { Healpix, Pointing } from "healpixjs";

export interface SourceUnit {
  unitId: string;
  unitKind: "tile";
  raDeg: number;
  decDeg: number;
  radiusDeg: number;
  exposureCount: number;
  lastNight: number;
  downloadUrl: string;
}

export interface SourceUnitMatch {
  status: "exact";
  unitKind: "tile";
  units: SourceUnit[];
  totalUnits: number;
  truncated: boolean;
  notes: string;
}

interface SourceUnitLayerIndex {
  layerId: string;
  /**
   * A coarse, NESTED parent-cell index bounds the exact work per request.
   * Keeping an order-8 reverse map for every DESI tile creates millions of
   * JavaScript Map/Array entries and exceeds the site's memory limit.
   */
  coarseOrder: number;
  coarseByPixel: Map<number, number[]>;
  units: SourceUnit[];
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

function binaryTable(buffer: Buffer, hduName: string): FitsTable {
  let offset = 0;
  while (offset < buffer.length) {
    const header = headerAt(buffer, offset);
    if (header.values.get("EXTNAME") === hduName) {
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

function numericValue(buffer: Buffer, rowOffset: number, column: FitsColumn): number {
  const offset = rowOffset + column.offset;
  const kind = /([A-Z])/.exec(column.format)?.[1];
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

async function buildDesiLayer(root: string, input: { layerId: string; releaseId: string; recipePath: string }): Promise<SourceUnitLayerIndex> {
  const recipe = JSON.parse(await readFile(path.join(root, input.recipePath), "utf8")) as { input: string; snapshot: { sha256: string }; recipe: { hdu: string; raColumn: string; decColumn: string; nexpColumn: string; nexpMin: number; radiusDeg: number } };
  const buffer = await readFile(path.join(root, recipe.input));
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
    });
  }
  const coarseOrder = 4;
  const coarseHealpix = new Healpix(2 ** coarseOrder);
  const coarseByPixel = new Map<number, number[]>();
  units.forEach((unit, unitIndex) => {
    const pointing = new Pointing(null, false, (90 - unit.decDeg) * Math.PI / 180, unit.raDeg * Math.PI / 180);
    rangePixels(coarseHealpix, pointing, unit.radiusDeg).forEach((pixel) => {
      const candidates = coarseByPixel.get(pixel);
      if (candidates) candidates.push(unitIndex);
      else coarseByPixel.set(pixel, [unitIndex]);
    });
  });
  return { layerId: input.layerId, coarseOrder, coarseByPixel, units };
}

export class SourceUnitStore {
  readonly #layers = new Map<string, SourceUnitLayerIndex>();

  static async load(root: string): Promise<SourceUnitStore> {
    const store = new SourceUnitStore();
    const registry = JSON.parse(await readFile(path.join(root, "src/layers/layer-registry.json"), "utf8")) as { layers?: Array<{ layerId: string; surveyId: string; releaseId: string; recipePath?: string }> };
    const desi = (registry.layers ?? []).filter((layer): layer is typeof layer & { recipePath: string } => layer.surveyId === "desi" && Boolean(layer.recipePath));
    for (const layer of desi) store.#layers.set(layer.layerId, await buildDesiLayer(root, layer));
    return store;
  }

  match(layerId: string, order: number, cells: number[], limit = 120): SourceUnitMatch | null {
    const layer = this.#layers.get(layerId);
    if (!layer || order < layer.coarseOrder) return null;
    const unitIndexes = new Set<number>();
    const parentScale = 2 ** (2 * (order - layer.coarseOrder));
    cells.forEach((pixel) => layer.coarseByPixel.get(Math.floor(pixel / parentScale))?.forEach((index) => unitIndexes.add(index)));

    // At order 4 the compact index is already the exact inclusive raster.
    // At a finer order, validate only its coarse candidates against the
    // requested cells using the same queryDiscInclusive rasterization.
    const selected = new Set(cells);
    const exactHealpix = order === layer.coarseOrder ? null : new Healpix(2 ** order);
    const allUnits = [...unitIndexes]
      .filter((index) => {
        if (!exactHealpix) return true;
        const unit = layer.units[index]!;
        const pointing = new Pointing(null, false, (90 - unit.decDeg) * Math.PI / 180, unit.raDeg * Math.PI / 180);
        return rangePixels(exactHealpix, pointing, unit.radiusDeg).some((pixel) => selected.has(pixel));
      })
      .map((index) => layer.units[index]!)
      .sort((left, right) => Number(left.unitId) - Number(right.unitId));
    return { status: "exact", unitKind: "tile", units: allUnits.slice(0, limit), totalUnits: allUnits.length, truncated: allUnits.length > limit, notes: "由生成 MOC 的同一份官方 TILE_COMPLETENESS 快照、NEXP 筛选和焦面半径与重合 HEALPix cells 求交；order-4 父像元只用于缩小候选集合。" };
  }
}

interface WorkerRequest { id: number; layerId: string; order: number; cells: number[]; limit?: number; }
interface WorkerResponse { type: "ready" | "result" | "fatal"; id?: number; result?: SourceUnitMatch | null; error?: string; }

export class SourceUnitWorkerStore {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (value: SourceUnitMatch | null) => void; reject: (error: Error) => void }>();
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

  static load(root: string): Promise<SourceUnitWorkerStore> {
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: "source-unit-store", root } });
    const store = new SourceUnitWorkerStore(worker);
    return new Promise((resolve, reject) => {
      const onMessage = (message: WorkerResponse): void => {
        if (message.type === "ready") { cleanup(); resolve(store); }
        else if (message.type === "fatal") { cleanup(); void worker.terminate(); reject(new Error(message.error ?? "Source-unit worker failed")); }
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const cleanup = (): void => { worker.off("message", onMessage); worker.off("error", onError); };
      worker.on("message", onMessage);
      worker.on("error", onError);
    });
  }

  match(layerId: string, order: number, cells: number[], limit = 120): Promise<SourceUnitMatch | null> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, layerId, order, cells, limit } satisfies WorkerRequest);
    });
  }

  terminate(): Promise<number> { return this.#worker.terminate(); }

  #rejectAll(error: Error): void {
    this.#pending.forEach((pending) => pending.reject(error));
    this.#pending.clear();
  }
}

if (!isMainThread && workerData?.kind === "source-unit-store" && parentPort) {
  const workerPort = parentPort;
  void SourceUnitStore.load(String(workerData.root)).then((store) => {
    workerPort.postMessage({ type: "ready" } satisfies WorkerResponse);
    workerPort.on("message", (request: WorkerRequest) => {
      try {
        workerPort.postMessage({ type: "result", id: request.id, result: store.match(request.layerId, request.order, request.cells, request.limit) } satisfies WorkerResponse);
      } catch (error) {
        workerPort.postMessage({ type: "result", id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
      }
    });
  }).catch((error) => workerPort.postMessage({ type: "fatal", error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse));
}
