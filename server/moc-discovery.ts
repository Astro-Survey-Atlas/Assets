import { AdminHttpError } from "./admin.js";

/** The single discovery contract emitted by the Warehouse v2 controller. */
export const MOC_DISCOVERY_POLICY = "cds-public-moc-v2" as const;
export const MOC_DISCOVERY_PROVIDER = "cds" as const;

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
  provider: typeof MOC_DISCOVERY_PROVIDER;
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
