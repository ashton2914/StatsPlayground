# Fit Model Regression Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the supplied JMP regression output and interaction workflow while improving Fit Model chart layout and linked profiler interaction.

**Architecture:** Rust keeps the fitted OLS basis but derives a separate, tested reporting basis for strongly hierarchical interaction models; non-hierarchical higher-order models explicitly retain the current uncentered output. React continues to compose shared Analysis primitives, while chart-domain calculation and pointer-coordinate conversion stay in focused graph components.

**Tech Stack:** Rust, nalgebra, statrs, Tauri v2, React 19, TypeScript, ECharts 6, Playwright component tests, Node/tsx contract tests.

**Spec:** `docs/superpowers/specs/2026-09-21-fit-model-regression-optimization-design.md`

## Global Constraints

- Work only in the existing `feat/fit-model-regression-interactions` worktree.
- Rust remains the sole statistical authority; do not calculate inferential statistics in TypeScript.
- Do not change fitted values, residuals, SSE, model-wide ANOVA, prediction snapshots, or saved diagnostic columns.
- Apply centered reporting only when all lower-order interactions implied by every higher-order interaction are present.
- Keep a non-hierarchical higher-order model in the uncentered fitted basis and retain its reduced-model Effect Tests.
- Add Effect creates one selected interaction and does not add lower-order interaction combinations.
- Preserve Analysis result identity and stale-result fencing.
- Reuse shared Analysis presentation primitives; do not add raw report tables or report action buttons.
- Keep TypeScript/Rust contracts camelCase-compatible and type-safe.
- Do not add dependencies.

---

### Task 1: JMP Reporting Basis and Centered Effect Tests

**Files:**
- Create: `src-tauri/src/engine/fit_model/reporting_basis.rs`
- Modify: `src-tauri/src/engine/fit_model.rs`
- Modify: `src-tauri/src/engine/fit_model/ols.rs`
- Modify: `src-tauri/src/engine/fit_model/effects.rs`
- Test: `src-tauri/src/engine/fit_model/reporting_basis.rs`
- Test: `src-tauri/src/engine/fit_model/ols.rs`
- Test: `src-tauri/src/engine/fit_model/effects.rs`

**Interfaces:**
- Consumes: fitted coefficient vector, unscaled coefficient geometry `(X'X)^-1`, resolved terms, and complete-case predictor means.
- Produces:

```rust
pub(crate) struct FitModelReportingBasis {
    pub coefficients: DVector<f64>,
    pub covariance_geometry: DMatrix<f64>,
    pub term_labels: Vec<String>,
    pub centered: bool,
}

pub(crate) fn reporting_basis(
    coefficients: &DVector<f64>,
    covariance_geometry: &DMatrix<f64>,
    terms: &[FitModelResolvedTerm],
    predictor_means: &BTreeMap<String, f64>,
) -> Result<FitModelReportingBasis, FitModelEngineError>;

pub(crate) fn compute_effect_tests(
    design_matrix: &DMatrix<f64>,
    response: &DVector<f64>,
    terms: &[FitModelResolvedTerm],
    reporting_basis: Option<&FitModelReportingBasis>,
    full_sse: f64,
    full_mse: Option<f64>,
    error_degrees_of_freedom: u64,
) -> Result<Vec<FitModelEffectTest>, FitModelEngineError>;
```

- `reporting_basis.centered == false` means coefficients, geometry, and labels are unchanged and Effect Tests must use the existing reduced-model path.

- [ ] **Step 1: Write failing reporting-basis tests**

Add tests that construct the raw basis `[1, A, B, A*B]`, transform raw
coefficients `[-14.5521, 146.213, 209.243, -334.874]` at means
`A=0.37388`, `B=0.39633`, and assert:

```rust
let reporting = reporting_basis(&coefficients, &geometry, &terms, &means)
    .expect("reporting basis");
assert!(reporting.centered);
assert_close(reporting.coefficients[0], 73.4217);
assert_close(reporting.coefficients[1], 13.4932);
assert_close(reporting.coefficients[2], 84.0403);
assert_close(reporting.coefficients[3], -334.874);
assert_eq!(
    reporting.term_labels[3],
    "(A-0.37388)*(B-0.39633)"
);
```

Also test:

```rust
// [1, A, B, C, A*B*C] is not strongly hierarchical.
assert!(!reporting.centered);
assert_eq!(reporting.coefficients, coefficients);
assert_eq!(reporting.term_labels[4], "A*B*C");
```

Use an additional complete `[1, A, B, C, A*B, A*C, B*C, A*B*C]` fixture to
assert transformation round-trips predictions for at least four predictor
rows:

```rust
assert_close(raw_design.row(row).dot(&raw_beta), centered_design.row(row).dot(&reporting.coefficients));
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```powershell
Set-Location src-tauri
cargo test reporting_basis --lib
```

Expected: FAIL because `reporting_basis` and its module do not exist.

- [ ] **Step 3: Implement hierarchical detection and the reporting transform**

In `reporting_basis.rs`:

1. Represent every non-power interaction as a sorted predictor-name set.
2. For each interaction of order greater than two, enumerate all subsets of
   sizes `2..order-1`; if any subset is absent, return the unchanged basis with
   `centered: false`.
3. Center predictors appearing in interactions.
4. Build transformation matrix `A` satisfying `X_raw = X_report A`.
5. Return `gamma = A * beta` and `G_gamma = A * G_beta * A.transpose()`.
6. Format centered factors with the repository report-number formatting rules,
   while retaining stable `term_id` values.
7. Reject dimension mismatches and non-finite means with
   `FitModelEngineError::InvalidInput` or `NumericalFailure`.

Keep powers in their existing raw feature form unless a future specification
defines JMP polynomial reporting.

- [ ] **Step 4: Run reporting-basis tests and verify GREEN**

Run:

```powershell
Set-Location src-tauri
cargo test reporting_basis --lib
```

Expected: PASS for two-way transformation, complete three-way invariance,
non-hierarchical fallback, and invalid-input tests.

- [ ] **Step 5: Write failing Parameter Estimates and Effect Tests**

In `ols.rs`, add a fit-level fixture with two interactions sharing a main
effect. Assert that:

```rust
assert_close(fitted.parameter_estimates[0].estimate, expected_centered_intercept);
assert_close(fitted.parameter_estimates[1].estimate, expected_centered_main_a);
assert_close(fitted.parameter_estimates[1].standard_error.unwrap(), expected_se);
assert_close(fitted.parameter_estimates[1].t_ratio.unwrap(), expected_t);
assert_eq!(fitted.plot_rows, expected_plot_rows); // fitted output is invariant
```

In `effects.rs`, add a centered-basis general-linear-hypothesis fixture and
assert:

```rust
assert_close(test.sum_of_squares.unwrap(), beta * beta / geometry_variance);
assert_close(test.f_ratio.unwrap(), test.sum_of_squares.unwrap() / mse);
assert_close(test.p_value.unwrap(), expected_f_upper_tail);
```

Retain a non-hierarchical test asserting byte-for-byte-equivalent reduced-model
Effect Tests.

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```powershell
Set-Location src-tauri
cargo test fit_model::ols --lib
cargo test fit_model::effects --lib
```

Expected: new centered parameter/effect assertions FAIL against raw estimates
and reduced-model main-effect tests.

- [ ] **Step 7: Integrate reporting geometry into OLS**

Expose an unscaled covariance geometry from `FitGeometry`; do not derive it by
dividing a rounded covariance matrix by MSE. In `ols.rs`:

```rust
let fitted_geometry = coefficient_covariance_geometry(&geometry)?;
let means = input.predictor_ranges.iter()
    .map(|range| (range.column_name.clone(), range.mean))
    .collect::<BTreeMap<_, _>>();
let reporting = reporting_basis(
    &coefficients,
    &fitted_geometry,
    &resolved,
    &means,
)?;
```

Use `reporting.coefficients`, `reporting.covariance_geometry`, and
`reporting.term_labels` only for Parameter Estimates and centered Effect Tests.
Continue constructing `FitModelSnapshot` from the original fitted coefficients
and original scaled covariance.

Refactor `parameter_estimates` to accept coefficient values, term IDs, labels,
and covariance geometry explicitly. Calculate standard errors as:

```rust
let variance = mse_value * covariance_geometry[(index, index)];
let standard_error = variance.sqrt();
```

- [ ] **Step 8: Implement centered general-linear-hypothesis Effect Tests**

When `reporting.centered` is true, group reporting coefficient indexes by
stable effect ID. For each group, let `b` be the coefficient subvector and
`G` the corresponding covariance-geometry submatrix:

```rust
let partial_ss = b.dot(&solve_symmetric(&g, &b)?);
let effect_df = matrix_rank(&g) as u64;
let f_ratio = (partial_ss / effect_df as f64) / mse;
```

Use SVD with the existing rank tolerance; return
`InferenceNotEstimable` for singular hypothesis geometry. When
`reporting.centered` is false, execute the existing reduced-model implementation
unchanged.

- [ ] **Step 9: Run Rust Fit Model tests and verify GREEN**

Run:

```powershell
Set-Location src-tauri
cargo test fit_model --lib
```

Expected: PASS, including prediction/diagnostic invariance and the
non-hierarchical fallback.

- [ ] **Step 10: Commit the statistical change**

```powershell
git add src-tauri/src/engine/fit_model.rs src-tauri/src/engine/fit_model/reporting_basis.rs src-tauri/src/engine/fit_model/ols.rs src-tauri/src/engine/fit_model/effects.rs
git commit -m "fix(stats): align fit model inference with JMP" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Diagnostic Chart Domains, Layout, and Report Order

**Files:**
- Modify: `src/graphCore/fitModelAdapter.ts`
- Modify: `src/components/analysis/renderers/FitModelAnalysisReport.tsx`
- Modify: `src/components/fitModel/FitModelEffectSummary.tsx`
- Modify: `src/components/fitModel/fitModel.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: `tests/fitModelGraphAdapter.test.ts`
- Test: `tests/fitModelReport.test.ts`
- Test: `tests/fitModelLocaleParity.test.ts`
- Test: `tests/e2e/FitModelReport.spec.tsx`

**Interfaces:**
- Produces:

```ts
interface NiceAxisExtent {
  min: number;
  max: number;
  interval: number;
}

function paddedNiceExtent(
  rawMin: number,
  rawMax: number,
  options?: { includeZero?: boolean; symmetric?: boolean },
): NiceAxisExtent;
```

- [ ] **Step 1: Write failing graph option tests**

Extend `tests/fitModelGraphAdapter.test.ts` with data concentrated between 65
and 71:

```ts
assert.ok(actual.xAxis.min < 65);
assert.ok(actual.xAxis.max > 71);
assert.equal((actual.xAxis.max - actual.xAxis.min) / actual.xAxis.interval % 1, 0);
assert.equal(residual.yAxis.min, -residual.yAxis.max);
assert.doesNotMatch(residual.yAxis.axisLabel.formatter(residual.yAxis.min), /000000|999999/);
assert.ok(actual.grid.left >= 48);
assert.ok(actual.grid.bottom >= 48);
```

Update the Effect Summary assertion to require:

```ts
assert.equal(markLine.data[0].xAxis, -Math.log10(0.05));
assert.equal(markLine.label.formatter, "LogWorth = 1.3");
assert.equal(markLine.lineStyle.color, "#d92d20");
assert.equal(markLine.lineStyle.type, "solid");
```

- [ ] **Step 2: Run graph tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
```

Expected: FAIL because axes still use raw extents and the significance line is
gray, dashed, and labeled `p = 0.05`.

- [ ] **Step 3: Implement padded nice extents and unclipped grids**

In `fitModelAdapter.ts`, implement the standard 1/2/2.5/5/10 nice-step family,
ten-percent padding, finite guards, constant-range expansion, and optional
symmetric limits. Set explicit `interval` and a shared formatter:

```ts
const formatAxisTick = (value: number) =>
  value === 0 ? "0" : Number.parseFloat(value.toPrecision(10)).toString();
```

Use padded extents for Actual X/Y and Residual X. Use
`{ includeZero: true, symmetric: true }` for Residual Y. Generate identity and
zero reference lines from the padded limits.

Increase diagnostic/effect chart grid margins and axis `nameGap` values. Keep
`containLabel: true`.

- [ ] **Step 4: Implement the red LogWorth reference**

Change the localized default and all four locale values from `p = 0.05` to
`LogWorth = 1.3`. Render a red solid mark line at `-Math.log10(0.05)`.

- [ ] **Step 5: Run graph and locale tests and verify GREEN**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelLocaleParity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing report structure tests**

Update report tests to require this prefix:

```ts
expect(sectionTitles.slice(0, 6)).toEqual([
  "Model Specification",
  "Leverage Plot",
  "Actual by Predicted",
  "Effect Summary",
  "Lack of Fit",
  "Residual by Predicted",
]);
```

Assert Parameter Estimates headers equal:

```ts
["Term", "Estimate", "Std Error", "t Ratio", "Feature VIF"]
```

Assert Leverage and Actual graph frames have the same computed width and chart
height at 1280px, and neither page nor chart labels overflow at 390px.

- [ ] **Step 7: Run report tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReport.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/FitModelReport.spec.tsx
```

Expected: FAIL on old order, old Parameter Estimates columns, and unequal graph
frame sizes.

- [ ] **Step 8: Reorder report sections and simplify Parameter Estimates**

Move the existing `FitModelLeveragePlot` block immediately after Model
Specification. Move no statistical calculations into the renderer.

Change the Parameter Estimates columns and cells to:

```tsx
columns={columns([
  ["term", t("fitModel.report.column.term")],
  ["estimate", t("fitModel.report.column.estimate"), true],
  ["standardError", t("fitModel.report.column.standardError"), true],
  ["tRatio", t("fitModel.report.column.tRatio"), true],
  ["featureVif", t("fitModel.report.column.featureVif"), true],
])}
```

Use the existing term-ID VIF lookup; show the undefined-value token for the
intercept.

- [ ] **Step 9: Match Leverage and Actual chart dimensions**

Replace the separate predicted/leverage sizing rules with one shared class or
identical declarations:

```css
.sp-fit-model-analysis-graph-predicted,
.sp-fit-model-analysis-graph-leverage {
  width: min(100%, 820px);
}

.sp-fit-model-diagnostic-chart-actualByPredicted,
.sp-fit-model-diagnostic-chart-leveragePlot {
  max-width: none;
  height: 340px;
}
```

Keep narrow-width containment and no page-level horizontal overflow.

- [ ] **Step 10: Run report tests and verify GREEN**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReport.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/FitModelReport.spec.tsx
```

Expected: PASS at desktop and narrow widths.

- [ ] **Step 11: Commit chart and report changes**

```powershell
git add src/graphCore/fitModelAdapter.ts src/components/analysis/renderers/FitModelAnalysisReport.tsx src/components/fitModel/FitModelEffectSummary.tsx src/components/fitModel/fitModel.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/fitModelGraphAdapter.test.ts tests/fitModelReport.test.ts tests/fitModelLocaleParity.test.ts tests/e2e/FitModelReport.spec.tsx
git commit -m "fix(graph): improve fit model report charts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Multi-Factor Add Effect Dialog

**Files:**
- Create: `src/components/fitModel/FitModelAddEffectDialog.tsx`
- Create: `src/components/fitModel/fitModelAddEffect.ts`
- Modify: `src/components/analysis/renderers/FitModelAnalysisReport.tsx`
- Modify: `src/components/analysis/renderers/FitModelAnalysisResults.tsx`
- Modify: `src/components/fitModel/fitModel.css`
- Modify: `src/components/fitModel/index.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: `tests/fitModelAddEffect.test.ts`
- Test: `tests/fitModelLocaleParity.test.ts`
- Test: `tests/e2e/FitModelReport.spec.tsx`

**Interfaces:**
- Produces:

```ts
export type FitModelAddEffectError =
  | "selectAtLeastTwo"
  | "duplicateEffect"
  | "tooManyTerms";

export type FitModelAddEffectResult =
  | { ok: true; terms: FitModelTerm[]; addedTerm: FitModelTerm }
  | { ok: false; reason: FitModelAddEffectError };

export function addFitModelInteractionEffect(
  terms: readonly FitModelTerm[],
  selectedColumnNames: readonly string[],
): FitModelAddEffectResult;
```

- Extends the report callback:

```ts
interface FitModelAnalysisReportProps {
  onAddEffect?: (terms: FitModelTerm[]) => void;
}
```

- [ ] **Step 1: Write failing pure-function tests**

Create `tests/fitModelAddEffect.test.ts` with:

```ts
assert.deepEqual(
  addFitModelInteractionEffect(existingMains, ["C", "A", "B"]),
  {
    ok: true,
    terms: [...existingMains, { kind: "interaction", columnNames: ["A", "B", "C"] }],
    addedTerm: { kind: "interaction", columnNames: ["A", "B", "C"] },
  },
);
assert.deepEqual(addFitModelInteractionEffect(existingMains, ["A"]), {
  ok: false,
  reason: "selectAtLeastTwo",
});
assert.deepEqual(addFitModelInteractionEffect(existingTerms, ["B", "A"]), {
  ok: false,
  reason: "duplicateEffect",
});
```

Add a 256-term boundary fixture that returns `tooManyTerms`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelAddEffect.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement canonical interaction addition**

Reuse `canonicalInteraction`, `canonicalizeFitModelTerms`, and
`MAX_FIT_MODEL_TERMS`. Deduplicate selected names, sort them with the same
canonical rule as existing term IDs, require at least two, and return a new
immutable terms array. Do not add pairwise subsets.

- [ ] **Step 4: Run the pure-function test and verify GREEN**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelAddEffect.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing component interaction tests**

In `FitModelReport.spec.tsx`, click Add and require:

```ts
await expect(component.getByRole("dialog", { name: "Add Effect" })).toBeVisible();
await component.getByRole("checkbox", { name: "A" }).check();
await component.getByRole("checkbox", { name: "B" }).check();
await component.getByRole("checkbox", { name: "C" }).check();
await component.getByRole("button", { name: "Add Effect" }).click();
expect(definitionChanges[0].definition.terms.at(-1)?.columnNames)
  .toEqual(["A", "B", "C"]);
```

Also cover one-selection validation, duplicate validation, Cancel, and disabled
behavior when `canEditInputs` is false.

- [ ] **Step 6: Run the component test and verify RED**

Run:

```powershell
npx playwright test -c playwright-ct.config.ts tests/e2e/FitModelReport.spec.tsx
```

Expected: FAIL because Add still opens the full Fit Model editor.

- [ ] **Step 7: Implement the Add Effect dialog**

Create `FitModelAddEffectDialog` using existing dialog classes. Props:

```ts
interface FitModelAddEffectDialogProps {
  predictorNames: readonly string[];
  terms: readonly FitModelTerm[];
  onConfirm: (terms: FitModelTerm[]) => void;
  onCancel: () => void;
}
```

Render one checkbox per predictor, the composed term preview, a localized
validation message, Cancel, and Add Effect. Keep all selection state local.

In `FitModelAnalysisReport`, replace the direct Add callback with local dialog
open state. Use `fittedResult.predictorColumns` and `item.terms` as dialog
inputs. On confirmation, pass the validated terms through
`onAddEffect(terms)` and close the dialog.

In `FitModelAnalysisResults`, replace `onAddEffect={onEditInputs}` with a
handler that calls the existing `submitDefinition` using the current centering
method and returned terms. Do not bypass config revision incrementing.

- [ ] **Step 8: Add localization and styles**

Add parity-checked keys for dialog title, instructions, preview, validation,
Cancel, and confirmation in all four locales. Add a bounded checkbox grid that
wraps and remains usable at 390px.

- [ ] **Step 9: Run Add Effect and locale tests and verify GREEN**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelAddEffect.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelLocaleParity.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/FitModelReport.spec.tsx
```

Expected: PASS.

- [ ] **Step 10: Commit Add Effect**

```powershell
git add src/components/fitModel/FitModelAddEffectDialog.tsx src/components/fitModel/fitModelAddEffect.ts src/components/analysis/renderers/FitModelAnalysisReport.tsx src/components/analysis/renderers/FitModelAnalysisResults.tsx src/components/fitModel/fitModel.css src/components/fitModel/index.ts src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/fitModelAddEffect.test.ts tests/fitModelLocaleParity.test.ts tests/e2e/FitModelReport.spec.tsx
git commit -m "feat(fit-model): add multi-factor effects" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: In-Chart Linked Prediction Profiler

**Files:**
- Modify: `src/components/fitModel/FitModelDiagnosticChart.tsx`
- Modify: `src/components/fitModel/FitModelProfiler.tsx`
- Modify: `src/components/fitModel/fitModel.css`
- Modify: `src/graphCore/fitModelAdapter.ts`
- Test: `tests/fitModelProfiler.test.ts`
- Test: `tests/fitModelGraphAdapter.test.ts`
- Test: `tests/e2e/FitModelProfiler.spec.tsx`

**Interfaces:**
- Extend the chart wrapper:

```ts
interface FitModelDiagnosticChartProps {
  option: EChartsOption;
  title: string;
  chartKind: FitModelChartKind;
  onXAxisPointerValue?: (value: number) => void;
}
```

- `onXAxisPointerValue` fires only for finite pointer values inside grid 0.

- [ ] **Step 1: Write failing profiler option and markup tests**

Require the profiler option to render a red current-value line and marker:

```ts
assert.equal(currentLine.lineStyle.color, "#d92d20");
assert.equal(currentLine.data[0].xAxis, currentValue);
assert.deepEqual(currentPoint.data[0].coord, [currentValue, currentPrediction]);
```

Update the component contract:

```ts
assert.equal((html.match(/type="range"/g) ?? []).length, 0);
assert.equal((html.match(/type="number"/g) ?? []).length, 2);
assert.match(html, /sp-fit-model-profiler-value/);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelProfiler.test.ts
```

Expected: FAIL because sliders remain and the current reference is not the
approved red interaction affordance.

- [ ] **Step 3: Implement chart pointer conversion**

In `FitModelDiagnosticChart`, after chart initialization, register ZRender
`mousedown`, `mousemove`, `mouseup`, and `globalout` handlers only when
`onXAxisPointerValue` is present.

Use:

```ts
if (!chart.containPixel({ gridIndex: 0 }, [event.offsetX, event.offsetY])) return;
const converted = chart.convertFromPixel(
  { xAxisIndex: 0 },
  [event.offsetX, event.offsetY],
);
const value = Array.isArray(converted) ? converted[0] : converted;
if (typeof value === "number" && Number.isFinite(value)) {
  onXAxisPointerValueRef.current?.(value);
}
```

`mousedown` applies one value and starts dragging; `mousemove` applies while
dragging; `mouseup` and `globalout` stop dragging. Dispose every listener on
unmount and before theme-driven chart recreation.

- [ ] **Step 4: Move numeric controls below charts**

Remove range inputs and the top controls block from `FitModelProfiler`. Render:

```tsx
<FitModelDiagnosticChart
  option={option}
  title={title}
  chartKind="predictionProfiler"
  onXAxisPointerValue={(next) =>
    updateValue(range.columnName, Math.min(range.maximum, Math.max(range.minimum, next)))
  }
/>
<label className="sp-fit-model-profiler-value">
  <span>{range.columnName}</span>
  <input type="number" step="any" value={value} ... />
</label>
```

Keep one shared values object, shared Y domain, and current prediction. Preserve
snapshot replacement behavior.

- [ ] **Step 5: Write failing click/drag linkage tests**

Replace slider-based Playwright actions with canvas interaction:

```ts
const box = await aCanvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.5);
await expect(aNumber).not.toHaveValue("2");
await expect.poll(async () => allMarkersSharePrediction(await readAllMarkerValues()))
  .toBe(true);

await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
await page.mouse.up();
await expect(aNumber).toHaveValue(expectedDraggedValue);
```

Assert both canvases change, both marker Y values equal the new prediction, the
numeric field is clamped to the training range, and the summary updates.

- [ ] **Step 6: Run profiler component tests and verify RED/GREEN**

Run after adding the failing assertions, then after implementation:

```powershell
npx playwright test -c playwright-ct.config.ts tests/e2e/FitModelProfiler.spec.tsx
```

Expected final result: PASS for click, drag, numeric entry, snapshot reset,
shared Y domain, missing inference, desktop layout, and narrow layout.

- [ ] **Step 7: Run all focused profiler/graph tests**

Run:

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelProfiler.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/FitModelProfiler.spec.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit profiler interaction**

```powershell
git add src/components/fitModel/FitModelDiagnosticChart.tsx src/components/fitModel/FitModelProfiler.tsx src/components/fitModel/fitModel.css src/graphCore/fitModelAdapter.ts tests/fitModelProfiler.test.ts tests/fitModelGraphAdapter.test.ts tests/e2e/FitModelProfiler.spec.tsx
git commit -m "feat(fit-model): link profiler chart interactions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Integrated Verification and Visual Acceptance

**Files:**
- Modify only files required to fix regressions caused by Tasks 1-4.
- Do not change unrelated pre-existing failures.

**Interfaces:**
- Consumes: all completed statistical, report, Add Effect, and profiler work.
- Produces: verified branch with clean focused and required Analysis gates.

- [ ] **Step 1: Format and run Rust focused verification**

Run:

```powershell
Set-Location src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test fit_model
```

Expected: PASS with no warnings.

- [ ] **Step 2: Run all Fit Model frontend tests**

Run:

```powershell
npm run test:fit-model
npm run test:fit-model:ui
```

Expected: PASS.

- [ ] **Step 3: Run required Analysis gates**

Run:

```powershell
npm run test:analysis:typecheck
npm run test:analysis:contracts
npm run test:analysis:kinds
npm run test:analysis:ui
npm run test:analysis
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
```

Expected: PASS.

- [ ] **Step 4: Build frontend and backend**

Run:

```powershell
npx vite build 2>&1 | Select-Object -Last 3
Set-Location src-tauri
cargo build
```

Expected: Vite completes successfully and Cargo finishes the dev build.

- [ ] **Step 5: Perform desktop visual acceptance**

In the shared `http://localhost:1420/` StatsPlayground page:

1. Open the supplied Fit Model analysis.
2. Confirm Leverage Plot is above Actual by Predicted.
3. Confirm both frames have equal dimensions.
4. Confirm Actual/Residual points have visible horizontal breathing room.
5. Confirm no X/Y title or tick label is clipped.
6. Confirm residual endpoints are short formatted numbers.
7. Confirm Effect Summary shows a red `LogWorth = 1.3` line.
8. Confirm Parameter Estimates match the centered JMP values and omit p-value
   and confidence-limit columns.
9. Confirm Effect Tests match the centered JMP main-effect values.
10. Add `X1*X2*X3` and confirm it is one term with no pairwise terms added.
11. Confirm that non-hierarchical model reports the explicit uncentered values.
12. Click and drag each profiler chart and confirm every chart and summary
    responds immediately.

- [ ] **Step 6: Perform narrow-width visual acceptance**

Set the viewport near 390x844 and confirm report frames, table scrollers, chart
labels, Add Effect dialog, profiler cards, and numeric inputs remain usable
without page-level horizontal overflow.

- [ ] **Step 7: Review the final diff**

Run:

```powershell
git status --short
git --no-pager diff --check
git --no-pager diff HEAD~4..HEAD --stat
```

Expected: only intended Fit Model implementation, tests, locale updates, and
approved docs are present.

- [ ] **Step 8: Commit any verification-only fixes**

If verification required tightly coupled fixes:

```powershell
git add <only-the-files-fixed-during-verification>
git commit -m "fix(fit-model): resolve regression optimization issues" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no fixes were required, do not create an empty commit.
