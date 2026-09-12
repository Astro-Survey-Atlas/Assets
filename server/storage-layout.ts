import path from "node:path";
import { mkdir } from "node:fs/promises";

import { projectRoot } from "./paths.js";

export interface StorageLayout {
  root: string;
  cacheRoot: string;
  scratchRoot: string;
  uploadsRoot: string;
}

function resolveStorageRoot(root: string): string {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) throw new Error("ASSETS_LOCAL_ROOT must not be a filesystem root");
  return resolved;
}

export function storageLayout(root: string): StorageLayout {
  const resolved = resolveStorageRoot(root);
  return {
    root: resolved,
    cacheRoot: path.join(resolved, "cache"),
    scratchRoot: path.join(resolved, "scratch"),
    uploadsRoot: path.join(resolved, "uploads"),
  };
}

export function storageLayoutFromProcess(
  environment: NodeJS.ProcessEnv = process.env,
  defaultRoot = path.join(projectRoot, ".assets-local"),
): StorageLayout {
  return storageLayout(environment.ASSETS_LOCAL_ROOT?.trim() || defaultRoot);
}

export async function ensureStorageLayout(layout: StorageLayout): Promise<StorageLayout> {
  await Promise.all([
    mkdir(layout.cacheRoot, { recursive: true }),
    mkdir(layout.scratchRoot, { recursive: true }),
    mkdir(layout.uploadsRoot, { recursive: true }),
  ]);
  return layout;
}
