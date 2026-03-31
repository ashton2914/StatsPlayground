/** Column format snapshot info */
export interface SnapshotColumnFormat {
  kind: string;
  decimals?: number;
  currency?: string;
}

/** Single column in a snapshot */
export interface SnapshotColumn {
  name: string;
  colType: string;
  width?: number;
  format?: SnapshotColumnFormat;
}

/** Single dataset in a snapshot */
export interface SnapshotDataset {
  id: string;
  name: string;
  sourceType: string;
  columns: SnapshotColumn[];
  rows: unknown[][];
}

/** Full project data snapshot */
export interface ProjectDataSnapshot {
  datasets: SnapshotDataset[];
}

/** A single history entry — stores the dataset state AFTER this operation */
export interface HistoryEntry {
  id: string;
  timestamp: string;
  description: string;
  /** Opaque dataset state snapshot taken after this operation (for undo/redo) */
  afterState?: unknown;
}

/** A named snapshot (bookmark) — full state capture */
export interface NamedSnapshot {
  id: string;
  name: string;
  timestamp: string;
  snapshot: ProjectDataSnapshot;
}
