use tauri::State;

use crate::error::AppError;
use crate::models::table::{DatasetMeta, TableQueryResult};
use crate::services::data_service::DataService;
use crate::state::AppState;

#[tauri::command]
pub fn import_file(state: State<'_, AppState>, file_path: String) -> Result<DatasetMeta, AppError> {
    let service = DataService::new(&state);
    service.import_csv(&file_path)
}

#[tauri::command]
pub fn list_datasets(state: State<'_, AppState>) -> Result<Vec<DatasetMeta>, AppError> {
    let service = DataService::new(&state);
    service.list_datasets()
}

#[tauri::command]
pub fn delete_dataset(state: State<'_, AppState>, dataset_id: String) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.delete_dataset(&dataset_id)
}

#[tauri::command]
pub fn query_table(
    state: State<'_, AppState>,
    dataset_id: String,
    page: usize,
    page_size: usize,
    sort_by: Option<String>,
    sort_order: Option<String>,
) -> Result<TableQueryResult, AppError> {
    let service = DataService::new(&state);
    service.query_table(
        &dataset_id,
        page,
        page_size,
        sort_by.as_deref(),
        sort_order.as_deref(),
    )
}
