import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createArtifactStoreFromProcess, type ArtifactStore } from "../server/artifact-store.js";
import { parseCurrentPointer } from "../server/sync-release.js";

interface EvidencePointer {
  schemaVersion: 1;
  namespace: "evidence";
  snapshot: string;
  files: number;
  bytes: number;
  updatedAt: string;
}

export interface StorageSnapshotLock {
  schemaVersion: 1;
  createdAt: string;
  public: { key: string; sha256: string; bundleId: string; bundleSha256: string };
  authorityEvidence: { key: string; sha256: string; snapshot: string; files: number; bytes: number };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseEvidence(bytes: Uint8Array): EvidencePointer {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<EvidencePointer>;
  if (value.schemaVersion !== 1 || value.namespace !== "evidence" || typeof value.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshot) || !Number.isSafeInteger(value.files) || (value.files ?? -1) < 0 || !Number.isSafeInteger(value.bytes) || (value.bytes ?? -1) < 0 || typeof value.updatedAt !== "string") {
    throw new Error("Authority evidence pointer is invalid");
  }
  return value as EvidencePointer;
}

async function readObject(store: ArtifactStore, key: string): Promise<{ body: Buffer; sha256: string }> {
  const object = await store.get(key);
  if (!object) throw new Error(`Required object-store pointer is missing: ${key}`);
  const digest = sha256(object.body);
  if (object.sha256 && object.sha256 !== digest) throw new Error(`Object-store pointer checksum mismatch: ${key}`);
  return { body: object.body, sha256: digest };
}

export async function pinStorageSnapshots(outputDir: string, environment: NodeJS.ProcessEnv = process.env): Promise<StorageSnapshotLock> {
  const scopedEnvironment = { ...environment, ASSETS_OBJECT_STORE_REQUIRED: "1" };
  const store = createArtifactStoreFromProcess(scopedEnvironment);
  if (store.kind !== "s3") throw new Error("Snapshot pinning requires an S3-compatible object store");
  const publicKey = environment.ASSETS_PUBLIC_OBJECT_STORE_CURRENT_KEY?.trim() || "public/current.json";
  const authorityKey = environment.ASSETS_AUTHORITY_EVIDENCE_CURRENT_KEY?.trim() || "authority/evidence/current.json";
  const [publicObject, authorityObject] = await Promise.all([readObject(store, publicKey), readObject(store, authorityKey)]);
  const publicPointer = parseCurrentPointer(publicObject.body);
  const authorityPointer = parseEvidence(authorityObject.body);
  const lock: StorageSnapshotLock = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    public: { key: publicKey, sha256: publicObject.sha256, bundleId: publicPointer.bundle.id, bundleSha256: publicPointer.bundle.sha256 },
    authorityEvidence: { key: authorityKey, sha256: authorityObject.sha256, snapshot: authorityPointer.snapshot, files: authorityPointer.files, bytes: authorityPointer.bytes },
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "public-current.json"), publicObject.body, { mode: 0o600 }),
    writeFile(path.join(outputDir, "authority-evidence-current.json"), authorityObject.body, { mode: 0o600 }),
    writeFile(path.join(outputDir, "lock.json"), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 }),
  ]);
  return lock;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const outputDir = process.argv[2];
  if (!outputDir || outputDir.startsWith("-")) {
    console.error("Usage: pin-storage-snapshots.ts <output-dir>");
    process.exitCode = 2;
  } else {
    await pinStorageSnapshots(path.resolve(outputDir)).then((lock) => {
      console.log(`Pinned public bundle ${lock.public.bundleId} (${lock.public.bundleSha256}) and authority evidence snapshot ${lock.authorityEvidence.snapshot}`);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
