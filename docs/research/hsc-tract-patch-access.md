# HSC Tract/Patch Download and Query Access

Checked 2026-09-30 (Asia/Shanghai) against HSC PDR2/PDR3 first-party release
pages and the official HSC SSP data-access-tools repository. No HSC credentials
were used and no science data were requested or downloaded.

## Conclusion

The public first-party material inspected here does not document a stable URL
template for downloading an original HSC `tract/patch` image, nor a DAS Search
browser deep-link contract that pre-fills `tract`, `patch`, and `filter`. It
documents release/area entry points and authenticated search/retrieval tools.
The authenticated directory tree might expose file links or navigation rules,
but it returned HTTP 401 without an HSC account, so this check cannot establish
whether an internal authenticated deep link exists.

There is a documented official alternative for minimizing transferred image
volume: submit a sky-coordinate rectangle to the release's image-cutout tool.
This returns FITS cutouts rather than the full original patch file. Its request
can optionally be constrained to a tract, but its documented request fields do
not include a patch identifier. Therefore it is a cutout endpoint, not a
tract/patch file URI or a patch-specific DAS Search link.

## Official access points and policy

| Purpose | PDR3 URL | What the public documentation establishes |
|---|---|---|
| DAS Search | <https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/> | Release-scoped search/retrieval entry point; not a demonstrated pre-filled query link. |
| DAS Search usage guide | <https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/usage.html> | Linked by the official PDR3 access page; GET returned `401` with `WWW-Authenticate: Basic realm="hsc-ssp"` in this check. |
| Wide directory tree | <https://hsc-release.mtk.nao.ac.jp/archive/filetree/pdr3_wide/> | Official release/area directory-tree entry point; GET returned the same Basic Auth `401`. It is not a public per-patch URI template. |
| Image cutout service | <https://hsc-release.mtk.nao.ac.jp/das_cutout/pdr3/> | Release cutout tool; its manual also returned Basic Auth `401`, while the official public source repository documents the client request format. |
| Catalog SQL job API | <https://hsc-release.mtk.nao.ac.jp/datasearch/api/catalog_jobs/> | Authenticated SQL catalog query API used by the official CLI; catalog query results are not image file links. |

The official [PDR3 Data Access page](https://hsc-release.mtk.nao.ac.jp/doc/index.php/data-access__pdr3/)
states that users must register to search, request, and retrieve data, and that
archive use is restricted to non-commercial scientific/educational purposes.
The [PDR2 Data Access page](https://hsc-release.mtk.nao.ac.jp/doc/index.php/tools-2/)
states the same account and use-policy requirements. These are source-side
access conditions: Assets should provide the official service link and explain
that the user completes access under HSC's policy; Assets should not proxy the
user's account or imply anonymous downloads.

The official PDR3 page links DAS Search and its usage guide, and separately
labels the file-tree links "Direct access to the directory tree" for release
areas such as Wide and Deep/UltraDeep. It also says an image patch is a 4k x
4k image. These public pages document the concepts and navigation entry points,
but do not publish an HTTP path rule from `tract/patch/filter` to a direct file.

## Coordinate cutout: valid smaller-download fallback

The official [PDR3 `downloadCutout.py` README at repository revision
`47507f35b870983a35253ff49a42eb8ff0b18518`](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/downloadCutout/README.md)
documents this example for images at one location (the default requests all
available filters):

```sh
python3 downloadCutout.py \
  --ra=222.222 --dec=44.444 \
  --sw=0.5arcmin --sh=0.5arcmin \
  --name='cutout-{filter}' \
  --user=USERNAME
```

The client prompts for the password unless it is supplied through the documented
`HSC_SSP_CAS_PASSWORD` environment variable. A coordinate-list request is also
documented, so a user can submit many small sky regions in one request instead
of retrieving each region's entire 4k x 4k patch. The CLI supports choosing a
filter, release rerun, product type (`coadd`, `coadd/bg`, or `warp`), and image,
mask, and variance layers. `--tract` is optional; there is no `--patch` option.

The client source in the same pinned repository revision establishes the
request mechanics:

- PDR3 API base: `https://hsc-release.mtk.nao.ac.jp/das_cutout/pdr3`
- HTTP endpoint: `POST https://hsc-release.mtk.nao.ac.jp/das_cutout/pdr3/cgi-bin/cutout`
- Request: authenticated `multipart/form-data`, with a text file in field
  `list`. Its documented field names are `rerun type filter tract ra dec sw
  sh image mask variance`.
- Authentication: HTTP Basic Auth. The client uses `tract=any` unless a tract
  is explicitly supplied; it does not accept a patch field.
- Response: a tar stream containing FITS cutouts. The returned metadata includes
  the selected tract, filter, rerun and product type; these are response
  metadata, not stable direct source-file URLs.

For example, the official client can make a much smaller PDR3 coadd cutout in
HSC-I near a selected HEALPix center by supplying the center's RA/Dec and a
chosen rectangle size. The request needs to be submitted by the user with their
HSC account. If Assets prepares a command or request manifest, it must label it
as an authenticated cutout request and must not present it as the original
patch-file URI. Use conservative dimensions that cover the desired sky region;
the tool takes rectangle semi-width and semi-height, not a HEALPix identifier.

The exact request URL and authentication behavior are visible in the pinned
[official client source](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/downloadCutout/downloadCutout.py#L31)
and its [request construction](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/downloadCutout/downloadCutout.py#L1002).
The CLI's coordinate, filter, rerun, tract, and output-layer options are in the
[argument definitions](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/downloadCutout/downloadCutout.py#L68).

## Catalog query is a different operation

The official [`hscReleaseQuery.py` guide at the same repository revision](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/hscReleaseQuery/README.md)
documents authenticated SQL submission using the
`datasearch/api/catalog_jobs/` API. This is suitable for querying HSC catalog
rows (where the selected release schema exposes the desired catalog columns),
not for creating a tract/patch image-download URL. The API accepts SQL in a
POST job body and credentials; it is not a browser URL to which query parameters
can safely be appended.

## Assets representation

For an HEALPix-to-HSC result, Assets can return the intersecting HSC native
`tract/patch` identities and filter/release context, plus a clearly labeled
release-level authenticated DAS Search entry point. This identifies the
relevant native sky subdivisions without inventing archive paths.

For users whose priority is minimizing download size, the best documented
fallback is the official coordinate cutout workflow above. Assets may expose
the official tool/manual and generate a user-side command or request manifest
from the clicked cell geometry. It must not imply a GET deep link, direct patch
file URI, patch selector, or no-login access. A stable patch-specific URI can
be added only after HSC documentation or authenticated first-party behavior
establishes its exact path and semantics.

## First-party source references

- [HSC PDR3 Data Access](https://hsc-release.mtk.nao.ac.jp/doc/index.php/data-access__pdr3/)
- [HSC PDR2 Data Access](https://hsc-release.mtk.nao.ac.jp/doc/index.php/tools-2/)
- [PDR3 DAS Search](https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/)
- [PDR3 DAS Search usage guide](https://hsc-release.mtk.nao.ac.jp/das_search/pdr3/usage.html)
- [PDR3 Wide archive file tree](https://hsc-release.mtk.nao.ac.jp/archive/filetree/pdr3_wide/)
- [PDR3 image cutout manual](https://hsc-release.mtk.nao.ac.jp/das_cutout/pdr3/manual.html)
- [Official HSC SSP data-access-tools repository](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/tree/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/)
- [`downloadCutout.py` usage](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/downloadCutout/README.md)
- [`downloadCutout.py` API implementation](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/downloadCutout/downloadCutout.py)
- [`hscReleaseQuery.py` usage](https://hsc-gitlab.mtk.nao.ac.jp/ssp-software/data-access-tools/-/blob/47507f35b870983a35253ff49a42eb8ff0b18518/pdr3/hscReleaseQuery/README.md)
