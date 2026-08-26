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
