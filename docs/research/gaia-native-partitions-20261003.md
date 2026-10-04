# Gaia DR3 native partition metadata, 2026-10-03

The Gaia DR3 main-source table has a usable official native file partition
inventory: **3,386 files**, each identified by an inclusive **NESTED HEALPix
order-8 range**. The staged metadata is intended for the **Dev native sky-unit
workflow**. Import, candidate construction, review, dependency archive and
runtime/site activation are owned by the managed workflow; acquisition alone
does not establish an active version.

## Official partition identity and coordinates

ESA's bulk-download tutorial explicitly states that the entire `(E)DR3`
`gaia_source` table is divided into 3,386 ranges of HEALPix level-8 indexes.
The filename suffix contains the first and last included indexes. Its example
`GaiaSource_000000-003111.csv.gz` contains sources associated with indexes
**0 through 3111, inclusive**. The tutorial says that an entirely empty range
does not produce a file, so file membership must come from the directory roster,
rather than manufacturing a filename for an arbitrary range. [1]

The Gaia DR3 `source_id` data model defines the approximate equatorial **ICRS**
position using the **nested HEALPix scheme at level 12** (`Nside=4096`) in bits
36–63. It gives the lower-order conversion as integer division
`source_id / 2^(59 - 2*n)` for level `n`. In particular, the corresponding O8
pixel is `floor(source_id / 2^43)`. The file partition is O8; the existence of an
O12 encoding inside a source identifier does not make the file inventory O12.
The same data model warns that source identifiers need not be stable across
releases, so a DR3 identity must retain its release. [2]

ESA's official bulk-download notebook independently implements
`HEALPix(nside=2**hpx_level, order='nested')`, derives O8 file ranges from the
filenames, and converts lower/higher levels with bit shifts. Its cone parameters
are explicitly ICRS. [3] The DR3 reference epoch is J2016.0. [4]

Recommended native identity and record fields:

| Field | Example / meaning |
| --- | --- |
| `surveyId`, `releaseId` | `gaia`, `gaia-dr3` |
| `unitKind`, `unitId` | `healpix-partition`, `GaiaSource_000000-003111` |
| `nativeOrder`, `ordering`, `coordinateFrame` | `8`, `NESTED`, `ICRS` |
| `firstIpix`, `lastIpix` | `0`, `3111`, both inclusive |
| `filename` | Original `GaiaSource_000000-003111.csv.gz` |
| `url` | Exact CDN URL emitted by the official file browser |
| `sizeBytes` | Source directory object's declared compressed size |
| `sourceMd5` | Checksum from official `_MD5SUM.txt`, unverified against science bytes |
| `sourceEtag`, `lastModified` | Source object metadata, retained without treating ETag as a checksum |

At O4, a queried NESTED cell `p` has O8 descendants
`[p*256, (p+1)*256-1]`; a file is a candidate when its actual filename range
intersects that interval. At O8, test whether the requested pixel is contained
in the file range. For finer query cells, compare their O8 parent to the same
native range and return **native order 8**, preserving the coarser partition
scope. This is exact interval arithmetic on the documented nested hierarchy;
it does not infer sub-file object presence. [1–3]

## Captured inventory and acquisition boundary

The current official CDN serves a JavaScript file browser. Its own script
delegates directory metadata to
`https://gaia.eu-1.cdn77-storage.com/?prefix=Gaia/gdr3/gaia_source/&delimiter=/`
and follows the S3 ListObjects V1 `NextMarker`. Its file links use
`https://cdn.gea.esac.esa.int/` plus the returned object key. The collector uses
that published metadata mechanism, not a guessed science-file listing. [5]

The captured directory has four pages. The terminal page declares
`IsTruncated=false`. It contains 3,386 catalog objects and `_MD5SUM.txt`.
All science filenames are unique, and their inclusive intervals are contiguous
with no gaps or overlaps across `[0, 786431]`, the 786,432 order-8 cells.
The listed science files total **753,025,661,884 compressed bytes**. These are
directory assertions captured on 2026-10-03, not locally downloaded files. [6]

The official `_MD5SUM.txt` contains a checksum for every one of the 3,386
listed catalog files. Its additional `_MD5SUM.txt` self entry is not used to
authenticate its own bytes; the captured metadata document has an independent
SHA-256 in the input manifest. ESA documents `_MD5SUM.txt` as the means for
users to verify science data after they retrieve it. Assets has not retrieved
the science data or verified those science checksums. [1, 6]

The new
[`acquire-gaia-partitions.py`](../../scripts/acquire-gaia-partitions.py)
has an explicit metadata URL allowlist. It reads only bounded documentation,
plain-text checksum/license/readme metadata and directory XML. It refuses
catalog URLs, redirects outside the declared metadata endpoints, HTML fallback
for a `.txt` resource, duplicate/out-of-scope keys, broken continuations,
filename/checksum mismatches and invalid/noncontiguous native intervals.
It stages the primary JSON and all referenced documents with SHA-256, byte
size, URL and capture time for a subsequent authenticated management import.

Run it with a fresh evidence directory:

```bash
python3 scripts/acquire-gaia-partitions.py --output /path/to/new/gaia-evidence
```

The primary JSON explicitly records `nativeOrder=8`,
`fileRosterComplete=true`, `scienceContentVerified=false` and
`estimatedPosition=true`. Complete membership applies only to the
**DR3 `gaiadr3.gaia_source` bulk-file roster at the capture date**. It is not a
claim about all Gaia tables, exposures, spectra or all underlying science
contents. The inventory captures no catalog rows or scientific pixels.

The staged primary input is
`managed-input/gaia-dr3-partitions.json`, **1,799,568 bytes**, SHA-256
`b39d156a72d3b6910228b76c453acdd060a3527fc5d198f30e0a9824cd854a7a`.
Its **14 referenced metadata documents** total **2,174,044 bytes** and have
all passed independent byte-size and SHA-256 checks. The roster capture ends
at `2026-10-03T08:48:19.196147+00:00`; the manifest was assembled at
`2026-10-03T08:59:29.649837+00:00`. Original response bytes and each capture's
timestamp remain attached. The recovered timestamps explicitly identify their
evidence as the original persisted file modification time, rather than
presenting the earlier roster as newly fetched. A subsequent fresh listing
attempt encountered connection timeouts on the delegated storage host;
the complete original four-page capture was reused after verifying its
original URL, SHA and byte size.

Eight metadata checks pass in
`managed-input/metadata-validation.json`: complete dependency hashes,
science/foreign URL refusal, duplicate-checksum refusal, reconstruction of
all 3,386 actual file identities, missing/changed filename refusal, and
native interval boundary/parent checks. O4 cell `[190]` corresponds to O8
`[48640,48895]` and matches the three source ranges
`GaiaSource_048543-048681`, `GaiaSource_048682-048814`, and
`GaiaSource_048815-048922`. The adjacent O8 boundary samples `[3111]` and
`[3112]` return different original files. O10 children `[49791]` and `[49792]`
retain these same O8 file identities and native order; they do not add finer
scientific spatial evidence. These checks validate metadata selection, not
downloaded catalog contents or an activated runtime.

## Precision, access and release limits

The filename-to-range association and the local interval calculation are
deterministic. **The scientific spatial association remains estimated**:
`source_id` encodes an approximate position, and an intersected O8 partition
can contain objects outside the selected region while empty subregions can
occur inside the partition. Use catalog coordinates or the Gaia Archive for
scientific source selection. A native file candidate must not be described as
an image footprint or as an object-presence measurement for every point in
its range. [1, 2]

Gaia DR3 bulk files are gzip-compressed enhanced CSV containing metadata comment
headers followed by catalog contents. The repository disclaimer says the Gaia
Archive, rather than the bulk dump, is the authoritative data/metadata
reference. Keep the original file URI and the official Archive entrypoint
visible. Users obtain files themselves under source terms. [1, 7]

ESA states that Gaia data are distributed under **CC BY-NC 3.0 IGO**, with
commercial-use guidelines in the ESA science archive terms. The official
repository `_citation.txt` points to ESA's Gaia/DPAC acknowledgment guide. [8]

The release-scenario page lists the Focused Product Release as **10 October
2023**, and schedules the full DR4 release for **2 December 2026**. DR4's
future expected tables must not be inserted as an available DR4 file inventory
on the date of this capture. [9] A public June 2026 DR4 pre-release does exist:
ESA provides astrometric time-series examples for **12 selected sources** and
a draft data model. Its page supplies individual source identities and a
science XML download, not a verified all-sky native file-partition roster.
It must be treated as that small, explicitly separate sample. [10]
The FPR is already public and contains separate products. In particular, ESA
describes its **526,587-source** Omega Centauri SIF crowded-field catalog as an
add-on to the nominal Gaia catalog. The public FPR directory's terminal listing
contains `Crowded_fields`, `Extra-galactic`, `Solar_system`, `Spectroscopy` and
`Variability` trees; it does not list a replacement all-sky `gaia_source` tree.
That directory metadata was inspected without reading the catalog contents.
It is a possible later source-specific supplementation, with its own product
and spatial metadata, rather than evidence that the DR3 main roster should be
renamed or replaced. [11] The DR3 main-table partitions documented here
retain their DR3 identity.

## Primary sources and captured evidence

1. [ESA Gaia Archive — Extract data, Bulk Download tutorial](https://www.cosmos.esa.int/web/gaia-users/archive/extract-data#bulk_download).
2. [ESA Gaia DR3 data model — `gaia_source`, `source_id`](https://gea.esac.esa.int/archive/documentation/GDR3/Gaia_archive/chap_datamodel/sec_dm_main_source_catalogue/ssec_dm_gaia_source.html#source_id).
3. [ESA Gaia Jupyter notebooks — official `(E)DR3` bulk-download tutorial](https://github.com/esa/gaia-jupyter-notebooks/blob/main/data-release-3-tutorials/tutorial_bulk_download_e-dr3.ipynb).
4. [ESA Gaia DR3 contents and coordinate/reference-epoch description](https://www.cosmos.esa.int/web/gaia/dr3).
5. [Official Gaia CDN file browser](https://cdn.gea.esac.esa.int/?prefix=Gaia/gdr3/gaia_source/), including its own delegated listing endpoint and pagination code.
6. [Delegated current directory listing](https://gaia.eu-1.cdn77-storage.com/?prefix=Gaia/gdr3/gaia_source/&delimiter=/) and [official checksum metadata](https://cdn.gea.esac.esa.int/Gaia/gdr3/gaia_source/_MD5SUM.txt). Exact response bytes and all continuation URLs are stored outside Git; counts above are computed from this captured metadata.
7. [Official DR3 README](https://cdn.gea.esac.esa.int/Gaia/gdr3/_readme.txt) and [bulk-dump disclaimer](https://cdn.gea.esac.esa.int/Gaia/gdr3/_disclaimer.txt).
8. [ESA Gaia data license](https://www.cosmos.esa.int/web/gaia-users/license), [official repository license reference](https://cdn.gea.esac.esa.int/Gaia/gdr3/_license.txt), [citation metadata](https://cdn.gea.esac.esa.int/Gaia/gdr3/_citation.txt) and [ESA Gaia credits](https://www.cosmos.esa.int/web/gaia-users/credits).
9. [ESA Gaia data-release scenario](https://www.cosmos.esa.int/web/gaia/release) and [expected Gaia DR4 contents](https://www.cosmos.esa.int/web/gaia/dr4).
10. [ESA Gaia DR4 pre-release](https://www.cosmos.esa.int/web/gaia/dr4-prerelease), whose 12-source metadata page was inspected; its science XML was not requested.
11. [ESA FPR contents](https://www.cosmos.esa.int/web/gaia/fpr), [FPR overview](https://www.cosmos.esa.int/web/gaia/focused-product-release) and [official delegated FPR directory metadata](https://gaia.eu-1.cdn77-storage.com/?prefix=Gaia/gfpr/&delimiter=/). The captured directory response and SHA receipt are `gfpr-root-list.xml` / `gfpr-root-list-receipt.json` outside Git; capture used an HTTPS request over SSH to the reachable network, with full certificate verification.

External evidence root:
`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-other/gaia/`.
The `managed-input/` subdirectory contains the collector's JSON and dependency
files; initial browsing captures and the official notebook are additional
research evidence. Raw metadata and the 3,386-file roster remain outside Git.
