# Task 4 Fix Round 2 Report

## Status

Completed.

Minimum symmetric lifecycle wiring was added so Fit Y by X state is reset on project close/open preflight and restored from project data on open. Folder restoration continues to use the saved `fitYByXFolders` payload after the Fit Y by X items are loaded, so prune sees valid restored IDs.

## Commit

Pending local commit with message:

`fix(project): restore Fit Y by X state on open`

## Tests

- `npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts`
- `npx tsc -b`
- `npx vite build`

## Concerns

- Direct `npx tsx tests/useProjectStore.saveLifecycle.test.ts` does not work in this repo because the test transitively imports `@/` aliases from app code. The validated command above uses `--tsconfig tsconfig.app.json` so the alias resolves correctly.
- `npx vite build` passes with existing chunk-size and mixed static/dynamic import warnings unrelated to this change.

## Fix Round 2

### Scope

Task 3 command-layer round 2 was implemented in the `188-mcp-command-layer` worktree with TDD and focused changes in managed table create response wiring, command warning propagation, localization parity, and runtime/store revision synchronization.

### Disposition Of Open Findings

1. Critical (commit succeeds but refresh fails): fixed.
- `table.create` now treats post-commit dataset refresh failure as a warning, not as command failure.
- Command returns success with deterministic committed effects exactly once (dirty, selection, history) and no create retry.
- Warning is surfaced via `CommandResult.warnings` with stable payload:
	- `code`: `table_create_refresh_failed`
	- `message`: `Table created, but dataset refresh failed`

2. Important (result columns/display rebuilt from request): fixed.
- Backend now returns canonical managed create outcome from the same successful mutation path (no post-commit read).
- IPC `create_managed_table` and TS `dataService.createManagedTable` return canonical dataset + columns + display payload.
- `table.create` result now uses backend canonical columns/display directly.

3. Important (hardcoded English history message): fixed.
- Default production table dependency now uses i18n runtime translation key `history.newTable`.
- Hardcoded `Created table ...` default path removed.

4. Important (runtime/store revision divergence across lifecycle): fixed.
- Added explicit revision synchronization contract in runtime construction via get/set callbacks.
- Production singleton runtime is wired to `useProjectStore.projectRevision` through this adapter.
- Successful changed mutations increment both runtime-visible and store revision once; lifecycle resets in store are reflected by runtime on next command.

### RED -> GREEN Evidence

RED
- TS RED confirmed in:
	- `tests/applicationCommandTable.test.ts` (canonical result shape + refresh warning expectations)
	- `tests/applicationCommandRuntime.test.ts` (revision adapter/reset behavior)
- Rust RED confirmed in:
	- `src-tauri/src/services/data_service.rs` (`create_managed_table_outcome_returns_canonical_columns_and_display`) before service method existed.

GREEN
- `npx tsx --tsconfig tsconfig.app.json tests/applicationCommandTable.test.ts`
- `npx tsx --tsconfig tsconfig.app.json tests/applicationCommandRuntime.test.ts`
- `npx tsx --tsconfig tsconfig.app.json tests/applicationCommandProject.test.ts`
- `npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts`
- `cd src-tauri && cargo test create_managed_table -- --nocapture`
- `cd src-tauri && cargo test save_project_round_trips_complex_values_and_project_metadata -- --nocapture`
- `npm run build`

All above passed.

### Canonical Response Path

- Rust model additions: `ManagedTableCreateResult`, `ManagedTableCreateColumn`.
- Rust service addition: `DataService::create_managed_table_outcome(&CreateManagedTableRequest) -> Result<ManagedTableCreateResult, AppError>`.
- Existing compatibility path preserved: `DataService::create_managed_table(...) -> Result<DatasetMeta, AppError>` now delegates to outcome and returns dataset.
- Tauri command `create_managed_table` now returns `ManagedTableCreateResult`.
- TS `dataService.createManagedTable` now returns `ManagedTableCreateResult`.

### Warning Semantics

- Refresh failure is caught after commit and emitted as a stable command warning.
- No retry is performed.
- No duplicate mutation is performed.
- Pre-commit validation/service failures remain hard errors and do not trigger dirty/history/selection/revision increments.

### Pre-commit Validation Coverage

`table.create` now validates preview bounds before commit:
- `preview.offset` must be integer >= 0
- `preview.limit` must be integer in [1, 200]

### Files Touched

- `src/applicationCommands/tableCommands.ts`
- `src/applicationCommands/runtime.ts`
- `src/applicationCommands/applicationRuntime.ts`
- `src/stores/useProjectStore.ts`
- `src/services/dataService.ts`
- `src/types/data.ts`
- `src-tauri/src/models/table.rs`
- `src-tauri/src/services/data_service.rs`
- `src-tauri/src/commands/data_commands.rs`
- `tests/applicationCommandTable.test.ts`
- `tests/applicationCommandRuntime.test.ts`