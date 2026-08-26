# Tabulate Export-to-Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a ready Tabulate result into a normal StatsPlayground data table with one optional row dimension and flattened multidimensional statistic columns.

**Architecture:** A pure TypeScript helper converts `TabulateItem` plus `TabulateResult` into a typed `CreateTableFromRowsRequest`. A new typed Tauri command delegates to `DataService`, whose DuckDB engine method validates and atomically creates the physical table and metadata. `Workspace` owns post-export refresh and navigation while `TabulateView` owns button state and errors.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri v2, Rust, DuckDB, Node assert tests.

## Global Constraints

- Rows accepts at most one field through keyboard assignment, field drop, and cross-zone movement.
- Columns and Statistics remain ordered multi-entry roles.
- Exported data columns use `Column values - localized statistic label - source field` and stable ` (2)` duplicate suffixes.
- Null dimension labels use localized `Missing`; null aggregate values remain null.
- Totals and visible-depth presentation state are not exported.
- Export is disabled for read-only projects, missing results, and an in-progress export.
- IPC uses typed values and parameterized statements; user values are never concatenated into SQL.
- Rust production code returns `Result<T, AppError>` without `unwrap()` or `expect()`.
- Every completed task is committed with a Conventional Commit message; do not push.

## File Structure

- Modify `src/types/data.ts`: shared table-from-rows request type.
- Modify `src/components/tabulate/tabulateResult.ts`: pure export conversion and single-Row assignment helpers.
- Modify `tests/tabulateResult.test.ts`: frontend transformation and role constraint coverage.
- Modify `src-tauri/src/models/table.rs`: Rust request model mirroring TypeScript.
- Modify `src-tauri/src/engine/duckdb_engine.rs`: validated transactional table creation from typed rows.
- Modify `src-tauri/src/services/data_service.rs`: UUID allocation and engine delegation.
- Modify `src-tauri/src/commands/data_commands.rs`: thin mutation command.
- Modify `src-tauri/src/lib.rs`: command registration.
- Modify `src/services/dataService.ts`: typed IPC wrapper.
- Modify `src/components/tabulate/TabulateView.tsx`: role constraint, export state, and toolbar action.
- Modify `src/components/tabulate/TabulateResultTable.tsx`: expose export action in the result toolbar.
- Modify `src/components/tabulate/tabulate.css`: stable export button layout and busy state.
- Modify `src/components/Workspace.tsx`: refresh, dirty/history update, and navigation callback.
- Modify `src/i18n/locales/en.json` and `src/i18n/locales/zh-CN.json`: localized export copy.

---

### Task 1: Pure Export Payload

**Files:**
- Modify: `src/types/data.ts`
- Modify: `src/components/tabulate/tabulateResult.ts`
- Test: `tests/tabulateResult.test.ts`

**Interfaces:**
- Produces: `CreateTableFromRowsRequest { name: string; columnNames: string[]; columnTypes: string[]; rows: Array<Array<string | number | boolean | null>> }`
- Produces: `buildTabulateExportRequest(item, result, options): CreateTableFromRowsRequest`
- Produces: `canAssignTabulateField(role, currentFields, fieldName): boolean`

- [ ] **Step 1: Write failing helper tests**

Add cases that expect this exact shape:

```ts
assert.deepEqual(buildTabulateExportRequest(exportItem, exportResult, {
  tableName: "Sales Summary",
  missingLabel: "Missing",
  statisticLabel: (statistic) => statistic.kind === "mean" ? "Mean" : "Count",
}), {
  name: "Sales Summary",
  columnNames: [
    "Region",
    "East - Retail - Mean - Sales",
    "East - Retail - Count - Sales",
    "Missing - Retail - Mean - Sales",
    "Missing - Retail - Count - Sales",
  ],
  columnTypes: ["VARCHAR", "DOUBLE", "DOUBLE", "DOUBLE", "DOUBLE"],
  rows: [["North", 10, 2, null, 1], ["South", 20, 4, 30, 6]],
});
assert.equal(canAssignTabulateField("rows", ["Region"], "Store"), false);
assert.equal(canAssignTabulateField("columns", ["Region"], "Store"), true);
```

Also cover no Rows, no Columns, and duplicate generated names receiving ` (2)`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --experimental-strip-types tests/tabulateResult.test.ts`

Expected: FAIL because `buildTabulateExportRequest` and `canAssignTabulateField` are not exported.

- [ ] **Step 3: Implement the minimal pure helpers**

Use the existing `cellIndex` ordering. Validate exactly one-or-zero row fields, nonempty statistics, matching member depth, and expected cell count. Build the optional first `VARCHAR` column and all aggregate columns as `DOUBLE`. Deduplicate names with a `Map<string, number>` and stable suffixes.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --experimental-strip-types tests/tabulateResult.test.ts`

Expected: `tabulateResult helpers OK` and exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add src/types/data.ts src/components/tabulate/tabulateResult.ts tests/tabulateResult.test.ts
git commit -m "feat(tabulate): build export table payload"
```

---

### Task 2: Atomic Table-from-Rows IPC

**Files:**
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/dataService.ts`

**Interfaces:**
- Consumes: `CreateTableFromRowsRequest` from Task 1.
- Produces: Rust `CreateTableFromRowsRequest` with camelCase serde fields.
- Produces: `DuckDbEngine::create_table_from_rows(id, request) -> Result<DatasetMeta, AppError>`.
- Produces: Tauri command `create_table_from_rows(request) -> Result<DatasetMeta, AppError>`.
- Produces: `dataService.createTableFromRows(request): Promise<DatasetMeta>`.

- [ ] **Step 1: Write failing Rust engine tests**

Add tests that create a two-column table from rows, query it back, and assert exact strings, doubles, nulls, row count, and source type `manual`. Add rejection tests for mismatched row widths and nested JSON values, asserting no dataset metadata remains after each error.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run from `src-tauri`: `cargo test create_table_from_rows -- --nocapture`

Expected: compile failure because the request model and engine method do not exist.

- [ ] **Step 3: Implement request validation and one transaction**

Add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableFromRowsRequest {
    pub name: String,
    pub column_names: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}
```

Validate lengths and scalar JSON (`Null`, `Bool`, `Number`, `String`) before `BEGIN TRANSACTION`. Reuse dataset-name, result-column-name, and canonical-type validation. Create the table and metadata inside the same transaction, prepare one parameterized insert statement containing `_row_id` plus one placeholder per column, convert JSON scalars to DuckDB values, update row count, and use `finalize_transaction` for commit/rollback.

- [ ] **Step 4: Add service, command, registration, and TS wrapper**

The service generates the UUID and delegates. The command acquires the mutation permit and delegates. Register it next to `create_table`. Add:

```ts
createTableFromRows: (request: CreateTableFromRowsRequest) =>
  invoke<DatasetMeta>("create_table_from_rows", { request }),
```

- [ ] **Step 5: Run focused backend tests and builds**

Run from `src-tauri`: `cargo test create_table_from_rows -- --nocapture`

Run from repository root: `npx vite build`

Expected: focused tests pass and Vite exits 0.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/models/table.rs src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/data_service.rs src-tauri/src/commands/data_commands.rs src-tauri/src/lib.rs src/services/dataService.ts
git commit -m "feat(data): create tables from typed rows"
```

---

### Task 3: Enforce One Rows Field

**Files:**
- Modify: `src/components/tabulate/TabulateView.tsx`
- Test: `tests/tabulateResult.test.ts`

**Interfaces:**
- Consumes: `canAssignTabulateField` from Task 1.
- Preserves: reorder of the existing Rows field and movement from Rows to Columns.
- Rejects: adding or moving a second distinct field into Rows.

- [ ] **Step 1: Add failing source and behavior assertions**

Assert that keyboard assignment and both field-drop/cross-zone paths call `canAssignTabulateField` before mutation. Keep the pure truth-table assertions from Task 1 as behavioral coverage.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --experimental-strip-types tests/tabulateResult.test.ts`

Expected: FAIL because `TabulateView` does not use the helper.

- [ ] **Step 3: Route all role assignment paths through the helper**

In `assignField`, field-drop, and cross-zone movement, return before mutation when the helper rejects the target. Do not change statistics or columns behavior.

- [ ] **Step 4: Run focused test and verify GREEN**

Run: `node --experimental-strip-types tests/tabulateResult.test.ts`

Expected: exit code 0.

- [ ] **Step 5: Commit**

```powershell
git add src/components/tabulate/TabulateView.tsx tests/tabulateResult.test.ts
git commit -m "fix(tabulate): limit rows to one field"
```

---

### Task 4: Export UI and Workspace Navigation

**Files:**
- Modify: `src/components/tabulate/TabulateView.tsx`
- Modify: `src/components/tabulate/TabulateResultTable.tsx`
- Modify: `src/components/tabulate/tabulate.css`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Test: `tests/tabulateResult.test.ts`

**Interfaces:**
- Consumes: `buildTabulateExportRequest` and `dataService.createTableFromRows`.
- Produces: `TabulateViewProps.onTableCreated(dataset: DatasetMeta): Promise<void>`.
- Produces: `TabulateResultTableProps.onExport`, `exporting`, and `exportDisabled`.

- [ ] **Step 1: Write failing UI contract assertions**

Assert source contains `onTableCreated`, `buildTabulateExportRequest`, `createTableFromRows`, export busy state, read-only disablement, `fa-table-arrow-up`, and all new English locale keys. Assert the button is inside `.sp-tabulate-results-toolbar`.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --experimental-strip-types tests/tabulateResult.test.ts`

Expected: FAIL on missing export UI contract.

- [ ] **Step 3: Implement export state and button**

Add `exporting` and `exportError` state in `TabulateView`. Build from the full `item` and current full result, not visible depths. Call `dataService.createTableFromRows`; await `onTableCreated`; on failure keep the result mounted and render an error banner. Add an icon-and-text button with tooltip, accessible label, fixed minimum height, and disabled/busy states to the existing results toolbar.

- [ ] **Step 4: Wire Workspace ownership**

Pass an async callback that runs:

```ts
await refreshDatasets();
markDirty();
setActiveGraphBuilderId(null);
setActiveTabulateId(null);
setActiveDataset(dataset.id);
recordAction(t("history.tabulateTableCreated", { name: dataset.name }));
```

- [ ] **Step 5: Add localized copy**

Add English and Simplified Chinese keys for export button, exporting state, export failure, and history entry. Use the existing locale structure and terminology for Data Table and Tabulate.

- [ ] **Step 6: Run focused test and frontend build**

Run: `node --experimental-strip-types tests/tabulateResult.test.ts`

Run: `npx vite build`

Expected: test exits 0 and Vite build succeeds.

- [ ] **Step 7: Commit**

```powershell
git add src/components/tabulate/TabulateView.tsx src/components/tabulate/TabulateResultTable.tsx src/components/tabulate/tabulate.css src/components/Workspace.tsx src/i18n/locales/en.json src/i18n/locales/zh-CN.json tests/tabulateResult.test.ts
git commit -m "feat(tabulate): export results to data table"
```

---

### Task 5: Full Verification

**Files:**
- Verify only; modify implementation files only for failures directly caused by Tasks 1-4.

**Interfaces:**
- Verifies the complete frontend/backend contract and repository quality gates.

- [ ] **Step 1: Run all frontend tests**

Run: `node --experimental-strip-types --test tests/*.test.ts`

Expected: all tests pass.

- [ ] **Step 2: Build frontend**

Run: `npx vite build`

Expected: TypeScript and Vite build succeed.

- [ ] **Step 3: Run backend tests**

Run from `src-tauri`: `cargo test`

Expected: all tests pass.

- [ ] **Step 4: Run backend lint**

Run from `src-tauri`: `cargo clippy --all-targets --all-features -- -D warnings`

Expected: exit code 0 with no warnings.

- [ ] **Step 5: Inspect final diff and status**

Run: `git diff dev...HEAD --check` and `git status --short`

Expected: no whitespace errors and a clean working tree.