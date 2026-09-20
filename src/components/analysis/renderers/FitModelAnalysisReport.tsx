import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnalysisButton } from "@/components/analysis/presentation/AnalysisButton";
import { AnalysisFrame } from "@/components/analysis/presentation/AnalysisFrame";
import { AnalysisGraph } from "@/components/analysis/presentation/AnalysisGraph";
import { AnalysisStack } from "@/components/analysis/presentation/AnalysisStack";
import {
  AnalysisTable,
  type AnalysisTableColumn,
  type AnalysisTableRow,
} from "@/components/analysis/presentation/AnalysisTable";
import { AnalysisText } from "@/components/analysis/presentation/AnalysisText";
import { FitModelDiagnosticChart } from "@/components/fitModel/FitModelDiagnosticChart";
import { FitModelEffectSummary } from "@/components/fitModel/FitModelEffectSummary";
import { buildNumericFitModelEquation } from "@/components/fitModel/fitModelEquation";
import { FitModelLeveragePlot } from "@/components/fitModel/FitModelLeveragePlot";
import { FitModelProfiler } from "@/components/fitModel/FitModelProfiler";
import {
  buildEffectSummary,
  filterFitModelDiagnostics,
  formatFitModelReportPValue,
  formatFitModelReportValue,
  type FitModelDiagnosticFilter,
} from "@/components/fitModel/fitModelReportModel";
import type { FitModelReportState } from "@/components/fitModel/useFitModelReport";
import {
  buildActualByPredictedOption,
  buildResidualByPredictedOption,
} from "@/graphCore/fitModelAdapter";
import type {
  FitModelDiagnosticFlag,
  FitModelInferenceReason,
  FitModelItem,
  FitModelLoadIssue,
} from "@/types/fitModel";

const DEFAULT_UNDEFINED_VALUE = "\u2014";

export interface FitModelAnalysisReportProps {
  item: FitModelItem;
  state: FitModelReportState;
  datasetMissing: boolean;
  loadIssue: FitModelLoadIssue | null;
  removeMessage: string | null;
  onAddEffect?: () => void;
  onRemoveTerm: (termId: string) => void;
  onUndoRemove: (() => void) | null;
  onSaveColumns?: () => void;
  saveColumnsDisabled?: boolean;
}

function columns(entries: Array<[string, ReactNode, boolean?]>): AnalysisTableColumn[] {
  return entries.map(([key, label, numeric]) => ({ key, label, numeric }));
}

function row(key: string, cells: ReactNode[]): AnalysisTableRow {
  return { key, cells };
}

function localizedFallback(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  const localized = t(key);
  return localized === key ? fallback : localized;
}

function inferenceReasonText(reason: FitModelInferenceReason, t: (key: string) => string): string {
  return localizedFallback(t, `fitModel.report.reason.${reason}`, reason);
}

function diagnosticFlagText(flag: FitModelDiagnosticFlag, t: (key: string) => string): string {
  const fallback: Record<FitModelDiagnosticFlag, string> = {
    residualWarning: "Residual warning",
    residualSevere: "Severe residual",
    highLeverage: "High leverage",
    influential: "Influential",
  };
  return localizedFallback(t, `fitModel.report.flag.${flag}`, fallback[flag]);
}

export function FitModelAnalysisReport({
  item,
  state,
  datasetMissing,
  loadIssue,
  removeMessage,
  onAddEffect,
  onRemoveTerm,
  onUndoRemove,
  onSaveColumns,
  saveColumnsDisabled = false,
}: FitModelAnalysisReportProps) {
  const { t } = useTranslation();
  const undefinedValue = localizedFallback(
    (key) => t(key),
    "fitModel.report.undefinedValue",
    DEFAULT_UNDEFINED_VALUE,
  );
  const [diagnosticFilter, setDiagnosticFilter] = useState<FitModelDiagnosticFilter>("all");
  const fittedResult = state.result?.kind === "fitted" ? state.result : null;
  const notComputableResult = state.result?.kind === "notComputable" ? state.result : null;
  const effects = useMemo(() => fittedResult ? buildEffectSummary(fittedResult) : [], [fittedResult]);
  const equation = useMemo(
    () => fittedResult ? buildNumericFitModelEquation(fittedResult) : null,
    [fittedResult],
  );
  const visibleDiagnosticRows = useMemo(
    () => filterFitModelDiagnostics(fittedResult?.diagnostics.rows ?? [], diagnosticFilter),
    [diagnosticFilter, fittedResult],
  );
  const sampledSubtitle = useMemo(() => {
    if (!fittedResult?.plotRowsSampled) return undefined;
    return t("graph.rowStatus.sampled", {
      defaultValue: "Sampled: {{processed}} / {{source}} rows",
      processed: fittedResult.plotRows.length,
      source: fittedResult.usedRows,
    });
  }, [fittedResult, t]);
  const actualByPredictedOption = useMemo(() => fittedResult
    ? buildActualByPredictedOption({
        title: t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" }),
        sampledSubtitle,
        plotRows: fittedResult.plotRows,
        labels: {
          predictedAxisName: t("fitModel.report.chart.axis.predicted", { defaultValue: "Predicted" }),
          actualAxisName: t("fitModel.report.chart.axis.actual", { defaultValue: "Actual" }),
          residualAxisName: t("fitModel.report.chart.axis.residual", { defaultValue: "Residual" }),
          actualSeriesName: t("fitModel.report.chart.series.actual", { defaultValue: "Actual" }),
          residualSeriesName: t("fitModel.report.chart.series.residual", { defaultValue: "Residual" }),
          identityReferenceName: t("fitModel.report.chart.reference.identity", { defaultValue: "y=x" }),
          zeroReferenceName: t("fitModel.report.chart.reference.zero", { defaultValue: "y=0" }),
          tooltipXLabel: t("fitModel.report.chart.tooltip.x", { defaultValue: "Predicted" }),
          tooltipYLabel: t("fitModel.report.chart.tooltip.yActual", { defaultValue: "Actual" }),
        },
      })
    : null, [fittedResult, sampledSubtitle, t]);
  const residualByPredictedOption = useMemo(() => fittedResult
    ? buildResidualByPredictedOption({
        title: t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" }),
        sampledSubtitle,
        plotRows: fittedResult.plotRows,
        labels: {
          predictedAxisName: t("fitModel.report.chart.axis.predicted", { defaultValue: "Predicted" }),
          actualAxisName: t("fitModel.report.chart.axis.actual", { defaultValue: "Actual" }),
          residualAxisName: t("fitModel.report.chart.axis.residual", { defaultValue: "Residual" }),
          actualSeriesName: t("fitModel.report.chart.series.actual", { defaultValue: "Actual" }),
          residualSeriesName: t("fitModel.report.chart.series.residual", { defaultValue: "Residual" }),
          identityReferenceName: t("fitModel.report.chart.reference.identity", { defaultValue: "y=x" }),
          zeroReferenceName: t("fitModel.report.chart.reference.zero", { defaultValue: "y=0" }),
          tooltipXLabel: t("fitModel.report.chart.tooltip.x", { defaultValue: "Predicted" }),
          tooltipYLabel: t("fitModel.report.chart.tooltip.yResidual", { defaultValue: "Residual" }),
        },
      })
    : null, [fittedResult, sampledSubtitle, t]);
  const diagnosticSampledSubtitle = fittedResult?.diagnostics.rowsSampled
    ? t("graph.rowStatus.sampled", {
        defaultValue: "Sampled: {{processed}} / {{source}} rows",
        processed: fittedResult.diagnostics.rows.length,
        source: fittedResult.diagnostics.sourceRowCount,
      })
    : null;
  const equationText = equation
    ? `${equation.response} = ${equation.parts.map((part, index) => {
        const magnitude = formatFitModelReportValue(Math.abs(part.coefficient));
        const feature = part.featureLabel ? ` ${part.featureLabel}` : "";
        if (index === 0) return `${part.coefficient < 0 ? "-" : ""}${magnitude}`;
        return `${part.coefficient < 0 ? "-" : "+"} ${magnitude}${feature}`;
      }).join(" ")}`
    : null;

  return (
    <AnalysisStack data-fit-model-analysis-report>
      <AnalysisStack direction="horizontal" data-analysis-block="actions">
        {state.status === "stale" ? (
          <AnalysisText>{t("fitModel.report.stale", { defaultValue: "Stale result" })}</AnalysisText>
        ) : null}
        {onSaveColumns ? (
          <AnalysisButton onClick={onSaveColumns} disabled={saveColumnsDisabled}>
            {t("fitModel.report.saveColumns.open", { defaultValue: "Save Columns" })}
          </AnalysisButton>
        ) : null}
      </AnalysisStack>

      {datasetMissing || loadIssue ? (
        <AnalysisText>{t("fitModel.sourceMissing", { defaultValue: "Source dataset is unavailable." })}</AnalysisText>
      ) : null}
      {removeMessage ? <AnalysisText role="status">{removeMessage}</AnalysisText> : null}
      {state.status === "loading" && state.result == null ? (
        <AnalysisText>{t("fitModel.report.loading", { defaultValue: "Loading report..." })}</AnalysisText>
      ) : null}
      {state.status === "error" && state.result == null ? (
        <AnalysisText>{t("fitModel.report.error", { defaultValue: "Failed to load report." })}: {state.error}</AnalysisText>
      ) : null}
      {(state.status === "error" || state.status === "stale") && state.result != null && state.error ? (
        <AnalysisText>
          {t("fitModel.report.errorWithOldResult", { defaultValue: "Failed to refresh. Showing previous result." })}: {state.error}
        </AnalysisText>
      ) : null}

      {fittedResult ? (
        <>
          <AnalysisFrame
            title={t("fitModel.report.section.modelSpecification", { defaultValue: "Model Specification" })}
            data-analysis-block="report"
          >
            <AnalysisTable
              title={t("fitModel.report.specification", { defaultValue: "Specification" })}
              framed={false}
              width="wide"
              columns={columns([
                ["property", t("fitModel.report.column.property", { defaultValue: "Property" })],
                ["value", t("fitModel.report.column.value", { defaultValue: "Value" })],
              ])}
              rows={[
                row("construct", [t("fitModel.report.specification.construct", { defaultValue: "Construct" }), `${item.construct.kind}${item.construct.kind === "factorialToDegree" ? ` (${item.construct.degree})` : ""}`]),
                row("response", [t("fitModel.report.specification.response", { defaultValue: "Response" }), fittedResult.responseColumn]),
                row("predictors", [t("fitModel.report.specification.predictors", { defaultValue: "Predictors" }), fittedResult.predictorColumns.join(", ")]),
                row("terms", [t("fitModel.report.specification.terms", { defaultValue: "Terms" }), fittedResult.terms.map((term) => term.label).join(", ")]),
                row("usedRows", [t("fitModel.report.specification.usedRows", { defaultValue: "Used rows" }), fittedResult.usedRows]),
                row("termBudget", [t("fitModel.report.specification.termBudget", { defaultValue: "Term budget" }), `${fittedResult.terms.length} / 256`]),
              ]}
            />
          </AnalysisFrame>

          {actualByPredictedOption ? (
            <AnalysisGraph
              title={t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" })}
              graphRole="actualByPredicted"
              frameClassName="sp-fit-model-analysis-graph-predicted"
              data-analysis-block="graph"
              strategy={{
                mode: "custom",
                render: () => (
                  <FitModelDiagnosticChart
                    title={t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" })}
                    chartKind="actualByPredicted"
                    option={actualByPredictedOption}
                  />
                ),
              }}
            />
          ) : null}

          <FitModelEffectSummary
            effects={effects}
            onAddEffect={onAddEffect}
            onRemoveTerm={onRemoveTerm}
            onUndoRemove={onUndoRemove}
            undefinedValue={undefinedValue}
          />

          <AnalysisFrame
            title={t("fitModel.report.section.lackOfFit", { defaultValue: "Lack of Fit" })}
            data-analysis-block="report"
          >
            <AnalysisStack>
              <AnalysisTable
                title={t("fitModel.report.section.lackOfFit", { defaultValue: "Lack of Fit" })}
                framed={false}
                width="wide"
                columns={columns([
                  ["source", t("fitModel.report.column.source", { defaultValue: "Source" })],
                  ["degreesOfFreedom", t("fitModel.report.column.degreesOfFreedom", { defaultValue: "DF" }), true],
                  ["sumOfSquares", t("fitModel.report.column.sumOfSquares", { defaultValue: "Sum of Squares" }), true],
                  ["meanSquare", t("fitModel.report.column.meanSquare", { defaultValue: "Mean Square" }), true],
                  ["fRatio", t("fitModel.report.column.fRatio", { defaultValue: "F Ratio" }), true],
                  ["pValue", t("fitModel.report.column.pValue", { defaultValue: "p-Value" }), true],
                ])}
                rows={[
                  row("error", [t("fitModel.report.source.error", { defaultValue: "Error" }), fittedResult.diagnostics.lackOfFit.errorDegreesOfFreedom, formatFitModelReportValue(fittedResult.diagnostics.lackOfFit.sumOfSquaresError, undefinedValue), undefinedValue, undefinedValue, undefinedValue]),
                  row("pureError", [t("fitModel.report.source.pureError", { defaultValue: "Pure Error" }), fittedResult.diagnostics.lackOfFit.pureErrorDegreesOfFreedom, formatFitModelReportValue(fittedResult.diagnostics.lackOfFit.sumOfSquaresPureError, undefinedValue), formatFitModelReportValue(fittedResult.diagnostics.lackOfFit.meanSquarePureError, undefinedValue), undefinedValue, undefinedValue]),
                  row("lackOfFit", [t("fitModel.report.source.lackOfFit", { defaultValue: "Lack of Fit" }), fittedResult.diagnostics.lackOfFit.lackOfFitDegreesOfFreedom, formatFitModelReportValue(fittedResult.diagnostics.lackOfFit.sumOfSquaresLackOfFit, undefinedValue), formatFitModelReportValue(fittedResult.diagnostics.lackOfFit.meanSquareLackOfFit, undefinedValue), formatFitModelReportValue(fittedResult.diagnostics.lackOfFit.fRatio, undefinedValue), formatFitModelReportPValue(fittedResult.diagnostics.lackOfFit.pValue, undefinedValue)]),
                ]}
              />
              {fittedResult.diagnostics.lackOfFit.reason ? (
                <AnalysisText>{inferenceReasonText(fittedResult.diagnostics.lackOfFit.reason, (key) => t(key))}</AnalysisText>
              ) : null}
            </AnalysisStack>
          </AnalysisFrame>

          {residualByPredictedOption ? (
            <AnalysisGraph
              title={t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" })}
              graphRole="residualByPredicted"
              frameClassName="sp-fit-model-analysis-graph-residual"
              data-analysis-block="graph"
              strategy={{
                mode: "custom",
                render: () => (
                  <FitModelDiagnosticChart
                    title={t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" })}
                    chartKind="residualByPredicted"
                    option={residualByPredictedOption}
                  />
                ),
              }}
            />
          ) : null}

          <AnalysisFrame
            title={t("fitModel.report.section.summaryOfFit", { defaultValue: "Summary of Fit" })}
            data-analysis-block="report"
          >
            <AnalysisStack>
              {equationText ? <AnalysisText aria-label="fitted-equation-inputs">{equationText}</AnalysisText> : null}
              <AnalysisTable
                title={t("fitModel.report.section.summaryOfFit", { defaultValue: "Summary of Fit" })}
                framed={false}
                columns={columns([
                  ["metric", t("fitModel.report.column.metric", { defaultValue: "Metric" })],
                  ["value", t("fitModel.report.column.value", { defaultValue: "Value" }), true],
                ])}
                rows={[
                  row("rSquared", [t("fitModel.report.summaryOfFit.rSquared", { defaultValue: "RSquare" }), formatFitModelReportValue(fittedResult.summaryOfFit.rSquared, undefinedValue)]),
                  row("adjustedRSquared", [t("fitModel.report.summaryOfFit.adjustedRSquared", { defaultValue: "RSquare Adj" }), formatFitModelReportValue(fittedResult.summaryOfFit.adjustedRSquared, undefinedValue)]),
                  row("rootMeanSquareError", [t("fitModel.report.summaryOfFit.rootMeanSquareError", { defaultValue: "Root Mean Square Error" }), formatFitModelReportValue(fittedResult.summaryOfFit.rootMeanSquareError, undefinedValue)]),
                  row("meanOfResponse", [t("fitModel.report.summaryOfFit.meanOfResponse", { defaultValue: "Mean of Response" }), formatFitModelReportValue(fittedResult.summaryOfFit.meanOfResponse, undefinedValue)]),
                  row("observations", [t("fitModel.report.summaryOfFit.observations", { defaultValue: "Observations" }), fittedResult.summaryOfFit.observationCount]),
                ]}
              />
            </AnalysisStack>
          </AnalysisFrame>

          <AnalysisFrame
            title={t("fitModel.report.section.analysisOfVariance", { defaultValue: "Analysis of Variance" })}
            data-analysis-block="report"
          >
            <AnalysisTable
              title={t("fitModel.report.section.analysisOfVariance", { defaultValue: "Analysis of Variance" })}
              framed={false}
              width="wide"
              columns={columns([
                ["source", t("fitModel.report.column.source", { defaultValue: "Source" })],
                ["degreesOfFreedom", t("fitModel.report.column.degreesOfFreedom", { defaultValue: "DF" }), true],
                ["sumOfSquares", t("fitModel.report.column.sumOfSquares", { defaultValue: "Sum of Squares" }), true],
                ["meanSquare", t("fitModel.report.column.meanSquare", { defaultValue: "Mean Square" }), true],
                ["fRatio", t("fitModel.report.column.fRatio", { defaultValue: "F Ratio" }), true],
                ["pValue", t("fitModel.report.column.pValue", { defaultValue: "p-Value" }), true],
              ])}
              rows={fittedResult.anova.map((anovaRow) => row(anovaRow.source, [
                anovaRow.source,
                formatFitModelReportValue(anovaRow.degreesOfFreedom, undefinedValue),
                formatFitModelReportValue(anovaRow.sumOfSquares, undefinedValue),
                formatFitModelReportValue(anovaRow.meanSquare, undefinedValue),
                formatFitModelReportValue(anovaRow.fRatio, undefinedValue),
                formatFitModelReportPValue(anovaRow.pValue, undefinedValue),
              ]))}
            />
          </AnalysisFrame>

          <AnalysisFrame
            title={t("fitModel.report.section.parameterEstimates", { defaultValue: "Parameter Estimates" })}
            data-analysis-block="report"
          >
            <AnalysisTable
              title={t("fitModel.report.section.parameterEstimates", { defaultValue: "Parameter Estimates" })}
              framed={false}
              width="wide"
              columns={columns([
                ["term", t("fitModel.report.column.term", { defaultValue: "Term" })],
                ["estimate", t("fitModel.report.column.estimate", { defaultValue: "Estimate" }), true],
                ["standardError", t("fitModel.report.column.standardError", { defaultValue: "Std Error" }), true],
                ["tRatio", t("fitModel.report.column.tRatio", { defaultValue: "t Ratio" }), true],
                ["pValue", t("fitModel.report.column.pValue", { defaultValue: "p-Value" }), true],
                ["lowerConfidenceLimit", t("fitModel.report.column.lowerConfidenceLimit", { defaultValue: "Lower 95%" }), true],
                ["upperConfidenceLimit", t("fitModel.report.column.upperConfidenceLimit", { defaultValue: "Upper 95%" }), true],
                ["featureVif", t("fitModel.report.column.featureVif", { defaultValue: "Feature VIF" }), true],
              ])}
              rows={fittedResult.parameterEstimates.map((estimate) => {
                const vif = fittedResult.diagnostics.featureVif.find((entry) => entry.termId === estimate.termId);
                return row(estimate.termId, [
                  estimate.termLabel,
                  formatFitModelReportValue(estimate.estimate, undefinedValue),
                  formatFitModelReportValue(estimate.standardError, undefinedValue),
                  formatFitModelReportValue(estimate.tRatio, undefinedValue),
                  formatFitModelReportPValue(estimate.pValue, undefinedValue),
                  formatFitModelReportValue(estimate.lowerConfidenceLimit, undefinedValue),
                  formatFitModelReportValue(estimate.upperConfidenceLimit, undefinedValue),
                  !vif ? undefinedValue : vif.reason
                    ? inferenceReasonText(vif.reason, (key) => t(key))
                    : formatFitModelReportValue(vif.value, undefinedValue),
                ]);
              })}
            />
          </AnalysisFrame>

          <AnalysisFrame
            title={t("fitModel.report.section.effectTests", { defaultValue: "Effect Tests" })}
            data-analysis-block="report"
          >
            <AnalysisTable
              title={t("fitModel.report.section.effectTests", { defaultValue: "Effect Tests" })}
              framed={false}
              width="wide"
              columns={columns([
                ["source", t("fitModel.report.column.source", { defaultValue: "Source" })],
                ["numberOfParameters", t("fitModel.report.column.numberOfParameters", { defaultValue: "Nparm" }), true],
                ["degreesOfFreedom", t("fitModel.report.column.degreesOfFreedom", { defaultValue: "DF" }), true],
                ["sumOfSquares", t("fitModel.report.column.sumOfSquares", { defaultValue: "Sum of Squares" }), true],
                ["fRatio", t("fitModel.report.column.fRatio", { defaultValue: "F Ratio" }), true],
                ["pValue", t("fitModel.report.column.probabilityGreaterThanF", { defaultValue: "Prob > F" }), true],
              ])}
              rows={fittedResult.effectTests.map((effect) => row(effect.termId, [
                effect.termLabel,
                effect.numberOfParameters,
                effect.degreesOfFreedom,
                formatFitModelReportValue(effect.sumOfSquares, undefinedValue),
                formatFitModelReportValue(effect.fRatio, undefinedValue),
                effect.reason
                  ? inferenceReasonText(effect.reason, (key) => t(key))
                  : formatFitModelReportPValue(effect.pValue, undefinedValue),
              ]))}
            />
          </AnalysisFrame>

          <FitModelLeveragePlot
            effectTests={fittedResult.effectTests}
            leveragePlots={fittedResult.leveragePlots}
            responseLabel={fittedResult.responseColumn}
            chartLabels={{
              leverageAxisName: t("fitModel.report.chart.axis.effectLeverage", { defaultValue: "Effect leverage" }),
              adjustedResponseAxisName: t("fitModel.report.chart.axis.adjustedResponse", { defaultValue: "Adjusted response" }),
              pointSeriesName: t("fitModel.report.chart.series.leveragePoints", { defaultValue: "Rows" }),
              fittedSeriesName: t("fitModel.report.chart.series.fitted", { defaultValue: "Fitted" }),
              confidenceSeriesName: t("fitModel.report.chart.series.confidence", { defaultValue: "Confidence" }),
              nullSeriesName: t("fitModel.report.chart.reference.nullEffect", { defaultValue: "Null effect" }),
              pValueLabel: t("fitModel.report.column.pValue", { defaultValue: "p-Value" }),
              tooltipXLabel: t("fitModel.report.chart.tooltip.effectLeverage", { defaultValue: "Effect leverage" }),
              tooltipYLabel: t("fitModel.report.chart.tooltip.adjustedResponse", { defaultValue: "Adjusted response" }),
            }}
          />

          <AnalysisFrame
            title={t("fitModel.report.section.rowDiagnostics", { defaultValue: "Row Diagnostics" })}
            data-analysis-block="report"
          >
            <AnalysisStack>
              <AnalysisStack
                direction="horizontal"
                role="group"
                aria-label={t("fitModel.report.diagnostics.filter", { defaultValue: "Diagnostic row filter" })}
              >
                {(["all", "flagged"] as const).map((filter) => (
                  <AnalysisButton
                    key={filter}
                    aria-pressed={diagnosticFilter === filter}
                    data-diagnostic-filter={filter}
                    onClick={() => setDiagnosticFilter(filter)}
                  >
                    {t(`fitModel.report.diagnostics.${filter}`, { defaultValue: filter === "all" ? "All" : "Flagged" })}
                  </AnalysisButton>
                ))}
              </AnalysisStack>
              {diagnosticSampledSubtitle ? <AnalysisText>{diagnosticSampledSubtitle}</AnalysisText> : null}
              <AnalysisTable
                title={t("fitModel.report.rows", { defaultValue: "Rows" })}
                framed={false}
                width="wide"
                ariaLabel={t("fitModel.report.section.rowDiagnostics", { defaultValue: "Row Diagnostics" })}
                columns={columns([
                  ["row", t("fitModel.report.column.row", { defaultValue: "Row" }), true],
                  ["observed", t("fitModel.report.column.observed", { defaultValue: "Observed" }), true],
                  ["fitted", t("fitModel.report.column.fitted", { defaultValue: "Fitted" }), true],
                  ["residual", t("fitModel.report.column.residual", { defaultValue: "Residual" }), true],
                  ["studentizedResidual", t("fitModel.report.column.studentizedResidual", { defaultValue: "Studentized Residual" }), true],
                  ["leverage", t("fitModel.report.column.leverage", { defaultValue: "Leverage" }), true],
                  ["cooksDistance", t("fitModel.report.column.cooksDistance", { defaultValue: "Cook's D" }), true],
                  ["meanConfidenceInterval", t("fitModel.report.column.meanConfidenceInterval", { defaultValue: "Mean CI" })],
                  ["predictionInterval", t("fitModel.report.column.predictionInterval", { defaultValue: "Prediction Interval" })],
                  ["flags", t("fitModel.report.column.flags", { defaultValue: "Flags" })],
                ])}
                rows={visibleDiagnosticRows.map((diagnostic) => row(String(diagnostic.rowIndex), [
                  diagnostic.rowIndex,
                  formatFitModelReportValue(diagnostic.observed, undefinedValue),
                  formatFitModelReportValue(diagnostic.fitted, undefinedValue),
                  formatFitModelReportValue(diagnostic.residual, undefinedValue),
                  formatFitModelReportValue(diagnostic.studentizedResidual, undefinedValue),
                  formatFitModelReportValue(diagnostic.leverage, undefinedValue),
                  formatFitModelReportValue(diagnostic.cooksDistance, undefinedValue),
                  `${formatFitModelReportValue(diagnostic.meanConfidenceLower, undefinedValue)} - ${formatFitModelReportValue(diagnostic.meanConfidenceUpper, undefinedValue)}`,
                  `${formatFitModelReportValue(diagnostic.predictionLower, undefinedValue)} - ${formatFitModelReportValue(diagnostic.predictionUpper, undefinedValue)}`,
                  diagnostic.flags.map((flag) => diagnosticFlagText(flag, (key) => t(key))).join(", "),
                ]))}
              />
            </AnalysisStack>
          </AnalysisFrame>

          <AnalysisGraph
            title={t("fitModel.report.section.predictionProfiler", { defaultValue: "Prediction Profiler" })}
            graphRole="predictionProfiler"
            frameClassName={`sp-fit-model-analysis-graph-profiler sp-fit-model-analysis-graph-profiler-${Math.max(1, Math.min(fittedResult.snapshot.predictorRanges.length, 2))}`}
            data-analysis-block="graph"
            strategy={{
              mode: "custom",
              render: () => (
                <FitModelProfiler
                  snapshot={fittedResult.snapshot}
                  responseName={fittedResult.responseColumn}
                />
              ),
            }}
          />

          <AnalysisFrame
            title={t("fitModel.report.section.warnings", { defaultValue: "Warnings" })}
            data-analysis-block="report"
          >
            {fittedResult.warnings.length === 0 ? (
              <AnalysisText>{t("fitModel.report.noWarnings", { defaultValue: "No warnings." })}</AnalysisText>
            ) : (
              <AnalysisStack>
                {fittedResult.warnings.map((warning) => (
                  <AnalysisText key={warning}>
                    {localizedFallback((key) => t(key), `fitModel.report.warning.${warning}`, warning)}
                  </AnalysisText>
                ))}
              </AnalysisStack>
            )}
          </AnalysisFrame>
        </>
      ) : null}

      {notComputableResult ? (
        <AnalysisFrame
          title={t("fitModel.report.notComputable", { defaultValue: "Not Computable" })}
          data-analysis-block="report"
        >
          <AnalysisStack>
            <AnalysisText>
              {localizedFallback(
                (key) => t(key),
                `fitModel.report.reason.${notComputableResult.reason}`,
                notComputableResult.reason,
              )}
            </AnalysisText>
            <AnalysisText>
              {t("fitModel.report.usedRows", { defaultValue: "Used Rows" })}: {notComputableResult.usedRows}
            </AnalysisText>
            <AnalysisText>
              {t("fitModel.report.excludedRows", { defaultValue: "Excluded Rows" })}: {notComputableResult.excludedRows}
            </AnalysisText>
          </AnalysisStack>
        </AnalysisFrame>
      ) : null}
    </AnalysisStack>
  );
}
