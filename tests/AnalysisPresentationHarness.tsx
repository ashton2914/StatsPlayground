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
      graphRole="graph"
      strategy={{
        mode: "builder",
        runtimeProps: { item, dataset, externalDataState, minPanelHeight: 96, onAxisRangeChange },
      }}
      renderGraph={(props) => (
        <output data-testid="graph-runtime-props">
          {JSON.stringify({
            item: props.item === item,
            dataset: props.dataset === dataset,
            externalDataState: props.externalDataState === externalDataState,
            minPanelHeight: props.minPanelHeight,
            onAxisRangeChange: props.onAxisRangeChange === onAxisRangeChange,
            brushMode: props.brushMode,
          })}
        </output>
      )}
    />
  );
}

export function AnalysisGraphStrategiesHarness() {
  const item = { id: "graph-1", name: "Distribution" } as GraphRuntimeProps["item"];
  const dataset = { id: "dataset-1", name: "Sample" } as GraphRuntimeProps["dataset"];
  const optionFactory = ({ option }: { option: Readonly<Record<string, unknown>> }) => ({ ...option });

  return (
    <div data-testid="strategy-examples">
      <AnalysisGraph
        title="Builder example"
        graphRole="builder-example"
        strategy={{ mode: "builder", runtimeProps: { item, dataset } }}
        renderGraph={(props, mode) => (
          <output data-testid="runtime-builder-example">
            {JSON.stringify({
              mode,
              hasOptionFactory: props.optionFactory === optionFactory,
              hasAxisRangeChange: typeof props.onAxisRangeChange === "function",
              brushMode: props.brushMode,
            })}
          </output>
        )}
      />
      <AnalysisGraph
        title="Builder custom example"
        graphRole="builder-custom-example"
        strategy={{
          mode: "builder-custom",
          runtimeProps: { item, dataset },
          optionFactory,
        }}
        renderGraph={(props, mode) => (
          <output data-testid="runtime-builder-custom-example">
            {JSON.stringify({
              mode,
              hasOptionFactory: props.optionFactory === optionFactory,
              hasAxisRangeChange: typeof props.onAxisRangeChange === "function",
              brushMode: props.brushMode,
            })}
          </output>
        )}
      />
      <AnalysisGraph
        title="Custom example"
        graphRole="custom-example"
        strategy={{
          mode: "custom",
          render: () => <output data-testid="fully-custom-example">Custom graph</output>,
        }}
      />
    </div>
  );
}

export function AnalysisGraphWidthHarness() {
  const item = { id: "graph-1", name: "Distribution" } as GraphRuntimeProps["item"];
  const dataset = { id: "dataset-1", name: "Sample" } as GraphRuntimeProps["dataset"];

  return (
    <div data-testid="graph-column" style={{ width: 900, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
      <AnalysisGraph
        title="Graph"
        graphRole="graph"
        strategy={{ mode: "builder", runtimeProps: { item, dataset } }}
        renderGraph={() => <div style={{ width: 320, height: 100 }}>Graph content</div>}
      />
    </div>
  );
}