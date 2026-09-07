import type { FieldRef } from "../graphCore/types";

import type { DistributionAnalysisConfig, DistributionItem } from "./distribution";

export type AnalysisKind = "distribution";

export interface DistributionAnalysisPresentation {
  schemaVersion: 1;
  layout: "distribution-v1";
}

export type AnalysisPresentation = DistributionAnalysisPresentation;

export interface DistributionAnalysisDefinition {
  kind: "distribution";
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  graphs: DistributionItem["graphs"];
}

export interface DistributionAnalysisDocument {
  schemaVersion: 1;
  documentType: "analysis";
  id: string;
  name: string;
  analysisKind: "distribution";
  configRevision: number;
  source: { datasetId: string };
  definition: DistributionAnalysisDefinition;
  presentation: DistributionAnalysisPresentation;
  createdAt: string;
  updatedAt: string;
}

export type AnalysisDocument = DistributionAnalysisDocument;

export type AnalysisDocumentByKind = {
  [Document in AnalysisDocument as Document["analysisKind"]]: Document;
};

export type AnalysisDocumentPatch = Partial<Pick<
  AnalysisDocument,
  "name" | "definition" | "presentation" | "source" | "configRevision" | "updatedAt"
>>;