import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildDownloadPlan, CoverageEvidenceStore } from "../server/evidence-store.js";
import { BATCH_EVIDENCE_LAYER_PREFIX, batchEvidenceLayerId } from "../server/scan-batch.js";

test("download plans deduplicate files while retaining every matching cell", () => {
  const plan = buildDownloadPlan({
    edges: [
      { edgeId: "edge-1", layerId: "layer-1", sourceFileId: "file-1", sourceUri: "s3://bucket/catalog.fits", fileName: "catalog.fits", order: 8, ipix: 101, precision: "exact" },
      { edgeId: "edge-2", layerId: "layer-1", sourceFileId: "file-1", sourceUri: "s3://bucket/catalog.fits", fileName: "catalog.fits", order: 8, ipix: 102, precision: "exact" },
      { edgeId: "edge-3", layerId: "layer-2", sourceFileId: "file-2", sourceUri: "https://data.example/image.fits", fileName: "image.fits", order: 8, ipix: 101, precision: "estimated" },
    ],
    sourceFiles: [
      { file_id: "file-1", source_uri: "s3://bucket/catalog.fits", file_name: "catalog.fits", file_type: "FITS", size_bytes: 12, unit_kind: "tile", unit_id: "101", download_provider: "example" },
      { file_id: "file-2", source_uri: "https://data.example/image.fits", file_name: "image.fits", file_type: "FITS", size_bytes: 34 },
    ],
    entrypoints: [{ kind: "coverage-moc", purpose: "coverage-reference", layerId: "layer-1", url: "https://data.example/coverage.moc.fits", precision: "entrypoint-only" }],
    truncated: false,
  });

  assert.equal(plan.files.length, 2);
  assert.deepEqual(plan.files[0]?.matchingCoverage.map((match) => match.ipix), [101, 102]);
  assert.equal(plan.files[0]?.sourceUri, "s3://bucket/catalog.fits");
  assert.equal(plan.files[0]?.downloadable, false);
  assert.equal(plan.files[0]?.downloadUrl, undefined);
  assert.equal(plan.files[0]?.unitKind, "tile");
  assert.equal(plan.files[0]?.unitId, "101");
  assert.equal(plan.files[0]?.downloadProvider, "example");
  assert.equal(plan.files[1]?.downloadable, true);
  assert.equal(plan.files[1]?.downloadUrl, "https://data.example/image.fits");
  assert.equal(plan.entrypoints[0]?.kind, "coverage-moc");
});

test("coverage-only plan evidence remains available without a file or retrieval link", () => {
  const coverageEvidence = {
    layerId: "hst-cosmos-footprint",
    productId: "hst-product",
    surveyId: "hst",
    releaseId: "hst-mast-snapshot-2026",
    product: "HST COSMOS observations",
    evidenceKind: "observation-footprint" as const,
    order: 4,
    nside: 16,
    nativeMaxOrder: 10,
    availableOrders: [4],
    matchedCells: [123],
    precision: "estimated" as const,
    summary: "Published footprint intersects; a science file is not verified.",
  };
  const plan = buildDownloadPlan({ edges: [], sourceFiles: [], coverageEvidence: [coverageEvidence], truncated: false });
  assert.equal(plan.files.length, 0);
  assert.equal(plan.entrypoints.length, 0);
  assert.deepEqual(plan.coverageEvidence, [coverageEvidence]);
});

test("download plans preserve canonical local file URIs as non-downloadable locators", () => {
  const sourceUri = "file:///data/catalogs/roman/image-001.fits";
  const plan = buildDownloadPlan({
    edges: [
      { edgeId: "edge-local", layerId: "roman-images", sourceFileId: "file-local", sourceUri, order: 8, ipix: 456, precision: "exact" },
    ],
    sourceFiles: [
      { file_id: "file-local", source_uri: sourceUri, file_name: "image-001.fits", file_type: "FITS" },
    ],
    truncated: false,
  });

  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]?.sourceUri, sourceUri);
  assert.equal(plan.files[0]?.downloadable, false);
  assert.equal(plan.files[0]?.downloadUrl, undefined);
  assert.deepEqual(plan.files[0]?.matchingCoverage.map((match) => match.ipix), [456]);
});

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
  assert.equal(result.downloadPlan.files.length, 1);
  assert.equal(result.downloadPlan.files[0]?.sourceUri, "oss://tiles/tile.fits");
  assert.equal(result.downloadPlan.files[0]?.downloadable, false);
  assert.equal(result.downloadPlan.files[0]?.downloadUrl, undefined);
  assert.deepEqual(result.downloadPlan.files[0]?.matchingCoverage.map((match) => match.ipix), [123]);
  assert.equal(requests.length, 3);
  const orderClause = requests[1]?.body.query.bool.must[0];
  assert.equal(orderClause?.bool?.minimum_should_match, 1);
  assert.ok(orderClause?.bool?.should.some((clause: any) => clause.term?.healpix_order === 4));
});

test("reverse lookup marks same-file edge truncation and excludes files already shown by a cursor", async () => {
  const layerId = "euclid-q1-vis";
  const requests: Array<{ url: string; body: any }> = [];
  const coverage = [
    { layer_id: layerId, source_file_id: "file-a", healpix_order: 8, healpix_cell: 101, precision: "exact" },
    { layer_id: layerId, source_file_id: "file-a", healpix_order: 8, healpix_cell: 102, precision: "exact" },
    { layer_id: layerId, source_file_id: "file-a", healpix_order: 8, healpix_cell: 103, precision: "exact" },
    { layer_id: layerId, source_file_id: "file-b", healpix_order: 8, healpix_cell: 104, precision: "exact" },
  ];
  const hits = (sources: Record<string, unknown>[], total = sources.length) => new Response(JSON.stringify({
    hits: { total: { value: total }, hits: sources.map((source, index) => ({ _id: `hit-${index}`, _source: source })) },
  }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    if (url.includes("ast_layer_index_v1")) return hits([{ layer_id: layerId, state: "ACTIVE" }]);
    if (url.includes("ast_file_index_v1")) {
      const ids = body.query.bool.should[0].ids.values as string[];
      return hits(ids.filter(id => id === "file-a" || id === "file-b").map(file_id => ({ file_id, file_name: `${file_id}.fits` })));
    }
    const excluded = body.query.bool.must_not?.flatMap((clause: any) => clause.terms?.source_file_id ?? []) ?? [];
    const matched = coverage.filter(edge => !excluded.includes(edge.source_file_id));
    return hits(matched.slice(0, body.size), matched.length);
  };
  const store = new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl });

  const first = await store.reverseLookup({ layerIds: [layerId], order: 8, cells: [101, 102, 103, 104], limit: 2 });
  const firstFile = first.downloadPlan.files.find(file => file.fileId === "file-a");
  assert.equal(firstFile?.matchingCoverage.length, 2);
  assert.equal(firstFile?.matchingCoverageTruncated, true);
  assert.ok(first.downloadPlan.warnings.some(warning => warning.includes("Matching coverage for file file-a")));

  const second = await store.reverseLookup({ layerIds: [layerId], order: 8, cells: [101, 102, 103, 104], excludeFileIds: ["file-a"], limit: 2 });
  assert.deepEqual(second.downloadPlan.files.map(file => file.fileId), ["file-b"]);
  const continuationQuery = requests.filter(request => request.url.includes("ast_coverage_index_v1"))[1]?.body;
  assert.deepEqual(continuationQuery?.query.bool.must_not, [{ terms: { source_file_id: ["file-a"] } }]);
});

function activeAliasFixture(options: { includePublic?: boolean; includeAlias?: boolean; aliasState?: string; aliasMode?: string } = {}) {
  const requests: Array<{ url: string; body: any }> = [];
  const publicLayerId = "euclid-q1-vis";
  const evidenceLayerId = batchEvidenceLayerId(publicLayerId);
  const layers = [
    ...(options.includePublic === false ? [] : [{ layer_id: publicLayerId, state: "ACTIVE" }]),
    ...(options.includeAlias === false ? [] : [{
      layer_id: evidenceLayerId,
      state: options.aliasState ?? "ACTIVE",
      ...(options.aliasMode ? { layer_mode: options.aliasMode } : {}),
    }]),
  ];
  const coverage = [
    { layer_id: publicLayerId, healpix_order: 8, healpix_cell: 101, precision: "exact" },
    { layer_id: evidenceLayerId, healpix_order: 8, healpix_cell: 102, precision: "estimated" },
    { layer_id: "failed-candidate-layer", healpix_order: 8, healpix_cell: 103, precision: "estimated" },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    const sources = url.includes("ast_layer_index_v1") ? layers : coverage;
    return new Response(JSON.stringify({ hits: { total: { value: sources.length }, hits: sources.map((source, index) => ({ _id: String(index), _source: source })) } }));
  };
  return { publicLayerId, evidenceLayerId, requests, store: new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }) };
}

test("ordinary and batch ACTIVE layers can be queried together while edges keep both identities", async () => {
  const { publicLayerId, evidenceLayerId, requests, store } = activeAliasFixture();
  const result = await store.reverseLookup({
    layerIds: [publicLayerId],
    evidenceLayerBindings: [{ layerId: publicLayerId, evidenceLayerId }],
    order: 8,
    cells: [101, 102, 103],
  });

  assert.deepEqual(result.edges.map(edge => [edge.layerId, edge.evidenceLayerId, edge.ipix]), [
    [publicLayerId, publicLayerId, 101],
    [publicLayerId, evidenceLayerId, 102],
  ]);
  assert.ok(JSON.stringify(requests[0]?.body).includes(evidenceLayerId));
  assert.equal(result.downloadPlan.files.find(file => file.matchingCoverage[0]?.evidenceLayerId === evidenceLayerId)?.matchingCoverage[0]?.layerId, publicLayerId);
});

test("reverse lookup tolerates an absent batch alias and can resolve the alias without the public Warehouse layer", async () => {
  const missingAlias = activeAliasFixture({ includeAlias: false });
  const original = await missingAlias.store.reverseLookup({
    layerIds: [missingAlias.publicLayerId],
    evidenceLayerBindings: [{ layerId: missingAlias.publicLayerId, evidenceLayerId: missingAlias.evidenceLayerId }],
    order: 8,
    cells: [101, 102],
  });
  assert.deepEqual(original.edges.map(edge => edge.evidenceLayerId), [missingAlias.publicLayerId]);

  const aliasOnly = activeAliasFixture({ includePublic: false });
  const batch = await aliasOnly.store.reverseLookup({
    layerIds: [aliasOnly.publicLayerId],
    evidenceLayerBindings: [{ layerId: aliasOnly.publicLayerId, evidenceLayerId: aliasOnly.evidenceLayerId }],
    order: 8,
    cells: [101, 102],
  });
  assert.deepEqual(batch.edges.map(edge => [edge.layerId, edge.evidenceLayerId]), [[aliasOnly.publicLayerId, aliasOnly.evidenceLayerId]]);
});

test("candidate and failed batch aliases cannot contribute coverage edges", async () => {
  for (const option of [
    { aliasState: "ACTIVE", aliasMode: "CANDIDATE" },
    { aliasState: "FAILED" },
  ]) {
    const { publicLayerId, evidenceLayerId, store } = activeAliasFixture(option);
    const result = await store.reverseLookup({
      layerIds: [publicLayerId],
      evidenceLayerBindings: [{ layerId: publicLayerId, evidenceLayerId }],
      order: 8,
      cells: [101, 102, 103],
    });
    assert.deepEqual(result.edges.map(edge => edge.evidenceLayerId), [publicLayerId]);
  }
});

test("warehouse reverse lookup exposes a public HTTP file as a direct download", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("ast_layer_index_v1")) return new Response(JSON.stringify({ hits: { hits: [{ _id: "layer-http", _source: { layer_id: "layer-http", state: "ACTIVE" } }] } }), { status: 200 });
    if (url.includes("ast_file_index_v1")) return new Response(JSON.stringify({ hits: { hits: [{ _id: "file-http", _source: {
      file_id: "file-http", file_name: "catalog.fits", file_type: "FITS", source_uri: "https://data.example/catalog.fits", download_url: "https://download.example/catalog.fits", size_bytes: 42,
    } }] } }), { status: 200 });
    return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _id: "edge-http", _source: {
      layer_id: "layer-http", healpix_order: 8, healpix_cell: 456, source_file_id: "file-http", source_uri: "https://data.example/catalog.fits", precision: "exact",
    } }] } }), { status: 200 });
  };
  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).reverseLookup({ layerIds: ["layer-http"], order: 8, cells: [456] });
  const file = result.downloadPlan.files[0];
  assert.equal(file?.metadataState, "complete");
  assert.equal(file?.downloadable, true);
  assert.equal(file?.downloadUrl, "https://download.example/catalog.fits");
  assert.equal(file?.sourceUri, "https://data.example/catalog.fits");
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
  const requests: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
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

  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog({ allowedLayerIds: [layerId], maxDocuments: 10_001 });
  const coverageRequests = requests.filter(({ url, body }) => url.includes("ast_coverage_index_v1") && body.query?.bool?.filter?.some((clause: any) => clause.terms?.layer_id?.includes(layerId)));
  assert.equal(coverageRequests.length, 2);
  assert.equal(coverageRequests[0]?.body.size, 10_000);
  assert.deepEqual(coverageRequests[1]?.body.search_after, last.sort);
  assert.equal(result?.truncated, false);
  assert.equal(result?.coverages.length, 10_001);
  assert.equal(result?.coverages.at(-1)?.ipix, 10_000);
});

test("public coverage catalog excludes batch evidence layers in its query and returned hits", async () => {
  const publicLayerId = "euclid-q1-vis";
  const evidenceLayerId = batchEvidenceLayerId(publicLayerId);
  const requests: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    const sources = url.includes("ast_layer_index_v1")
      ? [
        { layer_id: publicLayerId, survey_id: "euclid", release_id: "q1", product_id: "vis", state: "ACTIVE" },
        { layer_id: evidenceLayerId, survey_id: "euclid", release_id: "q1", product_id: "vis", state: "ACTIVE" },
      ]
      : [
        { layer_id: publicLayerId, healpix_order: 8, healpix_cell: 101, precision: "exact" },
        { layer_id: evidenceLayerId, healpix_order: 8, healpix_cell: 102, precision: "estimated" },
      ];
    return new Response(JSON.stringify({ hits: { total: { value: sources.length }, hits: sources.map((source, index) => ({ _id: String(index), sort: [publicLayerId, String(index), 8, index, "footprint_extent"], _source: source })) } }));
  };

  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog({ allowedLayerIds: [publicLayerId, evidenceLayerId] });
  const layerRequest = requests.find(request => request.url.includes("ast_layer_index_v1"))!;
  const coverageRequest = requests.find(request => request.url.includes("ast_coverage_index_v1"))!;
  assert.ok(layerRequest.body.query.bool.must_not.some((clause: any) => clause.prefix?.layer_id === BATCH_EVIDENCE_LAYER_PREFIX));
  assert.deepEqual(result?.layers.map(layer => layer.layerId), [publicLayerId]);
  assert.deepEqual(coverageRequest.body.query.bool.filter[0]?.terms?.layer_id, [publicLayerId]);
  assert.deepEqual(result?.coverages.map(coverage => [coverage.layerId, coverage.ipix]), [[publicLayerId, 101]]);
});

test("empty public coverage allowlists do not query Warehouse for geometry", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ hits: { hits: [] } }));
  };
  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog({ allowedLayerIds: [] });
  assert.deepEqual(result, { layers: [], coverages: [], truncated: false });
  assert.equal(requests, 0);
});

test("an empty public catalog can still load an explicit bounded draft status allowlist", async () => {
  const draftLayerId = "draft-layer";
  const queries: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    queries.push({ url, body });
    if (!body._source) throw new Error("An empty public catalog must not query geometry layers");
    return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _source: {
      layer_id: draftLayerId, state: "ACTIVE", file_count: 1, coverage_count: 2, error_count: 0,
    } }] } }));
  };
  const store = new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl });
  assert.deepEqual(await store.loadCurrentCoverageCatalog({ allowedLayerIds: [] }), { layers: [], coverages: [], truncated: false });
  const statuses = await store.loadCurrentCoverageLayerStatuses([draftLayerId]);
  assert.equal(statuses[0]?.fileCount, 1);
  assert.equal(statuses[0]?.coverageCount, 2);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.body._source, ["layer_id", "state", "file_count", "coverage_count", "error_count", "updated_at"]);
});

test("catalog coverage reads stay inside the public allowlist and deny private or synthetic layers before search", async () => {
  const publicLayerId = "euclid-q1-vis";
  const queries: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    queries.push({ url, body });
    const sources = url.includes("ast_layer_index_v1")
      ? [
        { layer_id: publicLayerId, survey_id: "euclid", release_id: "q1", product_id: "vis", state: "ACTIVE" },
        { layer_id: "staged-moc-publication", survey_id: "hst", release_id: "draft", product_id: "draft", state: "ACTIVE" },
        { layer_id: "csst-protected", survey_id: "csst", release_id: "private", product_id: "private", state: "ACTIVE" },
      ]
      : [
        { layer_id: publicLayerId, healpix_order: 8, healpix_cell: 101, precision: "exact" },
        { layer_id: "staged-moc-publication", healpix_order: 8, healpix_cell: 102, precision: "estimated" },
        { layer_id: "csst-protected", healpix_order: 8, healpix_cell: 103, precision: "estimated" },
      ];
    return new Response(JSON.stringify({ hits: { total: { value: sources.length }, hits: sources.map((source, index) => ({ _id: String(index), sort: [publicLayerId, String(index), 8, index, "footprint_extent"], _source: source })) } }));
  };

  const result = await new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl }).loadCurrentCoverageCatalog({
    allowedLayerIds: [publicLayerId, "csst-protected", "warehouse-selftest-fixture", "warehouse-caller-fixture", batchEvidenceLayerId(publicLayerId)],
  });
  const layerQuery = queries.find(({ url }) => url.includes("ast_layer_index_v1"))!.body;
  const coverageQuery = queries.find(({ url }) => url.includes("ast_coverage_index_v1"))!.body;
  assert.deepEqual(layerQuery.query.bool.filter[1].terms.layer_id, [publicLayerId]);
  assert.ok(layerQuery.query.bool.must_not.some((clause: any) => clause.terms?.survey_id?.includes("csst")));
  assert.deepEqual(coverageQuery.query.bool.filter[0].terms.layer_id, [publicLayerId]);
  assert.deepEqual(result?.layers.map(layer => layer.layerId), [publicLayerId]);
  assert.deepEqual(result?.coverages.map(coverage => [coverage.layerId, coverage.ipix]), [[publicLayerId, 101]]);
});

test("known draft readiness counts load from layer metadata without querying draft coverage edges", async () => {
  const publicLayerId = "approved-layer";
  const draftLayerId = "draft-layer";
  const queries: Array<{ url: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    queries.push({ url, body });
    if (body._source) return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _source: {
      layer_id: draftLayerId,
      state: "ACTIVE",
      file_count: 42,
      coverage_count: 84,
      error_count: 3,
      updated_at: "2026-09-25T00:00:00.000Z",
    } }] } }));
    if (url.includes("ast_layer_index_v1")) return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{ _source: {
      layer_id: publicLayerId, survey_id: "euclid", release_id: "q1", product_id: "vis", state: "ACTIVE",
    } }] } }));
    if (url.includes("ast_coverage_index_v1")) return new Response(JSON.stringify({ hits: { total: { value: 1 }, hits: [{
      _source: { layer_id: publicLayerId, healpix_order: 8, healpix_cell: 101, precision: "exact" },
    }] } }));
    throw new Error(`Unexpected Warehouse search: ${url}`);
  };

  const store = new CoverageEvidenceStore({ url: "http://warehouse:9200", fetchImpl });
  const result = await store.loadCurrentCoverageCatalog({ allowedLayerIds: [publicLayerId] });
  const statuses = await store.loadCurrentCoverageLayerStatuses([draftLayerId, "csst-private", batchEvidenceLayerId(draftLayerId)]);
  const statusQuery = queries.find(({ body }) => body._source)!.body;
  assert.deepEqual(statusQuery._source, ["layer_id", "state", "file_count", "coverage_count", "error_count", "updated_at"]);
  assert.deepEqual(statusQuery.query.bool.filter[1].terms.layer_id, [draftLayerId]);
  assert.deepEqual(statuses, [{
    layerId: draftLayerId,
    state: "ACTIVE",
    fileCount: 42,
    coverageCount: 84,
    errorCount: 3,
    updatedAt: "2026-09-25T00:00:00.000Z",
  }]);
  const coverageQueries = queries.filter(({ url }) => url.includes("ast_coverage_index_v1"));
  assert.equal(coverageQueries.length, 1);
  assert.deepEqual(coverageQueries[0]?.body.query.bool.filter[0].terms.layer_id, [publicLayerId]);
  assert.equal(JSON.stringify(statuses).includes("source_snapshot"), false);
});

function partitionedEvidenceFixture(options: { corruptScope?: boolean; missingObservation?: boolean; partial?: boolean } = {}) {
  const requests: Array<{ url: string; body: any }> = [];
  const hash = 'a'.repeat(64);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    const hits = (sources: Record<string, unknown>[]) => new Response(JSON.stringify({ hits: { total: { value: sources.length }, hits: sources.map((source, i) => ({ _id: String(i), _source: source })) } }));
    if (url.includes('ast_layer_index_v1')) return hits([{ layer_id: 'q1-vis', state: 'PARTITIONED', layer_mode: 'PARTITIONED', active_scope_id: 'q1-mer', scope_snapshot_sha256: hash, expected_partition_count: 2 }]);
    if (url.includes('ast_partition_index_v1')) return hits([
      { layer_id: 'q1-vis', partition_version: 1, scope_id: 'q1-mer', scope_snapshot_sha256: hash, expected_partition_count: 2, partition_id: 'scope-lock', state: 'SCOPE' },
      { layer_id: 'q1-vis', partition_version: 1, scope_id: 'q1-mer', scope_snapshot_sha256: options.corruptScope ? 'b'.repeat(64) : hash, expected_partition_count: 2, partition_id: 'tile-1', state: 'ACTIVE', active_layer_id: 'candidate-good', active_scan_run_id: 'run-good', pending_layer_id: 'candidate-failed', last_failed_scan_run_id: 'run-failed', source_snapshot_sha256: 'c'.repeat(64), available_orders: [8] },
    ]);
    if (url.includes('ast_file_observation_index_v1')) return hits(options.missingObservation ? [] : [{ layer_id: 'candidate-good', scan_run_id: 'run-good', file_id: 'file-1', file_name: 'tile-1.fits', source_uri: 'oss://public/q1/tile-1.fits', size_bytes: 42 }]);
    if (url.includes('ast_file_index_v1')) throw new Error('Partitioned lookup must never read mutable global file metadata');
    if (options.partial) return new Response(JSON.stringify({ timed_out: true, hits: { hits: [] } }));
    return hits([{ layer_id: 'candidate-good', source_file_id: 'file-1', healpix_order: 8, healpix_cell: 101, precision: 'estimated', source_uri: 'oss://public/q1/tile-1.fits' }]);
  };
  return { requests, store: new CoverageEvidenceStore({ url: 'http://warehouse:9200', fetchImpl }) };
}

test('reverse lookup joins an ordinary layer and a partitioned batch alias with complete match identity', async () => {
  const publicLayerId = 'euclid-q1-vis';
  const evidenceLayerId = batchEvidenceLayerId(publicLayerId);
  const scopeHash = 'a'.repeat(64);
  const fileSnapshotHash = 'b'.repeat(64);
  const observationLayerId = 'batch-candidate-good';
  const requests: Array<{ url: string; body: any }> = [];
  const hits = (sources: Record<string, unknown>[]) => new Response(JSON.stringify({
    hits: { total: { value: sources.length }, hits: sources.map((source, index) => ({ _id: String(index), _source: source })) },
  }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    if (url.includes('ast_layer_index_v1')) return hits([
      { layer_id: publicLayerId, state: 'ACTIVE' },
      { layer_id: evidenceLayerId, state: 'PARTITIONED', layer_mode: 'PARTITIONED', active_scope_id: 'q1-mer', scope_snapshot_sha256: scopeHash, expected_partition_count: 1 },
    ]);
    if (url.includes('ast_partition_index_v1')) return hits([
      { layer_id: evidenceLayerId, partition_version: 1, scope_id: 'q1-mer', scope_snapshot_sha256: scopeHash, expected_partition_count: 1, partition_id: 'scope-lock', state: 'SCOPE' },
      { layer_id: evidenceLayerId, partition_version: 1, scope_id: 'q1-mer', scope_snapshot_sha256: scopeHash, expected_partition_count: 1, partition_id: 'tile-1', state: 'ACTIVE', active_layer_id: observationLayerId, active_scan_run_id: 'run-batch', source_snapshot_sha256: fileSnapshotHash, available_orders: [8] },
    ]);
    if (url.includes('ast_file_observation_index_v1')) return hits([
      { layer_id: observationLayerId, scan_run_id: 'run-batch', file_id: 'batch-file', file_name: 'tile.fits', source_uri: 'oss://survey/tile.fits', size_bytes: 42 },
    ]);
    if (url.includes('ast_file_index_v1')) return hits([
      { file_id: 'ordinary-file', file_name: 'legacy.fits', source_uri: 'oss://survey/legacy.fits' },
    ]);
    return hits([
      { layer_id: publicLayerId, source_file_id: 'ordinary-file', healpix_order: 8, healpix_cell: 101, precision: 'exact' },
      { layer_id: observationLayerId, source_file_id: 'batch-file', healpix_order: 8, healpix_cell: 102, precision: 'estimated', source_uri: 'oss://survey/tile.fits' },
      { layer_id: 'batch-candidate-failed', source_file_id: 'failed-file', healpix_order: 8, healpix_cell: 103, precision: 'estimated' },
    ]);
  };

  const result = await new CoverageEvidenceStore({ url: 'http://warehouse:9200', fetchImpl }).reverseLookup({
    layerIds: [publicLayerId],
    evidenceLayerBindings: [{ layerId: publicLayerId, evidenceLayerId }],
    order: 8,
    cells: [101, 102, 103],
  });
  const edge = result.edges.find(candidate => candidate.evidenceLayerId === evidenceLayerId);
  assert.ok(edge);
  assert.equal(edge.layerId, publicLayerId);
  assert.equal(edge.observationLayerId, observationLayerId);
  assert.equal(edge.scopeId, 'q1-mer');
  assert.equal(edge.partitionId, 'tile-1');
  assert.equal(edge.scanRunId, 'run-batch');
  assert.equal(edge.sourceSnapshotSha256, fileSnapshotHash);
  assert.deepEqual(result.edges.map(candidate => candidate.ipix), [101, 102]);
  assert.deepEqual(result.scanScopes?.map(scope => [scope.layerId, scope.publishedLayerId, scope.completeness]), [[evidenceLayerId, publicLayerId, 'complete']]);
  const match = result.downloadPlan.files.find(file => file.fileId === 'batch-file')?.matchingCoverage[0];
  assert.deepEqual(match && {
    layerId: match.layerId,
    evidenceLayerId: match.evidenceLayerId,
    observationLayerId: match.observationLayerId,
    scopeId: match.scopeId,
    partitionId: match.partitionId,
    scanRunId: match.scanRunId,
    sourceSnapshotSha256: match.sourceSnapshotSha256,
  }, {
    layerId: publicLayerId,
    evidenceLayerId,
    observationLayerId,
    scopeId: 'q1-mer',
    partitionId: 'tile-1',
    scanRunId: 'run-batch',
    sourceSnapshotSha256: fileSnapshotHash,
  });
  const coverageRequest = requests.find(request => request.url.includes('ast_coverage_index_v1'))!;
  const layerRequest = requests.find(request => request.url.includes('ast_layer_index_v1'))!;
  assert.ok(JSON.stringify(layerRequest.body).includes(evidenceLayerId));
  assert.ok(JSON.stringify(coverageRequest.body).includes(observationLayerId));
  assert.ok(!JSON.stringify(coverageRequest.body).includes('batch-candidate-failed'));
  const observationRequest = requests.find(request => request.url.includes('ast_file_observation_index_v1'))!;
  assert.deepEqual(observationRequest.body.query.ids.values, [createHash('sha256').update(`${observationLayerId}\nbatch-file`).digest('hex')]);
});

test('partitioned reverse lookup follows the fixed scope and committed candidate only', async () => {
  const { store, requests } = partitionedEvidenceFixture();
  const result = await store.reverseLookup({ layerIds: ['q1-vis'], order: 8, cells: [101] });
  assert.equal(result.edges[0]?.layerId, 'q1-vis');
  assert.equal(result.edges[0]?.observationLayerId, 'candidate-good');
  assert.equal(result.edges[0]?.scanRunId, 'run-good');
  assert.equal(result.edges[0]?.sourceSnapshotSha256, 'c'.repeat(64));
  assert.equal(result.downloadPlan.files[0]?.sizeBytes, 42);
  assert.equal(result.scanScopes?.[0]?.completeness, 'incomplete');
  assert.equal(result.scanScopes?.[0]?.committedPartitions, 1);
  const queries = JSON.stringify(requests);
  assert.ok(queries.includes('candidate-good'));
  assert.ok(!queries.includes('candidate-failed'));
});

test('partitioned reverse lookup rejects mixed scope snapshots', async () => {
  const { store } = partitionedEvidenceFixture({ corruptScope: true });
  await assert.rejects(store.reverseLookup({ layerIds: ['q1-vis'], order: 8, cells: [101] }), /scope|snapshot/i);
});

test('missing versioned metadata retains evidence without falling back to mutable files', async () => {
  const { store } = partitionedEvidenceFixture({ missingObservation: true });
  const result = await store.reverseLookup({ layerIds: ['q1-vis'], order: 8, cells: [101] });
  assert.equal(result.edges.length, 1);
  assert.equal(result.downloadPlan.files[0]?.metadataState, 'missing');
  assert.equal(result.downloadPlan.files[0]?.sourceUri, 'oss://public/q1/tile-1.fits');
});

test('partial Elasticsearch responses cannot masquerade as no matching data', async () => {
  const { store } = partitionedEvidenceFixture({ partial: true });
  const result = await store.reverseLookup({ layerIds: ['q1-vis'], order: 8, cells: [101] }, { tolerateUnavailable: true });
  assert.equal(result.available, false);
});

test('same file keeps separate committed observations without cross-version metadata overwrite', () => {
  const plan = buildDownloadPlan({
    edges: [
      { edgeId: 'a', layerId: 'vis', observationLayerId: 'candidate-a', scanRunId: 'run-a', sourceFileId: 'file', order: 8, ipix: 1, precision: 'estimated' },
      { edgeId: 'b', layerId: 'vis', observationLayerId: 'candidate-b', scanRunId: 'run-b', sourceFileId: 'file', order: 8, ipix: 2, precision: 'estimated' },
    ],
    sourceFiles: [
      { file_id: 'file', layer_id: 'candidate-a', scan_run_id: 'run-a', size_bytes: 42 },
      { file_id: 'file', layer_id: 'candidate-b', scan_run_id: 'run-b', size_bytes: 84 },
    ], truncated: false,
  });
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]?.sizeBytes, undefined);
  assert.deepEqual(plan.files[0]?.observations?.map(value => value.sizeBytes), [42, 84]);
  assert.deepEqual(plan.files[0]?.matchingCoverage.map(value => value.scanRunId), ['run-a', 'run-b']);
  assert.match(plan.warnings.join(' '), /differing committed observations/);
});

test('a candidate layer cannot be used as a public logical layer', async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ hits: { hits: [{ _source: { layer_id: 'candidate', state: 'ACTIVE', layer_mode: 'CANDIDATE' } }] } }));
  };
  await assert.rejects(new CoverageEvidenceStore({ url: 'http://warehouse:9200', fetchImpl }).reverseLookup({ layerIds: ['candidate'], order: 8, cells: [1] }), /not ACTIVE/);
  assert.equal(requests, 1);
});

test('partitioned catalog reads only committed candidates and keeps logical identity', async () => {
  const hash = 'a'.repeat(64);
  const queries: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); const body = JSON.parse(String(init?.body)); queries.push(JSON.stringify(body));
    let sources: Record<string, unknown>[];
    if (url.includes('ast_layer_index_v1')) sources = [{ layer_id: 'vis', survey_id: 'euclid', release_id: 'q1', product_id: 'vis-product', state: 'PARTITIONED', layer_mode: 'PARTITIONED', active_scope_id: 'q1', scope_snapshot_sha256: hash, expected_partition_count: 2 }];
    else if (url.includes('ast_partition_index_v1')) sources = [
      { layer_id: 'vis', scope_id: 'q1', scope_snapshot_sha256: hash, expected_partition_count: 2, partition_version: 1, partition_id: 'scope-lock', state: 'SCOPE' },
      { layer_id: 'vis', scope_id: 'q1', scope_snapshot_sha256: hash, expected_partition_count: 2, partition_version: 1, partition_id: 'tile', state: 'ACTIVE', active_layer_id: 'candidate', active_scan_run_id: 'run', source_snapshot_sha256: hash, available_orders: [8], file_count: 1, coverage_count: 1 },
    ];
    else sources = [{ layer_id: 'candidate', source_file_id: 'file', healpix_order: 8, healpix_cell: 101, precision: 'estimated' }];
    return new Response(JSON.stringify({ hits: { total: { value: sources.length }, hits: sources.map(source => ({ _source: source })) } }));
  };
  const result = await new CoverageEvidenceStore({ url: 'http://warehouse:9200', fetchImpl }).loadCurrentCoverageCatalog({ allowedLayerIds: ['vis'] });
  assert.equal(result?.layers[0]?.scanScope?.completeness, 'incomplete');
  assert.deepEqual(result?.layers[0]?.availableOrders, [8]);
  assert.equal(result?.layers[0]?.fileCount, 1);
  assert.equal(result?.coverages[0]?.layerId, 'vis');
  assert.ok(queries[0]?.includes('CANDIDATE'));
  assert.ok(queries.at(-1)?.includes('candidate'));
});
