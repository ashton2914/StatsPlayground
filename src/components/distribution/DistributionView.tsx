import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  type DistributionGraphRole,
} from "@/graphCore/distributionAdapter";
import { useDistributionStore } from "@/stores/useDistributionStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";

import {
  DistributionGraphGrid,
  DistributionReportPanel,
  materializeDistributionGraphItems,
} from "./distributionPresentation";
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
          <div className="workspace-empty"><p>{t("workspace.datasourceDeleted")}</p></div>
        ) : (
          <DistributionGraphGrid
            item={item}
            dataset={dataset}
            reportState={reportState}
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
          <section className="distribution-report-section">
            <h2>{t("distribution.report.title", { defaultValue: "Statistical Report" })}</h2>
            <p className="distribution-report-unavailable">{t("workspace.datasourceDeleted")}</p>
          </section>
        )
        : <DistributionReportPanel reportState={reportState} />}
    </div>
  );
}