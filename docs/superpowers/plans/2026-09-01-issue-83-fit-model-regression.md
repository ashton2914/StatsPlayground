# Fit Model Regression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Analyze > Fit Model 中交付可持久化的多元线性回归分析，支持连续主效应、两因子交互、交互中心化、权威 Rust OLS 报告、Effect Summary 和两张诊断图。

**Architecture:** `FitModelItem` 只持久化可复现的模型定义；Rust `FitModelService` 通过受验证的 DuckDB 多列读取构建设计矩阵，并使用 `nalgebra` 的 SVD/QR 路径计算全量 OLS。TypeScript report controller 通过 dataset generation、request token 和 canonical configuration key 防止旧响应覆盖当前模型，诊断图只接收最多 8,000 个确定性采样点。

**Tech Stack:** React 19、TypeScript 5.7、Zustand 5、ECharts、Tauri v2、Rust 2021、DuckDB、serde、statrs 0.19.1、nalgebra 0.35.0、tsx contract tests、Playwright component tests。

**Spec:** `docs/superpowers/specs/2026-09-01-issue-83-fit-model-regression-design.md`（已批准）

## Global Constraints

- 首期只接受一个 continuous response 和至少一个 continuous main effect。
- 只支持 main effect 和 two-way interaction；`A*B` 必须同时存在 `A`、`B` main effects。
- 截距固定启用；不实现 categorical coding、polynomial、GLM、Prediction 或 Profiler。
- 项目与 IPC 使用列名，与当前 `FieldRef.name` 和 Fit Y by X 保持一致；列名失效时分析显示 unavailable，不按位置重绑。
- `mean` centering 只作用于 interaction feature，main-effect columns 保持原始尺度。
- OLS 使用全部 listwise complete-case rows；统计结果不得从图表采样数据计算。
- 诊断 IPC payload 最多返回 `GRAPH_SCATTER_RENDER_BUDGET = 8_000` 个确定性采样点。
- SVD rank tolerance 为 `max(n, p) * f64::EPSILON * sigma_max`；condition number warning threshold 为 `1e10`。
- perfect-fit relative tolerance 为 `1e-12 * SST`；p-value 显示下限为 `1e-300`；LogWorth 上限为 `300`。
- `n < p` 返回 `insufficientRows`；`rank < p` 返回 `rankDeficient`；饱和、常量 response 和完美拟合返回 `fitted` 加稳定 warning code。
- Rust 命令返回 `Result<T, AppError>`；非测试代码不得使用 `unwrap()` 或 `expect()`。
- SQL identifiers 必须先从 `_meta_columns` 验证，再通过现有 quoting helper 使用；用户输入不得直接拼入 SQL。
- Rust wire models 使用 camelCase serde；TypeScript 必须逐字段镜像。
- computed result、plot rows 和 disclosure state 不进入 project manifest。
- 所有用户可见文本必须覆盖 `en`、`zh-CN`、`zh-TW`、`vi` 四个 locale。
- 每个生产行为先写失败测试并观察预期 RED，再写最小实现。
- 不清理、暂存或提交工作区已有 `.vscode/`、target、cache、test-results 或 `xumax-test/` 内容。

## File Structure

### New Frontend Files

- `src/types/fitModel.ts`: persisted item、IPC request/result、ANOVA、parameters、warnings、diagnostic point 类型。
- `src/components/fitModel/fitModelConfig.ts`: term canonicalization、严格验证、strong hierarchy、Degree 1/2 宏和 item factory。
- `src/components/fitModel/fitModelDialogState.ts`: role/model dialog 的纯草稿状态转换。
- `src/components/fitModel/FitModelRoleDialog.tsx`: Fit Model 角色和模型构造 UI。
- `src/components/fitModel/FitModelView.tsx`: 当前 item、报告请求、remove/refit/undo 和报告编排。
- `src/components/fitModel/useFitModelReport.ts`: configuration-key/generation-fenced request controller。
- `src/components/fitModel/fitModelReportModel.ts`: report formatting、Effect Summary 排序与 LogWorth clamp。
- `src/components/fitModel/FitModelReport.tsx`: disclosure tables、Effect Summary 和状态 UI。
- `src/components/fitModel/FitModelDiagnosticChart.tsx`: ECharts 实例生命周期与 resize。
- `src/components/fitModel/fitModel.css`: dialog、report、tables、charts 的局部样式。
- `src/components/fitModel/index.ts`: public component exports。
- `src/stores/useFitModelStore.ts`: analysis CRUD、load normalization、counter 和 source cascade。
- `src/services/fitModelService.ts`: typed Tauri `invoke<FitModelResult>()` wrapper。
- `src/graphCore/fitModelAdapter.ts`: Actual by Predicted 与 Residual by Predicted ECharts options。

### New Rust Files

- `src-tauri/src/models/fit_model.rs`: camelCase request/result wire models。
- `src-tauri/src/engine/fit_model.rs`: pure engine facade 和公共计算入口。
- `src-tauri/src/engine/fit_model/terms.rs`: strict term resolver 与 strong hierarchy。
- `src-tauri/src/engine/fit_model/matrix.rs`: immutable `ModelMatrixSpec`、centers 和 feature transform。
- `src-tauri/src/engine/fit_model/ols.rs`: SVD rank、QR/SVD solve、OLS inference 和 deterministic plot sampling。
- `src-tauri/src/services/fit_model_service.rs`: request validation、generation check、DuckDB read 和 engine dispatch。
- `src-tauri/src/commands/fit_model_commands.rs`: thin Tauri command。

### New Tests

- `tests/fitModelConfig.test.ts`
- `tests/fitModelDialog.test.ts`
- `tests/fitModelStore.test.ts`
- `tests/folderStore.fitModel.test.ts`
- `tests/fitModelArchive.test.ts`
- `tests/fitModelReportState.test.ts`
- `tests/fitModelReport.test.ts`
- `tests/fitModelGraphAdapter.test.ts`
- `tests/workspaceFitModel.test.ts`

### Existing Files To Modify

- Frontend exports: `src/types/index.ts`, `src/services/index.ts`, `src/stores/index.ts`。
- Project contract: `src/services/projectService.ts`, `src/types/project.ts`。
- Folder/workspace: `src/stores/useFolderStore.ts`, `src/components/Workspace.tsx`。
- Locales: `src/i18n/locales/en.json`, `zh-CN.json`, `zh-TW.json`, `vi.json`。
- Rust dependency/registries: `src-tauri/Cargo.toml`, `Cargo.lock`, `src-tauri/src/{models,engine,services,commands}/mod.rs`, `src-tauri/src/lib.rs`。
- Rust project/archive: `src-tauri/src/models/save.rs`, `src-tauri/src/services/project_service.rs`, `spprj_archive.rs`, `streaming_project_writer.rs`, `src-tauri/src/perf_harness.rs`。
- DuckDB reader: `src-tauri/src/engine/duckdb_engine.rs`。
- Existing save/workspace tests whose struct literals or project fixtures require the new default fields。

---

### Task 1: TypeScript Model Contract And Pure Term Rules

**Files:**
- Create: `src/types/fitModel.ts`
- Create: `src/components/fitModel/fitModelConfig.ts`
- Modify: `src/types/index.ts`
- Test: `tests/fitModelConfig.test.ts`

**Interfaces:**
- Consumes: `FieldRef` from `src/graphCore/types.ts`。
- Produces: `FitModelItem`, `FitModelTerm`, `FitModelRequest`, `FitModelResult`, `canonicalInteraction`, `validateFitModelDefinition`, `applyFactorialDegree`, `fitModelParameterCount`, `createFitModelItem`。

- [ ] **Step 1: Write the failing pure-contract test**

Create `tests/fitModelConfig.test.ts` with assertions for canonical interaction order, duplicate detection, response/predictor separation, continuous-only roles, strong hierarchy, Degree 1/2 macro output and parameter count:

```ts
import assert from "node:assert/strict";
import {
  applyFactorialDegree,
  canonicalInteraction,
  createFitModelItem,
  fitModelParameterCount,
  validateFitModelDefinition,
} from "../src/components/fitModel/fitModelConfig.ts";

const response = { name: "Yield", type: "continuous" as const };
const temperature = { name: "Temperature", type: "continuous" as const };
const pressure = { name: "Pressure", type: "continuous" as const };

assert.deepEqual(canonicalInteraction("Temperature", "Pressure"), ["Pressure", "Temperature"]);
assert.deepEqual(applyFactorialDegree([temperature, pressure], 1), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
]);
assert.deepEqual(applyFactorialDegree([temperature, pressure], 2), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);
assert.equal(fitModelParameterCount(applyFactorialDegree([temperature, pressure], 2)), 4);
assert.deepEqual(validateFitModelDefinition({ response, terms: applyFactorialDegree([temperature, pressure], 2) }), { ok: true });

assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "interaction", columnNames: ["Pressure", "Temperature"] }],
  }),
  { ok: false, reason: "missingMainEffect", columnName: "Pressure" },
);

const item = createFitModelItem({
  id: "fit-model-1",
  name: "Fit Model 1",
  sourceDatasetId: "dataset-1",
  response,
  terms: applyFactorialDegree([temperature, pressure], 2),
  centeringMethod: "mean",
  createdAt: "2026-09-01T00:00:00.000Z",
});
assert.equal(item.centeringMethod, "mean");
```

Add separate assertions for `missingResponse`, `missingTerms`, `responseInModel`, `nonContinuousResponse`, `nonContinuousPredictor`, `duplicateTerm`, invalid term arity and same-column interaction.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts
```

Expected: FAIL with module-not-found for `fitModelConfig.ts`.

- [ ] **Step 3: Define the TypeScript contract**

In `src/types/fitModel.ts`, define the persisted and wire types exactly:

```ts
import type { FieldRef } from "@/graphCore";

export type FitModelCenteringMethod = "none" | "mean";
export type FitModelTermKind = "main" | "interaction";

export interface FitModelTerm {
  kind: FitModelTermKind;
  columnNames: string[];
}

export interface FitModelItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  createdAt: string;
}

export interface FitModelRequest {
  datasetId: string;
  generation: number;
  responseColumn: string;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  confidenceLevel: number;
}

export type FitModelNotComputableReason = "insufficientRows" | "rankDeficient";
export type FitModelWarningCode =
  | "saturatedModel"
  | "constantResponse"
  | "perfectFit"
  | "illConditioned";

export interface FitModelPlotRow {
  rowIndex: number;
  observed: number;
  fitted: number;
  residual: number;
}
```

Also define `FitModelParameterEstimate`, `FitModelAnovaRow`, `FitModelSummaryOfFit`, `FitModelCenter`, `FitModelResolvedTerm`, `FitModelFittedResult`, `FitModelNotComputableResult` and:

```ts
export type FitModelResult = FitModelFittedResult | FitModelNotComputableResult;
```

`FitModelFittedResult.kind` is `"fitted"`; it includes `usedRows`, `excludedRows`, `confidenceLevel`, `terms`, `centering`, `summaryOfFit`, `anova`, `parameterEstimates`, `plotRows`, `plotRowsSampled`, and `warnings`.

- [ ] **Step 4: Implement pure model helpers**

In `fitModelConfig.ts`, expose these signatures:

```ts
export function canonicalInteraction(first: string, second: string): [string, string];
export function canonicalizeFitModelTerms(terms: readonly FitModelTerm[]): FitModelTerm[];
export function validateFitModelDefinition(input: {
  response: FieldRef | null;
  terms: readonly FitModelTerm[];
  fields?: readonly FieldRef[];
}): FitModelValidationResult;
export function applyFactorialDegree(fields: readonly FieldRef[], degree: 1 | 2): FitModelTerm[];
export function fitModelParameterCount(terms: readonly FitModelTerm[]): number;
export function createFitModelItem(input: Omit<FitModelItem, never>): FitModelItem;
```

`canonicalizeFitModelTerms` preserves first occurrence order for main effects and sorts only the two names inside an interaction. Strict validation detects duplicates after canonicalization; it does not silently remove them. `fitModelParameterCount` returns `1 + terms.length` for the required intercept.

- [ ] **Step 5: Run GREEN and adjacent typecheck**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts
npx tsc -b
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- src/types/fitModel.ts src/types/index.ts src/components/fitModel/fitModelConfig.ts tests/fitModelConfig.test.ts
git commit -m "feat(analysis): define Fit Model contract"
```

---

### Task 2: Fit Model Store And Folder Assignments

**Files:**
- Create: `src/stores/useFitModelStore.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/stores/index.ts`
- Test: `tests/fitModelStore.test.ts`
- Test: `tests/folderStore.fitModel.test.ts`

**Interfaces:**
- Consumes: Task 1 `FitModelItem`, `canonicalizeFitModelTerms`, `validateFitModelDefinition`, `assertProjectMutable`。
- Produces: `useFitModelStore`, `fitModelFolders`, `setFitModelFolder` and extended `pruneAssignments` inputs。

- [ ] **Step 1: Write failing store tests**

Test this public shape using real Zustand state resets:

```ts
interface FitModelStore {
  items: FitModelItem[];
  counter: number;
  addItem: (item: FitModelItem) => void;
  updateItem: (id: string, patch: Partial<FitModelItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: unknown[]) => void;
  reset: () => void;
  nextName: () => string;
}
```

Assert CRUD, read-only rejection, `Fit Model N` counter recovery, source cascade, deep-copy isolation, malformed item skipping, interaction canonicalization and duplicate removal during project-load normalization. The load test must preserve the first duplicate and expose a session-only `migrationWarnings` entry.

In `folderStore.fitModel.test.ts`, assert load, set, folder rename, folder delete, reset and pruning for `fitModelFolders`.

- [ ] **Step 2: Run both tests and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.fitModel.test.ts
```

Expected: FAIL because the store and folder fields do not exist.

- [ ] **Step 3: Implement the Fit Model store**

Mirror the mutability and counter conventions of `useFitYByXStore`. Keep normalization private:

```ts
function normalizeLoadedFitModel(value: unknown): {
  item: FitModelItem | null;
  warnings: string[];
};

export const useFitModelStore = create<FitModelStore>((set, get) => ({
  items: [],
  counter: 1,
  migrationWarnings: [],
  addItem: (item) => { assertProjectMutable(); /* immutable append */ },
  updateItem: (id, patch) => { assertProjectMutable(); /* validated immutable replace */ },
  renameItem: (id, name) => { assertProjectMutable(); /* trimmed non-empty name */ },
  deleteItem: (id) => { assertProjectMutable(); /* remove */ },
  deleteByDataset: (datasetId) => { assertProjectMutable(); /* cascade */ },
  loadFromProject: (values) => { /* normalize without mutability guard */ },
  reset: () => set({ items: [], counter: 1, migrationWarnings: [] }),
  nextName: () => { /* reserve Fit Model N and increment */ },
}));
```

Do not store computed result, plot rows or disclosure state.

- [ ] **Step 4: Extend folder assignments**

Add `fitModelFolders: Record<string, string>` and:

```ts
setFitModelFolder: (fitModelId: string, folderId: string | null) => void;
```

Extend folder rename/delete/reset/load and `pruneAssignments` with a `fitModelIds: Set<string>` argument. Keep the root sentinel behavior identical to Fit Y by X.

- [ ] **Step 5: Run GREEN and adjacent folder tests**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.fitModel.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.fitYByX.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- src/stores/useFitModelStore.ts src/stores/useFolderStore.ts src/stores/index.ts tests/fitModelStore.test.ts tests/folderStore.fitModel.test.ts
git commit -m "feat(analysis): persist Fit Model state"
```

---

### Task 3: Project Contract And Archive Round Trip

**Files:**
- Modify: `src/services/projectService.ts`
- Modify: `src/types/project.ts`
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`
- Test: `tests/fitModelArchive.test.ts`

**Interfaces:**
- Consumes: Task 1 `FitModelItem`, Task 2 folder map。
- Produces: backward-compatible `fitModels` and `fitModelFolders` fields through frontend save/open and Rust manifest/archive models。

- [ ] **Step 1: Write failing frontend archive contract tests**

In `fitModelArchive.test.ts`, construct a save payload containing one Fit Model item and assert `projectService` types accept:

```ts
fitModels: [fitModel],
folders: {
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  fitYByXFolders: {},
  distributionFolders: {},
  fitModelFolders: { [fitModel.id]: "folder-1" },
},
```

Extend `useProjectStore.saveLifecycle.test.ts` so save/open preserves the item definition and folder assignment but never adds `result`, `plotRows` or `reportState`.

- [ ] **Step 2: Write failing Rust archive tests**

In `spprj_archive.rs` tests, add:

```rust
#[test]
fn fit_model_round_trips_and_strips_transient_fields() {
    let analysis = serde_json::json!({
        "id": "fit-model-1",
        "name": "Fit Model 1",
        "result": { "kind": "fitted" },
        "plotRows": [{ "rowIndex": 1 }],
        "reportState": { "anova": true }
    });
    let stripped = strip_transient_fit_model_fields(vec![analysis]);
    assert!(stripped[0].get("result").is_none());
    assert!(stripped[0].get("plotRows").is_none());
    assert!(stripped[0].get("reportState").is_none());
}
```

Also deserialize a legacy manifest without either new field and assert empty defaults.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelArchive.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test services::spprj_archive::tests::fit_model
Pop-Location
```

Expected: failures identify missing project fields and sanitizer.

- [ ] **Step 4: Extend frontend and Rust project models**

Add `fitModels: unknown[]` and `fitModelFolders: Record<string, string>` everywhere Fit Y by X is currently carried. Rust fields use serde defaults:

```rust
#[serde(default)]
pub fit_models: Vec<serde_json::Value>,
#[serde(default)]
pub fit_model_folders: std::collections::HashMap<String, String>,
```

Update every `SaveProjectRequest`, `ProjectBundle` and `build_bundle` struct literal in production and tests. Preserve existing user changes in those files.

- [ ] **Step 5: Add the sanitizer and streaming forwarding**

Implement:

```rust
fn strip_transient_fit_model_fields(values: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    values.into_iter().map(|mut value| {
        if let Some(object) = value.as_object_mut() {
            object.remove("result");
            object.remove("plotRows");
            object.remove("reportState");
        }
        value
    }).collect()
}
```

Call it at archive ingress, and forward both new fields through `streaming_project_writer` and `perf_harness` without changing streaming behavior.

- [ ] **Step 6: Run GREEN**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelArchive.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test services::spprj_archive::tests
& $cargo test services::project_service::tests
Pop-Location
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- src/services/projectService.ts src/types/project.ts src-tauri/src/models/save.rs src-tauri/src/services/project_service.rs src-tauri/src/services/spprj_archive.rs src-tauri/src/services/streaming_project_writer.rs src-tauri/src/perf_harness.rs tests/useProjectStore.saveLifecycle.test.ts tests/fitModelArchive.test.ts
git commit -m "feat(project): archive Fit Model definitions"
```

---

### Task 4: Rust Wire Models, Term Resolver, And Model Matrix

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/models/fit_model.rs`
- Create: `src-tauri/src/engine/fit_model.rs`
- Create: `src-tauri/src/engine/fit_model/terms.rs`
- Create: `src-tauri/src/engine/fit_model/matrix.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/engine/mod.rs`

**Interfaces:**
- Produces: Rust mirrors of Task 1 wire types, `resolve_terms`, `ResolvedTerm`, `ModelMatrixSpec::from_columns`, `transform_training_columns`。
- Consumes: `nalgebra` and validated numeric columns supplied later by DuckDB reader。

- [ ] **Step 1: Write failing model serialization and term tests**

Add model tests proving request fields serialize as `datasetId`, `responseColumn`, `columnNames`, `centeringMethod`, `confidenceLevel`; result enum serializes `kind: "fitted" | "notComputable"`.

In `terms.rs`, add tests equivalent to:

```rust
#[test]
fn interaction_requires_both_main_effects() {
    let terms = vec![term("interaction", &["A", "B"]), term("main", &["A"])];
    assert_eq!(resolve_terms(&terms), Err(TermError::MissingMainEffect("B".into())));
}

#[test]
fn reversed_interaction_is_a_duplicate() {
    let terms = vec![
        term("main", &["A"]), term("main", &["B"]),
        term("interaction", &["A", "B"]), term("interaction", &["B", "A"]),
    ];
    assert_eq!(resolve_terms(&terms), Err(TermError::DuplicateTerm("A*B".into())));
}
```

In `matrix.rs`, test raw and mean-centered interaction features. For rows `A=[1,3]`, `B=[2,6]`, mean centers are `2` and `4`; the centered interaction column is `[2,2]` while main columns remain `[1,3]` and `[2,6]`.

- [ ] **Step 2: Run RED**

```powershell
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test models::fit_model::tests
& $cargo test engine::fit_model::terms::tests
& $cargo test engine::fit_model::matrix::tests
Pop-Location
```

Expected: compilation fails because the modules and nalgebra dependency do not exist.

- [ ] **Step 3: Add dependency and wire models**

Add `nalgebra = "0.35.0"` without disabling its default `std` and `macros` features. This release requires Rust 1.89.0; the verified workspace toolchain is Rust 1.98.0. Define Rust models matching Task 1, including:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FitModelTerm {
    pub kind: FitModelTermKind,
    pub column_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FitModelResult {
    Fitted(FitModelFittedResult),
    NotComputable(FitModelNotComputableResult),
}
```

Use enums for all reason/warning values, not free-form strings.

- [ ] **Step 4: Implement strict terms and immutable matrix spec**

Expose:

```rust
pub fn resolve_terms(terms: &[FitModelTerm]) -> Result<Vec<ResolvedTerm>, TermError>;

pub struct ModelMatrixSpec {
    pub terms: Vec<ResolvedTerm>,
    pub centering_method: FitModelCenteringMethod,
    pub centers: Vec<FitModelCenter>,
}

impl ModelMatrixSpec {
    pub fn from_columns(
        terms: Vec<ResolvedTerm>,
        centering_method: FitModelCenteringMethod,
        columns: &BTreeMap<String, Vec<f64>>,
    ) -> Result<Self, MatrixError>;
    pub fn transform_training_columns(
        &self,
        columns: &BTreeMap<String, Vec<f64>>,
    ) -> Result<DMatrix<f64>, MatrixError>;
}
```

The first design-matrix column is all ones. Main effects follow request order; interactions follow their canonical resolved order. Centers are computed only for columns participating in interactions and only from complete-case rows.

- [ ] **Step 5: Run GREEN**

```powershell
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test models::fit_model::tests
& $cargo test engine::fit_model::terms::tests
& $cargo test engine::fit_model::matrix::tests
Pop-Location
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/models/fit_model.rs src-tauri/src/models/mod.rs src-tauri/src/engine/fit_model.rs src-tauri/src/engine/fit_model/terms.rs src-tauri/src/engine/fit_model/matrix.rs src-tauri/src/engine/mod.rs
git commit -m "feat(stats): define Fit Model matrix contract"
```

---

### Task 5: Stable OLS Engine And Statistical Oracle

**Files:**
- Create: `src-tauri/src/engine/fit_model/ols.rs`
- Modify: `src-tauri/src/engine/fit_model.rs`

**Interfaces:**
- Consumes: Task 4 `ModelMatrixSpec`, `DMatrix<f64>`, response values and row indexes。
- Produces: `fit_linear_model(input: FitModelData, confidence_level: f64) -> Result<FitModelResult, FitModelEngineError>`。

- [ ] **Step 1: Port fixed fixtures as failing Rust tests**

Create tests for exact/noisy line, exact/noisy plane, replicated $2^2$ interaction and mean-centered interaction using values from:

```text
C:\Users\xumax\AI Project\sixsigmacopilot\sixsigma-mvp\backend\tests\fixtures\regression_cases.py
```

Copy numeric fixture values and expected oracle numbers into Rust test constants; do not import or execute Python at runtime. Use:

```rust
fn assert_close(actual: f64, expected: f64) {
    let tolerance = 1e-12_f64.max(1e-9 * expected.abs());
    assert!((actual - expected).abs() <= tolerance,
        "actual={actual}, expected={expected}, tolerance={tolerance}");
}
```

Assert coefficients, fitted values, residuals, SSE/SSM/SST identity, ANOVA df, RMSE, $R^2$, adjusted $R^2$, standard errors, t ratios, p-values and confidence limits.

- [ ] **Step 2: Add failing degeneracy and sampling tests**

Cover:

```rust
// n < p -> NotComputable::InsufficientRows
// rank < p -> NotComputable::RankDeficient
// n == p full rank -> Fitted + SaturatedModel, inference null
// constant response -> Fitted + ConstantResponse, R2/F null
// perfect fit -> Fitted + PerfectFit, undefined tests null
// condition number > 1e10 -> Fitted + IllConditioned
// 8_001 rows -> exactly 8_000 deterministic plot rows and sampled=true
```

Run the same 8,001-row fit twice and assert identical sampled row indexes including first and last valid ranks.

- [ ] **Step 3: Run RED**

```powershell
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test engine::fit_model::ols::tests -- --nocapture
Pop-Location
```

Expected: FAIL because `fit_linear_model` is absent.

- [ ] **Step 4: Implement rank and coefficient solve**

Implement this decision order:

```rust
if n < p { return not_computable(InsufficientRows); }
let svd = design.clone().svd(false, false);
let sigma_max = svd.singular_values.max();
let rank_tolerance = (n.max(p) as f64) * f64::EPSILON * sigma_max;
let rank = svd.singular_values.iter().filter(|value| **value > rank_tolerance).count();
if rank < p { return not_computable(RankDeficient); }
```

Use QR solve for the full-rank ordinary path and SVD solve only as the stable fallback accepted by nalgebra's API. Do not compute coefficients through a direct inverse of $X^TX$.

- [ ] **Step 5: Implement inference and finite-output policy**

Compute SSE, SST, SSM, df, MSE, RMSE, ANOVA and coefficient covariance. Use `statrs::{StudentsT, FisherSnedecor}` for two-sided t and upper-tail F probabilities. Clamp only roundoff-sized negative SSE/SSM within `1e-12 * max(SST, 1)`; return `FitModelEngineError::NumericalFailure` beyond that range.

Map all mathematically undefined or non-finite display statistics to `None`. Add warnings in deterministic order:

```rust
SaturatedModel, ConstantResponse, PerfectFit, IllConditioned
```

Sample plot rows after fitting by deterministic rank-grid selection capped at `GRAPH_SCATTER_RENDER_BUDGET`.

- [ ] **Step 6: Run GREEN**

```powershell
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test engine::fit_model::ols::tests -- --nocapture
Pop-Location
```

Expected: fixtures and degeneracy tests pass within frozen tolerances.

- [ ] **Step 7: Commit Task 5**

```powershell
git add -- src-tauri/src/engine/fit_model.rs src-tauri/src/engine/fit_model/ols.rs
git commit -m "feat(stats): implement stable OLS regression"
```

---

### Task 6: DuckDB Reader, Service, Command, And IPC Wrapper

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Create: `src-tauri/src/services/fit_model_service.rs`
- Create: `src-tauri/src/commands/fit_model_commands.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/services/fitModelService.ts`
- Modify: `src/services/index.ts`

**Interfaces:**
- Consumes: Task 4 wire models and Task 5 engine。
- Produces: `DuckDbEngine::read_fit_model_rows`, `FitModelService::run`, Tauri command `fit_model`, `fitModelService.run(request)`。

- [ ] **Step 1: Write failing DuckDB reader tests**

Add tests beside existing Fit Y by X reader tests. Seed `_row_id`, response and two predictors with null, numeric, NaN/infinite and nonnumeric cases. Assert:

```rust
assert_eq!(result.used_rows.len(), 2);
assert_eq!(result.excluded_rows, 4);
assert_eq!(result.used_rows[0].row_index, 1);
assert_eq!(result.predictor_names, vec!["A", "B"]);
```

Also assert missing dataset, stale generation, unknown column, duplicate response/model column and non-continuous modeling type return `AppError::InvalidParam` before query execution.

- [ ] **Step 2: Write failing service/command tests**

Use the Fit Y by X service test pattern to prove confidence level validation, term error mapping, generation fencing and thin command delegation. Add a source-contract assertion that `lib.rs` registers:

```rust
commands::fit_model_commands::fit_model,
```

- [ ] **Step 3: Run RED**

```powershell
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test engine::duckdb_engine::tests::fit_model
& $cargo test services::fit_model_service::tests
& $cargo test commands::fit_model_commands::tests
Pop-Location
```

Expected: missing reader/service/command failures.

- [ ] **Step 4: Implement one-query validated row loading**

Expose:

```rust
pub struct FitModelDataRow {
    pub row_index: u64,
    pub response: f64,
    pub predictors: Vec<f64>,
}

pub struct FitModelDataSet {
    pub predictor_names: Vec<String>,
    pub used_rows: Vec<FitModelDataRow>,
    pub excluded_rows: u64,
}

pub fn read_fit_model_rows(
    &self,
    dataset_id: &str,
    generation: u64,
    response_column: &str,
    predictor_columns: &[String],
) -> Result<FitModelDataSet, AppError>;
```

Deduplicate predictor projection names only after strict term validation. Validate every requested name through metadata, quote validated identifiers, select `_row_id` plus all model columns once, and perform listwise finite conversion in Rust.

- [ ] **Step 5: Implement service and command**

```rust
impl FitModelService {
    pub fn run(&self, request: FitModelRequest) -> Result<FitModelResult, AppError> {
        validate_confidence_level(request.confidence_level)?;
        let terms = resolve_terms(&request.terms).map_err(map_term_error)?;
        let predictor_names = required_column_names(&terms);
        let data = self.engine.read_fit_model_rows(
            &request.dataset_id,
            request.generation,
            &request.response_column,
            &predictor_names,
        )?;
        calculate_fit_model(data, terms, request.centering_method, request.confidence_level)
            .map_err(map_engine_error)
    }
}
```

The Tauri command takes `State<'_, AppState>` and delegates only. Register it in `generate_handler!`.

- [ ] **Step 6: Add typed frontend service**

```ts
import { invoke } from "@tauri-apps/api/core";
import type { FitModelRequest, FitModelResult } from "@/types/fitModel";

export const fitModelService = {
  run(request: FitModelRequest): Promise<FitModelResult> {
    return invoke<FitModelResult>("fit_model", { request });
  },
};
```

- [ ] **Step 7: Run GREEN**

```powershell
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test engine::duckdb_engine::tests::fit_model
& $cargo test services::fit_model_service::tests
& $cargo test commands::fit_model_commands::tests
Pop-Location
npx tsc -b
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 6**

```powershell
git add -- src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/fit_model_service.rs src-tauri/src/services/mod.rs src-tauri/src/commands/fit_model_commands.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/services/fitModelService.ts src/services/index.ts
git commit -m "feat(analysis): expose Fit Model statistics"
```

---

### Task 7: Generation-Fenced Report Controller

**Files:**
- Create: `src/components/fitModel/useFitModelReport.ts`
- Test: `tests/fitModelReportState.test.ts`

**Interfaces:**
- Consumes: Task 1 request types, Task 6 `fitModelService.run`, existing authoritative dataset generation lookup。
- Produces: `fitModelConfigurationKey`, `createFitModelReportController`, `useFitModelReport` with `idle | loading | success | stale | error` state。

- [ ] **Step 1: Write failing configuration identity tests**

Assert canonical interaction ordering produces the same key, while any change to response, term set/order, centering, confidence or generation changes it:

```ts
const key = fitModelConfigurationKey({
  responseColumn: "Y",
  terms: [{ kind: "interaction", columnNames: ["B", "A"] }],
  centeringMethod: "mean",
  confidenceLevel: 0.95,
  generation: 4,
});
assert.equal(key, fitModelConfigurationKey({
  responseColumn: "Y",
  terms: [{ kind: "interaction", columnNames: ["A", "B"] }],
  centeringMethod: "mean",
  confidenceLevel: 0.95,
  generation: 4,
}));
```

- [ ] **Step 2: Write failing stale-response tests**

Use deferred promises to prove:

- request B supersedes request A for the same item;
- dataset generation change invalidates A;
- item switch/unmount invalidates A;
- configuration change keeps previous success visible with `status: "stale"`;
- failed replacement request keeps previous result but attaches current error;
- only matching token and `configurationKey` commit as current success.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReportState.test.ts
```

Expected: missing controller module.

- [ ] **Step 4: Implement the pure controller and React hook**

Expose state:

```ts
export type FitModelReportState =
  | { status: "idle"; result: null; error: null; configurationKey: null }
  | { status: "loading"; result: FitModelResult | null; error: null; configurationKey: string }
  | { status: "success"; result: FitModelResult; error: null; configurationKey: string }
  | { status: "stale"; result: FitModelResult; error: string | null; configurationKey: string }
  | { status: "error"; result: FitModelResult | null; error: string; configurationKey: string };
```

Build the request at confidence `0.95`. Increment a local token before each run and invalidation. Check item ID, dataset ID, generation, token and configuration key before committing a response.

- [ ] **Step 5: Run GREEN**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReportState.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXReportState.test.ts
```

Expected: both report-controller suites pass.

- [ ] **Step 6: Commit Task 7**

```powershell
git add -- src/components/fitModel/useFitModelReport.ts tests/fitModelReportState.test.ts
git commit -m "feat(analysis): fence Fit Model report requests"
```

---

### Task 8: Report Tables, Effect Summary, Remove/Refit, And Undo

**Files:**
- Create: `src/components/fitModel/fitModelReportModel.ts`
- Create: `src/components/fitModel/FitModelReport.tsx`
- Create: `src/components/fitModel/FitModelView.tsx`
- Create: `src/components/fitModel/index.ts`
- Modify: `src/stores/useFitModelStore.ts`
- Test: `tests/fitModelReport.test.ts`

**Interfaces:**
- Consumes: Task 2 item updates, Task 7 report hook, Task 1 result types。
- Produces: report view model, disclosure UI, effect removal guard, one-step undo and `FitModelView`。

- [ ] **Step 1: Write failing report-model tests**

Assert:

```ts
assert.equal(logWorth(0.05), -Math.log10(0.05));
assert.equal(logWorth(0), 300);
assert.equal(logWorth(1e-320), 300);
assert.equal(logWorth(null), null);
```

Build effects with p-values `0.05`, `0.001`, `null` and assert descending order with null last. Assert parameter p-value supplies each one-df effect's p-value. Assert mean centering does not relabel the main effect as a different term.

Add removal tests: interaction removal succeeds; main effect referenced by interaction returns `requiredByInteraction`; last main effect returns `lastMainEffect`; valid removal returns next terms and an undo snapshot.

- [ ] **Step 2: Write failing source/render contracts**

Render fixed result objects through the repository's existing React test approach and assert headings, Summary of Fit, ANOVA, Parameter Estimates, fitted equation inputs, warnings, not-computable reason, stale badge, error-with-old-result, `aria-expanded`, Remove and Undo labels.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReport.test.ts
```

Expected: missing report modules.

- [ ] **Step 4: Implement pure report model**

```ts
export function logWorth(pValue: number | null): number | null {
  if (pValue === null) return null;
  return Math.min(300, -Math.log10(Math.max(1e-300, pValue)));
}

export function buildEffectSummary(result: FitModelFittedResult): FitModelEffectRow[];
export function removeFitModelTerm(
  terms: readonly FitModelTerm[],
  termId: string,
): FitModelRemoveResult;
```

Use existing numeric/p-value formatting conventions from `FitYByXReport.tsx`. Do not format values in Rust.

- [ ] **Step 5: Implement report and view state**

Use local disclosure state initialized to the documented section defaults. `FitModelView` owns:

```ts
interface FitModelUndoSnapshot {
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
}
```

On valid Remove, snapshot the current definition, update the item through `useFitModelStore`, and let Task 7 refit. Undo restores exactly one snapshot and triggers another request. A blocked remove leaves item and result unchanged and shows a localized inline notice.

- [ ] **Step 6: Run GREEN**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelReport.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXReport.test.ts
npx tsc -b
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Task 8**

```powershell
git add -- src/components/fitModel/fitModelReportModel.ts src/components/fitModel/FitModelReport.tsx src/components/fitModel/FitModelView.tsx src/components/fitModel/index.ts src/stores/useFitModelStore.ts tests/fitModelReport.test.ts
git commit -m "feat(analysis): render Fit Model report"
```

---

### Task 9: Actual/Predicted And Residual/Predicted Charts

**Required skill at execution:** Read `.github/skills/graphcore-echarts/SKILL.md` before editing chart code.

**Files:**
- Create: `src/graphCore/fitModelAdapter.ts`
- Create: `src/components/fitModel/FitModelDiagnosticChart.tsx`
- Modify: `src/components/fitModel/FitModelReport.tsx`
- Test: `tests/fitModelGraphAdapter.test.ts`

**Interfaces:**
- Consumes: Task 1 `FitModelPlotRow[]` and `plotRowsSampled`。
- Produces: `buildActualByPredictedOption`, `buildResidualByPredictedOption`, reusable diagnostic chart component。

- [ ] **Step 1: Write failing adapter tests**

With plot rows `[(observed=2,fitted=1.5,residual=.5), (4,4.5,-.5)]`, assert:

```ts
assert.deepEqual(actual.series[0].data, [[1.5, 2], [4.5, 4]]);
assert.deepEqual(residual.series[0].data, [[1.5, 0.5], [4.5, -0.5]]);
assert.equal(actual.xAxis.name, "Predicted");
assert.equal(actual.yAxis.name, "Actual");
assert.equal(residual.yAxis.name, "Residual");
```

Assert Actual/Predicted has a finite `y=x` line spanning the combined actual/fitted extent, Residual/Predicted has a finite `y=0` line, tooltip values are finite, empty data returns a valid nonblank option, and sampled input exposes a localized sampling subtitle rather than altering points.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
```

Expected: missing adapter.

- [ ] **Step 3: Implement the two option builders**

Expose:

```ts
export function buildActualByPredictedOption(input: FitModelChartInput): EChartsOption;
export function buildResidualByPredictedOption(input: FitModelChartInput): EChartsOption;
```

Use an ordinary scatter series with stable symbol size and `progressive` settings, plus one `line` series or `markLine` for the reference. Filter no values silently: Task 1 contract guarantees finite plot rows, so throw a descriptive adapter error if a non-finite value crosses the boundary.

- [ ] **Step 4: Implement chart lifecycle**

Mirror `DistributionChart.tsx`: initialize once, call `setOption(..., { notMerge: true })`, observe container resize, dispose on unmount, and use fixed responsive height constraints so loading/title changes cannot resize the report unexpectedly.

- [ ] **Step 5: Run GREEN and visual compatibility**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelGraphAdapter.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionVisualCompatibility.test.ts
npx tsc -b
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 9**

```powershell
git add -- src/graphCore/fitModelAdapter.ts src/components/fitModel/FitModelDiagnosticChart.tsx src/components/fitModel/FitModelReport.tsx tests/fitModelGraphAdapter.test.ts
git commit -m "feat(analysis): add regression diagnostic charts"
```

---

### Task 10: Role And Model Construction Dialog

**Files:**
- Create: `src/components/fitModel/fitModelDialogState.ts`
- Create: `src/components/fitModel/FitModelRoleDialog.tsx`
- Modify: `src/components/fitModel/index.ts`
- Test: `tests/fitModelDialog.test.ts`

**Interfaces:**
- Consumes: Task 1 validation/macros/factory, `dataService.getColumns`, `getColumnDisplayProps`。
- Produces: `FitModelRoleDialog({ dataset, onCreateDefinition, onCancel })` and pure draft reducers。

- [ ] **Step 1: Write failing dialog-state tests**

Test pure actions for assign/clear response, toggle main, add/remove interaction, apply Degree 1/2, set centering, search fields and `canCreate`. Assert:

- assigning a current main effect as response is blocked;
- removing a main referenced by an interaction is blocked and lists interaction labels;
- removing the final main is blocked;
- removing the last interaction resets hidden centering to `none`;
- macros change only terms, not response or centering;
- nominal/ordinal/datetime/id fields are unavailable for response and model terms;
- Create stays disabled until strict validation succeeds.

- [ ] **Step 2: Write failing component source contracts**

Assert the component uses accessible buttons, labels, `aria-describedby` for validation, keyboard assignment, search, Main Effects, Interactions, Macros, Degree 1/2, Center Interactions, Current Model Terms, parameter count, Create and Cancel. Assert no complete-case row count is calculated in the frontend.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelDialog.test.ts
```

Expected: missing dialog modules.

- [ ] **Step 4: Implement pure draft transitions**

```ts
export interface FitModelDraft {
  response: FieldRef | null;
  mainEffects: FieldRef[];
  interactions: Array<[string, string]>;
  centeringMethod: FitModelCenteringMethod;
  validationMessage: FitModelDialogMessage | null;
}

export function reduceFitModelDraft(
  draft: FitModelDraft,
  action: FitModelDraftAction,
): FitModelDraft;
export function termsFromDraft(draft: FitModelDraft): FitModelTerm[];
export function canCreateFitModel(draft: FitModelDraft): boolean;
```

All reducers return new arrays and never mutate `FieldRef` inputs.

- [ ] **Step 5: Implement the dialog**

Follow the Fit Y by X dialog's column-loading and display metadata flow. `onCreateDefinition` receives `{ response, terms, centeringMethod }`; Workspace reserves the ID/name and calls `createFitModelItem`. The dialog must not write to Zustand before Create.

- [ ] **Step 6: Run GREEN**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/fitModelDialog.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXDialog.test.ts
npx tsc -b
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Task 10**

```powershell
git add -- src/components/fitModel/fitModelDialogState.ts src/components/fitModel/FitModelRoleDialog.tsx src/components/fitModel/index.ts tests/fitModelDialog.test.ts
git commit -m "feat(analysis): add Fit Model dialog"
```

---

### Task 11: Workspace, Menu, Project Tree, Locales, And Layout

**Files:**
- Modify: `src/components/Workspace.tsx`
- Create: `src/components/fitModel/fitModel.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Test: `tests/workspaceFitModel.test.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 8 and 10 stores/components/contracts。
- Produces: complete Analyze > Fit Model document lifecycle in Workspace。

- [ ] **Step 1: Write failing Workspace lifecycle test**

Mirror `workspaceFitYByX.test.ts` and assert source contracts for:

- menu label and enabled condition `activeDatasetId && !readOnly`;
- dialog open/cancel/create;
- `Fit Model N` name reservation;
- active selection clearing for table/graph/tabulate/Fit Y by X/distribution;
- tree grouping under `fitModelFolders`;
- selection, rename, delete, context menu and drag payload `{ kind: "fitModel", id }`;
- source-table cascade deletion;
- close/reset/open/save integration;
- missing source unavailable view;
- read-only mutation guards;
- main-pane dispatch to `FitModelView`.

- [ ] **Step 2: Write failing locale and layout assertions**

Assert every `fitModel.*`, `menu.fitModel`, history and workspace key exists in all four locale JSON files. Assert CSS provides bounded dialog dimensions, non-overlapping role/model columns, scrollable report, compact tables, disclosure buttons, stable chart height and narrow viewport wrapping.

- [ ] **Step 3: Run RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitModel.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
```

Expected: missing Workspace and locale wiring.

- [ ] **Step 4: Wire Workspace state and lifecycle**

Add `fitModelItems`, counter/actions, `activeFitModelId`, `showFitModelDialog`, folder selectors, context-menu and drag union members. Extend prune with the Task 2 `fitModelIds` set. Save:

```ts
fitModels: fitModelItems,
fitModelFolders: folderPayload.fitModelFolders,
```

Open with `loadFitModelFromProject(result.fitModels ?? [])` and folder defaults. Reset active ID/store on close, failed open and new project. Delete dependent items with the source dataset.

- [ ] **Step 5: Add Analyze menu and tree rendering**

Place Fit Model under Fit Y by X in Analyze. Create through `FitModelRoleDialog`, reserve the store name, record localized history, select the new analysis, and enter tree rename mode consistently with other analysis documents.

- [ ] **Step 6: Add complete localization and styles**

Use concise JMP-aligned English labels and faithful translations for menu, roles, macros, report headings, stale/error states, every warning/reason, Remove, Undo and sampling notice. Do not leave English fallback strings inside components.

Keep sections unframed with disclosure bars; do not add nested cards. Set chart containers with stable `min-height`/`height` and responsive width. Ensure longest Vietnamese and Chinese labels wrap without overlapping buttons.

- [ ] **Step 7: Run GREEN and adjacent lifecycle tests**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitModel.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitYByX.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionLocale.test.ts
npx tsc -b
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 11**

```powershell
git add -- src/components/Workspace.tsx src/components/fitModel/fitModel.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/workspaceFitModel.test.ts tests/useProjectStore.saveLifecycle.test.ts
git commit -m "feat(analysis): integrate Fit Model workspace"
```

---

### Task 12: End-To-End Regression, Visual, And Build Acceptance

**Files:**
- Modify only files required by failures caused by Tasks 1-11。
- Test: all Fit Model tests plus adjacent project, graph and Fit Y by X suites。

**Interfaces:**
- Consumes: all previous tasks。
- Produces: verified Issue #83 phase-one implementation with no unresolved test or build failures introduced by this branch。

- [ ] **Step 1: Run all Fit Model frontend tests**

```powershell
$tests = @(
  "fitModelConfig", "fitModelDialog", "fitModelStore", "folderStore.fitModel",
  "fitModelArchive", "fitModelReportState", "fitModelReport",
  "fitModelGraphAdapter", "workspaceFitModel"
)
foreach ($test in $tests) {
  npx tsx --tsconfig tsconfig.app.json "tests/$test.test.ts"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: every test exits 0.

- [ ] **Step 2: Run Rust Fit Model tests**

```powershell
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test fit_model -- --nocapture
Pop-Location
```

Expected: model, terms, matrix, OLS, reader, service and command tests pass.

- [ ] **Step 3: Run adjacent regression coverage**

```powershell
$tests = @(
  "fitYByXConfig", "fitYByXStore", "fitYByXReportState", "fitYByXReport",
  "folderStore.fitYByX", "workspaceFitYByX", "useProjectStore.saveLifecycle",
  "distributionVisualCompatibility", "graphRuntime", "graphDataPipeline"
)
foreach ($test in $tests) {
  npx tsx --tsconfig tsconfig.app.json "tests/$test.test.ts"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: all adjacent tests remain green.

- [ ] **Step 4: Run full compile, build, Rust test and clippy**

```powershell
npx tsc -b
npx vite build
Push-Location src-tauri
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
& $cargo test
& $cargo clippy -- -D warnings
Pop-Location
```

Expected: all commands exit 0 with no new warnings.

- [ ] **Step 5: Run Tauri manual acceptance**

Start the application:

```powershell
npm run tauri -- dev
```

Verify one fixture each for main-effects-only, two-way interaction, mean-centered interaction, missing rows, perfect fit, saturated model and rank-deficient model. For each applicable case verify report values, warning/reason, Effect Summary, Actual by Predicted and Residual by Predicted. Also verify rapid item switching, Remove & Refit, Undo, rename, folder move, source deletion, read-only behavior and save/reopen.

- [ ] **Step 6: Inspect scope before final commit**

```powershell
git status --short
git diff --check
git diff --stat dev...HEAD
```

Expected: only Issue #83 files are tracked; pre-existing untracked `.vscode/`, target/cache/test-results and `xumax-test/` remain untouched.

- [ ] **Step 7: Commit acceptance-only fixes if present**

If Step 1-6 required code fixes, stage only those explicit files and commit:

```powershell
git commit -m "fix(analysis): complete Fit Model acceptance"
```

If no files changed after the prior task commits, do not create an empty commit.