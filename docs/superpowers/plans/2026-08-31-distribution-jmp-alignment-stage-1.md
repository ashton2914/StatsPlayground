# Distribution JMP Alignment Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对齐Distribution的JMP专业术语和默认报告结构，修复Exponential参数计数，并增加Stability Index、百分比Nonconformance和可解释Stem输出。

**Architecture:** Rust继续拥有统计值和typed状态，React只负责JMP风格术语与格式。已确认bug在原有method内修复；未公开的JMP算法不在Stage 1实现，现有Quantile Box/Stem兼容状态保持可见。

**Tech Stack:** Rust 2021、statrs 0.18.0、Tauri v2、React 19、TypeScript 5.7、Playwright CT。

**Spec:** `docs/superpowers/specs/2026-08-31-distribution-jmp-terminology-and-method-alignment-design.md`

## Global Constraints

- 不复制JMP帮助正文、UI资产或未公开算法。
- 可见术语采用批准规格中的JMP专业名称。
- Stage 1不实现Continuous Fit参数SE/CI，不改变Normal/Gamma/Weibull估计方法。
- Quantile Box/Stem保留`intentionalDifference`；Capability exact intervals保持`compatibilityPending`。
- Rust非测试代码禁止`unwrap()`/`expect()`；available numeric fields必须finite。
- 显示格式不得舍入后端payload。
- 不新增Stage 2/3方法或空菜单入口。

---

### Task 1: Summary Semantics and JMP Terminology

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: four locale JSON files
- Modify: `tests/distributionContracts.test.ts`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Produces: explicit mode state or complete mode list in`DistributionSummaryDataV1`。
- Preserves: currentStd Error formula、Median、N Missing、Range、IQR、raw MAD values。

- [ ] Write RED Rust tests for unique mode, tied highest frequencies and all-values-equal-frequency/no unique mode.
- [ ] Write RED CT asserting`Std Error Mean`, retained fields, and`No unique mode`for the51-row fixture shape.
- [ ] Run focused tests and confirm failures are terminology/mode-contract failures.
- [ ] Extend mirrored Rust/TS summary payload with enough typed information to distinguish a unique mode from ties.
- [ ] Render`No unique mode`when top frequency ties; never infer uniqueness from`primaryMode`.
- [ ] Rename visible`Std Error`to`Std Error Mean`in all four locales; do not modify the formula.
- [ ] Preserve visible Median、N Missing、Range、IQR、MAD and add raw-MAD method wording only where needed.
- [ ] Run contracts、summary kernel tests、Workspace CT and build.

---

### Task 2: Stability Index, Three-Decimal Capability and Percentage Nonconformance

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/normal_capability.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/ProcessCapabilityReport.tsx`
- Modify: four locale JSON files
- Modify: `tests/distributionContracts.test.ts`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Produces: typedStability Index inProcess Summary。
- Consumes: existing observed/expected`proportion`fields forNonconformance。

- [ ] Write RED tests for$731.775276729348/600.464471303597=1.218682...$ and unavailable/zero-within states.
- [ ] Add typed stability payload with method provenance`capability.stability.overallToWithin.v1`.
- [ ] Render Process Summary Stability Index using the51-row fixture.
- [ ] Format all capability indices/interval endpoints with exactly3 decimal places; keep payload full precision.
- [ ] Replace default Nonconformance columns with`Portion | Observed % | Expected Within % | Expected Overall %`.
- [ ] Format percentages from`proportion*100`with up to4 decimals; do not derive from formattedPPM.
- [ ] Keep Count/PPM/Wilson fields incontracts but hide them from the default table.
- [ ] Run capability Rust tests、contracts、Capability CT and build.

---

### Task 3: Exponential Estimated Parameter Count

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `tests/fixtures/distribution/continuous-fit-stage1-public-v1.json`
- Modify: fit/service/contract tests

**Interfaces:**
- Produces: `estimatedParameterCount` and per-parameter fixed semantics, or an equivalent model-owned free-parameter count。
- Fixes: Exponential location0 uses$k=1$; otherStage 1 models use$k=2$。

- [ ] Add RED tests on the51-row tracked observations requiring Exponential`-2LL=740.6183972`, AICc`742.7000298`, BIC`744.5502228`within float tolerance.
- [ ] Add registry/model tests asserting free parameter count: Normal2、Lognormal2、Exponential1、Gamma2、Weibull2.
- [ ] Stop deriving$k$from`parameters.len()`inservice orchestration.
- [ ] Mark fixed location parameters explicitly without counting them in$k$.
- [ ] Preserve Fit All sorting and failure isolation.
- [ ] Run completefit tests、service Continuous Fit tests、contracts andRust library.

---

### Task 4: Continuous Fit JMP Measures and Parameter Terminology

**Files:**
- Modify: `src/components/distribution/ContinuousFitReport.tsx`
- Modify: four locale JSON files
- Modify: `tests/e2e/ContinuousFitReport.spec.tsx`

**Interfaces:**
- Consumes: Task3 fixed/free parameter metadata and current typed metrics。
- Produces: JMP-style visible parameter andMeasures tables without newstatistics。

- [ ] Write RED CT for model-specific terminology and table structure.
- [ ] Rename parameter value column to`Estimate`.
- [ ] Render fixed location rows as`Fixed`forExponential/Gamma/Weibull.
- [ ] Normal visible names: Location/Dispersion.
- [ ] Lognormal visible names: Scale/Shape with natural-log parameterization note.
- [ ] Gamma/Weibull visible names: Shape/Scale.
- [ ] Replace default Fit Statistics rows withMeasures:`-2*LogLikelihood`、AICc、BIC.
- [ ] Compute only display transform`-2 * logLikelihood.value`; do not recalculate likelihood/AICc/BIC.
- [ ] KeepAIC inpayload andFit All fallback but hide it from defaultMeasures table.
- [ ] Runfit report CT、contracts andbuild.

---

### Task 5: Quantile Box Label and Interpretable Stem Output

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/StemAndLeafReport.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: four locale JSON files
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`
- Modify: kernel/service/contract tests

**Interfaces:**
- Produces: Stem`leafUnit`、interpretation key、rowCount and sign-safe rows。
- Preserves: existing public decimal method ID/compatibility as`intentionalDifference`。

- [ ] Write RED tests fornegative values in$(-scale,0)$, row counts, leaf unit and interpretation key.
- [ ] Fix sign-loss as a versioned data-expression bug without claimingJMP compatibility.
- [ ] Add Count column and key such as`0|0 represents 0`fromtyped payload, not UI inference.
- [ ] PreserveFreq behavior、Weight unavailable andomission counts.
- [ ] Rename visible Quantile Box to`Letter-Value Quantile Plot`or equivalent approved locale wording while retaining compatibility label.
- [ ] Do not change Quantile Box geometry ormethod inStage1.
- [ ] Runkernel/service/contracts/Workspace CT andbuild.

---

### Task 6: Stage 1 Acceptance and Documentation Closure

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-distribution-optimization-handbook.md`
- Modify: `docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md`
- Create: `docs/superpowers/artifacts/2026-08-31-distribution-jmp-alignment-stage-1-acceptance.md`

**Interfaces:**
- Consumes: Tasks1–5 final code andevidence。
- Produces: truthful development/automation/UI/compatibility ledger。

- [ ] Run`npm run test:distribution`、`npm run build`、`cargo test --lib`、strictClippy、four locale parse and`git diff --check`.
- [ ] RunTauri smoke and captureSummary、Capability、Nonconformance、Continuous Fit、Stem/Quantile labels.
- [ ] Record51-row visible expected values andExponential correctedMeasures.
- [ ] KeepparameterSE/CI、JMP Quantile Box、JMP Stem andexactCapability intervals deferred/pending forStages2/3.
- [ ] Request independent whole-stage review; fix blocking findings and rerun affected gates.
- [ ] Update handbook andapproved scope without promoting UI acceptance from automated evidence.

## Stage Boundary

Stage 2 begins only afterStage 1 acceptance. It ownsContinuous Fit parameter SE/CI、Normal JMP target estimator andfive-model JMP fixture. Stage 3 ownsnewJMP-target Quantile Box、Stem andexactCapability interval methods. Neither stage may silently mutate thecurrent public method IDs.
