import assert from "node:assert/strict";
import test from "node:test";
import { fitsMoc } from "./reviewed-fixture.js";
import { sha256Hex } from "../server/hash.js";
import {
  FAILURE_ALERT_THRESHOLD, checkSource, detectDrift, runMonitor,
  type FetchBytes, type MonitoredSource, type MonitorState,
} from "../server/moc-source-monitor.js";

const mocA = new Uint8Array(fitsMoc([{ order: 3, pixel: 1 }, { order: 3, pixel: 2 }]));
const mocB = new Uint8Array(fitsMoc([{ order: 3, pixel: 1 }, { order: 3, pixel: 9 }]));
const record = new TextEncoder().encode("creator_did = ivo://x/y");
const NOW = "2026-11-16T00:00:00Z";

function source(overrides: Partial<MonitoredSource> = {}): MonitoredSource {
  return {
    id: "s1", recordUrl: "https://example.test/record", mocUrl: "https://example.test/moc", maxOrder: 3,
    status: "acquired", sourceSnapshotSha256: sha256Hex(mocA), sourceRecordSha256: sha256Hex(record), ...overrides,
  };
}
const serve = (moc: Uint8Array, rec: Uint8Array = record): FetchBytes => async url => (url.endsWith("/moc") ? moc : rec);
const broken: FetchBytes = async () => { throw new Error("HTTP 413"); };

test("an unchanged source matches the registry baseline", async () => {
  const health = await checkSource(source(), undefined, serve(mocA), NOW);
  assert.equal(health.state, "unchanged");
  assert.equal(health.lastGood?.mocSha256, sha256Hex(mocA));
  assert.equal(health.consecutiveFailures, 0);
});

test("changed MOC bytes are reported as drift and keep the reviewed baseline", async () => {
  const good = await checkSource(source(), undefined, serve(mocA), NOW);
  const drifted = await checkSource(source(), good, serve(mocB), "2026-11-17T00:00:00Z");
  assert.equal(drifted.state, "drifted");
  assert.deepEqual(drifted.drift, ["moc-bytes"]);
  assert.equal(drifted.lastGood?.mocSha256, sha256Hex(mocA), "baseline stays until a human accepts the change");
  assert.equal(drifted.candidate?.mocSha256, sha256Hex(mocB));
});

test("a changed record is drift even when the MOC bytes are identical", async () => {
  const health = await checkSource(source(), undefined, serve(mocA, new TextEncoder().encode("other")), NOW);
  assert.deepEqual(health.drift, ["record-bytes"]);
});

test("a changed native order is drift", () => {
  const observed = { recordSha256: sha256Hex(record), mocSha256: sha256Hex(mocA), sizeBytes: 1, maxOrder: 5, observedAt: NOW };
  assert.deepEqual(detectDrift(source(), observed), ["max-order"]);
});

test("a fetch failure is not drift and keeps the last good observation", async () => {
  const good = await checkSource(source(), undefined, serve(mocA), NOW);
  const failed = await checkSource(source(), good, broken, "2026-11-17T00:00:00Z");
  assert.equal(failed.state, "failed");
  assert.equal(failed.drift, undefined);
  assert.equal(failed.lastGood?.mocSha256, sha256Hex(mocA));
  assert.equal(failed.lastSuccessAt, NOW);
  assert.equal(failed.consecutiveFailures, 1);
  assert.match(failed.lastError ?? "", /413/);
});

test("garbage bytes that are not a MOC count as a failure, not as a MOC", async () => {
  const health = await checkSource(source(), undefined, serve(new TextEncoder().encode("<html>413</html>")), NOW);
  assert.equal(health.state, "failed");
});

test("recovery resets the failure counter", async () => {
  const failed = await checkSource(source(), undefined, broken, NOW);
  const recovered = await checkSource(source(), failed, serve(mocA), "2026-11-17T00:00:00Z");
  assert.equal(recovered.state, "unchanged");
  assert.equal(recovered.consecutiveFailures, 0);
});

test("rejected sources are skipped without any fetch", async () => {
  let calls = 0;
  const health = await checkSource(source({ status: "rejected" }), undefined, async () => { calls += 1; return mocA; }, NOW);
  assert.equal(health.state, "skipped");
  assert.equal(calls, 0);
});

test("the run summary alerts only after repeated consecutive failures", async () => {
  const sources = [source({ id: "ok" }), source({ id: "flaky" }), source({ id: "dead" })];
  const fetcher: FetchBytes = async url => {
    if (url.includes("flaky") || url.includes("dead")) throw new Error("HTTP 502");
    return url.endsWith("/moc") ? mocA : record;
  };
  const withUrls = sources.map(item => ({ ...item, recordUrl: `https://example.test/${item.id}/record`, mocUrl: `https://example.test/${item.id}/moc` }));
  let state: MonitorState = {};
  let summary;
  for (let run = 0; run < FAILURE_ALERT_THRESHOLD; run += 1) {
    ({ state, summary } = await runMonitor(withUrls, state, fetcher, NOW));
    assert.equal(summary.alerting.length, run + 1 >= FAILURE_ALERT_THRESHOLD ? 2 : 0);
  }
  assert.deepEqual(summary!.failed.sort(), ["dead", "flaky"]);
  assert.equal(summary!.unchanged, 1);
});
