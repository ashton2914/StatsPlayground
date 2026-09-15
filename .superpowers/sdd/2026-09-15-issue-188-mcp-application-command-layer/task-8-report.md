# Task 8 Report

Date: 2026-09-15
Issue: 188-mcp-command-layer
Branch: issue/188-mcp-command-layer
Commit: c72f7085b93ea8005b29d4672eaea428c059c39f feat(io): authorize shared project export commands

## Original RED

- `tests/applicationCommandSaveSnapshot.test.ts`
  - Failed on `Workspace save must stop compensating for shared runtime effect draining`.
  - Confirmed `Workspace` still flushed pending effects and passed a caller-built save request into `project.save`.
- `tests/applicationCommandRuntime.test.ts`
  - Failed on `Pending command promises must expose their runtime requestId immediately`.
  - Confirmed async policy evaluation still surfaced `awaiting-confirmation` too early and the pending promise did not expose the runtime request id.
- `src-tauri/src/services/path_authorization_service.rs`
  - Failed on `authorize_filesystem_root_uses_non_absolute_display_name`.
  - Confirmed basename-less root authorization fell back to `/` and leaked an absolute path label.

## Repair Summary

- Closed Critical 1 by moving shared `project.save` ownership to the command layer:
  - Runtime now injects pending-effect draining into `project.save`.
  - `project.save` always builds the canonical request from current state and destination path.
  - Workspace no longer flushes effects or passes a caller-built request payload.
- Closed Critical 2 by separating async policy evaluation from confirmation state:
  - Pending async policy requests stay `queued` until the resolved policy explicitly requires confirmation.
- Closed Important 1 by binding export confirmation to the launched runtime request id:
  - Pending command promises now expose `requestId` immediately.
  - Workspace confirmation polling matches the exact `requestId`, not command-name queue scans.
- Closed Important 2 by making output-root display names path-safe:
  - Basename-less authorized roots now fall back to `root` instead of an absolute canonical path.

## Files

- `src/applicationCommands/applicationRuntime.ts`
- `src/applicationCommands/projectCommands.ts`
- `src/applicationCommands/runtime.ts`
- `src/applicationCommands/types.ts`
- `src/components/Workspace.tsx`
- `src-tauri/src/services/path_authorization_service.rs`
- `tests/applicationCommandRuntime.test.ts`
- `tests/applicationCommandSaveSnapshot.test.ts`

## Repair RED -> GREEN

- RED: `task8-gate-applicationCommandSaveSnapshot`
- RED: `task8-red-runtime-confirmation`
- RED: `task8-gate-path-authorization-service`
- GREEN: `task8-gate-applicationCommandSaveSnapshot`
- GREEN: `task8-gate-runtime-confirmation-final`
- GREEN: `task8-gate-historyTimeline`
- GREEN: `task8-gate-useProjectStore-saveLifecycle`
- GREEN: `task8-gate-path-authorization-service`
- GREEN: `task8-gate-build`
- GREEN: `task8-gate-git-diff-check`

## Findings Closed

- `project.save` can no longer be bypassed with a caller-supplied request payload.
- Non-UI callers now use the same save-effect drain and canonical request assembly as the UI path.
- New CSV export targets no longer transiently appear as awaiting confirmation while async policy evaluation is still pending.
- Concurrent export confirmations now bind to the exact launched request id.
- Root-level output grants no longer expose absolute canonical paths through `displayName`.

## Concerns

- `cargo test path_authorization_service -- --nocapture` still emits pre-existing Rust dead-code and unused-variable warnings outside the Task 8 slice.
- `npm run build` still emits pre-existing Vite chunk-size and dynamic-import warnings outside the Task 8 slice.

## Fix Round 1

Commit: c5632ae06b74e22f12534959854225d509461ab8 fix(io): close export authorization races

### RED

- `tests/applicationCommandSaveSnapshot.test.ts`
  - Failed with `Missing expected rejection.` after the new `false -> true` CSV export overwrite-race regression, proving the handler still wrote after the second inspection observed an existing target.
- `tests/applicationCommandRuntime.test.ts`
  - Failed because the handler received `null` instead of trusted request-bound confirmation context, proving the runtime was not carrying resolved policy/confirmation state into execution.
- `src-tauri/src/services/path_authorization_service.rs`
  - Failed the new dangling-leaf and dangling-ancestor symlink tests by returning `ResolvedOutputPath { ..., status: CreateNew }`, proving `exists()`/nearest-ancestor logic skipped existing dangling symlink entries.
- `tests/workspaceCommandHandlers.test.ts`
  - Initial RED was `ERR_MODULE_NOT_FOUND` for the missing extracted Workspace command bridge; after adding the parser fix, that confirmed behavior-level coverage was absent before the production extraction.

### GREEN

- `task8-gate-applicationCommandSaveSnapshot`
  - `application command save/snapshot/export tests passed`
- `task8-gate-runtime-confirmation-final`
  - `application command runtime tests passed`
- `task8-red-workspace-command-handlers`
  - `workspace command handler behavior tests passed`
- `task8-gate-historyTimeline`
  - `history-timeline regression passed`
- `task8-gate-useProjectStore-saveLifecycle`
  - `useProjectStore save lifecycle passed`
- `task8-gate-path-authorization-service`
  - `10 passed; 0 failed` for `cargo test path_authorization_service -- --nocapture`
- `task8-gate-build`
  - `npm run build` passed; only pre-existing Vite dynamic-import and chunk-size warnings remained.
- `task8-gate-git-diff-check`
  - `git --no-pager diff --check` passed.

### Files

- `src-tauri/src/services/path_authorization_service.rs`
- `src/applicationCommands/applicationRuntime.ts`
- `src/applicationCommands/ioCommands.ts`
- `src/applicationCommands/policy.ts`
- `src/applicationCommands/runtime.ts`
- `src/applicationCommands/types.ts`
- `src/components/Workspace.tsx`
- `src/components/workspaceCommandHandlers.ts`
- `tests/applicationCommandRuntime.test.ts`
- `tests/applicationCommandSaveSnapshot.test.ts`
- `tests/workspaceCommandHandlers.test.ts`

### Findings Closed

- Important 1: `resolve_output` now walks the path with `symlink_metadata`, rejects unresolved dangling symlink leaves and ancestor segments, rejects escaping symlinks, and still allows safe nested new-file creation under an authorized root.
- Important 2: runtime policy now carries trusted per-request confirmation context into execution, and the CSV export handler refuses a late `createNew -> overwriteExisting` transition unless that exact request received runtime-owned confirmation.
- Important 2: Workspace overwrite confirmation now stays bound to the launched request id through the extracted handler path, and the new behavior-level test proves two concurrent exports cannot cross-confirm each other.
- Minor 1: save/snapshot/export coverage now includes behavior-level Workspace command-handler tests in addition to the existing source-text guards.

## Fix Round 2

Date: 2026-09-15
Commit: 5980937c45408655c0e1794828d6e0279a483785 fix(io): enforce atomic export publication

### RED

- `task8-gate-applicationCommandSaveSnapshot`
  - Failed with `Detected unsettled top-level await` at `tests/applicationCommandSaveSnapshot.test.ts:335` after the new forged-overwrite regression blocked on runtime-owned confirmation instead of rejecting immediately.
  - Tightening that harness to drive an explicit deny through `runtime.confirm(requestId, false)` established the intended discriminator: ApplicationCommand input cannot forge overwrite authorization, and trusted overwrite intent must be projected only through the internal export service call.

### GREEN

- `task8-gate-applicationCommandSaveSnapshot`
  - `application command save/snapshot/export tests passed`
- `task8-gate-runtime-confirmation-final`
  - `application command runtime tests passed`
- `task8-red-workspace-command-handlers`
  - `workspace command handler behavior tests passed`
- `task8-gate-historyTimeline`
  - `history-timeline regression passed`
- `task8-gate-useProjectStore-saveLifecycle`
  - `useProjectStore save lifecycle passed`
- `task8-gate-path-authorization-service`
  - `10 passed; 0 failed` for `cargo test path_authorization_service -- --nocapture`
- `task8-fix2-authorized-export-race`
  - `3 passed; 0 failed` for `cargo test export_csv_authorized_ -- --nocapture`
- `task8-gate-build`
  - `npm run build` passed; only pre-existing Vite dynamic-import and chunk-size warnings remained.
- `task8-gate-git-diff-check`
  - `git --no-pager diff --check` passed.

### Files

- `src-tauri/src/services/io_service.rs`
- `src/applicationCommands/applicationRuntime.ts`
- `src/applicationCommands/ioCommands.ts`
- `tests/applicationCommandSaveSnapshot.test.ts`

### Findings Closed

- Important 1: authorized single-file CSV export no longer hands DuckDB the final target path directly after `CreateNew` classification. Rust now exports into a same-directory temporary file and performs the final filesystem publication separately.
- Important 1: `CreateNew` publication now uses atomic no-replace semantics via hard-link publication, so a racing leaf created after initial classification causes the export to fail and preserves the racing file bytes.
- Important 1: confirmed overwrite publication now uses deliberate same-filesystem replacement semantics, so an existing target is only replaced after DuckDB finishes writing the temporary export successfully.
- Important 1: the final publication path is re-authorized immediately before publish, and temporary files are cleaned up on export or publish failure.
- Important 1: the internal TS export dependency contract now receives trusted overwrite intent from runtime context, while forged overwrite flags on ApplicationCommand input remain ineffective.

### Concerns

- Direct `run_in_terminal` output was corrupted during this round, so executable evidence was captured through workspace tasks instead of the raw terminal bridge.
- `cargo test` continues to emit pre-existing Rust dead-code and unused-item warnings outside the Task 8 slice.
- `npm run build` continues to emit the pre-existing Vite dynamic-import and chunk-size warnings outside the Task 8 slice.

## Fix Round 3

Date: 2026-09-15
Commit: 691e7603b2c29762d92ea7837d396d3c3c5616ca fix(io): enforce trusted export intent

### Ruling Scope

- Binding scope preserved: the trusted confirmation authority is the application command runtime that owns request-bound confirmation state.
- Rust now enforces the runtime-projected overwrite intent without introducing a new renderer-independent capability or Rust-owned confirmation UI.
- Same-user arbitrary mutation inside a user-authorized directory remains outside Issue 188 except where final publication must still honor request-bound overwrite intent and authorized-path revalidation.

### RED

- `task8-fix3-red-applicationCommandSaveSnapshot`
  - Failed on `Default IO command dependencies must project trusted overwrite confirmation into ioService.exportCsvAuthorized`, proving the default TS-to-Tauri bridge still dropped runtime-owned overwrite intent before the Tauri command boundary.
- `task8-fix3-red-exportCsvAuthorized`
  - Failed to compile after the new tests added a trusted overwrite argument and deterministic staging seam, proving the Rust service/command boundary lacked the projected overwrite confirmation input and lacked a private staging-directory export seam.
  - After the first production slice, the same focused Rust gate exposed two residual expectation mismatches: the create-new race now failed at re-authorization before hard-link publish, and staging cleanup correctly removed only the private staging directory while preserving the caller-created final parent directory.

### GREEN

- `task8-gate-applicationCommandSaveSnapshot`
  - `application command save/snapshot/export tests passed`
- `task5-green-applicationCommandRuntime`
  - `application command runtime tests passed`
- `task8-red-workspace-command-handlers`
  - `workspace command handler behavior tests passed`
- `task8-gate-historyTimeline`
  - `history-timeline regression passed`
- `task8-gate-useProjectStore-saveLifecycle`
  - `useProjectStore save lifecycle passed`
- `task8-gate-path-authorization-service`
  - `10 passed; 0 failed` for `cargo test path_authorization_service -- --nocapture`
- `task8-fix2-authorized-export-race`
  - `6 passed; 0 failed` for `cargo test export_csv_authorized_ -- --nocapture`
- `task8-gate-build`
  - `npm run build` passed; only pre-existing Vite dynamic-import and chunk-size warnings remained.
- `task8-gate-git-diff-check`
  - `git --no-pager diff --check` passed.

### Files

- `src/services/ioService.ts`
- `src/applicationCommands/ioCommands.ts`
- `src/applicationCommands/applicationRuntime.ts`
- `src-tauri/src/commands/io_commands.rs`
- `src-tauri/src/services/io_service.rs`
- `tests/applicationCommandSaveSnapshot.test.ts`

### Findings Closed

- Gap 1 closed: the real default TS bridge now projects runtime-owned `overwriteConfirmed` through `ioService.exportCsvAuthorized`, through the Tauri `export_csv_authorized` command payload, and into `IoService::export_csv_authorized`. Rust rejects `OverwriteExisting` unless that projected value is `true`.
- Gap 1 closed: `CreateNew` publication still uses no-replace semantics via hard-link publication even if `overwriteConfirmed` is `true`; overwrite only occurs when the initial and revalidated authorized classification is `OverwriteExisting` and the projected confirmation bit is true.
- Gap 2 closed: authorized CSV export now stages into a private same-filesystem `TempDir` under the authorized parent, gives DuckDB a leaf path that does not exist before export begins, verifies the staged leaf with `symlink_metadata` as a regular non-symlink file, re-authorizes the final target immediately before publish, and cleans the entire staging directory via RAII on both success and failure.
- Gap 3 closed: tests now prove the default TS dependency forwards trusted overwrite confirmation into the IO service signature, direct unconfirmed Rust overwrite is rejected while preserving original bytes, confirmed overwrite succeeds, the staging leaf is absent before the exporter runs via an injected deterministic seam, staging directories leave no artifacts after success/failure, and the prior final-target race regression remains green.

### Concerns

- `cargo test` still emits pre-existing Rust dead-code and unused-item warnings outside the Task 8 slice.
- `npm run build` still emits the pre-existing Vite dynamic-import and chunk-size warnings outside the Task 8 slice.

## Fix Round 4

Date: 2026-09-15
Commit: e35b4e90a41bb3bf6462687b2471265593ebd69e fix(io): secure Windows export staging

### RED

- Added `#[cfg(windows)]` `authorized_export_staging_dir_has_protected_current_user_windows_acl`, which would fail against the previous `#[cfg(not(unix))]` no-op because the inspection helper and protected current-user ACL contract did not exist.
- Host RED limit: this macOS host has only `aarch64-apple-darwin` installed, so the Windows-only test could not be executed or compiled here without installing a target, which was explicitly out of scope.

### GREEN

- `task8-green-applicationCommandSaveSnapshot`: `application command save/snapshot/export tests passed`.
- `task8-gate-runtime-confirmation-final`: `application command runtime tests passed`.
- `task8-red-workspace-command-handlers`: `workspace command handler behavior tests passed`.
- `task8-gate-historyTimeline`: `history-timeline regression passed`.
- `task8-gate-useProjectStore-saveLifecycle`: `useProjectStore save lifecycle passed`.
- `task8-gate-path-authorization-service`: `10 passed; 0 failed` for `cargo test path_authorization_service -- --nocapture`.
- `task8-fix3-red-exportCsvAuthorized`: `6 passed; 0 failed` for `cargo test export_csv_authorized_ -- --nocapture` after each production edit.
- `task8-fix4-host-cargo-check-final`: `cargo check` passed on `aarch64-apple-darwin`; only pre-existing warnings remained.
- `task8-fix4-host-cargo-build-final`: `cargo build` passed on `aarch64-apple-darwin`; only pre-existing warnings remained.
- `task8-gate-build`: `npm run build` passed; only pre-existing Vite dynamic-import and chunk-size warnings remained.

### Files

- `src-tauri/Cargo.toml`
- `src-tauri/src/services/io_service.rs`

### Findings Closed

- Windows authorized CSV staging is no longer a no-op: `set_private_staging_permissions` now uses native Windows ACL APIs through a target-specific `windows-sys` dependency.
- The staging directory DACL is replaced with a protected DACL containing current-user full control and inheritance protection; ACL verification failure aborts before DuckDB receives the staging leaf.
- The Windows-only unit test inspects owner identity, protected DACL state, current-user full control, and absence of other explicit allow ACEs.
- Unix `0o700`, same-filesystem staging, absent staging leaf, regular non-symlink verification, final reauthorization, no-replace create-new publication, confirmed overwrite semantics, and RAII cleanup are preserved.

### Concerns

- Windows-specific ACL behavior was not executed or target-compiled on this host because no Windows Rust target is installed (`rustup target list --installed` returned only `aarch64-apple-darwin`).
- `cargo fmt --check` reports broader pre-existing formatting drift in `src-tauri/src/services/io_service.rs`; I did not run whole-file formatting to avoid unrelated churn.