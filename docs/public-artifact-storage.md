# Public artifact storage and migration

This document records the distribution boundary for the complete public survey
footprint collection. The publication adapter is now implemented, while the
running service still uses the PVC-backed release as its active read path until
an object-backed bundle has passed dual-read validation.

## Ownership and delivery classes

Assets owns the public release index and the decision that a layer is
publishable. Warehouse owns scan execution and operational evidence for its
`ScanRequest` runs. Workspace downloads and verifies public packages but does
not become a second public catalog.

Every release entry has an explicit `deliveryClass`:

| Class | Examples | Browser startup | Long-term home |
| --- | --- | --- | --- |
| `runtime` | survey catalog, coverage catalog, small previews, query blocks, package catalog | Allowed when needed by the initial view | Git plus a versioned release object |
| `release` | Resource Package v3, native FITS MOC, large immutable query projection | On demand | Versioned public object storage |
| `evidence` | input manifest, normalized scan, task snapshot, errors, raw source MOC, Parquet exports | Never | Evidence PVC or restricted object storage |

`release-manifest.json` remains the index and trust surface. It records the
logical path, object key/URL, media type, byte size, SHA-256, bundle version,
source reference and delivery class. A storage URL or ETag never replaces the
content SHA-256.

## Proposed object layout

Use separate immutable prefixes even when the backing service is the same:

```text
public/releases/<bundle-id>/release-manifest.json
public/releases/<bundle-id>/packages/<package-id>.zip
public/releases/<bundle-id>/mocs/<layer-id>.moc.fits
public/releases/<bundle-id>/blocks/<layer-id>/o<order>/tile-<tile>.json.br
public/releases/<bundle-id>/previews/<layer-id>/o<order>.json

evidence/<survey-id>/<scan-run-id>/source-inventory.json.zst
evidence/<survey-id>/<scan-run-id>/normalized-scan.json.zst
evidence/<survey-id>/<scan-run-id>/coverage-edges.parquet
evidence/<survey-id>/<scan-run-id>/files.parquet
evidence/<survey-id>/<scan-run-id>/provenance.json
evidence/<survey-id>/<scan-run-id>/errors.jsonl.zst
```

## Runtime filesystem contract

The filesystem layout is part of the deployment contract. It keeps the public
release read path, editable publication state and evidence state separate:

| Path | Owner and contents | Lifecycle |
| --- | --- | --- |
| `/data/.staging` | `sync-release` temporary downloads, manifest checks and SHA-256 validation | Deleted after success or failure; never served |
| `/data/releases/<sha256>` | A fully verified immutable public release copied from S3 (or the image in development) | Retain the configured rollback count; never edit in place |
| `/data/current` | Symlink to the active `/data/releases/<sha256>` directory | Replaced atomically after validation; the server reads only this path |
| `/var/lib/assets-content` | Dynamic product drafts, MOC publication records and verified Resource Package v3 archives/state | Persistent content PVC; not a public source tree or a scan-evidence store |
| `/var/lib/assets-evidence` | Source snapshots, normalized scans, task snapshots, build inputs/outputs and errors | Persistent evidence PVC/object prefix; excluded from public catalog and initial browser requests |

In production `publish-assets` runs in `mode: pull`: it reads only the S3
`current.json` pointer, downloads the selected manifest and allowlisted release
objects into `/data/.staging`, verifies every size/hash, then atomically
activates `/data/current`. It does not copy the repository `artifacts/` tree
into a running pod. `mode: filesystem` is the development/image fallback;
`mode: push` is an explicit publisher used only by a release job. Release
history cleanup is controlled separately by `ASSETS_RELEASE_CLEANUP`; keep it
off for development rollouts because recursive deletion on a network PVC can
delay the init container, and enable it only in the reviewed production
overlay with the configured retention count.

Dynamic MOCs and Resource Package archives are generated only after a product
is explicitly published. Their immutable bytes live under the content PVC and
are exposed through the Assets catalog after startup/reload integrity checks;
they are not mixed into `/data/.staging` or evidence storage. A future object
store migration should publish these content records under the same immutable
release/evidence prefixes and keep the public catalog as the only Workspace
entry point.

The public prefix is anonymously readable only for allowlisted release files.
The evidence prefix is not listed in the public catalog and is exposed only
through an authenticated or explicitly signed evidence workflow. Internal
bucket names, PVC paths, Elasticsearch documents and credentials never appear
in browser responses.

## Publication contract

1. Build the release from locked recipes and verified source snapshots.
2. Write all objects under a new `<bundle-id>` prefix. Existing bundle prefixes
   are immutable and are never overwritten.
3. Generate the manifest with byte sizes and SHA-256 values after upload, then
   verify every object using a fresh read or range read.
4. Publish a small pointer (`current.json` or an equivalent deployment value)
   only after the manifest and all allowlisted objects pass validation.
5. Assets synchronizes the selected bundle to its release PVC, validates it with
   `loadCatalog`, and atomically switches the `current` symlink. Workspace
   consumes the same manifest and verifies package hashes before activation.

Rollback means changing the selected bundle pointer back to a previously
verified immutable bundle. It does not delete the newer bundle.

## Adapter and configuration

`server/artifact-store.ts` provides the same contract for a local filesystem
and an S3-compatible service. `FilesystemArtifactStore` writes through a
temporary file and refuses a different byte sequence at an existing immutable
key. `S3ArtifactStore` uses conditional `If-None-Match: *` writes, stores the
SHA-256 as object metadata, and verifies a concurrent writer before accepting
an existing key. `publishReleaseBundle()` uploads runtime objects under
`public/releases/<bundle-id>/<bundle-sha256>/` and evidence under a separate
`evidence/<bundle-id>/<bundle-sha256>/` prefix, then atomically updates
`public/current.json`.

The sync init container enables this publisher only when
`objectStore.enabled=true` (or the endpoint/bucket environment variables are
set). The default remains the filesystem adapter and the existing `current`
symlink on the release PVC. Configure an S3-compatible backend with:

```text
ASSETS_OBJECT_STORE_ENDPOINT
ASSETS_OBJECT_STORE_BUCKET
ASSETS_OBJECT_STORE_PREFIX             # optional key prefix
ASSETS_OBJECT_STORE_REGION             # defaults to us-east-1
ASSETS_OBJECT_STORE_FORCE_PATH_STYLE   # defaults to true for MinIO/OSS
ASSETS_OBJECT_STORE_PUBLIC_BASE_URL    # optional public URL base
ASSETS_OBJECT_STORE_ACCESS_KEY_ID
ASSETS_OBJECT_STORE_SECRET_ACCESS_KEY
ASSETS_OBJECT_STORE_SESSION_TOKEN      # optional
```

Credentials may instead be supplied as JSON through
`ASSETS_OBJECT_STORE_SECRET_JSON` or a mounted
`ASSETS_OBJECT_STORE_SECRET_FILE`; the Helm chart maps the three key fields
from `objectStore.credentialsSecret`. No credentials, evidence payloads or
PVC paths are added to the release manifest or browser responses.

## Migration procedure

The eventual migration is deliberately staged:

1. Classify the existing `artifacts` tree and compare it with the release
   allowlist. Keep the current Git history intact during this inventory pass.
2. Upload release objects and evidence objects to their separate prefixes.
3. Recompute and compare SHA-256, sizes, manifest references and package
   validator results. Test a complete package download and Workspace install.
4. Run Assets in dual-read validation mode: serve from the existing release PVC
   while checking the object-storage manifest and selected range reads.
5. Switch a deployment to the verified object-backed bundle, monitor health,
   download, preview and Workspace sync checks, then retain the previous PVC
   bundle for rollback.
6. Only after a release has survived its retention window should large duplicate
   working copies be removed from Git or local PVC storage in a separate,
   explicitly reviewed change.

This implementation phase does not upload or delete files. In particular,
`artifacts/public-survey-footprints/csst/input-manifest.json` remains evidence
and must not enter the Git-tracked public release allowlist. Normalized scans,
task snapshots and extraction errors follow the same evidence rule.

## Runtime compatibility

The initial cutover should preserve the existing HTTP paths and response
semantics:

- `/api/v1/assets` continues to return stable asset IDs and hashes.
- `/api/v1/resource-packages/catalog.json` remains the package catalog used by
  Workspace.
- `/api/v1/coverage/catalog` and coverage blocks remain immutable and cacheable.
- `ETag: "sha256-<digest>"` and `X-Content-SHA256` continue to identify bytes,
  regardless of whether the server read them from a PVC or object storage.

The object store is a publication backend, not a new scientific API. Assets
still owns public presentation and release activation; Warehouse still owns
current scan state and evidence production; Workspace still owns user data and
local package installation.
