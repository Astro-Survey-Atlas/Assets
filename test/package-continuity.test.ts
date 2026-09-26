import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { retainedPackageLayers, assertReleaseContinuity } from "../server/package-continuity.js";
import { testDataRoot } from "./test-data-root.js";
import { readResourcePackageManifest } from "../server/resource-package-inspection.js";

test("incremental ERO publication retains the baseline Q1 MOCs and provenance", async () => {
  const base = path.join(testDataRoot, "artifacts/public-survey-footprints/packages");
  const catalog = JSON.parse(await readFile(path.join(base, "catalog.json"), "utf8"));
  const current = catalog.packages.find((item: { id: string }) => item.id === "public-euclid-footprints");
  const bytes = await readFile(path.join(base, `${current.id}-${current.version}.zip`));
  const manifest = await readResourcePackageManifest(bytes);
  const replaced = manifest.layers.filter((layer) => layer.releaseId === "euclid-ero").map((layer) => layer.layerId);
  const retained = await retainedPackageLayers(testDataRoot, "euclid", replaced);
  const q1 = manifest.layers.filter((layer) => layer.releaseId === "euclid-q1");
  assert.ok(q1.length > 0);
  const retainedQ1 = retained.layers.filter((layer) => layer.releaseId === "euclid-q1");
  assert.equal(retainedQ1.length, q1.length);
  for (const layer of q1) {
    const kept = retainedQ1.find((item) => item.layerId === layer.layerId)!;
    assert.ok(kept);
    // Legacy manifests may gain product identity from their original provenance;
    // every already-declared field and the scientific geometry must remain intact.
    assert.deepEqual(Object.fromEntries(Object.entries(kept).filter(([key]) => key in layer)), layer);
    assert.ok(kept.product);
    assert.match(kept.productId!, /^[a-f0-9]{20}$/);
    assert.equal(createHash("sha256").update(retained.entries.get(layer.path)!).digest("hex"), layer.sha256);
  }
  assert.equal(retained.provenance.length, retained.layers.length);
  assert.ok(retained.footprints.some((item) => item.releaseId === "euclid-q1"));
  assertReleaseContinuity(retained.metadata.releases, ["euclid-ero", ...retained.layers.map((layer) => layer.releaseId)]);
  assert.throws(() => assertReleaseContinuity(retained.metadata.releases, ["euclid-ero"]), /euclid-q1/);
});
