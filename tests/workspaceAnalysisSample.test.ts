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
  "createAnalysisSampleDocument({",
  "addAnalysis(analysis)",
  "await refreshDatasets()",
  "dataService.deleteDataset(createdDatasetId)",
  'activateWorkspaceDocument("analysis", analysis.id)',
  'getAnalysisCreationHistoryKey("sample")',
  "markDirty()",
]) {
  assert.equal(handler.includes(required), true, `sample handler must include ${required}`);
}
for (const forbidden of [
  "createAnalysisSampleDistribution({",
  "addDistribution(distribution)",
  "addGraphBuilder(graph)",
  "addReport(report)",
]) {
  assert.equal(handler.includes(forbidden), false, `sample handler must not include ${forbidden}`);
}

assert.match(workspace, /menu\.analysisSample/);
assert.match(workspace, /onClick=\{readOnly \? undefined : handleCreateAnalysisSample\}/);
assert.ok(
  handler.indexOf("await refreshDatasets()") < handler.indexOf("addAnalysis(analysis)"),
  "backend table registration must succeed before the analysis is added",
);
assert.ok(
  handler.indexOf('activateWorkspaceDocument("analysis", analysis.id)') < handler.indexOf('getAnalysisCreationHistoryKey("sample")'),
  "sample creation must activate the saved Analysis before recording sample history",
);

for (const locale of ["en", "vi", "zh-CN", "zh-TW"]) {
  const messages = JSON.parse(readSource(`src/i18n/locales/${locale}.json`)) as {
    menu?: Record<string, unknown>;
    history?: Record<string, unknown>;
  };
  assert.equal(typeof messages.menu?.analysisSample, "string", `${locale} must localize menu.analysisSample`);
  assert.equal(typeof messages.history?.analysisSample, "string", `${locale} must localize history.analysisSample`);
}

console.log("Workspace analysis sample integration contract passed");