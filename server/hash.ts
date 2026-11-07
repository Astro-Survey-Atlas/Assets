import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * SHA-256 helpers shared by release, evidence and archive code. Every helper
 * returns the same lowercase hex string as `createHash("sha256")...digest("hex")`,
 * so persisted checksums are unchanged. Strings are hashed as UTF-8.
 *
 * Callers that hash JSON keep their own serialisation: some canonicalise keys
 * and some do not, and switching between them would change stored digests.
 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Streams a file once and returns its byte length and SHA-256. */
export async function sha256FileDetails(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

export async function sha256File(filePath: string): Promise<string> {
  return (await sha256FileDetails(filePath)).sha256;
}
