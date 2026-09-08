import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deriveWorkflowOperationColumnRequirements,
  isSchemaValidationBlocking,
  mergeWorkflowTableColumns,
  validateWorkflowInputSchema,
} from "../src/utils/workflowSchema.ts";
import { layoutWorkflowGraph } from "../src/utils/workflowLayout.ts";
import { useWorkflowStore } from "../src/stores/useWorkflowStore.ts";
import type { SchemaContract } from "../src/types/workflow.ts";

const contract: SchemaContract = {
  schemaFingerprint: "contract-1",
  columns: [
    {
      name: "yield",
      canonicalDuckdbType: "DOUBLE",
      required: true,
      requiredByOperationIds: ["workflow-operation-1"],
    },
    {
      name: "batch",
      canonicalDuckdbType: "VARCHAR",
      required: true,
      requiredByOperationIds: ["workflow-operation-1"],
    },
  ],
};

const compatible = validateWorkflowInputSchema(contract, [
  ["yield", "DOUBLE PRECISION"],
  ["batch", "TEXT"],
  ["operator", "VARCHAR"],
]);

assert.deepEqual(compatible.missingColumns, []);
assert.deepEqual(compatible.typeMismatches, []);
assert.deepEqual(compatible.extraColumns, ["operator"]);
assert.equal(isSchemaValidationBlocking(compatible), false);

const incompatible = validateWorkflowInputSchema(contract, [
  ["yield", "INTEGER"],
]);

assert.deepEqual(incompatible.missingColumns, [
  {
    columnName: "batch",
    expectedType: "VARCHAR",
    actualType: "",
    affectedOperationIds: ["workflow-operation-1"],
  },
]);
assert.deepEqual(incompatible.typeMismatches, [
  {
    columnName: "yield",
    expectedType: "DOUBLE",
    actualType: "INTEGER",
    affectedOperationIds: ["workflow-operation-1"],
  },
]);
assert.equal(isSchemaValidationBlocking(incompatible), true);

const extrasContract: SchemaContract = {
  schemaFingerprint: "contract-extras",
  columns: [{
    name: "batch",
    canonicalDuckdbType: "VARCHAR",
    required: true,
    requiredByOperationIds: ["workflow-operation-1"],
    requiredExtras: { valueOrder: { values: ["A", "B"] } },
  }],
};
const extrasMismatch = validateWorkflowInputSchema(extrasContract, [{
  name: "batch",
  colType: "VARCHAR",
  extras: { notes: { value: "not semantic" } },
}]);
assert.deepEqual(extrasMismatch.attributeMismatches, [{
  columnName: "batch",
  attributeName: "extras.valueOrder",
  expectedValue: { values: ["A", "B"] },
  affectedOperationIds: ["workflow-operation-1"],
}]);
assert.equal(isSchemaValidationBlocking(extrasMismatch), true);

assert.deepEqual(
  mergeWorkflowTableColumns(
    [["batch", "VARCHAR"], ["yield", "DOUBLE"]],
    [{ colIndex: 1, width: 180, extras: { spec: { lsl: 90 } } }],
  ),
  [
    { name: "batch", colType: "VARCHAR" },
    { name: "yield", colType: "DOUBLE", extras: { spec: { lsl: 90 } } },
  ],
);

assert.deepEqual(
  deriveWorkflowOperationColumnRequirements({
    id: "lineage",
    name: "Lineage",
    nodes: [{
      nodeType: "operation",
      id: "fit-operation",
      kind: "fitYByX",
      schemaVersion: "1",
      configuration: {
        sourceDatasetId: "table-1",
        response: { name: "yield", type: "continuous" },
        factor: { name: "batch", type: "nominal" },
      },
      inputPorts: [{ id: "fit-input", name: "source", payloadKind: "table" }],
      outputPorts: [],
    }],
    edges: [],
  }, ["fit-operation"]),
  [{
    operationId: "fit-operation",
    inputPortId: "fit-input",
    requiredColumnNames: ["batch", "yield"],
  }],
);

const layout = layoutWorkflowGraph(
  ["input", "operation", "output"],
  [
    { source: "input", target: "operation" },
    { source: "operation", target: "output" },
  ],
);
assert.ok(layout.positions.input.x < layout.positions.operation.x);
assert.ok(layout.positions.operation.x < layout.positions.output.x);
assert.equal(layout.positions.input.y, layout.positions.operation.y);
assert.equal(layout.width >= 700, true);

const projectTypes = readFileSync(
  new URL("../src/types/project.ts", import.meta.url),
  "utf8",
);

for (const field of ["workflows", "logicalFolders", "workflowRuns", "lineageGraph"]) {
  assert.match(projectTypes, new RegExp(`\\b${field}\\??:`));
}

const projectService = readFileSync(
  new URL("../src-tauri/src/services/project_service.rs", import.meta.url),
  "utf8",
);
const projectClient = readFileSync(
  new URL("../src/services/projectService.ts", import.meta.url),
  "utf8",
);

for (const field of ["workflows", "logical_folders", "workflow_runs", "lineage_graph"]) {
  assert.match(projectService, new RegExp(`pub ${field}:`));
}
for (const field of ["workflows", "logicalFolders", "workflowRuns"]) {
  assert.match(projectClient, new RegExp(`\\b${field}:`));
}

const projectCommands = readFileSync(
  new URL("../src-tauri/src/commands/project_commands.rs", import.meta.url),
  "utf8",
);
const tauriRegistry = readFileSync(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
const workspace = readFileSync(
  new URL("../src/components/Workspace.tsx", import.meta.url),
  "utf8",
);

assert.match(projectClient, /extractWorkflow:\s*\(request: WorkflowExtractionRequest\)/);
assert.match(projectClient, /invoke<WorkflowDefinition>\("extract_workflow", \{ request \}\)/);
assert.match(projectCommands, /pub fn extract_workflow\(/);
assert.match(tauriRegistry, /commands::project_commands::extract_workflow/);
assert.match(workspace, /const handleSaveWorkflowSelection = async/);
assert.match(workspace, /projectService\.extractWorkflow\(/);
assert.match(workspace, /dataService\.getColumnDisplayProps\(node\.documentRef\.id\)/);
assert.match(workspace, /columns:\s*mergeWorkflowTableColumns\(columns, displayProps\)/);
assert.match(workspace, /operationColumnRequirements:\s*deriveWorkflowOperationColumnRequirements\(/);
assert.match(workspace, /addWorkflow\(workflow\)/);
assert.match(
  workspace,
  /onSaveSelection=\{readOnly \? undefined : handleSaveWorkflowSelection\}/,
);

useWorkflowStore.getState().reset();
useWorkflowStore.getState().addWorkflow({
  id: "workflow-new",
  name: "New workflow",
  formatVersion: "1",
  revision: 1,
  inputSlots: [],
  operations: [],
  edges: [],
  outputDeclarations: [],
});
assert.equal(useWorkflowStore.getState().workflows[0]?.id, "workflow-new");
useWorkflowStore.getState().reset();