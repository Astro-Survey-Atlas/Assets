# Native-unit download sources and regional mirrors

Captured 2026-10-04 for the Dev spatial reverse-lookup plan. This note records
public file and directory entrypoints, mirrors, and the evidence behind each
status. Checks used `HEAD` requests or small directory listings; no science file
body was downloaded.

`accessUris[]` is one logical file/directory identity. A mirror is nested under
that entry as `alternatives[]`, so the same file does not appear as a duplicate
spatial unit. `sourceMetadata.entrypoints[]` keeps metadata or Products API
queries separate from downloadable files. `sourceMetadata.providerStatuses[]`
can retain a known repository whose data path is currently unavailable. The
flag identifies the provider's country; `servingRegion` separately records a
known delivery region or says that it is unknown. A CDN hostname or an
institution's country is not evidence for the exact serving node.

| Survey / product | File or directory source | Regional alternative and verification | Boundary |
| --- | --- | --- | --- |
| Gaia DR3 `gaia_source` | Exact `.csv.gz` file URL from the complete locked ESA roster; status `source-listed`. The checked `GaiaSource_048543-048681.csv.gz` returned HTTP 200 from ESA. | The same object path on `gaia.eu-1.cdn77-storage.com` returned HTTP 200; size and `Last-Modified` matched the ESA endpoint. Status `rule-derived`. The `eu-1` name is not treated as a verified country. | No catalog bytes were downloaded. The DR3 file range is the logical file identity; ESA and CDN77 are alternatives for it. |
| Euclid Q1 BGSUB VIS | ESA SAS-DD supplies the file-specific URL. | The IRSA AWS mirror directory `index.html#q1/MER/{tile_index}/VIS/` contains individual files. For Tile `102018211`, the directory listing and a matching BGSUB file returned HTTP 200. | The registered mirror rule is VIS-only. No NISP path is inferred. The separate `q1/VIS/2681/` prefix is live and lists a `GRD-PSF` file, but is not evidence for a BGSUB `tile_index`; it is not attached to these tile records. |
| Euclid ERO images | Per-target IPAC/IRSA directory `https://irsa.ipac.caltech.edu/data/Euclid/ERO/images/{target}/{ERO-target}/`. | All 17 target directories returned HTTP 200 and listed separate FITS files. The IC10 VIS file `Euclid-VIS-ERO-IC10-Flattened.DR3.fits` also returned HTTP 200 to `HEAD`. | The directory contains multiple bands and products. The compressed FITS member name in ESA's stack TAR is not reused as a mirror filename; the target directory is the truthful access unit. ESA TAR URLs remain geometry/provenance references and are not exposed as `accessUris`. Catalog downloads are not inferred from the image directory. |
| SDSS DR9 imaging | Official `data.sdss.org/sas/dr9/.../frame-{band}-{run}-{camcol}-{field}.fits.bz2` filename/path rule from the DR9 frame model. | The five bands for field `94/301/1/11` returned HTTP 200 to `HEAD` on 2026-10-03; a current g-band check also returned HTTP 200. Status remains `rule-derived` per generated field URI. | The URI rule does not prove every field file currently exists. Per-band access remains `unverified` until its exact URL is checked. |
| GALEX GR6/GR7 | The CAOM row's reported `dataURL` is retained as the file identity. For the checked AIS sample, changing the reported `http` scheme to `https` returned HTTP 200. | MAST Products API query is stored separately as a metadata entrypoint. | Never construct a filename from the observation ID or band. Only source-reported file-shaped paths are exposed. |
| JWST public calibrated images | A source-reported `mast:JWST/product/...` URI is converted through MAST's public `/api/v0.1/Download/file?uri=...` endpoint. The captured Carina MIRI sample returned HTTP 200 to `HEAD`. | The corresponding MAST Products API query remains a separate entrypoint. | Only archive-reported product identities are converted; planned/test observations and unrelated instruments/targets remain excluded. |
| HST public images | The locked observation snapshot currently supplies a MAST Products API query, not a file roster. | MAST remains an `entrypoint-only` source. | No product filename or direct file URL is guessed from an observation ID. |
| CASDC mirror | `https://casdc.china-vo.org/mirror/` currently returns HTTP 200. | The index names Gaia, GALEX and Euclid-Q1; their recorded target directories currently return HTTP 404. These are retained with country `CN` and status `unavailable`, ready to be rechecked after recovery. | A listed institution/repository is not presented as a usable file link while its target path returns 404. The download node location is unknown. |

### Runtime link behavior

The overlap response and JSON/CSV exports retain the same `accessUris[]`,
nested alternatives, MAST entrypoints and unavailable provider statuses. The
site shows the provider flag and a status badge for a verified file/directory,
source-listed URL, rule-derived URL, metadata entrypoint or unavailable mirror.
It does not fetch or proxy the science file. Users choose an available source
and download under that archive's access policy.

Provider flags use the user-selected public Icons8 CDN images, including
`https://img.icons8.com/color/48/usa-circular.png`, rather than platform-dependent
Unicode flag glyphs. US, CN, ES and JP have explicit circular-flag mappings;
unknown regions use a globe. CSP permits `img.icons8.com`, and the regional text
remains visible if a CDN image cannot load.

The Control Room does not currently edit these public mirror alternatives.
Maintain the resolver rules in `server/survey-access.ts` and verify each new
entry before adding it; keep the evidence and limits in this research note.
The native-source management page edits locked metadata inputs and is not the
editor for this public access list. Euclid Q1 VIS retains the checked IRSA AWS
directory pattern there; it does not infer a NISP path.

Warehouse source icons are configured on each Connector through the authenticated
Assets management API or the data-source detail UI. The icon can be an HTTP(S)
image, a site path, or an uploaded small raster (including the supplied ZJLab ICO).
The default type icon is shared by management and overlap. Uploaded images are
saved separately under immutable SHA-256 URLs; presentation state is archived
with Assets business state and does not alter a connection's scan configuration.

Selected-region file records resolve Connector identities from their own scan
runs or locked batch scopes. Batch resolution requires scope ID, evidence layer,
scope snapshot hash, partition count and product identity; a matching URI prefix
or layer-level label alone is insufficient. The Dev example Tile 102157301 NISP-H
file belongs to the retained `euclid-q1-mer-images-20260924` batch scope, which
identifies `euclid-q1-mer-catalog`. The source icon therefore comes from that
Connector. DESI batches use their corresponding real Connectors too. The
configured management namespace is `atlas-warehouse`, not the Assets workload
namespace; older absence checks against the latter did not establish that task
records were unavailable.

Attached and supporting scanned-file sources share the source-item layout,
retaining the actual URI and an authorization-required badge for OSS/S3/file
locators. Scan run IDs, snapshot hashes and association basis are expandable
provenance. JSON `connectors`, attached CSV `file_observations`, and supporting
CSV `source_metadata.connectors` preserve the same identities and icon URLs.
New queries use current Connector icons; frozen snapshots retain their captured
presentation. Unknown or conflicting provenance is kept unassociated. Icons and
scan evidence do not establish public retrieval availability or complete inventory.
NISP file paths come from actual normalized scans; the public AWS mirror resolver
remains VIS-only pending separate verification of NISP public paths.

For ERO, `geometryEvidence[].sourceUrl` and `sourceMetadata.archivePackageUris`
identify the official ESA packages from which bounded FITS-header evidence was
captured. They are provenance, not download links; the user-facing image link
is the IRSA target directory.
