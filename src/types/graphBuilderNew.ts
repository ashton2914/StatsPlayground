export type GraphNewXMode = "auto" | "numeric" | "time" | "duration" | "category";
export type GraphNewRawMode = "scatter" | "line" | "pointsLine";

export interface GraphBuilderNewCamera {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GraphBuilderNewDocumentV1 {
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

export interface GraphBuilderNewDocument {
  version: 2;
  id: string;
  name: string;
  datasetId: string;
  xColumnId: string | null;
  yColumnId: string | null;
  overlayColumnId: string | null;
  hiddenOverlayGroupIds: string[];
  showMean: boolean;
  xMode: GraphNewXMode;
  rawMode: GraphNewRawMode;
  camera: GraphBuilderNewCamera | null;
}

export type PersistedGraphBuilderNewDocument =
  | GraphBuilderNewDocumentV1
  | GraphBuilderNewDocument;

export interface GraphBuilderNewSession {
  id: string;
  transportId: string;
  runtimeEpoch?: number;
  version?: 2;
  name?: string;
  camera?: GraphBuilderNewCamera | null;
  datasetId: string;
  datasetGeneration: number;
  xColumnId: string | null;
  yColumnId: string | null;
  overlayColumnId: string | null;
  hiddenOverlayGroupIds: string[];
  showMean?: boolean;
  xMode?: GraphNewXMode;
  rawMode?: GraphNewRawMode;
}