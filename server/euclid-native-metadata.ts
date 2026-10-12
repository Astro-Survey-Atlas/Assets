import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { nativeEvidencePath, type NativeSource } from "./native-unit-model.js";

type Document = Record<string, any>;

export function csvRecords(text: string): Document[] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(field.replace(/\r$/, "")); field = "";
      if (char === "\n") { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += char;
  }
  if (quoted) throw new Error("Truncated Euclid CSV metadata");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const columns = rows.shift();
  if (!columns?.length || new Set(columns).size !== columns.length) throw new Error("Invalid Euclid CSV columns");
  return rows.map(values => {
    if (values.length !== columns.length) throw new Error("Euclid CSV row does not match its columns");
    return Object.fromEntries(columns.map((key, index) => [key, values[index]]));
  });
}

export function polygonCoordinates(region: string): { frame: string; points: number[] } {
  const tokens = region.trim().split(/\s+/);
  const points = tokens.slice(2).map(Number);
  if (tokens[0]?.toUpperCase() !== "POLYGON" || !["ICRS", "J2000"].includes(tokens[1]?.toUpperCase() ?? "")
    || points.length < 6 || points.length % 2 || points.some((n, i) => !Number.isFinite(n) || (i % 2 ? n < -90 || n > 90 : n < 0 || n >= 360))) {
    throw new Error("Unsupported Euclid source polygon");
  }
  return { frame: tokens[1]!.toUpperCase(), points };
}

export function validateEuclidManifest(manifest: Document, source: NativeSource): void {
  const q1 = source.id === "euclid-q1-calibrated-frames" && source.releaseId === "euclid-q1";
  const q2 = source.id === "euclid-q2-egbs-quadrants" && source.releaseId === "euclid-q2";
  if ((!q1 && !q2) || source.surveyId !== "euclid" || manifest.sourceId !== source.id
    || manifest.deliveryClass !== "evidence" || manifest.inventoryComplete !== false || manifest.queryPagesComplete !== true
    || manifest.scope?.geometryPrecision !== "estimated" || manifest.scope?.scienceFileScan !== "not-scanned"
    || manifest.scope?.validPixelMasksChecked !== false) throw new Error("Euclid metadata must preserve its release, estimated frame scope and science-payload boundary");
  if (q1) {
    const pages = manifest.sourcePagination?.pages;
    if (manifest.scope.release !== "Q1_R1" || manifest.scope.table !== "q1.calibrated_frame"
      || manifest.sourcePagination?.queryPagesComplete !== true
      || !Array.isArray(pages) || !pages.length || pages.at(-1)?.rows !== 0
      || pages.reduce((sum: number, page: Document) => sum + page.rows, 0) !== manifest.rowCount
      || manifest.sourcePagination.expectedRowCount !== manifest.rowCount
      || pages.some((page: Document, i: number) => page.page !== i + 1 || page.status !== 200
        || !Number.isSafeInteger(page.rows) || page.rows < 0 || page.rows > 500
        || !String(page.query).includes("FROM q1.calibrated_frame WHERE data_set_release = 'Q1_R1' AND calibrated_frame_oid > ")
        || !manifest.metadataDocuments.some((file: Document) => file.ref === page.ref && file.sha256 === page.sha256))) {
      throw new Error("Q1 import must retain complete, ordered archive metadata pages and source count");
    }
  } else if (manifest.rowCount !== 20736 || manifest.scope.observationId !== "067070" || manifest.scope.exposureCount !== 144
    || manifest.scope.processingRelease !== "EGBS-v1" || manifest.scope.psfCalibrationIncluded !== false) {
    throw new Error("Q2 import must retain the 144 science exposures and their 20,736 SCI quadrants");
  }
}

export function validateEuclidRow(row: Document, source: NativeSource): void {
  const metadata = row.sourceMetadata;
  if (!metadata || metadata.coordinateFrame !== "ICRS" || metadata.geometryPrecision !== "estimated"
    || metadata.scienceFileScan !== "not-scanned" || metadata.validPixelMasksChecked !== false
    || polygonCoordinates(String(row.sRegion)).frame !== "ICRS" || !Array.isArray(row.bands) || row.bands.length !== 1) {
    throw new Error("Euclid row lacks its own ICRS frame evidence and payload limits");
  }
  if (source.releaseId === "euclid-q1") {
    const band = ({ VIS: "VIS", NIR_Y: "Y", NIR_J: "J", NIR_H: "H" } as Record<string, string>)[metadata.filter_name];
    if (metadata.data_set_release !== "Q1_R1" || !/^\d+$/.test(metadata.calibrated_frame_oid ?? "")
      || !/^\d+$/.test(metadata.observation_id ?? "") || !["VIS", "NISP"].includes(metadata.instrument_name)
      || row.unitId !== `Q1_R1:calibrated-frame:${metadata.calibrated_frame_oid}`
      || row.filename !== metadata.file_name || !/^EUC_[A-Za-z0-9_.+-]+\.fits$/.test(row.filename)
      || row.instrument !== metadata.instrument_name || !band || row.bands[0] !== band
      || !metadata.file_path?.startsWith("/euclid/") || !metadata.datalabs_path?.startsWith("/data/euclid_q1/")) {
      throw new Error("Q1 calibrated frame cannot be relabelled as a Tile or unrelated release");
    }
    const raw = polygonCoordinates(metadata.stc_s), actual = polygonCoordinates(row.sRegion);
    if (raw.points.length !== actual.points.length || raw.points.some((coordinate, i) => {
      const difference = Math.abs(coordinate - actual.points[i]!);
      return (i % 2 ? difference : Math.min(difference, 360 - difference)) > 0.0001;
    })) throw new Error("Normalized Q1 geometry disagrees with its original J2000/ICRS frame");
  } else {
    if (metadata.observationId !== "067070" || metadata.processingRelease !== "EGBS-v1"
      || !Number.isSafeInteger(metadata.dither) || metadata.dither < 0 || metadata.dither > 143
      || !/^[1-6]-[1-6]\.[EFGH]\.SCI$/.test(metadata.extname ?? "") || row.bands[0] !== "VIS"
      || row.unitId !== `EGBS-v1:VIS:067070:${metadata.dither}:1:${metadata.extname}`
      || !/^[a-f0-9]{64}$/.test(metadata.headerSha256 ?? "")) throw new Error("Q2 identity must retain its source EXTNAME and science exposure");
  }
}

/** Lock normalized Q1 rows back to every original archive CSV row, not just a count. */
export async function verifyEuclidRawRows(root: string, ref: string, manifest: Document): Promise<void> {
  if (manifest.releaseId !== "euclid-q1") return;
  const countDocument = manifest.metadataDocuments.find((document: Document) => document.ref === "metadata/count.csv");
  if (!countDocument) throw new Error("Q1 manifest omits the official archive row count");
  const countBytes = await readFile(nativeEvidencePath(root, path.posix.join(path.posix.dirname(ref), countDocument.ref)));
  if (createHash("sha256").update(countBytes).digest("hex") !== countDocument.sha256) throw new Error("Q1 archive row count SHA changed");
  const countRows = csvRecords(countBytes.toString("utf8"));
  if (countRows.length !== 1 || !/^\d+$/.test(countRows[0]?.total ?? "") || Number(countRows[0]!.total) !== manifest.rowCount) {
    throw new Error("Q1 pages do not match the official archive row count");
  }
  const originals = new Map<string, { row: Document; ref: string; sha256: string }>();
  let previous = -1;
  for (const page of manifest.sourcePagination.pages as Document[]) {
    const file = path.posix.join(path.posix.dirname(ref), page.ref);
    const body = await readFile(nativeEvidencePath(root, file));
    if (createHash("sha256").update(body).digest("hex") !== page.sha256 || page.after !== previous) throw new Error("Q1 source page chain or SHA changed");
    const records = csvRecords(body.toString("utf8"));
    if (records.length !== page.rows) throw new Error("Q1 page receipt differs from raw archive rows");
    for (const row of records) {
      const oid = Number(row.calibrated_frame_oid);
      if (!Number.isSafeInteger(oid) || oid <= previous || originals.has(row.calibrated_frame_oid)) throw new Error("Q1 archive page identity is duplicated or unordered");
      previous = oid;
      originals.set(row.calibrated_frame_oid, { row, ref: page.ref, sha256: page.sha256 });
    }
  }
  if (originals.size !== manifest.rowCount) throw new Error("Q1 raw page inventory is incomplete");
  for (const file of manifest.rowFiles as Document[]) {
    const bytes = await readFile(nativeEvidencePath(root, path.posix.join(path.posix.dirname(ref), file.ref)));
    const contents = file.ref.endsWith(".gz") ? gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }) : bytes;
    for (const line of contents.toString("utf8").split("\n").filter(Boolean)) {
      const normalized = JSON.parse(line) as Document, metadata = normalized.sourceMetadata;
      const original = originals.get(metadata?.calibrated_frame_oid);
      if (!original || metadata.metadataRef !== original.ref || metadata.metadataSha256 !== original.sha256
        || Object.keys(original.row).some(key => metadata[key] !== original.row[key])) throw new Error("Q1 normalized row is not supported by its locked archive page");
      originals.delete(metadata.calibrated_frame_oid);
    }
  }
  if (originals.size) throw new Error("Q1 normalized rows omit source-listed frames");
}
