import { useEffect, useRef, useState } from "react";

import { graphNewService, type GraphNewRenderController, type GraphNewRenderRequest } from "@/services/graphNewService";
import type { GraphNewFrame } from "@/types/graphNew";
import { cameraTransform, createCameraScheduler, isCameraDomain, panCamera, zoomCamera, type CameraDomain, type PlotRect } from "./graphNewCamera";

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

type Props = Pick<GraphNewRenderRequest, "sessionId" | "datasetId" | "datasetGeneration" | "xColumnId" | "yColumnId"> & {
  xTitle: string;
  yTitle: string;
};

export function GraphNewCanvas({ sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, xTitle, yTitle }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const plotHost = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const resetView = useRef<() => void>(() => {});
  const cameraState = useRef<{ identity: string; full: CameraDomain | null; desired: CameraDomain | null; resetPending: boolean } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number; devicePixelRatio: number } | null>(null);
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
    const identity = JSON.stringify([sessionId, datasetId, datasetGeneration, xColumnId, yColumnId]);
    if (cameraState.current?.identity !== identity) {
      cameraState.current = { identity, full: null, desired: null, resetPending: false };
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
      settled: (generation) => { if (!disposed && current) launch(resetPending ? null : current, generation); },
    });
    const physicalPointer = (event: { clientX: number; clientY: number }) => {
      const { bounds, scale, left, top } = geometry();
      return { x: (event.clientX - bounds.x - left) / scale, y: (event.clientY - bounds.y - top) / scale };
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || pointer || !current || !full || !plot) return;
      event.preventDefault();
      plotElement.setPointerCapture(event.pointerId);
      pointer = { id: event.pointerId, ...physicalPointer(event) };
      scheduler.begin();
    };
    const move = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId || !current || !full || !plot) return;
      const next = physicalPointer(event);
      current = panCamera(current, full, plot, next.x - pointer.x, next.y - pointer.y);
      retained.desired = current;
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
      if (!current || !full || !plot) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      current = zoomCamera(current, full, plot, physicalPointer(event), delta);
      retained.desired = current;
      retained.resetPending = resetPending = false;
      scheduler.change(); showPreview();
    };
    resetView.current = () => {
      if (!full) return;
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
          sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, ...size,
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
          const { scale, left, top } = geometry();
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
          const visibleStatus = completion.visibleRows === null
            ? `${completion.selectedMarks.toLocaleString()} displayed; visible count unknown`
            : `${completion.selectedMarks.toLocaleString()} of ${completion.visibleRows.toLocaleString()} visible`;
          setStatus(`${completion.exactVisible ? "Exact" : "Approximate LOD"}: ${visibleStatus}; ${completion.excludedNonFiniteRows.toLocaleString()} excluded`);
        } catch (error) {
          if (!cancelled) {
            const missing = error instanceof Error && error.message === "graph_new_missing_cache";
            setReason(missing ? "graph_new_missing_cache" : "graph_new_render_failed");
            setStatus(missing ? "Camera cache unavailable. Reset view to rebuild." : "Plot could not be rendered.");
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
    launch(resetPending ? null : current, scheduler.generation());
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
  }, [sessionId, datasetId, datasetGeneration, xColumnId, yColumnId, size]);

  return (
    <div className="graph-new-chart">
      <span className="graph-new-y-title" data-testid="y-axis-title">{yTitle}</span>
      <div className="graph-new-canvas-host" ref={host}>
        <canvas ref={canvas} role="img" aria-label="Point plot frame" style={{ visibility: hasFrame ? "visible" : "hidden" }} />
        <div ref={plotHost} className="graph-new-camera-plot" data-testid="camera-plot">
          <canvas ref={preview} className="graph-new-camera-preview" data-testid="camera-preview" aria-hidden="true" />
        </div>
        <button className="graph-new-reset" aria-label="Reset view" title="Reset view" disabled={!cameraAvailable} onClick={() => resetView.current()}>
          <i className="fa-solid fa-rotate-left" aria-hidden="true" />
        </button>
      </div>
      <span className="graph-new-x-title" data-testid="x-axis-title">{xTitle}</span>
      <span className="graph-new-frame-status" role={reason ? "alert" : "status"} data-reason={reason}>{provisional ? `Axes frozen; preview cropped; hatched area awaits frame. ${reason ? status : ""}` : status}</span>
    </div>
  );
}