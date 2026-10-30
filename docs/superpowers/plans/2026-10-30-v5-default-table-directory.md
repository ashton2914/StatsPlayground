# Default v5 and Table-Centered Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make v5 the native default and navigate tables with owned documents and Transform links, with atomic whole-component organization and directed cascading deletion.

**Architecture:** A backend metadata topology is authoritative. Undirected connected components define move/copy/project-object export scope; directed descendants define deletion scope. UI, native commands, application commands, and MCP consume the same revision-bound operation previews and commit receipts.

**Tech Stack:** Rust, Tauri v2, bundled DuckDB, TypeScript, React, Zustand, existing Node/tsx and Playwright runners.

**Spec:** [Approved design](../specs/2026-10-30-v5-default-table-directory-design.md).

## Global Constraints

- Preserve existing stable IDs, v5 epoch/revision fences, automatic persistence, receipts, migration/source protection, and read-only rules.
- Graph, Graph-new, all Analysis kinds, and Tabulate are owned by their source table; synthetic extensions disappear from internal object UI.
- Move/copy/project-object export use complete Transform-connected components; deletion uses the selected table and all downstream descendants, never ancestors.
- Individual owned documents may be deleted; table deletion removes their owned documents too.
- New folders are containers; dragging a member or owned document moves its whole component, including to project root. Folder deletion promotes contents without deleting data.
- Topology and tree construction use metadata only, including unhydrated and later-page records; never query dataset rows or hydrate report bodies to navigate.
- Group move/delete/copy/import publication is atomic; expensive copies/exports support cancellation before publication.
- Keep `.spprj` and real interchange-file extensions; do not strip suffix-like user-authored object name text.
- Keep the locked DuckDB version and existing dependencies. No Git publication, release, installation, or user-data cleanup.

## Review Focus

1. Later-page/unloaded Transform bindings: the operation must include unseen members; Task 1 tests this without document hydration.
2. Shared-input Join and branch deletion: deleting one input removes dependent outputs, preserving other inputs and siblings; Task 3 tests exact survivors.
3. Dragging an owned graph into a newly created nested folder: move its entire component, and none of an unrelated component; Tasks 2/6 test this through the native boundary.
4. Lost acknowledgement or stale preview during topology change: replay exactly once or reject without partial effects; Tasks 2–5 test receipts and stale epochs/revisions.
5. Multi-layer graph settings, filters, calculated-column identity, and failed/cancelled export: preserve all remapped references and leave unrelated/source state unchanged; Tasks 4/5 test these.

## Workspace and verification conventions

Implementation starts in an isolated canonical worktree from the inspected
`dev` HEAD (`2ea3e334c32159e868aa39e25feaf3e7da5d35b8` at planning time); verify
live HEAD/status first. Use `superpowers:using-git-worktrees` and the-machine's
sibling `StatsPlayground.worktrees/<name>` layout. Carry these two untracked
planning documents into that worktree, preserve their original copies, and
leave the primary checkout's branch/HEAD/unrelated state unchanged.

Read applicable AGENTS.md and execution/TDD skills before code changes. Use
existing installed Node/npm through a command-scoped environment. No package
installation is part of this plan. Confirm dependencies exist before running.

All Git commands use `git --no-pager`; inspect diff stat first and restrict
content diffs with `--no-ext-diff`. Never dump generated files or lock diffs.
Local task commits below occur only in the implementation branch. No pushes,
PRs, merges, or cleanup are included.

Commands below run from the implementation worktree. Every Rust filter must
execute a nonzero test count; zero tests is not success. TS tests use
`node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.app.json <test>`.

## File responsibilities

- New `src-tauri/src/services/project_topology.rs`: bounded metadata read model and pure graph resolution.
- New `src-tauri/src/services/project_group_operations.rs`: authoritative previews, move and cascade deletion publication.
- New `src-tauri/src/services/project_group_history.rs`: cross-table cascade before-images and atomic replay.
- New `src-tauri/src/services/project_group_copy.rs`: typed ID remapping, staged copy and import publication.
- New `src-tauri/src/services/project_group_transfer.rs`: isolated native subset export and validated import staging.
- New `src-tauri/src/models/project_topology.rs`: serialized topology, preview, result, and transfer request contracts.
- New `src/projectPersistence/tableGroups.ts`: revision-bound client operation adapter; no second membership authority.
- New `src/components/directory/tableDirectoryModel.ts` and `TableDirectory.tsx`: typed navigation projection and table/group rendering.
- Existing `Workspace.tsx`: editor activation, dialogs, folder creation/drop integration; no unrelated restructuring.
- Existing catalog, Transform, coordinator, history, command/MCP, localization, and test-runner modules: owning integration points listed per task.

## Shared interfaces

Define camelCase-serialized Rust structs and matching TS types in Task 1:

- `ProjectTopology { epoch, committedRevision, tables, transforms, ownedDocuments, diagnostics }`; table records include ID/name/folder/revision; Transform links include connector ID/revision, input roles/table IDs, and output table ID; ownership records include document ID/kind/table ID/revision.
- `ProjectActionScope = component | descendants`; `ProjectActionPreview { epoch, committedRevision, targetTableId, scope, tableIds, transformIds, ownedDocumentIds, blockers }`. IDs are sorted and deduplicated.
- `ProjectGroupMoveRequest { targetTableId, destinationFolder, expectedTopologyRevision }`.
- `ProjectGroupCopyRequest { targetTableId, destinationFolder, expectedTopologyRevision }`.
- `ProjectGroupCopyResult { tableIds, idMap }`; `idMap` maps each original table/column/connector/document ID to its new ID.
- `ProjectGroupExportRequest { targetTableId, filePath, expectedTopologyRevision }`.
- `ProjectGroupImportRequest { filePath, destinationFolder }`.

Query methods use `epoch`; writes use existing `ProjectWriteContext` and
`ProjectCommit<T>`. Preview member lists are display data, never trusted write
inputs. Commands recompute scope in the writer transaction and require the
preview revision. Delete reuses the existing `delete_dataset` public signature
and adds cascade semantics behind it, retaining result type `()`.

### Task 1: Authoritative metadata topology and operation previews

**Files:** create the two topology modules above; modify `src-tauri/src/services/mod.rs`, `src-tauri/src/models/mod.rs`, `src-tauri/src/services/project_native_service.rs`, `src-tauri/src/services/project_catalog.rs`, `src-tauri/src/services/table_transform_service.rs`, `src-tauri/src/commands/project_commands.rs`, `src-tauri/src/lib.rs`, `src/types/projectPersistence.ts`, `src/services/projectService.ts`, `src/projectPersistence/documentAdapters.ts`.

**Interfaces:** implement `ProjectTopology::component(table_id)`, `ProjectTopology::descendants(table_id)`, `ProjectTopology::preview(table_id, scope)` returning validated sorted scopes. Add native `get_project_topology(epoch)` and `preview_project_table_action(epoch, tableId, scope)` plus matching `projectService` methods. Queries return complete metadata topology at one revision independent of catalog paging.

- [ ] Write `project_linked_groups_topology_*` Rust tests for isolated, linear, branching, Join/Concatenate graphs, missing bindings/outputs, duplicate roles, cycles, empty/failed outputs, and later-page/unhydrated records. Assert `component(B) == [A,B,C]` and `descendants(B) == [B,C]` for A→B→C; document ownership is separate from table reachability.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --features project-v5 --lib project_linked_groups_topology_`; confirm meaningful failures.
- [ ] Implement graph extraction from authoritative Transform documents and `transformBinding:<id>` settings, not generic `dependencies[0]`. Maintain any additive metadata index in the same transaction on create/rerun/rebind/import/replay. Repair older complete records through explicit metadata normalization; never silently delete invalid links.
- [ ] Add `tests/projectTableTopology.test.ts` for typed IPC, project switching, no table-window/analysis-body requests, and complete query results independent of catalog pages; register it in `scripts/projectPersistenceSuites.json`.
- [ ] Run new Rust/TS tests and existing `tests/tableTransformPersistence.test.ts`, `tests/tableTransformRerunPersistence.test.ts`, and `tests/projectCatalogStore.test.ts`; verify no table scans through existing work counters. Commit the focused topology change.

### Task 2: Atomic whole-component moves and folder integrity

**Files:** create `project_group_operations.rs`; modify topology/service/command registrations, `project_catalog.rs`, `project_transaction.rs`, `src/projectPersistence/coordinator.ts`, `src/projectPersistence/tableGroups.ts`, `src/services/projectService.ts`; add `tests/projectTableGroupMoves.test.ts` and native unit tests.

**Interfaces:** `NativeProjectService::move_table_group(context, request) -> ProjectCommit<()>`, command `move_project_table_group`; client `moveTableGroup(targetTableId, destinationFolder, expectedTopologyRevision): Promise<void>` submits through the coordinator. Backend resolves component; child document drags first resolve to their owning table. Folder creation uses existing record patches.

- [ ] Add failing native move tests: A→B and owned graph/analysis/tabulation move to a freshly created nested folder; unrelated X stays put; move to root; duplicate targets; readonly and stale epoch/revision; rollback before commit; retry same operation ID once.
- [ ] Implement one complete move patch and one commit. Guard generic directory patches against partial table-group/child moves, including direct folder rename/move/delete patches and raw Transform changes. A rename-only patch remains valid. Child records inherit the table location.
- [ ] Preserve empty-folder creation and non-destructive folder deletion: promote all contained complete groups to the parent. If older groups span folders, show one explicit normalization destination/action rather than silently normalizing on open. Rebinding/new output that links two folders cannot leave a published component split: creation places new outputs with its component; conflicting existing groups require normalization before linking.
- [ ] In TS tests assert submitted payload contains target/revision/destination, not trusted member lists; only acknowledged commit receipts update all folders. Direct partial record patches must fail without changing any record.
- [ ] Run Rust filter `project_linked_groups_move_`, new TS test, and existing folder/epoch/retry tests. Register new suite and commit.

### Task 3: Directed cascade deletion and cross-table undo/redo

**Files:** create `project_group_history.rs`; modify `project_group_operations.rs`, `project_native_service.rs`, `project_table_lifecycle.rs`, `project_table_retirement.rs`, `project_history_frontier.rs`, `project_catalog.rs`, `src/stores/useHistoryStore.ts`, `src/projectPersistence/documentAdapters.ts`, `src/stores/useWorkspaceSelectionStore.ts`; add `tests/projectTableCascadeDeletion.test.ts` and native tests.

**Interfaces:** `delete_dataset(context, dataset_id)` computes `descendants`; `apply_table_lifecycle(context, id, event_revision, undo)` recognizes a cascade root and replays the whole recorded event. Child lifecycle events cannot be replayed publicly. Add a cross-table event manifest keyed by root ID; do not reuse `project_history_group::children`, which requires one dataset and change-set storage kinds.

- [ ] Write failing native cases: A→B→C delete B preserves A; delete A removes all; A→B and A→D delete B preserves A/D; A+X→B delete A removes B but preserves X. Every case asserts exact owned documents and Transform definitions/bindings/lineage that remain. A child-document delete leaves its table and siblings.
- [ ] Implement one metadata-authorized cascade transaction: retire descendants in reverse dependency order; retain all necessary before-images, column/filter/display state and connector settings; remove producing connectors of deleted outputs. Reject external Report/Workflow references outside scope with actionable blockers. Reject generic record deletion of tables or unlink-only Transform bypasses.
- [ ] Implement one visible history root for the cascade; undo restores parents before descendants, redo retires descendants first. Persist all required before-images; reject replay of internal child events. New edits prune only event-owned redo state. Restore never reintroduces a dangling binding or a half-restored group.
- [ ] Add fault injection after retiring one descendant and before metadata publication, lost-reply replay, close/reopen undo/redo, and unrelated-table frontier tests. Assert all affected IDs/settings appear in the receipt and active editors for deleted descendants close; ancestor editors remain open.
- [ ] Run `project_linked_groups_delete_` and `project_linked_groups_replay_` Rust filters, new TS test, and existing lifecycle/receipt/history frontier tests. Register and commit.

### Task 4: Complete group copies with typed identity remapping

**Files:** create `project_group_copy.rs`; modify topology/contracts, native service/commands, `project_output.rs`, coordinator/transport; add `tests/projectTableGroupCopy.test.ts` and native tests.

**Interfaces:** `NativeProjectService::copy_table_group(context, request) -> ProjectCommit<ProjectGroupCopyResult>`, command `copy_project_table_group`; reusable `remap_group_records(records, id_map)` is schema-aware for every owned document and Transform binding. Shared staging publication accepts preassigned IDs and current source revision.

- [ ] Add failing copy case for chained multi-input transforms with Graph-new layers/camera/hidden groups, all Analysis kinds, Tabulate, filters, display properties, calculated columns, and column-ID references. Assert copied data equivalence and zero internal references to original group IDs.
- [ ] Implement isolated staging and typed remapping of table/column/Transform/document IDs, lineage and binding roles; preserve source data and configuration. Do not use unrestricted string replacement in user-authored text or SQL. Preserve user-defined display names with existing collision allocation. No original history, receipts, or transient render caches are copied.
- [ ] Publish the staged component atomically into the selected folder; revalidate topology revision and project owner before publishing. Cancellation/failure publishes nothing; lost acknowledgement returns the original copied IDs via the receipt rather than producing a second copy.
- [ ] Run `project_linked_groups_copy_`, new TS transport/receipt tests, reopen copied project and rerun a copied Transform to prove bindings address copied inputs. Register and commit.

### Task 5: Self-contained native group export and import

**Files:** create `project_group_transfer.rs`; modify `project_group_copy.rs`, `project_snapshot.rs`, `project_export.rs`, project commands/contracts; add `tests/projectTableGroupTransfer.test.ts` and native tests.

**Interfaces:** `export_project_table_group(epoch, request, cancellation) -> transfer result` produces native `.spprj`; `import_project_table_group(context, request, cancellation) -> ProjectCommit<ProjectGroupCopyResult>` reuses Task 4 remapping/publication. Client flushes its captured write barrier before export; source revision must match request.

- [ ] Add failing native round trip: export a group from a project containing unrelated tables, open exported file using the ordinary v5 reader, validate data/children/bindings, import into another project with overlapping names/IDs, and run an imported Transform.
- [ ] Build the subset from a consistent metadata/data snapshot directly into isolated destination staging. Do not copy the complete source project and then prune unrelated tables, which would leak unrelated data into a transfer artifact. Preserve application schema/engine markers and regenerate only project identity/receipts as required.
- [ ] Validate required dependencies, fsync and publish destination only after success. Cancellation before publish leaves no final partial export; source is unchanged. Import uses typed validation, ID remapping, and one atomic publication. Do not permit single-table `.sptb` project-object export to bypass linked-group scope; ordinary data interchange exports remain distinct.
- [ ] Test future/invalid files, dangling links, destination collisions without overwrite, source mutation/switching during export, readonly source export, cancelled export/import, and retry publication without duplicates. Verify no unrelated table rows enter the exported file.
- [ ] Run `project_linked_groups_transfer_`, new TS barrier/transport tests, and existing export read-barrier/import/migration regressions. Register and commit.

### Task 6: Table-centered directory and group-aware new-folder drag/drop

**Files:** create `src/components/directory/tableDirectoryModel.ts`, `TableDirectory.tsx`, `src/projectPersistence/tableGroups.ts` if not already created; modify `Workspace.tsx`, create `src/components/directory/tableDirectory.css`, modify `useFolderStore.ts`, `useProjectCatalogStore.ts`, `projectFileNaming.ts`, locale JSONs; add `tests/tableDirectoryModel.test.ts`, `tests/tableDirectory.spec.tsx` and its harness.

**Interfaces:** `buildTableDirectory(topology, summaries): TableDirectoryModel` produces folders, bracketed components, ordered tables, owned children, and explicit invalid-link diagnostics; `TableDirectory` accepts existing activation/rename/selection callbacks plus the Task 2 move adapter and Task 3 deletion preview. Domain membership is never inferred from currently hydrated stores.

- [ ] Add failing model tests for table/child ownership, topological peer ordering, multiple inputs without duplicate table rows, later-page summaries, and stable expansion through rename. Assert name `Experiment.sptb` remains literal while a plain `Experiment` receives no synthetic suffix.
- [ ] Add UI tests for both graph builders, every Analysis kind and Tabulate beneath its table; bracket/Transform control opens the existing editor; table and child activation preserve existing editor behavior. Remove extension-only decorations and internal wrong-extension validation while retaining real file-export names and applicable collision behavior.
- [ ] Wire new folder at root and nested folder → automatic rename → drag A, B, a group handle, or an owned graph/analysis to the folder. Every path submits the same whole-component move, visibly moves all peers and owned children, preserves Transform links, and leaves unrelated X. Test dragging back to root and no-op same-folder drop.
- [ ] Reject drops onto table/document rows as reparenting; enforce readonly and stale-session behavior. Failed move keeps the prior tree and shows the error. Folder rename/move/delete preserves whole components; folder deletion promotes contents without deleting them.
- [ ] Show deletion confirmation from descendant preview, listing exactly affected tables/children; selecting B must never label A for deletion. Owned document delete stays independent. Reset selection only for IDs actually deleted.
- [ ] Run new model/UI tests plus existing Workspace/Analysis/Graph-new/Distribution directory/folder tests. Check actual desktop bracket alignment, indentation, idle styling, drag feedback, and localized confirmation. Register and commit.

### Task 7: Application command and MCP parity

**Files:** modify `src/applicationCommands/types.ts`, `projectCommands.ts`, `applicationRuntime.ts`, `tableTransformCommands.ts`, relevant data command handlers, `src/components/workspaceCommandHandlers.ts`, `src-tauri/src/mcp/tools.rs`, `src-tauri/src/project_persistence_harness.rs`; add `tests/applicationCommandTableGroups.test.ts` and native MCP tests.

**Interfaces:** expose `project.previewTableAction`, `project.moveTableGroup`, `project.copyTableGroup`, `project.exportTableGroup`, `project.importTableGroup` through the existing registry and typed schemas; existing table deletion uses the same native cascade as UI. Register native commands and harness dispatch with the same DTOs, operation identities, cancellation, and error mapping.

- [ ] Add failing tests invoking group move and derived-table deletion through application commands and native MCP, then reading actual catalog/table state. Assert same scopes and errors as direct service/UI paths.
- [ ] Route operations through existing coordinator/commit notifications; prohibit direct generic record-patch bypasses, raw partial object export, isolated table-group moves, or Transform unlink/rebind that detaches outputs. Keep private unpublished workflow cleanup separate and scoped to owned staging IDs.
- [ ] Test stale target IDs, foreign project epochs, readonly writes, cancelled staged operations, lost replies, and unloaded groups; no frontend-only store success may be reported before backend acknowledgement.
- [ ] Run new tests, existing application-command project/Transform tests and MCP mutation guard tests. Confirm command schemas and cancellation reach the native boundary. Register and commit.

### Task 8: Enable default v5, regression suite, and desktop acceptance

**Files:** modify `src-tauri/Cargo.toml`, `docs/development.md`, relevant opt-in/default statements in README/docs and release build tests, `scripts/projectPersistenceSuites.json`; extend the real native default-startup coverage. Avoid an implementation-mirroring Cargo-text test.

**Interfaces:** Cargo `default = ["project-v5"]`; ordinary Tauri dev/build/portable builds probe v5 as enabled. Explicit legacy compatibility builds use `--no-default-features` where supported, never unintentionally in release/portable scripts.

- [ ] Add a failing real default-startup check and inspect the resolved Cargo feature graph; configuration text alone is insufficient. Audit CI/portable args for suppressed default features. Update docs and remove obsolete mandatory opt-in wording without changing historical reports.
- [ ] Set Cargo defaults only after Tasks 1–7 checks pass. Build `project_persistence_contract` with `--features perf-harness` (no explicit project-v5) and verify native draft/open/autosave/reopen uses v5. Separately test explicit no-default-feature compilation if retaining the fallback.
- [ ] Run `npm run build`, focused new contracts/UI suites, `npm run test:project-v5-budget`, and relevant native Rust tests. Build the harness with `cargo build --manifest-path src-tauri/Cargo.toml --example project_persistence_contract --features perf-harness`; set `STATSPG_PERSISTENCE_HARNESS` to its verified executable path and run `npm run test:project-persistence`. Run existing release/app-version/portable tests. Classify pre-existing unrelated failures with baseline evidence; never claim unexecuted suites passed.
- [ ] Run existing v5 performance budget on the changed metadata/navigation path; compare cold open, catalog pagination and no-row-read counters. No new all-table hydration or repeated body parsing on navigation is acceptable.
- [ ] Launch actual default desktop development build. Exercise new-folder/group drag, chain and Join deletion with undo/redo, individual child deletion, copy and native export/import after restart. Record screenshots and exact command/test counts in an execution ledger; offer the built UI for manual acceptance without publishing a release.
- [ ] Perform whole-branch code review under `superpowers:requesting-code-review`, resolve findings, inspect final bounded diff and Git status, commit verified changes, and report remaining platform limitations. No automatic merge/push/PR.

## Self-review coverage

- Default build/persistence: Task 8; ownership/name UI: Task 6; authoritative complete topology and older metadata: Task 1.
- Folder creation/drag/root/promotion and atomic location: Tasks 2/6; stale previews/receipts/readonly: Tasks 1–7.
- Directed child deletion, external blockers, Transform cleanup and cross-table replay: Task 3; direct command enforcement: Tasks 2/3/7.
- Complete typed copy and export/import: Tasks 4/5; existing migration, startup/recovery, catalogs and performance: Tasks 1/5/8.
- All five Review Focus cases have explicit owning tests. No implementation is claimed by the creation of this plan.
