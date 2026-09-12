import path from "node:path";
import { fileURLToPath } from "node:url";

import { createArtifactStoreFromProcess } from "../server/artifact-store.js";
import { ensureStorageLayout, storageLayoutFromProcess } from "../server/storage-layout.js";
import { syncReleaseFromObjectStore } from "../server/sync-release.js";

interface HydrateOptions {
  root?: string;
  currentKey?: string;
  retainReleases?: number;
}

function parseArgs(argv: string[]): HydrateOptions {
  const options: HydrateOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root" || argument === "--current-key" || argument === "--retain") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--root") options.root = value;
      else if (argument === "--current-key") options.currentKey = value;
      else {
        const retain = Number(value);
        if (!Number.isSafeInteger(retain) || retain < 1) throw new Error("--retain must be a positive integer");
        options.retainReleases = retain;
      }
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: npm run hydrate -- [--root <local-root>] [--current-key <key>] [--retain <count>]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function hydrateRelease(argv = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = parseArgs(argv);
  const scopedEnvironment = { ...environment, ASSETS_OBJECT_STORE_REQUIRED: "1" };
  const layout = await ensureStorageLayout(options.root ? storageLayoutFromProcess({ ...scopedEnvironment, ASSETS_LOCAL_ROOT: options.root }) : storageLayoutFromProcess(scopedEnvironment));
  const store = createArtifactStoreFromProcess(scopedEnvironment, layout.scratchRoot);
  if (store.kind !== "s3") throw new Error("hydrate requires an S3-compatible object store");
  const synced = await syncReleaseFromObjectStore(store, layout.cacheRoot, {
    currentKey: options.currentKey,
    retainReleases: options.retainReleases ?? 1,
    cleanup: true,
    allowInstalledFallback: false,
  });
  console.log(`Hydrated release ${synced.bundle.id} (${synced.bundle.sha256}) into ${layout.cacheRoot}/${synced.installedTarget}`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await hydrateRelease().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
