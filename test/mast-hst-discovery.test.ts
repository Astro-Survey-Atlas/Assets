import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FilesystemArtifactStore } from "../server/artifact-store.js";
import { mastHstObservationSummaryView, resolveMastHstObservation, verifyMastHstSnapshot } from "../server/moc-discovery.js";
import { importMastHstObservation } from "../server/mast-hst-import.js";
import { decodeNativeMoc, sha256 } from "../server/native-moc.js";
import { decodeScopeMoc, parseMastHstScopeRef, resolveMastHstScope } from "../server/mast-hst-discovery.js";
import { fitsMoc } from "./reviewed-fixture.js";

const LAYER_ID = "euclid-euclid-q1-euclid-q1-vis-moc";
const OBSID = "90001";
const REQUEST = { namespace: "atlas-warehouse", name: "hst-observation-discovery", uid: "request-uid-001" };

function scopeRef(order: number, componentIndex = 0) {
  return parseMastHstScopeRef({ publishedLayerId: LAYER_ID, stagedBuildName: "hst-observation-build", order, componentIndex });
}

function resolveScope(publishedBytes: Buffer, stagedBytes: Buffer, order: number, componentIndex = 0) {
  const publishedMoc = decodeNativeMoc(publishedBytes);
  const stagedMoc = decodeNativeMoc(stagedBytes);
  return resolveMastHstScope({
    ref: scopeRef(order, componentIndex),
    publishedLayer: { layerId: LAYER_ID, surveyId: "euclid", releaseId: "euclid-q1", product: "Current VIS catalog display" },
    publishedMoc,
    publishedMocSha256: sha256(publishedBytes),
    stagedBuild: { name: "hst-observation-build", phase: "STAGED", surveyId: "hst" },
    stagedMoc,
    stagedMocSha256: sha256(stagedBytes),
  });
}

function discoveryResource(snapshotBytes: Buffer) {
  const snapshotSha256 = sha256(snapshotBytes);
  const objectKey = `discovery-evidence/observations/atlas-warehouse/${REQUEST.name}/${REQUEST.uid}/${snapshotSha256}.json`;
  const observationQuery = {
    coordinateFrame: "ICRS" as const,
    cone: { raDeg: 45, decDeg: 2, radiusDeg: 1 },
    scope: { ordering: "NESTED" as const, order: 4, cells: [0], q1MocSha256: "a".repeat(64), hstMocSha256: "b".repeat(64) },
  };
  const summary = {
    kind: "mast-hst-observations",
    request: REQUEST,
    candidates: [{ obsid: OBSID, instrument: "ACS/WFC", filters: "F814W" }],
    candidateCount: 1,
    truncated: false,
    queryExhausted: true,
    snapshot: { objectKey, sha256: snapshotSha256, sizeBytes: snapshotBytes.length },
  };
  return {
    resource: {
      metadata: { ...REQUEST, labels: { "app.kubernetes.io/managed-by": "astro-survey-atlas-assets", "astro.zhejianglab.org/resource-kind": "moc-discovery" } },
      spec: { policyRef: "mast-hst-observations-v1", query: { observationQuery } },
      status: { phase: "SUCCEEDED", observationSummary: summary },
    },
    snapshot: {
      schemaVersion: 1,
      kind: "mast-hst-observations",
      request: REQUEST,
      observationQuery,
      result: { candidateCount: 1, truncated: false, queryExhausted: true },
      source: { collection: "HST", dataproductType: "image", dataRights: "PUBLIC" },
      Tables: [{
        Columns: ["obsid", "obs_collection", "dataproduct_type", "dataRights"].map((dataIndex) => ({ dataIndex })),
        Rows: [[OBSID, "HST", "image", "PUBLIC"]],
      }],
    },
  };
}

test("HST scope uses only the selected native MOC order and stable overlap component", () => {
  const bytes = fitsMoc([{ order: 4, pixel: 0 }, { order: 4, pixel: 1000 }]);
  const first = resolveScope(bytes, bytes, 4, 0);
  const second = resolveScope(bytes, bytes, 4, 1);

  assert.equal(first.componentId, "C01");
  assert.deepEqual(first.query.scope.cells, [0]);
  assert.equal(second.componentId, "C02");
  assert.deepEqual(second.query.scope.cells, [1000]);
  assert.equal(second.query.coordinateFrame, "ICRS");
  assert.equal(second.query.scope.ordering, "NESTED");
});

test("HST scope intersects broad native projections before applying bounded work limits", () => {
  const coarse = fitsMoc([{ order: 4, pixel: 0 }]);
  assert.throws(() => resolveScope(coarse, coarse, 5), /exceeds a selected native MOC/);
  assert.throws(() => resolveScope(coarse, fitsMoc([{ order: 4, pixel: 1000 }]), 4), /no intersection/);

  const broadPublished = fitsMoc(Array.from({ length: 5001 }, (_, pixel) => ({ order: 5, pixel })));
  const broadHst = fitsMoc(Array.from({ length: 5001 }, (_, index) => ({ order: 5, pixel: index + 4995 })));
  const narrowOverlap = resolveScope(broadPublished, broadHst, 5);
  assert.ok(narrowOverlap.query.scope.cells.length > 0);
  assert.ok(narrowOverlap.query.scope.cells.length <= 6);
  assert.ok(narrowOverlap.query.scope.cells.every((pixel) => pixel >= 4995 && pixel <= 5000));

  const excessiveOverlap = fitsMoc(Array.from({ length: 65_537 }, (_, pixel) => ({ order: 8, pixel })));
  assert.throws(() => resolveScope(excessiveOverlap, excessiveOverlap, 8), /exceeds the bounded scope computation limit/);
});

test("HST scope validates exact native bytes and selected release identity", () => {
  const bytes = fitsMoc([{ order: 4, pixel: 0 }]);
  const moc = decodeNativeMoc(bytes);
  assert.throws(() => decodeScopeMoc(Buffer.from("changed"), sha256(bytes)), /unavailable or invalid/);
  assert.throws(() => resolveMastHstScope({
    ref: scopeRef(4),
    publishedLayer: { layerId: LAYER_ID, surveyId: "euclid", releaseId: "euclid-q1-dr1", product: "Current VIS catalog display" },
    publishedMoc: moc,
    publishedMocSha256: sha256(bytes),
    stagedBuild: { name: "hst-observation-build", phase: "STAGED", surveyId: "hst" },
    stagedMoc: moc,
    stagedMocSha256: sha256(bytes),
  }), /not the current Euclid Q1 VIS product/);
});

test("HST observation request binds the selected public-image candidate to the immutable snapshot", () => {
  const source = discoveryResource(Buffer.from("snapshot"));
  const resolved = resolveMastHstObservation(source.resource, OBSID);
  assert.equal(resolved.snapshot.objectKey, source.resource.status.observationSummary.snapshot.objectKey);
  assert.equal(resolved.candidate.instrument, "ACS/WFC");
  assert.doesNotThrow(() => verifyMastHstSnapshot(source.snapshot, resolved));

  const privateImage = structuredClone(source.snapshot);
  privateImage.Tables[0]!.Rows[0]![3] = "Proprietary";
  assert.throws(() => verifyMastHstSnapshot(privateImage, resolved), /not one unique public image row/);
});

test("HST public observation summaries omit object keys and snapshot rows", () => {
  const source = discoveryResource(Buffer.from("snapshot"));
  const rawSummary = source.resource.status.observationSummary;
  const summary = mastHstObservationSummaryView(rawSummary, true);
  const text = JSON.stringify(summary);

  assert.equal(summary?.candidates?.[0]?.obsid, OBSID);
  assert.doesNotMatch(text, /objectKey|q1MocSha256|hstMocSha256|Tables|Rows|snapshot\//);
  assert.match(text, new RegExp(createHash("sha256").update("snapshot").digest("hex")));
});

test("HST import rejects artifact bytes that differ from the immutable discovery digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-hst-artifact-"));
  try {
    const body = Buffer.from("expected immutable bytes");
    const source = discoveryResource(body);
    const resolved = resolveMastHstObservation(source.resource, OBSID);
    const store = new FilesystemArtifactStore(root);
    await store.putImmutable(resolved.snapshot.objectKey, Buffer.from("tampered bytes"));

    await assert.rejects(importMastHstObservation({
      resource: source.resource,
      candidateId: OBSID,
      artifactStore: store,
      evidenceRoot: root,
      products: {} as never,
      builds: {} as never,
      buildService: {} as never,
    }), /metadata does not match the discovery status/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
