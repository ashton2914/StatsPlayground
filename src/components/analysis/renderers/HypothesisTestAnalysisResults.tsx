import { useTranslation } from "react-i18next";

import type { AnalysisKindViewProps } from "@/components/analysis/analysisViewRegistry";
import {
  AnalysisFrame,
  AnalysisShell,
  AnalysisStack,
} from "@/components/analysis/presentation";
import { useAnalysisExecution } from "@/components/analysis/useAnalysisExecution";

import { HypothesisTestAnalysisReport } from "./HypothesisTestAnalysisReport";

type HypothesisTestAnalysisResultsProps = AnalysisKindViewProps<"hypothesisTest">;

export function HypothesisTestAnalysisResults({
  item,
  dataset,
  runtime,
  canEditInputs = false,
  onEditInputs,
}: HypothesisTestAnalysisResultsProps) {
  const { t } = useTranslation();
  const state = useAnalysisExecution(item, dataset ?? null, runtime);
  const roles = item.definition.roles;
  const response = roles.layout === "long"
    ? roles.response.name
    : roles.measurements.map((field) => field.name).join(", ");

  return (
    <AnalysisShell
      title={item.name}
      sourceName={dataset?.name ?? t("workspace.analysisSourceMissing")}
      summary={[
        { key: "response", label: t("hypothesisTest.response", { defaultValue: "Response" }), value: response },
        {
          key: "studyDesign",
          label: t("hypothesisTest.studyDesign.label", { defaultValue: "Study design" }),
          value: t(`hypothesisTest.studyDesign.${item.definition.studyDesign}`),
        },
      ]}
      canEditInputs={canEditInputs && dataset != null}
      onEditInputs={onEditInputs}
    >
      <AnalysisStack>
        <AnalysisFrame
          title={t("hypothesisTest.title", { defaultValue: "Hypothesis Test" })}
          contentPadding="compact"
          data-analysis-document
          data-analysis-kind="hypothesisTest"
        >
          <HypothesisTestAnalysisReport
            state={state}
            datasetMissing={dataset == null}
            presentation={item.presentation}
          />
        </AnalysisFrame>
      </AnalysisStack>
    </AnalysisShell>
  );
}