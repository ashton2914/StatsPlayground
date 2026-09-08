import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hydrateAnalysisProjectPayload } from "../src/components/analysis/analysisWorkspaceLifecycle.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import { createFitYByXItem } from "../src/components/fitYByX/fitYByXConfig.ts";
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
const analysisStandardSource = readFileSync(
  new URL("../docs/analysis-development-standard.md", import.meta.url),
  "utf8",
);

assert.match(projectTypesSource, /analyses:\s*AnalysisDocument\[\]/);
assert.match(projectTypesSource, /analysisFolders:\s*Record<string, string>/);
assert.match(projectServiceSource, /analyses:\s*AnalysisDocument\[\]/);
assert.match(projectServiceSource, /analysisFolders:\s*Record<string, string>/);
assert.match(archiveSource, /DocumentKind\s*\{[\s\S]*Analysis/);
assert.match(archiveSource, /analyses/);
assert.match(archiveSource, /\.span/);
assert.match(analysisStandardSource, /directly compose[\s\S]*AnalysisFrame[\s\S]*AnalysisTable[\s\S]*AnalysisGraph/i);
assert.match(analysisStandardSource, /must not wrap or delegate to a legacy report/i);
assert.match(analysisStandardSource, /native `<table>`[\s\S]*native action `<button>`/i);
assert.match(analysisStandardSource, /typography[\s\S]*spacing[\s\S]*presentation tokens/i);
assert.match(analysisStandardSource, /visual acceptance/i);

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

const response = { name: "DIM2", type: "continuous" as const };
const legacyDistribution = createDistributionItem({
  id: "legacy-distribution",
  name: "Legacy Distribution",
  sourceDatasetId: "dataset-2",
  responses: [response],
  weight: null,
  frequency: null,
  by: [],
  columns: [{ name: response.name, sqlType: "DOUBLE", integerCompatible: false, field: response }],
  createdAt: "2026-09-06T00:00:00.000Z",
});
const hydrated = hydrateAnalysisProjectPayload({
  analyses: [analysis],
  analysisFolders: { "analysis-1": "Analyses/Sample" },
  distributions: [legacyDistribution],
  distributionFolders: { "legacy-distribution": "Analyses/Legacy" },
});
assert.equal(hydrated.migratedCount, 1);
assert.equal(hydrated.analyses.length, 2);
assert.equal(hydrated.analyses[1]?.documentType, "analysis");
assert.equal(hydrated.analysisFolders["legacy-distribution"], "Analyses/Legacy");

const legacyFitYByX = createFitYByXItem({
  id: "legacy-fit-y-by-x",
  name: "DIM2 by Site",
  sourceDatasetId: "dataset-2",
  response,
  factor: { name: "Site", type: "nominal" },
  createdAt: "2026-09-06T00:00:00.000Z",
});
const hydratedWithFitYByX = hydrateAnalysisProjectPayload({
  analyses: [analysis],
  analysisFolders: { "analysis-1": "Analyses/Sample" },
  distributions: [legacyDistribution],
  distributionFolders: { "legacy-distribution": "Analyses/Legacy" },
  fitYByX: [legacyFitYByX],
  fitYByXFolders: { "legacy-fit-y-by-x": "Analyses/Fit" },
});
assert.equal(hydratedWithFitYByX.migratedCount, 2);
assert.equal(hydratedWithFitYByX.analyses[2]?.id, legacyFitYByX.id);
assert.equal(hydratedWithFitYByX.analysisFolders[legacyFitYByX.id], "Analyses/Fit");

const hydratedWithFitModel = hydrateAnalysisProjectPayload({
  analyses: [analysis],
  analysisFolders: { "analysis-1": "Analyses/New" },
  fitModels: [
    {
      id: "legacy-fit-model",
      name: "Fit Model 1",
      sourceDatasetId: "dataset-2",
      response: { name: "Strength", type: "continuous" },
      construct: { kind: "manual" },
      terms: [{ kind: "main", columnNames: ["Temperature"] }],
      centeringMethod: "mean",
      createdAt: "2026-09-08T00:00:00.000Z",
    },
    {
      id: "analysis-1",
      name: "Colliding legacy item",
      sourceDatasetId: "dataset-2",
      response: { name: "Strength", type: "continuous" },
      terms: [{ kind: "main", columnNames: ["Temperature"] }],
      centeringMethod: "none",
      createdAt: "2026-09-08T00:00:00.000Z",
    },
    {
      id: "invalid-fit-model",
      name: "Damaged Fit Model",
      sourceDatasetId: "dataset-2",
      response: { name: "Site", type: "nominal" },
      terms: [],
      centeringMethod: "none",
      createdAt: "2026-09-08T00:00:00.000Z",
    },
  ],
  fitModelFolders: {
    "legacy-fit-model": "Analyses/Models",
    "analysis-1": "Analyses/Legacy Collision",
    "invalid-fit-model": "Analyses/Damaged",
  },
});
assert.deepEqual(hydratedWithFitModel.analyses.map((entry) => entry.id), [
  "analysis-1",
  "legacy-fit-model",
  "invalid-fit-model",
]);
assert.equal(hydratedWithFitModel.analyses[1]?.analysisKind, "fitModel");
assert.equal(hydratedWithFitModel.analyses[2]?.analysisKind, "fitModel");
assert.equal(
  hydratedWithFitModel.analyses[2]?.definition.kind === "fitModel"
    && hydratedWithFitModel.analyses[2].definition.migrationIssue?.code,
  "invalidPersistedDefinition",
);
assert.equal(hydratedWithFitModel.analysisFolders["analysis-1"], "Analyses/New");
assert.equal(hydratedWithFitModel.analysisFolders["legacy-fit-model"], "Analyses/Models");
assert.equal(hydratedWithFitModel.analysisFolders["invalid-fit-model"], "Analyses/Damaged");
assert.equal(hydratedWithFitModel.migratedCount, 2);

console.log("analysis project contracts passed");