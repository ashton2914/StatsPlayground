import type { EChartsOption } from "echarts";

import { getGraphTheme } from "@/graphCore/theme";
import type { HypothesisTestPlotData, HypothesisTestValue } from "@/types/hypothesisTest";

interface HypothesisTestGraphDisplay {
  showRawData: boolean;
  showIntervals: boolean;
}

export interface HypothesisTestGraphLabels {
  distribution: string;
  observations: string;
  meanInterval: string;
  subjectProfile: string;
  responseAxis: string;
  observationOrderAxis: string;
  groupResiduals: string;
  pairedDifferences: string;
  additiveResiduals: string;
  theoreticalQuantileAxis: string;
  observedDiagnosticAxis: string;
  diagnosticValues: string;
  reference: string;
}

const DEFAULT_LABELS: HypothesisTestGraphLabels = {
  distribution: "Distribution",
  observations: "Observations",
  meanInterval: "Mean interval",
  subjectProfile: "Subject profile",
  responseAxis: "Response",
  observationOrderAxis: "Observation order",
  groupResiduals: "Group residuals",
  pairedDifferences: "Paired differences",
  additiveResiduals: "Additive residuals",
  theoreticalQuantileAxis: "Theoretical quantile",
  observedDiagnosticAxis: "Observed diagnostic value",
  diagnosticValues: "Diagnostic values",
  reference: "Reference",
};

function baseOption(): EChartsOption {
  const theme = getGraphTheme();
  return {
    animationDuration: 180,
    backgroundColor: "transparent",
    grid: { left: 18, right: 24, top: 22, bottom: 18, containLabel: true },
    legend: { top: 0, textStyle: { color: theme.fgSecondary, fontSize: 10 } },
    tooltip: { trigger: "item" },
  };
}

function categoryAxis(conditions: string[]) {
  const theme = getGraphTheme();
  return {
    type: "category" as const,
    data: conditions,
    axisLine: { lineStyle: { color: theme.axisLine } },
    axisTick: { alignWithLabel: true, lineStyle: { color: theme.axisLine } },
    axisLabel: { color: theme.fgSecondary, fontSize: 10, interval: 0 },
  };
}

function valueAxis(name: string) {
  const theme = getGraphTheme();
  return {
    type: "value" as const,
    name,
    nameLocation: "middle" as const,
    nameGap: 42,
    nameTextStyle: { color: theme.fgSecondary, fontSize: 10 },
    axisLine: { show: true, lineStyle: { color: theme.axisLine } },
    axisTick: { show: true, lineStyle: { color: theme.axisLine } },
    axisLabel: { color: theme.fgSecondary, fontSize: 10 },
    splitLine: { lineStyle: { color: theme.gridLine, type: "dashed" as const } },
  };
}

function available(value: HypothesisTestValue): number | null {
  return value.state === "available" ? value.value : null;
}

function intervalSeries(plotData: HypothesisTestPlotData, labels: HypothesisTestGraphLabels) {
  const theme = getGraphTheme();
  return {
    name: labels.meanInterval,
    type: "custom" as const,
    clip: true,
    renderItem: (_params: unknown, api: { value: (index: number) => unknown; coord: (value: [number, number]) => [number, number] }) => {
      const conditionIndex = Number(api.value(0));
      const lower = Number(api.value(1));
      const upper = Number(api.value(2));
      const lowPoint = api.coord([conditionIndex, lower]);
      const highPoint = api.coord([conditionIndex, upper]);
      return {
        type: "line" as const,
        shape: { x1: lowPoint[0], y1: lowPoint[1], x2: highPoint[0], y2: highPoint[1] },
        style: { stroke: theme.fgPrimary, lineWidth: 3 },
      };
    },
    data: plotData.summaries.flatMap((summary, index) => {
      const lower = available(summary.meanIntervalLower);
      const upper = available(summary.meanIntervalUpper);
      return lower == null || upper == null ? [] : [[index, lower, upper, summary.mean]];
    }),
    z: 5,
  };
}

export function buildHypothesisTestMainOption(
  plotData: HypothesisTestPlotData,
  display: HypothesisTestGraphDisplay,
  labels: HypothesisTestGraphLabels = DEFAULT_LABELS,
): EChartsOption {
  const theme = getGraphTheme();
  const series: Array<Record<string, unknown>> = [];
  if (plotData.studyStructure === "independent") {
    series.push({
      name: labels.distribution,
      type: "boxplot",
      clip: true,
      itemStyle: { color: theme.sequential[0], borderColor: theme.accent },
      data: plotData.summaries.map((summary) => [
        summary.minimum,
        summary.lowerQuartile,
        summary.median,
        summary.upperQuartile,
        summary.maximum,
      ]),
    });
    if (display.showRawData) {
      series.push({
        name: labels.observations,
        type: "scatter",
        clip: true,
        symbolSize: 6,
        itemStyle: { color: theme.accent, opacity: 0.55 },
        data: plotData.observations.map((observation) => [observation.condition, observation.value]),
      });
    }
  } else if (display.showRawData) {
    const subjects = [...new Set(plotData.observations.flatMap((observation) => observation.subject == null ? [] : [observation.subject]))];
    for (const subject of subjects) {
      series.push({
        name: labels.subjectProfile,
        type: "line",
        clip: true,
        showSymbol: true,
        symbolSize: 4,
        silent: true,
        lineStyle: { color: theme.fgDim, width: 1, opacity: 0.3 },
        itemStyle: { color: theme.fgDim, opacity: 0.45 },
        data: plotData.conditions.map((condition) => {
          const observation = plotData.observations.find((item) => item.subject === subject && item.condition === condition);
          return [condition, observation?.value ?? null];
        }),
      });
    }
  }
  if (display.showIntervals) series.push(intervalSeries(plotData, labels));

  return {
    ...baseOption(),
    xAxis: categoryAxis(plotData.conditions),
    yAxis: valueAxis(labels.responseAxis),
    series,
  };
}

export function buildHypothesisTestDiagnosticOption(
  plotData: HypothesisTestPlotData,
  labels: HypothesisTestGraphLabels = DEFAULT_LABELS,
): EChartsOption {
  const theme = getGraphTheme();
  const label = plotData.diagnosticKind === "pairedDifferences"
    ? labels.pairedDifferences
    : plotData.diagnosticKind === "additiveResiduals"
      ? labels.additiveResiduals
      : labels.groupResiduals;
  return {
    ...baseOption(),
    xAxis: {
      type: "value",
      name: labels.observationOrderAxis,
      nameLocation: "middle",
      nameGap: 28,
      axisLabel: { color: theme.fgSecondary, fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis: valueAxis(label),
    series: [{
      name: label,
      type: "scatter",
      clip: true,
      symbolSize: 6,
      itemStyle: { color: theme.accent },
      data: plotData.diagnosticValues.map((value, index) => [index + 1, value]),
      markLine: { silent: true, symbol: "none", lineStyle: { color: theme.fgDim }, data: [{ yAxis: 0 }] },
    }],
  };
}

export function buildHypothesisTestQqOption(
  plotData: HypothesisTestPlotData,
  labels: HypothesisTestGraphLabels = DEFAULT_LABELS,
): EChartsOption {
  const theme = getGraphTheme();
  const points = plotData.qqPoints.map((point) => [point.theoretical, point.observed]);
  const coordinates = points.flat();
  const minimum = Math.min(...coordinates);
  const maximum = Math.max(...coordinates);
  const padding = Math.max((maximum - minimum) * 0.05, 0.1);
  const lower = minimum - padding;
  const upper = maximum + padding;
  return {
    ...baseOption(),
    xAxis: { ...valueAxis(labels.theoreticalQuantileAxis), min: lower, max: upper, nameGap: 30 },
    yAxis: { ...valueAxis(labels.observedDiagnosticAxis), min: lower, max: upper },
    series: [
      {
        name: labels.diagnosticValues,
        type: "scatter",
        clip: true,
        symbolSize: 6,
        itemStyle: { color: theme.accent },
        data: points,
      },
      {
        name: labels.reference,
        type: "line",
        clip: true,
        showSymbol: false,
        silent: true,
        lineStyle: { color: theme.fgDim, width: 1.5, type: "dashed" },
        data: [[lower, lower], [upper, upper]],
      },
    ],
  };
}