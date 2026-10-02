export function publicOpenApi() {
  const error = { description: "Request rejected", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };
  const json = (description: string) => ({ description, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } });
  return {
    openapi: "3.0.3", info: { title: "Astro Survey Atlas Assets API", version: "1.0.0", description: "Public survey coverage and source manifests. Coordinates are ICRS; HEALPix is NESTED. Download plans contain metadata and source links. Source access policies apply. Full region lookup uses an administrator-issued API Key; this service does not currently provide online billing." }, servers: [{ url: "/" }],
    tags: [{ name: "Public coverage" }, { name: "Authenticated lookup" }],
    components: { securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-Assets-API-Key" } } },
    paths: {
      "/api/v1/status": { get: { tags: ["Public coverage"], summary: "Current coverage and query service status", responses: { "200": json("Current public versions and availability") } } },
      "/api/v1/surveys": { get: { tags: ["Public coverage"], summary: "Published surveys, releases and product modalities", responses: { "200": json("Public survey catalog") } } },
      "/api/v1/coverage": { get: { tags: ["Public coverage"], summary: "Published layers, actual orders and evidence precision", responses: { "200": json("Coverage catalog") } } },
      "/api/v1/coverage/surveys/{surveyId}/healpix": { get: { tags: ["Public coverage"], summary: "Paginate the union of published survey MOCs at an order", description: "Defaults to every published MOC in the survey. Optional releaseId/productId narrow the selection. A layer whose native maximum order is lower than the requested order produces 422. Runtime overviews without published MOCs are excluded. Copy page.nextCursor into cursor; 409 means the version changed. Interval projection bounds memory even at order 13.", parameters: [
        { name: "surveyId", in: "path", required: true, schema: { type: "string" }, example: "euclid" },
        { name: "order", in: "query", required: true, schema: { type: "integer", minimum: 0, maximum: 13 }, example: 4 },
        ...["releaseId", "productId"].map(name => ({ name, in: "query", description: "Optional comma-separated IDs", schema: { type: "string" } })),
        { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 10000, default: 1000 } },
        ...["cursor", "revision"].map(name => ({ name, in: "query", schema: { type: "string" } })),
      ], responses: { "200": json("Sorted unique pixels, total, layer versions and continuation cursor"), "400": error, "404": error, "409": error, "422": error, "429": error } } },
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
