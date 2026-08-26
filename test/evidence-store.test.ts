import assert from "node:assert/strict";
import test from "node:test";

import { CoverageEvidenceStore } from "../server/evidence-store.js";

test("warehouse evidence lookup preserves explicit order and source file metadata", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    if (url.includes("ast_layer_index_v1")) return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "desi-dr1-spectra-footprint", _source: { layer_id: "desi-dr1-spectra-footprint", state: "ACTIVE" } }] } }), { status: 200 });
    if (url.includes("ast_file_index_v1")) return new Response(JSON.stringify({ hits: { hits: [{ _id: "file-1", _source: { file_name: "tile.fits", etag: "abc" } }] } }), { status: 200 });
    return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "edge-1", _source: { layer_id: "desi-dr1-spectra-footprint", order: 4, ipix: 123, source_file_id: "file-1", source_uri: "oss://tiles/tile.fits", precision: "exact" } }] } }), { status: 200 });
  };
  const store = new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl });
  const result = await store.reverseLookup({ layerIds: ["desi-dr1-spectra-footprint"], order: 4, cells: [123] });
  assert.equal(result.available, true);
  assert.equal(result.precision, "exact");
  assert.equal(result.edges[0]?.ipix, 123);
  assert.equal(result.sourceFiles[0]?.file_name, "tile.fits");
  assert.equal(requests.length, 3);
  const orderClause = requests[1]?.body.query.bool.must[0];
  assert.equal(orderClause?.bool?.minimum_should_match, 1);
  assert.ok(orderClause?.bool?.should.some((clause: any) => clause.term?.healpix_order === 4));
});

test("warehouse coverage contract fields are normalized for reverse lookup", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("ast_layer_index_v1")) return new Response(JSON.stringify({ hits: { hits: [{ _id: "layer-1", _source: { layer_id: "layer-1", state: "ACTIVE" } }] } }), { status: 200 });
    if (url.includes("ast_file_index_v1")) return new Response(JSON.stringify({ hits: { hits: [{ _id: "file-1", _source: { file_id: "file-1", file_name: "catalog.csv" } }] } }), { status: 200 });
    return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "edge-1", _source: {
      layer_id: "layer-1", healpix_order: 8, healpix_cell: 185860, source_file_id: "file-1",
      source_uri: "s3://catalog.csv", coverage_method: "catalog_radec", precision: "exact",
    } }] } }), { status: 200 });
  };
  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).reverseLookup({ layerIds: ["layer-1"], order: 8, cells: [185860] });
  assert.equal(result.available, true);
  assert.equal(result.edges[0]?.ipix, 185860);
  assert.equal(result.edges[0]?.order, 8);
  assert.equal(result.edges[0]?.sourceUri, "s3://catalog.csv");
  assert.equal(result.sourceFiles[0]?.file_name, "catalog.csv");
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

test("warehouse coverage catalog paginates an ACTIVE layer beyond the Elasticsearch 10,000-hit window", async () => {
  const layerId = "large-layer";
  const page = Array.from({ length: 10_000 }, (_, index) => {
    const sourceFileId = `file-${String(index).padStart(5, "0")}`;
    return {
      _id: `edge-${index}`,
      sort: [layerId, sourceFileId, 8, index, "footprint_extent"],
      _source: {
        layer_id: layerId,
        source_file_id: sourceFileId,
        source_uri: `s3://coverage/${sourceFileId}.fits`,
        healpix_order: 8,
        healpix_cell: index,
        coverage_role: "footprint_extent",
        precision: "exact",
      },
    };
  });
  const last = page.at(-1)!;
  const requests: Array<{ body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ body });
    if (url.includes("ast_layer_index_v1")) {
      return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: layerId, _source: {
        layer_id: layerId, survey_id: "large-survey", release_id: "r1", product_id: "p1", state: "ACTIVE",
        available_orders: [8], coverage_count: 10_001,
      } }] } }), { status: 200 });
    }
    if (!body.search_after) {
      return new Response(JSON.stringify({ hits: { total: { value: 10_001 }, hits: page } }), { status: 200 });
    }
    return new Response(JSON.stringify({ hits: { total: { value: 10_001 }, hits: [{
      _id: "edge-10000",
      sort: [layerId, "file-10000", 8, 10_000, "footprint_extent"],
      _source: { layer_id: layerId, source_file_id: "file-10000", source_uri: "s3://coverage/file-10000.fits", healpix_order: 8, healpix_cell: 10_000, coverage_role: "footprint_extent", precision: "exact" },
    }] } }), { status: 200 });
  };

  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog(10_001);
  const coverageRequests = requests.filter(({ body }) => body.query?.bool?.filter?.some((clause: any) => clause.term?.layer_id === layerId));
  assert.equal(coverageRequests.length, 2);
  assert.equal(coverageRequests[0]?.body.size, 10_000);
  assert.deepEqual(coverageRequests[1]?.body.search_after, last.sort);
  assert.equal(result?.truncated, false);
  assert.equal(result?.coverages.length, 10_001);
  assert.equal(result?.coverages.at(-1)?.ipix, 10_000);
});
