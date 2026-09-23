import assert from "node:assert/strict";
import test from "node:test";

import { fallbackSurveyColor, surveyColorFor } from "../site/src/atlas/survey-colors.js";

test("survey colors preserve valid catalog values", () => {
  assert.equal(surveyColorFor("euclid", "#3B82F6"), "#3b82f6");
});

test("survey colors prefer a specific survey item over a stale generic layer color", () => {
  assert.equal(surveyColorFor("euclid", "#3b82f6", "#376b9b"), "#3b82f6");
  assert.equal(surveyColorFor("euclid", "#376b9b", "#3b82f6"), "#3b82f6");
});

test("survey colors replace generic-only fallbacks deterministically", () => {
  const first = fallbackSurveyColor("unclassified-survey");
  assert.equal(surveyColorFor("unclassified-survey", "#376b9b"), first);
  assert.equal(surveyColorFor("unclassified-survey", undefined), first);
  assert.equal(fallbackSurveyColor("unclassified-survey"), first);
  assert.notEqual(first, "#376b9b");
});
