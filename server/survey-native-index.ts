import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createGunzip } from "node:zlib";
import { Healpix } from "healpixjs";
import type { DownloadPlanSpatialUnit } from "./evidence-store.js";
import type { SourceAccessAlternative, SourceAccessUri } from "./evidence-store.js";
import { candidateCellsForStcs, cellsForStcs } from "./hst-image-lookup.js";
import { nativeFile } from "./native-unit-archive.js";
import { nativeDigest, nativeEvidencePath, nativeMetadataUrl, type NativeAdapter, type NativeBinding, type NativeFile, type NativeSnapshot, type NativeSource } from "./native-unit-model.js";
import { alternativesForAccessUri, mastScienceFile, metadataEntrypoint } from "./survey-access.js";

const SCHEMA = "1";
const COARSE_ORDER = 4;
const MAX_UNITS = 50_000;
const ADAPTERS = new Set<NativeAdapter>(["gaia-healpix-range", "sdss-field", "mast-observation"]);
export const isSurveyNativeAdapter = (adapter: NativeAdapter): boolean => ADAPTERS.has(adapter);

type Document = Record<string, any>;
interface SurveyManifest extends Document {
  schemaVersion: 1; adapter: NativeAdapter; surveyId: string; releaseId: string;
  capturedAt: string; coordinateFrame: "ICRS"; ordering: "NESTED";
  metadataDocuments: Array<NativeFile & { url?: string }>;
  rowFiles?: Array<NativeFile & { rows: number }>;
  rowCount?: number; inventoryComplete?: boolean;
}
interface Summary {
  sourceId: string; surveyId: string; releaseId: string; adapter: NativeAdapter;
  sourceUrl: string; sha256: string; capturedAt: string; scope: string;
  rowCount: number; indexedRows: number; unitCount: number; excludedRows: number; inventoryComplete: boolean; queryComplete: boolean;
}
interface IndexedRow {
  sourceId: string; unitId: string; sRegion: string | null; firstIpix: number | null; lastIpix: number | null;
  payload: string;
}

/** Binding selectors are release/product contracts, independent of the displayed MOC. */
export function surveyNativeBinding(layer: Pick<NativeBinding, "layerId" | "surveyId" | "releaseId" | "product">): Pick<NativeBinding, "unitKind" | "sourceIds" | "selector"> | undefined {
  if (layer.surveyId === "gaia" && layer.releaseId === "gaia-dr3" && layer.layerId === "gaia-dr3-main-source-presence") return { unitKind: "healpix-range", sourceIds: ["gaia-dr3-file-partitions"] };
  if (layer.surveyId === "sdss" && layer.releaseId === "sdss-dr09") {
    const band = layer.product.match(/\b([ugriz])-band\b/i)?.[1]?.toUpperCase();
    if (!band && !/DR9.*color/i.test(layer.product)) return undefined;
    return { unitKind: "field", sourceIds: ["sdss-dr9-fields"], selector: { releaseTags: ["DR9"], ...(band ? { bands: [band] } : {}) } };
  }
  if (layer.surveyId === "galex" && ["galex-gr6-gr7", "galex-gr6-ais"].includes(layer.releaseId)) {
    const band = layer.product.match(/\b(FUV|NUV)\b/i)?.[1]?.toUpperCase();
    return { unitKind: "observation", sourceIds: ["galex-public-images"], selector: { releaseTags: layer.releaseId === "galex-gr6-ais" ? ["GR6"] : ["GR6", "GR7"], ...(band ? { bands: [band] } : {}), ...(layer.releaseId === "galex-gr6-ais" ? { project: "AIS" } : {}) } };
  }
  if (layer.surveyId === "jwst" && layer.releaseId === "dr1") {
    if (layer.layerId === "moc-jwst-dr1-611dfe774f60") return { unitKind: "observation", sourceIds: ["jwst-early-release-images"], selector: { proposalIds: ["2731"], instrument: "NIRCAM", targets: ["NGC-3324"] } };
    if (layer.layerId === "moc-jwst-dr1-c0924d1a5468") return { unitKind: "observation", sourceIds: ["jwst-early-release-images"], selector: { proposalIds: ["2736"], instrument: "NIRCAM", targets: ["SMACS-J0723.3-7327"] } };
  }
  return undefined;
}

export async function loadSurveyManifest(root: string, ref: string, source: NativeSource, expected?: Pick<NativeFile, "sha256" | "sizeBytes">): Promise<{ manifest: SurveyManifest; files: NativeFile[] }> {
  if (!isSurveyNativeAdapter(source.adapter)) throw new Error("Unsupported survey metadata adapter");
  nativeMetadataUrl(source.sourceUrl, source.adapter);
  const file = await nativeFile(root, ref, expected);
  if (file.sizeBytes > 16 * 1024 * 1024) throw new Error("Survey manifest exceeded its metadata budget");
  const manifest = JSON.parse(await readFile(nativeEvidencePath(root, ref), "utf8")) as SurveyManifest;
  if (manifest.schemaVersion !== 1 || manifest.adapter !== source.adapter || manifest.surveyId !== source.surveyId || manifest.releaseId !== source.releaseId
    || manifest.coordinateFrame !== "ICRS" || manifest.ordering !== "NESTED" || !Number.isFinite(Date.parse(manifest.capturedAt))
    || !Array.isArray(manifest.metadataDocuments) || !manifest.metadataDocuments.length || manifest.metadataDocuments.length + (manifest.rowFiles?.length ?? 0) > 4096) throw new Error("Survey manifest identity, coordinate contract or provenance is invalid");
  if (source.adapter === "gaia-healpix-range") {
    if (manifest.nativeOrder !== 8 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.listing?.complete !== true || manifest.scope?.fileRosterComplete !== true) throw new Error("Gaia import requires the complete official order-8 file roster");
    let end = -1;
    for (const row of manifest.files) {
      if (!Number.isSafeInteger(row.firstIpix) || !Number.isSafeInteger(row.lastIpix) || row.firstIpix !== end + 1 || row.lastIpix < row.firstIpix || row.lastIpix >= 12 * 4 ** 8
        || row.unitId !== `GaiaSource_${String(row.firstIpix).padStart(6, "0")}-${String(row.lastIpix).padStart(6, "0")}`
        || row.filename !== `${row.unitId}.csv.gz` || !/^[a-f0-9]{32}$/i.test(row.sourceMd5 ?? "") || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1) throw new Error("Invalid or overlapping Gaia native file range");
      const url = new URL(row.url);
      if (url.protocol !== "https:" || url.hostname !== "cdn.gea.esac.esa.int" && url.hostname !== "gaia.eu-1.cdn77-storage.com" || url.pathname !== `/Gaia/gdr3/gaia_source/${row.filename}` || url.username || url.password) throw new Error("Gaia file URI is not an official roster identity");
      end = row.lastIpix;
    }
    if (end !== 12 * 4 ** 8 - 1) throw new Error("Gaia native roster does not cover its declared order-8 partition domain");
  } else if (!Array.isArray(manifest.rowFiles) || !manifest.rowFiles.length || !Number.isSafeInteger(manifest.rowCount) || manifest.rowCount! < 1) throw new Error("Survey observation/field import needs locked row files");
  const files = [{ ...file, sourceUrl: source.sourceUrl }];
  for (const dependency of [...manifest.metadataDocuments, ...(manifest.rowFiles ?? [])]) {
    // References are relative to the manifest, and may never escape its directory.
    nativeEvidencePath("/", dependency.ref);
    const depRef = path.posix.join(path.posix.dirname(ref), dependency.ref);
    files.push({ ...await nativeFile(root, depRef, dependency), sourceUrl: ("url" in dependency ? dependency.url : undefined) ?? dependency.sourceUrl ?? source.sourceUrl });
  }
  return { manifest, files };
}

async function* manifestRows(root: string, ref: string, manifest: SurveyManifest): AsyncGenerator<Document> {
  if (manifest.adapter === "gaia-healpix-range") { for (const row of manifest.files) yield row; return; }
  let total = 0;
  for (const file of manifest.rowFiles!) {
    const stream = createReadStream(nativeEvidencePath(root, path.posix.join(path.posix.dirname(ref), file.ref)));
    const decoded = file.ref.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
    const lines = createInterface({ input: decoded, crlfDelay: Infinity });
    let rows = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > 256 * 1024) throw new Error("Native metadata row exceeds its size budget");
        const row = JSON.parse(line) as Document;
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => /^(?:flux|wavelength|pixels|spectrum)$/i.test(key))) throw new Error("Only native-unit metadata rows can be imported");
        rows++; total++; yield row;
      }
    } finally { lines.close(); decoded.destroy(); stream.destroy(); }
    if (rows !== file.rows) throw new Error("Survey row file count differs from its locked manifest");
  }
  if (total !== manifest.rowCount) throw new Error("Survey total row count differs from its locked manifest");
}

export async function importSurveySnapshot(root: string, file: NativeFile, source: NativeSource): Promise<NativeSnapshot> {
  const { manifest, files } = await loadSurveyManifest(root, file.ref, source, file);
  let rows = 0;
  for await (const _row of manifestRows(root, file.ref, manifest)) rows++;
  return { id: nativeDigest({ sourceId: source.id, sourceRevision: source.revision, sha256: files[0]!.sha256 }), sourceId: source.id, sourceRevision: source.revision,
    capturedAt: manifest.capturedAt, sourceUrl: source.sourceUrl, scope: source.scope, files, rowCount: rows };
}

function publicUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

function normalizedRow(row: Document, source: NativeSource): Document | undefined {
  const unitId = String(row.unitId ?? "");
  if (!unitId || unitId.length > 160 || /[\x00-\x1f]/.test(unitId)) throw new Error("Invalid native unit identity");
  if (source.adapter === "gaia-healpix-range") return row;
  if (source.adapter === "sdss-field") {
    const metadata = row.sourceMetadata;
    if (!metadata || ![metadata.run, metadata.camcol, metadata.field].every(Number.isSafeInteger)
      || String(metadata.rerun) !== "301" || metadata.photoStatus !== 0 || metadata.run < 1 || metadata.camcol < 1 || metadata.camcol > 6 || metadata.field < 0
      || unitId !== `${metadata.run}/${metadata.rerun}/${metadata.camcol}/${metadata.field}`) throw new Error("SDSS fields require actual normal rerun-301 native identities");
  }
  const sRegion = row.sRegion;
  if (typeof sRegion !== "string" || sRegion.length > 131_072) return undefined;
  if (source.adapter === "mast-observation") {
    if (String(row.dataRights).toUpperCase() !== "PUBLIC" || String(row.dataproduct_type).toLowerCase() !== "image" || String(row.obs_collection).toLowerCase() !== source.surveyId || !/^\d+$/.test(unitId)) throw new Error("MAST snapshot contains a non-public or unrelated observation");
    if (source.surveyId === "jwst" && (row.provenance_name !== "CALJWST" || !Number.isFinite(row.t_min) || ![1, 2, 3, 4].includes(Number(row.calib_level)))) throw new Error("Planned, test or uncalibrated JWST records cannot become observed sky units");
  }
  const bands: string[] = (Array.isArray(row.bands) ? row.bands : String(row.filters ?? "").split(/[,;\s]+/)).map((band: unknown) => String(band).toUpperCase()).filter(Boolean);
  const dataUrl = String(row.dataURL ?? "");
  const releaseTag = source.surveyId === "sdss" ? "DR9" : source.surveyId === "galex" ? /\/data\/(GR[67])\//i.exec(dataUrl)?.[1]?.toUpperCase() : undefined;
  if (source.surveyId === "galex" && !releaseTag) return undefined;
  const accessUris = (row.accessUris ?? []).flatMap((access: Document) => {
    const uri = publicUri(access.uri ?? access.url);
    return uri ? [{ ...access, uri, ...(access.fileName ?? access.filename ? { fileName: access.fileName ?? access.filename } : {}), ...(access.band ? { band: String(access.band).toUpperCase() } : {}) }] : [];
  });
  return { ...row, unitId, sRegion, bands, releaseTag, accessUris,
    instrument: row.instrument ?? row.instrument_name, proposalId: String(row.proposalId ?? row.proposal_id ?? ""), targetName: row.targetName ?? row.target_name,
    sourceMetadata: row.sourceMetadata ?? row.metadata ?? {} };
}

export class SurveyNativeIndex {
  readonly #db: DatabaseSync;
  readonly #sources: Map<string, Summary>;
  readonly buildKey: string;
  private constructor(db: DatabaseSync, buildKey: string) {
    this.#db = db; this.buildKey = buildKey;
    db.exec("PRAGMA cache_size=-8192; PRAGMA mmap_size=0; CREATE TEMP TABLE request_cells(cell INTEGER PRIMARY KEY) WITHOUT ROWID;");
    this.#sources = new Map((db.prepare("SELECT source_id AS sourceId, payload FROM survey_sources").all() as Array<{ sourceId: string; payload: string }>).map(row => [row.sourceId, JSON.parse(row.payload) as Summary]));
  }
  static open(file: string, buildKey: string): SurveyNativeIndex {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const meta = new Map((db.prepare("SELECT key,value FROM survey_meta").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]));
      if (meta.get("schema") !== SCHEMA || meta.get("build_key") !== buildKey) throw new Error("Survey native index schema or locked inputs do not match");
      return new SurveyNativeIndex(db, buildKey);
    } catch (error) { db.close(); throw error; }
  }
  static key(snapshots: NativeSnapshot[]): string { return nativeDigest({ schema: SCHEMA, construction: "local-staging-v1", inputs: snapshots.map(snapshot => [snapshot.sourceId, snapshot.id, snapshot.files[0]!.sha256]).sort() }); }
  static async build(root: string, ref: string, sources: NativeSource[], snapshots: NativeSnapshot[], progress: (message: string) => void): Promise<SurveyNativeIndex> {
    const file = nativeEvidencePath(root, ref); await mkdir(path.dirname(file), { recursive: true });
    const buildKey = this.key(snapshots);
    // SQLite's random page writes can stall for minutes on the evidence NFS.
    // Build on the worker's temporary disk, then atomically install the closed DB.
    const scratch = await mkdtemp(path.join(os.tmpdir(), "assets-survey-native-"));
    const staging = path.join(scratch, "survey.sqlite");
    const installing = `${file}.${path.basename(scratch)}.tmp`;
    let installStarted = false;
    let db: DatabaseSync | undefined;
    const healpix = new Healpix(2 ** COARSE_ORDER);
    try {
      db = new DatabaseSync(staging);
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384;
        CREATE TABLE survey_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE survey_sources(source_id TEXT PRIMARY KEY,payload TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE survey_units(row_id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, unit_id TEXT NOT NULL, row_hash TEXT UNIQUE NOT NULL,
          s_region TEXT, first_ipix INTEGER, last_ipix INTEGER, bands TEXT NOT NULL, release_tag TEXT, proposal_id TEXT, instrument TEXT, target TEXT, project TEXT, payload TEXT NOT NULL);
        CREATE INDEX survey_units_by_source ON survey_units(source_id,unit_id,row_id);
        CREATE INDEX survey_units_by_partition ON survey_units(source_id,first_ipix,last_ipix);
        CREATE TABLE survey_cells(coarse_cell INTEGER NOT NULL,row_id INTEGER NOT NULL,PRIMARY KEY(coarse_cell,row_id)) WITHOUT ROWID;
        CREATE TEMP TABLE native_ids(unit_id TEXT PRIMARY KEY) WITHOUT ROWID;
        BEGIN IMMEDIATE;`);
      const insert = db.prepare("INSERT OR IGNORE INTO survey_units(source_id,unit_id,row_hash,s_region,first_ipix,last_ipix,bands,release_tag,proposal_id,instrument,target,project,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const insertCell = db.prepare("INSERT OR IGNORE INTO survey_cells VALUES (?,?)");
      const insertId = db.prepare("INSERT OR IGNORE INTO native_ids VALUES (?)");
      for (const snapshot of snapshots) {
        const source = sources.find(item => item.id === snapshot.sourceId)!;
        const { manifest } = await loadSurveyManifest(root, snapshot.files[0]!.ref, source, snapshot.files[0]);
        let rowCount = 0, indexedRows = 0, excludedRows = 0;
        db.exec("DELETE FROM native_ids;");
        for await (const input of manifestRows(root, snapshot.files[0]!.ref, manifest)) {
          rowCount++;
          const row = normalizedRow(input, source);
          const coarseCells = row && source.adapter !== "gaia-healpix-range" ? candidateCellsForStcs(COARSE_ORDER, row.sRegion, healpix) : [];
          if (!row || source.adapter !== "gaia-healpix-range" && !coarseCells.length) { excludedRows++; continue; }
          const payload = JSON.stringify(row);
          const result = insert.run(source.id, row.unitId, nativeDigest([source.id, row]), row.sRegion ?? null, row.firstIpix ?? null, row.lastIpix ?? null,
            `,${(row.bands ?? []).join(",")},`, row.releaseTag ?? null, row.proposalId ?? null, row.instrument ?? null, row.targetName ?? null, row.project ?? null, payload);
          if (!result.changes) continue;
          indexedRows++; insertId.run(row.unitId);
          for (const cell of coarseCells) insertCell.run(cell, Number(result.lastInsertRowid));
          if (rowCount % 50_000 === 0) progress(`${source.title}: ${rowCount} metadata rows indexed`);
        }
        const unitCount = Number((db.prepare("SELECT count(*) AS total FROM native_ids").get() as { total: number }).total);
        const summary: Summary = { sourceId: source.id, surveyId: source.surveyId, releaseId: source.releaseId, adapter: source.adapter,
          sourceUrl: source.sourceUrl, sha256: snapshot.files[0]!.sha256, capturedAt: manifest.capturedAt, scope: snapshot.scope,
          rowCount, indexedRows, unitCount, excludedRows, inventoryComplete: source.adapter === "gaia-healpix-range" || manifest.inventoryComplete === true && excludedRows === 0,
          queryComplete: ["gaia-healpix-range", "sdss-field"].includes(source.adapter) || manifest.queryPagesComplete === true || manifest.sourcePagination?.queryPagesComplete === true };
        if (!unitCount) throw new Error(`${source.id} has no supported native metadata geometry`);
        db.prepare("INSERT INTO survey_sources VALUES (?,?)").run(source.id, JSON.stringify(summary));
        progress(`${source.title}: ${unitCount} identities; ${excludedRows} excluded rows retained in input evidence`);
      }
      db.prepare("INSERT INTO survey_meta VALUES ('schema',?)").run(SCHEMA);
      db.prepare("INSERT INTO survey_meta VALUES ('build_key',?)").run(buildKey);
      db.exec("COMMIT;");
      if ((db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("Survey native SQLite failed integrity verification");
      db.close();
      progress("Installing the verified survey metadata SQLite into evidence storage");
      installStarted = true;
      await copyFile(staging, installing, constants.COPYFILE_EXCL);
      await rename(installing, file);
      return this.open(file, buildKey);
    } catch (error) { try { db?.exec("ROLLBACK;"); } catch {} try { db?.close(); } catch {} throw error; }
    finally {
      await rm(scratch, { recursive: true, force: true });
      if (installStarted) await rm(installing, { force: true });
    }
  }
  get summaries(): Summary[] { return [...this.#sources.values()].map(summary => ({ ...summary })); }
  hasBinding(binding: NativeBinding): boolean { return binding.sourceIds.length === 1 && this.#sources.has(binding.sourceIds[0]!); }
  sampleCells(binding: NativeBinding): number[] {
    const { sql, args } = this.#selection(binding);
    const row = this.#db.prepare(`SELECT s_region AS sRegion,first_ipix AS firstIpix FROM survey_units WHERE ${sql} ORDER BY unit_id,row_id LIMIT 1`).get(...args) as { sRegion: string | null; firstIpix: number | null } | undefined;
    if (!row) return [];
    return row.firstIpix !== null ? [Math.floor(row.firstIpix / 4 ** (8 - 4))] : cellsForStcs(4, Array.from({ length: 12 * 4 ** 4 }, (_, pixel) => pixel), row.sRegion);
  }
  #selection(binding: NativeBinding): { sql: string; args: SQLInputValue[] } {
    if (!this.hasBinding(binding)) throw new Error("Product has no locked survey-native source");
    const terms = ["source_id=?"]; const args: SQLInputValue[] = [binding.sourceIds[0]!];
    const selector = binding.selector;
    for (const [column, values] of [["release_tag", selector?.releaseTags], ["proposal_id", selector?.proposalIds], ["target", selector?.targets]] as const) if (values?.length) { terms.push(`${column} IN (${values.map(() => "?").join(",")})`); args.push(...values); }
    if (selector?.bands?.length) { terms.push(`(${selector.bands.map(() => "INSTR(bands,?)>0").join(" OR ")})`); args.push(...selector.bands.map(band => `,${band.toUpperCase()},`)); }
    if (selector?.instrument) { terms.push("(UPPER(instrument)=? OR UPPER(instrument) LIKE ?)"); args.push(selector.instrument.toUpperCase(), `${selector.instrument.toUpperCase()}/%`); }
    if (selector?.project) { terms.push("UPPER(project)=?"); args.push(selector.project.toUpperCase()); }
    return { sql: terms.join(" AND "), args };
  }
  lookup(binding: NativeBinding, order: number, cells: readonly number[], limit = MAX_UNITS): { units: DownloadPlanSpatialUnit[]; truncated: boolean; queryExhausted: boolean; notes: string[]; inventoryComplete: boolean } {
    if (!Number.isSafeInteger(order) || order < 4 || order > 12 || cells.some(cell => !Number.isSafeInteger(cell) || cell < 0 || cell >= 12 * 4 ** order)) throw new Error("Survey lookup requires ICRS/NESTED cells at order 4 through 12");
    const summary = this.#sources.get(binding.sourceIds[0]!)!;
    const { sql, args } = this.#selection(binding);
    const rows = this.#db.prepare(`SELECT source_id AS sourceId,unit_id AS unitId,s_region AS sRegion,first_ipix AS firstIpix,last_ipix AS lastIpix,payload FROM survey_units WHERE ${sql}${summary.adapter === "gaia-healpix-range" ? "" : " AND row_id IN (SELECT row_id FROM survey_cells WHERE coarse_cell IN (SELECT cell FROM request_cells))"} ORDER BY unit_id,row_id`);
    this.#db.exec("DELETE FROM request_cells;");
    const insertCell = this.#db.prepare("INSERT OR IGNORE INTO request_cells VALUES (?)");
    for (const cell of new Set(cells.map(cell => Math.floor(cell / 4 ** (order - COARSE_ORDER))))) insertCell.run(cell);
    const matched = new Map<string, DownloadPlanSpatialUnit>();
    const clippedLimit = Math.max(1, Math.min(MAX_UNITS, Math.trunc(limit)));
    let limitHit = false;
    try {
      for (const row of rows.iterate(...args) as Iterable<IndexedRow>) {
        const matchingCells = summary.adapter === "gaia-healpix-range" ? cells.filter(cell => {
          const first = order <= 8 ? cell * 4 ** (8 - order) : Math.floor(cell / 4 ** (order - 8));
          const last = order <= 8 ? (cell + 1) * 4 ** (8 - order) - 1 : first;
          return first <= row.lastIpix! && last >= row.firstIpix!;
        }) : cellsForStcs(order, cells, row.sRegion);
        if (!matchingCells.length) continue;
        let unit = matched.get(row.unitId);
        if (!unit && matched.size >= clippedLimit) { limitHit = true; break; }
        const payload = JSON.parse(row.payload) as Document;
        if (!unit) {
          unit = { layerId: binding.layerId, productId: binding.productId, surveyId: binding.surveyId, releaseId: binding.releaseId, product: binding.product,
            ...(binding.modality ? { modality: binding.modality } : {}), unitKind: binding.unitKind, unitId: row.unitId, order, nside: 2 ** order, matchingCells: [], precision: "estimated",
            sourceSnapshotSha256: summary.sha256, sourceUrl: summary.sourceUrl, accessAvailability: summary.adapter === "sdss-field" ? "unverified" : "source-policy",
            sourceMetadata: { capturedAt: summary.capturedAt, inventoryComplete: summary.inventoryComplete, records: [] },
            note: summary.scope };
          if (summary.adapter === "gaia-healpix-range") {
            unit.nativePartition = { coordinateFrame: "ICRS", ordering: "NESTED", order: 8, firstIpix: row.firstIpix!, lastIpix: row.lastIpix!, precision: "exact" };
            const alternatives = alternativesForAccessUri(payload.url, { surveyId: binding.surveyId, releaseId: binding.releaseId, fileName: payload.filename });
            unit.accessUri = payload.url; unit.accessUris = [{ uri: payload.url, fileName: payload.filename, accessType: "file", alternatives }];
            unit.sourceMetadata = { capturedAt: summary.capturedAt, fileRosterComplete: true, scienceContentVerified: false, sizeBytes: payload.sizeBytes,
              sourceMd5: payload.sourceMd5, checksumStatus: "upstream-declared", sourceEtag: payload.sourceEtag, lastModified: payload.lastModified };
          }
          matched.set(row.unitId, unit);
        }
        unit.matchingCells = [...new Set([...unit.matchingCells, ...matchingCells])].sort((a, b) => a - b);
        if (summary.adapter !== "gaia-healpix-range") {
          const regions = new Set([...(unit.sRegion ? [unit.sRegion] : []), row.sRegion!]); unit.sRegion = [...regions].join(" ");
          unit.instrument = [...new Set([unit.instrument, payload.instrument].filter(Boolean))].join(", ") || undefined;
          const selectedBands = (payload.bands ?? []).filter((band: string) => !binding.selector?.bands?.length || binding.selector.bands.includes(band));
          unit.filters = [...new Set([...(unit.filters?.split(", ") ?? []), ...selectedBands])].sort().join(", ");
          const direct = mastScienceFile(payload.dataURL, binding.surveyId);
          const accessUris: SourceAccessUri[] = direct ? [{ uri: direct.uri, fileName: direct.fileName, accessType: "file",
            alternatives: alternativesForAccessUri(direct.uri, { surveyId: binding.surveyId, releaseId: binding.releaseId, fileName: direct.fileName,
              band: payload.bands?.length === 1 ? payload.bands[0] : undefined }) }] : [];
          for (const access of payload.accessUris as Document[]) {
            if (!access.band || !binding.selector?.bands?.length || binding.selector.bands.includes(String(access.band).toUpperCase())) {
              const uri = publicUri(access.uri ?? access.url);
              const fileName = String(access.fileName ?? access.filename ?? "");
              if (uri && /\.(?:fits(?:\.(?:gz|bz2|fz))?|asdf)$/i.test(fileName) && !accessUris.some(item => item.uri === uri)) {
                accessUris.push({ uri, fileName, accessType: "file", alternatives: alternativesForAccessUri(uri,
                  { surveyId: binding.surveyId, releaseId: binding.releaseId, fileName, band: access.band }) });
              }
            }
          }
          const allUris = new Map([...(unit.accessUris ?? []), ...accessUris].map(access => [access.uri, access]));
          unit.accessUris = [...allUris.values()]; unit.accessUri = unit.accessUris[0]?.uri;
          const productEntryPoint = (payload.accessUris as Document[]).map((access: Document) => publicUri(access.uri ?? access.url))
            .find((uri: string | undefined) => uri && new URL(uri).hostname === "mast.stsci.edu" && new URL(uri).pathname === "/api/v0/invoke");
          if (productEntryPoint) {
            const entrypoints = new Map((unit.sourceMetadata!.entrypoints ?? []).map(item => [item.uri, item]));
            entrypoints.set(productEntryPoint, metadataEntrypoint(productEntryPoint, binding.surveyId, binding.releaseId));
            unit.sourceMetadata!.entrypoints = [...entrypoints.values()];
          }
          (unit.sourceMetadata!.records as unknown[]).push({ ...payload.sourceMetadata, ...(payload.dataURL ? { dataURL: payload.dataURL } : {}),
            ...(payload.obs_id ? { obs_id: String(payload.obs_id) } : {}), ...(payload.objID ? { objID: String(payload.objID) } : {}),
            bands: payload.bands, releaseTag: payload.releaseTag, proposalId: payload.proposalId, targetName: payload.targetName,
            project: payload.project, provenance: payload.provenance_name, t_min: payload.t_min, t_max: payload.t_max, calib_level: payload.calib_level, dataRights: payload.dataRights, sRegion: row.sRegion });
        }
      }
    } finally { this.#db.exec("DELETE FROM request_cells;"); }
    const notes = [summary.scope];
    if (!summary.inventoryComplete) notes.push(`${binding.surveyId}: this locked metadata snapshot does not establish complete survey inventory.`);
    if (summary.excludedRows) notes.push(`${binding.surveyId}: ${summary.excludedRows} metadata rows lack supported release or geometry; their source evidence is retained.`);
    if (limitHit) notes.push(`${binding.surveyId}: the ${clippedLimit}-unit query limit was reached.`);
    if (summary.adapter === "mast-observation") {
      const detail = "Original MAST s_region is retained. Complex polygons use a conservative spherical cap and can include nearby false positives; valid-pixel masks and complete scientific product inventory were not inspected. The Products API is the source-policy entrypoint; archive-reported dataURL subtypes are preserved without synthesizing intensity files.";
      notes.push(detail); for (const unit of matched.values()) unit.note += ` ${detail}`;
    }
    return { units: [...matched.values()], queryExhausted: !limitHit && summary.queryComplete && summary.excludedRows === 0, truncated: limitHit || summary.excludedRows > 0 || !summary.queryComplete, notes, inventoryComplete: summary.inventoryComplete };
  }
  close(): void { this.#db.close(); }
}
