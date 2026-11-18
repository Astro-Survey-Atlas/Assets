import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PromoStore, normalizePromos, publicPromos } from "../server/promos.js";

const now = Date.parse("2026-11-18T00:00:00Z");
const base = { id: "a", title: { zh: "标题", en: "Title" }, body: { zh: "", en: "" } };

test("normalizePromos validates input and rejects bad data", () => {
  const [promo] = normalizePromos([{ ...base, link: "/atlas/", startsAt: "2026-11-01T00:00:00Z" }]);
  assert.equal(promo!.enabled, true);
  assert.equal(promo!.startsAt, "2026-11-01T00:00:00.000Z");
  assert.throws(() => normalizePromos([{ ...base, link: "javascript:alert(1)" }]), /link/);
  assert.throws(() => normalizePromos([{ ...base, title: { zh: "", en: "" } }]), /title/);
  assert.throws(() => normalizePromos([base, base]), /duplicated/);
  assert.throws(() => normalizePromos([{ ...base, startsAt: "2026-02-01", endsAt: "2026-01-01" }]), /endsAt/);
  assert.throws(() => normalizePromos([{ ...base, newSurveys: [{ surveyId: "x" }] }]), /newUntil/);
});

test("publicPromos returns only active items and unexpired NEW flags", () => {
  const promos = normalizePromos([
    { ...base, id: "on", newSurveys: [{ surveyId: "euclid", newUntil: "2026-12-01" }, { surveyId: "old", newUntil: "2026-01-01" }] },
    { ...base, id: "off", enabled: false, newSurveys: [{ surveyId: "hidden", newUntil: "2027-01-01" }] },
    { ...base, id: "future", startsAt: "2026-12-01T00:00:00Z" },
    { ...base, id: "ended", endsAt: "2026-11-01T00:00:00Z" },
  ]);
  const view = publicPromos(promos, now);
  assert.deepEqual(view.promos.map((p) => p.id), ["on"]);
  assert.deepEqual(view.newSurveys.map((f) => f.surveyId), ["euclid"]);
  assert.equal("enabled" in view.promos[0]!, false);
});

test("PromoStore persists across restart", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-promos-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new PromoStore(root);
  await store.initialize();
  assert.deepEqual(store.document().promos, []);
  await store.replace({ promos: [base] });
  const reopened = new PromoStore(root);
  await reopened.initialize();
  assert.equal(reopened.document().promos[0]!.id, "a");
  await assert.rejects(reopened.replace({ promos: "nope" }));
  assert.equal(reopened.document().promos.length, 1);
  await reopened.replace({ promos: [] });
  assert.deepEqual(reopened.public().promos, []);
});
