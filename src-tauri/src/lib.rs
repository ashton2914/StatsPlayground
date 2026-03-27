mod commands;
mod engine;
mod error;
mod models;
mod services;
mod state;

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
            commands::data_commands::create_table,
            commands::data_commands::add_row,
            commands::data_commands::update_cell,
            commands::data_commands::delete_row,
            commands::data_commands::rename_dataset,
            commands::data_commands::add_column,
            commands::data_commands::delete_column,
            commands::data_commands::rename_column,
            commands::data_commands::change_column_type,
            commands::stats_commands::get_column_stats,
            commands::stats_commands::get_descriptive_stats,
            commands::io_commands::export_csv,
            commands::project_commands::create_project,
            commands::project_commands::open_project,
            commands::project_commands::save_project,
            commands::project_commands::get_current_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
