# Assets API Reference

这是 Astro Survey Atlas Assets 的公开只读 API 维护入口。路由、响应字段、媒体类型、缓存、Range 或预览能力变更时，必须在同一变更中更新本文、`README.md` 的入口和对应 HTTP 测试。

公开 catalog、block、下载和预览只读取已经构建并通过
`release-manifest.json` allowlist 校验的静态制品。覆盖反查是一个明确的
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

返回当前 release manifest 的公开投影。每个 `files[]` 条目包含稳定 `id`、标签、媒体类型、下载名、大小、SHA-256、巡天/发布/产品关联和来源说明；服务器内部 `path` 不会返回。

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

返回公开巡天、Release 和产品状态的只读索引，供 Assets 网站渲染卡片和详情。它只反映审核后进入当前公开 release 的内容；尚未审核的登记或 coverage task 不会出现在这里。

## Coverage Catalog And Blocks

```http
GET /api/v1/coverage/catalog
GET /api/v1/coverage/blocks/{layerId}?order=4&tile=0
```

`coverage/catalog` is the lightweight runtime index. It declares `coordinateFrame: ICRS`, `ordering: NESTED`, the `tileScheme`, stable `layerId`/`productId`, real `availableOrders`, area and cell counts. A block contains only explicit `order`/`ipix` cells and a SHA-256 of that cell payload. Blocks are immutable and support gzip or Brotli content negotiation, `ETag` and long-lived cache headers. The browser requests overview blocks first and higher-order blocks only after zooming.

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
counts and connector status). Internal `s3://`, MinIO, Elasticsearch,
Kubernetes, PVC and local paths are omitted. File-level reverse lookup remains
bounded and deferred through `/api/v1/coverage/reverse-lookup`.

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

`GET /api/v1/admin/products?view=surveys` 是管理页审核入口。它按公共 `survey -> release -> product` 返回与 `/api/v1/surveys` 同源的名称、mission、描述、图片、modalities、统计、coverage orders 和产品状态；每个产品只附加 `review.state`、草稿/发布 revision、时间戳和当前 coverage 投影。它不会返回 input manifest、normalized scan、task snapshot、evidence 内容或内部路径。存在于 Assets 编辑存储但不再匹配公共 catalog 的产品会放在 `unmatchedProducts` 中，不会静默丢失。

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

### MOC Discovery And Review

管理员 MOC 接口需要同样的令牌：

```http
GET  /api/v1/admin/moc-discovery
POST /api/v1/admin/moc-discovery
GET  /api/v1/admin/moc-discovery/{name}
POST /api/v1/admin/moc-discovery/{name}/resubmit
GET  /api/v1/admin/moc-discovery/{name}/reviews
POST /api/v1/admin/moc-discovery/{name}/reviews
```

创建请求只提交巡天、Release/产品提示，或可选的 `productId`/`workContext`。
Assets 为 MOC 探查和文件扫描写入同一个稳定的 work identity/title annotation，
因此 02A 可以把不同 attempt 聚合到同一产品工作项。列表响应只包含 phase、计数和
evidence 引用；单项详情才包含 Warehouse 投影的有界 `status.reviewSummary`：候选、
probe、URL、响应哈希和空间 MOC 校验摘要。完整响应仍在 Warehouse evidence 中。

审核 POST 只允许提交 `candidateId`、可选 `probeId`、决定和备注。服务端会重新从
当前 Warehouse status 解析 URL/哈希并拒绝不存在或被篡改的 candidate/probe；
`ready-for-build` 必须是成功 request 中 `ok=true` 且 `validation.acceptedSpatialMoc=true`
的 probe。旧版成功但没有 `reviewSummary` 的请求会明确返回缺失状态，需通过
`resubmit` 创建新的不可变探查 attempt；原请求和 evidence 保留。合法的零候选/零 probe
结果与摘要缺失是两种不同状态，截断也会单独标明。

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

`GET /api/v1/admin/catalog/status` 返回当前 coverage 的加载模式、时间和记录数；
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
