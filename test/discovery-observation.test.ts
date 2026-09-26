import assert from "node:assert/strict";
import test from "node:test";
import { executorLogFinding, observeDiscovery, type ExecutorObservation } from "../server/discovery-observation.js";
import { discoveryProgress, discoveryObservationLabel } from "../site/admin/readiness-copy.js";
import { createServer } from "node:http";
import { AssetsAdmin, loadAdminConfig } from "../server/admin.js";

const now = Date.parse("2026-09-14T07:00:00Z");
const executor: ExecutorObservation = { health: "unknown", checkedAt: new Date(now).toISOString(), message: "No loop health proof" };
const request = { createdAt: "2026-09-14T06:55:33Z", status: { phase: "PENDING" } };

test("missing job is delayed independently of executor status and never becomes a task failure", () => {
  const observation = observeDiscovery(request, executor, 120, now);
  assert.equal(observation.state, "delayed");
  assert.equal(observation.waitedSeconds, 267);
  assert.equal(discoveryObservationLabel(observation), "等待异常");
  assert.match(discoveryProgress({ ...request, observation }), /原因尚未确认/);
  assert.equal(observeDiscovery(request, executor, 300, now).state, "waiting");
});

test("verified executor failure blocks waiting but never overrides a running or finished request", () => {
  const failure: ExecutorObservation = { ...executor, health: "error", ...executorLogFinding("OutOfMemoryError: Java heap space\nsecret=DO_NOT_EXPOSE")! };
  const observation = observeDiscovery(request, failure, 120, now);
  assert.equal(observation.state, "blocked");
  assert.match(discoveryProgress({ ...request, observation }), /内存不足/);
  assert.doesNotMatch(JSON.stringify(observation), /DO_NOT_EXPOSE/);
  assert.equal(observeDiscovery({ ...request, status: { phase: "RUNNING", jobName: "euclid" } }, failure, 120, now).state, "running");
  assert.equal(observeDiscovery({ ...request, status: { phase: "FAILED" } }, failure, 120, now).state, "finished");
});

test("unavailable diagnosis retains delay and unknown submission time does not invent elapsed time", () => {
  assert.equal(observeDiscovery(request, { ...executor, health: "unavailable" }, 120, now).state, "delayed");
  assert.equal(observeDiscovery({ status: request.status }, executor, 120, now).waitedSeconds, undefined);
  assert.equal(executorLogFinding("some arbitrary error including credentials"), undefined);
  assert.equal(executorLogFinding("moc-discovery list failed: RejectedExecutionException")?.reason, "ExecutorRejected");
});

test("JVM startup options do not look like an OutOfMemoryError", () => {
  const log = "Picked up JAVA_TOOL_OPTIONS: -XX:MaxRAMPercentage=60.0 -XX:InitialRAMPercentage=20.0 -XX:+ExitOnOutOfMemoryError";
  assert.equal(executorLogFinding(log), undefined);
});

test("actual Java OutOfMemoryError signatures remain diagnosed", () => {
  const finding = executorLogFinding('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space');
  assert.equal(finding?.reason, "OutOfMemory");
});

test("admin API independently observes a broken executor, caches probes and keeps terminal CR status intact", async () => {
  let probes = 0;
  const resource = { metadata: { name: "euclid", creationTimestamp: request.createdAt, labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } }, spec: { query: { surveyName: "euclid" } } };
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("/log?")) { probes++; res.end("moc-discovery list failed: RejectedExecutionException\nprivate-token=never-return"); }
    else if (req.url?.includes("/pods?")) res.end(JSON.stringify({ items: [{ metadata: { name: "discovery-1" }, status: { containerStatuses: [{ ready: true }] } }] }));
    else if (req.url?.includes("/mocdiscoveryrequests/euclid")) res.end(JSON.stringify(resource));
    else res.end(JSON.stringify({ items: [resource] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const admin = new AssetsAdmin(loadAdminConfig({ ASSETS_KUBE_API_URL: `http://127.0.0.1:${address.port}`, ASSETS_KUBE_TOKEN: "fixture", ASSETS_KUBE_CA_FILE: "/missing" }));
    const views = await admin.listMocDiscoveryRequests();
    assert.equal(views[0]?.status.phase, "PENDING");
    assert.equal(views[0]?.observation?.state, "blocked");
    assert.equal((await admin.getMocDiscoveryRequest("euclid")).observation?.executor.reason, "ExecutorRejected");
    assert.equal(probes, 1);
    assert.doesNotMatch(JSON.stringify(views), /never-return/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
