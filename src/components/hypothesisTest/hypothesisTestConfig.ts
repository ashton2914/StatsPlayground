import type {
  HypothesisTestAnalysisDefinition,
  HypothesisTestMethodId,
} from "@/types/hypothesisTest";
import { HYPOTHESIS_TEST_METHOD_IDS } from "@/types/hypothesisTest";

export type HypothesisTestConfigError =
  | "responseMustBeContinuous"
  | "conditionMustBeCategorical"
  | "duplicateRole"
  | "pairedSubjectRequired"
  | "atLeastTwoMeasurementsRequired"
  | "measurementsMustBeContinuous"
  | "duplicateMeasurement"
  | "manualMethodRequired"
  | "automaticMethodForbidden"
  | "manualMethodIncompatible"
  | "invalidAlpha"
  | "invalidConfidenceLevel"
  | "invalidReferenceLevel"
  | "oneSidedOmnibusUnsupported";

export interface HypothesisTestMethodCompatibility {
  methodId: HypothesisTestMethodId;
  compatible: boolean;
  reasonCode: "compatible" | "studyDesignMismatch" | "conditionCountMismatch";
}

function knownConditionCount(definition: HypothesisTestAnalysisDefinition): number | null {
  if (definition.roles.layout === "wide") return definition.roles.measurements.length;
  return definition.levelOrder.length >= 2 ? definition.levelOrder.length : null;
}

export function compatibleHypothesisTestMethods(
  definition: HypothesisTestAnalysisDefinition,
): HypothesisTestMethodCompatibility[] {
  const conditionCount = knownConditionCount(definition);
  const paired = definition.studyDesign === "pairedOrBlocked";
  return HYPOTHESIS_TEST_METHOD_IDS.map((methodId) => {
    const requiresPaired = methodId === "pairedT"
      || methodId === "wilcoxonSignedRank"
      || methodId === "randomizedBlockAnova"
      || methodId === "friedman";
    if (paired !== requiresPaired) {
      return { methodId, compatible: false, reasonCode: "studyDesignMismatch" };
    }
    const requiresTwo = methodId === "studentTwoSampleT"
      || methodId === "welchTwoSampleT"
      || methodId === "mannWhitneyU"
      || methodId === "pairedT"
      || methodId === "wilcoxonSignedRank";
    const countMatches = conditionCount == null
      || (requiresTwo ? conditionCount === 2 : conditionCount >= 3);
    return {
      methodId,
      compatible: countMatches,
      reasonCode: countMatches ? "compatible" : "conditionCountMismatch",
    };
  });
}

export function validateHypothesisTestDefinition(
  definition: HypothesisTestAnalysisDefinition,
): { ok: true } | { ok: false; code: HypothesisTestConfigError } {
  if (!(definition.alpha > 0 && definition.alpha < 1)) {
    return { ok: false, code: "invalidAlpha" };
  }
  if (!(definition.confidenceLevel > 0 && definition.confidenceLevel < 1)) {
    return { ok: false, code: "invalidConfidenceLevel" };
  }

  if (definition.roles.layout === "long") {
    if (definition.roles.response.type !== "continuous") {
      return { ok: false, code: "responseMustBeContinuous" };
    }
    if (definition.roles.condition.type !== "nominal"
      && definition.roles.condition.type !== "ordinal") {
      return { ok: false, code: "conditionMustBeCategorical" };
    }
    const roleNames = [
      definition.roles.response.name,
      definition.roles.condition.name,
      definition.roles.subject?.name,
    ].filter((name): name is string => name != null);
    if (new Set(roleNames).size !== roleNames.length) {
      return { ok: false, code: "duplicateRole" };
    }
    if (definition.studyDesign === "pairedOrBlocked" && definition.roles.subject == null) {
      return { ok: false, code: "pairedSubjectRequired" };
    }
  } else {
    if (definition.roles.measurements.length < 2) {
      return { ok: false, code: "atLeastTwoMeasurementsRequired" };
    }
    if (definition.roles.measurements.some((field) => field.type !== "continuous")) {
      return { ok: false, code: "measurementsMustBeContinuous" };
    }
    const measurementNames = definition.roles.measurements.map((field) => field.name);
    if (new Set(measurementNames).size !== measurementNames.length) {
      return { ok: false, code: "duplicateMeasurement" };
    }
    if (definition.roles.subject && measurementNames.includes(definition.roles.subject.name)) {
      return { ok: false, code: "duplicateRole" };
    }
  }

  if (definition.selectionMode === "automatic" && definition.manualSelection != null) {
    return { ok: false, code: "automaticMethodForbidden" };
  }
  if (definition.selectionMode === "manual" && definition.manualSelection == null) {
    return { ok: false, code: "manualMethodRequired" };
  }
  if (definition.manualSelection) {
    const selected = compatibleHypothesisTestMethods(definition)
      .find((entry) => entry.methodId === definition.manualSelection?.methodId);
    if (!selected?.compatible) return { ok: false, code: "manualMethodIncompatible" };
  }
  if (definition.referenceLevel != null
    && definition.levelOrder.length > 0
    && !definition.levelOrder.includes(definition.referenceLevel)) {
    return { ok: false, code: "invalidReferenceLevel" };
  }
  const conditionCount = knownConditionCount(definition);
  if (conditionCount != null && conditionCount >= 3 && definition.alternative !== "twoSided") {
    return { ok: false, code: "oneSidedOmnibusUnsupported" };
  }
  return { ok: true };
}