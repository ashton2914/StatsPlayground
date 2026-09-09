import { useTranslation } from "react-i18next";

import type { AnalysisViewRuntime } from "@/components/analysis/analysisViewRegistry";
import { DistributionAnalysisResults } from "@/components/analysis/renderers/DistributionAnalysisResults";
import {
  DistributionGraphGrid as ReportDistributionGraphGrid,
  DistributionReportPanel,
} from "@/components/distribution/distributionPresentation";
import {
  useDistributionReport,
  type DistributionReportDependencies,
} from "@/components/distribution/useDistributionReport";

import type { ReportResolvedSource } from "./ReportEmbed";

export interface DistributionReportEmbedRuntime
  extends Partial<DistributionReportDependencies>, Pick<AnalysisViewRuntime, "renderGraph"> {}

export function DistributionReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "distribution" }>;
  runtime?: DistributionReportEmbedRuntime;
}) {
  const { t } = useTranslation();

  if (source.origin === "analysis") {
    return (
      <section data-analysis-report-kind="distribution" data-kind="distribution">
        <DistributionAnalysisResults
          item={source.item}
          dataset={source.dataset}
          runtime={runtime}
        />
      </section>
    );
  }

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
        <ReportDistributionGraphGrid
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