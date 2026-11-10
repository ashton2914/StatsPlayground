import type { ColumnDescriptor, TableWindowSort } from "../types/data";

export function reconcileTableSortIdentity(
  sort: TableWindowSort | null,
  previous: readonly ColumnDescriptor[],
  current: readonly ColumnDescriptor[],
): TableWindowSort | null {
  if (!sort) return null;
  const identity = previous.find(column => column.name === sort.column)?.columnId;
  const column = identity
    ? current.find(column => column.columnId === identity)
    : current.find(column => column.name === sort.column);
  if (!column) return null;
  return column.name === sort.column ? sort : { ...sort, column: column.name };
}
