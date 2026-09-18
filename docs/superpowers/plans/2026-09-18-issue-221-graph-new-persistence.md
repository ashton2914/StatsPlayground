# Graph Builder-new Persistence Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for focused implementation and independent review. Preserve all existing work; do not commit or push the new implementation before its manual acceptance.

**Goal:** Save multiple native graphs in a project and reopen them as editable charts.

**Architecture:** Durable graph documents are separate from live renderer sessions. Extend the existing Rust archive and typed project IPC, then connect the document store to Workspace save/open and the project tree.

**Tech Stack:** Rust/serde/ZIP, Tauri, React, TypeScript, Zustand, Playwright CT.

**Spec:** `docs/superpowers/specs/2026-09-18-issue-221-graph-new-persistence-design.md`

## Global Constraints

- Work only in the existing Issue 221 worktree at baseline `10f45ca`.
- Preserve caches, user data, other worktrees, and running app windows.
- Use `graphBuildersNew` and `graphNewFolders` consistently across TS and Rust.
- Durable document contract is the spec's version-1 shape; runtime generations never persist.
- Old projects default missing collections to empty; malformed new documents fail explicitly.
- Never use Playwright's shared default output; use `.cache/issue221-persistence/ct`.
- No automatic commits, pushes, branch changes, unrelated refactors or new dependencies.

## Task 1: Archive And IPC

**Files:** existing Rust project models/commands/services and `spprj_archive.rs`, `src/services/projectService.ts`, `src/types/project.ts`.

**Interface:** `graphBuildersNew: GraphBuilderNewDocument[]`, `graphNewFolders: Record<string, string>`; serde camelCase and default empty collections.

- [x] Add a failing archive roundtrip test for two version-1 native documents and folders, alongside an unchanged legacy graph.
- [x] Run the narrow Rust test and capture its failure.
- [x] Add explicit document validation and archive entries through existing safe naming/path/atomic-save infrastructure; propagate save/open payloads.
- [x] Test defaults, bad versions/modes/cameras, duplicate IDs and runtime-field exclusion; rerun focused archive/project tests and Cargo build.

## Task 2: Durable Store And Chart State

**Files:** `src/types/graphBuilderNew.ts`, `src/stores/useGraphBuilderNewStore.ts`, `src/components/graphBuilderNew/{GraphBuilderNewView,GraphNewCanvas}.tsx`, existing graph-new tests/harness.

**Interface:** documents remain after `close(id)`; `open(datasetId, generation)` appends a document/session; `reopen(id, generation)` opens existing definitions. Expose load/reset/rename/delete, update camera, and data-table deletion actions using established project guards.

- [x] Replace single-session/nonpersistent assertions with two-document lifecycle assertions and observe RED.
- [x] Add versioned document type and store, keeping runtime sessions derived from definitions and current source generations.
- [x] Persist settled camera changes, restore only against compatible full-domain metadata, and retain missing field IDs with visible diagnostics.
- [x] Verify dirty/read-only/no-op/load behavior, close versus delete, multiple documents, camera resets and previous renderer tests.

## Task 3: Workspace And Project Tree

**Files:** `src/components/Workspace.tsx`, existing project-tree/folder/selection utilities, locale JSON and corresponding tests.

**Interface:** save from durable documents; load from `graphBuildersNew ?? []`; store `graphNewFolders` with other folder maps; use graph IDs for navigation.

- [x] Add focused save/reopen wiring and tree behavior tests; observe RED.
- [x] Integrate create/select/close/reopen/rename/delete/folders, dirty/save guards, project reset and source deletion handling.
- [x] Exercise two saved graphs plus a legacy graph in existing component harnesses, including closed-before-save documents and missing references.
- [x] Run TypeScript/Vite, focused TS and isolated CT, archive tests and Cargo build; obtain independent actual-diff review and repair blocking findings.
- [x] Launch a uniquely identified native app and provide the user a save/close/reopen manual checklist.

## Progress

- Design approved; existing Windows renderer accepted; baseline remote synchronized.
- Implementation complete, uncommitted at baseline `10f45ca`; new persistence desktop/Windows manual acceptance remains pending.
- Independent review found and verified fixes for closed runtime transport identity reuse, failed Open clearing current documents, and UI/archive name admission mismatch. Final scoped re-review has no Critical/Important blockers.
- Final frontend checks: 28 TS assertion scripts, 82 CT cases, app typecheck and Vite pass. Backend checks: 9 native archive tests, 29 project tests, 28 streaming tests, native fresh-session lifecycle regression and Cargo build pass.
- Full archive suite is NOT all green: 94 pass, one Distribution error-message fixture assertion fails; relevant fixture/validator/order are source-identical to baseline. Baseline was not rebuilt. No unrelated fix was made.
- CT mounts the real Workspace with mocked IPC; Rust tests separately exercise disk archives. These do not constitute a live desktop end-to-end acceptance claim.
- Native acceptance instance: `StatsPlayground - Issue221 Persistence Task3`, frontend `http://127.0.0.1:3192/`; a normal browser lacks native IPC. Preserve existing windows. Use a disposable project copy: create/configure two graphs, rename/folder/zoom, close both views, Save As, close/open project, reopen each entry and compare settings; also verify old graph selection and cancelled discard prompts.
- Evidence and exact command manifests: `.cache/issue221-persistence/{backend,store,workspace,safety}/`; no source datasets or cache artifacts belong in a commit.
- Local hypothesis: session-only store plus absent save/open fields causes document loss. Cheapest check: two documents survive store serialization/restoration and real archive roundtrip.
- Task boundaries: Task 1 owns Rust and project IPC types, Task 2 owns graph document/store/view, Task 3 owns Workspace/tree. Shared document shape is fixed above; delegates must not edit each other's files.