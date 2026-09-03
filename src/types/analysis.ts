import type { FieldRef } from "../graphCore/types";

import type { DistributionAnalysisConfig, DistributionItem } from "./distribution";

export type AnalysisKind = "distribution";

export interface AnalysisPresentation {
  schemaVersion: 1;
  layout: "distribution-v1";
}

export interface DistributionAnalysisDefinition {
  kind: "distribution";
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  graphs: DistributionItem["graphs"];
}

export interface AnalysisDocument {
  schemaVersion: 1;
  documentType: "analysis";
  id: string;
  name: string;
  analysisKind: "distribution";
  configRevision: number;
  source: { datasetId: string };
  definition: DistributionAnalysisDefinition;
  presentation: AnalysisPresentation;
  createdAt: string;
  updatedAt: string;
}