import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  graphNewService,
  type GraphNewAxis,
  type GraphNewOverlayGroup,
  type GraphNewRenderController,
  type GraphNewRenderRequest,
} from "@/services/graphNewService";
import type { GraphNewFrame } from "@/types/graphNew";
import { cameraTransform, createCameraScheduler, isCameraDomain, isRestorableCamera, panCamera, zoomCamera, type CameraDomain, type PlotRect } from "./graphNewCamera";

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

type Props = Pick<GraphNewRenderRequest, "datasetId" | "datasetGeneration" | "xColumnId" | "yColumnId" | "xMode" | "rawMode" | "overlayColumnId"> & {
  transportId: string;
  xTitle: string;
  yTitle: string;
  showMean: boolean;
  hiddenOverlayGroupIds?: string[];
  onMeanAvailabilityChange?: (available: boolean | null) => void;
  onOverlayStateChange?: (state: { active: boolean; groups: GraphNewOverlayGroup[] }) => void;
  savedCamera?: CameraDomain | null;
  readOnly?: boolean;
  onCameraChange?: (camera: CameraDomain | null) => void;
};

export function formatGraphNewTick(axis: GraphNewAxis, tick: GraphNewAxis["ticks"][number]): string {
  if (axis.kind === "category") return tick.label ?? "";
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

export function GraphNewCanvas({ transportId: sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, overlayColumnId = null, xTitle, yTitle, showMean, hiddenOverlayGroupIds = [], onMeanAvailabilityChange, onOverlayStateChange, xMode = "auto", rawMode = "scatter", savedCamera = null, readOnly = false, onCameraChange }: Props) {
  const { t } = useTranslation();
  const [meanFrame, setMeanFrame] = useState<{ available: boolean; visible: boolean; groups: number | null } | null>(null);
  const [overlayState, setOverlayState] = useState<{ active: boolean; groups: GraphNewOverlayGroup[] }>({ active: false, groups: [] });
  const [rawAvailable, setRawAvailable] = useState(true);
  const [axisLabels, setAxisLabels] = useState<{ label: string; left: number; top: number; width: number }[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const plotHost = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const resetView = useRef<() => void>(() => {});
  const cameraState = useRef<{ identity: string; full: CameraDomain | null; desired: CameraDomain | null; presented: CameraDomain | null; resetPending: boolean; restorePending: boolean; gesturePending: boolean } | null>(null);
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
  const [reason, setReason] = useState<string | null>(null);
  const [provisional, setProvisional] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const measure = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
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
      }, 100);
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
    const identity = JSON.stringify([sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, overlayColumnId, xMode]);
    if (cameraState.current?.identity !== identity) {
      cameraState.current = { identity, full: null, desired: null, presented: null, resetPending: false, restorePending: true, gesturePending: false };
      setCameraRestoreRejected(false);
    }
    const retained = cameraState.current;
    let disposed = false;
    let currentJob: RenderJob | null = null;
    let full: CameraDomain | null = retained.full;
    let presented: CameraDomain | null = null;
    let current: CameraDomain | null = retained.desired;
    let plot: PlotRect | null = null;
    let frameWidth = 0;
    let frameHeight = 0;
    let raf: number | null = null;
    let pointer: { id: number; x: number; y: number } | null = null;
    let resetPending = retained.resetPending;
    setCameraAvailable(full !== null);
    setProvisional(false);
    plotElement.style.visibility = "hidden";
    element.removeAttribute("data-provisional");
    const geometry = () => {
      const bounds = element.getBoundingClientRect();
      const scale = Math.min(bounds.width / frameWidth, bounds.height / frameHeight);
      return { bounds, scale, left: (bounds.width - frameWidth * scale) / 2, top: (bounds.height - frameHeight * scale) / 2 };
    };
    const drawPreview = () => {
      raf = null;
      if (!presented || !current || !plot || !preview.current) return;
      const { scale } = geometry();
      const transform = cameraTransform(presented, current, plot);
      preview.current.style.transform = `translate(${transform.x * scale}px, ${transform.y * scale}px) scale(${transform.scale})`;
    };
    const showPreview = () => {
      element.dataset.provisional = "true";
      setProvisional(true);
      if (raf === null) raf = requestAnimationFrame(drawPreview);
    };
    const scheduler = createCameraScheduler({
      invalidate: () => { currentJob?.cancel(!disposed); if (pendingJob === currentJob) pendingJob = null; },
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
      current = panCamera(current, full, plot, next.x - pointer.x, next.y - pointer.y);
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
      current = zoomCamera(current, full, plot, physicalPointer(event), delta);
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

    const launch = (cameraDomain: CameraDomain | null, cameraGeneration: number) => {
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
        setStatus("Rendering...");
        setReason(null);
        const generation = ++rendererGeneration;
        const request: GraphNewRenderRequest = {
          sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, showMean, xMode, rawMode, overlayColumnId, hiddenOverlayGroupIds: [...hiddenOverlayGroupIds], ...size,
          requestId: `${sessionId}:${generation}`, rendererGeneration: generation, cameraGeneration, cameraDomain,
        };
        let bitmap: ImageBitmap | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          controller = graphNewService.render(request, {
            activeIdentity: () => ({ ...request, cameraGeneration: scheduler.generation() }),
            onFrame: (frame) => { if (!cancelled) resolveFrame(frame); },
            onError: () => { resolveFrame(null); },
          });
          const completion = await controller.completion;
          if (cancelled) return;
          timer = setTimeout(() => resolveFrame(null), 5000);
          const frame = await frameReady;
          clearTimeout(timer);
          if (cancelled) return;
          if (!frame || completion.requestId !== request.requestId
            || frame.header.width !== Math.ceil(size.width * size.devicePixelRatio)
            || frame.header.height !== Math.ceil(size.height * size.devicePixelRatio)
            || completion.width !== frame.header.width || completion.height !== frame.header.height
            || !controller.canPresent(frame.header)) throw new Error("graph_new_render_failed");
          bitmap = frame.header.format === "rgba8"
            ? await createImageBitmap(new ImageData(new Uint8ClampedArray(frame.payload), frame.header.width, frame.header.height))
            : await createImageBitmap(new Blob([frame.payload], { type: "image/png" }));
          if (cancelled || !scheduler.isCurrent(cameraGeneration) || !controller.canPresent(frame.header) || !canvas.current || !preview.current) return;
          const context = canvas.current.getContext("2d");
          if (!context) throw new Error("graph_new_render_failed");
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
          const { scale, left, top } = geometry();
          const axis = completion.xAxis;
          context.font = `11px ${getComputedStyle(element).fontFamily}`;
          let previousEnd = -Infinity;
          setAxisLabels(axis && axis.kind !== "numeric" ? axis.ticks.flatMap((tick) => {
            const label = formatGraphNewTick(axis, tick);
            const width = Math.min(axis.kind === "category" ? 170 : Infinity, Math.ceil(context.measureText(label).width) + 8, element.clientWidth);
            const position = Math.max(0, Math.min(element.clientWidth - width, left + (plot!.x + tick.position * plot!.width) * scale - width / 2));
            if (!label || position < previousEnd + 8) return [];
            previousEnd = position + width;
            return [{ label, left: position, top: top + (plot!.y + plot!.height) * scale + 5, width }];
          }) : []);
          setRawAvailable(completion.rawLineAvailable !== false);
          setOverlayState({ active: completion.overlayActive, groups: completion.overlayGroups });
          plotElement.style.left = `${left + plot.x * scale}px`;
          plotElement.style.top = `${top + plot.y * scale}px`;
          plotElement.style.width = `${plot.width * scale}px`;
          plotElement.style.height = `${plot.height * scale}px`;
          plotElement.style.visibility = current ? "visible" : "hidden";
          preview.current.width = plot.width; preview.current.height = plot.height;
          preview.current.getContext("2d")?.drawImage(bitmap, plot.x, plot.y, plot.width, plot.height, 0, 0, plot.width, plot.height);
          preview.current.style.transform = "none";
          if (raf !== null) cancelAnimationFrame(raf);
          raf = null; retained.resetPending = resetPending = false;
          element.removeAttribute("data-provisional");
          setProvisional(false); setCameraAvailable(current !== null);
          controller.markPresented(frame.header, performance.now());
          setHasFrame(true);
          setMeanFrame({ available: completion.meanAvailable === true, visible: completion.meanVisible === true, groups: completion.meanGroups ?? null });
          const visibleStatus = completion.visibleRows === null
            ? `${completion.selectedMarks.toLocaleString()} submitted; visible count unknown`
            : `${completion.visibleRows.toLocaleString()} visible; ${completion.selectedMarks.toLocaleString()} submitted`;
          setStatus(`${completion.exactVisible ? "Exact" : "Approximate LOD"}: ${visibleStatus}; ${completion.excludedNonFiniteRows.toLocaleString()} excluded`);
          if (cameraDomain === null && retained.restorePending) {
            retained.restorePending = false;
            const saved = persistence.current.savedCamera;
            if (saved && full && isRestorableCamera(saved, full)) {
              retained.desired = current = saved;
              launch(saved, scheduler.generation());
            } else if (saved) {
              setCameraRestoreRejected(true);
            }
          }
        } catch (error) {
          if (!cancelled) {
            const missing = error instanceof Error && error.message === "graph_new_missing_cache";
            const unrepresentable = error instanceof Error && error.message === "graph_new_x_unrepresentable";
            const cachePressure = error instanceof Error && error.message === "graph_new_cache_pressure";
            const gpuValidation = error instanceof Error && error.message === "graph_new_gpu_validation";
            const overlayTooMany = error instanceof Error && error.message === "graph_new_overlay_too_many_groups";
            const overlayValueTooLarge = error instanceof Error && error.message === "graph_new_overlay_value_too_large";
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
                    : "graph_new_render_failed");
            setStatus(missing
              ? "Camera cache unavailable. Reset view to rebuild."
              : unrepresentable
                ? t("graphNew.xUnrepresentable", { defaultValue: "X values exceed the bounded categorical axis capacity." })
                : cachePressure
                  ? t("graphNew.cachePressure", { defaultValue: "Plot exceeded the render memory budget. Hide layers or reset the view." })
                  : gpuValidation
                    ? t("graphNew.gpuValidation", { defaultValue: "Plot rendering failed GPU validation. Hide layers or reset the view." })
                : overlayTooMany
                  ? t("graphNew.overlayTooManyGroups")
                  : overlayValueTooLarge
                    ? t("graphNew.overlayValueTooLarge")
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
      scheduler.dispose(); currentJob?.cancel();
      if (pendingJob === currentJob) pendingJob = null;
      if (raf !== null) cancelAnimationFrame(raf);
      if (pointer && plotElement.hasPointerCapture(pointer.id)) plotElement.releasePointerCapture(pointer.id);
      plotElement.removeEventListener("pointerdown", down); plotElement.removeEventListener("pointermove", move);
      plotElement.removeEventListener("pointerup", end); plotElement.removeEventListener("pointercancel", end);
      plotElement.removeEventListener("lostpointercapture", end); plotElement.removeEventListener("wheel", wheel);
      resetView.current = () => {};
    };
  }, [sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, overlayColumnId, hiddenOverlayGroupIds, size, showMean, xMode, rawMode, t]);

  return (
    <div className="graph-new-chart">
      <div className="graph-new-layers" aria-label={t("graphNew.layers")}>
        {rawMode !== "line" && <span className="graph-new-legend-item"><span className="graph-new-point-swatch" aria-hidden="true" />{t("graphNew.points")}</span>}
        {rawMode !== "scatter" && <span className="graph-new-legend-item"><span className="graph-new-line-swatch" aria-hidden="true" />{t("graphNew.rawLine", { defaultValue: "Raw line" })}</span>}
        {rawMode !== "scatter" && !rawAvailable && <span role="status" data-testid="raw-line-unavailable">{t("graphNew.rawUnavailable", { defaultValue: "Raw line unavailable: complete data was not retained." })}</span>}
        {meanFrame?.visible && <span className="graph-new-legend-item" data-testid="mean-legend">
          <span className="graph-new-mean-swatch" aria-hidden="true" />{t("graphNew.mean")}
        </span>}
        {meanFrame?.available === false && <span className="graph-new-mean-reason" data-testid="mean-unavailable">{t("graphNew.meanUnavailable")}</span>}
        {showMean && meanFrame?.available && meanFrame.groups !== null && meanFrame.groups < 2
          && <span className="graph-new-mean-reason">{t("graphNew.meanNeedsGroups")}</span>}
      </div>
      <span className="graph-new-y-title" data-testid="y-axis-title">{yTitle}</span>
      <div className="graph-new-canvas-host" ref={host}>
        <canvas ref={canvas} role="img" aria-label="Point plot frame" style={{ visibility: hasFrame ? "visible" : "hidden" }} />
        <div className="graph-new-axis-ticks" data-testid="x-axis-ticks" style={{ visibility: provisional ? "hidden" : "visible" }}>
          {axisLabels.map((tick) => <span key={`${tick.left}:${tick.label}`} title={tick.label}
            style={{ left: tick.left, top: tick.top, width: tick.width }}>{tick.label}</span>)}
        </div>
        <div ref={plotHost} className="graph-new-camera-plot" data-testid="camera-plot">
          <canvas ref={preview} className="graph-new-camera-preview" data-testid="camera-preview" aria-hidden="true" />
        </div>
        <button className="graph-new-reset" aria-label="Reset view" title="Reset view" disabled={readOnly || !cameraAvailable} onClick={() => resetView.current()}>
          <i className="fa-solid fa-rotate-left" aria-hidden="true" />
        </button>
      </div>
      <span className="graph-new-x-title" data-testid="x-axis-title">{xTitle}</span>
      <span className="graph-new-frame-status" role={reason ? "alert" : "status"} data-reason={reason}>
        {cameraRestoreRejected && !reason ? <span data-testid="camera-restore-unavailable">{t("graphNew.cameraUnavailable")}</span>
          : provisional ? `Axes frozen; preview cropped; hatched area awaits frame. ${reason ? status : ""}` : status}
      </span>
    </div>
  );
}