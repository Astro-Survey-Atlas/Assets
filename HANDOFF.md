# Assets Session Handoff

Updated: 2026-08-27

Repository: `/home/aaron/Repo/Astro-Survey-Atlas-Assets`

Starting commit: `49f434b`; current HEAD: `c5beceb`

## Start Here

Read `AGENTS.md`, `docs/coverage-workflow.md`, and
`skills/astro-survey-atlas-coverage-workflow/SKILL.md` before changing scan,
MOC, evidence, overlap, or reverse-lookup behavior. The Warehouse handoff is
`/home/aaron/Repo/Astro-Survey-Atlas-Warehouse/HANDOFF.md`.

The working tree is intentionally dirty. Preserve all current changes shown by
`git status --short`, including `.assets-content` product records, `.codex`
configuration, the Warehouse endpoint integration, evidence and admin tests,
Helm/deployment values, MOC discovery code and public MOC research notes.
These are working changes, not disposable generated output; inspect overlapping
diffs before editing them.

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
  `ASSETS_WAREHOUSE_ES_URL` and loads only Warehouse `ACTIVE` layers into the
  runtime catalog. The checked-in public catalog remains the base: a Warehouse
  layer replaces only the identical `layerId`; unrelated public footprints are
  retained.
- Warehouse coverage edges are loaded in bounded `search_after` pages with a
  stable layer/file/order/cell/role sort. Layers larger than 10,000 edges now
  load without relying on Elasticsearch's single-request hit limit; the
  configured global document cap still protects process memory.
- `POST /api/v1/admin/catalog/reload` refreshes the runtime catalog without a
  process restart. `GET /api/v1/admin/catalog/status` reports the load mode,
  timestamp, layer/footprint counts and Warehouse connectivity.
- `server/overlap-details.ts` keeps the public overlap-details response
  type-safe; the live route is available as `POST /api/v1/coverage/overlap/details`.
- Overlap components use the highest order shared by all selected layers.
  File-level reverse lookup is deferred until a component/cell is requested
  and returns actual order, precision, source IDs, and source URIs.
- If Warehouse Elasticsearch is unavailable during a reload/startup, the
  server falls back to checked-in public geometry and reports degraded mode in
  catalog status.
- The admin path emits Warehouse ScanPlan v2 requests. It supports connector
  registration, product/profile-driven task creation, task detail, evidence
  summaries and immutable retry resources; it does not scan data in Assets.
- `src/moc-sources/source-registry.json` records eight reviewed public MOC
  candidates. Network probes are validation/evidence only; candidates remain
  blocked from the public release until snapshot, attribution and license
  gates are reviewed.
- The overlap UI forwards the right-drawer viewport inset through
  `AtlasCoverageGlobe` to the Three.js viewer, so a successful overlap response
  can be rendered without a post-response runtime exception.

## Verification Baseline

The final bounded end-to-end smoke on 2026-08-26/27 used the new `ast_*`
indices. The deployed Assets health endpoint returned 200; CSST, DESI, and
Euclid ACTIVE layers appeared in catalog and overlap requests; tile/file
details included order and precision. Euclid order-8 cell `548925`
reverse-resolved through the Assets API to its OSS FileAsset metadata.

The Assets gate on 2026-08-27 was green: `npm run validate`, 40 Node tests and
16 Python tests passed (the same three scientific-dependency tests remain
skipped), and `git diff --check` was clean. The five-step plain-language
product explanation is present on the actual `/surveys/` directory entry
point (and kept in the shared resources template). A browser smoke
loaded the deployed bundle, entered G mode with CSST/DESI, rendered
`COMMON ORDER O8 · 11,119 CELLS`, and opened the overlap drawer without new
runtime exceptions.

At the earlier live cluster checkpoint on 2026-08-26, Warehouse held 13 layer
documents, 11 FileAssets, and 2,109 coverage edges. The final bounded smoke
layers were:

| ScanRequest | Result |
| --- | --- |
| `final-csst-catalog-retry-20260826` | `SUCCEEDED`, 1 file, 5 edges, 0 errors |
| `final-csst-image-20260826` | `FAILED`, missing FITS spatial header |
| `final-desi-catalog-20260826` | `SUCCEEDED`, 1 file, 2,039 edges, 0 errors |
| `final-desi-overlap-20260826` | `SUCCEEDED`, 1 file, 5 edges, 0 errors |
| `final-euclid-vis-20260826` | `SUCCEEDED`, 1 file, 11 edges, 0 errors |

The first CSST catalog attempt and the CSST image failure remain as
ScanRequest/Job/evidence records. The full-prefix CSST catalog retry
`oss-csst-w1-catalog-full-bulkfix2-20260826` reached its six-hour deadline and
the ScanRequest is now `FAILED` with reason `DeadlineExceeded`; its
`csst-w1-phot-catalog` layer is still `UPDATING`, so any partial edges remain
hidden from Assets runtime reads. These are live observations, not permanent
expected counts.

The checked-in public release is still present: `src/footprints/survey-
footprints.json` contains 44 footprints across 14 surveys and 66,373 cells.
The deployed Assets `/api/v1/coverage` now retains that public base and adds the
ACTIVE layers from the current Warehouse endpoint; while the CSST retry is
`UPDATING`, the live response contains 53 footprints across the public surveys
plus the ACTIVE CSST, DESI, Euclid and Assets-owned controlled smoke layers.
The current bounded smoke covers catalog/block reads, CSST/DESI,
Euclid/DESI and 2MASS/SDSS overlap, overlap details, reverse lookup, and FITS
Range reads.

The current Warehouse ES observation has 13 live layer documents (the index
also reports 2 deleted Lucene documents), 22,842 FileAsset documents and
92,787 coverage documents. The latter two counts include evidence from failed
or incomplete executions and are not public Assets counts. The runtime API
currently exposes 53 footprints and 53 catalog layers: the 44 static public
footprint records plus ACTIVE Warehouse
layers. The `csst-w1-phot-catalog` `UPDATING` layer is excluded.

On the previous deployment, every overlap appeared to fail even though the
server returned valid HTTP 200 JSON. Browser diagnostics identified
`TypeError: Q.setViewportRightInset is not a function` after the response was
parsed; the generic frontend catch obscured that rendering error. The missing
wrapper method was added in `site/src/atlas-coverage-globe.ts`, then deployed
as revision 82. A real browser smoke now reaches `COMMON ORDER O8 · 11,119
CELLS` for CSST/DESI, and opening the drawer hides the original panel and layer
list without new exceptions.

No bulk scan of the Euclid `MER/` root has occurred. Its 15,948 FITS objects
(about 19 TiB) were listed only. The controlled Gaia and SDSS probes are
persisted in the current `ast_*` indices, while the HI4PI probe is persisted as
explicit failed evidence because its header declares `RADESYS=FK5`; HST
multi-HDU checks remain local/in-memory contract probes.

## Live Deployment Layout

Assets is a separate Helm release in namespace `astro-survey-atlas-assets`.
The current dev rollout is Helm revision 83, image tag
`0.1.0-20260827-163611`, and serves through:

```text
http://10.15.51.75:32083/
http://astro.assets.dev.72602.space:32080/
https://astro.assets.dev.72602.space:32443/
```

The hostname is routed by ingress-nginx; this cluster exposes the controller
through HTTP NodePort `32080` and HTTPS NodePort `32443`. Port 80 without the
NodePort is not mapped in the current network.

Its pod receives:

```text
ASSETS_WAREHOUSE_ES_URL=http://atlas-warehouse-elasticsearch.atlas-warehouse.svc.cluster.local:9200
ASSETS_WAREHOUSE_LAYER_INDEX=ast_layer_index_v1
ASSETS_WAREHOUSE_COVERAGE_INDEX=ast_coverage_index_v1
ASSETS_WAREHOUSE_FILE_INDEX=ast_file_index_v1
```

The public site serves through the `astro-survey-atlas-assets` Service/Ingress.
The release PVC contains the static public bundle used for fallback and
publication. The current runtime bundle is
`public-survey-footprints-2026-08-20`, SHA-256
`cfd5af3c429c11e3d19afcd14eae3d9e59facc561c0f1be4dbbef121daf64722`.

The Gaia O8-only Warehouse layers are included in the globe's O4 visual
overview by NESTED coarsening, while their API coverage remains explicitly O8.
Euclid/SDSS overlap now tries the finest real common order first and falls back
to O4 when O8 has no shared cells; the live bounded request returns six O4
cells.

The viewer also keeps a coverage-only slot for Warehouse survey IDs that are
not yet registered in the public survey metadata. The live bounded Gaia probe
therefore renders on the globe without promoting its smoke product to the
public survey index. The current Euclid/SDSS/Gaia bounded probes have no
three-way overlap at O8 or after Gaia's O4 visual coarsening.

## Known Problems

1. Historical import utilities such as `scripts/import_csst_w234.py` still
   mention `astro_*`. Keep them explicitly migration-only; do not make them a
   runtime fallback.
2. The successful Assets-owned modality CRs were deleted after their ES state
   and evidence were verified; the failed cube probe remains for diagnosis
   because its real HI4PI header declares `RADESYS=FK5`. The current Warehouse
   scanner correctly rejects a non-explicit-ICRS WCS. Do not rewrite that source
   header or treat the result as successful coverage.
3. The old `warehouse` release and namespace are gone. Any retained old PV or
   evidence material is migration/diagnostic state and is not Assets-owned.
   Existing Warehouse-owned ScanRequests in `atlas-warehouse` are likewise
   excluded from the Assets task list; do not relabel or mutate foreign
   resources.
4. The CSST full-prefix retry is terminally failed at the ScanRequest level but
   its Warehouse layer is still `UPDATING`. Do not reload it into Assets as a
   successful result; keep the failed evidence and decide on a new bounded
   retry with the Warehouse owner.
5. The in-app browser runtime had no connected browser instances during the
   2026-08-27 local verification. Standalone Chromium validation is complete,
   but no in-app screenshot session or retained canvas-pixel artifact is
   available from that environment.

## Next Session

Work in this order:

1. Preserve all dirty files in both repositories and keep the static-plus-
   Warehouse merge, pagination, admin reload/status behavior and overlap
   viewport forwarding regression-tested.
2. Coordinate with Warehouse on the terminal CSST retry: inspect its evidence
   and layer state, then submit a new bounded retry only after choosing the
   scanner plan. Do not treat the current `UPDATING` layer as public coverage.
3. Once a successful CSST layer is genuinely `ACTIVE`, call
   `POST /api/v1/admin/catalog/reload` with the admin token and inspect
   `GET /api/v1/admin/catalog/status`; the status must show the current load
   mode, timestamp, counts and Warehouse connectivity.
4. The long Warehouse task is no longer active. Coordinate the pending
   `mocdiscovery` Operator rollout and verify its evidence/status path; Assets
   continues to submit intent-only discovery requests.
5. Rerun direct catalog, overlap, details and reverse-lookup smokes against
   bounded CSST, DESI and Euclid layers after future Warehouse image or
   mapping changes. Keep failed ScanRequests and evidence for diagnosis.

## Warehouse MOC Discovery Rollout

MOC discovery CRD/Operator/worker integration is implemented and validated.
The CRD is installed. The previously blocking CSST long task has now reached a
terminal deadline failure, but the live Operator is still on the existing
`operatorfix3` image; coordinate a separate rollout of the pushed
`mocdiscovery` image before creating discovery Jobs. See
`docs/deferred-moc-discovery-plan.md`. Assets only submits intent-only requests
and records review decisions; it does not execute discovery or own the
Operator.

## Do Not Disturb

- Preserve unrelated dirty files in both repositories.
- Keep credentials in Secret/environment references. Do not copy `.env` values
  into plans, evidence, logs, commits, or this document.
- Keep the roughly 19 TiB Euclid `MER/` root to inventory/listing tests. Use
  bounded prefixes or exact object keys for content probes.
- Never manufacture fine HEALPix cells from coarse preview geometry.

## 2026-08-27 Product Release Checkpoint

- Public product detail is now a structured, human-readable dossier. `GET
  /api/v1/products/{productId}` and `/evidence` work for catalog-backed
  products even before editorial publication; `/api/v1/products` remains the
  published-only compatibility list. The browser no longer expects a nested
  `{ product: ... }` response.
- The `/surveys/` directory explains the five user questions in order: choose a
  sky area, see coverage, read precision, check evidence, and go to the
  official archive. Raw JSON, hashes and technical artifacts are folded below
  that explanation.
- DESI and Euclid Resource Package v3 archives were rebuilt from the current
  acquired layer registry. The package IDs, `coverageRole`, `sourceTier`, MOC
  paths and archive hashes in `packages/catalog.json`, provenance and
  `release-manifest.json` are synchronized. Run `npm run packages:rebuild` to
  reproduce the refresh.
- Public UI and admin UI now use bundled Noto Sans/Noto Sans Mono faces from
  `site/public/fonts`; the static server advertises standard font MIME types,
  and Three.js canvas labels wait for the local faces before rasterization. The
  font license notice is shipped alongside the files.
- CSST full-prefix scanning remains deferred. No new CSST input manifest or
  normalized scan was added to the public release.
- Helm revision 83 is healthy with image tag `0.1.0-20260827-163611`. The
  `publish-assets` init container completed successfully and the new product
  dossier, evidence summary and predictable FITS MOC routes were verified
  through the ingress Host at `astro.assets.dev.72602.space:32080` (HTTPS
  `32443` health also verified).
- The final local verification removed the temporary `.tmp-ui` Chromium
  profile. `npm run validate` passed with 44 Node tests and 16 Python tests
  (the same three scientific-dependency tests skipped); `git diff --check` is
  clean.
- Standalone Chromium checked the product deep link, Chinese dossier copy,
  bundled Noto Sans/Noto Sans CJK loading, and the overlap drawer at
  2560x1440 and 3840-wide desktop viewports. At 2560x1440 the coverage panel
  and selected-component queue move off the left edge while the sky remains
  visible; at 3840 they remain alongside the drawer.

## 2026-08-27 Deployment Checkpoint

- The current source was gated with `npm run build`, `npm test`, and
  `helm lint charts/astro-survey-atlas-assets`; all passed. The three existing
  scientific-dependency Python tests remain skipped.
- Image
  `crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-survey-atlas-assets:0.1.0-20260827-163611`
  was pushed successfully. Helm revision 83 is `deployed`; the running Pod is
  `1/1 Running`, and the `publish-assets` init container exited 0 after
  synchronizing the release PVC.
- The verified Ingress URLs are
  `http://astro.assets.dev.72602.space:32080/` and
  `https://astro.assets.dev.72602.space:32443/`. The application Service
  NodePort `32083` is a direct-service fallback, not the Ingress path. The
  hostname's port 80 is not mapped in this cluster network.
- Ingress smoke checks returned 200 for `/healthz`, the W1 product detail
  (`6e2c427ca3e3c8f1ef32`), its `/evidence` response, and the predictable
  `csst-sim-w1-image-extent/moc.fits` route. The MOC response preserves FITS
  media type, ETag, `X-Content-SHA256`, and byte-range behavior.
- The active bundle is
  `public-survey-footprints-2026-08-20` with SHA-256
  `cfd5af3c429c11e3d19afcd14eae3d9e59facc561c0f1be4dbbef121daf64722` and 179
  published files. `/api/v1/products` is intentionally the published-only
  compatibility list and may currently be empty; `/api/v1/surveys` is the
  catalog-backed directory used by the page, and its product detail routes are
  available on demand.
- No old ReplicaSets or release PVC directories were deleted. The temporary
  `.tmp-ui` Chromium profile was removed after local QA.

The next release should run the Workspace Resource Package consumer tests
against the refreshed catalog and archive hashes. Any future visual QA that
requires the in-app browser still needs a connected browser instance.
