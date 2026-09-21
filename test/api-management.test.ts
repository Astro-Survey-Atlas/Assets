import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ApiManagement } from "../server/api-management.js";
import { discoveryResultMarkup, onlyLeads } from "../site/admin/moc-result.js";
import { providerFetch } from "../server/provider-fetch.js";

test("encrypted provider settings persist, reject stale edits and never expose credentials", async () => {
 const root = await mkdtemp(path.join(tmpdir(),"api-settings-")), master = randomBytes(32).toString("base64");
 let service = new ApiManagement(root, undefined, master, {key:"secret-fixture",baseUrl:"https://example.org",model:"fixture"});
 try {
  await service.initialize(); assert.equal(service.settings().key,"secret-fixture");
  assert.equal(JSON.stringify(service.view()).includes("secret-fixture"),false);
  await assert.rejects(service.updateProvider({revision:0,baseUrl:"https://example.org",model:"fixture",enabled:true}),/版本/);
  await assert.rejects(service.updateProvider({revision:1,baseUrl:"https://changed.example.org",model:"fixture",enabled:true}),/新凭证/);
  await service.updateProvider({revision:1,baseUrl:"https://example.org",model:"next",enabled:false});
  assert.deepEqual(service.settings(),{}); service.close();
  service = new ApiManagement(root,undefined,master,{}); await service.initialize();
  await service.updateProvider({revision:2,baseUrl:"https://example.org",model:"next",enabled:true});
  assert.equal(service.settings().key,"secret-fixture");
  await service.updateProvider({revision:3,baseUrl:"https://example.org",model:"next",enabled:false,clearKey:true});
  assert.equal(service.view().provider.keyConfigured,false);
  service.close(); assert.equal((await readFile(path.join(root,"api-management.sqlite"))).includes(Buffer.from("secret-fixture")),false);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test("managed keys persist only hashes; scopes, expiry, revocation, quotas and usage survive restart", async t => {
 const root = await mkdtemp(path.join(tmpdir(),"api-keys-")); let service = new ApiManagement(root,undefined,undefined,{});
 try {
  await service.initialize();
  await assert.rejects(service.createKey({name:"bad",scopes:["admin:publish"]}));
  await assert.rejects(service.createKey({name:"bad",scopes:["region:query"],expiresAt:"2000-01-01"}));
  const key = await service.createKey({name:"workspace",scopes:["region:query"],perMinute:1});
  assert.equal(JSON.stringify(service.view()).includes(key.key),false);
  assert.throws(()=>service.authorize(key.key,"admin:publish","test"),/权限/);
  assert.equal(service.authorize(key.key,"region:query","test"),key.id); service.recordKey(key.id,"test",200,10);
  service.recordLlm({requestId:"r",model:"m",success:true,durationMs:20,usage:{prompt_tokens:12,completion_tokens:3}});
  service.close(); service = new ApiManagement(root,undefined,undefined,{}); await service.initialize();
  assert.throws(()=>service.authorize(key.key,"region:query","test"),/限额/);
  assert.equal(service.view().keys[0]!.requests,3); assert.equal(service.view().llmUsage.inputTokens,12);
  await service.revokeKey(key.id); assert.throws(()=>service.authorize(key.key,"region:query","test"),/撤销/);
  const expiring=await service.createKey({name:"short",scopes:["region:query"],expiresAt:new Date(Date.now()+60000).toISOString()});
  const future=Date.now()+120000;const clock=t.mock.method(Date,"now",()=>future);
  assert.throws(()=>service.authorizeId(expiring.id,"region:query","test"),/过期/);clock.mock.restore();
  service.close(); assert.equal((await readFile(path.join(root,"api-management.sqlite"))).includes(Buffer.from(key.key)),false);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test("lead result provides clear next steps and escapes citations/links", () => {
 const c = {candidateId:"a",provider:"llm",buildable:false,title:"<script>x</script>",citation:"<img onerror=x>",recordUrl:"javascript:alert(1)"};
 const html = discoveryResultMarkup(c); assert.equal(onlyLeads([c]),true); assert.equal(onlyLeads([]),false);
 assert.match(html,/仅找到线索/); assert.match(html,/还缺什么/); assert.match(html,/下一步/); assert.match(html,/<details/);
 assert.doesNotMatch(html,/<script|<img|href="javascript/);
});
test("credentialed provider requests refuse local destinations", async () => {
 await assert.rejects(providerFetch("https://127.0.0.1/v1/models"),/public addresses/);
 await assert.rejects(providerFetch("http://example.org/v1/models"),/Invalid provider/);
});
