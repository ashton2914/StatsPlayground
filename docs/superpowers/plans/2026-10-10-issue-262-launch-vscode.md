# Launch VS Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Configure a selected local workspace safely and launch Stable VS Code.
**Architecture:** Rust owns plan records, credential protection, persistent runtime readiness, source-aware JSONC edits, and process launch. The MCP store owns selection, preview, approval, execution, and status refresh; the panel presents this state.
**Tech Stack:** Tauri, Rust, jsonc-parser CST, capability-relative filesystem access, React, Zustand, Playwright.
**Spec:** `docs/superpowers/specs/2026-10-10-issue-262-launch-vscode-design.md`

## Global Constraints

- Reuse the existing issue-262 worktree and `feat/262-launch-vscode` branch, targeting `dev`.
- Preserve other servers, inputs, unknown keys, comments and formatting.
- Never write tokens into tracked files; verify local Git exclusion first.
- Single-use plans expire after five minutes and bind workspace/config/Git/runtime state.
- IPC launch responses expose folder names and non-secret summaries only.
- Launch Stable VS Code on Windows, macOS and Linux using argument arrays.
- Preserve configuration on editor launch failure; do not claim full success.
- Leave commits and publication until manual acceptance.

## Review Focus

- Nested Git workspaces and linked worktrees must exclude the correct repository-relative file.
- Directory substitution and symlink/reparse traversal must not redirect credentials.
- Duplicate JSONC keys and invalid servers shapes must be rejected without overwriting.
- Concurrent runtime stop/start or settings edits must invalidate plans or fail before writing.
- Arbitrary endpoint URLs must never leak credentials in confirmation summaries.

### Task 1: Workspace configuration and filesystem protection
**Files:** Create `src-tauri/src/services/vscode_workspace.rs`; add source-aware JSONC and capability filesystem dependencies in `src-tauri/Cargo.toml`.
**Interfaces:** Produces `Workspace::inspect(path)`, `Workspace::protect_git()`, `Workspace::write(bytes)`, `merge_config(source, settings)` for Task 2.
- [x] Add tests for merge/no-op/conflict/invalid/duplicate input, tracked refusal, nested Git and worktree exclusion, idempotence, symlink escape, private atomic writes.
- [x] Run Rust tests and observe missing implementation failure.
- [x] Implement source-aware edits and capability-relative, compare-before-replace writes with rollback.
- [x] Run focused tests; confirm original bytes and unrelated fields survive.

### Task 2: Persistent endpoint and launch service
**Files:** Create `src-tauri/src/services/vscode_launch_service.rs`; modify `mcp/server.rs`, `state.rs`, `commands/mcp_commands.rs`, `services/mod.rs`, `lib.rs`.
**Interfaces:** Consumes Task 1. Produces camelCase `VsCodeLaunchPlan`, `VsCodeLaunchRequest`, `VsCodeLaunchResult` through `plan_vscode_mcp_launch` and `execute_vscode_mcp_launch`.
- [x] Add tests for endpoint persistence, failed persistence rollback, runtime mismatch, stale/expired/single-use plans, explicit conflict approval, redacted serialization, platform arguments and partial completion.
- [x] Observe failing tests, implement narrow runtime-fingerprint persistence and launch service.
- [x] Run focused Rust tests, build and clippy.

### Task 3: Store, panel and documentation
**Files:** Modify `src/types/mcp.ts`, `src/services/mcpManagementService.ts`, `src/stores/useMcpStore.ts`, `src/components/ai/McpServerPanel.tsx`, four locale files; create launch store and component tests; update `docs/development.md` and `docs/troubleshooting.md`.
**Interfaces:** Consumes Task 2 IPC types. Produces picker/preview/confirmation/result UI and refreshed status/settings.
- [x] Add tests for cancellation, decline/no execute, explicit approval, errors, partial success and refresh.
- [x] Observe failures, implement store workflow and localized panel.
- [x] Run focused frontend tests, MCP component tests, full frontend build and affected Rust tests.
- [x] Run diff check, inspect changes, request independent final review and fix important findings.
- [x] Provide launch command and manual acceptance checklist.

## Verification record

- New Rust launch/workspace service tests: 19 passed.
- MCP Rust unit/command/settings tests: 64 passed.
- HTTP integration tests: 9 passed.
- Registered-command classification test: passed after adding the new commands.
- Frontend MCP contracts/store tests and component/end-to-end coverage: passed (17 browser tests).
- TypeScript + Vite production build: passed.
- Cargo build and clippy: passed with existing repository warnings.
- Independent review: all important findings fixed and re-reviewed. Regressions cover directory substitution before and after replacement, unchanged-config startup race, and duplicate authentication headers.
- Full Rust library run: 1527 passed, 18 ignored, 2 failed. The new-command classification failure was repaired and its focused rerun passed. The unchanged OLS test `warns_in_required_order_when_multiple_conditions_apply` also fails in isolation with `predictor mean is missing for X1`; its source is unchanged from the starting commit.
- Full `test:mcp` remains blocked by the unchanged source-inspection test `applicationCommandSaveSnapshot.test.ts`, which expects a removed `handleSave` source boundary. Remaining frontend MCP tests and Rust MCP coverage were run separately and passed.
- macOS native test application uses an isolated frontend port (1462). Human acceptance and Windows/Linux native acceptance remain pending; platform command construction is covered.
- Changes remain uncommitted until manual acceptance.

## Manual acceptance repair

### Task 4: Approved portable configuration compatibility

**Files:** `vscode_workspace.rs`, `vscode_launch_service.rs`, IPC types, preview, four locales, launch tests and documentation.
**Interfaces:** Workspace selects `.mcp.json`/`mcpServers` by default, reuses legacy-only `.vscode/mcp.json`/`servers`, and passes the relative `configurationPath` into preview and result. Both files are freshness-bound; duplicate managed entries fail before writing. No automatic migration/deletion.
- [x] Add behavioral tests and observe failures for portable creation, existing root precedence, duplicate refusal, migration freshness, root symlink/tracked refusal, schema/JSONC preservation, private atomic write/rollback and root/nested/linked Git exclusion.
- [x] Implement target-aware workspace operations and preserve existing legacy regression coverage.
- [x] Add and verify preview path coverage; update documentation/locales.
- [x] Run service/MCP/HTTP tests, frontend build, independent review, and restart native acceptance application.

Expected RED: existing implementation writes `.vscode/mcp.json`, misses root configuration and ignores root duplicates/links. Expected GREEN: focused launch/workspace tests pass for both formats, frontend preview names the actual selected relative path, and native build succeeds.

Portable verification: the first six behavioral tests failed before implementation and passed afterwards. The additional root-other-servers/legacy-managed-entry test also failed before adding the planning guard. Launch/workspace suite: 28 passed; UI suite: 18 passed; store/locale test and TypeScript/Vite build passed. MCP unit suite: 64 passed serially. Its first parallel run hung in unchanged broker test `post_commit_late_error_is_recorded_truthfully_and_retention_is_bounded`, which dispatches with a 1 ms deadline then spins waiting for an emitted request; isolated rerun passed. HTTP integration: 9 passed serially; its first run had an intermittent connection reset in the unchanged raw HTTP response helper. No broker/HTTP test source changes. Independent review found no Critical, Important or confirmed Minor issues in the portable delta. Native build succeeded and issue-262 application restarted on frontend port 1462. Clippy passed with 199 existing warnings and none in the new VS Code modules; rustfmt and diff checks passed. Manual native acceptance remains pending; on 2026-10-10 the user explicitly requested committing and pushing the changes. This publication request does not assert that the remaining VS Code session-runtime scenario passed.

- The first native acceptance exposed an application-entrypoint issue: debug `run()` unconditionally injected port `48188` and a short development token. Runtime settings therefore differed from saved settings and VS Code launch correctly rejected the invalid token. Runtime/service unit tests did not execute this application entrypoint.
- Removed automatic environment injection. Normal debug startup now follows saved settings or random transient defaults; explicit developer environment overrides remain supported as specified by issue 254. Credential validation remains unchanged.
- MCP Rust tests rerun: 64 passed; launch/workspace tests: 19 passed. Independent review found no new important issues. Native debug build succeeded and the issue-262 test process was restarted against the responsive frontend on port 1462. An existing process must be fully restarted because it retains its injected environment and active runtime. Human retry remains pending.
