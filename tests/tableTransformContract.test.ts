import assert from "node:assert/strict";

import type {
  TableFilterExpression,
  TableTransformDefinition,
  TableTransformOperation,
} from "../src/types/tableTransform.ts";
import type {
  OperationKind,
  ProjectDocumentKind,
} from "../src/types/workflow.ts";

const filter: TableFilterExpression = {
  kind: "logical",
  operator: "and",
  left: {
    kind: "comparison",
    column: "age",
    operator: "greaterThanOrEqual",
    value: { type: "number", value: "18" },
  },
  right: {
    kind: "comparison",
    column: "status",
    operator: "equal",
    value: { type: "string", value: "active" },
  },
};

const operations: TableTransformOperation[] = [
  {
    kind: "sort",
    sortColumns: [{ column: "value", direction: "ascending" }],
  },
  { kind: "subset", columns: ["value"], filter },
  { kind: "transpose" },
  { kind: "stack", stackColumns: ["value"], idColumns: ["id"] },
  {
    kind: "split",
    splitColumn: "label",
    valueColumn: "value",
    idColumns: ["id"],
  },
  {
    kind: "summary",
    statisticColumns: ["value"],
    groupColumns: ["group"],
    statistics: ["mean"],
  },
  { kind: "join", joinType: "inner", leftKey: "id", rightKey: "id" },
  { kind: "update", matchColumn: "id", updateColumns: ["value"] },
  { kind: "concatenate", sourceCount: 3 },
];

const definition: TableTransformDefinition = {
  id: "transform-1",
  name: "Reusable transform",
  formatVersion: "1",
  revision: 1,
  operation: operations[0],
  inputSlots: [
    {
      role: "source",
      schemaContract: {
        schemaFingerprint: "fingerprint",
        columns: [
          {
            name: "value",
            canonicalDuckdbType: "DOUBLE",
            required: true,
            requiredByOperationIds: ["table-transform"],
          },
        ],
      },
    },
  ],
  output: {
    tableDocumentId: "output-table-1",
    name: "Transformed table",
  },
};

const documentKind: ProjectDocumentKind = "tableTransform";
const operationKind: OperationKind = "tableTransform";
const serialized = JSON.parse(JSON.stringify(definition));

assert.equal(operations.length, 9);
assert.deepEqual(
  operations.map((operation) => operation.kind),
  [
    "sort",
    "subset",
    "transpose",
    "stack",
    "split",
    "summary",
    "join",
    "update",
    "concatenate",
  ],
);
assert.equal(documentKind, "tableTransform");
assert.equal(operationKind, "tableTransform");
assert.equal(serialized.operation.sortColumns[0].direction, "ascending");
assert.equal(serialized.output.tableDocumentId, "output-table-1");
assert.equal("tableDocumentId" in serialized.inputSlots[0], false);