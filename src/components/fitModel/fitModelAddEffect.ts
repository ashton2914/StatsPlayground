import type { FitModelTerm } from "@/types/fitModel";

import {
  canonicalInteraction,
  canonicalizeFitModelTerms,
} from "./fitModelConfig";
import { MAX_FIT_MODEL_TERMS } from "./fitModelConstruct";

export type FitModelAddEffectError =
  | "selectAtLeastTwo"
  | "duplicateEffect"
  | "tooManyTerms";

export type FitModelAddEffectResult =
  | { ok: true; terms: FitModelTerm[]; addedTerm: FitModelTerm }
  | { ok: false; reason: FitModelAddEffectError };

export function addFitModelInteractionEffect(
  terms: readonly FitModelTerm[],
  selectedColumnNames: readonly string[],
): FitModelAddEffectResult {
  const selectedNames = [...new Set(selectedColumnNames)].sort((left, right) => {
    if (left === right) return 0;
    return canonicalInteraction(left, right)[0] === left ? -1 : 1;
  });
  if (selectedNames.length < 2) {
    return { ok: false, reason: "selectAtLeastTwo" };
  }

  const addedTerm = canonicalizeFitModelTerms([{
    kind: "interaction",
    columnNames: selectedNames as [string, string, ...string[]],
  }])[0];
  const canonicalTerms = canonicalizeFitModelTerms(terms);
  const duplicate = canonicalTerms.some((term) => (
    term.kind === "interaction"
    && term.columnNames.length === addedTerm.columnNames.length
    && term.columnNames.every((columnName, index) => columnName === addedTerm.columnNames[index])
  ));
  if (duplicate) {
    return { ok: false, reason: "duplicateEffect" };
  }
  if (canonicalTerms.length >= MAX_FIT_MODEL_TERMS) {
    return { ok: false, reason: "tooManyTerms" };
  }

  return {
    ok: true,
    terms: [...canonicalTerms, addedTerm],
    addedTerm,
  };
}
