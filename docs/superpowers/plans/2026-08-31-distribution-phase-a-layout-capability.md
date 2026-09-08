# Distribution Phase A Layout and Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将Overview改为横向Count Histogram，分离Fit Density图，统一报告外边界，并修正Average Moving Range对应的Within capability interval自由度。

**Architecture:** Rust继续拥有bins、Capability指标和区间；React只负责配置与报告结构；graphCore只映射冻结坐标。Overview固定为横向Count，fit PDF移入独立Density图；Capability interval通过版本化effective-DF方法扩展现有typed payload。

**Tech Stack:** Rust 2021、statrs 0.18.0、Tauri v2、React 19、TypeScript 5.7、ECharts、Playwright CT。

**Spec:** `docs/superpowers/specs/2026-08-31-distribution-phase-a-layout-capability-design.md`

## Global Constraints

- 不改变Process Capability Histogram的竖向Density方向。
- Overview不得绘制PDF，也不得将PDF缩放到Count axis。
- Overview histogram tuple固定为`[count, lower, upper]`；metadata不得进入坐标维度。
- Fit Density直接消费Rust返回的bin density和PDF coordinates，不在TypeScript重算。
- Within interval使用公开Moving Range effective-DF近似，状态保持`compatibilityPending`。
- Overall interval、Weight/Freq、By、Missing与四键run identity不得回归。
- 所有available numeric fields必须finite；Rust非测试代码禁止`unwrap()`/`expect()`。
- Tauri人工验收通过前，`uiAcceptance`保持`pending`。

---

### Task 1: Moving Range Evidence Fixture

**Files:**
- Create: `tests/fixtures/distribution/process-capability-moving-range-v1.json`
- Modify: `tests/fixtures/distribution/README.md`
- Modify: `src-tauri/src/services/normal_capability.rs`

**Interfaces:**
- Produces: machine-only `MovingRangeCapabilityFixtureV1` test input。
- Produces: stable 51-row observation order and public/JMP result sections。
- Consumes: ignored local synthetic source `xumax-test/tabulate-validation-2026-08-24/tabulate-validation-5000.csv` only during fixture creation。

- [ ] **Step 1: Add a failing fixture loader test**

In `normal_capability.rs` tests, deserialize:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MovingRangeCapabilityFixtureV1 {
    schema_version: String,
    case_id: String,
    observations: Vec<f64>,
    specification: SpecificationLimitsV1,
    expected_summary: MovingRangeExpectedSummaryV1,
    public_method_expected: MovingRangeExpectedIntervalsV1,
    jmp19_observed_rounded: MovingRangeExpectedIntervalsV1,
}
```

Assert schema `1`, case ID `missingRegion.salesAmount.n51`, exactly51 observations, first value`318.29`, and stable SHA-256 of the canonical observations array.

- [ ] **Step 2: Run the test and verify RED**

```powershell
Set-Location src-tauri
cargo test moving_range_fixture -- --nocapture
```

Expected: FAIL because the tracked fixture does not exist.

- [ ] **Step 3: Create the machine-only fixture**

Use this read-only extraction command to obtain the exact source-order observations:

```powershell
Import-Csv .\xumax-test\tabulate-validation-2026-08-24\tabulate-validation-5000.csv |
  Where-Object { [string]::IsNullOrWhiteSpace($_.region) -and -not [string]::IsNullOrWhiteSpace($_.sales_amount) } |
  ForEach-Object { [double]$_.sales_amount }
```

Create JSON via `apply_patch`; tests must never read `xumax-test/`. Include:

```json
{
  "schemaVersion": "1",
  "caseId": "missingRegion.salesAmount.n51",
  "observations": [],
  "specification": { "lsl": 1000, "target": 2000, "usl": 3000, "source": "analysisOverride" },
  "expectedSummary": {
    "n": 51,
    "mean": 523.723921568627,
    "movingRangeAverage": 677.5516,
    "withinSigma": 600.464471303597,
    "overallSigma": 731.775276729348
  },
  "publicMethodExpected": {
    "withinEffectiveDegreesOfFreedom": 30.43832706934947,
    "cplLower": -0.3774430508448331,
    "cplUpper": -0.15134324842045088,
    "cpuLower": 1.0174188071238934,
    "cpuUpper": 1.7318707809349665
  },
  "jmp19ObservedRounded": {
    "cplLower": -0.376,
    "cplUpper": -0.150,
    "cpuLower": 1.021,
    "cpuUpper": 1.726
  },
  "compatibilityStatus": "compatibilityPending"
}
```

Populate `observations` with all51 extracted values in source order.

- [ ] **Step 4: Verify fixture and current point estimates**

Run:

```powershell
cargo test moving_range_fixture
```

Expected: PASS for summary, MR order and point estimates; interval assertions remain deferred toTask2.

- [ ] **Step 5: Update fixture README**

Document that fixtures are synthetic machine-only evidence, may include literal observations, must not include screenshots/free text/absolute paths, and separate public expected values from third-party observed rounded values.

---

### Task 2: Moving Range Effective-DF Interval Math

**Files:**
- Modify: `src-tauri/src/services/normal_capability.rs`
- Test: unit tests in the same file

**Interfaces:**
- Consumes: `NormalProcessSummaryV1`, `NormalCapabilityIndicesV1`, Task1 fixture。
- Produces: `moving_range_effective_degrees_of_freedom(n: u64) -> Option<f64>`。
- Produces: parameterized `wald_interval(point,n,degrees_of_freedom,alpha,method)`。

- [ ] **Step 1: Write failing effective-DF tests**

Assert:

```rust
assert_eq!(moving_range_effective_degrees_of_freedom(2), None);
assert_close(
    moving_range_effective_degrees_of_freedom(51).unwrap(),
    30.43832706934947,
);
```

Calculate expected value literally from the approved formula, not by calling another production helper.

- [ ] **Step 2: Write failing n=51 interval tests**

Load Task1 fixture, call `normal_process_summary`, `capability_indices`, and `capability_intervals`; assert public expected Cpl/Cpu values with `abs<=1e-10 || rel<=1e-9`.

Also assert:

- Within Cp method=`movingRangeEffectiveDfChiSquare.v1`。
- Cpl/Cpu/Cpk method=`movingRangeEffectiveDfWald.v1`。
- Overall Pp/Ppl/Ppu/Ppk values and method IDs remain unchanged。
- $n<3$ remains typed unavailable。

- [ ] **Step 3: Run tests and verify RED**

```powershell
cargo test moving_range_effective_df
cargo test moving_range_fixture
```

Expected: FAIL because current code always uses$n-1$ and `wald.v1`.

- [ ] **Step 4: Implement effective DF**

Implement exact constants:

```rust
let m = (n - 1) as f64;
let d2 = 2.0 / PI.sqrt();
let variance = 2.0 * (1.0 - 2.0 / PI);
let adjacent_covariance = 1.0 / 3.0 + (2.0 * 3.0_f64.sqrt() - 4.0) / PI;
let relative_variance =
    (m * variance + 2.0 * (m - 1.0) * adjacent_covariance) /
    (m * m * d2 * d2);
let effective_df = 1.0 / (2.0 * relative_variance);
```

Reject nonfinite/nonpositive results with `None`.

- [ ] **Step 5: Parameterize interval helpers**

Pass `$\nu_{MR}$` to Within Cp/Cpl/Cpu/Cpk and `$n-1$` to Overall Pp/Ppl/Ppu/Ppk. Preserve Cpm unavailable states.

- [ ] **Step 6: Run focused and full Rust tests**

```powershell
cargo test moving_range_effective_df
cargo test moving_range_fixture
cargo test services::normal_capability::tests
cargo test --lib
```

Expected: all PASS; no NaN/Infinity.

---

### Task 3: Capability Interval Contract and Dynamic 95% Headers

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/ProcessCapabilityReport.tsx`
- Modify: four locale JSON files
- Modify: `tests/distributionContracts.test.ts`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Consumes: Task2 interval results and effective DF。
- Produces: `ProcessCapabilityIntervalsV1.confidenceLevel`。
- Produces: `ProcessCapabilityIntervalProvenanceV1.withinEffectiveDegreesOfFreedom`。

- [ ] **Step 1: Write failing Rust/TS contract tests**

Require camelCase payload:

```json
{
  "confidenceLevel": 0.95,
  "provenance": {
    "withinEffectiveDegreesOfFreedom": 30.43832706934947
  }
}
```

Old project result payloads are not archived, so no result migration is required. All manually constructed test payloads must add the new fields.

- [ ] **Step 2: Write failing UI tests**

For confidence `0.95`, assert column headers `Lower 95%` and `Upper 95%`. Add a `0.90` fixture and assert `Lower 90%`/`Upper 90%`. Assert fixed `Lower CI`/`Upper CI` are absent.

- [ ] **Step 3: Run tests and verify RED**

```powershell
npx tsc -p tests/tsconfig.contracts.json --noEmit
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx --grep "Capability"
```

- [ ] **Step 4: Extend mirrored contracts and mapper**

Rust:

```rust
pub struct ProcessCapabilityIntervalsV1 {
    pub confidence_level: f64,
    // existing intervals
    pub provenance: ProcessCapabilityIntervalProvenanceV1,
}

pub struct ProcessCapabilityIntervalProvenanceV1 {
    // existing fields
    pub within_effective_degrees_of_freedom: Option<f64>,
}
```

Mirror exact optionality inTypeScript. Populate from `capability_intervals` and service mapper.

- [ ] **Step 5: Implement dynamic labels**

Compute:

```ts
const confidencePercent = Number((data.intervals.confidenceLevel * 100).toFixed(6));
```

Use i18n keys `lowerConfidence`/`upperConfidence` with `{{confidence}}` in all four locales.

- [ ] **Step 6: Run contracts, UI and build**

```powershell
npm run test:distribution:contracts
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx --grep "Capability"
npm run build
```

---

### Task 4: Horizontal Count Overview

**Files:**
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `src/components/distribution/DistributionChart.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `tests/distributionGraphAdapter.test.ts`
- Modify: `tests/e2e/DistributionCharts.spec.tsx`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Consumes: existing `histogramData`, `boxPlotData`, specification lines。
- Produces: horizontal Count-only `buildDistributionOverviewOption`。
- Removes: `fitCurves` from Overview option/component contract。

- [ ] **Step 1: Replace old adapter expectations with RED tests**

Assert Overview option has:

```ts
xAxis[0] = value axis with [0,countMax]
yAxis[0] = value axis with [valueMin,valueMax]
series[0].data = [[count, lower, upper], ...]
```

For box panel assert `xAxis[1]` category, `yAxis[1]` shared value extent, box/outlier indices `1`, and all specification markLines use`yAxis`.

Assert fit curve points do not affect Overview extent or series.

- [ ] **Step 2: Run adapter test and verify RED**

```powershell
npm run test:distribution:adapter
```

- [ ] **Step 3: Implement horizontal custom bars**

Use `api.coord([count, upper])` and `api.coord([0, lower])`; return one unclippedrect with `clip:true`. For count zero, width must be zero; do not use`Math.max(1,...)`.

Use a leftHistogram grid and rightBox grid with safe outer right gutter. OnlyHistogram spec labels are visible.

- [ ] **Step 4: Remove fit curves from Overview wiring**

`DistributionReport` continues collecting successful fit curves but does not pass them into Overview. Preserve `Show Fit Curves` preference forTask5.

- [ ] **Step 5: Run adapter and canvas tests**

```powershell
npm run test:distribution:adapter
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionCharts.spec.tsx --grep "Overview"
```

Expected: horizontalCount Overview nonblank; no PDF line in Overview.

---

### Task 5: Independent Fit Density Chart

**Files:**
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `src/components/distribution/DistributionChart.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/components/distribution/distribution.css`
- Modify: four locale JSON files
- Modify: `tests/distributionGraphAdapter.test.ts`
- Modify: `tests/e2e/DistributionCharts.spec.tsx`
- Modify: `tests/e2e/ContinuousFitReport.spec.tsx`

**Interfaces:**
- Consumes: histogram bins and `DistributionFitCurveInputV1[]`。
- Produces: `buildDistributionFitDensityOption(...)` and `DistributionFitDensityChart`。

- [ ] **Step 1: Write failing adapter tests**

Assert:

- X=value、Y=Probability Density。
- Histogram uses backend `bin.density`。
- PDF tuples equal backend coordinates byte-for-byte。
- stable legend/order/color by`distributionId`。
- extent includes bins and curves。
- empty fit array does not render a Fit Density block。

- [ ] **Step 2: Write failing canvas and toggle tests**

Mount two curves and require nonblankcanvas. Toggle`Show Fit Curves` off and assert Fit Density chart disappears while horizontal Overview remains.

- [ ] **Step 3: Run tests and verify RED**

```powershell
npm run test:distribution:adapter
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionCharts.spec.tsx tests/e2e/ContinuousFitReport.spec.tsx --grep "Fit Density"
```

- [ ] **Step 4: Implement builder and component**

Reuse ECharts lifecycle from`DistributionOverviewChart`. Histogram custom tuple remains coordinate-only; useclosure for`upper`. Use localized title`distribution.report.fitDensity`.

- [ ] **Step 5: Wire report visibility**

Render immediately afterOverview when`fitCurves.length>0 && visible.fitOverlays!==false`. Do not changeconfig revision or rerun.

- [ ] **Step 6: Run focused and full frontend tests**

```powershell
npm run test:distribution:adapter
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionCharts.spec.tsx tests/e2e/ContinuousFitReport.spec.tsx --grep "Fit Density"
npm run build
```

---

### Task 6: Unified Report Bounds and Phase A Acceptance

**Files:**
- Modify: `src/components/distribution/distribution.css`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`
- Modify: `docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md`
- Create: `docs/superpowers/artifacts/2026-08-31-distribution-phase-a-layout-capability-acceptance.md`

**Interfaces:**
- Consumes: Tasks2–5 final report surfaces。
- Produces: unified report gutter/grid and final acceptance evidence。

- [ ] **Step 1: Write failing three-viewport layout tests**

Mount one complete result containingOverview、Quantiles/Summary、Capability、Fit Density、Fit Comparison。For`1440x900`、`1024x700`、`768x900`measure each top-level surface:

```ts
expect(Math.abs(surface.x - reference.x)).toBeLessThanOrEqual(2);
expect(Math.abs((surface.x + surface.width) - referenceRight)).toBeLessThanOrEqual(2);
expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
```

Atwide viewports assert paired cells share topwithin3px; at768 assert single-column order.

- [ ] **Step 2: Run layout CT and verify RED**

```powershell
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx --grep "aligned report bounds"
```

- [ ] **Step 3: Implement unified CSS grid**

Set one gutter on`.distribution-y-content`; apply`width:100%; min-width:0; box-sizing:border-box` to report surfaces and chart containers. Remove Quantiles fixed width. Standardize dual grids to18px gap and900px breakpoint. Add local overflow wrappers only where table minimum readable width exceeds viewport.

- [ ] **Step 4: Run complete automated gates**

```powershell
npm run test:distribution
npm run build
Set-Location src-tauri
cargo test --lib
cargo clippy --lib -- -D warnings
Set-Location ..
$files = Get-ChildItem .\src\i18n\locales\*.json
$files | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json | Out-Null }
git diff --check
```

Record strictClippy baseline separately; do not add blanket allows.

- [ ] **Step 5: Run Tauri visual acceptance**

On the51-rowmissing-region group verify:

1. Overview horizontalCount bars and right-sideBox share`sales_amount`Y axis。
2. LSL/Target/USL labels remain visible and do not overlap scrollbar。
3. Fit Density is separate and PDFs align toDensity scale。
4. Overview、tables、Capability、Fit reports outer edges align inwide/narrow windows。
5. Capability headings show`Lower 95% / Upper 95%`。
6. Within intervals useeffective-DF public method; Overall intervals remain unchanged。

- [ ] **Step 6: Update scope and acceptance artifact**

Record development/automation/UI/compatibility dimensions separately. Keep`uiAcceptance=pending` unless the formal scenarios are signed off. KeepJMP exact interval compatibility`pending` and record public-vs-observed differences.

## Execution Notes

- Task1→Task2→Task3 is the statistical contract chain。
- Task4→Task5 is the chart chain。
- Task6 waits for both chains。
- Tasks1 and4 may be implemented independently, but shared full-gate runs remain sequential。
- Do not create task commits unless the user explicitly requests commits; use scoped diff checkpoints during execution。
