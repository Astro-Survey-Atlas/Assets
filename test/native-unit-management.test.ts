import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SourceUnitStore } from "../server/source-units.js";
import { nativeDatabaseKey, nativeFile, runNativeUnitWorker } from "../server/native-unit-worker.js";
import { buildNativeDelta } from "../server/native-unit-delta.js";
import { NativeUnitController } from "../server/native-unit-controller.js";
import { PublicationTaskStore } from "../server/publication-task-store.js";
import { FilesystemArtifactStore } from "../server/artifact-store.js";
import { bindingRevision, nativeDigest, nativeGroupId, groupReviewDigest, type NativeBinding, type NativeGroup, type NativeSource, type NativeWorkerRequest, type NativeSnapshot } from "../server/native-unit-model.js";

const patchText = (tract: number) => [
  `Tract: ${tract}  Patch: 0,0  Center (RA, Dec): (149.507118993 , 1.48467782206)`,
  ...[[149.600381219, 1.39136228924], [149.413758093, 1.39142133554], [149.413840978, 1.57799734129], [149.600487771, 1.577930368]].map(([ra, dec], index) => `Tract: ${tract}  Patch: 0,0  Corner${index} (RA, Dec): (${ra}, ${dec})`),
].join("\n");

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(path.join(root, "src/layers/recipes"), { recursive: true });
  await mkdir(evidenceRoot);
  const sources: NativeSource[] = [], snapshots: Record<string, NativeSnapshot> = {}, bindings: NativeBinding[] = [];
  const lock: Record<string, any> = { schemaVersion: 1, layerBindings: [] };
  for (const [release, tract] of [[2, 9812], [3, 9813]]) {
    const releaseId = `hsc-pdr${release}`, id = `${releaseId}-patches`, slot = `hscPdr${release}`;
    const ref = `patches-${release}.txt`, sourceUrl = `https://hsc-release.mtk.nao.ac.jp/archive/pdr${release}/patches.txt`;
    await writeFile(path.join(evidenceRoot, ref), patchText(tract!));
    const file = { ...await nativeFile(evidenceRoot, ref), sourceUrl };
    const patch = { releaseId, snapshotKey: slot, sourceUrl, dasSearchUrl: `https://hsc-release.mtk.nao.ac.jp/das_search/pdr${release}/`, sourceFiles: [{ path: ref, sha256: file.sha256, sizeBytes: file.sizeBytes, sourceUrl, region: "fixture" }] };
    lock[slot] = patch;
    lock.layerBindings.push({ surveyId: "hsc-ssp", releaseId, product: "Coadded imaging", modality: "imaging", unitKind: "tract/patch", snapshotKey: slot, notes: "Synthetic public metadata fixture" });
    sources.push({ id, revision: 1, surveyId: "hsc-ssp", releaseId, title: releaseId, adapter: "hsc-patch", unitKind: "tract/patch", scope: "synthetic fixture", sourceUrl, slot, files: [file], updatedAt: "2026-10-01T00:00:00.000Z" });
    snapshots[id] = { id: nativeDigest(file.sha256), sourceId: id, sourceRevision: 1, capturedAt: "2026-10-01T00:00:00.000Z", files: [file], scope: "synthetic fixture", sourceUrl, patch, rowCount: 1 };
    bindings.push({ productId: `pdr${release}`, layerId: `source-units-hsc-ssp-${releaseId}-coadded-imaging`, surveyId: "hsc-ssp", releaseId, product: "Coadded imaging", modality: "imaging", unitKind: "tract/patch", sourceIds: [id], revision: "", visibility: "imported-overview" });
  }
  const lockText = JSON.stringify(lock);
  await writeFile(path.join(root, "src/layers/recipes/source-unit-indexes.lock.json"), lockText);
  await writeFile(path.join(root, "src/layers/layer-registry.json"), JSON.stringify({ layers: [] }));
  const store = await SourceUnitStore.load(root, evidenceRoot);
  const coverage = store.coverageLayers(); store.close();
  const ref = "derived/source-unit-indexes/native-units.sqlite";
  const candidate = { createdAt: "2026-10-01T00:00:00.000Z", origin: "imported-baseline" as const,
    generic: { file: await nativeFile(evidenceRoot, ref), buildKey: nativeDatabaseKey(path.join(evidenceRoot, ref)) },
    lockText, recipes: {}, snapshots, bindings: bindings.map(binding => ({ ...binding, revision: bindingRevision(binding, snapshots) })),
    report: { checks: [], counts: {}, gaps: [], samples: [] } };
  const group: NativeGroup = { ...candidate, id: nativeGroupId(candidate) };
  const request: NativeWorkerRequest = { operation: { kind: "native-unit", operation: "verify", actor: "fixture", submittedAt: group.createdAt, groupId: group.id },
    catalogRoot: root, evidenceRoot, taskId: "fixture-verification", sources, snapshots: [], active: group, bindings: group.bindings };
  group.report = (await runNativeUnitWorker(request)).report!;
  return { root, evidenceRoot, sources, snapshots, group, request, coverage };
}

test("release delta keeps the active database immutable and preserves other releases", async t => {
  const f = await fixture(t);
  const source = f.sources[0]!;
  const ref = "changed-pdr2.txt";
  await writeFile(path.join(f.evidenceRoot, ref), patchText(9912));
  const file = { ...await nativeFile(f.evidenceRoot, ref), sourceUrl: source.sourceUrl };
  const lock = JSON.parse(f.group.lockText);
  lock.hscPdr2.sourceFiles[0] = { ...lock.hscPdr2.sourceFiles[0], path: ref, sha256: file.sha256, sizeBytes: file.sizeBytes };
  const snapshot = { ...f.snapshots[source.id]!, id: nativeDigest(file.sha256), files: [file], patch: lock.hscPdr2 };
  const destination = "managed/candidate.sqlite";
  await buildNativeDelta({ ...f.request, taskId: "changed-release", snapshots: [snapshot] }, destination, JSON.stringify(lock), {}, () => {});
  assert.equal((await nativeFile(f.evidenceRoot, f.group.generic!.file.ref)).sha256, f.group.generic!.file.sha256);
  const changed = await SourceUnitStore.load(f.root, f.evidenceRoot, { readOnly: true, indexPath: path.join(f.evidenceRoot, destination), buildKey: nativeDatabaseKey(path.join(f.evidenceRoot, destination)), lockText: JSON.stringify(lock) });
  try {
    for (const binding of f.group.bindings) {
      const cells = f.coverage.find(layer => layer.releaseId === binding.releaseId)!.cells.get(4)!;
      const units = changed.match(binding.layerId, 4, cells, 10, binding)!.units;
      assert.deepEqual(units.map(unit => unit.unitId), [binding.releaseId === "hsc-pdr2" ? "9912/0,0" : "9813/0,0"]);
      assert.ok(units.every(unit => unit.geometryPrecision === "estimated" && unit.downloadUrl.includes(binding.releaseId.replace("hsc-", ""))));
    }
  } finally { changed.close(); }
  const missing = path.join(f.evidenceRoot, "missing.sqlite");
  await assert.rejects(SourceUnitStore.load(f.root, f.evidenceRoot, { readOnly: true, indexPath: missing, buildKey: "a".repeat(64) }), /managed build/);
  await assert.rejects(readFile(missing), /ENOENT/);
});

test("native review, archive, authority activation, site verification and isolated restore are independent", async t => {
  const f = await fixture(t);
  const store = new FilesystemArtifactStore(path.join(f.root, "var/object-store"));
  let siteChecks = 0;
  const options = { contentRoot: path.join(f.root, "content"), catalogRoot: f.root, evidenceRoot: f.evidenceRoot, store,
    bindings: async () => f.group.bindings, changed: async () => {}, verifyRuntime: async () => {}, verifySite: async () => { siteChecks++; } };
  const controller = new NativeUnitController(options); await controller.initialize();
  const queue = new PublicationTaskStore(path.join(f.root, "tasks.sqlite")); t.after(() => queue.close()); controller.attachQueue(queue);
  const baseline = await controller.submit({ operation: "baseline", expectedActive: null }, "fixture");
  const claimed = queue.claim<NativeWorkerRequest>()!; assert.equal(claimed.id, baseline.id);
  await controller.complete(claimed, { group: f.group }, queue);
  const digest = groupReviewDigest(f.group);
  await assert.rejects(controller.review(f.group.id, { digest, acceptedGaps: [] }, "fixture"), /accept every/);
  await controller.review(f.group.id, { digest, acceptedGaps: f.group.report.gaps }, "fixture");
  await assert.rejects(controller.submit({ operation: "activate", groupId: f.group.id, expectedActive: null, reviewDigest: digest }, "fixture"), /Archive every/);
  await controller.submit({ operation: "archive", groupId: f.group.id }, "fixture");
  const archive = queue.claim<NativeWorkerRequest>()!;
  const archived = await runNativeUnitWorker(archive.payload);
  await controller.complete(archive, archived, queue);
  assert.equal(groupReviewDigest(archived.group!), digest, "storage locations do not change reviewed content");
  const activate = await controller.submit({ operation: "activate", groupId: f.group.id, expectedActive: null, reviewDigest: digest }, "fixture");
  const activation = queue.claim<NativeWorkerRequest>()!; await controller.activate(activation, queue);
  assert.equal(queue.get(activate.id)!.phase, "site-pending"); assert.equal(siteChecks, 0);
  await controller.verifyPending(queue.get(activate.id)!);
  assert.equal(queue.get(activate.id)!.phase, "published"); assert.equal(siteChecks, 1);
  assert.equal(controller.active!.id, f.group.id);
  await assert.rejects(controller.submit({ operation: "activate", groupId: f.group.id, expectedActive: null, reviewDigest: digest }, "fixture"), /Active index changed/);
  const restoredRoot = path.join(f.root, "restored-evidence"); await mkdir(restoredRoot);
  const restored = new NativeUnitController({ ...options, contentRoot: path.join(f.root, "fresh-content"), evidenceRoot: restoredRoot });
  await restored.initialize();
  assert.equal(restored.active!.id, f.group.id); assert.equal(restored.generation, 1);
  assert.equal((await nativeFile(restoredRoot, restored.active!.generic!.file.ref)).sha256, f.group.generic!.file.sha256);
  const input = Object.values(restored.active!.snapshots)[0]!.files[0]!;
  await writeFile(path.join(restoredRoot, input.ref), Buffer.alloc(input.sizeBytes, 32));
  const corrupt = new NativeUnitController({ ...options, contentRoot: path.join(f.root, "another-content"), evidenceRoot: restoredRoot });
  await assert.rejects(corrupt.initialize(), /checksum mismatch/, "same-size corruption must not be adopted as the authority version");
});
