import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { SourceUnit, SourceUnitCoverageLayer } from "./source-units.js";

export interface SourceUnitDiskLayerInput {
  key: string;
  geometryKey: string;
  payloadKind?: "source-unit" | "legacy-release-roster";
  payloadContext?: Record<string, unknown>;
  aliases: string[];
  layerId: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  coarseOrder: number;
  maxUnitRadiusDeg: number;
  unitKind: string;
  notes: string;
  sourceSnapshotSha256?: string;
  units: Iterable<{ coarsePixel: number; unit: SourceUnit; membershipPayload?: unknown }>;
}

export interface SourceUnitDiskLayer {
  key: string;
  geometryKey: string;
  payloadKind: "source-unit" | "legacy-release-roster";
  payloadContext?: Record<string, unknown>;
  layerId: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  coarseOrder: number;
  maxUnitRadiusDeg: number;
  unitKind: string;
  notes: string;
  sourceSnapshotSha256?: string;
}

export interface SourceUnitDiskUnit {
  unit: SourceUnit;
  membershipPayload?: unknown;
}

export const SOURCE_UNIT_DISK_INDEX_VERSION = "4";

function payload<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Source-unit disk index contains an invalid JSON payload");
  return JSON.parse(value) as T;
}

export class SourceUnitDiskIndex {
  readonly #db: DatabaseSync;
  readonly #insertPixel: StatementSync;
  readonly #selectCandidates: StatementSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec("PRAGMA cache_size=-8192; PRAGMA mmap_size=0;");
    db.exec("CREATE TEMP TABLE IF NOT EXISTS request_pixels (pixel INTEGER PRIMARY KEY) WITHOUT ROWID;");
    this.#insertPixel = db.prepare("INSERT OR IGNORE INTO request_pixels(pixel) VALUES (?)");
    this.#selectCandidates = db.prepare(`
      SELECT geometry.unit_id AS unitId, geometry.payload AS geometryPayload,
        members.payload AS memberPayload
      FROM source_layers AS layers
      INNER JOIN source_geometries AS geometry ON geometry.geometry_key = layers.geometry_key
      INNER JOIN source_layer_units AS members
        ON members.layer_key = layers.layer_key AND members.unit_id = geometry.unit_id
      INNER JOIN request_pixels AS pixels ON pixels.pixel = geometry.coarse_pixel
      WHERE layers.layer_key = ?
      ORDER BY geometry.unit_id
    `);
  }

  static async open(filePath: string, buildKey: string): Promise<SourceUnitDiskIndex | null> {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
      const rows = db.prepare("SELECT key, value FROM cache_meta WHERE key IN ('schema_version', 'build_key')").all() as Array<{ key: string; value: string }>;
      const metadata = new Map(rows.map(({ key, value }) => [key, value]));
      if (metadata.get("schema_version") !== SOURCE_UNIT_DISK_INDEX_VERSION || metadata.get("build_key") !== buildKey) {
        db.close();
        return null;
      }
      return new SourceUnitDiskIndex(db);
    } catch {
      try { db?.close(); } catch { /* The database could not be opened. */ }
      return null;
    }
  }

  static async create(
    filePath: string,
    buildKey: string,
    layers: Iterable<SourceUnitDiskLayerInput>,
    coverageLayers: SourceUnitCoverageLayer[],
  ): Promise<SourceUnitDiskIndex> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const stagingPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(stagingPath);
      db.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        PRAGMA cache_size=-16384;
        CREATE TABLE cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE source_layers (
          layer_key TEXT PRIMARY KEY,
          geometry_key TEXT NOT NULL,
          payload_kind TEXT NOT NULL,
          payload_context TEXT,
          layer_id TEXT NOT NULL,
          survey_id TEXT,
          release_id TEXT,
          product TEXT,
          coarse_order INTEGER NOT NULL,
          max_unit_radius_deg REAL NOT NULL,
          unit_kind TEXT NOT NULL,
          notes TEXT NOT NULL,
          source_snapshot_sha256 TEXT
        ) WITHOUT ROWID;
        CREATE TABLE source_aliases (alias TEXT PRIMARY KEY, layer_key TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE source_geometries (
          geometry_key TEXT NOT NULL,
          coarse_pixel INTEGER NOT NULL,
          unit_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(geometry_key, unit_id)
        ) WITHOUT ROWID;
        CREATE INDEX source_geometries_by_coarse_pixel ON source_geometries(geometry_key, coarse_pixel, unit_id);
        CREATE TABLE source_layer_units (
          layer_key TEXT NOT NULL,
          unit_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY(layer_key, unit_id)
        ) WITHOUT ROWID;
        CREATE TABLE coverage_layers (layer_id TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID;
        BEGIN IMMEDIATE;
      `);
      const insertMeta = db.prepare("INSERT INTO cache_meta(key, value) VALUES (?, ?)");
      const insertLayer = db.prepare(`
        INSERT INTO source_layers(layer_key, geometry_key, payload_kind, payload_context, layer_id, survey_id, release_id, product, coarse_order,
          max_unit_radius_deg, unit_kind, notes, source_snapshot_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAlias = db.prepare("INSERT INTO source_aliases(alias, layer_key) VALUES (?, ?)");
      const insertGeometry = db.prepare("INSERT OR IGNORE INTO source_geometries(geometry_key, coarse_pixel, unit_id, payload) VALUES (?, ?, ?, ?)");
      const insertLayerUnit = db.prepare("INSERT INTO source_layer_units(layer_key, unit_id, payload) VALUES (?, ?, ?)");
      const insertCoverage = db.prepare("INSERT INTO coverage_layers(layer_id, payload) VALUES (?, ?)");

      for (const layer of layers) {
        insertLayer.run(layer.key, layer.geometryKey, layer.payloadKind ?? "source-unit",
          layer.payloadContext ? JSON.stringify(layer.payloadContext) : null, layer.layerId, layer.surveyId ?? null, layer.releaseId ?? null,
          layer.product ?? null, layer.coarseOrder, layer.maxUnitRadiusDeg, layer.unitKind,
          layer.notes, layer.sourceSnapshotSha256 ?? null);
        for (const alias of layer.aliases) insertAlias.run(alias, layer.key);
        for (const row of layer.units) {
          const { unitId, unitKind, raDeg, decDeg, radiusDeg, footprint, geometryPrecision, accessAvailability, note, ...membership } = row.unit;
          insertGeometry.run(layer.geometryKey, row.coarsePixel, unitId, JSON.stringify({
            unitKind, raDeg, decDeg, radiusDeg, ...(footprint ? { footprint } : {}), geometryPrecision,
            ...(accessAvailability ? { accessAvailability } : {}), ...(note ? { note } : {}),
          }));
          insertLayerUnit.run(layer.key, unitId, JSON.stringify(row.membershipPayload ?? membership));
        }
      }
      for (const layer of coverageLayers) {
        insertCoverage.run(layer.layerId, JSON.stringify({
          ...layer,
          cells: [...layer.cells.entries()],
        }));
      }
      insertMeta.run("schema_version", SOURCE_UNIT_DISK_INDEX_VERSION);
      insertMeta.run("build_key", buildKey);
      db.exec("COMMIT;");
      db.close();
      db = undefined;
      await rename(stagingPath, filePath);
      const index = await SourceUnitDiskIndex.open(filePath, buildKey);
      if (!index) throw new Error("Created source-unit disk index could not be reopened");
      return index;
    } catch (error) {
      try { db?.exec("ROLLBACK;"); } catch { /* The transaction may already be closed. */ }
      try { db?.close(); } catch { /* Preserve the original error. */ }
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  layer(alias: string): SourceUnitDiskLayer | null {
    const row = this.#db.prepare(`
      SELECT layers.layer_key AS key, layers.layer_id AS layerId,
        layers.geometry_key AS geometryKey,
        layers.payload_kind AS payloadKind, layers.payload_context AS payloadContext,
        layers.survey_id AS surveyId, layers.release_id AS releaseId,
        layers.product, layers.coarse_order AS coarseOrder,
        layers.max_unit_radius_deg AS maxUnitRadiusDeg, layers.unit_kind AS unitKind,
        layers.notes, layers.source_snapshot_sha256 AS sourceSnapshotSha256
      FROM source_aliases AS aliases
      INNER JOIN source_layers AS layers ON layers.layer_key = aliases.layer_key
      WHERE aliases.alias = ?
    `).get(alias) as (Omit<SourceUnitDiskLayer, "payloadContext"> & { payloadContext: string | null }) | undefined;
    if (!row) return null;
    return { ...row, payloadContext: row.payloadContext ? payload<Record<string, unknown>>(row.payloadContext) : undefined };
  }

  *units(layerKey: string, coarsePixels: Iterable<number>): IterableIterator<SourceUnitDiskUnit> {
    const layer = this.layer(layerKey);
    if (!layer) return;
    this.#db.exec("DELETE FROM request_pixels;");
    for (const pixel of coarsePixels) this.#insertPixel.run(pixel);
    try {
      for (const row of this.#selectCandidates.iterate(layerKey) as IterableIterator<{ unitId: string; geometryPayload: string; memberPayload: string }>) {
        const memberPayload = payload<unknown>(row.memberPayload);
        const compactMembership = layer.payloadKind === "legacy-release-roster";
        const membership = compactMembership
          ? { membershipPayload: memberPayload }
          : { membershipPayload: undefined };
        const details = !compactMembership && memberPayload && typeof memberPayload === "object" && !Array.isArray(memberPayload)
          ? memberPayload as Record<string, unknown>
          : {};
        yield {
          unit: {
            unitId: row.unitId,
            ...payload<Omit<SourceUnit, "unitId">>(row.geometryPayload),
            ...details,
          } as SourceUnit,
          ...membership,
        };
      }
    } finally {
      this.#db.exec("DELETE FROM request_pixels;");
    }
  }

  coverageLayers(): SourceUnitCoverageLayer[] {
    const rows = this.#db.prepare("SELECT payload FROM coverage_layers ORDER BY layer_id").all() as Array<{ payload: string }>;
    return rows.map(({ payload: value }) => {
      const layer = payload<Omit<SourceUnitCoverageLayer, "cells"> & { cells: Array<[number, number[]]> }>(value);
      return { ...layer, cells: new Map(layer.cells) };
    });
  }

  close(): void { this.#db.close(); }
}
