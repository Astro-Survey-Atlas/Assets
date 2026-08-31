import assert from "node:assert/strict";
import test from "node:test";

import { coverageLayerTooltipPosition, type LayerPanelRect } from "../site/src/atlas/layer-panel-layout.js";

const rect = (left: number, top: number, width: number, height: number): LayerPanelRect => ({ left, top, right: left + width, bottom: top + height, width, height });

test("coverage layer tooltip stays to the right of the list and inside the viewport", () => {
  const list = rect(28, 132, 330, 520);
  const row = rect(40, 590, 306, 32);
  const tooltip = coverageLayerTooltipPosition(1440, 900, row, list, { width: 292, height: 210 });
  assert.ok(tooltip);
  assert.ok(tooltip.left >= list.right);
  assert.ok(tooltip.top >= 12);
  assert.ok(tooltip.top + tooltip.height <= 888);
});

test("low rows are clamped without moving the layer list or intersecting it", () => {
  const list = rect(14, 160, 362, 620);
  const row = rect(20, 742, 350, 30);
  const tooltip = coverageLayerTooltipPosition(900, 820, row, list, { width: 292, height: 220 });
  assert.ok(tooltip);
  assert.ok(tooltip.left >= list.right);
  assert.ok(tooltip.top + tooltip.height <= 808);
  assert.equal(tooltip.height, 220);
});
