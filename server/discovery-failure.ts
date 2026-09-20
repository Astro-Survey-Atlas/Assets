/** Bounded Warehouse diagnostic projection; raw evidence stays outside browser payloads. */
export interface DiscoveryFailure {
  component?: string;
  code?: string;
  stage?: string;
  endpoint?: string;
  targetHost?: string;
  startedAt?: string;
  completedAt?: string;
  exceptionType?: string;
  message?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  bytes?: number;
  httpStatus?: number;
  causeChain?: string[];
}

export function discoveryFailureView(value: unknown): DiscoveryFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const safe = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "<URL>")
    .replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=<REDACTED>").slice(0, 512);
  for (const key of ["component", "code", "stage", "targetHost", "startedAt", "completedAt", "exceptionType", "message"]) {
    if (typeof source[key] === "string") result[key] = safe(source[key]);
  }
  if (typeof source.endpoint === "string") {
    try { const url = new URL(source.endpoint); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) result.endpoint = `${url.origin}${url.pathname}`.slice(0, 512); } catch { /* Invalid endpoint is not displayed. */ }
  }
  for (const key of ["elapsedMs", "timeoutMs", "bytes", "httpStatus"]) {
    if (typeof source[key] === "number" && Number.isSafeInteger(source[key]) && source[key] >= 0) result[key] = source[key];
  }
  if (Array.isArray(source.causeChain)) result.causeChain = source.causeChain.filter((item): item is string => typeof item === "string").slice(0, 8).map(safe);
  return Object.keys(result).length ? result as DiscoveryFailure : undefined;
}
