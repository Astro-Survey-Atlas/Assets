import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError } from "../server/admin.js";
import { SurveyEditorialStore, type SurveyEditorialContent } from "../server/editorial.js";
import { productId } from "../server/products.js";
import type { PublicSurveyRecord } from "../server/types.js";

function sourceSurvey(): PublicSurveyRecord {
  return {
    id: "demo",
    name: "Demo Survey",
    mission: "A demo mission",
    color: "#123456",
    description: "The baseline survey description.",
    modalities: ["imaging"],
    releases: [{
      id: "demo-dr1",
      label: "DR1",
      kind: "release",
      releasedYear: 2026,
      modalities: ["imaging"],
      products: [{
        productId: productId("demo", "demo-dr1", "Canonical image product"),
        name: "Canonical image product",
        modality: "imaging",
        description: "The baseline product description.",
        status: "acquired",
        sourceUrl: "https://example.test/data",
        coverage: { availableOrders: [4, 8], overviewOrder: 4, maxOrder: 8, layerId: "demo-layer" },
      }],
    }],
  };
}

function draftWithChanges(record: { draft: SurveyEditorialContent; revision: number }): SurveyEditorialContent {
  const draft = structuredClone(record.draft);
  draft.name = "Edited Demo Survey";
  draft.mission = "Edited mission";
  draft.description = "Edited survey description.";
  draft.releases[0]!.label = "Edited DR1";
  draft.releases[0]!.products[0]!.displayName = "Public image label";
  draft.releases[0]!.products[0]!.description = "Edited product description.";
  return draft;
}

test("editorial drafts persist, remain private until publish, and rehydrate safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-editorial-"));
  const survey = sourceSurvey();
  const store = new SurveyEditorialStore(root);
  await store.initialize([survey]);
  const initial = store.get("demo");
  assert.equal(initial.revision, 1);
  assert.equal(initial.published, null);
  assert.equal(initial.draft.releases[0]?.products[0]?.canonicalName, "Canonical image product");

  const updated = await store.updateDraft("demo", draftWithChanges(initial), initial.revision);
  assert.equal(updated.revision, 2);
  assert.equal(updated.published, null);
  assert.equal(updated.audit.at(-1)?.action, "draft");
  const runtime = { surveys: [survey] };
  assert.equal(store.applyPublished(runtime).surveys[0]?.name, "Demo Survey");
  assert.equal(store.applyDraft(runtime, "demo").surveys[0]?.name, "Edited Demo Survey");

  const file = JSON.parse(await readFile(path.join(root, "survey-editorial-v1.json"), "utf8")) as { schemaVersion: number; surveys: unknown[] };
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.surveys.length, 1);
  assert.equal((await readdir(root)).some((entry) => entry.includes(".tmp")), false);

  const restored = new SurveyEditorialStore(root);
  await restored.initialize([survey]);
  assert.equal(restored.get("demo").revision, 2);
  assert.equal(restored.get("demo").draft.name, "Edited Demo Survey");

  const published = await restored.publish("demo", 2);
  assert.equal(published.published?.name, "Edited Demo Survey");
  const publicIndex = restored.applyPublished(runtime);
  const product = publicIndex.surveys[0]!.releases[0]!.products[0]!;
  assert.equal(publicIndex.surveys[0]?.name, "Edited Demo Survey");
  assert.equal(publicIndex.surveys[0]?.releases[0]?.label, "Edited DR1");
  assert.equal(product.name, "Public image label");
  assert.equal(product.description, "Edited product description.");
  assert.equal(product.productId, survey.releases[0]!.products[0]!.productId);
  assert.equal(product.coverage?.layerId, "demo-layer");
});

test("editorial validation locks identity and topology and rejects revision conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-editorial-validation-"));
  const store = new SurveyEditorialStore(root);
  await store.initialize([sourceSurvey()]);
  const record = store.get("demo");

  const forgedId = structuredClone(record.draft);
  forgedId.releases[0]!.products[0]!.productId = "forged-product";
  await assert.rejects(() => store.updateDraft("demo", forgedId, record.revision), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /immutable|invalid/.test(error.message));

  const unknownField = { ...structuredClone(record.draft), unsupported: "no" };
  await assert.rejects(() => store.updateDraft("demo", unknownField, record.revision), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /unsupported field/.test(error.message));

  const reordered = structuredClone(record.draft);
  reordered.releases = [];
  await assert.rejects(() => store.updateDraft("demo", reordered, record.revision), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400);

  const addedNote = structuredClone(record.draft);
  addedNote.releases[0]!.products[0]!.reason = "This field was not in the catalog.";
  await assert.rejects(() => store.updateDraft("demo", addedNote, record.revision), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /not editable/.test(error.message));

  await assert.rejects(() => store.updateDraft("demo", record.draft, record.revision + 1), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409);
});
