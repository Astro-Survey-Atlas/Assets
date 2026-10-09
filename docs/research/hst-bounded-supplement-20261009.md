# HST bounded metadata supplement on Assets Dev (2026-10-09)

This update adds one public HST observation to the managed Dev candidate. It is
a bounded metadata supplement, not a complete MAST refresh or a scientific-data
download.

## Source evidence

The source is the public `Mast.Caom.Filtered` service at
<https://mast.stsci.edu/api/v0/invoke>. The 2026-10-09 query returned one
public HST image row for observation `26442812`: proposal `12440`, instrument
`ACS/WFC`, filter `detection`, and two polygons in the original `s_region`.
The selected metadata contains no science pixels or per-observation product
inventory.

The MAST [CAOM field reference](https://mast.stsci.edu/api/v0/_c_a_o_mfields.html)
defines `s_region` as an ICRS circle or polygon. This returned STC-S string does
not name its frame, so the index uses the documented MAST field contract. The
original string is preserved unchanged. The separate historical `GSC1` / `OTHER`
frame labels remain unsupported and excluded.

- Baseline capture time: `2026-10-01T00:17:55.681Z`.
- Baseline manifest SHA-256: `d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8`.
- Baseline scope: 601 original pages and 1,201,094 evidence rows; the supplement
  retains these pages byte for byte.
- Supplement capture time: `2026-10-09T10:34:33.642Z`; one selected page and one
  evidence row, not a complete new pagination.
- Supplement response SHA-256:
  `e3c82cf7f23c420450db9955111eb58f4fc953aabfef8abf6fa9bb827afacdfc`.
- Compressed page SHA-256:
  `dce122a4fdbe17e15524d5225e92c5807c42c86d05639d2b47095c8c31353719`;
  size 704 bytes.
- Managed input ID:
  `64310e9369b001ca4a8b481559877850ec46b04c166020f578a4451da9656df4`.
- Composite input SHA-256:
  `9733187f42058ed46e716e85ad8f69f46dbd2fe66d6425621c9b72de120b99d3`.

The composite evidence count is 1,201,095 rows. This counts retained input rows,
including duplicates; it is not an observation or archive-inventory count.

## Candidate and review

The isolated candidate group is
`78b08dee26fbeb01ff26036c8033e0ce50aac9820015e5a7a23f940829782b92` with
review digest
`6b6fac4eeb20216cd795de8b8d330de4794ac715a60c32ca8d5c059b3769dfd1`.
Its HST SQLite index is 599,212,032 bytes with SHA-256
`bd639ce8528d21418dfe02f3578c9e5685392ce2a1d5d8a4bd7bebe47c91b72a`.
All 243 candidate checks passed. The HST observation count increases from
916,116 to 916,117; no previous observation or geometry row is removed.

The candidate matches observation `26442812` to O4 NESTED cell `1703` with
`estimated` precision. The footprint is an archive-reported observation region,
not a valid-pixel mask or a verified science-file footprint. The reviewed gaps
`hst-partial-refresh` and `hst-unsupported-frames` remain explicit. The existing
18 rows with unsupported `GSC1` / `OTHER` frames stay excluded.

## Archive and activation

Archive task `native-mv0u73mc-a8612ad6` completed with 1,387/1,387 metadata
and index dependencies archived and verified. Activation task
`native-mv0xf4kd-2d6b046a` completed with the progress result “Active index and
native lookup verified through the site HTTP endpoint.” Dev now serves
generation 14, group
`78b08dee26fbeb01ff26036c8033e0ce50aac9820015e5a7a23f940829782b92`. The
`native-units` control snapshot is synced at generation 5629, SHA-256
`73b528824b7232b777922392a9286c195a1a6005d82339486aa68ba3d59b2324`.

The authenticated Dev reverse lookup returned observation `26442812` for
`hst-mast-cosmos-obs-26442812`, O8 NESTED cell `436132`, with `estimated`
precision and the expected composite source SHA-256
`9733187f42058ed46e716e85ad8f69f46dbd2fe66d6425621c9b72de120b99d3`. Its
spatial-unit page contained one result and `hasMore=false`; the overall response
still reported `truncated=true`, `resultTruncated=true` and
`queryExhausted=false`. This verifies that the added observation is addressable
through the active index, not that the bounded HST inventory is exhaustive.

Dev `/api/v1/status` and `/healthz` returned HTTP 200. The native index reports
generation 14 and `verified=true`. The public release remains
`reviewed-mupsxe2v-c91be91f`, bundle SHA-256
`0e49b04b57e482f98fd2028ce55fa1a482d7b6f5318142845dc8c0bb30b4b307`, with 603
files. This update changed only the Assets Dev native index: no production site,
public MOC or public bundle changed. The `hst-partial-refresh` and
`hst-unsupported-frames` gaps remain open, including the 18 excluded
`GSC1` / `OTHER` frame rows.

Evidence files remain outside Git under
`/var/lib/assets-evidence/native-imports/hst-supplement-20261009/`. No HST
science product was retrieved, and no public MOC or bundle was changed.
