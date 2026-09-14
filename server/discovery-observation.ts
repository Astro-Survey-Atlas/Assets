export interface ExecutorObservation {
  health: "unknown" | "unavailable" | "error";
  checkedAt: string;
  reason?: string;
  message: string;
  source?: string;
}

export interface DiscoveryObservation {
  state: "waiting" | "delayed" | "blocked" | "running" | "finished";
  checkedAt: string;
  waitedSeconds?: number;
  lastProgressAt?: string;
  executor: ExecutorObservation;
}

/** Diagnose only known signatures; never return arbitrary log lines or credentials. */
export function executorLogFinding(log: string): Pick<ExecutorObservation, "reason" | "message"> | undefined {
  if (/OutOfMemoryError|Java heap space/.test(log)) return { reason: "OutOfMemory", message: "探索服务检测到内存不足，执行能力可能受影响。" };
  if (/moc-discovery list failed: RejectedExecutionException/.test(log)) return { reason: "ExecutorRejected", message: "探索服务无法执行请求读取：执行线程池拒绝任务。" };
  if (/moc-discovery list failed:.*(?:Forbidden|403)/.test(log)) return { reason: "AccessDenied", message: "探索服务读取请求时被拒绝访问。" };
  return undefined;
}

export function observeDiscovery(request: { createdAt?: string; status: { phase?: string; jobName?: string; lastTransitionTime?: string } }, executor: ExecutorObservation, timeoutSeconds = 120, now = Date.now()): DiscoveryObservation {
  const created = Date.parse(request.createdAt ?? "");
  const waitedSeconds = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 1000)) : undefined;
  const terminal = ["SUCCEEDED", "COMPLETED", "FAILED", "ERROR", "INVALID", "CANCELLED"].includes((request.status.phase ?? "").toUpperCase());
  const state = terminal ? "finished" : request.status.jobName ? "running" : executor.health === "error" ? "blocked" : waitedSeconds !== undefined && waitedSeconds >= timeoutSeconds ? "delayed" : "waiting";
  return { state, checkedAt: new Date(now).toISOString(), ...(state !== "finished" && !request.status.jobName && waitedSeconds !== undefined ? { waitedSeconds } : {}), lastProgressAt: request.status.lastTransitionTime, executor };
}
