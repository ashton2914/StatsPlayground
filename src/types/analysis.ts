import type { FieldRef } from "../graphCore/types";

import type { DistributionAnalysisConfig, DistributionItem } from "./distribution";
import type { EmbeddedGraphConfig } from "./graphBuilder";
import type {
  FitModelCenteringMethod,
  FitModelConstruct,
  FitModelLoadIssue,
  FitModelTerm,
} from "./fitModel";
import type { FitYByXPersonality } from "./fitYByX";
import type {
  HypothesisTestAnalysisDefinition,
  HypothesisTestAnalysisPresentation,
} from "./hypothesisTest";

export type AnalysisKind = "distribution" | "fitYByX" | "fitModel" | "hypothesisTest";

export interface DistributionAnalysisPresentation {
  schemaVersion: 1;
  layout: "distribution-v1";
}

export interface FitYByXAnalysisPresentation {
  schemaVersion: 1;
  layout: "fit-y-by-x-v1";
  graph: EmbeddedGraphConfig;
}

export interface FitModelAnalysisPresentation {
  schemaVersion: 1;
  layout: "fit-model-v1";
}

export type AnalysisPresentation =
  | DistributionAnalysisPresentation
  | FitYByXAnalysisPresentation
  | FitModelAnalysisPresentation
  | HypothesisTestAnalysisPresentation;

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

export interface FitModelAnalysisDefinition {
  kind: "fitModel";
  response: FieldRef;
  construct: FitModelConstruct;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  confidenceLevel: number;
  migrationIssue?: FitModelLoadIssue;
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

export interface FitModelAnalysisDocument {
  schemaVersion: 1;
  documentType: "analysis";
  id: string;
  name: string;
  analysisKind: "fitModel";
  configRevision: number;
  source: { datasetId: string };
  definition: FitModelAnalysisDefinition;
  presentation: FitModelAnalysisPresentation;
  createdAt: string;
  updatedAt: string;
}

export interface HypothesisTestAnalysisDocument {
  schemaVersion: 1;
  documentType: "analysis";
  id: string;
  name: string;
  analysisKind: "hypothesisTest";
  configRevision: number;
  source: { datasetId: string };
  definition: HypothesisTestAnalysisDefinition;
  presentation: HypothesisTestAnalysisPresentation;
  createdAt: string;
  updatedAt: string;
}

export type AnalysisDocument =
  | DistributionAnalysisDocument
  | FitYByXAnalysisDocument
  | FitModelAnalysisDocument
  | HypothesisTestAnalysisDocument;

export type AnalysisDocumentByKind = {
  [Document in AnalysisDocument as Document["analysisKind"]]: Document;
};

export type AnalysisDocumentPatch = Partial<Pick<
  AnalysisDocument,
  "name" | "definition" | "presentation" | "source" | "configRevision" | "updatedAt"
>>;