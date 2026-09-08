import type { AnalysisDocument } from "@/types/analysis";

import { normalizeLegacyFitModelAnalysis } from "./adapters";

export function migrateLegacyFitModels(input: {
  analyses: readonly AnalysisDocument[];
  analysisFolders: Readonly<Record<string, string>>;
  fitModels: readonly unknown[];
  fitModelFolders: Readonly<Record<string, string>>;
}): {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
  migratedCount: number;
  warnings: string[];
} {
  const analyses = [...input.analyses];
  const analysisFolders = { ...input.analysisFolders };
  const ids = new Set(analyses.map((analysis) => analysis.id));
  const warnings: string[] = [];
  let migratedCount = 0;

  for (const value of input.fitModels) {
    const updatedAt = typeof value === "object"
      && value !== null
      && typeof Reflect.get(value, "createdAt") === "string"
      ? Reflect.get(value, "createdAt") as string
      : "";
    const normalized = normalizeLegacyFitModelAnalysis(value, updatedAt);
    warnings.push(...normalized.warnings);
    if (!normalized.document || ids.has(normalized.document.id)) continue;
    analyses.push(normalized.document);
    ids.add(normalized.document.id);
    migratedCount += 1;
    const folder = input.fitModelFolders[normalized.document.id];
    if (folder !== undefined && analysisFolders[normalized.document.id] === undefined) {
      analysisFolders[normalized.document.id] = folder;
    }
  }

  return { analyses, analysisFolders, migratedCount, warnings };
}