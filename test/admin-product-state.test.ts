import assert from "node:assert/strict";
import test from "node:test";
import { productLifecycleLabels, productLifecycleState } from "../site/admin/product-state.js";

test("each server review state maps to exactly one lifecycle label", () => {
  const cases: Array<[string | undefined, string]> = [
    ["draft", "pending"], ["unmatched-draft", "pending"], [undefined, "pending"],
    ["reviewed", "reviewed"], ["published", "published"], ["unmatched-published", "published"],
    ["unmatched", "unregistered"],
  ];
  for (const [state, expected] of cases) {
    assert.equal(productLifecycleState({ review: state === undefined ? undefined : { state } }), expected, String(state));
  }
});

test("retirement wins over every other state", () => {
  assert.equal(productLifecycleState({ retiredAt: "2026-11-01", review: { state: "published" } }), "retired");
  assert.equal(productLifecycleState({ lifecycle: { publication: { state: "RETIRED" } }, review: { state: "reviewed" } }), "retired");
});

test("the client does not recompute revisions the server already normalised", () => {
  // Extra revision fields must not change the result; the server's state is authoritative.
  const product = { review: { state: "published", draftRevision: 5, publishedRevision: 3 } };
  assert.equal(productLifecycleState(product), "published");
});

test("every lifecycle state has a label", () => {
  assert.deepEqual(Object.keys(productLifecycleLabels).sort(), ["pending", "published", "retired", "reviewed", "unregistered"]);
});
