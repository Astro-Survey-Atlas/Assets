# HST Footprint Source Supplement (2026-10-01)

## Result

No reviewed official MAST/CAOM service returns a second, documented ICRS
footprint for the 16 distinct HST observations behind the 18 excluded
`CIRCLE GSC1` / `CIRCLE OTHER` rows. The observation query returns the
unsupported `s_region` values and CAOM center coordinates; the documented
product query returns product inventory and access metadata, but no geometry
or WCS fields. A metadata-only FITS primary-header check also did not provide
a usable footprint for these observations. Keep the 18 source rows excluded
and keep HST inventory completeness false. The 16 distinct obsids are
`26538586`, `26112494`, `62243905`, `24140021`, `25052730`, `25055963`,
`26078684`, `60828578`, `25061122`, `26239310`, `64269313`, `60828498`,
`60903839`, `60662110`, `26255803`, and `26255290`; two appear twice in the
locked snapshot. See the [geometry audit](hst-unindexed-footprints-20261001.md)
for the row-level `s_region` values and offset comparison.

## Queries and Supported Fields

The official [MAST API service reference](https://mast.stsci.edu/api/v0/_services.html)
documents `Mast.Caom.Filtered` for observation queries and
`Mast.Caom.Products` for products belonging to one or more observation group
IDs. The [CAOM field reference](https://mast.stsci.edu/api/v0/_c_a_o_mfields.html)
documents `s_region` as an ICRS circle or polygon, and lists `s_ra` and `s_dec`
as observation right ascension and declination in degrees. It does not list
`s_fov`; a direct query for that column returns `Invalid column name 's_fov'`.
The live values for these rows still violate the documented `s_region`
serialization (`CIRCLE GSC1` or `CIRCLE OTHER`).

An all-columns `Mast.Caom.Filtered` query for the 16 obsids returned 16 rows and
these 36 fields:

```text
intentType, obs_collection, provenance_name, instrument_name, project, filters,
wave_region, target_name, target_classification, obs_id, s_ra, s_dec,
dataproduct_type, proposal_pi, calib_level, t_min, t_max, t_exptime,
wavelength_region, em_min, em_max, obs_title, t_obs_release, proposal_id,
proposal_type, sequence_number, s_region, jpegURL, dataURL, dataRights, mtFlag,
srcDen, obsid, objID, wave_min, wave_max
```

The documented [Products Field Descriptions](https://mast.stsci.edu/api/v0/_productsfields.html)
cover file/product identifiers, descriptions, URI, type/subgroup, project,
proposal, size, access rights, calibration level and filters. A single
`Mast.Caom.Products` request for the 16 IDs returned 142 rows (9 products per
observation except 8 for each `OTHER` observation) with these 20 fields:

```text
obsID, obs_collection, dataproduct_type, obs_id, description, type, dataURI,
productType, productGroupDescription, productSubGroupDescription,
productDocumentationURL, project, prvversion, proposal_id, productFilename,
size, parent_obsid, dataRights, calib_level, filters
```

There is no product-level `s_region`, `s_ra`, `s_dec`, `s_fov`, WCS, or other
footprint field in that response. The documented MAST service directory has no
separate HST observation-geometry service. `Mast.Caom.Cone` and
`Mast.Caom.Filtered.Position` are spatial search entrypoints, but return CAOM
columns; they do not expose an alternate geometry serialization.

## FITS Primary-Header Check

The product list identifies a public `_flt.fits` product for each of the 16
obsids. Following each returned `dataURI`, the MAST download endpoint was
queried with `Range: bytes=0-2879`. All 16 requests returned HTTP 206 and
exactly 2,880 bytes (`Content-Range: bytes 0-2879/<file size>`); no pixel-array
bytes were requested. This follows the documented
[MAST file download endpoint](https://mast.stsci.edu/api/v0/pyex.html#download_req)
and HTTP byte-range behavior described in
[RFC 9110, Range Requests](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests).

Each returned primary header block contained `EQUINOX = 2000.0`. The 14
`GSC1` products had `RA_TARG = 0` and `DEC_TARG = 0`; their target coordinates
cannot locate the observation. The two `OTHER` products contained nonzero
target coordinates matching the CAOM `s_ra`/`s_dec` values numerically:

| ObsID | CAOM token | Product | Primary-header `RA_TARG`, `DEC_TARG` |
| ---: | --- | --- | --- |
| 26255290 | `OTHER` | `le7i02znq_flt.fits` | `174.4737943178`, `-22.78353316989` |
| 26255803 | `OTHER` | `le7i05b9q_flt.fits` | `177.1246979098`, `-27.81941384054` |

The FITS header comments label `RA_TARG` and `DEC_TARG` as target right
ascension/declination in degrees (J2000), and `EQUINOX` as the equinox. They do
not label these values ICRS and do not define a spatial footprint shape or
extent. A target coordinate is not an observation footprint. In particular,
the matching numbers for the two `OTHER` rows are not independent evidence
that `OTHER` is ICRS. The first-block check does not inspect later extension
headers; no claim is made that no useful WCS could exist in an extension. Such
a WCS would need a separately documented, instrument-appropriate method for
turning product coordinates into the observation's sky footprint before it
could be used as coverage evidence.

## Local Reproducibility

The existing [snapshot lock](../../src/layers/recipes/hst-public-image-observations.lock.json)
and [acquisition script](../../scripts/acquire-hst-public-image-observations.ts)
already provide the reproducible offline path: capture the paged public
`Mast.Caom.Filtered` results, validate page counts and hashes, then build and
query the local SQLite observation index. The current snapshot/index contains
916,116 indexed observations and records 18 excluded source rows. Product
metadata can also be captured as a small supplemental evidence response, but
it currently supplies no additional spatial field to index. Do not synthesize
geometry from the two J2000 target positions or from undocumented CAOM center
semantics. If MAST corrects these rows or documents their frame and extent,
capture that source response, hash it, and rebuild a versioned local index;
normal overlap lookup should continue to use the local snapshot/index rather
than call MAST.

## Primary References

- [MAST API service reference](https://mast.stsci.edu/api/v0/_services.html):
  `Mast.Caom.Filtered`, `Mast.Caom.Filtered.Position`, `Mast.Caom.Cone`, and
  `Mast.Caom.Products` service descriptions.
- [MAST CAOM field descriptions](https://mast.stsci.edu/api/v0/_c_a_o_mfields.html):
  supported observation fields and the documented ICRS form of `s_region`.
- [MAST Products Field Descriptions](https://mast.stsci.edu/api/v0/_productsfields.html):
  supported product metadata fields.
- [MAST Python API examples](https://mast.stsci.edu/api/v0/pyex.html):
  product query and file-download request examples.
- [HST Data Handbook, FITS File Format](https://hst-docs.stsci.edu/hstdhb/3-hst-file-formats/3-2-fits-file-format):
  official HST FITS product format reference.
- [RFC 9110, Range Requests](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests):
  HTTP partial byte-range request semantics.
- [IVOA ObsCore 1.1 Recommendation](https://www.ivoa.net/documents/ObsCore/20170509/REC-ObsCore-v1.1-20170509.pdf):
  separate ObsCore semantics for `s_ra`/`s_dec`, `s_fov`, and `s_region`; these
  do not add fields to MAST CAOM or establish the semantics of the two labels.
