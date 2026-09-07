import type { AnalysisDocumentByKind, AnalysisDocumentPatch, AnalysisKind } from "@/types/analysis";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

export type AnalysisGraphRoleByKind = {
  distribution: "overview";
};

export interface AnalysisGraphPersistenceResult {
  patch: AnalysisDocumentPatch;
  statisticalInputsChanged: false;
}

interface AnalysisGraphPolicy<Kind extends AnalysisKind> {
  createPersistencePatch: (
    document: AnalysisDocumentByKind[Kind],
    role: AnalysisGraphRoleByKind[Kind],
    graph: EmbeddedGraphConfig,
    updatedAt: string,
  ) => AnalysisGraphPersistenceResult;
}

export const analysisGraphPolicies = {
  distribution: {
    createPersistencePatch: (document, role, graph, updatedAt) => ({
      patch: {
        definition: {
          ...document.definition,
          graphs: { ...document.definition.graphs, [role]: graph },
        },
        updatedAt,
      },
      statisticalInputsChanged: false,
    }),
  },
} satisfies { [Kind in AnalysisKind]: AnalysisGraphPolicy<Kind> | null };

export function createAnalysisGraphPersistencePatch(
  document: AnalysisDocumentByKind["distribution"],
  role: AnalysisGraphRoleByKind["distribution"],
  graph: EmbeddedGraphConfig,
  updatedAt: string,
): AnalysisGraphPersistenceResult {
  return analysisGraphPolicies[document.analysisKind].createPersistencePatch(
    document,
    role,
    graph,
    updatedAt,
  );
}