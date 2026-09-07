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
  AnalysisText,
} from "@/components/analysis/presentation";
import { describeDistributionAnalysis } from "@/components/analysis/adapters";
import { DistributionReport } from "@/components/distribution/DistributionReport";
import {
  mapDistributionCompositeExternalDataState,
  type DistributionGraphRole,
} from "@/graphCore/distributionAdapter";
import type { RefLineX, RefLineY, YAxisConfig } from "@/graphCore";
import type { AnalysisDocument } from "@/types/analysis";
import type { DatasetMeta } from "@/types/data";
import type { DistributionReportResponse } from "@/types/distribution";
import type { EmbeddedGraphConfig, Graph2DState } from "@/types/graphBuilder";

import {
  useAnalysisExecution,
  type UseAnalysisExecutionRuntime,
} from "./useAnalysisExecution";
import { createDistributionGraphBuilderConfig } from "./distributionCompositeGraph";

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

type AnalysisBuilderGraphRole = "overview";

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
    const boxPlot = supportedItem.definition.graphs.boxPlot;
    return {
      distributionComposite: createEmbeddedGraphItem({
        id: `analysis-graph:${item.id}:distributionComposite`,
        name: item.name,
        sourceDatasetId: item.source.datasetId,
        config: createDistributionGraphBuilderConfig(overview, boxPlot, supportedItem.definition.responses),
        createdAt: item.createdAt,
      }),
    };
  }, [item, supportedItem]);
  const responseName = supportedItem?.definition.responses.map((response) => response.name).join(", ") ?? item.name;
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
                      panelLayout: "fit",
                      externalDataState: mapDistributionCompositeExternalDataState(executionState),
                      onXAxisDblClick: onGraphConfigChange ? () => setAxisDialog({ role: "overview", axis: "x" }) : undefined,
                      onYAxisDblClick: onGraphConfigChange ? () => setAxisDialog({ role: "overview", axis: "y" }) : undefined,
                    },
                  }}
                  renderGraph={runtime?.renderGraph
                    ? (props) => runtime.renderGraph?.({ ...props, role: "overview" })
                    : undefined}
                />
              </>
            )}

            <AnalysisTextBlock state={executionState} />

            <AnalysisFrame
              title={t("distribution.report.title", { defaultValue: "Statistical Report" })}
              data-analysis-block="report"
            >
              <AnalysisDistributionReport state={executionState} datasetMissing={dataset == null} />
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
        <AnalysisText role="alert">{message}</AnalysisText>
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

function AnalysisDistributionReport({ state, datasetMissing }: {
  state: ReturnType<typeof useAnalysisExecution>;
  datasetMissing: boolean;
}) {
  const { t } = useTranslation();
  if (datasetMissing) return <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />;
  if (state.status === "idle" || state.status === "loading") {
    return <AnalysisUnavailable message={t("distribution.report.loading", { defaultValue: "Loading report..." })} />;
  }
  if (state.status === "error") return <AnalysisUnavailable message={state.error} alert />;

  return <DistributionReport groups={state.result.groups} reportBlocks={state.result.reportBlocks} />;
}

function AnalysisUnavailable({ message, alert = false }: { message: string; alert?: boolean }) {
  return <AnalysisText role={alert ? "alert" : undefined}>{message}</AnalysisText>;
}

function firstResult(response: DistributionReportResponse) {
  return response.groups.flatMap((group) => group.yResults)[0] ?? null;
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumSignificantDigits: 10 });
}
