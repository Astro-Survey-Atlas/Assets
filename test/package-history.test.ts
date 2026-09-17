import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { historicalPackages } from "../server/package-history.js";
import { DynamicResourcePackageStore } from "../server/resource-package-publication.js";
import { readResourcePackageManifest, readZipEntry } from "../server/resource-package-inspection.js";
import { testDataRoot } from "./test-data-root.js";

test("historical collections restore missing versions and repair lost 2MASS/GALEX Releases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "package-history-"));
  try {
    const recovered = await historicalPackages(testDataRoot);
    assert.equal(recovered.length, 5);
    const store = new DynamicResourcePackageStore(root);
    await store.repairHistoricalReleases(testDataRoot);
    assert.equal(store.list().length, 2);
    for (const survey of ["2mass", "galex"]) {
      const entry = store.latest(`public-${survey}-footprints`)!;
      assert.equal(entry.version, "3.2.0");
      assert.equal(entry.releases.length, 2);
      const asset = store.assets().find((item) => item.surveyId === survey)!;
      const bytes = await readFile(path.join(root, asset.path));
      const previous = recovered.find((item) => item.entry.surveyId === survey)!;
      const oldManifest = await readResourcePackageManifest(previous.bytes);
      const manifest = await readResourcePackageManifest(bytes);
      assert.equal(manifest.layers.length, 6);
      for (const layer of oldManifest.layers) assert.deepEqual(await readZipEntry(bytes, layer.path), await readZipEntry(previous.bytes, layer.path));
    }
    await store.repairHistoricalReleases(testDataRoot);
    assert.equal(store.list().length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
