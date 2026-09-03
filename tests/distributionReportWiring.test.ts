import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reportSource = readFileSync(
  new URL("../src/components/distribution/DistributionReport.tsx", import.meta.url),
  "utf8",
);
const capabilitySource = readFileSync(
  new URL("../src/components/distribution/ProcessCapabilityReport.tsx", import.meta.url),
  "utf8",
);
const continuousFitSource = readFileSync(
  new URL("../src/components/distribution/ContinuousFitReport.tsx", import.meta.url),
  "utf8",
);
const viewSource = readFileSync(
  new URL("../src/components/distribution/DistributionView.tsx", import.meta.url),
  "utf8",
);
const presentationSource = readFileSync(
  new URL("../src/components/distribution/distributionPresentation.tsx", import.meta.url),
  "utf8",
);

const assertTablesUseFitYByXStyle = (source: string): void => {
  const tableTags = source.match(/<table(?:\s[^>]*)?>/g) ?? [];
  assert.ok(tableTags.length > 0);
  tableTags.forEach((tableTag) => {
    assert.match(tableTag, /className="[^"]*sp-fit-y-by-x-report-table[^"]*"/);
  });
};

assert.match(reportSource, /DistributionGroupResult/);
assert.match(reportSource, /DistributionReportBlock/);
assert.match(reportSource, /<details/);
assert.match(reportSource, /SummaryDataTables/);
assert.match(reportSource, /ContinuousFitComparisonReport/);
assert.match(reportSource, /ProcessCapabilityReport/);
assertTablesUseFitYByXStyle(reportSource);
assertTablesUseFitYByXStyle(continuousFitSource);
assertTablesUseFitYByXStyle(capabilitySource);
assert.doesNotMatch(reportSource, /DistributionChart|GraphRuntime|useDistributionReport|useDistributionStore/);
assert.doesNotMatch(capabilitySource, /DistributionChart|ProcessCapabilityChart|echarts/);

assert.match(viewSource, /useDistributionReport/);
assert.match(viewSource, /DistributionReportPanel/);
assert.match(viewSource, /DistributionGraphGrid/);
assert.match(presentationSource, /<DistributionReport/);
assert.match(presentationSource, /reportState\.status === "error"/);
assert.match(presentationSource, /externalDataState:\s*mapDistributionExternalDataState\(reportState, role\)/);
assert.match(presentationSource, /renderGraph \? renderGraph\(graphProps\) : <GraphRuntime \{\.\.\.graphProps\} \/>/);

console.log("distribution report wiring OK");
