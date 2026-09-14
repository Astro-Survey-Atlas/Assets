export type AdminStep = "overview" | "sources" | "tasks" | "review" | "releases";
export interface AdminRoute { step: AdminStep; surveyId?: string; productId?: string }
export function parseAdminRoute(pathname: string, hash = ""): AdminRoute | null {
  if (/^\/admin\/?$/.test(pathname)) {
    const step = hash.slice(1);
    return { step: ["overview", "sources", "tasks", "review", "releases"].includes(step) ? step as AdminStep : "overview" };
  }
  const match = /^\/admin\/(overview|sources|tasks|review|releases)(?:\/(surveys|products)\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  const step = match[1] as AdminStep;
  if (!match[2]) return { step };
  try {
    if (step === "overview" && match[2] === "surveys") return { step, surveyId: decodeURIComponent(match[3]!) };
    if (step === "review" && match[2] === "products") return { step, productId: decodeURIComponent(match[3]!) };
  } catch { return null; }
  return null;
}
export function routePath(route: AdminRoute): string {
  return `/admin/${route.step}${route.surveyId ? `/surveys/${encodeURIComponent(route.surveyId)}` : route.productId ? `/products/${encodeURIComponent(route.productId)}` : ""}`;
}
