# JMP-Compatible Fit Model Leverage Plots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Effect Leverage and Actual by Predicted confidence geometry use the same JMP-compatible linear hypotheses as the reported tests.

**Architecture:** Rust remains the statistical authority. The reporting-basis transform will expose the equivalent design matrix, a reusable general-hypothesis leverage helper will construct effect and Whole Model coordinates and confidence curves, and the fitted-result IPC contract will carry ordered chart-ready band points to the React/ECharts adapter.

**Tech Stack:** Rust 2021, nalgebra, statrs, Tauri v2 IPC, TypeScript, React 19, ECharts 6, Playwright component tests.

**Spec:** `docs/superpowers/specs/2026-09-21-fit-model-regression-optimization-design.md`

## Global Constraints

- Preserve fitted values, residuals, SSE, ANOVA, predictions, saved columns, and the persisted analysis definition.
- Rust owns all hypothesis, F-distribution, and confidence-curve calculations; the frontend only maps finite coordinates.
- Effect points, fitted line, confidence curves, null line, and p-value must describe one identical hypothesis.
- Strongly hierarchical interaction models use the centered reporting basis; non-hierarchical models use the existing raw-basis fallback.
- Continuous one-degree-of-freedom main effects use original predictor units; interaction and complex effects use response units with slope one.
- Invalid dimensions, non-finite values, singular transforms, and non-estimable hypotheses return `FitModelEngineError` or the existing explicit inference reason.
- No new runtime dependency is required.

---

### Task 1: Expose the Reporting-Basis Design Matrix

**Files:**
- Modify: `src-tauri/src/engine/fit_model/reporting_basis.rs`

**Interfaces:**
- Consumes: fitted-basis coefficient transform already created by `reporting_basis`.
- Produces: `FitModelReportingBasis::design_matrix(&self, fitted_design: &DMatrix<f64>) -> Result<DMatrix<f64>, FitModelEngineError>`.

- [ ] **Step 1: Write failing transform tests**

Add tests that build raw `[1, x, z, x*z]` and mean-construction `[1, x, z, (x-mx)*(z-mz)]` matrices, then assert:

```rust
let reporting_design = reporting
    .design_matrix(&fitted_design)
    .expect("reporting design");
assert_matrix_close(
    &reporting_design * &reporting.coefficients,
    &fitted_design * &fitted_coefficients,
);
assert_close(reporting_design[(row, x_column)], x[row] - mean_x);
assert_close(reporting_design[(row, z_column)], z[row] - mean_z);
```

Also test unchanged/non-hierarchical reporting returns the fitted design unchanged and dimension mismatches return `FitModelEngineError::InvalidInput`.

- [ ] **Step 2: Run the reporting-basis tests and verify RED**

Run:

```powershell
Set-Location src-tauri
cargo test reporting_basis --lib
```

Expected: compilation fails because `FitModelReportingBasis::design_matrix` does not exist.

- [ ] **Step 3: Preserve the inverse coefficient transform**

Extend the reporting value with the matrix that maps reporting coefficients back to fitted coefficients:

```rust
pub(crate) struct FitModelReportingBasis {
    pub coefficients: DVector<f64>,
    pub covariance_geometry: DMatrix<f64>,
    pub term_labels: Vec<String>,
    pub centered: bool,
    fitted_coefficients_from_reporting: DMatrix<f64>,
}
```

For the centered path, compute the inverse of the existing coefficient transform and return `NumericalFailure` if it is singular. For the unchanged path, store `DMatrix::identity(width, width)`.

- [ ] **Step 4: Implement the reporting design projection**

Add:

```rust
impl FitModelReportingBasis {
    pub(crate) fn design_matrix(
        &self,
        fitted_design: &DMatrix<f64>,
    ) -> Result<DMatrix<f64>, FitModelEngineError> {
        if fitted_design.ncols() != self.fitted_coefficients_from_reporting.nrows() {
            return Err(FitModelEngineError::InvalidInput(
                "fitted design width must match reporting basis".to_string(),
            ));
        }
        let design = fitted_design * &self.fitted_coefficients_from_reporting;
        if design.iter().any(|value| !value.is_finite()) {
            return Err(FitModelEngineError::NumericalFailure(
                "reporting design contained non-finite values".to_string(),
            ));
        }
        Ok(design)
    }
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
Set-Location src-tauri
cargo test reporting_basis --lib
```

Expected: all reporting-basis tests pass.

Commit:

```powershell
git add src-tauri\src\engine\fit_model\reporting_basis.rs
git commit -m "refactor(stats): expose fit model reporting design"
```

---

### Task 2: Construct Effect Leverage from the Effect-Test Hypothesis

**Files:**
- Modify: `src-tauri/src/engine/fit_model/effects.rs`
- Modify: `src-tauri/src/engine/fit_model/ols.rs`
- Test: `src-tauri/src/engine/fit_model/effects.rs`
- Test: `src-tauri/src/engine/fit_model/ols.rs`

**Interfaces:**
- Consumes: `FitModelReportingBasis::design_matrix`, reporting-basis `FitModelEffectTest` rows, predictor means, MSE, error DF, and confidence level.
- Produces: existing `Vec<FitModelLeveragePlot>` with JMP-compatible points, fitted line, confidence band, null line, and p-value.

- [ ] **Step 1: Replace the raw-column oracle with hypothesis invariants**

Add a hierarchical interaction fixture where the raw main-effect coefficient and centered reporting coefficient have opposite signs. Assert for the main effect:

```rust
assert!(raw_main_coefficient > 0.0);
assert!(reporting_main_coefficient < 0.0);
assert!(recovered_plot_slope < 0.0);
assert_eq!(plot.p_value, centered_effect_test.p_value);
assert_close(mean(&plot_x), predictor_mean);
```

For every plotted row, recover the full-model and constrained residuals:

```rust
assert_close(point.adjusted_response - fitted_on_plot, full_residual[row]);
assert_close(point.adjusted_response - response_mean, constrained_residual[row]);
```

Assert the constrained-minus-full residual sum-of-squares difference equals `effect_test.sum_of_squares`.

- [ ] **Step 2: Add complex-effect scaling tests**

For an interaction effect, assert the horizontal coordinate is in response units and the fitted line has slope one:

```rust
let delta_x = second.effect_leverage - first.effect_leverage;
let delta_y = second.fitted - first.fitted;
assert_close(delta_y / delta_x, 1.0);
```

Assert a non-hierarchical model uses its raw Effect Test p-value and still satisfies the same residual-geometry invariants.

- [ ] **Step 3: Run effect tests and verify RED**

Run:

```powershell
Set-Location src-tauri
cargo test leverage --lib
```

Expected: the centered slope/p-value and complex-effect scaling assertions fail because leverage currently removes one raw fitted column.

- [ ] **Step 4: Introduce one internal general-hypothesis geometry**

In `effects.rs`, add an internal value:

```rust
struct LeverageGeometry {
    contribution: DVector<f64>,
    constrained_residuals: DVector<f64>,
    full_residuals: DVector<f64>,
    hypothesis_sum_of_squares: f64,
}
```

Build it by solving the full reporting design and the reporting design with the selected effect columns removed. Define:

```rust
let contribution = &constrained_residuals - &full_residuals;
let hypothesis_sum_of_squares = contribution.dot(&contribution);
```

Clamp only roundoff-sized negative differences using the existing tolerance policy. Reject non-finite geometry explicitly.

- [ ] **Step 5: Implement JMP coordinate scaling**

Change `compute_effect_leverage_plots` to accept:

```rust
pub(crate) fn compute_effect_leverage_plots(
    fitted_design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    row_indexes: &[u64],
    terms: &[FitModelResolvedTerm],
    reporting: &FitModelReportingBasis,
    effect_tests: &[FitModelEffectTest],
    predictor_means: &BTreeMap<String, f64>,
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
) -> Result<Vec<FitModelLeveragePlot>, FitModelEngineError>
```

For a one-column continuous main effect:

1. Residualize its reporting-design column against all nuisance columns.
2. Set `effect_leverage = predictor_mean + residualized_predictor`.
3. Set `adjusted_response = response_mean + constrained_residual`.
4. Set the fitted line to `response_mean + reporting_coefficient * (x - predictor_mean)`.

For interactions and all complex effects:

1. Set `effect_leverage = response_mean + contribution`.
2. Set `adjusted_response = response_mean + constrained_residual`.
3. Set the fitted line to `y = x`.

Use `effect_test.p_value` directly. Do not look up a separate fitted-basis test.

- [ ] **Step 6: Implement JMP confidence curves**

Extract a helper that receives the plotted center, horizontal energy, effect DF, MSE, error DF, and confidence level. For a coordinate delta, use:

```rust
let f_critical = FisherSnedecor::new(effect_df as f64, error_df as f64)?
    .inverse_cdf(confidence_level);
let margin = (
    effect_df as f64
        * f_critical
        * mse
        * (1.0 / source_row_count as f64 + delta * delta / horizontal_energy)
).sqrt();
```

For a continuous one-DF main effect, `horizontal_energy` is the residualized predictor sum of squares and `delta` is in predictor units. For response-unit complex effects, `horizontal_energy` is the hypothesis sum of squares and `delta` is in response units. Generate ordered band points from deterministic sorted leverage coordinates.

- [ ] **Step 7: Wire OLS to one hypothesis source**

In `ols.rs`, remove the separate `fitted_effect_tests` path for leverage. Pass `&reporting`, `&effect_tests`, and predictor means into `compute_effect_leverage_plots`. Keep the existing raw-basis fallback because `reporting.centered == false` already makes `effect_tests` raw-basis tests.

- [ ] **Step 8: Run Rust tests and commit**

Run:

```powershell
Set-Location src-tauri
cargo test leverage --lib
cargo test fit_model --lib --no-run
```

Expected: leverage unit tests pass and the Fit Model test target compiles.

Commit:

```powershell
git add src-tauri\src\engine\fit_model\effects.rs src-tauri\src\engine\fit_model\ols.rs
git commit -m "fix(stats): align leverage plots with JMP hypotheses"
```

---

### Task 3: Produce the Whole Model Actual-by-Predicted Confidence Curve

**Files:**
- Modify: `src-tauri/src/models/fit_model.rs`
- Modify: `src-tauri/src/engine/fit_model/effects.rs`
- Modify: `src-tauri/src/engine/fit_model/ols.rs`
- Modify: `src/types/fitModel.ts`
- Test: `src-tauri/src/models/fit_model.rs`
- Test: `src-tauri/src/engine/fit_model/ols.rs`

**Interfaces:**
- Consumes: full fitted values, response mean, model sum of squares, model DF, MSE, error DF, and confidence level.
- Produces: `actual_by_predicted_confidence_band: Vec<FitModelActualByPredictedBandPoint>` in `FitModelFittedResult`.

- [ ] **Step 1: Add failing Whole Model confidence tests**

Define the expected transport type in Rust tests:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelActualByPredictedBandPoint {
    pub predicted: f64,
    pub fitted: f64,
    pub lower: f64,
    pub upper: f64,
}
```

Add an OLS fixture assertion that:

- band points are ordered by `predicted`;
- `fitted == predicted`;
- `lower <= fitted <= upper`;
- equal predicted coordinates have equal bounds;
- the center point is narrowest;
- the curve is independent of `diagnostics.rows[*].mean_confidence_*`.

- [ ] **Step 2: Run the focused OLS test and verify RED**

Run:

```powershell
Set-Location src-tauri
cargo test whole_model_leverage --lib
```

Expected: compilation fails because the fitted result has no dedicated Whole Model band.

- [ ] **Step 3: Add the Rust and TypeScript contract**

Add the Rust type above and:

```rust
pub actual_by_predicted_confidence_band: Vec<FitModelActualByPredictedBandPoint>,
```

to `FitModelFittedResult`. Mirror it in `src/types/fitModel.ts`:

```ts
export interface FitModelActualByPredictedBandPoint {
  predicted: number;
  fitted: number;
  lower: number;
  upper: number;
}
```

and add `actualByPredictedConfidenceBand` to `FitModelFittedResult`.

Update the Rust camelCase serialization test to require the new field.

- [ ] **Step 4: Compute the Whole Model hypothesis geometry**

Add:

```rust
pub(crate) fn compute_whole_model_confidence_band(
    fitted: &DVector<f64>,
    response_mean: f64,
    model_sum_of_squares: f64,
    model_degrees_of_freedom: u64,
    mse: Option<f64>,
    error_degrees_of_freedom: u64,
    confidence_level: f64,
) -> Result<Vec<FitModelActualByPredictedBandPoint>, FitModelEngineError>
```

Use response-unit center `response_mean`, fitted line `y = x`, horizontal energy `model_sum_of_squares`, and the same F-based confidence helper from Task 2. Sort and deduplicate the deterministic fitted coordinate grid before creating points. Return an empty band when inference is not estimable; never substitute row diagnostic intervals.

- [ ] **Step 5: Populate the fitted result and update fixtures**

Call the helper in `ols.rs` after model SS, model DF, MSE, and fitted values are available. Add the returned vector to every `FitModelFittedResult` fixture and serialization snapshot.

- [ ] **Step 6: Run contract and engine tests and commit**

Run:

```powershell
Set-Location src-tauri
cargo test whole_model_leverage --lib
cargo test models::fit_model --lib
cargo test fit_model --lib --no-run
```

Expected: focused tests pass and the Fit Model test target compiles.

Commit:

```powershell
git add src-tauri\src\models\fit_model.rs src-tauri\src\engine\fit_model\effects.rs src-tauri\src\engine\fit_model\ols.rs src\types\fitModel.ts
git commit -m "feat(fit-model): add whole model confidence curve"
```

---

### Task 4: Render Dedicated JMP Confidence Geometry

**Files:**
- Modify: `src/graphCore/fitModelAdapter.ts`
- Modify: `src/components/analysis/renderers/FitModelAnalysisReport.tsx`
- Modify: `src/components/fitModel/FitModelLeveragePlot.tsx`
- Modify: `tests/fitModelGraphAdapter.test.ts`
- Modify: `tests/e2e/FitModelReport.spec.tsx`

**Interfaces:**
- Consumes: `FitModelFittedResult.actualByPredictedConfidenceBand` and existing `FitModelLeveragePlot`.
- Produces: chart options that map Rust band coordinates without deriving statistical intervals.

- [ ] **Step 1: Rewrite the graph-adapter test to require the dedicated band**

Replace the `confidenceRows` test input with:

```ts
actualByPredictedConfidenceBand: [
  { predicted: 9, fitted: 9, lower: 8.5, upper: 9.5 },
  { predicted: 11, fitted: 11, lower: 10.25, upper: 11.75 },
],
```

Assert the lower and width stack series exactly match these ordered coordinates. Add a deliberately conflicting row diagnostic interval to the report fixture and assert it never appears in the option.

- [ ] **Step 2: Add failing selector and UI assertions**

In `FitModelReport.spec.tsx`, use a centered Effect Test label such as `(A-2.5)` and a leverage plot label `A`. Assert the Effect selector displays `A`, the selected chart p-value equals the matching leverage result, and the Actual by Predicted chart renders exactly two confidence series.

- [ ] **Step 3: Run frontend tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelGraphAdapter.test.ts
npm run test:fit-model:ui
```

Expected: the adapter still requires `confidenceRows`, and the selector still displays Effect Test labels.

- [ ] **Step 4: Map the Whole Model band**

Change `FitModelChartInput` to:

```ts
actualByPredictedConfidenceBand?: readonly FitModelActualByPredictedBandPoint[];
```

Delete `FitModelConfidenceRow`. Build the lower and width stack directly from `lower` and `upper - lower`, preserving Rust order and rejecting non-finite or negative widths.

In `FitModelAnalysisReport.tsx`, pass:

```tsx
actualByPredictedConfidenceBand={fittedResult.actualByPredictedConfidenceBand}
```

Do not pass `fittedResult.diagnostics.rows`.

- [ ] **Step 5: Make effect selection use leverage identities**

In `FitModelLeveragePlot.tsx`, render selector options from `leveragePlots` so the visible label describes the plotted scaling:

```tsx
{leveragePlots.map((plot) => (
  <option key={plot.termId} value={plot.termId}>{plot.termLabel}</option>
))}
```

Continue using `effectTests` only for default significance ordering if required by `selectDefaultLeverageTermId`.

- [ ] **Step 6: Run frontend tests and commit**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelGraphAdapter.test.ts
npm run test:fit-model:ui
npm run test:analysis:typecheck
```

Expected: graph contract, 17 Fit Model UI tests, and Analysis type checking pass.

Commit:

```powershell
git add src\graphCore\fitModelAdapter.ts src\components\analysis\renderers\FitModelAnalysisReport.tsx src\components\fitModel\FitModelLeveragePlot.tsx tests\fitModelGraphAdapter.test.ts tests\e2e\FitModelReport.spec.tsx
git commit -m "fix(fit-model): render JMP leverage confidence curves"
```

---

### Task 5: Regression Gates and Visual Acceptance

**Files:**
- Modify only if a gate exposes a regression tightly coupled to Tasks 1-4.

**Interfaces:**
- Consumes: all preceding task outputs.
- Produces: verified branch with no Critical or Important review findings.

- [ ] **Step 1: Run the focused frontend gates**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests\fitModelGraphAdapter.test.ts
npm run test:fit-model:ui
npm run test:analysis:ui
npx vite build
```

Expected: graph contract passes, Fit Model UI reports 17 passing tests, Analysis UI reports 60 passing tests, and Vite exits zero with only the existing chunk-size advisory.

- [ ] **Step 2: Run the focused Rust gates**

Run:

```powershell
Set-Location src-tauri
cargo check --lib
cargo test fit_model --lib --no-run
```

If the Windows test loader still exits with `0xc0000139`, retain compile evidence and run the repository's existing isolated Fit Model source harness. Do not report the loader failure as a passing runtime suite.

- [ ] **Step 3: Review the complete change**

Review the diff from commit `5163e3a7` to `HEAD` against the approved spec. Reject:

- any plot using a p-value from a different hypothesis;
- any frontend confidence calculation;
- any row diagnostic interval reused as a Whole Model curve;
- any main-effect X axis left in centered-zero units;
- any interaction fitted line whose slope is not one;
- any silent fallback for singular or non-finite geometry.

- [ ] **Step 4: Launch and inspect the desktop app**

Run:

```powershell
npm run tauri dev
```

Using the supplied dataset, verify:

1. Actual by Predicted has a smooth pale-red 95% Whole Model confidence region around the red `y=x` line.
2. BK11P leverage values span the JMP-like original-variable range rather than clustering in the raw interaction basis.
3. BK11P slope direction and p-value match its centered Effect Test.
4. Interaction leverage uses response units and a slope-one red line.
5. Axis labels, confidence curves, and null lines remain unclipped.

- [ ] **Step 5: Commit any gate-driven corrections**

If corrections were required:

```powershell
git add -A
git commit -m "fix(fit-model): resolve JMP leverage integration issues"
```

If no correction was required, do not create an empty commit.
