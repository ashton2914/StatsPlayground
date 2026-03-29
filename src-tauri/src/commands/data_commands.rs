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

#[tauri::command]
pub fn create_table(
    state: State<'_, AppState>,
    name: String,
    column_names: Vec<String>,
    column_types: Vec<String>,
) -> Result<DatasetMeta, AppError> {
    let service = DataService::new(&state);
    service.create_table(&name, &column_names, &column_types)
}

#[tauri::command]
pub fn add_row(state: State<'_, AppState>, dataset_id: String) -> Result<i64, AppError> {
    let service = DataService::new(&state);
    service.add_row(&dataset_id)
}

#[tauri::command]
pub fn update_cell(
    state: State<'_, AppState>,
    dataset_id: String,
    row_id: i64,
    column_name: String,
    value: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.update_cell(&dataset_id, row_id, &column_name, &value)
}

#[tauri::command]
pub fn delete_row(
    state: State<'_, AppState>,
    dataset_id: String,
    row_id: i64,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.delete_row(&dataset_id, row_id)
}

#[tauri::command]
pub fn rename_dataset(
    state: State<'_, AppState>,
    dataset_id: String,
    new_name: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.rename_dataset(&dataset_id, &new_name)
}

#[tauri::command]
pub fn add_column(
    state: State<'_, AppState>,
    dataset_id: String,
    col_name: String,
    col_type: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.add_column(&dataset_id, &col_name, &col_type)
}

#[tauri::command]
pub fn delete_column(
    state: State<'_, AppState>,
    dataset_id: String,
    col_name: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.delete_column(&dataset_id, &col_name)
}

#[tauri::command]
pub fn rename_column(
    state: State<'_, AppState>,
    dataset_id: String,
    old_name: String,
    new_name: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.rename_column(&dataset_id, &old_name, &new_name)
}

#[tauri::command]
pub fn change_column_type(
    state: State<'_, AppState>,
    dataset_id: String,
    col_name: String,
    new_type: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.change_column_type(&dataset_id, &col_name, &new_type)
}

#[tauri::command]
pub fn paste_at_position(
    state: State<'_, AppState>,
    dataset_id: String,
    start_row: usize,
    start_col: usize,
    rows: Vec<Vec<String>>,
    header_names: Option<Vec<String>>,
    col_types: Vec<String>,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.paste_at_position(
        &dataset_id,
        start_row,
        start_col,
        &rows,
        header_names.as_deref(),
        &col_types,
    )
}
