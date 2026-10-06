# ZTF DR7 native reference-image inventory, checked 2026-10-06

**The cataloged CDS ZTF DR7 imaging products can now be mapped to real reference
images.** Their preserved `HpxFinder` progenitor metadata supplies original
filenames, image-frame polygons and a source-authored mapping to individual
IRSA FITS files. A research-only enumeration recovered **162,333 distinct
reference images** across g/r/i. This resolves the earlier missing-membership
blocker for the **CDS DR7 HiPS product scope**; it does not reconstruct all DR7
single exposures or guarantee that today's IRSA file bytes equal their 2021
versions.

Only this research note was added to the repository. All downloaded content was
documentation, schemas or progenitor metadata; scientific files were probed
with HEAD only. No management state, evidence PVC, deployment, public MOC,
public bundle, 72602 or Workspace was changed. Temporary research evidence is
under `/tmp/ztf-native-research-20261006/`; it has not been imported or activated.

## Why this applies to the existing products

The local catalog has `ztf / ztf-dr7` color, g, r and i imaging products, each
described as a public CDS HiPS/MOC extent. Their locked source identities are
`CDS/P/ZTF/DR7/{color,g,r,i}`. They are not a declared inventory of every DR7
science exposure. See the [catalog](../../src/surveys/survey-catalog.json) and
the [g-band recipe](../../src/layers/recipes/ztf-ztf-dr7-ztf-dr7-g-band-imaging-moc.lock.json).

The CDS publisher's [g](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FZTF%2FDR7%2Fg&get=record&fmt=json),
[r](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FZTF%2FDR7%2Fr&get=record&fmt=json)
and [i](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FZTF%2FDR7%2Fi&get=record&fmt=json)
records explicitly advertise `hips_progenitor_url` under each DR7 service.
Their production dates are in September 2021. The CDS
[Hipsgen reference manual](https://aladin.cds.unistra.fr/hips/HipsgenReferenceManual.html)
explains that `INDEX` stores the **original images intersecting each tile** in
ASCII JSON, one record per line, under `HpxFinder`; `DETAILS` adds image
characteristics and direct original-image links through `metadata.xml`.
These are source metadata, not resampled image pixels.

Browsing the `HpxFinder/` directory returns **403**, but its named metadata
files are public. The extensionless URLs below return JSONL successfully;
adding `.json`, `.xml` or `.tsv` to `Npix493` returned 404.

| Band | Metadata mapping | Representative progenitor page |
| --- | --- | --- |
| g | [metadata.xml](https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_g/HpxFinder/metadata.xml) | [O3 Npix493](https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_g/HpxFinder/Norder3/Dir0/Npix493) |
| r | [metadata.xml](https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_r/HpxFinder/metadata.xml) | [O3 Npix493](https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_r/HpxFinder/Norder3/Dir0/Npix493) |
| i | [metadata.xml](https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_i/HpxFinder/metadata.xml) | [O3 Npix493](https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_i/HpxFinder/Norder3/Dir0/Npix493) |

## All-sky enumeration and its completeness boundary

The declared capture enumerated every ICRS/equatorial **NESTED O3** key,
`ipix=0..767`, separately for g/r/i:

```text
https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_<band>/HpxFinder/
Norder3/Dir0/Npix<ipix>
```

There is no query cursor or server pagination: the finite page key space is
`12 × 4^3 = 768` per band. Every successful response was parsed as JSONL and
validated against that band's reference-image identity and four-corner
`POLYGON J2000` geometry. Every saved body was independently rechecked against
its receipt's size, SHA-256 and row count.

| Band | Keys attempted | HTTP 200 | HTTP 404 | Metadata rows | Distinct reference-image files | Repeated rows | Raw successful-page bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| g | 768 | 592 | 176 | 89,292 | 65,783 | 23,509 | 31,711,395 |
| r | 768 | 593 | 175 | 95,014 | 69,959 | 25,055 | 36,116,034 |
| i | 768 | 511 | 257 | 36,043 | 26,591 | 9,452 | 12,804,464 |
| Total | 2,304 | 1,696 | 608 | 220,349 | **162,333** | 58,016 | **80,631,893** |

There are **1,144 distinct field IDs** in the combined inventory; g/r/i contain
1,066/1,141/541 fields respectively. No unresolved request or parse error
remains. One initial connection drop on r `Npix399` recovered on retry; a
separate repeated GET returned the same SHA and all 93 rows. The initial
progress/manifest still carried that recovered error string; final validation
reread the per-page receipts, confirmed the recovery and marked the research
manifest complete.

The 608 HTTP 404 outcomes are recorded source-page absences within this explicit
enumeration. They must not be discarded as successful empty JSON responses or
used to invent missing quadrant files. A future acquisition must distinguish
them from timeouts, 403s, 5xx responses and invalid metadata.

All successful-page `Last-Modified` values are from the original generation:

| Band | Earliest page modification, UTC | Latest page modification, UTC |
| --- | --- | --- |
| g | 2021-09-15 07:28:12 | 2021-09-15 10:56:22 |
| r | 2021-09-20 21:25:20 | 2021-09-20 22:07:13 |
| i | 2021-09-17 18:31:21 | 2021-09-17 19:52:37 |

This is a complete enumeration of the **served CDS DR7 O3 progenitor metadata**.
It supports `queryPagesComplete=true` for that precise scope. It does not prove
the completeness of all ZTF DR7 archive products, the fidelity of every pixel,
or byte-level historical reproducibility; retain `inventoryComplete=false`
for those broader claims.

## Native identity and duplicate semantics

The native unit is a **reference-image CCD quadrant**, with a band-specific
whole-file identity:

```text
ztf_<field:6 digits>_<zg|zr|zi>_c<ccdid:2 digits>_q<qid>_refimg.fits
```

CCD IDs are 01–16 and quadrant IDs 1–4. The
[DR7 release notes, sections 3–4](https://irsa.ipac.caltech.edu/data/ZTF/docs/releases/dr07/ztf_release_notes_dr07.pdf)
identify a CCD quadrant as the basic image-processing unit; 64 quadrants make
one full-camera exposure. A reference image is a coadd for one
field/CCD/quadrant/filter. It is not a full-camera field, a HEALPix tile or an
individual exposure.

For example, g `Npix493` contains:

```json
{
  "name": "ztf_000535_zg_c11_q3_refimg",
  "path": "g/ztf_000535_zg_c11_q3_refimg.fits[0,0-1024x1024]",
  "ra": "255.57799744809276",
  "dec": "12.288439193951081",
  "cellmem": "4194304",
  "stc": "POLYGON J2000 255.12043101158037 12.730578164387953 256.03167534312337 12.73438420902644 256.0340269266452 11.845542841080556 255.1258565471099 11.841749668919874"
}
```

The `path` records Hipsgen's internal input and memory/subimage selection; some
r-band rows contain the publisher's absolute local filesystem path. Neither
the local path nor `[x,y-width×height]` is a public retrieval URI or an extra
native unit. `cellmem` is not sky coverage.

Across the entire capture, **every repeated basename has exactly one identical
STC polygon and image center**. One file appears in at most four O3 pages.
44,583 files have different internal generator paths across repeated rows
(g/r/i: 18,031/19,262/7,290), while their full image-frame polygons remain
identical. For example, g `ztf_000534_zg_c04_q1_refimg` appears in `Npix493`
and `Npix494` with different subimage selections and the same STC polygon.
Deduplicate by validated reference-image basename; retain all page/hash and
generator-path provenance. Reject conflicting footprints rather than silently
choosing one in future captures.

A finest-order metadata check also works: g
[O9 Npix2022751](https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_g/HpxFinder/Norder9/Dir2020000/Npix2022751)
contains the same field535/CCD11/q3 reference image already present in its O3
parent `floor(2022751 / 4^6) = 493`. O3 is the **progenitor index bucket**, not
the resolution of the image footprint or the public MOC.

## Source-supported whole-file URIs and access

All three `metadata.xml` files explicitly define:

```text
https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/${access}
```

Their `access` expression extracts the directory components from the original
`name`, giving the same rule as IRSA's
[metadata/path guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_metadata.html):

```text
https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/
<field[0:3]>/field<field:6>/<filtercode>/ccd<ccdid:2>/q<qid>/
ztf_<field:6>_<filtercode>_c<ccdid:2>_q<qid>_refimg.fits
```

All 162,333 names validated against this rule. No tar bundle, cutout `POS/SIZE`,
date inferred from a MOC or guessed observation ID is needed. Three actual
files named by the DR7 progenitor pages were tested anonymously:

| Original image | Whole-file link | HEAD status | Content-Length | Body bytes obtained |
| --- | --- | ---: | ---: | ---: |
| `ztf_000535_zg_c11_q3_refimg.fits` | [IRSA g FITS](https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/000/field000535/zg/ccd11/q3/ztf_000535_zg_c11_q3_refimg.fits) | 200 | 40,970,880 | 0 |
| `ztf_000535_zr_c11_q3_refimg.fits` | [IRSA r FITS](https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/000/field000535/zr/ccd11/q3/ztf_000535_zr_c11_q3_refimg.fits) | 200 | 40,970,880 | 0 |
| `ztf_000535_zi_c11_q3_refimg.fits` | [IRSA i FITS](https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/000/field000535/zi/ccd11/q3/ztf_000535_zi_c11_q3_refimg.fits) | 200 | 40,970,880 | 0 |

These source-listed links are individual whole FITS reference images. The HEAD
responses used `application/octet-stream`. They prove the three files were
reachable at the probe time; they do not verify every generated URI or its
2021 contents. Keep unprobed links source-listed/unverified and timestamp any
sampled availability evidence.

IRSA's [API guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_api.html)
says public products can be accessed without credentials; proprietary products
require an IRSA account/password. Preserve source-policy status when a file
cannot be retrieved anonymously. Assets should export the source manifest;
users retrieve scientific files themselves.

The source records advertise both the French CDS master `alasky` and mirror
`alaskybis`. The mirror's g `Npix493` is byte-identical to the master, and its
r/i `metadata.xml` files have matching hashes. These are verified **metadata
and HiPS mirrors**; they are not established mirrors of the original quadrant
FITS files. The original-file source here is IRSA in the US. Do not label CDS's
resampled HiPS FITS tiles as copies of original quadrant files. No original
ZTF imaging mirror on AWS, zjlab or CASDC was established in this check.

## Precision, color binding and remaining historical limits

The metadata mapping declares `eq_FK5`, equinox J2000, and each image frame is
`POLYGON J2000`. Convert that original frame to ICRS before indexing it; retain
the original STC string and source hashes. The output remains **estimated**:
four corners are image-frame bounds, not a valid-pixel, depth or detector-mask
footprint. IRSA's API guide itself describes its four-corner matching as an
approximation. Use conservative NESTED candidate buckets plus the actual
converted polygon, not just image centers or a field-grid formula. Do not
promote O3 index pages to invented O8 coverage. The locked public product MOC
order remains unchanged.

The CDS [color record](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FZTF%2FDR7%2Fcolor&get=record&fmt=json)
explicitly identifies i/r/g as its red/green/blue inputs; the color output is
PNG. A color-product reverse lookup can therefore expose its **underlying
band-specific original reference images**, retaining band identity and an
explicit color-input association. There is no source-supported original
`color_refimg.fits`; do not construct one or claim one indivisible RGB science
file.

The [official release list](https://irsa.ipac.caltech.edu/data/ZTF/docs/ztf_data_releases.txt)
dates DR7 to **2021-09-08**, says releases are cumulative/superseding and says
only the last five releases are available through IRSA's current UI/API.
The [mission home](https://irsa.ipac.caltech.edu/Missions/ztf.html) currently
advertises DR24 dated 2026-01-22; the returned release-list text itself still
ends at DR23. Neither page makes current image tables into frozen DR7 tables.
The local catalog's `releasedYear: 2025` conflicts with DR7's actual release
date; any correction belongs in the product review/publication workflow, not
an unreviewed native-index mutation.

A fresh [TAP table enumeration](https://irsa.ipac.caltech.edu/TAP/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT%20table_name%2Cdescription%20FROM%20TAP_SCHEMA.tables%20WHERE%20table_name%20LIKE%20%27%25ztf%25%27)
returned current `ztf_current_meta_*`/`ztf_current_path_*` image tables and
Objects DR20–DR24, with no advertised DR7 image table. Current reference
metadata for field535/CCD11/q3 and its `meta_id` path join both worked and
provided `rfid`, publication date, real path, size and SHA-512/256 checksum.
Those can supplement current retrieval identity; they are not the membership
authority for this CDS DR7 capture.

DR7's [release notes, sections 2 and 4](https://irsa.ipac.caltech.edu/data/ZTF/docs/releases/dr07/ztf_release_notes_dr07.pdf)
describe program 1 g/r exposures over MJD 58194–59396 and programs 2/3 g/r/i
over MJD 58194–58908. Reference images are continually updated and can include
good exposures outside those epoch ranges. The notes' reference counts are
65,331/68,293/23,944 (157,568 total), whereas the later September CDS progenitor
snapshot has 65,783/69,959/26,591. Record that scope/count difference openly.
These sources justify the declared **CDS DR7 product provenance**; they do not
justify relabeling the recovered roster as a frozen complete IRSA DR7 release.
Original `rfid` values and original-byte checksums were not preserved in the
HpxFinder rows. Today's filename-compatible IRSA targets may have been
reprocessed, so historical byte identity stays unverified.

## Recommended managed acquisition

The native mapping is ready to implement for the existing CDS DR7 imaging
scope, with the limits above retained as reviewable gaps:

1. Capture the three CDS source records, `HpxFinder/properties`,
   `HpxFinder/metadata.xml` and all 2,304 explicit O3 keys. Store original
   metadata bytes and receipts with URL, capture time, HTTP status, size and
   SHA. Keep 404 outcomes and abort incomplete pages rather than silently
   dropping errors. Lock an explicit CDS DR7 progenitor snapshot identity;
   use neither the current IRSA table nor the pointing grid as its membership.
2. Validate field/CCD/quadrant/filter filenames, finite J2000 polygons and
   duplicate consistency; construct the whole-file URI from the locked
   publisher mapping and preserve every source reference. Distinguish the
   220,349 evidence rows from the 162,333 native image identities.
3. Stage only metadata under `deliveryClass: evidence`, then use authenticated
   import, candidate build, review, dependency archive and activation. Preserve
   every existing active input/binding. Bind g/r/i by their own file bands and
   color only by its declared underlying inputs.
4. Required gaps include estimated frame geometry, CDS-product-only inventory,
   incomplete historical processing identity, mutable original-file targets,
   and unprobed per-file availability. State `queryPagesComplete=true` only for
   the acquired finite O3 key space and retain `inventoryComplete=false` for
   ZTF DR7 generally.
5. Test a real region around RA 255.578°, Dec +12.29°; the point is in NESTED
   O4 cell 1975 and source O3 page 493. Verify all three field535/CCD11/q3
   band files, original footprints, pagination/deduplication and JSON/CSV URI
   consistency. Keep the public bundle/MOC unchanged and deploy only to Dev.

The procedure must follow [coverage workflow](../coverage-workflow.md) and
[native-unit management](../native-unit-management.md). The research capture
does not itself establish an installed, reviewed, archived or active version.

## Reproducible evidence and hashes

The final temporary research manifest is
`/tmp/ztf-native-research-20261006/allsky-o3/research-manifest.json`, SHA-256:

```text
99fd82cdc61b2965ef19970482291063a0951b5d64b4db6294586ff2e1bfeb66
```

It records every key, response status, original bytes, page hash, row count and
HTTP headers. `research-summary.json` records the full enumeration and
deduplication checks; `{g,r,i}-units-summary.json` preserve the distinct image
identities, STC polygons, generator-path variants and contributing O3 pages.
These are temporary research artifacts, not managed snapshot manifests.

| Metadata artifact | SHA-256 |
| --- | --- |
| g `metadata.xml` | `bb16e601d7c526db91bc936f5c06de71b9bb2baaffb1b2ee2d69be6fcf34be35` |
| r `metadata.xml` | `b5e1f1a443373d6edd2f7cf0ac2454a6d2493c909fabb2af26cb97a9cbb05942` |
| i `metadata.xml` | `ab04f4d99e631fb9bb87c4871161871df90758c7c65f6cb4f983f119f8fddff2` |
| g O3 `Npix493` | `f45b4a3333c7a996b2fad763aefc75d39d6deb713e7723c77286e82ef947a9a8` |
| r O3 `Npix493` | `8d318156a61ca456d1c97eb14c7dfc45643de1c27188cd2c18d04785eff30799` |
| i O3 `Npix493` | `2be0d7e61d25b8a62dee301abefe1b1290c2c8a2d21bf9a400ecfc3e0a781c43` |
| DR7 release notes PDF | `f407df021db664bdf5ddaca9f6f4c6d9368ef4eea7f85ff0a9ba4867def17d26` |

The fresh CDS g source-record SHA remains
`e21fe30144a70e57d743e38711ed1f742cb4beaff513f4580334e548a2aa984c`,
matching the locked recipe. Enumeration, SHA/size/row validation, filename and
polygon validation, duplicate-consistency analysis, mirror comparison and
three anonymous science-file HEADs passed. **Zero scientific pixel bytes were
obtained.** No application build/test/deployment was required for this note.
