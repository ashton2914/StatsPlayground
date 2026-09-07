import type { AnalysisDocument } from "@/types/analysis";
import type { DistributionItem } from "@/types/distribution";
import { allocateProjectBasename } from "@/utils/projectFileNaming";

export interface DistributionAnalysisMigrationInput {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
  distributions: DistributionItem[];
  distributionFolders: Record<string, string>;
}

export interface DistributionAnalysisMigrationResult {
  analyses: AnalysisDocument[];
  analysisFolders: Record<string, string>;
  migratedCount: number;
}

function allocateMigratedId(requested: string, occupied: Set<string>): string {
  if (!occupied.has(requested)) return requested;
  let suffix = 2;
  while (occupied.has(`${requested}-migrated-${suffix}`)) suffix += 1;
  return `${requested}-migrated-${suffix}`;
}

export function createDistributionAnalysisDocument(
  item: DistributionItem,
  updatedAt: string,
): AnalysisDocument {
  return {
    schemaVersion: 1,
    documentType: "analysis",
    id: item.id,
    name: item.name,
    analysisKind: "distribution",
    configRevision: 1,
    source: { datasetId: item.sourceDatasetId },
    definition: {
      kind: "distribution",
      responses: structuredClone(item.responses),
      weight: structuredClone(item.weight),
      frequency: structuredClone(item.frequency),
      by: structuredClone(item.by),
      analysis: structuredClone(item.analysis),
      graphs: structuredClone(item.graphs),
    },
    presentation: { schemaVersion: 1, layout: "distribution-v1" },
    createdAt: item.createdAt,
    updatedAt,
  };
}

export function migrateLegacyDistributions(
  input: DistributionAnalysisMigrationInput,
): DistributionAnalysisMigrationResult {
  const analyses = [...input.analyses];
  const analysisFolders = { ...input.analysisFolders };
  const occupiedIds = new Set(analyses.map((analysis) => analysis.id));
  const occupiedNames = analyses.map((analysis) => analysis.name);

  for (const distribution of input.distributions) {
    const id = allocateMigratedId(distribution.id, occupiedIds);
    const name = allocateProjectBasename(distribution.name, ".span", occupiedNames);
    analyses.push({
      ...createDistributionAnalysisDocument(distribution, distribution.createdAt),
      id,
      name,
    });
    occupiedIds.add(id);
    occupiedNames.push(name);

    const folder = input.distributionFolders[distribution.id];
    if (folder !== undefined) analysisFolders[id] = folder;
  }

  return {
    analyses,
    analysisFolders,
    migratedCount: input.distributions.length,
  };
}
