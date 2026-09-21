import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LlmDiscovery } from "../server/llm-discovery.js";
import { isPublicAddress, publicSourceUrl } from "../server/public-source-fetch.js";
import type { MocDiscoveryView } from "../server/admin.js";
const request = (): MocDiscoveryView => ({ name: "fixture", surveyName: "SDSS", releaseHint: "DR9", productHint: "color imaging", policyRef: "cds-public-moc-v2", status: { phase: "SUCCEEDED", candidateCount: 0, discoveryState: "empty", reviewSummary: { schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [] } } });
test("enhancement only runs after confirmed CDS empty; cited candidates survive restart and leads cannot build", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "llm-discovery-"));
 try {
  let current = request(), calls = 0;
  const options = { root, evidenceRoot: root, getRequest: async () => current, key: "fixture-secret", model: "glm-5.3", baseUrl: "https://example.org",
   sourceFetch: async () => ({ url: "https://example.org/dr9", bytes: Buffer.from('Official SDSS DR9 color imaging coverage. <a href="https://example.org/dr9/moc.fits">MOC</a>'), contentType: "text/html" }),
   modelFetch: (async () => { calls++; return Response.json({ choices: [{ message: { content: JSON.stringify(calls % 2 ? { queries: [], urls: ["https://example.org/dr9"] } : { candidates: [
    { title: "DR9", sourceId: "source-1", quote: "Official SDSS DR9 color imaging coverage.", mocUrl: "https://example.org/dr9/moc.fits", coverageCategory: "observed", identityMatch: true },
    { title: "Lead", sourceId: "source-1", quote: "Official SDSS DR9 color imaging coverage.", coverageCategory: "unknown", identityMatch: false },
    { title: "Invented", sourceId: "source-1", quote: "not found in real source material", mocUrl: "https://example.org/fake.fits" }
   ] }) } }], usage: { total_tokens: 100 } }); }) as typeof fetch };
  const service = new LlmDiscovery(options); await service.initialize();
  await service.tick(); assert.equal(calls, 0, "off by default");
  await service.enable(current);
  for (const state of ["ready", "failed", "incomplete"] as const) {
   const independent = new LlmDiscovery({ ...options, root: path.join(root, state) }); await independent.initialize();
   const blocked = { ...request(), status: { ...request().status, discoveryState: state } }; current = blocked;
   await independent.enable(blocked); await independent.tick(); assert.equal(calls, 0);
  }
  current = request(); current.status.reviewSummary!.truncated = true;
  await service.tick(); assert.equal(calls, 0, "truncated empty is not absence");
  current = request(); await Promise.all([service.tick(), service.tick()]); assert.equal(calls, 2);
  const view = service.view(current); assert.equal(view.llmPhase, "complete"); assert.equal(view.status.candidateCount, 2);
  assert.equal(service.resolve(current.name, view.status.reviewSummary!.candidates[0]!.candidateId)?.provider, "llm");
  assert.throws(() => service.resolve(current.name, view.status.reviewSummary!.candidates[1]!.candidateId), /仅为线索/);
  const restarted = new LlmDiscovery(options); await restarted.initialize(); await restarted.tick(); assert.equal(calls, 2);
  assert.equal(restarted.view(current).status.candidateCount, 2);
  assert.equal((await readFile(path.join(root, "llm-discovery-v1.json"), "utf8")).includes("fixture-secret"), false);
  const saved = JSON.parse(await readFile(path.join(root, "llm-discovery-v1.json"), "utf8")); saved.fixture.phase = "running";
  await writeFile(path.join(root, "llm-discovery-v1.json"), JSON.stringify(saved));
  const interrupted = new LlmDiscovery(options); await interrupted.initialize(); await interrupted.tick(); assert.equal(calls, 2); assert.equal(interrupted.view(current).llmPhase, "interrupted");
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("public source restrictions exclude local, metadata, credentials and unsafe schemes", () => {
 for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
 assert.equal(isPublicAddress("1.1.1.1"), true);
 for (const url of ["file:///etc/passwd", "https://user:secret@example.org", "http://example.org:8080/"]) assert.throws(() => publicSourceUrl(url));
});
for (const mode of ["empty", "malformed", "length", "error"] as const) test(`LLM ${mode} is distinct from CDS absence and does not repeat calls`, async () => {
 const root = await mkdtemp(path.join(tmpdir(), "llm-failure-")); let calls = 0;
 try {
  const r = request();
  const service = new LlmDiscovery({ root, evidenceRoot: root, getRequest: async () => r, key: "private-fixture", model: "glm-5.3", baseUrl: "https://example.org", sourceFetch: async () => ({ url: "https://example.org", bytes: Buffer.from("Official source contains no downloadable coverage artifact."), contentType: "text/html" }), modelFetch: (async () => {
   calls++;
   if (mode === "error") throw new Error("provider failure private-fixture");
   return Response.json({ choices: [{ finish_reason: mode === "length" ? "length" : "stop", message: { content: mode === "malformed" ? "not json" : JSON.stringify(calls === 1 ? { urls: ["https://example.org"] } : { candidates: [] }) } }] });
  }) as typeof fetch });
  await service.initialize(); await service.enable(r); await service.tick();
  const view = service.view(r); assert.equal(view.status.discoveryState, mode === "empty" ? "empty" : "failed");
  assert.equal(view.status.candidateCount, 0); assert.equal(view.status.message?.includes("private-fixture"), false);
  const count = calls; await service.tick(); assert.equal(calls, count);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("runtime provider settings are frozen per discovery and actual calls report usage", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "llm-config-")); const r = request();
 let config = { key: "first-key", model: "first-model", baseUrl: "https://example.org" }, calls = 0;
 const events: Array<{success:boolean;usage?:unknown}> = [];
 try {
  const service = new LlmDiscovery({root,evidenceRoot:root,getRequest:async()=>r,getSettings:()=>config,onUsage:e=>events.push(e),
   sourceFetch:async()=>({url:"https://example.org",bytes:Buffer.from("An official source with no coverage file to download."),contentType:"text/html"}),
   modelFetch:(async(_url,init)=>{calls++; assert.equal(new Headers(init?.headers).get("authorization"),"Bearer first-key"); assert.equal(JSON.parse(String(init?.body)).model,"first-model"); config={key:"second-key",model:"second-model",baseUrl:"https://next.example.org"};return Response.json({choices:[{message:{content:JSON.stringify(calls===1?{urls:["https://example.org"]}:{candidates:[]})}}],usage:{prompt_tokens:10,completion_tokens:20}});}) as typeof fetch});
  await service.initialize(); await service.enable(r); await service.tick(); assert.equal(calls,2);assert.equal(events.length,2);assert.ok(events.every(e=>e.success));
  config={key:"",model:"",baseUrl:""};assert.equal(service.configured,false);await assert.rejects(service.enable({...r,name:"disabled"}),/未配置/);
 } finally {await rm(root,{recursive:true,force:true});}
});
