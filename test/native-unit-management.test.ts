import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Healpix, Pointing } from "healpixjs";
import { SourceUnitDiskIndex } from "../server/source-unit-disk-index.js";
import { legacyDr5CoaddFallbackAlias, SourceUnitStore } from "../server/source-units.js";
import { nativeDatabaseKey, nativeFile, runNativeUnitWorker } from "../server/native-unit-worker.js";
import { buildNativeDelta } from "../server/native-unit-delta.js";
import { NativeUnitController } from "../server/native-unit-controller.js";
import { PublicationTaskStore } from "../server/publication-task-store.js";
import { FilesystemArtifactStore } from "../server/artifact-store.js";
import { verifyNativeRuntimeBindings } from "../server/native-runtime-verification.js";
import { nativeBindingIndexRoute } from "../server/survey-native-index.js";
import { bindingRevision, nativeDigest, nativeGroupId, groupReviewDigest, type NativeBinding, type NativeGroup, type NativeSource, type NativeWorkerRequest, type NativeSnapshot } from "../server/native-unit-model.js";

const patchText = (tract: number) => [
  `Tract: ${tract}  Patch: 0,0  Center (RA, Dec): (149.507118993 , 1.48467782206)`,
  ...[[149.600381219, 1.39136228924], [149.413758093, 1.39142133554], [149.413840978, 1.57799734129], [149.600487771, 1.577930368]].map(([ra, dec], index) => `Tract: ${tract}  Patch: 0,0  Corner${index} (RA, Dec): (${ra}, ${dec})`),
].join("\n");

test("DECaLS DR5 can query an older index through its Legacy mixed-program coadd membership", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-native-decals-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(path.join(root, "src/layers/recipes"), { recursive: true });
  await mkdir(evidenceRoot);
  await writeFile(path.join(root, "src/layers/layer-registry.json"), JSON.stringify({ layers: [] }));
  await writeFile(path.join(root, "src/layers/recipes/source-unit-indexes.lock.json"), JSON.stringify({ layerBindings: [] }));

  const identity = { surveyId: "decals", releaseId: "decals-dr5", product: "DR5 g/r/z color footprint" };
  const legacyAlias = legacyDr5CoaddFallbackAlias("decals-dr5-color-footprint", identity);
  assert.equal(legacyAlias, "identity:legacy-surveys/legacy-dr5/Coadded%20imaging");
  const center = new Pointing(null, false, Math.PI / 2, 0);
  const cell = new Healpix(16).ang2pix(center);
  const indexPath = path.join(evidenceRoot, "installed/native-units.sqlite");
  const diskIndex = await SourceUnitDiskIndex.create(indexPath, "a".repeat(64), [{
    key: legacyAlias!,
    geometryKey: "legacy-dr5-geometry",
    payloadKind: "legacy-release-roster",
    payloadContext: { releaseId: "legacy-dr5", productPath: "coadd" },
    aliases: [legacyAlias!],
    layerId: legacyAlias!,
    surveyId: "legacy-surveys",
    releaseId: "legacy-dr5",
    product: "Coadded imaging",
    coarseOrder: 4,
    maxUnitRadiusDeg: 10,
    unitKind: "brick",
    notes: "Official Legacy DR5 coadd roster.",
    sourceSnapshotSha256: "b".repeat(64),
    units: [{
      coarsePixel: cell,
      unit: { unitId: "1498p020", unitKind: "brick", raDeg: 0, decDeg: 0, radiusDeg: 10, downloadUrl: "https://portal.nersc.gov/", geometryPrecision: "estimated", sourceSnapshotSha256: "b".repeat(64) },
      membershipPayload: { regions: [{ id: "all", availableBands: ["g", "r", "z"] }] },
    }],
  }], [{
    layerId: legacyAlias!, surveyId: "legacy-surveys", releaseId: "legacy-dr5", product: "Coadded imaging", modality: "imaging",
    unitKind: "brick", sourceSnapshotSha256: "b".repeat(64), sourceUrls: ["https://portal.nersc.gov/"], accessUrl: "https://portal.nersc.gov/",
    notes: "Official Legacy DR5 coadd roster.", cells: new Map([[cell, []]]),
  }]);
  assert.equal([...diskIndex.units(legacyAlias!, [cell])].length, 1);
  diskIndex.close();

  const store = await SourceUnitStore.load(root, evidenceRoot, { readOnly: true, indexPath, buildKey: "a".repeat(64), lockText: "{}" });
  try {
    const match = store.match("decals-dr5-color-footprint", 4, [cell], 10, identity);
    assert.equal(match?.totalUnits, 1);
    assert.equal(match?.units[0]?.unitId, "1498p020");
    assert.match(match?.notes ?? "", /mixed-program.*does not isolate DECaLS-only/i);
    assert.deepEqual(match?.units[0]?.accessUris?.map(uri => uri.fileName), [
      "legacysurvey-1498p020-image-g.fits.fz",
      "legacysurvey-1498p020-image-r.fits.fz",
      "legacysurvey-1498p020-image-z.fits.fz",
    ]);
    const binding: NativeBinding = { productId: "decals-dr5", layerId: "decals-dr5-color-footprint", ...identity, modality: "imaging", unitKind: "brick",
      sourceIds: ["legacy-dr5-bricks", "legacy-brick-geometry"], revision: "", visibility: "published", selector: { bands: ["G", "R", "Z"] } };
    assert.equal(nativeBindingIndexRoute(binding), "source-unit");
    let surveyIndexQueries = 0;
    const surveyIndex = {
      hasBinding: () => false,
      sampleCells: () => { surveyIndexQueries++; throw new Error("Product has no locked survey-native source"); },
      lookup: () => { throw new Error("Survey index must not query Legacy-backed bindings"); },
    } as unknown as import("../server/survey-native-index.js").SurveyNativeIndex;
    verifyNativeRuntimeBindings([binding], store, surveyIndex);
    assert.equal(surveyIndexQueries, 0);
  } finally { store.close(); }
});

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

test("baseline adoption preserves installed bindings while new import-only survey sources await metadata", async t => {
  const f = await fixture(t);
  const source: NativeSource = { id: "gaia-dr3-file-partitions", revision: 1, surveyId: "gaia", releaseId: "gaia-dr3", title: "Gaia file partitions", adapter: "gaia-healpix-range", unitKind: "healpix-range", scope: "awaiting import", files: [], slot: "survey", updatedAt: "2026-10-03T00:00:00Z", sourceUrl: "https://gaia.eu-1.cdn77-storage.com/?prefix=Gaia/gdr3/gaia_source/&delimiter=/" };
  const binding: NativeBinding = { productId: "gaia", layerId: "gaia-dr3-main-source-presence", surveyId: "gaia", releaseId: "gaia-dr3", product: "Gaia DR3 main source presence", unitKind: "healpix-range", sourceIds: [source.id], revision: "", visibility: "published" };
  const result = await runNativeUnitWorker({ ...f.request, active: undefined, operation: { kind: "native-unit", operation: "baseline", actor: "fixture", submittedAt: source.updatedAt }, sources: [...f.sources, source], bindings: [...f.group.bindings, binding] });
  assert.deepEqual(result.group!.bindings.map(binding => binding.layerId), f.group.bindings.map(binding => binding.layerId));
  assert.equal(result.group!.generic!.file.sha256, f.group.generic!.file.sha256);
  assert.equal(result.group!.snapshots[source.id], undefined);
  assert.ok(result.group!.report.checks.every(check => check.passed));
});

test("build completion persists a verification report when the candidate group already exists", async t => {
  const f = await fixture(t);
  const store = new FilesystemArtifactStore(path.join(f.root, "var/object-store"));
  const options = { contentRoot: path.join(f.root, "content"), catalogRoot: f.root, evidenceRoot: f.evidenceRoot, store,
    bindings: async () => f.group.bindings, changed: async () => {}, verifyRuntime: async () => {} };
  const controller = new NativeUnitController(options); await controller.initialize();
  const queue = new PublicationTaskStore(path.join(f.root, "tasks.sqlite")); t.after(() => queue.close()); controller.attachQueue(queue);

  const baseline = await controller.submit({ operation: "baseline", expectedActive: null }, "fixture");
  const baselineTask = queue.claim<NativeWorkerRequest>()!;
  assert.equal(baselineTask.id, baseline.id);
  await controller.complete(baselineTask, { group: f.group }, queue);

  const selection = await controller.changeBindings(f.group.id, {
    digest: groupReviewDigest(f.group), productIds: ["pdr3"],
  }, "fixture") as { id: string; bindings: NativeBinding[] };
  const build = await controller.submit({ operation: "build", groupId: selection.id, expectedActive: null,
    snapshotIds: [f.snapshots["hsc-pdr3-patches"]!.id] }, "fixture");
  const buildTask = queue.claim<NativeWorkerRequest>()!;
  assert.equal(buildTask.id, build.id);

  await controller.complete(buildTask, { group: { ...f.group, id: selection.id, bindings: selection.bindings } }, queue);
  const persisted = await controller.detail(selection.id) as { report: NativeGroup["report"]; review?: unknown };
  assert.deepEqual(persisted.report.checks, f.group.report.checks);
  assert.equal(persisted.review, undefined);
});

test("identical native candidates show the active generation and cannot be reviewed again", async t => {
  const f = await fixture(t);
  const contentRoot = path.join(f.root, "comparison-content");
  await mkdir(path.join(contentRoot, "native-units"), { recursive: true });
  const candidate = { ...structuredClone(f.group), id: "identical-candidate" };
  await writeFile(path.join(contentRoot, "native-units/state.json"), JSON.stringify({
    schemaVersion: 1,
    sources: f.sources,
    snapshots: Object.values(f.snapshots),
    groups: [f.group, candidate],
    active: f.group.id,
    generation: 13,
    history: [],
    tasks: {},
  }));
  const controller = new NativeUnitController({ contentRoot, catalogRoot: f.root, evidenceRoot: f.evidenceRoot,
    store: new FilesystemArtifactStore(path.join(f.root, "comparison-store")), bindings: async () => f.group.bindings,
    changed: async () => {}, verifyRuntime: async () => {} });
  await controller.initialize();

  const view = controller.view() as {
    groups: Array<{
      id: string;
      comparison: { baseline: { groupId: string; generation: number } | null; hasChanges: boolean | null };
    }>;
  };
  const displayed = view.groups.find(group => group.id === candidate.id)!;
  assert.deepEqual(displayed.comparison.baseline, { groupId: f.group.id, generation: 13 });
  assert.equal(displayed.comparison.hasChanges, false);
  await assert.rejects(controller.review(candidate.id, { digest: groupReviewDigest(candidate), acceptedGaps: candidate.report.gaps }, "fixture"), /no content changes/);
});

test("survey-native bindings skip legacy memberships and require their survey-native index", async t => {
  const f = await fixture(t);
  const bindings: NativeBinding[] = [
    { productId: "des-dr2", layerId: "des-dr2-g-band-imaging-moc", surveyId: "des", releaseId: "des-dr2", product: "g-band imaging", modality: "imaging", unitKind: "tile", sourceIds: [], revision: "", visibility: "published" },
    { productId: "spherex-qr2", layerId: "spherex-spherex-qr2-spherex-qr2-color-coverage-moc", surveyId: "spherex", releaseId: "spherex-qr2", product: "SPHEREx QR2 color coverage", modality: "infrared", unitKind: "image", sourceIds: [], revision: "", visibility: "published" },
    { productId: "ps1-dr1", layerId: "ps1-dr1-g", surveyId: "panstarrs", releaseId: "panstarrs-dr1", product: "DR1 g-band imaging", modality: "imaging", unitKind: "tile", sourceIds: [], revision: "", visibility: "published" },
    { productId: "iphas-dr2", layerId: "iphas-dr2-ha", surveyId: "iphas", releaseId: "iphas-dr2", product: "H-alpha imaging", modality: "imaging", unitKind: "ccd", sourceIds: [], revision: "", visibility: "published" },
    { productId: "rubin-firstlook", layerId: "rubin-firstlook-image", surveyId: "rubin", releaseId: "rubin-firstlook", product: "Rubin First Look imaging", modality: "imaging", unitKind: "image", sourceIds: [], revision: "", visibility: "published" },
    { productId: "akari-fis", layerId: "akari-fis-color", surveyId: "akari", releaseId: "akari-fis", product: "AKARI FIS color imaging", modality: "infrared", unitKind: "image", sourceIds: [], revision: "", visibility: "published" },
    { productId: "ztf-dr7", layerId: "ztf-dr7-g", surveyId: "ztf", releaseId: "ztf-dr7", product: "g-band imaging", modality: "imaging", unitKind: "image", sourceIds: [], revision: "", visibility: "published" },
  ];
  for (const binding of bindings) {
    const active = { ...f.group, bindings: [...f.group.bindings, binding] };
    await assert.rejects(
      runNativeUnitWorker({ ...f.request, active, bindings: active.bindings }),
      /New survey bindings require their locked native index/,
    );
  }
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
