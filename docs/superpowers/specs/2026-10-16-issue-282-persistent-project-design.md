# Issue 282: Persistent Projects, Lazy Loading, and Automatic Incremental Persistence

## Status and scope

Written design approved on 2026-10-16; implementation planning is in progress.

- Issue: <https://github.com/ashton2914/StatsPlayground/issues/282>
- Investigation: <https://github.com/ashton2914/StatsPlayground/issues/282#issuecomment-6206489405>
- Base and PR target: `origin/dev` → `dev`.
- Inspected baseline: `e0f840cb58296a5ed3f7661c3f7cc1dd6018417a`.
- Updated implementation baseline: `3a362f6ebed9dd9f2435aac56cdf5bd75a84052f`
  (latest fetched `origin/dev`, including PR #283).
- Related work: #246 (archive performance), #269 (history restoration), #263
  (persistent external DataLinks).

The product objective is that ordinary opening, browsing, small edits, and
closing stop moving every managed row. Automatic persistence is the selected
save model. Closing does not offer to discard already committed edits; undo and
redo remain available. Bulk work retains explicit progress and cancellation.

This specification covers one persistent-project subsystem. Delivery is staged,
but the new format must not become the default until all mutation producers and
document kinds satisfy its persistence contract.

## Verified current behavior

- `DuckDbEngine::new_in_memory` opens a DuckDB file in a temporary directory.
  Its `Arc<TempDir>` lifetime is shared by secondary engines.
- `ProjectService::open_project` creates staged state, restores every archived
  table, restores history, and rebuilds natural navigation anchors.
- `StreamingProjectWriter` reads every dataset through an archive cursor,
  serializes rows, writes a replacement ZIP, flushes, and replaces the project.
- `DataTableView` already uses 500-row windows, adjacent prefetch, generation
  fences, and a 5,000-row / 64-MiB estimated cache budget per viewport.
- The initial window query includes counting and ordering. Sorted/filtered
  prepared sessions build a complete ordinal-to-row-ID mapping.
- Project documents and display metadata currently have frontend/in-memory
  authorities that are collected for archive saves. Changing only the database
  path would leave those changes outside persistent transactions.
- The updated baseline includes Graph Builder-new v3 independent layers and
  pixel/line rendering caches. Preserve the complete layer options, empty-layer
  state, camera and hidden overlay groups; treat native/memory-mapped rendering
  caches as regenerable runtime state with explicit shutdown, never project data.

The September #246 measurements in `docs/performance.md` describe a different
source revision. They are background, not current or projected v5 measurements.

## Architecture choice and alternatives

Use a native DuckDB database as the v5 working `.spprj` file. Keep the existing
table engine and typed IPC. Store project documents and their directory
summaries alongside managed tables so one database transaction can publish
related changes consistently.

Alternatives considered:

1. **Lazy ZIP restoration plus cached tables:** improves directory opening but
   still parses full JSON table entries on first use and leaves archive saves
   expensive. It does not meet the incremental-persistence objective.
2. **A directory of Parquet tables plus patches:** supports lazy reads, but adds
   patch merging, compaction, multi-file atomic publication, and a second mutable
   table representation. Defer unless database measurements justify it.
3. **Persistent DuckDB with transactional project records:** reuses the existing
   query/mutation engine and is the selected approach. Costs include explicit
   database-version policy, WAL handling, and single-writer ownership.

Exported archives remain explicit interchange artifacts. They are not recreated
by normal edits, Ctrl+S, or ordinary opening and closing.

## Format and ownership

### Format identity

- Retain `.spprj`; introduce application project format `5.0.0`.
- Detect legacy ZIP/JSON versus DuckDB from bounded file-header reads. A DuckDB
  file is a project only after its application marker and version are validated.
- `_project_header` stores project UUID, application format version, minimum
  reader/writer capability, creation time, and committed project revision.
- Reject unknown future formats and non-project DuckDB files before application
  schema writes. Do not run the current unconditional initializer on an existing
  file: creation, read-only validation, and migrations are separate operations.
- Use the locked bundled DuckDB engine for v5 creation and record the actual
  engine/storage compatibility information. A bundled-engine upgrade requires
  fixture qualification before it may write existing projects. App schema
  compatibility and DuckDB physical storage compatibility are separate checks.
- Older app versions are not expected to read v5. Preserve old source files
  during migration and offer legacy export only where a lossless exporter is
  supported and tested.

### Database storage lifetime

Replace the unconditional `Arc<TempDir>` ownership with a shared storage owner:
`PersistentProject` or `RecoverableDraft`. All connections carry this owner;
dropping a persistent project must never delete it.

`ProjectDatabase` owns one serialized writer, a bounded reader pool, the storage
owner, a project epoch, mutation admission, and shutdown. Readers clone the same
database instance rather than opening independent writable engines. Opening an
already owned file in another window/process fails with an actionable file-lock
message. Qualified local read-only opening is explicit and prohibits mutation.
Writable network-share projects are outside initial v5 support; they must first
be copied to a local working location.

An unnamed project starts as a recoverable on-disk draft. A small application
draft registry records its UUID and location. Restart offers recovery; no
startup cleanup silently deletes unrecognized or unfinished drafts. First naming
uses the consistent snapshot procedure below and changes the active path only
after publication succeeds.

### Persistent records

Keep existing stable dataset/column IDs, row identity, natural order, generation,
calculated definitions, and internal history data. Add:

| Record | Responsibility |
| --- | --- |
| `_project_header` | Identity, format/capability markers, committed revision |
| `_project_documents` | Document ID, kind, schema version, JSON body, revision |
| `_project_directory` | Name, kind, parent/folder, document revision, summary |
| `_project_settings` | Dataset filters and other authoritative project settings |
| `_project_commit_receipts` | Idempotent operation ID and committed result revision |

Table/column metadata, display properties and history cursors must also live in
the database. Directory summaries and document bodies update in the same
transaction. Summaries contain identities and dependencies needed to display
content, without embedding report results or managed data rows. No summary may
require evaluating a table to construct the directory on each open.

Runtime query sessions, transport diagnostics, GPU resources, and regenerable
graph caches are not authoritative project data. Natural navigation anchors can
persist with their generation; valid anchors are reused, and stale/missing
anchors are repaired only for the requested table with progress.

## Transaction and automatic-save contract

### Mutation envelope

Introduce a backend project mutation boundary containing operation ID, expected
project epoch, expected document revisions/dataset generations, and typed
effects. The operation applies data, metadata, related documents, history and
directory changes on the same writer transaction. Advance the project revision
once per committed operation. A receipt permits safe retry when the transaction
committed but its IPC response was lost.

Existing engine methods that own `BEGIN`/`COMMIT` must gain transaction-aware
internal variants; callers must not nest transactions. Do not treat a frontend
store subscription followed by an unrelated data commit as atomic publication.
Workflow output packets and their recovery journal must use persistent receipts
and documents rather than relying on an in-memory acknowledgement window.

Audit every mutation producer: UI controls, application commands, MCP, imports,
SQL materialization, calculated columns, transforms, workflow execution,
directory operations, document presentation edits, undo and redo. A feature flag
keeps v5 opt-in until this inventory is complete and end-to-end coverage passes.

### Frontend persistence state

Use a project-scoped coordinator shared by UI and command adapters:

- `pending`: accepted local document changes have not all committed.
- `saving`: an operation is being submitted or committed.
- `saved`: no pending changes remain and the backend has acknowledged the target
  committed revision.
- `error`: a commit failed; pending user edits and the error remain visible.

Persisted state is authoritative; frontend stores are projections plus explicit
pending edits. High-frequency presentation edits may coalesce to the latest body
per document over a maximum 250-ms scheduling window. Data edits acknowledge
success only after commit. Coalesced document edits are visibly unsaved until
acknowledged. Coalescing never crosses a command barrier, source dependency, or
undo/redo boundary.

Ctrl+S captures the current local operation sequence, drains pending effects,
and waits until all operations through that sequence are durably acknowledged.
Later edits can continue and leave the status pending. Ctrl+S does not export,
copy the database, or force a full checkpoint. A save error cannot clear pending
state or advance the acknowledged revision.

Deleting/renaming an unloaded document updates backend records without loading
its body. Stale hydrated bodies are rejected by revision checks and cannot
overwrite a newer record. Acknowledgements from an old project epoch cannot
modify the newly active project.

## Metadata-only open and lazy document hydration

1. Authorize and identify the selected file; acquire its ownership/lock.
2. Open a staged database session, validate its project header and lightweight
   metadata schema, and allow the engine's required WAL recovery.
3. Read project settings and paged directory summaries. Use stored row/column
   counts and generations. Do not issue table counts, content hashes, anchor
   rebuilds, history snapshot restores, or report recomputation.
4. Publish the staged session only after catalog validation succeeds. A failure
   leaves the current project/session usable.
5. Populate stores with descriptors carrying ID, kind, name and revision. Fetch a
   document body when selected; fetch history entries in pages when requested.
6. Opening a report/analysis restores its saved document first. Recompute only
   when explicitly requested or required by its existing stale-result policy;
   project directory opening must not trigger every analysis.

Introduce separate summary/body contracts rather than casting unloaded stubs to
complete `AnalysisDocument`, graph, report, tabulate or workflow objects. Update
consumers that currently enumerate complete store items for names, dependencies,
deletion and save snapshots. `project.inspect`/document-list commands use the
same catalog; document-get hydrates only its requested body. Open returns no
managed table row arrays.

Opening may still perform engine metadata I/O and bounded WAL recovery. The
contract forbids application-driven full-table restoration/scans, not every
possible disk read inside DuckDB.

## Table browsing and query costs

Reuse current window transport, cancellation, cache keys, generation fences and
prefetch. Frontend memory stays bounded by row and byte budgets; impose an
aggregate budget across retained viewports, not an unbounded budget per tab.

Natural-order queries use persisted navigation anchors and stable row IDs.
Unfiltered total rows come from committed metadata. Cache filtered totals by
generation and query signature. Do not issue a new exact filtered count for
every scroll request. Initial-column metadata is separate from row payloads;
visible-column projection is used where the table layout permits it.

Global filter/sort preparation remains backend work and may scan the full input.
It runs cancellably with bounded session admission, byte budgets and progress.
Preserve global ordering with stable tie-breaking; never sort a fetched window
as a substitute. Measure first preparation separately from ready-session page
latency. This issue does not require arbitrary sorting to have constant cost.

The viewport releases its own row arrays; DuckDB manages database pages under a
configured memory budget. Scrolling must not manually delete database pages or
unload/reload entire managed tables.

## Import, undo and history

Import CSV and other supported sources directly into a table in the project
database. Parse/type conversion is still a full first pass. Table data, IDs,
metadata, initial anchors, folder entry and undo creation event become visible
in one committed operation. Failure/cancellation rolls back the import and
leaves no visible partial table. Long imports report progress without per-row
IPC; cancellation completes rollback before claiming cancellation succeeded.

Retain incremental history for ordinary edits and database-backed before-images
for operations that need them. History metadata/cursors and affected data commit
together. Undo and redo are new persistent mutations; reopening restores the
committed cursor without reconstructing every historical snapshot. Large
before-images remain possible and are measured separately from small edits.

Remote DataLinks remain metadata-driven external resources owned by #263. They
are not copied into a project merely because the project was opened.

## Close, checkpoint, snapshot and migration

### Normal close and switch

Stop admitting new edits, drain through the captured close barrier, cancel and
join read/compute jobs, release prepared sessions, then release all connections.
If draining fails, keep the project and pending edits open with the error; do
not silently discard them or announce successful close. A project switch stages
the new session and preserves the old session until replacement can succeed.

Use engine-managed checkpoints and a controlled idle maintenance opportunity;
do not checkpoint on every edit or Ctrl+S. Engine shutdown/checkpoint may incur
remaining I/O, so close latency is measured explicitly. If it misses the budget,
change checkpoint scheduling and remeasure rather than reporting a hidden wait
as zero. Ordinary close never creates a complete replacement project archive.

WAL sidecars are part of an active project's durable state. Do not manually
delete them. File Explorer copies of an open database are not a supported
snapshot operation; application Save As/export provides consistent copies.

### Save As and first naming

Drain a precise revision barrier, pause writers, cancel/join readers, checkpoint
and close all handles, then copy the closed database to a unique sibling
temporary file at the destination. Validate its lightweight header, flush file
and required directory metadata, and atomically publish it using the existing
platform replacement abstraction. Reopen the destination and switch active
ownership only after success. On failure reopen/preserve the source and retain
its identity; do not claim the failed destination is the current project.

If target publication succeeds but reopening fails, keep both files and report
the created destination explicitly. Do not remove either file as rollback.
Save As is deliberately allowed to copy all data and show progress. Never use a
hard link as an independent project copy. Overwrite follows existing explicit
destination-confirmation policy.

First naming preserves the draft project UUID. Save As creates a new project
UUID in the destination temporary database while preserving dataset, column,
document and row IDs and their relationships. The source is unchanged. Validate
and flush the destination again after this header update before publication.

### Legacy migration

Legacy archives open through an explicit migration flow into a new sibling
temporary v5 file. Reuse the existing archive compatibility reader once, import
all tables/history/documents, reconcile generations and identities, and validate
the completed migration before publication. Keep the original file unchanged;
default the new name to a distinct `-v5.spprj` sibling with collision handling.
Migration does not overwrite its source as a side effect of autosave.

Failed/cancelled migration preserves the live project and original archive.
Cleanup removes only operation-owned temporary outputs, never unknown recovery
files. Migrations of existing v5 schemas are explicit versioned operations;
normal open must not rerun schema backfills over all rows.

## Failure and compatibility requirements

- Inject failures before/after commit and before/after acknowledgement. Verify
  committed receipts make retry idempotent and failed transactions publish no
  partial data/document/history state.
- Inject disk-full/permission errors, invalid headers, unsupported versions,
  lock conflicts, stale generations, cancellation and switch races.
- Terminate a child process with committed WAL, reopen in a fresh process, and
  verify exact values, directory, revisions and history cursors. Separately
  verify uncommitted work is absent.
- Preserve special archive scalar types, calculated definitions, stable IDs,
  inserted natural order, display properties, filters, empty folders, all graph
  and analysis kinds, reports, tabulates, transforms and workflow bindings.
- Validate read-only opening without schema writes and with clearly disabled
  mutations. Do not attempt implicit repair that needs write access.

## Verification and performance acceptance

Use release builds, recorded source SHA, engine version and fixture seed. Run
300,000-, 2,000,000- and 10,000,000-row / 20-column fixtures, many-table and
many-document fixtures, and a bounded wide/long-string fixture. Creating these
fixtures is setup and is timed separately. Initial bulk import, first sort,
migration, Save As and export receive their own results.

Proposed latency budgets for review on the existing local NVMe reference host:

| Operation | Budget / evidence |
| --- | --- |
| Directory ready, 2M and 10M fixtures with equal catalog size | <= 1 s cold median; <= 500 ms warm P95 |
| First natural-order table window | <= 300 ms warm P95; cold timing reported separately |
| Ready-session scrolling | <= 100 ms warm P95 |
| Single-cell edit through durable acknowledgement | <= 200 ms warm P95 |
| No-pending-edit close | <= 500 ms warm P95; checkpoint cases reported separately |
| Viewport retention | <= 5,000 rows and 64 MiB estimated per active viewport, bounded aggregate |

Take five independent cold-open samples and at least 100 warm operation samples;
report cold median/max and measured warm P95, not a percentile inferred from a
single sample. State the cold-cache method. Repeat the same small edit across
sizes to expose total-size scaling.

Record UI ready time separately from backend completion, query duration,
commit/fsync, checkpoint, transferred bytes, process RSS, and per-process disk
reads/writes including WAL. Add counters proving zero archive row restoration,
zero archive writer calls, zero full-database copies and zero all-table anchor
rebuilds in ordinary v5 lifecycle operations. Validate SQL plans/profiling as
well as counters so a hidden count/hash query cannot evade the test.

Compare small-edit write volume across sizes and include checkpoint outliers;
do not require physical writes to equal the cell payload. Exact logical restore,
crash recovery and bounded-memory checks are release gates. A missed latency
budget remains a reported failure, never relabeled as zero wait.

## Delivery and review boundaries

1. Approve this written specification, then write the implementation plan and
   select execution method.
2. Add persistent storage ownership, v5 identity/schema and lifecycle primitives
   behind an opt-in gate; qualify engine reopen and read-only behavior.
3. Implement atomic mutation envelopes, receipts, history/document storage and
   the persistence coordinator; audit every mutation producer.
4. Add direct imports, migration and safe snapshot publication.
5. Add catalog opening, lazy document hydration and catalog-based consumers;
   reuse bounded viewport reads and remove open-time full work.
6. Run focused correctness gates per slice, then final affected frontend/Rust
   gates and independent diff review once the integrated source is frozen.
7. Run the release measurement matrix and native manual acceptance. Only then
   enable v5 by default and prepare publication under the repository workflow.

No step permits a partially persistent project to be presented as saved. No
performance result in this specification is a claim of achieved behavior.

## Recorded baseline checks

At the inspected baseline, using Node `v24.19.0` and the repository's locked
dependencies in the new worktree:

- Branch: `codex/282-persistent-project`.
- Dependencies: an independent copy-on-write copy of `node_modules/` after
  verifying the source and worktree lockfiles are identical; no shared symlink.
- Setup/verification-created disposable ignore allowlist: `node_modules/` and
  `dist/`. No runtime project data or credentials were created by this setup.

| Check | Result |
| --- | --- |
| `tests/tableWindowCache.test.ts` | Passed, exit 0 |
| `tests/tableViewport.test.ts` | Passed, exit 0 |
| `tests/useProjectStore.saveLifecycle.test.ts` | Passed, exit 0 |
| `tests/applicationCommandSaveSnapshot.test.ts` | Failed, exit 1 |

The failing test searches `Workspace.tsx` for the exact text
`const handleSave = async () => {`; the actual baseline has
`const handleSave = async (saveAs = false) => {`. Neither source nor test has
been changed when the failure was first recorded. This establishes an existing
source-contract test mismatch, not a verified defect in runtime saving.

Baseline repair: the test now locates the function by
`const handleSave = async (` so parameter-list changes do not break its body
extraction. Its existing wiring and runtime assertions are unchanged. The
original failure was reproduced before the repair; the complete
`applicationCommandSaveSnapshot.test.ts` now passes, exit 0. Product source is
unchanged. Vite production bundling passes, exit 0, with dynamic/static import
and chunk-size warnings. No full TypeScript/Rust qualification has run.

After the requested latest-dev update to
`3a362f6ebed9dd9f2435aac56cdf5bd75a84052f`, all four listed TS checks were rerun
and passed. The newly merged `graphNewLayersProjectRoundTrip.test.ts` and
`graphNewLayers.test.ts` also passed. `tsc -b` and Vite production bundling passed,
with the bundler import/chunk-size warnings retained. Rust/native qualification
has not run for this new baseline. Primary checkout and unrelated worktrees
were not updated by this operation.
