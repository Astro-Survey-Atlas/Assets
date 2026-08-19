import { cp, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { loadCatalog } from "./catalog.js";

const sourceRoot = path.resolve(process.env.ASSET_SOURCE_ROOT ?? "/app/release");
const targetRoot = path.resolve(process.env.ASSET_TARGET_ROOT ?? "/data");
if (sourceRoot === targetRoot || targetRoot === "/") throw new Error("Unsafe public asset synchronization paths");

const source = await loadCatalog(sourceRoot);
const releaseName = source.manifest.bundle.sha256;
const releasesRoot = path.join(targetRoot, "releases");
const finalPath = path.join(releasesRoot, releaseName);
const stagingPath = path.join(releasesRoot, `.${releaseName}.${process.pid}.staging`);
await mkdir(releasesRoot, { recursive: true });

let installed = false;
try {
  const details = await lstat(finalPath);
  installed = details.isDirectory();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (!installed) {
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: true });
  for (const directory of ["artifacts", "docs", "src"]) await cp(path.join(sourceRoot, directory), path.join(stagingPath, directory), { recursive: true, force: false });
  await loadCatalog(stagingPath);
  await rename(stagingPath, finalPath);
}

const currentPath = path.join(targetRoot, "current");
const nextPath = path.join(targetRoot, `.current.${process.pid}`);
await rm(nextPath, { force: true });
await symlink(path.relative(targetRoot, finalPath), nextPath, "dir");
await rename(nextPath, currentPath).catch(async (error: NodeJS.ErrnoException) => {
  if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
  const current = await lstat(currentPath);
  if (!current.isSymbolicLink()) throw new Error("Refusing to replace a non-symlink public asset current path");
  await rm(currentPath);
  await rename(nextPath, currentPath);
});
const installedTarget = await readlink(currentPath);
console.log(`Published ${source.manifest.bundle.id} at ${installedTarget}`);

