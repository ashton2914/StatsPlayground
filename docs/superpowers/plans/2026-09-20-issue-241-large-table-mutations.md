# Issue 241 Large-Table Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make row/column insertion and deletion scale with the changed data, add stable positional row insertion, and meet the approved 2,000,000-row latency targets without weakening Undo/Redo or stale-generation fencing.

**Architecture:** Add a nullable `HUGEINT` row-order override and seek natural windows by `(effective_order, row_id)`. Route row/column add/delete through a compact delta coordinator that copies only changed rows or columns, updates sparse anchors incrementally, and returns exact generation/count metadata so the React table can refresh only its active window.

**Tech Stack:** Tauri v2, Rust 2021, DuckDB, React 19, TypeScript, Zustand, Playwright Component Testing.

**Spec:** `docs/superpowers/specs/2026-09-20-issue-241-large-table-mutations-design.md`

## Global Constraints

- Base and PR target are `origin/dev`; implementation branch is `issue/241-large-table-mutations`.
- Natural dataset order is the only persisted row order; filters and sorts never rewrite it.
- Table-end `+` appends; row-menu insertion inserts above the stable target row ID.
- Scoped add/delete operations must not create `_history_full_before_*`.
- Scoped row operations must not call `rebuild_natural_anchors`.
- Existing rows remain `NULL` in `_row_order`; migration must not update 2,000,000 rows.
- Stale generation, missing target, dependency violations, and incomplete history must return explicit errors and roll back.
- Do not expose `_row_order` to the frontend as a user column.
- Keep legacy full change sets readable until all callers migrate.
- Use parameterized values for SQL inputs and quote only validated internal identifiers.
- Every behavior change follows RED/GREEN TDD and ends in an independently buildable Conventional Commit with the required Copilot co-author trailer.
- Do not edit the read-only attached `file_LogicalTableNavigationHarness.tsx`; edit the repository test harness instead.

---

### Task 1: Add the Effective Natural-Order Schema and Query Contract

**Files:**
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/models/table.rs`
- Test: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Produces: `NATURAL_ORDER_SQL: &str`
- Produces: `ensure_internal_row_order_column(dataset_id: &str) -> Result<(), AppError>`
- Produces: anchor rows with `(ordinal: i64, order_key: i128, row_id: i64)`
- Consumes: existing dataset creation/import/restore paths and `query_natural_navigation_window_inner`

- [ ] **Step 1: Add failing migration and ordering tests**

Add focused engine tests with these assertions:

```rust
#[test]
fn row_order_legacy_rows_keep_row_id_order_without_materializing_override() {
    let db = DuckDbEngine::new_in_memory().expect("db");
    db.seed_benchmark_table("order-legacy", "Legacy", 5, 1).expect("seed");
    db.ensure_internal_row_order_column("order-legacy").expect("migration");

    let populated: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM dataset_order_legacy WHERE \"_row_order\" IS NOT NULL",
        [],
        |row| row.get(0),
    ).expect("count");
    assert_eq!(populated, 0);
    assert_eq!(db.natural_row_ids_for_test("order-legacy"), vec![1, 2, 3, 4, 5]);
}

#[test]
fn row_order_explicit_override_sorts_before_target_with_row_id_tiebreaker() {
    let db = DuckDbEngine::new_in_memory().expect("db");
    db.seed_benchmark_table("order-override", "Override", 5, 1).expect("seed");
    db.ensure_internal_row_order_column("order-override").expect("migration");
    let between_two_and_three = 2 * NATURAL_ORDER_STRIDE + NATURAL_ORDER_STRIDE / 2;
    db.conn().execute(
        "UPDATE dataset_order_override SET \"_row_order\" = ? WHERE \"_row_id\" = 5",
        params![between_two_and_three],
    ).expect("set override");

    assert_eq!(
        db.natural_row_ids_for_test("order-override"),
        vec![1, 2, 5, 3, 4],
    );
}
```

The second test must use the production effective-order expression rather than a test-only `ORDER BY`.

- [ ] **Step 2: Run RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  row_order_ \
  -- --test-threads=1
```

Expected: FAIL because `_row_order`, the migration helper, and effective-order query do not exist.

- [ ] **Step 3: Add the schema and shared SQL expression**

Add:

```rust
pub(crate) const NATURAL_ORDER_STRIDE: i128 = 1_i128 << 64;
pub(crate) const NATURAL_ORDER_SQL: &str =
    "COALESCE(\"_row_order\", CAST(\"_row_id\" AS HUGEINT) * 18446744073709551616::HUGEINT)";
```

Create new dataset tables with `"_row_order" HUGEINT`. For existing tables use:

```rust
self.conn.execute(
    &format!("ALTER TABLE {table} ADD COLUMN IF NOT EXISTS \"_row_order\" HUGEINT"),
    [],
)?;
```

Update user-column discovery, archive projection, and metadata enumeration to exclude both `_row_id` and `_row_order`.

- [ ] **Step 4: Upgrade anchors and natural window seeking**

Migrate `_table_navigation_anchors` with:

```sql
ALTER TABLE _table_navigation_anchors
ADD COLUMN IF NOT EXISTS order_key HUGEINT;
```

Build/rebuild anchors with:

```sql
SELECT "_row_id",
       effective_order AS order_key,
       row_number() OVER (ORDER BY effective_order, "_row_id") - 1 AS ordinal
```

Change natural window seeking to use:

```sql
WHERE effective_order > ?
   OR (effective_order = ? AND "_row_id" >= ?)
ORDER BY effective_order, "_row_id"
LIMIT ? OFFSET ?
```

Keep `OFFSET` bounded by `NATURAL_ANCHOR_STRIDE`.

- [ ] **Step 5: Audit every natural-order consumer**

Replace direct natural `ORDER BY "_row_id"` use in export, copy, archive, content hash, workflow, and table-window code with `NATURAL_ORDER_SQL, "_row_id"`. Add a source-contract test that rejects a new direct natural-order clause outside the migration/recovery allowlist.

- [ ] **Step 6: Run GREEN and existing navigation regression tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml natural_navigation -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml row_order -- --test-threads=1
```

Expected: all focused and existing natural-navigation tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/engine/duckdb_engine.rs src-tauri/src/models/table.rs
git commit -m "feat(table): add stable natural row order" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Implement Bounded Order-Key Allocation and Incremental Anchors

**Files:**
- Create: `src-tauri/src/services/natural_row_order.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Test: `src-tauri/src/services/natural_row_order.rs`
- Test: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: `NATURAL_ORDER_SQL`, `NATURAL_ORDER_STRIDE`
- Produces:

```rust
pub(crate) struct RowOrderAllocation {
    pub row_orders: Vec<i128>,
    pub insertion_ordinal: i64,
}

pub(crate) fn allocate_before(
    engine: &DuckDbEngine,
    dataset_id: &str,
    before_row_id: Option<i64>,
    count: usize,
) -> Result<RowOrderAllocation, AppError>;

pub(crate) fn publish_inserted_anchors(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: u64,
    target_generation: u64,
    insertion_ordinal: i64,
    inserted: &[(i64, i128)],
) -> Result<(), AppError>;

pub(crate) fn publish_deleted_anchors(
    engine: &DuckDbEngine,
    dataset_id: &str,
    source_generation: u64,
    target_generation: u64,
    deleted: &[(i64, i128, i64)],
) -> Result<(), AppError>;
```

- [ ] **Step 1: Write allocation RED tests**

Cover append, insert before row 3, a three-row batch, repeated midpoint insertion,
missing target, and bounded local rebalance. Assert that unaffected rows retain
their previous effective keys and that the rebalance touches no more than the
declared safety window.

- [ ] **Step 2: Write incremental-anchor RED tests**

Seed at least `2 * NATURAL_ANCHOR_STRIDE + 10` rows. Insert and delete on both
sides of an anchor boundary. Assert:

```rust
assert!(max_anchor_gap(&db, dataset_id, next_generation) <= NATURAL_ANCHOR_STRIDE);
assert_eq!(
    query_all_windows(&db, dataset_id, next_generation),
    expected_natural_row_ids,
);
assert_eq!(full_anchor_rebuild_counter(), 0);
```

- [ ] **Step 3: Run RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml natural_row_order -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml incremental_anchor -- --test-threads=1
```

Expected: FAIL because allocation and incremental publication are absent.

- [ ] **Step 4: Implement midpoint allocation and bounded rebalance**

Use one query to load predecessor/target effective keys. Divide the open interval
into `count + 1` equal parts. If spacing is insufficient, load and rebalance a
window starting at 256 rows and doubling up to 8,192 rows. Return
`AppError::InvalidParam` after the bound; never call a full-table `UPDATE`.

- [ ] **Step 5: Implement sparse-anchor generation publication**

Copy the prior generation's sparse anchors, shift downstream ordinals, remove
anchors for deleted IDs, and insert local repair anchors until every gap is at
most `NATURAL_ANCHOR_STRIDE`. Delete obsolete generations only after the new
generation is complete.

- [ ] **Step 6: Run GREEN**

Run the Step 3 commands plus:

```bash
cargo test --manifest-path src-tauri/Cargo.toml natural_navigation -- --test-threads=1
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/services/natural_row_order.rs \
  src-tauri/src/services/mod.rs \
  src-tauri/src/engine/duckdb_engine.rs
git commit -m "feat(table): update row anchors incrementally" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Add Compact Row Mutation History

**Files:**
- Create: `src-tauri/src/services/table_delta_mutation.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/models/table.rs`
- Test: `src-tauri/src/services/table_delta_mutation.rs`
- Test: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: Task 2 allocation and anchor publication functions
- Produces:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMutationResult {
    pub row_ids: Vec<i64>,
    pub generation: u64,
    pub row_count: usize,
    pub change_set_id: String,
}

pub(crate) fn add_rows_compact(
    engine: &DuckDbEngine,
    dataset_id: &str,
    count: usize,
    before_row_id: Option<i64>,
    expected_generation: u64,
) -> Result<RowMutationResult, AppError>;

pub(crate) fn delete_rows_compact(
    engine: &DuckDbEngine,
    dataset_id: &str,
    row_ids: &[i64],
    expected_generation: u64,
) -> Result<RowMutationResult, AppError>;
```

- [ ] **Step 1: Add compact-history schema RED**

Assert initialization creates:

```sql
_history_delta_change_sets(
  id, dataset_id, operation, before_generation, after_generation,
  snapshot_table, applied
)
_history_row_deltas(change_set_id, ordinal, row_id, row_order)
```

Add `storage_kind TEXT NOT NULL DEFAULT 'full'` to `_history_change_sets` so
`apply_change_set` can dispatch legacy and delta formats.

- [ ] **Step 2: Add row mutation RED tests**

Tests must prove:

- append and insert-before return exact IDs, generation, row count, and change set;
- stale generation and missing target leave all tables unchanged;
- delete snapshots only selected rows in a typed
  `_history_rows_{change_set_id_without_hyphens}` table;
- no `_history_full_before_*` table is created;
- no full anchor rebuild occurs;
- Undo/Redo restores identical IDs, values, order keys, and natural order.

- [ ] **Step 3: Run RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml compact_row_mutation -- --test-threads=1
```

- [ ] **Step 4: Implement the row delta transaction**

Within one transaction:

1. validate `expected_generation`;
2. allocate IDs and order keys or capture deleted rows;
3. write delta metadata/snapshot;
4. mutate only requested rows;
5. update `_meta_datasets.row_count`;
6. publish incremental anchors for `generation + 1`;
7. update dataset generation and timestamp;
8. commit and return `RowMutationResult`.

Use a typed snapshot:

```sql
CREATE TABLE "_history_rows_{change_set_id_without_hyphens}" AS
SELECT * FROM dataset_table WHERE "_row_id" IN (?, ...)
```

The `IN` values remain bound parameters.

- [ ] **Step 5: Dispatch compact Undo/Redo**

Extend `apply_change_set` to inspect `storage_kind`. For `row_delta`, restore or
delete exact IDs/order keys and publish the inverse incremental-anchor change.
Update the stored before/after generation after each successful replay so the
existing frontend change-set action remains usable.

- [ ] **Step 6: Run GREEN**

```bash
cargo test --manifest-path src-tauri/Cargo.toml compact_row_mutation -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml delete_rows_change_set -- --test-threads=1
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/services/table_delta_mutation.rs \
  src-tauri/src/services/mod.rs \
  src-tauri/src/engine/duckdb_engine.rs \
  src-tauri/src/models/table.rs
git commit -m "feat(history): store compact row deltas" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Add Compact Column Mutation History

**Files:**
- Modify: `src-tauri/src/services/table_delta_mutation.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/models/table.rs`
- Test: `src-tauri/src/services/table_delta_mutation.rs`
- Test: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMutationResult {
    pub column_ids: Vec<String>,
    pub generation: u64,
    pub column_count: usize,
    pub change_set_id: String,
}
```

- Produces compact add/delete functions accepting stable column descriptors,
  logical `at_index`, and expected generation.

- [ ] **Step 1: Add column delta RED tests**

Cover:

- add one and many empty columns at a logical position;
- delete one and many columns;
- restore exact column IDs, types, order, calculated definitions, and values;
- reject dependency removal before mutation;
- stale generation leaves schema/history unchanged;
- added columns create no value snapshot;
- deleted-column snapshot contains only `_row_id` and deleted columns;
- scoped operations create no `_history_full_before_*`;
- column-only changes copy anchors to the next generation without rebuilding them.

- [ ] **Step 2: Run RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml compact_column_mutation -- --test-threads=1
```

- [ ] **Step 3: Implement typed column snapshots**

Create:

```sql
CREATE TABLE "_history_columns_{change_set_id_without_hyphens}" AS
SELECT "_row_id", deleted_column_1, deleted_column_2
FROM dataset_table
ORDER BY "_row_id"
```

Store column ID, name, type, `col_index`, and archived calculated definition in
delta metadata. Use the existing dependency validator before opening the
transaction.

- [ ] **Step 4: Implement compact column replay**

Undo add drops the stable column IDs. Redo add restores the same IDs and logical
positions. Undo delete recreates schema and updates values by `_row_id`; redo
delete drops the same IDs. Copy unchanged natural anchors to the new generation
without calling `rebuild_natural_anchors`.

- [ ] **Step 5: Run GREEN and calculated-column regressions**

```bash
cargo test --manifest-path src-tauri/Cargo.toml compact_column_mutation -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml calculated_mutation_delete_columns -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml deleted_columns_change_set -- --test-threads=1
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/services/table_delta_mutation.rs \
  src-tauri/src/engine/duckdb_engine.rs \
  src-tauri/src/models/table.rs
git commit -m "feat(history): store compact column deltas" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Persist and Clean Up Delta History

**Files:**
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src/stores/useHistoryStore.ts`
- Test: `src-tauri/src/services/spprj_archive.rs`
- Test: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: compact change-set metadata and typed snapshot tables from Tasks 3–4
- Produces optional archive entries:

```text
history/change_sets.json
history/snapshots/{change_set_id}.parquet
```

- Produces: `drop_table_change_set` cleanup for metadata plus referenced snapshot

- [ ] **Step 1: Add archive round-trip RED**

Create a project with one row deletion and one column deletion, save it, reopen
it, load the frontend history entries, and assert both change sets can Undo and
Redo. Also assert an archive without `history/` still opens.

- [ ] **Step 2: Add cleanup RED**

Record more than `MAX_HISTORY`, truncate the timeline, call
`dropTableChangeSet`, and assert the compact metadata rows and typed snapshot
tables are gone. Assert unrelated change sets remain.

- [ ] **Step 3: Run RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml delta_history_archive -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml drop_compact_change_set -- --test-threads=1
```

- [ ] **Step 4: Serialize optional delta history**

Add optional history descriptors to the archive manifest. Export metadata as
JSON and typed snapshots as Parquet. Restore metadata first, validate snapshot
columns against the descriptor, then publish the history to the project load
result. Reject missing or mismatched snapshots with `AppError::FileIO`.

- [ ] **Step 5: Make frontend cleanup failures observable**

Replace the silent change-set drop in `dropDiscardedChangeSets` with the
repository-standard history error update. Do not block the already completed
mutation, but surface cleanup failure in `historyError`.

- [ ] **Step 6: Run GREEN**

Run the Step 3 commands plus existing `.spprj` compatibility tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/services/spprj_archive.rs \
  src-tauri/src/services/streaming_project_writer.rs \
  src-tauri/src/services/project_service.rs \
  src-tauri/src/engine/duckdb_engine.rs \
  src/stores/useHistoryStore.ts
git commit -m "feat(project): persist compact table history" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Wire Typed Mutation Results Through Tauri IPC

**Files:**
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/commands/mutation_guard_coverage.rs`
- Modify: `src-tauri/src/lib.rs` only if command names change
- Modify: `src/services/dataService.ts`
- Modify: `src/types/data.ts` or the existing table mutation type module
- Test: `src-tauri/src/commands/data_commands.rs`
- Test: `tests/dataService.test.ts`

**Interfaces:**
- Consumes: `RowMutationResult`, `ColumnMutationResult`
- Produces:

```ts
export interface RowMutationResult {
  rowIds: number[];
  generation: number;
  rowCount: number;
  changeSetId: string;
}

export interface ColumnMutationResult {
  columnIds: string[];
  generation: number;
  columnCount: number;
  changeSetId: string;
}
```

- [ ] **Step 1: Add IPC contract RED**

Assert camelCase arguments and result fields for:

```ts
dataService.addRows(datasetId, count, beforeRowId, expectedGeneration)
dataService.deleteRowsWithChangeSet(datasetId, rowIds, expectedGeneration)
dataService.addColumnsWithChangeSet(datasetId, columns, atIndex, expectedGeneration)
dataService.deleteColumnsWithChangeSet(datasetId, columnIds, expectedGeneration)
```

The row insertion test must assert `beforeRowId`, not a viewport index.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/dataService.test.ts
cargo test --manifest-path src-tauri/Cargo.toml data_commands -- --test-threads=1
```

- [ ] **Step 3: Update service and command signatures**

Delegate all four operations to the compact coordinator and return the typed
result. Keep command registration and mutation classification complete. Require
`expected_generation` for every scoped mutation.

- [ ] **Step 4: Run GREEN and type-check**

```bash
npx vitest run tests/dataService.test.ts
cargo test --manifest-path src-tauri/Cargo.toml data_commands -- --test-threads=1
npx tsc -b --pretty false
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/services/data_service.rs \
  src-tauri/src/commands/data_commands.rs \
  src-tauri/src/commands/mutation_guard_coverage.rs \
  src-tauri/src/lib.rs \
  src/services/dataService.ts \
  src/types \
  tests/dataService.test.ts
git commit -m "feat(data): expose positional table mutations" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Apply Positional Mutations in DataTableView

**Files:**
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/stores/useDataStore.ts`
- Modify: `tests/LogicalTableNavigationHarness.tsx`
- Modify: `tests/logicalTableNavigation.spec.tsx`
- Create or Modify: `tests/dataTableMutations.spec.tsx`

**Interfaces:**
- Consumes: typed mutation results from Task 6
- Produces: stable `beforeRowId` row-menu behavior and local dataset metadata patch
- Produces store action:

```ts
applyDatasetMutationMeta(
  datasetId: string,
  patch: { generation: number; rowCount?: number; colCount?: number },
): void;
```

- [ ] **Step 1: Add positional row insertion RED**

Mount 200 rows, navigate to a middle window, open row 100's menu, insert one
row, and assert the harness received:

```ts
expect(lastAddRowsRequest).toEqual({
  datasetId: "logical-scroll-dataset",
  count: 1,
  beforeRowId: 100,
  expectedGeneration: 1,
});
```

Reload natural order and assert the new stable row ID precedes row ID 100.

- [ ] **Step 2: Add filter/sort semantics RED**

Under a filter or descending sort, insert above a visible target and assert the
same target `_row_id` is sent. After query reload, allow the blank row to move or
disappear, but assert natural order places it before the target when the query is
cleared.

- [ ] **Step 3: Add delete and metadata-refresh RED**

Assert add/delete row/column:

- patches exact generation and row/column count;
- invalidates the active window/session;
- does not call global `refreshDatasets`;
- clamps logical start/selection after deleting the last visible row;
- reports stale generation and performs one refresh without automatic mutation retry.

- [ ] **Step 4: Run RED**

```bash
PLAYWRIGHT_CT_PORT=3130 npx playwright test -c playwright-ct.config.ts \
  tests/dataTableMutations.spec.tsx \
  tests/logicalTableNavigation.spec.tsx \
  --workers=1 \
  --output=.cache/issue241/table-mutations-red
```

- [ ] **Step 5: Implement stable-target handlers**

Capture the row menu's loaded row ID before closing it:

```ts
const beforeRowId = getRowId(targetRow);
const result = await dataService.addRows(
  datasetId,
  count,
  beforeRowId,
  generationRef.current,
);
```

The table-end add row passes `null`. Batch row insert reuses the row-menu target.
Record every scoped operation as `{ kind: "changeSet", datasetId, changeSetId }`.

- [ ] **Step 6: Patch metadata and reload only the active context**

Apply returned generation/counts to `useDataStore`, invalidate table cache/query
session, and call `load(tableFiltersRef.current, desiredStart, result.generation)`.
Remove `refreshAndMarkDirty()` from these scoped paths; call `markDirty()` after
the local patch. Preserve the Issue #228 logical `N+1` append behavior.

- [ ] **Step 7: Run GREEN and adjacent table suites**

```bash
PLAYWRIGHT_CT_PORT=3130 npx playwright test -c playwright-ct.config.ts \
  tests/dataTableMutations.spec.tsx \
  tests/logicalTableNavigation.spec.tsx \
  tests/dataTableScroll.spec.tsx \
  --workers=1 \
  --output=.cache/issue241/table-mutations-green
npx vite build
```

- [ ] **Step 8: Commit**

```bash
git add src/components/DataTableView.tsx \
  src/stores/useDataStore.ts \
  tests/LogicalTableNavigationHarness.tsx \
  tests/logicalTableNavigation.spec.tsx \
  tests/dataTableMutations.spec.tsx
git commit -m "feat(table): insert rows at natural position" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Add the 2,000,000-Row Mutation Qualification Harness

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `docs/performance.md`
- Create: `docs/performance/large-table-mutations.md`
- Test: `src-tauri/src/perf_harness.rs`

**Interfaces:**
- Adds operations:

```rust
AppendRow,
InsertMiddleRow,
AddColumn,
DeleteRows,
DeleteColumn,
```

- Adds report fields:

```rust
mutation_ms: u128,
history_ms: u128,
anchor_ms: u128,
metadata_ms: u128,
reload_ms: Option<u128>,
full_snapshot_tables: usize,
full_anchor_rebuilds: usize,
qualification_passed: bool,
qualification_failure: Option<String>,
```

- [ ] **Step 1: Add parser/report RED**

Assert each operation parses and serializes its stage timings and approved
threshold. Reject `rows < 2_000_000` in qualification mode so a small fixture
cannot produce a false pass.

- [ ] **Step 2: Add structural qualification RED**

For each scoped operation assert:

```rust
assert_eq!(report.full_snapshot_tables, 0);
assert_eq!(report.full_anchor_rebuilds, 0);
```

For middle insertion additionally assert the inserted row precedes its target in
natural order.

- [ ] **Step 3: Run RED**

```bash
cargo test --manifest-path src-tauri/Cargo.toml perf_harness::table_mutation -- --test-threads=1
```

- [ ] **Step 4: Instrument production phase boundaries**

Use a test/perf observer around compact mutation phases. Do not add timing-only
branches to production SQL. Capture process memory before/after and count tables
matching `_history_full_before_%`.

- [ ] **Step 5: Run qualification**

Run one operation at a time to avoid cross-benchmark memory interference:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --features perf-harness -- \
  --rows 2000000 --columns 8 --operation append-row
cargo run --manifest-path src-tauri/Cargo.toml --features perf-harness -- \
  --rows 2000000 --columns 8 --operation insert-middle-row
cargo run --manifest-path src-tauri/Cargo.toml --features perf-harness -- \
  --rows 2000000 --columns 8 --operation add-column
cargo run --manifest-path src-tauri/Cargo.toml --features perf-harness -- \
  --rows 2000000 --columns 8 --operation delete-rows
cargo run --manifest-path src-tauri/Cargo.toml --features perf-harness -- \
  --rows 2000000 --columns 8 --operation delete-column
```

Expected thresholds: 1,000 ms, 2,000 ms, 2,000 ms, 2,000 ms, and 5,000 ms
respectively.

- [ ] **Step 6: Document exact commands and metric meaning**

Document fixture shape, cold/warm status, machine metadata, every timing field,
memory interpretation, and the rule that threshold failure blocks completion.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/perf_harness.rs \
  docs/performance.md \
  docs/performance/large-table-mutations.md
git commit -m "perf(table): qualify large mutation latency" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Run the Release Gate and Native Acceptance

**Files:**
- Modify only files required by failures caused by Tasks 1–8.

**Interfaces:**
- Consumes: all previous task outputs
- Produces: verified branch ready for independent review and user acceptance

- [ ] **Step 1: Format and run focused Rust tests**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml compact_row_mutation -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml compact_column_mutation -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml natural_navigation -- --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml row_order -- --test-threads=1
```

- [ ] **Step 2: Run full Rust gates**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Any pre-existing warning baseline must be reported separately; do not suppress a
new warning introduced by this branch.

- [ ] **Step 3: Run frontend gates**

```bash
PLAYWRIGHT_CT_PORT=3130 npx playwright test -c playwright-ct.config.ts \
  tests/dataTableMutations.spec.tsx \
  tests/logicalTableNavigation.spec.tsx \
  tests/dataTableScroll.spec.tsx \
  --workers=1 \
  --output=.cache/issue241/release-ct
npx vite build
git diff --check
```

- [ ] **Step 4: Run all five 2,000,000-row qualifications**

Run the Task 8 commands and retain their JSON reports under the session artifact
directory, not in the repository. Every threshold and structural assertion must
pass.

- [ ] **Step 5: Request independent review**

Review the complete branch diff against `origin/dev`, focusing on:

- no full snapshot/rebuild in scoped paths;
- SQL/type fidelity for typed snapshots;
- stale-generation atomicity;
- local rebalance bounds;
- anchor correctness;
- legacy project/change-set compatibility;
- filtered/sorted stable-target semantics;
- archive cleanup and security.

Resolve every Critical/Important finding with a new RED/GREEN cycle.

- [ ] **Step 6: Run native acceptance**

Launch:

```bash
npm run tauri dev
```

Manually verify on a 2,000,000-row dataset:

- table-end append;
- middle row-menu insert above target;
- filter/sort insert semantics;
- row and column deletion;
- Undo/Redo before and after save/reopen;
- responsive UI and correct row/column counts.

- [ ] **Step 7: Commit release-gate fixes**

If verification required code changes:

```bash
git status --short
git add src-tauri/src src tests docs/performance.md docs/performance
git commit -m "fix(table): close mutation release gaps" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no code changed, do not create an empty commit.

- [ ] **Step 8: Stop for user acceptance before PR**

Report test, build, benchmark, review, and native-app evidence. Do not push or
create the PR until the user explicitly accepts the final native behavior.
