# Euclid ERO and Q1 Frame Coverage Publication (2026-10-12)

This record describes the bounded ERO/Q1 image-frame additions published in
Dev bundle `reviewed-mv51kku3-a4f8d8e6`. It does not claim complete ERO or Q1
archive inventory.

## Locked inputs

ERO source `euclid-ero-targets`, revision 2, is the official 17-target snapshot
captured on 2026-10-03. Its SHA-256 is
`199538862e494dbb037169346744927c40ab70f0ea70f7ef2b3f329ebc7b268d`; it records
17 target packages and 85 bounded FITS-header records. These headers cover VIS,
NISP Y/J/H and Chi2 for each target. The four published frame products use the
VIS and NISP Y/J/H headers, 17 frames per band. ERO remains target-identified;
no verified Tile roster is available.

Q1 source `euclid-q1-calibrated-frames`, revision 1, is the official Q1_R1
`q1.calibrated_frame` snapshot captured on 2026-10-10. Its manifest SHA-256 is
`f2a46f106889ab46a5c99cc7d496011af364779f27d9b507b8dede32a7328a6e`; the
locked input contains 2,449 rows: 836 VIS, 537 NISP.H, 538 NISP.J and 538
NISP.Y. These are calibrated image frames with source-listed geometry, separate
from the 2,908-row / 352-Tile Q1 BGSUB MER roster. This frame query is not all
Q1 science products.

No scientific image pixels were downloaded for these snapshots. The ERO header
capture reads bounded FITS headers from archive packages; Q1 uses archive
metadata. See the [ERO FITS-header supplement](euclid-ero-fits-header-supplement-20261003.md)
and the [Q1 Tile mapping record](euclid-q1-deepfields-native-tiles.md) for the
underlying source and geometry boundaries.

## Published products

The public bundle contains four ERO and four Q1 frame-extent MOC products:

| Release | Layer IDs | Native unit | Source scope |
| --- | --- | --- | --- |
| Euclid ERO | `euclid-ero-vis-frames`, `euclid-ero-h-frames`, `euclid-ero-j-frames`, `euclid-ero-y-frames` | named target | 17 source-listed frames per band |
| Euclid Q1 | `euclid-q1-vis-frames`, `euclid-q1-h-frames`, `euclid-q1-j-frames`, `euclid-q1-y-frames` | calibrated image | 836 VIS / 537 H / 538 J / 538 Y source rows |

All eight products have maximum native MOC order 10 and estimated frame-bound
precision. Their geometry does not establish valid-pixel masks, object
occupancy, current per-file availability or complete release inventory. Q1
calibrated-frame examples return image identities but no file-level URI. ERO
examples preserve the target identity and package links, not a Tile identity.

## Publication and native index

Publication task `mv51kku3-a4f8d8e6` completed with candidate, authority and
site verification passed. The site observed bundle SHA-256
`d197228230cfa34ce9a59f25de6991cb5875094f18278825eb8b5a856a113ae7`; site
verification checked 115 products. The bundle has 611 files and 28 resource
packages. Its publication record contains 162 coverage documents; the public
coverage catalog reports 140 layers, including 113 published MOC layers.

The managed native index preserved the existing 128 bindings and added these
eight products. Candidate group
`14d6885aa39300ecb8041f822c3b9357a0f116dfc6d8911852583361b99ebcdf`, review
digest `4a0073155999d344a132b49147c02623bebe365195e3ac64dc7d72cd92b19fee`,
passed 252/252 checks with no unavailable bindings. Its 109 reported gaps
matched the previously reviewed active group's accepted gaps; there were no
new gaps. Archive task `native-mv609zti-e736b49f` verified 1,396/1,396
dependencies. Activation task `native-mv60duzp-c0b8179f` passed runtime and
site HTTP native-lookup verification. Dev is active at generation 17 with this
group. The new frame layers have O4 verification samples; all are estimated.

Control snapshot generation 6076, SHA-256
`8a6d758c83b718337e955fb8c9f075f62aceeb4311f9307d0a2a9684899d1c84`, later
advanced to `synced` at 2026-10-13 01:56:20 UTC. The remote object was confirmed
at 26,655,301 bytes with the same SHA-256 as the local upload manifest. This
control-state sync is separate from the already completed public-bundle and
native-index activation checks. Publication-task snapshot generation 16530,
SHA-256 `31ccbebde08f8f9b84702f732c0c48a0a3229e338e55c9706dd6c579b5edf702`,
also advanced to `synced` at 2026-10-13 02:12:32 UTC; remote size and SHA matched
the pointer and local manifest.

The independent data tag `data-v0.0.1` was pushed with this bundle SHA pinned.
GitHub Actions run 38335509877 failed during tag-coordinate resolution before
the public bundle was pinned or staged. No data-release assets were created.
The branch now explicitly fetches the annotated tag ref before reading its
message; the tag is preserved. The workflow is not yet on the default branch,
so recovery requires merging the branch and dispatching the workflow with the
same tag and bundle SHA. This publication state is separate from the successful
Dev bundle publication and native-index activation.

All eight published MOC asset HEAD requests returned HTTP 200, with SHA-256 and
byte counts matching the public asset catalog. `/api/v1/status` reported
generation 17, `managed=true`, `verified=true`. The Dev service was Helm
revision 371, image tag
`0.1.0-20261012-165105-nested-moc-output`. Local NodePort checks must bypass the
configured HTTP proxy; a proxied 502 was returned by the local proxy even while
both application Pods and in-cluster health checks were ready.

The independent data release is tracked separately from code-image and Helm
releases through `.github/workflows/data-release.yml`. It pins and packages the
public bundle only; evidence snapshots and scientific pixels are not included.
