import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { describeAnalysisDocument } from "@/components/analysis/analysisEditorRegistry";
import { createDistributionGraphBuilderConfig } from "@/components/analysis/distributionCompositeGraph";
import { AnalysisFrame } from "@/components/analysis/presentation/AnalysisFrame";
import { AnalysisGraph } from "@/components/analysis/presentation/AnalysisGraph";
import { AnalysisShell } from "@/components/analysis/presentation/AnalysisShell";
import { AnalysisStack } from "@/components/analysis/presentation/AnalysisStack";
import { AnalysisText } from "@/components/analysis/presentation/AnalysisText";
import type { AnalysisKindViewProps } from "@/components/analysis/analysisViewRegistry";
import { useAnalysisExecution } from "@/components/analysis/useAnalysisExecution";
import { DistributionReport } from "@/components/distribution/DistributionReport";
import { AxisSettingsDialog } from "@/components/graphBuilder/AxisSettingsDialog";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import type { RefLineX, RefLineY, YAxisConfig } from "@/graphCore";
import {
  mapDistributionCompositeExternalDataState,
  type DistributionFrameSourceState,
} from "@/graphCore/distributionAdapter";
import type { DistributionReportResponse } from "@/types/distribution";
import type { Graph2DState } from "@/types/graphBuilder";

type DistributionAnalysisResultsProps = AnalysisKindViewProps<"distribution">;
type DistributionBuilderGraphRole = "overview";

function toDistributionFrameSourceState(
  state: ReturnType<typeof useAnalysisExecution>,
): DistributionFrameSourceState {
  if (state.status === "success") {
    return state.analysisKind === "distribution" ? state : { status: "loading" };
  }
  if (state.status === "error") return { status: "error", error: state.error };
  return { status: state.status };
}

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
    axis: "x" | "y";
  } | null>(null);
  const executionState = useAnalysisExecution(item, dataset ?? null, runtime);
  const graphItems = useMemo(() => ({
    distributionComposite: createEmbeddedGraphItem({
      id: `analysis-graph:${item.id}:distributionComposite`,
      name: item.name,
      sourceDatasetId: item.source.datasetId,
      config: createDistributionGraphBuilderConfig(
        item.definition.graphs.overview,
        item.definition.graphs.boxPlot,
        item.definition.responses,
      ),
      createdAt: item.createdAt,
    }),
  }), [item]);
  const responseName = item.definition.responses.map((response) => response.name).join(", ") || item.name;
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
      <AnalysisFrame title={responseName} contentPadding="compact" data-analysis-document>
        <AnalysisStack>
          {dataset == null ? (
            <AnalysisFrame title={t("menu.graph", { defaultValue: "Graph" })} data-analysis-block="graph">
              <AnalysisUnavailable message={t("workspace.analysisSourceMissing")} />
            </AnalysisFrame>
          ) : (
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
                  externalDataState: mapDistributionCompositeExternalDataState(
                    toDistributionFrameSourceState(executionState),
                  ),
                  onXAxisDblClick: onGraphConfigChange
                    ? () => setAxisDialog({ role: "overview", axis: "x" })
                    : undefined,
                  onYAxisDblClick: onGraphConfigChange
                    ? () => setAxisDialog({ role: "overview", axis: "y" })
                    : undefined,
                },
              }}
              renderGraph={runtime?.renderGraph
                ? (props) => runtime.renderGraph?.({ ...props, role: "overview" })
                : undefined}
            />
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
            autoSpecLines={axisDialog.axis === "x"
              ? !!twoD.autoSpecLinesX
              : !!(twoD.autoSpecLinesY ?? twoD.autoSpecLines)}
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

function AnalysisTextBlock({ state }: { state: ReturnType<typeof useAnalysisExecution> }) {
  const result = state.status === "success" && state.analysisKind === "distribution"
    ? firstResult(state.result)
    : null;
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
  if (state.analysisKind !== "distribution") return null;

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