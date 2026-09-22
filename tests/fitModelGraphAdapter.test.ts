import assert from "node:assert/strict";

import {
  buildActualByPredictedOption,
  buildEffectSummaryOption,
  buildFitModelLeverageOption,
  buildFitModelProfilerOption,
  buildResidualByPredictedOption,
  buildResidualQqOption,
} from "../src/graphCore/fitModelAdapter.ts";
import type { FitModelPlotRow } from "../src/types/fitModel.ts";

const SAMPLE_LABELS = {
  predictedAxisName: "Predicted",
  actualAxisName: "Actual",
  residualAxisName: "Residual",
  actualSeriesName: "Actual",
  residualSeriesName: "Residual",
  identityReferenceName: "y=x",
  zeroReferenceName: "y=0",
  tooltipXLabel: "Predicted",
  tooltipYLabel: "Actual",
};

function findLineSeries(option: unknown, name: string): { data: Array<[number, number]> } {
  const series = (option as { series?: Array<{ name?: string; type?: string; data?: Array<[number, number]> }> }).series ?? [];
  const line = series.find((entry) => entry.type === "line" && entry.name === name);
  assert.ok(line, `missing line series ${name}`);
  return line as { data: Array<[number, number]> };
}

function assertAllFinite(points: Array<[number, number]>, label: string): void {
  points.forEach(([x, y], index) => {
    assert.ok(Number.isFinite(x), `${label} x at ${index} must be finite`);
    assert.ok(Number.isFinite(y), `${label} y at ${index} must be finite`);
  });
}

function testActualAndResidualPointsAndAxes(): void {
  const rows: FitModelPlotRow[] = [
    { rowIndex: 0, observed: 2, fitted: 1.5, residual: 0.5 },
    { rowIndex: 1, observed: 4, fitted: 4.5, residual: -0.5 },
  ];

  const actual = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: rows,
  }) as {
    xAxis: { name: string };
    yAxis: { name: string };
    series: Array<{ data: Array<[number, number]> }>;
  };

  const residual = buildResidualByPredictedOption({
    title: "Residual by Predicted",
    labels: { ...SAMPLE_LABELS, tooltipYLabel: "Residual" },
    plotRows: rows,
  }) as {
    xAxis: { name: string };
    yAxis: { name: string };
    series: Array<{ data: Array<[number, number]> }>;
  };

  assert.deepEqual(actual.series[0].data, [[1.5, 2], [4.5, 4]]);
  assert.deepEqual(residual.series[0].data, [[1.5, 0.5], [4.5, -0.5]]);
  assert.equal(actual.xAxis.name, "Predicted");
  assert.equal(actual.yAxis.name, "Actual");
  assert.equal(residual.yAxis.name, "Residual");
}

function testDiagnosticAxesUsePaddedNiceExtents(): void {
  const rows: FitModelPlotRow[] = [
    { rowIndex: 0, observed: 66, fitted: 65, residual: -0.2 },
    { rowIndex: 1, observed: 70, fitted: 71, residual: 0.3 },
  ];
  const actual = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: rows,
  }) as {
    grid: { left: number; bottom: number };
    xAxis: { min: number; max: number; interval: number };
  };
  const residual = buildResidualByPredictedOption({
    title: "Residual by Predicted",
    labels: { ...SAMPLE_LABELS, tooltipYLabel: "Residual" },
    plotRows: rows,
  }) as {
    yAxis: {
      min: number;
      max: number;
      interval: number;
      axisLabel: { formatter: (value: number) => string };
    };
  };

  assert.ok(actual.xAxis.min < 65);
  assert.ok(actual.xAxis.max > 71);
  assert.equal((actual.xAxis.max - actual.xAxis.min) / actual.xAxis.interval % 1, 0);
  assert.equal(residual.yAxis.min, -residual.yAxis.max);
  assert.doesNotMatch(residual.yAxis.axisLabel.formatter(residual.yAxis.min), /000000|999999/);
  assert.ok(actual.grid.left >= 48);
  assert.ok(actual.grid.bottom >= 48);
}

function testActualAxesUseIndependentObservedAndFittedExtents(): void {
  const actual = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: [
      { rowIndex: 0, observed: 10, fitted: 15, residual: -5 },
      { rowIndex: 1, observed: 20, fitted: 1000, residual: -980 },
    ],
  }) as {
    xAxis: { min: number; max: number };
    yAxis: { min: number; max: number };
  };
  const identity = findLineSeries(actual, "y=x");

  assert.ok(actual.xAxis.min < 15);
  assert.ok(actual.xAxis.max > 1000);
  assert.deepEqual(
    { min: actual.yAxis.min, max: actual.yAxis.max },
    { min: 8, max: 22 },
  );
  identity.data.forEach(([x, y]) => {
    assert.equal(x, y);
    assert.ok(x >= actual.xAxis.min && x <= actual.xAxis.max);
    assert.ok(y >= actual.yAxis.min && y <= actual.yAxis.max);
  });
}

function testActualPredictedAxisIncludesConfidenceCoordinates(): void {
  const actual = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: [
      { rowIndex: 0, observed: 10, fitted: 10, residual: 0 },
      { rowIndex: 1, observed: 20, fitted: 20, residual: 0 },
    ],
    actualByPredictedConfidenceBand: [
      { predicted: -5, fitted: -5, lower: -6, upper: -4 },
      { predicted: 35, fitted: 35, lower: 34, upper: 36 },
    ],
  }) as {
    xAxis: { min: number; max: number };
  };

  assert.ok(actual.xAxis.min < -5);
  assert.ok(actual.xAxis.max > 35);
}

function testReferenceLinesFiniteAndCorrect(): void {
  const rows: FitModelPlotRow[] = [
    { rowIndex: 0, observed: 2, fitted: 1.5, residual: 0.5 },
    { rowIndex: 1, observed: 4, fitted: 4.5, residual: -0.5 },
  ];

  const actual = buildActualByPredictedOption({ title: "Actual by Predicted", labels: SAMPLE_LABELS, plotRows: rows });
  const residual = buildResidualByPredictedOption({
    title: "Residual by Predicted",
    labels: { ...SAMPLE_LABELS, tooltipYLabel: "Residual" },
    plotRows: rows,
  });

  const identity = findLineSeries(actual, "y=x");
  const zero = findLineSeries(residual, "y=0");

  assert.deepEqual(identity.data, [[1.5, 1.5], [4.5, 4.5]]);
  assert.deepEqual(zero.data, [[1, 0], [5, 0]]);
  assertAllFinite(identity.data, "identity");
  assertAllFinite(zero.data, "zero");
}

function testTooltipValuesAreFinite(): void {
  const rows: FitModelPlotRow[] = [
    { rowIndex: 0, observed: 2, fitted: 1.5, residual: 0.5 },
    { rowIndex: 1, observed: 4, fitted: 4.5, residual: -0.5 },
  ];

  const actual = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: rows,
  }) as {
    tooltip?: { formatter?: (params: unknown) => string };
  };

  const formatter = actual.tooltip?.formatter;
  assert.equal(typeof formatter, "function");

  const value = formatter?.([
    {
      seriesName: "Actual",
      value: [1.5, 2],
    },
  ]);

  assert.equal(typeof value, "string");
  assert.doesNotMatch(value ?? "", /NaN|Infinity/i);
}

function testEmptyInputProducesNonblankOption(): void {
  const option = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: [],
  }) as {
    title?: { text?: string };
    series: Array<{ data: Array<[number, number]> }>;
  };

  assert.equal(option.title?.text, "Actual by Predicted");
  assert.deepEqual(option.series[0].data, []);

  const identity = findLineSeries(option, "y=x");
  assertAllFinite(identity.data, "empty-identity");
}

function testSampledSubtitlePreservesPoints(): void {
  const rows: FitModelPlotRow[] = [
    { rowIndex: 0, observed: 2, fitted: 1.5, residual: 0.5 },
    { rowIndex: 1, observed: 4, fitted: 4.5, residual: -0.5 },
  ];

  const option = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    sampledSubtitle: "Sampled: 2 / 3 rows",
    plotRows: rows,
  }) as {
    title?: { subtext?: string };
    series: Array<{ data: Array<[number, number]> }>;
  };

  assert.equal(option.title?.subtext, "Sampled: 2 / 3 rows");
  assert.deepEqual(option.series[0].data, [[1.5, 2], [4.5, 4]]);
}

function testNonFiniteBoundaryValuesThrow(): void {
  assert.throws(
    () => buildActualByPredictedOption({
      title: "Actual by Predicted",
      labels: SAMPLE_LABELS,
      plotRows: [{ rowIndex: 0, observed: 2, fitted: Number.NaN, residual: 0 }],
    }),
    /non-finite/i,
  );

  assert.throws(
    () => buildResidualByPredictedOption({
      title: "Residual by Predicted",
      labels: { ...SAMPLE_LABELS, tooltipYLabel: "Residual" },
      plotRows: [{ rowIndex: 0, observed: 2, fitted: Number.POSITIVE_INFINITY, residual: 0 }],
    }),
    /non-finite/i,
  );
}

function testSinglePointReferenceLinesUseExpandedFiniteExtent(): void {
  const rows: FitModelPlotRow[] = [{ rowIndex: 0, observed: 5, fitted: 5, residual: 0 }];

  const actual = buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: rows,
  });
  const residual = buildResidualByPredictedOption({
    title: "Residual by Predicted",
    labels: { ...SAMPLE_LABELS, tooltipYLabel: "Residual" },
    plotRows: rows,
  });

  const identity = findLineSeries(actual, "y=x");
  const zero = findLineSeries(residual, "y=0");

  assert.equal(identity.data.length, 2);
  assert.equal(zero.data.length, 2);
  assert.notEqual(identity.data[0]?.[0], identity.data[1]?.[0]);
  assert.notEqual(identity.data[0]?.[1], identity.data[1]?.[1]);
  assert.notEqual(zero.data[0]?.[0], zero.data[1]?.[0]);
  assert.equal(zero.data[0]?.[1], 0);
  assert.equal(zero.data[1]?.[1], 0);
  assertAllFinite(identity.data, "single-point-identity");
  assertAllFinite(zero.data, "single-point-zero");
}

function testResidualQqPointsAndReferenceLine(): void {
  const option = buildResidualQqOption({
    title: "Residual Q-Q",
    rows: [
      { rowIndex: 1, theoreticalQuantile: -0.67, studentizedResidual: -0.5 },
      { rowIndex: 2, theoreticalQuantile: 0.67, studentizedResidual: 0.8 },
    ],
    labels: {
      theoreticalAxisName: "Theoretical quantile",
      studentizedResidualAxisName: "Studentized residual",
      residualSeriesName: "Residual",
      referenceSeriesName: "Reference",
      tooltipXLabel: "Theoretical quantile",
      tooltipYLabel: "Studentized residual",
    },
  }) as {
    series: Array<{ clip?: boolean; data: Array<[number, number]> }>;
  };

  assert.equal(option.series.length, 2);
  assert.deepEqual(option.series[0]?.data, [[-0.67, -0.5], [0.67, 0.8]]);
  assert.ok(option.series.every((series) => series.clip === true));
  assert.doesNotMatch(JSON.stringify(option), /NaN|Infinity/);
}

function testResidualQqBoundaryInputs(): void {
  const labels = {
    theoreticalAxisName: "Theoretical quantile",
    studentizedResidualAxisName: "Studentized residual",
    residualSeriesName: "Residual",
    referenceSeriesName: "Reference",
    tooltipXLabel: "Theoretical quantile",
    tooltipYLabel: "Studentized residual",
  };
  const empty = buildResidualQqOption({ title: "Residual Q-Q", rows: [], labels });
  const single = buildResidualQqOption({
    title: "Residual Q-Q",
    rows: [{ rowIndex: 1, theoreticalQuantile: 0, studentizedResidual: 0 }],
    labels,
  });

  assert.doesNotMatch(JSON.stringify(empty), /NaN|Infinity/);
  assert.doesNotMatch(JSON.stringify(single), /NaN|Infinity/);
  assert.throws(
    () => buildResidualQqOption({
      title: "Residual Q-Q",
      rows: [{ rowIndex: 1, theoreticalQuantile: Number.NaN, studentizedResidual: 0 }],
      labels,
    }),
    /non-finite/i,
  );
}

function testPredictionProfilerCurveAndConfidenceBand(): void {
  const option = buildFitModelProfilerOption({
    predictorName: "A",
    responseName: "Y",
    currentValue: 2,
    currentPrediction: 3,
    yDomain: { min: -2, max: 8 },
    points: [
      { value: 0, predicted: 1, meanConfidenceLower: 0.5, meanConfidenceUpper: 1.5, predictionLower: 0, predictionUpper: 2, inferenceReason: null, extrapolatedColumns: [] },
      { value: 2, predicted: 3, meanConfidenceLower: 2.25, meanConfidenceUpper: 3.75, predictionLower: 1, predictionUpper: 5, inferenceReason: null, extrapolatedColumns: [] },
      { value: 4, predicted: 5, meanConfidenceLower: 4, meanConfidenceUpper: 6, predictionLower: 3, predictionUpper: 7, inferenceReason: null, extrapolatedColumns: [] },
    ],
    labels: {
      predictedSeriesName: "Predicted",
      meanConfidenceSeriesName: "Mean CI",
      currentValueName: "Current value",
      tooltipXLabel: "A",
      tooltipYLabel: "Y",
    },
  }) as {
    xAxis: { name: string; min: number; max: number };
    yAxis: { name: string; min: number; max: number };
    series: Array<{
      name?: string;
      type?: string;
      clip?: boolean;
      data?: Array<[number, number]>;
      markLine?: {
        lineStyle?: { color?: string };
        data: Array<{ xAxis: number }>;
      };
      markPoint?: {
        itemStyle?: { color?: string };
        data: Array<{ coord: [number, number] }>;
      };
    }>;
  };

  assert.equal(option.xAxis.name, "A");
  assert.equal(option.xAxis.min, 0);
  assert.equal(option.xAxis.max, 4);
  assert.equal(option.yAxis.name, "Y");
  assert.equal(option.yAxis.min, -2);
  assert.equal(option.yAxis.max, 8);
  assert.deepEqual(option.series.find((series) => series.name === "Predicted")?.data, [[0, 1], [2, 3], [4, 5]]);
  assert.equal(option.series.filter((series) => series.name === "Mean CI").length, 2);
  assert.ok(option.series.every((series) => series.type === "line" && series.clip === true));
  const markedSeries = option.series.find((series) => series.markLine && series.markPoint);
  assert.equal(markedSeries?.markLine?.lineStyle?.color, "#d92d20");
  assert.equal(markedSeries?.markLine?.data[0]?.xAxis, 2);
  assert.equal(markedSeries?.markPoint?.itemStyle?.color, "#d92d20");
  assert.deepEqual(markedSeries?.markPoint?.data[0]?.coord, [2, 3]);
  assert.ok((markedSeries?.markPoint?.data[0]?.coord[1] ?? Number.NaN) >= option.yAxis.min);
  assert.ok((markedSeries?.markPoint?.data[0]?.coord[1] ?? Number.NaN) <= option.yAxis.max);
  assert.ok(option.series.flatMap((series) => series.data ?? []).every(([, y]) => (
    y >= option.yAxis.min && y <= option.yAxis.max
  )));
  assert.doesNotMatch(JSON.stringify(option), /NaN|Infinity/);
}

function testEffectSummaryHorizontalBarsAndSignificanceReference(): void {
  const option = buildEffectSummaryOption({
    title: "Effect Summary",
    effects: [
      { termId: "interaction:A*B", termLabel: "A*B", kind: "interaction", pValue: 0.001, logWorth: 3 },
      { termId: "A", termLabel: "A", kind: "main", pValue: 0.05, logWorth: -Math.log10(0.05) },
      { termId: "B", termLabel: "B", kind: "main", pValue: null, logWorth: null },
    ],
    labels: {
      logWorthAxisName: "LogWorth",
      effectAxisName: "Effect",
      effectSeriesName: "LogWorth",
      significanceReferenceName: "LogWorth = 1.3",
      tooltipXLabel: "LogWorth",
      tooltipYLabel: "Effect",
      unavailableValueLabel: "Unavailable",
    },
  }) as {
    xAxis: { type: string };
    yAxis: { type: string; data: string[] };
    tooltip?: { formatter?: (params: unknown) => string };
    series: Array<{
      type: string;
      data: Array<number | null>;
      markLine?: {
        data?: Array<{ name?: string; xAxis?: number }>;
        label?: { formatter?: string; position?: string };
        lineStyle?: { color?: string; type?: string };
      };
    }>;
  };

  assert.equal(option.xAxis.type, "value");
  assert.equal(option.yAxis.type, "category");
  assert.deepEqual(option.yAxis.data, ["A*B", "A", "B"]);
  assert.deepEqual(option.series[0]?.data, [3, -Math.log10(0.05), null]);
  assert.equal(
    option.tooltip?.formatter?.({ dataIndex: 2, value: null }),
    "Effect: B<br/>LogWorth: Unavailable",
  );
  assert.equal(option.series[0]?.markLine?.data?.[0]?.name, "LogWorth = 1.3");
  assert.equal(option.series[0]?.markLine?.data?.[0]?.xAxis, -Math.log10(0.05));
  assert.equal(option.series[0]?.markLine?.label?.formatter, "LogWorth = 1.3");
  assert.equal(option.series[0]?.markLine?.label?.position, "insideEndTop");
  assert.equal(option.series[0]?.markLine?.lineStyle?.color, "#d92d20");
  assert.equal(option.series[0]?.markLine?.lineStyle?.type, "solid");
  assert.doesNotMatch(JSON.stringify(option), /NaN|Infinity/);
}

function testLeveragePointsFittedBandAndNullSeries(): void {
  const option = buildFitModelLeverageOption({
    title: "Leverage Plot",
    responseName: "Y",
    plot: {
      termId: "interaction:A*B",
      termLabel: "A*B",
      pValue: 0.001,
      points: [
        { rowIndex: 1, effectLeverage: -1, adjustedResponse: 8 },
        { rowIndex: 2, effectLeverage: 1, adjustedResponse: 12 },
      ],
      confidenceBand: [
        { effectLeverage: -1, fitted: 9, lower: 8.5, upper: 9.5 },
        { effectLeverage: 1, fitted: 11, lower: 10.5, upper: 11.5 },
      ],
      nullLineY: 10,
      rowsSampled: false,
      sourceRowCount: 2,
      reason: null,
    },
    labels: {
      leverageAxisName: "Effect leverage",
      adjustedResponseAxisName: "Adjusted Y",
      pointSeriesName: "Observed",
      fittedSeriesName: "Fitted",
      confidenceSeriesName: "Confidence band",
      nullSeriesName: "Null effect",
      pValueLabel: "Prob > F",
      tooltipXLabel: "Effect leverage",
      tooltipYLabel: "Adjusted Y",
    },
  }) as {
    title?: { subtext?: string };
    xAxis: { min: number; max: number; interval: number };
    yAxis: { min: number; max: number; interval: number };
    series: Array<{
      name?: string;
      type?: string;
      clip?: boolean;
      data?: Array<[number, number]>;
      renderItem?: (
        params: { dataIndex?: number },
        api: { coord: (point: [number, number]) => [number, number] },
      ) => { type: string; shape: { points: Array<[number, number]> } } | null;
    }>;
  };

  assert.match(option.title?.subtext ?? "", /0\.001/);
  assert.deepEqual(option.series.find((series) => series.name === "Observed")?.data, [[-1, 8], [1, 12]]);
  assert.deepEqual(option.series.find((series) => series.name === "Fitted")?.data, [[-1, 9], [1, 11]]);
  const confidenceSeries = option.series.find((series) => series.type === "custom");
  assert.ok(confidenceSeries?.renderItem);
  const confidenceShape = confidenceSeries.renderItem(
    { dataIndex: 0 },
    { coord: (point) => point },
  );
  assert.equal(confidenceShape?.type, "polygon");
  assert.deepEqual(confidenceShape?.shape.points, [
    [-1, 8.5],
    [1, 10.5],
    [1, 11.5],
    [-1, 9.5],
  ]);
  assert.deepEqual(
    option.series.find((series) => series.name === "Null effect")?.data,
    [[option.xAxis.min, 10], [option.xAxis.max, 10]],
  );
  assert.ok(option.xAxis.min < -1);
  assert.ok(option.xAxis.max > 1);
  assert.ok(option.xAxis.min > -2);
  assert.ok(option.xAxis.max < 2);
  assert.ok(option.yAxis.min < 8);
  assert.ok(option.yAxis.max > 12);
  assert.ok(option.yAxis.min > 6);
  assert.ok(option.yAxis.max < 14);
  assert.ok(option.xAxis.interval > 0);
  assert.ok(option.yAxis.interval > 0);
  assert.ok(option.series.every((series) => series.clip === true));
  assert.doesNotMatch(JSON.stringify(option), /NaN|Infinity/);
}

function testActualByPredictedWholeModelConfidenceBand(): void {
  const input = {
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: [
      { rowIndex: 1, observed: 8, fitted: 9, residual: -1 },
      { rowIndex: 2, observed: 12, fitted: 11, residual: 1 },
    ],
    actualByPredictedConfidenceBand: [
      { predicted: 9, fitted: 9, lower: 6, upper: 9.5 },
      { predicted: 11, fitted: 11, lower: 10.25, upper: 14 },
    ],
    confidenceRows: [
      { rowIndex: 1, fitted: 9, meanConfidenceLower: 7, meanConfidenceUpper: 12 },
    ],
  };
  const option = buildActualByPredictedOption(input) as {
    yAxis: { min: number; max: number };
    series: Array<{
      name?: string;
      type?: string;
      silent?: boolean;
      lineStyle?: { color?: string; type?: string };
      data?: Array<[number, number]>;
      renderItem?: (
        params: { dataIndex?: number },
        api: { coord: (point: [number, number]) => [number, number] },
      ) => { type: string; shape: { points: Array<[number, number]> } } | null;
    }>;
  };

  const confidenceSeries = option.series.find((series) => series.type === "custom");
  assert.ok(confidenceSeries?.renderItem);
  const confidenceShape = confidenceSeries.renderItem(
    { dataIndex: 0 },
    { coord: (point) => point },
  );
  assert.equal(confidenceShape?.type, "polygon");
  assert.deepEqual(confidenceShape?.shape.points, [
    [9, 6],
    [11, 10.25],
    [11, 14],
    [9, 9.5],
  ]);
  assert.equal(confidenceSeries.silent, true);
  assert.ok(option.yAxis.min < 6);
  assert.ok(option.yAxis.max > 14);
  const identity = option.series.find((series) => series.type === "line" && !series.stack);
  assert.equal(identity?.lineStyle?.color, "#d92d20");
  assert.equal(identity?.lineStyle?.type, "solid");
}

function testActualByPredictedRejectsInvalidWholeModelBandWidths(): void {
  const build = (lower: number, upper: number) => buildActualByPredictedOption({
    title: "Actual by Predicted",
    labels: SAMPLE_LABELS,
    plotRows: [{ rowIndex: 1, observed: 8, fitted: 9, residual: -1 }],
    actualByPredictedConfidenceBand: [
      { predicted: 9, fitted: 9, lower, upper },
    ],
  });

  assert.throws(() => build(9.5, 8.5), /confidenceWidth/);
  assert.throws(() => build(8.5, Number.POSITIVE_INFINITY), /upper/);
}

function testChartLayoutContainsAxisText(): void {
  const rows: FitModelPlotRow[] = [
    { rowIndex: 0, observed: 2, fitted: 1.5, residual: 0.5 },
    { rowIndex: 1, observed: 4, fitted: 4.5, residual: -0.5 },
  ];
  const options = [
    buildActualByPredictedOption({ title: "Actual by Predicted", labels: SAMPLE_LABELS, plotRows: rows }),
    buildResidualByPredictedOption({
      title: "Residual by Predicted",
      labels: { ...SAMPLE_LABELS, tooltipYLabel: "Residual" },
      plotRows: rows,
    }),
    buildResidualQqOption({
      title: "Residual Q-Q",
      rows: [
        { rowIndex: 1, theoreticalQuantile: -0.67, studentizedResidual: -0.5 },
        { rowIndex: 2, theoreticalQuantile: 0.67, studentizedResidual: 0.8 },
      ],
      labels: {
        theoreticalAxisName: "Theoretical quantile",
        studentizedResidualAxisName: "Studentized residual",
        residualSeriesName: "Residual",
        referenceSeriesName: "Reference",
        tooltipXLabel: "Theoretical quantile",
        tooltipYLabel: "Studentized residual",
      },
    }),
  ] as Array<{
    grid?: { containLabel?: boolean };
    xAxis?: { nameLocation?: string; nameGap?: number };
    yAxis?: { nameLocation?: string; nameGap?: number };
  }>;

  for (const option of options) {
    assert.equal(option.grid?.containLabel, true);
    assert.equal(option.xAxis?.nameLocation, "middle");
    assert.equal(option.yAxis?.nameLocation, "middle");
    assert.ok((option.xAxis?.nameGap ?? 0) >= 28);
    assert.ok((option.yAxis?.nameGap ?? 0) >= 36);
  }
}

testActualAndResidualPointsAndAxes();
testDiagnosticAxesUsePaddedNiceExtents();
testActualAxesUseIndependentObservedAndFittedExtents();
testActualPredictedAxisIncludesConfidenceCoordinates();
testReferenceLinesFiniteAndCorrect();
testTooltipValuesAreFinite();
testEmptyInputProducesNonblankOption();
testSampledSubtitlePreservesPoints();
testNonFiniteBoundaryValuesThrow();
testSinglePointReferenceLinesUseExpandedFiniteExtent();
testResidualQqPointsAndReferenceLine();
testResidualQqBoundaryInputs();
testPredictionProfilerCurveAndConfidenceBand();
testLeveragePointsFittedBandAndNullSeries();
testActualByPredictedWholeModelConfidenceBand();
testActualByPredictedRejectsInvalidWholeModelBandWidths();
testEffectSummaryHorizontalBarsAndSignificanceReference();
testChartLayoutContainsAxisText();

console.log("fitModel graph adapter contract passed");
