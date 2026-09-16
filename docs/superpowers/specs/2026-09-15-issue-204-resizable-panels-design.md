# Issue 204 Resizable Panels Design

## Context

Issue 204 requires the application's major functional panels to support bounded width or height adjustment without sacrificing readability. The affected screenshots cover Graph Builder, Table, Analysis, Tabulate, Snapshot, and Workflow.

The current implementation has two different failure modes:

- Workspace, Analysis, and Tabulate use fixed CSS widths or grid tracks and cannot be resized.
- Graph Builder, Data Table, and History/Snapshot each implement their own mouse-only resize logic with different bounds, reset behavior, cursor handling, and state lifetime.

The common defect is the absence of a shared splitter interaction and preference contract.

## Goals

- Make the major panel boundaries shown in Issue 204 adjustable in both width and height where appropriate.
- Keep every panel within an explicit readable minimum and a container-safe maximum.
- Give all splitters consistent pointer, keyboard, reset, and accessibility behavior.
- Persist desktop layout preferences across page switches and application restarts.
- Preserve the existing narrow-screen layouts instead of forcing desktop split sizes onto them.
- Replace the duplicated resize handlers in Graph Builder, Data Table, and History/Snapshot.

## Non-Goals

- Changing project or `.spprj` schemas. Panel sizes are personal display preferences, not project content.
- Adding a new third-party resizing library.
- Redesigning the content, typography, or information hierarchy inside any panel.
- Making cards, dialogs, table columns, or graph axes resizable through this primitive.
- Adding backend, Tauri IPC, Rust, or DuckDB behavior.

## Architecture

### Shared splitter primitive

Add a controlled `PanelSplitter` component under `src/components/layout/`. It renders only the separator and owns input normalization; the parent layout remains responsible for rendering its panes and applying the resulting size through flex basis, grid tracks, or CSS custom properties.

The component accepts:

```ts
type PanelSplitterOrientation = "horizontal" | "vertical";

interface PanelSplitterProps {
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
```

`orientation="vertical"` means a vertical separator changes panel width; `orientation="horizontal"` means a horizontal separator changes panel height. `direction` handles a pane whose growth direction is opposite pointer movement, such as Graph Builder's right rail.

Pointer interaction uses pointer capture on the separator. A pointer move calculates the delta from the drag origin, applies direction, and clamps the next value to `[min, max]`. `onChange` updates the live page-local size. Pointer release or cancellation calls `onCommit` once with the final clamped value and releases capture. The component restores global cursor and text-selection state on completion and unmount.

Double-click calls `onReset`. Keyboard behavior is:

- Arrow keys in the active axis adjust by 8 units.
- Shift plus an active arrow adjusts by 32 units.
- Home selects `min`.
- End selects `max`.
- Enter resets to `defaultValue`.

The separator exposes `role="separator"`, `tabIndex={0}`, `aria-label`, `aria-orientation`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`. Decorative hit-area styling is shared in `src/components/layout/panelSplitter.css`; each separator has a stable visual line plus a larger pointer target without changing surrounding layout dimensions.

### Layout preference store

Add `useLayoutPreferencesStore` under `src/stores/`. It stores committed numeric values by a closed `LayoutPanelId` union rather than arbitrary strings:

```ts
type LayoutPanelId =
  | "workspace.sidebar"
  | "analysis.summary"
  | "tabulate.fields"
  | "tabulate.configuration"
  | "graphBuilder.filter"
  | "graphBuilder.leftRail"
  | "graphBuilder.rightRail"
  | "graphBuilder.leftStack"
  | "table.filter"
  | "table.columns"
  | "history.stack";
```

The store reads one versioned `localStorage` object, `sp-layout-preferences-v1`. Parsing is defensive: non-object payloads, unknown IDs, non-finite values, and storage access failures fall back to defaults. Values are clamped again by each consumer because a valid stored value may be invalid in a smaller current container.

Dragging does not write to `localStorage` on every pointer move. Each page initializes local state from the store, updates that local state during interaction, and calls the store only from `onCommit` or `onReset`. Preferences survive page unmounts and application restarts but do not mark the active project dirty.

### Consumer integration

#### Workspace and Workflow

Replace the fixed `240px` Workspace side-panel width with a local value initialized from `workspace.sidebar`. Insert a vertical `PanelSplitter` between `.side-panel` and `.main-area`.

- Default: `240px`
- Minimum: `200px`
- Maximum: the smaller of `480px` and 40% of the current Workspace width

Workflow uses the same global boundary; it does not add a second nested width preference. Directory, History/Snapshot, and other activity-bar panels inherit the same adjustable side-panel width.

#### Analysis

Convert the first Analysis grid track from fixed `minmax(240px, 280px)` to a CSS custom property controlled by `analysis.summary`, and place a vertical splitter between the summary and results panes.

- Default: `280px`
- Minimum: `240px`
- Maximum: the smaller of `480px` and 45% of the shell width

At the existing narrow breakpoint, Analysis remains a single column, the splitter is not rendered, and the stored desktop value is left unchanged.

#### Tabulate

Keep the existing three logical panes but replace fixed grid tracks with two controlled pixel tracks and two vertical splitters:

- Fields: default `300px`, minimum `240px`, maximum `420px`.
- Configuration: default `360px`, minimum `320px`, maximum `520px`.
- Results: retains at least `320px`; consumer-calculated maxima shrink the adjustable tracks before results become unreadable.

At the existing `1100px` narrow mode, the current collapsed/mobile layout remains authoritative and neither desktop splitter is rendered.

#### Existing resizable pages

Graph Builder, Data Table, and History/Snapshot retain their current defaults, units, bounds, and pane structure. Their bespoke mouse listeners are replaced by `PanelSplitter`, and committed values move into `useLayoutPreferencesStore`.

- Graph Builder keeps pixel widths for filter/left/right rails and percentage sizing for TABLE/LAYERS.
- Data Table keeps separate pixel widths for Filter and Columns.
- History/Snapshot keeps its existing `15%` to `85%` vertical split and `60%` default.

These migrations must not change graph rendering, data loading, table virtualization, history actions, or snapshot behavior.

## Responsive And Container Behavior

Each consumer observes its own container, not `window.innerWidth`, when deriving a dynamic maximum. On mount, container resize, preference load, and reset, it clamps the live size against the current bounds. A container shrinking below the sum of readable minima hides the splitter and uses the page's existing narrow or overflow layout rather than producing a negative content size.

The shared component does not decide breakpoints. Analysis and Tabulate keep their existing breakpoints; Graph Builder, Data Table, History/Snapshot, and Workspace preserve their current overflow behavior unless a focused regression demonstrates that an explicit narrow fallback is required.

## Error Handling

- `localStorage` read and write failures are non-fatal and leave the live layout usable for the current mount.
- Invalid persisted values are ignored or clamped; they never propagate `NaN` into CSS.
- Lost pointer capture, `pointercancel`, and component unmount all terminate the drag and restore document interaction styles.
- A missing container measurement uses the static configured maximum until a real measurement is available.

## Testing

### Shared behavior

Create a module-level Playwright Component Test harness for `PanelSplitter`. Tests must first fail against the absent primitive, then cover:

- Pointer drag updates in both orientations and both directions.
- Values clamp at minimum and maximum.
- Pointer release commits once.
- Double-click and Enter restore the default.
- Arrow, Shift+Arrow, Home, and End behavior.
- Required separator role and ARIA values.
- Pointer cancellation and unmount restore document styles.

Add focused TypeScript tests for preference parsing, unknown-key rejection, persistence, reset, and unavailable storage.

### Consumer behavior

- Extend the Analysis Shell harness to assert desktop resizing, persisted remount size, and narrow-mode splitter removal.
- Add a focused Tabulate layout harness that exercises both desktop boundaries without invoking backend data services.
- Add a Workspace layout harness for the global side-panel boundary and dynamic maximum.
- Update existing Graph Builder, Data Table, and History/Snapshot component tests to assert the shared separator behavior while retaining their current feature assertions.
- Add geometry assertions that the result/main pane remains above its declared readable minimum after extreme drags and container resizing.

### Validation gates

Run the focused tests after each migration, followed by:

```text
npx playwright test -c playwright-ct.config.ts <touched component specs>
npx tsx --tsconfig tsconfig.app.json tests/layoutPreferencesStore.test.ts
npm run test:analysis:ui
npm run build
```

No Rust validation is required because this design does not touch `src-tauri/`.

## Delivery Sequence

1. Add failing tests for the shared splitter and layout preference store, then implement both primitives.
2. Migrate Workspace/Workflow and verify the global side panel.
3. Migrate Analysis and run the scoped Analysis UI gate.
4. Migrate Tabulate and verify desktop plus narrow behavior.
5. Migrate Graph Builder, Data Table, and History/Snapshot one owner at a time, running each owner's focused tests immediately after the edit.
6. Run the complete frontend build and the combined touched-component Playwright suite.

## Acceptance Criteria

- Every major boundary shown in Issue 204 can be adjusted in its applicable axis.
- No adjustable pane can be reduced below its readable minimum or expanded beyond the current container-safe maximum.
- Every separator supports pointer, keyboard, double-click reset, and screen-reader semantics.
- Committed desktop sizes survive page switches and application restarts without modifying project state.
- Existing Analysis and Tabulate narrow layouts remain usable and do not render desktop splitters.
- Graph Builder, Data Table, and History/Snapshot no longer own document-level mouse resize implementations.
- Focused component tests and the production frontend build pass.