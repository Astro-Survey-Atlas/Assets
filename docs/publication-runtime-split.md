# Publication runtime and recovery

The role split was deployed at revision 179. See [HANDOFF](../HANDOFF.md) for image, live counts and recovery
evidence. The cutover instructions below describe the completed migration; do not
repeat them on the already split deployment.

Warehouse owns scan execution and status. Assets submits standard scan requests,
consumes normalized results, and builds candidates. Official MOC import uses the
same existing Core validation/build path. Neither scan completion nor MOC build
completion publishes a product: a revision/hash-bound review and explicit product
selection are still required. DR selection groups reviewed products.

## Processes and volumes

`ASSETS_ROLE=site` serves verified public releases, access checks, and public APIs.
It does not initialize product/editorial/build/task stores. Existing admin API
paths proxy to the internal backend and return 503 if that backend is unavailable.
The website has only its own release cache PVC. Every request retains its catalog
and public snapshot through AsyncLocalStorage, including across asynchronous reads.
Startup and 5-second refresh use the same serialized authority synchronizer.
The public Deployment can roll while retaining the old ready Pod; the backend
remains single-replica Recreate. A
startup without authority access can serve a completely verified installed release.
Release staging and symlink names use UUIDs; local kernel locks survive neither
process death nor PID namespace confusion. Release directories remain available
for in-flight readers; automatic history deletion is disabled in this mode.

`ASSETS_ROLE=backend` is the only business-state writer. Its Deployment uses
Recreate and one replica. A lifetime local filesystem lock rejects a second owner.
It exclusively mounts the existing local-path content/work PVC and upload spool,
plus the evidence PVC. Its authority release cache is a separate PVC from the
website's. Do not place `publication/tasks.sqlite` on NFS. The old publisher
Deployment is disabled when `splitRoles.enabled=true`.

SQLite WAL with FULL synchronous commits owns task submission, idempotency,
frozen selections, attempts, leases and progress. The HTTP process acknowledges
202 only after durable submission. Each publication executor is a child process;
its writes to task state and its authority activation requests pass through fenced
IPC. The parent alone advances the authority pointer using object-store CAS.
Existing JSON business stores remain backend-owned, and HTTP mutations are
serialized. Core computational child processes retain their existing build path.

## Publication and recovery

1. Freeze selected reviewed product records and immutable artifact references.
2. Claim an attempt; heartbeat every 15 seconds with a 120-second lease.
3. Build against the latest verified authority baseline, preserving other products.
4. Upload missing SHA-addressed objects, restore the candidate and check hashes.
5. Recheck selected revision/review, persist the candidate identity, and CAS the
   authority pointer. Cancellation is rejected during this step.
6. Independently poll website health, product, coverage and package identities.
   Until successful, the task remains verifying. After 120 seconds the UI says
   website synchronization is delayed and continues checking.

Full `release.tar.gz` is an export/restore artifact, not a single-product upload
requirement. Existing archive references remain readable for older authority
manifests. Snapshot upload, publication execution, release synchronization and
website verification have separate loops, so a snapshot conflict cannot stop the
publication queue.

Transient transport failures and stopped executors receive at most three automatic
retries, after 5, 15 and 45 seconds. Validation/review/version errors remain failed.
An uncertain authority write must be reconciled before any retry. If the pointer
committed, resume website verification without another upload. Executors are killed
and reaped before recovery; old attempt messages cannot advance the pointer.

The task detail exposes cancel queued / stop running. Activated releases require
withdrawal, not cancellation. Retry preserves the frozen payload; changed revisions
or reviews require a new submission. Runs and attempts are retained. The
`publication-tasks` authority snapshot includes the durable queue and attempts;
pending snapshots remain recoverable from the local PVC. Never expose these
snapshots or normalized scans in initial browser payloads.

## Dev cutover

Use the existing Helm values plus the new image, with these ordered stages:

1. Confirm no active legacy publications. Preserve the authority pointer, business
   records and legacy history. Build/test/lint before publishing the image.
2. Upgrade with `splitRoles.enabled=true,splitRoles.backendReplicas=0`. This stops
   both legacy mutable processes and starts the public-only website on its new
   cache PVC. No new backend writes can overlap old writes.
3. After old pods have exited, take a consistent content/spool backup from a
   temporary read-only mount. Preserve the old release/content/evidence/spool PVCs.
4. Upgrade with `splitRoles.backendReplicas=1`. Import legacy run IDs and retain
   their files. Legacy unfinished runs without frozen inputs require explicit
   recovery; the compatibility retry checks the original selected revisions and
   reviews before freezing them. Changed drafts must be reviewed and resubmitted.
5. Check both roles, precise Service endpoints, admin authentication/proxy,
   publication history, authority SHA, public products/coverage/packages and FITS
   range responses. Keep snapshots/backups and record the actual rollout receipt.

## Rollback after new writes

A blind Helm rollback is not a data rollback. Stop the backend first; preserve the
SQLite database, WAL, business JSON, spool and current authority pointer. Run
`node dist/scripts/export-publication-rollback.js <tasks.sqlite> <new-directory>`
on that stopped database. It exports legacy-compatible history without modifying
the database or authority. Interrupted tasks are exported failed for explicit
review/version recovery; activated tasks retain their bundle identity.

Review and copy those exported records into the legacy runs directory only while
all writers remain stopped. Retain the new-format database and backups. Start the
old runtime against the latest authority and business records, not a pre-cutover
snapshot that would discard post-cutover edits. Preserve both new cache PVCs.

During the dev cutover, both independent caches were seeded from the old immutable
release only after checking its authority bundle SHA and all 477 manifest files.
The temporary migration pod is not part of the runtime layout. Each service still
checks the authority pointer and validates its installed cache at startup.
