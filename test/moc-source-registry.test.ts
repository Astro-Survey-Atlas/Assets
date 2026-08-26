import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MOC source registry separates catalog presence from image footprints", async () => {
  const registry = JSON.parse(await readFile("src/moc-sources/source-registry.json", "utf8")) as {
    coordinateFrame: string;
    ordering: string;
    sourcePolicy: { previewOrder: number; releaseRequires: string[] };
    sources: Array<{ id: string; sourceKind: string; mocUrl: string; maxOrder: number; overviewOrder: number; coverageRole: string; dataOrigin: string; sourceTier: string; precision: string; licenseStatus: string; status: string }>;
  };
  assert.equal(registry.coordinateFrame, "ICRS");
  assert.equal(registry.ordering, "NESTED");
  assert.equal(registry.sourcePolicy.previewOrder, 4);
  assert.ok(registry.sourcePolicy.releaseRequires.includes("sourceSnapshotSha256"));
  assert.equal(new Set(registry.sources.map((source) => source.id)).size, registry.sources.length);
  assert.ok(registry.sources.length >= 8);
  for (const source of registry.sources) {
    const url = new URL(source.mocUrl);
    assert.equal(url.searchParams.get("get"), "smoc");
    assert.equal(url.searchParams.get("fmt"), "fits");
    assert.equal(Number(url.searchParams.get("order")), source.maxOrder);
    assert.ok(source.overviewOrder <= source.maxOrder);
    assert.equal(source.sourceTier, "third_party_moc");
    assert.notEqual(source.status, "acquired", "unlocked research candidates must not enter the public release");
    assert.ok(source.licenseStatus);
    if (source.sourceKind === "catalog-moc") {
      assert.equal(source.coverageRole, "object_presence");
      assert.equal(source.dataOrigin, "catalog");
      assert.equal(source.precision, "exact");
    } else {
      assert.equal(source.coverageRole, "footprint_extent");
      assert.equal(source.dataOrigin, "observed");
    }
  }
  for (const id of ["erass1-main-source-presence", "planck-hfi-857-footprint"]) {
    const source = registry.sources.find((entry) => entry.id === id);
    assert.equal(source?.maxOrder, 8, `${id} must retain its native order-8 precision`);
  }
});
