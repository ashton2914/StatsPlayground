import type { FieldRef } from "../graphCore/types";

import type { DistributionAnalysisConfig, DistributionItem } from "./distribution";
import type { EmbeddedGraphConfig } from "./graphBuilder";
import type { FitYByXPersonality } from "./fitYByX";

export type AnalysisKind = "distribution" | "fitYByX";

export interface DistributionAnalysisPresentation {
  schemaVersion: 1;
  layout: "distribution-v1";
}

export interface FitYByXAnalysisPresentation {
  schemaVersion: 1;
  layout: "fit-y-by-x-v1";
  graph: EmbeddedGraphConfig;
}

export type AnalysisPresentation = DistributionAnalysisPresentation | FitYByXAnalysisPresentation;

export interface DistributionAnalysisDefinition {
  kind: "distribution";
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  graphs: DistributionItem["graphs"];
}

export interface FitYByXAnalysisDefinition {
  kind: "fitYByX";
  response: FieldRef;
  factor: FieldRef;
  personality: FitYByXPersonality;
  confidenceLevel: number;
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

export interface FitYByXAnalysisDocument {
  schemaVersion: 1;
  documentType: "analysis";
  id: string;
  name: string;
  analysisKind: "fitYByX";
  configRevision: number;
  source: { datasetId: string };
  definition: FitYByXAnalysisDefinition;
  presentation: FitYByXAnalysisPresentation;
  createdAt: string;
  updatedAt: string;
}

export type AnalysisDocument = DistributionAnalysisDocument | FitYByXAnalysisDocument;

export type AnalysisDocumentByKind = {
  [Document in AnalysisDocument as Document["analysisKind"]]: Document;
};

export type AnalysisDocumentPatch = Partial<Pick<
  AnalysisDocument,
  "name" | "definition" | "presentation" | "source" | "configRevision" | "updatedAt"
>>;