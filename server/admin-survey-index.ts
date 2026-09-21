import type { PublicSurveyIndex } from "./surveys.js";
import type { PublicSurveyModality } from "./types.js";
import type { ProductRecord } from "./products.js";
import { isDeniedSurvey } from "./publication-policy.js";

/** Editorial inventory is independent of public release membership. Never use this for public APIs. */
export function adminInventoryIndex(index: PublicSurveyIndex, records: readonly ProductRecord[]): PublicSurveyIndex {
  const result = structuredClone(index);
  const seen = new Set(result.surveys.flatMap(s => s.releases.flatMap(r => r.products.map(p => p.productId))));
  for (const record of records) {
    if (seen.has(record.productId) || isDeniedSurvey(record.draft.surveyId)) continue;
    const draft = record.draft;
    let survey = result.surveys.find(s => s.id === draft.surveyId);
    if (!survey) {
      survey = {
        id: draft.surveyId, name: draft.publicSurvey?.name ?? draft.surveyId.toUpperCase(),
        mission: draft.publicSurvey?.mission ?? "后台登记 · 尚未公开",
        description: draft.publicSurvey?.description ?? "按产品登记身份归组；后台分组不代表已公开发布。",
        color: draft.publicSurvey?.color ?? "#82979e", modalities: [], releases: [], imageUrl: "", assets: [],
        statistics: { publicProducts: 0, acquired: 0, overviewOnly: 0, awaitingGeometry: 0, notApplicable: 0, footprintCells: 0 },
      };
      result.surveys.push(survey);
    }
    let release = survey.releases.find(r => r.id === draft.releaseId);
    if (!release) {
      release = { id: draft.releaseId, label: draft.publicRelease?.label ?? draft.releaseId,
        kind: draft.publicRelease?.kind ?? "collection", modalities: [], products: [] };
      survey.releases.push(release);
    }
    // Registration preserves the scientific identity; no guess based on a candidate title.
    const allowed: PublicSurveyModality[] = ["imaging", "spectroscopy", "photometry", "time-domain", "integral-field", "ultraviolet", "infrared", "catalog", "simulation"];
    const modality: PublicSurveyModality = draft.modality === "image" ? "imaging" : draft.modality === "spectrum" ? "spectroscopy"
      : allowed.includes(draft.modality as PublicSurveyModality) ? draft.modality as PublicSurveyModality : "catalog";
    if (!release.modalities.includes(modality)) release.modalities.push(modality);
    if (!survey.modalities.includes(modality)) survey.modalities.push(modality);
    release.products.push({ productId: record.productId, name: draft.name,
      modality,
      description: draft.publicDescription ?? "后台登记产品；请查看当前审核和发布状态。",
      status: draft.publicStatus ?? "awaiting_geometry", sourceUrl: draft.sourceUrl ?? draft.geometrySourceUrl ?? "" });
    seen.add(record.productId);
  }
  return result;
}
