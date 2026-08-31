import assert from "node:assert/strict";
import test from "node:test";

import { rendererPrecision } from "../site/src/atlas/survey-layer-viewer.js";

test("renderer precision falls back when a WebGL driver returns null precision records", () => {
  const canvas = {
    getContext: () => ({ getShaderPrecisionFormat: () => null }),
  } as unknown as HTMLCanvasElement;
  assert.equal(rendererPrecision(canvas), "lowp");
});

test("renderer precision keeps high precision when both shader stages advertise it", () => {
  const canvas = {
    getContext: () => ({
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      HIGH_FLOAT: 3,
      MEDIUM_FLOAT: 4,
      getShaderPrecisionFormat: () => ({ precision: 23 }),
    }),
  } as unknown as HTMLCanvasElement;
  assert.equal(rendererPrecision(canvas), "highp");
});

