# HST bounded metadata supplement (2026-10-03)

Assets 72602 now indexes **923,382 public HST image observations**, up from
916,116. A reviewed supplement added **7,266 observation identities** while
retaining every installed identity and indexed geometry record. This is a
bounded metadata update, with `inventoryComplete=false`; it does not establish
a complete current MAST inventory or download any scientific files.

## Inputs and actual scope

The historical input captured on `2026-10-01T00:17:55.681Z` has 601 pages and
1,201,094 metadata rows. Its unchanged manifest SHA is
`d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8`.
All 601 local page hashes and sizes were independently checked to validate the
input-identity comparison, and the managed import verified the installed
baseline dependencies again. A complete page list does not imply complete
unique-observation or scientific-file inventory.

The official `Mast.Caom.Filtered` query at
<https://mast.stsci.edu/api/v0/invoke> selected only `HST`, `image`, `PUBLIC`,
and the existing allowlist of observation identity, instrument/filter/time
and `s_region` fields. Current responses reported **1,201,187 rows**, a net
difference of 93. That difference is not a count of added observations:
page order and duplicate identities differ from the historical capture.

The full acquisition was slow and was cancelled through the management API
as `native-mus2a19c-dbc4f7ed`. Its completely received pages, plus a separately
captured official final page, supply 39,187 rows from these actual page numbers:

```text
1, 2, 3, 4, 5, 7, 9, 10, 11, 16, 17, 18, 20, 21, 22, 23, 25, 26, 28, 601
```

Each retains the original 2,000 page size, 601 total pages, upstream totals,
response bytes, SHA and number. Pages were not renumbered or relabelled as a
complete fresh snapshot. Comparing their identities against **all historical
input rows** found 7,266 absent IDs in 8,927 rows; repeated rows are retained
in input evidence and deduplicated in SQLite. These are additions to this
local index, not a claim that the observations were newly taken or released.

The v2 composite input keeps the original v1 manifest and pages byte for byte,
and declares `refreshMode: bounded-supplement`, separate capture dates/query
and locked references. Its 1,240,281 rows are **combined evidence rows**, not
the latest upstream total or a unique-observation count.

- Composite manifest SHA:
  `65abc912ef79ec923156742fa8d082e2759ee5eb3794e7f18431f58272ea1897`.
- Manifest size: 5,925 bytes; 623 input dependencies including both manifests.
- Managed snapshot:
  `d68f139b7b6c648fad76c1d08755957f11df6970ce5f3e549cebc79315e53a2a`.
- Source `hst-public-images`, revision 2.
- SQLite SHA:
  `58a08149dade1f325c5e115ad359d25059ff4ee516b57f59c0f26a8e8d9dd683`;
  604,119,040 bytes.

## Candidate, review and activation

The worker copied the existing SHA-verified v4 index into a separate candidate
and merged selected rows by record content. Original indexes and observations
remain installed. Tests also compare this path with a rebuild from both sets
of raw input pages, including duplicate records and metadata variants.

| Operation | Completed task |
| --- | --- |
| Import and locked-page verification | `native-mus31wr4-3e2a5e68` |
| Candidate build and verification | `native-mus322bm-d922d3bf` |
| Archive, 661/661 metadata/index dependencies | `native-mus32h8t-b1948674` |
| Activate, runtime and site HTTP verification | `native-mus32zi3-f00fe5ff` |

All **138 checks** passed; all reported gaps were reviewed. Active generation
is **4**, group
`803023a36a8d489d951717214b92d0df4c3d4b7b36607a3634843bb0621d29d5`.
Native control generation 611 is `synced`. Direct joins of the old and new
SQLite indexes independently confirmed 7,266 added observations, **zero
removed observations and zero lost original indexed records**.

Remaining HST exclusions are 19 rows, up from 18. The unavailable published
binding `hst-mast-cosmos-obs-26442812` is retained. The mandatory reviewed gap
`hst-partial-refresh` and public/export notes preserve the baseline date/SHA,
selected fresh row count and the absence of a complete current refresh. Old
observations are not deleted based on their absence from selected new pages.
`s_region` geometry still has estimated precision, including the existing
conservative handling of complex footprints.

## Verification and deployment

72602 Helm revision **7** uses immutable image
`0.1.0-20261003-153818-hst-supplement`; site/backend are 1/1 Ready.
Build, 382 tests (380 passed, 2 skipped), Core wheel verification and Helm
lint passed. Metadata client requests now use MAST's standard POST form and
a compatible identifying User-Agent; TLS checks stay enabled.

Actual authenticated site requests tested newly indexed identities:

| Observation | Product | O8 NESTED cell | Returned spatial records/pages |
| --- | --- | --- | --- |
| 97287786 | ACS/WFC F814W | 121713 | 12 / 1 |
| 199602393 | WFC3/UVIS F606W | 13801 | 114 / 2 |

Both returned their original `s_region`, composite source SHA, estimated
precision and official MAST Products API URI. Pagination kept the same
snapshot. The requests preserve inventory incompleteness and bounded-input
notes. The baseline absence was verified against locked input identities;
the attempted website “before” request ran after activation and is not used
as before/after evidence.

The 15-check HTTP release/coverage suite passed again, including ERO C01 and
four-survey C02 first/second pages of 20 records. C01 actual browser JSON/CSV
exports match six spatial product records and IC10's per-band header hashes
and polygons, with `inventoryComplete=false` and no JavaScript errors.
Final-image layout checks at 1440px/1024px both report `max-height=none`,
785px content height in a 1000px viewport, and no horizontal overflow.
Supporting information has its own preview limits. This does not repeat a
full four-survey component export.

The public bundle, 105 MOCs/132 catalog layers, generic native index and all
17 ERO targets/85 headers are preserved. Dev remains revision 319/generation
2; Workspace is unchanged. No scientific dataset or private CSST input was
acquired. Source and validation receipts remain outside Git under
`/home/aaron/.local/share/astro-assets-survey-supplements/20261003-hst/`;
deployment receipts are under
`/home/aaron/.local/share/astro-assets-deployments/72602/20261003-153818-hst-supplement/`.
