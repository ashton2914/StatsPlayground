export interface GraphNewTransportGateInput {
  width: number;
  height: number;
  readbackToPresentP95Ms: number;
  compositorFpsP95: number;
  compositorFrameTimeP95Ms: number;
  longestAvoidableMainThreadTaskMs: number;
  maximumQueueDepth: number;
  usedTextPixelEncoding: boolean;
  tornOrStaleFrames: number;
}

export interface GraphNewTransportGateVerdict {
  pass: boolean;
  failedBudgets: Array<keyof GraphNewTransportGateInput>;
}

export interface GraphNewTransportSample {
  frameId: number;
  renderMs: number;
  readbackMs: number;
  transferMs: number;
  decodeMs: number;
  presentMs: number;
  readbackToPresentMs: number;
  payloadBytes: number;
}

export interface GraphNewTransportStageSummary {
  p50: number;
  p95: number;
  max: number;
}

export interface GraphNewTransportResolutionReport {
  width: number;
  height: number;
  framesRequested: number;
  framesSent: number;
  framesPresented: number;
  rustFrameHz: number;
  compositorFpsP95: number;
  compositorFrameTimeP95Ms: number;
  longestAvoidableMainThreadTaskMs: number;
  payloadBytes: number;
  peakTransportBytes: number;
  peakResidentFrameBuffers: number;
  peakResidentFrameBytes: number;
  maximumQueueDepth: number;
  droppedSupersededFrames: number;
  usedTextPixelEncoding: boolean;
  tornOrStaleFrames: number;
  stages: {
    renderMs: GraphNewTransportStageSummary;
    readbackMs: GraphNewTransportStageSummary;
    transferMs: GraphNewTransportStageSummary;
    decodeMs: GraphNewTransportStageSummary;
    presentMs: GraphNewTransportStageSummary;
    readbackToPresentMs: GraphNewTransportStageSummary;
  };
  samples: GraphNewTransportSample[];
}

export interface GraphNewTransportReportV1 {
  version: 1;
  generatedAt: string;
  userAgent: string;
  transport: "tauri-channel-raw-rgba8-pull";
  resolutions: GraphNewTransportResolutionReport[];
  gate: GraphNewTransportGateVerdict;
}

export function percentile(values: readonly number[], rank: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function summarizeStage(
  values: readonly number[],
): GraphNewTransportStageSummary {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

export function evaluateGraphNewTransportGate(
  input: GraphNewTransportGateInput,
): GraphNewTransportGateVerdict {
  const failedBudgets: Array<keyof GraphNewTransportGateInput> = [];
  const failWhen = (
    field: keyof GraphNewTransportGateInput,
    condition: boolean,
  ): void => {
    if (condition) failedBudgets.push(field);
  };

  failWhen("width", input.width !== 3840);
  failWhen("height", input.height !== 2160);
  failWhen(
    "readbackToPresentP95Ms",
    !Number.isFinite(input.readbackToPresentP95Ms)
      || input.readbackToPresentP95Ms > 100,
  );
  failWhen(
    "compositorFpsP95",
    !Number.isFinite(input.compositorFpsP95) || input.compositorFpsP95 < 55,
  );
  failWhen(
    "compositorFrameTimeP95Ms",
    !Number.isFinite(input.compositorFrameTimeP95Ms)
      || input.compositorFrameTimeP95Ms > 18,
  );
  failWhen(
    "longestAvoidableMainThreadTaskMs",
    !Number.isFinite(input.longestAvoidableMainThreadTaskMs)
      || input.longestAvoidableMainThreadTaskMs > 50,
  );
  failWhen("maximumQueueDepth", input.maximumQueueDepth > 1);
  failWhen("usedTextPixelEncoding", input.usedTextPixelEncoding);
  failWhen("tornOrStaleFrames", input.tornOrStaleFrames !== 0);

  return { pass: failedBudgets.length === 0, failedBudgets };
}