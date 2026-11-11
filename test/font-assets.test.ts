import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

type Slice = { weight: number; slice: string; file: string; unicodeRange: string; bytes: number; count: number; sha256: string };
type Manifest = { weights: Record<string, { file: string; bytes: number; codepoints: number; sha256: string; cmapSha256: string }>; slices: Slice[] };
const manifest = async () => JSON.parse(await readFile("fonts-src/cjk-slices.json", "utf8")) as Manifest;
const python = process.env.CJK_FONT_PYTHON ?? "python3";
const validator = resolve("scripts/validate_cjk_font_slices.py");
const generator = resolve("scripts/slice_cjk_font.py");
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function validate(root = resolve(".")) {
  return spawnSync(python, ["-I", validator, "--root", root], { encoding: "utf8" });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "assets-font-test-"));
  for (const path of ["fonts-src", "site/public/fonts/cjk", "site/src/cjk-font-faces.css"]) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    cpSync(path, join(root, path), { recursive: true });
  }
  return root;
}

function editManifest(root: string, mutate: (m: Manifest) => void) {
  const path = join(root, "fonts-src/cjk-slices.json");
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  mutate(m);
  writeFileSync(path, JSON.stringify(m));
}

test("public and admin styles load hash-verified unicode-range slices, never full CJK fonts", async () => {
  const [siteStyles, adminStyles, faces, { slices, weights }] = await Promise.all([
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
  assert.equal(slices.length, 90);
  assert.equal(faces.match(/@font-face/g)?.length, slices.length);
  for (const weight of [400, 700]) assert.ok(slices.some((s) => s.weight === weight && s.slice === "core"));
  for (const s of slices) {
    assert.match(s.file, /^NotoSansSC-(?:Regular|Bold)\.[a-z0-9-]+\.[0-9a-f]{8}\.woff2$/);
    const face = faces.split("\n").find((line) => line.includes(`/fonts/cjk/${s.file}`));
    assert.ok(face?.includes(`font-weight: ${s.weight};`) && face.includes(`unicode-range: ${s.unicodeRange};`));
    const bytes = await readFile(`site/public/fonts/cjk/${s.file}`);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2");
    assert.equal(bytes.length, s.bytes);
    assert.equal(digest(bytes), s.sha256);
    assert.ok(s.file.endsWith(`.${s.sha256.slice(0, 8)}.woff2`));
  }
  for (const source of Object.values(weights)) {
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.match(source.cmapSha256, /^[0-9a-f]{64}$/);
    assert.equal(source.codepoints, 44810);
  }
  for (const root of ["fonts-src", "site/public", "dist/site"]) {
    if (!existsSync(root)) continue;
    const files = readdirSync(root, { recursive: true }).map(String);
    assert.ok(!files.some((file) => /(?:^|\/)NotoSansSC-(?:Regular|Bold)\.woff2$/.test(file)), root);
  }
});

test("real Python cmap validation is mandatory (CJK_FONT_PYTHON or python3)", () => {
  const result = validate();
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}${result.stderr}\nInstall requirements/fonts.lock in the selected Python.`);
  assert.match(result.stdout, /90 slices/);
});

test("semantic validator rejects missing, mutated, misdeclared and incomplete slices", async (t) => {
  const cases: [string, (root: string) => void, RegExp][] = [
    ["missing file", (root) => {
      const m = JSON.parse(readFileSync(join(root, "fonts-src/cjk-slices.json"), "utf8")) as Manifest;
      rmSync(join(root, "site/public/fonts/cjk", m.slices[0]!.file));
    }, /slice file inventory mismatch/],
    ["mutated bytes", (root) => {
      const m = JSON.parse(readFileSync(join(root, "fonts-src/cjk-slices.json"), "utf8")) as Manifest;
      const path = join(root, "site/public/fonts/cjk", m.slices[0]!.file);
      const data = readFileSync(path);
      data[data.length - 1] = data[data.length - 1]! ^ 1;
      writeFileSync(path, data);
    }, /SHA256 mismatch/],
    ["wrong recorded size", (root) => editManifest(root, (m) => { m.slices[0]!.bytes++; }), /size mismatch/],
    ["wrong recorded cmap count", (root) => editManifest(root, (m) => { m.slices[0]!.count++; }), /cmap count mismatch/],
    ["wrong manifest range", (root) => editManifest(root, (m) => { m.slices[0]!.unicodeRange = "U+20"; }), /unicode-range != cmap/],
    ["wrong CSS range", (root) => {
      const path = join(root, "site/src/cjk-font-faces.css");
      writeFileSync(path, readFileSync(path, "utf8").replace(/unicode-range: [^;]+;/, "unicode-range: U+20;"));
    }, /CSS declaration mismatch/],
    ["duplicate CSS face", (root) => {
      const path = join(root, "site/src/cjk-font-faces.css");
      const css = readFileSync(path, "utf8");
      writeFileSync(path, css + css.split("\n")[1]);
    }, /duplicate CSS face/],
    ...["Regular", "Bold"].map((name): [string, (root: string) => void, RegExp] => [
      `${name} independent original fingerprint`,
      (root) => editManifest(root, (m) => { m.weights[name]!.cmapSha256 = "0".repeat(64); }),
      /union cmap fingerprint mismatch/,
    ]),
    ["same-count wrong cmap with self-consistent slice metadata and CSS", (root) => {
      const result = spawnSync(python, ["-I", "-c", `
import hashlib, json, runpy, sys
from pathlib import Path
from fontTools.ttLib import TTFont
root = Path(sys.argv[1])
helper = runpy.run_path(sys.argv[2])
path = root / "fonts-src/cjk-slices.json"
manifest = json.loads(path.read_text())
s = manifest["slices"][0]
old_file, old_range = s["file"], s["unicodeRange"]
font_path = root / "site/public/fonts/cjk" / old_file
with TTFont(font_path, recalcTimestamp=False) as font:
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap = {0x80 if c == 0x41 else c: glyph for c, glyph in table.cmap.items()}
    font.save(font_path)
data = font_path.read_bytes()
s.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
s["file"] = f'NotoSansSC-Regular.latin.{s["sha256"][:8]}.woff2'
font_path.rename(font_path.with_name(s["file"]))
s["unicodeRange"] = helper["ranges"](helper["read_cmap"](font_path.with_name(s["file"])))
assert s["count"] == len(helper["parse_ranges"](s["unicodeRange"]))
path.write_text(json.dumps(manifest))
css_path = root / "site/src/cjk-font-faces.css"
css_path.write_text(css_path.read_text().replace(old_file, s["file"]).replace(old_range, s["unicodeRange"], 1))
`, root, validator], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }, /union cmap fingerprint mismatch/],
    ["coherently removed slice", (root) => {
      let filename = "";
      editManifest(root, (m) => { filename = m.slices.pop()!.file; });
      rmSync(join(root, "site/public/fonts/cjk", filename));
      const path = join(root, "site/src/cjk-font-faces.css");
      writeFileSync(path, readFileSync(path, "utf8").split("\n").filter((line) => !line.includes(filename)).join("\n"));
    }, /union cmap count mismatch/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const root = fixture();
      try {
        mutate(root);
        const result = validate(root);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("generator --rescan updates the tiny character list and real core slices in a staged synthetic tree", () => {
  const root = fixture();
  const sourceDir = mkdtempSync(join(tmpdir(), "assets-font-synthetic-source-"));
  try {
    const setup = spawnSync(python, ["-I", "-c", `
import hashlib, json, sys
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
root, source_dir = map(Path, sys.argv[1:])
path = root / "fonts-src/cjk-slices.json"
manifest = json.loads(path.read_text())
cmap = {0x41: "A", 0x4E00: "one", 0x4E8C: "two", 0x4E09: "three"}
for name, source in manifest["weights"].items():
    builder = FontBuilder(1000, isTTF=True)
    glyph_order = [".notdef", *cmap.values()]
    builder.setupGlyphOrder(glyph_order)
    builder.setupCharacterMap(cmap)
    glyphs = {}
    for glyph in glyph_order:
        pen = TTGlyphPen(None)
        pen.moveTo((100, 0)); pen.lineTo((400, 0)); pen.lineTo((400, 600)); pen.closePath()
        glyphs[glyph] = pen.glyph()
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({glyph: (500, 0) for glyph in glyph_order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Synthetic CJK", "styleName": name})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.font.flavor = "woff2"
    output = source_dir / source["file"]
    builder.save(output)
    data = output.read_bytes()
    source.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), codepoints=len(cmap),
                  cmapSha256=hashlib.sha256("".join(f"{c:06X}\\n" for c in sorted(cmap)).encode("ascii")).hexdigest())
path.write_text(json.dumps(manifest))
(root / "fonts-src/site-used-chars.txt").write_text("一\\n")
(root / "site/src/rescan.ts").write_text('const text = "二";')
` , root, sourceDir], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const result = spawnSync(python, ["-I", generator, "--root", root, "--source-dir", sourceDir, "--rescan"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(root, "fonts-src/site-used-chars.txt"), "utf8"), "二\n");
    const generated = JSON.parse(readFileSync(join(root, "fonts-src/cjk-slices.json"), "utf8")) as Manifest;
    assert.equal(generated.slices.length, 6);
    assert.deepEqual(generated.slices.filter((s) => s.slice === "core").map((s) => s.unicodeRange), ["U+4E8C", "U+4E8C"]);
    assert.equal(readdirSync(join(root, "site/public/fonts/cjk")).length, 6);
    assert.ok(!readdirSync(root).some((file) => file.startsWith(".cjk-stage-")));
    const checked = validate(root);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("generator refuses absent/bad sources before changing any installed output", async (t) => {
  for (const mode of ["argument missing", "files missing", "bad size", "bad hash", "second source bad hash"]) {
    await t.test(mode, () => {
      const root = fixture();
      const sourceDir = mkdtempSync(join(tmpdir(), "assets-font-bad-source-"));
      try {
        const before = readdirSync(join(root, "site/public/fonts/cjk")).map((file) => [file, digest(readFileSync(join(root, "site/public/fonts/cjk", file)))]);
        if (mode === "second source bad hash") {
          // The first source passes byte verification but is not decodable. The error
          // must still be the SECOND source hash, proving all hashes precede decoding.
          const regular = Buffer.from("wOF2 first source is intentionally not decodable");
          writeFileSync(join(sourceDir, "NotoSansSC-Regular.woff2"), regular);
          writeFileSync(join(sourceDir, "NotoSansSC-Bold.woff2"), Buffer.alloc(12116992));
          editManifest(root, (m) => {
            m.weights.Regular!.bytes = regular.length;
            m.weights.Regular!.sha256 = digest(regular);
          });
        }
        const metadataBefore = readFileSync(join(root, "fonts-src/cjk-slices.json"));
        const cssBefore = readFileSync(join(root, "site/src/cjk-font-faces.css"));
        const charsBefore = readFileSync(join(root, "fonts-src/site-used-chars.txt"));
        if (mode === "bad size" || mode === "bad hash") {
          writeFileSync(join(sourceDir, "NotoSansSC-Regular.woff2"), Buffer.alloc(mode === "bad size" ? 4 : 11424252));
        }
        const args = ["-I", generator, "--root", root, "--rescan"];
        if (mode !== "argument missing") args.push("--source-dir", sourceDir);
        // An unrelated cwd must not be used as an implicit font source.
        const result = spawnSync(python, args, { encoding: "utf8", cwd: sourceDir });
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, mode === "argument missing" ? /required/ : mode === "files missing" ? /No such file/ : mode === "bad size" ? /source size mismatch/ : mode === "second source bad hash" ? /Bold: source SHA256 mismatch/ : /source SHA256 mismatch/);
        assert.deepEqual(readdirSync(join(root, "site/public/fonts/cjk")).map((file) => [file, digest(readFileSync(join(root, "site/public/fonts/cjk", file)))]), before);
        assert.deepEqual(readFileSync(join(root, "fonts-src/cjk-slices.json")), metadataBefore);
        assert.deepEqual(readFileSync(join(root, "site/src/cjk-font-faces.css")), cssBefore);
        assert.deepEqual(readFileSync(join(root, "fonts-src/site-used-chars.txt")), charsBefore);
        assert.ok(!readdirSync(root).some((file) => file.startsWith(".cjk-stage-")));
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
      }
    });
  }
});
