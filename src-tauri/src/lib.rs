mod commands;
mod engine;
mod error;
mod models;
mod services;
mod state;

#[cfg(any(test, feature = "perf-harness"))]
#[doc(hidden)]
pub mod perf_harness;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new().expect("Failed to initialize application state");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::data_commands::import_file,
            commands::data_commands::list_datasets,
            commands::data_commands::delete_dataset,
            commands::data_commands::query_table,
            commands::data_commands::query_table_window,
            commands::data_commands::get_dataset_generation,
            commands::data_commands::locate_table_row,
            commands::data_commands::query_table_filter_values,
            commands::graph_data_commands::stream_graph_data,
            commands::graph_data_commands::cancel_graph_data,
            commands::data_commands::execute_sql_query,
            commands::data_commands::create_table_from_sql_query,
            commands::data_commands::create_table,
            commands::data_commands::create_table_from_rows,
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
            commands::tabulate_commands::tabulate,
            commands::io_commands::export_csv,
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
            commands::project_commands::export_table,
            commands::project_commands::export_tables_sptb_zip,
            commands::project_commands::import_table,
            commands::project_commands::export_graph,
            commands::project_commands::import_graph,
            commands::table_commands::get_columns,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
