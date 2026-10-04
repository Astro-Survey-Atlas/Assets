# Euclid ERO official FITS-header supplement (2026-10-03)

The 72602 instance now maps all **17 official ERO targets**, up from 10.
The seven missing outreach associations were supplemented with each target's
own official VIS and NISP image-frame WCS. DESI + Euclid O4 C01, cell `[190]`,
now returns **ERO-IC10** alongside DESI DR1 Tile 82406. Identity remains
`target`; this supplies neither a Tile inventory nor valid-pixel coverage.

## Source and acquisition boundary

The official [ERO landing](https://euclid.esac.esa.int/dr/ero/) and each
target XML explicitly name all 17 targets and their VIS/NISP Stack/Catalog
package URLs. ESA TAP still exposes only the previously checked outreach
associations; its mosaic tables inspected on this date identify Q1_R1 rather
than ERO. No Q1 geometry, object center or aggregate MOC was substituted.

`scripts/acquire-euclid-ero-headers.py` captured 34 XML-linked, uncompressed
tar packages by bounded HTTP `Range` requests. It read tar member headers,
skipped member contents using their actual sizes, and decoded only gzip
FITS-header blocks through the padded `END` block. It captured 85 primary
image headers: VIS plus NISP Y/J/H/Chi2 for every target. The runtime selects
VIS or the requested Y/J/H band; Chi2 headers remain evidence and do not
replace a band's own header.

Only **322,560 bytes** of package ranges were transferred for this metadata
capture. No complete package, scientific image array, weight image, mask or
catalogue was retrieved. Raw scientific prefixes were not saved in the
snapshot. The evidence stores plain FITS header cards, tar headers, literal
XML, request-range hashes, package sizes/validators and capture receipts.

CDN certificate time validation failed on this date. The collector explicitly
used `--allow-expired-certificate`: CA-chain and hostname checks remained
enabled, and the exception is recorded in all affected receipts and the
reviewed gap `euclid-ero-cdn-certificate-time-exception`. No runtime/global
TLS validation was disabled. Initial small diagnostic ranges used an
unverified TLS probe; they were not imported. Managed evidence was recollected
with chain and hostname verification and the scoped certificate-time exception.

Locked snapshot:

- File SHA-256: `199538862e494dbb037169346744927c40ab70f0ea70f7ef2b3f329ebc7b268d`.
- Size: 1,249,141 bytes; schema version 2; 17 targets / 34 packages / 85 headers.
- Managed snapshot: `6b11e9c027fa1e2c744cea62f4afd87b1f0addda3da1166f1c3eec882591bd2d`.
- Source `euclid-ero-targets`, revision 2.
- Raw staging and acquisition receipts live outside Git under
  `/home/aaron/.local/share/astro-assets-survey-supplements/20261003-ero/`.
- The authoritative snapshot and dependencies were imported and archived as
  evidence through the authenticated native-unit management API.

## Geometry and precision

Every imported header declares `RADESYS=ICRS`, degree axes, a 2D TAN
projection, image dimensions, reference pixel/coordinate and a nonsingular
CD matrix. The parser rejects unsupported distortion, other coordinate
frames, conflicting target/member/instrument identities, missing bands,
altered header bytes and incomplete bounded-range receipts.

The footprint uses the four **half-pixel image edges** (`0.5` to
`NAXIS+0.5`), transformed by the full TAN WCS. Independent Astropy WCS
evaluation of all 85 headers agrees within `5.684341886080801e-13` degrees.
Original cards and their individual SHA-256 hashes remain in locked evidence.
The polygons are frame bounds, so spatial precision remains **estimated**:
valid-pixel masks, exposure holes and catalogue object extent were not tested.

The seven added target centers below come from the headers and are presented
only as coordinates for recognizing their verified frame; no footprint was
constructed from a center alone.

| Target | VIS CRVAL RA, Dec (deg) | VIS header SHA-256 |
| --- | --- | --- |
| Barnard30 | 82.880945, 12.316275 | `72d2a04cd56cde17f75645448395c368ca4fb446b2d29ad9287e83efb107b59f` |
| Taurus | 64.9833, 28.0233 | `8a4822a60e66d69f8294b0cedce28a10d91d8c82d630bac022e8ecf2e8ed7f81` |
| NGC6254 | 254.3032, −4.1003 | `337d4cedf1d93c33893829a9fdb99a02951b8d188f62f2e6a6fabcb6855d4cad` |
| HolmbergII | 124.790327, 70.706033 | `e762631e7cb2bd97821077c441fffe7aece0409aa8732d44bcfe97bb6b0079d4` |
| IC10 | 5.0632, 59.288 | `6d3ecfd7b40026d78f5ded9a444aaa0f3b60d386bb0b20ce5ba5ea94b6abe3ec` |
| NGC2403 | 114.211242, 65.58657 | `9ff6139e12d219801d11eeeb2175a6e5ecfd7fa3751af2ad7e28d60d02e560c0` |
| Fornax | 54.0176, −35.2672 | `517d60b130e83edae949ffa44c55784bc67571cabebaf1de2645aefd5daed328` |

IC10 VIS frame:

```text
POLYGON ICRS 6.027939416075 58.784412707169 4.098460583925 58.784412707169 4.069698969226 59.784241354938 6.056701030774 59.784241354938
```

The actual ERO-Fornax frame is around Dec −35°, independently distinguished
from Q1 Deep Field Fornax near Dec −28°. IC10 is independently distinguished
from IC342 by its XML package, tar member and own WCS.

## Managed activation and HTTP verification

72602 group `869ad929fc0389b3d4711ce5636df6ec6a1d728721486d2d584a752f9f05a28c`
was built, verified and reviewed with every remaining gap, all 640 dependencies
archived, and activated as generation 3. It passed **137/137 checks**,
including 85 image-frame probes; `eroExcludedTargets=0`.

| Operation | Completed task |
| --- | --- |
| Import | `native-mus1n4g9-5e9741aa` |
| Build and verification | `native-mus1n7mg-447fee76` |
| Archive | `native-mus1nifn-e2da5237` |
| Activate, runtime and site HTTP verification | `native-mus1nldt-e2073f9d` |

15 site HTTP checks passed: unchanged published bundle/105 MOCs/132 catalog
layers, MOC FITS Range/SHA, coverage pagination, C01 target identity and WCS
evidence, all archived native dependencies, and the four-survey C02 first and
second pages of 20 units with one snapshot and no duplicates. This C02 check
does not claim a repeated full four-survey export.

C01's anonymous native list now shows six spatial product records: one DESI
Tile plus IC10 color/VIS/Y/J/H associations. Its finite native query is now
exhausted (`queryExhausted=true`, `resultTruncated=false`), while
**`inventoryComplete=false`** remains independent. Anonymous supporting
information still has preview limits, so the outer response can remain
truncated. Neither query exhaustion nor 17 mapped targets establishes complete
survey scientific inventory.

1440px and 1024px browser checks display both DESI 82406 and ERO-IC10, remove
the old seven-target warning, and retain frame precision. The requested
`.overlap-drawer-content` height limit was removed: computed `max-height=none`,
content client height 785px in a 1000px viewport; no horizontal overflow or
JavaScript errors. JSON and CSV preserve `geometryEvidence`/`geometry_evidence`,
package/member/header hashes, band, original polygon and source snapshot.

The public MOCs and installed generic/HST index hashes were unchanged by this
ERO update. Dev retains its older generation 2 until separately updated.
The old installed native group remains available for managed rollback.

Actual browser JSON/CSV downloads were subsequently verified for the same
O4 C01 region: six spatial product records, five IC10 product associations,
eight header evidence references and identical source hashes/polygons in both
formats. `inventoryComplete=false` remains; the mixed page can still have
supporting information omitted. Verification passed again after the HST
supplement activated generation 4, retaining all 17 ERO targets and 85 headers.
The initially empty downloads were caused by Snap Chromium's isolated default
temporary directory in the test environment; an explicitly shared download
directory fixed the test. No application download change was necessary.
