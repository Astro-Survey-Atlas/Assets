# Assets Session Handoff

## Latest: inline survey icons and visible source workflow (2026-09-20, dev 182)

Image `0.1.0-20260920-flow-layout`, Helm revision 182. Both roles 1/1 Ready.
Live browser verified inline icon geometry, always-visible workflow and CDS link;
existing package download returned 206 bytes 0-31/408424. Public health is OK,
user bundle `reviewed-mu9992i3-7e599e9b`, 479 files.
Homepage modality icons now sit immediately after the survey name on one flex
line; precision is the compact second line. Release workflow is always visible,
with peer Existing MOC / Source data scan cards and matching heading levels.
Existing MOC names CDS MocServer and links its full public query endpoint.
Desktop uses two source columns; mobile stacks peers and preserves arrows.
This supersedes the collapsed workflow layout from revision 181.

Build, 211 Node tests + Core wheel, site types, Helm lint and diff check passed.
Updated public-workflow browser check asserts name/icon center alignment, visible
CDS URL, peer headings and absence of collapse controls, plus all previous
language/theme/responsive checks. Logs `/dev/shm/assets-flow-layout-*.log`.

## Latest: public release workflow and homepage icons (2026-09-20, dev 181)

Image `0.1.0-20260920-release-flow`, Helm revision 181.
Both site and backend are 1/1 Ready, zero restarts. Live browser verified actual
homepage SVGs, workflow expansion and existing release download links; package
Range returned 206 bytes 0-31/408416. Health remains on user publication bundle
`reviewed-mu97svf3-c2030703`, SHA256
`f075144af8e99dbf0ead0dc84e76974129bc410c0e591afe81572756b3dd9074`,
479 manifest files.
Homepage dynamic survey modality placeholders now render into scoped Lucide SVGs
after API completion, including locale refresh; precision and modality labels use
EN/ZH. `/releases/` has a default-collapsed, keyboard-accessible workflow explaining
MOC discovery vs Warehouse scan inputs, construction, version review, explicit
incremental publication and website verification. Desktop horizontal/mobile
vertical arrows; LLM branch is dashed and explicitly planned/not enabled. Home
workflow/video content and release history/download behavior are unchanged.

`docs/moc-discovery-enhancement-design.md` specifies proposed alias/networked LLM
candidate discovery, evidence, budgets, scientific validation and manual review.
Existing discovery/coverage docs link it. No LLM integration, credentials, public
API changes, scan submissions or test publications were introduced.

Build, 211 Node tests + Core wheel, site TypeScript, Helm lint and diff check passed.
`scripts/public-workflow-browser.py` verifies delayed API icon rendering, locale
refresh, empty/error states, keyboard expansion, EN/ZH, light/dark and
1440/900/390px without overflow or page errors. Fixtures intercept API responses;
live acceptance additionally checks real catalog icons and release downloads.
Logs `/dev/shm/assets-flow-{build,tests,image,push}.log`; layout screenshots
`/dev/shm/release-flow-*.png`. Preserve all dirty/untracked implementation files.

## Latest: pending verification display correction (2026-09-20, dev 180)

Image `0.1.0-20260920-pending-verification`, Helm revision 180.
User run `mu97fn25-02edfb19` actually succeeded on its first attempt: submitted
02:36:02 UTC, authority activated 02:36:48, website verified 02:37:17. Its
"uploading / failed" display came from PublicReleasePublisher.execute initializing
verification.overall to failed before any check. Changed initial and pre-activation
fallback state to pending (UI already renders 待核验); actual failure handling remains.
Regression captures every real executor repository update for building/uploading/
verifying and first failed with actual failed vs expected pending, then passed.
Build, 211 Node tests + Core wheel, site TypeScript, Helm lint and diff check pass.
Browser intercepted publication responses to verify uploading/pending and genuine
failure remain distinct; no new publication was submitted for testing.

Public product `467fbb986cd42d5968ce` is present; public coverage now has 6 layers.
Authority bundle `reviewed-mu97fn25-02edfb19`, SHA256
`196539806fe49c008b6f986dc09da993234a526023fc26143daff2baca66c2b0`.
Both roles rolled out 1/1 Ready with zero restarts; final authenticated run check
confirms published/verified and public health matches its bundle SHA.
Logs `/dev/shm/assets-pending-{build,tests,image,push}.log`.

## Latest: split publication runtime deployed (2026-09-20, dev 179)

Dev Helm revision **179**, image `0.1.0-20260920-102600-split`.
Site and backend are both 1/1 Running, zero restarts; legacy publisher removed.
Public Service targets only site (verified endpoint 10.42.1.246:4180).
Existing workspace changes remain uncommitted; preserve all tracked and new files.

Implemented the approved scan/review/incremental-publication separation. Warehouse
still owns scan execution/status. Site is public-only with authenticated admin
proxy; backend alone owns business writes and durable SQLite WAL/FULL queue on
local-path storage. Each role has its own 8Gi local-path release cache PVC, verified
against authority on startup and refreshed independently. Lifetime kernel flock,
fenced child IPC, leases/heartbeats, bounded transient retries, cancellation,
immutable reviewed selections and CAS activation replace the previous shared-write
runtime. Full release.tar.gz remains export/restore only. Website verification is
separate from publication and snapshots; activated tasks stay verifying until the
site confirms their exact selection, including a later bundle preserving it.
Historical failed runs no longer override an equal/newer published product badge.
Backend startup no longer automatically rebuilds resource packages. See
`docs/publication-runtime-split.md` for workflow, cutover and rollback procedures.

Migration stopped old writers before enabling backend. Both new caches were seeded
from the old immutable cache only after authority SHA and all 477 file hashes were
checked. Temporary migration Pods were deleted; original PVCs and history retained.
Imported 10 historical publication runs; admin has 166 products. No actual product
was reviewed or published for acceptance testing. Quiesced backups are in
`/dev/shm/assets-split-migration` (volatile host storage; retain/copy before reboot):
`quiesced-content-spool.tar.gz` SHA256
`616b19e5cd2961177ec57b98e826512fc230098cfcfac1c82726aa1f7edc66f4`,
`quiesced-current.json` SHA256
`4efb1b9434d5c9b7abf8121b00e3c20094c8a1405ba9bdfc25c26fd47eb38166`.
Rollback after new writes requires stopping backend and exporting latest SQLite
history with `scripts/export-publication-rollback.ts`; never restore stale business
state blindly. Legacy schema-3 fresh restore CLI deadlock was fixed and regression
tested. Snapshot generation persistence is now namespace-local under kernel lock.

Validation: build, site TypeScript, **210 Node tests + Core wheel**, Helm lint and
`git diff --check` passed. Tests cover real child IPC/local S3 incremental publish,
queue restart/fencing/retry/cancel, site offline/cache/proxy/hot activation, sync CLI
and namespace locking. Local action-feedback/cancel/delayed-sync browser checks
passed. Final live `scripts/admin-review-browser.py` passed at 1440/900/390px,
including state filters, dialogs, focus, polling and no browser errors. Admin proxy
returns 401 without auth and authenticated products/history return 200. Backend
startup has no automatic-package-rebuild warning. Public API reports 5 products,
5 coverage layers, 3 packages; health reports 477 manifest files (public asset list
is deliberately filtered). DESI EDR MOC Range returned 206, bytes 0-31/259200;
full file SHA and X-Content-SHA256 matched catalog.

Public URL: `http://astro.assets.dev.72602.space:32080/`.
Authority remains `reviewed-mu6tefsx-bc07840a`, SHA256
`7b280f837d8520fbdfe3079c93133f13b6d7f0c1382ba4c0c13adcb8c4493ade`.
Internal site verification uses `http://astro-survey-atlas-assets:80`; external
HTTPS hostname mismatch remains an ingress certificate issue, not bypassed TLS.
Logs: `/dev/shm/assets-plan-{build,tests}.log`,
`/dev/shm/assets-split-finalized-{build,push}.log`,
`/dev/shm/assets-split-live-browser.log`; screenshots `/dev/shm/asa-review-layout/`.
The old shared-runtime hardening concerns in revision 175 below are superseded by
this cutover. This remains a single-backend design, not a multi-writer deployment.

## Latest: publication recovery deployed (2026-09-18, dev 175)

Image `0.1.0-20260918-publication-lease2`, Helm revision 175.
Site and release publisher both 1/1 Running. Publisher had been scaled to zero;
restored by Helm. Stale active publication runs now expire after 600000 ms without
heartbeat, become failed with recovery reason, and release queue markers.
Admin list/detail expose Recover and retry through authenticated
POST /api/v1/admin/publications/:runId/recover. Original records are retained.

Recovered user run `mu6p4rna-3da9b804` through that API (HTTP 202), new run
`mu6tefsx-bc07840a` published DESI product `cc7665b2435c322ec3c9` revision 4.
Published at 10:28:38 UTC after starting 10:27:43 UTC. Live health bundle SHA:
`7b280f837d8520fbdfe3079c93133f13b6d7f0c1382ba4c0c13adcb8c4493ade` (477 files).
Public products, surveys (desi-dr1), and coverage catalog
(desi-dr1-spectra-footprint O4/O8) verified. Browser verified recovery button;
screenshot /dev/shm/publication-recovery-live.png. Build, site typecheck,
201 Node tests + Core verification, Helm lint passed. Existing unrelated
trailing blank line in test/server-http.test.ts remains.

State snapshot reconciliation no longer stops on same-generation mismatched
uploads: it retains the current remote pointer and continues to later generations.
This unblocked publication-runs@37 with two distinct uploaded snapshots.

Remaining hardening concerns: release sync lock still uses container-local PID;
site init and publisher both PID 1 raced during rollout, sharing staging paths.
Init eventually succeeded and both workloads are healthy, but the lock needs a
cross-container identity/lease before another concurrent rollout. Publication
recovery also needs cross-process fencing against late worker writes; current
write tail only serializes within one publisher instance. Generation persistence
writes all cached namespaces, so cross-namespace writers can overwrite counters;
this deserves a separate regression/fix. Do not equate these known limitations
with a fully hardened distributed queue. Preserve all dirty worktree changes.


## Current implementation: reviewed public boundary (2026-09-18)

Implemented the development hard-cutover foundation for the reviewed public
coverage boundary. `server/approved-release.ts` creates an immutable reviewed
release snapshot and package metadata; `server/native-moc.ts` validates actual
ICRS/NUNIQ cells and projects existing MOCs without inventing precision.
Product reviews carry `reviewed-release-v1` plus geometry facts; old review
records are invalidated on startup. Public coverage/products/assets are filtered
by the approved snapshot rather than Warehouse ACTIVE state. Warehouse ACTIVE
remains execution state only.

Added protected `POST /api/v1/access/region-query` with explicit layer IDs,
bounded NESTED cells, revisions, capability/completeness fields and expiry.
Reverse lookup/details and scientific asset downloads require either the
server-to-server `X-Assets-API-Key` or the development download unlock
(`POST /api/v1/access/unlock`, password default `123`); public MOCs, package
catalogs and Resource Package ZIPs remain open for Workspace synchronization.
See `docs/public-coverage-access-v1.md` for the fixed Euclid Q1 VIS + DESI DR1
order-8 integration case.

Server/site builds and TypeScript checks pass. The existing 203-test suite has
188 passing and 15 failures because its publication/HTTP fixtures assert the
old implicit-publication and anonymous-download behavior; these tests must be
updated to the reviewed snapshot and unlock contract before deployment.

## Latest: inline sky coverage state (2026-09-18, dev 160)

Replaced the separate runtime layer product list with a sky coverage status chip
after each overview product's readiness chips. Shows loaded/not loaded/unknown,
actual source and orders; Warehouse sources explicitly retain `Warehouse ACTIVE`.
Each product keeps only its existing detail button. Unlinked runtime layers remain
in a small expandable survey note alongside the load time/degradation explanation.
No Warehouse state or product mutations. Dev image
`0.1.0-20260918-inline-layer-status`, revision 160, both rollouts Ready.
Build, site types, Node/Core tests, Helm lint and diff check passed; live browser
checks passed at 1440/390px including ACTIVE labels and product detail navigation.
Health and public package audit passed; public bundle SHA unchanged from 159.

## Latest: read-only runtime layer status (2026-09-18, dev 159)

Overview survey details now contain an expandable current sky coverage panel;
no extra tab or Warehouse state mutations. The admin overview summarizes actual
loaded coverage records, source (release baseline, Warehouse ACTIVE, or activated
published product MOC), Release, actual orders, associated product review state
and published-version existence. Loaded means server catalog availability, not
browser selection or product approval. Load timestamp and degradation are shown.

Dev image `0.1.0-20260918-103851-layer-status`, Helm revision 159; site and
publisher rollouts completed. Build, site TypeScript, 203 Node tests + Core,
Helm lint and diff check passed. Live read-only browser checks passed at
1440/390px, including actual sources/time, product detail links and no page
errors. Screenshots: `/dev/shm/layers-1440.png`, `/dev/shm/layers-390.png`.
Health, coverage, FITS 206 range/hash and public package audit (72 historical
references) passed. Bundle remains `public-survey-footprints-2026-09-17`, SHA
`f126e1ff96abaebfcf03848a5a7f93d9531d2b479f3ec4906c27712f2a9777bf`.
No products were reviewed/published for testing; existing dirty work preserved.

## Latest: public product editorial copy projection (2026-09-18, dev 156)

The public product dossier previously omitted the catalog/editorial description:
`/api/v1/products/:id` returned only the generic coverage conclusion, while the
admin product editor showed `PUBLIC DESCRIPTION`. The dossier now exposes the
published description, reason and manual step; `/surveys/#product=...` renders
that copy in the product conclusion. Catalog description is used as fallback
when no published product/editorial override exists. Build, TypeScript and 203
tests passed. Dev revision 156 is Ready.

## Latest: review result refresh correction (2026-09-17, dev 153)

Image `0.1.0-20260917-154302-review-refresh`. The survey product browser was
incorrectly covered by the generic open-dialog snapshot freeze: after review,
fresh API responses were cached but the reviewed filter rendered old records.
Refresh and deferred-close handling now exclude `review-survey-dialog` from the
freeze; actual detail/edit dialogs retain their snapshot protection.

Action-feedback regression now starts from review → Euclid → pending → product,
instead of overview. It reproduced a missing reviewed row before the fix and
passed afterward, including immediate highlight, publish guard and failure/retry.
The read-only review layout suite, build/types, 203 tests + Core, Helm lint and
diff check also passed. User product `d4f09ef93d371e7ebcb1` is ERO NISP.H and
its persisted review was confirmed by a read-only API request; it was not
reviewed or published again for testing.

## Latest: survey-first review workspace (2026-09-17, dev 152)

Dev revision 152, image `0.1.0-20260917-152757-review`, digest
`sha256:1f29bb6b1a2c1919b43c4d1dc2979027c1782ac6fa7919e7e9c84b551a1fd398`.
Site and publisher Ready. `/admin/review` starts with survey cards and status
counts; selecting a survey opens a product dialog with all/pending/reviewed/
published/retired filters. Product rows show name, modality, Release, state and
actions. Readiness, lifecycle, provenance and history remain in product details.
Unmatched products and staged builds retain their detail/registration paths.
Closing the survey dialog restores card focus and polling does not reopen it.
Review success selects the reviewed filter and reveals/highlights the product.

Build, TypeScript, 203 Node tests, Core wheel, Helm lint and diff check passed.
`scripts/admin-review-browser.py` passed locally and live at 1440/900/390px,
covering counts, filters, compact geometry, details, Escape/focus, polling and
search. Updated action-feedback browser fixture passed review/highlight,
publish duplicate guard and failure/retry, with all mutations intercepted.
Screenshots: `/dev/shm/asa-review-layout/`. Live package audit passed with 72
historical references; health retains the September 17 bundle SHA below.
Changes remain uncommitted; no push performed.

## Latest: admin icons and task result layout (2026-09-17, dev 151)

Dev image `0.1.0-20260917-150901-ui-fixes`, digest
`sha256:1a49aa7718eb7a4bac3749a56d6176434c0264fa1190368db7fcfe19b26a3e00`.
Helm revision 151; site and release publisher Ready. Existing Helm values were
reused, overriding only image.tag. User URL:
`http://astro.assets.dev.72602.space:32080/admin/tasks`.

Fixed Lucide `grid-3x3` registry casing (`Grid3x3`) and missing `UploadCloud`.
Discovery actions now inherit their button/status typography rather than generic
resource-row span styles, and wrap. Scan/result metrics wrap instead of squeezing
five fixed columns and overlapping the time column.

Validation: build, site TypeScript, Helm lint, 203 Node tests and Core wheel passed.
Run build before tests: concurrent manifest regeneration caused transient hash
mismatches; sequential rerun passed. New `scripts/admin-layout-regression.py`
reproduced icon/style/overflow failures before the fix and passes afterward.
Live read-only browser checked outputs/discovery/scans at 1440/900/390px, no
missing icon warnings, page errors or metric overflow. Screenshots:
`/dev/shm/asa-ui-discovery-{1440,900,390}.png`.

Public bundle remains `public-survey-footprints-2026-09-17`, SHA
`f126e1ff96abaebfcf03848a5a7f93d9531d2b479f3ec4906c27712f2a9777bf`.
Post-rollout package audit passed, including 72 historical package references.
Release-page browser verified Euclid 3.2.0 with ERO (7 layers), Q1 (6 layers)
and its versioned download URL. UI changes are uncommitted; no push performed.

## Latest: action feedback and detail layout (2026-09-15, dev 142)

Dev image `0.1.0-20260915-133500`, digest
`sha256:fab75b0b4a79db330b8d5d89d41f85634fa50d7337171ac7c06194cf4d44471c`;
Helm revision **142**, site and publisher Ready. User entry remains
`http://astro.assets.dev.72602.space:32080/`.

Fixed consent checkbox first-line alignment and oversized cancel button.
Successful review reveals the owning survey and product row, returns focus,
and highlights the row green for five seconds. Review/publish share a per-product
in-flight guard; buttons show spinner/aria-busy and disable duplicate requests,
including new buttons rendered while the request is pending. Failures restore
the action for retry. Connector detail has a fixed square 44px icon, wrapping
identity, and one row of three 36px square icon buttons with accessible text.

IMPORTANT user item 4 requested an explanation first: draft/published storage
and duplicate readiness panels remain unchanged. Publishing clones draft into
published and retains a working copy for future edits. Suggested future UX is
one combined panel when version/content/evidence match, separate panels only
when unpublished changes exist; user has not approved that change yet.

Build, 198 Node tests + Core wheel, TypeScript and Helm lint passed. New local
`scripts/admin-action-feedback-browser.py` intercepts every review/publish and
checks consent/cancel geometry, reveal/highlight expiry, spinner, single request
under repeated clicks, failure/retry success and square Connector controls on
mobile. Live read-only browser verified requested product
`b2c58698f7945ea9c0a2` and desktop/mobile Connector layout. No real product review
or publication was triggered for testing. Screenshots:
`/dev/shm/asa-feedback-dev-142/` and `/dev/shm/asa-action-feedback/`.
Public coverage 200 and DESI FITS Range 206 with SHA passed; authority bundle
remains `adace67a9c7bcbae0044ced06352be7263b91dade2cb0bc8a4bc1415539ee407`.
Production unchanged, no commit/push. Temporary 4199 server stopped.

Previous rollout records below are historical.

## Latest: public content correction and admin consistency (2026-09-15)

Dev Helm revision **141**, image `0.1.0-20260915-113800`, digest
`sha256:d870a02d2582a6674adaa7be010a4cbec968dfbc41b63113bb7152c32c242104`.
Site and publisher Ready. User URL remains
`http://astro.assets.dev.72602.space:32080/`.

Three August 26 Warehouse ACTIVE test layers leaked through runtime merging,
not through published survey/package data: `smoke-catalog`,
`assets-smoke-image-euclid-vis`, `assets-atlas-spectrum-sdss-current`.
Their scan_run_ids and source findings are recorded at the top of the admin
refactor plan. Server defaults now union mandatory test exclusions with custom
Helm exclusions, so old reused values cannot reintroduce them. Live catalog has
124 layers; all three are absent, direct blocks return 404, reverse lookup
returns no matches/files/entrypoints. Warehouse records/evidence were retained.

SDK is now an introduction with official docs/quickstart/source links; obsolete
CLI snippets, version 1.0.0 and undecided ownership language are removed.
GitHub project responsibilities and docs/source links were updated in EN/ZH.
Admin images use a consistent desaturated display, restoring original color on
hover/focus; Euclid/Gaia badges fit without cropping. Unpublished state uses the
lifecycle badge format, product modalities have icons, DR headers count modes.
Execution receipts share preflight styles, colored checks, duration, collapsible
input/output references and explicit missing-version badges; no historic evidence
or versions were invented.

Verification: build, TypeScript, **198 Node tests + Core wheel**, Helm lint,
five-poll usability regression and new receipt/image/modality browser fixture
passed. Live visual smoke, real product receipt, SDK/GitHub language switching,
public test-layer isolation and DESI FITS Range 206 with SHA passed. Authority
bundle remains `adace67a9c7bcbae0044ced06352be7263b91dade2cb0bc8a4bc1415539ee407`;
production unchanged. No commit/push performed.

Screenshots: `/dev/shm/asa-sep15-dev-141/`, local cases in
`/dev/shm/asa-sep15-admin/` and `/dev/shm/asa-sep15-pages/`.
Local `/tmp` writes hit errno -122 (quota); tests succeeded with TMPDIR=/dev/shm.
Snap confinement rejects profiles there, so browser verification used native
`/snap/chromium/current/usr/lib/chromium-browser/chrome` via
PLAYWRIGHT_CHROMIUM_EXECUTABLE. No unrelated temporary files were deleted.
The temporary local 4199 server was stopped after verification.

Previous rollout records below are historical.

## Latest: dev admin polish and independent task observation (2026-09-14)

Dev Helm revision **140**, image `0.1.0-20260914-171000`, digest
`sha256:21511d2927dd8b69fc0072ca3f9bbc065f6c88a4bbe8ac791b7400f19b3c44fa`.
Verified user URL: `http://astro.assets.dev.72602.space:32080/admin/overview`.
Both site and publisher Ready; hydrate retains authority bundle
`adace67a9c7bcbae0044ced06352be7263b91dade2cb0bc8a4bc1415539ee407`.

Admin survey rows are 104px with 32 local project/scientific images, separate
from coverage previews. Official public Logo, compact toolbar, whole-row
connector connection colors and right-side inventory, and 14px preflight
heading with distinct blocker/pending/pass colors are deployed. External
image URLs are source references only: CSP stays self-only. Missing images
fall back to explicit text. Existing routing and five-cycle polling protections
remain; Escape/close on product dialogs no longer causes polling to reopen them.

Discovery list/detail responses now include independent `observation` alongside
unaltered Warehouse `status`. Default 120-second acceptance timeout is a Helm
value. Assets reads bounded executor Pod/log diagnostics with 15-second cache;
known error signatures are mapped to safe messages, never raw logs. Timeout
without diagnosis remains delayed/unknown, not a fabricated executor error.
Open task detail updates status only; failed reads retain the last known state.

Warehouse recovery was implemented in the sibling Warehouse repository with
Luna Max: list-before-watch namespace checks, bounded coalescing work queue,
controller health probes and JVM OOM exit. Warehouse dev revision 6 uses
`0.2.0-20260914-controller-health`. The missing `astro-data-workspace` watch
and client failure were relevant; the earlier claim based only on the scan
operator's RBAC was incomplete because discovery has its own controller/SA.
Original Euclid request `euclid-moc-discovery-20260914065533` now SUCCEEDED,
Job `euclid-moc-discovery-20260914065533-moc-discovery`, 1 candidate. Original
requests were neither deleted nor resubmitted.

Validation: Assets build, **197 Node tests**, Core wheel, TypeScript and Helm
lint passed. Local browser regression verifies five polls, retained selection,
OOM display, diagnosis recovery, failed status queries, pause/manual refresh.
Live dev visual smoke verifies actual images, 104px rows, 14px preflight,
distinct warning/blocker colors, connector layout, dark mode and mobile.
Screenshots: `/tmp/asa-admin-visual-dev-140/` (Euclid candidate screenshot in
`/tmp/asa-admin-visual-dev-139/`). Public health/assets/coverage and Euclid WebP
return 200; DESI FITS Range returns 206 with content SHA. Revision 140 also
uses overview aggregates for toolbar counts before task lists are loaded;
the live browser verifies no placeholder dashes on overview. Production
remains unchanged. No commit/push.

Warehouse static gates and Asset caller smoke passed. Full Warehouse live
validation remains partially limited: local fixture PVC lacks
`/data/gz_desi_merger_samples.csv`; Workspace caller skipped because its
namespace does not exist. These are separate from successful Euclid recovery.

The older revision and diagnosis records below are historical.

Updated: 2026-09-14 (admin usability deployed to dev)

Latest rollout supersedes the revision 137 details below: dev Helm revision
138, image `0.1.0-20260914-142228`, running digest
`sha256:63967c1b9fd830cf5de1e061fb26d544a9a8676ef4a605aac9dd86d9a280d644`.
Admin now has explicit `/admin/overview`, `/admin/sources`, `/admin/tasks`,
`/admin/review`, `/admin/releases` routes and survey/product deep links.
Polling is workspace-scoped with cancellation, unchanged-data suppression,
stable overview/build DOM, a session pause toggle, and modal snapshots.
Overview restores L0–L3 statistics; build outputs span the full work-item width.
Validation: 193 Node tests plus Core wheel, server/site builds and types,
browser five-cycle Euclid selection regression, pause/manual refresh and
deep-link reload; hydrate succeeded and public API/Range checks passed.

Latest usability follow-up (uncommitted, deployed to dev revision 137): survey-card overview,
read-only product detail and registration confirmation, searchable discovery
product tree, existing-candidate/build labels, compact connector icons and
guided evidence checks. `POST /api/v1/admin/products/{id}/verify-build` verifies
locked source/output bytes and Core MOC validity, persists the result and
invalidates review; latest failed verification blocks review. Node suite:
190 passed plus Core wheel; local workflow smoke and JWST/Roman browser fixture
test passed. See the final usability entry in the admin refactor plan.
Roman's pending request has no status/Job: the deployed Warehouse operator
ServiceAccount cannot list MocDiscoveryRequests (`kubectl auth can-i` returned
`no`); the live Role has ScanRequest permissions only. This requires Warehouse
RBAC reconciliation; no Warehouse or cluster resource was changed here.

## Active implementation handoff

Read [S3 authority implementation plan](docs/s3-authority-implementation-plan.md)
before changing storage. That plan’s **完成 / 未完成** table is the stage
scorecard. P0-P6 are complete for this migration; preserve the receipts and
rerun the verification gates before a future release.

Confirmed production authority is the MinIO in gitignored `.info`, not the
deployed Helm `storage/minio` public bucket. Do not print `.info` credentials.
The live public pointer is `public/current.json` for bundle
`public-survey-footprints-2026-09-09` with manifest SHA
`adace67a9c7bcbae0044ced06352be7263b91dade2cb0bc8a4bc1415539ee407`.
Physical evidence pointers: `authority/evidence/current.json` snapshot
`b5be3ff04a8baf6b7516ef5a45800238730a37cc740d27e16a308af418f49ff3` (468 /
104,141,186), `authority-content/content/current.json`
`7abda54ff00eb14d4a9562d7bd4b99663c90d80b24af3d36862b2c67711a4519` (4 /
854,957), `authority-probe/evidence/current.json`
`f532707a285fc407926830c255d4bd36242f70179ffe5d281846604182890526` (1 /
4,873), and `repo-evidence/evidence/current.json`
`9ffec99fbb30995f5bb7af6878e878c1050f02acebd0478700457e9df3155b69` (250 /
239,337,574). The current content pointer is `content/current.json` snapshot
`7e27395888bda1902553761dd13230bfed7e506a71588d743a676258833baeee` (19 /
975,170). Read-only restores of the authority snapshots succeeded under
`/tmp/opencode/authority-test-info`, `authority-content-test-info`,
`authority-probe-test-info`. Helm public hydrate restored
`public-survey-footprints-2026-09-09` manifest
`adace67a9c7bcbae0044ced06352be7263b91dade2cb0bc8a4bc1415539ee407` under
`/tmp/opencode/assets-hydrate-3/cache/current`. Authority writes were limited
to the documented content/state migration and live consumer cutover; authority
history objects were not deleted.

Checkout keepers only: three CSST conformance files, Core 1.1.0 wheel,
`evidence-index.json`. Generated release/layer/raw/package/content/probe data
was deleted after those restores.

Completed in this handoff: P2 atomic/idempotent upload spool, P3 CAS state
snapshots and restore, P4 pinned hydrate-first workflow, P5 authority cutover
and old development-store cleanup, P6 API `syncStatus` plus explicit offline
fallback, and the admin-readiness refactor first pass. The refactor plan is
`docs/admin-readiness-refactor-plan.md`; preserve its remaining P2/P5 gates.
Do not add scan-to-MOC/package conversion or change DR/coverage precision.

Live development deployment: Helm revision `137`, image
`0.1.0-20260914-125847`, running pod image digest
`sha256:26d9d11187ed839b027d8da582c5c7f1cc02987aac2e30ea2c032334e71bdf26`;
site and release-publisher use `asa-resource` via
`asa-assets-authority-object-store`. Products authority pointer is generation
8 (`322cd73ca79d46cf9612356d78494262e40356ef756318054f63ba90802e1e28`);
resource-packages is generation 4
(`1a444a0384659bbdf175a9b24f723a0180724fc467e38bcef7aad5ff4a2bbda4`).
Migration deletion details are in
`docs/s3-authority-migration-receipt-20260912.json`.

Final verification for this handoff: the Node suite passed 190 tests; Core
wheel, server/site TypeScript, Vite, focused target-site verification tests,
Helm lint and `git diff --check` also passed. The local admin browser smoke
passed against the local admin service with the explicit
`--allow-control-plane-unavailable --workflow` flags (the local process has no
Warehouse API). On September 14 the dev application image was upgraded using
the live Helm values (`--reuse-values`, only `image.tag` overridden; the old
`deploy/k3s-values.yaml` reference no longer exists). Both site and publisher
rolled out successfully; hydrate exited 0 and retained the authority bundle
`adace67a9c7bcbae0044ced06352be7263b91dade2cb0bc8a4bc1415539ee407`.
Live admin browser smoke passed through `http://10.15.51.75:32083/admin/`;
public assets/coverage returned 200 and a DESI FITS Range returned 206 with
its content hash. The dev DNS host currently resolves to `10.15.49.212` and
does not accept HTTP connections from this workstation; use the NodePort.
The configured dev ingress is `astro.assets.dev.72602.space`; the separate
`astro.assets.72602.space` site was not changed. Remaining admin gates are the
Warehouse native/PVC inventory contract, a write-enabled end-to-end publish
workflow in a disposable environment, and HTTPS target-site verification for
the requested 72602 production host.

Historical sections below are not current operating instructions. Recheck
live values in P0 instead of copying old revision/hash numbers.

## Historical session records (not current operating instructions)

Repository: `/home/aaron/Repo/Astro-Survey-Atlas-Assets`

Starting commit: `49f434b`; latest code commit before this closure: `a24a9f5`

## Current Session Snapshot

### 2026-09-05 Public MOC Expansion to 100+

- Added eight additional public CDS MocServer products (2MASS 6X H/J/K and
  SDSS DR9 g/r/i/u/z) on top of the first expansion batch. The allow-listed
  harvester now locks 63 CDS source records and writes raw evidence before
  generating Assets MOC-Core layers.
- The current static release contains 101 unique raw MOC source artifacts,
  111 canonical footprint records before runtime Warehouse merge, 154 public
  products with 102 `acquired` products, and 74 generated Core layers. All
  imported layers retain ICRS/NESTED order metadata, source snapshot and record
  hashes, and estimated/product-availability limitations where applicable.
- Local gates passed: `npm run artifacts:validate`, `npm run moc:validate`,
  `npm run build`, `npm test` (115 Node tests plus Core wheel verification),
  `helm lint`, and `git diff --check`.
- Development Helm revision 122 uses image tag
  `0.1.0-20260905-021417`. The live NodePort remains
  `http://10.15.51.75:32083/`; `/healthz` reports bundle SHA-256
  `6e0af1fc390d70e46e39e67b70c0dfb562008205669624c924b148c4f7823467` and 735
  release files. `/api/v1/coverage` and `/api/v1/coverage/catalog` each return
  122 layers, and a new 2MASS 6X MOC Range request returned `206 Partial
  Content` with `X-Content-SHA256`.
- Production and the 72602 production cluster remain untouched. The working
  tree is intentionally uncommitted; preserve the generated MOC evidence and
  all pre-existing UI/catalog changes.

### 2026-09-03 Globe Visibility Fix and Development Rollout

- Fixed the coverage viewer's initial single-survey framing. When the
  selection changes from empty to one survey, the viewer now focuses the
  largest connected HEALPix component instead of averaging separated regions
  into a direction that may have no coverage. The behavior is survey-agnostic
  and applies to CSST, DESI and other multi-region footprints.
- Increased normal and dimmed coverage opacity/edge contrast, restored each
  survey's `--layer-color` for `COVERAGE LAYER` details and selection borders,
  and strengthened the indigo overlap surface/dash plus active component
  highlight for the light theme. Added a regression test for largest-component
  focus selection.
- Local verification passed: `npm run build`, `npm test` (107 Node tests plus
  Core wheel verification), `npx tsc -p tsconfig.site.json --noEmit`,
  `npm run build:site`, `helm lint charts/astro-survey-atlas-assets`, and
  `git diff --check`.
- Development Helm release is revision `115`, image tag
  `0.1.0-20260903-062410`, image manifest
  `sha256:233cd83bae19dc8d1460b74ab2cb490d2024ef78df635f0a222e510d352d57b4`
  on node `eva7028`. The `publish-assets` init container completed with exit
  code `0` and activated bundle
  `public-survey-footprints-2026-08-20` with SHA-256
  `6e480be8cbfa3269978bb9abe9495b3fe8750d7ff71044aa2fe1353a2e954d59`.
- Live development URL: `http://10.15.51.75:32083/`; ingress host:
  `http://astro.assets.dev.72602.space/`.
- Online smoke passed: `/healthz` returned `ok` with 231 release files;
  `/api/v1/assets` returned 230 public files; `/api/v1/coverage` returned 59
  footprints; `/api/v1/coverage/catalog` returned 59 layers at revision
  `577ac2c10f20b38b9d96916730805942`; and a DESI DR1 FITS Range request
  returned `206 Partial Content`, `Content-Range: bytes 0-31/1339200` and
  `X-Content-SHA256`.
- Production and the 72602 production cluster were not changed. The working
  tree remains intentionally uncommitted and contains this session's viewer,
  public-style and regression-test edits alongside earlier UI/catalog work;
  preserve and inspect those changes before the next rollout. Existing
  `.tmp-atlas-*` screenshots are local working artifacts.

Updated after the 2026-08-31 registration-defaults, coverage-layer UI and
font-consistency rollouts, the MOC discovery and reverse-lookup follow-up, the
2026-09-02 coverage control-panel adjustment, and the Gaia DR3 full-sky
catalog-presence release.
The code-stage reliability and storage-boundary work is complete in the working
tree; production deployment remains deferred. Preserve all existing changes
and inspect overlapping diffs before editing.

### Previous Development Deployment (2026-09-02)

- Helm revision `112` is running image tag `0.1.0-20260902-132800` on
  `eva7028`, serving at `http://10.15.51.75:32083/`.
- The `publish-assets` init container completed with exit code `0` and
  activated bundle SHA-256
  `6e480be8cbfa3269978bb9abe9495b3fe8750d7ff71044aa2fe1353a2e954d59`.
- Live smoke reports `/healthz` `ok`, 230 public asset files and 59 coverage
  footprints. A DESI FITS range request returned `206 Partial Content` with
  `Content-Range` and `X-Content-SHA256`.
- `npm run build`, `npm test` (106 Node tests plus Core wheel verification),
  and Helm lint passed before rollout. Production and the 72602 production
  cluster remain untouched.

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
- At that checkpoint, the dev rollout was Helm revision 112, image tag `0.1.0-20260902-132800`, bundle
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

### Historical Deployed Baseline (2026-09-02)

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
  development values file lives outside the repo (`~/.asa/k3s-values.yaml`).
- The runtime storage and Workspace handoff is documented in
  `docs/public-artifact-storage.md` and `docs/resource-package-integration.md`;
  `charts/astro-survey-atlas-assets/examples/` contains sanitized templates
  only and does not assert a real endpoint, bucket or Secret.
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

HEAD is `022a791` on `main`; the current worktree contains the post-cutover
code, tests and documentation edits and is intentionally uncommitted. Do not
restore generated packages/layers into Git. Inspect overlapping diffs before
editing storage files.

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
- Since 2026-09-10 repository evidence (raw MOC snapshots under `raw/moc/`,
  the Euclid Q1 region ZIP, and the CSST working set except the three
  conformance keepers) is not stored in Git. Its durable copies live in the
  production object store under the `repo-evidence` prefix; the tracked
  `artifacts/public-survey-footprints/evidence-index.json` pins the active
  snapshot and every object's SHA-256. Validation accepts a missing local
  evidence input only when its hash matches that index. See
  `docs/public-artifact-storage.md` for sync/restore commands.

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
- `server/artifact-store.ts` retains its filesystem adapter for explicit local
  and test tooling, while runtime hydrate and release publication require
  `ASSETS_OBJECT_STORE_REQUIRED=1`. `sync-release.ts` verifies the selected
  S3 release before activating the local `/data/current` read path; runtime
  HTTP serving remains local and does not read S3 per request.
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
At the 2026-08-28 pre-authority rollout checkpoint, object-store publication
was disabled and the service read the verified PVC release. Current runtime
hydrate and publication use the required S3 path described above.

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
The latest recorded dev rollout is Helm revision 115, image tag
`0.1.0-20260903-062410`, and serves through:

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
`6e480be8cbfa3269978bb9abe9495b3fe8750d7ff71044aa2fe1353a2e954d59`, with
220 manifest files. The init container completed successfully; the image
manifest digest is
`sha256:233cd83bae19dc8d1460b74ab2cb490d2024ef78df635f0a222e510d352d57b4`.

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

Storage migration is complete. Before a future release, read the plan matrix,
rerun the hydrate/build/test/Helm gates in a clean worktree, and verify the
authority pointer pair from `.info` without printing credentials. Keep the
release/content/evidence/upload-spool PVCs until a separate evidence-backed
retirement decision; the old development bucket and Secret were already
removed (see the migration receipt).

Warehouse items remain but are not this session’s storage path: do not treat
the terminal CSST `UPDATING` layer as public coverage; keep failed
ScanRequests as evidence.

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
