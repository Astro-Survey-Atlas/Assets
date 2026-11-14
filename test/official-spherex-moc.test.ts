import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fitsMoc } from "./reviewed-fixture.js";
import { sha256 } from "../server/native-moc.js";
import { ProductStore } from "../server/products.js";
import { MocBuildService, MocBuildStore, type MocCoreRunner } from "../server/moc-build.js";
import { stageSpherexDr1Moc, SPHEREX_DR1_CUBE } from "../server/official-spherex-moc.js";

test("official import locks both metadata inputs, stages a bound Cube product, and detects tampering", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "spherex-import-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, "sources"), evidenceRoot = path.join(base, "evidence"), content = path.join(base, "content");
  for (const directory of ["src/layers/recipes", "src/surveys"]) await mkdir(path.join(sourceRoot, directory), { recursive: true });
  for (const file of ["src/surveys/survey-catalog.json", "src/layers/layer-registry.json"]) await copyFile(file, path.join(sourceRoot, file));
  const source = fitsMoc(Array.from({ length: 12 }, (_, pixel) => ({ order: 0, pixel })));
  const properties = Buffer.from("creator_did = ivo://IPAC/P/SPHEREx/DR1/cube\n");
  const recipePath = `src/layers/recipes/${SPHEREX_DR1_CUBE}.lock.json`;
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  recipe.snapshot.sha256 = sha256(source); recipe.snapshot.sizeBytes = source.length;
  recipe.recipe.sourceRecordSha256 = sha256(properties);
  await writeFile(path.join(sourceRoot, recipePath), JSON.stringify(recipe));
  const products = new ProductStore(undefined, content); await products.initialize(sourceRoot);
  const builds = new MocBuildStore(content, undefined, evidenceRoot);
  const runner: MocCoreRunner = {
    validate: async () => ({ valid: true }),
    build: async (input, output, orders) => {
      assert.deepEqual(orders, { maxOrder: 0, queryOrder: 0, previewOrder: 0 });
      await copyFile(input, path.join(output, "moc.fits"));
      for (const name of ["query-order0.json", "preview-order0.json", "statistics.json"]) await writeFile(path.join(output, name), "{}\n");
      return { valid: true };
    },
  };
  const buildService = new MocBuildService({ store: builds, evidenceRoot, runner });
  const urls: string[] = [];
  const options = { sourceRoot, evidenceRoot, products, builds, buildService,
    fetchBytes: async (url: string) => { urls.push(url); return url.endsWith("properties") ? properties : source; } };
  await assert.rejects(() => stageSpherexDr1Moc(options, { sourceId: SPHEREX_DR1_CUBE, url: "https://example.org/other" }), /registered/);
  assert.equal(urls.length, 0);
  await assert.rejects(() => stageSpherexDr1Moc({ ...options, fetchBytes: async () => Buffer.from("changed") }, { sourceId: SPHEREX_DR1_CUBE }), /locked snapshot/);
  const { request, product } = await stageSpherexDr1Moc(options, { sourceId: SPHEREX_DR1_CUBE });
  assert.equal(request.phase, "STAGED"); assert.equal(request.provider, "evidence");
  assert.equal(request.productId, product.productId); assert.equal(request.outputs?.maxOrder, 0);
  assert.equal(product.draft.releaseId, "spherex-dr1"); assert.equal(product.draft.layerId, SPHEREX_DR1_CUBE);
  assert.equal(product.draft.sourceTier, "official_geometry"); assert.equal(product.review, undefined);
  assert.equal(request.source.evidenceInputs?.length, 2);
  assert.deepEqual(urls.sort(), ["Moc.fits", "properties"].map(name => `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/${name}`));
  await writeFile(path.join(evidenceRoot, request.source.evidenceInputs![0]!.ref), "tampered");
  await assert.rejects(() => buildService.verifyOutputs(request.name), /锁定内容不一致/);
});
