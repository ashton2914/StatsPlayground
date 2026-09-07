import type { AnalysisDocumentByKind, AnalysisKind } from "@/types/analysis";

interface AnalysisViewContract<Kind extends AnalysisKind> {
  presentationSchemaVersion: AnalysisDocumentByKind[Kind]["presentation"]["schemaVersion"];
  presentationLayout: AnalysisDocumentByKind[Kind]["presentation"]["layout"];
}

export const analysisViewContracts = {
  distribution: {
    presentationSchemaVersion: 1,
    presentationLayout: "distribution-v1",
  },
} satisfies { [Kind in AnalysisKind]: AnalysisViewContract<Kind> };