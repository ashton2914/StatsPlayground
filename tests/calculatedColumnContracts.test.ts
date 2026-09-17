import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  CalculatedColumnDescriptor,
  CalculatedColumnDiagnostic,
  CalculatedColumnMutationResult,
  CalculatedColumnStatus,
  CalculatedColumnValidation,
  CalculatedExpressionV1,
  CalculatedOutputTypeV1,
  ValidateCalculatedColumnRequest,
  UpsertCalculatedColumnRequest,
  ColumnDescriptor,
} from "../src/types/data.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readRelative(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const commandSource = readRelative("src-tauri/src/commands/calculated_column_commands.rs");
const modSource = readRelative("src-tauri/src/commands/mod.rs");
const libSource = readRelative("src-tauri/src/lib.rs");
const serviceSource = readRelative("src/services/dataService.ts");
const dataTypesSource = readRelative("src/types/data.ts");

for (const commandName of [
  "validate_calculated_column",
  "upsert_calculated_column",
  "convert_calculated_column_to_values",
]) {
  assert.match(commandSource, new RegExp(`pub fn ${commandName}\\b`));
  assert.match(modSource, /pub mod calculated_column_commands;/);
  assert.match(
    libSource,
    new RegExp(`commands::calculated_column_commands::${commandName}`),
  );
}

assert.match(serviceSource, /validateCalculatedColumn:\s*\(request:\s*ValidateCalculatedColumnRequest\)\s*=>\s*invoke<CalculatedColumnValidation>\("validate_calculated_column",\s*\{\s*request\s*\}\)/s);
assert.match(serviceSource, /upsertCalculatedColumn:\s*\(request:\s*UpsertCalculatedColumnRequest\)\s*=>\s*invoke<CalculatedColumnMutationResult>\("upsert_calculated_column",\s*\{\s*request\s*\}\)/s);
assert.match(serviceSource, /convertCalculatedColumnToValues:\s*\(datasetId:\s*string,\s*columnId:\s*string,\s*expectedGeneration:\s*number\)\s*=>\s*invoke<CalculatedColumnMutationResult>\("convert_calculated_column_to_values",\s*\{\s*datasetId,\s*columnId,\s*expectedGeneration,\s*\}\)/s);

assert.doesNotMatch(serviceSource, /pre-conversion descriptor/i);
assert.match(
  dataTypesSource,
  /export type CalculatedNumberV1 = number;/,
  "CalculatedNumberV1 must mirror the persisted schemaVersion 1 JSON number literal exactly",
);
assert.doesNotMatch(
  dataTypesSource,
  /kind:\s*"integer"|kind:\s*"float"/,
  "TypeScript must not model schemaVersion 1 numbers as tagged integer\/float objects",
);

const validateRequest: ValidateCalculatedColumnRequest = {
  datasetId: "dataset-1",
  outputName: "Rounded Length",
  formulaText: "ROUND([Length], 2)",
  atIndex: 3,
  outputColumnId: "output-1",
  formulaId: "formula-1",
  expectedGeneration: 7,
};
assert.deepEqual(Object.keys(validateRequest), [
  "datasetId",
  "outputName",
  "formulaText",
  "atIndex",
  "outputColumnId",
  "formulaId",
  "expectedGeneration",
]);

const upsertRequest: UpsertCalculatedColumnRequest = {
  datasetId: validateRequest.datasetId,
  outputName: validateRequest.outputName,
  formulaText: validateRequest.formulaText,
  atIndex: validateRequest.atIndex,
  outputColumnId: validateRequest.outputColumnId,
  formulaId: validateRequest.formulaId,
  expectedGeneration: validateRequest.expectedGeneration,
};
assert.deepEqual(Object.keys(upsertRequest), [
  "datasetId",
  "outputName",
  "formulaText",
  "atIndex",
  "outputColumnId",
  "formulaId",
  "expectedGeneration",
]);

const statuses = [
  "draft",
  "ready",
  "disabled",
  "broken",
  "unsupported",
] as const satisfies readonly CalculatedColumnStatus[];
assert.deepEqual(statuses, ["draft", "ready", "disabled", "broken", "unsupported"]);

const outputTypes = [
  "boolean",
  "continuous",
  "integer",
  "null",
  "text",
  "unknown",
] as const satisfies readonly CalculatedOutputTypeV1[];
assert.deepEqual(outputTypes, ["boolean", "continuous", "integer", "null", "text", "unknown"]);

const expression: CalculatedExpressionV1 = {
  kind: "function",
  function: "round",
  arguments: [
    { kind: "columnRef", columnId: "length-id" },
    { kind: "numberLiteral", value: 2 },
  ],
};
assert.equal(expression.kind, "function");

const persistedNumber = expression.arguments[1];
assert.deepEqual(persistedNumber, {
  kind: "numberLiteral",
  value: 2,
});

const descriptor: CalculatedColumnDescriptor = {
  formulaId: "formula-1",
  schemaVersion: "1",
  outputColumnId: "output-1",
  displayFormulaText: "ROUND([Length], 2)",
  status: "ready",
  dependencyColumnIds: ["length-id"],
  inferredOutputType: "continuous",
  fingerprint: "3cd67180ea1eb30ab80b1923231a94f3a9e15a9d5b14f034b7d128393874ad0b",
};

const mutation: CalculatedColumnMutationResult = {
  columnId: "output-1",
  datasetGeneration: 8,
  changeSetId: "change-set-1",
  calculated: descriptor,
  diagnostics: undefined,
  warningCount: {
    total: 0,
    expression: 0,
    dependencyGraph: 0,
    validation: 0,
  },
};
assert.equal(mutation.columnId, "output-1");
assert.equal(mutation.datasetGeneration, 8);
assert.equal(mutation.changeSetId, "change-set-1");
assert.equal(mutation.calculated?.outputColumnId, "output-1");

const validation: CalculatedColumnValidation = {
  status: "ready",
  diagnostics: undefined,
  warningCount: mutation.warningCount,
  definition: {
    formulaId: "formula-1",
    schemaVersion: "1",
    outputColumnId: "output-1",
    expression,
    dependencyColumnIds: ["length-id"],
    inferredOutputType: "continuous",
    fingerprint: "3cd67180ea1eb30ab80b1923231a94f3a9e15a9d5b14f034b7d128393874ad0b",
  },
};
assert.equal(validation.definition.expression.kind, "function");

const emptyDiagnostic: CalculatedColumnDiagnostic = {
  level: "warning",
  code: "none",
  message: "no related ids",
};
assert.equal(emptyDiagnostic.relatedColumnIds, undefined);

const populatedDiagnostic: CalculatedColumnDiagnostic = {
  level: "error",
  code: "dependencyMissing",
  message: "column missing",
  relatedColumnIds: ["length-id"],
};
assert.deepEqual(populatedDiagnostic.relatedColumnIds, ["length-id"]);

const plainDescriptor: ColumnDescriptor = {
  columnId: "column-1",
  name: "Length",
  sqlType: "DOUBLE",
  calculated: descriptor,
};
assert.equal(plainDescriptor.calculated?.status, "ready");

const legacyStatus: CalculatedColumnStatus = "broken";
assert.equal(legacyStatus, "broken");

console.log("Calculated column contracts passed");