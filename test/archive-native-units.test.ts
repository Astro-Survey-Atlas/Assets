import assert from "node:assert/strict";
import test from "node:test";
import { Healpix } from "healpixjs";
import { archiveNativeUnits, hstObservationMatchesLayer } from "../server/archive-native-units.js";
import { acquireEroTargetSnapshot, parseEroTargetSnapshot } from "../server/ero-target-index.js";
import { createHash } from "node:crypto";
import { lookupHstImages } from "../server/hst-image-lookup.js";
import type { CoverageCellLayer } from "../server/coverage.js";
import type { ArtifactStore } from "../server/artifact-store.js";
import type { HstObservationIndex } from "../server/hst-observation-index.js";

const layer = (surveyId: string, product: string, releaseId: string): CoverageCellLayer => ({ layerId: product, productId: product, surveyId, product, releaseId,
  modality: "imaging", color: "#ffffff", availableOrders: [8], overviewOrder: 8, maxOrder: 8, cellCount: 1, areaDeg2: 1, tileScheme: "ipix-range-4096", cells: new Map() });

test("Explicit HST product lookup uses public observation metadata without retrieving science files", async (t) => {
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
  const messierUri = "https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-Messier78.DR3.tar";
  const ic10Uri = "https://cdn.euclid.esac.esa.int/Stack/Euclid-VIS-Stack-ERO-IC10.DR3.tar";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.notEqual(url.hostname, "cdn.euclid.esac.esa.int", "scientific packages must never be fetched");
    if (url.hostname === "sky.esa.int") return new Response(JSON.stringify({ metadata: [{ name: "id" }, { name: "object_name" }, { name: "stc_s" }], data: [
      ["Abell2390", "Abell 2390 galaxy cluster", "POLYGON ICRS 328.889286 17.5327373 328.5711216 18.1453116 327.9278751 17.8408843 328.2476865 17.2293456"],
      ["M78", "Messier 78 nebula", "POLYGON ICRS 84 0 85 0 85 1"],
      ["M78_HighRes", "Messier 78 nebula", "POLYGON ICRS 84 0 85 0 85 1"],
    ] }));
    if (url.pathname === "/dr/ero/") return new Response("<data><a href='ERO-Abell2390'>Abell2390</a><a href='ERO-Messier78'>Messier78</a><a href='ERO-IC10'>IC10</a></data>");
    const id = url.pathname.split("/").at(-1);
    const packageUri = id === "ERO-Abell2390" ? uri : id === "ERO-Messier78" ? messierUri : ic10Uri;
    return new Response(`<data><dataitem><name>${id}</name><a href="${packageUri}">VIS</a></dataitem></data>`);
  };
  const snapshot = await acquireEroTargetSnapshot();
  const eroIndex = parseEroTargetSnapshot(snapshot, createHash("sha256").update(snapshot).digest("hex"));
  assert.equal(eroIndex.targets.length, 2);
  assert.equal(eroIndex.excludedTargets, 1, "IC10 package links do not prove a spatial footprint");
  const messier = eroIndex.targets.find((target) => target.id === "ERO-Messier78");
  assert.equal(messier?.sRegion, "POLYGON ICRS 84 0 85 0 85 1");
  assert.deepEqual(messier?.urls, [messierUri]);
  globalThis.fetch = async () => { throw new Error("Runtime lookup must not acquire metadata"); };
  const result = await archiveNativeUnits([layer("euclid", "ERO VIS", "euclid-ero")], 8, [202250, 202272], store, { eroIndex });
  assert.equal(result.units[0]!.unitKind, "target"); assert.equal(result.units[0]!.unitId, "ERO-Abell2390");
  assert.equal(result.units[0]!.accessUri, uri); assert.equal(result.units[0]!.precision, "estimated");
  assert.equal(stored.length, 0, "Read-only runtime lookup writes no evidence objects");
  const miss = await archiveNativeUnits([layer("euclid", "ERO VIS", "euclid-ero")], 8, [0], store, { eroIndex });
  assert.deepEqual(miss.units, []);
});

test("HST reverse lookup distinguishes the local observation cap from excluded geometry rows", async () => {
  const hstIndex = { lookup: () => ({ observations: Array.from({ length: 6400 }, (_, index) => ({ obsid: String(index), productUrl: "https://mast.stsci.edu/observation/", sRegion: "POLYGON ICRS 0 0 1 0 1 1", matchingCells: [200001] })),
    matchedObservationCount: 6401, truncated: true, queryExhausted: false,
    sourceSnapshotSha256: "a".repeat(64), excludedRows: 18 }) } as unknown as HstObservationIndex;
  const result = await archiveNativeUnits([layer("hst", "HST public image observations", "hst-mast-snapshot-2026")], 8, [200001],
    {} as ArtifactStore, { hstIndex });
  assert.equal(result.truncated, true);
  assert.match(result.notes.join("\n"), /at least 6401 observations.*configured 6400-observation result limit/);
  assert.match(result.notes.join("\n"), /excludes 18 public image rows/);
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
