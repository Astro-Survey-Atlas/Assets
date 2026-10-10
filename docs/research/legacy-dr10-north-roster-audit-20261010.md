# Legacy DR10 North brick-roster audit

Checked **2026-10-10**, 03:10:44–03:14:16 UTC (11:10:44–11:14:16 Asia/Shanghai),
against first-party Legacy Surveys documentation, the NERSC release tree, and
NOIRLab Astro Data Lab TAP metadata. No authoritative **DR10 North imaging brick
roster** was found in these published sources. The current documentation still
directs northern BASS/MzLS observations to **DR9**. This confirms, within the
routes checked below, the release-identity conclusion of the
[2026-10-01 North audit](legacy-north-source-supplement-20261001.md).

Only documentation, directory listings, checksum text and bounded TAP metadata
responses were retrieved. Existing FITS rosters were checked with HEAD; their
bodies and scientific images/catalogs were not downloaded. No source definition,
lock file, application code, native index, product binding, MOC or release was
changed or imported, and no deployment, activation or WCS work was performed.

## Release identity and published routes

The [DR10 description][D1] says DR10 incorporates new DECam imaging into the
southern footprint and explicitly states: “To obtain northern observations from
BASS and MzLS, see DR9 of the Legacy Surveys.” It explains that the `ls-dr10`
viewer combines northern MzLS/BASS with southern DECam images, but names
`ls-dr9-north` for North-only cutouts. A composite viewer name is therefore not
evidence of a separately published DR10 North brick release. The description
returned GET 200; its response Last-Modified was `2026-09-02T22:54:50Z`.

The [DR10 files page][D2] documents
`south/survey-bricks-dr10-south.fits.gz`, `south/tractor/*` and `south/coadd/*`.
Its published file descriptions contain no DR10 North brick-roster or North
Coadd/Tractor tree. The [NERSC DR10 directory][N1] lists `south/`, the shared
`survey-bricks.fits.gz`, DECam CCD metadata, `calib/`, `masking/` and `randoms/`;
it does not list `north/`. The [South directory][N2] lists the South roster,
Coadd and Tractor directories. Both directory listings returned GET 200.

The files page also describes `survey-bricks-dr10-randoms-2.6.0.fits` as the
geometric brick grid with extra random-catalog interpretation columns, including
`PHOTSYS=N/S`. That column distinguishes the resolved photometric footprint; it
does not establish new northern image-release provenance or a DR10 North
Coadd/Tractor inventory. Its documented northern observations remain subject to
the DR9 identity in the release description. This audit did not download the
randoms table or use it to manufacture release membership. [Sources: D1, D2.]

The following North routes were explicitly checked. The roster names are
**hypotheses based on earlier release naming**, not links published by the
current DR10 files page. A HEAD request reads no file body.

| Exact URL | Method | HTTP | Completed UTC, 2026-10-10 |
| --- | --- | --- | --- |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/ | GET | 404 | 03:12:18 |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/coadd/ | GET | 404 | 03:12:19 |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/tractor/ | GET | 404 | 03:12:19 |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/survey-bricks-dr10-north.fits.gz | HEAD | 404 | 03:12:17 |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/survey-bricks-dr10-north.fits.gz | HEAD | 404 | 03:12:17 |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/north/survey-bricks-dr10.fits.gz | HEAD | 404 | 03:12:17 |

These are actual HTTP 404 responses, not inferred failures from timeouts.
The three GET error bodies were each 236 bytes with SHA-256
`9448f8a1159c9b14e3e1b9d8eab1a6ddf88d26e1f888a34cef430c756e4e6e1e`.
They establish the status of these paths at the check time; they are not a claim
that every possible unpublished source has been searched.

## NOIRLab metadata and reproducible counts

[TAP table metadata][Q1] returned 41 table-description rows for `ls_dr10` and
`ls_dr9` (17 and 24 respectively). There is no `ls_dr10.bricks_n` in that
published schema. [Column metadata][Q2] returned 415 column-description rows
for five selected tables. Three bounded COUNT queries returned the following
current table row counts; no brick records or object catalog rows were exported.

| First-party table | Evidence on this check | Meaning for a North brick roster |
| --- | --- | --- |
| `ls_dr10.bricks` | [COUNT query][Q3]: 662,174 rows; 11 geometry/identity columns in Q2 | All-sky geometric grid, not release membership. |
| `ls_dr10.bricks_s` | [COUNT query][Q4]: 366,912 rows; Q1 labels it “DR10 southern region” | Authoritative DR10 South table; no North membership. |
| `ls_dr9.bricks_n` | [COUNT query][Q5]: 93,548 rows; Q1 labels it “Northern region” | Explicit DR9 North metadata, consistent with the already locked DR9 North roster. |
| `ls_dr10.tractor` | Q1 describes “combined DR10 southern region and DR9 northern region” and declares 3,145,841,852 rows | A merged object catalog preserves the DR9 northern provenance; the table name does not change that provenance. Object-presence aggregation is not a complete native file roster. |
| `ls_dr10.psc_n` | Q1 calls it “LS DR10 North Point Source Catalog” and declares 339,015,213 rows; Q2 contains 13 columns, with no `brickid` or `brickname` | A named point-source product, not a North imaging brick roster or native Coadd/Tractor file inventory. |

The billion-scale Tractor and PSC counts above are **descriptions declared by
TAP_SCHEMA**, not newly executed COUNT queries. PSC columns are `dec`, `elat`,
`elon`, `glat`, `glon`, `htm9`, `ls_id`, `nest4096`, `ra`, `random_id`, `ring256`,
`score` and `white_mag`. Position or HEALPix cells cannot turn this object table
into authoritative native brick-file membership. [Sources: Q1, Q2.]

All TAP calls used GET to `https://datalab.noirlab.edu/tap/sync` with
`REQUEST=doQuery`, `LANG=ADQL`, `FORMAT=csv` and these exact queries. Fully encoded
request URLs are linked as Q1–Q5 below.

```sql
-- Q1
SELECT table_name, description
FROM TAP_SCHEMA.tables
WHERE schema_name IN ('ls_dr10', 'ls_dr9')
ORDER BY schema_name, table_name

-- Q2
SELECT table_name, column_name, description
FROM TAP_SCHEMA.columns
WHERE table_name IN ('ls_dr10.bricks', 'ls_dr10.bricks_s', 'ls_dr10.psc_n', 'ls_dr10.tractor', 'ls_dr9.bricks_n')
ORDER BY table_name, column_name

-- Q3, Q4, Q5 respectively
SELECT COUNT(*) AS n FROM ls_dr10.bricks
SELECT COUNT(*) AS n FROM ls_dr10.bricks_s
SELECT COUNT(*) AS n FROM ls_dr9.bricks_n
```

## Existing authoritative rosters

The official [DR9 files page][D4] still defines `north` as BASS/MzLS and
documents its region-specific roster and native file layout. The [DR9 North
directory][N3] lists `survey-bricks-dr9-north.fits.gz`, `coadd/` and `tractor/`.
HEAD checks at 03:12:17–03:12:18 UTC returned:

| Official roster URL | HTTP | Content-Length | Last-Modified |
| --- | --- | --- | --- |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/survey-bricks-dr10-south.fits.gz | 200 | 104,480,980 bytes | 2023-12-15T19:26:48Z |
| https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/survey-bricks-dr9-north.fits.gz | 200 | 20,882,100 bytes | 2020-12-11T02:59:42Z |

The source-published [South checksum text][C2] names the roster SHA-256 as
`863e5ded7a4aae7abcb5df76f322f35cf89945483715ff6d1874c88f5a072d9a`;
the [DR9 North checksum text][C3] names its roster SHA-256 as
`2edd5c295fdad26852c6f224a3ff023cff43dd0e03a53acd35b767e726ee72fb`.
Both match the values in
[source-unit-indexes.lock.json](../../src/layers/recipes/source-unit-indexes.lock.json),
as do the reported byte lengths. The lock records 366,912 DR10 South members
and 93,548 DR9 North members, consistent with Q4/Q5. These are comparisons to
official published checksums and HEAD metadata; this audit did not independently
hash the current remote FITS bodies. The [DR10 root checksum text][C1] lists only
three DECam CCD metadata files and supplies no North roster entry.

## Captured response receipts

Hashes below cover the complete captured **metadata response body**, not a FITS
image, brick roster body or derived spatial inventory. HTML has no table row
count; checksum text counts nonempty lines; TAP counts data rows excluding the
CSV header. All successful requests finished on 2026-10-10.

| Response | Method / HTTP | Finished UTC | Bytes | Response rows | SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| [DR10 description][D1] | GET / 200 | 03:12:20 | 68,162 | — | `00bf9d4b474db608a6b9e584f3f3b87725d67e5543510fcae41df77e8a0a2e24` |
| [DR10 files][D2] | GET / 200 | 03:12:22 | 183,230 | — | `6f9892b9bf6b0d5a37772e90014e738aae1e057b860c4f904b8ea42fde018178` |
| [DR10 catalog data model][D3] | GET / 200 | 03:12:17 | 77,933 | — | `df3605a4e8ec464d822ec80993edf376a4eb4741e96adc121fdb1b70703fb7c1` |
| [DR9 files][D4] | GET / 200 | 03:12:20 | 187,585 | — | `d0b51d66529cb4c62db7e8ae1df22d6976879f46dcd62b4e6993729b42674c85` |
| [NERSC DR10 root][N1] | GET / 200 | 03:12:17 | 903 | — | `980791fa508326cd6d3789aede9da8b5071e1424d851e0d45b33ab990d331f1c` |
| [NERSC DR10 South][N2] | GET / 200 | 03:12:18 | 1,022 | — | `521b6ce3aefcff589f97a774e8f5121f3a9efbff7bbad245787dfc9f95a70c39` |
| [NERSC DR9 North][N3] | GET / 200 | 03:12:20 | 1,165 | — | `8a2964b66eda29054dffb8574e66c171eb1b0c6c10013bc114f62a61071617c3` |
| [DR10 root checksum text][C1] | GET / 200 | 03:14:15 | 294 | 3 | `cca78443f50472336d2233ea10696906a31880a247e1548a1c2a4eb944fa3a3f` |
| [DR10 South checksum text][C2] | GET / 200 | 03:14:16 | 289 | 3 | `ee1655aba343e3f4f646c6e3b2c8a17ff77c0f2722743ba6f5df3895231baadd` |
| [DR9 North checksum text][C3] | GET / 200 | 03:14:14 | 286 | 3 | `3638b39c5393f804888467c4c34ff21e2e894d0629c56275f2697dd2ee67febf` |
| [TAP tables Q1][Q1] | GET / 200 | 03:11:20 | 4,675 | 41 | `a07434e0edf299e5589f7d834d77ec49fcf930441add09c62ae0348593253c14` |
| [TAP columns Q2][Q2] | GET / 200 | 03:11:20 | 38,104 | 415 | `b2d6494f74c8c59863dc2c8269785259dfa89cf07648b98876a7df5c532e7d1a` |
| [TAP grid COUNT Q3][Q3] | GET / 200 | 03:13:05 | 9 | 1 | `68aad2daacf96ac2b394efc5b7e05ae9b6bf5ee8d8119a0538ecca7bf01b93f7` |
| [TAP South COUNT Q4][Q4] | GET / 200 | 03:13:05 | 9 | 1 | `fb61403956a739e12538ae2f80b5e898cd6e614920618344f48d97f2f3b871b3` |
| [TAP DR9 North COUNT Q5][Q5] | GET / 200 | 03:13:05 | 8 | 1 | `142fb8dbe13f685214374ef6cb6c6daec34a2b947bcd0a5ec707d48c12f72c5c` |

TAP requests used the restored `http://127.0.0.1:7890` proxy. Initial Python
urllib requests to Legacy/NERSC through that proxy failed with TLS
`UNEXPECTED_EOF_WHILE_READING` at 03:10:49–03:10:54 UTC; no HTTP status was
received, so those attempts are not source-availability evidence. The table's
Legacy/NERSC receipts use direct connections with the proxy environment bypassed.
A curl GET of D1 through the proxy then succeeded at 03:14:15 UTC: HTTP 200,
TLS verification result 0, 68,162 bytes and the same SHA-256 as the direct D1
receipt. All successful checks used normal certificate-chain and hostname
validation; none disabled TLS verification. Complete temporary bodies and JSON
receipts were kept outside Git in `/tmp/asa-legacy-dr10-north-audit-20261010/`.

## Action for Assets

Retain **DR10 South** and **DR9 North** as distinct release identities. The
evidence checked here provides no new DR10 North roster suitable for managed
import. Do not relabel DR9 North, derive DR10 North membership from the all-sky
grid, convert PSC source positions into an imaging roster, or synthesize North
Coadd/Tractor links. Existing per-file availability and estimated-geometry limits
remain unchanged. [Sources: D1, D2, Q1, Q2; existing scope in the lock and the
[coverage workflow](../coverage-workflow.md).]

If a genuine North imaging release roster is subsequently published, first
record its official release identity, native brick IDs, band membership,
source-listed file layout and immutable input SHA/size/count. Acquire only the
metadata and use the supported management workflow to register/import a
snapshot, build an isolated candidate, verify membership and queries, review
the explicit precision/inventory gaps, archive all dependencies, then activate
and verify the runtime/site HTTP results. The installed indexes remain intact
until that process succeeds. See
[native-unit-management.md](../native-unit-management.md).

[D1]: https://www.legacysurvey.org/dr10/description/
[D2]: https://www.legacysurvey.org/dr10/files/
[D3]: https://www.legacysurvey.org/dr10/catalogs/
[D4]: https://www.legacysurvey.org/dr9/files/
[N1]: https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/
[N2]: https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/
[N3]: https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/
[C1]: https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/legacysurvey_dr10.sha256sum
[C2]: https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/legacysurvey_dr10_south.sha256sum
[C3]: https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr9/north/legacysurvey_dr9_north.sha256sum
[Q1]: https://datalab.noirlab.edu/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+table_name%2C+description+FROM+TAP_SCHEMA.tables+WHERE+schema_name+IN+%28%27ls_dr10%27%2C+%27ls_dr9%27%29+ORDER+BY+schema_name%2C+table_name
[Q2]: https://datalab.noirlab.edu/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+table_name%2C+column_name%2C+description+FROM+TAP_SCHEMA.columns+WHERE+table_name+IN+%28%27ls_dr10.bricks%27%2C+%27ls_dr10.bricks_s%27%2C+%27ls_dr10.psc_n%27%2C+%27ls_dr10.tractor%27%2C+%27ls_dr9.bricks_n%27%29+ORDER+BY+table_name%2C+column_name
[Q3]: https://datalab.noirlab.edu/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+COUNT%28%2A%29+AS+n+FROM+ls_dr10.bricks
[Q4]: https://datalab.noirlab.edu/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+COUNT%28%2A%29+AS+n+FROM+ls_dr10.bricks_s
[Q5]: https://datalab.noirlab.edu/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+COUNT%28%2A%29+AS+n+FROM+ls_dr9.bricks_n
