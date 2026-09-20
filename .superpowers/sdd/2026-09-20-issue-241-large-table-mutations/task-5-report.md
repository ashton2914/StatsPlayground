# Task 5 Report — Persist and Clean Up Delta History

## Result

Implemented and committed as `56802a2` (`feat(project): persist compact table history`).

## Changed files

- `src-tauri/src/services/spprj_archive.rs`
- `src-tauri/src/services/streaming_project_writer.rs`
- `src-tauri/src/services/project_service.rs`
- `src-tauri/src/engine/duckdb_engine.rs`
- `src/stores/useHistoryStore.ts`
- `tests/historyCleanupFailure.test.ts`

No Analysis contracts, validators, manifests, or behavior were changed.

## Archive format and lifecycle

- Added optional manifest `deltaHistory`.
- Compact metadata is stored at `history/change_sets.json` (version 1).
- Each referenced typed snapshot is stored at
  `history/snapshots/{validated-change-set-uuid}.parquet`.
- Metadata contains row/column operation, dataset, current/before/after
  generations, applied state, row delta rows, column delta rows, calculated
  definitions, and stable snapshot-table identity.
- Save validates UUID-derived snapshot names and schema, casts Parquet columns
  to the declared archive types, and validates the completed archive.
- Open strictly validates paths, UUIDs, descriptor/metadata parity, missing or
  extra snapshots, metadata JSON, and every restored Parquet schema. Restore
  occurs transactionally in the staged database: metadata first, then snapshot
  tables, generation/anchor restoration, and only then live-state publication.
- Archives without `deltaHistory` continue to open unchanged.
- Timeline replay generation metadata is advanced across related compact
  change sets so sequential Undo/Redo remains valid after reopen.
- `drop_change_set` now transactionally deletes legacy, row, and column
  metadata and only the UUID-validated referenced snapshot. Snapshot-free add
  operations remain supported.
- Frontend cleanup remains fire-and-forget after mutation, but failures now set
  `historyError`.

## TDD evidence

Behavioral RED (both compiled and executed):

- `cargo test --manifest-path src-tauri/Cargo.toml delta_history_archive -- --test-threads=1`
  exited 101: `missing snapshot must fail`.
- `cargo test --manifest-path src-tauri/Cargo.toml drop_compact_change_set -- --test-threads=1`
  exited 101: `_history_delta_change_sets retained discarded metadata`.
- `npx tsx --tsconfig tsconfig.app.json tests/historyCleanupFailure.test.ts`
  exited 1 because the silent catch was still present.

GREEN:

- `delta_history_archive`: 2 passed.
- `drop_compact_change_set`: 1 passed.
- `read_project_file`: 14 passed.
- `legacy_`: 39 passed.
- `compact_`: 25 passed.
- Frontend cleanup contract: passed.
- `npx vite build`: passed (existing chunk-size warning only).
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib`: passed with
  pre-existing warnings.
- `git diff --check`: passed.

The post-commit full `cargo test --lib -- --test-threads=1` baseline was not
green: 1,340 passed, 18 ignored, and 9 unrelated pre-existing failures remained
(one SQLite import test and eight tabulate-session tests). The tabulate failures
report missing generation-0 source anchor manifests; none exercise the Task 5
archive, cleanup, or history paths. All focused and adjacent compact/archive
suites listed above are green.

## Compatibility coverage

- Explicit no-`history/` archive open assertion.
- Missing referenced snapshot rejects with `AppError::FileIO`.
- Round-trip project test saves a row deletion and a column deletion, reopens,
  loads both frontend history entries, and performs sequential Undo and Redo.
- Existing indexed archive reader and broad legacy archive suites pass.
- Compact mutation regression suite passes.

## Self-review

- SQL values remain bound; generated identifiers come only from validated UUIDs
  or database-owned schema descriptors and are quoted.
- Absolute paths are used only internally for DuckDB temporary Parquet I/O and
  are never returned across IPC.
- Restore failures remain staged and cannot replace the live project.
- Cleanup preserves unrelated metadata and snapshot tables.
- No Task 6/7 mutation IPC or DataTableView wiring was added.

## Risks

- Parquet represents DuckDB `HUGEINT` through `DECIMAL(38,0)`; the writer casts
  to that declared stable archive type and the reader validates it explicitly.
- The focused frontend regression is the repository-standard source contract
  style because this store has no isolated runtime store test harness.

## Fix round 1/5 — 2026-09-20

Committed as `184f135` (`fix(project): validate compact history restore`).

### Findings closed

1. **Archive contract validation:** delta history is now validated exhaustively
   before staged metadata insertion. Only the four supported kind/operation
   pairs are accepted. Delete operations require UUID-derived snapshots; add
   operations forbid them. Row/column delta shapes, UUIDs, calculated-column
   JSON, dataset existence, descriptor schemas, physical Parquet schemas, and
   snapshot row identities are validated. Every failure is `AppError::FileIO`.
2. **Authoritative generation:** `manifest.json` now carries optional
   `datasetGenerations`. Open restores the table generation and anchors before
   compact history, never lowers it to the maximum compact generation, and
   normalizes compact replay fences around the authoritative generation. Legacy
   full-history replay advances compact fences transactionally.
3. **Lossless HUGEINT:** snapshot descriptors now record logical and transport
   types. `HUGEINT` is transported as canonical `VARCHAR`, validated with
   `TRY_CAST` plus canonical round-trip equality, and reconstructed as
   `HUGEINT`. Nulls and the full signed i128 range remain exact.
4. **Cleanup runtime coverage:** added a real Zustand store regression that
   records 101 change-set actions, observes MAX_HISTORY truncation calling
   `dropTableChangeSet` for only the discarded set, forces backend rejection,
   and observes `historyError`.

### Behavioral RED evidence

- Archive contract suite: 3 executed failures because delete-with-null,
  matching-but-invalid row/column schemas, and add-with-snapshot all opened
  successfully (`0 passed; 3 failed`, exit 101).
- Authoritative generation: controlled removal of manifest generation
  publication produced `left: 0, right: 2` in the compact-then-legacy
  round-trip test (exit 101).
- HUGEINT: the extrema/null round trip failed with restored `DOUBLE` snapshot
  columns instead of logical `HUGEINT` (exit 101).

### GREEN evidence

- `delta_history_archive`: 7 passed.
- `drop_compact_change_set`: 1 passed.
- `read_project_file`: 14 passed.
- `legacy_`: 40 passed.
- `compact_`: 25 passed.
- Frontend `historyCleanupFailure`, `historyCleanupRuntime`, and
  `historyTimeline`: passed; the runtime test printed
  `history cleanup runtime regression passed`.
- Vite build: passed in 5.95 seconds (existing chunk-size warning only).
- Cargo build: passed with existing warnings.
- Cargo clippy `--lib`: passed with existing baseline warnings.

### Compatibility and risk update

- `datasetGenerations` defaults to empty and is omitted when empty, preserving
  archives created before this round.
- Analysis archive validators/contracts were not modified.
- The prior report's statement that only a source contract was feasible is
  superseded by the new runtime Zustand cleanup regression.

## Fix round 2/5 — 2026-09-20

### Root-cause trace and hypotheses

- **Archive serialization:** `streaming_project_writer` publishes
  `datasetGenerations` from the save snapshot and writes compact descriptors
  from `DuckDbEngine::archive_delta_history`. Row-delete snapshots are physical
  `SELECT *` copies, while snapshot-free column additions carry their logical
  types only in `change_sets.json`.
- **Staged project restore:** `ProjectService::open_project` restores table
  documents at their default generation, overwrites generations only by
  iterating the deserialized `datasetGenerations` map, rebuilds anchors, and
  then calls `restore_delta_history`. Because the manifest field currently
  defaults to an empty map, absence in a pre-field archive is
  indistinguishable from an explicitly empty map.
- **Delta restore and fences:** `restore_delta_history` treats the staged
  dataset generation as authoritative, admits row descriptors whose columns
  are merely a subset of the dataset-plus-history column set, does not
  canonicalize snapshot-free column metadata types, and uses `min(generation)`
  to lower stored compact fences silently.
- **Hypothesis 1:** requiring equality between a row-delete descriptor and the
  complete dataset-plus-historical-column logical schema will reject a
  physically incomplete snapshot before insertion while preserving genuine
  historical row snapshots.
- **Hypothesis 2:** canonicalizing every column-delta `colType` and validating
  calculated-definition ownership before starting the restore transaction will
  reject malformed snapshot-free metadata as `FileIO`.
- **Hypothesis 3:** representing manifest generation presence explicitly,
  deriving absent-map generations from restored metadata plus the maximum
  compact `generation`/`beforeGeneration`/`afterGeneration`, and rejecting
  present-map values below that maximum will preserve pre-field archives
  without weakening new archives. Archives with neither compact history nor a
  generation map remain on the legacy path.

### Behavioral RED evidence

`cargo test --manifest-path src-tauri/Cargo.toml delta_history_archive --
--test-threads=1` compiled and executed 10 tests. Four failed for the intended
missing behavior:

- incomplete-but-allowed row snapshot: restore returned `Ok(())`;
- snapshot-free `add_columns` with `NOT_A_DUCKDB_TYPE`: restore returned
  `Ok(())`;
- pre-field archive: restored generation was `0` instead of compact generation
  `1`;
- explicit generation `0` below compact generation `1`: open returned success.

Result: **6 passed, 4 failed**, exit 101.

### Implementation

- Changed `ProjectManifest.dataset_generations` from a defaulted map to an
  optional map so archive readers retain absent-versus-present information.
  New saves always serialize `Some(map)`.
- For an absent map with compact history, staged restore now derives each
  authoritative generation as the maximum of restored dataset metadata and all
  compact current/before/after generations, then rebuilds anchors at that
  generation. No-history legacy archives remain untouched.
- Delta restore now rejects an authoritative generation below any compact
  generation instead of `min`-normalizing it, and preserves stored inactive
  fences while rebasing only the fence representing the current applied state.
- Row-delete snapshots must contain the complete exact logical name/type set
  from the restored physical dataset plus archived historical columns.
- Every column delta is canonicalized through DuckDB before transaction start;
  unsupported or non-canonical types become `FileIO`. Calculated definitions
  must deserialize and own the archived column ID. Snapshot logical types also
  map canonicalization failures to `FileIO`.
- Added behavioral coverage for a pre-field archive followed by compact Undo,
  legacy Undo/Redo, and compact Redo, proving mixed replay advances fences
  monotonically.

### GREEN evidence

- `delta_history_archive`: **10 passed**.
- `read_project_file`: **14 passed**.
- `legacy_`: **40 passed**.
- `compact_`: **26 passed**.
- `drop_compact_change_set`: **1 passed**.
- Frontend history cleanup failure contract: passed.
- Frontend `MAX_HISTORY` cleanup runtime: passed and printed
  `history cleanup runtime regression passed`.
- Frontend history timeline: passed and printed
  `history-timeline regression passed`.
- `npx vite build`: passed in **6.28s**; existing chunk-size warning only.
- `cargo build --manifest-path src-tauri/Cargo.toml`: passed with 112 existing
  warnings.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib`: passed with 181
  existing baseline warnings.
- `git diff --check`: passed.

### Round-2 compatibility and risk

- The pre-field test removes `datasetGenerations` from a genuinely saved
  compact-history archive before open; it does not construct a synthetic
  manifest-only case.
- Explicit too-low generation is rejected as `AppError::FileIO` before compact
  metadata insertion into the staged database.
- Canonical `VARCHAR` transport for logical `HUGEINT` remains unchanged and its
  extrema/null round trip remains in the passing delta archive suite.
- No Analysis contracts, primary checkout files, unrelated fixtures, or
  frontend behavior were changed.
