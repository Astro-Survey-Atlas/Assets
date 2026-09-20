import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicationRun } from "../server/public-release-publication.js";

// Run only after backend is stopped, exporting to a NEW directory for review.
// This does not overwrite the source PVC, queue, SQLite database or authority.
const [database, destination] = process.argv.slice(2);
if (!database || !destination) throw new Error("Usage: export-publication-rollback <tasks.sqlite> <new-output-directory>");
await mkdir(destination, { recursive: false });
const db = new DatabaseSync(database, { readOnly: true });
try {
  const rows = db.prepare("SELECT r.document,t.phase,t.result FROM run_records r LEFT JOIN tasks t ON t.id=r.id").all();
  for (const row of rows) {
    const run = JSON.parse(String(row.document)) as PublicationRun;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run.runId)) throw new Error("Invalid run identity");
    if (row.phase === "published" || row.phase === "site-pending") {
      const result = row.result ? JSON.parse(String(row.result)) : undefined;
      run.status = "published";
      if (result) { run.bundle = result.bundle; run.manifestKey = result.manifestKey; }
    } else if (row.phase && row.phase !== "failed") {
      run.status = "failed";
      run.error = "Backend stopped for rollback; explicit review-version retry required";
      run.recovery = { detectedAt: new Date().toISOString(), reason: run.error };
    }
    await writeFile(path.join(destination, `${run.runId}.json`), JSON.stringify(run, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  console.log(`Exported ${rows.length} publication records; original database unchanged`);
} finally { db.close(); }
