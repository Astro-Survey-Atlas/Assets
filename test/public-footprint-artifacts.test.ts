import assert from "node:assert/strict";
import test from "node:test";

import { validate } from "../scripts/public_footprint_artifacts.js";

  test("Assets independently validates public sources, snapshots and generated Core layers", { skip: process.env.ASSET_RUNTIME_HYDRATE === "1" ? "runtime hydrate does not include private evidence" : false }, async () => {
  const statistics = await validate();
  assert.equal(statistics.products, 163);
  assert.equal(statistics.acquired, 111);
  assert.equal(statistics.overview_only, 11);
  assert.equal(statistics.awaiting_geometry, 41);
  assert.equal(statistics.not_applicable, 0);
  assert.equal(statistics.generatedLayers, 83);
});
