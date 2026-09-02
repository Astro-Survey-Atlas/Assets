# Assets Session Handoff

Updated: 2026-09-02

Repository: `/home/aaron/Repo/Astro-Survey-Atlas-Assets`

Starting commit: `49f434b`; latest code commit before this closure: `a24a9f5`

## Current Session Snapshot

Updated after the 2026-08-31 registration-defaults, coverage-layer UI and
font-consistency rollouts, the MOC discovery and reverse-lookup follow-up, the
2026-09-02 coverage control-panel adjustment, and the Gaia DR3 full-sky
catalog-presence release.
The code-stage reliability and storage-boundary work is complete in the working
tree; production deployment remains deferred. Preserve all existing changes
and inspect overlapping diffs before editing.

### Gaia DR3 Full-Sky Release (2026-09-02)

- Added the reviewed CDS Gaia DR3 main-source catalog-presence MOC as
  `gaia-dr3-main-source-presence`, with locked ICRS/NESTED input hash
  `ea7f15e3e2c54daf034a99caf754147d35f0c7353e2925d1dd02c1664f6562f9` and
  generated MOC hash `b0fa6948ab98c540d8f79e08ae699b406bb857c68233ebb3f33666be9869f16f`.
- Gaia publishes O4/O8 projections, 12 O4 base cells, `41252.961249 deg2`,
  `object_presence`/`catalog` classification, official Archive/TAP/CDS
  entrypoints and `entrypoint-only` reverse lookup. It is not an imaging or
  scanning-law footprint, and the raw input remains evidence-only.
- Added the `public-gaia-footprints-3.0.0` Resource Package (SHA-256
  `47a473da1e55b7f44c865bbf5512c3ba953d389bdce4704ff4b840d5aa69872b`) and
  records the official Gaia/DPAC credits URL
  `https://www.cosmos.esa.int/web/gaia-users/credits`.
  Added regression tests for full-sky projections and public metadata.
- Assets now excludes the four known Gaia smoke/self-test layer IDs from the
  runtime Warehouse merge by default and through Helm values. The Warehouse
  index still reports those foreign test layers as `ACTIVE`; coordinate their
  state transition with the Warehouse owner rather than mutating them here.
- Dev rollout is Helm revision 111, image tag `0.1.0-20260902-120500`, bundle
  SHA-256 `6e480be8cbfa3269978bb9abe9495b3fe8750d7ff71044aa2fe1353a2e954d59`,
  serving at `http://10.15.51.75:32083/`. Online smoke confirms Gaia only,
  O4/O8, full-sky area, entrypoint-only reverse lookup and no smoke layers.

### Completed in This Session

- MOC product registration accepts blank Release/product facts. Assets derives
  defaults from public catalog facts, discovery hints and selected candidates;
  explicit operator values override those defaults. The server applies the
  same fallback at submit time, so the API does not depend on browser
  pre-filling.
- The globe layer panel now reserves the viewport, hides and inert-ifies the
  coverage detail and selection queue while open, and keeps every row inside a
  scrollable `100dvh` panel with safe-area padding.
- Layer tooltips are one body-mounted instance, triggered by the entire row
  (pointer and keyboard), positioned outside the list, and suppressed on narrow
  touch layouts so they cannot cover the list or be clipped by scrolling.
- Public and admin pages use standalone Simplified Chinese WOFF2 faces. The
  `Atlas Mono` stack now falls back to the bundled `Atlas Sans CJK` face for
  Chinese glyphs, so mono-styled labels do not silently select a host JP font.
- Added focused layout and registration tests; API documentation describes the
  defaulting behavior. Warehouse and MOC-Core-SDK contracts were not changed.
- MOC discovery now exposes an explicit `discoveryState` (`running`, `ready`,
  `empty`, `incomplete` or `failed`). The admin review dialog explains failure
  reasons and evidence, hides candidate/build controls unless a complete v2
  summary is ready, and keeps retries available for terminal failures.
- Reverse lookup now returns a file-level `downloadPlan`: one row per
  FileAsset, all matching NESTED cells, HTTP(S)-only direct downloads, and
  separate official/MOC/tile entrypoints. `s3://`, `oss://` and canonical
  `file:///...` values remain non-clickable location hints. The plan is
  exported by both CSV and JSON.

### 2026-09-01 Overlap Download Plan Closure

- Every overlap component now defers reverse lookup for all layers that
  actually participate in that component. Public MOC/entrypoint layers, exact
  DESI Tile layers and Warehouse FileAsset layers are no longer filtered out
  by a file-only predicate.
- Warehouse `FileAsset.sourceUri` preserves public HTTP(S), `s3://`, `oss://`
  and hostless `file:///...` locators. Only public HTTP(S) is a browser direct
  download; local and object-store URIs are shown and copyable without being
  rewritten or falsely marked downloadable.
- DESI Tile entrypoints use the official cumulative Tile directory and carry
  `tileId` plus the exact requested NESTED cells intersecting that Tile. O4
  uses the locked coarse reverse index; finer orders rerasterize the locked
  Tile geometry with the same `queryDiscInclusive` rule before intersection.
  A component's full cell list is never copied onto each Tile.
- CSV exports distinguish `item_kind=file` and `item_kind=entrypoint`, retain
  complete file coverage matches, and expose Tile `tile_id`, exact
  `matching_cells` and `entrypoint_url`. Empty plans produce zero data rows;
  the old `no-public-download-entrypoint` placeholder is gone. JSON preserves
  the same authoritative `downloadPlan` structure.
- The compact mobile overlap view now hides the duplicate selection queue and
  gives the scrollable result panel an opaque reading surface while overlap is
  active. Desktop behavior is unchanged.
- Final local gate: `npm run build` and `npm test` pass 102 Node tests plus the Core wheel
  verification. Helm lint and development/production template rendering pass,
  as does `git diff --check`. The generated 211-file bundle remains
  `e7684305a9c81df66a2fd7c9387c1dc3672c093caecdfe36383076ee5e520f2c`.
- Cache-disabled Chromium smoke at 1440x900 and 390x844 reached CSST/DESI
  `COMMON ORDER O8` with 11,119 cells and 324 official Tile links for C01.
  Tile cells were strict subsets of the component where appropriate. The
  Chinese mobile pass loaded both bundled CJK weights, had no browser errors
  or horizontal overflow, and screenshots/canvas-region pixel samples were
  nonblank. No production or 72602 deployment was performed at that checkpoint.

### 2026-09-01 Coverage Initialization and WebGL Closure

- Coverage hydration is serialized by catalog revision. Initialization and
  `pageshow`/visibility refreshes cannot rebuild the same catalog concurrently;
  duplicate overview-block requests share one in-flight promise. A failed
  revision remains retryable, including after a `304 Not Modified`, and the
  layer retry action forces a fresh hydration.
- Reloading the coverage catalog disposes the old scene and renderer resources
  without calling `WEBGL_lose_context` on the shared canvas. Final globe
  disposal still releases the context, and queued frames from a retired viewer
  are cancelled.
- Added regression coverage for the revision queue, renderer disposal and
  independent download-plan locations; the full suite passes 103/103 Node
  tests plus Core wheel verification.
- Coverage layer queues now use the available viewport height, accept wheel and
  touch scrolling, and keep persistent layer details in the outer queue rather
  than truncating each card at a fixed inner height. Overlap Result keeps Tile
  numbers while Download Plan shows the complete official URL and source URI.
- Development deployment is Helm revision 109 with image tag
  `0.1.0-20260902-094018`; the Pod is `1/1 Running` on `eva7028`.
- Twenty delayed-catalog Chromium runs at 1440x900 all reported
  `contextLost=0`, a ready non-empty canvas, DESI selected, and no page or
  console errors. Production remains untouched.

### 2026-09-02 Coverage Control and Detail View

- `#coverage-status` now sits at the leading edge of the top-left coverage
  controls, before reset/layers/help; narrow screens wrap the status into its
  own row so the buttons remain usable.
- Cell Inspector and Overlap Result use the available viewport height with
  safe top/bottom insets, so their content can be read and scrolled without
  the old fixed inner `290px` cap. Coverage Layer and selection queue keep
  wheel/touch scrolling while hiding persistent scrollbar tracks.
- The verified image was pushed and deployed as Helm revision 109. The
  `publish-assets` init container completed successfully and activated bundle
  `e7684305a9c81df66a2fd7c9387c1dc3672c093caecdfe36383076ee5e520f2c`.
- Development smoke passed through the NodePort: `/healthz` reports 222
  release files, `/api/v1/assets` reports 221 public files, `/api/v1/coverage`
  reports 62 footprints, and a FITS Range request returned `206 Partial
  Content` with `Content-Range` and `X-Content-SHA256`. Production and the
  72602 production cluster remain untouched.

### Last Deployed Baseline

- `npm run build`, `npm test` (103 tests),
  `helm lint charts/astro-survey-atlas-assets`, Helm template rendering, and
  `git diff --check` pass.
- Helm revision 109 is healthy with image tag
  `0.1.0-20260902-094018`; the `publish-assets` init container completed and
  the Pod is `1/1 Running` on `eva7028`.
- Direct service URL: `http://10.15.51.75:32083/`.
  Ingress URLs: `http://astro.assets.dev.72602.space:32080/` and
  `https://astro.assets.dev.72602.space:32443/`.
- Health bundle SHA-256 is
  `e7684305a9c81df66a2fd7c9387c1dc3672c093caecdfe36383076ee5e520f2c`;
  `/healthz` reports 222 release files, `/api/v1/assets` reports 221 public
  files, and `/api/v1/coverage` reports 62 footprints. A FITS Range request
  returned 32 bytes with `206 Partial Content`, `Content-Range`, and
  `X-Content-SHA256`.
- The running image manifest digest is
  `sha256:8d6cefcad70660647e6b045b5b96bc48dbf59562a1b4f77063ac7259fc68c918`.
- Delayed-catalog Chromium smoke on the public NodePort passed 20/20 runs with
  no WebGL context loss, blank canvas or browser errors.

### Current code-stage closure

- The browser loads `surveys`, `coverage` and `assets` as independent resources.
  Each request retries, then keeps the current in-memory value or a validated
  browser cache; one failed request cannot clear the other catalogs. The
  source state is exposed as `fresh`, `memory`, `cached` or `unavailable` on the
  document for diagnostics.
- Admin product routes have stable JSON semantics: missing/invalid Bearer
  tokens are `401`, unknown product IDs are `404`, malformed path/JSON is `400`,
  revision conflicts are `409`, and unexpected admin errors are a generic
  `500`. The known `bb743658cd44269d7675` record is an existing CSST W2 draft.
- Release loading and object-store publication force evidence paths (input
  manifests, normalized scans, task snapshots, scan errors, raw/CSST data) to
  remain evidence even if a stale manifest declares `runtime`. Dynamic package
  and MOC records still use explicit logical asset IDs and verified hashes.
- Node regression tests cover the public catalog fallback policy, product API
  error matrix, evidence allowlist boundary, revision hydration and renderer
  disposal. Production S3, 72602 minipc, the production hostname and Ingress
  remain untouched.
- Local final gate passed: `npm run build` and `npm test` completed 103 Node
  tests plus the Core wheel verification; Helm lint, development/production
  template rendering, and `git diff --check` also pass. The generated bundle
  `e7684305a9c81df66a2fd7c9387c1dc3672c093caecdfe36383076ee5e520f2c` is
  deployed to the development NodePort only.
- `npx tsc -p tsconfig.site.json --noEmit` and the server type check pass; the
  site tsconfig now includes the installed Node type declarations used by the
  shared survey registry module.
- Chromium smoke passed at 1440px and 390px: both loaded 17 surveys with
  `document.fonts.status=loaded` and no horizontal overflow. With the coverage
  catalog request forced to fail, the page stayed populated and reported
  `data-public-catalog-state="degraded"`.

### 2026-08-31 Storage and Workspace Continuation (historical checkpoint)

- Dynamic Resource Package v3 archives are now generated from verified,
  explicitly published MOC records, persisted on the content volume and
  restored only after ID, version, path, size and SHA-256 checks. Public package
  asset IDs normalize `3.0.0` to `3-0-0` so the archive URL is a safe path
  component. FITS outputs are checked for ICRS/NUNIQ/MOC 2.0/SPACE semantics,
  and projections retain their real NESTED order and HEALPix bounds.
- `sync-release` supports production S3 `pull`: it verifies `current.json`,
  the release manifest and every object in `/data/.staging`, activates
  `/data/releases/<sha256>` and atomically switches `/data/current`. The
  development `deploy/k3s-values.yaml` remains filesystem-backed.
- The runtime storage and Workspace handoff is documented in
  `docs/public-artifact-storage.md` and `docs/resource-package-integration.md`;
  `deploy/production-values.example.yaml` contains placeholders only and does
  not assert a real endpoint, bucket or Secret.
- Workspace now accepts a dynamic Assets catalog's explicit `replacedBy: []`.
  A real static Euclid package and a temporary dynamically generated JWST
  package were downloaded completely, checked against catalog size/SHA-256,
  installed, and queried with `mocLayers()`; both returned the manifest's real
  layer identity and MOC hash.
- Assets local verification is green after the complete ZIP assertions:
  `npm run validate` (84 Node tests plus Core wheel verification), Helm lint,
  template rendering with the production overlay and `git diff --check` pass.
  Workspace `npm run build` and `npm test` pass (one PostgreSQL test is skipped
  when its URL is unset).
- The dev rollout at that checkpoint was Helm revision 101 with image
  `0.1.0-20260831-164957`, Pod `1/1 Running`, and live bundle SHA-256
  `ccc273c90738140dc3760ea387529a7d41a21e77b4187ca510f06760a1130046` at
  `http://10.15.51.75:32083/`. The live JWST Resource Package archive is
  `4d41ac806e2e9f76db13b4cddc54de7e8699c4501d35d90ccb0f34e8c7f239aa` and
  contains both published layers `moc-jwst-dr1-611dfe774f60` and
  `moc-jwst-dr1-c0924d1a5468`.
- The revision-101 smoke returned 221 public assets and 58 coverage
  footprints; a DESI FITS range returned `206 Partial Content` with
  `Content-Range` and `X-Content-SHA256`. The active filesystem path is
  `/data/current -> releases/ccc273c90738140dc3760ea387529a7d41a21e77b4187ca510f06760a1130046`,
  and the image manifest digest is
  `sha256:f86bae15a613c9755e9473ec4b7efdf31eaa36cca708673aaa534b1c49980af6`.
- Workspace installed that public JWST package from the Assets catalog and
  verified the installed MOC bytes against the manifest. Dynamic package
  asset IDs now use the same normalized semver path (`3-0-0`) when the server
  resolves catalog entries, so a same-survey static package cannot be selected
  by fallback matching. Public catalog requests on the Assets home page retry
  short transient failures and fall back to the last successful browser cache.
- Release-directory cleanup is explicit via `ASSETS_RELEASE_CLEANUP`. The
  development Helm values leave it off to avoid multi-gigabyte NFS deletion in
  the init critical path; the production overlay enables it with the reviewed
  retention count.

### Next Session

1. Read `AGENTS.md`, this handoff, `docs/coverage-workflow.md`, and the
   coverage-workflow skill before touching scan, MOC, evidence, overlap or
   reverse-lookup behavior.
2. Keep the static-plus-Warehouse catalog merge and all current tests intact;
   do not add Warehouse workflow logic to Assets or modify MOC-Core-SDK.
3. For future UI changes, repeat the desktop/mobile layer-panel smoke and
   check that tooltip rectangles remain outside the list.
4. Coordinate any new Warehouse layer or MOC discovery work with its owner;
   retain historical evidence and do not expose input manifests in the public
   release.
5. Before the next rollout, rerun the complete build/test/lint gate and use a
   new immutable image tag. Do not delete old ReplicaSets or release PVC
   directories.

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
- The admin path emits Warehouse ScanPlan v2 requests. It supports remote S3/OSS
  connectors plus local connectors that reference a Warehouse Infra-managed,
  scanner-authorized PVC and optional relative base path. Local task paths are
  translated under the read-only `/data` mount; Assets never creates hostPath
  PV/PVC resources. The admin path supports product/profile-driven task
  creation, task detail, evidence summaries and immutable retry resources; it
  does not scan data in Assets.
- The admin workspace groups task and MOC attempts by the shared work identity:
  02A shows one latest-result summary, 02B is the public MOC discovery/review
  queue, and 02C is the file-scan execution history with task creation beside
  its heading. Product review is grouped as survey cards that expand to
  release/product rows sourced from the same public survey index; unmatched
  editor records remain visible in an editorial queue. A staged MOC build that
  was created without a product appears in the product-review `__moc-builds__`
  queue; the one-time registration action creates an Assets-owned draft product
  and binds the existing build before normal copy review and publication.
- Connector ConfigMaps do not carry runtime status. The admin list therefore
  reports `NOT_CHECKED`; clicking one Connector runs a bounded, read-only
  object-store or authorized-PVC probe and returns transient `READY`, `PENDING`
  or `ERROR` data with a redacted message and `checkedAt`. Probe results stay
  in the current page only and are never written to Kubernetes or evidence.
- `src/moc-sources/source-registry.json` records eight reviewed public MOC
  sources. Four (SkyMapper DR4, KiDS DR5, VISTA VIKING J, and DECaLS DR5)
  now have locked CDS snapshots and generated Core layers; Gaia, eRASS1,
  4XMM, and Planck remain candidates pending terms review. Network discovery
  probes remain validation/evidence only.
- The overlap UI forwards the right-drawer viewport inset through
  `AtlasCoverageGlobe` to the Three.js viewer, so a successful overlap response
  can be rendered without a post-response runtime exception.
- `server/artifact-store.ts` provides an immutable filesystem fallback and an
  optional S3-compatible publication adapter. `sync-release.ts` keeps the PVC
  symlink as the active read path and only publishes to object storage when it
  is explicitly configured; runtime and evidence prefixes remain separate.
- MOC discovery is v2 and evidence-only: Warehouse returns at most 50 candidate
  summaries from a 51-record bounded search, while Assets performs the separate
  `MocBuildRequest` acquisition/build flow. Discovery has no probe or review
  POST endpoint; selecting a candidate creates a build. Discovery work-context
  identifiers are preserved through the Assets API, so product-bound builds
  remain attached to the same review item; product publication is the explicit
  public-release gate. The admin workspace exposes build phase/progress and
  output summaries while polling active work. Unbound staged builds are not
  silently discarded: `POST /api/v1/admin/moc-builds/{name}/register-product`
  records the public survey/release/product facts, binds the build once, and
  leaves publication behind the existing product-review gate.
- `MocPublicationStore` persists dynamic publication records on the content
  volume, verifies every referenced file/size/SHA-256 before activation, and
  skips missing or tampered publications on startup/reload. Published MOCs are
  added to `/api/v1/assets`, `/api/v1/coverage`, `/api/v1/surveys` and the
  predictable FITS route only after that check.
- The runtime image now includes Python, the locked scientific dependencies and
  the pinned MOC-Core-SDK wheel so the local build runner has the same contract
  as the development environment. The image is built with the PEP 427 wheel
  filename intact so pip accepts the local Core package.
- The GitHub organization page now presents Assets as the public front door,
  explains Warehouse and Workspace responsibilities, and shows the shared
  MOC-Core-SDK dependency and conformance-fixture flow. `/sdk/` documents the
  Core wheel ownership and leaves a future hosted client SDK decision open.

## Verification Baseline

The final bounded end-to-end smoke on 2026-08-26/27 used the new `ast_*`
indices. The deployed Assets health endpoint returned 200; CSST, DESI, and
Euclid ACTIVE layers appeared in catalog and overlap requests; tile/file
details included order and precision. Euclid order-8 cell `548925`
reverse-resolved through the Assets API to its OSS FileAsset metadata.

The Assets gate on 2026-08-28 is green: `npm run validate`, all 47 Node tests,
and the Core wheel verification passed; `helm lint` and `git diff --check` are
also clean. The five-step plain-language
product explanation is present on the actual `/surveys/` directory entry
point (and kept in the shared resources template). A browser smoke
loaded the deployed bundle, entered G mode with CSST/DESI, rendered
`COMMON ORDER O8 · 11,119 CELLS`, and opened the overlap drawer without new
runtime exceptions.

The 2026-08-30 admin review/work-identity change is green locally: `npm run validate`
passes 72 Node tests and the Core wheel verification, with `helm lint` and
`git diff --check` clean. The admin API now exposes the transient
`POST /api/v1/admin/connectors/{name}/probe` result. A standalone Chromium smoke
checked the admin workspace at 1440x900 and 390x844; no horizontal overflow was
observed, and the product public-facts block remains inside its dialog form.

The same build was deployed as Helm revision 88 with image tag
`0.1.0-20260830-100849`. Rollout completed with one healthy Pod; direct Service
and Ingress `/healthz` checks returned 200 with bundle
`b8fef8f5306f1419a683c7b4dc8041577820a8e1e819d8da3692fc93ca08c461`. The
live `/api/v1/assets` response contains 211 files, `/api/v1/coverage` contains
56 footprints, and a DESI FITS asset returned `206 Partial Content` with a
correct `Content-Range` and `X-Content-SHA256`.

On 2026-08-30 the Warehouse MOC discovery status path was repaired and Assets
was redeployed as Helm revision 89 with image tag `0.1.0-20260830-110326`.
The Warehouse discovery worker now uses the CDS MOCServer filter API instead of
the unsupported ADQL request. The verified JWST request
`jwst-moc-discovery-fix-20260830114238` is `SUCCEEDED` with 16 candidates, 10
probes, and 10 accepted spatial MOCs. Assets now normalizes empty arrays
omitted by Kubernetes serialization while still treating a missing summary
object as unreviewable; the earlier ADQL 0/0 attempts remain visible as
historical records.

The MOC build runtime was deployed as Helm revision 91 with image tag
`0.1.0-20260830-144338`. Rollout completed with one healthy Pod. The init
container published bundle SHA-256
`00804a3ce33a8cbd5ab5e65250e4c5315d1e54ce6e82f9d6a3399c3ca8be9ad2`; the
service loaded 56 ACTIVE Warehouse layers, exposed 211 assets, and passed a
FITS `206 Partial Content` / `Content-Range` / `X-Content-SHA256` check. The
container imports Python `astropy 7.2.0`, `astropy-healpix 1.1.2`, `mocpy 0.20.0`,
and `astro_survey_moc_core` successfully. A real v2 retry produced a staged
MOC build with source hash
`2b2337d63f69f2bd6a292b81416f0f70a87f4c4b6e0a53ef0dd49c86152c5919`, 20 cells, query order 8 and preview
order 4; it remains unpublished until a product release is approved.

The follow-up MOC discovery/build UI and publication-boundary changes were
deployed as Helm revision 92 with image tag
`0.1.0-20260830-153231`. The rollout completed with one healthy Pod on
`eva7028`; the `publish-assets` init container activated bundle SHA-256
`00804a3ce33a8cbd5ab5e65250e4c5315d1e54ce6e82f9d6a3399c3ca8be9ad2` and loaded
56 ACTIVE Warehouse layers. Direct NodePort smoke checks returned 200 for
`/healthz`, `/api/v1/assets` (211 files), and `/api/v1/coverage` (56
footprints). A DESI FITS download returned `206 Partial Content` with the
expected `Content-Range` and `X-Content-SHA256`; the admin API returned 7
discovery records, 1 staged MOC build, 4 connectors, and 90 products. The
image manifest digest is
`sha256:7b32810b8a77c7db0ccc323813a23d29e102fc5a042f9ce6d84babb60ca478df`.

The staged-build action follow-up was deployed as Helm revision 94 with image
tag `0.1.0-20260830-175732`. The rollout completed with one healthy Pod. In
addition to the product-review `__moc-builds__` queue, 02A now places a direct
`登记产品` action beside every unbound `BUILD STAGED` result. Browser smoke
against the NodePort confirmed two JWST staged builds are visible both from
that action and after searching `jwst` in 03 产品审核. The product remains a
draft until its public facts and editorial copy are reviewed and explicitly
published.

The unmatched-product publishing gap was deployed as Helm revision 95 with
image tag `0.1.0-20260830-200223`. Unmatched draft rows in 03 产品审核 now
provide both `编辑` and `发布`; the live JWST record remains `unmatched-draft`
until that explicit action is taken. Browser smoke confirmed the `jwst`
search result exposes both actions without changing the product-publication
boundary.

The product-editor publishing affordance was deployed as Helm revision 96 with
image tag `0.1.0-20260830-202758`. Draft product dialogs now expose an explicit
`发布产品` action alongside save; publishing closes the dialog and refreshes
the review queue. The live JWST draft remains `unmatched-draft` until the
operator chooses that action.

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
footprints.json` now contains 47 footprints across 17 surveys. Its generated
catalog reports 90 products (38 acquired, 11 overview-only, and 41 awaiting
geometry), and the offline Core build plan contains 10 layers. The four new
layers are derived from reviewed CDS spatial projections and retain estimated
precision; their STMOC time metadata stays in provenance evidence.
The deployed Assets `/api/v1/coverage` now retains that public base and adds the
ACTIVE layers from the current Warehouse endpoint; while the CSST retry is
`UPDATING`, the live response contains 56 footprints across the public surveys
plus the ACTIVE CSST, DESI, Euclid and Assets-owned controlled smoke layers.
The 2026-08-28 rollout activated the rebuilt bundle; object-store publication
remains disabled, so the service still reads the verified PVC release.

On 2026-08-29 the local-source contract was completed and verified in the
development cluster. Warehouse Infra revision 2 now owns the scanner source
PVC `atlas-source-catalogs` (1800Gi, ReadOnlyMany, static NFS export
`10.15.49.212:/mnt/data/catalogs`) with the scanner authorization label. Assets
revision 87 uses the PVC-aware scanner image and no longer creates PV/PVC or
accepts node-specific host paths. The local Connector
`cosmos-parameter-prediction-source` references that claim with base path
`cosmos-parameter-prediction`.

The bounded COSMOS CSV task `cosmos-parameter-prediction-catalog-20260829`
completed successfully through the Assets admin API: one discovered file,
298,232 valid catalog rows, 19 explicit order-8 coverage records and zero
errors. Its read-only source mount was `/data` with subPath
`cosmos-parameter-prediction`; evidence includes source inventory, normalized
scan, errors and summary on `atlas-evidence-smoke`. Operator image
`0.2.0-20260829-pvc2` also protects terminal ScanRequests from being recreated
when an Operator rollout changes the execution hash.
The current bounded smoke covers catalog/block reads, CSST/DESI,
Euclid/DESI and 2MASS/SDSS overlap, overlap details, reverse lookup, and FITS
Range reads.

The current Warehouse ES observation has 13 live layer documents (the index
also reports 2 deleted Lucene documents), 22,842 FileAsset documents and
92,787 coverage documents. The latter two counts include evidence from failed
or incomplete executions and are not public Assets counts. The runtime API
currently exposes 56 footprints and 56 catalog layers: the 47 static public
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

The sibling Workspace gate also passes after updating its expected Core
distribution identifier: `npm run validate` completes with 184 tests (one
PostgreSQL integration case skipped when its database URL is unset). Warehouse
passes both `mvn -B -q test` and `mvn -B -q verify`; the shared Core conformance
fixture remains pinned to MOC-Core-SDK commit `2ebc395`.

The deep-link/catalog follow-up was deployed as Helm revision 97 with image tag
`0.1.0-20260830-233430`. The live service reports 57 ACTIVE coverage layers;
JWST O4 cell `2337` and O8 cell `598322` are available, and its FITS route
returns a verified `206 Partial Content` response. Desktop and 390px mobile
browser smokes opened `/?survey=jwst&product=3b997b091a6793c40bf3`, rendered
the JWST layer, and reported no horizontal overflow or browser exceptions.

The 2026-08-31 interaction regression fix was deployed as Helm revision 98
with image tag `0.1.0-20260831-070428`. The rollout has one healthy Pod and
the `publish-assets` init container completed successfully. The live health
bundle is `00804a3ce33a8cbd5ab5e65250e4c5315d1e54ce6e82f9d6a3399c3ca8be9ad2`;
the health/API asset listing exposes 216 files (the base release manifest remains
211 files) and 57 coverage footprints.
The FITS range smoke returned `206 Partial Content` with `Content-Range` and
`X-Content-SHA256`. Browser smoke verified that entering the globe leaves all
21 survey controls unselected, Gaia O8 + DES O4 G mode explains that no common
order exists without sending an overlap request, and CSST + JWST reaches
`COMMON ORDER O8 · 1 CELLS`. The MOC registration dialog is visible and
scrollable; closing it leaves the other admin tabs operable. No page runtime
exceptions were observed in these checks.

The registration-defaults and layer-panel interaction fixes were deployed as
Helm revision 99 with image tag `0.1.0-20260831-105813`. The rollout completed
with one healthy Pod; `publish-assets` activated the same verified bundle and
the service loaded 56 ACTIVE Warehouse layers. Direct NodePort smoke checks
returned 200 for `/healthz`, `/api/v1/assets` (221 files), and
`/api/v1/coverage` (58 footprints). A DESI FITS Range request returned 32
bytes with `206 Partial Content`, the expected `Content-Range`, and
`X-Content-SHA256`. The running image manifest digest is
`sha256:6a62dc145a21fcd32cbce9a515aaf26e809dcb610cd735fbdae4bc8ad59538fb`.
Browser smoke verified that the layer list remains fully scrollable, hides the
coverage/selection overlays while open, and places the hover tooltip outside
the list without creating a mobile hover layer.

## Live Deployment Layout

Assets is a separate Helm release in namespace `astro-survey-atlas-assets`.
The latest recorded dev rollout is Helm revision 109, image tag
`0.1.0-20260902-094018`, and serves through:

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
`e7684305a9c81df66a2fd7c9387c1dc3672c093caecdfe36383076ee5e520f2c`, with
211 manifest files. The init container completed successfully; the image
manifest digest is
`sha256:8d6cefcad70660647e6b045b5b96bc48dbf59562a1b4f77063ac7259fc68c918`.

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

1. Preserve all dirty files in all repositories and keep the static-plus-
   Warehouse merge, pagination, admin reload/status behavior, object-store
   publication and overlap viewport forwarding regression-tested.
2. If an object-backed release is desired, run a staged dual-read validation
   against a non-production bucket before changing the active PVC read path.
3. Coordinate with Warehouse on the terminal CSST retry: inspect its evidence
   and layer state, then submit a new bounded retry only after choosing the
   scanner plan. Do not treat the current `UPDATING` layer as public coverage.
4. Once a successful CSST layer is genuinely `ACTIVE`, call
   `POST /api/v1/admin/catalog/reload` with the admin token and inspect
   `GET /api/v1/admin/catalog/status`; the status must show the current load
   mode, timestamp, counts and Warehouse connectivity.
5. The long Warehouse task is no longer active. The `mocdiscovery` Operator
   rollout and evidence/status path are verified; retain the completed Gaia,
   SkyMapper, KiDS, VISTA VIKING, DECaLS, and JWST discovery evidence while
   Assets continues to submit intent-only requests.
6. Rerun direct catalog, overlap, details and reverse-lookup smokes against
   bounded CSST, DESI and Euclid layers after future Warehouse image or
   mapping changes. Keep failed ScanRequests and evidence for diagnosis.

## Warehouse MOC Discovery Rollout

MOC discovery CRD/Operator/worker integration is implemented and validated.
The 2026-08-28 SkyMapper, KiDS, VISTA VIKING, and DECaLS requests used the old
CDS ObsCore ADQL endpoint and returned HTTP 200 with empty bodies; those
requests remain read-only historical evidence, not proof that the surveys lack
public MOCs. The corrected JWST request
`jwst-moc-discovery-fix-20260830114238` uses the CDS MOCServer filter API and
returned 16 candidates in the bounded v2 summary. The policy reads at most 51
records and stores at most 50 candidate summaries so truncation is reliable.
Empty or malformed responses remain protocol evidence, while a parsed,
non-truncated empty record set is a valid zero-result query. See
`docs/deferred-moc-discovery-plan.md`. Assets submits intent-only discovery,
then owns candidate selection, the independent MOC build and explicit product
publication; it does not execute the Warehouse discovery Job or alter the
Connector ScanRequest workflow.

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
