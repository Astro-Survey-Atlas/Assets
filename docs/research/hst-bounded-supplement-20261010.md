# HST bounded metadata supplement on Assets Dev (2026-10-10)

This update adds two public HST observation identities to the managed Assets Dev
native index. It is a bounded metadata supplement, not a complete MAST refresh
or a scientific-data download. It uses public CAOM metadata and the original
`s_region`; it does not perform WCS solving or retrieve science pixels.

## Source evidence

The source is the public `Mast.Caom.Filtered` service at
<https://mast.stsci.edu/api/v0/invoke>. The selected query captured one page of
three public HST image metadata rows at `2026-10-10T03:56:58.000Z`. It selected
observation IDs `26442812`, `454130303` and `454130304`, with
`obs_collection=HST`, `dataproduct_type=image` and `dataRights=PUBLIC`.
`s_region` is retained as returned under the MAST ICRS field contract.

- Baseline capture time: `2026-10-01T00:17:55.681Z`.
- Baseline manifest SHA-256: `d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8`.
- Baseline input: 601 pages and 1,201,094 evidence rows, retained byte for byte.
- Supplement response: HTTP 200, 2,463 bytes, SHA-256
  `ff974239f88cf832e353a1495f0a2af847704b3179042d9d685dd0971bd4dfdf`.
- Compressed supplement page: SHA-256
  `e30d3cde0895148fbc43161077836350f83de236a83c2a04201a9789d0b11ebe`, 956 bytes,
  with three rows.
- Composite HST input SHA-256:
  `ffd9bd95cc71c12244315eae43ce05a6f2522163a2731f68fee86e40393f7a72`.
- Composite evidence count: 1,201,097 rows, including retained rows and
  duplicates; this is not an observation or archive-inventory count.

Observation `26442812` is retained from the earlier selected supplement.
Observations `454130303` and `454130304` are the two new identities. Both are
proposal `18010`, instrument `WFC3/UVIS`, filter `F350LP`, target `2014QS441`.
No science-file product inventory was selected.

## Candidate and review

The isolated candidate group is
`943d3246d3fe8b83153c1e442edc4f29cca2093f014486a3fb09172c35dc624b` with review
digest `4306f0c0f2834c602f6955934d627f3850eb71a06ef1929bc4a2947701d18b6b`.
Its HST SQLite index is 599,216,128 bytes with SHA-256
`cd1942dc9157f8e59f136a053f5be7e5f60b6293f35737e551f23f4916a88ac0`.
All 243 candidate checks passed, there were no unavailable product bindings,
and the index contains 916,119 observations while retaining 18 unsupported
`GSC1` / `OTHER` rows as excluded evidence. The 108 accepted evidence gaps were
unchanged from the previous reviewed group.

The review retains `hst-partial-refresh` and `hst-unsupported-frames`. This
input does not establish a complete current HST inventory. The 18 unsupported
coordinate-frame rows remain excluded, and observation `s_region` bounds remain
estimated rather than verified valid-pixel coverage.

## Archive and activation

Archive task `native-mv1ydj3i-499edc19` completed with 1,387/1,387 metadata and
index dependencies remotely verified. The new SQLite archive is gzip with SHA-256
`677fbd7981ecda618bbff83c96226555c05618836139be93cd430d6215227265` and size
285,933,986 bytes.

Activation task `native-mv21vtfp-6b15e7ca` completed with the progress result
“Active index and native lookup verified through the site HTTP endpoint.” Dev
now serves native generation 15 and the candidate group above. The latest
`native-units` control snapshot is synced at generation 5780 with SHA-256
`406de9b622574c607c7ab0d7fb44b9d9f03e5fa106ac445762ebb628fe390a0c`. An earlier
generation 5779 snapshot had a retryable 300-second S3 request timeout; the
newer complete generation 5780 was uploaded and verified, so the current control
pointer is synced.

The active HST lookup for O8 NESTED cell `587500` returned observations
`454130303` and `454130304` over HTTP 200. It reported
`sourceSnapshotSha256=ffd9bd95cc71c12244315eae43ce05a6f2522163a2731f68fee86e40393f7a72`,
`queryExhausted=true`, `truncated=true` and 18 excluded rows. The query exhausts
the selected cell but does not claim a complete survey inventory.

A targeted reverse lookup of layer `hst-mast-cosmos-obs-26442812` at O8 cell
`436132` also returned HTTP 200 and one spatial unit, observation `26442812`,
with `estimated` precision. It returned no science files and remained
`truncated=true`, `queryExhausted=false` and `inventoryComplete=false`.

Dev `/api/v1/status` and `/healthz` returned HTTP 200; status reports the active
native index as `verified=true`. The public release remains
`reviewed-mupsxe2v-c91be91f`, bundle SHA-256
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`, with 603
files and 105 published MOC layers. No production site, public MOC or public
bundle changed. HST science pixels were not retrieved. The open HST gaps mean
this update is not evidence of inventory completeness or a release-complete
dataset.

