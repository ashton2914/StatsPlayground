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
            commands::stats_commands::get_column_stats,
            commands::stats_commands::get_descriptive_stats,
            commands::io_commands::export_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
