use tauri::{AppHandle, Emitter, State};
use serde::Serialize;

use crate::error::AppError;
use crate::models::table::DatasetMeta;
use crate::services::io_service::IoService;
use crate::state::AppState;

#[derive(Clone, Serialize)]
struct ImportProgress {
    table_name: String,
    table_index: usize,
    table_total: usize,
    rows_done: usize,
    rows_total: usize,
}

#[tauri::command]
pub fn export_csv(
    state: State<'_, AppState>,
    dataset_id: String,
    output_path: String,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.export_csv(&dataset_id, &output_path)
}

#[tauri::command(async)]
pub fn import_sqlite(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Vec<DatasetMeta>, AppError> {
    let service = IoService::new(&state);
    service.import_sqlite(&file_path, |table_name, table_index, table_total, rows_done, rows_total| {
        let _ = app.emit("import-progress", ImportProgress {
            table_name: table_name.to_string(),
            table_index,
            table_total,
            rows_done,
            rows_total,
        });
    })
}

#[tauri::command(async)]
pub fn export_sqlite(
    state: State<'_, AppState>,
    output_path: String,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.export_sqlite(&output_path)
}

#[tauri::command(async)]
pub fn export_csv_zip(
    state: State<'_, AppState>,
    output_path: String,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.export_csv_zip(&output_path)
}
