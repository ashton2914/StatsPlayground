import type { ComponentType, ReactNode } from "react";

import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import type { DistributionGraphRole } from "@/graphCore/distributionAdapter";
import type { AnalysisDocumentByKind, AnalysisDocumentPatch, AnalysisKind } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

import type { AnalysisGraphRoleByKind } from "./analysisGraphPolicies";
import { analysisViewContracts } from "./analysisViewContracts";
import { DistributionAnalysisResults } from "./renderers/DistributionAnalysisResults";
import { FitYByXAnalysisResults } from "./renderers/FitYByXAnalysisResults";
import { FitModelAnalysisResults } from "./renderers/FitModelAnalysisResults";
import type { UseAnalysisExecutionRuntime } from "./useAnalysisExecution";

export interface AnalysisViewRuntime extends UseAnalysisExecutionRuntime {
  renderGraph?: (props: GraphRuntimeProps & { role: DistributionGraphRole | "main" }) => ReactNode;
}

export interface AnalysisKindViewProps<Kind extends AnalysisKind> {
  item: AnalysisDocumentByKind[Kind];
  dataset?: DatasetMeta | null;
  runtime?: AnalysisViewRuntime;
  canEditInputs?: boolean;
  onEditInputs?: () => void;
  onDefinitionChange?: (patch: AnalysisDocumentPatch) => void;
  onDatasetChanged?: () => Promise<void>;
  onGraphConfigChange?: (
    role: AnalysisGraphRoleByKind[Kind],
    graph: EmbeddedGraphConfig,
  ) => void;
}

export const analysisViewRegistry = {
  distribution: DistributionAnalysisResults,
  fitYByX: FitYByXAnalysisResults,
  fitModel: FitModelAnalysisResults,
} satisfies {
  [Kind in AnalysisKind]: ComponentType<AnalysisKindViewProps<Kind>>;
};

export { analysisViewContracts };