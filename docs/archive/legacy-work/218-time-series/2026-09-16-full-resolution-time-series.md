# Full-Resolution Time Series Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Graph Builder Time Series element that accepts explicit temporal or sequence X semantics and renders every filtered observation in deterministic order without sampling.

**Architecture:** Keep Time Series inside the existing 2D Graph Builder shell while giving it a dedicated persisted X interpretation and a typed full-resolution frame adapter. DuckDB validates and converts temporal X values to epoch milliseconds, orders rows by `(X, _row_id)`, and streams every row; graphCore renders the committed frame with ordinary ECharts line series unless the target Windows benchmark rejects that adapter.

**Tech Stack:** Tauri v2, Rust 2021, DuckDB, serde, React 19, TypeScript, Zustand, ECharts 5.6 Canvas, i18next, Playwright Component Testing.

**Spec:** [Full-Resolution Time Series Design](../specs/2026-09-16-full-resolution-time-series-design.md), [GitHub Issue 218 investigation](https://github.com/ashton2914/StatsPlayground/issues/218#issuecomment-5691496940), and [ADO Task 1120770](https://1es4devices.visualstudio.com/MechanicalEngineering/_workitems/edit/1120770)

## Global Constraints

- Execute on an isolated `feat/218-full-resolution-time-series` worktree created from the user-confirmed latest remote base; never commit directly to `dev`.
- Confirm the base and pull-request target with Ashton before creating the worktree, as required by the repository Issue lifecycle.
- Time Series is a specialized 2D element. Generic Graph Builder X eligibility and generic Points/Line behavior must remain unchanged.
- Full-resolution Time Series never samples, downsamples, aggregates, deduplicates, or silently drops an invalid X value.
- The existing 8,000-point scatter budget remains unchanged for generic elements.
- Text dates use only the six persisted allowlist IDs in the design. Never guess locale and never concatenate a user-provided format into SQL.
- Version 1 uses UTC temporal transport and display. Standalone DuckDB `TIME` is not a valid Time Series X.
- Time Series is mutually exclusive with raw Points, generic Line, Smoother, Fit Line, Bar, and Histogram; reference lines and bands remain compatible.
- Follow strict TDD: run every new behavior test and observe the expected RED result before changing production code.
- Do not stage or commit before manual acceptance. Record bounded status/diff checkpoints after each task, then create one conventional commit after acceptance.
- If the target Windows ECharts benchmark misses any required threshold, stop before release acceptance and write a dedicated-renderer replacement plan; do not weaken the thresholds or enable sampling.

## File Structure

### Create

- `src/components/graphBuilder/timeSeriesContract.ts` - persisted options, X eligibility, format allowlist, and element compatibility.
- `src/graphCore/frameTimeSeries.ts` - typed-frame decoder, ordered line data, and parallel source-row index.
- `src-tauri/src/services/time_series.rs` - Time Series validation and closed text-format-to-DuckDB mapping.
- `tests/timeSeriesContract.test.ts` - mode-scoped X eligibility and compatibility.
- `tests/frameTimeSeries.test.ts` - full-resolution, duplicate-X, series identity, and missing-gap behavior.
- `tests/TimeSeriesGraphHarness.tsx` and `tests/timeSeriesGraph.spec.tsx` - configuration and status component tests.
- `src/benchmarks/TimeSeriesBenchmark.tsx` - target-WebView line-series scenarios.
- `scripts/runTimeSeriesBenchmark.mjs`, `scripts/timeSeriesBenchmarkCore.mjs`, and `scripts/timeSeriesBenchmarkCore.test.mjs` - runner and threshold policy.
- `docs/performance/time-series-renderer-YYYY-MM-DD.md` - dated Windows measurement report; use the actual run date.

### Modify

- Graph contracts/state: `src/graphCore/types.ts`, `src/types/graphBuilder.ts`, `src/types/graphData.ts`.
- Graph Builder: `graphLayerConfig.ts`, `graphBuilderMode.ts`, `graphSamplingPolicy.ts`, `useGraphDataPipeline.ts`, `graphRuntimeModel.ts`, `GraphBuilderView.tsx`, and `GraphRuntime.tsx` under `src/components/graphBuilder/`.
- Rendering: `src/graphCore/transform.ts` and `src/graphCore/Graph.tsx`.
- Backend: `src-tauri/src/models/graph_data.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/services/graph_data_service.rs`, `src-tauri/src/engine/duckdb_engine.rs`, and `src-tauri/src/perf_harness.rs`.
- Localization: all four files under `src/i18n/locales/`.
- Tests: focused Graph Builder, graph-data, graphCore, and project round-trip suites named in each task.

---

### Task 1: Mode-Scoped Time Series Contract

**Files:**
- Create: `src/components/graphBuilder/timeSeriesContract.ts`
- Create: `tests/timeSeriesContract.test.ts`
- Modify: `src/graphCore/types.ts`
- Modify: `src/types/graphBuilder.ts`
- Modify: `src/components/graphBuilder/graphLayerConfig.ts`
- Modify: `src/components/graphBuilder/graphBuilderMode.ts`
- Test: `tests/graphBuilderMode.test.ts`

**Interfaces:** Consume existing `FieldRef`, `ChartElement`, `ElementKind`, and persisted 2D element arrays. Produce `TimeSeriesOptions`, `TimeSeriesXInterpretation`, `TimeSeriesTextDateFormat`, `validateTimeSeriesX(...)`, and `reconcileTimeSeriesElements(...)`.

- [ ] **Step 1: Write failing pure contract tests**

Cover native date/timestamp acceptance, standalone time rejection, explicit US
text parsing for the screenshot case, explicit numeric sequence, and no changes
to generic drop behavior:

```ts
assert.deepEqual(
  validateTimeSeriesX(
    { name: "数据日期", type: "datetime" },
    "DATE",
    { kind: "nativeTemporal" },
  ),
  { valid: true, temporalKind: "date" },
);
assert.equal(validateTimeSeriesX(
  { name: "数据日期", type: "nominal" },
  "VARCHAR",
  { kind: "textDate", format: "usDate" },
).valid, true);
assert.equal(validateTimeSeriesX(
  { name: "clock", type: "datetime" },
  "TIME",
  { kind: "nativeTemporal" },
).valid, false);
assert.equal(validateTimeSeriesX(
  { name: "sequence", type: "continuous" },
  "BIGINT",
  { kind: "sequence" },
).valid, true);
```

Also assert that reconciliation removes incompatible raw layers but retains
reference lines/bands. Extend normalization coverage so missing Time Series
options receive documented defaults without converting an old Line graph.

- [ ] **Step 2: Run tests and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/timeSeriesContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderMode.test.ts
```

Expected: module/type failures and missing Time Series normalization.

- [ ] **Step 3: Add the minimal TypeScript contract**

```ts
export interface TimeSeriesOptions {
  xInterpretation: TimeSeriesXInterpretation;
  order: "timeAscending" | "sourceRow";
  missingValues: "break" | "connect";
  connection: "line" | "step";
  markerMode: "auto" | "show" | "hide";
}

export const DEFAULT_TIME_SERIES_OPTIONS: TimeSeriesOptions = {
  xInterpretation: { kind: "nativeTemporal" },
  order: "timeAscending",
  missingValues: "break",
  connection: "line",
  markerMode: "auto",
};
```

Add `timeSeries` to `ElementKind`, register it in `GRAPH_LAYER_DEFS`, and keep
its validation in `timeSeriesContract.ts`. Do not modify `inferFieldType()` or
generic `graphBuilderDropRouting.ts` behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
npx tsx --tsconfig tsconfig.app.json tests/timeSeriesContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderMode.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphBuilderDropRouting.test.ts
```

Expected: all pass and generic drop-routing assertions remain unchanged.

- [ ] **Step 5: Record an uncommitted checkpoint**

```bash
git --no-pager status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat -- src/graphCore/types.ts src/types/graphBuilder.ts src/components/graphBuilder tests/timeSeriesContract.test.ts tests/graphBuilderMode.test.ts
```

Expected: only Task 1 paths plus pre-existing user paths appear.

---

### Task 2: Typed Request And Validated DuckDB Temporal Projection

**Files:**
- Create: `src-tauri/src/services/time_series.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/models/graph_data.rs`
- Modify: `src/types/graphData.ts`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Test: focused unit modules in the new service and engine.

**Interfaces:** Consume persisted Time Series options, field bindings, validated dataset SQL types, and graph query-plan compilation. Produce optional `GraphElementRequest.timeSeries`, Rust `TimeSeriesRequest`, static `text_date_pattern(format)`, and canonical ordered X projection.

- [ ] **Step 1: Add failing Rust validation and SQL-plan tests**

```rust
assert_eq!(text_date_pattern(TimeSeriesTextDateFormat::UsDate), "%m/%d/%Y");
assert!(validate_time_series_x("DATE", &TimeSeriesXInterpretation::NativeTemporal).is_ok());
assert!(validate_time_series_x("TIME", &TimeSeriesXInterpretation::NativeTemporal).is_err());
assert!(validate_time_series_x("VARCHAR", &TimeSeriesXInterpretation::TextDate {
    format: TimeSeriesTextDateFormat::UsDate,
}).is_ok());
assert!(validate_time_series_x("BIGINT", &TimeSeriesXInterpretation::Sequence).is_ok());
```

Engine tests must prove native DATE and `usDate` compile numeric `__sp_x`,
`timeAscending` ends with `ORDER BY "__sp_x" ASC NULLS LAST, "_row_id" ASC`,
and `sourceRow` retains `_row_id` ordering. Assert generated SQL contains only a
static pattern selected by the enum.

- [ ] **Step 2: Run focused Rust tests and verify RED**

From `src-tauri/`:

```bash
cargo test time_series --lib
cargo test graph_projection_time_series --lib
```

Expected: compilation fails because request enums, service, and query-plan
branch do not exist.

- [ ] **Step 3: Mirror the request contract in TypeScript and Rust**

```ts
export interface GraphTimeSeriesRequest {
  xInterpretation: TimeSeriesXInterpretation;
  order: "timeAscending" | "sourceRow";
  missingValues: "break" | "connect";
  markerMode: "auto" | "show" | "hide";
  connection: "line" | "step";
}
```

Add optional `timeSeries` to `GraphElementRequest`, use camelCase serde and
closed Rust enums, and have `deriveElements()` copy options only for
`kind === "timeSeries"`.

- [ ] **Step 4: Implement validated static temporal SQL**

Keep the format map in `time_series.rs`. The engine selects an expression from
validated SQL type and enum; it never interpolates a caller-supplied pattern.
Native/parsed temporal values become epoch milliseconds while sequence stays
numeric. Use the repository identifier-quoting helper and preserve parameterized
filters and generation/cancellation behavior.

- [ ] **Step 5: Run focused tests and format touched Rust files**

```bash
cd src-tauri && cargo test time_series --lib
cd src-tauri && cargo test graph_projection_time_series --lib
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
cd src-tauri && rustfmt --edition 2021 src/models/graph_data.rs src/services/time_series.rs src/services/mod.rs src/engine/duckdb_engine.rs
cd src-tauri && cargo test time_series --lib && cargo test graph_projection_time_series --lib
```

Expected: validation, static mapping, deterministic order, request serialization,
and existing graph request fixtures pass after formatting.

---

### Task 3: Full-Resolution Temporal Stream And Coherent Failure

**Files:**
- Modify: `src-tauri/src/models/graph_data.rs`
- Modify: `src-tauri/src/services/graph_data_service.rs`
- Modify: `src/types/graphData.ts`
- Modify: `src/components/graphBuilder/graphSamplingPolicy.ts`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Test: `tests/graphSamplingPolicy.test.ts`, `tests/graphDataPipeline.test.ts`, and focused Rust stream tests.

**Interfaces:** Consume Task 2's validated temporal projection. Produce `GraphAxisEncoding::Temporal`, `GraphTemporalAxisMetadata`, `GraphTimeSeriesDisposition`, unlimited Full Time Series chunks, and pending-frame rejection for invalid X.

- [ ] **Step 1: Write failing backend full-resolution tests**

Create a 10,001-row dataset to cross the scatter cap and assert all rows are
processed and decoded. Assert duplicate-timestamp row IDs are ascending,
temporal X uses f64 epoch milliseconds, and one wrong `usDate` value produces
`invalidTimeSeriesX` with an exact count and no terminal commit.

- [ ] **Step 2: Write failing frontend policy/coherence tests**

Assert Full Time Series remains Full while generic raw Line still resolves to
the 8,000-row sample. Feed temporal chunks followed by an
`invalidTimeSeriesX` completion and assert the previous committed frame remains
while pending chunks are discarded.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd src-tauri && cargo test time_series_full_resolution --lib
npx tsx --tsconfig tsconfig.app.json tests/graphSamplingPolicy.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
```

Expected: Time Series still shares generic raw handling and tests fail.

- [ ] **Step 4: Add temporal chunk metadata and disposition**

```ts
export type GraphAxisEncoding = "numeric" | "categorical" | "temporal";

export interface GraphTemporalAxisMetadata {
  unit: "epochMilliseconds";
  kind: "date" | "timestamp" | "timestampTz";
  displayZone: "utc";
}

export type GraphTimeSeriesDisposition =
  | { status: "included"; includedRows: number; invalidXRows: 0 }
  | { status: "invalidTimeSeriesX"; includedRows: number; invalidXRows: number };
```

Mirror in Rust. Put optional temporal metadata on chunk headers and optional
disposition on completion. Decode Temporal X through the aligned f64 descriptor,
not a category dictionary.

- [ ] **Step 5: Stream every Time Series row without the scatter budget**

Identify Time Series only from a validated element request, require Full mode,
skip ordinary raw-point omission, preserve Y validity bits, and count invalid X.
If invalid X exists, return the structured result so the frontend never commits
the pending frame. Never retry or derive a Sample request.

- [ ] **Step 6: Run focused and containing tests**

```bash
cd src-tauri && cargo test time_series_full_resolution --lib
cd src-tauri && cargo test services::graph_data_service::tests --lib
npx tsx --tsconfig tsconfig.app.json tests/graphSamplingPolicy.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
```

Expected: all pass, including 10,001 included rows, prior-frame retention, and
existing generic points omission/sample behavior.

---

### Task 4: Frame Adapter And ECharts Time Series Rendering

**Files:**
- Create: `src/graphCore/frameTimeSeries.ts`
- Create: `tests/frameTimeSeries.test.ts`
- Modify: `src/graphCore/transform.ts`
- Modify: `src/graphCore/Graph.tsx`
- Test: `tests/transformAggregatePackets.test.ts`

**Interfaces:** Consume committed Temporal GraphDataFrame chunks, validity bits, row IDs, group/source roles, and Time Series options. Produce `buildFrameTimeSeries(...)`, ECharts line series with every vertex, and `pickBySeriesDataIndex(...)`.

- [ ] **Step 1: Write failing adapter tests with exact identity**

Use two chunks and duplicate X values. Assert no reduction, stable order, and
parallel row IDs:

```ts
assert.deepEqual(result.series[0].data, [
  [1_722_038_400_000, 4.1],
  [1_722_038_400_000, 4.2],
  [1_722_124_800_000, null],
  [1_722_211_200_000, 4.3],
]);
assert.deepEqual(result.series[0].rowIds, [11n, 12n, 13n, 14n]);
```

Cover `break` retaining null, `connect` omitting it, and source-column/group
identity creating distinct series.

- [ ] **Step 2: Run adapter tests and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/frameTimeSeries.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the single-pass adapter**

Decode Temporal X directly from f64 buffers. Preserve valid X, map invalid Y to
null for `break`, and append each item to a stable series bucket. Return tuple
arrays plus parallel `bigint[]` row IDs; do not allocate per-observation pick
objects.

- [ ] **Step 4: Add failing final-option assertions**

Assert `xAxis.type === "time"`, UTC mode, ordinary line series,
`sampling === "none"`, disabled animation/emphasis, exact full count,
line/step modes, three marker modes, and row lookup by series/data index.

- [ ] **Step 5: Run final-option tests and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/transformAggregatePackets.test.ts
```

Expected: Time Series options and pick index are absent.

- [ ] **Step 6: Wire the adapter into graphCore**

Keep `transform.ts` as semantic owner and call the adapter only for Time Series.
Use ordinary ECharts `series-line`; do not use `series-lines.large`, ECharts
sampling, or generic scatter. Resolve Graph click/cursor events through the
parallel row-ID index.

- [ ] **Step 7: Run rendering tests and verify GREEN**

```bash
npx tsx --tsconfig tsconfig.app.json tests/frameTimeSeries.test.ts
npx tsx --tsconfig tsconfig.app.json tests/transformAggregatePackets.test.ts
```

Expected: exact arrays, duplicate order, null gaps, UTC axis, all vertices, and
row identity pass.

---

### Task 5: Graph Builder UX, Persistence, And Localized Errors

**Files:**
- Create: `tests/TimeSeriesGraphHarness.tsx`
- Create: `tests/timeSeriesGraph.spec.tsx`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/GraphRuntime.tsx`
- Modify: `src/components/graphBuilder/graphRuntimeModel.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: `tests/graphRuntime.test.ts`
- Test: `tests/graphProjectRoundTrip.test.ts`

**Interfaces:** Consume Tasks 1-4 contract, validation, stream disposition, adapter, and existing layer editor/persistence. Produce layer selection, X interpretation/format/order/missing/marker controls, full-resolution status, and four-locale messages.

- [ ] **Step 1: Write failing component tests**

Mount the production Graph Builder with native DATE, screenshot-like VARCHAR,
numeric, and TIME columns. Assert:

- selecting Time Series removes incompatible raw layers;
- DATE X runs with `nativeTemporal`;
- VARCHAR X blocks until `US date (M/D/YYYY)` is selected;
- numeric X blocks until `Sequence / elapsed value` is selected;
- standalone TIME remains blocked;
- Sample is absent while `Full resolution` and the included count are visible;
- invalid X status includes its exact row count;
- marker, missing, connection, and order controls update persisted state.

- [ ] **Step 2: Run the component test and verify RED**

```bash
npx playwright test -c playwright-ct.config.ts tests/timeSeriesGraph.spec.tsx
```

Expected: Time Series layer and controls are absent.

- [ ] **Step 3: Preserve datetime metadata in GraphRuntime**

Change local metadata mapping so datetime remains datetime-capable for runtime
validation instead of collapsing to nominal. Do not broaden generic
`ColumnMeta.role`; exact SQL type and `FieldRef.type` remain the Time Series
authority.

- [ ] **Step 4: Implement the option editor and execution guard**

Add the first-class layer, segmented X Interpretation control, six allowlisted
format options, time/source ordering, break/connect, line/step, and marker mode.
Disable execution with one actionable localized error when X validation fails.
Suppress sampling controls only while Time Series is active.

- [ ] **Step 5: Add all four locale entries and parity assertions**

Add the same key set under `graph.timeSeries` in `en`, `zh-CN`, `zh-TW`, and
`vi`. Extend the existing locale-parity test to compare key paths.

- [ ] **Step 6: Add round-trip and runtime assertions**

Persist and reopen this representative configuration exactly:

```ts
{
  kind: "timeSeries",
  enabled: true,
  options: {
    xInterpretation: { kind: "textDate", format: "usDate" },
    order: "timeAscending",
    missingValues: "break",
    connection: "line",
    markerMode: "auto",
  },
}
```

Assert `buildGraphRuntimeModel` emits temporal X and Time Series semantics
without changing existing graph fixtures.

- [ ] **Step 7: Run focused UI/runtime/persistence tests and verify GREEN**

```bash
npx playwright test -c playwright-ct.config.ts tests/timeSeriesGraph.spec.tsx
npx tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphProjectRoundTrip.test.ts
```

Expected: all pass, including an unchanged generic Graph Builder control case.

---

### Task 6: Target-WebView Renderer Qualification

**Files:**
- Create: `src/benchmarks/TimeSeriesBenchmark.tsx`
- Create: `scripts/runTimeSeriesBenchmark.mjs`
- Create: `scripts/timeSeriesBenchmarkCore.mjs`
- Create: `scripts/timeSeriesBenchmarkCore.test.mjs`
- Create: `docs/performance/time-series-renderer-YYYY-MM-DD.md`
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `package.json`

**Interfaces:** Consume the production Task 4 adapter/option path and Task 3 full-resolution stream. Produce `benchmark:time-series`, raw samples, a dated report, and an exact renderer pass/fail decision.

- [ ] **Step 1: Write failing pure threshold-policy tests**

```js
assert.equal(evaluateTimeSeriesCandidate({
  coherentFrameMs: 1_900,
  longestTaskMs: 190,
  zoomP95Ms: 95,
  cursorP95Ms: 45,
  peakHeapMb: 500,
}).passed, true);

assert.deepEqual(evaluateTimeSeriesCandidate({
  coherentFrameMs: 2_001,
  longestTaskMs: 190,
  zoomP95Ms: 95,
  cursorP95Ms: 45,
  peakHeapMb: 500,
}).failedMetrics, ["coherentFrameMs"]);
```

- [ ] **Step 2: Run the policy test and verify RED**

```bash
node --test scripts/timeSeriesBenchmarkCore.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement policy and production-path scenarios**

Encode exact thresholds from the design. Generate deterministic 8k, 50k,
100k, and 300k total-observation fixtures with one/four series, duplicate X,
1% missing Y, and marker `auto/show`. The harness must call the production Time
Series option factory, not a benchmark-only renderer.

- [ ] **Step 4: Run the pure policy test and verify GREEN**

```bash
node --test scripts/timeSeriesBenchmarkCore.test.mjs
```

Expected: pass and identify each failed metric independently.

- [ ] **Step 5: Add backend temporal transfer measurements**

Extend `perf_harness.rs` with native temporal input and report source rows,
processed rows, chunks, bytes, query time, encode time, projection passes, and
invalid X count. Assert the 300k scenario transfers exactly 300k observations.

- [ ] **Step 6: Run the benchmark on the target Windows WebView**

```powershell
npm run benchmark:time-series
```

Expected: the runner writes dated raw JSON and Markdown, covers every scenario,
and exits 0 only when the 300k default-marker case passes every design threshold.

- [ ] **Step 7: Apply the hard renderer gate**

On exit 0, record `Renderer decision: ECharts Canvas series-line` and continue.
On nonzero, record every failed metric and stop before release acceptance.
Create a replacement-adapter plan for a dedicated high-density renderer while
preserving Tasks 1-3 contracts; never enable sampling as fallback.

---

### Task 7: Full Verification And Manual Acceptance

**Files:**
- Verify: every implementation and test path above.
- Update after checks pass: GitHub Issue 218 and ADO Task 1120770 Discussion with implementation and benchmark evidence.

**Interfaces:** Consume a passing Task 6 renderer decision and all focused suites. Produce repository-wide evidence, a manual acceptance build, one accepted commit, and pull-request-ready state.

- [ ] **Step 1: Run the combined frontend gate**

```bash
npx tsx --tsconfig tsconfig.app.json tests/timeSeriesContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphSamplingPolicy.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphDataPipeline.test.ts
npx tsx --tsconfig tsconfig.app.json tests/frameTimeSeries.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/transformAggregatePackets.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphProjectRoundTrip.test.ts
npx playwright test -c playwright-ct.config.ts tests/timeSeriesGraph.spec.tsx
node --test scripts/timeSeriesBenchmarkCore.test.mjs
```

Expected: every command exits 0 with no failed tests.

- [ ] **Step 2: Run backend verification**

From `src-tauri/`:

```bash
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cargo build
```

Expected: all commands exit 0 with no failures or warnings.

- [ ] **Step 3: Run production build and repository checks**

```bash
npm run build
git --no-pager diff --no-ext-diff --check
git --no-pager status --short --untracked-files=all
```

Expected: build and diff check pass; status contains only intended Issue 218
files plus explicitly preserved pre-existing paths.

- [ ] **Step 4: Obtain independent AI review**

Provide Issue 218, approved spec, base SHA, complete status, and bounded source
diff. Require review of full-resolution semantics, temporal SQL safety, UTC/date
behavior, pending-frame coherence, generic Graph Builder regressions, and
benchmark integrity. Fix every Critical or Important finding with a fresh
RED/GREEN cycle and repeat affected verification.

- [ ] **Step 5: Start the exact acceptance build**

Launch the feature worktree with its bound npm path and verify process,
frontend source, executable, and port. Ask Ashton to exercise:

1. native DATE/TIMESTAMP X;
2. screenshot-like `7/27/2026` text with US Date selected;
3. an intentionally wrong text format and retained prior graph;
4. duplicate timestamps and deterministic order;
5. missing Y in Break and Connect modes;
6. numeric Sequence mode;
7. more than 8,000 and the 300k fixture with Full resolution status;
8. save, close, reopen, and compare configuration;
9. one generic Points/Line graph to confirm its 8k policy is unchanged.

- [ ] **Step 6: Stop at the manual acceptance gate**

Do not stage, commit, push, or create a pull request until Ashton explicitly
confirms the checklist passes.

- [ ] **Step 7: After acceptance, verify again and create one commit**

Re-run Steps 1-3 on the exact accepted tree, stage only Issue 218 files, inspect
the staged diff, and commit:

```bash
git commit -m "feat(graph): add full-resolution time series"
```

- [ ] **Step 8: Create the pull request through the Issue lifecycle**

Push without force, create the PR to the user-confirmed target, bind its exact
head SHA, include benchmark/manual-acceptance evidence and cleanup metadata,
and stop without merging.

## Plan Self-Review

- Spec coverage: temporal/text/sequence X, no guessing, deterministic order,
  duplicate X, missing values, no sampling, coherent errors, persistence,
  renderer qualification, review, and manual acceptance map to explicit tasks.
- Type consistency: `TimeSeriesXInterpretation`, `TimeSeriesTextDateFormat`,
  `GraphTimeSeriesRequest`, `GraphTemporalAxisMetadata`, and
  `GraphTimeSeriesDisposition` use the same names across TypeScript, Rust, and
  tests.
- Scope: generic Graph Builder X semantics stay unchanged; a second renderer is
  deferred unless measured evidence requires it.
- Execution gate: implementation starts only after base/target confirmation and
  isolated-worktree creation; commit and PR stay behind manual acceptance.
