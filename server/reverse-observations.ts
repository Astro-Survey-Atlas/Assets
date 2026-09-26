export interface WarehouseSourceFiles {
  sourceFiles: Array<Record<string, unknown>>;
}

export interface LayeredWarehouseSourceFile {
  logicalLayerId: string;
  source: Record<string, unknown>;
}

export interface WarehouseFileEdge {
  layerId?: string;
  sourceFileId?: string;
  observationLayerId?: string;
}

function sourceFileId(source: Record<string, unknown>): string | undefined {
  const value = source.file_id ?? source.fileId ?? source._id;
  return typeof value === "string" && value ? value : undefined;
}

/** Resolve candidate observations by immutable candidate identity, ordinary files by file ID. */
export function warehouseLogicalLayersForSource(
  source: Record<string, unknown>,
  edges: readonly WarehouseFileEdge[],
  fallbackLogicalLayerId?: string,
): string[] {
  const fileId = sourceFileId(source);
  if (!fileId) return fallbackLogicalLayerId ? [fallbackLogicalLayerId] : [];
  const observationLayerId = typeof source.layer_id === "string" ? source.layer_id : undefined;
  const layerIds = [...new Set(edges.flatMap((edge) => {
    if (edge.sourceFileId !== fileId || !edge.layerId) return [];
    if (observationLayerId && edge.observationLayerId !== observationLayerId) return [];
    return [edge.layerId];
  }))];
  if (layerIds.length || observationLayerId) return layerIds;
  return fallbackLogicalLayerId ? [fallbackLogicalLayerId] : [];
}

/** Preserve immutable candidate observations while coalescing ordinary FileAssets. */
export function mergeWarehouseSourceFiles(
  results: Iterable<readonly [string, WarehouseSourceFiles]>,
): LayeredWarehouseSourceFile[] {
  const files = new Map<string, LayeredWarehouseSourceFile>();
  let unkeyed = 0;
  for (const [logicalLayerId, lookup] of results) {
    for (const source of lookup.sourceFiles) {
      const observationLayerId = typeof source.layer_id === "string" ? source.layer_id : "";
      const id = sourceFileId(source) ?? `unkeyed-${unkeyed++}`;
      const key = `${observationLayerId}\u0000${id}`;
      if (!files.has(key)) files.set(key, { logicalLayerId, source });
    }
  }
  return [...files.values()];
}
