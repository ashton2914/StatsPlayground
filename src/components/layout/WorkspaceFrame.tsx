import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLayoutPreferencesStore } from "@/stores/useLayoutPreferencesStore";

import { PanelSplitter } from "./PanelSplitter";

const WORKSPACE_SIDEBAR_ID = "workspace.sidebar";
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

interface WorkspaceFrameProps {
  activityBar: ReactNode;
  sidePanel: ReactNode;
  children: ReactNode;
}

export function WorkspaceFrame({ activityBar, sidePanel, children }: WorkspaceFrameProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const persistedSidebarWidth = useLayoutPreferencesStore((state) => state.sizes[WORKSPACE_SIDEBAR_ID]);
  const setPanelSize = useLayoutPreferencesStore((state) => state.setPanelSize);
  const resetPanelSize = useLayoutPreferencesStore((state) => state.resetPanelSize);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => persistedSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
  const preferredSidebarWidth = clamp(sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);

  const maxSidebarWidth = useMemo(() => {
    if (containerWidth == null) {
      return MAX_SIDEBAR_WIDTH;
    }

    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, containerWidth * 0.4));
  }, [containerWidth]);

  const effectiveSidebarWidth =
    containerWidth == null
      ? preferredSidebarWidth
      : clamp(sidebarWidth, MIN_SIDEBAR_WIDTH, maxSidebarWidth);

  const renderedSidebarWidth = effectiveSidebarWidth;
  const renderedSidebarMaxWidth = containerWidth == null ? `min(40%, ${MAX_SIDEBAR_WIDTH}px)` : `${maxSidebarWidth}px`;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const applyMeasuredWidth = (nextWidth: number) => {
      if (!Number.isFinite(nextWidth)) {
        return;
      }

      setContainerWidth(nextWidth);
    };

    applyMeasuredWidth(container.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth === "number") {
        applyMeasuredWidth(nextWidth);
      }
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleSidebarChange = (nextWidth: number) => {
    setSidebarWidth(clamp(nextWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
  };

  const handleSidebarCommit = (nextWidth: number) => {
    const preferredWidth = clamp(nextWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
    setSidebarWidth(preferredWidth);
    setPanelSize(WORKSPACE_SIDEBAR_ID, preferredWidth);
  };

  const handleSidebarReset = () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    resetPanelSize(WORKSPACE_SIDEBAR_ID);
  };

  return (
    <div ref={containerRef} className="workspace">
      <div className="workspace-frame__activity">{activityBar}</div>
      <div
        className="workspace-frame__side"
        style={{
          flexBasis: `${renderedSidebarWidth}px`,
          width: `${renderedSidebarWidth}px`,
          minWidth: `${MIN_SIDEBAR_WIDTH}px`,
          maxWidth: renderedSidebarMaxWidth,
        }}
      >
        {sidePanel}
      </div>
      <PanelSplitter
        orientation="vertical"
        value={effectiveSidebarWidth}
        min={MIN_SIDEBAR_WIDTH}
        max={maxSidebarWidth}
        defaultValue={DEFAULT_SIDEBAR_WIDTH}
        unit="px"
        label="Resize workspace side panel"
        onChange={handleSidebarChange}
        onCommit={handleSidebarCommit}
        onReset={handleSidebarReset}
      />
      <div className="workspace-frame__main">{children}</div>
    </div>
  );
}