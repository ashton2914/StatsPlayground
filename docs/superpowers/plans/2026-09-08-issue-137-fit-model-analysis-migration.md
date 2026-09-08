# Issue 137 Fit Model Analysis Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Fit Model from its parallel document lifecycle into a native Analysis kind while preserving its complete existing behavior through shared interactive table, button, and custom graph primitives.

**Architecture:** Add a persisted `fitModel` Analysis document and adapt the existing Rust/IPC compute contract into the exhaustive Analysis registries. Perform one-way legacy project migration at load, render the existing Fit Model report through shared Analysis presentation components, and remove the old Fit Model store and Workspace lifecycle only after behavior parity is proven.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, ECharts, Playwright Component Testing 1.55, Tauri v2, Rust 2021, DuckDB, serde, Node `tsx` contract tests.

**Spec:** `docs/superpowers/specs/2026-09-08-issue-137-fit-model-analysis-migration-design.md`

## Global Constraints

- Migrate Fit Model only; do not refactor Fit Y by X.
- Rust remains the sole statistical authority; do not add frontend computation.
- Persist definitions and presentation only; never persist results, diagnostics, plot rows, or disclosure state.
- Preserve full Analysis stale fencing and synchronous stale-result masking.
- Every Fit Model graph uses `AnalysisGraph` custom mode; `graphEditing` is `false` and its graph policy is `null`.
- Legacy `fitModels` and `fitModelFolders` are read-compatible and migrate one way; new saves omit them.
- Preserve malformed legacy entries as visible, non-executable documents carrying `migrationIssue`.
- Existing Analysis table calls remain source-compatible.
- Do not commit, push, or create a PR before manual acceptance; use status and bounded diff checkpoints between tasks.
- The temporary `.playwright-system-chrome.config.ts` is disposable test setup and must not enter the final change.

---

### Task 1: Fit Model Analysis Document And Adapter

**Files:**
- Modify: `src/types/analysis.ts`
- Create: `src/components/analysis/adapters/fitModelAnalysisAdapter.ts`
- Modify: `src/components/analysis/adapters/index.ts`
- Modify: `tests/analysisDocument.test.ts`
- Create: `tests/fitModelAnalysisAdapter.test.ts`

**Interfaces:**
- Consumes: `FieldRef`, `FitModelConstruct`, `FitModelTerm`, `FitModelCenteringMethod`, `FitModelLoadIssue`, and existing Fit Model validation/canonicalization helpers.
- Produces: `FitModelAnalysisDefinition`, `FitModelAnalysisPresentation`, `FitModelAnalysisDocument`, `createFitModelAnalysisDocument`, `normalizeLegacyFitModelAnalysis`, and `isFitModelAnalysisDocument`.

- [ ] **Step 1: Write document and adapter RED tests**

Assert a newly adapted Fit Model has `analysisKind/definition.kind = "fitModel"`, layout `fit-model-v1`, confidence `0.95`, cloned terms, no result fields, and no `migrationIssue`. Assert legacy duplicate terms retain the first canonical term and malformed definitions return a visible document with `migrationIssue`.

```ts
const document = createFitModelAnalysisDocument({ item, confidenceLevel: 0.95, updatedAt });
assert.equal(document.analysisKind, "fitModel");
assert.equal(document.presentation.layout, "fit-model-v1");
assert.equal(Object.hasOwn(document, "result"), false);
```

- [ ] **Step 2: Run RED**

Run:

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/fitModelAnalysisAdapter.test.ts
```

Expected: fail because the adapter and discriminated document member do not exist.

- [ ] **Step 3: Implement the minimal document member and adapter**

Keep normalization pure and return warnings separately:

```ts
interface LegacyFitModelAnalysisNormalization {
  document: FitModelAnalysisDocument | null;
  warnings: string[];
}

function normalizeLegacyFitModelAnalysis(value: unknown, updatedAt: string): LegacyFitModelAnalysisNormalization;
```

Reuse existing canonicalization and validation rules; do not duplicate model-term semantics.

- [ ] **Step 4: Run GREEN and Analysis typecheck**

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/fitModelAnalysisAdapter.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run test:analysis:typecheck
```

Expected: both pass.

- [ ] **Step 5: Checkpoint**

Run worktree status and a bounded diff stat. Confirm only Task 1 files changed.

---

### Task 2: Exhaustive Kind Registration And Rust Archive Validation

**Files:**
- Modify: `contracts/analysis/kinds.v1.json`
- Modify: `src/components/analysis/analysisKindDescriptors.ts`
- Modify: `src/components/analysis/analysisEditorRegistry.ts`
- Modify: `src/components/analysis/analysisGraphPolicies.ts`
- Modify: `src/components/analysis/analysisReportPolicies.ts`
- Modify: `src/components/analysis/analysisViewContracts.ts`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `tests/analysisKindRegistry.test.ts`
- Modify: `tests/analysisProjectContracts.test.ts`

**Interfaces:**
- Consumes: Task 1 `FitModelAnalysisDocument` and manifest identity.
- Produces: exhaustive layer registration, truthful capability flags, and Rust `validate_fit_model_analysis_definition` selected by both kind identities.

- [ ] **Step 1: Extend registry tests first**

Require exact manifest parity for:

```json
{
  "analysisKind": "fitModel",
  "documentSchemaVersion": 1,
  "definitionKind": "fitModel",
  "presentation": { "schemaVersion": 1, "layout": "fit-model-v1" }
}
```

Require descriptor capabilities `{ "graphEditing": false, "reportEmbedding": false }`, null graph/report policies, and explicit editor/view registrations.

- [ ] **Step 2: Extend the Rust manifest parity test first**

Add valid and invalid Fit Model Analysis fixtures. Mutating `definition.kind`, response shape, construct, terms, confidence level, presentation layout, or `migrationIssue` shape must fail validation.

- [ ] **Step 3: Run RED**

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run test:analysis:contracts
cargo test --manifest-path /Users/ashton/git/ashton2914/StatsPlayground-issue-137/src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts
```

Expected: failures naming missing `fitModel` registrations and validator support.

- [ ] **Step 4: Implement exhaustive registration and validator dispatch**

Add a dedicated Rust validator branch. Accept optional `migrationIssue` as `{ code: string, detail: string }`; do not weaken validation for normal new documents.

- [ ] **Step 5: Run GREEN**

Repeat both Step 3 commands. Expected: pass with all three Analysis kinds in parity.

- [ ] **Step 6: Checkpoint**

Run diagnostics on changed TypeScript/Rust files and inspect bounded diff stats.

---

### Task 3: Analysis Execution, Fingerprinting, And Stale Fencing

**Files:**
- Modify: `src/components/analysis/analysisExecutors.ts`
- Modify: `src/components/analysis/useAnalysisExecution.ts`
- Modify: `src/components/analysis/analysisViewRegistry.tsx`
- Modify: `src/components/analysis/AnalysisView.tsx`
- Modify: `tests/analysisExecution.test.ts`
- Modify: `tests/AnalysisExecutionHarness.tsx`
- Modify: `tests/analysisView.spec.tsx`

**Interfaces:**
- Consumes: Task 1 document and existing `fitModelService.run` request/result types.
- Produces: `fitModelAnalysisDefinitionFingerprint`, request construction, execute/identity/error policies, and controlled `onDefinitionChange`/`onDatasetChanged` host actions.

- [ ] **Step 1: Write execution RED tests**

Hand-derive a request fixture and assert exact dataset ID, generation, response, construct-derived terms, centering, and confidence. Assert every definition field changes the fingerprint. Assert a document with `migrationIssue` makes zero generation/service calls.

- [ ] **Step 2: Add mounted stale-fence RED coverage**

Resolve request A after a Fit Model definition/config revision changes to B. The mounted view must mask A synchronously and only render B after B resolves.

- [ ] **Step 3: Run RED**

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/analysisExecution.test.ts
/Users/ashton/git/ashton2914/StatsPlayground-issue-137/node_modules/.bin/playwright test -c /Users/ashton/git/ashton2914/StatsPlayground-issue-137/.playwright-system-chrome.config.ts tests/analysisView.spec.tsx
```

Expected: missing Fit Model executor/dispatch failures.

- [ ] **Step 4: Implement the executor and explicit AnalysisView branch**

Do not add a default/fallback dispatch. Extend `AnalysisKindViewProps` with:

```ts
onDefinitionChange?: (patch: AnalysisDocumentPatch) => void;
onDatasetChanged?: () => Promise<void>;
```

- [ ] **Step 5: Run GREEN**

Repeat Step 3. Expected: pass, including zero calls for migration-issue documents.

- [ ] **Step 6: Checkpoint**

Run `test:analysis:typecheck` and inspect only Task 3 source/test diffs.

---

### Task 4: Shared Analysis Button And Interactive Table

**Files:**
- Create: `src/components/analysis/presentation/AnalysisButton.tsx`
- Modify: `src/components/analysis/presentation/AnalysisTable.tsx`
- Modify: `src/components/analysis/presentation/index.ts`
- Modify: `src/components/analysis/analysis.css`
- Modify: `tests/AnalysisPresentationHarness.tsx`
- Modify: `tests/analysisPresentation.spec.tsx`

**Interfaces:**
- Produces: `AnalysisButtonTone`, `AnalysisButton`, `AnalysisTableSelection`, `AnalysisTableRowAction`, optional `selection`, and optional `getRowActions` props.
- Preserves: existing static table title, width, numeric alignment, row headers, and DOM hierarchy.

- [ ] **Step 1: Write real component RED tests**

Mount a static table, a controlled checkbox table, and an action table. Assert checkbox accessible names, disabled rows, controlled toggles, action labels, action callbacks, pending button disabled state, and unchanged static column count.

- [ ] **Step 2: Run RED**

```text
/Users/ashton/git/ashton2914/StatsPlayground-issue-137/node_modules/.bin/playwright test -c /Users/ashton/git/ashton2914/StatsPlayground-issue-137/.playwright-system-chrome.config.ts tests/analysisPresentation.spec.tsx
```

Expected: missing exports/props and interaction assertions fail.

- [ ] **Step 3: Implement minimal primitives**

Use native `<button>` and `<input type="checkbox">`. The table owns generated selection/action header cells; Fit Model-specific copy stays outside these components.

- [ ] **Step 4: Run GREEN**

Repeat Step 2 and run `test:analysis:typecheck`. Expected: pass.

- [ ] **Step 5: Checkpoint**

Inspect component diagnostics and bounded source diffs.

---

### Task 5: Fit Model Analysis Renderer And Custom Graphs

**Files:**
- Create: `src/components/analysis/renderers/FitModelAnalysisResults.tsx`
- Create: `src/components/analysis/renderers/fitModelAnalysisModel.ts`
- Modify: `src/components/analysis/analysisViewRegistry.tsx`
- Modify: `src/components/analysis/analysis.css`
- Modify: `tests/AnalysisViewHarness.tsx`
- Create: `tests/fitModelAnalysisModel.test.ts`
- Modify: `tests/analysisView.spec.tsx`
- Modify: `tests/e2e/FitModelReport.spec.tsx`
- Modify: `tests/e2e/FitModelProfiler.spec.tsx`
- Modify: `tests/e2e/FitModelSaveColumns.spec.tsx`

**Interfaces:**
- Consumes: Analysis execution state, Task 4 primitives, existing report-model/equation helpers, diagnostic option factories, `FitModelDiagnosticChart`, `FitModelProfiler`, and save-columns lifecycle.
- Produces: synchronous `FitModelAnalysisResults` and pure report view model sections.

- [ ] **Step 1: Write report-model RED tests**

Cover loading, source missing, migration issue, not computable, success, stale old result, error old result, diagnostics filtering, effect actions, and Save Columns availability with literal expected section keys/rows.

- [ ] **Step 2: Write component RED tests**

Assert every existing section renders, Effect Summary Remove and Undo call controlled definition changes, Save Columns uses checkbox rows, read-only disables mutation, and each of four visual modules has `data-graph-strategy="custom"`.

- [ ] **Step 3: Run RED**

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/fitModelAnalysisModel.test.ts
/Users/ashton/git/ashton2914/StatsPlayground-issue-137/node_modules/.bin/playwright test -c /Users/ashton/git/ashton2914/StatsPlayground-issue-137/.playwright-system-chrome.config.ts tests/analysisView.spec.tsx tests/e2e/FitModelReport.spec.tsx tests/e2e/FitModelProfiler.spec.tsx tests/e2e/FitModelSaveColumns.spec.tsx
```

Expected: missing renderer/model and custom graph assertions fail.

- [ ] **Step 4: Implement report composition**

Use `AnalysisShell`, `AnalysisFrame`, `AnalysisTable`, `AnalysisButton`, and `AnalysisGraph`. Reuse existing numerical formatting and ECharts option factories; do not alter graph math.

- [ ] **Step 5: Implement controlled Remove/Undo and Save Columns**

A successful term mutation sends a complete `definition` plus `configRevision + 1` and new `updatedAt`. Save Columns preserves history transaction and refresh-failure messaging.

- [ ] **Step 6: Run GREEN**

Repeat Step 3. Expected: all model and component tests pass at desktop and mobile viewports.

- [ ] **Step 7: Checkpoint**

Run Analysis typecheck and inspect renderer/CSS diff only.

---

### Task 6: One-Way Project Migration And Save Contract

**Files:**
- Create: `src/components/analysis/fitModelProjectMigration.ts`
- Modify: `src/types/project.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `tests/fitModelArchive.test.ts`
- Modify: `tests/analysisProjectContracts.test.ts`
- Modify: `tests/useProjectStore.saveLifecycle.test.ts`
- Modify: `tests/folderStore.analysis.test.ts`

**Interfaces:**
- Consumes: Task 1 legacy normalizer, `OpenProjectResult.analyses`, optional legacy fields, and both folder maps.
- Produces: `migrateLegacyFitModelsToAnalyses` returning merged documents, merged Analysis folders, and warnings.

- [ ] **Step 1: Write migration RED tests**

Cover valid, invalid, duplicate-term, ID collision, folder collision, order preservation, transient-field stripping, and no-legacy-input cases. New Analysis data wins collisions.

```ts
const migrated = migrateLegacyFitModelsToAnalyses({ analyses, fitModels, analysisFolders, fitModelFolders, updatedAt });
assert.deepEqual(migrated.analyses.map(({ id }) => id), ["new-format", "legacy-only"]);
assert.equal(migrated.analysisFolders["legacy-only"], "Analyses/Fit Models");
```

- [ ] **Step 2: Write save-contract RED tests**

Assert Workspace save payload includes the migrated document only in `analyses`, includes its folder only in `analysisFolders`, and does not emit `fitModels` or `fitModelFolders`.

- [ ] **Step 3: Run RED**

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/fitModelArchive.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/analysisProjectContracts.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts
```

Expected: missing migration function and legacy save fields still present.

- [ ] **Step 4: Implement pure merge and integrate project open/save**

Load merged documents once into `useAnalysisStore`. Feed merged folder assignments to `useFolderStore`. Keep optional legacy read fields in `OpenProjectResult`.

- [ ] **Step 5: Run GREEN and Rust archive tests**

Repeat Step 3, then run:

```text
cargo test --manifest-path /Users/ashton/git/ashton2914/StatsPlayground-issue-137/src-tauri/Cargo.toml spprj_archive
```

Expected: all pass.

- [ ] **Step 6: Checkpoint**

Inspect save payload and archive diffs; confirm no write path emits legacy Fit Model fields.

---

### Task 7: Unified Workspace Lifecycle And Legacy Removal

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useAnalysisStore.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/stores/index.ts`
- Delete: `src/stores/useFitModelStore.ts`
- Delete: `src/components/fitModel/FitModelView.tsx`
- Delete: `src/components/fitModel/useFitModelReport.ts`
- Modify: `src/components/fitModel/index.ts`
- Modify: `tests/workspaceAnalysis.test.ts`
- Modify: `tests/workspaceAnalysisLifecycle.test.ts`
- Modify: `tests/workspaceFitModel.test.ts`
- Delete or fold: `tests/fitModelStore.test.ts`
- Delete or fold: `tests/folderStore.fitModel.test.ts`
- Delete or fold: `tests/fitModelReportState.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 1-6 complete Analysis behavior.
- Produces: one Analysis store, one Analysis folder map, one selection/view dispatch, and one source cascade for all Analysis kinds.

- [ ] **Step 1: Rewrite Workspace RED contracts around behavior**

Test creation, selection, editor conversion, rename, folder move, deletion, dataset cascade, history, read-only enforcement, and view dispatch through `analysisKind: "fitModel"`. Do not retain source-text assertions for removed `setActiveFitModelId` calls.

- [ ] **Step 2: Run RED**

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/workspaceAnalysis.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/workspaceAnalysisLifecycle.test.ts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 exec -- tsx --tsconfig tsconfig.app.json tests/workspaceFitModel.test.ts
```

Expected: tests fail while Workspace still uses parallel Fit Model state.

- [ ] **Step 3: Move creation/editing into Analysis adapters and store**

Creation calls `createFitModelAnalysisDocument`, adds it with `addAnalysis`, and activates `{ kind: "analysis", id }`. Rename/delete/folder/source cascade use generic Analysis actions.

- [ ] **Step 4: Remove parallel state and obsolete modules**

Remove Fit Model store subscriptions, active ID, folder map, save/open arrays, standalone view dispatch, old controller, and obsolete exports/tests. Keep reusable dialog, pure config/model helpers, graph adapters, profiler, save-columns dialog/lifecycle, service, and backend.

- [ ] **Step 5: Run GREEN**

Repeat Step 2, then run:

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run test:analysis:contracts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run test:fit-model
```

Expected: pass with updated suites and no references to removed lifecycle modules.

- [ ] **Step 6: Checkpoint**

Run diagnostics and a bounded diff stat. Search source/tests for `useFitModelStore`, `activeFitModelId`, and `fitModelFolders`; only explicit legacy-read migration references may remain.

---

### Task 8: Full Verification, Independent Review, And Manual Acceptance Runtime

**Files:**
- Modify only files required by verified Critical/Important review findings.
- Delete: `.playwright-system-chrome.config.ts` after the last component test.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified uncommitted Issue #137 implementation ready for manual acceptance.

- [ ] **Step 1: Run focused frontend gates**

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run test:analysis:typecheck
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run test:analysis:contracts
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run test:analysis:kinds
```

- [ ] **Step 2: Run system-Chrome component gates**

Use `.playwright-system-chrome.config.ts` to run the Analysis UI and Fit Model UI file lists. Expected: zero failures.

- [ ] **Step 3: Run full Rust and production gates**

```text
cargo test --manifest-path /Users/ashton/git/ashton2914/StatsPlayground-issue-137/src-tauri/Cargo.toml
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run build
```

Expected: zero Rust failures and build exit code 0.

- [ ] **Step 4: Run independent code review**

Review the actual diff from base `2e0487f859a9`, including untracked files, against Issue 137 and the design. Repair every Critical or Important finding and rerun affected focused/full gates.

- [ ] **Step 5: Remove temporary setup and inspect final tree**

Delete `.playwright-system-chrome.config.ts`. Run `git diff --check`, bounded diff stat, status with all untracked files, and diagnostics. Confirm only intended source, tests, docs, and contract files remain.

- [ ] **Step 6: Start the worktree runtime**

Run:

```text
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-137 run tauri -- dev
```

Verify the Vite port, desktop process executable, and process cwd belong to `StatsPlayground-issue-137`.

- [ ] **Step 7: Request manual acceptance**

Provide the Issue-derived checklist: legacy migration, one project-tree entry, all report tables/actions, Remove/Undo, Save Columns, custom graphs, Profiler, save/reopen, mobile/narrow layout, Distribution regression, and Fit Y by X regression. Stop before commit/push/PR.
