import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AccessError } from "./region-access.js";

export interface CoverageOverviewFootprint {
  surveyId: string;
  releaseId: string;
  product: string;
  productId: string;
  layerId: string;
  nside: number;
  pixels: number[];
}

interface CoverageCursor {
  version: 1;
  revision: string;
  offset: number;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

/** Pages whole product footprints while binding each cursor to one exact overview. */
export function pageCoverageFootprints(options: {
  footprints: readonly CoverageOverviewFootprint[];
  generatedAt: string;
  nside: number;
  pageSize?: number;
  cursor?: string;
  secret: string;
}) {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new AccessError(400, `pageSize must be from 1 to ${MAX_PAGE_SIZE}`);
  }

  const revision = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    coordinateFrame: "ICRS",
    ordering: "NESTED",
    nside: options.nside,
    generatedAt: options.generatedAt,
    footprints: options.footprints,
  })).digest("hex");

  let offset = 0;
  if (options.cursor) {
    const [body, signature, extra] = options.cursor.split(".");
    const expected = createHmac("sha256", options.secret).update(body ?? "").digest("base64url");
    if (!body || !signature || extra || signature.length !== expected.length
      || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new AccessError(400, "Invalid coverage cursor");
    }
    let cursor: CoverageCursor;
    try {
      cursor = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CoverageCursor;
    } catch {
      throw new AccessError(400, "Invalid coverage cursor");
    }
    if (cursor.version !== 1 || !Number.isSafeInteger(cursor.offset)
      || cursor.offset < 0 || cursor.offset > options.footprints.length) {
      throw new AccessError(400, "Invalid coverage cursor");
    }
    if (cursor.revision !== revision) throw new AccessError(409, "Coverage version changed; restart the list");
    offset = cursor.offset;
  }

  const footprints = options.footprints.slice(offset, offset + pageSize);
  const hasMore = offset + footprints.length < options.footprints.length;
  let nextCursor: string | undefined;
  if (hasMore) {
    const body = Buffer.from(JSON.stringify({ version: 1, revision, offset: offset + footprints.length } satisfies CoverageCursor)).toString("base64url");
    nextCursor = `${body}.${createHmac("sha256", options.secret).update(body).digest("base64url")}`;
  }

  return {
    schemaVersion: 1 as const,
    coordinateFrame: "ICRS" as const,
    ordering: "NESTED" as const,
    nside: options.nside,
    generatedAt: options.generatedAt,
    revision,
    footprints,
    total: options.footprints.length,
    page: { pageSize, shown: footprints.length, hasMore, ...(nextCursor ? { nextCursor } : {}) },
  };
}
