# Resource Package v3 integration

Astro Survey Atlas Resource Package v3 is the reusable output boundary. A
consumer does not need the Assets website, Kubernetes administrator, Warehouse,
or Elasticsearch to install and query the published MOCs.

See the [frontend guide](frontend-resource-package-guide.md) and the collapsible
FAQ on `/releases/` for rendering and Workspace loading.

## Trust and download

Read the public package catalog, choose a package, download its immutable
versioned archive, and verify its SHA-256 before extracting anything:

```bash
BASE=https://assets.example

curl --fail --silent --show-error \
  "$BASE/api/v1/resource-packages/catalog.json" \
  --output catalog.json

# packages[].archiveUrl is the pinned version route:
#   /api/v1/resource-packages/{id}/versions/{version}/download
curl --fail --silent --show-error \
  "$BASE/api/v1/resource-packages/<id>/versions/<version>/download" \
  --output package.zip

printf '%s  %s\n' "<packages[].sha256>" package.zip \
  | sha256sum --check -
```

The catalog's `packages[].sha256` is the trust anchor. HTTP `ETag` and object
storage multipart ETags are not substitutes for the content hash.

A release may expose a **resource package collection** ZIP through release
history when it declares `collection`. Incremental publication does not require
creating one. Check that field before using the optional download:

```bash
curl --fail --silent --show-error "$BASE/api/v1/releases" --output releases.json
# releases[].collection.downloadUrl -> /api/v1/releases/{releaseId}/download
# releases[].collection.sizeBytes / .sha256 -> verify after download
```

Ready-to-run clients with retry, atomic rename and hash verification are
published as release artifacts and linked from the `/releases/` page:

- Python 3 (stdlib only): `docs/examples/python/asa_package_sync.py`
- Java 17: `docs/examples/java/` (Maven, Jackson)

Assets rebuilds packages from the acquired/frozen layer registry. For the
current DESI and Euclid refresh, the reproducible local command is:

```bash
npm run packages:rebuild
```

It reads the registry and locked recipe snapshots, keeps the v3 archive
structure unchanged, rewrites the package catalog hashes, refreshes release
provenance, and rebuilds `release-manifest.json`. Source manifests and
normalized scans are evidence inputs and are deliberately not ZIP members.

## Workspace synchronization and installation

Workspace must be configured with the public Assets catalog URL, for example
`ASTRO_RESOURCE_CATALOG_URL=https://<assets-host>/api/v1/resource-packages/catalog.json`,
and (when an allow-list is used) the matching public origin in
`ASTRO_RESOURCE_CATALOG_ALLOWED_ORIGINS`. It never reads the Assets S3 bucket,
the release PVC or the Git `artifacts/` directory directly. The supported flow
is:

1. Fetch and parse the v3 catalog. Workspace writes the verified catalog and
   survey metadata to `assets-snapshots/<catalog-sha256>/` and atomically points
   `assets-current` at that snapshot. If Assets is temporarily unavailable,
   the last verified snapshot remains usable.
2. Select a catalog `packages[].id`, fetch its `archiveUrl` as a complete ZIP,
   check `Content-Length` against `sizeBytes`, and compare the complete body
   SHA-256 with `packages[].sha256` before extraction.
3. Extract to a private staging directory, validate
   `resource-package.json`, every declared file and every FITS MOC, then
   atomically install at `ASTRO_RESOURCE_PACKAGE_ROOT/installed/<package-id>/<version>`.
   The package state file records the installed hash and active release IDs;
   transient downloads are removed after the install.
4. Activate the desired release IDs and call `mocLayers(packageId)`. The
   result is the manifest's real `layerId`, `surveyId`, `releaseId`, MOC path,
   byte length and SHA-256. Read the file only through that manifest-declared
   path (or the Workspace HTTP adapter); do not search by ZIP filename or infer
   a layer from a survey label.

Workspace's local paths are also part of the contract. Catalog snapshots are
stored under `assets-snapshots/<catalog-sha256>/` with `assets-current` pointing
to the last verified snapshot; package downloads use a private staging
directory under the configured package root; verified archives are installed at
`<package-root>/installed/<package-id>/<version>`. Temporary ZIPs and failed
staging directories are removed after the job, while the installed directory
and its state file retain the package hash and active release IDs. No step
searches the Assets repository or an S3 prefix by filename.

The corresponding HTTP operations are `POST /api/resource-packages/:id/install`,
poll `GET /api/resource-packages/jobs/:jobId`, then
`POST /api/resource-packages/:id/activate` and
`GET /api/resource-packages/:id/mocs`. This makes a newly published JWST or
Euclid MOC discoverable through the same catalog/install path as the static
packages.

## End-to-end publication chain

The ownership boundary is explicit:

```text
MOC discovery/build (evidence)
  -> product review and explicit publication
  -> Assets MOC publication with ICRS/NESTED/hash checks
  -> Resource Package v3 archive and catalog entry
  -> Workspace catalog download + SHA-256 verification + install
  -> mocLayers(packageId) returns the actual layer identity
```

Input manifests, normalized scans, task snapshots and scanner errors remain in
`/var/lib/assets-evidence` (or its evidence object prefix). They are not copied
into a public package, the browser's initial request or the Workspace public
resource catalog.

## Validate before installation

Install the pinned MOC Core wheel published by `/api/v1/assets`, then validate
the archive against the downloaded public catalog:

```bash
python3 -m pip install astro_survey_moc_core-1.1.0-py3-none-any.whl
python3 -m astro_survey_moc_core.cli package validate package.zip \
  --public-catalog catalog.json
```

Validation rejects path traversal, symlinks, encrypted or duplicate entries,
unbounded archive sizes, undeclared files, incorrect hashes, invalid layer
identities, non-ICRS coordinates and malformed FITS MOCs. Only after this gate
should a consumer atomically activate the extracted directory.

## Consumer contract

`resource-package.json` lists each stable layer identity and its
`mocs/<layer-id>.moc.fits` file, SHA-256, modality, release, coverage role, data
origin and source tier. Supporting files are:

- `footprints/survey-footprints.json`: order-4 website preview only;
- `provenance.json`: source snapshots, methods, precision and attribution;
- `README.md`: survey-specific interpretation and limitations.

Use an IVOA MOC library such as MOCpy or CDS ST-MOC tooling for intersection
and point-in-MOC queries. Do not promote the preview pixels to a finer order.
When a layer is catalog `object_presence`, it describes catalog row positions,
not an imaging footprint or depth map.

Online clients may instead use `/api/v1/coverage/catalog` and immutable
`/api/v1/coverage/blocks/<layer-id>` responses. Reverse lookup remains an
optional Assets/Warehouse online capability and is not required to consume the
offline package.

## Incremental publication and Release continuity

A dynamic MOC publication is an incremental update to a survey package. The
builder retains every baseline layer not replaced by the same stable layer ID,
including its original FITS bytes, provenance and preview precision. It verifies
the baseline archive and retained member hashes before allocating an immutable
successor version. The candidate publication rejects a missing historical Release
and rejects differences between catalog Release IDs and actual ZIP layer Release
IDs. Removing a Release is not an implicit side effect of updating another one:
it requires a separate explicit withdrawal workflow with a recorded reason; the
current incremental publisher rejects such removals.

The public catalog exposes activated release versions. Product publication may
prepare a new package, but the package becomes an upgrade only after the complete
public release (catalog, history and collection) is activated. Historical
immutable downloads remain available.

Run the HTTP consumer audit after publication:

```bash
python3 scripts/check-public-package-release.py https://<assets-host>
```

It checks every current package, its ZIP members, Release continuity, the latest
history entry, versioned downloads and the whole-release collection hashes.

For a repair that republishes already published bytes without publishing pending
editorial drafts, `scripts/repair-public-package-release.mjs` uses the standard
publisher, archive verification and authority pointer activation. Run it from
`/app` in the configured Assets environment with `ASSETS_REPAIR_SURVEY_ID` set.
The default is a read-only plan. Before setting `ASSETS_REPAIR_EXECUTE=1`, verify
there are no queued/running publications and pause the ordinary publisher worker;
resume the worker afterwards. The repair filters packages/publications to the
named survey, preserves all other baseline packages, and never reviews drafts.
Activate the resulting authority bundle on the Assets server and run the HTTP
audit. Workspace needs only its normal catalog sync and package update.

## Sparse descriptive metadata

Reviewed v3 catalogs may have `sources: []` and omit `wavelengths`, `productTypes`
and `coverageAuthorities`. Consumers normalize those three missing descriptive
lists to `[]`; present values must still be arrays of nonempty strings. An empty
source list does not waive archive/manifest/hash/MOC provenance validation or
justify invented source information. Package identity, version, hash, size,
Release membership and scientific validation remain required.

Workspace reports `stale` and `lastSyncError` separately from local catalog
availability. A usable cached catalog is not evidence of a successful remote
sync. Successful sync atomically advances the current snapshot; failure retains
that snapshot without selecting an older catalog or downgrading packages.

Reviewed previews may declare `ordering: NESTED` and per-footprint `nside` rather
than a document-level nside. Workspace matches every preview's layerId/surveyId/
releaseId to a verified native MOC layer, requires a consistent NSIDE, and retains
the supplied pixels without refinement. Missing display labels are derived from
product names; missing source URLs stay absent. Original ZIP members are not
rewritten. Native MOC paths and hashes remain the scientific interface.
