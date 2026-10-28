# Persistent Projects and Automatic Incremental Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open v5 projects from metadata, browse bounded table windows, and persist edits directly to project-owned DuckDB storage without routine full-project serialization.

**Architecture:** One project session owns a persistent or recoverable-draft database, one serialized writer and bounded readers. Transactions commit data, documents, directory metadata, history and idempotency receipts together. A frontend coordinator tracks pending operations separately from backend committed revisions and exposes a save barrier; v5 remains opt-in until every mutation producer is covered.

**Tech Stack:** Existing Rust/Tauri v2/DuckDB, React/TypeScript/Zustand, tsx tests, Playwright CT and the release perf-harness; no new database or queue dependency.

**Spec:** [Approved Issue 282 design](../specs/2026-10-16-issue-282-persistent-project-design.md).

## Global Constraints

- Issue #282; worktree `282-persistent-project`; branch `codex/282-persistent-project`; latest implementation base `3a362f6ebed9dd9f2435aac56cdf5bd75a84052f` (PR #283); PR target `dev`. Original investigation/baseline checks used `e0f840cb58296a5ed3f7661c3f7cc1dd6018417a`; preserve that provenance.
- Application format `5.0.0`, extension `.spprj`; file signatures distinguish native DuckDB, legacy ZIP and legacy JSON. Foreign/future databases are rejected before schema writes.
- Automatic persistence is the selected save model. Closing does not discard committed edits; undo/redo remain available.
- One serialized writer; readers share database ownership. Persistent storage is never owned by an auto-deleting `TempDir`.
- Data, document bodies/summaries, metadata, generations and history commit atomically. Do not nest `BEGIN`/`COMMIT` in existing engine methods.
- Presentation coalescing window maximum 250 ms, without crossing a command, dependency, undo/redo or save barrier.
- Existing table window size 500 rows; per-viewport limits 5,000 rows / 64 MiB estimated; add a bounded aggregate retained-viewport budget.
- Ordinary open/save/close perform zero archive row restoration, zero archive writing, zero full-database copies and zero all-table anchor rebuilds.
- Valid natural anchors persist; unfiltered counts come from committed metadata. Full sort/filter preparation remains globally correct, cancellable and separately measured.
- Legacy migration preserves the original and publishes a distinct `-v5.spprj`; first naming preserves project UUID; Save As changes project UUID while preserving internal artifact IDs.
- Keep external DataLinks under #263; do not import remote databases on open. Initial writable v5 support is for qualified local storage.
- Preserve latest-dev Graph Builder-new v3 layers, complete point/line/time-series options, camera, hidden groups, empty layers and v1/v2 migration. Preserve upstream `serde_json/float_roundtrip` and `memmap2` dependencies; regenerate only intentional dependency changes.
- All new Tauri commands delegate to services, register in `lib.rs`, and have camelCase-mirrored Rust/TS models and wrappers. Preserve existing path-authorization and overwrite-confirmation boundaries.
- Keep v5 opt-in until correctness, final review, performance and native acceptance gates pass. No partial persistence may be labeled saved.
- Commit/push/PR publication follows the existing acceptance gate; task checkpoints below do not authorize commits or publication before acceptance.
- Current local edits include the approved uncommitted spec and the repaired baseline test. Preserve both; do not reset this worktree to reconstruct a clean baseline.

## Review Focus

1. A write commits but its IPC acknowledgement is lost: retry must return the original receipt without applying the mutation twice (Task 2).
2. A late acknowledgement or body fetch arrives after switching projects: it must not mutate the new session or revive deleted documents (Tasks 6, 9, 10).
3. A document-only pending edit is followed by Ctrl+S/close while another edit arrives: the captured sequence must drain without falsely reporting later edits as saved (Task 6).
4. Snapshot publication succeeds but destination reopen fails: preserve both files and report the created destination accurately (Task 11).
5. A single-cell edit routes through full-table history/anchor work: history and I/O counters must expose the regression even if the UI responds quickly (Tasks 4, 13).

---

## File and interface map

New modules have focused ownership; register Rust modules in `services/mod.rs`,
`engine/mod.rs` and `models/mod.rs` in the task creating them. Avoid moving
unrelated sections out of the existing large engine/Workspace files.

| New file | Responsibility |
| --- | --- |
| `src-tauri/src/engine/database_storage.rs` | Shared persistent/draft/temporary storage owner |
| `src-tauri/src/services/project_database.rs` | v5 session ownership, connection admission, shutdown |
| `src-tauri/src/services/project_schema.rs` | v5 creation, bounded format/header checks, explicit schema upgrades |
| `src-tauri/src/services/project_transaction.rs` | Writer transactions and durable receipts |
| `src-tauri/src/services/project_catalog.rs` | Summaries, document bodies, settings and display metadata |
| `src-tauri/src/services/project_drafts.rs` | Recoverable draft registry and recovery offers |
| `src-tauri/src/services/project_snapshot.rs` | Closed-database snapshots and atomic publication |
| `src-tauri/src/services/project_migration.rs` | One-time legacy import into a new v5 file |
| `src-tauri/src/models/project_persistence.rs` | Shared v5 request/result contracts |
| `src/projectPersistence/coordinator.ts` | Pending sequence, coalescing, acknowledgement and barriers |
| `src/projectPersistence/documentAdapters.ts` | Typed document/settings writes, hydration suppression |
| `src/stores/useProjectCatalogStore.ts` | Summary/body states and revision fences |
| `src/components/ProjectPersistenceStatus.tsx` | Saved/pending/error status and retry |
| `src-tauri/src/perf_project_v5.rs` | v5 lifecycle/I/O measurement and crash scenarios |
| `src-tauri/examples/project_persistence_v5.rs` | Process-isolated fixture/probe entrypoint |

Shared model decisions used by later tasks:

```text
ProjectEpoch = u64
ProjectHeader { project_id: String, format_version: String,
  minimum_reader: u32, minimum_writer: u32, committed_revision: u64,
  created_at: String, engine_version: String, storage_version: String }
ProjectWriteContext { operation_id: String, expected_epoch: u64,
  expected_revision: u64, request_digest: String, document_revisions: Vec<DocumentRevision>,
  dataset_generations: Vec<DatasetGeneration> }
ProjectCommit<T> { operation_id: String, epoch: u64, committed_revision: u64,
  value: T, changed_dataset_generations: Vec<DatasetGeneration>,
  changed_document_revisions: Vec<DocumentRevision> }
DocumentRevision { id: String, revision: u64 }
DatasetGeneration { id: String, generation: u64 }
ProjectDocumentSummary { id: String, kind: ProjectDocumentKind, name: String,
  folder: String, revision: u64, dependencies: Vec<String> }
ProjectDocumentBody { summary: ProjectDocumentSummary,
  schema_version: u32, body: serde_json::Value }
CatalogPage { items: Vec<ProjectDocumentSummary>, next_cursor: Option<String>,
  committed_revision: u64 }
CatalogPageRequest { after: Option<String>, limit: usize }
ProjectOpenSummary { project: ProjectInfo, header: ProjectHeader, epoch: u64,
  writable: bool, directory: CatalogPage, settings_revision: u64 }
ProjectPersistenceStatus { epoch: u64, committed_revision: u64, writable: bool }
DocumentWrite { expected_revision: Option<u64>, document: ProjectDocumentBody }
ProjectSettingWrite { key: String, expected_revision: Option<u64>, value: Value }
ProjectRecordPatch { documents: Vec<DocumentWrite>, deleted_document_ids: Vec<String>,
  settings: Vec<ProjectSettingWrite>, directory_moves: Vec<DirectoryMove>,
  created_folders: Vec<String>, deleted_folders: Vec<String> }
DirectoryMove { id: String, expected_revision: u64, folder: String }
HistoryPageRequest { dataset_id: Option<String>, after: Option<String>, limit: usize }
ProjectHistorySummary { id: String, dataset_id: String, operation: String,
  applied: bool, generation: u64 }
ProjectHistoryPage { items: Vec<ProjectHistorySummary>, next_cursor: Option<String>,
  committed_revision: u64 }
```

`ProjectDocumentKind` includes table, graph, graphNew, analysis, report, tabulate,
workflow, transform and snapshot. Folder records include empty folders. Filters,
workflow bindings/runs, lineage, display metadata and history navigation are
explicit persisted owners, not arbitrary objects swept from frontend stores.
All model types live in `project_persistence.rs` and mirror into
`src/types/projectPersistence.ts`; existing domain validators remain authoritative.

Commands carry a `ProjectWriteContext` through the existing command path; do not
create a second mutation engine. Backend receipts supply v5 revisions, while the
legacy path retains its existing revision behavior until migrated. Read requests
carry epoch/revision fences but never fabricate placeholder complete documents.

## Execution and verification conventions

Run every command with the worktree as explicit cwd. Resolve Node/Cargo using
the active environment before execution; do not assume interactive-shell PATH.
The commands below use `node`/`cargo` as resolved executable placeholders.

`TS(file)` means `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.app.json file`.
`RS(filter)` means `cargo test --manifest-path src-tauri/Cargo.toml filter -- --nocapture`.
Rust verification must list a nonzero executed test count; exit 0 with zero tests
is not evidence. Focused TS tests must print their named completion marker.
Do not add tests that merely search source strings for the new architecture.

For each task, preserve the failing assertion and passing run in an execution
ledger at `docs/superpowers/plans/2026-10-16-issue-282-execution.md`, recording
changed paths, command, result, source state, review status and residual gaps.
The ledger also carries the mutation-owner inventory from Tasks 5 and 7. Record
checkpoint-ready state after green; commit only when repository acceptance
authorizes it. Keep generated dependency/build/test paths in an exact disposable
allowlist, separate from benchmark evidence and user projects.

## Task 1: Own persistent and recoverable database sessions

**Files:** Create `engine/database_storage.rs`, `services/project_database.rs`,
`services/project_schema.rs`, `models/project_persistence.rs` and module entries;
modify `engine/duckdb_engine.rs`, `state.rs`, `Cargo.toml`.

**Interfaces:**
- Produce `DatabaseStorage::{Temporary(Arc<TempDir>), RecoverableDraft(PathBuf), PersistentProject(PathBuf)}` behind `Arc`.
- Produce `ProjectDatabase::create(path: &Path, draft: bool) -> Result<Self, AppError>` and `ProjectDatabase::open(path: &Path, read_only: bool) -> Result<Self, AppError>`.
- Produce `ProjectDatabase::header() -> Result<ProjectHeader, AppError>`, `epoch() -> u64`, and `shutdown() -> Result<(), AppError>`.
- Split engine schema creation from connection opening. Preserve legacy `new_in_memory()` and clone behavior for current tests; v5 open never invokes its unconditional DDL/backfills.
- `ProjectDatabase` owns the sole `Arc<Mutex<DuckDbEngine>>` writer. The transitional `AppState.db` facade, if retained for legacy callers, aliases that same Arc; it must not create a second writer or distinct storage owner. Staged publication updates the database facade and navigation/tabulate readers together under the existing lifecycle lock order. Tasks 4/5 migrate v5 writes through `commit` before enabling the format.

- [ ] Write `project_database` Rust tests: create/drop/reopen preserves a stored table and UUID; dropping the last clone preserves persistent files; temporary engines still clean owned temporary directories; read-only rejects writes; duplicate ownership is rejected; opening foreign/future DB leaves its schema/content unchanged.
- [ ] Run `RS(project_database)` and retain expected failures for missing session/format behavior.
- [ ] Implement shared storage lifetime, bounded header detection and v5 creation; use native DuckDB read-only configuration and an application ownership guard bound to canonical file identity, including symlink aliases. Add a default-disabled Cargo feature `project-v5` for experimental entrypoints; recognizing an existing v5 file must produce an explicit capability error when disabled.
- [ ] Run `RS(project_database)` and existing engine clone/open tests. Include bounded ZIP/JSON signature detection and exact format `5.0.0` assertions; require no automatic deletion of persistent/draft paths.
- [ ] Record green evidence, default-disabled behavior and checkpoint-ready diff in the ledger.

## Task 2: Introduce a single transaction owner and durable receipts

**Files:** Create `services/project_transaction.rs`; modify `project_database.rs`,
`models/project_persistence.rs`, `services/save_coordinator.rs`, `state.rs`.

**Interfaces:** Consume Task 1 storage and models. Produce
`ProjectDatabase::commit<T: Serialize + DeserializeOwned>(&self, context: &ProjectWriteContext, apply: impl FnOnce(&DuckDbEngine) -> Result<T, AppError>) -> Result<ProjectCommit<T>, AppError>`;
`ProjectDatabase::committed_revision() -> Result<u64, AppError>`;
and `ProjectDatabase::with_reader<T>(&self, epoch: u64, read: impl FnOnce(&DuckDbEngine) -> Result<T, AppError>) -> Result<T, AppError>`.
Only the commit boundary owns `BEGIN`/`COMMIT` for v5 writes. No writer may
reacquire the writer mutex from inside its callback.

- [ ] Write `project_transaction` tests with real DuckDB: injected failure rolls back two data changes plus header revision; successful operation advances once; stale revision/epoch/generation rejects before mutation; duplicate operation with same request digest returns the original serialized result after reopen; same ID/different digest rejects; lost-ack retry applies once.
- [ ] Run `RS(project_transaction)` and capture the expected failing guarantees.
- [ ] Implement receipt schema, canonical typed-request digest binding, precondition checks, transaction rollback and result serialization before commit. Validate the current session epoch first, then look up matching receipts before rejecting an otherwise stale retried revision. Hash normalized typed operation/payload/preconditions with SHA-256 and sorted object keys, excluding the session epoch so a retry can rebind after recovery; the backend recomputes and checks the submitted digest. Key receipts by project UUID and operation ID. Store durable result/revision independently of runtime epoch and project the current validated epoch into replay acknowledgements. Keep receipts durable for the project lifetime in initial v5.
- [ ] Run `RS(project_transaction)` plus `RS(save_coordinator)`; use test-only injected failpoints, including commit error and post-commit lost acknowledgement. Verify cancellation after commit reports the receipt rather than claiming rollback.
- [ ] Record atomicity and replay evidence; mark the transaction interface stable for dependent tasks.

## Task 3: Persist catalog, document bodies and project settings

**Files:** Create `services/project_catalog.rs`; modify `project_schema.rs`,
`project_persistence.rs`, `models/project.rs`; add mirrored `src/types/projectPersistence.ts`.

**Interfaces:** Produce `ProjectCatalog::new(engine: &DuckDbEngine)`;
`list(request: &CatalogPageRequest) -> Result<CatalogPage, AppError>`;
`get_document(id: &str, expected_revision: u64) -> Result<ProjectDocumentBody, AppError>`;
`apply_patch(patch: &ProjectRecordPatch) -> Result<(), AppError>` inside Task 2's transaction;
`list_history(request: &HistoryPageRequest) -> Result<ProjectHistoryPage, AppError>`;
and `describe_table(id: &str) -> Result<DatasetMeta, AppError>` using stored counts.
Catalog pages default to 200 items with maximum 1,000; cursor binds committed
catalog revision and stable `(kind, id)` ordering, so mutations require restart.

- [ ] Write `project_catalog` tests: body/summary atomic update, unknown kind/schema rejected, rename/move/delete without body hydration, empty-folder retention, Unicode names, page boundary correctness, stale body revision rejection, paged history summary, exact dataset metadata without scanning data tables.
- [ ] Run `RS(project_catalog)` and preserve failures.
- [ ] Implement catalog/settings/display schemas and per-kind existing validators. Store graphNew/analysis/report/tabulate/workflow/transform bodies and associated dependencies; keep large history data in existing DB history storage. Register explicit persisted ownership for filters, bindings, runs, lineage and display properties.
- [ ] Run `RS(project_catalog)`; inject failure between document and summary writes through Task 2 and verify neither publishes. Test catalog paging while another operation commits: return a revision conflict, never gaps/duplicates disguised as a stable listing.
- [ ] Record schema, catalog/body separation and all persisted owners in the ledger.

## Task 4: Make ordinary edits and history genuinely incremental

**Files:** Modify `services/table_delta_mutation.rs`, `table_mutation_coordinator.rs`,
`table_history_archive.rs`, `natural_row_order.rs`, `engine/duckdb_engine.rs`,
`services/data_service.rs`, `commands/data_commands.rs`, `commands/history_commands.rs`;
extend tests in these modules.

**Interfaces:** Consume Task 2 commit boundary. Produce
`update_cells_compact_in_transaction(engine: &DuckDbEngine, dataset_id: &str, updates: &[CellUpdate], expected_generation: u64) -> Result<TableMutationEffects<()>, AppError>`
in `table_delta_mutation.rs`; add `_in_transaction` variants for existing compact
row/column mutations and history navigation. Public legacy methods may keep their
own transaction wrapper; v5 dispatch invokes only transaction-neutral variants.

- [ ] Write real-engine tests: one edit in a 100k-row table captures only affected before/after cells, preserves `_row_id`/column UUID/natural order, advances one generation and history cursor, and undo/redo work after reopen. Inject history-write failure and require the cell value and generation to remain unchanged. Record `full_before_table_copies == 0` and `full_anchor_rebuilds == 0` for a plain cell edit.
- [ ] Run `RS(project_v5_small_mutations)` for RED; explicitly exercise `update_cells_if_generation`, whose current generic coordinator creates a whole-table before-image.
- [ ] Implement affected-cell delta history and transaction-neutral wrappers. Value-only edits do not rebuild positional anchors. Local row operations update bounded anchors using current compact helpers. Treat genuinely global formula recomputation, type conversion and full-table transforms as measured bulk work; do not silently route plain cell/paste edits to legacy full snapshots.
- [ ] Run `RS(project_v5_small_mutations)`, `RS(table_delta_mutation)`, `RS(table_history_archive)` and calculated-column affected tests. Include bounded paste, inserted middle rows, nulls, exact integers, date/time values, stale generations and undo-after-redo-branch behavior.
- [ ] Record the migrated mutation routes and remaining explicit bulk routes; no default enablement yet.

## Task 5: Publish imports, SQL results, transforms and workflow outputs atomically

**Files:** Modify `services/io_service.rs`, `data_service.rs`, `table_transform_service.rs`,
`workflow_executor.rs`, `workflow_document_executor.rs`, `calculated_column_service.rs`,
`engine/duckdb_engine.rs`, `commands/io_commands.rs`, `commands/project_commands.rs`,
`commands/mutation_guard_coverage.rs` and `mcp/tools.rs`.

**Interfaces:** Existing typed operations consume Task 2 context and return
`ProjectCommit<T>` in v5. `WorkflowRunCommitPacket` remains the domain payload
inside the receipt, not a second publication step. `ProjectCatalog::apply_patch`
publishes all operation-owned documents/directory entries on that same writer.

- [ ] Write `project_v5_outputs` service tests: direct CSV import creates table/counts/folder/history in one commit; conversion error/cancel exposes nothing; source-file changes fail cleanly; SQL materialization and transform outputs reopen exactly; workflow commit lost-ack replay returns the same packet and IDs without duplicate tables.
- [ ] Run `RS(project_v5_outputs)` and corresponding existing workflow/import tests for RED.
- [ ] Split transaction-owning import/materialization helpers, then route operation publication through Task 2. Keep long compute cancellable outside the publication transaction where possible; staged tables remain internal and inaccessible, tracked by operation ID, and are published only after source-generation checks. Staging cleanup/recovery must never delete another operation's tables. No externally visible output may precede its catalog/history commit.
- [ ] Run `RS(project_v5_outputs)`, affected `workflow_executor`, `table_transform_service`, `io_service` and mutation-guard suites. Test source generation changing during compute, failure after staging but before publication, and persistent recovery after process interruption.
- [ ] Inventory every backend mutating command/MCP tool in the execution ledger: entrypoint, transaction owner, durable data/document/history effects, replay ID, test. A bypass blocks Task 14.

## Task 6: Add frontend persistence queue, acknowledgements and Ctrl+S barrier

**Files:** Create `src/projectPersistence/coordinator.ts`,
`tests/projectPersistenceCoordinator.test.ts`; modify `src/services/projectService.ts`,
`src/types/projectPersistence.ts`, `src/stores/useProjectStore.ts`,
`src/applicationCommands/runtime.ts`, `applicationRuntime.ts`, `projectCommands.ts`,
`types.ts`, `src/components/workspaceCommandHandlers.ts`, `tests/useProjectStore.saveLifecycle.test.ts`.

**Interfaces:** Produce `createProjectPersistenceCoordinator(deps: PersistenceDependencies): ProjectPersistenceCoordinator` with
`enqueueDocument(write: DocumentWrite): number`,
`submit<T>(operation: ProjectOperation<T>): Promise<ProjectCommit<T>>`,
`captureBarrier(): number`, `flushThrough(sequence: number): Promise<void>`,
`snapshot(): PersistenceSnapshot`, and `close(): Promise<void>`.
`PersistenceSnapshot` carries epoch, pending sequence, acknowledged sequence,
committed revision, status (`pending|saving|saved|error`) and safe error detail.
`ProjectOperation<T>` wraps a typed existing command and its normalized digest;
it is not a free-form SQL execution API. `PersistenceDependencies` injects clock,
timer, typed transport and event subscription for deterministic tests.

- [ ] Write tests asserting last-write coalescing at 250 ms maximum, no coalescing across command/undo/save barriers, save captures sequence N while N+1 stays pending, failed commit retains edits, duplicate acknowledgement does not advance twice, old epoch acknowledgement is ignored, and post-commit retry uses the same operation ID/digest.
- [ ] Run `TS(tests/projectPersistenceCoordinator.test.ts)` for RED.
- [ ] Implement one ordered project queue; send operation context via existing typed commands. Adopt backend committed revision for v5 rather than independently incrementing it in TS. Ctrl+S drains pending effects and waits through the captured sequence without archive snapshot collection or forcing checkpoint. Preserve legacy behavior behind format dispatch.
- [ ] Run the new test plus `tests/useProjectStore.saveLifecycle.test.ts`, `tests/applicationCommandSaveSnapshot.test.ts`, `tests/applicationCommandProject.test.ts` and `tests/workspaceCommandHandlers.test.ts`; verify confirmation and cancellation still bind exact request IDs.
- [ ] Record coordinator state transitions and barrier evidence; keep errors visible and retryable.

## Task 7: Route document, directory and presentation edits through persistence

**Files:** Create `src/projectPersistence/documentAdapters.ts` and
`tests/projectPersistenceAdapters.test.ts`; modify `src/stores/documentStore.ts`,
`useGraphBuilderStore.ts`, `useGraphBuilderNewStore.ts`, `useAnalysisStore.ts`,
`useReportStore.ts`, `useTabulateStore.ts`, `useWorkflowStore.ts`,
`useTableTransformStore.ts`, `useFolderStore.ts`, `useDatasetFilterStore.ts`,
`useHistoryStore.ts`; modify domain handlers under `src/applicationCommands/`
(`graphCommands.ts`, `analysisCommands.ts`, `reportCommands.ts`, `tabulateCommands.ts`,
`tableTransformCommands.ts`, `tableCommands.ts`) and their direct UI callers.

**Interfaces:** Produce `applyCommittedProjectEffects(commit: ProjectCommit<unknown>): void`,
`persistDocumentChange(kind: ProjectDocumentKind, id: string, expectedRevision: number): Promise<void>`,
and `hydrateProjectDocument(document: ProjectDocumentBody): void`.
Hydration applies projections under an explicit no-enqueue scope. Domain adapters
construct typed patches, not arbitrary serialized Zustand snapshots.

- [ ] Write adapter tests for each document kind, folder rename/delete (including unloaded items and empty folders), filters, display properties, workflow definitions/runs/bindings, snapshot metadata, undo and redo. Reopen through a real persisted fixture/IPC service boundary to prove the acknowledged body was stored, not merely queued.
- [ ] Run `TS(tests/projectPersistenceAdapters.test.ts)` for RED; use actual stores and adapters, replacing only native transport with the tested service contract.
- [ ] Route mutating store actions and direct UI presentation paths to Task 6; apply backend results as projections. Preserve analysis presentation revision versus statistical configRevision semantics and don't recompute statistics for axis changes. Multi-artifact effects belong to one backend operation, never a trail of independent store subscriptions.
- [ ] Run the new tests and existing analysis/graph/workflow/report project contract suites, including `tests/graphNewLayersProjectRoundTrip.test.ts` and `tests/graphNewLayers.test.ts` from latest dev. Preserve v3 full options, hidden groups, camera and empty layers plus v1/v2 normalization. Inject hydration, rejected revision, failed rename, and late body fetch after delete; verify no feedback loop or lost pending edit.
- [ ] Complete the frontend mutation inventory in the ledger with direct UI, keyboard, MCP and workflow entrypoints. Source-coverage inspection supplements behavioral cases; no unowned persistence route can pass the gate.

## Task 8: Expose catalog/body IPC and metadata-only project opening

**Files:** Modify `project_service.rs`, `project_commands.rs`, `lib.rs`,
`models/project_persistence.rs`, `state.rs`, `services/project_catalog.rs`,
`src/services/projectService.ts`, `src/types/project.ts`, `src/types/projectPersistence.ts`;
create `tests/projectPersistenceContracts.test.ts`.

**Interfaces:** Produce backend service methods and Tauri wrappers:
`open_project_v5(file_path: String, read_only: bool) -> ProjectOpenSummary`,
`list_project_catalog(epoch: u64, request: CatalogPageRequest) -> CatalogPage`,
`get_project_document(epoch: u64, id: String, expected_revision: u64) -> ProjectDocumentBody`,
`list_project_history(epoch: u64, request: HistoryPageRequest) -> ProjectHistoryPage`,
`commit_project_records(context: ProjectWriteContext, patch: ProjectRecordPatch) -> ProjectCommit<()>`,
and `get_project_persistence_status(epoch: u64) -> ProjectPersistenceStatus`.
`ProjectPersistenceStatus` exposes committed revision/read-only state, not local
filesystem paths. All return repository-standard `Result<_, AppError>`.

- [ ] Write `project_v5_open` Rust tests: directory/settings/counts restored with row-restore/archive-write/full-copy/all-table-anchor counters all zero; malformed catalog leaves existing live session unchanged; v5 opt-in policy is honored; registration/wrapper contract round-trips camelCase values.
- [ ] Run `RS(project_v5_open)` and `TS(tests/projectPersistenceContracts.test.ts)` for RED.
- [ ] Implement staged session open, lightweight catalog validation and bounded first directory page. Publish the new session only after validation; never route v5 to archive.restore_tables. Keep legacy migration on Task 12's explicit flow and use separate open-result types for legacy versus catalog mode.
- [ ] Run focused tests plus relevant `project_service`/command coverage; include a project with large history before-images and document bodies proving those payloads are not hydrated at catalog open.
- [ ] Record end-to-end open payload size, forbidden-work counters and staged replacement behavior.

## Task 9: Hydrate documents on demand and convert catalog consumers

**Files:** Create `src/stores/useProjectCatalogStore.ts`,
`tests/projectCatalogStore.test.ts`, `tests/projectLazyHydration.spec.tsx` and
`tests/ProjectLazyHydrationHarness.tsx`; modify `src/components/Workspace.tsx`,
`HistoryPanel.tsx`, the inline directory/folder rendering in `Workspace.tsx`,
`src/applicationCommands/projectCommands.ts`, `src/workflow/projectDependencyGraph.ts`,
domain stores from Task 7 and project inspect/list/get adapters.

**Interfaces:** Produce catalog store actions `installOpenSummary(summary)`,
`loadNextPage(): Promise<void>`, `ensureDocument(id: string): Promise<ProjectDocumentBody>`,
`invalidateDocument(id: string, revision: number): void`, `reset(epoch: number): void`.
Summary state is separate from `unloaded|loading|ready|error` body state.

- [ ] Write real-store tests for opening 1,000 summaries without body loads, selecting one item loads one body, concurrent selection deduplicates loads, source revision invalidates bodies, stale project/deleted-item responses are discarded, paged catalog mutations restart consistently. Add CT showing accurate names/counts/folders before body arrival and recoverable load errors.
- [ ] Run `TS(tests/projectCatalogStore.test.ts)` and focused CT for RED.
- [ ] Replace eager complete-document assumptions in directory, selection, dependency graph, rename/delete, inspect/list and get. Fetch paged history only when shown. Update Workspace open lifecycle to install summaries rather than hydrate all stores; opening the directory triggers zero analysis execution. Unloaded dependencies retain their recorded IDs and validity state.
- [ ] Run new checks plus analysis/workflow/project contracts and existing graph round-trip tests. Assert actual rendered directory order/content and selected report recovery, not just store flags; use module-level CT harnesses.
- [ ] Record all converted consumers and any remaining eager body paths; remaining eager open paths block release.

## Task 10: Bound viewport retention and reuse persisted navigation/counts

**Files:** Modify `engine/duckdb_engine.rs`, `table_navigation_service.rs`,
`natural_row_order.rs`, `src/components/DataTableView.tsx`,
`src/utils/tableWindowCache.ts`, `src/stores/useTableViewportStore.ts`;
create `src/projectPersistence/viewportBudget.ts`, `tests/projectViewportBudget.test.ts`;
extend `tests/tableViewport.test.ts`, `tableWindowCache.test.ts`,
`dataTableScroll.spec.tsx`, `dataTableCounts.spec.tsx` and backend navigation tests.

**Interfaces:** Produce `createViewportBudget({ maxRows: 5000, maxBytes: 67108864, maxRetainedViewports: 2 })` with `acquire(viewportId)`, `release(viewportId)` and admission/eviction notifications. Initial aggregate cap is two retained viewports: 10,000 rows / 128 MiB estimated; retain active viewports preferentially and release inactive LRU entries.
Use existing generation/query signatures for filtered totals and sessions.

- [ ] Write tests proving natural first/last windows use saved counts/anchors, repeated scroll does not recount, generation changes invalidate caches, 100 tab switches stay within aggregate budgets, and stale navigation after project switch cannot paint. Compare actual sorted row sequence with known nontrivial fixture order.
- [ ] Run `RS(project_v5_navigation)` and the new/existing TS window tests for RED.
- [ ] Use committed unfiltered metadata counts; cache filtered counts with prepared sessions; keep first-sort preparation asynchronous/cancellable. Reuse valid anchor manifests and limit repair to the requested dataset. Add aggregate viewport eviction; keep 500-row requests and 5,000-row/64-MiB local limits.
- [ ] Run focused navigation/CT tests including distant jumps, equal sort keys, inserted row order, wide strings, resize/zoom and cancelled prefetch; verify no per-scroll full count or viewport-local fake sort.
- [ ] Record query plans and separate first preparation from ready-window costs.

## Task 11: Close/switch barriers, recoverable drafts and consistent snapshots

**Files:** Create `services/project_drafts.rs`, `project_snapshot.rs`;
modify `project_database.rs`, `project_service.rs`, `save_coordinator.rs`,
`state.rs`, `services/streaming_project_writer.rs` (extract/reuse OS replacement),
`services/graph_new_service.rs`, `graph_new_cache.rs`, `graph_new_layers_cache.rs`,
`src/components/workspaceCommandHandlers.ts`, `src/stores/useProjectStore.ts`,
`src/components/Workspace.tsx`; add `tests/projectLifecycleV5.test.ts`.

**Interfaces:** Produce `ProjectDraftRegistry::create(registry_root: &Path) -> Result<ProjectDatabase, AppError>`,
`list_recoverable(registry_root: &Path) -> Result<Vec<DraftDescriptor>, AppError>`,
`mark_named(registry_root: &Path, project_id: &str) -> Result<(), AppError>`,
`ProjectDatabase::prepare_close(epoch: u64) -> Result<(), AppError>`,
`ProjectSnapshotService::save_as(source: &ProjectDatabase, destination: &Path, first_naming: bool) -> Result<ProjectOpenSummary, AppError>`;
frontend `closeProjectV5()` drains Task 6 then invokes native close, and
`switchProjectV5(path)` stages/open-validates before releasing the old session.
`DraftDescriptor` contains project UUID, display name and an opaque recovery ID;
its internal registry entry stores the authorized `PathBuf`. It exposes no raw
filesystem path to the frontend. Registry updates use atomic file replacement.

- [ ] Write Rust/TS lifecycle tests: failed pending-document flush keeps old project open; close joins readers and releases locks; unnamed draft survives process restart; first naming preserves UUID; Save As assigns a new UUID but preserves artifact IDs; source remains unchanged; overwrite/copy/flush/replace/reopen failures preserve correct files and active path.
- [ ] Run `RS(project_v5_lifecycle)`, `RS(project_snapshot)`, `TS(tests/projectLifecycleV5.test.ts)` for RED.
- [ ] Implement orderly shutdown and idle checkpoint scheduling without checkpoint per edit/Ctrl+S. Snapshot only a checkpointed, closed source after all handles/jobs release it; validate and flush a sibling temporary destination including its new header, atomically publish and reopen. Save As scopes subsequent receipts to its new UUID; first naming retains its UUID and receipts. If publication succeeded but reopen failed, preserve both files and expose that precise outcome. Never hard-link projects or delete WAL manually.
- [ ] Run failure-injection matrix, same-path/alias destination guards, read-only/WAL recovery cases and failed-switch cases. Release/join new graph sessions and memory-mapped layer caches before claiming all handles closed; prevent cross-project cache reuse when internal dataset IDs/generations match but project UUID/epoch differs. No unchanged ordinary close may call full-copy/archive paths. Keep read-only WAL recovery failures explicit rather than performing hidden writes.
- [ ] Record draft locations through environment paths, lifecycle allowlist and snapshot atomicity evidence. Unknown drafts/recovery files are never disposable cleanup items.

## Task 12: Migrate legacy archives without replacing their originals

**Files:** Create `services/project_migration.rs`; modify `project_service.rs`,
`project_table_restore.rs`, `spprj_archive.rs`, `project_commands.rs`,
`src/components/Workspace.tsx`, `src/services/projectService.ts`,
`src/i18n/locales/en.json`, `zh-CN.json`, `zh-TW.json`;
add `tests/projectMigrationFlow.test.ts`.

**Interfaces:** Produce `ProjectMigrationService::migrate(source: &Path, destination: &Path, progress: &MigrationProgressCallback) -> Result<ProjectOpenSummary, AppError>` and an explicit preflight result identifying legacy format, destination collision and required capability. Default filename uses `-v5.spprj`; overwrite source is rejected.

- [ ] Write `project_v5_migration` tests for supported v1–v4 fixtures, special scalars, empty folders, filters, calculated columns, graphs/new graphs, analyses, reports, tabulates, workflow outputs/bindings and undo/redo cursors. Hash source before/after; inject malformed table/history and cancellation to prove preservation of source/live project.
- [ ] Run `RS(project_v5_migration)` and `TS(tests/projectMigrationFlow.test.ts)` for RED.
- [ ] Reuse legacy stream readers into a fresh destination transaction; publish via Task 11 only after content validation and receipt/header initialization. Convert frontend-only archived records once into Task 3 schemas. Show progress and explicit migration choice; unsupported/future files fail before destination publication. Old-mode opening remains available while v5 is opt-in.
- [ ] Run archive compatibility corpus and reopen every migrated fixture through metadata-only v5 open plus selected table/document/history reads. Same-path, existing sibling and out-of-order JSON field cases must be explicit tests.
- [ ] Record complete migrated identity/value comparisons and original hashes; never silently rewrite the legacy archive on autosave.

## Task 13: Prove crash recovery and quantify lifecycle performance

**Files:** Create `src-tauri/src/perf_project_v5.rs`,
`src-tauri/examples/project_persistence_v5.rs`, `scripts/runProjectV5Budget.mjs`,
`scripts/projectV5BudgetCore.mjs`, `scripts/projectV5BudgetCore.test.mjs`;
modify `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `package.json`,
`docs/performance.md`; add real Rust child-process integration tests under
`src-tauri/tests/project_v5_recovery.rs` and `project_v5_forbidden_work.rs`.

**Interfaces:** Example accepts `--scenario seed|catalog|window|edit|close|crash-commit|crash-uncommitted`, `--path`, `--rows`, `--columns`, `--samples`, `--seed` and `--output`.
Each operation emits JSON with source/build/engine/fixture identity, backend and
UI-adjacent timing fields, forbidden-work counters, actual disk I/O method,
WAL/checkpoint bytes, RSS, exact logical verification and per-sample data.

- [ ] Write tests that kill a child after committed WAL and before acknowledgement, then verify exact data/docs/history and idempotent replay in a fresh process; kill before commit and require no partial state. Assert plain edit counts full before-image copies and anchor rebuilds as zero; test runner rejects missing/nonfinite metrics and insufficient samples.
- [ ] Run new Rust recovery/forbidden-work tests and `node --test scripts/projectV5BudgetCore.test.mjs` for RED. A fresh-process test must fail if it accidentally reuses a parent engine/connection.
- [ ] Implement probes and process I/O sampling using existing platform methods where available; unsupported metrics are unavailable and block the corresponding qualification rather than becoming zero. Instrument archive restore/write, DB copy, full history snapshot and full anchor rebuild boundaries; supplement counters with SQL profiling.
- [ ] Build `cargo build --release --manifest-path src-tauri/Cargo.toml --features perf-harness,project-v5 --example project_persistence_v5`. After final correctness/review freezes source, run 300k/2M/10M × 20-column fixtures plus many-table/document and long-string tiers; five independent cold opens, at least 100 warm operations per reported P95. Use the approved 1-s cold directory median, 500-ms warm directory P95, 300-ms first window, 100-ms scroll, 200-ms durable edit and 500-ms unchanged-close budgets. Report checkpoint outliers and cold-cache method separately.
- [ ] Persist immutable raw reports outside disposable caches and update `docs/performance.md` with commands, exact source state, sample counts, failures and platform gaps. No qualification based on debug timing or silent reruns.

## Task 14: Integrate status UI, run final gates and obtain native acceptance

**Files:** Create `src/components/ProjectPersistenceStatus.tsx`,
`tests/ProjectPersistenceHarness.tsx`, `tests/projectPersistenceStatus.spec.tsx`;
modify `Workspace.tsx`, `src/i18n/locales/{en,zh-CN,zh-TW}.json`,
`package.json`, `docs/development.md`, `docs/performance.md`,
`tests/applicationCommandSaveSnapshot.test.ts`, `tests/mcpArtifactParity.test.ts`,
`src-tauri/src/mcp/artifact_parity.rs` and the execution ledger.

**Interfaces:** Status component consumes Task 6 snapshot and retry callback;
no product UI exposes queue internals or physical filesystem paths. Add
`test:project-persistence` script for new TS coordinator/catalog/lifecycle/adapter
contracts and new CT files. Keep Rust qualification a separate explicit command.

- [ ] Write UI tests showing pending/saving/saved/error and safe retry; saved appears only after captured durable acknowledgement; failed close stays open; migration/recovery choices are understandable. Add UI/MCP parity cases that reopen the same project and read exact committed values, summaries and selected bodies.
- [ ] Run focused new UI/parity checks for RED, then implement status and final format dispatch. Audit Tasks 5/7 inventory: every mutation and document kind has a transaction owner and behavioral persistence case. Keep the opt-in feature until the final gate passes.
- [ ] Run `npm run build`, `npm run test:project-persistence`, `npm run test:analysis`, `npm run test:mcp`, existing workflow/history/window/viewport tests, `cargo build --features project-v5`, `cargo clippy --features project-v5 -- -D warnings`, `cargo test` and `cargo test --features project-v5` (all Rust commands under explicit `src-tauri/Cargo.toml`) and `git --no-pager diff --no-ext-diff --check`. The default-feature run validates the disabled gate; the enabled run qualifies v5 behavior. Capture every failure and nonzero count; reuse focused results until affecting changes invalidate them. Do not globally format unrelated Rust files.
- [ ] Dispatch independent review of actual tracked/untracked diff against spec, base SHA and mutation inventory; resolve important findings and rerun affected gates. Freeze the source, run Task 13's final performance matrix, and launch the exact worktree's native app. Provide acceptance fixtures for lazy directory/table behavior, small edit/reopen/undo, direct import, save/error/close, migration and Save As. Windows validation is required before claiming Windows support; Linux gaps remain explicit.
- [ ] Obtain native manual acceptance. Only afterward enable v5 by default if all qualification gates passed, run the affected fresh checks, and prepare commit/push/PR under the existing publication authorization. Preserve worktree and user projects. If default enablement changes runtime behavior, include it in final acceptance rather than assuming opt-in acceptance covers it.

## Coverage and dependency audit

| Spec area | Owning tasks |
| --- | --- |
| Format/version/storage ownership, read-only and locks | 1, 2, 11 |
| Data/document/history transactions, receipts and revisions | 2–7 |
| Plain edits avoid full history copies | 4, 13 |
| Direct imports/SQL/transforms/workflow publication | 5 |
| Automatic save status and sequence barriers | 6, 7, 14 |
| Metadata-only catalog and lazy documents/history | 3, 8, 9 |
| Bounded front/back query retention, counts/anchors | 10 |
| Draft recovery, close/switch/checkpoint, Save As | 11 |
| Legacy migration and scalar/domain compatibility | 12 |
| Crash/failure injection and performance evidence | 2, 4, 5, 11–14 |
| Mutation coverage, independent review/native acceptance | 5, 7, 14 |

Tasks 1–3 establish shared contracts; Tasks 4/5/6 must agree on Task 2's
transaction/revision ownership before their changes integrate. Tasks 7–10 depend
on that integration. Tasks 11/12 reuse the same lifetime and transaction owner.
Task 13's correctness probes can develop alongside the integrated behavior, but
its final measurements follow Task 14's source freeze. Task 14 cannot declare
completion from a green subset or from opt-in feature scaffolding alone.

## Handoff state

- [x] Written design approved on 2026-10-16.
- [x] Existing save-contract baseline failure reproduced and repaired; focused test and Vite bundling passed; independent review found no actionable issue.
- [x] Implementation plan written and self-reviewed for coverage, interface ownership, failure tests and proportionality.
- [x] Updated worktree to latest `origin/dev` `3a362f6ebed9dd9f2435aac56cdf5bd75a84052f` by fast-forward, preserving local edits; remote ref read-back matches HEAD. Six TS checks (save/snapshot, window cache, viewport, save lifecycle, v3 layer round-trip, layer migration/store) and TypeScript build plus Vite bundling pass at this baseline. Native/Rust qualification remains pending.
- [ ] Human review of this implementation plan and execution-method selection.
- [ ] Tasks 1–14 implemented and verified.
- [ ] Native acceptance and separately authorized publication.

Recommended execution: Native implementation in this session with focused
RED/GREEN slices and a whole-branch independent review. The tasks share
transaction, revision and lifetime interfaces, so keeping implementation context
continuous avoids repeated discovery; the ledger and final review preserve
traceability. Subagent-driven execution remains available if selected.
