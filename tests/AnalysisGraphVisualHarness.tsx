import { Component, type ErrorInfo, type ReactNode } from "react";

import { AnalysisGraph } from "../src/components/analysis/presentation";
import type { GraphRuntimeProps } from "../src/components/graphBuilder/GraphRuntime";
import { createSampleEcdfOption, SampleFiveNumberRange } from "../src/components/analysis/SampleAnalysisGraphExamples";
import { Graph, type GraphSpec } from "../src/graphCore";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS, type GraphDataFrame } from "../src/types/graphData";

import "../src/components/analysis/analysis.css";

const item = { id: "visual-graph", name: "DIM1" } as GraphRuntimeProps["item"];
const dataset = { id: "dataset-1", name: "Sample" } as GraphRuntimeProps["dataset"];
const data = { columns: ["DIM1"], rows: [] };

const compositeSpec: GraphSpec = {
  encoding: { x: { name: "DIM1", type: "continuous" } },
  elements: [
    { kind: "histogram", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram } },
    { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves, lineWidth: 3 } },
    { kind: "boxplot", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot } },
  ],
};

const compositeFrame: GraphDataFrame = {
  requestId: "visual:composite",
  datasetId: "dataset-1",
  generation: 1,
  sourceRows: 32,
  processedRows: 32,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  rawChunks: [],
  aggregates: [
    {
      kind: "histogram",
      yColumn: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram,
      binCount: 6,
      minValue: 85,
      maxValue: 121,
      missingCount: 0,
      binWidth: 6,
      totalCount: 32,
      bins: [4, 7, 9, 6, 4, 2].map((count, index) => ({
        binStart: 85 + index * 6,
        binEnd: 91 + index * 6,
        count,
      })),
    },
    {
      kind: "precomputedCurve",
      elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves,
      seriesName: "Normal fit",
      interpolation: "linear",
      points: [[85, 0.4], [91, 3.2], [97, 7.3], [103, 8.1], [109, 4.7], [115, 1.2], [121, 0.2]]
        .map(([x, y]) => ({ x, y })),
    },
    {
      kind: "boxPlot",
      yColumn: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot,
      entries: [{
        count: 32,
        min: 87.4,
        q1: 96.1,
        median: 101.04,
        q3: 108.9,
        max: 121.3,
        whiskerLow: 87.4,
        whiskerHigh: 121.3,
        outliers: [],
      }],
    },
  ],
  rawPointDisposition: { status: "empty", validRows: 0, budget: 8_000 },
};

const ecdfSpec: GraphSpec = {
  encoding: { x: { name: "DIM1", type: "continuous" } },
  elements: [{ kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.ecdf } }],
};
const ecdfFrame: GraphDataFrame = {
  ...compositeFrame,
  requestId: "visual:ecdf",
  aggregates: [{
    kind: "precomputedCurve",
    elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.ecdf,
    interpolation: "stepEnd",
    points: [[87.4, 0], [96.1, 0.25], [101.04, 0.5], [108.9, 0.75], [121.3, 1]]
      .map(([x, y]) => ({ x, y })),
  }],
};

class VisualErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    return this.state.error
      ? <pre data-testid="visual-error">{this.state.error}</pre>
      : this.props.children;
  }
}

export function AnalysisGraphVisualHarness() {
  const ecdfOptionFactory = createSampleEcdfOption("DIM1");
  return (
    <VisualErrorBoundary>
      <div style={{ width: "100%" }}>
      <AnalysisGraph
        title="Distribution"
        graphRole="distributionComposite"
        contentClassName="analysis-graph-distribution"
        strategy={{ mode: "builder", runtimeProps: { item, dataset } }}
        renderGraph={(props) => (
          <Graph
            spec={compositeSpec}
            data={data}
            frame={compositeFrame}
            minPanelHeight={360}
            brushMode={props.brushMode}
            onAxisRangeChange={props.onAxisRangeChange}
          />
        )}
      />
      <AnalysisGraph
        title="Empirical cumulative distribution"
        graphRole="ecdf"
        contentClassName="analysis-graph-ecdf"
        strategy={{ mode: "builder-custom", runtimeProps: { item, dataset }, optionFactory: ecdfOptionFactory }}
        renderGraph={(props) => (
          <Graph
            spec={ecdfSpec}
            data={data}
            frame={ecdfFrame}
            minPanelHeight={220}
            brushMode={props.brushMode}
            onAxisRangeChange={props.onAxisRangeChange}
            optionFactory={props.optionFactory}
          />
        )}
      />
      <AnalysisGraph
        title="Five-number range"
        graphRole="summaryRange"
        contentClassName="analysis-graph-summary-range"
        strategy={{
          mode: "custom",
          render: () => (
            <SampleFiveNumberRange
              responseName="DIM1"
              minimum={87.4}
              q1={96.1}
              median={101.04}
              q3={108.9}
              maximum={121.3}
              mean={101.04}
            />
          ),
        }}
      />
      </div>
    </VisualErrorBoundary>
  );
}