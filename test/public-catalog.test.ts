import assert from "node:assert/strict";
import test from "node:test";

import { loadPublicCatalogResource, resolvePublicCatalogResource } from "../site/src/public-catalog.js";

test("public catalog keeps the current value when a refresh rejects", async () => {
  const current = { revision: "current" };
  const result = await loadPublicCatalogResource(() => Promise.reject(new Error("503")), { current });
  assert.deepEqual(result.value, current);
  assert.equal(result.source, "memory");
  assert.equal(result.error, "503");
});

test("public catalog uses a valid cached value when no in-memory value exists", async () => {
  const cached = { revision: "cached" };
  const result = await loadPublicCatalogResource(() => Promise.resolve(null), { cached });
  assert.deepEqual(result.value, cached);
  assert.equal(result.source, "cached");
});

test("public catalog reports unavailable without throwing when all fallbacks are absent", () => {
  const result = resolvePublicCatalogResource<{ revision: string }>({ status: "rejected", reason: new Error("network down") });
  assert.equal(result.value, null);
  assert.equal(result.source, "unavailable");
  assert.equal(result.error, "network down");
});

test("a fresh public catalog document always wins over stale fallbacks", () => {
  const result = resolvePublicCatalogResource(
    { status: "fulfilled", value: { revision: "fresh" } },
    { current: { revision: "current" }, cached: { revision: "cached" } },
  );
  assert.deepEqual(result.value, { revision: "fresh" });
  assert.equal(result.source, "fresh");
  assert.equal(result.error, undefined);
});
