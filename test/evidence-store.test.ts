import assert from "node:assert/strict";
import test from "node:test";

import { CoverageEvidenceStore } from "../server/evidence-store.js";

test("warehouse evidence lookup preserves explicit order and source file metadata", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    if (url.includes("astro_file_index_v1")) return new Response(JSON.stringify({ hits: { hits: [{ _id: "file-1", _source: { name: "tile.fits", etag: "abc" } }] } }), { status: 200 });
    return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "edge-1", _source: { layer_id: "desi-dr1-spectra-footprint", survey_id: "desi", order: 4, ipix: 123, source_file_id: "file-1", ra_min: 10, ra_max: 12, dec_min: -2, dec_max: 3 } }] } }), { status: 200 });
  };
  const store = new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl });
  const result = await store.reverseLookup({ layerIds: ["desi-dr1-spectra-footprint"], order: 4, cells: [123] });
  assert.equal(result.available, true);
  assert.equal(result.precision, "exact");
  assert.equal(result.edges[0]?.ipix, 123);
  assert.equal(result.sourceFiles[0]?.name, "tile.fits");
  assert.equal(requests.length, 2);
  const orderClause = requests[0]?.body.query.bool.must[0];
  assert.equal(orderClause?.bool?.minimum_should_match, 1);
  assert.ok(orderClause?.bool?.should.some((clause: any) => clause.term?.order === 4));
});

test("missing warehouse configuration is explicit and non-blocking", async () => {
  const result = await new CoverageEvidenceStore().reverseLookup({ layerIds: ["x"], order: 4, cells: [1] });
  assert.equal(result.available, false);
  assert.equal(result.precision, "entrypoint-only");
  assert.match(result.notes[0] ?? "", /not configured/);
});

test("overlap enrichment can preserve geometry when warehouse evidence is unavailable", async () => {
  const store = new CoverageEvidenceStore({
    url: "http://warehouse:9200",
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  const result = await store.reverseLookup(
    { layerIds: ["csst-sim-w4-image-extent"], order: 8, cells: [742869] },
    { tolerateUnavailable: true },
  );
  assert.equal(result.available, false);
  assert.equal(result.precision, "entrypoint-only");
  assert.match(result.notes[0] ?? "", /temporarily unavailable/);
});
