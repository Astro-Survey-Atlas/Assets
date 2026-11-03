export interface CoverageCatalogRevisionSource {
  revision?: string;
  generatedAt?: string;
  layers: readonly {
    layerId: string;
    revision?: string;
    displayRevision?: string;
    nativeMaxOrder?: number;
    displayOrders?: readonly number[];
    availableOrders?: readonly number[];
  }[];
}

export function coverageCatalogRevisionKey(catalog: CoverageCatalogRevisionSource): string {
  const base = catalog.revision
    ? `revision:${catalog.revision}`
    : catalog.generatedAt
      ? `generated:${catalog.generatedAt}`
      : `catalog:${JSON.stringify(catalog)}`;
  const layers = [...catalog.layers]
    .map((layer) => ({
      layerId: layer.layerId,
      revision: layer.revision ?? "",
      displayRevision: layer.displayRevision ?? "",
      nativeMaxOrder: layer.nativeMaxOrder ?? null,
      displayOrders: [...(layer.displayOrders ?? layer.availableOrders ?? [])].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.layerId.localeCompare(right.layerId));
  return `${base}:layers:${JSON.stringify(layers)}`;
}
