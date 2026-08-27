import test from "node:test";
import assert from "node:assert/strict";

import { overlapPanelExitTransform, overlapPanelsShouldExit } from "../site/src/overlap-layout.js";

test("expanded overlap panels leave the sky visible on dense desktop widths", () => {
  assert.equal(overlapPanelsShouldExit(820, 802), true);
  assert.equal(overlapPanelsShouldExit(1440, 748), true);
  assert.equal(overlapPanelsShouldExit(2560, 820), true);
  assert.equal(overlapPanelsShouldExit(3840, 820), false);
});

test("invalid measurements fail closed and exit transform clears the viewport", () => {
  assert.equal(overlapPanelsShouldExit(Number.NaN, 400), true);
  assert.equal(overlapPanelsShouldExit(1440, Number.NaN), true);
  assert.equal(overlapPanelExitTransform(2560), "translateX(-2608px)");
});
