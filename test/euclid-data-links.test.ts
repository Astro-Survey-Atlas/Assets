import assert from "node:assert/strict";
import test from "node:test";

import { resolveEuclidQ1MerFile } from "../server/euclid-data-links.js";

test("Euclid Q1 MER filenames resolve to the official ESA file endpoint", () => {
  const link = resolveEuclidQ1MerFile(
    "EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-ACBD03_20241018T142710.276838Z_00.00.fits",
    { surveyId: "euclid", releaseId: "euclid-q1" },
  );
  assert.equal(link?.tileId, "102018211");
  assert.equal(link?.unitKind, "tile");
  assert.match(link?.downloadUrl ?? "", /eas\.esac\.esa\.int\/sas-dd\/data/);
  assert.equal(new URL(link!.downloadUrl).searchParams.get("FILE_NAME"), "EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211-ACBD03_20241018T142710.276838Z_00.00.fits");
  assert.equal(new URL(link!.downloadUrl).searchParams.get("RELEASE"), "q1");
});

test("the resolver rejects non-Q1 identities and unrelated filenames", () => {
  assert.equal(resolveEuclidQ1MerFile("EUC_MER_BGSUB-MOSAIC-VIS_TILE102018211.fits", { surveyId: "euclid", releaseId: "euclid-q2" }), undefined);
  assert.equal(resolveEuclidQ1MerFile("some-other-survey.fits", { surveyId: "euclid", releaseId: "euclid-q1" }), undefined);
});
