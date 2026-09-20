import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const LOCALES = ["en", "zh-CN", "zh-TW", "vi"] as const;
const REQUIRED_VISIBLE_KEYS = [
  "fitModel.report.add",
  "fitModel.report.chart.axis.adjustedResponse",
  "fitModel.report.chart.axis.effect",
  "fitModel.report.chart.axis.effectLeverage",
  "fitModel.report.chart.axis.logWorth",
  "fitModel.report.chart.reference.nullEffect",
  "fitModel.report.chart.reference.significance",
  "fitModel.report.chart.series.confidence",
  "fitModel.report.chart.series.fitted",
  "fitModel.report.chart.series.leveragePoints",
  "fitModel.report.chart.series.logWorth",
  "fitModel.report.chart.tooltip.adjustedResponse",
  "fitModel.report.chart.tooltip.effect",
  "fitModel.report.chart.tooltip.effectLeverage",
  "fitModel.report.chart.tooltip.logWorth",
  "fitModel.report.column.metric",
  "fitModel.report.column.numberOfParameters",
  "fitModel.report.column.probabilityGreaterThanF",
  "fitModel.report.column.property",
  "fitModel.report.column.value",
  "fitModel.report.effect",
  "fitModel.report.effects",
  "fitModel.report.leverageUnavailable",
  "fitModel.report.profiler.notEstimable",
  "fitModel.report.reason.auxiliaryRankDeficient",
  "fitModel.report.reason.constantFeature",
  "fitModel.report.reason.inferenceNotEstimable",
  "fitModel.report.reason.insufficientDiagnosticRows",
  "fitModel.report.reason.lackOfFitDegreesOfFreedomZero",
  "fitModel.report.reason.noReplicates",
  "fitModel.report.reason.pureErrorZero",
  "fitModel.report.rows",
  "fitModel.report.section.effectTests",
  "fitModel.report.section.leveragePlot",
  "fitModel.report.summaryOfFit.meanOfResponse",
  "fitModel.report.summaryOfFit.observations",
] as const;

function collectLeafValues(
  value: unknown,
  prefix = "fitModel",
  leaves = new Map<string, string>(),
): Map<string, string> {
  if (typeof value === "string") {
    leaves.set(prefix, value);
    return leaves;
  }

  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${prefix} must be an object or string`);
  for (const [key, child] of Object.entries(value)) {
    collectLeafValues(child, `${prefix}.${key}`, leaves);
  }
  return leaves;
}

const localeLeaves = LOCALES.map((locale) => {
  const filePath = path.resolve(process.cwd(), `src/i18n/locales/${locale}.json`);
  const document = JSON.parse(readFileSync(filePath, "utf8")) as { fitModel?: unknown };
  assert.ok(document.fitModel, `${locale} must define the fitModel namespace`);
  return [locale, collectLeafValues(document.fitModel)] as const;
});

const [referenceLocale, referenceLeaves] = localeLeaves[0];
const referenceKeys = [...referenceLeaves.keys()].sort();
for (const [locale, leaves] of localeLeaves) {
  assert.deepEqual([...leaves.keys()].sort(), referenceKeys, `${locale} fitModel keys must match ${referenceLocale}`);
  for (const key of REQUIRED_VISIBLE_KEYS) {
    assert.ok(leaves.has(key), `${locale} must define visible Fit Model key ${key}`);
  }
  for (const [key, value] of leaves) {
    assert.ok(value.trim().length > 0, `${locale}:${key} must be a non-empty string`);
  }
}

console.log(`fitModel locale parity passed (${referenceKeys.length} keys across ${LOCALES.length} locales)`);