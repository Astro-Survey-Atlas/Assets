# Native Block Access URIs: HSC and Legacy Surveys

Research checked 2026-09-30 (Asia/Shanghai) against first-party HSC SSP and Legacy Surveys release pages. The URL and per-file checks used `HEAD`; no science data were downloaded. The public DR10 South brick summary was separately retrieved as source metadata, SHA-256 locked, and connected to the local brick index.

## HSC-SSP PDR2 and PDR3

### Official query and directory entry points

| Release | DAS Search entry | Official usage guide | Area file-tree entries |
|---|---|---|---|
| PDR2 | [DAS Search PDR2](https://hsc-release.mtk.nao.ac.jp/das_search/pdr2/) | [DAS Search PDR2 usage](https://hsc-release.mtk.nao.ac.jp/das_search/pdr2/usage.html) | [DUD](https://hsc-release.mtk.nao.ac.jp/archive/filetree/pdr2_dud/), [Wide](https://hsc-release.mtk.nao.ac.jp/archive/filetree/pdr2_wide/) |
| PDR3 | [DAS Search PDR3](https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/) | [DAS Search PDR3 usage](https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/usage.html) | [DUD](https://hsc-release.mtk.nao.ac.jp/archive/filetree/pdr3_dud/), [Wide](https://hsc-release.mtk.nao.ac.jp/archive/filetree/pdr3_wide/) |

The release-specific entries are linked by HSC's official [PDR2 Data Access page](https://hsc-release.mtk.nao.ac.jp/doc/index.php/tools-2/) and [PDR3 Data Access page](https://hsc-release.mtk.nao.ac.jp/doc/index.php/data-access__pdr3/). Those pages describe DAS Search as a data retrieval/search tool and state that users need an account to search, request, and retrieve archive data. They also list directory-tree browsing by survey area. The PDR3 page describes an image patch as a 4k x 4k image. The DAS Search, usage-guide, and file-tree URLs returned HTTP 401 to unauthenticated requests during this check, consistent with the release pages' account requirement.

### What can be linked for one tract/patch

`tract/patch` is a real HSC spatial unit. It is useful to identify the patch whose footprint intersects a HEALPix cell. A filter/band is useful as an additional imaging criterion, but `tract/patch/filter` does not identify a unique archive file by itself: the data-access page presents a search/retrieval service and area-level file-tree entry points, not a public tract/patch/filter-to-file URL template.

The public first-party material inspected here documents release-scoped DAS Search URLs and links to `usage.html`; it does **not** document an HTTP deep-link parameter contract that pre-fills a tract, patch, and filter. The unauthenticated interface could not be inspected because it returned 401. Therefore:

- A DAS Search link is an authenticated **query-page entry point**, not a direct file URI and not evidence that a particular file exists.
- The result may be described as `tract/patch` candidates, with the filter/band as a suggested criterion and a link to the matching release's DAS Search page. The user completes the product-specific search in the authenticated service; the public material reviewed here does not establish its deep-link parameter contract.
- Do not synthesize a per-unit file URL or call the DAS URL a pre-filled query URL unless HSC publishes a stable URL format or an authenticated test establishes one.
- The direct file-tree URLs are useful release/area navigation links, but the public documentation inspected here does not make them per-tract/patch direct links.

Official sources: [HSC PDR2 Data Access](https://hsc-release.mtk.nao.ac.jp/doc/index.php/tools-2/), [HSC PDR3 Data Access](https://hsc-release.mtk.nao.ac.jp/doc/index.php/data-access__pdr3/), [PDR2 DAS Search](https://hsc-release.mtk.nao.ac.jp/das_search/pdr2/), [PDR3 DAS Search](https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/).

## Legacy Surveys DR10

### Native unit and release availability

Legacy Surveys coadded imaging and Tractor catalogs are organized by `brick`; the DR10 description says bricks are approximately 0.25 degrees on a side and defined in RA/Dec. The release's [files page](https://www.legacysurvey.org/dr10/files/#survey-bricks-fits-gz) distinguishes two relevant brick tables:

- `survey-bricks.fits.gz` describes the geometric brick grid across the sky, including bricks outside the DR10 footprint or without DR10 coverage.
- `south/survey-bricks-dr10-south.fits.gz` summarizes the bricks that have content in the DR10 south release.

Thus the all-sky geometry table can produce candidate brick IDs, but it is not a release-specific file inventory. For a DR10 south file list, also constrain by the release summary table or verify the generated file URI. See the [DR10 files page](https://www.legacysurvey.org/dr10/files/#south-survey-bricks-dr10-south-fits-gz) for the release summary's description.

The summary was retrieved on 2026-09-30 and captured at
`source-units/legacy-survey-bricks-dr10-south.fits.gz` in the evidence store;
the lock records its 104,480,980-byte size and SHA-256
`863e5ded7a4aae7abcb5df76f322f35cf89945483715ff6d1874c88f5a072d9a`. The
runtime index joins its `BRICKNAME` values to the all-sky geometric table. It
uses the result only as DR10 South brick membership. The summary's band
exposure and source-count statistics are not treated as exact per-file
inventory, so Coadd and Tractor URIs remain unverified candidates.

### Documented DR10 path rules

The official [DR10 image-stack documentation](https://www.legacysurvey.org/dr10/files/#image-stacks-south-coadd) specifies coadd entries under `south/coadd/<AAA>/<brick>/`. A representative image filename is:

```text
legacysurvey-<brick>-image-<filter>.fits.fz
```

The same page documents related per-brick products such as `invvar`, `model`, `chi2`, `depth`, `galdepth`, `nexp`, `psfsize`, `maskbits`, and `ccds`; filter names for the optical stack images are `g`, `r`, `i`, and `z`.

The official [DR10 Tractor catalog documentation](https://www.legacysurvey.org/dr10/catalogs/#south-tractor-aaa-tractor-brick-fits) specifies the Tractor table path under `south/tractor/<AAA>/tractor-<brick>.fits`. The `AAA` directory is based on the RA of the brick center; for example, `002` corresponds to brick centers from RA 2 to 3 degrees. There is no extra `<brick>/` subdirectory in this Tractor path.

Brick names encode approximate RA/Dec centers, but the release documentation cautions that they do not recover the exact brick center; use the `brickname`, `ra`, and `dec` columns in `survey-bricks.fits.gz` when exact geometry is needed. Use the complete brick footprint to decide HEALPix intersections, not just the encoded center.

### Verified exact file URLs

Using brick `1498p020` (the documented name form for a center near RA 149.8 degrees and Dec +2.0 degrees), the following exact south-release URLs returned HTTP 200 to `HEAD` on 2026-09-30 Asia/Shanghai. `Content-Length` is included as an observation from that check, not a guarantee that the release will never change.

| Kind | Exact URL | HEAD result |
|---|---|---|
| Coadd image, r band | [`legacysurvey-1498p020-image-r.fits.fz`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/coadd/149/1498p020/legacysurvey-1498p020-image-r.fits.fz) | 200, 9,907,200 bytes |
| Tractor catalog | [`tractor-1498p020.fits`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/tractor/149/tractor-1498p020.fits) | 200, 47,047,680 bytes |

The superficially plausible Tractor URL with an extra brick directory, `.../south/tractor/149/1498p020/tractor-1498p020.fits`, returned HTTP 404. This confirms the catalog-page layout above and is a path-construction regression case.

### Reverse-lookup implications

- A spatial match should return the native `brick` identity, then expand it to the selected DR10 product URI(s). A coadd brick can yield multiple files by image product and band; the Tractor catalog is a different per-brick file.
- A documented filename rule makes a URI constructible, but does not prove every candidate brick has that file. Preserve this distinction in result precision/status; use release-specific presence metadata or a source-side check before marking the file as observed.
- The brick directory (`.../coadd/<AAA>/<brick>/`) is a directory entry point; the two linked sample URLs above are exact file URIs. Keep those link types distinct in UI and exported manifests.

## Legacy Surveys DR1-DR10 inventory differences

The release pages and metadata endpoints were checked with unauthenticated `HEAD` requests on 2026-09-30. These are inventory/geometry files, not science images or catalogs:

| Release | All-sky brick geometry | Release membership summary | Result |
|---|---|---|---|
| DR1 | `dr1/decals-bricks.fits` (HTTP 200) | The same table has `has_image_g/r/z` and `has_catalog` flags | Catalog source link corrected to this table; it previously named a `survey-bricks.fits.gz` URL that returns 404. |
| DR2 | `dr2/decals-bricks.fits` (HTTP 200) | `dr2/decals-bricks-dr2.fits` (HTTP 200) | Catalog geometry link corrected to the all-sky table; the release page says the DR2-suffixed table describes release content. |
| DR3-DR7 | `drN/survey-bricks.fits.gz` (HTTP 200) | `drN/survey-bricks-drN.fits.gz` (HTTP 200) | Keep the all-sky grid separate from the release-specific brick roster. |
| DR8-DR9 | `drN/survey-bricks.fits.gz` (HTTP 200) | `drN/north|south/survey-bricks-drN-north|south.fits.gz` (HTTP 200) | North and South are separate region rosters, not per-file inventories. The local matcher has both regions for these releases. |
| DR10 | `dr10/survey-bricks.fits.gz` (HTTP 200) | `dr10/south/survey-bricks-dr10-south.fits.gz` (HTTP 200) | The official files page lists DR10 Coadd and Tractor trees under `south/` only. The checked North roster and `north/coadd/` paths return 404; no DR10 North member roster was found. |

The DR1 files page says its brick table includes the image-band and catalog membership flags. The DR2 page distinguishes the geometric grid from its release summary. DR3-DR9 roster schemas were inspected; their rows provide release-member brick candidates and exposure summaries, not exact per-file existence. The DR10 roster remains a separate South-only membership summary.

Access rules also vary by release. DR1 and DR2 document `tractor/<AAA>/tractor-<brick>.fits` and `coadd/<AAA>/<brick>/decals-<brick>-image-<filter>.fits`. DR3 and DR4 coadds use `legacysurvey-<brick>-image-<filter>.fits` under `coadd/<AAA>/<brick>/`. Directories for the sampled DR5, DR6, and DR7 bricks list the same coadd filenames with the `.fits.fz` suffix; representative corrected file URLs returned HTTP 200. DR8 and DR9 use North/South roots, `tractor/<AAA>/tractor-<brick>.fits`, and coadd `legacysurvey-<brick>-image-<filter>.fits.fz`. DR10 uses the South prefix and the `.fits.fz` image name. DR8/DR9 North `NEXP_Z=0` for the sampled brick `0411p017`, so its North z-band URI is not a matcher result; North g/r and South g/r/z files were present in the sampled directories. A successful `HEAD` is per-file evidence; a documented path rule alone remains an unverified candidate.

The DR1 [`decals-bricks.fits`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr1/decals-bricks.fits) snapshot was captured locally at 49,011,840 bytes with SHA-256 `4c8370585000a4189cac3d98e8b620fbde93f8a1e791b23b73865be304e70fb3`. It contains 662,174 brick rows and the `has_image_g/r/z` and `has_catalog` membership flags. The local source-unit matcher builds separate Coadded imaging and Tractor catalog brick mappings. Tractor candidates use `tractor/<AAA>/tractor-<brick>.fits`, whose sample `1498p020` URL returned HTTP 200. The DR1 files page documents the coadd filename and path under `coadd/<AAA>/<brick>/`, but the NERSC directory now says those coadds were removed and links the [NOAO archive FTP root](ftp://archive.noao.edu/public/hlsp/decals/dr1/coadd/). A representative NERSC DR1 Coadd image URL returned HTTP 404 on 2026-09-30. FTP file candidates are generated from the documented archive root and path rule, but are not individually verified; `archive.noao.edu` did not resolve from the verification environment. Image and catalog membership flags establish release-level brick membership, not present-day per-file availability. The snapshot is loaded by the Dev source-unit worker. Runtime brick mappings now cover DR1-DR10 using the corresponding locked release rosters; DR1/DR2 Coadd paths remain unverified because the documented legacy FTP host could not be resolved, while per-file URI rules for the later releases are still candidates unless individually checked. No MOC is generated or modified by this source-unit mapping.

### DR2 roster capture and current file access check

The official DR2 `decals-bricks-dr2.fits` release roster was captured locally
as an evidence input at 24,180,480 bytes, SHA-256
`36df229f93931d05a597a4b560afea1400fb94e0af4df1715bb53b49f0dd2fef`. It has
318,032 rows and includes `BRICKNAME`, the brick center and `RA1/RA2/DEC1/DEC2`
bounds, plus `nobs_med_*` and `nobs_max_*` columns. Every roster brick matched
the independently captured DR2 all-sky `decals-bricks.fits` geometry table;
all six coordinate columns were identical for all 318,032 rows. The runtime
Tractor matcher can therefore use the release roster's native brick identity
and boundaries without treating the all-sky grid as release membership.

The official DR2 files page documents
`tractor/<AAA>/tractor-<brick>.fits`. For the roster brick `2134m090`, the
corresponding Tractor URL returned HTTP 200. This is one example only; all
per-brick candidates remain unverified. The same page documents the Coadd
filename `coadd/<AAA>/<brick>/decals-<brick>-image-<filter>.fits`. A HEAD
request to the NERSC example returned HTTP 404, and a GET of its `dr2/coadd/`
directory explains why: those files were removed from NERSC to conserve
storage and remain available from the linked NOAO FTP root
`ftp://archive.noao.edu/public/hlsp/decals/dr2/coadd/`. That root did not
resolve from the verification environment, so generated per-brick FTP URIs are
officially documented candidates but remain unverified for present-day
availability. The roster's `nobs_max_g/r/z` values select candidate bands; they
are exposure summaries, not per-file inventory. For example, brick `1498p020`
has positive median and maximum exposure summaries in g/r/z. The runtime index
therefore returns DR2 Coadded imaging brick candidates separately from Tractor
bricks and labels every Coadd URI unverified. DR2 Tractor brick lookup remains
available on Dev revision 283. An anonymous O8 `436132` preview returned six
DR2 Tractor brick candidates and marked the preview truncated; the first URI,
for `1498p020`, returned HTTP 200. Tractor candidates also remain unverified
per brick because only that sample was checked.

The independent all-sky geometry file was 46,362,240 bytes, SHA-256
`53b9fdd3feb2ec3d336026a68321c4d004da9674161f71d73dd424c1e6485233`; it is a
cross-check input and is not part of the runtime DR2 lock. The roster remains
in the ignored local evidence cache and the existing evidence PVC; the all-sky
cross-check remains local-only. Neither snapshot is in Git or the browser
bundle.

These findings do not yet establish a complete DR1-DR10 runtime index. DR2
Tractor and Coadded imaging are locally indexed from the locked release
roster. DR3-DR9 roster snapshots and runtime bindings are recorded below; DR10
still has a South-only release summary. Runtime parsing preserves each
release's source snapshot, member filter and access rule, and reuses the
all-sky brick geometry rather than copying that full grid for every release.

### DR3-DR9 source-unit roster snapshots

The compressed FITS files captured under the ignored local evidence cache are
official per-brick release summaries, not object-level catalogs, MOCs or
science images. Their BRICKNAME rows identify candidate source units;
NEXP_g/r/z > 0 selects candidate Coadd bands but does not prove that a
band-specific file exists. Tractor candidates use the listed release-member
bricks. Byte size, SHA-256, observed row count and source URL are recorded in
the source-unit-indexes.lock.json manifest.

| Release | Region | Rows | IDs missing from locked grid | Center mismatch | Bounds mismatch |
|---|---|---:|---:|---:|---:|
| DR3 | all | 149,464 | 0 | 0 | not supplied |
| DR4 | all | 65,543 | 0 | 0 | not supplied |
| DR5 | all | 176,811 | 0 | 0 | not supplied |
| DR6 | all | 92,292 | 0 | 0 | not supplied |
| DR7 | all | 180,117 | 0 | 0 | not supplied |
| DR8 | North | 93,610 | 0 | 0 | not supplied |
| DR8 | South | 247,844 | 0 | 0 | not supplied |
| DR9 | North | 93,548 | 0 | 0 | not supplied |
| DR9 | South | 253,658 | 0 | 0 | 0 |

All roster centers match the locked DR10 survey-bricks.fits.gz all-sky
geometry; the boundaries present in DR9 South match as well. Runtime lookup
intersects the selected full HEALPix cell with the brick polygon. DR8/DR9
results preserve north/ and south/ in their generated URI paths, including
both region paths when one native brick ID is listed in both rosters. All
matches remain estimated. A representative DR9 North brick, `1500p292`, was
cross-checked against the official `ls_dr9.bricks_n` table (NEXP_g/r > 0,
NEXP_z = 0); its North Tractor URI and g/r Coadd URIs returned HTTP 200, while
the z Coadd URI returned HTTP 404. This validates the path rule and band
filter for that brick only; all other generated URIs remain unverified. The
snapshots have not been added to Git or the browser bundle, synced to Dev
evidence storage, or used to generate or publish a MOC.

## Source pages

- HSC SSP: [PDR2 Data Access](https://hsc-release.mtk.nao.ac.jp/doc/index.php/tools-2/), [PDR3 Data Access](https://hsc-release.mtk.nao.ac.jp/doc/index.php/data-access__pdr3/), [PDR2 DAS Search](https://hsc-release.mtk.nao.ac.jp/das_search/pdr2/), [PDR3 DAS Search](https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/).
- Legacy Surveys: [DR1 files and layouts](https://www.legacysurvey.org/dr1/files/), [DR1 Tractor catalog format](https://www.legacysurvey.org/dr1/catalogs/), [DR10 files and layouts](https://www.legacysurvey.org/dr10/files/), [DR10 Tractor catalog format](https://www.legacysurvey.org/dr10/catalogs/), [DR10 release description](https://www.legacysurvey.org/dr10/description/).

## Euclid ERO and Q1 Deep Fields

### ERO: target packages, no Tile-level inventory found

The ESA [ERO archive landing page](https://euclid.esac.esa.int/dr/ero/) groups data by named ERO target. It states that each target has image stacks and catalogs, and documents package names such as `Euclid-VIS-Stack-[TARGET].DR3.tar`, `Euclid-NISP-Stack-[TARGET].DR3.tar`, `Euclid-VIS-Catalog-[TARGET].DR3.tar`, and `Euclid-NISP-Catalog-[TARGET].DR3.tar`. The page lists 17 targets and links each target to its data page. For example, the [Barnard 30 target page](https://euclid.esac.esa.int/dr/ero/ERO-Barnard30) links directly to target-level VIS/NISP stack and catalog tar files.

The ERO page and the inspected target page do not publish a `tile_index`, per-Tile footprint, or a Tile-to-product-file inventory. The target tar packages are exact downloadable package links, but they are not per-Tile products. An ERO HEALPix result can therefore point to the relevant target package only when the target region is known to contain that cell; it cannot claim an ESA Tile ID or synthesize a per-Tile URI from these pages.

As a bounded check of the separate ESA Euclid Archive TAP metadata, `ivoa.obscore` was queried for `obs_collection='sedm'`, ERO target names, and filenames containing `ERO`. At the time of the check, the `sedm` ObsCore rows exposed only `data_set_release='Q1_R1'`, and no ERO target/package rows matched those ERO terms. This absence applies to the queried TAP collection and does not replace the explicit target-package inventory on the ERO archive page.

### Q1: native Tile IDs, per-product footprints, and exact file access URLs

ESA's [Q1 Data Access page](https://www.cosmos.esa.int/web/euclid/q1-data) says that the full public Q1 data set is available through the [Euclid Science Archive](https://eas.esac.esa.int/sas/); its web archive uses IVOA protocols and supports table/image queries from the command line. The official archive TAP service is [EAS TAP](https://eas.esac.esa.int/tap-server/tap/). Its live `TAP_SCHEMA` exposes these relevant first-party fields:

- `q1.mosaic_product`: `tile_index`, `file_name`, `file_path`, `filter_name`, `patch_id_list`, and `stc_s`.
- `q1.mer_segmentation_map`: `tile_index`, `file_name`, `file_path`, and `stc_s`.
- `ivoa.obscore`: `tile_index`, `file_name`, `s_region`, `access_url`, `data_set_release`, and `dataproduct_type`.

For Euclid, `tile_index` is the native Tile identity. `stc_s` and ObsCore's
`s_region` describe a particular product row's footprint and are used only for
spatial matching; neither field defines the Tile ID or changes the output unit.

For Q1 BGSUB mosaic products, the archive query below returned 2,908 rows and 352 distinct `tile_index` values on 2026-09-30. Every row in the current `q1.mosaic_product` `Q1_R1` result set matched the `EUC_MER_BGSUB-MOSAIC-%` filename prefix. The table provides actual Tile IDs and product footprints; its `file_path` is an archive-internal repository path, so use ObsCore's `access_url` for a user-facing file URL.

```sql
SELECT tile_index, file_name, filter_name, stc_s, file_path
FROM q1.mosaic_product
WHERE data_set_release = 'Q1_R1'
  AND tile_index = 102042918
```

The matching ObsCore row has the same `tile_index` and `file_name`, and gives both the product's `s_region` and an exact SAS-DD access URL. The following is the access URL returned for the VIS mosaic on Tile `102042918`; a `HEAD` request returned HTTP 200 on 2026-09-30 (1,474,565,760 bytes, not downloaded):

[`EUC_MER_BGSUB-MOSAIC-VIS_TILE102042918-2DF4FD_20241021T032108.330546Z_00.00.fits`](https://eas.esac.esa.int/sas-dd/data?RETRIEVAL_TYPE=FILE&release=sedm&file_name=EUC_MER_BGSUB-MOSAIC-VIS_TILE102042918-2DF4FD_20241021T032108.330546Z_00.00.fits)

Use this archive query pattern to get native unit, spatial region, and URL together for a selected Q1 release and product type:

```sql
SELECT tile_index, file_name, s_region, access_url, dataproduct_type
FROM ivoa.obscore
WHERE data_set_release = 'Q1_R1'
  AND tile_index = 102042918
  AND dataproduct_type = 'mosaic'
```

This is sufficient for a HEALPix-to-Tile-to-file mapping for the products returned by the Q1 archive: intersect the complete HEALPix region with the returned `s_region`, preserve the returned `tile_index`, then emit the row's exact `access_url`. No Tile ID needs to be generated. To map a named Q1 deep-field region, spatially intersect its sourced region geometry with these per-product regions and retain only the actual returned `tile_index` and `access_url` rows.

The archive does not provide a deep-field label in the `q1.mosaic_product` fields listed above. A search for filename substrings `DEEP` or `EDF` is not a reliable deep-field selector: the three matches observed in Q1 BGSUB data were ordinary product filenames whose hexadecimal filename checksum happened to contain those character sequences. Do not infer deep-field identity from that substring, nor treat the 2,908-row BGSUB inventory as a separately curated “deep-field product” list. The explicit deep-field association still depends on a sourced region definition and spatial intersection. The Q1 table's scope is the products returned by that release table, not every present or future Euclid product.

Official sources: [ESA Q1 Data Access](https://www.cosmos.esa.int/web/euclid/q1-data), [Euclid Science Archive](https://eas.esac.esa.int/sas/), [EAS TAP](https://eas.esac.esa.int/tap-server/tap/), [ESA ERO archive](https://euclid.esac.esa.int/dr/ero/), and the [ERO Public Release notes](https://www.cosmos.esa.int/web/euclid/ero-public-release).

## Legacy DR10 South Brick Summary

### File schema and release scope

The [DR10 files page](https://www.legacysurvey.org/dr10/files/) defines `survey-bricks.fits.gz` as the all-sky geometric brick grid, explicitly including bricks outside the Legacy Surveys footprint and bricks without DR10 coverage. It separately defines `south/survey-bricks-dr10-south.fits.gz` as a table summarizing the contents of each brick in DR10. The public file URIs documented by the release are:

- [`survey-bricks.fits.gz`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/survey-bricks.fits.gz)
- [`south/survey-bricks-dr10-south.fits.gz`](https://portal.nersc.gov/cfs/cosmo/data/legacysurvey/dr10/south/survey-bricks-dr10-south.fits.gz)

Both URLs returned HTTP 200 to `HEAD` on 2026-09-30; the observed compressed lengths were 13,147,987 and 104,480,980 bytes respectively. The South summary was then captured as source evidence at `source-units/legacy-survey-bricks-dr10-south.fits.gz`, SHA-256 `863e5ded7a4aae7abcb5df76f322f35cf89945483715ff6d1874c88f5a072d9a`. It has 366,912 rows and includes the complete brick bounds and `NEXP_g/r/i/z` columns. On 2026-10-01, the official DR10 files page still listed Coadd and Tractor products only under `south/`; both `north/survey-bricks-dr10-north.fits.gz` and `north/coadd/` returned 404. No North release roster or North file tree was found. The all-sky `survey-bricks.fits.gz` remains geometry only and must not be treated as DR10 North membership.

The summary schema documented by the same page is:

| Column group | Columns and documented types | Meaning |
|---|---|---|
| Identity and center | `brickname` char[8]; `ra`, `dec` float64 | Brick identity and center coordinates |
| Optical exposures | `nexp_g/r/i/z` int16; `nexphist_g/r/i/z` int32[11] | Median exposures and per-pixel exposure-count histograms in the unique `BRICK_PRIMARY` area; histogram bins are 0 through 9 and >10 |
| Source counts | `nobjs`, `npsf`, `nsimp`, `nrex`, `nexp`, `ndev`, `ncomp`, `nser`, `ndup` int32 | Counts of `BRICK_PRIMARY` objects overall and by Tractor morphology |
| Image quality/depth | `psfsize_g/r/i/z`, `psfdepth_g/r/i/z`, `galdepth_g/r/i/z` float32 | Median PSF size and 5-sigma point-source/galaxy depth by optical band |
| Dust/transparency | `ebv`, `trans_g/r/i/z`, `trans_wise`, `ext_g/r/i/z`, `ext_w1/w2/w3/w4` float32; `wise_nobs` int16[4] | Dust, transmission, and WISE exposure summary values |
| Coadd sky | `cosky_g/r/i/z` float32 | Estimated sky level in coadded images by optical band |

The release documentation describes `nexp_*` and `nexphist_*` in the **unique primary area**, not over every pixel in the full brick image. The table has no coadd/Tractor per-file URI column and no per-product file-presence flag.

The captured summary reports positive `NEXP` values for 349,806 g-, 325,134 r-, 289,484 i- and 336,611 z-band rows; 3,584 rows have zero exposure in all four optical bands. Runtime coadd matching uses only positive values in the requested roster row to select band-specific candidate URIs. A positive value is not evidence that the individual coadd or Tractor file exists.

### Filtering the geometric grid to DR10 South

For a query HEALPix cell, first find candidate `BRICKNAME`s by intersecting the full cell geometry with the all-sky brick boundaries (`RA1`, `RA2`, `DEC1`, `DEC2` in `survey-bricks.fits.gz`). Then inner-join those candidates by brick name to the `brickname` values present in `south/survey-bricks-dr10-south.fits.gz`. This filters geometric candidates to bricks represented in the DR10 South release summary without deriving any new brick IDs.

For an optical band-specific *exposure-evidence* refinement, use that band's `nexp_*` and `nexphist_*`; in particular, positive bins in `nexphist_<band>` show that pixels in the unique `BRICK_PRIMARY` region have that band exposure. Because these are summary statistics rather than exact file inventory, they must not be represented as proof that a particular image/weight/mask/Tractor file exists. Use the official path rule plus a source-side file check or file inventory for exact product presence. A zero-exposure statistic also says nothing about pixels in the brick's overlap area outside `BRICK_PRIMARY`.

The official source therefore supports a two-level local computation: geometric HEALPix-to-brick intersection followed by a release-specific join against DR10 South membership, including band-specific exposure evidence. In the Abell 2390 O8 cells `[202250,202272]`, the local matcher returns 11 South bricks each for Coadd and Tractor. It emits direct per-band candidate URLs, for example all four g/r/i/z URI rules for `3281p177`. Only sampled source checks establish file presence; other candidates remain unverified. The geometry table alone is insufficient for DR10 availability, and the South summary does not replace per-file verification.
