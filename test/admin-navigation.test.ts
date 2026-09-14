import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminRoute, routePath } from "../site/admin/navigation.js";
import { WorkspaceRequests, businessSignature } from "../site/admin/workspaces.js";

test("admin routes support workspaces, deep links and legacy hashes", () => {
  for (const step of ["overview", "sources", "tasks", "review", "releases"] as const) {
    assert.deepEqual(parseAdminRoute(routePath({ step })), { step });
    assert.deepEqual(parseAdminRoute("/admin/", `#${step}`), { step });
  }
  assert.deepEqual(parseAdminRoute("/admin/review/products/euclid-ero"), { step: "review", productId: "euclid-ero" });
  assert.equal(parseAdminRoute("/admin/tasks/products/no"), null);
  assert.equal(parseAdminRoute("/admin/unknown"), null);
});
test("observation timestamps do not trigger business rerenders", () => {
  assert.equal(businessSignature({ generatedAt: "a", count: 4 }), businessSignature({ generatedAt: "b", count: 4 }));
  assert.notEqual(businessSignature({ phase: "PENDING" }), businessSignature({ phase: "RUNNING" }));
});
test("route cancellation rejects obsolete data even if transport ignores abort", async () => {
  const requests = new WorkspaceRequests();
  let resolve!: (value: unknown) => void;
  const old = requests.load(["overview"], () => new Promise(done => { resolve = done; }));
  requests.cancel();
  const current = await requests.load(["tasks"], async () => ({ tasks: [] }));
  resolve({ count: 99 });
  assert.equal(await old, null);
  assert.deepEqual(current, [{ status: "fulfilled", value: { key: "tasks", value: { tasks: [] } } }]);
});
