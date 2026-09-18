export type GraphNewFrameFormat = "rgba8" | "png";

export interface GraphNewFrameIdentity {
  requestId: string;
  datasetGeneration: number;
  rendererGeneration: number;
  cameraGeneration: number;
}

export interface GraphNewFrameHeader extends GraphNewFrameIdentity {
  frameId: number;
  width: number;
  height: number;
  format: GraphNewFrameFormat;
  byteLength: number;
  readbackCompletedAtUnixMicros: number;
}

export interface GraphNewFrameToken extends GraphNewFrameIdentity {
  frameId: number;
}

export interface GraphNewFrame {
  header: GraphNewFrameHeader;
  payload: ArrayBuffer;
}

export interface GraphNewFrameMetrics {
  frameId: number;
  presentedAtMs: number;
}

export type GraphNewTransportEvent =
  | { type: "header"; header: GraphNewFrameHeader }
  | { type: "payload"; token: GraphNewFrameToken; payload: ArrayBuffer }
  | { type: "cancel"; cameraGeneration: number };