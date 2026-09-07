import type { AnalysisKind } from "@/types/analysis";

export const analysisReportPolicies = {
  distribution: null,
} satisfies Record<AnalysisKind, object | null>;