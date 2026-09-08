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
import { buildNumericFitModelEquation } from "@/components/fitModel/fitModelEquation";
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
  buildResidualQqOption,
} from "@/graphCore/fitModelAdapter";
import type {
  FitModelDiagnosticFlag,
  FitModelFittedResult,
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

function resolveUndefinedValueLabel(t: (key: string) => string): string {
  const localized = t("fitModel.report.undefinedValue");
  return localized === "fitModel.report.undefinedValue" ? DEFAULT_UNDEFINED_VALUE : localized;
}

function warningText(code: FitModelFittedResult["warnings"][number], t: (key: string) => string): string {
  const key = `fitModel.report.warning.${code}`;
  const localized = t(key);
  return localized === key ? code : localized;
}

function notComputableText(reason: "insufficientRows" | "rankDeficient", t: (key: string) => string): string {
  const key = `fitModel.report.reason.${reason}`;
  const localized = t(key);
  return localized === key ? reason : localized;
}

function inferenceReasonText(reason: FitModelInferenceReason, t: (key: string) => string): string {
  const key = `fitModel.report.reason.${reason}`;
  const localized = t(key);
  return localized === key ? reason : localized;
}

function diagnosticFlagText(flag: FitModelDiagnosticFlag, t: (key: string) => string): string {
  const key = `fitModel.report.flag.${flag}`;
  const localized = t(key);
  if (localized !== key) return localized;
  const fallback: Record<FitModelDiagnosticFlag, string> = {
    residualWarning: "Residual warning",
    residualSevere: "Severe residual",
    highLeverage: "High leverage",
    influential: "Influential",
  };
  return fallback[flag];
}

export function FitModelAnalysisReport({
  item,
  state,
  datasetMissing,
  loadIssue,
  removeMessage,
  onRemoveTerm,
  onUndoRemove,
  onSaveColumns,
  saveColumnsDisabled = false,
}: FitModelAnalysisReportProps) {
  const { t } = useTranslation();
  const undefinedValue = resolveUndefinedValueLabel((key) => t(key));
  const [diagnosticFilter, setDiagnosticFilter] = useState<FitModelDiagnosticFilter>("all");
  const stale = state.status === "stale";
  const fittedResult = state.result?.kind === "fitted" ? state.result : null;
  const notComputableResult = state.result?.kind === "notComputable" ? state.result : null;
  const effects = useMemo(() => fittedResult ? buildEffectSummary(fittedResult) : [], [fittedResult]);
  const equation = useMemo(() => fittedResult ? buildNumericFitModelEquation(fittedResult) : null, [fittedResult]);
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

  const actualByPredictedOption = useMemo(() => fittedResult ? buildActualByPredictedOption({
    title: t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" }),
    sampledSubtitle,
    plotRows: fittedResult.plotRows,
    labels: {
      predictedAxisName: t("fitModel.report.chart.axis.predicted"),
      actualAxisName: t("fitModel.report.chart.axis.actual"),
      residualAxisName: t("fitModel.report.chart.axis.residual"),
      actualSeriesName: t("fitModel.report.chart.series.actual"),
      residualSeriesName: t("fitModel.report.chart.series.residual"),
      identityReferenceName: t("fitModel.report.chart.reference.identity"),
      zeroReferenceName: t("fitModel.report.chart.reference.zero"),
      tooltipXLabel: t("fitModel.report.chart.tooltip.x"),
      tooltipYLabel: t("fitModel.report.chart.tooltip.yActual"),
    },
  }) : null, [fittedResult, sampledSubtitle, t]);

  const residualByPredictedOption = useMemo(() => fittedResult ? buildResidualByPredictedOption({
    title: t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" }),
    sampledSubtitle,
    plotRows: fittedResult.plotRows,
    labels: {
      predictedAxisName: t("fitModel.report.chart.axis.predicted"),
      actualAxisName: t("fitModel.report.chart.axis.actual"),
      residualAxisName: t("fitModel.report.chart.axis.residual"),
      actualSeriesName: t("fitModel.report.chart.series.actual"),
      residualSeriesName: t("fitModel.report.chart.series.residual"),
      identityReferenceName: t("fitModel.report.chart.reference.identity"),
      zeroReferenceName: t("fitModel.report.chart.reference.zero"),
      tooltipXLabel: t("fitModel.report.chart.tooltip.x"),
      tooltipYLabel: t("fitModel.report.chart.tooltip.yResidual"),
    },
  }) : null, [fittedResult, sampledSubtitle, t]);

  const qqSampledSubtitle = useMemo(() => {
    if (!fittedResult?.diagnostics.qqRowsSampled) return undefined;
    return t("graph.rowStatus.sampled", {
      defaultValue: "Sampled: {{processed}} / {{source}} rows",
      processed: fittedResult.diagnostics.qqRows.length,
      source: fittedResult.diagnostics.qqSourceRowCount,
    });
  }, [fittedResult, t]);

  const residualQqOption = useMemo(() => {
    if (!fittedResult || fittedResult.diagnostics.qqRows.length === 0) return null;
    return buildResidualQqOption({
      title: t("fitModel.report.section.residualQq", { defaultValue: "Residual Q-Q" }),
      sampledSubtitle: qqSampledSubtitle,
      rows: fittedResult.diagnostics.qqRows,
      labels: {
        theoreticalAxisName: t("fitModel.report.chart.axis.theoreticalQuantile", { defaultValue: "Theoretical quantile" }),
        studentizedResidualAxisName: t("fitModel.report.chart.axis.studentizedResidual", { defaultValue: "Studentized residual" }),
        residualSeriesName: t("fitModel.report.chart.series.studentizedResidual", { defaultValue: "Studentized residual" }),
        referenceSeriesName: t("fitModel.report.chart.reference.qq", { defaultValue: "Q-Q reference" }),
        tooltipXLabel: t("fitModel.report.chart.tooltip.xQq", { defaultValue: "Theoretical quantile" }),
        tooltipYLabel: t("fitModel.report.chart.tooltip.yQq", { defaultValue: "Studentized residual" }),
      },
    });
  }, [fittedResult, qqSampledSubtitle, t]);

  const diagnosticSampledSubtitle = useMemo(() => {
    if (!fittedResult?.diagnostics.rowsSampled) return null;
    return t("graph.rowStatus.sampled", {
      defaultValue: "Sampled: {{processed}} / {{source}} rows",
      processed: fittedResult.diagnostics.rows.length,
      source: fittedResult.diagnostics.sourceRowCount,
    });
  }, [fittedResult, t]);

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
        {stale ? <AnalysisText>{t("fitModel.report.stale", { defaultValue: "Stale result" })}</AnalysisText> : null}
        {onUndoRemove ? (
          <AnalysisButton onClick={onUndoRemove}>{t("fitModel.report.undo", { defaultValue: "Undo" })}</AnalysisButton>
        ) : null}
        {onSaveColumns ? (
          <AnalysisButton onClick={onSaveColumns} disabled={saveColumnsDisabled}>
            {t("fitModel.report.saveColumns.open", { defaultValue: "Save Columns" })}
          </AnalysisButton>
        ) : null}
      </AnalysisStack>

      {datasetMissing || loadIssue ? <AnalysisText>{t("fitModel.sourceMissing", { defaultValue: "Source dataset is unavailable." })}</AnalysisText> : null}
      {removeMessage ? <AnalysisText role="status">{removeMessage}</AnalysisText> : null}
      {state.status === "loading" && state.result == null ? <AnalysisText>{t("fitModel.report.loading", { defaultValue: "Loading report..." })}</AnalysisText> : null}
      {state.status === "error" && state.result == null ? <AnalysisText>{t("fitModel.report.error", { defaultValue: "Failed to load report." })}: {state.error}</AnalysisText> : null}
      {state.status === "error" && state.result != null ? <AnalysisText>{t("fitModel.report.errorWithOldResult", { defaultValue: "Failed to refresh. Showing previous result." })}: {state.error}</AnalysisText> : null}
      {state.status === "stale" && state.error ? <AnalysisText>{t("fitModel.report.errorWithOldResult", { defaultValue: "Failed to refresh. Showing previous result." })}: {state.error}</AnalysisText> : null}

      {fittedResult ? (
        <>
          <AnalysisTable
            title={t("fitModel.report.section.modelSpecification", { defaultValue: "Model Specification" })}
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

          <AnalysisTable
            title={t("fitModel.report.section.effectSummary", { defaultValue: "Effect Summary" })}
            width="wide"
            columns={columns([
              ["term", t("fitModel.report.column.term", { defaultValue: "Term" })],
              ["pValue", t("fitModel.report.column.pValue", { defaultValue: "p-Value" }), true],
              ["logWorth", t("fitModel.report.column.logWorth", { defaultValue: "LogWorth" }), true],
            ])}
            rows={effects.map((effect) => row(effect.termId, [
              effect.termLabel,
              formatFitModelReportPValue(effect.pValue, undefinedValue),
              formatFitModelReportValue(effect.logWorth, undefinedValue),
            ]))}
            getRowActions={(effectRow) => [{
              key: "remove",
              label: t("fitModel.report.remove", { defaultValue: "Remove" }),
              tone: "danger",
              onInvoke: () => onRemoveTerm(effectRow.key),
            }]}
          />

          <AnalysisFrame title={t("fitModel.report.section.summaryOfFit", { defaultValue: "Summary of Fit" })} data-analysis-block="report">
            <AnalysisStack>
              {equationText ? <AnalysisText aria-label="fitted-equation-inputs">{equationText}</AnalysisText> : null}
              <AnalysisTable
                title={t("fitModel.report.section.summaryOfFit", { defaultValue: "Summary of Fit" })}
                columns={columns([
                  ["metric", t("fitModel.report.column.metric", { defaultValue: "Metric" })],
                  ["value", t("fitModel.report.column.value", { defaultValue: "Value" }), true],
                ])}
                rows={[
                  row("rSquared", [t("fitModel.report.summaryOfFit.rSquared", { defaultValue: "RSquare" }), formatFitModelReportValue(fittedResult.summaryOfFit.rSquared, undefinedValue)]),
                  row("adjustedRSquared", [t("fitModel.report.summaryOfFit.adjustedRSquared", { defaultValue: "RSquare Adj" }), formatFitModelReportValue(fittedResult.summaryOfFit.adjustedRSquared, undefinedValue)]),
                  row("rootMeanSquareError", [t("fitModel.report.summaryOfFit.rootMeanSquareError", { defaultValue: "Root Mean Square Error" }), formatFitModelReportValue(fittedResult.summaryOfFit.rootMeanSquareError, undefinedValue)]),
                ]}
              />
            </AnalysisStack>
          </AnalysisFrame>

          <AnalysisTable
            title={t("fitModel.report.section.analysisOfVariance", { defaultValue: "Analysis of Variance" })}
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

          <AnalysisFrame title={t("fitModel.report.section.lackOfFit", { defaultValue: "Lack of Fit" })} data-analysis-block="report">
            <AnalysisStack>
              <AnalysisTable
                title={t("fitModel.report.section.lackOfFit", { defaultValue: "Lack of Fit" })}
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
              {fittedResult.diagnostics.lackOfFit.reason ? <AnalysisText>{inferenceReasonText(fittedResult.diagnostics.lackOfFit.reason, (key) => t(key))}</AnalysisText> : null}
            </AnalysisStack>
          </AnalysisFrame>

          <AnalysisTable
            title={t("fitModel.report.section.parameterEstimates", { defaultValue: "Parameter Estimates" })}
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
                !vif ? undefinedValue : vif.reason ? inferenceReasonText(vif.reason, (key) => t(key)) : formatFitModelReportValue(vif.value, undefinedValue),
              ]);
            })}
          />

          {actualByPredictedOption ? (
            <AnalysisGraph
              title={t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" })}
              graphRole="actualByPredicted"
              frameClassName="sp-fit-model-analysis-graph-predicted"
              data-analysis-block="graph"
              strategy={{ mode: "custom", render: () => <FitModelDiagnosticChart title={t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" })} chartKind="actualByPredicted" option={actualByPredictedOption} /> }}
            />
          ) : null}

          {residualByPredictedOption ? (
            <AnalysisGraph
              title={t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" })}
              graphRole="residualByPredicted"
              frameClassName="sp-fit-model-analysis-graph-predicted"
              data-analysis-block="graph"
              strategy={{ mode: "custom", render: () => <FitModelDiagnosticChart title={t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" })} chartKind="residualByPredicted" option={residualByPredictedOption} /> }}
            />
          ) : null}

          {residualQqOption ? (
            <AnalysisGraph
              title={t("fitModel.report.section.residualQq", { defaultValue: "Residual Q-Q" })}
              graphRole="residualQq"
              frameClassName="sp-fit-model-analysis-graph-qq"
              data-analysis-block="graph"
              strategy={{ mode: "custom", render: () => <FitModelDiagnosticChart title={t("fitModel.report.section.residualQq", { defaultValue: "Residual Q-Q" })} chartKind="residualQq" option={residualQqOption} /> }}
            />
          ) : (
            <AnalysisFrame title={t("fitModel.report.section.residualQq", { defaultValue: "Residual Q-Q" })} data-analysis-block="report">
              <AnalysisText>{fittedResult.diagnostics.qqReason ? inferenceReasonText(fittedResult.diagnostics.qqReason, (key) => t(key)) : undefinedValue}</AnalysisText>
            </AnalysisFrame>
          )}

          <AnalysisFrame title={t("fitModel.report.section.rowDiagnostics", { defaultValue: "Row Diagnostics" })} data-analysis-block="report">
            <AnalysisStack>
              <AnalysisStack direction="horizontal" role="group" aria-label={t("fitModel.report.diagnostics.filter", { defaultValue: "Diagnostic row filter" })}>
                {(["all", "flagged"] as const).map((filter) => (
                  <AnalysisButton key={filter} aria-pressed={diagnosticFilter === filter} data-diagnostic-filter={filter} onClick={() => setDiagnosticFilter(filter)}>
                    {t(`fitModel.report.diagnostics.${filter}`, { defaultValue: filter === "all" ? "All" : "Flagged" })}
                  </AnalysisButton>
                ))}
              </AnalysisStack>
              {diagnosticSampledSubtitle ? <AnalysisText>{diagnosticSampledSubtitle}</AnalysisText> : null}
              <AnalysisTable
                title={t("fitModel.report.rows", { defaultValue: "Rows" })}
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
            strategy={{ mode: "custom", render: () => <FitModelProfiler snapshot={fittedResult.snapshot} responseName={fittedResult.responseColumn} /> }}
          />

          <AnalysisFrame title={t("fitModel.report.section.warnings", { defaultValue: "Warnings" })} data-analysis-block="report">
            {fittedResult.warnings.length === 0 ? (
              <AnalysisText>{t("fitModel.report.noWarnings", { defaultValue: "No warnings." })}</AnalysisText>
            ) : (
              <AnalysisStack>{fittedResult.warnings.map((warning) => <AnalysisText key={warning}>{warningText(warning, (key) => t(key))}</AnalysisText>)}</AnalysisStack>
            )}
          </AnalysisFrame>
        </>
      ) : null}

      {notComputableResult ? (
        <AnalysisFrame title={t("fitModel.report.notComputable", { defaultValue: "Not Computable" })} data-analysis-block="report">
          <AnalysisStack>
            <AnalysisText>{notComputableText(notComputableResult.reason, (key) => t(key))}</AnalysisText>
            <AnalysisText>{t("fitModel.report.usedRows", { defaultValue: "Used Rows" })}: {notComputableResult.usedRows}</AnalysisText>
            <AnalysisText>{t("fitModel.report.excludedRows", { defaultValue: "Excluded Rows" })}: {notComputableResult.excludedRows}</AnalysisText>
          </AnalysisStack>
        </AnalysisFrame>
      ) : null}
    </AnalysisStack>
  );
}
