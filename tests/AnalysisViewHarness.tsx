import { useEffect, useRef, useState } from "react";

import { AnalysisView } from "../src/components/analysis/AnalysisView";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample";
import type { AnalysisDocument } from "../src/types/analysis";
import type { DatasetMeta } from "../src/types/data";
import type { DistributionReportResponse } from "../src/types/distribution";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS } from "../src/types/graphData";
import type { GraphAggregatePacket } from "../src/types/graphData";

function createDataset(): DatasetMeta {
  return {
    id: "dataset-1",
    name: "Incoming Data",
    sourcePath: null,
    sourceType: "manual",
    rowCount: 32,
    colCount: 1,
    generation: 4,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function createAnalysisDocument() {
  const document = createAnalysisSampleDocument({
    datasetId: "dataset-1",
    analysisId: "analysis-1",
    analysisName: "Strength Distribution",
    createdAt: "2026-09-03T00:00:00.000Z",
  });
  document.definition.graphs.overview.modeStates.twoD.elements = [];
  return document;
}

function createUnsupportedPresentationDocument(): AnalysisDocument {
  return {
    ...createAnalysisDocument(),
    presentation: {
      schemaVersion: 2 as 1,
      layout: "distribution-v2" as "distribution-v1",
    },
  };
}

function createResponse(quantile: number, generation: number): DistributionReportResponse {
  const frame = (role: string, aggregates: GraphAggregatePacket[]) => ({
    requestId: `analysis:${role}`,
    datasetId: "dataset-1",
    generation,
    sourceRows: 32,
    processedRows: 32,
    sampling: { mode: "full" as const },
    dictionaries: {},
    extents: {},
    rawChunks: [],
    aggregates,
    rawPointDisposition: { status: "included" as const, validRows: 32, budget: 8000 },
  });

  return {
    datasetId: "dataset-1",
    generation,
    groups: [{
      groupKey: [],
      yResults: [{
        yColumn: { columnId: "DIM1", modelingType: "continuous" },
        yName: "DIM1",
        quantiles: [
          { probability: 0, value: 87.4 },
          { probability: 0.25, value: 96.1 },
          { probability: 0.5, value: quantile },
          { probability: 0.75, value: 108.9 },
          { probability: 1, value: 121.3 },
        ],
        blocks: [{
          schemaVersion: "1",
          blockId: "summary-1",
          kind: "summary",
          titleKey: "distribution.report.summary",
          status: "available",
          reasonCode: null,
          summaryData: {
            n: 32,
            nMissing: 0,
            mean: 101.044792,
            stdDev: 5.125,
            stdError: 0.906,
            meanCiLower: 99.198,
            meanCiUpper: 102.891,
            minimum: 87.4,
            maximum: 121.3,
            median: quantile,
            primaryMode: 101.044792,
            modeIsUnique: true,
            range: 33.9,
            iqr: 12.8,
            mad: 4.4,
          },
          capabilityData: undefined,
          distributionFitData: undefined,
          distributionFitComparisonData: undefined,
          chartData: null,
        }],
      }],
    }],
    reportBlocks: [],
    graphFrames: {
      overview: frame("overview", [
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
          seriesName: "DIM1 - Normal",
          interpolation: "linear",
          points: [
            { x: 85, y: 0.4 },
            { x: 91, y: 3.2 },
            { x: 97, y: 7.3 },
            { x: 103, y: 8.1 },
            { x: 109, y: 4.7 },
            { x: 115, y: 1.2 },
            { x: 121, y: 0.2 },
          ],
        },
      ]),
      boxPlot: frame("boxPlot", [{
        kind: "boxPlot",
        yColumn: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot,
        entries: [{
          count: 32,
          min: 87.4,
          q1: 96.1,
          median: quantile,
          q3: 108.9,
          max: 121.3,
          whiskerLow: 87.4,
          whiskerHigh: 121.3,
          outliers: [],
        }],
      }]),
      ecdf: frame("ecdf", [{
        kind: "precomputedCurve",
        elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.ecdf,
        interpolation: "stepEnd",
        points: [
          { x: 87.4, y: 0 },
          { x: 96.1, y: 0.25 },
          { x: quantile, y: 0.5 },
          { x: 108.9, y: 0.75 },
          { x: 121.3, y: 1 },
        ],
      }]),
      normalQuantile: frame("normalQuantile", []),
    },
  };
}

interface AnalysisViewHarnessProps {
  mode?: "default" | "unsupportedPresentation";
}

export function AnalysisViewHarness({ mode = "default" }: AnalysisViewHarnessProps) {
  const [dataset] = useState(createDataset());
  const [item, setItem] = useState(() => mode === "unsupportedPresentation"
    ? createUnsupportedPresentationDocument()
    : createAnalysisDocument());
  const [current, setCurrent] = useState(() => createResponse(101.044792, 4));
  const [computeCalls, setComputeCalls] = useState(0);
  const [generationCalls, setGenerationCalls] = useState(0);
  const [editInputsCalls, setEditInputsCalls] = useState(0);
  const [deferNextResponse, setDeferNextResponse] = useState(false);
  const currentResponseRef = useRef(current);
  const currentDatasetRef = useRef(dataset);
  const deferNextResponseRef = useRef(deferNextResponse);
  const pendingResolverRef = useRef<((value: DistributionReportResponse) => void) | null>(null);
  const runtimeRef = useRef<NonNullable<Parameters<typeof AnalysisView>[0]["runtime"]>>(null);
  const originalDefinition = JSON.stringify(item.definition);

  useEffect(() => {
    currentResponseRef.current = current;
  }, [current]);

  useEffect(() => {
    currentDatasetRef.current = dataset;
  }, [dataset]);

  useEffect(() => {
    deferNextResponseRef.current = deferNextResponse;
  }, [deferNextResponse]);

  if (runtimeRef.current == null) {
    runtimeRef.current = {
      getDatasetGeneration: async () => {
        setGenerationCalls((count) => count + 1);
        return currentDatasetRef.current.generation;
      },
      compute: async () => {
        setComputeCalls((count) => count + 1);
        if (deferNextResponseRef.current) {
          deferNextResponseRef.current = false;
          setDeferNextResponse(false);
          return await new Promise<DistributionReportResponse>((resolve) => {
            pendingResolverRef.current = resolve;
          });
        }
        return currentResponseRef.current;
      },
      renderGraph: ({ role, externalDataState, optionFactory, item: graphItem, onXAxisDblClick, onYAxisDblClick }) => (
        <div>
          {`Distribution graph:${role}:${externalDataState?.status ?? "pipeline"}:${optionFactory ? "custom-option" : "native"}`}
          <button type="button" onClick={onXAxisDblClick}>{`Open ${role} X axis`}</button>
          <button type="button" onClick={onYAxisDblClick}>{`Open ${role} Y axis`}</button>
          {role === "overview" && (
            <output data-testid="composite-element-kinds">
              {graphItem.modeStates.twoD.elements.map((element) => element.kind).join(",")}
            </output>
          )}
        </div>
      ),
    };
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setCurrent(createResponse(88.5, 4));
          setDeferNextResponse(true);
          setItem((prev) => ({
            ...prev,
            configRevision: prev.configRevision + 1,
            updatedAt: "2026-09-03T00:05:00.000Z",
          }));
        }}
      >
        Bump config revision
      </button>
      <button
        type="button"
        onClick={() => {
          pendingResolverRef.current?.(currentResponseRef.current);
          pendingResolverRef.current = null;
        }}
      >
        Resolve pending response
      </button>
      <div>{JSON.stringify(item.definition) === originalDefinition ? "definition:unchanged" : "definition:mutated"}</div>
      <div>{`compute-calls:${computeCalls}`}</div>
      <div>{`generation-calls:${generationCalls}`}</div>
      <output data-testid="overview-x-min">{item.definition.graphs.overview.modeStates.twoD.xAxis?.min ?? "auto"}</output>
      <output data-testid="ecdf-y-min">{item.definition.graphs.ecdf.modeStates.twoD.yAxis?.min ?? "auto"}</output>
      <output data-testid="edit-inputs-calls">{editInputsCalls}</output>
      <AnalysisView
        item={item}
        dataset={dataset}
        runtime={runtimeRef.current}
        canEditInputs
        onEditInputs={() => setEditInputsCalls((count) => count + 1)}
        onGraphConfigChange={(role, graph) => setItem((previous) => ({
          ...previous,
          definition: {
            ...previous.definition,
            graphs: { ...previous.definition.graphs, [role]: graph },
          },
        }))}
      />
    </>
  );
}