# Euclid Q1 Deep Fields: Native Tile Mapping

**Checked:** 2026-09-30

## Conclusion

Euclid's native spatial unit is the ESA `tile_index`. A product's `stc_s` or
ObsCore `s_region` is its footprint, not its identity. A deep-field region can
be mapped to Q1 product URIs by intersecting the official deep-field polygons
with each product footprint, then retaining the archive row's actual
`tile_index`, filename, product/filter and `access_url`.

The exact deep-field geometry is published by the Euclid Consortium as
`q1_region_files.zip`; its 5,272-byte response was retrieved and matched the
Assets recipe lock SHA-256. A first local candidate pass now intersects those
official polygons with the locked Q1 BGSUB product geometries using inclusive
order-8 NESTED HEALPix cells. It returns estimated candidates, not an exact
polygon-overlay result.

## Authoritative boundaries

- ESA's [Q1 Data Access page](https://www.cosmos.esa.int/web/euclid/q1-data)
  directs users to the Euclid Science Archive for Q1 access.
- The ESA [Q1 announcement](https://www.esa.int/Science_Exploration/Space_Science/Euclid/Euclid_opens_data_treasure_trove_offers_glimpse_of_deep_fields)
  names the North, Fornax and South deep fields and states that the three
  fields cover 63.1 square degrees together. It also links their ESA Sky views
  as `EDFN`, `EDFF` and `EDFS`, respectively. The announcement gives context
  and names, but not precise boundary coordinates.
- The Euclid Consortium's [Q1 region archive](https://www.euclid-ec.org/wp-content/uploads/q1_region_files.zip)
  is the precise geometry source recorded by this repository. The locked
  recipe [`euclid-q1-deep-fields-image-extent.lock.json`](../../src/layers/recipes/euclid-q1-deep-fields-image-extent.lock.json)
  identifies three root-level ICRS DS9 polygon files: `q1_edfn.reg` (North),
  `q1_edff.reg` (Fornax) and `q1_edfs.reg` (South). Its recorded snapshot is
  5,272 bytes with SHA-256
  `1cf306fab4995179219fbefd32b9648ce0455b65c48cab9246138cc72eff20ef`.
- Direct HTTPS retrieval returned the expected 5,272 bytes on 2026-09-30;
  SHA-256 `1cf306fab4995179219fbefd32b9648ce0455b65c48cab9246138cc72eff20ef`
  matches the recipe lock.

Do not replace these polygons with a circle inferred from a field center or
the reported 63.1 square degree total. That would not preserve the published
boundaries.

## Q1 Tile and product metadata

ESA's [EAS TAP service](https://eas.esac.esa.int/tap-server/tap/) was reachable
on the check date. Its live `TAP_SCHEMA` lists these authoritative fields:

- `q1.mosaic_product`: `tile_index`, `file_name`, `filter_name`, `stc_s`,
  `data_set_release` and product metadata.
- `ivoa.obscore`: `tile_index`, `file_name`, `s_region`, `access_url`,
  `dataproduct_type`, `data_set_release` and `target_name`.

The Q1 `q1.mosaic_product` row's `tile_index` is the native Tile ID. Its
`stc_s` describes that specific product's footprint. The corresponding
ObsCore row carries the public access URI and its `s_region`. For example,
this ADQL join was tested live for Tile `102042918` and returned matching
product names, both footprint fields and ESA SAS-DD URLs:

```sql
SELECT m.tile_index, m.file_name, m.filter_name,
       m.stc_s, o.s_region, o.access_url
FROM q1.mosaic_product AS m
JOIN ivoa.obscore AS o
  ON o.file_name = m.file_name
 AND o.tile_index = m.tile_index
WHERE m.data_set_release = 'Q1_R1'
  AND o.data_set_release = 'Q1_R1'
  AND m.tile_index = 102042918
```

The `tile_index` predicate is only for this sample. To build the declared
BGSUB mosaic inventory, remove it and add
`m.file_name LIKE 'EUC_MER_BGSUB-MOSAIC-%'`; the locked inventory scope is
2,908 product rows, 352 Tile IDs and 13 filename product groups. This is only
that BGSUB query scope, not the complete Q1 inventory or every Q1 modality.
Each returned product remains its own URI row: multiple filters/products on
one Tile must not be collapsed to a guessed single file.

The local mapping procedure is:

1. Restore the three official DS9 polygons and verify the snapshot SHA-256.
   Keep their field labels and ICRS coordinate frame.
2. Fetch the supported Q1 product rows from TAP and join ObsCore by actual
   `file_name`, `tile_index` and release. Parse the returned `stc_s` or
   `s_region` polygon using its declared frame and normalize it to ICRS.
3. Intersect each official field polygon with each product footprint. Emit
   `(field, tile_index, product/filter, file_name, access_url)` for actual
   non-empty intersections. For a user's HEALPix query, intersect the whole
   HEALPix cell against the same per-product footprints, then group results by
   `tile_index` while retaining every matching product URI.
4. Keep scan evidence separate: attach a Warehouse “seen” status only to a
   matching survey/release/product/Tile identity. TAP-derived or
   rule-derived locations are not scan-confirmed files.

An initial candidate pass used the locked 2,908-row BGSUB snapshot and the
existing source-unit matcher at order 8. It found 72 candidate Tiles in
Fornax, 124 in North and 148 in South, for 344 distinct Tile IDs and 2,876
candidate product URIs across the five runtime product groups. Each result is
`estimated`: HEALPix raster overlap is conservative around field and product
boundaries. These figures describe only the locked BGSUB inventory and are
not a complete Q1 Tile or product inventory. The aggregate deep-fields layer
now uses the same locked BGSUB snapshot for runtime lookups and groups its
matching product URIs by `tile_index`; normal per-product Q1 lookups continue
to use their own product identities.

The existing Q1 BGSUB query snapshot and these API rows do not provide a
reliable deep-field tag. In the live TAP result, all 2,908 BGSUB mosaic ObsCore
rows have an empty `target_name`, and the `q1.mosaic_product` schema has no
field-name column. The association must therefore come from the published
region geometry and spatial intersection, not a filename or blank target
field.

## Filename false positives

A live Q1_R1 check found zero `file_name LIKE '%DEEP%'` matches. The combined
`LIKE '%DEEP%' OR LIKE '%EDF%'` query found three rows, all ordinary
`EUC_MER_BGSUB-MOSAIC-*` products whose six-character filename checksum
contains `EDF`:

- Tile `102159188`, NIR-Y, checksum `BEDF51`.
- Tile `102044184`, DES-I, checksum `D3EDFC`.
- Tile `102020056`, VIS, checksum `EDF5E2`.

These are checksum coincidences, not deep-field labels. Never filter Q1 files
to a deep field using `EDF` or `DEEP` substrings.

## Search and remaining work

Primary sources checked on 2026-09-30 were the ESA Q1 Data Access page, the
ESA Q1 deep-field announcement, the Euclid Consortium region ZIP, EAS
TAP_SCHEMA, and live Q1 `q1.mosaic_product`/`ivoa.obscore` queries. The ESA
announcement is not a substitute for polygon geometry; EAS product rows
provide Tile and file footprints but no deep-field label. The runtime binding
exposes candidates at the precision supported by the inclusive order-8
HEALPix matcher. Do not treat the 2,908 BGSUB rows as all Q1 products or label
the estimated matches as exact spherical polygon intersections.

The source research did not change any MOC, public release, public pointer or
existing data. The separate runtime implementation is described above.
