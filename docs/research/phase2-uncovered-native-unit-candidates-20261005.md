# Uncovered native sky-unit candidates, checked 2026-10-05

**AllWISE W3/W4 is the clearest next Dev increment.** Its first-party metadata
service, native Atlas Tile identity, frame geometry, global denominator and
individual-file paths all work. The separately listed DECaLS DR5 product is a
second, conditional candidate: the existing Legacy DR5 brick inventory is useful,
but it does not isolate observations made by the DECaLS program.

This note began as a source audit. The AllWISE metadata-only capture and adapter
are now implemented, but the capture is staged in Dev evidence storage and has
not yet been imported into the managed index or activated. The separate VIKING
candidate build is still running. Source probes read public documentation,
metadata and directory listings; science-file access checks used HEAD. One
AllWISE W3 FITS header was read with two explicitly confirmed 2,880-byte HTTP
ranges, stopping at the header END block. No scientific pixels, public bundle,
or MOC were changed. Initial diagnostic responses are under
`/tmp/assets-uncovered-research-20261005/`; they are not managed inputs or
archived dependencies.

## Published product identities and ranking

The Dev [coverage catalog](http://10.15.51.75:32083/api/v1/coverage/catalog)
returned 132 layers. These three relevant product identities reported
`sourceUnitIndex.status=entrypoint-only` during this check:

| Rank | Published identity | Feasibility | Qualification |
| --- | --- | --- | --- |
| 1 | `allwise` / `allwise`: W3 `e795f90cc525b5310aa6`; W4 `2415c4ce8e7c2307b676` | Captured and reconciled 36,480 official source-table rows: 18,240 W3 and 18,240 W4 rows with matching coadd IDs | Inventory is complete only for the declared W3/W4 intensity table; geometry is estimated and individual file availability remains unverified |
| 2, conditional | `decals` / `decals-dr5`: g/r/z color `bd6574b77e120d049660` | Official 176,811-brick DR5 roster already exists as a locked Legacy input; representative native brick directory and g/r/z files are available | The roster includes other DECam programs. Explicitly adopt official DR5 pipeline/coadd scope, or acquire program-specific contribution evidence before claiming an exclusively DECaLS inventory |

These are the candidates actually audited here, not a claim that every other
uncovered survey has been exhausted. ACT DR5 and DECaPS DR2 initial probes are
recorded below without a readiness claim.

## 1. AllWISE: a defensible full source-table roster

### First-party release and native identity

The [AllWISE Image Atlas description](https://wise2.ipac.caltech.edu/docs/release/allwise/expsup/sec4_1.html#desc)
states that the Atlas contains **18,240** image sets on fixed approximately
1.56° × 1.56° Tile footprints. Each set contains four spatially registered
intensity images, one per WISE band, plus separate uncertainty and coverage
products. The description specifies 4,095 × 4,095 pixels at 1.375 arcsec/pixel.
An Atlas Tile is a native source unit; a selected HEALPix cell is not its ID.

The [official IBE AllWISE product guide](https://irsa.ipac.caltech.edu/ibe/docs/wise/allwise/p3am_cdd/)
returned HTTP 200. It defines a metadata row as a single coadd uniquely
identified by **`coadd_id` and `band`**. Use `coadd_id` as the Tile identity and
retain the band and actual intensity filename as its product/file identity.
The suffix such as `_ac51` belongs to the native ID and must not be dropped.

The available Assets products are W3 and W4. Do not add W1/W2 bindings simply
because the same upstream service also contains them. Uncertainty, coverage and
artifact tables are ancillary products; they must not replace the matched
intensity-image URI.

### Live table, counts and reproducible continuation

The [IRSA TAP service](https://irsa.ipac.caltech.edu/TAP/sync) and its
[first-party query documentation](https://irsa.ipac.caltech.edu/docs/program_interface/TAP.html)
support the metadata acquisition. All SQL below was sent with `REQUEST=doQuery`
and `LANG=ADQL`; the count-by-band response was CSV, while the distinct-count
and page responses were VOTable. The latter explicitly returned
`QUERY_STATUS=OK`, rather than merely HTTP 200.

```sql
SELECT table_name FROM TAP_SCHEMA.tables
WHERE table_name LIKE '%p3am%'

SELECT column_name, datatype, description, unit, ucd
FROM TAP_SCHEMA.columns
WHERE table_name = 'allwise_p3am_cdd'

SELECT band, COUNT(*) AS n
FROM allwise_p3am_cdd
GROUP BY band

SELECT COUNT(DISTINCT coadd_id) AS n
FROM allwise_p3am_cdd WHERE band = 3

SELECT COUNT(DISTINCT coadd_id) AS n
FROM allwise_p3am_cdd WHERE band = 4
```

The source schema contains `allwise_p3am_cdd`. The grouped response returned
**18,240 for each of bands 1, 2, 3 and 4**, or 72,960 rows overall. Both
independent W3 and W4 distinct-coadd counts returned **18,240**, matching the
official release denominator. Thus each required band has one row per coadd
within this table. Counts alone do not demonstrate that the complete W3/W4 ID
sets are identical; compare those sets after full capture.

This small ordered page returned six rows, with both required bands for
`0000m016_ac51`, `0000m031_ac51` and `0000m046_ac51`:

```sql
SELECT TOP 6 coadd_id, band, ra1, dec1, ra2, dec2,
       ra3, dec3, ra4, dec4, crval1, crval2,
       naxis1, naxis2, ctype1, ctype2, equinox, cntr
FROM allwise_p3am_cdd
WHERE band IN (3,4)
ORDER BY coadd_id, band
```

The exact composite-key continuation also succeeded, yielding W3/W4 for
`0000m061_ac51`, `0000m076_ac51` and `0000m091_ac51`:

```sql
SELECT TOP 6 coadd_id, band, cntr
FROM allwise_p3am_cdd
WHERE band IN (3,4)
  AND (coadd_id > '0000m046_ac51'
       OR (coadd_id = '0000m046_ac51' AND band > 4))
ORDER BY coadd_id, band
```

For acquisition, use the same full column list in every page, freeze
`band IN (3,4)`, order by `(coadd_id, band)`, and advance strictly after the
last returned pair. Use a page size such as 1,000 and `MAXREC` above that size;
inspect the actual response status, duplicate keys, terminal page and raw page
hashes. Reconcile 36,480 rows, 18,240 unique pairs in each band, both coadd ID
sets and all geometry/access fields. Capture counts before and after acquisition
to detect changes. Do not treat the two diagnostic pages here as the full
inventory.

**Can this table establish the full W3/W4 roster? Yes, within its declared
source-table scope**, once those reconciliations pass. It has an official global
denominator and a working continuation rule, so no arbitrary small sky-region
limit is needed. This still does not prove scientific valid-pixel coverage,
the presence of every ancillary product, or current availability of every
intensity file. Keep those qualifications separate from pagination and roster
completeness. Follow the managed import/build/review/archive/activation workflow
before reporting any new index active.

### Geometry and coordinate-frame handling

The [live IBE column metadata](https://irsa.ipac.caltech.edu/ibe/search/wise/allwise/p3am_cdd?FORMAT=METADATA)
and TAP schema provide four image corners `ra1/dec1` through `ra4/dec4`, image
dimensions, `CRVAL`, `CRPIX`, `CTYPE`, `CDELT`, `CROTA2` and `equinox`.
The schema labels the corner positions **J2000**. The
[official header guide](https://wise2.ipac.caltech.edu/docs/release/allwise/expsup/sec4_1b.html)
also defines `EQUINOX` and the SIN projection WCS. Preserve these declarations;
do not silently relabel the source corners as ICRS.

The sample W3/W4 Tile `0000m016_ac51` has `EQUINOX=2000`,
`CTYPE=RA---SIN/DEC--SIN` and these source-labelled J2000 corners:

```text
0.783066597436   -2.296740180822
359.217315689685 -2.296740318771
359.217880601775 -0.732247395259
0.782501409442   -0.732247257410
```

This is a real RA-wrap case. Candidate selection and footprint intersection
must operate on spherical geometry, including pole-crossing Tiles, rather than
taking a flat minimum/maximum RA rectangle. If applying the normal FITS
FK5/J2000 convention to convert these WCS/corners to ICRS, record that conversion
convention explicitly and retain the original WCS. Match image-frame bounds
with `precision=estimated`: frame geometry is not a valid-pixel mask, and the
source-defined corner convention must not be replaced by invented bounds.

The real W3 file for `0384p651_ac51` confirmed this metadata with a **header-only**
check: two HTTP 206 ranges `bytes=0-2879` and `bytes=2880-5759` returned the
header through `END`. It has 4,095 × 4,095 axes, SIN WCS, `EQUINOX=2000`,
`BAND=3` and the exact `COADDID`. No `RADESYS` or `RADECSYS` card appeared in
that complete header. The header hash is
`7ddbe41db4b7810b9bbfce3b5da780726beb7c443896f70c34bcdd4dc45720b1`.
This is one representative header check, not a complete image or mask audit.

### Exact file and directory rules, with availability

The [first-party IBE guide](https://irsa.ipac.caltech.edu/ibe/docs/wise/allwise/p3am_cdd/#int)
defines the **whole intensity FITS** path:

```text
coaddgrp = coadd_id[0:2]
coadd_ra = coadd_id[0:4]

https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/
<coaddgrp>/<coadd_ra>/<coadd_id>/<coadd_id>-w<band>-int-3.fits
```

For the existing products, `<band>` is `3` or `4`. Without `center/size` query
parameters this is an individual complete FITS image, not a generated cutout
or a multi-file archive. Its parent directory is independently useful to the
user and can also be retained as a directory source.

The [real Tile directory](https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/03/0384/0384p651_ac51/)
returned HTTP 200 and lists both filenames below. The
[bounded IBE source response](https://irsa.ipac.caltech.edu/ibe/search/wise/allwise/p3am_cdd?POS=39.00%2C65.57)
returns the same Tile with W1/W2/W3/W4 band rows. These are the observed
availability results for the two required, individual files:

| URI | HEAD result |
| --- | --- |
| [W3 `0384p651_ac51-w3-int-3.fits`](https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/03/0384/0384p651_ac51/0384p651_ac51-w3-int-3.fits) | HTTP 200; `image/x-fits`; 67,083,840 bytes; byte ranges supported |
| [W4 `0384p651_ac51-w4-int-3.fits`](https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/03/0384/0384p651_ac51/0384p651_ac51-w4-int-3.fits) | HTTP 200; `image/x-fits`; 67,083,840 bytes; byte ranges supported |

Do not extend these two HEAD results to all 36,480 file candidates. The guide
also documents per-file `.md5` sidecars; they are source checksum identities,
not scientific checksum verification performed by this research. No separate
AllWISE regional mirror was established here. The official IRSA path can be
recorded as the US source; add additional mirrors only after verifying their
own source identities and path rules.

### 2026-10-05 metadata capture and Dev evidence stage

The collector queried the official AllWISE TAP `allwise_p3am_cdd` table in 37
ordered pages. Before/after source counts remained 36,480 total rows, with
18,240 rows in each of W3 and W4; the two bands contain the same 18,240 coadd
IDs. This is the complete source-table roster for the two bound intensity
products, not every AllWISE ancillary product. The capture sets
`queryPagesComplete=true` and `inventoryComplete=true` for this declared table
scope.

The capture is at
`/home/aaron/.local/share/astro-assets-deployments/dev/20261005-allwise-w3w4-capture1/`.
Its manifest SHA-256 is
`233d829a1ec9bcac1a909f78568a09af628cf5f9db4fd316e4a33d9bf5f4e780` (76,551
bytes). The 46 VOTable evidence documents and one normalized gzip row file have
all been staged and independently checked in Dev at
`/var/lib/assets-evidence/managed/native-units/staging/20261005-allwise-w3w4-capture1/`:
48/48 files, 34,319,542 bytes, with each dependency's declared SHA-256 and size
matching. The normalized file has SHA-256
`efb4a810ba51b3e6c3e07b673c59724d36d014d685850ade89f8778320502df1` and contains
36,480 rows. No science pixels were captured.

The adapter, source registration and W3/W4 product bindings are present in the
working tree. Its three focused collector tests, the 427-test Node suite (425
passed, two skipped), production build, 37 Python collector tests and Helm lint
passed. The new code still needs a Dev rollout before the manifest can be
imported through the authenticated native-unit management API. The managed
`import → build → review → archive → activate` sequence and live region lookup
remain outstanding.

## 2. DECaLS DR5: useful shared roster, unresolved program restriction

### What the official release actually contains

The [official DR5 description](https://www.legacysurvey.org/dr5/description/#contents-of-dr5)
calls DR5 the fourth public release of DECaLS images/catalogs and gives
**176,811 bricks**. It explicitly says that DR5 also includes **DECam data from
non-DECaLS surveys**, in addition to DECaLS program 0404 observations. Therefore
“DR5 pipeline/coadd data” and “bricks observed exclusively by the DECaLS
program” are different scopes.

The [official DR5 files guide](https://www.legacysurvey.org/dr5/files/)
distinguishes the all-sky geometric grid, `survey-bricks.fits.gz`, from the
release membership summary, `survey-bricks-dr5.fits.gz`. The latter contains
`brickname`, center coordinates, `nexp_g/r/z` and exposure histograms. Those
summaries do not include an observing-program-only selector. A positive band
exposure summary is not proof that its contributing observations came only
from DECaLS program 0404, nor proof of present-day file availability.

The local [source lock](../../src/layers/recipes/source-unit-indexes.lock.json)
already records the official DR5 roster under `legacy-dr5`: 176,811 rows,
27,041,967 bytes, SHA-256
`3bddc0adb01612cd4c1003d691a0f5987d5a882ad8353e0efd8e89c8d78a8e44`.
Its existing geometry join is described in the
[previous brick inventory audit](native-block-access-uris.md#legacy-surveys-dr1-dr10-inventory-differences).
The upstream [roster URL](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/survey-bricks-dr5.fits.gz)
still returned HEAD HTTP 200 during this check. The complete metadata table
was not re-downloaded here.

### Can that shared roster safely exclude non-DECaLS bricks?

**No.** Neither its native brick identity nor its band counts establish
program-specific membership. A brick may combine contributions from multiple
programs; even identifying the existence of one DECaLS exposure would not
make the whole coadd exclusively DECaLS data. A source-wide MOC or a matching
sky position cannot supply that missing provenance.

Two defensible implementation choices remain:

1. If the published `decals-dr5` color product is explicitly intended to mean
   the official DR5 pipeline/coadd release, create a reviewed binding with that
   full scope and preserve shared Legacy source identities. Label the scope
   truthfully, retain per-band availability rules, and avoid manufacturing a
   separate color FITS file. This is the smaller increment.
2. If the intended product is DECaLS-program-only, acquire the accepted CCD
   contribution inventory and its observing-program provenance, then reconcile
   contributions per brick. The metadata guide lists relevant CCD tables, but
   this research did not prove the required program-to-brick join or a
   program-only denominator. Keep the product entrypoint-only until that
   evidence exists.

The catalog currently describes its footprint as CDS-hosted DECaLS DR5
g/r/z color HiPS availability; that third-party geometry alone does not resolve
this provenance question. A reviewed semantic mapping is necessary before
reusing the Legacy roster under the separately listed survey ID.

### Genuine brick files are available

The [official DR5 files guide](https://www.legacysurvey.org/dr5/files/) names the
NERSC release root and coadd hierarchy. The
[actual brick directory `1498p020`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/coadd/149/1498p020/)
returned HTTP 200 and explicitly lists the individual g/r/z image files. Its
current file form is:

```text
https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/
coadd/<brick[0:3]>/<brick>/legacysurvey-<brick>-image-<band>.fits.fz
```

All three representative file HEAD requests for
[g](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/coadd/149/1498p020/legacysurvey-1498p020-image-g.fits.fz),
[r](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/coadd/149/1498p020/legacysurvey-1498p020-image-r.fits.fz)
and [z](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/coadd/149/1498p020/legacysurvey-1498p020-image-z.fits.fz)
returned HTTP 200. `.fits.fz` compresses an individual FITS image and is not a
multi-file bundle. The directory is also a usable source link. These checks
establish access feasibility for this brick only; they resolve neither all-file
availability nor the program-scope issue.

## Other initial probes and their limits

The [NASA LAMBDA ACT product table](https://lambda.gsfc.nasa.gov/product/act/actpol_prod_table.html)
returned HTTP 200. For **DR5**, it lists 42 individual coadd-map files of roughly
5 GB each and links an explicit
[download page](https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_get.html),
[product description](https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_info.html)
and [download script](https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_wget.sh).
Those three endpoints repeatedly timed out in this environment. The known
42-file denominator is promising, but no per-map URI roster or geometry was
captured here. The current Assets ACT products are `act-dr5` 90/150/220 GHz;
do not substitute DR6 or invent a tiled grid for whole native maps. ACT is a
later candidate after its map roster and metadata/header access are verified.

For DECaPS, the [survey landing page](https://decaps.skymaps.info/) failed TLS
handshake; its HTTP form returned 403. The probed
[NERSC project root](https://portal.nersc.gov/project/decaps/) and
`/project/decaps/decaps2/` both returned 403. These are dated access observations,
not proof that DECaPS DR2 lacks native files or a usable alternate archive.
No file paths or inventory were inferred from these failed probes.

CFHTLS, IPHAS, NVSS, Pan-STARRS, Rubin, SUMSS and WENSS were not independently
audited in this note. The prior
[Phase 2 source recheck](phase2-next-survey-rescan-20261005.md) already records
the ZTF DR7 frozen-inventory blocker; current ZTF references cannot silently
replace its historical release.

## Diagnostic hashes and required next work

| Diagnostic response | SHA-256 |
| --- | --- |
| AllWISE count-by-band CSV | `edb688f538ca93923c1e29f747a698d4e3569e5f20b560a42b3ef14a8812e3d3` |
| AllWISE TAP column schema CSV | `6299eb90f706def25b2a5fc7f66da44149ae250d101b2e4392b4788ff0546ca4` |
| W3 distinct-coadd VOTable; W4 has the same response bytes | `3d04da7523f93f96eceadb047c74fd72a443c9a3e97ed4affcb3ec2be6ca6484` |
| W3/W4 first six-row VOTable | `ae444870accd9ecad221426d07f07631c99e82b8225b6d67aea806193274b563` |
| W3/W4 keyset continuation VOTable | `da8f8f67f39fa98c29a68f46793ed2c34c6e5ff303c9f6f6b41debadb3c42e0f` |
| AllWISE native Tile directory | `e60bcc2b995cbc5efd8f20febfb5b1ce6cc417bf61abe42052a72ac123c37014` |
| DECaLS DR5 native brick directory | `a65e90c982fcd7cdfe8a36b72986e4b07eaf587840c2ae9813c56abac459b75d` |

Finish the AllWISE Dev rollout and managed workflow described in
[native-unit management](../native-unit-management.md) and
[coverage workflow](../coverage-workflow.md). Preserve the 36,480-row roster
denominator, native Tile/file IDs, coordinate convention, estimated geometry,
availability scope and every unresolved gap in review and runtime results.
Do not describe the staged capture or successful build alone as an active
index.
