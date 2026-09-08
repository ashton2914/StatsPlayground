# Distribution Continuous Descriptive V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为连续 Y 交付批准的 quantiles、core summary、Freedman-Diaconis histogram、Tukey box 和 weighted ECDF，并在正式 Distribution UI 中可运行、保存和验收。

**Architecture:** DuckDB executor 只安全解析 stable IDs、FilterExpr 和投影数据；新的 Rust `distribution_kernel` 对每个 By/Y 共享一次预处理与排序，生成统计表和结构化 chart-data。React 不计算统计量，Graph Builder adapter 只保留并渲染后端数值。

**Tech Stack:** Rust 2021, DuckDB, serde, statrs (许可证审核后锁定版本), Tauri v2, React 19, ECharts/Graph Builder, proptest.

**Spec:** [docs/superpowers/specs/2026-08-26-distribution-continuous-descriptive-methods-v1.md](../specs/2026-08-26-distribution-continuous-descriptive-methods-v1.md)

## Global Constraints

- Freq 逻辑重复；Weight 参与加权；同时存在贡献为 `Weight × Freq`。
- Quantile 使用规格定义的 scaled weighted Type-6，不调用 DuckDB `QUANTILE_CONT` 或第三方默认 quantile。
- Histogram 默认 Freedman-Diaconis；Distribution 冻结 bins，Graph Builder 不 re-bin。
- Missing By 独立成组并稳定排最后。
- 不实现 DESC-06/07/08/10、任何 TEST/FIT/CAP/CAT/SAVE。
- 每个 method 先 RED，再最小实现，数值结果进入 synthetic golden fixture。

---

## File Map

- Create: `src-tauri/src/engine/distribution_executor.rs`
- Create: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/engine/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/commands/distribution_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/services/distributionService.ts`
- Modify: `src/stores/useDistributionStore.ts`
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `src/components/distribution/DistributionWorkspace.tsx`
- Create: `src/components/distribution/DistributionReport.tsx`
- Create: `tests/distributionDescriptive.test.ts`
- Create: `tests/distributionDescriptiveGolden.test.ts`
- Create: `tests/e2e/DistributionDescriptive.spec.tsx`
- Create: `tests/fixtures/distribution/descriptive-v1.json`

---

## Task 1: Safe Row Materialization, Filter, Roles, and By Ordering

**Interfaces:**

```rust
pub struct PreparedObservationV1 {
    pub row_id: i64,
    pub y: f64,
    pub weight: f64,
    pub frequency: u64,
    pub contribution: f64,
}

pub struct PreparedGroupV1 {
    pub key: Vec<DistributionGroupValueV1>,
    pub observations: Vec<PreparedObservationV1>,
    pub source_rows: u64,
    pub n_missing: u64,
    pub excluded_rows: u64,
}

pub fn prepare_continuous_groups(
    engine: &DuckDbEngine,
    request: &DistributionRequestV1,
    y: &DistributionColumnRefV1,
) -> Result<Vec<PreparedGroupV1>, AppError>;
```

- [ ] Write Rust tests for missing Y, Weight/Freq exclusion/rejection, `Weight×Freq`, FilterExpr, multiple By order and Missing-last group.
- [ ] Run RED; expect module/function missing.
- [ ] Implement stable-ID resolution and parameterized SQL projection. Never concatenate user identifiers; resolve IDs to trusted metadata then quote via existing helper.
- [ ] Enforce budgets before allocating group vectors; preserve row ID order.
- [ ] Run focused tests and commit `feat(distribution): prepare continuous observations`.

## Task 2: Weighted Type-6 and Core Summary

**Interfaces:**

```rust
pub fn weighted_type6(sorted: &[PreparedObservationV1], p: f64) -> Result<f64, MethodUnavailableV1>;
pub fn continuous_summary(
    prepared: &PreparedGroupV1,
    confidence_level: f64,
) -> ContinuousSummaryV1;
```

`ContinuousSummaryV1` has typed values for N/N Missing/Mean/Std Dev/Std Error/Mean CI/Min/Max/Median/Modes/Range/IQR/MAD plus W/nEff and method provenance.

- [ ] Write exact unweighted Type-6 cases for n=1/2/5 and p=0/1, Freq logical-expansion equivalence, Weight scale invariance, Weight×Freq, ties/multiple modes, D<=0 and CI confidence validation.
- [ ] Add exact knot-hit and epsilon-boundary cases, adjacent cumulative positions within epsilon, `nEff=1`, and `1<nEff<2` Mean CI behavior with reason `summary.meanCiUnavailable.v1` where required.
- [ ] Add proptest: multiplying every Weight by a positive constant leaves weighted quantiles/mean unchanged; repeated integer Freq equals physical expansion for small bounded samples.
- [ ] Run RED.
- [ ] Implement compensated sums, scaled knots, mixed variance denominator, Kish nEff and Student-t CI using a version-pinned licensed crate.
- [ ] Run tests and commit `feat(distribution): add weighted quantiles and summary`.

## Task 3: Histogram, Tukey Box, and ECDF Kernels

**Interfaces:**

```rust
pub fn freedman_diaconis_histogram(sample: &PreparedGroupV1) -> HistogramDataV1;
pub fn tukey_box(sample: &PreparedGroupV1, confidence: f64) -> BoxPlotDataV1;
pub fn weighted_ecdf(sample: &PreparedGroupV1) -> CdfDataV1;
```

- [ ] Write failing tests for FD, Scott, Sturges and constant fallbacks; last-bin right inclusion; empty bins; probability sum 1; density integral 1.
- [ ] Write failing box tests for weighted quartiles, fence vs whisker, IQR=0, unique outlier contribution, n=1.
- [ ] Write failing ECDF tests for ties, start probability 0, final 1, Weight scale invariance and Freq expansion.
- [ ] Implement each pure kernel in `distribution_kernel.rs`; no DuckDB or UI imports.
- [ ] Run focused/golden tests and commit `feat(distribution): add descriptive chart data`.

## Task 4: Result Tree, Capability Registration, and IPC

**Interfaces:**

```rust
pub struct DistributionResultV1 {
    pub analysis_id: String,
    pub config_revision: u64,
    pub run_id: String,
    pub snapshot_id: String,
    pub source_data_version: String,
    pub exact: bool,
    pub groups: Vec<DistributionGroupResultV1>,
    pub warnings: Vec<DistributionWarningV1>,
    pub provenance: DistributionResultProvenanceV1,
}
```

Implemented registry IDs: `quantile.type6.weighted`, `summary.continuous.core`, `histogram.freedmanDiaconis`, `boxplot.tukey.weighted`, `ecdf.weighted`.

- [ ] Write contract tests for report order By→Y→registry, Histograms Only suppression, block partial/unavailable states, camelCase IPC and stale snapshot refusal before completion.
- [ ] Run RED.
- [ ] Add Rust/TS result types; integrate kernels into run coordinator; emit progress phases `prepare/sort/summary/charts/finalize`.
- [ ] Register only the five implemented capabilities; add typed frontend `startRun/cancelRun` service calls.
- [ ] Run cargo/TS contracts and commit `feat(distribution): expose continuous descriptive results`.

## Task 5: Formal Report UI and Graph Builder Rendering

**Files:**
- Create/modify frontend files listed in File Map.

- [ ] Write adapter tests proving bins/outlier contributions/ECDF coordinates survive byte-for-byte and no statistical helper is imported.
- [ ] Write Playwright CT for By/Y hierarchy, quantile/core tables, block statuses, Histograms Only, old report while updating, and no-results error states.
- [ ] Run RED.
- [ ] Implement `DistributionReport` with compact tables and collapsible report blocks; pass chart-data through `toGraphBuilderInput` to Graph Builder renderer. Do not create Distribution-specific ECharts options.
- [ ] Add all locale keys; verify no hard-coded user text except machine IDs.
- [ ] Run UI suite/build and commit `feat(distribution): render continuous descriptive reports`.

## Task 6: Golden Matrix, Performance, and Product Acceptance

- [ ] Create `descriptive-v1.json` synthetic cases covering the full spec matrix; store inputs, expected typed result and tolerance, never third-party text.
- [ ] Add Rust golden runner and TS contract runner; compare exact fields exactly and doubles by method tolerance.
- [ ] Add performance test showing each By/Y is scanned once and sorted once; Freq is never physically expanded; budgets reject before over-allocation.
- [ ] Run `npm run test:distribution`, `npm run build`, `cargo test`, and a Tauri dev smoke test.
- [ ] Update DESC-01..05/09 to `implemented/passing/pending`; create `docs/superpowers/artifacts/2026-08-26-distribution-descriptive-acceptance.md`.
- [ ] Product performs formal UI acceptance; only then update individual `uiAcceptance=passed`.
- [ ] Commit `docs(distribution): record continuous descriptive acceptance`.

## Required Verification Commands

```powershell
npm run test:distribution
npm run build
Push-Location src-tauri
cargo test
cargo clippy -- -D warnings
Pop-Location
```

Existing unrelated warnings must be documented rather than silently fixed in this plan.
