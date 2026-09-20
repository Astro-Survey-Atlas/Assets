import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type TaskPhase = "queued" | "running" | "activating" | "site-pending" | "published" | "failed" | "cancelled";
export interface PublicationTask<T = unknown> {
  id: string;
  selectionKey: string;
  phase: TaskPhase;
  payload: T;
  attemptId: string | null;
  attempts: number;
  readyAt: number;
  leaseUntil: number | null;
  result: unknown;
  error: string | null;
}
interface TaskRow {
  id: string; selection_key: string; phase: TaskPhase; payload: string;
  attempt_id: string | null; attempts: number; ready_at: number;
  lease_until: number | null; result: string | null; error: string | null;
}
interface AttemptRow { id: string; task_id: string; started_at: number; finished_at: number | null; outcome: string | null; error: string | null }
export interface PublicationTaskSnapshot {
  schemaVersion: 1;
  tasks: TaskRow[];
  attempts: AttemptRow[];
  runs: Array<{ id: string; document: string }>;
}
const retryDelays = [5_000, 15_000, 45_000];

/** Backend-owned durable queue on a local PVC. Children never open this database.
 * All state transitions use attempt fencing; recovery is called only after the
 * owner has killed and reaped the previous executor (or after a new Pod starts).
 */
export class PublicationTaskStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  constructor(file: string, now: () => number = Date.now) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.#now = now;
    this.#db = new DatabaseSync(file);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, selection_key TEXT NOT NULL, phase TEXT NOT NULL,
        payload TEXT NOT NULL, attempt_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        ready_at INTEGER NOT NULL, lease_until INTEGER, result TEXT, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_selection ON tasks(selection_key)
        WHERE phase IN ('queued','running','activating','site-pending');
      CREATE TABLE IF NOT EXISTS run_records (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, outcome TEXT, error TEXT
      );`);
  }
  snapshot(): PublicationTaskSnapshot {
    return { schemaVersion: 1,
      tasks: this.#db.prepare("SELECT * FROM tasks ORDER BY rowid").all() as unknown as TaskRow[],
      attempts: this.#db.prepare("SELECT * FROM attempts ORDER BY rowid").all() as unknown as AttemptRow[],
      runs: this.#db.prepare("SELECT * FROM run_records ORDER BY rowid").all() as unknown as PublicationTaskSnapshot["runs"] };
  }
  restore(snapshot: PublicationTaskSnapshot): void {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.attempts) || !Array.isArray(snapshot.runs)) throw new Error("Invalid publication task snapshot");
    if (this.#db.prepare("SELECT id FROM run_records LIMIT 1").get()) throw new Error("Refusing to overwrite local publication tasks");
    this.#transaction(() => {
      for (const row of snapshot.tasks) this.#db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)").run(row.id, row.selection_key, row.phase, row.payload, row.attempt_id, row.attempts, row.ready_at, row.lease_until, row.result, row.error);
      for (const row of snapshot.attempts) this.#db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,?)").run(row.id, row.task_id, row.started_at, row.finished_at, row.outcome, row.error);
      for (const row of snapshot.runs) this.#db.prepare("INSERT INTO run_records VALUES(?,?)").run(row.id, row.document);
    });
  }
  close(): void { this.#db.close(); }
  #transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #decode<T>(row: TaskRow): PublicationTask<T> {
    return { id: row.id, selectionKey: row.selection_key, phase: row.phase,
      payload: JSON.parse(row.payload) as T, attemptId: row.attempt_id,
      attempts: row.attempts, readyAt: row.ready_at, leaseUntil: row.lease_until,
      result: row.result ? JSON.parse(row.result) as unknown : null, error: row.error };
  }
  get<T = unknown>(id: string): PublicationTask<T> | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
    return row ? this.#decode<T>(row) : undefined;
  }
  list(): PublicationTask[] {
    return (this.#db.prepare("SELECT * FROM tasks ORDER BY rowid").all() as unknown as TaskRow[]).map(row => this.#decode(row));
  }
  submit<T>(id: string, selectionKey: string, payload: T, run?: unknown): PublicationTask<T> {
    return this.#transaction(() => {
      const duplicate = this.#db.prepare("SELECT * FROM tasks WHERE selection_key = ? AND phase IN ('queued','running','activating','site-pending')").get(selectionKey) as unknown as TaskRow | undefined;
      if (duplicate) return this.#decode<T>(duplicate);
      this.#db.prepare("INSERT INTO tasks(id,selection_key,phase,payload,ready_at) VALUES(?,?,'queued',?,?)").run(id, selectionKey, JSON.stringify(payload), this.#now());
      if (run) this.writeRun(id, run);
      return this.get<T>(id)!;
    });
  }
  writeRun(id: string, run: unknown): void {
    this.#db.prepare("INSERT INTO run_records(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(id, JSON.stringify(run));
  }
  readRun<T>(id: string): T | undefined {
    const row = this.#db.prepare("SELECT document FROM run_records WHERE id=?").get(id) as { document: string } | undefined;
    return row ? JSON.parse(row.document) as T : undefined;
  }
  readRuns<T>(): T[] {
    return (this.#db.prepare("SELECT document FROM run_records ORDER BY rowid DESC").all() as { document: string }[]).map(row => JSON.parse(row.document) as T);
  }
  /** Only one task may reach the authority writer at a time. */
  claim<T>(): PublicationTask<T> | undefined {
    return this.#transaction(() => {
      if (this.#db.prepare("SELECT id FROM tasks WHERE phase IN ('running','activating') LIMIT 1").get()) return undefined;
      const row = this.#db.prepare("SELECT * FROM tasks WHERE phase='queued' AND ready_at<=? ORDER BY rowid LIMIT 1").get(this.#now()) as unknown as TaskRow | undefined;
      if (!row) return undefined;
      const attempt = randomUUID();
      this.#db.prepare("UPDATE tasks SET phase='running',attempt_id=?,attempts=attempts+1,lease_until=?,error=NULL WHERE id=?").run(attempt, this.#now() + 120_000, row.id);
      this.#db.prepare("INSERT INTO attempts(id,task_id,started_at) VALUES(?,?,?)").run(attempt, row.id, this.#now());
      return this.get<T>(row.id)!;
    });
  }
  assertAttempt(id: string, attempt: string): PublicationTask {
    const task = this.get(id);
    if (!task || task.attemptId !== attempt || !["running", "activating"].includes(task.phase) || (task.leaseUntil ?? 0) <= this.#now()) {
      throw new Error("Obsolete or expired publication attempt");
    }
    return task;
  }
  heartbeat(id: string, attempt: string): void {
    this.assertAttempt(id, attempt);
    this.#db.prepare("UPDATE tasks SET lease_until=? WHERE id=? AND attempt_id=?").run(this.#now() + 120_000, id, attempt);
  }
  beginActivation(id: string, attempt: string, candidate: unknown): void {
    this.assertAttempt(id, attempt);
    // Persist the candidate identity before remote CAS, so a crash can reconcile it.
    this.#db.prepare("UPDATE tasks SET phase='activating',result=? WHERE id=? AND attempt_id=?").run(JSON.stringify(candidate), id, attempt);
  }
  activated(id: string, attempt: string, result: unknown): void {
    this.assertAttempt(id, attempt);
    this.#transaction(() => {
      this.#db.prepare("UPDATE tasks SET phase='site-pending',result=?,lease_until=NULL WHERE id=? AND attempt_id=?").run(JSON.stringify(result), id, attempt);
      this.#db.prepare("UPDATE attempts SET finished_at=?,outcome='activated' WHERE id=?").run(this.#now(), attempt);
    });
  }
  verified(id: string): void {
    this.#db.prepare("UPDATE tasks SET phase='published',error=NULL WHERE id=? AND phase='site-pending'").run(id);
  }
  fail(id: string, attempt: string, error: string, transient: boolean): void {
    this.assertAttempt(id, attempt);
    this.#transaction(() => this.#failure(this.get(id)!, error, transient));
  }
  #failure(task: PublicationTask, error: string, transient: boolean): void {
    const delay = transient ? retryDelays[task.attempts - 1] : undefined;
    this.#db.prepare("UPDATE tasks SET phase=?,ready_at=?,lease_until=NULL,attempt_id=NULL,error=? WHERE id=?").run(
      delay === undefined ? "failed" : "queued", this.#now() + (delay ?? 0), error, task.id);
    if (task.attemptId) this.#db.prepare("UPDATE attempts SET finished_at=?,outcome='failed',error=? WHERE id=?").run(this.#now(), error, task.attemptId);
  }
  /** Recovery must follow executor termination; activating tasks need remote CAS reconciliation first. */
  recoverStopped(id: string, authorityActivated: boolean): void {
    this.#transaction(() => {
      const task = this.get(id);
      if (!task || !["running", "activating"].includes(task.phase)) return;
      if (authorityActivated) {
        this.#db.prepare("UPDATE tasks SET phase='site-pending',lease_until=NULL WHERE id=?").run(id);
        if (task.attemptId) this.#db.prepare("UPDATE attempts SET finished_at=?,outcome='activated' WHERE id=?").run(this.#now(), task.attemptId);
      } else this.#failure(task, "Publication executor stopped", true);
    });
  }
  cancelStopped(id: string): void {
    this.#transaction(() => {
      const task = this.get(id);
      if (!task) throw new Error("Unknown publication task");
      if (!["queued", "running"].includes(task.phase)) throw new Error("Cannot cancel activation or an already activated publication");
      this.#db.prepare("UPDATE tasks SET phase='cancelled',lease_until=NULL,attempt_id=NULL WHERE id=?").run(id);
      if (task.attemptId) this.#db.prepare("UPDATE attempts SET finished_at=?,outcome='cancelled' WHERE id=?").run(this.#now(), task.attemptId);
    });
  }
  attempts(id: string): unknown[] {
    return this.#db.prepare("SELECT * FROM attempts WHERE task_id=? ORDER BY started_at,id").all(id);
  }
}
