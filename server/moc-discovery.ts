import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AdminHttpError } from "./admin.js";

export const MOC_DISCOVERY_POLICY = "cds-public-moc-v1" as const;
export const MOC_DISCOVERY_PROVIDER = "cds" as const;

export type MocDiscoveryDecision = "pending" | "ready-for-build" | "rejected";

export interface MocDiscoveryReviewInput {
  provider?: string;
  candidateId: string;
  sourceSnapshotSha256: string;
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
  const sourceSnapshotSha256 = text(input.sourceSnapshotSha256, "sourceSnapshotSha256", 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSnapshotSha256)) throw new AdminHttpError(400, "sourceSnapshotSha256 must be a 64-character SHA-256");
  const decision = text(input.decision, "decision", 32) as MocDiscoveryDecision;
  if (!["pending", "ready-for-build", "rejected"].includes(decision)) throw new AdminHttpError(400, "decision is unsupported");
  const sourceUrl = publicUrl(input.sourceUrl, "sourceUrl");
  const mocUrl = publicUrl(input.mocUrl, "mocUrl");
  const hipsUrl = publicUrl(input.hipsUrl, "hipsUrl");
  const notes = optionalText(input.notes, "notes", 4000);
  return {
    provider,
    candidateId,
    sourceSnapshotSha256,
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
    const append = async (): Promise<MocDiscoveryReview> => {
      const previous = await this.list(requestName);
      const key = `${input.provider}:${input.candidateId}:${input.sourceSnapshotSha256}`;
      const revision = previous.filter((entry) => `${entry.provider}:${entry.candidateId}:${entry.sourceSnapshotSha256}` === key).length + 1;
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

export function validateMocDiscoveryRequestName(value: string): string {
  const normalized = text(value, "request name", 63).toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(normalized)) throw new AdminHttpError(400, "request name must be a DNS label");
  return normalized;
}
