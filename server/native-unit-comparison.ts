import { createHash } from "node:crypto";
import type { NativeBinding, NativeGroup, NativeSnapshot } from "./native-unit-model.js";

export type NativeDiffState = "unchanged" | "modified" | "added" | "removed";

export interface NativeInputDiff {
  sourceId: string;
  state: NativeDiffState;
  active?: NativeSnapshotSummary;
  candidate?: NativeSnapshotSummary;
}

export interface NativeSnapshotSummary {
  id: string;
  sourceRevision: number;
  scope: string;
  rowCount?: number;
  files: Array<{ sha256: string; sizeBytes: number }>;
}

export interface NativeProductDiff {
  productId: string;
  state: NativeDiffState;
  changes: string[];
  bindingFields: string[];
  active?: NativeBinding;
  candidate?: NativeBinding;
}

export interface NativeArtifactDiff {
  id: "generic" | "hst" | "survey" | "lock" | "recipes";
  label: string;
  state: NativeDiffState;
  activeDigest?: string;
  candidateDigest?: string;
}

export interface NativeComparisonSummary {
  products: Record<NativeDiffState, number>;
  inputs: Record<NativeDiffState, number>;
  changedArtifacts: number;
}

export interface NativeGroupComparison {
  baseline: { groupId: string; generation: number } | null;
  hasChanges: boolean | null;
  summary: NativeComparisonSummary;
  products: NativeProductDiff[];
  inputs: NativeInputDiff[];
  artifacts: NativeArtifactDiff[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify({ value: canonical(value) })).digest("hex");
}

function normalizedLock(value: string): unknown {
  try { return canonical(JSON.parse(value) as unknown); }
  catch { return value; }
}

function bindingIdentity(binding: NativeBinding): unknown {
  const { revision: _revision, ...identity } = binding;
  return canonical({ ...identity, sourceIds: [...binding.sourceIds].sort() });
}

function snapshotSummary(snapshot: NativeSnapshot): NativeSnapshotSummary {
  return {
    id: snapshot.id,
    sourceRevision: snapshot.sourceRevision,
    scope: snapshot.scope,
    ...(snapshot.rowCount !== undefined ? { rowCount: snapshot.rowCount } : {}),
    files: snapshot.files.map(file => ({ sha256: file.sha256, sizeBytes: file.sizeBytes })),
  };
}

function artifactValues(group: NativeGroup): Array<{ id: NativeArtifactDiff["id"]; label: string; value: unknown }> {
  return [
    ...(group.generic ? [{ id: "generic" as const, label: "通用索引制品", value: { sha256: group.generic.file.sha256, buildKey: group.generic.buildKey } }] : []),
    ...(group.hst ? [{ id: "hst" as const, label: "HST 索引制品", value: { sha256: group.hst.file.sha256, sourceSha256: group.hst.sourceSha256 } }] : []),
    ...(group.survey ? [{ id: "survey" as const, label: "巡天索引制品", value: { sha256: group.survey.file.sha256, buildKey: group.survey.buildKey } }] : []),
    { id: "lock", label: "锁定配置", value: normalizedLock(group.lockText) },
    { id: "recipes", label: "配方配置", value: group.recipes },
  ];
}

function sourceInputSignatures(group: NativeGroup): Record<string, NativeSnapshotSummary> {
  return Object.fromEntries(Object.entries(group.snapshots).map(([sourceId, snapshot]) => [sourceId, snapshotSummary(snapshot)]));
}

function contentSignature(group: NativeGroup): string {
  return digest({
    bindings: group.bindings.map(binding => [binding.productId, bindingIdentity(binding)]).sort(([left], [right]) => String(left).localeCompare(String(right))),
    inputs: sourceInputSignatures(group),
    artifacts: artifactValues(group).map(artifact => [artifact.id, artifact.value]),
  });
}

function sourceIdsFor(binding: NativeBinding | undefined): string[] {
  return [...new Set(binding?.sourceIds ?? [])].sort();
}

export function compareNativeGroups(active: NativeGroup | undefined, candidate: NativeGroup, generation: number): NativeGroupComparison {
  const activeBindings = new Map((active?.bindings ?? []).map(binding => [binding.productId, binding]));
  const candidateBindings = new Map(candidate.bindings.map(binding => [binding.productId, binding]));
  const productIds = [...new Set([...activeBindings.keys(), ...candidateBindings.keys()])].sort();
  const products: NativeProductDiff[] = productIds.map(productId => {
    const oldBinding = activeBindings.get(productId);
    const newBinding = candidateBindings.get(productId);
    if (!oldBinding) return { productId, state: "added", changes: ["binding-added"], bindingFields: [], candidate: newBinding };
    if (!newBinding) return { productId, state: "removed", changes: ["binding-removed"], bindingFields: [], active: oldBinding };
    const changes: string[] = [];
    const oldIdentity = bindingIdentity(oldBinding) as Record<string, unknown>;
    const newIdentity = bindingIdentity(newBinding) as Record<string, unknown>;
    const bindingFields = [...new Set([...Object.keys(oldIdentity), ...Object.keys(newIdentity)])].filter(key => digest(oldIdentity[key]) !== digest(newIdentity[key])).sort();
    if (bindingFields.length) changes.push("binding-changed");
    const oldInputs = Object.fromEntries(sourceIdsFor(oldBinding).map(id => [id, active!.snapshots[id] ? snapshotSummary(active!.snapshots[id]!) : null]));
    const newInputs = Object.fromEntries(sourceIdsFor(newBinding).map(id => [id, candidate.snapshots[id] ? snapshotSummary(candidate.snapshots[id]!) : null]));
    for (const sourceId of [...new Set([...Object.keys(oldInputs), ...Object.keys(newInputs)])].sort()) {
      if (digest(oldInputs[sourceId]) !== digest(newInputs[sourceId])) changes.push(`snapshot:${sourceId}`);
    }
    return { productId, state: changes.length ? "modified" : "unchanged", changes, bindingFields, active: oldBinding, candidate: newBinding };
  });

  const oldInputs = active ? sourceInputSignatures(active) : {};
  const newInputs = sourceInputSignatures(candidate);
  const inputs: NativeInputDiff[] = [...new Set([...Object.keys(oldInputs), ...Object.keys(newInputs)])].sort().map(sourceId => {
    const oldValue = oldInputs[sourceId];
    const newValue = newInputs[sourceId];
    const state: NativeDiffState = !oldValue ? "added" : !newValue ? "removed" : digest(oldValue) === digest(newValue) ? "unchanged" : "modified";
    return { sourceId, state, ...(oldValue ? { active: oldValue } : {}), ...(newValue ? { candidate: newValue } : {}) };
  });

  const oldArtifacts = active ? artifactValues(active) : [];
  const newArtifacts = artifactValues(candidate);
  const oldById = new Map(oldArtifacts.map(artifact => [artifact.id, artifact]));
  const newById = new Map(newArtifacts.map(artifact => [artifact.id, artifact]));
  const artifacts: NativeArtifactDiff[] = newArtifacts.map(artifact => {
    const old = oldById.get(artifact.id);
    const next = newById.get(artifact.id)!;
    const state: NativeDiffState = !old ? "added" : digest(old.value) === digest(next.value) ? "unchanged" : "modified";
    return { id: artifact.id, label: artifact.label, state, ...(old ? { activeDigest: digest(old.value) } : {}), candidateDigest: digest(next.value) };
  });
  for (const artifact of oldArtifacts) if (!newById.has(artifact.id)) artifacts.push({ id: artifact.id, label: artifact.label, state: "removed", activeDigest: digest(artifact.value) });

  const summary = {
    products: Object.fromEntries(([
      ["unchanged", products.filter(item => item.state === "unchanged").length],
      ["modified", products.filter(item => item.state === "modified").length],
      ["added", products.filter(item => item.state === "added").length],
      ["removed", products.filter(item => item.state === "removed").length],
    ] as const)) as Record<NativeDiffState, number>,
    inputs: Object.fromEntries(([
      ["unchanged", inputs.filter(item => item.state === "unchanged").length],
      ["modified", inputs.filter(item => item.state === "modified").length],
      ["added", inputs.filter(item => item.state === "added").length],
      ["removed", inputs.filter(item => item.state === "removed").length],
    ] as const)) as Record<NativeDiffState, number>,
    changedArtifacts: artifacts.filter(item => item.state !== "unchanged").length,
  };

  const hasChanges = active ? contentSignature(active) !== contentSignature(candidate) : null;
  return { baseline: active ? { groupId: active.id, generation } : null, hasChanges, summary, products, inputs, artifacts };
}
