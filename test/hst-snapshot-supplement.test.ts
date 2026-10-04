import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { HstObservationIndex } from "../server/hst-observation-index.js";
import { hstSnapshotRows, loadHstSnapshot } from "../server/hst-snapshot.js";
import { archiveNativeUnits } from "../server/archive-native-units.js";
import type { CoverageCellLayer } from "../server/coverage.js";
import type { ArtifactStore } from "../server/artifact-store.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const query = { columns: "obsid,obs_collection,dataproduct_type,instrument_name,filters,s_region,dataRights",
  filters: [{ paramName: "obs_collection", values: ["HST"] }, { paramName: "dataproduct_type", values: ["image"] }, { paramName: "dataRights", values: ["PUBLIC"] }],
  coordinateFrame: "ICRS", spatialColumn: "s_region" };
const identity = { kind: "mast-hst-public-image-observations", sourceUrl: "https://mast.stsci.edu/api/v0/invoke", service: "Mast.Caom.Filtered" };
const row = (obsid: number, filters = "F814W") => ({ obsid, obs_collection: "HST", dataproduct_type: "image", dataRights: "PUBLIC",
  instrument_name: "ACS/WFC", filters, s_region: "POLYGON ICRS 95 10 95.01 10 95.01 10.01 95 10.01" });

async function fixture(root: string) {
  const put = async (ref: string, bytes: Buffer) => {
    await mkdir(path.dirname(path.join(root, ref)), { recursive: true });
    await writeFile(path.join(root, ref), bytes);
    return { path: ref, sha256: digest(bytes), sizeBytes: bytes.length };
  };
  const page = async (ref: string, number: number, count: number, total: number, data: unknown[]) => ({
    ...await put(ref, gzipSync(Buffer.from(JSON.stringify({ status: "COMPLETE", data,
      paging: { page: number, pageSize: 2, pagesFiltered: count, rowsFiltered: total, rowsTotal: total, rows: data.length } })))),
    page: number, rows: data.length,
  });
  const basePage = await page("baseline/source-units/hst-public-image-pages/page-000001.json.gz", 1, 1, 2, [row(1), row(3)]);
  const baseline = await put("baseline/source-units/hst-public-image-pages/manifest.json", Buffer.from(JSON.stringify({ ...identity,
    schemaVersion: 1, capturedAt: "2026-10-01T00:00:00Z", query, pageSize: 2, pageCount: 1, rowCount: 2, rowsTotal: 2,
    pages: [{ ...basePage, path: basePage.path.slice("baseline/".length) }] })));
  const newPages = [await page("supplement/page-000001.json.gz", 1, 3, 6, [row(1), row(2)]),
    await page("supplement/page-000003.json.gz", 3, 3, 6, [row(1, "F606W"), row(4)])];
  const manifest = { ...identity, schemaVersion: 2, refreshMode: "bounded-supplement", capturedAt: "2026-10-03T00:00:00Z", rowCount: 6,
    baseline: { root: "baseline", manifest: "source-units/hst-public-image-pages/manifest.json", sha256: baseline.sha256, sizeBytes: baseline.sizeBytes },
    supplement: { capturedAt: "2026-10-03T00:00:00Z", query, pageSize: 2, pageCount: 3, rowCount: 4, rowsFiltered: 6, rowsTotal: 6, pages: newPages } };
  const ref = "source-units/hst-public-image-pages/manifest.json";
  const saved = await put(ref, Buffer.from(JSON.stringify(manifest)));
  return { baseline, manifest, saved, ref };
}

test("HST bounded supplement preserves the installed input and adds real observations and metadata variants", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hst-supplement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(root);
  const baselineRoot = path.join(root, "baseline");
  const base = await HstObservationIndex.build(baselineRoot, f.ref, f.baseline.sha256);
  base.close();
  const originalFile = HstObservationIndex.indexPath(baselineRoot, f.baseline.sha256);
  const originalSha = digest(await readFile(originalFile));
  const fullRoot = path.join(root, "full-build");
  await cp(path.join(root, "baseline"), path.join(fullRoot, "baseline"), { recursive: true });
  await cp(path.join(root, "supplement"), path.join(fullRoot, "supplement"), { recursive: true });
  await mkdir(path.dirname(path.join(fullRoot, f.ref)), { recursive: true });
  await cp(path.join(root, f.ref), path.join(fullRoot, f.ref));
  const index = await HstObservationIndex.build(root, f.ref, f.saved.sha256, { evidenceRoot: baselineRoot, sourceSnapshotSha256: f.baseline.sha256 });
  const full = await HstObservationIndex.build(fullRoot, f.ref, f.saved.sha256);
  assert.deepEqual(index.summary, full.summary);
  assert.equal(index.summary.rowCount, 6);
  assert.equal(index.summary.observationCount, 4);
  assert.equal(index.summary.indexedRows, 5);
  assert.equal(index.summary.duplicateRecords, 1);
  assert.equal(index.summary.duplicateRows, 1);
  assert.equal(index.summary.partialRefresh, true);
  assert.equal(index.summary.supplementRows, 4);
  assert.equal(index.summary.baselineSnapshotSha256, f.baseline.sha256);
  assert.equal(digest(await readFile(originalFile)), originalSha);
  const cells = Array.from({ length: 3072 }, (_, i) => i);
  const result = index.lookup(4, cells);
  assert.deepEqual(result.observations.map(obs => obs.obsid), ["1", "2", "3", "4"]);
  assert.equal(result.observations[0]!.filters, "F606W, F814W");
  assert.equal(result.queryExhausted, true);
  assert.equal(result.truncated, true);
  const layer = { layerId: "hst-acs", surveyId: "hst", releaseId: "hst-public-images", product: "HST ACS archive coverage", modality: "imaging" } as CoverageCellLayer;
  const output = await archiveNativeUnits([layer], 4, cells, {} as ArtifactStore, { hstIndex: index });
  assert.equal(output.units.length, 4);
  assert.equal(output.truncated, true);
  assert.match(output.notes.join(" "), /bounded supplement does not establish a complete current inventory/);
  assert.match(output.notes.join(" "), new RegExp(f.baseline.sha256));
  full.close(); index.close();
});

test("HST supplement refuses fabricated pagination, changed baseline, private rows and unsafe references", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hst-supplement-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(root);
  const writeManifest = async (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)); await writeFile(path.join(root, f.ref), bytes);
    return loadHstSnapshot(root, f.ref, digest(bytes), true);
  };
  const plan = await writeManifest(f.manifest);
  let count = 0; for await (const rows of hstSnapshotRows(root, plan)) count += rows.length;
  assert.equal(count, 6);
  await assert.rejects(writeManifest({ ...f.manifest, refreshMode: "complete" }), /unsupported composite schema/);
  await assert.rejects(writeManifest({ ...f.manifest, baseline: { ...f.manifest.baseline, root: "../external" } }), /unsafe evidence path/);
  await assert.rejects(writeManifest({ ...f.manifest, rowCount: 999 }), /row count disagrees/);
  await assert.rejects(writeManifest({ ...f.manifest, supplement: { ...f.manifest.supplement, pages: [f.manifest.supplement.pages[0], f.manifest.supplement.pages[0]] } }), /invalid or missing pagination/);
  const privatePage = gzipSync(Buffer.from(JSON.stringify({ status: "COMPLETE", paging: { page: 1, pageSize: 2, pagesFiltered: 3, rowsFiltered: 6, rowsTotal: 6, rows: 2 }, data: [row(1), { ...row(2), dataRights: "EXCLUSIVE_ACCESS" }] })));
  await writeFile(path.join(root, "supplement/page-000001.json.gz"), privatePage);
  const privatePlan = await writeManifest({ ...f.manifest, supplement: { ...f.manifest.supplement, pages: [
    { ...f.manifest.supplement.pages[0], sha256: digest(privatePage), sizeBytes: privatePage.length }, f.manifest.supplement.pages[1]] } });
  await assert.rejects(async () => { for await (const _ of hstSnapshotRows(root, privatePlan)) { /* Verify all selected inputs. */ } }, /only public image/);
  await writeFile(path.join(root, f.baseline.path), "altered historical input");
  await assert.rejects(writeManifest(f.manifest), /baseline manifest failed/);
});
