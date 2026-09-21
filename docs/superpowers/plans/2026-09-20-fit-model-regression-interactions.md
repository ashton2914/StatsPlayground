# Fit Model Regression Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Fit Model regression report order, Type III effect tests, JMP-style selectable leverage plots, graphical effect management, and a compact linked Prediction Profiler.

**Architecture:** Rust extends the existing fitted result with effect-level inferential and leverage payloads computed from the same full-model design matrix. React continues to consume the native Analysis document lifecycle, while focused Effect Summary and Leverage Plot components compose shared Analysis primitives and ECharts options from `graphCore`. Profiler linkage remains transient presentation state and shares one computed Y display domain across all predictor cards.

**Tech Stack:** Rust, nalgebra, statrs, Tauri v2 IPC contracts, TypeScript 5.7, React 19, Zustand-backed Analysis lifecycle, ECharts, Playwright component testing.

**Spec:** `docs/superpowers/specs/2026-09-20-fit-model-regression-interactions-design.md`

## Global Constraints

- Work on `feat/fit-model-regression-interactions`; do not push unless requested.
- Rust remains the statistical authority; frontend code must not recompute effect tests or leverage statistics.
- Rust commands and services continue to return `Result<T, AppError>` without `unwrap()` or `expect()` in non-test code.
- Rust result models use `#[serde(rename_all = "camelCase")]`; TypeScript mirrors fields exactly.
- Preserve Analysis kind/document/dataset/request stale fencing and synchronous stale-result masking.
- Fit Model remains continuous-response and continuous-predictor only.
- Effect Add uses the existing Fit Model editor and revisioned definition update path.
- Residual Q-Q data remains contract-compatible but is not rendered.
- New report structure directly composes shared Analysis presentation primitives.
- No new runtime dependencies are required.

---

## File Structure

### New files

- `src-tauri/src/engine/fit_model/effects.rs` — Type III effect tests and JMP-style partial-regression leverage payload computation.
- `src/components/fitModel/FitModelEffectSummary.tsx` — effect table, LogWorth chart, Add, Remove, and Undo surface.
- `src/components/fitModel/FitModelLeveragePlot.tsx` — selected-effect state, selector fallback, non-estimable state, and one leverage chart.

### Modified backend files

- `src-tauri/src/engine/fit_model.rs` — register the new `effects` module.
- `src-tauri/src/models/fit_model.rs` — add effect-test and leverage result contracts.
- `src-tauri/src/engine/fit_model/ols.rs` — call the effect computations once the full model fit is available and attach results.

### Modified frontend files

- `src/types/fitModel.ts` — mirror the Rust contract.
- `src/components/fitModel/fitModelReportModel.ts` — effect sorting/default-selection helpers.
- `src/components/fitModel/FitModelProfiler.tsx` — shared scans, shared Y domain, and compact horizontal card track.
- `src/components/fitModel/fitModel.css` — effect/leverage sizing, wider residual plot, and compact profiler track.
- `src/components/fitModel/index.ts` — export new focused components/helpers where needed by tests.
- `src/components/analysis/renderers/FitModelAnalysisReport.tsx` — approved block order, summary rows, hidden Q-Q, and focused component composition.
- `src/components/analysis/renderers/FitModelAnalysisResults.tsx` — pass existing edit-input action to Effect Summary Add.
- `src/graphCore/fitModelAdapter.ts` — Effect Summary, leverage, and shared-domain profiler chart options.
- `src/i18n/locales/en.json`, `zh-CN.json`, `zh-TW.json`, `vi.json` — exact locale parity for new controls, tables, axes, and reasons.

### Modified tests

- `tests/fitModelReport.test.ts`
- `tests/fitModelGraphAdapter.test.ts`
- `tests/fitModelProfiler.test.ts`
- `tests/fitModelLocaleParity.test.ts`
- `tests/workspaceFitModel.test.ts`
- `tests/e2e/FitModelReport.spec.tsx`
- `tests/e2e/FitModelProfiler.spec.tsx`
- backend unit tests colocated in `src-tauri/src/engine/fit_model/effects.rs`, `ols.rs`, and `models/fit_model.rs`

---

### Task 1: Add the cross-language effect result contract

**Files:**
- Modify: `src-tauri/src/models/fit_model.rs:120-330`
- Modify: `src/types/fitModel.ts:90-255`
- Modify: `tests/fitModelReport.test.ts:100-360`
- Modify: `tests/e2e/FitModelReport.spec.tsx:20-135`
- Modify: backend serialization tests in `src-tauri/src/models/fit_model.rs:330-499`

**Interfaces:**
- Produces: `FitModelEffectTest`, `FitModelLeveragePoint`, `FitModelLeverageBandPoint`, `FitModelLeveragePlot`, `effectTests`, and `leveragePlots`.
- Consumes: existing `FitModelInferenceReason` and `FitModelFittedResult`.

- [ ] **Step 1: Write failing Rust serialization coverage**

Add a fitted-result fixture with one effect test and one leverage payload, then assert exact camelCase keys:

```rust
assert_eq!(value["effectTests"][0]["termId"], "A");
assert_eq!(value["effectTests"][0]["numberOfParameters"], 1);
assert_eq!(value["leveragePlots"][0]["points"][0]["rowIndex"], 7);
assert_eq!(value["leveragePlots"][0]["confidenceBand"][0]["lower"], 9.5);
assert_eq!(value["leveragePlots"][0]["nullLineY"], 10.0);
```

- [ ] **Step 2: Run the model test and confirm the contract is absent**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml models::fit_model::tests::fit_model_result_serializes_variant_kind_tags -- --nocapture
```

Expected: FAIL because `effect_tests` and `leverage_plots` do not exist.

- [ ] **Step 3: Add exact Rust and TypeScript types**

Use these public shapes:

```rust
pub struct FitModelEffectTest {
    pub term_id: String,
    pub term_label: String,
    pub number_of_parameters: u64,
    pub degrees_of_freedom: u64,
    pub sum_of_squares: Option<f64>,
    pub f_ratio: Option<f64>,
    pub p_value: Option<f64>,
    pub reason: Option<FitModelInferenceReason>,
}

pub struct FitModelLeveragePoint {
    pub row_index: u64,
    pub effect_leverage: f64,
    pub adjusted_response: f64,
}

pub struct FitModelLeverageBandPoint {
    pub effect_leverage: f64,
    pub fitted: f64,
    pub lower: f64,
    pub upper: f64,
}

pub struct FitModelLeveragePlot {
    pub term_id: String,
    pub term_label: String,
    pub p_value: Option<f64>,
    pub points: Vec<FitModelLeveragePoint>,
    pub confidence_band: Vec<FitModelLeverageBandPoint>,
    pub null_line_y: Option<f64>,
    pub rows_sampled: bool,
    pub source_row_count: u64,
    pub reason: Option<FitModelInferenceReason>,
}
```

Add `effect_tests: Vec<FitModelEffectTest>` and
`leverage_plots: Vec<FitModelLeveragePlot>` to `FitModelFittedResult`. Mirror
the exact names and nullability in TypeScript. Update every fitted-result test
fixture with empty arrays until later tasks provide populated data.

- [ ] **Step 4: Run contract-focused tests**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml models::fit_model -- --nocapture
npx tsx --tsconfig tsconfig.app.json tests\fitModelReport.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```powershell
git add src-tauri\src\models\fit_model.rs src\types\fitModel.ts tests
git commit -m "feat(fit-model): add effect result contracts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Compute Type III effect tests in Rust

**Files:**
- Create: `src-tauri/src/engine/fit_model/effects.rs`
- Modify: `src-tauri/src/engine/fit_model.rs:1-8`
- Modify: `src-tauri/src/engine/fit_model/ols.rs:160-390`

**Interfaces:**
- Consumes: full design matrix, response vector, resolved terms, full-model SSE/MSE, and error degrees of freedom.
- Produces:

```rust
pub(crate) fn compute_effect_tests(
    design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    terms: &[FitModelResolvedTerm],
    full_sse: f64,
    full_mse: Option<f64>,
    error_degrees_of_freedom: u64,
) -> Result<Vec<FitModelEffectTest>, FitModelEngineError>
```

- [ ] **Step 1: Write hand-computable failing tests**

In `effects.rs`, add tests for:

```rust
#[test]
fn type_three_effect_tests_match_reduced_model_sse() { /* Y = 1 + 2A + 3B + 4AB */ }

#[test]
fn type_three_tests_are_invariant_to_term_order() { /* swap A and B columns */ }

#[test]
fn effect_test_marks_inference_unavailable_without_error_df() { /* df_error = 0 */ }
```

Assert term IDs, `number_of_parameters`, rank-difference DF, partial SS, F, and
p-value to a `1e-9` tolerance. Compute expected partial SS in the test from an
explicit reduced matrix, not by calling the production helper.

- [ ] **Step 2: Run the new test module and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml engine::fit_model::effects::tests::type_three -- --nocapture
```

Expected: FAIL because the module/function is not implemented.

- [ ] **Step 3: Implement reduced-model comparisons**

For each term, remove its design-column group while retaining the intercept and
all other effects. Solve the reduced model with SVD using the same rank
tolerance policy as OLS. Compute:

```rust
let partial_ss = clamp_roundoff_negative(reduced_sse - full_sse, tolerance, "partial SS")?;
let effect_df = reduced_rank.abs_diff(full_rank) as u64;
let f_ratio = match (full_mse, effect_df, error_degrees_of_freedom) {
    (Some(mse), df, error_df) if mse > 0.0 && df > 0 && error_df > 0 =>
        Some((partial_ss / df as f64) / mse),
    _ => None,
};
```

Return `InferenceNotEstimable` when the full-model MSE/DF cannot support the F
test. Preserve one output row per resolved effect and source order.

- [ ] **Step 4: Integrate with the full fitted result**

Call `compute_effect_tests` in `fit_linear_model_with_diagnostics` after SSE,
MSE, and resolved terms are available. Attach the result to `effect_tests`.
Leave `leverage_plots` empty until Task 3.

- [ ] **Step 5: Run Rust Fit Model tests**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml engine::fit_model::effects -- --nocapture
cargo test --manifest-path src-tauri\Cargo.toml engine::fit_model::ols -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit Type III tests**

```powershell
git add src-tauri\src\engine\fit_model.rs src-tauri\src\engine\fit_model\effects.rs src-tauri\src\engine\fit_model\ols.rs
git commit -m "feat(stats): add Type III fit model effect tests" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Compute bounded JMP-style leverage payloads

**Files:**
- Modify: `src-tauri/src/engine/fit_model/effects.rs`
- Modify: `src-tauri/src/engine/fit_model/ols.rs:300-390`

**Interfaces:**
- Consumes: full design matrix, response, row IDs, resolved terms, effect tests, full MSE, error DF, and confidence level.
- Produces:

```rust
pub(crate) fn compute_effect_leverage_plots(
    design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    row_indexes: &[u64],
    terms: &[FitModelResolvedTerm],
    effect_tests: &[FitModelEffectTest],
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
) -> Result<Vec<FitModelLeveragePlot>, FitModelEngineError>
```

- [ ] **Step 1: Write failing projection and sampling tests**

Use an explicit interaction fixture and independently form the nuisance
projection `M_Z = I - Z Z+`. Assert for effect `A`:

```rust
assert_close(point.effect_leverage, effect_mean + residualized_x[row]);
assert_close(point.adjusted_response, response_mean + residualized_y[row]);
assert_close(band.fitted, response_mean + beta_effect * (band.effect_leverage - effect_mean));
assert_close(plot.null_line_y.expect("null line"), response_mean);
```

Also assert stable row IDs, sorted band X values, finite bounds, and identical
sampled row IDs over two calls. Add an inference-unavailable case that keeps the
effect payload but supplies `reason` and no confidence band.

- [ ] **Step 2: Run leverage tests and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml engine::fit_model::effects::tests::leverage -- --nocapture
```

Expected: FAIL because leverage computation is absent.

- [ ] **Step 3: Implement partial-regression geometry**

For each current one-column continuous effect:

1. Build nuisance matrix `Z` from intercept plus every non-selected effect.
2. Residualize selected column and response against `Z` using SVD projection.
3. Shift residualized X by the selected feature mean and residualized Y by the
   response mean for JMP-style readable axes.
4. Fit the selected partial slope and generate a sorted confidence band using
   Student's t at the fitted model confidence level.
5. Set the null-effect line to response mean.
6. Apply the same deterministic rank-grid scatter budget used by Fit Model
   diagnostics.

If a future effect maps to more than one design column, return the effect with
`InferenceNotEstimable` rather than silently selecting one column.

- [ ] **Step 4: Attach leverage plots to the fitted result**

Invoke the helper after `effect_tests` and attach every returned effect payload
to `leverage_plots`. Ensure point and band values pass finite checks before
serialization.

- [ ] **Step 5: Run backend regression tests**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml engine::fit_model -- --nocapture
cargo test --manifest-path src-tauri\Cargo.toml services::fit_model_service -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit leverage statistics**

```powershell
git add src-tauri\src\engine\fit_model\effects.rs src-tauri\src\engine\fit_model\ols.rs
git commit -m "feat(stats): add fit model leverage diagnostics" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Add effect and leverage chart adapters

**Files:**
- Modify: `src/graphCore/fitModelAdapter.ts:1-500`
- Modify: `tests/fitModelGraphAdapter.test.ts:1-346`
- Modify: `src/components/fitModel/fitModelReportModel.ts:1-240`
- Modify: `tests/fitModelReport.test.ts:1-787`

**Interfaces:**
- Produces:

```ts
buildEffectSummaryOption(input: FitModelEffectSummaryChartInput): EChartsOption
buildFitModelLeverageOption(input: FitModelLeverageChartInput): EChartsOption
selectDefaultLeverageTermId(effectTests: readonly FitModelEffectTest[]): string | null
reconcileLeverageTermId(current: string | null, plots: readonly FitModelLeveragePlot[]): string | null
```

- [ ] **Step 1: Write failing adapter/model tests**

Assert that Effect Summary emits one horizontal bar per sorted effect and a
p=0.05 reference line, and that Leverage Plot emits point, fitted-line,
confidence-band, and null-line series without `NaN`/`Infinity`.

Assert selector rules:

```ts
assert.equal(selectDefaultLeverageTermId(effectTests), "interaction:A*B");
assert.equal(reconcileLeverageTermId("removed", plots), "interaction:A*B");
assert.equal(reconcileLeverageTermId("A", plots), "A");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelGraphAdapter.test.ts
npx tsx --tsconfig tsconfig.app.json tests\fitModelReport.test.ts
```

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement ECharts options and selection helpers**

Reuse `baseOption`, `getGraphTheme`, finite guards, clipped series, and existing
tooltip formatting. Build confidence bands with the same stacked lower-plus-
width pattern used by the profiler. Keep effect order identical to the report
model's sorted rows.

- [ ] **Step 4: Run focused tests**

Run the two commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit chart models**

```powershell
git add src\graphCore\fitModelAdapter.ts src\components\fitModel\fitModelReportModel.ts tests\fitModelGraphAdapter.test.ts tests\fitModelReport.test.ts
git commit -m "feat(graph): add fit model effect charts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Rebuild the report order and effect interactions

**Files:**
- Create: `src/components/fitModel/FitModelEffectSummary.tsx`
- Create: `src/components/fitModel/FitModelLeveragePlot.tsx`
- Modify: `src/components/fitModel/index.ts`
- Modify: `src/components/analysis/renderers/FitModelAnalysisReport.tsx:1-464`
- Modify: `src/components/analysis/renderers/FitModelAnalysisResults.tsx:25-185`
- Modify: `src/components/fitModel/fitModel.css:120-270`
- Modify: `tests/fitModelReport.test.ts`
- Modify: `tests/workspaceFitModel.test.ts`
- Modify: `tests/e2e/FitModelReport.spec.tsx`

**Interfaces:**
- `FitModelEffectSummary` consumes effects plus `onAddEffect`, `onRemoveTerm`, and `onUndoRemove`.
- `FitModelLeveragePlot` consumes `effectTests`, `leveragePlots`, response label, and localized chart labels.
- `FitModelAnalysisReport` adds `onAddEffect?: () => void`.
- `FitModelAnalysisResults` passes `onEditInputs` only when `canEditInputs` is true.

- [ ] **Step 1: Write failing structure and interaction tests**

In the Playwright report test, assert the button order by
`data-analysis-block`/accessible headings:

```ts
expect(sectionTitles).toEqual([
  "Model Specification",
  "Actual by Predicted",
  "Effect Summary",
  "Lack of Fit",
  "Residual by Predicted",
  "Summary of Fit",
  "Analysis of Variance",
  "Parameter Estimates",
  "Effect Tests",
  "Leverage Plot",
  "Row Diagnostics",
  "Prediction Profiler",
  "Warnings",
]);
```

Also assert:

- no Residual Q-Q button, graph, or placeholder;
- Mean of Response and Observations rows;
- Add invokes the passed callback;
- Remove still invokes the selected term ID;
- leverage selector changes the single chart;
- residual chart desktop width exceeds 680px and stays within its frame.

- [ ] **Step 2: Run report tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelReport.test.ts
npx playwright test -c playwright-ct.config.ts tests\e2e\FitModelReport.spec.tsx
```

Expected: FAIL on old order, Q-Q presence, and missing effect controls.

- [ ] **Step 3: Implement focused components**

`FitModelEffectSummary.tsx` must compose `AnalysisFrame`,
`AnalysisTable`, `AnalysisButton`, `AnalysisGraph`, and `AnalysisStack`.
Render Add and Undo at frame level and Remove as table row actions.

`FitModelLeveragePlot.tsx` keeps only `selectedTermId` in local state and uses
`reconcileLeverageTermId` in an effect when result identity changes. Render a
native `<select>` because this is an input control, one `AnalysisGraph`, or an
`AnalysisText` non-estimable reason.

- [ ] **Step 4: Reorder and complete the report**

Remove all Q-Q option construction/imports/rendering. Recompose the approved
order and add:

```tsx
row("meanOfResponse", [
  t("fitModel.report.summaryOfFit.meanOfResponse"),
  formatFitModelReportValue(fittedResult.summaryOfFit.meanOfResponse),
]),
row("observations", [
  t("fitModel.report.summaryOfFit.observations"),
  fittedResult.summaryOfFit.observationCount,
]),
```

Render Effect Tests columns Source, Nparm, DF, Sum of Squares, F Ratio, and
Prob > F. Set the residual frame class to a new wider rule such as
`width: min(100%, 820px)`.

- [ ] **Step 5: Wire Add to the existing editor**

Pass:

```tsx
onAddEffect={canEditInputs ? onEditInputs : undefined}
```

Do not add another dialog or model draft inside the report.

- [ ] **Step 6: Run report, workspace, and component tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelReport.test.ts
npx tsx --tsconfig tsconfig.app.json tests\workspaceFitModel.test.ts
npx playwright test -c playwright-ct.config.ts tests\e2e\FitModelReport.spec.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit the report**

```powershell
git add src\components\fitModel src\components\analysis\renderers\FitModelAnalysisReport.tsx src\components\analysis\renderers\FitModelAnalysisResults.tsx tests
git commit -m "feat(fit-model): enhance regression report interactions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Build the compact linked Prediction Profiler

**Files:**
- Modify: `src/components/fitModel/FitModelProfiler.tsx:1-145`
- Modify: `src/components/fitModel/fitModelPrediction.ts`
- Modify: `src/graphCore/fitModelAdapter.ts:360-478`
- Modify: `src/components/fitModel/fitModel.css:136-275`
- Modify: `tests/fitModelProfiler.test.ts`
- Modify: `tests/fitModelGraphAdapter.test.ts`
- Modify: `tests/e2e/FitModelProfiler.spec.tsx`

**Interfaces:**
- Produces:

```ts
export interface FitModelProfilerDomain { min: number; max: number }
export function fitModelProfilerYDomain(
  scans: readonly FitModelProfilerPoint[][],
): FitModelProfilerDomain
```

- `buildFitModelProfilerOption` adds `yDomain: FitModelProfilerDomain`.

- [ ] **Step 1: Write failing shared-domain tests**

Cover predicted values, both confidence bounds, equal-value expansion, and
non-finite rejection:

```ts
assert.deepEqual(fitModelProfilerYDomain(scans), { min: 8.8, max: 15.2 });
assert.throws(() => fitModelProfilerYDomain([[badPoint]]), /non-finite/i);
```

In Playwright, change predictor A and assert both A and B option snapshots or
canvas-visible markers update, while their Y-axis min/max remain equal.

- [ ] **Step 2: Run profiler tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelProfiler.test.ts
npx tsx --tsconfig tsconfig.app.json tests\fitModelGraphAdapter.test.ts
npx playwright test -c playwright-ct.config.ts tests\e2e\FitModelProfiler.spec.tsx
```

Expected: FAIL because options do not accept a shared domain and layout is a
wrapping grid.

- [ ] **Step 3: Compute all scans before rendering cards**

In `FitModelProfiler`, derive a memoized array:

```ts
const scans = snapshot.predictorRanges.map((range) => ({
  range,
  points: scanFitModelPredictor(snapshot, effectiveScanValues, range.columnName),
}));
const yDomain = fitModelProfilerYDomain(scans.map((scan) => scan.points));
```

Pass the same `yDomain` to every chart. Keep current values, deferred scan
values, and summary prediction in their existing linked state path.

- [ ] **Step 4: Implement the compact horizontal track**

Replace the auto-fit wrapping grid with:

```css
.sp-fit-model-profiler-track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: clamp(280px, 32vw, 380px);
  gap: 10px;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scroll-snap-type: inline proximity;
}
```

Give cards `scroll-snap-align: start`, reduce profiler chart height to the
approved compact range, and keep the result strip outside the scrolling track.

- [ ] **Step 5: Run profiler acceptance tests**

Run the commands from Step 2.

Expected: PASS at 1280x800 and 390x844 with no page-level overflow.

- [ ] **Step 6: Commit profiler linkage**

```powershell
git add src\components\fitModel\FitModelProfiler.tsx src\components\fitModel\fitModelPrediction.ts src\components\fitModel\fitModel.css src\graphCore\fitModelAdapter.ts tests
git commit -m "feat(fit-model): link compact prediction profiler" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Complete localization and contract parity

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/fitModelLocaleParity.test.ts`
- Modify: `tests/fitModelReport.test.ts`

**Interfaces:**
- Consumes: all visible keys introduced by Tasks 4-6.
- Produces: exact locale-key parity and a source-structure guard against native result tables/actions or legacy report delegation.

- [ ] **Step 1: Add failing locale and structure assertions**

Require keys for Effect Tests, Leverage Plot, Add Effect, Nparm, Prob > F,
effect leverage axis, adjusted response axis, null effect, and all
non-estimable labels. Assert the Fit Model renderer still imports shared
`AnalysisTable`, `AnalysisButton`, and `AnalysisGraph`, and contains no native
result `<table>`.

- [ ] **Step 2: Run parity tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelLocaleParity.test.ts
npm run test:analysis:contracts
```

Expected: FAIL on missing locale keys.

- [ ] **Step 3: Add all four locale translations**

Use the same nested key structure in every locale. Keep p-value notation and
statistical abbreviations consistent with existing Fit Model translations.

- [ ] **Step 4: Run parity and structure tests**

Run the two commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit localization**

```powershell
git add src\i18n\locales tests
git commit -m "feat(i18n): localize fit model effect analysis" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Run full Fit Model and Analysis verification

**Files:**
- Modify only files required to fix defects introduced by Tasks 1-7.

**Interfaces:**
- Consumes: completed implementation.
- Produces: verified branch with no uncommitted changes.

- [ ] **Step 1: Run focused frontend suites**

```powershell
npm run test:fit-model
npm run test:fit-model:ui
```

Expected: PASS.

- [ ] **Step 2: Run required Analysis gates**

```powershell
npm run test:analysis:typecheck
npm run test:analysis:contracts
npm run test:analysis:kinds
npm run test:analysis:ui
npm run test:analysis
```

Expected: PASS.

- [ ] **Step 3: Run backend gates**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml analysis_kind_manifest_matches_validator_contracts
Push-Location src-tauri
cargo test
cargo clippy -- -D warnings
Pop-Location
```

Expected: PASS with no warnings.

- [ ] **Step 4: Build the frontend**

```powershell
npx vite build 2>&1 | Select-Object -Last 3
```

Expected: Vite reports a successful production build.

- [ ] **Step 5: Perform running desktop visual acceptance**

Start the existing `Run StatsPlayground Tauri Dev` VS Code task and verify:

- the approved report order at desktop and narrow widths;
- Effect Summary bars align with table effects;
- Add opens the existing editor and Remove/Undo refit correctly;
- leverage selector switches one chart immediately;
- residual plot is wider without overflow;
- Q-Q is absent;
- profiler cards scroll horizontally and every chart updates from one input.

- [ ] **Step 6: Review the final diff**

```powershell
git --no-pager diff origin/dev...HEAD --check
git --no-pager status --short --branch
git --no-pager log --oneline origin/dev..HEAD
```

Expected: no diff-check errors and no uncommitted changes.
