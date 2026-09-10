export interface PropertyTableLayout {
  keyColumnName: string;
  keyColumnIndex: number;
  propertyColumnNames: string[];
}

export function resolvePropertyTableLayout(
  allColumns: string[],
  columnNameHeader: string,
): PropertyTableLayout | null {
  const visibleColumns = allColumns.filter((column) => column !== "_row_id");
  const keyColumnIndex = allColumns.indexOf(columnNameHeader);
  if (keyColumnIndex < 0) return null;

  return {
    keyColumnName: columnNameHeader,
    keyColumnIndex,
    propertyColumnNames: visibleColumns.filter((column) => column !== columnNameHeader),
  };
}