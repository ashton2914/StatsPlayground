import assert from "node:assert/strict";

import type { SaveProjectFolders, SaveProjectRequest } from "../src/services/projectService";
import type { OpenProjectResult, ProjectInfo } from "../src/types/project";
import type { ReportItem } from "../src/types/report";

const project: ProjectInfo = {
  name: "Project",
  filePath: "C:/tmp/project.spprj",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const reportItem: ReportItem = {
  schemaVersion: 1,
  id: "report-1",
  name: "Report 1",
  markdown: "# Report",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const saveFolders = {
  folders: ["Reports"],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  tabulateFolders: {},
  distributionFolders: {},
  reports: [reportItem],
  reportFolders: {
    "report-1": "Reports",
  },
} satisfies SaveProjectFolders;

const saveRequest = {
  filePath: undefined,
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  tabulates: [],
  distributions: [],
  workflows: [],
  logicalFolders: [],
  workflowRuns: [],
  ...saveFolders,
} satisfies SaveProjectRequest;

const openResult = {
  project,
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  tabulates: [],
  distributions: [],
  folders: ["Reports"],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  tabulateFolders: {},
  distributionFolders: {},
  reports: [reportItem],
  reportFolders: {
    "report-1": "Reports",
  },
  workflows: [],
  logicalFolders: [],
  workflowRuns: [],
  lineageGraph: {
    id: "project-lineage",
    name: "Project Lineage",
    nodes: [],
    edges: [],
  },
  documentNameMigrations: [],
  datasetNameMigrations: [],
  requiresMigration: false,
} satisfies OpenProjectResult;

assert.deepEqual(saveFolders.reports, [reportItem]);
assert.deepEqual(saveFolders.reportFolders, { "report-1": "Reports" });
assert.deepEqual(saveRequest.reports, [reportItem]);
assert.deepEqual(saveRequest.reportFolders, { "report-1": "Reports" });
assert.deepEqual(openResult.reports, [reportItem]);
assert.deepEqual(openResult.reportFolders, { "report-1": "Reports" });

console.log("report project contracts passed");