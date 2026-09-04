import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DistributionReport } from "@/components/distribution/DistributionReport";
import { materializeDistributionGraphItems } from "@/components/distribution/DistributionView";
import {
  useDistributionReport,
  type DistributionReportDependencies,
} from "@/components/distribution/useDistributionReport";
import { GraphRuntime, type GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import {
  DISTRIBUTION_GRAPH_ROLES,
  mapDistributionExternalDataState,
  type DistributionGraphRole,
} from "@/graphCore/distributionAdapter";

import type { ReportResolvedSource } from "./ReportEmbed";

export interface DistributionReportEmbedRuntime extends Partial<DistributionReportDependencies> {
  renderGraph?: (props: GraphRuntimeProps & { role: DistributionGraphRole }) => ReactNode;
}

const GRAPH_TITLE_KEYS: Record<DistributionGraphRole, string> = {
  overview: "distribution.report.overview",
  boxPlot: "distribution.report.outlierBoxPlot",
  ecdf: "distribution.report.ecdf",
  normalQuantile: "distribution.report.normalQuantilePlot",
};

export function DistributionReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "distribution" }>;
  runtime?: DistributionReportEmbedRuntime;
}) {
  const { t } = useTranslation();
  const reportState = useDistributionReport(
    source.item,
    source.dataset.generation ?? source.dataset.updatedAt,
    runtime,
  );
  const graphItems = useMemo(() => materializeDistributionGraphItems(source.item), [source.item]);

  return (
    <section className="sp-report-embed-card" data-kind="distribution">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <div className="distribution-graph-grid sp-report-distribution-graphs">
        {DISTRIBUTION_GRAPH_ROLES.map((role) => {
          const graphProps = {
            item: graphItems[role],
            dataset: source.dataset,
            externalDataState: mapDistributionExternalDataState(reportState, role),
            role,
          };
          return (
            <section className="distribution-graph-region" key={role} data-graph-role={role}>
              <h3>{t(GRAPH_TITLE_KEYS[role])}</h3>
              <div className="distribution-graph-runtime">
                {runtime?.renderGraph ? runtime.renderGraph(graphProps) : <GraphRuntime {...graphProps} />}
              </div>
            </section>
          );
        })}
      </div>
      <div className="sp-report-distribution-details">
        {(reportState.status === "idle" || reportState.status === "loading") && (
          <p className="distribution-report-status">{t("distribution.report.loading", { defaultValue: "Loading report..." })}</p>
        )}
        {reportState.status === "error" && (
          <p className="distribution-report-unavailable" role="alert">{reportState.error}</p>
        )}
        {reportState.status === "success" && (
          <DistributionReport groups={reportState.result.groups} reportBlocks={reportState.result.reportBlocks} />
        )}
      </div>
    </section>
  );
}