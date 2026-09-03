import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
} from "../graphBuilder/graphBuilderMode";
import type { ReportItem } from "../../types/report";
import type { GraphBuilderItem } from "../../types/graphBuilder";

const SAMPLE_COLUMN = "DIM1";
const NORMAL_MEAN = 100;
const NORMAL_SIGMA = 15;

export interface AnalysisSampleQuantile {
  probability: number;
  label: string;
  value: number;
}

export interface AnalysisSampleSummary {
  count: number;
  mean: number;
  stdDev: number;
  stdError: number;
  minimum: number;
  maximum: number;
  range: number;
  median: number;
  interquartileRange: number;
}

export interface AnalysisSample {
  values: number[];
  rows: number[][];
  quantiles: AnalysisSampleQuantile[];
  summary: AnalysisSampleSummary;
}

export interface AnalysisSampleReportLabels {
  description: string;
  quantiles: string;
  summaryStatistics: string;
  probability: string;
  quantile: string;
  value: string;
  statistic: string;
  minimum: string;
  maximum: string;
  median: string;
  count: string;
  mean: string;
  stdDev: string;
  stdError: string;
  range: string;
  interquartileRange: string;
}

const DEFAULT_REPORT_LABELS: AnalysisSampleReportLabels = {
  description: "This sample demonstrates the standard analysis layout.",
  quantiles: "Quantiles",
  summaryStatistics: "Summary Statistics",
  probability: "Probability",
  quantile: "Quantile",
  value: "Value",
  statistic: "Statistic",
  minimum: "Minimum",
  maximum: "Maximum",
  median: "Median",
  count: "N",
  mean: "Mean",
  stdDev: "Std Dev",
  stdError: "Std Error Mean",
  range: "Range",
  interquartileRange: "Interquartile Range",
};

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const fraction = position - lowerIndex;
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[Math.min(lowerIndex + 1, sorted.length - 1)] ?? lower;
  return lower + fraction * (upper - lower);
}

export function createAnalysisSample(seed = 112, sampleSize = 200): AnalysisSample {
  if (!Number.isInteger(sampleSize) || sampleSize < 2) {
    throw new RangeError("sampleSize must be an integer of at least 2");
  }

  const random = createRandom(seed);
  const values: number[] = [];
  while (values.length < sampleSize) {
    const first = Math.max(random(), Number.EPSILON);
    const second = random();
    const radius = Math.sqrt(-2 * Math.log(first));
    const angle = 2 * Math.PI * second;
    values.push(NORMAL_MEAN + NORMAL_SIGMA * radius * Math.cos(angle));
    if (values.length < sampleSize) {
      values.push(NORMAL_MEAN + NORMAL_SIGMA * radius * Math.sin(angle));
    }
  }

  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  const quantileDefinitions: Array<[number, string]> = [
    [0, "Minimum"],
    [0.01, "1%"],
    [0.05, "5%"],
    [0.1, "10%"],
    [0.25, "Q1"],
    [0.5, "Median"],
    [0.75, "Q3"],
    [0.9, "90%"],
    [0.95, "95%"],
    [0.99, "99%"],
    [1, "Maximum"],
  ];
  const quantiles = quantileDefinitions.map(([probability, label]) => ({
    probability,
    label,
    value: quantile(sorted, probability),
  }));
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];
  const firstQuartile = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const thirdQuartile = quantile(sorted, 0.75);

  return {
    values,
    rows: values.map((value) => [value]),
    quantiles,
    summary: {
      count: values.length,
      mean,
      stdDev,
      stdError: stdDev / Math.sqrt(values.length),
      minimum,
      maximum,
      range: maximum - minimum,
      median,
      interquartileRange: thirdQuartile - firstQuartile,
    },
  };
}

export function createAnalysisSampleGraph(input: {
  datasetId: string;
  graphId: string;
  graphName: string;
  createdAt: string;
}): GraphBuilderItem {
  const twoD = createDefaultGraph2DState();
  return {
    id: input.graphId,
    name: input.graphName,
    sourceDatasetId: input.datasetId,
    mode: "2d",
    modeStates: {
      twoD: {
        ...twoD,
        encoding: { x: { name: SAMPLE_COLUMN, type: "continuous" } },
        elements: [
          { kind: "histogram", enabled: true },
          { kind: "normalCurve", enabled: true, options: { showSigmaBands: false } },
          { kind: "boxplot", enabled: true },
        ],
      },
      threeD: createDefaultGraph3DState(),
      multivariate: createDefaultMultivariateGraphState(),
    },
    sampling: { mode: "full" },
    createdAt: input.createdAt,
  };
}

function formatValue(value: number): string {
  return Number.parseFloat(value.toFixed(6)).toString();
}

export function createAnalysisSampleReport(input: {
  reportId: string;
  reportName: string;
  graphId: string;
  sample: AnalysisSample;
  createdAt: string;
  labels?: Partial<AnalysisSampleReportLabels>;
}): ReportItem {
  const labels = { ...DEFAULT_REPORT_LABELS, ...input.labels };
  const quantileLabel = (label: string) => {
    if (label === "Minimum") return labels.minimum;
    if (label === "Maximum") return labels.maximum;
    if (label === "Median") return labels.median;
    return label;
  };
  const quantileRows = input.sample.quantiles
    .map((entry) => `| ${formatValue(entry.probability * 100)}% | ${quantileLabel(entry.label)} | ${formatValue(entry.value)} |`)
    .join("\n");
  const summaryRows: Array<[string, number]> = [
    [labels.count, input.sample.summary.count],
    [labels.mean, input.sample.summary.mean],
    [labels.stdDev, input.sample.summary.stdDev],
    [labels.stdError, input.sample.summary.stdError],
    [labels.minimum, input.sample.summary.minimum],
    [labels.maximum, input.sample.summary.maximum],
    [labels.range, input.sample.summary.range],
    [labels.median, input.sample.summary.median],
    [labels.interquartileRange, input.sample.summary.interquartileRange],
  ];
  const summaryTableRows = summaryRows
    .map(([label, value]) => `| ${label} | ${formatValue(value)} |`)
    .join("\n");

  const markdown = [
    "# DIM1",
    "",
    `{{sp-embed kind="graph" id="${input.graphId}"}}`,
    "",
    labels.description,
    "",
    `## ${labels.quantiles}`,
    "",
    `| ${labels.probability} | ${labels.quantile} | ${labels.value} |`,
    "| ---: | :--- | ---: |",
    quantileRows,
    "",
    `## ${labels.summaryStatistics}`,
    "",
    `| ${labels.statistic} | ${labels.value} |`,
    "| :--- | ---: |",
    summaryTableRows,
  ].join("\n");

  return {
    schemaVersion: 1,
    id: input.reportId,
    name: input.reportName,
    markdown,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export const ANALYSIS_SAMPLE_COLUMN = SAMPLE_COLUMN;