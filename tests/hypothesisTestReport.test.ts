import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { formatHypothesisTestValue } from "../src/components/analysis/renderers/hypothesisTestAnalysisModel.ts";

assert.equal(formatHypothesisTestValue({ state: "available", value: 0 }), "0");
assert.equal(
  formatHypothesisTestValue({ state: "unavailable", reason: "NO_INTERVAL" }),
  "Unavailable: NO_INTERVAL",
);

const reportSource = readFileSync(resolve(process.cwd(), "src/components/analysis/renderers/HypothesisTestAnalysisReport.tsx"), "utf8");
for (const primitive of ["AnalysisFrame", "AnalysisGraph", "AnalysisStack", "AnalysisTable", "AnalysisText"]) {
  assert.equal(reportSource.includes(primitive), true, `report must compose ${primitive}`);
}
assert.equal(reportSource.includes("<table"), false, "report must not render raw result tables");
assert.equal(reportSource.includes("<button"), false, "report must not render raw actions");
assert.equal(/legacy|LegacyReport/.test(reportSource), false, "report must not wrap a legacy report");
assert.equal(reportSource.includes('t("hypothesisTest.graph.dataAndEstimates"'), true, "graph titles must be localized");

const graphLocaleKeys = [
  "dataAndEstimates",
  "diagnosticValues",
  "normalQq",
  "distribution",
  "observations",
  "meanInterval",
  "subjectProfile",
  "responseAxis",
  "observationOrderAxis",
  "groupResiduals",
  "pairedDifferences",
  "additiveResiduals",
  "theoreticalQuantileAxis",
  "observedDiagnosticAxis",
  "reference",
] as const;
for (const locale of ["en", "zh-CN", "zh-TW", "vi"]) {
  const messages = JSON.parse(readFileSync(resolve(process.cwd(), `src/i18n/locales/${locale}.json`), "utf8"));
  for (const key of graphLocaleKeys) {
    assert.equal(typeof messages.hypothesisTest.graph[key], "string", `${locale} is missing hypothesisTest.graph.${key}`);
  }
}

const resultsSource = readFileSync(resolve(process.cwd(), "src/components/analysis/renderers/HypothesisTestAnalysisResults.tsx"), "utf8");
assert.equal(resultsSource.includes("HypothesisTestAnalysisReport"), true);
assert.equal(resultsSource.includes('data-analysis-kind="hypothesisTest"'), true);