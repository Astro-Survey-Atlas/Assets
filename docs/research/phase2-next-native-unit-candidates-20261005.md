# Next native sky-unit candidates, checked 2026-10-05

**FDS DR1 is the smallest next Dev increment with a reconciled official roster,
native field identities, per-image geometry and exact single-file URIs.** KiDS
DR5 is a useful second candidate; VPHAS+ DR4 is third because its incremental
release and 32-CCD union footprints need more work. These are implementation
recommendations based on the first-party documents and metadata probes below,
not deployed or imported indexes.

This research was read-only except for this note. It queried public documents,
ObsCore and DataLink metadata and used **HEAD only** on scientific files. It did
not read FITS pixels, submit management tasks, change bindings, deploy services,
change the public bundle/MOCs or alter 72602/Workspace. Diagnostic responses are
under `/tmp/assets-next-native-candidates-20261005/`; that directory is **not**
an immutable managed capture or archive.

## Published products checked

The Dev [coverage catalog](http://10.15.51.75:32083/api/v1/coverage/catalog)
returned 132 layers. The FDS, KiDS and VPHAS+ products below still reported
`sourceUnitIndex.status=entrypoint-only` when checked. Published identities, not
working registry names, must be used for candidate bindings.

| Priority | Existing published scope | Verified native metadata route | File access result | Remaining work |
| --- | --- | --- | --- | --- |
| 1 | FDS DR1, five imaging products | 97 unique science `dp_id` rows / 26 native `FDS_Fnn` fields; 97 J2000 polygons; 97/97 DataLink `#this` identities | Three representative ESO file HEADs passed | New FDS-specific adapter/registered source, SHA-locked capture, per-band bindings and normal managed review/archive/Dev activation |
| 2 | KiDS DR5, `DR5 gri imaging` | Official 1,347-Tile release; ESO DR5 g/r/i denominator 5,388 images including both i epochs; official source file list separately reconciles 6,735 ugrii2 images | Astro-WISE g file HEAD passed; the ESO sample timed out | Capture DR5-only polygons and all required DataLinks; join both sources by actual filename and retain i/i2; handle documented HTTP source honestly |
| 3 | VPHAS+ DR4, six imaging products | Exact DR4 submission gives 15,534 image rows; sample includes real field/exposure IDs and a 32-polygon J2000 union | ESO H-alpha file HEAD passed | Preserve DR4 increment, exposure identities and separate CCD polygons; capture complete metadata/DataLinks |

The catalog also exposed entrypoint-only products for ACT, AllWISE W3/W4,
Pan-STARRS DR1, NVSS, CFHTLS Wide, DECaPS DR2, IPHAS DR2, Rubin First Look,
SUMSS, WENSS, VIKING and ZTF DR7, plus historical HST/DECaLS gaps. They were
not newly audited against upstream inventories here and are not claimed ready.
DES DR2 and SPHEREx QR2 still had entrypoint-only labels in that same response,
although the preceding implementation batch included them; exclude them from
the next-source ranking and check their active runtime labels separately.
This catalog observation is not a claim that those prior inputs are absent.

## 1. FDS DR1: reconciled, bounded and direct-file capable

The [official ESO release description, ID 157](https://www.eso.org/rm/api/v1/public/releaseDescriptions/157)
identifies **Fornax Deep Survey DR1**, published 2020-08-26. Its release-content
section specifies **97 science files and 97 weight files** and describes native
fields/tiles of approximately one square degree. It also documents non-uniform
band availability and gaps from bright stars. Thus a list of fields or a merged
overview MOC must not imply that every field has every band or fully valid
pixels.

### Exact source selector and reconciliation

The live [ESO ObsCore TAP service](https://archive.eso.org/tap_obs/) returned
HTTP 200 for this complete diagnostic query:

```sql
SELECT dp_id, target_name, filter, obs_id, obs_creator_did,
       s_region, access_url, release_description
FROM ivoa.ObsCore
WHERE obs_collection = 'FDS'
  AND dataproduct_type = 'image'
  AND release_description =
      'https://www.eso.org/rm/api/v1/public/releaseDescriptions/157'
ORDER BY dp_id
```

The response was 59,698 bytes, SHA-256
`60847d6271dc481a824a8d1dc9caa94f0ef9e85093057f7082099e40ca7e0b08`,
and contained **97 rows / 97 unique `dp_id` / 26 distinct `target_name`**.
All rows had a non-empty **`POLYGON J2000`**, and all belonged to the exact
release-description selector above. A separate grouped count at the same
first-party TAP service reconciled the bands:

| Source filter | Science image rows | Normalized band |
| --- | ---: | --- |
| `u_SDSS` | 20 | U |
| `g_SDSS` | 26 | G |
| `r_SDSS` | 26 | R |
| `i_SDSS` | 25 | I |
| Total | 97 | |

The exact native field identifiers returned by ESO were:

```text
FDS_F1, FDS_F2, FDS_F4, FDS_F5, FDS_F6, FDS_F7,
FDS_F9, FDS_F10, FDS_F11, FDS_F12, FDS_F13, FDS_F14,
FDS_F15, FDS_F16, FDS_F17, FDS_F18, FDS_F19, FDS_F20,
FDS_F21, FDS_F22, FDS_F25, FDS_F26, FDS_F27, FDS_F28,
FDS_F31, FDS_F33
```

Preserve these identities verbatim as native **fields**, retaining `dp_id` as
the individual image identity. `obs_id` can contain a comma-separated list of
contributing exposures, so it is not a unique field or science-file identifier.
For example, the source row `ADP.2020-08-26T11:45:32.261` is `FDS_F10`,
`g_SDSS`, original filename `FDS_F10_OCAM_g_SDSS_sci.fits.fz`.
The exact `access_url` is a DataLink metadata response, not itself the FITS file.
[The corresponding first-party DataLink](https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?ADP.2020-08-26T11:45:32.261)
supplies the file link.

The grouped query over all FDS image releases also returned four images under
release-description **162**. Do not merge those into the DR1 selector just
because `obs_collection='FDS'` matches. Full roster acquisition should freeze
the query, independently record its denominator, use ordered `dp_id` keyset
pages with an explicit page budget/terminal receipt, and reject duplicate IDs
or source rows outside release 157.

### DataLink completeness and file semantics

All **97** release-157 science rows were checked against their own source-listed
ESO DataLink URL. All returned HTTP 200 and **exactly one `semantics=#this`**
record; there were **zero missing responses, zero missing `#this` records and
zero filename, file-ID or category mismatches**. Every record satisfied:

```text
eso_category = SCIENCE.IMAGE
eso_origfile = filename from that row's obs_creator_did
access_url = https://dataportal.eso.org/dataPortal/file/<that row's dp_id>
```

These are **source-listed** individual FITS files, not tar packages or a
constructed Tile directory. A collector should retain the actual `#this`
record and its raw response/hash; the observed URL equality is a cross-check,
not a reason to replace source resolution with an unvalidated path formula.
The sample [DataLink](https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?ADP.2020-08-26T11:45:32.261)
reports `content_length=260331840`,
`content_type=application/x-fits-hcompress` and
`eso_origfile=FDS_F10_OCAM_g_SDSS_sci.fits.fz`.

The same 97 responses each had one **`#auxiliary` / `ANCILLARY.WEIGHTMAP`**
identity. They also list cutout services, previews, progenitor metadata and a
derived catalog separately. Preserve those semantics in source evidence.
Do not count a weight map, preview, derived catalog or the DataLink document
as the matched science image, and do not fetch those science payloads to
establish the native index. No independently hosted FDS mirror was established
in this research.

The diagnostic aggregate `fds-datalink-all-results.json` records the source URL,
raw-response filename/hash, and returned links for each `dp_id`. Its SHA-256 is
`b2b84882cbc24780c7a3f972e978ef15fb4c1370bf94225d10ab3045756a7404`.
This diagnostic file is not a management manifest; acquisition must package
and hash the raw responses as durable evidence before import.

### Geometry contract

Every FDS DR1 polygon in the exact ESO response declares **J2000**, not ICRS.
Do not change the declaration by replacing the label. The next collector can
follow the existing [VVV collector's frame conversion](../../scripts/acquire_vvv_dr4_native_tiles.py):
parse the complete source polygon, transform `FK5(equinox=J2000.0)` vertices
to ICRS with Astropy, and retain both the original `sourceSRegion` and the
transformation description. This is an explicit implementation convention
for ESO's `J2000` declaration and must be recorded in the capture/review.
Retain each band's own polygon even where coordinates happen to coincide.
Returned geometry remains **estimated image-frame coverage**; the official
[DR1 description](https://www.eso.org/rm/api/v1/public/releaseDescriptions/157)
describes masked/bright-star gaps, and this research did not inspect masks or
valid pixels. HEALPix NESTED candidate buckets must still be followed by actual
polygon-region intersection; no finer coverage should be inferred from the
existing product's overview cells.

### Representative access checks

Only HEAD was used on these source-listed FITS URIs. The first FDS g request
timed out at 25 seconds; a second request with a 45-second limit passed.
Retain both outcomes if importing the probe receipt. The final results were:

| Source-listed FITS URI | HEAD result | Content length |
| --- | --- | ---: |
| [FDS_F10 g, ADP.2020-08-26T11:45:32.261](https://dataportal.eso.org/dataPortal/file/ADP.2020-08-26T11:45:32.261) | 200, `application/octet-stream` | 260,331,840 |
| [FDS_F10 r, ADP.2020-08-26T11:45:32.265](https://dataportal.eso.org/dataPortal/file/ADP.2020-08-26T11:45:32.265) | 200, `application/octet-stream` | 261,348,480 |
| [Last ordered science record, ADP.2020-08-26T11:45:32.453](https://dataportal.eso.org/dataPortal/file/ADP.2020-08-26T11:45:32.453) | 200, `application/octet-stream` | 259,657,920 |

These checks establish representative route availability. **97/97 DataLink
identities does not mean 97/97 files were HEAD-checked**, and neither test
validates science bytes/checksums. URI availability for unprobed files must
remain unverified even if the declared metadata roster is complete.

### Exact manager envelope and required FDS extension

The current [survey manifest loader](../../server/survey-native-index.ts) accepts
a `schemaVersion: 1` envelope with registered adapter/survey/release identity,
ISO `capturedAt`, `coordinateFrame: ICRS`, `ordering: NESTED`, non-empty
`metadataDocuments`, SHA/size-locked `rowFiles`, and an exact `rowCount`.
Row files are gzip NDJSON; references are relative to the manifest and cannot
escape its directory. The [worker](../../server/native-unit-worker.ts) imports
**one manifest**, then validates all dependencies; the authenticated
[controller](../../server/native-unit-controller.ts) accepts this task body:

```json
{
  "operation": "import",
  "sourceId": "<registered FDS source ID>",
  "sourceRevision": "<current numeric revision>",
  "files": [{
    "ref": "<evidence-root-relative directory>/manifest.json",
    "sha256": "<actual 64-character SHA-256 of staged manifest>",
    "sizeBytes": "<actual positive integer byte count>"
  }]
}
```

This is a schema template, not a ready-to-send request. The route is
`POST /api/v1/admin/native-units/tasks`; no management call was made here.
Current source allowlisting and `eso-obscore-vvv` validation explicitly require
**VVV / vista-vvv-dr4 / release 80 / bNNN or dNNN / H,J,Y,Z,Ks**. Consequently
an FDS capture **cannot currently be imported by relabelling it as VVV**.
Register `fds` as a supported public survey and add an explicit FDS adapter
(for example `eso-obscore-fds`) with frozen DR1 rules, leaving all installed
VVV inputs/rules intact. The registered source should point to ESO
`https://archive.eso.org/tap_obs/sync`, declare `unitKind=field`, and use
`surveyId=fds`, `releaseId=fds-dr1`.

Recommended FDS-specific envelope fields, in addition to the manager contract:

```text
nativeCoordinateFrame: J2000
scope.obsCollection: FDS
scope.releaseDescription: https://www.eso.org/rm/api/v1/public/releaseDescriptions/157
scope.dataproductType: image
scope.filters: [u_SDSS, g_SDSS, r_SDSS, i_SDSS]
scope.expectedRowCount: 97
scope.expectedFieldCount: 26
scope.bandCounts: {U: 20, G: 26, R: 26, I: 25}
scope.scienceImagesOnly: true
scope.validPixelMasksChecked: false
rowCount: 97
sourcePagination: frozen queries, denominator, actual ordered pages,
                  terminal/QUERY_STATUS receipt, DataLink requested/listed/errors
metadataDocuments: release PDF, denominator, raw TAP pages, raw DataLink evidence,
                   transformation/access contract and HEAD receipts
rowFiles: SHA/size/rows-locked gzip NDJSON
```

Each normalized row should preserve:

```text
unitId: exact source target_name, e.g. FDS_F10
sRegion: transformed POLYGON ICRS
bands: one actual normalized band, e.g. [G]
filename: source-listed eso_origfile
sourceMetadata:
  dpId, obsId, obsCreatorDid, sourceTargetName,
  filter (original g_SDSS), nativeCoordinateFrame (J2000), sourceSRegion,
  geometryTransform, releaseDescription, dataLinkUrl,
  dataLinkResponseSha256, dataLinkListed, esoOriginalFile,
  contentLength, accessSemantics (whole-science-image)
accessUris:
  exactly that row's DataLink #this URI,
  fileName, normalized band, accessType=file
```

Use row-level `dp_id`/filename uniqueness and per-band field membership checks;
aggregate multiple files under a field without discarding their identities.
`queryPagesComplete` must require both complete TAP capture and resolved
DataLinks. `inventoryComplete=true` is justified **only for the declared
97-science-image DR1 selector** after its denominator, field/band counts and
all dependencies have been locked and validated; it must not imply valid-pixel
completeness, per-file availability, weight-map/catalog inventory or a complete
current FDS archive. A deliberately bounded subset must use
`inventoryComplete=false` and state the subset.

Published Dev binding identities from the catalog were:

| Product | Product ID | Layer ID |
| --- | --- | --- |
| FDS DR1 color imaging | `0c56e9d4a4960d2c40b5` | `fds-fds-dr1-fds-dr1-color-imaging-moc` |
| FDS DR1 g-band imaging | `78d6987bba17d90b6681` | `fds-fds-dr1-fds-dr1-g-band-imaging-moc` |
| FDS DR1 i-band imaging | `f51a23afb7dcba9ed0ac` | `fds-fds-dr1-fds-dr1-i-band-imaging-moc` |
| FDS DR1 r-band imaging | `73429418c389a40816cd` | `fds-fds-dr1-fds-dr1-r-band-imaging-moc` |
| FDS DR1 u-band imaging | `d6832b7f0ea166e83d81` | `fds-fds-dr1-fds-dr1-u-band-imaging-moc` |

Bind each band product to its actual filter. An aggregate color result can
group explicitly selected, source-backed bands but must not invent an RGB
FITS file or borrow another band's footprint; confirm its intended band scope
against the published product before activation. Use the existing
[managed native-unit workflow](../native-unit-management.md) for import,
candidate build, review, complete dependency archive, synchronized control
state, Dev-only activation and public HTTP verification. This note does not
authorize new public MOC publication or imply those steps have happened.

## 2. KiDS DR5: native Tiles plus two official storage sources

The [KiDS DR5 overview](https://kids.strw.leidenuniv.nl/DR5/index.php) and
[ESO release description 229](https://www.eso.org/rm/api/v1/public/releaseDescriptions/229)
identify 1,347 survey Tiles, u/g/r single-epoch stacks and two i epochs. The
release document says DR5 supersedes earlier releases. The
[official access page](https://kids.strw.leidenuniv.nl/DR5/access.php) points to
both ESO and Astro-WISE and explains that FITS metadata/headers can differ.
These should therefore be recorded as two source representations, not claimed
byte-identical mirrors.

At [ESO TAP](https://archive.eso.org/tap_obs/), the exact filter
`obs_collection='KIDS' AND dataproduct_type='image' AND
release_description='https://www.eso.org/rm/api/v1/public/releaseDescriptions/229'`
returned grouped counts **u=1,347, g=1,347, r=1,347, i=2,694**. For the
existing gri product, that is **5,388** metadata rows. A release-specific
five-row probe returned `KIDS_195.5_-3.5`, distinct science `dp_id` values,
actual J2000 polygons and both
`KiDS_DR5.0_195.5_-3.5_i_sci.fits` and
`KiDS_DR5.0_195.5_-3.5_i2_sci.fits`. Preserve both epochs; a filter-only key
would collapse distinct files.

The [source-owned science wget list](https://kids.strw.leidenuniv.nl/DR5/kids_dr5.0_sci_wget.sh)
was retrieved as text only. It contained **6,735 unique URIs / 1,347 Tiles**,
with 1,347 each in u/g/r/i/i2; SHA-256
`e6954de31be9e75a9fd40733c88d7544659876b9106577e7fcd83e40896564b4`.
This is an independent file-roster join opportunity, not a geometry source.
Resolve ESO DataLink and match the source-listed filenames before associating
the second source with a Tile; do not guess which reduction a similarly named
file belongs to. The supplied shell script was **not executed**.

For `KIDS_195.5_-3.5` g, the official
[ESO DataLink](https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?ADP.2024-12-13T18:08:20.831)
returned one `#this` / `SCIENCE.IMAGE`, filename
`KiDS_DR5.0_195.5_-3.5_g_sci.fits`, 1,500,719,040 bytes. The associated
[ESO FITS URI](https://dataportal.eso.org/dataPortal/file/ADP.2024-12-13T18:08:20.831)
timed out during this 25-second HEAD check. The exact
[Astro-WISE URI listed by KiDS](http://ds.astro.rug.astro-wise.org:8000/KiDS_DR5.0_195.5_-3.5_g_sci.fits)
passed HEAD, **HTTP 200 / `image/fits` / 1,500,719,040 bytes**. No bytes were
downloaded to compare the two representations.

The Astro-WISE URI is **HTTP**, as documented; current
[survey-native URI normalization](../../server/survey-native-index.ts) accepts
HTTPS only. A later implementation must deliberately retain/support the
source-listed HTTP representation or keep it as explicit provenance. Do not
silently convert it to an unverified HTTPS route. Full 5,388-row geometry,
DataLink completeness, all filename joins and per-file availability remain
unverified. The existing Dev binding is product `8bad9526a39794a56eff`, layer
`kids-dr5-color-footprint`, `surveyId=kids`, `releaseId=kids-dr5`.

## 3. VPHAS+ DR4: real native exposures, larger geometry work

The [survey's data page](https://www.vphasplus.org/data.shtml) and
[ESO release description 145](https://www.eso.org/rm/api/v1/public/releaseDescriptions/145)
explicitly identify DR4 as the **final incremental release**, not an all-history
replacement. The document gives **15,534 images** and describes reduced,
unstacked native **32-CCD OmegaCAM pawprints**. Later reverse lookup must not
label these files as stacked images or claim every field has all bands.

At [ESO TAP](https://archive.eso.org/tap_obs/), exact
`obs_collection='VPHASplus'`, image, release-description-145 grouped counts
were **g=3,829, i=1,876, NB_659=2,835, r=4,437, u=2,557**, totaling 15,534.
The exact DR4 sample returned field `vphas_0418`, distinct
`ADP.2019-10-07T14:31:45.774/.777` files and a **32-polygon `UNION J2000`**
for each file. Both sample rows share `obs_id=1001970`; use the distinct
`dp_id`/original file identity, not `obs_id` alone, when retaining exposures
and associating them with the native field.

The sample
[DataLink](https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?ADP.2019-10-07T14:31:45.774)
returned one `#this`, filename `o20151119_00083.fits.fz`,
`eso_category=SCIENCE.MEFIMAGE`, 160,683,840 bytes. Its
[source-listed FITS URI](https://dataportal.eso.org/dataPortal/file/ADP.2019-10-07T14:31:45.774)
passed HEAD: **HTTP 200 / `application/octet-stream` / 160,683,840 bytes**.
This verifies one image route; no full DR4 DataLink roster was captured.

The existing VVV conversion helper accepts a single polygon and cannot safely
be reused verbatim for this union. Preserve every CCD polygon, transform its
J2000 frame explicitly, and maintain the union rather than filling CCD gaps
with a single corner rectangle. Keep precision estimated until supported
valid-pixel evidence exists. A first input can freeze the exact 15,534-row
DR4 submission with `inventoryComplete=false` for cumulative DR4; including
earlier releases requires separate, source-backed membership reconciliation.

## 4. VIKING DR1: real Tile files, unresolved release denominator

The [ESO release description 24](https://www.eso.org/rm/api/v1/public/releaseDescriptions/24)
is titled **VIKING Data Release 1**. It declares 151 survey Tiles (226 deg²)
and defines a VISTA Tile as six offset pawprints combined to fill the detector
gaps. This is the correct native unit; individual pawprint polygons must not
be presented as Tile footprints. The matching Dev product is
`vista-viking-j-footprint`, product `8cdeedbe0a9dbfe93f5d`, layer
`vista-viking-j-footprint`.

At ESO TAP, the exact selector `obs_collection='VIKING'`,
`dataproduct_type='image'` and release description 24 returned H=8, J=422,
Ks=17, Y=31 and Z=17 rows. J separates into **110 Tile-image rows** with no
`dataproduct_subtype` and **312 pawprint rows**. Restricting `target_name LIKE
'viking%'` yields 72 J Tile-image rows plus 204 J pawprint rows; the other
`sample...` targets account for additional J records. The release description
declares 151 survey Tiles, so neither the 110-row J tile subset nor the
72-row `viking...` subset reconciles the official Tile count. Do not call this
full VIKING J coverage or activate it as a complete inventory until membership
and omissions are understood. It remains a bounded candidate with exact
source identities and estimated image-frame geometry.

For `vikingJKH_gama09_1_2_4`, `dp_id=ADP.2013-06-13T08:59:50.083` and
source filename `viking_er1_08h54-000d28_tile_j_image_565147.fits.fz`, the
source-listed ESO DataLink returned one `#this` / `SCIENCE.IMAGE` file at
`https://dataportal.eso.org/dataPortal/file/ADP.2013-06-13T08:59:50.083`
(114,114,240 bytes). Its representative HEAD returned HTTP 200 and
`application/octet-stream`. The source row preserves a single `POLYGON J2000`
Tile footprint, which can be transformed with the explicit FK5/J2000
convention; it does not verify valid-pixel coverage or all-file availability.

## Diagnostic reproducibility and limits

All TAP requests used `REQUEST=doQuery`, `LANG=ADQL`, `FORMAT=csv` at
`https://archive.eso.org/tap_obs/sync`; reported count probes group by
`release_description, filter`, and the full FDS row query is given above.
The FDS DataLink evidence consists of 97 source-listed metadata responses;
each raw XML has its own SHA in `fds-datalink-all-results.json`. Source PDF
hashes were:

| First-party source | Bytes | SHA-256 |
| --- | ---: | --- |
| [FDS DR1, 157](https://www.eso.org/rm/api/v1/public/releaseDescriptions/157) | 785,828 | `1c309075b9e8ee60064211eeaa8ef87e4f2f8bc620b32f2d48055fe8f7131f50` |
| [KiDS DR5, 229](https://www.eso.org/rm/api/v1/public/releaseDescriptions/229) | 810,859 | `e1453414937517d2a16ddba41fa93ea33a6916b1d05eded23c369a2102a65939` |
| [VPHAS+ DR4, 145](https://www.eso.org/rm/api/v1/public/releaseDescriptions/145) | 320,353 | `d3ae0c5ae25e8f05d4fd8fc136628bda9019f26587b370be983434825697f1a4` |

ESO's generic Phase 3 release-list page returned HTTP 403 and an attempted
generic programmatic documentation URL returned 404. Neither failure prevented
the release PDFs, TAP or DataLink checks above. An attempted WISE programmatic
guide URL also returned 404; AllWISE is not ranked from that failed probe.
These are access observations, not evidence that those surveys lack data.

This note establishes **FDS metadata acquisition feasibility**, representative
file availability, and bounded next-source options. It does not replace a
durable immutable capture, registered adapter validation, archived dependencies,
review, managed activation or runtime/site checks. Follow the
[coverage workflow](../coverage-workflow.md) and
[native-unit management](../native-unit-management.md) for implementation;
retain every identity, original declaration and unresolved limitation.
