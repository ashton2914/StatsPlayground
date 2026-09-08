import { startTransition, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildFitModelProfilerOption } from "@/graphCore/fitModelAdapter";
import type { FitModelSnapshot } from "@/types/fitModel";

import { FitModelDiagnosticChart } from "./FitModelDiagnosticChart";
import {
  predictFitModelPoint,
  scanFitModelPredictor,
} from "./fitModelPrediction";
import { formatFitModelReportValue } from "./fitModelReportModel";

export interface FitModelProfilerProps {
  snapshot: FitModelSnapshot;
  responseName: string;
}

function initialValues(snapshot: FitModelSnapshot): Record<string, number> {
  return Object.fromEntries(snapshot.predictorRanges.map((range) => [range.columnName, range.mean]));
}

function intervalText(lower: number | null, upper: number | null, notEstimable: string): string {
  if (lower === null || upper === null) return notEstimable;
  return `${formatFitModelReportValue(lower)} - ${formatFitModelReportValue(upper)}`;
}

export function FitModelProfiler({ snapshot, responseName }: FitModelProfilerProps) {
  const { t } = useTranslation();
  const inputIdPrefix = useId().replace(/:/g, "");
  const [values, setValues] = useState<Record<string, number>>(() => initialValues(snapshot));
  const [scanValues, setScanValues] = useState<Record<string, number>>(() => initialValues(snapshot));

  useEffect(() => {
    const next = initialValues(snapshot);
    setValues(next);
    startTransition(() => setScanValues(next));
  }, [snapshot]);

  const effectiveValues = Object.fromEntries(snapshot.predictorRanges.map((range) => [
    range.columnName,
    values[range.columnName] ?? range.mean,
  ]));
  const effectiveScanValues = Object.fromEntries(snapshot.predictorRanges.map((range) => [
    range.columnName,
    scanValues[range.columnName] ?? range.mean,
  ]));
  const currentPrediction = predictFitModelPoint(snapshot, effectiveValues);
  const notEstimable = t("fitModel.report.profiler.notEstimable", { defaultValue: "Not estimable" });

  const updateValue = (columnName: string, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = { ...effectiveValues, [columnName]: value };
    setValues(next);
    startTransition(() => setScanValues(next));
  };

  return (
    <div className="sp-fit-model-profiler">
      {snapshot.predictorRanges.map((range, index) => {
        const value = effectiveValues[range.columnName];
        const numberInputId = `${inputIdPrefix}-number-${index}`;
        const sliderValue = Math.min(range.maximum, Math.max(range.minimum, value));
        const step = range.maximum === range.minimum ? 1 : (range.maximum - range.minimum) / 100;
        const points = scanFitModelPredictor(snapshot, effectiveScanValues, range.columnName);
        const option = buildFitModelProfilerOption({
          predictorName: range.columnName,
          responseName,
          currentValue: value,
          currentPrediction: currentPrediction.predicted,
          points,
          labels: {
            predictedSeriesName: t("fitModel.report.chart.series.predicted", { defaultValue: "Predicted" }),
            meanConfidenceSeriesName: t("fitModel.report.chart.series.meanConfidence", { defaultValue: "Mean CI" }),
            currentValueName: t("fitModel.report.profiler.currentValue", { defaultValue: "Current value" }),
            tooltipXLabel: range.columnName,
            tooltipYLabel: responseName,
          },
        });
        return (
          <article key={range.columnName} className="sp-fit-model-profiler-column" data-profiler-column={range.columnName}>
            <div className="sp-fit-model-profiler-controls">
              <label htmlFor={numberInputId}>
                <span>{range.columnName}</span>
                <span>{t("fitModel.report.profiler.currentValue", { defaultValue: "Current value" })}</span>
              </label>
              <input
                type="range"
                min={range.minimum}
                max={range.maximum}
                step={step}
                value={sliderValue}
                aria-label={`${range.columnName} ${t("fitModel.report.profiler.currentValue", { defaultValue: "Current value" })}`}
                onChange={(event) => updateValue(range.columnName, event.currentTarget.valueAsNumber)}
              />
              <input
                id={numberInputId}
                type="number"
                step="any"
                value={value}
                aria-label={`${range.columnName} ${t("fitModel.report.profiler.currentValue", { defaultValue: "Current value" })}`}
                onChange={(event) => updateValue(range.columnName, event.currentTarget.valueAsNumber)}
              />
            </div>
            <FitModelDiagnosticChart
              title={`${range.columnName} ${t("fitModel.report.section.predictionProfiler", { defaultValue: "Prediction Profiler" })}`}
              chartKind="predictionProfiler"
              option={option}
            />
          </article>
        );
      })}
      <dl className="sp-fit-model-profiler-result" aria-live="polite">
        <div><dt>{t("fitModel.report.profiler.predicted", { defaultValue: "Predicted" })}</dt><dd>{formatFitModelReportValue(currentPrediction.predicted)}</dd></div>
        <div><dt>{t("fitModel.report.profiler.meanConfidenceInterval", { defaultValue: "Mean CI" })}</dt><dd>{intervalText(currentPrediction.meanConfidenceLower, currentPrediction.meanConfidenceUpper, notEstimable)}</dd></div>
        <div><dt>{t("fitModel.report.profiler.predictionInterval", { defaultValue: "Prediction interval" })}</dt><dd>{intervalText(currentPrediction.predictionLower, currentPrediction.predictionUpper, notEstimable)}</dd></div>
      </dl>
      {currentPrediction.extrapolatedColumns.length > 0 ? (
        <p className="sp-fit-model-profiler-warning" role="status">
          {t("fitModel.report.profiler.extrapolation", {
            defaultValue: "Outside training range: {{columns}}",
            columns: currentPrediction.extrapolatedColumns.join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
}
