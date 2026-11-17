import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fitsMoc } from "./reviewed-fixture.js";
import { sha256 } from "../server/native-moc.js";
import { ProductStore } from "../server/products.js";
import { MocBuildService, MocBuildStore, type MocCoreRunner } from "../server/moc-build.js";
import { stageOfficialMoc } from "../server/official-moc.js";
import { OFFICIAL_MOC_SOURCES } from "../server/official-moc-sources.js";

for (const [sourceId, descriptor] of Object.entries(OFFICIAL_MOC_SOURCES)) test(`${sourceId}: locked acquisition, product binding and tamper detection`, async t => {
  const base = await mkdtemp(path.join(tmpdir(), "spherex-import-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "sources"), evidenceRoot = path.join(base, "evidence"), content = path.join(base, "content");
  for (const directory of ["src/layers/recipes", "src/surveys"]) await mkdir(path.join(sourceRoot, directory), { recursive: true });
  for (const file of ["src/surveys/survey-catalog.json", "src/layers/layer-registry.json"]) await copyFile(file, path.join(sourceRoot, file));
  const source = fitsMoc(descriptor.fullSky ? Array.from({ length: 12 }, (_, pixel) => ({ order: 0, pixel })) : [{ order: 13, pixel: 70000000 }]);
  const properties = Buffer.from(descriptor.creatorDid ? `creator_did = ${descriptor.creatorDid}\n` : descriptor.recordMarkers!.join("\n"));
  const recipePath = `src/layers/recipes/${sourceId}.lock.json`;
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  delete recipe.expectedOutputs; // Synthetic fixture outputs are independent of the captured public bytes.
  recipe.snapshot.sha256 = sha256(source); recipe.snapshot.sizeBytes = source.length;
  recipe.recipe.sourceRecordSha256 = sha256(properties);
  await writeFile(path.join(sourceRoot, recipePath), JSON.stringify(recipe));
  const products = new ProductStore(undefined, content); await products.initialize(sourceRoot);
  const builds = new MocBuildStore(content, undefined, evidenceRoot);
  const runner: MocCoreRunner = {
    validate: async () => ({ valid: true }),
    build: async (input, output, orders) => {
      assert.deepEqual(orders, { maxOrder: recipe.maxOrder, queryOrder: recipe.queryOrder, previewOrder: recipe.previewOrder });
      await copyFile(input, path.join(output, "moc.fits"));
      for (const name of [`query-order${recipe.queryOrder}.json`, `preview-order${recipe.previewOrder}.json`, "statistics.json"]) await writeFile(path.join(output, name), "{}\n");
      return { valid: true };
    },
  };
  const buildService = new MocBuildService({ store: builds, evidenceRoot, runner });
  if (descriptor.recordFile) {
    await mkdir(path.dirname(path.join(sourceRoot, descriptor.recordFile)), { recursive: true });
    await writeFile(path.join(sourceRoot, descriptor.recordFile), gzipSync(properties));
  }
  if (descriptor.mocFile) await writeFile(path.join(sourceRoot, descriptor.mocFile), gzipSync(source));
  const urls: string[] = [];
  const options = { sourceRoot, evidenceRoot, products, builds, buildService,
    fetchBytes: async (url: string) => { urls.push(url); return url === descriptor.recordUrl ? properties : source; } };
  await assert.rejects(() => stageOfficialMoc(options, { sourceId: sourceId, url: "https://example.org/other" }), /registered/);
  assert.equal(urls.length, 0);
  // Downloaded inputs are locked by hash; a pinned MOC is covered by the dedicated tamper check below.
  if (!descriptor.mocFile || !descriptor.recordFile) await assert.rejects(() => stageOfficialMoc({ ...options, fetchBytes: async () => Buffer.from("changed") }, { sourceId: sourceId }), /locked snapshot/);
  if (descriptor.mocFile) {
    // The MOC comes from the pinned copy, so tampering with that copy must also be refused by the lock.
    const original = await readFile(path.join(sourceRoot, descriptor.mocFile));
    await writeFile(path.join(sourceRoot, descriptor.mocFile), gzipSync(Buffer.from("changed")));
    await assert.rejects(() => stageOfficialMoc(options, { sourceId: sourceId }), /locked snapshot/);
    await writeFile(path.join(sourceRoot, descriptor.mocFile), original);
  }
  const { request, product } = await stageOfficialMoc(options, { sourceId: sourceId });
  assert.equal(request.phase, "STAGED"); assert.equal(request.provider, "evidence");
  assert.equal(request.productId, product.productId); assert.equal(request.outputs?.maxOrder, recipe.maxOrder);
  assert.equal(product.draft.releaseId, descriptor.releaseId); assert.equal(product.draft.layerId, sourceId);
  assert.equal(product.draft.sourceTier, "official_geometry"); assert.equal(product.review, undefined);
  assert.equal(request.source.evidenceInputs?.length, 2);
  // A pinned record is read from the repository copy and never downloaded.
  assert.deepEqual(urls.sort(), [...(descriptor.mocFile ? [] : [descriptor.mocUrl]), ...(descriptor.recordFile ? [] : [descriptor.recordUrl])].sort());
  const revision = product.revision;
  recipe.expectedOutputs = { moc: { sha256: "0".repeat(64), sizeBytes: source.length } };
  await writeFile(path.join(sourceRoot, recipePath), JSON.stringify(recipe));
  await assert.rejects(() => stageOfficialMoc(options, { sourceId }), /locked output/);
  assert.equal(products.get(product.productId).revision, revision, "a failed locked output must not change the product");
  await writeFile(path.join(evidenceRoot, request.source.evidenceInputs![0]!.ref), "tampered");
  await assert.rejects(() => buildService.verifyOutputs(request.name), /锁定内容不一致/);
});

test("pinned Euclid record: the shipped copy matches every lock that relies on it, and a changed copy is refused", async t => {
  const pinned = Object.entries(OFFICIAL_MOC_SOURCES).filter(([, d]) => d.recordFile);
  assert.ok(pinned.length >= 2, "Wide and Deep share the pinned IRSA record");
  for (const [sourceId, descriptor] of pinned) {
    const shipped = (await import("node:zlib")).gunzipSync(await readFile(descriptor.recordFile!));
    const lock = JSON.parse(await readFile(`src/layers/recipes/${sourceId}.lock.json`, "utf8"));
    assert.equal(sha256(shipped), lock.recipe.sourceRecordSha256, `${sourceId}: shipped record must equal the locked record hash`);
    assert.ok(shipped.toString().includes(descriptor.recordMarkers![0]!), `${sourceId}: record identifies its MOC`);
  }
  // Same options as the main test but with a pinned copy that was altered after locking.
  const [sourceId, descriptor] = pinned[0]!;
  const base = await mkdtemp(path.join(tmpdir(), "pinned-record-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "sources"), evidenceRoot = path.join(base, "evidence"), content = path.join(base, "content");
  for (const directory of ["src/layers/recipes", "src/surveys", path.dirname(descriptor.recordFile!)]) await mkdir(path.join(sourceRoot, directory), { recursive: true });
  for (const file of ["src/surveys/survey-catalog.json", "src/layers/layer-registry.json"]) await copyFile(file, path.join(sourceRoot, file));
  await copyFile(`src/layers/recipes/${sourceId}.lock.json`, path.join(sourceRoot, `src/layers/recipes/${sourceId}.lock.json`));
  await writeFile(path.join(sourceRoot, descriptor.recordFile!), gzipSync(Buffer.from("altered record")));
  if (descriptor.mocFile) await copyFile(descriptor.mocFile, path.join(sourceRoot, descriptor.mocFile));
  const products = new ProductStore(undefined, content); await products.initialize(sourceRoot);
  const builds = new MocBuildStore(content, undefined, evidenceRoot);
  const runner: MocCoreRunner = { validate: async () => ({ valid: true }), build: async () => ({ valid: true }) };
  const buildService = new MocBuildService({ store: builds, evidenceRoot, runner });
  await assert.rejects(() => stageOfficialMoc({ sourceRoot, evidenceRoot, products, builds, buildService, fetchBytes: async () => Buffer.from("anything") }, { sourceId }), /locked snapshot/);
});

test("pinned Wide MOC: the shipped copy equals the lock's snapshot", async () => {
  const wide = OFFICIAL_MOC_SOURCES["euclid-dr1-foundation-wide-tiles-moc"]!;
  assert.ok(wide.mocFile);
  const bytes = (await import("node:zlib")).gunzipSync(await readFile(wide.mocFile));
  const lock = JSON.parse(await readFile("src/layers/recipes/euclid-dr1-foundation-wide-tiles-moc.lock.json", "utf8"));
  assert.equal(bytes.length, lock.snapshot.sizeBytes);
  assert.equal(sha256(bytes), lock.snapshot.sha256);
});
