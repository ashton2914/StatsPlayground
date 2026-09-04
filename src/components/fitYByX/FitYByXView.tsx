import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AxisSettingsDialog, isAxisConfigEmpty } from "@/components/graphBuilder/AxisSettingsDialog";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { GraphRuntime } from "@/components/graphBuilder/GraphRuntime";
import type { RefLineX, RefLineY, YAxisConfig } from "@/graphCore";
import { useFitYByXStore } from "@/stores/useFitYByXStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { DatasetMeta } from "@/types/data";
import type { FitYByXItem } from "@/types/fitYByX";

import { FitYByXReport } from "./FitYByXReport";
import { updateEmbeddedGraph2D, type Graph2DUpdater } from "./fitYByXAxisInteractions";
import { useFitYByXReport } from "./useFitYByXReport";

export interface FitYByXViewProps {
  item: FitYByXItem;
  dataset: DatasetMeta | undefined;
}

export function FitYByXView({ item, dataset }: FitYByXViewProps) {
  const { t } = useTranslation();
  const updateItem = useFitYByXStore((state) => state.updateItem);
  const markDirty = useProjectStore((state) => state.markDirty);
  const readOnly = useProjectStore((state) => state.readOnly);
  const [axisDialog, setAxisDialog] = useState<"x" | "y" | null>(null);
  const [axisContextMenu, setAxisContextMenu] = useState<{ axis: "x" | "y"; x: number; y: number } | null>(null);
  const reportState = useFitYByXReport(dataset ? item : null, dataset?.generation ?? null);
  const twoD = item.graph.modeStates.twoD;

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

  const updateGraph = useCallback((updater: Graph2DUpdater) => {
    if (readOnly) return;
    const currentItem = useFitYByXStore.getState().items.find((candidate) => candidate.id === item.id) ?? item;
    const nextGraph = updateEmbeddedGraph2D(currentItem.graph, updater);
    updateItem(item.id, { graph: nextGraph });
    markDirty();
  }, [item, markDirty, readOnly, updateItem]);

  const setAxisConfig = useCallback((axis: "x" | "y", config: YAxisConfig | undefined) => {
    updateGraph(axis === "x" ? { xAxis: config } : { yAxis: config });
  }, [updateGraph]);

  const handleAxisRangeChange = useCallback((axis: "x" | "y", min: number, max: number) => {
    updateGraph((current) => {
      const axisConfig = axis === "x" ? current.xAxis : current.yAxis;
      return axis === "x"
        ? { xAxis: { ...(axisConfig ?? {}), min, max } }
        : { yAxis: { ...(axisConfig ?? {}), min, max } };
    });
  }, [updateGraph]);

  const resetAxisRange = useCallback((axis: "x" | "y") => {
    const current = axis === "x" ? twoD.xAxis : twoD.yAxis;
    const next = { ...(current ?? {}), min: undefined, max: undefined };
    setAxisConfig(axis, isAxisConfigEmpty(next) ? undefined : next);
    setAxisContextMenu(null);
  }, [setAxisConfig, twoD.xAxis, twoD.yAxis]);

  const graphItem = useMemo(
    () => createEmbeddedGraphItem({
      id: `fit-y-by-x-graph:${item.id}`,
      name: item.name,
      sourceDatasetId: item.sourceDatasetId,
      config: item.graph,
      createdAt: item.createdAt,
    }),
    [item],
  );

  return (
    <div className="sp-fit-y-by-x-view">
      <section className="sp-fit-y-by-x-summary">
        <div className="sp-panel-header">
          <div className="sp-tabulate-heading-copy">
            <span className="sp-panel-header-title">{item.name}</span>
            <span className="sp-tabulate-source-label" title={dataset ? dataset.name : t("workspace.datasourceDeleted")}>
              {dataset
                ? t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })
                : t("workspace.datasourceDeleted")}
            </span>
          </div>
        </div>

        <div className="sp-fit-y-by-x-summary-body">
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.response")}</span>
            <span className="sp-fit-y-by-x-summary-value">{item.response.name}</span>
          </div>
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.factor")}</span>
            <span className="sp-fit-y-by-x-summary-value">{item.factor.name}</span>
          </div>
          <div className="sp-fit-y-by-x-summary-row">
            <span className="sp-fit-y-by-x-summary-label">{t("fitYByX.personalityLabel")}</span>
            <span className="sp-fit-y-by-x-summary-value">{t(`fitYByX.personality.${item.personality}`)}</span>
          </div>
        </div>
      </section>

      <div className="sp-fit-y-by-x-analysis-root">
        <section className="sp-fit-y-by-x-runtime-panel">
          <div className="sp-panel-header">
            <span className="sp-panel-header-title">{t("fitYByX.graph")}</span>
            <span className="sp-tabulate-header-hint">{t("fitYByX.graphHint")}</span>
          </div>

          <div className="sp-fit-y-by-x-graph-shell">
            {dataset == null ? (
              <div className="main-content">
                <div className="workspace-empty">
                  <p>{t("workspace.datasourceDeleted")}</p>
                </div>
              </div>
            ) : (
              <GraphRuntime
                item={graphItem}
                dataset={dataset}
                onYAxisDblClick={readOnly ? undefined : () => setAxisDialog("y")}
                onXAxisDblClick={readOnly ? undefined : () => setAxisDialog("x")}
                onAxisRangeChange={readOnly ? undefined : handleAxisRangeChange}
                onAxisContextMenu={readOnly ? undefined : (axis, x, y) => setAxisContextMenu({ axis, x, y })}
              />
            )}
          </div>
        </section>

        <FitYByXReport item={item} state={reportState} datasetMissing={dataset == null} />
      </div>

      {axisDialog && (
        <AxisSettingsDialog
          axis={axisDialog}
          refLines={axisDialog === "x" ? twoD.refLinesX ?? [] : twoD.refLinesY ?? []}
          setRefLines={axisDialog === "x"
            ? (lines: RefLineX[]) => updateGraph({ refLinesX: lines })
            : (lines: RefLineY[]) => updateGraph({ refLinesY: lines })}
          autoSpecLines={axisDialog === "x" ? !!twoD.autoSpecLinesX : !!(twoD.autoSpecLinesY ?? twoD.autoSpecLines)}
          setAutoSpecLines={(enabled) => updateGraph(axisDialog === "x" ? { autoSpecLinesX: enabled } : { autoSpecLinesY: enabled })}
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
            <div className="sp-ctx-item" onClick={() => { setAxisDialog(axisContextMenu.axis); setAxisContextMenu(null); }}>
              {t("graph.axisCtx.settings", { defaultValue: "Axis settings" })}
            </div>
            <div className={`sp-ctx-item${zoomed ? "" : " sp-ctx-disabled"}`} aria-disabled={!zoomed} onClick={() => { if (zoomed) resetAxisRange(axisContextMenu.axis); }}>
              {t("graph.axisCtx.resetZoom", { defaultValue: "Reset zoom" })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}