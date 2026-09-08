import { useTranslation } from "react-i18next";

import {
  AnalysisStack,
  AnalysisTable,
  AnalysisText,
} from "@/components/analysis/presentation";
import type { AnalysisExecutionState } from "@/components/analysis/useAnalysisExecution";
import type { FitYByXAnalysisDocument } from "@/types/analysis";

import { createFitYByXAnalysisReportModel } from "./fitYByXAnalysisModel";

interface FitYByXAnalysisReportProps {
  document: FitYByXAnalysisDocument;
  state: AnalysisExecutionState;
  datasetMissing: boolean;
}

export function FitYByXAnalysisReport({
  document,
  state,
  datasetMissing,
}: FitYByXAnalysisReportProps) {
  const { t } = useTranslation();
  const model = createFitYByXAnalysisReportModel({
    document,
    state,
    datasetMissing,
    translate: (key, values) => t(key, values),
  });

  return (
    <AnalysisStack role={model.alert ? "alert" : undefined}>
      <AnalysisText>
        {t("fitYByX.report.personality")}: {model.summary.personality}; {t("fitYByX.report.usedRows")}: {model.summary.usedRows}; {t("fitYByX.report.excludedRows")}: {model.summary.excludedRows}
      </AnalysisText>
      {model.sections.map((section) => (
        <AnalysisTable
          key={section.key}
          title={section.title}
          columns={section.columns}
          rows={section.rows}
          width={section.width}
          ariaLabel={section.title}
        />
      ))}
    </AnalysisStack>
  );
}
