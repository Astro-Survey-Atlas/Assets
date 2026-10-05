# Phase 2 next-survey recheck, 2026-10-05

**Capture-stage baseline (before revision 340):** VVV DR4 and SkyMapper DR4 were
in the active Dev index, generation 5. The bounded 2MASS 6X M31 increment was
built and reviewed; archive task `native-muucskfc-696a7d9e` later completed and
generation 6 was activated. At this capture checkpoint DES DR2 capture3 had
10,169 Tiles / 50,845 normal five-band rows and SPHEREx capture2 had five
FITS-header rows for observation `2025W17_4B_0001_1`; both were staged but not
yet imported.

**Current status (2026-10-05, after revision 341):** Assets Dev runs image
`0.1.0-20261005-094718-phase2-spherex-fix`; active native group
`2cc52ebcd4d39b963e6cd6bdf9d7a28433f618423f681db2708b2327b60c1962` is
generation 7 with 86 bindings and 184/184 checks passing. DES DR2, SPHEREx QR2,
and the bounded 2MASS LMC increment were built into one reviewed and archived
candidate; archive task `native-muuqmul2-a3781aaa` validated 903/903 dependencies
and activation task `native-muut99w2-130d388e` passed site HTTP verification.
The review deliberately leaves the SPHEREx D1 product unbound because capture2
contains only detectors 2–6. The three 2MASS product bindings reference both
M31 and LMC snapshots. Post-activation status reports public bundle
`reviewed-mupsxe2v-c91be91f`, 603 files, 105 MOCs; no public bundle or MOC was
changed. The latest native-units control snapshot generation 1531 is synced.
See [HANDOFF](../../HANDOFF.md) for runtime query and HEAD acceptance details.

The initial research-only recheck below ran at approximately 01:30–01:43
Asia/Shanghai on 2026-10-05. Its endpoint probes are a dated record, not the
current import/deployment status. Science-file checks used HEAD; no science
contents were downloaded.

## Published Dev scope and next-import ranking

The Dev [coverage catalog](http://10.15.51.75:32083/api/v1/coverage/catalog)
returned HTTP 200 and 132 layers. These four releases currently account for
20 published layers, all `sourceUnitIndex.status=entrypoint-only` when checked.
Use their actual published product IDs when building bindings; do not silently
replace the named release or promote an input query to a full inventory.

| Rank among these four | Existing published products | What can be acquired now | Remaining restriction |
| --- | --- | --- | --- |
| 1 — 2MASS `2mass-6x` | J/H/K infrared imaging, 3 layers | Two bounded one-degree queries are active: M31 (138 band-images / 46 coadds) and LMC (165 / 55); O4 LMC reverse lookup returns 165 file identities | No global 6X inventory denominator. Keep `inventoryComplete=false`, both query scopes, original FK5 frame and estimated frame geometry; representative whole-image links do not verify every file |
| 2 — DES `des-dr2` | Color and g/r/i/z/Y imaging, 6 layers | Active: 10,169 Tiles / 50,845 normal coadd rows; positive and negative sample Tile access URLs return HTTP 200 `image/fits` without `POS/SIZE` | Completeness is scoped to the official TAP roster; geometry is estimated, per-file access and directory/mirror membership remain unverified |
| 3 — SPHEREx `spherex-qr2` | Color and D1–D6 infrared coverage, 7 layers | Active capture2 locks five exact observation files for detectors 2–6, with IRSA and AWS mirror links verified by HEAD; manifest SHA is `f826c8fb4cde3e8618ef2a7d3c631246014d2f771dffe434b69b0eaac8e4402c` | D1 has no captured file and remains entrypoint-only. This single observation is not an all-sky roster; precision remains estimated and `inventoryComplete=false` |
| 4 — ZTF `ztf-dr7` | Color and g/r/i imaging, 4 layers | Official unit geometry/file rules and historical release selectors remain documented | A genuine frozen DR7 image/reference roster is missing. Current reference images cannot establish the DR7 snapshot |

The 2MASS captures below are bounded regional increments, not a 6X inventory.
For broader coverage, expand via explicit regions/scans and cross-check
directory membership rather than labeling the first 46 or 55 coadds as all 6X.
This combined increment is active in Dev. The remaining follow-up is to identify
another official, reproducible native-unit inventory; see the next-candidate
research record. Keep M31 and LMC as bounded 6X regions, not a complete inventory.

## 2MASS 6X: working alternate metadata service and actual full images

### Endpoints and bounded response evidence

IRSA's [official Image Inventory Program Interface](https://irsa.ipac.caltech.edu/applications/2MASS/IM/docs/siahelp.html)
documents `nph-im_sia`, `ds=sx` for the **6X Catalog** image set, `ds=sxw` for
**Full 6X**, and Atlas versus Quicklook selection. These are separate scopes;
do not mix either with the All-Sky `asky` image inventory. The official
[IBE 6X metadata/product guide](https://irsa.ipac.caltech.edu/ibe/docs/twomass/sixxcat/sixxcat/)
also returned HTTP 200 and defines whole-image paths.

| Exact metadata request | Observed result |
| --- | --- |
| [Small M31 SIA query](https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia?ds=sx&POS=10.6847083%2C41.26875&SIZE=0.1&FORMAT=image%2Ffits) | HTTP 200, `QUERY_STATUS=OK`; 9 rows, 3 distinct `coadd_key` values, J/H/K; 17,356 response bytes |
| [Larger bounded M31 SIA query](https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia?ds=sx&POS=10.6847083%2C41.26875&SIZE=1.0&FORMAT=image%2Ffits) | HTTP 200, `QUERY_STATUS=OK`; 138 rows, 46 distinct `coadd_key` values, J/H/K, dates/hemispheres `001113n` and `001114n`; 147,481 bytes |
| [CGI service metadata](https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia?FORMAT=METADATA) | HTTP 200, `QUERY_STATUS=OK`; parameter/column definitions |
| `nph-im_sia?ds=sx&xdate=000325&hem=n&scan=34&FORMAT=image/fits` | HTTP 200 but `QUERY_STATUS=ERROR`: **No location specified**. Date/hemisphere/scan filters do not replace a position |
| `https://irsa.ipac.caltech.edu/ibe/search/twomass/sixxcat/sixxcat?POS=80,-69&SIZE=0.01` | HTTP 502, `Proxy Error` |
| `https://irsa.ipac.caltech.edu/ibe/search/twomass/sixxcat/sixxcat?FORMAT=METADATA` | HTTP 502, `Proxy Error` |

### Additional bounded-region probe, LMC

At 2026-10-05 08:55 Asia/Shanghai, a new official SIA request for
`ds=sx`, `POS=80.894,-69.756`, `SIZE=1.0`, `FORMAT=image/fits`, and
`MAXREC=1000` returned HTTP 200 / `QUERY_STATUS=OK`. The 174,886-byte VOTable
has SHA-256 `689e84b0a17fc0f3dea48aa060216318ad7572edf48809f18f2f89ea0dd662db`,
165 band-image rows across 55 coadds (J/H/K each 55) and six scan date/hemisphere
identities: `001208s`, `001229s`, `010103s`, `010113s`, `010202s`, `010203s`.
The exact request is
[the LMC one-degree SIA query](https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia?ds=sx&POS=80.894%2C-69.756&SIZE=1.0&FORMAT=image%2Ffits&MAXREC=1000).

Capture1 normalized the response into 165 metadata-only rows, computed each
frame's ICRS edge polygon from its source FK5/J2000 SIN WCS, and verified 55
distinct coadds with 55 rows in each J/H/K band. The VOTable SHA remains
`689e84b0a17fc0f3dea48aa060216318ad7572edf48809f18f2f89ea0dd662db`; the
immutable local capture is
`/home/aaron/.local/share/astro-assets-deployments/dev/20261005-2mass-6x-lmc-capture1/`.
Its manifest SHA-256 is
`d8f1a9f217d87d5b72696d567d701bec27e542ab4eb8976b9cce0e16421ae477`, and the
compressed normalized rows SHA-256 is
`ecaca1cbb7084aec497bdf0ff52961a11a88edc423bc1eabca9d8e4559a5c3ce` (9,756
bytes). The input declares `queryPagesComplete=true` and
`inventoryComplete=false`. It is captured locally but is not yet staged in the
Assets evidence PVC or imported into Dev.

Three first-coadd whole-image IBE URLs passed HEAD with HTTP 200 and
`application/x-gzip`: J `ji0370080.fits.gz` (1,584,923 bytes), H
`hi0370080.fits.gz` (1,495,345 bytes), and K `ki0370080.fits.gz` (1,467,766
bytes), all under
`https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/001208s/s037/image/`.
These checks validate the direct single-file path rule only for one coadd and
do not establish availability for all 165 files. Exact one-degree probes at
M81, M82, M83, and NGC 253 returned HTTP 200 / `OK` with zero rows; that only
describes those four query circles, not full 6X coverage.

The larger response SHA-256 is
`248320f4db8d454e90d76bb4736c4bbb2796734cdd0ff572179741fc97c6acaa`;
the smaller response SHA-256 is
`be1a4d000761655a7eaba123fefd5da2603673bc657c6cf22c2405fe0e25a245`.
Neither response declares a global 6X expected row count. A successful bounded
SIA response is evidence for that query only; verify duplicate identities and
any service truncation/status indicators during acquisition and keep global
inventory completeness separate.

### Native identity and geometry

The small query's first actual row identifies `dataset=sx`, date `001114`,
hemisphere `n`, scan `46`, image `33`, band `J`, `type=A` (Atlas), and
`coadd_key=54225`. H and K are separately returned for that coadd. Use the
dataset/date/hemisphere/scan/image identity, with its real band/file attached;
keep `coadd_key` as additional evidence. The
[6X cautionary notes](https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/doc/seca3_1d.html#6xatlas)
warn about duplicated Tile numbers, so a bare Tile number is not a unique
replacement for this native identity.

The response includes a complete frame WCS description:

```text
COOSYS: system=eq_FK5, equinox=J2000.0, epoch=J2000.0
PARAM crefframe=FK5, cequinox=2000.0, ctype=SIN
naxis  = 512 1024
scale  = -2.777777845e-04  2.777777845e-04 degrees/pixel
crpix  = 256.5 512.5
crval  = 10.68145330 41.29402879 degrees
crota2 = 0.03385583169 degrees
pixflags = CZ
```

The column descriptions call `center_ra/center_dec` ICRS while their `ref`
points to the FK5/J2000 `COOSYS`; preserve this source inconsistency. For frame
construction, use the explicit WCS frame declarations rather than silently
relabeling the values ICRS. Astropy WCS with `RA---SIN/DEC--SIN`, signed scale
and CROTA2 produces the following frame-edge corners from FITS pixel edges
`(0.5,0.5)`, `(512.5,0.5)`, `(512.5,1024.5)`, `(0.5,1024.5)`; FK5/J2000 to
ICRS conversion was performed using only returned metadata:

```text
POLYGON ICRS
10.7759944164 41.1518082455
10.5871124880 41.1517243701
10.5864760203 41.4361687116
10.7761833685 41.4362529535
```

WCS pixel/world round-trip errors were approximately `1e-10` pixel. This tests
the metadata calculation, not scientific image contents. These are estimated
frame bounds: original headers, distortion differences, valid-pixel masks and
artifact/quality semantics were not independently checked. Preserve the
source WCS, frame, `pixflags`, query response SHA and selected band. A merged
6X MOC or a scan center is not a substitute for each actual Atlas image.

### Source-supported whole-file paths and dated checks

The [official IBE guide](https://irsa.ipac.caltech.edu/ibe/docs/twomass/sixxcat/sixxcat/)
defines the whole-image location from `ordate`, `hemisphere`, `scanno`, and
the real `fname`:

```text
https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/
<yymmdd><hemisphere>/s<scan:03d>/image/<fname>
```

Use the exact directory/filename roster, preserving date leading zeros.
The guide separately documents `center/size` query parameters as cutouts;
the unparameterized `.fits.gz` links below are whole Atlas images, not bundle
archives. Gzip compresses each one FITS file.

The [matching directory](https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/001114n/s046/image/)
returned HTTP 200, listed 12 image files, and explicitly included all three
files for image `0033`. Directory SHA-256:
`30973c0dd1cc6a7ac0d27188ffc596f83045f85d0d30e55f2bfbf53d975aa040`.

| Exact full-image URL | HEAD result |
| --- | --- |
| [J `ji0460033.fits.gz`](https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/001114n/s046/image/ji0460033.fits.gz) | HTTP 200, `application/x-gzip`, 1,696,381 bytes |
| [H `hi0460033.fits.gz`](https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/001114n/s046/image/hi0460033.fits.gz) | HTTP 200, `application/x-gzip`, 1,622,319 bytes |
| [K `ki0460033.fits.gz`](https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/001114n/s046/image/ki0460033.fits.gz) | HTTP 200, `application/x-gzip`, 1,611,895 bytes |
| [Another directory-listed J image](https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/000325n/s034/image/ji0340009.fits.gz) | HTTP 200, `application/x-gzip`, 1,437,007 bytes |

The source-returned CGI `download` URL for the same first J row is
[`nph-im?ds=sx&atdir=/ti09/6x&dh=001114n&scan=046&name=ji0460033.fits`](https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im?ds=sx&atdir=/ti09/6x&dh=001114n&scan=046&name=ji0460033.fits).
Its HEAD returned HTTP 200 but `text/html`, with no length. This does **not**
verify a science-file response; preserve it as the original access evidence
and prefer the documented, directory-confirmed IBE full-file URI. Only the
representative IBE files above were HEAD-checked, not all 138 rows. No separate
regional mirror was established in this recheck.

## DES DR2: genuine ICRS Tile geometry behind SIA

The [NOIRLab DES description](https://datalab.noirlab.edu/data/dark-energy-survey)
returned HTTP 200 and documents 10,169 DR2 coadd Tiles. `des_dr1.tile_info`
belongs to DR1. However the DR2 image-metadata tables are accessible through
the official [Data Lab TAP service](https://datalab.noirlab.edu/tap/).

All SQL below was sent to `https://datalab.noirlab.edu/tap/sync` with
`REQUEST=doQuery`, `LANG=ADQL`, and the stated `FORMAT`/`MAXREC`. Do not mistake
HTTP 200 for query success: inspect VOTable `QUERY_STATUS` as well.

### Actual schema and coordinate declaration

This discovery query returned HTTP 200 / CSV and names including
`ivoa_des_dr2.siav1`, `.siav2`, `.obscore` and `.exposure`:

```sql
SELECT TOP 20 table_name FROM TAP_SCHEMA.tables
WHERE table_name LIKE '%ivoa%des%dr2%'
```

`SELECT TOP 1 * FROM ivoa_des_dr2.siav1` returned HTTP 200 and actual row
`object=DES0121-1832`, `fileref=DES0121-1832_r4907p01_g.fits.fz`,
`filter=g`, file/extension publisher ID, an access URL, `RA---TAN/DEC--TAN`,
image dimensions and four RA/Dec corner pairs. The source schema query was:

```sql
SELECT column_name, description, unit, ucd, utype
FROM TAP_SCHEMA.columns
WHERE table_name = 'ivoa_des_dr2.siav1'
  AND column_name IN ('object','ra1','dec1','ra2','dec2','ra3','dec3',
                      'ra4','dec4','obs_pub_did','id','fileref',
                      'filter','access_url')
```

It returned HTTP 200 / CSV and explicitly describes `ra1/dec1` through
`ra4/dec4` as the lower-left, lower-right, upper-right and upper-left **ICRS**
image positions. Response SHA-256:
`decc1e7367e93b01b90a6f83c19f93760fa263c2327963fdecd4e1c2617f0031`.
For the real first Tile, the corners are:

```text
POLYGON ICRS
20.8041 -18.9093
20.0320 -18.9093
20.0336 -18.1788
20.8025 -18.1788
```

Use `object` as the Tile ID; retain each actual `fileref`, filter and
`obs_pub_did` including the FITS extension. `obs_id=des_dr2` is a collection
identifier, not a unique Tile. Keep the source's reported corner order and
handle RA wrap on the sphere: the first sorted Tile `DES0000-0207` has corners
near both `0.377` and `359.646` degrees. Report this as estimated frame
coverage, not a valid-pixel mask or source-object coverage.

The sampled ObsCore row has an ICRS **circle** in `s_region`, rather than this
four-corner polygon. Prefer the file-specific corner evidence for image-frame
matching; do not substitute the broad circle merely because it is ObsCore.

### Proven denominator and bounded keyset continuation

Use the science-image HDU selector `obs_pub_did LIKE '%#1'` and actual filters
g/r/i/z/Y. The single-Tile query shows standard and `_nobkg` file variants,
each with extensions `#1`, `#2`, `#3`, plus a detection file. Do not count
all SIA rows as distinct Tiles or silently combine science and mask HDUs.

```sql
SELECT object, COUNT(*) AS files
FROM ivoa_des_dr2.siav1
WHERE obs_pub_did LIKE '%#1' AND filter IN ('g','r','i','z','Y')
GROUP BY object ORDER BY object
```

With `FORMAT=votable&MAXREC=20000`, this returned HTTP 200,
`QUERY_STATUS=OK`, **10,169 Tile rows**, all with `files=10`, sum **101,690**.
The full aggregate response was 427,870 bytes, SHA-256
`6084ff3002f0459d34d96249b159374b0305a020f7615f938c97209b18fc541e`.
A grouped filter count separately returned **20,338** rows per band. Adding
`AND fileref NOT LIKE '%nobkg%'` to the source `COUNT(*)` returned **50,845**
normal band-image rows. This establishes a metadata-query denominator,
not independent science completeness.

The following first page returned HTTP 200 / `QUERY_STATUS=OK`, five rows:

```sql
SELECT TOP 5 object, fileref, filter, obs_pub_did, access_url,
             ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4
FROM ivoa_des_dr2.siav1
WHERE obs_pub_did LIKE '%#1' AND filter IN ('g','r','i','z','Y')
ORDER BY obs_pub_did
```

The second page adds this exact predicate before the same `ORDER BY`:

```sql
AND obs_pub_did >
    'ivo://datalab.noao/des_dr2/DES0000-0207_r4907p01_r.fits.fz#1'
```

It returned five subsequent rows, HTTP 200 / `QUERY_STATUS=OK`, with no
duplicate of the first page's keys. Page SHA-256 values:
first page `15f02a00db32537f9ee94322fe137b12915c3fedb61a999fc425ca3a66f9ab05`;
second page
`25f09497e0bbf510f2a439302f297e6c89e05049c8e97956f97df5708b7c49cf`.
These are pagination probes only; no full 101,690-row file inventory has been
captured or imported here. Lock a declared selector, compare completed page
counts with the matching denominator, reject duplicate IDs, and retain the
terminal response when implementing acquisition. Database sort order can
place uppercase Y after lowercase r; use the server's cursor ordering.

`COUNT(DISTINCT object)` was also attempted: HTTP 200 with
`QUERY_STATUS=ERROR` and a parser error. The successful `GROUP BY` result,
not that failed query, is the 10,169-Tile evidence.

### Access semantics and per-file verification

The official [SIA tutorial](https://github.com/astro-datalab/notebooks-latest/blob/master/04_HowTos/SiaService/How_to_use_the_Simple_Image_Access_service.ipynb)
explicitly calls its positional workflow **image cutouts** and explains that
`access_url` points to the requested cutout. The
[live DES DR2 SIA request](https://datalab.noirlab.edu/sia/des_dr2?POS=25,-45&SIZE=0.02&VERB=3)
returned HTTP 200 / `QUERY_STATUS=OK`, 33 rows for real Tile `DES0139-4457`;
`s_region` and usable WCS are empty in this SIA response. The TAP table's
corners resolve that geometry gap.

An explicit [g-band cutout](https://datalab.noirlab.edu/svc/cutout?col=des_dr2&siaRef=DES0139-4457_r4920p02_g.fits.fz&extn=1&POS=25.0,-45.0&SIZE=0.02,0.02)
passed HEAD: HTTP 200, `image/fits`, no content length. The source-listed
[no-size access URL](https://datalab.noirlab.edu/svc/cutout?col=des_dr2&siaRef=DES0121-1832_r4907p01_g.fits.fz&extn=1)
has no `POS` or `SIZE`. A bounded response sample reported a 10,000-by-10,000
FITS image, while the explicit positional request returned a 275-by-275
cutout; no full image was retained. On 2026-10-05, HEAD for source-listed
positive Tile `DES0000+0209` returned HTTP 200 / `image/fits` without a
Content-Length. Replacing its literal `+` with `%2B` returned HTTP 500 / HTML.
Keep the source URI unchanged. These probes verify representative routes only;
individual files and valid-pixel masks remain unverified.

The official [NCSA DR2 page](https://des.ncsa.illinois.edu/releases/dr2) and
`https://desdr-server.ncsa.illinois.edu/despublic/dr2_tiles/` probes timed out
after 18 seconds from this environment. Do not invent a per-Tile filename
directory or claim that a rule-derived NCSA URL is verified. No independent
mirror was established in this recheck.

### 2026-10-05 metadata capture

The metadata-only collector is
[`scripts/acquire-des-dr2-native-tiles.py`](../../scripts/acquire-des-dr2-native-tiles.py).
It accepts NOIRLab's unnamespaced VOTable 1.2 responses, verifies the
10,169-row grouped Tile denominator and five normal-band counts, and pages by
the server's `obs_pub_did` cursor with duplicate detection. It does not impose
Python string ordering on the endpoint's collation. Native Tile IDs have a
signed declination field, such as `DES0000+0209` and `DES0000-0207`.

The immutable capture is outside Git at
`/home/aaron/.local/share/astro-assets-deployments/dev/20261005-des-dr2-capture3/`.
It contains 11 source pages and 50,845 normalized rows: 10,169 each for
g/r/i/z/Y. The manifest SHA-256 is
`3863ef174b9dadc6ca630eb379e846798fef7dc1d585f14a3b892d12780bfca8`;
local adapter/import validation produced snapshot ID
`b4eeaa92134edd4abeb1a63f86b4922e3b903c8c3de9dea13405b6918e597d94` and
confirmed 50,845 rows across 16 hashed input files. `inventoryComplete=true`
is scoped to this denominator-backed normal-coadd selector. The runtime
binding still reports per-file availability as unverified.

Earlier attempts stopped on the VOTable namespace and signed-ID/order
assumptions; neither partial staging directory contains a complete manifest.
`capture3` is authoritative. No scientific image was downloaded for this
capture. Dev import and activation await completion and activation of the
already-running 2MASS candidate.

## SPHEREx QR2: bounded observation capture

The first-party [archive access guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
and [IRSA tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/)
both returned HTTP 200. They document QR2 wide/deep SIA collections, individual
spectral images, original footprints and returned `access_url/cloud_access`.
Keep the QR2 release and wide/deep scope explicit; QR3 is a different release.

| Exact metadata attempt | Result |
| --- | --- |
| `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&POS=CIRCLE%200%200%200.01` | HTTP 502, `Proxy Error` |
| [The guide's QR2 example](https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&POS=circle+127.69444+-39.17760+0.01&RESPONSEFORMAT=HTML) | HTTP 502; body states **Error reading from remote server** |
| `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr2&MAXREC=1` | HTTP 502, `Proxy Error` |
| TAP `SELECT TOP 5 table_name FROM TAP_SCHEMA.tables WHERE table_name LIKE '%spherex%'` | HTTP 502, `Proxy Error` |
| `SIA?COLLECTION=spherex_qr2_deep&POS=CIRCLE+270+66+0.01` | Read timeout after 16 seconds |

The first-party [cutout tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/)
provides an alternative native metadata join, `spherex.artifact` to
`spherex.plane` by `planeid`, including `p.poly`, band and observation time.
This valid source route was also tried at IRSA TAP `/sync` with
`FORMAT=votable`:

```sql
SELECT TOP 1 a.uri, p.planeid, p.poly, p.energy_bandpassname,
             p.time_bounds_lower
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE a.uri LIKE '%/spherex/qr2/level2/%'
```

It timed out after 16 seconds; no rows or managed input were obtained.

### Public S3 object roster and ranged WCS probe (2026-10-05)

The official AWS mirror also permits anonymous ListObjects V2 requests even
while IRSA SIA/TAP times out. Listing prefix `qr2/level2/` with delimiter `/`
returned HTTP 200, 129 complete common-prefix directories and
`IsTruncated=false`. This is a directory count, not a file or observation
denominator. Under `2025W17_4B/`, the official level2 product version paths
include `l2b-v20-2025-240/` and `l2b-v20-2025-241/`.

The filename prefix `_0001_` contains several distinct observation IDs, so
it is not a valid single-observation selector. In particular, the source FITS
header for `_0001_2D2` identifies `OBSID=2025W17_4B_0001_2`, while the
`_0001_1D2` header identifies `OBSID=2025W17_4B_0001_1`. The collector rejects
that mixed identity. The corrected bounded selector is exact observation
`2025W17_4B_0001_1` under version `v20-2025-240`; detector directories 2
through 6 each list one matching file with `IsTruncated=false`, five FITS
object identities total. This is one observation sample, not an
inventory-completeness claim. One object listing reports
71,634,240 bytes and ETag `ee30fd35a2ab3d38e52d06acc1128cca`.

S3 `Range` requests returned HTTP 206 for aligned FITS header blocks only,
stopping when the first image extension's `END` card was reached; no pixel
payload was requested. Its primary HDU is empty and its `IMAGE` extension is
2040 x 2040 with `CTYPE1/2=RA---TAN-SIP/DEC--TAN-SIP`, `RADESYS=ICRS`,
`CRVAL=(164.705590379, 29.1388961408)` degrees, and SIP distortion cards.
This proves that official object paths can be joined to per-file celestial
frame metadata without using the unavailable live query service.

Capture2 subsequently locked all five detector-specific terminal listings and
header-range receipts, then computed 32-point ICRS frame polygons from each
TAN-SIP image header. It stores five normalized rows plus the raw listing and
header evidence; SHA-256 is
`f826c8fb4cde3e8618ef2a7d3c631246014d2f771dffe434b69b0eaac8e4402c`.
The immutable local capture is under
`/home/aaron/.local/share/astro-assets-deployments/dev/20261005-spherex-qr2-2025w17-4b-0001-capture2/`
and the PVC staging path is
`managed/native-units/staging/20261005-spherex-qr2-capture2/`. Pixel ranges were
not requested. This bounded observation has `inventoryComplete=false`; its
frame edges remain estimated and valid-pixel masks were not checked. Import
and activate only through the normal Dev management workflow.

Both representative **whole-image** files passed HEAD again, HTTP 200 and
71,634,240 bytes:

- [IRSA QR2 original](https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W43_1A/l2b-v20-2025-299/5/level2_2025W43_1A_0516_1D5_spx_l2b-v20-2025-299.fits), `application/fits`.
- [Official AWS mirror](https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr2/level2/2025W43_1A/l2b-v20-2025-299/5/level2_2025W43_1A_0516_1D5_spx_l2b-v20-2025-299.fits), `binary/octet-stream`.

The [official cloud-access page](https://irsa.ipac.caltech.edu/cloud_access/#spherex)
and archive guide establish this mirror and its relative path rules. Keep
both sources and their US location. A successful file HEAD is not an observation
inventory or a footprint snapshot.

## ZTF DR7: current files cannot restore the historical release

The official [API guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_api.html),
[file-path guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_metadata.html),
[release list](https://irsa.ipac.caltech.edu/data/ZTF/docs/ztf_data_releases.txt)
and [DR7 release notes](https://irsa.ipac.caltech.edu/data/ZTF/docs/releases/dr07/ztf_release_notes_dr07.pdf)
returned HTTP 200. They retain genuine field/CCD/quadrant identities, image
corner geometry, per-exposure file paths and reference-file paths. The release
list says releases are cumulative and **only the last five** are available
through the current IRSA UI/API. This is an old-release membership limitation,
not evidence that ZTF lacks native spatial units.

The DR7 notes give public program 1 g/r exposures over MJD 58194–59396 and
programs 2/3 g/r/i over MJD 58194–58908. They also state that reference images
are **updated continually**, may include good-quality exposures irrespective
of these epoch spans, and report a historical reference snapshot. Thus date
cuts on today's archive do not reconstruct DR7 reference versions or prove
which files generated the published DR7 HiPS coverage.

These bounded metadata retries both timed out after 16 seconds:

```text
https://irsa.ipac.caltech.edu/ibe/search/ztf/products/ref
  ?WHERE=field=000535 AND ccdid=11 AND qid=3

https://irsa.ipac.caltech.edu/ibe/search/ztf/products/sci
  ?WHERE=field=535 AND ccdid=11 AND qid=3 AND filefracday=20180411467847
  &COLUMNS=filefracday,field,ccdid,qid,filtercode,
           ra1,dec1,ra2,dec2,ra3,dec3,ra4,dec4,pid,programid
  &CT=csv
```

These retries obtained no usable metadata. Even a successful current response
would require an authoritative DR7 inventory/processing association before
binding it to `ztf-dr7`. Keep the known release/source visible with its gap;
do not bind present-day references or newer releases under DR7.

## Evidence location and implementation boundary

Public probe responses and documentation are temporarily under
`/tmp/assets-next-survey-recheck-20261005/`; this is a diagnostic directory,
not a durable managed input or evidence archive. Key files are
`sixx-cgi-sia-m31.xml`, `sixx-cgi-sia-m31-1deg.xml`,
`sixx-m31-directory.html`, `des-corner-columns.csv`,
`des-order-page1.xml`, `des-order-page2.xml`,
`des-tile-denominator.xml`, and `des-native-filename-quality.xml`.
No scientific file bytes are stored there.

Before import, an acquisition must save immutable original metadata and
directory evidence outside Assets Git, SHA-lock every dependency, record the
exact source selectors and status/completeness, retain original coordinate
declarations and actual file identities, and cross-check every generated file
path against the source contract/roster. Follow
[native unit management](../native-unit-management.md) for import, build,
review, dependency archive and Dev-only activation, preserving the installed
index. Preserve whole files, cutouts, query entrypoints, source-listed paths
and representative availability checks as their actual types. No new public
MOC or change to 72602/Workspace is implied by these findings.
