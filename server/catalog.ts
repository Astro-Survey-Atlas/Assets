import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { PublicAssetManifest, PublicAssetPreviewMode, PublicAssetProjection, PublicAssetRecord } from "./types.js";

export interface LoadedCatalog {
  root: string;
  manifest: PublicAssetManifest;
  files: Map<string, { record: PublicAssetRecord; absolutePath: string }>;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function resolveInside(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error(`Unsafe public asset path: ${relativePath}`);
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Public asset escapes release root: ${relativePath}`);
  return absolutePath;
}

export async function loadCatalog(root: string, verifyFiles = true): Promise<LoadedCatalog> {
  const normalizedRoot = path.resolve(root);
  const manifestPath = path.join(normalizedRoot, "artifacts", "public-survey-footprints", "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PublicAssetManifest;
  if (manifest.schemaVersion !== 1 || !manifest.bundle?.sha256 || !Array.isArray(manifest.files)) throw new Error("Unsupported public asset release manifest");
  const files = new Map<string, { record: PublicAssetRecord; absolutePath: string }>();
  for (const record of manifest.files) {
    if (!record.id || files.has(record.id) || !/^[a-z0-9][a-z0-9-]*$/.test(record.id)) throw new Error(`Invalid or duplicate public asset ID: ${record.id}`);
    if (!/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1) throw new Error(`Invalid public asset checksum record: ${record.id}`);
    const absolutePath = resolveInside(normalizedRoot, record.path);
    if (verifyFiles) {
      const details = await stat(absolutePath);
      if (!details.isFile() || details.size !== record.sizeBytes) throw new Error(`Public asset size mismatch: ${record.id}`);
      if (await sha256(absolutePath) !== record.sha256) throw new Error(`Public asset SHA-256 mismatch: ${record.id}`);
    }
    files.set(record.id, { record, absolutePath });
  }
  const bundleHash = createHash("sha256").update(JSON.stringify(manifest.files.map(({ id, path: filePath, sizeBytes, sha256: digest }) => ({ id, path: filePath, sizeBytes, sha256: digest })))).digest("hex");
  if (bundleHash !== manifest.bundle.sha256) throw new Error("Public asset bundle digest does not match the release manifest");
  return { root: normalizedRoot, manifest, files };
}

export function assetPreviewMode(mediaType: string): PublicAssetPreviewMode | undefined {
  const type = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "application/json" || type === "application/fits" || type === "application/zip" || type.startsWith("text/")) return "text";
  if (["image/png", "image/svg+xml", "image/webp"].includes(type)) return "image";
  return undefined;
}

export function publicManifest(catalog: LoadedCatalog): Omit<PublicAssetManifest, "files"> & { files: PublicAssetProjection[] } {
  return {
    ...catalog.manifest,
    files: catalog.manifest.files.map(({ path: _path, ...record }) => {
      const previewMode = assetPreviewMode(record.mediaType);
      return {
        ...record,
        downloadUrl: `/api/v1/assets/${encodeURIComponent(record.id)}/download`,
        ...(previewMode ? { previewUrl: `/api/v1/assets/${encodeURIComponent(record.id)}/preview`, previewMode } : {}),
      };
    }),
  };
}
