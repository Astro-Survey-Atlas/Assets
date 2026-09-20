import type { ArtifactStore } from "./artifact-store.js";
import { syncReleaseFromObjectStore } from "./sync-release.js";

/** One serialized synchronizer per role/PVC for both startup and polling. */
export class ReleaseSynchronizer {
  #pending: Promise<void> | undefined;
  #pointer: string | undefined;
  constructor(readonly store: ArtifactStore, readonly root: string, readonly currentKey = "public/current.json") {}
  sync(): Promise<void> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#sync().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
  async #sync(): Promise<void> {
    let pointer: string | undefined;
    try { pointer = (await this.store.get(this.currentKey))?.body.toString("utf8"); }
    catch { /* sync validates installed fallback on startup */ }
    if (pointer && pointer === this.#pointer) return;
    await syncReleaseFromObjectStore(this.store, this.root, {
      currentKey: this.currentKey, allowInstalledFallback: true, cleanup: false,
    });
    // Only cache a pointer after the synchronizer has actually loaded it.
    // A concurrent authority update is harmless: the next poll checks again.
    this.#pointer = pointer;
  }
}
