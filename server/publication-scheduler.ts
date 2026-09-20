import { readApprovedRelease } from "./approved-release.js";
import type { StateSnapshotSink } from "./state-snapshot.js";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { PublicationTaskStore, type PublicationTask, type PublicationTaskSnapshot } from "./publication-task-store.js";
import { activateObjectRelease, type ObjectReleasePointer } from "./object-release.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ProductRecord } from "./products.js";
import type { MocPublication } from "./moc-build.js";
import { PublicationConflictError, type PublicationRun, type PublicationRunRepository, type PublicationVerificationExpectation } from "./public-release-publication.js";

export interface FrozenPublication { products: ProductRecord[]; publications: MocPublication[] }
export interface ExecutorRequest { run: PublicationRun; frozen: FrozenPublication; contentRoot: string; baselineRoot: string }
export interface PublicationSchedulerOptions {
  contentRoot: string; baselineRoot: string; store: ArtifactStore;
  freeze: () => Promise<FrozenPublication>;
  synchronize: () => Promise<void>;
  snapshotSink?: StateSnapshotSink;
}

/** The backend is the sole queue owner and authority pointer writer. Executors only
 * calculate/upload immutable candidates and report through fenced IPC messages. */
export class PublicationScheduler implements PublicationRunRepository {
  readonly tasks: PublicationTaskStore;
  readonly #options: PublicationSchedulerOptions;
  #child: ChildProcess | undefined;
  #active: PublicationTask | undefined;
  #busy = false;
  #stopping = false;
  #cancelling = new Set<string>();
  #childDone: Promise<void> = Promise.resolve();
  #snapshotDigest = "";
  constructor(options: PublicationSchedulerOptions) {
    this.#options = options;
    this.tasks = new PublicationTaskStore(path.join(options.contentRoot, "publication", "tasks.sqlite"));
  }
  async initialize(): Promise<void> {
    if (!this.tasks.readRuns().length) {
      const restored = await this.#options.snapshotSink?.restore?.("publication-tasks");
      if (restored) this.tasks.restore(restored.state as PublicationTaskSnapshot);
    }
    // Import history once without deleting or rewriting the legacy records.
    for (const file of await readdir(path.join(this.#options.contentRoot, "publication", "runs")).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      const run = JSON.parse(await readFile(path.join(this.#options.contentRoot, "publication", "runs", file), "utf8")) as PublicationRun;
      if (!run.runId || this.tasks.readRun(run.runId)) continue;
      if (["queued", "building", "uploading", "verifying"].includes(run.status)) {
        // Legacy tasks have no frozen input. Preserve history; require an explicit
        // version-checked retry rather than constructing a new selection silently.
        run.status = "failed";
        run.error = "Legacy executor stopped during migration; retry the reviewed version";
        run.recovery = { detectedAt: new Date().toISOString(), reason: run.error };
      }
      this.tasks.writeRun(run.runId, run);
    }
    // Recreate deployment stops the old executor before this process opens state.
    await this.#reconcileStopped();
  }
  async snapshot(): Promise<void> {
    if (!this.#options.snapshotSink) return;
    const snapshot = this.tasks.snapshot();
    const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if (digest === this.#snapshotDigest) return;
    await this.#options.snapshotSink.enqueue("publication-tasks", snapshot);
    this.#snapshotDigest = digest;
  }
  async #reconcileStopped(): Promise<void> {
    for (const task of this.tasks.list()) {
      if (!["running", "activating"].includes(task.phase)) continue;
      if (this.#child && this.#active?.id === task.id) continue;
      const candidate = task.result as ObjectReleasePointer | null;
      let committed = false;
      if (task.phase === "activating" && candidate) {
        // If authority is unavailable, leave the task activating and retry this
        // read later. Never assume a timed-out pointer write did not commit.
        const pointer = await this.#options.store.get(process.env.ASSETS_OBJECT_STORE_CURRENT_KEY ?? "public/current.json");
        committed = Boolean(pointer && JSON.parse(pointer.body.toString("utf8")).bundle.sha256 === candidate.bundle.sha256);
      }
      this.tasks.recoverStopped(task.id, committed);
    }
  }
  async retry(previous: PublicationRun): Promise<PublicationRun | undefined> {
    const old = this.tasks.get<FrozenPublication>(previous.runId);
    // Legacy records have no frozen payload. The publisher's compatibility
    // path rechecks their original revisions and current reviews before submit.
    if (!old) return undefined;
    const latest = await this.#options.freeze();
    for (const original of old.payload.products) {
      const current = latest.products.find(p => p.productId === original.productId);
      if (!current || current.revision !== original.revision || JSON.stringify(current.review) !== JSON.stringify(original.review)) {
        throw new PublicationConflictError("Selected revision or review changed; review and submit a new publication");
      }
    }
    const run: PublicationRun = { ...previous, runId: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      status: "queued", createdAt: new Date().toISOString(), startedAt: undefined, finishedAt: undefined,
      claimedAt: undefined, lastProgressAt: undefined, recovery: undefined, error: undefined,
      verification: undefined, bundle: undefined, manifestKey: undefined, queue: undefined, log: [] };
    const task = this.tasks.submit(run.runId, old.selectionKey, old.payload, run);
    return (await this.get(task.id))!;
  }

  async submit(run: PublicationRun): Promise<PublicationRun> {
    const frozen = await this.#options.freeze();
    const selected = [...(run.selectedProducts ?? [])].sort((a, b) => a.productId.localeCompare(b.productId));
    if (!selected.length || selected.some(value => !frozen.products.some(product => product.productId === value.productId && product.revision === value.revision))) throw new Error("Selected revision changed before queue submission");
    // Only selected products are needed by the builder; baseline carries the rest.
    frozen.products = frozen.products.filter(product => selected.some(value => value.productId === product.productId));
    const key = createHash("sha256").update(JSON.stringify(selected)).digest("hex");
    const task = this.tasks.submit(run.runId, key, frozen, run);
    return (await this.get(task.id))!;
  }
  async get(id: string): Promise<PublicationRun | undefined> {
    let run = this.tasks.readRun<PublicationRun>(id);
    if (!run) return undefined;
    const task = this.tasks.get(id);
    if (!task) return run;
    const activatedAt = run.verification?.authority.checkedAt ?? run.finishedAt;
    run = { ...run, queue: { phase: task.phase, attempts: task.attempts,
      ...(task.phase === "queued" && task.attempts > 0 ? { nextAttemptAt: new Date(task.readyAt).toISOString() } : {}),
      cancellable: ["queued", "running"].includes(task.phase),
      syncDelayed: task.phase === "site-pending" && Date.now() - Date.parse(activatedAt ?? run.createdAt) >= 120_000 } };
    if (task.phase === "queued") return { ...run, status: "queued", error: task.error ?? undefined };
    if (task.phase === "failed" || task.phase === "cancelled") return { ...run, status: task.phase, error: task.error ?? (task.phase === "cancelled" ? "Publication cancelled" : run.error) };
    if (task.phase === "site-pending") {
      const candidate = task.result as ObjectReleasePointer;
      return { ...run, status: "verifying", bundle: candidate.bundle, manifestKey: candidate.manifestKey,
        verification: { ...(run.verification ?? { candidate: { state: "passed" }, site: { state: "pending" } }), overall: "site-pending", authority: { state: "passed", bundleSha256: candidate.bundle.sha256 } } };
    }
    if (task.phase === "published") return { ...run, status: "published" };
    return run;
  }
  async list(): Promise<PublicationRun[]> {
    const runs = await Promise.all(this.tasks.readRuns<PublicationRun>().map(run => this.get(run.runId).then(value => value!)));
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId));
  }
  async write(run: PublicationRun): Promise<void> {
    const task = this.tasks.get(run.runId);
    if (task?.phase === "site-pending" && run.verification?.site.state === "passed") this.tasks.verified(run.runId);
    this.tasks.writeRun(run.runId, run);
  }
  /** A site may skip intermediate bundles while offline. Verify a later bundle
   * only when its approved snapshot still contains the exact frozen selection. */
  async siteExpectation(id: string): Promise<{ bundle: { id: string; sha256: string }; expected: PublicationVerificationExpectation } | undefined> {
    const task = this.tasks.get<FrozenPublication>(id);
    if (!task || task.phase !== "site-pending") return undefined;
    const root = await realpath(this.#options.baselineRoot);
    const manifest = JSON.parse(await readFile(path.join(root, "artifacts/public-survey-footprints/release-manifest.json"), "utf8"));
    const candidate = task.result as ObjectReleasePointer;
    if (candidate.bundle.sha256 === manifest.bundle.sha256) return undefined;
    const approved = await readApprovedRelease(root);
    for (const frozen of task.payload.products) {
      const published = approved.products.find(product => product.productId === frozen.productId);
      if (frozen.retiredAt) { if (published) return undefined; }
      else if (!published || published.revision !== frozen.revision || published.contentSha256 !== frozen.contentSha256
        || JSON.stringify(published.geometry) !== JSON.stringify(frozen.review?.geometry ?? null)) return undefined;
    }
    return { bundle: manifest.bundle, expected: {
      products: approved.products.map(product => ({ productId: product.productId, surveyId: product.content.surveyId, present: true })),
      layers: approved.products.flatMap(product => product.geometry ? [{ layerId: product.geometry.layerId, surveyId: product.content.surveyId, present: true }] : []),
      packages: approved.packages.map(pkg => ({ id: String(pkg.id), version: String(pkg.version), surveyId: String(pkg.surveyId), present: true })),
    } };
  }
  async tick(): Promise<void> {
    if (this.#busy || this.#stopping) return;
    this.#busy = true;
    try {
      if (this.#child) {
        if (((this.#active && this.tasks.get(this.#active.id)?.leaseUntil) ?? Infinity) <= Date.now()) await this.#stopChild();
        return;
      }
      await this.#reconcileStopped();
      await this.#options.synchronize();
      const task = this.tasks.claim<FrozenPublication>();
      if (!task) return;
      this.#active = task;
      const baselineRoot = await realpath(this.#options.baselineRoot);
      const manifest = JSON.parse(await readFile(path.join(baselineRoot, "artifacts/public-survey-footprints/release-manifest.json"), "utf8"));
      const run = { ...(await this.get(task.id))!, status: "queued" as const, baselineBundle: manifest.bundle };
      const child = fork(new URL(import.meta.url.endsWith(".ts") ? "./publication-executor.ts" : "./publication-executor.js", import.meta.url), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      this.#child = child;
      let tail = Promise.resolve();
      child.on("message", (message: any) => {
        tail = tail.then(async () => {
          try {
            if (this.#child !== child || this.#active?.attemptId !== task.attemptId || this.#cancelling.has(task.id)) throw new Error("Obsolete executor message");
            let result: unknown;
            if (message.operation === "progress") {
              const next = message.value as PublicationRun;
              if (next.runId !== task.id) throw new Error("Executor run identity mismatch");
              const current = this.tasks.get(task.id)!;
              if (current.phase === "published" || (current.phase === "site-pending" && next.status !== "published")) {
                // A queued heartbeat must not replace an activated/verified result.
              } else {
                if (current.phase !== "site-pending") this.tasks.heartbeat(task.id, task.attemptId!);
                this.tasks.writeRun(task.id, next);
              }
            } else if (message.operation === "activate") {
              this.tasks.assertAttempt(task.id, task.attemptId!);
              const live = await this.#options.freeze();
              for (const selected of run.selectedProducts ?? []) {
                const original = task.payload.products.find(p => p.productId === selected.productId);
                const latest = live.products.find(p => p.productId === selected.productId);
                if (!latest || latest.revision !== selected.revision || JSON.stringify(latest.review) !== JSON.stringify(original?.review)) throw new Error("Selected review changed during publication");
              }
              const candidate = message.value.candidate as ObjectReleasePointer;
              this.tasks.beginActivation(task.id, task.attemptId!, candidate);
              result = await activateObjectRelease(this.#options.store, candidate, message.value.baseline);
              this.tasks.activated(task.id, task.attemptId!, result);
            } else if (message.operation === "finished") {
              const final = message.value as PublicationRun;
              if (this.tasks.get(task.id)?.phase === "activating") {
                // Force exit reconciliation before deciding whether to retry CAS.
                throw new Error("Activation outcome requires authority reconciliation");
              }
              if (this.tasks.get(task.id)?.phase !== "site-pending") {
                // Only positively identified transport failures get automatic retries.
                this.tasks.fail(task.id, task.attemptId!, final.error ?? "Publication failed", /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|HTTP 50[234]|ServiceUnavailable|SlowDown/i.test(final.error ?? ""));
              }
            } else throw new Error("Unknown executor operation");
            if (child.connected) child.send({ id: message.id, value: result });
          } catch (error) { if (child.connected) child.send({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
        });
      });
      this.#childDone = new Promise<void>(resolve => {
        child.once("exit", () => { void tail.finally(async () => {
          if (this.#child !== child) return;
          if (this.#cancelling.has(task.id)) this.tasks.cancelStopped(task.id);
          this.#child = undefined;
          this.#active = undefined;
          await this.#reconcileStopped();
        }).catch(error => console.error("Publication recovery deferred", error)).finally(resolve); });
      });
      child.send({ operation: "start", value: { run, frozen: task.payload, contentRoot: this.#options.contentRoot, baselineRoot } satisfies ExecutorRequest });
    } finally { this.#busy = false; }
  }
  async #stopChild(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    child.kill("SIGKILL");
    await this.#childDone;
  }
  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || !["queued", "running"].includes(task.phase)) throw new PublicationConflictError("Cannot cancel activation or an already activated publication");
    if (this.#active?.id === id) {
      this.#cancelling.add(id);
      try { await this.#stopChild(); } finally { this.#cancelling.delete(id); }
    } else this.tasks.cancelStopped(id);
  }
  async stop(): Promise<void> { this.#stopping = true; await this.#stopChild(); }
}
