import assert from "node:assert/strict";

import {
  createAnalysisSample,
  createAnalysisSampleGraph,
  createAnalysisSampleReport,
} from "../src/components/analysis/analysisSample.ts";
import {
  canExecuteGraphRequest,
  deriveGraphRequestParts,
} from "../src/components/graphBuilder/useGraphDataPipeline.ts";

const first = createAnalysisSample(112, 200);
const repeated = createAnalysisSample(112, 200);
const different = createAnalysisSample(113, 200);

assert.deepEqual(first, repeated, "the bundled sample must be reproducible for a saved analysis");
assert.notDeepEqual(first.values, different.values, "different seeds must produce different random samples");
assert.equal(first.values.length, 200);
assert.equal(first.values.every(Number.isFinite), true);
assert.equal(first.rows.length, 200);
assert.equal(first.rows.every((row) => row.length === 1 && row[0] === first.values[first.rows.indexOf(row)]), true);
assert.ok(first.summary.mean > 90 && first.summary.mean < 110, "sample mean should remain near the configured normal mean");
assert.ok(first.summary.stdDev > 10 && first.summary.stdDev < 20, "sample deviation should remain near the configured normal sigma");
assert.equal(first.quantiles[0]?.label, "Minimum");
assert.equal(first.quantiles.at(-1)?.label, "Maximum");

const graph = createAnalysisSampleGraph({
  datasetId: "dataset-112",
  graphId: "graph-112",
  graphName: "DIM1 Distribution",
  createdAt: "2026-09-03T00:00:00.000Z",
});

assert.equal(graph.sourceDatasetId, "dataset-112");
assert.deepEqual(graph.modeStates.twoD.encoding, {
  x: { name: "DIM1", type: "continuous" },
});
assert.deepEqual(
  graph.modeStates.twoD.elements.map((element) => element.kind),
  ["histogram", "normalCurve", "boxplot"],
  "the sample graph must exercise all requested Graph Builder layers",
);
const request = deriveGraphRequestParts(graph);
assert.deepEqual(request.elements.map((element) => element.kind), ["histogram", "normalCurve", "boxplot"]);
assert.equal(
  canExecuteGraphRequest(graph, request.fields, request.elements),
  true,
  "the one-column distribution graph must produce an executable graph request",
);

const report = createAnalysisSampleReport({
  reportId: "report-112",
  reportName: "DIM1 Analysis",
  graphId: graph.id,
  sample: first,
  createdAt: "2026-09-03T00:00:00.000Z",
});

assert.equal(report.markdown.startsWith("# DIM1\n"), true);
const expectedOrder = [
  '{{sp-embed kind="graph" id="graph-112"}}',
  "This sample demonstrates the standard analysis layout.",
  "## Quantiles",
  "## Summary Statistics",
];
let offset = 0;
for (const fragment of expectedOrder) {
  const index = report.markdown.indexOf(fragment, offset);
  assert.notEqual(index, -1, `missing or out-of-order report fragment: ${fragment}`);
  offset = index + fragment.length;
}
assert.match(report.markdown, /\| Probability \| Quantile \| Value \|/);
assert.match(report.markdown, /\| Statistic \| Value \|/);

const localizedReport = createAnalysisSampleReport({
  reportId: "report-zh",
  reportName: "DIM1 分析",
  graphId: graph.id,
  sample: first,
  createdAt: "2026-09-03T00:00:00.000Z",
  labels: {
    description: "此示例展示统一的分析排版。",
    quantiles: "分位数",
    summaryStatistics: "汇总统计",
    probability: "概率",
    quantile: "分位数",
    value: "值",
    statistic: "统计量",
  },
});
assert.match(localizedReport.markdown, /此示例展示统一的分析排版。/);
assert.match(localizedReport.markdown, /## 分位数/);
assert.match(localizedReport.markdown, /## 汇总统计/);
assert.match(localizedReport.markdown, /\| 概率 \| 分位数 \| 值 \|/);

console.log("Analysis sample contract tests passed");