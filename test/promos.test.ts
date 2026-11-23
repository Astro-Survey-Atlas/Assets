import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PromoStore, automaticNewSurveys, normalizeNewSettings, normalizePromos, publicPromos } from "../server/promos.js";

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

test("promo kind defaults, validates and is exposed with its surveys", () => {
  const [plain, flagged] = normalizePromos([base, { ...base, id: "b", newSurveys: [{ surveyId: "x", newUntil: "2027-01-01" }] }]);
  assert.equal(plain!.kind, "notice");
  assert.equal(flagged!.kind, "new-survey");
  const [typed] = normalizePromos([{ ...base, id: "m", kind: "maintenance", surveyIds: ["a", "a", "b"] }]);
  assert.deepEqual(typed!.surveyIds, ["a", "b"]);
  assert.throws(() => normalizePromos([{ ...base, kind: "ad" }]), /kind/);
  assert.equal(publicPromos([typed!], now).promos[0]!.kind, "maintenance");
});

test("automatic NEW covers surveys first published within 30 days, manual flags add, suppression removes", () => {
  const first = new Map([["roman", "2026-11-10T00:00:00Z"], ["euclid", "2026-09-17T00:00:00Z"], ["spherex", "2026-11-15T00:00:00Z"]]);
  const automatic = automaticNewSurveys(first, now);
  assert.deepEqual(automatic.map((flag) => flag.surveyId).sort(), ["roman", "spherex"]);
  const settings = normalizeNewSettings({ manual: [{ surveyId: "euclid", newUntil: "2026-12-31" }], suppressed: ["spherex"] });
  const view = publicPromos([], now, settings, automatic);
  assert.deepEqual(view.newSurveys.map((flag) => flag.surveyId).sort(), ["euclid", "roman"]);
  assert.throws(() => normalizeNewSettings({ manual: [{ surveyId: "x" }] }), /newUntil/);
});

test("replace keeps NEW settings unless supplied, and persists them", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-promos-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new PromoStore(root);
  await store.initialize();
  await store.replace({ promos: [], newSettings: { manual: [], suppressed: ["gaia"] } });
  await store.replace({ promos: [base] });
  assert.deepEqual(store.document().newSettings.suppressed, ["gaia"]);
  const reopened = new PromoStore(root);
  await reopened.initialize();
  assert.deepEqual(reopened.document().newSettings.suppressed, ["gaia"]);
  assert.equal(reopened.document().schemaVersion, 2);
});
