import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Healpix } from "healpixjs";

import { candidateCellsForStcs, cellsForStcs } from "./hst-image-lookup.js";
import { hstSnapshotRows, loadHstSnapshot } from "./hst-snapshot.js";

const INDEX_SCHEMA_VERSION = "4";
const COARSE_ORDER = 4;
const MAX_LOOKUP_OBSERVATIONS = 6400;

export interface IndexedHstObservation {
  obsid: string;
  instrument?: string;
  filters?: string;
  target?: string;
  startTime?: number;
  endTime?: number;
  productUrl: string;
  sRegion: string;
  matchingCells: number[];
}

export interface HstObservationIndexSummary {
  sourceSnapshotSha256: string;
  rowCount: number;
  indexedRows: number;
  observationCount: number;
  excludedRows: number;
  duplicateRows: number;
  duplicateRecords: number;
  partialRefresh: boolean;
  baselineSnapshotSha256?: string;
  baselineCapturedAt?: string;
  supplementRows: number;
}

export interface HstObservationLookup {
  observations: IndexedHstObservation[];
  matchedObservationCount: number;
  truncated: boolean;
  queryExhausted: boolean;
  sourceSnapshotSha256: string;
  excludedRows: number;
  partialRefresh?: boolean;
  baselineSnapshotSha256?: string;
  baselineCapturedAt?: string;
  supplementRows?: number;
}

interface RawObservation extends Record<string, unknown> {
  obsid: string | number;
  s_region: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function text(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= maximumLength ? result : undefined;
}

function finite(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mastProductsUrl(obsid: string): string {
  const url = new URL("https://mast.stsci.edu/api/v0/invoke");
  url.searchParams.set("request", JSON.stringify({
    service: "Mast.Caom.Products",
    params: {
      obsid,
      columns: "obsID,obs_collection,dataproduct_type,obs_id,description,type,dataURI,productType,productGroupDescription,productSubGroupDescription,project,proposal_id,productFilename,size,parent_obsid,dataRights,calib_level,filters",
    },
    format: "json",
    pagesize: 5000,
    page: 1,
  }));
  return url.toString();
}

function isPublicHstImage(row: Record<string, unknown>): row is RawObservation {
  const obsid = String(row.obsid ?? "");
  return /^\d{1,32}$/.test(obsid) && Number.isSafeInteger(Number(obsid))
    && String(row.obs_collection ?? "").toUpperCase() === "HST"
    && String(row.dataproduct_type ?? "").toLowerCase() === "image"
    && String(row.dataRights ?? "").toUpperCase() === "PUBLIC"
    && typeof row.s_region === "string";
}

export class HstObservationIndex {
  readonly #db: DatabaseSync;
  readonly #selectCandidates: StatementSync;
  readonly #summary: HstObservationIndexSummary;

  private constructor(db: DatabaseSync, summary: HstObservationIndexSummary) {
    this.#db = db;
    this.#summary = summary;
    db.exec("PRAGMA cache_size=-8192; PRAGMA mmap_size=0;");
    db.exec("CREATE TEMP TABLE IF NOT EXISTS request_cells (cell INTEGER PRIMARY KEY) WITHOUT ROWID;");
    this.#selectCandidates = db.prepare(`
      SELECT observations.row_id AS rowId, observations.obsid, observations.instrument, observations.filters,
        observations.target, observations.start_time AS startTime,
        observations.end_time AS endTime, observations.s_region AS sRegion
      FROM hst_observation_cells AS cells
      INNER JOIN hst_observations AS observations ON observations.row_id = cells.row_id
      WHERE cells.coarse_cell IN (SELECT cell FROM request_cells)
        AND (? IS NULL OR observations.obsid = ?)
      ORDER BY observations.obsid, observations.row_id
    `);
  }

  static indexPath(evidenceRoot: string, sourceSnapshotSha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sourceSnapshotSha256)) throw new Error("Invalid HST source snapshot SHA-256");
    return path.join(evidenceRoot, "derived", "hst-observation-indexes", `${sourceSnapshotSha256}.v${INDEX_SCHEMA_VERSION}.sqlite`);
  }

  static async open(evidenceRoot: string, sourceSnapshotSha256: string): Promise<HstObservationIndex> {
    const filePath = this.indexPath(evidenceRoot, sourceSnapshotSha256);
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT key, value FROM hst_index_meta").all() as Array<{ key: string; value: string }>;
      const meta = new Map(rows.map(({ key, value }) => [key, value]));
      if (meta.get("schema_version") !== INDEX_SCHEMA_VERSION || meta.get("source_snapshot_sha256") !== sourceSnapshotSha256) {
        throw new Error("HST observation index does not match the locked source snapshot");
      }
      const summary: HstObservationIndexSummary = {
        sourceSnapshotSha256,
        rowCount: Number(meta.get("row_count")),
        indexedRows: Number(meta.get("indexed_rows")),
        observationCount: Number(meta.get("observation_count")),
        excludedRows: Number(meta.get("excluded_rows")),
        duplicateRows: Number(meta.get("duplicate_rows")),
        duplicateRecords: Number(meta.get("duplicate_records")),
        partialRefresh: meta.get("partial_refresh") === "true",
        ...(meta.get("baseline_snapshot_sha256") ? { baselineSnapshotSha256: meta.get("baseline_snapshot_sha256") } : {}),
        ...(meta.get("baseline_captured_at") ? { baselineCapturedAt: meta.get("baseline_captured_at") } : {}),
        supplementRows: Number(meta.get("supplement_rows") ?? 0),
      };
      if (Object.values(summary).some((value) => typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))) {
        throw new Error("HST observation index has invalid summary counts");
      }
      return new HstObservationIndex(db, summary);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  static async build(evidenceRoot: string, manifestRelativePath: string, sourceSnapshotSha256: string,
    baseline?: { evidenceRoot: string; sourceSnapshotSha256: string }): Promise<HstObservationIndex> {
    const manifest = await loadHstSnapshot(evidenceRoot, manifestRelativePath, sourceSnapshotSha256);
    const filePath = this.indexPath(evidenceRoot, sourceSnapshotSha256);
    const existing = await this.open(evidenceRoot, sourceSnapshotSha256).catch(() => undefined);
    if (existing) return existing;
    await mkdir(path.dirname(filePath), { recursive: true });
    const stagingPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let db: DatabaseSync | undefined;
    const coarseHealpix = new Healpix(2 ** COARSE_ORDER);
    let indexedRows = 0;
    let observationCount = 0;
    let excludedRows = 0;
    let duplicateRows = 0;
    let duplicateRecords = 0;
    let observedRows = 0;
    let processedPages = 0;
    try {
      let copiedBaseline = false;
      if (baseline && manifest.partialRefresh && manifest.baselineSnapshotSha256 === baseline.sourceSnapshotSha256) {
        const original = await this.open(baseline.evidenceRoot, baseline.sourceSnapshotSha256);
        const summary = original.summary;
        original.close();
        if (summary.rowCount !== manifest.batches[0]!.rowCount || summary.partialRefresh) throw new Error("HST installed baseline does not match the composite's original input");
        await copyFile(this.indexPath(baseline.evidenceRoot, baseline.sourceSnapshotSha256), stagingPath);
        indexedRows = summary.indexedRows; observationCount = summary.observationCount;
        excludedRows = summary.excludedRows; duplicateRows = summary.duplicateRows; duplicateRecords = summary.duplicateRecords;
        observedRows = summary.rowCount;
        copiedBaseline = true;
      }
      db = new DatabaseSync(stagingPath);
      db.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        PRAGMA cache_size=-16384;
      `);
      if (!copiedBaseline) db.exec(`
        CREATE TABLE hst_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE hst_observations (
          row_id INTEGER PRIMARY KEY,
          row_hash TEXT NOT NULL UNIQUE,
          obsid TEXT NOT NULL,
          instrument TEXT,
          filters TEXT,
          target TEXT,
          start_time REAL,
          end_time REAL,
          s_region TEXT NOT NULL
        );
        CREATE TABLE hst_observation_cells (
          coarse_cell INTEGER NOT NULL,
          row_id INTEGER NOT NULL,
          PRIMARY KEY(coarse_cell, row_id)
        ) WITHOUT ROWID;
        CREATE INDEX hst_observation_cells_by_row ON hst_observation_cells(row_id, coarse_cell);
        CREATE TABLE hst_observation_ids (obsid TEXT PRIMARY KEY) WITHOUT ROWID;
      `);
      db.exec("CREATE TEMP TABLE request_cells (cell INTEGER PRIMARY KEY) WITHOUT ROWID; BEGIN IMMEDIATE;");
      const insertObservation = db.prepare(`
        INSERT OR IGNORE INTO hst_observations(row_hash, obsid, instrument, filters, target, start_time, end_time, s_region)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertObservationId = db.prepare("INSERT OR IGNORE INTO hst_observation_ids(obsid) VALUES (?)");
      const insertCell = db.prepare("INSERT OR IGNORE INTO hst_observation_cells(coarse_cell, row_id) VALUES (?, ?)");
      const insertMeta = db.prepare("INSERT OR REPLACE INTO hst_index_meta(key, value) VALUES (?, ?)");
      const writePage = (pageRows: Record<string, unknown>[]): void => {
        for (const row of pageRows) {
          observedRows += 1;
          if (!isPublicHstImage(row)) { excludedRows += 1; continue; }
          const obsid = String(row.obsid);
          const sRegion = row.s_region.trim();
          const candidateCells = candidateCellsForStcs(COARSE_ORDER, sRegion, coarseHealpix);
          if (!sRegion || !candidateCells.length) { excludedRows += 1; continue; }
          const instrument = text(row.instrument_name, 128) ?? null;
          const filters = text(row.filters, 512) ?? null;
          const target = text(row.target_name, 256) ?? null;
          const startTime = finite(row.t_min) ?? null;
          const endTime = finite(row.t_max) ?? null;
          const rowHash = digest(Buffer.from(JSON.stringify([obsid, instrument, filters, target, startTime, endTime, sRegion])));
          const inserted = insertObservation.run(rowHash, obsid, instrument, filters, target, startTime, endTime,
            sRegion,
          );
          if (!inserted.changes) { duplicateRecords += 1; continue; }
          indexedRows += 1;
          if (insertObservationId.run(obsid).changes) observationCount += 1;
          else duplicateRows += 1;
          const rowId = Number(inserted.lastInsertRowid);
          for (const cell of candidateCells) insertCell.run(cell, rowId);
        }
      };

      const inputs = copiedBaseline ? { ...manifest, batches: manifest.batches.slice(1) } : manifest;
      const pageCount = inputs.batches.reduce((sum, batch) => sum + batch.pages.length, 0);
      for await (const pageData of hstSnapshotRows(evidenceRoot, inputs)) {
        writePage(pageData);
        processedPages += 1;
        if (pageCount > 20 && processedPages % 50 === 0) {
          console.info(`HST SQLite build verified ${processedPages}/${pageCount} metadata pages (${observedRows}/${manifest.rowCount} rows).`);
        }
      }
      if (observedRows !== manifest.rowCount) throw new Error("HST snapshot page count or total rows differ from its manifest");
      const metadata: Record<string, string> = {
        schema_version: INDEX_SCHEMA_VERSION,
        source_snapshot_sha256: sourceSnapshotSha256,
        row_count: String(manifest.rowCount),
        indexed_rows: String(indexedRows),
        observation_count: String(observationCount),
        excluded_rows: String(excludedRows),
        duplicate_rows: String(duplicateRows),
        duplicate_records: String(duplicateRecords),
        partial_refresh: String(manifest.partialRefresh),
        supplement_rows: String(manifest.supplementRows),
        ...(manifest.baselineSnapshotSha256 ? { baseline_snapshot_sha256: manifest.baselineSnapshotSha256 } : {}),
        ...(manifest.baselineCapturedAt ? { baseline_captured_at: manifest.baselineCapturedAt } : {}),
      };
      for (const [key, value] of Object.entries(metadata)) insertMeta.run(key, value);
      db.exec("COMMIT;");
      db.close();
      db = undefined;
      await rename(stagingPath, filePath);
      return this.open(evidenceRoot, sourceSnapshotSha256);
    } catch (error) {
      try { db?.exec("ROLLBACK;"); } catch { /* The transaction may already be closed. */ }
      try { db?.close(); } catch { /* Preserve the original error. */ }
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  get summary(): HstObservationIndexSummary { return { ...this.#summary }; }

  lookup(order: number, cells: readonly number[], limit = MAX_LOOKUP_OBSERVATIONS, observationId?: string): HstObservationLookup {
    if (!Number.isSafeInteger(order) || order < COARSE_ORDER || order > 12 || cells.length < 1
      || cells.some((cell) => !Number.isSafeInteger(cell) || cell < 0 || cell >= 12 * 4 ** order)) {
      throw new Error("HST index lookup requires valid NESTED HEALPix cells at order 4 through 12");
    }
    const coarseCells = new Set<number>();
    const childCount = 4 ** Math.max(0, COARSE_ORDER - order);
    for (const cell of cells) {
      if (order < COARSE_ORDER) {
        for (let child = 0; child < childCount; child += 1) coarseCells.add(cell * childCount + child);
      } else coarseCells.add(Math.floor(cell / 4 ** (order - COARSE_ORDER)));
    }
    this.#db.exec("DELETE FROM request_cells;");
    const insertCell = this.#db.prepare("INSERT OR IGNORE INTO request_cells(cell) VALUES (?)");
    for (const cell of coarseCells) insertCell.run(cell);
    const matched = new Map<string, {
      instruments: Set<string>; filters: Set<string>; targets: Set<string>; sRegions: Set<string>;
      matchingCells: Set<number>; startTime?: number; endTime?: number;
    }>();
    const clippedLimit = Math.max(1, Math.min(MAX_LOOKUP_OBSERVATIONS, Math.trunc(limit)));
    try {
      for (const row of this.#selectCandidates.iterate(observationId ?? null, observationId ?? null) as IterableIterator<{
        rowId: number; obsid: string; instrument: string | null; filters: string | null; target: string | null;
        startTime: number | null; endTime: number | null; sRegion: string;
      }>) {
        const matchingCells = cellsForStcs(order, cells, row.sRegion);
        if (!matchingCells.length) continue;
        let observation = matched.get(row.obsid);
        if (!observation) {
          observation = { instruments: new Set(), filters: new Set(), targets: new Set(), sRegions: new Set(), matchingCells: new Set() };
          matched.set(row.obsid, observation);
          if (matched.size > clippedLimit) break;
        }
        if (row.instrument) observation.instruments.add(row.instrument);
        if (row.filters) observation.filters.add(row.filters);
        if (row.target) observation.targets.add(row.target);
        observation.sRegions.add(row.sRegion);
        matchingCells.forEach((cell) => observation!.matchingCells.add(cell));
        if (row.startTime !== null) observation.startTime = observation.startTime === undefined ? row.startTime : Math.min(observation.startTime, row.startTime);
        if (row.endTime !== null) observation.endTime = observation.endTime === undefined ? row.endTime : Math.max(observation.endTime, row.endTime);
      }
    } finally {
      this.#db.exec("DELETE FROM request_cells;");
    }
    const matchedObservationCount = matched.size;
    const limitTruncated = matchedObservationCount > clippedLimit;
    const truncated = limitTruncated || this.#summary.excludedRows > 0 || this.#summary.partialRefresh;
    const observations: IndexedHstObservation[] = [...matched.entries()].slice(0, clippedLimit).map(([obsid, row]) => ({
      obsid,
      ...(row.instruments.size ? { instrument: [...row.instruments].sort().join(", ") } : {}),
      ...(row.filters.size ? { filters: [...row.filters].sort().join(", ") } : {}),
      ...(row.targets.size ? { target: [...row.targets].sort().join(", ") } : {}),
      ...(row.startTime !== undefined ? { startTime: row.startTime } : {}),
      ...(row.endTime !== undefined ? { endTime: row.endTime } : {}),
      productUrl: mastProductsUrl(obsid),
      sRegion: [...row.sRegions].join(" "),
      matchingCells: [...row.matchingCells].sort((left, right) => left - right),
    }));
    return {
      observations,
      matchedObservationCount,
      truncated,
      queryExhausted: !limitTruncated,
      sourceSnapshotSha256: this.#summary.sourceSnapshotSha256,
      excludedRows: this.#summary.excludedRows,
      partialRefresh: this.#summary.partialRefresh,
      baselineSnapshotSha256: this.#summary.baselineSnapshotSha256,
      baselineCapturedAt: this.#summary.baselineCapturedAt,
      supplementRows: this.#summary.supplementRows,
    };
  }

  close(): void { this.#db.close(); }
}

export async function buildHstObservationIndex(evidenceRoot: string, manifestPath: string, sourceSnapshotSha256: string): Promise<HstObservationIndex> {
  const root = path.resolve(evidenceRoot);
  const relative = path.isAbsolute(manifestPath) ? path.relative(root, manifestPath) : manifestPath;
  return HstObservationIndex.build(root, relative, sourceSnapshotSha256);
}
