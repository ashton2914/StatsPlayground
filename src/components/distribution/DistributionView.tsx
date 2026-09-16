import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnalysisFrame, AnalysisText } from "@/components/analysis/presentation";
import {
  getDistributionFitSelectionKey,
  getDistributionGroupName,
  type DistributionFitSelections,
  type DistributionGraphRole,
} from "@/graphCore/distributionAdapter";
import { useDistributionStore } from "@/stores/useDistributionStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { DatasetMeta } from "@/types/data";
import type { ContinuousDistributionIdV1, DistributionItem } from "@/types/distribution";

import {
  DistributionGraphGrid as DistributionViewGraphGrid,
  DistributionReportPanel,
} from "./distributionPresentation";
import { materializeDistributionGraphItems } from "./distributionPresentation";
import { createDistributionAxisRangeController } from "./distributionAxisInteractions";
import { useDistributionReport } from "./useDistributionReport";
import "./distribution.css";

export interface DistributionViewProps {
  item: DistributionItem;
  dataset?: DatasetMeta | null;
}

export { materializeDistributionGraphItems };

export function DistributionView({ item, dataset }: DistributionViewProps) {
  const { t } = useTranslation();
  const updateItem = useDistributionStore((state) => state.updateItem);
  const readOnly = useProjectStore((state) => state.readOnly);
  const markDirty = useProjectStore((state) => state.markDirty);
  const getCurrentItem = useMemo(
    () => () => useDistributionStore.getState().items.find((candidate) => candidate.id === item.id),
    [item.id],
  );
  const reportState = useDistributionReport(
    dataset ? item : null,
    dataset?.generation ?? null,
    { getCurrentItem },
  );
  const [fitSelectionState, setFitSelectionState] = useState<{
    itemId: string;
    overrides: Record<string, ContinuousDistributionIdV1>;
  }>({ itemId: item.id, overrides: {} });
  const fitSelectionOverrides = fitSelectionState.itemId === item.id
    ? fitSelectionState.overrides
    : {};
  const selectedFitDistributionIds = useMemo<DistributionFitSelections>(() => {
    if (reportState.status !== "success") return {};
    const selections: Record<string, ContinuousDistributionIdV1> = {};
    for (const group of reportState.result.groups) {
      const groupName = getDistributionGroupName(group);
      for (const result of group.yResults) {
        const fitIds = result.blocks.flatMap((block) => (
          block.distributionFitData ? [block.distributionFitData.distributionId] : []
        ));
        const firstFitId = fitIds[0];
        if (!firstFitId) continue;
        const seriesName = groupName === "Overall" ? result.yName : `${result.yName} | ${groupName}`;
        const selectionKey = getDistributionFitSelectionKey(result.yColumn.columnId, seriesName);
        const requestedFitId = fitSelectionOverrides[selectionKey];
        selections[selectionKey] = requestedFitId && fitIds.includes(requestedFitId)
          ? requestedFitId
          : firstFitId;
      }
    }
    return selections;
  }, [fitSelectionOverrides, reportState]);
  const axisController = useMemo(() => createDistributionAxisRangeController({
    getItem: () => useDistributionStore.getState().items.find((candidate) => candidate.id === item.id) ?? item,
    isReadOnly: () => useProjectStore.getState().readOnly,
    commitGraphs: (graphs) => {
      updateItem(item.id, { graphs });
      markDirty();
    },
  }), [item, markDirty, updateItem]);

  return (
    <div className="distribution-view">
      <header className="distribution-view-header">
        <div>
          <h2>{item.name}</h2>
          <span title={dataset?.name ?? t("workspace.datasourceDeleted")}>
            {dataset
              ? t("workspace.datasourceLabel", { defaultValue: "Source: {{name}}", name: dataset.name })
              : t("workspace.datasourceDeleted")}
          </span>
        </div>
      </header>

      <section className="distribution-graph-section">
        {dataset == null ? (
          <div className="workspace-empty"><AnalysisText>{t("workspace.datasourceDeleted")}</AnalysisText></div>
        ) : (
          <DistributionViewGraphGrid
            item={item}
            dataset={dataset}
            reportState={reportState}
            selectedFitDistributionIds={selectedFitDistributionIds}
            onAxisRangeChange={readOnly
              ? undefined
              : (role: DistributionGraphRole, axis: "x" | "y", min: number, max: number) => {
                  if (role !== "overview" && role !== "boxPlot") {
                    return;
                  }
                  axisController.handleAxisRangeChange(role, axis, min, max);
                }}
          />
        )}
      </section>

      {dataset == null
        ? (
          <AnalysisFrame
            className="distribution-report-section"
            title={t("distribution.report.title", { defaultValue: "Statistical Report" })}
          >
            <AnalysisText>{t("workspace.datasourceDeleted")}</AnalysisText>
          </AnalysisFrame>
        )
        : (
          <DistributionReportPanel
            reportState={reportState}
            selectedFitDistributionIds={selectedFitDistributionIds}
            onSelectedFitDistributionIdChange={(selectionKey, distributionId) => {
              setFitSelectionState((current) => ({
                itemId: item.id,
                overrides: {
                  ...(current.itemId === item.id ? current.overrides : {}),
                  [selectionKey]: distributionId,
                },
              }));
            }}
          />
        )}
    </div>
  );
}