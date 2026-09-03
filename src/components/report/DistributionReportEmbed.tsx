import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  DistributionGraphGrid,
  DistributionReportPanel,
} from "@/components/distribution/distributionPresentation";
import {
  useDistributionReport,
  type DistributionReportDependencies,
} from "@/components/distribution/useDistributionReport";
import type { GraphRuntimeProps } from "@/components/graphBuilder/GraphRuntime";
import type { DistributionGraphRole } from "@/graphCore/distributionAdapter";

import type { ReportResolvedSource } from "./ReportEmbed";

export interface DistributionReportEmbedRuntime extends Partial<DistributionReportDependencies> {
  renderGraph?: (props: GraphRuntimeProps & { role: DistributionGraphRole }) => ReactNode;
}

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

  return (
    <section className="sp-report-embed-card" data-kind="distribution">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <div className="sp-report-distribution-graphs">
        <DistributionGraphGrid
          item={source.item}
          dataset={source.dataset}
          reportState={reportState}
          renderGraph={runtime?.renderGraph}
        />
      </div>
      <div className="sp-report-distribution-details">
        <DistributionReportPanel reportState={reportState} />
      </div>
    </section>
  );
}