# Issue 282 frontend persistence owners

Status is about native v5 integration. A pending row blocks enabling v5 even
when its legacy behavior and primitive tests pass. Catalog metadata is complete;
body arrays contain only hydrated documents and cannot define directory membership.

| Entry surface | Persistence owner | Current evidence / remaining gate |
| --- | --- | --- |
| Graph UI, graph.create/update through UI or MCP | Graph store explicit action setter; application runtime captured barrier | Store/command regressions and native graph body round-trip pass |
| Graph New layers/options/camera/hidden groups | Graph New explicit action setter | v3 full body, camera, empty layers and legacy normalization tests pass |
| Graph New renderer open/close/generation/transport | Runtime only | Hydrating another document preserves live sessions; session close enqueues nothing |
| Analysis dialogs and presentation editors | Analysis explicit action setter | Native validation/body reopen and configRevision preservation pass |
| analysis.create/update via MCP | Admission owner guard, pre-publication commit guard and captured barrier | Delayed analysis source reads cannot publish into a successor; queued SQL/transform preflights reject switched/closed owners; domain suites retain the shared UI path |
| Report editor, rename/delete/restore | Report explicit action setter | Native markdown reopen, delete tombstone, restored revision and late fetch fences pass |
| report.create/update via MCP | Application runtime captured barrier | MCP result waits for native acknowledgement; later edits remain pending |
| Tabulate configuration / tabulate.create | Tabulate explicit setter + runtime barrier | Native body reopen and command suites pass |
| Workflow extraction/addWorkflow | Captured UI action owner + Workflow explicit action setter | Actual App delayed extraction/switch regression and native definition reopen pass |
| Workflow run packet + logical run folder + output bindings | One backend workflow commit; projection only in workflowRunCommit | Native public graph/table execution, rollback/replay/reopen and actual frontend/native-process no-echo projection qualified; selected persisted bindings retained |
| Failed workflow run journal | Typed workflow operation | Native semantic failures persist in the same receipt-protected commit; actual frontend/native process qualified; no arbitrary store serialization |
| Transform definition explicit persist | Typed document adapter | Real native schema validation and reopen pass |
| Transform create/run/rebind + output + binding + lineage | One backend transform operation; applyResult projects result | Create/run/rebind native public transport and actual store/native-process reopen qualified. Deleted outputs require undo before rerun; restored-output generation and exact retained rows/reopened binding qualified |
| Transform removal + binding invalidation + lineage | One commit_project_records patch | Native definition removal, null binding and lineage setting verified; unloaded Workspace deletion reads only required settings and preserves unrelated lineage |
| Folder create/rename/move/delete and per-document assignments | Complete metadata inventory, no-echo folder projection and typed metadata delta | Native reopen/rename/root move/reopen without body reads; held-ack pagination preserves later empty folders and optimistic root moves |
| Folder collapse/expand | Local UI preference | No native project mutation |
| Workflow panel / lineage inspection | Catalog metadata and selected typed bodies/settings | Saved definition names appear without body loads; lineage uses the persisted graph and workflow selection/retry reads only one body; selected workflow fetches only run count/latest bindings; unopened counts remain hidden |
| Project inspect / document list / document get | Complete catalog inventory and selected domain hydration | Extended Graph New/workflow kinds, native table metadata queries, selected-body hydration, unchanged path redaction and project-switch fences pass; name inventory uses metadata and pending drafts; creation commands finish metadata inventory first |
| Folder pruneAssignments / directory selection / name allocation | Catalog consumer | Native directory bypasses legacy pruning; active-session name inventory includes unhydrated documents and pending drafts. Public creation, Graph New, selected workflow and report insertion/embeds are qualified |
| Dataset filter replace/rename/clear | Explicit per-dataset settings adapter | Real native setting revisions and clear verified; selected-table settings hydrate before the first bounded query, pending edits are fenced and reads do not enqueue |
| Column rename with dependent filters / column display properties | Owning typed table mutation, including metadata in same transaction | Native schema/filter/display transaction and receipt projection qualified by real process, including type incompatibility and undo; final IPC/UI gate pending |
| Manual/structured/empty table creation | Typed dataService creator on ordered coordinator | Validation and actual native process/file reopen passed |
| Column display read/write | Native epoch-bound settings; writes bind ordered stable column IDs | Actual native process/reopen, stale-column rejection and invalid-width rollback passed; add/delete schema changes follow stable display IDs; reorder is metadata-only and native-process qualified; rename/type and filter disable/restore are native-process qualified |
| Data table rename | Native metadata receipt; shared directory summary projection | Actual native process/reopen passed without advancing table generation |
| Selected SQLite create/append import | Typed dataLinkService operation; append target metadata preconditions | Native service regression and actual frontend/native-process file reopen passed; final IPC/UI gate pending |
| Table UI, paste, keyboard undo/redo, history replay | Typed dataService operation on ordered coordinator | Native cell/row edits, committed history IDs and HistoryStore undo/redo passed through the installed native session; native column add/delete and effective filter receipts also pass; compound paste and inline/formula-bar native alias qualified; actual Tauri acceptance remains |
| History summary browsing | Native paged history cache and HistoryPanel | Lazy 200-entry pages, stale cursor restart, read retry and project/unmount fences pass; migrated nonexecutable legacy descriptions use a bounded read-only summary projection, retaining raw payloads off paging paths |
| Named snapshots metadata and restore | Native descriptor cache and typed snapshot queue operation | Native5, selected TS5, integrated CT11 and actual process capture/rename/edit/restore/delete pass; rows stay in native tables; final native UI gate pending |
| UI imports and external document imports | Typed import operation / document publication | CSV/SQL/selected SQLite/standalone sptb public receipts and real frontend/native process qualified; live PostgreSQL 16/MySQL 8.4 native imports, cancellation/retry, source-free receipts and readonly reopen qualified; owned fixtures removed/read back |
| Workflow/project loadFromProject and reset actions | Explicit no-enqueue projection | Store/hydration regressions and Task11 staged lifecycle/reader disposal pass; final native acceptance remains |
| Authorized CSV UI/MCP export | Captured native write barrier + epoch-bound reader and authorized publication | Pending writes/failed flush/stale owner tests, exact native CSV bytes and close-during-staging no-target pass |
| Other CSV/SQLite/standalone table exports | Captured write barrier and epoch-bound lifecycle lease | All7 frontend routes, actual native-process exports, export16/guards18/default-disabled1, CT6 and typecheck pass. Native standalone files retain stable display settings and visible natural row order; explicit bulk exports hold the selected project until completion |
| Ctrl+S / project.save | Captured coordinator barrier | No archive collection; ordinary save tests pass |
| First naming / Save As / close / project switch | Native lifecycle provider | Feature-enabled native lifecycle/snapshot tests, TS lifecycle/transport and App component checks pass; no legacy archive fallback. Native acceptance/crash/performance gates remain |
| Direct static store writes in workflowRunCommit / transform lineage | Backend result projection only | Must remain inside owning operation projection scope; native projection scopes registered and actual frontend/native-process no-echo checks pass |

Public backend and MCP route inventory is maintained separately in
[backend mutations](2026-10-16-issue-282-backend-mutations.md). These two inventories
are the enablement gate, not an assertion that pending routes are finished.

- Calculated-column upsert/convert use the ordered native coordinator with dataset generation preconditions, retaining legacy invoke compatibility. Real native-process formula creation/conversion/undo and 41 calculated/mutation CT pass. Metadata-only conversion is qualified; broader final native acceptance remains pending.

- Dataset deletion now commits direct graph dependents and setting tombstones in the owning native operation. Receipt projection updates loaded stores/history/viewport before resolution; Workspace does not enqueue separate cleanup writes. Actual native-process deletion and 18 Workspace CT pass. Typed creation/deletion undo, reopened native frontier and global redo pruning are qualified; actual Tauri acceptance remains.

- Fit Model saved columns use the native ordered queue and source-generation context; receipt projects metadata/history before acknowledgement. Output-only native history supports reopened undo/redo, bulk staging avoids per-row source scans. Selected TS5, CT8, native/archive regressions and actual frontend/native-process save/undo/redo/delete pass; final native UI/performance acceptance remains.

- Tabulate export passes source dataset identity and source generation into the native queue; legacy invoke is retained outside native sessions. Typed output metadata resolves only after durable receipt. Selected TS5 (including22 command lifecycle cases), typecheck, CT28 and actual frontend/native-process prepare/materialize/release/delete pass. Creation undo is qualified; native manual/performance gates remain.

- Native table lifecycle receipts now retain typed creation/deletion actions while hiding directories, project only affected restored headers and leave graph bodies unloaded. Native undo/redo always consults the read-only next-action metadata frontier; local history/cursors are presentation caches, protecting reopened sessions and lost-ack recovery. Native subset89, actual frontend/native-process global branch cleanup, selected TS replay/lock/owner tests and History CT9 pass; Workspace keyboard without a mounted table, input/read-only exclusions, visible errors/retry and no duplicate table shortcut pass actual component tests.

Shared dataset refresh captures owner, revision and request order before reading;
late responses cannot overwrite successor/closed projections or a newer response.
