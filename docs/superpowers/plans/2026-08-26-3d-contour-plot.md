# 3D Contour Plot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class 3D Contour layer that extracts constant-Z lines from the same regular grid as Surface and renders them in the existing ECharts GL scene.

**Architecture:** A pure `contours3d.ts` module owns marching-squares extraction and segment stitching. `threeD.ts` exposes one internal surface-grid shape to both Surface and Contour, while Graph Builder registers `contour3d` as a normal 3D layer with statistic, smoothness, and level controls.

**Tech Stack:** React 19, TypeScript 5.7, ECharts 5.6, echarts-gl 2.0.9, Node's built-in assertions and strip-types test runner.

## Global Constraints

- Contours follow X, Y, Z, Overlay, hidden-group, and theme-color behavior already used by Surface.
- Aggregation is `mean` or `median`; smoothness is clamped to 0..1; levels are clamped to integer 3..20 and default to 10.
- Missing grid vertices invalidate adjacent cells, so geometry never bridges holes.
- Contour Z rendering offset is one millionth of the finite Z span.
- Extraction accepts at most 20,000 segments and emits at most 512 connected polylines per group.
- No new runtime dependencies.

---

### Task 1: Pure Marching-Squares Contour Extraction

**Files:**
- Create: `src/graphCore/contours3d.ts`
- Create: `tests/contours3d.test.ts`

**Interfaces:**
- Consumes: regular grid coordinates `xs`, `ys`, row-major `values`, requested `levels`, and finite `zmin` / `zmax`.
- Produces: `buildContourPolylines(grid, requestedLevels): ContourPolyline[]`, where `ContourPolyline` is `{ level: number; points: [number, number, number][] }`.

- [ ] **Step 1: Write the failing interpolation test**

Create a 2x2 monotonic grid and assert that a level of 1 crosses the expected interpolated edge positions:

```ts
const lines = buildContourPolylines({
  xs: [0, 1], ys: [0, 1],
  values: new Float64Array([0, 1, 1, 2]),
  zmin: 0, zmax: 2,
}, 3);
assert.deepEqual(lines.find((line) => line.level === 1), {
  level: 1,
  points: [[1, 0, 1], [0, 1, 1]],
});
assert.deepEqual([...new Set(lines.map((line) => line.level))], [0.5, 1, 1.5]);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --experimental-strip-types tests/contours3d.test.ts`

Expected: FAIL because `src/graphCore/contours3d.ts` does not exist.

- [ ] **Step 3: Implement the minimal marching-squares API**

Define `ContourGrid`, `ContourPolyline`, clamp requested levels to 3..20, generate levels strictly inside `(zmin, zmax)`, interpolate finite cell edges, and return deterministic two-point lines. Export only `buildContourPolylines` and its input/output types.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --experimental-strip-types tests/contours3d.test.ts`

Expected: `contours3d regressions passed`.

- [ ] **Step 5: Add failing tests for holes, saddles, flat grids, stitching, and caps**

Assert that a NaN vertex yields no segment for its cell, a flat grid yields no lines, adjacent cell segments join into one maximal polyline, saddle output is deterministic, level counts are clamped, no result exceeds 20,000 accepted segments or 512 polylines, and all emitted points are finite.

- [ ] **Step 6: Run the expanded test and verify RED**

Run: `node --experimental-strip-types tests/contours3d.test.ts`

Expected: FAIL on the first not-yet-implemented edge behavior.

- [ ] **Step 7: Implement stitching and safety limits**

Use a scale-aware quantized endpoint key, extend both ends of open polylines, close loops when endpoints meet, choose saddle pairing from the bilinear center value, process levels and cells in ascending deterministic order, stop accepting segments at 20,000, and stop emitting after 512 polylines.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `node --experimental-strip-types tests/contours3d.test.ts`

Expected: all contour algorithm assertions pass.

- [ ] **Step 9: Commit the algorithm**

```powershell
git add src/graphCore/contours3d.ts tests/contours3d.test.ts
git commit -m "feat(graph): add 3D contour extraction"
```

### Task 2: Share Surface Grid And Emit Contour Series

**Files:**
- Modify: `src/graphCore/types.ts`
- Modify: `src/graphCore/threeD.ts`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `tests/threeD.test.ts`

**Interfaces:**
- Consumes: `buildContourPolylines` from Task 1 and existing row-backed / frame-backed 3D point paths.
- Produces: `ElementKind` value `contour3d` and ECharts `line3D` series named `${group}__contour_${level}_${index}`.

- [ ] **Step 1: Write failing 3D option tests**

Extend `tests/threeD.test.ts` with a `contour3d` spec over a 3x3 grid. Assert that `build3DOption` emits finite `line3D` data, does not require Surface to be enabled, applies the configured level count, offsets rendered Z above each source level, colors lines with the group theme color, and omits hidden Overlay groups.

- [ ] **Step 2: Run the 3D test and verify RED**

Run: `node --experimental-strip-types tests/threeD.test.ts`

Expected: TypeScript/runtime failure because `contour3d` is not an `ElementKind` and no contour series are emitted.

- [ ] **Step 3: Add the layer type and shared grid result**

Add `"contour3d"` to `ElementKind`. In `threeD.ts`, replace the duplicated return shapes of `buildSurfaceData` and `buildSurfaceDataFromPoints` with an internal `SurfaceGrid` that includes `xs`, `ys`, `values`, `verts`, `dataShape`, `zmin`, and `zmax`. Preserve existing Surface vertices and smoothing behavior byte-for-byte.

- [ ] **Step 4: Emit contour `line3D` series**

Read contour options independently from Surface. Build a grid when either Surface or Contour is enabled, call `buildContourPolylines`, add the Z offset only while mapping output into ECharts data, set `silent: true`, and use `{ color, width: 2, opacity: 0.9 }`. Do not add contour indices to `groupSeries` visualMap indices.

- [ ] **Step 5: Extend data-pipeline field derivation**

Treat `contour3d` as a 3D element that requires the Z field in `deriveFields`, preserving existing size-field behavior for scatter only.

- [ ] **Step 6: Run contour and 3D tests and verify GREEN**

Run:

```powershell
node --experimental-strip-types tests/contours3d.test.ts
node --experimental-strip-types tests/threeD.test.ts
```

Expected: both regression suites pass.

- [ ] **Step 7: Commit 3D integration**

```powershell
git add src/graphCore/types.ts src/graphCore/threeD.ts src/components/graphBuilder/useGraphDataPipeline.ts tests/threeD.test.ts
git commit -m "feat(graph): render contour layers in 3D"
```

### Task 3: Graph Builder Controls And Localization

**Files:**
- Create: `src/components/graphBuilder/graphLayerConfig.ts`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Create: `tests/graphLayerConfig.test.ts`

**Interfaces:**
- Consumes: `contour3d` layer kind and options `{ stat, smoothness, levels }` from Task 2.
- Produces: exported `GRAPH_LAYER_DEFS`, `LAYER_DIM`, and `defaultLayerOptions(kind, existingElements)` configuration plus `Contour3DOptions` controls.

- [ ] **Step 1: Add a failing runtime configuration test**

Create `tests/graphLayerConfig.test.ts` and import the wished-for configuration exports plus each locale JSON object. Assert the layer registry includes `contour3d`, its dimension is `3d`, defaults are `{ stat: "mean", smoothness: 0, levels: 10 }`, and every locale defines non-empty `graph.element.contour3d` and `graph.opt.contourLevels` strings. UI compilation in Step 6 verifies the options-editor routing.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --experimental-strip-types tests/graphLayerConfig.test.ts`

Expected: FAIL because `graphLayerConfig.ts` and the locale keys are absent.

- [ ] **Step 3: Extract layer configuration and register defaults**

Move the existing chart definitions and dimensionality map into `graphLayerConfig.ts` as `GRAPH_LAYER_DEFS` and `LAYER_DIM`. Add `{ kind: "contour3d", icon: "≋" }`, map it to `"3d"`, and implement `defaultLayerOptions` preserving smoother, fitline, surface, and scatter3d defaults while returning `{ stat: "mean", smoothness: 0, levels: 10 }` for Contour. Update `GraphBuilderView.tsx` to consume these exports and route the contour card to `Contour3DOptions`.

- [ ] **Step 4: Add the options editor**

Implement controls matching Surface's statistic and smoothness controls plus an integer range/input for levels constrained to 3..20. Use existing `OptRow`, `gb-opt-select`, and `gb-slider` styles; do not add CSS.

- [ ] **Step 5: Add all locale strings**

Add localized Contour layer labels, contour-level labels, and update 3D empty-state guidance to say Surface, Contour, or Scatter in English, Simplified Chinese, Traditional Chinese, and Vietnamese.

- [ ] **Step 6: Run focused tests and frontend build**

Run:

```powershell
node --experimental-strip-types tests/threeD.test.ts
node --experimental-strip-types tests/graphLayerConfig.test.ts
npx vite build
```

Expected: test prints `threeD regressions passed`; Vite exits 0.

- [ ] **Step 7: Commit UI integration**

```powershell
git add src/components/graphBuilder/graphLayerConfig.ts src/components/graphBuilder/GraphBuilderView.tsx src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/graphLayerConfig.test.ts
git commit -m "feat(graph): add 3D contour controls"
```

### Task 4: Final Regression And Review

**Files:**
- Modify only files required by concrete failures found in this task.

**Interfaces:**
- Consumes: completed contour algorithm, renderer integration, and UI controls.
- Produces: verified issue #45 implementation with clean diff and conventional commits.

- [ ] **Step 1: Run all graph-related Node regression tests**

Run every `tests/*.test.ts` file with `node --experimental-strip-types`, stopping and fixing only failures caused by this branch.

- [ ] **Step 2: Run the production frontend build**

Run: `npx vite build`

Expected: exit code 0 with generated production assets.

- [ ] **Step 3: Run diff and diagnostics checks**

Run: `git diff --check HEAD~3..HEAD` and inspect `git status --short`. Use VS Code diagnostics on all modified TypeScript/TSX files; resolve errors introduced by this branch.

- [ ] **Step 4: Review requirements against the design**

Confirm the independent layer, defaults, clamping, holes, saddles, stitching, Overlay groups, hidden groups, theme colors, offset, caps, no new dependencies, and all four locales each have implementation or test evidence.

- [ ] **Step 5: Run the final focused verification again**

Run:

```powershell
node --experimental-strip-types tests/contours3d.test.ts
node --experimental-strip-types tests/threeD.test.ts
node --experimental-strip-types tests/graphLayerConfig.test.ts
npx vite build
```

Expected: both tests pass and Vite exits 0.

- [ ] **Step 6: Commit any review-only corrections**

If Task 4 required source changes, stage only those files and commit with `fix(graph): address 3D contour review`. If no corrections were needed, do not create an empty commit.