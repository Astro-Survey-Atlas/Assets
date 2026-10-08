# IPHAS DR2 and ZTF DR7 residual evidence, checked 2026-10-07

**IPHAS now has a recoverable QC snapshot in the same pinned author repository
as the already captured image precursor. Its selected native identities match
the precursor exactly. ZTF still has no recovered frozen IRSA DR7 processing
inventory; its previously captured CDS DR7 progenitor scope remains usable.**

This follows the [2026-10-06 residual audit](phase2-residual-native-surveys-20261006.md)
and [later ZTF acquisition audit](phase2-ztf-native-inventory-20261006.md).
The former predates the successful CDS roster capture; its statement that no
ZTF native roster was recovered is historical. Existing installed counts are
not new acquisitions in this note. Rechecks below occurred on **2026-10-07,
10:31–10:38 UTC**. Only public documentation and metadata were read; image
availability used HEAD. No cluster, management state, PVC, object store,
deployment, public bundle/MOC, Workspace or 72602 was changed.

## Follow-up status, 2026-10-08

These recommendations are now tracked as pending work in the
[handoff checklist](../../HANDOFF.md). The pinned IPHAS QC research has not yet
been imported as a managed input, and no frozen IRSA DR7 processing inventory
has been recovered. Keep the existing IPHAS/CDS ZTF provenance and incomplete
inventory declarations. Importing the QC evidence must preserve duplicate field
associations and follow storage qualification and the full retention dry run;
29 bound survey IDs in active generation 13 do not establish complete inventory.
This status update does not acquire metadata, build an index or start a task.

## IPHAS: pinned QC can strengthen the existing precursor evidence

The [pinned DR2 Git tree][iphas-tree] returned HTTP 200 and is not truncated.
It contains `dr2/lib/iphas-qc.fits`, **44,691,840 bytes**, Git blob
`b96be8781b4b231422051e2c20fe1ad9768dd038`. This file was introduced by the
[author's 2014-04-17 commit][qc-introduction], whose message is
“Add QC file to DR2 rep, so DR2 is self-contained”. This is a new finding;
the earlier audit considered the separate QC repository's moving tree.

A strict GET of the [pinned QC file][qc-file] with
`Range: bytes=0-115199` returned **206** and
`Content-Range: bytes 0-115199/44691840`. The decoded primary HDU contains a
VOTable metadata document, followed by one BINTABLE: **22,349 rows**, **110
columns**, **1,998 bytes/row**, data offset **37,440**. No HDU contains
scientific image pixels. The subsequent full metadata GET returned 200;
its size and Git blob SHA-1 match the tree, and its SHA-256 is:

```text
937b6c06829fae63c04caaa31c198824bdaebb99a479e4a59c28a5cd4c1f8243
```

A local reconciliation of this QC table with the [same pinned image precursor][pipeline]
found:

| Check | Result |
| --- | ---: |
| QC `is_best & (qflag != 'D')` selected fields | 14,115 |
| QC `is_dr2` versus that selector | Identical for every QC row |
| Selected QC run/CCD/band identities, expanding CCD 1–4 | 169,380 |
| Precursor unique identities with `in_dr2=true` | 169,380 |
| Set difference in either direction | 0 |
| Precursor rows with at least one QC run/band association | 268,185 / 268,185 |

These are computed facts about these two pinned inputs, not a new assertion
of complete published inventory. The [pinned constants][constants] declare
the same release selector, but still load QC from the author's absolute
`/home/gb/dev/iphas-qc/qcdata/iphas-qc.fits` path. Repository co-location and
matching membership do not prove that every final published QC/calibration
value came from the bundled file.

The QC association needs explicit duplicate handling. Runs **367744 (H-alpha),
367745 (r), 367746 (i)** each appear under two QC field IDs:
`6195_oct2003` is selected, grade A++; `6195b_oct2003` is unselected, grade D.
Together they affect 24 precursor rows and 12 unique image identities. Preserve
both associations and their flags. The [author's augmentation script][augment]
uses a last-wins run dictionary and only explicitly removes extra run-367744
rows; copying that dictionary rule would conceal the conflicting QC association.
Corrupt run 376022 has one precursor row, already `in_dr2=false`.

The [author-defined final text index][final-text] is newly reachable: GET 200,
**1,048,576 bytes**, SHA-256
`4f7a9f3a4257e865d631882aca7a8c5398d0f5669ea839c2f349108bc96a6571`.
It has **8,455 complete data rows**, one header and a truncated last line ending
`http://www.iphas.org/data/imag`. All complete rows' fieldid, qcgrade, in_dr2
and band agree with the pinned QC/precursor join. This is useful sampled
corroboration; the incomplete file cannot establish the final inventory.
A GET requesting bytes 1048576–1048703 returned 200 rather than 206; no body
was read for that request, so it does not establish a retrievable remainder.

Other dated access observations, without reading image bodies:

| Exact publisher path | Method / result |
| --- | --- |
| [`/data/`][iphas-data] | GET 403 |
| [`/data/images/iphas-images.fits.gz`][final-gz] | HEAD 404 |
| [`/data/images/iphas-images.sqlite`][final-sqlite] | HEAD 404 |
| [`/data/images/iphas-images.fits`][final-fits] | HEAD 200, `text/html; charset=utf-8`; bounded GET exceeded the 3 MiB limit, so no valid FITS index established |
| [`http://www.iphas.org/data/images/r375/r375643-1.fits.fz`][image-http] | HEAD 404 |
| [`https://www.iphas.org/data/images/r375/r375643-1.fits.fz`][image-https] | HEAD 404 |

**Recommendation:** a separately declared, metadata-only managed capture of
the pinned QC table, constants and augmentation source is justified. It can
add traceable field/QC evidence to the existing 169,380 identities without
expanding their membership. Preserve duplicate associations, original values
and the precursor/final-export distinction through review. Keep
`inventoryComplete=false`: the complete published final index, final output
byte identity and general image availability remain unverified. Geometry
remains estimated image bounds; this research supplies no valid-pixel masks.

## ZTF: rechecks preserve the CDS scope, not frozen IRSA DR7 identity

The [official release list][ztf-releases] again returned **200**, **2,519 bytes**,
SHA-256 `7bb6e7fc9dd8ab4bf04c8c74d1f1c8aad730f3cbc616e6ac32362cb18e5948fd`,
unchanged from the earlier audit. It dates DR7 to 2021-09-08, says releases
are cumulative/superseding and only the last five are served through the
current UI/API. Its text still ends at DR23; that last row is not proof of
today's newest release.

The exact [TAP table-enumeration GET][ztf-tables] returned **200**, **721 bytes**,
SHA-256 `0281d6dc69ba5901afdf3a48400f5bc04043c9757c32787fc36a464d12c82393`.
It advertises `ztf.ztf_current_meta_*`, `ztf.ztf_current_path_*` and
`ztf_objects_dr20` through `ztf_objects_dr24`; no DR7 image/reference table
appears in that response. The [current IBE reference metadata schema][ztf-schema]
returns 200, 7,118 bytes. These successful current-service probes do not
establish historical DR7 membership or processing identity.

The [DR7 documentation source directory][ztf-src] returned **200**, **2,335
bytes**; its listed children are HTML/source documentation, figures and a PDF,
not a frozen per-image inventory. Its [DR7 HTML][ztf-html] returned 200,
78,454 bytes. Section 2 explicitly says reference images are updated continually
and may use good exposures outside the release's single-exposure epoch spans.
Sections 8/12 give current generic paths and queries. Their “listings” are
product suffix descriptions, not an enumerated historical filename roster.
No frozen IRSA processing/reference inventory was recovered from these checked
routes; this does not establish that none exists elsewhere.

The already captured CDS roster need not be reacquired just to repeat those
findings. Fresh GETs of the [g-band metadata mapping][ztf-g-metadata] and
[O3 Npix493][ztf-g-page] both returned **200**, **2,743 / 35,091 bytes**, with
exactly the hashes in the previous acquisition audit:

```text
metadata.xml  bb16e601d7c526db91bc936f5c06de71b9bb2baaffb1b2ee2d69be6fcf34be35
Npix493       f45b4a3333c7a996b2fad763aefc75d39d6deb713e7723c77286e82ef947a9a8
```

Only these samples were rechecked today. The earlier full enumeration remains
**162,333 distinct CDS DR7 reference-image identities** from 2,304 O3 keys;
see its [scope, count differences and receipt audit](phase2-ztf-native-inventory-20261006.md).
`queryPagesComplete=true` applies to that served CDS key space. Historical
`rfid`, original processing versions/checksums and frozen IRSA DR7 completeness
remain missing; current filenames may address reprocessed bytes.

**Recommendation:** no new current-IRSA capture under a “frozen DR7” label is
justified by these rechecks. Retain the existing CDS product provenance and
`inventoryComplete=false`. Any future historical extension needs an
explicitly versioned first-party roster/processing association; an intentionally
current capture requires separately reviewed release semantics.

## Reproducibility

Temporary metadata bodies and timestamped HTTP receipts are in
`/tmp/assets-residual-followup-20261007/`; `reconcile.py`,
`reconcile-summary.json` and `membership-summary.json` record the local joins.
These are research artifacts, not managed inputs or archived dependencies.
No application code or deployed state was changed, and no scientific image
payload was fetched. The temporary files are research artifacts outside Git;
the note itself is the only output from this source-research task.

[iphas-tree]: https://api.github.com/repos/barentsen/iphas-dr2/git/trees/e2e47c6964df6bb5fe9909e317ef18f0913698db?recursive=1
[qc-introduction]: https://api.github.com/repos/barentsen/iphas-dr2/commits/60954a9e52a6dc16d430aa9e1b3d7f1c72b14d8c
[qc-file]: https://raw.githubusercontent.com/barentsen/iphas-dr2/e2e47c6964df6bb5fe9909e317ef18f0913698db/dr2/lib/iphas-qc.fits
[pipeline]: https://raw.githubusercontent.com/barentsen/iphas-dr2/e2e47c6964df6bb5fe9909e317ef18f0913698db/scripts/release-preparation/iphas-images-pipeline.fits
[constants]: https://raw.githubusercontent.com/barentsen/iphas-dr2/e2e47c6964df6bb5fe9909e317ef18f0913698db/dr2/constants.py
[augment]: https://github.com/barentsen/iphas-dr2/blob/e2e47c6964df6bb5fe9909e317ef18f0913698db/scripts/release-preparation/augment-image-metadata.py
[final-text]: https://www.iphas.org/data/images/iphas-images.txt
[iphas-data]: https://www.iphas.org/data/
[final-gz]: https://www.iphas.org/data/images/iphas-images.fits.gz
[final-sqlite]: https://www.iphas.org/data/images/iphas-images.sqlite
[final-fits]: https://www.iphas.org/data/images/iphas-images.fits
[image-http]: http://www.iphas.org/data/images/r375/r375643-1.fits.fz
[image-https]: https://www.iphas.org/data/images/r375/r375643-1.fits.fz
[ztf-releases]: https://irsa.ipac.caltech.edu/data/ZTF/docs/ztf_data_releases.txt
[ztf-tables]: https://irsa.ipac.caltech.edu/TAP/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=SELECT%20table_name%2Cdescription%20FROM%20TAP_SCHEMA.tables%20WHERE%20table_name%20LIKE%20%27%25ztf%25%27
[ztf-schema]: https://irsa.ipac.caltech.edu/ibe/search/ztf/products/ref?FORMAT=METADATA
[ztf-src]: https://irsa.ipac.caltech.edu/data/ZTF/docs/releases/dr07/src/
[ztf-html]: https://irsa.ipac.caltech.edu/data/ZTF/docs/releases/dr07/src/dr07.html
[ztf-g-metadata]: https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_g/HpxFinder/metadata.xml
[ztf-g-page]: https://alasky.cds.unistra.fr/ZTF/DR7/CDS_P_ZTF_DR7_g/HpxFinder/Norder3/Dir0/Npix493
