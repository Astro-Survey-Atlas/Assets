import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { reviewedFixture } from "./reviewed-fixture.js";
import { s3HttpFixture } from "./s3-http-fixture.js";
import { createArtifactStoreFromProcess, publishReleaseArchive } from "../server/artifact-store.js";
import { packageRelease } from "../scripts/release-archive.js";
import { uploadObjectRelease, activateObjectRelease } from "../server/object-release.js";

test("fresh CLI restore of schema-3 legacy members does not deadlock on importing its entrypoint", async () => {
  const f = await reviewedFixture();
  const s3 = await s3HttpFixture();
  try {
    const store = createArtifactStoreFromProcess(s3.env);
    const archive = await packageRelease({ root: f.root, outputPath: path.join(f.base, "base.tar.gz") });
    await publishReleaseArchive(archive, store);
    const objects = await uploadObjectRelease(f.root, f.root, store, f.manifest.bundle.sha256);
    await activateObjectRelease(store, objects, f.manifest.bundle.sha256);
    const target = path.join(f.base, "empty-cache");
    const child = spawn(process.execPath, ["dist/server/sync-release.js"], {
      env: { ...process.env, ...s3.env, ASSET_TARGET_ROOT: target }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const code = await new Promise<number | null>(resolve => child.on("exit", resolve));
      assert.equal(code, 0, output);
      const manifest = JSON.parse(await readFile(path.join(target, "current/artifacts/public-survey-footprints/release-manifest.json"), "utf8"));
      assert.equal(manifest.bundle.sha256, f.manifest.bundle.sha256);
    } finally { clearTimeout(timer); }
  } finally { await s3.close(); await rm(f.base, { recursive: true, force: true }); }
});
