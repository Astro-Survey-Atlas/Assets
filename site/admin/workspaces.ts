import type { AdminStep } from "./navigation.js";

export const resources = {
  overview: "/api/v1/admin/overview", connectors: "/api/v1/admin/connectors",
  tasks: "/api/v1/admin/tasks", products: "/api/v1/admin/products",
  reviewSurveys: "/api/v1/admin/products?view=surveys",
  catalogStatus: "/api/v1/admin/catalog/status",
  mocDiscovery: "/api/v1/admin/moc-discovery", mocBuilds: "/api/v1/admin/moc-builds",
};
export type Resource = keyof typeof resources;
export const workspaceResources: Record<AdminStep, Resource[]> = {
  overview: ["overview", "products", "reviewSurveys"],
  sources: ["connectors"],
  tasks: ["tasks", "mocDiscovery", "mocBuilds", "products", "reviewSurveys", "connectors"],
  review: ["products", "reviewSurveys", "mocBuilds", "catalogStatus"],
  releases: [],
};

/** Observation timestamps do not constitute a business change. */
export function businessSignature(value: unknown): string {
  return JSON.stringify(value, (key, item) => ["generatedAt", "loadedAt"].includes(key) ? undefined : item);
}

/** One request generation per route; obsolete results cannot overwrite its successor. */
export class WorkspaceRequests {
  #controller = new AbortController();
  #generation = 0;
  cancel(): void { this.#controller.abort(); this.#controller = new AbortController(); this.#generation++; }
  async load(keys: Resource[], fetcher: (url: string, signal: AbortSignal) => Promise<unknown>) {
    const generation = this.#generation;
    const signal = this.#controller.signal;
    const results = await Promise.allSettled(keys.map(async (key) => ({ key, value: await fetcher(resources[key], signal) })));
    return generation === this.#generation ? results : null;
  }
}
