import { useEffect, useRef, useState } from "react";

import {
  evaluateGraphNewTransportGate,
  percentile,
  summarizeStage,
  type GraphNewTransportReportV1,
  type GraphNewTransportResolutionReport,
  type GraphNewTransportSample,
} from "./graphNewTransportMetrics";
import {
  graphNewService,
  type GraphNewProbeController,
  type GraphNewTransportProbeCompletion,
} from "../services/graphNewService";
import type { GraphNewFrame, GraphNewFrameToken } from "../types/graphNew";

const FRAMES_PER_RESOLUTION = 30;
const RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 3840, height: 2160 },
] as const;
const BACKGROUND_RGBA = [248, 250, 252, 255] as const;

interface FramePresentation {
  transferMs: number;
  decodeMs: number;
  presentMs: number;
  readbackToPresentMs: number;
  payloadBytes: number;
  synchronousTaskMs: number;
}

function frameToken(frame: GraphNewFrame): GraphNewFrameToken {
  return {
    requestId: frame.header.requestId,
    datasetGeneration: frame.header.datasetGeneration,
    rendererGeneration: frame.header.rendererGeneration,
    cameraGeneration: frame.header.cameraGeneration,
    frameId: frame.header.frameId,
  };
}

function hasCoherentCorners(frame: GraphNewFrame): boolean {
  const pixels = new Uint8Array(frame.payload);
  const { width, height } = frame.header;
  const offsets = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    ((height * width) - 1) * 4,
  ];
  return offsets.every((offset) => BACKGROUND_RGBA.every(
    (channel, channelIndex) => pixels[offset + channelIndex] === channel,
  ));
}

function nextAnimationFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function presentFrame(
  frame: GraphNewFrame,
  controller: GraphNewProbeController,
  context: CanvasRenderingContext2D,
  canvasHasFrame: boolean,
  onBufferState: (rawBuffers: number, decodedBuffers: number, canvasBuffers: number) => void,
): Promise<FramePresentation> {
  const transferMs = Math.max(
    0,
    (Date.now() * 1_000 - frame.header.readbackCompletedAtUnixMicros) / 1_000,
  );
  onBufferState(1, 0, canvasHasFrame ? 1 : 0);
  if (!hasCoherentCorners(frame)) {
    throw new Error(`graph-new frame ${frame.header.frameId} failed corner coherence`);
  }

  const decodeStartedAt = performance.now();
  const imageDataStartedAt = performance.now();
  const imageData = new ImageData(
    new Uint8ClampedArray(frame.payload),
    frame.header.width,
    frame.header.height,
  );
  const imageDataTaskMs = performance.now() - imageDataStartedAt;
  const bitmap = await createImageBitmap(imageData);
  const decodeMs = performance.now() - decodeStartedAt;
  onBufferState(1, 1, canvasHasFrame ? 1 : 0);

  await nextAnimationFrame();
  const token = frameToken(frame);
  if (!controller.canPresent(token)) {
    bitmap.close();
    throw new Error(`graph-new frame ${frame.header.frameId} became stale before presentation`);
  }
  const drawStartedAt = performance.now();
  context.drawImage(bitmap, 0, 0);
  const drawTaskMs = performance.now() - drawStartedAt;
  bitmap.close();
  onBufferState(1, 0, 1);
  const presentedAt = await nextAnimationFrame();
  controller.markPresented(token, presentedAt);

  return {
    transferMs,
    decodeMs,
    presentMs: presentedAt - drawStartedAt,
    readbackToPresentMs: Math.max(
      0,
      (performance.timeOrigin + presentedAt)
        - (frame.header.readbackCompletedAtUnixMicros / 1_000),
    ),
    payloadBytes: frame.payload.byteLength,
    synchronousTaskMs: Math.max(imageDataTaskMs, drawTaskMs),
  };
}

async function runResolution(
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
  transformHost: HTMLDivElement,
  setStatus: (status: string) => void,
): Promise<GraphNewTransportResolutionReport> {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("2D canvas is unavailable");

  const longTasks: number[] = [];
  const observer = typeof PerformanceObserver === "undefined"
    ? null
    : new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
  try {
    observer?.observe({ entryTypes: ["longtask"] });
  } catch {
    observer?.disconnect();
  }

  const compositorFrameTimes: number[] = [];
  let previousAnimationFrame: number | null = null;
  let animationFrame = 0;
  let animationRunning = true;
  const animateTransform = (timestamp: number): void => {
    if (!animationRunning) return;
    if (previousAnimationFrame !== null) {
      compositorFrameTimes.push(timestamp - previousAnimationFrame);
    }
    previousAnimationFrame = timestamp;
    const phase = animationFrame / 20;
    const scale = 1 + ((Math.sin(phase) + 1) * 0.04);
    transformHost.style.transform = `translate(${Math.sin(phase) * 8}px, ${Math.cos(phase) * 5}px) scale(${scale})`;
    animationFrame += 1;
    requestAnimationFrame(animateTransform);
  };
  requestAnimationFrame(animateTransform);

  const samples: GraphNewTransportSample[] = [];
  const completions: GraphNewTransportProbeCompletion[] = [];
  let maximumQueueDepth = 0;
  let peakResidentFrameBuffers = 0;
  let peakResidentFrameBytes = 0;
  let longestSynchronousTaskMs = 0;
  let canvasHasFrame = false;
  let tornOrStaleFrames = 0;

  try {
    for (let sequenceFrameId = 1; sequenceFrameId <= FRAMES_PER_RESOLUTION; sequenceFrameId += 1) {
      setStatus(`${width} x ${height}: frame ${sequenceFrameId}/${FRAMES_PER_RESOLUTION}`);
      const requestId = `graph-new-${width}x${height}-${sequenceFrameId}`;
      let controller: GraphNewProbeController | null = null;
      let resolvePresentation: (value: FramePresentation) => void = () => undefined;
      let rejectPresentation: (reason: unknown) => void = () => undefined;
      const presentation = new Promise<FramePresentation>((resolve, reject) => {
        resolvePresentation = resolve;
        rejectPresentation = reject;
      });
      controller = graphNewService.probe({
        requestId,
        width,
        height,
        frames: 1,
        format: "rgba8",
      }, {
        activeIdentity: () => ({
          requestId,
          datasetGeneration: 0,
          rendererGeneration: 0,
          cameraGeneration: 0,
        }),
        onFrame: (frame) => {
          const activeController = controller;
          if (!activeController) {
            rejectPresentation(new Error("graph-new probe controller was not initialized"));
            return;
          }
          void presentFrame(
            frame,
            activeController,
            context,
            canvasHasFrame,
            (rawBuffers, decodedBuffers, canvasBuffers) => {
              const buffers = rawBuffers + decodedBuffers + canvasBuffers;
              peakResidentFrameBuffers = Math.max(peakResidentFrameBuffers, buffers);
              peakResidentFrameBytes = Math.max(
                peakResidentFrameBytes,
                buffers * frame.payload.byteLength,
              );
            },
          ).then(resolvePresentation).catch((error: unknown) => {
            tornOrStaleFrames += 1;
            rejectPresentation(error);
          });
        },
        onError: rejectPresentation,
      });

      const presentationTimeout = window.setTimeout(
        () => rejectPresentation(new Error(
          `graph-new ${width} x ${height} frame ${sequenceFrameId} timed out`,
        )),
        30_000,
      );
      let completion: GraphNewTransportProbeCompletion;
      let presented: FramePresentation;
      try {
        [completion, presented] = await Promise.all([
          controller.completion,
          presentation,
        ]);
      } finally {
        window.clearTimeout(presentationTimeout);
      }
      canvasHasFrame = true;
      completions.push(completion);
      maximumQueueDepth = Math.max(
        maximumQueueDepth,
        completion.maximumQueueDepth,
        controller.snapshot().maximumQueueDepth,
      );
      longestSynchronousTaskMs = Math.max(
        longestSynchronousTaskMs,
        presented.synchronousTaskMs,
      );
      samples.push({
        frameId: sequenceFrameId,
        renderMs: completion.renderMs[0] ?? 0,
        readbackMs: completion.readbackMs[0] ?? 0,
        transferMs: presented.transferMs,
        decodeMs: presented.decodeMs,
        presentMs: presented.presentMs,
        readbackToPresentMs: presented.readbackToPresentMs,
        payloadBytes: presented.payloadBytes,
      });
    }
  } finally {
    animationRunning = false;
    transformHost.style.transform = "none";
    observer?.takeRecords().forEach((entry) => longTasks.push(entry.duration));
    observer?.disconnect();
  }

  const renderMs = samples.map((sample) => sample.renderMs);
  const readbackMs = samples.map((sample) => sample.readbackMs);
  const producerMs = samples.reduce(
    (total, sample) => total + sample.renderMs + sample.readbackMs,
    0,
  );
  const compositorFrameTimeP95Ms = percentile(compositorFrameTimes, 95);
  return {
    width,
    height,
    framesRequested: completions.reduce((total, item) => total + item.framesRequested, 0),
    framesSent: completions.reduce((total, item) => total + item.framesSent, 0),
    framesPresented: samples.length,
    rustFrameHz: producerMs > 0 ? (samples.length * 1_000) / producerMs : 0,
    compositorFpsP95: compositorFrameTimeP95Ms > 0
      ? 1_000 / compositorFrameTimeP95Ms
      : 0,
    compositorFrameTimeP95Ms,
    longestAvoidableMainThreadTaskMs: Math.max(
      longestSynchronousTaskMs,
      0,
      ...longTasks,
    ),
    payloadBytes: samples.reduce((total, sample) => total + sample.payloadBytes, 0),
    peakTransportBytes: Math.max(0, ...completions.map((item) => item.peakTransportBytes)),
    peakResidentFrameBuffers,
    peakResidentFrameBytes,
    maximumQueueDepth,
    droppedSupersededFrames: completions.reduce(
      (total, item) => total + item.droppedSupersededFrames,
      0,
    ),
    usedTextPixelEncoding: false,
    tornOrStaleFrames,
    stages: {
      renderMs: summarizeStage(renderMs),
      readbackMs: summarizeStage(readbackMs),
      transferMs: summarizeStage(samples.map((sample) => sample.transferMs)),
      decodeMs: summarizeStage(samples.map((sample) => sample.decodeMs)),
      presentMs: summarizeStage(samples.map((sample) => sample.presentMs)),
      readbackToPresentMs: summarizeStage(
        samples.map((sample) => sample.readbackToPresentMs),
      ),
    },
    samples,
  };
}

async function postReport(report: GraphNewTransportReportV1): Promise<void> {
  const callbackUrl = import.meta.env.VITE_GRAPH_NEW_TRANSPORT_BENCHMARK_CALLBACK;
  if (!callbackUrl) {
    throw new Error("VITE_GRAPH_NEW_TRANSPORT_BENCHMARK_CALLBACK is required");
  }
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(`Result receiver returned ${response.status}`);
}

async function postFailure(error: unknown): Promise<void> {
  const callbackUrl = import.meta.env.VITE_GRAPH_NEW_TRANSPORT_BENCHMARK_CALLBACK;
  if (!callbackUrl) return;
  await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }),
  });
}

export function GraphNewTransportBenchmark() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Preparing graph-new transport gate...");

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const canvas = canvasRef.current;
      const transformHost = transformHostRef.current;
      if (!canvas || !transformHost) return;
      const resolutions: GraphNewTransportResolutionReport[] = [];
      for (const resolution of RESOLUTIONS) {
        if (cancelled) return;
        resolutions.push(await runResolution(
          resolution.width,
          resolution.height,
          canvas,
          transformHost,
          setStatus,
        ));
      }
      const fourK = resolutions.find(
        (resolution) => resolution.width === 3840 && resolution.height === 2160,
      );
      if (!fourK) throw new Error("4K graph-new transport result is missing");
      const gate = evaluateGraphNewTransportGate({
        width: fourK.width,
        height: fourK.height,
        readbackToPresentP95Ms: fourK.stages.readbackToPresentMs.p95,
        compositorFpsP95: fourK.compositorFpsP95,
        compositorFrameTimeP95Ms: fourK.compositorFrameTimeP95Ms,
        longestAvoidableMainThreadTaskMs: fourK.longestAvoidableMainThreadTaskMs,
        maximumQueueDepth: fourK.maximumQueueDepth,
        usedTextPixelEncoding: fourK.usedTextPixelEncoding,
        tornOrStaleFrames: fourK.tornOrStaleFrames,
      });
      const report: GraphNewTransportReportV1 = {
        version: 1,
        generatedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        transport: "tauri-channel-raw-rgba8-pull",
        resolutions,
        gate,
      };
      setStatus(`Posting ${gate.pass ? "PASS" : "FAIL"} report...`);
      await postReport(report);
      setStatus(`Graph-new transport gate: ${gate.pass ? "PASS" : "FAIL"}`);
    };

    void run().catch(async (error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
      try {
        await postFailure(error);
      } catch {
        setStatus("Benchmark failed and the failure report could not be posted");
      }
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ height: "100vh", overflow: "hidden", background: "#eef2f6", color: "#17212b", fontFamily: "Georgia, serif", padding: 16, boxSizing: "border-box" }}>
      <strong>{status}</strong>
      <div style={{ height: "calc(100% - 32px)", display: "grid", placeItems: "center", overflow: "hidden" }}>
        <div ref={transformHostRef} style={{ width: "92%", aspectRatio: "16 / 9", transformOrigin: "center", willChange: "transform" }}>
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        </div>
      </div>
    </main>
  );
}