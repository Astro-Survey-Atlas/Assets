import { FilesystemArtifactStore, createArtifactStoreFromProcess } from "../server/artifact-store.js";
import { ContentArchiveSync, namespaceRootFromProcess, type ContentArchiveNamespace } from "../server/content-archive.js";

function usage(): never {
  console.error("Usage: content-archive.ts <sync|restore|status|diff> <content|evidence> [--root <dir>] [--local <dir>] [--overwrite] [--snapshot <sha256>] [--include <regex>] [--all]");
  process.exit(2);
}

const [command, namespaceArgument] = process.argv.slice(2);
if (command !== "sync" && command !== "restore" && command !== "status" && command !== "diff") usage();
if (namespaceArgument !== "content" && namespaceArgument !== "evidence") usage();
const namespace = namespaceArgument as ContentArchiveNamespace;

const flags = process.argv.slice(4);
function flagValue(name: string): string | undefined {
  const index = flags.indexOf(name);
  return index >= 0 ? flags[index + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return flags.includes(name);
}

const rootOverride = flagValue("--root");
const localOverride = flagValue("--local");
const includePattern = flagValue("--include");
const snapshot = flagValue("--snapshot");
const store = localOverride
  ? new FilesystemArtifactStore(localOverride)
  : createArtifactStoreFromProcess(process.env, `/tmp/opencode/content-archive-${namespace}`);
if (!localOverride && store.kind !== "s3") {
  console.error("Object store is not configured; pass --local <dir> for a filesystem archive or set ASSETS_OBJECT_STORE_* variables.");
  process.exit(2);
}

const select = includePattern ? (relativePath: string): boolean => new RegExp(includePattern).test(relativePath) : undefined;
const archive = new ContentArchiveSync({
  store,
  root: rootOverride ? String(rootOverride) : namespaceRootFromProcess(namespace),
  namespace,
  ...(select ? { select } : {}),
});

if (command === "sync") {
  const result = await archive.snapshot();
  console.log(`${result.skipped ? "unchanged" : "published"} ${namespace} snapshot ${result.snapshot}: ${result.files} files, ${result.bytes} bytes, uploaded ${result.uploadedObjects}, unchanged ${result.unchangedObjects}`);
} else if (command === "restore") {
  const result = await archive.restore({ overwrite: hasFlag("--overwrite"), ...(snapshot ? { snapshot } : {}) });
  console.log(`restored ${namespace} snapshot ${result.snapshot}: ${result.restored} files written, ${result.skippedIdentical} identical, ${result.bytes} bytes`);
} else if (command === "status") {
  const pointer = await archive.readPointer();
  if (!pointer) {
    console.log(`${namespace}: no snapshot published`);
  } else {
    console.log(`${namespace}: snapshot ${pointer.snapshot}, ${pointer.files} files, ${pointer.bytes} bytes, updated ${pointer.updatedAt}`);
  }
} else {
  const diff = await archive.diff();
  console.log(`${namespace} diff vs ${diff.snapshot ?? "none"}: missing ${diff.missing.length}, changed ${diff.changed.length}, extra ${diff.extra.length}`);
  for (const filePath of [...diff.missing, ...diff.changed, ...diff.extra].slice(0, 40)) console.log(`  ${filePath}`);
  if (diff.missing.length + diff.changed.length + diff.extra.length > 40) console.log("  ...");
}
