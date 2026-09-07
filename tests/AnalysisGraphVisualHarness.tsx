import { Component, type ErrorInfo, type ReactNode } from "react";

import { AnalysisGraph } from "../src/components/analysis/presentation";
import type { GraphRuntimeProps } from "../src/components/graphBuilder/GraphRuntime";
import { Graph, type GraphSpec } from "../src/graphCore";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS, type GraphDataFrame } from "../src/types/graphData";

import "../src/components/analysis/analysis.css";

const item = { id: "visual-graph", name: "DIM1" } as GraphRuntimeProps["item"];
const dataset = { id: "dataset-1", name: "Sample" } as GraphRuntimeProps["dataset"];
const responses = ["DIM1"];
const data = { columns: ["__sp_variable__", "__sp_value__"], rows: [] };

const compositeSpec: GraphSpec = {
  encoding: {
    x: { name: "__sp_value__", type: "continuous" },
    y: { name: "__sp_variable__", type: "nominal" },
  },
  elements: [
    { kind: "histogram", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram } },
    { kind: "normalCurve", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves } },
    { kind: "boxplot", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot } },
  ],
};

const compositeFrame: GraphDataFrame = {
  requestId: "visual:composite",
  datasetId: "dataset-1",
  generation: 1,
  sourceRows: 10,
  processedRows: 10,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  rawChunks: [],
  aggregates: [
    {
      kind: "histogram",
      yColumn: "__sp_y",
      sourceColumn: "__sp_variable__",
      binCount: 6,
      minValue: 85,
      maxValue: 121,
      missingCount: 0,
      binWidth: 6,
      totalCount: 10,
      bins: responses.flatMap((sourceColumn) =>
        [1, 2, 4, 2, 1, 0].map((count, index) => ({
          sourceColumn,
          binStart: 85 + index * 6,
          binEnd: 91 + index * 6,
          count,
        }))),
    },
    ...responses.map((sourceColumn) => ({
      kind: "precomputedCurve" as const,
      elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves,
      seriesId: `fit-${sourceColumn}`,
      seriesName: `${sourceColumn} - Normal`,
      category: sourceColumn,
      sourceColumn,
      interpolation: "linear" as const,
      points: [
        { x: 85, y: 0.2 },
        { x: 91, y: 2.2 },
        { x: 97, y: 6.5 },
        { x: 101, y: 8 },
        { x: 105, y: 6.5 },
        { x: 111, y: 2.2 },
        { x: 121, y: 0.2 },
      ],
    })),
    {
      kind: "boxPlot",
      yColumn: "__sp_y",
      sourceColumn: "__sp_variable__",
      entries: responses.map((sourceColumn, responseIndex) => ({
        sourceColumn,
        count: 10,
        min: 85,
        q1: 94 + responseIndex * 3,
        median: 99 + responseIndex * 3,
        q3: 104 + responseIndex * 3,
        max: 121,
        whiskerLow: 85,
        whiskerHigh: 121,
        outliers: [],
      })),
    },
  ],
  rawPointDisposition: { status: "empty", validRows: 0, budget: 8_000 },
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
  return (
    <VisualErrorBoundary>
      <div style={{ width: "100%" }}>
      <AnalysisGraph
        title="Distribution"
        graphRole="distributionComposite"
        contentClassName="analysis-graph-distribution"
        strategy={{ mode: "builder", runtimeProps: { item, dataset, panelLayout: "fit" } }}
        renderGraph={(props) => (
          <Graph
            spec={compositeSpec}
            data={data}
            frame={compositeFrame}
            panelLayout={props.panelLayout}
            brushMode={props.brushMode}
            onAxisRangeChange={props.onAxisRangeChange}
          />
        )}
      />
      </div>
    </VisualErrorBoundary>
  );
}