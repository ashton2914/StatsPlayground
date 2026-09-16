# Issue 191 Distribution 统计参数优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Distribution Summary、Continuous Fit、多分布拟合、曲线颜色和 Cpm confidence interval 的端到端优化，满足 GitHub Issue #191。

**Architecture:** Rust 继续拥有拟合和 capability 统计计算；TypeScript 只负责持久化配置、请求适配和共享 Analysis presentation。`ContinuousDistributionIdV1` 是跨语言分布身份，`fitAll` 是独立布尔合同；报告 swatch 与 ECharts fitted curve 通过同一个纯颜色解析函数保持一致。

**Tech Stack:** Tauri v2、Rust 2021、statrs 0.19.1、argmin 0.11.0、React 19、TypeScript、Playwright Component Testing、ECharts graphCore、Zustand Analysis lifecycle。

**Spec:** `docs/superpowers/specs/2026-09-14-issue-191-distribution-statistics-optimization-design.md`

## Global Constraints

- 新建 Distribution 默认 `fitDistributions: ["normal"]`、`fitAll: false`。
- Rust 是统计权威；前端不得计算 PDF、MLE 或 Cpm interval。
- Compatibility 与 convergence 保留在 payload/provenance，只从成功结果的可见报告中移除。
- Cpm interval 使用 spec 定义的 log-delta approximation，并升级 method provenance；不得标记为 JMP compatible。
- 所有 Analysis document、request identity、archive validator 和 Rust/TS 枚举必须保持精确一致。
- 每个 production change 必须先有能够因缺失行为而失败的 RED test。
- 不修改不相关统计方法，不删除 payload 中现有 summary 字段，不改变 Quantiles 的 Minimum/Maximum。

---

### Task 1: 合并 Summary 并精简 Fit 报告

**Files:**
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/components/distribution/ContinuousFitReport.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: `tests/e2e/ContinuousFitReport.spec.tsx`
- Test: `tests/analysisView.spec.tsx`
- Test: `tests/distributionReportWiring.test.ts`

**Interfaces:**
- Consumes: `DistributionSummaryDataV1` 与 `DistributionFitDataV1` 现有 payload，不改变统计合同。
- Produces: 单一 `Summary Statistics` table；成功 fit 只显示 Parameter Estimates、Measures 和模型必要说明。

- [ ] **Step 1: 写 Summary Statistics RED component assertion**

在 `tests/analysisView.spec.tsx` 的 Distribution response tree fixture 上展开 Overall，断言：

```ts
const summary = component.getByRole("table", { name: "Summary Statistics" });
await expect(summary).toBeVisible();
await expect(summary.locator("tbody tr")).toHaveCount(8);
for (const label of ["N", "N Missing", "Mean", "Median", "Std Dev", "Std Error", "Lower 95% Mean", "Upper 95% Mean"]) {
  await expect(summary.getByRole("rowheader", { name: label, exact: true })).toBeVisible();
}
for (const removed of ["Mode", "Minimum", "Maximum", "Range", "Interquartile Range", "Median Absolute Deviation"]) {
  await expect(summary.getByRole("rowheader", { name: removed, exact: true })).toHaveCount(0);
}
```

- [ ] **Step 2: 写 Continuous Fit 可见文本 RED assertion**

修改 `tests/e2e/ContinuousFitReport.spec.tsx` 的成功 fit 测试：

```ts
await expect(component.getByText("Compatibility pending")).toHaveCount(0);
await expect(component.getByText(/Convergence: Converged/)).toHaveCount(0);
```

保留 unavailable/failed reason 的现有测试，证明失败原因没有被一起隐藏。

- [ ] **Step 3: 运行 RED tests**

Run:

```powershell
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "Distribution response tree"
npx playwright test -c playwright-ct.config.ts tests/e2e/ContinuousFitReport.spec.tsx --grep "renders available"
```

Expected: Summary 仍为 Location/Variation，Compatibility 与 Convergence 仍可见，因此断言失败。

- [ ] **Step 4: 实现单表和成功状态精简**

将 `SummaryDataTables` 改为一张表：

```tsx
<SummaryTable title={t("distribution.report.summaryStatistics")} rows={[
  ["n", summaryData.n],
  ["nMissing", summaryData.nMissing],
  ["mean", summaryData.mean],
  ["median", summaryData.median],
  ["stdDev", summaryData.stdDev],
  ["stdError", summaryData.stdError],
  ["meanCiLower", summaryData.meanCiLower],
  ["meanCiUpper", summaryData.meanCiUpper],
]} />
```

删除 `ContinuousFitReport` 成功分支中的 compatibility 和 convergence `AnalysisText`；不要删除 payload 字段或 unavailable reason 分支。四种 locale 增加 `distribution.report.summaryStatistics`。

- [ ] **Step 5: 运行 GREEN tests 与结构合同**

Run:

```powershell
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "Distribution response tree"
npx playwright test -c playwright-ct.config.ts tests/e2e/ContinuousFitReport.spec.tsx
npx tsx --tsconfig tsconfig.app.json tests/distributionReportWiring.test.ts
```

Expected: 全部通过。

- [ ] **Step 6: 提交 Task 1**

```powershell
git add src/components/distribution/DistributionReport.tsx src/components/distribution/ContinuousFitReport.tsx src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/e2e/ContinuousFitReport.spec.tsx tests/analysisView.spec.tsx tests/distributionReportWiring.test.ts
git commit -m "fix(distribution): simplify statistical report"
```

---

### Task 2: 扩展 Fit 配置与跨语言持久化合同

**Files:**
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/distributionConfig.ts`
- Modify: `src/components/distribution/useDistributionReport.ts`
- Modify: `src/components/analysis/distributionAnalysisMigration.ts`
- Modify: `src/components/analysis/analysisSample.ts`
- Modify: `src/types/analysis.ts`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/engine/distribution_executor.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Test: `tests/distributionConfig.test.ts`
- Test: `tests/distributionRunContract.test.ts`
- Test: `tests/distributionAnalysisMigration.test.ts`
- Test: `tests/distributionArchive.test.ts`
- Test: `tests/analysisDocument.test.ts`
- Test: Rust unit tests in the touched modules

**Interfaces:**
- Produces: `DistributionAnalysisConfig.fitAll: boolean`、`DistributionRequest.fitAll: boolean`，以及 `ContinuousDistributionIdV1` 的 `"cauchy"` member。
- Produces: Rust `ContinuousDistributionIdV1::Cauchy` 与 legacy `DistributionRequest.fit_all: bool`。
- Migration rule: persisted Analysis/legacy items missing `fitAll` normalize to `false` without changing selected distributions.

- [ ] **Step 1: 写 TypeScript contract RED tests**

更新默认值、request shape 和迁移断言：

```ts
assert.deepEqual(createDefaultDistributionAnalysisConfig(), {
  confidenceLevel: 0.95,
  specLimits: {},
  fitDistributions: ["normal"],
  fitAll: false,
});

assert.equal(createDistributionRequest(item, 7).fitAll, false);
assert.equal(migrated.definition.analysis.fitAll, false);
```

为 `fitDistributions: ["cauchy"]` 增加通过校验与 archive round-trip 断言，为 `fitAll: true` 增加 request fingerprint 改变断言。

- [ ] **Step 2: 写 Rust model/archive RED tests**

在 `models::distribution` serde test 中解析：

```json
{
  "enabledDistributionIds": ["cauchy"],
  "fitAll": true,
  "diagnostics": { "goodnessOfFit": false, "qqPlot": false, "cdfPlot": false, "ppPlot": false }
}
```

在 `spprj_archive` fixture 中断言 `fitAll: true` 和 `fitDistributions: ["cauchy"]` 合法，未知 ID 仍失败。

- [ ] **Step 3: 运行 RED contract tests**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/distributionConfig.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionRunContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionAnalysisMigration.test.ts
cargo test --manifest-path src-tauri/Cargo.toml models::distribution
cargo test --manifest-path src-tauri/Cargo.toml distribution_analysis_archive
```

Expected: 类型、默认字段、Cauchy enum 或 archive validator 缺失导致失败。

- [ ] **Step 4: 实现 TypeScript 合同与 migration normalization**

扩展类型：

```ts
export type ContinuousDistributionIdV1 =
  | "normal"
  | "cauchy"
  | "lognormal"
  | "exponential"
  | "gamma"
  | "weibull";

export interface DistributionAnalysisConfig {
  confidenceLevel: number;
  specLimits: Record<string, SpecLimitsOverride>;
  fitDistributions: DistributionFitKind[];
  fitAll: boolean;
}
```

`normalizeDistributionAnalysisForFrontend` 和 persisted normalization 都以不可变方式补 `fitAll ?? false`。`createDistributionRequest` 显式复制 `fitAll`，使 request identity 自动纳入 stale fence。

- [ ] **Step 5: 实现 Rust enum、legacy request 和 archive parity**

```rust
pub enum ContinuousDistributionIdV1 {
    Normal,
    Cauchy,
    Lognormal,
    Exponential,
    Gamma,
    Weibull,
    #[serde(other)]
    Unknown,
}

pub struct DistributionRequest {
    // existing fields
    pub fit_distributions: Vec<DistributionFitKind>,
    #[serde(default)]
    pub fit_all: bool,
}
```

`distribution_executor` 将 `fit_all` 传入 V1 `continuous_fit.fit_all`。Rust archive validator 对缺失 `fitAll` 的旧文档按 false 验证、对存在但非 boolean 的值报错；前端 migration 在加载后补 false，使下一次保存写出 canonical 字段。validator 允许 cauchy，继续拒绝 unknown。

- [ ] **Step 6: 运行 GREEN contracts 与 Analysis gate 子集**

```powershell
npm run test:distribution:contracts
npm run test:analysis:typecheck
npm run test:analysis:contracts
cargo test --manifest-path src-tauri/Cargo.toml models::distribution
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
```

- [ ] **Step 7: 提交 Task 2**

```powershell
git add src/types/distribution.ts src/types/analysis.ts src/components/distribution/distributionConfig.ts src/components/distribution/useDistributionReport.ts src/components/analysis/distributionAnalysisMigration.ts src/components/analysis/analysisSample.ts src-tauri/src/models/distribution.rs src-tauri/src/engine/distribution_executor.rs src-tauri/src/services/spprj_archive.rs tests/distributionConfig.test.ts tests/distributionRunContract.test.ts tests/distributionAnalysisMigration.test.ts tests/distributionArchive.test.ts tests/analysisDocument.test.ts
git commit -m "feat(distribution): persist fit all configuration"
```

---

### Task 3: 增加 Continuous Fit 选择器

**Files:**
- Modify: `src/components/distribution/DistributionDialog.tsx`
- Modify: `src/components/distribution/distributionDialogState.ts`
- Modify: `src/components/distribution/distributionConfig.ts`
- Modify: `src/components/distribution/distribution.css`
- Modify: four locale files under `src/i18n/locales/`
- Test: `tests/e2e/DistributionDialog.spec.tsx`
- Test: `tests/distributionConfig.test.ts`
- Test: `tests/distributionLocale.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `fitDistributions` 和 `fitAll`。
- Produces: `validateDistributionAnalysisConfig` rule：`fitAll === true || fitDistributions.length > 0`。
- UI: six distribution checkboxes plus one Fit All checkbox; Fit All disables but does not clear individual selections.

- [ ] **Step 1: 写选择器 RED component tests**

```ts
const fitAll = component.getByRole("checkbox", { name: "Fit All" });
const normal = component.getByRole("checkbox", { name: "Normal" });
const cauchy = component.getByRole("checkbox", { name: "Cauchy" });
await expect(normal).toBeChecked();
await cauchy.check();
await fitAll.check();
await expect(normal).toBeDisabled();
await expect(cauchy).toBeDisabled();
await fitAll.uncheck();
await expect(cauchy).toBeChecked();
```

保存后断言 `saved.analysis.fitDistributions` 保留 Normal+Cauchy，`saved.analysis.fitAll === false`。另加全不选时 Save disabled/alert 的测试。

- [ ] **Step 2: 运行 RED dialog test**

```powershell
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionDialog.spec.tsx --grep "Continuous Fit"
```

Expected: checkbox 不存在。

- [ ] **Step 3: 使用共享 checkbox 控件实现 UI**

按 registry 顺序渲染，不复制分布列表：

```tsx
{DISTRIBUTION_FIT_CAPABILITY_REGISTRY.map(({ distributionId }) => (
  <label key={distributionId} className="distribution-fit-option">
    <input
      type="checkbox"
      checked={state.analysis.fitDistributions.includes(distributionId)}
      disabled={state.analysis.fitAll}
      onChange={() => setState((current) => toggleDistributionFit(current, distributionId))}
    />
    <span>{t(`distribution.fit.distributions.${distributionId}`)}</span>
  </label>
))}
```

若 `src/components/ui` 已有 Checkbox，必须使用现有控件；只有不存在时才使用原生 checkbox。Fit All 保留 selection，不在 toggle 时清空数组。

- [ ] **Step 4: 完成 responsive CSS 与 locale parity**

选择器使用稳定 grid，窄宽时换行；不得增加卡片嵌套。四种 locale 增加 Continuous Fit、Fit All 与 Cauchy 文案。

- [ ] **Step 5: 运行 GREEN UI、locale 和窄宽测试**

```powershell
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionDialog.spec.tsx
npx tsx --tsconfig tsconfig.app.json tests/distributionConfig.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionLocale.test.ts
```

- [ ] **Step 6: 提交 Task 3**

```powershell
git add src/components/distribution/DistributionDialog.tsx src/components/distribution/distributionDialogState.ts src/components/distribution/distributionConfig.ts src/components/distribution/distribution.css src/i18n/locales tests/e2e/DistributionDialog.spec.tsx tests/distributionConfig.test.ts tests/distributionLocale.test.ts
git commit -m "feat(distribution): add continuous fit selector"
```

---

### Task 4: 实现 Cauchy MLE 与参数推断

**Files:**
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/components/distribution/distributionConfig.ts`
- Modify: `src/components/distribution/ContinuousFitReport.tsx`
- Test: Rust `services::distribution_fit::tests`
- Test: Rust `services::distribution_service::tests::continuous_fit`
- Test: `tests/e2e/ContinuousFitReport.spec.tsx`
- Test: `tests/distributionGolden.test.ts`

**Interfaces:**
- Produces: `CauchyFitV1` implementing existing `FitModel`.
- Produces: registry entry `fit.cauchy.locationScale.mle.v1` / `cauchy.locationScale.v1` with two estimated parameters.
- Consumes: weighted/frequency `FitObservationV1::contribution()` and existing `build_pdf_curve`/typed inference states.

- [ ] **Step 1: 写 Cauchy fit RED tests**

在 Rust test module 增加：

```rust
#[test]
fn cauchy_fit_recovers_location_scale_deterministically() {
    let observations = deterministic_cauchy_fixture();
    let first = CauchyFitV1.fit(&observations).expect("cauchy fit");
    let second = CauchyFitV1.fit(&observations).expect("repeat cauchy fit");
    assert_eq!(first, second);
    assert_eq!(first.distribution_id, ContinuousDistributionIdV1::Cauchy);
    assert_parameter_close(&first, "location", 5.0, 0.25);
    assert_parameter_close(&first, "scale", 2.0, 0.35);
    assert!(first.log_likelihood.is_finite());
}
```

另加 weighted/frequency compact-vs-expanded 等价、constant sample typed failure、PDF 非负、Hessian singular 只影响 inference 的测试。

- [ ] **Step 2: 运行 RED Rust test**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_fit::tests::cauchy_fit -- --nocapture
```

Expected: `CauchyFitV1` 不存在。

- [ ] **Step 3: 实现确定性 Cauchy objective 和多起点优化**

新增：

```rust
#[derive(Debug, Clone, Copy, Default)]
pub struct CauchyFitV1;

impl CauchyFitV1 {
    pub const METHOD_ID: &'static str = "fit.cauchy.locationScale.mle.v1";
    pub const PARAMETERIZATION_ID: &'static str = "cauchy.locationScale.v1";
}
```

目标函数在 `[location, log_scale]` 上计算：

```rust
contribution * (std::f64::consts::PI.ln() + log_scale
    + ((value - location) / log_scale.exp()).powi(2).ln_1p())
```

使用 weighted Q1/median/Q3 与 IQR-derived scale 形成固定起点。复用现有 `FitOptimizer` abstraction；若现有 optimizer 只支持一维 Brent，则增加一个局部、确定性的二维 optimizer 实现，不把优化逻辑放进 service 或前端。所有候选按 objective 后再按起点序号稳定选择。

- [ ] **Step 4: 实现 observed-information inference 和 PDF**

在 transformed 参数处计算中心差分 Hessian，逆矩阵得到 location 与 log-scale covariance，再用 delta method 转为 scale standard error。奇异/非正定时调用 `set_parameter_inference_unavailable`。PDF 使用 `statrs::distribution::Cauchy` 或同等经过参数校验的稳定公式。

- [ ] **Step 5: 注册 Cauchy 并补前端参数术语**

将 registry 改为六项，更新所有 exhaustive `match`、`distribution_id`、capability registry 和报告参数 label。Cauchy 显示 Location/Scale。

- [ ] **Step 6: 运行 GREEN focused tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_fit::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_service::tests::continuous_fit -- --nocapture
npx playwright test -c playwright-ct.config.ts tests/e2e/ContinuousFitReport.spec.tsx
```

- [ ] **Step 7: 提交 Task 4**

```powershell
git add src-tauri/src/services/distribution_fit.rs src-tauri/src/services/distribution_service.rs src/components/distribution/distributionConfig.ts src/components/distribution/ContinuousFitReport.tsx tests/e2e/ContinuousFitReport.spec.tsx tests/distributionGolden.test.ts
git commit -m "feat(stats): add cauchy continuous fit"
```

---

### Task 5: 完成 Fit All 服务行为与比较结果

**Files:**
- Modify: `src-tauri/src/engine/distribution_executor.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/components/distribution/useDistributionReport.ts`
- Test: `tests/distributionRunContract.test.ts`
- Test: Rust `services::distribution_service::tests::continuous_fit`
- Test: `tests/e2e/ContinuousFitReport.spec.tsx`

**Interfaces:**
- Consumes: Task 2 `fitAll` request 与 Task 4 六项 registry。
- Produces: Fit All 每个 response/group 最多一个 comparison block，包含六个稳定排序 row；单模型失败不终止其他模型。

- [ ] **Step 1: 写 legacy request RED test**

构造 `DistributionRequest { fit_all: true, fit_distributions: vec![Normal] }`，断言转换后的 V1 request：

```rust
assert!(request.continuous_fit.fit_all);
assert_eq!(request.continuous_fit.enabled_distribution_ids, vec![ContinuousDistributionIdV1::Normal]);
```

- [ ] **Step 2: 写六模型 Fit All RED service test**

对正值 fixture 执行 Fit All，断言六个 fit block 和一个 comparison block；对含负值 fixture 断言 Lognormal/Gamma/Weibull unavailable 时 Normal/Cauchy 仍 available，comparison 仍有六行。

- [ ] **Step 3: 运行 RED tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_service::tests::continuous_fit::fit_all -- --nocapture
```

Expected: legacy adapter 丢弃 `fitAll` 或 comparison 只有五个 registry rows。

- [ ] **Step 4: 贯通 fitAll 并保持失败隔离**

确保 legacy adapter 不再硬编码 `fit_all: false`。`fit_candidates` 在 Fit All 时取完整 registry，否则取显式去重 selection。保留现有 `execute_fit_candidates` 每候选 typed payload 行为，不将模型 domain failure 升级为 command failure。

- [ ] **Step 5: 运行 GREEN service/contract/report tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_service::tests::continuous_fit -- --nocapture
npx tsx --tsconfig tsconfig.app.json tests/distributionRunContract.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/ContinuousFitReport.spec.tsx
```

- [ ] **Step 6: 提交 Task 5**

```powershell
git add src-tauri/src/engine/distribution_executor.rs src-tauri/src/services/distribution_service.rs src/components/distribution/useDistributionReport.ts tests/distributionRunContract.test.ts tests/e2e/ContinuousFitReport.spec.tsx
git commit -m "fix(distribution): restore fit all execution"
```

---

### Task 6: 统一报告 Swatch 与拟合曲线颜色

**Files:**
- Create: `src/graphCore/distributionFitStyle.ts`
- Modify: `src/graphCore/transform.ts`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/components/distribution/distribution.css`
- Test: `tests/transformAggregatePackets.test.ts`
- Test: `tests/e2e/ContinuousFitReport.spec.tsx`
- Test: `tests/analysisView.spec.tsx`

**Interfaces:**
- Produces: `DISTRIBUTION_FIT_ORDER: readonly ContinuousDistributionIdV1[]`。
- Produces: `distributionFitColor(distributionId, categorical): string`，报告与 graphCore 必须共同调用。
- Consumes: stable fitted curve `seriesId` suffix `:fit:<distributionId>`；优先避免扩展 packet schema。

- [ ] **Step 1: 写纯颜色与 transform RED tests**

```ts
assert.equal(distributionFitColor("normal", palette), palette[0]);
assert.equal(distributionFitColor("cauchy", palette), palette[1]);
assert.notEqual(distributionFitColor("normal", palette), distributionFitColor("weibull", palette));
```

构造六个 `precomputedCurve` packets，运行 transform 后按 `seriesId` 断言每个 ECharts line 的 `lineStyle.color` 等于纯函数结果，且颜色集合大小为 6。

- [ ] **Step 2: 运行 RED transform test**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/transformAggregatePackets.test.ts
```

Expected: helper 缺失，或所有 MODE A curve 使用第一色。

- [ ] **Step 3: 实现共享 resolver 并修正 MODE A/MODE C packet path**

```ts
export const DISTRIBUTION_FIT_ORDER = [
  "normal", "cauchy", "lognormal", "weibull", "exponential", "gamma",
] as const;

export function distributionFitColor(
  distributionId: ContinuousDistributionIdV1,
  categorical: readonly string[],
): string {
  const index = DISTRIBUTION_FIT_ORDER.indexOf(distributionId);
  return categorical[Math.max(0, index) % categorical.length] ?? "#4a6cf7";
}
```

增加严格的 `distributionIdFromFitSeriesId` parser，只接受已知 suffix；未知 packet 继续走 existing group style。不要给 `custom` series 添加 `encode`，不要改变 histogram bin math。

- [ ] **Step 4: 在报告 frame 标题加入同源 swatch**

为 `ReportBlock` 构造带 swatch 的可访问标题；若 `AnalysisFrame.title` 仅接受 string，则在 frame 内容顶部使用 `AnalysisText` + `aria-hidden` swatch，保留原 button accessible name。颜色调用 `distributionFitColor(data.distributionId, getGraphTheme().categorical)`，不得复制 palette。

- [ ] **Step 5: 运行 GREEN transform 与 component tests**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/transformAggregatePackets.test.ts
npx playwright test -c playwright-ct.config.ts tests/e2e/ContinuousFitReport.spec.tsx
npx playwright test -c playwright-ct.config.ts tests/analysisView.spec.tsx --grep "Distribution response tree"
```

- [ ] **Step 6: 执行图表视觉验收**

启动 app 后使用包含 By group 和 Normal+Cauchy+Lognormal+Weibull 的 fixture，验证：Normal 为蓝色；每个报告 swatch 与同 ID 曲线像素颜色一致；不同 response/group 不改变 distribution 色；desktop 与 narrow viewport 无重叠。

- [ ] **Step 7: 提交 Task 6**

```powershell
git add src/graphCore/distributionFitStyle.ts src/graphCore/transform.ts src/components/distribution/DistributionReport.tsx src/components/distribution/distribution.css tests/transformAggregatePackets.test.ts tests/e2e/ContinuousFitReport.spec.tsx tests/analysisView.spec.tsx
git commit -m "fix(graph): align distribution fit colors"
```

---

### Task 7: 实现 Cpm Log-Delta Confidence Interval

**Files:**
- Modify: `src-tauri/src/services/normal_capability.rs`
- Test: Rust `services::normal_capability::tests`
- Test: Rust `services::distribution_service::tests`
- Test: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Produces: `cpm_log_delta_interval(point, sigma, mean, target, n, degrees_of_freedom, alpha, method_id)` returning `CapabilityIntervalV1`。
- Within method ID: `movingRangeEffectiveDfLogDeltaCpm.v1`。
- Overall method ID: `logDeltaCpm.v1`。
- Existing `ProcessCapabilityReport` needs no statistical fallback; it already renders interval typed values.

- [ ] **Step 1: 写 analytic Cpm RED tests**

使用独立手算 fixture 验证：

```rust
let intervals = capability_intervals(&summary, &indices, 0.95);
assert_available_close(&intervals.cpm_within.lower, expected_within_lower, 1e-10);
assert_available_close(&intervals.cpm_within.upper, expected_within_upper, 1e-10);
assert_available_close(&intervals.cpm_overall.lower, expected_overall_lower, 1e-10);
assert_available_close(&intervals.cpm_overall.upper, expected_overall_upper, 1e-10);
assert_eq!(intervals.cpm_within.method_id.as_deref(), Some("movingRangeEffectiveDfLogDeltaCpm.v1"));
assert_eq!(intervals.cpm_overall.method_id.as_deref(), Some("logDeltaCpm.v1"));
```

测试 90% interval 严格窄于 95%，并覆盖 no target、one-sided spec、n<3、sigma zero/non-finite typed state。

- [ ] **Step 2: 运行 RED capability test**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::normal_capability::tests::cpm -- --nocapture
```

Expected: 当前返回 `capability.cpmIntervalDeferred.v1`。

- [ ] **Step 3: 实现 spec 公式的单一 helper**

```rust
let delta = mean - target;
let q = sigma * sigma + delta * delta;
let variance_q = 2.0 * sigma.powi(4) / degrees_of_freedom
    + 4.0 * delta * delta * sigma * sigma / n as f64;
let se_log_cpm = variance_q.sqrt() / (2.0 * q);
let critical = Normal::new(0.0, 1.0)?.inverse_cdf(1.0 - alpha / 2.0);
let lower = point * (-critical * se_log_cpm).exp();
let upper = point * (critical * se_log_cpm).exp();
```

实际代码必须通过既有 typed constructors 处理 invalid state，不在 helper 中 `unwrap()`。Within/Overall 调用只传不同 sigma、df 和 method ID。

- [ ] **Step 4: 升级 provenance 并替换 deferred interval**

将 method version 升级，parameterization 追加 `cpmLogDeltaApproximation`。保留其他 Cp/Cpk/Pp/Ppk interval 算法和 method ID 不变。

- [ ] **Step 5: 运行 GREEN Rust 与 UI capability tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::normal_capability -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_service -- --nocapture
npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionWorkspace.spec.tsx --grep "capability"
```

- [ ] **Step 6: 提交 Task 7**

```powershell
git add src-tauri/src/services/normal_capability.rs tests/e2e/DistributionWorkspace.spec.tsx
git commit -m "feat(stats): calculate cpm confidence intervals"
```

---

### Task 8: 完整验收与回归清理

**Files:**
- No planned production file changes; validation failures return to the task that owns the behavior.

**Interfaces:**
- Consumes: all previous task outputs。
- Produces: clean branch with complete automated and visual acceptance evidence。

- [ ] **Step 1: 运行 Distribution 全门禁**

```powershell
npm run test:distribution
```

- [ ] **Step 2: 运行 Analysis required gate**

```powershell
npm run test:analysis:typecheck
npm run test:analysis:contracts
npm run test:analysis:kinds
npm run test:analysis:ui
npm run test:analysis
cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
```

- [ ] **Step 3: 运行 Rust focused 与全量静态检查**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_fit
cargo test --manifest-path src-tauri/Cargo.toml services::normal_capability
cargo test --manifest-path src-tauri/Cargo.toml services::distribution_service
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

已有与本变更无关的 clippy warning 若使 `-D warnings` 失败，记录精确 warning 与基线证据，不做无关重构；本变更新增 warning 必须修复。

- [ ] **Step 4: 运行 production build**

```powershell
npm run build
```

- [ ] **Step 5: 启动应用并执行视觉验收**

```powershell
npm run tauri dev
```

验收 desktop 与 narrow viewport：八行 Summary Statistics；无成功 Compatibility/Convergence 文本；Fit selector 可恢复 selection；六模型 Fit All comparison；Cpm Lower/Upper 为数值；swatch 与曲线同色；无文字溢出、控件重排或页面级横向滚动。

- [ ] **Step 6: 检查生成文件与工作区稳定性**

停止应用后运行：

```powershell
git status --short
git diff --check
```

Expected: 启动不再改写 Cargo.toml 或 Tauri schema；仅存在本计划内尚未提交的预期修改。

- [ ] **Step 7: 确认所有修复归属已有任务提交**

若 Steps 1-6 发现回归，回到拥有该行为的 Task 1-7，先补 RED test，再修复并追加到该任务的 Conventional Commit。完成后 `git status --short` 必须为空，不创建内容不明确的兜底提交。

- [ ] **Step 8: 最终审查**

检查 `git diff origin/dev...HEAD`，确认没有持久化计算结果、前端统计 fallback、未知 ID fallback、无关格式化或生成产物噪声。记录每条验证命令的 exit code 与失败基线，不在验证失败时宣称完成。