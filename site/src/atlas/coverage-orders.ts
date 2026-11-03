export interface CoverageOrderLayer {
  surveyId: string;
  availableOrders: number[];
}

/** Below O6 the complete sky fits in a small bounded overlap response. */
export function overlapViewTileOrder(order: number): number | null {
  if (!Number.isSafeInteger(order) || order < 4 || order > 13 || order < 6) return null;
  return order - 6;
}

/** Keep every selected product in its survey union at a real shared order. */
export function highestCommonCoverageOrder(layers: CoverageOrderLayer[], surveyIds: Iterable<string>): number | null {
  const selectedIds = new Set(surveyIds);
  if (selectedIds.size < 2) return null;

  const bySurvey = new Map<string, Set<number>>();
  for (const layer of layers) {
    if (!selectedIds.has(layer.surveyId)) continue;
    const previous = bySurvey.get(layer.surveyId);
    const orders = new Set(previous ? layer.availableOrders.filter((order) => previous.has(order)) : layer.availableOrders);
    bySurvey.set(layer.surveyId, orders);
  }
  if (bySurvey.size !== selectedIds.size) return null;

  const common = [...bySurvey.values()].reduce<number[]>((orders, available, index) => (
    index === 0 ? [...available] : orders.filter((order) => available.has(order))
  ), []);
  return common.length ? Math.max(...common) : null;
}
