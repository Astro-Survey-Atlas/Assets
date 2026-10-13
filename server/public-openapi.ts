export function publicOpenApi() {
  const error = { description: "Request rejected", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };
  const json = (description: string) => ({ description, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } });
  const overviewFootprint = {
    type: "object",
    required: ["surveyId", "releaseId", "product", "productId", "layerId", "nside", "pixels"],
    description: "One published product layer's O4 overview footprint. Pixels are NESTED cell IDs at this footprint's nside; they are not file, Tile, brick or observation records. / 一个已发布产品图层的 O4 概览覆盖。pixels 是该分块 nside 下的 NESTED 像元 ID，不是文件、Tile、brick 或 observation 清单。",
    properties: {
      surveyId: { type: "string", description: "Stable public survey ID. / 公开巡天 ID。" },
      releaseId: { type: "string", description: "Public release containing the product. / 产品所属的公开 release。" },
      product: { type: "string", description: "Published product name. / 已发布产品名称。" },
      productId: { type: "string", description: "Stable product identity. / 稳定产品 ID。" },
      layerId: { type: "string", description: "Stable coverage-layer identity. / 稳定覆盖图层 ID。" },
      nside: { type: "integer", description: "HEALPix NSIDE for pixels; order = log2(nside), currently 16 (O4). / pixels 使用的 HEALPix NSIDE；order=log2(nside)，当前为 16（O4）。" },
      pixels: { type: "array", items: { type: "integer" }, description: "Sorted unique NESTED cell IDs for this layer at nside. / 本图层在该 nside 下排序去重后的 NESTED 像元 ID。" },
    },
  };
  const overviewPage = {
    type: "object",
    required: ["pageSize", "shown", "hasMore"],
    properties: {
      pageSize: { type: "integer", description: "Maximum number of footprint records requested. / 请求的 footprint 记录上限。" },
      shown: { type: "integer", description: "Footprint records in this page. / 本页返回的 footprint 记录数。" },
      hasMore: { type: "boolean", description: "Whether another footprint page exists; this says nothing about native inventory completeness. / 是否还有下一页；不表示原生清单完整性。" },
      nextCursor: { type: "string", description: "Signed continuation token, present only when hasMore is true. Pass it unchanged with the same pageSize. / 仅 hasMore=true 时返回的签名续页 token；保持 pageSize 不变并原样传回。" },
    },
  };
  const surveyHealpixLayer = {
    type: "object",
    required: ["layerId", "productId", "releaseId", "nativeRevision", "maxOrder"],
    properties: {
      layerId: { type: "string", description: "Coverage-layer identity included in the union. / 并集中包含的覆盖图层 ID。" },
      productId: { type: "string", description: "Published product identity. / 已发布产品 ID。" },
      releaseId: { type: "string", description: "Published release identity. / 已发布 release ID。" },
      nativeRevision: { type: "string", description: "Revision of the source layer's native MOC. / 源图层原生 MOC 版本。" },
      maxOrder: { type: "integer", description: "Highest native MOC order for this layer. / 本图层原生 MOC 的最高 order。" },
      modality: { type: "string", description: "Published product modality when declared. / 已声明时返回产品模态。" },
    },
  };
  const pageInfo = {
    type: "object",
    required: ["pageSize", "shown", "hasMore"],
    properties: {
      pageSize: { type: "integer", description: "Maximum number of pixels requested. / 请求的像元数上限。" },
      shown: { type: "integer", description: "Number of pixel IDs in this page. / 本页像元 ID 数。" },
      hasMore: { type: "boolean", description: "Whether more pixels remain in this frozen list. False means the pixel list is exhausted, not that source inventory is complete. / 此冻结列表是否还有像元。false 表示像元分页耗尽，不代表来源库存完整。" },
      nextCursor: { type: "string", description: "Signed cursor for the next page; returned only when hasMore is true. / 下一页的签名 cursor；仅 hasMore=true 时返回。" },
    },
  };
  const surveyHealpixResponse = {
    type: "object",
    required: ["status", "schemaVersion", "surveyId", "coordinateFrame", "ordering", "order", "nside", "revision", "layers", "availableOrders", "projection", "precision", "pixels", "total", "page"],
    description: "One page of the sorted, duplicate-free union of all selected published MOCs for a survey, projected to the requested order. This is a coverage-cell list, not a native-unit or science-file inventory. / 所选巡天已发布 MOC 在请求阶数上的排序去重并集分页。这是覆盖像元清单，不是原生分块或科学文件库存。",
    properties: {
      status: { type: "integer", enum: [200], description: "HTTP status repeated in the JSON body. / JSON body 中重复的 HTTP 状态码。" },
      schemaVersion: { type: "integer", enum: [1], description: "Response schema version. / 响应 schema 版本。" },
      surveyId: { type: "string", description: "Selected public survey. / 所选公开巡天。" },
      coordinateFrame: { type: "string", enum: ["ICRS"], description: "Sky coordinate frame. / 天球坐标系。" },
      ordering: { type: "string", enum: ["NESTED"], description: "HEALPix indexing scheme. / HEALPix 像元排序方式。" },
      order: { type: "integer", description: "Requested HEALPix order. / 请求的 HEALPix 阶数。" },
      nside: { type: "integer", description: "2^order; for order 5 this is 32. / 等于 2^order；order 5 时为 32。" },
      revision: { type: "string", description: "Digest binding this list to its survey, order and included native layer revisions. Pass it unchanged as revision when continuing. / 绑定巡天、order 和所含原生图层版本的摘要；续页时原样传入 revision。" },
      layers: { type: "array", items: { $ref: "#/components/schemas/SurveyHealpixLayer" }, description: "Published MOC layers contributing to the union, with each layer's native revision and maximum order. / 参与并集计算的已发布 MOC 图层及其原生版本和最高 order。" },
      availableOrders: { type: "array", items: { type: "integer" }, description: "Orders supported by every included layer (0 through the lowest layer maxOrder); this is not a list of only native cell orders. / 所有参与图层都支持的 order（从 0 到各层 maxOrder 的最低值）；不只是原生 MOC 实际存储的阶数。" },
      projection: { type: "string", enum: ["inclusive-native-moc"], description: "Each returned cell intersects at least one included native MOC after projection to the requested order. / 每个返回像元都与至少一个参与的原生 MOC 在请求阶数投影后相交。" },
      precision: { type: "string", enum: ["native-moc", "estimated"], description: "native-moc when the request is at the highest included native order; estimated when coarser than any included layer's maximum. / 请求达到参与图层最高原生阶数时为 native-moc；低于任一图层最高阶数时为 estimated。" },
      pixels: { type: "array", items: { type: "integer" }, description: "Sorted, unique NESTED pixel IDs at order. Their valid range is 0 to 12 × 4^order - 1. / order 阶下排序去重的 NESTED 像元 ID；范围为 0 到 12 × 4^order - 1。" },
      total: { type: "integer", description: "Total unique pixels in the complete selected union, not just this page. / 完整所选并集的唯一像元总数，不只是本页数量。" },
      page: { $ref: "#/components/schemas/SurveyHealpixPageInfo" },
    },
  };
  return {
    openapi: "3.0.3", info: { title: "Astro Survey Atlas Assets API", version: "0.0.1", description: "Public survey coverage and source manifests. Coordinates are ICRS; HEALPix is NESTED. Download plans contain metadata and source links. Source access policies apply. Full region lookup uses an administrator-issued API Key; this service does not currently provide online billing." }, servers: [{ url: "/" }],
    tags: [{ name: "Public coverage" }, { name: "Authenticated lookup" }],
    components: { securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-Assets-API-Key" } }, schemas: {
      CoverageOverviewFootprint: overviewFootprint,
      CoverageOverviewPageInfo: overviewPage,
      CoverageOverviewResponse: {
        type: "object",
        required: ["schemaVersion", "coordinateFrame", "ordering", "nside", "generatedAt", "footprints"],
        description: "Legacy public O4 overview for all published product layers. Omitting pageSize/cursor preserves the original full response; supplying either returns a page. / 所有已发布产品图层的旧版公开 O4 概览。不传 pageSize/cursor 保留原完整响应；传入任一参数则返回分页。",
        properties: {
          schemaVersion: { type: "integer", enum: [1] },
          coordinateFrame: { type: "string", enum: ["ICRS"] },
          ordering: { type: "string", enum: ["NESTED"] },
          nside: { type: "integer", enum: [16], description: "O4 overview NSIDE (2^4). / O4 概览 NSIDE（2^4）。" },
          generatedAt: { type: "string", format: "date-time", description: "Approved public release timestamp. / 已批准公开 release 的时间戳。" },
          revision: { type: "string", description: "Present in paginated responses; binds continuation to this exact footprint array. / 分页响应中提供，用于把续页绑定到当前 footprint 数组。" },
          footprints: { type: "array", items: { $ref: "#/components/schemas/CoverageOverviewFootprint" }, description: "One record per product layer. Each pixels array is that layer's O4 overview cells, not files or native units. / 每个产品图层一条记录；pixels 是该图层的 O4 概览像元，不是文件或原生分块。" },
          total: { type: "integer", description: "Present in paginated responses; total product-footprint records across all pages. / 分页响应中提供，表示所有页面的产品 footprint 记录总数。" },
          page: { $ref: "#/components/schemas/CoverageOverviewPageInfo" },
        },
      },
      SurveyHealpixLayer: surveyHealpixLayer,
      SurveyHealpixPageInfo: pageInfo,
      SurveyHealpixResponse: surveyHealpixResponse,
      SurveyHealpixUnsupportedOrder: {
        type: "object",
        required: ["status", "error", "availableOrders", "unsupportedLayers"],
        properties: {
          status: { type: "integer", enum: [422] },
          error: { type: "string", description: "The selected layer set cannot be projected at the requested order. / 所选图层集合不支持请求的 order。" },
          availableOrders: { type: "array", items: { type: "integer" }, description: "Common supported orders for the selected layers. / 所选图层共同支持的 order。" },
          unsupportedLayers: { type: "array", items: { type: "object", required: ["layerId", "productId", "releaseId", "maxOrder"], properties: { layerId: { type: "string" }, productId: { type: "string" }, releaseId: { type: "string" }, maxOrder: { type: "integer" } } }, description: "Layers whose native MOC ends below the requested order. / 原生 MOC 最高阶低于请求 order 的图层。" },
        },
      },
    } },
    paths: {
      "/api/v1/status": { get: { tags: ["Public coverage"], summary: "Current coverage and query service status", responses: { "200": json("Current public versions and availability") } } },
      "/api/v1/surveys": { get: { tags: ["Public coverage"], summary: "Published surveys, releases and product modalities", responses: { "200": json("Public survey catalog") } } },
      "/api/v1/coverage": { get: { tags: ["Public coverage"], summary: "All-product O4 overview footprints (optional pagination)", description: "Legacy endpoint. With no query parameters, returns all published product-layer footprints at O4 (nside 16), including each layer's pixel array; this full response is kept for compatibility. For Swagger and bounded browsing, set pageSize (default 10, maximum 100) and continue with page.nextCursor. Paging is by whole product footprint, not by individual pixel. The returned cells are a coarse overview, not native Tile/brick/observation identities or a complete file inventory. / 旧版接口。无查询参数时返回全部已发布产品图层的 O4 footprint（nside 16）及每层像元数组；为保持兼容继续保留完整响应。Swagger 和分批浏览请设置 pageSize（默认 10、最大 100），并使用 page.nextCursor 续页。分页单位是完整产品 footprint，不是单个像元。返回的是粗略概览，不是原生 Tile/brick/observation 身份或完整文件库存。", parameters: [
        { name: "pageSize", in: "query", description: "Number of whole product footprints per page. Omit both paging parameters to receive the legacy full response. / 每页返回的产品 footprint 数；两个分页参数都不传则使用旧版完整响应。", schema: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
        { name: "cursor", in: "query", description: "Signed continuation token returned by the previous page. / 上一页返回的签名续页 token。", schema: { type: "string" } },
      ], responses: { "200": { description: "O4 overview footprints. A paged response includes revision, total and page metadata. / O4 概览 footprint；分页响应额外包含 revision、total 和 page 信息。", content: { "application/json": { schema: { $ref: "#/components/schemas/CoverageOverviewResponse" } } } }, "400": error, "409": error } } },
      "/api/v1/coverage/surveys/{surveyId}/healpix": { get: { tags: ["Public coverage"], summary: "Paginate the union of published survey MOCs at an order", description: "Defaults to every published MOC in the survey. Optional releaseId/productId narrow the selection. The returned pixels are the sorted unique NESTED HEALPix cell IDs in the union of those MOCs at the requested order, not native source units. layers lists the MOCs contributing to the union. availableOrders is the common supported order range; maxOrder in layers remains each MOC's original maximum. precision is estimated when projecting below the finest included MOC order. total counts unique pixels over every page, while page.shown counts this page. Copy page.nextCursor into cursor and revision into revision for the same immutable selection; 409 means restart with the new version. page.hasMore=false means pagination is exhausted, not that any input catalogue is complete. A layer whose native maximum order is lower than the requested order produces 422. / 默认包含该巡天全部已发布 MOC；可用 releaseId/productId 缩小范围。pixels 是这些 MOC 在请求 order 下排序去重后的 NESTED HEALPix 像元 ID，并非原生分块。layers 列出参与并集的 MOC；availableOrders 表示所有图层共同支持的阶数范围，layers.maxOrder 保留各层原始最高阶。低于参与 MOC 的最高原生阶数投影时 precision 为 estimated。total 是所有页面唯一像元总数，page.shown 是本页数量。续页时原样传回 page.nextCursor 和 revision；版本变化会返回 409 并要求重启。page.hasMore=false 只表示像元分页耗尽，不代表输入清单完整。若请求阶数高于任一所选层原生最高阶则返回 422。", parameters: [
        { name: "surveyId", in: "path", required: true, schema: { type: "string" }, example: "euclid" },
        { name: "order", in: "query", required: true, schema: { type: "integer", minimum: 0, maximum: 13 }, example: 4 },
        ...["releaseId", "productId"].map(name => ({ name, in: "query", description: "Optional comma-separated IDs", schema: { type: "string" } })),
        { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 10000, default: 1000 } },
        ...["cursor", "revision"].map(name => ({ name, in: "query", schema: { type: "string" } })),
      ], responses: { "200": { description: "Sorted unique NESTED cells and their contributing MOC layers. / 排序去重的 NESTED 像元及其来源 MOC 图层。", content: { "application/json": { schema: { $ref: "#/components/schemas/SurveyHealpixResponse" } } } }, "400": error, "404": error, "409": error, "422": { description: "One or more selected MOCs do not support the requested order. / 一个或多个所选 MOC 不支持请求阶数。", content: { "application/json": { schema: { $ref: "#/components/schemas/SurveyHealpixUnsupportedOrder" } } } }, "429": error } } },
      "/api/v1/coverage/overlap": { post: { tags: ["Public coverage"], summary: "Compute connected overlap components", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["surveyIds"], properties: { surveyIds: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 64 }, modalities: { type: "array", items: { type: "string" } }, requestedOrder: { type: "integer", minimum: 0, maximum: 13 } } }, example: { surveyIds: ["euclid", "desi", "legacy-surveys", "hst"], requestedOrder: 4 } } } }, responses: { "200": json("Overlap geometry and actual shared order"), "400": error, "422": error } } },
      "/api/v1/coverage/reverse-lookup": {
        post: {
          tags: ["Authenticated lookup"],
          summary: "Native units and download-plan manifest for a selected region",
          description: "A Key with region:query grants full pagination. Anonymous requests must explicitly set preview:true to receive a six-item preview; requests without preview:true or a valid Key return 401. Regions over 100 square degrees are split into batches of at most 64 real NESTED cells and 100 square degrees. Each request runs at most 32 cell batches, stopping sooner when it fills pageSize; repeated file and native-unit identities across cells are emitted once. Pages within a batch reuse its immutable snapshot, and continuation cursors retain one root querySnapshot. A batch exceeding its 64 MiB snapshot or 100,000 unique identity bound is returned as truncated and stops further cell scanning. A single cell over 100 square degrees is rejected. querySnapshot.batch.batchComplete describes the frozen current batch, complete means all cell batches ran, queryComplete is false when any batch reports truncation, and queryExhausted combines complete and queryComplete; inventoryComplete remains false. If a source revision changes before a later batch is materialized, continuation returns 409 rather than mixing revisions. Accept: text/event-stream enables progress and completed batches before the final frozen result. JSON/CSV plans identify Tile/brick/observation units and source URIs, preserving precision and known gaps. Scientific files are retrieved by the user from their source.",
          security: [{ ApiKey: [] }, {}],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["layerIds", "order", "cells"], properties: {
            layerIds: { type: "array", items: { type: "string" }, maxItems: 64 },
            order: { type: "integer", minimum: 0, maximum: 13 },
            cells: { type: "array", items: { type: "integer", minimum: 0 }, maxItems: 4096, description: "ICRS/NESTED cells; preserve the requested order and split them into bounded cell batches." },
            preview: { type: "boolean", default: false, description: "Explicitly request the anonymous six-item preview; full pagination requires an API Key." },
            pageSize: { type: "integer", minimum: 1, maximum: 100, default: 100 },
            cursor: { type: "string" },
            querySnapshotId: { type: "string" },
            pageKind: { type: "string", enum: ["spatial-units", "supporting-evidence"] },
          } } } } },
          responses: { "200": json("Source results, downloadPlan and frozen snapshot page"), "400": error, "401": error, "403": error, "409": error, "410": error, "429": error, "503": error },
        },
      },
      "/api/v1/access/region-query": { post: { tags: ["Authenticated lookup"], summary: "Bounded query against versioned native MOCs", security: [{ ApiKey: [] }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true }, example: { purpose: "download-plan", region: { coordinateFrame: "ICRS", ordering: "NESTED", order: 4, cells: [637] }, sources: [{ surveyId: "euclid", releaseId: "euclid-q1", productId: "SELECT_FROM_CATALOG", layerId: "SELECT_FROM_CATALOG", coverageRevision: "SELECT_FROM_CATALOG", indexRevision: null }] } } } }, responses: { "200": json("Versioned geometry and evidence"), "400": error, "401": error, "409": error, "429": error } } },
    },
  };
}
