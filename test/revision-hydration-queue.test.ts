import assert from "node:assert/strict";
import test from "node:test";

import { createRevisionHydrationQueue } from "../site/src/revision-hydration-queue.js";

interface Catalog { revision: string }

test("revision queue serializes initialization and refresh duplicates", async () => {
  const calls: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst: (() => void) | undefined;
  const queue = createRevisionHydrationQueue<Catalog>(
    (catalog) => catalog.revision,
    async (catalog) => {
      calls.push(catalog.revision);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      active -= 1;
    },
  );

  const first = queue.enqueue({ revision: "catalog-1" });
  const duplicate = queue.enqueue({ revision: "catalog-1" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst?.();
  await Promise.all([first, duplicate]);

  assert.deepEqual(calls, ["catalog-1"]);
  assert.equal(maximumActive, 1);
  assert.equal(queue.appliedRevision, "catalog-1");
});

test("a failed revision remains retryable and force retries an applied revision", async () => {
  let attempts = 0;
  const queue = createRevisionHydrationQueue<Catalog>(
    (catalog) => catalog.revision,
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    },
  );

  await assert.rejects(queue.enqueue({ revision: "catalog-2" }), /transient/);
  assert.equal(queue.appliedRevision, null);
  await queue.enqueue({ revision: "catalog-2" });
  assert.equal(queue.appliedRevision, "catalog-2");
  await queue.enqueue({ revision: "catalog-2" }, true);
  assert.equal(attempts, 3);
});
