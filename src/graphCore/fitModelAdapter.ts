import type { EChartsOption } from "echarts";

import type { FitModelProfilerPoint } from "@/components/fitModel/fitModelPrediction";
import type { FitModelPlotRow, FitModelQqRow } from "@/types/fitModel";
import { getGraphTheme } from "./theme";

const POINT_SYMBOL_SIZE = 6;
const FALLBACK_MIN = 0;
const FALLBACK_MAX = 1;

export interface FitModelChartInput {
  title: string;
  sampledSubtitle?: string;
  plotRows: FitModelPlotRow[];
  labels: FitModelChartLabels;
}

export interface FitModelChartLabels {
  predictedAxisName: string;
  actualAxisName: string;
  residualAxisName: string;
  actualSeriesName: string;
  residualSeriesName: string;
  identityReferenceName: string;
  zeroReferenceName: string;
  tooltipXLabel: string;
  tooltipYLabel: string;
}

export interface FitModelQqChartInput {
  title: string;
  sampledSubtitle?: string;
  rows: FitModelQqRow[];
  labels: FitModelQqChartLabels;
}

export interface FitModelQqChartLabels {
  theoreticalAxisName: string;
  studentizedResidualAxisName: string;
  residualSeriesName: string;
  referenceSeriesName: string;
  tooltipXLabel: string;
  tooltipYLabel: string;
}

type AxisExtent = {
  min: number;
  max: number;
};

function ensureFinite(value: number, field: string, rowIndex: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`fitModelAdapter: non-finite ${field} at plotRows[${rowIndex}]`);
  }
  return value;
}

function axisExtentFromRaw(min: number, max: number): AxisExtent {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("fitModelAdapter: non-finite chart extent");
  }

  if (min === max) {
    const delta = Math.max(Math.abs(min) * 0.05, 1);
    return { min: min - delta, max: max + delta };
  }

  return { min, max };
}

function resolvePredictedExtent(rows: FitModelPlotRow[]): AxisExtent {
  if (rows.length === 0) {
    return { min: FALLBACK_MIN, max: FALLBACK_MAX };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  rows.forEach((row, index) => {
    const fitted = ensureFinite(row.fitted, "fitted", index);
    min = Math.min(min, fitted);
    max = Math.max(max, fitted);
  });
  return { min, max };
}

function resolveCombinedObservedFittedExtent(rows: FitModelPlotRow[]): AxisExtent {
  if (rows.length === 0) {
    return { min: FALLBACK_MIN, max: FALLBACK_MAX };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  rows.forEach((row, index) => {
    const observed = ensureFinite(row.observed, "observed", index);
    const fitted = ensureFinite(row.fitted, "fitted", index);
    min = Math.min(min, observed, fitted);
    max = Math.max(max, observed, fitted);
  });
  return { min, max };
}

function resolveResidualExtent(rows: FitModelPlotRow[]): AxisExtent {
  if (rows.length === 0) {
    return { min: FALLBACK_MIN, max: FALLBACK_MAX };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  rows.forEach((row, index) => {
    const residual = ensureFinite(row.residual, "residual", index);
    min = Math.min(min, residual, 0);
    max = Math.max(max, residual, 0);
  });
  return { min, max };
}

function resolveQqExtent(rows: FitModelQqRow[]): AxisExtent {
  if (rows.length === 0) {
    return { min: FALLBACK_MIN, max: FALLBACK_MAX };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  rows.forEach((row, index) => {
    const theoretical = ensureFinite(row.theoreticalQuantile, "theoreticalQuantile", index);
    const residual = ensureFinite(row.studentizedResidual, "studentizedResidual", index);
    min = Math.min(min, theoretical, residual);
    max = Math.max(max, theoretical, residual);
  });
  return axisExtentFromRaw(min, max);
}

function tooltipValue(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("fitModelAdapter: non-finite tooltip value");
  }
  if (value === 0) return "0";
  return Number.parseFloat(value.toPrecision(6)).toString();
}

function baseOption(
  title: string,
  sampledSubtitle: string | undefined,
  tooltipXLabel: string,
  tooltipYLabel: string,
): EChartsOption {
  const theme = getGraphTheme();
  return {
    animation: false,
    backgroundColor: "transparent",
    title: {
      text: title,
      subtext: sampledSubtitle,
      left: 8,
      top: 4,
      textStyle: { color: theme.fgPrimary, fontSize: 12 },
      subtextStyle: { color: theme.fgDim, fontSize: 11 },
    },
    grid: { left: 56, right: 20, top: sampledSubtitle ? 52 : 36, bottom: 40, containLabel: false },
    legend: { show: false },
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const head = Array.isArray(params) ? params[0] : params;
        const payload = (head ?? {}) as { seriesName?: string; value?: unknown };
        const value = Array.isArray(payload.value) ? payload.value : [];
        const x = typeof value[0] === "number" ? value[0] : Number.NaN;
        const y = typeof value[1] === "number" ? value[1] : Number.NaN;
        return `${payload.seriesName ?? ""}<br/>${tooltipXLabel}: ${tooltipValue(x)}<br/>${tooltipYLabel}: ${tooltipValue(y)}`;
      },
    },
  };
}

export function buildActualByPredictedOption(input: FitModelChartInput): EChartsOption {
  const theme = getGraphTheme();
  const points = input.plotRows.map((row, index) => {
    const x = ensureFinite(row.fitted, "fitted", index);
    const y = ensureFinite(row.observed, "observed", index);
    return [x, y] as [number, number];
  });

  const predictedExtent = resolvePredictedExtent(input.plotRows);
  const combinedExtent = resolveCombinedObservedFittedExtent(input.plotRows);
  const predictedAxisExtent = axisExtentFromRaw(predictedExtent.min, predictedExtent.max);
  const combinedAxisExtent = axisExtentFromRaw(combinedExtent.min, combinedExtent.max);

  return {
    ...baseOption(input.title, input.sampledSubtitle, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      min: predictedAxisExtent.min,
      max: predictedAxisExtent.max,
      name: input.labels.predictedAxisName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: combinedAxisExtent.min,
      max: combinedAxisExtent.max,
      name: input.labels.actualAxisName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    series: [
      {
        name: input.labels.actualSeriesName,
        type: "scatter",
        clip: true,
        symbolSize: POINT_SYMBOL_SIZE,
        progressive: 400,
        progressiveThreshold: 3000,
        itemStyle: { color: theme.accent },
        data: points,
      },
      {
        name: input.labels.identityReferenceName,
        type: "line",
        clip: true,
        showSymbol: false,
        silent: true,
        lineStyle: { color: theme.fgDim, width: 1.5, type: "dashed" },
        data: [
          [combinedAxisExtent.min, combinedAxisExtent.min],
          [combinedAxisExtent.max, combinedAxisExtent.max],
        ],
      },
    ],
  };
}

export function buildResidualByPredictedOption(input: FitModelChartInput): EChartsOption {
  const theme = getGraphTheme();
  const points = input.plotRows.map((row, index) => {
    const x = ensureFinite(row.fitted, "fitted", index);
    const y = ensureFinite(row.residual, "residual", index);
    return [x, y] as [number, number];
  });

  const predictedExtent = resolvePredictedExtent(input.plotRows);
  const residualExtent = resolveResidualExtent(input.plotRows);
  const predictedAxisExtent = axisExtentFromRaw(predictedExtent.min, predictedExtent.max);
  const residualAxisExtent = axisExtentFromRaw(residualExtent.min, residualExtent.max);

  return {
    ...baseOption(input.title, input.sampledSubtitle, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      min: predictedAxisExtent.min,
      max: predictedAxisExtent.max,
      name: input.labels.predictedAxisName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: residualAxisExtent.min,
      max: residualAxisExtent.max,
      name: input.labels.residualAxisName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    series: [
      {
        name: input.labels.residualSeriesName,
        type: "scatter",
        clip: true,
        symbolSize: POINT_SYMBOL_SIZE,
        progressive: 400,
        progressiveThreshold: 3000,
        itemStyle: { color: theme.accent },
        data: points,
      },
      {
        name: input.labels.zeroReferenceName,
        type: "line",
        clip: true,
        showSymbol: false,
        silent: true,
        lineStyle: { color: theme.fgDim, width: 1.5 },
        data: [
          [predictedAxisExtent.min, 0],
          [predictedAxisExtent.max, 0],
        ],
      },
    ],
  };
}

export function buildResidualQqOption(input: FitModelQqChartInput): EChartsOption {
  const theme = getGraphTheme();
  const points = input.rows.map((row, index) => [
    ensureFinite(row.theoreticalQuantile, "theoreticalQuantile", index),
    ensureFinite(row.studentizedResidual, "studentizedResidual", index),
  ] as [number, number]);
  const extent = resolveQqExtent(input.rows);

  return {
    ...baseOption(input.title, input.sampledSubtitle, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      min: extent.min,
      max: extent.max,
      name: input.labels.theoreticalAxisName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: extent.min,
      max: extent.max,
      name: input.labels.studentizedResidualAxisName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    series: [
      {
        name: input.labels.residualSeriesName,
        type: "scatter",
        clip: true,
        symbolSize: POINT_SYMBOL_SIZE,
        progressive: 400,
        progressiveThreshold: 3000,
        itemStyle: { color: theme.accent },
        data: points,
      },
      {
        name: input.labels.referenceSeriesName,
        type: "line",
        clip: true,
        showSymbol: false,
        silent: true,
        lineStyle: { color: theme.fgDim, width: 1.5, type: "dashed" },
        data: [
          [extent.min, extent.min],
          [extent.max, extent.max],
        ],
      },
    ],
  };
}

export interface FitModelProfilerChartInput {
  predictorName: string;
  responseName: string;
  currentValue: number;
  currentPrediction: number;
  points: FitModelProfilerPoint[];
  labels: FitModelProfilerChartLabels;
}

export interface FitModelProfilerChartLabels {
  predictedSeriesName: string;
  meanConfidenceSeriesName: string;
  currentValueName: string;
  tooltipXLabel: string;
  tooltipYLabel: string;
}

export function buildFitModelProfilerOption(input: FitModelProfilerChartInput): EChartsOption {
  const theme = getGraphTheme();
  const predicted = input.points.map((point, index) => [
    ensureFinite(point.value, "value", index),
    ensureFinite(point.predicted, "predicted", index),
  ] as [number, number]);
  const intervalPoints = input.points.filter(
    (point) => point.meanConfidenceLower !== null && point.meanConfidenceUpper !== null,
  );
  const lower = intervalPoints.map((point, index) => [
    ensureFinite(point.value, "value", index),
    ensureFinite(point.meanConfidenceLower as number, "meanConfidenceLower", index),
  ] as [number, number]);
  const width = intervalPoints.map((point, index) => [
    ensureFinite(point.value, "value", index),
    ensureFinite((point.meanConfidenceUpper as number) - (point.meanConfidenceLower as number), "meanConfidenceWidth", index),
  ] as [number, number]);

  return {
    ...baseOption(input.predictorName, undefined, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      name: input.predictorName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      name: input.responseName,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    series: [
      {
        name: input.labels.meanConfidenceSeriesName,
        type: "line",
        clip: true,
        stack: "mean-confidence",
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        data: lower,
      },
      {
        name: input.labels.meanConfidenceSeriesName,
        type: "line",
        clip: true,
        stack: "mean-confidence",
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { color: theme.accent, opacity: 0.16 },
        data: width,
      },
      {
        name: input.labels.predictedSeriesName,
        type: "line",
        clip: true,
        showSymbol: false,
        lineStyle: { color: theme.accent, width: 2 },
        data: predicted,
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { color: theme.fgDim, type: "dashed" },
          data: [{ name: input.labels.currentValueName, xAxis: ensureFinite(input.currentValue, "currentValue", 0) }],
        },
        markPoint: {
          symbol: "circle",
          symbolSize: 8,
          label: { show: false },
          itemStyle: { color: theme.accent },
          data: [{
            name: input.labels.currentValueName,
            coord: [
              ensureFinite(input.currentValue, "currentValue", 0),
              ensureFinite(input.currentPrediction, "currentPrediction", 0),
            ],
          }],
        },
      },
    ],
  };
}