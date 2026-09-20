import { PublicReleasePublisher, type PublicationRun, type PublicationRunRepository } from "./public-release-publication.js";
import { MocPublicationStore } from "./moc-build.js";
import { DynamicResourcePackageStore } from "./resource-package-publication.js";
import type { FrozenPublication, ExecutorRequest } from "./publication-scheduler.js";

let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function call<T>(operation: string, value?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send?.({ id, operation, value });
  });
}
process.on("disconnect", () => process.exit(1));
process.on("message", (message: any) => {
  if (message.operation === "start") { void execute(message.value).catch(error => { console.error(error); process.exit(1); }); return; }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
});
async function execute(input: ExecutorRequest): Promise<void> {
  const frozen: FrozenPublication = input.frozen;
  const repository: PublicationRunRepository = {
    get: async () => input.run,
    list: async () => [],
    submit: async () => { throw new Error("Executor cannot submit tasks"); },
    write: async run => { await call("progress", run); },
  };
  const mocs = new MocPublicationStore(input.contentRoot);
  const publisher = new PublicReleasePublisher({
    contentRoot: input.contentRoot, baselineRoot: input.baselineRoot,
    loadProducts: () => frozen.products, loadPublications: () => frozen.publications,
    publicationFile: file => mocs.absolutePath(file),
    loadPackages: new DynamicResourcePackageStore(input.contentRoot),
    runRepository: repository, deferSiteVerification: true,
    activateCandidate: async (_store, candidate, baseline) => call("activate", { candidate, baseline }),
    publicationLeaseMs: 120_000,
  });
  const run: PublicationRun = await publisher.execute(input.run.runId);
  await call("finished", run);
  process.disconnect();
}
