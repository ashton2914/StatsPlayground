# PR #82 Distribution Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild PR #82 Distribution on the current Fit Y by X analysis framework while preserving its Rust statistical results and rendering every chart through embedded GraphRuntime instances.

**Architecture:** Merge `origin/dev` into `feat/distribution-analysis`, retain the fixture-backed Distribution kernels, and replace the old event/snapshot/workspace plumbing with current document, store, IPC, and project-v4 patterns. One Rust request returns report blocks plus precomputed graph frames; Distribution materializes ordinary embedded graph items and supplies those frames to GraphRuntime without frontend statistics.

**Tech Stack:** Tauri v2, Rust, DuckDB, statrs, argmin, React 19, TypeScript, Zustand, ECharts 6, GraphRuntime, tsx contract tests, Playwright component tests.

**Spec:** `docs/superpowers/specs/2026-09-01-pr-82-distribution-refactor-design.md`

## Global Constraints

- All implementation commits stay on `feat/distribution-analysis`; do not commit implementation code on `dev`.
- Preserve the numerical behavior frozen by PR #82 fixtures for descriptive statistics, distribution fits, and Normal capability.
- Rust remains the sole authority for binning, fitting, quantiles, capability, and chart coordinates.
- Every Distribution chart renders through `createEmbeddedGraphItem` and `GraphRuntime`; no standalone Distribution ECharts renderer remains.
- Use one generation-checked Tauri request; do not retain progress events, run IDs, cancel tokens, or persisted computed snapshots.
- Weight, Freq, and By remain Distribution roles and do not become Graph Builder drag-and-drop slots.
- Project format v4 uses stable IDs, manifest references, separate `.spdist` members, and case-sensitive manifest/member/body name parity.
- Return Rust failures through `Result<T, AppError>` without `unwrap()` or `expect()` in non-test code.

---

### Task 1: Merge The Current Framework Into The PR Branch

**Files:**
- Preserve: `src-tauri/src/services/distribution_kernel.rs`
- Preserve: `src-tauri/src/services/distribution_fit.rs`
- Preserve: `src-tauri/src/services/normal_capability.rs`
- Preserve: `tests/fixtures/distribution/**`
- Resolve: `src-tauri/src/lib.rs`
- Resolve: `src-tauri/src/models/mod.rs`
- Resolve: `src-tauri/src/services/mod.rs`
- Resolve: `src-tauri/src/commands/mod.rs`
- Resolve: `src/types/index.ts`
- Resolve: `src/services/index.ts`
- Resolve: `src/stores/index.ts`
- Resolve: `src/components/Workspace.tsx`
- Resolve: `src/i18n/locales/en.json`
- Resolve: `src/i18n/locales/zh-CN.json`
- Resolve: `src/i18n/locales/zh-TW.json`
- Resolve: `src/i18n/locales/vi.json`
- Resolve: `package.json`

**Interfaces:**
- Consumes: PR #82 at `d6130ab` plus the three design commits on `feat/distribution-analysis`.
- Produces: A merge commit containing `origin/dev` and the PR numerical modules, with no conflict markers and no Distribution framework decisions hidden in conflict resolution.

- [ ] **Step 1: Record the pre-merge numerical baseline**

Run:

```powershell
npm run test:distribution:golden
Set-Location src-tauri
cargo test distribution_kernel
cargo test distribution_fit
cargo test normal_capability
Set-Location ..
```

Expected: Existing PR fixture tests pass, or any pre-existing failure is recorded before the merge.

- [ ] **Step 2: Merge current dev into the feature branch**

Run:

```powershell
git fetch origin
git merge --no-ff --no-commit origin/dev
```

Resolve conflicts by keeping current-dev framework code in shared files and retaining PR code only in Distribution-owned modules. Do not resolve `Workspace`, project persistence, GraphRuntime, or shared stores by taking the PR side wholesale.

- [ ] **Step 3: Verify the merge structure**

Run:

```powershell
git diff --check
git grep -n "<<<<<<<\|=======\|>>>>>>>" -- ':!package-lock.json'
git merge-base --is-ancestor origin/dev HEAD
```

Expected: No whitespace errors, no conflict markers, and `origin/dev` is an ancestor of `HEAD`.

- [ ] **Step 4: Verify the preserved numerical modules**

Run the same commands from Step 1. Expected: Results match the recorded pre-merge baseline.

- [ ] **Step 5: Commit the merge**

```powershell
git commit
```

Use the generated merge message `Merge remote-tracking branch 'origin/dev' into feat/distribution-analysis`.

---

### Task 2: Freeze And Modernize The Distribution Numerical Core

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/services/distribution_fit.rs`
- Modify: `src-tauri/src/services/normal_capability.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Test: Rust `#[cfg(test)]` modules in the three service files
- Test: `tests/distributionGolden.test.ts`
- Test: `tests/fixtures/distribution/*.json`

**Interfaces:**
- Consumes: PR `PreparedObservationV1`, `PreparedGroupV1`, descriptive, fit, and capability result types.
- Produces: Pure calculation functions with current serde models and no event, snapshot, DuckDB, or frontend dependencies.

- [ ] **Step 1: Add characterization tests for the preserved public calculations**

Cover these exact entry points or their current PR equivalents:

```rust
continuous_summary(&prepared_group, 0.95)
freedman_diaconis_histogram(&prepared_group)
tukey_box(&prepared_group, 0.95)
weighted_ecdf(&prepared_group)
normal_quantile(&prepared_group)
fit_all(&prepared_group, &requested_distributions)
normal_process_summary(&prepared_group)
```

Assert fixture values for weighted and unweighted data, invalid weight/frequency rows, constant data, missing data, all five fit families, and capability indices.

- [ ] **Step 2: Run the focused Rust tests and verify RED where current-dev types are incompatible**

```powershell
Set-Location src-tauri
cargo test distribution_kernel
cargo test distribution_fit
cargo test normal_capability
Set-Location ..
```

Expected: Any failure is caused by model/module incompatibility introduced by the modern framework, not changed expected numbers.

- [ ] **Step 3: Make only compatibility edits**

Move shared wire-only structures into `models/distribution.rs`, keep formula implementation in the service modules, and preserve fixture tolerances and parameter conventions.

- [ ] **Step 4: Run focused tests and the golden contract**

```powershell
Set-Location src-tauri
cargo test distribution_kernel
cargo test distribution_fit
cargo test normal_capability
Set-Location ..
npm run test:distribution:golden
```

Expected: PASS with unchanged fixture outputs.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/models/distribution.rs src-tauri/src/services/distribution_kernel.rs src-tauri/src/services/distribution_fit.rs src-tauri/src/services/normal_capability.rs src-tauri/src/services/mod.rs tests/distributionGolden.test.ts tests/fixtures/distribution
git commit -m "refactor(distribution): preserve statistical kernels"
```

---

### Task 3: Add Generic Precomputed Graph Packets

**Files:**
- Modify: `src/types/graphData.ts`
- Modify: `src/graphCore/transform.ts`
- Test: `tests/transformAggregatePackets.test.ts`
- Create: `tests/precomputedGraphPackets.test.ts`

**Interfaces:**
- Consumes: Existing `GraphAggregatePacket`, `HistogramPacket`, `BoxPlotPacket`, and element IDs.
- Produces: Generic element-keyed point and curve packets consumed by graphCore without statistical interpretation.

Add these contracts using the existing aggregate packet naming and element-key conventions:

```typescript
export interface PrecomputedPointPacket {
  kind: "precomputedPoints";
  elementId: string;
  points: Array<{ x: number; y: number; label?: string; group?: string }>;
}

export interface PrecomputedCurvePacket {
  kind: "precomputedCurve";
  elementId: string;
  interpolation: "linear" | "stepEnd";
  points: Array<{ x: number; y: number }>;
}
```

- [ ] **Step 1: Write failing packet transform tests**

Assert that `buildGraph` renders:

- one scatter series for `precomputedPoints`;
- one symbol-free line series for a linear curve;
- one `step: "end"` line series for a stepped curve;
- no recomputed values or reordered coordinates;
- `clip: true` on any custom series introduced by the implementation.

- [ ] **Step 2: Run the new test and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/precomputedGraphPackets.test.ts
```

Expected: FAIL because the packet discriminants are not part of `GraphAggregatePacket`.

- [ ] **Step 3: Implement packet types and transform handlers**

Extend the discriminated union, locate packets by `elementId`, and build ordinary ECharts scatter/line series. Do not add Distribution names, fit models, Weight, or Freq to the generic packet types.
Update `isGraphAggregatePacket(value: unknown)` in `src/types/graphData.ts`
to validate both new discriminants and their coordinate arrays before a frame
is accepted.

- [ ] **Step 4: Verify packet and existing aggregate transforms**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/precomputedGraphPackets.test.ts
npx tsx --tsconfig tsconfig.app.json tests/transformAggregatePackets.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/types/graphData.ts src/graphCore/transform.ts tests/precomputedGraphPackets.test.ts tests/transformAggregatePackets.test.ts
git commit -m "feat(graph): render precomputed point and curve packets"
```

---

### Task 4: Let GraphRuntime Consume External Frames

**Files:**
- Modify: `src/components/graphBuilder/GraphRuntime.tsx`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Create: `tests/graphRuntimeExternalData.test.ts`
- Modify: `tests/graphRuntime.test.ts`

**Interfaces:**
- Consumes: A complete `GraphBuilderItem`, `DatasetMeta`, and optional external frame state.
- Produces: A GraphRuntime path that skips graph-data IPC while retaining graphCore rendering and all axis callbacks.

Add the public contract:

```typescript
export type ExternalGraphDataState =
  | { status: "loading"; frame: null; error: null }
  | { status: "ready"; frame: GraphDataFrame; error: null }
  | { status: "error"; frame: null; error: string };

export interface GraphRuntimeProps {
  item: GraphBuilderItem;
  dataset: DatasetMeta;
  externalDataState?: ExternalGraphDataState;
}
```

Extend `useGraphDataPipeline` with an `enabled` input. The hook must always be called; when disabled it performs no IPC and exposes an idle internal state that GraphRuntime ignores.

- [ ] **Step 1: Write the failing runtime model test**

Test that ready external data selects the external frame, loading/error states stay independent, and `enabled: false` prevents request construction while axis callbacks remain wired.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/graphRuntimeExternalData.test.ts
```

Expected: FAIL because `externalDataState` and pipeline `enabled` do not exist.

- [ ] **Step 3: Implement the minimal runtime extension**

Keep `buildGraphRuntimeModel`, resize behavior, theme handling, point selection, and axis interactions unchanged. Select external versus internal data state only after hooks have executed.

- [ ] **Step 4: Verify runtime behavior**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/graphRuntimeExternalData.test.ts
npx tsx --tsconfig tsconfig.app.json tests/graphRuntime.test.ts
npx tsx --tsconfig tsconfig.app.json tests/fitYByXAxisInteractions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/components/graphBuilder/GraphRuntime.tsx src/components/graphBuilder/useGraphDataPipeline.ts tests/graphRuntimeExternalData.test.ts tests/graphRuntime.test.ts
git commit -m "feat(graph): accept external runtime frames"
```

---

### Task 5: Replace The Distribution Event Pipeline With One IPC Request

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/engine/distribution_executor.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/commands/distribution_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/services/distributionService.ts`
- Modify: `src/services/index.ts`
- Test: Rust tests in `distribution_service.rs`
- Modify: `tests/distributionContracts.test.ts`
- Modify: `tests/distributionRunContract.test.ts`

**Interfaces:**
- Consumes: Validated role column names, source dataset ID, dataset generation, analysis options, and the pure kernels.
- Produces: `compute_distribution_report(request) -> Result<DistributionReportResponse, AppError>` and matching `distributionService.compute(request)`.

Use these wire-level shapes, following existing camelCase conventions:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionRequest {
    pub dataset_id: String,
    pub generation: u64,
    pub response_columns: Vec<String>,
    pub weight_column: Option<String>,
    pub freq_column: Option<String>,
    pub by_columns: Vec<String>,
    pub confidence_level: f64,
    pub spec_limits: HashMap<String, SpecLimitsOverride>,
    pub fit_distributions: Vec<DistributionFitKind>,
}
```

The response includes the echoed dataset ID and generation, report blocks, and `graph_frames: HashMap<String, GraphDataFrameDto>` keyed by persisted graph role (`overview`, `boxPlot`, `ecdf`, `normalQuantile`).

- [ ] **Step 1: Rewrite contract tests for one-shot behavior**

Assert camelCase JSON, generation echo, stable result/reason discriminants, all graph-frame keys, and absence of `runId`, `snapshotId`, progress-event, and cancel-command fields.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:distribution:typecheck
npx tsx --tsconfig tsconfig.app.json tests/distributionContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionRunContract.test.ts
```

Expected: FAIL against the old run/event contract.

- [ ] **Step 3: Implement current-engine materialization and service orchestration**

Validate columns before quoting identifiers, use prepared values, check generation after acquiring the database lock, preserve By ordering, and convert kernel chart output into generic aggregate packets. Keep the command as a thin delegate.

- [ ] **Step 4: Verify Rust and TypeScript contracts**

```powershell
Set-Location src-tauri
cargo test distribution_service
cargo test distribution_executor
cargo test distribution_commands
Set-Location ..
npm run test:distribution:typecheck
npx tsx --tsconfig tsconfig.app.json tests/distributionContracts.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionRunContract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/models/distribution.rs src-tauri/src/engine/distribution_executor.rs src-tauri/src/services/distribution_service.rs src-tauri/src/commands/distribution_commands.rs src-tauri/src/lib.rs src/types/distribution.ts src/services/distributionService.ts src/services/index.ts tests/distributionContracts.test.ts tests/distributionRunContract.test.ts
git commit -m "refactor(distribution): use single report request"
```

---

### Task 6: Rebuild Distribution Documents, Roles, And Report State

**Files:**
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/distributionConfig.ts`
- Create: `src/components/distribution/distributionDialogState.ts`
- Modify: `src/components/distribution/DistributionDialog.tsx`
- Modify: `src/components/distribution/DistributionRoleZone.tsx`
- Modify: `src/components/distribution/SpecificationLimitsEditor.tsx`
- Modify: `src/stores/useDistributionStore.ts`
- Create: `src/components/distribution/useDistributionReport.ts`
- Modify: `tests/distributionConfig.test.ts`
- Modify: `tests/distributionStore.test.ts`
- Create: `tests/distributionReportState.test.ts`

**Interfaces:**
- Consumes: Current `FieldRef`, `EmbeddedGraphConfig`, project mutability guard, `DatasetMeta.generation`, and `distributionService.compute`.
- Produces: Persisted `DistributionItem`, pure dialog state, document-only Zustand store, and stale-fenced transient report state.

Use the document boundary:

```typescript
export interface DistributionItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  responses: FieldRef[];
  weight: FieldRef | null;
  frequency: FieldRef | null;
  by: FieldRef[];
  analysis: DistributionAnalysisConfig;
  graphs: {
    overview: EmbeddedGraphConfig;
    boxPlot: EmbeddedGraphConfig;
    ecdf: EmbeddedGraphConfig;
    normalQuantile: EmbeddedGraphConfig;
  };
  createdAt: string;
}
```

- [ ] **Step 1: Write failing role, store, and stale-response tests**

Cover continuous responses, numeric Weight, integer-compatible Freq metadata, categorical By fields, duplicate rejection, default embedded graphs, create/rename/update/delete/reset/cascade, read-only rejection, old document normalization, and late-result rejection after item/generation/config changes.

- [ ] **Step 2: Run the tests and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/distributionConfig.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionReportState.test.ts
```

Expected: FAIL because the old store owns run/snapshot state and no focused report controller exists.

- [ ] **Step 3: Implement the document lifecycle**

Follow the current Fit Y by X config/dialog/store/controller boundaries. Keep computed results out of Zustand and use a deterministic serialization of analysis fields for the request fingerprint.

- [ ] **Step 4: Verify the focused frontend state tests**

Run the three commands from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/types/distribution.ts src/components/distribution/distributionConfig.ts src/components/distribution/distributionDialogState.ts src/components/distribution/DistributionDialog.tsx src/components/distribution/DistributionRoleZone.tsx src/components/distribution/SpecificationLimitsEditor.tsx src/stores/useDistributionStore.ts src/components/distribution/useDistributionReport.ts tests/distributionConfig.test.ts tests/distributionStore.test.ts tests/distributionReportState.test.ts
git commit -m "refactor(distribution): adopt analysis document lifecycle"
```

---

### Task 7: Render Distribution Through Embedded GraphRuntime Instances

**Files:**
- Create: `src/components/distribution/DistributionView.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `src/graphCore/distributionAdapter.ts`
- Delete: `src/components/distribution/DistributionChart.tsx`
- Delete: `src/components/distribution/DistributionWorkspace.tsx`
- Delete: `src/components/distribution/DistributionDirectoryItem.tsx`
- Modify: `src/components/distribution/distribution.css`
- Create: `tests/distributionGraphEmbedding.test.ts`
- Create: `tests/distributionAxisInteractions.test.ts`
- Modify: `tests/distributionGraphAdapter.test.ts`
- Modify: `tests/distributionReportWiring.test.ts`
- Modify: `tests/distributionVisualCompatibility.test.ts`

**Interfaces:**
- Consumes: `DistributionItem.graphs`, `DistributionReportResponse.graphFrames`, `createEmbeddedGraphItem`, and `GraphRuntime.externalDataState`.
- Produces: A Fit Y by X-style view with GraphRuntime-owned rendering and no standalone ECharts option.

- [ ] **Step 1: Write failing embedding tests**

Assert that the view:

- imports and renders `GraphRuntime`;
- materializes each graph with `createEmbeddedGraphItem`;
- passes the matching external frame;
- does not import ECharts or `DistributionChart`;
- keeps histogram and box-plot axis ranges synchronized without recursive updates;
- renders independent graph/report loading and error states.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/distributionGraphEmbedding.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionAxisInteractions.test.ts
```

Expected: FAIL because the PR view uses its standalone renderer/workspace.

- [ ] **Step 3: Implement the embedded view**

Convert `distributionAdapter.ts` to pure response-to-packet/frame helpers. Use one outer scroller, bounded graph regions, and disclosure report sections. Delete standalone rendering and directory components only after no imports remain.

- [ ] **Step 4: Verify embedding and report compatibility**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/distributionGraphEmbedding.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionAxisInteractions.test.ts
npm run test:distribution:adapter
npm run test:distribution:report
npm run test:distribution:compatibility
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/components/distribution src/graphCore/distributionAdapter.ts tests/distributionGraphEmbedding.test.ts tests/distributionAxisInteractions.test.ts tests/distributionGraphAdapter.test.ts tests/distributionReportWiring.test.ts tests/distributionVisualCompatibility.test.ts
git commit -m "refactor(distribution): render with embedded graph runtime"
```

---

### Task 8: Integrate Distribution Into Workspace And Folders

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/stores/index.ts`
- Modify: `src/components/distribution/index.ts`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`
- Create: `tests/workspaceDistribution.test.ts`
- Create: `tests/folderStore.distribution.test.ts`
- Modify: `tests/distributionLocale.test.ts`

**Interfaces:**
- Consumes: Validated dialog output and `useDistributionStore` document actions.
- Produces: Analysis menu creation, active document routing, folder movement, history, rename/delete, read-only protection, and source-table cascade behavior.

- [ ] **Step 1: Write failing workspace lifecycle tests**

Mirror the current `workspaceFitYByX.test.ts` and `folderStore.fitYByX.test.ts` expectations for Distribution, including active-item mutual exclusion and `DistributionView` dispatch.

- [ ] **Step 2: Run the tests and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceDistribution.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.distribution.test.ts
```

Expected: FAIL because the PR owns a separate workspace/directory model.

- [ ] **Step 3: Implement current Workspace integration**

Follow current Fit Y by X selection, folder, filename validation, history, and cascade patterns. Do not introduce a generic document registry.

- [ ] **Step 4: Verify workspace, folder, and locale behavior**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/workspaceDistribution.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.distribution.test.ts
npx tsx --tsconfig tsconfig.app.json tests/distributionLocale.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workspaceFitYByX.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/components/Workspace.tsx src/stores/useFolderStore.ts src/stores/index.ts src/components/distribution/index.ts src/i18n/locales tests/workspaceDistribution.test.ts tests/folderStore.distribution.test.ts tests/distributionLocale.test.ts
git commit -m "feat(distribution): integrate workspace lifecycle"
```

---

### Task 9: Add Project Format V4 Distribution Members

**Files:**
- Modify: `src/utils/projectFileNaming.ts`
- Modify: `src/types/project.ts`
- Modify: `src/services/projectService.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `tests/distributionArchive.test.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`
- Modify: `tests/projectFileNaming.test.ts`

**Interfaces:**
- Consumes: `DistributionItem[]`, folder mappings, v4 `ManifestRef`, and current archive validation helpers.
- Produces: `manifest.distributions`, `distributions/{id}.spdist`, `.spdist` naming, and strict v4 validation.

- [ ] **Step 1: Write failing archive and naming tests**

Assert:

- `.spdist` is immutable and participates in collision suffixing;
- current saves emit manifest refs and separate members;
- only manifest-indexed Distribution documents are serialized;
- missing members fail;
- duplicate IDs fail;
- manifest ID equals body ID;
- manifest name equals case-sensitive member basename and body name;
- unindexed extra members are ignored deterministically;
- legacy projects without Distribution fields load empty collections.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/distributionArchive.test.ts
npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
```

Expected: FAIL because current v4 has no Distribution document kind.

- [ ] **Step 3: Implement v4 storage by extending existing helpers**

Add Distribution to the current archive document-kind switch and reuse stable-ID, name-parity, and manifest-authority helpers. Do not restore PR inline manifest documents or persisted result snapshots.

- [ ] **Step 4: Verify frontend and Rust persistence**

```powershell
npx tsx --tsconfig tsconfig.app.json tests/distributionArchive.test.ts
npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.test.ts
npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
Set-Location src-tauri
cargo test spprj_archive
cargo test project_service
cargo test streaming_project_writer
Set-Location ..
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/utils/projectFileNaming.ts src/types/project.ts src/services/projectService.ts src/stores/useProjectStore.ts src-tauri/src/models/save.rs src-tauri/src/services/project_service.rs src-tauri/src/services/spprj_archive.rs src-tauri/src/services/streaming_project_writer.rs tests/distributionArchive.test.ts tests/useProjectStore.saveLifecycle.test.ts tests/projectFileNaming.test.ts
git commit -m "feat(project): persist distribution documents in v4"
```

---

### Task 10: Remove Legacy Control Plane And Validate End To End

**Files:**
- Delete: `src/components/distribution/continuousFitRun.ts`
- Delete: `tests/distributionContinuousFitRun.test.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/types/distribution.ts`
- Modify: `src/stores/useDistributionStore.ts`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `package.json`
- Modify: `tests/distributionSnapshot.test.ts`
- Modify: `tests/distributionIsolation.test.ts`
- Modify: `tests/distributionBlackBox.test.ts`
- Modify: `tests/e2e/DistributionDialog.spec.tsx`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`
- Modify: `tests/e2e/DistributionCharts.spec.tsx`
- Modify: `tests/e2e/DistributionDirectory.spec.tsx`
- Modify: `tests/e2e/ContinuousFitReport.spec.tsx`

**Interfaces:**
- Consumes: Completed single-shot backend, document lifecycle, GraphRuntime embedding, workspace integration, and v4 persistence.
- Produces: No reachable legacy control-plane code and one current Distribution verification suite.

- [ ] **Step 1: Rewrite legacy assertions as absence and integration tests**

Replace snapshot/run-ID expectations with checks that results are transient, late responses are isolated, close/open recomputes results, and the embedded GraphRuntime path renders all approved visual families.

- [ ] **Step 2: Run the Distribution suite and repair only migration regressions**

```powershell
npm run test:distribution
```

Expected: PASS with no tests requiring progress events, cancel commands, persisted snapshots, `DistributionChart`, or `DistributionWorkspace`.

- [ ] **Step 3: Verify legacy code is unreachable**

```powershell
git grep -n "distribution-progress\|start_distribution_run\|cancel_distribution_run\|DistributionChart\|DistributionWorkspace"
```

Expected: No production-code matches.

- [ ] **Step 4: Run full frontend validation**

```powershell
npx tsc -b
npx vite build
```

Expected: Both commands exit 0.

- [ ] **Step 5: Run full backend validation**

```powershell
Set-Location src-tauri
cargo test
cargo clippy -- -D warnings
Set-Location ..
```

Expected: Both commands exit 0. If the known streaming writer timing test fails once, rerun it once before classifying it as a regression.

- [ ] **Step 6: Run the desktop smoke test**

```powershell
npm run tauri -- dev
```

Verify creation, role validation, all embedded graphs, axis interactions, report sections, rapid document switching, rename, folders, source cascade deletion, read-only behavior, and save/reopen. Stop the development process after the smoke test.

- [ ] **Step 7: Commit cleanup**

```powershell
git add -A
git commit -m "refactor(distribution): remove legacy analysis control plane"
```