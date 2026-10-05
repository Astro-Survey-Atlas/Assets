# Phase 2 native sky-unit candidates, researched 2026-10-04; updated 2026-10-05

This note preserves the source research and the original candidate ranking.
Its task and active-index snapshots below are historical; the authoritative
current state and next operations are in [HANDOFF](../../HANDOFF.md). A later
recheck adds DES DR2 full-Tile geometry and a bounded SPHEREx observation
capture; see [next-survey recheck](phase2-next-survey-rescan-20261005.md).

The original practical candidates were **VVV DR4 image Tiles**, **SPHEREx QR2
observation/detector images**, and **SkyMapper DR4 exposure/CCD units**. Each
has an official identity and footprint source. Their access and inventory
limitations differ; none should be presented as a complete survey inventory.

## Dev identities and baseline ranking (2026-10-05)

The public Dev `/api/v1/coverage/catalog` returned 132 layers. These six
survey groups contain **28 products**. Their native mappings were
`sourceUnitIndex.status=entrypoint-only` at the time of this research. Runtime
published product/layer IDs must be used; working registry names are not a
substitute for the published identities.

| Rank | Existing published release/products | Native roster/geometry | Access supported by the source | Acquisition/import assessment |
| --- | --- | --- | --- | --- |
| 1 | `vista-vvv-dr4`: H bulge, H disk, J, Y, Z, J/Y/Z color (6) | Official Tile IDs; ESO image-level polygons and exact file identities | ESO DataLink supplies the requested image and associated file URLs | The 2026-10-04 incremental capture is imported; a 23-input/70-binding candidate passed 163 checks and was reviewed. Remote archive upload/verification is running. This is not the cumulative DR4 inventory |
| 2 | `spherex-qr2`: color + D1–D6 (7) | Official SIA observation IDs, footprints and file URLs; detector identity in native filenames | Exact IRSA files and official AWS mirror with identical relative paths | Sample file HEADs passed on 2026-10-04. Both SIA and TAP metadata queries returned HTTP 502 again on 2026-10-05; no snapshot is available to import |
| 3 | `skymapper-dr4`: g/r/i color footprint (1) | Live TAP `dr4.ccds` has image ID, CCD, ICRS polygon and filter; bounded 2014-03-15 to 18 query captured 5,666 rows in two keyset pages | SIAP yields actual 5-arcmin FITS cutouts, not complete CCD files; one matching bounded-scope cutout passed HEAD | Capture is ready for managed import after VVV activation. `inventoryComplete=false`; this is a three-day increment, not all DR4 |
| 4 | `des-dr2`: color + g/r/i/z/Y (6) | Live SIA exposes real Tile names and files; this probe supplied no polygon/WCS | Official Data Lab cutout URLs; NCSA DR2 directories were unreachable from this environment | A useful release-specific metadata source exists; full footprint and native-file resolution remain prerequisites for a managed Tile index |
| 5 | `2mass-6x`: J/H/K imaging (3) | Official scan/Atlas-image identities and metadata services; directory membership available | Official `sixxcat`/`sixxfull` image directory trees | Directory acquisition works, but IBE/TAP probes returned 502. Need an image-footprint inventory, not only scan centers or Tile numbers |
| 6 | `ztf-dr7`: color + g/r/i (4) | Official field/CCD/quadrant image footprints and URI rules exist | Explicit image URLs, subject to public/proprietary status | Old DR7 inventory is the blocker: only the last five releases are available through the current official UI/API; current reference images cannot establish a frozen DR7 inventory |

## Historical Phase 2 task snapshot (superseded by HANDOFF)

The VVV evidence is in
`/home/aaron/.local/share/astro-assets-deployments/dev/20261004-vvv-dr4-capture4/`;
the backend evidence PVC copy is under
`/var/lib/assets-evidence/managed/native-units/inputs/vista-vvv-dr4-capture4/`.
The official TAP pagination and DataLink responses are SHA-locked in the
manifest. The managed row input contains 11,239 image rows for 348 Tile IDs;
213 non-Tile calibration targets remain in the original 11,452-row TAP evidence
and are intentionally excluded from the spatial index. The H/J/Y/Z DataLink
responses provide 1,513 single-file identities. No science data was fetched.
`inventoryComplete=false`; direct-file availability is unverified and J2000
image-frame polygons transformed to ICRS remain estimated without pixel masks.

The import task `native-mutzul7h-6c98db1b` completed. Build task
`native-mutzv10p-2d6b4315` completed a combined candidate with 23 inputs and
70 product bindings, including the previous 22-input/64-binding active group
plus six VVV bindings. All 163 checks passed and review accepted the declared
gaps. Candidate group is
`a59a319606857538b9c24fb1109927496cba232709230ab78f5e89e089307d82`.
Archive task `native-muu1oyri-5d41e766` is uploading the compressed 328,131,475
byte survey SQLite; remote verification has not started. Dev remains on
generation 3 until archive and activation pass.

SkyMapper's exact bounded query has now completed. Capture directory:
`/home/aaron/.local/share/astro-assets-deployments/dev/20261005-skymapper-dr4-capture1/`.
The manifest SHA-256 is `50e6e6b83f834f93ea422cd1dcba61086dc93cf455f662d74e761a6d8492547f`; its
compressed normalized row file SHA-256 is `0fb90eb3a01b8428d8c502995f9cd35be11de87220e1f719266763e35ddf7be8`
(495,524 bytes, 5,666 rows). The official count and both ordered TAP pages returned HTTP 200 / `QUERY_STATUS=OK`;
page sizes are 5,000 and 666. The captured keys run from `(20140315153115, 1)` through `(20140317185942, 32)`.
The manifest records `sourcePagination.expectedRowCount=5666`, `queryPagesComplete=true`, and
`inventoryComplete=false`. No FITS/science data was downloaded.

The adapter, source definition, and locked import contract are implemented and covered by four Python
acquisition tests plus a TypeScript index test. A real in-scope CCD cutout for `20140315153115-01`
returned HTTP 200, `image/fits`, 748,800 bytes at the official SIAP endpoint. It is a fixed five-arcmin
cutout around the CCD center, not the full CCD or arbitrary selected sky region; only this representative
URL was checked. Do not describe all per-unit cutouts as individually verified or submit the SkyMapper
import until the VVV archive/activation task finishes.

## VISTA: VVV DR4 is usable, but cumulative membership matters

ESO's [VVV DR4 release description](https://www.eso.org/rm/api/v1/public/releaseDescriptions/80)
identifies the release, gives bulge/disk Tile IDs and J2000 centers, and describes
**348 Tiles**. It says the DR4 submission adds **11,452 tile images** to the
**18,011 in DR3**. A Tile may have many observation epochs and files. Return
`bNNN`/`dNNN` as the native Tile and retain each file's distinct `dp_id`, band,
observation identity, source filename and release reference.

The live [ESO ObsCore TAP service](https://archive.eso.org/tap_obs/) returned
`target_name`, `filter`, `dp_id`, `obs_creator_did`, `obs_id`, `s_region`,
`access_url` and `release_description`. This exact filter isolates the DR4
submission without mixing in later VVV/VVVx or catalogue/variability releases:

```sql
SELECT dp_id, target_name, filter, obs_id, obs_creator_did,
       s_region, access_url, release_description
FROM ivoa.ObsCore
WHERE obs_collection = 'VVV'
  AND release_description =
      'https://www.eso.org/rm/api/v1/public/releaseDescriptions/80'
  AND dataproduct_type = 'image'
```

A live grouped query returned Ks **9,726**, Z **489**, Y **486**, J **372** and
H **379**, summing to **11,452**. Thus there are **1,726** image metadata rows in
the four bands relevant to the existing Dev products. This is a promising small
first input; it is the DR4 **increment**, not all images available by DR4.
For a cumulative input, explicitly identify and freeze the earlier submissions
described by DR4; do not select all present-day `obs_collection='VVV'` rows.

An actual J-band row is Tile `d104`, file ID
`ADP.2016-05-25T15:33:38.726`, source filename
`v20140402_00373_st_tl.fits.fz`. Its polygon is recorded as **J2000**, not ICRS.
Retain the original coordinate declaration and normalize the supported frame
before labelling the managed geometry ICRS; frame bounds remain estimated
without valid-pixel masks.

For the separately probed Ks file `ADP.2016-05-25T15:33:36.267`,
[DataLink](https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?ADP.2016-05-25T15:33:36.267)
returned HTTP 200 and an explicit `semantics=#this` link to
[`https://dataportal.eso.org/dataPortal/file/ADP.2016-05-25T15:33:36.267`](https://dataportal.eso.org/dataPortal/file/ADP.2016-05-25T15:33:36.267).
It also identifies weight maps, provenance and derived catalogues separately.
The file HEAD timed out after 22 seconds; preserve this as an unverified access
check, rather than converting the metadata-listed file to a verified download.
DataLink should be resolved during metadata acquisition, with each returned
link's semantics retained; a catalogue or progenitor is not the matched image.

The separate Dev `viking` J product (`8cdeedbe0a9dbfe93f5d`) needs its own
release-membership audit. A live VIKING J row had
`target_name=vikingJYZ_gama09_1_2_8`, an image ID and a 16-polygon `UNION J2000`
footprint. This is useful observation geometry, but does not by itself establish
a VIKING Tile grid or the release scope underlying the published product. Do
not reuse VVV Tile identities or assume every VIKING target string is a Tile.

## SPHEREx QR2: exact files and an official mirror

The official [release overview](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html)
distinguishes QR2 from QR3 and says QR2 is still accessible. The
[archive data-access guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
documents SIA2 at `https://irsa.ipac.caltech.edu/SIA`, with collections
`spherex_qr2` and `spherex_qr2_deep`, and browsable native directories. The
[first-party tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/)
shows returned `obs_id`, `s_region`, `obs_publisher_did`, `access_url` and
`cloud_access` fields. Freeze the wide/deep collection choices and capture date;
weekly ingestion and its SIA delay make the current archive a moving inventory.

The [product guide](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
defines six detector images per pointing and warns that some observations omit
bands after quality assessment. Use observation + detector + original file
identity. A survey-plan period alone is not a sky partition, and a footprint
does not prove every spectral channel is measured at every sky position.
For the existing D1–D6 products, require the actual detector metadata; the
color product can group matched images without inventing a color science file.

The documented relative organization is
`qr2/level2/<planning-period>/l2b-v<version>-<processing-date>/<detector>/<file>`.
Prefer the source's `access_url` over recreating a filename: the guide's displayed
template and real examples differ in underscore/hyphen punctuation.

The [official cloud page](https://irsa.ipac.caltech.edu/cloud_access/#spherex)
names bucket `nasa-irsa-spherex`, region `us-east-1`, prefix `qr2/level2`, and
its [browser directory](https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/index.html).
The source guide states that the AWS copy mirrors the on-premise directories.
Both of these same-file URLs passed HEAD with **71,634,240 bytes**:

- [IRSA QR2 file](https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/2025W43_1A/l2b-v20-2025-299/5/level2_2025W43_1A_0516_1D5_spx_l2b-v20-2025-299.fits).
- [AWS QR2 mirror file](https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr2/level2/2025W43_1A/l2b-v20-2025-299/5/level2_2025W43_1A_0516_1D5_spx_l2b-v20-2025-299.fits).

These are per-file access checks only; no scientific bytes or checksums were
verified. This session's bounded SIA and TAP probes returned HTTP 502, while
the documentation and native file HEADs worked. Source metadata must be
acquired successfully before constructing the managed local footprint index.

## SkyMapper DR4: actual CCD geometry, cutout access

[ANU's official access instructions](https://skymapper.anu.edu.au/how-to-access/)
document the [public TAP service](https://api.skymapper.nci.org.au/public/tap/),
`TAP_SCHEMA`, and the DR4 SIAP service. Live schema and two-row queries passed.
`dr4.ccds` exposes `image_id`, `ccd`, `filter`, `filename`, `coverage` and
`header`; `coverage` is an actual `POLYGON ICRS`. `dr4.images` adds `field_id`,
exposure metadata and quality, joined by `image_id`. `dr4.mosaic` gives CCD
positions within the instrument; it is not an observed sky inventory.

Example: `image_id=20140315153115`, CCD `1`, filter `g`, file
`56731/01/Skymapper_1206517766_2014-03-16T02:31:00_01_red.fits`, with its own
ICRS polygon. Use `(image_id, ccd)` as the native unit, retaining `field_id` as
an additional identity. A field alone does not identify its observed images.

The [documented SIAP query](https://api.skymapper.nci.org.au/public/siap/dr4/query?POS=189.99763,-11.62305&SIZE=0.05&BAND=g,r,i&FORMAT=image/fits&VERB=3&INTERSECT=OVERLAPS)
returned **46 metadata rows**. Each retains a `unique_image_id` such as
`20140425124821-10`, and explicit `get_fits`/`get_mask` URLs with image,
position and size parameters. Those URLs retrieve **cutouts**, not complete
native CCD files. The instructions limit cutouts to less than 10 arcmin per
side; they cannot represent a larger arbitrary Assets component. A `filename`
in TAP is not proof of a public full-file URL. Preserve the unit and link to
the honest image-access entrypoint until full CCD access is established.

A TAP request naming `field_id` on `dr4.ccds` fails with `Unknown column`;
`field_id` belongs to `dr4.images`, not the CCD table. With the actual CCD
schema, live `TOP 10`/`TOP 15` queries over `image_id, ccd, filter, filename,
coverage` returned successful ICRS polygons in 21 ms and 134 ms. A composite
keyset continuation `(image_id > cursor_id OR (image_id = cursor_id AND ccd >
cursor_ccd))`, ordered by `(image_id, ccd)`, returned the next CCD rows in 20 ms.
The initial global and year-bounded count probes returned VOTable
`QUERY_STATUS=ERROR` due to timeout. On 2026-10-05, the narrower locked
three-day interval completed its bounded count and full keyset capture: 5,666
rows across two pages. Earlier TOP 10/15/page latency measurements remain
diagnostics only; do not extrapolate the three-day capture to complete DR4.

The documented SIAP query returned 46 metadata rows. Each retains a
`unique_image_id` such as `20140425124821-10` and explicit `get_fits`/`get_mask`
URLs. A matching cutout URL generated for the captured CCD `20140315153115-01`
passed `HEAD` on 2026-10-05: HTTP 200, `image/fits`, 748,800 bytes. This is an
actual downloadable region cutout, not the complete CCD file. Preserve cutout
semantics and do not label it as a full native CCD download. The captured
bounded pages use stable `(image_id, ccd)` ordering, reject duplicate keys and
record the terminal page and expected row count. The published color product
should select g/r/i records and label their actual filters, not manufacture an
RGB file or assume a common footprint for all three bands.

## DES DR2: usable official lookup, incomplete geometry in this probe

[NOIRLab's DES description](https://datalab.noirlab.edu/data/dark-energy-survey)
documents **10,169** DR2 coadd Tiles. Its DR2 TAP schema exposes coverage and
object tables but no `tile_info`; `des_dr1.tile_info` belongs to DR1 and cannot
be substituted for DR2 membership.

NOIRLab's [official SIA notebook](https://github.com/astro-datalab/notebooks-latest/blob/master/04_HowTos/SiaService/How_to_use_the_Simple_Image_Access_service.ipynb)
explicitly lists `https://datalab.noirlab.edu/sia/des_dr2` and the separate
single-exposure collection `des_dr2_se`. A small
[DR2 query](https://datalab.noirlab.edu/sia/des_dr2?POS=25,-45&SIZE=0.02&VERB=3)
returned HTTP 200, **33 metadata rows**, `object=DES0139-4457`,
`obs_collection=DES DR2`, band and full source file identities such as
`DES0139-4457_r4920p02_g.fits.fz`. `obs_id=des_dr2` is the collection name,
not a unique native observation ID; use the real Tile and file identity.
Rows include multiple FITS extensions and the detection image, so row count
is not a count of unique Tiles or science images.

The returned `access_url` is a documented cutout URL. Both VERB 2 and 3
responses lacked `s_region` and usable WCS; a center, dimensions and pixel
scale do not establish a verified native footprint. The
[Astro Data Archive API](https://astroarchive.noirlab.edu/api/docs/)
offers metadata/header/file methods, but its header lookup for this coadd
filename returned 404. This does not establish that the NCSA image is absent.
NCSA's [DR2 release page](https://des.ncsa.illinois.edu/releases/dr2) and
`desdr-server.ncsa.illinois.edu` directory probes timed out. Obtain a real DR2
Tile roster/full WCS and published native-file access contract before import;
retain the functioning Data Lab entrypoint and the source check failures.

## 2MASS 6X: use Atlas images and scans, not bare Tile numbers

The [official 6X overview](https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/doc/seca3_1.html)
describes targeted long-exposure observations, their image atlas and source
catalogues. The [cautionary notes](https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/doc/seca3_1d.html#6xatlas)
warn that Tile numbers were incorrectly duplicated for scans in Chameleon 2
and Hydra that cover different sky. Therefore a bare Tile number is not a
safe unique spatial identity. Use source Atlas-image identity plus hemisphere,
observation date, scan, coadd and band; retain the original scan association.
The [scan metadata schema](https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/doc/seca3_3c.html)
is a useful supplemental source, but scan centers alone are not image bounds.

Official [catalogue-release image directories](https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/)
and [full 6X image directories](https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxfull/)
were accessible. The checked tree includes real date/hemisphere directory
`000325n/` and scan directories `s034/` and `s035/`. Use these rosters or returned
archive file paths, keeping selected/catalogue-release versus full scan scope
distinct. Do not reuse the 2MASS All-Sky inventory for the three Dev 6X products.
The corresponding IBE metadata probes returned 502; a complete usable image
footprint roster, per-band membership and URI rules remain to be captured.

## ZTF DR7: keep native rules, resolve the old-release inventory

The [official API guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_api.html)
provides raw/science/reference queries, ICRS image-corner geometry and public
versus proprietary access. The [metadata guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_metadata.html)
gives exact paths from `field`, `ccdid`, `qid`, `filtercode` and date/processing
fields. Science identity is exposure + field/CCD/quadrant + band; reference
identity also requires its real processing version. A field grid cannot prove
that a release-specific image exists.

The [official release list](https://irsa.ipac.caltech.edu/data/ZTF/docs/ztf_data_releases.txt)
states that releases are cumulative and only the **last five** are accessible
through the current UI/API. The retained
[DR7 notes](https://irsa.ipac.caltech.edu/data/ZTF/docs/releases/dr07/ztf_release_notes_dr07.pdf)
describe different date/program selectors: public program 1 in g/r through
MJD **59396**, and programs 2/3 in g/r/i through MJD **58908**, both starting
at MJD **58194**. They also say reference images are continually updated and
can include good-quality exposures irrespective of those date ranges.
These selectors may guide an explicitly scoped historical-exposure acquisition,
but do not reconstruct the old processing or reference-image inventory.

Do not bind current reference rows or the latest release to `ztf-dr7` silently.
First obtain an authoritative DR7 inventory/processing snapshot, or publish a
separate current release through the supported product workflow. Retain the
documented access entrypoint meanwhile.

## Managed import requirements for the first addition

Acquisition must capture original metadata pages, actual query/scope,
capture date, terminal/overflow/error status and SHA-256, with normalized native
IDs and source URIs. A new adapter format must enter the authenticated
`import → candidate build → validation → review → dependency archive → activation`
workflow in [native unit management](../native-unit-management.md). Keep the
installed version and the existing public products/MOCs intact while building
the candidate.

For each result retain original footprint/frame, selected band, native identity,
real input scope, source snapshot SHA and precision. Record exact source files,
listed DataLink files, rule-derived mirrors, cutouts and query entrypoints as
their actual link types with per-source availability. Successful HEAD or
metadata pagination does not establish complete scientific inventory or valid
pixel coverage. The VVV input is imported and its candidate is in progress as
described above; the other candidates in this note have not been imported or
activated.
