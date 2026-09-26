import { AdminHttpError } from "./admin-error.js";
import { isDeepStrictEqual } from "node:util";

/** The single discovery contract emitted by the Warehouse v2 controller. */
export const MOC_DISCOVERY_POLICY = "cds-public-moc-v2" as const;
export const MOC_DISCOVERY_PROVIDER = "cds" as const;
export const MAST_HST_DISCOVERY_POLICY = "mast-hst-observations-v1" as const;
export const MAST_HST_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface MastHstScopeRef {
  publishedLayerId: string;
  stagedBuildName: string;
  order: number;
  componentIndex: number;
}

export interface MastHstObservationQuery {
  coordinateFrame: "ICRS";
  cone: { raDeg: number; decDeg: number; radiusDeg: number };
  scope: {
    ordering: "NESTED";
    order: number;
    cells: number[];
    q1MocSha256: string;
    hstMocSha256: string;
  };
}

export interface MastHstObservationCandidate {
  obsid: string;
  instrument?: string;
  filters?: string;
}

export interface MastHstObservationSummaryView {
  kind: "mast-hst-observations";
  semantics?: string;
  request: { namespace: string; name: string; uid: string };
  candidates?: MastHstObservationCandidate[];
  candidateCount: number;
  truncated: boolean;
  queryExhausted: boolean;
  snapshot?: { sha256: string; sizeBytes: number };
}

export interface MastHstDiscoveryResource {
  metadata?: { name?: string; namespace?: string; uid?: string; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface ResolvedMastHstObservation {
  request: { namespace: string; name: string; uid: string };
  candidate: MastHstObservationCandidate;
  snapshot: { objectKey: string; sha256: string; sizeBytes: number };
  observationQuery: MastHstObservationQuery;
  candidateCount: number;
  truncated: boolean;
  queryExhausted: boolean;
}

export interface MocCandidateSummary {
  candidateId: string;
  title?: string;
  recordUrl?: string;
  mocUrl?: string;
  hipsUrl?: string;
  [key: string]: unknown;
}

export interface MocReviewSummary {
  schemaVersion: 2;
  truncated: boolean;
  summaryTruncated: boolean;
  searchRecordCount?: number;
  candidates: MocCandidateSummary[];
}

export interface MocDiscoveryCandidate {
  provider: typeof MOC_DISCOVERY_PROVIDER | "llm";
  requestName: string;
  candidate: MocCandidateSummary;
  sourceUrl: string;
  mocUrl?: string;
  hipsUrl?: string;
}

type MocDiscoveryRequestLike = {
  name?: string;
  status?: Record<string, unknown> & { reviewSummary?: unknown };
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function observationQuery(value: unknown): MastHstObservationQuery {
  const query = object(value);
  const cone = object(query?.cone);
  const scope = object(query?.scope);
  const cells = scope?.cells;
  const order = scope?.order;
  const raDeg = cone?.raDeg;
  const decDeg = cone?.decDeg;
  const radiusDeg = cone?.radiusDeg;
  const q1MocSha256 = scope?.q1MocSha256;
  const hstMocSha256 = scope?.hstMocSha256;
  if (query?.coordinateFrame !== "ICRS" || !cone || !scope || scope.ordering !== "NESTED"
    || typeof raDeg !== "number" || !Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360
    || typeof decDeg !== "number" || !Number.isFinite(decDeg) || decDeg < -90 || decDeg > 90
    || typeof radiusDeg !== "number" || !Number.isFinite(radiusDeg) || radiusDeg <= 0 || radiusDeg > 10
    || !Number.isSafeInteger(order) || Number(order) < 4 || Number(order) > 12
    || !Array.isArray(cells) || cells.length < 1 || cells.length > 4096
    || typeof q1MocSha256 !== "string" || !SHA256.test(q1MocSha256)
    || typeof hstMocSha256 !== "string" || !SHA256.test(hstMocSha256)) {
    throw new AdminHttpError(409, "HST observation query is invalid or unsupported");
  }
  const cellLimit = 12 * 4 ** Number(order);
  let previous = -1;
  const normalizedCells: number[] = [];
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell) || Number(cell) < 0 || Number(cell) >= cellLimit || Number(cell) <= previous) {
      throw new AdminHttpError(409, "HST scope cells must be ascending, unique, and valid at the declared order");
    }
    previous = Number(cell);
    normalizedCells.push(Number(cell));
  }
  return {
    coordinateFrame: "ICRS",
    cone: { raDeg, decDeg, radiusDeg },
    scope: { ordering: "NESTED", order: Number(order), cells: normalizedCells, q1MocSha256, hstMocSha256 },
  };
}

function parsedObservationSummary(value: unknown, includeCandidates: boolean): MastHstObservationSummaryView | undefined {
  const summary = object(value);
  const request = object(summary?.request);
  const snapshot = object(summary?.snapshot);
  const candidates = summary?.candidates;
  if (summary?.kind !== "mast-hst-observations"
    || !request || !nonEmptyText(request.namespace, 63) || !nonEmptyText(request.name, 253) || !nonEmptyText(request.uid, 64)
    || !Number.isSafeInteger(summary.candidateCount) || Number(summary.candidateCount) < 0
    || typeof summary.truncated !== "boolean" || typeof summary.queryExhausted !== "boolean"
    || !Array.isArray(candidates) || candidates.length > 50) return undefined;
  const parsedCandidates: MastHstObservationCandidate[] = [];
  for (const entry of candidates) {
    const candidate = object(entry);
    if (!candidate || typeof candidate.obsid !== "string" || !/^\d{1,64}$/.test(candidate.obsid)) return undefined;
    if (candidate.instrument !== undefined && !nonEmptyText(candidate.instrument, 128)) return undefined;
    if (candidate.filters !== undefined && !nonEmptyText(candidate.filters, 512)) return undefined;
    parsedCandidates.push({ obsid: candidate.obsid,
      ...(typeof candidate.instrument === "string" ? { instrument: candidate.instrument } : {}),
      ...(typeof candidate.filters === "string" ? { filters: candidate.filters } : {}),
    });
  }
  let safeSnapshot: MastHstObservationSummaryView["snapshot"];
  if (snapshot) {
    if (typeof snapshot.sha256 !== "string" || !SHA256.test(snapshot.sha256)
      || !Number.isSafeInteger(snapshot.sizeBytes) || Number(snapshot.sizeBytes) < 1 || Number(snapshot.sizeBytes) > MAST_HST_MAX_SNAPSHOT_BYTES) return undefined;
    safeSnapshot = { sha256: snapshot.sha256, sizeBytes: Number(snapshot.sizeBytes) };
  }
  return {
    kind: "mast-hst-observations",
    ...(typeof summary.semantics === "string" ? { semantics: summary.semantics.slice(0, 256) } : {}),
    request: { namespace: request.namespace, name: request.name, uid: request.uid },
    ...(includeCandidates ? { candidates: parsedCandidates } : {}),
    candidateCount: Number(summary.candidateCount),
    truncated: summary.truncated,
    queryExhausted: summary.queryExhausted,
    ...(safeSnapshot ? { snapshot: safeSnapshot } : {}),
  };
}

export function mastHstObservationSummaryView(value: unknown, includeCandidates: boolean): MastHstObservationSummaryView | undefined {
  return parsedObservationSummary(value, includeCandidates);
}

function normalizedStatus(resource: MastHstDiscoveryResource): Record<string, unknown> {
  const raw = object(resource.status) ?? {};
  return object(raw.status) ?? raw;
}

function expectedSnapshotKey(request: { namespace: string; name: string; uid: string }, sha256: string): string {
  return `discovery-evidence/observations/atlas-warehouse/${request.name}/${request.uid}/${sha256}.json`;
}

export function resolveMastHstObservation(resource: MastHstDiscoveryResource, candidateId: unknown): ResolvedMastHstObservation {
  if (typeof candidateId !== "string" || !/^\d{1,64}$/.test(candidateId)) throw new AdminHttpError(400, "candidateId must be a decimal MAST obsid");
  if (resource.metadata?.labels?.["app.kubernetes.io/managed-by"] !== "astro-survey-atlas-assets"
    || resource.metadata?.labels?.["astro.zhejianglab.org/resource-kind"] !== "moc-discovery") {
    throw new AdminHttpError(404, "MOC discovery request was not found");
  }
  const request = {
    namespace: resource.metadata.namespace ?? "",
    name: resource.metadata.name ?? "",
    uid: resource.metadata.uid ?? "",
  };
  if (!nonEmptyText(request.namespace, 63) || !nonEmptyText(request.name, 253) || !/^[A-Za-z0-9-]{1,64}$/.test(request.uid)) {
    throw new AdminHttpError(409, "HST discovery request identity is incomplete");
  }
  if (resource.spec?.policyRef !== MAST_HST_DISCOVERY_POLICY) throw new AdminHttpError(409, "Discovery request does not use the HST observation policy");
  const status = normalizedStatus(resource);
  if (String(status.phase ?? "").toUpperCase() !== "SUCCEEDED") throw new AdminHttpError(409, "HST observation discovery has not succeeded");
  const summary = parsedObservationSummary(status.observationSummary, true);
  if (!summary || summary.request.namespace !== request.namespace || summary.request.name !== request.name || summary.request.uid !== request.uid) {
    throw new AdminHttpError(409, "HST observation summary does not match the owned discovery request");
  }
  const specQuery = object(object(resource.spec.query)?.observationQuery);
  const query = observationQuery(specQuery);
  const snapshot = object(status.observationSummary && object(status.observationSummary)?.snapshot);
  if (!snapshot || typeof snapshot.objectKey !== "string" || snapshot.objectKey !== expectedSnapshotKey(request, snapshot.sha256 as string)
    || typeof snapshot.sha256 !== "string" || !SHA256.test(snapshot.sha256)
    || !Number.isSafeInteger(snapshot.sizeBytes) || Number(snapshot.sizeBytes) < 1 || Number(snapshot.sizeBytes) > MAST_HST_MAX_SNAPSHOT_BYTES) {
    throw new AdminHttpError(409, "HST observation snapshot reference is invalid");
  }
  const candidate = summary.candidates?.find((entry) => entry.obsid === candidateId);
  if (!candidate) throw new AdminHttpError(400, "candidateId is not present in the HST discovery result");
  return {
    request,
    candidate,
    snapshot: { objectKey: expectedSnapshotKey(request, snapshot.sha256), sha256: snapshot.sha256, sizeBytes: Number(snapshot.sizeBytes) },
    observationQuery: query,
    candidateCount: summary.candidateCount,
    truncated: summary.truncated,
    queryExhausted: summary.queryExhausted,
  };
}

export function verifyMastHstSnapshot(value: unknown, resolved: ResolvedMastHstObservation): void {
  const snapshot = object(value);
  const request = object(snapshot?.request);
  const result = object(snapshot?.result);
  if (snapshot?.schemaVersion !== 1 || snapshot.kind !== "mast-hst-observations"
    || !request || request.namespace !== resolved.request.namespace || request.name !== resolved.request.name || request.uid !== resolved.request.uid
    || !isDeepStrictEqual(snapshot.observationQuery, resolved.observationQuery)
    || !result || result.candidateCount !== resolved.candidateCount || result.truncated !== resolved.truncated
    || result.queryExhausted !== resolved.queryExhausted) {
    throw new AdminHttpError(409, "Frozen HST snapshot identity or query does not match the discovery request");
  }
  const source = object(snapshot.source);
  if (source?.collection !== "HST" || source.dataproductType !== "image" || source.dataRights !== "PUBLIC") {
    throw new AdminHttpError(409, "Frozen HST snapshot does not identify public HST image observations");
  }
  const tables = snapshot.Tables;
  if (!Array.isArray(tables) || !tables.length) throw new AdminHttpError(409, "Frozen HST snapshot has no normalized CAOM table");
  const table = object(tables[0]);
  const columns = table?.Columns;
  const rows = table?.Rows;
  if (!Array.isArray(columns) || !Array.isArray(rows)) throw new AdminHttpError(409, "Frozen HST snapshot table is malformed");
  const columnNames = columns.map((column) => object(column)?.dataIndex);
  if (columnNames.some((name) => typeof name !== "string") || new Set(columnNames).size !== columnNames.length) throw new AdminHttpError(409, "Frozen HST snapshot columns are invalid");
  const obsidIndex = columnNames.indexOf("obsid");
  const collectionIndex = columnNames.indexOf("obs_collection");
  const dataProductTypeIndex = columnNames.indexOf("dataproduct_type");
  const dataRightsIndex = columnNames.indexOf("dataRights");
  if (obsidIndex < 0 || collectionIndex < 0 || dataProductTypeIndex < 0 || dataRightsIndex < 0) {
    throw new AdminHttpError(409, "Frozen HST snapshot omits required public image observation fields");
  }
  const matchingRows = rows.filter((row) => Array.isArray(row) && row[obsidIndex] !== null && String(row[obsidIndex]) === resolved.candidate.obsid);
  if (matchingRows.length !== 1 || String(matchingRows[0]?.[collectionIndex]).toUpperCase() !== "HST"
    || String(matchingRows[0]?.[dataProductTypeIndex]).toLowerCase() !== "image"
    || String(matchingRows[0]?.[dataRightsIndex]).toUpperCase() !== "PUBLIC") {
    throw new AdminHttpError(409, "Selected HST obsid is not one unique public image row in the frozen CAOM snapshot");
  }
}

function sourceSummary(request: MocDiscoveryRequestLike): MocReviewSummary {
  const raw = request.status?.reviewSummary;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdminHttpError(409, "MOC discovery summary is unavailable; wait for the v2 discovery job to finish");
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 2 || typeof value.truncated !== "boolean" || typeof value.summaryTruncated !== "boolean" || !Array.isArray(value.candidates)) {
    throw new AdminHttpError(409, "MOC discovery summary is not a supported v2 result; resubmit the discovery request");
  }
  const candidates = value.candidates.filter((entry): entry is MocCandidateSummary => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.candidateId === "string" && item.candidateId.length > 0;
  });
  if (candidates.length !== value.candidates.length || candidates.length > 50) {
    throw new AdminHttpError(409, "MOC discovery summary contains invalid candidate records");
  }
  const searchRecordCount = typeof value.searchRecordCount === "number" && Number.isSafeInteger(value.searchRecordCount) && value.searchRecordCount >= 0
    ? value.searchRecordCount : undefined;
  return {
    schemaVersion: 2,
    truncated: value.truncated,
    summaryTruncated: value.summaryTruncated,
    ...(searchRecordCount !== undefined ? { searchRecordCount } : {}),
    candidates,
  };
}

function publicCandidateUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    const allowlisted = ["alasky.cds.unistra.fr", "alasky.unistra.fr", "cds.unistra.fr"]
      .some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    return allowlisted ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the authoritative source selected by an Admin operator. The input
 * contains only an ID; all URLs and hashes come from the Warehouse summary.
 */
export function resolveMocDiscoveryCandidate(request: MocDiscoveryRequestLike, candidateId: unknown): MocDiscoveryCandidate {
  if (typeof request.name !== "string" || !request.name) throw new AdminHttpError(400, "MOC discovery request name is required");
  if (typeof candidateId !== "string" || !candidateId.trim()) throw new AdminHttpError(400, "candidateId is required");
  const summary = sourceSummary(request);
  const candidate = summary.candidates.find((entry) => entry.candidateId === candidateId);
  if (!candidate) throw new AdminHttpError(400, "candidateId is not present in the discovery result");
  const mocUrl = publicCandidateUrl(candidate.mocUrl);
  const hipsUrl = publicCandidateUrl(candidate.hipsUrl);
  const recordUrl = publicCandidateUrl(candidate.recordUrl);
  const sourceUrl = mocUrl ?? (hipsUrl ? hipsMocUrl(hipsUrl) : undefined);
  if (!sourceUrl) throw new AdminHttpError(409, "selected candidate has no allowlisted MOC source URL");
  return {
    provider: MOC_DISCOVERY_PROVIDER,
    requestName: request.name,
    candidate,
    sourceUrl: sourceUrl ?? recordUrl!,
    ...(mocUrl ? { mocUrl } : {}),
    ...(hipsUrl ? { hipsUrl } : {}),
  };
}

export function reviewSummaryFromDiscoveryStatus(value: unknown): MocReviewSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    return sourceSummary({ status: { reviewSummary: value } });
  } catch {
    return undefined;
  }
}

function hipsMocUrl(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  return normalized.endsWith("/Moc.fits") ? normalized : `${normalized}/Moc.fits`;
}
