import assert from "node:assert/strict";

import {
  buildActualByPredictedOption,
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
  assert.deepEqual(zero.data, [[1.5, 0], [4.5, 0]]);
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
    xAxis: { name: string };
    yAxis: { name: string };
    series: Array<{ name?: string; type?: string; clip?: boolean; data?: Array<[number, number]>; markLine?: unknown; markPoint?: unknown }>;
  };

  assert.equal(option.xAxis.name, "A");
  assert.equal(option.yAxis.name, "Y");
  assert.deepEqual(option.series.find((series) => series.name === "Predicted")?.data, [[0, 1], [2, 3], [4, 5]]);
  assert.equal(option.series.filter((series) => series.name === "Mean CI").length, 2);
  assert.ok(option.series.every((series) => series.type === "line" && series.clip === true));
  assert.ok(option.series.some((series) => series.markLine && series.markPoint));
  assert.doesNotMatch(JSON.stringify(option), /NaN|Infinity/);
}

testActualAndResidualPointsAndAxes();
testReferenceLinesFiniteAndCorrect();
testTooltipValuesAreFinite();
testEmptyInputProducesNonblankOption();
testSampledSubtitlePreservesPoints();
testNonFiniteBoundaryValuesThrow();
testSinglePointReferenceLinesUseExpandedFiniteExtent();
testResidualQqPointsAndReferenceLine();
testResidualQqBoundaryInputs();
testPredictionProfilerCurveAndConfidenceBand();

console.log("fitModel graph adapter contract passed");
