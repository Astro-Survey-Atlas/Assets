import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public styles use a standalone Simplified Chinese WOFF2 face", async () => {
  const [siteStyles, adminStyles] = await Promise.all([
    readFile("site/src/styles.css", "utf8"),
    readFile("site/admin/styles.css", "utf8"),
  ]);
  for (const styles of [siteStyles, adminStyles]) {
    assert.match(styles, /NotoSansSC-Regular\.woff2"\) format\("woff2"\)/);
    assert.match(styles, /NotoSansSC-Bold\.woff2"\) format\("woff2"\)/);
    assert.doesNotMatch(styles, /NotoSansCJK-(?:Regular|Bold)\.ttc/);
  }
  for (const file of ["site/public/fonts/NotoSansSC-Regular.woff2", "site/public/fonts/NotoSansSC-Bold.woff2"]) {
    const bytes = await readFile(file);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2", `${file} must be a WOFF2 file`);
  }
});
