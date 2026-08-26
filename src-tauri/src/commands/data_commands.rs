use tauri::State;

use crate::error::AppError;
use crate::models::table::{
    CellPosition, CellUpdate, ColumnDisplayProps, CreateTableFromRowsRequest, DatasetMeta,
    TableQueryResult, TableWindowRequest, TableWindowResult,
};
use crate::services::data_service::DataService;
use crate::state::AppState;

pub(crate) fn acquire_mutation_permit(
    state: &AppState,
) -> Result<crate::services::save_coordinator::MutationPermit<'_>, AppError> {
    state.save_coordinator.mutation_permit()
}

pub(crate) fn delete_dataset_entry(state: &AppState, dataset_id: &str) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state)?;
    let service = DataService::new(state);
    service.delete_dataset(dataset_id)
}

pub(crate) fn query_table_window_entry(
    state: &AppState,
    request: &TableWindowRequest,
) -> Result<TableWindowResult, AppError> {
    let service = DataService::new(state);
    service.query_table_window(request)
}

#[tauri::command]
pub fn import_file(state: State<'_, AppState>, file_path: String) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
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
    delete_dataset_entry(state.inner(), &dataset_id)
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

#[tauri::command(async)]
pub fn query_table_window(
    state: State<'_, AppState>,
    request: TableWindowRequest,
) -> Result<TableWindowResult, AppError> {
    query_table_window_entry(state.inner(), &request)
}

#[tauri::command]
pub fn get_dataset_generation(
    state: State<'_, AppState>,
    dataset_id: String,
) -> Result<u64, AppError> {
    let service = DataService::new(&state);
    service.get_dataset_generation(&dataset_id)
}

#[tauri::command(async)]
pub fn locate_table_row(
    state: State<'_, AppState>,
    dataset_id: String,
    row_id: i64,
    filters: Vec<crate::models::table::TableWindowFilter>,
    generation: u64,
) -> Result<Option<usize>, AppError> {
    let service = DataService::new(&state);
    service.locate_table_row(&dataset_id, row_id, &filters, generation)
}

#[tauri::command(async)]
pub fn query_table_filter_values(
    state: State<'_, AppState>,
    dataset_id: String,
    field: String,
    search: String,
    limit: usize,
    generation: u64,
) -> Result<Vec<String>, AppError> {
    let service = DataService::new(&state);
    service.query_table_filter_values(&dataset_id, &field, &search, limit, generation)
}

#[tauri::command]
pub fn execute_sql_query(
    state: State<'_, AppState>,
    sql: String,
    page: usize,
    page_size: usize,
) -> Result<crate::models::table::SqlQueryResult, AppError> {
    let service = DataService::new(&state);
    service.execute_sql_query(&sql, page, page_size)
}

#[tauri::command]
pub fn create_table_from_sql_query(
    state: State<'_, AppState>,
    sql: String,
    name: String,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.create_table_from_sql_query(&sql, &name)
}

#[tauri::command]
pub fn create_table(
    state: State<'_, AppState>,
    name: String,
    column_names: Vec<String>,
    column_types: Vec<String>,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.create_table(&name, &column_names, &column_types)
}

#[tauri::command]
pub fn create_table_from_rows(
    state: State<'_, AppState>,
    request: CreateTableFromRowsRequest,
) -> Result<DatasetMeta, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.create_table_from_rows(&request)
}

#[tauri::command]
pub fn add_row(state: State<'_, AppState>, dataset_id: String) -> Result<i64, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.add_row(&dataset_id)
}

#[tauri::command]
pub fn add_rows(
    state: State<'_, AppState>,
    dataset_id: String,
    count: usize,
) -> Result<crate::models::table::AddedRowsResult, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.add_rows(&dataset_id, count)
}

#[tauri::command]
pub fn apply_added_rows(
    state: State<'_, AppState>,
    dataset_id: String,
    row_ids: Vec<i64>,
    undo: bool,
    expected_generation: u64,
) -> Result<u64, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.apply_added_rows(&dataset_id, &row_ids, undo, expected_generation)
}

#[tauri::command]
pub fn update_cell(
    state: State<'_, AppState>,
    dataset_id: String,
    row_id: i64,
    column_name: String,
    value: String,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.update_cell(&dataset_id, row_id, &column_name, &value)
}

#[tauri::command]
pub fn clear_cells(
    state: State<'_, AppState>,
    dataset_id: String,
    cells: Vec<CellPosition>,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.clear_cells(&dataset_id, &cells)
}

#[tauri::command]
pub fn update_cells(
    state: State<'_, AppState>,
    dataset_id: String,
    updates: Vec<CellUpdate>,
    expected_generation: Option<u64>,
) -> Result<u64, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.update_cells(&dataset_id, &updates, expected_generation)
}

#[tauri::command]
pub fn delete_row(
    state: State<'_, AppState>,
    dataset_id: String,
    row_id: i64,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.delete_row(&dataset_id, row_id)
}

#[tauri::command]
pub fn delete_rows(
    state: State<'_, AppState>,
    dataset_id: String,
    row_ids: Vec<i64>,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.delete_rows(&dataset_id, &row_ids)
}

#[tauri::command]
pub fn delete_rows_with_change_set(
    state: State<'_, AppState>,
    dataset_id: String,
    row_ids: Vec<i64>,
    expected_generation: Option<u64>,
) -> Result<String, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.delete_rows_with_change_set(&dataset_id, &row_ids, expected_generation)
}

#[tauri::command]
pub fn delete_columns_with_change_set(
    state: State<'_, AppState>,
    dataset_id: String,
    column_names: Vec<String>,
    expected_generation: Option<u64>,
) -> Result<String, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.delete_columns_with_change_set(&dataset_id, &column_names, expected_generation)
}

#[tauri::command]
pub fn alter_column_with_change_set(
    state: State<'_, AppState>,
    dataset_id: String,
    old_name: String,
    new_name: String,
    new_type: String,
    expected_generation: Option<u64>,
) -> Result<String, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.alter_column_with_change_set(
        &dataset_id,
        &old_name,
        &new_name,
        &new_type,
        expected_generation,
    )
}

#[tauri::command]
pub fn alter_columns_type_with_change_set(
    state: State<'_, AppState>,
    dataset_id: String,
    column_names: Vec<String>,
    new_type: String,
    expected_generation: Option<u64>,
) -> Result<String, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.alter_columns_type_with_change_set(
        &dataset_id,
        &column_names,
        &new_type,
        expected_generation,
    )
}

#[tauri::command]
pub fn rename_dataset(
    state: State<'_, AppState>,
    dataset_id: String,
    new_name: String,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
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
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.add_column(&dataset_id, &col_name, &col_type)
}

#[tauri::command]
pub fn add_column_with_change_set(
    state: State<'_, AppState>,
    dataset_id: String,
    col_name: String,
    col_type: String,
    at_index: Option<i32>,
    expected_generation: Option<u64>,
) -> Result<String, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.add_column_with_change_set(
        &dataset_id,
        &col_name,
        &col_type,
        at_index,
        expected_generation,
    )
}

#[tauri::command]
pub fn add_columns_with_change_set(
    state: State<'_, AppState>,
    dataset_id: String,
    columns: Vec<crate::models::table::ColumnDefinition>,
    at_index: Option<i32>,
    expected_generation: Option<u64>,
) -> Result<String, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.add_columns_with_change_set(
        &dataset_id,
        &columns,
        at_index,
        expected_generation,
    )
}

#[tauri::command]
pub fn insert_column_at(
    state: State<'_, AppState>,
    dataset_id: String,
    col_name: String,
    col_type: String,
    at_index: usize,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.insert_column_at(&dataset_id, &col_name, &col_type, at_index)
}

#[tauri::command]
pub fn reorder_column(
    state: State<'_, AppState>,
    dataset_id: String,
    from: usize,
    to: usize,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.reorder_column(&dataset_id, from, to)
}

#[tauri::command]
pub fn reorder_column_if_generation(
    state: State<'_, AppState>,
    dataset_id: String,
    from: usize,
    to: usize,
    expected_generation: u64,
) -> Result<u64, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.reorder_column_if_generation(&dataset_id, from, to, expected_generation)
}

#[tauri::command]
pub fn delete_column(
    state: State<'_, AppState>,
    dataset_id: String,
    col_name: String,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
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
    let _permit = acquire_mutation_permit(state.inner())?;
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
    let _permit = acquire_mutation_permit(state.inner())?;
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
    expected_generation: Option<u64>,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.paste_at_position(
        &dataset_id,
        start_row,
        start_col,
        &rows,
        header_names.as_deref(),
        &col_types,
        expected_generation,
    )
}

#[tauri::command]
pub fn paste_at_position_with_change_set(
    state: State<'_, AppState>,
    dataset_id: String,
    start_row: usize,
    start_col: usize,
    rows: Vec<Vec<String>>,
    header_names: Option<Vec<String>>,
    col_types: Vec<String>,
    expected_generation: Option<u64>,
) -> Result<crate::models::table::PasteChangeSetResult, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    let change_set_id = service.paste_at_position_with_change_set(
        &dataset_id,
        start_row,
        start_col,
        &rows,
        header_names.as_deref(),
        &col_types,
        expected_generation,
    )?;
    Ok(crate::models::table::PasteChangeSetResult { change_set_id })
}

#[tauri::command]
pub fn apply_table_change_set(
    state: State<'_, AppState>,
    change_set_id: String,
    undo: bool,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    DataService::new(&state).apply_change_set(&change_set_id, undo)
}

#[tauri::command]
pub fn drop_table_change_set(
    state: State<'_, AppState>,
    change_set_id: String,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    DataService::new(&state).drop_change_set(&change_set_id)
}

#[tauri::command]
pub fn restore_snapshot(
    state: State<'_, AppState>,
    dataset_id: String,
    col_names: Vec<String>,
    col_types: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.restore_snapshot(&dataset_id, &col_names, &col_types, &rows)
}

#[tauri::command]
pub fn get_column_display_props(
    state: State<'_, AppState>,
    dataset_id: String,
) -> Result<Vec<ColumnDisplayProps>, AppError> {
    let display = state
        .column_display
        .lock()
        .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(display.get(&dataset_id).cloned().unwrap_or_default())
}

#[tauri::command]
pub fn set_column_display_props(
    state: State<'_, AppState>,
    dataset_id: String,
    props: Vec<ColumnDisplayProps>,
) -> Result<(), AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let mut display = state
        .column_display
        .lock()
        .map_err(|e| AppError::Database(e.to_string()))?;
    display.insert(dataset_id, props);
    Ok(())
}
