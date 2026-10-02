import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DownloadPlan, DownloadPlanCoverageEvidence, DownloadPlanEntrypoint, DownloadPlanSpatialUnit } from "./evidence-store.js";
import { AccessError } from "./region-access.js";

export const REVERSE_PAGE_SIZE = 30;
export const REVERSE_PAGE_SIZE_MAX = 100;
export const REVERSE_CURSOR_MAX_BYTES = 1_048_576;
export const REVERSE_CURSOR_MAX_KEYS = 10_000;
export const REVERSE_CURSOR_MAX_KEY_LENGTH = 517;

export type ReverseCursorScope = "manifest" | "spatial-units" | "supporting-evidence";

export interface ReverseCursorPayload {
  version: 1;
  identity: string;
  fingerprint: string;
  scope?: ReverseCursorScope;
  seenKeys: string[];
}

export type ReversePlanItem =
  | { key: string; kind: "spatial-unit"; value: DownloadPlanSpatialUnit }
  | { key: string; kind: "file"; value: DownloadPlan["files"][number] }
  | { key: string; kind: "entrypoint"; value: DownloadPlanEntrypoint }
  | { key: string; kind: "coverage-evidence"; value: DownloadPlanCoverageEvidence };

export function reversePlanFileKey(file: DownloadPlan["files"][number]): string {
  return `file:${file.fileId}`;
}

export function reversePlanSpatialUnitKey(unit: DownloadPlanSpatialUnit): string {
  const identity = `${unit.layerId}:${unit.unitKind}:${unit.unitId}`;
  return `unit:${createHash("sha256").update(identity).digest("hex")}`;
}

export function reversePlanEntrypointKey(entry: DownloadPlanEntrypoint): string {
  const identity = [
    "entry",
    entry.kind,
    entry.layerId ?? "",
    entry.tileId ?? "",
    entry.url ?? entry.sourceUri ?? entry.sourceUrl ?? entry.mocUrl ?? "",
    entry.product ?? entry.productId ?? "",
  ];
  return `entry:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function reversePlanCoverageEvidenceKey(evidence: DownloadPlanCoverageEvidence): string {
  const identity = `${evidence.layerId}:${evidence.order}`;
  return `coverage:${createHash("sha256").update(identity).digest("hex")}`;
}

/** Keep every matched survey visible before filling a page with its next units. */
export function interleaveSpatialUnitsBySurvey(units: readonly DownloadPlanSpatialUnit[]): DownloadPlanSpatialUnit[] {
  const groups = new Map<string, DownloadPlanSpatialUnit[]>();
  for (const unit of units) {
    const group = groups.get(unit.surveyId);
    if (group) group.push(unit);
    else groups.set(unit.surveyId, [unit]);
  }
  let active = [...groups.values()];
  const result: DownloadPlanSpatialUnit[] = [];
  for (let index = 0; active.length; index++) {
    const next: DownloadPlanSpatialUnit[][] = [];
    for (const group of active) {
      result.push(group[index]!);
      if (index + 1 < group.length) next.push(group);
    }
    active = next;
  }
  return result;
}

export function reversePlanItems(plan: DownloadPlan): ReversePlanItem[] {
  return [
    ...(plan.spatialUnits ?? []).map((value) => ({ key: reversePlanSpatialUnitKey(value), kind: "spatial-unit" as const, value })),
    ...plan.files.map((value) => ({ key: reversePlanFileKey(value), kind: "file" as const, value })),
    ...plan.entrypoints.map((value) => ({ key: reversePlanEntrypointKey(value), kind: "entrypoint" as const, value })),
    ...(plan.coverageEvidence ?? []).map((value) => ({ key: reversePlanCoverageEvidenceKey(value), kind: "coverage-evidence" as const, value })),
  ];
}

export function encodeReverseCursor(payload: ReverseCursorPayload, secret: string): string {
  if (!Array.isArray(payload.seenKeys)) throw new AccessError(400, "Invalid reverse lookup cursor payload");
  const seenKeys = [...new Set(payload.seenKeys)];
  if (payload.version !== 1 || typeof payload.identity !== "string" || typeof payload.fingerprint !== "string"
    || (payload.scope !== undefined && !["manifest", "spatial-units", "supporting-evidence"].includes(payload.scope))
    || seenKeys.length > REVERSE_CURSOR_MAX_KEYS
    || seenKeys.some((key) => typeof key !== "string" || key.length > REVERSE_CURSOR_MAX_KEY_LENGTH)) {
    throw new AccessError(400, "Invalid reverse lookup cursor payload");
  }
  const normalized = { ...payload, scope: payload.scope ?? "manifest", seenKeys };
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  const cursor = `${encoded}.${signature}`;
  if (cursor.length > REVERSE_CURSOR_MAX_BYTES) throw new AccessError(400, "Reverse lookup cursor exceeds the size limit");
  return cursor;
}

export function decodeReverseCursor(value: unknown, identity: string, fingerprint: string, secret: string, scope: ReverseCursorScope = "manifest"): ReverseCursorPayload | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > REVERSE_CURSOR_MAX_BYTES) throw new AccessError(400, "Invalid reverse lookup cursor");
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new AccessError(400, "Invalid reverse lookup cursor");
  const [encoded, signature] = parts as [string, string];
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  if (expectedBytes.length !== signatureBytes.length || !timingSafeEqual(expectedBytes, signatureBytes)) throw new AccessError(400, "Invalid reverse lookup cursor");
  let payload: Partial<ReverseCursorPayload>;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ReverseCursorPayload>; }
  catch { throw new AccessError(400, "Invalid reverse lookup cursor"); }
  const payloadScope = payload.scope ?? "manifest";
  if (payload.version !== 1 || typeof payload.fingerprint !== "string" || payload.fingerprint !== fingerprint
    || typeof payload.identity !== "string" || !Array.isArray(payload.seenKeys)
    || !["manifest", "spatial-units", "supporting-evidence"].includes(String(payloadScope)) || payloadScope !== scope
    || payload.seenKeys.length > REVERSE_CURSOR_MAX_KEYS || payload.seenKeys.some((key) => typeof key !== "string" || key.length > REVERSE_CURSOR_MAX_KEY_LENGTH)) {
    throw new AccessError(400, "Reverse lookup cursor does not match this query");
  }
  if (payload.identity !== "preview" && payload.identity !== identity) throw new AccessError(403, "Reverse lookup cursor belongs to another access session");
  return { version: 1, identity: payload.identity, fingerprint: payload.fingerprint, ...(scope === "manifest" ? {} : { scope }), seenKeys: [...new Set(payload.seenKeys)] };
}

export function reversePageSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > REVERSE_PAGE_SIZE_MAX) throw new AccessError(400, `pageSize must be 1-${REVERSE_PAGE_SIZE_MAX}`);
  return Number(value);
}

export const REVERSE_QUERY_BATCH_MAX_AREA_DEG2 = 100;
export const REVERSE_QUERY_BATCH_MAX_CELLS = 64;

/** Split real NESTED cells into deterministic query regions within the public area limit. */
export function partitionReverseCells(order: number, cells: readonly number[]): number[][] {
  if (!Number.isSafeInteger(order) || order < 0 || order > 13 || !cells.length
    || cells.some((cell) => !Number.isSafeInteger(cell) || cell < 0 || cell >= 12 * 4 ** order)) {
    throw new AccessError(400, "Invalid reverse lookup order or cells");
  }
  const unique = [...new Set(cells)].sort((left, right) => left - right);
  const cellArea = 41252.96124941927 / (12 * 4 ** order);
  if (cellArea > REVERSE_QUERY_BATCH_MAX_AREA_DEG2) {
    throw new AccessError(413, "A single requested HEALPix cell exceeds the 100 square degree query limit");
  }
  const cellsPerBatch = Math.max(1, Math.min(REVERSE_QUERY_BATCH_MAX_CELLS, Math.floor(REVERSE_QUERY_BATCH_MAX_AREA_DEG2 / cellArea + 1e-12)));
  const batches: number[][] = [];
  for (let offset = 0; offset < unique.length; offset += cellsPerBatch) batches.push(unique.slice(offset, offset + cellsPerBatch));
  return batches;
}

export function pageReversePlan(plan: DownloadPlan, seenKeys: ReadonlySet<string>, pageSize: number, scope: ReverseCursorScope = "manifest"): { plan: DownloadPlan; keys: string[]; hasMore: boolean } {
  const items = reversePlanItems(plan).filter((item) => scope === "manifest"
    || (scope === "spatial-units" ? item.kind === "spatial-unit" : item.kind !== "spatial-unit"));
  const remaining = items.filter((item) => !seenKeys.has(item.key));
  const pageItems = remaining.slice(0, pageSize);
  const keys = [...seenKeys, ...pageItems.map((item) => item.key)];
  return {
    keys: [...new Set(keys)],
    hasMore: remaining.length > pageItems.length,
    plan: {
      ...plan,
      spatialUnits: scope === "supporting-evidence" ? [] : pageItems.filter((item): item is Extract<ReversePlanItem, { kind: "spatial-unit" }> => item.kind === "spatial-unit").map((item) => item.value),
      files: scope === "spatial-units" ? [] : pageItems.filter((item): item is Extract<ReversePlanItem, { kind: "file" }> => item.kind === "file").map((item) => item.value),
      entrypoints: scope === "spatial-units" ? [] : pageItems.filter((item): item is Extract<ReversePlanItem, { kind: "entrypoint" }> => item.kind === "entrypoint").map((item) => item.value),
      coverageEvidence: scope === "spatial-units" ? [] : pageItems.filter((item): item is Extract<ReversePlanItem, { kind: "coverage-evidence" }> => item.kind === "coverage-evidence").map((item) => item.value),
      tileSelections: undefined,
      truncated: scope === "manifest" ? plan.truncated || remaining.length > pageItems.length : remaining.length > pageItems.length,
    },
  };
}
