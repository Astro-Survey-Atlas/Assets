# HST Unindexed Footprints (2026-10-01)

## Findings

HST spatial reverse lookup can use a locally downloaded CAOM metadata snapshot;
it does not need to query MAST for each sky-cell request. Assets already has
this path: the acquisition job pages the official `Mast.Caom.Filtered` API,
locks the response pages and manifest by SHA-256, and builds a local SQLite
index on the evidence PVC. The current snapshot has 601 pages and 1,201,094
public HST image rows. Its manifest SHA-256 is
`d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8`.

The official MAST references reviewed document a filtered CAOM query API and
the `s_region` field; they do not identify a separate versioned full-archive
geometry dump. The locked paginated API response is therefore the available
reproducible input found for local mapping. MAST remains the metadata authority
and snapshot refresh source, not a request-time dependency of spatial lookup.
Ordinary HST cell lookup and overlap reverse lookup now read the same local
SQLite v4 index. The API returns observation identities and saved `s_region`
values; it does not fetch products during a sky lookup. Users follow the MAST
observation link for the current product list and access policy.

The v4 index reports 916,116 indexed rows/observation IDs, 284,960 duplicate
source records, and 18 excluded rows. The index is 599,207,936 bytes with
SHA-256 `2e61e368e86dd93398d6a666c863f30ebc9d8ea9f389770ec5dce7f1e446983b`.
The 18 remaining rows all have public HST image identity and a string
`s_region`, but their coordinate-frame labels are not understood: 16 use
`CIRCLE GSC1` and 2 use `CIRCLE OTHER`. The index summary keeps an aggregate
exclusion count, not row-level parse reasons.

The previous v3 index excluded 103 rows. The parser changes made 85 of those
rows indexable by increasing bounded input limits, recognizing the observed
missing whitespace before `POLYGON`, and skipping degenerate polygon parts
while retaining other usable parts. The remaining two frame labels must not be
guessed into ICRS:

| Count | Observed `s_region` issue | Current behavior |
| ---: | --- | --- |
| 25 | Region length 33,183–64,549 characters; each has 1–242 `POLYGON` markers (median 171) | Indexed with the bounded v4 limit of 131,072 characters/tokens. |
| 16 | `CIRCLE GSC1 ...` | Still excluded. `GSC1` is not an accepted frame; no transform or ICRS equivalence is assumed. |
| 2 | `CIRCLE OTHER ...` | Still excluded. Only ICRS is accepted until the source clarifies this label. |
| 29 | A polygon part has fewer than three distinct vertices after removing an explicit closing vertex | Degenerate part is skipped; valid parts in the same region remain usable. |
| 18 | A polygon part has fewer than three coordinate pairs | Empty/degenerate part is skipped; the row is indexed if another valid part remains. |
| 13 | A coordinate and following `POLYGON` token are concatenated, e.g. `...33.4622358900001POLYGON...` | The parser recognizes this numeric-to-shape boundary. |

The groups sum to the v3 total of 103. Only the 18 rows with unresolved frame
labels remain excluded in v4. MAST's CAOM field page describes `s_region` as
an ICRS circle or polygon, but that statement does not prove that `GSC1` or
`OTHER` are ICRS aliases.

## Follow-up: Current MAST Rows and Coordinate Fields

On 2026-10-01, the public `Mast.Caom.Filtered` API was queried again for the
16 distinct obsids represented by these rows. The request selected
`obsid,s_region,s_ra,s_dec,instrument_name,filters,dataRights`, filtered to
`obs_collection=HST`, and returned all 16 as public image observations. Fourteen
returned `CIRCLE GSC1`; two returned `CIRCLE OTHER`. The two repeated GSC1
obsids `24140021` and `64269313` each occur twice in the locked source pages,
so these 16 distinct obsids correspond to 18 excluded source rows.

The queried obsids were `26538586`, `26112494`, `62243905`, `24140021`,
`25052730`, `25055963`, `26078684`, `60828578`, `25061122`, `26239310`,
`64269313`, `60828498`, `60903839`, `60662110`, `26255803`, and `26255290`.

All returned circles have a radius of 0.00069444 degrees (2.5 arcsec). A
great-circle comparison of each circle center's numeric coordinates with the
same row's `s_ra`/`s_dec`, treating the numbers as one frame without applying a
transform, gives the following diagnostic values. Because MAST does not
document the frame of its CAOM `s_ra`/`s_dec`, these are not physical angular
separations when the frames differ.

| Label | Distinct obsids | Untransformed numeric offset from `s_ra`/`s_dec` | Meaning |
| --- | ---: | ---: | --- |
| `GSC1` | 14 | 332.52544–332.52547 arcsec | About 133 times the encoded circle radius; the centers are not numerically interchangeable. |
| `OTHER` | 2 | 0.00029–0.00036 arcsec | Numerically coincident to sub-milliarcsecond precision, but this alone does not establish the frame token's semantics. |

The MAST CAOM field reference says `s_region` will be an ICRS circle or polygon
and gives `CIRCLE ICRS` as its example. The live `GSC1` and `OTHER` values do
not follow that documented serialization. The MAST CAOM reference does not
define either token, and the `Mast.Caom.Filtered` service reference does not
provide a mapping or transform for them. No authoritative definition for these
tokens was found in the MAST CAOM or IVOA ObsCore references reviewed here.
Treat the rows as source metadata that conflicts with the documented contract;
do not infer that `GSC1` means a particular catalog, equinox, or transform, or
that `OTHER` means ICRS.

The MAST CAOM query also rejects `s_fov` as an invalid column name, and the
CAOM field table has no `s_fov` entry. It lists CAOM `s_ra`/`s_dec` in degrees,
but does not assign them a coordinate frame. IVOA ObsCore 1.1 defines its own
`s_ra`/`s_dec` fields as ICRS center coordinates and `s_fov` as an approximate
diameter of a containing circle (§§4.10–4.11); it places the more precise shape
in `s_region` (§4.12). These ObsCore definitions do not supply MAST CAOM values
or semantics. Even for ObsCore, the standard does not explicitly guarantee
that a provider's containing-circle center is the `s_ra`/`s_dec` center.
Therefore these CAOM rows cannot be made into a reliable approximate footprint
by substituting `s_ra`/`s_dec` or assuming a radius from `s_fov`. Keep all 18
source rows excluded until MAST clarifies the frame labels and supplies
geometry semantics that can be validated; keep the HST inventory marked
incomplete.

## Implementation Evidence

- [The snapshot lock](../../src/layers/recipes/hst-public-image-observations.lock.json)
  declares the public CAOM query, 601 pages, 1,201,094 rows, evidence delivery
  class, and the local SQLite index path.
- [The acquisition script](../../scripts/acquire-hst-public-image-observations.ts)
  requests observation identity, public-access status, proposal/target labels,
  instrument/filter labels, times and `s_region`; it stores verified response
  pages for local use, not science files or a per-observation product list.
- [The footprint parser](../../server/hst-image-lookup.ts) accepts bounded
  compound `POLYGON`/`CIRCLE` primitives in ICRS, recognizes the observed
  coordinate-to-`POLYGON` token boundary, and can retain valid parts when a
  sibling polygon is degenerate. It caps regions at 131,072 characters/tokens,
  512 shapes and 32,768 polygon vertices; unknown frame labels remain excluded.
- [The index builder](../../server/hst-observation-index.ts) increments one
  aggregate exclusion count when public-row validation fails or when no coarse
  candidate cell is returned. It does not record the distinction or raw parse
  error for each excluded row.
- [The coverage workflow](../coverage-workflow.md) already states that the
  locked CAOM snapshot is used for local spatial matching and that unsupported
  footprints keep the HST inventory incomplete.

The v3 count classification was reproduced against the 601 locked gzip pages
in the Assets evidence PVC and the matching SQLite `row_hash` set. The v4
snapshot and index hashes, counts and C04 result were verified again on Dev;
the live HST endpoint returned HTTP 200 from the local index. No Workspace or
CSST data was used in the classification.

## Recommended Scope

1. Keep the existing acquisition boundary: refresh the public-image CAOM
   snapshot deliberately through the documented MAST API, validate page
   totals and hashes, and build/query the derived spatial index locally. Do
   not add MAST calls to normal spatial lookup.
2. Keep the 16 `GSC1` and 2 `OTHER` rows out of spatial matching until MAST
   confirms their coordinate semantics and any required transform. Do not
   mark HST inventory complete while those public source rows remain unresolved.
3. A future index schema may persist row-level exclusion reasons and parser
   version. The current v4 index records the aggregate count; the locked
   snapshot remains sufficient to reproduce the 18-row exclusion result.

This is a source-unit reverse-lookup repair. It does not require a new HST MOC,
science-file download, or per-query MAST request. Complex-footprint matches
remain `estimated` where the implementation uses conservative spherical caps.

## Official References

- [MAST API service reference: `Mast.Caom.Filtered`](https://mast.stsci.edu/api/v0/_services.html#MastCaomFiltered)
  documents filtered CAOM observation queries with selected columns and
  filters. The current Assets acquisition snapshots this public query in
  pages; it is not a static geometry-file download contract.
- [MAST CAOM field descriptions](https://mast.stsci.edu/api/v0/_c_a_o_mfields.html)
  describes `s_region` as the STC/S footprint, with valid values “ICRS circle or
  polygon”, and gives `CIRCLE ICRS ...` as an example.
- [IVOA ObsCore 1.1, section 4.12](https://www.ivoa.net/documents/ObsCore/20170509/)
  defines `s_region` as the more precise spatial coverage field and specifies
  that its selected TAP value is an STC-S string. This is the serialization
  contract behind the MAST field; the observed `GSC1` and `OTHER` labels still
  require source clarification because MAST's field page promises ICRS.
- [IVOA ObsCore 1.1 Recommendation, sections 4.10–4.11](https://www.ivoa.net/documents/ObsCore/20170509/REC-ObsCore-v1.1-20170509.pdf)
  defines ObsCore `s_ra`/`s_dec` as ICRS center coordinates and `s_fov` as an
  approximate diameter. Its `s_fov` definition is not evidence that the MAST
  CAOM query exposes that field or that the returned CAOM `s_ra`/`s_dec` can
  reconstruct the malformed `s_region` values.
