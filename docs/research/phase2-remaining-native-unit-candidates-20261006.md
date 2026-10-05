# Remaining native sky-unit candidates, checked 2026-10-05–06

**Pan-STARRS DR1 is ready for a declared, bounded skycell capture.** Its official
grid, image-list API, whole-file paths and representative image-header WCS all
work. CFHTLS Wide T0007 is the next small roster to reconcile; DECaPS DR2 has
working CCD metadata and file access but a much larger inventory. ACT DR5 files
are whole maps, not spatial tiles.

This note audits the eleven remaining survey IDs below. AllWISE and VIKING are
excluded because their acquisition/build work is already in flight. No code,
management state, deployment, binding, MOC, public bundle, 72602 or Workspace was
changed. Scientific-file probes used HEAD, except **PS1 FITS headers only**:
eight confirmed 2,880-byte HTTP 206 ranges ended at the two HDU header END blocks;
no image pixels were read. Documents, file-list responses and the small PS1 grid
table are metadata. Diagnostics live in
`/tmp/assets-remaining-catalog-research-20261005/`; they are not managed inputs.

The Dev [coverage catalog](http://10.15.51.75:32083/api/v1/coverage/catalog)
returned 132 layers. These eleven survey IDs were `entrypoint-only` at the
initial research checkpoint. That observation is not a later activation status.

| Priority | Existing survey/release | Native mapping and actual access | Next step / limitation |
| --- | --- | --- | --- |
| 1 | `panstarrs` / `panstarrs-dr1` | RINGS.V3 `projection.skycell`, band and stack filename; official five-band list and g/r/i whole-file HEADs work | Capture an explicit sky region/grid subset, resolve every candidate skycell and lock metadata/WCS; global file membership is not established |
| 2 | `cfhtls` / `cfhtls-wide` | CADC TERAPIX T0007: 171 Wide observations, 855 ugriz planes; polygon, file URI and checksum join; representative FITS HEAD works | Reconcile the complete 855-file science-image join and retained i-filter identities; exclude 110 separate RGB planes |
| 3 | `decaps` / `decaps-dr2` | NOIRLab exposure + CCD-extension identity, ICRS corners, individual FITS access URLs; two representative HEADs work | Start a bounded exposure/CCD capture or acquire the complete 1,065,941-row source table with composite identity checks; these are CCDs, not bricks |
| 4 | `act` / `act-dr5` | Official 42-file roster; six normal ACT-only frequency/time-selection maps | Capture actual map WCS/header evidence and resolve currently intermittent file access; do not invent tiles or substitute ACT+Planck/ancillary maps |
| 5, conditional | `decals` / `decals-dr5` | Existing official Legacy DR5 176,811-brick roster and real g/r/z files | Adopt the official mixed-program DR5 coadd scope explicitly, or obtain DECaLS-only contribution provenance; prior audit is linked below |
| 6 | `iphas` / `iphas-dr2` | Release-author source defines run/CCD, metadata index and whole-image path | Retrieve the final DR2 metadata index and confirm image access; old image endpoints timed out in this check; current IGAPS is a different scope |
| 7 | `nvss` / `nvss-final` | NRAO documents 2,326 native 4° mosaics and C/I FITS names | Recover a reachable mosaic roster/WCS source; documented FTP currently rejects anonymous login |
| 8 | `sumss` / `sumss-final` | Historical native mosaics, preserved CDS provenance | Original Sydney mosaic/landing URLs return 404 or time out; no usable native-file roster or mirror established |
| 9 | `wenss` / `wenss-final` | Historical native mosaics, preserved CDS provenance | Old ASTRON/Leiden image endpoints return 404; no usable native-file roster or mirror established |
| 10 | `ztf` / `ztf-dr7` | Field/CCD/quadrant identities and whole-file rules are documented | Frozen DR7 processing/reference inventory remains missing; the current service cannot silently replace it |
| 11 | `rubin` / `rubin-firstlook` | Public First Look display coverage; scientific DP1 has separate SIA/Butler access | Do not bind restricted DP1 observations or generic tract/patch guesses to the First Look product |

## Pan-STARRS: enough source metadata for a locked bounded inventory

The official [Stack Images description](https://outerspace.stsci.edu/display/PANSTARRS/PS1+Stack+Images)
explicitly identifies deep `.stk.<band>.unconv` signal/variance/mask images as
**DR1 products**. [The archive home](https://outerspace.stsci.edu/display/PANSTARRS/Pan-STARRS1+data+archive+home+page)
states that DR1 data are also available in DR2. Freeze `type=stack` for DR1
imaging; single-epoch `warp` images added with DR2 are a separate product.

The [first-party image-list/download guide](https://outerspace.stsci.edu/display/PANSTARRS/PS1+Image+Cutout+Service)
documents both `skycell=1405.053` and J2000 `ra/dec`, band/type selectors and
batch position uploads. The exact
[live skycell query](https://ps1images.stsci.edu/cgi-bin/ps1filenames.py?skycell=1405.053)
returned five `stack` rows, one each in g/r/i/z/y, with `projcell=1405`,
`subcell=53`, `badflag=0` and real filenames. Response SHA-256:
`ce64ede2494b80b8f05e8ff1aeb32d9e777cc9ddb9686348f8769f4b8270a551`.
Use the **returned `filename`**, retaining `shortname`, type, filter and badflag;
the prose guide's sample table repeats a g filename in other bands, whereas the
live response correctly lists each band's own file.

The guide defines whole-file access by prefixing the filename with the server:

```text
https://ps1images.stsci.edu + <returned filename>

Example observed filename:
/rings.v3.skycell/1405/053/rings.v3.skycell.1405.053.stk.g.unconv.fits
```

These [g](https://ps1images.stsci.edu/rings.v3.skycell/1405/053/rings.v3.skycell.1405.053.stk.g.unconv.fits),
[r](https://ps1images.stsci.edu/rings.v3.skycell/1405/053/rings.v3.skycell.1405.053.stk.r.unconv.fits)
and [i](https://ps1images.stsci.edu/rings.v3.skycell/1405/053/rings.v3.skycell.1405.053.stk.i.unconv.fits)
whole-file HEADs returned HTTP 200, `image/fits`, respectively 66,974,400,
66,818,880 and 66,882,240 bytes. They are individual tile-compressed FITS
images, not a tar bundle. The corresponding root, projection and skycell
**directory URLs returned 404**; emit the actual file links, not guessed parent
directory links. No separate native-image mirror was established.

### Grid and actual footprint evidence

The official [tessellation description](https://outerspace.stsci.edu/display/PANSTARRS/PS1+Sky+tessellation+patterns)
defines 2,009 projection cells north of −30°, each split into a 10 × 10 grid of
approximately 0.4° skycells. `skycell.nnnn.0yx` preserves both digits: x and y
are each 0–9. Skycell overlap is 240 pixels per edge; do not map only centers.
Zones 13/14 have no stack images, and near-pole best-cell selection needs more
than a simple declination threshold.

Its downloadable [PS1 grid FITS metadata table](https://outerspace.stsci.edu/download/attachments/298812317/ps1grid.fits?version=1&modificationDate=1532367528459&api=v2)
returned 11,520 bytes, SHA-256
`2b482af457949f3dbdf71be0eaa351482514ebdf5205b068c792c363de2cf786`.
It has 33 zone rows and `ZONE`, `PROJCELL`, `NBAND`, `DEC`, `DEC_MIN/MAX`,
`XCELL/YCELL`, `CRPIX1/2`. This is a **geometric grid**, not an observed-file
roster. For zone 23 it supplies start projection 1322, 90 projections,
Dec 2°, 6240 × 6243 pixels and reference offsets 240/242.

The complete metadata-only g header for `skycell.1405.053` independently gives:

```text
TESS_ID=RINGS.V3; SKYCELL=skycell.1405.053; STK_ID=3850338
ZNAXIS1/2=6240/6243       # original compressed-image dimensions
CTYPE1/2=RA---TAN/DEC--TAN
CRVAL1/2=332/2; CRPIX1/2=11760/242
CDELT1/2=6.94444461259988e-05 degrees
PC001001/PC002002=-1/+1; off-diagonal PC=0
```

The primary HDU has `NAXIS=0`; WCS belongs to the compressed-image extension.
Use `ZNAXIS*`, not the BINTABLE's byte/row dimensions. Its 20,160-byte complete
extension header SHA is
`6b489729c139b31cb7dd7254ed5ed10f07c7befd6bec85c55563a48875c2a28f`.
There is no `RADESYS` or `EQUINOX` card. The official guide explicitly warns
about this and suggests the **FK5/J2000** convention; it also documents the
obsolete PC keywords. Preserve the source header, record that convention,
transform to ICRS explicitly, and retain `precision=estimated` frame coverage.
No valid-pixel/mask coverage was checked.

This candidate grid derivation exactly reproduces the representative WCS;
cross-check it against actual headers before using it across additional zones:

```text
projection RA = 360 * (projectionID - zone.PROJCELL) / zone.NBAND
projection Dec = zone.DEC
CRPIX1 = zone.CRPIX1 + (5 - x) * (zone.XCELL - 480)
CRPIX2 = zone.CRPIX2 + (5 - y) * (zone.YCELL - 480)
```

For the representative g image, FITS pixel-edge corners converted from that
explicit FK5/J2000 convention to ICRS are approximately
`(332.817060,1.983023)`, `(332.383516,1.983180)`,
`(332.383617,2.416705)`, `(332.817275,2.416513)`.
Use spherical polygon intersection, including RA wrap and polar geometry.

### Capture boundary and completeness

The documented positional query returns only the **best** skycell covering the
position. Live probes returned Taurus `(64.5,28)` → `1944.003`,
M31 `(10.6847083,41.26875)` → `2159.034`, and `(0,89.5)` → `2643.034`, each
with five stack bands. They do not enumerate neighboring overlapping skycells.
`skycell=1405` and `skycell=1405.*` returned 400; no projection-wide wildcard
enumeration was established.

For a sound first increment, declare a bounded ICRS region or named projection
subset, derive intersecting candidates from the **source grid**, and query each
candidate by its complete skycell identity. Lock the grid, official release/type
documentation, exact requests/responses, returned file identities and actual
WCS/header evidence with SHA/size receipts. Record empty and failed queries;
compare candidate/query receipts rather than treating HTTP success as inventory
completeness. Keep `inventoryComplete=false` for the full survey. A future global
capture must enumerate/reconcile all source-grid skycells and actual band/file
membership; ~200,000 geometric cells is not a global image count.

This route is sufficient for a **SHA-locked bounded native-unit inventory**
without pixel downloads. Bind the five imaging bands and reviewed color-band
scope only. The catalog's separate `DR1 color imaging` product currently has
`modality=catalog`; resolve that semantic mismatch through the supported product
workflow rather than binding an image roster to it silently. Do not fabricate a
standalone RGB FITS when only individual band images were returned.

## CFHTLS Wide: small final-release roster at CADC

The [official CFHTLS archive](https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/cfht/cfhtls.html)
identifies TERAPIX as an archive collection. [CADC services](https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/services/)
link its working TAP endpoint, **`https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync`**;
the guessed historical `/tap/sync` path returned 404. This query finds the Wide
scope correctly; `target_name LIKE 'W%'` misses most observations (only seven):

```sql
SELECT COUNT(*) FROM caom2.Observation
WHERE collection='CFHTTERAPIX' AND observationID LIKE 'CFHTLS_W_%'
```

It returned **171 observations**. Join `Observation.obsID → Plane.obsID →
Artifact.planeID`; all Wide planes have `provenance_version=T0007`. There are
**171 each u/g/r/z, 139 old-i + 32 new-i = 855 band planes**, plus **110 separate
gri/gry/ryg color planes**. Do not count those RGB planes as single-band images.
Filter actual `.fits` science artifacts; `.cat.gz`, `.ldac.gz`, weight and preview
identities are separate. Sample source observation `CFHTLS_W_022539-041200`
retains native target `W1.+2+3`, a per-plane four-corner polygon, filter
`g.MP9401` and artifact
`cadc:CFHTTERAPIX/CFHTLS_W_g_022539-041200_T0007_MEDIAN.fits`.

The [CADC data API](https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/)
documents anonymous and authenticated access. The representative
[whole g FITS route](https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/pub/CFHTTERAPIX/CFHTLS_W_g_022539-041200_T0007_MEDIAN.fits)
first timed out and once redirected to `/data/auth/`; a later HEAD with **no
credentials** returned 200, 1,498,320,000 bytes and the source-listed MD5 digest
`5bbeb87faa312d42428f07facc9112ca`. Authentication challenge headers alone do
not establish that a currently public file requires login. Preserve the dated
probe outcomes and avoid extending this one result to all images.
The installed [CDS g provenance record](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FCFHTLS%2FW%2Fg&get=record&fmt=json)
names TERAPIX and T0007-family HiPS. Capture the exact source version and original
frame declaration: the plane polygons are unlabelled CAOM shapes, but an actual
joined g-image `Chunk` explicitly returns **`position_coordsys=ICRS`**, TAN WCS,
19354 × 19354 dimensions and `position_equinox=2000.0`. Preserve that explicit
ICRS declaration and source equinox; acquire each image's own Chunk/frame
metadata rather than assuming one sample proves all frames. Per-band roster
completeness still needs full join reconciliation and SHA-locked capture.

## DECaPS DR2: CCD files, not a Legacy brick roster

The official [NOIRLab DECaPS page](https://datalab.noirlab.edu/data/decaps)
works even though `decaps.skymaps.info` fails TLS. The
[NOIRLab TAP service](https://datalab.noirlab.edu/tap/) exposes
`ivoa_decaps_dr2.siav1/siav2/obscore/exposure`.
`COUNT(*) FROM ivoa_decaps_dr2.siav1` returned **1,065,941** rows; per-band counts
g/i/r/Y/z are **222,948 / 213,595 / 220,344 / 198,019 / 211,035**.
These are table rows, not yet reconciled unique exposure/CCD identities.

Actual row `c4d_180520_103732_ooi_r_decaps2.fits.fz#51` has exposure **748737**,
2046 × 4094 CCD geometry and `RA---TPV/DEC--TPV`. The schema explicitly labels
the four corner pairs **ICRS**. Preserve `obs_pub_did` including the extension,
`fileref`, exposure, source access URL and actual band. ObsCore samples omit the
extension in their publisher ID and give approximate circles, so SIAv1 corner
rows are the more useful source for distinct CCD geometry.

Its [source-listed r CCD route](https://datalab.noirlab.edu/svc/cutout?col=decaps_dr2&siaRef=c4d_180520_103732_ooi_r_decaps2.fits.fz&extn=51)
and a [Y CCD route](https://datalab.noirlab.edu/svc/cutout?col=decaps_dr2&siaRef=c4d_180804_044436_ooi_Y_decaps2.fits.fz&extn=51)
both returned HEAD 200, `image/fits`, without POS/SIZE. Preserve these actual
service links and the CCD selector; do not label them static brick files or
invent an NERSC DR2 tree. Payload dimensions, TPV edge curvature and valid-pixel
masks were not independently checked. Frame intersection remains estimated.
The accessible NERSC `/cfs/cosmo/data/decaps/` root lists only **dr1**; its guessed
`dr2/` returns 404 and `/project/decaps/` returns 403. Those access failures do
not mean DR2 has no images; the official metadata and CCD access above work.

## ACT DR5 and conditional DECaLS reuse

The [ACT DR5 download page](https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_get.html),
[42-file script](https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_wget.sh)
and [supplement](https://lambda.gsfc.nasa.gov/product/act/actpol_dr5_coadd_maps_info.html)
now returned 200, resolving the earlier document-access blocker. The six normal
ACT-only maps are frequency 090/150/220 × night/daynight, with names such as
`act_dr5.01_s08s18_AA_f090_daynight_map.fits` under the source-listed
`/data/suborbital/ACT/ACT_dr5/maps/` root. Other roster members are ACT+Planck,
source-subtracted or variance products; keep those identities distinct.
These native **whole CAR maps** span all RA and Dec approximately −63° to +23°,
43200 × 10320 × 3 Stokes axes. The supplement documents holes/artifacts; that
frame is not exact ACT valid-pixel coverage. File HEADs and the page-linked FITS
header CGI timed out in this probe. Keep links source-listed/unverified until
header/access checks succeed. No spatial Tile inventory was proven.

The [existing DECaLS/Legacy DR5 audit](phase2-uncovered-native-unit-candidates-20261005.md#2-decals-dr5-useful-shared-roster-unresolved-program-restriction)
already verifies the 176,811-brick roster and sample g/r/z whole FITS links.
The [official release description](https://www.legacysurvey.org/dr5/description/)
explicitly includes non-DECaLS DECam programs. Reusing it under `decals-dr5`
requires an explicit reviewed **DR5 coadd** scope; its exposure summaries cannot
prove a program-only DECaLS inventory. This note did not repeat that acquisition.

## Sources requiring recovery or a different release scope

- **IPHAS DR2:** the release author's [immutable image-preparation source](https://github.com/barentsen/iphas-dr2/blob/e2e47c6964df6bb5fe9909e317ef18f0913698db/dr2/images.py)
  defines native run + CCD, revised ICRS/ZPN WCS and `r<run>-<ccd>.fits.fz`;
  the `r` filename prefix alone is **not the photometric band**. Its
  [metadata export source](https://github.com/barentsen/iphas-dr2/blob/e2e47c6964df6bb5fe9909e317ef18f0913698db/scripts/release-preparation/augment-image-metadata.py)
  defines `http://www.iphas.org/data/images/<filename[0:4]>/<filename>` and exports
  `iphas-images.fits.gz` with run/CCD/band/fieldid/in_dr2/quality/bounds. It also
  records a corrupt run and a duplicate that must be excluded. The corresponding
  HTTPS sample image/index HEADs timed out; no usable final-index capture exists
  from this audit. The [old project page](https://www.iphas.org/) announces its
  replacement by IGAPS; its old content also contains unrelated injected links.
  Prefer the author-owned source/publication for provenance and recover the
  DR2 index/image archive before import; IGAPS observations are not automatically
  a DR2 snapshot.
- **NVSS:** [NRAO](https://www.cv.nrao.edu/nvss/) documents 2,326 4° × 4° Stokes
  mosaics. Its [download instructions](https://www.cv.nrao.edu/nvss/anonftp.shtml)
  define `ftp://ftp.cv.nrao.edu/pub/nvss/MAPS/`, with native examples `C2230P84.gz`
  (I/Q/U cube) and `I0224M32.gz` (I-only), named by J2000 centers. Gzip compresses
  individual FITS files. Anonymous FTP returned **530 login incorrect / unable
  to set anonymous privileges**. The documented Cambridge mirror URL returned
  404. No current roster/header capture or verified whole-map HTTP mirror was
  obtained; a center naming rule is insufficient to manufacture membership.
- **SUMSS:** original Sydney landing/mosaic URLs and the alternate Sydney link
  in [CDS source provenance](https://alasky.cds.unistra.fr/SUMSS/properties)
  returned 404 or timed out; its FTP hostname did not resolve. Preserve the
  known survey/native-mosaic provenance. CDS HiPS pixels are resampled display
  data and do not establish an original-mosaic download roster.
- **WENSS:** the Leiden and ASTRON `/wow/testcode.php?survey=1` image links return
  404; [the current ASTRON VO service list](https://vo.astron.nl/__system__/services/root)
  did not expose a WENSS route in the inspected listing. The
  [CDS provenance](https://alasky.cds.unistra.fr/WENSS/properties) still identifies
  ASTRON and the resampled 325-MHz product. No native whole-image URI inventory
  was established. This is an access/discovery gap, not proof the images no
  longer exist; catalog files or HiPS tiles must not replace native mosaics.
- **ZTF DR7:** the [official release list](https://irsa.ipac.caltech.edu/data/ZTF/docs/ztf_data_releases.txt)
  still says only the last five cumulative releases are served through the
  current UI/API. [The previous audit](phase2-native-sky-unit-candidates-20261004.md#ztf-dr7-keep-native-rules-resolve-the-old-release-inventory)
  captures the DR7 date/program selectors and continually updated-reference
  caveat. Retain documented native rules and the unresolved frozen-inventory
  status; current reference images do not reconstruct DR7.
- **Rubin First Look:** [DP1 documentation](https://dp1.lsst.io/) restricts
  scientific DP1 access to Rubin data-rights holders; its
  [access guide](https://dp1.lsst.io/access/index.html) describes SIA/Butler/RSP.
  That is a different product scope from `rubin-firstlook`. No public First Look
  exposure/tract/patch-to-scientific-file roster was established. Retain the
  existing entrypoint and known public display provenance, without guessing
  storage paths or replacing the release with DP1.

Successful research probes are neither installed indexes nor per-survey global
completion. New captures must follow the managed import/build/review/archive/Dev
activation workflow, retaining actual source IDs, file membership, frame
conventions, precision, query scope and per-link availability independently.
