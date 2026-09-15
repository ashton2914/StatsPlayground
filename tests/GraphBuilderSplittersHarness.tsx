import { useState } from "react";

import { PanelSplitter } from "../src/components/layout/PanelSplitter.tsx";
import { useLayoutPreferencesStore } from "../src/stores/useLayoutPreferencesStore.ts";

const GRAPH_BUILDER_FILTER_ID = "graphBuilder.filter";
const GRAPH_BUILDER_LEFT_RAIL_ID = "graphBuilder.leftRail";
const GRAPH_BUILDER_RIGHT_RAIL_ID = "graphBuilder.rightRail";
const GRAPH_BUILDER_LEFT_STACK_ID = "graphBuilder.leftStack";

const FILTER_DEFAULT_WIDTH = 240;
const LEFT_RAIL_DEFAULT_WIDTH = 220;
const RIGHT_RAIL_DEFAULT_WIDTH = 220;
const LEFT_STACK_DEFAULT_PERCENT = 50;

const PANEL_MIN_WIDTH = 160;
const PANEL_MAX_WIDTH = 500;
const LEFT_STACK_MIN_PERCENT = 15;
const LEFT_STACK_MAX_PERCENT = 85;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function GraphBuilderSplittersHarness() {
  const persistedFilterWidth = useLayoutPreferencesStore((state) => state.sizes[GRAPH_BUILDER_FILTER_ID]);
  const persistedLeftRailWidth = useLayoutPreferencesStore((state) => state.sizes[GRAPH_BUILDER_LEFT_RAIL_ID]);
  const persistedRightRailWidth = useLayoutPreferencesStore((state) => state.sizes[GRAPH_BUILDER_RIGHT_RAIL_ID]);
  const persistedLeftStackPercent = useLayoutPreferencesStore((state) => state.sizes[GRAPH_BUILDER_LEFT_STACK_ID]);
  const setPanelSize = useLayoutPreferencesStore((state) => state.setPanelSize);
  const resetPanelSize = useLayoutPreferencesStore((state) => state.resetPanelSize);
  const [filterWidth, setFilterWidth] = useState(
    () => clamp(persistedFilterWidth ?? FILTER_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
  );
  const [leftRailWidth, setLeftRailWidth] = useState(
    () => clamp(persistedLeftRailWidth ?? LEFT_RAIL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
  );
  const [rightRailWidth, setRightRailWidth] = useState(
    () => clamp(persistedRightRailWidth ?? RIGHT_RAIL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
  );
  const [leftStackPercent, setLeftStackPercent] = useState(
    () => clamp(persistedLeftStackPercent ?? LEFT_STACK_DEFAULT_PERCENT, LEFT_STACK_MIN_PERCENT, LEFT_STACK_MAX_PERCENT),
  );

  return (
    <div style={{ display: "grid", gap: 16, width: 960 }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
        <section data-testid="graph-filter-panel" style={{ width: filterWidth, height: 64, border: "1px solid currentColor" }} />
        <PanelSplitter
          orientation="vertical"
          value={filterWidth}
          min={PANEL_MIN_WIDTH}
          max={PANEL_MAX_WIDTH}
          defaultValue={FILTER_DEFAULT_WIDTH}
          unit="px"
          label="Resize graph builder filter panel"
          onChange={(nextWidth) => setFilterWidth(clamp(nextWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH))}
          onCommit={(nextWidth) => {
            const preferredWidth = clamp(nextWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
            setFilterWidth(preferredWidth);
            setPanelSize(GRAPH_BUILDER_FILTER_ID, preferredWidth);
          }}
          onReset={() => {
            setFilterWidth(FILTER_DEFAULT_WIDTH);
            resetPanelSize(GRAPH_BUILDER_FILTER_ID);
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
        <section data-testid="graph-left-rail" style={{ width: leftRailWidth, height: 64, border: "1px solid currentColor" }} />
        <PanelSplitter
          orientation="vertical"
          value={leftRailWidth}
          min={PANEL_MIN_WIDTH}
          max={PANEL_MAX_WIDTH}
          defaultValue={LEFT_RAIL_DEFAULT_WIDTH}
          unit="px"
          label="Resize graph builder left rail"
          onChange={(nextWidth) => setLeftRailWidth(clamp(nextWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH))}
          onCommit={(nextWidth) => {
            const preferredWidth = clamp(nextWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
            setLeftRailWidth(preferredWidth);
            setPanelSize(GRAPH_BUILDER_LEFT_RAIL_ID, preferredWidth);
          }}
          onReset={() => {
            setLeftRailWidth(LEFT_RAIL_DEFAULT_WIDTH);
            resetPanelSize(GRAPH_BUILDER_LEFT_RAIL_ID);
          }}
        />
      </div>

      <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
        <PanelSplitter
          orientation="vertical"
          value={rightRailWidth}
          min={PANEL_MIN_WIDTH}
          max={PANEL_MAX_WIDTH}
          defaultValue={RIGHT_RAIL_DEFAULT_WIDTH}
          unit="px"
          direction={-1}
          label="Resize graph builder right rail"
          onChange={(nextWidth) => setRightRailWidth(clamp(nextWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH))}
          onCommit={(nextWidth) => {
            const preferredWidth = clamp(nextWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
            setRightRailWidth(preferredWidth);
            setPanelSize(GRAPH_BUILDER_RIGHT_RAIL_ID, preferredWidth);
          }}
          onReset={() => {
            setRightRailWidth(RIGHT_RAIL_DEFAULT_WIDTH);
            resetPanelSize(GRAPH_BUILDER_RIGHT_RAIL_ID);
          }}
        />
        <section data-testid="graph-right-rail" style={{ width: rightRailWidth, height: 64, border: "1px solid currentColor" }} />
      </div>

      <div style={{ display: "grid", gap: 8, width: 320 }}>
        <div style={{ height: 320, display: "flex", flexDirection: "column", border: "1px solid currentColor" }}>
          <section data-testid="graph-left-stack-top" style={{ flex: `0 0 ${leftStackPercent}%`, borderBottom: "1px solid currentColor" }} />
          <PanelSplitter
            orientation="horizontal"
            value={leftStackPercent}
            min={LEFT_STACK_MIN_PERCENT}
            max={LEFT_STACK_MAX_PERCENT}
            defaultValue={LEFT_STACK_DEFAULT_PERCENT}
            unit="%"
            label="Resize graph builder left stack"
            onChange={(nextPercent) => setLeftStackPercent(clamp(nextPercent, LEFT_STACK_MIN_PERCENT, LEFT_STACK_MAX_PERCENT))}
            onCommit={(nextPercent) => {
              const preferredPercent = clamp(nextPercent, LEFT_STACK_MIN_PERCENT, LEFT_STACK_MAX_PERCENT);
              setLeftStackPercent(preferredPercent);
              setPanelSize(GRAPH_BUILDER_LEFT_STACK_ID, preferredPercent);
            }}
            onReset={() => {
              setLeftStackPercent(LEFT_STACK_DEFAULT_PERCENT);
              resetPanelSize(GRAPH_BUILDER_LEFT_STACK_ID);
            }}
          />
          <section data-testid="graph-left-stack-bottom" style={{ flex: `0 0 ${100 - leftStackPercent}%` }} />
        </div>
      </div>
    </div>
  );
}