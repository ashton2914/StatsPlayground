import type { ReactNode } from "react";

import { GraphRuntime, type GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";

import { AnalysisFrame } from "./AnalysisFrame";

interface AnalysisGraphProps {
  title: ReactNode;
  runtimeProps: GraphRuntimeProps;
  renderGraph?: (props: GraphRuntimeProps) => ReactNode;
}

export function AnalysisGraph({ title, runtimeProps, renderGraph }: AnalysisGraphProps) {
  return (
    <AnalysisFrame title={title}>
      <div className="analysis-ui-graph-runtime">
        {renderGraph ? renderGraph(runtimeProps) : <GraphRuntime {...runtimeProps} />}
      </div>
    </AnalysisFrame>
  );
}