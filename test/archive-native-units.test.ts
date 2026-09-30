import assert from "node:assert/strict";
import test from "node:test";
import { Healpix } from "healpixjs";
import { archiveNativeUnits, hstObservationMatchesLayer } from "../server/archive-native-units.js";
import { lookupHstImages } from "../server/hst-image-lookup.js";
import type { CoverageCellLayer } from "../server/coverage.js";
import type { ArtifactStore } from "../server/artifact-store.js";

const layer = (surveyId: string, product: string, releaseId: string): CoverageCellLayer => ({ layerId: product, productId: product, surveyId, product, releaseId,
  modality: "imaging", color: "#ffffff", availableOrders: [8], overviewOrder: 8, maxOrder: 8, cellCount: 1, areaDeg2: 1, tileScheme: "ipix-range-4096", cells: new Map() });

test("HST metadata reverse lookup uses GET and preserves observation footprint without product or science requests", async (t) => {
  const pixel = 200001; const pointing = new Healpix(256).pix2ang(pixel);
  const ra = pointing.phi * 180 / Math.PI, dec = 90 - pointing.theta * 180 / Math.PI;
  const sRegion = `POLYGON ${ra - .01} ${dec - .01} ${ra + .01} ${dec - .01} ${ra + .01} ${dec + .01} ${ra - .01} ${dec + .01}`;
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input)); assert.equal(url.hostname, "mast.stsci.edu");
    const query = JSON.parse(url.searchParams.get("request")!); assert.equal(query.service, "Mast.Caom.Filtered.Position");
    return new Response(JSON.stringify({ status: "COMPLETE", paging: { pagesFiltered: 1 }, data: [{ obsid: 123, obs_collection: "HST", dataproduct_type: "image", dataRights: "PUBLIC", instrument_name: "ACS/WFC", filters: "F814W", s_region: sRegion }] }));
  };
  const result = await lookupHstImages({ order: 8, cells: [pixel] }, undefined, { metadataOnly: true });
  assert.equal(result.observations[0]!.sRegion, sRegion);
  assert.deepEqual(result.observations[0]!.matchingCells, [pixel]);
  assert.deepEqual(result.observations[0]!.files, []);
  assert.equal(hstObservationMatchesLayer(layer("hst", "HST WFC3 archive coverage", "archive"), result.observations[0]!), false);
  assert.equal(hstObservationMatchesLayer(layer("hst", "HST ACS archive coverage", "archive"), result.observations[0]!), true);
  const single = { ...layer("hst", "Observation", "archive"), layerId: "hst-mast-observation-124" };
  assert.equal(hstObservationMatchesLayer(single, result.observations[0]!), false);
});

test("ERO target URLs come from official XML and associated ESA Sky footprint, never an aggregate MOC or center", async (t) => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  const stored: string[] = [];
  const store = { putImmutable: async (_key: string, body: string) => { stored.push(body); } } as unknown as ArtifactStore;
  const uri = "https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-Abell2390.DR3.tar";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.notEqual(url.hostname, "cdn.euclid.esac.esa.int", "scientific packages must never be fetched");
    if (url.hostname === "sky.esa.int") return new Response(JSON.stringify({ metadata: [{ name: "id" }, { name: "stc_s" }], data: [["Abell2390", "POLYGON ICRS 328.889286 17.5327373 328.5711216 18.1453116 327.9278751 17.8408843 328.2476865 17.2293456"]] }));
    if (url.pathname === "/dr/ero/") return new Response("<data><a href='ERO-Abell2390'>Abell2390</a></data>");
    assert.equal(url.pathname, "/dr/ero/ERO-Abell2390");
    return new Response(`<data><dataitem><name>ERO-Abell2390</name><a href="${uri}">VIS</a></dataitem></data>`);
  };
  const result = await archiveNativeUnits([layer("euclid", "ERO VIS", "euclid-ero")], 8, [202250, 202272], store);
  assert.equal(result.units[0]!.unitKind, "target"); assert.equal(result.units[0]!.unitId, "ERO-Abell2390");
  assert.equal(result.units[0]!.accessUri, uri); assert.equal(result.units[0]!.precision, "estimated");
  assert.equal(stored.length, 1); assert.match(stored[0]!, /footprint/);
  const miss = await archiveNativeUnits([layer("euclid", "ERO VIS", "euclid-ero")], 8, [0], store);
  assert.deepEqual(miss.units, []);
});

test("an expired HST query deadline returns honest partial status without an upstream request", async (t) => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => { throw new Error("expired query must not fetch"); };
  const result = await lookupHstImages({ order: 8, cells: [200003] }, undefined,
    { metadataOnly: true, signal: AbortSignal.abort(new DOMException("Query deadline", "TimeoutError")) });
  assert.equal(result.truncated, true);
  assert.equal(result.queryExhausted, false);
  assert.equal(result.errors[0]!.kind, "timeout");
  assert.deepEqual(result.observations, []);
});
