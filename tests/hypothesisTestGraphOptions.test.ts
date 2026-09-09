import assert from "node:assert/strict";

import {
  buildHypothesisTestDiagnosticOption,
  buildHypothesisTestMainOption,
  buildHypothesisTestQqOption,
} from "../src/components/analysis/renderers/hypothesisTestGraphOptions.ts";
import type { HypothesisTestPlotData } from "../src/types/hypothesisTest.ts";

const independent: HypothesisTestPlotData = {
  studyStructure: "independent",
  conditions: ["Control", "Treatment"],
  observations: [
    { condition: "Control", value: 1, subject: null },
    { condition: "Control", value: 2, subject: null },
    { condition: "Treatment", value: 3, subject: null },
    { condition: "Treatment", value: 4, subject: null },
  ],
  summaries: [
    { condition: "Control", count: 2, mean: 1.5, median: 1.5, lowerQuartile: 1.25, upperQuartile: 1.75, minimum: 1, maximum: 2, meanIntervalLower: { state: "available", value: 0.5 }, meanIntervalUpper: { state: "available", value: 2.5 } },
    { condition: "Treatment", count: 2, mean: 3.5, median: 3.5, lowerQuartile: 3.25, upperQuartile: 3.75, minimum: 3, maximum: 4, meanIntervalLower: { state: "available", value: 2.5 }, meanIntervalUpper: { state: "available", value: 4.5 } },
  ],
  diagnosticKind: "groupResiduals",
  diagnosticValues: [-0.5, 0.5, -0.5, 0.5],
  qqPoints: [
    { theoretical: -1, observed: -0.5 },
    { theoretical: -0.25, observed: -0.5 },
    { theoretical: 0.25, observed: 0.5 },
    { theoretical: 1, observed: 0.5 },
  ],
};

const independentOption = buildHypothesisTestMainOption(independent, {
  showRawData: true,
  showIntervals: true,
});
const independentSeries = independentOption.series as Array<Record<string, unknown>>;
assert.deepEqual(independentSeries.map((series) => series.name), ["Distribution", "Observations", "Mean interval"]);
assert.deepEqual((independentOption.xAxis as { data: string[] }).data, independent.conditions);
assert.equal((independentSeries[1].data as unknown[]).length, 4);

const paired: HypothesisTestPlotData = {
  ...independent,
  studyStructure: "paired",
  observations: [
    { condition: "Control", value: 1, subject: "S1" },
    { condition: "Treatment", value: 3, subject: "S1" },
    { condition: "Control", value: 2, subject: "S2" },
    { condition: "Treatment", value: 4, subject: "S2" },
  ],
  diagnosticKind: "pairedDifferences",
  diagnosticValues: [-2, -2],
};
const pairedSeries = buildHypothesisTestMainOption(paired, {
  showRawData: true,
  showIntervals: true,
}).series as Array<Record<string, unknown>>;
assert.equal(pairedSeries.filter((series) => series.name === "Subject profile").length, 2);
assert.equal(pairedSeries.at(-1)?.name, "Mean interval");

const qqOption = buildHypothesisTestQqOption(independent);
assert.equal(((qqOption.series as Array<Record<string, unknown>>)[0].data as unknown[]).length, 4);
assert.equal((qqOption.series as Array<Record<string, unknown>>)[1].name, "Reference");

const diagnosticOption = buildHypothesisTestDiagnosticOption(paired);
assert.equal((diagnosticOption.series as Array<Record<string, unknown>>)[0].name, "Paired differences");
assert.equal(((diagnosticOption.series as Array<Record<string, unknown>>)[0].data as unknown[]).length, 2);

console.log("Hypothesis Test graph options passed");