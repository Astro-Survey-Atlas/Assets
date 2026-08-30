import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AdminHttpError } from "./admin.js";

export const MOC_DISCOVERY_POLICY = "cds-public-moc-v1" as const;
export const MOC_DISCOVERY_PROVIDER = "cds" as const;

export type MocDiscoveryDecision = "pending" | "ready-for-build" | "rejected";

export interface MocDiscoveryReviewInput {
  provider?: string;
  candidateId: string;
  probeId?: string;
  sourceSnapshotSha256?: string;
  decision: MocDiscoveryDecision;
  sourceUrl?: string;
  mocUrl?: string;
  hipsUrl?: string;
  notes?: string;
}

export interface MocDiscoveryReview extends MocDiscoveryReviewInput {
  provider: string;
  requestName: string;
  revision: number;
  reviewedAt: string;
}

export interface MocCandidateSummary {
  candidateId: string;
  title?: string;
  recordUrl?: string;
  mocUrl?: string;
  hipsUrl?: string;
  [key: string]: unknown;
}

export interface MocProbeValidationSummary {
  format?: string;
  timeLoss?: string;
  icrs?: boolean;
  nested?: boolean;
  mocDimension?: boolean;
  stmoc?: boolean;
  acceptedSpatialMoc?: boolean;
  maxOrder?: number;
  [key: string]: unknown;
}

export interface MocProbeSummary {
  probeId: string;
  candidateId: string;
  kind: string;
  url: string;
  status?: number;
  bytes?: number;
  ok: boolean;
  sha256?: string;
  evidenceRef?: string;
  contentType?: string;
  error?: string;
  validation?: MocProbeValidationSummary;
  [key: string]: unknown;
}

export interface MocReviewSummary {
  schemaVersion: 1;
  truncated: boolean;
  summaryTruncated: boolean;
  candidates: MocCandidateSummary[];
  probes: MocProbeSummary[];
}

type MocDiscoveryRequestLike = {
  name?: string;
  status?: Record<string, unknown> & { reviewSummary?: unknown };
};

const configuredContentRoot = process.env.ASSETS_CONTENT_ROOT
  ? path.resolve(process.env.ASSETS_CONTENT_ROOT)
  : "/var/lib/assets-content";

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new AdminHttpError(400, `${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new AdminHttpError(400, `${field} is invalid`);
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, maxLength);
}

function publicUrl(value: unknown, field: string): string | undefined {
  const candidate = optionalText(value, field, 2048);
  if (!candidate) return undefined;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { throw new AdminHttpError(400, `${field} must be an http or https URL`); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new AdminHttpError(400, `${field} must be a public http or https URL without credentials`);
  return parsed.toString();
}

function reviewInput(value: unknown): MocDiscoveryReviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminHttpError(400, "review must be an object");
  const input = value as Record<string, unknown>;
  const provider = optionalText(input.provider, "provider", 32) ?? MOC_DISCOVERY_PROVIDER;
  if (provider !== MOC_DISCOVERY_PROVIDER) throw new AdminHttpError(400, "provider is unsupported");
  const candidateId = text(input.candidateId, "candidateId", 512);
  const probeId = optionalText(input.probeId, "probeId", 128)?.toLowerCase();
  if (probeId && !/^[a-f0-9]{64}$/.test(probeId)) throw new AdminHttpError(400, "probeId must be a 64-character SHA-256");
  const rawSnapshot = optionalText(input.sourceSnapshotSha256, "sourceSnapshotSha256", 128);
  const sourceSnapshotSha256 = rawSnapshot?.toLowerCase();
  if (sourceSnapshotSha256 && !/^[a-f0-9]{64}$/.test(sourceSnapshotSha256)) throw new AdminHttpError(400, "sourceSnapshotSha256 must be a 64-character SHA-256");
  const decision = text(input.decision, "decision", 32) as MocDiscoveryDecision;
  if (!["pending", "ready-for-build", "rejected"].includes(decision)) throw new AdminHttpError(400, "decision is unsupported");
  const sourceUrl = publicUrl(input.sourceUrl, "sourceUrl");
  const mocUrl = publicUrl(input.mocUrl, "mocUrl");
  const hipsUrl = publicUrl(input.hipsUrl, "hipsUrl");
  const notes = optionalText(input.notes, "notes", 4000);
  return {
    provider,
    candidateId,
    ...(probeId ? { probeId } : {}),
    ...(sourceSnapshotSha256 ? { sourceSnapshotSha256 } : {}),
    decision,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(mocUrl ? { mocUrl } : {}),
    ...(hipsUrl ? { hipsUrl } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Versioned local review records; discovery evidence remains owned by Warehouse. */
export class MocDiscoveryReviewStore {
  #root: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(root = configuredContentRoot) {
    this.#root = path.resolve(root);
  }

  #file(): string { return path.join(this.#root, "moc-discovery-reviews-v1.ndjson"); }

  async list(requestName: string): Promise<MocDiscoveryReview[]> {
    try {
      const lines = (await readFile(this.#file(), "utf8")).split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as MocDiscoveryReview)
        .filter((entry) => entry.requestName === requestName)
        .sort((a, b) => a.revision - b.revision);
    } catch { return []; }
  }

  async add(requestName: string, value: unknown): Promise<MocDiscoveryReview> {
    const input = reviewInput(value);
    if (input.decision === "ready-for-build" && !input.sourceSnapshotSha256) throw new AdminHttpError(400, "ready-for-build requires a verified source snapshot");
    const append = async (): Promise<MocDiscoveryReview> => {
      const previous = await this.list(requestName);
      const key = `${input.provider}:${input.candidateId}:${input.sourceSnapshotSha256 ?? "no-snapshot"}`;
      const revision = previous.filter((entry) => `${entry.provider}:${entry.candidateId}:${entry.sourceSnapshotSha256 ?? "no-snapshot"}` === key).length + 1;
      const record: MocDiscoveryReview = { ...input, provider: input.provider ?? MOC_DISCOVERY_PROVIDER, requestName, revision, reviewedAt: new Date().toISOString() };
      await mkdir(this.#root, { recursive: true });
      await appendFile(this.#file(), `${JSON.stringify(record)}\n`, "utf8");
      return record;
    };
    const result = this.#writeQueue.then(append, append);
    this.#writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function summaryFromRequest(request: MocDiscoveryRequestLike): MocReviewSummary | undefined {
  const rawStatus = request.status ?? {};
  const rawSummary = rawStatus.reviewSummary;
  if (!rawSummary || typeof rawSummary !== "object" || Array.isArray(rawSummary)) return undefined;
  const value = rawSummary as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.truncated !== "boolean" || typeof value.summaryTruncated !== "boolean") return undefined;
  if (!Array.isArray(value.candidates) || !Array.isArray(value.probes)) return undefined;
  const candidates = value.candidates.filter((entry): entry is MocCandidateSummary => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.candidateId === "string" && item.candidateId.length > 0;
  });
  const probes = value.probes.filter((entry): entry is MocProbeSummary => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.probeId === "string" && /^[a-f0-9]{64}$/.test(item.probeId)
      && typeof item.candidateId === "string" && typeof item.kind === "string"
      && typeof item.url === "string" && typeof item.ok === "boolean";
  });
  if (candidates.length !== value.candidates.length || probes.length !== value.probes.length) return undefined;
  return { schemaVersion: 1, truncated: value.truncated, summaryTruncated: value.summaryTruncated, candidates, probes };
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || left === right;
}

/** Resolve a review against the authoritative, bounded summary projected by Warehouse. */
export function resolveMocDiscoveryReview(request: MocDiscoveryRequestLike, value: unknown): MocDiscoveryReviewInput {
  const input = reviewInput(value);
  const summary = summaryFromRequest(request);
  if (!summary) throw new AdminHttpError(409, "MOC discovery review summary is unavailable; resubmit the discovery request");
  const candidate = summary.candidates.find((entry) => entry.candidateId === input.candidateId);
  if (!candidate) throw new AdminHttpError(400, "candidateId is not present in the discovery result");
  const probes = summary.probes.filter((entry) => entry.candidateId === candidate.candidateId);
  const probe = input.probeId ? probes.find((entry) => entry.probeId === input.probeId) : undefined;
  if (input.probeId && !probe) throw new AdminHttpError(400, "probeId is not present for the selected candidate");
  const phase = String(request.status?.phase ?? "").toUpperCase();
  const probeHash = probe && typeof probe.sha256 === "string" && /^[a-f0-9]{64}$/.test(probe.sha256) ? probe.sha256 : undefined;
  if (input.sourceSnapshotSha256 && input.sourceSnapshotSha256 !== probeHash) throw new AdminHttpError(400, "sourceSnapshotSha256 does not match the selected Warehouse probe");
  if (input.decision === "ready-for-build") {
    const accepted = probe?.ok === true && probeHash && probe.validation?.acceptedSpatialMoc === true;
    if (phase !== "SUCCEEDED" || !accepted) throw new AdminHttpError(409, "ready-for-build requires a successful probe with acceptedSpatialMoc=true");
  }

  const sourceUrl = candidate.recordUrl;
  const candidateMocUrl = candidate.mocUrl;
  const candidateHipsUrl = candidate.hipsUrl;
  const mocUrl = probe?.kind === "mocUrl" ? probe.url : candidateMocUrl;
  const hipsUrl = probe?.kind === "hipsUrl" ? probe.url : candidateHipsUrl;
  const authoritativeProbeUrl = probe?.kind === "recordUrl" ? probe.url : undefined;
  if (!sameOptional(input.sourceUrl, sourceUrl) || !sameOptional(input.mocUrl, mocUrl) || !sameOptional(input.hipsUrl, hipsUrl)) {
    throw new AdminHttpError(400, "review URLs must match the selected Warehouse candidate/probe");
  }
  return {
    provider: input.provider,
    candidateId: candidate.candidateId,
    ...(probe ? { probeId: probe.probeId } : {}),
    ...(probeHash ? { sourceSnapshotSha256: probeHash } : {}),
    decision: input.decision,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(mocUrl ?? authoritativeProbeUrl ? { mocUrl: mocUrl ?? authoritativeProbeUrl } : {}),
    ...(hipsUrl ? { hipsUrl } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

export function validateMocDiscoveryRequestName(value: string): string {
  const normalized = text(value, "request name", 63).toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(normalized)) throw new AdminHttpError(400, "request name must be a DNS label");
  return normalized;
}
