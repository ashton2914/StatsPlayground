import type { AnalysisDocumentByKind, AnalysisDocumentPatch, AnalysisKind } from "@/types/analysis";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

export type AnalysisGraphRoleByKind = {
  distribution: "overview";
  fitYByX: "main";
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
  fitYByX: {
    createPersistencePatch: (document, _role, graph, updatedAt) => ({
      patch: {
        presentation: {
          ...document.presentation,
          graph: structuredClone(graph),
        },
        updatedAt,
      },
      statisticalInputsChanged: false,
    }),
  },
} satisfies { [Kind in AnalysisKind]: AnalysisGraphPolicy<Kind> | null };

export function createAnalysisGraphPersistencePatch(
  document: AnalysisDocumentByKind["fitYByX"],
  role: AnalysisGraphRoleByKind["fitYByX"],
  graph: EmbeddedGraphConfig,
  updatedAt: string,
): AnalysisGraphPersistenceResult;
export function createAnalysisGraphPersistencePatch(
  document: AnalysisDocumentByKind["distribution"],
  role: AnalysisGraphRoleByKind["distribution"],
  graph: EmbeddedGraphConfig,
  updatedAt: string,
): AnalysisGraphPersistenceResult;
export function createAnalysisGraphPersistencePatch(
  document: AnalysisDocumentByKind["distribution"] | AnalysisDocumentByKind["fitYByX"],
  role: "overview" | "main",
  graph: EmbeddedGraphConfig,
  updatedAt: string,
): AnalysisGraphPersistenceResult {
  if (document.analysisKind === "distribution") {
    return analysisGraphPolicies.distribution.createPersistencePatch(document, role as "overview", graph, updatedAt);
  }
  return analysisGraphPolicies.fitYByX.createPersistencePatch(document, role as "main", graph, updatedAt);
}