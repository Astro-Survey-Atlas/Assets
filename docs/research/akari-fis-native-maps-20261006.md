# AKARI FIS native map inventory — 2026-10-06

AKARI FIS is ready for a metadata-only managed acquisition. Its source-owned
inventory has **1,672 native map regions**, **6,688 science images** across four
bands, and real, individually downloadable FITS at IRSA. This note records
research and diagnostic snapshots; it does not claim an installed or active
index. No scientific pixels or archive packages were downloaded.

## Source identity and product scope

- [JAXA's archive announcement](https://www.ir.isas.jaxa.jp/AKARI/Archive/)
  says its primary data server moved to DARTS on **2022-05-18**. The old
  `https://www.ir.isas.jaxa.jp/AKARI/Archive/Images/FIS_AllSkyMap/` returned
  HTTP **404** during this investigation; this is not evidence that the maps
  are unavailable.
- The current [DARTS dataset](https://darts.isas.jaxa.jp/en/datasets/darts:akari-fis-image-allsky-map-2.1/)
  is named version **2.1**, describes N60 (65 µm), WideS (90 µm), WideL
  (140 µm), and N160 (160 µm), and links its actual distribution directory.
  [IRSA's overview](https://irsa.ipac.caltech.edu/data/AKARI/overview.html)
  identifies these image maps with DOI **10.26131/IRSA653**; its FIS and IRC
  point-source catalogs are separate datasets, not image footprints.
- The [DARTS README](https://data.darts.isas.jaxa.jp/pub/akari/AKARI-FIS_Image_AllSky_Map_2.1/ReadMe.txt)
  and [IRSA README](https://irsa.ipac.caltech.edu/data/AKARI/documentation/ReadMe.txt)
  are byte-identical and say **Public Release Version 1**. Preserve both the
  source-reported dataset ID and this publication label. Matching documentation
  and native IDs do not establish scientific-byte equivalence between a DARTS
  tar member and an IRSA FITS.
- The repository's `akari / akari-fis / AKARI FIS color coverage` recipe uses
  [CDS/P/AKARI/FIS/Color](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FAKARI%2FFIS%2FColor&get=record&fmt=json):
  red = WideL, green = WideS, blue = N60. **N160 is not a channel of this
  existing color product.** A candidate bound to that product should expose
  those three bands (5,016 science files); a four-band image-map product needs
  its own explicit supported binding.

## Inventory and geometry

The official [region list](https://data.darts.isas.jaxa.jp/pub/akari/AKARI-FIS_Image_AllSky_Map_2.1/region_list.txt)
has **1,672 unique IDs**. Each of the four source-listed DARTS band directories
has exactly 1,672 tar names, whose region IDs match that list with no missing or
extra entries. The README describes 6° × 6° ecliptic maps and separately handled
north/south ecliptic-pole maps. Preserve the listed IDs; do not generate them
from a MOC or an assumed regular longitude grid.

IRSA exposes the image table **`akari.akari_images`** through its
[TAP service](https://irsa.ipac.caltech.edu/TAP/sync).
[Its declared columns](https://irsa.ipac.caltech.edu/TAP/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+column_name%2Cdatatype%2Cunit%2Cdescription+FROM+TAP_SCHEMA.columns+WHERE+table_name%3D%27akari.akari_images%27)
include the stored `fname`, band, file type, HDU, dimensions, WCS parameters,
equinox and four RA/Dec corners; center RA/Dec are explicitly described as
**J2000**. The [live grouped count](https://irsa.ipac.caltech.edu/TAP/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT+band_name%2Cfile_type%2CCOUNT%28%2A%29+AS+n+FROM+akari.akari_images+GROUP+BY+band_name%2Cfile_type)
and four complete HTTP-200 science metadata responses agree with the directory
memberships:

| Band | Science / `fixstripe` | Uncertainty / `sigma` | Coverage / `nscan` + `nsamp` | All files |
| --- | ---: | ---: | ---: | ---: |
| N60 | 1,672 | 1,672 | 3,344 | 6,688 |
| WideS | 1,672 | 1,672 | 3,344 | 6,688 |
| WideL | 1,672 | 1,672 | 3,344 | 6,688 |
| N160 | 1,672 | 1,672 | 3,344 | 6,688 |
| Total | 6,688 | 6,688 | 13,376 | 26,752 |

For **every band**, all 1,672 science rows have unique `fname`, finite centers
and corners, HDU 0, dimensions 1,440 × 1,440, and equinox 2000. There are 1,670
`ELON-TAN / ELAT-TAN` maps plus two `RA---TAN / DEC--TAN` pole maps. Science
filenames match the complete source-listed FITS directory and the JAXA region
IDs exactly. One native region can therefore carry three or four band-specific
file relationships; bands do not create four different sky regions.

Use source WCS/corners with an explicit J2000-to-ICRS normalization. Mark the
resulting footprint **estimated** until the frame and boundary conversion are
validated; rectangular map bounds do not prove every pixel is observed or
scientifically usable. Filename positions are rounded — for example
`l027.47` has WCS `CRVAL1=27.4674282` — so they are not an exact geometry source.
Never derive native files from the color HiPS order-5 grid, or advertise its PNG/
JPEG display tiles as scientific FITS.

## Actual retrieval sources and dated availability

All HTTP observations below were made on **2026-10-06**. Availability checks
cover directory membership and representative files, not HEAD requests for all
26,752 files.

| Source | Region | Source-listed access | Observed status | Use in reverse lookup |
| --- | --- | --- | --- | --- |
| IRSA image archive | US | [N60](https://irsa.ipac.caltech.edu/data/AKARI/images/N60/), [WideS](https://irsa.ipac.caltech.edu/data/AKARI/images/WideS/), [WideL](https://irsa.ipac.caltech.edu/data/AKARI/images/WideL/), [N160](https://irsa.ipac.caltech.edu/data/AKARI/images/N160/) | All four listings HTTP 200; each lists 6,688 individual `.fits` files | Individual whole FITS or its band directory; public, anonymous access |
| JAXA DARTS distribution | JP | [Official download root](https://data.darts.isas.jaxa.jp/pub/akari/AKARI-FIS_Image_AllSky_Map_2.1/) and its four band directories | Root, README, region list and all band listings HTTP 200 | Preserve source identity and provenance; the advertised products are `.tar` bundles, so do not substitute them for the user's requested individual-file source |
| CDS and its listed HiPS mirrors | FR | Source record above | CDS record HTTP 200; native science-file mirroring was not established | Display provenance only |

IRSA's Atlas-generated download script explicitly supplies whole-file URLs;
the band directory listings independently confirm the same names. Joining the
published IRSA root to the stored `fname` gives:

```text
https://irsa.ipac.caltech.edu/data/AKARI/{fname}
fname = images/{band}/{regionID}_{band}_fixstripe.fits
```

The scientific type is `fixstripe`; associated listed types are `sigma`,
`nscan`, and `nsamp`. Honor the actual stored name and compression rather than
the README's generic `.fits.gz` example. HEAD requests at **01:51 UTC** for
`l027.47_b+35.00_ecl_6deg` in all four bands returned **200**,
`Content-Type: image/x-fits`, **8,305,920 bytes**, and `Accept-Ranges: bytes`.
One checked example is
[the WideS whole map](https://irsa.ipac.caltech.edu/data/AKARI/images/WideS/l027.47_b+35.00_ecl_6deg_WideS_fixstripe.fits).

## Reproducible acquisition and frozen metadata

Use `REQUEST=doQuery`, `LANG=ADQL`, `FORMAT=csv`, `MAXREC=2000` at the TAP sync
endpoint above, once for each literal band (`N60`, `WideS`, `WideL`, `N160`):

```sql
SELECT cntr,fname,band_name,file_type,ra,dec,equinox,naxis1,naxis2,
       ctype1,ctype2,crval1,crval2,crpix1,crpix2,cdelt1,cdelt2,crota2,
       ra1,dec1,ra2,dec2,ra3,dec3,ra4,dec4,hdu,access_estsize
FROM akari.akari_images
WHERE file_type='science' AND band_name='{band}'
ORDER BY cntr
```

Each response contains all 1,672 advertised science rows, below `MAXREC`; the
scope is the complete published per-band map inventory, not a cone-search
sample. Recheck grouped counts and directory membership before calling a staged
snapshot complete. If the source grows, use stable `cntr` pagination and retain
overflow/failure status. A diagnostic `SELECT TOP 5 *` and one Atlas `mode=PI`
request timed out; the explicit-column acquisitions above succeeded.

| Frozen response | Bytes | SHA-256 |
| --- | ---: | --- |
| DARTS `region_list.txt` | 75,286 | `2947f90d944a2513152c538ebb9c2e03e694789041618e72177c7150f9733243` |
| DARTS / IRSA `ReadMe.txt` | 3,306 | `6f8cec043c31a5798c042fb3418e48bd3745703855730ae0f04b8fcb59f4f591` |
| IRSA science N60 CSV | 697,077 | `e336605b1dbc142c3c71afe2ddb5e0e8c5b8d778545debbbbe703fa2ae76f1c9` |
| IRSA science WideS CSV | 708,242 | `eca01e5da9cb632626e757e9cba74ba7154a8f9461e865b33dad8fffba9eabc4` |
| IRSA science WideL CSV | 709,072 | `e15f67d7538756ca25ab125426bd0d164de86c0b91d5b44e00f15158f5a65096` |
| IRSA science N160 CSV | 704,056 | `4a5d50de286ae21b02f268eb9123833c8d41332b2ae1cbcb3ce08ad3a7b37df7` |

Diagnostic metadata, full listing responses, effective request URLs, HTTP
headers, and membership checks are under
`/tmp/assets-akari-native-research-20261006/`; those temporary files are not
managed evidence. The next implementation step is to stage and import supported
metadata through native-unit management, archive its dependencies, review a
candidate with the chosen product scope and precision, then verify activation.
This investigation made no management, runtime, deployment or handoff changes.
