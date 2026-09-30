import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ArtifactStore } from "./artifact-store.js";
import type { DownloadPlan } from "./evidence-store.js";
import { AccessError } from "./region-access.js";
import { reversePlanItems, type ReverseCursorScope } from "./reverse-pagination.js";

export interface ReverseSnapshot {
  schemaVersion: 1;
  identity: string;
  fingerprint: string;
  expiresAt: string;
  response: Record<string, unknown> & { downloadPlan: DownloadPlan };
  previewPlan: DownloadPlan;
}

interface SnapshotCursor { snapshotId: string; identity: string; fingerprint: string; scope: ReverseCursorScope; offset: number; skipKeys: string[] }
const keyFor = (id: string): string => `reverse-lookups/${id}.json`;

export async function writeReverseSnapshot(store: ArtifactStore, snapshot: ReverseSnapshot): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (bytes.length > 64 * 1024 * 1024) throw new AccessError(413, "Reverse lookup snapshot is too large; select a smaller region");
  const id = createHash("sha256").update(bytes).digest("hex");
  await store.putImmutable(keyFor(id), bytes, { contentType: "application/json", metadata: { deliveryClass: "evidence" } });
  return id;
}

export async function readReverseSnapshot(store: ArtifactStore, id: unknown, identity: string, fingerprint: string): Promise<ReverseSnapshot> {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new AccessError(400, "Invalid query snapshot ID");
  const object = await store.get(keyFor(id));
  if (!object) throw new AccessError(410, "Reverse lookup snapshot expired; repeat the region query");
  const snapshot = JSON.parse(object.body.toString("utf8")) as ReverseSnapshot;
  if (snapshot.schemaVersion !== 1 || snapshot.fingerprint !== fingerprint) throw new AccessError(409, "Reverse lookup region or coverage revision changed");
  if (snapshot.identity !== "preview" && snapshot.identity !== identity) throw new AccessError(403, "Reverse lookup snapshot belongs to another access session");
  if (Date.parse(snapshot.expiresAt) <= Date.now()) throw new AccessError(410, "Reverse lookup snapshot expired; repeat the region query");
  return snapshot;
}

function encodeCursor(payload: SnapshotCursor, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `rs2.${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function decodeSnapshotCursor(value: unknown, identity: string, fingerprint: string, scope: ReverseCursorScope, secret: string): SnapshotCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 8192) throw new AccessError(400, "Invalid reverse lookup cursor");
  const [version, body, signature, extra] = value.split(".");
  const expected = createHmac("sha256", secret).update(body ?? "").digest("base64url");
  if (version !== "rs2" || !body || !signature || extra || signature.length !== expected.length
    || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new AccessError(400, "Invalid reverse lookup cursor");
  let cursor: SnapshotCursor;
  try { cursor = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { throw new AccessError(400, "Invalid reverse lookup cursor"); }
  if (cursor.fingerprint !== fingerprint || cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
    || !/^[a-f0-9]{64}$/.test(cursor.snapshotId) || !Array.isArray(cursor.skipKeys) || cursor.skipKeys.length > 6
    || cursor.skipKeys.some((key) => typeof key !== "string" || key.length > 517)) throw new AccessError(400, "Reverse lookup cursor does not match this query");
  if (cursor.identity !== "preview" && cursor.identity !== identity) throw new AccessError(403, "Reverse lookup cursor belongs to another access session");
  return cursor;
}

export function snapshotPage(snapshot: ReverseSnapshot, snapshotId: string, identity: string, secret: string, options: { preview?: boolean; scope: ReverseCursorScope; pageSize: number; cursor?: SnapshotCursor }): Record<string, unknown> {
  const plan = snapshot.response.downloadPlan;
  const items = reversePlanItems(plan);
  const scopeItems = (scope: ReverseCursorScope) => items.filter((item) => scope === "manifest" || (scope === "spatial-units" ? item.kind === "spatial-unit" : item.kind !== "spatial-unit"));
  const previewKeys = reversePlanItems(snapshot.previewPlan).map((item) => item.key);
  const skipKeys = options.cursor?.skipKeys ?? [];
  const remaining = scopeItems(options.scope).filter((item) => !skipKeys.includes(item.key));
  const offset = options.cursor?.offset ?? 0;
  const selected = options.preview ? reversePlanItems(snapshot.previewPlan) : remaining.slice(offset, offset + options.pageSize);
  const hasMore = options.preview ? items.length > selected.length : remaining.length > offset + selected.length;
  const cursorFor = (scope: ReverseCursorScope, offset: number, skip: string[]): string => encodeCursor({ snapshotId,
    identity: options.preview ? "preview" : identity, fingerprint: snapshot.fingerprint, scope, offset, skipKeys: skip }, secret);
  const page = { pageSize: options.pageSize, shown: selected.length, omitted: options.preview ? items.length - selected.length : Math.max(0, remaining.length - offset - selected.length), hasMore,
    ...(hasMore ? { nextCursor: cursorFor(options.scope, options.preview ? 0 : offset + selected.length, options.preview ? previewKeys : skipKeys) } : {}) };
  const scopedPreview = (scope: ReverseCursorScope) => {
    const shown = selected.filter((item) => scope === "spatial-units" ? item.kind === "spatial-unit" : item.kind !== "spatial-unit");
    const hasMore = scopeItems(scope).length > shown.length;
    return { pageSize: options.pageSize, shown: shown.length, hasMore, ...(hasMore ? { nextCursor: cursorFor(scope, 0, shown.map((item) => item.key)) } : {}) };
  };
  const responsePlan: DownloadPlan = options.preview ? snapshot.previewPlan : { ...plan,
    spatialUnits: selected.flatMap((item) => item.kind === "spatial-unit" ? [item.value] : []),
    files: selected.flatMap((item) => item.kind === "file" ? [item.value] : []),
    entrypoints: selected.flatMap((item) => item.kind === "entrypoint" ? [item.value] : []),
    coverageEvidence: selected.flatMap((item) => item.kind === "coverage-evidence" ? [item.value] : []),
    tileSelections: undefined, truncated: plan.truncated || hasMore };
  return { ...snapshot.response, downloadPlan: responsePlan, truncated: responsePlan.truncated,
    querySnapshot: { id: snapshotId, expiresAt: snapshot.expiresAt, queryExhausted: !plan.truncated, inventoryComplete: false },
    expiresAt: snapshot.expiresAt,
    ...(options.preview ? { preview: { limit: options.pageSize, shown: page.shown, omitted: page.omitted, hasMore } } : {}),
    ...(options.scope === "manifest" ? { page } : {}),
    ...(options.preview ? { spatialPage: scopedPreview("spatial-units"), supportingPage: scopedPreview("supporting-evidence") }
      : options.scope === "spatial-units" ? { spatialPage: page } : options.scope === "supporting-evidence" ? { supportingPage: page } : {}),
    edges: [], sourceFiles: [] };
}
