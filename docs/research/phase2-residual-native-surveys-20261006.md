# Residual native survey sources, checked 2026-10-06

**DECaLS DR5 can reuse a real, locked brick inventory if its binding explicitly
means the official mixed-program DR5 coadd release. Rubin First Look now has a
small, recoverable two-image source with actual download URLs and embedded AVM
astrometry. IPHAS has a recoverable author-owned image-metadata precursor.**
The other four survey releases still lack a defensible, accessible native
inventory in this environment.

This is a research result, not an installed or activated index. It extends
[the remaining-candidate audit](phase2-remaining-native-unit-candidates-20261006.md)
and [the DECaLS/AllWISE audit](phase2-uncovered-native-unit-candidates-20261005.md)
without changing them. No code, management state, evidence PVC, public release,
MOC, 72602 or Workspace was changed. Only this note was added. Scientific image
payloads were not downloaded: file availability checks used HEAD; the Rubin
checks read only structurally identified BigTIFF header, IFD and XMP metadata
with validated HTTP 206 byte ranges. IPHAS ranges contain a metadata BINTABLE,
not image pixels.

## What can be captured now

| Catalog release | Source and bounded/full scope | Native identity and access | Remaining qualification / next step |
| --- | --- | --- | --- |
| `decals-dr5` | Existing locked official DR5 roster: 176,811 bricks; source HEAD 200 | Brick + band; actual NERSC directory and g/r/z image HEADs 200 | Bind explicitly to official mixed-program DR5 coadds. A DECaLS-program-only inventory needs additional exposure provenance. |
| `rubin-firstlook` | Exactly the two original NOIRLab TIFFs used by the current CDS First Look layer; both have readable AVM metadata | Publisher image ID `noirlab2521a` / `noirlab2521b`; whole TIFF links HEAD 200 | Capture the two XMP/IFD receipts, validate AVM coordinate conventions, then import as estimated **outreach image** frames. This does not establish scientific DP1 or all Rubin inventory. |
| `iphas-dr2` | A pinned 268,185-row pipeline image-metadata precursor is readable; sampled DR2-recalibrated rows are real | Run + CCD, separate band; author-defined whole-image path | Capture with declared precursor/recalibration scope, reject corrupt/duplicate identities, and keep `inventoryComplete=false`. Final QC/release reconciliation and image availability remain unresolved. |
| `nvss-final` | No current native roster captured | Documented 4° mosaic FITS names; original FTP login fails | Restore a source/mirror roster and actual per-map FITS WCS. Do not generate membership from center names. |
| `sumss-final` | No current original-mosaic roster captured | Original 4° mosaic identity; no verified file-path rule recovered | Restore the original image archive or a provenance-preserving native mirror. HiPS pixels are not native mosaics. |
| `wenss-final` | No current original-image roster captured | Original map/mosaic filename; no verified file-path rule recovered | Discover a functioning original-image service and capture its identity/WCS roster. Catalogs and HiPS cannot replace it. |
| `ztf-dr7` | Official current rules and example files work; a frozen DR7 inventory has not been recovered | Science exposure + field/CCD/quadrant/band; reference identity must preserve its actual processing metadata | Recover the authoritative DR7 processing/reference snapshot or introduce a separately reviewed current release. Current metadata must not silently stand in for DR7. |

An importable source is not automatically complete or active. Any later addition
must use [managed import → build → review → archive → Dev activation](../native-unit-management.md),
preserve existing bindings, and report source coverage, geometry precision and
link availability independently. A successful single-file HEAD is not a global
availability check.

## DECaLS DR5: available bricks, explicit release semantics

The [official DR5 description](https://www.legacysurvey.org/dr5/description/)
returned HTTP 200. It again states **176,811 bricks** and explicitly includes
DECam observations from **non-DECaLS surveys**. The official page itself uses
`layer=decals-dr5` for its viewer examples, so an explicitly described official
DR5 coadd scope is possible; it must not be presented as exclusively observing
program 0404.

The [official files guide](https://www.legacysurvey.org/dr5/files/) returned HTTP
200. It distinguishes geometric `survey-bricks.fits.gz` RA/Dec bounds from the
release-membership `survey-bricks-dr5.fits.gz` summary. The existing local
[source lock](../../src/layers/recipes/source-unit-indexes.lock.json) records
176,811 membership rows, 27,041,967 bytes and SHA-256
`3bddc0adb01612cd4c1003d691a0f5987d5a882ad8353e0efd8e89c8d78a8e44`.
[Roster HEAD](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/survey-bricks-dr5.fits.gz)
returned HTTP 200 with that byte length; this check did not fetch the full
table again.

The [real brick directory](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/coadd/149/1498p020/)
returned HTTP 200 and listed the individual images. Its SHA remains
`a65e90c982fcd7cdfe8a36b72986e4b07eaf587840c2ae9813c56abac459b75d`.
The source-supported rule is:

```text
https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr5/
coadd/<brick[0:3]>/<brick>/legacysurvey-<brick>-image-<band>.fits.fz
```

For `1498p020`, g/r/z HEADs returned HTTP 200 with lengths
10,802,880 / 13,259,520 / 14,690,880 bytes respectively. `.fits.fz` is a
compressed individual image, not a multi-file resource bundle. Geometry must
retain the existing ICRS brick-grid join and distinguish the defined brick
boundary from valid image pixels; source membership and grid bounds do not
verify exposure masks, every band file, or program-only provenance. The
color product may point to its actual g/r/z files or their parent directory;
there is no basis for inventing a single color FITS file.

**Next:** reuse the existing reviewed DR5 source under an explicit mixed-program
binding. If a DECaLS-program-only scope is required, obtain accepted CCD and
program provenance and reconcile contributions per brick first, as described
in the earlier audit.

## Rubin First Look: two real public original images and their AVM

The [exact CDS source record](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FRubin%2FFirstLook&get=record&fmt=json)
returned HTTP 200, 2,321 bytes, SHA-256
`93e62dc483ef4234617575788ab239482461b525cc532357e9586fb067c3f8f4`, matching the
existing recipe. It explicitly identifies two fullsize original TIFFs used
to build the First Look HiPS, covering about 29 square degrees: **The Cosmic
Treasure Chest** and **The Trifid and Lagoon Nebulae**. This record is provenance
for the display layer, not a scientific exposure inventory.

Both publisher-owned whole-file paths are real and returned HEAD HTTP 200:

| Publisher identity / actual file | Bytes | IFD image dimensions | XMP range, inclusive | XMP SHA-256 |
| --- | ---: | --- | --- | --- |
| [`noirlab2521a.tif`](https://storage.noirlab.edu/media/archives/images/original/noirlab2521a.tif) | 15,142,805,372 | 97,943 × 51,536 | 524–26,612, 26,089 bytes | `2434a33aab3fa183b284cb332b503b9d9bfe53f7acc48cec13e58e6df92c1d04` |
| [`noirlab2521b.tif`](https://storage.noirlab.edu/media/archives/images/original/noirlab2521b.tif) | 25,956,028,716 | 84,000 × 51,500 | 524–20,743, 20,220 bytes | `9bc9699803579fb8b2fb0a6ca3c1ad13f9ac6e368c65d42f7c06d5c6173f8930` |

The official image pages are
[noirlab2521a](https://noirlab.edu/public/images/noirlab2521a/) and
[noirlab2521b](https://noirlab.edu/public/images/noirlab2521b/). Their page GETs
timed out here, but the publisher CDN metadata is reachable and identifies
those same reference pages, publisher, resource IDs and whole-file URLs.

The TIFFs are little-endian **BigTIFF**, magic 43, with first IFD at byte 16
and 22 entries. Read ranges were only `0–7`, `8–15`, `16–23`, `24–463`, and
the XMP tag-700 ranges above. Each response was validated as HTTP 206 with
the exact Content-Range before reading its body. Image strip payloads start
at byte **33,982** for a and **28,670** for b; none of those payload bytes
was requested or read.

The embedded primary-source AVM values are:

| AVM field | `noirlab2521a` | `noirlab2521b` |
| --- | --- | --- |
| `Spatial.CoordinateFrame` / `Spatial.Equinox` | ICRS / J2000 | ICRS / J2000 |
| `Spatial.CoordsystemProjection` | TAN | TAN |
| `Spatial.ReferenceValue` (degrees) | `[186.368524202294, 6.930215747979968]` | `[271.6317360235022, -23.762469026534358]` |
| `Spatial.ReferenceDimension` | `[97943, 51536]` | `[84000, 51500]` |
| `Spatial.ReferencePixel` | `[48971.5, 25768]` | `[42000, 25750]` |
| `Spatial.Scale` (degrees/pixel) | `[-5.55399208524905e-5, 5.55399208524905e-5]` | `[-5.553994996501517e-5, 5.553994996501517e-5]` |
| `Spatial.Rotation` (degrees) | `48.96` | `-12` |
| `Spatial.Quality` | **Position** | **Position** |
| `MetadataDate` | `2025-06-20T13:52:29.896213` | `2025-06-20T13:52:29.672687` |

The dimension fields match the actual IFD width/height. The AVM includes
additional WCS notes, but the declared quality is **Position**, not a claim
of a verified scientific astrometric solution. An adapter must respect AVM
reference-pixel, rotation and axis conventions and label the resulting
frame footprint **estimated**. Valid-pixel boundaries, holes, individual
contributing exposures and per-filter scientific files were not checked.

**Next:** the smallest genuinely new capture is these two IFD/XMP metadata
snapshots plus the exact CDS provenance record. Bind the existing First Look
product to two original **outreach image** identities with actual TIFF links
and estimated per-image footprints after coordinate-convention validation.
That completes only the declared two-image provenance roster, not Rubin's
scientific inventory.

[DP1 documentation](https://dp1.lsst.io/) and its
[access guide](https://dp1.lsst.io/access/index.html) timed out in this recheck.
The earlier audit established separate Rubin data-rights/SIA/Butler access.
Do not map a DP1 observation, visit/detector, tract/patch or guessed object-store
path to this First Look product. The new finding is about the existing public
TIFF product and its own primary metadata.

## IPHAS DR2: recoverable precursor, incomplete final-release evidence

The release author's pinned
[repository README](https://github.com/barentsen/iphas-dr2/blob/e2e47c6964df6bb5fe9909e317ef18f0913698db/README.rst)
identifies this as the source used to produce IPHAS DR2. Its
[image-preparation code](https://github.com/barentsen/iphas-dr2/blob/e2e47c6964df6bb5fe9909e317ef18f0913698db/dr2/images.py)
and [final-index augmentation](https://github.com/barentsen/iphas-dr2/blob/e2e47c6964df6bb5fe9909e317ef18f0913698db/scripts/release-preparation/augment-image-metadata.py)
returned HTTP 200. Their SHA-256 hashes are respectively
`94dec500e5a9e77e294b730ac83a69a36aad04b8e770588fe20f03a5d07c77b8` and
`e9142f6e8e0c1043c93fb4bfbb4ef3ac93e25f7575d6c2b4bec4215e7e511425`.

The new recoverable input is
[`iphas-images-pipeline.fits`](https://raw.githubusercontent.com/barentsen/iphas-dr2/e2e47c6964df6bb5fe9909e317ef18f0913698db/scripts/release-preparation/iphas-images-pipeline.fits).
The pinned Git tree identifies blob `03ea74de6ac7d0c169d8fd7890748465e5b3bd48`,
63,570,240 bytes. HEAD returned HTTP 200. A strict metadata-only HTTP 206
range `0–17,279` decoded a NAXIS=0 primary HDU and a BINTABLE with **268,185
rows**, 237 bytes/row, 20 columns, data beginning at byte 8,640. The prefix
SHA-256 is `561326390eb62993f8f22bfa7c85bf345f01e358afb1f0235e7d7563abb3c083`;
it is a prefix hash, not a full-file SHA. The full file was not acquired here.

Columns include filename, run, CCD, `in_dr2`, band, UTC start, center, RA/Dec
bounds and calibration/image-quality metadata. The author code sets
`RADESYS=ICRS`, ZPN projection, applies known WCS fixes and derives bounds
from the four CCD corners. RA wrap is represented by allowing `ra_max > 360`;
for example the first H-alpha CCD crosses zero RA. Bounds are therefore
**estimated image-frame bounds**, not an exact valid-pixel mask or a guarantee
that four sampled corners trace every curved ZPN edge.

The native unit is **run + CCD**, with band kept separately. The `r` in
`r<run>-<ccd>.fits.fz` is a filename prefix, not proof of an r-band image.
The author's final-index code explicitly constructs:

```text
http://www.iphas.org/data/images/<filename[0:4]>/<filename>
```

A second strict range `2,378,640–2,390,015` inspected rows 10,000–10,047:
40 have `in_dr2=true` and 8 `false`. Representative row 10,000 is
`r375643-1.fits.fz`, run 375643, CCD 1, H-alpha, center
`[40.68416590173798, 56.22358397750068]`, bounds
`[40.34307304889804, 41.02527536218735, 56.12732988220369, 56.32031808508418]`.
The range SHA is
`d45bd0273080293347f2207f3c827a41ff42a51b40c3a89abed498b5856f87b8`.
Both source-defined HTTP and separately probed HTTPS forms of
`www.iphas.org/data/images/r375/r375643-1.fits.fz` timed out during HEAD.
They must not be marked available. Some FITS strings are NUL-padded; a parser
must decode FITS strings correctly instead of comparing literal `true\0`
or treating NUL bytes as part of a band/filename.

The code explains that `in_dr2` identifies DR2 **recalibration** membership
via the calibration database. It is not, by itself, the entire final catalog
quality/release selector. The final-index augmentation removes corrupt run
376022 and extra duplicate run-367744 rows, and adds field IDs and QC from
an auxiliary IPHAS-QC table. The author-owned
[QC repository](https://github.com/barentsen/iphas-qc) currently exposes
`qcdata/iphas-qc.fits`, but its moving tree has not been reconciled to the
DR2 snapshot; it must not silently provide final-release completeness.

`https://www.iphas.org/data/` returned HTTP 403; the attempted historical
index location `https://www.iphas.org/data/images/iphas-images.fits.gz`
returned HEAD 404. That failed index location does not invalidate the
reachable pinned precursor. IGAPS remains a separate release/survey scope.

**Next:** capture the pinned precursor with a full SHA, preserve its declared
scope, parse the official recalibration flag, reject corrupt identities and
deduplicate run/CCD while keeping exclusion evidence. A bounded native
mapping can retain known image identities and source-rule paths with failed
or unverified availability and `inventoryComplete=false`. Establish final
QC/DR2 inventory membership and a functioning image archive separately before
claiming a complete, downloadable DR2 inventory.

## NVSS: documented mosaics, original FTP still rejects access

The earlier audit of [NRAO's native survey description](https://www.cv.nrao.edu/nvss/)
and [download instructions](https://www.cv.nrao.edu/nvss/anonftp.shtml) records
2,326 4° × 4° mosaics and original archive
`ftp://ftp.cv.nrao.edu/pub/nvss/MAPS/`. Examples are `C2230P84.gz`, an I/Q/U
cube, and `I0224M32.gz`, I-only, named by J2000 center. These are individual
gzip-compressed FITS maps, not multi-file packages.

In this recheck the NRAO HTTPS documents and exploratory HTTPS translations
of those two MAPS paths timed out. Those HTTPS translations have not been
established as a supported mirror rule. Direct anonymous FTP again returned
**`530-Unable to set anonymous privileges. 530 Login incorrect.`** before any
listing or data transfer. The documented
[Cambridge mirror landing](https://www.mrao.cam.ac.uk/surveys/nvss/)
returned HTTP 404.

**No native inventory can be captured from the checked routes now.** A known
center naming convention does not establish actual release membership. Recover
a real listing/mirror and each map's original FITS WCS, confirm its frame
explicitly and transform to ICRS when required; “J2000” alone does not prove
ICRS. Any WCS-frame footprint is estimated until valid-pixel coverage is
verified. Preserve the documented source identity and failures meanwhile.

## SUMSS: original archive recovery is still needed

The historical first-party [Sydney landing](https://www.astrop.physics.usyd.edu.au/SUMSS/),
`/SUMSS/MOSAICS/`, and the alternate
[Sydney provenance page](https://www.physics.usyd.edu.au/sifa/Main/SUMSS)
all timed out in this recheck. `ftp.astrop.physics.usyd.edu.au` did not resolve.

The [CDS HiPS provenance](https://alasky.cds.unistra.fr/SUMSS/properties)
returned HTTP 200 with SHA
`7b2e89fcfec0858c69eba90d57dfbbf4db43a23c22afa1b6a391a977f89c5ed9`.
It describes original 4° × 4° mosaics from up to 17 observations and identifies
the historical Sydney source. This establishes the display source's recorded
provenance, not an independent original-mosaic roster. Its advertised
`HpxFinder` progenitor route, checked at a position, redirected to a trailing
slash and returned HTTP 403.

**No bounded or complete native inventory was established.** The intended
unit is an original mosaic with its source filename and original WCS, not a
resampled HiPS pixel tile. No usable source-owned filename-to-file path rule
or per-mosaic geometry/frame table was recovered. Next recover the native
archive or a provenance-preserving mirror, capture its actual roster and WCS,
then convert frame metadata to ICRS and label image bounds estimated until
mask coverage is known. Do not derive arbitrary mosaic identities from the
survey-wide MOC.

## WENSS: no verified original-image route in this recheck

The old first-party
[ASTRON image route](https://www.astron.nl/wow/testcode.php?survey=1)
and [current ASTRON service listing](https://vo.astron.nl/__system__/services/root)
timed out here. The Leiden hostname `www.astro.leidenuniv.nl` failed DNS
resolution. These are local, dated access observations; they do not prove
that the original WENSS images no longer exist.

[CDS's WENSS properties](https://alasky.cds.unistra.fr/WENSS/properties)
returned HTTP 200, SHA
`d75d5f10994ad74fbaf014c707cc901689bc92de572951fbfc84fd19ca757b28`, and retain
the ASTRON origin for the 325-MHz display product. The linked
[HEASARC catalog documentation](https://heasarc.gsfc.nasa.gov/w3browse/all/wenss.html)
also timed out; a catalog would not substitute for native image footprints.
Exploratory SkyView survey-directory probes timed out and yielded no roster.

**No bounded or complete original-map inventory was established.** Keep
original map/mosaic filename as the intended identity; no confirmed current
file-path formula, per-image WCS or frame inventory is available from this
check. Next locate a functioning original-image service, retrieve its listing
and native FITS WCS, and preserve source provenance. Do not label CDS HiPS
tiles or catalog partitions as WENSS native mosaics.

## ZTF DR7: whole files are reachable; the historical inventory is missing

The [official release list](https://irsa.ipac.caltech.edu/data/ZTF/docs/ztf_data_releases.txt)
returned HTTP 200, SHA
`7bb6e7fc9dd8ab4bf04c8c74d1f1c8aad730f3cbc616e6ac32362cb18e5948fd`.
It explicitly says releases are cumulative and **only the last five** are
available through the current IRSA UI/API. The returned list ends at DR23
dated 2025-01-22; it lists DR7 dated 2021-09-08. The list's last entry is a
source observation, not proof of the newest release as of this note's date.

The [API guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_api.html)
and [metadata/path guide](https://irsa.ipac.caltech.edu/docs/program_interface/ztf_metadata.html)
both returned HTTP 200. They provide ICRS image corners, field/CCD/quadrant
and band identities and the actual whole-file rules:

```text
sci/<year>/<month><day>/<fracday>/
ztf_<filefracday>_<paddedfield>_<filtercode>_c<paddedccdid>_<imgtypecode>_q<qid>_sciimg.fits

ref/<fieldprefix>/field<paddedfield>/<filtercode>/ccd<paddedccdid>/q<qid>/
ztf_<paddedfield>_<filtercode>_c<paddedccdid>_q<qid>_refimg.fits
```

Both are relative to `https://irsa.ipac.caltech.edu/ibe/data/ztf/products/`.
The guides' actual representative
[science image](https://irsa.ipac.caltech.edu/ibe/data/ztf/products/sci/2018/0411/467847/ztf_20180411467847_000535_zr_c11_o_q3_sciimg.fits)
and [reference image](https://irsa.ipac.caltech.edu/ibe/data/ztf/products/ref/000/field000535/zr/ccd11/q3/ztf_000535_zr_c11_q3_refimg.fits)
returned HEAD HTTP 200 with lengths 37,872,000 and 40,970,880 bytes. Those
checks establish these two present-day files, not a DR7 processing snapshot.
The IBE reference schema request and a one-row query against the documented
`ztf.ztf_current_meta_ref` TAP table timed out; no current inventory was captured.

As [the earlier DR7 audit](phase2-native-sky-unit-candidates-20261004.md#ztf-dr7-keep-native-rules-resolve-the-old-release-inventory)
records, DR7 has distinct date/program selectors and its reference images
were continually updated. A present-day `refimg.fits` path does not freeze
its earlier bytes or processing identity. Even an observation within the
DR7 date range does not, by itself, prove DR7 release membership or reproduce
its reference inventory. Four ICRS frame corners remain estimated evidence
without pixel/mask validation.

**Next:** obtain an authoritative frozen DR7 image/processing/reference roster
with stable source identities, or create a separately reviewed current
release before capturing current metadata. A bounded current capture could
use these native rules under that truthful scope; it must not activate as
`ztf-dr7` merely to fill the existing layer.

## Recommended immediate acquisition

1. Reuse the already captured official DR5 brick source for DECaLS with the
   explicit coadd-release semantics above; this needs binding/review work,
   not another large acquisition.
2. Capture the **two Rubin First Look AVM metadata blocks** as the next small
   new source. Both identity and whole-file access are established; retain
   outreach-image scope and estimated astrometry.
3. Capture IPHAS's pinned **metadata precursor**, with exclusions and source
   scope preserved. Reconcile final DR2 QC and mark unreachable image access
   honestly instead of dropping the known identities.
4. Keep NVSS, SUMSS, WENSS and DR7 ZTF as unresolved native-inventory sources
   with recorded provenance and blockers until their actual archive/release
   evidence is available. Do not manufacture download paths or survey-global
   completeness from display coverage.
