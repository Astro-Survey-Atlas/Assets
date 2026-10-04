import assert from "node:assert/strict";
import test from "node:test";
import { CoverageEvidenceStore } from "../server/evidence-store.js";

const metadata = (layerId: string) => ({ layer_id: layerId, survey_id: "desi", release_id: "dr1", product_id: layerId, state: "ACTIVE", available_orders: [8], coverage_count: 266_051 });
const rows = (sources: Record<string, unknown>[]) => new Response(JSON.stringify({ hits: { hits: sources.map(_source => ({ _source })) } }));

test("all 266,051 unique O8 cells load without the old 200,000-document limit", async () => {
  let pages = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("ast_layer_index_v1")) return rows([metadata("desi")]);
    assert.equal(body.size, 0);
    assert.equal(body._source, false);
    assert.ok(body.aggs, "coverage startup must request aggregated geometry, never file documents");
    const start = (body.aggs.cells.composite.after?.ipix ?? -1) + 1;
    const end = Math.min(start + body.aggs.cells.composite.size, 266_051);
    pages++;
    const buckets = Array.from({ length: end - start }, (_, i) => ({ key: { layerId: "desi", order: 8, ipix: start + i }, doc_count: 4 }));
    return new Response(JSON.stringify({ aggregations: { cells: { buckets, ...(end < 266_051 ? { after_key: buckets.at(-1)!.key } : {}) } } }));
  };
  const snapshot = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog({ allowedLayerIds: ["desi"] });
  assert.equal(snapshot?.coverages.length, 266_051);
  assert.equal(snapshot?.coverages.at(-1)?.ipix, 266_050);
  assert.equal(snapshot?.truncated, false);
  assert.equal(pages, 27);
  assert.deepEqual(Object.keys(snapshot!.coverages[0]!).sort(), ["ipix", "layerId", "order"]);
});

test("a failed geometry page discards only that layer and retains the successful layer", async () => {
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("ast_layer_index_v1")) return rows([metadata("failed"), metadata("loaded")]);
    const layerId = body.query.bool.filter[0].terms.layer_id[0];
    if (layerId === "failed" && body.aggs.cells.composite.after) return new Response("", { status: 503 });
    const key = { layerId, order: 8, ipix: 101 };
    return new Response(JSON.stringify({ aggregations: { cells: { buckets: [{ key, doc_count: 200_001 }], ...(layerId === "failed" ? { after_key: key } : {}) } } }));
  };
  const snapshot = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog({ allowedLayerIds: ["failed", "loaded"] });
  assert.deepEqual(snapshot?.coverages, [{ layerId: "loaded", order: 8, ipix: 101 }]);
  assert.equal(snapshot?.layers.length, 2, "layer scan counters remain available even when geometry fails");
  assert.equal(snapshot?.truncated, true);
  assert.deepEqual(snapshot?.failures, [{ layerId: "failed", reason: "Warehouse evidence search returned HTTP 503" }]);
});

test("a repeated aggregation cursor is an explicit layer failure", async () => {
  const key = { layerId: "desi", order: 8, ipix: 101 };
  const fetchImpl: typeof fetch = async url => String(url).includes("ast_layer_index_v1") ? rows([metadata("desi")])
    : new Response(JSON.stringify({ aggregations: { cells: { buckets: [{ key, doc_count: 1 }], after_key: key } } }));
  const snapshot = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog({ allowedLayerIds: ["desi"] });
  assert.deepEqual(snapshot?.coverages, []);
  assert.match(snapshot?.failures?.[0]?.reason ?? "", /cursor did not advance/);
});

test("regional file pagination ends despite Elasticsearch reporting the full-query total", async () => {
  const queries: any[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).includes("ast_layer_index_v1")) return rows([metadata("desi")]);
    if (String(url).includes("ast_file_index_v1")) return rows([{ file_id: "file", source_uri: "oss://survey/tiles/file.fits", scan_run_id: "run", file_name: "file.fits" }]);
    queries.push(body);
    const start = body.search_after ? 2 : 0;
    const hits = Array.from({ length: body.search_after ? 1 : 3 }, (_, i) => {
      const cell = 190 * 256 + start + i;
      return { sort: ["file", "desi", 8, cell, "extent"], _source: { layer_id: "desi", source_file_id: "file", healpix_order: 8, healpix_cell: cell, source_uri: "oss://survey/tiles/file.fits", scan_run_id: "run", source_snapshot_sha256: "a".repeat(64), precision: "exact" } };
    });
    return new Response(JSON.stringify({ hits: { total: { value: 3 }, hits } }));
  };
  const store = new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl });
  const first = await store.reverseLookup({ layerIds: ["desi"], order: 4, cells: [190], limit: 2 });
  assert.equal(first.truncated, true);
  assert.equal(first.edges.length, 2);
  assert.ok(first.nextSearchAfter);
  const last = await store.reverseLookup({ layerIds: ["desi"], order: 4, cells: [190], limit: 2, searchAfter: first.nextSearchAfter });
  assert.equal(last.truncated, false);
  assert.equal(last.nextSearchAfter, undefined);
  const match = last.downloadPlan.files[0]?.matchingCoverage[0];
  assert.equal(match?.order, 4);
  assert.equal(match?.ipix, 190);
  assert.equal(match?.sourceOrder, 8);
  assert.equal(match?.sourceIpix, 190 * 256 + 2);
  assert.equal(match?.scanRunId, "run");
  assert.equal(match?.sourceSnapshotSha256, "a".repeat(64));
  assert.equal(last.downloadPlan.files[0]?.sourceUri, "oss://survey/tiles/file.fits");
  assert.ok(JSON.stringify(queries[0]).includes('"healpix_order":8'));
  assert.ok(JSON.stringify(queries[0]).includes('"range":{"healpix_cell":{"gte":48640,"lt":48896}}'));
});

test("a finer regional request never manufactures descendants of a coarser Warehouse cell", async () => {
  let coverageRequests = 0;
  const fetchImpl: typeof fetch = async url => {
    if (String(url).includes("ast_layer_index_v1")) return rows([{ ...metadata("desi"), available_orders: [4] }]);
    coverageRequests++;
    return rows([]);
  };
  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).reverseLookup({ layerIds: ["desi"], order: 8, cells: [48640] });
  assert.equal(result.edges.length, 0);
  assert.equal(coverageRequests, 0);
});
