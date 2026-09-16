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

const tableCreateColumns = [
  {
    name: "value",
    sqlType: "DOUBLE",
    display: {
      width: 144,
      format: { kind: "fixed", decimals: 2 },
      extras: {
        unit: { symbol: "mm" },
        spec: { lsl: 1.2, target: 2.4, usl: 3.6 },
        notes: { text: "critical" },
      },
    },
  },
  {
    name: "build",
    sqlType: "VARCHAR",
    display: {
      width: 120,
      format: { kind: "asis" },
      extras: { valueOrder: { values: ["EV", "DV", "PQ"] } },
    },
  },
] as const;

const normalizedColumns = JSON.parse(JSON.stringify(tableCreateColumns));
assert.deepEqual(normalizedColumns, tableCreateColumns);
assert.equal(normalizedColumns[0].sqlType, "DOUBLE");
assert.equal(normalizedColumns[1].sqlType, "VARCHAR");
assert.equal(normalizedColumns[0].display.width, 144);
assert.deepEqual(normalizedColumns[0].display.format, { kind: "fixed", decimals: 2 });
assert.deepEqual(normalizedColumns[0].display.extras.spec, { lsl: 1.2, target: 2.4, usl: 3.6 });
assert.deepEqual(normalizedColumns.map((column) => column.name), ["value", "build"]);