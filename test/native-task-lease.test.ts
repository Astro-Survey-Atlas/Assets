import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { maintainNativeExecutorLease } from "../server/publication-scheduler.js";
import { PublicationTaskStore } from "../server/publication-task-store.js";

test("native executor lease survives a synchronous phase longer than its lease without child IPC", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-lease-"));
  let now = 0;
  const tasks = new PublicationTaskStore(path.join(root, "tasks.sqlite"), () => now);
  t.after(async () => { tasks.close(); await rm(root, { recursive: true, force: true }); });
  tasks.submit("build", "selection", { operation: { kind: "native-unit", operation: "build" } });
  const task = tasks.claim()!;
  t.mock.timers.enable({ apis: ["setInterval"] });
  let alive = true;
  const stop = maintainNativeExecutorLease(tasks, task, () => alive);
  t.after(stop);
  // No progress or heartbeat messages arrive from the blocked executor.
  for (let i = 0; i < 20; i++) {
    now += 15_000; t.mock.timers.tick(15_000);
    assert.equal(tasks.assertAttempt(task.id, task.attemptId!).attempts, 1);
  }
  alive = false;
  now += 121_000; t.mock.timers.tick(121_000);
  assert.throws(() => tasks.assertAttempt(task.id, task.attemptId!), /expired/);
});

test("native lease keeper cannot extend a cancelled or superseded attempt", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-lease-fence-"));
  let now = 0;
  const tasks = new PublicationTaskStore(path.join(root, "tasks.sqlite"), () => now);
  t.after(async () => { tasks.close(); await rm(root, { recursive: true, force: true }); });
  tasks.submit("old", "selection", {});
  const old = tasks.claim()!;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stop = maintainNativeExecutorLease(tasks, old, () => true); t.after(stop);
  tasks.recoverStopped(old.id, false);
  now += 5_000;
  const replacement = tasks.claim()!;
  assert.notEqual(replacement.attemptId, old.attemptId);
  const deadline = replacement.leaseUntil;
  now += 15_000; t.mock.timers.tick(15_000);
  assert.equal(tasks.get(old.id)!.leaseUntil, deadline);
  tasks.cancelStopped(old.id);
  now += 15_000; t.mock.timers.tick(15_000);
  assert.equal(tasks.get(old.id)!.phase, "cancelled");
  assert.equal(tasks.get(old.id)!.leaseUntil, null);
});
