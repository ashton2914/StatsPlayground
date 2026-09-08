import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const TEST_FILE_DIR = resolve(process.cwd(), "tests");

function readSource(relativePath: string): string {
  return readFileSync(resolve(TEST_FILE_DIR, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function readJson(relativePath: string): JsonObject {
  return JSON.parse(readSource(relativePath)) as JsonObject;
}

function getPathValue(root: JsonObject, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, root);
}

function assertSourceIncludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), true, message);
}

function assertSourceExcludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), false, message);
}

const workspaceSource = readSource("../src/components/Workspace.tsx");

for (const obsoletePath of [
  "../src/stores/useFitYByXStore.ts",
  "../src/components/fitYByX/FitYByXView.tsx",
  "../src/components/fitYByX/useFitYByXReport.ts",
  "../src/components/fitYByX/FitYByXReport.tsx",
  "../src/components/report/FitYByXReportEmbed.tsx",
]) {
  assert.equal(existsSync(resolve(TEST_FILE_DIR, obsoletePath)), false, `${obsoletePath} must be removed`);
}

assertSourceIncludes(workspaceSource, "createFitYByXAnalysisDocument", "Workspace must create canonical Fit Y by X Analysis documents");
assertSourceIncludes(workspaceSource, "analysisItems.filter(isFitYByXAnalysisDocument)", "Workspace must derive Fit Y by X rows from the Analysis store");
assertSourceIncludes(workspaceSource, "FitYByXRoleDialog", "Workspace must render the Fit Y by X role dialog");
assertSourceExcludes(workspaceSource, "useFitYByXStore", "Workspace must not consume the legacy Fit Y by X store");
assertSourceExcludes(workspaceSource, "FitYByXView", "Workspace must render Fit Y by X through AnalysisView");

assertSourceIncludes(workspaceSource, "menu.fitYByX", "Analysis menu must include menu.fitYByX");
assertSourceIncludes(workspaceSource, "handleCreateFitYByX", "Fit Y by X menu entry must open the creation flow");

assertSourceIncludes(workspaceSource, "fitYByX: []", "Project save must clear compatibility-only Fit Y by X values");
assertSourceIncludes(workspaceSource, "fitYByXFolders: {}", "Project save must clear compatibility-only Fit Y by X folders");
assertSourceIncludes(workspaceSource, "fitYByX: (result.fitYByX", "Project open must pass legacy Fit Y by X values to Analysis migration");

assertSourceExcludes(workspaceSource, "activeFitYByXId", "Workspace must use only the shared active Analysis id");
assertSourceIncludes(workspaceSource, "showFitYByXDialog", "Workspace must track the Fit Y by X creation dialog");
assertSourceIncludes(workspaceSource, "addAnalysis(created)", "Workspace must add newly created Fit Y by X analyses to the Analysis store");
assertSourceExcludes(workspaceSource, "deleteFitYByXByDataset", "Deleting a source table must retain Fit Y by X Analysis documents");

assertSourceExcludes(workspaceSource, "fitYByXByParent", "Tree grouping must use the shared Analysis collection");
assertSourceIncludes(workspaceSource, "history.newFitYByX", "Creation must record Fit Y by X history");
assertSourceIncludes(workspaceSource, "history.renameAnalysis", "Rename must record shared Analysis history");
assertSourceIncludes(workspaceSource, "history.deleteAnalysis", "Delete must record shared Analysis history");
assertSourceIncludes(workspaceSource, "<AnalysisView item={item} dataset={ds}", "Main pane must dispatch Fit Y by X through AnalysisView");

const locales = [
  ["en", readJson("../src/i18n/locales/en.json")],
  ["vi", readJson("../src/i18n/locales/vi.json")],
  ["zh-CN", readJson("../src/i18n/locales/zh-CN.json")],
  ["zh-TW", readJson("../src/i18n/locales/zh-TW.json")],
] as const;

const requiredLocalePaths = [
  "menu.fitYByX",
  "fitYByX.title",
  "fitYByX.dialogTitle",
  "fitYByX.response",
  "fitYByX.factor",
  "fitYByX.graph",
  "fitYByX.graphHint",
  "fitYByX.report.title",
  "fitYByX.report.loading",
  "fitYByX.report.error",
  "fitYByX.report.personality",
  "fitYByX.personalityLabel",
  "fitYByX.report.reasonLabel",
  "fitYByX.report.undefinedValue",
  "fitYByX.report.usedRows",
  "fitYByX.report.excludedRows",
  "fitYByX.report.notComputable",
  "fitYByX.report.section.status",
  "fitYByX.report.section.summaryOfFit",
  "fitYByX.report.section.lackOfFit",
  "fitYByX.report.section.analysisOfVariance",
  "fitYByX.report.section.parameterEstimates",
  "fitYByX.report.section.groupSummary",
  "fitYByX.report.section.effectSize",
  "fitYByX.report.column.metric",
  "fitYByX.report.column.value",
  "fitYByX.report.column.source",
  "fitYByX.report.column.degreesOfFreedom",
  "fitYByX.report.column.sumOfSquares",
  "fitYByX.report.column.meanSquare",
  "fitYByX.report.column.fRatio",
  "fitYByX.report.column.pValue",
  "fitYByX.report.column.term",
  "fitYByX.report.column.estimate",
  "fitYByX.report.column.standardError",
  "fitYByX.report.column.tRatio",
  "fitYByX.report.column.lowerConfidenceLimit",
  "fitYByX.report.column.upperConfidenceLimit",
  "fitYByX.report.column.group",
  "fitYByX.report.column.count",
  "fitYByX.report.column.mean",
  "fitYByX.report.column.standardDeviation",
  "fitYByX.report.summaryOfFit.rSquared",
  "fitYByX.report.summaryOfFit.adjustedRSquared",
  "fitYByX.report.summaryOfFit.rootMeanSquareError",
  "fitYByX.report.summaryOfFit.meanOfResponse",
  "fitYByX.report.summaryOfFit.observationCount",
  "fitYByX.report.effectSize.etaSquared",
  "fitYByX.report.effectSize.omegaSquared",
  "fitYByX.report.lackOfFit.notIdentifiable",
  "fitYByX.report.reason.insufficientValidRows",
  "fitYByX.report.reason.insufficientGroups",
  "fitYByX.report.reason.constantFactor",
  "fitYByX.report.reason.noResidualDegreesOfFreedom",
  "fitYByX.report.reason.noWithinGroupDegreesOfFreedom",
  "fitYByX.create",
  "fitYByX.cancel",
  "fitYByX.search",
  "fitYByX.sourceMissing",
  "fitYByX.validation.missingResponse",
  "fitYByX.validation.missingFactor",
  "fitYByX.validation.duplicateRole",
  "fitYByX.validation.invalidResponse",
  "fitYByX.validation.invalidFactor",
  "history.newFitYByX",
  "history.renameFitYByX",
  "history.deleteFitYByX",
  "workspace.fitYByXMissing",
  "workspace.fitYByXSourceMissing",
];

for (const [localeName, messages] of locales) {
  for (const keyPath of requiredLocalePaths) {
    assert.equal(typeof getPathValue(messages, keyPath), "string", `${localeName} locale must define ${keyPath}`);
  }
}

console.log("Workspace Fit Y by X integration contract passed");