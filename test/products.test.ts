import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError } from "../server/admin.js";
import { ProductStore } from "../server/products.js";

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-product-store-"));
  await mkdir(path.join(root, "src/surveys"), { recursive: true });
  await mkdir(path.join(root, "src/layers"), { recursive: true });
  await writeFile(path.join(root, "src/surveys/survey-catalog.json"), JSON.stringify({ schemaVersion: 1, surveys: [] }));
  await writeFile(path.join(root, "src/layers/layer-registry.json"), JSON.stringify({ schemaVersion: 1, layers: [] }));
  return root;
}

function input() {
  return {
    surveyId: "demo",
    surveyName: "Demo Survey",
    mission: "Demo mission",
    surveyDescription: "A test survey.",
    surveyColor: "#42d5c4",
    surveyModalities: ["imaging"],
    releaseId: "dr1",
    releaseLabel: "DR1",
    releaseKind: "release",
    productName: "Demo DR1",
    productDescription: "Demo coverage.",
    modality: "imaging",
    sourceUrl: "https://archive.example/demo",
    geometrySourceUrl: "https://archive.example/demo/moc.fits",
  };
}

test("ProductStore binds review to a revision and invalidates it after evidence or content changes", async () => {
  const root = await fixtureRoot();
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-product-content-"));
  try {
    const store = new ProductStore(undefined, contentRoot);
    await store.initialize(root);
    const created = await store.createMocProduct(input());
    await assert.rejects(() => store.publish(created.productId, created.revision), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409);

    const reviewed = await store.review(created.productId, created.revision, ["file-level-reverse-index-missing"]);
    assert.equal(reviewed.review?.revision, reviewed.revision);
    assert.equal(reviewed.review?.contentSha256, reviewed.contentSha256);
    const execution = await store.recordExecution(created.productId, {
      revision: reviewed.revision,
      executionId: "moc-validation-1",
      stepId: "validate",
      status: "passed",
      tool: { name: "moc-core", version: "1.1.0", imageDigest: `sha256:${"a".repeat(64)}` },
      inputs: [{ label: "source snapshot", sha256: "b".repeat(64), sizeBytes: 10 }],
      parameters: { order: 8 },
      outputs: [{ label: "validated MOC", sha256: "c".repeat(64), sizeBytes: 20 }],
      checks: [{ id: "output-integrity", status: "passed" }],
    });
    assert.equal(execution.review, undefined);
    assert.equal(execution.executions?.length, 1);
    await assert.rejects(() => store.recordExecution(created.productId, { executionId: "moc-validation-1", revision: execution.revision, stepId: "validate", status: "passed" }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409);

    const reviewedRevision = execution.revision;
    const next = await store.updateDraft(created.productId, structuredClone(execution.draft), reviewedRevision);
    assert.equal(next.revision, reviewedRevision + 1);
    assert.equal(next.review, undefined);
    await assert.rejects(() => store.recordExecution(created.productId, { revision: reviewedRevision, executionId: "stale", stepId: "validate", status: "passed" }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(contentRoot, { recursive: true, force: true });
  }
});

test("ProductStore rejects credential-like execution parameters and failed records without an error", async () => {
  const root = await fixtureRoot();
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-product-content-"));
  try {
    const store = new ProductStore(undefined, contentRoot);
    await store.initialize(root);
    const created = await store.createMocProduct(input());
    await assert.rejects(() => store.recordExecution(created.productId, { revision: 1, stepId: "scan", status: "failed", inputs: [], outputs: [], checks: [] }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /error/.test(error.message));
    await assert.rejects(() => store.recordExecution(created.productId, { revision: 1, stepId: "scan", status: "passed", parameters: { secretKey: "should-not-persist" }, inputs: [], outputs: [], checks: [] }), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 400 && /unsupported key/.test(error.message));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(contentRoot, { recursive: true, force: true });
  }
});

test("ProductStore retires a published product without deleting its historical content", async () => {
  const root = await fixtureRoot();
  const contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-product-retirement-"));
  try {
    const store = new ProductStore(undefined, contentRoot);
    await store.initialize(root);
    const created = await store.createMocProduct(input());
    await store.review(created.productId, created.revision);
    const published = await store.publish(created.productId, created.revision);
    const publishedRevision = published.revision;
    const retired = await store.retire(created.productId, publishedRevision, "Superseded by DR2");

    assert.equal(retired.retiredAt !== undefined, true);
    assert.equal(retired.retirementReason, "Superseded by DR2");
    assert.equal(retired.revision, publishedRevision + 1);
    assert.equal(retired.published?.productId, created.productId);
    assert.equal(retired.publishedRevision, publishedRevision);
    assert.equal(retired.review, undefined);
    assert.equal((await store.retire(created.productId, retired.revision, "ignored")).retirementReason, "Superseded by DR2");

    const restarted = new ProductStore(undefined, contentRoot);
    await restarted.initialize(root);
    const restored = restarted.get(created.productId);
    assert.equal(restored.retiredAt, retired.retiredAt);
    assert.equal(restored.retirementReason, "Superseded by DR2");
    assert.equal((await restarted.history(created.productId)).some((entry) => (entry as { action?: string }).action === "retire"), true);
    await assert.rejects(
      () => restarted.retire(created.productId, restored.revision - 1),
      (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409,
    );
    await assert.rejects(
      () => restarted.review(created.productId, restored.revision),
      (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409,
    );
    await assert.rejects(
      () => restarted.publish(created.productId, restored.revision),
      (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(contentRoot, { recursive: true, force: true });
  }
});

test("restoration requires completed withdrawal, preserves identity/history and invalidates approval", async () => {
  const root = await fixtureRoot(), contentRoot = await mkdtemp(path.join(os.tmpdir(), "assets-restore-"));
  try {
    const store = new ProductStore(undefined, contentRoot); await store.initialize(root);
    const product = await store.createMocProduct(input());
    await store.review(product.productId, product.revision); await store.publish(product.productId, product.revision);
    await store.retire(product.productId, product.revision, "Missing evidence");
    const retiredRevision = product.revision;
    await assert.rejects(() => store.restore(product.productId, retiredRevision, "Rebuild coverage"), /撤下/);
    store.projectPublished([], new Date().toISOString());
    await assert.rejects(() => store.restore(product.productId, retiredRevision - 1, "Rebuild coverage"), /revision/i);
    await assert.rejects(() => store.restore(product.productId, retiredRevision, ""), /reason/i);
    const restored = await store.restore(product.productId, retiredRevision, "Rebuild coverage");
    assert.equal(restored.productId, product.productId); assert.equal(restored.revision, retiredRevision + 1);
    assert.equal(restored.retiredAt, undefined); assert.equal(restored.review, undefined); assert.equal(restored.published, null);
    assert.ok(restored.restoredAt); assert.equal(restored.restorationReason, "Rebuild coverage");
    assert.equal(restored.draft.surveyId, "demo");
    await assert.rejects(() => store.restore(product.productId, restored.revision, "again"), /退休/);
    await assert.rejects(() => store.review(product.productId, restored.revision), /原生 MOC/);
    await assert.rejects(() => store.publish(product.productId, restored.revision), /review/i);
    const restarted = new ProductStore(undefined, contentRoot); await restarted.initialize(root);
    assert.equal(restarted.get(product.productId).restoredAt, restored.restoredAt);
    const history = await restarted.history(product.productId);
    assert.ok(history.some(e => (e as {action:string}).action === "retire"));
    assert.ok(history.some(e => (e as {action:string;reason?:string}).action === "restore" && (e as {reason:string}).reason === "Rebuild coverage"));
    const updated = await restarted.updateDraft(product.productId, structuredClone(restored.draft), restored.revision);
    assert.equal(updated.revision, retiredRevision + 2); assert.ok(updated.restoredAt);
  } finally { await rm(root, { recursive: true, force: true }); await rm(contentRoot, { recursive: true, force: true }); }
});
