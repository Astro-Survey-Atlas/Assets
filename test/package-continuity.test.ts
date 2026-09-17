import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { retainedPackageLayers, assertReleaseContinuity } from "../server/package-continuity.js";
import { testDataRoot } from "./test-data-root.js";
import { readResourcePackageManifest } from "../server/resource-package-inspection.js";

test("incremental ERO publication retains the baseline Q1 MOCs and provenance", async () => {
  const bytes = await readFile(path.join(testDataRoot, "artifacts/public-survey-footprints/packages/public-euclid-footprints-3.0.0.zip"));
  const manifest = await readResourcePackageManifest(bytes);
  const replaced = manifest.layers.filter((layer) => layer.releaseId === "euclid-ero").map((layer) => layer.layerId);
  const retained = await retainedPackageLayers(testDataRoot, "euclid", replaced);
  const q1 = manifest.layers.filter((layer) => layer.releaseId === "euclid-q1");
  assert.ok(q1.length > 0);
  assert.deepEqual(retained.layers.filter((layer) => layer.releaseId === "euclid-q1"), q1);
  assert.equal(retained.provenance.length, retained.layers.length);
  assert.ok(retained.footprints.some((item) => item.releaseId === "euclid-q1"));
  assertReleaseContinuity(retained.metadata.releases, ["euclid-ero", ...retained.layers.map((layer) => layer.releaseId)]);
  assert.throws(() => assertReleaseContinuity(retained.metadata.releases, ["euclid-ero"]), /euclid-q1/);
});
