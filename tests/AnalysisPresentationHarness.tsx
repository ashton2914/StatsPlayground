import { AnalysisGraph } from "../src/components/analysis/presentation";
import type { GraphRuntimeProps } from "../src/components/graphBuilder/GraphRuntime";

export function AnalysisGraphHarness() {
  const item = { id: "graph-1", name: "Distribution" } as GraphRuntimeProps["item"];
  const dataset = { id: "dataset-1", name: "Sample" } as GraphRuntimeProps["dataset"];
  const externalDataState = { status: "loading" } as GraphRuntimeProps["externalDataState"];
  const onAxisRangeChange: NonNullable<GraphRuntimeProps["onAxisRangeChange"]> = () => undefined;

  return (
    <AnalysisGraph
      title="Graph"
      runtimeProps={{ item, dataset, externalDataState, minPanelHeight: 96, onAxisRangeChange }}
      renderGraph={(props) => (
        <output data-testid="graph-runtime-props">
          {JSON.stringify({
            item: props.item === item,
            dataset: props.dataset === dataset,
            externalDataState: props.externalDataState === externalDataState,
            minPanelHeight: props.minPanelHeight,
            onAxisRangeChange: props.onAxisRangeChange === onAxisRangeChange,
          })}
        </output>
      )}
    />
  );
}