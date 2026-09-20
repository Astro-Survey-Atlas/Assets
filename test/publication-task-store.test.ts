import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PublicationTaskStore } from "../server/publication-task-store.js";

test("durable selection deduplication, restart recovery and attempt fencing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publication-tasks-"));
  const file = path.join(root, "queue.sqlite");
  let now = 1000;
  let store = new PublicationTaskStore(file, () => now);
  try {
    const selected = { products: [{ id: "euclid", revision: 4 }], hash: "immutable" };
    store.submit("a", "selection", selected);
    assert.equal(store.submit("b", "selection", { revision: 5 }).id, "a");
    const first = store.claim()!;
    assert.equal(store.claim(), undefined);
    store.close();
    store = new PublicationTaskStore(file, () => now);
    assert.deepEqual(store.get("a")?.payload, selected);
    store.recoverStopped("a", false);
    assert.equal(store.claim(), undefined);
    now += 5000;
    const next = store.claim()!;
    assert.notEqual(first.attemptId, next.attemptId);
    assert.throws(() => store.heartbeat("a", first.attemptId!), /Obsolete/);
    store.beginActivation("a", next.attemptId!, { bundle: "candidate" });
    assert.throws(() => store.cancelStopped("a"), /Cannot cancel/);
    store.recoverStopped("a", true);
    assert.equal(store.get("a")?.phase, "site-pending");
    assert.equal(store.claim(), undefined);
    store.verified("a");
    assert.equal(store.get("a")?.phase, "published");
    assert.equal(store.attempts("a").length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("only three transient retries at 5/15/45 seconds; permanent failures do not retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publication-retries-"));
  let now = 1000;
  const store = new PublicationTaskStore(path.join(root, "queue.sqlite"), () => now);
  try {
    store.submit("a", "selection", { revision: 4 });
    for (const delay of [5000, 15000, 45000]) {
      const task = store.claim()!;
      store.fail("a", task.attemptId!, "timeout", true);
      assert.equal(store.claim(), undefined);
      now += delay;
    }
    const fourth = store.claim()!;
    store.fail("a", fourth.attemptId!, "timeout", true);
    assert.equal(store.get("a")?.phase, "failed");
    now += 1_000_000;
    assert.equal(store.claim(), undefined);
    store.submit("b", "another", {});
    const permanent = store.claim()!;
    store.fail("b", permanent.attemptId!, "review changed", false);
    assert.equal(store.get("b")?.phase, "failed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("lease expiry rejects late activation and cancellation retains history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publication-lease-"));
  let now = 1000;
  const store = new PublicationTaskStore(path.join(root, "queue.sqlite"), () => now);
  try {
    store.submit("a", "selection", {});
    const first = store.claim()!;
    now += 120_000;
    assert.throws(() => store.beginActivation("a", first.attemptId!, {}), /expired/);
    store.cancelStopped("a");
    assert.equal(store.get("a")?.phase, "cancelled");
    assert.equal(store.attempts("a").length, 1);
    assert.equal(store.submit("b", "selection", {}).id, "b");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot restores frozen inputs and attempts without overwriting live state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publication-snapshot-"));
  const source = new PublicationTaskStore(path.join(root, "source.sqlite"));
  const restored = new PublicationTaskStore(path.join(root, "restored.sqlite"));
  try {
    source.submit("a", "selection", { revision: 7, artifact: "sha256:fixed" }, { runId: "a", status: "queued" });
    source.claim();
    restored.restore(source.snapshot());
    assert.deepEqual(restored.snapshot(), source.snapshot());
    assert.throws(() => restored.restore(source.snapshot()), /overwrite/);
  } finally { source.close(); restored.close(); await rm(root, { recursive: true, force: true }); }
});
