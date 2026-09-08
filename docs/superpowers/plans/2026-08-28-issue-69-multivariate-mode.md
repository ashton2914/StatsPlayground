# Multivariate Graph Builder Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent 2D, 3D, and Multivariate Graph Builder modes, moving Correlation Matrix into a dedicated multiple-variable workflow.

**Architecture:** Replace the persisted flat visualization fields with an explicit active mode and three nested mode states, normalized through one pure compatibility boundary. The data pipeline and view consume only the active state; Multivariate columns reuse the existing correlation request and backend packet contract.

**Tech Stack:** React 19, TypeScript, Zustand, ECharts 6, standalone Node TypeScript tests, Vite

**Spec:** `docs/superpowers/specs/2026-08-28-issue-69-multivariate-mode-design.md`

## Global Constraints

- Regression analysis and regression-specific plots are out of scope.
- Keep the Rust correlation request, computation, and packet contract unchanged.
- Correlation Matrix accepts 2 to 20 unique continuous columns and defaults to Pearson.
- 2D, 3D, and Multivariate visualization settings are persisted independently.
- Filters remain shared; sampling remains shared but is ignored in Multivariate mode.
- Legacy graph items normalize at the Zustand store boundary; normalization is pure and idempotent.
- New saves emit only `mode` and `modeStates`, never legacy flat visualization fields.
- Follow red-green-refactor for every production change.

---

### Task 1: Mode Types, Defaults, And Legacy Normalization

**Files:**
- Create: `src/components/graphBuilder/graphBuilderMode.ts`
- Create: `tests/graphBuilderMode.test.ts`
- Modify: `src/types/graphBuilder.ts`
- Modify: `src/components/graphBuilder/graphLayerConfig.ts`
- Modify: `src/stores/useGraphBuilderStore.ts`

**Interfaces:**
- Produces: `GraphBuilderMode`, `Graph2DState`, `Graph3DState`, `MultivariateGraphState`, and current `GraphBuilderItem` in `src/types/graphBuilder.ts`.
- Produces: `createDefaultGraph2DState()`, `createDefaultGraph3DState()`, `createDefaultMultivariateGraphState()`, and `normalizeGraphBuilderItem(item: unknown): GraphBuilderItem` in `graphBuilderMode.ts`.
- Produces: `getLayerMode(kind: ElementKind): "2d" | "3d" | "multivariate"` in `graphLayerConfig.ts`.

- [ ] **Step 1: Write the failing mode and migration tests**

Create table-driven tests that assert the exact public shape:

```ts
assert.deepEqual(createDefaultMultivariateGraphState(), {
  columns: [],
  chartType: "correlationMatrix",
  correlationMethod: "pearson",
});

const legacyCorrelation = normalizeGraphBuilderItem({
  ...legacyBase,
  multiX: [continuous("a"), continuous("b")],
  multiY: [continuous("ignored"), continuous("alsoIgnored")],
  elements: [{ kind: "correlationMatrix", correlationMethod: "spearman" }],
});
assert.equal(legacyCorrelation.mode, "multivariate");
assert.deepEqual(
  legacyCorrelation.modeStates.multivariate.columns.map((field) => field.name),
  ["a", "b"],
);
assert.equal(legacyCorrelation.modeStates.multivariate.correlationMethod, "spearman");
assert.deepEqual(normalizeGraphBuilderItem(legacyCorrelation), legacyCorrelation);
```

Cover new defaults, legacy 2D, legacy 3D, ordinary layer splitting, `multiX` precedence, invalid-method fallback, and idempotence.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
$out = Join-Path $env:TEMP "graphBuilderMode.test.mjs"
npx esbuild tests/graphBuilderMode.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force
```

Expected: FAIL because the mode types and helpers do not exist.

- [ ] **Step 3: Add nested mode types and defaults**

Define the discriminated persisted model:

```ts
export type GraphBuilderMode = "2d" | "3d" | "multivariate";

export interface MultivariateGraphState {
  columns: FieldRef[];
  chartType: "correlationMatrix";
  correlationMethod: "pearson" | "spearman" | "kendall";
}

export interface GraphBuilderItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  mode: GraphBuilderMode;
  modeStates: {
    twoD: Graph2DState;
    threeD: Graph3DState;
    multivariate: MultivariateGraphState;
  };
  filters?: FilterRuleItem[];
  sampling?: GraphSampling;
  createdAt: string;
}
```

Move every visualization-specific flat property into the applicable Cartesian state exactly as defined by the spec. Classify `correlationMatrix` as `multivariate`; preserve all existing layer classifications.

- [ ] **Step 4: Implement pure legacy normalization**

Implement `normalizeGraphBuilderItem` without mutating its input. Detect legacy correlation by its enabled element, migrate its ordered variables and method, and otherwise split legacy fields between Cartesian defaults. Return current-format items in canonical form so repeated normalization is deeply equal.

- [ ] **Step 5: Route all store ingress through the normalizer**

Replace the private store normalizer with the exported pure helper in both `addItem` and `loadFromProject`. Keep `updateItem` current-format only so production code cannot reintroduce legacy fields.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 7: Commit the state foundation**

```powershell
git add src/types/graphBuilder.ts src/components/graphBuilder/graphBuilderMode.ts src/components/graphBuilder/graphLayerConfig.ts src/stores/useGraphBuilderStore.ts tests/graphBuilderMode.test.ts
git commit -m "feat(graph): add independent builder mode state"
```

### Task 2: New Graph Creation And Project Round Trip

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`

**Interfaces:**
- Consumes: the three default-state factories and `normalizeGraphBuilderItem` from Task 1.
- Produces: new Graph Builder items containing only current-format `mode` and `modeStates` visualization data.

- [ ] **Step 1: Write failing creation and persistence tests**

Extend project lifecycle coverage with a current nested item and assert round-trip identity:

```ts
assert.equal(savedGraph.mode, "multivariate");
assert.deepEqual(savedGraph.modeStates.multivariate, {
  columns: [continuous("height"), continuous("weight")],
  chartType: "correlationMatrix",
  correlationMethod: "kendall",
});
for (const legacyKey of ["threeD", "encoding", "multiX", "multiY", "elements"]) {
  assert.equal(Object.hasOwn(savedGraph, legacyKey), false);
}
```

Also load one legacy correlation graph through the store and verify that saving emits the canonical nested shape.

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run:

```powershell
$out = Join-Path $env:TEMP "useProjectStore.saveLifecycle.test.mjs"
npx esbuild tests/useProjectStore.saveLifecycle.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=$out
node $out
Remove-Item $out -Force
```

Expected: FAIL because Workspace still creates flat graph items and fixtures still expect legacy fields.

- [ ] **Step 3: Create canonical new graph items**

Update `handleCreateGraphBuilder` to use:

```ts
const item: GraphBuilderItem = {
  id,
  name,
  sourceDatasetId: ds.id,
  mode: "2d",
  modeStates: {
    twoD: createDefaultGraph2DState(),
    threeD: createDefaultGraph3DState(),
    multivariate: createDefaultMultivariateGraphState(),
  },
  createdAt: new Date().toISOString(),
};
```

Keep save and open transport opaque; both existing project load and standalone graph import must enter through the store normalizer.

- [ ] **Step 4: Run the lifecycle test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit creation and persistence**

```powershell
git add src/components/Workspace.tsx tests/useProjectStore.saveLifecycle.test.ts
git commit -m "feat(graph): persist builder mode configurations"
```

### Task 3: Active-Mode Request Derivation

**Files:**
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: nested mode state from Task 1.
- Produces: `deriveGraphRequestParts(item, ...)`, `deriveFields(item, ...)`, and `deriveElements(item)` that read only the active mode.
- Preserves: existing Rust-facing `multiY0...multiYn` correlation bindings and `correlationMatrix` element request.

- [ ] **Step 1: Rewrite correlation request tests against Multivariate state**

Assert deterministic role encoding and inactive-state exclusion:

```ts
const item = makeGraphBuilderItem({
  mode: "multivariate",
  modeStates: {
    ...defaultModeStates(),
    twoD: { ...createDefaultGraph2DState(), encoding: { x: continuous("inactive_x") } },
    multivariate: {
      columns: [continuous("a"), continuous("b"), continuous("c")],
      chartType: "correlationMatrix",
      correlationMethod: "spearman",
    },
  },
});
assert.deepEqual(roleColumns(deriveFields(item, filters), "multiY0"), ["a"]);
assert.deepEqual(roleColumns(deriveFields(item, filters), "multiY2"), ["c"]);
assert.deepEqual(roleColumns(deriveFields(item, filters), "x"), []);
assert.deepEqual(deriveElements(item), [{
  kind: "correlationMatrix",
  summaryStat: "none",
  correlationMethod: "spearman",
}]);
```

Retain explicit tests proving ordinary 2D `multiX`/`multiY` axis and merge behavior is unchanged.

- [ ] **Step 2: Run the pipeline test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
```

Expected: FAIL because request derivation still reads flat fields and infers correlation from a layer.

- [ ] **Step 3: Select active state before deriving requests**

Refactor request helpers so 2D and 3D consume their nested Cartesian state. For Multivariate mode, emit one correlation element and ordered `multiY${index}` fields directly from `columns`; include shared filters, omit synthetic melt fields, and resolve sampling as full data.

- [ ] **Step 4: Run the pipeline test and verify GREEN**

Run the Step 2 command. Expected: PASS, including the retained ordinary multi-column tests.

- [ ] **Step 5: Commit active request derivation**

```powershell
git add src/components/graphBuilder/useGraphDataPipeline.ts tests/graphDataPipeline.test.ts
git commit -m "feat(graph): derive data from active builder mode"
```

### Task 4: Three-Mode Graph Builder Interface

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: mode states, defaults, and layer registry from Tasks 1-3.
- Produces: explicit `setMode(mode: GraphBuilderMode)`, mode-scoped state updates, and a Multivariate Y (Variables) editor.

- [ ] **Step 1: Add failing UI contract assertions**

Replace source assertions tied to `item.threeD`, local `LAYER_DIM`, and `isCorrelationMatrixItem(item)` with assertions for:

```ts
assert.match(graphBuilderViewSource, /item\.mode === "multivariate"/);
assert.match(graphBuilderViewSource, /setMode\("2d"\)/);
assert.match(graphBuilderViewSource, /setMode\("3d"\)/);
assert.match(graphBuilderViewSource, /setMode\("multivariate"\)/);
assert.match(graphBuilderViewSource, /modeStates\.multivariate\.columns/);
assert.doesNotMatch(graphBuilderViewSource, /isCorrelationMatrixItem\(item\)/);
```

Add behavior-oriented helper tests for appending, reordering, and removing variables, plus rejection of duplicate, categorical, and 21st fields. Extract a pure `updateMultivariateColumns` helper if needed to avoid testing DOM internals.

- [ ] **Step 2: Run the focused UI contract and verify RED**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
```

Expected: FAIL because the view still uses a 2D/3D boolean toggle and correlation layer inference.

- [ ] **Step 3: Refactor the view around active mode state**

Introduce stable aliases for `twoD`, `threeD`, and `multivariate`. Every edit must replace only its target nested state:

```ts
updateItem(item.id, {
  modeStates: {
    ...item.modeStates,
    multivariate: {
      ...item.modeStates.multivariate,
      columns: nextColumns,
    },
  },
});
```

Make `startOver` reset only the active state. Keep Swap X/Y and axis/reference-line editing 2D-only. Keep Cartesian layer editing mode-scoped. Dispatch rendering by explicit mode and remove runtime dependence on legacy flat fields.

- [ ] **Step 4: Build the Multivariate role panel**

Render Correlation Matrix as the selected chart type and Y (Variables) as the sole drop role. Reuse existing field chips and drop feedback where possible. Accept only unique continuous fields, cap at 20, retain list order, allow append/removal/reorder, and show the existing empty guidance until two fields are selected.

- [ ] **Step 5: Replace the segmented mode control and visibility gates**

Render `2D | 3D | Multivariate` at all times. Give the control three stable tracks and thumb positions. In Multivariate mode keep Filter, chart type, variable list, and correlation method; hide sampling, cursor, Swap X/Y, Cartesian roles, facets, axis dialogs, reference lines, style/legend editing, and ordinary layers.

- [ ] **Step 6: Add all locale strings**

Add equivalent keys to all four locale files:

```json
{
  "graph.mode.label": "Graph mode",
  "graph.mode.twoD": "2D",
  "graph.mode.threeD": "3D",
  "graph.mode.multivariate": "Multivariate",
  "graph.multivariate.variables": "Y (Variables)",
  "graph.multivariate.chartType": "Chart type"
}
```

Use native translations in Chinese locale files and the established fallback style in Vietnamese. Include concise invalid-field, duplicate-field, and maximum-column feedback keys only when existing correlation messages cannot express them.

- [ ] **Step 7: Run focused tests and build**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/graphLayerConfig.test.ts
npx vite build 2>&1 | Select-Object -Last 3
```

Expected: both tests PASS and Vite exits 0.

- [ ] **Step 8: Commit the interface**

```powershell
git add src/components/graphBuilder/GraphBuilderView.tsx src/components/graphBuilder/graphBuilder.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/graphDataPipeline.test.ts
git commit -m "feat(graph): add multivariate builder interface"
```

### Task 5: Full Regression Validation And Cleanup

**Files:**
- Modify: only files required by failures directly caused by Tasks 1-4
- Test: `tests/*.test.ts`

**Interfaces:**
- Consumes: complete frontend implementation from Tasks 1-4.
- Produces: no legacy production reads, passing frontend suite/build, and evidence that the unchanged backend correlation boundary still passes.

- [ ] **Step 1: Scan production code for legacy mode reads**

Run:

```powershell
rg "item\.(threeD|encoding|multiX|multiY|elements|xAxis|yAxis|refLinesX|refLinesY)" src
```

Expected: no Graph Builder runtime reads outside explicit compatibility normalization. Fix only remaining #69 migration gaps, then rerun focused tests for each touched file.

- [ ] **Step 2: Run every standalone frontend test**

Run each `tests/*.test.ts` with the repository's direct Node pattern. For alias-dependent tests, bundle with the Task 1 esbuild pattern. Record the exact passing and failing file counts; repair only failures introduced by this branch and rerun each repaired test before proceeding.

- [ ] **Step 3: Run the production frontend build**

```powershell
npx vite build 2>&1 | Select-Object -Last 3
```

Expected: exit code 0.

- [ ] **Step 4: Run focused unchanged-backend correlation tests**

From `src-tauri` run the existing correlation-filtered tests:

```powershell
cargo test correlation
```

Expected: exit code 0 and no failed correlation tests.

- [ ] **Step 5: Perform the manual Tauri acceptance pass**

Start the app and verify: each mode restores independent fields/layers; Multivariate accepts, orders, and removes 2-20 continuous fields; invalid drops are rejected; all three methods and filters refresh the matrix; sampling is absent; save/reopen preserves all three mode states; switching during loading never displays a stale chart.

- [ ] **Step 6: Commit any validation-only fixes**

If Step 1-5 required code changes:

```powershell
git add <only-files-changed-for-issue-69>
git commit -m "fix(graph): complete multivariate mode migration"
```

If no changes were required, do not create an empty commit.