import assert from "node:assert/strict";
import test from "node:test";
import { healpixList } from "../server/healpix-list.js";
import { projectMoc, type NativeMoc } from "../server/native-moc.js";
import { AccessError } from "../server/region-access.js";

const moc = (cells: NativeMoc["cells"], revision: string): NativeMoc => ({ cells, revision, maxOrder: Math.max(...cells.map(cell => cell.order)), availableOrders: [...new Set(cells.map(cell => cell.order))], sha256: revision });
test("published HEALPix union pagination equals native MOC projections without duplicates", () => {
  const first = moc([{ order: 1, pixel: 2 }, { order: 3, pixel: 90 }], "a"), second = moc([{ order: 3, pixel: 91 }, { order: 3, pixel: 92 }], "b");
  const layers = [first, second].map((moc, index) => ({ layerId: `layer-${index}`, productId: `product-${index}`, releaseId: "r1", moc }));
  const pixels: number[] = []; let cursor: string | undefined;
  do { const result = healpixList({ surveyId: "survey", layers, order: 3, pageSize: 3, cursor, secret: "secret" }); if (result.status !== 200) throw new Error(result.error); pixels.push(...result.pixels); cursor = result.page.nextCursor; } while (cursor);
  assert.deepEqual(pixels, [...new Set([first, second].flatMap(moc => projectMoc(moc, 3).cells))].sort((a, b) => a - b));
});
test("O13 pagination does not expand a broad source cell, and rejects unsupported native orders", () => {
  const native = moc([{ order: 0, pixel: 1 }, { order: 13, pixel: 0 }], "a");
  const layers = [{ layerId: "l", productId: "p", releaseId: "r", moc: native }];
  const result = healpixList({ surveyId: "survey", layers, order: 13, pageSize: 2, secret: "secret" });
  assert.equal(result.status, 200); if (result.status !== 200) return;
  assert.deepEqual(result.pixels, [0, 4 ** 13]); assert.equal(result.total, 4 ** 13 + 1); assert.equal(result.page.hasMore, true);
  const unsupported = healpixList({ surveyId: "survey", layers: [{ ...layers[0]!, moc: moc([{ order: 4, pixel: 9 }], "b") }], order: 8, secret: "secret" });
  assert.equal(unsupported.status, 422); if (unsupported.status === 422) assert.equal(unsupported.unsupportedLayers[0]?.maxOrder, 4);
});
test("HEALPix cursor binds selection and current version", () => {
  const layers = [{ layerId: "l", productId: "p", releaseId: "r", moc: moc([{ order: 0, pixel: 1 }, { order: 2, pixel: 0 }], "a") }];
  const first = healpixList({ surveyId: "s", layers, order: 2, pageSize: 1, secret: "secret" }); if (first.status !== 200) throw new Error();
  assert.throws(() => healpixList({ surveyId: "s", layers: [{ ...layers[0]!, moc: { ...layers[0]!.moc, revision: "changed" } }], order: 2, cursor: first.page.nextCursor, secret: "secret" }), (error: unknown) => error instanceof AccessError && error.statusCode === 409);
});
