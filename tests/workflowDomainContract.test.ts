import assert from "node:assert/strict";

import "../src/types/workflow.ts";
import type {
  ProjectWorkflowManifestFields,
  WorkflowDefinition,
  WorkflowRun,
} from "../src/types/workflow.ts";

const workflow: WorkflowDefinition = {
  id: "workflow-1",
  name: "Analyze yield",
  formatVersion: "1",
  revision: 2,
  inputSlots: [
    {
      id: "workflow-input-1",
      name: "Measurements",
      outputPort: {
        id: "workflow-input-1:output",
        name: "output",
        payloadKind: "table",
      },
      schemaContract: {
        schemaFingerprint: "5f21e7b9",
        columns: [
          {
            name: "yield",
            canonicalDuckdbType: "DOUBLE",
            required: true,
            requiredByOperationIds: ["workflow-operation-1"],
          },
        ],
      },
    },
  ],
  operations: [
    {
      id: "workflow-operation-1",
      kind: "graphGeneration",
      schemaVersion: "1",
      configuration: { response: "yield" },
      inputPorts: [
        { id: "input", name: "input", payloadKind: "table" },
      ],
      outputPorts: [
        { id: "output", name: "output", payloadKind: "graph" },
      ],
    },
  ],
  edges: [
    {
      id: "workflow-edge-1",
      kind: "consumes",
      source: { nodeId: "workflow-input-1", portId: "workflow-input-1:output" },
      target: { nodeId: "workflow-operation-1", portId: "input" },
    },
  ],
  outputDeclarations: [],
};

const run: WorkflowRun = {
  id: "run-1",
  workflowId: workflow.id,
  workflowRevision: workflow.revision,
  status: "pending",
  inputBindings: [
    { slotId: "workflow-input-1", tableDocumentId: "table-1" },
  ],
  nodeResults: [],
  outputBindings: [],
  errors: [],
  parentFolderId: "folder-run-1",
};

const manifestFields: ProjectWorkflowManifestFields = {
  lineageGraph: {
    id: "project-lineage",
    name: "Project lineage",
    nodes: [
      {
        nodeType: "artifact",
        id: "artifact-table-1",
        documentRef: { kind: "table", id: "table-1" },
        name: "Measurements",
        artifactKind: "table",
        inputPort: { id: "input", name: "input", payloadKind: "table" },
        outputPort: { id: "output", name: "output", payloadKind: "table" },
      },
    ],
    edges: [],
  },
  workflowFiles: [
    {
      id: workflow.id,
      name: workflow.name,
      revision: workflow.revision,
      file: "workflows/workflow-1.json",
    },
  ],
  logicalFolders: [
    {
      id: "folder-run-1",
      name: "Run 1",
      kind: "workflowRun",
      parentFolderId: "folder-workflow-1",
    },
  ],
  workflowRuns: [run],
};

const serialized = JSON.parse(JSON.stringify({ workflow, ...manifestFields }));

assert.equal(serialized.lineageGraph.nodes[0].nodeType, "artifact");
assert.equal(serialized.workflowFiles[0].file, "workflows/workflow-1.json");
assert.equal(serialized.logicalFolders[0].parentFolderId, "folder-workflow-1");
assert.equal(serialized.workflowRuns[0].parentFolderId, "folder-run-1");
assert.equal(
  serialized.workflow.inputSlots[0].schemaContract.schemaFingerprint,
  "5f21e7b9",
);
assert.equal("workflow_files" in serialized, false);
assert.equal("parent_folder_id" in serialized.logicalFolders[0], false);