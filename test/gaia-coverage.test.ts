import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layerRoot = "artifacts/public-survey-footprints/layers/gaia-dr3-main-source-presence";

test("Gaia DR3 coverage is a locked full-sky catalog-presence layer", async () => {
  const [recipe, preview, query, statistics, registry, layerProvenance] = await Promise.all([
    readFile("src/layers/recipes/gaia-dr3-main-source-presence.lock.json", "utf8").then(JSON.parse),
    readFile(`${layerRoot}/preview-order4.json`, "utf8").then(JSON.parse),
    readFile(`${layerRoot}/query-order8.json`, "utf8").then(JSON.parse),
    readFile(`${layerRoot}/statistics.json`, "utf8").then(JSON.parse),
    readFile("src/layers/layer-registry.json", "utf8").then(JSON.parse),
    readFile("artifacts/public-survey-footprints/layers/gaia-dr3-main-source-presence/provenance.json", "utf8").then(JSON.parse),
  ]);

  assert.equal(recipe.coordinateFrame, "ICRS");
  assert.equal(recipe.ordering, "NESTED");
  assert.equal(recipe.coverageRole, "object_presence");
  assert.equal(recipe.dataOrigin, "catalog");
  assert.equal(recipe.snapshot.sha256, "ea7f15e3e2c54daf034a99caf754147d35f0c7353e2925d1dd02c1664f6562f9");
  assert.equal(recipe.snapshot.retrievedAt, "2026-09-02T02:59:38Z");
  assert.equal(recipe.recipe.attributionUrl, "https://www.cosmos.esa.int/web/gaia-users/credits");
  assert.equal(layerProvenance.recipe.attributionUrl, "https://www.cosmos.esa.int/web/gaia-users/credits");
  assert.equal(layerProvenance.snapshot.retrievedAt, "2026-09-02T02:59:38Z");
  assert.deepEqual(recipe.recipe.availableOrders, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(preview.order, 4);
  assert.equal(preview.ordering, "NESTED");
  assert.equal(preview.pixels.length, 12 * 4 ** 4);
  assert.deepEqual(preview.pixels, Array.from({ length: 12 * 4 ** 4 }, (_, pixel) => pixel));
  assert.equal(query.order, 8);
  assert.equal(query.pixels.length, 12 * 4 ** 8);
  assert.equal(statistics.previewPixelCount, preview.pixels.length);
  assert.equal(statistics.queryPixelCount, query.pixels.length);
  assert.ok(statistics.areaDeg2 > 41_251 && statistics.areaDeg2 <= 41_252.96124941927);

  const layer = registry.layers.find((entry: { layerId: string }) => entry.layerId === "gaia-dr3-main-source-presence");
  assert.equal(layer?.status, "acquired");
  assert.equal(layer?.expectedSha256, statistics.mocSha256);
});
