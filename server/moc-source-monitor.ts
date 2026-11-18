import { decodeNativeMoc } from "./native-moc.js";
import { sha256Hex } from "./hash.js";

/**
 * Watches the official MOC sources in src/moc-sources/source-registry.json.
 *
 * It only observes. A changed source becomes a "drifted" report entry for human review;
 * nothing here builds, stages or publishes. A fetch failure is never drift: the source
 * keeps its last known-good observation and only its failure counter moves.
 */
export interface MonitoredSource {
  id: string;
  recordUrl: string;
  mocUrl: string;
  maxOrder: number;
  status: string;
  /** Pinned, derived sources have no remote endpoint to observe. */
  sourceKind?: string;
  sourceSnapshotSha256?: string;
  sourceRecordSha256?: string;
}

export interface Observation {
  recordSha256: string;
  mocSha256: string;
  sizeBytes: number;
  maxOrder: number;
  observedAt: string;
}

export type SourceHealth = {
  id: string;
  state: "unchanged" | "drifted" | "failed" | "skipped";
  /** Last observation that fetched and decoded successfully. */
  lastGood?: Observation;
  lastSuccessAt?: string;
  lastAttemptAt: string;
  consecutiveFailures: number;
  lastError?: string;
  /** Present only when state is "drifted": what differs from the baseline. */
  drift?: Array<"moc-bytes" | "record-bytes" | "max-order">;
  /** The new bytes behind a drift, attached for the reviewer; never promoted automatically. */
  candidate?: Observation;
};

export type MonitorState = Record<string, SourceHealth>;
export type FetchBytes = (url: string) => Promise<Uint8Array>;

export const FAILURE_ALERT_THRESHOLD = 3;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

export async function observeSource(source: MonitoredSource, fetchBytes: FetchBytes, now: string): Promise<Observation> {
  const [record, moc] = await Promise.all([fetchBytes(source.recordUrl), fetchBytes(source.mocUrl)]);
  const decoded = decodeNativeMoc(Buffer.from(moc));
  return {
    recordSha256: sha256Hex(record),
    mocSha256: sha256Hex(moc),
    sizeBytes: moc.byteLength,
    maxOrder: decoded.maxOrder,
    observedAt: now,
  };
}

/** Compare against the registry baseline when no earlier observation exists, otherwise the previous good one. */
export function detectDrift(source: MonitoredSource, observed: Observation, previous?: Observation): NonNullable<SourceHealth["drift"]> {
  const baselineMoc = previous?.mocSha256 ?? source.sourceSnapshotSha256;
  const baselineRecord = previous?.recordSha256 ?? source.sourceRecordSha256;
  const drift: NonNullable<SourceHealth["drift"]> = [];
  if (baselineMoc && baselineMoc !== observed.mocSha256) drift.push("moc-bytes");
  if (baselineRecord && baselineRecord !== observed.recordSha256) drift.push("record-bytes");
  if (observed.maxOrder !== (previous?.maxOrder ?? source.maxOrder)) drift.push("max-order");
  return drift;
}

export async function checkSource(
  source: MonitoredSource, previous: SourceHealth | undefined, fetchBytes: FetchBytes, now: string,
): Promise<SourceHealth> {
  if (source.status === "rejected" || source.sourceKind === "derived-planned-moc") {
    return { id: source.id, state: "skipped", lastAttemptAt: now, consecutiveFailures: 0 };
  }
  try {
    const observed = await observeSource(source, fetchBytes, now);
    const drift = detectDrift(source, observed, previous?.lastGood);
    const base = { id: source.id, lastSuccessAt: now, lastAttemptAt: now, consecutiveFailures: 0 };
    // A drifted source keeps its reviewed baseline; the new bytes ride along as the candidate.
    return drift.length
      ? { ...base, state: "drifted", lastGood: previous?.lastGood, drift, candidate: observed }
      : { ...base, state: "unchanged", lastGood: observed };
  } catch (error) {
    return {
      id: source.id,
      state: "failed",
      lastGood: previous?.lastGood,
      lastSuccessAt: previous?.lastSuccessAt,
      lastAttemptAt: now,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      lastError: errorText(error),
    };
  }
}

export interface MonitorSummary {
  checked: number;
  unchanged: number;
  drifted: string[];
  failed: string[];
  /** Sources failing at least FAILURE_ALERT_THRESHOLD runs in a row. */
  alerting: string[];
}

export async function runMonitor(
  sources: readonly MonitoredSource[], previous: MonitorState, fetchBytes: FetchBytes, now: string,
  options: { concurrency?: number } = {},
): Promise<{ state: MonitorState; summary: MonitorSummary }> {
  const state: MonitorState = { ...previous };
  const queue = [...sources];
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 4) }, async () => {
    for (let source = queue.shift(); source; source = queue.shift()) {
      state[source.id] = await checkSource(source, previous[source.id], fetchBytes, now);
    }
  });
  await Promise.all(workers);
  const current = sources.map(source => state[source.id]!).filter(health => health.state !== "skipped");
  return {
    state,
    summary: {
      checked: current.length,
      unchanged: current.filter(health => health.state === "unchanged").length,
      drifted: current.filter(health => health.state === "drifted").map(health => health.id),
      failed: current.filter(health => health.state === "failed").map(health => health.id),
      alerting: current.filter(health => health.consecutiveFailures >= FAILURE_ALERT_THRESHOLD).map(health => health.id),
    },
  };
}
