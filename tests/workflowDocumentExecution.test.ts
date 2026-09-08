import assert from "node:assert/strict";

import { createWorkflowAnalysisExecutionRequest } from "../src/components/analysis/analysisExecutors.ts";
import type { FitYByXAnalysisDocument } from "../src/types/analysis.ts";
import type { WorkflowDocumentCommit } from "../src/types/workflow.ts";

const analysis: FitYByXAnalysisDocument = {
  schemaVersion: 1,
  documentType: "analysis",
  id: "analysis-output",
  name: "Strength by site",
  analysisKind: "fitYByX",
  configRevision: 3,
  source: { datasetId: "workflow-local-slot" },
  definition: {
    kind: "fitYByX",
    response: { name: "strength", type: "continuous" },
    factor: { name: "site", type: "nominal" },
    personality: "oneway",
    confidenceLevel: 0.95,
  },
  presentation: {
    schemaVersion: 1,
    layout: "fit-y-by-x-v1",
    graph: {
      mode: "2d",
      modeStates: {
        twoD: {
          encoding: {},
          multiX: [],
          multiY: [],
          elements: [],
          smootherLambda: 0.5,
        },
        threeD: { encoding: {}, elements: [], smootherLambda: 0.5 },
        multivariate: {
          columns: [],
          chartType: "correlationMatrix",
          correlationMethod: "pearson",
        },
      },
      filters: [],
    },
  },
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const request = createWorkflowAnalysisExecutionRequest(
  analysis,
  "stable-table-c",
  7,
);
assert.equal(request.datasetId, "stable-table-c");
assert.equal(request.generation, 7);
assert.equal(analysis.source.datasetId, "workflow-local-slot");

const commits: WorkflowDocumentCommit[] = [
  {
    kind: "graph",
    id: "stable-graph",
    name: "Graph",
    sourceTableId: "stable-table-c",
    document: { sourceDatasetId: "stable-table-c" },
    validationResultHash: "graph-hash",
  },
  {
    kind: "analysis",
    id: "stable-analysis",
    name: "Analysis",
    sourceTableId: "stable-table-c",
    document: analysis,
    validationResultHash: "analysis-hash",
  },
  {
    kind: "tabulate",
    id: "stable-tabulate",
    name: "Tabulate",
    sourceTableId: "stable-table-c",
    document: { sourceDatasetId: "stable-table-c" },
    result: { cells: [] },
    validationResultHash: "tabulate-hash",
  },
  {
    kind: "report",
    id: "stable-report",
    name: "Report",
    markdown: '{{sp-embed kind="graph" id="stable-graph"}}',
    dependencyIds: ["stable-graph"],
    validationResultHash: "report-hash",
  },
];

assert.deepEqual(commits.map((commit) => commit.kind), [
  "graph",
  "analysis",
  "tabulate",
  "report",
]);