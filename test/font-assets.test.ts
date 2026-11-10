import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

type Slice = { weight: number; slice: string; file: string; unicodeRange: string };
const manifest = async () => JSON.parse(await readFile("fonts-src/cjk-slices.json", "utf8")) as { slices: Slice[] };

test("public and admin styles load Simplified Chinese through unicode-range slices", async () => {
  const [siteStyles, adminStyles, faces, { slices }] = await Promise.all([
    readFile("site/src/styles.css", "utf8"),
    readFile("site/admin/styles.css", "utf8"),
    readFile("site/src/cjk-font-faces.css", "utf8"),
    manifest(),
  ]);
  assert.match(siteStyles, /^@import "\.\/cjk-font-faces\.css";/);
  assert.match(adminStyles, /^@import "\.\.\/src\/cjk-font-faces\.css";/);
  for (const styles of [siteStyles, adminStyles]) {
    assert.match(styles, /--font-mono:\s*"Atlas Mono",\s*"Atlas Sans CJK",\s*monospace/);
    assert.doesNotMatch(styles, /NotoSansSC-(?:Regular|Bold)\.woff2/);
    assert.doesNotMatch(styles, /NotoSansCJK-(?:Regular|Bold)\.ttc/);
  }
  assert.equal(faces.match(/@font-face/g)?.length, slices.length);
  for (const weight of [400, 700]) assert.ok(slices.some((s) => s.weight === weight && s.slice === "core"));
  for (const s of slices) {
    assert.match(s.file, /^NotoSansSC-(?:Regular|Bold)\.[a-z0-9-]+\.[0-9a-f]{8}\.woff2$/);
    assert.ok(faces.includes(`url("/fonts/cjk/${s.file}") format("woff2")`) && faces.includes(`font-weight: ${s.weight};`));
    assert.ok(faces.includes(`unicode-range: ${s.unicodeRange};`), `${s.file} unicode-range`);
    const bytes = await readFile(`site/public/fonts/cjk/${s.file}`);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2", `${s.file} must be a WOFF2 file`);
  }
  // The full fonts must not sit in the served tree.
  assert.equal(existsSync("site/public/fonts/NotoSansSC-Regular.woff2"), false);
  assert.equal(existsSync("site/public/fonts/NotoSansSC-Bold.woff2"), false);
});

test("slice cmaps equal the original cmap and match unicode-range", { skip: !existsSync("/tmp/fv/bin/python") && !process.env.CJK_FONT_PYTHON ? "needs a python with fonttools+brotli (CJK_FONT_PYTHON or /tmp/fv)" : false }, () => {
  const python = process.env.CJK_FONT_PYTHON ?? "/tmp/fv/bin/python";
  const result = spawnSync(python, ["-I", "scripts/validate_cjk_font_slices.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
