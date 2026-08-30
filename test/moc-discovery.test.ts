import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError } from "../server/admin.js";
import { MocBuildService, MocBuildStore, MocPublicationStore } from "../server/moc-build.js";
import { resolveMocDiscoveryCandidate } from "../server/moc-discovery.js";

function request(summary: unknown, phase = "SUCCEEDED") {
  return { name: "jwst-moc-discovery", status: { phase, reviewSummary: summary } };
}

test("MOC v2 candidate resolution uses the Warehouse summary as authority", () => {
  const result = resolveMocDiscoveryCandidate(request({
    schemaVersion: 2,
    truncated: false,
    summaryTruncated: false,
    candidates: [{ candidateId: "jwst", title: "JWST", recordUrl: "https://alasky.cds.unistra.fr/jwst", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }],
  }), "jwst");
  assert.equal(result.sourceUrl, "https://alasky.cds.unistra.fr/jwst/moc.fits");
  assert.equal(result.candidate.title, "JWST");
  assert.throws(() => resolveMocDiscoveryCandidate(request({ schemaVersion: 1, truncated: false, summaryTruncated: false, candidates: [] }), "jwst"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409);
  assert.throws(() => resolveMocDiscoveryCandidate(request({ schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst", mocUrl: "https://example.org/jwst.fits" }] }), "jwst"), (error: unknown) => error instanceof AdminHttpError && error.statusCode === 409);
});

test("MOC build requests persist phases and deduplicate a locked source snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-build-"));
  const store = new MocBuildStore(root);
  const candidate = resolveMocDiscoveryCandidate(request({ schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }] }), "jwst");
  const first = await store.create({ discoveryRequestName: candidate.requestName, candidate, productId: "jwst-dr1" });
  const second = await store.create({ discoveryRequestName: candidate.requestName, candidate, productId: "jwst-dr1" });
  const locked = await store.lockSnapshot(first.name, "a".repeat(64), 10, "moc-build/source.moc");
  assert.equal(locked.request.phase, "SNAPSHOT_LOCKED");
  const duplicate = await store.lockSnapshot(second.name, "a".repeat(64), 10, "moc-build/source.moc");
  assert.equal(duplicate.duplicateOf, first.name);
  assert.equal(store.get(second.name).phase, "DUPLICATE");
  const persisted = JSON.parse(await readFile(path.join(root, "moc-build-requests-v1.json"), "utf8")) as { requests: Array<{ name: string }> };
  assert.equal(persisted.requests.length, 2);
});

test("MOC build service locks bytes and reaches STAGED with an injected Core runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-service-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-evidence-"));
  const store = new MocBuildStore(root);
  const candidate = resolveMocDiscoveryCandidate(request({ schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }] }), "jwst");
  const build = await store.create({ discoveryRequestName: candidate.requestName, candidate });
  const runner = {
    validate: async () => ({ valid: true }),
    build: async (_source: string, output: string) => {
      await writeFile(path.join(output, "moc.fits"), "moc");
      await writeFile(path.join(output, "query-order8.json"), "{}");
      await writeFile(path.join(output, "preview-order4.json"), "{}");
      await writeFile(path.join(output, "statistics.json"), "{}");
      return { cells: 3, availableOrders: [8], maxOrder: 8 };
    },
  };
  const service = new MocBuildService({ store, evidenceRoot: evidence, fetchImpl: async () => new Response("source-moc"), runner });
  service.enqueue(build, candidate);
  for (let attempt = 0; attempt < 100 && store.get(build.name).phase !== "STAGED"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.get(build.name).phase, "STAGED");
  assert.equal(store.get(build.name).source.snapshotSha256?.length, 64);
  assert.equal(store.get(build.name).outputs?.cellCount, 3);
});

test("staged MOC outputs publish immutably and can be restored", async () => {
  const content = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-public-content-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-public-evidence-"));
  const store = new MocBuildStore(content);
  const candidate = resolveMocDiscoveryCandidate(request({ schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }] }), "jwst");
  const build = await store.create({ discoveryRequestName: candidate.requestName, candidate, productId: "jwst-dr1" });
  const runner = {
    validate: async () => ({ valid: true }),
    build: async (_source: string, output: string) => {
      await writeFile(path.join(output, "moc.fits"), "moc");
      await writeFile(path.join(output, "query-order8.json"), JSON.stringify({ order: 8, ordering: "NESTED", pixels: [1, 2] }));
      await writeFile(path.join(output, "preview-order4.json"), JSON.stringify({ order: 4, ordering: "NESTED", pixels: [0] }));
      await writeFile(path.join(output, "statistics.json"), "{}");
      return { cells: 2, availableOrders: [4, 8], maxOrder: 8 };
    },
  };
  const service = new MocBuildService({ store, evidenceRoot: evidence, fetchImpl: async () => new Response("source-moc"), runner });
  service.enqueue(build, candidate);
  for (let attempt = 0; attempt < 100 && store.get(build.name).phase !== "STAGED"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const staged = store.get(build.name);
  const publications = new MocPublicationStore(content, evidence);
  const publication = await publications.publish(staged, { productId: "jwst-dr1", surveyId: "jwst", releaseId: "dr1", name: "JWST DR1" });
  assert.equal(publication.files.query?.sha256.length, 64);
  assert.match(publications.absolutePath(publication.files.moc), /moc-releases/);
  assert.ok(publication.files.preview);
  assert.equal((await readFile(publications.absolutePath(publication.files.preview), "utf8")).includes('"order":4'), true);
  const restored = new MocPublicationStore(content, evidence);
  await restored.initialize();
  assert.equal(restored.forBuild(build.name)?.id, publication.id);
});

test("publication integrity verification rejects tampered content-volume files", async () => {
  const content = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-integrity-content-"));
  const evidence = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-integrity-evidence-"));
  const store = new MocBuildStore(content);
  const candidate = resolveMocDiscoveryCandidate(request({ schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }] }), "jwst");
  const build = await store.create({ discoveryRequestName: candidate.requestName, candidate, productId: "jwst-dr1" });
  const runner = {
    validate: async () => ({ valid: true }),
    build: async (_source: string, output: string) => {
      await writeFile(path.join(output, "moc.fits"), "moc");
      await writeFile(path.join(output, "query-order8.json"), JSON.stringify({ order: 8, ordering: "NESTED", pixels: [1] }));
      return { cells: 1, availableOrders: [8], maxOrder: 8 };
    },
  };
  const service = new MocBuildService({ store, evidenceRoot: evidence, fetchImpl: async () => new Response("source-moc"), runner });
  service.enqueue(build, candidate);
  for (let attempt = 0; attempt < 100 && store.get(build.name).phase !== "STAGED"; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const staged = store.get(build.name);
  const publications = new MocPublicationStore(content, evidence);
  const publication = await publications.publish(staged, { productId: "jwst-dr1", surveyId: "jwst", releaseId: "dr1", name: "JWST DR1" });
  assert.deepEqual(await publications.verify(publication), { valid: true });
  await writeFile(publications.absolutePath(publication.files.moc), "tampered");
  const invalid = await publications.verify(publication);
  if (invalid.valid) throw new Error("tampered publication unexpectedly passed integrity verification");
  assert.match(invalid.reason, /SHA-256|size/i);
});
