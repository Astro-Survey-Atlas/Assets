// Run from the deployed /app directory with the normal publisher environment.
// This maintenance operation republishes existing verified packages only. It
// neither reviews nor publishes editorial drafts, and preserves other surveys.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleAt = (name) => import(pathToFileURL(path.resolve('dist/server', `${name}.js`)).href);
const { createArtifactStoreFromProcess } = await moduleAt('artifact-store');
const { DynamicResourcePackageStore } = await moduleAt('resource-package-publication');
const { MocPublicationStore } = await moduleAt('moc-build');
const { ProductStore } = await moduleAt('products');
const { PublicReleasePublisher } = await moduleAt('public-release-publication');
const { StateSnapshotCoordinator, STATE_SNAPSHOT_NAMESPACES } = await moduleAt('state-snapshot');
const { UploadSpool } = await moduleAt('upload-spool');
const surveyIds = (process.env.ASSETS_REPAIR_SURVEY_ID || "").split(",");
if (!surveyIds.length || surveyIds.some((id) => !/^[a-z0-9-]+$/.test(id))) throw new Error('ASSETS_REPAIR_SURVEY_ID is required');
const contentRoot = process.env.ASSETS_CONTENT_ROOT || '/var/lib/assets-content';
const baselineRoot = process.env.ASSET_RELEASE_ROOT || '/data/current';
const spoolRoot = process.env.ASSETS_UPLOAD_SPOOL_ROOT || '/var/lib/assets-upload-spool';
const store = createArtifactStoreFromProcess();
const spool = new UploadSpool({ root: spoolRoot, store });
await spool.initialize();
const snapshots = new StateSnapshotCoordinator({ root: path.join(spoolRoot, 'state'), store, spool });
await snapshots.initialize(STATE_SNAPSHOT_NAMESPACES);
const packages = new DynamicResourcePackageStore(contentRoot, snapshots, baselineRoot);
const mocs = new MocPublicationStore(contentRoot, undefined, snapshots);
const products = new ProductStore(snapshots, contentRoot);
await packages.initialize(); await mocs.initialize(); await products.initialize(baselineRoot, []);
if (process.env.ASSETS_REPAIR_EXECUTE === '1' && process.env.ASSETS_REPAIR_HISTORY === '1') await packages.repairHistoricalReleases(baselineRoot);
const publisher = new PublicReleasePublisher({
  contentRoot, baselineRoot, store, snapshotSink: snapshots,
  loadPackages: {
    list: () => packages.list().filter((entry) => surveyIds.includes(entry.surveyId)),
    assets: () => packages.assets().filter((entry) => surveyIds.includes(entry.surveyId)),
  },
  loadPublications: () => mocs.list().filter((entry) => surveyIds.includes(entry.surveyId) && !products.list().some((product) => product.productId === entry.productId && product.retiredAt)),
  publicationFile: (file) => mocs.absolutePath(file),
  // No draft diffs: the candidate contains only immutable, already published bytes.
});
const plan = await publisher.plan();
console.log(JSON.stringify({ operation: 'repair-published-package', surveyIds, plan }));
if (process.env.ASSETS_REPAIR_EXECUTE !== '1') process.exit(0);
if ((await publisher.list()).some((run) => ['queued', 'building', 'uploading', 'verifying'].includes(run.status))) throw new Error('Another publication is active');
const queued = await publisher.submit({ planId: plan.planId, expectedBaselineSha256: plan.baselineBundle.sha256, surveyIds }, 'package-release-repair');
// Pause the ordinary release worker before running this maintenance command.
const claimed = await publisher.claimQueuedRun();
if (claimed !== queued.runId) throw new Error('Unexpected queued publication; stop and inspect the queue');
const run = await publisher.execute(queued.runId);
console.log(JSON.stringify({ run }));
if (run.status !== 'published') process.exitCode = 1;
