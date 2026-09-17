import { useEffect, useState } from "react";

import { GraphBuilderNewView } from "../src/components/graphBuilderNew/GraphBuilderNewView";
import { dataService } from "../src/services/dataService";
import { graphNewService, type GraphNewRenderRequest } from "../src/services/graphNewService";
import { useGraphBuilderNewStore } from "../src/stores/useGraphBuilderNewStore";
import type { DatasetMeta } from "../src/types/data";

interface GraphBuilderNewHarnessProps {
  mode?: "live" | "stale" | "missing" | "empty" | "error" | "invalid" | "render" | "slow" | "renderError" | "unknownCount";
}

const SESSION_ID = "graph-builder-new-session";
const DATASET: DatasetMeta = {
  id: "dataset-1",
  name: "Measurements",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 3,
  colCount: 3,
  generation: 7,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
};
const CHANGED_DATASET = { ...DATASET, generation: DATASET.generation + 1 };

export function GraphBuilderNewHarness({ mode = "live" }: GraphBuilderNewHarnessProps) {
  const [ready, setReady] = useState(false);
  const [descriptorCalls, setDescriptorCalls] = useState(0);
  const [closeCount, setCloseCount] = useState(0);
  const [lastRequest, setLastRequest] = useState<GraphNewRenderRequest | null>(null);
  const [renderTimes, setRenderTimes] = useState<number[]>([]);
  const [cancelModes, setCancelModes] = useState<boolean[]>([]);
  const [metrics, setMetrics] = useState({ renders: 0, cancels: 0, closes: 0, presented: 0, maximumActive: 0, settled: 0 });
  const [width, setWidth] = useState(960);
  const [invalidated, setInvalidated] = useState(false);
  const [visible, setVisible] = useState(true);
  const selectedSession = useGraphBuilderNewStore((state) => state.sessions[0] ?? null);

  useEffect(() => {
    const previousGetColumnDescriptors = dataService.getColumnDescriptors;
    const previousStoreState = useGraphBuilderNewStore.getState();
    const previousRender = graphNewService.render;
    const previousClose = graphNewService.close;
    const previousInternals = (window as any).__TAURI_INTERNALS__;
    let active = 0;
    const closedSessions = new Set<string>();
    if (["render", "slow", "renderError", "unknownCount"].includes(mode)) {
      (window as any).__TAURI_INTERNALS__ = {};
      graphNewService.close = async (sessionId) => {
        closedSessions.add(sessionId);
        setMetrics((value) => ({ ...value, closes: value.closes + 1 }));
      };
      graphNewService.render = (request, handlers) => {
        if (closedSessions.has(request.sessionId)) throw new Error("graph_new_cancelled");
        setLastRequest(request);
        setRenderTimes((value) => [...value, performance.now()]);
        active += 1;
        setMetrics((value) => ({ ...value, renders: value.renders + 1, maximumActive: Math.max(value.maximumActive, active) }));
        let cancelled = false;
        let presented = false;
        const frameWidth = Math.ceil(request.width * request.devicePixelRatio);
        const frameHeight = Math.ceil(request.height * request.devicePixelRatio);
        const header = { ...request, width: frameWidth, height: frameHeight, frameId: 1, format: "rgba8" as const,
          byteLength: frameWidth * frameHeight * 4, readbackCompletedAtUnixMicros: 1 };
        const completion = new Promise<any>((resolve, reject) => setTimeout(() => {
          active -= 1;
          setMetrics((value) => ({ ...value, settled: value.settled + 1 }));
          if (mode === "renderError") { handlers.onError("graph_new_render_failed"); reject(new Error("private /user/source.db")); return; }
          const pixels = new Uint8Array(header.byteLength).fill(255);
          for (let row = Math.floor(frameHeight / 3); row < Math.floor(frameHeight * 2 / 3); row++) {
            for (let column = Math.floor(frameWidth / 3); column < Math.floor(frameWidth * 2 / 3); column++) {
              const offset = (row * frameWidth + column) * 4;
              pixels[offset] = 31; pixels[offset + 1] = 111; pixels[offset + 2] = 235;
            }
          }
          handlers.onFrame({ header, payload: pixels.buffer });
          resolve({ requestId: request.requestId, processedRows: 4, finiteRows: 3, excludedNonFiniteRows: 1,
            selectedMarks: request.cameraDomain ? (mode === "unknownCount" ? 0 : 1) : 2,
            exactVisible: Boolean(request.cameraDomain) && mode !== "unknownCount",
            visibleRows: request.cameraDomain ? (mode === "unknownCount" ? null : 1) : 3,
            rawIndexEntriesInspected: 0, rawBlocksInspected: 0, rawPointsInspected: 0,
            buildMs: 1, renderMs: 1, readbackMs: 1, width: frameWidth, height: frameHeight,
            cameraDomain: request.cameraDomain ?? { xMin: 0, xMax: 100, yMin: 0, yMax: 100 },
            plotRect: { x: Math.ceil(64 * request.devicePixelRatio), y: Math.ceil(16 * request.devicePixelRatio),
              width: Math.floor((request.width - 16) * request.devicePixelRatio) - Math.ceil(64 * request.devicePixelRatio),
              height: Math.floor((request.height - 32) * request.devicePixelRatio) - Math.ceil(16 * request.devicePixelRatio) },
            sourceProjectionQueryCount: request.cameraDomain ? 0 : 1, renderGenerationCheckCount: 4 });
        }, mode === "slow" ? 400 : 60));
        return { completion, canPresent: () => !cancelled && !presented,
          markPresented: () => { presented = true; setMetrics((value) => ({ ...value, presented: value.presented + 1 })); },
          cancel: async (preserveCache = false) => {
            setCancelModes((value) => [...value, preserveCache]);
            if (!cancelled) setMetrics((value) => ({ ...value, cancels: value.cancels + 1 })); cancelled = true;
          },
          snapshot: () => ({ maximumQueueDepth: 1, droppedSupersededFrames: 0, rejectedFrames: 0, presentedFrames: Number(presented), pendingFrameId: null }),
        };
      };
    }

    useGraphBuilderNewStore.setState({
      sessions: [{
        id: SESSION_ID,
        datasetId: DATASET.id,
        datasetGeneration: mode === "stale" ? DATASET.generation - 1 : DATASET.generation,
        xColumnId: mode === "invalid" ? "removed-x" : null,
        yColumnId: mode === "invalid" ? "column-label" : null,
      }],
    });
    dataService.getColumnDescriptors = async () => {
      setDescriptorCalls((count) => count + 1);
      if (mode === "error") throw new Error("descriptor lookup failed");
      if (mode === "empty") return [];
      return [
        { columnId: "column-x", name: "Diameter", sqlType: "DOUBLE" },
        { columnId: "column-y", name: "Height", sqlType: "INTEGER" },
        { columnId: "column-label", name: "Cavity", sqlType: "VARCHAR" },
      ];
    };
    setReady(true);

    return () => {
      dataService.getColumnDescriptors = previousGetColumnDescriptors;
      graphNewService.render = previousRender;
      graphNewService.close = previousClose;
      if (previousInternals === undefined) delete (window as any).__TAURI_INTERNALS__;
      else (window as any).__TAURI_INTERNALS__ = previousInternals;
      useGraphBuilderNewStore.setState(previousStoreState, true);
    };
  }, [mode]);

  if (!ready) return null;

  return (
    <div style={{ width, maxWidth: "100%", height: 600 }}>
      {visible && <GraphBuilderNewView
        sessionId={SESSION_ID}
        dataset={mode === "missing" ? undefined : invalidated ? CHANGED_DATASET : DATASET}
        onClose={() => {
          useGraphBuilderNewStore.getState().close(SESSION_ID);
          setCloseCount((count) => count + 1);
        }}
      />}
      <output data-testid="descriptor-calls">{descriptorCalls}</output>
      <output data-testid="close-count">{closeCount}</output>
      <output data-testid="render-metrics">{JSON.stringify(metrics)}</output>
      <output data-testid="render-request">{JSON.stringify(lastRequest)}</output>
      <output data-testid="render-times">{JSON.stringify(renderTimes)}</output>
      <output data-testid="cancel-modes">{JSON.stringify(cancelModes)}</output>
      <button onClick={() => setWidth((value) => value === 960 ? 800 : 960)}>Resize fixture</button>
      <button onClick={() => setInvalidated(true)}>Invalidate source</button>
      <button onClick={() => setVisible(false)}>Unmount view</button>
      <button onClick={() => setVisible(true)}>Remount view</button>
      <button onClick={() => useGraphBuilderNewStore.getState().close(SESSION_ID)}>Close retained session</button>
      <output data-testid="selected-columns">
        {JSON.stringify(selectedSession)}
      </output>
    </div>
  );
}