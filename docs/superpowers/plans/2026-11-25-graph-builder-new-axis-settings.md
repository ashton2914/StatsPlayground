# Graph Builder for Massive Data — Axis Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Graph Builder for Massive Data (`src/components/graphBuilderNew/`) to full X/Y axis settings parity with Classic Graph Builder (`AxisSettingsDialog`: Axis, Tick Grid, Reference Lines + Auto-show spec limits + `.spgn` persistence).

**Architecture:** Rust GPU renders data-only bitmaps (`hideChrome: true`) with server-side `axisBounds` domain resolution and native `invertX`/`invertY` mirroring. Frontend `GraphNewCanvas` computes tick/minor-tick/grid/reference-line layout in `graphNewAxisLayout.ts` and renders a 60fps SVG/DOM vector overlay synced to `plotRect` and live `cameraDomain`, reusing Classic's `AxisSettingsDialog` in `GraphBuilderNewView`.

**Tech Stack:** TypeScript, React 19, Zustand, Rust (`wgpu`, `serde`), `tsx` (`node:assert/strict`), Playwright Component Testing (`playwright-ct`), `cargo test`.

**Spec:** [docs/superpowers/specs/2026-11-25-graph-builder-new-axis-settings-design.md](../specs/2026-11-25-graph-builder-new-axis-settings-design.md)

## Global Constraints

- `.spgn` document stays `version: 3` with optional fields; existing v1/v2/v3 documents load without migration errors.
- Custom `min`/`max` act as effective full domain and Reset View target (Option A); users can still pan/zoom freely and Reset returns to custom Range.
- All style/tick/grid/ref-line edits (everything except `min`, `max`, `inverse`) must update the SVG/DOM overlay immediately with **0 Rust GPU re-renders**.
- Major and minor gridlines default to OFF (`false`), matching Classic `AxisSettingsDialog`. Minor gridlines render only when `showMinorGrid === true` AND `minorTickCount > 0`.
- Non-numeric X axes (`category`, `time`, `duration`) keep stored settings non-destructive while ignoring incompatible numeric overrides per Spec §4.3.
- Read-only project mode disables axis mutations and dialog triggers (`assertProjectMutable`).

## Review Focus

1. **Invalid partial/inverted Range input while typing (`min >= max` or `NaN`)**: Must never throw `graph_new_invalid_request` or corrupt `cameraDomain`; omit invalid axis bounds until `min < max` (pinned in Task 2 & Task 3).
2. **Wide/narrow custom Range exceeding 4× or `< 1e-6×` of `dataFull`**: Rust `validate_camera_limits` must validate relative to `effective_full` rather than raw `dataFull`, and `cameraDomain: null` must build cache from `dataFull` then render `effective_full` (pinned in Task 2).
3. **Tiny `tickInterval` on a huge span (e.g. `tickInterval = 0.001` on `[0, 1e6]`)**: `computeAxisTicks` must cap/step up gracefully (≤ 64 major ticks) so the browser never freezes (pinned in Task 4).
4. **Inverted axis (`invertX` / `invertY`) during live pan/zoom & overscan preview**: Dragging right must move data right on screen, wheel zoom must stay anchored under cursor, and `cameraTransform` preview must match the settled Rust frame (pinned in Task 2 & Task 3).
5. **Switching X from numeric to `category` or `time` with saved `xAxisConfig` / `refLinesX`**: Must not empty the plot, clobber timestamp labels with decimals, or draw misplaced vertical reference lines; switching back to numeric restores them (pinned in Task 1, Task 4 & Task 6).

---

### Task 1: Document Schema, Store Actions & Persistence Normalization

**Files:**
- Modify: `src/types/graphBuilderNew.ts:45-64`
- Modify: `src/stores/useGraphBuilderNewStore.ts:21-229`
- Test: `tests/graphNewAxisStore.test.ts` (create)

**Interfaces:**
- Consumes: `isAxisConfigEmpty` from `@/components/graphBuilder/AxisSettingsDialog`, `YAxisConfig`, `RefLineX`, `RefLineY` from `@/graphCore`
- Produces:
  - Optional fields on `GraphBuilderNewDocument` & `GraphBuilderNewSession`: `xAxisConfig?: YAxisConfig`, `yAxisConfig?: YAxisConfig`, `refLinesX?: RefLineX[]`, `refLinesY?: RefLineY[]`, `autoSpecLinesX?: boolean`, `autoSpecLinesY?: boolean`
  - Store actions on `useGraphBuilderNewStore`: `setXAxisConfig(id, config)`, `setYAxisConfig(id, config)`, `setRefLinesX(id, lines)`, `setRefLinesY(id, lines)`, `setAutoSpecLinesX(id, enabled)`, `setAutoSpecLinesY(id, enabled)`
  - `normalizeGraphNewDocument(item)` sanitizes and preserves all axis settings across v1/v2/v3 loads

- [ ] **Step 1: Write failing unit tests in `tests/graphNewAxisStore.test.ts`**
  Assert:
  1. `normalizeGraphNewDocument` loads v1/v2/v3 documents without axis fields (all axis fields `undefined`), and preserves valid `xAxisConfig`, `yAxisConfig`, `refLinesX`, `refLinesY`, `autoSpecLinesX`, `autoSpecLinesY` on v3.
  2. `normalizeGraphNewDocument` drops empty `YAxisConfig` (via `isAxisConfigEmpty`), drops non-finite bounds/`tickInterval <= 0`, clamps `decimals` to `0..10` and `minorTickCount` to `0..20`, and filters invalid ref lines.
  3. Store actions (`setXAxisConfig`, `setYAxisConfig`, `setRefLinesX`, `setRefLinesY`, `setAutoSpecLinesX`, `setAutoSpecLinesY`) update both `items` and `sessions`, mark project dirty, and throw in read-only mode.
  4. `setColumns` preserves axis configs and ref lines non-destructively while resetting `camera: null`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewAxisStore.test.ts`
  Expected: FAIL (missing store actions / fields dropped by `normalizeGraphNewDocument`).

- [ ] **Step 3: Extend `src/types/graphBuilderNew.ts` and `src/stores/useGraphBuilderNewStore.ts`**
  Add optional axis fields to `GraphBuilderNewDocument` and `GraphBuilderNewSession`. Implement `normalizeAxisConfig`, `normalizeRefLinesX`, `normalizeRefLinesY` in `useGraphBuilderNewStore.ts`, wire them into `normalizeGraphNewDocument`, and add the 6 setter actions via `update(...)`.

- [ ] **Step 4: Run tests to verify pass**
  Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewAxisStore.test.ts && npx tsx --tsconfig tsconfig.app.json tests/workspaceGraphBuilderNew.test.ts && npx tsx --tsconfig tsconfig.app.json tests/graphNewLayersProjectRoundTrip.test.ts`
  Expected: All PASS.

- [ ] **Step 5: Commit**
  `git --no-pager add src/types/graphBuilderNew.ts src/stores/useGraphBuilderNewStore.ts tests/graphNewAxisStore.test.ts && git --no-pager commit -m "feat(graph): persist X/Y axis settings and ref lines in graphBuilderNew store (#322)"`

---

### Task 2: Rust Backend & Service Contract (`axisBounds`, `hideChrome`, `invertX` / `invertY`)

**Files:**
- Modify: `src-tauri/src/models/graph_new.rs:108-176`
- Modify: `src-tauri/src/services/graph_new_service.rs:295-325, 451-478`
- Modify: `src-tauri/src/services/graph_new_renderer.rs:37-51, 251-280, 623-665, 907-999`
- Modify: `src/services/graphNewService.ts:58-77, 150-185`
- Test: Rust unit tests in `graph_new_renderer.rs` & `graph_new_service.rs`; TS contract test in `tests/graphNewService.test.ts`

**Interfaces:**
- Consumes: Existing `GraphNewRenderRequest`, `ScenePresentation`, `validate_camera_limits`, `PixelRaster`
- Produces:
  - Rust `GraphNewAxisBounds { x_min: Option<f64>, x_max: Option<f64>, y_min: Option<f64>, y_max: Option<f64> }`
  - Optional serde-defaulted fields on `GraphNewRenderRequest`: `invert_x: bool`, `invert_y: bool`, `hide_chrome: bool`, `axis_bounds: Option<GraphNewAxisBounds>`
  - Matching TS fields on `GraphNewRenderRequest` in `src/services/graphNewService.ts`: `invertX?: boolean`, `invertY?: boolean`, `hideChrome?: boolean`, `axisBounds?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number }`
  - `resolve_effective_full_domain(data_full: GraphDomain, bounds: Option<&GraphNewAxisBounds>, x_kind: GraphNewXMode) -> GraphDomain`

- [ ] **Step 1: Write failing Rust & TS tests**
  1. In `graph_new_service.rs` tests: verify `resolve_effective_full_domain` applies wide custom bounds (`0..1000` on `45..55`), ignores invalid `min >= max` or non-finite values, ignores X bounds on `Category`/`Time` X, and `validate_camera_limits` succeeds against `effective_full`.
  2. In `graph_new_renderer.rs` tests:
     - `hide_chrome: true` produces transparent/background-only pixels along the axis border where `INK` and `GRID` normally draw.
     - `invert_x: true` mirrors rendered point and `PixelRaster` X pixel coordinates across `plot_rect` (`x' = plot_x + plot_w - 1 - (x - plot_x)`).
     - `invert_y: true` mirrors rendered point and `PixelRaster` Y pixel coordinates across `plot_rect`.
  3. In `tests/graphNewService.test.ts`: verify `validateRenderRequest` accepts valid `invertX`/`invertY`/`hideChrome`/`axisBounds` and rejects non-finite `axisBounds` values.

- [ ] **Step 2: Run tests to verify failure**
  Run: `cargo test --manifest-path src-tauri/Cargo.toml graph_new_renderer::tests -- --nocapture` and `npx tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts`
  Expected: Compile error / FAIL on missing fields.

- [ ] **Step 3: Implement Rust & TS backend changes**
  1. `src-tauri/src/models/graph_new.rs`: add `GraphNewAxisBounds` and the 4 `#[serde(default)]` fields to `GraphNewRenderRequest`; validate `axis_bounds` fields are finite when `Some`.
  2. `src-tauri/src/services/graph_new_service.rs`: apply `resolve_effective_full_domain` to `full_domain` before `validate_camera_limits` and `domain` resolution (keeping `built.pyramid` cache keyed on source data); add `flip_pixel_raster(&mut rgba, frame, plot, invert_x, invert_y)` helper for pixel-aggregated scatter/line rasters when `invert_x || invert_y`; pass `hide_chrome`, `invert_x`, `invert_y` into `ScenePresentation`.
  3. `src-tauri/src/services/graph_new_renderer.rs`: when `scene.presentation.hide_chrome` is true, skip emitting `GRID` and `INK` chrome `marks`; when `invert_x` / `invert_y` is true, apply `1.0 - coord` (or negate scale + shift offset in `PointBasis::camera` / `mean_camera` / `layer_marks`) consistently across points, raw lines, mean segments, and layer geometry.
  4. `src/services/graphNewService.ts`: add `invertX`, `invertY`, `hideChrome`, `axisBounds` to `GraphNewRenderRequest` and `validateRenderRequest`.

- [ ] **Step 4: Run Rust & TS tests to verify pass**
  Run: `cargo test --manifest-path src-tauri/Cargo.toml graph_new_renderer::tests && cargo test --manifest-path src-tauri/Cargo.toml graph_new_ticks::tests && cargo test --manifest-path src-tauri/Cargo.toml graph_new_service::tests:: && npx tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts`
  Expected: All PASS.

- [ ] **Step 5: Commit**
  `git --no-pager add src-tauri/src/models/graph_new.rs src-tauri/src/services/graph_new_service.rs src-tauri/src/services/graph_new_renderer.rs src/services/graphNewService.ts tests/graphNewService.test.ts && git --no-pager commit -m "feat(graph): support axisBounds, hideChrome, and invertX/invertY in graph_new renderer (#322)"`

---

### Task 3: Camera & Axis Inversion Math

**Files:**
- Modify: `src/components/graphBuilderNew/graphNewCamera.ts:51-97`
- Test: `tests/graphNewCamera.test.ts`

**Interfaces:**
- Consumes: `YAxisConfig` from `@/graphCore`, `GraphNewXMode` from `@/types/graphBuilderNew`
- Produces:
  - `buildAxisBounds(xConfig?: YAxisConfig, yConfig?: YAxisConfig, xKind?: GraphNewXMode): { xMin?: number; xMax?: number; yMin?: number; yMax?: number } | undefined`
  - Optional `{ invertX?: boolean; invertY?: boolean }` parameter on `panCamera`, `zoomCamera`, `cameraTransform`, and `shouldPreviewCameraTransform`

- [ ] **Step 1: Write failing tests in `tests/graphNewCamera.test.ts`**
  Assert:
  1. `buildAxisBounds` returns `undefined` when all bounds are unset; returns partial `{ yMin: 0 }` when only `yMin` is set; omits an axis's bounds when both `min` and `max` are set with `min >= max`; omits X bounds when `xKind` is `"category"` or `"time"`, keeps them for `"numeric"` / `"duration"`.
  2. `panCamera(..., { invertX: true })` dragging right (`dx > 0`) shifts `[xMin, xMax]` **upward** (opposite of non-inverted) so data follows the pointer; same for `invertY: true` with `dy > 0`.
  3. `zoomCamera(..., { invertX: true, invertY: true })` keeps the world coordinate under the pointer fixed at the same screen pixel.
  4. `cameraTransform(presented, current, plot, { invertX: true, invertY: true })` produces the exact pixel offset matching the inverted screen mapping.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewCamera.test.ts`
  Expected: FAIL (`buildAxisBounds` not exported / inversion options ignored).

- [ ] **Step 3: Implement inversion support and `buildAxisBounds` in `src/components/graphBuilderNew/graphNewCamera.ts`**
  Keep existing parameter defaults (`invertX = false`, `invertY = false`) so all existing callers remain backward-compatible.

- [ ] **Step 4: Run test to verify pass**
  Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewCamera.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git --no-pager add src/components/graphBuilderNew/graphNewCamera.ts tests/graphNewCamera.test.ts && git --no-pager commit -m "feat(graph): support inverted axes and axisBounds in graphNewCamera (#322)"`

---

### Task 4: Frontend Axis Layout Engine (`graphNewAxisLayout.ts`)

**Files:**
- Create: `src/components/graphBuilderNew/graphNewAxisLayout.ts`
- Test: `tests/graphNewAxisLayout.test.ts` (create)

**Interfaces:**
- Consumes: `AutoSpec`, `GridLineStyle`, `RefLineStyle`, `RefLineX`, `RefLineY`, `YAxisConfig` from `@/graphCore`; `GraphNewAxis` from `@/services/graphNewService`; `formatCompactNumericTick`, `normalizedAxisValue`, `projectAxisTicks`, `projectGridPositions` from `./graphNewCamera`
- Produces:
  - `AxisTickMark { value: number; screenPosition: number; label: string }` (`screenPosition ∈ [0, 1]`, left→right for X, bottom→top for Y, already incorporating `inverse`)
  - `AxisRefLineRender { id: string; screenPosition: number; label: string; color: string; style: RefLineStyle; width: number }`
  - `AxisLayoutResult { majorTicks: AxisTickMark[]; minorPositions: number[]; majorGridPositions: number[]; minorGridPositions: number[]; refLines: AxisRefLineRender[]; showAxisLine: boolean; tickPosition: "outside" | "inside"; showMajorGrid: boolean; showMinorGrid: boolean; majorGridStyle: Required<GridLineStyle>; minorGridStyle: Required<GridLineStyle> }`
  - `computeAxisLayout(params: { axis: "x" | "y"; axisMeta: GraphNewAxis; currentMin: number; currentMax: number; refMin: number; refMax: number; config?: YAxisConfig; refLines?: RefLineX[] | RefLineY[]; autoSpecLines?: boolean; resolvedAutoSpec?: AutoSpec; categoryLabels?: Map<number, string>; formatTick: (axis: GraphNewAxis, tick: { value: number; position: number; label: string | null }) => string }): AxisLayoutResult`
  - `strokeDashArrayForStyle(style: RefLineStyle): string | undefined` (`solid` → `undefined`, `dashed` → `"4 4"`, `dotted` → `"1.5 3"`)

- [ ] **Step 1: Write failing unit tests in `tests/graphNewAxisLayout.test.ts`**
  Assert:
  1. Custom `tickInterval = 25` on `[0, 100]` yields ticks at `0, 25, 50, 75, 100`; tiny `tickInterval = 0.001` on `[0, 1e6]` caps gracefully at ≤ 64 ticks without hanging.
  2. `decimals = 2` formats numeric labels with `toFixed(2)` and normalizes `-0.00` to `"0.00"`; `decimals` is ignored on `category`, `time`, and `duration` axes.
  3. `minorTickCount = 4` emits 4 evenly spaced minor positions between adjacent major ticks (and in leading/trailing edge intervals) within `[0, 1]`; `showMinorGrid` is forced `false` when `minorTickCount` is `0` or `undefined`.
  4. `inverse: true` flips `screenPosition` (`1 - norm`) for major ticks, minor ticks, gridlines, and reference lines.
  5. `refLinesY` + `autoSpecLinesY` emits user lines plus LSL (`#E60000`, `"LSL"`), Target (`#00C853`, `"Target"`), USL (`#E60000`, `"USL"`), clipped to `[0, 1]`; `refLinesX` and `autoSpecLinesX` emit empty array when `axisMeta.kind` is `"category"` or `"time"`.
  6. Default gridline visibility is `false` for both major and minor; default colors `#bdbdbd` (major) / `#e2e2e2` (minor), style `"dashed"`, width `1`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewAxisLayout.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/components/graphBuilderNew/graphNewAxisLayout.ts`**
  Implement `computeAxisLayout` and `strokeDashArrayForStyle` using `projectAxisTicks` / `projectGridPositions` for auto ticks and world-anchored multiples of `tickInterval` (doubling/scaling step if `span / step > 64`) for custom `tickInterval`.

- [ ] **Step 4: Run test to verify pass**
  Run: `npx tsx --tsconfig tsconfig.app.json tests/graphNewAxisLayout.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git --no-pager add src/components/graphBuilderNew/graphNewAxisLayout.ts tests/graphNewAxisLayout.test.ts && git --no-pager commit -m "feat(graph): add frontend axis/grid/minor-tick/ref-line layout engine (#322)"`

---

### Task 5: `GraphNewCanvas` Vector Chrome Overlay, Range↔Camera Sync & Double-Click Triggers

**Files:**
- Modify: `src/components/graphBuilderNew/GraphNewCanvas.tsx`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.css`

**Interfaces:**
- Consumes: `computeAxisLayout`, `strokeDashArrayForStyle` (Task 4); `buildAxisBounds`, updated `panCamera` / `zoomCamera` / `cameraTransform` (Task 3); `hideChrome`, `invertX`, `invertY`, `axisBounds` on `GraphNewRenderRequest` (Task 2)
- Produces:
  - Additional optional props on `GraphNewCanvas`:
    `xAxisConfig?: YAxisConfig`, `yAxisConfig?: YAxisConfig`, `refLinesX?: RefLineX[]`, `refLinesY?: RefLineY[]`, `autoSpecLinesX?: boolean`, `autoSpecLinesY?: boolean`, `resolvedAutoSpecX?: AutoSpec`, `resolvedAutoSpecY?: AutoSpec`, `onXAxisDblClick?: () => void`, `onYAxisDblClick?: () => void`
  - Testable SVG/DOM hooks: `data-testid="graph-new-grid-svg"`, `data-testid="graph-new-axis-svg"`, `data-testid="graph-new-reflines-svg"`, `data-testid="x-axis-ticks"`, `data-testid="y-axis-ticks"`

- [ ] **Step 1: Wire `hideChrome: true`, `invertX`, `invertY`, and `axisBounds` into `GraphNewCanvas` render requests**
  1. Pass `hideChrome: true`, `invertX: Boolean(xAxisConfig?.inverse)`, `invertY: Boolean(yAxisConfig?.inverse)`, and `axisBounds = buildAxisBounds(xAxisConfig, yAxisConfig, xMode)` in `GraphNewRenderRequest` (both primary and overscan renders).
  2. Only re-trigger the Rust render effect when `axisBounds` (serialized key) or `invertX` / `invertY` changes — **NOT** when gridlines, decimals, minor ticks, tickInterval, showAxisLine, tickPosition, or refLines change.
  3. When `axisBounds` changes, reset `retained.desired = null` / `retained.resetPending = true` and clear saved camera so Rust renders the new `effectiveFull` immediately (Option A).
  4. Pass `{ invertX, invertY }` into `panCamera`, `zoomCamera`, `cameraTransform`, and `shouldPreviewCameraTransform`.

- [ ] **Step 2: Replace the old `live-grid` `<div>` with the SVG vector overlay driven by `computeAxisLayout`**
  1. Store live `xLayout` and `yLayout` (computed from latest `xAxisMeta`/`yAxisMeta`, active `current` camera domain, and `axisConfig`/`refLines`/`autoSpec` props via a `useMemo` + live camera state during pan/zoom so style edits re-render SVG/DOM instantaneously with 0 GPU calls).
  2. Render:
     - **Gridlines SVG** (clipped to `plotRect`): minor gridlines first, then major gridlines, using `color`, `width`, `strokeDashArrayForStyle(style)`.
     - **Reference lines SVG** (clipped to `plotRect`): horizontal Y lines and vertical X lines with color/width/dash + non-empty label text inside plot right/top edge.
     - **Axis lines & ticks SVG** (full host bounds, unclipped): left Y axis line and bottom X axis line when `showAxisLine` is true (theme ink `#475569` light / `#aaaaaa` dark), plus major ticks (5px) and minor ticks (3px) oriented `outside` or `inside`.
     - **Axis tick bands** (`x-axis-ticks`, `y-axis-ticks`): collision-filtered labels from `majorTicks`, with `onDoubleClick={onXAxisDblClick}` / `onDoubleClick={onYAxisDblClick}` (plus `pointer-events: auto`, `cursor: pointer`, and tooltip when handler is provided).

- [ ] **Step 3: Add minimal CSS in `src/components/graphBuilderNew/GraphBuilderNewView.css`**
  Style `.graph-new-svg-layer` (`position: absolute; inset: 0; pointer-events: none; overflow: visible`), interactive axis hit bands (`.graph-new-axis-interactive`), and reference line text typography.

- [ ] **Step 4: Run typecheck + existing unit & Playwright CT tests**
  Run: `npm run build && npx tsx --tsconfig tsconfig.app.json tests/graphNewCamera.test.ts && npx playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx`
  Expected: Build passes and existing tests pass (update any existing `live-grid` selector assertion in `graphBuilderNew.spec.tsx` if needed for the new default-off / SVG grid).

- [ ] **Step 5: Commit**
  `git --no-pager add src/components/graphBuilderNew/GraphNewCanvas.tsx src/components/graphBuilderNew/GraphBuilderNewView.css tests/graphBuilderNew.spec.tsx && git --no-pager commit -m "feat(graph): render vector axis/grid/ticks/ref-lines overlay in GraphNewCanvas (#322)"`

---

### Task 6: `GraphBuilderNewView` Dialog Wiring, Spec Limits, Style Inspector & Playwright CT Tests

**Files:**
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.tsx`
- Modify: `src/components/graphBuilderNew/GraphBuilderNewView.css`
- Modify: `tests/GraphBuilderNewHarness.tsx`
- Modify: `tests/graphBuilderNew.spec.tsx`

**Interfaces:**
- Consumes: `AxisSettingsDialog` from `@/components/graphBuilder/AxisSettingsDialog`; `dataService.getColumnDisplayProps`; new store actions from Task 1; new `GraphNewCanvas` props from Task 5
- Produces: Full user-facing X & Y Axis Settings workflow in `GraphBuilderNewView`

- [ ] **Step 1: Wire column spec-limit loading and `AxisSettingsDialog` into `GraphBuilderNewView.tsx`**
  1. Fetch `dataService.getColumnDisplayProps(datasetId)` alongside `getColumnDescriptors(datasetId)` (catch → `[]`) and derive `resolvedAutoSpecX` / `resolvedAutoSpecY` (`AutoSpec`) from `extras.spec` (`lsl`, `target`, `usl`) matching the bound X/Y column index.
  2. Manage `openAxisDialog: "x" | "y" | null` state (closed on `Escape`, disabled when `readOnly`).
  3. Replace the disabled `Axis Settings` placeholder button in the right **Style** inspector with active **X Axis Settings** and **Y Axis Settings** buttons (enabled when `!controlsDisabled && Boolean(session.xColumnId && session.yColumnId)`).
  4. Pass `xAxisConfig`, `yAxisConfig`, `refLinesX`, `refLinesY`, `autoSpecLinesX`, `autoSpecLinesY`, `resolvedAutoSpecX`, `resolvedAutoSpecY`, `onXAxisDblClick`, `onYAxisDblClick` to `GraphNewCanvas`.
  5. Render `<AxisSettingsDialog />` for `openAxisDialog === "x"` or `"y"`, wired to the store setters, `resolvedAutoSpec`, and `autoSpecColName`.

- [ ] **Step 2: Write Playwright CT E2E tests in `tests/graphBuilderNew.spec.tsx` (and mock `getColumnDisplayProps` in `tests/GraphBuilderNewHarness.tsx`)**
  Test scenarios:
  1. Opening Y Axis Settings via double-clicking `y-axis-ticks` AND via Style inspector button; opening X Axis Settings via double-clicking `x-axis-ticks` AND Style inspector button.
  2. Editing **Axis** tab: Range min/max triggers render with `axisBounds` and Reset View returns to custom Range; `tickInterval`, `decimals`, `minorTickCount`, `showAxisLine`, `tickPosition` update SVG/DOM immediately with **0 extra render requests**; `inverse` triggers render with `invertY: true`.
  3. Editing **Tick Grid** tab: Major & Minor gridlines default hidden; enabling Major gridlines + picking color/style/width renders SVG lines with matching attributes; Minor gridlines only render after `minorTickCount > 0` is set.
  4. Editing **Reference Lines** tab: toggling `Auto-show spec limits` overlays LSL/Target/USL from mocked `displayProps`; adding/editing/removing a custom reference line updates `graph-new-reflines-svg` immediately with 0 extra render requests.
  5. Non-numeric X (`category`): X numeric `tickInterval`/`decimals`/`refLinesX` do not corrupt category ticks or draw invalid X ref lines.

- [ ] **Step 3: Run full verification suite**
  Run:
  - `npx tsx --tsconfig tsconfig.app.json tests/graphNewAxisStore.test.ts`
  - `npx tsx --tsconfig tsconfig.app.json tests/graphNewAxisLayout.test.ts`
  - `npx tsx --tsconfig tsconfig.app.json tests/graphNewCamera.test.ts`
  - `npx tsx --tsconfig tsconfig.app.json tests/graphNewService.test.ts`
  - `npm run build`
  - `npx playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx`
  - `cargo test --manifest-path src-tauri/Cargo.toml graph_new_renderer::tests && cargo test --manifest-path src-tauri/Cargo.toml graph_new_ticks::tests`
  Expected: All PASS with zero errors.

- [ ] **Step 4: Commit**
  `git --no-pager add src/components/graphBuilderNew/GraphBuilderNewView.tsx src/components/graphBuilderNew/GraphBuilderNewView.css tests/GraphBuilderNewHarness.tsx tests/graphBuilderNew.spec.tsx && git --no-pager commit -m "feat(graph): wire X/Y AxisSettingsDialog, spec limits, and CT tests for Graph Builder for Massive Data (#322)"`
