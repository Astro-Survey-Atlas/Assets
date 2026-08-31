export interface CoverageOrderLayer {
  surveyId: string;
  availableOrders: number[];
}

/** Return the finest order explicitly published by every selected survey. */
export function highestCommonCoverageOrder(layers: CoverageOrderLayer[], surveyIds: Iterable<string>): number | null {
  const selectedIds = new Set(surveyIds);
  if (selectedIds.size < 2) return null;

  const bySurvey = new Map<string, Set<number>>();
  for (const layer of layers) {
    if (!selectedIds.has(layer.surveyId)) continue;
    const orders = bySurvey.get(layer.surveyId) ?? new Set<number>();
    layer.availableOrders.forEach((order) => orders.add(order));
    bySurvey.set(layer.surveyId, orders);
  }
  if (bySurvey.size !== selectedIds.size) return null;

  const common = [...bySurvey.values()].reduce<number[]>((orders, available, index) => (
    index === 0 ? [...available] : orders.filter((order) => available.has(order))
  ), []);
  return common.length ? Math.max(...common) : null;
}
