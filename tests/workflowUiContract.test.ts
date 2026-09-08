import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isSchemaValidationBlocking,
  validateWorkflowInputSchema,
} from "../src/utils/workflowSchema.ts";
import { layoutWorkflowGraph } from "../src/utils/workflowLayout.ts";
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