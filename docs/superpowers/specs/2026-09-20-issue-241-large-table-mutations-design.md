# Issue 241 Large-Table Mutations Design

## Status

Approved on 2026-09-20.

## Problem

On a dataset with approximately 2,000,000 rows, adding or deleting a row or
column is much slower than the size of the requested change suggests. The row
context-menu action also says that it inserts a row, but the current API has no
position argument and the backend always appends with `MAX(_row_id) + 1`.

The dominant confirmed costs are not the single-row `INSERT` itself:

1. `execute_table_mutation` creates `_history_full_before_*` with
   `CREATE TABLE ... AS SELECT *`, copying the full dataset for every mutation.
2. Every mutation calls `rebuild_natural_anchors`, which scans every row and
   computes `row_number()`.
3. The frontend reloads the table and refreshes all dataset metadata after the
   mutation.

Row and column deletion use the same full-snapshot and full-anchor-rebuild path.
They are therefore in scope together with insertion.

## Goals

- Append one row to a 2,000,000-row dataset in no more than 1 second.
- Insert one row in the middle in no more than 2 seconds.
- Add one empty column in no more than 2 seconds.
- Delete one or a small number of rows in no more than 2 seconds.
- Delete one column in no more than 5 seconds.
- Keep batch row deletion proportional to the number of deleted rows, up to the
  existing 5,000-row limit.
- Keep batch column deletion proportional to deleted columns times source rows.
- Make row context-menu insertion occur above the target row in persistent
  natural order.
- Preserve Undo/Redo, stale-generation fencing, calculated-column dependency
  validation, project persistence, and logical table navigation.
- Never fall back to full-table row renumbering or a full dataset history copy
  for the operations in scope.

## Non-goals

- Rewriting compact history for cell edits, paste, type conversion, calculated
  columns, or other complex mutations.
- Persisting a filtered or sorted view order as dataset order.
- Guaranteeing that a newly inserted blank row remains visible under a filter
  or sort.
- Removing the full-snapshot coordinator until every remaining caller has a
  compact inverse representation.
- Optimizing deletion of a column below the unavoidable cost of preserving that
  column's values for Undo.

## User Semantics

Natural dataset order is the only persisted row order.

- The table-end `+` appends rows.
- The row context-menu insert action inserts above the clicked target row.
- A batch insert opened from a row context menu inserts the batch above that
  target, retaining batch order.
- A batch insert without a row target appends.
- In a filtered or sorted view, the UI resolves the target's stable `_row_id`
  and inserts before that row in natural order. Reapplying the current query may
  move or hide the blank row.
- Deletes address stable row IDs or column IDs, never transient viewport slots.

## Stable Mutation Contract

The row IPC contract becomes:

```ts
interface RowMutationResult {
  rowIds: number[];
  generation: number;
  rowCount: number;
  changeSetId: string;
}

addRows(
  datasetId: string,
  count: number,
  beforeRowId: number | null,
  expectedGeneration: number,
): Promise<RowMutationResult>
```

Rust receives `before_row_id: Option<i64>` and `expected_generation: u64`.

- `beforeRowId = null` appends.
- A row ID inserts immediately before that stable row in natural order.
- A stale generation or missing target returns `AppError::InvalidParam`.
- The backend does not silently retry at another position.

Column add/delete APIs retain stable column IDs, logical `col_index`, and
expected generation. Their results return the new generation, column count, and
change-set ID so the frontend can update metadata without a global refresh.

## Natural Row Order

Every dataset table gains a hidden nullable column:

```sql
"_row_order" HUGEINT
```

Natural order is:

```sql
ORDER BY
  COALESCE("_row_order", CAST("_row_id" AS HUGEINT) * ORDER_STRIDE),
  "_row_id"
```

`ORDER_STRIDE` is a large constant that leaves ample space between legacy rows.
Existing rows remain `NULL`; opening an old project does not update millions of
rows.

Middle insertion allocates evenly spaced keys between the predecessor and target
effective keys. Repeated insertion at one location eventually triggers a bounded
local rebalance:

1. Load a fixed-size natural-order window around the target.
2. Find stable keys before and after the window.
3. Redistribute only that window's explicit `_row_order` values.
4. Expand the window geometrically up to a fixed safety bound if needed.
5. Return an explicit error if the bound cannot produce enough keys.

The implementation must not renumber the full table.

All natural-order consumers use one shared SQL helper, including navigation,
export, copy, archive, content hashing, and workflows. `_row_order` remains an
internal column and is not exposed as user data.

## Incremental Natural Navigation Anchors

`_table_navigation_anchors` stores the effective `order_key` in addition to
`ordinal` and `row_id`. Natural window reads seek with `(order_key, row_id)`.

Specialized row mutations:

1. copy the previous generation's sparse anchors to the next generation;
2. shift downstream ordinals by the inserted/deleted count;
3. remove anchors whose rows were deleted;
4. repair only gaps around affected boundaries so every adjacent anchor gap is
   no greater than `NATURAL_ANCHOR_STRIDE`;
5. update dataset generation atomically.

Sparse anchor work is proportional to anchor count plus the locally repaired
range, not dataset row count. Full rebuild remains available only for import,
project restore, migration repair, and complex mutations still using the legacy
coordinator.

## Compact History

The four operation families use a specialized delta coordinator:

- add rows;
- delete rows;
- add columns;
- delete columns.

The coordinator validates generation and performs mutation, delta capture,
metadata updates, anchor updates, and generation publication in one DuckDB
transaction.

### Row deltas

Metadata records the operation, dataset, generations, target position, and
stable row IDs/order keys.

- Added blank rows require only IDs and order keys.
- If allocation performs a bounded local rebalance, the same change set stores
  one typed metadata row per existing row touched (maximum 8,192), containing
  the stable row ID and the nullable `_row_order` before-image plus explicit
  after-image. This preserves the distinction between a legacy `NULL` fallback
  key and an explicit `HUGEINT`; it is not a full-table snapshot.
- History v2 writes all `HUGEINT` order keys as canonical decimal strings.
  Compatibility reads also accept legacy bare JSON integer tokens across the
  full signed `i128` range, but reject floats, exponent notation, out-of-range
  values, and noncanonical decimal strings. The serde_json `raw_value` feature
  is used only to preserve the original integer token for this field-level
  parser; unlike `arbitrary_precision`, it does not change global JSON number
  deserialization behavior.
- Deleted rows use a typed per-change-set snapshot table containing only the
  deleted rows, including `_row_id`, `_row_order`, and user values.
- Undo of an add deletes those IDs, then restores the bounded rebalance
  before-image before publishing anchors and the manifest.
- Redo of an add reapplies the bounded rebalance after-image before restoring
  the same IDs and order keys.
- Undo of a delete restores the typed rows at their original natural positions.
- Redo deletes the same IDs again.

### Column deltas

Metadata records stable column ID, name, DuckDB type, logical `col_index`,
calculated-column definition where applicable, and operation.

- Added empty columns need no value snapshot.
- Deleted columns use a typed per-change-set snapshot table containing only
  `_row_id` plus the deleted columns.
- Undo restores schema, stable IDs, logical positions, definitions, and values.
- Redo removes the same stable IDs again.
- Existing calculated-column dependency checks remain authoritative.

The scoped operations never create `_history_full_before_*`.

### Cleanup and persistence

Deleting history removes its delta metadata and typed snapshot tables.
All retained table mutations also publish one immutable timeline row:

```text
change_set_id, dataset_id, history_ordinal, storage_kind, operation,
created_before_generation, created_after_generation, current_generation,
applied, before_schema, after_schema
```

`history_ordinal` is allocated monotonically per dataset when the mutation is
created. It never changes during Undo/Redo. The created generation pair and
before/after schemas are also immutable; only `current_generation` and
`applied` change during replay. Compact and legacy/full replay advance the
current fences of every retained change set for that dataset in the same
transaction.

Project save writes an optional unified history archive v2:

```text
history/timeline.v2.json
history/snapshots/{change_set_id}/delta.parquet
history/snapshots/{change_set_id}/before.parquet
history/snapshots/{change_set_id}/after.parquet
```

The ordered timeline contains every retained compact and legacy/full change
set, the applied cursor/prefix state, exact before/after physical schemas keyed
by stable column ID, and snapshot descriptors with logical and transport
types. Compact add operations have no snapshot. Compact deletes store their
typed delta snapshot. Legacy/full entries store both full snapshots. Logical
`HUGEINT` uses a canonical `VARCHAR` transport and is reconstructed as
`HUGEINT` on restore.

Project open validates the complete timeline before inserting history
metadata: ordinals are unique and contiguous within each dataset, cursor and
applied state agree, generation transitions are monotonic, schema transitions
match the ordered operations, every required snapshot is present exactly once,
and every descriptor matches its Parquet payload. Restore occurs in staged
state and publishes frontend history only after the full timeline commits.
Row-delete snapshots are validated against the exact schema at their immutable
history ordinal, not against the current schema or a union of all schemas.

Archives without a history section remain compatible. Archives containing the
earlier compact-only v1 section restore only the compact backend evidence they
actually contain. A frontend entry that references a legacy/full change set
absent from that archive is marked non-replayable with an explicit migration
error; generation or snapshot state is never inferred from the frontend entry.
New saves always write v2. Legacy full-snapshot change sets restored from v2
continue to dispatch through the existing replay path.

## Frontend Refresh

Mutation results carry exact generation and counts. The frontend:

1. records the returned compact change-set ID;
2. patches active dataset generation and row/column count;
3. invalidates affected table windows and query sessions;
4. reloads the current window with the returned generation;
5. marks the project dirty.

It does not call a global dataset refresh after a successful scoped mutation.
If the backend returns stale generation, the UI reports the error, refreshes the
current dataset/window, and requires an explicit retry.

After row deletion, logical start, active cell, and selections clamp to surviving
rows. After positional insertion, the natural view keeps the target area visible.
A filtered or sorted view reruns its query and accepts that the inserted blank row
may move or disappear.

## Migration

Migration is transactional:

- add `_row_order HUGEINT` to every dataset table if absent;
- add `order_key HUGEINT` to anchor storage if absent;
- create compact change-set and delta metadata tables;
- mark old anchors for one-time rebuild at first natural navigation or rebuild
  them during controlled project restoration;
- retain legacy change-set tables and readers.

Migration does not populate `_row_order` for old rows.

## Failure Handling

The transaction rolls back on:

- stale generation;
- missing `beforeRowId`;
- local order-key rebalance exceeding its safety bound;
- calculated-column dependency violations;
- incomplete or mismatched delta history;
- schema mutation, snapshot, metadata, or anchor failure.

There is no success-shaped fallback, append-at-end fallback, full-table
renumbering fallback, or history-free success.

## Verification

### Correctness

- Append and positional insert, including repeated insertion at one target.
- Natural navigation at Home, middle, and End after insert/delete.
- Filtered/sorted insertion sends stable row ID and preserves natural semantics.
- Row and column add/delete Undo/Redo restores IDs, values, order, types, and
  logical positions.
- Stale generation and missing-target requests fail atomically.
- Local rebalance remains bounded.
- Legacy projects and legacy change sets remain readable.
- Saved and reopened projects retain delta history behavior.
- No scoped operation creates `_history_full_before_*`.

### Performance

A fixed 2,000,000-row `perf-harness` fixture reports:

- backend mutation time;
- history delta time;
- metadata/anchor time;
- current-window reload time where applicable;
- total operation time;
- retained/process memory.

Qualification thresholds:

| Operation | Maximum |
|---|---:|
| Append one row | 1,000 ms |
| Insert one middle row | 2,000 ms |
| Add one empty column | 2,000 ms |
| Delete one/small row set | 2,000 ms |
| Delete one column | 5,000 ms |

The qualification also asserts no full history snapshot, no full anchor rebuild,
no full-table row renumber, and no near-doubling of memory from a dataset copy.

## Delivery

Implementation branch: `issue/241-large-table-mutations`.

Base and PR target: latest `origin/dev`.

The work requires focused RED/GREEN cycles, Conventional Commits with the
required Copilot trailer, full Rust/frontend verification, independent review,
and native Tauri acceptance before PR submission.
