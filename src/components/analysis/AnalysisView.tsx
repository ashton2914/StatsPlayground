import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AxisSettingsDialog } from "@/components/graphBuilder/AxisSettingsDialog";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import {
  AnalysisFrame,
  AnalysisGraph,
  AnalysisShell,
  AnalysisStack,
  AnalysisTable,
  AnalysisText,
} from "@/components/analysis/presentation";
import { describeDistributionAnalysis } from "@/components/analysis/adapters";
import { ProcessCapabilityReport } from "@/components/distribution/ProcessCapabilityReport";
import { mapDistributionExternalDataState, type DistributionGraphRole } from "@/graphCore/distributionAdapter";
import type { RefLineX, RefLineY, YAxisConfig } from "@/graphCore";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionReportResponse } from "@/types/distribution";
import { DISTRIBUTION_GRAPH_ELEMENT_IDS, type GraphDataFrame } from "@/types/graphData";
import type { EmbeddedGraphConfig, Graph2DState } from "@/types/graphBuilder";

import {
  useAnalysisExecution,
  type UseAnalysisExecutionRuntime,
} from "./useAnalysisExecution";
import {
  createSampleEcdfOption,
  SampleFiveNumberRange,
} from "./SampleAnalysisGraphExamples";

import "./analysis.css";

function isSupportedAnalysisDocument(item: AnalysisDocument): boolean {
  return item.schemaVersion === 1
    && item.analysisKind === "distribution"
    && item.definition.kind === "distribution"
    && item.presentation.schemaVersion === 1
    && item.presentation.layout === "distribution-v1";
}

interface AnalysisViewProps {
  item: AnalysisDocument;
  dataset?: DatasetMeta | null;
  runtime?: AnalysisViewRuntime;
  canEditInputs?: boolean;
  onEditInputs?: () => void;
  onGraphConfigChange?: (role: AnalysisBuilderGraphRole, graph: EmbeddedGraphConfig) => void;
}

type AnalysisBuilderGraphRole = "overview" | "ecdf";

export interface AnalysisViewRuntime extends UseAnalysisExecutionRuntime {
  renderGraph?: (props: GraphRuntimeProps & { role: DistributionGraphRole }) => ReactNode;
}

export function AnalysisView({
  item,
  dataset,
  runtime,
  canEditInputs = false,
  onEditInputs,
  onGraphConfigChange,
}: AnalysisViewProps) {
  const { t } = useTranslation();
  const documentScrollRef = useRef<HTMLElement | null>(null);
  const [axisDialog, setAxisDialog] = useState<{ role: AnalysisBuilderGraphRole; axis: "x" | "y" } | null>(null);
  const supportedItem = isSupportedAnalysisDocument(item) ? item : null;
  const executionState = useAnalysisExecution(
    supportedItem,
    supportedItem == null ? null : (dataset ?? null),
    runtime,
  );
  const graphItems = useMemo(() => {
    if (!supportedItem) return null;
    const overview = supportedItem.definition.graphs.overview;
    return {
      distributionComposite: createEmbeddedGraphItem({
      id: `analysis-graph:${item.id}:distributionComposite`,
      name: item.name,
      sourceDatasetId: item.source.datasetId,
      config: {
        ...overview,
        modeStates: {
          ...overview.modeStates,
          twoD: {
            ...overview.modeStates.twoD,
            elements: [
              { kind: "histogram", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewHistogram } },
              { kind: "line", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.overviewFittedCurves } },
              { kind: "boxplot", enabled: true, options: { elementId: DISTRIBUTION_GRAPH_ELEMENT_IDS.boxPlot } },
            ],
          },
        },
      },
      createdAt: item.createdAt,
    }),
    ecdf: createEmbeddedGraphItem({
      id: `analysis-graph:${item.id}:ecdf`,
      name: item.name,
      sourceDatasetId: item.source.datasetId,
      config: item.definition.graphs.ecdf,
      createdAt: item.createdAt,
    }),
    };
  }, [item, supportedItem]);
  const responseName = supportedItem?.definition.responses.map((response) => response.name).join(", ") ?? item.name;
  const ecdfOptionFactory = useMemo(() => createSampleEcdfOption(responseName), [responseName]);
  const compositeDataState = useMemo(() => {
    if (executionState.status !== "success") {
      return executionState.status === "error"
        ? { status: "error" as const, frame: null, error: executionState.error }
        : { status: "loading" as const, frame: null, error: null };
    }
    const overview = executionState.result.graphFrames.overview;
    const boxPlot = executionState.result.graphFrames.boxPlot;
    const frame: GraphDataFrame = {
      ...overview,
      requestId: `${overview.requestId}:composite`,
      aggregates: [...overview.aggregates, ...boxPlot.aggregates],
    };
    return { status: "ready" as const, frame, error: null };
  }, [executionState]);

  const updateGraph2D = (role: AnalysisBuilderGraphRole, patch: Partial<Graph2DState>) => {
    if (!onGraphConfigChange) return;
    const graph = item.definition.graphs[role];
    onGraphConfigChange(role, {
      ...graph,
      modeStates: {
        ...graph.modeStates,
        twoD: { ...graph.modeStates.twoD, ...patch },
      },
    });
  };

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => documentScrollRef.current?.scrollTo({ top: 0, left: 0 }));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [executionState.status, item.id]);

  if (item.schemaVersion !== 1) {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis schema." })} />;
  }
  if (item.analysisKind !== "distribution" || item.definition.kind !== "distribution") {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis kind." })} />;
  }
  if (item.presentation.schemaVersion !== 1 || item.presentation.layout !== "distribution-v1") {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupportedPresentation", { defaultValue: "Unsupported analysis presentation." })} />;
  }
  if (!graphItems) {
    return <UnsupportedAnalysis item={item} message={t("workspace.analysisUnsupported", { defaultValue: "Unsupported analysis kind." })} />;
  }

  const summary = describeDistributionAnalysis(item, dataset ?? null, t);
  const rangeResult = executionState.status === "success" ? firstResult(executionState.result) : null;
  const rangeSummary = rangeResult?.blocks.find((block) => block.summaryData)?.summaryData;
  const q1 = rangeResult?.quantiles.find((quantile) => quantile.probability === 0.25)?.value;
  const q3 = rangeResult?.quantiles.find((quantile) => quantile.probability === 0.75)?.value;

  return (
    <AnalysisShell
      title={item.name}
      sourceName={dataset?.name ?? t("workspace.analysisSourceMissing")}
      summary={summary}
      canEditInputs={canEditInputs && dataset != null}
      onEditInputs={onEditInputs}
      resultsRef={documentScrollRef}
    >
        <AnalysisFrame
          title={responseName || item.name}
          contentPadding="compact"
          data-analysis-document
        >
          <AnalysisStack>
            {dataset == null ? (
              <AnalysisFrame title={t("fitYByX.graph", { defaultValue: "Graph" })} data-analysis-block="graph">
                <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />
              </AnalysisFrame>
            ) : (
              <>
                <AnalysisGraph
                  title={t("distribution.graph.overview", { defaultValue: "Distribution" })}
                  graphRole="distributionComposite"
                  data-analysis-block="graph"
                  contentClassName="analysis-graph-distribution"
                  strategy={{
                    mode: "builder",
                    runtimeProps: {
                      item: graphItems.distributionComposite,
                      dataset,
                      minPanelHeight: 360,
                      externalDataState: compositeDataState,
                      onXAxisDblClick: onGraphConfigChange ? () => setAxisDialog({ role: "overview", axis: "x" }) : undefined,
                      onYAxisDblClick: onGraphConfigChange ? () => setAxisDialog({ role: "overview", axis: "y" }) : undefined,
                    },
                  }}
                  renderGraph={runtime?.renderGraph
                    ? (props) => runtime.renderGraph?.({ ...props, role: "overview" })
                    : undefined}
                />
                <AnalysisGraph
                  title={t("distribution.graph.ecdf", { defaultValue: "Empirical cumulative distribution" })}
                  graphRole="ecdf"
                  data-analysis-block="graph"
                  contentClassName="analysis-graph-ecdf"
                  strategy={{
                    mode: "builder-custom",
                    runtimeProps: {
                      item: graphItems.ecdf,
                      dataset,
                      minPanelHeight: 220,
                      externalDataState: mapDistributionExternalDataState(executionState, "ecdf"),
                      onXAxisDblClick: onGraphConfigChange ? () => setAxisDialog({ role: "ecdf", axis: "x" }) : undefined,
                      onYAxisDblClick: onGraphConfigChange ? () => setAxisDialog({ role: "ecdf", axis: "y" }) : undefined,
                    },
                    optionFactory: ecdfOptionFactory,
                  }}
                  renderGraph={runtime?.renderGraph
                    ? (props) => runtime.renderGraph?.({ ...props, role: "ecdf" })
                    : undefined}
                />
                <AnalysisGraph
                  title={t("distribution.graph.fiveNumberRange", { defaultValue: "Five-number range" })}
                  graphRole="summaryRange"
                  data-analysis-block="graph"
                  contentClassName="analysis-graph-summary-range"
                  strategy={{
                    mode: "custom",
                    render: () => rangeResult && rangeSummary && q1 != null && q3 != null
                      ? (
                          <SampleFiveNumberRange
                            responseName={rangeResult.yName}
                            minimum={rangeSummary.minimum}
                            q1={q1}
                            median={rangeSummary.median}
                            q3={q3}
                            maximum={rangeSummary.maximum}
                            mean={rangeSummary.mean}
                          />
                        )
                      : null,
                  }}
                />
              </>
            )}

            <AnalysisTextBlock state={executionState} />

            <AnalysisFrame title="Summary Statistical" data-analysis-block="tables">
              <AnalysisTables state={executionState} datasetMissing={dataset == null} />
            </AnalysisFrame>

            <AnalysisFrame title="Process Capabilities" data-analysis-block="process-capabilities">
              <AnalysisProcessCapabilities state={executionState} datasetMissing={dataset == null} />
            </AnalysisFrame>
          </AnalysisStack>
        </AnalysisFrame>
        {axisDialog && (() => {
          const twoD = item.definition.graphs[axisDialog.role].modeStates.twoD;
          return (
            <AxisSettingsDialog
              axis={axisDialog.axis}
              refLines={axisDialog.axis === "x" ? twoD.refLinesX ?? [] : twoD.refLinesY ?? []}
              setRefLines={axisDialog.axis === "x"
                ? (lines: RefLineX[]) => updateGraph2D(axisDialog.role, { refLinesX: lines })
                : (lines: RefLineY[]) => updateGraph2D(axisDialog.role, { refLinesY: lines })}
              autoSpecLines={axisDialog.axis === "x" ? !!twoD.autoSpecLinesX : !!(twoD.autoSpecLinesY ?? twoD.autoSpecLines)}
              setAutoSpecLines={(enabled) => updateGraph2D(
                axisDialog.role,
                axisDialog.axis === "x" ? { autoSpecLinesX: enabled } : { autoSpecLinesY: enabled },
              )}
              axisConfig={axisDialog.axis === "x" ? twoD.xAxis : twoD.yAxis}
              setAxisConfig={(config: YAxisConfig | undefined) => updateGraph2D(
                axisDialog.role,
                axisDialog.axis === "x" ? { xAxis: config } : { yAxis: config },
              )}
              onClose={() => setAxisDialog(null)}
            />
          );
        })()}
    </AnalysisShell>
  );
}

function UnsupportedAnalysis({ item, message }: { item: AnalysisDocument; message: string }) {
  return (
    <div className="main-content">
      <div className="workspace-empty">
        <h2>{item.name}</h2>
        <p role="alert">{message}</p>
      </div>
    </div>
  );
}

function AnalysisTextBlock({ state }: { state: ReturnType<typeof useAnalysisExecution> }) {
  const result = state.status === "success" ? firstResult(state.result) : null;
  const summary = result?.blocks.find((block) => block.summaryData)?.summaryData;
  if (!result || !summary) return null;

  return (
    <AnalysisText data-analysis-block="text">
      {result.yName}: n = {formatNumber(summary.n)}, mean = {formatNumber(summary.mean)}, standard deviation = {formatNumber(summary.stdDev)}.
    </AnalysisText>
  );
}

function AnalysisTables({ state, datasetMissing }: {
  state: ReturnType<typeof useAnalysisExecution>;
  datasetMissing: boolean;
}) {
  const { t } = useTranslation();
  if (datasetMissing) return <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />;
  if (state.status === "idle" || state.status === "loading") {
    return <AnalysisUnavailable message={t("distribution.report.loading", { defaultValue: "Loading report..." })} />;
  }
  if (state.status === "error") return <AnalysisUnavailable message={state.error} alert />;

  const result = firstResult(state.result);
  const summary = result?.blocks.find((block) => block.summaryData)?.summaryData;
  if (!result) return <AnalysisUnavailable message={t("distribution.report.unavailable", { defaultValue: "No results available." })} />;

  return (
    <AnalysisStack>
      <AnalysisTable
        title={t("distribution.report.quantiles", { defaultValue: "Quantiles" })}
        width="standard"
        columns={[
          { key: "probability", label: t("distribution.report.probability") },
          { key: "label", label: t("distribution.report.label") },
          { key: "value", label: t("distribution.report.value"), numeric: true },
        ]}
        rows={result.quantiles.map((quantile) => ({
          key: String(quantile.probability),
          cells: [
            formatProbability(quantile.probability),
            quantileLabel(quantile.probability, t),
            formatNumber(quantile.value),
          ],
        }))}
      />
      {summary && (
        <>
          <SummaryTableFrame title={t("distribution.report.location")} rows={[
            ["n", summary.n], ["mean", summary.mean], ["median", summary.median],
            ["minimum", summary.minimum], ["maximum", summary.maximum],
          ]} />
          <SummaryTableFrame title={t("distribution.report.variation")} rows={[
            ["stdDev", summary.stdDev], ["stdError", summary.stdError],
            ["range", summary.range], ["iqr", summary.iqr], ["mad", summary.mad],
          ]} />
        </>
      )}
    </AnalysisStack>
  );
}

function SummaryTableFrame({ title, rows }: { title: string; rows: Array<[string, number | null]> }) {
  const { t } = useTranslation();
  return (
    <AnalysisTable
      title={title}
      width="compact"
      columns={[
        { key: "metric", label: t("distribution.report.metric", { defaultValue: "Metric" }) },
        { key: "value", label: t("distribution.report.value"), numeric: true },
      ]}
      rows={rows.map(([label, value]) => ({
        key: label,
        cells: [t(`distribution.statistics.${label}`), formatNumber(value)],
      }))}
    />
  );
}

function AnalysisUnavailable({ message, alert = false }: { message: string; alert?: boolean }) {
  return <p className="analysis-unavailable" role={alert ? "alert" : undefined}>{message}</p>;
}

function firstResult(response: DistributionReportResponse) {
  return response.groups.flatMap((group) => group.yResults)[0] ?? null;
}

function quantileLabel(probability: number, t: (key: string) => string): string {
  if (probability === 0) return t("distribution.statistics.minimum");
  if (probability === 0.25) return "Q1";
  if (probability === 0.5) return t("distribution.statistics.median");
  if (probability === 0.75) return "Q3";
  if (probability === 1) return t("distribution.statistics.maximum");
  return "";
}

function formatProbability(probability: number): string {
  return `${Number.parseFloat((probability * 100).toFixed(3))}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 10 });
}

function AnalysisProcessCapabilities({ state, datasetMissing }: {
  state: ReturnType<typeof useAnalysisExecution>;
  datasetMissing: boolean;
}) {
  const { t } = useTranslation();
  if (datasetMissing) return <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />;
  if (state.status === "idle" || state.status === "loading") return null;
  if (state.status === "error") return <AnalysisUnavailable message={state.error} alert />;

  const capabilityData = state.result.groups
    .flatMap((group) => group.yResults)
    .flatMap((result) => result.blocks)
    .find((block) => block.capabilityData)?.capabilityData;

  return capabilityData
    ? <ProcessCapabilityReport data={capabilityData} />
    : <AnalysisUnavailable message={t("distribution.report.unavailable", { defaultValue: "Process capability requires specification limits." })} />;
}