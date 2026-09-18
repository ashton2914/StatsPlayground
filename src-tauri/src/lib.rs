mod commands;
pub mod connectors;
mod engine;
mod error;
pub mod mcp;
mod models;
mod services;
pub mod state;

#[cfg(any(test, feature = "perf-harness"))]
#[doc(hidden)]
pub mod perf_harness;

use state::AppState;
use tauri::Manager;

fn initialize_graph_new_cache<E>(
    state: &AppState,
    directory: Result<std::path::PathBuf, E>,
) -> Result<(), &'static str> {
    let directory = directory.map_err(|_| "path_unavailable")?;
    state
        .set_graph_cache_directory(&directory)
        .map_err(|_| "initialization_failed")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    {
        std::env::set_var("STATSPLAYGROUND_MCP_BIND", "127.0.0.1:48188");
        std::env::set_var("STATSPLAYGROUND_MCP_TOKEN", "statsplayground-local-dev");
    }
    let app_state = AppState::new().expect("Failed to initialize application state");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .manage(app_state)
        .setup(|app| {
            mcp::broker::configure_tauri_broker(app)
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(reason) = initialize_graph_new_cache(
                    &handle.state::<AppState>(), handle.path().app_cache_dir(),
                ) {
                    eprintln!("{}", serde_json::json!({
                        "event": "graph_new_cache_disabled", "mode": "memory_only", "reason": reason,
                    }));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::calculated_column_commands::validate_calculated_column,
            commands::calculated_column_commands::upsert_calculated_column,
            commands::calculated_column_commands::convert_calculated_column_to_values,
            commands::mcp_commands::start_mcp_server,
            commands::mcp_commands::stop_mcp_server,
            commands::mcp_commands::get_mcp_server_status,
            commands::mcp_commands::list_mcp_audit_entries,
            commands::mcp_commands::register_application_command_dispatcher,
            commands::mcp_commands::complete_application_command,
            commands::mcp_commands::unregister_application_command_dispatcher,
            commands::data_link_commands::test_postgres_connection,
            commands::data_link_commands::test_server_connection,
            commands::data_link_commands::list_server_source_objects,
            commands::data_link_commands::get_server_source_schema,
            commands::data_link_commands::preview_server_source_object,
            commands::data_link_commands::import_server_snapshot,
            commands::data_link_commands::list_postgres_source_objects,
            commands::data_link_commands::get_postgres_source_schema,
            commands::data_link_commands::preview_postgres_source_object,
            commands::data_link_commands::import_postgres_snapshot,
            commands::data_link_commands::list_sqlite_source_objects,
            commands::data_link_commands::preview_sqlite_source_object,
            commands::data_link_commands::import_selected_sqlite,
            commands::data_link_commands::cancel_sqlite_import,
            commands::data_commands::import_file,
            commands::data_commands::list_datasets,
            commands::data_commands::delete_dataset,
            commands::data_commands::query_table,
            commands::data_commands::query_table_window,
            commands::data_commands::query_table_navigation_window,
            commands::data_commands::prepare_table_navigation_benchmark,
            commands::data_commands::prepare_table_query_session,
            commands::data_commands::get_table_query_session_status,
            commands::data_commands::release_table_query_session,
            commands::data_commands::cancel_table_navigation_request,
            commands::data_commands::get_dataset_generation,
            commands::data_commands::locate_table_row,
            commands::data_commands::query_table_filter_values,
            commands::distribution_commands::compute_distribution_report,
            commands::graph_data_commands::stream_graph_data,
            commands::graph_data_commands::cancel_graph_data,
            commands::graph_new_commands::probe_graph_new_transport,
            commands::graph_new_commands::render_graph_new,
            commands::graph_new_commands::cancel_graph_new,
            commands::graph_new_commands::close_graph_new,
            commands::data_commands::execute_sql_query,
            commands::data_commands::preflight_create_table_from_sql_query,
            commands::data_commands::create_table_from_sql_query,
            commands::data_commands::create_table,
            commands::data_commands::create_table_from_rows,
            commands::data_commands::create_managed_table,
            commands::data_commands::add_row,
            commands::data_commands::add_rows,
            commands::data_commands::apply_added_rows,
            commands::data_commands::update_cell,
            commands::data_commands::clear_cells,
            commands::data_commands::update_cells,
            commands::data_commands::delete_row,
            commands::data_commands::delete_rows,
            commands::data_commands::delete_rows_with_change_set,
            commands::data_commands::delete_columns_with_change_set,
            commands::data_commands::alter_column_with_change_set,
            commands::data_commands::alter_columns_type_with_change_set,
            commands::data_commands::rename_dataset,
            commands::data_commands::add_column,
            commands::data_commands::add_column_with_change_set,
            commands::data_commands::add_columns_with_change_set,
            commands::data_commands::insert_column_at,
            commands::data_commands::reorder_column,
            commands::data_commands::reorder_column_if_generation,
            commands::data_commands::delete_column,
            commands::data_commands::rename_column,
            commands::data_commands::change_column_type,
            commands::data_commands::paste_at_position,
            commands::data_commands::paste_at_position_with_change_set,
            commands::data_commands::apply_table_change_set,
            commands::data_commands::drop_table_change_set,
            commands::data_commands::restore_snapshot,
            commands::data_commands::get_column_display_props,
            commands::data_commands::set_column_display_props,
            commands::stats_commands::get_column_stats,
            commands::stats_commands::get_descriptive_stats,
            commands::fit_model_commands::fit_model,
            commands::fit_model_commands::save_fit_model_columns,
            commands::fit_y_by_x_commands::fit_y_by_x,
            commands::hypothesis_test_commands::run_hypothesis_test,
            commands::tabulate_commands::tabulate,
            commands::io_commands::export_csv,
            commands::io_commands::authorize_csv_export_root,
            commands::io_commands::revoke_csv_export_root,
            commands::io_commands::inspect_authorized_csv_target,
            commands::io_commands::export_csv_authorized,
            commands::io_commands::import_sqlite,
            commands::io_commands::export_sqlite,
            commands::io_commands::export_csv_zip,
            commands::io_commands::export_csv_zip_subset,
            commands::io_commands::export_sqlite_subset,
            commands::history_commands::capture_project_snapshot,
            commands::history_commands::restore_project_snapshot,
            commands::project_commands::init_project,
            commands::project_commands::create_project,
            commands::project_commands::open_project,
            commands::project_commands::save_project,
            commands::project_commands::get_current_project,
            commands::project_commands::extract_workflow,
            commands::project_commands::run_workflow,
            commands::project_commands::acknowledge_workflow_commit,
            commands::project_commands::export_table,
            commands::project_commands::export_tables_sptb_zip,
            commands::project_commands::import_table,
            commands::project_commands::import_graph,
            commands::project_commands::preflight_create_table_transform,
            commands::project_commands::create_table_transform,
            commands::project_commands::preflight_run_table_transform,
            commands::project_commands::run_table_transform,
            commands::project_commands::rebind_table_transform,
            commands::project_commands::export_table_transform,
            commands::project_commands::import_table_transform,
            commands::table_commands::get_columns,
            commands::table_commands::get_column_descriptors,
            commands::table_commands::sort_table,
            commands::table_commands::subset_table,
            commands::table_commands::transpose_table,
            commands::table_commands::stack_table,
            commands::table_commands::split_table,
            commands::table_commands::summary_table,
            commands::table_commands::join_tables,
            commands::table_commands::update_table,
            commands::table_commands::concatenate_tables,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            if let Err(error) = tauri::async_runtime::block_on(state.mcp_server.stop()) {
                eprintln!("failed to stop MCP server during application exit: {error}");
            }
        }
    });
}
