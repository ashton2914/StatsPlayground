import { useTranslation } from "react-i18next";

import { FitYByXAnalysisReport } from "@/components/analysis/renderers/FitYByXAnalysisReport";
import {
  useAnalysisExecution,
  type UseAnalysisExecutionRuntime,
} from "@/components/analysis/useAnalysisExecution";

import type { ReportResolvedSource } from "./ReportEmbed";

export type FitYByXAnalysisReportEmbedRuntime = UseAnalysisExecutionRuntime;

export function FitYByXAnalysisReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "fitYByX" }>;
  runtime?: FitYByXAnalysisReportEmbedRuntime;
}) {
  const { t } = useTranslation();
  const state = useAnalysisExecution(source.item, source.dataset, runtime);

  return (
    <section className="sp-report-embed-card" data-kind="fitYByX">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <div data-analysis-report-kind="fitYByX">
        <FitYByXAnalysisReport document={source.item} state={state} datasetMissing={false} />
      </div>
    </section>
  );
}
