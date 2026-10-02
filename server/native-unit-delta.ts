import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SourceUnitStore } from "./source-units.js";
import { nativeDigest, nativeEvidencePath, type NativeWorkerRequest } from "./native-unit-model.js";

/** Parse changed releases independently and merge them into an isolated SQLite copy.
 * The old database is never written, and rows are copied in SQLite rather than JS. */
export async function buildNativeDelta(request: NativeWorkerRequest, ref: string, lockText: string, recipes: Record<string, string>, progress: (message: string) => void): Promise<void> {
  const baseline = request.active?.generic;
  if (!baseline) throw new Error("Adopt a verified baseline before incremental native builds");
  const destination = nativeEvidencePath(request.evidenceRoot, ref);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(nativeEvidencePath(request.evidenceRoot, baseline.file.ref), destination);
  const changed = request.snapshots.filter(snapshot => snapshot.sourceId !== "hst-public-images" && snapshot.id !== request.active?.snapshots[snapshot.sourceId]?.id);
  const scopes = new Map<string, { surveyId: string; releaseId: string }>();
  for (const snapshot of changed) {
    const source = request.sources.find(source => source.id === snapshot.sourceId)!;
    if (source.adapter === "entrypoint") continue;
    if (source.adapter === "legacy-geometry") {
      for (const binding of request.bindings.filter(binding => binding.surveyId === "legacy-surveys")) scopes.set(`${binding.surveyId}/${binding.releaseId}`, { surveyId: binding.surveyId, releaseId: binding.releaseId });
    } else scopes.set(`${source.surveyId}/${source.releaseId}`, { surveyId: source.surveyId, releaseId: source.releaseId });
  }
  if (!scopes.size) throw new Error("No generic release changed in this build");
  let index = 0;
  const implementationKeys: string[] = [];
  for (const scope of scopes.values()) {
    const partial = path.join(path.dirname(destination), `delta-${index++}.sqlite`);
    progress(`Incremental native build ${index}/${scopes.size}: ${scope.surveyId} / ${scope.releaseId}`);
    const store = await SourceUnitStore.load(request.catalogRoot, request.evidenceRoot, { indexPath: partial, lockText, recipes, sourceScope: scope });
    if (!store.diskBacked) { store.close(); throw new Error("A changed release could not produce a complete locked delta index"); }
    store.close();
    const db = new DatabaseSync(destination);
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384;");
      db.prepare("ATTACH DATABASE ? AS delta").run(partial);
      implementationKeys.push(String((db.prepare("SELECT value FROM delta.cache_meta WHERE key='build_key'").get() as { value: string }).value));
      // Geometry keys in separately built databases are local identifiers.
      const prefix = `delta-${nativeDigest({ task: request.taskId, scope }).slice(0, 24)}-`;
      db.exec("BEGIN IMMEDIATE;");
      const aliases = db.prepare("SELECT DISTINCT current.layer_key AS key FROM source_aliases current JOIN delta.source_aliases next ON next.alias=current.alias").all() as Array<{ key: string }>;
      for (const { key } of aliases) {
        db.prepare("DELETE FROM source_layer_units WHERE layer_key=?").run(key);
        db.prepare("DELETE FROM source_aliases WHERE layer_key=?").run(key);
        db.prepare("DELETE FROM source_layers WHERE layer_key=?").run(key);
      }
      db.prepare(`INSERT INTO source_layers SELECT layer_key, ? || geometry_key, payload_kind, payload_context, layer_id, survey_id, release_id, product, coarse_order, max_unit_radius_deg, unit_kind, notes, source_snapshot_sha256 FROM delta.source_layers`).run(prefix);
      db.exec("INSERT INTO source_aliases SELECT * FROM delta.source_aliases; INSERT INTO source_layer_units SELECT * FROM delta.source_layer_units;");
      db.prepare("INSERT INTO source_geometries SELECT ? || geometry_key,coarse_pixel,unit_id,payload FROM delta.source_geometries").run(prefix);
      db.exec("INSERT OR REPLACE INTO coverage_layers SELECT * FROM delta.coverage_layers; COMMIT; DETACH DATABASE delta;");
    } catch (error) { try { db.exec("ROLLBACK;"); } catch {} throw error; }
    finally { db.close(); }
    await rm(partial);
  }
  const db = new DatabaseSync(destination);
  try {
    db.exec("PRAGMA cache_size=-16384; BEGIN IMMEDIATE;");
    db.exec("DELETE FROM source_geometries WHERE geometry_key NOT IN (SELECT DISTINCT geometry_key FROM source_layers);");
    db.prepare("UPDATE cache_meta SET value=? WHERE key='build_key'").run(nativeDigest({ baseline: baseline.file.sha256, lock: JSON.parse(lockText), recipes, implementationKeys }));
    db.exec("COMMIT;");
    const result = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (result.quick_check !== "ok") throw new Error("Incremental candidate SQLite failed integrity verification");
  } finally { db.close(); }
}
