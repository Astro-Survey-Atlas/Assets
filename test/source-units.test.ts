import assert from "node:assert/strict";
import test from "node:test";
import { legacyDr1ImageUrl, parseHscPatchFile } from "../server/source-units.js";

test("Legacy DR1 image URI uses the release-published NOAO archive location", () => {
  assert.equal(
    legacyDr1ImageUrl("1498p020", "g"),
    "ftp://archive.noao.edu/public/hlsp/decals/dr1/coadd/149/1498p020/decals-1498p020-image-g.fits",
  );
});

test("HSC tract/patch parser accepts official coordinates with whitespace before commas", () => {
  const content = [
    "Tract: 9812  Patch: 0,0  Center (RA, Dec): (149.507118993 , 1.48467782206)",
    "Tract: 9812  Patch: 0,0      Corner0 (RA, Dec): (149.600381219 , 1.39136228924)",
    "Tract: 9812  Patch: 0,0      Corner1 (RA, Dec): (149.413758093 , 1.39142133554)",
    "Tract: 9812  Patch: 0,0      Corner2 (RA, Dec): (149.413840978 , 1.57799734129)",
    "Tract: 9812  Patch: 0,0      Corner3 (RA, Dec): (149.600487771 , 1.577930368)",
    "Tract: 9812  Patch: 0,0      Corner4 (RA, Dec): (149.600381219 , 1.39136228924)",
  ].join("\n");

  const units = parseHscPatchFile(content, "hsc-pdr2", "DUD COSMOS", "snapshot-sha256", "https://hsc-release.mtk.nao.ac.jp/das_search/pdr2/");

  assert.equal(units.length, 1);
  assert.equal(units[0]?.unitId, "9812/0,0");
  assert.equal(units[0]?.unitKind, "tract/patch");
  assert.deepEqual([units[0]?.raDeg, units[0]?.decDeg], [149.507118993, 1.48467782206]);
  assert.equal(units[0]?.footprint?.length, 4);
  assert.equal(units[0]?.downloadUrl, "https://hsc-release.mtk.nao.ac.jp/das_search/pdr2/");
  assert.equal(units[0]?.sourceSnapshotSha256, "snapshot-sha256");
});
