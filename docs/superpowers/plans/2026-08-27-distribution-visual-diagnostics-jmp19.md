# Distribution Visual Diagnostics JMP 19 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 JMP 19 数值兼容目标下的 Distribution 可视化诊断、Histogram 控制、报告布局优化和 Overview/Capability 图形修复。

**Architecture:** Rust kernel 在一次 Y/group run 中预计算 Histogram、Normal Quantile、Quantile Box、Stem and Leaf、ECDF 与 Capability chart-data；React 只控制显示偏好与报告布局；graphCore 只映射后端坐标。官方公开公式直接形成 documented contract，未公开细节先进入脱敏黑盒兼容矩阵，通过前保持 `compatibilityPending`。

**Tech Stack:** Rust 2021, statrs 0.18.0, DuckDB, Tauri v2, React 19, TypeScript 5.7, Zustand 5, ECharts, Playwright CT.

**Spec:** [docs/superpowers/specs/2026-08-27-distribution-visual-diagnostics-jmp19-design.md](../specs/2026-08-27-distribution-visual-diagnostics-jmp19-design.md)

## Global Constraints

- 不复制 JMP 代码、界面、截图、帮助正文或自由文本输出。
- `documentedCompatible` 只用于官方公开公式与自动矩阵均通过的方法。
- `validatedCompatible` 只用于脱敏 synthetic 黑盒矩阵通过的方法。
- 浮点兼容容差为 `abs <= 1e-10` 或 `rel <= 1e-9`。
- React 与 graphCore 不排序样本、不 re-bin、不计算 quantile、normal score、density、stem 或 capability。
- Custom ECharts series 返回单一 shape，不声明 `encode`，并设置 `clip:true`。
- 计算配置更新 `configRevision`；显示偏好不更新 revision。
- Weight 下 Normal Quantile Plot 与 Stem and Leaf 返回 typed unavailable。
- 正式 UI 验收必须由产品负责人在 Tauri 应用中执行。

---

## Task 1: JMP 19 Compatibility Evidence Matrix

**Files:**
- Create: `tests/fixtures/distribution/jmp19-visual-diagnostics-v1.json`
- Create: `tests/distributionVisualCompatibility.test.ts`
- Modify: `docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md`
- Modify: `docs/superpowers/artifacts/2026-08-27-distribution-formal-report-acceptance.md`

**Interfaces:**
- Produces sanitized cases with `caseId`, `methodId`, `inputHash`, numeric/enum outputs, `jmpVersion`, and `compatibilityStatus`.
- No case stores screenshots, proprietary project files, help prose, visible column names, or absolute paths.

- [ ] **Step 1: Add fixture schema RED**

Create a TS test that rejects free text/path fields and requires exact machine keys:

```ts
assert.deepEqual(Object.keys(caseItem).sort(), [
  "caseId", "compatibilityStatus", "expected", "input", "inputHash",
  "jmpVersion", "methodId", "schemaVersion",
]);
assert.match(caseItem.inputHash, /^sha256:[0-9a-f]{64}$/);
```

- [ ] **Step 2: Run RED**

Run `npx tsx tests/distributionVisualCompatibility.test.ts` and expect missing fixture failure.

- [ ] **Step 3: Record synthetic matrix**

Include deterministic cases for:

- Normal scores: `n=1,2,3,5,10`, ties, negative values, zero, Freq.
- Histogram: constant, narrow decimal, mixed sign, outlier, exact-boundary values, `n=1..20`, each scale.
- Quantile Box: `n=1..20`, ties, odd/even, outliers, Freq, Weight.
- Stem and Leaf: positive/negative/zero/decimal/repeated/extreme scale/Freq.

Each expected result contains only numbers, booleans, nulls, machine enums and arrays thereof.

- [ ] **Step 4: Implement comparator**

Use exact comparison for structural fields and:

```ts
const compatibleFloat = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= 1e-10 ||
  Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(actual), Math.abs(expected));
```

- [ ] **Step 5: Run GREEN**

Run the compatibility test and `git diff --check`.

## Task 2: Versioned Config and Result Contracts

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/distributionConfig.ts`
- Modify: `tests/distributionContracts.test.ts`
- Modify: `tests/distributionConfig.test.ts`
- Modify: `tests/distributionArchive.test.ts`

**Interfaces:**
- Produces `DistributionVisualDiagnosticsConfigV1` and `DistributionYReportPreferencesV2` from the spec.
- Produces chart-data variants `normalQuantileData`, `quantileBoxData`, and report payload `stemAndLeafData`.
- Every method payload includes `methodId`, `methodVersion`, `compatibilityStatus`, and snapshot provenance.

- [ ] **Step 1: Write contract RED**

Assert defaults and validation:

```ts
assert.equal(config.visualDiagnostics.histogram.method, "jmpAuto");
assert.equal(config.reportPreferences?.["col-y"]?.normalQuantilePlot, false);
assert.equal(validate({ method: "fixedCount", fixedCount: 0 })[0].fieldPath,
  "visualDiagnostics.histogram.fixedCount");
```

- [ ] **Step 2: Run RED**

Run `npx tsx tests/distributionContracts.test.ts` and `npx tsx tests/distributionConfig.test.ts`.

- [ ] **Step 3: Implement mirrored contracts**

Add serde camelCase Rust structs and exact TS interfaces. Use `#[serde(default)]` for newly added archive fields so V1 documents remain readable.

- [ ] **Step 4: Extend archive fixture**

Save/reopen non-default fixed width, density scale, Normal Quantile enabled, and horizontal tables disabled. Assert deep equality after store load.

- [ ] **Step 5: Run GREEN**

Run contract/config/archive tests, `cargo test models::distribution --lib`, and `npm run build`.

## Task 3: Histogram Methods and Overview Axis Repair

**Files:**
- Modify: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `tests/distributionGraphAdapter.test.ts`
- Modify: `tests/e2e/DistributionCharts.spec.tsx`
- Add Rust kernel/service tests.

**Interfaces:**
- Consumes `visualDiagnostics.histogram` config.
- Produces frozen bins containing `lower`, `upper`, `count`, `probability`, `density`.
- Overview builder additionally consumes optional Capability specification lines.

- [ ] **Step 1: Write kernel RED**

Add analytic tests for FD, Scott, Sturges, fixed count/width, constant values, Weight/Freq normalization and invalid bounds. For `jmpAuto`, compare exact bins from Task 1 fixture.

- [ ] **Step 2: Run RED**

Run `cargo test services::distribution_kernel::tests::histogram --lib` and expect missing method dispatch.

- [ ] **Step 3: Implement backend methods**

Create one dispatcher:

```rust
pub(crate) fn histogram(
    sample: &PreparedGroupV1,
    config: &HistogramConfigV1,
) -> Result<HistogramKernelV1, AppError>;
```

All bins are generated in Rust. `jmpAuto` uses only the rule proven by Task 1; if fixture coverage is insufficient, return `compatibilityPending` rather than substituting FD silently.

- [ ] **Step 4: Write adapter RED for axis isolation**

Use fixture count `17_445_714`, value max `8_554.68`, and specs `0/3_000/6_000`. Assert count axis max is `17_445_714`, both value axes max cover `8_554.68`, no value-axis label/extent equals the count, and both grids receive spec mark lines.

- [ ] **Step 5: Repair Overview adapter**

Keep coordinate tuples minimal: histogram series data `[metric, lower, upper]`; bind style metadata through `params.dataIndex`. Explicitly set count/value bounds. Add spec-line carrier series per grid with `clip:true` where applicable.

- [ ] **Step 6: Verify GREEN**

Run Rust histogram tests, adapter test, chart canvas CT and `npm run build`.

## Task 4: JMP 19 Normal Quantile Plot

**Files:**
- Modify: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Add Rust tests and Playwright CT.

**Interfaces:**
- Produces `NormalQuantileDataV1 { points, referenceLine, confidenceBand, status, provenance }`.
- A point contains `rank`, `probability`, `normalScore`, and `observedValue`.

- [ ] **Step 1: Write documented formula RED**

For unique unweighted values assert:

$$
p_i=\frac{r_i}{N+1},\qquad z_i=\Phi^{-1}(p_i).
$$

Compare `z_i` with Task 1 JMP 19 fixture at the global compatibility tolerance. Add ties and Freq tests from the fixture. Add Weight unavailable test with exact reason code.

- [ ] **Step 2: Run RED**

Run focused Rust normal-quantile tests and expect missing kernel.

- [ ] **Step 3: Implement normal scores**

Use `statrs::distribution::Normal(0,1).inverse_cdf`. Implement logical ranks without materializing Freq-expanded rows. Downsample only the emitted coordinates using a deterministic rank grid after all rank values are computed.

- [ ] **Step 4: Gate reference line and band**

Reference-line and pointwise-band method IDs are distinct from normal scores. Mark each `validatedCompatible` only if its Task 1 matrix passes; otherwise emit the coordinates with `compatibilityPending` provenance.

- [ ] **Step 5: Render**

graphCore maps backend points, line and band directly. Add nonblank canvas CT and assert source code contains no inverse-CDF or quantile calculation.

- [ ] **Step 6: Run GREEN**

Run focused Rust tests, compatibility test, adapter test, CT and build.

## Task 5: Quantile Box and Stem-and-Leaf

**Files:**
- Modify: backend kernel/service/models.
- Modify: TS types and `DistributionReport.tsx`.
- Create: `src/components/distribution/StemAndLeafReport.tsx`.
- Modify: graphCore adapter and tests.

**Interfaces:**
- Produces ordered `QuantileBoxLayerV1` arrays and typed `StemAndLeafDataV1`.
- Both payloads expose `compatibilityStatus`; no UI inference from coordinates.

- [ ] **Step 1: Write black-box matrix RED**

Load Task 1 exact fixtures. Assert every Quantile Box layer and every stem/leaf token. Assert Weight states and Freq equivalence.

- [ ] **Step 2: Run RED**

Run focused compatibility and Rust tests; expect missing kernels.

- [ ] **Step 3: Implement only proven rules**

Implement rank/layer and stem scaling rules recovered from the complete fixture matrix. If multiple rules fit the fixture, add a discriminating synthetic case before production code. Never choose a rule by visual resemblance.

- [ ] **Step 4: Add bounded display metadata**

Return at most 200 displayed stems and 120 leaves per stem plus exact omitted counts. Full output request must reject budgets beyond existing resource limits.

- [ ] **Step 5: Render and verify**

Render Quantile Box via precomputed layers and Stem-and-leaf via semantic table/preformatted rows. Add narrow-window CT, omitted-count assertions and canvas pixel test.

## Task 6: Menus, Table Layout, and Compact Nonconformance

**Files:**
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/components/distribution/ProcessCapabilityReport.tsx`
- Modify: `src/components/distribution/distribution.css`
- Modify: four locale JSON files.
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Consumes Task 2 preferences and Task 3-5 real blocks.
- Produces grouped menus; no menu item appears without a real backend payload or supported config path.

- [ ] **Step 1: Write UI RED**

Assert grouped menu labels, default visibility, persisted toggles, histogram calculation option callback, scale-only immediate update, and no Test/Fit/Save items.

- [ ] **Step 2: Add layout RED**

At `1024x700`, Quantiles and Summary have different x positions and aligned top edges. At `768x900`, they share x position and stack. Assert visible outer/row/column borders.

- [ ] **Step 3: Add Nonconformance RED**

Assert exactly three body rows and five columns: Region, Observed Count, Observed PPM, Expected Within PPM, Expected Overall PPM. Assert proportion and Wilson CI are absent from default visible text.

- [ ] **Step 4: Implement UI**

Use Display, Histogram, Diagnostic Plots and Process Capability sections. Use native buttons/checkbox semantics, Escape closing and focus return. Do not reproduce JMP menu visuals.

- [ ] **Step 5: Run GREEN**

Run focused CT, parse all four locale JSON files, and run build.

## Task 7: Integration, Compatibility Ledger, and Product Acceptance

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md`
- Create: `docs/superpowers/artifacts/2026-08-27-distribution-visual-diagnostics-acceptance.md`
- Modify relevant golden/black-box runners.

- [ ] **Step 1: Run automated gates**

```powershell
npm run test:distribution
npm run build
Push-Location src-tauri
cargo test --lib
cargo clippy --lib -- -D warnings
Pop-Location
```

Parse four locale JSON files and run `git diff --check`.

- [ ] **Step 2: Update method statuses**

Set each method independently to `documentedCompatible`, `validatedCompatible`, `compatibilityPending`, or `intentionalDifference`. Never promote a parent feature because one child method passed.

- [ ] **Step 3: Tauri smoke**

Run a real multi-By dataset with specs. Verify Overview specs, no `17445714` value-axis label, menu persistence, all optional reports, compact Nonconformance and fixed-window scrolling.

- [ ] **Step 4: Product acceptance**

Keep `uiAcceptance=pending` until the product owner performs and records the formal scenarios. Automated evidence cannot set it to passed.