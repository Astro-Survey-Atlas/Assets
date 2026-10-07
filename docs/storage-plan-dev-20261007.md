# Assets Dev Storage Plan

Snapshot date: 2026-10-07, after native generation 13 activation. This plan
covers Dev only. It does not change storage, delete objects, or move data.
Assets stores metadata and indexes, not survey science images or spectra.

## Current Footprint

Measurements use `du -sb` inside the Assets pods, a read-only `ListObjectsV2`
walk of the configured `asa-resource` bucket, and Kubernetes PVC status. The
bucket list reports current object sizes; it excludes old object versions and
uncompleted multipart parts. Directory and object totals overlap and must not
be added together as a migration estimate.

| Tier | Measured use | Capacity and ownership |
| --- | ---: | --- |
| Evidence PVC | 109,692,214,128 bytes / 102.16 GiB | NFS PV requested at 256 GiB; mounted from `10.15.49.212` |
| Backend cache `/data` | 5,248,569,182 bytes / 4.89 GiB | 8 GiB local-path PVC on `eva7028`; reproducible release cache |
| Site cache `/data` | 5,273,788,254 bytes / 4.91 GiB | 8 GiB local-path PVC on `eva7028`; reproducible release cache |
| Content PVC | 167,187,281 bytes / 0.16 GiB | 64 MiB local-path PVC on `eva7028`; contains managed state and task databases |
| Upload spool | 140,780,790 bytes / 0.13 GiB | 1 GiB local-path PVC on `eva7028`; application admission budget is also 1 GiB |
| `asa-resource` bucket | 46,756,999,982 bytes / 43.55 GiB in 11,983 objects | Shared 60 GiB quota; 16.45 GiB remains (72.6% used) |

The evidence PVC contains 95,339,582,976 bytes / 88.79 GiB under
`managed/native-units/indexes`, 1,227,110,287 bytes of staged native inputs,
6,032,079,929 bytes of rebuildable archive cache, 4,679,323,648 bytes under
`derived`, and 696,502,368 bytes under `source-units`. The index directory
includes historical and candidate copies; it is not the size of the active
index alone.

The object bucket's largest prefixes are `state/` at 36.19 GB, `native-units/`
at 6.49 GB, `environments/` at 2.88 GB, `public/` at 0.81 GB, and
`reverse-lookups/` at 0.22 GB. `state/` contains full historical control
snapshots and is not all required for a first migration. The bucket is shared
with other environments, so its full size is not Dev-owned data.

The NFS filesystem reported 1,965,731,872,768 bytes total, 1,096,380,579,840
bytes used and 769,422,000,128 bytes free (59% used). This is the backing
filesystem view, not a per-PVC quota. The
256 GiB PVC request has not been verified as a hard NFS quota. The local-path
PVCs share `eva7028`'s root filesystem; after the spool compaction its current
view was 527,295,578,112 bytes total, 48,066,654,208 bytes used and
452,368,601,088 bytes free (10% used). Neither PVC requests
nor node-wide free space reserve capacity exclusively for Assets.

The previous authority audit found the evidence PVC and MinIO's NFS volume on
the same storage host, `10.15.49.212`. Treating that MinIO bucket as the only
backup would therefore leave a shared failure domain. The public MinIO route
was used for this inventory. A cluster-internal route returned
`InvalidAccessKeyId`; do not change endpoints until its bucket and credentials
are independently verified.

Read-only probes from the workstation found two reachable Unistor S3 services,
but only bucket listing was verified. Their accounts expose several existing
buckets, `rclone about` is unsupported, and neither bucket ownership, a
dedicated Assets bucket/quota nor physical failure-domain separation from
`10.15.49.212` is established. No destination has been selected and no remote
write was made; treat these endpoints as unqualified leads until the owner and
provider confirm an isolated bucket, enforceable capacity and independent
failure domain.

The active generation 13 group contains 1,385 dependency references representing
1,372 distinct original content hashes: 13,132,850,063 raw bytes and
2,464,807,145 archived bytes. Its three SQLite files total 10,684,186,624
bytes. These files already sit inside the measured evidence footprint, and
some archived objects overlap earlier groups. Do not add these values to the
PVC or bucket totals as new usage or treat them as net bucket growth.

## Reference Dry Run

At 2026-10-07 18:32 CST, an authenticated, read-only management API inventory
resolved every file reference in the active generation 13 group and its
immediate generation 12 rollback group. The counts below deduplicate original
files by SHA-256 and archived representations by immutable object key:

| Retention set | References | Unique objects | Original bytes | Archived bytes |
| --- | ---: | ---: | ---: | ---: |
| Generation 13 active | 1,385 | 1,372 | 13,132,850,063 | 2,464,807,145 |
| Generation 12 rollback | 1,363 | 1,352 | 13,045,511,366 | 2,430,526,441 |
| Active + rollback union | 2,748 | 1,373 | 21,334,467,471 | 3,243,243,835 |

The two generations share 1,351 immutable object keys. No file reference in
this selected pair lacks an object key. This is a minimum native-index recovery
set of about 3.02 GiB of archived objects, not a complete migration estimate.
The calculation did not re-read object bodies and excludes version-manifest
JSON, current/control pointers, state snapshots, older group history, the
public release, other namespaces and evidence-PVC-only data.

The current control view contains 31 group records and no nonterminal native
tasks. Across all groups, the same read-only reference resolution found
30,177 references, 1,386 distinct original hashes / 67,016,080,717 original
bytes, and 1,384 known object keys / 6,403,738,444 archived bytes. Five groups
are not fully archived; two of those have accepted reviews and three have no
review. Their 1,337 references without object keys collapse to two distinct
raw hashes totaling 6,988,058,090 bytes. These are older, non-active records;
the management state has no explicit retirement marker, so their preservation
or retirement remains part of the state-history decision. Preserving all group
history would require the known 6,403,738,444 archived bytes plus transfer of
those two local-only files (up to their 6,988,058,090 raw bytes before
compression), before adding control snapshots, public release state or a new
candidate. No files were copied, removed or rewritten during this dry run.

The spool compaction fix is deployed at Helm revision 354; Dev is currently at
revision 355. It reduced the local spool from 37,180,447,529 bytes to about
0.57 GiB while preserving leased and unique jobs. The current spool is
140,780,790 bytes. The 1 GiB admission limit is an application guard, not a filesystem
quota. If admission reaches that limit, new state checkpoints fail closed while
the local business state remains; operators must restore admission and wait for
the newest namespace checkpoint to become `synced` before activation or
migration.

## Retention Rules

- The user set a Dev retention target of at most three completed versions per
  logical content lineage, counting the active version. Keep candidate inputs
  and dependencies while build, review, archive, or activation work is open.
  Shared immutable objects remain while any retained version references them;
  calculate reclaimable bytes from a reference-aware dry run before pruning.
- Keep the active native pointer, its immutable version manifest, and every
  dependency referenced by that manifest. Keep the reviewed candidate, its
  inputs, and all dependencies while build, review, archive, or activation work
  remains open.
- Keep the current public release pointer and all of its referenced objects.
  Keep the previous verified release while it is the approved rollback target.
- Keep each namespace's latest acknowledged state snapshot and pointer. The
  current snapshots include the accumulated audit history; older full snapshots
  are recovery points, not unique business data.
- Keep all leased, conflicting, retryable, or not-yet-acknowledged spool jobs,
  plus every unique file job. Compact only validated, superseded state snapshots.
- Keep archive-cache files while their archive task is active or their remote
  object is not fully verified. They are rebuildable after successful archive
  verification; they are not a migration dependency.
- Site/backend release caches can be rebuilt from the public authority. Do not
  copy every historical cache directory during migration.
- Do not infer expiry from object age. No bucket lifecycle policy was present
  in the prior bucket audit. Do not add lifecycle expiry or delete remote state
  history until a reference-aware dry run is reviewed.

## Migration Work

1. Extend the read-only native-group inventory above into a full dry run.
   Decide whether the five unarchived historical groups remain in the recovery
   set, then include retained group manifests, active pointers, current/control
   objects, the newest full snapshot for each namespace, the public release,
   task backups and any open candidate. Resolve references and deduplicate by
   immutable object key; report source bytes, archived bytes, checksums, object
   count and reclaimable bytes separately. Make no changes during this step.
2. Choose a destination whose failure domain is independent of
   `10.15.49.212`. Confirm its quota and credentials without printing them.
   Reserve enough capacity for the active authority, the reviewed candidate,
   one retained rollback version, and in-flight task snapshots.
3. Copy immutable objects from the dry-run manifest and verify every remote
   size and SHA-256. Restore representative compressed inputs and SQLite files
   to scratch and verify both archive and original hashes before cutover.
4. Freeze Dev mutations for the final control-state snapshot. Require every
   namespace's `syncStatus=synced`, copy each latest state pointer/snapshot, and
   keep Dev and the destination on independent mutable pointers. Never copy an
   open SQLite database as ordinary files.
5. Switch only Dev after restore, runtime lookup, site HTTP, and rollback checks
   pass. Keep the old authority read-only until the agreed recovery window ends.

Before additional archives, measure compressed bytes in the bucket and compare
them with the shared quota's remaining capacity. This snapshot is at 72.6% of
the shared quota, with 16.45 GiB free; the proposed 75% capacity review
threshold is about 1.5 GiB away. Candidate raw bytes are not a compressed
upload forecast, and other environments share this bucket.

For planning, alerting at 75% of the bucket quota and require capacity review
before 85%; alert at 750 MiB spool use and stop admitting optional work before
900 MiB. These are proposed operational thresholds, not deployed alerts. The
evidence NFS needs a provider-enforced per-volume quota and a separate free-space
alert because its PVC request does not establish a hard limit.

Before starting another optional survey archive, select independent
backup/object storage and produce a reference-aware dry run that applies the
three-version Dev retention target. The destination must have a failure domain
independent of `10.15.49.212`. No remote pruning or cutover has been performed
as part of this plan.
