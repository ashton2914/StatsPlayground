import { useTranslation } from "react-i18next";

import {
  AnalysisFrame,
  AnalysisGraph,
  AnalysisStack,
  AnalysisTable,
  AnalysisText,
} from "@/components/analysis/presentation";
import type { AnalysisExecutionState } from "@/components/analysis/useAnalysisExecution";
import type { HypothesisTestAnalysisPresentation } from "@/types/hypothesisTest";

import { HypothesisTestChart } from "./HypothesisTestChart";
import { createHypothesisTestDisplayModel } from "./hypothesisTestAnalysisModel";
import {
  buildHypothesisTestDiagnosticOption,
  buildHypothesisTestMainOption,
  buildHypothesisTestQqOption,
} from "./hypothesisTestGraphOptions";

interface HypothesisTestAnalysisReportProps {
  state: AnalysisExecutionState;
  datasetMissing: boolean;
  presentation: HypothesisTestAnalysisPresentation;
}

export function HypothesisTestAnalysisReport({
  state,
  datasetMissing,
  presentation,
}: HypothesisTestAnalysisReportProps) {
  const { t } = useTranslation();
  if (datasetMissing) return <AnalysisText role="alert">The source dataset is unavailable.</AnalysisText>;
  if (state.status === "error" && state.analysisKind === "hypothesisTest") {
    return <AnalysisText role="alert">{state.error}</AnalysisText>;
  }
  if (state.status !== "success" || state.analysisKind !== "hypothesisTest") {
    return <AnalysisText role="status">Running hypothesis test...</AnalysisText>;
  }

  const model = createHypothesisTestDisplayModel(state.result);
  const graphLabels = {
    distribution: t("hypothesisTest.graph.distribution"),
    observations: t("hypothesisTest.graph.observations"),
    meanInterval: t("hypothesisTest.graph.meanInterval"),
    subjectProfile: t("hypothesisTest.graph.subjectProfile"),
    responseAxis: t("hypothesisTest.graph.responseAxis"),
    observationOrderAxis: t("hypothesisTest.graph.observationOrderAxis"),
    groupResiduals: t("hypothesisTest.graph.groupResiduals"),
    pairedDifferences: t("hypothesisTest.graph.pairedDifferences"),
    additiveResiduals: t("hypothesisTest.graph.additiveResiduals"),
    theoreticalQuantileAxis: t("hypothesisTest.graph.theoreticalQuantileAxis"),
    observedDiagnosticAxis: t("hypothesisTest.graph.observedDiagnosticAxis"),
    diagnosticValues: t("hypothesisTest.graph.diagnosticValues"),
    reference: t("hypothesisTest.graph.reference"),
  };
  const dataAndEstimatesTitle = t("hypothesisTest.graph.dataAndEstimates");
  const diagnosticValuesTitle = t("hypothesisTest.graph.diagnosticValues");
  const normalQqTitle = t("hypothesisTest.graph.normalQq");
  const mainOption = buildHypothesisTestMainOption(state.result.plotData, presentation.graphs, graphLabels);
  const diagnosticOption = presentation.graphs.showDiagnostics
    ? buildHypothesisTestDiagnosticOption(state.result.plotData, graphLabels)
    : null;
  const qqOption = presentation.graphs.showDiagnostics
    ? buildHypothesisTestQqOption(state.result.plotData, graphLabels)
    : null;
  return (
    <AnalysisStack>
      <AnalysisFrame title="Conclusion" data-analysis-block="conclusion">
        <AnalysisText>{model.conclusion}</AnalysisText>
        {model.robustness ? <AnalysisText role="alert">{model.robustness}</AnalysisText> : null}
        {state.result.warnings.map((warning) => <AnalysisText role="status" key={warning}>{warning}</AnalysisText>)}
      </AnalysisFrame>
      <AnalysisTable
        title={model.primary.title}
        columns={model.primary.columns}
        rows={model.primary.rows}
        width="compact"
        ariaLabel={model.primary.title}
      />
      <AnalysisGraph
        title={dataAndEstimatesTitle}
        graphRole="hypothesisMain"
        data-analysis-block="graph"
        strategy={{ mode: "custom", render: () => <HypothesisTestChart option={mainOption} title={dataAndEstimatesTitle} chartKind="main" /> }}
      />
      {diagnosticOption ? (
        <AnalysisGraph
          title={diagnosticValuesTitle}
          graphRole="hypothesisDiagnostic"
          data-analysis-block="graph"
          strategy={{ mode: "custom", render: () => <HypothesisTestChart option={diagnosticOption} title={diagnosticValuesTitle} chartKind="diagnostic" /> }}
        />
      ) : null}
      {qqOption ? (
        <AnalysisGraph
          title={normalQqTitle}
          graphRole="hypothesisQq"
          data-analysis-block="graph"
          strategy={{ mode: "custom", render: () => <HypothesisTestChart option={qqOption} title={normalQqTitle} chartKind="qq" /> }}
        />
      ) : null}
      {model.sections.map((section) => section.rows.length > 0 ? (
        <AnalysisTable
          key={section.key}
          title={section.title}
          columns={section.columns}
          rows={section.rows}
          width={section.key === "postHoc" ? "wide" : "standard"}
          ariaLabel={section.title}
        />
      ) : (
        <AnalysisFrame key={section.key} title={section.title} defaultExpanded={section.defaultExpanded ?? true}>
          <AnalysisText>None.</AnalysisText>
        </AnalysisFrame>
      ))}
    </AnalysisStack>
  );
}