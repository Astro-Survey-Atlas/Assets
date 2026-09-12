import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

import {
  isDeniedPackageId,
  isDeniedSurvey,
  isSanitizableControlDocument,
  sanitizeReleaseControlDocument,
} from "../server/publication-policy.js";

import { testArtifactRoot, testSourceRoot } from "./test-data-root.js";

type ControlDocumentCheck = {
  path: string;
  arrayKey: string;
  identityKey: string;
};

const CHECKS: ControlDocumentCheck[] = [
  { path: "src/surveys/survey-catalog.json", arrayKey: "surveys", identityKey: "id" },
  { path: "src/layers/layer-registry.json", arrayKey: "layers", identityKey: "surveyId" },
  { path: "artifacts/public-survey-footprints/packages/catalog.json", arrayKey: "packages", identityKey: "surveyId" },
];

test("publication policy sanitizes every control document that references denied surveys", async () => {
  for (const check of CHECKS) {
    assert.ok(
      isSanitizableControlDocument(check.path),
      `${check.path} must be a registered control document`,
    );
    const bytes = await readFile(check.path.startsWith("artifacts/public-survey-footprints/")
      ? join(testArtifactRoot, check.path.slice("artifacts/public-survey-footprints/".length))
      : join(testSourceRoot, check.path));
    const sanitized = sanitizeReleaseControlDocument(check.path, bytes);
    assert.ok(sanitized, `${check.path} references a denied survey and must change`);
    const document = JSON.parse(sanitized.toString("utf8")) as Record<string, unknown>;
    const entries = document[check.arrayKey] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, `${check.path} must keep non-denied entries`);
    for (const entry of entries) {
      assert.ok(
        !isDeniedSurvey(String(entry[check.identityKey] ?? "")),
        `${check.path} leaked a denied survey entry`,
      );
    }
  }

  for (const path of [
    "src/footprints/survey-footprints.json",
    "artifacts/public-survey-footprints/normalized/survey-footprints.json",
  ]) {
    const bytes = await readFile(path === "artifacts/public-survey-footprints/normalized/survey-footprints.json"
      ? join(testArtifactRoot, "normalized/survey-footprints.json")
      : join(testSourceRoot, path));
    const sanitized = sanitizeReleaseControlDocument(path, bytes);
    assert.ok(sanitized, `${path} references a denied survey and must change`);
    const document = JSON.parse(sanitized.toString("utf8")) as { footprints: Array<{ surveyId: string }> };
    assert.equal(document.footprints.filter((footprint) => isDeniedSurvey(footprint.surveyId)).length, 0);
  }

  const buildPlanPath = "src/layers/public-build-plan.json";
  const buildPlanBytes = await readFile(join(testSourceRoot, buildPlanPath));
  const sanitizedPlan = sanitizeReleaseControlDocument(buildPlanPath, buildPlanBytes);
  assert.ok(sanitizedPlan, `${buildPlanPath} references a denied survey and must change`);
  const plan = JSON.parse(sanitizedPlan.toString("utf8")) as { builds: Array<{ spec: string }> };
  assert.equal(plan.builds.filter((build) => /csst/i.test(build.spec)).length, 0);
});

test("publication policy denies csst survey and package ids but allows public surveys", () => {
  assert.ok(isDeniedSurvey("csst"));
  assert.ok(!isDeniedSurvey("gaia"));
  assert.ok(!isDeniedSurvey("sdss"));
  assert.ok(isDeniedPackageId("public-csst-footprints"));
  assert.ok(isDeniedPackageId("public-csst-footprints-3.0.0"));
  assert.ok(!isDeniedPackageId("public-gaia-footprints"));
});
