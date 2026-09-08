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
  fitYByX: {
    presentationSchemaVersion: 1,
    presentationLayout: "fit-y-by-x-v1",
  },
  fitModel: {
    presentationSchemaVersion: 1,
    presentationLayout: "fit-model-v1",
  },
} satisfies { [Kind in AnalysisKind]: AnalysisViewContract<Kind> };