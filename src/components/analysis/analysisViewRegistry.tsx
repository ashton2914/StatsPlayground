import type { ComponentType, ReactNode } from "react";

import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import type { DistributionGraphRole } from "@/graphCore/distributionAdapter";
import type { AnalysisDocumentByKind, AnalysisKind } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";

import type { AnalysisGraphRoleByKind } from "./analysisGraphPolicies";
import { analysisViewContracts } from "./analysisViewContracts";
import { DistributionAnalysisResults } from "./renderers/DistributionAnalysisResults";
import type { UseAnalysisExecutionRuntime } from "./useAnalysisExecution";

export interface AnalysisViewRuntime extends UseAnalysisExecutionRuntime {
  renderGraph?: (props: GraphRuntimeProps & { role: DistributionGraphRole }) => ReactNode;
}

export interface AnalysisKindViewProps<Kind extends AnalysisKind> {
  item: AnalysisDocumentByKind[Kind];
  dataset?: DatasetMeta | null;
  runtime?: AnalysisViewRuntime;
  canEditInputs?: boolean;
  onEditInputs?: () => void;
  onGraphConfigChange?: (
    role: AnalysisGraphRoleByKind[Kind],
    graph: EmbeddedGraphConfig,
  ) => void;
}

export const analysisViewRegistry = {
  distribution: DistributionAnalysisResults,
} satisfies {
  [Kind in AnalysisKind]: ComponentType<AnalysisKindViewProps<Kind>>;
};

export { analysisViewContracts };