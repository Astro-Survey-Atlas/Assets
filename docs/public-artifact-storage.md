# Public artifact storage and migration

This document records the intended distribution boundary for the complete
public survey footprint collection. It is a design and migration contract; the
current working tree is not migrated by this document.

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
