# Legacy Surveys DR10 North Product Audit

Checked 2026-10-01 against first-party Legacy Surveys release pages, the live NERSC listings, and public NOIRLab Astro Data Lab TAP metadata. No science files were downloaded. A North point-source catalog exists in Data Lab, but no inspected source provides a DR10 North native-brick inventory.

## Release provenance

The first-party [DR10 release description](https://www.legacysurvey.org/dr10/description/#contents-of-dr10) says DR10 incorporates additional DECam data into the southern Legacy Surveys footprint (defined there as Dec <= 32.375 degrees), and explicitly directs users to DR9 for northern BASS/MzLS observations. The [DR10 files page](https://www.legacysurvey.org/dr10/files/) agrees: its release-specific brick summary, Coadd tree, Tractor tree, and sweeps are all named under `south/`. This is the release provenance to preserve: the northern BASS/MzLS product is DR9 North, even when it appears in a broader DR10-branded catalog service.

## NOIRLab table audit

The public [NOIRLab TAP query service](https://datalab.noirlab.edu/tap/sync) exposes `TAP_SCHEMA.tables` and `TAP_SCHEMA.columns`. The following ADQL queries were used to inspect the complete listed `ls_dr10` and `ls_dr9` table sets and the relevant brick fields:

```sql
SELECT table_name, description
FROM TAP_SCHEMA.tables
WHERE schema_name IN ('ls_dr10', 'ls_dr9')
ORDER BY schema_name, table_name
```

```sql
SELECT table_name, column_name, description
FROM TAP_SCHEMA.columns
WHERE table_name LIKE 'ls_dr10.%'
  AND column_name LIKE '%brick%'
ORDER BY table_name, column_name
```

| Table/product | Documented scope and native fields | What it can support |
|---|---|---|
| `ls_dr10.tractor` | 3,145,841,852 rows; NOIRLab describes it as the combined DR10 southern and DR9 northern main Tractor catalog. TAP metadata includes `release`, `brickid`, `brickname`, `brick_primary`, `ra`, and `dec`. | A catalog row can be associated with its native brick. A North row belongs to the DR9 North provenance; this merged table does not establish a DR10 North brick or file. Object rows alone are not a complete inventory of bricks with files. |
| `ls_dr10.tractor_s` | 2,825,807,500 rows; explicitly the DR10 southern main Tractor catalog, with the same brick fields. | DR10 South object-to-brick lookup only. |
| `ls_dr10.bricks` | 662,174 rows; described as the all-sky geometrical brick grid. | Geometry and brick-name resolution only. It does not encode DR10 North membership or product-file availability. |
| `ls_dr10.bricks_s` | 366,912 rows; described as DR10 South geometrical bricks. | South region geometry/summary, consistent with the South roster; it supplies no North list. |
| `ls_dr10.psc_n` | 339,015,213 rows; described as “LS DR10 North Point Source Catalog.” Its columns are source coordinates/ID, magnitude and point-source score, HTM and HEALPix indices; there is no `brickname` or `brickid`. The table description does not specify an underlying North image-release provenance. | It is a real North point-source catalog identity queryable as `ls_dr10.psc_n`, but it cannot directly return native brick membership, coadd/Tractor file identities, or per-file URIs. It may support object-level catalog search if labeled as that product. |
| `ls_dr9.bricks_n` and `ls_dr9.tractor_n` | NOIRLab describes these as DR9 North: 93,548 geometrical brick rows and 364,277,779 North Tractor rows. `tractor_n` exposes `brickid`, `brickname`, `brick_primary`, `ra`, and `dec`; `bricks_n` exposes the brick geometry/summary. | Supports a distinct DR9 North identity. It must remain labeled DR9 North, and table/object presence is not individual file-existence proof. |

The `ls_dr10` schema has no `bricks_n` or sweep table. A North-area `brickname` obtained from `ls_dr10.tractor` can be used as a DR9 North catalog identity for that row, but must not be promoted to a DR10 North product. The separate `psc_n` table is North-specific at object level; its current schema does not bridge those objects to native bricks.

## Sweeps, geometry, and color MOC

- **Sweeps:** The official [DR10 files page's sweep section](https://www.legacysurvey.org/dr10/files/#sweep-catalogs-south-sweep) places them under `south/sweep/`, with standard files named `10.[0-1]/sweep-<brickmin>-<brickmax>.fits`. The min/max tokens describe RA/Dec rectangles, not a single brick. The page defines their rows as `BRICK_PRIMARY==T` Tractor sources within each rectangle and documents row identifiers including `RELEASE`, `BRICKID`, and `OBJID`. These rows can identify South catalog bricks; the shard URI is rectangular and has no DR10 North scope.
- **All-sky bricks:** The official DR10 `survey-bricks.fits.gz` and `ls_dr10.bricks` give the geometric grid, not release-member flags. Intersecting northern sky positions with that grid would create a geometric candidate only; it cannot establish North membership. No such inference is used here.
- **DR10 color imaging:** Assets' existing overview identity is the CDS MOC `CDS/P/DESI-Legacy-Surveys/DR10/color`, requested at order 4 from the [CDS MOC server](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDESI-Legacy-Surveys%2FDR10%2Fcolor&get=smoc&order=4&fmt=json). It is a coarse sky-coverage product, not an official Legacy brick table or file manifest. It can provide overview cells only; it does not establish a native DR10 North brick or a Coadd/Tractor URI. The first-party DR10 description's instruction to use DR9 for northern BASS/MzLS remains controlling for those North products.

## Supported product identities and access

| Identity | Supported access form | Evidence limit |
|---|---|---|
| DR10 South Coadded imaging, native unit `brick` | `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/coadd/<AAA>/<brick>/legacysurvey-<brick>-image-<filter>.fits.fz` | Official DR10 South path rule. A generated path is a candidate unless that individual file is checked. |
| DR10 South Tractor catalog, native unit `brick` | `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/tractor/<AAA>/tractor-<brick>.fits` | Official DR10 South path rule; no North counterpart is documented in DR10. |
| DR10 South sweep catalog, product unit is an RA/Dec rectangle | `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/sweep/10.1/sweep-<brickmin>-<brickmax>.fits` (the older `10.0/` tree is also documented) | Official access tree and filename pattern. Row-level brick fields do not change the file's rectangular shard identity or its South-only scope. |
| DR10 North point-source catalog | NOIRLab table `ls_dr10.psc_n` via `https://datalab.noirlab.edu/tap/sync` | Table-query identity only. No native brick or per-file URI is documented in its TAP columns. |
| DR9 North Tractor / Coadd, native unit `brick` | `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/tractor/<AAA>/tractor-<brick>.fits`; Coadd image pattern `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/coadd/<AAA>/<brick>/legacysurvey-<brick>-image-<filter>.fits.fz` | Official DR9 North identity and path rules. Assets' DR9 North roster has 93,548 entries; one representative North Tractor and g/r Coadd path was checked, while other candidates remain unverified. |

For the Assets MVP, keep DR10 brick reverse lookup bounded to its locked DR10 South roster. North-region Legacy results that need native brick identities should select the separate DR9 North release/product and preserve its `north/` URI prefix. Do not combine `DR10 color imaging`, `ls_dr10.tractor` North rows, or the all-sky grid into a synthetic “DR10 North brick” identity.

## Repository and primary references

- [DR10 release description](https://www.legacysurvey.org/dr10/description/#contents-of-dr10): DR10's new DECam southern scope and direction to DR9 for northern BASS/MzLS.
- [DR10 file layouts](https://www.legacysurvey.org/dr10/files/), [DR10 Tractor format](https://www.legacysurvey.org/dr10/catalogs/), and [DR9 file layouts](https://www.legacysurvey.org/dr9/files/).
- [NOIRLab TAP tables metadata](https://datalab.noirlab.edu/tap/tables) and [TAP query endpoint](https://datalab.noirlab.edu/tap/sync), queried for `ls_dr10` and `ls_dr9` on 2026-10-01.
- Existing release roster and sample-path evidence: [native-block-access-uris.md](native-block-access-uris.md) and [source-unit-indexes.lock.json](../../src/layers/recipes/source-unit-indexes.lock.json).
- Existing DR10 color MOC identity: [survey-catalog.json](../../src/surveys/survey-catalog.json) and [survey-footprints.json](../../src/footprints/survey-footprints.json).
