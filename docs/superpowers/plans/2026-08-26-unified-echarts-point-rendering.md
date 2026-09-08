# Unified ECharts Point Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frame-backed Canvas raw-point path with one standard ECharts scatter path while retaining typed IPC performance through a measured point budget and explicit sampling.

**Architecture:** `GraphDataFrame` remains the production data source. `transform.ts` resolves graph semantics and calls a mechanical typed-frame scatter adapter that emits ordinary ECharts series; ECharts owns all 2D drawing and interaction. Full frames above the measured budget omit raw payloads explicitly while exact aggregate packets continue to render.

**Tech Stack:** React 19, TypeScript 5.7, ECharts 5.6.0, Vite 6, Tauri 2.10, Rust 2021, DuckDB, Node native TypeScript stripping.

## Global Constraints

- ECharts is the only production 2D renderer; do not retain Canvas, `large`, `scatterGL`, or a size-dependent renderer fallback.
- Frame-backed graph construction must not read or reconstruct `GraphData.rows`.
- Full Data never silently samples or drops raw observations.
- Histogram, heatmap, boxplot, and summary packets remain exact over all filtered rows.
- `stacked`, `uniform`, and `normal` jitter are deterministic and apply consistently to every legend group.
- The point budget is selected from measured candidates `[5_000, 8_000, 10_000, 20_000, 50_000, 100_000]`; choose the largest candidate meeting coherent frame <= 2 seconds and avoidable main-thread task <= 200 milliseconds, apply a 20% safety reduction rounded down to the nearest 1,000, then select the largest measured passing candidate at or below that cap. Throw if no measured candidate passes or no measured passing candidate validates the cap.
- Preserve cancellation, generation checks, explicit sampling seeds, frame caching, axis interaction, and 3D rendering.
- Do not stage, modify, or commit the untracked `query.js`.
- Existing uncommitted frame/aggregate transport fixes are part of the working baseline; do not revert them. Canvas-only jitter edits are superseded and removed by this plan.

---

### Task 1: Measure Ordinary ECharts Scatter Budget

**Files:**
- Create: `src/graphCore/scatterBudget.ts`
- Create: `src/benchmarks/ScatterBudgetBenchmark.tsx`
- Create: `scripts/runScatterBudget.mjs`
- Create: `tests/scatterBudgetHarness.test.ts`
- Create: `docs/performance/echarts-scatter-budget-2026-08-26.md`
- Modify: `src/main.tsx`
- Modify: `package.json`

**Interfaces:**
- Produces: `SCATTER_RENDER_BUDGET` recorded as an exact integer in the performance report for Tasks 4 and 5.
- Produces: `npm run benchmark:scatter` as a repeatable target-WebView benchmark command.

- [x] **Step 1: Add the failing harness contract test**

Create `tests/scatterBudgetHarness.test.ts` with assertions for the deterministic candidate sequence and safety calculation:

```ts
import assert from "node:assert/strict";
import {
  BUDGET_CANDIDATES,
  chooseScatterBudget,
} from "../src/graphCore/scatterBudget.ts";

assert.deepEqual(BUDGET_CANDIDATES, [5_000, 8_000, 10_000, 20_000, 50_000, 100_000]);
assert.equal(chooseScatterBudget([
  { points: 5_000, coherentFrameMs: 180, longestTaskMs: 30 },
  { points: 8_000, coherentFrameMs: 240, longestTaskMs: 35 },
  { points: 10_000, coherentFrameMs: 300, longestTaskMs: 40 },
  { points: 20_000, coherentFrameMs: 700, longestTaskMs: 80 },
  { points: 50_000, coherentFrameMs: 1_700, longestTaskMs: 180 },
  { points: 100_000, coherentFrameMs: 3_000, longestTaskMs: 280 },
]), 20_000);
```

- [x] **Step 2: Run the contract test and verify RED**

Run: `node --experimental-strip-types tests/scatterBudgetHarness.test.ts`

Expected: FAIL because `src/graphCore/scatterBudget.ts` does not exist.

- [x] **Step 3: Add the policy module and target-WebView benchmark harness**

Create `src/graphCore/scatterBudget.ts` with:

```ts
export const BUDGET_CANDIDATES = [5_000, 8_000, 10_000, 20_000, 50_000, 100_000] as const;

export interface ScatterBudgetMeasurement {
  points: number;
  coherentFrameMs: number;
  longestTaskMs: number;
}

export function chooseScatterBudget(rows: readonly ScatterBudgetMeasurement[]): number {
  const passing = rows
    .filter((row) => row.coherentFrameMs <= 2_000 && row.longestTaskMs <= 200)
    .map((row) => row.points);
  if (passing.length === 0) {
    throw new Error("No measured scatter candidate passed the performance thresholds");
  }

  const largestPassing = Math.max(...passing);
  const safetyCap = Math.floor((largestPassing * 0.8) / 1_000) * 1_000;
  const measuredSafe = passing.filter((points) => points <= safetyCap);
  if (measuredSafe.length === 0) {
    throw new Error(`No measured passing scatter candidate validates the ${safetyCap}-point safety cap`);
  }
  return Math.max(...measuredSafe);
}
```

`src/benchmarks/ScatterBudgetBenchmark.tsx` must run inside the Tauri WebView, construct standard ECharts scatter series for each candidate, and display copyable JSON containing:

```ts
interface ScatterBenchmarkResult extends ScatterBudgetMeasurement {
  grouped: boolean;
  faceted: boolean;
  setOptionMs: number;
  zoomPatchMs: number;
  brushMs: number;
}
```

Run ungrouped, two-group, and four-facet cases three times each. The report uses the median coherent-frame and maximum longest-task values per candidate. `src/main.tsx` renders the benchmark component only when `import.meta.env.DEV && import.meta.env.VITE_SCATTER_BENCHMARK === "1"`; normal app startup remains unchanged.

`scripts/runScatterBudget.mjs` spawns the platform npm executable with `run tauri dev` and environment variable `VITE_SCATTER_BENCHMARK=1`. Add this exact package script:

```json
"benchmark:scatter": "node scripts/runScatterBudget.mjs"
```

- [x] **Step 4: Run the harness and record the measured budget**

Run:

```powershell
npm run benchmark:scatter
```

Expected: all candidate measurements are written to `docs/performance/echarts-scatter-budget-2026-08-26.md`; the report names the exact selected `SCATTER_RENDER_BUDGET` calculated by `chooseScatterBudget` and includes OS, WebView2, CPU, and app build identifiers.

- [x] **Step 5: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/scatterBudgetHarness.test.ts
npm run build
git diff --check
```

Expected: all commands pass; only existing Vite bundle warnings remain.

Commit:

```powershell
git add package.json scripts/runScatterBudget.mjs src/main.tsx src/benchmarks/ScatterBudgetBenchmark.tsx src/graphCore/scatterBudget.ts tests/scatterBudgetHarness.test.ts docs/performance/echarts-scatter-budget-2026-08-26.md
git commit -m "perf(graph): establish ECharts scatter budget"
```

---

### Task 2: Build Deterministic Jitter And Typed Scatter Adapter

**Files:**
- Create: `src/graphCore/jitter.ts`
- Create: `src/graphCore/frameScatter.ts`
- Create: `tests/jitter.test.ts`
- Create: `tests/frameScatter.test.ts`
- Modify: `src/graphCore/transform.ts`
- Modify: `tests/transformAggregatePackets.test.ts`

**Interfaces:**
- Produces: `computeJitterOffsets(points, options, geometry): ReadonlyArray<readonly [number, number]>` in `jitter.ts`.
- Produces: `buildFrameScatterItems(input: FrameScatterInput): FrameScatterGroup[]` in `frameScatter.ts`.
- Consumes: explicit group order, resolved styles, facet selector, jitter policy, X/Y encoding, and pick column supplied by `transform.ts`; `frameScatter.ts` must not import or parse `GraphSpec`.

- [x] **Step 1: Write failing jitter tests**

Cover these exact behaviors in `tests/jitter.test.ts`:

```ts
assert.deepEqual(
  computeJitterOffsets(points, { mode: "normal", limit: 0.5, seed: 7 }, geometry),
  computeJitterOffsets(points, { mode: "normal", limit: 0.5, seed: 7 }, geometry),
);
assert.equal(new Set(stackedOffsets.map(([x]) => x)).size, 3);
assert.ok(eastOffsets.some(([x]) => x !== 0));
assert.ok(westOffsets.some(([x]) => x !== 0));
```

Use three overlapping points per group at the same X/Y. Assert `uniform` and `normal` have a centered distribution with both negative and positive offsets over at least 100 stable row IDs, preventing whole-group translation.

- [x] **Step 2: Write failing adapter tests**

In `tests/frameScatter.test.ts`, build a typed frame with numeric and categorical X, groups East/West, source codes, size values, facet codes, validity masks, and row IDs. Assert:

- one standard scatter group per visible dictionary group;
- each item has `value`, `symbolOffset`, and `__pick`;
- hidden groups are omitted;
- both visible groups receive jitter;
- melted source codes set the correct `__pick.colName`;
- invalid and nonmatching facet rows are omitted;
- the adapter never accepts `GraphData` or `GraphSpec`.

- [x] **Step 3: Run both tests and verify RED**

Run:

```powershell
node --experimental-strip-types tests/jitter.test.ts
node --experimental-strip-types tests/frameScatter.test.ts
```

Expected: FAIL because both modules are missing.

- [x] **Step 4: Implement the pure jitter module**

Use stable row-ID hashing for random modes. `stacked` groups by X key and projected Y bucket, spreads symmetrically, and scales by `limit`. Return offsets only; do not know about ECharts, groups, colors, or frame chunks.

- [x] **Step 5: Implement the mechanical frame adapter**

Define explicit inputs:

```ts
export interface FrameScatterInput {
  frame: GraphDataFrame;
  xType: "continuous" | "nominal" | "datetime";
  yColumn: string;
  groupOrder: readonly string[];
  hiddenGroups: ReadonlySet<string>;
  facet?: FrameFacetSelector;
  jitter: JitterOptions;
  plotGeometry: JitterGeometry;
}

export interface FrameScatterItem {
  value: [number | string, number];
  symbolOffset: readonly [number, number];
  __pick: { rowId: number; colName: string };
  sizeValue?: number;
}
```

Reject row IDs outside JavaScript's safe integer range from pick metadata while retaining the visual point. Group results remain aligned with dictionary codes.

- [x] **Step 6: Wire the adapter into transform semantics**

`transform.ts` resolves group styles, marker shapes, hidden legend state, and options. It converts each `FrameScatterGroup` into the same standard ECharts scatter shape used by the legacy row path:

```ts
{
  type: "scatter",
  name: group.name,
  symbol,
  symbolSize,
  itemStyle,
  progressive: 0,
  data: group.items,
}
```

Do not enable `large`. Keep exact aggregate series unchanged.

- [x] **Step 7: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/jitter.test.ts
node --experimental-strip-types tests/frameScatter.test.ts
node --experimental-strip-types tests/transformAggregatePackets.test.ts
npm run build
```

Expected: all pass.

Commit:

```powershell
git add src/graphCore/jitter.ts src/graphCore/frameScatter.ts src/graphCore/transform.ts tests/jitter.test.ts tests/frameScatter.test.ts tests/transformAggregatePackets.test.ts
git commit -m "feat(graph): render typed points as ECharts scatter"
```

---

### Task 3: Remove The Canvas Point Architecture

**Files:**
- Delete: `src/graphCore/RawPointsLayer.tsx`
- Delete: `src/graphCore/rawPoints.ts`
- Delete: `tests/rawPoints.test.ts`
- Modify: `src/graphCore/Graph.tsx`
- Modify: `src/graphCore/index.ts`
- Modify: `src/graphCore/layers.ts`
- Modify: `src/graphCore/types.ts`
- Modify: `tests/scatterProgressive.test.ts`

**Interfaces:**
- Consumes: frame-backed standard scatter series from Task 2.
- Produces: one ECharts-only `GraphPanel`; point click and brush consume item `__pick` metadata.

- [x] **Step 1: Rewrite the architecture guard first**

Change `tests/scatterProgressive.test.ts` to assert:

```ts
assert.equal(graphSource.includes("RawPointsLayer"), false);
assert.equal(graphSource.includes("./rawPoints"), false);
assert.ok(frameScatterSeries.length > 0);
assert.ok(frameScatterSeries.some(hasPickPayload));
assert.ok(frameScatterSeries.every((series) => series.large !== true));
```

Also assert faceted frame-backed panels each contain only their matching point items.

- [x] **Step 2: Run the guard and verify RED**

Run: `node --experimental-strip-types tests/scatterProgressive.test.ts`

Expected: FAIL because `Graph.tsx` still imports and mounts `RawPointsLayer`.

- [x] **Step 3: Remove Canvas hosting and interaction branches**

Delete `rawPoints` panel props, `rawIndexRef`, Canvas hit testing, brush fallback, zrender Canvas DOM z-index mutation, and `<RawPointsLayer />`. Keep standard ECharts click and brush extraction from `__pick` data items.

- [x] **Step 4: Remove Canvas modules and exports**

Delete both Canvas files and their dedicated tests. Remove `GRAPH_RAW_CANVAS_Z_INDEX` and `applyZrenderCanvasZIndices`, retaining `withInterleavedGraphLayers` for ECharts series zlevels. Remove obsolete `RawPointJitterOptions` and `rawPointJitter*` fields.

- [x] **Step 5: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/frameScatter.test.ts
node --experimental-strip-types tests/transformAggregatePackets.test.ts
npm run build
git diff --check
```

Expected: all pass; repository search finds no production `RawPointsLayer`, `RawPointPanelDescriptor`, or `GRAPH_RAW_CANVAS_Z_INDEX` references.

Commit:

```powershell
git add src/graphCore tests
git commit -m "refactor(graph): remove Canvas point renderer"
```

---

### Task 4: Add Raw-Point Budget And Omission Protocol

**Files:**
- Modify: `src-tauri/src/models/graph_data.rs`
- Modify: `src-tauri/src/services/graph_data_service.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src/types/graphData.ts`
- Modify: `src/services/graphDataTransport.ts`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: exact `SCATTER_RENDER_BUDGET` measured in Task 1.
- Produces request field: `rawPointBudget: number` / Rust `raw_point_budget: usize`.
- Produces completion/frame field `rawPointDisposition`:

```ts
export type GraphRawPointDisposition =
  | { status: "included"; validRows: number; budget: number }
  | { status: "empty"; validRows: 0; budget: number }
  | {
      status: "omitted";
      reason: "pointBudgetExceeded";
      validRows: number;
      budget: number;
    };
```

- [x] **Step 1: Add failing Rust model tests**

Update the camel-case request fixture with `rawPointBudget`. Add serde round-trip assertions for all three disposition variants and reject zero or policy-exceeding budgets in service validation.

- [x] **Step 2: Add failing service tests**

Seed datasets immediately below and above the measured budget. For a Full raw-points request above budget assert:

```rust
assert_eq!(completion.chunks_sent, 0);
assert!(matches!(
    completion.raw_points,
    GraphRawPointDisposition::Omitted {
        reason: GraphRawPointOmissionReason::PointBudgetExceeded,
        ..
    }
));
assert!(!sink.aggregates.is_empty());
```

For under-budget Full and Sample requests, assert chunks are present and status is `Included`. For zero valid observations, assert `Empty`.

- [x] **Step 3: Add failing TypeScript reducer tests**

In `tests/graphDataPipeline.test.ts`, assert omission commits a coherent frame with no raw chunks and exact aggregates, while an `included` completion with inconsistent `chunksSent` still fails.

- [x] **Step 4: Run tests and verify RED**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
Push-Location src-tauri; cargo test graph_data; Pop-Location
```

Expected: FAIL because request/completion disposition fields do not exist.

- [x] **Step 5: Implement contract and validation**

Add matching camelCase Rust/TS types. The backend accepts only `1..=SCATTER_RENDER_BUDGET`; Sample size is also bounded by this policy. Invalid values return `AppError::InvalidParam`.

- [x] **Step 6: Implement omission without raw payloads**

For requests containing an enabled raw 2D points element (`kind == "points"` and `summary_stat == "none"`), buffer raw chunks until the renderable observation count is known. If count exceeds budget:

- stop adding rows to the accumulator but continue the projection/count and cancellation checks;
- clear buffered raw chunks;
- send no raw header/payload messages;
- still send exact aggregate packets;
- return `Omitted` with valid count and budget.

Do not apply this omission policy to 3D-only requests. Under budget, flush buffered chunks in original order.

- [x] **Step 7: Commit reducer state**

`useGraphDataPipeline` copies completion disposition into `GraphDataFrame.rawPointDisposition`. `hasCoherentCompletion` permits zero chunks only for `empty` or `omitted`, never for `included` nonempty frames.

- [x] **Step 8: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
Push-Location src-tauri
cargo fmt --check
cargo test graph_data
cargo clippy
Pop-Location
npm run build
```

Expected: all pass, apart from pre-existing warnings not promoted by the touched target.

Commit exact files only with:

```powershell
git add src-tauri/src/models/graph_data.rs src-tauri/src/services/graph_data_service.rs src-tauri/src/engine/duckdb_engine.rs src/types/graphData.ts src/services/graphDataTransport.ts src/components/graphBuilder/useGraphDataPipeline.ts tests/graphDataPipeline.test.ts
git commit -m "feat(graph): enforce raw point render budget"
```

---

### Task 5: Expose Explicit Sampling And Omission State

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Create: `tests/graphSamplingPolicy.test.ts`

**Interfaces:**
- Consumes: `GraphDataFrame.rawPointDisposition` from Task 4 and `SCATTER_RENDER_BUDGET` from Task 1.
- Produces: explicit Full-over-budget status and a Switch to Sample action using existing `setSamplingMode("sample")`.

- [x] **Step 1: Write failing policy tests**

Extract and test pure helpers:

```ts
assert.equal(clampSampleSize(SCATTER_RENDER_BUDGET + 1), SCATTER_RENDER_BUDGET);
assert.deepEqual(getRawPointNotice({
  status: "omitted",
  reason: "pointBudgetExceeded",
  validRows: 75_000,
  budget: 40_000,
}), { kind: "pointBudgetExceeded", validRows: 75_000, budget: 40_000 });
```

- [x] **Step 2: Run and verify RED**

Run: `node --experimental-strip-types tests/graphSamplingPolicy.test.ts`

Expected: FAIL because helpers do not exist.

- [x] **Step 3: Implement the UI policy**

- Cap Sample input `max` and store updates at `SCATTER_RENDER_BUDGET`.
- Keep Full selected when raw points are omitted; do not silently mutate persisted sampling.
- Render an unframed inline status in the graph workspace with valid count,
  budget, and an icon-plus-text Switch to Sample button.
- Clicking the command switches to Sample with size `min(20_000, SCATTER_RENDER_BUDGET)` and preserves the current seed.
- Aggregate layers remain visible behind the status; do not replace the chart with an empty state.
- Row status must say raw points were omitted, not `Full Data: N rows`.

- [x] **Step 4: Add all four locale strings**

Use equivalent translations for status, valid/budget count, and action. Do not leave English fallback copy in non-English locales.

- [x] **Step 5: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/graphSamplingPolicy.test.ts
npm run build
```

Expected: both pass.

Commit:

```powershell
git add src/components/graphBuilder/GraphBuilderView.tsx src/components/graphBuilder/graphBuilder.css src/i18n/locales/en.json src/i18n/locales/vi.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json tests/graphSamplingPolicy.test.ts
git commit -m "feat(graph): explain point budget sampling"
```

---

### Task 6: Complete Architecture And Desktop Acceptance

**Files:**
- Modify: `tests/transformAggregatePackets.test.ts`
- Modify: `tests/scatterProgressive.test.ts`
- Modify: `docs/superpowers/plans/2026-08-26-unified-echarts-point-rendering.md`

**Interfaces:**
- Consumes: completed single-renderer architecture from Tasks 1-5.
- Produces: executable behavior matrix and checked plan record.

- [x] **Step 1: Complete the rendering matrix**

Assert frame-backed standard ECharts points alone and overlaid with line, bar,
smoother, fit line, histogram, heatmap, and boxplot. Include numeric, date,
categorical, grouped, melted, Group X/Y, and Wrap cases. Every raw point series
must carry pick metadata and must not set `large: true`.

- [x] **Step 2: Run the complete frontend suite**

Run:

```powershell
node --experimental-strip-types tests/jitter.test.ts
node --experimental-strip-types tests/frameScatter.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/transformAggregatePackets.test.ts
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/graphSamplingPolicy.test.ts
node --experimental-strip-types tests/threeD.test.ts
node --experimental-strip-types tests/confidenceBand.test.ts
npm run build
git diff --check
```

Expected: every command exits 0; only existing Vite bundle warnings remain.

- [x] **Step 3: Run backend verification**

Run:

```powershell
Push-Location src-tauri
cargo build
cargo test
cargo clippy
Pop-Location
```

Expected: all exit 0.

- [ ] **Step 4: Cold-start desktop acceptance**

Blocked on 2026-08-26: port 1420 is owned by the active
`issue-45-3d-contour-plot` worktree's Vite/Tauri processes. Automated frontend,
backend, and architecture checks passed; native interaction checks remain manual.

Run: `npm run tauri dev`

Verify manually in the target WebView:

- every legend group jitters in stacked, uniform, and normal modes;
- normal jitter is centered rather than translating a group;
- legend hide/show affects points and overlays identically;
- point tooltip, click, overlap pick, and brush use ECharts behavior;
- points overlay correctly with boxplot, histogram, heatmap, fit line, smoother,
  line, and bar;
- Full under budget renders all points;
- Full over budget retains exact aggregate layers and shows the sampling action;
- Sample renders through the same ECharts scatter path;
- zoom, pan, transpose, Group X/Y, Wrap, and 3D remain functional.

- [x] **Step 5: Final architecture search and commit**

Run:

```powershell
rg "RawPointsLayer|RawPointPanelDescriptor|GRAPH_RAW_CANVAS_Z_INDEX|scatterGL|large:\s*true" src tests
```

Expected: no production raw-point Canvas or alternate-renderer matches; any test
string matches are explicit architecture guards.

Mark completed checkboxes in this plan and commit only verification updates:

```powershell
git add tests/transformAggregatePackets.test.ts tests/scatterProgressive.test.ts docs/superpowers/plans/2026-08-26-unified-echarts-point-rendering.md
git commit -m "test(graph): verify unified point rendering"
```