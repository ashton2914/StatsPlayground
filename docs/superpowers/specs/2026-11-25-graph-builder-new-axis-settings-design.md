# Graph Builder for Massive Data — Axis Settings Design

**Issue**: [#322](https://github.com/ashton2914/StatsPlayground/issues/322)
**Date**: 2026-11-25
**Status**: Approved

---

## 1. Intent & Why

Bring **Graph Builder for Massive Data** (`src/components/graphBuilderNew/`) to full feature and visual parity with **Classic Graph Builder** (`src/components/graphBuilder/`) for X and Y axis settings. Users working with massive datasets need the same control over axis bounds, tick intervals, decimal formatting, minor ticks, reversed axes, customizable major/minor gridlines, reference lines, and automatic column spec-limit overlays (LSL / Target / USL) that they already rely on in Classic Graph Builder.

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- Reuse Classic Graph Builder's `AxisSettingsDialog` UI (`Axis`, `Tick Grid`, `Reference Lines` tabs) for both X and Y axes in `GraphBuilderNewView`.
- Support all 3 tabs' settings end-to-end with 1:1 visual and behavioral parity:
  1. **Axis**: Range (`min`, `max`), `tickInterval`, `decimals`, `minorTickCount`, `inverse`, `showAxisLine`, `tickPosition` (`outside` | `inside`), Reset to default.
  2. **Tick Grid**: Theme presets, `showMajorGrid`, `showMinorGrid` (gated on `minorTickCount > 0`), `majorGridStyle` / `minorGridStyle` (color presets + custom hex, `solid` | `dashed` | `dotted`, width `0.5`–`5`), Reset to default.
  3. **Reference Lines**: `autoSpecLinesX` / `autoSpecLinesY` (reads column `extras.spec` LSL `#E60000` / Target `#00C853` / USL `#E60000`) and user-defined `refLinesX` / `refLinesY` (label, value, color, `solid` | `dashed` | `dotted`, width).
- **Range ↔ Camera interaction (User Decision: Option A)**: Custom `min` / `max` define the axis's effective full domain and Reset View target, and immediately apply to the active camera when edited. Users can still pan/zoom freely to inspect detail and click Reset View to return to their custom Range.
- Open the dialog by **double-clicking the X or Y axis tick region** (matching Classic) AND via the **Style inspector → Axis Settings** control (replacing the current disabled placeholder button).
- Persist all axis settings, reference lines, and auto-spec flags in `.spgn` documents with backward compatibility for existing v1/v2/v3 documents.

### Non-Goals
- Multi-column melted `BandRefLine` (Graph Builder for Massive Data currently supports single X and single Y column bindings; `multiValueColCount` is `0`).
- Log scale or custom date/time format strings (not present in Classic's `AxisSettingsDialog`).
- Raster image export compositing (out of scope for this issue).

### Anti-Goals
- Triggering Rust GPU re-renders for purely visual chrome edits (gridline color/dash/width, decimals, minor ticks, tick position, axis line visibility, reference lines).
- Duplicating gridline/tick/reference-line rendering logic in both Rust wgpu and TypeScript.
- Breaking existing pan/zoom smoothness, overscan pre-rendering (`#319`), or read-only project mode.

## 3. Approaches Considered

| Approach | Summary | Trade-offs |
|---|---|---|
| **Approach 1 (Selected)** | **Rust GPU data-only + Frontend SVG/DOM vector overlay** for gridlines, axis lines, major/minor ticks, tick labels, and reference lines. Rust only adds `invertX` / `invertY` and suppresses baked-in static chrome (`hideChrome`). | **Pros**: 0 GPU round-trips for style/tick/ref-line edits (instant 60fps); seamless lockstep during `#319` live pan/zoom; crisp dashed/dotted strokes and text labels without hitting Rust's 1024-mark decoration cap.<br>**Cons**: Chrome is composited in the frontend rather than baked into the raw RGBA8 frame buffer. |
| **Approach 2 (Rejected)** | **Rust wgpu chrome rendering** (pass full axis/grid/ref-line configs to Rust, implement dashed shaders, keep DOM for labels and live pan/zoom preview). | **Pros**: Strokes baked into RGBA8 buffer.<br>**Cons**: Duplicates grid/tick/ref-line rendering across Rust and TS; every style tweak triggers a GPU round-trip; high shader/validation complexity. |

## 4. Architecture & Component Design

### 4.1 Persistence & Store (`src/types/graphBuilderNew.ts`, `src/stores/useGraphBuilderNewStore.ts`)
Extend `GraphBuilderNewDocument` (remain `version: 3` with optional fields so existing v3 `.spgn` files load seamlessly without a breaking version bump):
```ts
export interface GraphBuilderNewDocument extends Omit<GraphBuilderNewDocumentV2, "version" | "showMean" | "rawMode"> {
  version: 3;
  layers: GraphNewLayer[];
  xAxisConfig?: YAxisConfig;
  yAxisConfig?: YAxisConfig;
  refLinesX?: RefLineX[];
  refLinesY?: RefLineY[];
  autoSpecLinesX?: boolean;
  autoSpecLinesY?: boolean;
}
```
- Mirror these optional fields on `GraphBuilderNewSession`.
- Normalization in `normalizeGraphNewDocument`:
  - Sanitize `xAxisConfig` / `yAxisConfig` (drop empty configs via `isAxisConfigEmpty`; reject non-finite numbers; clamp `decimals` to `0..10`, `minorTickCount` to `0..20`, `tickInterval > 0`).
  - Sanitize `refLinesX` / `refLinesY` (filter invalid entries, default style/width/color safely).
  - Normalize `autoSpecLinesX` / `autoSpecLinesY` as booleans (omit when `false`).
- Store actions on `useGraphBuilderNewStore`:
  - `setXAxisConfig(id, config: YAxisConfig | undefined)`
  - `setYAxisConfig(id, config: YAxisConfig | undefined)`
  - `setRefLinesX(id, lines: RefLineX[])`
  - `setRefLinesY(id, lines: RefLineY[])`
  - `setAutoSpecLinesX(id, enabled: boolean)`
  - `setAutoSpecLinesY(id, enabled: boolean)`
- Column change behavior:
  - Keep `xAxisConfig`, `yAxisConfig`, `refLinesX`, `refLinesY`, `autoSpecLinesX`, `autoSpecLinesY` non-destructive when changing columns (matching Classic), while still resetting `camera: null` on X/Y column change.
- Read-only enforcement: all setters go through `update(...)` which calls `assertProjectMutable(readOnly)` and `markDirty()`.

### 4.2 Rust Backend Changes (`src-tauri/src/models/graph_new.rs`, `graph_new_renderer.rs`, `graph_new_service.rs`, `src/services/graphNewService.ts`)
Keep Rust changes minimal and strictly scoped to what affects the GPU data bitmap and domain validation:
1. Add optional fields to `GraphNewRenderRequest` (with `#[serde(default)]` so existing callers/tests remain 100% compatible):
   - `invert_x: bool` (`invertX`)
   - `invert_y: bool` (`invertY`)
   - `hide_chrome: bool` (`hideChrome`) — when `true`, `graph_new_renderer::prepare()` skips emitting the hardcoded `GRID` and `INK` axis boundary quads (`marks` starts empty for chrome), keeping only plot data (`points`, `raster`, `raw_line`, `mean`, `layer_geometry`) inside `plot_rect`.
   - `axis_bounds: Option<GraphNewAxisBounds>` (`axisBounds?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number }`) — optional user-specified Range overrides (only finite values; ignored for an axis if `min >= max` or non-numeric X axis).
2. **Domain resolution & `validate_camera_limits` (Builder Call)**:
   - In `graph_new_service.rs`, compute `effective_full` by applying `axis_bounds` on top of `data_full` (for each axis, if `axis_bounds` supplies a finite `min` and/or `max` that yields `min < max`, use it; otherwise keep `data_full`'s bound).
   - When `camera_domain` is `None` (initial render, cache miss, or Reset View), render `effective_full` instead of raw `data_full` (still building/keying the data cache on `data_full`, so cache misses never fail with `graph_new_missing_cache`).
   - Run `validate_camera_limits` relative to `effective_full` instead of raw `data_full` so wide/narrow user Ranges (e.g. `0–1000` on data in `[45, 55]`) never trigger `graph_new_invalid_request`, while pan/zoom stays safely bounded relative to `effective_full`.
3. Implement `invert_x` / `invert_y` in `graph_new_renderer.rs` and pixel-aggregation paths (`graph_new_pixels.rs`, `graph_new_line_pixels.rs`, `graph_new_pixel_jitter.rs`, `graph_new_layers.rs`):
   - Map normalized coordinate `u ∈ [0, 1]` to `1.0 - u` when `invert_x` is true, and `v ∈ [0, 1]` to `1.0 - v` when `invert_y` is true, consistently across:
     - GPU point shader / `PointBasis::camera` affine transform
     - Raw line / mean segment / layer geometry projection
     - CPU pixel rasterizer (`PixelRaster` / pixel-aggregated scatter & line)
   - `completion.cameraDomain` remains canonical (`xMin < xMax`, `yMin < yMax`); inversion is purely a display-direction flag so camera math and validation invariants (`xMin < xMax`, `yMin < yMax`) stay simple and sound.
4. Mirror `invertX`, `invertY`, `hideChrome`, `axisBounds` in `src/services/graphNewService.ts` request type and validation.

### 4.3 Range, Camera, Non-Numeric X & Inversion Math (`src/components/graphBuilderNew/graphNewCamera.ts`)
1. **Effective Full Domain (Option A)**:
   - On unconstrained render (`cameraDomain: null` + `axisBounds`), Rust returns `effectiveFull` as `completion.cameraDomain`, which becomes `retained.full` in `GraphNewCanvas`.
   - When `xAxisConfig?.min/max` or `yAxisConfig?.min/max` changes (on an axis where numeric Range applies):
     - Clear saved camera / reset `current` to `null` and launch a render with `cameraDomain: null` and the updated `axisBounds`, so Rust immediately renders and returns the new `effectiveFull` (no stale cache-miss failure, and pan/zoom bounds automatically rebase to `effectiveFull`).
   - Guard: if user enters `min >= max` (e.g. while typing), omit that axis's invalid bound from `axisBounds` until `min < max` so `isCameraDomain` is never violated.
   - **Reset View** sets `cameraDomain: null` (with current `axisBounds`), returning to `effectiveFull` (or `dataFull` when Auto).
   - **Pan & Zoom with `invertX` / `invertY`**:
     - `panCamera`: negate `dx` when `invertX` is true; negate `dy` when `invertY` is true.
     - `zoomCamera`: flip pointer anchor `ax → 1 - ax` when `invertX`; `ay → 1 - ay` when `invertY`.
     - `cameraTransform` (for live preview canvas transform during pan/zoom): flip X/Y offset signs when `invertX` / `invertY` is true so the overscan preview moves in the exact direction of the pointer.
2. **Non-Numeric X Axis Behavior (`category`, `time`, `duration`) (Builder Call)**:
   - All stored X settings remain non-destructive in the document when switching X columns.
   - `category` X: apply `inverse`, `showAxisLine`, `tickPosition`, `showMajorGrid` / `majorGridStyle`; ignore `min`, `max`, `tickInterval`, `decimals`, `minorTickCount`, `showMinorGrid`, `refLinesX`, and `autoSpecLinesX`.
   - `time` X: because `cameraDomain` uses dataset-relative `(epoch_nanos - origin) / unit_nanos` and Classic's `AxisSettingsDialog` only accepts plain numeric inputs, apply `inverse`, `showAxisLine`, `tickPosition`, `minorTickCount`, `showMajorGrid` / `showMinorGrid` + styles; ignore numeric `min`, `max`, `tickInterval`, `decimals`, `refLinesX`, and `autoSpecLinesX` so timestamps are never corrupted.
   - `duration` X (seconds): apply numeric `min`, `max`, `tickInterval`, `refLinesX`, `autoSpecLinesX`, `inverse`, `showAxisLine`, `tickPosition`, `minorTickCount`, and gridlines; ignore `decimals` so `H:MM:SS` duration formatting is preserved.
3. **Tick, Minor Tick & Grid Position Computation** (new helper module `src/components/graphBuilderNew/graphNewAxisLayout.ts`):
   - **Major ticks**:
     - If `axis.kind === "category"`: use category positions (ignore `tickInterval` / `decimals`, honor `inverse` for screen position `pos = invert ? 1 - norm : norm`).
     - If `axis.kind === "numeric"` and `config?.tickInterval > 0`: generate world-anchored ticks at multiples of `tickInterval` within `[currentMin, currentMax]` (with a safety cap, e.g. ≤ 64 ticks; if `span / tickInterval > 64`, step up or cap gracefully so a tiny interval on a huge range never freezes the UI).
     - Otherwise (Auto): reuse `#319`'s world-anchored nice tick projection (`projectAxisTicks`), then apply `invert` (`screenPos = invert ? 1 - normPos : normPos`).
   - **Tick label formatting**:
     - If `axis.kind === "numeric"` and `config?.decimals !== undefined`: format with `value.toFixed(decimals)` (normalizing `-0` to `0`).
     - Otherwise: keep existing compact/time/duration/category formatting (`formatGraphNewTick` / `formatCompactNumericTick`).
   - **Minor ticks**:
     - Only for non-category axes when `minorTickCount > 0`.
     - Between every pair of adjacent major ticks (and extrapolating one major step before the first / after the last major tick so edge sub-intervals are filled), place `minorTickCount` evenly spaced minor positions (`k / (minorTickCount + 1)` for `k = 1..minorTickCount`), filtered to `[0, 1]`.
   - **Reference lines & Auto-spec lines**:
     - Combine user `refLinesY` + (if `autoSpecLinesY` and `resolvedAutoSpecY`) LSL (`#E60000`, `"LSL"`), Target (`#00C853`, `"Target"`), USL (`#E60000`, `"USL"`). Same for X when X is numeric/time/duration (silently skipped when X is categorical, matching Classic).
     - Project each line's value into `[0, 1]` using `normalizedAxisValue` + `invert`. Clip lines outside `[0, 1]`.

### 4.4 Frontend Vector Chrome Overlay (`src/components/graphBuilderNew/GraphNewCanvas.tsx`)
Render a crisp SVG layer aligned to the canvas host (sized to `host` bounds, using `plotLeft`, `plotTop`, `plotWidth`, `plotHeight` in CSS px) that updates at 60fps both on settled frames and during live pan/zoom:
1. **Layer stacking order**:
   - Bottom: Canvas (`rgba8` data bitmap with `hideChrome: true`) + live overscan preview inside `plotHost`.
   - Gridlines SVG (clipped to `plotRect`, `pointer-events: none`):
     - Minor gridlines (drawn first, below major): rendered when `showMinorGrid === true` AND `minorTickCount > 0`. Default color `#e2e2e2`, default style `dashed`, default width `1`.
     - Major gridlines: rendered when `showMajorGrid === true`. Default color `#bdbdbd`, default style `dashed`, default width `1`.
     - Dash patterns (`strokeDasharray`): `solid` → none, `dashed` → `"4 4"`, `dotted` → `"1.5 3"`.
     - Note on default gridlines: Classic Graph Builder defaults `showMajorGrid` to `false` (matching `AxisSettingsDialog`'s unchecked checkbox). Wait — let's verify: in Classic, both Major and Minor gridlines default to unchecked (`false`) so the dialog checkbox matches the chart!
   - Reference lines SVG (clipped to `plotRect`, `pointer-events: none`):
     - Horizontal lines for Y (`y = plotTop + (1 - screenPos) * plotHeight` — or `screenPos` directly if `screenPos` is top-down), vertical lines for X.
     - Render label text near the right end (Y) or top end (X) inside the plot with matching color and clean padding when `label.trim() !== ""`.
   - Axis lines & ticks SVG (`pointer-events: none`, unclipped so outside ticks extend past `plotRect`):
     - Drawn per axis when `showAxisLine !== false` (default `true`).
     - Axis boundary line at left edge (Y) and bottom edge (X), colored with theme ink (`#475569` light / `#aaaaaa` dark).
     - Major tick marks (`length = 5px`) and minor tick marks (`length = 3px`), pointing outward (`tickPosition !== "inside"`) or inward (`tickPosition === "inside"`).
   - Tick labels DOM (`x-axis-ticks`, `y-axis-ticks`):
     - Existing collision-avoiding label layout, now driven by `graphNewAxisLayout.ts` (respecting `tickInterval`, `decimals`, `inverse`).
     - **Double-click triggers**: `onDoubleClick` on the X-axis tick band opens X Axis Settings; `onDoubleClick` on the Y-axis tick band opens Y Axis Settings (when `!readOnly` and columns are bound), with `cursor: pointer` and tooltip hint matching Classic.

### 4.5 UI Integration (`src/components/graphBuilderNew/GraphBuilderNewView.tsx`)
- Load column display props via `dataService.getColumnDisplayProps(datasetId)` alongside `dataService.getColumnDescriptors(datasetId)` (non-blocking fallback to `[]` if unavailable), and resolve `autoSpecX` / `autoSpecY` by matching column index/name to `extras.spec` (`lsl`, `target`, `usl`), reusing the same extraction logic as `graphRuntimeModel.ts`.
- Replace the disabled `Axis Settings` placeholder button in the right **Style** inspector with an active entry (two compact buttons or segmented row: **X Axis Settings** / **Y Axis Settings**, or an **Axis Settings** menu/buttons; specifically placing **X Axis Settings** and **Y Axis Settings** buttons in the Style section so both axes are 1-click accessible even without knowing the double-click shortcut).
- Mount Classic's `<AxisSettingsDialog />` directly for `axis="x"` and `axis="y"` when opened, wired to the store setters, `resolvedAutoSpec`, and `autoSpecColName`.
- Esc key closes the dialog (matching Classic).

## 5. Testing & Verification Plan
- **Unit tests (Vitest)**:
  - `graphNewAxisLayout.test.ts`: major tick generation with `tickInterval` (including huge-range cap), `decimals` formatting, `minorTickCount` sub-ticks, `inverse` coordinate mapping, reference line + auto-spec projection and categorical X skipping.
  - `graphNewCamera.test.ts`: `resolveEffectiveFullDomain` (partial min-only, max-only, invalid `min >= max` fallback), `panCamera` / `zoomCamera` / `cameraTransform` under `invertX` and `invertY`.
  - `useGraphBuilderNewStore.test.ts`: persistence normalization of v1/v2/v3 documents with and without axis configs / ref lines / auto-spec flags, read-only guards, empty config cleanup.
- **Rust unit tests (`cargo test`)**:
  - `graph_new_renderer::tests`: `hide_chrome: true` produces no grid/axis ink outside data; `invert_x` and `invert_y` mirror rendered point/raster/line coordinates accurately across both GPU and pixel-aggregated paths.
  - `graph_new_service` / `models::graph_new`: serde defaults and validation for `invertX`, `invertY`, `hideChrome`.
- **Component / E2E tests (Playwright CT)**:
  - `tests/graphBuilderNew.spec.tsx`: opening X/Y `AxisSettingsDialog` via double-clicking axis bands and Style inspector buttons; editing Range, Tick interval, Decimals, Minor ticks, Reverse, Axis line/tick position, Major/Minor gridlines, and Reference lines + Auto-spec; verifying SVG/DOM output and Reset View returning to custom Range.

## 6. Left to the Builder
- Exact CSS class names and subtle spacing/padding tweaks for the SVG overlay and Style inspector X/Y axis buttons.
- Exact i18n keys to reuse vs add (reuse `graph.yAxisSettings.*`, `graph.xAxisSettings.*`, `graph.axis.*`, `graph.grid.*`, `graph.refLine.*` wherever they already exist).
