import type {
  ProjectLineageGraph,
  SchemaContract,
  SchemaValidationReport,
  WorkflowOperationInputSchema,
  WorkflowTableColumn,
} from "@/types/workflow";
import type { ColumnDisplayProps } from "@/types/data";

export function mergeWorkflowTableColumns(
  columns: Array<[string, string]>,
  displayProps: ColumnDisplayProps[],
): WorkflowTableColumn[] {
  const propsByIndex = new Map(displayProps.map((props) => [props.colIndex, props]));
  return columns.map(([name, colType], colIndex) => {
    const extras = propsByIndex.get(colIndex)?.extras;
    return {
      name,
      colType,
      ...(extras ? { extras } : {}),
    };
  });
}

export function deriveWorkflowOperationColumnRequirements(
  graph: ProjectLineageGraph,
  selectedNodeIds: readonly string[],
): WorkflowOperationInputSchema[] {
  const selected = new Set(selectedNodeIds);
  return graph.nodes
    .flatMap((node) => {
      if (node.nodeType !== "operation" || !selected.has(node.id)) return [];
      return node.inputPorts
        .filter((port) => port.payloadKind === "table" || port.payloadKind === "any")
        .map((port) => {
          if (!port.tableRequirement) {
            throw new Error(`Cannot determine required columns for operation ${node.id} input ${port.id}`);
          }
          return {
            operationId: node.id,
            inputPortId: port.id,
            columns: port.tableRequirement.columns.map((column) => ({
              name: column.name,
              requiredExtraKinds: [...column.requiredExtraKinds].sort(),
            })),
            completeSchema: port.tableRequirement.completeSchema,
          };
        });
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId)
      || left.inputPortId.localeCompare(right.inputPortId));
}

export function canonicalDuckdbType(rawType: string): string {
  const normalized = rawType.trim().replace(/\s+/g, " ").toUpperCase();
  const aliases: Record<string, string> = {
    INT: "INTEGER",
    SIGNED: "INTEGER",
    INT4: "INTEGER",
    INT8: "BIGINT",
    LONG: "BIGINT",
    INT2: "SMALLINT",
    INT1: "TINYINT",
    "DOUBLE PRECISION": "DOUBLE",
    FLOAT8: "DOUBLE",
    FLOAT4: "REAL",
    BOOL: "BOOLEAN",
    "CHARACTER VARYING": "VARCHAR",
    TEXT: "VARCHAR",
    STRING: "VARCHAR",
  };
  return aliases[normalized] ?? normalized;
}

export function validateWorkflowInputSchema(
  contract: SchemaContract,
  actualColumns: Array<[string, string] | WorkflowTableColumn>,
): SchemaValidationReport {
  const normalizedColumns = actualColumns.map((column) => Array.isArray(column)
    ? { name: column[0], colType: column[1] }
    : column);
  const actualByName = new Map(
    normalizedColumns.map((column) => [column.name, column]),
  );
  const requiredColumns = contract.columns.filter((column) => column.required);
  const requiredNames = new Set(requiredColumns.map((column) => column.name));
  const missingColumns: SchemaValidationReport["missingColumns"] = [];
  const typeMismatches: SchemaValidationReport["typeMismatches"] = [];
  const attributeMismatches: SchemaValidationReport["attributeMismatches"] = [];

  for (const column of requiredColumns) {
    const expectedType = canonicalDuckdbType(column.canonicalDuckdbType);
    const actualColumn = actualByName.get(column.name);
    if (actualColumn === undefined) {
      missingColumns.push({
        columnName: column.name,
        expectedType,
        actualType: "",
        affectedOperationIds: column.requiredByOperationIds,
      });
    } else if (canonicalDuckdbType(actualColumn.colType) !== expectedType) {
      typeMismatches.push({
        columnName: column.name,
        expectedType,
        actualType: canonicalDuckdbType(actualColumn.colType),
        affectedOperationIds: column.requiredByOperationIds,
      });
    } else {
      for (const [kind, expectedValue] of Object.entries(column.requiredExtras ?? {})) {
        const hasActualValue = Object.prototype.hasOwnProperty.call(actualColumn.extras ?? {}, kind);
        const actualValue = actualColumn.extras?.[kind];
        if (!hasActualValue || canonicalJson(actualValue) !== canonicalJson(expectedValue)) {
          attributeMismatches.push({
            columnName: column.name,
            attributeName: `extras.${kind}`,
            expectedValue,
            ...(hasActualValue ? { actualValue } : {}),
            affectedOperationIds: column.requiredByOperationIds,
          });
        }
      }
    }
  }

  return {
    missingColumns,
    typeMismatches,
    attributeMismatches,
    extraColumns: normalizedColumns
      .map((column) => column.name)
      .filter((name) => !requiredNames.has(name))
      .sort(),
  };
}

export function isSchemaValidationBlocking(report: SchemaValidationReport): boolean {
  return report.missingColumns.length > 0
    || report.typeMismatches.length > 0
    || report.attributeMismatches.length > 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}