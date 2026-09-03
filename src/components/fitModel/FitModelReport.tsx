import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  buildActualByPredictedOption,
  buildResidualByPredictedOption,
} from "@/graphCore/fitModelAdapter";
import type { FitModelItem, FitModelFittedResult } from "@/types/fitModel";

import {
  buildNumericFitModelEquation,
  type FitModelEquationPart,
} from "./fitModelEquation";
import {
  buildEffectSummary,
  formatFitModelReportPValue,
  formatFitModelReportValue,
} from "./fitModelReportModel";
import { FitModelDiagnosticChart } from "./FitModelDiagnosticChart";
import type { FitModelReportState } from "./useFitModelReport";
import type { FitModelLoadIssue } from "@/types/fitModel";

interface FitModelDisclosureState {
  effectSummary: boolean;
  summaryOfFit: boolean;
  analysisOfVariance: boolean;
  parameterEstimates: boolean;
  actualByPredicted: boolean;
  residualByPredicted: boolean;
  warnings: boolean;
}

const DEFAULT_DISCLOSURE_STATE: FitModelDisclosureState = {
  effectSummary: true,
  summaryOfFit: true,
  analysisOfVariance: true,
  parameterEstimates: true,
  actualByPredicted: true,
  residualByPredicted: true,
  warnings: true,
};

const DEFAULT_UNDEFINED_VALUE = "\u2014";

export interface FitModelReportProps {
  item: FitModelItem;
  state: FitModelReportState;
  datasetMissing: boolean;
  loadIssue: FitModelLoadIssue | null;
  removeMessage: string | null;
  onRemoveTerm: (termId: string) => void;
  onUndoRemove: (() => void) | null;
}

function resolveUndefinedValueLabel(t: (key: string) => string): string {
  const localized = t("fitModel.report.undefinedValue");
  return localized === "fitModel.report.undefinedValue"
    ? DEFAULT_UNDEFINED_VALUE
    : localized;
}

function warningText(code: FitModelFittedResult["warnings"][number], t: (key: string) => string): string {
  const localized = t(`fitModel.report.warning.${code}`);
  return localized === `fitModel.report.warning.${code}` ? code : localized;
}

function notComputableText(reason: "insufficientRows" | "rankDeficient", t: (key: string) => string): string {
  const localized = t(`fitModel.report.reason.${reason}`);
  return localized === `fitModel.report.reason.${reason}` ? reason : localized;
}

function FittedEquation({ response, parts }: { response: string; parts: FitModelEquationPart[] }) {
  return (
    <div className="sp-fit-model-report-equation" aria-label="fitted-equation-inputs">
      <span>{response}</span>
      <span>=</span>
      {parts.map((part, index) => {
        const magnitude = formatFitModelReportValue(Math.abs(part.coefficient));
        const feature = part.featureLabel ? ` ${part.featureLabel}` : "";
        if (index === 0) {
          return <span key="eq:intercept">{`${part.coefficient < 0 ? "-" : ""}${magnitude}`}</span>;
        }
        return (
          <span key={`eq:${index}:${part.featureLabel}`}>
            {`${part.coefficient < 0 ? "-" : "+"} ${magnitude}${feature}`}
          </span>
        );
      })}
    </div>
  );
}

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="sp-fit-model-report-section">
      <button
        type="button"
        className="sp-fit-model-report-section-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        {title}
      </button>
      {open ? <div className="sp-fit-model-report-section-body">{children}</div> : null}
    </section>
  );
}

export function FitModelReport({
  item,
  state,
  datasetMissing,
  loadIssue,
  removeMessage,
  onRemoveTerm,
  onUndoRemove,
}: FitModelReportProps) {
  void item;
  const { t } = useTranslation();
  const undefinedValue = resolveUndefinedValueLabel((key) => t(key));
  const [disclosure, setDisclosure] = useState<FitModelDisclosureState>(DEFAULT_DISCLOSURE_STATE);

  const toggle = (key: keyof FitModelDisclosureState) => {
    setDisclosure((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const stale = state.status === "stale";
  const fittedResult = state.result?.kind === "fitted" ? state.result : null;
  const notComputableResult = state.result?.kind === "notComputable" ? state.result : null;
  const effects = useMemo(
    () => (fittedResult ? buildEffectSummary(fittedResult) : []),
    [fittedResult],
  );
  const equation = useMemo(
    () => (fittedResult ? buildNumericFitModelEquation(fittedResult) : null),
    [fittedResult],
  );

  const sampledSubtitle = useMemo(() => {
    if (!fittedResult?.plotRowsSampled) {
      return undefined;
    }

    return t("graph.rowStatus.sampled", {
      defaultValue: "Sampled: {{processed}} / {{source}} rows",
      processed: fittedResult.plotRows.length,
      source: fittedResult.usedRows,
    });
  }, [fittedResult, t]);

  const actualByPredictedOption = useMemo(() => {
    if (!fittedResult) {
      return null;
    }

    const labels = {
      predictedAxisName: t("fitModel.report.chart.axis.predicted"),
      actualAxisName: t("fitModel.report.chart.axis.actual"),
      residualAxisName: t("fitModel.report.chart.axis.residual"),
      actualSeriesName: t("fitModel.report.chart.series.actual"),
      residualSeriesName: t("fitModel.report.chart.series.residual"),
      identityReferenceName: t("fitModel.report.chart.reference.identity"),
      zeroReferenceName: t("fitModel.report.chart.reference.zero"),
      tooltipXLabel: t("fitModel.report.chart.tooltip.x"),
      tooltipYLabel: t("fitModel.report.chart.tooltip.yActual"),
    };

    return buildActualByPredictedOption({
      title: t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" }),
      sampledSubtitle,
      plotRows: fittedResult.plotRows,
      labels,
    });
  }, [fittedResult, sampledSubtitle, t]);

  const residualByPredictedOption = useMemo(() => {
    if (!fittedResult) {
      return null;
    }

    const labels = {
      predictedAxisName: t("fitModel.report.chart.axis.predicted"),
      actualAxisName: t("fitModel.report.chart.axis.actual"),
      residualAxisName: t("fitModel.report.chart.axis.residual"),
      actualSeriesName: t("fitModel.report.chart.series.actual"),
      residualSeriesName: t("fitModel.report.chart.series.residual"),
      identityReferenceName: t("fitModel.report.chart.reference.identity"),
      zeroReferenceName: t("fitModel.report.chart.reference.zero"),
      tooltipXLabel: t("fitModel.report.chart.tooltip.x"),
      tooltipYLabel: t("fitModel.report.chart.tooltip.yResidual"),
    };

    return buildResidualByPredictedOption({
      title: t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" }),
      sampledSubtitle,
      plotRows: fittedResult.plotRows,
      labels,
    });
  }, [fittedResult, sampledSubtitle, t]);

  return (
    <section className="sp-fit-model-report-panel" aria-label={t("fitModel.report.title", { defaultValue: "Fit Model report" })}>
      <div className="sp-panel-header">
        <span className="sp-panel-header-title">{t("fitModel.report.title", { defaultValue: "Fit Model report" })}</span>
        {stale ? (
          <span className="sp-tabulate-header-hint">{t("fitModel.report.stale", { defaultValue: "Stale result" })}</span>
        ) : null}
      </div>

      <div className="sp-fit-model-report-shell">

      {datasetMissing || loadIssue ? (
        <p>{t("fitModel.sourceMissing", { defaultValue: "Source dataset is unavailable." })}</p>
      ) : null}

      {removeMessage ? (
        <p role="status">{removeMessage}</p>
      ) : null}

      {onUndoRemove ? (
        <button type="button" onClick={onUndoRemove}>
          {t("fitModel.report.undo", { defaultValue: "Undo" })}
        </button>
      ) : null}

      {state.status === "loading" && state.result == null ? (
        <p>{t("fitModel.report.loading", { defaultValue: "Loading report..." })}</p>
      ) : null}

      {state.status === "error" && state.result == null ? (
        <p>{t("fitModel.report.error", { defaultValue: "Failed to load report." })}: {state.error}</p>
      ) : null}

      {state.status === "error" && state.result != null ? (
        <p>{t("fitModel.report.errorWithOldResult", { defaultValue: "Failed to refresh. Showing previous result." })}: {state.error}</p>
      ) : null}

      {state.status === "stale" && state.error ? (
        <p>{t("fitModel.report.errorWithOldResult", { defaultValue: "Failed to refresh. Showing previous result." })}: {state.error}</p>
      ) : null}

      {fittedResult ? (
        <>
          <Section
            title={t("fitModel.report.section.effectSummary", { defaultValue: "Effect Summary" })}
            open={disclosure.effectSummary}
            onToggle={() => toggle("effectSummary")}
          >
            <div className="sp-fit-model-report-table-wrap">
              <table className="sp-fit-model-report-table">
                <thead>
                  <tr>
                    <th>{t("fitModel.report.column.term", { defaultValue: "Term" })}</th>
                    <th>{t("fitModel.report.column.pValue", { defaultValue: "p-Value" })}</th>
                    <th>{t("fitModel.report.column.logWorth", { defaultValue: "LogWorth" })}</th>
                    <th>{t("fitModel.report.column.action", { defaultValue: "Action" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {effects.map((effect) => (
                    <tr key={effect.termId}>
                      <td>{effect.termLabel}</td>
                      <td>{formatFitModelReportPValue(effect.pValue, undefinedValue)}</td>
                      <td>{formatFitModelReportValue(effect.logWorth, undefinedValue)}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => onRemoveTerm(effect.termId)}
                        >
                          {t("fitModel.report.remove", { defaultValue: "Remove" })}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title={t("fitModel.report.section.summaryOfFit", { defaultValue: "Summary of Fit" })}
            open={disclosure.summaryOfFit}
            onToggle={() => toggle("summaryOfFit")}
          >
            {equation ? (
              <FittedEquation response={equation.response} parts={equation.parts} />
            ) : null}
            <div className="sp-fit-model-report-table-wrap">
              <table className="sp-fit-model-report-table">
                <tbody>
                  <tr>
                    <th>{t("fitModel.report.summaryOfFit.rSquared", { defaultValue: "RSquare" })}</th>
                    <td>{formatFitModelReportValue(fittedResult.summaryOfFit.rSquared, undefinedValue)}</td>
                  </tr>
                  <tr>
                    <th>{t("fitModel.report.summaryOfFit.adjustedRSquared", { defaultValue: "RSquare Adj" })}</th>
                    <td>{formatFitModelReportValue(fittedResult.summaryOfFit.adjustedRSquared, undefinedValue)}</td>
                  </tr>
                  <tr>
                    <th>{t("fitModel.report.summaryOfFit.rootMeanSquareError", { defaultValue: "Root Mean Square Error" })}</th>
                    <td>{formatFitModelReportValue(fittedResult.summaryOfFit.rootMeanSquareError, undefinedValue)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title={t("fitModel.report.section.analysisOfVariance", { defaultValue: "Analysis of Variance" })}
            open={disclosure.analysisOfVariance}
            onToggle={() => toggle("analysisOfVariance")}
          >
            <div className="sp-fit-model-report-table-wrap">
              <table className="sp-fit-model-report-table">
                <thead>
                  <tr>
                    <th>{t("fitModel.report.column.source", { defaultValue: "Source" })}</th>
                    <th>{t("fitModel.report.column.degreesOfFreedom", { defaultValue: "DF" })}</th>
                    <th>{t("fitModel.report.column.sumOfSquares", { defaultValue: "Sum of Squares" })}</th>
                    <th>{t("fitModel.report.column.meanSquare", { defaultValue: "Mean Square" })}</th>
                    <th>{t("fitModel.report.column.fRatio", { defaultValue: "F Ratio" })}</th>
                    <th>{t("fitModel.report.column.pValue", { defaultValue: "p-Value" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {fittedResult.anova.map((row) => (
                    <tr key={`anova:${row.source}`}>
                      <td>{row.source}</td>
                      <td>{formatFitModelReportValue(row.degreesOfFreedom, undefinedValue)}</td>
                      <td>{formatFitModelReportValue(row.sumOfSquares, undefinedValue)}</td>
                      <td>{formatFitModelReportValue(row.meanSquare, undefinedValue)}</td>
                      <td>{formatFitModelReportValue(row.fRatio, undefinedValue)}</td>
                      <td>{formatFitModelReportPValue(row.pValue, undefinedValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title={t("fitModel.report.section.parameterEstimates", { defaultValue: "Parameter Estimates" })}
            open={disclosure.parameterEstimates}
            onToggle={() => toggle("parameterEstimates")}
          >
            <div className="sp-fit-model-report-table-wrap">
              <table className="sp-fit-model-report-table">
                <thead>
                  <tr>
                    <th>{t("fitModel.report.column.term", { defaultValue: "Term" })}</th>
                    <th>{t("fitModel.report.column.estimate", { defaultValue: "Estimate" })}</th>
                    <th>{t("fitModel.report.column.standardError", { defaultValue: "Std Error" })}</th>
                    <th>{t("fitModel.report.column.tRatio", { defaultValue: "t Ratio" })}</th>
                    <th>{t("fitModel.report.column.pValue", { defaultValue: "p-Value" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {fittedResult.parameterEstimates.map((row) => (
                    <tr key={`pe:${row.termId}`}>
                      <td>{row.termLabel}</td>
                      <td>{formatFitModelReportValue(row.estimate, undefinedValue)}</td>
                      <td>{formatFitModelReportValue(row.standardError, undefinedValue)}</td>
                      <td>{formatFitModelReportValue(row.tRatio, undefinedValue)}</td>
                      <td>{formatFitModelReportPValue(row.pValue, undefinedValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title={t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" })}
            open={disclosure.actualByPredicted}
            onToggle={() => toggle("actualByPredicted")}
          >
            {actualByPredictedOption ? (
              <FitModelDiagnosticChart
                title={t("fitModel.report.section.actualByPredicted", { defaultValue: "Actual by Predicted" })}
                chartKind="actualByPredicted"
                option={actualByPredictedOption}
              />
            ) : null}
          </Section>

          <Section
            title={t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" })}
            open={disclosure.residualByPredicted}
            onToggle={() => toggle("residualByPredicted")}
          >
            {residualByPredictedOption ? (
              <FitModelDiagnosticChart
                title={t("fitModel.report.section.residualByPredicted", { defaultValue: "Residual by Predicted" })}
                chartKind="residualByPredicted"
                option={residualByPredictedOption}
              />
            ) : null}
          </Section>

          <Section
            title={t("fitModel.report.section.warnings", { defaultValue: "Warnings" })}
            open={disclosure.warnings}
            onToggle={() => toggle("warnings")}
          >
            {fittedResult.warnings.length === 0 ? (
              <p>{t("fitModel.report.noWarnings", { defaultValue: "No warnings." })}</p>
            ) : (
              <ul>
                {fittedResult.warnings.map((warning) => (
                  <li key={warning}>{warningText(warning, (key) => t(key))}</li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}

      {notComputableResult ? (
        <Section
          title={t("fitModel.report.notComputable", { defaultValue: "Not Computable" })}
          open={disclosure.summaryOfFit}
          onToggle={() => toggle("summaryOfFit")}
        >
          <p>{notComputableText(notComputableResult.reason, (key) => t(key))}</p>
          <p>{t("fitModel.report.usedRows", { defaultValue: "Used Rows" })}: {notComputableResult.usedRows}</p>
          <p>{t("fitModel.report.excludedRows", { defaultValue: "Excluded Rows" })}: {notComputableResult.excludedRows}</p>
        </Section>
      ) : null}
      </div>
    </section>
  );
}
