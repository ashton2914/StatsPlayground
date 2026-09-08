# Issue 89 Table Transform Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all nine Table operations reusable `.sptbtf` documents with schema-checked input bindings and one atomically refreshed stable output table.

**Architecture:** Add a strongly typed Rust Table Transform domain and mirror it in TypeScript. Existing DuckDB operation methods remain the compute primitives, while a new executor runs each operation into a temporary dataset and atomically replaces the definition's stable output; project archive, lineage, IPC, Zustand, and Workspace layers carry the definition and its project-local bindings without embedding upstream dataset IDs in the standalone file.

**Tech Stack:** Rust 2021, DuckDB, Serde, Tauri v2, React 19, TypeScript, Zustand, Node `assert`, Playwright Component Testing

**Spec:** `docs/superpowers/specs/2026-09-08-issue-89-table-transform-files-design.md`

## Global Constraints

- Support exactly Sort, Subset, Transpose, Stack, Split, Summary, Join, Update, and Concatenate in format version `1`.
- `.sptbtf` contains no table rows and no concrete upstream dataset IDs.
- Every definition owns one stable output Table ID; successful reruns preserve it and failed reruns preserve the previous output.
- Update produces a derived output and never mutates either bound input.
- Schema validation completes before temporary output creation.
- Transform Subset filters use a structured expression and bound scalar values; imported files never inject a raw SQL predicate.
- Project lineage remains the only relationship authority.
- Existing direct Table IPC commands and existing `.spprj`/`.sptb` readers remain compatible.
- Rust service and command failures use `Result<T, AppError>` without `unwrap()` or `expect()` in non-test code.
- Frontend DTOs use camelCase and mirror Serde `rename_all = "camelCase"` models.

---

## File Structure

### New Files

- `src-tauri/src/services/table_transform_domain.rs`: versioned definition DTOs, operation union, structured filter AST, validation, input-role rules, and schema-contract derivation.
- `src-tauri/src/services/table_transform_service.rs`: project-local bindings, execution result DTOs, temporary execution, stable-output replacement, and lineage updates.
- `src/types/tableTransform.ts`: TypeScript mirrors for definitions, bindings, execution results, and filter expressions.
- `src/services/tableTransformService.ts`: typed Tauri IPC wrapper.
- `src/stores/useTableTransformStore.ts`: definitions/bindings state and create, import, bind, rerun, reset actions.
- `src/components/tableTransform/TableTransformView.tsx`: definition, bindings, schema status, output, and rerun/rebind UI.
- `tests/tableTransformContract.test.ts`: frontend DTO, service, registration, naming, and project-contract tests.
- `tests/tableTransformStore.test.ts`: Zustand behavior tests with a fake service.
- `tests/tableTransformWorkspace.test.ts`: Workspace creation/open/save/tree integration contracts.

### Existing Files To Modify

- `src-tauri/Cargo.toml`, `src-tauri/src/services/mod.rs`: expose `sqlparser 0.62.0` directly and register the two Rust modules.
- `src-tauri/src/engine/duckdb_engine.rs`: derived Update copy and atomic stable dataset replacement.
- `src-tauri/src/services/workflow_domain.rs`: add Table Transform document/operation kinds.
- `src-tauri/src/services/spprj_archive.rs`: manifest index, project-local bindings, validation, standalone `.sptbtf` IO, and archive round-trip.
- `src-tauri/src/models/save.rs`, `src-tauri/src/services/streaming_project_writer.rs`, `src-tauri/src/services/project_service.rs`: carry definitions and bindings through Save/Open.
- `src-tauri/src/commands/project_commands.rs`, `src-tauri/src/lib.rs`: thin standalone and execution IPC commands plus registration.
- `src/types/workflow.ts`, `src/types/project.ts`, `src/services/projectService.ts`: DTO parity and project payloads.
- `src/utils/projectFileNaming.ts`: `.sptbtf` extension and `tableTransform` kind.
- `src/stores/useFolderStore.ts`: transform folder assignments.
- `src/components/analysis/analysisWorkspaceLifecycle.ts`: `tableTransform` workspace selection.
- `src/components/TableOpsDialog.tsx`: emit typed transform drafts instead of directly invoking Table operation commands.
- `src/components/Workspace.tsx`: store hydration/save, transform creation, selection, tree row, view, and import/export actions.
- `src/i18n/locales/{en,zh-CN,zh-TW,vi}.json`: visible labels and structured errors.
- Existing Rust tests in the touched backend modules own backend regression coverage.

---

### Task 1: Strongly Typed Table Transform Domain

**Files:**
- Create: `src-tauri/src/services/table_transform_domain.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/services/workflow_domain.rs`
- Create: `src/types/tableTransform.ts`
- Modify: `src/types/workflow.ts`
- Test: inline Rust tests in `src-tauri/src/services/table_transform_domain.rs`
- Test: `tests/tableTransformContract.test.ts`

**Interfaces:**
- Produces: `TableTransformDefinition`, `TableTransformOperation`, `TableTransformInputSlot`, `TableTransformOutput`, `TableFilterExpression`, `validate_table_transform_definition()`, and `derive_input_contracts()`.
- Produces: `ProjectDocumentKind::TableTransform` and `OperationKind::TableTransform` in Rust plus `"tableTransform"` mirrors in TypeScript.
- Consumes: existing `workflow_domain::{SchemaContract, SchemaColumnRequirement, canonical_duckdb_type, schema_fingerprint}`.

- [x] **Step 1: Write failing Rust domain tests**

Add tests that construct every operation variant and assert exact roles, reject duplicate/missing roles, reject unsupported format versions, reject blank IDs/names, and derive only operation-referenced columns. Add a Subset test that parses `age >= 18 AND status = 'active'` into a serializable AST and rejects statements, subqueries, functions, comments, and unknown columns.

```rust
#[test]
fn all_v1_operations_have_canonical_input_roles() {
    assert_eq!(required_input_roles(&sort_operation()), vec!["source"]);
    assert_eq!(required_input_roles(&join_operation()), vec!["left", "right"]);
    assert_eq!(required_input_roles(&update_operation()), vec!["left", "right"]);
    assert_eq!(required_input_roles(&concatenate_operation(3)), vec!["source-1", "source-2", "source-3"]);
}

#[test]
fn subset_filter_rejects_executable_sql() {
    let error = parse_filter_expression("age > 18; DROP TABLE x", &source_columns())
        .expect_err("multiple statements must be rejected");
    assert!(matches!(error, AppError::InvalidParam(_)));
}
```

- [x] **Step 2: Run the Rust tests and verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_transform_domain
```

Expected: compilation fails because `table_transform_domain` and its public types do not exist.

- [x] **Step 3: Implement the domain and safe filter AST**

Define the stable outer shape and a tagged operation enum. Add `sqlparser = "0.62.0"` as a direct dependency, parse exactly one expression, allow only boolean composition, comparison, `IS NULL`, `IS NOT NULL`, column identifiers, and scalar literals, then normalize it into `TableFilterExpression`. Do not persist `sqlparser` AST values.

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableTransformDefinition {
    pub id: String,
    pub name: String,
    pub format_version: String,
    pub revision: u64,
    pub operation: TableTransformOperation,
    pub input_slots: Vec<TableTransformInputSlot>,
    pub output: TableTransformOutput,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TableTransformOperation {
    Sort { sort_columns: Vec<SortColumn> },
    Subset { columns: Vec<String>, filter: Option<TableFilterExpression> },
    Transpose,
    Stack { stack_columns: Vec<String>, id_columns: Vec<String> },
    Split { split_column: String, value_column: String, id_columns: Vec<String> },
    Summary { statistic_columns: Vec<String>, group_columns: Vec<String>, statistics: Vec<SummaryStatistic> },
    Join { join_type: JoinType, left_key: String, right_key: String },
    Update { match_column: String, update_columns: Vec<String> },
    Concatenate { source_count: usize },
}
```

Mirror the exact discriminated union in `src/types/tableTransform.ts` and extend Workflow kinds.

- [x] **Step 4: Run Rust and TypeScript contract tests and verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_transform_domain
npx tsx --tsconfig tsconfig.app.json tests/tableTransformContract.test.ts
```

Expected: all new domain and serialization tests pass.

- [x] **Step 5: Commit the domain slice after review approval**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/services/mod.rs src-tauri/src/services/table_transform_domain.rs src-tauri/src/services/workflow_domain.rs src/types/tableTransform.ts src/types/workflow.ts tests/tableTransformContract.test.ts
git commit -m "feat(table): define reusable transform documents"
```

---

### Task 2: Atomic Stable Output Database Primitives

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Test: inline Rust tests in `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Produces: `copy_and_update_table(temp_id, temp_name, left_id, right_id, match_column, update_columns) -> Result<DatasetMeta, AppError>`.
- Produces: `replace_dataset_atomically(stable_id, temporary_id, stable_name, expected_generation) -> Result<DatasetMeta, AppError>`.
- Consumes: existing explicit-`new_id` Sort, Subset, Transpose, Stack, Split, Summary, Join, and Concatenate methods.

- [x] **Step 1: Write failing atomicity and identity tests**

Test initial promotion, replacement under an existing stable ID, generation increment, metadata/column replacement, temporary metadata removal, and rollback when expected generation is stale. Add a derived Update test proving both inputs remain byte-equivalent while the temporary output contains updates.

```rust
#[test]
fn replace_dataset_atomically_preserves_stable_identity() {
    let engine = fixture_engine();
    seed_table(&engine, "stable", "Output", &[1]);
    seed_table(&engine, "temporary", "Temporary", &[2, 3]);
    let generation = engine.get_dataset_generation("stable").unwrap();
    let result = engine
        .replace_dataset_atomically("stable", "temporary", "Output", generation)
        .unwrap();
    assert_eq!(result.id, "stable");
    assert_eq!(read_values(&engine, "stable"), vec![2, 3]);
    assert!(engine.get_dataset_meta("temporary").is_err());
}
```

- [x] **Step 2: Run focused engine tests and verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml replace_dataset_atomically
cargo test --manifest-path src-tauri/Cargo.toml copy_and_update_table
```

Expected: compilation fails because both methods are missing.

- [x] **Step 3: Implement transactional replacement and derived Update**

Follow the existing replacement-table transaction pattern in `duckdb_engine.rs`: begin a transaction, verify the stable generation, drop old stable physical/column metadata only inside the transaction, rename the temporary physical table to the stable internal name, retarget temporary column metadata, update or insert stable dataset metadata, remove temporary metadata, increment generation, and commit. Roll back every statement on error.

Implement Update by creating a copy with an executor-supplied ID, applying updates to that copy, and returning its metadata. Quote only identifiers resolved against input schemas.

- [x] **Step 4: Run focused engine tests and verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml replace_dataset_atomically
cargo test --manifest-path src-tauri/Cargo.toml copy_and_update_table
```

Expected: identity, rollback, generation, metadata, and immutable-input tests pass.

- [x] **Step 5: Commit the database slice after review approval**

```bash
git add src-tauri/src/engine/duckdb_engine.rs
git commit -m "feat(table): atomically refresh transform outputs"
```

---

### Task 3: Table Transform Execution And Lineage

**Files:**
- Create: `src-tauri/src/services/table_transform_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/workflow_domain.rs`
- Test: inline Rust tests in `src-tauri/src/services/table_transform_service.rs`

**Interfaces:**
- Produces: `TableTransformProjectBinding`, `TableTransformInputBinding`, `TableTransformRunStatus`, `TableTransformRunState`, `TableTransformExecutionResult`.
- Produces: `TableTransformService::create_and_run()`, `rebind_and_run()`, and `run()`.
- Consumes: Task 1 definition validation/contracts and Task 2 database primitives.

- [x] **Step 1: Write failing service tests for all nine operations**

Use real in-memory DuckDB tables. Assert first execution creates the configured output ID, rerun after source replacement preserves that ID, blocked schema validation creates no output, failed rerun preserves old rows, stale revision cannot commit, and Update leaves both inputs unchanged. Assert lineage has one transform operation reference, expected `consumes` edges, and one `produces` edge.

```rust
#[test]
fn rebind_refreshes_output_without_rewiring_downstream() {
    let fixture = transform_fixture();
    let first = fixture.run_with_source("source-a").unwrap();
    fixture.attach_downstream("analysis-1", &first.output.id).unwrap();
    let second = fixture.rebind_with_source("source-b").unwrap();
    assert_eq!(second.output.id, first.output.id);
    assert!(fixture.downstream_consumes("analysis-1", &first.output.id));
}
```

- [x] **Step 2: Run service tests and verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_transform_service
```

Expected: compilation fails because the service and project-binding DTOs are missing.

- [x] **Step 3: Implement preflight, dispatch, revision fence, and lineage mutation**

Dispatch each typed operation to the existing engine method with a UUID temporary ID. Render the structured Subset filter into controlled SQL fragments and bound scalar values inside the engine boundary. Validate every role before dispatch. Replace the output only after successful temporary execution and a matching definition revision.

```rust
pub fn run(
    &self,
    definition: &TableTransformDefinition,
    binding: &TableTransformProjectBinding,
    lineage: &mut ProjectLineageGraph,
) -> Result<TableTransformExecutionResult, AppError>;
```

Return `Blocked` with role-scoped schema reports for compatibility failures. Return `Failed` for operation failures while preserving prior output. Use `Err(AppError)` for invalid references and infrastructure failures.

- [x] **Step 4: Run focused service and Workflow tests and verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_transform_service
cargo test --manifest-path src-tauri/Cargo.toml workflow_domain
```

Expected: all transform execution and existing Workflow domain tests pass.

- [x] **Step 5: Commit the service slice after review approval**

```bash
git add src-tauri/src/services/mod.rs src-tauri/src/services/table_transform_service.rs src-tauri/src/services/workflow_domain.rs
git commit -m "feat(table): execute transform documents"
```

---

### Task 4: Standalone And Project Archive Persistence

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/models/save.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Test: inline Rust tests in all four files

**Interfaces:**
- Produces: `TableTransformEntryRef { id, name, revision, file }` and default-empty manifest fields `table_transform_files` and `table_transform_bindings`.
- Produces: `write_table_transform_file()`, `read_table_transform_file()`, `ProjectService::export_table_transform()`, and `ProjectService::import_table_transform()`.
- Extends: `SaveProjectRequest` and `OpenProjectResult` with `table_transforms` and `table_transform_bindings`.

- [ ] **Step 1: Write failing standalone and archive tests**

Add tests for standalone round-trip, malformed/unsupported body rejection, import allocating fresh definition/output IDs and clearing bindings/run state, indexed project round-trip, body/index mismatch, duplicate IDs, unknown binding references, missing entries, and legacy archives defaulting both collections to empty.

```rust
#[test]
fn imported_transform_gets_fresh_project_identity() {
    let original = transform_definition("transform-a", "output-a");
    write_table_transform_file(&original, path()).unwrap();
    let imported = ProjectService::new(&state()).import_table_transform(path()).unwrap();
    assert_ne!(imported.definition.id, original.id);
    assert_ne!(imported.definition.output.table_document_id, original.output.table_document_id);
    assert!(imported.binding.input_bindings.is_empty());
}
```

- [ ] **Step 2: Run archive tests and verify RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_transform_file
cargo test --manifest-path src-tauri/Cargo.toml table_transform_round_trip
```

Expected: compilation fails because archive models and IO functions are absent.

- [ ] **Step 3: Implement indexed `.sptbtf` persistence**

Allocate collision-safe `.sptbtf` archive paths, stream definitions as metadata entries, and validate indexed identity/revision. Carry project-local bindings in manifest metadata. Include transform documents and stable output tables in referential validation. Keep new fields `#[serde(default)]` and do not bump `SPPRJ_VERSION` for the additive layout.

Standalone import returns a fresh definition and empty binding; it never guesses inputs by name.

- [ ] **Step 4: Run archive, project, and streaming tests and verify GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml table_transform
cargo test --manifest-path src-tauri/Cargo.toml streaming_project_writer
cargo test --manifest-path src-tauri/Cargo.toml project_service
```

Expected: new persistence tests and existing save/open tests pass.

- [ ] **Step 5: Commit the persistence slice after review approval**

```bash
git add src-tauri/src/services/spprj_archive.rs src-tauri/src/models/save.rs src-tauri/src/services/streaming_project_writer.rs src-tauri/src/services/project_service.rs
git commit -m "feat(project): persist table transform files"
```

---

### Task 5: Tauri IPC, TypeScript Service, And Zustand Store

**Files:**
- Modify: `src-tauri/src/commands/project_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/services/tableTransformService.ts`
- Create: `src/stores/useTableTransformStore.ts`
- Modify: `src/types/project.ts`
- Modify: `src/services/projectService.ts`
- Create: `tests/tableTransformStore.test.ts`
- Modify: `tests/tableTransformContract.test.ts`

**Interfaces:**
- Produces Tauri commands: `create_table_transform`, `run_table_transform`, `rebind_table_transform`, `export_table_transform`, `import_table_transform`.
- Produces store actions: `loadFromProject`, `createAndRun`, `rebindAndRun`, `rerun`, `importDefinition`, `remove`, and `reset`.

- [ ] **Step 1: Write failing IPC registration and store tests**

Assert commands delegate to `TableTransformService` and are registered. With a fake client, assert create success inserts definition/binding, blocked rerun retains previous output state, rebind sends a complete role map, stale async completion cannot overwrite a newer run, and reset clears state.

```ts
const store = createTableTransformStore({ service: fakeService });
await store.getState().createAndRun(draft, bindings);
assert.equal(store.getState().definitions[0]?.id, "transform-1");
assert.equal(store.getState().bindings[0]?.lastRun?.status, "succeeded");
```

- [ ] **Step 2: Run frontend tests and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableTransformContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformStore.test.ts
```

Expected: module resolution and registration assertions fail because the client/store/commands are absent.

- [ ] **Step 3: Implement thin commands, client, project DTOs, and store**

Commands acquire the mutation permit for create/run/rebind/import and delegate to the service. Export is read-only. Extend Save/Open request types with default-empty arrays.

```ts
export const tableTransformService = {
  createAndRun: (definition: TableTransformDefinition, inputBindings: TableTransformInputBinding[]) =>
    invoke<TableTransformExecutionResult>("create_table_transform", { definition, inputBindings }),
  run: (transformId: string) =>
    invoke<TableTransformExecutionResult>("run_table_transform", { transformId }),
  rebindAndRun: (transformId: string, inputBindings: TableTransformInputBinding[]) =>
    invoke<TableTransformExecutionResult>("rebind_table_transform", { transformId, inputBindings }),
  exportFile: (transformId: string, filePath: string) =>
    invoke<void>("export_table_transform", { transformId, filePath }),
  importFile: (filePath: string) =>
    invoke<ImportedTableTransform>("import_table_transform", { filePath }),
};
```

- [ ] **Step 4: Run store, contract, command, and mutation-guard tests and verify GREEN**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableTransformContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformStore.test.ts
cargo test --manifest-path src-tauri/Cargo.toml project_commands
cargo test --manifest-path src-tauri/Cargo.toml mutation_guard
```

Expected: new IPC/store tests and existing mutation-guard coverage pass.

- [ ] **Step 5: Commit the boundary slice after review approval**

```bash
git add src-tauri/src/commands/project_commands.rs src-tauri/src/lib.rs src/services/tableTransformService.ts src/stores/useTableTransformStore.ts src/types/project.ts src/services/projectService.ts tests/tableTransformContract.test.ts tests/tableTransformStore.test.ts
git commit -m "feat(table): expose transform execution state"
```

---

### Task 6: Transform Creation And Editing UI

**Files:**
- Modify: `src/components/TableOpsDialog.tsx`
- Create: `src/components/tableTransform/TableTransformView.tsx`
- Create: `tests/tableTransformWorkspace.test.ts`
- Create: `tests/TableTransformHarness.tsx`
- Create: `tests/tableTransformView.spec.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`

**Interfaces:**
- `TableOpsDialog` produces `TableTransformDraft` through `onSubmit(draft)` and performs no Tauri calls.
- `TableTransformView` consumes one definition, its binding, available tables, `onRebind`, `onRerun`, and `readOnly`.

- [ ] **Step 1: Write failing creation and view tests**

Add tests proving all nine forms produce typed drafts with canonical roles and no concrete source IDs inside definitions. Mount the production view and verify parameters, bindings, blocked schema details, stable output link, rerun disabled/read-only states, and rebind submission.

```tsx
await mount(<TableTransformHarness status="blocked" />);
await expect(page.getByText("Missing column: batch")).toBeVisible();
await expect(page.getByRole("button", { name: "Rerun" })).toBeEnabled();
```

- [ ] **Step 2: Run creation and component tests and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableTransformWorkspace.test.ts
npx playwright test -c playwright-ct.config.ts tests/tableTransformView.spec.tsx
```

Expected: draft callbacks and `TableTransformView` are missing.

- [ ] **Step 3: Refactor the dialog and implement the view**

Keep current controls/defaults, but make each form register a draft-producing primary action. Convert Subset's predicate input into a structured condition builder that emits the Task 1 AST; do not serialize free SQL text. Add a required Transform name derived from the current result suffix.

Render a quiet work surface using existing field, toolbar, error, and table styles. Use icon buttons with tooltips for rerun/export and selects for role binding. Do not add nested cards or instructional feature copy.

- [ ] **Step 4: Run UI tests, locale parity, and typecheck and verify GREEN**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableTransformWorkspace.test.ts
npx playwright test -c playwright-ct.config.ts tests/tableTransformView.spec.tsx
npx tsc -p tsconfig.app.json --noEmit
```

Expected: creation and view behavior pass in all supported locales with no type errors.

- [ ] **Step 5: Commit the UI slice after review approval**

```bash
git add src/components/TableOpsDialog.tsx src/components/tableTransform/TableTransformView.tsx tests/TableTransformHarness.tsx tests/tableTransformView.spec.tsx tests/tableTransformWorkspace.test.ts src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json
git commit -m "feat(table): create and edit transform nodes"
```

---

### Task 7: Workspace, Folder Tree, And Standalone Import/Export

**Files:**
- Modify: `src/utils/projectFileNaming.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/components/analysis/analysisWorkspaceLifecycle.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `tests/projectFileNaming.test.ts`
- Modify: `tests/folderStore.test.ts`
- Modify: `tests/tableTransformWorkspace.test.ts`
- Modify: `tests/workflowDomainContract.test.ts`
- Modify: `tests/workflowUiContract.test.ts`

**Interfaces:**
- Adds `ProjectDocumentKind = "tableTransform"` and extension `.sptbtf`.
- Adds `tableTransformFolders: Record<string, string>` to folder/project payloads.
- Adds `activeTableTransformId` to `WorkspaceDocumentSelection`.
- Workspace creates/opens/selects/moves/renames/saves/loads/imports/exports Transform documents and activates the stable output after first success.

- [ ] **Step 1: Write failing Workspace and folder lifecycle tests**

Assert case-insensitive `.sptbtf` naming, folder normalization/move/rename/delete/prune, selection exclusivity, save/open/reset hydration, one tree row per definition separate from output `.sptb`, creation calling the store once, import leaving the definition unbound, export using the `.sptbtf` filter, and transform removal preserving its output table unless separately deleted.

```ts
assert.equal(projectFileExtension("tableTransform"), ".sptbtf");
assert.equal(selectWorkspaceDocument("tableTransform", "tf-1").activeTableTransformId, "tf-1");
assert.equal(selectWorkspaceDocument("tableTransform", "tf-1").activeDatasetId, null);
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

```bash
npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformWorkspace.test.ts
```

Expected: unknown kind/field assertions fail.

- [ ] **Step 3: Wire Workspace and project persistence**

Hydrate/reset/save the Transform store alongside Workflow state. Include definitions and bindings in every Save request and Open result. Add transform folder maps to every folder operation and prune pass. Render `.sptbtf` rows with an icon, operation/source status, standard rename/context actions, and `TableTransformView` selection.

Use this standalone filter:

```ts
filters: [{ name: "StatsPlayground Table Transform", extensions: ["sptbtf"] }]
```

On create success, refresh datasets, mark dirty, store the returned definition/binding, and activate its stable output. On import, activate the unbound Transform view. On rerun success, refresh datasets and invalidate table caches without changing IDs.

- [ ] **Step 4: Run Workspace, project, Workflow, and build tests and verify GREEN**

```bash
npx tsx --tsconfig tsconfig.app.json tests/projectFileNaming.test.ts
npx tsx --tsconfig tsconfig.app.json tests/folderStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformWorkspace.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workflowDomainContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/workflowUiContract.test.ts
npm run build
```

Expected: lifecycle contracts pass and the production build succeeds.

- [ ] **Step 5: Commit the integrated Workspace slice after review approval**

```bash
git add src/utils/projectFileNaming.ts src/stores/useFolderStore.ts src/components/analysis/analysisWorkspaceLifecycle.ts src/components/Workspace.tsx tests/projectFileNaming.test.ts tests/folderStore.test.ts tests/tableTransformWorkspace.test.ts tests/workflowDomainContract.test.ts tests/workflowUiContract.test.ts
git commit -m "feat(workspace): manage table transform files"
```

---

### Task 8: End-To-End Regression And Acceptance Gate

**Files:**
- Modify only files required by concrete failures found in this task.
- Test: all Issue 89 focused tests and repository-required checks.

**Interfaces:**
- Consumes the complete Issue 89 implementation.
- Produces fresh verification evidence and a running Tauri acceptance build; no new product behavior.

- [ ] **Step 1: Add one cross-layer stable-output regression**

Create a Rust integration-style test in `table_transform_service.rs` that executes Stack from source A, attaches a downstream document to the stable output, rebinds to source B, saves/reopens the project, reruns, and verifies the same output ID/content/downstream edge.

- [ ] **Step 2: Run the complete focused gate**

```bash
npx tsx --tsconfig tsconfig.app.json tests/tableTransformContract.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformStore.test.ts
npx tsx --tsconfig tsconfig.app.json tests/tableTransformWorkspace.test.ts
npx playwright test -c playwright-ct.config.ts tests/tableTransformView.spec.tsx
cargo test --manifest-path src-tauri/Cargo.toml table_transform
cargo test --manifest-path src-tauri/Cargo.toml workflow_domain
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 3: Run repository-required final verification**

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
git diff --check
```

Expected: build, all Rust tests, Clippy, and whitespace checks pass. If unchanged baseline warnings make `-D warnings` fail, record the exact baseline comparison and run focused Clippy on touched targets; do not claim full Clippy passed.

- [ ] **Step 4: Inspect bounded final status and diff**

```bash
git status --short --untracked-files=all
git diff --stat
```

Expected: only Issue 89 source, tests, locales, spec, and plan are present. Exclude the three Tauri generated schema files changed by baseline compilation unless a deliberate capability change requires them.

- [ ] **Step 5: Start Tauri for manual acceptance**

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground-issue-89 run tauri -- dev
```

Manual acceptance checklist:

1. Create representative one-input, two-input, and Concatenate transforms.
2. Confirm each `.sptbtf` appears separately from its output `.sptb`.
3. Rebind an upstream table and confirm output content changes while downstream documents remain connected.
4. Bind an incompatible table and confirm execution is blocked while the previous output remains usable.
5. Export a Transform, import it into another project, bind inputs, and run it.
6. Save/reopen the project and confirm definitions, bindings, output IDs, statuses, folders, and lineage persist.

- [ ] **Step 6: Stop at manual acceptance**

Do not commit, push, or open a pull request until Ashton explicitly confirms the acceptance checklist passes. After acceptance, rerun final verification, stage only intended files, create repository-conforming commits, push without force, and open a PR to `dev` with `Closes #89` and cleanup metadata.