import assert from "node:assert/strict";
import test from "node:test";

import { surveyMarkCode, surveyMarkMarkup } from "../site/src/survey-mark.js";

test("survey marks use stable identifiers for known missions and aliases", () => {
  assert.equal(surveyMarkCode("Euclid"), "EUC");
  assert.equal(surveyMarkCode("nancy-grace-roman-space-telescope"), "ROM");
});

test("unknown survey identifiers get a readable, markup-safe fallback", () => {
  assert.equal(surveyMarkCode("new survey 2030"), "NEWS");
  assert.equal(surveyMarkCode("!!!"), "ASA");
  const markup = surveyMarkMarkup('<script>alert("x")</script>');
  assert.match(markup, /<text[^>]*>SCRI<\/text>/);
  assert.doesNotMatch(markup, /<script>/);
});
