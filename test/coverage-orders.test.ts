import assert from "node:assert/strict";
import test from "node:test";

import { highestCommonCoverageOrder } from "../site/src/atlas/coverage-orders.js";

test("coverage order selection returns the highest exact order shared by selected surveys", () => {
  const layers = [
    { surveyId: "jwst", availableOrders: [4, 8] },
    { surveyId: "csst", availableOrders: [4, 8] },
    { surveyId: "csst", availableOrders: [8] },
  ];
  assert.equal(highestCommonCoverageOrder(layers, ["jwst", "csst"]), 8);
});

test("coverage order selection reports no common order instead of inventing O4", () => {
  const layers = [
    { surveyId: "o4-only", availableOrders: [4] },
    { surveyId: "o8-only", availableOrders: [8] },
  ];
  assert.equal(highestCommonCoverageOrder(layers, ["o4-only", "o8-only"]), null);
});
