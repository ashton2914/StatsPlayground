import { useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { GraphRuntime, type GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import type { GraphPanelOptionFactory } from "@/graphCore";
import type { GraphBuilderItem } from "@/types/graphBuilder";

import { AnalysisFrame } from "./AnalysisFrame";

export type AnalysisGraphStrategy =
  | { mode: "builder"; runtimeProps: GraphRuntimeProps }
  | {
      mode: "builder-custom";
      runtimeProps: GraphRuntimeProps;
      optionFactory: GraphPanelOptionFactory;
    }
  | { mode: "custom"; render: () => ReactNode };

interface AnalysisGraphProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "className" | "style" | "title"> {
  title: ReactNode;
  graphRole: string;
  strategy: AnalysisGraphStrategy;
  contentClassName?: string;
  renderGraph?: (
    props: GraphRuntimeProps,
    mode: "builder" | "builder-custom",
  ) => ReactNode;
}

export function AnalysisGraph({
  title,
  graphRole,
  strategy,
  contentClassName,
  renderGraph,
  ...frameProps
}: AnalysisGraphProps) {
  return (
    <AnalysisFrame title={title} contentPadding="none" className="analysis-ui-graph" {...frameProps}>
      <div className={contentClassName ? `analysis-ui-graph-content ${contentClassName}` : "analysis-ui-graph-content"}>
        <div
          className="analysis-ui-graph-runtime"
          data-graph-role={graphRole}
          data-graph-strategy={strategy.mode}
        >
          {strategy.mode === "custom"
            ? strategy.render()
            : (
                <AnalysisBuilderGraph
                  strategy={strategy}
                  renderGraph={renderGraph}
                />
              )}
        </div>
      </div>
    </AnalysisFrame>
  );
}

function withAxisRange(
  item: GraphBuilderItem,
  axis: "x" | "y",
  min: number,
  max: number,
): GraphBuilderItem {
  const axisKey = axis === "x" ? "xAxis" : "yAxis";
  const twoD = item.modeStates.twoD;
  return {
    ...item,
    modeStates: {
      ...item.modeStates,
      twoD: {
        ...twoD,
        [axisKey]: { ...(twoD[axisKey] ?? {}), min, max },
      },
    },
  };
}

function AnalysisBuilderGraph({
  strategy,
  renderGraph,
}: {
  strategy: Exclude<AnalysisGraphStrategy, { mode: "custom" }>;
  renderGraph?: AnalysisGraphProps["renderGraph"];
}) {
  const [axisRanges, setAxisRanges] = useState<Partial<Record<"x" | "y", { min: number; max: number }>>>({});

  useEffect(() => {
    setAxisRanges({});
  }, [strategy.runtimeProps.item]);

  const runtimeItem = useMemo(() => {
    let next = strategy.runtimeProps.item;
    if (axisRanges.x) next = withAxisRange(next, "x", axisRanges.x.min, axisRanges.x.max);
    if (axisRanges.y) next = withAxisRange(next, "y", axisRanges.y.min, axisRanges.y.max);
    return next;
  }, [axisRanges, strategy.runtimeProps.item]);

  const fallbackAxisRangeChange = (axis: "x" | "y", min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return;
    setAxisRanges((current) => ({ ...current, [axis]: { min, max } }));
  };
  const runtimeProps: GraphRuntimeProps = {
    ...strategy.runtimeProps,
    item: runtimeItem,
    brushMode: strategy.runtimeProps.brushMode ?? false,
    onAxisRangeChange: strategy.runtimeProps.onAxisRangeChange ?? fallbackAxisRangeChange,
    optionFactory: strategy.mode === "builder-custom" ? strategy.optionFactory : undefined,
  };

  return renderGraph
    ? renderGraph(runtimeProps, strategy.mode)
    : <GraphRuntime {...runtimeProps} />;
}