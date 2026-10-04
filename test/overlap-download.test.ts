import assert from "node:assert/strict";
import test from "node:test";

import { mergeDownloadPlans, OVERLAP_DOWNLOAD_HEADER, overlapCsvRows, type DownloadPlan } from "../site/src/overlap-download.js";

const component = {
  id: "C09",
  order: 8,
  cells: [101, 102],
  bounds: { raMin: 146.4, raMax: 149.6, decMin: -15.4, decMax: -12.0, areaDeg2: 5.35 },
};

const layer = { surveyId: "desi", releaseId: "desi-dr1", product: "DR1 spectra", modality: "spectroscopy" };

function record(row: string[]): Record<string, string> {
  return Object.fromEntries(OVERLAP_DOWNLOAD_HEADER.map((key, index) => [key, row[index] ?? ""]));
}

test("manifest pagination keeps distinct native scan cells inside one requested coarse cell", () => {
  const match = { layerId: "desi", order: 4, ipix: 190, sourceOrder: 8, sourceIpix: 48640, precision: "exact", scanRunId: "run" };
  const file = { fileId: "file", metadataState: "complete" as const, sourceUri: "oss://survey/file.fits", downloadable: false, matchingCoverage: [match] };
  const unit = { layerId: "desi", productId: "p", surveyId: "desi", releaseId: "dr1", product: "spectra", unitKind: "tile", unitId: "82406", order: 4, nside: 16,
    matchingCells: [190], precision: "estimated", scannedFiles: [{ fileId: "file", scanRunId: "run", matchingCoverage: [match] }] };
  const first: DownloadPlan = { schemaVersion: 1, files: [file], spatialUnits: [unit], entrypoints: [], truncated: true, warnings: [] };
  const nextMatch = { ...match, sourceIpix: 48641 };
  const merged = mergeDownloadPlans(first, { ...first, files: [{ ...file, matchingCoverage: [nextMatch] }],
    spatialUnits: [{ ...unit, scannedFiles: [{ ...unit.scannedFiles[0]!, matchingCoverage: [nextMatch] }] }], truncated: false });
  assert.deepEqual(merged.files[0]?.matchingCoverage.map(value => value.sourceIpix), [48640, 48641]);
  assert.deepEqual(merged.spatialUnits?.[0]?.scannedFiles?.[0]?.matchingCoverage?.map(value => value.sourceIpix), [48640, 48641]);
  const rows = overlapCsvRows({ ...component, order: 4, cells: [190] }, merged, () => layer).map(record);
  assert.deepEqual(JSON.parse(rows.find(row => row.item_kind === "file")!.matching_cells!).map((value: { sourceIpix: number }) => value.sourceIpix), [48640, 48641]);
});

test("empty download plans do not manufacture placeholder rows", () => {
  const plan: DownloadPlan = { schemaVersion: 1, files: [], entrypoints: [], truncated: false, warnings: [] };
  assert.deepEqual(overlapCsvRows(component, plan, () => layer), []);
});

test("Connector identity and icon survive pagination and both attached and supporting CSV records", () => {
  const connectors = [{ name: "euclid-mirror", type: "oss", iconUrl: "/api/v1/connector-icons/custom", identityBasis: "scan-scope" as const }];
  const match = { layerId: "euclid-q1-h", order: 8, ipix: 101, precision: "estimated", scanRunId: "scan-h" };
  const file = { fileId: "file", metadataState: "complete" as const, sourceUri: "oss://repository/q1/h.fits", downloadable: false, matchingCoverage: [match], connectors };
  const scannedFile = { fileId: "attached", sourceUri: "oss://repository/q1/attached.fits", scanRunId: "scan-h", matchingCoverage: [match], connectors };
  const unit = { layerId: "euclid-q1-h", productId: "q1-h", surveyId: "euclid", releaseId: "euclid-q1", product: "NISP.H", unitKind: "tile", unitId: "102157301",
    order: 8, nside: 256, matchingCells: [101], precision: "estimated", scannedFiles: [scannedFile] };
  const first: DownloadPlan = { schemaVersion: 1, spatialUnits: [unit], files: [file], entrypoints: [], warnings: [], truncated: true };
  const { connectors: _fileProvider, ...continuedFile } = file;
  const { connectors: _scanProvider, ...continuedScan } = scannedFile;
  const merged = mergeDownloadPlans(first, { ...first, truncated: false, files: [continuedFile], spatialUnits: [{ ...unit, scannedFiles: [continuedScan] }] });
  assert.deepEqual(merged.files[0]?.connectors, connectors);
  assert.deepEqual(merged.spatialUnits?.[0]?.scannedFiles?.[0]?.connectors, connectors);
  const rows = overlapCsvRows(component, merged, () => layer).map(record);
  const attached = JSON.parse(rows.find(row => row.item_kind === "spatial-unit")!.file_observations!)[0];
  const supporting = rows.find(row => row.item_kind === "file")!;
  assert.deepEqual(attached.connectors, connectors);
  assert.equal(attached.sourceUri, scannedFile.sourceUri);
  assert.deepEqual(JSON.parse(supporting.source_metadata!).connectors, connectors);
  assert.equal(supporting.source_uri, file.sourceUri);
  assert.equal(supporting.downloadable, "false");
  assert.equal(supporting.download_url, "");
  const secondConnector = { name: "second-mirror", type: "s3", identityBasis: "scan-run" as const };
  const otherObservation = { ...file, connectors: [secondConnector], matchingCoverage: [{ ...match, scanRunId: "other-scan" }] };
  assert.deepEqual(mergeDownloadPlans(first, { ...first, files: [otherObservation] }).files[0]?.connectors, [...connectors, secondConnector]);
});

test("native-unit CSV preserves all URIs, footprint, source policy and snapshot manifest status", () => {
  const unit = { layerId: "euclid-ero", productId: "ero", surveyId: "euclid", releaseId: "euclid-ero", product: "ERO", modality: "imaging",
    unitKind: "target", unitId: "ERO-Abell2390", order: 8, nside: 256, matchingCells: [101, 102], precision: "estimated",
    accessUri: "https://example.test/vis.tar", accessUris: [{ uri: "https://example.test/vis.tar", fileName: "vis.tar" }, { uri: "https://example.test/nisp.tar", fileName: "nisp.tar" }],
    accessAvailability: "source-policy" as const, sRegion: "POLYGON ICRS 1 1 2 1 2 2 1 2", sourceUrl: "https://example.test/metadata", instrument: "VIS", filters: "VIS",
    sourceSnapshotSha256: "a".repeat(64), scannedFiles: [{ fileId: "file-1", scanRunId: "scan-1" }], note: "Outreach target extent" };
  const plan: DownloadPlan = { schemaVersion: 1, spatialUnits: [unit], files: [], entrypoints: [], truncated: true, warnings: ["Limited preview"] };
  const rows = overlapCsvRows(component, plan, () => layer, "estimated", { snapshotId: "b".repeat(64), omitted: 5, hasMore: true }).map(record);
  assert.deepEqual(JSON.parse(rows[0]!.access_uris!), unit.accessUris);
  assert.equal(rows[0]!.s_region, unit.sRegion);
  assert.equal(rows[0]!.access_availability, unit.accessAvailability);
  assert.equal(rows[0]!.source_url, unit.sourceUrl);
  assert.equal(rows[0]!.science_file_scan, "");
  assert.deepEqual(JSON.parse(rows[0]!.file_observations!), unit.scannedFiles);
  assert.equal(rows[1]!.item_kind, "manifest-state");
  assert.equal(rows[1]!.query_snapshot_id, "b".repeat(64));
  assert.equal(rows[1]!.omitted, "5");
  assert.equal(rows[1]!.has_more, "true");
  assert.equal(rows[1]!.inventory_complete, "false");
});

test("a completed file list still exports incomplete matching coverage and missing metadata", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1, truncated: false, warnings: [], entrypoints: [],
    files: [{ fileId: "partial", metadataState: "missing", downloadable: false,
      matchingCoverage: [{ layerId: "desi", order: 8, ipix: 101, precision: "estimated" }],
      matchingCoverageTruncated: true, warnings: ["Retained source evidence only"],
    }],
  };
  const row = record(overlapCsvRows(component, plan, () => layer)[0]!);
  assert.equal(row.matching_coverage_truncated, "true");
  assert.match(row.notes!, /FileAsset metadata missing/);
  assert.match(row.notes!, /file coverage matches truncated/);
  assert.match(row.notes!, /Retained source evidence only/);
});

test("coverage-only results export a separate coverage evidence row", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [],
    entrypoints: [],
    coverageEvidence: [{
      layerId: "hst-cosmos-footprint",
      productId: "hst-product",
      surveyId: "hst",
      releaseId: "hst-mast-snapshot-2026",
      product: "HST COSMOS observations",
      evidenceKind: "observation-footprint",
      order: 4,
      nside: 16,
      nativeMaxOrder: 10,
      availableOrders: [4],
      matchedCells: [101, 102],
      precision: "estimated",
      sourceIdentity: "MAST observation 26442812",
      instrument: "ACS/WFC",
      filters: "F606W, F814W",
      sourceSnapshotSha256: "a".repeat(64),
      completeness: "incomplete",
      scienceFileScan: "not-scanned",
      geometrySourceUrl: "https://archive.stsci.edu/",
      summary: "Coverage material intersects; no science file match is asserted.",
    }],
    truncated: false,
    warnings: [],
  };
  const row = record(overlapCsvRows(component, plan, () => ({ ...layer, surveyId: "hst" }))[0]!);
  assert.equal(row.item_kind, "coverage-evidence");
  assert.equal(row.evidence_kind, "observation-footprint");
  assert.equal(row.layer_id, "hst-cosmos-footprint");
  assert.deepEqual(JSON.parse(row.matching_cells ?? "[]"), [101, 102]);
  assert.equal(row.geometry_source_url, "https://archive.stsci.edu/");
  assert.equal(row.native_max_order, "10");
  assert.equal(row.source_identity, "MAST observation 26442812");
  assert.equal(row.science_file_scan, "not-scanned");
  assert.equal(row.source_snapshot_sha256, "a".repeat(64));
  assert.match(row.notes ?? "", /no science file match/);
});

test("file rows retain local URIs and all matching coverage", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [{
      fileId: "local-file",
      metadataState: "complete",
      fileName: "image.fits",
      sourceUri: "file:///data/images/image.fits",
      downloadable: false,
      matchingCoverage: [
        { layerId: "roman-images", order: 8, ipix: 101, precision: "exact" },
        { layerId: "roman-images", order: 8, ipix: 102, precision: "exact" },
      ],
    }],
    entrypoints: [],
    truncated: false,
    warnings: [],
  };
  const row = record(overlapCsvRows(component, plan, () => ({ ...layer, surveyId: "roman" }))[0]!);
  assert.equal(row.item_kind, "file");
  assert.equal(row.source_uri, "file:///data/images/image.fits");
  assert.equal(row.downloadable, "false");
  assert.deepEqual(JSON.parse(row.matching_cells ?? "[]").map((match: { ipix: number }) => match.ipix), [101, 102]);
});

test("file rows retain an official link and owned URI independently", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [{
      fileId: "owned-file",
      metadataState: "complete",
      fileName: "tile.fits",
      sourceUri: "oss://survey-data/tiles/1234/tile.fits",
      downloadable: true,
      downloadUrl: "https://data.example/tiles/1234/tile.fits",
      matchingCoverage: [{ layerId: "desi", order: 8, ipix: 101, precision: "exact" }],
    }],
    entrypoints: [],
    truncated: false,
    warnings: [],
  };
  const row = record(overlapCsvRows(component, plan, () => layer)[0]!);
  assert.equal(row.source_uri, "oss://survey-data/tiles/1234/tile.fits");
  assert.equal(row.downloadable, "true");
  assert.equal(row.download_url, "https://data.example/tiles/1234/tile.fits");
});

test("tile rows expose the matched cells, tile identity and official directory URL", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [],
    entrypoints: [{
      kind: "tile-directory",
      purpose: "data-access",
      layerId: "desi-dr1-spectra-footprint",
      surveyId: "desi",
      releaseId: "desi-dr1",
      product: "DR1 spectra",
      order: 8,
      nside: 256,
      cells: [101, 102],
      precision: "exact",
      tileId: "1234",
      url: "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/1234/20250101/",
    }],
    truncated: false,
    warnings: [],
  };
  const row = record(overlapCsvRows(component, plan, () => layer)[0]!);
  assert.equal(row.item_kind, "entrypoint");
  assert.equal(row.entrypoint_kind, "tile-directory");
  assert.equal(row.tile_id, "1234");
  assert.deepEqual(JSON.parse(row.matching_cells ?? "[]"), [101, 102]);
  assert.match(row.entrypoint_url ?? "", /tiles\/cumulative\/1234/);
  assert.equal(row.source_file_id, "");
});

test("source-path rows preserve the original locator and tile selection metadata", () => {
  const plan: DownloadPlan = {
    schemaVersion: 1,
    files: [],
    entrypoints: [{
      kind: "source-path",
      purpose: "data-access",
      layerId: "csst-sim-w2-image-extent",
      surveyId: "csst",
      releaseId: "csst-sim-w2-20250731",
      product: "W2 simulated wide-field images",
      order: 8,
      nside: 256,
      cells: [101, 102],
      precision: "entrypoint-only",
      sourceUri: "s3://data-and-computing/projects/CSST/W2_Phot/",
      sourceScope: "prefix",
      note: "原始数据来源前缀；当前计划不展开到每个文件。",
    }, {
      kind: "tile-directory",
      purpose: "data-access",
      layerId: "desi-dr1-spectra-footprint",
      surveyId: "desi",
      releaseId: "desi-dr1",
      product: "DR1 spectra",
      order: 8,
      nside: 256,
      cells: [101],
      precision: "exact",
      tileId: "1234",
      url: "https://data.desi.lbl.gov/public/dr1/tile/1234/",
      sourceUri: "https://data.desi.lbl.gov/public/dr1/tile/1234/",
      sourceScope: "tile-directory",
      required: true,
      selectionComplete: true,
      selectionRule: "all official tile footprints intersecting the current component cells",
    }],
    tileSelections: [{
      layerId: "desi-dr1-spectra-footprint",
      surveyId: "desi",
      releaseId: "desi-dr1",
      product: "DR1 spectra",
      tileIds: ["1234"],
      selectionRule: "all official tile footprints intersecting the current component cells",
      complete: true,
      note: "下载本组件列出的全部 Tile 可获得覆盖当前重合区域的相关数据；Tile 内容可能超出组件边界，未做空间裁剪。",
    }],
    truncated: false,
    warnings: [],
  };
  const rows = overlapCsvRows(component, plan, (layerId) => layerId?.startsWith("csst") ? {
    surveyId: "csst", releaseId: "csst-sim-w2-20250731", product: "W2 simulated wide-field images", modality: "imaging",
  } : layer);
  const source = record(rows[0]!);
  assert.equal(source.item_kind, "source-path");
  assert.equal(source.source_uri, "s3://data-and-computing/projects/CSST/W2_Phot/");
  assert.equal(source.source_scope, "prefix");
  const tile = record(rows[1]!);
  assert.equal(tile.required, "true");
  assert.equal(tile.selection_complete, "true");
  assert.deepEqual(JSON.parse(tile.required_tile_ids!), ["1234"]);
});

test('file manifest CSV retains committed observations and frozen-scope limits', () => {
  const snapshot = 'a'.repeat(64);
  const observations = [{ layerId: 'vis', scanRunId: 'run-1', sourceSnapshotSha256: snapshot, fileName: 'vis.fits', sizeBytes: 42, metadataState: 'complete' as const }];
  const scanScopes = [{ layerId: 'assets-batch-vis', publishedLayerId: 'vis', scopeId: 'q1-mer', scopeSnapshotSha256: 'b'.repeat(64), expectedPartitions: 2, committedPartitions: 1, completeness: 'incomplete' as const }];
  const match = { layerId: 'vis', evidenceLayerId: 'assets-batch-vis', observationLayerId: 'candidate-1', scopeId: 'q1-mer', partitionId: 'tile-1', order: 8, ipix: 101, precision: 'estimated', scanRunId: 'run-1', sourceSnapshotSha256: snapshot };
  const plan: DownloadPlan = { schemaVersion: 1, files: [{ fileId: 'file', metadataState: 'complete', downloadable: false, observations, matchingCoverage: [match] }], entrypoints: [], truncated: false, warnings: [], scanScopes };
  const row = record(overlapCsvRows(component, plan, () => layer)[0]!);
  assert.equal(row.source_snapshot_sha256, snapshot);
  assert.deepEqual(JSON.parse(row.file_observations!), observations);
  assert.deepEqual(JSON.parse(row.scan_scopes!), scanScopes);
  assert.deepEqual(JSON.parse(row.matching_cells!), [match]);
});

test("paged download plans merge repeated identities consistently for JSON and CSV", () => {
  const unit = {
    layerId: "euclid-ero", productId: "ero", surveyId: "euclid", releaseId: "euclid-ero", product: "ERO", modality: "imaging",
    unitKind: "target", unitId: "Abell2390", order: 8, nside: 256, matchingCells: [101], precision: "estimated",
    accessUri: "https://example.test/vis.fits", accessUris: [{ uri: "https://example.test/vis.fits", fileName: "vis.fits", alternatives: [
      { uri: "https://example.test/vis.fits", accessType: "file" as const, provider: "Archive US", providerCountryCode: "US", status: "source-listed" as const },
    ] }],
    scannedFiles: [{ fileId: "scan-a", scanRunId: "run-a" }], note: "ESA Sky extent",
  };
  const repeatedUnit = { ...unit, matchingCells: [102], precision: "exact", accessUri: "https://example.test/nisp.fits",
    accessUris: [
      { uri: "https://example.test/vis.fits", fileName: "vis.fits", alternatives: [
        { uri: "https://mirror.example.test/vis.fits", accessType: "file" as const, provider: "Mirror CN", providerCountryCode: "CN", relationship: "mirror", status: "verified" as const },
      ] },
      { uri: "https://example.test/nisp.fits", fileName: "nisp.fits" },
    ],
    scannedFiles: [{ fileId: "scan-b", scanRunId: "run-b" }], note: "Package metadata" };
  const file = { fileId: "file-1", metadataState: "complete" as const, downloadable: true, sourceUri: "s3://survey/file-1",
    matchingCoverage: [{ layerId: "euclid-ero", order: 8, ipix: 101, precision: "estimated" }] };
  const repeatedFile = { ...file, matchingCoverage: [{ layerId: "euclid-ero", order: 8, ipix: 102, precision: "estimated" }] };
  const entrypoint = { kind: "tile-directory", purpose: "data-access" as const, layerId: "euclid-ero", surveyId: "euclid", releaseId: "euclid-ero",
    product: "ERO", order: 8, nside: 256, cells: [101], precision: "entrypoint-only", tileId: "Abell2390", url: "https://example.test/Abell2390/" };
  const evidence = { layerId: "euclid-ero", productId: "ero", surveyId: "euclid", releaseId: "euclid-ero", product: "ERO",
    evidenceKind: "observation-footprint" as const, order: 8, nside: 256, nativeMaxOrder: 10, availableOrders: [4, 8], matchedCells: [101],
    precision: "estimated" as const, completeness: "incomplete" as const, scienceFileScan: "not-scanned" as const, summary: "First batch evidence." };
  const first: DownloadPlan = { schemaVersion: 1, spatialUnits: [unit], files: [file], entrypoints: [entrypoint], coverageEvidence: [evidence],
    tileSelections: [{ layerId: "euclid-ero", tileIds: ["Abell2390"], selectionRule: "official target match", complete: true, note: "First batch." }],
    truncated: true, warnings: ["More pages remain"], scanScopes: [{ layerId: "layer", scopeId: "scope-a", scopeSnapshotSha256: "a".repeat(64), expectedPartitions: 1, committedPartitions: 1, completeness: "complete" }] };
  const second: DownloadPlan = { ...first, spatialUnits: [repeatedUnit], files: [repeatedFile],
    entrypoints: [{ ...entrypoint, cells: [102], precision: "exact" }], coverageEvidence: [{ ...evidence, matchedCells: [102], summary: "Second batch evidence." }],
    tileSelections: [{ ...first.tileSelections![0]!, tileIds: ["Abell2390", "Abell2391"], note: "Second batch." }],
    truncated: false, warnings: ["Query completed"], scanScopes: [{ layerId: "layer", scopeId: "scope-b", scopeSnapshotSha256: "b".repeat(64), expectedPartitions: 1, committedPartitions: 1, completeness: "complete" }] };

  const merged = mergeDownloadPlans(first, second);
  const jsonPlan = JSON.parse(JSON.stringify(merged)) as DownloadPlan;
  assert.equal(jsonPlan.truncated, false, "the final page state wins after the client drains all pages");
  assert.deepEqual(jsonPlan.spatialUnits?.[0]?.matchingCells, [101, 102]);
  assert.equal(jsonPlan.spatialUnits?.[0]?.precision, "estimated", "a later exact page cannot improve an earlier estimate");
  assert.deepEqual(jsonPlan.spatialUnits?.[0]?.accessUris?.map((entry) => entry.uri), ["https://example.test/vis.fits", "https://example.test/nisp.fits"]);
  assert.deepEqual(jsonPlan.spatialUnits?.[0]?.accessUris?.[0]?.alternatives?.map((entry) => entry.uri), [
    "https://example.test/vis.fits", "https://mirror.example.test/vis.fits",
  ]);
  assert.deepEqual(jsonPlan.spatialUnits?.[0]?.scannedFiles?.map((entry) => entry.fileId), ["scan-a", "scan-b"]);
  assert.deepEqual(jsonPlan.files[0]?.matchingCoverage.map((match) => match.ipix), [101, 102]);
  assert.deepEqual(jsonPlan.entrypoints[0]?.cells, [101, 102]);
  assert.equal(jsonPlan.entrypoints[0]?.precision, "entrypoint-only", "entrypoint precision cannot be upgraded by a later page");
  assert.deepEqual(jsonPlan.coverageEvidence?.[0]?.matchedCells, [101, 102]);
  assert.deepEqual(jsonPlan.tileSelections?.[0]?.tileIds, ["Abell2390", "Abell2391"]);
  assert.equal(jsonPlan.scanScopes?.length, 2);
  assert.deepEqual(jsonPlan.warnings, ["More pages remain", "Query completed"]);

  const rows = overlapCsvRows(component, jsonPlan, () => ({ ...layer, surveyId: "euclid", releaseId: "euclid-ero", product: "ERO" }), "estimated").map(record);
  assert.equal(rows.length, 4, "JSON and CSV each contain one row per merged identity");
  const spatialRow = rows.find((row) => row.item_kind === "spatial-unit")!;
  assert.deepEqual(JSON.parse(spatialRow.matching_cells!), [101, 102]);
  assert.deepEqual(JSON.parse(spatialRow.access_uris!), [
    { uri: "https://example.test/vis.fits", fileName: "vis.fits", alternatives: [
      { uri: "https://example.test/vis.fits", accessType: "file", provider: "Archive US", providerCountryCode: "US", status: "source-listed" },
      { uri: "https://mirror.example.test/vis.fits", accessType: "file", provider: "Mirror CN", providerCountryCode: "CN", relationship: "mirror", status: "verified" },
    ] },
    { uri: "https://example.test/nisp.fits", fileName: "nisp.fits" },
  ]);
  assert.deepEqual(JSON.parse(rows.find((row) => row.item_kind === "file")!.matching_cells!).map((match: { ipix: number }) => match.ipix), [101, 102]);
  assert.deepEqual(JSON.parse(rows.find((row) => row.item_kind === "entrypoint")!.matching_cells!), [101, 102]);
  assert.deepEqual(JSON.parse(rows.find((row) => row.item_kind === "coverage-evidence")!.matching_cells!), [101, 102]);
});
