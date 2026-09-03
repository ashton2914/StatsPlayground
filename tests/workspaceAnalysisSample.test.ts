import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source boundary: ${start}`);
  assert.notEqual(endIndex, -1, `missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

const workspace = readSource("src/components/Workspace.tsx");
const handler = sourceBetween(
  workspace,
  "const handleCreateAnalysisSample",
  "const handleCreateDistribution",
);

for (const required of [
  "createAnalysisSample(",
  "dataService.createTableFromRows({",
  "columnNames: [ANALYSIS_SAMPLE_COLUMN]",
  'columnTypes: ["DOUBLE"]',
  "createAnalysisSampleGraph({",
  "createAnalysisSampleReport({",
  "addGraphBuilder(graph)",
  "addReport(report)",
  "await refreshDatasets()",
  "dataService.deleteDataset(createdDatasetId)",
  "setActiveReportId(report.id)",
  "markDirty()",
  "history.analysisSample",
]) {
  assert.equal(handler.includes(required), true, `sample handler must include ${required}`);
}

assert.match(workspace, /menu\.analysisSample/);
assert.match(workspace, /onClick=\{readOnly \? undefined : handleCreateAnalysisSample\}/);
assert.ok(
  handler.indexOf("await refreshDatasets()") < handler.indexOf("addGraphBuilder(graph)"),
  "backend table registration must succeed before frontend documents are added",
);

const reportCss = readSource("src/components/report/report.css");
assert.match(
  reportCss,
  /\.sp-report-markdown-flow h1,[\s\S]*background:\s*var\(--bg-header\)/,
  "analysis headings must render as the standard frame title bars",
);

for (const locale of ["en", "vi", "zh-CN", "zh-TW"]) {
  const messages = JSON.parse(readSource(`src/i18n/locales/${locale}.json`)) as {
    menu?: Record<string, unknown>;
    history?: Record<string, unknown>;
    analysisSample?: { report?: Record<string, unknown> };
  };
  assert.equal(typeof messages.menu?.analysisSample, "string", `${locale} must localize menu.analysisSample`);
  assert.equal(typeof messages.history?.analysisSample, "string", `${locale} must localize history.analysisSample`);
  for (const key of ["description", "quantiles", "summaryStatistics", "probability", "quantile", "value", "statistic"]) {
    assert.equal(typeof messages.analysisSample?.report?.[key], "string", `${locale} must localize analysisSample.report.${key}`);
  }
}

console.log("Workspace analysis sample integration contract passed");