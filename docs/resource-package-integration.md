# Resource Package v3 integration

Astro Survey Atlas Resource Package v3 is the reusable output boundary. A
consumer does not need the Assets website, Kubernetes administrator, Warehouse,
or Elasticsearch to install and query the published MOCs.

## Trust and download

Read the public package catalog, choose a package, download its immutable
archive, and compare its SHA-256 with the catalog before extracting anything:

```bash
curl --fail --silent --show-error \
  https://assets.example/api/v1/resource-packages/catalog.json \
  --output catalog.json

curl --fail --silent --show-error \
  https://assets.example/api/v1/assets/<package-asset-id>/download \
  --output package.zip

sha256sum package.zip
```

The catalog's `packages[].sha256` is the trust anchor. HTTP `ETag` and object
storage multipart ETags are not substitutes for the content hash.

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
python3 -m pip install astro_survey_moc_core-1.0.0-py3-none-any.whl
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
