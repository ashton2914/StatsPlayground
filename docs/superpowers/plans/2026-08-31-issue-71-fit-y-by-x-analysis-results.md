# Fit Y by X Analysis Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Fit Y by X with automatic Oneway and Bivariate personalities, shared Graph Builder visualizations, and authoritative JMP-inspired statistical reports.

**Architecture:** `FitYByXItem` continues to own the persisted analysis definition and embedded graph configuration. Graphs stay in `GraphRuntime`; a new Rust `FitYByXService` reads complete paired data through a narrow DuckDB engine API, computes a discriminated statistical result, and returns it through a typed Tauri IPC wrapper to a focused React report hook and view.

**Tech Stack:** React 19, TypeScript, Zustand, ECharts/Graph Core, Tauri v2, Rust, DuckDB, statrs 0.19.1, serde, existing esbuild-based Node contract tests.

**Spec:** `docs/superpowers/specs/2026-08-31-issue-71-fit-y-by-x-analysis-results-design.md` (Approved)

## Global Constraints

- Y is one numeric column modeled as continuous.
- X is one distinct column modeled as continuous, nominal, or ordinal.
- Nominal/ordinal X selects `oneway`; continuous X selects `bivariate`.
- Oneway graphs use Points and Box Plot; Bivariate graphs use Points and a degree-one polynomial Fit Line with confidence band.
- Every graph is rendered by the existing `GraphRuntime`; do not create a second chart renderer or hidden `GraphBuilderItem` store entry.
- Statistical calculations use complete pairwise-valid data and never use sampled graph payloads.
- Statistical results are recomputed and are not persisted in the project archive.
- Rust commands return `Result<T, AppError>` and do not use `unwrap()` or `expect()` outside tests.
- SQL values are parameterized. Requested columns are validated against `_meta_columns` before quoted identifiers are used.
- Rust models serialize camelCase and TypeScript types mirror them exactly.
- Existing Fit Y by X documents without `personality` load as `oneway` when X is categorical.
- Expected mathematical degeneracy is structured data, not `AppError`.
- User-facing strings are added to `en.json`, `zh-CN.json`, `zh-TW.json`, and `vi.json`.
- Follow red-green-refactor for every production boundary.
- Do not stage unrelated changes already present in `src-tauri/Cargo.toml` or generated schema files; merge the required `statrs` dependency into the current Cargo manifest without reverting user changes.

## File Structure

### New Files

- `src-tauri/src/models/fit_y_by_x.rs`: request/result wire models and stable reason enums.
- `src-tauri/src/engine/fit_y_by_x.rs`: pure Oneway and Bivariate calculations over validated rows.
- `src-tauri/src/services/fit_y_by_x_service.rs`: request validation, full-data loading, and calculation dispatch.
- `src-tauri/src/commands/fit_y_by_x_commands.rs`: thin Tauri command.
- `src/services/fitYByXService.ts`: typed frontend IPC wrapper.
- `src/components/fitYByX/useFitYByXReport.ts`: generation-fenced report loading state.
- `src/components/fitYByX/FitYByXReport.tsx`: compact disclosure sections and statistical tables.
- `tests/fitYByXReport.test.ts`: frontend result formatting/render contract.
- `tests/fitYByXReportState.test.ts`: stale-response and independent-error state contract.

### Modified Files

- `src-tauri/Cargo.toml`: add `statrs` while preserving current unrelated edits.
- `src-tauri/src/engine/mod.rs`: export pure analysis engine.
- `src-tauri/src/engine/duckdb_engine.rs`: add a narrow, validated two-column read API.
- `src-tauri/src/models/mod.rs`, `services/mod.rs`, `commands/mod.rs`, `lib.rs`: export and register the IPC path.
- `src/types/fitYByX.ts`: personality, request, result, table-row, and reason-code types.
- `src/types/index.ts`, `src/services/index.ts`: public exports.
- `src/components/fitYByX/fitYByXRoles.ts`: accept continuous X and derive personality.
- `src/components/fitYByX/fitYByXConfig.ts`: personality-aware item and graph defaults.
- `src/components/fitYByX/fitYByXDialogState.ts`, `FitYByXRoleDialog.tsx`: expose the selected personality.
- `src/stores/useFitYByXStore.ts`: backward-compatible personality and graph normalization.
- `src/components/fitYByX/FitYByXView.tsx`, `index.ts`: load and render the report below the graph.
- `src/App.css`: bounded graph height, scrollable analysis page, disclosure bars, and dense tables.
- `src/i18n/locales/{en,zh-CN,zh-TW,vi}.json`: personality, section, column, error, and degeneracy labels.
- Existing Fit Y by X, graph runtime, pipeline, project-load, and workspace tests: update contracts without weakening prior coverage.

---

### Task 1: Personality-Aware Analysis Definition And Graph Defaults

**Files:**
- Modify: `src/types/fitYByX.ts`
- Modify: `src/components/fitYByX/fitYByXRoles.ts`
- Modify: `src/components/fitYByX/fitYByXConfig.ts`
- Modify: `src/components/fitYByX/fitYByXDialogState.ts`
- Modify: `src/components/fitYByX/FitYByXRoleDialog.tsx`
- Modify: `src/stores/useFitYByXStore.ts`
- Test: `tests/fitYByXConfig.test.ts`
- Test: `tests/fitYByXDialog.test.ts`
- Test: `tests/fitYByXStore.test.ts`

**Interfaces:**
- Produces: `FitYByXPersonality`, `deriveFitYByXPersonality(factor)`, personality-aware `createDefaultFitYByXGraphConfig`, normalized `FitYByXItem.personality`.
- Consumes: existing `FieldRef`, `EmbeddedGraphConfig`, `createEmbeddedGraphItem`, and Fit Y by X project-load normalization.

- [ ] **Step 1: Extend the focused tests first**

Add assertions equivalent to:

```ts
const continuousX = { name: "temperature", type: "continuous" as const };

assert.equal(canAssignFitYByXRole("factor", continuousX), true);
assert.equal(deriveFitYByXPersonality(factor), "oneway");
assert.equal(deriveFitYByXPersonality(continuousX), "bivariate");

const bivariate = createFitYByXItem({
  id: "fit-bivariate",
  name: "Fit Y by X 2",
  sourceDatasetId: "table-1",
  response,
  factor: continuousX,
  createdAt,
});
assert.equal(bivariate.personality, "bivariate");
assert.deepEqual(bivariate.graph.modeStates.twoD.elements, [
  { kind: "points", enabled: true },
  {
    kind: "fitline",
    enabled: true,
    options: { fitType: "polynomial", degree: 1, showFitCI: true },
  },
]);
```

In the store test, load an old categorical-X item with no `personality` and
assert it becomes `oneway`. Load an item whose persisted personality conflicts
with X and assert X wins. Preserve a valid customized graph only when its X/Y
bindings and personality-specific element family are valid.

- [ ] **Step 2: Run tests to verify RED**

Bundle and run the three tests with the repository-local esbuild executable:

```powershell
.\node_modules\.bin\esbuild.cmd tests/fitYByXConfig.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=$env:TEMP\fitYByXConfig.mjs
node $env:TEMP\fitYByXConfig.mjs
.\node_modules\.bin\esbuild.cmd tests/fitYByXDialog.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=$env:TEMP\fitYByXDialog.mjs
node $env:TEMP\fitYByXDialog.mjs
.\node_modules\.bin\esbuild.cmd tests/fitYByXStore.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=$env:TEMP\fitYByXStore.mjs
node $env:TEMP\fitYByXStore.mjs
```

Expected: FAIL because continuous X is rejected and personality does not exist.

- [ ] **Step 3: Implement the personality contract**

Add:

```ts
export type FitYByXPersonality = "oneway" | "bivariate";

export function deriveFitYByXPersonality(factor: FieldRef): FitYByXPersonality {
  return factor.type === "continuous" ? "bivariate" : "oneway";
}
```

Allow `continuous | nominal | ordinal` for X, retain duplicate-column
rejection, add `personality` to `FitYByXItem`, and make the graph factory emit
the exact personality-specific elements from Step 1. In the role dialog, show
the derived personality beside the completed X assignment.

During project load, derive personality from X for both old and current items.
Only preserve a loaded graph when mode is 2D, X/Y still match, and it contains
the expected analysis element (`boxplot` for Oneway or `fitline` for
Bivariate); otherwise use the personality's default graph. Continue skipping
only `FitYByXRoleValidationError` items and rethrow unexpected errors.

- [ ] **Step 4: Run the three focused tests to verify GREEN**

Run the commands from Step 2. Expected: all three tests print their contract
success messages and exit 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/types/fitYByX.ts src/components/fitYByX/fitYByXRoles.ts src/components/fitYByX/fitYByXConfig.ts src/components/fitYByX/fitYByXDialogState.ts src/components/fitYByX/FitYByXRoleDialog.tsx src/stores/useFitYByXStore.ts tests/fitYByXConfig.test.ts tests/fitYByXDialog.test.ts tests/fitYByXStore.test.ts
git commit -m "feat(analysis): add Fit Y by X personalities"
```

---

### Task 2: Statistical Wire Models And Pure Numerical Engine

**Files:**
- Modify: `src-tauri/Cargo.toml` (`statrs = "0.19.1"`)
- Create: `src-tauri/src/models/fit_y_by_x.rs`
- Create: `src-tauri/src/engine/fit_y_by_x.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/engine/mod.rs`

**Interfaces:**
- Produces: `FitYByXRequest`, `FitYByXResult`, `OnewayResult`, `BivariateResult`, `NotComputableResult`, `FitYByXRow`, `calculate_oneway`, and `calculate_bivariate`.
- Consumes: `statrs::distribution::{ContinuousCDF, FisherSnedecor, StudentsT}` and pairwise-valid rows supplied by Task 3.

- [ ] **Step 1: Write pure Rust numerical tests before models compile**

In `src-tauri/src/engine/fit_y_by_x.rs`, add `#[cfg(test)]` tests using fixed
fixtures. Define a comparison helper only inside tests:

```rust
fn assert_close(actual: f64, expected: f64, tolerance: f64) {
    assert!((actual - expected).abs() <= tolerance,
        "actual={actual}, expected={expected}, tolerance={tolerance}");
}
```

Cover at least these fixtures:

```rust
// Perfectly separated Oneway groups.
let rows = vec![
    FitYByXRow::Oneway { y: 1.0, group: "A".into() },
    FitYByXRow::Oneway { y: 2.0, group: "A".into() },
    FitYByXRow::Oneway { y: 4.0, group: "B".into() },
    FitYByXRow::Oneway { y: 5.0, group: "B".into() },
];
// means 1.5 and 4.5; SS_between=9, SS_within=1, SS_total=10;
// df=(1,2,3); F=18; eta_squared=.9; omega_squared=.8095238095.

// Exact linear Bivariate rows.
let rows = vec![(1.0, 3.0), (2.0, 5.0), (3.0, 7.0), (4.0, 9.0)];
// intercept=1, slope=2, R2=1, model SS=20, error SS=0.
```

Also test a noisy non-perfect line for finite standard errors/p-values, a
replicated-X fixture for Lack of Fit decomposition, no-repeat X for
`notIdentifiable`, constant X, fewer than three Bivariate rows, fewer than two
Oneway groups, zero within-group degrees of freedom, and camelCase JSON tags.

- [ ] **Step 2: Run the module test to verify RED**

```powershell
Set-Location src-tauri
cargo test engine::fit_y_by_x::tests
```

Expected: FAIL because the module, types, and `statrs` dependency do not exist.

- [ ] **Step 3: Add the wire model as a discriminated union**

Use serde tagged enums so TypeScript can mirror them exactly:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FitYByXPersonality { Oneway, Bivariate }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitYByXRequest {
    pub dataset_id: String,
    pub response_column: String,
    pub factor_column: String,
    pub personality: FitYByXPersonality,
    pub confidence_level: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FitYByXResult {
    Oneway(OnewayResult),
    Bivariate(BivariateResult),
    NotComputable(NotComputableResult),
}
```

Define reusable `AnovaRow { source, degrees_of_freedom, sum_of_squares,
mean_square, f_ratio, p_value }` and `EstimateRow { term, estimate,
standard_error, t_ratio, p_value, lower_confidence_limit,
upper_confidence_limit }`. Oneway group labels remain strings. Every result
includes `used_rows`, `excluded_rows`, and `confidence_level`.

- [ ] **Step 4: Implement pure calculations**

Keep calculation code independent of DuckDB and Tauri. Use numerically stable
centered sums for OLS and sums of squares. Compute upper-tail probabilities
with the distributions' survival functions and clamp floating-point tails to
`[0, 1]`. Use
`StudentsT` for parameter/group confidence intervals and `FisherSnedecor` for
ANOVA and Lack of Fit.

Return stable reasons:

```rust
pub enum FitYByXNotComputableReason {
    InsufficientValidRows,
    InsufficientGroups,
    ConstantFactor,
    NoResidualDegreesOfFreedom,
    NoWithinGroupDegreesOfFreedom,
}
```

Lack of Fit is a nested state tagged as `available` or `notIdentifiable`; do
not turn no-repeat X into a failed whole analysis.

- [ ] **Step 5: Run numerical and serialization tests to verify GREEN**

```powershell
cargo test engine::fit_y_by_x::tests
cargo test models::fit_y_by_x::tests
```

Expected: all numerical identities and camelCase serialization tests pass.

- [ ] **Step 6: Commit Task 2 without staging unrelated schema files**

First inspect the existing Cargo diff and retain all user changes while adding
`statrs`:

```powershell
git diff -- src-tauri/Cargo.toml
git add -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/models/fit_y_by_x.rs src-tauri/src/models/mod.rs src-tauri/src/engine/fit_y_by_x.rs src-tauri/src/engine/mod.rs
git commit -m "feat(stats): calculate Fit Y by X results"
```

---

### Task 3: Validated Full-Data Query And Tauri IPC

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Create: `src-tauri/src/services/fit_y_by_x_service.rs`
- Create: `src-tauri/src/commands/fit_y_by_x_commands.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models/fit_y_by_x.rs`

**Interfaces:**
- Produces: `DuckDbEngine::read_fit_y_by_x_rows`, `FitYByXService::run`, and Tauri command `fit_y_by_x`.
- Consumes: Task 2 request/result types and pure calculators.

- [ ] **Step 1: Write service and command tests first**

Add service tests that create datasets through existing test helpers and assert:

```rust
let result = FitYByXService::new(&state).run(FitYByXRequest {
    dataset_id: dataset.id.clone(),
    generation: 0,
    response_column: "height".into(),
    factor_column: "site".into(),
    personality: FitYByXPersonality::Oneway,
    confidence_level: 0.95,
})?;
assert!(matches!(result, FitYByXResult::Oneway(_)));
```

Cover pairwise null exclusion and exact `usedRows`/`excludedRows`, stale
generation, unknown
dataset, unknown column, same column for X/Y, Oneway requested for numeric
continuous X, Bivariate requested for categorical X, and confidence levels
outside `(0, 1)`.

Add a command serialization test that asserts request/response camelCase and
the `kind` discriminant.

- [ ] **Step 2: Run tests to verify RED**

```powershell
Set-Location src-tauri
cargo test services::fit_y_by_x_service::tests
cargo test commands::fit_y_by_x_commands::tests
```

Expected: FAIL because service, command, and engine read API do not exist.

- [ ] **Step 3: Implement the narrow DuckDB read boundary**

Add a method that returns rows plus source count, not statistics:

```rust
pub fn read_fit_y_by_x_rows(
    &self,
    dataset_id: &str,
    response_column: &str,
    factor_column: &str,
    personality: FitYByXPersonality,
) -> Result<FitYByXRows, AppError>
```

Implementation order is mandatory:

1. call `get_dataset_meta(dataset_id)`;
2. call `get_user_columns(dataset_id)` and locate both exact names;
3. reject equal columns and require numeric Y plus numeric X for Bivariate;
4. derive the internal table name from the validated dataset ID;
5. quote the two validated identifiers with `quote_identifier`;
6. execute one read-only `SELECT` and convert DuckDB `Value`s without panic;
7. count every source row and exclude a row unless both requested values are
   usable for the selected personality.

For Oneway, convert X to its display string and Y to finite `f64`. For
Bivariate, convert both to finite `f64`. Keep SQL free of user-provided values;
all metadata lookups remain parameterized.

- [ ] **Step 4: Implement service dispatch and registration**

`FitYByXService::run` validates confidence level and personality, locks the DB
with `AppError::Database` mapping, compares `request.generation` with
`get_dataset_generation` while holding that lock, calls
`read_fit_y_by_x_rows`, then dispatches to `calculate_oneway` or
`calculate_bivariate`.

The command is only:

```rust
#[tauri::command]
pub fn fit_y_by_x(
    state: State<'_, AppState>,
    request: FitYByXRequest,
) -> Result<FitYByXResult, AppError> {
    FitYByXService::new(&state).run(request)
}
```

Export all modules and add
`commands::fit_y_by_x_commands::fit_y_by_x` to
`tauri::generate_handler![...]`.

- [ ] **Step 5: Run service, command, and full backend tests**

```powershell
cargo test services::fit_y_by_x_service::tests
cargo test commands::fit_y_by_x_commands::tests
cargo test
```

Expected: all focused and existing backend tests pass.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/fit_y_by_x_service.rs src-tauri/src/services/mod.rs src-tauri/src/commands/fit_y_by_x_commands.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/models/fit_y_by_x.rs
git commit -m "feat(stats): expose Fit Y by X analysis"
```

---

### Task 4: TypeScript IPC Contract And Generation-Fenced Report State

**Files:**
- Modify: `src/types/fitYByX.ts`
- Modify: `src/types/index.ts`
- Create: `src/services/fitYByXService.ts`
- Modify: `src/services/index.ts`
- Create: `src/components/fitYByX/useFitYByXReport.ts`
- Create: `tests/fitYByXReportState.test.ts`

**Interfaces:**
- Produces: mirrored result union, `fitYByXService.run(request)`, `FitYByXReportState`, `loadFitYByXReport`, and `useFitYByXReport`.
- Consumes: Task 1 personalities, Task 3 command, `dataService.getDatasetGeneration`.

- [ ] **Step 1: Write the report-state contract test first**

Keep the state machine pure enough to test without React or Tauri. The test
uses deferred promises and asserts:

```ts
const first = deferred<FitYByXResult>();
const second = deferred<FitYByXResult>();
const controller = createFitYByXReportController(fakeDependencies);

controller.load(firstItem, 4);
controller.load(secondItem, 4);
second.resolve(secondResult);
await controller.settled();
assert.deepEqual(controller.getState().result, secondResult);
first.resolve(firstResult);
await controller.settled();
assert.deepEqual(controller.getState().result, secondResult);
```

Also assert loading, IPC error, unmount/cancel, and reload when dataset
generation changes. Graph errors are absent from this state by design.

- [ ] **Step 2: Run the test to verify RED**

```powershell
.\node_modules\.bin\esbuild.cmd tests/fitYByXReportState.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=$env:TEMP\fitYByXReportState.mjs
node $env:TEMP\fitYByXReportState.mjs
```

Expected: FAIL because report types, service, and controller do not exist.

- [ ] **Step 3: Mirror Rust types and add the service wrapper**

Define the exact discriminated union from Task 2 in `src/types/fitYByX.ts`.
Use `number | null` only where Rust uses `Option<f64>`. Add:

```ts
export const fitYByXService = {
  run: (request: FitYByXRequest) =>
    invoke<FitYByXResult>("fit_y_by_x", { request }),
};
```

- [ ] **Step 4: Implement fenced loading**

The hook obtains dataset generation before invoking analysis and includes it in
the request. Fence every
completion by monotonically increasing request token plus item ID, dataset ID,
and generation. Abort means ignoring completion; the Tauri call itself need
not be cancellable. Expose:

```ts
type FitYByXReportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: FitYByXResult }
  | { status: "error"; message: string };
```

The request always sends `confidenceLevel: 0.95`.

- [ ] **Step 5: Run report-state and TypeScript tests to verify GREEN**

```powershell
node $env:TEMP\fitYByXReportState.mjs
.\node_modules\.bin\tsc.cmd -b
```

Expected: contract test and TypeScript build pass.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- src/types/fitYByX.ts src/types/index.ts src/services/fitYByXService.ts src/services/index.ts src/components/fitYByX/useFitYByXReport.ts tests/fitYByXReportState.test.ts
git commit -m "feat(analysis): load Fit Y by X reports"
```

---

### Task 5: JMP-Inspired Report Components And Analysis Layout

**Files:**
- Create: `src/components/fitYByX/FitYByXReport.tsx`
- Modify: `src/components/fitYByX/FitYByXView.tsx`
- Modify: `src/components/fitYByX/index.ts`
- Modify: `src/App.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Create: `tests/fitYByXReport.test.ts`
- Modify: `tests/graphRuntime.test.ts`
- Modify: `tests/workspaceFitYByX.test.ts`

**Interfaces:**
- Produces: `FitYByXReport`, numeric formatting helpers, disclosure sections, and the complete scrollable analysis view.
- Consumes: Task 4 report state/result union and existing `GraphRuntime`.

- [ ] **Step 1: Write presentation contract tests first**

The report test passes fixed Oneway, Bivariate, and NotComputable values to pure
view-model helpers. Assert section order and formatted values, including:

```ts
assert.deepEqual(buildBivariateSections(result).map((section) => section.id), [
  "summaryOfFit",
  "lackOfFit",
  "analysisOfVariance",
  "parameterEstimates",
]);
assert.equal(formatStatistic(0.123456), "0.123456");
assert.equal(formatPValue(0.00001), "<0.0001");
assert.equal(formatStatistic(null), "—");
```

Add source-contract assertions that `FitYByXView` mounts both `GraphRuntime`
and `FitYByXReport`, and that the graph shell is bounded rather than consuming
the full content height.

- [ ] **Step 2: Run the frontend tests to verify RED**

```powershell
.\node_modules\.bin\esbuild.cmd tests/fitYByXReport.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=$env:TEMP\fitYByXReport.mjs
node $env:TEMP\fitYByXReport.mjs
.\node_modules\.bin\esbuild.cmd tests/workspaceFitYByX.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=$env:TEMP\workspaceFitYByX.mjs
node $env:TEMP\workspaceFitYByX.mjs
```

Expected: FAIL because report components and bounded layout do not exist.

- [ ] **Step 3: Build compact report sections**

Use semantic `<details>`/`<summary>` disclosure sections, `<table>` with
caption or accessible heading association, and right-aligned numeric cells.
Default all core sections open. Do not put cards inside cards. Use stable
formatting: six significant decimal places for general values, four decimals
for common p-values, `<0.0001` for smaller positive p-values, and an em dash for
undefined fields.

Oneway order:

1. Group Summary;
2. Analysis of Variance;
3. Effect Size.

Bivariate order:

1. fitted equation and Summary of Fit;
2. Lack of Fit;
3. Analysis of Variance;
4. Parameter Estimates.

For `notComputable`, show the localized reason and row counts. For
`lackOfFit.kind === "notIdentifiable"`, keep the section visible with a short
localized explanation.

- [ ] **Step 4: Integrate independent graph and report states**

`FitYByXView` calls `useFitYByXReport(item, dataset)` and renders the report
after the graph panel. Keep `GraphRuntime` unchanged. Add personality to the
header summary. The analysis root owns vertical scrolling; graph height uses a
responsive bounded value such as `clamp(320px, 52vh, 620px)` so the next
section remains discoverable. On narrow screens, tables scroll horizontally
within their section and do not resize the page.

- [ ] **Step 5: Add all locale keys**

Add equivalent keys under `fitYByX` for personality names, loading/error text,
section headings, table columns, ANOVA source labels, parameter terms, effect
sizes, row counts, and every not-computable reason. Do not leave English
fallbacks in non-English locale files.

- [ ] **Step 6: Run focused UI contracts and production build**

```powershell
node $env:TEMP\fitYByXReport.mjs
node $env:TEMP\workspaceFitYByX.mjs
.\node_modules\.bin\esbuild.cmd tests/graphRuntime.test.ts --bundle --platform=node --format=esm --packages=external --alias:@=./src --outfile=$env:TEMP\graphRuntime.mjs
node $env:TEMP\graphRuntime.mjs
.\node_modules\.bin\tsc.cmd -b
.\node_modules\.bin\vite.cmd build
```

Expected: all contracts, type checking, and Vite build pass.

- [ ] **Step 7: Commit Task 5**

```powershell
git add -- src/components/fitYByX/FitYByXReport.tsx src/components/fitYByX/FitYByXView.tsx src/components/fitYByX/index.ts src/App.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/fitYByXReport.test.ts tests/graphRuntime.test.ts tests/workspaceFitYByX.test.ts
git commit -m "feat(analysis): render Fit Y by X reports"
```

---

### Task 6: Persistence, Cross-Layer Regression, And Native Validation

**Files:**
- Modify: `tests/fitYByXStore.test.ts`
- Modify: `tests/graphDataPipeline.test.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Produces: verified backward-compatible save/reopen and end-to-end behavior.
- Consumes: all prior tasks.

- [ ] **Step 1: Add cross-layer regression cases first**

Assert that:

- an old item without personality reopens as Oneway;
- a Bivariate item saves and reopens with personality and Fit Line config;
- a malformed Bivariate graph falls back to Points + Fit Line;
- graph request derivation for Bivariate uses continuous X/Y and full sampling;
- save/reopen never stores computed `FitYByXResult`;
- rapid document switching leaves the second report visible when the first
  request resolves last.

- [ ] **Step 2: Run focused tests and verify any new case is RED before repair**

Bundle each modified TypeScript test with the same esbuild flags used above;
run the narrow Rust persistence test with
`cargo test services::spprj_archive::tests`.
Expected: any uncovered persistence or normalization behavior fails for its
specific missing contract, not because of browser globals.

- [ ] **Step 3: Apply only the minimal cross-layer repairs**

Keep result data out of `FitYByXItem` and Rust project manifest models. Repair
only serialization, normalizers, or request derivation required by the RED
cases. Do not duplicate report output in project JSON.

- [ ] **Step 4: Run the complete verification matrix**

Frontend focused tests:

```powershell
$tests = @(
  "fitYByXConfig", "fitYByXDialog", "fitYByXStore",
  "fitYByXReport", "fitYByXReportState", "graphRuntime",
  "graphDataPipeline", "workspaceFitYByX", "useProjectStore.saveLifecycle"
)
foreach ($name in $tests) {
  $out = Join-Path $env:TEMP "$name.mjs"
  .\node_modules\.bin\esbuild.cmd "tests/$name.test.ts" --bundle --platform=node --format=esm --packages=external --alias:@=./src "--outfile=$out"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  node $out
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Remove-Item $out -Force
}
.\node_modules\.bin\tsc.cmd -b
.\node_modules\.bin\vite.cmd build
```

Backend:

```powershell
Set-Location src-tauri
cargo fmt -- --check
cargo test
cargo clippy -- -D warnings
```

Expected: every command exits 0. A Vite chunk-size warning is informational,
not a failed build.

- [ ] **Step 5: Run native acceptance checks**

Start from the Issue 71 worktree:

```powershell
Set-Location C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-issue-71
npm run tauri -- dev
```

Manually verify:

1. categorical X creates Oneway, shows Points + Box Plot, group summaries,
   ANOVA, and effect sizes;
2. continuous X creates Bivariate, shows scatter + linear fit and confidence
   band, equation, Summary of Fit, Lack of Fit state, ANOVA, and estimates;
3. report and graph loading/errors remain independent;
4. switching quickly between analyses does not show stale results;
5. save, close, and reopen preserves both definitions and recomputes reports;
6. the first report heading is visible below the bounded graph at the current
   desktop viewport and tables remain usable at narrow width.

- [ ] **Step 6: Request final scoped review**

Ask a reviewer to inspect numerical correctness, degrees of freedom, tail
probabilities, serde/TS parity, query validation, stale-result fencing,
backward compatibility, and the absence of computed results in persistence.
Resolve findings with a focused RED/GREEN cycle.

- [ ] **Step 7: Commit final regression repairs**

```powershell
git add -- tests/fitYByXStore.test.ts tests/graphDataPipeline.test.ts tests/useProjectStore.saveLifecycle.test.ts src-tauri/src/services/spprj_archive.rs
git commit -m "test(analysis): cover Fit Y by X reports end to end"
```

Do not include unrelated generated schema or manifest changes unless they are
demonstrably produced by and required for the registered command.