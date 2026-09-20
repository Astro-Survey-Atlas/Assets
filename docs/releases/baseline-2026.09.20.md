# Assets / Workspace baseline — 2026-09-20

The matching `baseline-2026.09.20` tags in Assets and Workspace freeze the
verified public publication → package installation → native MOC overlap flow.
These are deployment baseline releases, not a request to rebuild packages from
a mutable catalog. GitHub attachments record the actual deployed image digests,
source commits, charts, original public package bytes, and SHA-256 checksums.

| Component | Verified deployment | Image tag |
| --- | --- | --- |
| Assets | Helm revision 184, site + backend each 1/1 | `1.0.0-20260920-baseline` |
| Workspace | Helm `asa` revision 31, 1/1 | `0.10.38-dev-20260920-native-overlap` |

The frozen public bundle is `reviewed-mu9eqjrr-d2bb9a87`, SHA-256
`aa211a5004c482144eec85b2b9bd5cd73afcb19a3c74c6d4e61ad03ec0c53ecc`
(484 manifest files). The public packages are DESI 3.2.0, Euclid 3.9.0,
Gaia 3.1.0, and SDSS 3.2.0: 11 native MOC layers altogether.

The original archive bytes are retained; no migration, package downgrade, or
public release rewrite is part of this baseline. `catalog.json` in the GitHub
Assets release points to versioned release attachments. The collection ZIP
contains a relative-path catalog for offline use. `BASELINE.json` pins both
applications and the public data; `SHA256SUMS` covers release attachments.
Deployment requires the environment's existing values and credentials; the
included image overrides contain no secrets and pin images by digest.

Validation:

- Assets build, 212 Node tests, pinned Core wheel verification passed.
- Home rows keep name, native order, modality icons, DR and product counts on
  one line at 1440/900/390px in Chinese and English, with no page errors.
- Workspace build and 262 tests passed (2 optional tests skipped); the live
  catalog test separately installed all four current packages in isolation.
- The frozen collection was independently installed and activated in a
  temporary Workspace state: 4 packages, 11 native MOCs.
- With Euclid ERO + Q1 and DESI EDR + DR1 selected, both live services and the
  offline native projections produce order 8, 570 cells and 5 components.
  Explicit order 4 and per-component details also match.

Publication audit: the four latest runs `mu9e3548-22ed9a39`,
`mu9ep1l9-5774c9e3`, `mu9epzio-9fa82283`, and `mu9eqjrr-d2bb9a87` are all
`published`, with candidate, authority and site checks passed and one worker
attempt each. They contain no persisted execution error. The reported transient
UI/submission error cannot be attributed from these records; do not describe it
as a confirmed package build failure or claim that a retry fixed a known cause.
Historical failed runs from September 18 remain historical evidence.

The tags and artifacts capture this release without freezing future public
publishing. Keep live user data and activation selections when updating software;
never restore this snapshot over later publication history.
