import type { EChartsOption } from "echarts";

import type {
  FitModelProfilerDomain,
  FitModelProfilerPoint,
} from "@/components/fitModel/fitModelPrediction";
import type { FitModelEffectRow } from "@/components/fitModel/fitModelReportModel";
import type {
  FitModelLeveragePlot,
  FitModelPlotRow,
  FitModelQqRow,
} from "@/types/fitModel";
import { getGraphTheme } from "./theme";

const POINT_SYMBOL_SIZE = 6;
const FALLBACK_MIN = 0;
const FALLBACK_MAX = 1;

export interface FitModelChartInput {
  title: string;
  sampledSubtitle?: string;
  plotRows: FitModelPlotRow[];
  confidenceRows?: readonly FitModelConfidenceRow[];
  labels: FitModelChartLabels;
}

export interface FitModelConfidenceRow {
  rowIndex: number;
  fitted: number;
  meanConfidenceLower: number | null;
  meanConfidenceUpper: number | null;
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

export interface FitModelEffectSummaryChartInput {
  title: string;
  effects: readonly FitModelEffectRow[];
  labels: FitModelEffectSummaryChartLabels;
}

export interface FitModelEffectSummaryChartLabels {
  logWorthAxisName: string;
  effectAxisName: string;
  effectSeriesName: string;
  significanceReferenceName: string;
  tooltipXLabel: string;
  tooltipYLabel: string;
  unavailableValueLabel: string;
}

export interface FitModelLeverageChartInput {
  title: string;
  responseName: string;
  plot: FitModelLeveragePlot;
  labels: FitModelLeverageChartLabels;
}

export interface FitModelLeverageChartLabels {
  leverageAxisName: string;
  adjustedResponseAxisName: string;
  pointSeriesName: string;
  fittedSeriesName: string;
  confidenceSeriesName: string;
  nullSeriesName: string;
  pValueLabel: string;
  tooltipXLabel: string;
  tooltipYLabel: string;
}

type AxisExtent = {
  min: number;
  max: number;
};

export interface NiceAxisExtent {
  min: number;
  max: number;
  interval: number;
}

const formatAxisTick = (value: number) =>
  value === 0 ? "0" : Number.parseFloat(value.toPrecision(10)).toString();

function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1
    ? 1
    : normalized <= 2
      ? 2
      : normalized <= 2.5
        ? 2.5
        : normalized <= 5
          ? 5
          : 10;
  return factor * magnitude;
}

export function paddedNiceExtent(
  rawMin: number,
  rawMax: number,
  options: { includeZero?: boolean; symmetric?: boolean } = {},
): NiceAxisExtent {
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    throw new Error("fitModelAdapter: non-finite chart extent");
  }

  let min = Math.min(rawMin, rawMax);
  let max = Math.max(rawMin, rawMax);
  if (min === max) {
    const delta = Math.max(Math.abs(min) * 0.1, 1);
    min -= delta;
    max += delta;
  }
  if (options.includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  if (options.symmetric) {
    const paddedAbsolute = Math.max(Math.abs(min), Math.abs(max)) * 1.1;
    const interval = niceStep((paddedAbsolute * 2) / 6);
    const limit = Math.max(interval, Math.ceil(paddedAbsolute / interval) * interval);
    return { min: -limit, max: limit, interval };
  }

  const padding = (max - min) * 0.1;
  const paddedMin = min - padding;
  const paddedMax = max + padding;
  const interval = niceStep((paddedMax - paddedMin) / 6);
  return {
    min: Math.floor(paddedMin / interval) * interval,
    max: Math.ceil(paddedMax / interval) * interval,
    interval,
  };
}

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

function resolveObservedExtent(rows: FitModelPlotRow[]): AxisExtent {
  if (rows.length === 0) {
    return { min: FALLBACK_MIN, max: FALLBACK_MAX };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  rows.forEach((row, index) => {
    const observed = ensureFinite(row.observed, "observed", index);
    min = Math.min(min, observed);
    max = Math.max(max, observed);
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
    grid: { left: 56, right: 32, top: sampledSubtitle ? 56 : 40, bottom: 52, containLabel: true },
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
  const observedExtent = resolveObservedExtent(input.plotRows);
  const predictedAxisExtent = paddedNiceExtent(predictedExtent.min, predictedExtent.max);
  const observedAxisExtent = paddedNiceExtent(observedExtent.min, observedExtent.max);
  const identityMin = Math.max(predictedAxisExtent.min, observedAxisExtent.min);
  const identityMax = Math.min(predictedAxisExtent.max, observedAxisExtent.max);
  const identityData: Array<[number, number]> = identityMin <= identityMax
    ? [[identityMin, identityMin], [identityMax, identityMax]]
    : [];
  const confidenceRows = (input.confidenceRows ?? [])
    .filter((row) => row.meanConfidenceLower !== null && row.meanConfidenceUpper !== null)
    .map((row, index) => {
      const x = ensureFinite(row.fitted, "confidence.fitted", index);
      const lower = ensureFinite(row.meanConfidenceLower as number, "meanConfidenceLower", index);
      const upper = ensureFinite(row.meanConfidenceUpper as number, "meanConfidenceUpper", index);
      return { x, lower, width: ensureFinite(upper - lower, "meanConfidenceWidth", index) };
    })
    .sort((left, right) => left.x - right.x);
  const confidenceLower = confidenceRows.map(({ x, lower }) => [x, lower] as [number, number]);
  const confidenceWidth = confidenceRows.map(({ x, width }) => [x, width] as [number, number]);

  return {
    ...baseOption(input.title, input.sampledSubtitle, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      min: predictedAxisExtent.min,
      max: predictedAxisExtent.max,
      interval: predictedAxisExtent.interval,
      name: input.labels.predictedAxisName,
      nameLocation: "middle",
      nameGap: 38,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10, formatter: formatAxisTick },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: observedAxisExtent.min,
      max: observedAxisExtent.max,
      interval: observedAxisExtent.interval,
      name: input.labels.actualAxisName,
      nameLocation: "middle",
      nameGap: 50,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10, formatter: formatAxisTick },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    series: [
      {
        name: input.labels.actualSeriesName,
        type: "scatter",
        clip: true,
        z: 3,
        symbolSize: POINT_SYMBOL_SIZE,
        progressive: 400,
        progressiveThreshold: 3000,
        itemStyle: { color: theme.accent },
        data: points,
      },
      {
        name: `${input.labels.identityReferenceName} confidence`,
        type: "line",
        clip: true,
        z: 1,
        stack: "actual-confidence",
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        data: confidenceLower,
      },
      {
        name: `${input.labels.identityReferenceName} confidence`,
        type: "line",
        clip: true,
        z: 1,
        stack: "actual-confidence",
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { color: "#d92d20", opacity: 0.14 },
        data: confidenceWidth,
      },
      {
        name: input.labels.identityReferenceName,
        type: "line",
        clip: true,
        z: 2,
        showSymbol: false,
        silent: true,
        lineStyle: { color: "#d92d20", width: 2, type: "solid" },
        data: identityData,
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
  const predictedAxisExtent = paddedNiceExtent(predictedExtent.min, predictedExtent.max);
  const residualAxisExtent = paddedNiceExtent(
    residualExtent.min,
    residualExtent.max,
    { includeZero: true, symmetric: true },
  );

  return {
    ...baseOption(input.title, input.sampledSubtitle, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      min: predictedAxisExtent.min,
      max: predictedAxisExtent.max,
      interval: predictedAxisExtent.interval,
      name: input.labels.predictedAxisName,
      nameLocation: "middle",
      nameGap: 38,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10, formatter: formatAxisTick },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: residualAxisExtent.min,
      max: residualAxisExtent.max,
      interval: residualAxisExtent.interval,
      name: input.labels.residualAxisName,
      nameLocation: "middle",
      nameGap: 50,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10, formatter: formatAxisTick },
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
      nameLocation: "middle",
      nameGap: 30,
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
      nameLocation: "middle",
      nameGap: 42,
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

export function buildEffectSummaryOption(input: FitModelEffectSummaryChartInput): EChartsOption {
  const theme = getGraphTheme();
  const categories = input.effects.map((effect) => effect.termLabel);
  const values = input.effects.map((effect, index) => (
    effect.logWorth === null
      ? null
      : ensureFinite(effect.logWorth, "logWorth", index)
  ));
  const significanceLogWorth = -Math.log10(0.05);

  return {
    ...baseOption(input.title, undefined, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    tooltip: {
      trigger: "item",
      formatter: (params: unknown) => {
        const payload = (params ?? {}) as { dataIndex?: number; value?: unknown };
        const index = typeof payload.dataIndex === "number" ? payload.dataIndex : -1;
        const effect = input.effects[index];
        if (effect?.logWorth === null) {
          return `${input.labels.tooltipYLabel}: ${effect.termLabel}<br/>${input.labels.tooltipXLabel}: ${input.labels.unavailableValueLabel}`;
        }
        const value = typeof payload.value === "number" ? payload.value : Number.NaN;
        return `${input.labels.tooltipYLabel}: ${effect?.termLabel ?? ""}<br/>${input.labels.tooltipXLabel}: ${tooltipValue(value)}`;
      },
    },
    grid: { left: 56, right: 32, top: 40, bottom: 52, containLabel: true },
    xAxis: {
      type: "value",
      min: 0,
      name: input.labels.logWorthAxisName,
      nameLocation: "middle",
      nameGap: 38,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "category",
      name: input.labels.effectAxisName,
      nameLocation: "middle",
      nameGap: 50,
      inverse: true,
      data: categories,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
    },
    series: [
      {
        name: input.labels.effectSeriesName,
        type: "bar",
        clip: true,
        itemStyle: { color: theme.accent },
        data: values,
        markLine: {
          silent: true,
          symbol: "none",
          label: {
            show: true,
            color: "#d92d20",
            formatter: input.labels.significanceReferenceName,
            position: "insideEndTop",
            distance: 6,
          },
          lineStyle: { color: "#d92d20", width: 1.5, type: "solid" },
          data: [{ name: input.labels.significanceReferenceName, xAxis: significanceLogWorth }],
        },
      },
    ],
  };
}

export function buildFitModelLeverageOption(input: FitModelLeverageChartInput): EChartsOption {
  const theme = getGraphTheme();
  const points = input.plot.points.map((point, index) => [
    ensureFinite(point.effectLeverage, "effectLeverage", index),
    ensureFinite(point.adjustedResponse, "adjustedResponse", index),
  ] as [number, number]);
  const fitted = input.plot.confidenceBand.map((point, index) => [
    ensureFinite(point.effectLeverage, "effectLeverage", index),
    ensureFinite(point.fitted, "fitted", index),
  ] as [number, number]);
  const lower = input.plot.confidenceBand.map((point, index) => [
    ensureFinite(point.effectLeverage, "effectLeverage", index),
    ensureFinite(point.lower, "lower", index),
  ] as [number, number]);
  const width = input.plot.confidenceBand.map((point, index) => [
    ensureFinite(point.effectLeverage, "effectLeverage", index),
    ensureFinite(point.upper - point.lower, "confidenceWidth", index),
  ] as [number, number]);
  const xValues = [...points, ...fitted].map(([x]) => x);
  const yValues = [
    ...points.map(([, y]) => y),
    ...input.plot.confidenceBand.flatMap((point, index) => [
      ensureFinite(point.lower, "lower", index),
      ensureFinite(point.upper, "upper", index),
    ]),
    ...(input.plot.nullLineY === null
      ? []
      : [ensureFinite(input.plot.nullLineY, "nullLineY", 0)]),
  ];
  const xExtent = xValues.length === 0
    ? { min: FALLBACK_MIN, max: FALLBACK_MAX, interval: 0.2 }
    : paddedNiceExtent(Math.min(...xValues), Math.max(...xValues));
  const yExtent = yValues.length === 0
    ? { min: FALLBACK_MIN, max: FALLBACK_MAX, interval: 0.2 }
    : paddedNiceExtent(Math.min(...yValues), Math.max(...yValues));
  const subtitle = input.plot.pValue === null
    ? undefined
    : `${input.labels.pValueLabel}: ${tooltipValue(ensureFinite(input.plot.pValue, "pValue", 0))}`;
  const nullSeries = input.plot.nullLineY === null
    ? []
    : [{
        name: input.labels.nullSeriesName,
        type: "line" as const,
        clip: true,
        showSymbol: false,
        silent: true,
        lineStyle: { color: theme.fgDim, width: 1.5, type: "dashed" as const },
        data: [
          [xExtent.min, ensureFinite(input.plot.nullLineY, "nullLineY", 0)],
          [xExtent.max, ensureFinite(input.plot.nullLineY, "nullLineY", 0)],
        ],
      }];

  return {
    ...baseOption(input.title, subtitle, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      min: xExtent.min,
      max: xExtent.max,
      interval: xExtent.interval,
      name: input.labels.leverageAxisName,
      nameLocation: "middle",
      nameGap: 30,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10, formatter: formatAxisTick },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: yExtent.min,
      max: yExtent.max,
      interval: yExtent.interval,
      name: input.labels.adjustedResponseAxisName || input.responseName,
      nameLocation: "middle",
      nameGap: 42,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10, formatter: formatAxisTick },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    series: [
      {
        name: input.labels.confidenceSeriesName,
        type: "line",
        clip: true,
        stack: "leverage-confidence",
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        data: lower,
      },
      {
        name: input.labels.confidenceSeriesName,
        type: "line",
        clip: true,
        stack: "leverage-confidence",
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { color: theme.accent, opacity: 0.16 },
        data: width,
      },
      {
        name: input.labels.fittedSeriesName,
        type: "line",
        clip: true,
        showSymbol: false,
        lineStyle: { color: theme.accent, width: 2 },
        data: fitted,
      },
      ...nullSeries,
      {
        name: input.labels.pointSeriesName,
        type: "scatter",
        clip: true,
        symbolSize: POINT_SYMBOL_SIZE,
        progressive: 400,
        progressiveThreshold: 3000,
        itemStyle: { color: theme.accent },
        data: points,
      },
    ],
  };
}

export interface FitModelProfilerChartInput {
  predictorName: string;
  responseName: string;
  currentValue: number;
  currentPrediction: number;
  yDomain: FitModelProfilerDomain;
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
  const yMin = ensureFinite(input.yDomain.min, "yDomain.min", 0);
  const yMax = ensureFinite(input.yDomain.max, "yDomain.max", 0);
  if (yMin >= yMax) {
    throw new Error("fitModelAdapter: profiler Y domain min must be less than max");
  }
  const predicted = input.points.map((point, index) => [
    ensureFinite(point.value, "value", index),
    ensureFinite(point.predicted, "predicted", index),
  ] as [number, number]);
  const predictorValues = predicted.map(([value]) => value);
  const predictorMin = predictorValues.length > 0 ? Math.min(...predictorValues) : undefined;
  const predictorMax = predictorValues.length > 0 ? Math.max(...predictorValues) : undefined;
  const hasPredictorSpan = predictorMin !== undefined
    && predictorMax !== undefined
    && predictorMin < predictorMax;
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
    ...baseOption("", undefined, input.labels.tooltipXLabel, input.labels.tooltipYLabel),
    xAxis: {
      type: "value",
      min: hasPredictorSpan ? predictorMin : undefined,
      max: hasPredictorSpan ? predictorMax : undefined,
      name: input.predictorName,
      nameLocation: "middle",
      nameGap: 30,
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      axisTick: { show: true, lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
    },
    yAxis: {
      type: "value",
      min: yMin,
      max: yMax,
      name: input.responseName,
      nameLocation: "middle",
      nameGap: 42,
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
          lineStyle: { color: "#d92d20", width: 1.5, type: "solid" },
          data: [{ name: input.labels.currentValueName, xAxis: ensureFinite(input.currentValue, "currentValue", 0) }],
        },
        markPoint: {
          symbol: "circle",
          symbolSize: 8,
          label: { show: false },
          itemStyle: { color: "#d92d20" },
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