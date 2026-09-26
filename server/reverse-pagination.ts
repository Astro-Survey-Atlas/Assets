import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { DownloadPlan, DownloadPlanCoverageEvidence, DownloadPlanEntrypoint } from "./evidence-store.js";
import { AccessError } from "./region-access.js";

export const REVERSE_PAGE_SIZE = 20;
export const REVERSE_PAGE_SIZE_MAX = 100;
export const REVERSE_CURSOR_MAX_BYTES = 1_048_576;
export const REVERSE_CURSOR_MAX_KEYS = 10_000;
export const REVERSE_CURSOR_MAX_KEY_LENGTH = 517;

export interface ReverseCursorPayload {
  version: 1;
  identity: string;
  fingerprint: string;
  seenKeys: string[];
}

export type ReversePlanItem =
  | { key: string; kind: "file"; value: DownloadPlan["files"][number] }
  | { key: string; kind: "entrypoint"; value: DownloadPlanEntrypoint }
  | { key: string; kind: "coverage-evidence"; value: DownloadPlanCoverageEvidence };

export function reversePlanFileKey(file: DownloadPlan["files"][number]): string {
  return `file:${file.fileId}`;
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

export function reversePlanItems(plan: DownloadPlan): ReversePlanItem[] {
  return [
    ...plan.files.map((value) => ({ key: reversePlanFileKey(value), kind: "file" as const, value })),
    ...plan.entrypoints.map((value) => ({ key: reversePlanEntrypointKey(value), kind: "entrypoint" as const, value })),
    ...(plan.coverageEvidence ?? []).map((value) => ({ key: reversePlanCoverageEvidenceKey(value), kind: "coverage-evidence" as const, value })),
  ];
}

export function encodeReverseCursor(payload: ReverseCursorPayload, secret: string): string {
  if (!Array.isArray(payload.seenKeys)) throw new AccessError(400, "Invalid reverse lookup cursor payload");
  const seenKeys = [...new Set(payload.seenKeys)];
  if (payload.version !== 1 || typeof payload.identity !== "string" || typeof payload.fingerprint !== "string"
    || seenKeys.length > REVERSE_CURSOR_MAX_KEYS
    || seenKeys.some((key) => typeof key !== "string" || key.length > REVERSE_CURSOR_MAX_KEY_LENGTH)) {
    throw new AccessError(400, "Invalid reverse lookup cursor payload");
  }
  const normalized = { ...payload, seenKeys };
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  const cursor = `${encoded}.${signature}`;
  if (cursor.length > REVERSE_CURSOR_MAX_BYTES) throw new AccessError(400, "Reverse lookup cursor exceeds the size limit");
  return cursor;
}

export function decodeReverseCursor(value: unknown, identity: string, fingerprint: string, secret: string): ReverseCursorPayload | undefined {
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
  if (payload.version !== 1 || typeof payload.fingerprint !== "string" || payload.fingerprint !== fingerprint
    || typeof payload.identity !== "string" || !Array.isArray(payload.seenKeys)
    || payload.seenKeys.length > REVERSE_CURSOR_MAX_KEYS || payload.seenKeys.some((key) => typeof key !== "string" || key.length > REVERSE_CURSOR_MAX_KEY_LENGTH)) {
    throw new AccessError(400, "Reverse lookup cursor does not match this query");
  }
  if (payload.identity !== "preview" && payload.identity !== identity) throw new AccessError(403, "Reverse lookup cursor belongs to another access session");
  return { version: 1, identity: payload.identity, fingerprint: payload.fingerprint, seenKeys: [...new Set(payload.seenKeys)] };
}

export function reversePageSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > REVERSE_PAGE_SIZE_MAX) throw new AccessError(400, `pageSize must be 1-${REVERSE_PAGE_SIZE_MAX}`);
  return Number(value);
}

export function pageReversePlan(plan: DownloadPlan, seenKeys: ReadonlySet<string>, pageSize: number): { plan: DownloadPlan; keys: string[]; hasMore: boolean } {
  const items = reversePlanItems(plan);
  const remaining = items.filter((item) => !seenKeys.has(item.key));
  const pageItems = remaining.slice(0, pageSize);
  const keys = [...seenKeys, ...pageItems.map((item) => item.key)];
  return {
    keys: [...new Set(keys)],
    hasMore: remaining.length > pageItems.length,
    plan: {
      ...plan,
      files: pageItems.filter((item): item is Extract<ReversePlanItem, { kind: "file" }> => item.kind === "file").map((item) => item.value),
      entrypoints: pageItems.filter((item): item is Extract<ReversePlanItem, { kind: "entrypoint" }> => item.kind === "entrypoint").map((item) => item.value),
      coverageEvidence: pageItems.filter((item): item is Extract<ReversePlanItem, { kind: "coverage-evidence" }> => item.kind === "coverage-evidence").map((item) => item.value),
      tileSelections: undefined,
      truncated: plan.truncated || remaining.length > pageItems.length,
    },
  };
}
