import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Kernel-owned lock: works across PID namespaces and is released on process death.
 * The lock file must never be unlinked, otherwise contenders could lock different inodes.
 * Use on the role's local PVC, never as a distributed lease on object storage.
 */
export async function acquireLocalFileLock(file: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", file,
    "sh", "-c", "echo locked; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += String(bytes); });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(code === 75
        ? "Another release synchronization is already running"
        : `Cannot acquire local file lock (${code}): ${stderr}`)));
      child.stdout.once("data", () => resolve());
    });
    return async () => { child.stdin.end(); await exited; };
  } catch (error) {
    child.stdin.end();
    await exited;
    throw error;
  }
}

export async function withLocalFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const release = await acquireLocalFileLock(file);
  try { return await work(); } finally { await release(); }
}
