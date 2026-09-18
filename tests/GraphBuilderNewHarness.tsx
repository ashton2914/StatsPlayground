import { useEffect, useRef, useState } from "react";

import { GraphBuilderNewView } from "../src/components/graphBuilderNew/GraphBuilderNewView";
import i18n from "../src/i18n";
import { dataService } from "../src/services/dataService";
import { graphNewService, type GraphNewRenderRequest } from "../src/services/graphNewService";
import { useGraphBuilderNewStore } from "../src/stores/useGraphBuilderNewStore";
import { useProjectStore } from "../src/stores/useProjectStore";
import type { GraphBuilderNewCamera, GraphBuilderNewDocument } from "../src/types/graphBuilderNew";
import type { ColumnDescriptor, DatasetMeta } from "../src/types/data";

interface GraphBuilderNewHarnessProps {
  deferClose?: boolean;
  savedCamera?: GraphBuilderNewCamera;
  locale?: "en" | "zh-CN";
  axisFixture?: "nanoTime" | "microTime" | "microDuration" | "unicode";
  mode?: "live" | "stale" | "missing" | "empty" | "error" | "invalid" | "render" | "slow" | "renderError" | "unknownCount" | "largeExact" | "mixedFields" | "unsupportedFields" | "deferredFields";
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
const MIXED_FIELDS: ColumnDescriptor[] = [
  { columnId: "text-test-time", name: "TestTime", sqlType: "VARCHAR" },
  { columnId: "column-x", name: "TestTime", sqlType: "DOUBLE" },
  { columnId: "timestamp-dpt", name: "DPT", sqlType: "TIMESTAMP" },
  { columnId: "text-step-time", name: "StepTime", sqlType: "VARCHAR" },
  { columnId: "column-y", name: "Voltage", sqlType: "INTEGER" },
  { columnId: "duplicate-x", name: "TestTime", sqlType: "DOUBLE" },
];
const REPLACEMENT_FIELDS: ColumnDescriptor[] = [
  { columnId: "new-x", name: "New X", sqlType: "DOUBLE" },
  { columnId: "new-text", name: "New text", sqlType: "VARCHAR" },
];

export function GraphBuilderNewHarness({ mode = "live", locale = "en", axisFixture, savedCamera, deferClose = false }: GraphBuilderNewHarnessProps) {
  const [ready, setReady] = useState(false);
  const [descriptorCalls, setDescriptorCalls] = useState(0);
  const [closeCount, setCloseCount] = useState(0);
  const [lastRequest, setLastRequest] = useState<GraphNewRenderRequest | null>(null);
  const [renderTimes, setRenderTimes] = useState<number[]>([]);
  const [cancelModes, setCancelModes] = useState<boolean[]>([]);
  const [closedIds, setClosedIds] = useState<string[]>([]);
  const [cancelledIds, setCancelledIds] = useState<string[]>([]);
  const pendingCloses = useRef<(() => void)[]>([]);
  const [metrics, setMetrics] = useState({ renders: 0, cancels: 0, closes: 0, presented: 0, maximumActive: 0, settled: 0 });
  const [width, setWidth] = useState(960);
  const [invalidated, setInvalidated] = useState(false);
  const [visible, setVisible] = useState(true);
  const [fieldDataset, setFieldDataset] = useState(DATASET);
  const refreshedFields = useRef(false);
  const pendingFields = useRef<{ resolve: (fields: ColumnDescriptor[]) => void; reject: (error: Error) => void } | null>(null);
  const selectedSession = useGraphBuilderNewStore((state) => state.sessions[0] ?? null);
  const documents = useGraphBuilderNewStore((state) => state.items);
  const dirty = useProjectStore((state) => state.dirty);

  useEffect(() => {
    const previous = i18n.language;
    void i18n.changeLanguage(locale);
    return () => { void i18n.changeLanguage(previous); };
  }, [locale]);

  useEffect(() => {
    const previousGetColumnDescriptors = dataService.getColumnDescriptors;
    const previousStoreState = useGraphBuilderNewStore.getState();
    const previousProjectState = useProjectStore.getState();
    const previousRender = graphNewService.render;
    const previousClose = graphNewService.close;
    const previousInternals = (window as any).__TAURI_INTERNALS__;
    let active = 0;
    const closedSessions = new Set<string>();
    if (["render", "slow", "renderError", "unknownCount", "largeExact", "mixedFields", "unsupportedFields", "deferredFields"].includes(mode)) {
      (window as any).__TAURI_INTERNALS__ = {};
      graphNewService.close = async (sessionId) => {
        setClosedIds((value) => [...value, sessionId]);
        if (deferClose) await new Promise<void>((resolve) => pendingCloses.current.push(resolve));
        closedSessions.add(sessionId);
        setMetrics((value) => ({ ...value, closes: value.closes + 1 }));
      };
      graphNewService.render = (request, handlers) => {
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
          if (closedSessions.has(request.sessionId)) { handlers.onError("graph_new_cancelled"); reject(new Error("graph_new_cancelled")); return; }
          if (mode === "renderError") { handlers.onError("graph_new_render_failed"); reject(new Error("private /user/source.db")); return; }
          const pixels = new Uint8Array(header.byteLength).fill(255);
          for (let row = Math.floor(frameHeight / 3); row < Math.floor(frameHeight * 2 / 3); row++) {
            for (let column = Math.floor(frameWidth / 3); column < Math.floor(frameWidth * 2 / 3); column++) {
              const offset = (row * frameWidth + column) * 4;
              pixels[offset] = 31; pixels[offset + 1] = 111; pixels[offset + 2] = 235;
            }
          }
          handlers.onFrame({ header, payload: pixels.buffer });
          const typedDomain = request.xMode === "duration" ? { xMin: 0, xMax: 180000, yMin: 0, yMax: 100 }
            : request.xMode === "time" ? { xMin: 1766389600, xMax: 1766476000, yMin: 0, yMax: 100 }
              : request.xMode === "category" ? { xMin: 0, xMax: 4, yMin: 0, yMax: 100 }
                : { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };
          const fixtureAxis = axisFixture === "nanoTime" || axisFixture === "microTime"
            ? { kind: "time", utc: true, origin: { epochNanos: axisFixture === "nanoTime" ? "1789689600000000001" : "1789689600000001000", unitNanos: axisFixture === "nanoTime" ? 1 : 1000 },
              ticks: [{ value: 0, position: 0, label: null }, { value: 1, position: 1, label: null }] }
            : axisFixture === "microDuration" ? { kind: "duration", utc: false,
              ticks: [{ value: 90000.000001, position: 0, label: null }, { value: 90000.000002, position: 1, label: null }] }
              : axisFixture === "unicode" ? { kind: "category", utc: false,
                ticks: [{ value: 0, position: 0, label: "\u6e29\u5ea6" }, { value: 1, position: 1, label: "\u00e9\u0394" }] } : null;
          const domain = request.cameraDomain ?? (fixtureAxis ? { xMin: fixtureAxis.ticks[0].value, xMax: fixtureAxis.ticks[1].value, yMin: 0, yMax: 100 } : typedDomain);
          resolve({ requestId: request.requestId, processedRows: mode === "largeExact" ? 2_032_294 : 4,
            rawMode: request.rawMode ?? "scatter", rawLineAvailable: mode !== "unknownCount", rawLineSegments: request.rawMode === "scatter" ? 0 : 2,
            xAxis: fixtureAxis ?? (["duration", "time", "category"].includes(request.xMode ?? "") ? { kind: request.xMode, utc: request.xMode === "time",
              ticks: [0, 0.25, 0.5, 0.75, 1].map((position, index) => ({ value: domain.xMin + position * (domain.xMax - domain.xMin), position,
                label: request.xMode === "category" ? `Category ${index + 1} with a deliberately long descriptive label` : null })) }
              : { kind: "numeric", utc: false, ticks: [] }),
            finiteRows: mode === "largeExact" ? 2_032_293 : 3, excludedNonFiniteRows: 1,
            meanAvailable: mode === "largeExact", meanGroups: mode === "largeExact" && request.showMean ? 2 : null,
            meanVisible: mode === "largeExact" && request.showMean === true,
            selectedMarks: mode === "largeExact" ? 2_032_293 : request.cameraDomain ? (mode === "unknownCount" ? 0 : 1) : 2,
            exactVisible: mode === "largeExact" || (Boolean(request.cameraDomain) && mode !== "unknownCount"),
            visibleRows: mode === "largeExact" ? (request.cameraDomain ? 7 : 2_032_293) : request.cameraDomain ? (mode === "unknownCount" ? null : 1) : 3,
            rawIndexEntriesInspected: 0, rawBlocksInspected: 0, rawPointsInspected: 0,
            buildMs: 1, renderMs: 1, readbackMs: 1, width: frameWidth, height: frameHeight,
            cameraDomain: domain,
            plotRect: { x: Math.ceil(64 * request.devicePixelRatio), y: Math.ceil(16 * request.devicePixelRatio),
              width: Math.floor((request.width - 16) * request.devicePixelRatio) - Math.ceil(64 * request.devicePixelRatio),
              height: Math.floor((request.height - 32) * request.devicePixelRatio) - Math.ceil(16 * request.devicePixelRatio) },
            sourceProjectionQueryCount: request.cameraDomain ? 0 : 1, renderGenerationCheckCount: 4 });
        }, mode === "slow" ? 400 : 60));
        return { completion, canPresent: () => !cancelled && !presented && !closedSessions.has(request.sessionId),
          markPresented: () => { presented = true; setMetrics((value) => ({ ...value, presented: value.presented + 1 })); },
          cancel: async (preserveCache = false) => {
            setCancelledIds((value) => [...value, request.sessionId]);
            setCancelModes((value) => [...value, preserveCache]);
            if (!cancelled) setMetrics((value) => ({ ...value, cancels: value.cancels + 1 })); cancelled = true;
          },
          snapshot: () => ({ maximumQueueDepth: 1, droppedSupersededFrames: 0, rejectedFrames: 0, presentedFrames: Number(presented), pendingFrameId: null }),
        };
      };
    }

    useProjectStore.setState({ dirty: false, readOnly: false });
    useGraphBuilderNewStore.getState().loadFromProject([{
        version: 1,
        id: SESSION_ID,
        name: "Graph Builder-new 1",
        datasetId: DATASET.id,
        xColumnId: mode === "invalid" ? "removed-x" : savedCamera ? "column-x" : null,
        yColumnId: mode === "invalid" ? "column-label" : savedCamera ? "column-y" : null,
        showMean: true, xMode: "auto", rawMode: "scatter", camera: savedCamera ?? null,
    }]);
    useGraphBuilderNewStore.getState().reopen(SESSION_ID, mode === "stale" ? DATASET.generation - 1 : DATASET.generation);
    dataService.getColumnDescriptors = async (datasetId) => {
      setDescriptorCalls((count) => count + 1);
      if (mode === "error") throw new Error("descriptor lookup failed");
      if (mode === "empty") return [];
      if (datasetId === "dataset-2") return REPLACEMENT_FIELDS;
      if (mode === "deferredFields") return new Promise<ColumnDescriptor[]>((resolve, reject) => {
        pendingFields.current = { resolve, reject };
      });
      if (mode === "unsupportedFields") return MIXED_FIELDS.filter(({ sqlType }) => sqlType === "VARCHAR" || sqlType === "TIMESTAMP");
      if (mode === "mixedFields") return refreshedFields.current
        ? MIXED_FIELDS.filter(({ columnId }) => columnId !== "duplicate-x").map((column) => (
          column.columnId === "column-x" ? { ...column, sqlType: "VARCHAR" } : column
        ))
        : MIXED_FIELDS;
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
      useProjectStore.setState(previousProjectState, true);
    };
  }, [mode, axisFixture, savedCamera, deferClose]);

  if (!ready) return null;

  return (
    <div style={{ width, maxWidth: "100%", height: 600 }}>
      {visible && <GraphBuilderNewView
        sessionId={SESSION_ID}
        dataset={mode === "missing" ? undefined : invalidated ? CHANGED_DATASET : fieldDataset}
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
      <output data-testid="closed-ids">{JSON.stringify(closedIds)}</output>
      <output data-testid="cancelled-ids">{JSON.stringify(cancelledIds)}</output>
      <button onClick={() => pendingCloses.current.splice(0).forEach((resolve) => resolve())}>Release old closes</button>
      <button onClick={() => useGraphBuilderNewStore.getState().reopen(SESSION_ID, DATASET.generation)}>Reopen retained generation</button>
      <output data-testid="documents">{JSON.stringify(documents)}</output>
      <output data-testid="project-dirty">{String(dirty)}</output>
      <button onClick={() => useProjectStore.setState({ dirty: false })}>Mark saved</button>
      <button onClick={() => useProjectStore.setState({ readOnly: true, dirty: false })}>Begin save</button>
      <button onClick={() => useProjectStore.setState({ readOnly: false })}>Finish save</button>
      <button onClick={() => {
        const saved = JSON.parse(JSON.stringify(useGraphBuilderNewStore.getState().items)) as GraphBuilderNewDocument[];
        useGraphBuilderNewStore.getState().reset();
        useGraphBuilderNewStore.getState().loadFromProject(saved);
        useGraphBuilderNewStore.getState().reopen(SESSION_ID, DATASET.generation);
        useProjectStore.setState({ dirty: false });
        setVisible(true);
      }}>Reload documents</button>
      <button onClick={() => {
        const saved = useGraphBuilderNewStore.getState().items.map((item) => ({ ...item, camera: null }));
        useGraphBuilderNewStore.getState().loadFromProject(saved);
        useGraphBuilderNewStore.getState().reopen(SESSION_ID, DATASET.generation);
        useProjectStore.setState({ dirty: false });
      }}>Reload full view</button>
      <button onClick={() => {
        useGraphBuilderNewStore.getState().reopen(SESSION_ID, CHANGED_DATASET.generation);
        setFieldDataset(CHANGED_DATASET);
      }}>Reopen current generation</button>
      <button onClick={() => setWidth((value) => value === 960 ? 800 : 960)}>Resize fixture</button>
      <button onClick={() => setInvalidated(true)}>Invalidate source</button>
      <button onClick={() => setVisible(false)}>Unmount view</button>
      <button onClick={() => setVisible(true)}>Remount view</button>
      {["mixedFields", "unsupportedFields", "deferredFields"].includes(mode) && <>
        <button onClick={() => {
          const replacement = { ...DATASET, id: "dataset-2", name: "Replacement" };
          useGraphBuilderNewStore.getState().loadFromProject([{ ...useGraphBuilderNewStore.getState().items[0], datasetId: replacement.id, xColumnId: null, yColumnId: null, camera: null }]);
          useGraphBuilderNewStore.getState().reopen(SESSION_ID, replacement.generation);
          setFieldDataset(replacement);
        }}>Replace field source</button>
        <button onClick={() => {
          refreshedFields.current = true;
          setFieldDataset({ ...DATASET, updatedAt: "2026-09-18T00:00:00.000Z" });
        }}>Refresh field metadata</button>
        <button onClick={() => pendingFields.current?.resolve(MIXED_FIELDS)}>Resolve old fields</button>
        <button onClick={() => pendingFields.current?.reject(new Error("old descriptor failure"))}>Reject old fields</button>
      </>}
      <button onClick={() => useGraphBuilderNewStore.getState().close(SESSION_ID)}>Close retained session</button>
      <output data-testid="selected-columns">
        {JSON.stringify(selectedSession)}
      </output>
    </div>
  );
}