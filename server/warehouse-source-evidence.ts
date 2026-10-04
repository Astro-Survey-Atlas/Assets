import type { ConnectorView, CoverageTaskView } from "./admin.js";
import type { DownloadPlanMatch, ScanScopeSummary, WarehouseLayerSnapshot } from "./evidence-store.js";
import type { ScanConnectorIdentity } from "../src/connector-icon.js";

export interface WarehouseConnectorContext {
  tasks: readonly CoverageTaskView[];
  batches: readonly Record<string, unknown>[];
  connectors: readonly ConnectorView[];
}
interface LayerIdentity { surveyId: string; releaseId: string; productId: string }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function objects(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : []; }
function agrees(candidate: Record<string, unknown>, layer: LayerIdentity): boolean {
  return candidate.surveyId === layer.surveyId && candidate.releaseId === layer.releaseId && candidate.productId === layer.productId;
}

function connectorIdentity(name: string, basis: ScanConnectorIdentity["identityBasis"], context: WarehouseConnectorContext): ScanConnectorIdentity {
  const connector = context.connectors.find(value => value.name === name);
  return { name, type: connector?.type ?? "unknown", ...(connector?.iconUrl ? { iconUrl: connector.iconUrl } : {}), identityBasis: basis };
}

/** A scope ID alone is insufficient: join the evidence layer and frozen scope SHA too. */
function scopeConnectors(layer: LayerIdentity, scope: ScanScopeSummary, context: WarehouseConnectorContext): ScanConnectorIdentity[] {
  return context.batches.flatMap(batch => {
    if (typeof batch.sourceConnector !== "string" || !batch.sourceConnector) return [];
    const rule = objects(batch.rules).find(value => {
      const identity = object(value.layer);
      return identity.layerId === scope.layerId && agrees(identity, layer);
    });
    if (!rule) return [];
    const scopeRule = objects(object(object(batch.status).scope).rules).find(value => value.layerId === scope.layerId
      && value.scopeId === scope.scopeId && value.scopeSnapshotSha256 === scope.scopeSnapshotSha256
      && value.expectedPartitionCount === scope.expectedPartitions && value.name === rule.name);
    return scopeRule ? [connectorIdentity(batch.sourceConnector, "scan-scope", context)] : [];
  });
}

function runConnectors(layer: LayerIdentity, runId: string | undefined, context: WarehouseConnectorContext): ScanConnectorIdentity[] {
  if (!runId) return [];
  return context.tasks.flatMap(task => task.status.runId === runId && task.sourceConnector
    && agrees(task as unknown as Record<string, unknown>, layer)
    ? [connectorIdentity(task.sourceConnector, "scan-run", context)] : []);
}

/** Resolve each file's own provenance, never a URI prefix or aggregate layer brand. */
export function scannedFileConnectors(
  file: { scanRunId?: string; matchingCoverage?: DownloadPlanMatch[] },
  context: WarehouseConnectorContext,
  layers: ReadonlyMap<string, LayerIdentity>,
  scopes: readonly ScanScopeSummary[],
): ScanConnectorIdentity[] {
  const identities = new Map<string, ScanConnectorIdentity>();
  for (const match of file.matchingCoverage ?? []) {
    const layer = match.layerId ? layers.get(match.layerId) : undefined;
    if (!layer) continue;
    const run = runConnectors(layer, match.scanRunId ?? file.scanRunId, context);
    const scope = scopes.find(value => value.layerId === (match.evidenceLayerId ?? match.layerId) && value.scopeId === match.scopeId);
    const scoped = scope ? scopeConnectors(layer, scope, context) : [];
    const candidates = [...run, ...scoped];
    // Conflicting retained provenance must not assign an arbitrary Connector.
    if (new Set(candidates.map(value => value.name)).size !== 1) continue;
    const identity = candidates[0];
    if (identity) identities.set(identity.name, identity);
  }
  return [...identities.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Layer summaries are separate from regional file hits. */
export function withWarehouseConnectorEvidence(snapshot: WarehouseLayerSnapshot, context: WarehouseConnectorContext): WarehouseLayerSnapshot {
  const runs = [...new Set(snapshot.scanRunIds?.length ? snapshot.scanRunIds : snapshot.scanRunId ? [snapshot.scanRunId] : [])];
  const evidence = new Map<string, ScanConnectorIdentity & { matchingScanRuns: number }>();
  if (snapshot.scanScope) for (const connector of scopeConnectors(snapshot, snapshot.scanScope, context)) {
    evidence.set(connector.name, { ...connector, matchingScanRuns: snapshot.scanRunCount ?? snapshot.scanScope.committedPartitions });
  }
  for (const run of runs) for (const connector of runConnectors(snapshot, run, context)) {
    const current = evidence.get(connector.name);
    if (current?.identityBasis === "scan-scope") continue;
    evidence.set(connector.name, { ...connector, matchingScanRuns: (current?.matchingScanRuns ?? 0) + 1 });
  }
  return evidence.size ? { ...snapshot, connectorEvidence: [...evidence.values()] } : snapshot;
}
