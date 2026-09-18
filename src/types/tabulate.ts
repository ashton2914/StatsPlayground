export type TabulateStatisticKind =
  | "count"
  | "missingCount"
  | "uniqueCount"
  | "sum"
  | "mean"
  | "standardDeviation"
  | "variance"
  | "minimum"
  | "maximum"
  | "median"
  | "range"
  | "quantile"
  | "rowPercentage"
  | "columnPercentage"
  | "totalPercentage";

export interface TabulateStatistic {
  id: string;
  field: string;
  kind: TabulateStatisticKind;
  quantile?: number;
}

export interface TabulateItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  rowFields: string[];
  columnFields: string[];
  statistics: TabulateStatistic[];
  includeRowTotals: boolean;
  includeColumnTotals: boolean;
  createdAt: string;
}

export interface TabulateSessionRequest {
  datasetId: string;
  sourceGeneration: number;
  rowFields: string[];
  columnFields: string[];
  statistics: TabulateStatistic[];
  includeRowTotals: boolean;
  includeColumnTotals: boolean;
}

export type TabulateSessionState = "preparing" | "ready" | "cancelled" | "failed";

export interface TabulateSessionStatus {
  sessionId: string;
  fingerprint: string;
  sourceGeneration: number;
  state: TabulateSessionState;
  rowMemberCount: number;
  columnMemberCount: number;
  logicalCellCount: number;
  measuredMemberIndexBytes: number;
  failureCode?: string;
}

export interface TabulateWindowRequest {
  requestId: string;
  sessionId: string;
  sourceGeneration: number;
  rowStart: number;
  rowCount: number;
  columnStart: number;
  columnCount: number;
}

export interface TabulateSparseCell {
  rowIndex: number;
  columnIndex: number;
  statisticIndex: number;
  value: number | null;
}

export interface TabulateWindowResult {
  sessionId: string;
  requestId: string;
  fingerprint: string;
  sourceGeneration: number;
  rowStart: number;
  columnStart: number;
  rowMembers: unknown[][];
  columnMembers: unknown[][];
  rowMemberBefore: unknown[] | null;
  rowMemberAfter: unknown[] | null;
  columnMemberBefore: unknown[] | null;
  columnMemberAfter: unknown[] | null;
  statistics: TabulateStatistic[];
  cells: TabulateSparseCell[];
  rowTotalsReady: boolean;
  columnTotalsReady: boolean;
  rowMemberCount: number;
  columnMemberCount: number;
}

export type TabulateTotalsKind =
  | { kind: "rows"; start: number; count: number }
  | { kind: "columns"; start: number; count: number }
  | { kind: "grand" };

export interface TabulateTotalsRequest {
  requestId: string;
  sessionId: string;
  sourceGeneration: number;
  totals: TabulateTotalsKind;
}

export interface TabulateSparseTotal {
  memberIndex: number;
  statisticIndex: number;
  value: number | null;
}

export interface TabulateTotalsResult {
  sessionId: string;
  requestId: string;
  fingerprint: string;
  sourceGeneration: number;
  totals: TabulateTotalsKind;
  rowTotals: TabulateSparseTotal[];
  columnTotals: TabulateSparseTotal[];
  grandTotals: Array<number | null>;
}

export interface TabulateMaterializeRequest {
  sessionId: string;
  sourceGeneration: number;
  fingerprint: string;
  destinationName: string;
  missingLabel: string;
  statisticLabels: string[];
}