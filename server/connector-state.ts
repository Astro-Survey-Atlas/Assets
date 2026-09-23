import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { queueStateSnapshot, type StateSnapshotSink } from "./state-snapshot.js";

export interface ConnectorProbeState {
  phase: "READY" | "PENDING" | "ERROR";
  message?: string;
  checkedAt: string;
  configFingerprint?: string;
}

export type ConnectorInventoryPhase = "UNKNOWN" | "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED";
export interface ConnectorInventoryState {
  phase: ConnectorInventoryPhase;
  processedObjects?: number;
  totalObjectCount?: number;
  totalBytes?: number;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  scopeFingerprint?: string;
  message?: string;
  /** Opaque provider continuation token; never returned to the browser. */
  continuationToken?: string;
}

interface PersistedConnectorProbeState {
  schemaVersion: 1;
  probes: Record<string, ConnectorProbeState>;
}

/** Durable, credential-free state for the latest on-demand connector probes. */
export class ConnectorProbeStateStore {
  readonly #root: string;
  readonly #snapshotSink?: StateSnapshotSink;
  #state: PersistedConnectorProbeState | undefined;
  #loadPromise: Promise<PersistedConnectorProbeState> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(root: string, snapshotSink?: StateSnapshotSink) {
    this.#root = path.resolve(root);
    this.#snapshotSink = snapshotSink;
  }

  async get(name: string): Promise<ConnectorProbeState | undefined> {
    const state = await this.load();
    const value = state.probes[name];
    return value ? { ...value } : undefined;
  }

  async set(name: string, value: ConnectorProbeState): Promise<void> {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    this.#writeQueue = this.#writeQueue.then(async () => {
      const state = await this.load();
      state.probes[normalizedName] = { ...value };
      await this.persist(state);
    });
    await this.#writeQueue;
  }

  async remove(name: string): Promise<void> {
    this.#writeQueue = this.#writeQueue.then(async () => {
      const state = await this.load();
      delete state.probes[name];
      await this.persist(state);
    });
    await this.#writeQueue;
  }

  private async load(): Promise<PersistedConnectorProbeState> {
    if (this.#state) return this.#state;
    if (!this.#loadPromise) {
      this.#loadPromise = readFile(path.join(this.#root, "connector-probes-v1.json"), "utf8")
        .then((text) => this.parse(text))
        .catch(async (error: unknown) => {
          if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
          // A fresh pod may lose its content PVC while the authority snapshot
          // is intact. Restore the credential-free probe state before exposing
          // connectors to the browser.
          let restored: { state: unknown } | null | undefined;
          try { restored = await this.#snapshotSink?.restore?.("connector-probes"); } catch { restored = null; }
          if (restored?.state && typeof restored.state === "object") {
            const state = restored.state as Partial<PersistedConnectorProbeState>;
            if (state.schemaVersion === 1 && state.probes && typeof state.probes === "object" && !Array.isArray(state.probes)) return { schemaVersion: 1 as const, probes: { ...state.probes } };
          }
          return { schemaVersion: 1 as const, probes: {} };
        });
    }
    this.#state = await this.#loadPromise;
    return this.#state;
  }

  private parse(text: string): PersistedConnectorProbeState {
    const parsed = JSON.parse(text) as Partial<PersistedConnectorProbeState>;
    if (parsed.schemaVersion !== 1 || !parsed.probes || typeof parsed.probes !== "object" || Array.isArray(parsed.probes)) throw new Error("invalid connector probe state");
    return { schemaVersion: 1 as const, probes: { ...parsed.probes } };
  }

  private async persist(state: PersistedConnectorProbeState): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const destination = path.join(this.#root, "connector-probes-v1.json");
    const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    await queueStateSnapshot(this.#snapshotSink, "connector-probes", state);
  }
}

interface PersistedConnectorInventoryState {
  schemaVersion: 1;
  inventories: Record<string, ConnectorInventoryState>;
}

/** Durable, credential-free connector inventory progress. */
export class ConnectorInventoryStateStore {
  readonly #root: string;
  readonly #snapshotSink?: StateSnapshotSink;
  #state: PersistedConnectorInventoryState | undefined;
  #loadPromise: Promise<PersistedConnectorInventoryState> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(root: string, snapshotSink?: StateSnapshotSink) {
    this.#root = path.resolve(root);
    this.#snapshotSink = snapshotSink;
  }

  async get(name: string): Promise<ConnectorInventoryState | undefined> {
    const state = await this.load();
    const value = state.inventories[name];
    return value ? { ...value } : undefined;
  }

  async set(name: string, value: ConnectorInventoryState): Promise<void> {
    const normalizedName = name.trim();
    if (!normalizedName) return;
    this.#writeQueue = this.#writeQueue.then(async () => {
      const state = await this.load();
      state.inventories[normalizedName] = { ...value };
      await this.persist(state);
    });
    await this.#writeQueue;
  }

  async remove(name: string): Promise<void> {
    this.#writeQueue = this.#writeQueue.then(async () => {
      const state = await this.load();
      delete state.inventories[name];
      await this.persist(state);
    });
    await this.#writeQueue;
  }

  private async load(): Promise<PersistedConnectorInventoryState> {
    if (this.#state) return this.#state;
    if (!this.#loadPromise) {
      this.#loadPromise = readFile(path.join(this.#root, "connector-inventory-v1.json"), "utf8")
        .then((text) => this.parse(text))
        .catch(async (error: unknown) => {
          if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
          let restored: { state: unknown } | null | undefined;
          try { restored = await this.#snapshotSink?.restore?.("connector-inventory"); } catch { restored = null; }
          if (restored?.state && typeof restored.state === "object") {
            const state = restored.state as Partial<PersistedConnectorInventoryState>;
            if (state.schemaVersion === 1 && state.inventories && typeof state.inventories === "object" && !Array.isArray(state.inventories)) return { schemaVersion: 1 as const, inventories: { ...state.inventories } };
          }
          return { schemaVersion: 1 as const, inventories: {} };
        });
    }
    this.#state = await this.#loadPromise;
    return this.#state;
  }

  private parse(text: string): PersistedConnectorInventoryState {
    const parsed = JSON.parse(text) as Partial<PersistedConnectorInventoryState>;
    if (parsed.schemaVersion !== 1 || !parsed.inventories || typeof parsed.inventories !== "object" || Array.isArray(parsed.inventories)) throw new Error("invalid connector inventory state");
    return { schemaVersion: 1 as const, inventories: { ...parsed.inventories } };
  }

  private async persist(state: PersistedConnectorInventoryState): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const destination = path.join(this.#root, "connector-inventory-v1.json");
    const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    await queueStateSnapshot(this.#snapshotSink, "connector-inventory", state);
  }
}
