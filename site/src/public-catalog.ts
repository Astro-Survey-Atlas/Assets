/**
 * Resolve one public catalog request without allowing a failed refresh to
 * replace an already usable in-memory or browser-cached value.
 *
 * This module intentionally has no DOM or storage dependencies so the failure
 * policy can be covered by the Node test suite as well as the browser entry
 * point.
 */

export type PublicCatalogSource = "fresh" | "memory" | "cached" | "unavailable";

export interface PublicCatalogResource<T> {
  value: T | null;
  source: PublicCatalogSource;
  error?: string;
}

export interface PublicCatalogFallback<T> {
  current?: T | null;
  cached?: T | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Public catalog request failed";
}

export function resolvePublicCatalogResource<T>(
  result: PromiseSettledResult<T | null>,
  fallback: PublicCatalogFallback<T> = {},
): PublicCatalogResource<T> {
  if (result.status === "fulfilled" && result.value !== null && result.value !== undefined) {
    return { value: result.value, source: "fresh" };
  }

  const failure = result.status === "rejected"
    ? errorMessage(result.reason)
    : "Public catalog returned no document";
  if (fallback.current !== undefined && fallback.current !== null) {
    return { value: fallback.current, source: "memory", error: failure };
  }
  if (fallback.cached !== undefined && fallback.cached !== null) {
    return { value: fallback.cached, source: "cached", error: failure };
  }
  return { value: null, source: "unavailable", error: failure };
}

export async function loadPublicCatalogResource<T>(
  load: () => Promise<T | null>,
  fallback: PublicCatalogFallback<T> = {},
): Promise<PublicCatalogResource<T>> {
  try {
    const value = await load();
    return resolvePublicCatalogResource({ status: "fulfilled", value }, fallback);
  } catch (error) {
    return resolvePublicCatalogResource({ status: "rejected", reason: error }, fallback);
  }
}
