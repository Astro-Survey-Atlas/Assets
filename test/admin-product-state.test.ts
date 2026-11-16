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

import { productBadge, skyVisibility } from "../site/admin/product-state.js";

const labels = { activeLabel: (run: { status: string }) => `发布中 ${run.status}`, withdrawal: () => "已撤下" };

test("an active publication run takes priority over the resting lifecycle", () => {
  for (const status of ["queued", "building", "uploading", "verifying"]) {
    const badge = productBadge({ review: { state: "reviewed" } }, { status }, labels);
    assert.deepEqual([badge.kind, badge.active], ["publishing", true], status);
  }
});

test("a failed run is surfaced, but a retired product keeps its retired badge when there is no run", () => {
  assert.equal(productBadge({ review: { state: "reviewed" } }, { status: "failed" }, labels).kind, "failed");
  const retired = productBadge({ retiredAt: "2026-11-01", review: { state: "published" } }, undefined, labels);
  assert.deepEqual([retired.kind, retired.label], ["retired", "已退休 · 已撤下"]);
});

test("without a run the badge is exactly the lifecycle label", () => {
  assert.deepEqual(productBadge({ review: { state: "published" } }, { status: "published" }, labels), { kind: "published", label: "已发布", active: false });
  assert.deepEqual(productBadge({ review: { state: "draft" } }, undefined, labels), { kind: "pending", label: "待审核", active: false });
});

test("sky visibility reports the live release, never the review state", () => {
  const orderText = (orders: number[]) => orders.map(order => `O${order}`).join("/");
  assert.equal(skyVisibility(undefined, orderText), "天球：未公开");
  assert.equal(skyVisibility({ published: false, orders: [], retired: false }, orderText), "天球：未公开");
  assert.equal(skyVisibility({ published: true, orders: [4, 8], retired: false }, orderText), "天球：可显示 · O4/O8");
  assert.equal(skyVisibility({ published: true, orders: [], retired: false }, orderText), "天球：已公开 · 暂无覆盖几何");
  assert.equal(skyVisibility({ published: true, orders: [4], retired: true }, orderText), "天球：待撤下");
  assert.equal(skyVisibility({ published: false, orders: [], retired: true }, orderText), "天球：已撤下");
});

import { eligibilityFlag } from "../site/admin/product-state.js";

const eligible = (over: Record<string, string> = {}) => ({
  state: "blocked", label: "暂不可审核", reason: "覆盖尚未构建或校验", publicationState: "blocked", publicationLabel: "发布：未通过门禁", ...over,
});

test("a pending product shows its review eligibility as one flag", () => {
  assert.deepEqual(eligibilityFlag("pending", eligible()), { severity: "block", text: "暂不可审核", detail: "覆盖尚未构建或校验" });
  assert.equal(eligibilityFlag("pending", eligible({ state: "ready", label: "可审核", reason: "审核条件满足" }))!.severity, "ok");
  assert.equal(eligibilityFlag("pending", eligible({ state: "confirm-limitations" }))!.severity, "warn");
});

test("a reviewed product shows only its publication gate", () => {
  const flag = eligibilityFlag("reviewed", eligible({ publicationState: "ready", publicationLabel: "发布：可提交" }))!;
  assert.deepEqual([flag.severity, flag.text, flag.detail], ["ok", "发布：可提交", ""]);
  assert.equal(eligibilityFlag("reviewed", eligible({ publicationState: "blocked" }))!.severity, "block");
});

test("published and retired products carry no flag, except a changed version", () => {
  assert.equal(eligibilityFlag("published", eligible({ state: "published" })), null);
  assert.equal(eligibilityFlag("retired", eligible({ state: "retired" })), null);
  assert.equal(eligibilityFlag("published", eligible({ state: "stale", label: "版本已变化" }))!.severity, "block");
});
