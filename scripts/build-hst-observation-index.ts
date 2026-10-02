import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildHstObservationIndex, HstObservationIndex } from "../server/hst-observation-index.js";

async function main(): Promise<void> {
  const evidenceRoot = path.resolve(process.argv.slice(2).find((argument) => argument.startsWith("--evidence-root="))?.slice("--evidence-root=".length)
    ?? process.env.ASSETS_EVIDENCE_ROOT ?? "/var/lib/assets-evidence");
  const lockPath = path.resolve("src/layers/recipes/hst-public-image-observations.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as { status?: string; manifest?: { path?: string; sha256?: string } };
  if (lock.status !== "ready" || !lock.manifest?.path || !lock.manifest.sha256) {
    throw new Error("The checked-in HST metadata lock is not ready; acquire and review a complete snapshot first.");
  }
  const index = await buildHstObservationIndex(evidenceRoot, lock.manifest.path, lock.manifest.sha256);
  const indexPath = HstObservationIndex.indexPath(evidenceRoot, lock.manifest.sha256);
  const details = await stat(indexPath);
  console.info(JSON.stringify({ indexPath, sizeBytes: details.size, ...index.summary }, null, 2));
  index.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
