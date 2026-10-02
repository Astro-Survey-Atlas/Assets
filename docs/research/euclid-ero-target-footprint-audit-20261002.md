# Euclid ERO Excluded Target Footprint Audit (2026-10-02)

## Result

Of the eight ERO targets excluded by the current name-association rule,
**Messier78 has an unambiguous identity alias** in the official ESA Sky
outreach table: `M78` and `M78_HighRes`, both labelled `Messier 78 nebula`,
share one identical ICRS polygon. The other seven have **no verified ERO
outreach footprint in the inspected table**. This is a bounded absence in
these sources, not a claim that no footprint exists anywhere at ESA.

All eight official ERO XML target pages returned HTTP 200 and explicitly
listed VIS/NISP Stack and Catalog package links. Package identity and access
entrypoints are therefore available independently of spatial association.
The XML documents do not supply a target footprint or a Tile inventory.
Only metadata was fetched; package bytes and pixel data were not downloaded,
and the existence or extent of each science file was not independently tested.

The verified Messier78 outreach polygon is at RA 86.337–87.044°, Dec
−0.352–0.355°. It cannot repair DESI + Euclid O4 C01, cell `[190]`, whose
recorded region is RA 0–9°, Dec 57.3995–63.4483°. This audit supplies no
verified missing-target polygon for C01. Do not mark C01 complete after an
alias-only update, or use Q1 C04's 875 records as its evidence.

## Official Queries and Capture

The [official ERO landing page](https://euclid.esac.esa.int/dr/ero/) was
captured at `2026-10-02T04:39:09.064951Z` (12:39:09 Asia/Shanghai), HTTP
200, 7,211 bytes, SHA-256
`9c157080f999c0598c4e425037475b2cc485ca76a9f1dddbd6edaa0d0b48844f`.
It lists 17 targets. Its headings distinguish `ERO-09: The Fornax galaxy
cluster seen with Euclid` from other programmes, and its data section
describes target-level image stacks and catalogues.

The [ESA Sky TAP endpoint](https://sky.esa.int/esasky-tap/tap/sync) was
queried with `REQUEST=doQuery`, `LANG=ADQL`, `FORMAT=json` and:

```sql
SELECT TOP 200 * FROM images.euclid_outreach
```

[Exact GET request](https://sky.esa.int/esasky-tap/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=json&QUERY=SELECT+TOP+200+%2A+FROM+images.euclid_outreach).
Response captured at `2026-10-02T04:37:56.700507Z`, HTTP 200, 56,377
bytes, SHA-256
`3b86dc515f4334c950f8cd104b6f72020e069c30e2de120254efa099a583e1a8`.
All 19 rows were inspected, including `id`, `object_name`, `title`,
`description` and `stc_s`. All 19 returned nonempty `POLYGON ICRS` strings.
The table includes Q1/Q2 outreach products as well as ERO images; table
membership alone does not establish ERO identity.

Independent counts establish that the 200-row limit did not truncate this
table. Count requests used the same TAP endpoint and parameters:

```sql
SELECT COUNT(*) AS row_count FROM images.euclid_outreach
SELECT COUNT(*) AS row_count FROM images.mv_euclid_outreach_fdw
SELECT COUNT(*) AS row_count FROM images.mv_euclid_outreach_ext_fdw
```

| Table | Count | Captured at (UTC, 2026-10-02) | HTTP |
| --- | ---: | --- | ---: |
| `images.euclid_outreach` | 19 | 04:39:09.491023 | 200 |
| `images.mv_euclid_outreach_fdw` | 19 | 04:39:09.495299 | 200 |
| `images.mv_euclid_outreach_ext_fdw` | 0 | 04:39:09.478491 | 200 |

The two 19-count responses each have SHA-256
`90dc0886e143e65495156940d5ecc8199a9b6b9f01765896535b0119834c988f`;
the zero-count response has
`914ea79710fb4745cb3d89bd59a96aeae1e16fc92f81fe7050e2dda903e93c15`.
Only the primary table's full rows were inspected in this audit; equal counts
alone do not prove that the FDW view's rows are identical.

## Eight Targets

Each linked official XML page below returned HTTP 200, its `dataitem/name`
agreed with the target ID, and its content listed all four packages: VIS
Stack, NISP Stack, VIS Catalog and NISP Catalog. All declare version `V3.0`.

| Official target metadata | Package entrypoints | Geometry association in the 19-row response | Classification |
| --- | --- | --- | --- |
| [ERO-Barnard30](https://euclid.esac.esa.int/dr/ero/ERO-Barnard30) | Four explicit links | No identified ERO row | Footprint unavailable in inspected outreach source |
| [ERO-Messier78](https://euclid.esac.esa.int/dr/ero/ERO-Messier78) | Four explicit links | `M78` and `M78_HighRes`; identical polygon and explicit Messier 78 label | Unambiguous alias association omitted by current rule |
| [ERO-Taurus](https://euclid.esac.esa.int/dr/ero/ERO-Taurus) | Four explicit links | No identified ERO row | Footprint unavailable in inspected outreach source |
| [ERO-NGC6254](https://euclid.esac.esa.int/dr/ero/ERO-NGC6254) | Four explicit links | No identified ERO row, including no `M10` row | Footprint unavailable in inspected outreach source |
| [ERO-HolmbergII](https://euclid.esac.esa.int/dr/ero/ERO-HolmbergII) | Four explicit links | No identified ERO row | Footprint unavailable in inspected outreach source |
| [ERO-IC10](https://euclid.esac.esa.int/dr/ero/ERO-IC10) | Four explicit links | No identified ERO row; `ic342` is explicitly IC342 | Footprint unavailable in inspected outreach source |
| [ERO-NGC2403](https://euclid.esac.esa.int/dr/ero/ERO-NGC2403) | Four explicit links | No identified ERO row | Footprint unavailable in inspected outreach source |
| [ERO-Fornax](https://euclid.esac.esa.int/dr/ero/ERO-Fornax) | Four explicit links | No ERO-Fornax row; `EDFF` explicitly describes Q1 Deep Field Fornax | Footprint unavailable; reject the Q1 namesake |

The complete `id` inventory is:

```text
Abell2764, Dorado, Dorado_HighRes, Abell2390_HighRes, horsehead,
NGC6744, NGC6744_HighRes, M78_HighRes, Q2-EGBS-PNG-RGB_HIPS,
EDFS, perseus, M78, ic342, Abell2764_HighRes, ngc6822,
EDFF, ngc6397, EDFN, Abell2390
```

Names, descriptions and polygons were considered together. There is no
identified row for the remaining seven, rather than merely no literal ID
match. No geometry was inferred from a target center, package filename,
object name, Q1 polygon or another release's MOC.

### Messier78: Source Identity Alias and Spatial Precision

The `M78` row has `object_name = 'Messier 78 nebula'` and title
`Messier 78 nebula (enhanced view)`; `M78_HighRes` has the same object name
and title `Messier 78 nebula (24x24k resolution)`. Both return exactly:

```text
POLYGON ICRS 87.0203732 -0.3520556 87.0441778 0.3308336 86.3612915 0.3546423 86.3374657 -0.3282535
```

The official ERO landing page names `Messier78`, and its XML identifies
`ERO-Messier78`. This is sufficient to recognize the identity alias. Strip
the known resolution suffix, handle the explicit Messier78/M78 alias, and
retain the check that all associated rows agree on a single sourced polygon.
Do not generalize this to arbitrary text substrings.

The polygon is an **outreach image footprint**, not independently verified
per-band Stack/Catalog coverage. A resulting target-to-science-package
spatial association must retain its estimated precision and source identity;
neither exact science-package geometry nor an ERO Tile ID follows from the
alias. The exact polygon string above should be preserved as source evidence.

### Fornax: A Q1 Namesake Is Not an ERO Footprint

The `EDFF` row has `object_name = 'Euclid Q1 EDFF'`, title
`Euclid Deep Field Fornax`, description beginning
`This is Euclid’s Deep Field Fornax`, a Q1 download-script link, and
`tiles_url = 'hips:https://cdn.skies.esac.esa.int/Q1-EDFF-R4-PNG-RGB_HIPS/'`.
Its polygon is:

```text
POLYGON ICRS 55.95354968600888 -25.300944300910853 49.92067099652547 -25.28917808916404 49.78422600129751 -30.765217192037593 56.310550575376354 -30.722672886753433
```

The ERO landing page instead lists `ERO-Fornax` under the Fornax galaxy
cluster programme. A shared constellation/name does not identify these
products as the same field. The response explicitly resolves the tempting
namesake to Q1; it provides no ERO-Fornax association. Retain the ERO package
entrypoints without borrowing EDFF geometry.

## Package URI Evidence

These links were read literally from the eight XML documents, not generated
from a naming pattern. Their publication in metadata proves package
entrypoint identity; this audit did not issue package GET/HEAD requests.

| Target | VIS Stack | NISP Stack | VIS Catalog | NISP Catalog |
| --- | --- | --- | --- | --- |
| Barnard30 | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-Barnard30.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-Barnard30.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-Barnard30.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-Barnard30.DR3.tar.gz) |
| Messier78 | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-Messier78.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-Messier78.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-Messier78.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-Messier78.DR3.tar.gz) |
| Taurus | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-Taurus.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-Taurus.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-Taurus.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-Taurus.DR3.tar.gz) |
| NGC6254 | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-NGC6254.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-NGC6254.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-NGC6254.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-NGC6254.DR3.tar.gz) |
| HolmbergII | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-HolmbergII.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-HolmbergII.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-HolmbergII.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-HolmbergII.DR3.tar.gz) |
| IC10 | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-IC10.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-IC10.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-IC10.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-IC10.DR3.tar.gz) |
| NGC2403 | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-NGC2403.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-NGC2403.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-NGC2403.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-NGC2403.DR3.tar.gz) |
| Fornax | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-Fornax.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Stack/Euclid-NISP-Stack-ERO-Fornax.DR3.tar) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-VIS-Catalog-ERO-Fornax.DR3.tar.gz) | [package](https://cdn.euclid.esac.esa.int/Catalog/Euclid-NISP-Catalog-ERO-Fornax.DR3.tar.gz) |

## XML Capture Identity

All captures are on 2026-10-02 UTC (Asia/Shanghai adds eight hours):

| XML target | Captured at (UTC) | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Barnard30 | 04:37:55.457488 | 2,283 | `c79023302e5cb5e0186a7de899ba0c8975d82b0bebe154abcb98d9becdedc270` |
| Messier78 | 04:37:55.422397 | 2,283 | `5d571793d85a694a215e252952031af20eb8d76f3d13432f28fd56a41d062900` |
| Taurus | 04:37:55.401340 | 2,256 | `324a4bbf9efd934e4cdc31c2ab82f2fcf486791bb23daa34b92ba7f6f0ea2af5` |
| NGC6254 | 04:37:55.443633 | 2,265 | `b5002bf88efbe6e4bcfe918b50089a88b7f02fc2cdf9457280b90329f8669bfb` |
| HolmbergII | 04:37:56.309904 | 2,292 | `3996d7bb2d5ad1ec933211755953f251b6ff3764f3ad1f0405eb76cc13c3b118` |
| IC10 | 04:37:56.295522 | 2,238 | `392d88038288082425c4308e38e05cda43e147466ebd05ae99cdd87740ccc6f5` |
| NGC2403 | 04:37:56.345889 | 2,265 | `eaf71d02aafecfe9aaaa942a6e8aab876d7e4a26db6f625db5d686945b51264c` |
| Fornax | 04:37:56.322240 | 2,256 | `49410177ed58a0dafe26a0e162c2391da9325c4e0b7da65ed12d44eeaa4ba4fe` |

Temporary raw metadata and request receipts are in
`/tmp/assets-ero-target-audit-20261002-2cp0wac9/` and
`/tmp/assets-ero-tap-audit-20261002-0nnwv3yu/`. These are audit staging
files, not managed/archived evidence. Their presence does not imply import,
review or activation, and `/tmp` may be cleaned.

## Managed Follow-up

The safe candidate change is one explicit Messier78/M78 identity association
while preserving conflicting-footprint rejection and seven separately named
geometry gaps. An unchanged live metadata fetch is insufficient on its own
to repair a parser association; the candidate must reflect the revised
association behavior and be validated with the sourced polygon. The XML
entrypoints for the seven missing-footprint targets should remain visible as
source evidence, without being counted as spatial native matches.

Acquisition/import, candidate construction, verification, individual gap
review, complete dependency archive and activation must use the
[managed native-unit workflow](../native-unit-management.md). Retain the old
installed version and assert the new active version only after runtime and
site HTTP validation. This audit performed none of those mutations and did
not change the public ERO MOC, native index or product bindings.

After an alias update, at most one of the original eight exclusions is
resolved by the inspected source. ERO native identity remains `target`, its
spatial package association remains estimated, and complete ERO inventory
must remain false. C01 needs separately verified geometry or an explicit
remaining spatial-mapping gap; pagination cannot create that geometry.
