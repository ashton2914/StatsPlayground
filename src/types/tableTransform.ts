import type { SchemaContract } from "./workflow";

export interface TableTransformDefinition {
  id: string;
  name: string;
  formatVersion: string;
  revision: number;
  operation: TableTransformOperation;
  inputSlots: TableTransformInputSlot[];
  output: TableTransformOutput;
}

export interface TableTransformInputSlot {
  role: string;
  schemaContract: SchemaContract;
}

export interface TableTransformOutput {
  tableDocumentId: string;
  name: string;
}

export type SortDirection = "ascending" | "descending";

export interface SortColumn {
  column: string;
  direction: SortDirection;
}

export type SummaryStatistic =
  | "n"
  | "mean"
  | "std"
  | "min"
  | "max"
  | "sum"
  | "median";

export type JoinType = "inner" | "left" | "right" | "full";

export type TableTransformOperation =
  | { kind: "sort"; sortColumns: SortColumn[] }
  | {
      kind: "subset";
      columns: string[];
      filter?: TableFilterExpression;
    }
  | { kind: "transpose" }
  | { kind: "stack"; stackColumns: string[]; idColumns: string[] }
  | {
      kind: "split";
      splitColumn: string;
      valueColumn: string;
      idColumns: string[];
    }
  | {
      kind: "summary";
      statisticColumns: string[];
      groupColumns: string[];
      statistics: SummaryStatistic[];
    }
  | {
      kind: "join";
      joinType: JoinType;
      leftKey: string;
      rightKey: string;
    }
  | { kind: "update"; matchColumn: string; updateColumns: string[] }
  | { kind: "concatenate"; sourceCount: number };

export type TableFilterExpression =
  | {
      kind: "logical";
      operator: TableFilterLogicalOperator;
      left: TableFilterExpression;
      right: TableFilterExpression;
    }
  | { kind: "not"; expression: TableFilterExpression }
  | {
      kind: "comparison";
      column: string;
      operator: TableFilterComparisonOperator;
      value: TableFilterScalar;
    }
  | { kind: "isNull"; column: string; negated: boolean };

export type TableFilterLogicalOperator = "and" | "or";

export type TableFilterComparisonOperator =
  | "equal"
  | "notEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual";

export type TableFilterScalar =
  | { type: "string"; value: string }
  | { type: "number"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "null" };