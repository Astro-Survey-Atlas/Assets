import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/update_provenance_hashes.py", import.meta.url));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(root: string, sourceHash: string) {
  const inputs = {
    canonicalManifest: { path: "../../src/footprints/survey-footprints.json", sha256: "0".repeat(64) },
    sources: { path: "sources.json", sha256: "0".repeat(64) },
    rawMocIndex: { path: "raw/moc/index.json", sha256: sourceHash },
    rawGeometryIndex: { path: "raw/geometry/index.json", sha256: "b".repeat(64) },
  };
  const files = new Map<string, unknown>([
    ["src/footprints/survey-footprints.json", { footprints: [] }],
    ["artifacts/public-survey-footprints/sources.json", { releases: [] }],
    ["artifacts/public-survey-footprints/normalized/survey-footprints.json", { footprints: [] }],
    ["artifacts/public-survey-footprints/packages/catalog.json", { packages: [] }],
    ["artifacts/public-survey-footprints/provenance.json", {
      inputs, files: { manifest: {}, catalog: {}, packages: [] }, statistics: {},
    }],
  ]);
  for (const [relative, document] of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(document));
  }
  return inputs;
}

test("package metadata refresh preserves unavailable evidence identities without hydrating inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-package-provenance-"));
  try {
    const inputs = await fixture(root, "a".repeat(64));
    const output = execFileSync("python3", [script], {
      env: { ...process.env, ASSET_WORKTREE_ROOT: root }, encoding: "utf8", timeout: 10_000,
    });
    const base = path.join(root, "artifacts/public-survey-footprints");
    const result = JSON.parse(await readFile(path.join(base, "provenance.json"), "utf8"));
    assert.deepEqual(result.inputs.rawMocIndex, inputs.rawMocIndex);
    assert.deepEqual(result.inputs.rawGeometryIndex, inputs.rawGeometryIndex);
    assert.equal(result.files.catalog.sha256, digest(await readFile(path.join(base, "packages/catalog.json"))));
    assert.equal(result.inputs.sources.sha256, digest(await readFile(path.join(base, "sources.json"))));
    assert.match(output, /not locally verified/);
    await assert.rejects(access(path.join(base, "raw")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package metadata refresh rejects missing frozen evidence hashes without changing provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-package-provenance-"));
  try {
    await fixture(root, "unknown");
    const target = path.join(root, "artifacts/public-survey-footprints/provenance.json");
    const before = await readFile(target);
    assert.throws(() => execFileSync("python3", [script], {
      env: { ...process.env, ASSET_WORKTREE_ROOT: root }, stdio: "pipe", timeout: 10_000,
    }), /Missing frozen input checksum/);
    assert.deepEqual(await readFile(target), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
