import assert from "node:assert/strict";
import test from "node:test";
import { mocBuildView, orderLabel, phaseLabel } from "../site/admin/build-display.js";

test("phase normalization falls back to PENDING", () => {
  assert.equal(phaseLabel(undefined), "PENDING");
  assert.equal(phaseLabel("  staged "), "STAGED");
});

test("orderLabel renders every order or a placeholder", () => {
  assert.equal(orderLabel([3, 13]), "O3 / O13");
  assert.equal(orderLabel([]), "--");
  assert.equal(orderLabel(undefined), "--");
});

test("a building build is busy with clamped progress", () => {
  const view = mocBuildView({ phase: "FETCHING", progress: { percent: 140, message: "downloading" } });
  assert.equal(view!.busy, true);
  assert.equal(view!.percent, 100);
  assert.match(view!.summary, /^FETCHING · 100%$/);
});

test("a staged build is at rest with cells and orders in the summary", () => {
  const view = mocBuildView({ phase: "STAGED", outputs: { cellCount: 201207, availableOrders: [3, 13] }, publishedAt: "2026-11-16" });
  assert.equal(view!.busy, false);
  assert.equal(view!.percent, undefined);
  assert.deepEqual([view!.cellCountText, view!.ordersText], ["201,207", "O3 / O13"]);
  assert.equal(view!.summary, "STAGED · 201,207 单元 · O3 / O13 · 已发布");
});

test("failed and duplicate are terminal; queued is busy without a percent", () => {
  assert.equal(mocBuildView({ phase: "FAILED" })!.busy, false);
  assert.equal(mocBuildView({ phase: "DUPLICATE" })!.busy, false);
  const queued = mocBuildView({ phase: "QUEUED" })!;
  assert.equal(queued.busy, true);
  assert.equal(queued.percent, undefined);
});

test("no build means no view", () => {
  assert.equal(mocBuildView(undefined), null);
});
