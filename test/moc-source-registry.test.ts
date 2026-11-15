import { OFFICIAL_MOC_SOURCES } from "../server/official-moc-sources.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MOC source registry separates catalog presence from image footprints", async () => {
  const registry = JSON.parse(await readFile("src/moc-sources/source-registry.json", "utf8")) as {
    coordinateFrame: string;
    ordering: string;
    sourcePolicy: { previewOrder: number; releaseRequires: string[] };
    sources: Array<{ id: string; surveyId?: string; releaseId?: string; sourceKind: string; mocUrl: string; maxOrder: number; overviewOrder: number; coverageRole: string; dataOrigin: string; sourceTier: string; precision: string; licenseStatus: string; status: string; attributionUrl?: string }>;
  };
  assert.equal(registry.coordinateFrame, "ICRS");
  assert.equal(registry.ordering, "NESTED");
  assert.equal(registry.sourcePolicy.previewOrder, 4);
  assert.ok(registry.sourcePolicy.releaseRequires.includes("sourceSnapshotSha256"));
  assert.equal(new Set(registry.sources.map((source) => source.id)).size, registry.sources.length);
  assert.ok(registry.sources.length >= 8);
  for (const source of registry.sources) {
    const url = new URL(source.mocUrl);
    if (["official-hips-moc", "official-archive-moc"].includes(source.sourceKind)) {
      assert.equal(url.href, OFFICIAL_MOC_SOURCES[source.id]?.mocUrl);
      assert.equal(source.sourceTier, "official_geometry");
      assert.equal(source.releaseId, OFFICIAL_MOC_SOURCES[source.id]?.releaseId);
    } else {
      assert.equal(url.searchParams.get("get"), "smoc");
      assert.equal(url.searchParams.get("fmt"), "fits");
      assert.equal(Number(url.searchParams.get("order")), source.maxOrder);
      assert.equal(source.sourceTier, "third_party_moc");
    }
    assert.ok(source.overviewOrder <= source.maxOrder);
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
  for (const id of ["skymapper-dr4-color-footprint", "kids-dr5-color-footprint", "vista-viking-j-footprint", "decals-dr5-color-footprint"]) {
    assert.equal(registry.sources.find((source) => source.id === id)?.status, "acquired", `${id} must have a locked snapshot before release`);
  }
  assert.equal(registry.sources.find((source) => source.id === "gaia-dr3-main-source")?.status, "acquired");
  assert.match(registry.sources.find((source) => source.id === "gaia-dr3-main-source")?.licenseStatus ?? "", /^reviewed-/);
  assert.equal(registry.sources.find((source) => source.id === "gaia-dr3-main-source")?.attributionUrl, "https://www.cosmos.esa.int/web/gaia-users/credits");
  for (const [releaseId, sourceIds] of [
    ["euclid-ero", [
      "euclid-euclid-ero-ero-first-images-moc", "euclid-euclid-ero-ero-nisp-h-moc", "euclid-euclid-ero-ero-nisp-j-moc",
      "euclid-euclid-ero-ero-nisp-y-moc", "euclid-euclid-ero-ero-vis-moc", "euclid-euclid-ero-ero-color-imaging-moc",
    ]],
    ["euclid-q1", [
      "euclid-euclid-q1-euclid-q1-nisp-h-moc", "euclid-euclid-q1-euclid-q1-nisp-j-moc", "euclid-euclid-q1-euclid-q1-nisp-y-moc",
      "euclid-euclid-q1-euclid-q1-vis-moc", "euclid-euclid-q1-euclid-q1-color-imaging-moc",
    ]],
  ] as const) {
    for (const sourceId of sourceIds) {
      const source = registry.sources.find((entry) => entry.id === sourceId);
      assert.equal(source?.status, "acquired", `${sourceId} must have a locked snapshot`);
      assert.equal(source?.surveyId, "euclid");
      assert.equal(source?.releaseId, releaseId);
    }
  }
  for (const id of ["erass1-main-source-presence", "xmm-4xmm-dr13-source-presence", "planck-hfi-857-footprint"]) {
    assert.equal(registry.sources.find((source) => source.id === id)?.status, "candidate", `${id} remains blocked pending terms review`);
  }
  for (const id of ["erass1-main-source-presence", "planck-hfi-857-footprint"]) {
    const source = registry.sources.find((entry) => entry.id === id);
    assert.equal(source?.maxOrder, 8, `${id} must retain its native order-8 precision`);
  }
});


test("Euclid's current additions are Foundation Wide/Deep Tile footprints with separate locked inputs", async () => {
  const catalog = JSON.parse(await readFile("src/surveys/survey-catalog.json", "utf8"));
  const euclid = catalog.surveys.find((survey: { id: string }) => survey.id === "euclid");
  const release = euclid.releases.find((release: { id: string }) => release.id === "euclid-dr1-foundation");
  assert.equal(release.label, "DR1-Foundation");
  assert.equal(release.releasedYear, 2026);
  assert.equal(release.products.length, 2);
  assert.equal(euclid.releases.some((release: { id: string }) => release.id === "euclid-dr1"), false, "2027 full DR1 is not this release");
  const hashes = new Set<string>();
  for (const field of ["wide", "deep"]) {
    const id = `euclid-dr1-foundation-${field}-tiles-moc`;
    const recipe = JSON.parse(await readFile(`src/layers/recipes/${id}.lock.json`, "utf8"));
    assert.equal(recipe.releaseId, release.id);
    assert.equal(recipe.recipe.sourceMocUrl, `https://irsa.ipac.caltech.edu/data/MOC/euclid_dr1_${field}.moc.moc.fits`);
    assert.match(recipe.recipe.precisionJustification, /Tile extent/);
    assert.equal(recipe.maxOrder, 13); assert.equal(recipe.queryOrder, 8); assert.equal(recipe.previewOrder, 4);
    for (const kind of ["moc", "query", "preview"]) assert.match(recipe.expectedOutputs[kind].sha256, /^[a-f0-9]{64}$/);
    hashes.add(recipe.snapshot.sha256);
  }
  assert.equal(hashes.size, 2);
});
