# Table Row and Column Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show exact table row/column totals below Columns and exact source-table row frequencies beside categorical Filter values in the Table workspace.

**Architecture:** Keep source-table shape in existing `DatasetMeta`, filtered displayed-row count in existing `TableWindowResult`, and compute categorical frequencies in DuckDB because the frontend holds only a bounded row window. Extend the existing generation-fenced filter-value IPC from strings to `{ value, rowCount }`, then render counts only when the Table workspace supplies that backend provider so Graph Builder does not gain new UI behavior.

**Tech Stack:** Tauri v2, Rust 2021, DuckDB, serde, React 19, TypeScript, Zustand, i18next, Playwright Component Testing.

**Spec:** [GitHub Issue 217 investigation comment](https://github.com/ashton2914/StatsPlayground/issues/217#issuecomment-5691468688) and [ADO Task 1120769](https://1es4devices.visualstudio.com/MechanicalEngineering/_workitems/edit/1120769)

## Global Constraints

- Execute on an isolated `feat/217-table-row-column-counts` worktree created from the user-confirmed latest remote base; never commit directly to `dev`.
- Confirm the base and pull-request target with Ashton before creating the worktree, as required by the repository Issue lifecycle.
- Preserve Issue 217's v1 count definition: a categorical value count is its frequency in the complete current source table; search and checkbox selection do not change that frequency.
- Preserve the current 500-value bound, alphabetical ordering, identifier validation, parameterized search, null/empty coalescing, and dataset-generation stale fence.
- Render per-value counts in the Table workspace only. The shared Graph Builder Filter UI must retain its current appearance and behavior.
- Show displayed rows only while one or more dataset filters are active, including pass-through filters where displayed rows equal total rows.
- Use only user-visible columns. `_row_id` must not contribute to the column count.
- Add no dependency and make no unrelated Data Table or Filter refactor.
- Follow strict TDD: each production behavior starts with a focused test that is run and observed failing for the expected reason.

---

## File Structure

### Create

- `src/components/TableShapeSummary.tsx` - presentational summary for total rows, total columns, and conditionally displayed rows.
- `tests/FilterValueCountsHarness.tsx` - isolated shared Filter harness with table-backed categorical options.
- `tests/filterValueCounts.spec.tsx` - component assertions for value frequencies and Graph Builder-compatible no-count rendering.
- `tests/DataTableCountsHarness.tsx` - Data Table harness with controlled dataset metadata, filters, and filtered window totals.
- `tests/dataTableCounts.spec.tsx` - component and Zustand status assertions for table shape counts.

### Modify

- `src-tauri/src/models/table.rs` - add the serialized filter-value/count IPC model.
- `src-tauri/src/engine/duckdb_engine.rs` - aggregate exact categorical frequencies and extend focused engine tests.
- `src-tauri/src/services/data_service.rs` - propagate the counted result type.
- `src-tauri/src/commands/data_commands.rs` - expose the counted result through the existing command.
- `src/types/data.ts` - mirror the Rust filter-value/count model.
- `src/services/dataService.ts` - type the existing invoke wrapper with the structured result.
- `src/components/filter/FilterPanel.tsx` - retain string selection identity while rendering optional backend counts.
- `src/components/filter/filter.css` - reserve a stable right-aligned count column.
- `src/components/DataTableView.tsx` - supply counted options, mount the summary, and correct filtered status totals.
- `src/App.css` - style the non-stretching lower summary section.
- `src/i18n/locales/en.json` - add English summary labels.
- `src/i18n/locales/zh-CN.json` - add Simplified Chinese summary labels.
- `src/i18n/locales/zh-TW.json` - add Traditional Chinese summary labels.
- `src/i18n/locales/vi.json` - add Vietnamese summary labels.

---

### Task 1: Exact Counted Filter-Value IPC

**Files:**
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`

**Interfaces:**
- Consumes: `query_table_filter_values(dataset_id, field, search, limit, generation)` and the existing dataset-generation/column validation helpers.
- Produces: Rust `TableFilterValue { value: String, row_count: i64 }`, serialized as `{ value, rowCount }`, and `Result<Vec<TableFilterValue>, AppError>` through engine, service, and command.

- [ ] **Step 1: Change the focused engine expectations first**

In the existing `query_table_filter_values_is_bounded_and_searchable` and `query_table_filter_values_handles_a_numeric_value_column` tests, assert structured values and exact frequencies. Add duplicate empty/null data so the blank bucket is proved:

```rust
assert_eq!(
    db.query_table_filter_values("benchmark-id", "category", "alpha", 10, 0)
        .unwrap(),
    vec![
        TableFilterValue { value: "Alpha".into(), row_count: 2 },
        TableFilterValue { value: "Alphabet".into(), row_count: 1 },
    ]
);

assert_eq!(
    db.query_table_filter_values("benchmark-id", "category", "", 10, 0)
        .unwrap()
        .into_iter()
        .find(|option| option.value.is_empty()),
    Some(TableFilterValue { value: "".into(), row_count: 2 })
);
```

Retain assertions for the limit, unknown column, numeric source values, and stale generation. Add `PartialEq, Eq` to the model derivation so behavior can be compared directly.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run from `src-tauri/`:

```bash
cargo test query_table_filter_values --lib
```

Expected: compilation/test failure because `TableFilterValue` does not exist and the method still returns `Vec<String>`.

- [ ] **Step 3: Add the minimal model and aggregation**

Add to `src-tauri/src/models/table.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TableFilterValue {
    pub value: String,
    pub row_count: i64,
}
```

Change the engine return type to `Result<Vec<TableFilterValue>, AppError>` and use a grouped, parameterized query:

```sql
SELECT
    COALESCE(CAST(<validated-column> AS VARCHAR), '') AS filter_value,
    COUNT(*) AS row_count
FROM <validated-table>
WHERE strpos(lower(COALESCE(CAST(<validated-column> AS VARCHAR), '')), lower(?)) > 0
GROUP BY filter_value
ORDER BY lower(filter_value), filter_value
LIMIT ?
```

Map each row explicitly:

```rust
TableFilterValue {
    value: row.get(0)?,
    row_count: row.get(1)?,
}
```

Update `DataService::query_table_filter_values` and the Tauri command to return `Result<Vec<TableFilterValue>, AppError>`. Do not add a new command or change registration in `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run focused Rust tests and verify GREEN**

```bash
cargo test query_table_filter_values --lib
```

Expected: all `query_table_filter_values` tests pass, including duplicate, blank/null, numeric, search, limit, invalid-column, and stale-generation cases.

- [ ] **Step 5: Run the containing engine test gate**

```bash
cargo test engine::duckdb_engine::tests --lib
```

Expected: exit code 0 with no failed tests.

- [ ] **Step 6: Format only the touched Rust files and re-run the focused test**

```bash
rustfmt --edition 2021 src/models/table.rs src/engine/duckdb_engine.rs src/services/data_service.rs src/commands/data_commands.rs
cargo test query_table_filter_values --lib
```

Expected: rustfmt exits 0 and the focused tests remain green.

- [ ] **Step 7: Record the uncommitted Task 1 checkpoint**

```bash
git --no-pager status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat -- src-tauri/src/models/table.rs src-tauri/src/engine/duckdb_engine.rs src-tauri/src/services/data_service.rs src-tauri/src/commands/data_commands.rs
```

Expected: only Task 1 files appear in this checkpoint. Do not stage or commit before manual acceptance.

---

### Task 2: Table Filter Value Count Rendering

**Files:**
- Create: `tests/FilterValueCountsHarness.tsx`
- Create: `tests/filterValueCounts.spec.tsx`
- Modify: `src/types/data.ts`
- Modify: `src/services/dataService.ts`
- Modify: `src/components/filter/FilterPanel.tsx`
- Modify: `src/components/filter/filter.css`

**Interfaces:**
- Consumes: backend `{ value, rowCount }[]` from Task 1 and the existing `FilterRuleItem.selected: string[]` identity contract.
- Produces: TypeScript `TableFilterValue`, typed `dataService.queryTableFilterValues`, and optional right-aligned counts when `getCategoricalValues` is supplied.

- [ ] **Step 1: Create the component harness and failing count-render tests**

Build `FilterValueCountsHarness.tsx` around the production `FilterPanel` with one categorical rule. The table-backed variant supplies:

```ts
async () => [
  { value: "", rowCount: 2 },
  { value: "DV", rowCount: 24 },
  { value: "EV", rowCount: 76 },
]
```

The local/Graph Builder-compatible variant omits `getCategoricalValues` and supplies local `GraphData` only. In `filterValueCounts.spec.tsx`, assert:

```tsx
await expect(component.getByText("DV")).toBeVisible();
await expect(component.getByText("24", { exact: true })).toBeVisible();
await expect(component.getByText("76", { exact: true })).toBeVisible();
await expect(component.getByText("(blank)")).toBeVisible();
```

Also type into Search and toggle `DV`, then assert `24` remains unchanged. Mount the local variant and assert `.gb-filter-cat-row-count` has count 0.

- [ ] **Step 2: Run the component test and verify RED**

```bash
npx playwright test -c playwright-ct.config.ts tests/filterValueCounts.spec.tsx
```

Expected: TypeScript/render failure because the provider still returns `string[]` and no row-count element exists.

- [ ] **Step 3: Add the TypeScript contract and service typing**

Add to `src/types/data.ts`:

```ts
export interface TableFilterValue {
  value: string;
  rowCount: number;
}
```

Import that type in `src/services/dataService.ts` and change the existing invoke to:

```ts
invoke<TableFilterValue[]>("query_table_filter_values", {
  datasetId,
  field,
  search,
  limit,
  generation,
})
```

- [ ] **Step 4: Preserve string selection identity and render optional counts**

In `CategoricalEditor`, store remote options as `TableFilterValue[]`, derive `all` as `options.map(({ value }) => value)`, and derive a `Map<string, number>` for rendering. Keep every existing selection, range selection, search, include/exclude, and persistence operation on strings.

Render the count after the label only when a backend option provides one:

```tsx
<span className="gb-filter-cat-label" title={v}>
  {v === "" ? <em>(blank)</em> : v}
</span>
{rowCounts.has(v) && (
  <span className="gb-filter-cat-row-count">
    {rowCounts.get(v)!.toLocaleString()}
  </span>
)}
```

Add stable layout CSS:

```css
.gb-filter-cat-label {
  flex: 1 1 auto;
  min-width: 0;
}

.gb-filter-cat-row-count {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Run the component test and verify GREEN**

```bash
npx playwright test -c playwright-ct.config.ts tests/filterValueCounts.spec.tsx
```

Expected: table-backed value counts render and stay stable through search/selection; the local variant renders no count elements.

- [ ] **Step 6: Run existing filter contract regressions**

```bash
npx tsx --tsconfig tsconfig.app.json tests/filterExclusion.test.ts
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterViews.test.ts
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterStore.test.ts
```

Expected: all three commands exit 0.

- [ ] **Step 7: Record the uncommitted Task 2 checkpoint**

```bash
git --no-pager status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat -- src/types/data.ts src/services/dataService.ts src/components/filter/FilterPanel.tsx src/components/filter/filter.css tests/FilterValueCountsHarness.tsx tests/filterValueCounts.spec.tsx
```

Expected: Task 1 remains intact and only the listed Task 2 files are added to the working-tree scope. Do not stage or commit before manual acceptance.

---

### Task 3: Columns Summary and Correct Filtered Status

**Files:**
- Create: `src/components/TableShapeSummary.tsx`
- Create: `tests/DataTableCountsHarness.tsx`
- Create: `tests/dataTableCounts.spec.tsx`
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/App.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`

**Interfaces:**
- Consumes: `DatasetMeta.rowCount`, `DatasetMeta.colCount`, filtered `TableQueryResult.totalRows`, and `tableFilters.length`.
- Produces: `TableShapeSummary({ totalRows, totalColumns, displayedRows, filtered })` and a corrected global status string using filtered shown rows over source total rows.

- [ ] **Step 1: Create the Data Table harness and failing summary tests**

The harness must seed one dataset with `rowCount: 100`, `colCount: 2`, and two user columns. It accepts `filtered: boolean`; when true, seed one pass-through categorical rule in `useDatasetFilterStore` and return a table window with `totalRows: 24`, otherwise return `totalRows: 100`.

Mock and restore these service methods in the harness lifecycle:

```ts
dataService.getDatasetGeneration
dataService.queryTableWindow
dataService.getColumnDisplayProps
dataService.queryTableFilterValues
```

In `dataTableCounts.spec.tsx`, first assert the unfiltered summary:

```tsx
await expect(component.getByText("Total rows").locator("..")).toContainText("100");
await expect(component.getByText("Total columns").locator("..")).toContainText("2");
await expect(component.getByText("Displayed rows")).toHaveCount(0);
```

Then mount the filtered variant and assert:

```tsx
await expect(component.getByText("Displayed rows").locator("..")).toContainText("24");
await expect.poll(() => useDataStore.getState().statusInfo?.dimensions)
  .toBe("24 / 100 rows × 2 cols");
```

Add a zero-match variant returning `totalRows: 0` and assert `Displayed rows 0`.

- [ ] **Step 2: Run the Data Table component test and verify RED**

```bash
npx playwright test -c playwright-ct.config.ts tests/dataTableCounts.spec.tsx
```

Expected: the summary labels are absent and the filtered status reports `24 / 24 rows × 2 cols`.

- [ ] **Step 3: Add localized summary labels**

Under each locale's `dataTable` section add equivalent keys:

```json
"tableSummary": "Table summary",
"totalRows": "Total rows",
"totalColumns": "Total columns",
"displayedRows": "Displayed rows"
```

Use native translations in `zh-CN`, `zh-TW`, and `vi`; keep identical key sets across all four locale files.

- [ ] **Step 4: Add the presentational summary component**

Create `TableShapeSummary.tsx` with numeric props and `useTranslation`. Render a section header plus compact label/value rows. Format all numbers with `toLocaleString()` and omit the displayed-row row when `filtered` is false:

```tsx
interface TableShapeSummaryProps {
  totalRows: number;
  totalColumns: number;
  displayedRows: number;
  filtered: boolean;
}
```

- [ ] **Step 5: Mount the summary below the scrollable Columns list**

In `DataTableView`, select `datasetColCount` from the same dataset metadata record used for `datasetRowCount`. Place `TableShapeSummary` immediately after `ColsPanelList` so `.sp-cols-panel-list` retains `flex: 1` and the summary stays pinned at the bottom:

```tsx
<TableShapeSummary
  totalRows={datasetRowCount}
  totalColumns={datasetColCount}
  displayedRows={data.totalRows}
  filtered={tableFilters.length > 0}
/>
```

Correct the status payload from:

```ts
t("dataTable.dimensionsFiltered", {
  shown: data.totalRows,
  total: data.totalRows,
  cols: visibleColCount,
})
```

to:

```ts
t("dataTable.dimensionsFiltered", {
  shown: data.totalRows,
  total: datasetRowCount,
  cols: datasetColCount,
})
```

Use `datasetColCount` for the unfiltered dimensions label as well, and add both metadata counts to the effect dependency list.

- [ ] **Step 6: Add bounded summary styling**

In `src/App.css`, give the summary a top border, fixed flex basis, compact rows, muted labels, tabular numeric values, and no nested card treatment:

```css
.sp-table-shape-summary {
  flex: 0 0 auto;
  border-top: 1px solid var(--border-main);
  background: var(--bg-panel);
}

.sp-table-shape-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 8px;
  font-size: 11px;
}

.sp-table-shape-value {
  color: var(--fg-primary);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 7: Run the Data Table component test and verify GREEN**

```bash
npx playwright test -c playwright-ct.config.ts tests/dataTableCounts.spec.tsx
```

Expected: unfiltered, filtered, and zero-match summary assertions pass; filtered status is `24 / 100 rows × 2 cols`.

- [ ] **Step 8: Run adjacent Data Table UI regressions**

```bash
npx playwright test -c playwright-ct.config.ts tests/dataTableScroll.spec.tsx tests/dataTableSplitters.spec.tsx tests/dataTableCounts.spec.tsx
```

Expected: all component tests pass and the lower summary does not disturb scrolling or splitter sizing.

- [ ] **Step 9: Record the uncommitted Task 3 checkpoint**

```bash
git --no-pager status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat -- src/components/TableShapeSummary.tsx src/components/DataTableView.tsx src/App.css src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/DataTableCountsHarness.tsx tests/dataTableCounts.spec.tsx
```

Expected: the working tree contains only Task 1-3 implementation/test files plus this plan. Do not stage or commit before manual acceptance.

---

### Task 4: Cross-Layer Verification and Manual Acceptance

**Files:**
- Verify only. If a check exposes a defect, return to the owning task, add or strengthen its failing test, repair that slice, and repeat the affected gates before resuming this task.

**Interfaces:**
- Consumes: all Task 1-3 deliverables.
- Produces: fresh verification evidence and a runtime ready for Issue 217 manual acceptance.

- [ ] **Step 1: Run the complete focused feature suite**

```bash
cd src-tauri && cargo test query_table_filter_values --lib
cd .. && npx tsx --tsconfig tsconfig.app.json tests/filterExclusion.test.ts
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterViews.test.ts
npx tsx --tsconfig tsconfig.app.json tests/datasetFilterStore.test.ts
npx playwright test -c playwright-ct.config.ts tests/filterValueCounts.spec.tsx tests/dataTableCounts.spec.tsx tests/dataTableScroll.spec.tsx tests/dataTableSplitters.spec.tsx
```

Expected: every command exits 0 with zero failed tests.

- [ ] **Step 2: Run repository-required compile and static gates**

```bash
npm run build
cd src-tauri && cargo build
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Expected: every command exits 0. If an unrelated pre-existing failure appears, record its exact command/output and stop for disposition rather than changing unrelated code.

- [ ] **Step 3: Inspect the bounded final change**

```bash
git --no-pager status --short --untracked-files=all
git --no-pager diff --no-ext-diff --stat origin/dev...HEAD
git --no-pager diff --no-ext-diff --check origin/dev...HEAD
```

Expected: only the files listed by this plan are changed, diff check emits no output, and no generated/cache files are present.

- [ ] **Step 4: Start the feature worktree for manual acceptance**

```bash
npm --prefix /Users/ashton/git/ashton2914/StatsPlayground.worktrees/217-table-row-column-counts run tauri -- dev
```

Verify the launched Vite/Tauri processes resolve to the Issue 217 worktree before reporting the runtime as ready.

- [ ] **Step 5: Ask Ashton to verify the Issue acceptance scenarios**

Manual checklist:

1. Open a table with repeated categorical values and confirm each visible Filter value shows its exact source-row frequency.
2. Search the Filter values and toggle checkboxes; frequencies remain stable while the table's displayed-row total changes.
3. Confirm the Columns lower section shows total rows and total columns with no active filter.
4. Activate a filter and confirm displayed rows appears and matches the grid/status bar, including a zero-match filter.
5. Add/delete rows or columns and confirm totals refresh after the dataset mutation.
6. Open Graph Builder and confirm its shared Filter panel has no newly added per-value count column.

Stop at the manual-acceptance gate. Do not stage or commit implementation changes, push, create a pull request, merge, or clean the worktree until Ashton explicitly confirms manual acceptance.

---

### Task 5: Post-Acceptance Commit and Pull Request

**Files:**
- Stage only the Task 1-3 files listed in this plan and this plan document.

**Interfaces:**
- Consumes: Ashton's explicit manual-acceptance response and the exact verified Task 1-4 working tree.
- Produces: one conventional commit and a pull request targeting the user-confirmed branch, with Issue 217 cleanup metadata.

- [ ] **Step 1: Require explicit manual acceptance**

Do not begin this task unless Ashton explicitly confirms the Task 4 runtime scenarios pass. Acceptance authorizes pull-request preparation, not merge or cleanup.

- [ ] **Step 2: Re-run fresh verification on the exact tree to be committed**

```bash
cd src-tauri && cargo test query_table_filter_values --lib
cd .. && npx playwright test -c playwright-ct.config.ts tests/filterValueCounts.spec.tsx tests/dataTableCounts.spec.tsx tests/dataTableScroll.spec.tsx tests/dataTableSplitters.spec.tsx
npm run build
cd src-tauri && cargo build && cargo clippy --all-targets --all-features -- -D warnings && cargo test
cd .. && git --no-pager diff --no-ext-diff --check
```

Expected: every command exits 0 with zero failed tests, and diff check emits no output.

- [ ] **Step 3: Stage only the intended files and inspect the staged change**

```bash
git add docs/superpowers/plans/2026-09-16-table-row-column-counts.md \
  src-tauri/src/models/table.rs src-tauri/src/engine/duckdb_engine.rs \
  src-tauri/src/services/data_service.rs src-tauri/src/commands/data_commands.rs \
  src/types/data.ts src/services/dataService.ts \
  src/components/filter/FilterPanel.tsx src/components/filter/filter.css \
  src/components/TableShapeSummary.tsx src/components/DataTableView.tsx src/App.css \
  src/i18n/locales/en.json src/i18n/locales/zh-CN.json \
  src/i18n/locales/zh-TW.json src/i18n/locales/vi.json \
  tests/FilterValueCountsHarness.tsx tests/filterValueCounts.spec.tsx \
  tests/DataTableCountsHarness.tsx tests/dataTableCounts.spec.tsx
git --no-pager diff --cached --no-ext-diff --stat
git --no-pager diff --cached --no-ext-diff --check
```

Expected: the staged stat contains exactly the listed files and staged diff check emits no output.

- [ ] **Step 4: Create one conventional commit**

```bash
git commit -m "feat(table): show table and filter row counts"
git --no-pager log -1 --format='%H %s'
```

Record the full 40-character commit SHA from Git; never infer it from a short prefix.

- [ ] **Step 5: Push without force and create the pull request**

Push `feat/217-table-row-column-counts` and create a pull request to the user-confirmed target. The pull-request body must include:

- `Closes #217`
- objective summary of table shape and categorical frequency behavior
- exact verification commands and outcomes
- Ashton's manual-acceptance statement
- feature branch, full head SHA, and target branch
- cleanup metadata with the exact disposable ignored-path allowlist recorded at worktree creation

Read the pull request back and verify its head SHA equals the recorded local commit SHA. Stop after reporting the pull-request URL; merge and cleanup require later, separate authorization and verification.

---

## Plan Self-Review

- **Spec coverage:** Columns totals, conditional displayed rows, per-value categorical frequencies, data/filter refresh behavior, exact large-table counting, localization, shared-Filter regression, and zero matches each have an implementation and verification step.
- **Type consistency:** Rust `TableFilterValue.row_count` serializes to TypeScript `TableFilterValue.rowCount`; every engine/service/command/service-wrapper layer uses the same structured array.
- **Scope boundary:** Counts are enabled by the Table-only backend provider; Graph Builder's local Filter path is explicitly tested to remain unchanged.
- **Lifecycle consistency:** Tasks 1-4 remain uncommitted through manual acceptance; Task 5 alone stages, commits, pushes, and creates the pull request after explicit acceptance.
- **No placeholders:** Every task names files, interfaces, failing checks, implementation shape, passing checks, and lifecycle boundaries.