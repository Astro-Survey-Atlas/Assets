# Assets API Reference

这是 Astro Survey Atlas Assets 的公开只读 API 维护入口。路由、响应字段、媒体类型、缓存、Range 或预览能力变更时，必须在同一变更中更新本文、`README.md` 的入口和对应 HTTP 测试。

公开 catalog、block、下载和预览只读取已经构建并通过
`release-manifest.json` allowlist 校验的静态制品，或已经审核发布并通过
SHA-256 校验的动态 MOC 制品。覆盖反查是一个明确的
warehouse Elasticsearch 读路径（`ASSETS_WAREHOUSE_ES_URL`），不会访问 OSS
或旧 Assets ES，也不处理或暴露原始远程凭据。这里描述的是公开只读服务
边界，不限制 Assets 项目自行管理 ConfigMap、Secret 和 ScanRequest。

## Conventions

- Base path: `/api/v1`。
- 公开只读接口只接受 `GET` 和 `HEAD`；其它方法返回 `405`。管理员端点按各自
  契约接受 `GET`、`POST` 或 `PUT`，并需要管理员令牌。
- JSON 响应使用 `application/json; charset=utf-8`，目录接口使用 `Cache-Control: no-cache`。
- 对单个公开制品的下载和预览，`ETag` 为不可变的 `"sha256-<digest>"`，并返回 `X-Content-SHA256`。
- 未知 API 返回 `{ "error": "API endpoint not found" }` 和 `404`。

## Service Health

```http
GET /healthz
```

返回运行状态、发布 bundle SHA-256 和当前 allowlist 文件数量。它只用于部署健康检查，不应据此推断某个巡天或产品已经有有效覆盖。

## Asset Catalog

```http
GET /api/v1/assets
```

返回当前 release manifest 与已发布 MOC publication 的公开投影。每个 `files[]` 条目包含稳定 `id`、标签、媒体类型、下载名、大小、SHA-256、巡天/发布/产品关联和来源说明；服务器内部 `path` 不会返回。动态 MOC 只有在对应产品发布成功后才会加入；输入快照和构建证据不会因为发布而进入初始页面 payload。

当前 release 也包含架构边界、Assets 对 data-warehouse 的需求和 Resource
Package v3 JSON Schema，作为普通 allowlisted metadata/documentation 制品下载。
data-warehouse task schema 是 Assets 用来生成标准 CRD 的公开输入约束；该公开
API 本身保持只读，不创建或执行任务。认证后的管理端点另有明确的
`POST`/`PUT` 路由，用于创建 Connector、提交 ScanRequest 和编辑产品。
远程 Connector 由 ConfigMap + Secret 保存；本地 Connector 只引用 Warehouse
Infra 已授权的源 PVC 和可选相对 base path，Assets 不创建 PV/PVC 或接受 hostPath。

可在线预览的制品额外包含：

```json
{
  "previewUrl": "/api/v1/assets/csst-w1-geometry/preview",
  "previewMode": "text"
}
```

`previewMode` 为 `text` 或 `image`。当前 release 中所有文件都有预览入口；FITS 以文本方式展示 HDU 头卡片，ZIP 以文本方式展示压缩包目录。

## Survey Index

```http
GET /api/v1/surveys

Survey releases and products include `coverage` order metadata when a verified
coverage layer exists: `availableOrders`, `overviewOrder`, `maxOrder`, and
`layerId`. Survey and release records also include aggregated `coverageOrders`.
```

返回公开巡天、Release 和产品状态的只读索引，供 Assets 网站渲染卡片和详情。它只反映已进入当前公开目录的内容；尚未审核的登记、未发布的 MOC build 或 coverage task 不会出现在这里。

### Browser catalog failure policy

首页把 `/api/v1/surveys`、`/api/v1/coverage/catalog` 和 `/api/v1/assets`
作为三个独立的公开资源。每个请求都会进行有限重试；失败时先保留当前内存
版本，再使用同一浏览器中最近一次通过 schema 校验的缓存版本。一个资源失败不会
清空其它已经成功的目录，也不会用空的 `304` 响应覆盖当前目录。只有该资源没有
可用的内存或缓存版本时，页面才显示“巡天公开目录载入失败”。

服务端不会把浏览器缓存当作发布源。发布源始终是经过
`release-manifest.json` 校验的静态 release 或已通过文件/哈希校验的动态 MOC
publication；缓存只用于短暂网络故障时继续浏览。

## Coverage Catalog And Blocks

```http
GET /api/v1/coverage/catalog
GET /api/v1/coverage/blocks/{layerId}?order=4&tile=0
```

`coverage/catalog` is the lightweight runtime index. It declares `coordinateFrame: ICRS`, `ordering: NESTED`, the `tileScheme`, stable `layerId`/`productId`, real `availableOrders`, area and cell counts. The response also includes a content `revision` and an `ETag` of the form `"catalog-<revision>"`. A block contains only explicit `order`/`ipix` cells and a SHA-256 of that cell payload. Pass the layer revision returned by the catalog when requesting a block:

```http
GET /api/v1/coverage/blocks/desi-dr1-spectra-footprint?order=8&tile=3&revision=<layer-revision>
```

The server returns `409` when the revision is stale, so a client can reload the catalog before using the block. Revisioned blocks use immutable cache headers; requests without a revision are explicitly revalidated. Catalog requests honor `If-None-Match` and return `304 Not Modified`. The browser requests overview blocks first and higher-order blocks only after zooming.

## Coverage Overlap

```http
POST /api/v1/coverage/overlap
POST /api/v1/coverage/overlap/details
```

`overlap` first tries the highest HEALPix order shared by all selected surveys
and returns explicit cells plus connected components (`C01`, `C02`, ...). If
that order has no actual shared cells, it falls back to the next lower
explicitly published common order; it never manufactures finer cells from a
coarse overview. Every component includes the selected layer precision and an
`evidence` object. When warehouse ES is unavailable, geometry still works and
evidence is marked `entrypoint-only`.

Content-Type: application/json

`overlap/details` keeps the geometry response small and loads the selected
connected component's metadata on demand:

```json
{
  "surveyIds": ["euclid", "sdss"],
  "componentId": "C01"
}
```

The response contains the component bounds, `publicSources` (public survey,
release, product, modality and public MOC/tile/archive claims), and
`warehouseEvidence` (ACTIVE layer, scan run, source snapshot, file/coverage
counts and connector status). Infrastructure endpoints, credentials and
evidence-storage paths are omitted. Each component's deferred `evidenceLookup`
includes every layer that actually participates in that component, including
public MOC, Tile and Warehouse FileAsset layers. File/Tile reverse lookup
remains bounded and deferred through `/api/v1/coverage/reverse-lookup`.

All coverage cells remain explicit ICRS/NESTED `order/ipix` values. The
`precision` field is one of `exact`, `estimated`, `entrypoint-only` or
`truncated`; a visual overview order is never presented as a finer query
measurement.

```json
{"surveyIds":["desi","legacy-surveys"],"requestedOrder":8}
```

### `POST /api/v1/coverage/reverse-lookup`

Request:

```json
{"layerIds":["desi-dr1-spectra-footprint"],"order":8,"cells":[123,456],"limit":500}
```

The response includes the requested `order`/`nside`, `precision`, coverage
edges, source file IDs, URI/name/ETag/WCS bounds, download entrypoints and a
`truncated` flag. It never upgrades an order-4-only layer to order 8.

The service unions published products within each selected survey, then intersects the resulting survey coverages. It uses the highest real order shared by every selected survey that does not exceed `requestedOrder`; no layer is upsampled to an order it does not publish. The response reports `commonOrder`, explicit NESTED `pixels`, four-side-connected components with stable `C01` identifiers and RA/DEC bounds, plus source-unit/download matches when a release has a locked reverse index. At least two distinct survey IDs are required.

#### Download plan

`downloadPlan` is the authoritative export for this lookup. It deliberately keeps
coverage matches, real files and general public entrypoints separate:

```json
{
  "schemaVersion": 1,
  "files": [
    {
      "fileId": "file-123",
      "metadataState": "complete",
      "fileName": "tile.fits",
      "sourceUri": "s3://bucket/path/tile.fits",
      "downloadable": false,
      "matchingCoverage": [
        { "layerId": "layer-1", "order": 8, "ipix": 123, "precision": "exact" }
      ]
    }
  ],
  "entrypoints": [
    { "kind": "tile-directory", "purpose": "data-access", "tileId": "1234", "cells": [123], "url": "https://data.example/tiles/1234/" },
    { "kind": "coverage-moc", "purpose": "coverage-reference", "url": "/api/v1/coverage/layers/layer-1/moc.fits" }
  ],
  "truncated": false,
  "warnings": []
}
```

Each source `FileAsset` appears at most once in `files[]`; every matching
`order`/`ipix` edge is retained in its `matchingCoverage[]`. `metadataState`
is `missing` when Warehouse returned an edge without a matching FileAsset, so
the response never invents a complete file record. `downloadable=true` and
`downloadUrl` are reserved for a public HTTP(S) file URL. Canonical `s3://`,
`oss://` and hostless `file:///...` values remain visible verbatim as
`sourceUri` location hints but are not clickable and are explicitly not direct
browser downloads. A `file:///...` locator names the path in the Warehouse
scanner's mounted data environment; it does not claim that the same path
exists on the public Assets host. Assets does not proxy credentials, presign
objects or translate local paths.

`entrypoints[]` contains links that are useful for reaching the official data
service or checking the coverage itself, not additional file rows. Current
entrypoint kinds are `official-release`, `official-data`, `official-query`,
`coverage-source`, `coverage-moc` and `tile-directory`. MOC URLs and tile
directories therefore appear only as coverage/data entrypoints. A
`tile-directory` entry carries `tileId` and only the requested NESTED cells
that actually intersect that Tile; its URL is the official directory and
Assets does not crawl or expand the directory into inferred file rows. The
historical top-level `edges`, `sourceFiles` and `entrypoints` fields remain for
clients that have not migrated; new exports should consume `downloadPlan`.

#### CSV and JSON exports

The browser's overlap export requests the same bounded `downloadPlan`. JSON
preserves it without flattening. CSV emits one row per real item and uses:

- `item_kind=file` for a Warehouse FileAsset. `source_file_id`, `source_uri`,
  `downloadable`, `download_url` and the complete `matching_cells` JSON value
  identify the source and all matching coverage edges.
- `item_kind=entrypoint` for an official data or coverage entry. Tile rows use
  `entrypoint_kind=tile-directory`, include `tile_id`, put the exact Tile
  intersection in `matching_cells`, and put the official directory in
  `entrypoint_url`.

When a component has neither a real FileAsset locator nor an entrypoint, the
CSV contains no data row for that component. It never manufactures a blank
`entrypoint-only` placeholder such as `no-public-download-entrypoint`.

## Legacy Coverage Index

```http
GET /api/v1/coverage
```

返回兼容旧客户端的聚合覆盖 manifest，包括坐标系、NSIDE 和各巡天的 HEALPix 像元。新客户端应使用上面的 catalog/block 路由；两者都不替代原始 MOC 或几何制品的下载。

## Published Product Content

公开页面可读取已发布的产品说明：

```http
GET /api/v1/products
```

草稿和版本控制只在管理员认证边界内：`GET /api/v1/admin/products`、`GET /api/v1/admin/products?view=surveys`、`GET /api/v1/admin/products?surveyId=<surveyId>`、`GET /api/v1/admin/products/{productId}`、`PUT /api/v1/admin/products/{productId}/draft`、`POST /api/v1/admin/products/{productId}/publish` 和 `GET /api/v1/admin/products/{productId}/history`。产品 ID 固定由 `surveyId + releaseId + product name` 生成；流程图节点的实现引用由 recipe 固定，管理员只能修改解释文本和证据链接。产品记录包含已发布 coverage layer 的可用 HEALPix order。

所有 admin product 请求都必须带 `Authorization: Bearer <admin-token>`。错误语义固定如下：

| 条件 | HTTP | JSON |
| --- | --- | --- |
| 缺少或错误令牌 | `401` | `{ "error": "Invalid Assets admin token" }` |
| 产品 ID 不存在 | `404` | `{ "error": "Product not found" }` |
| 非法 URL path segment 或 JSON | `400` | 可读的 `error` |
| revision 冲突 | `409` | `{ "error": "Product revision conflict" }` |
| 未预期的 admin 异常 | `500` | `{ "error": "Internal server error" }` |

例如 `bb743658cd44269d7675` 是当前 CSST W2 草稿产品：带有效令牌的
`GET /api/v1/admin/products/bb743658cd44269d7675` 返回 `200`；不带令牌返回
`401`，不能把认证失败当成产品不存在。

`GET /api/v1/admin/products?view=surveys` 是管理页审核入口。它按公共 `survey -> release -> product` 返回与 `/api/v1/surveys` 同源的名称、mission、描述、图片、modalities、统计、coverage orders 和产品状态；每个产品只附加 `review.state`、草稿/发布 revision、时间戳和当前 coverage 投影。产品还会返回 `lifecycle`：`publication.state` 是 `DRAFT` 或 `PUBLISHED`，`runtime.state` 是 `CATALOG_BASELINE`、`ACTIVE`、`INVALID` 或 `INACTIVE`，并携带 native build orders、公开 layer orders、catalog revision 和产品/天球/Catalog/FITS MOC 链接。它不会返回 input manifest、normalized scan、task snapshot、evidence 内容或内部路径。存在于 Assets 编辑存储但不再匹配公共 catalog 的产品会放在 `unmatchedProducts` 中，不会静默丢失。

### Survey editorial copy

管理页的巡天目录编辑器使用同一份公共 `survey -> release -> product` 结构做所见即所得预览。它只保存公开文案，草稿在发布前不会进入公开接口：

```http
GET  /api/v1/admin/catalog/surveys/{surveyId}/editorial
PUT  /api/v1/admin/catalog/surveys/{surveyId}/editorial/draft
POST /api/v1/admin/catalog/surveys/{surveyId}/editorial/publish
```

`PUT` 请求体包含当前 `revision` 和 `content`。`content` 可编辑的字段是巡天的
`name`、`mission`、`description`，Release 的 `label`，以及产品的
`displayName`、`description`、已有的 `reason` 和 `manualStep`。`surveyId`、Release
顺序、产品顺序、`productId`、`canonicalName`、modality、status、coverage、layer、recipe、
hash 和来源事实由服务端从 catalog 重建并锁定；编辑器会以只读字段显示这些事实。

`revision` 用于乐观并发控制：版本不匹配返回 `409`，非法字段或试图改动锁定事实返回
`400`。发布会把当前 draft 复制为 published，并使 `/api/v1/surveys`、
`/api/v1/products` 及产品详情使用新的公开文案；它不会改变 coverage、MOC、layer、recipe
或稳定的产品 ID。所有三个 endpoint 都需要 `Authorization: Bearer <admin-token>`。

### Public product dossier and evidence

```http
GET /api/v1/products/{productId}
GET /api/v1/products/{productId}/evidence
```

`/api/v1/products` retains the historical published product fields and adds
`detailUrl`, `evidenceUrl` and typed `links[]`. The detail endpoint groups the
same product into an identity, plain-language conclusion, real coverage
orders/area, source, derivation steps, verification checks, limitations and
actions. Its `technicalDownloads` entries point to allowlisted artifacts and
include SHA-256 values where available.

The evidence endpoint is loaded on demand and is safe to expose in a browser.
It reports `status` (`complete`, `partial` or `entrypoint-only`) separately from
coverage `precision` (`exact`, `estimated`, `entrypoint-only` or `truncated`),
along with ICRS/NESTED orders, source snapshot hash, output hashes and the
official next destination. Input manifests, normalized scans, task snapshots,
PVC/object-store paths and Elasticsearch documents are never included.

Every layer with an allowlisted FITS MOC also has a predictable download URL:

```http
GET|HEAD /api/v1/coverage/layers/{layerId}/moc.fits
Range: bytes=0-1023
```

This route uses the same media type, byte-range, immutable cache, ETag and
`X-Content-SHA256` semantics as `/api/v1/assets/{assetId}/download`. The
Resource Package v3 archive remains the immutable multi-file boundary for
Workspace consumers.

The list endpoint intentionally remains published-only for backward
compatibility. Detail and evidence routes are catalog-backed: a registered
product can have a safe `entrypoint-only` or `partial` dossier before its
editorial copy is published. Draft text is never returned verbatim; the server
builds a structured projection from the catalog, current layer registry and
allowlisted release assets.

## Admin Scan Requests

### MOC Discovery And Build

管理员 MOC 接口需要同样的令牌：

```http
GET  /api/v1/admin/moc-discovery
POST /api/v1/admin/moc-discovery
GET  /api/v1/admin/moc-discovery/{name}
POST /api/v1/admin/moc-discovery/{name}/resubmit
GET  /api/v1/admin/moc-builds
POST /api/v1/admin/moc-builds
GET  /api/v1/admin/moc-builds/{name}
POST /api/v1/admin/moc-builds/{name}/retry
POST /api/v1/admin/moc-builds/{name}/register-product
```

创建 discovery 只提交巡天、Release/产品提示，或可选的 `productId`/`workContext`。
Assets 为 discovery 和文件扫描写入同一个稳定的 work identity/title annotation，
因此 02A 可以把不同 attempt 聚合到同一产品工作项。列表响应只包含 phase、计数和
evidence 引用；单项详情才包含 Warehouse 投影的有界 `status.reviewSummary`。

`cds-public-moc-v2` 只做一次 CDS MocServer 搜索，不下载候选 MOC，也不执行 probe，
不写 `ast_*`。搜索最多读取 51 条记录，状态最多保存前 50 条；第 51 条只是可靠的
truncation sentinel，因此 `truncated=true` 表示还有候选没有进入审核摘要。摘要
`schemaVersion=2` 包含 `truncated`、`summaryTruncated`、可选的 `searchRecordCount`
和候选的 `candidateId`/公共 URL。一个带合法摘要但候选为空的结果是可审核的零结果；
没有摘要则表示 discovery 尚未产生可审核结果。v1 CR/evidence 仅保留为只读历史，
不会被 v2 operator 重写，也不被 Assets 当作可构建结果。
对旧 v1 记录执行“重新探查”会复制其查询意图并创建新的 v2 retry；旧对象和证据仍不变。

选择候选后提交构建请求：

```json
{
  "discoveryRequestName": "jwst-moc-discovery-20260830",
  "candidateId": "jwst-dr1",
  "productId": "<product-id>"
}
```

服务端只从当前 Warehouse 摘要解析并校验 CDS URL，浏览器不能提交来源地址或哈希。
如果 discovery 已通过 `productId` 绑定产品，详情响应会保留该工作上下文，build
会自动继承它；请求中若提交了不同的 `productId` 会被拒绝。未绑定的 discovery
仍可在创建 build 时显式选择一个已登记产品。
独立的 Assets-owned `MocBuildRequest` 按
`QUEUED → FETCHING → SNAPSHOT_LOCKED → VALIDATING → BUILDING → PROJECTING → BUNDLING → STAGED`
执行；它调用 MOC-Core-SDK，证据和构建输出先留在 evidence。失败或重复快照分别为
`FAILED`、`DUPLICATE`，retry 会创建新的不可变 build attempt，不会触碰 ScanRequest。

如果创建时没有绑定产品，`STAGED` build 会出现在
`GET /api/v1/admin/products?view=surveys` 返回的 `__moc-builds__` 编辑队列中，
即使它的 survey 还不在静态公共 catalog 里也不会丢失。管理员提交
`POST /api/v1/admin/moc-builds/{name}/register-product`，填写 survey、release、
产品公共事实和来源 URL；Assets 会创建一个未发布的草稿产品并一次性绑定该 build。
其中 Release/产品事实可以省略或提交空字符串。单 build 详情
`GET /api/v1/admin/moc-builds/{name}` 对未绑定的 `STAGED` build 会附加
`registrationDefaults`；服务端登记时再次按同一规则兜底。已有公共 Catalog 事实优先，
其次使用 discovery 提示和候选标题，最后使用中性的 `public`/`Public MOC` 与来源描述。
调用方提供的非空值始终覆盖默认值。
之后在同一个产品审核页面编辑说明，最后调用 publish。登记不会把 discovery 候选
直接变成公开产品，也不会修改原始 build attempt 或正常 Connector/ScanRequest 流程。

产品审核发布时，`POST /api/v1/admin/products/{productId}/publish` 才会把对应的
`STAGED` build 复制到内容卷并登记 publication。登记前每个输出都会重新检查文件、
大小和 SHA-256；publication 文件缺失或被篡改时不会进入 `/api/v1/assets`、
`/api/v1/coverage` 或 `/api/v1/surveys`。发布成功后动态 layer 同时出现在这些接口，
并可通过下列 MOC URL 下载。

`GET /api/v1/admin/moc-builds` 和 `GET /api/v1/admin/moc-builds/{name}` 对已绑定产品
附加同样的 `lifecycle` 投影；构建详情仍保留 native 输出 order，产品生命周期的
runtime order 则来自当前已加载 Catalog。发布后的 lifecycle links 包含产品详情、
canonical sky deep link、Catalog 和 FITS MOC。若 runtime 为 `INVALID`，通常表示
publication 文件已存在但当前 Catalog 没有有效 layer；管理员可调用
`POST /api/v1/admin/catalog/reload` 重新激活并复核 revision。

### Admin Connectors

管理员 Connector 接口需要 `Authorization: Bearer <admin-token>`：

```http
GET  /api/v1/admin/connectors
POST /api/v1/admin/connectors
POST /api/v1/admin/connectors/{name}/probe
```

Connector 是 Assets 管理的配置对象，不是 Warehouse `ScanRequest`。列表和创建
响应的 `phase` 初始为 `NOT_CHECKED`，因为 ConfigMap 不保存连接状态。只有点击
单个 Connector 后才执行一次按需探测；对象存储使用引用 Secret 中的凭据发送
`ListObjectsV2`，本地 Connector 检查同 namespace 的授权源 PVC 是否存在、带有
`atlas.zhejianglab.org/scanner-source=true` 标签且为 `Bound`。探测结果的
`phase` 为 `READY`、`PENDING` 或 `ERROR`，并带有脱敏 `message` 和 `checkedAt`。

探测结果只在当前浏览器页面内存中展示，不写入 ConfigMap、Secret、ScanRequest、
日志或 evidence；刷新页面后会重新显示 `NOT_CHECKED`。错误响应不会返回凭据、签名
或 Authorization header。

管理员控制面使用产品 recipe 生成 ScanPlan v2。任务接口为
`GET|POST /api/v1/admin/tasks`、`GET /api/v1/admin/tasks/{name}` 和
`POST /api/v1/admin/tasks/{name}/resubmit`。详情响应只包含 CRD plan、status
summary、source snapshot hash 和 evidence path；不内嵌 manifest、normalized
scan 或错误文件。重提创建新的不可变 ScanRequest、run ID 和 evidence path，原
任务保持不变。

`GET /api/v1/admin/catalog/status` 返回当前 coverage 的加载模式、时间、内容 revision 和记录数；
`POST /api/v1/admin/catalog/reload` 重新加载静态公开覆盖，并用 Warehouse ACTIVE
layer 按 layer identity 覆盖或追加。Warehouse 不可用时保留静态 catalog，并将
模式报告为 `degraded`。

## Download

```http
GET|HEAD /api/v1/assets/{assetId}/download
Range: bytes=0-1023
```

只接受 `/api/v1/assets` 返回的稳定 `assetId`。成功时返回条目的精确 `mediaType`，并以 `Content-Disposition: attachment` 提供下载。支持单个 byte range：有 Range 时返回 `206` 和 `Content-Range`；无效范围返回 `416`。未知 ID 返回 `404`。

响应包含：

```http
Accept-Ranges: bytes
ETag: "sha256-<digest>"
X-Content-SHA256: <digest>
Cache-Control: public, max-age=31536000, immutable
```

客户端应以 manifest 中的 SHA-256 或 `X-Content-SHA256` 进行完整性校验；不把 OSS Multipart ETag 误作内容哈希。

## Online Preview

```http
GET|HEAD /api/v1/assets/{assetId}/preview
Range: bytes=0-1023
```

预览只提供 allowlist 内、具有 `previewUrl` 的安全媒体类型：`application/json`、`application/fits`、`application/zip`、`text/*`、PNG、SVG 和 WebP。JSON 在服务器端解析并以两格缩进输出；超过 2 MiB 的 JSON/文本返回前 2 MiB 和明确的截断提示。FITS 预览仅读取有限范围并显示最多 16 个 HDU 的头卡片，不把二进制表或图像数据发送给浏览器。ZIP 预览仅读取 central directory，显示条目路径、压缩大小、解压大小和压缩方法，不解压或执行条目；超大目录会明确提示截断。预览通过 `Content-Disposition: inline` 返回，并与下载使用相同的 SHA-256、ETag 和单 Range 语义。

错误语义：

| 状态 | 条件 |
| --- | --- |
| `404` | 不存在的公开 asset ID |
| `415` | 媒体类型不支持预览 |
| `416` | Range 无效或超出文件范围 |
| `422` | JSON、FITS 头或 ZIP central directory 不能被安全格式化 |

浏览器应使用 `/api/v1/assets` 的 `previewUrl` 和 `previewMode` 决定是否显示预览按钮，不能根据文件名猜测预览能力。

## Maintenance Checklist

修改任何公开 API 时：

1. 更新路由实现及本文中的请求、响应和错误契约。
2. 更新 `test/server-http.test.ts`，覆盖状态码、媒体类型、Range、ETag、SHA-256 和安全边界。
3. 若 manifest 投影字段变化，更新 `test/catalog.test.ts` 和网站调用方。
4. 若有制品或发布流程变化，更新 release-manifest 构建逻辑与 provenance 文档。
5. 运行 `npm run validate`，部署后检查 `/healthz`、`/api/v1/assets`、`/api/v1/surveys` 和 `/api/v1/coverage`。

Implementation index:

- HTTP routes: `server/server.ts`
- Public manifest projection and preview eligibility: `server/catalog.ts`
- Survey index: `server/surveys.ts`
- Coverage catalog and HEALPix block projection: `server/coverage.ts`
- Product draft/publish store: `server/products.ts`
- Release allowlist construction: `scripts/build-release-manifest.ts`
