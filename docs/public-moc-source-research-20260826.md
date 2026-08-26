# Public MOC source research (2026-08-26)

## Conclusion

Eight useful public coverage candidates are discoverable through the CDS
MocServer. They are not all the same kind of coverage:

- Gaia DR3, eROSITA eRASS1 and 4XMM-DR13 are catalog-row spatial MOCs. They
  answer where catalog objects occur (`object_presence`), not where an
  instrument observed or reached a stated depth.
- SkyMapper DR4, KiDS DR5, VISTA VIKING J and DECaLS DR5 are MOCs associated
  with CDS-hosted image HiPS products. Their MocServer records are STMOCs, so
  an Assets import would deliberately retain only the spatial projection and
  discard time from the public SMOC. They describe HiPS/product availability,
  not CCD masks, exposure depth or catalog selection functions.
- Planck HFI 857 is an all-sky image-product SMOC. It is useful as a map
  availability baseline, but not as a sparse observation or depth footprint.

The survey or archive pages below are the authorities for the releases and
their scientific meaning. CDS is the authority for the listed MocServer
records and the MOC/HiPS artifacts it generates or hosts. A CDS MOC must not be
described as an official survey geometry unless the survey itself explicitly
endorses that exact artifact. KiDS DR5 does link its CDS HiPS directly; this
still does not turn its spatial projection into a per-exposure boundary.

All eight records were queried on 2026-08-26. A live fetch of each exact FITS
URL below returned an IVOA MOC 2.0 binary table with `COORDSYS=C`,
`ORDERING=NUNIQ`, `MOCDIM=SPACE` and a `UNIQ` column. The FITS `MOCORDER`
reflects the requested export for each URL: Gaia, 4XMM, SkyMapper, KiDS,
VIKING and DECaLS were requested at order 10, while eRASS1 and Planck were
requested at order 8. A requested/export order is not automatically the native
or scientifically justified resolution; the native record order and effective
precision remain separately recorded.

## Candidate matrix

| Priority | Candidate                         | Official release/archive source                                          | CDS record                                      | Exact candidate FITS query                    | CDS record type and native order                             | Assets semantics                                                                                  | Proposed Assets output                                                                                                                        |
| -------- | --------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Gaia DR3 main source              | [Gaia DR3 release][gaia-dr3]                                             | [`CDS/I/355/gaiadr3`][gaia-record]              | [`get=smoc&order=10&fmt=fits`][gaia-moc]      | SMOC, native order 10, all sky                               | `object_presence`; catalog source positions, not imaging/exposure coverage                        | ICRS NUNIQ FITS MOC at effective order 10, order-8 query projection, order-4 preview, provenance and attribution                              |
| P0       | eROSITA eRASS1 main catalog       | [eROSITA-DE DR1][erass1-dr1] and [catalog page][erass1-catalogs]         | [`CDS/J/A+A/682/A34/erass1-m`][erass1-record]   | [`get=smoc&order=10&fmt=fits`][erass1-moc]    | SMOC, native order 8, sky fraction 0.4252                    | `object_presence`; 930,203 catalog positions, not X-ray exposure geometry                         | Preserve effective order 8 even if the export header says 10; order-8 query block and order-4 preview                                         |
| P0       | XMM-Newton 4XMM-DR13 slim catalog | [XMM Science Archive][xsa] and [VizieR IX/69 release record][xmm-vizier] | [`CDS/IX/69/xmm4d13s`][xmm-record]              | [`get=smoc&order=10&fmt=fits`][xmm-moc]       | SMOC, native order 11, sky fraction 0.009367                 | `object_presence`; 656,997 unique-source positions, not an observation field-of-view union        | Down-project to order 10 for the package; publish catalog-presence semantics and keep any future official observation MOC as a separate layer |
| P0       | SkyMapper DR4 color               | [SkyMapper DR4][skymapper-dr4]                                           | [`CDS/P/Skymapper/DR4/color`][skymapper-record] | [`get=smoc&order=10&fmt=fits`][skymapper-moc] | STMOC, spatial order 10, time order 25, sky fraction 0.6327  | `footprint_extent`; CDS color HiPS made from selected DR4 i/r/g images                            | Spatial SMOC only, marked `estimated`; retain original STMOC/time range as evidence                                                           |
| P0       | KiDS DR5 color-gri                | [KiDS DR5][kids-dr5]                                                     | [`CDS/P/KiDS/DR5/color-gri`][kids-record]       | [`get=smoc&order=10&fmt=fits`][kids-moc]      | STMOC, spatial order 11, time order 25, sky fraction 0.03263 | `footprint_extent`; g/r/i HiPS availability, not masks or weak-lensing selection                  | Order-10 spatial SMOC, marked `estimated`; retain temporal evidence and keep other bands/products separate                                    |
| P0       | VISTA VIKING J                    | [ESO Phase 3 releases][eso-phase3]                                       | [`CDS/P/VISTA/VIKING/J`][viking-record]         | [`get=smoc&order=10&fmt=fits`][viking-moc]    | STMOC, spatial order 16, time order 25, sky fraction 0.02438 | `footprint_extent`; J-band HiPS availability                                                      | Order-10 spatial SMOC, marked `estimated`; one layer per band unless a reviewed recipe explicitly unions bands                                |
| P0       | DECaLS DR5 color                  | [Legacy Survey DR5][decals-dr5]                                          | [`CDS/P/DECaLS/DR5/color`][decals-record]       | [`get=smoc&order=10&fmt=fits`][decals-moc]    | STMOC, spatial order 11, time order 25, sky fraction 0.269   | `footprint_extent`; g/r/z color HiPS availability                                                 | Order-10 spatial SMOC, marked `estimated`; keep distinct from DESI spectroscopy and catalog layers                                            |
| P1       | Planck HFI 857 GHz                | [IRSA Planck mission page][planck-irsa] and [ESA HiPS][planck-hips]      | [`ESAVO/P/PLANCK/HFI-857`][planck-record]       | [`get=smoc&order=10&fmt=fits`][planck-moc]    | SMOC, native order 8, all sky; source HiPS frame is Galactic | `footprint_extent`; all-sky HFI 857 map availability, not cadence, depth or detector hit coverage | ICRS spatial MOC with effective order 8 and `estimated` product-availability semantics                                                        |

`MocServer get=smoc&order=10` can serialize a result whose header advertises
order 10 even when the record's native MOC is only order 8, as for eRASS1 and
Planck. Assets must not interpret those subdivided cells as new information.
Conversely, XMM, KiDS, VIKING and DECaLS have native spatial orders above 10;
the exact URLs deliberately lower their package candidate to the MOC Core
default maximum order 10. This follows the repository rule that a preview or
serialization operation cannot manufacture finer coverage.

## Source-by-source findings

### Gaia DR3 main source

The ESA/DPAC release page identifies Gaia DR3 as the official release. The CDS
VizieR record describes `I/355/gaiadr3` as the 1,811,709,771-row main source
catalog and supplies the MocServer entry. The resulting MOC is therefore a
spatial index of catalog-row positions. It is exact only in the limited sense
that Assets can preserve the retrieved third-party MOC cells at their declared
order; it is not an independent claim about Gaia scanning-law exposure,
completeness or imaging.

Use `sourceTier=third_party_moc`, `dataOrigin=catalog`,
`coverageRole=object_presence`, `maxOrder=10`, and preserve the ESA/DPAC and
Gaia Collaboration citations. [ESA's Gaia data-license page][gaia-license]
states `CC BY-NC 3.0 IGO`; commercial reuse needs the additional ESA terms
reviewed. The package must say that CDS generated/serves this catalog MOC and
must not call it an ESA-published footprint.

### eROSITA eRASS1 main catalog

The eROSITA-DE DR1 site says the publicly released data cover the western
Galactic hemisphere. Its current catalog page identifies the main catalog and
Merloni et al. (2024); the CDS record used here contains 930,203 sources and a
native order-8 SMOC. This makes it an X-ray source-presence layer, not the
eROSITA exposure or sensitivity footprint.

Use `sourceTier=third_party_moc`, `dataOrigin=catalog`,
`coverageRole=object_presence`, and effective `maxOrder=8`. The official
[eROSITA acknowledgement page][erass1-ack] requires a mission acknowledgement
and identifies Merloni et al. (2024) as the eRASS1 reference. No simple
machine-readable redistribution license was found on the cited DR1 pages, so
publication must remain blocked until a human records the applicable terms.

### XMM-Newton 4XMM-DR13

The XSA is the official data/archive entrypoint. VizieR IX/69 describes
4XMM-DR13 as 983,948 detections associated with 656,997 unique sources and says
not every public observation is included. The selected `xmm4d13s` table MOC is
therefore catalog source presence. It must not be substituted for an XMM
field-of-view union; an observation-footprint product would require its own
official observation geometry and layer identity.

Use `sourceTier=third_party_moc`, `dataOrigin=catalog`,
`coverageRole=object_presence`, and package order 10 after a reviewed
down-projection from native order 11. The [XMM publication guidelines][xmm-pub]
require the mission acknowledgement and require catalog users to name the
catalog version and unique source names. No explicit artifact-redistribution
license was found on the cited XSA/VizieR pages, so terms must be reviewed
before publishing a downloadable package.

### SkyMapper DR4 color

The official DR4 page documents more than 400,000 images, observations from
2014-03 through 2021-09, and image and catalog products. The CDS record says
the color HiPS was made by CDS from deep and shallow images, after rejecting
images with strong background variation. This is why the product is useful as
a HiPS availability footprint but cannot stand in for the complete DR4 CCD
inventory or a survey selection function.

The record is an STMOC (`moc_order=10`, `moc_time_order=25`). Import only its
spatial projection as `sourceTier=third_party_moc`, `dataOrigin=observed`,
`coverageRole=footprint_extent`, `precision=estimated`. Store the record, raw
STMOC or equivalent time metadata in evidence and state that the public SMOC
cannot answer time-window queries. CDS identifies itself as HiPS creator,
marks the HiPS `ODbL-1.0`, and records Australian National University survey
copyright/acknowledgement; preserve both layers of attribution.

### KiDS DR5 color-gri

The official KiDS DR5 page describes 1,347 square degrees of u/g/r/i imaging
and directly links the CDS g/r/i HiPS. This is unusually strong linkage between
the survey release and the hosted HiPS, but the MOC still describes that color
HiPS, not per-band masks, weight maps or the weak-lensing selection.

The CDS record is an STMOC with native spatial order 11 and time order 25.
Publish only an order-10 spatial projection with `sourceTier=third_party_moc`,
`dataOrigin=observed`, `coverageRole=footprint_extent`, and
`precision=estimated`; retain its temporal bounds as evidence. The CDS record
points to the [ESO data-access policy][eso-policy], which says ESO archive data
are `CC BY 4.0`, retain ESO copyright, require provenance acknowledgement, and
permit third-party distribution when headers and credit are preserved.

### VISTA VIKING J

The ESO Phase 3 page is the official release family entrypoint. The CDS record
describes the VIKING J-band HiPS, its ESO programme provenance and a native
spatial order-16 STMOC. This artifact is a single-band product footprint; J,
H, Ks, Y and Z should remain separate layers unless a recipe explicitly defines
and documents their union or intersection.

Publish an order-10 spatial projection with `sourceTier=third_party_moc`,
`dataOrigin=observed`, `coverageRole=footprint_extent`, and
`precision=estimated`. CDS marks the HiPS `ODbL-1.0` and names ESO as the
underlying copyright/progenitor. ESO's archive policy separately states
`CC BY 4.0` for ESO archive data and requires ESO provenance and preserved file
headers. The Assets package should contain only the derived MOC and metadata,
not republish VISTA image files.

### DECaLS DR5 color

The official Legacy Survey DR5 page defines the release. The CDS record says
the color HiPS uses g/r/z products, was built by CDS, covers a sky fraction of
0.269, and has a native order-11 STMOC. This is an image/HiPS availability
layer, not DESI spectroscopic coverage, a Tractor-catalog selection mask or an
accepted-CCD polygon reconstruction.

Publish the order-10 spatial projection with `sourceTier=third_party_moc`,
`dataOrigin=observed`, `coverageRole=footprint_extent`, and
`precision=estimated`. The CDS record marks the HiPS `ODbL-1.0`, CDS as its
creator and DECam Legacy Survey as the underlying copyright attribution.
Preserve the release URL, CDS record, HiPS DOI and both attributions.

### Planck HFI 857 GHz

IRSA's Planck page identifies HFI 857 GHz as one of the mission frequencies,
describes Planck's all-sky coverage and links Public Data Release 3 products.
The MocServer record identifies an ESA-created HFI 857 HiPS, an all-sky
native order-8 SMOC, and a Galactic-frame source HiPS. The fetched MocServer
FITS MOC is serialized in ICRS (`COORDSYS=C`), as required by MOC 2.0 and the
Assets contract.

Use `sourceTier=third_party_moc`, `dataOrigin=observed`,
`coverageRole=footprint_extent`, effective `maxOrder=8`, and
`precision=estimated`. This layer says that the all-sky map product is
available; it does not encode the number of visits, noise, masks or usable
science depth. The CDS record names ESA/Planck as creator/copyright and the
Planck Collaboration for acknowledgement, but exposes no simple MOC license;
record the applicable ESA/IRSA terms before package publication.

## Import and publication gates

The IVOA [MOC 2.0 Recommendation][ivoa-moc] defines SMOC on HEALPix in ICRS,
requires NESTED numbering and defines NUNIQ FITS packaging for SMOC. The local
[coverage workflow](coverage-workflow.md) and
[MOC Core contract](moc-core-contract.md) add the project-specific gates below.

1. **Allowlisted identity.** Pin the exact MocServer ID, official release URL,
   record URL and exact FITS URL. The release/product identity and
   `coverageRole` must match; a nearby survey or band is not a substitute.
2. **Immutable source snapshot.** `refresh` is the only networked step. Store
   the response bytes, retrieval time, final URL, HTTP validators when present,
   byte count and content SHA-256. An HTTP `ETag` is evidence, not a substitute
   for SHA-256. Preserve the MocServer record JSON as provenance.
3. **Native and exported order.** Record the CDS record's native spatial order,
   requested export order, FITS `MOCORD_S`/`MOCORDER`, and the effective
   scientifically justified maximum. Never promote native order-8 information
   to order 10 merely because the response header says 10. `overviewOrder=4`
   is only a preview; it is never evidence for order 8 or 10.
4. **Coordinate and encoding validation.** Reject unless the authoritative
   imported product is a valid FITS SMOC with `COORDSYS=C`,
   `ORDERING=NUNIQ`, `MOCDIM=SPACE`, a valid `UNIQ` column and cells that can be
   normalized to explicit NESTED `order/ipix`. Validate area, sky fraction and
   order against the saved record; do not silently reproject unknown frames.
5. **STMOC projection is lossy.** For SkyMapper, KiDS, VIKING and DECaLS, save
   the original record and time bounds as evidence, explicitly project to
   SMOC, and publish a limitation saying that the result cannot answer temporal
   coverage questions. A spatial union over time must not be presented as
   simultaneous or continuous availability.
6. **Truthful precision and provenance.** Set `sourceTier=third_party_moc` for
   all eight candidates. Catalog MOCs may be `exact` only at the declared MOC
   discretization and only for catalog object presence. HiPS/STMOC spatial
   projections and the Planck product-availability layer are `estimated`.
   Preserve `sourceSnapshotSha256`, available orders, source references,
   attribution and every limitation in the recipe lock and provenance.
7. **Evidence boundary.** Raw record JSON, raw STMOC/time metadata, retrieval
   logs, validation output and errors are evidence. They remain outside the
   browser's initial request. The public package contains only reviewed runtime
   artifacts and their provenance.
8. **Fail closed.** A timeout, non-2xx response, unexpected redirect, changed
   ID/release, hash drift without review, malformed FITS, frame/order mismatch,
   failed STMOC projection, unresolved license or missing attribution leaves
   the source in `candidate`/`awaiting_snapshot`. It must not enter the public
   build plan, release manifest or ACTIVE catalog. Never publish a partial or
   last-page-only MOC as a successful refresh.

The recipe lock must list the source snapshot hash, source references, Core
version and steps, `availableOrders`, `overviewOrder`, `maxOrder`, precision
justification and output hashes. After acquisition, rebuild must be offline and
reproducible from the saved snapshot.

## Reuse by other projects

The reusable boundary should be Resource Package v3, not a dependency on the
Assets server, Kubernetes, Warehouse or Elasticsearch. The normative local
contract is [`contracts/resource-package-v3.schema.json`](../contracts/resource-package-v3.schema.json),
with integration guidance in [Resource Package v3 integration](resource-package-integration.md).
Each immutable archive contains:

```text
resource-package.json
mocs/<layer-id>.moc.fits
footprints/survey-footprints.json
provenance.json
README.md
```

`resource-package.json` carries stable survey/release/layer identity,
modality, `coverageRole`, `dataOrigin`, `sourceTier`, file size and SHA-256.
The FITS MOC is the interoperable scientific artifact; the footprint JSON is
only the order-4 website preview; provenance records the source snapshot,
method, precision, license/attribution and limitations. Consumers verify the
archive SHA-256 from the public package catalog and validate every member hash
before atomic activation.

This is broadly reusable because any IVOA MOC implementation can perform
point-in-MOC, intersection, union and coverage comparison without the Assets
runtime. MOCpy, Aladin/CDS tooling and other standards-aware clients can read
the FITS artifact directly. An online consumer can instead use the read-only
`/api/v1/coverage/catalog` and immutable
`/api/v1/coverage/blocks/<layer-id>` interfaces; download clients obtain the
package through the public asset catalog and asset-download endpoint. Reverse
lookup into Warehouse file records is optional and is not required for offline
MOC use.

The portability is scientific as well as technical only when semantics travel
with the MOC. A client must be able to distinguish `object_presence` from
`footprint_extent`, native order from export order, `exact` from `estimated`,
and a CDS third-party artifact from official survey geometry. For these eight
candidates, that metadata is mandatory rather than descriptive decoration.

## Primary sources

- [IVOA MOC 2.0 Recommendation][ivoa-moc]
- [Assets coverage workflow](coverage-workflow.md)
- [Assets MOC Core contract](moc-core-contract.md)
- [Resource Package v3 integration](resource-package-integration.md)
- [Resource Package v3 schema](../contracts/resource-package-v3.schema.json)
- Candidate-specific official and CDS links embedded in the matrix and
  findings above

[gaia-dr3]: https://www.cosmos.esa.int/web/gaia/data-release-3
[gaia-license]: https://www.cosmos.esa.int/web/gaia-users/license
[gaia-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FI%2F355%2Fgaiadr3&get=record&fmt=json
[gaia-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FI%2F355%2Fgaiadr3&get=smoc&order=10&fmt=fits
[erass1-dr1]: https://erosita.mpe.mpg.de/dr1/
[erass1-catalogs]: https://erosita.mpe.mpg.de/dr1/AllSkySurveyData_dr1/Catalogues_dr1/
[erass1-ack]: https://erosita.mpe.mpg.de/dr1/AllSkySurveyData_dr1/acknowledgement.html
[erass1-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FJ%2FA%2BA%2F682%2FA34%2Ferass1-m&get=record&fmt=json
[erass1-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FJ%2FA%2BA%2F682%2FA34%2Ferass1-m&get=smoc&order=8&fmt=fits
[xsa]: https://www.cosmos.esa.int/web/xmm-newton/xsa
[xmm-vizier]: https://cdsarc.cds.unistra.fr/viz-bin/cat/IX/69
[xmm-pub]: https://www.cosmos.esa.int/web/xmm-newton/publication-guidelines
[xmm-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FIX%2F69%2Fxmm4d13s&get=record&fmt=json
[xmm-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FIX%2F69%2Fxmm4d13s&get=smoc&order=10&fmt=fits
[skymapper-dr4]: https://skymapper.anu.edu.au/data-release/dr4/
[skymapper-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSkymapper%2FDR4%2Fcolor&get=record&fmt=json
[skymapper-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSkymapper%2FDR4%2Fcolor&get=smoc&order=10&fmt=fits
[kids-dr5]: https://kids.strw.leidenuniv.nl/DR5/index.php
[kids-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=record&fmt=json
[kids-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=smoc&order=10&fmt=fits
[eso-phase3]: https://www.eso.org/sci/observing/phase3/data_releases.html
[eso-policy]: https://archive.eso.org/cms/eso-data-access-policy.html
[viking-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FVISTA%2FVIKING%2FJ&get=record&fmt=json
[viking-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FVISTA%2FVIKING%2FJ&get=smoc&order=10&fmt=fits
[decals-dr5]: https://www.legacysurvey.org/dr5/
[decals-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDECaLS%2FDR5%2Fcolor&get=record&fmt=json
[decals-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDECaLS%2FDR5%2Fcolor&get=smoc&order=10&fmt=fits
[planck-irsa]: https://irsa.ipac.caltech.edu/Missions/planck.html
[planck-hips]: http://skies.esac.esa.int/pla/HFI_SkyMap_857_2048_R3_00_full_HiPS/
[planck-record]: https://alasky.cds.unistra.fr/MocServer/query?ID=ESAVO%2FP%2FPLANCK%2FHFI-857&get=record&fmt=json
[planck-moc]: https://alasky.cds.unistra.fr/MocServer/query?ID=ESAVO%2FP%2FPLANCK%2FHFI-857&get=smoc&order=8&fmt=fits
[ivoa-moc]: https://www.ivoa.net/documents/MOC/20220727/REC-moc-2.0-20220727.html
