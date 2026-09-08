# Issue 57 Unified 2D Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent standalone points, box plots, and fit lines from becoming blank after the unified data-pipeline migration while keeping all 2D marks in ECharts and preserving exact backend aggregates.

**Architecture:** Keep DuckDB aggregate packets exact and keep typed chunks as the only raw-data transport. Resolve Full requests that contain raw-derived 2D layers to a deterministic sample capped at `SCATTER_RENDER_BUDGET`, then feed that frame directly into the existing ECharts series builders. Packet-owned box plots remain independent of raw samples.

**Tech Stack:** React 19, TypeScript 5.7, ECharts 5.6, Tauri v2, Rust, DuckDB, Node assertion tests.

## Global Constraints

- Do not reconstruct full `unknown[][]` rows or call the legacy table query path.
- Do not restore `RawPointsLayer`; ECharts remains the only 2D renderer.
- Full-data histogram, heatmap, boxplot, and summary aggregates remain exact.
- Raw-derived ECharts data is capped at `SCATTER_RENDER_BUDGET` with seed `0` unless the user selected an explicit sample.
- Explicit user sampling keeps its configured size and seed after size clamping.
- Rust production code returns `Result<T, AppError>` and uses no `unwrap()` or `expect()`.
- Commit each passing task with a Conventional Commit message; do not push.

---

## File Structure

- Modify `src/components/graphBuilder/graphSamplingPolicy.ts`: own the pure raw-layer classification and effective sampling policy.
- Modify `src/components/graphBuilder/useGraphDataPipeline.ts`: use the policy when creating a graph request.
- Modify `tests/graphSamplingPolicy.test.ts`: prove Full raw-derived requests become bounded deterministic samples while aggregate-only requests remain Full.
- Modify `tests/graphDataPipeline.test.ts`: prove the production request builder uses the effective sample and preserves exact aggregate element requests.
- Modify `tests/transformAggregatePackets.test.ts`: add one issue-level matrix covering standalone points, boxplot, fitline, and points-plus-histogram with production-shaped sampled frames.
- Modify `src-tauri/src/services/graph_data_service.rs` only if the focused integration test proves sampled projection affects aggregate packets; otherwise leave Rust unchanged.

### Task 1: Define Effective Raw-Layer Sampling

**Files:**
- Modify: `src/components/graphBuilder/graphSamplingPolicy.ts`
- Test: `tests/graphSamplingPolicy.test.ts`

**Interfaces:**
- Consumes: `GraphSampling`, `GraphElementRequest`, and `SCATTER_RENDER_BUDGET`.
- Produces: `requiresRawGraphFrame(elements: readonly GraphElementRequest[]): boolean`.
- Produces: `resolveEffectiveGraphSampling(configured: GraphSampling | undefined, elements: readonly GraphElementRequest[]): GraphSampling`.

- [ ] **Step 1: Write failing policy tests**

Extend `tests/graphSamplingPolicy.test.ts` with these cases:

```ts
import {
  requiresRawGraphFrame,
  resolveEffectiveGraphSampling,
} from "../src/components/graphBuilder/graphSamplingPolicy.ts";

const rawCases = [
  [{ kind: "points", summaryStat: "none" }],
  [{ kind: "line", summaryStat: "none" }],
  [{ kind: "bar", summaryStat: "none" }],
  [{ kind: "smoother", summaryStat: "none" }],
  [{ kind: "fitline", summaryStat: "none" }],
];
for (const elements of rawCases) {
  assert.equal(requiresRawGraphFrame(elements), true);
  assert.deepEqual(resolveEffectiveGraphSampling({ mode: "full" }, elements), {
    mode: "sample",
    size: SCATTER_RENDER_BUDGET,
    seed: 0,
  });
}

const aggregateOnly = [
  { kind: "histogram", summaryStat: "none" },
  { kind: "boxplot", summaryStat: "none" },
  { kind: "points", summaryStat: "mean" },
];
assert.equal(requiresRawGraphFrame(aggregateOnly), false);
assert.deepEqual(
  resolveEffectiveGraphSampling({ mode: "full" }, aggregateOnly),
  { mode: "full" },
);
assert.deepEqual(
  resolveEffectiveGraphSampling(
    { mode: "sample", size: SCATTER_RENDER_BUDGET + 1, seed: 17 },
    rawCases[0],
  ),
  { mode: "sample", size: SCATTER_RENDER_BUDGET, seed: 17 },
);
```

- [ ] **Step 2: Run the policy test and verify RED**

Run: `node --experimental-strip-types tests/graphSamplingPolicy.test.ts`

Expected: FAIL because `requiresRawGraphFrame` and `resolveEffectiveGraphSampling` are not exported.

- [ ] **Step 3: Implement the minimal pure policy**

In `graphSamplingPolicy.ts`, classify raw consumers without inspecting UI state:

```ts
import type {
  GraphElementRequest,
  GraphSampling,
} from "../../types/graphData.ts";

export function requiresRawGraphFrame(
  elements: readonly GraphElementRequest[],
): boolean {
  return elements.some((element) => {
    const kind = element.kind.toLowerCase();
    if (kind === "points" || kind === "line") {
      return element.summaryStat.toLowerCase() === "none";
    }
    return kind === "bar" || kind === "smoother" || kind === "fitline";
  });
}

export function resolveEffectiveGraphSampling(
  configured: GraphSampling | undefined,
  elements: readonly GraphElementRequest[],
): GraphSampling {
  if (configured?.mode === "sample") {
    return {
      mode: "sample",
      size: clampSampleSize(configured.size),
      seed: Math.max(0, Math.trunc(configured.seed) || 0),
    };
  }
  if (requiresRawGraphFrame(elements)) {
    return { mode: "sample", size: SCATTER_RENDER_BUDGET, seed: 0 };
  }
  return { mode: "full" };
}
```

- [ ] **Step 4: Run the policy test and verify GREEN**

Run: `node --experimental-strip-types tests/graphSamplingPolicy.test.ts`

Expected: PASS with `graph sampling policy tests passed`.

- [ ] **Step 5: Commit the policy**

```powershell
git add src/components/graphBuilder/graphSamplingPolicy.ts tests/graphSamplingPolicy.test.ts
git commit -m "fix(graph): bound raw layer sampling"
```

### Task 2: Wire Effective Sampling Into Production Requests

**Files:**
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Test: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveGraphSampling(configured, elements)` from Task 1.
- Produces: exported `deriveGraphRequestParts(item: GraphBuilderItem)` returning `{ fields, filters, elements, sampling }` for the hook and tests.

- [ ] **Step 1: Write a failing production-request test**

Add a test that builds realistic Graph Builder items and calls the exported request helper:

```ts
const rawItem = makeGraphBuilderItem({
  elements: [
    { kind: "points", enabled: true, options: { summaryStat: "none" } },
    { kind: "fitline", enabled: true, options: { degree: 1 } },
  ],
  sampling: { mode: "full" },
});
const rawParts = deriveGraphRequestParts(rawItem);
assert.deepEqual(rawParts.sampling, {
  mode: "sample",
  size: SCATTER_RENDER_BUDGET,
  seed: 0,
});
assert.deepEqual(rawParts.elements.map((element) => element.kind), ["points", "fitline"]);

const boxItem = makeGraphBuilderItem({
  elements: [{ kind: "boxplot", enabled: true }],
  sampling: { mode: "full" },
});
assert.deepEqual(deriveGraphRequestParts(boxItem).sampling, { mode: "full" });
```

- [ ] **Step 2: Run the pipeline test and verify RED**

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: FAIL because `deriveGraphRequestParts` is not exported or Full raw requests remain Full.

- [ ] **Step 3: Implement and use the request helper**

Replace the private sampling assembly with one pure helper:

```ts
export function deriveGraphRequestParts(item: GraphBuilderItem) {
  const elements = deriveElements(item);
  return {
    fields: deriveFields(item),
    filters: serializeFilters(item.filters ?? []),
    elements,
    sampling: resolveEffectiveGraphSampling(item.sampling, elements),
  };
}
```

In `useGraphDataPipeline`, construct `requestSkeleton` from
`deriveGraphRequestParts(item)` and append `datasetId` plus the debounced
viewport. Keep `rawPointBudget: SCATTER_RENDER_BUDGET` on the final request.

- [ ] **Step 4: Run focused pipeline and transport tests**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/graphSamplingPolicy.test.ts
```

Expected: both PASS. The raw request uses Sample; the boxplot-only request uses Full.

- [ ] **Step 5: Build the frontend**

Run: `npx vite build`

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 6: Commit production wiring**

```powershell
git add src/components/graphBuilder/useGraphDataPipeline.ts tests/graphDataPipeline.test.ts
git commit -m "fix(graph): sample raw ECharts requests"
```

### Task 3: Lock Issue 57 Rendering And Aggregate Contracts

**Files:**
- Modify: `tests/transformAggregatePackets.test.ts`
- Test: `tests/transformAggregatePackets.test.ts`
- Test: `src-tauri/src/services/graph_data_service.rs`

**Interfaces:**
- Consumes: production-shaped sampled `GraphDataFrame` objects and exact `BoxPlotPacket`/`HistogramPacket` aggregates.
- Produces: one regression matrix demonstrating every issue 57 layer remains renderable without legacy rows.

- [ ] **Step 1: Add the issue-level regression matrix**

Create a sampled frame fixture with six typed X/Y points and assert:

```ts
const issueFrame = {
  ...typedNumericFrame(),
  sampling: { mode: "sample", size: 6, seed: 0 } as const,
};

for (const element of [
  { kind: "points", enabled: true, options: { summaryStat: "none" } },
  { kind: "fitline", enabled: true, options: { degree: 1 } },
] satisfies GraphSpec["elements"]) {
  const panel = buildGraph(
    {
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      elements: [element],
    },
    frameBackedAggregateData(["x", "y"], 6),
    theme,
    undefined,
    issueFrame,
  ).panels[0];
  assert.ok(panelSeries(panel.option as Record<string, unknown>)
    .some((series) => Array.isArray(series.data) && series.data.length > 0));
}
```

Add packet-backed cases using the existing packet fixtures:

- standalone boxplot emits `type: "boxplot"` without points or histogram;
- points plus histogram emits both non-empty ECharts scatter and histogram series;
- a point STYLE override produces the requested symbol, size, color, and opacity.

Use `frameBackedAggregateData(...)` so any accidental legacy-row read throws.

- [ ] **Step 2: Run the transform regression**

Run: `node --experimental-strip-types tests/transformAggregatePackets.test.ts`

Expected: PASS. If a newly added case fails, make the smallest local correction
in `transform.ts`, then rerun this same command before any broader edit.

- [ ] **Step 3: Verify sampled raw rows and exact aggregates in Rust**

Run from `src-tauri/`:

```powershell
cargo test graph_data::tests::aggregate::sampled_raw_rows_keep_minority_groups_with_same_seed --lib
cargo test graph_data::tests::aggregate::boxplot_packet_matches_direct_sql_quantiles_whiskers_and_outlier_ids --lib
```

Expected: both PASS. Sampling is deterministic and boxplot statistics still match direct full-data SQL.

- [ ] **Step 4: Run the graph regression suite and build**

Run from the repository root:

```powershell
node --experimental-strip-types tests/graphSamplingPolicy.test.ts
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/transformAggregatePackets.test.ts
npx vite build
```

Expected: every command exits `0`; Vite reports a successful production build.

- [ ] **Step 5: Manually verify the issue reproductions**

Run `cargo tauri dev` and verify with a dataset larger than
`SCATTER_RENDER_BUDGET`:

1. standalone points are visible and respond to STYLE marker, color, size, and opacity;
2. standalone boxplot is visible without histogram;
3. standalone fitline is visible;
4. points plus histogram shows both layers;
5. status reports sampled raw rendering rather than omitted points.

- [ ] **Step 6: Commit regression coverage or the local transform correction**

```powershell
git add tests/transformAggregatePackets.test.ts src/graphCore/transform.ts
git commit -m "test(graph): cover issue 57 rendering paths"
```

Omit `src/graphCore/transform.ts` from `git add` when no production correction was required.