# SDSS DR9 native field metadata supplement

Captured 2026-10-03. This research and collector cover public native sky-unit
metadata for Assets Dev. They do not download science images, source catalogs,
spectra, or pixel masks, and do not activate an index themselves.

## Source and release identity

The existing selectable SDSS products in Assets are DR9 imaging in `u/g/r/i/z`
(`surveyId=sdss`, `releaseId=sdss-dr09`). Use the DR9 native field roster rather
than silently associating a newer release's photometry or astrometry with them.
DR9 explicitly corrected earlier imaging astrometry; unchanged object IDs do not
mean all coordinates and calibrations were unchanged ([DR9 changes](https://www.sdss3.org/dr9/whatsnew.php)).

The official DR9 resolve documentation identifies
[`window_flist.fits`](https://data.sdss.org/sas/dr9/env/PHOTO_RESOLVE/window_flist.fits)
as the field list used to determine the survey window. Its
[official data model](https://data.sdss.org/datamodel/files/PHOTO_RESOLVE/window_flist.html)
defines `RUN`, `RERUN`, `CAMCOL`, `FIELD`, source RA/Dec, the great-circle
`NODE/INCL`, and `MU_START/MU_END/NU_START/NU_END`. These are native field
definitions and acquisition metadata, not object-position catalogs.

The complete metadata response was acquired without Range truncation:

| Property | Captured value |
| --- | --- |
| Bytes | 352,843,200 |
| SHA-256 | `e7d2bae3f1cbb6c04b191073253e9f236f651db7d72dcab0ede0f5ba80e79ecb` |
| Native metadata rows | 1,127,256 |
| `RERUN=301` rows | 938,046 |
| `RERUN=157` rows | 189,210 |
| Source Last-Modified | 2010-05-26 17:35:49 GMT |
| Source ETag | `"4bfd5bf5-1507f5c0"` |

The capture date is the date of this static DR9 metadata retrieval, not a
claim of new SDSS imaging. All original table bytes and HTTP headers remain
outside Git under
`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-other/sdss/`.

## Native geometry and scope

SDSS identifies a field by run, camera column and field sequence; the rerun
adds its processing version. The output ID preserves all four values in
`run/rerun/camcol/field` order. It does not invent a CAS `fieldID`, Tile, visit,
or HEALPix partition.

The [DR9 resolve geometry description](https://www.sdss3.org/dr9/algorithms/resolve.php)
defines the official field area as the corrected image's 2048×1489 pixels with
64 pixels trimmed from **each** edge: 1920×1361 pixels. Its field-window
geometry is consequently smaller than the full corrected frame. The same
documentation states that a field has images in the five `u/g/r/i/z` bands,
taken within a few minutes of each other. That source contract does not prove
the continuing existence of every current SAS file.

The collector converts the four original great-circle window corners with the
[DR9 astrometry equations](https://www.sdss3.org/dr9/algorithms/astrometry.php)
under “Transformation from Great Circle Coordinates to J2000 Celestial
Coordinates.” For `m=mu-node`, `n=nu`, and `i=incl`:

```text
x = cos(m) cos(n)
y = sin(m) cos(n) cos(i) - sin(n) sin(i)
z = sin(m) cos(n) sin(i) + sin(n) cos(i)
ra  = node + atan2(y, x)
dec = asin(z)
```

Each row retains those source coordinates and the original source RA/Dec.
Output `POLYGON ICRS` is approximate equatorial field-window geometry. It is
not an individually decoded band WCS, a valid-pixel mask, or the resolved
primary-only part of a field. Connecting four corners approximates small-circle
edges, and the static window metadata predates the documented DR9 astrometric
corrections. All matches and derived NESTED order-4/order-8 query geometry must
remain `estimated`. These order declarations describe locally computed query
geometry; this collector does not publish or upsample a MOC.

The raw RA/Dec column is not always the converted window's midpoint. Across
the 927,643 normalized rows, their median separation is 0.0000890101 degrees;
the maximum is 0.0633125113 degrees (`1908/301/3/27`). The output `center`
therefore uses the transformed rectangle midpoint. The source RA/Dec remains
under `sourceMetadata.originalCenter`, so a coarse index does not accidentally
use an inconsistent center while discarding the original evidence.

An independent comparison of 1,000 evenly spaced fields / 4,000 corners using
Astropy spherical/cartesian conversions and its three-dimensional rotation
matrices found maximum differences of `1.1368683772161603e-13` degrees in RA
and `5.684341886080802e-14` degrees in Dec. The receipt is
`independent-geometry-verification.json` beside the snapshot. This verifies the
numerical coordinate conversion, without upgrading its scientific precision.

## Normal processing and quality

The normalized scope is `RERUN=301`, `PHOTO_STATUS=0`, valid finite source
window coordinates, and run membership in the official
[DR9 frames/301 directory](https://data.sdss.org/sas/dr9/boss/photoObj/frames/301/).
That directory contains 765 runs, matching every run in the table's rerun301
subset. The normal-processing scope has **927,643 unique fields**, without
duplicate run/rerun/camcol/field identities or invalid source bounds.

Exclusions retain their original rows in the complete metadata evidence:

| Exclusion | Rows |
| --- | --- |
| Rerun157 outside the declared DR9 corrected-frame scope | 189,210 |
| Rerun301 `PHOTO_STATUS=3` | 10,403 |
| Missing run in the official frame run roster | 0 |
| Invalid finite/window geometry | 0 |

The [photoField data model](https://data.sdss.org/datamodel/files/BOSS_PHOTOOBJ/RERUN/RUN/photoField.html)
documents `PHOTO_STATUS=0` as OK and `3` as TOO_LONG. It is a processing
status, not scientific quality. Normalized rows preserve `PSP_STATUS[5]`,
`IMAGE_STATUS[5]`, `CALIB_STATUS[5]`, and `SCORE`, without silently dropping
cloudy or lower-quality fields.

The official [IMAGE_STATUS documentation](https://www.sdss3.org/dr9/algorithms/bitmask_image_status.php)
describes sky and instrument conditions: CLEAR, CLOUDY, UNKNOWN, BAD_ROTATOR,
BAD_ASTROM, BAD_FOCUS, SHUTTERS, FF_PETALS, DEAD_CCD, and NOISY_CCD. These bits
are not file-existence flags. The
[CALIB_STATUS documentation](https://www.sdss3.org/dr9/algorithms/bitmask_calib_status.php)
specifies band-array order `u/g/r/i/z`. In this original `window_flist` snapshot,
**all** CALIB_STATUS values are zero. Neither that zero value nor a CLEAR image
bit establishes photometric quality, present-day file availability, or complete
valid-pixel coverage.

`inventoryComplete=false` remains explicit: the field-window input is fully
captured, but the mapped scope omits nonnormal/rerun157 rows and is not a
verified scientific file inventory.

The final `manifest.json` is 9,085 bytes with SHA-256
`cd1ab3022c1b68fc74f5295ca4084dd51daa38658c4c0b42a1627c02027f4a3d`.
Its ten gzip NDJSON batches contain 927,643 rows, 135,592,351 compressed bytes
and 1,857,406,052 uncompressed bytes. All 18 metadata-document hashes/sizes and
all ten row-file hashes/sizes, gzip CRCs and full row counts passed verification;
`snapshot-verification.json` records the results. `queryPagesComplete=true`
describes the fully captured declared normal-processing rerun301 metadata
scope; it does not upgrade `inventoryComplete` or URI availability.

## Access locations

The [official corrected-frame data model](https://data.sdss.org/datamodel/files/BOSS_PHOTOOBJ/frames/RERUN/RUN/CAMCOL/frame.html)
documents `frame-[ugriz]-[run:06]-[camcol]-[field:04].fits.bz2` in the
`frames/RERUN/RUN/CAMCOL` hierarchy. The
[DR9 image documentation](https://www.sdss3.org/dr9/imaging/images.php)
describes these calibrated corrected frames as the per-field, per-band image
product. Generated access locations use the actual DR9 SAS tree:

```text
https://data.sdss.org/sas/dr9/boss/photoObj/frames/{rerun}/{run}/{camcol}/frame-{band}-{run:06d}-{camcol}-{field:04d}.fits.bz2
```

For field `94/301/1/11`, all five band locations returned HTTP 200 to
**HEAD** on 2026-10-03, with zero science-body bytes read. The headers are saved
in `sample-frame-head-receipts.json`. Those five samples corroborate the naming
rule, not the existence of every generated URI. Every normalized access URI
therefore keeps `availability=unverified` and `resolution=documented-rule`.

## Collector and managed import

[`scripts/acquire-sdss-native-fields.py`](../../scripts/acquire-sdss-native-fields.py)
uses only fixed official metadata/documentation sources with ordinary TLS
verification. It captures a SHA-locked manifest with raw documents, original
HTTP receipts, and gzip NDJSON batches of at most 100,000 native fields.
References are relative to the manifest directory. Each row carries identity,
original coordinate/quality evidence, the estimated polygon, all documented
band locations and their unverified availability.

```bash
python3 scripts/acquire-sdss-native-fields.py --output <evidence-directory>
```

The collector performs no management mutation. Import this evidence through
the authenticated Dev native-unit management workflow before an isolated
candidate is built, verified, reviewed, fully archived and activated. Retain the
geometry, omitted-scope and URI-verification gaps in that review and in runtime
lookup/export. No Dev activation or site verification is established by this
research note alone.
