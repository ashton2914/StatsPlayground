import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const workspaceSource = readSource("../src/components/Workspace.tsx");

assertSourceIncludes(workspaceSource, "useFitModelStore", "Workspace must consume the Fit Model store");
assertSourceIncludes(workspaceSource, "FitModelRoleDialog", "Workspace must render the Fit Model role dialog");
assertSourceIncludes(workspaceSource, "FitModelView", "Workspace must render the Fit Model main-pane view");
assertSourceIncludes(workspaceSource, "onCreateDefinition={handleCreateFitModelItem}", "Workspace must pass the async fit model creation callback directly for awaited error handling");

assertSourceIncludes(workspaceSource, "menu.fitModel", "Analysis menu must include menu.fitModel");
assertSourceIncludes(workspaceSource, "handleCreateFitModel", "Fit Model menu entry must open the creation flow");

assertSourceIncludes(workspaceSource, "fitModels: fitModelItems", "Project save payload must include Fit Model analyses");
assertSourceIncludes(workspaceSource, "fitModelFolders", "Project save/open payloads must include Fit Model folder assignments");
assertSourceIncludes(workspaceSource, "loadFitModelFromProject((result.fitModels ?? [])", "Project open must load saved Fit Model analyses");
assertSourceIncludes(workspaceSource, "resetFitModels()", "Project close/open reset must clear the Fit Model store");

assertSourceIncludes(workspaceSource, "activeFitModelId", "Workspace must track the active Fit Model analysis");
assertSourceIncludes(workspaceSource, "showFitModelDialog", "Workspace must track the Fit Model creation dialog");
assertSourceIncludes(workspaceSource, "addFitModel", "Workspace must add newly created Fit Model analyses");
assertSourceIncludes(workspaceSource, "renameFitModel", "Workspace must rename Fit Model analyses from the tree");
assertSourceIncludes(workspaceSource, "deleteFitModel", "Workspace must delete Fit Model analyses from the tree");
assertSourceIncludes(workspaceSource, "deleteFitModelByDataset", "Deleting a source table must cascade-delete dependent Fit Model analyses");
assertSourceIncludes(workspaceSource, "fsSetFitModelFolder", "Workspace drag/drop must move Fit Model analyses into folders");
assertSourceIncludes(workspaceSource, "Boolean(item.loadIssue)", "Fit Model tree rows must treat load-issue analyses as unavailable");
assertSourceIncludes(workspaceSource, "fitModelUnavailable ? t(\"workspace.fitModelSourceMissing\") : sourceDs.name", "Fit Model tree rows must render unavailable text for load-issue analyses");

assertSourceIncludes(workspaceSource, "| { kind: \"fitModel\"; id: string }", "Drag payload and context menu unions must include Fit Model items");
assertSourceIncludes(workspaceSource, "fitModelByParent", "Tree grouping must include Fit Model documents by folder");
assertSourceIncludes(workspaceSource, "setActiveFitModelId(null)", "Selecting tables, graphs, tabulates, Fit Y by X, distributions, or close/open must clear active Fit Model selection");
assertSourceIncludes(workspaceSource, "setActiveFitModelId(id)", "Selecting or creating a Fit Model item must activate it");
assertSourceIncludes(workspaceSource, "activeFitModelId === item.id", "Tree rows must show the active Fit Model document");
assertSourceIncludes(workspaceSource, "sourceDatasetId === id", "Source-table deletion must recognize active dependent Fit Model analyses");
assertSourceIncludes(workspaceSource, "history.newFitModel", "Creation must record Fit Model history");
assertSourceIncludes(workspaceSource, "history.renameFitModel", "Rename must record Fit Model history");
assertSourceIncludes(workspaceSource, "history.deleteFitModel", "Delete must record Fit Model history");
assertSourceIncludes(workspaceSource, "<FitModelView", "Main pane must dispatch to FitModelView");
assertSourceIncludes(workspaceSource, "fsPrune(dsIds, gbIds, tabulateIds, fitYByXIds, distributionIds, fitModelIds)", "Folder prune must pass Fit Model IDs as the sixth argument");

const fitModelCssSource = readSource("../src/components/fitModel/fitModel.css");
assertSourceIncludes(fitModelCssSource, ".sp-fit-model-dialog", "Fit Model CSS must style dialog sizing");
assertSourceIncludes(fitModelCssSource, "grid-template-columns", "Fit Model CSS must define stable two-column layout");
assertSourceIncludes(fitModelCssSource, ".sp-fit-model-report-shell", "Fit Model CSS must define report scroll container");
assertSourceIncludes(fitModelCssSource, ".sp-fit-model-report-table-wrap", "Fit Model CSS must keep report tables compact and scrollable");
assertSourceIncludes(fitModelCssSource, ".sp-fit-model-chart-shell", "Fit Model CSS must define stable chart height");
assertSourceIncludes(fitModelCssSource, "@media (max-width: 900px)", "Fit Model CSS must wrap layout for narrow viewports");

const locales = [
  ["en", readJson("../src/i18n/locales/en.json")],
  ["vi", readJson("../src/i18n/locales/vi.json")],
  ["zh-CN", readJson("../src/i18n/locales/zh-CN.json")],
  ["zh-TW", readJson("../src/i18n/locales/zh-TW.json")],
] as const;

const requiredLocalePaths = [
  "menu.fitModel",
  "history.newFitModel",
  "history.renameFitModel",
  "history.deleteFitModel",
  "history.saveFitModelColumns",
  "workspace.fitModelMissing",
  "workspace.fitModelSourceMissing",
  "fitModel.title",
  "fitModel.response",
  "fitModel.modelTermCount",
  "fitModel.centeringMethod",
  "fitModel.centering.none",
  "fitModel.centering.mean",
  "fitModel.sourceMissing",
  "fitModel.dialog.title",
  "fitModel.dialog.availableFields",
  "fitModel.dialog.searchFields",
  "fitModel.dialog.searchAvailableFields",
  "fitModel.dialog.loadingFields",
  "fitModel.dialog.noFields",
  "fitModel.dialog.noMatch",
  "fitModel.dialog.assignResponseLabel",
  "fitModel.dialog.assignResponse",
  "fitModel.dialog.assignMainLabel",
  "fitModel.dialog.assignMain",
  "fitModel.dialog.response",
  "fitModel.dialog.continuousOnly",
  "fitModel.dialog.responseEmpty",
  "fitModel.dialog.responseHint",
  "fitModel.dialog.clearResponse",
  "fitModel.dialog.mainEffects",
  "fitModel.dialog.mainEffectsEmpty",
  "fitModel.dialog.removeMainEffect",
  "fitModel.dialog.interactions",
  "fitModel.dialog.twoWayOnly",
  "fitModel.dialog.interactionsEmpty",
  "fitModel.dialog.removeInteraction",
  "fitModel.dialog.addInteraction",
  "fitModel.dialog.toggleInteraction",
  "fitModel.dialog.macros",
  "fitModel.dialog.degree1",
  "fitModel.dialog.degree2",
  "fitModel.dialog.centerInteractions",
  "fitModel.dialog.currentTerms",
  "fitModel.dialog.parameterCount",
  "fitModel.dialog.termsEmpty",
  "fitModel.dialog.termKindMain",
  "fitModel.dialog.termKindInteraction",
  "fitModel.dialog.create",
  "fitModel.dialog.cancel",
  "fitModel.dialog.createError",
  "fitModel.dialog.validation.responseCollision",
  "fitModel.dialog.validation.mainRequiredByInteraction",
  "fitModel.dialog.validation.lastMainEffect",
  "fitModel.dialog.validation.nonContinuousField",
  "fitModel.dialog.validation.invalidInteraction",
  "fitModel.report.title",
  "fitModel.report.stale",
  "fitModel.report.loading",
  "fitModel.report.error",
  "fitModel.report.errorWithOldResult",
  "fitModel.report.undo",
  "fitModel.report.remove",
  "fitModel.report.notComputable",
  "fitModel.report.usedRows",
  "fitModel.report.excludedRows",
  "fitModel.report.noWarnings",
  "fitModel.report.undefinedValue",
  "fitModel.report.saveColumns.title",
  "fitModel.report.saveColumns.open",
  "fitModel.report.saveColumns.save",
  "fitModel.report.saveColumns.saving",
  "fitModel.report.saveColumns.cancel",
  "fitModel.report.saveColumns.unavailable",
  "fitModel.report.saveColumns.metric.predicted",
  "fitModel.report.saveColumns.metric.residual",
  "fitModel.report.saveColumns.metric.studentizedResidual",
  "fitModel.report.saveColumns.metric.leverage",
  "fitModel.report.saveColumns.metric.cooksDistance",
  "fitModel.report.saveColumns.metric.meanConfidenceLower",
  "fitModel.report.saveColumns.metric.meanConfidenceUpper",
  "fitModel.report.saveColumns.metric.predictionLower",
  "fitModel.report.saveColumns.metric.predictionUpper",
  "fitModel.report.section.modelSpecification",
  "fitModel.report.section.effectSummary",
  "fitModel.report.section.summaryOfFit",
  "fitModel.report.section.analysisOfVariance",
  "fitModel.report.section.lackOfFit",
  "fitModel.report.section.parameterEstimates",
  "fitModel.report.section.actualByPredicted",
  "fitModel.report.section.residualByPredicted",
  "fitModel.report.section.residualQq",
  "fitModel.report.section.rowDiagnostics",
  "fitModel.report.section.warnings",
  "fitModel.report.specification.construct",
  "fitModel.report.specification.response",
  "fitModel.report.specification.predictors",
  "fitModel.report.specification.terms",
  "fitModel.report.specification.usedRows",
  "fitModel.report.specification.termBudget",
  "fitModel.report.summaryOfFit.rSquared",
  "fitModel.report.summaryOfFit.adjustedRSquared",
  "fitModel.report.summaryOfFit.rootMeanSquareError",
  "fitModel.report.column.term",
  "fitModel.report.column.source",
  "fitModel.report.column.estimate",
  "fitModel.report.column.standardError",
  "fitModel.report.column.tRatio",
  "fitModel.report.column.pValue",
  "fitModel.report.column.logWorth",
  "fitModel.report.column.action",
  "fitModel.report.column.degreesOfFreedom",
  "fitModel.report.column.sumOfSquares",
  "fitModel.report.column.meanSquare",
  "fitModel.report.column.fRatio",
  "fitModel.report.column.lowerConfidenceLimit",
  "fitModel.report.column.upperConfidenceLimit",
  "fitModel.report.column.featureVif",
  "fitModel.report.column.row",
  "fitModel.report.column.observed",
  "fitModel.report.column.fitted",
  "fitModel.report.column.residual",
  "fitModel.report.column.studentizedResidual",
  "fitModel.report.column.leverage",
  "fitModel.report.column.cooksDistance",
  "fitModel.report.column.meanConfidenceInterval",
  "fitModel.report.column.predictionInterval",
  "fitModel.report.column.flags",
  "fitModel.report.reason.insufficientRows",
  "fitModel.report.reason.rankDeficient",
  "fitModel.report.reason.noReplicates",
  "fitModel.report.reason.lackOfFitDegreesOfFreedomZero",
  "fitModel.report.reason.pureErrorZero",
  "fitModel.report.reason.inferenceNotEstimable",
  "fitModel.report.reason.constantFeature",
  "fitModel.report.reason.auxiliaryRankDeficient",
  "fitModel.report.reason.insufficientDiagnosticRows",
  "fitModel.report.flag.residualWarning",
  "fitModel.report.flag.residualSevere",
  "fitModel.report.flag.highLeverage",
  "fitModel.report.flag.influential",
  "fitModel.report.diagnostics.filter",
  "fitModel.report.diagnostics.all",
  "fitModel.report.diagnostics.flagged",
  "fitModel.report.source.error",
  "fitModel.report.source.pureError",
  "fitModel.report.source.lackOfFit",
  "fitModel.report.warning.saturatedModel",
  "fitModel.report.warning.constantResponse",
  "fitModel.report.warning.perfectFit",
  "fitModel.report.warning.illConditioned",
  "fitModel.report.removeBlocked.requiredByDerivedTerm",
  "fitModel.report.removeBlocked.lastMainEffect",
  "fitModel.report.removeBlocked.notFound",
  "fitModel.report.chart.axis.predicted",
  "fitModel.report.chart.axis.actual",
  "fitModel.report.chart.axis.residual",
  "fitModel.report.chart.axis.theoreticalQuantile",
  "fitModel.report.chart.axis.studentizedResidual",
  "fitModel.report.chart.series.actual",
  "fitModel.report.chart.series.residual",
  "fitModel.report.chart.series.studentizedResidual",
  "fitModel.report.chart.reference.identity",
  "fitModel.report.chart.reference.zero",
  "fitModel.report.chart.reference.qq",
  "fitModel.report.chart.tooltip.x",
  "fitModel.report.chart.tooltip.yActual",
  "fitModel.report.chart.tooltip.yResidual",
  "fitModel.report.chart.tooltip.xQq",
  "fitModel.report.chart.tooltip.yQq",
] as const;

for (const [localeName, messages] of locales) {
  for (const keyPath of requiredLocalePaths) {
    assert.equal(typeof getPathValue(messages, keyPath), "string", `${localeName} locale must define ${keyPath}`);
  }
}

console.log("Workspace Fit Model integration contract passed");
