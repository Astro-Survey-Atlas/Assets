import { readFile } from "node:fs/promises";
import { syncReleaseFromObjectStore } from "./sync-release.js";
import path from "node:path";

import { createArtifactStoreFromProcess } from "./artifact-store.js";
import { DynamicResourcePackageStore } from "./resource-package-publication.js";
import { MocPublicationStore } from "./moc-build.js";
import { ProductStore } from "./products.js";
import { PublicReleasePublisher } from "./public-release-publication.js";
import { StateSnapshotCoordinator, STATE_SNAPSHOT_NAMESPACES } from "./state-snapshot.js";
import { UploadSpool } from "./upload-spool.js";

const contentRoot = process.env.ASSETS_CONTENT_ROOT ? path.resolve(process.env.ASSETS_CONTENT_ROOT) : "/var/lib/assets-content";
const baselineRoot = process.env.ASSET_RELEASE_ROOT ? path.resolve(process.env.ASSET_RELEASE_ROOT) : "/data/current";
const pollSeconds = Number(process.env.ASSETS_PUBLICATION_POLL_SECONDS ?? "5");
const pollMs = Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds * 1000 : 5000;
const publicationLeaseMs = Number(process.env.ASSETS_PUBLICATION_LEASE_MS ?? "600000");
const uploadSpoolRoot = process.env.ASSETS_UPLOAD_SPOOL_ROOT ? path.resolve(process.env.ASSETS_UPLOAD_SPOOL_ROOT) : "/var/lib/assets-upload-spool";
const objectStore = createArtifactStoreFromProcess();
const uploadSpool = new UploadSpool({ root: uploadSpoolRoot, store: objectStore });
await uploadSpool.initialize();
const stateSnapshots = new StateSnapshotCoordinator({ root: path.join(uploadSpoolRoot, "state"), store: objectStore, spool: uploadSpool });
await stateSnapshots.initialize(STATE_SNAPSHOT_NAMESPACES);

const mocPublicationStore = new MocPublicationStore(contentRoot, undefined, stateSnapshots);
const dynamicResourcePackages = new DynamicResourcePackageStore(contentRoot, stateSnapshots);
const products = new ProductStore(stateSnapshots, contentRoot);

await mocPublicationStore.initialize();
await dynamicResourcePackages.initialize();
await products.initialize(baselineRoot, []);

const publisher = new PublicReleasePublisher({
  contentRoot,
  baselineRoot,
  loadPublications: () => mocPublicationStore.list(),
  publicationFile: (file) => mocPublicationStore.absolutePath(file),
  loadPackages: dynamicResourcePackages,
  loadProducts: async () => (JSON.parse(await readFile(path.join(contentRoot,"product-content-v1.json"),"utf8")) as {products:import("./products.js").ProductRecord[]}).products,
  snapshotSink: stateSnapshots,
  publicationLeaseMs,
});

function log(message: string): void {
  console.log(`[release-publisher] ${new Date().toISOString()} ${message}`);
}

log(`worker started (contentRoot=${contentRoot}, baselineRoot=${baselineRoot}, uploadSpoolRoot=${uploadSpoolRoot}, poll=${pollMs}ms)`);

let syncedPointer = "";
for (;;) {
  let claimed = false;
  try {
    const uploads = await uploadSpool.processPending();
    const advanced = await stateSnapshots.reconcileUploaded(uploads.uploadedManifests);
    const reconciled = await uploadSpool.markReconciled(uploads.uploadedManifests.map((manifest) => manifest.uploadId));
    const cleaned = await uploadSpool.cleanupUploaded();
    if (uploads.uploaded.length || uploads.retryable.length || uploads.conflicts.length || uploads.quarantined.length || advanced.length || reconciled || cleaned) {
      log(`uploads scanned=${uploads.scanned} uploaded=${uploads.uploaded.length} retryable=${uploads.retryable.length} conflicts=${uploads.conflicts.length} quarantined=${uploads.quarantined.length} pointers=${advanced.length} reconciled=${reconciled} cleaned=${cleaned}`);
    }
    // Retry authority reconciliation even after a previous sync failure.
    const pointer = (await objectStore.get("public/current.json"))?.body.toString("utf8") ?? "";
    if(pointer !== syncedPointer){
      await syncReleaseFromObjectStore(objectStore,path.dirname(baselineRoot),{cleanup:false});
      syncedPointer=pointer;
    }
    for(const pending of (await publisher.list()).filter(r=>r.status==="published" && r.verification?.site.state==="pending").slice(0,3))await publisher.verifySite(pending.runId);
    const runId = await publisher.claimQueuedRun();
    if (runId) {
      claimed = true;
      log(`executing run ${runId}`);
      await mocPublicationStore.reload();

      await dynamicResourcePackages.reload();
      const finished = await publisher.execute(runId);
      if (finished.status === "published") await syncReleaseFromObjectStore(objectStore,path.dirname(baselineRoot),{cleanup:false});
      log(`run ${runId} finished status=${finished.status}${finished.error ? ` error=${finished.error}` : ` bundle=${finished.bundle?.sha256 ?? ""}`}`);
    }
  } catch (error) {
    log(`worker iteration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!claimed) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
