import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createHypothesisTestAnalysisDocument } from "../src/components/analysis/adapters/hypothesisTestAnalysisAdapter.ts";
import { resolveReportDependency } from "../src/components/report/ReportEmbed.tsx";
import { formatReportEmbed, parseReportMarkdown } from "../src/utils/reportParser.ts";

const document = createHypothesisTestAnalysisDocument({
  id: "hypothesis-1",
  name: "Hypothesis Test 1",
  sourceDatasetId: "dataset-1",
  createdAt: "2026-09-08T00:00:00.000Z",
  definition: {
    kind: "hypothesisTest",
    roles: {
      layout: "wide",
      measurements: [
        { name: "Before", type: "continuous" },
        { name: "After", type: "continuous" },
      ],
      subject: null,
    },
    studyDesign: "pairedOrBlocked",
    selectionMode: "automatic",
    manualSelection: null,
    alternative: "twoSided",
    alpha: 0.05,
    confidenceLevel: 0.95,
    levelOrder: ["Before", "After"],
    referenceLevel: "Before",
    postHoc: "automatic",
    selectorVersion: "1",
  },
});
const dataset = {
  id: "dataset-1",
  name: "Study",
  sourcePath: null,
  sourceType: "manual" as const,
  rowCount: 12,
  colCount: 2,
  generation: 1,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const dependency = { kind: "hypothesisTest" as const, documentId: document.id };

assert.equal(resolveReportDependency(dependency, { analyses: [document], datasets: [dataset] }).status, "resolved");
assert.equal(resolveReportDependency(dependency, {
  analyses: [{ ...document, analysisKind: "fitYByX" } as never],
  datasets: [dataset],
}).status, "missing");
assert.equal(resolveReportDependency(dependency, { analyses: [document], datasets: [] }).status, "missing");

const source = formatReportEmbed(dependency);
assert.equal(source, '{{sp-embed kind="hypothesisTest" id="hypothesis-1"}}');
assert.deepEqual(parseReportMarkdown(source), [{ type: "embed", dependency }]);

const embedSource = readFileSync(resolve(process.cwd(), "src/components/report/HypothesisTestAnalysisReportEmbed.tsx"), "utf8");
assert.equal(embedSource.includes("HypothesisTestAnalysisReport"), true);