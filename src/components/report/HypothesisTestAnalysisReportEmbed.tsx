import { useTranslation } from "react-i18next";

import { HypothesisTestAnalysisReport } from "@/components/analysis/renderers/HypothesisTestAnalysisReport";
import {
  useAnalysisExecution,
  type UseAnalysisExecutionRuntime,
} from "@/components/analysis/useAnalysisExecution";

import type { ReportResolvedSource } from "./ReportEmbed";

export type HypothesisTestAnalysisReportEmbedRuntime = UseAnalysisExecutionRuntime;

export function HypothesisTestAnalysisReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "hypothesisTest" }>;
  runtime?: HypothesisTestAnalysisReportEmbedRuntime;
}) {
  const { t } = useTranslation();
  const state = useAnalysisExecution(source.item, source.dataset, runtime);
  return (
    <section className="sp-report-embed-card" data-kind="hypothesisTest">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <div data-analysis-report-kind="hypothesisTest">
        <HypothesisTestAnalysisReport
          state={state}
          datasetMissing={false}
          presentation={source.item.presentation}
        />
      </div>
    </section>
  );
}