use tauri::State;

use crate::error::AppError;
use crate::models::table::{ColumnDescriptor, DatasetMeta};
use crate::services::data_service::DataService;
use crate::state::AppState;

pub(crate) fn acquire_mutation_permit(
    state: &AppState,
) -> Result<crate::services::save_coordinator::MutationPermit<'_>, AppError> {
    state.save_coordinator.mutation_permit()
}

pub(crate) fn sort_table_entry(
    state: &AppState,
    source_id: &str,
    sort_cols: &[String],
    sort_orders: &[String],
    new_name: &str,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state)?;
    let service = DataService::new(state);
    service.sort_table(source_id, sort_cols, sort_orders, new_name)
}

#[tauri::command]
pub fn get_columns(
    state: State<'_, AppState>,
    dataset_id: String,
) -> Result<Vec<(String, String)>, AppError> {
    let service = DataService::new(&state);
    service.get_columns(&dataset_id)
}

#[tauri::command]
pub fn get_column_descriptors(
    state: State<'_, AppState>,
    dataset_id: String,
) -> Result<Vec<ColumnDescriptor>, AppError> {
    let service = DataService::new(&state);
    service.get_column_descriptors(&dataset_id)
}

#[tauri::command]
pub fn sort_table(
    state: State<'_, AppState>,
    source_id: String,
    sort_cols: Vec<String>,
    sort_orders: Vec<String>,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    sort_table_entry(
        state.inner(),
        &source_id,
        &sort_cols,
        &sort_orders,
        &new_name,
    )
}

#[tauri::command]
pub fn subset_table(
    state: State<'_, AppState>,
    source_id: String,
    columns: Vec<String>,
    row_filter: Option<String>,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.subset_table(&source_id, &columns, row_filter.as_deref(), &new_name)
}

#[tauri::command]
pub fn transpose_table(
    state: State<'_, AppState>,
    source_id: String,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.transpose_table(&source_id, &new_name)
}

#[tauri::command]
pub fn stack_table(
    state: State<'_, AppState>,
    source_id: String,
    stack_cols: Vec<String>,
    id_cols: Vec<String>,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.stack_table(&source_id, &stack_cols, &id_cols, &new_name)
}

#[tauri::command]
pub fn split_table(
    state: State<'_, AppState>,
    source_id: String,
    split_col: String,
    value_col: String,
    id_cols: Vec<String>,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.split_table(&source_id, &split_col, &value_col, &id_cols, &new_name)
}

#[tauri::command]
pub fn summary_table(
    state: State<'_, AppState>,
    source_id: String,
    stat_cols: Vec<String>,
    group_cols: Vec<String>,
    statistics: Vec<String>,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.summary_table(&source_id, &stat_cols, &group_cols, &statistics, &new_name)
}

#[tauri::command]
pub fn join_tables(
    state: State<'_, AppState>,
    left_id: String,
    right_id: String,
    join_type: String,
    left_key: String,
    right_key: String,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.join_tables(
        &left_id, &right_id, &join_type, &left_key, &right_key, &new_name,
    )
}

#[tauri::command]
pub fn update_table(
    state: State<'_, AppState>,
    left_id: String,
    right_id: String,
    match_col: String,
    update_cols: Vec<String>,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.update_table(&left_id, &right_id, &match_col, &update_cols)
}

#[tauri::command]
pub fn concatenate_tables(
    state: State<'_, AppState>,
    source_ids: Vec<String>,
    new_name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.concatenate_tables(&source_ids, &new_name)
}
