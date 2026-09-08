# Distribution Normal Process Capability V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在连续描述能力完成后，交付从列属性或当前分析 override 获取规格限的 Normal Individuals Process Capability 报告、indices、置信区间、超规 PPM 和 Graph Builder 图形。

**Architecture:** 后端在 snapshot 内读取权威列 extras 并解析 override，复用 continuous prepared observations/histogram，独立 `normal_capability` kernel 计算所有 capability 数值。Weight/Freq 时 capability block 显式 unavailable；Graph Builder 只渲染预计算 density/规格线。

**Tech Stack:** Rust 2021, DuckDB, serde, version-pinned statistical distribution crate, Tauri v2, React 19, Graph Builder/ECharts, Playwright CT.

**Spec:** [docs/superpowers/specs/2026-08-26-distribution-normal-capability-method-v1.md](../specs/2026-08-26-distribution-normal-capability-method-v1.md)

## Global Constraints

- 只支持 Normal Individuals、moving range window 2。
- 默认权威来源是 Table `extras.spec`; 分析 override 按字段覆盖且不回写。
- 无 LSL/USL 时 block absent；Target-only 不启用。
- Weight/Freq 使 capability unavailable，不能静默忽略。
- 不实现 CAP-14..20、通用拟合、nonnormal 或情景分析。
- 每项数值使用 typed availability state，禁止用裸 null 混淆语义。

---

## File Map

- Create: `src-tauri/src/services/normal_capability.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/engine/distribution_executor.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/DistributionDialog.tsx`
- Create: `src/components/distribution/SpecificationLimitsEditor.tsx`
- Create: `src/components/distribution/ProcessCapabilityReport.tsx`
- Modify: `src/graphCore/distributionAdapter.ts`
- Create: `tests/distributionCapability.test.ts`
- Create: `tests/distributionCapabilityGolden.test.ts`
- Create: `tests/e2e/DistributionCapability.spec.tsx`
- Create: `tests/fixtures/distribution/normal-capability-v1.json`

---

## Task 1: Specification Source Contract and Backend Column Extras

**Interfaces:**

```rust
pub struct SpecificationLimitsV1 {
    pub lsl: Option<f64>,
    pub target: Option<f64>,
    pub usl: Option<f64>,
    pub source: SpecificationSourceV1,
}

pub fn resolve_specification_limits(
    column_extras: Option<&serde_json::Value>,
    override_value: Option<&SpecificationOverrideV1>,
) -> Result<SpecificationResolutionV1, AppError>;
```

- [ ] Write failing tests for no spec, Target-only, each one-sided case, double-sided, override add/remove, no writeback, invalid finite/order/Target bounds, invalid column warning vs invalid override error.
- [ ] Add contract tests for `CapabilityOverrideEnvelopeV1`: exact capability ID, payload version `1`, only lsl/target/usl fields, duplicate/unknown envelope rejection.
- [ ] Run RED.
- [ ] Add a backend service method that retrieves column display extras by stable column ID from snapshot state; do not trust frontend extras.
- [ ] Implement pure resolver and stable codes `capability.invalidColumnSpec.v1` / `capability.invalidOverride.v1`.
- [ ] Run tests and commit `feat(distribution): resolve capability specifications`.

## Task 2: Process Summary and Sigma Kernels

**Interfaces:**

```rust
pub struct NormalProcessSummaryV1 {
    pub n: u64,
    pub mean: f64,
    pub moving_range_average: TypedValueV1,
    pub d2: f64,
    pub within_sigma: TypedValueV1,
    pub overall_sigma: TypedValueV1,
}

pub fn normal_process_summary(observations_in_row_order: &[f64]) -> NormalProcessSummaryV1;
```

- [ ] Write exact tests for row order, n=0/1/2, constant, missing-filtered adjacency, By groups, and `d2=2/sqrt(pi)`.
- [ ] Add test proving sorting by Y would change MR and is not used.
- [ ] Run RED.
- [ ] Implement compensated mean/variance and MR in a pure module; no Weight/Freq code path.
- [ ] Run tests and commit `feat(distribution): compute normal process sigma`.

## Task 3: Capability Indices and Typed States

**Interfaces:**

```rust
pub enum NumericStateV1 { Available, NotApplicable, Unavailable, Unbounded }
pub struct TypedValueV1 { pub state: NumericStateV1, pub value: Option<f64>, pub reason_code: Option<String> }
pub fn capability_indices(summary: &NormalProcessSummaryV1, specs: &SpecificationLimitsV1) -> NormalCapabilityIndicesV1;
```

- [ ] Write failing analytic tests for double-sided Cp/Cpk/Cpl/Cpu/Pp/Ppk/Ppl/Ppu/Cpm, LSL-only, USL-only, mean outside spec (negative indices), no Target, and sigma=0 typed states.
- [ ] Run RED.
- [ ] Implement formulas exactly from spec; never clamp negatives or serialize infinity.
- [ ] Add proptest monotonicity: widening specs cannot decrease potential Cp/Pp when sigma fixed.
- [ ] Run tests and commit `feat(distribution): add normal capability indices`.

## Task 4: Confidence Intervals and Nonconformance

**Interfaces:**

```rust
pub fn capability_intervals(summary: &NormalProcessSummaryV1, indices: &NormalCapabilityIndicesV1, confidence: f64) -> CapabilityIntervalsV1;
pub fn capability_nonconformance(observations: &[f64], summary: &NormalProcessSummaryV1, specs: &SpecificationLimitsV1, confidence: f64) -> NonconformanceV1;
```

- [ ] Write failing tests for chi-square Cp/Pp CI, Wald one-sided indices, limiting side/tie behavior, Cpm CI deferred state, Wilson observed CI, expected within/overall Normal tails, equality-at-limit conforming, extreme tail log-CDF.
- [ ] Add n<3 unavailable and non-finite inverse-CDF guard tests; assert provenance records crate name/version, parameterization and algorithm ID.
- [ ] Run RED.
- [ ] Add and license-audit a pinned Rust crate for Normal/chi-square inverse CDF; record version and parameterization in provenance.
- [ ] Implement intervals/tails with finite guards and typed failures.
- [ ] Run tests and commit `feat(distribution): add capability intervals and ppm`.

## Task 5: Distribution Integration and Capability Registry

- [ ] Write failing integration tests: block absent with no spec, automatic column spec, override persistence, Weight/Freq unavailable while descriptive blocks stay available, invalid override global failure, column spec change stales run.
- [ ] Add `ProcessCapabilityBlockV1` Rust/TS contracts and capability ID `capability.normal.individuals` only after integration test passes.
- [ ] Reuse prepared row order and histogram; compute summary/indices/interval/nonconformance once per By/Y.
- [ ] Emit capability progress after descriptive charts and before finalize.
- [ ] Run cargo/contracts and commit `feat(distribution): integrate normal capability reports`.

## Task 6: Specification Editor and Formal Report UI

- [ ] Write CT tests for column-property values, override badge, field-level remove, invalid input, no-spec hidden block, one-sided fields, Weight/Freq unavailable reason and no Table writeback call.
- [ ] Implement `SpecificationLimitsEditor` in Edit Inputs using numeric inputs and source indicators; no competitor copy/layout.
- [ ] Implement compact report sections: Process Summary, Within/Overall indices with CI, observed/expected table and typed warnings.
- [ ] Pass capability chart-data through adapter; Graph Builder renders histogram, Normal density, specification lines and tail highlighting without recomputing.
- [ ] Run UI/build and commit `feat(distribution): render normal capability analysis`.

## Task 7: Golden Matrix and Product Acceptance

- [ ] Create synthetic fixture matrix for all spec states, including column extras and overrides.
- [ ] Add Rust golden and TS preservation runners with exact/tolerance fields.
- [ ] Run `npm run test:distribution`, `npm run build`, `cargo test`, `cargo clippy -- -D warnings` and Tauri smoke.
- [ ] Update CAP-01..13 to `implemented/passing/pending`; create `docs/superpowers/artifacts/2026-08-26-distribution-normal-capability-acceptance.md`.
- [ ] Product performs the eight Normal Capability UI scenarios in the scope ledger. Only passed scenarios update `uiAcceptance=passed`.
- [ ] Commit `docs(distribution): record normal capability acceptance`.

## Required Verification Commands

```powershell
npm run test:distribution
npm run build
Push-Location src-tauri
cargo test
cargo clippy -- -D warnings
Pop-Location
```
