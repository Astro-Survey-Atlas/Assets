import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactStore } from "./artifact-store.js";
import { AdminHttpError } from "./admin-error.js";
import type { PublicationTask, PublicationTaskStore } from "./publication-task-store.js";
import type { StateSnapshotSink } from "./state-snapshot.js";
import { nativeSourceRecipes } from "./native-unit-sources.js";
import { nativeFile, restoreNativeFile } from "./native-unit-archive.js";
import { assertNativeSurvey, bindingRevision, groupReviewDigest, nativeDigest, nativeEvidencePath, nativeGroupId, nativeMetadataUrl, nativeNow, type NativeBinding, type NativeFile, type NativeGroup, type NativeOperation, type NativeSnapshot, type NativeSource, type NativeState, type NativeTaskDocument, type NativeTaskKind, type NativeWorkerRequest, type NativeWorkerResult } from "./native-unit-model.js";

export interface NativeControllerOptions {
  contentRoot: string; catalogRoot: string; evidenceRoot: string;
  store: ArtifactStore; snapshotSink?: StateSnapshotSink;
  bindings: () => Promise<NativeBinding[]>;
  changed: () => Promise<void>;
  verifyRuntime: (group: NativeGroup) => Promise<void>;
  verifySite?: (group: NativeGroup) => Promise<void>;
}
interface NativePointer { schemaVersion: 1; groupId: string; generation: number; manifestKey: string; sha256: string; at: string; taskId: string }
const pointerKey = "native-units/current.json";
const emptyState = (): NativeState => ({ schemaVersion: 1, sources: [], snapshots: [], groups: [], active: null, generation: 0, history: [], tasks: {} });

/** One backend owns source edits, frozen tasks, review and the independent index CAS. */
export class NativeUnitController {
  readonly #options: NativeControllerOptions;
  #state = emptyState();
  #queue?: PublicationTaskStore;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(options: NativeControllerOptions) { this.#options = options; }
  attachQueue(queue: PublicationTaskStore): void { this.#queue = queue; }
  get active(): NativeGroup | undefined { return this.#state.groups.find(group => group.id === this.#state.active); }
  get generation(): number { return this.#state.generation; }
  get version(): string { return this.#state.active ?? "imported-baseline"; }
  async initialize(): Promise<void> {
    const file = path.join(this.#options.contentRoot, "native-units/state.json");
    let state: NativeState | undefined;
    try { state = JSON.parse(await readFile(file, "utf8")) as NativeState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!state) state = (await this.#options.snapshotSink?.restore?.("native-units"))?.state as NativeState | undefined;
    if (state) {
      if (state.schemaVersion !== 1 || !Array.isArray(state.sources) || !Array.isArray(state.groups)) throw new Error("Invalid native-unit management state");
      for (const source of state.sources) assertNativeSurvey(source.surveyId);
      for (const group of state.groups) for (const binding of group.bindings) assertNativeSurvey(binding.surveyId);
      this.#state = state;
    }
    for (const source of await nativeSourceRecipes(this.#options.catalogRoot)) if (!this.#state.sources.some(item => item.id === source.id)) this.#state.sources.push(source);
    const pointer = await this.#options.store.get(pointerKey);
    if (pointer) await this.#adoptPointer(JSON.parse(pointer.body.toString("utf8")) as NativePointer);
    await this.#save();
  }
  matches(payload: unknown): payload is NativeWorkerRequest { return (payload as NativeWorkerRequest | undefined)?.operation?.kind === "native-unit"; }
  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work); this.#tail = next.catch(() => undefined); return next;
  }
  async #save(): Promise<void> {
    const file = path.join(this.#options.contentRoot, "native-units/state.json");
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#state) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
    await this.#options.snapshotSink?.enqueue("native-units", this.#state);
  }
  #audit(action: string, id: string, actor: string): void { this.#state.history.push({ at: nativeNow(), actor, action, id }); }
  #group(id: string): NativeGroup { const group = this.#state.groups.find(group => group.id === id); if (!group) throw new AdminHttpError(404, "Native index version not found"); return group; }
  taskDocuments(): NativeTaskDocument[] {
    return (this.#queue?.list() ?? []).filter(task => this.matches(task.payload)).map(task => {
      const request = task.payload as NativeWorkerRequest; const operation = request.operation;
      return { id: task.id, operation: operation.operation, sourceId: operation.sourceId, groupId: operation.groupId, actor: operation.actor, submittedAt: operation.submittedAt, phase: task.phase === "published" ? "completed" : task.phase, attempts: task.attempts, ...this.#state.tasks[task.id], ...(task.error ? { error: task.error } : {}) };
    }).reverse();
  }
  view(): unknown {
    return { schemaVersion: 1, active: this.#state.active, generation: this.generation, baseline: this.active ? "managed" : "imported-overview", sources: this.#state.sources.map(source => {
      const snapshots = this.#state.snapshots.filter(snapshot => snapshot.sourceId === source.id);
      return { ...source, files: source.files.map(({ ref: _ref, ...file }) => file), snapshots: snapshots.map(snapshot => ({ id: snapshot.id, sourceRevision: snapshot.sourceRevision, capturedAt: snapshot.capturedAt, rowCount: snapshot.rowCount, fileCount: snapshot.files.length, sizeBytes: snapshot.files.reduce((sum, file) => sum + file.sizeBytes, 0), active: this.active?.snapshots[source.id]?.id === snapshot.id })) };
    }), groups: this.#state.groups.map(group => ({ id: group.id, createdAt: group.createdAt, origin: group.origin, active: group.id === this.#state.active, inputCount: Object.keys(group.snapshots).length, productCount: group.bindings.length, bindings: group.bindings, sizeBytes: (group.generic?.file.sizeBytes ?? 0) + (group.hst?.file.sizeBytes ?? 0), archived: this.#files(group).every(file => Boolean(file.objectKey)), report: { ...group.report, samples: undefined }, review: group.review, digest: groupReviewDigest(group) })), tasks: this.taskDocuments(), history: this.#state.history.slice(-128).reverse() };
  }
  detail(id: string): unknown {
    const group = this.#group(id);
    return { id: group.id, digest: groupReviewDigest(group), bindings: group.bindings, report: group.report, review: group.review, generic: group.generic, hst: group.hst, inputs: Object.values(group.snapshots).map(snapshot => ({ id: snapshot.id, sourceId: snapshot.sourceId, sourceRevision: snapshot.sourceRevision, scope: snapshot.scope, sourceUrl: snapshot.sourceUrl, capturedAt: snapshot.capturedAt, rowCount: snapshot.rowCount, files: snapshot.files })) };
  }
  async availableBindings(): Promise<NativeBinding[]> { return this.#options.bindings(); }
  async updateSource(id: string, body: Record<string, unknown>, actor: string): Promise<NativeSource> {
    return this.#serialized(async () => {
      const source = this.#state.sources.find(source => source.id === id);
      if (!source) throw new AdminHttpError(404, "Registered source adapter not found");
      if (body.revision !== source.revision) throw new AdminHttpError(409, "Source revision changed");
      const next = { ...source };
      for (const key of ["title", "scope", "sourceUrl", "query"] as const) if (body[key] !== undefined) {
        if (typeof body[key] !== "string" || !String(body[key]).trim() || String(body[key]).length > 16_384) throw new AdminHttpError(400, `Invalid source ${key}`);
        next[key] = String(body[key]);
      }
      nativeMetadataUrl(next.sourceUrl, next.adapter);
      if (next.adapter === "entrypoint" && next.sourceUrl !== "https://euclid.esac.esa.int/dr/ero/") throw new AdminHttpError(400, "ERO target metadata uses the registered official XML endpoint");
      if (next.files.length === 1 && next.sourceUrl !== source.sourceUrl) next.files = next.files.map(file => ({ ...file, sourceUrl: next.sourceUrl }));
      if (body.fileUrls !== undefined) {
        if (!Array.isArray(body.fileUrls) || body.fileUrls.length !== next.files.length || body.fileUrls.some(url => typeof url !== "string")) throw new AdminHttpError(400, "Provide one official metadata URL per recipe input");
        next.files = next.files.map((file, index) => ({ ...file, sourceUrl: nativeMetadataUrl((body.fileUrls as string[])[index]!, next.adapter).href }));
      }
      next.revision++; next.updatedAt = nativeNow();
      this.#state.sources = this.#state.sources.map(item => item.id === id ? next : item);
      this.#audit("source-edited", id, actor); await this.#save(); return next;
    });
  }
  async submit(body: Record<string, unknown>, actor: string): Promise<NativeTaskDocument> {
    return this.#serialized(async () => {
      if (!this.#queue) throw new AdminHttpError(503, "Managed publication queue is unavailable");
      const operation = body.operation as NativeTaskKind;
      if (!["baseline", "discover", "acquire", "import", "build", "verify", "archive", "activate", "restore"].includes(operation)) throw new AdminHttpError(400, "Unknown native-unit operation");
      const source = this.#state.sources.find(source => source.id === body.sourceId);
      if (["discover", "acquire", "import"].includes(operation) && (!source || body.sourceRevision !== source.revision)) throw new AdminHttpError(409, "Select the current registered source revision");
      const selectedGroup = typeof body.groupId === "string" ? this.#group(body.groupId) : undefined;
      if (["verify", "archive", "activate", "restore"].includes(operation) && !selectedGroup) throw new AdminHttpError(400, "Select an index version");
      if (["activate", "build", "baseline"].includes(operation) && body.expectedActive !== this.#state.active) throw new AdminHttpError(409, "Active index changed; refresh the plan");
      if (operation === "activate") this.#assertReview(selectedGroup!, body.reviewDigest);
      if (operation === "baseline" && this.active) throw new AdminHttpError(409, "Existing baseline is already managed");
      const ids = body.snapshotIds;
      if (operation === "build" && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !this.#state.snapshots.some(snapshot => snapshot.id === id)))) throw new AdminHttpError(400, "Select validated input snapshots");
      const snapshots = operation === "build" ? this.#state.snapshots.filter(snapshot => (ids as string[]).includes(snapshot.id)) : [];
      if (new Set(snapshots.map(snapshot => snapshot.sourceId)).size !== snapshots.length) throw new AdminHttpError(400, "Select one snapshot per source");
      for (const snapshot of snapshots) if (this.#state.sources.find(source => source.id === snapshot.sourceId)?.revision !== snapshot.sourceRevision) throw new AdminHttpError(409, "Snapshot belongs to a superseded source revision");
      let importFiles: NativeFile[] | undefined;
      if (operation === "import") {
        if (!Array.isArray(body.files) || !body.files.length || body.files.length > 64) throw new AdminHttpError(400, "Import requires staged metadata file references");
        importFiles = body.files as NativeFile[];
        for (const file of importFiles) {
          nativeEvidencePath(this.#options.evidenceRoot, file.ref);
          if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1) throw new AdminHttpError(400, "Import requires SHA-256 and byte count");
        }
      }
      const id = `native-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const op: NativeOperation = { kind: "native-unit", operation, actor, submittedAt: nativeNow(), ...(source ? { sourceId: source.id, sourceRevision: source.revision } : {}), ...(selectedGroup ? { groupId: selectedGroup.id } : {}), expectedActive: this.#state.active, ...(importFiles ? { importFiles } : {}), ...(snapshots.length ? { snapshotIds: snapshots.map(snapshot => snapshot.id) } : {}), ...(operation === "activate" ? { reviewDigest: groupReviewDigest(selectedGroup!) } : {}) };
      const bindings = operation === "baseline" ? await this.#options.bindings() : selectedGroup?.bindings ?? this.active?.bindings ?? await this.#options.bindings();
      for (const binding of bindings) assertNativeSurvey(binding.surveyId);
      const request: NativeWorkerRequest = { operation: op, catalogRoot: this.#options.catalogRoot, evidenceRoot: this.#options.evidenceRoot, taskId: id, source, sources: structuredClone(this.#state.sources), snapshots: structuredClone(snapshots), active: structuredClone(selectedGroup ?? this.active), bindings: structuredClone(bindings) };
      const task = this.#queue.submit(id, nativeDigest({ kind: "native-unit", operation, source: source && [source.id, source.revision], group: selectedGroup?.id, snapshots: snapshots.map(snapshot => snapshot.id).sort(), active: this.#state.active, importFiles }), request);
      this.#audit(`task:${operation}`, task.id, actor); await this.#save(); return this.taskDocuments().find(document => document.id === task.id)!;
    });
  }
  #assertReview(group: NativeGroup, digest: unknown): void {
    if (!group.report.checks.length || group.report.checks.some(check => !check.passed) || group.review?.digest !== groupReviewDigest(group) || digest !== group.review.digest) throw new AdminHttpError(409, "Review this verified index version before activation");
    if (!this.#files(group).every(file => file.objectKey)) throw new AdminHttpError(409, "Archive every input and index before activation");
  }
  async review(id: string, body: Record<string, unknown>, actor: string): Promise<unknown> {
    return this.#serialized(async () => {
      const group = this.#group(id); const digest = groupReviewDigest(group);
      if (body.digest !== digest) throw new AdminHttpError(409, "Index verification or product bindings changed");
      if (!group.report.checks.length || group.report.checks.some(check => !check.passed)) throw new AdminHttpError(422, "Index has not passed verification");
      if (!Array.isArray(body.acceptedGaps) || group.report.gaps.some(gap => !(body.acceptedGaps as unknown[]).includes(gap)) || body.acceptedGaps.some(gap => !group.report.gaps.includes(String(gap)))) throw new AdminHttpError(422, "Explicitly accept every reported gap");
      group.review = { at: nativeNow(), actor, digest, acceptedGaps: body.acceptedGaps as string[] };
      this.#audit("reviewed", id, actor); await this.#save(); return this.detail(id);
    });
  }
  async changeBindings(id: string, body: Record<string, unknown>, actor: string): Promise<unknown> {
    return this.#serialized(async () => {
      const original = this.#group(id);
      if (body.digest !== groupReviewDigest(original)) throw new AdminHttpError(409, "Index version changed");
      if (!Array.isArray(body.productIds) || !body.productIds.length) throw new AdminHttpError(400, "Select registered product identities");
      const known = await this.#options.bindings();
      const bindings = (body.productIds as string[]).map(id => known.find(binding => binding.productId === id));
      if (bindings.some(binding => !binding)) throw new AdminHttpError(422, "Unknown or unsupported public product binding");
      const group = { ...structuredClone(original), bindings: bindings.map(binding => ({ ...binding!, revision: bindingRevision(binding!, original.snapshots) })), createdAt: nativeNow(), origin: "managed-build" as const, review: undefined, report: { ...original.report, checks: [], samples: [] } };
      group.id = nativeGroupId(group);
      if (!this.#state.groups.some(item => item.id === group.id)) this.#state.groups.push(group);
      this.#audit("bindings-edited", group.id, actor); await this.#save(); return this.detail(group.id);
    });
  }
  async progress(task: PublicationTask<NativeWorkerRequest>, message: string): Promise<void> {
    return this.#serialized(async () => { this.#state.tasks[task.id] = { ...this.#state.tasks[task.id], progress: message.slice(0, 1024) }; await this.#save(); });
  }
  normalizeRequest(request: NativeWorkerRequest): NativeWorkerRequest {
    const result = structuredClone(request);
    result.snapshots = result.snapshots.map(snapshot => {
      const same = this.#state.snapshots.find(item => item.sourceId === snapshot.sourceId && item.sourceRevision === snapshot.sourceRevision && nativeDigest(item.files.map(file => file.sha256)) === nativeDigest(snapshot.files.map(file => file.sha256)));
      return same ?? snapshot;
    });
    return result;
  }
  async complete(task: PublicationTask<NativeWorkerRequest>, result: NativeWorkerResult, queue: PublicationTaskStore): Promise<void> {
    return this.#serialized(async () => {
      queue.assertAttempt(task.id, task.attemptId!);
      const operation = task.payload.operation;
      if (result.discovered) this.#state.tasks[task.id] = { ...this.#state.tasks[task.id], result: { discovered: result.discovered } };
      if (result.snapshot) {
        const snapshot = result.snapshot;
        const same = this.#state.snapshots.find(item => item.sourceId === snapshot.sourceId && item.sourceRevision === snapshot.sourceRevision && nativeDigest(item.files.map(file => file.sha256)) === nativeDigest(snapshot.files.map(file => file.sha256)));
        if (!same) this.#state.snapshots.push(snapshot);
        this.#state.tasks[task.id] = { ...this.#state.tasks[task.id], result: { snapshotId: same?.id ?? snapshot.id, noChange: Boolean(same) } };
      }
      if (result.group) {
        const group = result.group; const existing = this.#state.groups.find(item => item.id === group.id);
        if (existing && operation.operation === "archive") {
          // Archiving changes storage locations, never the reviewed scientific content.
          const review = existing.review; Object.assign(existing, group); existing.review = review;
        } else if (existing && operation.operation === "restore") {
          Object.assign(existing, group); existing.review = undefined;
        } else if (!existing) this.#state.groups.push(group);
        for (const snapshot of Object.values(group.snapshots)) {
          const index = this.#state.snapshots.findIndex(item => item.id === snapshot.id);
          if (index < 0) this.#state.snapshots.push(snapshot);
          else if (operation.operation === "archive") this.#state.snapshots[index] = snapshot;
        }
        this.#state.tasks[task.id] = { ...this.#state.tasks[task.id], result: { groupId: group.id, noChange: Boolean(existing) } };
      }
      if (result.report) { const group = this.#group(operation.groupId!); group.report = result.report; group.review = undefined; }
      this.#audit(`completed:${operation.operation}`, task.id, operation.actor);
      await this.#save(); queue.complete(task.id, task.attemptId!, this.#state.tasks[task.id]?.result ?? result);
    });
  }
  #files(group: NativeGroup): NativeFile[] { return [...Object.values(group.snapshots).flatMap(snapshot => snapshot.files), ...(group.generic ? [group.generic.file] : []), ...(group.hst ? [group.hst.file] : [])]; }
  async activate(task: PublicationTask<NativeWorkerRequest>, queue: PublicationTaskStore): Promise<void> {
    return this.#serialized(async () => {
      const operation = task.payload.operation; const group = this.#group(operation.groupId!);
      queue.assertAttempt(task.id, task.attemptId!);
      if (operation.expectedActive !== this.#state.active) throw new AdminHttpError(409, "Active index changed during queued activation");
      this.#assertReview(group, operation.reviewDigest);
      await this.#options.verifyRuntime(group);
      const bytes = JSON.stringify(group) + "\n"; const sha256 = nativeDigest(bytes);
      const manifestKey = `native-units/versions/${group.id}/${sha256}.json`;
      await this.#options.store.putImmutable(manifestKey, bytes, { contentType: "application/json", cacheControl: "no-store" });
      const existing = await this.#options.store.get(pointerKey);
      const baseline = existing ? JSON.parse(existing.body.toString("utf8")) as NativePointer : undefined;
      if ((baseline?.groupId ?? null) !== operation.expectedActive) throw new AdminHttpError(409, "Native index authority changed");
      const pointer: NativePointer = { schemaVersion: 1, groupId: group.id, generation: (baseline?.generation ?? 0) + 1, manifestKey, sha256, at: nativeNow(), taskId: task.id };
      queue.beginActivation(task.id, task.attemptId!, pointer);
      await this.#options.store.putMutable(pointerKey, JSON.stringify(pointer) + "\n", { contentType: "application/json", cacheControl: "no-store", ...(existing ? { ifMatch: existing.etag ?? existing.sha256 } : { ifNoneMatch: "*" }) });
      const confirmed = await this.#options.store.get(pointerKey);
      if (!confirmed || JSON.parse(confirmed.body.toString("utf8")).taskId !== task.id) throw new Error("Native activation requires authority reconciliation");
      this.#state.active = group.id; this.#state.generation = pointer.generation; this.#audit("activated", group.id, operation.actor);
      this.#state.tasks[task.id] = { result: { groupId: group.id }, progress: "Authority activated; checking query runtime" };
      await this.#save(); queue.activated(task.id, task.attemptId!, pointer);
      await this.#options.changed();
    });
  }
  async #adoptPointer(pointer: NativePointer): Promise<void> {
    if (pointer.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(pointer.groupId) || !Number.isSafeInteger(pointer.generation) || pointer.generation < 1 || !/^[a-f0-9]{64}$/.test(pointer.sha256)) throw new Error("Invalid native-unit authority pointer");
    if (pointer.manifestKey !== `native-units/versions/${pointer.groupId}/${pointer.sha256}.json`) throw new Error("Invalid native authority manifest key");
    const object = await this.#options.store.get(pointer.manifestKey);
    if (!object || nativeDigest(object.body.toString("utf8")) !== pointer.sha256) throw new Error("Native authority manifest checksum mismatch");
    const group = JSON.parse(object.body.toString("utf8")) as NativeGroup;
    if (group.id !== pointer.groupId || group.id !== nativeGroupId(group)) throw new Error("Native authority identity mismatch");
    for (const binding of group.bindings) assertNativeSurvey(binding.surveyId);
    for (const file of this.#files(group)) {
      await restoreNativeFile(this.#options.store, this.#options.evidenceRoot, file);
    }
    this.#state.groups = [...this.#state.groups.filter(item => item.id !== group.id), group];
    for (const snapshot of Object.values(group.snapshots)) if (!this.#state.snapshots.some(item => item.id === snapshot.id)) this.#state.snapshots.push(snapshot);
    this.#state.active = pointer.groupId; this.#state.generation = pointer.generation;
  }
  async reconcile(task: PublicationTask): Promise<boolean> {
    if (task.phase !== "activating") return false;
    const object = await this.#options.store.get(pointerKey);
    if (!object) return false;
    const pointer = JSON.parse(object.body.toString("utf8")) as NativePointer;
    if (pointer.taskId !== task.id) return false;
    await this.#serialized(async () => { await this.#adoptPointer(pointer); await this.#save(); await this.#options.changed(); });
    return true;
  }
  async verifyPending(task: PublicationTask): Promise<void> {
    if (!this.matches(task.payload) || task.phase !== "site-pending") return;
    const pointer = task.result as NativePointer;
    if (this.#state.active !== pointer.groupId) return;
    const group = this.#group(pointer.groupId);
    await this.#options.verifyRuntime(group);
    if (!this.#options.verifySite) { await this.progress(task as PublicationTask<NativeWorkerRequest>, "Authority active; configure the site verification URL to finish validation"); return; }
    await this.#options.verifySite(group);
    if (this.#state.active !== pointer.groupId) return;
    this.#queue?.verified(task.id);
    await this.progress(task as PublicationTask<NativeWorkerRequest>, "Active index and native lookup verified through the site HTTP endpoint");
  }
}
