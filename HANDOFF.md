# Assets Session Handoff

Updated: 2026-08-26

Repository: `/home/aaron/Repo/Astro-Survey-Atlas-Assets`

Starting commit: `49f434b`

## Start Here

Read `AGENTS.md`, `docs/coverage-workflow.md`, and
`skills/astro-survey-atlas-coverage-workflow/SKILL.md` before changing scan,
MOC, evidence, overlap, or reverse-lookup behavior. The Warehouse handoff is
`/home/aaron/Repo/Astro-Survey-Atlas-Warehouse/HANDOFF.md`.

The working tree is not clean. At this checkpoint it contains unfinished UI
work in:

```text
 M site/src/atlas/survey-layer-viewer.ts
 M site/src/main.ts
 M site/src/styles.css
```

Treat these files as user work in progress. Inspect their diffs before editing
them and preserve their behavior unless the next task explicitly supersedes it.

## Fixed Product Decisions

- Assets owns public survey metadata, release artifacts, MOCs, previews,
  overlap presentation, reverse-lookup UX, and evidence retention.
- Warehouse owns scan execution and the current FileAsset/SpatialCoverage
  index state. Assets submits standard scans and consumes normalized documents.
- Runtime may use only `ASSETS_WAREHOUSE_ES_URL`. Legacy `astro_*` indices are
  allowed only as an explicit input to one-shot migration tools.
- The new index names are intentionally isolated:
  `ast_layer_index_v1`, `ast_file_index_v1`, and `ast_coverage_index_v1`.
- The product answers which surveys overlap a region and which known public
  files/modalities cover it. It is a discovery catalog, not a data download
  proxy or a scientific processing service.
- FileAsset is the v1 discovery unit. SourceUnit is reserved vocabulary and is
  not implemented until real data demonstrates a useful grouping model.
- Warehouse refreshes current state. There is no user-queryable scan history;
  a later successful scan replaces the layer result.
- Coverage is ICRS with explicit NESTED `order/ipix`. Preserve `exact`,
  `estimated`, or `entrypoint-only` precision and report truncation separately.
- Input manifests, normalized scans, task snapshots, and scan errors are
  evidence. They stay on the evidence PVC/object store and out of the browser's
  initial request. In particular, CSST `input-manifest.json` is not a public
  Git release artifact.

## Current Implementation

- `server/server.ts` constructs an `ElasticsearchEvidenceStore` from
  `ASSETS_WAREHOUSE_ES_URL` and loads Warehouse coverage into the runtime
  catalog.
- Only Warehouse layers in `ACTIVE` state are read. Current code replaces the
  checked-in coverage catalog when any ACTIVE layer exists; it does not yet
  merge the Warehouse result with the remaining public footprint records.
- Overlap components use the highest order shared by all selected layers.
  File-level reverse lookup is deferred until a component/cell is requested
  and returns actual order, precision, source IDs, and source URIs.
- If Warehouse Elasticsearch is unavailable during startup, the server falls
  back to checked-in public geometry. This keeps the site usable but can hide
  freshness/connectivity failures unless health and logs are checked.
- The admin path emits Warehouse ScanPlan v2 requests; it does not scan data in
  Assets itself.

## Verification Baseline

The last recorded end-to-end smoke on 2026-08-25 used the new `ast_*` indices.
The deployed Assets health endpoint returned 200; CSST, DESI, and Euclid ACTIVE
layers appeared in catalog and overlap requests; tile/file details included
order and precision. Euclid order-8 cell `548925` reverse-resolved through the
Assets API to its OSS FileAsset metadata.

At the live cluster checkpoint on 2026-08-26, Warehouse held 5 layer documents,
5 FileAssets, and 2,060 coverage edges. Four layers were ACTIVE:
`csst-w1-phot-catalog` (5 edges), `desi-merger-catalog` (2,039),
`desi-overlap-catalog` (5), and `euclid-q1-vis-tile102018212` (11). The current
CSST image layer `csst-sim-w1-image-extent` is `FAILED` with one error
(`FITS spatial header position is missing`) and is hidden from runtime reads.
The five indexed files total 1,652,927,417 bytes (about 1.54 GiB), and the
successful catalog probes report 26,134 valid rows. These are live observations,
not permanent expected counts.

The checked-in public release is still present: `src/footprints/survey-
footprints.json` contains 44 footprints across 14 surveys and 66,373 cells.
However, the deployed Assets `/api/v1/coverage` returned only 4 Warehouse
footprints across `csst`, `desi`, and `euclid`. The cause is
`server.ts:40-55` calling `coverageCatalogFromWarehouse`, whose implementation
creates a new record map from ACTIVE Warehouse layers instead of preserving
static records that have no Warehouse layer. The public files were not deleted;
the runtime response omitted them.

No bulk scan of the Euclid `MER/` root has occurred. Its 15,948 FITS objects
(about 19 TiB) were listed only. Gaia, HI4PI, SDSS, and HST checks were local or
in-memory contract probes and were not written to the current `ast_*` indices.

## Live Deployment Layout

Assets is a separate Helm release in namespace `astro-survey-atlas-assets`.
Its pod receives:

```text
ASSETS_WAREHOUSE_ES_URL=http://warehouse-elasticsearch.warehouse.svc.cluster.local:9200
ASSETS_WAREHOUSE_LAYER_INDEX=ast_layer_index_v1
ASSETS_WAREHOUSE_COVERAGE_INDEX=ast_coverage_index_v1
ASSETS_WAREHOUSE_FILE_INDEX=ast_file_index_v1
```

The public site serves through the `astro-survey-atlas-assets` Service/Ingress.
The server loads Warehouse coverage once during process startup; the release
PVC contains the static public bundle used for fallback and publication.

## Known Problems

1. Warehouse coverage is loaded once during server startup in
   `server/server.ts`. A completed rescan does not appear until Assets restarts.
2. When any ACTIVE Warehouse layer exists, the runtime replaces all static
   public footprints. This is why public HST/SDSS/GALEX/Pan-STARRS/2MASS/
   WISE/DES/KiDS/HSC and other releases are currently absent from the globe.
   Merge static records with Warehouse overrides by layer identity, then verify
   that the endpoint contains both sets.
3. `server/evidence-store.ts` loads at most 10,000 coverage documents per layer
   and does not paginate. A larger ACTIVE layer is rejected and the runtime can
   fall back to static geometry.
4. Startup fallback needs an observable degraded/freshness signal. A healthy
   HTTP process is not proof that current Warehouse data was loaded.
5. Historical import utilities such as `scripts/import_csst_w234.py` still
   mention `astro_*`. Keep them explicitly migration-only; do not make them a
   runtime fallback.
6. Warehouse currently has correctness issues that can publish partial scans
   as ACTIVE. Do not treat a new large scan as authoritative until the
   Warehouse issues in its `HANDOFF.md` are fixed and regression-tested.

## Next Session

Work in this order:

1. Read both handoffs and inspect both worktrees. Preserve the three unfinished
   Assets UI files and all Warehouse WIP.
2. Fix the static-plus-Warehouse coverage merge first. Completion means
   `/api/v1/coverage` retains all 44 checked-in public footprints while adding
   every ACTIVE Warehouse layer, with Warehouse records overriding only an
   identical layer identity.
3. Fix Warehouse partial-scan failure semantics and evidence reliability;
   Assets cannot compensate for an incorrectly ACTIVE layer.
4. Add paginated/streamed Warehouse catalog loading in Assets. Completion means
   a layer with more than 10,000 coverage edges loads without static fallback.
5. Add a refresh mechanism or a documented restart/reload operation. Completion
   means a successful layer rescan becomes visible without an unexplained stale
   interval.
6. Expose Warehouse connectivity, load time, source snapshot, and fallback mode
   in readiness/diagnostics, then rerun the direct catalog, overlap, and reverse
   lookup smoke against representative CSST, DESI, and Euclid layers.

## Do Not Disturb

- Preserve unrelated dirty files in both repositories.
- Keep credentials in Secret/environment references. Do not copy `.env` values
  into plans, evidence, logs, commits, or this document.
- Keep the roughly 19 TiB Euclid `MER/` root to inventory/listing tests. Use
  bounded prefixes or exact object keys for content probes.
- Never manufacture fine HEALPix cells from coarse preview geometry.
