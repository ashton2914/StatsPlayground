import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import type { SaveProjectRequest } from "../src/services/projectService";
import type { OpenProjectResult, ProjectInfo } from "../src/types/project";

const projectTypesSource = readFileSync(
  new URL("../src/types/project.ts", import.meta.url),
  "utf8",
);
const projectServiceSource = readFileSync(
  new URL("../src/services/projectService.ts", import.meta.url),
  "utf8",
);
const archiveSource = readFileSync(
  new URL("../src-tauri/src/services/spprj_archive.rs", import.meta.url),
  "utf8",
);

assert.match(projectTypesSource, /analyses:\s*AnalysisDocument\[\]/);
assert.match(projectTypesSource, /analysisFolders:\s*Record<string, string>/);
assert.match(projectServiceSource, /analyses:\s*AnalysisDocument\[\]/);
assert.match(projectServiceSource, /analysisFolders:\s*Record<string, string>/);
assert.match(archiveSource, /DocumentKind\s*\{[\s\S]*Analysis/);
assert.match(archiveSource, /analyses/);
assert.match(archiveSource, /\.span/);

const analysis = createAnalysisSampleDocument({
  datasetId: "dataset-1",
  analysisId: "analysis-1",
  analysisName: "DIM1 Analysis",
  createdAt: "2026-09-03T00:00:00.000Z",
});

const project: ProjectInfo = {
  name: "Project",
  filePath: "C:/tmp/project.spprj",
  createdAt: "2026-09-03T00:00:00.000Z",
};

const saveRequest = {
  filePath: undefined,
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  tabulates: [],
  distributions: [],
  analyses: [analysis],
  folders: ["Analyses", "Analyses/Sample"],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  tabulateFolders: {},
  reportFolders: {},
  reports: [],
  distributionFolders: {},
  analysisFolders: { "analysis-1": "Analyses/Sample" },
  workflows: [],
  logicalFolders: [],
  workflowRuns: [],
} satisfies SaveProjectRequest;

const openResult = {
  project,
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  tabulates: [],
  distributions: [],
  analyses: [analysis],
  folders: ["Analyses", "Analyses/Sample"],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  distributionFolders: {},
  analysisFolders: { "analysis-1": "Analyses/Sample" },
  documentNameMigrations: [],
  datasetNameMigrations: [],
  requiresMigration: false,
  tabulateFolders: {},
  reportFolders: {},
  reports: [],
  workflows: [],
  logicalFolders: [],
  workflowRuns: [],
  lineageGraph: {
    id: "project-lineage",
    name: "Project Lineage",
    nodes: [],
    edges: [],
  },
} satisfies OpenProjectResult;

assert.deepEqual(saveRequest.analyses, [analysis]);
assert.deepEqual(saveRequest.analysisFolders, { "analysis-1": "Analyses/Sample" });
assert.deepEqual(openResult.analyses, [analysis]);
assert.deepEqual(openResult.analysisFolders, { "analysis-1": "Analyses/Sample" });

console.log("analysis project contracts passed");