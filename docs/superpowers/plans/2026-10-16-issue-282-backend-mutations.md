# Issue 282 Backend Mutation Inventory

This inventory is an enablement gate. Native adapters use the sole project writer. Legacy-only commands retain the
legacy permit and reject native sessions; these are not native publication routes.
A pending active route blocks v5 enablement; guards alone do not qualify persistence.

## Backend commands

| Entrypoint | Current owner/effects | v5 replay and test status |
| --- | --- | --- |
| `mcp_commands::execute_vscode_mcp_launch` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `calculated_column_commands::upsert_calculated_column` | Native project writer + transaction-neutral formula service + receipt replay | Rollback/replay/reopen undo, 24 formula service tests, 41 combined CT and rebuilt native-process adapter pass; metadata-only conversion qualified; final IPC/UI gate pending |
| `calculated_column_commands::convert_calculated_column_to_values` | Native project writer + transaction-neutral formula service + receipt replay | Rollback/replay/reopen undo, 24 formula service tests, 41 combined CT and rebuilt native-process adapter pass; metadata-only conversion qualified; final IPC/UI gate pending |
| `mcp_commands::start_mcp_server` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `mcp_commands::stop_mcp_server` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `mcp_commands::save_mcp_settings` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `mcp_commands::register_application_command_dispatcher` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `mcp_commands::complete_application_command` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `mcp_commands::unregister_application_command_dispatcher` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `data_link_commands::import_server_snapshot` | Native streaming writer, source-identity preflight and receipt; legacy permit retained | Native cancellation/stale/seeded lost-ack and source-change tests, guards18, IO12 (external3 ignored), typecheck and CT4 pass; live PostgreSQL 16/MySQL 8.4 SELECT-only fixtures passed exact integers/decimal/Unicode/NULL, lost-ack source-free replay, cancellation/retry and readonly reopen; owned fixtures removed/read back |
| `data_link_commands::import_postgres_snapshot` | Native streaming writer, source-identity preflight and receipt; legacy permit retained | Native cancellation/stale/seeded lost-ack and source-change tests, guards18, IO12 (external3 ignored), typecheck and CT4 pass; live PostgreSQL 16/MySQL 8.4 SELECT-only fixtures passed exact integers/decimal/Unicode/NULL, lost-ack source-free replay, cancellation/retry and readonly reopen; owned fixtures removed/read back |
| `data_link_commands::import_selected_sqlite` | Native direct import transaction + append generation preconditions + owned cancellation registration | Native creation/append/replay/cancellation, SQLite regression 13/13 and actual frontend/native-process file reopen passed; final IPC/UI qualification pending |
| `data_link_commands::cancel_sqlite_import` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `data_commands::import_file` | NativeProjectService direct project publication + context/receipt response | Repeated import/name allocation/source-free replay and frontend creation transport qualified; final native IPC/UI gate pending |
| `data_commands::delete_dataset` | Native retention of original table storage plus typed lifecycle metadata, graph before-images and setting tombstones in one receipt | Native 89 subset and actual frontend/native-process undo/redo, hidden storage cleanup and reopened metadata frontier qualified; final native UI gate pending |
| `fit_model_commands::save_fit_model_columns` | Native sole-writer fit computation and bulk output-only column delta with receipt replay | Rollback/replay/reopened undo/redo and zero full-before copies passed; native archive-history RED repaired by explicit valued-add operation, archive117/history6, service8, guards18, CT8 and actual frontend/native process pass; final native UI/performance gates pending |
| `data_commands::create_table_from_sql_query` | NativeProjectService direct project publication + context/receipt response | Repeated import/name allocation/source-free replay and frontend creation transport qualified; final native IPC/UI gate pending |
| `data_commands::create_table_from_rows` | Native validated rows + directory + display settings in one receipt transaction | Legacy validation regressions and actual frontend/native process/file reopen passed; final IPC/UI gate pending |
| `data_commands::create_managed_table` | Native validated rows + directory + display settings in one receipt transaction | Legacy validation regressions and actual frontend/native process/file reopen passed; final IPC/UI gate pending |
| `data_commands::create_table` | Legacy compatibility API, excluded from native writer | Native createTable alias uses create_table_from_rows; legacy permit rejects native direct calls |
| `data_commands::add_row` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::add_rows` | NativeProjectService neutral row mutation + context/receipt response | Native row count/history/reopen undo and frontend transport tests pass; final native IPC/UI gate pending |
| `data_commands::apply_added_rows` | Legacy compatibility API, excluded from native writer | HistoryStore native branch uses authoritative replay and skips legacy cleanup; legacy permit rejects native calls |
| `data_commands::update_cell` | Legacy compatibility API, excluded from native writer | Native inline/formula-bar alias uses update_cells with visible generation; TS, actual cell CT and native-process formula/undo pass |
| `data_commands::clear_cells` | NativeProjectService transaction + context/receipt response; legacy temporary engine remains compatible | Native sparse cell commit, replay, reopen and frontend transport tests pass; final native IPC/UI gate pending |
| `data_commands::update_cells` | NativeProjectService transaction + context/receipt response; legacy temporary engine remains compatible | Native sparse cell commit, replay, reopen and frontend transport tests pass; final native IPC/UI gate pending |
| `data_commands::delete_row` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::delete_rows` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::delete_rows_with_change_set` | NativeProjectService neutral row mutation + context/receipt response | Native row count/history/reopen undo and frontend transport tests pass; final native IPC/UI gate pending |
| `data_commands::delete_columns_with_change_set` | Native compact column transaction plus stable display/filter metadata and effective filter receipt | Deleted filters disable/restore on reopened undo; actual frontend/native-process checks and guard regressions pass; final native UI acceptance remains |
| `data_commands::alter_column_with_change_set` | Native schema/filter transaction + scoped value history + receipt replay | Metadata-only rename, scoped conversion/dependent outputs, rollback, reopened undo and actual native-process filter/display projection pass; final IPC/UI gate pending |
| `data_commands::alter_columns_type_with_change_set` | Native schema/filter transaction + scoped value history + receipt replay | Metadata-only rename, scoped conversion/dependent outputs, rollback, reopened undo and actual native-process filter/display projection pass; final IPC/UI gate pending |
| `data_commands::rename_dataset` | Native catalog/table metadata patch + receipt; generation unchanged | Service replay and actual frontend/native-process rename/reopen passed; final IPC/UI gate pending |
| `data_commands::add_column` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::add_column_with_change_set` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::add_columns_with_change_set` | Native compact column transaction, stable display IDs, context/receipt and history | Replay, rollback, reopened undo/redo, actual frontend/native-process file reopen and transport checks pass; final native UI acceptance remains |
| `data_commands::insert_column_at` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::reorder_column` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::reorder_column_if_generation` | Native metadata-only column permutation + owned history + receipt replay | Zero full-before copies, no row snapshots, reopened undo/redo, actual native-process order/display checks pass; final IPC/UI gate pending |
| `data_commands::delete_column` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::rename_column` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::change_column_type` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::paste_at_position` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::paste_at_position_with_change_set` | Native compact cell/formula history with bound row/column identity | Compound schema/row/cell history, header/type promotion and natural tail growth qualified; unloaded sorted/filter row-ID paging reuses bounded prepared mapping. Reopened undo/redo, 43 table CT and actual native process pass; sorted/filter tail growth remains rejected; final native UI gate pending |
| `data_commands::apply_table_change_set` | NativeProjectService checks change-set ownership and context generation, then neutral replay + receipt | Real frontend HistoryStore undo/redo through installed native session and file reopen passed; final native IPC/UI gate pending |
| `data_commands::drop_table_change_set` | Legacy compatibility API, excluded from native writer | HistoryStore native branch uses authoritative replay and skips legacy cleanup; legacy permit rejects native calls |
| `data_commands::restore_snapshot` | Legacy compatibility API, excluded from native writer | No active frontend caller; native permits reject this legacy command |
| `data_commands::set_column_display_props` | Native setting receipt with dataset generation and stable column identity checks | Native replay, invalid width/stale column rejection and actual frontend/native-process file reopen passed; final IPC/UI gate pending |
| `tabulate_commands::materialize_tabulate_table` | Native prepared-definition read, bounded writer member maps and direct result table/catalog/output-event receipt | Native source omission/staleness, rollback, released-session replay, reopen exact aggregates; Tabulate82/guards18, selected TS5 (command22), CT28 and actual frontend/native process pass; creation undo qualified; final native UI/performance gates remain |
| `io_commands::authorize_csv_export_root` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `io_commands::revoke_csv_export_root` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `io_commands::import_sqlite` | Legacy all-table import wrapper | No active frontend caller; native UI uses selected SQLite import; legacy permit rejects native calls |
| `history_commands::restore_project_snapshot` | Legacy snapshot restore wrapper | HistoryStore native branch uses typed native descriptor restore; legacy permit rejects native calls |
| `graph_new_commands::cancel_graph_new` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `graph_new_commands::close_graph_new` | Runtime/application configuration; no project dataset/document publication | Outside project commit; verify lifecycle coordination |
| `project_commands::init_project` | Legacy lifecycle/archive API guarded by legacy mutation permit | Native frontend uses typed draft/open/snapshot/close provider or Ctrl+S durability barrier; native sessions reject the legacy API. Lifecycle/command contracts, real native adapter and App CT qualified; final Tauri acceptance remains |
| `project_commands::create_project` | Legacy lifecycle/archive API guarded by legacy mutation permit | Native frontend uses typed draft/open/snapshot/close provider or Ctrl+S durability barrier; native sessions reject the legacy API. Lifecycle/command contracts, real native adapter and App CT qualified; final Tauri acceptance remains |
| `project_commands::open_project` | Legacy lifecycle/archive API guarded by legacy mutation permit | Native frontend uses typed draft/open/snapshot/close provider or Ctrl+S durability barrier; native sessions reject the legacy API. Lifecycle/command contracts, real native adapter and App CT qualified; final Tauri acceptance remains |
| `project_commands::save_project` | Legacy lifecycle/archive API guarded by legacy mutation permit | Native frontend uses typed draft/open/snapshot/close provider or Ctrl+S durability barrier; native sessions reject the legacy API. Lifecycle/command contracts, real native adapter and App CT qualified; final Tauri acceptance remains |
| `project_commands::run_workflow` | Native authoritative definition/source preflight, server execution, atomic output/run publication and durable receipt | Graph/table rollback, lost-ack replay/reopen, failed runs, server determinism, selected run metadata and actual frontend/native-process projection pass; deleted output produces a durable failed journal, undo then rerun preserves output identity; final native UI gate pending |
| `project_commands::acknowledge_workflow_commit` | Legacy journal only, legacy owner permit | Native receipt is acknowledgement; native frontend sends no legacy acknowledgement or second save; actual frontend/native process verifies no echo |
| `project_commands::import_table` | Native bounded typed file sink, original transaction and exact public {id} receipt | Native3, parser9/restore5/archive117/guards18, TS/typecheck and rebuilt actual frontend/native-process source-free retry/reopen pass; actual Tauri acceptance remains |
| `project_commands::create_table_transform` | Native full typed result receipt; definition/output/binding/lineage in one transaction, source generation preconditions | Backend transform regression 24/24, frontend suites 5/5 and actual native process/store/reopen passed; run/rebind qualified through actual frontend/native process; final Tauri UI acceptance remains |
| `project_commands::run_table_transform` | Native authoritative definition/binding/source-output generation checks; output/status/settings and receipt transaction | Rerun/replay/reopen and actual frontend store/native-process file reopen pass; deleted output requires undo before rerun, exact retained rows/restored generation/reopened binding qualified; final native UI acceptance remains |
| `project_commands::rebind_table_transform` | Native input replacement plus definition dependency and binding/lineage/status publication | Changed source dependencies, stale binding rejection, blocked-state retention and actual native-process store route pass; final IPC/UI gate pending |
| `project_commands::import_table_transform` | Legacy file-definition import helper | No active frontend caller; no project publication; legacy permit retained |
| `table_commands::sort_table` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::subset_table` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::transpose_table` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::stack_table` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::split_table` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::summary_table` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::join_tables` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::update_table` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |
| `table_commands::concatenate_tables` | Legacy compatibility API, excluded from native writer | No active frontend caller; current transform UI uses typed transform operations; native permit rejects legacy writes |

## MCP tools

These dispatch through application commands; the transport must forward the
same operation identity and authoritative project acknowledgement. Exporting
CSV changes an external file but does not mutate project state.

| Tool | Application command | v5 persistence status |
| --- | --- | --- |
| `statsplayground_table_create` | `table.create` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_table_transform_create` | `tableTransform.create` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_table_transform_run` | `tableTransform.run` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_sql_create_table` | `sql.createTable` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_table_export_csv` | `table.exportCsv` | Captured native write barrier and epoch-bound reader; authorized publication holds lifecycle transition for final owner check. TS pending/failed/stale barrier and native exact CSV/close-during-staging no-target tests pass |
| `statsplayground_tabulate_create` | `tabulate.create` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_tabulate_run` | `tabulate.run` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_tabulate_to_table` | `tabulate.exportTable` | Typed ordered materialization with source generation and durable metadata receipt; actual frontend/native-process prepare/materialize/release/delete qualified; final Tauri/performance gates remain |
| `statsplayground_graph_create` | `graph.create` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_graph_update` | `graph.update` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_analysis_create` | `analysis.create` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_analysis_update` | `analysis.update` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_analysis_run` | `analysis.run` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_report_create` | `report.create` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_report_update` | `report.update` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_project_save` | `project.save` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |
| `statsplayground_snapshot_create` | `snapshot.create` | Application command uses the captured native acknowledgement barrier and typed service/store owner; domain command suites and real frontend/native-process persistence route qualified separately; final native Tauri/MCP acceptance remains |

## Qualified internal operations

- `ProjectDatabase::import_project_csv`: commit owns table, directory, source
  fence, output event and durable receipt. `project_v5_outputs_csv_*` and
  `project_v5_outputs_cancel_or_changed_source_*` qualify the primitive.
- `ProjectDatabase::materialize_project_sql`: commit owns native result table,
  directory, output event and receipt. SQL security validation remains intact.
- `update_cells_compact_in_transaction`: caller project commit owns native typed
  cell history, values, generation and anchors; small-mutation tests qualify it.

Qualification remains per route: transform/workflow and selected-run metadata now have native public adapters. Typed lifecycle undo and explicit migration are qualified. Final native UI/MCP acceptance, performance qualification and whole-branch review still gate enabling v5.


## Native v5 catalog and commit routes

| Route | Guard / owner |
| --- | --- |
| open_project_v5 | Explicit build capability; staged metadata validation; exclusive session publication |
| list_project_catalog | Epoch-bound native read-only snapshot; bounded keyset page |
| get_project_document | Epoch and expected body revision; typed body validator |
| list_project_history | Epoch-bound metadata-only history page |
| get_project_history_frontier | Epoch-bound next executable metadata action; per-table frontier and original commit ordering; no row/body hydration |
| get_project_table_lifecycle_event | Epoch-bound selected event version and active generation, including null hidden state |
| apply_project_table_lifecycle | Sole native writer; operation/event/project CAS and active generation guard; atomic metadata/storage undo/redo receipt |
| get_project_persistence_status | Epoch-bound committed revision/read-only metadata |
| commit_project_records | Project UUID/epoch/revision preconditions; transactional receipt and replay |

Native mode rejects legacy mutation permits and legacy archive saves. Context
branches for individual table/import/compute commands must still be qualified
row by row above; the catalog routes do not complete that migration.

## Native named data snapshots

Explicit capture/restore/delete use owned native tables and durable receipts. Descriptor-only listing pages at most1000 entries (frontend200); rename uses directory CAS. Five native regressions, five selected TS suites, 11 integrated App/history CT and rebuilt native-process capture/rename/edit/restore/delete pass. Restore retains identity high-water marks and invalidates table history. Progress completes only after commit; ordinary open/save/close reads/copies no snapshot rows. Final native UI acceptance remains.
