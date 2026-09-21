import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildFitModelProfilerOption } from "@/graphCore/fitModelAdapter";
import type { FitModelSnapshot } from "@/types/fitModel";

import { FitModelDiagnosticChart } from "./FitModelDiagnosticChart";
import {
  fitModelProfilerYDomain,
  predictFitModelPoint,
  scanFitModelPredictor,
} from "./fitModelPrediction";
import { formatFitModelReportValue } from "./fitModelReportModel";

export interface FitModelProfilerProps {
  snapshot: FitModelSnapshot;
  responseName: string;
}

interface FitModelProfilerValueState {
  snapshot: FitModelSnapshot;
  values: Record<string, number>;
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
  const snapshotInitialValues = useMemo(() => initialValues(snapshot), [snapshot]);
  const [valueState, setValueState] = useState<FitModelProfilerValueState>(() => ({
    snapshot,
    values: snapshotInitialValues,
  }));
  const values = valueState.snapshot === snapshot ? valueState.values : snapshotInitialValues;

  useEffect(() => {
    if (valueState.snapshot !== snapshot) {
      setValueState({ snapshot, values: snapshotInitialValues });
    }
  }, [snapshot, snapshotInitialValues, valueState.snapshot]);

  const effectiveValues = useMemo(
    () => Object.fromEntries(snapshot.predictorRanges.map((range) => [
      range.columnName,
      values[range.columnName] ?? range.mean,
    ])),
    [snapshot, values],
  );
  const scans = useMemo(() => snapshot.predictorRanges.map((range) => ({
    range,
    points: scanFitModelPredictor(snapshot, effectiveValues, range.columnName),
  })), [effectiveValues, snapshot]);
  const yDomain = useMemo(
    () => fitModelProfilerYDomain(scans.map((scan) => scan.points)),
    [scans],
  );
  const currentPrediction = useMemo(
    () => predictFitModelPoint(snapshot, effectiveValues),
    [effectiveValues, snapshot],
  );
  const notEstimable = t("fitModel.report.profiler.notEstimable", { defaultValue: "Not estimable" });

  const updateValue = (columnName: string, value: number) => {
    if (!Number.isFinite(value)) return;
    setValueState({
      snapshot,
      values: { ...effectiveValues, [columnName]: value },
    });
  };

  return (
    <div className="sp-fit-model-profiler">
      <div className="sp-fit-model-profiler-track">
        {scans.map(({ range, points }, index) => {
          const value = effectiveValues[range.columnName];
          const numberInputId = `${inputIdPrefix}-number-${index}`;
          const option = buildFitModelProfilerOption({
            predictorName: range.columnName,
            responseName,
            currentValue: value,
            currentPrediction: currentPrediction.predicted,
            yDomain,
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
            <article
              key={range.columnName}
              className="sp-fit-model-profiler-column"
              data-profiler-column={range.columnName}
              data-y-domain-min={yDomain.min}
              data-y-domain-max={yDomain.max}
              data-marker-x={value}
              data-marker-y={currentPrediction.predicted}
              data-curve-start-y={points[0]?.predicted}
              data-curve-end-y={points[points.length - 1]?.predicted}
            >
              <FitModelDiagnosticChart
                title={`${range.columnName} ${t("fitModel.report.section.predictionProfiler", { defaultValue: "Prediction Profiler" })}`}
                chartKind="predictionProfiler"
                option={option}
                onXAxisPointerValue={(next) => updateValue(
                  range.columnName,
                  Math.min(range.maximum, Math.max(range.minimum, next)),
                )}
              />
              <label className="sp-fit-model-profiler-value" htmlFor={numberInputId}>
                <span>{range.columnName}</span>
                <input
                  id={numberInputId}
                  type="number"
                  step="any"
                  value={value}
                  aria-label={`${range.columnName} ${t("fitModel.report.profiler.currentValue", { defaultValue: "Current value" })}`}
                  onChange={(event) => updateValue(range.columnName, event.currentTarget.valueAsNumber)}
                />
              </label>
            </article>
          );
        })}
      </div>
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
