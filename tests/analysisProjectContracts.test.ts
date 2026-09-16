import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hydrateAnalysisProjectPayload } from "../src/components/analysis/analysisWorkspaceLifecycle.ts";
import { createAnalysisSampleDocument } from "../src/components/analysis/analysisSample.ts";
import { createDistributionItem } from "../src/components/distribution/distributionConfig.ts";
import { createFitYByXItem } from "../src/components/fitYByX/fitYByXConfig.ts";
import { createHypothesisTestAnalysisDocument } from "../src/components/analysis/adapters/hypothesisTestAnalysisAdapter.ts";
import type { SaveProjectRequest } from "../src/services/projectService";
import type { ColumnDisplayProps } from "../src/types/data";
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
analysis.definition.nestedSubgroup = { name: "Lot", type: "nominal" };

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
  datasetFilters: {},
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
  datasetFilters: {},
  datasetFilterMigrationConflicts: [],
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
    graphVersion: 2,
    graphHash: "a".repeat(64),
    nodes: [],
    edges: [],
  },
} satisfies OpenProjectResult;

assert.deepEqual(saveRequest.analyses, [analysis]);
assert.deepEqual(saveRequest.analyses[0]?.definition.nestedSubgroup, {
  name: "Lot",
  type: "nominal",
});
assert.deepEqual(saveRequest.analysisFolders, { "analysis-1": "Analyses/Sample" });
assert.deepEqual(openResult.analyses, [analysis]);
assert.deepEqual(openResult.analyses[0]?.definition.nestedSubgroup, {
  name: "Lot",
  type: "nominal",
});
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
  analysis: {
    confidenceLevel: 0.99,
    specLimits: { DIM2: { lsl: 9, target: 10, usl: 11 } },
    fitDistributions: ["normal", "weibull"],
  },
  createdAt: "2026-09-06T00:00:00.000Z",
});
const legacyProjectPayload = {
  analyses: [analysis],
  analysisFolders: { "analysis-1": "Analyses/Sample" },
  distributions: [legacyDistribution],
  distributionFolders: { "legacy-distribution": "Analyses/Legacy" },
  tableDisplayProps: [{ colIndex: 0, extras: { spec: { lsl: 9, target: 10, usl: 11 } } }] satisfies ColumnDisplayProps[],
};
const legacyProjectPayloadSnapshot = JSON.stringify(legacyProjectPayload);
const hydrated = hydrateAnalysisProjectPayload(legacyProjectPayload);
assert.equal(hydrated.migratedCount, 1);
assert.equal(hydrated.analyses.length, 2);
assert.equal(hydrated.analyses[1]?.documentType, "analysis");
assert.equal(hydrated.analyses[1]?.analysisKind, "distribution");
assert.deepEqual(
  hydrated.analyses[1]?.analysisKind === "distribution"
    ? hydrated.analyses[1].definition.analysis.specLimits
    : null,
  {},
);
assert.equal(hydrated.analysisFolders["legacy-distribution"], "Analyses/Legacy");
assert.equal(JSON.stringify(legacyProjectPayload), legacyProjectPayloadSnapshot);

const canonicalLegacyOverride = {
  ...analysis,
  definition: {
    ...analysis.definition,
    analysis: {
      ...analysis.definition.analysis,
      specLimits: { DIM1: { lsl: 9, target: 10, usl: 11 } },
    },
  },
};
const canonicalHydrated = hydrateAnalysisProjectPayload({
  analyses: [canonicalLegacyOverride],
  analysisFolders: { [canonicalLegacyOverride.id]: "Analyses/Sample" },
});
assert.equal(canonicalHydrated.migratedCount, 1);
assert.equal(canonicalHydrated.analyses.length, 1);
assert.deepEqual(
  canonicalHydrated.analyses[0]?.analysisKind === "distribution"
    ? canonicalHydrated.analyses[0].definition.analysis.specLimits
    : null,
  {},
);
assert.deepEqual(
  canonicalLegacyOverride.definition.analysis.specLimits,
  { DIM1: { lsl: 9, target: 10, usl: 11 } },
);

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

const hypothesisDocument = createHypothesisTestAnalysisDocument({
  id: "analysis-hypothesis",
  name: "Hypothesis Test",
  sourceDatasetId: "dataset-2",
  definition: {
    kind: "hypothesisTest",
    roles: {
      layout: "long",
      response: { name: "DIM2", type: "continuous" },
      condition: { name: "Site", type: "nominal" },
      subject: null,
    },
    studyDesign: "independent",
    selectionMode: "automatic",
    manualSelection: null,
    alternative: "twoSided",
    alpha: 0.05,
    confidenceLevel: 0.95,
    levelOrder: ["A", "B"],
    referenceLevel: "A",
    postHoc: "automatic",
    selectorVersion: "1",
  },
  createdAt: "2026-09-08T00:00:00.000Z",
});

const hydratedAllKinds = hydrateAnalysisProjectPayload({
  analyses: [analysis, hypothesisDocument],
  analysisFolders: {
    "analysis-1": "Analyses/New",
    "analysis-hypothesis": "Analyses/Hypothesis",
  },
  distributions: [legacyDistribution],
  distributionFolders: { "legacy-distribution": "Analyses/Legacy" },
  fitYByX: [legacyFitYByX],
  fitYByXFolders: { "legacy-fit-y-by-x": "Analyses/Fit" },
  fitModels: [
    {
      id: "legacy-fit-model-all",
      name: "Fit Model All",
      sourceDatasetId: "dataset-2",
      response: { name: "Strength", type: "continuous" },
      construct: { kind: "manual" },
      terms: [{ kind: "main", columnNames: ["Temperature"] }],
      centeringMethod: "none",
      createdAt: "2026-09-08T00:00:00.000Z",
    },
  ],
  fitModelFolders: {
    "legacy-fit-model-all": "Analyses/Models",
  },
});
const allKinds = new Set(hydratedAllKinds.analyses.map((entry) => entry.analysisKind));
assert.deepEqual([...allKinds].sort(), ["distribution", "fitModel", "fitYByX", "hypothesisTest"]);
assert.equal(hydratedAllKinds.analysisFolders["analysis-hypothesis"], "Analyses/Hypothesis");

console.log("analysis project contracts passed");