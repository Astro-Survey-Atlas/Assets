import assert from "node:assert/strict";
import test from "node:test";

import { canonicalModality, filterByModalities } from "../src/modality-filter.js";

test("public survey modalities match Warehouse layer modality names", () => {
  assert.equal(canonicalModality("image"), "imaging");
  assert.equal(canonicalModality("spectrum"), "spectroscopy");
  assert.equal(canonicalModality("redshift"), "redshift");
  assert.deepEqual(filterByModalities([
    { id: "image", modality: "image" },
    { id: "spectrum", modality: "spectrum" },
    { id: "redshift", modality: "redshift" },
  ], ["redshift"]), [{ id: "redshift", modality: "redshift" }]);
});
