# Issue 282 Execution Ledger

Plan: [Persistent projects](2026-10-16-issue-282-persistent-project.md).
Spec: [Approved design](../specs/2026-10-16-issue-282-persistent-project-design.md).

Execution method: Native continuous; approved on 2026-10-16. Base:
`3a362f6ebed9dd9f2435aac56cdf5bd75a84052f`. Worktree branch:
`codex/282-persistent-project`. No commit/push before manual acceptance.
Detailed task briefs and raw logs are retained under the plan-specific
`.superpowers/sdd/2026-10-16-issue-282-persistent-project/` workspace.

## Progress

- Task 1 complete: shared persistent/draft/temporary storage lifetime; schema
  creation separated from existing-file open; v5 marker/capability/header and
  physical storage version; read-only validation; alias-aware file ownership;
  non-overwriting project creation and explicit connection shutdown.
  RED: missing APIs, then physical-version assertion. GREEN: six project storage
  tests plus existing secondary-connection test; 7 passed, 0 failed. Source
  checkpoints remain uncommitted. Product v5 entrypoint remains disabled.
- Task 2 complete: transaction ownership, backend-computed canonical request
  fingerprints, persistent receipts, generation/revision checks and reader pool.
  RED: missing commit/context APIs, retained in `task-2-red.log`.
  GREEN: transaction 5, save coordinator 11 and project storage 6 tests passed.
- Task 3 complete: paged directory separated from bodies, settings revision guards,
  folder retention and metadata-only table/history reads. Supplemental RED found
  inconsistent reader snapshots and mutable document kinds; both fixed. Final
  regression run: catalog 7, transaction 5 and storage 6 passed.
- Task 4 complete: native typed per-column cell deltas, bounded ordinary paste,
  unchanged-order anchor reuse, reopened undo/redo and redo-branch cleanup.
  Row/column mutations, history replay and bulk coordinator expose transaction-
  neutral entrypoints. RED reproduced whole-table behavior and missing neutral
  helpers. GREEN: 4 small-edit, 16 compact mutation, 6 archive and 104 calculated-
  column tests passed (130 total). Ordinary cell edit counters: zero full before
  copies and zero full anchor rebuilds. Schema growth/type conversion/formula
  recomputation remain explicit bulk operations.
- Task 5 complete under the staged-routing rulings below: CSV/SQLite/SQL,
  transform definition/binding/lineage/table publication, workflow packet receipts,
  owned staging manifests/recovery, explicit changed-ID acknowledgements and
  project UUID fences. Final focused/regression execution: 73 passed, 3 existing
  live database fixture tests ignored. Reader transactions are native read-only.
  Public AppState/IPC route migration remains an explicit Task 8 requirement;
  [backend-mutations](2026-10-16-issue-282-backend-mutations.md) blocks enablement
  until all pending project routes are resolved.
- Task 6 complete: ordered queue, maximum 250 ms document coalescing, sealed
  command/save barriers, immutable retry identity, epoch-aware acknowledgements,
  native revision authority and store save dispatch without archive collection.
  RED covered missing queue, forced later batches, runtime revision increments,
  store/command archive fallback and read-only close. All six TS suites plus
  TypeScript build passed. Snapshot destination handling remains Task 11.
- Task 7 in progress: typed document/settings/directory adapters and mutation
  inventory; hydration must not enqueue writes.

## Rulings

- Acceptance rules override automatic per-task commits; task completion records
  actual working-tree evidence. Cost if wrong: publication is delayed, without
  data/source loss.
- Shared Cargo compilation cache is reused with explicit target-dir; project
  databases/runtime sessions remain isolated. Cost if wrong: cache rebuild only.
- Task 1: `Mutex<Option<DuckDbEngine>>` allows real handle release on shutdown;
  AppState integration moves to Task 8's staged installation. Until then no v5
  session can be activated. Cost if wrong: integration adjustment, no live dual
  writer.
- Task 2: `commit` also accepts the normalized typed request, so backend receipts
  bind the actual request rather than trusting a supplied hash. Empty client
  hashes are permitted because the backend computes the authoritative digest;
  supplied nonempty hashes must match. Cost if wrong: dependent call signatures
  need adjustment; retries never silently apply a different payload.

- Task 4: Ruling: native typed cell snapshots live in a focused
  `project_cell_mutation` module, re-exported through the planned delta interface.
  The old archive validator explicitly rejects this new storage kind; v5 stays
  disabled until native snapshot/lifecycle integration. Cost if wrong: additional
  legacy export conversion work, without silent history loss.
- Task 4: Ruling: IPC/state routing is completed with Task 8's session integration;
  this task establishes transaction-neutral engine entrypoints first. Existing
  temporary engines retain legacy behavior. Cost if wrong: integration changes
  before enabling the feature, rather than a partially active persistence path.
- Task 4 regression: existing source-boundary test matched the new wrapper rather
  than the implementation; adjusted its boundary to the transaction-neutral
  function while retaining its bounded-navigation assertion.

- Task 5: Ruling: extend the transaction callback with explicit changed dataset
  and document IDs, and bind every write context to the project UUID. Tests found
  that newly created tables were absent from acknowledgements and a current epoch
  alone did not reject a foreign project identity. This avoids metadata-wide scans
  and protects retries across application restarts. Cost if wrong: typed context
  and frontend adapters require adjustment before enablement.

- Task 5: Ruling: public AppState/IPC routing is installed in Task 8 alongside
  the single session facade; Task 5 qualifies the transaction-neutral publication
  primitives and inventories every pending route. The default-disabled feature
  and Task 14 inventory gate prevent partial activation. Cost if wrong: more
  Task 8 integration work, with no live bypass enabled.
- Task 5: Ruling: real process-kill qualification runs in Task 13's dedicated
  harness. Task 5 verifies reopen/recovery and owned cleanup with real files;
  those checks do not claim process-crash qualification. Cost if wrong: fault
  handling adjustments before final enablement.
- Task 5: reader callbacks now run in native read-only transactions. A RED test
  demonstrated that a read callback previously could write without a receipt;
  GREEN verifies the database rejects that bypass.

- Task 6: Ruling: first naming and Save As use Task 11's native snapshot
  provider. Ordinary native Ctrl+S bypasses archive collection now; destination
  changes cannot fall back to the legacy archive writer. Cost if wrong: the
  snapshot adapter changes before v5 enablement.

- Task 7: Ruling: the persisted frontend fixture uses a feature-gated native
  JSON-lines harness around the actual ProjectDatabase service. This verifies
  native validation, transaction receipts and file reopen before Task 8 adds the
  thin Tauri routes. It is service-boundary evidence, not live IPC/UI acceptance.
  Cost if wrong: transport-specific fixes remain for Tasks 8/14.
- Task 7: document hydration projects only the requested record. A RED test
  reproduced loss of unrelated Graph New renderer sessions; GREEN preserves
  sessions and existing document revisions while accepting backend revisions.
- Task 7: native fixture caught an omitted analysis documentType field. The
  serializer now retains it; report/analysis/Graph New full bodies, empty layers,
  camera and presentation-only configRevision survived real file reopen.
- Task 7: queued settings and directory preconditions now rebase from only this
  queue's earlier acknowledgements. RED reproduced a stale second filter edit;
  GREEN retains immutable operation payload/context after first send.
- Task 7: folder setters generate one typed metadata patch per action, including
  assignments for unloaded documents and empty folders. Filter setters emit
  per-dataset settings; project hydration/reset use projection setters. Native
  file checks passed rename/delete/reparent and filter replace/rename/clear.

- Task 7 regression: workflowProjectContracts failed against unchanged dev
  source: its regex required an owned bundle and a single-line boolean expression,
  while dev already passes a mutable reference and formats the expression over
  lines. Verified identical HEAD source, then repaired only those source-match
  assumptions; native workflow behavior is unchanged.
- Latest origin/dev fetched again on 2026-10-19: still
  3a362f6ebed9dd9f2435aac56cdf5bd75a84052f, matching this worktree baseline.
- Task 7: all seven document kinds now have real-file round-trip evidence.
  Workflow creation uses the explicit mutation setter; transform definitions use
  the typed persistence entrypoint. Automatic transform execution/removal,
  workflow run/binding effects and snapshots still need their owning typed routes
  (Tasks 8/11); no completion or enablement claim is made for those paths.
- Task 7: MCP graph/report/analysis/tabulate mutations await the captured queue
  barrier before returning success. RED observed early MCP success; GREEN holds
  the result until native acknowledgement while leaving later UI edits pending.
  Delayed duplicate events are ignored once their project revision is superseded.

- Task 7: transform removal now emits one typed patch for definition deletion,
  binding invalidation and updated lineage; real native service checks passed.
  Full frontend route ownership is recorded in the adjacent frontend inventory.
- Task 7/8: Ruling: finish native session/typed public route integration as a
  shared integration span before closing Task 7. Workflow/transform multi-artifact
  projections, filter-dependent table writes and native history depend on the
  single writer installed by Task 8; snapshots also require Task 11's provider.
  Task 7 remains incomplete until those owning routes are qualified. Cost if wrong:
  integration changes before enablement; no bypass is declared complete.

- Task 8 in progress: staged catalog-only open, native service/IPC contracts
  and shared-writer installation. A RED/GREEN test confirms native commits and
  existing AppState reads use the same engine; a retired owner cannot clear its
  replacement's engine. No extra synchronization dependency was added.
- Task 8: Ruling: a shared database slot preserves existing service borrows while
  moving the already-open native writer into AppState. A native epoch fences slot
  ownership and prevents legacy engine replacement. Cost if wrong: lifecycle/facade
  adjustments before enablement; focused service regressions are required.
- Task 8: a RED test demonstrated that legacy mutation permits were still granted
  after native open. Native mode now requires a write context; the legacy archive
  writer is fenced as well. Unported routes remain explicit pending inventory
  entries rather than bypassing receipts.

- Task 8: native update_cells/clear_cells/add_rows/delete_rows_with_change_set
  now return durable commit envelopes through the existing IPC names. Frontend
  dataService preserves its legacy return API while using the ordered coordinator
  for native sessions. Cell/row native service tests cover acknowledgement replay,
  typed history, exact row counts and reopen/undo. The remaining command inventory
  is still pending, and v5 is still default-disabled.
- Task 8: RED found that queued dataset context generation was rebased while the
  same payload's expectedGeneration remained stale. Both are now frozen together
  at first send, using only this queue's earlier acknowledgements.
- Task 8: mutation guard coverage now explicitly checks each native context branch
  delegates to NativeProjectService and returns a commit envelope, then separately
  checks the legacy branch still starts with its permit. No legacy guarded family
  was removed from coverage. Read/catalog routes and native commit classification
  are enumerated alongside the existing registration table.
- Current frontend verification: 29 TS suites plus TypeScript build passed.
  Rust shared-writer regression checks passed native v5 (19), storage (7),
  transaction (8), catalog (9), coordinator (11), legacy project service (59).
  Further focused checks and feature-enabled harness rebuild remain in progress.

- Task 8: Ruling: commit envelopes include newly appended history summaries.
  Existing cell APIs keep their numeric/void return values; native UI history uses
  the backend change-set IDs instead of duplicating cell before/after values.
  Cursors use per-dataset next_history_ordinal and indexed ordinal lookups, without
  scanning history bodies. Cost if wrong: acknowledgement/projection adjustments
  before enablement; persisted receipts retain the history identity.
- Task 8: native HistoryStore projections deduplicate acknowledgement replay and
  suppress duplicate UI recordTable entries. Cache eviction/reset preserves durable
  history. apply_table_change_set now binds dataset ownership and generation to the
  native transaction; undo/redo do not append new undo entries.
- Task 8: the feature-gated process harness now installs the real AppState/native
  session. Frontend stores + dataService + coordinator passed actual CSV import,
  cell edit, backend history projection, HistoryStore undo/redo, all document
  kinds, folders, filters, report dependencies and complete file/session reopen.
  This is native service/transport-boundary evidence; live Tauri UI acceptance and
  process-kill qualification remain pending.

- Task 8: Ruling: commit envelopes also return affected directory summaries and
  deleted IDs, including folder ancestry. A real-service RED reproduced an import
  immediately followed by folder assignment being skipped because only the table
  generation was acknowledged. The frontend now registers committed metadata
  before follow-up actions; real native import/folder/history/reopen checks pass.
  Cost if wrong: metadata acknowledgement consumers adjust before enablement;
  table/document bodies are not included in these summaries.
- Task 8: CSV and SQL materialization now use their public context/receipt branches.
  Name allocation is inside the native transaction, preserving legacy `-2` suffixes
  and stable replay when the external CSV has disappeared. The native service test
  passed repeated import and SQL name allocation without duplicating replayed data.
- Task 8 regression: tests/dataService.test.ts imports Vitest although the unchanged
  dev package declares no Vitest dependency or runner. Verified the HEAD import,
  then used Node's built-in test function for this plain single async test. Its
  exact legacy compact payload/return assertions now run and pass without a new
  dependency. The 35 other selected TS suites passed before that runner repair.

- Task 7/8: metadata rename now updates only directory/table metadata and the
  document revision. A native test renamed a report with an intentionally
  unparseable body and a 10-million-row table with no physical rows, then rejected
  an invalid name atomically. Name-only store changes emit directory patches;
  no-op renames emit nothing. A RED test caught rename reverting a preceding
  queued folder move; the adapter now preserves pending metadata when composing it.

- Task 8: structured/manual table creation now shares the legacy validation and
  canonical column/display preparation, with an explicit transaction-neutral engine
  creator for native commits. New table rows, directory entry and display settings
  are written together; replay returns the same table and invalid display settings
  roll back. Native display reads use the epoch-bound persisted settings, not the
  temporary in-memory display map. Public creator/read contract verification is
  in progress; remaining inventory rows still gate enablement.

## Verification scope

Only focused tests have qualified the new primitives. Full frontend/Rust/native,
fault-recovery and performance qualification remain pending. No speedup or full
feature completion is claimed.

- Task 8 continuation: origin/dev refreshed on 2026-10-19 and remains
  3a362f6ebed9dd9f2435aac56cdf5bd75a84052f, matching the worktree baseline.
  Seven legacy managed-table validation/display/poisoned-lock regressions pass.
  Actual frontend native process now verifies managed, structured and empty table
  creation, durable column width and file/session reopen. TypeScript check passes.
- Task 8: Ruling: display updates carry the complete ordered stable-column ID list
  as well as the dataset precondition. The backend checks identity inside the
  receipt transaction before validating/replacing the persisted display setting.
  This prevents coordinator generation rebasing from retargeting an old index
  after a queued schema edit. Cost if wrong: stale-schema display writes need
  explicit reload/retry; no silent remapping is attempted. Native replay, stale
  identity rejection and invalid-width rollback pass; process round-trip pending.

- Task 8: display-write and table-rename frontend contracts pass, including stable
  column IDs and acknowledged queue sequences. Real frontend/native-process
  creation/display/rename/file-reopen checks pass; rename does not change data
  generation. Legacy row creator regressions pass 4/4.
- Task 8 regression: mutation coverage's function extractor matched prefixes
  (`create_table` selected `create_table_from_sql_query`). A focused RED reproduced
  the wrong function body. Extraction now requires the `(` or generic `<` name
  boundary, retaining generic entry helpers. All 42 command tests pass.
- Task 8: selected SQLite imports now route through the native receipt service,
  while preserving bare legacy summaries. Native service tests prove creation,
  append, replay after deleting the source, missing append precondition rejection
  and cancellation without advancing the committed revision. SQLite regression
  passes 13/13, including bounded streaming and conversion rollback.
- Task 8: Ruling: SQLite append must name its target dataset in write-context
  generation preconditions, resolved case-insensitively from metadata. The native
  transaction checks that identity before reading/writing source rows. Cancellation
  returns a rejected native operation rather than a completed commit envelope.
  Cost if wrong: append/cancel recovery must refresh metadata or explicitly retry;
  confirmed-rejection queue recovery remains an enablement gate.
- Current frozen-source check: complete Rust library regression and refreshed
  native-process SQLite round-trip are being run. No Task 7/8 completion, native
  UI acceptance, enablement, commit or publication is implied.

- Frozen-source broad verification: frontend production build passed; real
  frontend/native-process SQLite create+append+complete reopen passed; application
  TypeScript check passed. Complete Rust library run: 1664 passed, 1 failed,
  20 ignored. The sole failure is the untouched OLS warning-order fixture:
  `InvalidInput("predictor mean is missing for X1")`. Reproduced with `--locked`
  and the exact test name in the clean primary dev checkout, currently at
  3a362f6ebed9dd9f2435aac56cdf5bd75a84052f. Primary tracked status remains clean.
- Task 8: Ruling: keep the independent OLS fixture failure recorded as a baseline
  failure, without altering statistical behavior in the persistence issue. Cost
  if wrong: the complete suite remains non-green until a separate OLS correction;
  no complete-suite pass or release qualification is claimed.
- Formatted only the new native service/harness and touched command coverage
  additions; focused command/native project checks are being rerun afterward.

- Task 8: transform creation now records the complete typed command result
  (definition, execution/binding/output, lineage) in the receipt. RED exposed the
  missing fields; GREEN proves replay returns the original lineage even after a
  later transaction changes the live lineage. Source table generations are
  required. Backend transform regressions pass 24/24; five frontend transform
  store/contract/workspace/command suites pass.
- Task 8 integration finding: reopening an adapter without existing setting
  revisions makes its next lineage write incorrectly expect creation. The native
  fixture now reads the actual persisted lineage revision before installing the
  second-session adapter. Production settings metadata/lazy-value loading must be
  provided by Task 9; the current harness-only setting read is not live IPC proof.
- Task 9: in progress (brief read, no completion). Ruling: advance the catalog/body
  revision and setting-loading seam before finishing remaining native routes,
  while Tasks 7/8 remain open. Run/rebind/workflow adapters need authoritative
  loaded-document and setting revisions; this is a shared integration dependency,
  not permission to enable v5. Cost if wrong: adapter rework before enablement.

- Task 8 transform creation: real frontend transform store/native process verifies
  the committed definition, sorted output, lineage, no duplicate projection write
  and complete project reopen. Run/rebind routes remain pending.
- Task 9 core catalog store: RED/GREEN covers 1000 summaries without any body
  fetch, deduplicated body requests, recoverable read failures (including synchronous
  transport exceptions), revision invalidation, project/deletion late-response
  fences, and an in-flight old page restarting after a catalog mutation. This
  store is not yet connected to Workspace or live IPC lifecycle.
- Task 9: Ruling: loaded body/setting base revisions are independent of newer
  catalog/event metadata. Only an acknowledged own write or actual body/value
  hydration can advance the loaded base. RED reproduced a newer event incorrectly
  allowing an old report/filter payload to overwrite the new revision; GREEN
  retains the original CAS precondition. A delayed own receipt cannot regress a
  newer catalog record. Cost if wrong: conflicts require reload/merge while local
  pending edits remain retained; no automatic stale-body overwrite is allowed.
- Task 9 coordinator callbacks now provide transient own/external attribution and
  the exact acknowledged operation for local projection. These fields never enter
  the IPC commit envelope. The legacy compact fixture without directory summaries
  uses the exact acknowledged document metadata, not a newer pending edit.

- Task 9 targeted settings API: added epoch-fenced `get_project_setting` returning
  one key/value/revision record (or null), with command registration/camelCase
  contract, stale epoch and missing-key coverage. Native service, all 43 command
  checks, and actual frontend/native-process setting reload/reopen pass.
  Ruling: expose a targeted setting read alongside body reads so loading a
  selected table/workflow does not enumerate setting values. Cost if wrong: one
  additive read API; owner projections and setting-key enumeration remain pending.
- Task 9 catalog/domain adapter seam: first/paged summaries register metadata
  without hydrating bodies; an unloaded report accepts folder movement; selected
  body hydration projects only that domain object. Setting/body caches deduplicate
  requests, preserve per-record revisions, and fence project switches.
- Task 9 Workspace initial integration: directory rows now use native metadata
  (with typed pending directory changes), preserving names, folders, source IDs
  and cached table dimensions without making placeholder document bodies. Selection
  lazily fetches one body, deduplicates repeated clicks, fences superseded requests
  and provides localized retry. The legacy partial-body prune is skipped in native
  mode; committed native deletions remove their folder assignments explicitly.
- Task 9 UI: 21 component checks pass (three new lazy-directory/report tests plus
  18 existing Graph New Workspace checks). 34 selected TS/native-boundary suites
  and application typecheck pass. Unloaded report rename/delete emits only metadata
  patches and performs zero body reads. Epoch tests reject a delayed old-project
  rename/delete before it can touch a new same-ID document.
- Additional baseline verification: workspaceDatasetFilters, workspaceFitYByX and
  workspaceIssue153 source contracts fail identically in clean primary dev.
  Corrected their references to current command owners and renamed export handler;
  no production statistics/export/filter behavior was changed for these repairs.
- Task 9 remaining: production native open/session installation, targeted setting
  projections, paged history UI, workflow/dependency/inspect/list/get consumers,
  metadata-only subtype/name allocation and all unported native mutation rows.
  Current CT starts from an installed native summary; it is not native app/file
  dialog or lifecycle acceptance. Tasks 7/8/9 remain incomplete and v5 stays off.

- Task 9 deletion/selection qualification: a held commit test proves the selected
  editor closes before disk acknowledgement while its body remains recoverable
  until acknowledgement. A late editing callback cannot enqueue a recreate after
  deletion; delayed older receipts cannot resurrect a later committed deletion.
  Explicit restore-after-delete regressions remain green.
- Task 9 local body selection: a pending newly-created document opens directly
  from its validated local store while its commit is held, with no body RPC.
  Loaded-current bodies likewise avoid redundant fetches; stale loaded bases
  still require refresh. Metadata mutations check the captured project epoch.

- Task 9 targeted settings: filters, lineage and transform bindings now project
  only the selected setting into its domain store. Loaded setting revisions,
  pending-edit fences, read-only hydration and project epochs are qualified.
  Native reads validate selected lineage/bindings lazily; omitted default fields
  are supplied without dropping unknown extensions or writing a new revision.
- Task 9 selected table/transform: the real Workspace restores a table filter
  before its first bounded window request. A selected transform reads its body
  and binding and restores saved lastRun/schemaReports. An unloaded transform
  can be deleted using only lineage/binding reads; unrelated lineage nodes and
  loaded setting CAS bases are preserved. Eight lazy Workspace CT cases pass.
- Task 9 native settings evidence: the rebuilt native-process harness creates a
  transform, closes/reopens the actual project file, clears local bindings and
  lineage, then hydrates persisted run state and schema reports without writes.
  Ten native service tests and twelve related frontend suites pass.
- Task 9 history: a separate bounded summary cache now backs the native history
  panel. No requests occur before the panel mounts; it requests 200 entries per
  page and loads further pages on demand. Cursor changes restart once, failures
  allow retry, and reset/project changes fence delayed responses. Four CT cases
  pass across native paging/retry and existing panel layout behavior. This is
  history summary browsing; native jump/restore and named snapshots remain in
  their owning mutation/lifecycle tasks. No historical data payload is fetched.
- Current remote baseline rechecked: origin/dev remains 3a362f6; feature worktree
  HEAD has the same base. No primary checkout changes or publication occurred.
  Tasks 7/8/9 remain in progress; production native open/session installation,
  remaining settings owners, workflow/dependency/inspect/list consumers,
  metadata subtypes/name inventories and unported mutations still gate v5.

- Task 9 directory paging: the Workspace exposes subsequent catalog pages and
  recoverable read errors. A real-store CT proves later reports and ancestor
  folders become visible with zero body loads and no project writes.
- Task 9 workflow browsing: the workflow panel lists metadata-only saved
  definitions and hides unavailable revision/run counts. Entering lineage reads
  the saved graph rather than reconstructing it from partial body arrays;
  selecting a saved workflow loads only that body. Retry is qualified. Native
  extraction now reads the same persisted graph. Public run/rebind bindings and
  run-journal setting ownership remain Task 8/9 gates.
- Task 9 current UI qualification: 47 CT cases pass across eleven lazy Workspace
  cases, native/existing history panels, transform views, legacy Graph New and
  workflow views. Production build and fourteen selected TS suites pass.
- Task 9 project query adapters: project.inspect and document.list complete the
  metadata inventory without body/table reads; document.get hydrates only the
  selected supported document and preserves pending current local bodies. The
  existing API kinds, sorting, cursor rules and path redaction are unchanged.
  A real catalog/domain-store command test and legacy command tests pass; new
  Graph New/workflow MCP result variants and table-metadata refresh ownership are
  still required before enabling v5. Date/subtype metadata must not be fabricated
  from absent bodies. Pending metadata overlays are included in query results.
- Task 9 remains incomplete: production native open/session installation,
  remaining setting owners and run-journal enumeration, full catalog-aware name
  allocation/subtypes, extended query contracts, unported mutation inventories,
  lifecycle/snapshot/migration and fault/performance qualification remain open.
  No commit, push or native acceptance was performed; v5 remains disabled.

- Task 9 complete-inventory reconciliation: a reproduced stale metadata entry
  survived a later complete catalog snapshot. Full snapshots now reconcile
  durable membership while retaining pending drafts and protecting newer receipt
  watermarks. A RED→GREEN test covers pruning, draft retention and delayed older
  receipts. Partial pages never assert absence of not-yet-read records.
- Current-source checkpoint (2026-10-20): 47 combined CT cases, twenty selected
  TS suites, application/project typecheck, production build, native file reopen
  and settings/body conflict tests pass; git diff --check passes. Native service
  focused regression remains ten passing tests on the unchanged Rust source.
  Full library green is not claimed: the earlier clean-dev OLS baseline failure
  remains recorded. Actual native UI, process-kill and performance acceptance
  still require later tasks. All work remains uncommitted and v5 disabled.

- Continuation instruction: proceed through completion without stopping after
  intermediate verification checkpoints; preserve the manual acceptance and
  publication gates, which have not been satisfied.
- Task 8 transform run/rebind: native requests validate authoritative definition
  body revision, persisted binding and all source/output generations. Results,
  output generation, dependencies, binding, lineage, run status and receipt share
  the project transaction. Replays preserve the original result after later
  state changes/reopen; incompatible inputs persist blocked state while retaining
  the last successful output. Public IPC and TS coordinator adapters are wired;
  actual frontend store/native-process/file reopen verifies exactly one queued
  operation per rerun/rebind. Focused Rust and 24 transform regressions pass.
- Task 10: Ruling: aggregate frontend viewport budgets can advance independently
  of remaining Task 8 mutation adapters because they consume the already stable
  epoch/generation/window interfaces. Implementation does not enable native mode.
  Cost if wrong: adjust cache ownership when lifecycle providers install/reset it.
- Task 10 started: a 100-switch budget test and real three-table CT qualify two
  retained caches, aggregate 10000-row/128-MiB bounds, active preference and lease
  disposal. Eleven viewport/count/scroll CT checks and existing window TS suites
  pass. Native initial-window count/anchor qualification is in progress.

Task 11: checkpoint 2026-10-20: tabulate service now joins preparation workers and explicitly detaches source/session engines even when callers retain service, entry and lease objects (retained-connection regression RED→GREEN; 47 tabulate tests pass). ProjectDatabase prepare_close holds the lifecycle write gate through external-reader ownership validation, writable-only checkpoint and writer/file-owner release. Refused close preserves a usable writer; read-only close leaves bytes unchanged. Graph shutdown cancels owner before waiting for cache work and clears derived layers. Seven close/lifecycle tests pass; native switch retirement regression reproduced before installation changes. Native integration regression currently running. Draft/snapshot providers, final consumer/mutation inventory and full native qualification remain pending; v5 stays disabled.

### 2026-10-20 — Task 11 native lifecycle integration

- Retained navigation/tabulate owners now detach their connections, cancel active SQL and join preparation workers before native close. Tabulate regressions: 47 passed. Native project/lifecycle integration: 36 passed.
- `prepare_close` fences commits under the lifecycle write lock, checks external connection ownership, checkpoints writable sessions and closes owned handles; a refused close restores read services. Read-only close preserves file bytes. Graph shutdown waits for cache work after cancelling its owner.
- Recoverable drafts use an application-owned registry and opaque recovery IDs. Registry updates are atomically replaced; naming retains recovery data and unknown files.
- Closed-source snapshots use a sibling temporary file, validate metadata, flush, atomically replace and reopen. First naming retains project UUID; Save As assigns a new UUID and clears old receipt identities while retaining artifact IDs. Source bytes are unchanged. Occupied/alias destinations are rejected. Snapshot failure matrix: 3 tests passed across copy/validation/flush/publication/reopen.
- Native snapshot failures after source close restore the source under a fresh epoch and return an explicit recovery outcome; frontend reinstalls that epoch. Publication state is returned even when destination reopen fails.
- Native lifecycle transport, startup single-flight/retry/legacy fallback, recovery selection (2 browser CT cases), registered camelCase IPC envelopes and typecheck pass. Startup, open/switch, Save As and window-close adapters are now being integrated.
- Ruling: the snapshot helper returns an owned `ProjectDatabase`, and NativeProjectService publishes it into AppState before returning `ProjectOpenSummary`; returning a summary from a temporary snapshot owner would expose an already-closed epoch. Cost if wrong: internal signature adjustment before enablement.
- Remaining gates: full native lifecycle failure/locking qualification, migration, mutation/consumer inventories, crash/performance qualification and native manual acceptance. Feature remains default disabled; no commit or publication.

Task 10: additional wide-value regression found a pinned window could exceed the local byte cap, and an uncached navigation response could leave the viewport showing the old range. RED: pinned UTF-16 cache admission returned true above its cap; real DataTableView distant-scroll test never displayed row 5000 when retention was rejected. Fix rejects oversized entries before replacing existing cache state, reports actual retention, pins a new active request before LRU admission and paints valid uncached visible responses. Aggregate cache limits continue to cover retained cache entries, not total renderer/DOM memory. Final Task 10 verification reruns after GREEN.
Task 11: external-process destination ownership regression RED→GREEN. Snapshot publication now holds DuckDB's destination file lock through POSIX rename; Windows releases its probe before replacement so the OS replacement operation can enforce open-handle restrictions. Destinations with a WAL requiring recovery are rejected without hidden recovery writes. Four snapshot tests and 38 project/native lifecycle/navigation tests pass. Window close now uses one dynamic-owner handler and fences project changes during effect draining; report queues drain until their accepted tail stops changing. Unit close/retry/duplicate/session-switch regression passes.

Task 10: Ruling: retain the existing 500-row page alignment and bounded cross-page windows (up to 2,000 rows), rather than replace the established viewport transport with a strict 500-row RPC cap. The spec explicitly requires reuse of transport/cache/cancellation behavior; the existing boundary test expects a 1,000-row combined window. Cost if wrong: at a boundary a bounded request can fetch extra adjacent rows; Task 13 must measure actual payload sizes and latency. Cache retention limits remain 5,000 rows / 64 MiB locally and two retained viewport caches globally.
Task 10: qualified wide-value and uncached-render regression: UTF-16 oversized pinned admission rejects; a deterministic wheel event traverses the actual DataTableView paging path to row 5000. The old cache-only result handler fails at the visible-row assertion; the corrected handler passes. An explicit rendered-window identity prevents repeated reads when current data cannot be retained. Earlier diagnostic fixtures with missing stable column IDs or coalesced native wheel bursts are not counted as regression evidence.
Task 11: four real-App browser component cases now pass: metadata-only startup/switch with editor reset, first naming then ordinary save barrier, duplicate window-close events wait for the accepted document commit before destruction, and published-copy/session-recovery failure shows its precise outcome plus a working retry. Fatal startup retry was RED→GREEN; startup single-flight now clears after completion so recovery can be rescanned.

- Task 10 complete (2026-10-20): final task-done verification passed navigation
  Rust suites, viewport/cache/property TS contracts, 13 component tests and tsc.
  The wide-window regression first failed at the visible last row, then passed
  after retaining the current response independently from cache admission.
  Shared-session assertions preserve ordered page visits while allowing bounded
  adjacent prefetch requests. Logs: task-10-verify.sh task-done output in scratch.
- Task 11 qualification (2026-10-20): 5 project_snapshot tests and 40 project_v5_
  tests pass, including cross-process destination ownership, WAL retention,
  read-only copy, refused close preserving the live writer, and idle checkpoint
  revision fencing. Lifecycle TS busy-state test and tsc pass. Four App CTs
  cover metadata-only switching, naming/save, pending-commit close, and a
  published-copy failure with retry. These are component/native service checks;
  full native process kill/recovery and performance gates remain Task 13.
- Task 9 query consumers: a complete-catalog regression failed because Graph New
  and workflow counts were absent. The fix lists both kinds without bodies,
  hydrates only the requested body, and reads authoritative native table metadata
  for table.list/describe even when no table is loaded in the frontend. Table
  metadata queries leave stores and rows untouched. MCP schema qualification is
  in progress; v5 remains disabled pending the complete inventories.

- Task 11 complete (2026-10-20): task-done passed the project-v5 feature-enabled
  41 native tests, 5 snapshot tests, 8 TS suites, 6 App/recovery component tests,
  TypeScript and production build. Draft files are under the application data
  directory's project-drafts-v5; the frontend receives opaque recovery IDs only.
  Snapshot copy/validation/flush/publication/reopen fault matrix preserves source
  files and reports post-publication failure explicitly. No native user acceptance
  or kill/recovery/performance claim is made by this completion.
- Task 11: Ruling: named internal data snapshots are typed data mutations under
  Task 8, distinct from Task 11's checkpointed whole-file Save As — lifecycle
  qualification must not imply that the legacy rows-in-JS named snapshot route is
  migrated. Cost if wrong: extra integration work before v5 enablement.
- Task 9 query/name qualification: 20 MCP tests, 12 focused TS suites, 15 lazy
  directory/App component tests and tsc pass. Public graph/report/analysis/tabulate
  commands finish metadata inventory before allocation and hydrate only requested
  bodies plus source metadata; old metadata responses are fenced after a switch.
  An active-session name inventory includes unloaded records and pending local
  changes; counter helpers and Graph New creation/rename share it. Direct dialog
  creation paths still need complete-inventory preparation before enablement.
- Task 9: Ruling: persist analysis subtypes in a small auxiliary metadata index,
  derived from validated bodies in the same write transaction. Older opt-in v5
  files without this index stay readable (unknown subtype) and gain the index on
  their first explicit document write; opening never performs a body scan or
  hidden upgrade. Cost if wrong: a pre-index analysis needs selection before its
  subtype is known. A native regression corrupts the stored body after publication
  and proves metadata subtype listing, rename and read-only reopen still work.

- Task 9 complete (2026-10-20): task-done passed 12 catalog Rust tests,
  43 feature-enabled project_v5 tests, 20 MCP tests, 22 TS suites, 20 native
  directory/report/history/App component tests and tsc. The report insertion
  menu lists unloaded analysis types from metadata. Embedded sources hydrate on
  demand with retry and bounded 20-row table previews. Graph New selection and
  workflow browsing prepare source metadata; generation receipts update existing
  dataset metadata without manufacturing unloaded tables. No eager native-open
  body/analysis execution path is known in these consumers. Legacy open/load
  paths remain explicitly separated; Task 8 mutation inventory still blocks v5.

- Task 8 column add/delete slice qualified (2026-10-20): 45 project_v5 native,
  12 catalog, 8 transaction, 16 compact mutation and 17 mutation-guard tests pass
  (98 total), 19 DataTable mutation CT pass, focused transport/filter/setting TS
  suites and tsc pass. The rebuilt real native-process fixture proves add/delete,
  undo/redo, display identity, filter disable/restore and file reopen through the
  actual dataService/coordinator/session path. Filter projection enqueues no
  follow-up settings write. Broader guard coverage added the seven Task 11 IPC
  classifications and explicit native add/delete routing assertions.
- Task 8: Ruling: native display settings are stored by stable column ID, with
  positional arrays retained as a read-compatible logical DTO. A schema mutation
  converts old arrays transactionally before positions change. Deleted IDs retain
  their settings for undo. Saved filters retain stable IDs; read/receipt projections
  disable missing columns and resolve current names. Effective filter records are
  included in the same durable commit receipt, avoiding a fallible post-commit
  fetch before table refresh. Cost if wrong: retained metadata needs retirement
  with owned history cleanup; no row values are copied for settings.
- Native fixture correction: its earlier filter used a fictitious column ID on
  an absent source and renamed only the frontend field. The stronger effective
  projection exposed that invalid setup. The fixture now creates a real filter
  source, uses its actual stable ID and tests successive bounds/clear. This does
  not qualify column rename atomicity, which remains a separate pending route.
- Task 8 column reorder started: the new native regression currently fails on
  missing reorder_columns. It requires metadata-only order history, durable replay,
  reopened undo/redo and zero full-before-table copies; legacy full-copy reorder
  cannot satisfy the v5 contract.

- Task 8 column reorder qualified (2026-10-21): metadata-only permutation history,
  receipt replay and reopened undo/redo pass; archives contain no row snapshots
  and the full-before-copy counter stays zero. The rebuilt native process fixture
  verifies actual column order and display properties through the coordinator.
  Focused branch/history/archive/delta Rust tests pass (1+4+6+16); transport TS
  and typecheck pass. Wider integrated regression remains pending.
- Task 8: Ruling: retire an abandoned redo branch centrally when recording the
  next mutation for that dataset, inside the same transaction. The regression
  first failed because reorder history survived a new row edit after undo; it
  now passes. This also removes duplicate cell-only cleanup. Cost if wrong:
  branch retirement must preserve other datasets and shared history validation,
  requiring the integrated history regression gate.
- Task 8 calculated columns: native rollback/replay/reopen test is RED on absent
  typed service routes; transport is RED on absent coordinator context. Extract
  transaction-neutral formula operations for the project writer. Existing bulk
  formula materialization still uses a full-before working table and must be
  bounded to affected columns before the incremental-I/O contract is qualified.

- Task 8 calculated-column transaction slice: native rollback after formula metadata,
  durable replay, computed values, reopen and undo pass. Frontend routes now use
  the ordered receipt coordinator; both IPC wrappers retain legacy permits and
  have explicit native guard coverage. Scoped history captures only the changed
  formula output and downstream outputs, excluding unrelated source columns.
  Observed RED full-table-copy counter became GREEN. Regression found conversion
  unnecessarily recomputed downstream formulas; conversion now preserves their
  unchanged materialized values (24 service + 2 rollback + 6 archive + 4 timeline
  + 17 guard tests pass). Native v5 suite passed 47 tests before that refinement.
- Task 8: Ruling: retain the existing before/after column snapshot encoding for
  calculated materialization, but permit an explicitly identified partial-column
  history operation only when every untracked schema column remains identical.
  Formula evaluation changes a full output column, not the full source table.
  Cost if wrong: replay and archive validation must cover chained outputs,
  insertion positions and unrelated values. Native conversion still needs a
  metadata-only delta to avoid copying values that did not change.
- UI regression: initial DataTable run had 18 passes and a menu timeout while
  opening a query-session failure case. The isolated case passed; a fresh complete
  calculated-column + mutation run passed all 41 component tests. No production
  menu change was made based on the transient timeout.
- Baseline refresh (2026-10-21): fetched origin/dev and confirmed it remains
  3a362f6ebed9dd9f2435aac56cdf5bd75a84052f, matching this worktree base.

- Task 8 calculated-column slice qualified (2026-10-21): final focused Rust
  47 native + 24 formula + 2 rollback + 6 archive + 4 timeline + 17 guard
  tests pass (100 total), transport/typecheck and 41 combined UI CT pass.
  Rebuilt real-process adapter passes formula creation, convert-to-values,
  two undo operations and subsequent schema edits through the coordinator.
  Conversion is now a metadata-only compact delta with no row snapshots,
  validated timeline transitions and reopened undo; insertion before a source
  column is covered. Legacy formula entrypoints retain full legacy history
  encoding, so default-disabled v5 does not change legacy archive behavior.
- Task 8: Ruling: converting a formula to values changes only formula metadata;
  retain its existing materialized values and dependent outputs. Store its
  definition in compact metadata history and copy unchanged navigation anchors.
  Cost if wrong: replay must reject a mismatched physical schema or anything
  other than one formula metadata transition; validators enforce both.
- Next Task 8 slice: column rename/type canonical transport is RED on missing
  project context. Pure rename must remain metadata-only; type conversion may
  write only converted columns and affected calculated outputs.

- Task 8 column alteration: observed RED on missing native facade methods and
  missing transport context; transport is GREEN. Pure rename uses compact
  metadata history; type changes reuse neutral engine validation with scoped
  before-images including downstream formulas. The shared scoped history
  operation is now named `column_values` to cover formula and type changes.
  Legacy entrypoints retain their original full history encoding.

- Task 8 column rename/type slice qualified: 49 feature-enabled native tests,
  24 formula service, 6 archive, 4 timeline, 17 guard and 5 existing alteration
  tests pass; scoped dependency regression and 28 compiler tests pass. Transport,
  typecheck and 24 property/calculated CT pass. Rebuilt real-process integration
  verifies rename/type/undo, stable display identity, synchronous filter rename,
  incompatible filter disable/undo restore and no receipt echo writes.
- Task 8: Ruling: filters with incompatible physical types become inactive while
  their raw stable-ID definitions remain available for undo. Numeric-to-text was
  observed RED with an invalid active numeric filter, then GREEN after projection
  uses the existing engine type classifiers. Cost if wrong: read projections
  must preserve categorical rules and future semantic type overrides.
- Task 8: Ruling: preserve an existing floating formula output when its inputs
  become integral by allowing an explicit integral-to-double cast only in
  materialized-output compilation. The ordinary typed compiler stays strict;
  narrowing and numeric/boolean mismatches still fail atomically. A native
  chained-output test exposed the old mismatch, then passed with only three
  affected columns retained and original values recovered after reopen/undo.
- Native fixture correction: a new assertion assumed a nonexistent getFilters
  method; changed it to the actual byDataset store shape. The real-process test
  then passed; no production behavior was changed for that test error.

- Task 8 dataset deletion transaction slice: observed missing-service RED and
  stale loaded-store projection RED, then native service/guard (1+17), full
  native suite (50), 10 focused TS suites, tsc, 18 Workspace CT and rebuilt
  real-process integration pass. Target table, owned history and graph/GraphNew
  dependents are removed in one receipt without hydrating graph bodies (even
  a malformed unselected graph body does not block deletion). Unrelated tables
  remain. Loaded table/graph/filter/viewport/history state projects synchronously
  without cleanup writes; Workspace native deletion uses this projection.
- Task 8: Ruling: scope deletion to the legacy UI's table plus direct graph
  dependents; retain analyses/reports with unavailable source IDs. Keep settings
  revision tombstones so late updates cannot resurrect removed settings.
  Cost if wrong: table lifecycle undo/redo requires a separate typed tombstone
  history contract; creation/deletion undo parity remains an enablement gate.
  This slice does not qualify table lifecycle undo or named snapshot restore.
- Task 7 recovery audit: observed RED where an onCommit projection exception
  removed the queue head and reported saved while promises/barriers hung. Queue
  removal now follows successful projection; failure retains the same immutable
  operation for receipt replay and keeps barriers failed. A second RED exposed
  nested calculated requests not rebasing expectedGeneration with their context;
  both payload/context now rebase without mutating caller inputs. Targeted tests
  pass; integrated lifecycle/checkpoint/native-process checks are running.
- Task 7 unresolved gate: invalid/stale immutable queue heads still need durable
  operation resolution before cancellation/replacement. Never drop an uncertain
  operation merely because its transport rejected; delayed application must be
  fenced with a durable cancellation marker or resolved committed receipt.

- Task 7 failed primitive-operation recovery: backend operation resolution and
  coordinator/UI are integrated. Observed RED absent resolution method/queue
  support and missing recovery button, then GREEN. The writer returns an existing
  committed receipt or durably records cancellation before any delayed request
  can apply; cancellation is idempotent and survives reopen. Older opt-in files
  are not upgraded on open or ordinary commit; explicit resolution adds its
  marker table transactionally. 10 transaction + 18 guard tests, six focused TS
  suites, tsc and five native App CT pass. Actual native process proves invalid
  operation cancellation followed by queued rename, rejection of the late
  original request and lost-ack receipt recovery without a second write.
- Task 7: Ruling: permit explicit recovery only for typed primitive queue heads.
  The UI describes cancelling unapplied work and retaining committed changes.
  Autosaved document/settings patches keep their retained drafts and require
  conflict repair, rather than being silently discarded. Cost if wrong: a
  document conflict needs a separate explicit draft/remote reconciliation flow
  before enablement. External receipt-projection exception recovery is also
  still pending; owned receipt projection retry is qualified.
- Task 7 namespace qualification: first naming must preserve cancellation
  markers with the draft identity, while Save As resets them with receipt
  identity. The new regression was RED because copied markers remained; the
  implementation now clears the owned cancellation table only for Save As.
  Snapshot/native regression is running before marking that boundary qualified.

- Task 7 cancellation namespace qualified: six snapshot tests and 50 native
  regressions pass. First naming preserves cancellation markers; Save As clears
  the old identity's markers with its receipt namespace.
- Task 7 external projection recovery: an observed RED showed external receipt
  callback exceptions escaping the listener. Unprojected receipts now remain in
  revision order; retry reprojects them without transport or data writes and
  cannot let a newer partial receipt erase an earlier one. Coordinator tests,
  nine focused TS suites, tsc and actual native-process fixture pass. Owned and
  external receipt projection recovery are covered; explicit retained-document
  conflict repair remains an enablement gate.
- Task 8 formula-dependent cell edits: observed runtime RED full-before-table
  copy counter (1 rather than 0). Replace the native fallback with compact
  per-column/per-row before-images and row-local formula evaluation in dependency
  order. Row sets propagate exactly through dependencies and share immutable
  sets/unions to avoid duplicating common affected-row lists. Qualification is
  running, including untouched-row and reopened-undo assertions.

- Task 8 formula-dependent cells qualified: 51 native + 4 compact-cell + 24
  formula-service + 28 compiler tests pass, followed by a sparse independent
  input/dependent-output regression and rebuilt real-process source edit/formula
  value/HistoryStore undo test. Single-cell history snapshots contain exactly
  one row for each source/dependent column; two sparse source edits retain the
  exact row set per output and preserve unrelated rows/columns. Full-before
  table copy counter remains zero.
- Task 8: Ruling: v1 formulas are row-local, so ordinary source-cell updates
  materialize only dependency-derived row IDs. Reuse immutable row sets and
  memoized unions for common dependency shapes. Formula definition changes and
  explicit type conversions retain their separately measured bulk paths.
  Cost if wrong: new non-row-local formula functions require a distinct bulk
  materialization contract; complex sparse graph/RSS behavior remains a Task 13
  measurement boundary.
- Qualification corrections: the numeric fixture reader had hardcoded `value`
  despite accepting a column argument; fixed its quoted numeric lookup before
  rerunning the real-process test. The sparse SQL assertion also needed its
  reserved `Both` column quoted. Native v5 cell history uses its own typed row
  snapshots and metadata pager; the legacy archive-history validator does not
  describe this storage kind and remains outside native save/export paths.
- Next: canonical native paste routing, including formula-dependent ordinary
  pastes. Schema growth/header changes, sorted/filtered row identity and atomic
  compound history must be qualified before paste enablement.

- Task 8 bounded paste slice qualified: native paste now binds the full ordered
  column-ID inventory and optionally the visible physical row IDs. One compact
  cell/formula history event commits with generation/row/column metadata; native
  UI applies that scoped result and reloads its window. Natural in-bounds ranges
  use saved anchors. Stale column order rejects atomically. Native/replay/reopen
  undo, transport and actual process formula-dependent paste/HistoryStore undo
  pass; 53 native + 4 compact-cell + 18 guard tests, eight TS suites, tsc and
  42 calculated/mutation CT pass. UI regression asserts reversed visible row
  order, submitted IDs, pasted values and linked unchanged column values.
- Task 8: Ruling: preserve existing nonempty column types when detected clipboard
  types differ, matching the existing paste semantics; empty-column promotion,
  headers and row/column growth require the still-pending compound schema/history
  operation. Native sorted/filtered paste must bind visible IDs; ranges outside
  the loaded view remain gated until bounded view-row resolution is integrated.
  Cost if wrong: do not fall back to full table snapshots to make these cases
  appear supported. V5 remains disabled until the complete paste gate passes.
- Paste test correction: ordinary browser keyboard paste does not consume a
  mocked navigator clipboard. The new test now sends an actual clipboard event
  to the grid; it then observed the intended missing-row-ID RED before GREEN.

- Task 8 added-row defaults qualified: observed RED where new rows contained
  NULL for constant/COALESCE formulas, then GREEN after evaluating all ready
  formulas only on inserted rows. Reopened redo uses the same deterministic
  row-local calculation, with no value snapshot or full-before copy. The new
  native regression and 16 compact mutation regressions pass; the later 54-test
  native suite also covers this behavior.
- Task 9 header receipts: observed RED missing row counts after add/undo. Native
  commit receipts now include authoritative metadata only for affected table
  directory entries, using saved metadata (not table scans). Projection updates
  loaded table counts/names with revision/generation and pending-name fences;
  unchanged source headers retain object identity. Rust 54 native + 10
  transaction + six snapshot tests, focused TS and seven App/history CT pass.
  Real-process count/undo verification is running after adding its missing
  add_rows dispatch; that fixture omission did not require a production fix.
- Task 7 receipt ordering: observed RED where external revision 12 arriving
  before unrelated revision 11 discarded the latter. Compressed received-revision
  intervals now accept unseen out-of-order partial receipts while rejecting
  duplicates and pre-open revisions; global committed revision stays monotonic.
- Task 11 publication race: observed RED where a new-owner receipt arrived
  during awaited old-owner close, projected into old stores and was lost before
  new store installation. Delivery now buffers until new adapters/catalog/table
  metadata are published, then drains and releases the early buffer. Focused
  lifecycle RED→GREEN and integrated TS/App/history checks pass.

- Task 9 real-process receipt count/undo verification passed after correcting the
  harness AddRows dispatch; production table metadata updates require no catalog reload.
- Task 8 Ruling: compound paste groups existing compact schema/row/cell history
  children in one native transaction, exposing only the final root as one undo
  action. Dataset generation can advance for each child; project revision advances
  once. This reuses validated deltas without a full-table before-image. Cost if
  wrong: replay ordering or hidden-child history projection could diverge; test
  rollback, reopen, one-step undo/redo and branch pruning explicitly.
- Task 8 Ruling: observed DuckDB commit rejection when reversing cell writes
  before table ALTER in a compound undo. Replay all inverse schema deltas before
  row writes, then rebind surviving cell snapshots by stable column ID; snapshots
  belonging to columns added by this same group are omitted after their removal.
  Group frontier validation still prevents out-of-order replay. Cost if wrong:
  compound undo could restore an incorrect column; exercise case-only rename,
  added-column removal, row growth, reopened redo and rollback together.
- Task 8 compound paste qualified: two focused native regressions pass after
  observed REDs, including rollback after schema/row growth, one visible root,
  case-only rename, empty-column type promotion, reopened redo and redo-branch
  pruning. 56 native tests, four selected TS suites, typecheck and rebuilt real
  process (including formula row growth and HistoryStore compound undo/redo) pass.
  Zero full-before table copies. The process fixture needed its explicit VALUE
  column name after the case-only rename; production behavior was already correct.
- Task 8 Ruling: sorted/filtered unloaded paste resolves bounded row-ID pages
  through the existing prepared mapping and signature, retaining no cell values
  and creating no second mapping. The frontend must fence owner, generation,
  session and query signature throughout resolution. Cost if wrong: paste could
  target a different visible order; verify physical IDs and stale-query rejection.
- Task 8 row identity paging qualified: observed missing-ID submission CT RED,
  then GREEN after resolving unloaded in-range paste targets before submission.
  Backend returns only row IDs in pages <=2000, reuses the ready mapping, and
  validates dataset/generation/sort/filter independent of its value projection.
  Frontend bounds total IDs at100000, rejects duplicate/wide/incomplete/stale
  pages and fences owner/query/session before each page and mutation. Native
  focused signature RED→GREEN, 19 navigation +18 guard tests, row-ID TS and
  43 calculated/table mutation CT pass; typecheck passes after using serialized
  filter DTOs. Extending past the end of a sorted/filtered result remains safely
  rejected; natural-order tail/gap growth is supported by compound paste.
- Task 7 Ruling: a manual save retry first resolves the uncertain failed record
  operation. A committed receipt projects without another write; a cancelled
  identity is fenced before a new identity refreshes only the project revision.
  Body/setting base revisions and draft contents stay unchanged, so a real
  document conflict remains visible and cannot overwrite the saved body. If the
  resolver is unavailable, only the unchanged original identity may replay. Cost
  if wrong: stale drafts could overwrite remote bodies; new retained-conflict,
  outcome-loss and concurrent-barrier cases plus actual process verify this.
- Task 7 retry recovery qualified: observed missing outcome-resolution RED, then
  GREEN; seven selected TS suites, typecheck, seven App/history CT and actual
  frontend/native-process unrelated-revision retry and true-conflict preservation
  pass. Explicit primitive cancellation still refuses record drafts. No draft
  is acknowledged merely because its cancelled identity was fenced.
- Task 8 Ruling: named data snapshots are explicit bulk operations, separate
  from ordinary autosave. Capture native project tables and their column,
  calculated, display/filter and directory metadata into owned immutable database
  tables; expose only snapshot descriptors to JavaScript. Restore is an explicit
  atomic bulk table replacement, preserving project documents and resetting table
  history consistently with existing snapshot behavior. Ordinary open/save/close
  do not copy snapshot rows. Cost if wrong: snapshot restore could lose identities
  or overwrite newer state; qualify native types, formulas/order, reopen, receipt
  replay, injected failure and typed UI/MCP routes before enabling v5.

- Task 8 native named snapshots in progress: typed capture/list/restore/delete
  operations now keep immutable table copies inside the project; descriptors
  expose no row arrays or storage paths. Metadata-only rename reuses directory
  CAS. Three native tests cover DECIMAL/NULL fidelity, capture lost-ack replay,
  restore rollback/reopen, read-only future-writer listing and recreating a
  deleted table. Snapshot restore preserves generation, row-ID allocator and
  table directory revision high-water marks; deletion now retains those marks.
- Task 8 snapshot frontend qualified through initial integration: separate paged
  descriptor store, typed history actions/MCP create result, owner fences, and
  history reset before acknowledgement. Observed legacy-capture and missing
  panel-name REDs then GREEN; three native history CT, selected TS/typecheck,
  paging/retry/late-owner tests,18 guards and rebuilt actual process capture,
  rename, table-edit/restore and delete pass. Late/duplicate pre-restore receipts
  cannot resurrect invalid history or erase newer edits. Formula/natural-order
  and settings snapshot regressions, progress and broader App checks remain.

- Task 8 named snapshot slice qualified: five native tests include formulas, natural order, display/filter settings and progress completion only after commit; five selected TS suites and 11 integrated App/history CT pass. Listener-registration failure retry and successful-close cache reset each observed RED then GREEN. Final rebuilt frontend/native process create/rename/edit/restore/delete passes. Actual Tauri manual acceptance remains separate.
- Task 8 Ruling: Fit Model saved columns use a transaction-neutral native writer and retain only the selected output columns for redo. The current legacy implementation copies the entire source into a replacement table, which is unsuitable for native projects; legacy behavior remains while native output reuses compact column history. Cost if wrong: diagnostic values or excluded-row NULLs could change; verify identical fit semantics, rollback, replay and reopened undo/redo before qualification.

- Task 8 saved-fit-column integration: native rollback/replay/reopened undo/redo and zero full-before-copy tests pass, selected TS5 and UI CT8 pass, legacy fit service8 and guards18 pass. Diagnostic writes use bulk appender staging plus one join update per output column, avoiding one source scan per fitted row. Real-process testing then exposed legacy history snapshot validation rejecting an added-column value snapshot; this is a genuine integration RED. Qualification stays pending until an explicit valued-add history operation passes archive validation and actual process replay. An initial process fixture also needed a supported harness command and the DatasetMeta colCount field; those test fixture errors are corrected.
- Task 8 Tabulate output brief and frontend context RED prepared; backend test is staged in scratch after observing missing native method RED. Keep this slice behind the saved-fit-column integration repair to avoid unrelated compile errors blocking its regression tests.

- Task 8 Ruling: add_valued_columns is a distinct compact history operation requiring exactly one controlled column-value snapshot, while metadata-only add_columns continues forbidding snapshots. Update both delta/timeline validators and replay schema transitions together. Cost if wrong: drop/undo/archive reads could reject otherwise committed history; observed real-process failure is now covered by native archive_unified_history RED before the fix.
- Task 8 Ruling: Tabulate materialization resolves its existing prepared definition only inside the receipt-protected commit closure, then recreates bounded distinct member indexes in the sole writer using the same aggregate SQL. It does not copy source rows or mutate through a reader connection; temporary maps are dropped before publication. Cost if wrong: transient member-index memory could duplicate a ready session or source identity could drift; preserve the existing budget and verify source CAS, stale session and rollback/replay explicitly.

- Task 8 saved-fit-column slice qualified: explicit add_valued_columns history now passes its archive_unified_history regression RED→GREEN and real-process save/undo/redo/deletion. Native rollback/replay/reopened history passes with only row ID plus two output columns retained, zero full-before copies. Archive117/history6, legacy fit8, commands4, guards18, selected TS5, typecheck and UI CT8 pass. Actual Tauri acceptance and release large-data performance remain open.
- Task 8 Tabulate primitive now commits through the native writer and returns metadata only. Focused rollback/released-session replay/reopened exact aggregates passed; source omission/staleness tests and full Tabulate regressions are now running. Receipt metadata includes both source precondition and new output by the existing transaction contract; adjusted the test to assert both identities and unchanged source generation.

- Task 8 Tabulate output slice qualified: focused source omission/staleness, rollback, replay after released session and reopened exact NULL/mean outputs pass; full Tabulate82, guards18, column-delta16, selected TS5 (command22), typecheck, CT28 and rebuilt actual frontend/native process pass. Existing static wrapper-count test required one shared command constant across native/legacy branches; no production routes were removed. Table-creation undo remains a separate enablement gate.
- Task 8 workflow run brief prepared. First implement shared side-effect-free receipt/context preflight so expensive staging never reruns a committed operation, while final publication still revalidates CAS. Preflight RED is running.

- Task 8 Ruling: expensive native execution gets a side-effect-free preflight using the exact same envelope, receipt/cancellation and CAS validators as final commit. It reserves nothing and cannot replace final validation. This prevents replay from depending on now-missing inputs/staging while allowing writers to reject a stale first attempt before staging. Cost if wrong: a stale or cancelled computation could stage data; tests verify no revision/cancellation mutation and final publication still checks context.
- Task 8 preflight primitive qualified: missing-method RED→GREEN,11 transaction tests (including shared cell rollback),63 project_v5 regressions and rebuilt actual frontend/native-process integration pass. Workflow public execution itself has not migrated yet; no enablement claim.

- Task 8 workflow public integration in progress: native definition/source preflight, staged server execution, packet/table/document publication and receipt acknowledgement are wired. Native authority/rollback/lost-ack/reopen test passed after correcting the copied legacy test fixture's boundary port name to the canonical output required by the catalog validator. Native frontend queue transport and project-switch fence pass; initial static store import caused an actual module initialization cycle, fixed by runtime imports inside async service methods.
- Task 8 Ruling: native workflow determinism reads comparable committed run metadata one record at a time in Rust, never the client's previousRuns baseline. Query filters workflow/configuration/seed/engine first, then the existing canonical identity/fingerprint comparison chooses the earliest comparable run. Cost if wrong: altered client history or omitted lazy history could cause false divergence; forged-client-baseline native RED→GREEN verifies persisted authority. Semantic execution failure is persisted as a failed run without outputs; persistence/ownership/cancellation errors remain errors. Native cleanup errors propagate before acknowledging a failed run.

- Task 8 workflow output coverage: public graph and table routes pass authority, rollback, outcome-loss replay, exact sorted values and reopen.18 workflow/App CT and rebuilt actual graph/failed-run frontend/native-process path pass; all output values remain native. The table test fixture's source generation was corrected to the actual value after its seed edits.
- Task 8 Ruling: a small workflow-run metadata index stores only the run record, excluding document packets. Existing opt-in metadata is backfilled only inside the first explicit workflow transaction; ordinary reads use a no-write fallback. Commit revision orders native runs; legacy timestamp/id orders prior entries. Cost if wrong: latest output bindings could change or metadata reads could parse large packets; no-write/2MB-unparsed-body/bounded-result/rollback/readonly tests and selected-state frontend identity fences cover this.
- Task 8 Ruling: malformed workflow input/output binding envelopes are rejected before staging rather than saved as executable failed-run history. Semantic compute failures still persist after cleanup. Cost if wrong: invalid request bindings could poison the latest-binding state; validate declared identities before execution.

- Task 8 workflow selected-state slice qualified: native metadata index/no-write legacy fallback/rollback/readonly regression and public graph/table tests passed; executor12, guards18, selected TS6/typecheck and App/workflow CT17 pass. Rebuilt actual frontend/native process preserves custom bindings and run counts across reopen, without run-packet hydration or feedback writes. Added selected-workflow run-count UI RED→GREEN; combined lazy-hydration/workflow CT25 pass. Only selected definitions fetch run metadata; ordinary open and lineage do not. Fetched origin/dev on 2026-10-22; base remains 3a362f6. V5 remains disabled; table lifecycle undo, remaining import aliases, migration, release performance/crash and native acceptance remain gates.

- Task 8 Ruling: server/Postgres native imports hash the connection definition and username as stable source identity, excluding password; they resolve the same typed durable receipt before connector construction. Password rotation or unavailable credentials do not invalidate a committed import, while changed connection/object/target conflicts. Cost if wrong: replay could connect unnecessarily or return another source's receipt; cancellation/stale-preflight and seeded lost-ack/source-change tests cover this without network credentials.
- Task 8 server import public adapter slice: observed native missing-method RED and frontend unqueued-envelope RED, then GREEN. Two native preflight/cancel/seeded-receipt tests, server primitive cancellation1, guards18, legacy IO12 (3 external-source tests ignored), selected TS6, typecheck and DataLink CT4 pass. This qualifies transport and transaction/replay boundaries only: actual PostgreSQL/MySQL source streaming remains an external fixture gate, not a claimed passing live import.

- Task 8 table lifecycle storage brief prepared. Ruling: retire the active dataset metadata row while retaining its original physical table, column/formula metadata, natural-order anchors and incremental history under project ownership. Restore issues a fresh generation and re-fences retained history; no full row copies or anchor rebuilds. Public retirement must atomically remove catalog/settings/dependent graph entries and authorize restore through typed lifecycle events. Cost if wrong: hidden IDs or stale history could remain usable; primitive tests cover storage identity/rollback/reopen/replay, later public integration must cover visibility, conflicts, snapshot coexistence and redo pruning before enablement.
- Task 8 storage regression initially used the legacy archive serializer against native-only cell_delta history, which that legacy format rejects. Replaced that fixture assertion with native retained-timeline metadata and actual reopened undo; do not expand legacy archive format or claim native archive export support.

- Task 8 lifecycle storage primitive qualified: missing-function RED, then reopened cell-undo stale-fence RED→GREEN; identity-high-water RED (1 vs required10)→GREEN. Retains original physical table, exact BIGINT/DECIMAL/NULL values, metadata and compact history across reopen. Restored generation and allocator respect retained maxima, with zero full-before copies/full anchor rebuilds. Full selected project_v5 suite70 passes. Primitive is not yet used by public deletion; lifecycle event/catalog/UI/snapshot coexistence gates remain.
- Task 8 workflow count refresh regression: observed editor remount clearing the selected source when run metadata refreshed; separate selected metadata effect now preserves the input, RED→GREEN. First fixture had no required schema and correctly disabled its input; supplied a required DOUBLE column before reproducing the actual state-loss failure. Typecheck and combined App/lazy/workflow CT31 pass.

- Task 8 lifecycle event primitive: shared ordinal allocation, explicit event revision, combined ordinary/lifecycle frontier and same-transaction acknowledgement now pass the missing-function RED→GREEN. Metadata reads do not create tables; injected precommit failure rolls back table/event creation, and postcommit outcome loss replays without publication. Both redo-branch directions observed RED (ordinary edit vs lifecycle deletion)→GREEN through one shared cleanup hook in record_history_timeline. Lifecycle suite20 and legacy history6 pass. Public deletion/creation routes remain unmodified until catalog/settings/dependent-document restoration, full replay guards, native UI and snapshot coexistence are qualified.

- Full Rust audit after shared history cleanup:1725 passed,3 failed,20 ignored. OLS warns_in_required_order_when_multiple_conditions_apply is the already proven clean-dev baseline. Two branch failures require repair: data_commands_expose_compact_mutation_contracts still asserts pre-native column return types; delta_history_archive_pre_generation_field_preserves_later_legacy_generation expects the existing legacy redo behavior. Ruling: authoritative redo pruning belongs to project-owned v5 storage; preserve the existing temporary/legacy archive behavior. Cost if wrong: native abandoned branches could survive or legacy archives could lose usable history; verify the legacy migration regression and native reorder/lifecycle branch tests together.
- During resolver audit, found a public-result projection hypothesis: native create-from-rows/SQLite/server map stored internal receipt values after persistence. A focused brief now requires native lost-ack public-value reproduction before any fix; this takes precedence over further lifecycle public integration.

- Full-suite failures repaired in targeted runs: command boundary contract now uses compile-time function types and legacy column-result serialization, avoiding stale source-text signatures; legacy generation/archive regression passes after scoping redo pruning to persistent-project storage. Native v5 keeps authoritative branch cleanup.
- Task 7 public receipt result bug confirmed by two native lost-ack REDs (DatasetMeta name and ImportSummary status both missing), and a real frontend/old-native-process RED returning ManagedTableCreateResult instead of DatasetMeta. Ruling: project public values before receipt serialization in the original transaction, using shared output writer result callbacks; do not reinterpret internal receipt values in JavaScript or rewrite stored receipts. Separate create-from-rows vs managed-create command digests because their public values differ. Cost if wrong: outcome resolution could acknowledge the wrong API shape; require normal/resolve/retry equality and no-source replay. Native tests2 now GREEN; rebuilt process and full-suite regressions are running. Offline server replay fixture now seeds the public summary that its writer persists. Experimental old internal-value receipts are not silently converted.

- Task 7 public-result receipt slice qualified: two native lost-ack/no-source tests GREEN, rebuilt actual frontend/native-process normal/resolve equality GREEN for DatasetMeta and ImportSummary. Full Rust rerun:1729 passed,1 failed,20 ignored; the sole failure is the previously proven clean-dev OLS warns_in_required_order_when_multiple_conditions_apply (predictor mean missing for X1). Both new full-suite failures are repaired; no other regression remains in this run. V5 is still disabled and lifecycle catalog/public replay remains in progress.

- Task 8 catalog retirement primitive qualified: expected missing-handler RED→GREEN; two native tests preserve an unparsed ~1.8MB graph body, unrelated graph, exact rows, settings, fresh revisions, folders and reopen. Expanded conflict coverage: changed setting or reused graph ID rolls back row reattachment and preserves current data. Both filter/display keys get tombstones even when originally absent. Observed non-null hidden-table settings-write RED→GREEN by rejecting writes whose table metadata is missing (null tombstones remain allowed; stale revision checks still run first). Retirement4, catalog12 and project_v5 suite80 pass. New public deletion/replay/receipt/UI/creation-event and snapshot cleanup integrations are still pending; default remains disabled.

- Task 8 selected event validation and unified cursor qualified: unknown operation/zero revision/empty dataset/out-of-range ordinal/future commit metadata RED→GREEN; ordinary replay now shares lifecycle frontier validation, with grouped redo first-child handling. Six event tests pass, including create/delete/edit undo/redo ordering. Temporary/legacy history behavior remains unchanged.
- Task 8 native service deletion/replay facade qualified in focused test: delete now retires original storage and owned metadata/history instead of dropping it. Added epoch-bound selected getter and event-revision replay, preserving public void result shape. Native public-facade missing-method RED→GREEN covers reopen, rollback, lost-ack resolution/replay, exact >2^53 integer, unparsed graph restoration with fresh revisions, stale-event rejection and original row-history undo/redo. Zero full-before copies and full anchor rebuilds. Existing deletion test now requires retained history. Full native regression is running; IPC registration/receipt history collection/UI/creation hooks/snapshot invalidation remain pending.

- Task 8 lifecycle continuation: selected lifecycle IPC compile contract 1/1 and mutation guards 18/18 passed. Snapshot cleanup regression and project_v5 subset 83/83 passed before subsequent creation hooks. The retained table's public undo/redo receipt now includes the indexed lifecycle history summary, name and atomic active generation (including empty-table generation 0).
- Task 7/8 frontend lifecycle: new receipt test observed RED because directory deletion removed executable history. GREEN retains typed tableLifecycle actions, metadata-only native undo/redo, lazy graph restoration and late receipt/snapshot fences. Dataset header insertion requires a matching table directory entry and valid counts, retaining unloaded-ID boundary. Existing metadata/deletion and lifecycle transport suites all passed, typecheck passed, nativeHistoryPanel CT 5/5 passed including hidden-table operation/name labels. Reopened executable history hydration remains pending; no qualification inferred from labels.
- Task 8 creation hooks: public create-rows lost-ack test observed RED for missing create_table receipt; expanded SQLite test checks one typed creation event and output-marker deduplication. Hooks now implemented across managed, CSV, SQL, SQLite new-table, server, transform initial output, Tabulate and workflow initial outputs; selected native regression is running. Existing-table append/rerun paths retain ordinary publication. No implementation commit or feature enablement.

- Task 8 creation lifecycle/native-process: native subset 84/84 and actual frontend/native process pass (delete undo/redo, lazy graph metadata restore, source-free receipts and snapshot reset). Generic document deletion now retains revision watermarks; RED demonstrated original graph restore falling from deleted replacement99 to5, GREEN restores at100 with exact raw body. Compound paste plus creation frontier and empty snapshot hidden-storage regressions added; full Rust running.
- Task 7/8: Ruling: reopened keyboard history uses a native metadata-only frontier reader and original-commit introduction index. Existing UUID-paged history remains presentation metadata, not a chronological executable stack. Old experimental v5 files without introduction metadata retain deterministic per-table fallback without write-on-open or receipt-payload scans. Cost if wrong: ordering/query changes before v5 enablement; no lost table data or body hydration. Supplemental brief specifies direction/frontier/owner tests.

- Task 8 reopened history: metadata frontier subset 86/86 and selected actual reopen replay2/2 passed; frontend lookup/cache-boundary/edit-lock regressions RED→GREEN. Rebuilt process exposed a real cross-table redo error: native pruning was per-table, while existing frontend recordIncrementalEntry abandons a global future. Redo after delete undo selected an older unrelated table action.
- Task 8: Ruling: new executable native table actions prune abandoned redo across the project, matching existing global frontend history semantics. Cleanup removes only explicitly abandoned ordinary history and lifecycle-owned hidden creation storage/metadata; retain identity clocks and active tables. This is a correctness requirement exposed by actual process replay, not an ordering workaround. Cost if wrong: storage-retention/redo cleanup changes before enablement; source files and current active tables must remain protected by regression tests. Two native cross-table/hidden-owner regressions running RED before implementation.
- Full Rust before new frontier code: 1738 pass/2 fail/20 ignored; one known clean-dev OLS failure, one new creation+paste fixture incorrectly seeded a lifecycle event without its original commit. Corrected the fixture to publish through a real receipt transaction; subsequent project_v5 86/86 pass includes that grouped-paste frontier. A fresh full run remains required after frontier/global-pruning implementation.

- Task 8 global history GREEN: native subset89 and actual frontend/native-process fallback now pass after project-wide abandoned redo cleanup. Fresh full Rust: 1743 passed, 1 known clean-dev OLS failure, 20 ignored (210.33s). Additional selected native4 verifies cleanup rollback restores hidden storage/redo metadata and committed lost-ack retry publishes exactly once. No all-green full suite claim.
- Task 7/8: Ruling: native undo/redo always selects the authoritative metadata frontier, even with a populated local cache. A stale local cursor after lost acknowledgement must not select a second undo instead of redo. Local history remains presentation metadata; an extra single-action metadata request replaces cache authority. Cost if wrong: small replay lookup/ordering adjustment, no row/history-body hydration. Stale-cache and lost-ack-resolution TS regressions pass.
- Task 8 UI: native workspace shortcut restores/deletes a hidden table with no table component, row windows or graph bodies. Text-edit undo/read-only mode and no duplicate DataTable dispatch are qualified. Error notifications now remain visible when no table editor exists and retry succeeds. CT24 plus two new cell/keyboard CT pass, typecheck passed.
- Task 8 route audit: found active inline/formula-bar updateCell paths still using legacy update_cell. Native alias now submits one-cell update_cells with the visible generation; legacy response stays void. TS RED→GREEN, real DataTable cell edit with generation0 and actual frontend/native-process formula/undo pass. Standalone .sptb import remains active and unconverted; supplemental native-sptb-import brief records streaming sink and receipt tests next.

- Task 8 standalone table import: native/TS RED observed against missing receipt path. GREEN native3 verifies exact BIGINT/DECIMAL/NULL, source hash, rows-before-header, serialized order with row ID3000000000, allocator, disk uniqueness, cancellation, source-free replay/reopen, V3 UUID/formula remap and subsequent formula recalculation. Before-commit rollback and committed lost-ack retry preserve exact public {id} receipt. Native IPC/harness branch and legacy-compatible response wrapper are wired; shared parser/archive/guard and real-process regression running.
- Task 8: Ruling: standalone native table import uses a transaction-neutral typed sink borrowing the sole project engine, reusing archive validation/decoding/remap helpers. It never calls legacy AppState restore, nests transactions or writes a staging database. Reordered JSON fields take a metadata-only scan plus the bounded parser; serialized row order and exact positive i64 IDs survive, with BIGINT physical IDs and a native unique index. Cost if wrong: archive compatibility/order adjustments before enablement; source hashes and project rollback are explicit gates. Full legacy archive migration is not qualified by this route.

- Task 8 standalone import regression qualified: shared reader9, restore5, archive117, mutation guards18 and native IPC compile contract1 pass. Selected TS8/typecheck and rebuilt actual frontend/native-process source-free receipt/reopen pass; final native catalog contains20 non-folder entries. This remains a bulk initial import, not a claim about measured RSS or archive migration.
- Task 7: Ruling: native body/directory revision clocks advance across deletion and recreation of the same UUID. Fresh create revision1 remains a client proposal; the native writer assigns max(current, retained watermark)+1 and returns it in the original receipt, without rewriting domain configuration revisions. Cost if wrong: proposal/ack integration changes before enabling v5; stale hydration, rollback, following edits and read-only reopen must remain covered.
- Task 7 document-clock slice qualified: observed native recreate1 versus expected2 RED, then4 selected tests GREEN, including rollback/no consumed clock, stale read/update rejection, moves and read-only reopen. Rebuilt actual frontend/native process rejects delayed original hydration and sends following edit with assigned revision. Full Rust regression is running; no retired output identity reuse claim.
- Task 7 graph-file import: observed actual component RED when imported ID belonged to an unopened Graph New document. Complete native metadata inventory now provides collision IDs, with project ownership fenced across dialog, file read and metadata read. CT GREEN retains both original and imported graphs, preserves missing-source configuration, reads zero bodies; typecheck passed. Existing legacy ID behavior retained.

- Full Rust after standalone import/shared parser/document clocks:1748 passed,1 known clean-dev OLS failure,20 ignored,117.15s. No new test failures. Application route TS12 passed before an incorrectly named next test path stopped that batch; corrected discovered history paths and4 suites passed separately. This is a runner invocation error, not a product failure.
- Task 7/8 route inventory refreshed using actual frontend callers: native empty-table and inline-cell aliases map to typed creators/update_cells; native history skips legacy apply_added_rows/drop cleanup; old table transform, row/column, all-SQLite and raw snapshot wrappers have no active native caller and reject legacy permits. Active server fixtures, final Tauri acceptance and deleted-output rerun remain explicit gates.
- Task 12 migration has begun with native preflight/source collision/cancellation/live-session preservation tests. Observed missing-service compiler RED. Ruling: migration may use isolated transactions inside its unpublished operation-owned file because legacy history restore owns its transactions; the atomic publication boundary is the entire validated, closed and flushed file. It never routes through legacy AppState or switches the live owner before validation. Cost if wrong: only operation-owned temporary output is discarded; no partially migrated destination or source rewrite is permitted.

- Task 12 migration baseline3 GREEN: legacy JSON data imports directly into an isolated native file; atomic no-clobber publication, source/sibling preservation, cancellation, malformed duplicate rows, unchanged live session and read-only reopen pass. Native lifecycle migration transport observed missing-method RED→GREEN; captured flush failure prevents migration, malformed migration retains owner/drafts/listeners, success replaces metadata session. Lifecycle TS3 and typecheck pass.
- Task 12 migration corpus5 GREEN before later analysis conversion: actual legacy saver archive preserves formula and stable column IDs, generations, exact timeline/current redo cursor and post-migration formula recalculation/reopen. Its ZIP wrappers with version2/3/4 exercise format detection and history loading; these are not independently historical v2/v3 fixtures. Report bodies, folder assignments and empty nested folders are retained. Additional historical-shape fixtures remain required.
- Task 12: Ruling: migrated legacy named snapshots retain their public IDs, including old h_ IDs, while their descriptor owns a UUID storage key. Stream snapshot tables before active tables in the unpublished project, retain small native metadata copies, and adopt row storage by rename rather than copying rows again. Ordinary native snapshot IDs/layout remain compatible. Cost if wrong: snapshot ownership/restore/delete compatibility before enablement; test exact source/live values, display properties, stable IDs, read-only reopen and old native snapshot regressions.
- Task 12 named snapshots observed unsupported-conversion RED→GREEN. Follow-up RED demonstrated generic commit_project_records could rewrite snapshot storage ownership. Generic body creation/update/deletion of snapshots now requires the typed snapshot operation; directory rename remains available. The same native5 suite passed with generic update/delete rejection, exact restore and source hash preservation.
- Task 12 analysis conversion observed unsupported legacy-record RED, followed by a real stale-manifest-ref failure after converting Fit Y by X. Converted body and manifest projections now agree before lineage rebuild. Native6 GREEN matches the current frontend compatibility fixture for Distribution, Fit Y by X and Fit Model bodies/folders and retains source hashes. Fixture expected output comes from current hydrateAnalysisProjectPayload and is checked separately by TS. Malformed/colliding legacy analysis variants and workflow bindings still require qualification; no full migration-completion claim.
- Task 12 publication audit: added source-type retention and late source-change/destination-collision/cancellation/project-switch regression cases; RED running. Migration publication must not replace a newer live project after long staging. Current implementation has no public IPC/UI migration wiring yet; native lifecycle transport exists but must not be exposed until service compatibility gates are met.

- Task 12 publication RED confirmed two real defects: migration reset archived csv sourceType to manual, and an intervening native project switch was overwritten at final migration publication. Source type now survives the neutral sink (standalone import still overrides to sptb in its original transaction). Publication compares captured native owner under project_transition and holds that lock across no-clobber rename, destination reopen and native installation; no recursive transition lock. Late source/collision/cancellation/switch and all native7 migration tests GREEN. Source/sibling/newer live project remain untouched on rejection; operation-owned temporary files clean up.
- Task 12: Ruling: a failure after successful destination publication retains the validated destination and reports project_migration_destination_published; never delete a newly published user copy to hide an open error. Source validation/close/flush happens before the transition, and owner CAS happens before rename. Cost if wrong: frontend must distinguish a published copy from a failure before publication; dedicated post-publication fault/IPC/UI handling remains a qualification gate.
- Task 12 native project_v5/snapshot/archive regression is running. Migration still needs independent historical-shape fixtures, richer workflow/binding/type/formula/row-history corpus, global archived-history ordering, error/identity variants, public IPC and explicit UI migration choice before task completion or feature enablement.

- Task 12 regression after publication fixes: native project_v5 100/100, native snapshots6/6 and legacy archive117/117 pass. These counts precede the later global-order/row-history tests; no fresh full-Rust all-green claim.
- Task 12 global history observed cross-table RED: alphabetical per-table fallback selected A although archived frontend history's latest action was B. GREEN restores known executable change-set introduction order from archived action metadata. Original raw records are retained in a native imported-history table, never read by ordinary open/paging. Non-executable old frontend records are preserved but not promoted to invented native replay actions; their presentation/compatibility remains an enablement gate.
- Task 12: Ruling: archived global order occupies the initial native revision range, with the original project UUID replaced by the new native UUID. New commits follow that range, so newer native edits cannot sort behind imported actions. No old native receipts are fabricated. Cost if wrong: initial revision numbers need not start at0; owner/receipt consumers use returned revision, not an assumed zero. Cross-table undo and read-only reopened redo/source-hash tests pass in native8.
- Task 12 row history observed a real RED: a migrated double-insert table displayed in serialized order but undo rejected the published natural-order range. Ruling: for tables with executable row history, reconstruct hidden current row coordinates from restored before/after snapshots, applied row deltas and undone rebalance metadata in native temporary tables. Validate against independent serialized visible order before publication; update only hidden coordinates through an explicit bulk boundary and rebuild that table's anchors. Ordinary open never calls this. Cost if wrong: an inconsistent old archive fails migration safely; this initial conversion uses an additional native metadata map/scan, not a second value-table copy.
- Row-history reconstruction/native9 GREEN after correcting a test-only raw ORDER BY _row_order query to the application's actual COALESCE natural-order expression (legacy base rows intentionally have null overrides). The initial undo-range RED was a production defect; the intermediate NULL-sort assertion was a fixture error. Expanded tests now include a real local rebalance, repeated replay and independent nested v2/v3 table-v1 files without folder/generation manifests; qualification running.

- Task 12 older/history corpus11 GREEN: independent nested v2/v3 table-v1 paths without folder/generation metadata retain exact BIGINT/DECIMAL values, display width and derived folder paths; 80 insertions actually trigger local key rebalance and repeated native undo/redo retain visible order. Corrected the older fixture to encode its historical tables/ path instead of omitting folder metadata from a modern flat data/ path. No production folder workaround.
- Task 12 metadata preflight RED→GREEN: preflight now reads only legacy JSON version metadata or the ZIP manifest header; complete table/history validation occurs only during explicit conversion. Native12 passed. Source archives with a readable header and malformed body can reach the conversion choice, but actual conversion rejects them before publication. Ruling: preflight identifies format/collision, not full validity — avoids pre-confirmation data hydration — cost if wrong: malformed payload is reported during conversion, with source/live project preserved.
- Task 12 undone-rebalance cursor passes separately: saved native history with20 undone actions across an actual rebalance can redo and undo after migration. Post-publication fault injection verifies a valid new copy survives an open failure while the old live owner/hash remain unchanged; structured migration outcome marks destinationPublished.
- Task 12 source-replacement RED confirmed a preflight race: the source could change after preflight and be accepted as a different import. Source stamping now begins before preflight, actual archive version is revalidated, and source/cancellation guards run again under the final transition immediately before publication. Both after-preflight and after-flush replacements reject publication and preserve the external replacement. Full migration15 GREEN (14.93s).
- Task 12 frontend outcomes: request identity and structured publication-failure RED→GREEN. Failed conversion, published-but-not-open copy, and malformed source preserve the original frontend owner/drafts/listeners; success installs metadata session. Selected TS4 and typecheck passed. Explicit open-with-migration helper separately observed missing-module RED→GREEN for native bypass, explicit confirmation, chooser cancellation, destination collision and ownership fences.
- 2026-10-26 continuation: fetched origin/dev again; HEAD/origin/dev remain3a362f6. No implementation commit/push/PR; v5 remains disabled. Cancellation registry observed missing-owner RED→GREEN; scope is one active conversion per AppState, with canonical UUID request identity and operation-owned drop cleanup. Ruling: serialize full conversions per application instance to bound staging resources, without global cross-AppState state — cost if wrong: concurrent conversions wait/reject until the current one completes. Public IPC contract/owned-cancellation tests observed missing-entry RED; command registration and typed outcome/progress adapters now implemented, verification running.

- Task 12 public IPC commands2 and mutation guards18 GREEN. Workspace conversion prompt/save chooser/progress/cancel integrated after two actual component RED failures. All22 lazy Workspace CT tests and typecheck pass; native cancellation controller covers early registration intent, in-flight deduplication, disposal and IPC errors. Ruling: cancel is an intent until the native operation outcome arrives; a published success wins a late cancel. Retain early intent and resend only once when the native request announces registration — cost if wrong: cancellation may finish as success but must never misreport a durable copy as discarded. Native registration RED observed; initial progress notification added, real-process migration verification in progress.

- Task12 native registration1 GREEN, actual frontend/native process conversion plus incremental note/reopen GREEN, original native adapter regression GREEN. The process fixture was corrected to use supported v1 dataset fields (v1 did not support report bodies) and compare canonical macOS file paths after reopen; no production compatibility workaround. Full-domain fixture from current frontend constructors qualifies legacy/new graph/report/tabulate/workflow/run output binding/transform binding/filter/logical folders/lineage and readonly reopen, exact bodies/settings/output value/source hash retained.
- Task12 archived history missing-row native RED and missing-label component RED observed. Migration now builds bounded description/timestamp metadata for nonexecutable legacy entries, retaining complete raw JSON separately. Executable table history is excluded from this projection and keeps native undo. Native archived history1, History CT6 and typecheck GREEN. Ruling: preserve nonexecutable frontend history as visible read-only archived rows, never as synthetic native replay actions; descriptions are capped at512 characters/timestamps128 in the summary only — cost if wrong: incomplete legacy undo coverage or abbreviated labels; original payload remains recoverable and native executable cursor tests remain gates.

- Integrated Rust run:1767 passed,2 failed,20 ignored (134.70s): known clean-dev OLS plus a new source-contract failure because migration bulk row-order restore added a second UPDATE template inside the canonical boundary. Kept the single-template source contract intact; both typed ID and map routes now use one private executor, with no per-row migration loop. Source-contract RED→GREEN; affected migration/history/full regression still required. Production frontend build passed.
- Task7 authorized CSV read barrier audit: shared native engine selection was already correct; actual gap was pending-write/epoch ordering, not wrong database storage. Frontend observed export-before-write RED→GREEN for captured flush, rejected flush, stale owner and unchanged legacy arguments. Native missing API RED→GREEN verifies exact918 CSV bytes/epoch-required and stale no-output. Final authorized-publication transition lock race test is being added; other export variants remain unqualified until separately audited.

- Fresh integrated regression after canonical boundary/export race fixes:1769 passed,1 known clean-dev OLS failure,20 ignored (129.95s). No new failures. Authorized CSV security/export13 passed,3 live-server tests ignored. Combined app/history/report/Workspace CT35 passed; selected TS12/typecheck and production build passed. Ruling: native authorized CSV stages through the captured reader, then holds the lifecycle transition only for owner revalidation and atomic publication — cost if wrong: stale-project external file publication; close-during-staging/no-target and source918-byte tests cover it. Other export variants still need inventory qualification.

- Task12 invalid Fit Y by X native RED confirmed a graph-role mismatch accepted by migration but rejected by the existing frontend. Added role-matched2D validation before wrapping the document; all19 migration/request tests GREEN, including malformed graph/personality/same-field/identity/history cases with unchanged source and retained live owner. Historical v2/v3 corpus now explicitly serializes table rows before column/header fields and passes exact value/ID/folder tests. Generator uses deterministic layer IDs.
- Task12 complete via task-done: migration19, archive117, native command2, canonical boundary1, rebuilt actual native conversion/adapters, TS4/typecheck and CT28 all passed. Old-mode opening remains default; archived nonexecutable history is explicitly read-only, executable native table cursors remain independent. No implementation commit/push/PR or Tauri/manual acceptance.

- Task7 remaining export variants observed all7 dispatch-before-barrier RED, then common frontend captured-flush/epoch adapter GREEN; legacy arguments retained. Native export project lease observed missing-helper RED; seven CSV/SQLite/sptb command routes now require matching epoch and hold the selected lifecycle until completion, qualification running. Ruling: explicit bulk file exports retain the existing shared engine export implementation under a project transition lease; ordinary opens/saves/edits do not acquire this export lease — cost if wrong: project switching waits for a user-started bulk export, and large exports may contend with the writer; this is not a claim of reader-parallel export performance. Authorized CSV keeps its shorter reader/staging/final-publication lease path.

- Export variants: native project lease1/typecheck and table export dialog CT6 passed. Standalone table export fixture initially hit forbidden VALUES and range-table-function query syntax; those are runner fixture failures, not accepted RED evidence. Replaced fixture setup with typed managed rows. Correct RED now proves persisted native width177 is omitted by the legacy in-memory display map; a separate row-order assertion is being qualified before restoring the native projection/order fix.

- Native standalone export now has actual product RED evidence: widthNone versus177, then visible row IDs[1,2] versus[2,1] using a typed two-row fixture. GREEN after native compose reads stable persisted display settings and NATURAL_ORDER_SQL; legacy compose behavior remains unchanged. Seven-variant frontend and project lease tests pass, CT export6/typecheck pass. Extended real native process test observed missing export bridge RED; rebuilt bridge qualification is running and will verify actual CSV/SQLite/sptb data after migration.

- Export inventory slice qualified: actual native process executes all7 variants with exact CSV/SQLite/sptb values and width177. A double clearMocks after deleting its test window initially masked the successful run; corrected test cleanup and rerun exits0. Existing native-adapter regression, export16, guards18, default-disabled1, TS4/typecheck and CT6 pass. Native bulk exports hold lifecycle selection; authorized CSV uses its short final-publication lock. Remaining derived-output rerun audit is now running.

- Retired transform output actual native-process RED: after deletion undo, context guards generation3 but persisted last-run binding still carries2, so rerun incorrectly rejects. Native transaction now derives the replacement generation from the actual output already protected by the context; definition/binding CAS remains intact. Real native-process GREEN verifies deleted-output rerun queues nothing, undo retains exact prior row/value, restored rerun keeps output identity and latest saved binding survives reopen. Updated the test's later binding expectation to this additional successful run (4 instead of previous2). Workflow retired-output durable-failure/undo/rerun qualification is running.

- Retired workflow table RED reproduced duplicate retained column metadata when a rerun tried to reuse the deleted output ID. Native preflight now identifies retired table outputs before staging and records a durable failed run with undo guidance. GREEN verifies unchanged hidden SUM6, no staged leaks, undo restores ownership and valid output document/generation preconditions permit rerun; old receipt still replays after reopen. Workflow12/output8 plus selected TS5 pass. Ruling: fixed derived output identities remain reserved by native undo; users undo deletion before rerunning rather than overwrite retained storage — cost if wrong: output recreation needs a separate explicit product design; no silent row/history replacement.
- Live-server gate: postgres/mysql executables absent on PATH; Docker CLI exists but daemon socket is unavailable, and local fixture ports55432/53306 have no listeners. Prepared SELECT-only, localhost-only, tmpfs PostgreSQL16/MySQL8.4 Compose fixtures and real native import/cancel/lost-ack/reopen tests; Compose config validates, test compile in progress. No Docker startup/container creation/image download has been performed. This environment gate does not qualify live server imports.

#### Task 13 recovery ruling and evidence
Three real killed-process recovery cases passed (`task-13-dirty-marker-green.log`): committed cell/document state and source-free receipt replay, pre-commit rollback, and dirty unmarked/future application-header rejection. Nonempty WAL requires writable engine recovery; clean files retain raw readonly application-header validation before writer acquisition. Readonly dirty opens reject without changing database/WAL bytes. For writable dirty storage, DuckDB may replay/checkpoint committed storage before the application marker is checked, but no application schema initialization or upgrade is performed. Rejected dirty storage is therefore not guaranteed byte-identical. No full copy or manual WAL deletion is used.

Bulk-work evidence will count actual archive append/write, physical or logical whole-database copy, coarse history before-image and full anchor rebuild boundaries. Fresh-process positive controls must make each relevant counter nonzero before ordinary lifecycle zero counts can qualify. Native backend timing and UI readiness remain separate; unavailable OS/UI measurements cannot be substituted with zero.

#### Task 13 counter and collector progress
- Five real child-process integration tests pass: two forbidden-work/positive-control cases plus three crash/recovery cases (`task-13-process-integrated-green.log`). Positive controls exercise actual legacy archive open/save, native Save As, coarse table history and anchor rebuilds; each relevant boundary increments. Ordinary catalog/navigation/scroll/edit/close samples retain zero bulk counters. Navigation uses the same 500-row service route as the table UI. Durable edit verification reopens the file outside timing.
- Sixteen budget/runner/fingerprint tests pass (`task-13-runner-green.log`), including failed-sample rejection, explicit cold OS cache evidence, immutable reports, untracked/removed source changes and refusal of a binary from another source tree before seeding.
- Source fingerprint is embedded at build from canonical path/status/length/content over the shared source scope list, including uncommitted/untracked source; Git hash-object runs without writing objects/index. Collector verifies the current fingerprint before seeding and after each process. Documentation/measurement output does not affect source identity.
- First collector smoke raw reports are retained under `docs/performance-reports/issue282-20261026-native-collector-smoke-01/`. All five scenarios ran two samples with logical checks and actual macOS process IO/sampled RSS; assessment correctly returned unqualified. This is debug plumbing validation, not budget evidence. Source fingerprint5ebd4ebb151afd71c2db62437e002feae47b2cfc; report/profile/source values were read back.
- Ruling: native-only probes report UI readiness, frontend retention, checkpoint-write bytes and SQL-profile evidence unavailable instead of inferring them from native payload/file lengths — these quantities require separate observation — qualification remains blocked until those observations and the release fixture matrix exist.
- Catalog/close process IO includes temporary database lifecycle writes; an untimed diagnostic probe confirmed project file SHA-256 unchanged across metadata catalog reopen. Do not equate whole-process IO with project-file IO or claim zero disk writes.

#### Task 7/8 integration refresh
Native `project_v5`112 passed/1 optional live fixture ignored; mutation guard18 passed. The combined frontend verification found a real ESM initialization cycle when importing projectService first: exportRead imports useProjectStore, whose eager default dependency read projectService before initialization. A lazy default service getter preserves synchronous export-owner capture and injected test dependencies. Fresh-process service-first/IO-first/store-first cases failed before the fix and passed after; each also exercised default init and legacy export. IPC contract tests then passed. All27 selected frontend suites, including domain commands, layer round-trip, actual native persistence and migration processes, plus typecheck passed (`task-7-8-frontend-integrated-green.log`). Backend/ frontend inventories were refreshed to replace stale server-fixture/lifecycle/MCP adapter entries with current bounded evidence; native Tauri/MCP visual acceptance remains separate.

Task 13 explicit checkpoint observation now passes a real committed-edit/close positive control. The counter samples macOS `proc_pid_rusage` disk-write deltas around the two explicit ProjectDatabase CHECKPOINT boundaries; resets distinguish absent work from unavailable OS metrics. All six child-process recovery/forbidden-work/checkpoint tests pass (`task-13-checkpoint-process-green.log`,3+3). This does not infer checkpoint bytes from file length and does not claim coverage of implicit DuckDB shutdown writes. The earlier immutable debug smoke retains its original null checkpoint field. Production frontend build passed after the import-order fix. Building a separate native acceptance app identity/productName with the current frontend bundle; it is not the default production build and no installed app is replaced.

#### Native large-table validation and viewport repair
The isolated macOS Tauri app opened a2M×20 native fixture as directory-only, rendered the first table window with500 rows/181.3KiB cache, jumped to A1000001 with exact c0=1000000, edited c0 to42424242, and after quit/relaunch/reopen showed42424242 in both the selected formula value and actual row cell. Cache stayed within4,000 rows/~1.4MiB in these observations. This is actual WKWebView evidence; no release latency qualification or user manual acceptance is claimed. Details live in `docs/performance-reports/issue282-20261026-native-ui/observations.md`.

Native formula editing exposed a generation-projection race that reset the viewport to row0. A targeted component reproduction failed for formula editing (inline control already passed). Both paths now hold the owned refresh while native acknowledgement projects metadata, then use the existing mutation-result refresh at the acknowledged generation/current window. Both focused cases pass;55 integrated mutation/scroll/navigation/App component tests and typecheck pass. Native repetition of the repaired bundle remains pending. The unnamed empty draft offered on restart was preserved; no recovery cleanup was inferred.

Task7 completion recorded with27 TS/native-adapter suites plus typecheck. Task8 fresh metadata-open/guard/IPC/native-adapter verification is running. Remote origin/dev read-back remains3a362f6ebed9dd9f2435aac56cdf5bd75a84052f.

Ruling: catalog performance now measures and serializes the actual open response (including its bounded first catalog page and table headers), rather than issuing an additional catalog-list call — this matches the native UI opening route and accounts for the full open payload — earlier immutable debug smoke remains diagnostic and is not directly compared as qualification.

Task8 completion recorded: fresh native metadata-open5, guards18, rebuilt real native persistence harness, IPC contracts/native adapters/catalog preparation all passed. Tasks7/8 are complete; final source freeze, release budget matrix, SQL profiling, native repetition and independent review/manual acceptance remain. Native viewport repair production bundle also builds successfully.

Native viewport repair repetition passed in the rebuilt isolated WKWebView app: row1,000,001 changed42424242→42424243; visible edited cell retained42424243, selection moved to A1000002 with exact1000001, logical start999981, cache3,500rows/four entries/~1.2MiB, Ctrl+S showed Saved. App quit and running=false read back. Source/binary SHA and exact observations retained immutably in `docs/performance-reports/issue282-20261026-native-ui/fixed-bundle.json`. This closes the specific native viewport finding, not the remaining performance/final-review/user-acceptance gates.

#### Actual SQL scan regression and first bounded-query repair
Canonical navigation SQL was profiled with actual bind values through DuckDB EXPLAIN(ANALYZE,FORMAT JSON), separately from timing runs. On a300k×20 seeded fixture, all three500-row windows performed300,000-row scans, despite zero archive/copy/history/anchor/full-count counters. The source-scan test failed at that exact observation. Raw before plan is immutable in `docs/performance-reports/issue282-20261026-sql-profile-before-01/profile.json`.

Ruling: preserve existing sparse anchors and fallback-null row-order semantics, but add the next ordinal anchor as an exclusive upper boundary and split nonnull physical keys versus fallback-null rows into disjoint range-filtered UNION branches — the previous COALESCE predicate prevented storage-group pruning and had no upper bound — SQL becomes more complex and requires mixed-order/paging/history regression coverage, but no migration or full rewrite is introduced.

First full-source-scan regression passed. Actual after plans scan122,880/122,880/54,240 physical rows, with candidate cardinalities4097/4097/992, returning exact500-row windows. This reflects DuckDB storage-group granularity and is not a claim of500 physical reads. Before/after raw plans retain their distinct source fingerprints. Expanded fallback/materialized/mixed and full-count positive controls are next; broader semantic and release gates remain.

Task 13 continuation (2026-10-27): real App probe operations now bind samples to
fixture identity/current epoch, validate matching raw SQL profile before creating
output, and publish immutable scenario reports. Native runner tests 10/10 passed
(`task-13-ui-command-green.log`); frontend exact readiness/error fences and probe
entrypoint checks passed, typecheck and explicit benchmark frontend build passed.
The isolated debug benchmark bundle built successfully. Native operation spans
exclude prefetch and observe actual reply payload sizes; RSS is main-process only,
cache bytes use existing retained-payload estimates, and two animation frames do
not prove compositor presentation. Actual native telemetry and release/cold matrix
are pending; these checks do not complete Task 13 or qualify performance.

Task 13 real UI smoke: first cached scroll correctly failed missing native-span
qualification; target now stays beyond initial window/prefetch (three fixture
sizes/100 unique positions checked). Second debug smoke obtained actual distant
query samples but exposed duplicate formula writes on Enter followed by blur.
Regression `formula Enter followed by focus loss commits one native cell only`
failed with generation 3 instead of 2 and unchanged active reference. Added one
synchronous FormulaBar in-flight commit guard across Enter/blur; regression and
existing inline/formula native acknowledgement tests passed 3/3. Immutable failed
smokes retained with observations; final native repetition remains required.
Remote dev readback remains 3a362f6ebed9dd9f2435aac56cdf5bd75a84052f.

Task 13 native UI smoke03: 10/10 exact logical samples passed (two complete real
App cycles), after the FormulaBar Enter/blur guard. Native backend spans, visible
cell/reference, saved status and cache usage were observed, source
`efaa578479f7c6a9fe966c60dd9a078437f87a10`. Debug/small sample count and concurrent
cold diagnostic make this collector correctness evidence only, not a latency
qualification. Broader CT51 and host/source/budget checks passed. Real stress
seeds verified501 tables,10001 report documents and512-character string cells;
initial fixture bulk construction is outside every measured operation.

Ruling: cold App samples perform file-scoped msync(MS_SYNC|MS_INVALIDATE) and
mincore census in native begin, after untimed fixture validation/setup has fully
closed and before operation timing/IO/RSS starts. Earlier catalog CLI calibration
had inadvertently warmed metadata before its timer; retained as unqualified.
Independent raw-read controls proved zero resident pages then65536/41431040
physical cold bytes, followed by zero warm reads. No global cache/service change.
Cost if wrong: cold qualification could describe warm metadata; require per-sample
zero-residency geometry/identity plus positive actual disk reads and five distinct
App PIDs. Unsupported platforms reject this cold method, rather than infer cold.
Native cache/config/runner tests13/13 and cold host aggregation4/4 pass; final raw
App cold samples and the release matrix remain pending.

Ruling: final correctness review uses the full base-versus-working-tree diff plus
all untracked source/tests, because implementation commits are explicitly gated
on user manual acceptance and BASE==HEAD. An empty committed-range package would
miss this implementation. Freeze source fingerprint and inventory the full worktree
for the fresh reviewer; release performance follows review/fixes as the plan
requires. Cost if wrong: review could omit untracked behavior or drift; reviewer
must inspect actual new modules, and host source fences reject stale binaries.

Native smoke04 source6f2ecbb1f3af9dbcb21c3b5648874ca4b945609e passed two cold
catalog App processes (residentPagesAfter0, actual3276800 read bytes each) and two
warm five-operation cycles. Retained debug/small-sample reports are unqualified.
Native cold13, host/budget/source24 and broader table CT51 passed. Fresh full
Rust lib regression is running; final release matrix and manual acceptance pending.

Task 14 integration correction: the final reviewer was dispatched before the
planned status component/suite integration was complete. Review was paused before
any verdict, then the reviewer hit an external usage limit; there is no completed
independent review. Do not treat the dispatched seat as a passed AI gate. Complete
Task14 status/parity/suite work before resuming an available fresh review.

Fresh full lib regression before command inventory repair:1785 passed,2 failed,
21 ignored. The failures are the known clean-dev OLS case plus missing inventory
entries for four private probe commands. Added an explicit ProbeControl category;
focused mutation guards12/12 passed. Real child recovery/forbidden-work9/9 and
default-disabled cargo check passed (existing warnings retained).

Task14 status RED (missing component) -> implementation ->9 CT pass (status4,
native App5). Status follows actual coordinator pending/saving/error/durable saved;
retry keeps operation identity and late old-owner acknowledgement cannot affect
the new keyed status. Raw filesystem errors remain in diagnostics/state, while
native status shows translated user-facing labels and safe retry. Expanded failed
close/multilingual/full-suite checks are active. First integrated suite correctly
stopped because STATSPG_PERSISTENCE_HARNESS was not provided; no native test skipped.

Task14 MCP preview regression RED exposed hidden row IDs presented as visible
column zero. Preview now maps by described column names; focused native catalog
and existing project command tests pass. Real reopened UI/MCP parity is being
added to the native adapter fixture so exact committed document bodies and table
values are checked against actual storage, rather than in-memory fake rows.

Task14 project suite04 passed66 contract files (including live reopened native
MCP/UI parity) and104 CT cases. First failed-close fixture had edited an unloaded
report, then expected the wrong retry identity: native resolver first proves
cancellation, fences the old identity and rebases an unchanged document payload.
Corrected the fixture/expectations; close/error and query-session readiness checks
passed three repetitions (6/6). Query-session fixture now waits for actual query
resolution and visible EV rows before opening its context menu.

Closing-error popup observed a raw path RED; it now uses translated user-facing
text while retaining diagnostic error state. Current i18n instance avoids replacing
the window's in-flight close owner when language changes. Legacy status flow stays
separate from the native durability status. Native UI acceptance remains pending.

This execution environment has Node/Cargo but no npm executable. A scratch driver
expanded the exact package.json test:analysis and test:mcp scripts, invoking the
existing Node CLIs and Cargo in order (unknown shell syntax is rejected). Both
chains exited0: analysis UI60, MCP UI18, and positive Rust subsets31+2+4+20+1+59;
all package contract commands also passed. No package test was omitted.

Ruling: retain the existing Rust legacy artifact-parity fixture, and add native
reopened MCP/UI parity to the real JSON-lines database adapter fixture instead of
copying that legacy archive fixture into a second native-only Rust simulation —
the production application runtime now reads actual committed bodies/values from
the same reopened database as the UI projection, with body-read counts and no-echo
checks — cost if wrong: the test still uses the IPC mock solely as a transport
bridge, so real Tauri/native manual acceptance and MCP broker tests stay required.

Clippy baseline audit used an ignored local shared clone of exact3a362f6; primary
checkout and feature HEAD were not moved. Clean base strict Clippy fails215
checks; initial feature run236. New unused helpers were scoped to test/harness,
unused conversion removed, redundant borrows/arithmetic corrected; flat IPC argument
and inline receipt-envelope lint allowances are narrow and explicit. Latest check
was213 diagnostics including one newly unused mut subsequently removed; no claim
that strict lint is green. Final diagnostic comparison and full Rust remain pending.

The first fresh reviewer failed twice on service quota before a final verdict,
returning two preliminary source defects (folder metadata projection, stale table
list store write). A fresh available-model replacement now owns the same incomplete
review seat; it must validate those and finish the whole live tracked/untracked
review. No independent review pass or source freeze has been claimed.

Fresh clean3a362f6 exact OLS reproduction fails identically at
engine/fit_model/ols.rs2273 with predictor mean missing for X1; retained in
`task-14-ols-clean-dev.log`. Final strict Clippy current212 vs clean-base215,
zero unmatched current diagnostics by exact file/message/offending-line comparison
(`clippy-comparison-final.json`). This is a baseline comparison, not a green
strict-lint result; base default and current project-v5 feature sets are stated.

Replacement reviewer is active after the first seat's repeated quota failures.
Confirmed preliminary folder-state and stale-table-metadata findings remain
unfixed until complete grading; analysis async ownership and many-doc probe
readiness are also being validated. No passed review, source freeze or final
performance qualification has been claimed.

Task 14 verification continuation (2026-10-27): default full Cargo after exact known OLS exclusion passes1744 lib +3 integration +9 recovery tests,20 ignored. Deterministic workflow executedAt audit-field regression RED→GREEN; four fingerprint tests retain estimate/method-version sensitivity. Four public-native positive tests now run only with project-v5, preserving the default-disabled capability boundary. Enabled/perf-harness full verification remains active.

Final review preparation: delayed A table-list response overwrites B tables (same ID/different metadata plus B-only table), metadata-only folder reopen omits Reports assignment, and delayed analysis creation writes into B; new production-path regressions each observed RED. These review candidates await the complete independent graded verdict before grouped fixes. No final qualification or user acceptance.

# Final review grading and rulings

All five actionable findings are Important by effect: F1 command admission/publication owner; F2 direct workflow extraction owner; F3 metadata folder projection and complete subtree actions; F4 shared table projection response owner; F5 many-document qualification admission. None is deferred. No Minor finding was raised. One grouped TDD fix pass is active; no re-review will be dispatched.

Final: Ruling: release latency/write scaling/RSS was declined by reviewer — require source-frozen release matrix after all correctness fixes, retaining failed/unqualified evidence — cost if wrong: opt-in feature remains unqualified and delivery is delayed.
Final: Ruling: arbitrary global sort/filter preparation may scan input — retain the approved separate preparation cost and bounded ready-session pages — cost if wrong: first-time preparation can wait; never label it zero-wait.
Final: Ruling: Windows replacement/fsync, disk-full/permission, network shares, future DuckDB upgrades were not established — retain platform/fault qualification gaps and keep v5 disabled by default; writable network shares remain unsupported — cost if wrong: deployment to those environments is not qualified.
Final: Ruling: clean-dev OLS predictor mean missing for X1 — preserve unrelated statistical code, report exact failure and exclude only that named test from current persistence aggregate reruns — cost if wrong: the full unfiltered suite remains red until the statistical issue is separately repaired.
Final: Ruling: WebContent/GPU and full render-cache memory were not measured — label main-process RSS and cache payload estimates precisely, retain null unobserved values — cost if wrong: total application memory may exceed the measured main-process budget.
Final: Ruling: many-document catalog readiness must reflect its bounded first page — use visible first-page metadata readiness; page to Data only in explicit untimed setup before all five table scenarios, preserving regular/long-string scenarios and sample counts — cost if wrong: table-access setup cost is separate and must remain disclosed.


Final review grouped fix pass evidence (2026-10-27):
- F1 analysis creation owner regression RED→GREEN; command admission captures a guard checked before handler and beginCommit. SQL/transform delayed preflight and queued-request switch/closed cases also pass. No stale native submit/store publication.
- F2 actual App workflow selection/extraction delayed across lifecycle switch RED→GREEN; captured owner is checked after schemas and before publication after extraction. The initial UI switch test encountered the legitimate modal overlay; production lifecycle switching used for the race, matching alternate command-driven transitions.
- F3 reopened folder assignment RED→GREEN; metadata-only projection batches catalog changes, preserves pending path deltas, and folder actions finish metadata inventory. Held-ack paging regression for later empty folder RED→GREEN. Real native adapter file reopen/mutation/reopen test passes with zero additional report-body reads.
- F4 delayed table metadata owner RED→GREEN; same-ID B metadata and B-only tables survive A response, closed owner remains empty. Shared refresh also fences request order and committed revision.
- F5 actual App benchmark report-first page RED→GREEN; cold first-page sample completes without Data or body loads. Warm table lookup pages outside measured first-page readiness, retaining all five scenarios. IPC doubles in this CT establish runner admission only. Final native stress proof remains pending.
- Fresh full Rust with exact known clean-dev OLS exclusion: default1744 lib +3 integration +9 recovery,20 ignored; enabled1787 lib +3 integration +9 recovery +6 feature process,21 ignored. Typecheck passes. Expanded69-contract/106-UI suite running; fix pass is not declared complete until whole suite is green.

Final: fixed F1 command publication owner — delayed analysis RED→GREEN, SQL/transform preflight/queued cases GREEN; added post-commit refresh owner regression RED→GREEN and guards before follow-up effects. Suite final-project-suite-03:73 TS files and106 CT passed.
Final: fixed F2 direct UI workflow extraction owner — nativeProjectApp delayed extraction/switch RED→GREEN; suite106/106 UI passed.
Final: fixed F3 folder projection/subtree preparation — reopened folder and held-ack later empty-folder tests RED→GREEN, real native file rename/move/reopen passed; suite73 TS/106 CT passed.
Final: fixed F4 dataset refresh projection owner — switched/closed same-ID metadata RED→GREEN, same-owner response ordering passed; suite73 TS/106 CT passed.
Final: fixed F5 probe catalog admission — first report-only page CT RED→GREEN; first-page metric stays bounded and warm table traversal is explicitly untimed; suite106/106 passed. Actual many-document release sampling is still required.
A full-suite test race was repaired by waiting for actual resolved/visible query rows before context-menu mutation (stale-recovery case, repeat3 passed); full expanded suite then passed. Latest strict Clippy212 matches retained clean-base215 with zero unmatched diagnostics; strict lint remains nonzero. Full project-v5 without perf also passes after exact known OLS exclusion. All implementation edits are now frozen for the final release probe build; no re-review, default enablement, publication or user acceptance claimed.

Task 13 release matrix01 (source92e38d4): regular300k/2m/10m each completed100 warm samples and5 independent cold opens. Regular10m warm native/UI P95 ms: catalog33.15/63, window11.49/65, scroll9.25/133, edit44.80/99, close57.74/78. Scroll UI fails100ms budget across all sizes; existing TABLE_NAVIGATION_SETTLE_MS75 is a confirmed component of the delay. Many-document case reaches all catalog pages and first window/scroll, but first edit times out on visible state despite native completion52ms; long tier was not reached because logical verification stops the host. Immutable matrix01 raw reports retained.

Observer interference: a CUA app-path lookup between phases launched an unconfigured extra owned app (PID35671, parent launchd); only that process was terminated. Its possible regular300k/2m overlap is recorded in matrix01/observer-interference.json. No final foreground qualification can use those affected samples. Regular10m started after its termination and independently confirms133ms scroll. Do not call CUA getApp while a timed runner can be between processes.

Separate owned many diagnostic fixture was seeded/profiled from92e38d4, launched without auto-kill and retained after timeout. CUA screenshot shows referenceA160002, actual viewport159981..160001; rows through159999 contain data, target160000 and next160001 are blank after edit. This points to mutation reload using fixed500 rows at159500 while the pre-edit viewport crosses a500-row boundary (ordinary viewport range is1000). No implementation fix yet; require deterministic reproduction before deciding. Diagnostic app PID36173 terminated; file/reports preserved. Native debug harness exact target reopen read is running.

Task 13: Ruling: the first frozen release source failed its final performance/correctness gates — retire92e38d4 as the final qualification candidate, retain every failed/interfered report, write RED tests for committed navigation delay and own mutation refresh coverage, fix and re-freeze/rebuild before fresh full matrix — cost if wrong: another release build/matrix is required; budgets and logical checks stay intact. This is planned qualification-driven work, not a second independent review pass.

Task 13 qualification repair: two focused CT regressions observed RED (own mutation reload requested500 at4500 while editedrow5000 lay in next page; committed reference jump did not start foreground native request within32ms). Both now GREEN: reload preserves the previous bounded viewport span and includes count in in-flight identity; committed offscreen reference jumps flush their newly scheduled foreground request immediately while wheel coalescing stays75ms. Actual diagnostic file reopen confirmsrow160000=42000000 at generation1, proving the earlier blank cell was a visible-window refresh defect, not lost persistence. Expanded viewport/cache/scheduler/logical-navigation full suite running (77 contracts, UI count to read on completion); no new source freeze or release qualification yet. Old source92 release app and CLI retained in ignored source92-release-artifacts before replacement.

Task 13 repair verification complete for next candidate:77 TS contract files,133 CT tests, typecheck and diff check pass. Source frozen again atf151e9d27e10b51a8c574c051c3cc453e5f6e614 (2026-10-27T09:01:53.900Z); exact scoped source snapshot/inventory retained in ignored source-freeze-02.tar.gz/source-freeze-02-inventory.json before the second release build. Release02 Vite/Tauri/CLI build running sequentially; matrix02 must use new roots and no CUA observer while timed children run. Native manual acceptance and publication/default enablement still pending.

Task 13 matrix02 continuation (2026-10-28): all3 regular dimensions completed100 samples per five warm operations plus5 cold processes, within latency budgets. UI P95 ms:300k catalog63/window64/scroll50/edit98/close64;2m64/65/63/100/64;10m64/65/66/100/79. Full matrix is NOT qualified: many produced only1 catalog sample and a failed first window (native12.67ms, UI timeout); long was never reached. No sample reduction or budget waiver.

Many diagnostics: native main/WebContent appeared idle and a black window was observed read-only after the stall; system power assertions showed display/user active, so sleep was not established. Own WebContent stack and bounded OS logs retained, no renderer-crash claim. Rebinding/raising the existing window coincided with host publishing the failed sample and normal child termination (not a20-minute host timeout). A separate controlled f151 one-cycle run then passed catalog/window/scroll and reproduced edited cell visibility failure: target160000 and next row blank, referenceA160002, native edit52.77ms/3calls/224516 reply bytes. This confirms first repair based on dataRef.rows length did not cover every native timing/cache path. Fixture edit persisted; no data-loss claim.

Second deterministic defect reproduced: navigate toA5201, await prefetched5500 page, thenA5501 with the same cache-window start but larger span. Cached lookup returned the larger range, but the UI skipped setData whenever cached.start stayed equal; row5500 missing. Regression RED→GREEN after always projecting a newly requested cached key's full result (key equality still prevents repeats). Existing boundary reload and committed-navigation regressions also pass3/3. No extra viewport-count algorithm was implemented yet; assess this narrower root fix with actual native diagnostics before expanding further. f151 is no longer the final candidate.

Debug diagnostic bundle +CLI build is active under unique com.statsplayground.issue282.diagnostic / StatsPlayground Issue282 Diagnostic, using current source and VITE_PROJECT_V5_BENCHMARK=1. Next: small actual many/long run on fresh fixtures, expanded77-contract/134-UI suite, then freeze/rebuild/re-run full release matrix03. Preserve source92 binaries, f151 source archive995 files, all failed raw reports and diagnostics. Default v5, commit/push/PR and user acceptance remain pending.

Task 13 native cache diagnosis: debug source541708e937959b22456e2eaa8da30af24bfaf153 completed2 full many-document cycles (10 operations, every visible value/reference/save/close check passed). Edit reply sizes447997/224582 bytes confirm correct larger refresh where required. This directly validates the same-start cache-span projection fix; no additional viewport-count algorithm was added. Original541 debug app/CLI retained before rebuild.

Long-string diagnostic source541 reached two catalog/window/scroll/edit cycles; the second edit's frontend exact readiness passed, but native verification rejected backend sum739.039ms versus UI662ms, errorNone,3 completed native calls, zero forbidden work. This is a timing-model inconsistency rather than a visible-value failure. A native overlapping-span regression observed RED (sum counted two overlapping20ms intervals twice). It is now GREEN with native interval union; all15 native probe tests pass. Node audit/missing-proof/mixed-version regressions observed RED→GREEN; all26 host/budget/source tests pass.

Task 13: Ruling: native elapsed time must not double-count overlapping invocation intervals — timing version2 reports monotonic endpoints, backendMs interval union, backendAggregateMs unchanged per-call duration sum and backendOverlapMs; host independently recomputes each and rejects missing/inconsistent proof or mixed versions. UI timing, sample counts and budgets unchanged; historical reports remain byte-for-byte unchanged. Cost if wrong: native duration could be understated, so original aggregate and complete endpoint proof remain auditable and a fresh actual native long-string run is required.

Current interval-union debug diagnostic Vite/bundle/examples build is running (unique diagnostic identifier), followed by actual small many/long rerun, full77-contract/134-UI suite, enabled native full/metrics/lint gates, then new source freeze and full release matrix03. No final qualification/manual acceptance/default enablement/publication.

Task 13 final gate refresh (2026-10-28): interval-union native debug source8751b2b completed all20 many/long operations with exact UI/native checks passing. Many edit union/aggregate/overlap/UI ms350.4/415.9/65.5/581 and246.4/301.3/54.9/381; long962.5/1260.2/297.7/1379 and417.6/641.9/224.3/580. This is unqualified debug smoke, not release budget evidence. Full frontend suite77 TS files/134 CT, typecheck/diff passed; full enabled/perf native1789 lib+3 provenance+9 MCP+6 forbidden-work+3 recovery passed,21 ignored and exactly one known clean-dev OLS test excluded. Remote dev compare remains identical3a362f6.

Extra strict perf-enabled Clippy found9 new diagnostics (4 redundant IPC returns,2 probe expression simplifications, one process-IO return,2 unprofiled convenience dead-code paths). Narrow repairs preserve behavior; the legacy unprofiled reader remains available in normal builds and has one documented perf-only dead-code allow because perf builds select its instrumented counterpart. The migration no-cancel convenience is test-only; production/perf use cancellation-aware entrypoint. Exact same-feature clean-dev comparison after repairs: current200 diagnostics versus baseline204, zero unmatched; strict lint stays nonzero. Fresh full library regression is running before source-freeze03/release matrix03. Earlier failed/interfered/unqualified raw evidence remains unchanged.

Source-freeze03:6d5b04b7646276cf49a4e890832af3e10e59444e,995 scoped files archived, current HEAD3a362f6. Final library rerun after lint-only repairs passes1789/0 failures,21 ignored,exact known OLS excluded (125.69s). Vite release03 passes; unique benchmark release bundle build running. f151 release bundle/CLI preserved separately before overwrite. No timed probe is running yet.

Task13 release matrix03 source6d5b04b: all2500 warm operations plus15 independent cold directory samples pass logical correctness, all six forbidden-work counters zero, interval proof valid. All regular dimensions and most stress operations fit budget. Three latency gates fail: many edit UI P95206ms(native44.02), long scroll149(native56.78),long edit248(native94.34). No reduced samples/budgets/retrospective edits; raw matrix03 remains immutable. Long scroll replies4.9–9.8MB versus regular112k; edit9.8MB versus224k. Median UI-minus-native long92.48/154.98ms and many edit149.50ms versus regular52.58ms. Source03 is not qualified.

Qualification root repairs: actual App getter-based directory traversal regression observed RED on pure saving-phase status update(same epoch/pending/ack sequences), GREEN after memoizing directory by these ownership/overlay fields rather than snapshot object identity. Pending/ack transitions still invalidate pending overlays. Actual table distant large-string request regression RED(count500/1000)→GREEN with sampled byte-informed page-size hint(1MiB target,min64,max500); true cache admission still measures all rows/bytes with existing caps. Neighbor prefetch also follows the smaller observed page. Mutation refresh preserves the full prior window span without imposing minimum500, and actual native-ack CT proves distant edited value/selection/read coverage while prefetch held. Focused/full tests and a new frozen release matrix04 required; no final performance claim yet.

Qualification repair evidence: large-string edit mutation check restores minimum500 and fails the new exact visible-value/read-range CT; adaptive minimum passes. Full focused40 CT initially exposed the small200→201 append boundary when refresh used only prior200 rows; fixed minimum to max(observed page-size hint, prior span), preserving numeric500 and string64 pages. Small append/obsolete-response +long-string held-prefetch regressions2/2 now pass. Full77-contract/137-UI suite running against real release03 native contract harness (backend unchanged); typecheck/diff pass. This is required Task13 repair validation, not a skipped failure.

Issue282 validation refresh: mutation-check restoring fixed500 refresh fails the large-string exact visible-cell/read-range regression as expected. Focused40 run exposed small200→201 append boundary; adaptive minimum now max(page-size hint,prior span), focused2/2 and full77-contract/137-UI suite pass, typecheck/diff pass. Final source04 ce0d858c7f823b9a13143ebeb1624d5e63f878cb frozen with995-file archive; Vite passes and release bundle/examples/full matrix04 are sequenced, fresh output roots. Prior6d5b release app+both CLI artifacts preserved. No final qualification/native manual acceptance/default enablement/publication.

Task13 matrix04 sourcece0d858:2500 warm+15cold logical checks pass, all counters/interval proofs valid, but three UI P95 gates remain red:many edit210,long scroll132,long edit249ms. Adaptive scroll replies did shrink to627.8k/1.255MB(from4.9/9.8MB), while edit still9.8MB, so payload hypothesis alone does not explain UI latency. No qualification claimed.

Root trace: recordCommittedTableMutation increments historyRevision; the legacy history effect then runs load(default500)+refreshDatasets even for native receipts, causing two500-row reads and extra whole metadata projection. Added nativeHistoryReceipt to actual table harness, invoking the real HistoryStore projection. Regression RED(two500 reads)→GREEN(one small owned refresh) after native mode skips that legacy notification effect; native generation metadata/replay effects remain responsible for refresh. Existing simple native-ack doubles omitted that history side effect, which is now explicit.

Historical source04 CPU diagnostic did not complete or publish UI reports before120s timeout; own main97707 terminated, new WebContent97712 sampled. Marked unqualified outcome and do not infer a renderer/text-layout bottleneck from idle/setup stacks. Added benchmark-only operation-finished/first-ready/per-frame endpoint evidence under retention.uiPhases; actual App cold probe RED(missing evidence)→GREEN, no readiness frames or budgets reduced. Focused2 pass; diagnostic debug rebuild/small many+long run with new source active before deciding further long-scroll changes.

Task13 phase diagnostic05 source783d1e5 built Vite/debug app/CLI successfully but first long edit timed out waiting UI readiness. Native edit+one refresh only2 spans, reply1.2557MB confirms legacy-history duplicate removal. Exact native screenshot after stall showsc0 target42000000 and next activeA160002 with both rows present. This is not evidence of lost data; benchmark readiness timed out. App was bound only after confirming PID6468 alive; attempted observed Raise then returned App quit because host had published failure and terminated its own app. Diagnostic is interfered/unqualified, no budget inference.

Frontend phase intervals show scroll ready231ms/native170.98, then two frame waits50+12ms; first-window ready548/native271.2 with late155/58/31ms frames. Neighbor prefetch begins after2rAF and can collide with the final foreground presentation. New real navigation fake-clock regression RED(prefetch8500 already started during first180ms)→GREEN with2rAF+100ms cancellable quiet period. Existing after-paint and superseded-prefetch cancellation tests also pass. This is a second scoped long-scroll performance hypothesis; actual native validation remains required.

Collector control strengthened: benchmark-only native window always-on-top and per-operation focus setup before either timer starts. No system preferences/AppNap settings changed; ordinary builds stay unaffected. Frontend phases now include start/end document focus/visibility and failed-sample diagnostics. Host uiObservationVersion1 rejects missing/invalid phase endpoints, missing two post-ready frames, lost focus/visibility and mixed versions (RED→GREEN); existing budgets/frame count/sample counts unchanged. Old raw evidence retained; no retrospective edits. Focused5 CT, host25 selected tests, typecheck/diff pass; full77/139 UI and native15 probe reruns active before debug diagnostic06.

Task13 current checks: native probe15 pass; host UI/budget/source25+native host3 pass, typecheck/diff pass. Full frontend suite first rerun77 contracts passed and138 CT passed/1 failed: deferred query invalidation expected2 cancellations but new idle scheduling meant initial prefetch was not admitted before mutation. Test now explicitly awaits actual initial prefetch admission, preserving both cancellation branches and exact error/no-unhandled-rejection assertions; repeat3 passes. Full77/139 suite06 rerunning; no test failure hidden. Debug diagnostic06 build active with uiObservationVersion1, focus/visibility proof, always-on-top dedicated window, cancellable100ms idle prefetch and native-history duplicate removal. Source783d debug artifacts preserved before overwrite.

Task13 foreground debug06 sourceae073ac completed all30 operations(3 cycles each many/long), logical verification, native interval proof and uiObservationVersion1 focus/visibility/two-post-ready-frame audit all pass. Exit2 remains expected unqualified debug/counts/incomplete matrix/native debug latency; no budget claim. Long edit replies0.628–1.256MB vs prior9.8MB,2 matching native calls instead3. Post-ready long frames still~50–59ms in both window and scroll even with prefetch quiet period; do not claim prefetch alone fixed the remaining rendering latency. Full77 TS contracts/139 CT, native15 probe, host28, typecheck/diff pass. New unqualified debug12-cycle long CPU run07 with actual foreground controls and5s OS WebContent sampling active; no code changes until host source fence completes.

Task13 CPU run07 sourceae073ac: actual foreground-controlled debug12 cycles all60 logical/focus/frame samples pass; source host guard intact. Intrusive5s WebContent sample65932 contains FontCascade::drawText/layoutComplexText249 samples, CoreText typesetter202, glyph shaping/kerning and paint438 branch versus JSONParse4; mixed startup/render workload, not latency qualification or exclusive operation attribution. Long post-ready frames remain~50ms despite delayed prefetch, so prefetch collision was insufficient as a full explanation.

Third scoped long-scroll hypothesis: clipped cell text is paying optional kerning/ligature shaping; disable only these optional typographic features on cell spans, preserving raw strings, full formula/editor and clipboard data. This reversible CSS-only repair uses the measured failed native matrix/CPU trace as RED evidence and existing full139 UI geometry/zoom/navigation tests; no source-text CSS mirror test. Full UI rerun and exact-source debug diagnosis08 are active; if this still fails the actual phase/latency problem, stop guessing and revisit the rendering architecture before another fix. Current source snapshot archived995 scoped files; sourceae073 app+both examples preserved. No final qualification/native acceptance/default enablement/publication.

Task13 typography debug08 sourcefa2ccc624a2cdeb46218933cf9f89d612e2232cc completed all30 many/long operations with logical, native interval and foreground-phase proofs passing. Exit2 remains unqualified debug/small sample/incomplete regular matrix. Long post-ready scroll frames20+13/19+15/20+8ms versus prior50+12/52+13/51+5, with UI-native gap now67–81ms versus110–117. Long edit reply0.628–1.256MB, UI309–343ms vs native225–236(debug), showing lower UI cost without truncating values. Full139 UI checks pass after CSS-only optional kerning/ligature removal;77 contract files, native15 probe, host28 and typecheck evidence retained from same code before CSS-only change.

Remote dev refreshed through GitHub compare_commits: still identical3a362f6,0ahead/behind. Candidatefa2 source995-file snapshot is already retained. Next: strict perf Clippy baseline comparison, source-freeze05 and full release matrix05 with all required counts/budgets plus stronger foreground evidence. Default v5/manual acceptance/publication remain blocked pending actual qualification.

Final release05 freeze:fa2ccc624a2cdeb46218933cf9f89d612e2232cc at2026-10-28T05:53:52.004Z,HEAD3a362f6,995-file inventory/archive. Vite passes; release bundle/examples/full matrix05 queued sequentially with full2500warm+15cold and uiObservationVersion1 focus/frame proof. Oldce0d release app+both examples preserved before overwrite. Fresh strict perf Clippy current200 vs clean204, zero unmatched exact diagnostics, exit101 retained as baseline lint failure. No release qualification/native acceptance/default enablement/publication claim.

Task13 release05 sourcefa2 built successfully. Matrix05 stopped at regular2m edit sample249(index49), visible-ready timeout15s, DOM focus true at start/false at finish, native33ms with~10s frontend gap; raw partial run retained, no data-loss inference. Same-source fresh matrix06 completed2500warm+15cold with every logical check and every original latency budget passing. UI P95 ms:regular300k64/66/77/98/63,2m63/64/75/112/64,10m62/64/71/113/77,many150/124/68/189/120,long63/97/81/131/63(catalog/window/scroll/edit/close). However21 samples fail uiObservationVersion1 because DOM focus at finish is false, while all intervals/visibility are valid. Matrix06 remains unqualified; no retrospective rewrite.

Observation-method repair: document.hasFocus is page/input focus and is not sufficient proof of native-window foreground. Need direct measurement to distinguish real window focus loss from DOM focus churn; do not assume either. Added nativeWindowFocusedAtStart/Finish from Tauri window.is_focused in native begin/finish commands, with method label; begin rejects unfocused native window. UI observation version2 uses these native endpoints plus unchanged page visibility/two-frame proof and keeps DOM fields diagnostic. Version1 interpretation remains unchanged. Native missing-focus proof regression RED(Null)→GREEN; host rejects missing/native-false/hidden/missing-frame evidence and accepts native focus independently of DOM state, RED→GREEN. Native15 and host29 pass, diff check passes. Dedicated debug09/native-focus contrast run before new final release freeze; actual native-vs-DOM divergence still unproven until that run. Product code unchanged afterfa2 CSS fix.

Native-focus diagnostic09 source348311912647aec34ae13f01da85de67c94e9abf built Vite/debug app/both examples successfully. Forty regular300k cycles complete200 operations, all logical/native interval/UI phase/native-window-focus/visibility evidence passes. Exit2 is expected debug40 samples/incomplete matrix, not release qualification. No DOM/native divergence occurred in these200 samples, so the specific cause of prior21 false DOM-focus flags remains unestablished; do not claim a reproduced WebKit-focus bug. Native-window focus is the direct foreground contract, while DOM focus remains separately recorded; v1 report interpretations and raw failures remain unchanged. Product behavior is identical to fa2 after the CSS fix. Native15 and host29 pass; full77/139 frontend evidence remains valid for unchanged frontend code. Next: final same-feature Clippy compare, source-freeze06 and complete release matrix07 with source3483119/uiObservationVersion2 and all original budgets/counts.

Release06 source-freeze06:348311912647aec34ae13f01da85de67c94e9abf at2026-10-28T06:32:03.718Z,HEAD3a362f6,995 scoped files inventoried/archived. Vite passes; release bundle/examples/full matrix07 sequenced. Raw observations version2/native timing2; all original budgets and counts unchanged. Native-focus debug09 all200 logical/focus/frame observations pass, no DOM/native contrast observed (cause of previous21 DOM flags still unknown). Fresh strict perf Clippy200 vs clean204 zero unmatched; lint overall exit101 retained. Oldfa2 release app+both examples preserved. No source edits during build/measurement.

Release06 source3483119 built Vite/app/both examples successfully; matrix07 stopped before the90th regular10m close sample after300k/2m each100 cycles and10m90 catalog/window/scroll/edit plus89 close. Every published sample is logically verified; no failed sample explains the missing next admission. Existing collector did not serialize run-level pre-admission errors, so actual cause is still unknown (do not assert real focus loss or data failure). Preserve all partial reports.

Collector regressions: actual App native-activation-delay fixture RED(old sampler admitted after a false native-focus setup response)→GREEN with explicit repeated native focus acknowledgement before timers. Actual App admission-error fixture RED(missing publish metadata)→GREEN serializing runError across partial reports; native writer RED(runError plus successful stored samples incorrectly labeled success)→GREEN marking whole report failed and retaining error. Native publish receives bounded runError; host error message exposes it. Sixteen native probe tests first had one strict cold-cache-unconfirmed rejection; retained as qualification-admission-native-green.log, no cache criterion changed. Fresh unmodified quiescent16/16 passes in green-02. Host29, actual App11, typecheck/diff pass. Debug10 exact-source build active, followed by target regular10m100-cycle diagnostic and fresh source release if sound; product persistence/rendering code remains unchanged afterfa2.

Debug10 source dd76cb32 complete Vite/app/both examples builds. Full frontend suite08 passes77 contract files and141 CT; strict Clippy final07 exits101 with200 diagnostics versus204 same-feature clean-dev diagnostics, zero unmatched exact file/message/first-source-line entries. Target regular10m100-cycle smoke is running with direct native activation admission and retained runError. An initial host invocation rejected relative output paths before fixture/app work; corrected to absolute paths, diagnostic log retained separately. No source changes during measurement.

Release07 dd76cb32 Vite/app/both examples all0. Fresh full Rust1790 library pass,21ignored, exact known clean-dev OLS1filtered; integration3 provenance/9MCP/6forbidden-work/3recovery pass. Matrix08 completes2500warm+15cold with all logical/native-interval checks and every latency budget passing; one regular300k close(index94) has direct Tauri native-window focus true→false, DOM true→false, UI58ms/native40ms, hence the entire matrix remains unqualified. Raw report retained without reinterpretation. Actual cause of OS focus change unknown. Human explicitly replied开始 to request for an exclusive foreground test interval; same frozen source/binaries, fresh roots, full counts and unchanged budgets now run as matrix09. Corrected initial duration estimate3min to actual~7min before remeasurement. No source or binary changes/no cherry-picked replacement samples.

Task13 final source dd76cb32 release matrix09 QUALIFIED:2500warm+15independent cold, all original latency/logical/native-interval/foreground-focus/visibility/two-frame gates pass, zero forbidden-work counters. Source/binaries identical to retained matrix08; fresh roots after human exclusive-foreground readiness. Exact result and cache/RSS/I/O/checkpoint ranges in docs/performance-reports/issue282-20261028-release-matrix-09/README.md. Task13 complete for macOS qualification; platform/fault gaps explicit. Task14 normal native preview build VITE_PROJECT_V5_BENCHMARK0, onlyproject-v5, separate identifier; fresh owned2M fixture and verified legacy22/33 sample prepared. Manual acceptance/publication/default enablement remain pending.

Task14 native acceptance artifact ready: ordinary Debug Preview Vite/build0, benchmark frontend0, onlyproject-v5, no probe configuration; CUA opened fresh owned2M×20 project, metadata Data/Report visible before selecting, then Data selected and actual A1000001=1000000 visible with adjacent values and All changes saved. Screenshot and state stored in ignored native-acceptance-final-ready.png/native-acceptance-final-state.json. Fixture unedited, preview left running for human. Checklist/report links updated. Independent review findings resolved; required verification is complete with explicitly retained known baseline OLS/Clippy failures. Native HUMAN acceptance pending: stop before commit/push/PR under github-issue-development-flow §5. V5 still opt-in.

Publication update: PR creation explicitly requested after the native-preview handoff. Publish the opt-in implementation and qualified macOS evidence; no separate completed manual-checklist result is recorded, so retain this status and do not enable v5 by default. Fresh dev compare remains identical3a362f6; source fingerprint remains dd76cb32; TypeScript and staged diff checks pass. CSV acceptance fixtures retain CRLF; diff whitespace check uses cr-at-eol without rewriting raw evidence. Local .task5-generation-history database is excluded from publication and retained.
