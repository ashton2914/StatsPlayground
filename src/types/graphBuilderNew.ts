export type GraphNewXMode = "auto" | "numeric" | "time" | "duration" | "category";
export type GraphNewRawMode = "scatter" | "line" | "pointsLine";

export interface GraphBuilderNewCamera {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GraphBuilderNewDocument {
  version: 1;
  id: string;
  name: string;
  datasetId: string;
  xColumnId: string | null;
  yColumnId: string | null;
  showMean: boolean;
  xMode: GraphNewXMode;
  rawMode: GraphNewRawMode;
  camera: GraphBuilderNewCamera | null;
}

export interface GraphBuilderNewSession {
  id: string;
  transportId: string;
  runtimeEpoch?: number;
  version?: 1;
  name?: string;
  camera?: GraphBuilderNewCamera | null;
  datasetId: string;
  datasetGeneration: number;
  xColumnId: string | null;
  yColumnId: string | null;
  showMean?: boolean;
  xMode?: GraphNewXMode;
  rawMode?: GraphNewRawMode;
}