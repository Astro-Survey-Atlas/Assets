import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AdminHttpError } from "../server/admin.js";
import { FilesystemArtifactStore, type ArtifactObject, type ArtifactObjectWithBody, type ArtifactPutOptions, type ArtifactStore } from "../server/artifact-store.js";
import { MocBuildService, MocBuildStore, MocPublicationStore } from "../server/moc-build.js";
import { resolveMocDiscoveryCandidate } from "../server/moc-discovery.js";
import { StateSnapshotCoordinator, stateSnapshotFileKey } from "../server/state-snapshot.js";
import { UploadSpool } from "../server/upload-spool.js";

class LocalS3Adapter implements ArtifactStore {
  readonly kind = "s3" as const;

  constructor(private readonly delegate: FilesystemArtifactStore) {}

  head(key: string): Promise<ArtifactObject | null> { return this.delegate.head(key); }
  get(key: string, range?: { start: number; end: number }): Promise<ArtifactObjectWithBody | null> { return this.delegate.get(key, range); }
  putImmutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putImmutable(key, body, options); }
  putMutable(key: string, body: Uint8Array | string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putMutable(key, body, options); }
  putFileImmutable(key: string, filePath: string, options?: ArtifactPutOptions): Promise<ArtifactObject> { return this.delegate.putFileImmutable(key, filePath, options); }
  downloadToFile(key: string, filePath: string): Promise<ArtifactObject | null> { return this.delegate.downloadToFile(key, filePath); }
}

async function waitForUploadKind(root: string, kind: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const entry of await readdir(path.join(root, "jobs"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(root, "jobs", entry.name, "manifest.json"), "utf8")) as { kind?: string };
        if (manifest.kind === kind) return;
      } catch { /* enqueue is still copying the job */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for upload kind ${kind}`);
}

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

test("MOC staged and published files record durable keys and queue after local completion", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "atlas-moc-durable-"));
  let snapshots: StateSnapshotCoordinator | undefined;
  try {
    const content = path.join(base, "content");
    const evidence = path.join(base, "evidence");
    const objectStore = new LocalS3Adapter(new FilesystemArtifactStore(path.join(base, "objects")));
    const spool = new UploadSpool({ root: path.join(base, "uploads"), store: objectStore });
    await spool.initialize();
    snapshots = new StateSnapshotCoordinator({ root: path.join(base, "state"), store: objectStore, spool });
    await snapshots.initialize(["moc-build", "moc-publications"]);

    const builds = new MocBuildStore(content, snapshots);
    const candidate = resolveMocDiscoveryCandidate(request({ schemaVersion: 2, truncated: false, summaryTruncated: false, candidates: [{ candidateId: "jwst", mocUrl: "https://alasky.cds.unistra.fr/jwst/moc.fits" }] }), "jwst");
    const build = await builds.create({ discoveryRequestName: candidate.requestName, candidate, productId: "jwst-dr1" });
    const service = new MocBuildService({
      store: builds,
      evidenceRoot: evidence,
      fetchImpl: async () => new Response("source-moc"),
      runner: {
        validate: async () => ({ valid: true }),
        build: async (_source, output) => {
          await writeFile(path.join(output, "moc.fits"), "moc");
          await writeFile(path.join(output, "query-order8.json"), "{}");
          return { cells: 1, availableOrders: [8], maxOrder: 8 };
        },
      },
    });
    service.enqueue(build, candidate);
    for (let attempt = 0; attempt < 100 && builds.get(build.name).phase !== "STAGED"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const staged = builds.get(build.name);
    assert.equal(staged.phase, "STAGED");
    assert.equal(staged.outputs?.moc?.objectKey, stateSnapshotFileKey("moc-build", staged.outputs!.moc!.sha256));
    await waitForUploadKind(path.join(base, "uploads"), "moc-build-output");

    const publications = new MocPublicationStore(content, evidence, snapshots);
    const publication = await publications.publish(staged, { productId: "jwst-dr1", surveyId: "jwst", releaseId: "dr1", name: "JWST DR1" });
    assert.equal(publication.files.moc.objectKey, stateSnapshotFileKey("moc-publications", publication.files.moc.sha256));
    await waitForUploadKind(path.join(base, "uploads"), "moc-publication-file");
    const persisted = JSON.parse(await readFile(path.join(content, "moc-publications-v1.json"), "utf8")) as { publications: Array<{ files: { moc: { objectKey?: string } } }> };
    assert.equal(persisted.publications[0]?.files.moc.objectKey, publication.files.moc.objectKey);
  } finally {
    await snapshots?.flush();
    await rm(base, { recursive: true, force: true });
  }
});
