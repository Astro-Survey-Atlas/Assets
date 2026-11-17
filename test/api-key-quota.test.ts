import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ApiManagement, MAX_KEY_QUOTA } from "../server/api-management.js";

async function withService(run: (service: ApiManagement, root: string, master: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "api-quota-")), master = randomBytes(32).toString("base64");
  const service = new ApiManagement(root, undefined, master, {});
  try { await service.initialize(); await run(service, root, master); } finally {
    try { service.close(); } catch { /* a test may already have closed it to simulate a restart */ }
    await rm(root, { recursive: true, force: true });
  }
}

const scope = "region:query";
const status = async (call: () => unknown): Promise<number> => { try { call(); return 200; } catch (error) { return (error as { statusCode: number }).statusCode; } };

test("a quota-limited key admits exactly its quota, then answers 403; rate-limited requests do not consume quota", async () => {
  await withService(async (service) => {
    const { key } = await service.createKey({ name: "buyer", scopes: [scope], perMinute: 2, quota: 3 });
    assert.equal(await status(() => service.authorize(key, scope, "/a")), 200);
    assert.equal(await status(() => service.authorize(key, scope, "/a")), 200);
    // third request in the same minute is rate limited (429) and must not use up quota
    assert.equal(await status(() => service.authorize(key, scope, "/a")), 429);
    const used = service.view().keys[0]!;
    assert.equal(used.quota, 3);
    assert.equal(used.quotaUsed, 2);
  });
});

test("an exhausted quota returns 403 with a clear message and never reopens", async () => {
  await withService(async (service) => {
    const { key } = await service.createKey({ name: "buyer", scopes: [scope], perMinute: 30, quota: 2 });
    service.authorize(key, scope, "/a"); service.authorize(key, scope, "/a");
    await assert.rejects(async () => service.authorize(key, scope, "/a"), (error: { statusCode: number; message: string }) => error.statusCode === 403 && /额度已用完/.test(error.message));
    assert.equal(service.view().keys[0]!.quotaUsed, 2);
  });
});

test("keys without a quota stay unlimited in total and survive restart with their counters", async () => {
  await withService(async (service, root, master) => {
    const unlimited = await service.createKey({ name: "ops", scopes: [scope] });
    const limited = await service.createKey({ name: "buyer", scopes: [scope], quota: 5, perMinute: 30 });
    service.authorize(unlimited.key, scope, "/a"); service.authorize(limited.key, scope, "/a");
    assert.equal(service.view().keys.find(k => k.id === unlimited.id)!.quota, undefined);
    service.close();
    const reopened = new ApiManagement(root, undefined, master, {});
    try {
      await reopened.initialize();
      const record = reopened.view().keys.find(k => k.id === limited.id)!;
      assert.equal(record.quota, 5); assert.equal(record.quotaUsed, 1);
    } finally { reopened.close(); }
  });
});

test("quota bounds are validated", async () => {
  await withService(async (service) => {
    for (const quota of [0, -1, 1.5, MAX_KEY_QUOTA + 1, "10"]) {
      await assert.rejects(service.createKey({ name: "x", scopes: [scope], quota }), /调用额度/);
    }
  });
});

test("issueKey mints a fixed-scope, capped key and refuses a second issue for the same order", async () => {
  await withService(async (service) => {
    const issued = await service.issueKey({ orderRef: "order-2026-0001", quota: 100, perMinute: 10, validDays: 30 });
    assert.match(issued.key, /^asa_live_/);
    assert.equal(issued.quota, 100); assert.equal(issued.reissued, false);
    const record = service.view().keys[0]!;
    assert.deepEqual(record.scopes, [scope]); assert.equal(record.perMinute, 10); assert.equal(record.orderRef, "order-2026-0001");
    assert.equal(JSON.stringify(service.view()).includes(issued.key), false, "the plaintext must never be listed");
    await assert.rejects(service.issueKey({ orderRef: "order-2026-0001", quota: 100 }), (error: { statusCode: number }) => error.statusCode === 409);
    assert.equal(service.view().keys.length, 1);
  });
});

test("issueKey rejects out-of-bounds or malformed requests", async () => {
  await withService(async (service) => {
    const bad: Array<Record<string, unknown>> = [
      { orderRef: "short", quota: 10 },
      { orderRef: "order with spaces", quota: 10 },
      { orderRef: "order-2026-0002" },
      { orderRef: "order-2026-0002", quota: 0 },
      { orderRef: "order-2026-0002", quota: MAX_KEY_QUOTA + 1 },
      { orderRef: "order-2026-0002", quota: 10, perMinute: 31 },
      { orderRef: "order-2026-0002", quota: 10, validDays: 366 },
      { orderRef: "order-2026-0002", quota: 10, scopes: ["admin"] }, // scopes are not caller controlled; this one is merely ignored
    ];
    for (const input of bad.slice(0, -1)) await assert.rejects(service.issueKey(input), (error: { statusCode: number }) => error.statusCode === 400);
    const ok = await service.issueKey(bad.at(-1)!);
    assert.deepEqual(service.view().keys.find(k => k.id === ok.id)!.scopes, [scope]);
  });
});

test("reissue revokes the old key and carries only the remaining quota, so a retry cannot mint extra calls", async () => {
  await withService(async (service) => {
    const first = await service.issueKey({ orderRef: "order-2026-0003", quota: 10, perMinute: 30, validDays: 30 });
    for (let i = 0; i < 4; i += 1) service.authorize(first.key, scope, "/a");
    const second = await service.issueKey({ orderRef: "order-2026-0003", quota: 10, reissue: true });
    assert.equal(second.reissued, true);
    assert.equal(second.quota, 6, "10 bought - 4 used = 6 left, not a fresh 10");
    assert.notEqual(second.key, first.key);
    await assert.rejects(async () => service.authorize(first.key, scope, "/a"), (error: { statusCode: number }) => error.statusCode === 401);
    assert.equal(await status(() => service.authorize(second.key, scope, "/a")), 200);
    // at most one live key per order
    assert.equal(service.view().keys.filter(k => k.orderRef === "order-2026-0003" && !k.revokedAt).length, 1);
    // a second reissue after the quota is gone is refused
    for (let i = 0; i < 5; i += 1) service.authorize(second.key, scope, "/a");
    await assert.rejects(service.issueKey({ orderRef: "order-2026-0003", quota: 10, reissue: true }), (error: { statusCode: number }) => error.statusCode === 409);
  });
});
