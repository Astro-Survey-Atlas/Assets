import path from "node:path";

import { DynamicResourcePackageStore } from "./resource-package-publication.js";
import { MocPublicationStore } from "./moc-build.js";
import { ProductStore } from "./products.js";
import { PublicReleasePublisher } from "./public-release-publication.js";

const contentRoot = process.env.ASSETS_CONTENT_ROOT ? path.resolve(process.env.ASSETS_CONTENT_ROOT) : "/var/lib/assets-content";
const baselineRoot = process.env.ASSET_RELEASE_ROOT ? path.resolve(process.env.ASSET_RELEASE_ROOT) : "/data/current";
const pollSeconds = Number(process.env.ASSETS_PUBLICATION_POLL_SECONDS ?? "5");
const pollMs = Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds * 1000 : 5000;

const mocPublicationStore = new MocPublicationStore(contentRoot);
const dynamicResourcePackages = new DynamicResourcePackageStore(contentRoot);
const products = new ProductStore();

await mocPublicationStore.initialize();
await dynamicResourcePackages.initialize();
await products.initialize(baselineRoot, []);

const publisher = new PublicReleasePublisher({
  contentRoot,
  baselineRoot,
  loadPublications: () => mocPublicationStore.list(),
  publicationFile: (file) => mocPublicationStore.absolutePath(file),
  loadPackages: dynamicResourcePackages,
  loadProducts: () => products.list(),
});

function log(message: string): void {
  console.log(`[release-publisher] ${new Date().toISOString()} ${message}`);
}

log(`worker started (contentRoot=${contentRoot}, baselineRoot=${baselineRoot}, poll=${pollMs}ms)`);

for (;;) {
  let claimed = false;
  try {
    const runId = await publisher.claimQueuedRun();
    if (runId) {
      claimed = true;
      log(`executing run ${runId}`);
      const finished = await publisher.execute(runId);
      log(`run ${runId} finished status=${finished.status}${finished.error ? ` error=${finished.error}` : ` bundle=${finished.bundle?.sha256 ?? ""}`}`);
    }
  } catch (error) {
    log(`worker iteration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!claimed) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
