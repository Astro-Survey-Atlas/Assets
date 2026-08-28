# Public survey MOC acquisition evidence (2026-08-28)

This note records a fresh, read-only CDS MocServer probe for four public survey
products requested for possible Assets coverage layers. It supplements the
broader candidate review in
[`public-moc-source-research-20260826.md`](public-moc-source-research-20260826.md).
The files below are immutable evidence snapshots for review; this probe did
not modify `src/`, `artifacts/`, the source registry, or the public build plan.

## Snapshot results

All four exact `get=smoc&order=10&fmt=fits` requests returned HTTP 200 on
2026-08-28. The response headers identify an IVOA MOC 2.0 spatial binary
table (`MOCDIM=SPACE`, `COORDSYS=C`, `ORDERING=NUNIQ`, `TTYPE1=UNIQ`) generated
by CDS Java API 6.4. `MOCORD_S`/`MOCORDER=10` is the requested export order,
not proof that the underlying HiPS has scientifically useful order-10
precision. The SHA-256 values are for the exact response bytes fetched in this
probe and must be rechecked during acquisition.

| Candidate | Official release/source | CDS record | Exact FITS export | HTTP / bytes | Snapshot SHA-256 | Native/product semantics |
| --- | --- | --- | --- | ---: | --- | --- |
| SkyMapper DR4 g/r/i color | [ANU SkyMapper DR4](https://skymapper.anu.edu.au/data-release/dr4/) | [CDS/P/Skymapper/DR4/color](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSkymapper%2FDR4%2Fcolor&get=record&fmt=json) | [SMOC order 10](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSkymapper%2FDR4%2Fcolor&get=smoc&order=10&fmt=fits) | 200 / 129,600 | `d89b39f1036dbad020b0a472e05aa6e7442e0552e27255b81fabd6991cf02f20` | CDS color HiPS made from selected i/r/g images; source record is an STMOC (spatial order 10, time order 25), so import only a spatial projection as an estimated product-availability extent. |
| KiDS DR5 g/r/i color | [KiDS DR5](https://kids.strw.leidenuniv.nl/DR5/index.php) | [CDS/P/KiDS/DR5/color-gri](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=record&fmt=json) | [SMOC order 10](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=smoc&order=10&fmt=fits) | 200 / 34,560 | `05814db03135f15e36228c4c3b743ef4da12857d0fedc645f66d2ca43a20fabd` | CDS g/r/i HiPS; source record is an STMOC (spatial order 11, time order 25). The survey page directly links the CDS HiPS, but the footprint is not a per-band mask or weak-lensing selection function. |
| VISTA VIKING J | [ESO Phase 3 releases](https://www.eso.org/sci/observing/phase3/data_releases.html) | [CDS/P/VISTA/VIKING/J](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FVISTA%2FVIKING%2FJ&get=record&fmt=json) | [SMOC order 10](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FVISTA%2FVIKING%2FJ&get=smoc&order=10&fmt=fits) | 200 / 51,840 | `90981ae15adb2f018775e98948780fa5dd18afc719366f638194f880e1526ca3` | Single-band J HiPS; source record is an STMOC with native spatial order 16 and time order 25. Keep J separate from H, Ks, Y and Z unless a reviewed recipe defines a union. |
| DECaLS DR5 g/r/z color | [Legacy Survey DR5](https://www.legacysurvey.org/dr5/) | [CDS/P/DECaLS/DR5/color](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDECaLS%2FDR5%2Fcolor&get=record&fmt=json) | [SMOC order 10](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FDECaLS%2FDR5%2Fcolor&get=smoc&order=10&fmt=fits) | 200 / 192,960 | `592fbf29361a7de3efc29b4b2d904cbd80525224da7cbb60a3d23b3e4845d677` | CDS g/r/z color HiPS; source record is an STMOC with native spatial order 11 and time order 25. This is an image/HiPS availability extent, not DESI spectroscopy, a Tractor selection mask, or accepted-CCD polygons. |

## Attribution and license handling

CDS records identify the HiPS creator and licensing metadata. SkyMapper's
record names CDS as creator, gives `ODbL-1.0`, and carries the ANU SkyMapper
acknowledgement/copyright text. The KiDS record points to ESO archive policy;
the [ESO data-access policy](https://archive.eso.org/cms/eso-data-access-policy.html)
states CC BY 4.0 for ESO archive data with preserved provenance and credit.
The VIKING record similarly carries CDS `ODbL-1.0` metadata and ESO
provenance; DECaLS carries CDS `ODbL-1.0` metadata and DECam Legacy Survey
attribution. These statements apply to the hosted metadata/HiPS products and
do not by themselves grant permission to redistribute survey image files.
Before publication, record the exact license text, attribution string, and
source snapshot hash in the recipe lock; unresolved terms leave a candidate in
`awaiting_snapshot`.

## Validation and limitations

The probe checked HTTP status, byte count, SHA-256, and the FITS header fields
listed above. It did not yet persist the raw bytes or perform a full cell-level
MOC validation, area cross-check, or STMOC-to-SMOC projection. Those checks are
required before acquisition. In particular:

1. Preserve the CDS record JSON and any temporal bounds as evidence. A spatial
   projection loses time and cannot answer temporal-coverage questions.
2. Keep native order, requested export order, FITS header order, and effective
   published precision as separate fields. Never infer finer cells from the
   order-10 serialization.
3. Use `sourceTier=third_party_moc`, `coverageRole=footprint_extent`,
   `dataOrigin=observed`, and `precision=estimated` for these four candidates.
4. Require source identity, release attribution, ICRS/NESTED normalization,
   output hashes, and an offline reproducible rebuild before adding a layer to
   the public build plan. The current status remains `candidate`.

## Reproduction

The hashes above were produced by downloading each exact FITS URL with a
redirect-following HTTP GET and running `sha256sum` on the response. A future
acquisition must save the response bytes, retrieval timestamp, final URL,
HTTP validators when present, and validation output under the evidence store;
the public browser/API should receive only the reviewed derived package.

