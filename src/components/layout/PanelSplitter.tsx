import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";

import "./panelSplitter.css";

export type PanelSplitterOrientation = "horizontal" | "vertical";

export interface PanelSplitterProps {
  orientation: PanelSplitterOrientation;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  unit: "px" | "%";
  direction?: 1 | -1;
  label: string;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function axisStep(orientation: PanelSplitterOrientation, key: string) {
  if (orientation === "vertical") {
    if (key === "ArrowRight") return 1;
    if (key === "ArrowLeft") return -1;
  } else {
    if (key === "ArrowDown") return 1;
    if (key === "ArrowUp") return -1;
  }
  return 0;
}

export function PanelSplitter({
  orientation,
  value,
  min,
  max,
  unit,
  direction = 1,
  label,
  onChange,
  onCommit,
  onReset,
}: PanelSplitterProps) {
  const separatorRef = useRef<HTMLDivElement | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartValueRef = useRef(value);
  const dragLatestValueRef = useRef(clamp(value, min, max));
  const bodyCursorRef = useRef("");
  const bodyUserSelectRef = useRef("");

  useEffect(() => {
    dragLatestValueRef.current = clamp(value, min, max);
  }, [max, min, value]);

  function restoreDocumentState() {
    const body = document.body;
    body.style.cursor = bodyCursorRef.current;
    body.style.userSelect = bodyUserSelectRef.current;
  }

  function finishDrag(commit: boolean) {
    const pointerId = dragPointerIdRef.current;
    const separator = separatorRef.current;

    if (pointerId !== null && separator?.hasPointerCapture(pointerId)) {
      try {
        separator.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture may already be gone after cancel or unmount.
      }
    }

    if (commit) {
      onCommit(dragLatestValueRef.current);
    }

    dragPointerIdRef.current = null;
    dragOriginRef.current = null;
    restoreDocumentState();
  }

  useEffect(() => () => {
    finishDrag(false);
  }, []);

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;

    const separator = separatorRef.current;
    if (!separator) return;

    dragPointerIdRef.current = event.pointerId;
    dragOriginRef.current = { x: event.clientX, y: event.clientY };
    dragStartValueRef.current = clamp(value, min, max);
    dragLatestValueRef.current = dragStartValueRef.current;

    const body = document.body;
    bodyCursorRef.current = body.style.cursor;
    bodyUserSelectRef.current = body.style.userSelect;
    body.style.cursor = orientation === "vertical" ? "col-resize" : "row-resize";
    body.style.userSelect = "none";

    try {
      separator.setPointerCapture(event.pointerId);
    } catch {
      // Some synthetic environments do not support pointer capture.
    }
  }

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId || !dragOriginRef.current) return;

    const delta = orientation === "vertical"
      ? event.clientX - dragOriginRef.current.x
      : event.clientY - dragOriginRef.current.y;
    const nextValue = clamp(dragStartValueRef.current + delta * direction, min, max);

    dragLatestValueRef.current = nextValue;
    onChange(nextValue);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) return;
    updateDrag(event);
    finishDrag(true);
  }

  function handlePointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) return;
    updateDrag(event);
    finishDrag(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onReset();
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      onChange(min);
      onCommit(min);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      onChange(max);
      onCommit(max);
      return;
    }

    const axis = axisStep(orientation, event.key);
    if (!axis) return;

    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    const nextValue = clamp(value + axis * step * direction, min, max);
    onChange(nextValue);
    onCommit(nextValue);
  }

  const orientationClass = orientation === "vertical"
    ? "panel-splitter--vertical"
    : "panel-splitter--horizontal";
  const displayedValue = clamp(value, min, max);

  return (
    <div
      ref={separatorRef}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(displayedValue)}
      aria-valuetext={`${Math.round(displayedValue)}${unit}`}
      className={`panel-splitter ${orientationClass}`}
      onPointerDown={beginDrag}
      onPointerMove={updateDrag}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={() => {
        if (dragPointerIdRef.current !== null) {
          finishDrag(true);
        }
      }}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}