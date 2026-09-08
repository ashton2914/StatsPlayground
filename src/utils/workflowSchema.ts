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
      const requiredColumnNames = deriveRequiredColumnNames(node.kind, node.configuration);
      return node.inputPorts
        .filter((port) => port.payloadKind === "table" || port.payloadKind === "any")
        .map((port) => ({
          operationId: node.id,
          inputPortId: port.id,
          requiredColumnNames,
        }));
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId)
      || left.inputPortId.localeCompare(right.inputPortId));
}

function deriveRequiredColumnNames(
  operationKind: string,
  configuration: unknown,
): string[] {
  const config = asRecord(configuration);
  if (!config) return [];
  const names = new Set<string>();
  const addField = (value: unknown) => {
    const name = asRecord(value)?.name;
    if (typeof name === "string" && name.trim()) names.add(name);
  };
  const addStrings = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) names.add(item);
    }
  };

  if (operationKind === "graphGeneration") {
    collectGraphColumns(config, addField);
  } else if (operationKind === "fitYByX") {
    addField(config.response);
    addField(config.factor);
    const graph = asRecord(config.graph);
    if (graph) collectGraphColumns(graph, addField);
  } else if (operationKind === "tabulate") {
    addStrings(config.rowFields);
    addStrings(config.columnFields);
    if (Array.isArray(config.statistics)) {
      for (const statistic of config.statistics) {
        const field = asRecord(statistic)?.field;
        if (typeof field === "string" && field.trim()) names.add(field);
      }
    }
  }

  return [...names].sort();
}

function collectGraphColumns(
  config: Record<string, unknown>,
  addField: (value: unknown) => void,
): void {
  const modeStates = asRecord(config.modeStates);
  const modeKey = config.mode === "3d"
    ? "threeD"
    : config.mode === "multivariate" ? "multivariate" : "twoD";
  const state = asRecord(modeStates?.[modeKey]);
  const encoding = asRecord(state?.encoding);
  for (const field of Object.values(encoding ?? {})) addField(field);
  for (const key of ["multiX", "multiY", "columns"] as const) {
    const fields = state?.[key];
    if (Array.isArray(fields)) fields.forEach(addField);
  }
  if (Array.isArray(config.filters)) {
    for (const item of config.filters) addField(asRecord(asRecord(item)?.rule)?.field);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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