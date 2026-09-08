# Public artifact storage and release archives

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

`public/current.json` has this v1 shape:

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

Build and validate the local release data first. The 15 Resource Package v3
archives can live outside the repository:

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
archive and restarts the deployment. It does not delete release objects or
the PVC's previous release directories.

The server reads only `/data/current`; it never reads S3 at request time and
never uses the Git checkout as a runtime data source.
