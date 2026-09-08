import type {
  SchemaContract,
  SchemaValidationReport,
} from "@/types/workflow";

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
  actualColumns: Array<[string, string]>,
): SchemaValidationReport {
  const actualByName = new Map(
    actualColumns.map(([name, type]) => [name, canonicalDuckdbType(type)]),
  );
  const requiredColumns = contract.columns.filter((column) => column.required);
  const requiredNames = new Set(requiredColumns.map((column) => column.name));
  const missingColumns: SchemaValidationReport["missingColumns"] = [];
  const typeMismatches: SchemaValidationReport["typeMismatches"] = [];

  for (const column of requiredColumns) {
    const expectedType = canonicalDuckdbType(column.canonicalDuckdbType);
    const actualType = actualByName.get(column.name);
    if (actualType === undefined) {
      missingColumns.push({
        columnName: column.name,
        expectedType,
        actualType: "",
        affectedOperationIds: column.requiredByOperationIds,
      });
    } else if (actualType !== expectedType) {
      typeMismatches.push({
        columnName: column.name,
        expectedType,
        actualType,
        affectedOperationIds: column.requiredByOperationIds,
      });
    }
  }

  return {
    missingColumns,
    typeMismatches,
    extraColumns: actualColumns
      .map(([name]) => name)
      .filter((name) => !requiredNames.has(name))
      .sort(),
  };
}

export function isSchemaValidationBlocking(report: SchemaValidationReport): boolean {
  return report.missingColumns.length > 0 || report.typeMismatches.length > 0;
}