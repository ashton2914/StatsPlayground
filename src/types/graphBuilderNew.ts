export type GraphNewXMode = "auto" | "numeric" | "time" | "duration" | "category";
export type GraphNewRawMode = "scatter" | "line" | "pointsLine";

export interface GraphBuilderNewSession {
  id: string;
  datasetId: string;
  datasetGeneration: number;
  xColumnId: string | null;
  yColumnId: string | null;
  showMean?: boolean;
  xMode?: GraphNewXMode;
  rawMode?: GraphNewRawMode;
}