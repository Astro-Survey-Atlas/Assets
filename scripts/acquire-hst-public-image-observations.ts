import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const SOURCE_URL = "https://mast.stsci.edu/api/v0/invoke";
const SERVICE = "Mast.Caom.Filtered";
const PAGE_SIZE = 2000;
const COLUMNS = "obsid,obs_collection,dataproduct_type,proposal_id,target_name,instrument_name,filters,t_min,t_max,s_region,dataRights";
const FILTERS = [
  { paramName: "obs_collection", values: ["HST"] },
  { paramName: "dataproduct_type", values: ["image"] },
  { paramName: "dataRights", values: ["PUBLIC"] },
];

interface MastaPage {
  status: string;
  paging: { page: number; pageSize: number; pagesFiltered: number; rows: number; rowsFiltered: number; rowsTotal: number };
  data: unknown[];
}

interface LockedPage {
  page: number;
  path: string;
  sha256: string;
  sizeBytes: number;
  rows: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseHstMetadataRows(response: Record<string, unknown>): unknown[] {
  if (Array.isArray(response.data)) return response.data;
  const tables = response.Tables;
  const table = Array.isArray(tables) ? tables[0] as Record<string, unknown> | undefined : undefined;
  if (!Array.isArray(table?.Columns) || !Array.isArray(table.Rows)) throw new Error("MAST response contains no data rows");
  const columns = table.Columns.map((column) => (column as Record<string, unknown>)?.dataIndex);
  if (!columns.length || columns.some((column) => typeof column !== "string")) throw new Error("MAST response has invalid table columns");
  return table.Rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error("MAST table row has an unexpected width");
    return Object.fromEntries(columns.map((column, index) => [column as string, row[index]]));
  });
}

function parsePage(bytes: Uint8Array, page: number, pageSize: number): MastaPage {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  const paging = value.paging as Record<string, unknown> | undefined;
  const data = parseHstMetadataRows(value);
  const parsed: MastaPage = {
    status: String(value.status ?? ""),
    paging: {
      page: Number(paging?.page),
      pageSize: Number(paging?.pageSize),
      pagesFiltered: Number(paging?.pagesFiltered),
      rows: Number(paging?.rows),
      rowsFiltered: Number(paging?.rowsFiltered),
      rowsTotal: Number(paging?.rowsTotal),
    },
    data,
  };
  if (parsed.status.toUpperCase() !== "COMPLETE" || parsed.paging.page !== page
    || parsed.paging.pageSize !== pageSize || parsed.paging.pagesFiltered < 1
    || parsed.paging.rows !== data.length || parsed.paging.rowsFiltered < data.length) {
    throw new Error(`MAST returned an incomplete or inconsistent response for page ${page}`);
  }
  return parsed;
}

function pageFilename(page: number): string {
  return `page-${String(page).padStart(6, "0")}.json.gz`;
}

async function cachedPage(directory: string, page: number, pageSize: number): Promise<{ bytes: Buffer; parsed: MastaPage } | undefined> {
  const filePath = path.join(directory, pageFilename(page));
  try {
    const bytes = await readFile(filePath);
    const parsed = parsePage(gunzipSync(bytes), page, pageSize);
    return { bytes, parsed };
  } catch {
    return undefined;
  }
}

async function fetchPage(page: number, pageSize: number): Promise<{ raw: Buffer; parsed: MastaPage }> {
  const request = { service: SERVICE, params: { columns: COLUMNS, filters: FILTERS }, format: "json", pagesize: pageSize, page };
  const url = new URL(SOURCE_URL);
  url.searchParams.set("request", JSON.stringify(request));
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`MAST returned HTTP ${response.status} for page ${page}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length > 16 * 1024 * 1024) throw new Error(`MAST page ${page} exceeded the 16 MiB response limit`);
  return { raw, parsed: parsePage(raw, page, pageSize) };
}

async function storePage(directory: string, page: number, raw: Buffer, parsed: MastaPage): Promise<LockedPage> {
  const relativePath = `source-units/hst-public-image-pages/${pageFilename(page)}`;
  const compressed = gzipSync(raw, { level: 6 });
  const destination = path.join(directory, pageFilename(page));
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, compressed, { mode: 0o600 });
  await rename(temporary, destination);
  return { page, path: relativePath, sha256: sha256(compressed), sizeBytes: compressed.length, rows: parsed.data.length };
}

async function main(): Promise<void> {
  const outputArg = process.argv.slice(2).find((argument) => argument.startsWith("--output="))?.slice("--output=".length);
  const concurrencyArg = process.argv.slice(2).find((argument) => argument.startsWith("--concurrency="))?.slice("--concurrency=".length);
  const pageSizeArg = process.argv.slice(2).find((argument) => argument.startsWith("--page-size="))?.slice("--page-size=".length);
  const outputRoot = path.resolve(outputArg ?? process.env.ASSETS_EVIDENCE_ROOT ?? "/var/lib/assets-evidence");
  await acquireHstPublicImageSnapshot(outputRoot, { concurrency: Number(concurrencyArg ?? 2), pageSize: Number(pageSizeArg ?? PAGE_SIZE) });
}

export async function acquireHstPublicImageSnapshot(outputRoot: string, options: { concurrency?: number; pageSize?: number; progress?: (message: string) => void } = {}): Promise<void> {
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency ?? 2)));
  const pageSize = Math.max(1, Math.min(2000, Number(options.pageSize ?? PAGE_SIZE)));
  if (!Number.isSafeInteger(concurrency) || !Number.isSafeInteger(pageSize)) throw new Error("concurrency and page-size must be integers");
  const directory = path.join(outputRoot, "source-units/hst-public-image-pages");
  const manifestPath = path.join(directory, "manifest.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const firstCached = await cachedPage(directory, 1, pageSize);
  const first = firstCached
    ? { kind: "cached" as const, bytes: firstCached.bytes, parsed: firstCached.parsed }
    : { kind: "fresh" as const, ...await fetchPage(1, pageSize) };
  const baseline = first.parsed.paging;
  if (!Number.isSafeInteger(baseline.pagesFiltered) || !Number.isSafeInteger(baseline.rowsFiltered)
    || baseline.pagesFiltered < 1 || baseline.rowsFiltered < 1) throw new Error("MAST did not report a complete filtered page count");
  const pageRecords = new Map<number, LockedPage>();
  if (first.kind === "cached") {
    const sizeBytes = (await stat(path.join(directory, pageFilename(1)))).size;
    pageRecords.set(1, { page: 1, path: `source-units/hst-public-image-pages/${pageFilename(1)}`, sha256: sha256(first.bytes), sizeBytes, rows: first.parsed.data.length });
  } else pageRecords.set(1, await storePage(directory, 1, first.raw, first.parsed));

  let nextPage = 2;
  let completed = 1;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(0, baseline.pagesFiltered - 1)) }, async () => {
    while (true) {
      const page = nextPage++;
      if (page > baseline.pagesFiltered) return;
      const cached = await cachedPage(directory, page, pageSize);
      const fresh = cached ? undefined : await fetchPage(page, pageSize);
      const parsed = cached?.parsed ?? fresh!.parsed;
      const paging = parsed.paging;
      if (paging.pagesFiltered !== baseline.pagesFiltered || paging.rowsFiltered !== baseline.rowsFiltered
        || paging.rowsTotal !== baseline.rowsTotal) throw new Error(`MAST pagination totals changed on page ${page}`);
      pageRecords.set(page, cached
        ? { page, path: `source-units/hst-public-image-pages/${pageFilename(page)}`, sha256: sha256(cached.bytes), sizeBytes: cached.bytes.length, rows: cached.parsed.data.length }
        : await storePage(directory, page, fresh!.raw, parsed));
      completed += 1;
      if (completed % 25 === 0 || completed === baseline.pagesFiltered) {
        const message = `HST metadata pages ${completed}/${baseline.pagesFiltered}; rowsFiltered=${baseline.rowsFiltered}`;
        if (options.progress) options.progress(message); else console.info(message);
      }
    }
  });
  await Promise.all(workers);

  const pages = [...pageRecords.values()].sort((left, right) => left.page - right.page);
  const rowCount = pages.reduce((sum, page) => sum + page.rows, 0);
  if (pages.length !== baseline.pagesFiltered || rowCount !== baseline.rowsFiltered) {
    throw new Error(`HST snapshot is incomplete: ${pages.length} pages and ${rowCount} rows`);
  }
  const manifest = {
    schemaVersion: 1,
    kind: "mast-hst-public-image-observations",
    sourceUrl: SOURCE_URL,
    service: SERVICE,
    capturedAt: new Date().toISOString(),
    query: { columns: COLUMNS, filters: FILTERS, coordinateFrame: "ICRS", spatialColumn: "s_region" },
    pageSize,
    pageCount: pages.length,
    rowCount,
    rowsTotal: baseline.rowsTotal,
    pages,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const temporary = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, manifestPath);
  console.info(`HST public image metadata snapshot: ${rowCount} rows, ${pages.length} pages, manifest sha256=${sha256(bytes)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
