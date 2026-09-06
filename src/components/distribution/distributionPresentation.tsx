import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { GraphRuntime } from "@/components/graphBuilder/GraphRuntime";
import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import {
  DISTRIBUTION_GRAPH_ROLES,
  mapDistributionExternalDataState,
  type DistributionGraphRole,
  type DistributionFrameSourceState,
} from "@/graphCore/distributionAdapter";
import type { DatasetMeta } from "@/types/data";
import type { DistributionItem, DistributionReportResponse } from "@/types/distribution";
import type { GraphBuilderItem } from "@/types/graphBuilder";

import { DistributionReport } from "./DistributionReport";

const GRAPH_TITLE_KEYS: Record<DistributionGraphRole, string> = {
  overview: "distribution.report.overview",
  boxPlot: "distribution.report.outlierBoxPlot",
  ecdf: "distribution.report.ecdf",
  normalQuantile: "distribution.report.normalQuantilePlot",
};

export interface DistributionPresentationSource {
  id: string;
  name: string;
  sourceDatasetId: string;
  graphs: DistributionItem["graphs"];
  createdAt: string;
}

export type DistributionExecutionLikeState =
  | { status: "idle" | "loading" }
  | { status: "error"; error: string }
  | { status: "success"; result: DistributionReportResponse };

export interface DistributionGraphGridProps {
  item: DistributionPresentationSource;
  dataset: DatasetMeta;
  reportState: DistributionFrameSourceState;
  renderGraph?: (props: GraphRuntimeProps & { role: DistributionGraphRole }) => ReactNode;
  onAxisRangeChange?: (
    role: DistributionGraphRole,
    axis: "x" | "y",
    min: number,
    max: number,
  ) => void;
}

export function materializeDistributionGraphItems(
  item: DistributionPresentationSource,
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

export function DistributionGraphGrid({
  item,
  dataset,
  reportState,
  renderGraph,
  onAxisRangeChange,
}: DistributionGraphGridProps) {
  const { t } = useTranslation();
  const graphItems = useMemo(() => materializeDistributionGraphItems(item), [item]);

  return (
    <div className="distribution-graph-grid">
      {DISTRIBUTION_GRAPH_ROLES.map((role) => {
        const graphProps = {
          item: graphItems[role],
          dataset,
          externalDataState: mapDistributionExternalDataState(reportState, role),
          onAxisRangeChange: onAxisRangeChange == null
            ? undefined
            : (axis: "x" | "y", min: number, max: number) => onAxisRangeChange(role, axis, min, max),
          role,
        };

        return (
          <section className="distribution-graph-region" key={role} data-graph-role={role}>
            <h3>{t(GRAPH_TITLE_KEYS[role])}</h3>
            <div className="distribution-graph-runtime">
              {renderGraph ? renderGraph(graphProps) : <GraphRuntime {...graphProps} />}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function DistributionReportPanel({ reportState }: { reportState: DistributionExecutionLikeState }) {
  const { t } = useTranslation();

  return (
    <section className="distribution-report-section">
      <h2>{t("distribution.report.title", { defaultValue: "Statistical Report" })}</h2>
      {(reportState.status === "idle" || reportState.status === "loading") && (
        <p className="distribution-report-status">{t("distribution.report.loading", { defaultValue: "Loading report..." })}</p>
      )}
      {reportState.status === "error" && (
        <p className="distribution-report-unavailable" role="alert">{reportState.error}</p>
      )}
      {reportState.status === "success" && (
        <DistributionReport groups={reportState.result.groups} reportBlocks={reportState.result.reportBlocks} />
      )}
    </section>
  );
}