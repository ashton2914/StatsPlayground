import { useTranslation } from "react-i18next";

import { FitYByXReport } from "@/components/fitYByX/FitYByXReport";
import {
  useFitYByXReport,
  type FitYByXReportDependencies,
} from "@/components/fitYByX/useFitYByXReport";

import type { ReportResolvedSource } from "./ReportEmbed";

export type FitYByXReportEmbedRuntime = Partial<FitYByXReportDependencies>;

export function FitYByXReportEmbed({
  source,
  runtime,
}: {
  source: Extract<ReportResolvedSource, { kind: "fitYByX" }>;
  runtime?: FitYByXReportEmbedRuntime;
}) {
  const { t } = useTranslation();
  const state = useFitYByXReport(source.item, source.dataset.updatedAt, runtime);

  return (
    <section className="sp-report-embed-card" data-kind="fitYByX">
      <div className="sp-report-embed-header">
        <span className="sp-report-embed-title">{source.name}</span>
        <span className="sp-report-embed-meta">{t("workspace.datasourceLabel", { name: source.dataset.name })}</span>
      </div>
      <FitYByXReport item={source.item} state={state} datasetMissing={false} />
    </section>
  );
}