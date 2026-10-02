import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { acquireHstPublicImageSnapshot, parseHstMetadataRows } from "../scripts/acquire-hst-public-image-observations.js";
import { createArtifactStoreFromProcess } from "./artifact-store.js";
import { archiveNativeFile, nativeFile, restoreNativeFile } from "./native-unit-archive.js";
import { buildNativeDelta } from "./native-unit-delta.js";
import { HstObservationIndex } from "./hst-observation-index.js";
import { cellsForStcs } from "./hst-image-lookup.js";
import { inspectSourceUnitInput, SourceUnitStore } from "./source-units.js";
import { SOURCE_UNIT_DISK_INDEX_VERSION } from "./source-unit-disk-index.js";
import { getNativeSlot, setNativeSlot } from "./native-unit-sources.js";
import { acquireEroTargetSnapshot, parseEroTargetSnapshot } from "./ero-target-index.js";
import { bindingRevision, nativeDigest, nativeEvidencePath, nativeGroupId, nativeMetadataUrl, nativeNow, type NativeFile, type NativeGroup, type NativeReport, type NativeSnapshot, type NativeSource, type NativeWorkerRequest, type NativeWorkerResult } from "./native-unit-model.js";

type Document = Record<string, any>;
export { nativeFile } from "./native-unit-archive.js";

export function nativeDatabaseKey(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = new Map((db.prepare("SELECT key,value FROM cache_meta").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]));
    if (meta.get("schema_version") !== SOURCE_UNIT_DISK_INDEX_VERSION || !/^[a-f0-9]{64}$/.test(meta.get("build_key") ?? "")) throw new Error("Native index schema or build identity is incompatible");
    return meta.get("build_key")!;
  } finally { db.close(); }
}

async function hstSnapshot(root: string, source: NativeSource, manifestRef: string, snapshotRoot = ""): Promise<NativeSnapshot> {
  const manifestFile = await nativeFile(root, manifestRef, source.files[0]?.sha256 ? source.files[0] : undefined);
  const manifest = JSON.parse(await readFile(nativeEvidencePath(root, manifestRef), "utf8")) as Document;
  if (manifest.kind !== "mast-hst-public-image-observations" || !Array.isArray(manifest.pages) || manifest.pages.length !== manifest.pageCount) throw new Error("HST input is not a complete public CAOM metadata snapshot");
  const filters = manifest.query?.filters as Array<{ paramName: string; values: string[] }>;
  for (const [key, value] of [["obs_collection", "HST"], ["dataproduct_type", "image"], ["dataRights", "PUBLIC"]]) if (!filters?.some(filter => filter.paramName === key && filter.values?.length === 1 && filter.values[0] === value)) throw new Error("HST snapshot scope must be public HST images");
  const files = [manifestFile]; let rows = 0;
  for (const page of manifest.pages) {
    const ref = snapshotRoot ? `${snapshotRoot}/${page.path}` : page.path;
    files.push(await nativeFile(root, ref, page));
    const value = JSON.parse(gunzipSync(await readFile(nativeEvidencePath(root, ref)), { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8")) as Document;
    const data = parseHstMetadataRows(value) as Document[];
    if (data.length !== page.rows || value.paging?.page !== page.page || value.status !== "COMPLETE") throw new Error("HST metadata page is incomplete");
    const allowed = new Set(String(manifest.query.columns).split(",").map(column => column.trim()));
    for (const row of data) {
      if (row.obs_collection !== "HST" || row.dataproduct_type !== "image" || row.dataRights !== "PUBLIC" || !row.obsid || Object.keys(row).some(key => !allowed.has(key))) throw new Error("HST pages must contain only public image observation metadata");
    }
    rows += data.length;
  }
  if (rows !== manifest.rowCount) throw new Error("HST page row count disagrees with its locked manifest");
  return { id: nativeDigest({ sourceId: source.id, sourceRevision: source.revision, sha256: manifestFile.sha256 }), sourceId: source.id, sourceRevision: source.revision, sourceUrl: source.sourceUrl, capturedAt: manifest.capturedAt, scope: source.scope, files, rowCount: rows, hstRoot: snapshotRoot, hstManifest: snapshotRoot ? manifestRef.slice(snapshotRoot.length + 1) : manifestRef };
}

async function baselineSnapshot(request: NativeWorkerRequest, source: NativeSource): Promise<NativeSnapshot> {
  if (source.adapter === "hst-caom") return hstSnapshot(request.evidenceRoot, source, source.files[0]!.ref);
  if (source.adapter === "entrypoint") return acquireSnapshot({ ...request, source }, () => undefined);
  const files = await Promise.all(source.files.map(async file => ({ ...await nativeFile(request.evidenceRoot, file.ref, file), sourceUrl: file.sourceUrl })));
  const lock = JSON.parse(await readFile(path.join(request.catalogRoot, "src/layers/recipes/source-unit-indexes.lock.json"), "utf8")) as Document;
  const recipeText = source.adapter === "desi-tile" ? await readFile(path.join(request.catalogRoot, source.slot), "utf8") : undefined;
  let rowCount = 0;
  for (const file of files) rowCount += inspectSourceUnitInput(await readFile(nativeEvidencePath(request.evidenceRoot, file.ref)), source.adapter === "euclid-tap" ? "euclid" : source.adapter === "desi-tile" ? "desi" : source.adapter === "hsc-patch" ? "hsc" : "legacy").rows;
  return { id: nativeDigest({ sourceId: source.id, sourceRevision: source.revision, hashes: files.map(file => file.sha256), recipeText }), sourceId: source.id, sourceRevision: source.revision, capturedAt: nativeNow(), files, rowCount, scope: source.scope, sourceUrl: source.sourceUrl, ...(recipeText ? { recipeText } : source.slot !== "entrypoint" ? { patch: getNativeSlot(lock, source.slot) } : {}) };
}

async function downloadMetadata(url: URL, ref: string, root: string, init: RequestInit = {}): Promise<NativeFile> {
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Official metadata request returned HTTP ${response.status}`);
  const destination = nativeEvidencePath(root, ref); await mkdir(path.dirname(destination), { recursive: true });
  const staging = destination + ".part"; let size = 0;
  const budget = new Transform({ transform(chunk: Buffer, _encoding, done) { size += chunk.length; done(size > 512 * 1024 * 1024 ? new Error("Metadata response exceeded its 512 MiB budget") : null, chunk); } });
  await pipeline(Readable.fromWeb(response.body as any), budget, createWriteStream(staging, { flags: "wx", mode: 0o600 }));
  await rename(staging, destination);
  return { ...await nativeFile(root, ref), sourceUrl: url.href };
}

async function acquireSnapshot(request: NativeWorkerRequest, progress: (message: string) => void): Promise<NativeSnapshot> {
  const source = request.source!;
  const prefix = `managed/native-units/inputs/${request.taskId}`;
  if (source.adapter === "entrypoint") {
    let file: NativeFile;
    if (request.operation.importFiles) {
      if (request.operation.importFiles.length !== 1) throw new Error("Import one locked ERO target metadata document");
      const staged = request.operation.importFiles[0]!;
      file = await nativeFile(request.evidenceRoot, staged.ref, staged);
    } else {
      const ref = `${prefix}/euclid-ero-target-metadata.json`;
      const bytes = await acquireEroTargetSnapshot(progress);
      await mkdir(path.dirname(nativeEvidencePath(request.evidenceRoot, ref)), { recursive: true });
      await writeFile(nativeEvidencePath(request.evidenceRoot, ref), bytes, { flag: "wx", mode: 0o600 });
      file = await nativeFile(request.evidenceRoot, ref);
    }
    const index = parseEroTargetSnapshot(await readFile(nativeEvidencePath(request.evidenceRoot, file.ref), "utf8"), file.sha256);
    return { id: nativeDigest({ sourceId: source.id, sourceRevision: source.revision, sha256: file.sha256 }), sourceId: source.id,
      sourceRevision: source.revision, capturedAt: nativeNow(), sourceUrl: source.sourceUrl, scope: source.scope,
      files: [{ ...file, sourceUrl: source.sourceUrl }], rowCount: index.targets.length };
  }
  if (source.adapter === "hst-caom") {
    if (request.operation.operation === "import") {
      const manifest = request.operation.importFiles?.[0];
      if (!manifest || request.operation.importFiles?.length !== 1) throw new Error("Import one HST manifest with all locked pages staged beneath the evidence root");
      await nativeFile(request.evidenceRoot, manifest.ref, manifest);
      const suffix = "source-units/hst-public-image-pages/manifest.json";
      if (!manifest.ref.endsWith(suffix)) throw new Error("HST manifest must retain its relative page directory layout");
      const prefix = manifest.ref.slice(0, -suffix.length).replace(/\/$/, "");
      return hstSnapshot(request.evidenceRoot, { ...source, files: [manifest] }, manifest.ref, prefix);
    }
    const root = nativeEvidencePath(request.evidenceRoot, prefix);
    await acquireHstPublicImageSnapshot(root, { concurrency: 2, progress });
    const fresh = { ...source, files: [] };
    return hstSnapshot(request.evidenceRoot, fresh, `${prefix}/source-units/hst-public-image-pages/manifest.json`, prefix);
  }
  const activeLock = JSON.parse(request.active?.lockText ?? await readFile(path.join(request.catalogRoot, "src/layers/recipes/source-unit-indexes.lock.json"), "utf8")) as Document;
  const oldPatch = getNativeSlot(activeLock, source.slot);
  const files: NativeFile[] = [];
  const imported = request.operation.importFiles;
  if (imported && imported.length !== source.files.length) throw new Error("Imported file count must match the source recipe");
  for (let index = 0; index < source.files.length; index++) {
    const file = source.files[index]!;
    const metadataUrl = nativeMetadataUrl(file.sourceUrl ?? source.sourceUrl, source.adapter);
    let frozen: NativeFile;
    if (imported) frozen = await nativeFile(request.evidenceRoot, imported[index]!.ref, imported[index]!);
    else {
      const ref = `${prefix}/${index}-${path.basename(file.ref)}`;
      let init: RequestInit | undefined;
      if (source.adapter === "euclid-tap") {
        if (!source.query || !/^SELECT\s/i.test(source.query) || !/FROM\s+q1\.mosaic_product\s/i.test(source.query) || /;|\b(?:INSERT|UPDATE|DELETE|DROP)\b/i.test(source.query)) throw new Error("Euclid acquisition requires a reviewed Q1 metadata query");
        const selected = /^SELECT\s+(.+?)\s+FROM\s/i.exec(source.query)?.[1]?.split(",").map(column => column.trim().toLowerCase());
        const columns = new Set(["tile_index", "file_name", "file_path", "datalabs_path", "stc_s", "data_set_release", "published", "instrument_name", "filter_name", "product_type"]);
        if (!selected?.length || selected.some(column => !columns.has(column)) || !/data_set_release\s*=\s*'Q1_R1'/i.test(source.query) || !/file_name\s+LIKE\s+'EUC_MER_BGSUB-MOSAIC-%'/i.test(source.query)) throw new Error("The Euclid adapter accepts explicit Q1_R1 BGSUB metadata columns and its declared inventory scope");
        init = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ REQUEST: "doQuery", LANG: "ADQL", FORMAT: "csv", QUERY: source.query }) };
      }
      frozen = await downloadMetadata(metadataUrl, ref, request.evidenceRoot, init);
    }
    files.push({ ...frozen, sourceUrl: metadataUrl.href }); progress(`Metadata ${index + 1}/${source.files.length} validated`);
  }
  let patch: Document | undefined; let recipeText: string | undefined;
  const counts: number[] = [];
  for (const file of files) counts.push(inspectSourceUnitInput(await readFile(nativeEvidencePath(request.evidenceRoot, file.ref)), source.adapter === "euclid-tap" ? "euclid" : source.adapter === "desi-tile" ? "desi" : source.adapter === "hsc-patch" ? "hsc" : "legacy").rows);
  const rowCount = counts.reduce((sum, count) => sum + count, 0);
  const asLock = (file: NativeFile): Document => ({ path: file.ref, sha256: file.sha256, sizeBytes: file.sizeBytes, sourceUrl: file.sourceUrl });
  if (source.adapter === "desi-tile") {
    const recipe = JSON.parse(request.active?.recipes[source.slot] ?? await readFile(path.join(request.catalogRoot, source.slot), "utf8")) as Document;
    recipe.input = `artifacts/public-survey-footprints/raw/${files[0]!.ref}`;
    recipe.snapshot = { ...recipe.snapshot, ...asLock(files[0]!) };
    recipeText = JSON.stringify(recipe);
  } else if (oldPatch?.regions) patch = { ...oldPatch, regions: oldPatch.regions.map((region: Document, index: number) => ({ ...region, snapshot: asLock(files[index]!), observedRows: counts[index] })) };
  else if (source.adapter === "hsc-patch") patch = { ...oldPatch, sourceFiles: oldPatch.sourceFiles.map((file: Document, index: number) => ({ ...file, ...asLock(files[index]!) })) };
  else patch = { ...oldPatch, snapshot: asLock(files[0]!), ...(source.adapter === "euclid-tap" ? { snapshotQuery: source.query } : {}) };
  // Raw row counts belong to the new snapshot; old release statistics are not copied as new evidence.
  if (patch) { delete patch.observedRows; delete patch.observedTileCount; delete patch.observedQ1R1ProductGroups; }
  return { id: nativeDigest({ sourceId: source.id, sourceRevision: source.revision, hashes: files.map(file => file.sha256), recipeText }), sourceId: source.id, sourceRevision: source.revision, capturedAt: nativeNow(), files, scope: source.scope, sourceUrl: source.sourceUrl, rowCount, ...(patch ? { patch } : {}), ...(recipeText ? { recipeText } : {}) };
}

async function verifyGroup(request: NativeWorkerRequest, group: NativeGroup, progress: (message: string) => void): Promise<NativeReport> {
  const start = Date.now(); const report: NativeReport = { checks: [], counts: {}, gaps: ["candidate-files-unverified"], samples: [] };
  for (const snapshot of Object.values(group.snapshots)) {
    for (const file of snapshot.files) await nativeFile(request.evidenceRoot, file.ref, file);
    if (snapshot.rowCount !== undefined) report.counts[snapshot.sourceId] = snapshot.rowCount;
  }
  report.checks.push({ id: "input-hashes", passed: true, detail: "All locked metadata inputs match their SHA-256 and byte count" });
  for (const binding of group.bindings) for (const sourceId of binding.sourceIds) if (!group.snapshots[sourceId]) throw new Error(`Product binding ${binding.layerId} has no locked input: ${sourceId}`);
  if (group.generic) {
    await nativeFile(request.evidenceRoot, group.generic.file.ref, group.generic.file);
    const store = await SourceUnitStore.load(request.catalogRoot, request.evidenceRoot, { readOnly: true, indexPath: nativeEvidencePath(request.evidenceRoot, group.generic.file.ref), buildKey: group.generic.buildKey, lockText: group.lockText, recipes: group.recipes });
    const db = new DatabaseSync(nativeEvidencePath(request.evidenceRoot, group.generic.file.ref), { readOnly: true });
    try {
      report.counts.nativeMemberships = Number((db.prepare("SELECT count(*) AS total FROM source_layer_units").get() as { total: number }).total);
      report.counts.nativeGeometries = Number((db.prepare("SELECT count(*) AS total FROM source_geometries").get() as { total: number }).total);
      for (const binding of group.bindings.filter(binding => binding.surveyId !== "hst" && binding.unitKind !== "target")) {
        const identity = `identity:${[binding.surveyId, binding.releaseId, binding.product].map(encodeURIComponent).join("/")}`;
        const row = db.prepare(`SELECT g.coarse_pixel AS pixel FROM source_aliases a JOIN source_layers l ON l.layer_key=a.layer_key JOIN source_layer_units m ON m.layer_key=l.layer_key JOIN source_geometries g ON g.geometry_key=l.geometry_key AND g.unit_id=m.unit_id WHERE a.alias IN (?,?) LIMIT 1`).get(binding.layerId, identity) as { pixel: number } | undefined;
        if (!row) throw new Error(`No native membership exists for product binding ${binding.layerId}`);
        const match = store.match(binding.layerId, 4, [row.pixel], 3, binding);
        if (!match?.units.length) throw new Error(`Native geometry probe failed for ${binding.layerId}`);
        report.checks.push({ id: `binding:${binding.layerId}`, passed: true, detail: `${match.unitKind} identity and footprint can be queried at O4` });
        if (report.samples.length < 24) for (const unit of match.units.slice(0, 1)) report.samples.push({ layerId: binding.layerId, unitKind: unit.unitKind, unitId: unit.unitId, order: 4, cells: unit.matchingCells, precision: unit.geometryPrecision, uris: unit.accessUris?.map(uri => uri.url) ?? [unit.downloadUrl] });
      }
    } finally { db.close(); store.close(); }
  }
  if (group.hst) {
    await nativeFile(request.evidenceRoot, group.hst.file.ref, group.hst.file);
    const root = group.hst.root ? nativeEvidencePath(request.evidenceRoot, group.hst.root) : request.evidenceRoot;
    const index = await HstObservationIndex.open(root, group.hst.sourceSha256);
    const db = new DatabaseSync(nativeEvidencePath(request.evidenceRoot, group.hst.file.ref), { readOnly: true });
    try {
      report.counts.hstObservations = index.summary.observationCount;
      report.counts.hstExcludedRows = index.summary.excludedRows;
      if (index.summary.excludedRows) report.gaps.push("hst-unsupported-frames");
      report.checks.push({ id: "hst-local-index", passed: true, detail: `${index.summary.observationCount} observations; ${index.summary.excludedRows} rows retained as excluded evidence` });
      for (const binding of group.bindings.filter(binding => binding.surveyId === "hst")) {
        const instrument = binding.instrument ?? binding.product.match(/\b(ACS|WFC3)\b/i)?.[1];
        const observationId = binding.observationId ?? binding.layerId.match(/(?:observation|obs)-(\d+)$/)?.[1];
        if (!instrument && !observationId) throw new Error(`HST binding has no supported observation selector: ${binding.layerId}`);
        // Explicit observation identity is the selector, as in runtime lookup.
        // A published observation can be absent from a later public CAOM snapshot.
        const row = observationId
          ? db.prepare(`SELECT obsid, s_region AS sRegion FROM hst_observations WHERE obsid=? LIMIT 1`).get(observationId)
          : db.prepare(`SELECT obsid, s_region AS sRegion FROM hst_observations WHERE UPPER(instrument) LIKE ? AND (? IS NULL OR INSTR(',' || REPLACE(filters, ', ', ',') || ',', ',' || ? || ',') > 0) LIMIT 1`).get(`${instrument!.toUpperCase()}%`, binding.filters ?? null, binding.filters ?? null);
        const candidate = row as { sRegion: string; obsid: string } | undefined;
        if (!candidate) {
          (report.unavailableBindings ??= []).push(binding.layerId);
          report.gaps.push(`hst-binding-not-in-snapshot:${binding.layerId}`);
          report.checks.push({ id: `binding:${binding.layerId}`, passed: true, detail: "Published source identity is retained; this locked snapshot has no matching observation. Native lookup remains entrypoint-only for this binding." });
          continue;
        }
        const sampleCells = cellsForStcs(4, Array.from({ length: 12 * 4 ** 4 }, (_, pixel) => pixel), candidate.sRegion);
        const result = index.lookup(4, sampleCells, 1, candidate.obsid);
        const sample = result.observations.find(observation => observation.obsid === candidate.obsid);
        if (!sample) throw new Error(`HST geometry probe failed for ${binding.layerId}`);
        report.checks.push({ id: `binding:${binding.layerId}`, passed: true, detail: "Saved HST s_region resolves locally to an observation and its MAST entrypoint" });
        report.samples.push({ layerId: binding.layerId, unitKind: "observation", unitId: sample.obsid, order: 4, cells: sample.matchingCells, precision: "estimated", uris: [sample.productUrl], sRegion: sample.sRegion });
      }
    } finally { db.close(); index.close(); }
  }
  const eroSnapshot = group.snapshots["euclid-ero-targets"];
  if (eroSnapshot) {
    const file = eroSnapshot.files[0]!;
    const index = parseEroTargetSnapshot(await readFile(nativeEvidencePath(request.evidenceRoot, file.ref), "utf8"), file.sha256);
    report.counts.eroTargets = index.targets.length;
    report.counts.eroExcludedTargets = index.excludedTargets;
    if (index.excludedTargets) report.gaps.push("euclid-ero-footprint-association-missing");
    for (const binding of group.bindings.filter(binding => binding.unitKind === "target")) {
      const target = index.targets[0]!;
      const pixels = Array.from({ length: 12 * 4 ** 4 }, (_, pixel) => pixel);
      const matching = cellsForStcs(4, pixels, target.sRegion);
      if (!matching.length) throw new Error("ERO outreach footprint has no supported ICRS geometry");
      report.checks.push({ id: `binding:${binding.layerId}`, passed: true, detail: "Locked official target XML and ESA Sky outreach footprint; target identity is preserved" });
      report.samples.push({ layerId: binding.layerId, unitKind: "target", unitId: target.id, order: 4, cells: matching, precision: "estimated", uris: target.urls, sRegion: target.sRegion });
    }
  }
  if (Object.values(group.snapshots).some(snapshot => snapshot.sourceId === "euclid-q1-bgsub-tiles")) report.gaps.push("euclid-q1-partial-inventory");
  if (group.bindings.some(binding => binding.unitKind === "target")) report.gaps.push("euclid-ero-tile-inventory-missing");
  report.checks.push({ id: "public-boundary", passed: true, detail: "Only registered public survey metadata and explicit product bindings" });
  report.counts.unavailableProductBindings = report.unavailableBindings?.length ?? 0;
  report.elapsedMs = Date.now() - start;
  report.peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  progress("Input, index and product binding verification complete");
  return report;
}

export async function runNativeUnitWorker(request: NativeWorkerRequest, progress: (message: string) => void = () => undefined): Promise<NativeWorkerResult> {
  const operation = request.operation.operation;
  if (operation === "archive" || operation === "restore") {
    const group = structuredClone(request.active!);
    const store = createArtifactStoreFromProcess(process.env, path.join(request.catalogRoot, "var/object-store"));
    const files = [...Object.values(group.snapshots).flatMap(snapshot => snapshot.files), ...(group.generic ? [group.generic.file] : []), ...(group.hst ? [group.hst.file] : [])];
    const completed = new Map<string, Promise<NativeFile>>();
    let nextFile = 0, finished = 0;
    // Four streams bound compression/read buffers and avoid serial archive round trips.
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, files.length) }, async () => {
      while (nextFile < files.length) {
        const index = nextFile++, file = files[index]!;
        if (operation === "archive") {
          let pending = completed.get(file.sha256);
          if (!pending) {
            pending = archiveNativeFile(store, request.evidenceRoot, file, message => { if (file.sizeBytes >= 1024 * 1024 || index % 25 === 0) progress(message); });
            completed.set(file.sha256, pending);
          }
          const archived = await pending;
          file.objectKey = archived.objectKey;
          if (archived.archive) file.archive = archived.archive;
        } else await restoreNativeFile(store, request.evidenceRoot, file);
        finished++;
        if (finished === 1 || finished % 25 === 0 || finished === files.length) progress(`${operation === "archive" ? "Archived" : "Restored"} ${finished}/${files.length} metadata and index files`);
      }
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    if (operation === "restore") group.report = await verifyGroup(request, group, progress);
    return { group };
  }
  if (operation === "discover") {
    const url = nativeMetadataUrl(request.source!.sourceUrl, request.source!.adapter);
    const response = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok && ![400, 405].includes(response.status)) throw new Error(`Metadata source returned HTTP ${response.status}`);
    return { discovered: { sourceUrl: url.href, reachable: true, ...(response.headers.get("content-length") ? { sizeBytes: Number(response.headers.get("content-length")) } : {}) } };
  }
  if (operation === "acquire" || operation === "import") return { snapshot: await acquireSnapshot(request, progress) };
  if (operation === "verify") return { report: await verifyGroup(request, request.active!, progress) };

  const start = Date.now();
  const lockText = request.active?.lockText ?? await readFile(path.join(request.catalogRoot, "src/layers/recipes/source-unit-indexes.lock.json"), "utf8");
  const lock = JSON.parse(lockText) as Document; const recipes = { ...request.active?.recipes };
  const snapshots: Record<string, NativeSnapshot> = { ...request.active?.snapshots };
  if (operation === "baseline") for (const source of request.sources) { progress(`Locking ${source.title}`); snapshots[source.id] = await baselineSnapshot(request, source); }
  else for (const snapshot of request.snapshots) {
    const source = request.sources.find(source => source.id === snapshot.sourceId)!;
    snapshots[source.id] = snapshot;
    if (snapshot.recipeText) recipes[source.slot] = snapshot.recipeText;
    else if (snapshot.patch && source.slot !== "hst") setNativeSlot(lock, source.slot, snapshot.patch);
  }
  for (const snapshot of Object.values(snapshots)) if (snapshot.recipeText) recipes[request.sources.find(source => source.id === snapshot.sourceId)!.slot] = snapshot.recipeText;
  let generic = request.active?.generic;
  const nextLockText = operation === "baseline" ? lockText : JSON.stringify(lock);
  const genericChanged = !request.active || nativeDigest(JSON.parse(request.active.lockText)) !== nativeDigest(lock) || nativeDigest(request.active.recipes) !== nativeDigest(recipes);
  if (operation === "baseline") {
    const ref = "derived/source-unit-indexes/native-units.sqlite";
    generic = { file: await nativeFile(request.evidenceRoot, ref), buildKey: nativeDatabaseKey(nativeEvidencePath(request.evidenceRoot, ref)) };
  } else if (genericChanged) {
    const ref = `managed/native-units/indexes/${request.taskId}/native-units.sqlite`;
    progress("Building candidate SQLite from locked inventories; current index remains active");
    await buildNativeDelta(request, ref, nextLockText, recipes, progress);
    generic = { file: await nativeFile(request.evidenceRoot, ref), buildKey: nativeDatabaseKey(nativeEvidencePath(request.evidenceRoot, ref)) };
  }
  let hst = request.active?.hst;
  const hstSnapshotRecord = snapshots["hst-public-images"];
  if (hstSnapshotRecord && (!hst || hst.sourceSha256 !== hstSnapshotRecord.files[0]!.sha256)) {
    const root = hstSnapshotRecord.hstRoot ? nativeEvidencePath(request.evidenceRoot, hstSnapshotRecord.hstRoot) : request.evidenceRoot;
    const index = operation === "baseline" ? await HstObservationIndex.open(root, hstSnapshotRecord.files[0]!.sha256) : await HstObservationIndex.build(root, hstSnapshotRecord.hstManifest!, hstSnapshotRecord.files[0]!.sha256);
    index.close();
    const ref = path.relative(request.evidenceRoot, HstObservationIndex.indexPath(root, hstSnapshotRecord.files[0]!.sha256));
    hst = { file: await nativeFile(request.evidenceRoot, ref), root: hstSnapshotRecord.hstRoot ?? "", manifest: hstSnapshotRecord.hstManifest!, sourceSha256: hstSnapshotRecord.files[0]!.sha256 };
  }
  const bindings = request.bindings.map(binding => ({ ...binding, revision: bindingRevision(binding, snapshots) }));
  const candidate = { createdAt: nativeNow(), origin: operation === "baseline" ? "imported-baseline" as const : "managed-build" as const, generic, hst, lockText: nextLockText, recipes, snapshots, bindings, report: { checks: [], gaps: [], counts: {}, samples: [] } as NativeReport };
  const group: NativeGroup = { ...candidate, id: nativeGroupId(candidate) };
  group.report = await verifyGroup(request, group, progress);
  group.report.cacheHit = operation !== "baseline" && !genericChanged && request.active?.hst?.sourceSha256 === hst?.sourceSha256;
  group.report.elapsedMs = Date.now() - start;
  group.report.peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  return { group, noChange: group.id === request.active?.id };
}
