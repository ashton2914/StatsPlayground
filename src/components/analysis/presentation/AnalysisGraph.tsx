import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { GraphRuntime, type GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";

import { AnalysisFrame } from "./AnalysisFrame";

export interface AnalysisGraphRuntimeSlot {
  key: string;
  runtimeProps: GraphRuntimeProps;
}

interface AnalysisGraphProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "className" | "style" | "title"> {
  title: ReactNode;
  runtimeProps?: GraphRuntimeProps;
  runtimeSlots?: AnalysisGraphRuntimeSlot[];
  contentClassName?: string;
  renderGraph?: (props: GraphRuntimeProps, slotKey?: string) => ReactNode;
}

export function AnalysisGraph({
  title,
  runtimeProps,
  runtimeSlots,
  contentClassName,
  renderGraph,
  ...frameProps
}: AnalysisGraphProps) {
  const slots = runtimeSlots ?? (runtimeProps ? [{ key: "graph", runtimeProps }] : []);

  return (
    <AnalysisFrame title={title} contentPadding="none" {...frameProps}>
      <div className={contentClassName ? `analysis-ui-graph-content ${contentClassName}` : "analysis-ui-graph-content"}>
        {slots.map((slot) => (
          <div className="analysis-ui-graph-runtime" data-graph-role={slot.key} key={slot.key}>
            {renderGraph
              ? renderGraph(slot.runtimeProps, slot.key)
              : <GraphRuntime {...slot.runtimeProps} />}
          </div>
        ))}
      </div>
    </AnalysisFrame>
  );
}