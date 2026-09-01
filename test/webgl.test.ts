import assert from "node:assert/strict";
import test from "node:test";

import { disposeRenderer, rendererPrecision } from "../site/src/atlas/survey-layer-viewer.js";

function fakeRenderer() {
  let disposed = 0;
  let lost = 0;
  return {
    renderer: {
      dispose: () => { disposed += 1; },
      getContext: () => ({ getExtension: () => ({ loseContext: () => { lost += 1; } }) }),
    } as any,
    counts: () => ({ disposed, lost }),
  };
}

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

test("viewer reload disposes GPU resources without losing the shared WebGL context", () => {
  const fake = fakeRenderer();
  disposeRenderer(fake.renderer, false);
  assert.deepEqual(fake.counts(), { disposed: 1, lost: 0 });
});

test("final viewer disposal releases the WebGL context", () => {
  const fake = fakeRenderer();
  disposeRenderer(fake.renderer);
  assert.deepEqual(fake.counts(), { disposed: 1, lost: 1 });
});
