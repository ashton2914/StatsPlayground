import React, { useMemo, useRef } from "react";

export interface LogicalVerticalScrollbarProps {
  totalRows: number;
  visibleRows: number;
  logicalStart: number;
  onLogicalStartChange: (nextLogicalStart: number) => void;
  onInteractionEnd?: () => void;
  disabled?: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function LogicalVerticalScrollbar({
  totalRows,
  visibleRows,
  logicalStart,
  onLogicalStartChange,
  onInteractionEnd,
  disabled = false,
}: LogicalVerticalScrollbarProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const dragGeometryRef = useRef<{ top: number; height: number } | null>(null);
  const maxLogicalStart = Math.max(0, totalRows - visibleRows);
  const canScroll = !disabled && maxLogicalStart > 0;

  const thumbMetrics = useMemo(() => {
    const minThumbHeight = 32;
    if (maxLogicalStart === 0 || totalRows <= 0) {
      return { heightPx: minThumbHeight, travelRatio: 0 };
    }
    const visibleRatio = clamp(visibleRows / totalRows, 0, 1);
    const heightPx = Math.max(minThumbHeight, visibleRatio * 180);
    const clampedHeightPx = Math.max(minThumbHeight, Math.min(180, heightPx));
    const travelRatio = clamp(logicalStart / maxLogicalStart, 0, 1);
    return { heightPx: clampedHeightPx, travelRatio };
  }, [logicalStart, maxLogicalStart, totalRows, visibleRows]);

  const updateFromClientY = (clientY: number) => {
    const rail = railRef.current;
    if (!rail || !canScroll) return;
    const geometry = dragGeometryRef.current ?? rail.getBoundingClientRect();
    if (geometry.height <= 0) return;
    const ratio = clamp((clientY - geometry.top) / geometry.height, 0, 1);
    onLogicalStartChange(Math.round(ratio * maxLogicalStart));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canScroll) return;
    const rail = railRef.current;
    rail?.setPointerCapture(event.pointerId);
    const rect = rail?.getBoundingClientRect();
    dragGeometryRef.current = rect ? { top: rect.top, height: rect.height } : null;
    updateFromClientY(event.clientY);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canScroll || (event.buttons & 1) === 0) return;
    updateFromClientY(event.clientY);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    railRef.current?.releasePointerCapture(event.pointerId);
    if (canScroll) updateFromClientY(event.clientY);
    dragGeometryRef.current = null;
    onInteractionEnd?.();
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    railRef.current?.releasePointerCapture(event.pointerId);
    dragGeometryRef.current = null;
    onInteractionEnd?.();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canScroll) return;
    const pageStep = Math.max(1, visibleRows);
    let next: number | null = null;
    switch (event.key) {
      case "Home":
        next = 0;
        break;
      case "End":
        next = maxLogicalStart;
        break;
      case "PageDown":
        next = logicalStart + pageStep;
        break;
      case "PageUp":
        next = logicalStart - pageStep;
        break;
      case "ArrowDown":
        next = logicalStart + 1;
        break;
      case "ArrowUp":
        next = logicalStart - 1;
        break;
      default:
        break;
    }
    if (next == null) return;
    event.preventDefault();
    onLogicalStartChange(clamp(next, 0, maxLogicalStart));
    onInteractionEnd?.();
  };

  return (
    <div
      ref={railRef}
      className={`sp-logical-scrollbar${canScroll ? "" : " sp-logical-scrollbar-disabled"}`}
      role="scrollbar"
      aria-label="Logical table rows"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={maxLogicalStart}
      aria-valuenow={clamp(logicalStart, 0, maxLogicalStart)}
      tabIndex={canScroll ? 0 : -1}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
    >
      <div className="sp-logical-scrollbar-track">
        <div
          className="sp-logical-scrollbar-thumb"
          style={{
            height: `${thumbMetrics.heightPx}px`,
            top: `calc((100% - ${thumbMetrics.heightPx}px) * ${thumbMetrics.travelRatio})`,
          }}
        />
      </div>
    </div>
  );
}