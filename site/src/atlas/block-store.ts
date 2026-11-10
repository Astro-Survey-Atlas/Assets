/**
 * Persistent browser store for decoded coverage data.
 *
 * Every entry is addressed by the layer's content versions (`revision` and
 * `displayRevision`), so a stored value can never be served for different
 * geometry: a new release changes the key and the old entry is simply never
 * read again. Entries therefore need no expiry; `prune` only reclaims space
 * for versions the current catalog no longer references.
 *
 * Every failure (no IndexedDB, private mode, quota, blocked upgrade) degrades
 * to "not cached" and never reaches the caller.
 */

export interface RangeIndex { ranges: Array<{ start: number; end: number }>; totalTiles: number }

interface StoredBlock { key: string; layerId: string; version: string; cells: Uint32Array }
interface StoredIndex { key: string; layerId: string; version: string; starts: Uint32Array; ends: Uint32Array; totalTiles: number }

const DB_NAME = "asa-coverage-cache";
const DB_VERSION = 1;
const BLOCKS = "blocks";
const INDEXES = "tile-indexes";

export interface LayerVersion { layerId: string; revision?: string; displayRevision?: string }

/** The single version tag used for keys and pruning. Both versions participate. */
export function layerVersionTag(layer: Omit<LayerVersion, "layerId">): string {
  return `${layer.revision ?? ""}|${layer.displayRevision ?? ""}`;
}

export function blockStoreKey(layer: LayerVersion, order: number, tile: number): string {
  return `${layer.layerId}:${layerVersionTag(layer)}:${order}:${tile}`;
}

export function indexStoreKey(layer: LayerVersion, order: number): string {
  return `${layer.layerId}:${layerVersionTag(layer)}:${order}:index`;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class CoverageBlockStore {
  readonly #factory: IDBFactory | undefined;
  #db: Promise<IDBDatabase | null> | null = null;

  constructor(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB) {
    this.#factory = factory;
  }

  #open(): Promise<IDBDatabase | null> {
    if (this.#db) return this.#db;
    this.#db = new Promise<IDBDatabase | null>((resolve) => {
      if (!this.#factory) { resolve(null); return; }
      try {
        const request = this.#factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of [BLOCKS, INDEXES]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "key" }).createIndex("layerId", "layerId");
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.#db = null; };
          resolve(db);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return this.#db;
  }

  async getBlock(layer: LayerVersion, order: number, tile: number): Promise<number[] | null> {
    try {
      const db = await this.#open();
      if (!db) return null;
      const row = await promisify(db.transaction(BLOCKS, "readonly").objectStore(BLOCKS).get(blockStoreKey(layer, order, tile))) as StoredBlock | undefined;
      return row?.cells instanceof Uint32Array ? Array.from(row.cells) : null;
    } catch { return null; }
  }

  async putBlock(layer: LayerVersion, order: number, tile: number, cells: readonly number[]): Promise<void> {
    try {
      const db = await this.#open();
      if (!db) return;
      const transaction = db.transaction(BLOCKS, "readwrite");
      const row: StoredBlock = { key: blockStoreKey(layer, order, tile), layerId: layer.layerId, version: layerVersionTag(layer), cells: Uint32Array.from(cells) };
      transaction.objectStore(BLOCKS).put(row);
      await transactionDone(transaction);
    } catch { /* quota or private mode: simply not cached */ }
  }

  async getIndex(layer: LayerVersion, order: number): Promise<RangeIndex | null> {
    try {
      const db = await this.#open();
      if (!db) return null;
      const row = await promisify(db.transaction(INDEXES, "readonly").objectStore(INDEXES).get(indexStoreKey(layer, order))) as StoredIndex | undefined;
      if (!row || !(row.starts instanceof Uint32Array) || !(row.ends instanceof Uint32Array) || row.starts.length !== row.ends.length) return null;
      return { ranges: Array.from(row.starts, (start, index) => ({ start, end: row.ends[index]! })), totalTiles: row.totalTiles };
    } catch { return null; }
  }

  async putIndex(layer: LayerVersion, order: number, value: RangeIndex): Promise<void> {
    try {
      const db = await this.#open();
      if (!db) return;
      const transaction = db.transaction(INDEXES, "readwrite");
      const row: StoredIndex = {
        key: indexStoreKey(layer, order), layerId: layer.layerId, version: layerVersionTag(layer),
        starts: Uint32Array.from(value.ranges, (range) => range.start), ends: Uint32Array.from(value.ranges, (range) => range.end), totalTiles: value.totalTiles,
      };
      transaction.objectStore(INDEXES).put(row);
      await transactionDone(transaction);
    } catch { /* not cached */ }
  }

  /**
   * Drops entries whose layer is gone or whose versions differ from the current
   * catalog. Safe to run at any time: removed entries are only ones the current
   * catalog can no longer request.
   */
  async prune(current: readonly LayerVersion[]): Promise<number> {
    try {
      const db = await this.#open();
      if (!db) return 0;
      const live = new Map(current.map((layer) => [layer.layerId, layerVersionTag(layer)]));
      let removed = 0;
      for (const name of [BLOCKS, INDEXES]) {
        const transaction = db.transaction(name, "readwrite");
        const store = transaction.objectStore(name);
        await new Promise<void>((resolve, reject) => {
          const cursorRequest = store.openCursor();
          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) { resolve(); return; }
            const row = cursor.value as { layerId: string; version: string };
            if (live.get(row.layerId) !== row.version) { cursor.delete(); removed += 1; }
            cursor.continue();
          };
        });
        await transactionDone(transaction);
      }
      return removed;
    } catch { return 0; }
  }
}

export const coverageBlockStore = new CoverageBlockStore();
