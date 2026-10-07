import { nativeBindingIndexRoute, surveyNativeBinding, type SurveyNativeIndex } from "./survey-native-index.js";
import type { NativeBinding } from "./native-unit-model.js";
import type { SourceUnitStore } from "./source-units.js";

export function verifyNativeRuntimeBindings(bindings: readonly NativeBinding[], store: SourceUnitStore, surveyIndex?: SurveyNativeIndex): void {
  for (const binding of bindings.filter(binding => surveyNativeBinding(binding))) {
    const route = nativeBindingIndexRoute(binding);
    if (route === "survey") {
      if (!surveyIndex?.hasBinding(binding)) throw new Error(`Product has no locked survey-native source: ${binding.layerId}`);
      const cells = surveyIndex.sampleCells(binding);
      if (cells.length && surveyIndex.lookup(binding, 4, cells.slice(0, 1), 1).units.length) continue;
    } else if (route === "source-unit") {
      const layer = store.coverageLayers().find(layer => layer.surveyId === "legacy-surveys" && layer.releaseId === "legacy-dr5" && layer.product === "Coadded imaging");
      const cell = layer?.cells.keys().next().value;
      const result = cell === undefined ? null : store.match(binding.layerId, 4, [cell], 1, binding);
      if (result?.units.some(unit => unit.unitKind === binding.unitKind)) continue;
    } else {
      throw new Error(`Native runtime has no index route for ${binding.layerId}`);
    }
  }
}
