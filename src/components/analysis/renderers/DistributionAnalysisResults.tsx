import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { describeAnalysisDocument } from "@/components/analysis/analysisEditorRegistry";
import { AnalysisFrame } from "@/components/analysis/presentation/AnalysisFrame";
import { AnalysisShell } from "@/components/analysis/presentation/AnalysisShell";
import { AnalysisText } from "@/components/analysis/presentation/AnalysisText";
import type { AnalysisKindViewProps } from "@/components/analysis/analysisViewRegistry";
import { useAnalysisExecution } from "@/components/analysis/useAnalysisExecution";
import { getDistributionResponseAxis } from "@/components/distribution/distributionAxisInteractions";
import { AxisSettingsDialog } from "@/components/graphBuilder/AxisSettingsDialog";
import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import { createDistributionGraphBuilderConfig } from "@/components/analysis/distributionCompositeGraph";
import { AnalysisGraph, AnalysisStack } from "@/components/analysis/presentation";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import type { RefLineY, YAxisConfig } from "@/graphCore";
import type { Graph2DState } from "@/types/graphBuilder";

import { DistributionAnalysisReportTree } from "./DistributionAnalysisReportTree";

type DistributionAnalysisResultsProps = AnalysisKindViewProps<"distribution">;
type DistributionBuilderGraphRole = "overview";
type DistributionGraphRenderer = (
  props: GraphRuntimeProps,
  mode: "builder" | "builder-custom",
) => ReactNode;

export function DistributionAnalysisResults({
  item,
  dataset,
  runtime,
  canEditInputs = false,
  onEditInputs,
  onGraphConfigChange,
}: DistributionAnalysisResultsProps) {
  const { t } = useTranslation();
  const documentScrollRef = useRef<HTMLElement | null>(null);
  const [axisDialog, setAxisDialog] = useState<{
    role: DistributionBuilderGraphRole;
    sourceAxis: "x" | "y";
  } | null>(null);
  const executionState = useAnalysisExecution(item, dataset ?? null, runtime);
  const overviewResponse = item.definition.responses[0];
  const renderOverviewGraph = runtime?.renderGraph
    ? (props: GraphRuntimeProps) => runtime.renderGraph?.({ ...props, role: "overview" })
    : undefined;
  const overviewResponseAxis = overviewResponse
    ? getDistributionResponseAxis(item.definition.graphs.overview, overviewResponse)
    : null;
  const updateGraph2D = (role: DistributionBuilderGraphRole, patch: Partial<Graph2DState>) => {
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

  const summary = describeAnalysisDocument(item, dataset ?? null, t);
  return (
    <AnalysisShell
      title={item.name}
      sourceName={dataset?.name ?? t("workspace.analysisSourceMissing")}
      summary={summary}
      canEditInputs={canEditInputs && dataset != null}
      onEditInputs={onEditInputs}
      resultsRef={documentScrollRef}
    >
      {dataset != null && executionState.status === "success" && executionState.analysisKind === "distribution"
        ? (
            <DistributionAnalysisReportTree
              item={item}
              dataset={dataset}
              result={executionState.result}
              onOpenAxisSettings={onGraphConfigChange && overviewResponseAxis
                ? () => setAxisDialog({ role: "overview", sourceAxis: overviewResponseAxis })
                : undefined}
              onAxisRangeChange={onGraphConfigChange
                ? (axis, min, max) => {
                    if (axis !== "y") return;
                    if (overviewResponseAxis === "x") {
                      updateGraph2D("overview", {
                        xAxis: {
                          ...(item.definition.graphs.overview.modeStates.twoD.xAxis ?? {}),
                          min,
                          max,
                        },
                      });
                    } else if (overviewResponseAxis === "y") {
                      updateGraph2D("overview", {
                        yAxis: {
                          ...(item.definition.graphs.overview.modeStates.twoD.yAxis ?? {}),
                          min,
                          max,
                        },
                      });
                    }
                  }
                : undefined}
              renderGraph={renderOverviewGraph}
            />
          )
        : <DistributionAnalysisPendingSurface
            item={item}
            dataset={dataset}
            state={executionState}
            onOpenAxisSettings={onGraphConfigChange && overviewResponseAxis
              ? () => setAxisDialog({ role: "overview", sourceAxis: overviewResponseAxis })
              : undefined}
            onAxisRangeChange={onGraphConfigChange
              ? (axis, min, max) => {
                  if (axis !== "y") return;
                  if (overviewResponseAxis === "x") {
                    updateGraph2D("overview", {
                      xAxis: {
                        ...(item.definition.graphs.overview.modeStates.twoD.xAxis ?? {}),
                        min,
                        max,
                      },
                    });
                  } else if (overviewResponseAxis === "y") {
                    updateGraph2D("overview", {
                      yAxis: {
                        ...(item.definition.graphs.overview.modeStates.twoD.yAxis ?? {}),
                        min,
                        max,
                      },
                    });
                  }
                }
              : undefined}
            renderGraph={renderOverviewGraph}
          />}
      {axisDialog && (() => {
        const twoD = item.definition.graphs[axisDialog.role].modeStates.twoD;
        const sourceAxis = axisDialog.sourceAxis;
        const refLines = sourceAxis === "x"
          ? (twoD.refLinesX ?? []).map(({ x, ...line }) => ({ ...line, y: x }))
          : twoD.refLinesY ?? [];
        return (
          <AxisSettingsDialog
            axis="y"
            refLines={refLines}
            setRefLines={(lines: RefLineY[]) => updateGraph2D(
              axisDialog.role,
              sourceAxis === "x"
                ? { refLinesX: lines.map(({ y, ...line }) => ({ ...line, x: y })) }
                : { refLinesY: lines },
            )}
            autoSpecLines={sourceAxis === "x"
              ? !!(twoD.autoSpecLinesX ?? twoD.autoSpecLines)
              : !!(twoD.autoSpecLinesY ?? twoD.autoSpecLines)}
            setAutoSpecLines={(enabled) => updateGraph2D(
              axisDialog.role,
              sourceAxis === "x" ? { autoSpecLinesX: enabled } : { autoSpecLinesY: enabled },
            )}
            axisConfig={sourceAxis === "x" ? twoD.xAxis : twoD.yAxis}
            setAxisConfig={(config: YAxisConfig | undefined) => updateGraph2D(
              axisDialog.role,
              sourceAxis === "x" ? { xAxis: config } : { yAxis: config },
            )}
            onClose={() => setAxisDialog(null)}
          />
        );
      })()}
    </AnalysisShell>
  );
}

function DistributionAnalysisPendingSurface({
  item,
  dataset,
  state,
  onOpenAxisSettings,
  onAxisRangeChange,
  renderGraph,
}: {
  item: DistributionAnalysisResultsProps["item"];
  dataset: DistributionAnalysisResultsProps["dataset"];
  state: ReturnType<typeof useAnalysisExecution>;
  onOpenAxisSettings?: () => void;
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
  renderGraph?: DistributionGraphRenderer;
}) {
  const { t } = useTranslation();
  const documentTitle = item.definition.responses.map((field) => field.name).join(", ") || item.name;

  return (
    <AnalysisFrame title={documentTitle} data-analysis-document>
      <AnalysisStack>
        {dataset == null ? (
          <AnalysisFrame title={t("graph.distribution", { defaultValue: "Distribution" })} data-analysis-block="graph">
            <AnalysisText>{t("workspace.analysisSourceMissing")}</AnalysisText>
          </AnalysisFrame>
        ) : (
          <AnalysisGraph
            title={t("graph.distribution", { defaultValue: "Distribution" })}
            graphRole="distributionComposite"
            data-analysis-block="graph"
            contentClassName="analysis-graph-distribution"
            strategy={{
              mode: "builder",
              runtimeProps: {
                item: createEmbeddedGraphItem({
                  id: `analysis-graph:${item.id}:pending:distributionComposite`,
                  name: `${documentTitle} Distribution`,
                  sourceDatasetId: item.source.datasetId,
                  config: createDistributionGraphBuilderConfig(
                    item.definition.graphs.overview,
                    item.definition.graphs.boxPlot,
                    item.definition.responses,
                  ),
                  createdAt: item.createdAt,
                }),
                dataset,
                panelLayout: "fit",
                externalDataState: state.status === "error"
                  ? { status: "error", frame: null, error: state.error }
                  : { status: "loading", frame: null, error: null },
                onYAxisDblClick: onOpenAxisSettings,
                onAxisRangeChange,
              },
            }}
            renderGraph={renderGraph}
          />
        )}
        <AnalysisFrame
          title={t("distribution.report.title", { defaultValue: "Statistical Report" })}
          data-analysis-block="report"
        >
          <AnalysisDistributionReport state={state} datasetMissing={dataset == null} />
        </AnalysisFrame>
      </AnalysisStack>
    </AnalysisFrame>
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
  return state.analysisKind === "distribution"
    ? <AnalysisUnavailable message={t("distribution.report.loading", { defaultValue: "Loading report..." })} />
    : null;
}

function AnalysisUnavailable({ message, alert = false }: { message: string; alert?: boolean }) {
  return <AnalysisText role={alert ? "alert" : undefined}>{message}</AnalysisText>;
}