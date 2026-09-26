import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { buildApprovedRelease } from "../server/approved-release.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";
import { uploadObjectRelease, activateObjectRelease } from "../server/object-release.js";
import { reviewedFixture } from "./reviewed-fixture.js";
import { s3HttpFixture } from "./s3-http-fixture.js";
import { createArtifactStoreFromProcess } from "../server/artifact-store.js";
import { PublicReleasePublisher, type PublicationRun } from "../server/public-release-publication.js";
import { PublicationScheduler } from "../server/publication-scheduler.js";

async function until(work: () => boolean | Promise<boolean>, timeout = 15000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("Condition timed out");
}

test("real IPC executor activates frozen product, parent persists state, verification is separate", async () => {
  const f = await reviewedFixture();
  const s3 = await s3HttpFixture();
  const previous = { ...process.env };
  Object.assign(process.env, s3.env);
  const store = createArtifactStoreFromProcess();
  let scheduler = new PublicationScheduler({ contentRoot: f.contentRoot, baselineRoot: f.root, store,
    freeze: async () => ({ products: f.products, publications: [] }), synchronize: async () => {} });
  try {
    await scheduler.initialize();
    const publisher = new PublicReleasePublisher({ ...f.options, runRepository: scheduler });
    const plan = await publisher.plan();
    const run = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"], productIds: ["product-1"] });
    assert.equal(run.status, "queued");
    assert.equal((await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds: ["m42"], productIds: ["product-1"] })).runId, run.runId);
    await scheduler.tick();
    await until(() => ["site-pending", "failed", "queued"].includes(scheduler.tasks.get(run.runId)!.phase));
    const finished = await scheduler.get(run.runId);
    assert.equal(scheduler.tasks.get(run.runId)?.phase, "site-pending", JSON.stringify(finished));
    assert.equal(finished?.status, "verifying", "authority activation is not UI completion");
    const pointer = await store.get("public/current.json");
    assert.equal(JSON.parse(pointer!.body.toString()).bundle.sha256, finished?.bundle?.sha256);
    assert.ok(![...s3.objects.keys()].some(key => key.endsWith("release.tar.gz")), "incremental publication never uploads a full tar");
    assert.equal(scheduler.tasks.attempts(run.runId).length, 1);
    assert.equal(finished?.queue?.cancellable, false);
    await scheduler.stop();
    const installed = path.join(f.base, "installed");
    await syncReleaseFromObjectStore(store, installed);
    const baselineRoot = path.join(installed, "current");
    const baseline = JSON.parse(await readFile(path.join(baselineRoot, "artifacts/public-survey-footprints/release-manifest.json"), "utf8"));
    // Simulate another valid release while the website has missed this task's
    // intermediate bundle: the already approved selection is carried forward.
    const successor = await buildApprovedRelease({ stagingRoot: path.join(f.base, "successor"), runId: "successor",
      root: baselineRoot, baseline, files: baseline.files, products: [], selected: [], publications: [], publicationFile: () => "" });
    const uploaded = await uploadObjectRelease(successor.root, baselineRoot, store, baseline.bundle.sha256);
    await activateObjectRelease(store, uploaded, baseline.bundle.sha256);
    await syncReleaseFromObjectStore(store, installed);
    scheduler.tasks.close();
    scheduler = new PublicationScheduler({ contentRoot: f.contentRoot, baselineRoot, store,
      freeze: async () => ({ products: f.products, publications: [] }), synchronize: async () => {} });
    const expectation = await scheduler.siteExpectation(run.runId);
    assert.equal(expectation?.bundle.sha256, uploaded.bundle.sha256);
    assert.equal((await scheduler.get(run.runId))?.bundle?.sha256, finished?.bundle?.sha256, "original candidate identity remains in history");

  } finally {
    await scheduler.stop();
    scheduler.tasks.close();
    for (const key of Object.keys(s3.env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await s3.close(); await rm(f.base, { recursive: true, force: true });
  }
});

test("scheduler freezes package-mode payloads and keys duplicates by mode, baseline and surveys", async t => {
  const f = await reviewedFixture();
  t.after(() => rm(f.base, { recursive: true, force: true }));
  const scheduler = new PublicationScheduler({
    contentRoot: f.contentRoot,
    baselineRoot: f.root,
    store: f.store,
    freeze: async () => ({ products: f.products, publications: [] }),
    synchronize: async () => {},
  });
  await scheduler.initialize();
  const run = {
    runId: "package-run",
    operation: "publish",
    selectedProducts: [],
    rebuildPackages: true,
    rebuildSurveyIds: ["m42"],
    planId: "plan",
    baselineBundle: f.manifest.bundle,
    surveyIds: ["m42"],
    status: "queued",
    requestedBy: undefined,
    createdAt: new Date().toISOString(),
    startedAt: undefined,
    finishedAt: undefined,
    bundle: undefined,
    archiveKey: undefined,
    archiveSizeBytes: undefined,
    archiveSha256: undefined,
    files: undefined,
    packages: undefined,
    error: undefined,
    log: [],
  } as PublicationRun;
  const queued = await scheduler.submit(run);
  assert.equal(queued.runId, run.runId);
  assert.deepEqual(scheduler.tasks.get<{ products: unknown[] }>(run.runId)?.payload.products, []);
  const duplicate = await scheduler.submit({ ...run, runId: "package-duplicate" });
  assert.equal(duplicate.runId, run.runId);
  const different = await scheduler.submit({ ...run, runId: "package-other", rebuildSurveyIds: ["other-survey"], surveyIds: ["other-survey"] });
  assert.equal(different.runId, "package-other");
  const task = scheduler.tasks.claim()!;
  scheduler.tasks.fail(task.id, task.attemptId!, "fixture failure", false);
  const retry = await scheduler.retry((await scheduler.get(run.runId))!);
  assert.ok(retry);
  assert.equal(retry.rebuildPackages, true);
  assert.deepEqual(retry.rebuildSurveyIds, ["m42"]);
  assert.deepEqual(retry.selectedProducts, []);
  scheduler.tasks.close();
});
