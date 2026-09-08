import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AnalysisFrame,
  AnalysisGraph,
  AnalysisShell,
  AnalysisStack,
  AnalysisText,
} from "@/components/analysis/presentation";
import type { AnalysisKindViewProps } from "@/components/analysis/analysisViewRegistry";
import { useAnalysisExecution } from "@/components/analysis/useAnalysisExecution";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { AxisSettingsDialog, isAxisConfigEmpty } from "@/components/graphBuilder/AxisSettingsDialog";
import { updateEmbeddedGraph2D, type Graph2DUpdater } from "@/components/fitYByX/fitYByXAxisInteractions";
import type { RefLineX, RefLineY, YAxisConfig } from "@/graphCore";

import { FitYByXAnalysisReport } from "./FitYByXAnalysisReport";

type FitYByXAnalysisResultsProps = AnalysisKindViewProps<"fitYByX">;

export function FitYByXAnalysisResults({
  item,
  dataset,
  runtime,
  canEditInputs = false,
  onEditInputs,
  onGraphConfigChange,
}: FitYByXAnalysisResultsProps) {
  const { t } = useTranslation();
  const [axisDialog, setAxisDialog] = useState<"x" | "y" | null>(null);
  const [axisContextMenu, setAxisContextMenu] = useState<{
    axis: "x" | "y";
    x: number;
    y: number;
  } | null>(null);
  const executionState = useAnalysisExecution(item, dataset ?? null, runtime);
  const twoD = item.presentation.graph.modeStates.twoD;
  const graphItem = useMemo(() => createEmbeddedGraphItem({
    id: `analysis-graph:${item.id}:main`,
    name: item.name,
    sourceDatasetId: item.source.datasetId,
    config: item.presentation.graph,
    createdAt: item.createdAt,
  }), [item]);
  const summary = [
    { key: "response", label: t("fitYByX.response"), value: item.definition.response.name },
    { key: "factor", label: t("fitYByX.factor"), value: item.definition.factor.name },
    { key: "personality", label: t("fitYByX.personalityLabel"), value: t(`fitYByX.personality.${item.definition.personality}`) },
  ];
  const updateGraph = useCallback((updater: Graph2DUpdater) => {
    if (!onGraphConfigChange) return;
    onGraphConfigChange("main", updateEmbeddedGraph2D(item.presentation.graph, updater));
  }, [item.presentation.graph, onGraphConfigChange]);
  const setAxisConfig = useCallback((axis: "x" | "y", config: YAxisConfig | undefined) => {
    updateGraph(axis === "x" ? { xAxis: config } : { yAxis: config });
  }, [updateGraph]);
  const resetAxisRange = useCallback((axis: "x" | "y") => {
    const current = axis === "x" ? twoD.xAxis : twoD.yAxis;
    const next = { ...(current ?? {}), min: undefined, max: undefined };
    setAxisConfig(axis, isAxisConfigEmpty(next) ? undefined : next);
    setAxisContextMenu(null);
  }, [setAxisConfig, twoD.xAxis, twoD.yAxis]);

  useEffect(() => {
    if (!axisContextMenu) return;
    const close = () => setAxisContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [axisContextMenu]);

  return (
    <div data-analysis-kind="fitYByX">
      <AnalysisShell
        title={item.name}
        sourceName={dataset?.name ?? t("workspace.analysisSourceMissing")}
        summary={summary}
        canEditInputs={canEditInputs && dataset != null}
        onEditInputs={onEditInputs}
      >
        <AnalysisFrame title={item.definition.response.name} contentPadding="compact" data-analysis-document>
          <AnalysisStack>
            {dataset == null ? (
              <AnalysisFrame title={t("fitYByX.graph")} data-analysis-block="graph">
                <AnalysisText>{t("workspace.analysisSourceMissing")}</AnalysisText>
              </AnalysisFrame>
            ) : (
              <AnalysisGraph
                title={t("fitYByX.graph")}
                graphRole="main"
                data-analysis-block="graph"
                strategy={{
                  mode: "builder",
                  runtimeProps: {
                    item: graphItem,
                    dataset,
                    panelLayout: "fit",
                    onXAxisDblClick: onGraphConfigChange ? () => setAxisDialog("x") : undefined,
                    onYAxisDblClick: onGraphConfigChange ? () => setAxisDialog("y") : undefined,
                    onAxisRangeChange: onGraphConfigChange
                      ? (axis, min, max) => updateGraph((current) => {
                          const config = axis === "x" ? current.xAxis : current.yAxis;
                          return axis === "x"
                            ? { xAxis: { ...(config ?? {}), min, max } }
                            : { yAxis: { ...(config ?? {}), min, max } };
                        })
                      : undefined,
                    onAxisContextMenu: onGraphConfigChange
                      ? (axis, x, y) => setAxisContextMenu({ axis, x, y })
                      : undefined,
                  },
                }}
                renderGraph={runtime?.renderGraph
                  ? (props) => runtime.renderGraph?.({ ...props, role: "main" })
                  : undefined}
              />
            )}

            <AnalysisFrame title={t("fitYByX.report.title")} data-analysis-block="report">
              <FitYByXAnalysisReport
                document={item}
                state={executionState}
                datasetMissing={dataset == null}
              />
            </AnalysisFrame>
          </AnalysisStack>
        </AnalysisFrame>
        {axisDialog && (
          <AxisSettingsDialog
            axis={axisDialog}
            refLines={axisDialog === "x" ? twoD.refLinesX ?? [] : twoD.refLinesY ?? []}
            setRefLines={axisDialog === "x"
              ? (lines: RefLineX[]) => updateGraph({ refLinesX: lines })
              : (lines: RefLineY[]) => updateGraph({ refLinesY: lines })}
            autoSpecLines={axisDialog === "x"
              ? !!twoD.autoSpecLinesX
              : !!(twoD.autoSpecLinesY ?? twoD.autoSpecLines)}
            setAutoSpecLines={(enabled) => updateGraph(
              axisDialog === "x" ? { autoSpecLinesX: enabled } : { autoSpecLinesY: enabled },
            )}
            axisConfig={axisDialog === "x" ? twoD.xAxis : twoD.yAxis}
            setAxisConfig={(config) => setAxisConfig(axisDialog, config)}
            onClose={() => setAxisDialog(null)}
          />
        )}
        {axisContextMenu && (() => {
          const config = axisContextMenu.axis === "x" ? twoD.xAxis : twoD.yAxis;
          const zoomed = config?.min !== undefined || config?.max !== undefined;
          return (
            <div
              className="sp-ctx-menu"
              style={{ left: axisContextMenu.x, top: axisContextMenu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <div
                className="sp-ctx-item"
                onClick={() => {
                  setAxisDialog(axisContextMenu.axis);
                  setAxisContextMenu(null);
                }}
              >
                {t("graph.axisCtx.settings", { defaultValue: "Axis settings" })}
              </div>
              <div
                className={`sp-ctx-item${zoomed ? "" : " sp-ctx-disabled"}`}
                aria-disabled={!zoomed}
                onClick={() => { if (zoomed) resetAxisRange(axisContextMenu.axis); }}
              >
                {t("graph.axisCtx.resetZoom", { defaultValue: "Reset zoom" })}
              </div>
            </div>
          );
        })()}
      </AnalysisShell>
    </div>
  );
}
