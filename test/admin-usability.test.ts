import assert from "node:assert/strict";
import test from "node:test";
import { discoveryProgress, gapGuidance } from "../site/admin/readiness-copy.js";

test("a pending discovery without a Job says it is waiting for an executor", () => {
  const text = discoveryProgress({ status: { phase: "PENDING" } });
  assert.match(text, /等待执行器接单/);
  assert.doesNotMatch(text, /正在执行|正在处理/);
  assert.match(discoveryProgress({ status: { phase: "RUNNING", jobName: "roman-job", message: "正在读取 CDS 响应" } }), /正在读取 CDS 响应/);
});

test("discovery evidence guidance separates acquisition, publication and optional indexing", () => {
  assert.match(gapGuidance["input-snapshot-hash-missing"]!.description, /查询条件.*来源响应.*MOC/);
  assert.equal(gapGuidance["output-validation-missing"]!.blocking, true);
  assert.equal(gapGuidance["isolated-restore-not-verified"]!.blocking, undefined);
  assert.equal(gapGuidance["file-level-reverse-index-missing"]!.blocking, undefined);
});
