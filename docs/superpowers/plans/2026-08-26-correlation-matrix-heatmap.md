# Correlation Matrix Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an exact, backend-computed Pearson/Spearman/Kendall correlation matrix heatmap for 2 to 20 numeric Graph Builder columns.

**Architecture:** A pure Rust correlation module computes pairwise statistics, while `DuckDbEngine` validates multi-column bindings, reads filtered numeric values, and emits a dedicated `correlationMatrix` aggregate packet. The frontend strictly validates that packet, requests it without multi-column melt expansion, and renders an exclusive standard ECharts heatmap through the existing coherent-frame pipeline.

**Tech Stack:** Rust 2021, DuckDB, serde, Tauri v2, TypeScript 5.7, React 19, ECharts 5.6, Node's TypeScript test runner.

## Global Constraints

- Accept exactly 2 to 20 unique continuous numeric columns in display order.
- Support `pearson`, `spearman`, and tie-corrected Kendall $\tau_b$; Pearson is the persisted default.
- Use pairwise deletion of null, non-numeric, and non-finite observations.
- Kendall must use $O(n \log n)$ counting or equivalent bounded complexity, never quadratic row-pair enumeration.
- Emit a complete deterministic row-major $p^2$ matrix; compute only the upper triangle and mirror it.
- Represent undefined coefficients as absent values with `insufficientData` or `zeroVariance`, never as zero, `NaN`, or infinity.
- Preserve request ID, generation fencing, stream ordering, cancellation, and coherent-frame commit behavior.
- Keep the existing two-dimensional density `heatmap` packet and renderer unchanged.
- Use validated and quoted identifiers; do not concatenate unvalidated user input into SQL.
- Return `Result<T, AppError>` and do not add `unwrap()` or `expect()` to non-test Rust code.
- Correlation Matrix is an exclusive 2D layout and does not combine with ordinary Cartesian layers, facets, grouping, reference lines, raw-point picking, or axis interaction controls.
- Do not add dependencies.

---

### Task 1: Pure Rust Correlation Statistics

**Files:**
- Create: `src-tauri/src/engine/correlation.rs`
- Modify: `src-tauri/src/engine/mod.rs`

**Interfaces:**
- Consumes: Two equal-length `&[Option<f64>]` columns whose positions represent the same filtered source rows.
- Produces: `pub enum StatisticalMethod { Pearson, Spearman, Kendall }`, `pub enum CorrelationFailure { InsufficientData, ZeroVariance }`, `pub struct CorrelationResult { pub coefficient: Option<f64>, pub sample_count: u64, pub failure: Option<CorrelationFailure> }`, and `pub fn correlate(left: &[Option<f64>], right: &[Option<f64>], method: StatisticalMethod) -> CorrelationResult`.

- [ ] **Step 1: Write failing unit tests for pairwise filtering and Pearson stability**

Add `#[cfg(test)] mod tests` in `correlation.rs` with assertions equivalent to:

```rust
#[test]
fn pearson_uses_pairwise_finite_rows_and_is_stable_at_large_offsets() {
    let left = [Some(1.0e12 + 1.0), None, Some(1.0e12 + 2.0), Some(f64::INFINITY), Some(1.0e12 + 3.0)];
    let right = [Some(3.0), Some(99.0), Some(5.0), Some(7.0), Some(7.0)];
    let result = correlate(&left, &right, StatisticalMethod::Pearson);
    assert_eq!(result.sample_count, 3);
    assert!((result.coefficient.unwrap() - 1.0).abs() < 1e-12);
    assert_eq!(result.failure, None);
}

#[test]
fn pearson_distinguishes_insufficient_data_from_zero_variance() {
    let insufficient = correlate(&[Some(1.0)], &[Some(2.0)], StatisticalMethod::Pearson);
    assert_eq!(insufficient.coefficient, None);
    assert_eq!(insufficient.failure, Some(CorrelationFailure::InsufficientData));

    let constant = correlate(&[Some(4.0), Some(4.0)], &[Some(1.0), Some(2.0)], StatisticalMethod::Pearson);
    assert_eq!(constant.coefficient, None);
    assert_eq!(constant.failure, Some(CorrelationFailure::ZeroVariance));
}
```

- [ ] **Step 2: Run the focused Rust tests and confirm RED**

Run: `cargo test engine::correlation::tests --lib`

Expected: compilation fails because the correlation types/functions are not implemented.

- [ ] **Step 3: Implement pairwise extraction and stable Pearson**

Implement one-pass centered covariance accumulation over rows where both options contain finite values. Return `InsufficientData` for $n < 2$, `ZeroVariance` when either centered sum of squares is zero, and otherwise clamp only the final finite coefficient to `[-1.0, 1.0]`.

- [ ] **Step 4: Run the Pearson tests and confirm GREEN**

Run: `cargo test engine::correlation::tests::pearson --lib`

Expected: both Pearson tests pass.

- [ ] **Step 5: Write failing Spearman tie and rank-locality tests**

```rust
#[test]
fn spearman_uses_average_ties_after_pairwise_deletion() {
    let left = [Some(10.0), Some(10.0), Some(20.0), None];
    let right = [Some(1.0), Some(2.0), Some(3.0), Some(100.0)];
    let result = correlate(&left, &right, StatisticalMethod::Spearman);
    assert_eq!(result.sample_count, 3);
    assert!((result.coefficient.unwrap() - 0.8660254037844387).abs() < 1e-12);
}
```

- [ ] **Step 6: Run the Spearman test and confirm RED**

Run: `cargo test engine::correlation::tests::spearman --lib`

Expected: test fails because Spearman is not implemented.

- [ ] **Step 7: Implement average ranks and rank Pearson**

Sort `(value, original_index)` pairs with `f64::total_cmp`, assign each equal-value run its average one-based rank, restore input order, then feed both rank vectors to the stable Pearson helper.

- [ ] **Step 8: Run the Spearman test and confirm GREEN**

Run: `cargo test engine::correlation::tests::spearman --lib`

Expected: pass.

- [ ] **Step 9: Write failing Kendall $\tau_b$ tie tests**

Use hand-checkable datasets covering perfect order, reverse order, ties in each side, and tied-both pairs:

```rust
#[test]
fn kendall_tau_b_corrects_ties() {
    let left = [Some(1.0), Some(1.0), Some(2.0), Some(3.0)];
    let right = [Some(1.0), Some(2.0), Some(2.0), Some(3.0)];
    let result = correlate(&left, &right, StatisticalMethod::Kendall);
    assert_eq!(result.sample_count, 4);
    assert!((result.coefficient.unwrap() - 0.8).abs() < 1e-12);
}
```

- [ ] **Step 10: Run the Kendall test and confirm RED**

Run: `cargo test engine::correlation::tests::kendall --lib`

Expected: test fails because Kendall is not implemented.

- [ ] **Step 11: Implement $O(n \log n)$ Kendall $\tau_b$**

Sort pairwise values by `(x, y)`, count ties in X, ties in Y, and joint ties from equal-value runs, and count discordant pairs with merge-sort inversion counting over Y while excluding X-tied pairs. Compute:

```rust
let numerator = concordant as f64 - discordant as f64;
let denominator = (((n0 - ties_x) as f64) * ((n0 - ties_y) as f64)).sqrt();
```

Return `ZeroVariance` when the denominator is zero. Keep inversion and pair counts in `u128` internally so large row counts cannot overflow before conversion to `f64`.

- [ ] **Step 12: Run all correlation tests and confirm GREEN**

Run: `cargo test engine::correlation::tests --lib`

Expected: all Pearson, Spearman, Kendall, symmetry, diagonal, finite filtering, and unavailable-reason tests pass.

- [ ] **Step 13: Commit the statistics module**

```powershell
git add src-tauri/src/engine/correlation.rs src-tauri/src/engine/mod.rs
git commit -m "feat(stats): add pairwise correlation methods"
```

---

### Task 2: Rust Request and Aggregate Packet Contract

**Files:**
- Modify: `src-tauri/src/models/graph_data.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/graph_data_service.rs`

**Interfaces:**
- Consumes: Task 1 `correlate`, `StatisticalMethod`, and `CorrelationFailure`; existing `GraphDataRequest.fields`, filters, generation, and cancellation path.
- Produces: serde-camelCase `CorrelationMethod`, `CorrelationUnavailableReason`, `CorrelationMatrixCell`, `CorrelationMatrixPacket`, `GraphAggregatePacket::CorrelationMatrix`, and optional `GraphElementRequest.correlation_method`.

- [ ] **Step 1: Write failing model serialization tests**

In `models/graph_data.rs`, add tests asserting that a packet serializes with `kind: "correlationMatrix"`, `method: "spearman"`, camelCase `sampleCount`, absent `coefficient`, and `unavailableReason: "zeroVariance"`.

- [ ] **Step 2: Run the model test and confirm RED**

Run: `cargo test models::graph_data::tests::correlation_matrix --lib`

Expected: compilation fails because the packet types and enum variant do not exist.

- [ ] **Step 3: Add the Rust request and packet types**

Add these shapes with serde rename rules and equality derives suitable for tests:

```rust
pub struct GraphElementRequest {
    pub kind: String,
    pub summary_stat: String,
    #[serde(default)]
    pub correlation_method: Option<CorrelationMethod>,
}

pub struct CorrelationMatrixCell {
    pub x_index: u32,
    pub y_index: u32,
    pub coefficient: Option<f64>,
    pub sample_count: u64,
    pub unavailable_reason: Option<CorrelationUnavailableReason>,
}

pub struct CorrelationMatrixPacket {
    pub method: CorrelationMethod,
    pub columns: Vec<String>,
    pub cells: Vec<CorrelationMatrixCell>,
}
```

Use `#[serde(tag = "kind", rename_all = "camelCase")]` on `GraphAggregatePacket` so the new variant emits `correlationMatrix` consistently with existing variants.

Implement explicit `From<CorrelationMethod> for StatisticalMethod` and
`From<CorrelationFailure> for CorrelationUnavailableReason` mappings in the
graph engine. The pure statistics module must not import IPC model types.

- [ ] **Step 4: Run the model test and confirm GREEN**

Run: `cargo test models::graph_data::tests::correlation_matrix --lib`

Expected: pass.

- [ ] **Step 5: Write failing engine validation and matrix tests**

In the existing DuckDB/graph service test modules, seed numeric columns `a`, `b`, `c`, a text column, nulls, and infinities. Add tests asserting:

```rust
assert_eq!(packet.columns, vec!["a", "b", "c"]);
assert_eq!(packet.cells.len(), 9);
assert_eq!((packet.cells[0].x_index, packet.cells[0].y_index), (0, 0));
assert_eq!((packet.cells[8].x_index, packet.cells[8].y_index), (2, 2));
assert_eq!(packet.cells[1].coefficient, packet.cells[3].coefficient);
assert_eq!(packet.cells[1].sample_count, packet.cells[3].sample_count);
```

Also add independent rejection cases for one column, 21 columns, duplicate bindings, a non-numeric column, both `multiX*` and `multiY*`, and a missing method.

- [ ] **Step 6: Run the focused engine tests and confirm RED**

Run: `cargo test correlation_matrix --lib`

Expected: tests fail because correlation aggregate collection is not implemented.

- [ ] **Step 7: Validate and collect ordered correlation bindings**

Add a helper that selects exactly one case-insensitive role prefix (`multix` or `multiy`), parses numeric suffixes, sorts by suffix, rejects gaps/duplicates, validates 2–20 unique metadata-backed numeric columns, and obtains the method from the sole enabled `correlationMatrix` element. Missing/unsupported methods return `AppError::InvalidParam`.

- [ ] **Step 8: Query filtered columns once and assemble the matrix**

Reuse `compile_graph_query_plan` filtering and identifier validation, but project original selected columns rather than melted `__sp_value__`. Convert null/non-finite values to `None`, retain one vector per selected column, call Task 1 only for `x_index <= y_index`, mirror results, and emit row-major cells using:

```rust
for y_index in 0..column_count {
    for x_index in 0..column_count {
        cells.push(cached_pair_result(x_index.min(y_index), x_index.max(y_index)));
    }
}
```

Check cancellation while reading rows and between unique variable pairs. Do not emit histogram, density heatmap, boxplot, or summary packets for an exclusive correlation request.

- [ ] **Step 9: Run focused Rust tests and confirm GREEN**

Run: `cargo test correlation_matrix --lib`

Expected: packet, pairwise, ordering, filtering, and invalid-request tests pass.

- [ ] **Step 10: Run graph service regressions**

Run: `cargo test graph_data_service --lib`

Expected: existing graph packet and stream tests remain green.

- [ ] **Step 11: Commit the backend contract and aggregation**

```powershell
git add src-tauri/src/models/graph_data.rs src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/graph_data_service.rs
git commit -m "feat(graph): stream correlation matrix aggregates"
```

---

### Task 3: TypeScript Packet Types and Strict Validation

**Files:**
- Modify: `src/types/graphData.ts`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: Task 2 camelCase JSON packet contract.
- Produces: `CorrelationMethod`, `CorrelationUnavailableReason`, `CorrelationMatrixCell`, `CorrelationMatrixPacket`, union membership in `GraphAggregatePacket`, and strict support in `isGraphAggregatePacket`.

- [ ] **Step 1: Write failing strict-validator tests**

Add one valid 2-by-2 packet and cloned invalid packets covering duplicate cell indices, 3 cells instead of 4, coefficient `1.01`, negative/non-integer `sampleCount`, absent coefficient without reason, coefficient with a reason, duplicate columns, unsupported method, and out-of-range indices.

```ts
assert.equal(isGraphAggregatePacket(validCorrelationPacket), true);
assert.equal(isGraphAggregatePacket({ ...validCorrelationPacket, method: "distance" }), false);
assert.equal(isGraphAggregatePacket({ ...validCorrelationPacket, cells: validCorrelationPacket.cells.slice(0, 3) }), false);
```

- [ ] **Step 2: Run the frontend contract test and confirm RED**

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: valid correlation packet is rejected because the union and guard do not support it.

- [ ] **Step 3: Add types and semantic validation**

Implement a packet guard that verifies 2–20 unique non-empty column names, exact `columns.length ** 2` cells, row-major index identity at each array position, finite coefficients inside `[-1, 1]`, non-negative integer sample counts, and the exclusive coefficient/reason relationship.

- [ ] **Step 4: Run the frontend contract test and confirm GREEN**

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: all packet validation and existing pipeline tests pass.

- [ ] **Step 5: Commit the TypeScript packet contract**

```powershell
git add src/types/graphData.ts tests/graphDataPipeline.test.ts
git commit -m "feat(graph): validate correlation matrix packets"
```

---

### Task 4: Correlation Request Derivation Without Melt

**Files:**
- Modify: `src/graphCore/types.ts`
- Modify: `src/types/graphBuilder.ts`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `tests/graphDataPipeline.test.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`

**Interfaces:**
- Consumes: `ChartElement.options.correlationMethod`, existing `multiX`/`multiY`, and Task 3 packet types.
- Produces: `ElementKind` member `correlationMatrix`; request element `{ kind, summaryStat, correlationMethod? }`; exported `isCorrelationMatrixItem(item)` helper used by Graph Builder and pipeline rendering decisions.

- [ ] **Step 1: Write failing request derivation tests**

Export `deriveElements` for direct tests. For an item with `multiX: [a, b, c]` and a correlation element, assert:

```ts
assert.deepEqual(deriveFields(item), [
  { role: "multiX0", column: "a" },
  { role: "multiX1", column: "b" },
  { role: "multiX2", column: "c" },
]);
assert.deepEqual(deriveElements(item), [
  { kind: "correlationMatrix", summaryStat: "none", correlationMethod: "spearman" },
]);
```

Assert a missing option normalizes to `pearson`, and assert source-level/runtime behavior does not create `__sp_variable__` or `__sp_value__` for a correlation request.

- [ ] **Step 2: Run request derivation tests and confirm RED**

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: missing element kind/method and melt bypass assertions fail.

- [ ] **Step 3: Add the element kind and derive the method**

Add `correlationMatrix` to `ElementKind`, add optional `correlationMethod` to the TS `GraphElementRequest`, export `isCorrelationMatrixItem`, and have `deriveElements` emit only a validated method (`pearson`, `spearman`, or `kendall`) with a Pearson fallback.

- [ ] **Step 4: Bypass effective melt for correlation requests**

Keep multi bindings in `deriveFields`, but make `meltInfo` return `null` when `isCorrelationMatrixItem(item)` is true. Correlation rendering receives an empty legacy `GraphData.rows` and consumes only the aggregate packet after coherent commit.

- [ ] **Step 5: Add project round-trip coverage**

Extend save lifecycle fixtures with a correlation element using `kendall`; assert save/load preserves it. Add a legacy fixture with a correlation element lacking the option and assert runtime request normalization chooses Pearson without mutating unrelated project data.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/useProjectStore.saveLifecycle.test.ts
```

Expected: both pass.

- [ ] **Step 7: Commit request and persistence behavior**

```powershell
git add src/graphCore/types.ts src/types/graphBuilder.ts src/components/graphBuilder/useGraphDataPipeline.ts tests/graphDataPipeline.test.ts tests/useProjectStore.saveLifecycle.test.ts
git commit -m "feat(graph): request correlation matrix data"
```

---

### Task 5: Correlation Matrix ECharts Transform

**Files:**
- Modify: `src/graphCore/transform.ts`
- Modify: `src/graphCore/theme.ts`
- Modify: `tests/transformAggregatePackets.test.ts`

**Interfaces:**
- Consumes: Task 3 `CorrelationMatrixPacket`, `GraphTheme`, and frame aggregates.
- Produces: a dedicated single-panel standard ECharts heatmap option returned before ordinary Cartesian/facet transforms.

- [ ] **Step 1: Write failing transform tests**

Build a frame-backed 3-column packet and assert:

```ts
assert.deepEqual(option.xAxis.data, ["alpha", "beta", "gamma"]);
assert.deepEqual(option.yAxis.data, ["alpha", "beta", "gamma"]);
assert.equal(option.series[0].type, "heatmap");
assert.deepEqual(option.visualMap.min, -1);
assert.deepEqual(option.visualMap.max, 1);
assert.equal(option.series[0].data.length, 9);
```

Assert a zero coefficient remains numeric zero, while an undefined coefficient has an unavailable item style and no label value. Invoke the tooltip formatter and assert it contains both names, localized method name/key, coefficient or unavailable reason, and `n`.

- [ ] **Step 2: Run transform tests and confirm RED**

Run: `node --experimental-strip-types tests/transformAggregatePackets.test.ts`

Expected: no correlation matrix option is emitted.

- [ ] **Step 3: Implement packet lookup and exclusive early return**

Add `findCorrelationMatrixPacket` with the same frame ownership rules as other aggregate lookups. When an enabled `correlationMatrix` element and matching packet exist, return one panel immediately and do not enter facet, shared-axis, raw-point, reference-line, or ordinary layer paths.

- [ ] **Step 4: Build a standard heatmap option**

Emit category axes in packet order, square-oriented grid sizing, `animation: false`, a fixed continuous visual map from `-1` to `1`, and one `type: "heatmap"` series. Use data objects carrying `value: [xIndex, yIndex, coefficientOrSentinel]` plus cell metadata for tooltip formatting. Do not use `custom` or `renderItem`.

Use a balanced diverging palette with theme-backed negative, neutral, and positive colors. Undefined cells use a distinct neutral fill and `label.show: false`; defined cells format to a maximum of three decimals and choose dark/light text by coefficient magnitude.

- [ ] **Step 5: Run transform tests and confirm GREEN**

Run: `node --experimental-strip-types tests/transformAggregatePackets.test.ts`

Expected: matrix semantics pass and all existing density heatmap packet tests remain green.

- [ ] **Step 6: Commit the renderer**

```powershell
git add src/graphCore/transform.ts src/graphCore/theme.ts tests/transformAggregatePackets.test.ts
git commit -m "feat(graph): render correlation matrix heatmap"
```

---

### Task 6: Graph Builder Correlation Layer UX

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: Task 4 `isCorrelationMatrixItem`, `ElementKind`, and correlation method option.
- Produces: layer picker entry, method selector, exclusive-layer transitions, 2–20-column guidance/rejection, and suppression of inapplicable controls.

- [ ] **Step 1: Write failing UI structure and localization tests**

Extend the existing TypeScript AST/source and locale tests to require:

```ts
const requiredLocalePaths = [
  "graph.type.correlationMatrix",
  "graph.opt.correlationMethod",
  "graph.opt.correlation.pearson",
  "graph.opt.correlation.spearman",
  "graph.opt.correlation.kendall",
  "graph.correlation.requiresColumns",
  "graph.correlation.tooManyColumns",
];
```

Assert `CHART_TYPE_DEFS` and `LAYER_DIM` include `correlationMatrix`, `LayerCard` renders `CorrelationMatrixOptions`, and correlation mode gates axis dialogs, cursor controls, legend/group styling, reference-line controls, and facets.

- [ ] **Step 2: Run the UI contract test and confirm RED**

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: layer/localization assertions fail.

- [ ] **Step 3: Add exclusive layer transitions**

When adding `correlationMatrix`, replace enabled 2D elements with one element whose options are `{ correlationMethod: "pearson" }`. When adding any ordinary 2D element while correlation mode is active, remove the correlation element first. Preserve inactive 3D elements so toggling dimensional mode remains non-destructive.

- [ ] **Step 4: Add the method selector and column constraints**

Implement `CorrelationMatrixOptions` as one native select with Pearson, Spearman, and Kendall. Disable graph request/render readiness below 2 columns and reject attempts to append beyond 20 with the existing slot reject flash plus localized canvas guidance. Keep the selected column order and existing multi-column manager.

- [ ] **Step 5: Suppress inapplicable correlation controls**

In correlation mode, hide Group X/Y, overlay legend/style editing, X/Y axis settings triggers, pan/select toolbar, reference-line controls, and point click/brush handlers. Keep filters and loading/error overlays active. The matrix canvas itself remains the first screen; do not add an explanatory landing view.

- [ ] **Step 6: Add responsive matrix CSS**

Give the chart host stable minimum dimensions and overflow behavior so 20 labels remain reachable without overlapping layer/slot panels. Keep existing card radius and design tokens; do not introduce a new palette outside graph theme colors.

- [ ] **Step 7: Run UI tests and frontend build**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
npx vite build
```

Expected: tests pass and Vite build succeeds.

- [ ] **Step 8: Commit the Graph Builder UX**

```powershell
git add src/components/graphBuilder/GraphBuilderView.tsx src/components/graphBuilder/graphBuilder.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/graphDataPipeline.test.ts
git commit -m "feat(graph): add correlation matrix layer controls"
```

---

### Task 7: Full Regression and Manual Verification

**Files:**
- Modify only files required to fix regressions caused by Tasks 1–6.

**Interfaces:**
- Consumes: the complete issue #44 implementation.
- Produces: verified branch with no generated schema noise or uncommitted changes.

- [ ] **Step 1: Run all TypeScript tests**

Run: `node --experimental-strip-types --test tests/*.test.ts`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run the frontend production build**

Run: `npx vite build`

Expected: TypeScript compilation and Vite production build succeed. Record existing bundle-size warnings separately.

- [ ] **Step 3: Run Rust formatting and focused lint**

Run:

```powershell
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
```

Expected: both succeed without warnings.

- [ ] **Step 4: Run the complete Rust build and tests**

Run:

```powershell
cargo build
cargo test
```

Expected: both succeed with zero failed tests.

- [ ] **Step 5: Restore build-generated schema rewrites if they are content-equivalent noise**

Inspect `git status --short`. If `src-tauri/gen/schemas/desktop-schema.json` or `windows-schema.json` changed only because Tauri rewrote line endings/generated ordering and no command/capability contract changed, restore exactly those two files. Do not restore source or test changes.

- [ ] **Step 6: Start the Tauri development app**

Run from the worktree root: `cargo tauri dev`

Expected: app opens without frontend or IPC errors. Keep the server running during manual checks.

- [ ] **Step 7: Exercise the acceptance matrix**

Verify with a dataset containing monotonic, reverse-monotonic, tied, constant, missing, and non-finite numeric columns:

1. Pearson, Spearman, and Kendall each produce expected signs and values.
2. Method switching preserves the old complete matrix until the new result commits.
3. Pairwise `n` differs between cells where missingness differs.
4. Constant/insufficient cells are unavailable rather than zero.
5. Full symmetric cells and valid diagonals render.
6. Filters update coefficients and sample counts.
7. Two columns and 20 columns render; 1 and 21 are rejected.
8. Long labels remain reachable and tooltips show full names.
9. Existing density heatmap and ordinary multi-column chart still render after leaving correlation mode.

- [ ] **Step 8: Stop the development server and inspect the final diff**

Run:

```powershell
git diff --check
git status --short
git log --oneline --decorate -8
```

Expected: no whitespace errors, no generated noise, and only intentional issue #44 changes/commits.

- [ ] **Step 9: Commit any verification-only regression fix**

If Task 7 required a source correction, rerun the narrow failing check and then all affected gates before committing:

```powershell
git add src/graphCore/transform.ts tests/transformAggregatePackets.test.ts
git commit -m "fix(graph): resolve correlation matrix regression"
```

The paths above illustrate a transform regression. Stage the exact source and
regression-test files actually changed, and no generated or unrelated files.
If no correction was needed, do not create an empty commit.