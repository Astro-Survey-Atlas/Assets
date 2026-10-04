import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { acquireHstPublicImageSnapshot } from "../scripts/acquire-hst-public-image-observations.js";

test("HST managed acquisition identifies its metadata client, locks every public page and rejects changing totals", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hst-acquisition-"));
  const oldFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = oldFetch; await rm(root, { recursive: true, force: true }); });
  const seen: number[] = [];
  let changing = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://mast.stsci.edu/api/v0/invoke");
    assert.equal(init?.method, "POST");
    const request = JSON.parse(new URLSearchParams(String(init?.body)).get("request")!);
    assert.equal(request.service, "Mast.Caom.Filtered");
    assert.deepEqual(request.params.filters.map((filter: { paramName: string; values: string[] }) => [filter.paramName, filter.values]),
      [["obs_collection", ["HST"]], ["dataproduct_type", ["image"]], ["dataRights", ["PUBLIC"]]]);
    assert.match(String(new Headers(init?.headers).get("user-agent")), /^Mozilla\/5\.0 .*Astro-Survey-Atlas-Assets/);
    seen.push(request.page);
    const rows = changing && request.page === 2 ? 4 : 3;
    return new Response(JSON.stringify({ status: "COMPLETE",
      paging: { page: request.page, pageSize: 2, pagesFiltered: 2, rows: request.page === 1 ? 2 : 1, rowsFiltered: rows, rowsTotal: rows },
      data: request.page === 1 ? [{ obsid: 1 }, { obsid: 2 }] : [{ obsid: 3 }] }));
  };
  await acquireHstPublicImageSnapshot(root, { pageSize: 2, concurrency: 2 });
  const manifest = JSON.parse(await readFile(path.join(root, "source-units/hst-public-image-pages/manifest.json"), "utf8"));
  assert.deepEqual(seen.sort(), [1, 2]); assert.equal(manifest.rowCount, 3); assert.equal(manifest.pageCount, 2);
  for (const page of manifest.pages) {
    const bytes = await readFile(path.join(root, page.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), page.sha256);
    assert.equal(bytes.length, page.sizeBytes);
    assert.equal(JSON.parse(gunzipSync(bytes).toString()).data.length, page.rows);
  }
  changing = true;
  await assert.rejects(acquireHstPublicImageSnapshot(path.join(root, "changed"), { pageSize: 2, concurrency: 2 }), /pagination totals changed/);
  await assert.rejects(readFile(path.join(root, "changed/source-units/hst-public-image-pages/manifest.json")), /ENOENT/);
});
