const NUMERIC_DUCKDB_TYPES = new Set([
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "HUGEINT",
  "UHUGEINT",
  "FLOAT",
  "REAL",
  "DOUBLE",
  "DECIMAL",
  "NUMERIC",
]);

export function isNumericDuckDbType(dataType: string): boolean {
  return NUMERIC_DUCKDB_TYPES.has(dataType.trim().toUpperCase().split("(", 1)[0]);
}

export function canExportTabulateResult(
  resultReady: boolean,
  requestCurrent: boolean,
  loading: boolean,
  readOnly: boolean,
  exporting: boolean,
): boolean {
  return resultReady && requestCurrent && !loading && !readOnly && !exporting;
}

export function parseQuantileInput(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

export function reorderForDrop<T>(items: readonly T[], from: number, target: number): T[] {
  if (from < 0 || from >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [entry] = next.splice(from, 1);
  const boundedTarget = Math.max(0, Math.min(items.length, target));
  const insertionIndex = from < boundedTarget ? boundedTarget - 1 : boundedTarget;
  next.splice(insertionIndex, 0, entry);
  return next;
}

type TabulateAssignmentRole = "rows" | "columns" | "statistics";

export function canAssignTabulateField(
  role: TabulateAssignmentRole,
  currentFields: readonly string[],
  fieldName: string,
): boolean {
  if (role === "rows") {
    return currentFields.length === 0 && !currentFields.includes(fieldName);
  }
  if (role === "columns") {
    return !currentFields.includes(fieldName);
  }
  return true;
}