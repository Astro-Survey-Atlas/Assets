# Assets API Reference

这是 Astro Survey Atlas Assets 的公开只读 API 维护入口。路由、响应字段、媒体类型、缓存、Range 或预览能力变更时，必须在同一变更中更新本文、`README.md` 的入口和对应 HTTP 测试。

该公开服务只读取已经构建并通过 `release-manifest.json` allowlist 校验的静态制品；运行时不访问 OSS、Connector、data-warehouse 或任务状态，也不处理或暴露原始远程凭据。这里描述的是公开只读服务边界，不限制 Assets 项目自行管理 DataSource、Secret 和任务。

## Conventions

- Base path: `/api/v1`。
- 所有接口只接受 `GET` 和 `HEAD`；其它方法返回 `405`。
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
API 本身保持只读，不创建或执行任务。

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
```

返回公开巡天、Release 和产品状态的只读索引，供 Assets 网站渲染卡片和详情。它只反映审核后进入当前公开 release 的内容；尚未审核的登记或 coverage task 不会出现在这里。

## Coverage Catalog And Blocks

```http
GET /api/v1/coverage/catalog
GET /api/v1/coverage/blocks/{layerId}?order=4&tile=0
```

`coverage/catalog` is the lightweight runtime index. It declares `coordinateFrame: ICRS`, `ordering: NESTED`, the `tileScheme`, stable `layerId`/`productId`, real `availableOrders`, area and cell counts. A block contains only explicit `order`/`ipix` cells and a SHA-256 of that cell payload. Blocks are immutable and support gzip or Brotli content negotiation, `ETag` and long-lived cache headers. The browser requests overview blocks first and higher-order blocks only after zooming.

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

草稿和版本控制只在管理员认证边界内：`GET /api/v1/admin/products`、`GET /api/v1/admin/products/{productId}`、`PUT /api/v1/admin/products/{productId}/draft`、`POST /api/v1/admin/products/{productId}/publish` 和 `GET /api/v1/admin/products/{productId}/history`。产品 ID 固定由 `surveyId + releaseId + product name` 生成；流程图节点的实现引用由 recipe 固定，管理员只能修改解释文本和证据链接。

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
