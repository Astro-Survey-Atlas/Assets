# Legacy North Source Supplement

Checked 2026-10-01 against first-party Legacy Surveys DR10/DR9 pages, live NERSC paths, and public NOIRLab Astro Data Lab TAP metadata. No science files were downloaded. The public evidence does **not** identify a DR10 North Coadd or Tractor release product. A DR10-branded North point-source catalog is exposed by NOIRLab, but it is a separate object-level catalog and cannot supply brick membership or native brick file links.

## Release identity

The first-party [DR10 release description](https://www.legacysurvey.org/dr10/description/#contents-of-dr10) says DR10 adds DECam observations to the southern Legacy Surveys footprint and directs users to [DR9](https://www.legacysurvey.org/dr9/) for northern BASS/MzLS observations. It describes a continuous `ls-dr10` viewer image as a merge of northern MzLS+BASS and southern DECam, then explicitly names `ls-dr9-north` for North-only cutouts. That composite viewer layer is a cutout service identity, not proof of a DR10 North brick product or file inventory.

The [DR10 files page](https://www.legacysurvey.org/dr10/files/) lists the release-specific summary as `south/survey-bricks-dr10-south.fits.gz` and documents Coadd, Tractor, and sweep trees under `south/`. The current [NERSC DR10 root](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/) exposes `south/` as its release-region subtree. On the check date these direct paths returned HTTP 404:

- `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/`
- `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/coadd/`
- `https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/tractor/`
- Representative `dr10/north/coadd/150/1500p292/legacysurvey-1500p292-image-g.fits.fz` and `dr10/north/tractor/150/tractor-1500p292.fits` paths.

These sources provide no official DR10 North Coadd/Tractor identity. The all-sky `survey-bricks.fits.gz` remains geometric context, not release membership. See the [Legacy Surveys native URI audit](native-block-access-uris.md) for the locked roster schema and scope.

## NOIRLab TAP tables

The first-party [NOIRLab TAP service](https://datalab.noirlab.edu/tap/sync) exposes table descriptions and columns via `TAP_SCHEMA`. Repeated live ADQL queries returned HTTP 200 on 2026-10-01:

```sql
SELECT table_name, description
FROM TAP_SCHEMA.tables
WHERE schema_name IN ('ls_dr10', 'ls_dr9')
ORDER BY schema_name, table_name
```

```sql
SELECT column_name, description
FROM TAP_SCHEMA.columns
WHERE table_name = 'ls_dr10.psc_n'
ORDER BY column_name
```

| Table | Current first-party metadata | Supported use and limits |
|---|---|---|
| `ls_dr10.tractor` | 3,145,841,852 rows; “combined DR10 southern region and DR9 northern region.” Columns include `brickid`, `brickname`, `brick_primary`, `ra`, `dec`, and `release`. The TAP description for `release` says it identifies camera/filter processing runs, not public data release or sky region. | A returned catalog row can identify its brick. It does not turn a North row into DR10 provenance. A current sample query by `brickid=492440` returned `brickname=1500p292` with `brick_primary=1`; the same `brickid`/name is present in `ls_dr9.bricks_n`. Treat it as a merged catalog row that belongs to the DR9 North brick identity, not a DR10 North file record. Object rows are not a complete brick-file inventory. |
| `ls_dr10.tractor_s` | 2,825,807,500 rows; explicitly DR10 southern Tractor catalog. | DR10 South catalog rows only. |
| `ls_dr10.bricks` | 662,174 rows; all-sky geometric brick table. | Brick geometry/name resolution only; no North release membership. |
| `ls_dr10.bricks_s` | 366,912 rows; DR10 southern-region brick table. | South membership/geometry; it does not supply a North roster. |
| `ls_dr10.psc_n` | 339,015,213 rows; explicitly named “LS DR10 North Point Source Catalog.” Its columns include `ls_id`, `ra`, `dec`, `nest4096` (Nside 4096, NESTED/order 12), `ring256` (Nside 256, RING/order 8), `htm9`, `score`, and `white_mag`; no `brickid` or `brickname`. | A separately named, TAP-queryable North point-source product. It supports source-object searches by position/index and can return catalog IDs. The current schema cannot map an object to a native brick or return Coadd/Tractor file URIs. Its table description does not state which North image-release files underlie it, so keep the product identity to the table name and do not infer DR10 North imaging provenance. |
| `ls_dr9.bricks_n` | 93,548 rows; geometrical brick table for the northern region. | Explicit DR9 North brick metadata. It is consistent with the existing locked official DR9 North roster. |
| `ls_dr9.tractor_n` | 364,277,779 rows; northern-region Tractor catalog with `brickid`, `brickname`, `brick_primary`, `ra`, and `dec`. | Explicit DR9 North object-to-brick records. This is a distinct DR9 product identity, not DR10 North. |

The `ls_dr10` schema has no `bricks_n` table or North sweep table. `ls_dr10.psc_n` is therefore the only explicitly named DR10 North table found, and it is an object catalog only. `ls_dr10.tractor` can provide object records for a selected North brick, but using its rows to derive all bricks would be a partial object-presence index, not a complete release roster. It is unnecessary for native block membership where the official DR9 North roster already exists.

## Supported North brick ingestion

For a native brick index, use the release-specific DR9 North source:

- Official DR9 North roster: [`survey-bricks-dr9-north.fits.gz`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/survey-bricks-dr9-north.fits.gz), current HEAD HTTP 200. Assets already has 93,548 rows locked at SHA-256 `2edd5c295fdad26852c6f224a3ff023cff43dd0e03a53acd35b767e726ee72fb` in [source-unit-indexes.lock.json](../../src/layers/recipes/source-unit-indexes.lock.json).
- The official [DR9 files page](https://www.legacysurvey.org/dr9/files/) defines `<region>` as `north` for BASS/MzLS or `south` for DECaLS, documents the North NERSC tree, and gives the Tractor rule `north/tractor/<AAA>/tractor-<brick>.fits` and Coadd rule under `north/coadd/<AAA>/<brick>/`.
- Representative native file checks for DR9 North brick `1500p292` returned HTTP 200 for [`tractor-1500p292.fits`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/tractor/150/tractor-1500p292.fits) and g/r Coadd images, and HTTP 404 for its z-band Coadd. This matches the locked roster's positive g/r and zero z exposure evidence; it does not verify any other brick's individual files. Keep other paths as candidates unless checked.

The actionable Assets path is to retain the current DR10 South index and use the already locked DR9 North roster for North `brick` results, preserving `releaseId=legacy-dr9` and `north/` URI prefixes. No new DR10 North brick snapshot is supported by the inspected public evidence.

If the product requirement instead needs point sources, query `ls_dr10.psc_n` through the TAP `sync` endpoint using an explicit sky region or its documented spatial-index columns; preserve `ls_id`, coordinates, HEALPix scheme/order, and the source table. Present it as a separate NOIRLab `LS DR10 North Point Source Catalog` result with TAP access. Do not turn its rows into bricks, claim an image release not specified by the table metadata, or synthesize a Coadd/Tractor URI.

## Primary references

- [Legacy Surveys DR10 release description](https://www.legacysurvey.org/dr10/description/) and [DR10 files](https://www.legacysurvey.org/dr10/files/).
- [Legacy Surveys DR9 files](https://www.legacysurvey.org/dr9/files/) and [public DR9 North NERSC directory](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/).
- [NOIRLab TAP schema](https://datalab.noirlab.edu/tap/tables) and [TAP query service](https://datalab.noirlab.edu/tap/sync), queried for the table descriptions/columns above on 2026-10-01.
- Existing DR9/DR10 roster and representative per-file evidence: [native-block-access-uris.md](native-block-access-uris.md) and [source-unit-indexes.lock.json](../../src/layers/recipes/source-unit-indexes.lock.json).
