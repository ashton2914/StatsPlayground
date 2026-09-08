# Distribution Fit Inference and Diagnostics Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Letter-Value Quantile Plot and Stem-and-Leaf end to end, and add fixed 95% parameter standard errors and confidence limits for all five Continuous Fit models.

**Architecture:** Rust remains the sole owner of fitting and parameter inference. `distribution_fit.rs` computes typed parameter inference, `distribution_service.rs` only maps fit results into report payloads, and React renders the frozen four-value parameter contract. Removed diagnostics disappear from compute, IPC, preferences, graph adapter, UI, and tests while legacy unknown preference fields remain readable.

**Tech Stack:** Rust 2021, statrs 0.18, deterministic finite differences, Tauri v2 serde IPC, React 19, TypeScript, Playwright CT.

**Spec:** `docs/superpowers/specs/2026-08-31-distribution-fit-inference-and-diagnostics-removal-design.md`

## Global Constraints

- Parameter confidence is fixed at 95%; it does not consume Distribution `confidenceLevel`.
- Available numeric fields must be finite; singular/non-finite information returns typed unavailable.
- Do not change existing MLE point estimates, AIC/AICc/BIC, fit sorting, failure isolation, or PDF coordinates.
- Do not retain hidden Quantile Box or Stem calculation paths.
- Old archive preference keys `quantileBoxPlot` and `stemAndLeaf` must be ignored during read and omitted during write.
- No new Tauri command or dependency.
- Compatibility remains `compatibilityPending` for parameter inference.

---

### Task 1: Remove Diagnostic Compute and Rust Contracts

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`

**Interfaces:**
- Consumes: existing continuous report assembly and `DistributionChartDataV1`.
- Produces: report envelopes with no `quantileBox`, `quantileBoxData`, `stemAndLeaf`, or `stemAndLeafData` surfaces.

- [ ] **Step 1: Write RED service assertions**

Update `executes_continuous_descriptive_report_blocks` and `histograms_only_result_has_no_normal_quantile_block` to assert:

```rust
assert!(!result.report_blocks.iter().any(|block| {
    block.kind == "quantileBox" || block.kind == "stemAndLeaf"
}));
assert!(!serialized.contains("quantileBoxData"));
assert!(!serialized.contains("stemAndLeafData"));
```

- [ ] **Step 2: Run the focused service tests**

Run: `cargo test executes_continuous_descriptive_report_blocks`

Expected: FAIL because both report blocks still exist.

- [ ] **Step 3: Remove service assembly and model variants**

Delete Quantile Box and Stem block construction from `execute_distribution_run`. Remove:

```rust
DistributionChartKindV1::QuantileBoxData
DistributionChartDataV1::QuantileBoxData { ... }
DistributionReportBlockV1.stem_and_leaf_data
QuantileBoxLayerV1
QuantileBoxDataV1
StemAndLeafRowV1
StemAndLeafInterpretationKeyV1
StemAndLeafDataV1
```

Remove all now-redundant `stem_and_leaf_data: None` initializers and imports.

- [ ] **Step 4: Delete orphaned kernel methods and tests**

Delete `quantile_box_public_letter_value`, `stem_and_leaf_public_decimal`, their private structs/status enums, scale helper, and all dedicated tests. Preserve weighted Type-6 functions used by Quantiles and Normal Quantile.

- [ ] **Step 5: Run Rust removal gates**

Run:

```powershell
cargo test executes_continuous_descriptive_report_blocks
cargo test services::distribution_kernel::tests
```

Expected: PASS; no references to removed diagnostics compile.

- [ ] **Step 6: Review checkpoint**

Request an independent read-only review confirming no hidden compute path remains and unrelated Quantiles/Normal Quantile behavior is intact.

---

### Task 2: Remove Frontend Diagnostics and Preserve Legacy Read

**Files:**
- Delete: `src/components/distribution/StemAndLeafReport.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `src/types/distribution.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/distributionArchive.test.ts`
- Modify: `tests/distributionConfig.test.ts`
- Modify: `tests/distributionContracts.test.ts`
- Modify: `tests/distributionGraphAdapter.test.ts`
- Modify: `tests/e2e/DistributionCharts.spec.tsx`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Consumes: Task 1 reduced Rust result contract.
- Produces: reduced TS union/preferences and legacy preference sanitization.

- [ ] **Step 1: Write RED tests for absence and migration**

In Workspace CT assert the Diagnostic Plots group contains neither removed label. In archive test parse a legacy raw object containing both keys, normalize/save it, and assert:

```ts
expect(savedPreferences).not.toHaveProperty("quantileBoxPlot");
expect(savedPreferences).not.toHaveProperty("stemAndLeaf");
```

- [ ] **Step 2: Run focused RED tests**

Run:

```powershell
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx --grep "diagnostic"
npm run test:distribution:contracts
```

Expected: FAIL because menu/types still expose removed capabilities.

- [ ] **Step 3: Remove frontend runtime and types**

Delete Stem component/import/rendering. Remove `quantileBoxData` from chart unions and adapter. Remove Quantile Box/Stem menu detection, toggle keys, visibility branches, compatibility extraction, and unavailable handling. Remove both fields from `DistributionYReportPreferencesV2` and defaults.

- [ ] **Step 4: Sanitize legacy preference objects**

Change `normalizeReportPreferences` to explicitly select supported fields rather than spreading unknown input:

```ts
return {
  ...DEFAULT_DISTRIBUTION_REPORT_PREFERENCES,
  overview: preferences?.overview ?? true,
  // repeat every supported field; omit removed keys
};
```

Ensure store write receives the normalized reduced object.

- [ ] **Step 5: Remove stale locales and tests**

Remove dedicated rendering fixtures and adapter assertions for the two diagnostics. Remove only their exclusive locale keys; retain generic `quantiles`, `stem` words if used elsewhere.

- [ ] **Step 6: Run frontend removal gates**

Run:

```powershell
npm run test:distribution:contracts
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionCharts.spec.tsx
```

Expected: PASS; no removed chart/menu/type remains.

- [ ] **Step 7: Review checkpoint**

Request review for complete removal, old archive readability, and absence of broad object-spread reintroduction.

---

### Task 3: Add Typed Parameter Inference Contract

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `tests/distributionContracts.test.ts`

**Interfaces:**
- Produces:

```rust
pub struct DistributionFitParameterV1 {
    pub parameter_id: String,
    pub estimate: CapabilityTypedValueV1,
    pub standard_error: CapabilityTypedValueV1,
    pub lower_confidence: CapabilityTypedValueV1,
    pub upper_confidence: CapabilityTypedValueV1,
}
```

- [ ] **Step 1: Write RED serde and TS contract tests**

Require camelCase fields `estimate`, `standardError`, `lowerConfidence`, `upperConfidence`; reject new payload fixtures using `value` or a fixed Location row. Assert available fit `estimatedParameterCount === parameters.length`.

- [ ] **Step 2: Run contract tests to verify RED**

Run:

```powershell
cargo test distribution_fit_parameter
npm run test:distribution:contracts
```

Expected: FAIL on missing inference fields.

- [ ] **Step 3: Change Rust and TS types**

Replace public parameter `value` with the four typed fields. Add a helper:

```rust
fn estimated_parameter(parameter_id: &str, estimate: f64) -> Result<DistributionFitParameterV1, FitFailureV1>
```

It initializes inference fields as typed unavailable with `distribution.fit.parameterInferenceUnavailable.v1`; later tasks replace them when inference succeeds.

- [ ] **Step 4: Remove fixed Location from public fit estimates**

Exponential `FitEstimateV1.parameters` becomes `[scale]`; its `pdf` validates only Scale and assumes Location 0 internally. Remove service code that marks/appends Location. Gamma/Weibull remain `[shape, scale]`.

- [ ] **Step 5: Update parameter extraction helpers and all fixtures**

`expect_parameter_values` reads `parameter.estimate`. Update public fixture assertions and TS component fixtures. Ensure `estimatedParameterCount == parameters.len()` for all available models.

- [ ] **Step 6: Run contract and fit regression tests**

Run:

```powershell
cargo test services::distribution_fit::tests
cargo test services::distribution_service::tests::continuous_fit
npm run test:distribution:contracts
```

Expected: PASS; point estimates, metrics and PDF tests unchanged.

---

### Task 4: Implement Closed-Form and Gamma Inference

**Files:**
- Modify: `src-tauri/src/services/distribution_fit.rs`

**Interfaces:**
- Produces:

```rust
fn attach_parameter_inference(
    estimate: FitEstimateV1,
    observations: &[FitObservationV1],
) -> FitEstimateV1
```

and model-specific covariance calculations for Normal, Lognormal, Exponential, Gamma.

- [ ] **Step 1: Write RED numeric tests**

Use literal samples and assert formulas within `abs <= 1e-10 || rel <= 1e-9`:

```rust
assert_close(normal_location_se, sigma / total_weight.sqrt());
assert_close(normal_scale_se, sigma / (2.0 * total_weight).sqrt());
assert_close(exponential_scale_se, theta / total_weight.sqrt());
```

For every available parameter assert limits equal `estimate ± 1.959963984540054 * se`.

- [ ] **Step 2: Run RED tests**

Run: `cargo test parameter_inference`

Expected: FAIL because inference fields are unavailable.

- [ ] **Step 3: Implement typed Wald helper**

Add:

```rust
const PARAMETER_Z_975: f64 = 1.959963984540054;
fn inferred_parameter(parameter_id: &str, estimate: f64, standard_error: f64)
    -> DistributionFitParameterV1
```

Return typed unavailable SE/limits when SE or either limit is non-finite.

- [ ] **Step 4: Implement closed-form model inference**

Use `total_contribution(observations)` for $W$. Apply the spec formulas to Normal, Lognormal and Exponential without changing point estimates.

- [ ] **Step 5: Implement trigamma and Gamma covariance**

Because statrs 0.18 does not export trigamma, implement a private deterministic helper:

```rust
fn trigamma(mut x: f64) -> Option<f64> {
    if !x.is_finite() || x <= 0.0 { return None; }
    let mut result = 0.0;
    while x < 8.0 { result += 1.0 / (x * x); x += 1.0; }
    let inverse = 1.0 / x;
    let inverse2 = inverse * inverse;
    result += inverse + inverse2 / 2.0 + inverse2 * inverse / 6.0
        - inverse2 * inverse2 * inverse / 30.0
        + inverse2.powi(3) * inverse / 42.0;
    result.is_finite().then_some(result)
}
```

Validate against known values $\psi_1(1)=\pi^2/6$ and $\psi_1(1/2)=\pi^2/2$. Invert the symmetric $2\times2$ Gamma information matrix only when finite and positive definite.

- [ ] **Step 6: Isolate inference failure**

If Gamma information is invalid, preserve Estimate and return typed unavailable SE/limits for both rows. Do not fail the fit or remove its PDF.

- [ ] **Step 7: Run inference and full fit tests**

Run:

```powershell
cargo test parameter_inference
cargo test services::distribution_fit::tests
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Request statistical review of formulas, Weight contribution, matrix inversion and typed failure isolation.

---

### Task 5: Implement Weibull Numerical Information and UI

**Files:**
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Modify: `src/components/distribution/ContinuousFitReport.tsx`
- Modify: four locale JSON files
- Modify: `tests/e2e/ContinuousFitReport.spec.tsx`

**Interfaces:**
- Consumes: Task 3 parameter contract and Task 4 Wald helper.
- Produces: Weibull transformed Hessian/delta-method inference and five-column parameter UI.

- [ ] **Step 1: Write Weibull RED tests**

For deterministic positive samples assert repeated runs produce identical SE/limits, all available fields are finite, and frequency-compacted input equals logical expansion. Add a synthetic singular objective test expecting `distribution.fit.parameterInformationSingular.v1`.

- [ ] **Step 2: Implement two-parameter transformed objective**

Add a private full Weibull negative log-likelihood evaluator accepting `[ln_shape, ln_scale]`, separate from the profile optimizer objective. It must use stable log-domain terms and existing weighted likelihood semantics.

- [ ] **Step 3: Implement deterministic Hessian**

Use central differences and $h_j=\sqrt[3]{\epsilon}\max(1,|\eta_j|)$. Symmetrize off-diagonal estimates, validate positive definiteness, invert $2\times2$, then apply `diag(shape, scale)` delta method.

- [ ] **Step 4: Run Weibull inference tests**

Run: `cargo test weibull_parameter_inference`

Expected: PASS with deterministic finite outputs or stable typed unavailable.

- [ ] **Step 5: Write RED component test**

Require exactly five columns and no Location row:

```ts
await expect(table.getByRole("columnheader", { name: "Estimate" })).toBeVisible();
await expect(table.getByRole("columnheader", { name: "Std Error" })).toBeVisible();
await expect(table.getByRole("columnheader", { name: "Lower 95%" })).toBeVisible();
await expect(table.getByRole("columnheader", { name: "Upper 95%" })).toBeVisible();
await expect(table.getByRole("rowheader", { name: "Location" })).toHaveCount(0);
```

Add an unavailable inference row test that displays the typed reason code without hiding Estimate.

- [ ] **Step 6: Render the four typed values**

Update `ContinuousFitReport` to render Parameter plus four numeric columns. Remove `Fixed` handling and fixed locale strings. Add all four locale translations for Std Error and fixed 95% limits.

- [ ] **Step 7: Run UI and build gates**

Run:

```powershell
npx playwright test -c playwright-ct.config.ts tests/e2e/ContinuousFitReport.spec.tsx
npm run build
```

Expected: PASS with responsive table and complete grid borders.

- [ ] **Step 8: Review checkpoint**

Request review for numerical determinism, no UI recomputation, fixed Location absence and localization.

---

### Task 6: End-to-End Acceptance and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md`
- Modify: `docs/superpowers/specs/2026-08-31-distribution-optimization-handbook.md`
- Modify: `docs/superpowers/specs/2026-08-31-distribution-jmp-terminology-and-method-alignment-design.md`
- Create: `docs/superpowers/artifacts/2026-08-31-distribution-fit-inference-and-diagnostics-removal-acceptance.md`

**Interfaces:**
- Consumes: Tasks 1-5 code and evidence.
- Produces: truthful development/automation/UI/compatibility ledger.

- [ ] **Step 1: Run full automated gates**

Run:

```powershell
npm run test:distribution
npm run build
Set-Location src-tauri
cargo test --lib
cargo clippy --lib --tests
```

Expected: all tests/build pass; ordinary Clippy exits 0 with documented repository warnings.

- [ ] **Step 2: Parse locales and check diff**

Run four-locale JSON parse and `git diff --check`. Expected: 4/4 and no whitespace errors.

- [ ] **Step 3: Run Tauri smoke**

Start or reuse the dev app. Verify HTTP 200 and responsive `stats-playground` process. Do not elevate component tests or shell smoke to formal product UI acceptance.

- [ ] **Step 4: Update status documents**

Mark Letter-Value and Stem as removed, not deferred or hidden. Document fixed 95% Wald parameter inference and `compatibilityPending`; remove text claiming Stage 2 parameter SE/CI is unimplemented.

- [ ] **Step 5: Write acceptance artifact**

Record exact test counts, five-model parameter rows, removed surfaces, typed failure coverage, Clippy baseline and Tauri smoke. Keep formal UI acceptance pending unless a real dataset workflow was manually exercised.

- [ ] **Step 6: Final independent review**

Review the whole diff against the approved spec. Fix blocking findings and rerun affected gates.

- [ ] **Step 7: Commit after user request**

Do not auto-commit during tasks. When explicitly requested, use a Conventional Commit such as:

```text
feat(distribution): add fit parameter inference
```
