# Fit Model #83/#91 核心闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Fit Model MVP 上完成三种 DOE construct、响应面、高阶交互、工程诊断、Prediction Profiler、Save Columns 与 DOE 预填入口，使 Issue #83/#91 的核心范围可验收关闭。

**Architecture:** 保留 `FitModelItem -> fit_model IPC -> FitModelService -> ModelMatrixSpec -> SVD OLS -> FitModelReport` 主链路。显式 terms 是计算权威，construct 只负责确定性生成；Rust 使用全量 complete-case 数据计算拟合、推断和诊断，前端只消费结构化结果与紧凑拟合快照；Save Columns 通过单个 DuckDB 事务和既有 change-set history 写入并撤销。

**Tech Stack:** React 19、TypeScript 5.7、Zustand 5、ECharts、Tauri v2、Rust 2021、DuckDB、nalgebra、statrs、tsx contract tests、Playwright component tests。

**Spec:** `docs/superpowers/specs/2026-09-02-issues-83-91-fit-model-core-closure-design.md`

## Global Constraints

- P0 只支持 continuous response 和 continuous predictors。
- term contract 支持 `main`、arity 2..k 的 `interaction`、`exponent=2` 的 `power`。
- `interaction` 和 `power` 必须满足 strong hierarchy。
- 单个模型最多 256 个 persisted terms，即最多 257 个含截距参数。
- `Full Factorial` 生成全部 1..k 阶项；`Factorial to Degree` 生成全部 1..d 阶项；`Response Surface` 生成 main、two-way interaction 和 square。
- 旧 main/two-way interaction 项目必须保持可加载、可重算和统计语义不变。
- `centeringMethod="mean"` 不改变 main feature；interaction 和 power 使用 complete-case 均值中心化输入。
- P0 confidence level 固定为 0.95，不进入 `FitModelItem`，请求只接受 0.95。
- OLS、诊断与 Save Columns 使用全量 complete-case 数据；报告逐行 payload 和 Q-Q 点各最多 8,000。
- Profiler 使用当前拟合快照在前端计算，每个 predictor 最多 101 个扫描点。
- Save Columns 在一次事务中完成新增列、写值、metadata、generation 与 change set；失败必须完全回滚。
- Rust command 返回 `Result<T, AppError>`；非测试代码不得使用 `unwrap()` 或 `expect()`。
- SQL value 使用参数化语句；动态 identifier 必须先验证再走现有 quoting helper。
- wire model 使用 camelCase serde，TypeScript 类型逐字段镜像。
- 所有用户可见文本覆盖 `en`、`zh-CN`、`zh-TW`、`vi`。
- 每项生产行为先写聚焦失败测试并观察预期 RED，再做最小实现。
- 不清理或回退工作区已有用户改动；每个任务只暂存自身文件。
- 每个任务完成后使用独立 Conventional Commit；不 push。

## File Structure

### 新增前端文件

- `src/components/fitModel/fitModelConstruct.ts`：安全组合数、三种 construct term 生成器与 256 项限制。
- `src/components/fitModel/fitModelEquation.ts`：按 resolved feature basis 格式化数值拟合方程。
- `src/components/fitModel/fitModelPrediction.ts`：纯 TypeScript 点预测、Mean CI、Prediction Interval 与 profiler scan。
- `src/components/fitModel/FitModelProfiler.tsx`：Prediction Profiler 交互 UI。
- `src/components/fitModel/FitModelSaveColumnsDialog.tsx`：Save Columns metric 选择和状态 UI。

### 新增 Rust 文件

- `src-tauri/src/engine/fit_model/prediction.rs`：snapshot、点预测、区间与 predictor ranges。
- `src-tauri/src/engine/fit_model/diagnostics.rs`：LOF/Pure Error、Feature VIF、row diagnostics 与 Q-Q 数据。

### 新增测试文件

- `tests/fitModelConstruct.test.ts`
- `tests/fitModelEquation.test.ts`
- `tests/fitModelPrediction.test.ts`
- `tests/fitModelSaveColumns.test.ts`
- `tests/fitModelPrefill.test.ts`
- `playwright/fitModelReport.spec.tsx`
- `playwright/fitModelProfiler.spec.tsx`

### 主要修改文件

- Frontend contract/state：`src/types/fitModel.ts`、`src/components/fitModel/fitModelConfig.ts`、`fitModelDialogState.ts`、`FitModelRoleDialog.tsx`、`useFitModelStore.ts`。
- Frontend report：`FitModelView.tsx`、`FitModelReport.tsx`、`fitModelReportModel.ts`、`fitModel.css`、`src/graphCore/fitModelAdapter.ts`。
- Frontend IPC/history：`src/services/fitModelService.ts`、`src/components/Workspace.tsx`、`src/stores/useHistoryStore.ts` 的既有 `recordTable` API。
- Rust contract/engine：`src-tauri/src/models/fit_model.rs`、`engine/fit_model.rs`、`engine/fit_model/{terms.rs,matrix.rs,ols.rs}`、`services/fit_model_service.rs`、`commands/fit_model_commands.rs`、`lib.rs`。
- DuckDB mutation：`src-tauri/src/engine/duckdb_engine.rs`。
- Locale/build：四个 locale JSON、`package.json`。

---

### Task 0: 恢复完整前端构建基线

**Files:**
- Modify: `src/components/Workspace.tsx`
- Create: `tests/workspaceTabulate.test.ts`

**Interfaces:**
- Consumes: `datasets: DatasetMeta[]`、`TabulateViewProps.existingDatasetNames: string[]`。
- Produces: 每次渲染 TabulateView 时传入当前数据集名称列表。

- [ ] **Step 1: 为缺失 prop 添加失败合同测试**

在 `tests/workspaceTabulate.test.ts` 增加源码合同断言，要求调用处存在：

```ts
assert.match(
  workspaceSource,
  /<TabulateView[\s\S]*existingDatasetNames=\{datasets\.map\(\(dataset\) => dataset\.name\)\}/,
);
```

- [ ] **Step 2: 运行测试和类型检查确认 RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts
npx tsc -b --pretty false
```

Expected: 合同测试或类型检查失败，错误指出 `existingDatasetNames` 缺失。
若基线已经因同一缺参在 `tsc` 失败，该编译错误即为有效 RED，可直接进入 Step 3。

- [ ] **Step 3: 传入当前数据集名称**

在 Workspace 的 `TabulateView` 调用增加：

```tsx
existingDatasetNames={datasets.map((dataset) => dataset.name)}
```

- [ ] **Step 4: 验证 GREEN 和完整 build**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceTabulate.test.ts
npm run build
```

Expected: 两个命令 exit 0。

- [ ] **Step 5: 独立提交基线修复**

```powershell
git add -- src/components/Workspace.tsx tests/workspaceTabulate.test.ts
git commit -m "fix(tabulate): pass dataset names to report view"
```

---

### Task 1: TypeScript Construct 与持久化协议

**Files:**
- Create: `src/components/fitModel/fitModelConstruct.ts`
- Modify: `src/types/fitModel.ts`
- Modify: `src/components/fitModel/fitModelConfig.ts`
- Modify: `src/stores/useFitModelStore.ts`
- Modify: `src/components/fitModel/index.ts`
- Test: `tests/fitModelConstruct.test.ts`
- Test: `tests/fitModelConfig.test.ts`
- Test: `tests/fitModelStore.test.ts`
- Test: `tests/fitModelArchive.test.ts`

**Interfaces:**
- Produces: `MAX_FIT_MODEL_TERMS`、`FitModelConstruct`、`FitModelTerm` union、`countFactorialTerms()`、`buildFullFactorialTerms()`、`buildFactorialToDegreeTerms()`、`buildResponseSurfaceTerms()`。
- Preserves: 旧 `{ kind, columnNames }` JSON 和 `invalidPersistedDefinition` 隔离行为。

- [ ] **Step 1: 写 construct 与协议失败测试**

创建 `tests/fitModelConstruct.test.ts`，至少固定以下行为：

```ts
import assert from "node:assert/strict";
import {
  MAX_FIT_MODEL_TERMS,
  buildFactorialToDegreeTerms,
  buildFullFactorialTerms,
  buildResponseSurfaceTerms,
  countFactorialTerms,
} from "../src/components/fitModel/fitModelConstruct.ts";

const fields = ["A", "B", "C"].map((name) => ({ name, type: "continuous" as const }));

assert.equal(MAX_FIT_MODEL_TERMS, 256);
assert.equal(countFactorialTerms(3, 3), 7);
assert.deepEqual(buildFullFactorialTerms(fields).map((term) => term.columnNames), [
  ["A"], ["B"], ["C"], ["A", "B"], ["A", "C"], ["B", "C"], ["A", "B", "C"],
]);
assert.equal(buildFactorialToDegreeTerms(fields, 2).length, 6);
assert.deepEqual(buildResponseSurfaceTerms(fields).filter((term) => term.kind === "power"), [
  { kind: "power", columnNames: ["A"], exponent: 2 },
  { kind: "power", columnNames: ["B"], exponent: 2 },
  { kind: "power", columnNames: ["C"], exponent: 2 },
]);
assert.throws(() => buildFullFactorialTerms(
  Array.from({ length: 9 }, (_, index) => ({ name: `X${index}`, type: "continuous" as const })),
), /256/);
```

扩展 config/store/archive 测试，覆盖 power strong hierarchy、多阶交互 canonical identity、旧 item 缺少 construct 时迁移到 manual，以及非法 exponent 进入 `loadIssue`。增加一个无 construct、仅 main/two-way interaction、`centeringMethod="mean"` 的旧归档 fixture；加载后用固定数据重算，断言 coefficients 与 fitted values 保持基线数值语义。

- [ ] **Step 2: 运行聚焦测试确认 RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelConstruct.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts
```

Expected: 新模块不存在或现有 term kind 拒绝 `power`。

- [ ] **Step 3: 定义向后兼容 TypeScript union**

在 `src/types/fitModel.ts` 定义：

```ts
export type FitModelConstruct =
  | { kind: "manual" }
  | { kind: "fullFactorial" }
  | { kind: "factorialToDegree"; degree: number }
  | { kind: "responseSurface" };

export type FitModelTerm =
  | { kind: "main"; columnNames: [string] }
  | { kind: "interaction"; columnNames: string[] }
  | { kind: "power"; columnNames: [string]; exponent: 2 };
```

为 `FitModelItem` 增加 `construct: FitModelConstruct`。更新 clone、canonical key、参数计数和 strict validation；`power` identity 使用 `power\0<length>:<name>\02`，interaction 先排序再编码 tuple，不使用 `join("*")` 作为身份。

- [ ] **Step 4: 实现安全组合数和 term 生成器**

在构造数组前计算组合数；超过 256 立即抛出 typed error：

```ts
export const MAX_FIT_MODEL_TERMS = 256;

export function countFactorialTerms(factorCount: number, degree: number): number;
export function buildFullFactorialTerms(fields: readonly FieldRef[]): FitModelTerm[];
export function buildFactorialToDegreeTerms(
  fields: readonly FieldRef[],
  degree: number,
): FitModelTerm[];
export function buildResponseSurfaceTerms(fields: readonly FieldRef[]): FitModelTerm[];
```

组合枚举固定按阶数升序，再按输入字段顺序生成 canonical tuple。Response Surface 返回 main、two-way interaction、power，并由调用者默认设置 `centeringMethod="mean"`。

- [ ] **Step 5: 更新 archive normalization**

`parseTerm(unknown)` 分支必须显式检查：main arity 1、interaction arity >= 2 且列名不同、power arity 1 且 exponent === 2。缺少 construct 迁移为 manual；无法解析的新 term 保留 item 并写：

```ts
loadIssue: {
  code: "invalidPersistedDefinition",
  detail: "invalidTerm:<index>",
}
```

- [ ] **Step 6: 验证全部相关合同**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelConstruct.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelArchive.test.ts
npx tsc -b --pretty false
```

Expected: 全部 exit 0。

- [ ] **Step 7: 提交协议任务**

```powershell
git add -- src/types/fitModel.ts src/components/fitModel/fitModelConstruct.ts src/components/fitModel/fitModelConfig.ts src/components/fitModel/index.ts src/stores/useFitModelStore.ts tests/fitModelConstruct.test.ts tests/fitModelConfig.test.ts tests/fitModelStore.test.ts tests/fitModelArchive.test.ts
git commit -m "feat(analysis): add DOE model constructs"
```

---

### Task 2: 构建模型对话框与 Construct 预览

**Files:**
- Modify: `src/components/fitModel/fitModelDialogState.ts`
- Modify: `src/components/fitModel/FitModelRoleDialog.tsx`
- Modify: `src/components/fitModel/fitModel.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: `tests/fitModelDialog.test.ts`

**Interfaces:**
- Consumes: Task 1 construct builders。
- Produces: `FitModelCreateDefinition` 包含 `construct`、canonical terms 和 centering method。

- [ ] **Step 1: 写 dialog reducer 失败测试**

为 `tests/fitModelDialog.test.ts` 增加：

```ts
const responseSurface = reduceFitModelDraft(withThreePredictors, {
  type: "setConstruct",
  construct: { kind: "responseSurface" },
});
assert.equal(responseSurface.centeringMethod, "mean");
assert.equal(responseSurface.terms.filter((term) => term.kind === "power").length, 3);

const degreeThree = reduceFitModelDraft(withThreePredictors, {
  type: "setConstruct",
  construct: { kind: "factorialToDegree", degree: 3 },
});
assert.equal(degreeThree.terms.length, 7);
```

源码渲染合同同时要求三个 construct label、整数 degree input、`termCount / 256` 和不再出现 `twoWayOnly` 限制。

- [ ] **Step 2: 运行测试确认 RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelDialog.test.ts
```

- [ ] **Step 3: 扩展 draft 和 reducer**

将 draft 的模型权威字段改为：

```ts
interface FitModelDraft {
  response: FieldRef | null;
  predictors: FieldRef[];
  construct: FitModelConstruct;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  validationMessage: FitModelDialogMessage | null;
}
```

`setConstruct` 使用 Task 1 生成器重建 terms；手工删除 term 后 construct 变为 manual；删除 main 时继续阻止违反 hierarchy 的操作。创建 definition 必须携带 construct。

- [ ] **Step 4: 重构对话框 UI**

用三段式 construct control 替换 Degree 1/2 按钮；Factorial to Degree 显示 `min=1`、`max=predictorCount`、`step=1` 的 number input；Current Terms 使用可搜索列表，高阶 interaction 只显示单行 label。超限时禁用 Create 并显示组合数计算式。

- [ ] **Step 5: 补齐四语言文案并验证**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelDialog.test.ts
npx tsc -b --pretty false
npx vite build
```

- [ ] **Step 6: 提交 dialog 任务**

```powershell
git add -- src/components/fitModel/fitModelDialogState.ts src/components/fitModel/FitModelRoleDialog.tsx src/components/fitModel/fitModel.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/fitModelDialog.test.ts
git commit -m "feat(analysis): redesign Fit Model constructs"
```

---

### Task 3: Rust Term Resolver 与模型矩阵

**Files:**
- Modify: `src-tauri/src/models/fit_model.rs`
- Modify: `src-tauri/src/engine/fit_model/terms.rs`
- Modify: `src-tauri/src/engine/fit_model/matrix.rs`
- Modify: `src-tauri/src/services/fit_model_service.rs`
- Test: module tests in the same Rust files

**Interfaces:**
- Consumes: wire `FitModelTerm { kind, column_names, exponent }`。
- Produces: canonical `ResolvedTerm`、任意阶 interaction、power feature、`ModelMatrixSpec::transform_point()`。

- [ ] **Step 1: 写 Rust resolver/matrix 失败测试**

新增 tests 固定：

```rust
#[test]
fn resolves_three_way_interaction_and_square() {
    let terms = vec![main("A"), main("B"), main("C"), interaction(&["C", "A", "B"]), power("A", 2)];
    let resolved = resolve_terms(&terms).expect("valid terms");
    assert_eq!(resolved[3].term_id(), "interaction:A*B*C");
    assert_eq!(resolved[4].term_id(), "power:A^2");
}

#[test]
fn centered_response_surface_matrix_matches_fixture() {
    // A=[1,2,3], B=[2,4,6], centers A=2, B=4
    // columns: 1, A, B, (A-2)(B-4), (A-2)^2, (B-4)^2
}
```

同时测试 exponent != 2、257 terms、重复 interaction tuple 和 power 缺 main effect 均返回明确错误。

- [ ] **Step 2: 运行 Rust 聚焦测试确认 RED**

```powershell
Set-Location src-tauri
cargo test engine::fit_model::terms -- --nocapture
cargo test engine::fit_model::matrix -- --nocapture
```

- [ ] **Step 3: 扩展 Rust wire model**

保持 struct wire 兼容：

```rust
pub enum FitModelTermKind { Main, Interaction, Power }

pub struct FitModelTerm {
    pub kind: FitModelTermKind,
    pub column_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exponent: Option<u8>,
}
```

main/interaction 要求 exponent 为 None；power 要求一个列名且 exponent 为 Some(2)。term resolver 在生成任何 matrix 前执行 256 上限和 strong hierarchy。

- [ ] **Step 4: 扩展 ResolvedTerm 与 ModelMatrixSpec**

为 `ResolvedTerm` 提供：

```rust
pub fn interaction_columns(&self) -> Option<&[String]>;
pub fn power_column(&self) -> Option<(&str, u8)>;
```

matrix row transform 统一复用一个 feature evaluator：

```rust
fn evaluate_term(
    term: &ResolvedTerm,
    values: &BTreeMap<String, f64>,
    centers: &BTreeMap<String, f64>,
    centering: &FitModelCenteringMethod,
) -> Result<f64, MatrixError>;
```

training transform 和新增 `transform_point(&BTreeMap<String, f64>)` 必须调用同一 evaluator，避免 Profiler 与拟合 basis 漂移。

- [ ] **Step 5: 修复所有 struct literals 和错误映射**

为旧 Rust tests 的 main/interaction literal 添加 `exponent: None`；service 的 `map_term_error` 增加 `TooManyTerms`、`InvalidExponent`、`PowerRequiresMainEffect` 和 interaction arity 文案。

- [ ] **Step 6: 验证 Rust term/matrix/service**

```powershell
cargo test engine::fit_model::terms -- --nocapture
cargo test engine::fit_model::matrix -- --nocapture
cargo test services::fit_model_service -- --nocapture
cargo test commands::fit_model_commands -- --nocapture
```

- [ ] **Step 7: 提交 Rust matrix 任务**

```powershell
git add -- src-tauri/src/models/fit_model.rs src-tauri/src/engine/fit_model/terms.rs src-tauri/src/engine/fit_model/matrix.rs src-tauri/src/services/fit_model_service.rs src-tauri/src/commands/fit_model_commands.rs
git commit -m "feat(stats): support response surface terms"
```

---

### Task 4: 拟合快照、预测与数值方程

**Files:**
- Create: `src-tauri/src/engine/fit_model/prediction.rs`
- Create: `src/components/fitModel/fitModelEquation.ts`
- Modify: `src-tauri/src/engine/fit_model.rs`
- Modify: `src-tauri/src/engine/fit_model/ols.rs`
- Modify: `src-tauri/src/models/fit_model.rs`
- Modify: `src/types/fitModel.ts`
- Modify: `src/components/fitModel/fitModelReportModel.ts`
- Test: Rust module tests
- Test: `tests/fitModelEquation.test.ts`

**Interfaces:**
- Produces: `FitModelSnapshot`、`FitModelPredictorRange`、`predict_from_snapshot()`、`buildNumericFitModelEquation()`。
- Contract: coefficient/covariance order follows `[Intercept, resolved terms...]`。

- [ ] **Step 1: 写独立 oracle 失败测试**

Rust fixture 使用一个 noisy 二因子响应面，固定 coefficients、MSE、covariance、predictor ranges 和点预测区间。断言使用：

```rust
fn assert_close(actual: f64, expected: f64) {
    let tolerance = 1e-12_f64.max(expected.abs() * 1e-9);
    assert!((actual - expected).abs() <= tolerance, "{actual} != {expected}");
}
```

创建 `tests/fitModelEquation.test.ts`，要求系数、负号、centered interaction 和 square 显示为有限数字，不再显示占位 `Intercept + A`。

- [ ] **Step 2: 运行测试确认 RED**

```powershell
Set-Location src-tauri
cargo test engine::fit_model::prediction -- --nocapture
Set-Location ..
npx tsx --tsconfig tsconfig.app.json tests/fitModelEquation.test.ts
```

- [ ] **Step 3: 定义并返回 FitModelSnapshot**

Rust/TS 镜像 spec 中冻结的结构。将 OLS 内已有 covariance 结果放入 fitted result；不可推断时为 None/null。predictor range 从 complete-case columns 计算，拒绝空列和非有限值。

- [ ] **Step 4: 实现 Rust snapshot prediction**

```rust
pub struct FitModelPrediction {
    pub predicted: f64,
    pub mean_confidence_lower: Option<f64>,
    pub mean_confidence_upper: Option<f64>,
    pub prediction_lower: Option<f64>,
    pub prediction_upper: Option<f64>,
    pub inference_reason: Option<FitModelInferenceReason>,
}

pub fn predict_from_snapshot(
    snapshot: &FitModelSnapshot,
    values: &BTreeMap<String, f64>,
) -> Result<FitModelPrediction, FitModelEngineError>;
```

feature vector 必须通过 Task 3 的 `transform_point` 生成。MSE/covariance/df 不可用时保留 point prediction，区间为 None。

- [ ] **Step 5: 实现数值方程 model**

`fitModelEquation.ts` 只负责 presentation model，不反向解析字符串：

```ts
export interface FitModelEquationPart {
  coefficient: number;
  featureLabel: string | null;
}

export function buildNumericFitModelEquation(
  result: FitModelFittedResult,
): { response: string; parts: FitModelEquationPart[] } | null;
```

feature label 根据 resolved term 与 centers 生成 `A`、`(A - 2) * (B - 4)`、`(A - 2)^2`；UI 单独格式化系数符号，禁止字符串拼接后再解析。

- [ ] **Step 6: 验证 snapshot、旧 OLS 与方程**

```powershell
Set-Location src-tauri
cargo test engine::fit_model::prediction -- --nocapture
cargo test engine::fit_model::ols -- --nocapture
Set-Location ..
npx tsx --tsconfig tsconfig.app.json tests/fitModelEquation.test.ts
```

- [ ] **Step 7: 提交预测基础**

```powershell
git add -- src-tauri/src/engine/fit_model/prediction.rs src-tauri/src/engine/fit_model.rs src-tauri/src/engine/fit_model/ols.rs src-tauri/src/models/fit_model.rs src/types/fitModel.ts src/components/fitModel/fitModelEquation.ts src/components/fitModel/fitModelReportModel.ts tests/fitModelEquation.test.ts
git commit -m "feat(stats): expose Fit Model prediction snapshot"
```

---

### Task 5: 工程诊断内核

**Files:**
- Create: `src-tauri/src/engine/fit_model/diagnostics.rs`
- Modify: `src-tauri/src/engine/fit_model.rs`
- Modify: `src-tauri/src/engine/fit_model/ols.rs`
- Modify: `src-tauri/src/models/fit_model.rs`
- Modify: `src/types/fitModel.ts`
- Modify: `src-tauri/src/services/fit_model_service.rs`
- Test: Rust module/service tests

**Interfaces:**
- Produces: `FitModelLackOfFitResult`、`FitModelVifRow`、`FitModelRowDiagnostic`、`FitModelQqRow`、`FitModelInferenceReason`。
- Consumes: design matrix、SVD geometry、snapshot、complete-case predictor tuples、row indexes。

- [ ] **Step 1: 写 diagnostics oracle 失败测试**

覆盖 replicated fixture、无 replicate、pure error 0、saturated/perfect fit、VIF、high leverage、Cook's D 和 8,000 采样。核心断言包括：

```rust
assert_close(ss_error, ss_lack_of_fit + ss_pure_error);
assert_eq!(no_replicates.reason, Some(FitModelInferenceReason::NoReplicates));
assert!(rows.iter().all(|row| row.leverage.is_some()));
assert!(perfect_fit.rows.iter().all(|row| row.studentized_residual.is_none()));
assert!(sampled.rows.len() <= GRAPH_SCATTER_RENDER_BUDGET);
```

- [ ] **Step 2: 运行 diagnostics 测试确认 RED**

```powershell
Set-Location src-tauri
cargo test engine::fit_model::diagnostics -- --nocapture
```

- [ ] **Step 3: 实现 LOF/Pure Error 与 reason codes**

以原始 predictor bitwise value tuple 分组，仅归一化 signed zero。冻结 reason enum：

```rust
pub enum FitModelInferenceReason {
    NoReplicates,
    LackOfFitDegreesOfFreedomZero,
    PureErrorZero,
    InferenceNotEstimable,
    ConstantFeature,
    AuxiliaryRankDeficient,
    InsufficientDiagnosticRows,
}
```

- [ ] **Step 4: 实现 Feature VIF 与 row diagnostics**

VIF 对每个非截距 feature 做辅助回归；常量或秩亏返回 null + reason。使用 SVD 的 U 计算 leverage，按 internally Studentized Residual 和 Cook's D 标准公式计算；MSE/df 不可用时对应值为 null。

- [ ] **Step 5: 实现 Q-Q 和确定性采样**

先对全量有限 studentized residual 排序并生成 normal plotting positions，再按确定性 rank grid 降至 8,000；row diagnostics 同样采样但保持原始 row index。返回 `rowsSampled` 和 `sourceRowCount`。

- [ ] **Step 6: 接入 fitted result 并验证**

```powershell
cargo test engine::fit_model::diagnostics -- --nocapture
cargo test engine::fit_model::ols -- --nocapture
cargo test services::fit_model_service -- --nocapture
```

- [ ] **Step 7: 提交诊断内核**

```powershell
git add -- src-tauri/src/engine/fit_model/diagnostics.rs src-tauri/src/engine/fit_model.rs src-tauri/src/engine/fit_model/ols.rs src-tauri/src/models/fit_model.rs src-tauri/src/services/fit_model_service.rs src/types/fitModel.ts
git commit -m "feat(stats): add Fit Model engineering diagnostics"
```

---

### Task 6: 报告、Q-Q 图与逐行诊断 UI

**Files:**
- Modify: `src/components/fitModel/FitModelReport.tsx`
- Modify: `src/components/fitModel/fitModelReportModel.ts`
- Modify: `src/graphCore/fitModelAdapter.ts`
- Modify: `src/components/fitModel/FitModelDiagnosticChart.tsx`
- Modify: `src/components/fitModel/fitModel.css`
- Modify: four locale JSON files
- Test: `tests/fitModelReport.test.ts`
- Test: `tests/fitModelGraphAdapter.test.ts`
- Create: `playwright/fitModelReport.spec.tsx`

**Interfaces:**
- Consumes: Task 4/5 fitted result。
- Produces: Model Specification、numeric equation、parameter CI、LOF、Feature VIF、Residual Q-Q、Row Diagnostics。

- [ ] **Step 1: 写 report/adapter 失败测试**

扩展 static markup 测试要求新 section 标题、CI 列、LOF reason、sampled row subtitle 和 threshold flags。adapter test 固定：

```ts
const option = buildResidualQqOption({
  title: "Residual Q-Q",
  rows: [
    { rowIndex: 1, theoreticalQuantile: -0.67, studentizedResidual: -0.5 },
    { rowIndex: 2, theoreticalQuantile: 0.67, studentizedResidual: 0.8 },
  ],
  labels,
});
assert.equal((option.series as unknown[]).length, 2);
assert.doesNotMatch(JSON.stringify(option), /NaN|Infinity/);
```

- [ ] **Step 2: 运行聚焦测试确认 RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
```

- [ ] **Step 3: 扩展报告 disclosure model**

按 spec 顺序增加 sections。所有 null value 使用本地化 em dash/reason，不把 null 格式化为 0。Parameter Estimates 显示 Lower/Upper CI；Feature VIF 列明确标注 feature 层级。

- [ ] **Step 4: 实现 Q-Q adapter**

新增：

```ts
export function buildResidualQqOption(input: FitModelQqChartInput): EChartsOption;
```

使用普通 scatter + line series，两者都设置 `clip: true`；不使用 custom series，不声明无意义 encode；空/单点输入产生有限 axis extent。

- [ ] **Step 5: 实现 Row Diagnostics 表**

使用稳定列宽和横向滚动容器，支持 `all / flagged` segmented filter。warning/severe/high leverage/influential 使用图标与文本 tooltip，不只依赖颜色。采样时显示 `Sampled: m / n rows`。

- [ ] **Step 6: 添加 Playwright component 验收**

挂载一个完整 fitted fixture，断言 sections 可展开、flag filter 可用、桌面 1280x800 和窄视口 390x844 无水平页面溢出或 section 重叠。

- [ ] **Step 7: 验证报告任务**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
npx playwright test -c playwright-ct.config.ts playwright/fitModelReport.spec.tsx
npm run build
```

- [ ] **Step 8: 提交报告任务**

```powershell
git add -- src/components/fitModel/FitModelReport.tsx src/components/fitModel/fitModelReportModel.ts src/components/fitModel/FitModelDiagnosticChart.tsx src/components/fitModel/fitModel.css src/graphCore/fitModelAdapter.ts src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/fitModelReport.test.ts tests/fitModelGraphAdapter.test.ts playwright/fitModelReport.spec.tsx
git commit -m "feat(analysis): render Fit Model diagnostics"
```

---

### Task 7: Prediction Profiler

**Files:**
- Create: `src/components/fitModel/fitModelPrediction.ts`
- Create: `src/components/fitModel/FitModelProfiler.tsx`
- Modify: `src/components/fitModel/FitModelReport.tsx`
- Modify: `src/components/fitModel/fitModel.css`
- Modify: `src/graphCore/fitModelAdapter.ts`
- Modify: four locale JSON files
- Test: `tests/fitModelPrediction.test.ts`
- Create: `playwright/fitModelProfiler.spec.tsx`

**Interfaces:**
- Consumes: `FitModelSnapshot`。
- Produces: `predictFitModelPoint()`、`scanFitModelPredictor()`、interactive profiler。

- [ ] **Step 1: 写前端预测 parity 失败测试**

创建 fixture 与 Task 4 Rust oracle 使用相同 snapshot：

```ts
const prediction = predictFitModelPoint(snapshot, { A: 1.5, B: 2.5 });
assertClose(prediction.predicted, 12.3456789);
assertClose(prediction.meanConfidenceLower!, 11.9);
assertClose(prediction.predictionUpper!, 13.2);
assert.equal(prediction.extrapolatedColumns.length, 0);

const extrapolated = predictFitModelPoint(snapshot, { A: 99, B: 2.5 });
assert.deepEqual(extrapolated.extrapolatedColumns, ["A"]);
```

实际 expected 数字必须从独立 Python/R fixture 固化后写入测试，不能从当前 Rust 输出复制。

- [ ] **Step 2: 运行纯函数测试确认 RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelPrediction.test.ts
```

- [ ] **Step 3: 实现纯 TypeScript prediction kernel**

```ts
export interface FitModelPointPrediction {
  predicted: number;
  meanConfidenceLower: number | null;
  meanConfidenceUpper: number | null;
  predictionLower: number | null;
  predictionUpper: number | null;
  inferenceReason: FitModelInferenceReason | null;
  extrapolatedColumns: string[];
}

export function predictFitModelPoint(
  snapshot: FitModelSnapshot,
  values: Readonly<Record<string, number>>,
): FitModelPointPrediction;

export function scanFitModelPredictor(
  snapshot: FitModelSnapshot,
  values: Readonly<Record<string, number>>,
  columnName: string,
  points?: number,
): FitModelProfilerPoint[];
```

验证 dimension、term IDs、covariance shape 和所有有限输入；实现与 Rust 完全相同的 feature evaluator。

- [ ] **Step 4: 实现 Profiler UI**

每个 predictor 固定一列，初始化为 training mean；range input 与 number input 双向同步。滑块限制 min/max，number input 允许外推。使用 `startTransition` 更新多列 scan，保持输入响应；不默认引入 `useMemo/useCallback`。

- [ ] **Step 5: 实现 profiler chart option**

每列使用 line series 显示 predicted curve，可估计时增加 Mean CI band 与当前值参考线。若使用 custom band series，必须遵循 graphCore skill：单一 shape、无 `encode`、`clip: true`；优先使用两个 line + areaStyle 避免 custom series。

- [ ] **Step 6: Playwright 验收交互和布局**

测试滑块更新 point prediction、number input 外推 warning、不可推断时区间显示 Not estimable，以及桌面/窄视口不重叠。

- [ ] **Step 7: 验证 Profiler**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelPrediction.test.ts
npx playwright test -c playwright-ct.config.ts playwright/fitModelProfiler.spec.tsx
npm run build
```

- [ ] **Step 8: 提交 Profiler**

```powershell
git add -- src/components/fitModel/fitModelPrediction.ts src/components/fitModel/FitModelProfiler.tsx src/components/fitModel/FitModelReport.tsx src/components/fitModel/fitModel.css src/graphCore/fitModelAdapter.ts src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/fitModelPrediction.test.ts playwright/fitModelProfiler.spec.tsx
git commit -m "feat(analysis): add Fit Model prediction profiler"
```

---

### Task 8: Save Columns Rust 事务与 IPC

**Files:**
- Modify: `src-tauri/src/models/fit_model.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/fit_model_service.rs`
- Modify: `src-tauri/src/commands/fit_model_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Test: Rust engine/service/command tests

**Interfaces:**
- Produces: `FitModelSavedMetric`、`SaveFitModelColumnsRequest/Result`、`DuckDbEngine::add_valued_columns_with_change_set()`、`save_fit_model_columns` command。
- Reuses: `_history_change_sets`、`_history_change_set_columns`、before/after snapshot tables、`apply_change_set()`。

- [ ] **Step 1: 写 transaction 与 IPC 失败测试**

测试必须覆盖：9 metrics、excluded row NULL、重名整组加后缀、stale generation 零变更、写入中间失败完全回滚、Undo 删除整组、Redo 恢复列和值。核心 engine input：

```rust
pub struct ValuedColumn {
    pub name: String,
    pub column_type: String,
    pub values: Vec<(u64, Option<f64>)>,
}
```

- [ ] **Step 2: 运行聚焦 Rust 测试确认 RED**

```powershell
Set-Location src-tauri
cargo test add_valued_columns_with_change_set -- --nocapture
cargo test services::fit_model_service::tests::save_columns -- --nocapture
```

- [ ] **Step 3: 实现 DuckDB 原子 valued columns helper**

```rust
pub fn add_valued_columns_with_change_set(
    &self,
    dataset_id: &str,
    columns: &[ValuedColumn],
    expected_generation: u64,
) -> Result<(String, u64), AppError>;
```

事务顺序固定为：验证 dataset/generation/列名和值长度；解析整组唯一名称；BEGIN；创建空 before snapshot；ALTER/metadata；用 prepared `UPDATE ... WHERE _row_id = ?` 写值；创建包含全部行和值的 after snapshot；写 change-set metadata；generation 只加 1；COMMIT。任一步失败 ROLLBACK。

- [ ] **Step 4: 实现 service save 方法**

重构 `FitModelService::run` 的共享拟合准备为私有 helper，使 save 在同一 DB lock/generation 下读取、拟合、全量诊断和写列。不得先调用 public `run` 再重新锁数据库。

```rust
pub fn save_columns(
    &self,
    request: SaveFitModelColumnsRequest,
) -> Result<SaveFitModelColumnsResult, AppError>;
```

metrics 为空或包含不可估计 metric 返回 InvalidParam，不发生 mutation；excluded rows 不出现在 valued map，新增列默认 NULL。

- [ ] **Step 5: 添加 command、mutation permit 与注册**

command 使用与 data mutation command 相同的 save/mutation guard，然后委托 service；添加到 `tauri::generate_handler!` 并扩展 mutation guard coverage。

- [ ] **Step 6: 验证 Rust mutation 全链路**

```powershell
cargo test add_valued_columns_with_change_set -- --nocapture
cargo test services::fit_model_service -- --nocapture
cargo test commands::fit_model_commands -- --nocapture
cargo test commands::mutation_guard_coverage -- --nocapture
cargo clippy -- -D warnings
```

- [ ] **Step 7: 提交后端 Save Columns**

```powershell
git add -- src-tauri/src/models/fit_model.rs src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/fit_model_service.rs src-tauri/src/commands/fit_model_commands.rs src-tauri/src/commands/mutation_guard_coverage.rs src-tauri/src/lib.rs
git commit -m "feat(data): save Fit Model diagnostic columns"
```

---

### Task 9: Save Columns UI、History 与刷新

**Files:**
- Create: `src/components/fitModel/FitModelSaveColumnsDialog.tsx`
- Modify: `src/services/fitModelService.ts`
- Modify: `src/components/fitModel/FitModelView.tsx`
- Modify: `src/components/fitModel/FitModelReport.tsx`
- Modify: `src/components/fitModel/fitModel.css`
- Modify: `src/components/Workspace.tsx`
- Modify: four locale JSON files
- Test: `tests/fitModelSaveColumns.test.ts`
- Test: `tests/workspaceFitModel.test.ts`

**Interfaces:**
- Consumes: Task 8 IPC result、`useHistoryStore.recordTable()`、Workspace `refreshDatasets()`。
- Produces: metric picker、一次可执行 change-set history、源表刷新和 stale report 状态。

- [ ] **Step 1: 写 service/UI/history 失败测试**

要求 service wrapper 精确调用：

```ts
invoke<SaveFitModelColumnsResult>("save_fit_model_columns", { request });
```

状态测试固定成功处理：

```ts
recordTable(description, {
  kind: "changeSet",
  datasetId: item.sourceDatasetId,
  changeSetId: result.changeSetId,
});
```

并断言 stale result、read-only、pending history mutation 时 Save 按钮禁用。

- [ ] **Step 2: 运行测试确认 RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelSaveColumns.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitModel.test.ts
```

- [ ] **Step 3: 实现 typed IPC wrapper 和 dialog**

dialog 显示 9 个 checkbox，默认前 5 个；当前 result reason 导致不可估计的 metric disabled 并显示原因。提交期间锁定 controls，失败保留选择并显示错误，不关闭 dialog。

- [ ] **Step 4: 接入可执行 history**

Workspace 向 FitModelView 传入 `onDatasetMutated` callback。成功后先 `recordTable`，再刷新 datasets，使 Fit Model report 因 generation 变化进入 stale 并自动重算。使用 `tryBeginTableMutation/endTableMutation` 防止 Undo 与保存并发。

- [ ] **Step 5: 验证前端 Save Columns**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelSaveColumns.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitModel.test.ts
npm run build
```

- [ ] **Step 6: 提交前端 Save Columns**

```powershell
git add -- src/components/fitModel/FitModelSaveColumnsDialog.tsx src/components/fitModel/FitModelView.tsx src/components/fitModel/FitModelReport.tsx src/components/fitModel/fitModel.css src/services/fitModelService.ts src/components/Workspace.tsx src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/fitModelSaveColumns.test.ts tests/workspaceFitModel.test.ts
git commit -m "feat(analysis): wire Fit Model saved columns history"
```

---

### Task 10: DOE Prefill 合同

**Files:**
- Modify: `src/types/fitModel.ts`
- Modify: `src/components/fitModel/fitModelDialogState.ts`
- Modify: `src/components/fitModel/FitModelRoleDialog.tsx`
- Modify: `src/components/Workspace.tsx`
- Create: `tests/fitModelPrefill.test.ts`
- Modify: `tests/workspaceFitModel.test.ts`

**Interfaces:**
- Produces: `FitModelPrefill`、`createFitModelDraft(prefill?)`、Workspace `openFitModel(prefill?)`。
- Does not produce: DOE generator 或假设不存在的 DOE result page。

- [ ] **Step 1: 写 prefill 失败测试**

```ts
const prefill: FitModelPrefill = {
  sourceDatasetId: "doe-table",
  response: { name: "Yield", type: "continuous" },
  predictors: [
    { name: "Temperature", type: "continuous" },
    { name: "Pressure", type: "continuous" },
  ],
  construct: { kind: "responseSurface" },
};

const draft = createFitModelDraft(prefill);
assert.equal(draft.response?.name, "Yield");
assert.equal(draft.construct.kind, "responseSurface");
assert.equal(draft.terms.filter((term) => term.kind === "power").length, 2);
assert.equal(draft.centeringMethod, "mean");
```

另测 source dataset 不匹配、字段不存在或非 continuous 时保留 dialog 并显示 validation，不自动运行。

- [ ] **Step 2: 运行测试确认 RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelPrefill.test.ts
```

- [ ] **Step 3: 实现预填类型和 draft 初始化**

```ts
export interface FitModelPrefill {
  sourceDatasetId: string;
  response: FieldRef;
  predictors: FieldRef[];
  construct: FitModelConstruct;
}
```

字段加载完成后按 exact name/type 验证 prefill，再构造 canonical draft。普通 Analyze > Fit Model 调用 `openFitModel()`；未来 DOE 调用 `openFitModel(prefill)`。dialog 始终要求用户点击 Create。

- [ ] **Step 4: 验证无 DOE 模块时的合同边界**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelPrefill.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitModelDialog.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitModel.test.ts
npm run build
```

- [ ] **Step 5: 提交 DOE prefill**

```powershell
git add -- src/types/fitModel.ts src/components/fitModel/fitModelDialogState.ts src/components/fitModel/FitModelRoleDialog.tsx src/components/Workspace.tsx tests/fitModelPrefill.test.ts tests/workspaceFitModel.test.ts
git commit -m "feat(doe): add Fit Model prefill contract"
```

---

### Task 11: 聚合验收、性能门槛与关闭证据

**Files:**
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-09-02-issues-83-91-fit-model-core-closure-design.md` only to set status after all gates pass
- Create: `docs/superpowers/artifacts/2026-09-02-issues-83-91-fit-model-acceptance.md`
- Create: `tests/fitModelLocaleParity.test.ts`
- Test: all Fit Model TS/Rust/Playwright suites

**Interfaces:**
- Produces: `npm run test:fit-model` 和可粘贴到 #83/#91 的验收证据。

- [ ] **Step 1: 添加前端聚合脚本**

在 `package.json` 增加显式测试列表，避免 glob 顺序或 shell 差异：

```json
"test:fit-model": "tsx --tsconfig tsconfig.app.json tests/fitModelConstruct.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelDialog.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelStore.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelArchive.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelReportState.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelEquation.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelPrediction.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelReport.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelSaveColumns.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelPrefill.test.ts && tsx --tsconfig tsconfig.app.json tests/fitModelLocaleParity.test.ts && tsx --tsconfig tsconfig.app.json tests/workspaceFitModel.test.ts && tsx --tsconfig tsconfig.app.json tests/folderStore.fitModel.test.ts"
```

`tests/fitModelLocaleParity.test.ts` 收集 `fitModel` namespace 下所有叶子 key，断言 `en`、`zh-CN`、`zh-TW`、`vi` 的 key set 完全相同且 value 均为非空字符串。

- [ ] **Step 2: 运行前端和组件测试**

```powershell
npm run test:fit-model
npx playwright test -c playwright-ct.config.ts playwright/fitModelReport.spec.tsx playwright/fitModelProfiler.spec.tsx
npm run build
```

Expected: 0 failures；仅记录已知、与本功能无关的 warning。

- [ ] **Step 3: 运行完整 Rust gates**

```powershell
Set-Location src-tauri
cargo test
cargo clippy -- -D warnings
```

Expected: 0 failures，0 clippy warnings。

- [ ] **Step 4: 执行 Tauri 手工验收**

```powershell
Set-Location ..
npm run tauri dev
```

按顺序验证：创建三种 construct；响应面方程；LOF/VIF/row diagnostics/Q-Q；Profiler 滑块、输入和外推；保存默认 5 列与全部 9 列；Undo/Redo；保存项目、关闭、重开并重算旧/新模型。

- [ ] **Step 5: 记录性能与边界证据**

验收文档记录：256 项在构造前被拒绝或成功进入拟合；8,000 row diagnostics/Q-Q 上限；101 profiler points；Save Columns generation 只增加一次；失败事务零残留。每项证据固定包含 `命令`、`输入 fixture`、`关键输出摘要`、`通过阈值`、`失败与重试结论` 五个字段，不得只记录“看起来正常”。

- [ ] **Step 6: 建立非目标后续 Issues**

关闭 #83/#91 前关联独立 Issue 编号，至少覆盖：categorical coding；stepwise/model selection；logistic/GLM；inverse prediction；desirability/optimization；扩展残差检验。验收文档记录这些编号。

- [ ] **Step 7: 更新设计状态并提交验收材料**

仅在 Steps 2-6 全部通过后，将 spec 状态从“已批准”改为“已实现并验收”，并提交：

```powershell
git add -- package.json tests/fitModelLocaleParity.test.ts docs/superpowers/specs/2026-09-02-issues-83-91-fit-model-core-closure-design.md docs/superpowers/artifacts/2026-09-02-issues-83-91-fit-model-acceptance.md
git commit -m "test(analysis): verify Fit Model core closure"
```

## Execution Notes

- 推荐按 Task 0 -> 11 串行执行；Task 6 和 Task 7 都依赖 Task 4/5 的稳定 result contract，不应提前并行。
- Task 8 的 DuckDB transaction 是最高风险任务，完成后先独立 review 再进入 Task 9。
- 每个任务只提交列出的文件；工作区已有 distribution、project archive 或用户文件改动不属于本计划时不得暂存。
- 任一数值 oracle 不一致时先停在对应 Rust task，禁止通过放宽到无意义容差或复制当前实现输出使测试变绿。
- 任一完整 build 失败时先判断是否由当前任务引入；不把无关修复混入 Fit Model commit。
