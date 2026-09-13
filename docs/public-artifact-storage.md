# Public artifact storage and release archives

This document describes the **current storage contract**. The scope and
implementation record are in the [S3 authority implementation
plan](s3-authority-implementation-plan.md). Production S3 is the
sole authority for uploaded business bytes and synced control state. The
confirmed authority endpoint is the MinIO described by gitignored `.info`, not
the currently deployed Helm `storage/minio` public-release bucket. Local
`cache/` is a verified, disposable restore; `scratch/` is recomputable work;
and `uploads/` is an explicit pending-upload spool. Compute completion does not
wait for upload completion. The online authority cutover and development-bucket
retirement are complete; active PVCs remain until a separate evidence-backed
retirement decision.

The generated release tree, local dynamic content state, dated probe and release
staging output were removed from this checkout after independent S3 restore and
size/SHA-256 checks. The source checkout retains only small software/conformance
fixtures and the evidence ledger; release validation must hydrate its data roots.

Assets v1 uses one deployment path: the release data is built as a complete,
immutable `tar.gz`, uploaded to S3-compatible object storage, and downloaded by
the `publish-assets` init container before the server starts. The runtime image
contains code and dependencies only; it never contains the public release
tree.

## Ownership and delivery classes

Assets owns the public release index, MOC, preview, evidence and reverse-lookup
boundary. Warehouse owns scan execution and status. Workspace consumes the
Assets HTTP catalog and verifies package hashes before installation.

`release-manifest.json` is the file-level integrity and catalog trust surface.
It records every public asset's logical path, media type, size, SHA-256 and
delivery class. Evidence records remain marked `evidence`; the CSST
`input-manifest.json` is not added to the public allowlist.

## Object layout

Each release is immutable and selected by a small mutable pointer:

```text
public/releases/<bundle-id>/<bundle-sha256>/release.tar.gz
public/current.json
```

`public/current.json` currently uses schema version 2:

```json
{
  "schemaVersion": 2,
  "bundle": { "id": "public-survey-footprints-2026-09-07", "sha256": "<manifest-sha256>" },
  "archiveKey": "public/releases/<bundle-id>/<manifest-sha256>/release.tar.gz",
  "archiveSizeBytes": 123,
  "archiveSha256": "<archive-sha256>",
  "publishedAt": "2026-09-07T00:00:00.000Z"
}
```

The archive contains the complete release tree needed by Assets, including the
manifest, catalog, MOCs, coverage projections, registry and recipe metadata,
provenance and Resource Package v3 archives. Package ZIPs are copied from
`ASSETS_PACKAGE_STAGING_ROOT` during packaging and are validated against the
catalog size and SHA-256. A clean code-only image build does not need package
ZIPs in its build context.

## Runtime filesystem contract

```text
/data/.staging                 temporary archive and extraction directory
/data/releases/<manifest-sha>  fully verified immutable release tree
/data/current                  atomic symlink to the active release
/var/lib/assets-content        dynamic product publication PVC
/var/lib/assets-evidence       scan and evidence PVC
```

The init container reads only `public/current.json`, downloads its
`archiveKey`, checks the archive size and SHA-256, rejects unsafe archive paths
and links, extracts to staging, runs `loadCatalog` over the extracted tree,
then atomically switches `/data/current`. A failed download, extraction or
manifest check leaves the previous active release untouched and prevents the
server container from starting.

When the selected manifest SHA already exists and passes `loadCatalog`, the
archive is not downloaded again. This hash cache is the only startup reuse
optimization; there is no image-data fallback or per-file object download.

## Build and publish

Build and validate the local release data first. Resource Package v3 archives
can live outside the repository; use the selected catalog for the package set,
not a historical fixed count:

```bash
ASSETS_PACKAGE_STAGING_ROOT=/srv/asa-resource-packages npm run catalog:build
ASSETS_PACKAGE_STAGING_ROOT=/srv/asa-resource-packages npm run artifacts:validate
ASSETS_PACKAGE_STAGING_ROOT=/srv/asa-resource-packages npm run release:package
```

`release:package` writes the archive and a sidecar descriptor containing the
bundle ID, manifest SHA-256, archive size and archive SHA-256. Upload it only
after the descriptor and archive have been checked:

```bash
ASSETS_RELEASE_ARCHIVE=/srv/releases/<bundle-sha256>.tar.gz npm run release:upload
```

The upload command requires `ASSETS_OBJECT_STORE_ENDPOINT` and
`ASSETS_OBJECT_STORE_BUCKET`, uses the configured S3 credentials, performs a
read-after-write size/hash check, and updates `public/current.json` last. A
failed upload never advances the pointer.

## Object-store configuration

The init container and upload command use:

```text
ASSETS_OBJECT_STORE_ENDPOINT
ASSETS_OBJECT_STORE_BUCKET
ASSETS_OBJECT_STORE_PREFIX             optional key prefix
ASSETS_OBJECT_STORE_REGION             defaults to us-east-1
ASSETS_OBJECT_STORE_FORCE_PATH_STYLE   true for MinIO/OSS
ASSETS_OBJECT_STORE_CURRENT_KEY        defaults to public/current.json
ASSETS_OBJECT_STORE_ACCESS_KEY_ID
ASSETS_OBJECT_STORE_SECRET_ACCESS_KEY
ASSETS_OBJECT_STORE_SESSION_TOKEN      optional
```

Kubernetes injects credentials from `objectStore.credentialsSecret`. Real
credentials and production endpoints are never committed to values files or
written to logs. The chart always runs archive pull; its default values are
intentionally incomplete until an endpoint, bucket and least-privilege Secret
are supplied.

## Evidence storage (repository evidence)

Upstream MOC source snapshots (`raw/moc/`), the Euclid Q1 region ZIP and the
bulk of the CSST working set (input manifest, normalized scans, job/task
snapshots, reports) are evidence, not runtime data. Their durable copies live
in the production object store under the `repo-evidence` key prefix, separate
from both `public/releases/` and the in-cluster evidence PVC namespace:

```text
repo-evidence/evidence/objects/<sha256>       content-addressed objects
repo-evidence/evidence/snapshots/<id>.json    immutable snapshot manifests
repo-evidence/evidence/current.json           mutable pointer
```

`artifacts/public-survey-footprints/evidence-index.json` is the tracked ledger:
it pins the active snapshot and lists every archived object's repository
relative path, size and SHA-256. Release validation
(`npm run artifacts:validate`, `npm run catalog:build`) accepts a locally
missing evidence input only when its hash matches this index, so a fresh
workspace stays verifiable while bulk evidence stays out of Git. The checkout
retains only the three CSST conformance keepers, the Core wheel and this
evidence index. Generated release trees, layer outputs, raw inputs, dynamic
content, probe output and staging directories were removed only after
independent S3 restore plus exact SHA-256 and size checks. Recomputing a
product requires restoring its indexed inputs first; those historical build
paths are not runtime authority.

Restore a working evidence tree with:

```bash
node --import tsx scripts/content-archive.ts sync evidence --include "<families>"   # publish
node --import tsx scripts/content-archive.ts restore evidence --root <target-dir>   # verify+restore
```

Both commands take their store configuration from `ASSETS_OBJECT_STORE_*` plus
`ASSETS_OBJECT_STORE_PREFIX=repo-evidence` and scan the root configured by
`ASSETS_EVIDENCE_ROOT`. After any future evidence re-sync, regenerate
`evidence-index.json` from the verified restore so validation keeps accepting
the archived inputs. Active snapshot:
`9ffec99fbb30995f5bb7af6878e878c1050f02acebd0478700457e9df3155b69`
(250 objects, 239,337,574 bytes, published 2026-09-10).

The P0-P5 authority restore and cutover checks were also completed against production S3:

| Prefix | Snapshot | Files | Bytes | Restore check |
| --- | --- | ---: | ---: | --- |
| `authority` | `b5be3ff04a8baf6b7516ef5a45800238730a37cc740d27e16a308af418f49ff3` | 468 | 104,141,186 | exact SHA-256 and size |
| `authority-content` | `7abda54ff00eb14d4a9562d7bd4b99663c90d80b24af3d36862b2c67711a4519` | 4 | 854,957 | exact SHA-256 and size |
| `authority-probe` | `f532707a285fc407926830c255d4bd36242f70179ffe5d281846604182890526` | 1 | 4,873 | exact SHA-256 and size |

The local generated release tree, content state, dated probe and staging copies
were removed only after those independent restores. Production S3 objects were
not deleted. The online production consumer now uses the authority bucket; the
old development objects and Secret were removed after consumer and hash checks.

Before the authority cutover on 2026-09-12, a read-only listing through the
Helm `storage/minio` configuration found only `public/current.json`. That
cluster bucket was the public-release consumer, not the authority source. The
same day, a read-only listing of the gitignored `.info` MinIO found the recorded
`authority`, `authority-content`, `authority-probe` and `repo-evidence`
pointers at `authority/evidence/current.json`,
`authority-content/content/current.json`,
`authority-probe/evidence/current.json` and
`repo-evidence/evidence/current.json`. Do not print `.info` credentials. P5
are now the source for online consumers; do not look for authority snapshots in
the retired Helm public bucket.

## Migration and rollback

The first migration is deliberately one-way:

1. Stage and validate the Resource Package v3 archives outside the repository.
2. Build one complete deterministic archive.
3. Upload and verify the immutable archive in MinIO/S3.
4. Advance `public/current.json` only after verification.
5. Deploy the code-only image with archive-pull values.
6. Confirm `/healthz`, catalog, package downloads, Range responses, ETag and
   `X-Content-SHA256`.

Rollback changes `public/current.json` to a previously verified immutable
archive and re-runs the Helm installation (`helm upgrade --install
astro-survey-atlas-assets charts/astro-survey-atlas-assets --values
<environment-values.yaml>`) so the init container re-syncs the pointed-to
release. It does not delete release objects or the PVC's previous release
directories.

Static public release downloads read the verified `/data/current` tree; dynamic
publications read the configured local content root. The server does not read S3
for each HTTP request, so Range, ETag and `X-Content-SHA256` remain local file
serving contracts. Hydrate and the Helm init container require the configured
S3 store and fail closed on a fresh environment rather than silently using the
source checkout. A plain Helm upgrade with unchanged Pod configuration may not
rerun init; rollback must verify an actual Pod recreation and the resulting
bundle hash.
