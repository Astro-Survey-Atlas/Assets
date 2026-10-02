# Four-survey MVP

## Current follow-up (2026-10-02)

The current deployment and remaining work are recorded in [HANDOFF](../HANDOFF.md).
Assets Dev is Helm revision 316; the active managed native index is generation 2.
The four-survey MVP has complete page/JSON/CSV desktop acceptance for O4 C02,
cells `[637,639,725,958,959,1002,1003]`. O4 C01 `[190]` is separately verified
for DESI + Euclid and correctly reports the unresolved ERO footprint mapping.
These checks do not establish native matches for every overlap component.

The C01 spatial page is exhausted and contains DESI DR1 Tile `82406` only.
Euclid ERO coverage/source identity remains visible, but seven target footprints
have no verified association in the inspected official outreach table. The
Messier78/M78 alias is now mapped and lies at O4 cell `[1429]`, outside C01.
The 875 records from the earlier DESI + Euclid Q1 C04 selection do not establish
C01 completeness.

Ordinary browsing uses the existing immutable query snapshot and signed cursor.
JSON/CSV export drains pages from that same snapshot. No independent query-session
create/status/stop/continue API was added. The gap notice was accepted on Assets
315 and remains in 316; it matches the C01 page, JSON and CSV. Revision 316 also
contains the desktop-checked native management UI update. An unauthenticated
first-page check of other O4 components is only a preview; until their cursors
are exhausted, missing surveys must not be interpreted as no match.

## Scope

Euclid, DESI, Legacy Surveys and HST share one region inspection and manifest
flow. Desktop is the acceptance target. Ordinary cell inspection lists releases
and modalities only. Overlap unions selected products within a survey and
intersects survey unions, including all eleven combinations of two or more
surveys. A component click submits all of its cells up to 4,096. Regions over
100 square degrees are split into bounded subqueries of at most 64 cells and
100 square degrees; the existing cursor advances up to 32 subqueries per
request until a page is full. Each cell retains its actual requested order.

| Owner | Persistent data | Region response |
| --- | --- | --- |
| Assets | Public coverage, native indexes, evidence, caches and snapshots | Native Tile/brick/target/observation identities, all source URIs, modality, footprint, order and precision |
| Workspace | Public geometry/metadata packages; private CSST scans, coverage and file mappings | Temporary Assets result plus deduplicated CSST immediate parent directories |

Workspace calls Assets server-side with an API Key and only public selectors.
Private identities and paths never cross into Assets. Public reverse responses
are not persisted in Workspace. Geometry remains usable without a Key; public
native lookup has no anonymous/crawler fallback. Browser JSON/CSV export is
a source manifest, never a scientific data download.

## Assets 315 Reverse-Lookup Checkpoint

- **DESI + Euclid O4 C01 `[190]`:** the exhausted spatial page contains one
  estimated DESI DR1 Tile (`82406`). The Euclid ERO coverage match, source
  entrypoint and seven-target footprint gap remain visible. Page, JSON and CSV
  agree; the query is still incomplete and is not an inventory-completeness
  claim. Evidence is in `/tmp/assets-c01-desktop-315/`.
- **Euclid + DESI + Legacy Surveys + HST O4 C02
  `[637,639,725,958,959,1002,1003]`:** 22,772 native records were drained and
  matched one by one across the page, JSON and CSV. Every survey is represented.
  The cursor ended, but `resultTruncated=true`, `queryExhausted=false` and
  `inventoryComplete=false` remain because source/query bounds still apply.
  Evidence is in `/tmp/assets-four-survey-315/`.
- **O4 C01 `[483,486,487,498]`, C03 `[787,790]`, and C04 `[1944]`:** anonymous
  first-page previews returned continuations. They are not exhaustive component
  checks, and an absent survey on those pages is not a confirmed no-match.

These are the minimum public reverse-lookup checks for user review. The native
management UI was separately checked on Assets 316. Broader component validation
follows after the user accepts the MVP. Workspace remains at revision 62; its
earlier complete seven-cell result is a separate product-layer selection and does
not replace these Assets checks.

## One Real Region: Abell 2390

The existing four-survey public overlap includes order-8 NESTED cells
`202250` and `202272` near Abell 2390. Use the published geometry; do not modify
MOCs or publish a new release to create this example.

- Euclid ERO: `target` identity `ERO-Abell2390`, read from official ESA ERO
  XML and associated with ESA Sky outreach `stc_s`. Official VIS/NISP Stack
  and Catalog package URLs are retained. The outreach extent is estimated;
  it is not a verified instrument/filter footprint or Tile roster.
- DESI: DR1/EDR Tile candidates from locked completeness tables. Circular
  focal-plane geometry is estimated, not target-level spectral coverage.
- Legacy DR10: Abell 2390 (Dec about +17 degrees) is inside the official DR10
  South footprint boundary (Dec <= 32.375 degrees); the locked South roster
  returns 11 native brick candidates there. The local index covers all
  366,912 official South roster members and derives per-band Coadd candidates
  from positive `NEXP_g/r/i/z`. Sky north of the DR10 boundary uses the
  separate DR9 North release and its own brick identities/URI rules.
- HST: both cell and overlap reverse lookup use a local SQLite index built from
  the SHA-locked public MAST CAOM snapshot; requests do not query MAST. The
  index currently includes 916,116 observation IDs from the 1,201,094-row
  snapshot. It matches saved `s_region` footprints and links to the MAST
  observation page; file-level product lists and access policy remain on MAST.
  Complex boundaries may use a conservative spherical-cap estimate. Eighteen
  rows with `GSC1`/`OTHER` frame labels remain excluded because their coordinate
  semantics are unresolved; they keep HST inventory marked incomplete. This
  captured scope is not a complete or live HST inventory.

The official ERO target extent used for this association is:

```text
POLYGON ICRS 328.889286 17.5327373 328.5711216 18.1453116
327.9278751 17.8408843 328.2476865 17.2293456
```

No referenced scientific contents, headers, ranges or previews are fetched.
Only official metadata inventories and existing public geometry are read.

## Earlier Dev Verification

Assets revision 305 is available at `http://10.15.51.75:32083/atlas/`.
Workspace revision 58 is available at
`http://astro.workspace.dev.72602.space:32080/`.
The Assets site and backend are Ready with zero restarts. Its `/healthz`
response is HTTP 200; the 603-file public bundle retains SHA-256
`0e23aca242d542d3b7ae8d96a846d2eed1ef1eabcb4f573fadeaa493c3905d6e`, and the
coverage catalog has 132 layers. The existing Legacy SQLite index was reused.

At revisions 293/294, the minimal four-layer Abell 2390 request returned 59
native units / 79 manifest items: one ERO target, one DESI DR1 Tile, eleven
Legacy DR10 bricks and 46 HST ACS observations. Revision 298 revalidates the
same eleven Legacy bricks against the complete official DR10 South roster,
replacing the earlier unscoped-geometry membership evidence. The HST count
came from the then-live MAST lookup and is historical. Missing/invalid Keys
returned 401 and changing the snapshot's region returned 409.

Selecting all products returned 78 native units at revisions 293/52.
Workspace read five pages with `pageSize=25`. At revisions 294/53 the desktop
C04 lookup returned 79 units: five ERO target/product identities, one
DESI Tile, eleven Legacy bricks and 62 HST observation/layer identities. At
revision 294 HST metadata was queried at runtime. Revision 296 now uses a local
SQLite index built from a SHA-locked snapshot of public MAST CAOM rows; reverse
lookup does not query MAST. The ordinary HST cell lookup now also uses the
locked local snapshot; its MAST links lead to the current product list and
access policy. Desktop browser checks at revision 294 confirmed the C04 JSON/CSV
export matches the displayed public list. Assets also passed
ordinary-click/no-lookup, anonymous export and API-Key unlock checks. Private
CSST verification is recorded in Workspace; private cells, paths and scan
identities must not be copied into this repository.

At revision 296 the workspace drained five pages for C04 and returned 74
unique public units with no duplicates; that count predates the local HST v4
index and DR10 roster correction. Revision 298 uses the HST v4 index: 916,116
observation IDs indexed, 284,960 duplicate CAOM rows and 18 unresolved-frame
rows excluded from 1,201,094 snapshot rows. The C04 local lookup and Dev API
returned 158 HST observations with `queryExhausted=true` and `truncated=true`;
the 18 excluded rows keep the inventory incomplete. Legacy DR10 now indexes all
366,912 official South roster members; positive `NEXP_i` is included alongside
g/r/z. Candidate file URIs are not per-file existence proofs. Official checks
found no DR10 North brick roster or North Coadd/Tractor tree. NOIRLab's
`ls_dr10.tractor` combines DR10 South with DR9 North; it does not supply DR10
North brick membership.

Workspace geometry packages are DESI 3.5.0, Euclid 3.17.0, HST 3.4.0 and
Legacy Surveys 3.1.0, all active. Existing other package selections were
preserved. Composite public source IDs have their own bounded input length;
only explicitly selected Workspace sources are read during reverse lookup.

An empty native match now retains the source index notes and an explicit
official-entrypoint note. Workspace shows surveys without returned native units
after pagination and retains clickable official entrypoints and their notes.
Archive failures remain incomplete in display and export even after all stored
pages are read. Current native Legacy DR10 lookup uses its locked South release
roster and per-band exposure evidence. The official DR10 files page lists South
Coadd and Tractor trees only; the North roster and `north/coadd/` path return
404. The all-sky brick table is geometry, not proof of DR10 North membership.
A no-hit result outside the South roster therefore reflects the published DR10
scope. Northern Legacy results must retain their actual release identity, such
as DR9 North. Do not claim four native-survey hits for every overlap.

## Revalidation on Dev Revisions 300/54 (2026-10-01)

The pure-public Abell 2390 C04 request was made through Workspace's configured
Assets API Key, with Workspace sources excluded. It drained two pages (100 and
19 items) from one Assets snapshot. The final manifest contains 74
spatial-unit identities: DESI DR1 1, Euclid ERO 5, Legacy DR10 11 and HST 57,
with 104 URI entries. The Workspace JSON manifest and its `workspaceManifestCsv`
serializer contain the same 74 units and identical URI payloads. `hasMore` is
false, while `queryExhausted=false` and `truncated=true` because the local HST
inventory excludes 18 observations with unresolved coordinate-frame labels.
The query did not time out or contact MAST.

For the current Workspace CSST layer set, the O8 four-survey overlap had 3
cells in 2 components. The smallest component was one cell. Its Assets response
contained 30 spatial units: DESI DR1 1, Euclid Q1 24, HST 5, and no Legacy DR10
South brick; all four surveys still had coverage evidence. Assets returned 78
URI entries. Workspace returned 54 deduplicated immediate parent directories,
with no directory truncation. The Workspace JSON and CSV serializers matched
all public spatial-unit/URI payloads and all private directory rows. The
HST-related `queryExhausted=false` and `truncated=true` state remained because
of the 18 excluded rows, not an upstream timeout. This result is not a complete
HST inventory, complete Euclid Q1 inventory, or DR10 North product claim.

An O4 mixed component containing 7 cells was also checked. Its wider search
timed out at the configured Assets request deadline. Workspace returned 1,875
parent candidates with an incomplete-limit warning; the response contained no
Assets result and is not evidence of a zero match. Keep DR9 North identified
as DR9 and narrow or optimize broad O4 searches before presenting a complete
plan.

For mixed Workspace lookup, the Assets request contains public layer IDs, the
selected component's order/cells and pagination selectors. CSST layer identity,
scan identity, file paths and file-level metadata remain in Workspace. The
public response and CSST directory mapping are used transiently for the
manifest and are not persisted by Workspace. No science files were scanned or
read during this revalidation.

## O4 acceptance on Dev 305/58 (2026-10-01)

The selected DR9 products constrain the common order to O4. All products within
one survey must share that order; selecting an O8 product alongside DR9 does
not remove the O4 product. The complete bounded component has seven cells and
an area of about 94 square degrees. It was queried as one region, with no
single-cell substitution.

The fourteen selected public product layers in both public replay and mixed
Workspace lookup drained one Assets snapshot over 92 pages: 9,124 manifest
items, including 9,056 native-unit records. Counts by
survey are Euclid 744, DESI 131, Legacy 5,682 and HST 2,499. Identity is
`[layerId, unitKind, unitId]`, so these counts include different product/layer
identities and are not unique HST observations or unique sky bricks. Pagination
ended with `hasMore=false` and `omitted=0`; all native IDs, modality, precision,
matching cells, URI payloads and original HST `s_region` were retained.
`queryExhausted=false`, `truncated=true` and `inventoryComplete=false` retain
upstream inventory limits, including the eighteen excluded HST frame rows.
They do not mean that unread pages remain. No-Key lookup returned 401 and a
changed snapshot region returned 409.

Assets now compresses snapshot JSON and bounds its memory cache; the pure
public O4 preview fell from an 87-second baseline to about 10.2 seconds.
Workspace continuation uses concrete public identities from the first response
and does not repeat private lookup or DR9 geometry requests. Actual 429 retry
delays are retained, and the configured Key request limit remains enforced.

Workspace revision 58 aggregates private matching file identities and native
orders in Elasticsearch, joins locator-only metadata in batches, and merges
parents as pages arrive. This replaced a 98.7-second truncated raw-edge query
with a 33.9-second complete directory probe. The deployed mixed reverse
response took about 50.0 seconds after geometry selection and returned 3,893
immediate parent directory records with `directoriesTruncated=false` and
native O10 evidence. Private-only lookup returned the same parent list without
an Assets result. A no-Key client made zero outbound public queries.

Representative native cells have their own `matchingCellsTruncated` flag;
missing parents use `directoriesTruncated`. The displayed and exported precision
must not conflate these states. Private paths, source identities and region
pixels were retained only in Workspace/request/browser memory; this document
records totals only. No scientific file was read or scanned. The Workspace
container remains limited to 1 CPU and 1 GiB.

Workspace desktop component-click and JSON/CSV button acceptance passed with
the same 9,056 public records and 3,893 private parents, including identical
URI/footprint/precision and sampling payloads. Ordinary cell clicks made no
native request; page errors and direct MAST requests were zero. Two Key rate
waits recovered on the same snapshot.

Assets desktop acceptance also passed for the full public C02 component:
O4 cells `[637,639,725,958,959,1002,1003]`. All eleven survey combinations
returned valid overlap responses. Anonymous JSON retained the current six-item
preview; API-Key unlock and the JSON/CSV buttons exhausted the same snapshot
and retained 22,772 native-unit records. Every CSV record preserved the native
identity, modality, order, precision, matching cells, all access URIs and HST
`s_region`; snapshot state and the final displayed record count matched JSON.
Ordinary clicks made no native request; page errors and direct MAST requests
were zero. Assets selected twenty product layers, while the Workspace example
selected fourteen, so the two record totals describe different layer sets.
The browser script exited zero; its summary is in
`/tmp/assets-native-authorized-browser.log` and its public-only screenshot is
`/tmp/assets-native-mvp-final-desktop.png`.

The current 305/58 public Abell 2390 O8 replay drained two pages and still
returned 74 native records / 104 URI entries: Euclid ERO 5, DESI DR1 1,
Legacy DR10 11 and HST 57. It returned no private directories and retained the
HST inventory limits after pagination ended. Earlier revision-300/54 timeouts
and truncated directory counts above are historical; API and desktop checks
for the complete bounded component have now passed.

## Desktop acceptance before managed activation on Dev 311/62 (2026-10-02)

Assets image `0.1.0-20261002-022932-multipart-manifest` and Workspace image
`0.10.38-dev-20261002-022932-native-version` are Ready with zero restarts.
The new public bundle contains 603 files with SHA-256
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`.
Legacy color imaging was reviewed and published as `imaging`, and Workspace
installed the resulting Legacy geometry package 3.2.0. All 105 published native
MOC hashes were unchanged by the metadata correction.

Both complete desktop flows passed again on these images. Assets tested all
eleven survey combinations and the full public O4 seven-cell component; its
twenty selected product layers produced 22,772 native records. Workspace used
the same complete region with fourteen public product layers, producing 9,056
public records and 3,893 immediate private parents. The displayed lists and
JSON/CSV preserved native identity, modality, all URI payloads, original HST
`s_region`, matching cells, actual order and precision. Private parents remained
complete with `directoriesTruncated=false`. No private responses or screenshots
were saved in either repository.

CSV after JSON added zero snapshot-page requests in both applications. Assets
read 236 cursor pages in total, compared with 472 before the export reuse fix.
Workspace read 94 cursor requests, including three recovered rate-limit waits.
Both exports preserved the same `nativeUnitIndexRevision` and snapshot. These
checks ran on `imported-baseline` while the managed native archive was still
pending. Page errors, ordinary-click native requests and direct MAST requests
were zero. HST inventory exclusions and other source limits remain visible
after all stored pages are exhausted.

The homepage and local Swagger passed a real desktop Try it out check:
seven documented operations and 44 Euclid O4 cells, with zero browser errors
or external requests. Missing and invalid native-query API Keys returned 401.
A published MOC range request returned 206 with the expected SHA. Current
public authority dependencies total 162,978,439 bytes over 131 unique objects;
the two site/backend release caches are derived copies.

## Managed activation on Dev 311/62 (2026-10-02)

The native group
`7934212d371634751fc1119c3a9a5ccccb10e8061dce5d930988c50bf8b7d7b6` is now active
at generation 1. All 640 dependencies completed archive verification; a real
gzip source restored in isolated scratch with both hashes verified. Group
restore/reverification, the subsequent UI gap review, CAS activation and site
HTTP verification completed through the management workflow. A real DR10
acquire/build returned `noChange=true`, keeping both original SQLite hashes and
the active version. Application images and native MOC hashes were preserved.

The selected-region Assets desktop flow passed after activation: all eleven survey
combinations, the fixed O4 seven-cell component, six-item anonymous preview and 22,772
authorized native records. Display, JSON and CSV preserve the same current
native version, URI/footprint/precision and native identities. CSV added zero
pages after JSON; total cursor requests remained 236. Ordinary-click native
requests, direct MAST requests and browser errors were zero. Evidence is in
`/tmp/assets-managed-active-assets-desktop.log`.

Workspace's complete desktop flow also passed on the active group: fourteen
public product layers produced 9,056 native records (Euclid 744, DESI 131,
Legacy 5,682 and HST 2,499) with 3,893 immediate private parents and
`directoriesTruncated=false`. Display, JSON and CSV matched each native URI,
footprint, precision, order and directory sampling flag. CSV added zero pages;
93 cursor requests included two recovered Key quota waits. Ordinary-click
native requests, direct MAST requests and browser errors were zero. The private
response, exports, preferences and identifiers remained in memory; only summary
counts were saved in `/tmp/assets-managed-active-workspace-desktop.log`.

The active-version SSE check kept the complete seven-cell region: Assets first
meaningful batch 4.437 s / complete query 20.189 s; Workspace 4.692 s / 33.495 s,
52 batches and 3,893 complete parents. Mixed geometry took 12.376 s initially
and 0.560 s on reuse. The container limits and Key quota were preserved. These
query timings precede full paginated export; Key quota waits still apply to
that export. Evidence is in `/tmp/assets-managed-active-stream-perf.log`.

Frozen pagination also passed across activation: the old snapshot retains
`imported-baseline`, its 56 native records and all four source identities;
fresh queries use the managed group. That old selector had no Euclid native
match; source preservation and version continuity do not manufacture a missing
unit. Four-survey results for the fixed region are checked by the component flow above.
Native inventory gaps in other components require their own lookup and acceptance.

Published O4 HEALPix pagination was revalidated after activation: Euclid 44,
DESI 1,385, Legacy 2,247 and HST 2,262 sorted unique cells. Unsupported O13
requests returned 422, revision/order conflicts 409 and invalid cursors 400.
An actual public quota wait resumed successfully. These lists describe
published MOCs independently of native-unit inventory completeness.

## Acceptance

1. Ordinary four-survey cell inspection displays release/modality metadata
   without a native lookup or live MAST request.
2. Overlap component inspection returns source-supported units from all four
   surveys, preserving multiple URIs and source policies.
3. Anonymous Assets export retains the current six-item preview and omission
   status. With a valid Key, export exhausts one immutable snapshot and the
   resulting displayed list equals the exported list. Expiry, revision, scope
   and access identity are enforced; query exhaustion is not inventory completeness.
4. Workspace uses the four geometry packages and intersects local CSST. Public
   lookup comes only from Assets; private lookup returns matched file parents.
   No-Key/invalid-Key cases preserve geometry/private results and report public
   unavailability.
5. Existing releases, scans, selections, histories and worktree edits are
   preserved. Application rollouts, reviewed product metadata publication and
   native-index activation remain separate operations with their own evidence.

## Inventory Limits

Q1 covers the locked 2,908 BGSUB rows / 352 Tiles only. ERO has no verified Tile
roster. The user-provided DESI OSS copy contains 904 scanned redrock files;
about 904 spectra archives and 12,855 coadds remain unscanned and do not represent
complete BGS/DR1. Legacy DR5-DR9 URI rules and every brick file are not fully
verified. Workspace now uses Legacy package 3.2.0 and also selects Assets runtime
DR9 layers with their actual O4 geometry and DR9 identity. HSC's existing
tract/patch adapter is outside this MVP and does not establish DAS file existence.
The DR10 color-imaging product was corrected to `imaging` through product
revision 6 review and publication on 2026-10-02. Its native MOC hash did not
change; the resulting Legacy metadata package is version 3.2.0.
Do not increase memory limits solely because the prior Legacy index cold build
approached 4 GiB; assess streaming or incremental builds before expanding inputs.

## Control-state synchronization on Dev 312/62 (2026-10-02)

Assets revision 312, image `0.1.0-20261002-054741-snapshot-batches`, fixes
control-mirror acknowledgement waiting behind an entire historical upload
queue. Bounded uploads rotate namespaces and prioritize their newest complete
snapshot; reconciliation advances each namespace to its newest verified
uploaded generation. Historical snapshots remain queued for archive, and
pointers never regress.

Native control generation 370, publication-task generation 2623 and
API-management generation 238 are synced. Isolated native-control restoration
matches local state, retaining eighteen sources and both recorded groups.
At the check, 565 historical snapshots remained queued, with zero unacknowledged
newer generations or upload failures. The native authority still uses the same
active group at generation 1 and the same manifest SHA; health/status confirms
603 public files and an available reverse runtime. The complete desktop and
performance evidence above was collected on 311/62; this follow-up checks the
control-state fix. Build, Helm lint and site/backend rollout passed; repository
tests and the full desktop scene were not repeated.
