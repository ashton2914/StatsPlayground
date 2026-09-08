# Distribution Continuous Fit Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为连续 Y 提供 Normal、Lognormal、Exponential、Gamma、Weibull、Fit All、参数/信息准则报告和 Probability Density PDF overlay。

**Architecture:** 复用现有 Distribution run IPC 和 `PreparedObservationV1`，在 Rust 新增独立 `distribution_fit` registry/optimizer 模块；`distribution_service` 只编排 typed fit blocks。前端保存计算配置和显示偏好，只映射 Rust 返回的参数、指标与曲线坐标。

**Tech Stack:** Rust 2021、statrs 0.18.0、argmin 0.11.0、Tauri v2、React 19、TypeScript 5.7、Zustand 5、ECharts、Playwright CT。

**Spec:** `docs/superpowers/specs/2026-08-28-distribution-continuous-fit-jmp19-design.md`

## Global Constraints

- Rust errors返回 `Result<T, AppError>`；非测试代码禁止 `unwrap()`/`expect()`。
- 不新增 Tauri command；沿现有 Distribution request/result IPC。
- Rust 独占 MLE、信息准则、Fit All 排序和 PDF 坐标；前端不得重算。
- `argmin` 固定为 `0.11.0`，保留 `statrs = "0.18.0"`。
- 只有 registry 中 `implemented=true` 的 fit 才进入 UI 菜单。
- Stage 1 参数化固定为 Normal location/scale、Lognormal log-location/log-scale、Exponential scale/location0、Gamma shape/scale、Weibull shape/scale。
- 失败模型不产生伪曲线，不序列化 NaN/Infinity，不阻塞其他模型。
- 初始 optimizer/Weight/JMP 全流程状态为 `compatibilityPending`；不得从名称推断兼容。
- 保留四键 run identity、旧报告 updating 可见和 archive 向后兼容。

---

### Task 1: Versioned Fit Contracts and Registry

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/distributionConfig.ts`
- Modify: `src/components/distribution/DistributionDialog.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `tests/distributionContracts.test.ts`
- Modify: `tests/distributionRunContract.test.ts`
- Modify: `tests/distributionArchive.test.ts`
- Test: Rust model tests in `src-tauri/src/models/distribution.rs`

**Interfaces:**
- Produces: `ContinuousDistributionIdV1`, `DistributionContinuousFitConfigV1`, `DistributionFitDataV1`, `DistributionFitCapabilityV1`。
- Produces: config field `continuousFit` and report field `distributionFitData`。
- Consumes: existing `DistributionAnalysisConfigV1`, `DistributionReportBlockV1`, run request serialization。

- [ ] **Step 1: Write failing TS contract tests**

Add an exact config fixture:

```ts
const continuousFit = {
  enabledDistributionIds: ["normal", "gamma"],
  fitAll: false,
  diagnostics: {
    goodnessOfFit: false,
    qqPlot: false,
    cdfPlot: false,
    ppPlot: false,
  },
};

const configured: DistributionAnalysisConfigV1 = { ...config, continuousFit };
const request: DistributionRequestV1 = { ...baseRequest, continuousFit };
assert.deepEqual(configured.continuousFit, continuousFit);
assert.deepEqual(request.continuousFit, continuousFit);
```

In `distributionRunContract.test.ts`, assert the captured `start_distribution_run` invocation contains the exact `continuousFit` object. In `distributionArchive.test.ts`, add `continuousFit` to `distribution.currentConfig`, return that fixture from the existing mocked `open_project`, and assert the reopened document preserves it. Add a Rust serde test proving missing `continuousFit` defaults to disabled with no selected IDs.

- [ ] **Step 2: Run TS tests and verify RED**

Run:

```powershell
npx tsx tests/distributionContracts.test.ts
npx tsx tests/distributionRunContract.test.ts
npx tsx tests/distributionArchive.test.ts
```

Expected: FAIL because `continuousFit` and fit payload types/defaults do not exist.

- [ ] **Step 3: Add Rust/TS mirrored contracts**

Use these exact IDs:

```ts
export type ContinuousDistributionIdV1 =
  | "normal"
  | "lognormal"
  | "exponential"
  | "gamma"
  | "weibull";

export interface DistributionContinuousFitConfigV1 {
  enabledDistributionIds: ContinuousDistributionIdV1[];
  fitAll: boolean;
  diagnostics: {
    goodnessOfFit: boolean;
    qqPlot: boolean;
    cdfPlot: boolean;
    ppPlot: boolean;
  };
}
```

Add `continuous_fit` with `#[serde(default)]` to Rust config and `continuousFit?` to TS config. Default must be:

```ts
{
  enabledDistributionIds: [],
  fitAll: false,
  diagnostics: { goodnessOfFit: false, qqPlot: false, cdfPlot: false, ppPlot: false },
}
```

Add typed parameter, metric, convergence, provenance, curve and fit payload structs. Add:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub distribution_fit_data: Option<DistributionFitDataV1>,
```

Every existing `DistributionReportBlockV1` constructor must set `distribution_fit_data: None`.

- [ ] **Step 4: Add registry capability contract**

Define capability rows with exact fields:

```ts
interface DistributionFitCapabilityV1 {
  distributionId: ContinuousDistributionIdV1;
  methodId: string;
  methodVersion: string;
  parameterizationId: string;
  implemented: boolean;
  compatibilityStatus: "documentedCompatible" | "validatedCompatible" | "compatibilityPending" | "intentionalDifference";
}
```

Register exactly five implemented Stage 1 IDs; unknown IDs must fail validation at `continuousFit.enabledDistributionIds[index]`.

- [ ] **Step 5: Run contract, archive and Rust model tests**

Run:

```powershell
npx tsx tests/distributionContracts.test.ts
npx tsx tests/distributionRunContract.test.ts
npx tsx tests/distributionArchive.test.ts
Set-Location src-tauri
cargo test models::distribution::tests
```

Expected: all PASS; old configs deserialize cleanly and unknown fit IDs are rejected.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src-tauri/Cargo.toml src-tauri/src/models/distribution.rs src/types/distribution.ts src/components/distribution/distributionConfig.ts src/components/distribution/DistributionDialog.tsx src/components/Workspace.tsx tests/distributionContracts.test.ts tests/distributionRunContract.test.ts tests/distributionArchive.test.ts
git commit -m "feat(distribution): add continuous fit contracts"
```

---

### Task 2: Shared Fit Math and Optimizer Boundary

**Files:**
- Create: `src-tauri/src/services/distribution_fit.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: unit tests in `src-tauri/src/services/distribution_fit.rs`

**Interfaces:**
- Consumes: `PreparedObservationV1` from `engine::distribution_executor`。
- Produces: `FitObservationV1`, `FitMetricSetV1`, `FitModel` trait, `FitOptimizer` abstraction。
- Produces: `fit_information_criteria(log_likelihood, parameter_count, effective_n)`。

- [ ] **Step 1: Write failing tests for weighted likelihood support**

Add tests with observations carrying `(value, frequency, weight)`. For rows `(1,2,1)` and `(2,1,3)`, assert:

```rust
assert!((total_frequency(&observations) - 3.0).abs() < 1e-12);
assert!((effective_n(&observations) - 25.0 / 11.0).abs() < 1e-12);
```

The weighted contributions are `2.0` and `3.0`, while the denominator is $2(1^2)+1(3^2)=11$. Calculate expected values explicitly in each test rather than calling production helpers.

- [ ] **Step 2: Write failing information-criteria tests**

For `log_likelihood=-10`, `k=2`, `n_eff=20`, assert:

```rust
AIC = 24
AICc = 24 + 12 / 17
BIC = 2 * ln(20) + 20
```

Also assert AICc is typed unavailable when `n_eff <= k + 1`, and every non-finite input returns `AppError::Stats` or a typed unavailable metric instead of NaN.

- [ ] **Step 3: Run tests and verify RED**

```powershell
Set-Location src-tauri
cargo test services::distribution_fit::tests
```

Expected: FAIL because module and helpers do not exist.

- [ ] **Step 4: Implement common fit types and transforms**

Implement:

```rust
pub struct FitObservationV1 {
    pub value: f64,
  pub frequency: f64,
  pub weight: f64,
}

pub struct FitEstimateV1 {
    pub distribution_id: ContinuousDistributionIdV1,
    pub parameterization_id: &'static str,
    pub parameters: Vec<DistributionFitParameterV1>,
    pub log_likelihood: f64,
    pub convergence: DistributionFitConvergenceV1,
}

pub trait FitModel {
    fn distribution_id(&self) -> ContinuousDistributionIdV1;
    fn validate_domain(&self, observations: &[FitObservationV1]) -> Result<(), FitFailureV1>;
    fn fit(&self, observations: &[FitObservationV1]) -> Result<FitEstimateV1, FitFailureV1>;
    fn pdf(&self, estimate: &FitEstimateV1, x: f64) -> Result<f64, FitFailureV1>;
}
```

Centralize positive transforms as `exp(unconstrained)` and reject non-finite objective values. Add `argmin = "0.11.0"`; do not add observer crates.
Provide `FitObservationV1::contribution()` returning `frequency * weight`; retain both source dimensions so effective N can use `frequency * weight * weight` exactly.

- [ ] **Step 5: Implement criteria and 256-point curve builder**

`build_pdf_curve` consumes an explicit finite `(x_min, x_max)` and returns exactly 256 sorted points. It must return typed unavailable for zero-width extent or any non-finite PDF.

- [ ] **Step 6: Run focused tests**

```powershell
cargo test services::distribution_fit::tests
cargo clippy --lib -- -D warnings
```

Expected: fit module tests PASS. If strict Clippy only reports pre-existing repository warnings, record exact warning IDs; do not add blanket allows.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/services/mod.rs src-tauri/src/services/distribution_fit.rs
git commit -m "feat(stats): add continuous fit math kernel"
```

---

### Task 3: Closed-Form Normal, Lognormal and Exponential Fits

**Files:**
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Create: `tests/fixtures/distribution/continuous-fit-stage1-public-v1.json`
- Test: unit tests in `src-tauri/src/services/distribution_fit.rs`

**Interfaces:**
- Consumes: `FitModel`, weighted observations and criteria from Task 2。
- Produces: registry models `NormalFitV1`, `LognormalFitV1`, `ExponentialFitV1`。
- Produces method IDs `fit.normal.mle.v1`, `fit.lognormal.mle.v1`, `fit.exponential.location0.mle.v1`。

- [ ] **Step 1: Add independent golden fixture**

Fixture must contain machine-only fields:

```json
{
  "schemaVersion": "1",
  "cases": [
    {
      "caseId": "normal.unique.v1",
      "distributionId": "normal",
      "values": [1, 2, 3, 4, 5],
      "frequencies": null,
      "weights": null,
      "expectedParameters": { "location": 3, "scale": 1.4142135623730951 }
    }
  ]
}
```

Add positive-domain Lognormal and Exponential cases plus exact Frequency replication cases. Expected values must be generated from closed formulas outside production helpers.

- [ ] **Step 2: Write failing model tests**

Assert parameter IDs, MLE values, log-likelihood, 256-point finite curves, domain failures, constant sample behavior and Frequency replication equivalence.

- [ ] **Step 3: Run tests and verify RED**

```powershell
Set-Location src-tauri
cargo test services::distribution_fit::tests::closed_form
```

Expected: FAIL because the three model implementations are absent.

- [ ] **Step 4: Implement Normal MLE**

Use weighted MLE, not sample standard deviation:

$$
\hat\mu=\frac{\sum c_ix_i}{\sum c_i},\quad
\hat\sigma^2=\frac{\sum c_i(x_i-\hat\mu)^2}{\sum c_i}
$$

A zero fitted scale returns `unavailable/constantSample`; it must not construct `statrs::Normal` with invalid scale.

- [ ] **Step 5: Implement Lognormal and Exponential MLE**

Lognormal applies Normal MLE to `ln(x)` and requires every value `>0`. Exponential location0 requires every value `>=0` and uses:

$$
\hat\theta=\frac{\sum c_ix_i}{\sum c_i}
$$

Zero scale returns typed unavailable.

- [ ] **Step 6: Verify models and fixture**

```powershell
cargo test services::distribution_fit::tests::closed_form
cargo test services::distribution_fit::tests::public_fixture
```

Expected: all PASS with float rule `abs <= 1e-10 || rel <= 1e-9`.

- [ ] **Step 7: Commit Task 3**

```powershell
git add src-tauri/src/services/distribution_fit.rs tests/fixtures/distribution/continuous-fit-stage1-public-v1.json
git commit -m "feat(stats): fit common continuous distributions"
```

---

### Task 4: Deterministic Gamma and Weibull Optimization

**Files:**
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Modify: `tests/fixtures/distribution/continuous-fit-stage1-public-v1.json`
- Test: unit tests in `src-tauri/src/services/distribution_fit.rs`

**Interfaces:**
- Consumes: Task 2 optimizer abstraction and positive parameter transform。
- Produces: `GammaFitV1`, `WeibullFitV1` and convergence provenance。
- Produces method IDs `fit.gamma.shapeScale.mle.v1`, `fit.weibull.shapeScale.mle.v1`。

- [ ] **Step 1: Add failing parameter-recovery tests**

Use deterministic synthetic quantiles from `statrs` with fixed probability grid `p_i=(i-0.5)/100`, not RNG. Assert recovered parameters, finite likelihood, and repeat-run byte-equivalent payloads.

Include values spanning narrow positive data, wide scale, repeated values and Frequency expansion.

- [ ] **Step 2: Add failing optimizer-state tests**

Assert exact typed states for:

- non-positive domain
- iteration limit
- non-finite objective
- boundary parameter
- same input executed twice

Required convergence fields: `state`, `iterations`, `objective`, `gradientNorm`, `optimizerId`, `tolerance`.

- [ ] **Step 3: Run tests and verify RED**

```powershell
Set-Location src-tauri
cargo test services::distribution_fit::tests::optimized_models
```

Expected: FAIL because Gamma/Weibull registry entries are absent.

- [ ] **Step 4: Implement one centralized argmin adapter**

Use transformed parameters `(ln shape, ln scale)`, deterministic starts derived from sample log-moments, max 500 iterations and tolerance `1e-10`. Do not expose `argmin` types outside `distribution_fit.rs`.

- [ ] **Step 5: Implement Gamma and Weibull objectives**

Evaluate weighted `ln_pdf` through `statrs`; reject every non-finite term. Return best finite estimate only when convergence criteria pass. Preserve objective and iteration count in provenance.

- [ ] **Step 6: Run optimized model and full fit tests**

```powershell
cargo test services::distribution_fit::tests::optimized_models
cargo test services::distribution_fit::tests
```

Expected: all PASS and repeated runs return stable parameter ordering and values within tolerance.

- [ ] **Step 7: Commit Task 4**

```powershell
git add src-tauri/src/services/distribution_fit.rs tests/fixtures/distribution/continuous-fit-stage1-public-v1.json
git commit -m "feat(stats): add gamma and weibull fitting"
```

---

### Task 5: Service Orchestration and Fit All

**Files:**
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Modify: `src-tauri/src/models/distribution.rs`
- Test: service tests in `src-tauri/src/services/distribution_service.rs`

**Interfaces:**
- Consumes: Stage 1 registry and `DistributionContinuousFitConfigV1`。
- Produces: ordered `continuousFit` blocks after diagnostics and before Process Capability。
- Produces: one `fitComparison` block when `fitAll=true`。

- [ ] **Step 1: Write failing service tests**

Test exact block ordering and IDs for selected Normal/Gamma. Assert `histogramsOnly=true` suppresses all fit blocks.

For Fit All, use mixed-sign data and assert:

- Normal succeeds.
- Lognormal/Gamma/Weibull return domain failure rows.
- Exponential rejects negative data.
- successful models sort before failures.
- one failed model does not fail the run.

- [ ] **Step 2: Write failing validation tests**

Assert duplicate IDs, unknown IDs, and `fitAll=true` combined with non-empty explicit IDs follow one rule: reject the conflicting request at `continuousFit` with `InvalidParam`. This removes ambiguous candidate selection.

- [ ] **Step 3: Run service tests and verify RED**

```powershell
Set-Location src-tauri
cargo test services::distribution_service::tests::continuous_fit
```

Expected: FAIL because service does not dispatch fits.

- [ ] **Step 4: Implement registry dispatch**

At each Y group, derive fit observations from the same prepared group used by summary/histogram. Compute X extent from histogram bins plus observed finite values. Check cancellation between model executions.

Generate stable IDs:

```text
fit:<distributionId>:<groupIdentity>:<yColumnId>
fit-comparison:<groupIdentity>:<yColumnId>
```

Do not include display labels or absolute paths.

- [ ] **Step 5: Implement stable Fit All comparison**

Sort with exact rule: available AICc, available AIC, `distributionId`, then failed rows. Record actual registry candidate IDs and versions in provenance.

- [ ] **Step 6: Run service and Rust library tests**

```powershell
cargo test services::distribution_service::tests::continuous_fit
cargo test --lib
```

Expected: all PASS; serialized output contains no `NaN`, `Infinity` or `null` in available numeric fields.

- [ ] **Step 7: Commit Task 5**

```powershell
git add src-tauri/src/services/distribution_service.rs src-tauri/src/services/distribution_fit.rs src-tauri/src/models/distribution.rs
git commit -m "feat(distribution): execute continuous fits"
```

---

### Task 6: Continuous Fit Menu, Reports and PDF Overlay

**Files:**
- Create: `src/components/distribution/ContinuousFitReport.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/components/distribution/DistributionChart.tsx`
- Modify: `src/components/distribution/distribution.css`
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `tests/distributionGraphAdapter.test.ts`
- Modify: `tests/distributionReportWiring.test.ts`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`
- Modify: `tests/e2e/DistributionCharts.spec.tsx`

**Interfaces:**
- Consumes: fit capability registry, fit blocks and PDF coordinates from Tasks 1/5。
- Produces: payload-gated Continuous Fit submenu, fit tables, comparison table and Overview overlays。
- Produces: presentation preferences `fitOverlays`, `fitDetails` without revision changes。

- [ ] **Step 1: Write failing menu/report CT tests**

Mount a result containing only Normal and Gamma capabilities. Assert menu contains exactly:

```text
Fit Normal
Fit Gamma
Fit All
```

and does not contain unimplemented Cauchy/Student t/SHASH/Johnson/Mixture/Smooth Curve. Selecting Normal calls the computation-config callback once and closes the menu. Display-only overlay toggle calls preferences callback and does not call run.

- [ ] **Step 2: Write failing table tests**

Assert each available fit shows:

- parameter name/value rows
- LogLikelihood, AIC, AICc, BIC
- convergence status
- compatibility label

All `th/td` cells must have solid bottom and right borders. Domain failure shows reason code and no chart.

- [ ] **Step 3: Write failing adapter/canvas tests**

Extend `buildDistributionOverviewOption` with:

```ts
fitCurves?: Array<{
  fitId: string;
  distributionId: ContinuousDistributionIdV1;
  points: DistributionCoordinateV1[];
}>;
```

Assert curve data is copied directly, legend order is stable by `distributionId`, chart X extent contains histogram/spec/curve values, Y extent contains density/curve values, and non-coordinate metadata never enters a custom-series tuple. Render two overlays and require nonblank canvas pixels.

- [ ] **Step 4: Run frontend tests and verify RED**

```powershell
npx tsx tests/distributionGraphAdapter.test.ts
npx tsx tests/distributionReportWiring.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx tests/e2e/DistributionCharts.spec.tsx --grep "Continuous Fit|fit overlay"
```

Expected: FAIL because menu, report and overlay mapping do not exist.

- [ ] **Step 5: Implement menu and config callbacks**

Use the existing opaque `.distribution-analysis-menu` surface. Add a submenu/panel only for implemented registry rows. Computation selection updates `continuousFit.enabledDistributionIds`, increments revision through the existing save/run path, and keeps the committed report visible while updating.

- [ ] **Step 6: Implement fit tables and comparison report**

`ContinuousFitReport.tsx` renders typed values only; use existing `formatNumber` conventions and complete table grid. Never infer success from a non-empty parameter array; honor payload `status`.

- [ ] **Step 7: Implement PDF overlays**

Use ECharts `line` series with `clip: true`, `showSymbol: false`, backend point tuples `[x,y]`, stable color from `distributionId`, and a compact legend. Do not recompute PDF or normalize curves in TypeScript.

- [ ] **Step 8: Add four-locale strings and validate JSON**

Add menu labels, parameter names, metric names, status/reason labels and Fit All comparison text. Parse all four locale files with `ConvertFrom-Json`.

- [ ] **Step 9: Run frontend tests**

```powershell
npm run test:distribution
npm run build
```

Expected: all PASS; no production TypeScript error; Continuous Fit charts are nonblank.

- [ ] **Step 10: Commit Task 6**

```powershell
git add src/components/distribution/ContinuousFitReport.tsx src/components/distribution/DistributionReport.tsx src/components/distribution/DistributionChart.tsx src/components/distribution/distribution.css src/graphCore/distributionAdapter.ts src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/distributionGraphAdapter.test.ts tests/distributionReportWiring.test.ts tests/e2e/DistributionWorkspace.spec.tsx tests/e2e/DistributionCharts.spec.tsx
git commit -m "feat(distribution): add continuous fit reports"
```

---

### Task 7: Stage 1 Acceptance and Scope Closure

**Files:**
- Create: `docs/superpowers/artifacts/2026-08-28-distribution-continuous-fit-stage-1-acceptance.md`
- Modify: `docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md`
- Modify: `docs/superpowers/specs/2026-08-28-distribution-continuous-fit-jmp19-design.md`
- Modify: `package.json` only if a new fit-specific test is not already reached by `test:distribution`

**Interfaces:**
- Consumes: all Stage 1 implementation and evidence。
- Produces: automated acceptance record and truthful compatibility/UI status。

- [ ] **Step 1: Add an acceptance checklist before final runs**

Record exact rows for:

- five Stage 1 model statuses
- formula/optimizer compatibility status
- Weight/Freq evidence
- Fit All ordering and partial failure
- archive migration
- PDF overlay canvas
- desktop manual scenarios

Keep `uiAcceptance=pending` until actual Tauri product scenarios are run and recorded.

- [ ] **Step 2: Run complete automated gates**

```powershell
Set-Location src-tauri
cargo test --lib
cargo clippy --lib -- -D warnings
Set-Location ..
npm run test:distribution
npm run build
$files = Get-ChildItem .\src\i18n\locales\*.json
$files | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json | Out-Null }
git diff --check
```

Expected: Rust/frontend/build/locales/diff PASS. Record strict Clippy baseline separately if only pre-existing warnings remain.

- [ ] **Step 3: Run Tauri product smoke**

Use a synthetic dataset with positive skew and specs. Verify:

1. Fit Normal and Fit Gamma trigger updating without blanking old report.
2. Fit All returns five rows with stable ordering.
3. Positive-only models fail visibly on mixed-sign data.
4. Overview overlays align to `sales_amount` and Probability Density axes.
5. Project reopen restores selected models and presentation preferences, then recomputes results.
6. Narrow window menu remains opaque, scrollable and inside viewport.

- [ ] **Step 4: Update scope truthfully**

Set FIT-01 and Stage 1 portion of FIT-04 to `implemented/passing`; leave UI acceptance pending unless Step 3 is formally signed off. Leave FIT-03, FIT-05, FIT-07 and FIT-08 approved but not started for later stage plans.

- [ ] **Step 5: Request final code review**

Review priorities:

- likelihood/parameterization correctness
- optimizer determinism and failure isolation
- Weight/Freq/effective-N semantics
- no frontend recomputation
- no false JMP compatibility claim
- archive backward compatibility

Fix findings in the owning task slice and rerun its focused gate before the full gate.

- [ ] **Step 6: Commit acceptance records**

```powershell
git add docs/superpowers/artifacts/2026-08-28-distribution-continuous-fit-stage-1-acceptance.md docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md docs/superpowers/specs/2026-08-28-distribution-continuous-fit-jmp19-design.md package.json
git commit -m "docs(distribution): record continuous fit stage 1 acceptance"
```

## Stage Boundary

Stage 1 完成并通过验收后，才创建 Stage 2 实施计划。Stage 2 可依赖本计划产出的 `FitModel`、`FitOptimizer`、fit payload、Fit All comparison 和 UI registry，不得重定义这些合同。Stage 3 必须等待 Stage 2 optimizer/GOF 稳定后开始。
