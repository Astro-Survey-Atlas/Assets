import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { ArtifactStore } from "./artifact-store.js";
import { nativeEvidencePath, type NativeFile } from "./native-unit-model.js";

export async function nativeFile(root: string, ref: string, expected?: Pick<NativeFile, "sha256" | "sizeBytes">): Promise<NativeFile> {
  const file = await realpath(nativeEvidencePath(root, ref));
  const boundary = await realpath(root);
  if (!file.startsWith(boundary + path.sep)) throw new Error("Evidence reference leaves the configured storage root");
  const hash = createHash("sha256"); let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); sizeBytes += chunk.length; }
  const sha256 = hash.digest("hex");
  if (expected && (expected.sha256 !== sha256 || (expected.sizeBytes > 0 && expected.sizeBytes !== sizeBytes))) throw new Error(`Metadata checksum mismatch: ${ref}`);
  return { ref, sha256, sizeBytes };
}

/** Compress storage bytes while retaining the original file identity and SHA. */
export async function archiveNativeFile(store: ArtifactStore, root: string, file: NativeFile, progress: (message: string) => void): Promise<NativeFile> {
  await nativeFile(root, file.ref, file);
  if (file.objectKey) {
    // Only a completed archive task adds this receipt to a managed version.
    // Reused immutable dependencies retain the prior full byte verification;
    // check their storage identity without downloading the inventory again.
    const object = await store.head(file.objectKey);
    const archived = file.archive ?? file;
    if (object?.sha256 === archived.sha256 && object.sizeBytes === archived.sizeBytes) return file;
  }
  const source = nativeEvidencePath(root, file.ref);
  let upload = file;
  if (file.archive || !file.objectKey && file.sizeBytes >= 1024 * 1024) {
    const handle = await open(source, "r"); const magic = Buffer.alloc(2);
    try { await handle.read(magic, 0, magic.length, 0); } finally { await handle.close(); }
    if (file.archive || magic[0] !== 0x1f || magic[1] !== 0x8b) {
      const cacheRef = `managed/native-units/archive-cache/${file.sha256}.gz`;
      const cache = nativeEvidencePath(root, cacheRef), temporary = `${cache}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(cache), { recursive: true });
      progress(`Compressing ${path.basename(file.ref)} (${file.sizeBytes} bytes)`);
      try { await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(temporary, { flags: "wx", mode: 0o600 })); await rename(temporary, cache); }
      finally { await rm(temporary, { force: true }); }
      upload = await nativeFile(root, cacheRef);
      if (file.archive && (upload.sha256 !== file.archive.sha256 || upload.sizeBytes !== file.archive.sizeBytes)) throw new Error("Compressed native evidence differs from its archive identity");
      if (!file.archive && upload.sizeBytes >= file.sizeBytes) upload = file;
    }
  }
  const compressed = upload !== file;
  const key = file.objectKey ?? `native-units/files/${upload.sha256}${compressed ? ".gz" : ""}`;
  progress(`Uploading and verifying ${path.basename(file.ref)} (${upload.sizeBytes} archive bytes)`);
  const object = await store.putFileImmutable(key, nativeEvidencePath(root, upload.ref), {
    contentType: "application/octet-stream", cacheControl: "no-store", multipart: true,
    onProgress: (uploaded, total) => progress(`Uploading ${path.basename(file.ref)}: ${uploaded}/${total} archive bytes; full remote verification remains pending`),
    metadata: { deliveryClass: "evidence", sourceSha256: file.sha256, ...(compressed ? { encoding: "gzip" } : {}) },
  });
  if (object.sha256 !== upload.sha256 || object.sizeBytes !== upload.sizeBytes) throw new Error("Native evidence object failed archive verification");
  return { ...file, objectKey: key, ...(compressed ? { archive: { encoding: "gzip" as const, sha256: upload.sha256, sizeBytes: upload.sizeBytes } } : {}) };
}

/** Restore in scratch, verify both hashes, and publish without overwriting an existing input. */
export async function restoreNativeFile(store: ArtifactStore, root: string, file: NativeFile): Promise<void> {
  try { await nativeFile(root, file.ref, file); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!file.objectKey) throw new Error("This native evidence file has not been archived");
  const scratchRef = `managed/native-units/restore/${randomUUID()}`;
  const encodedRef = `${scratchRef}.encoded`, decodedRef = `${scratchRef}.decoded`;
  const encoded = nativeEvidencePath(root, encodedRef), decoded = nativeEvidencePath(root, decodedRef);
  const destination = nativeEvidencePath(root, file.ref);
  await mkdir(path.dirname(encoded), { recursive: true });
  try {
    const object = await store.downloadToFile(file.objectKey, encoded);
    if (!object) throw new Error("Archived native evidence is missing");
    await nativeFile(root, encodedRef, file.archive ?? file);
    if (file.archive) {
      if (file.archive.encoding !== "gzip") throw new Error("Unsupported native archive encoding");
      await pipeline(createReadStream(encoded), createGunzip(), createWriteStream(decoded, { flags: "wx", mode: 0o600 }));
      await nativeFile(root, decodedRef, file);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    // A hard link cannot overwrite an input created concurrently.
    try { await link(file.archive ? decoded : encoded, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await nativeFile(root, file.ref, file); }
  } finally { await Promise.all([rm(encoded, { force: true }), rm(decoded, { force: true })]); }
}
