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
const analysisResultsSource = readFileSync(
  new URL("../src/components/analysis/renderers/DistributionAnalysisResults.tsx", import.meta.url),
  "utf8",
);
const analysisTreeSource = readFileSync(
  new URL("../src/components/analysis/renderers/DistributionAnalysisReportTree.tsx", import.meta.url),
  "utf8",
);

assert.match(reportSource, /DistributionGroupResult/);
assert.match(reportSource, /DistributionReportBlock/);
assert.match(reportSource, /DistributionYResultV1/);
assert.match(reportSource, /AnalysisFrame/);
assert.match(reportSource, /AnalysisTable/);
assert.match(reportSource, /AnalysisStack/);
assert.match(reportSource, /AnalysisText/);
assert.match(reportSource, /SummaryDataTables/);
assert.match(reportSource, /DistributionResponseReport/);
assert.match(reportSource, /ContinuousFitComparisonReport/);
assert.match(reportSource, /ProcessCapabilityReport/);
assert.doesNotMatch(reportSource, /<table|<caption|<details|reportTable\.css/);
assert.match(continuousFitSource, /AnalysisTable/);
assert.match(continuousFitSource, /AnalysisStack/);
assert.match(continuousFitSource, /AnalysisText/);
assert.doesNotMatch(continuousFitSource, /<table|<caption|<details|sp-fit-y-by-x-report-table/);
assert.match(capabilitySource, /AnalysisTable/);
assert.match(capabilitySource, /AnalysisStack/);
assert.match(capabilitySource, /AnalysisText/);
assert.doesNotMatch(capabilitySource, /<table|<caption/);
assert.doesNotMatch(reportSource, /DistributionChart|GraphRuntime|useDistributionReport|useDistributionStore/);
assert.doesNotMatch(capabilitySource, /DistributionChart|ProcessCapabilityChart|echarts/);

assert.match(viewSource, /useDistributionReport/);
assert.match(viewSource, /DistributionReportPanel/);
assert.match(viewSource, /DistributionGraphGrid/);
assert.match(viewSource, /AnalysisFrame/);
assert.match(viewSource, /AnalysisText/);
assert.match(presentationSource, /<DistributionReport/);
assert.match(presentationSource, /reportState\.status === "error"/);
assert.match(presentationSource, /AnalysisFrame/);
assert.match(presentationSource, /AnalysisText/);
assert.doesNotMatch(presentationSource, /distribution-report-status/);
assert.match(presentationSource, /externalDataState:\s*mapDistributionExternalDataState\(reportState, role\)/);
assert.match(presentationSource, /renderGraph \? renderGraph\(graphProps\) : <GraphRuntime \{\.\.\.graphProps\} \/>/);
assert.match(analysisTreeSource, /DistributionAnalysisReportTree/);
assert.match(analysisTreeSource, /DistributionResponseReport/);
assert.match(analysisTreeSource, /AnalysisFrame/);
assert.match(analysisTreeSource, /AnalysisGraph/);
assert.match(analysisTreeSource, /AnalysisStack/);
assert.match(analysisTreeSource, /AnalysisText/);
assert.match(analysisTreeSource, /createDistributionGraphBuilderConfig/);
assert.match(analysisTreeSource, /getDistributionResponseCompositeGraphFrame/);
assert.doesNotMatch(analysisTreeSource, /<table|<caption|<details|useDistributionReport|useDistributionStore|DistributionView/);
assert.doesNotMatch(analysisTreeSource, /Math\.(mean|median|round|sqrt)|simple-statistics|jstat/);
assert.match(analysisResultsSource, /DistributionAnalysisReportTree/);
assert.doesNotMatch(analysisResultsSource, /AnalysisTextBlock/);
assert.doesNotMatch(analysisResultsSource, /DistributionReport\s*\{/);
assert.match(analysisResultsSource, /function AnalysisUnavailable[\s\S]*return <AnalysisText/);

console.log("distribution report wiring OK");
