import assert from "node:assert/strict";
import test from "node:test";
import { Healpix } from "healpixjs";
import type { ArtifactStore } from "../server/artifact-store.js";
import { lookupHstImages } from "../server/hst-image-lookup.js";

function table(fields: string[], values: unknown[][]): object {
  return { status: "COMPLETE", Tables: [{ Columns: fields.map((dataIndex) => ({ dataIndex })), Rows: values }] };
}

test("HST image lookup intersects s_region with the selected HEALPix cell and stores bounded metadata evidence", async (t) => {
  const order = 8;
  const pixel = 256_137;
  const healpix = new Healpix(2 ** order);
  const center = healpix.pix2vec(pixel);
  const ra = (Math.atan2(center.y, center.x) * 180 / Math.PI + 360) % 360;
  const dec = Math.asin(center.z) * 180 / Math.PI;
  const inside = `POLYGON ICRS ${ra - 0.01} ${dec - 0.01} ${ra + 0.01} ${dec - 0.01} ${ra + 0.01} ${dec + 0.01} ${ra - 0.01} ${dec + 0.01} ${ra - 0.01} ${dec - 0.01}`;
  const outside = `POLYGON ICRS ${(ra + 180) % 360} ${dec - 0.01} ${(ra + 180.02) % 360} ${dec - 0.01} ${(ra + 180.02) % 360} ${dec + 0.01} ${(ra + 180) % 360} ${dec + 0.01} ${(ra + 180) % 360} ${dec - 0.01}`;
  const requested: Array<{ service: string; params: Record<string, unknown> }> = [];
  const stored: Array<{ key: string; body: Uint8Array }> = [];
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (_input, init) => {
    const request = new URLSearchParams(String(init?.body));
    const envelope = JSON.parse(request.get("request") ?? "{}") as { service: string; params: Record<string, unknown> };
    requested.push(envelope);
    if (envelope.service === "Mast.Caom.Filtered.Position") {
      return new Response(JSON.stringify(table(
        ["obsid", "obs_collection", "dataproduct_type", "dataRights", "s_region", "instrument_name", "filters", "target_name", "t_min", "t_max"],
        [[123, "HST", "image", "PUBLIC", inside, "ACS/WFC", "F105W", "Test target", 58000, 58001], [124, "HST", "image", "PUBLIC", outside, "WFC3/IR", "F160W", "Outside target", 58000, 58001]],
      )), { status: 200 });
    }
    assert.equal(envelope.service, "Mast.Caom.Products");
    assert.equal(envelope.params.obsid, 123);
    return new Response(JSON.stringify(table(
      ["obsid", "productFilename", "dataURI", "productSubGroupDescription", "productType", "dataSize", "dataRights"],
      [[123, "hst_123_drz.fits", "mast:HST/product/hst_123_drz.fits", "DRZ", "SCIENCE", 1000, "PUBLIC"], [123, "hst_123_flt.fits", "mast:HST/product/hst_123_flt.fits", "FLT", "SCIENCE", 2000, "PUBLIC"], [123, "private.fits", "mast:HST/product/private.fits", "DRZ", "SCIENCE", 3000, "PROPRIETARY"]],
    )), { status: 200 });
  };
  const store = {
    putImmutable: async (key: string, body: Uint8Array) => { stored.push({ key, body }); return { key, sizeBytes: body.length, sha256: "" }; },
  } as unknown as ArtifactStore;

  const result = await lookupHstImages({ order, cells: [pixel] }, store);
  assert.equal(requested[0]!.params.filters && Array.isArray(requested[0]!.params.filters), true);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]!.obsid, "123");
  assert.match(result.observations[0]!.productUrl, /mast\.stsci\.edu/);
  assert.deepEqual(result.observations[0]!.files.map((file) => [file.fileName, file.recommendation, file.sizeBytes]), [
    ["hst_123_drz.fits", "combined-image", 1000],
    ["hst_123_flt.fits", "exposure", 2000],
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.truncated, false);
  assert.equal(result.queryExhausted, true);
  assert.equal(result.matchedObservationCount, 1);
  assert.match(result.sourceSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(stored.length, 1);
  assert.ok(stored[0]!.key.startsWith("hst-image-lookups/"));
  assert.match(Buffer.from(stored[0]!.body).toString(), /mast:HST\/product\/hst_123_drz\.fits/);
});

test("HST lookup retains matched FITS files when product requests fail and can retry the failed result", async (t) => {
  const order = 8;
  const pixel = 342_987;
  const center = new Healpix(2 ** order).pix2vec(pixel);
  const ra = (Math.atan2(center.y, center.x) * 180 / Math.PI + 360) % 360;
  const dec = Math.asin(center.z) * 180 / Math.PI;
  const inside = `POLYGON ICRS ${ra - 0.01} ${dec - 0.01} ${ra + 0.01} ${dec - 0.01} ${ra + 0.01} ${dec + 0.01} ${ra - 0.01} ${dec + 0.01} ${ra - 0.01} ${dec - 0.01}`;
  let failSecondObservation = true;
  let productCalls = 0;
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (_input, init) => {
    const request = new URLSearchParams(String(init?.body));
    const envelope = JSON.parse(request.get("request") ?? "{}") as { service: string; params: Record<string, unknown> };
    if (envelope.service === "Mast.Caom.Filtered.Position") {
      return new Response(JSON.stringify(table(
        ["obsid", "obs_collection", "dataproduct_type", "dataRights", "s_region"],
        [[123, "HST", "image", "PUBLIC", inside], [124, "HST", "image", "PUBLIC", inside]],
      )), { status: 200 });
    }
    productCalls++;
    if (Number(envelope.params.obsid) === 124 && failSecondObservation) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(table(
      ["parent_obsid", "obsID", "productFilename", "dataURI", "productSubGroupDescription", "productType", "dataSize", "dataRights"],
      [
        [Number(envelope.params.obsid), 900_000 + Number(envelope.params.obsid), "hst_123_drz.fits", "mast:HST/product/hst_123_drz.fits", "DRZ", "SCIENCE", 1000, "PUBLIC"],
        [999, 456, "wrong-parent.fits", "mast:HST/product/wrong-parent.fits", "DRZ", "SCIENCE", 1000, "PUBLIC"],
        [Number(envelope.params.obsid), 789, "preview.jpg", "mast:HST/product/preview.jpg", "PREVIEW", "PREVIEW", 1000, "PUBLIC"],
        [Number(envelope.params.obsid), 790, "auxiliary.fits", "mast:HST/product/auxiliary.fits", "AUXILIARY", "AUXILIARY", 1000, "PUBLIC"],
      ],
    )), { status: 200 });
  };

  const input = { order, cells: [pixel] };
  const partial = await lookupHstImages(input);
  assert.equal(partial.observations.length, 2);
  assert.deepEqual(partial.observations[0]!.files.map((file) => file.fileName), ["hst_123_drz.fits"]);
  assert.deepEqual(partial.observations[1]!.files, []);
  assert.equal(partial.truncated, true);
  assert.equal(partial.errors.length, 1);
  assert.equal(partial.errors[0]!.obsid, "124");

  failSecondObservation = false;
  const retried = await lookupHstImages(input);
  assert.equal(retried.errors.length, 0);
  assert.ok(retried.observations.every((observation) => observation.files.length === 1));
  assert.equal(productCalls, 4, "a partial result is not cached and both observations are retried");
});

test("HST lookup retains earlier observations when a later MAST position page fails", async (t) => {
  const order = 8;
  const pixel = 410_713;
  const center = new Healpix(2 ** order).pix2vec(pixel);
  const ra = (Math.atan2(center.y, center.x) * 180 / Math.PI + 360) % 360;
  const dec = Math.asin(center.z) * 180 / Math.PI;
  const inside = `POLYGON ICRS ${ra - 0.01} ${dec - 0.01} ${ra + 0.01} ${dec - 0.01} ${ra + 0.01} ${dec + 0.01} ${ra - 0.01} ${dec + 0.01} ${ra - 0.01} ${dec - 0.01}`;
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (_input, init) => {
    const request = new URLSearchParams(String(init?.body));
    const envelope = JSON.parse(request.get("request") ?? "{}") as { service: string; params: Record<string, unknown> };
    const page = Number((JSON.parse(request.get("request") ?? "{}").page));
    if (envelope.service === "Mast.Caom.Filtered.Position") {
      if (page === 2) return new Response("unavailable", { status: 503 });
      const body = {
        ...table(["obsid", "obs_collection", "dataproduct_type", "dataRights", "s_region"], [[234, "HST", "image", "PUBLIC", inside]]),
        paging: { pagesFiltered: 2 },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify(table(
      ["productFilename", "productSubGroupDescription", "productType", "dataRights"],
      [["hst_234_drz.fits", "DRZ", "SCIENCE", "PUBLIC"]],
    )), { status: 200 });
  };

  const result = await lookupHstImages({ order, cells: [pixel] });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]!.files[0]!.fileName, "hst_234_drz.fits");
  assert.equal(result.queryExhausted, false);
  assert.equal(result.errors[0]!.stage, "observations");
  assert.equal(result.errors[0]!.page, 2);
});

test("HST image lookup rejects unbounded and invalid cell requests before contacting MAST", async (t) => {
  let called = false;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error("unexpected MAST request"); };
  t.after(() => { globalThis.fetch = oldFetch; });
  await assert.rejects(() => lookupHstImages({ order: 3, cells: [0] }), /order must be 4 through 12/);
  await assert.rejects(() => lookupHstImages({ order: 8, cells: [] }), /cells must contain 1 through/);
  await assert.rejects(() => lookupHstImages({ order: 8, cells: [12 * 4 ** 8] }), /invalid NESTED/);
  assert.equal(called, false);
});

test("HST image lookup reports slow MAST requests as timeouts rather than an unavailable archive", async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => { throw Object.assign(new Error("fixture timeout"), { name: "TimeoutError" }); };

  const result = await lookupHstImages({ order: 8, cells: [256_138] });
  assert.equal(result.observations.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.stage, "observations");
  assert.equal(result.errors[0]!.kind, "timeout");
  assert.match(result.errors[0]!.message, /60 seconds/);
});
