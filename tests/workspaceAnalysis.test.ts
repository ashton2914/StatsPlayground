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

assertSourceIncludes(workspaceSource, "useAnalysisStore", "Workspace must consume the analysis store");
assertSourceIncludes(workspaceSource, "AnalysisView", "Workspace must render the Analysis main-pane view");
assertSourceIncludes(workspaceSource, "activeAnalysisId", "Workspace must track the active Analysis document");
assertSourceIncludes(workspaceSource, "addAnalysis", "Workspace must add Analysis documents");
assertSourceIncludes(workspaceSource, "loadAnalyses", "Project open must load saved Analysis documents");
assertSourceIncludes(workspaceSource, "resetAnalyses", "Project close/open reset must clear the Analysis store");
assertSourceIncludes(workspaceSource, "analysisFolders", "Project save/open payloads must include Analysis folder assignments");
assertSourceIncludes(workspaceSource, "setAnalysisFolder", "Workspace must move Analysis documents through the folder store");
assertSourceIncludes(workspaceSource, "buildAnalysisProjectPayload", "Workspace must delegate analysis save payload shaping to the lifecycle helper");
assertSourceIncludes(workspaceSource, "hydrateAnalysisProjectPayload", "Workspace must delegate analysis open hydration to the lifecycle helper");
assertSourceIncludes(workspaceSource, "analyses: folderPayload.analyses", "Project save payload must include analyses");
assertSourceIncludes(workspaceSource, 'kind === "analysis"', "Drag payload and context menu unions must include Analysis items");
assertSourceIncludes(workspaceSource, "analysesByParent", "Tree grouping must include Analysis documents by folder");
assertSourceIncludes(workspaceSource, "fsSetAnalysisFolder", "Drop handling must assign Analysis documents into folders");
assertSourceIncludes(workspaceSource, "history.renameAnalysis", "Rename must record Analysis history");
assertSourceIncludes(workspaceSource, "history.deleteAnalysis", "Delete must record Analysis history");
assertSourceIncludes(workspaceSource, 'projectFileExtension("analysis")', "DIRECTORY rows must render the immutable .span suffix");
assertSourceIncludes(workspaceSource, "activeAnalysisId === item.id", "DIRECTORY rows must highlight the active Analysis");
assertSourceIncludes(workspaceSource, "workspace.analysisMissing", "Missing Analysis documents must have a workspace state");
assertSourceIncludes(workspaceSource, "workspace.analysisSourceMissing", "Analysis view must report when the source dataset is unavailable");
assertSourceIncludes(workspaceSource, "<AnalysisView item={item} dataset={ds}", "AnalysisView must receive the document and optional dataset");
assert.equal(workspaceSource.includes("deleteAnalysisByDataset"), false, "Deleting a source table must not cascade-delete saved Analysis documents");
assertSourceIncludes(workspaceSource, "fsPrune(dsIds, gbIds, tabulateIds, fitYByXIds, distributionIds, reportIds, analysisIds)", "Prune must include live Analysis ids");
assertSourceIncludes(workspaceSource, "selectWorkspaceDocument", "Workspace must use the shared lifecycle helper for active-document exclusivity");
assertSourceIncludes(workspaceSource, "getRetainedActiveAnalysisIdAfterDatasetDeletion", "Workspace must use the shared lifecycle helper for source deletion retention");

const analysisViewSource = readSource("../src/components/analysis/AnalysisView.tsx");
assertSourceIncludes(analysisViewSource, "AnalysisView", "AnalysisView component must exist");
assertSourceIncludes(analysisViewSource, "item: AnalysisDocument", "AnalysisView must accept an AnalysisDocument prop");
assertSourceIncludes(analysisViewSource, "dataset?:", "AnalysisView must accept a missing dataset");

const projectNamingSource = readSource("../src/utils/projectFileNaming.ts");
assertSourceIncludes(projectNamingSource, 'if (kind === "analysis") return ".span";', "Shared naming must map analyses to .span");
assertSourceIncludes(projectNamingSource, "ensureProjectFileName", "Shared naming utilities must expose ensureProjectFileName");

const locales = [
  ["en", readJson("../src/i18n/locales/en.json")],
  ["vi", readJson("../src/i18n/locales/vi.json")],
  ["zh-CN", readJson("../src/i18n/locales/zh-CN.json")],
  ["zh-TW", readJson("../src/i18n/locales/zh-TW.json")],
] as const;

const requiredLocalePaths = [
  "history.newAnalysis",
  "history.renameAnalysis",
  "history.deleteAnalysis",
  "workspace.analysisMissing",
  "workspace.analysisSourceMissing",
];

for (const [localeName, messages] of locales) {
  for (const keyPath of requiredLocalePaths) {
    assert.equal(typeof getPathValue(messages, keyPath), "string", `${localeName} locale must define ${keyPath}`);
  }
}

console.log("Workspace analysis integration contract passed");