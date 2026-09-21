import assert from "node:assert/strict";
import test from "node:test";
import { adminInventoryIndex } from "../server/admin-survey-index.js";
import type { PublicSurveyIndex } from "../server/surveys.js";
import type { ProductRecord } from "../server/products.js";

function product(id: string, survey: string, release: string): ProductRecord {
  return { productId: id, revision: 1, contentSha256: "fixture", updatedAt: "2026-09-20", published: null, publishedAt: null, publishedRevision: null,
    draft: { productId: id, surveyId: survey, releaseId: release, name: id, modality: "imaging",
      presentation: { summaryMarkdown: "", methodologyMarkdown: "", limitationsMarkdown: "", flow: { nodes: [], edges: [] } } } };
}
test("editorial inventory groups unpublished JWST and retired AKARI without changing public membership or identities", () => {
  const publicIndex: PublicSurveyIndex = { schemaVersion: 1, generatedAt: "fixture", surveys: [], sharedAssets: [] };
  const retired = { ...product("retired-akari", "akari", "fis"), retiredAt: "2026-09-20" };
  const records = [product("carina", "jwst", "dr1"), product("smacs", "jwst", "dr1"), product("f115w", "jwst", "public"), retired];
  const inventory = adminInventoryIndex(publicIndex, records);
  assert.deepEqual(inventory.surveys.map(s => [s.id, s.releases.map(r => [r.id, r.products.map(p => p.productId)])]),
    [["jwst", [["dr1", ["carina", "smacs"]], ["public", ["f115w"]]]], ["akari", [["fis", ["retired-akari"]]]]]);
  assert.deepEqual(inventory.surveys[0]?.modalities, ["imaging"]);
  assert.equal(publicIndex.surveys.length, 0);
  assert.equal(records[0]?.published, null);
  assert.deepEqual(adminInventoryIndex(inventory, records), inventory, "existing groups do not duplicate products");
  assert.equal(adminInventoryIndex(publicIndex, [product("private", "csst", "private")]).surveys.length, 0);
});
