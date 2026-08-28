import assert from "node:assert/strict";
import test from "node:test";

import { validate } from "../scripts/public_footprint_artifacts.js";

test("Assets independently validates public sources, snapshots and generated Core layers", async () => {
  const statistics = await validate();
  assert.equal(statistics.products, 90);
  assert.equal(statistics.acquired, 38);
  assert.equal(statistics.overview_only, 11);
  assert.equal(statistics.awaiting_geometry, 41);
  assert.equal(statistics.not_applicable, 0);
  assert.equal(statistics.generatedLayers, 10);
});
