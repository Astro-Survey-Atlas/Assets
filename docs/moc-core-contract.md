# Assets MOC Core contract

Assets owns the scientific coverage contract and the offline implementation.
Atlas and scanner images consume a wheel pinned by version and SHA-256; they do
not call an Assets computation service at runtime.

## Scientific representation

- The authoritative artifact is an IVOA FITS MOC in ICRS using NESTED/NUNIQ.
- The default maximum order is 10. A recipe may lower it. Raising it requires a
  written `precisionJustification` and scientific review.
- Order 8 is the Atlas query projection. Order 4 is the website preview. Both
  are derived from the authoritative FITS MOC.
- `coverageRole` is one of `image_extent`, `object_presence`, or
  `footprint_extent`.
- `dataOrigin` is one of `observed`, `simulated`, or `catalog`.
- `sourceTier` is one of `official_geometry`, `official_inventory_derived`,
  `third_party_moc`, `best_effort_derived`, or `user_file_derived`.
- `coverageRole` is the only accepted field. `evidenceRole` was removed in Core
  1.0.0 and is rejected at the input boundary.

The reviewed CSST layer remains order 8 and retains its existing FITS bytes,
pixels, measured area, and SHA-256. Its classification is `image_extent`,
`simulated`, and `user_file_derived`.

The Assets layer registry may reserve a stable ID with `status:
awaiting_snapshot` before the official input is available. Such a record must
include its planned input mode, source URLs and reason, and must not contain an
artifact hash. Only `acquired` records with a recipe, snapshot and output hash
may enter `public-build-plan.json` or the public release manifest.

## CLI lifecycle

`refresh` is the only command that can access the network. It stores a local
snapshot and a lock containing SHA-256 and size. `build --rebuild` rejects an
unlocked spec and performs no network operations; `rebuild` is the explicit
offline spelling of the same operation. `merge` sorts shard paths,
normalizes the union, and writes the same canonical FITS representation as a
single build. `project` derives a fixed-order NESTED index from FITS MOC.
`rebuild-public` consumes only `src/layers/public-build-plan.json`, requires its
fixed `SOURCE_DATE_EPOCH`, and rejects any output whose authoritative MOC hash
differs from the lock.

```bash
astro-survey-moc-core refresh --spec recipe.json --snapshot-dir snapshots --lock recipe.lock.json
SOURCE_DATE_EPOCH=1787184000 astro-survey-moc-core build --spec recipe.lock.json --base-dir snapshots --output build --rebuild
SOURCE_DATE_EPOCH=1787184000 astro-survey-moc-core rebuild --spec recipe.lock.json --base-dir snapshots --output build
astro-survey-moc-core merge --input shard-001.fits --input shard-000.fits --output merged.fits
astro-survey-moc-core project --moc merged.fits --order 8 --output query-order8.json
```

Supported input modes are `fits-wcs`, `catalog-radec`, `nested-healpix`,
`regions`, and `tile-table`. Connector credentials and byte-range reads stay in
the scanner. Core accepts local files or already parsed normalized inputs.

## Resource Package v3

New package builds produce only `3.0.0` with this closed structure:

```text
resource-package.json
mocs/<layer-id>.moc.fits
footprints/survey-footprints.json
provenance.json
README.md
```

The validator rejects traversal paths, backslashes, NULs, symbolic links,
duplicates, directory entries, undeclared or extra files, oversized entries,
invalid FITS MOCs, and size/SHA-256 mismatches. Public installation additionally
requires the complete archive hash to be present in the Assets package catalog.
Validation without that public trust gate is suitable only for user assets.
The normative manifest shape is published as
[`contracts/resource-package-v3.schema.json`](../contracts/resource-package-v3.schema.json).
