# Native radio map inventories, checked 2026-10-06

**NVSS, SUMSS and WENSS now have reachable, enumerated whole-map sources at
NASA SkyView.** Their explicit XML inventories contain **2,326 + 748 + 493 =
3,567 distinct map paths**. These are named FITS maps, not generated cutouts,
HiPS tiles or tar packages. Representative exact inventory URLs returned
HTTP 200 to HEAD, and their actual FITS headers were read with validated HTTP
206 ranges. The inventories resolve the radio-source discovery blockers in
[the earlier residual-survey audit](phase2-residual-native-surveys-20261006.md).

The initial audit below was research-only. The capture addendum records a
subsequent metadata-only inventory acquisition; it still does not publish a
MOC, modify the public bundle, update 72602 or Workspace, or read scientific
pixels. The original `capture1` remains unchanged. A corrected, importer-ready
`capture2` has passed local adapter validation, but it has not yet been copied
to the Dev evidence PVC or imported through the managed API.

## Metadata capture addendum (2026-10-06)

All three published XML rosters were captured with the exact map identities
and per-map FITS header evidence. Header requests returned validated HTTP 206
ranges for all 3,567 entries, and every header produced an ICRS frame
footprint. No scientific pixels were requested, decoded or saved
(`pixelBytesRead=0`). This verifies those header ranges at capture time, not
full-file downloads, valid-pixel masks or image-data integrity.

Capture directory:
`/home/aaron/.local/share/astro-assets-deployments/dev/20261006-radio-native-capture1/`.
Each manifest and its dependent XML, header evidence and normalized rows are
SHA/size-locked under that directory:

| Survey | Manifest SHA-256 | XML roster rows | Header / geometry failures | WENSS frequency conflicts |
| --- | --- | ---: | ---: | ---: |
| NVSS | `6d8f18326151f10a37c7a5e2af40af1e02fc36d5fcc583dc7214b74a5e7a14a4` | 2,326 | 0 / 0 | 0 |
| SUMSS | `753d2b160caba9d4cdfe1d81ffbae75989a8f8448efaf440230bae8b28e92bb6` | 748 | 0 / 0 | 0 |
| WENSS | `6720d1170caad85d26c0dfe40ebf9e63ee519f163f50ad1729c1050bf154684e` | 493 | 0 / 0 | 107 |

The input scope remains narrower than a complete survey inventory: NVSS is the
SkyView I-plane roster; SUMSS is the exact Galactic/Extragalactic mosaic roster;
WENSS is the HIGHRES map roster. `inventoryComplete=false` is retained even
though each declared XML roster was fully parsed. Producer country and mirror
country remain separate (NRAO/US, Sydney/AU, WENSS/NL; SkyView mirror/US).
For the 107 WENSS spectral conflicts, the publisher's 325 MHz identity and the
raw FITS `CRVAL3=609585595.238 Hz` metadata are both retained without
correction.

### Corrected import package

The immutable original manifests remain in `20261006-radio-native-capture1/`.
The importer requires each normalized row's actual WCS footprint under
`sourceMetadata.footprint`; the first staging omitted that field. The corrected
`20261006-radio-native-capture2/` adds the derived ICRS footprint to every row
and passed complete local manifest/row validation for all three adapters.
`capture1` was not overwritten. Capture2 is still only staged metadata, not an
imported or active Dev index.

| Survey | Capture1 manifest SHA-256 | Capture2 manifest SHA-256 | Normalized rows SHA-256 | Rows | Footprint rows repaired | Header / geometry failures | Spectral conflicts |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| NVSS | `6d8f18326151f10a37c7a5e2af40af1e02fc36d5fcc583dc7214b74a5e7a14a4` | `1865fac107a6933a6c5473132ee2c4480aebc16fc640aab7297bd60f4e564b07` | `f0a8ffa6ec58b99edbb3926a670b457a7915c963bc8626eff7becdbe7e692c40` | 2,326 | 2,326 | 0 / 0 | 0 |
| SUMSS | `753d2b160caba9d4cdfe1d81ffbae75989a8f8448efaf440230bae8b28e92bb6` | `dfdcae60bd941ce9477bfea535b46e518440e29690aaea26413c4eadd2963254` | `ef3860579932cca3576b4c1625483cbe3ee20e65055a59a29db83f80f8dcfa17` | 748 | 748 | 0 / 0 | 0 |
| WENSS | `6720d1170caad85d26c0dfe40ebf9e63ee519f163f50ad1729c1050bf154684e` | `04394ea5850f91209ae2883424574d8bcc390d89485104664ce0415ce665cd4d` | `18cdd307ba638b6d5ae084e121fa8f89b89f938fad01758d27e0fa4ef689eae2` | 493 | 493 | 0 / 0 | 107 |

Capture2 directories are under
`/home/aaron/.local/share/astro-assets-deployments/dev/20261006-radio-native-capture2/`.
The row hashes cover the normalized compressed NDJSON files. Each manifest
locks its XML roster, per-map header evidence and normalized rows. The 107
WENSS raw frequency conflicts remain unchanged from capture1 and are not
silently corrected.

Any status change must be recorded after managed import, build, review, archive
and site-level activation verification.

## Inventories and source identities

The [SkyView manifest](https://skyview.gsfc.nasa.gov/current/jar/surveys/survey.manifest)
explicitly lists `surveys/xml/nvss.xml.gz`, `surveys/xml/sumss.xml.gz` and
`surveys/xml/wenss.xml.gz`. These are configuration/inventory metadata for
[SkyView in a JAR](https://skyview.gsfc.nasa.gov/current/docs/skyviewinajar.html),
not the generated images returned by its query service.

| Assets survey / release | Enumerated whole-map inventory | Original producer / provenance | Reachable mirror |
| --- | --- | --- | --- |
| `nvss` / `nvss-final` | [NVSS XML](https://skyview.gsfc.nasa.gov/current/jar/surveys/xml/nvss.xml.gz): 2,326 `Images/Image` rows, 2,326 unique paths and cache names, no duplicate paths | NRAO, US. XML explicitly says SkyView copied **intensity** data from NRAO FTP; the full original release has additional Stokes planes | NASA/GSFC SkyView, US; original named I-only maps |
| `sumss` / `sumss-final` | [SUMSS XML](https://skyview.gsfc.nasa.gov/current/jar/surveys/xml/sumss.xml.gz): 748 rows and unique paths/cache names; **119 Galactic + 629 Extragalactic** | SUMSS project team, University of Sydney, AU. XML describes slightly overlapping mosaics assembled from up to 17 observations and says data were last updated 2015-01-28 | NASA/GSFC SkyView, US; original named mosaics, preserving their Galactic/Extragalactic paths |
| `wenss` / `wenss-final` | [WENSS XML](https://skyview.gsfc.nasa.gov/current/jar/surveys/xml/wenss.xml.gz): 493 rows and unique paths/cache names, **444 `wn` + 49 `wp`**, no duplicate paths | WENSS team, NFRA/ASTRON and Leiden Observatory, NL. XML explicitly records acquisition from `ftp://vliet.strw.leidenuniv.nl/pub/wenss/HIGHRES/` on **1999-03-18** | NASA/GSFC SkyView, US; named HIGHRES maps in its publisher-described 325 MHz survey snapshot |

All 3,567 rows matched their observed name pattern and the expected four
whitespace fields, without malformed rows. The inventory counts establish
completeness of these particular XML lists.
They do **not** establish completeness of every scientific product in each
survey, current original archives, valid-pixel footprints or all-file
availability. A later capture can declare the XML roster fully parsed while
keeping `inventoryComplete=false` until the declared release/product scope is
reconciled. NVSS I-only, SUMSS's mixed directories and WENSS's historical
snapshot must remain visible.

Retain the original producer separately from the US mirror, so future regional
source choices remain honest. The current audit has not established a
reachable original-producer HTTP download source for these maps. Previously
checked NRAO FTP anonymous login failed, Sydney image paths returned 404, and
Leiden/ASTRON historical image entrypoints returned 404. Record these source
identities and their observed status; do not invent a current primary download
URL. Directory browsing at SkyView's `/surveys/{nvss,sumss,wenss}/` returns
403 while the named files work. Directory 403 is not a file-availability result.

## Exact URI construction and native naming

For each XML image row, split on whitespace first. The first whitespace token
is a comma-separated **spell**, not the entire image filename. Its first comma
field is the exact relative remote path; its second is the cache filename.
Construct the source-listed mirror URI as:

```text
URI = XML Images/SpellPrefix + first comma field of Image's first whitespace token
```

Preserve case and directory components. Use membership in the explicit XML
roster to establish that a filename exists; a naming pattern alone does not
establish membership. The trailing RA/Dec/epoch fields are selection metadata,
not an actual image-frame polygon or a complete FITS WCS.

| Survey | Observed names and source-supported path rule | Scope / naming qualification |
| --- | --- | --- |
| NVSS | `https://skyview.gsfc.nasa.gov/surveys/nvss/<IHHMM[PM]DD.fits.gz>` | Every enumerated name follows this pattern. [NRAO download instructions](https://www.cv.nrao.edu/nvss/anonftp.shtml) describe center-encoded C/I map names, e.g. `C2230P84.gz` and `I0224M32.gz`. Preserve the **mirror's actual `.fits.gz` name**; do not substitute an original-FTP suffix or C cube |
| SUMSS | `https://skyview.gsfc.nasa.gov/surveys/sumss/mosaics/<Galactic or Extragalactic>/<JHHMMMDD.FITS>` | Exact directory and filename are listed per row. The J name encodes a J2000 field center, but image dimensions and declination scale vary; do not generate a fixed 4-degree rectangle from the name |
| WENSS | `https://skyview.gsfc.nasa.gov/surveys/wenss/<XML-listed filename>`; observed form `w[np]<five digits>h.fits.gz`, e.g. `wn30000h.fits.gz`, `wn50112h.fits.gz`, `wp90000h.fits.gz` | Do not derive membership, band, a J2000 center or a pixel frame by rounding the digits. Use exact roster identity and actual FITS header. A distinct publisher map may include processing recorded in HISTORY; bitwise equality with the unavailable original FTP copy was not established |

The source rule is a whole named map link without `POS`, `SIZE`, `width`,
`height` or cutout parameters. A `.gz` here compresses an individual FITS map;
it is not a multi-file survey archive. Keep `.fits.gz` on NVSS/WENSS URIs:
the server sends `Content-Encoding: x-gzip`, even with
`Accept-Encoding: identity`. WENSS `wn30000h.fits` returned 406 under that
request; the exact roster's `wn30000h.fits.gz` returned 200.

## Verified whole-file availability

HEAD probes followed redirects and requested `Accept-Encoding: identity`.
The following exact roster URLs returned 200 with `Content-Type:
application/fits` and `Accept-Ranges: bytes` on 2026-10-06:

| File | Whole-file URL | HTTP content length | Last-Modified |
| --- | --- | ---: | --- |
| `I0000M04.fits.gz` | [NVSS map](https://skyview.gsfc.nasa.gov/surveys/nvss/I0000M04.fits.gz) | 749,184 | 2010-07-30 01:35:50 GMT |
| `I0224M32.fits.gz` | [NVSS map](https://skyview.gsfc.nasa.gov/surveys/nvss/I0224M32.fits.gz) | 793,747 | 2010-07-30 01:36:14 GMT |
| `Extragalactic/J0000M84.FITS` | [SUMSS mosaic](https://skyview.gsfc.nasa.gov/surveys/sumss/mosaics/Extragalactic/J0000M84.FITS) | 7,905,600 | 2002-09-13 05:38:31 GMT |
| `Galactic/J0730M32.FITS` | [SUMSS mosaic](https://skyview.gsfc.nasa.gov/surveys/sumss/mosaics/Galactic/J0730M32.FITS) | 4,222,080 | 2007-08-07 05:04:23 GMT |
| `wn30000h.fits.gz` | [WENSS map](https://skyview.gsfc.nasa.gov/surveys/wenss/wn30000h.fits.gz) | 801,283 | 2010-07-30 02:36:40 GMT |

Later header-only requests also returned 206 for
[WENSS `wn50112h.fits.gz`](https://skyview.gsfc.nasa.gov/surveys/wenss/wn50112h.fits.gz),
total compressed size 1,243,837 bytes, and
[`wp90000h.fits.gz`](https://skyview.gsfc.nasa.gov/surveys/wenss/wp90000h.fits.gz),
831,041 bytes. These are availability observations for those files only.
Requests occasionally timed out; preserve checked time and per-request
failure, and do not interpret one timeout as a missing archive or mark every
unprobed URI available.

## Actual native image geometry

The [publisher's JAR](https://skyview.gsfc.nasa.gov/current/jar/skyview.jar)
contains `skyview/survey/CachingImageFactory.java`. Its class comment explicitly
calls a proxy's WCS **an approximation**. The source confirms the spell layout
`url,file,ra,dec,proj,csys,nx,ny,dx,dy` and creates its default proxy with a
centered scaler. Cached/downloaded FITS images instead use their real headers.
Therefore the XML spells are adequate identity/URI evidence, but cannot be
assumed to provide the native image footprint.

Header probes required an exact `Content-Range`, HTTP 206, stable ETag and
length; an HTTP 200 whole-file response would be closed without reading its
body. Uncompressed FITS was read in 2,880-byte header blocks. Gzip FITS was
read in 512-byte compressed-prefix ranges and inflated one header block at a
time, stopping at the padded block containing `END`. No pixel array was
decoded or retained. Celestial WCS was interpreted with Astropy/WCSLIB, with
the native FK5/FK4 frame retained and explicitly transformed to ICRS.

| Actual file header | Pixel dimensions | Native celestial WCS | Actual CRPIX1, CRPIX2 | Metadata bytes read / inflated header bytes |
| --- | --- | --- | --- | --- |
| NVSS `I0000M04.fits.gz` | 1,024 × 1,034; singleton STOKES/FREQ axes | `RA---SIN`, `DEC--SIN`, `EPOCH=2000`; FK5/J2000; CDELT `(-0.004166666884, +0.004166666884)` deg | 512, 513 | 3,584 compressed / 14,400 |
| SUMSS `Extragalactic/J0000M84.FITS` | 1,408 × 1,401 | `RA---SIN`, `DEC--SIN`, `EPOCH=2000`; FK5/J2000; CDELT `(-0.00305555555556, +0.00307238640981)` deg | 705, 701 | 14,400 / 14,400 |
| SUMSS `Galactic/J0730M32.FITS` | 1,408 × 747 | `RA---SIN`, `DEC--SIN`, `EPOCH=2000`; FK5/J2000; CDELT `(-0.00305555555556, +0.00576607751781)` deg | 705, 374 | 14,400 / 14,400 |
| WENSS `wn30000h.fits.gz` | 1,024 × 704; singleton FREQ axis | `RA---NCP`, `DEC--NCP`, `EPOCH=1950`; FK4/B1950; CDELT `(-0.00585937, +0.00585937)` deg | 513, **193** | 1,536 compressed / 5,760 |
| WENSS `wn50112h.fits.gz` | **1,024 × 1,024**; singleton FREQ axis | NCP, `EPOCH=1950`; CDELT `(-0.00585937, +0.00585937)` deg | 513, 513 | 2,048 compressed / 8,640 |
| WENSS `wp90000h.fits.gz` | **1,024 × 1,024**; singleton FREQ axis | NCP, `EPOCH=1950`; CDELT approximately `(-0.005859369878, +0.005859369878)` deg; CRVAL `(0,90)` | 512, 512 | 2,560 compressed / 11,520 |

NVSS/SUMSS CRPIX also differs from the proxy's default centered frame. SUMSS
XML has 17 dimension/scale variants, including
`Extragalactic/J1554M36.FITS` at 1,310 × 770 rather than width 1,408.
Its description calls the geometry an orthographic/SIN representation
of the NCP plane; the sampled real headers are SIN and must be interpreted
as such. Do not replace them with an assumed NCP header or constant RA/Dec box.

WENSS is the most serious proxy mismatch: its XML global suffix is
`,Ncp,J2000,1024,704,0.00585937,0.00585937`, whereas the XML MetaTable says
equinox 1950 and all three sampled real headers contain `EPOCH=1950`.
Two sampled frames are 1,024 pixels high. `wn30000h` is cropped/asymmetrically
referenced: CRVAL is not the pixel-frame center. At FITS-origin-1 pixel
`(512.5,352.5)`, its approximate ICRS center is **(0.64504468,
31.20012474)** deg, not `(0,30)`.

For that file, actual outer-pixel corners `(0.5,0.5)`, `(1024.5,0.5)`,
`(1024.5,704.5)`, `(0.5,704.5)` transform to approximately:

```text
ICRS (4.07511606,28.94327217), (357.21463933,28.94418969),
     (357.06662236,32.97922403), (4.22371887,32.97835221)
```

These illustrate real native geometry; they are not a full valid-pixel
footprint. A production capture should obtain **each map's actual header**,
sample curved edges through its own WCS, handle RA seams/poles spherically,
retain NCP-to-SIN WCSLIB fix evidence, and label frame geometry `estimated`.
Sampling just four corners is not proof that great-circle edges trace the
actual WCS boundary. Pixel masks/blanking were not examined. A survey-wide
SkyView/CDS MOC cannot replace the native per-map geometry or membership.

### WENSS spectral metadata conflict

The WENSS XML describes its survey as 325 MHz / 92 cm. Actual file headers are
not uniformly consistent with that band description:

| File | FREQ `CRVAL3`, Hz | `CDELT3`, Hz |
| --- | ---: | ---: |
| `wn30000h.fits.gz` | **609,585,595.238** | 787,500,032 |
| `wn50112h.fits.gz` | 327,142,253.2218 | 161,172,131 |
| `wp90000h.fits.gz` | 349,720,000 | 5,521,848,832 |

The cause was not established from the first-party material examined. Preserve
the publisher's 325 MHz identity separately from raw header frequency fields
and raise an explicit provenance/band-conflict gap. Do not silently repair
the frequency, assert that the first file is a verified 325 MHz observation,
or infer a usable 609 MHz inventory from that header. Its spatial WCS remains
readable, but binding ambiguous records to a fixed-band product requires
explicit review of this scope, or exclusion from that binding with the
identity retained as evidence. Polar-map HISTORY also records HGEOM processing;
the reachable object is that whole named map, not proof of bitwise identity
with every original observation or precursor map.

## Input hashes and metadata receipts

The XML HTTP responses returned `Content-Type: application/xml`,
`Content-Encoding: x-gzip`, and Last-Modified **2026-08-26 18:42:24 GMT**.
Raw bytes were read without automatic HTTP decompression. A gzip decode was
performed only when those bytes began with gzip magic; avoid decompressing an
already-decoded requests response twice.

| Input | Raw bytes | Raw SHA-256 | Decoded bytes | Decoded SHA-256 |
| --- | ---: | --- | ---: | --- |
| NVSS XML | 27,564 | `edf66ba81ef6d8b9aaf0269304fe73d883f94322381c274d06646a0f6095ab27` | 236,077 | `6dcfc1ca712ceb25a4f1ab1acee082166692674fbc7ac1dc65a066af10fa641e` |
| SUMSS XML | 12,273 | `2442dfc7d4f0bb4a32ee2e89d1c7c19d54c22614e7520f774b573d0fb9c4d242` | 113,026 | `b53830eec9a22c1a2de5501e0b768bb257abc48c93a04de9786f2202d9c5a09c` |
| WENSS XML | 7,926 | `a143ab3121d6696c49eaa7decda66bfd09f09d42d16b0ca934318bd5ac2ce2b1` | 51,058 | `65c846bcb447cf39c0009ebb49b304b658bda91881db72dbb40fcd40d6f10e52` |
| SkyView manifest | 22,854 | `0fdf1796c9d15023b7fb7355203569e063c378ea34c25f29e15d90a010ebb325` | — | — |
| SkyView JAR v3.5.7 | 5,137,270 | `6ecef5ca44ee7a983bad14755084073ebaf932b35a45929df79f4cb62dc93651` | — | — |

Decoded complete padded FITS-header SHA-256 values, **not** science-file hashes:

| File | Header SHA-256 |
| --- | --- |
| NVSS `I0000M04.fits.gz` | `b85d8c6c25768b612bc3ce1b83801c2cd1dae41954afec3c5c8f6d089a4bb814` |
| SUMSS `Extragalactic/J0000M84.FITS` | `354e7c791e75a603fbf6d6ffc19ef2cdb4d1a7b6eee67145a7889b6d356fb99b` |
| SUMSS `Galactic/J0730M32.FITS` | `fdea604af247995a77a2fa7fe6e5fe8f76c0b22d5f1526d1ec4d1a75dda8b332` |
| WENSS `wn30000h.fits.gz` | `f50db6cb8cd90fb795b75524edab58e8261ab869db5ace6ea2ea853fd1dc9e1f` |
| WENSS `wn50112h.fits.gz` | `dd94e69a94da3e965e52b331d1af9aada7af9de2c2f98ffa9aa2ff8b080c01a0` |
| WENSS `wp90000h.fits.gz` | `b450b68973a17cc8cb81a637a42fd94d22f9ab201519887b5970addfc58cc53d` |

SUMSS also has legitimate source-reference metadata at
[CDS HpxFinder metadata.xml](https://alasky.cds.unistra.fr/SUMSS/HpxFinder/metadata.xml),
2,406 bytes, SHA-256
`f35e00122403c06b8b035eb9f9d4b243e4dc726261d3c7c587a7e7699d5f895a`.
It identifies FK5/J2000 and the historical native file pattern
`http://www.astrop.physics.usyd.edu.au/mosaics/${access}`.
[A sample HpxFinder metadata page](https://alasky.cds.unistra.fr/SUMSS/HpxFinder/Norder3/Dir0/Npix512)
contains named original-image paths and frame polygons. A partial audit of
180 out of 240 available Norder3 pages found 588 unique map names, but mirror
timeouts prevented full enumeration. That partial list must not substitute
for the complete 748-row SkyView roster. CDS's actual HiPS pixel files remain
resampled data and are not native SUMSS mosaic download alternatives.

## Minimum staged metadata for a managed source

This is a proposed source schema, not an existing import contract. A new
adapter/collector should stage metadata outside Git and import it through
[native-unit management](../native-unit-management.md) before a candidate
build, review, archive and Dev activation. Preserve installed indexes and all
unrelated product bindings.

| Record | Required fields |
| --- | --- |
| Source manifest | `schemaVersion`, `deliveryClass: evidence`, survey/release/source identities, capture time, producer and mirror identities/country codes, exact source URLs, publisher snapshot/scope, raw and decoded inventory SHA/bytes, declared/fetched/distinct/geometry row counts, query-completion and inventory-completeness flags, declared precision and gaps |
| Native map row | Stable native map ID, exact filename and relative path, raw XML row and inventory row reference, XML prefix/suffix, producer provenance, original entrypoint, source-listed mirror URI and URI construction basis, SUMSS Galactic/Extragalactic membership, publisher band and retained raw spectral fields |
| Actual frame evidence | Complete padded primary-header metadata or an evidence-file reference, header SHA/bytes, NAXIS dimensions and singleton-axis selection, CTYPE/CRVAL/CRPIX/CD or CDELT/PC/CROTA, EQUINOX/EPOCH/RADESYS, relevant HISTORY, native coordinate frame, transformation implementation/version, finite sampled native and ICRS edge points, conservative frame polygon/cap, `precision: estimated`, WCS repair/conflict notes |
| Request receipt | Exact URL/final URL, time, method, status, total transport size, ETag/Last-Modified, content encoding, requested/received byte range, metadata-range SHA/bytes, decoded-header extent and no-pixel-decode declaration, availability state and failure reason |
| Managed binding / gap report | Actual existing product/layer identity, radio imaging modality, native map/mosaic identity, declared scope, source-listed versus checked URI state, incomplete header capture or excluded rows, unpublished mask uncertainty, WENSS band/frame contradictions, retained identity for every excluded/unresolved record |

Capture all enumerated rows first. If a header request fails, retain its known
identity/URI and the failure; retry or explicitly report the geometry gap.
Never substitute proxy geometry silently, drop failed files without accounting,
or manufacture high-order cells from a survey overview. Record **ICRS/NESTED**
on normalized outputs and declare actual available indexing orders/precision
under [coverage workflow](../coverage-workflow.md). No native MOC orders or
public coverage products were generated in this research task.

**Readiness:** all three have defensible whole-map identities, direct mirror
paths, and a corrected capture2 that passed local full-import validation.
Managed import, candidate review, archive and Dev activation are still
outstanding. WENSS has an additional mandatory band-conflict gap; none of the
capture counts should be reported as active survey inventory until the website
confirms the activated index.
