import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { GraphRuntime } from "@/components/graphBuilder/GraphRuntime";
import {
  DISTRIBUTION_GRAPH_ROLES,
  mapDistributionExternalDataState,
  type DistributionGraphRole,
} from "@/graphCore/distributionAdapter";
import { useDistributionStore } from "@/stores/useDistributionStore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem } from "@/types/distribution";
import type { GraphBuilderItem } from "@/types/graphBuilder";

import { DistributionReport } from "./DistributionReport";
import { createDistributionAxisRangeController } from "./distributionAxisInteractions";
import { useDistributionReport } from "./useDistributionReport";
import "./distribution.css";

export interface DistributionViewProps {
  item: DistributionItem;
  dataset?: DatasetMeta | null;
}

const GRAPH_TITLE_KEYS: Record<DistributionGraphRole, string> = {
  overview: "distribution.report.overview",
  boxPlot: "distribution.report.outlierBoxPlot",
  ecdf: "distribution.report.ecdf",
  normalQuantile: "distribution.report.normalQuantilePlot",
};

export function materializeDistributionGraphItems(
  item: DistributionItem,
): Record<DistributionGraphRole, GraphBuilderItem> {
  return Object.fromEntries(DISTRIBUTION_GRAPH_ROLES.map((role) => [
    role,
    createEmbeddedGraphItem({
      id: `distribution-graph:${item.id}:${role}`,
      name: `${item.name} ${role}`,
      sourceDatasetId: item.sourceDatasetId,
      config: item.graphs[role],
      createdAt: item.createdAt,
    }),
  ])) as Record<DistributionGraphRole, GraphBuilderItem>;
}

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
  const graphItems = useMemo(() => materializeDistributionGraphItems(item), [item]);
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
          <div className="distribution-graph-grid">
            {DISTRIBUTION_GRAPH_ROLES.map((role) => (
              <section className="distribution-graph-region" key={role} data-graph-role={role}>
                <h3>{t(GRAPH_TITLE_KEYS[role])}</h3>
                <div className="distribution-graph-runtime">
                  <GraphRuntime
                    item={graphItems[role]}
                    dataset={dataset}
                    externalDataState={mapDistributionExternalDataState(reportState, role)}
                    onAxisRangeChange={readOnly || (role !== "overview" && role !== "boxPlot")
                      ? undefined
                      : (axis, min, max) => axisController.handleAxisRangeChange(role, axis, min, max)}
                  />
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      <section className="distribution-report-section">
        <h2>{t("distribution.report.title", { defaultValue: "Statistical Report" })}</h2>
        {dataset == null && <p className="distribution-report-unavailable">{t("workspace.datasourceDeleted")}</p>}
        {dataset != null && (reportState.status === "idle" || reportState.status === "loading") && (
          <p className="distribution-report-status">{t("distribution.report.loading", { defaultValue: "Loading report..." })}</p>
        )}
        {dataset != null && reportState.status === "error" && (
          <p className="distribution-report-unavailable" role="alert">{reportState.error}</p>
        )}
        {reportState.status === "success" && (
          <DistributionReport groups={reportState.result.groups} reportBlocks={reportState.result.reportBlocks} />
        )}
      </section>
    </div>
  );
}