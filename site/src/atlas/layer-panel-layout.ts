export interface LayerPanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface LayerTooltipPosition {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Place the layer tooltip beside the list without ever covering its hit area. */
export function coverageLayerTooltipPosition(
  viewportWidth: number,
  viewportHeight: number,
  row: Pick<LayerPanelRect, "top" | "bottom">,
  list: Pick<LayerPanelRect, "right">,
  tooltip: Pick<LayerPanelRect, "width" | "height">,
  margin = 12,
  gap = 12,
): LayerTooltipPosition | null {
  if (![viewportWidth, viewportHeight, row.top, row.bottom, list.right, tooltip.width, tooltip.height].every(Number.isFinite)) return null;
  const left = list.right + gap;
  if (left + tooltip.width > viewportWidth - margin) return null;
  const maxTop = viewportHeight - tooltip.height - margin;
  if (maxTop < margin) return null;
  const preferredTop = row.top;
  const top = Math.min(Math.max(margin, preferredTop), maxTop);
  return { left, top, width: tooltip.width, height: tooltip.height };
}
