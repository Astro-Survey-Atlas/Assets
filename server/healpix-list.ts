import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NativeMoc } from "./native-moc.js";
import { AccessError } from "./region-access.js";

export interface HealpixLayer { layerId: string; productId: string; releaseId: string; modality?: string; moc: NativeMoc }
type Range = [number, number];
interface Cursor { version: 1; revision: string; selector: string; nextPixel: number }
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cache = new Map<string, Range[]>();
let cachedRanges = 0;

/** Project into intervals. Never expand an all-sky O13 result just to paginate it. */
export function healpixRanges(mocs: readonly NativeMoc[], order: number): Range[] {
  const ranges: Range[] = [];
  for (const moc of mocs) for (const cell of moc.cells) {
    const scale = 4 ** Math.abs(order - cell.order);
    const low = cell.order <= order ? cell.pixel * scale : Math.floor(cell.pixel / scale);
    ranges.push([low, cell.order <= order ? (cell.pixel + 1) * scale : low + 1]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

export function healpixList(options: { surveyId: string; layers: HealpixLayer[]; order: number; pageSize?: number; cursor?: string; revision?: string; secret: string }) {
  const { surveyId, layers, order, secret } = options;
  const pageSize = options.pageSize ?? 1000;
  if (!Number.isSafeInteger(order) || order < 0 || order > 13) throw new AccessError(400, "order must be an integer from 0 to 13");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new AccessError(400, "pageSize must be from 1 to 10000");
  if (!layers.length) throw new AccessError(404, "No published MOC matches this survey and selection");
  const unsupportedLayers = layers.filter(layer => layer.moc.maxOrder < order).map(layer => ({ layerId: layer.layerId, productId: layer.productId, releaseId: layer.releaseId, maxOrder: layer.moc.maxOrder }));
  if (unsupportedLayers.length) return { unsupportedLayers, status: 422 as const, error: "Some selected MOCs do not support this order; restrict releaseId or productId", availableOrders: Array.from({ length: Math.min(...layers.map(layer => layer.moc.maxOrder)) + 1 }, (_, index) => index) };
  const identities = layers.map(layer => ({ layerId: layer.layerId, productId: layer.productId, releaseId: layer.releaseId, nativeRevision: layer.moc.revision, maxOrder: layer.moc.maxOrder, modality: layer.modality })).sort((a, b) => a.layerId.localeCompare(b.layerId));
  const revision = digest({ surveyId, order, identities });
  const selector = digest({ surveyId, order, layers: identities.map(layer => layer.layerId) });
  if (options.revision !== undefined && options.revision !== revision) throw new AccessError(409, "Coverage version changed; restart the list");
  let nextPixel = 0;
  if (options.cursor) {
    const [body, signature, extra] = options.cursor.split(".");
    const expected = createHmac("sha256", secret).update(body ?? "").digest("base64url");
    if (!body || !signature || extra || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new AccessError(400, "Invalid HEALPix cursor");
    let cursor: Cursor;
    try { cursor = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor; } catch { throw new AccessError(400, "Invalid HEALPix cursor"); }
    if (cursor.version !== 1 || !Number.isSafeInteger(cursor.nextPixel) || cursor.nextPixel < 0 || cursor.nextPixel > 12 * 4 ** order) throw new AccessError(400, "Invalid HEALPix cursor");
    if (cursor.revision !== revision || cursor.selector !== selector) throw new AccessError(409, "Coverage version or list selection changed; restart the list");
    nextPixel = cursor.nextPixel;
  }
  let ranges = cache.get(revision);
  if (!ranges) {
    ranges = healpixRanges(layers.map(layer => layer.moc), order);
    if (ranges.length <= 100_000) {
      while (cache.size >= 16 || cachedRanges + ranges.length > 250_000) {
        const key = cache.keys().next().value;
        if (!key) break;
        cachedRanges -= cache.get(key)!.length; cache.delete(key);
      }
      cache.set(revision, ranges); cachedRanges += ranges.length;
    }
  }
  const total = ranges.reduce((sum, [low, high]) => sum + high - low, 0);
  const pixels: number[] = []; let hasMore = false;
  let lowIndex = 0, highIndex = ranges.length;
  while (lowIndex < highIndex) { const middle = (lowIndex + highIndex) >>> 1; if (ranges[middle]![1] <= nextPixel) lowIndex = middle + 1; else highIndex = middle; }
  for (let index = lowIndex; index < ranges.length; index++) {
    const [low, high] = ranges[index]!;
    for (let pixel = Math.max(low, nextPixel); pixel < high; pixel++) {
      if (pixels.length === pageSize) { hasMore = true; break; }
      pixels.push(pixel);
    }
    if (hasMore) break;
  }
  let nextCursor: string | undefined;
  if (hasMore) {
    const body = Buffer.from(JSON.stringify({ version: 1, revision, selector, nextPixel: pixels.at(-1)! + 1 } satisfies Cursor)).toString("base64url");
    nextCursor = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  }
  return { status: 200 as const, schemaVersion: 1, surveyId, coordinateFrame: "ICRS", ordering: "NESTED", order, nside: 2 ** order, revision, layers: identities, availableOrders: Array.from({ length: Math.min(...layers.map(layer => layer.moc.maxOrder)) + 1 }, (_, index) => index), projection: "inclusive-native-moc", precision: order < Math.max(...layers.map(layer => layer.moc.maxOrder)) ? "estimated" : "native-moc", pixels, total, page: { pageSize, shown: pixels.length, hasMore, ...(nextCursor ? { nextCursor } : {}) } };
}
