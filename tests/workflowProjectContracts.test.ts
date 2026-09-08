import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildProjectDependencyGraph } from "../src/workflow/projectDependencyGraph.ts";
import type { OpenProjectResult, ProjectInfo } from "../src/types/project";

const liveGraph = buildProjectDependencyGraph({
  datasets: [],
  graphs: [],
  analyses: [],
  distributions: [],
  tabulates: [],
  reports: [],
});
assert.equal(liveGraph.graphVersion, 2);
assert.equal(liveGraph.graphHash, "");

const project: ProjectInfo = {
  name: "Project",
  filePath: "/project.spprj",
  createdAt: "2026-09-08T00:00:00.000Z",
};
const openResult = {
  project,
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [],
  tabulates: [],
  distributions: [],
  analyses: [],
  folders: [],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: {},
  distributionFolders: {},
  analysisFolders: {},
  documentNameMigrations: [],
  datasetNameMigrations: [],
  requiresMigration: false,
  tabulateFolders: {},
  reportFolders: {},
  reports: [],
  workflows: [],
  logicalFolders: [],
  workflowRuns: [],
  recoveredWorkflowPackets: [{
    commitId: "run-2",
    documents: [],
    run: {
      id: "run-2",
      workflowId: "workflow-1",
      workflowRevision: 1,
      status: "succeeded",
      inputBindings: [{ slotId: "source", tableDocumentId: "table-a" }],
      nodeResults: [],
      outputBindings: [{ declarationId: "table-output", artifactDocumentId: "table-c" }],
      errors: [],
      seed: 42,
      engineVersion: "0.1.0",
      configurationHash: "configuration-hash",
      inputFingerprints: [{
        slotId: "source",
        tableDocumentId: "table-a",
        generation: 0,
        schemaFingerprint: "schema-hash",
        contentHash: "input-hash",
      }],
      outputFingerprints: [{
        declarationId: "table-output",
        artifactDocumentId: "table-c",
        contentHash: "output-hash",
      }],
      determinismBaselineRunId: "run-1",
    },
  }],
  lineageGraph: {
    id: "project-lineage",
    name: "Project lineage",
    graphVersion: 2,
    graphHash: "a".repeat(64),
    nodes: [],
    edges: [],
  },
} satisfies OpenProjectResult;
assert.equal(openResult.lineageGraph.graphHash.length, 64);
assert.equal(
  openResult.recoveredWorkflowPackets[0]?.run.determinismBaselineRunId,
  "run-1",
);

const projectServiceSource = readFileSync(
  new URL("../src-tauri/src/services/project_service.rs", import.meta.url),
  "utf8",
);
assert.match(
  projectServiceSource,
  /refresh_project_lineage_graph\(&mut bundle\)\?/,
);
assert.match(
  projectServiceSource,
  /requires_archive_migration\(&bundle\.manifest\.version\) \|\| graph_requires_migration/,
);

console.log("workflow project contracts passed");
