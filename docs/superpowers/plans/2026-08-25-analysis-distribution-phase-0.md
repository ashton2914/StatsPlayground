# Analysis Distribution Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冻结 `Analyze > Distribution` 的 Phase 0 契约、项目持久化、统计结果与 chart-data 边界、Graph Builder adapter、并发/陈旧快照约束、clean-room 证据链和测试基础设施，让后续统计实现只能在已签名的边界内推进。

**Architecture:** Distribution 后端负责统计和图表所需结构化数值数据，Graph Builder 负责统一渲染、坐标轴、主题、交互和导出。Phase 0 先冻结可序列化合同、chart-data discriminated union、Graph Builder adapter 输入、项目归档和前端/Zustand 边界，再补空系统路径、能力注册表、黑盒验证结构和来源台账；不实现任何统计公式或图形。

**Tech Stack:** Rust 2021, Tauri v2, DuckDB 1.10505.0, serde, React 19, TypeScript 5.7, Zustand 5, `tsx` 4.20.5, `proptest` 1.7.0, Playwright Component Testing 1.55.0, `cargo test`.

**Spec:** [docs/superpowers/specs/2026-08-25-analysis-distribution-design.md](../specs/2026-08-25-analysis-distribution-design.md)

## Global Constraints

- 基准固定为 JMP Pro 19.0，覆盖全部四种建模类型。
- StatsPlayground 保持 Apache-2.0；本设计不授予任何第三方知识产权许可。
- 平台工具提供主程序原生等价能力，不实现 JSL。
- `DistributionRequest` 至少包含 analysis ID、config revision、run ID、dataset ID、Y 和建模类型、Weight/Freq/By、`FilterExpr`、资源预算和 `exact` 模式。
- 过滤使用版本化 `FilterExpr` AST，只允许稳定 column ID 和类型化 `and`、`or`、`not`、null、数值范围、类别集合和日期范围谓词。
- `exact` 仅表示统计计算未使用近似算法；图形简化由独立 `plotSampling` 描述。
- Distribution 计算结构化 histogram/box/Q-Q/P-P/CDF/fitted-curve 数据；Graph Builder 只负责渲染和交互，不重新推导统计量。
- UI 排版、主题和控件遵循 StatsPlayground；Phase 0 不建立独立 Distribution 图表引擎。
- 项目 manifest 正式新增 `distributions: []`、`distributionFolders: {}`、`derivedFormulas: []`；未知关键版本不静默降级。
- `BlackBoxCase` 只允许自有/脱敏输入、抽象 action ID、类型化参数、数值/枚举/状态输出、允许的 warning code 和必要 provenance；禁止自由文本产品输出。
- 阶段 0 必须固定 Rust unit/property tests、前端 test runner、Tauri/UI 自动化、版本化黄金 fixture runner、随机种子、artifact 格式和 Windows/macOS/Linux CI 矩阵及命令。
- 进入公开发布前必须完成正式法律审查；本计划只记录流程和证据链，不写任何法律结论。

---

## File Map

### Backend contracts and archive

- Create: `src-tauri/src/models/distribution.rs`
- Create: `src-tauri/src/services/distribution_service.rs`
- Create: `src-tauri/src/commands/distribution_commands.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`

### Frontend contracts, store, Graph Builder adapter, and statistical workspace skeleton

- Create: `src/types/distribution.ts`
- Modify: `src/types/filter.ts`
- Modify: `src/types/project.ts`
- Modify: `src/types/index.ts`
- Create: `src/services/distributionService.ts`
- Create: `src/graphCore/distributionAdapter.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/services/index.ts`
- Create: `src/stores/useDistributionStore.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src/stores/index.ts`
- Create: `src/components/distribution/DistributionWorkspace.tsx`
- Create: `src/components/distribution/index.ts`
- Create: `src/components/distribution/distribution.css`
- Modify: `src/components/Workspace.tsx`

### Tests, fixtures, CI, and process artifacts

- Create: `tests/distributionContracts.test.ts`
- Create: `tests/distributionGraphAdapter.test.ts`
- Create: `tests/distributionArchive.test.ts`
- Create: `tests/distributionSnapshot.test.ts`
- Create: `tests/distributionIsolation.test.ts`
- Create: `tests/distributionBlackBox.test.ts`
- Create: `tests/distributionGolden.test.ts`
- Create: `tests/fixtures/distribution/seeds.json`
- Create: `tests/fixtures/distribution/README.md`
- Create: `contracts/distribution/observation-contribution-v1.json`
- Create: `tests/e2e/DistributionWorkspace.spec.tsx`
- Create: `playwright-ct.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.github/workflows/distribution-phase0.yml`
- Create: `docs/superpowers/artifacts/2026-08-25-analysis-distribution-source-ledger.md`
- Create: `docs/superpowers/artifacts/2026-08-25-analysis-distribution-legal-review-process.md`

---

## Task 1: Versioned Contracts, Empty System Path, and Filter AST

**Files:**
- Create: `src-tauri/src/models/distribution.rs`
- Create: `src-tauri/src/services/distribution_service.rs`
- Create: `src-tauri/src/commands/distribution_commands.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/types/distribution.ts`
- Modify: `src/types/filter.ts`
- Modify: `src/types/index.ts`
- Create: `src/services/distributionService.ts`
- Modify: `src/services/index.ts`
- Test: `tests/distributionContracts.test.ts`

**Interfaces:**
- Produces Rust types: `DistributionSchemaVersionV1`, `DistributionModeV1`, `DistributionModelingTypeV1`, `DistributionColumnRefV1`, `AnalysisSnapshotV1`, `DistributionRequestV1`, `ResourceBudgetV1`, `FilterExprV1`, `ObservationContributionPolicyV1`, `DistributionReportBlockV1`, `DistributionChartDataV1`, `DistributionChartKindV1`, `CapabilityDescriptorV1`, `DistributionWorkspaceBootstrapV1`, `BlackBoxCaseV1`, `BlackBoxProvenanceV1`, `BlackBoxObservationV1`, `BlackBoxStatusV1`, `SourceLedgerEntryV1`, `LegalReviewRecordV1`.
- Produces Rust signatures: `pub fn bootstrap_distribution_workspace(&self) -> Result<DistributionWorkspaceBootstrapV1, AppError>`, `pub fn list_distribution_capabilities(&self) -> Result<Vec<CapabilityDescriptorV1>, AppError>`, `pub fn validate_black_box_case(&self, case: &BlackBoxCaseV1) -> Result<(), AppError>`.
- Produces TS mirrors: `DistributionRequestV1`, `DistributionModelingTypeV1`, `DistributionColumnRefV1`, `FilterExprV1`, `AnalysisSnapshotV1`, `ObservationContributionPolicyV1`, `ResourceBudgetV1`, `DistributionReportBlockV1`, `DistributionChartDataV1`, `DistributionChartKindV1`, `CapabilityDescriptorV1`, `BlackBoxCaseV1`, `BlackBoxObservationV1`, `DistributionWorkspaceBootstrapV1`.
- Produces adapter signature: `toGraphBuilderInput(block: DistributionChartDataV1): DistributionGraphInputV1`, where the adapter performs structural mapping only and contains no quantile, bin, whisker, test, or fit calculations.
- Produces TS service wrappers: `distributionService.bootstrapWorkspace()`, `distributionService.listCapabilities()`, `distributionService.validateBlackBoxCase(case)`, all via typed `invoke<T>()`.

- [ ] **Step 1: Write the failing contract tests**

Add one Rust test module and one TS regression file that assert these exact shapes:

```rust
#[test]
fn distribution_request_v1_serializes_camel_case_and_versioned_filter_ast() {
    let request = DistributionRequestV1 {
        schema_version: "1".to_string(),
        analysis_id: "dist-001".to_string(),
        config_revision: 7,
        run_id: "run-abc".to_string(),
        source_dataset_id: Some("ds-42".to_string()),
        source_data_version: Some("17".to_string()),
        mode: DistributionModeV1::Continuous,
        y_columns: vec![DistributionColumnRefV1 {
          column_id: "sales-amount-id".to_string(),
          modeling_type: DistributionModelingTypeV1::Continuous,
        }],
        weight_column_id: Some("sample-weight-id".to_string()),
        frequency_column_id: None,
        by_column_ids: vec!["region-id".to_string()],
        filter_expr: FilterExprV1::And {
            exprs: vec![FilterExprV1::CategorySet {
                field_id: "region".to_string(),
                values: vec!["East".to_string()],
                negate: false,
            }],
        },
        observation_policy: ObservationContributionPolicyV1::strict_v1(),
        resource_budget: ResourceBudgetV1 {
            max_groups: 1_000,
            max_rows_per_group: 100_000,
            max_total_rows: 1_000_000,
            max_total_bytes: 64 * 1024 * 1024,
            cancel_token: Some("cancel-1".to_string()),
        },
        exact: true,
    };

    let json = serde_json::to_value(&request).expect("serialize request");
    assert_eq!(json["analysisId"], "dist-001");
    assert_eq!(json["configRevision"], 7);
    assert_eq!(json["filterExpr"]["kind"], "and");
    assert_eq!(json["filterExpr"]["exprs"][0]["kind"], "categorySet");
}

#[test]
fn bootstrap_distribution_workspace_returns_empty_system_path() {
    let state = AppState::new().expect("test state");
    let service = DistributionService::new(&state);
    let bootstrap = service.bootstrap_distribution_workspace().expect("bootstrap");

    assert!(!bootstrap.can_run);
    assert!(bootstrap.capabilities.is_empty());
    assert_eq!(bootstrap.mode, DistributionModeV1::EmptySystem);
    assert_eq!(bootstrap.observation_policy.schema_version, "1");
}
```

The TS regression must assert that `distributionService.bootstrapWorkspace()` returns a `mode` of `emptySystem`, a `capabilities` array with zero entries, and a `resourceBudget` object with `maxTotalRows`, `maxTotalBytes`, and `cancelToken` keys in camelCase.

Add a contract test asserting `DistributionChartKindV1` is a closed union of `histogramData`, `boxPlotData`, `qqData`, `ppData`, `cdfData`, `fittedCurveData`, and `diagnosticCoordinateData`. Payloads must contain already-computed coordinates/counts and provenance; they must not accept raw observations for adapter-side statistical calculation.

- [ ] **Step 2: Run the focused RED checks**

Run:

```powershell
Set-Location src-tauri
cargo test models::distribution::tests::distribution_request_v1_serializes_camel_case_and_versioned_filter_ast -- --nocapture
```

Expected: compile failure because `src-tauri/src/models/distribution.rs` and its module exports do not exist yet.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionContracts.test.ts
```

Expected: module resolution failure because `src/services/distributionService.ts` and `src/types/distribution.ts` do not exist yet.

- [ ] **Step 3: Implement the minimal contract layer**

Implement the exact structs and enums above, with `#[serde(rename_all = "camelCase")]` on every public Rust contract and `export interface` / `export type` mirrors in TypeScript. Keep `FilterExprV1` versioned and closed over these variants only: `and`, `or`, `not`, `isNull`, `numericRange`, `categorySet`, `dateRange`. Keep `DistributionChartDataV1` versioned and closed over the seven chart-data kinds above.

Implement `ObservationContributionPolicyV1::strict_v1()` by deserializing `contracts/distribution/observation-contribution-v1.json`; do not add statistical behavior. The artifact must enumerate these complete dimensions as codes, not prose: `yMissing`, `weightMissing`, `weightZero`, `weightNegative`, `weightNonFinite`, `frequencyMissing`, `frequencyZero`, `frequencyNegative`, `frequencyNonInteger`, `frequencyNonFinite`, `weightAndFrequency`, `byMissing`, `emptyGroup`, `singleObservation`, and `constantColumn`. The Rust test must compare the parsed dimension-key set to this exact set so omitted combinations fail Phase 0.

Implement `bootstrap_distribution_workspace()` as a non-statistical empty-system path that only reports readiness, dataset count, a filtered capability registry, the default observation policy, and the default resource budget.

- [ ] **Step 4: Run the focused GREEN checks**

Run:

```powershell
Set-Location src-tauri
cargo test models::distribution::tests::distribution_request_v1_serializes_camel_case_and_versioned_filter_ast -- --nocapture
cargo test services::distribution_service::tests::bootstrap_distribution_workspace_returns_empty_system_path -- --nocapture
```

Expected: both tests pass.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionContracts.test.ts
```

Expected: the contract test passes and prints a single success line.

- [ ] **Step 5: Commit this slice**

```bash
git add src-tauri/src/models/distribution.rs src-tauri/src/services/distribution_service.rs src-tauri/src/commands/distribution_commands.rs src-tauri/src/models/mod.rs src-tauri/src/services/mod.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/types/distribution.ts src/types/filter.ts src/types/index.ts src/services/distributionService.ts src/services/index.ts contracts/distribution/observation-contribution-v1.json tests/distributionContracts.test.ts
git commit -m "feat(distribution): freeze phase-0 contracts"
```

---

## Task 2: Project Manifest, Save/Open, and Directory Round-Trips

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/models/project.rs`
- Modify: `src/types/project.ts`
- Modify: `src/types/index.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src/stores/index.ts`
- Modify: `src/components/Workspace.tsx`
- Create: `src/stores/useDistributionStore.ts`
- Create: `tests/distributionArchive.test.ts`

**Interfaces:**
- Produces manifest fields: `distributions`, `distributionFolders`, `derivedFormulas`, `distributionIssues`.
- Produces archive entry types: `DistributionEntryRefV1`, `DerivedFormulaEntryRefV1`, `DistributionDocV1`, `DerivedFormulaDocV1`, `DistributionArchiveEnvelopeV1`, `DerivedFormulaArchiveEnvelopeV1`.
- Produces project results: `OpenProjectResult.distributions`, `OpenProjectResult.distributionFolders`, `OpenProjectResult.derivedFormulas`, `OpenProjectResult.distributionIssues`.
- Produces store hydration methods: `useFolderStore.loadFromProject(...)`, `useDistributionStore.loadFromProject(...)`, `useDistributionStore.reset()`, `useProjectStore.openProject(...)`, `useProjectStore.saveProject(...)`.

- [ ] **Step 1: Write the failing manifest round-trip tests**

Add Rust tests that save and reopen a bundle containing one Distribution and one Derived Formula definition. The test data must use exact machine-readable examples like this:

```json
{
  "schemaVersion": "1",
  "analysisId": "dist-001",
  "name": "Distribution 1",
  "sourceDatasetId": "ds-42",
  "status": "ready",
  "currentConfig": {
    "mode": "continuous",
    "filterExpr": {
      "kind": "isNull",
      "fieldId": "region"
    }
  }
}
```

The Derived Formula example must include `formulaId`, `schemaVersion`, `analysisId`, `sourceDatasetId`, `sourceColumnIds`, `outputColumnName`, `ast`, and `fingerprint`.

Add TS tests that assert `projectService.saveProject()` forwards `distributionFolders` and the independent `derivedFormulas` collection, and `projectService.openProject()` returns them unchanged.

- [ ] **Step 2: Run the focused RED checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::spprj_archive::tests::distribution_manifest_round_trip_preserves_distribution_and_formula_folder_maps -- --nocapture
```

Expected: compile failure or test failure because the manifest fields and archive envelopes do not exist yet.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionArchive.test.ts
```

Expected: the test fails because `distributionFolders` and the independent `derivedFormulas` collection are not yet wired through `projectService`.

- [ ] **Step 3: Implement save/open and store hydration**

Extend the project manifest with the exact phase-0 fields. Keep the existing `tableFolders`, `graphFolders`, and `tabulateFolders` behavior intact.

Implement `useFolderStore` so it tracks `distributionFolders` alongside the existing tables/graphs/tabulates. `Workspace.tsx` must hydrate that map on open, clear it on close, and include Distribution rows in the Directory tree using the same folder normalization rules as other item types. Derived formula definitions remain project-level metadata/materialized table columns; they are not independent Directory nodes and have no folder map.

Implement `useDistributionStore` as the phase-0 item store for saved Distribution analyses and derived formula definitions. It should only manage project persistence, selection metadata, and empty-system bootstrap state; it must not compute statistics.

- [ ] **Step 4: Run the focused GREEN checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::spprj_archive::tests::distribution_manifest_round_trip_preserves_distribution_and_formula_folder_maps -- --nocapture
cargo test services::project_service::tests::open_project_restores_distribution_and_formula_folder_maps -- --nocapture
```

Expected: both tests pass and confirm folder maps are preserved exactly.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionArchive.test.ts
```

Expected: the TS round-trip test passes and confirms the same folder assignments are returned after save/open.

- [ ] **Step 5: Commit this slice**

```bash
git add src-tauri/src/services/spprj_archive.rs src-tauri/src/services/project_service.rs src-tauri/src/models/project.rs src/types/project.ts src/types/index.ts src/services/projectService.ts src/stores/useFolderStore.ts src/stores/useProjectStore.ts src/stores/index.ts src/components/Workspace.tsx src/stores/useDistributionStore.ts tests/distributionArchive.test.ts
git commit -m "feat(distribution): persist project manifest round-trips"
```

---

## Task 3: Unknown Version Preservation, Corruption Isolation, and Missing Source States

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/types/project.ts`
- Create: `tests/distributionIsolation.test.ts`

**Interfaces:**
- Produces `DistributionArchiveEnvelopeV1 { schemaVersion, body }` and `DerivedFormulaArchiveEnvelopeV1 { schemaVersion, body }`.
- Produces `DistributionIssueV1 { analysisId, kind, messageKey, schemaVersion, sourceDatasetId? }`.
- Produces `DistributionLoadStatusV1 = "ready" | "unknownVersion" | "missingSource" | "corrupt"`.
- Produces `OpenProjectResult.distributionIssues` and preserves the original raw JSON payload for unknown versions.

- [ ] **Step 1: Write the failing isolation tests**

Add Rust tests that cover these exact cases:

1. A Distribution entry with `schemaVersion: "99"` and a valid raw body must reopen as a preserved raw envelope, not as a dropped record.
2. A single malformed Distribution payload must be isolated to one `DistributionIssueV1`, while the rest of the project still opens.
3. A saved Distribution whose `sourceDatasetId` no longer exists must reopen as `missingSource` and remain present in the project model.

Add a TS regression that asserts `openProject()` returns one `distributionIssues` element for the malformed entry and keeps the remaining record intact.

- [ ] **Step 2: Run the focused RED checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::spprj_archive::tests::distribution_unknown_version_is_preserved_and_corruption_is_isolated -- --nocapture
```

Expected: the test fails because the archive layer still hard-parses known shapes and does not preserve the raw envelope yet.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionIsolation.test.ts
```

Expected: the test fails because `distributionIssues` and `missingSource` are not yet surfaced.

- [ ] **Step 3: Implement raw-envelope preservation and per-item isolation**

Teach the archive reader to keep unknown-version records as raw JSON blobs while still preserving their schema version, analysis ID, name, and folder placement. Do not coerce them into a lower version, and do not delete them.

Teach the project service to convert malformed or missing-source items into structured issues instead of failing the entire open operation, except when the manifest itself is unreadable. The new result must keep healthy items usable and mark broken items as read-only/unavailable.

- [ ] **Step 4: Run the focused GREEN checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::spprj_archive::tests::distribution_unknown_version_is_preserved_and_corruption_is_isolated -- --nocapture
cargo test services::project_service::tests::open_project_preserves_healthy_distributions_when_one_entry_is_corrupt -- --nocapture
```

Expected: both tests pass; unknown versions are preserved and corruption is isolated.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionIsolation.test.ts
```

Expected: the TS regression passes and confirms that the issue list is machine-readable and the surviving record stays accessible.

- [ ] **Step 5: Commit this slice**

```bash
git add src-tauri/src/services/spprj_archive.rs src-tauri/src/services/project_service.rs src-tauri/src/models/distribution.rs src/types/distribution.ts src/types/project.ts tests/distributionIsolation.test.ts
git commit -m "feat(distribution): preserve unknown versions and isolate corruption"
```

---

## Task 4: AnalysisSnapshot, Stale/Concurrency Rejection, Resource Budgets, Cancel, and Progress

**Files:**
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src/services/distributionService.ts`
- Modify: `src/stores/useDistributionStore.ts`
- Create: `tests/distributionSnapshot.test.ts`

**Interfaces:**
- Produces `AnalysisSnapshotV1 { analysisId, snapshotId, datasetId, sourceDataVersion, datasetGeneration, schemaFingerprint, filterFingerprint, createdAt }`.
- Produces `DistributionProgressV1 { runId, phase, current, total, messageKey, percent }`.
- Produces `DistributionCancelTokenV1 { cancelToken }` and `DistributionRunStateV1 { runId, status, progress, snapshotId }`.
- Produces service helpers: `take_analysis_snapshot()`, `validate_snapshot_is_current()`, `emit_progress()`, `cancel_run()`.

- [ ] **Step 1: Write the failing stale/concurrency tests**

Add Rust tests that do all of the following:

1. Capture an `AnalysisSnapshotV1` from a live dataset and then mutate the dataset generation; the stale snapshot must be rejected.
2. Spawn a concurrent mutation while a read path is running; the old result must not cross over into the new revision.
3. Validate that `DistributionProgressV1` emits monotonically increasing `current` values and that `percent` never decreases within one run.
4. Validate that `DistributionCancelTokenV1` is carried through the request envelope and can be compared as an opaque string only.

- [ ] **Step 2: Run the focused RED checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::distribution_service::tests::stale_snapshot_is_rejected_after_generation_change -- --nocapture
```

Expected: the test fails because the snapshot helpers are not implemented yet.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionSnapshot.test.ts
```

Expected: the test fails because the frontend store does not yet model snapshot, cancel, and progress state.

- [ ] **Step 3: Implement the snapshot and run-state helpers**

Implement `AnalysisSnapshotV1` as the exact join key between `analysisId`, source dataset generation, schema fingerprint, and filter fingerprint. Validate stale results by comparing the saved snapshot against the current generation and fingerprints before any result is accepted.

Implement the progress and cancel surface as pure contract plumbing: the backend should accept a cancel token, represent run state explicitly, and emit progress in machine-readable fields only. Do not add any statistical work yet; the point of Phase 0 is to prove the control plane is deterministic and reject stale work.

Implement `useDistributionStore` so it can hold snapshot IDs, cancel tokens, progress, and the current empty-system bootstrap state without leaking into unrelated stores.

- [ ] **Step 4: Run the focused GREEN checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::distribution_service::tests::stale_snapshot_is_rejected_after_generation_change -- --nocapture
cargo test services::distribution_service::tests::concurrent_mutation_marks_previous_run_stale -- --nocapture
```

Expected: both tests pass and demonstrate stale rejection and concurrency isolation.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionSnapshot.test.ts
```

Expected: the store-level snapshot, cancel, and progress test passes.

- [ ] **Step 5: Commit this slice**

```bash
git add src-tauri/src/services/distribution_service.rs src-tauri/src/models/distribution.rs src-tauri/src/services/project_service.rs src/services/distributionService.ts src/stores/useDistributionStore.ts tests/distributionSnapshot.test.ts
git commit -m "feat(distribution): add snapshot and run-state control plane"
```

---

## Task 5: Capability Registry, Sanitized BlackBoxCase, and Process Artifacts

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/commands/distribution_commands.rs`
- Modify: `src/types/distribution.ts`
- Create: `tests/distributionBlackBox.test.ts`
- Create: `docs/superpowers/artifacts/2026-08-25-analysis-distribution-source-ledger.md`
- Create: `docs/superpowers/artifacts/2026-08-25-analysis-distribution-legal-review-process.md`

**Interfaces:**
- Produces `CapabilityDescriptorV1 { id, titleKey, scope, menuScope, statusKey }` and a registry that returns only implemented capabilities.
- Produces `BlackBoxCaseV1 { caseId, actionId, provenance, inputs, expected, observed, warnings }` with no free-text product output field.
- Produces `BlackBoxProvenanceV1 { sourceLedgerHash, inputHash, outputHash, toolVersion, seed, reviewArtifactHash }`.
- Produces `SourceLedgerEntryV1 { artifactId, originKind, allowedFieldKeys, inputHash, outputHash, reviewState }` and `LegalReviewRecordV1 { artifactId, status, requestedAt, reviewerRole, artifactHash, notesHash }`.

- [ ] **Step 1: Write the failing registry and sanitizer tests**

Add tests that assert all of the following:

1. The capability registry contains only implemented IDs and never includes future statistical methods.
2. `BlackBoxCaseV1` rejects any free-text product output, raw screenshot text, or absolute filesystem path.
3. `BlackBoxProvenanceV1` stores only hashes and opaque seed IDs; it does not store raw third-party output.
4. The source ledger and legal-review artifacts record process metadata and hashes only; they do not contain legal conclusions.

Use a synthetic input corpus only. Do not import or encode any real third-party product output in the fixture.

- [ ] **Step 2: Run the focused RED checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::distribution_service::tests::capability_registry_exposes_only_implemented_methods -- --nocapture
```

Expected: the test fails because the registry and validator are not yet present.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionBlackBox.test.ts
```

Expected: the test fails because the sanitized TS contract does not yet exist.

- [ ] **Step 3: Implement registry filtering and black-box validation**

Implement the capability registry as a strict allowlist. If a capability is not implemented in Phase 0, it must not be exposed at all; there is no placeholder status and no dead method surface.

Implement `validate_black_box_case()` so it accepts only machine-readable IDs, enum codes, hashes, and structured numeric or boolean observations. Reject any free-text output, any path-like string that escapes the repository, and any provenance payload that lacks a deterministic hash.

Write the source ledger and legal-review process artifacts as process records only. They should capture case ID, artifact hash, reviewer role, request timestamp, allowed-field list, and status flow, but they must not contain legal advice, conclusions, or approval language.

- [ ] **Step 4: Run the focused GREEN checks**

Run:

```powershell
Set-Location src-tauri
cargo test services::distribution_service::tests::capability_registry_exposes_only_implemented_methods -- --nocapture
cargo test services::distribution_service::tests::black_box_case_validator_rejects_free_text_and_paths -- --nocapture
```

Expected: both tests pass and confirm the registry is implement-only and the black-box validator is sanitized.

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionBlackBox.test.ts
```

Expected: the TS contract test passes and confirms the schema only exposes hashes, enum codes, and structured outputs.

- [ ] **Step 5: Commit this slice**

```bash
git add src-tauri/src/models/distribution.rs src-tauri/src/services/distribution_service.rs src-tauri/src/commands/distribution_commands.rs src/types/distribution.ts tests/distributionBlackBox.test.ts docs/superpowers/artifacts/2026-08-25-analysis-distribution-source-ledger.md docs/superpowers/artifacts/2026-08-25-analysis-distribution-legal-review-process.md
git commit -m "feat(distribution): add capability registry and black-box process artifacts"
```

---

## Task 6: Deterministic Seeds, Golden Infrastructure, Graph Adapter, and Statistical Workspace Skeleton

**Files:**
- Create: `tests/fixtures/distribution/seeds.json`
- Create: `tests/fixtures/distribution/README.md`
- Create: `tests/distributionGolden.test.ts`
- Create: `tests/e2e/DistributionWorkspace.spec.tsx`
- Create: `playwright-ct.config.ts`
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.github/workflows/distribution-phase0.yml`
- Create: `src/components/distribution/DistributionWorkspace.tsx`
- Create: `src/components/distribution/index.ts`
- Create: `src/components/distribution/distribution.css`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useDistributionStore.ts`
- Create: `src/graphCore/distributionAdapter.ts`
- Create: `tests/distributionGraphAdapter.test.ts`

**Interfaces:**
- Produces `distributionSeeds.json` with stable `seedId`, `seed`, `caseId`, `inputHash`, `expectedHash`, and `status` fields.
- Produces a golden runner script that reads the seed corpus, runs only synthetic inputs, and compares hashes instead of third-party output text.
- Produces a minimal `DistributionWorkspace` skeleton that renders an empty-system message, statistical capability count, progress shell, cancel shell, and empty statistical-results region without performing statistics or rendering charts.
- Produces `toGraphBuilderInput()` as a structural adapter from precomputed chart-data blocks to Graph Builder inputs; it must not contain statistical formulas.
- Produces package scripts: `test:distribution`, `test:distribution:contracts`, `test:distribution:adapter`, `test:distribution:golden`, `test:distribution:blackbox`, and `test:distribution:ui`.
- Produces Rust dev dependency `proptest = "1.7.0"` and frontend dev dependencies `tsx = "4.20.5"`, `@playwright/experimental-ct-react = "1.55.0"`, and `@playwright/test = "1.55.0"`.
- Produces a CI workflow with `windows-latest`, `macos-latest`, and `ubuntu-latest` matrix jobs that run the same fixed-seed commands.

- [ ] **Step 1: Write the failing deterministic-fixture tests**

Add a golden test that reads `tests/fixtures/distribution/seeds.json`, constructs only synthetic cases, and verifies identical hashes across two runs. Add `tests/e2e/DistributionWorkspace.spec.tsx` with Playwright Component Testing to assert the empty-system UI state shows a non-statistical message, capability count `0`, an empty statistical-results region, no canvas/ECharts instance, and a disabled run button when no dataset is active.

Add `tests/distributionGraphAdapter.test.ts` with synthetic, already-computed histogram and Q-Q payloads. Assert the adapter preserves bin edges/counts and coordinates byte-for-byte, attaches Graph Builder display metadata, and never imports or calls quantile/bin/box/fit calculation helpers.

Add a Rust `proptest!` that generates nested `FilterExprV1` values up to depth 4, serializes and deserializes them, and asserts equality. Use `TestRunner::new_with_rng(Config { cases: 128, ..Config::default() }, TestRng::deterministic_rng(RngAlgorithm::ChaCha))` so CI uses a deterministic property-test stream.

- [ ] **Step 2: Run the focused RED checks**

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionGolden.test.ts
npm run test:distribution:ui
```

Expected: the runner fails because the fixture corpus and scripts do not exist; the component test fails because the skeleton and Playwright CT config do not exist.

- [ ] **Step 3: Implement the fixture runner, scripts, and skeleton UI**

Install exact frontend versions with:

```powershell
npm install --save-dev --save-exact tsx@4.20.5 @playwright/test@1.55.0 @playwright/experimental-ct-react@1.55.0
```

Add `proptest = "1.7.0"` under `[dev-dependencies]` in `src-tauri/Cargo.toml`.

Implement the golden runner with stable seeds and hash-based comparison only. Define `test:distribution:contracts` as the exact four contract/archive/isolation/snapshot TS files, `test:distribution:adapter` as `tsx tests/distributionGraphAdapter.test.ts`, `test:distribution:golden` as the golden runner, `test:distribution:blackbox` as the sanitizer runner, `test:distribution:ui` as `playwright test -c playwright-ct.config.ts`, and `test:distribution` as all five scripts in sequence.

Add the minimal statistical `DistributionWorkspace` skeleton and wire it into `Workspace.tsx` only as a dormant, empty-system-capable shell; do not surface a real statistics menu item or render a chart in Phase 0.

Implement `toGraphBuilderInput()` as a pure structural adapter. It may map names, series roles, orientation, labels, and display metadata, but it must preserve all numeric values supplied by Distribution and must not import statistical transforms from Graph Builder.

Keep the skeleton intentionally small: it should render the empty-system path, the registry count, a progress placeholder, and the cancel affordance, but it must not pretend to compute or display any statistical report.

- [ ] **Step 4: Run the focused GREEN checks**

Run:

```powershell
Set-Location ..
npm exec -- tsx tests/distributionGolden.test.ts
npm run test:distribution
npm run build
```

Expected: golden, contract, black-box, and component tests pass deterministically; the frontend build succeeds.

Run:

```powershell
Set-Location src-tauri
cargo test
```

Expected: the backend test suite and deterministic FilterExpr property test pass, including contract, archive, snapshot, and black-box tests.

The workflow matrix must use `os: [windows-latest, macos-latest, ubuntu-latest]`, Node `22`, Rust stable, `npm ci`, Playwright Chromium installation, `npm run test:distribution`, `npm run build`, and `cargo test --manifest-path src-tauri/Cargo.toml`. Upload only synthetic test artifacts and hashes; never upload validation-repository raw inputs.

- [ ] **Step 5: Commit this slice**

```bash
git add tests/fixtures/distribution/seeds.json tests/fixtures/distribution/README.md tests/distributionGolden.test.ts tests/distributionGraphAdapter.test.ts tests/e2e/DistributionWorkspace.spec.tsx playwright-ct.config.ts src-tauri/Cargo.toml package.json package-lock.json .github/workflows/distribution-phase0.yml src/components/distribution/DistributionWorkspace.tsx src/components/distribution/index.ts src/components/distribution/distribution.css src/components/Workspace.tsx src/stores/useDistributionStore.ts src/graphCore/distributionAdapter.ts
git commit -m "feat(distribution): add deterministic fixtures and workspace skeleton"
```

---

## Self-Review Checklist

- [ ] Spec coverage is complete: contracts, manifest, `AnalysisSnapshot`, stale/concurrency handling, versioned `FilterExpr`, observation policy schema, black-box schema, capability registry, process artifacts, deterministic seeds, and CI all map to a task above.
- [ ] Incomplete-step scan is clean: every step includes concrete code, schema, command, or expected result.
- [ ] Type consistency is clean: every later task only uses names introduced earlier in this plan, especially `DistributionRequestV1`, `FilterExprV1`, `AnalysisSnapshotV1`, `ObservationContributionPolicyV1`, `BlackBoxCaseV1`, `DistributionLoadStatusV1`, and `DistributionWorkspaceBootstrapV1`.
- [ ] No phase-1 math slipped in: chart-data types and the Graph Builder adapter contain no histogram, quantile, fit, Q-Q, interval, or capability calculation.
- [ ] No third-party output slipped in: the black-box path only stores hashes, enum codes, structured observations, and process metadata.

---

## Task Count, File Groups, and Gates

**任务总数：** 6

**文件组：**
- 后端契约与 archive：Distribution 模型、Tauri 命令、归档读写、project service。
- 前端契约与 store：Distribution 类型、服务封装、Zustand store、Workspace 骨架。
- 持久化与目录：Project manifest、folder store、open/save round-trip、Directory hydration。
- 测试基础设施：Rust unit/property tests、TS regression scripts、golden fixtures、synthetic seeds。
- 合规与证据链：source ledger、legal-review process artifacts、black-box validator。
- CI 与脚本：package scripts、GitHub Actions workflow、`cargo test`、`npm run build`。

**Gates：**
- Gate 1: `DistributionRequestV1`、`FilterExprV1`、`ObservationContributionPolicyV1` 和 `bootstrap_distribution_workspace()` 序列化/反序列化全部通过。
- Gate 2: `save_project` / `open_project` 能完整 round-trip `distributions`、`derivedFormulas` 和 `distributionFolders`。
- Gate 3: 未知版本、损坏条目和缺失源数据都被隔离成显式状态，不会清空健康项目内容。
- Gate 4: `AnalysisSnapshotV1` 能阻止陈旧结果和并发交叉写入，`DistributionProgressV1` 和 `DistributionCancelTokenV1` 只作为控制平面数据流动。
- Gate 5: capability registry 只暴露已实现方法，`BlackBoxCaseV1` 不接受自由文本产品输出。
- Gate 6: 固定种子 golden、Graph Builder adapter preservation test、Playwright component test、FilterExpr property test、`npm run build` 和 `cargo test` 全部通过，三平台 CI workflow 能复现本地结果。

## Phase Exit Criteria

Phase 0 完成时，仓库里必须已经有分布分析的版本化合同、chart-data union、无统计计算的 Graph Builder adapter、空系统路径、项目归档 round-trip、unknown version preservation、corruption isolation、stale snapshot rejection、capability allowlist、sanitized black-box schema、来源台账、法律流程记录、固定种子 golden runner，以及可以在 CI 上复现的统计工作区骨架。此时不允许出现任何统计公式、拟合算法、独立图表引擎或第三方输出复制。