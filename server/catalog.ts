import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { inferredPublicAssetDeliveryClass, type PublicAssetManifest, type PublicAssetPreviewMode, type PublicAssetProjection, type PublicAssetRecord } from "./types.js";
import { isSanitizableControlDocument, sanitizeReleaseControlDocument } from "./publication-policy.js";

export interface LoadedCatalog {
  root: string;
  manifest: PublicAssetManifest;
  files: Map<string, { record: PublicAssetRecord; absolutePath: string }>;
}

const RELEASE_MANIFEST_PATH = "artifacts/public-survey-footprints/release-manifest.json";

/** Bundle identity covers the complete manifest records so delivery/API metadata changes rotate the archive key. */
export function publicReleaseBundleDigest(files: ReadonlyArray<PublicAssetRecord>): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
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
    if (record.deliveryClass !== undefined && record.deliveryClass !== "runtime" && record.deliveryClass !== "evidence") throw new Error(`Invalid delivery class: ${record.id}`);
    if (record.deliveryClass === "evidence") throw new Error(`Public release manifest must not contain evidence records: ${record.id}`);
    if (record.deliveryClass === "runtime" && inferredPublicAssetDeliveryClass(record) === "evidence") throw new Error(`Evidence asset cannot be marked runtime: ${record.id}`);
    const absolutePath = resolveInside(normalizedRoot, record.path);
    if (verifyFiles) {
      const details = await stat(absolutePath);
      if (!details.isFile()) throw new Error(`Public asset is not a regular file: ${record.id}`);
      let verified = details.size === record.sizeBytes && (await sha256(absolutePath)) === record.sha256;
      // Worktree equivalence: control documents keep denied-survey data on
      // disk while the release manifest records sanitized bytes. Accept the
      // on-disk document when its sanitized projection matches the record.
      if (!verified && isSanitizableControlDocument(record.path)) {
        const sanitized = sanitizeReleaseControlDocument(record.path, await readFile(absolutePath));
        verified = sanitized !== null
          && sanitized.length === record.sizeBytes
          && createHash("sha256").update(sanitized).digest("hex") === record.sha256;
      }
      if (!verified) throw new Error(`Public asset SHA-256 mismatch: ${record.id}`);
    }
    files.set(record.id, { record, absolutePath });
  }
  const bundleHash = publicReleaseBundleDigest(manifest.files);
  if (bundleHash !== manifest.bundle.sha256) throw new Error("Public asset bundle digest does not match the release manifest");
  return { root: normalizedRoot, manifest, files };
}

/** Reject release trees with missing, extra or unsafe members beyond the manifest and its own manifest record. */
export async function assertExactReleaseTree(root: string, catalog: LoadedCatalog): Promise<void> {
  const expected = new Set(catalog.manifest.files.map((record) => record.path.replaceAll("\\", "/")));
  expected.add(RELEASE_MANIFEST_PATH);
  // Optional runtime marker written by sync after a verified archive pull.
  const optional = new Set([".archive-sha256"]);
  const walk = async (directory: string, relative: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Release tree must not contain symlinks: ${child}`);
      if (entry.isDirectory()) found.push(...await walk(path.join(directory, entry.name), child));
      else if (entry.isFile()) found.push(child);
      else throw new Error(`Release tree contains an unsupported file type: ${child}`);
    }
    return found;
  };
  const actual = await walk(path.resolve(root), "");
  const actualSet = new Set(actual);
  for (const file of actual) if (!expected.has(file) && !optional.has(file)) throw new Error(`Release tree contains an unlisted file: ${file}`);
  for (const file of expected) if (!actualSet.has(file)) throw new Error(`Release tree is missing a listed file: ${file}`);
}

export function assetPreviewMode(mediaType: string): PublicAssetPreviewMode | undefined {
  const type = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (type === "application/json" || type === "application/xml" || type === "application/fits" || type === "application/zip" || type.startsWith("text/")) return "text";
  if (["image/png", "image/svg+xml", "image/webp"].includes(type)) return "image";
  return undefined;
}

export function publicManifest(catalog: LoadedCatalog, additionalRecords: PublicAssetRecord[] = []): Omit<PublicAssetManifest, "files"> & { files: PublicAssetProjection[] } {
  // The public projection must never list, count or link evidence-class
  // records. Evidence material stays on the evidence store and is simply
  // invisible to the browser-facing catalog.
  const known = new Set(catalog.manifest.files.map((record) => record.id));
  const files = [...catalog.manifest.files, ...additionalRecords.filter((record) => !known.has(record.id))]
    .filter((record) => inferredPublicAssetDeliveryClass(record) !== "evidence")
    .map((record) => ({ ...record, deliveryClass: "runtime" as const }));
  const runtimeBytes = files.reduce((sum, record) => sum + record.sizeBytes, 0);
  return {
    ...catalog.manifest,
    statistics: { ...catalog.manifest.statistics, packages: files.filter((record) => record.kind === "package").length, totalBytes: runtimeBytes, rawMocFiles: files.filter((record) => record.kind === "moc").length, runtimeBytes, evidenceBytes: 0 },
    files: files.map(({ path: _path, ...record }) => {
      const previewMode = assetPreviewMode(record.mediaType);
      return {
        ...record,
        downloadUrl: `/api/v1/assets/${encodeURIComponent(record.id)}/download`,
        ...(previewMode ? { previewUrl: `/api/v1/assets/${encodeURIComponent(record.id)}/preview`, previewMode } : {}),
      };
    }),
  };
}
