import { useThemeStore } from "@/stores/useThemeStore";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { AutoSpec, RefLineX, RefLineY, YAxisConfig } from "@/graphCore/types";
import {
  graphNewService,
  type GraphNewAxis,
  type GraphNewOverlayGroup,
  type GraphNewRenderController,
  type GraphNewRenderRequest,
} from "@/services/graphNewService";
import type { GraphNewFrame } from "@/types/graphNew";
import { computeAxisLayout, strokeDashArrayForStyle } from "./graphNewAxisLayout";
import { buildAxisBounds, cameraTransform, createCameraScheduler, isCameraDomain, isRestorableCamera, overscanCamera, overscanViewport, panCamera, shouldPreviewCameraTransform, zoomCamera, type CameraDomain, type PlotRect } from "./graphNewCamera";

interface RenderJob { run: () => Promise<void>; cancel: (preserveCache?: boolean) => void }
let activeJob: RenderJob | null = null;
let pendingJob: RenderJob | null = null;
let rendererGeneration = Date.now() * 1024;

function pump() {
  if (activeJob || !pendingJob) return;
  const job = pendingJob;
  pendingJob = null;
  activeJob = job;
  void job.run().catch(() => {}).finally(() => { activeJob = null; pump(); });
}

function enqueue(job: RenderJob) {
  activeJob?.cancel(true);
  pendingJob?.cancel(true);
  pendingJob = job;
  pump();
}

type Props = Pick<GraphNewRenderRequest, "datasetId" | "datasetGeneration" | "xColumnId" | "yColumnId" | "xMode" | "rawMode" | "overlayColumnId" | "layers"> & {
  transportId: string;
  controlsHost?: HTMLElement | null;
  showMean: boolean;
  pointRadius?: number;
  hiddenOverlayGroupIds?: string[];
  onMeanAvailabilityChange?: (available: boolean | null) => void;
  onOverlayStateChange?: (state: { active: boolean; groups: GraphNewOverlayGroup[] }) => void;
  savedCamera?: CameraDomain | null;
  readOnly?: boolean;
  onCameraChange?: (camera: CameraDomain | null) => void;
  xAxisConfig?: YAxisConfig;
  yAxisConfig?: YAxisConfig;
  refLinesX?: RefLineX[];
  refLinesY?: RefLineY[];
  autoSpecLinesX?: boolean;
  autoSpecLinesY?: boolean;
  resolvedAutoSpecX?: AutoSpec;
  resolvedAutoSpecY?: AutoSpec;
  onXAxisDblClick?: () => void;
  onYAxisDblClick?: () => void;
};

export function formatGraphNewTick(axis: GraphNewAxis, tick: GraphNewAxis["ticks"][number]): string {
  if (axis.kind === "category") return tick.label ?? "";
  if (axis.kind === "numeric") return tick.label ?? String(tick.value);
  const unit = axis.origin?.unitNanos ?? 1_000_000_000;
  const interval = axis.ticks.slice(1).reduce((minimum, current, index) =>
    Math.min(minimum, Math.abs(current.value - axis.ticks[index].value) * unit / 1_000_000_000), Infinity);
  const precision = Math.min(9, Math.max(3, -Math.floor(Math.log10(interval) + 0.0001)));
  if (axis.kind === "time") {
    if (axis.origin) {
      const whole = Math.trunc(tick.value);
      const nanos = BigInt(axis.origin.epochNanos) + BigInt(whole) * BigInt(unit)
        + BigInt(Math.round((tick.value - whole) * unit));
      const fraction = ((nanos % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
      const date = new Date(Number((nanos - fraction) / 1_000_000_000n) * 1000);
      if (!Number.isFinite(date.valueOf())) return "";
      const digits = fraction.toString().padStart(9, "0").replace(/0+$/, "");
      const suffix = digits ? `.${digits.padEnd(precision, "0")}` : "";
      return `${date.toISOString().replace("T", " ").replace(/\.000Z$/, "")}${suffix}${axis.utc ? " UTC" : ""}`;
    }
    const date = new Date(tick.value * 1000);
    return Number.isFinite(date.valueOf()) ? `${date.toISOString().replace("T", " ").replace(/\.000Z$/, "").replace(/Z$/, "")}${axis.utc ? " UTC" : ""}` : "";
  }
  if (axis.kind === "duration") {
    const [integer, fraction] = Math.abs(tick.value).toFixed(precision).split(".");
    const totalSeconds = Number(integer);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = totalSeconds % 60;
    return `${tick.value < 0 ? "-" : ""}${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${Number(fraction) ? `.${fraction}` : ""}`;
  }
  return String(tick.value);
}

export function GraphNewCanvas({
  controlsHost,
  transportId: sessionId,
  datasetId,
  datasetGeneration,
  xColumnId,
  yColumnId,
  overlayColumnId = null,
  layers,
  showMean,
  pointRadius,
  hiddenOverlayGroupIds = [],
  onMeanAvailabilityChange,
  onOverlayStateChange,
  xMode = "auto",
  rawMode = "scatter",
  savedCamera = null,
  readOnly = false,
  onCameraChange,
  xAxisConfig,
  yAxisConfig,
  refLinesX,
  refLinesY,
  autoSpecLinesX,
  autoSpecLinesY,
  resolvedAutoSpecX,
  resolvedAutoSpecY,
  onXAxisDblClick,
  onYAxisDblClick,
}: Props) {
  const { t } = useTranslation();
  const darkTheme = useThemeStore(state => state.effectiveTheme === "dark");
  const invertX = Boolean(xAxisConfig?.inverse);
  const invertY = Boolean(yAxisConfig?.inverse);
  const axisBounds = useMemo(
    () => buildAxisBounds(xAxisConfig, yAxisConfig, xMode),
    [xAxisConfig?.min, xAxisConfig?.max, yAxisConfig?.min, yAxisConfig?.max, xMode],
  );
  const axisBoundsKey = JSON.stringify(axisBounds ?? null);
  const [meanFrame, setMeanFrame] = useState<{ available: boolean; visible: boolean; groups: number | null } | null>(null);
  const [overlayState, setOverlayState] = useState<{ active: boolean; groups: GraphNewOverlayGroup[] }>({ active: false, groups: [] });
  const [rawAvailable, setRawAvailable] = useState(true);
  const [chromeSnapshot, setChromeSnapshot] = useState<{
    plotLeft: number;
    plotTop: number;
    plotWidth: number;
    plotHeight: number;
    hostWidth: number;
    hostHeight: number;
    xAxis: GraphNewAxis;
    yAxis: GraphNewAxis;
    categoryLabels: Map<number, string>;
    presentedDomain: CameraDomain;
    liveDomain: CameraDomain;
  } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const plotHost = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const resetView = useRef<() => void>(() => {});
  const cameraState = useRef<{ identity: string; sourceIdentity: string; axisBoundsKey: string; restoreCamera: CameraDomain | null; full: CameraDomain | null; desired: CameraDomain | null; presented: CameraDomain | null; resetPending: boolean; restorePending: boolean; gesturePending: boolean } | null>(null);
  const persistence = useRef({ savedCamera, readOnly, onCameraChange });
  persistence.current = { savedCamera, readOnly, onCameraChange };
  const [cameraRestoreRejected, setCameraRestoreRejected] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number; devicePixelRatio: number } | null>(null);

  useEffect(() => {
    onMeanAvailabilityChange?.(meanFrame?.available ?? null);
  }, [meanFrame?.available, onMeanAvailabilityChange]);

  useEffect(() => {
    onOverlayStateChange?.(overlayState);
  }, [onOverlayStateChange, overlayState]);
  const [hasFrame, setHasFrame] = useState(false);
  const [status, setStatus] = useState("Rendering...");
  const [layerWarning, setLayerWarning] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [provisional, setProvisional] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    let initialized = false;
    const apply = () => {
      const bounds = element.getBoundingClientRect();
      const hostWidth = Math.max(96, Math.floor(bounds.width));
      const hostHeight = Math.max(64, Math.floor(bounds.height));
      const logicalScale = Math.min(1, 7680 / hostWidth, 4320 / hostHeight);
      const width = Math.max(96, Math.floor(hostWidth * logicalScale));
      const height = Math.max(64, Math.floor(hostHeight * logicalScale));
      const ratio = Math.floor(Math.min(8, Math.max(0.5, window.devicePixelRatio || 1), 3840 / width, 2160 / height) * 1_000_000) / 1_000_000;
      const next = {
        width,
        height,
        devicePixelRatio: ratio,
      };
      setSize((previous) => previous?.width === next.width && previous.height === next.height
        && previous.devicePixelRatio === next.devicePixelRatio ? previous : next);
    };
    const measure = () => {
      clearTimeout(timer);
      if (!initialized) {
        initialized = true;
        apply();
        return;
      }
      timer = setTimeout(apply, 100);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    measure();
    return () => { clearTimeout(timer); observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => {
    if (!size) return;
    const element = host.current;
    const plotElement = plotHost.current;
    if (!element || !plotElement) return;
    const sourceIdentity = JSON.stringify([sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, overlayColumnId, xMode]);
    const sourcePolicy = layers === undefined ? rawMode === "line" : layers.some(layer => layer.kind !== "points" || layer.options.summaryStat !== "none");
    const identity = JSON.stringify([sourceIdentity, sourcePolicy, layers, axisBoundsKey]);
    if (cameraState.current?.identity !== identity) {
      const previous = cameraState.current;
      const boundsChanged = previous !== null && previous.sourceIdentity === sourceIdentity && previous.axisBoundsKey !== axisBoundsKey;
      const restoreCamera = !boundsChanged && previous?.sourceIdentity === sourceIdentity ? previous.desired ?? previous.restoreCamera : null;
      cameraState.current = {
        identity,
        sourceIdentity,
        axisBoundsKey,
        restoreCamera,
        full: null,
        desired: null,
        presented: null,
        resetPending: boundsChanged,
        restorePending: !boundsChanged,
        gesturePending: false,
      };
      if (boundsChanged && !persistence.current.readOnly) {
        persistence.current.onCameraChange?.(null);
      }
      setCameraRestoreRejected(false);
    }
    const inversion = { invertX, invertY };
    const retained = cameraState.current;
    let disposed = false;
    let currentJob: RenderJob | null = null;
    let overscanJob: { cancel: () => void } | null = null;
    let full: CameraDomain | null = retained.full;
    let presented: CameraDomain | null = null;
    let previewDomain: CameraDomain | null = null;
    let presentedAxes: { x: GraphNewAxis; y: GraphNewAxis; categoryLabels: Map<number, string> } | null = null;
    let current: CameraDomain | null = retained.desired;
    let plot: PlotRect | null = null;
    let frameWidth = 0;
    let frameHeight = 0;
    let raf: number | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retriedCameraGeneration: number | null = null;
    let pointer: { id: number; x: number; y: number } | null = null;
    let resetPending = retained.resetPending;
    const cancelOverscan = () => {
      overscanJob?.cancel();
      overscanJob = null;
    };
    setCameraAvailable(full !== null);
    setProvisional(false);
    plotElement.style.visibility = "hidden";
    element.removeAttribute("data-provisional");
    const geometry = () => {
      const bounds = element.getBoundingClientRect();
      const scale = Math.min(bounds.width / frameWidth, bounds.height / frameHeight);
      return { bounds, scale, left: (bounds.width - frameWidth * scale) / 2, top: (bounds.height - frameHeight * scale) / 2 };
    };
    const publishChrome = (target: CameraDomain) => {
      if (!presented || !presentedAxes || !plot || frameWidth === 0 || frameHeight === 0) return;
      const { scale, left, top } = geometry();
      setChromeSnapshot({
        plotLeft: left + plot.x * scale,
        plotTop: top + plot.y * scale,
        plotWidth: plot.width * scale,
        plotHeight: plot.height * scale,
        hostWidth: element.clientWidth,
        hostHeight: element.clientHeight,
        xAxis: presentedAxes.x,
        yAxis: presentedAxes.y,
        categoryLabels: presentedAxes.categoryLabels,
        presentedDomain: presented,
        liveDomain: target,
      });
    };
    const drawPreview = () => {
      raf = null;
      const source = previewDomain ?? presented;
      if (!presented || !source || !current || !plot || !preview.current) return;
      if (shouldPreviewCameraTransform(presented, current, plot, source, inversion)) {
        const { scale } = geometry();
        const transform = cameraTransform(source, current, plot, inversion);
        preview.current.style.transform = `translate3d(${transform.x * scale}px, ${transform.y * scale}px, 0) scale(${transform.scale})`;
      }
      publishChrome(current);
    };
    const showPreview = () => {
      const source = previewDomain ?? presented;
      if (!presented || !source || !current || !plot || !preview.current) return;
      if (!shouldPreviewCameraTransform(presented, current, plot, source, inversion)) {
        preview.current.style.transform = "none";
        element.removeAttribute("data-provisional");
        setProvisional(false);
        const delta = cameraTransform(presented, current, plot, inversion);
        const changed = Number.isFinite(delta.scale) && Number.isFinite(delta.x) && Number.isFinite(delta.y)
          && (Math.abs(delta.scale - 1) > 1e-8 || Math.abs(delta.x) > 1e-6 || Math.abs(delta.y) > 1e-6);
        if (changed) {
          if (raf === null) raf = requestAnimationFrame(drawPreview);
        } else {
          if (raf !== null) cancelAnimationFrame(raf);
          raf = null;
          publishChrome(presented);
        }
        return;
      }
      element.dataset.provisional = "true";
      setProvisional(true);
      if (raf === null) raf = requestAnimationFrame(drawPreview);
    };
    const scheduler = createCameraScheduler({
      invalidate: () => { cancelOverscan(); currentJob?.cancel(!disposed); if (pendingJob === currentJob) pendingJob = null; },
      settled: (generation) => {
        if (disposed || !current) return;
        if (persistence.current.readOnly) {
          retained.desired = current = retained.presented;
          retained.resetPending = resetPending = false;
          retained.gesturePending = false;
          if (preview.current) preview.current.style.transform = "none";
          element.removeAttribute("data-provisional");
          setProvisional(false);
          if (!plot) launch(current, generation);
          return;
        }
        if (retained.gesturePending) {
          retained.gesturePending = false;
          setCameraRestoreRejected(false);
          persistence.current.onCameraChange?.(resetPending ? null : current);
        }
        launch(resetPending ? null : current, generation);
      },
    });
    const physicalPointer = (event: { clientX: number; clientY: number }) => {
      const { bounds, scale, left, top } = geometry();
      return { x: (event.clientX - bounds.x - left) / scale, y: (event.clientY - bounds.y - top) / scale };
    };
    const down = (event: PointerEvent) => {
      if (persistence.current.readOnly || event.button !== 0 || pointer || !current || !full || !plot) return;
      event.preventDefault();
      plotElement.setPointerCapture(event.pointerId);
      pointer = { id: event.pointerId, ...physicalPointer(event) };
      scheduler.begin();
    };
    const move = (event: PointerEvent) => {
      if (persistence.current.readOnly || !pointer || pointer.id !== event.pointerId || !current || !full || !plot) return;
      const next = physicalPointer(event);
      current = panCamera(current, full, plot, next.x - pointer.x, next.y - pointer.y, layers !== undefined, inversion);
      retained.desired = current;
      retained.gesturePending = true;
      pointer = { id: event.pointerId, ...next };
      retained.resetPending = resetPending = false;
      scheduler.change(); showPreview();
    };
    const end = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id) return;
      pointer = null;
      if (plotElement.hasPointerCapture(event.pointerId)) plotElement.releasePointerCapture(event.pointerId);
      scheduler.end();
    };
    const wheel = (event: WheelEvent) => {
      if (persistence.current.readOnly || !current || !full || !plot) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      current = zoomCamera(current, full, plot, physicalPointer(event), delta, layers !== undefined, inversion);
      retained.desired = current;
      retained.gesturePending = true;
      retained.resetPending = resetPending = false;
      scheduler.change(); showPreview();
    };
    resetView.current = () => {
      if (persistence.current.readOnly || !full) return;
      retained.gesturePending = true;
      retained.desired = current = full;
      retained.resetPending = resetPending = true;
      scheduler.change(); showPreview();
    };
    plotElement.addEventListener("pointerdown", down);
    plotElement.addEventListener("pointermove", move);
    plotElement.addEventListener("pointerup", end);
    plotElement.addEventListener("pointercancel", end);
    plotElement.addEventListener("lostpointercapture", end);
    plotElement.addEventListener("wheel", wheel, { passive: false });

    const launchOverscan = (basePresented: CameraDomain, baseFull: CameraDomain, basePlot: PlotRect, cameraGeneration: number) => {
      if (disposed || persistence.current.readOnly || typeof graphNewService.renderOverscan !== "function") return;
      const overscan = overscanCamera(basePresented, baseFull, layers !== undefined);
      if (!overscan) return;
      const viewport = overscanViewport(basePlot, size.devicePixelRatio, overscan.factor);
      if (!viewport) return;
      cancelOverscan();
      let cancelled = false;
      let controller: GraphNewRenderController | null = null;
      let resolveFrame: (frame: GraphNewFrame | null) => void = () => {};
      const frameReady = new Promise<GraphNewFrame | null>((resolve) => { resolveFrame = resolve; });
      const handle = {
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          resolveFrame(null);
          void controller?.cancel(true).catch(() => {});
        },
      };
      overscanJob = handle;
      void (async () => {
        let bitmap: ImageBitmap | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const generation = ++rendererGeneration;
          const request: GraphNewRenderRequest = {
            sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, layers,
            layerConfigurationId: layers === undefined ? undefined : JSON.stringify(layers),
            showMean, pointRadius, xMode, rawMode, overlayColumnId,
            hiddenOverlayGroupIds: [...hiddenOverlayGroupIds],
            ...viewport,
            ...(darkTheme ? { darkTheme } : {}),
            plotOnly: true,
            hideChrome: true,
            ...(invertX ? { invertX } : {}),
            ...(invertY ? { invertY } : {}),
            ...(axisBounds ? { axisBounds } : {}),
            requestId: `${sessionId}:${generation}`,
            rendererGeneration: generation,
            cameraGeneration,
            cameraDomain: overscan.domain,
            referenceDomain: basePresented,
          };
          controller = graphNewService.renderOverscan(request, {
            activeIdentity: () => ({ ...request, cameraGeneration: scheduler.generation() }),
            onFrame: (frame) => { if (!cancelled) resolveFrame(frame); },
            onError: () => { resolveFrame(null); },
          });
          const completion = await controller.completion;
          if (cancelled || disposed || pointer) return;
          timer = setTimeout(() => { resolveFrame(null); }, 5000);
          const frame = await frameReady;
          clearTimeout(timer);
          if (cancelled || disposed || pointer || !frame
            || completion.requestId !== request.requestId
            || !scheduler.isCurrent(cameraGeneration)
            || presented !== basePresented
            || !controller.canPresent(frame.header)) return;
          bitmap = frame.header.format === "rgba8"
            ? await createImageBitmap(new ImageData(new Uint8ClampedArray(frame.payload), frame.header.width, frame.header.height))
            : await createImageBitmap(new Blob([frame.payload], { type: "image/png" }));
          if (cancelled || disposed || pointer || !scheduler.isCurrent(cameraGeneration)
            || presented !== basePresented || !preview.current || !controller.canPresent(frame.header)) return;
          preview.current.width = frame.header.width;
          preview.current.height = frame.header.height;
          preview.current.getContext("2d")?.drawImage(bitmap, 0, 0);
          previewDomain = overscan.domain;
          if (presentedAxes && completion.xAxis.kind === "category") {
            for (const tick of completion.xAxis.ticks) {
              if (tick.label !== null) presentedAxes.categoryLabels.set(tick.value, tick.label);
            }
          }
          controller.markPresented(frame.header, performance.now());
        } catch {
          // Overscan is a best-effort background optimization; visible frame remains authoritative.
        } finally {
          clearTimeout(timer);
          bitmap?.close();
          if (overscanJob === handle) overscanJob = null;
        }
      })();
    };

    const launch = (cameraDomain: CameraDomain | null, cameraGeneration: number) => {
    cancelOverscan();
    let cancelled = false;
    let preserved = false;
    let controller: GraphNewRenderController | null = null;
    let resolveFrame: (frame: GraphNewFrame | null) => void = () => {};
    const frameReady = new Promise<GraphNewFrame | null>((resolve) => { resolveFrame = resolve; });
    const job: RenderJob = {
      cancel: (preserveCache = false) => {
        if (cancelled && (preserveCache || !preserved)) return;
        cancelled = true;
        preserved = preserveCache;
        resolveFrame(null);
        void controller?.cancel(preserveCache).catch(() => {});
      },
      run: async () => {
        if (cancelled) return;
        if (!presented || layers !== undefined) setStatus(t("graphNew.rendering", {defaultValue:"Rendering..."}));
        setReason(null);
        const generation = ++rendererGeneration;
        const request: GraphNewRenderRequest = {
          sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, layers, layerConfigurationId: layers === undefined ? undefined : JSON.stringify(layers), showMean, pointRadius, xMode, rawMode, overlayColumnId, hiddenOverlayGroupIds: [...hiddenOverlayGroupIds], ...size,
          ...(darkTheme ? { darkTheme } : {}),
          hideChrome: true,
          ...(invertX ? { invertX } : {}),
          ...(invertY ? { invertY } : {}),
          ...(axisBounds ? { axisBounds } : {}),
          requestId: `${sessionId}:${generation}`, rendererGeneration: generation, cameraGeneration, cameraDomain,
        };
        let bitmap: ImageBitmap | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let failureReason: string | null = null;
        try {
          controller = graphNewService.render(request, {
            activeIdentity: () => ({ ...request, cameraGeneration: scheduler.generation() }),
            onFrame: (frame) => { if (!cancelled) resolveFrame(frame); },
            onError: (error) => { failureReason = error; resolveFrame(null); },
          });
          const completion = await controller.completion;
          if (cancelled) return;
          timer = setTimeout(() => {
            failureReason = "graph_new_frame_timeout";
            resolveFrame(null);
          }, 5000);
          const frame = await frameReady;
          clearTimeout(timer);
          if (cancelled) return;
          if (!frame) throw new Error(failureReason ?? "graph_new_render_failed");
          if (completion.requestId !== request.requestId
            || frame.header.width !== Math.ceil(size.width * size.devicePixelRatio)
            || frame.header.height !== Math.ceil(size.height * size.devicePixelRatio)
            || completion.width !== frame.header.width || completion.height !== frame.header.height
            || !controller.canPresent(frame.header)) throw new Error("graph_new_frame_mismatch");
          try {
            bitmap = frame.header.format === "rgba8"
              ? await createImageBitmap(new ImageData(new Uint8ClampedArray(frame.payload), frame.header.width, frame.header.height))
              : await createImageBitmap(new Blob([frame.payload], { type: "image/png" }));
          } catch {
            throw new Error("graph_new_decode_failed");
          }
          if (cancelled || !scheduler.isCurrent(cameraGeneration) || !controller.canPresent(frame.header) || !canvas.current || !preview.current) return;
          const context = canvas.current.getContext("2d");
          if (!context) throw new Error("graph_new_canvas_unavailable");
          canvas.current.width = frame.header.width;
          canvas.current.height = frame.header.height;
          context.drawImage(bitmap, 0, 0);
          frameWidth = frame.header.width; frameHeight = frame.header.height;
          plot = completion.plotRect;
          if (isCameraDomain(completion.cameraDomain)) {
            presented = completion.cameraDomain; current = presented;
            if (cameraDomain === null) full = presented;
          } else { presented = null; current = null; full = null; }
          retained.full = full;
          retained.desired = current;
          retained.presented = presented;
          const categoryLabels = new Map<number, string>();
          if (completion.xAxis.kind === "category") {
            for (const tick of completion.xAxis.ticks) {
              if (tick.label !== null) categoryLabels.set(tick.value, tick.label);
            }
          }
          presentedAxes = { x: completion.xAxis, y: completion.yAxis, categoryLabels };
          const { scale, left, top } = geometry();
          let pendingRestoreCamera: CameraDomain | null = null;
          if (cameraDomain === null && retained.restorePending) {
            const modeCamera = retained.restoreCamera;
            const saved = modeCamera ?? persistence.current.savedCamera;
            const overlapsNewData = !modeCamera || !full || (
              modeCamera.xMax > full.xMin && modeCamera.xMin < full.xMax
              && modeCamera.yMax > full.yMin && modeCamera.yMin < full.yMax);
            if (saved && full && overlapsNewData && isRestorableCamera(saved, full, layers !== undefined)) {
              pendingRestoreCamera = saved;
            }
          }
          if (presented) publishChrome(pendingRestoreCamera ?? presented);
          setRawAvailable(completion.rawLineAvailable !== false);
          setOverlayState({ active: completion.overlayActive, groups: completion.overlayGroups });
          plotElement.style.left = `${left + plot.x * scale}px`;
          plotElement.style.top = `${top + plot.y * scale}px`;
          plotElement.style.width = `${plot.width * scale}px`;
          plotElement.style.height = `${plot.height * scale}px`;
          plotElement.style.visibility = current ? "visible" : "hidden";
          preview.current.width = plot.width; preview.current.height = plot.height;
          preview.current.getContext("2d")?.drawImage(bitmap, plot.x, plot.y, plot.width, plot.height, 0, 0, plot.width, plot.height);
          previewDomain = presented;
          preview.current.style.transform = "none";
          if (raf !== null) cancelAnimationFrame(raf);
          raf = null; retained.resetPending = resetPending = false;
          element.removeAttribute("data-provisional");
          setProvisional(false); setCameraAvailable(current !== null);
          controller.markPresented(frame.header, performance.now());
          setHasFrame(true);
          let willRestore = false;
          setMeanFrame({ available: completion.meanAvailable === true, visible: completion.meanVisible === true, groups: completion.meanGroups ?? null });
          setLayerWarning(completion.layerStates?.some(state => state.reason === "graph_new_jitter_budget") ? t("graphNew.jitterBudget") : null);
          retriedCameraGeneration = null;
          const visibleStatus = completion.visibleRows === null
            ? `${completion.selectedMarks.toLocaleString()} submitted; visible count unknown`
            : `${completion.visibleRows.toLocaleString()} visible; ${completion.selectedMarks.toLocaleString()} submitted`;
          setStatus(completion.pixelAggregated
            ? `Full data: ${completion.visibleRows?.toLocaleString()} visible points; ${layers?.some(layer => layer.kind !== "points" || layer.options.summaryStat !== "none") ? `${layers.length} layers` : `${completion.selectedMarks.toLocaleString()} colored pixels`}; ${completion.excludedNonFiniteRows.toLocaleString()} excluded`
            : `${completion.exactVisible ? "Exact" : "Approximate LOD"}: ${visibleStatus}; ${completion.excludedNonFiniteRows.toLocaleString()} excluded`);
          if (cameraDomain === null && retained.restorePending) {
            retained.restorePending = false;
            const modeCamera = retained.restoreCamera;
            retained.restoreCamera = null;
            const saved = modeCamera ?? persistence.current.savedCamera;
            const overlapsNewData = !modeCamera || !full || (
              modeCamera.xMax > full.xMin && modeCamera.xMin < full.xMax
              && modeCamera.yMax > full.yMin && modeCamera.yMin < full.yMax);
            if (saved && full && overlapsNewData && isRestorableCamera(saved, full, layers !== undefined)) {
              willRestore = true;
              retained.desired = current = saved;
              if (modeCamera && !persistence.current.readOnly) persistence.current.onCameraChange?.(saved);
              launch(saved, scheduler.generation());
            } else if (modeCamera) {
              if (!persistence.current.readOnly) persistence.current.onCameraChange?.(null);
            } else if (saved) {
              setCameraRestoreRejected(true);
            }
          }
          if (!willRestore && presented && full && plot && !pointer && scheduler.isCurrent(cameraGeneration)) {
            launchOverscan(presented, full, plot, cameraGeneration);
          }
        } catch (error) {
          if (!cancelled) {
            const errorCode = failureReason ?? (error instanceof Error ? error.message : "graph_new_render_failed");
            const transient = ["graph_new_cancelled", "graph_new_stale_dataset", "graph_new_busy", "graph_new_channel_closed"].includes(errorCode);
            const genericReplacementFailure = errorCode === "graph_new_render_failed"
              && controller?.diagnostic() === "backend_render_failed"
              && presented !== null && cameraDomain !== null;
            if (transient || genericReplacementFailure) {
              console.info("Graph New recoverable replacement failure", errorCode, controller?.snapshot());
              if (preview.current) preview.current.style.transform = "none";
              element.removeAttribute("data-provisional");
              setProvisional(false);
              setReason(null);
              if (current && scheduler.isCurrent(cameraGeneration) && retriedCameraGeneration !== cameraGeneration) {
                retriedCameraGeneration = cameraGeneration;
                retryTimer = setTimeout(() => {
                  retryTimer = null;
                  if (!disposed && current && scheduler.isCurrent(cameraGeneration)) launch(current, cameraGeneration);
                }, 50);
              } else if (genericReplacementFailure) {
                setStatus("Showing the previous frame; the latest view is unavailable.");
              }
              return;
            }
            const missing = errorCode === "graph_new_missing_cache";
            const unrepresentable = errorCode === "graph_new_x_unrepresentable";
            const layerOverflow = errorCode === "graph_new_layer_overflow";
            const cachePressure = errorCode === "graph_new_cache_pressure";
            const gpuValidation = errorCode === "graph_new_gpu_validation";
            const overlayTooMany = errorCode === "graph_new_overlay_too_many_groups";
            const overlayValueTooLarge = errorCode === "graph_new_overlay_value_too_large";
            const frameTimeout = errorCode === "graph_new_frame_timeout";
            const frameMismatch = errorCode === "graph_new_frame_mismatch";
            const decodeFailed = errorCode === "graph_new_decode_failed";
            const canvasUnavailable = errorCode === "graph_new_canvas_unavailable";
            console.error("Graph New render failure", errorCode);
            setReason(missing
              ? "graph_new_missing_cache"
              : unrepresentable
                ? "graph_new_x_unrepresentable"
                : cachePressure
                  ? "graph_new_cache_pressure"
                  : gpuValidation
                    ? "graph_new_gpu_validation"
                : overlayTooMany
                  ? "graph_new_overlay_too_many_groups"
                  : overlayValueTooLarge
                    ? "graph_new_overlay_value_too_large"
                    : frameTimeout || frameMismatch || decodeFailed || canvasUnavailable
                      ? errorCode
                      : "graph_new_render_failed");
            setStatus(missing
              ? "Camera cache unavailable. Reset view to rebuild."
              : unrepresentable
                ? t("graphNew.xUnrepresentable", { defaultValue: "X values exceed the bounded categorical axis capacity." })
                : layerOverflow
                  ? t("graphNew.layerOverflow")
                : cachePressure
                  ? t("graphNew.cachePressure", { defaultValue: "Plot exceeded the render memory budget. Hide layers or reset the view." })
                  : gpuValidation
                    ? t("graphNew.gpuValidation", { defaultValue: "Plot rendering failed GPU validation. Hide layers or reset the view." })
                : overlayTooMany
                  ? t("graphNew.overlayTooManyGroups")
                  : overlayValueTooLarge
                    ? t("graphNew.overlayValueTooLarge")
                    : frameTimeout
                      ? "Plot frame timed out."
                      : frameMismatch
                        ? "Plot frame did not match the render request."
                        : decodeFailed
                          ? "Plot frame could not be decoded."
                          : canvasUnavailable
                            ? "Plot canvas is unavailable."
                            : "Plot could not be rendered.");
          }
        } finally {
          clearTimeout(timer);
          bitmap?.close();
        }
      },
    };
    currentJob = job;
    enqueue(job);
    };
    if (retained.gesturePending) scheduler.change();
    else launch(resetPending ? null : current, scheduler.generation());
    return () => {
      disposed = true;
      cancelOverscan();
      scheduler.dispose(); currentJob?.cancel();
      if (pendingJob === currentJob) pendingJob = null;
      if (raf !== null) cancelAnimationFrame(raf);
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (pointer && plotElement.hasPointerCapture(pointer.id)) plotElement.releasePointerCapture(pointer.id);
      plotElement.removeEventListener("pointerdown", down); plotElement.removeEventListener("pointermove", move);
      plotElement.removeEventListener("pointerup", end); plotElement.removeEventListener("pointercancel", end);
      plotElement.removeEventListener("lostpointercapture", end); plotElement.removeEventListener("wheel", wheel);
      resetView.current = () => {};
    };
  }, [sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, overlayColumnId, hiddenOverlayGroupIds, size, showMean, pointRadius, xMode, rawMode, layers, darkTheme, invertX, invertY, axisBoundsKey, t]);

  const chromeRender = useMemo(() => {
    let activeSnapshot = chromeSnapshot;
    let provisionalUnknownX = false;
    let provisionalUnknownY = false;

    if (!activeSnapshot && size) {
      const hostWidth = host.current?.clientWidth || size.width;
      const hostHeight = host.current?.clientHeight || size.height;
      const plotLeft = Math.min(64, Math.max(0, hostWidth - 32));
      const plotTop = 16;
      const plotWidth = Math.max(16, hostWidth - plotLeft - 16);
      const plotHeight = Math.max(16, hostHeight - plotTop - 32);

      const allowCustomX = xMode !== "category" && xMode !== "time";
      const customXValid = allowCustomX
        && typeof xAxisConfig?.min === "number" && Number.isFinite(xAxisConfig.min)
        && typeof xAxisConfig?.max === "number" && Number.isFinite(xAxisConfig.max)
        && xAxisConfig.min < xAxisConfig.max;
      const customYValid = typeof yAxisConfig?.min === "number" && Number.isFinite(yAxisConfig.min)
        && typeof yAxisConfig?.max === "number" && Number.isFinite(yAxisConfig.max)
        && yAxisConfig.min < yAxisConfig.max;
      const validSaved = savedCamera && isCameraDomain(savedCamera) ? savedCamera : null;

      const xMin = validSaved ? validSaved.xMin : customXValid ? xAxisConfig!.min! : 0;
      const xMax = validSaved ? validSaved.xMax : customXValid ? xAxisConfig!.max! : 1;
      const yMin = validSaved ? validSaved.yMin : customYValid ? yAxisConfig!.min! : 0;
      const yMax = validSaved ? validSaved.yMax : customYValid ? yAxisConfig!.max! : 1;
      provisionalUnknownX = !customXValid && !validSaved;
      provisionalUnknownY = !customYValid && !validSaved;

      const buildProvisionalTicks = (min: number, max: number, known: boolean) =>
        known
          ? [0, 0.25, 0.5, 0.75, 1].map((pos) => {
            const value = min + pos * (max - min);
            return { value, position: pos, label: String(Number(value.toPrecision(6))) };
          })
          : [];

      const provisionalKind: GraphNewAxis["kind"] = xMode === "auto" ? "numeric" : xMode;
      const provisionalDomain: CameraDomain = { xMin, xMax, yMin, yMax };
      activeSnapshot = {
        plotLeft,
        plotTop,
        plotWidth,
        plotHeight,
        hostWidth,
        hostHeight,
        xAxis: {
          kind: provisionalKind,
          utc: provisionalKind === "time",
          ticks: provisionalKind === "numeric" ? buildProvisionalTicks(xMin, xMax, !provisionalUnknownX) : [],
        },
        yAxis: {
          kind: "numeric",
          utc: false,
          ticks: buildProvisionalTicks(yMin, yMax, !provisionalUnknownY),
        },
        categoryLabels: new Map(),
        presentedDomain: provisionalDomain,
        liveDomain: provisionalDomain,
      };
    }

    if (!activeSnapshot) return null;
    const {
      plotLeft, plotTop, plotWidth, plotHeight, hostWidth, hostHeight,
      xAxis, yAxis, categoryLabels, presentedDomain, liveDomain,
    } = activeSnapshot;
    const xLayout = computeAxisLayout({
      axis: "x",
      axisMeta: xAxis,
      currentMin: liveDomain.xMin,
      currentMax: liveDomain.xMax,
      refMin: presentedDomain.xMin,
      refMax: presentedDomain.xMax,
      config: provisionalUnknownX ? { ...xAxisConfig, tickInterval: undefined } : xAxisConfig,
      refLines: provisionalUnknownX ? [] : refLinesX,
      autoSpecLines: provisionalUnknownX ? false : autoSpecLinesX,
      resolvedAutoSpec: resolvedAutoSpecX,
      categoryLabels,
      formatTick: formatGraphNewTick,
    });
    const yLayout = computeAxisLayout({
      axis: "y",
      axisMeta: yAxis,
      currentMin: liveDomain.yMin,
      currentMax: liveDomain.yMax,
      refMin: presentedDomain.yMin,
      refMax: presentedDomain.yMax,
      config: provisionalUnknownY ? { ...yAxisConfig, tickInterval: undefined } : yAxisConfig,
      refLines: provisionalUnknownY ? [] : refLinesY,
      autoSpecLines: provisionalUnknownY ? false : autoSpecLinesY,
      resolvedAutoSpec: resolvedAutoSpecY,
      formatTick: formatGraphNewTick,
    });
    if (provisionalUnknownX && xLayout.showMajorGrid && xLayout.majorGridPositions.length === 0) {
      xLayout.majorGridPositions = [0, 0.25, 0.5, 0.75, 1];
    }
    if (provisionalUnknownY && yLayout.showMajorGrid && yLayout.majorGridPositions.length === 0) {
      yLayout.majorGridPositions = [0, 0.25, 0.5, 0.75, 1];
    }
    const context = canvas.current?.getContext("2d");
    const fontFamily = host.current ? getComputedStyle(host.current).fontFamily : "sans-serif";
    if (context) context.font = `11px ${fontFamily}`;
    const measure = (text: string) => context ? Math.ceil(context.measureText(text).width) : text.length * 7;

    let previousEnd = -Infinity;
    const xLabels = [...xLayout.majorTicks]
      .sort((a, b) => a.screenPosition - b.screenPosition)
      .flatMap((tick) => {
        const width = Math.min(xAxis.kind === "category" ? 170 : Infinity, measure(tick.label) + 8, hostWidth);
        const position = Math.max(0, Math.min(hostWidth - width, plotLeft + tick.screenPosition * plotWidth - width / 2));
        if (!tick.label || position < previousEnd + 8) return [];
        previousEnd = position + width;
        return [{ label: tick.label, left: position, top: plotTop + plotHeight + 5, width }];
      });

    previousEnd = -Infinity;
    const yLabels = yLayout.majorTicks
      .map((tick) => {
        const width = Math.min(measure(tick.label) + 8, Math.max(0, plotLeft - 4));
        return {
          label: tick.label,
          left: Math.max(0, plotLeft - width - 6),
          top: plotTop + (1 - tick.screenPosition) * plotHeight - 7,
          width,
        };
      })
      .sort((a, b) => a.top - b.top)
      .flatMap((tick) => {
        if (!tick.label || tick.width === 0 || tick.top < previousEnd + 4) return [];
        previousEnd = tick.top + 14;
        return [tick];
      });

    return { plotLeft, plotTop, plotWidth, plotHeight, hostWidth, hostHeight, xLayout, yLayout, xLabels, yLabels };
  }, [
    chromeSnapshot,
    size,
    xMode,
    savedCamera,
    xAxisConfig,
    yAxisConfig,
    refLinesX,
    refLinesY,
    autoSpecLinesX,
    autoSpecLinesY,
    resolvedAutoSpecX,
    resolvedAutoSpecY,
  ]);

  const axisInk = darkTheme ? "#aaaaaa" : "#475569";
  const clipId = `gbn-plot-clip-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const controls = (<>
        <button className="graph-new-reset" aria-label="Reset view" title="Reset view" disabled={readOnly || !cameraAvailable} onClick={() => resetView.current()}>
          <i className="fa-solid fa-rotate-left" aria-hidden="true" />
        </button>
        <span className="graph-new-frame-status" role={reason ? "alert" : "status"} data-reason={reason}>
          {cameraRestoreRejected && !reason ? <span data-testid="camera-restore-unavailable">{t("graphNew.cameraUnavailable")}</span>
            : provisional ? `Axes frozen; previewing view while the next frame renders. ${reason ? status : ""}` : status}
        </span>
  </>);

  return (
    <div className="graph-new-chart">
      {layers === undefined && <div className="graph-new-layers" aria-label={t("graphNew.layers")}>
        {rawMode !== "line" && <span className="graph-new-legend-item"><span className="graph-new-point-swatch" aria-hidden="true" />{t("graphNew.points")}</span>}
        {rawMode !== "scatter" && <span className="graph-new-legend-item"><span className="graph-new-line-swatch" aria-hidden="true" />{t("graphNew.rawLine", { defaultValue: "Raw line" })}</span>}
        {rawMode !== "scatter" && !rawAvailable && <span role="status" data-testid="raw-line-unavailable">{t("graphNew.rawUnavailable", { defaultValue: "Raw line unavailable for this view." })}</span>}
        {meanFrame?.visible && <span className="graph-new-legend-item" data-testid="mean-legend">
          <span className="graph-new-mean-swatch" aria-hidden="true" />{t("graphNew.mean")}
        </span>}
        {meanFrame?.available === false && <span className="graph-new-mean-reason" data-testid="mean-unavailable">{t("graphNew.meanUnavailable")}</span>}
        {showMean && meanFrame?.available && meanFrame.groups !== null && meanFrame.groups < 2
          && <span className="graph-new-mean-reason">{t("graphNew.meanNeedsGroups")}</span>}
      </div>}
      <div className="graph-new-canvas-host" ref={host}>
        <canvas ref={canvas} role="img" aria-label="Point plot frame" style={{ visibility: hasFrame ? "visible" : "hidden" }} />
        <div ref={plotHost} className="graph-new-camera-plot" data-testid="camera-plot">
          <canvas ref={preview} className="graph-new-camera-preview" data-testid="camera-preview" aria-hidden="true" />
        </div>
        {chromeRender && (
          <>
            <svg className="graph-new-svg-layer" data-testid="graph-new-grid-svg" aria-hidden="true">
              <defs>
                <clipPath id={clipId}>
                  <rect x={chromeRender.plotLeft} y={chromeRender.plotTop} width={chromeRender.plotWidth} height={chromeRender.plotHeight} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${clipId})`}>
                {chromeRender.xLayout.minorGridPositions.map((pos, idx) => (
                  <line
                    key={`x-minor-grid-${idx}`}
                    data-grid="x-minor"
                    x1={chromeRender.plotLeft + pos * chromeRender.plotWidth}
                    y1={chromeRender.plotTop}
                    x2={chromeRender.plotLeft + pos * chromeRender.plotWidth}
                    y2={chromeRender.plotTop + chromeRender.plotHeight}
                    stroke={chromeRender.xLayout.minorGridStyle.color}
                    strokeOpacity={0.5}
                    strokeWidth={Math.max(0.4, chromeRender.xLayout.minorGridStyle.width * 0.6)}
                    strokeDasharray={strokeDashArrayForStyle(chromeRender.xLayout.minorGridStyle.style)}
                  />
                ))}
                {chromeRender.yLayout.minorGridPositions.map((pos, idx) => (
                  <line
                    key={`y-minor-grid-${idx}`}
                    data-grid="y-minor"
                    x1={chromeRender.plotLeft}
                    y1={chromeRender.plotTop + (1 - pos) * chromeRender.plotHeight}
                    x2={chromeRender.plotLeft + chromeRender.plotWidth}
                    y2={chromeRender.plotTop + (1 - pos) * chromeRender.plotHeight}
                    stroke={chromeRender.yLayout.minorGridStyle.color}
                    strokeOpacity={0.5}
                    strokeWidth={Math.max(0.4, chromeRender.yLayout.minorGridStyle.width * 0.6)}
                    strokeDasharray={strokeDashArrayForStyle(chromeRender.yLayout.minorGridStyle.style)}
                  />
                ))}
                {chromeRender.xLayout.majorGridPositions.map((pos, idx) => (
                  <line
                    key={`x-major-grid-${idx}`}
                    data-grid="x-major"
                    x1={chromeRender.plotLeft + pos * chromeRender.plotWidth}
                    y1={chromeRender.plotTop}
                    x2={chromeRender.plotLeft + pos * chromeRender.plotWidth}
                    y2={chromeRender.plotTop + chromeRender.plotHeight}
                    stroke={chromeRender.xLayout.majorGridStyle.color}
                    strokeOpacity={0.65}
                    strokeWidth={Math.max(0.5, chromeRender.xLayout.majorGridStyle.width * 0.75)}
                    strokeDasharray={strokeDashArrayForStyle(chromeRender.xLayout.majorGridStyle.style)}
                  />
                ))}
                {chromeRender.yLayout.majorGridPositions.map((pos, idx) => (
                  <line
                    key={`y-major-grid-${idx}`}
                    data-grid="y-major"
                    x1={chromeRender.plotLeft}
                    y1={chromeRender.plotTop + (1 - pos) * chromeRender.plotHeight}
                    x2={chromeRender.plotLeft + chromeRender.plotWidth}
                    y2={chromeRender.plotTop + (1 - pos) * chromeRender.plotHeight}
                    stroke={chromeRender.yLayout.majorGridStyle.color}
                    strokeOpacity={0.65}
                    strokeWidth={Math.max(0.5, chromeRender.yLayout.majorGridStyle.width * 0.75)}
                    strokeDasharray={strokeDashArrayForStyle(chromeRender.yLayout.majorGridStyle.style)}
                  />
                ))}
              </g>
            </svg>
            <svg className="graph-new-svg-layer" data-testid="graph-new-reflines-svg" aria-hidden="true">
              <g clipPath={`url(#${clipId})`}>
                {chromeRender.yLayout.refLines.map((line) => {
                  const y = chromeRender.plotTop + (1 - line.screenPosition) * chromeRender.plotHeight;
                  return (
                    <g key={`ref-y-${line.id}`} data-refline-axis="y">
                      <line
                        x1={chromeRender.plotLeft}
                        y1={y}
                        x2={chromeRender.plotLeft + chromeRender.plotWidth}
                        y2={y}
                        stroke={line.color}
                        strokeWidth={line.width}
                        strokeDasharray={strokeDashArrayForStyle(line.style)}
                      />
                      {line.label.trim() !== "" && (
                        <text
                          className="graph-new-refline-label"
                          x={chromeRender.plotLeft + chromeRender.plotWidth - 4}
                          y={Math.max(chromeRender.plotTop + 11, y - 3)}
                          textAnchor="end"
                          fill={line.color}
                        >
                          {line.label}
                        </text>
                      )}
                    </g>
                  );
                })}
                {chromeRender.xLayout.refLines.map((line) => {
                  const x = chromeRender.plotLeft + line.screenPosition * chromeRender.plotWidth;
                  return (
                    <g key={`ref-x-${line.id}`} data-refline-axis="x">
                      <line
                        x1={x}
                        y1={chromeRender.plotTop}
                        x2={x}
                        y2={chromeRender.plotTop + chromeRender.plotHeight}
                        stroke={line.color}
                        strokeWidth={line.width}
                        strokeDasharray={strokeDashArrayForStyle(line.style)}
                      />
                      {line.label.trim() !== "" && (
                        <text
                          className="graph-new-refline-label"
                          x={Math.min(chromeRender.plotLeft + chromeRender.plotWidth - 4, x + 4)}
                          y={chromeRender.plotTop + 12}
                          textAnchor="start"
                          fill={line.color}
                        >
                          {line.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
            <svg className="graph-new-svg-layer" data-testid="graph-new-axis-svg" aria-hidden="true">
              {chromeRender.yLayout.showAxisLine && (
                <g data-axis-line="y" data-tick-position={chromeRender.yLayout.tickPosition}>
                  <line
                    x1={chromeRender.plotLeft}
                    y1={chromeRender.plotTop}
                    x2={chromeRender.plotLeft}
                    y2={chromeRender.plotTop + chromeRender.plotHeight}
                    stroke={axisInk}
                    strokeWidth={1}
                  />
                  {chromeRender.yLayout.majorTicks.map((tick, idx) => {
                    const y = chromeRender.plotTop + (1 - tick.screenPosition) * chromeRender.plotHeight;
                    const dx = chromeRender.yLayout.tickPosition === "inside" ? 5 : -5;
                    return <line key={`y-maj-t-${idx}`} data-tick="y-major" x1={chromeRender.plotLeft} y1={y} x2={chromeRender.plotLeft + dx} y2={y} stroke={axisInk} strokeWidth={1} />;
                  })}
                  {chromeRender.yLayout.minorPositions.map((pos, idx) => {
                    const y = chromeRender.plotTop + (1 - pos) * chromeRender.plotHeight;
                    const dx = chromeRender.yLayout.tickPosition === "inside" ? 3 : -3;
                    return <line key={`y-min-t-${idx}`} data-tick="y-minor" x1={chromeRender.plotLeft} y1={y} x2={chromeRender.plotLeft + dx} y2={y} stroke={axisInk} strokeWidth={1} />;
                  })}
                </g>
              )}
              {chromeRender.xLayout.showAxisLine && (
                <g data-axis-line="x" data-tick-position={chromeRender.xLayout.tickPosition}>
                  <line
                    x1={chromeRender.plotLeft}
                    y1={chromeRender.plotTop + chromeRender.plotHeight}
                    x2={chromeRender.plotLeft + chromeRender.plotWidth}
                    y2={chromeRender.plotTop + chromeRender.plotHeight}
                    stroke={axisInk}
                    strokeWidth={1}
                  />
                  {chromeRender.xLayout.majorTicks.map((tick, idx) => {
                    const x = chromeRender.plotLeft + tick.screenPosition * chromeRender.plotWidth;
                    const dy = chromeRender.xLayout.tickPosition === "inside" ? -5 : 5;
                    return <line key={`x-maj-t-${idx}`} data-tick="x-major" x1={x} y1={chromeRender.plotTop + chromeRender.plotHeight} x2={x} y2={chromeRender.plotTop + chromeRender.plotHeight + dy} stroke={axisInk} strokeWidth={1} />;
                  })}
                  {chromeRender.xLayout.minorPositions.map((pos, idx) => {
                    const x = chromeRender.plotLeft + pos * chromeRender.plotWidth;
                    const dy = chromeRender.xLayout.tickPosition === "inside" ? -3 : 3;
                    return <line key={`x-min-t-${idx}`} data-tick="x-minor" x1={x} y1={chromeRender.plotTop + chromeRender.plotHeight} x2={x} y2={chromeRender.plotTop + chromeRender.plotHeight + dy} stroke={axisInk} strokeWidth={1} />;
                  })}
                </g>
              )}
            </svg>
            {onXAxisDblClick && (
              <div
                className="graph-new-axis-hit-band"
                data-testid="x-axis-hit-band"
                title={t("graph.xAxisSettings.dblClickHint", { defaultValue: "Double-click for X Axis Settings" })}
                style={{
                  left: chromeRender.plotLeft,
                  top: chromeRender.plotTop + chromeRender.plotHeight,
                  width: chromeRender.plotWidth,
                  height: Math.max(24, chromeRender.hostHeight - (chromeRender.plotTop + chromeRender.plotHeight)),
                }}
                onDoubleClick={onXAxisDblClick}
              />
            )}
            {onYAxisDblClick && (
              <div
                className="graph-new-axis-hit-band"
                data-testid="y-axis-hit-band"
                title={t("graph.yAxisSettings.dblClickHint", { defaultValue: "Double-click for Y Axis Settings" })}
                style={{
                  left: 0,
                  top: chromeRender.plotTop,
                  width: Math.max(40, chromeRender.plotLeft),
                  height: chromeRender.plotHeight,
                }}
                onDoubleClick={onYAxisDblClick}
              />
            )}
          </>
        )}
        <div className="graph-new-axis-ticks graph-new-x-axis-ticks" data-testid="x-axis-ticks">
          {(chromeRender?.xLabels ?? []).map((tick) => <span key={`${tick.left}:${tick.label}`} title={tick.label}
            style={{ left: tick.left, top: tick.top, width: tick.width }}>{tick.label}</span>)}
        </div>
        <div className="graph-new-axis-ticks graph-new-y-axis-ticks" data-testid="y-axis-ticks">
          {(chromeRender?.yLabels ?? []).map((tick) => <span key={`${tick.top}:${tick.label}`} title={tick.label}
            style={{ left: tick.left, top: tick.top, width: tick.width }}>{tick.label}</span>)}
        </div>

      </div>
      {layerWarning && <span role="status" className="graph-new-layer-warning">{layerWarning}</span>}
      {controlsHost ? createPortal(controls, controlsHost) : controls}
    </div>
  );
}