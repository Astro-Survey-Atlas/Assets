# Assets MOC Core contract

`MOC-Core-SDK` owns the organization-level scientific contract and offline
implementation. Assets maintains the public release workflow and publishes the
verified wheel; Workspace installs the same wheel for local/user MOCs; Warehouse
keeps its Java implementation compatible through the shared conformance
fixtures. None of the projects depends on an Assets computation service at
runtime.

Source repository: [Astro-Survey-Atlas/MOC-Core-SDK](https://github.com/Astro-Survey-Atlas/MOC-Core-SDK).
Consumers record the wheel SHA-256 and its source identity in release or vendor
provenance. For a committed source release, that identity is the exact Core
commit. For a wheel built from a dirty worktree, record its base commit, the
source snapshot archive and SHA-256, and the build environment; the base commit
does not identify the exact source contents. Assets distributes its pinned
wheel and source snapshot together.

## Scientific representation

- The authoritative artifact is an IVOA FITS MOC in ICRS using NESTED/NUNIQ.
- The default maximum order is 10. A recipe may lower it. Raising it requires a
  written `precisionJustification` and scientific review.
- A recipe's maximum order is a computation cap. Canonical cell merging can
  produce a lower native maximum: a requested O10 result may contain only O9
  cells. Report the decoded native `maxOrder` and `availableOrders`; do not
  reject that result solely for being lower or upsample it to match the cap.
  The Assets MAST regions wrapper currently requires native order at least 8
  for its fixed O8 query projection, as well as the public minimum of 4.
- Order 8 is the public query projection used by Assets and package consumers.
  Order 4 is the website preview. Both are derived from the authoritative FITS
  MOC.
- `coverageRole` is one of `image_extent`, `object_presence`, or
  `footprint_extent`.
- `dataOrigin` is one of `observed`, `simulated`, or `catalog`.
- `sourceTier` is one of `official_geometry`, `official_inventory_derived`,
  `third_party_moc`, `best_effort_derived`, or `user_file_derived`.
- `coverageRole` is the only accepted field. `evidenceRole` was removed in Core
  1.0.0 and is rejected at the input boundary. Core 1.1.0 additionally accepts
  any Resource Package `3.x.y` version. Core 1.2.0 adds validation and
  generation of fixed-order order-4 and order-8 HEALPix sidecars.

Shared conformance tests use synthetic geometry. Real private survey MOCs and
preview cells (including CSST) are not Git fixtures; their protected runtime
storage is independent of the public package contract.

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
`regions`, and `tile-table`. Remote connector authentication and byte-range
reads are outside Core and are owned by the task's source/connector
implementation. Core accepts local files or already parsed normalized inputs.

## Resource Package v3

New package builds produce Resource Package `3.x.y` versions (bumping the
minor for content changes) with this closed structure:

```text
resource-package.json
mocs/<layer-id>.moc.fits
footprints/survey-footprints.json
provenance.json
healpix/order4.json
healpix/order8.json
README.md
```

The fixed-order sidecars are projected from the native FITS MOCs, not from the
display footprint or a finer requested order. Each lists sorted NESTED cell
numbers per layer and the survey union, plus precision and completeness. A
layer whose native maximum order is below a sidecar's order is listed under
`surveyUnion.omittedLayers`; the union is then not described as complete.
Historical packages may omit these sidecars; newly built and reviewed packages
must contain both.

The legacy offline historical-repair utility retains the old minimal package
contract and discards inherited sidecars that describe only one input version.
Its output is not a reviewed publication; the normal publication gate still
requires newly generated sidecars. This utility is not invoked at server startup.

The validator rejects traversal paths, backslashes, NULs, symbolic links,
duplicates, directory entries, undeclared or extra files, oversized entries,
invalid FITS MOCs, and size/SHA-256 mismatches. Public installation additionally
requires the complete archive hash to be present in the Assets package catalog.
Validation without that public trust gate is suitable only for user assets.
The normative manifest shape is published as
[`contracts/resource-package-v3.schema.json`](../contracts/resource-package-v3.schema.json).
