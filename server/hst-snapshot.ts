import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parseHstMetadataRows } from "../scripts/acquire-hst-public-image-observations.js";

const SOURCE_URL = "https://mast.stsci.edu/api/v0/invoke";
type Document = Record<string, any>;

export interface HstSnapshotFile { path: string; sha256: string; sizeBytes: number }
interface SnapshotPage extends HstSnapshotFile { page: number; rows: number }
interface PageBatch {
  pages: SnapshotPage[]; pageSize: number; pageCount: number; rowCount: number;
  rowsFiltered: number; rowsTotal?: number; query?: Document;
}
export interface HstSnapshotPlan {
  capturedAt: string; rowCount: number; files: HstSnapshotFile[]; batches: PageBatch[];
  partialRefresh: boolean; baselineSnapshotSha256?: string; baselineCapturedAt?: string;
  supplementRows: number;
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function integer(value: unknown, minimum = 1): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum; }
function relative(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value)
    || value.split(/[\\/]/).some(part => part === "..")) throw new Error("HST snapshot has an unsafe evidence path");
  return value;
}
function join(root: string, file: string): string { return root ? path.join(root, relative(file)) : relative(file); }
function identity(value: Document): void {
  if (value.kind !== "mast-hst-public-image-observations" || value.sourceUrl !== SOURCE_URL
    || value.service !== "Mast.Caom.Filtered" || !Number.isFinite(Date.parse(value.capturedAt))) {
    throw new Error("HST snapshot manifest has an unsupported source or capture date");
  }
}
function publicScope(query: Document | undefined): void {
  const filters = query?.filters;
  if (!Array.isArray(filters) || typeof query?.columns !== "string") throw new Error("HST snapshot scope must be public HST images");
  for (const [key, value] of [["obs_collection", "HST"], ["dataproduct_type", "image"], ["dataRights", "PUBLIC"]]) {
    const selected = filters.filter(filter => filter.paramName === key);
    if (selected.length !== 1 || selected[0].values?.length !== 1 || selected[0].values[0] !== value) {
      throw new Error("HST snapshot scope must be public HST images");
    }
  }
  if (query.coordinateFrame !== "ICRS" || query.spatialColumn !== "s_region") throw new Error("HST snapshot must preserve ICRS s_region geometry");
  const columns = query.columns.split(",").map((column: string) => column.trim());
  const allowed = new Set(["obsid", "obs_collection", "dataproduct_type", "proposal_id", "target_name", "instrument_name", "filters", "t_min", "t_max", "s_region", "dataRights"]);
  if (columns.some((column: string) => !allowed.has(column)) || ["obsid", "obs_collection", "dataproduct_type", "s_region", "dataRights"].some(column => !columns.includes(column))) {
    throw new Error("HST snapshot columns must contain only public observation metadata");
  }
}
function batch(value: Document, root: string, partial: boolean, requireScope: boolean): PageBatch {
  if (!integer(value.pageSize) || !integer(value.pageCount) || !integer(value.rowCount)
    || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > value.pageCount
    || !partial && value.pages.length !== value.pageCount) throw new Error("HST snapshot manifest is incomplete or has invalid pagination");
  if (requireScope || value.query) publicScope(value.query);
  const pages: SnapshotPage[] = [...value.pages].sort((a, b) => a.page - b.page).map((page, index, all) => {
    if (!integer(page.page) || page.page > value.pageCount || !integer(page.rows, 0) || page.rows > value.pageSize
      || !integer(page.sizeBytes) || !/^[a-f0-9]{64}$/.test(page.sha256)
      || index > 0 && all[index - 1].page === page.page || !partial && page.page !== index + 1) {
      throw new Error("HST snapshot page manifest has invalid or missing pagination entries");
    }
    return { ...page, path: join(root, page.path) };
  });
  if (pages.reduce((sum, page) => sum + page.rows, 0) !== value.rowCount) throw new Error("HST snapshot page count or total rows differ from its manifest");
  const rowsFiltered = partial ? value.rowsFiltered : value.rowCount;
  if (!integer(rowsFiltered) || rowsFiltered < value.rowCount || Math.ceil(rowsFiltered / value.pageSize) !== value.pageCount
    || pages.some(page => page.rows !== Math.min(value.pageSize, rowsFiltered - (page.page - 1) * value.pageSize))
    || value.rowsTotal !== undefined && (!integer(value.rowsTotal) || value.rowsTotal < rowsFiltered)) {
    throw new Error("HST snapshot pagination totals are invalid");
  }
  return { pages, pageSize: value.pageSize, pageCount: value.pageCount, rowCount: value.rowCount, rowsFiltered,
    ...(value.rowsTotal !== undefined ? { rowsTotal: value.rowsTotal } : {}), query: value.query };
}

/** A composite preserves a complete historical input plus explicitly selected fresh pages. */
export async function loadHstSnapshot(root: string, manifestPath: string, sha256: string, requireScope = false): Promise<HstSnapshotPlan> {
  const bytes = await readFile(path.join(root, relative(manifestPath)));
  if (digest(bytes) !== sha256) throw new Error("HST snapshot manifest SHA-256 does not match its lock");
  const value = JSON.parse(bytes.toString("utf8")) as Document;
  identity(value);
  const manifestFile = { path: manifestPath, sha256, sizeBytes: bytes.length };
  if (value.schemaVersion === 1) {
    const input = batch(value, "", false, requireScope);
    return { capturedAt: value.capturedAt, rowCount: value.rowCount, files: [manifestFile, ...input.pages],
      batches: [input], partialRefresh: false, supplementRows: 0 };
  }
  if (value.schemaVersion !== 2 || value.refreshMode !== "bounded-supplement" || !integer(value.rowCount)
    || !value.baseline || !value.supplement || !/^[a-f0-9]{64}$/.test(value.baseline.sha256)
    || !integer(value.baseline.sizeBytes)) throw new Error("HST snapshot manifest has an unsupported composite schema");
  const baselineRoot = relative(value.baseline.root);
  const baselinePath = join(baselineRoot, value.baseline.manifest);
  const baselineBytes = await readFile(path.join(root, baselinePath));
  if (baselineBytes.length !== value.baseline.sizeBytes || digest(baselineBytes) !== value.baseline.sha256) throw new Error("HST baseline manifest failed its locked size or SHA-256");
  const baseline = JSON.parse(baselineBytes.toString("utf8")) as Document;
  identity(baseline);
  if (baseline.schemaVersion !== 1) throw new Error("HST composite baseline must be a locked version 1 snapshot");
  const original = batch(baseline, baselineRoot, false, true);
  if (!Number.isFinite(Date.parse(value.supplement.capturedAt)) || value.supplement.capturedAt !== value.capturedAt
    || Date.parse(value.capturedAt) < Date.parse(baseline.capturedAt)) throw new Error("HST supplement capture date precedes or disagrees with its baseline");
  const supplement = batch(value.supplement, "", true, true);
  if (value.rowCount !== original.rowCount + supplement.rowCount) throw new Error("HST composite row count disagrees with its inputs");
  const files = [manifestFile, { path: baselinePath, sha256: value.baseline.sha256, sizeBytes: baselineBytes.length }, ...original.pages, ...supplement.pages];
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("HST composite reuses an input path");
  return { capturedAt: value.capturedAt, rowCount: value.rowCount, files, batches: [original, supplement], partialRefresh: true,
    baselineSnapshotSha256: value.baseline.sha256, baselineCapturedAt: baseline.capturedAt, supplementRows: supplement.rowCount };
}

export async function* hstSnapshotRows(root: string, plan: HstSnapshotPlan): AsyncGenerator<Record<string, unknown>[]> {
  for (const input of plan.batches) {
    let rowsTotal: number | undefined;
    for (const expected of input.pages) {
      const bytes = await readFile(path.join(root, relative(expected.path)));
      if (bytes.length !== expected.sizeBytes || digest(bytes) !== expected.sha256) throw new Error(`HST snapshot page ${expected.page} failed its locked size or SHA-256`);
      const response = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8")) as Document;
      const paging = response.paging;
      const data = parseHstMetadataRows(response) as Record<string, unknown>[];
      if (response.status !== "COMPLETE" || paging?.page !== expected.page || paging.pageSize !== input.pageSize
        || paging.pagesFiltered !== input.pageCount || paging.rowsFiltered !== input.rowsFiltered
        || paging.rows !== expected.rows || data.length !== expected.rows || !integer(paging.rowsTotal) || paging.rowsTotal < input.rowsFiltered
        || rowsTotal !== undefined && paging.rowsTotal !== rowsTotal
        || input.rowsTotal !== undefined && paging.rowsTotal !== input.rowsTotal) throw new Error(`HST snapshot page ${expected.page} pagination or row count is inconsistent`);
      rowsTotal = paging.rowsTotal;
      if (input.query) {
        const allowed = new Set(String(input.query.columns).split(",").map(column => column.trim()));
        for (const row of data) if (row.obs_collection !== "HST" || row.dataproduct_type !== "image" || row.dataRights !== "PUBLIC"
          || !row.obsid || Object.keys(row).some(key => !allowed.has(key))) throw new Error("HST pages must contain only public image observation metadata");
      }
      yield data;
    }
  }
}
