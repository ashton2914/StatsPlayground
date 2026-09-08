import type { AnalysisDocumentByKind, AnalysisKind } from "@/types/analysis";

export interface AnalysisKindDescriptor<Kind extends AnalysisKind> {
  identity: {
    analysisKind: Kind;
    definitionKind: AnalysisDocumentByKind[Kind]["definition"]["kind"];
  };
  schema: {
    document: AnalysisDocumentByKind[Kind]["schemaVersion"];
    presentation: AnalysisDocumentByKind[Kind]["presentation"]["schemaVersion"];
    layout: AnalysisDocumentByKind[Kind]["presentation"]["layout"];
  };
  locale: {
    title: string;
  };
  capabilities: {
    graphEditing: boolean;
    reportEmbedding: boolean;
  };
}

export const analysisKindDescriptors = {
  distribution: {
    identity: {
      analysisKind: "distribution",
      definitionKind: "distribution",
    },
    schema: {
      document: 1,
      presentation: 1,
      layout: "distribution-v1",
    },
    locale: {
      title: "distribution.title",
    },
    capabilities: {
      graphEditing: true,
      reportEmbedding: false,
    },
  },
  fitYByX: {
    identity: {
      analysisKind: "fitYByX",
      definitionKind: "fitYByX",
    },
    schema: {
      document: 1,
      presentation: 1,
      layout: "fit-y-by-x-v1",
    },
    locale: {
      title: "fitYByX.title",
    },
    capabilities: {
      graphEditing: true,
      reportEmbedding: true,
    },
  },
} satisfies { [Kind in AnalysisKind]: AnalysisKindDescriptor<Kind> };